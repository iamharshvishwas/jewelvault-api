// I12 and the dashboard line of spec section 12 (owner only): GET /v1/dashboard/health, and the lists of GET /v1/health/checks.
//
// readHealth is the TYPESCRIPT TWIN of readHealth in scripts/health.mjs (MB03, MB05): src/ is compiled alone (tsconfig.build.json, rootDir src) and cannot import scripts/*.mjs. It does what the
// original does, statement for statement, and tests/api/health-twin.test.ts asks both the same question on every state of the database (never run, healthy, each red and amber reason, the rights of
// the user) and requires the same answer. A change to the original is made here too, or that test fails.
//
// What it answers (read only; one "now", the caller's): how old the last check, the last GOOD export and the last GOOD photo copy are, how big the database is against the 2 GB red line (P5: the
// size of the other tables after ANALYZE TABLE, plus the live photos, plus 12 percent), the backup folder as the last good run recorded it (B2), the days since the owner's last Download
// everything (B3, O53) and since Harsh's last weekly pull (O54), and what the database user may do (Delete and Drop stay unticked, S7). Red: the last check says Problem or is older than 26 hours or
// never ran, the last good export or photo copy is older than 26 hours or never was, the folder's file count fell without a prune, the backup folder cannot be used (the dump's folder probe says so and
// no good run is newer: RV3a-F3), a photo copy in the folder is damaged and still waiting for somebody (RV3a-F1), a good export or photo copy is dated in the future (a wrong clock on the cron host
// would hide a dead export: RV3a-F4), the database is above 2 GB, the download is more than 35 days old.
// Amber: nothing is red but the download is 28 days old or more, the pull is more than 10 days old, the nightly check wrote a vanished photo copy again in the last 7 days (RV3a-F1), or the user has
// a Delete or Drop right. Days are whole Asia/Kolkata calendar dates.
//
// The route repeats the figures and the reasons and changes nothing but the way an instant is written: the wire format of S3 ('2026-10-17T08:30:00.000000Z', wireHealth below).
import type { Connection, RowDataPacket } from 'mysql2/promise';
import type { Reader } from '../db/tx.js';
import { limits } from '../limits.js';
import { scopeMatches } from '../preflight.js';
import { formatRow, timestampToWire } from '../wire/format.js';
import * as wire from '../wire/zod.js';
import { z } from 'zod';
import { readColumns, selectList } from './columns.js';

export const RED_AFTER_HOURS = 26;
export const DB_RED_LINE_BYTES = 2 * 1024 * 1024 * 1024;
export const DOWNLOAD_AMBER_DAYS = 28; // amber at this many days or more (O53)
export const DOWNLOAD_RED_DAYS = 35; // red above this many days (O53)
export const PULL_AMBER_DAYS = 10; // amber above this many days (O54)
export const FOLDER_FALL_WINDOW_DAYS = 7; // a fall of the folder's file count stays red for this long, so it is not gone before anyone looked
export const CLOCK_SKEW_MINUTES = 5; // a good run dated up to this long after "now" is the difference between the clock of the app and of cron, not a fault (RV3a-F4)

