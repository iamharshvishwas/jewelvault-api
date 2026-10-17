// D24, A13, T-D30: the login counters and the hourly failure summary. sys_login_attempts is updated in place and never grows (at most 2 x 1,024 + 2 rows); a failed login is never written one by one:
// the `audit` row (slot 0) keeps the count of the current UTC hour, and the first failure after the hour has changed, or the tick's housekeeping, claims it and writes ONE audit_log event
// `login_failures` for the hour that ended, so an attack makes at most 24 audit rows a day.
//
// This is the TypeScript twin of scripts/login-counters.mjs (MB07, tested by tests/schema/s22-login-counters.test.ts). The build compiles src/ alone, so src cannot import a scripts/*.mjs file
// (src/db/adminStatements.ts is the twin of the admin statements the same way); tests/api/login-counters-twin.test.ts keeps the two identical: the same slots, the same statements character for
// character, the same rows for the same calls. The statements are the script's and no new SQL: what differs is only how they are sent (prepared, through the statement wrapper, on a short checkout
// of the pool that is given back at once), and that the failure summary's transaction goes through withTx.
//
// `now` (a Date) is a test seam, as in the script: without it the database's own UTC clock is used.
import { createHash } from 'node:crypto';
import { type Autocommit, withAutocommit } from '../db/autocommit.js';
import { type TxContext, withTx } from '../db/tx.js';
import { addressKey } from './limiter.js';

export { addressKey };

export const WINDOW_SECONDS = Object.freeze({ email: 900, addr: 60, any: 60 });
export const SLOTS = 1024;
export type Scope = keyof typeof WINDOW_SECONDS;
const SCOPES = Object.keys(WINDOW_SECONDS);

/** MariaDB DATETIME(6) text of an instant, to the millisecond (what a Date holds). */
const micro = (d: Date): string => d.toISOString().replace('T', ' ').replace('Z', '000');

/** The counter slot: the first two bytes of SHA-256(salt | lower-cased e-mail or shortened address) modulo 1,024 (D24). The salt is a secret from the environment (U10). */
export function loginSlot(salt: string, kind: 'email' | 'addr', value: string): number {
  if (typeof salt !== 'string' || salt === '') throw new Error('loginSlot needs the secret salt');
  if (kind !== 'email' && kind !== 'addr') throw new Error(`kind must be email or addr, got ${JSON.stringify(kind)}`);
  const text = kind === 'email' ? String(value).trim().toLowerCase() : addressKey(String(value));
  return createHash('sha256').update(`${salt}|${text}`).digest().readUInt16BE(0) % SLOTS;
}

// The statement of D24, with the database clock and with an injected time. n is assigned before window_start: the right-hand sides read the OLD window_start (MariaDB evaluates the assignments
// left to right).
const COUNT_SQL = `INSERT INTO sys_login_attempts (scope, slot, window_start, n) VALUES (?, ?, UTC_TIMESTAMP(6), 1)
     ON DUPLICATE KEY UPDATE n = IF(window_start < UTC_TIMESTAMP(6) - INTERVAL ? SECOND, 1, n + 1), window_start = IF(window_start < UTC_TIMESTAMP(6) - INTERVAL ? SECOND, UTC_TIMESTAMP(6), window_start)`;
const COUNT_AT_SQL = `INSERT INTO sys_login_attempts (scope, slot, window_start, n) VALUES (?, ?, ?, 1)
     ON DUPLICATE KEY UPDATE n = IF(window_start < ? - INTERVAL ? SECOND, 1, n + 1), window_start = IF(window_start < ? - INTERVAL ? SECOND, ?, window_start)`;
const READ_COUNT_SQL = 'SELECT n FROM sys_login_attempts WHERE scope = ? AND slot = ?';

/**
 * Counts one attempt when the request ARRIVES, by one atomic statement (a window that has run out starts again at 1), then reads the count with a plain SELECT. Returns n.
 * Use it on a short checkout of the pool (withAutocommit): it is two autocommit statements.
 */
export async function countAttempt(db: Pick<Autocommit, 'rows' | 'run'>, scope: Scope, slot: number, options: { now?: Date | undefined } = {}): Promise<number> {
  if (!SCOPES.includes(scope)) throw new Error(`scope must be one of ${SCOPES.join(', ')}, got ${JSON.stringify(scope)}`);
  if (!Number.isInteger(slot) || slot < 0 || slot >= SLOTS) throw new Error(`slot must be a whole number from 0 to ${SLOTS - 1}, got ${JSON.stringify(slot)}`);
  const seconds = WINDOW_SECONDS[scope];
  if (options.now) {
    const t = micro(options.now);
    await db.run(COUNT_AT_SQL, [scope, slot, t, t, seconds, t, seconds, t]);
  } else {
    await db.run(COUNT_SQL, [scope, slot, seconds, seconds]);
  }
  const rows = await db.rows<{ n: number | string }>(READ_COUNT_SQL, [scope, slot]);
  return Number(rows[0].n);
}

