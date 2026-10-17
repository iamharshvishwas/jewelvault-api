// D24, A13 and T-D30 (database half): the login counters and the hourly failure summary. sys_login_attempts is updated in place and never grows (at most 2 x 1,024 + 3 rows);
// a failed login is never written one by one: the `audit` row (slot 0) keeps the count of the current UTC hour, and the first failure after the hour has changed, or the tick's
// housekeeping, claims it and writes ONE audit_log event `login_failures` for the hour that ended, so an attack makes at most 24 audit rows a day.
// `now` (a Date) is a test seam; without it the database's own UTC clock is used.
import { createHash } from 'node:crypto';
import net from 'node:net';

export const WINDOW_SECONDS = { email: 900, addr: 60, any: 60 };
export const SLOTS = 1024;
const SCOPES = Object.keys(WINDOW_SECONDS);
const MICRO = (d) => d.toISOString().replace('T', ' ').replace('Z', '000');

/**
 * An address as it is counted: IPv4 as it is, an IPv4-mapped IPv6 address as the IPv4, any other IPv6 address shortened to its first 64 bits (`2001:db8:1:2::`), so that a whole
 * /64 network counts as one address (A13). `x-forwarded-for` is never read; the caller passes the `x-real-ip` header.
 */
export function addressKey(address) {
  let a = String(address).trim().toLowerCase();
  const zone = a.indexOf('%');
  if (zone >= 0) a = a.slice(0, zone);
  if (net.isIPv4(a)) return a;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a);
  if (mapped && net.isIPv4(mapped[1])) return mapped[1];
  if (!net.isIPv6(a)) return a; // something else: counted as the text it is
  const [head, tail] = a.split('::');
  const groups = (part) => (part ? part.split(':') : []);
  const expand = (list) =>
    list.flatMap((g) => {
      if (!g.includes('.')) return [g];
      const o = g.split('.').map(Number); // an embedded IPv4 tail takes two groups
      return [((o[0] << 8) | o[1]).toString(16), ((o[2] << 8) | o[3]).toString(16)];
    });
  const h = expand(groups(head));
  const t = a.includes('::') ? expand(groups(tail)) : [];
  const full = a.includes('::') ? [...h, ...Array(8 - h.length - t.length).fill('0'), ...t] : h;
  return `${full.slice(0, 4).map((g) => parseInt(g, 16).toString(16)).join(':')}::`;
}

/** The counter slot: the first two bytes of SHA-256(salt | lower-cased e-mail or shortened address) modulo 1,024 (D24). The salt is a secret from the environment (U10). */
export function loginSlot(salt, kind, value) {
  if (typeof salt !== 'string' || salt === '') throw new Error('loginSlot needs the secret salt');
  if (kind !== 'email' && kind !== 'addr') throw new Error(`kind must be email or addr, got ${JSON.stringify(kind)}`);
  const text = kind === 'email' ? String(value).trim().toLowerCase() : addressKey(value);
  return createHash('sha256').update(`${salt}|${text}`).digest().readUInt16BE(0) % SLOTS;
}

/**
 * Counts one attempt when the request ARRIVES, by one atomic statement (a window that has run out starts again at 1), then reads the count with a plain SELECT. Returns n.
 * Use it on a short checkout of the pool: it is two autocommit statements.
 */
export async function countAttempt(conn, scope, slot, { now } = {}) {
  if (!SCOPES.includes(scope)) throw new Error(`scope must be one of ${SCOPES.join(', ')}, got ${JSON.stringify(scope)}`);
  if (!Number.isInteger(slot) || slot < 0 || slot >= SLOTS) throw new Error(`slot must be a whole number from 0 to ${SLOTS - 1}, got ${JSON.stringify(slot)}`);
  const seconds = WINDOW_SECONDS[scope];
  const clock = now ? '?' : 'UTC_TIMESTAMP(6)';
  const t = now ? MICRO(now) : null;
  // n is assigned before window_start: the right-hand sides read the OLD window_start (MariaDB evaluates the assignments left to right)
  await conn.query(
    `INSERT INTO sys_login_attempts (scope, slot, window_start, n) VALUES (?, ?, ${clock}, 1)
     ON DUPLICATE KEY UPDATE n = IF(window_start < ${clock} - INTERVAL ? SECOND, 1, n + 1), window_start = IF(window_start < ${clock} - INTERVAL ? SECOND, ${clock}, window_start)`,
    now ? [scope, slot, t, t, seconds, t, seconds, t] : [scope, slot, seconds, seconds]
  );
  const [rows] = await conn.query('SELECT n FROM sys_login_attempts WHERE scope = ? AND slot = ?', [scope, slot]);
  return Number(rows[0].n);
}

