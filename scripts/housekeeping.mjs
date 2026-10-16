// Statements the spec gives to the database session in draft 5.2 (18.13 E): the error log with its cap (D25), the photo insert with its count and caps (P2), the two admin-door statements (U3).
// Each is one statement (or a short loop) and the table's own keys make the cap strict under concurrency; the API calls these, it does not re-write them.
import { createHash } from 'node:crypto';
import { loadQueries } from './queries.mjs';

const Q = loadQueries();
export const ERROR_LOG_PER_MINUTE = 20;
const minuteOf = (d) => d.toISOString().slice(0, 16).replace('T', ' ') + ':00';
const stamp = (d) => d.toISOString().slice(0, 23).replace('T', ' ') + '000';

/**
 * D25: at most 20 rows a minute for each error code. The next free seq (1 to 20) is taken in the same statement as the insert and is UNIQUE per (code, minute), so eight connections racing
 * cannot write a 21st row; beyond 20 the count is added to detail.suppressed of the row with seq 20 by one atomic UPDATE, so no occurrence is lost.
 */
export async function logError(conn, entry, opts = {}) {
  const now = opts.now ?? new Date();
  const minute = minuteOf(now);
  const detail = entry.detail === undefined || entry.detail === null ? null : JSON.stringify(entry.detail);
  const message = String(entry.message ?? '').slice(0, 500);
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      const [res] = await conn.query(
        `INSERT INTO sys_error_log (at, minute_at, seq, level, code, message, request_id, user_id, detail)
         SELECT ?, ?, n.next, ?, ?, ?, ?, ?, ?
         FROM (SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM sys_error_log WHERE code = ? AND minute_at = ?) n
         WHERE n.next <= ${ERROR_LOG_PER_MINUTE}`,
        [stamp(now), minute, entry.level, entry.code, message, entry.request_id ?? null, entry.user_id ?? null, detail, entry.code, minute]
      );
      if (res.affectedRows === 1) return { written: true };
      break; // the twentieth row of this minute exists already
    } catch (e) {
      if (e.errno === 1062) continue; // another connection took the same seq a moment ago: take the next
      throw e;
    }
  }
  await conn.query(
    `UPDATE sys_error_log
        SET detail = JSON_SET(COALESCE(detail, JSON_OBJECT()), '$.suppressed', COALESCE(JSON_VALUE(detail, '$.suppressed'), 0) + 1)
      WHERE code = ? AND minute_at = ? AND seq = ${ERROR_LOG_PER_MINUTE}`,
    [entry.code, minute]
  );
  return { written: false, suppressed: true };
}

/** P2: the unattached photos (their design_id is not a design yet): how many distinct ids and how many bytes. */
export async function unattachedPhotos(conn) {
  const [rows] = await conn.query(Q.P2_unattached);
  return { photos: Number(rows[0].photos), bytes: Number(rows[0].bytes) };
}

/**
 * P2: store one photo object if the design has fewer than `perDesign` distinct live photo ids and, for a design that does not exist yet, the unattached caps hold. One statement.
 * Returns { inserted: true } or { inserted: false, reason } (design_full, unattached_count, unattached_bytes). A (id, kind) pair that exists raises the duplicate-key error (insert-only).
 */
export async function insertPhotoGuarded(conn, photo, caps) {
  const bytes = Buffer.from(photo.bytes);
  const sha = createHash('sha256').update(bytes).digest('hex');
  const [res] = await conn.query(Q.P2_insert, [
    photo.id, photo.kind, photo.design_id, photo.mime, bytes.length, sha, bytes, photo.created_by ?? null,
    photo.design_id, photo.id, caps.perDesign,
    photo.design_id,
    photo.id, caps.unattachedPhotos, bytes.length, caps.unattachedBytes,
  ]);
  if (res.affectedRows === 1) return { inserted: true };
  const [[d]] = await conn.query('SELECT COUNT(DISTINCT id) AS n FROM design_photos WHERE design_id = ? AND removed_at IS NULL AND id <> ?', [photo.design_id, photo.id]).then((r) => [r[0]]);
  if (Number(d.n) >= caps.perDesign) return { inserted: false, reason: 'design_full' };
  const u = await unattachedPhotos(conn);
  if (u.photos >= caps.unattachedPhotos) return { inserted: false, reason: 'unattached_count' };
  return { inserted: false, reason: 'unattached_bytes' };
}