// ------------------------------------------------------------------ the failure summary

const HOUR_NOW_SQL = "SELECT DATE_FORMAT(UTC_TIMESTAMP(6), '%Y-%m-%d %H:00:00.000000') AS h";
const READ_AUDIT_SQL = "SELECT DATE_FORMAT(window_start, '%Y-%m-%d %H:%i:%s.%f') AS w, n FROM sys_login_attempts WHERE scope = 'audit' AND slot = 0";
const CREATE_AUDIT_SQL = "INSERT IGNORE INTO sys_login_attempts (scope, slot, window_start, n) VALUES ('audit', 0, ?, 0)";
const CLAIM_SQL = "UPDATE sys_login_attempts SET window_start = ?, n = 0 WHERE scope = 'audit' AND slot = 0 AND window_start = ? AND n = ?";
const SUMMARY_SQL = "INSERT INTO audit_log (actor, actor_role, request_id, table_name, row_id, action, old_row, new_row) VALUES (NULL, 'job', NULL, 'login_failures', ?, 'event', NULL, ?)";
const ADD_FAILURE_SQL = "UPDATE sys_login_attempts SET n = n + 1 WHERE scope = 'audit' AND slot = 0";

/** The hour that ended, with the failures that were counted in it. */
export interface ClosedHour {
  hour: string;
  failures: number;
}

const hourOfDate = (d: Date): string => `${d.toISOString().slice(0, 13).replace('T', ' ')}:00:00.000000`;

/**
 * Moves the summary row to `hour` and, when the hour that ended had failures, writes ONE `login_failures` event for it, in one transaction. Exactly one caller wins: the update only succeeds
 * against the window AND the count that were read, so no failure counted meanwhile is lost (a plain `WHERE window_start < ?` could not tell the winner the count). With `add` the failure that
 * asked is counted as well, in the hour it is now. Returns the hour that was closed with failures, or null.
 */
async function claim(ctx: TxContext, now: Date | undefined, add: boolean): Promise<ClosedHour | null> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const seen = await withAutocommit(ctx, async (db) => {
      const hour = now ? hourOfDate(now) : (await db.rows<{ h: string }>(HOUR_NOW_SQL))[0].h;
      const rows = await db.rows<{ w: string; n: number | string }>(READ_AUDIT_SQL);
      if (!rows[0]) {
        await db.run(CREATE_AUDIT_SQL, [hour]);
        return { next: 'again' as const };
      }
      const row = { window: rows[0].w, n: Number(rows[0].n) };
      if (row.window >= hour) {
        // already the current hour (or a later one): nothing to close
        if (add) await db.run(ADD_FAILURE_SQL);
        return { next: 'done' as const };
      }
      return { next: 'claim' as const, hour, row };
    });
    if (seen.next === 'again') continue;
    if (seen.next === 'done') return null;
    const { hour, row } = seen;
    const won = await withTx(ctx, async (tx) => {
      const res = await tx.run(CLAIM_SQL, [hour, row.window, row.n]);
      if (res.affectedRows !== 1) return false; // somebody else claimed it, or counted a failure meanwhile: read again
      if (row.n > 0) await tx.run(SUMMARY_SQL, [row.window, JSON.stringify({ event: 'login_failures', hour_start: row.window.slice(0, 19), failures: row.n })]);
      return true;
    });
    if (!won) continue;
    if (add) await withAutocommit(ctx, (db) => db.run(ADD_FAILURE_SQL));
    return row.n > 0 ? { hour: row.window, failures: row.n } : null;
  }
  throw new Error('the login failure summary could not be claimed (it kept changing)');
}

/**
 * A failed login: closes the summary of an hour that has ended (see claim) and adds one to the current hour. Never writes a row for the attempt itself.
 * Do not call it inside an open transaction. Returns { closed: { hour, failures } | null }.
 */
export async function recordFailure(ctx: TxContext, options: { now?: Date | undefined } = {}): Promise<{ closed: ClosedHour | null }> {
  return { closed: await claim(ctx, options.now, true) };
}

/**
 * The housekeeping phase of the tick (I8): closes the summary of any finished hour that has failures not yet written, without waiting for another failed login, so the last hour of an attack
 * is not left. Returns { hour, failures } or null.
 */
export async function closeFinishedHour(ctx: TxContext, options: { now?: Date | undefined } = {}): Promise<ClosedHour | null> {
  return claim(ctx, options.now, false);
}
