// B2 (draft 5.2): the backup folder on the Hostinger plan. One folder named by JV_BACKUP_DIR (an absolute path, the same for the app and for cron), three sub-folders:
//
//   daily/<yyyy-mm-dd>.enc      one export a night (a retried night may add daily/<yyyy-mm-dd>-<run id>.enc)
//   monthly/<yyyy-mm>.enc       the first export of a month, also linked here
//   photos/<photo id>-<kind>    each photo object once (backup.mjs directoryPhotos); the app never prunes it
//
// There is no lock to lean on (a compromised app, hPanel, SSH or a "files restore" can all delete files), so the rules are in the code:
//  - every file is written as <name>.partial, flushed to disk (fsync), then link()ed into place: a final name always holds a complete file and is never overwritten;
//  - the export's bytes differ at every run (a fresh key), so its sha256 and size are RECORDED (backup_runs.detail) before the link; on a retry a final file whose sha256 equals the
//    record means the phase is done; anything else leaves the existing file alone, raises an alert and writes daily/<date>-<run id>.enc;
//  - at the start of a job `.partial` files older than an hour are removed;
//  - pruning touches only exact name patterns, always keeps the newest 30 daily and 13 monthly files whatever their age, runs only after a good write of the same night, never when the
//    folder holds fewer files than the last recorded count, and the first real prune is preceded by a logged dry run; photos/ is never pruned.
// The dashboard turns red when the file count falls without a prune (health.mjs reads backup_runs.detail.folder and detail.pruned that recordBackupRun writes).
//  - the folder must be THERE and writable on every run (spec 5.2.2): probeBackupDir tests it by writing a file; a missing folder is never made for the job (a stale absolute path would grow a new
//    tree under domains/) and never read as "nothing due". The default place is /home/<user>/jv-backup, outside domains/: connecting a domain renames the site's folder in domains/.

import { access, link, lstat, mkdir, open, readdir, stat, statfs, unlink } from 'node:fs/promises';
import { constants, createReadStream } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { createExportWriter } from './export-file.mjs';

export const KEEP_DAILY = 30;
export const KEEP_MONTHLY = 13;
export const PARTIAL_MAX_AGE_MS = 60 * 60 * 1000;
export const SUBFOLDERS = ['daily', 'monthly', 'photos'];

const RUN_ID = '[0-9A-Za-z][0-9A-Za-z-]{0,39}';
const DAILY_RE = new RegExp(`^(\\d{4}-\\d{2}-\\d{2})(?:-(${RUN_ID}))?\\.enc$`);
const MONTHLY_RE = /^(\d{4}-\d{2})\.enc$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const RUN_ID_RE = new RegExp(`^${RUN_ID}$`);

/** The business date (Asia/Kolkata, UTC+05:30, no daylight saving) of an instant, as yyyy-mm-dd. */
export const businessDate = (ms = Date.now()) => new Date(ms + 19_800_000).toISOString().slice(0, 10);

const checkDate = (date) => {
  const parsed = DATE_RE.test(String(date)) ? new Date(`${date}T00:00:00Z`) : null;
  if (!parsed || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) throw new Error(`not a business date (yyyy-mm-dd): ${JSON.stringify(date)}`);
  return date;
};
const checkRunId = (runId) => {
  if (!RUN_ID_RE.test(String(runId))) throw new Error(`not a run id (letters, digits and hyphens): ${JSON.stringify(runId)}`);
  return String(runId);
};

export const dailyName = (date) => `daily/${checkDate(date)}.enc`;
export const dailyRunName = (date, runId) => `daily/${checkDate(date)}-${checkRunId(runId)}.enc`;
export const monthlyName = (date) => `monthly/${checkDate(date).slice(0, 7)}.enc`;

/**
 * JV_BACKUP_DIR: an absolute path. Never `~` and never os.homedir(): in the app homedir() is the domain folder, in a cron job HOME is /home/<user>, and the two jobs must name the same folder.
 * Returns the normalised path; throws a message the start-up check can show.
 */
export function resolveBackupDir(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) throw new Error('JV_BACKUP_DIR is not set');
  if (raw.includes('~')) throw new Error('JV_BACKUP_DIR must not contain "~" (the app and cron resolve it differently); use the full path');
  if (!path.isAbsolute(raw)) throw new Error('JV_BACKUP_DIR must be an absolute path');
  if (raw.split('/').includes('..')) throw new Error('JV_BACKUP_DIR must not contain ".."');
  const dir = path.normalize(raw).replace(/\/+$/, '');
  if (dir === '' || dir === '/') throw new Error('JV_BACKUP_DIR must not be the root folder');
  return dir;
}

