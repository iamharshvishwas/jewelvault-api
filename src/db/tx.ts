// S12, X0, NODE-DESIGN 5.3 and 5.4: one request, one connection, one transaction (withTx), and reads outside a transaction (withRead).
//
//  - Any error is ROLLBACK of the whole transaction, whatever it is: a lock wait timeout (1205) rolls back only the failing statement, so earlier statements would still commit if the code
//    carried on. Domain code never catches a database error and goes on; if it does anyway, the first failure is remembered, every later statement is refused, and the call is rolled back
//    and answered with that first failure.
//  - A deadlock (1213) runs the WHOLE function again, up to 2 more times, after 20 to 80 ms; then JV_BUSY. The connection is given back while it waits.
//  - The deadline of 12 s starts when the request ARRIVES (ctx.arrivedAt, taken by the app's first hook), so it includes the wait for a pool connection. It is checked before every statement
//    and once more just before COMMIT, where a late call is rolled back instead. max_statement_time (8 s) limits one statement and does not add up, so this is the bound of the whole call.
//  - The actor variables of the audit triggers (MB06: @jv_actor, @jv_role, @jv_request) are set at the start and cleared at the end; they live on the pooled connection and survive a commit.
//  - Statements are prepared (execute, one ? for each value) and pass src/db/stmt.ts: no object parameter, no DELETE, TRUNCATE, DROP, ALTER, no REPLACE INTO.
//  - A connection that drops during COMMIT is JV_BUSY that never promises "nothing was changed" (outcomeUnknown): the retry with the same Idempotency-Key finds out (L5).
//  - Every path gives the connection back: release() normally, destroy() when it is broken. A transaction a dead process left open is rolled back by MariaDB, which frees its locks at once.
import type { FastifyRequest } from 'fastify';
import type { ResultSetHeader } from 'mysql2/promise';
import { BusyError, classifyError, isConnectionLost, isDeadlock } from '../errors.js';
import { UUID_TEXT } from '../wire/format.js';
import type { DbConnection, DbPool } from './pool.js';
import { type Param, checkStatement } from './stmt.js';

/** The numbers of S12. */
export const TX_LIMITS = Object.freeze({
  /** the whole call, from the request's arrival */
  deadlineMs: 12_000,
  /** a deadlock runs the function again this many times at most (so 3 runs in all) */
  deadlockReruns: 2,
  jitterMinMs: 20,
  jitterMaxMs: 80,
});

/** Who is calling, for the audit trail: a user (id and role), or a job or import (no id, the role says what it is). */
export interface Actor {
  readonly id: string | null;
  readonly role: string;
}

/** Where the wrapper says what it did that an operator should see (request.log fits). */
export interface TxLog {
  warn(obj: object, msg: string): void;
}

export interface TxContext {
  /** Only checkout() is used, so a test can put a spy in front of the pool. */
  readonly pool: Pick<DbPool, 'checkout'>;
  /** The request id; a UUID, because the audit log's request_id column is one. */
  readonly requestId: string;
  readonly actor: Actor | null;
  /** When the request arrived, on the monotonic clock of now(). The 12 s deadline counts from here. */
  readonly arrivedAt: number;
  readonly deadlineMs: number;
  now(): number;
  sleep(ms: number): Promise<void>;
  /** 20 to 80 ms */
  jitter(): number;
  readonly log?: TxLog;
}