export interface Age {
  last_at: string | null;
  age_hours: number | null;
}
export interface Health {
  /** 'red' (something is wrong), 'amber' (the database user may delete or drop, or a reminder is due), or 'green'. */
  level: 'red' | 'amber' | 'green';
  /** Why it is red or amber, in the order of the dashboard. */
  reasons: string[];
  check: Age & { ok: boolean | null };
  db_dump: Age;
  photo_copy: Age;
  db_size: { bytes: number; data_bytes: number; index_bytes: number; photo_bytes: number; overhead_percent: number; red_line_bytes: number; injected: boolean };
  download: { state: 'ok' | 'amber' | 'red' | 'unknown'; from: 'last_download' | 'first_night' | null; reference_date: string | null; age_days: number | null };
  pull: { state: 'ok' | 'amber' | 'unknown'; from: 'last_pulled' | 'first_export' | null; reference_date: string | null; age_days: number | null };
  folder: { files: number; bytes: number; free_bytes: number | null; previous_files: number | null; recorded_at: string; fell: boolean; fell_at: string | null } | null;
  /** RV3a-F4: the newest GOOD export or photo copy dated more than CLOCK_SKEW_MINUTES after "now" (a wrong clock on the cron host), and how many hours ahead it is; null when there is none. The ages above ignore such a run. */
  clock_ahead: { last_at: string; hours: number } | null;
  /** RV3a-F3, the folder signal of the dump (API34): the newest folder probe, or null when there never was one. ok false = the folder could not be used (code ENOENT, EACCES, ENOTDIR ..., or CONFIG; where = folder, a sub-folder or JV_BACKUP_DIR); ok true = the heal row. */
  folder_probe: { ok: boolean; code: string | null; where: string | null; at: string } | null;
  /** RV3a-F1, the nightly check of the photo copies: copies written again in the last 7 days (and when last), and copies found damaged and not yet fixed (and when they were found). */
  photo_files: { repaired: number; repaired_at: string | null; damaged: number; damaged_at: string | null };
  rights: { delete: boolean; drop: boolean; extra: string[] };
  now: string;
}
export interface HealthOptions {
  /** 'YYYY-MM-DD HH:MM:SS' (fraction allowed) in UTC; default: the database's own UTC_TIMESTAMP(). */
  now?: string;
  /** Replaces the measured database size. Test seam. */
  sizeBytes?: number;
  /** Run ANALYZE TABLE on the other tables before measuring (default true). */
  analyze?: boolean;
}
/** A mysql2 connection (the pool's or a plain one): the text protocol, which SHOW GRANTS and ANALYZE TABLE need. */
export type HealthConnection = Pick<Connection, 'query'>;

const FMT = '%Y-%m-%d %H:%i:%s.%f';
const utcMs = (text: string): number => Date.parse(String(text).includes('T') ? String(text) : `${String(text).replace(' ', 'T')}Z`);
/** The Asia/Kolkata calendar date (UTC+05:30, no daylight saving) of a UTC instant given as a DATETIME text or an ISO string; null when it is not a date. */
const kolkataDate = (text: string): string | null => {
  const ms = utcMs(text);
  return Number.isFinite(ms) ? new Date(ms + 19_800_000).toISOString().slice(0, 10) : null;
};
const wholeDays = (laterDate: string, earlierDate: string): number => Math.round((Date.parse(laterDate) - Date.parse(earlierDate)) / 86_400_000);
const parseJson = (v: unknown): any => {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'string') return v;
  try {
    return JSON.parse(v);
  } catch {
    return null;
  }
};
/** The instant as DATETIME(6) text in UTC. */
const stampMs = (ms: number): string => `${new Date(ms).toISOString().slice(0, 23).replace('T', ' ')}000`;
const hoursBetween = (nowStr: string, thenStr: string): number => Math.round(((Date.parse(`${nowStr.replace(' ', 'T')}Z`) - Date.parse(`${thenStr.replace(' ', 'T')}Z`)) / 3600_000) * 100) / 100;

// The 18 boxes of hPanel's Change Permissions (A3). Ten are ticked; Delete, Drop and these six are not.
const ALL_BOXES = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'CREATE', 'DROP', 'REFERENCES', 'INDEX', 'ALTER', 'CREATE TEMPORARY TABLES', 'LOCK TABLES', 'EXECUTE', 'CREATE VIEW', 'SHOW VIEW', 'CREATE ROUTINE', 'ALTER ROUTINE', 'EVENT', 'TRIGGER'];
const TICKED = new Set(['SELECT', 'INSERT', 'UPDATE', 'CREATE', 'ALTER', 'INDEX', 'REFERENCES', 'TRIGGER', 'CREATE TEMPORARY TABLES', 'LOCK TABLES']);

