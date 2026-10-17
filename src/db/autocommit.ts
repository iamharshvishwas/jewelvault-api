// U4, X0 item 1: statements that are each their own transaction. A checked-out connection is in autocommit unless START TRANSACTION was sent, so a statement run here commits by itself, holds its row
// lock only for that one statement, and is never part of any other call's transaction. The write of `sessions.last_seen_at` is the user of this: it is made before the handler runs, so a slow money call
// does not hold the session row and make the same user's other calls wait.
//
// Like withRead and ensureSeries it takes its own short checkout (the wait for a place counts against the deadline of S12), passes every statement through the statement wrapper, maps a database error
// to its JvError, and always gives the connection back (destroyed when it is broken). `fn` must not send START TRANSACTION and must not hold the connection across anything slow.
import type { ResultSetHeader } from 'mysql2/promise';
import { BusyError, classifyError, isConnectionLost } from '../errors.js';
import type { DbConnection } from './pool.js';
import { type Param, checkStatement } from './stmt.js';
import type { TxContext } from './tx.js';

export interface Autocommit {
  /** A statement that returns rows (SELECT). */
  rows<T extends object = Record<string, unknown>>(sql: string, params?: readonly Param[]): Promise<T[]>;
  /** A statement that changes rows, committed by itself: the OK packet. */
  run(sql: string, params?: readonly Param[]): Promise<ResultSetHeader>;
}

export async function withAutocommit<T>(ctx: TxContext, fn: (db: Autocommit) => Promise<T>): Promise<T> {
  let conn: DbConnection | undefined;
  let broken = false;
  let over = false;
  const guard = () => {
    if (ctx.now() - ctx.arrivedAt > ctx.deadlineMs) throw new BusyError('deadline');
  };
  const send = async (sql: string, params: readonly Param[]): Promise<unknown> => {
    if (over) throw new Error('the connection was given back: this object must not be used after the call has returned');
    guard();
    checkStatement(sql, params);
    const [result] = await conn!.execute(sql, params as Param[]);
    return result;
  };
  try {
    guard();
    conn = await ctx.pool.checkout(); // the wait for a place is part of the deadline: arrivedAt is older than this call
    return await fn({
      rows: async <R extends object>(sql: string, params: readonly Param[] = []) => {
        const result = await send(sql, params);
        if (!Array.isArray(result)) throw new Error('rows() is for statements that return rows; use run() for a change');
        return result as R[];
      },
      run: async (sql, params = []) => {
        const result = await send(sql, params);
        if (Array.isArray(result)) throw new Error('run() is for statements that change rows; use rows() for a SELECT');
        return result as ResultSetHeader;
      },
    });
  } catch (e) {
    broken = isConnectionLost(e);
    throw classifyError(e);
  } finally {
    over = true;
    if (conn) {
      if (broken) conn.destroy();
      else conn.release();
    }
  }
}