export interface TxContextInit {
  requestId: string;
  actor?: Actor | null;
  arrivedAt?: number;
  deadlineMs?: number;
  /** Seams for tests; the route wrapper passes none of them. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  jitter?: () => number;
  log?: TxLog;
}

export function txContext(pool: TxContext['pool'], init: TxContextInit): TxContext {
  if (!UUID_TEXT.test(init.requestId)) throw new TypeError('the request id must be a lower-case UUID (the audit log\'s request_id column is a UUID)');
  const actor = init.actor ?? null;
  if (actor) {
    if (actor.id !== null && !UUID_TEXT.test(actor.id)) throw new TypeError('the actor id must be a lower-case UUID or null');
    if (!/^[a-z][a-z-]{0,19}$/.test(actor.role)) throw new TypeError('the actor role is 1 to 20 lower-case letters (audit_log.actor_role)');
  }
  const now = init.now ?? (() => performance.now());
  return {
    pool,
    requestId: init.requestId,
    actor,
    arrivedAt: init.arrivedAt ?? now(),
    deadlineMs: init.deadlineMs ?? TX_LIMITS.deadlineMs,
    now,
    sleep: init.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms))),
    jitter: init.jitter ?? (() => TX_LIMITS.jitterMinMs + Math.random() * (TX_LIMITS.jitterMaxMs - TX_LIMITS.jitterMinMs)),
    log: init.log,
  };
}

/** The context of a request handler: the arrival time and the id come from the request (app.ts takes the first when the request comes in). */
export function txContextFor(pool: TxContext['pool'], request: FastifyRequest, actor: Actor | null): TxContext {
  return txContext(pool, { requestId: request.id, actor, arrivedAt: request.arrivedAt, log: request.log });
}

export interface Tx {
  readonly requestId: string;
  readonly actor: Actor | null;
  /** A statement that returns rows (SELECT, also ... FOR UPDATE). */
  rows<T extends object = Record<string, unknown>>(sql: string, params?: readonly Param[]): Promise<T[]>;
  /** A statement that changes rows: the OK packet (affectedRows, insertId). */
  run(sql: string, params?: readonly Param[]): Promise<ResultSetHeader>;
}

/** What withRead gives: SELECT and WITH only. */
export interface Reader {
  rows<T extends object = Record<string, unknown>>(sql: string, params?: readonly Param[]): Promise<T[]>;
}

/** The state of one call on one connection. */
interface Session {
  readonly conn: DbConnection;
  readonly ctx: TxContext;
  readonly readOnly: boolean;
  failed: boolean;
  failure: unknown;
  /** the call has returned: the connection may belong to somebody else by now */
  over: boolean;
}

const session = (conn: DbConnection, ctx: TxContext, readOnly: boolean): Session => ({ conn, ctx, readOnly, failed: false, failure: undefined, over: false });

/** The deadline of S12 (3): over it, the next statement is not sent and COMMIT is not sent. */
function guard(ctx: TxContext): void {
  if (ctx.now() - ctx.arrivedAt > ctx.deadlineMs) throw new BusyError('deadline');
}

/** The one place a statement is sent: refuse after a failure, check the deadline and the statement, then execute it as a prepared statement. */
async function send(s: Session, sql: string, params: readonly unknown[]): Promise<unknown> {
  if (s.over) throw new Error('the transaction is over: this object must not be used after the call has returned');
  if (s.failed) throw s.failure;
  try {
    guard(s.ctx);
    checkStatement(sql, params, { readOnly: s.readOnly });
    const [result] = await s.conn.execute(sql, params as Param[]);
    return result;
  } catch (e) {
    s.failed = true;
    s.failure = e;
    throw e;
  }
}

const rowsOf = async <T extends object>(s: Session, sql: string, params: readonly Param[]): Promise<T[]> => {
  const result = await send(s, sql, params);
  if (!Array.isArray(result)) throw new Error('rows() is for statements that return rows; use run() for a change');
  return result as T[];
};

const SET_ACTOR = 'SET @jv_actor = ?, @jv_role = ?, @jv_request = ?';
const CLEAR_ACTOR = 'SET @jv_actor = NULL, @jv_role = NULL, @jv_request = NULL';

/** One run of the function on one connection. Throws what went wrong (not yet classified); the connection is always given back. */
async function runOnce<T>(ctx: TxContext, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const conn = await ctx.pool.checkout(); // the wait for a place is part of the deadline: arrivedAt is older than this call
  const s = session(conn, ctx, false);
  let broken = false;
  let actorSet = false;
  let started = false;
  let committing = false;
  try {
    guard(ctx);
    await send(s, SET_ACTOR, [ctx.actor?.id ?? null, ctx.actor?.role ?? null, ctx.requestId]);
    actorSet = true;
    await conn.query('START TRANSACTION');
    started = true;
    const tx: Tx = {
      requestId: ctx.requestId,
      actor: ctx.actor,
      rows: (sql, params = []) => rowsOf(s, sql, params),
      run: async (sql, params = []) => {
        const result = await send(s, sql, params);
        if (Array.isArray(result)) throw new Error('run() is for statements that change rows; use rows() for a SELECT');
        return result as ResultSetHeader;
      },
    };
    let result: T;
    try {
      result = await fn(tx);
    } catch (e) {
      throw s.failed ? s.failure : e; // the first failure is the cause; whatever the function made of it afterwards is not
    }
    if (s.failed) throw s.failure; // the function swallowed a database error and returned: it still does not commit
    guard(ctx); // once more just before COMMIT
    committing = true;
    await conn.query('COMMIT');
    return result;
  } catch (e) {
    const lost = isConnectionLost(e);
    if (lost) broken = true; // it would only fail the ROLLBACK; MariaDB rolls back and frees the locks when the connection ends
    else if (started) {
      try {
        await conn.query('ROLLBACK'); // always, whatever the error
      } catch {
        broken = true;
      }
    }
    if (committing && lost) throw new BusyError('commit_lost', { cause: e, outcomeUnknown: true });
    throw e;
  } finally {
    s.over = true;
    if (!broken && actorSet) {
      try {
        await conn.query(CLEAR_ACTOR);
      } catch {
        broken = true;
      }
    }
    if (broken) conn.destroy();
    else conn.release();
  }
}

/**
 * Runs `fn` in one transaction on one connection and returns what it returns. Throws a JvError: a domain error from `fn` as it is, a database error by the map of src/errors.ts.
 * `fn` must not catch a database error and carry on, and must not touch the network (row locks are held).
 */
export async function withTx<T>(ctx: TxContext, fn: (tx: Tx) => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await runOnce(ctx, fn);
    } catch (e) {
      if (isDeadlock(e) && attempt <= TX_LIMITS.deadlockReruns) {
        const wait = ctx.jitter();
        ctx.log?.warn({ request_id: ctx.requestId, attempt, wait_ms: Math.round(wait) }, 'deadlock (1213): the whole function is run again');
        await ctx.sleep(wait);
        continue;
      }
      throw classifyError(e);
    }
  }
}

/** Reads outside a transaction on a checked-out connection (so with the same seven session settings), under the same deadline. SELECT and WITH only. */
export async function withRead<T>(ctx: TxContext, fn: (db: Reader) => Promise<T>): Promise<T> {
  let conn: DbConnection | undefined;
  let s: Session | undefined;
  let broken = false;
  try {
    conn = await ctx.pool.checkout();
    s = session(conn, ctx, true);
    const owned = s;
    return await fn({ rows: (sql, params = []) => rowsOf(owned, sql, params) });
  } catch (e) {
    broken = isConnectionLost(e);
    throw classifyError(e);
  } finally {
    if (s) s.over = true;
    if (conn) {
      if (broken) conn.destroy();
      else conn.release();
    }
  }
}
