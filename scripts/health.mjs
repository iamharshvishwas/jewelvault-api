// I12 and the dashboard line of spec section 12 (read only): how old the last good export, the last good photo copy and the last nightly check are,
// how big the database is against the 2 GB red line, and whether the database user may Delete or Drop (S7 says both stay unticked).
// Everything is measured from one "now": the database's own UTC clock unless a test passes one in.
//
// Red: the last check says Problem, the last check is older than 26 hours (or none exists), the last GOOD export or photo copy is older than 26 hours
// (or none exists), the backup folder's file count fell without a prune (B2), the backup folder cannot be used (the dump's folder probe says so and no good run is newer: RV3a-F3), a photo copy in
// the folder is damaged and still waiting for somebody (RV3a-F1), a good export or photo copy is dated in the future (a wrong clock on the cron host hides a dead export: RV3a-F4), the database is above
// 2 GB, or the owner's last Download everything is more than 35 days old (B3, O53).
// Amber: nothing is red but the owner's download is 28 days old or more, Harsh's weekly pull (O54) is more than 10 days old, the nightly check wrote a vanished photo copy again in the last 7 days
// (RV3a-F1), or the user has a Delete or Drop right (S11). Otherwise green.
// "Never ran" is red on purpose: on a new shop nothing is backed up until the first tick has run, and the owner should see that.
// Days are whole Asia/Kolkata calendar dates (the shop's day, B3), not 24-hour spans.

import { one } from './backup.mjs';

