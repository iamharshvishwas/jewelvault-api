// Spec 5.2.2 (B2, I12, S11): the backup folder named by JV_BACKUP_DIR must exist and be writable, and the start-up check says so. This file is the TypeScript twin of probeBackupDir, probeBackupSetting and
// resolveBackupDir in scripts/backup-folder.mjs and of recordFolderProbe in scripts/dump-job.mjs (the build compiles src/ alone and cannot import scripts/*.mjs; tests/api/dump-job-parts.test.ts
// keeps the pairs equal: the same answers on the same folders, the same rows for the same sequence of probes). A change to one is a change to the other.
//
// The shop works without its backup folder, so a folder that is missing or not writable does NOT make the start-up check fail (the API does not answer 503 for it). It is written down for the owner's
// dashboard line instead: a backup_runs row of kind `db_dump`, ok = 0, detail = { phase: 'folder_probe', folder_probe: { ok, code, where } }, and a sys_error_log row (code JV_BACKUP_FOLDER) through
// logError; the hourly dump script (`scripts/job.js dump`) writes the same rows. A passing probe after a failure writes the heal row (folder_probe.ok = true). The folder itself is never made here.
import { constants } from 'node:fs';
import { access, open, stat, unlink } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import type { RowDataPacket } from 'mysql2/promise';
import { logError } from '../db/errorLog.js';
import type { DbConnection, DbPool } from '../db/pool.js';
import { SUBFOLDERS, resolveBackupDir } from './backupFolder.js';

/** The same failed probe is written again after this long: one row a day, not one an hour. */
export const FOLDER_PROBE_REPEAT_MS = 24 * 60 * 60 * 1000;

export interface FolderProbeFailure {
  ok: false;
  /** ENOENT (missing), ENOTDIR, EACCES (read-only), EROFS, ENOSPC ... or CONFIG (the setting itself). */
  code: string;
  /** `folder`, a sub-folder name, or `JV_BACKUP_DIR` for CONFIG. No path is in it. */
  where: string;
  message: string;
}
export type FolderProbe = { ok: true } | FolderProbeFailure;

/** JV_BACKUP_DIR: the same rules as the photo copy's twin (src/jobs/backupFolder.ts), which the script's resolveBackupDir is kept equal to. */
export { resolveBackupDir };

const failure = (code: unknown, where: string, message: string): FolderProbeFailure => ({ ok: false, code: String(code ?? 'UNKNOWN'), where, message });
const codeOf = (e: unknown) => (e as { code?: string } | null)?.code;
const textOf = (e: unknown) => codeOf(e) ?? (e as Error | null)?.message;