const inside = (dir, rel) => {
  const full = path.join(dir, rel);
  const relative = path.relative(dir, full);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`path leaves the backup folder: ${rel}`);
  return full;
};

/** Creates daily/, monthly/ and photos/ when they are missing. */
export async function prepareFolder(dir) {
  for (const sub of SUBFOLDERS) await mkdir(path.join(dir, sub), { recursive: true });
}

async function syncDir(dirPath) {
  try {
    const h = await open(dirPath, 'r');
    try {
      await h.sync();
    } finally {
      await h.close();
    }
  } catch {
    // some file systems refuse to sync a directory; the file itself was synced
  }
}

/** At the start of every job: removes `*.partial` files older than an hour from daily/, monthly/ and photos/. Returns the names removed. */
export async function sweepPartials(dir, { nowMs = Date.now(), maxAgeMs = PARTIAL_MAX_AGE_MS } = {}) {
  const removed = [];
  for (const sub of SUBFOLDERS) {
    let names;
    try {
      names = await readdir(path.join(dir, sub));
    } catch (e) {
      if (e.code === 'ENOENT') continue;
      throw e;
    }
    for (const name of names) {
      if (!name.endsWith('.partial')) continue;
      const full = path.join(dir, sub, name);
      const st = await lstat(full).catch(() => null);
      if (!st || !st.isFile() || nowMs - st.mtimeMs <= maxAgeMs) continue;
      await unlink(full).catch((e) => {
        if (e.code !== 'ENOENT') throw e;
      });
      removed.push(`${sub}/${name}`);
    }
  }
  return removed;
}

/** The figures backup_runs.detail.folder holds: final files in the three sub-folders (not `.partial`), their total size, and the free disk (statfs). */
export async function folderStats(dir) {
  const counts = { daily: 0, monthly: 0, photos: 0 };
  let bytes = 0;
  for (const sub of SUBFOLDERS) {
    let entries;
    try {
      entries = await readdir(path.join(dir, sub), { withFileTypes: true });
    } catch (e) {
      if (e.code === 'ENOENT') continue;
      throw e;
    }
    for (const entry of entries) {
      if (!entry.isFile() || entry.name.endsWith('.partial')) continue;
      counts[sub] += 1;
      bytes += (await stat(path.join(dir, sub, entry.name))).size;
    }
  }
  let free = null;
  try {
    const fs = await statfs(dir);
    free = Number(fs.bavail) * Number(fs.bsize);
  } catch {
    free = null;
  }
  return { files: counts.daily + counts.monthly + counts.photos, bytes, free_bytes: free, daily: counts.daily, monthly: counts.monthly, photos: counts.photos };
}

/** The sha256 and size of a file, read as a stream. */
export async function fileDigest(file) {
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of createReadStream(file)) {
    hash.update(chunk);
    size += chunk.length;
  }
  return { sha256: hash.digest('hex'), size };
}

/**
 * The retry rule, step 1 (call before dumping again). `recorded` is what an earlier attempt of the same night put in backup_runs.detail before linking: { name, sha256, size }.
 * done is true only when that final file exists and its sha256 and size equal the record: the earlier attempt only lacked its `ok` row.
 */
export async function checkRecordedExport(dir, recorded) {
  if (!recorded || typeof recorded.name !== 'string') return { done: false, reason: 'no_record' };
  const m = DAILY_RE.exec(path.basename(recorded.name));
  if (!m || !recorded.name.startsWith('daily/')) return { done: false, reason: 'bad_record' };
  const full = inside(dir, recorded.name);
  const st = await stat(full).catch((e) => {
    if (e.code === 'ENOENT') return null;
    throw e;
  });
  if (!st) return { done: false, reason: 'missing' };
  if (st.size !== Number(recorded.size)) return { done: false, reason: 'differs' };
  const digest = await fileDigest(full);
  if (digest.sha256 !== String(recorded.sha256).toLowerCase()) return { done: false, reason: 'differs' };
  return { done: true, name: recorded.name, sha256: digest.sha256, size: digest.size };
}

async function linkOnce(from, to) {
  try {
    await link(from, to);
    return true;
  } catch (e) {
    if (e.code === 'EEXIST') return false;
    throw e;
  }
}