export const RED_AFTER_HOURS = 26;
export const DB_RED_LINE_BYTES = 2 * 1024 * 1024 * 1024;
export const DOWNLOAD_AMBER_DAYS = 28; // amber at this many days or more (O53)
export const DOWNLOAD_RED_DAYS = 35; // red above this many days (O53)
export const PULL_AMBER_DAYS = 10; // amber above this many days (O54)
export const FOLDER_FALL_WINDOW_DAYS = 7; // a fall of the folder's file count stays red for this long, so it is not gone before anyone looked
export const CLOCK_SKEW_MINUTES = 5; // a good run dated up to this long after "now" is the difference between the clock of the app and of cron, not a fault (RV3a-F4)

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
/** The instant as DATETIME(6) text in UTC. */
const stampMs = (ms) => new Date(ms).toISOString().slice(0, 23).replace('T', ' ') + '000';
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
  // RV3a-F4: the dump stamps ran_at from the clock of the cron host. A good run dated AFTER "now" (more than the skew between two clocks) would make a negative age, which is never stale, and a dead
  // export would look fresh until the future arrived. So the age is taken from the newest good run that is not in the future, and a good run in the future is red by itself (backup_clock_ahead).
  // The rows the line reads about the folder and the photo copies leave the future out too: it must not heal the folder signal or become "the last run".
  const horizon = stampMs(utcMs(now) + CLOCK_SKEW_MINUTES * 60_000);
  const lastGood = async (kind) => {
    const [rows] = await conn.query(`SELECT DATE_FORMAT(MAX(ran_at), '${FMT}') AS at FROM backup_runs WHERE kind = ? AND ok = 1 AND ran_at <= ?`, [kind, horizon]);
    return rows[0].at ?? null;
  };
  const dumpAt = await lastGood('db_dump');
  const photoAt = await lastGood('photo_copy');
  const [aheadRows] = await conn.query(`SELECT DATE_FORMAT(MAX(ran_at), '${FMT}') AS at FROM backup_runs WHERE ok = 1 AND kind IN ('db_dump', 'photo_copy') AND ran_at > ?`, [horizon]);
  const aheadAt = aheadRows[0].at ?? null;
  const clock_ahead = aheadAt ? { last_at: aheadAt, hours: hoursBetween(aheadAt, now) } : null;

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
    `SELECT DATE_FORMAT(ran_at, '${FMT}') AS at, detail FROM backup_runs WHERE ok = 1 AND kind IN ('db_dump', 'photo_copy') AND ran_at <= ? AND JSON_VALUE(detail, '$.folder.files') IS NOT NULL ORDER BY ran_at DESC, id DESC LIMIT 60`,
    [horizon]
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

  // RV3a-F1: the nightly check of the photo copies (src/jobs/photoVerify.ts) writes backup_runs.detail.verify = { repaired, damaged_total, ... } on every photo_copy row it ends, good or failed. The
  // repairs of the last FOLDER_FALL_WINDOW_DAYS days are amber (a copy that vanished from the folder was written again); the NEWEST row that has a `verify` says whether a damaged copy is still
  // waiting for somebody (never overwritten, B2): red until a newer row has none, and the phase cannot end ok while a copy is damaged.
  const [verifyRows] = await conn.query(
    `SELECT DATE_FORMAT(ran_at, '${FMT}') AS at, JSON_VALUE(detail, '$.verify.repaired') AS repaired, JSON_VALUE(detail, '$.verify.damaged_total') AS damaged FROM backup_runs WHERE kind = 'photo_copy' AND ran_at <= ? AND JSON_CONTAINS_PATH(detail, 'one', '$.verify') ORDER BY ran_at DESC, id DESC LIMIT 60`,
    [horizon]
  );
  const photo_files = { repaired: 0, repaired_at: null, damaged: 0, damaged_at: null };
  const repairsFrom = utcMs(now) - FOLDER_FALL_WINDOW_DAYS * 86_400_000;
  verifyRows.forEach((r, i) => {
    if (i === 0 && Number(r.damaged) > 0) {
      photo_files.damaged = Number(r.damaged);
      photo_files.damaged_at = r.at;
    }
    if (Number(r.repaired) > 0 && utcMs(r.at) >= repairsFrom) {
      photo_files.repaired += Number(r.repaired);
      photo_files.repaired_at ??= r.at;
    }
  });

  // RV3a-F3: the folder signal of API34 (scripts/dump-job.mjs recordFolderProbe, twin src/jobs/backupProbe.ts). A probe that fails is a backup_runs row of kind db_dump, ok 0, detail
  // {phase: 'folder_probe', folder_probe: {ok: false, code, where}}; a probe that passes after a failure writes the heal row {ok: true}. The NEWEST such row (by id, the order it was written in, as the
  // writer reads it) is the state of the folder; a failure is red until a good db_dump or photo_copy row is NEWER than it, which proves the folder was written to afterwards. JSON_VALUE gives a JSON
  // false as the text '0' on MariaDB 11.8 (another version may say 'false'), and the writer reads anything else as ok, so the reader does too.
  const [probeRows] = await conn.query(
    `SELECT DATE_FORMAT(ran_at, '${FMT}') AS at, JSON_VALUE(detail, '$.folder_probe.ok') AS ok, JSON_VALUE(detail, '$.folder_probe.code') AS code, JSON_VALUE(detail, '$.folder_probe.where') AS wh FROM backup_runs WHERE kind = 'db_dump' AND JSON_CONTAINS_PATH(detail, 'one', '$.folder_probe') ORDER BY id DESC LIMIT 1`
  );
  let folder_probe = null;
  if (probeRows.length > 0) {
    const p = probeRows[0];
    const failed = p.ok === '0' || p.ok === 'false';
    folder_probe = failed ? { ok: false, code: p.code ?? null, where: p.wh ?? null, at: p.at } : { ok: true, code: null, where: null, at: p.at };
  }
  let folderUnusable = false;
  if (folder_probe && folder_probe.ok === false) {
    const [healed] = await conn.query("SELECT 1 AS n FROM backup_runs WHERE ok = 1 AND kind IN ('db_dump', 'photo_copy') AND ran_at > ? AND ran_at <= ? LIMIT 1", [folder_probe.at, horizon]);
    folderUnusable = healed.length === 0;
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
  if (folderUnusable) reasons.push('backup_folder_unusable');
  if (photo_files.damaged > 0) reasons.push('backup_photos_damaged');
  if (clock_ahead) reasons.push('backup_clock_ahead');
  if (db_size.bytes > DB_RED_LINE_BYTES) reasons.push('db_size');
  if (download.state === 'red') reasons.push('download_red');
  const red = reasons.length > 0;
  if (download.state === 'amber') reasons.push('download_amber');
  if (pull.state === 'amber') reasons.push('pulled_amber');
  if (photo_files.repaired > 0) reasons.push('backup_photos_repaired');
  if (rights.delete || rights.drop) reasons.push('delete_or_drop_right');

  return { level: red ? 'red' : reasons.length > 0 ? 'amber' : 'green', reasons, check, db_dump, photo_copy, folder, folder_probe, photo_files, clock_ahead, download, pull, db_size, rights, now };
}
