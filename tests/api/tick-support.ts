import { createHash, randomBytes } from 'node:crypto';
import type { LightMyRequestResponse } from 'fastify';
import type { Connection } from 'mysql2/promise';
import { migrate } from '../../scripts/migrate.mjs';
import type { Config } from '../../src/config';
import type { DbConnection } from '../../src/db/pool';
import { registerJobRoutes } from '../../src/jobs/routes';
import type { Due, Phase, PhaseContext, PhaseResult } from '../../src/jobs/types';
import { type World, makeWorld } from './cells';
import { type TestClock, testClock } from './edit-support';

// Shared by the tests of API33 (the hourly tick, PT-T1): a scratch database with the real schema (and the seeds, and the generated audit triggers when asked), an application on a clock the test moves,
// the job door open with a token made up at run time (the app holds only its SHA-256, as in production), and a log of what happened to each connection the tick took from the pool.

export const JOB_TOKEN = randomBytes(32).toString('base64url');
export const JOB_HASH = createHash('sha256').update(JOB_TOKEN).digest('hex');

/** An instant, as the clock's microseconds. */
export const at = (iso: string): bigint => BigInt(Date.parse(iso)) * 1000n;

export interface ConnEvent {
  kind: 'release' | 'destroy';
  thread: number;
}

export interface JobRun {
  id: number;
  job: string;
  run_date: string;
  status: string;
  started_at: string;
  finished_at: string | null;
  detail: any;
}

export interface TickWorldOptions {
  /** The phases of the tick (registerJobRoutes). Default: the application's own, registered by registerRoutes (routes: true). */
  phases?: readonly Phase[];
  /** true: the application's own routes, and the job routes with the application's phases. */
  routes?: boolean;
  /** true: db/optional is applied (the generated audit triggers). */
  triggers?: boolean;
  /** true: the migration seeds are applied. */
  seeds?: boolean;
  config?: Partial<Config>;
  /** false: the job door is not configured (no JV_JOB_TOKEN_HASH). */
  door?: boolean;
}

export interface CallOptions {
  /** the bearer token; null: no Authorization header (default: the right one) */
  token?: string | null;
  /** x-real-ip; null: none (an address that cannot be trusted); default: a fresh one for every call */
  ip?: string | null;
  headers?: Record<string, string>;
  method?: 'POST' | 'GET' | 'OPTIONS';
}

let addresses = 0;
export const freshIp = () => `198.19.${Math.floor(++addresses / 250)}.${(addresses % 250) + 1}`;

export interface TickWorld {
  world: World;
  time: TestClock;
  /** what the pool was told about each connection a tick took: given back (release) or thrown away (destroy), with its thread id */
  conns: ConnEvent[];
  tick(o?: CallOptions): Promise<LightMyRequestResponse>;
  /** sys_job_runs, oldest first */
  runs(job?: string): Promise<JobRun[]>;
  /** audit_log rows with action event and the role job */
  jobEvents(): Promise<{ id: number; actor: string | null; actor_role: string; request_id: string; table_name: string; row_id: string; new_row: any }[]>;
  /** a plain connection of the ten-box user (autocommit), for the checks that must not use the application's pool */
  sql: Connection;
  /** the database's name (the lock is `jv_tick:<name>`) */
  database: string;
  close(): Promise<void>;
}

export async function tickWorld(label: string, options: TickWorldOptions = {}): Promise<TickWorld> {
  const time = testClock();
  const routes = options.routes ?? false;
  const world = await makeWorld({
    label,
    routes,
    clock: time.clock,
    config: { ...(options.door === false ? {} : { jobTokenHash: JOB_HASH }), ...options.config },
    build: (app) => {
      if (!routes && options.door !== false) registerJobRoutes(app, options.phases ? { phases: options.phases } : {});
    },
  });
  if (options.seeds || options.triggers) await migrate(world.sql, { seeds: options.seeds ?? false, optional: options.triggers === true });

  // what happens to each connection a call takes: the pool's own release() and destroy(), seen from outside (patched once for each connection object)
  const conns: ConnEvent[] = [];
  const patched = new WeakSet<object>();
  const original = world.spy.pool.checkout;
  world.spy.pool.checkout = async () => {
    const conn = (await original()) as DbConnection;
    if (!patched.has(conn)) {
      patched.add(conn);
      for (const kind of ['release', 'destroy'] as const) {
        const real = conn[kind].bind(conn);
        conn[kind] = () => {
          conns.push({ kind, thread: conn.threadId });
          real();
        };
      }
    }
    return conn;
  };

  const tick = (o: CallOptions = {}) =>
    world.app.inject({
      method: o.method ?? 'POST',
      url: '/internal/jobs/tick',
      headers: { ...(o.token === null ? {} : { authorization: `Bearer ${o.token ?? JOB_TOKEN}` }), ...(o.ip === null ? {} : { 'x-real-ip': o.ip ?? freshIp() }), ...o.headers },
    });

  return {
    world,
    time,
    conns,
    tick,
    sql: world.sql,
    database: world.scratch.database,
    async runs(job) {
      const [rows] = await world.sql.query<any[]>(
        `SELECT id, job, DATE_FORMAT(run_date, '%Y-%m-%d') AS run_date, status, DATE_FORMAT(started_at, '%Y-%m-%d %H:%i:%s.%f') AS started_at,
                DATE_FORMAT(finished_at, '%Y-%m-%d %H:%i:%s.%f') AS finished_at, detail
           FROM sys_job_runs ${job ? 'WHERE job = ?' : ''} ORDER BY id`,
        job ? [job] : [],
      );
      return rows.map((r) => ({ ...r, id: Number(r.id), detail: typeof r.detail === 'string' ? JSON.parse(r.detail) : r.detail }));
    },
    async jobEvents() {
      const [rows] = await world.sql.query<any[]>("SELECT id, actor, actor_role, request_id, table_name, row_id, new_row FROM audit_log WHERE action = 'event' AND actor_role = 'job' ORDER BY id");
      return rows.map((r) => ({ ...r, id: Number(r.id), new_row: typeof r.new_row === 'string' ? JSON.parse(r.new_row) : r.new_row }));
    },
    close: () => world.close(),
  };
}

// ------------------------------------------------------------------ toy phases and gates

/** A phase the test writes: it counts its runs and does what `run` says. */
export interface Toy extends Phase {
  readonly runs: PhaseContext[];
}

export function toyPhase(job: string, due: Due, run: (ctx: PhaseContext) => Promise<PhaseResult> | PhaseResult = () => ({ complete: true }), extra: { audited?: boolean } = {}): Toy {
  const runs: PhaseContext[] = [];
  return {
    job,
    due,
    ...extra,
    runs,
    async run(ctx) {
      runs.push(ctx);
      return run(ctx);
    },
  };
}

/** A phase waits at `hold()` until the test calls `open()`; `arrived` resolves when a phase is waiting. */
export function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  let reached!: () => void;
  const arrived = new Promise<void>((resolve) => (reached = resolve));
  return {
    arrived,
    open,
    async hold() {
      reached();
      await opened;
    },
  };
}

export const body = (res: LightMyRequestResponse) => res.json() as any;