async function hourOf(conn, now) {
  if (now) return `${now.toISOString().slice(0, 13).replace('T', ' ')}:00:00.000000`;
  const [rows] = await conn.query("SELECT DATE_FORMAT(UTC_TIMESTAMP(6), '%Y-%m-%d %H:00:00.000000') AS h");
  return rows[0].h;
}

const readAudit = async (conn) => {
  const [rows] = await conn.query("SELECT DATE_FORMAT(window_start, '%Y-%m-%d %H:%i:%s.%f') AS w, n FROM sys_login_attempts WHERE scope = 'audit' AND slot = 0");
  return rows[0] ? { window: rows[0].w, n: Number(rows[0].n) } : null;
};

/**
 * Moves the summary row to `hour` and, when the hour that ended had failures, writes ONE `login_failures` event for it, in one transaction. Exactly one caller wins: the update
 * only succeeds against the window AND the count that were read, so no failure counted meanwhile is lost (a plain `WHERE window_start < ?` could not tell the winner the count).
 * Returns { hour, failures } for the hour that was closed with failures, or null.
 */
async function claim(conn, hour) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const row = await readAudit(conn);
    if (!row) {
      await conn.query("INSERT IGNORE INTO sys_login_attempts (scope, slot, window_start, n) VALUES ('audit', 0, ?, 0)", [hour]);
      continue;
    }
    if (row.window >= hour) return null; // already the current hour (or a later one)
    await conn.query('START TRANSACTION');
    try {
      const [res] = await conn.query("UPDATE sys_login_attempts SET window_start = ?, n = 0 WHERE scope = 'audit' AND slot = 0 AND window_start = ? AND n = ?", [hour, row.window, row.n]);
      if (res.affectedRows !== 1) {
        await conn.query('ROLLBACK'); // somebody else claimed it, or counted a failure meanwhile: read again
        continue;
      }
      if (row.n > 0) {
        await conn.query(
          "INSERT INTO audit_log (actor, actor_role, request_id, table_name, row_id, action, old_row, new_row) VALUES (NULL, 'job', NULL, 'login_failures', ?, 'event', NULL, ?)",
          [row.window, JSON.stringify({ event: 'login_failures', hour_start: row.window.slice(0, 19), failures: row.n })]
        );
      }
      await conn.query('COMMIT');
      return row.n > 0 ? { hour: row.window, failures: row.n } : null;
    } catch (e) {
      await conn.query('ROLLBACK').catch(() => undefined);
      throw e;
    }
  }
  throw new Error('the login failure summary could not be claimed (it kept changing)');
}

/**
 * A failed login: closes the summary of an hour that has ended (see claim) and adds one to the current hour. Never writes a row for the attempt itself.
 * Do not call it inside an open transaction. Returns { closed: { hour, failures } | null }.
 */
export async function recordFailure(conn, { now } = {}) {
  const hour = await hourOf(conn, now);
  const closed = await claim(conn, hour);
  await conn.query("UPDATE sys_login_attempts SET n = n + 1 WHERE scope = 'audit' AND slot = 0");
  return { closed };
}

/**
 * The housekeeping phase of the tick (I8): closes the summary of any finished hour that has failures not yet written, without waiting for another failed login, so the last
 * hour of an attack is not left. Returns { hour, failures } or null.
 */
export async function closeFinishedHour(conn, { now } = {}) {
  return claim(conn, await hourOf(conn, now));
}