/** The first run of a month also puts the file in monthly/<yyyy-mm>.enc (a hard link: no second copy on disk). Returns true when it was created. */
export async function linkMonthly(dir, finalName, date) {
  const created = await linkOnce(inside(dir, finalName), inside(dir, monthlyName(date)));
  if (created) await syncDir(path.join(dir, 'monthly'));
  return created;
}

/**
 * Writes tonight's export into the folder.
 *   exportFn(sink)  runs the export into the sink (exportDatabase(conn, sink))
 *   record(info)    is called with { name, sha256, size, run_id } BEFORE the file is linked, so backup_runs.detail holds it if the process dies between the link and the `ok` row
 *   recorded        { name, sha256, size } from an earlier attempt of this night, or null
 * Returns { status: 'written' | 'already_done', name, sha256, size, conflict, alerts, monthly, manifest }.
 */
export async function writeDailyExport({ dir, date, runId, publicKey, exportFn, record, recorded = null, nowMs = Date.now() }) {
  checkDate(date);
  checkRunId(runId);
  await prepareFolder(dir);
  await sweepPartials(dir, { nowMs });
  const alerts = [];

  const earlier = await checkRecordedExport(dir, recorded);
  if (earlier.done) {
    const monthly = await linkMonthly(dir, earlier.name, date);
    return { status: 'already_done', name: earlier.name, sha256: earlier.sha256, size: earlier.size, conflict: false, alerts, monthly: monthly ? monthlyName(date) : null, manifest: null };
  }
  if (recorded && earlier.reason === 'differs') alerts.push({ code: 'export_record_mismatch', detail: { name: recorded.name } });

  const plain = dailyName(date);
  const plainTaken = await stat(inside(dir, plain)).then(() => true, (e) => (e.code === 'ENOENT' ? false : Promise.reject(e)));
  let name = plainTaken ? dailyRunName(date, runId) : plain;
  if (plainTaken) alerts.push({ code: 'export_name_taken', detail: { existing: plain, written_as: name } });

  // the partial always carries the run's own name, so two attempts never write the same path
  const partial = inside(dir, `${dailyRunName(date, runId)}.partial`);
  const writer = await createExportWriter(partial, publicKey);
  let manifest;
  let digest;
  try {
    manifest = await exportFn(writer.sink);
    digest = await writer.finish();
  } catch (e) {
    await writer.abort();
    throw e;
  }
  try {
    await record?.({ name, sha256: digest.sha256, size: digest.size, run_id: String(runId) });
    if (!(await linkOnce(partial, inside(dir, name)))) {
      // somebody created the plain name between the check and the link: this run's file goes under its own name, never over the other
      name = dailyRunName(date, runId);
      alerts.push({ code: 'export_name_taken', detail: { existing: plain, written_as: name } });
      await record?.({ name, sha256: digest.sha256, size: digest.size, run_id: String(runId) });
      if (!(await linkOnce(partial, inside(dir, name)))) throw new Error(`${name} already exists; nothing was overwritten`);
    }
    await syncDir(path.join(dir, 'daily'));
    const monthly = await linkMonthly(dir, name, date);
    return { status: 'written', name, sha256: digest.sha256, size: digest.size, conflict: alerts.some((a) => a.code === 'export_name_taken'), alerts, monthly: monthly ? monthlyName(date) : null, manifest };
  } finally {
    await unlink(partial).catch((e) => {
      if (e.code !== 'ENOENT') throw e;
    });
  }
}

// ---------------------------------------------------------------- pruning

