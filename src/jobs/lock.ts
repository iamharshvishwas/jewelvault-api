// I8, RF5-3, RM5-4: the job locks. The TypeScript twin of `jobLockName` and `withJobLock` in scripts/housekeeping.mjs (MB06): src cannot import scripts/*.mjs (the build's rootDir is src), so the tick
// uses this file, and tests/api/job-lock-twin.test.ts keeps the two equal (same names, same statements, same answers, same marking of an error). A change to one is a change to the other.
//
// A lock name is SERVER-WIDE in MariaDB (across databases and users), so the database name is part of it: production and staging on one server must not block each other. A lock belongs to the
// CONNECTION, not to the transaction, and a pooled connection lives on, so RELEASE_LOCK runs in a `finally`, and an error that leaves the work marks itself `destroyConnection`: the caller must
// destroy the connection instead of returning it to the pool (a lock that could not be released dies with its connection).
import type { RowDataPacket } from 'mysql2/promise';
import type { DbConnection } from '../db/pool.js';

/** MariaDB refuses a lock name longer than 64 characters. */
export const LOCK_NAME_MAX = 64;

export type JobLockKind = 'tick' | 'dump';

/** The part of a connection the lock uses: plain statements. */
type Queryable = Pick<DbConnection, 'query'>;

/** `jv_tick:<database>` or `jv_dump:<database>`. Throws for another kind, for a connection with no database, and for a name over 64 characters. */
export async function jobLockName(conn: Queryable, kind: JobLockKind): Promise<string> {
  if (!['tick', 'dump'].includes(kind)) throw new Error(`unknown job lock: ${JSON.stringify(kind)}`);
  const row = (await conn.query<RowDataPacket[]>('SELECT DATABASE() AS db'))[0][0];
  if (!row?.db) throw new Error('the connection has no database selected');
  const name = `jv_${kind}:${row.db}`;
  if (name.length > LOCK_NAME_MAX) throw new Error(`the lock name ${name} is longer than ${LOCK_NAME_MAX} characters: the database name is too long`);
  return name;
}

export type JobLockResult<T> = { ran: false; name: string } | { ran: true; name: string; value: T; released: boolean };

/**
 * Runs `fn` only when nobody else holds the job lock (`GET_LOCK(name, 0)`: a second tick answers "already running" at once), and releases it in a `finally`. If `fn` throws, the error is rethrown
 * marked `destroyConnection = true` after RELEASE_LOCK was tried; a lock that RELEASE_LOCK says it did not hold is the same kind of error. A connection that is gone at RELEASE_LOCK took the lock
 * with it.
 */
export async function withJobLock<T>(conn: Queryable, kind: JobLockKind, fn: () => Promise<T>): Promise<JobLockResult<T>> {
  const name = await jobLockName(conn, kind);
  const got = (await conn.query<RowDataPacket[]>('SELECT GET_LOCK(?, 0) AS got', [name]))[0][0];
  if (Number(got.got) !== 1) return { ran: false, name };
  let failure: unknown = null;
  let failed = false;
  let value: T | undefined;
  try {
    value = await fn();
  } catch (e) {
    failed = true;
    failure = e;
    if (e && typeof e === 'object') (e as { destroyConnection?: boolean }).destroyConnection = true;
  }
  let released = false;
  try {
    const r = (await conn.query<RowDataPacket[]>('SELECT RELEASE_LOCK(?) AS released', [name]))[0][0];
    released = Number(r.released) === 1;
  } catch {
    // the connection is gone: the lock went with it
    released = true;
  }
  if (failed) throw failure;
  if (!released) {
    const e = new Error(`the job lock ${name} could not be released`) as Error & { destroyConnection?: boolean };
    e.destroyConnection = true;
    throw e;
  }
  return { ran: true, name, value: value as T, released };
}
