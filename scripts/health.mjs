// I12 and the dashboard line of spec section 12 (read only): how old the last good export, the last good photo copy and the last nightly check are,
// how big the database is against the 2 GB red line, and whether the database user may Delete or Drop (S7 says both stay unticked).
// Everything is measured from one "now": the database's own UTC clock unless a test passes one in.
//
// Red: the last check says Problem, the last check is older than 26 hours (or none exists), the last GOOD export or photo copy is older than 26 hours
// (or none exists), or the database is above 2 GB. Amber: nothing is red but the user has a Delete or Drop right. Otherwise green.
// "Never ran" is red on purpose: on a new shop nothing is backed up until the first tick has run, and the owner should see that.

import { one } from './backup.mjs';

export const RED_AFTER_HOURS = 26;
export const DB_RED_LINE_BYTES = 2 * 1024 * 1024 * 1024;

const FMT = "%Y-%m-%d %H:%i:%s.%f";
const hoursBetween = (nowStr, thenStr) => Math.round(((Date.parse(nowStr.replace(' ', 'T') + 'Z') - Date.parse(thenStr.replace(' ', 'T') + 'Z')) / 3600_000) * 100) / 100;

/** `db`.* patterns of GRANT: an unescaped _ is any one character, % any run, a backslash makes either literal. */
function scopeMatches(pattern, dbName) {
  const re = pattern.replace(/\\(.)|[.*+?^${}()|[\]]|(_)|(%)/g, (m, esc, us, pc) => {
    if (esc !== undefined) return esc.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (us) return '.';
    if (pc) return '.*';
    return '\\' + m;
  });
  return new RegExp(`^${re}$`, 'i').test(dbName);
}

// The 18 boxes of hPanel's Change Permissions (A3). Ten are ticked; Delete, Drop and these six are not.
const ALL_BOXES = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'CREATE', 'DROP', 'REFERENCES', 'INDEX', 'ALTER', 'CREATE TEMPORARY TABLES', 'LOCK TABLES', 'EXECUTE', 'CREATE VIEW', 'SHOW VIEW', 'CREATE ROUTINE', 'ALTER ROUTINE', 'EVENT', 'TRIGGER'];
const TICKED = new Set(['SELECT', 'INSERT', 'UPDATE', 'CREATE', 'ALTER', 'INDEX', 'REFERENCES', 'TRIGGER', 'CREATE TEMPORARY TABLES', 'LOCK TABLES']);

async function readRights(conn, dbName) {
  const [grants] = await conn.query('SHOW GRANTS FOR CURRENT_USER()');
  const rights = { delete: false, drop: false, extra: [] };
  const held = new Set();
  for (const row of grants) {
    const line = String(Object.values(row)[0]);
    const m = /^GRANT (.+?) ON (.+?) TO /.exec(line);
    if (!m) continue; // a role grant or a proxy grant: no privileges listed
    const [, privs, scope] = m;
    const dbPart = scope.split(/\.(?=[^.]*$)/)[0]; // everything before the table part
    const unquoted = dbPart.replace(/^`|`$/g, '').replace(/``/g, '`');
    const onThisDb = dbPart === '*' || unquoted === '*' || scopeMatches(unquoted, dbName);
    if (!onThisDb) continue;
    const list = privs.split(',').map((p) => p.trim().toUpperCase());
    if (list.includes('ALL PRIVILEGES') || list.includes('ALL')) {
      rights.delete = true;
      rights.drop = true;
      for (const b of ALL_BOXES) held.add(b);
    }
    if (list.includes('DELETE')) rights.delete = true;
    if (list.includes('DROP')) rights.drop = true;
    for (const p of list) held.add(p);
  }
  rights.extra = [...held].filter((p) => ALL_BOXES.includes(p) && !TICKED.has(p)).sort();
  return rights;
}

