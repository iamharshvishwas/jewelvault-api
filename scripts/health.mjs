// I12 and the dashboard line of spec section 12 (read only): how old the last good export, the last good photo copy and the last nightly check are,
// how big the database is against the 2 GB red line, and whether the database user may Delete or Drop (S7 says both stay unticked).
// Everything is measured from one "now": the database's own UTC clock unless a test passes one in.
//
// Red: the last check says Problem, the last check is older than 26 hours (or none exists), the last GOOD export or photo copy is older than 26 hours
// (or none exists), the backup folder's file count fell without a prune (B2), the database is above 2 GB, or the owner's last Download everything is more than 35 days old (B3, O53).
// Amber: nothing is red but the owner's download is 28 days old or more, Harsh's weekly pull (O54) is more than 10 days old, or the user has a Delete or Drop right (S11). Otherwise green.
// "Never ran" is red on purpose: on a new shop nothing is backed up until the first tick has run, and the owner should see that.
// Days are whole Asia/Kolkata calendar dates (the shop's day, B3), not 24-hour spans.

import { one } from './backup.mjs';

export const RED_AFTER_HOURS = 26;
export const DB_RED_LINE_BYTES = 2 * 1024 * 1024 * 1024;
export const DOWNLOAD_AMBER_DAYS = 28; // amber at this many days or more (O53)
export const DOWNLOAD_RED_DAYS = 35; // red above this many days (O53)
export const PULL_AMBER_DAYS = 10; // amber above this many days (O54)
export const FOLDER_FALL_WINDOW_DAYS = 7; // a fall of the folder's file count stays red for this long, so it is not gone before anyone looked

const FMT = "%Y-%m-%d %H:%i:%s.%f";
const utcMs = (text) => Date.parse(String(text).includes('T') ? String(text) : String(text).replace(' ', 'T') + 'Z');
/** The Asia/Kolkata calendar date (UTC+05:30, no daylight saving) of a UTC instant given as a DATETIME text or an ISO string; null when it is not a date. */
const kolkataDate = (text) => {
  const ms = utcMs(text);
  return Number.isFinite(ms) ? new Date(ms + 19_800_000).toISOString().slice(0, 10) : null;
};
const wholeDays = (laterDate, earlierDate) => Math.round((Date.parse(laterDate) - Date.parse(earlierDate)) / 86_400_000);
const parseJson = (v) => {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'string') return v;
  try {
    return JSON.parse(v);
  } catch {
    return null;
  }
};
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

  // B3, O53: the days since the owner's last Download everything, counted from settings.last_download.at, or with none from the oldest check_runs row (the first night).
  const today = kolkataDate(now);
  const [dlRows] = await conn.query("SELECT value FROM settings WHERE setting_key = 'last_download'");
  const lastDownloadAt = parseJson(dlRows[0]?.value)?.at;
  let download = { state: 'unknown', from: null, reference_date: null, age_days: null };
  const fromDownload = lastDownloadAt ? kolkataDate(lastDownloadAt) : null;
  if (fromDownload) download = { from: 'last_download', reference_date: fromDownload };
  else {
    const firstNight = (await conn.query(`SELECT DATE_FORMAT(MIN(ran_at), '${FMT}') AS at FROM check_runs`))[0][0].at;
    if (firstNight) download = { from: 'first_night', reference_date: kolkataDate(firstNight) };
  }
  if (download.reference_date) {
    download.age_days = wholeDays(today, download.reference_date);
    download.state = download.age_days > DOWNLOAD_RED_DAYS ? 'red' : download.age_days >= DOWNLOAD_AMBER_DAYS ? 'amber' : 'ok';
  }

  // O54: the days since Harsh's weekly pull, from settings.last_pulled.at, or with none from the first good export.
  const [pullRows] = await conn.query("SELECT value FROM settings WHERE setting_key = 'last_pulled'");
  const lastPulledAt = parseJson(pullRows[0]?.value)?.at;
  let pull = { state: 'unknown', from: null, reference_date: null, age_days: null };
  const fromPull = lastPulledAt ? kolkataDate(lastPulledAt) : null;
  if (fromPull) pull = { from: 'last_pulled', reference_date: fromPull };
  else {
    const firstExport = (await conn.query(`SELECT DATE_FORMAT(MIN(ran_at), '${FMT}') AS at FROM backup_runs WHERE kind = 'db_dump' AND ok = 1`))[0][0].at;
    if (firstExport) pull = { from: 'first_export', reference_date: kolkataDate(firstExport) };
  }
  if (pull.reference_date) {
    pull.age_days = wholeDays(today, pull.reference_date);
    pull.state = pull.age_days > PULL_AMBER_DAYS ? 'amber' : 'ok';
  }

  // B2: the backup folder as the good runs recorded it (backup_runs.detail.folder = {files, bytes, free_bytes}; detail.pruned = how many files that run removed on purpose).
  // The file count FALLING by more than was pruned, between two consecutive recorded runs, is red; the flag stays for FOLDER_FALL_WINDOW_DAYS so a night's fall is still visible the day after.
  const [folderRows] = await conn.query(
    `SELECT DATE_FORMAT(ran_at, '${FMT}') AS at, detail FROM backup_runs WHERE ok = 1 AND kind IN ('db_dump', 'photo_copy') AND JSON_VALUE(detail, '$.folder.files') IS NOT NULL ORDER BY ran_at DESC, id DESC LIMIT 60`
  );
  const seen = folderRows.reverse().map((r) => ({ at: r.at, detail: parseJson(r.detail) }));
  let folder = null;
  if (seen.length > 0) {
    const last = seen[seen.length - 1];
    const f = last.detail.folder;
    let fell = false;
    let fellAt = null;
    const windowStart = utcMs(now) - FOLDER_FALL_WINDOW_DAYS * 86_400_000;
    for (let i = 1; i < seen.length; i++) {
      const before = Number(seen[i - 1].detail.folder.files);
      const after = Number(seen[i].detail.folder.files);
      const pruned = Number(seen[i].detail.pruned ?? 0);
      if (after < before - pruned && utcMs(seen[i].at) >= windowStart) {
        fell = true;
        fellAt = seen[i].at;
      }
    }
    folder = {
      files: Number(f.files),
      bytes: Number(f.bytes ?? 0),
      free_bytes: f.free_bytes === undefined || f.free_bytes === null ? null : Number(f.free_bytes),
      previous_files: seen.length > 1 ? Number(seen[seen.length - 2].detail.folder.files) : null,
      recorded_at: last.at,
      fell,
      fell_at: fellAt,
    };
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
  if (folder?.fell) reasons.push('backup_files_fell');
  if (db_size.bytes > DB_RED_LINE_BYTES) reasons.push('db_size');
  if (download.state === 'red') reasons.push('download_red');
  const red = reasons.length > 0;
  if (download.state === 'amber') reasons.push('download_amber');
  if (pull.state === 'amber') reasons.push('pulled_amber');
  if (rights.delete || rights.drop) reasons.push('delete_or_drop_right');

  return { level: red ? 'red' : reasons.length > 0 ? 'amber' : 'green', reasons, check, db_dump, photo_copy, folder, download, pull, db_size, rights, now };
}