async function listFinal(dir, sub, re) {
  let entries;
  try {
    entries = await readdir(path.join(dir, sub), { withFileTypes: true });
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
  const out = [];
  for (const entry of entries) {
    const m = re.exec(entry.name);
    if (!m || !entry.isFile()) continue; // a symbolic link, a folder or a name outside the pattern is never ours to touch
    const st = await lstat(path.join(dir, sub, entry.name));
    out.push({ name: `${sub}/${entry.name}`, key: m[1], mtimeMs: st.mtimeMs });
  }
  // newest first: by the date in the name, then by the file's time ("newest 30" counts files, not dates: a retried night can leave two for one date)
  return out.sort((a, b) => (a.key === b.key ? b.mtimeMs - a.mtimeMs || (a.name < b.name ? 1 : -1) : a.key < b.key ? 1 : -1));
}

/** What a prune would keep and remove. Nothing is touched. */
export async function planPrune(dir, { keepDaily = KEEP_DAILY, keepMonthly = KEEP_MONTHLY } = {}) {
  if (!Number.isInteger(keepDaily) || keepDaily < KEEP_DAILY || !Number.isInteger(keepMonthly) || keepMonthly < KEEP_MONTHLY) throw new Error(`the newest ${KEEP_DAILY} daily and ${KEEP_MONTHLY} monthly files are always kept`);
  const daily = await listFinal(dir, 'daily', DAILY_RE);
  const monthly = await listFinal(dir, 'monthly', MONTHLY_RE);
  return {
    keep: [...daily.slice(0, keepDaily), ...monthly.slice(0, keepMonthly)].map((f) => f.name),
    remove: [...daily.slice(keepDaily), ...monthly.slice(keepMonthly)].map((f) => f.name),
  };
}

/**
 * Prunes daily/ and monthly/ with the guard rails of B2.
 *   goodWriteTonight   true only after tonight's export was written and its `ok` row is in (otherwise nothing is deleted, however many nights failed)
 *   lastRecordedFiles  the folder's file count in the last good run's backup_runs.detail.folder; a folder with fewer files is refused (files have gone that this job did not remove)
 *   dryRunDone         true when an earlier night logged a dry run (readPruneState); the first real prune is always preceded by one
 * Returns { action: 'refused' | 'nothing' | 'dry_run' | 'pruned', reason?, candidates, removed }. For 'dry_run' the caller logs the candidates in backup_runs.detail.prune_dry_run.
 */
export async function prune(dir, { goodWriteTonight, lastRecordedFiles = null, dryRunDone = false, keepDaily, keepMonthly } = {}) {
  if (goodWriteTonight !== true) return { action: 'refused', reason: 'no_good_write_tonight', candidates: [], removed: [] };
  const stats = await folderStats(dir);
  if (lastRecordedFiles !== null && lastRecordedFiles !== undefined && stats.files < Number(lastRecordedFiles)) {
    return { action: 'refused', reason: 'fewer_files_than_recorded', candidates: [], removed: [], files: stats.files, recorded: Number(lastRecordedFiles) };
  }
  const plan = await planPrune(dir, { keepDaily, keepMonthly });
  if (plan.remove.length === 0) return { action: 'nothing', candidates: [], removed: [] };
  if (!dryRunDone) return { action: 'dry_run', candidates: plan.remove, removed: [] };
  const removed = [];
  for (const name of plan.remove) {
    const full = inside(dir, name);
    const st = await lstat(full).catch(() => null);
    if (!st || !st.isFile() || st.isSymbolicLink()) continue;
    await unlink(full);
    removed.push(name);
  }
  await syncDir(path.join(dir, 'daily'));
  await syncDir(path.join(dir, 'monthly'));
  return { action: 'pruned', candidates: plan.remove, removed };
}

// ---------------------------------------------------------------- the rows the dashboard reads

/** What the next prune needs from backup_runs: the folder's file count in the last good run, and whether a dry run was ever logged. Read it before tonight's row is written. */
export async function readPruneState(conn) {
  const [rows] = await conn.query(
    "SELECT JSON_VALUE(detail, '$.folder.files') AS files FROM backup_runs WHERE ok = 1 AND kind IN ('db_dump', 'photo_copy') AND JSON_VALUE(detail, '$.folder.files') IS NOT NULL ORDER BY ran_at DESC, id DESC LIMIT 1"
  );
  const [dry] = await conn.query("SELECT 1 AS x FROM backup_runs WHERE JSON_CONTAINS_PATH(detail, 'one', '$.prune_dry_run') LIMIT 1");
  return { lastRecordedFiles: rows.length ? Number(rows[0].files) : null, dryRunDone: dry.length > 0 };
}

/**
 * The retry rule's input: what the latest attempt of this business date recorded (detail.export = { name, sha256, size }) before it linked its file, or null. Pass it to
 * writeDailyExport as `recorded`.
 */
export async function readRecordedExport(conn, date) {
  checkDate(date);
  const [rows] = await conn.query(
    "SELECT JSON_VALUE(detail, '$.export.name') AS name, JSON_VALUE(detail, '$.export.sha256') AS sha256, JSON_VALUE(detail, '$.export.size') AS size FROM backup_runs WHERE kind = 'db_dump' AND JSON_VALUE(detail, '$.export.name') LIKE ? ORDER BY id DESC LIMIT 1",
    [`daily/${date}%`]
  );
  return rows.length ? { name: rows[0].name, sha256: rows[0].sha256, size: Number(rows[0].size) } : null;
}

/**
 * Writes one backup_runs row. `ok` is for a complete phase only (D17). detail.folder = { files, bytes, free_bytes } (folderStats) is what the dashboard compares from night to night;
 * detail.pruned is how many files this run removed on purpose, so that the drop is not read as a loss. Other keys (counts, the recorded export, prune_dry_run) are kept as given.
 */
export async function recordBackupRun(conn, { kind, ok, bytes = 0, detail = {}, ranAt = null }) {
  if (!['db_dump', 'photo_copy', 'restore_drill'].includes(kind)) throw new Error(`unknown backup kind: ${kind}`);
  if (detail.folder) {
    for (const k of ['files', 'bytes']) if (!Number.isFinite(Number(detail.folder[k]))) throw new Error(`detail.folder.${k} must be a number`);
  }
  if (detail.pruned !== undefined && !(Number.isInteger(detail.pruned) && detail.pruned >= 0)) throw new Error('detail.pruned must be a whole number');
  const [res] = ranAt
    ? await conn.query('INSERT INTO backup_runs (ran_at, kind, ok, bytes, detail) VALUES (?, ?, ?, ?, ?)', [ranAt, kind, ok ? 1 : 0, bytes, JSON.stringify(detail)])
    : await conn.query('INSERT INTO backup_runs (kind, ok, bytes, detail) VALUES (?, ?, ?, ?)', [kind, ok ? 1 : 0, bytes, JSON.stringify(detail)]);
  return { id: Number(res.insertId) };
}


// ---------------------------------------------------------------- the folder must be there (spec 5.2.2, B2, I12)

const failure = (code, where, message) => ({ ok: false, code: String(code ?? 'UNKNOWN'), where, message });

/** Writes a one-byte file in `folder` and removes it. The name ends in .partial, so a crash in between leaves what the sweep removes. */
async function writeProbe(folder) {
  const file = path.join(folder, `.probe-${randomBytes(6).toString('hex')}.partial`);
  const handle = await open(file, 'wx');
  try {
    await handle.write('x');
    await handle.sync();
  } finally {
    await handle.close();
    await unlink(file).catch(() => undefined);
  }
}

/**
 * Spec 5.2.2 (B2, I12): the folder named by JV_BACKUP_DIR exists, is a folder and is writable. A mode is not enough (a read-only mount, a quota, an ACL), so a file is really created, flushed and
 * removed in the folder and in each of daily/, monthly/ and photos/ that exists; a sub-folder that is missing is made by prepareFolder when the first file is written. The folder itself is NEVER made
 * here. Answers { ok: true } or { ok: false, code, where, message } with the system's code (ENOENT, EACCES, ENOTDIR, EROFS, ENOSPC, EDQUOT ...) and where it failed (`folder` or a sub-folder name); the
 * path is not in the answer.
 */
export async function probeBackupDir(dir) {
  try {
    if (!(await stat(dir)).isDirectory()) return failure('ENOTDIR', 'folder', 'the backup folder is not a folder');
  } catch (e) {
    return failure(e.code, 'folder', `the backup folder cannot be looked at (${e.code ?? e.message})`);
  }
  for (const where of ['folder', ...SUBFOLDERS]) {
    const target = where === 'folder' ? dir : path.join(dir, where);
    try {
      if (where !== 'folder') {
        const st = await stat(target).catch((e) => (e.code === 'ENOENT' ? null : Promise.reject(e)));
        if (!st) continue;
        if (!st.isDirectory()) return failure('ENOTDIR', where, `${where}/ is not a folder`);
      }
      await access(target, constants.R_OK | constants.W_OK | constants.X_OK);
      await writeProbe(target);
    } catch (e) {
      return failure(e.code, where, `the backup folder cannot be written (${e.code ?? e.message})`);
    }
  }
  return { ok: true };
}

/** resolveBackupDir, then probeBackupDir. A value that is no usable path (unset, relative, "~", "..", the root) is { ok: false, code: 'CONFIG', where: 'JV_BACKUP_DIR' }. */
export async function probeBackupSetting(value) {
  let dir;
  try {
    dir = resolveBackupDir(value);
  } catch (e) {
    return failure('CONFIG', 'JV_BACKUP_DIR', e.message);
  }
  const probe = await probeBackupDir(dir);
  return probe.ok ? { ok: true, dir } : probe;
}