async function writeProbe(folder: string): Promise<void> {
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

/** The folder exists, is a folder and is writable (a file is created and removed in it and in each of daily/, monthly/, photos/ that exists). Never makes the folder. */
export async function probeBackupDir(dir: string): Promise<FolderProbe> {
  try {
    if (!(await stat(dir)).isDirectory()) return failure('ENOTDIR', 'folder', 'the backup folder is not a folder');
  } catch (e) {
    return failure(codeOf(e), 'folder', `the backup folder cannot be looked at (${textOf(e)})`);
  }
  for (const where of ['folder', ...SUBFOLDERS]) {
    const target = where === 'folder' ? dir : path.join(dir, where);
    try {
      if (where !== 'folder') {
        const st = await stat(target).catch((e: unknown) => (codeOf(e) === 'ENOENT' ? null : Promise.reject(e)));
        if (!st) continue;
        if (!st.isDirectory()) return failure('ENOTDIR', where, `${where}/ is not a folder`);
      }
      await access(target, constants.R_OK | constants.W_OK | constants.X_OK);
      await writeProbe(target);
    } catch (e) {
      return failure(codeOf(e), where, `the backup folder cannot be written (${textOf(e)})`);
    }
  }
  return { ok: true };
}

/** resolveBackupDir, then probeBackupDir. A value that is no usable path is { ok: false, code: 'CONFIG', where: 'JV_BACKUP_DIR' }. On success the answer carries the resolved folder. */
export async function probeBackupSetting(value: string | undefined): Promise<FolderProbe & { dir?: string }> {
  let dir: string;
  try {
    dir = resolveBackupDir(value);
  } catch (e) {
    return failure('CONFIG', 'JV_BACKUP_DIR', (e as Error).message);
  }
  const probe = await probeBackupDir(dir);
  return probe.ok ? { ok: true, dir } : probe;
}

/** The instant as DATETIME(6) text in UTC, as the API's clock writes it. */
const stamp = (ms: number) => `${new Date(ms).toISOString().slice(0, 23).replace('T', ' ')}000`;
const utcMs = (text: string) => Date.parse(`${String(text).replace(' ', 'T')}Z`);
/** JSON_VALUE of a JSON false: MariaDB gives the text '0' (and '1' for true), another version may give 'false'. */
const isFalse = (v: unknown) => v === '0' || v === 'false' || v === 0 || v === false;

type Queryable = Pick<DbConnection, 'query'>;

async function insertRun(conn: Queryable, nowMs: number, folderProbe: Record<string, unknown>): Promise<void> {
  await conn.query('INSERT INTO backup_runs (ran_at, kind, ok, bytes, detail) VALUES (?, ?, ?, ?, ?)', [stamp(nowMs), 'db_dump', 0, 0, JSON.stringify({ phase: 'folder_probe', folder_probe: folderProbe })]);
}

/**
 * Writes down what the probe found. A failure is written when the newest folder_probe row is not the same failure of the last 24 hours (a row in backup_runs and a row in sys_error_log); a probe
 * that passes while the newest folder_probe row is a failure writes the heal row. Returns { written, healed }.
 */
export async function recordFolderProbe(conn: Queryable, probe: FolderProbe, opts: { nowMs: number }): Promise<{ written: boolean; healed: boolean }> {
  const [rows] = await conn.query<RowDataPacket[]>(
    "SELECT DATE_FORMAT(ran_at, '%Y-%m-%d %H:%i:%s.%f') AS at, JSON_VALUE(detail, '$.folder_probe.ok') AS ok, JSON_VALUE(detail, '$.folder_probe.code') AS code, JSON_VALUE(detail, '$.folder_probe.where') AS wh FROM backup_runs WHERE kind = 'db_dump' AND JSON_CONTAINS_PATH(detail, 'one', '$.folder_probe') ORDER BY id DESC LIMIT 1"
  );
  const last = rows[0];
  if (probe.ok) {
    if (!last || !isFalse(last.ok)) return { written: false, healed: false };
    await insertRun(conn, opts.nowMs, { ok: true });
    return { written: false, healed: true };
  }
  const same = last && isFalse(last.ok) && last.code === probe.code && last.wh === probe.where && opts.nowMs - utcMs(String(last.at)) < FOLDER_PROBE_REPEAT_MS;
  if (same) return { written: false, healed: false };
  await insertRun(conn, opts.nowMs, { ok: false, code: probe.code, where: probe.where });
  await logError(
    conn,
    { level: 'error', code: 'JV_BACKUP_FOLDER', message: `The backup folder cannot be used: ${probe.message}. Nothing can be backed up until it is fixed.`, detail: { code: probe.code, where: probe.where } },
    { now: new Date(opts.nowMs) }
  );
  return { written: true, healed: false };
}

interface Warner {
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

/**
 * The start-up half of the folder rule (S11): probe JV_BACKUP_DIR and write down the result. Never throws and never stops the start: whatever goes wrong is said in the log. Returns the probe.
 */
export async function checkBackupFolderAtStart(db: Pick<DbPool, 'checkout'>, value: string, nowMs: number, log: Warner): Promise<FolderProbe> {
  const probe = await probeBackupSetting(value);
  if (!probe.ok) log.error({ code: probe.code, where: probe.where }, 'the backup folder cannot be used: the dashboard line is red until it is fixed');
  let conn: DbConnection | null = null;
  try {
    conn = await db.checkout();
    await recordFolderProbe(conn, probe, { nowMs });
  } catch (e) {
    log.warn({ cause: (e as { code?: string } | null)?.code ?? (e as Error | null)?.name }, 'the result of the backup folder check could not be recorded');
  } finally {
    conn?.release();
  }
  return probe;
}
