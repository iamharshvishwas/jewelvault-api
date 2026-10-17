import { randomUUID } from 'node:crypto';
import type { Connection } from 'mysql2/promise';
import { migrate } from '../../scripts/migrate.mjs';
import type { DbConnection, DbPool } from '../../src/db/pool';
import type { Tx } from '../../src/db/tx';
import { type Scratch, scratchDatabase } from '../helpers';

// Shared by the tests of API03 (T-C19, T-C18, T-D07, T-F08 clause): a scratch database that holds the real schema AND the generated audit triggers (so "no audit row" means something),
// a toy service function with the shape of a writing function (claim, customer lock, number counter, a row in an audited table), and a spy that sees every statement a connection sends.

export interface TxWorld {
  scratch: Scratch;
  root: Connection;
  customers: string[];
  series: string;
  drop(): Promise<void>;
}

/** A scratch database with the migrations and db/optional (audit triggers), two customers and one counter series. */
export async function txWorld(label: string): Promise<TxWorld> {
  const scratch = await scratchDatabase(label, { schema: true });
  const u = await scratch.connect();
  const customers = [randomUUID(), randomUUID()];
  try {
    await migrate(u, { seeds: false, optional: true });
    for (const [i, id] of customers.entries()) await u.query('INSERT INTO customers (id, name, mobile) VALUES (?, ?, ?)', [id, `Customer ${i}`, `98765432${10 + i}`]);
    await u.query("INSERT INTO sys_counters (series) VALUES ('toy:2026')");
  } finally {
    await u.end();
  }
  const root = await scratch.root();
  // the append-only trigger of db/optional/0900 is proved by the database half (s20); here the scratch database is emptied between tests, and not even root can delete past it
  await root.query(`DROP TRIGGER IF EXISTS \`${scratch.database}\`.trg_audit_log_no_delete`);
  return {
    scratch,
    root,
    customers,
    series: 'toy:2026',
    async drop() {
      await root.end().catch(() => undefined);
      await scratch.drop();
    },
  };
}

/** Counts of what a toy call may leave behind. */
export async function leftovers(w: TxWorld) {
  const q = async (sql: string) => Number(((await w.root.query<any[]>(sql))[0] as any[])[0].n);
  const db = `\`${w.scratch.database}\``;
  return {
    categories: await q(`SELECT COUNT(*) AS n FROM ${db}.categories`),
    audit: await q(`SELECT COUNT(*) AS n FROM ${db}.audit_log WHERE table_name = 'categories'`),
    claims: await q(`SELECT COUNT(*) AS n FROM ${db}.sys_idempotency`),
    counter: await q(`SELECT last_value AS n FROM ${db}.sys_counters WHERE series = 'toy:2026'`),
  };
}

export const NOTHING = { categories: 0, audit: 0, claims: 0, counter: 0 };

/** The server's own count of deadlocks since it started. */
export async function innodbDeadlocks(root: Connection): Promise<number> {
  const [rows] = await root.query<any[]>("SHOW GLOBAL STATUS LIKE 'Innodb_deadlocks'");
  return Number(rows[0].Value);
}

// ------------------------------------------------------------------ the toy writing function

export type Step = 'claim' | 'lock' | 'number' | 'row';
export interface ToyArgs {
  requestId: string;
  customerId: string;
  name: string;
  steps?: Step[];
  series?: string;
  /** called after each step: a test holds a call here */
  after?: (step: Step) => Promise<void> | void;
}
export interface ToyResult {
  number: number | null;
  categoryId: string | null;
}

/** The right order (X0): claim first, the customer row, the number counter LAST, the written row. */
export const RIGHT: Step[] = ['claim', 'lock', 'number', 'row'];
/** The deliberately wrong order of the negative control: the counter BEFORE the customer lock. */
export const WRONG: Step[] = ['claim', 'number', 'lock', 'row'];

const ACTOR_FOR_CLAIM = '00000000-0000-4000-8000-000000000001';