/**
 * U3, the admin door: sets n to 0 and the window to now on every row of the counting scopes (email, addr, any) so that Harsh can unblock a shop with one command; the summary row
 * (scope audit) is left alone. The scopes are named, so the statement uses the primary key.
 */
export async function clearLoginCounters(conn) {
  const [res] = await conn.query("UPDATE sys_login_attempts SET n = 0, window_start = UTC_TIMESTAMP(6) WHERE scope IN ('email', 'addr', 'any')");
  return { cleared: res.affectedRows };
}

/** U3 / O54, the admin door: records that Harsh pulled the newest export (settings.last_pulled = {at, by, file, sha256}). The health line reads it (I12). */
export async function recordPull(conn, pull) {
  if (typeof pull.at !== 'string' || Number.isNaN(Date.parse(pull.at))) throw new Error('recordPull: at must be a time like 2026-10-10T05:00:00.000Z');
  if (typeof pull.by !== 'string' || pull.by.trim() === '') throw new Error('recordPull: by is blank');
  if (typeof pull.file !== 'string' || !/^(daily|monthly)\/\d{4}-\d{2}(-\d{2})?(-[0-9A-Za-z][0-9A-Za-z-]{0,39})?\.enc$/.test(pull.file)) throw new Error('recordPull: file must be a backup name like daily/2026-10-10.enc');
  if (typeof pull.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(pull.sha256)) throw new Error('recordPull: sha256 must be 64 hex characters');
  const value = JSON.stringify({ at: pull.at, by: pull.by, file: pull.file, sha256: pull.sha256.toLowerCase() });
  await conn.query("INSERT INTO settings (setting_key, value) VALUES ('last_pulled', ?) ON DUPLICATE KEY UPDATE value = VALUES(value)", [value]);
  return { recorded: true };
}

// ---------------------------------------------------------------- the job locks (I8, RF5-3, RM5-4)

/** MariaDB refuses a lock name longer than 64 characters. */
export const LOCK_NAME_MAX = 64;

/**
 * The name of a job lock: `jv_tick:<database>` or `jv_dump:<database>`. A lock name is SERVER-WIDE in MariaDB (across databases and users), so the database name is part of it:
 * production and staging on one server must not block each other.
 */
export async function jobLockName(conn, kind) {
  if (!['tick', 'dump'].includes(kind)) throw new Error(`unknown job lock: ${JSON.stringify(kind)}`);
  const row = (await conn.query('SELECT DATABASE() AS db'))[0][0];
  if (!row.db) throw new Error('the connection has no database selected');
  const name = `jv_${kind}:${row.db}`;
  if (name.length > LOCK_NAME_MAX) throw new Error(`the lock name ${name} is longer than ${LOCK_NAME_MAX} characters: the database name is too long`);
  return name;
}

/**
 * Runs `fn` only when nobody else holds the job lock (GET_LOCK with timeout 0, so a second tick answers "already running" at once). A lock belongs to the CONNECTION, not to the
 * transaction, and a pooled connection lives on, so RELEASE_LOCK runs in a finally. If `fn` throws, the error is marked `destroyConnection = true`: the caller must destroy the
 * connection instead of returning it to the pool (a lock that could not be released dies with its connection).
 * Returns { ran: false, name } when the lock is taken, else { ran: true, name, value, released }.
 */
export async function withJobLock(conn, kind, fn) {
  const name = await jobLockName(conn, kind);
  const got = (await conn.query('SELECT GET_LOCK(?, 0) AS got', [name]))[0][0];
  if (Number(got.got) !== 1) return { ran: false, name };
  let failure = null;
  let value;
  try {
    value = await fn();
  } catch (e) {
    failure = e;
    if (e && typeof e === 'object') e.destroyConnection = true;
  }
  let released = false;
  try {
    const r = (await conn.query('SELECT RELEASE_LOCK(?) AS released', [name]))[0][0];
    released = Number(r.released) === 1;
  } catch {
    // the connection is gone: the lock went with it
    released = true;
  }
  if (failure) throw failure;
  if (!released) {
    const e = new Error(`the job lock ${name} could not be released`);
    e.destroyConnection = true;
    throw e;
  }
  return { ran: true, name, value, released };
}
