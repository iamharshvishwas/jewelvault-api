// D25, A14: sys_error_log keeps the unexpected errors beyond Hostinger's log window of the latest deployment, AT MOST 20 ROWS A MINUTE FOR EACH ERROR CODE (nothing can purge this table, S7).
// This is the TypeScript twin of logError in scripts/housekeeping.mjs, the database half's function (MB05, tested by tests/schema/s18-housekeeping.test.ts). The build compiles src/ alone,
// so src cannot import a scripts/*.mjs file (the pacer's twin, src/db/pacer.ts, is made the same way); tests/api/error-log.test.ts keeps the two identical: the same two statements, character
// for character, and the same rows for the same calls.
//
// The next free place (seq 1 to 20) is taken in the same statement as the insert and is UNIQUE for a code and a minute, so eight connections racing cannot write a 21st row; beyond 20 the
// count is added to detail.suppressed of the row with seq 20 by one atomic UPDATE, so no occurrence is lost.
import type { ResultSetHeader } from 'mysql2/promise';
import type { DbConnection } from './pool.js';

export const ERROR_LOG_PER_MINUTE = 20;

export type ErrorLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal';

/** One unexpected error. Nothing in it is customer data: no name, no mobile, PAN or GST number, no amount typed by a person (D25). */
export interface ErrorEntry {
  level: ErrorLevel;
  code: string;
  message: string;
  request_id?: string | null;
  user_id?: string | null;
  detail?: Record<string, unknown> | null;
}

export type LogErrorResult = { written: true } | { written: false; suppressed: true };

/** The UTC minute of an instant, as MariaDB DATETIME text. */
const minuteOf = (d: Date) => `${d.toISOString().slice(0, 16).replace('T', ' ')}:00`;
/** The instant as DATETIME(6) text (the clock reads whole milliseconds here). */
const stamp = (d: Date) => `${d.toISOString().slice(0, 23).replace('T', ' ')}000`;

/** The minute a row of this instant belongs to (the key of the cap). */
export const errorLogMinute = minuteOf;

export const INSERT_SQL = `INSERT INTO sys_error_log (at, minute_at, seq, level, code, message, request_id, user_id, detail)
         SELECT ?, ?, n.next, ?, ?, ?, ?, ?, ?
         FROM (SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM sys_error_log WHERE code = ? AND minute_at = ?) n
         WHERE n.next <= ${ERROR_LOG_PER_MINUTE}`;

export const SUPPRESS_SQL = `UPDATE sys_error_log
        SET detail = JSON_SET(COALESCE(detail, JSON_OBJECT()), '$.suppressed', COALESCE(JSON_VALUE(detail, '$.suppressed'), 0) + 1)
      WHERE code = ? AND minute_at = ? AND seq = ${ERROR_LOG_PER_MINUTE}`;

/** Writes one error, or counts it when the code already has its 20 rows for the minute. `now` is a seam for tests and the time of the error itself. */
export async function logError(conn: Pick<DbConnection, 'query'>, entry: ErrorEntry, opts: { now?: Date } = {}): Promise<LogErrorResult> {
  const now = opts.now ?? new Date();
  const minute = minuteOf(now);
  const detail = entry.detail === undefined || entry.detail === null ? null : JSON.stringify(entry.detail);
  const message = String(entry.message ?? '').slice(0, 500);
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      const [res] = await conn.query<ResultSetHeader>(INSERT_SQL, [stamp(now), minute, entry.level, entry.code, message, entry.request_id ?? null, entry.user_id ?? null, detail, entry.code, minute]);
      if (res.affectedRows === 1) return { written: true };
      break; // the twentieth row of this minute exists already
    } catch (e) {
      if ((e as { errno?: number }).errno === 1062) continue; // another connection took the same seq a moment ago: take the next
      throw e;
    }
  }
  await conn.query(SUPPRESS_SQL, [entry.code, minute]);
  return { written: false, suppressed: true };
}
