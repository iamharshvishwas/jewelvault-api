import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LightMyRequestResponse } from 'fastify';
import type { Connection } from 'mysql2/promise';
import { migrate } from '../../scripts/migrate.mjs';
import type { Config } from '../../src/config';
import type { DbConnection } from '../../src/db/pool';
import { registerAuthRoutes } from '../../src/auth/loginRoutes';
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
  /** true (with routes false): the session routes and the login are there too, beside the job routes with `phases` (the tests of the login failures use it) */
  authRoutes?: boolean;
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
  /** GET /internal/jobs/health (API33b), with the same options as a tick: the token, the address, more headers */
  health(o?: CallOptions): Promise<LightMyRequestResponse>;
  /** sys_job_runs, oldest first */
  runs(job?: string): Promise<JobRun[]>;
  /** audit_log rows with action event and the role job */
  jobEvents(): Promise<{ id: number; actor: string | null; actor_role: string; request_id: string; table_name: string; row_id: string; new_row: any }[]>;
  /** a plain connection of the ten-box user (autocommit), for the checks that must not use the application's pool */
  sql: Connection;
  /** the database's name (the lock is `jv_tick:<name>`) */
  database: string;
  /** JV_BACKUP_DIR of the world: a folder of its own (made for the world and removed when it closes), unless the test gave `config.backupDir` */
  backupDir: string | undefined;
  close(): Promise<void>;
}

export async function tickWorld(label: string, options: TickWorldOptions = {}): Promise<TickWorld> {
  const time = testClock();
  const routes = options.routes ?? false;
  // B2: the backup folder of the app (JV_BACKUP_DIR). The photo copy of the application's own phases (API33b) writes there, and fails when there is none, so every world has a folder of its own.
  // (`config: { backupDir: undefined }` is a world with no folder set, for the test of that case)
  const ownFolder = !options.config || !('backupDir' in options.config);
  const backupDir = ownFolder ? await mkdtemp(join(tmpdir(), 'jv-tick-backup-')) : options.config?.backupDir;
  const world = await makeWorld({
    label,
    routes,
    clock: time.clock,
    config: { ...(options.door === false ? {} : { jobTokenHash: JOB_HASH }), backupDir, ...options.config },
    build: (app) => {
      if (!routes && options.authRoutes) registerAuthRoutes(app);
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

  const call = (url: string, method: 'POST' | 'GET' | 'OPTIONS', o: CallOptions = {}) =>
    world.app.inject({
      method: o.method ?? method,
      url,
      headers: { ...(o.token === null ? {} : { authorization: `Bearer ${o.token ?? JOB_TOKEN}` }), ...(o.ip === null ? {} : { 'x-real-ip': o.ip ?? freshIp() }), ...o.headers },
    });
  const tick = (o: CallOptions = {}) => call('/internal/jobs/tick', 'POST', o);
  const health = (o: CallOptions = {}) => call('/internal/jobs/health', 'GET', o);

  return {
    world,
    time,
    conns,
    tick,
    health,
    sql: world.sql,
    database: world.scratch.database,
    backupDir,
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
    async close() {
      await world.close();
      if (ownFolder) await rm(backupDir as string, { recursive: true, force: true });
    },
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

// ------------------------------------------------------------------ photos for the photo copy (B2, D25)

export interface PhotoObject {
  id: string;
  kind: 'full' | 'thumb';
  bytes: Buffer;
  createdAt: string;
}

let photoCounter = 0;
/**
 * Puts `count` photo OBJECTS (one row of design_photos each: a photo has a `full` and a `thumb`) into the database, each created one second after the one before, so that the order of the copy
 * (oldest first, then id, then kind) is the order returned. Each holds a few made-up bytes whose sha256 and size are right.
 */
export async function addPhotoObjects(sql: Connection, count: number, o: { kinds?: ('full' | 'thumb')[]; size?: number; removed?: boolean; from?: number } = {}): Promise<PhotoObject[]> {
  const made: PhotoObject[] = [];
  const kinds = o.kinds ?? ['full'];
  for (let i = 0; i < count; i++) {
    const id = randomUUID();
    const kind = kinds[i % kinds.length];
    const bytes = Buffer.concat([Buffer.from(`photo-${++photoCounter}:`), randomBytes(o.size ?? 200)]);
    const createdAt = `2026-10-10 00:${String(Math.floor(((o.from ?? 0) + i) / 60)).padStart(2, '0')}:${String(((o.from ?? 0) + i) % 60).padStart(2, '0')}.000000`;
    await sql.query('INSERT INTO design_photos (id, kind, design_id, mime, byte_size, sha256, bytes, removed_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [
      id,
      kind,
      randomUUID(),
      'image/jpeg',
      o.removed ? 10 : bytes.length,
      createHash('sha256').update(bytes).digest(),
      o.removed ? null : bytes,
      o.removed ? '2026-10-11 00:00:00.000000' : null,
      createdAt,
    ]);
    made.push({ id, kind, bytes, createdAt });
  }
  return made;
}

/** The rows of sys_photo_copies, by photo id and kind. */
export async function copiedRows(sql: Connection): Promise<{ photo_id: string; kind: string; sha: string; size: number }[]> {
  const [rows] = await sql.query<any[]>('SELECT photo_id, kind, HEX(sha256) AS sha, size FROM sys_photo_copies ORDER BY copied_at, photo_id, kind');
  return rows.map((r) => ({ ...r, size: Number(r.size) }));
}

/** The rows of backup_runs, oldest first, with the detail parsed. */
export async function backupRuns(sql: Connection, kind?: string): Promise<{ id: number; ran_at: string; kind: string; ok: number; bytes: number; detail: any }[]> {
  const [rows] = await sql.query<any[]>(`SELECT id, DATE_FORMAT(ran_at, '%Y-%m-%d %H:%i:%s.%f') AS ran_at, kind, ok, bytes, detail FROM backup_runs ${kind ? 'WHERE kind = ?' : ''} ORDER BY id`, kind ? [kind] : []);
  return rows.map((r) => ({ ...r, id: Number(r.id), ok: Number(r.ok), bytes: Number(r.bytes), detail: typeof r.detail === 'string' ? JSON.parse(r.detail) : r.detail }));
}