async function readRights(conn: HealthConnection, dbName: string): Promise<Health['rights']> {
  const [grants] = await conn.query<RowDataPacket[]>('SHOW GRANTS FOR CURRENT_USER()');
  const rights = { delete: false, drop: false, extra: [] as string[] };
  const held = new Set<string>();
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

export async function readHealth(conn: HealthConnection, opts: HealthOptions = {}): Promise<Health> {
  const rows = async (sql: string, params?: unknown[]): Promise<RowDataPacket[]> => (await conn.query<RowDataPacket[]>(sql, params))[0];
  const now = opts.now ?? String((await rows(`SELECT DATE_FORMAT(UTC_TIMESTAMP(6), '${FMT}') AS t`))[0].t);

  const chk = (await rows(`SELECT DATE_FORMAT(ran_at, '${FMT}') AS at, ok FROM check_runs ORDER BY ran_at DESC, id DESC LIMIT 1`))[0];
  // RV3a-F4: the dump stamps ran_at from the clock of the cron host. A good run dated AFTER "now" (more than the skew between two clocks) would make a negative age, which is never stale, and a dead
  // export would look fresh until the future arrived. So the age is taken from the newest good run that is not in the future, and a good run in the future is red by itself (backup_clock_ahead).
  // The rows the line reads about the folder and the photo copies leave the future out too: it must not heal the folder signal or become "the last run".
  const horizon = stampMs(utcMs(now) + CLOCK_SKEW_MINUTES * 60_000);
  const lastGood = async (kind: string): Promise<string | null> => {
    const r = await rows(`SELECT DATE_FORMAT(MAX(ran_at), '${FMT}') AS at FROM backup_runs WHERE kind = ? AND ok = 1 AND ran_at <= ?`, [kind, horizon]);
    return (r[0].at as string | null) ?? null;
  };
  const dumpAt = await lastGood('db_dump');
  const photoAt = await lastGood('photo_copy');
  const aheadAt = ((await rows(`SELECT DATE_FORMAT(MAX(ran_at), '${FMT}') AS at FROM backup_runs WHERE ok = 1 AND kind IN ('db_dump', 'photo_copy') AND ran_at > ?`, [horizon]))[0].at as string | null) ?? null;
  const clock_ahead: Health['clock_ahead'] = aheadAt ? { last_at: aheadAt, hours: hoursBetween(aheadAt, now) } : null;

  // P5: DATA_LENGTH + INDEX_LENGTH of the other tables after ANALYZE TABLE of each (the user may run it), plus SUM(byte_size) of the live photos, plus 12 percent for InnoDB overhead.
  // information_schema alone lags badly for a table of few large rows: it said 0.0 MB after 65 MB of photos were inserted and 69.5 MB after ANALYZE TABLE.
  const injected = typeof opts.sizeBytes === 'number';
  let dataBytes = 0;
  let indexBytes = 0;
  let photoBytes = 0;
  if (!injected) {
    const tables = await rows("SELECT TABLE_NAME AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE' AND TABLE_NAME <> 'design_photos' ORDER BY TABLE_NAME");
    if (opts.analyze !== false) for (const t of tables) await conn.query(`ANALYZE TABLE \`${String(t.n).replace(/`/g, '``')}\``);
    const sizeRows = await rows("SELECT COALESCE(SUM(DATA_LENGTH), 0) AS d, COALESCE(SUM(INDEX_LENGTH), 0) AS i FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE' AND TABLE_NAME <> 'design_photos'");
    dataBytes = Number(sizeRows[0].d);
    indexBytes = Number(sizeRows[0].i);
    const photoRow = (await rows('SELECT COALESCE(SUM(byte_size), 0) AS b FROM design_photos WHERE removed_at IS NULL'))[0];
    photoBytes = Number(photoRow.b);
  }

  // B3, O53: the days since the owner's last Download everything, counted from settings.last_download.at, or with none from the oldest check_runs row (the first night).
  const today = kolkataDate(now) as string;
  const dlRows = await rows("SELECT value FROM settings WHERE setting_key = 'last_download'");
  const lastDownloadAt = parseJson(dlRows[0]?.value)?.at;
  let download: Health['download'] = { state: 'unknown', from: null, reference_date: null, age_days: null };
  const fromDownload = lastDownloadAt ? kolkataDate(lastDownloadAt) : null;
  if (fromDownload) download = { ...download, from: 'last_download', reference_date: fromDownload };
  else {
    const firstNight = (await rows(`SELECT DATE_FORMAT(MIN(ran_at), '${FMT}') AS at FROM check_runs`))[0].at as string | null;
    if (firstNight) download = { ...download, from: 'first_night', reference_date: kolkataDate(firstNight) };
  }
  if (download.reference_date) {
    download.age_days = wholeDays(today, download.reference_date);
    download.state = download.age_days > DOWNLOAD_RED_DAYS ? 'red' : download.age_days >= DOWNLOAD_AMBER_DAYS ? 'amber' : 'ok';
  }

  // O54: the days since Harsh's weekly pull, from settings.last_pulled.at, or with none from the first good export.
  const pullRows = await rows("SELECT value FROM settings WHERE setting_key = 'last_pulled'");
  const lastPulledAt = parseJson(pullRows[0]?.value)?.at;
  let pull: Health['pull'] = { state: 'unknown', from: null, reference_date: null, age_days: null };
  const fromPull = lastPulledAt ? kolkataDate(lastPulledAt) : null;
  if (fromPull) pull = { ...pull, from: 'last_pulled', reference_date: fromPull };
  else {
    const firstExport = (await rows(`SELECT DATE_FORMAT(MIN(ran_at), '${FMT}') AS at FROM backup_runs WHERE kind = 'db_dump' AND ok = 1`))[0].at as string | null;
    if (firstExport) pull = { ...pull, from: 'first_export', reference_date: kolkataDate(firstExport) };
  }
  if (pull.reference_date) {
    pull.age_days = wholeDays(today, pull.reference_date);
    pull.state = pull.age_days > PULL_AMBER_DAYS ? 'amber' : 'ok';
  }

  // B2: the backup folder as the good runs recorded it (backup_runs.detail.folder = {files, bytes, free_bytes}; detail.pruned = how many files that run removed on purpose).
  // The file count FALLING by more than was pruned, between two consecutive recorded runs, is red; the flag stays for FOLDER_FALL_WINDOW_DAYS so a night's fall is still visible the day after.
  const folderRows = await rows(
    `SELECT DATE_FORMAT(ran_at, '${FMT}') AS at, detail FROM backup_runs WHERE ok = 1 AND kind IN ('db_dump', 'photo_copy') AND ran_at <= ? AND JSON_VALUE(detail, '$.folder.files') IS NOT NULL ORDER BY ran_at DESC, id DESC LIMIT 60`,
    [horizon],
  );
  const seen = folderRows.reverse().map((r) => ({ at: r.at as string, detail: parseJson(r.detail) }));
  let folder: Health['folder'] = null;
  if (seen.length > 0) {
    const last = seen[seen.length - 1];
    const f = last.detail.folder;
    let fell = false;
    let fellAt: string | null = null;
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

  // RV3a-F3: the folder signal of API34 (scripts/dump-job.mjs recordFolderProbe, twin src/jobs/backupProbe.ts). A probe that fails is a backup_runs row of kind db_dump, ok 0, detail
  // {phase: 'folder_probe', folder_probe: {ok: false, code, where}}; a probe that passes after a failure writes the heal row {ok: true}. The NEWEST such row (by id, the order it was written in, as the
  // writer reads it) is the state of the folder; a failure is red until a good db_dump or photo_copy row is NEWER than it, which proves the folder was written to afterwards. JSON_VALUE gives a JSON
  // false as the text '0' on MariaDB 11.8 (another version may say 'false'), and the writer reads anything else as ok, so the reader does too.
  const probeRows = await rows(
    `SELECT DATE_FORMAT(ran_at, '${FMT}') AS at, JSON_VALUE(detail, '$.folder_probe.ok') AS ok, JSON_VALUE(detail, '$.folder_probe.code') AS code, JSON_VALUE(detail, '$.folder_probe.where') AS wh FROM backup_runs WHERE kind = 'db_dump' AND JSON_CONTAINS_PATH(detail, 'one', '$.folder_probe') ORDER BY id DESC LIMIT 1`,
  );
  let folder_probe: Health['folder_probe'] = null;
  if (probeRows.length > 0) {
    const p = probeRows[0];
    const failed = p.ok === '0' || p.ok === 'false';
    folder_probe = failed ? { ok: false, code: (p.code as string | null) ?? null, where: (p.wh as string | null) ?? null, at: p.at as string } : { ok: true, code: null, where: null, at: p.at as string };
  }
  let folderUnusable = false;
  if (folder_probe && folder_probe.ok === false) {
    const healed = await rows("SELECT 1 AS n FROM backup_runs WHERE ok = 1 AND kind IN ('db_dump', 'photo_copy') AND ran_at > ? AND ran_at <= ? LIMIT 1", [folder_probe.at, horizon]);
    folderUnusable = healed.length === 0;
  }

  // RV3a-F1: the nightly check of the photo copies (src/jobs/photoVerify.ts) writes backup_runs.detail.verify = { repaired, damaged_total, ... } on every photo_copy row it ends, good or failed. The
  // repairs of the last FOLDER_FALL_WINDOW_DAYS days are amber (a copy that vanished from the folder was written again); the NEWEST row that has a `verify` says whether a damaged copy is still
  // waiting for somebody (never overwritten, B2): red until a newer row has none, and the phase cannot end ok while a copy is damaged.
  const verifyRows = await rows(
    `SELECT DATE_FORMAT(ran_at, '${FMT}') AS at, JSON_VALUE(detail, '$.verify.repaired') AS repaired, JSON_VALUE(detail, '$.verify.damaged_total') AS damaged FROM backup_runs WHERE kind = 'photo_copy' AND ran_at <= ? AND JSON_CONTAINS_PATH(detail, 'one', '$.verify') ORDER BY ran_at DESC, id DESC LIMIT 60`,
    [horizon],
  );
  const photo_files: Health['photo_files'] = { repaired: 0, repaired_at: null, damaged: 0, damaged_at: null };
  const repairsFrom = utcMs(now) - FOLDER_FALL_WINDOW_DAYS * 86_400_000;
  verifyRows.forEach((r, i) => {
    if (i === 0 && Number(r.damaged) > 0) {
      photo_files.damaged = Number(r.damaged);
      photo_files.damaged_at = r.at as string;
    }
    if (Number(r.repaired) > 0 && utcMs(r.at as string) >= repairsFrom) {
      photo_files.repaired += Number(r.repaired);
      photo_files.repaired_at ??= r.at as string;
    }
  });
  const dbName = (await rows('SELECT DATABASE() AS name'))[0].name as string;

  const check = { last_at: (chk?.at as string | undefined) ?? null, age_hours: chk?.at ? hoursBetween(now, chk.at as string) : null, ok: chk?.at ? Number(chk.ok) === 1 : null };
  const db_dump = { last_at: dumpAt, age_hours: dumpAt ? hoursBetween(now, dumpAt) : null };
  const photo_copy = { last_at: photoAt, age_hours: photoAt ? hoursBetween(now, photoAt) : null };
  const db_size = injected
    ? { bytes: opts.sizeBytes as number, data_bytes: opts.sizeBytes as number, index_bytes: 0, photo_bytes: 0, overhead_percent: 12, red_line_bytes: DB_RED_LINE_BYTES, injected: true }
    : { bytes: Math.round((dataBytes + indexBytes + photoBytes) * 1.12), data_bytes: dataBytes, index_bytes: indexBytes, photo_bytes: photoBytes, overhead_percent: 12, red_line_bytes: DB_RED_LINE_BYTES, injected: false };
  const rights = await readRights(conn, dbName);

  const reasons: string[] = [];
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

// ------------------------------------------------------------------ the wire

const stamp = (text: string | null): string | null => (text === null ? null : timestampToWire(text));

/** The line as the wire carries it (S3): every instant ('YYYY-MM-DD HH:MM:SS.ffffff' in UTC) as '...T...Z' with six decimals; dates, numbers and reasons as they are. */
export function wireHealth(h: Health): Health {
  return {
    ...h,
    check: { ...h.check, last_at: stamp(h.check.last_at) },
    db_dump: { ...h.db_dump, last_at: stamp(h.db_dump.last_at) },
    photo_copy: { ...h.photo_copy, last_at: stamp(h.photo_copy.last_at) },
    folder: h.folder === null ? null : { ...h.folder, recorded_at: timestampToWire(h.folder.recorded_at), fell_at: stamp(h.folder.fell_at) },
    clock_ahead: h.clock_ahead === null ? null : { ...h.clock_ahead, last_at: timestampToWire(h.clock_ahead.last_at) },
    folder_probe: h.folder_probe === null ? null : { ...h.folder_probe, at: timestampToWire(h.folder_probe.at) },
    photo_files: { ...h.photo_files, repaired_at: stamp(h.photo_files.repaired_at), damaged_at: stamp(h.photo_files.damaged_at) },
    now: timestampToWire(h.now),
  };
}

// ------------------------------------------------------------------ GET /v1/health/checks

/** The newest runs of the nightly check and of the backup jobs (A4: check_runs and backup_runs are read by the owner alone). Parameter: the limit. Exported for the EXPLAIN test (A7). */
export const checkRunsStatement = (columns: readonly string[]): string => `SELECT ${selectList('c', columns)} FROM check_runs c ORDER BY c.ran_at DESC, c.id DESC LIMIT ?`;
export const backupRunsStatement = (columns: readonly string[]): string => `SELECT ${selectList('b', columns)} FROM backup_runs b ORDER BY b.ran_at DESC, b.id DESC LIMIT ?`;

const limitMessage = `must be a whole number from 1 to ${limits.ownerPageRows}`;
/** Strict: a key that is not here is 422. */
export const checksQuery = wire.strictObject({ limit: z.string({ error: limitMessage }).regex(/^[1-9][0-9]{0,3}$/, limitMessage).optional() });
/** Rows of each list when `limit` is not given. */
export const DEFAULT_CHECK_ROWS = 30;

export interface HealthLists {
  check_runs: Record<string, unknown>[];
  backup_runs: Record<string, unknown>[];
}

function listRow(raw: Record<string, unknown>, json: string): Record<string, unknown> {
  const out = formatRow(raw, { ran_at: 'timestamp' });
  out.id = Number(raw.id);
  out.ok = Number(raw.ok) === 1;
  if (raw.bytes !== undefined) out.bytes = Number(raw.bytes);
  out[json] = parseJson(raw[json]);
  return out;
}

export async function readHealthLists(db: Reader, role: string, q: z.output<typeof checksQuery>): Promise<HealthLists> {
  const asked = q.limit === undefined ? DEFAULT_CHECK_ROWS : Number(q.limit);
  if (asked > limits.ownerPageRows) throw new wire.InvalidInputError('limit', limitMessage); // the cap is the contract: asking for more is refused, not cut
  const checks = await db.rows<Record<string, unknown>>(checkRunsStatement(readColumns('check_runs', role)), [asked]);
  const backups = await db.rows<Record<string, unknown>>(backupRunsStatement(readColumns('backup_runs', role)), [asked]);
  return { check_runs: checks.map((r) => listRow(r, 'details')), backup_runs: backups.map((r) => listRow(r, 'detail')) };
}