export async function readHealth(conn, opts = {}) {
  const now = opts.now ?? (await conn.query(`SELECT DATE_FORMAT(UTC_TIMESTAMP(6), '${FMT}') AS t`))[0][0].t;

  const [chkRows] = await conn.query(`SELECT DATE_FORMAT(ran_at, '${FMT}') AS at, ok FROM check_runs ORDER BY ran_at DESC, id DESC LIMIT 1`);
  const chk = chkRows[0];
  const lastGood = async (kind) => {
    const [rows] = await conn.query(`SELECT DATE_FORMAT(MAX(ran_at), '${FMT}') AS at FROM backup_runs WHERE kind = ? AND ok = 1`, [kind]);
    return rows[0].at ?? null;
  };
  const dumpAt = await lastGood('db_dump');
  const photoAt = await lastGood('photo_copy');

  // P5: DATA_LENGTH + INDEX_LENGTH of the other tables after ANALYZE TABLE of each (the user may run it), plus SUM(byte_size) of the live photos, plus 12 percent for InnoDB overhead.
  // information_schema alone lags badly for a table of few large rows: it said 0.0 MB after 65 MB of photos were inserted and 69.5 MB after ANALYZE TABLE.
  const injected = typeof opts.sizeBytes === 'number';
  let dataBytes = 0;
  let indexBytes = 0;
  let photoBytes = 0;
  if (!injected) {
    const [tables] = await conn.query("SELECT TABLE_NAME AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE' AND TABLE_NAME <> 'design_photos' ORDER BY TABLE_NAME");
    if (opts.analyze !== false) for (const t of tables) await conn.query(`ANALYZE TABLE \`${String(t.n).replace(/`/g, '``')}\``);
    const sizeRows = (await conn.query("SELECT COALESCE(SUM(DATA_LENGTH), 0) AS d, COALESCE(SUM(INDEX_LENGTH), 0) AS i FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE' AND TABLE_NAME <> 'design_photos'"))[0];
    dataBytes = Number(sizeRows[0].d);
    indexBytes = Number(sizeRows[0].i);
    const photoRow = await one(conn, 'SELECT COALESCE(SUM(byte_size), 0) AS b FROM design_photos WHERE removed_at IS NULL');
    photoBytes = Number(photoRow.b);
  }
  const [nameRows] = await conn.query('SELECT DATABASE() AS name');
  const dbRow = nameRows[0];

  const check = { last_at: chk?.at ?? null, age_hours: chk?.at ? hoursBetween(now, chk.at) : null, ok: chk?.at ? Number(chk.ok) === 1 : null };
  const db_dump = { last_at: dumpAt, age_hours: dumpAt ? hoursBetween(now, dumpAt) : null };
  const photo_copy = { last_at: photoAt, age_hours: photoAt ? hoursBetween(now, photoAt) : null };
  const db_size = injected
    ? { bytes: opts.sizeBytes, data_bytes: opts.sizeBytes, index_bytes: 0, photo_bytes: 0, overhead_percent: 12, red_line_bytes: DB_RED_LINE_BYTES, injected: true }
    : { bytes: Math.round((dataBytes + indexBytes + photoBytes) * 1.12), data_bytes: dataBytes, index_bytes: indexBytes, photo_bytes: photoBytes, overhead_percent: 12, red_line_bytes: DB_RED_LINE_BYTES, injected: false };
  const rights = await readRights(conn, dbRow.name);

  const reasons = [];
  if (check.ok === false) reasons.push('check_problem');
  if (check.age_hours === null) reasons.push('check_never');
  else if (check.age_hours > RED_AFTER_HOURS) reasons.push('check_stale');
  if (db_dump.age_hours === null) reasons.push('dump_never');
  else if (db_dump.age_hours > RED_AFTER_HOURS) reasons.push('dump_stale');
  if (photo_copy.age_hours === null) reasons.push('photo_copy_never');
  else if (photo_copy.age_hours > RED_AFTER_HOURS) reasons.push('photo_copy_stale');
  if (db_size.bytes > DB_RED_LINE_BYTES) reasons.push('db_size');
  const red = reasons.length > 0;
  if (rights.delete || rights.drop) reasons.push('delete_or_drop_right');

  return { level: red ? 'red' : rights.delete || rights.drop ? 'amber' : 'green', reasons, check, db_dump, photo_copy, db_size, rights, now };
}
