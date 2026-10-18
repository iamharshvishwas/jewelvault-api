import type { LightMyRequestResponse } from 'fastify';
import { migrate } from '../../scripts/migrate.mjs';
import { createClock } from '../../src/clock';
import { T0, makeWorld } from './cells';
import type { EditWorld } from './edit-support';
import { body } from './x02-support';

// Shared by the tests of API30 (T-C15: a lock held for more than 5 s, a statement past max_statement_time, the stress run; T-C19 on the real X2 record_payment): worlds with the application's real
// routes, holders that keep a lock or a table lock the way "another connection" does, and readers of what the log says about an answered JV_BUSY.

/**
 * The world of the stress run: the real routes, the seeds and the generated audit triggers (L1 (a), so "no audit row" means something), and an API clock that STARTS at the instant of the fixtures (17 Oct
 * 2026, 10:00 UTC, so their sessions are valid) and then moves with real time, as a running API's does: every stamp of the run is its own, not a tie.
 */
export async function movingWorld(label: string): Promise<EditWorld> {
  const started = performance.now();
  const clock = createClock(() => T0 + BigInt(Math.round((performance.now() - started) * 1000)));
  const world = await makeWorld({ label, routes: true, clock });
  await migrate(world.sql, { seeds: true, optional: true });
  const [cats] = await world.sql.query<any[]>('SELECT id FROM categories ORDER BY name LIMIT 2');
  const [subs] = await world.sql.query<any[]>("SELECT id FROM subcategories WHERE category_id = ? AND name = 'Kundan'", [cats[0].id]);
  return { world, time: { clock, readings: [], time: { micros: T0 } }, category: cats[0].id, other_category: cats[1].id, subcategory: subs[0].id };
}

// ------------------------------------------------------------------ holders: "another connection"

export interface Hold {
  /** when the hold began (performance.now()) */
  readonly since: number;
  /** how long it has been held */
  heldMs(): number;
  /** ends the hold (ROLLBACK or UNLOCK TABLES) and closes the connection */
  release(): Promise<void>;
}

/** A row lock held by an open transaction of another connection (the ten-box user's own connection to the database): `SELECT ... FOR UPDATE` on one row of `customers` or `bills`. */
export async function holdRow(w: EditWorld, table: 'customers' | 'bills', id: string): Promise<Hold> {
  const c = await w.world.scratch.connect();
  await c.query('START TRANSACTION');
  await c.query(`SELECT id FROM \`${table}\` WHERE id = ? FOR UPDATE`, [id]);
  const since = performance.now();
  return {
    since,
    heldMs: () => performance.now() - since,
    async release() {
      await c.query('ROLLBACK').catch(() => undefined);
      await c.end().catch(() => undefined);
    },
  };
}

/** A table lock (LOCK TABLES ... WRITE) held by another connection: every statement on the table waits for a metadata lock, which only the statement time limit (error 1969) cuts. */
export async function holdTable(w: EditWorld, table: string): Promise<Hold> {
  const root = await w.world.scratch.root();
  await root.query(`LOCK TABLES \`${w.world.scratch.database}\`.\`${table}\` WRITE`);
  const since = performance.now();
  return {
    since,
    heldMs: () => performance.now() - since,
    async release() {
      await root.query('UNLOCK TABLES').catch(() => undefined);
      await root.end().catch(() => undefined);
    },
  };
}

// ------------------------------------------------------------------ what the log says

export interface BusyLine {
  reason: string;
  outcome_unknown: boolean;
}

/** The "answered JV_BUSY" warnings of the world's log from line `from` on: the reason each busy answer was given for. */
export function busyLines(w: EditWorld, from = 0): BusyLine[] {
  return w.world.logs
    .lines()
    .slice(from)
    .filter((l) => l.msg === 'answered JV_BUSY')
    .map((l) => ({ reason: String(l.reason), outcome_unknown: l.outcome_unknown === true }));
}

/** How many log lines there are now (a test remembers it and asks `busyLines(w, mark)` afterwards). */
export const logMark = (w: EditWorld): number => w.world.logs.lines().length;

/** The reasons of the busy answers, counted. */
export function tally(lines: readonly BusyLine[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const l of lines) out[l.reason] = (out[l.reason] ?? 0) + 1;
  return out;
}

// ------------------------------------------------------------------ answers

/** The S8 shape of an answered JV_BUSY: 503, Retry-After 1, `{error:{code,message,details},request_id}`, a message that never promises that nothing was changed. */
export function expectBusyAnswer(res: LightMyRequestResponse): void {
  const b = body<{ error: { code: string; message: string; details: unknown }; request_id: string }>(res);
  if (res.statusCode !== 503 || res.headers['retry-after'] !== '1' || b.error?.code !== 'JV_BUSY') {
    throw new Error(`expected 503 JV_BUSY with Retry-After 1, got ${res.statusCode} retry-after=${String(res.headers['retry-after'])}: ${res.body.slice(0, 300)}`);
  }
  if (Object.keys(b).join() !== 'error,request_id') throw new Error(`the body of a busy answer is {error, request_id}, got ${Object.keys(b).join()}`);
  if (/nothing was changed|not saved|no change/i.test(b.error.message)) throw new Error(`a busy answer must not promise that nothing was changed: ${b.error.message}`);
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