/** One statement per step, in the order given. Writes through tx only. */
export async function toyWrite(tx: Tx, a: ToyArgs): Promise<ToyResult> {
  let number: number | null = null;
  let categoryId: string | null = null;
  for (const step of a.steps ?? RIGHT) {
    if (step === 'claim') {
      await tx.run('INSERT INTO sys_idempotency (request_id, fn, actor, args_hash, claim_token) VALUES (?, ?, ?, ?, ?)', [a.requestId, 'toy_pay', ACTOR_FOR_CLAIM, 'a'.repeat(64), randomUUID()]);
    } else if (step === 'lock') {
      await tx.rows('SELECT id FROM customers WHERE id = ? FOR UPDATE', [a.customerId]);
    } else if (step === 'number') {
      const r = await tx.run('UPDATE sys_counters SET last_value = LAST_INSERT_ID(last_value + 1) WHERE series = ?', [a.series ?? 'toy:2026']);
      if (r.affectedRows !== 1) throw new Error('the series row is missing');
      number = Number(r.insertId); // the number comes from the OK packet; no statement runs between
    } else {
      categoryId = randomUUID();
      await tx.run('INSERT INTO categories (id, name, prefix) VALUES (?, ?, ?)', [categoryId, `${a.name}#${number ?? 0}`, 'TY']);
    }
    await a.after?.(step);
  }
  return { number, categoryId };
}

/** The shape of L5, small: claim (the first statement), a replay when the key is known, the work, the result stored in the same transaction. A toy of API14's helper. */
export async function toyIdempotent(tx: Tx, a: ToyArgs): Promise<ToyResult & { replayed: boolean }> {
  const token = randomUUID();
  await tx.run('INSERT INTO sys_idempotency (request_id, fn, actor, args_hash, claim_token) VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE request_id = request_id', [a.requestId, 'toy_pay', ACTOR_FOR_CLAIM, 'b'.repeat(64), token]);
  const [row] = await tx.rows<{ claim_token: string; result: string | null }>('SELECT claim_token, result FROM sys_idempotency WHERE request_id = ? FOR UPDATE', [a.requestId]);
  if (row.claim_token !== token) {
    const stored = typeof row.result === 'string' ? JSON.parse(row.result) : row.result;
    return { ...(stored as ToyResult), replayed: true };
  }
  const out = await toyWrite(tx, { ...a, steps: ['lock', 'number', 'row'] });
  await tx.run('UPDATE sys_idempotency SET result = ? WHERE request_id = ?', [JSON.stringify(out), a.requestId]);
  return { ...out, replayed: false };
}

// ------------------------------------------------------------------ a spy on the statements a connection sends

export interface Sent {
  kind: 'query' | 'execute';
  sql: string;
  thread: number;
}
export interface Spy {
  /** the pool to hand to withTx / withRead */
  pool: Pick<DbPool, 'checkout'>;
  sent: Sent[];
  /** every SQL text sent, in order */
  sqls(): string[];
  /**
   * A hook that sees each statement before it is sent. Return `{ result }` to answer in place of the server, throw to fail the statement, or return nothing to let it through.
   * `real()` sends the statement for real.
   */
  intercept: ((e: Sent & { conn: DbConnection; real: () => Promise<unknown> }) => Promise<{ result: unknown } | undefined | void> | { result: unknown } | undefined | void) | null;
}

/** Wraps a pool so that every connection it hands out reports the statements it sends. Use a fresh pool for each test: the connection objects are patched for good. */
export function spyOn(pool: DbPool): Spy {
  const patched = new WeakSet<object>();
  const spy: Spy = {
    sent: [],
    sqls: () => spy.sent.map((s) => s.sql),
    intercept: null,
    pool: {
      async checkout() {
        const conn = await pool.checkout();
        if (!patched.has(conn)) {
          patched.add(conn);
          for (const kind of ['query', 'execute'] as const) {
            const real = (conn as any)[kind].bind(conn) as (...a: unknown[]) => Promise<unknown>;
            (conn as any)[kind] = async (sql: unknown, ...rest: unknown[]) => {
              const text = typeof sql === 'string' ? sql : String((sql as { sql: string }).sql);
              const entry: Sent = { kind, sql: text, thread: conn.threadId };
              spy.sent.push(entry);
              const handled = await spy.intercept?.({ ...entry, conn, real: () => real(sql, ...rest) });
              return handled ? handled.result : real(sql, ...rest);
            };
          }
        }
        return conn;
      },
    },
  };
  return spy;
}

/** An error that looks like the driver's: errno, code, sqlState, a message that may name a table. */
export function dbError(errno: number, code: string, message: string, extra: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(message), { errno, code, sqlState: '40001', sqlMessage: message, ...extra });
}
/** What mysql2 throws when the connection is gone. */
export const connectionLost = () => Object.assign(new Error('Connection lost: The server closed the connection.'), { code: 'PROTOCOL_CONNECTION_LOST', fatal: true });
