// I8 (B), B2, D17, D25: the nightly dump job, the library behind `scripts/job.js dump` (the Custom cron job that hPanel runs every hour).
//
// One run of the job, in this order:
//   1. ONE connection of its own (a pool of one), opened through the pacer (S11: Hostinger refuses a burst of new connections), with the S11 session settings, wait_timeout 300 and the 20 s
//      statement limit of I8 for the tick and the dump;
//   2. the folder: JV_BACKUP_DIR exists and is writable (spec 5.2.2). EVERY run tests it, also one that would end as "not due" or "already done": a missing folder is never read as "nothing due".
//      A failed probe is a row in backup_runs (ok = 0, detail.folder_probe) and a row in sys_error_log (JV_BACKUP_FOLDER); a probe that passes after a failure writes the heal row;
//   3. what is due: not before 02:00 in Asia/Kolkata, and not when today's `db_dump` is `ok` in sys_job_runs;
//   4. the lock jv_dump:<database> (withJobLock of housekeeping.mjs: GET_LOCK with timeout 0, released in a finally), the day's row in sys_job_runs (a failed one goes back to running, a running one
//      older than 30 minutes is abandoned and taken over);
//   5. the export, as ONE snapshot and never sliced: writeDailyExport of backup-folder.mjs does the retry rule, the run-specific name, `.partial` / fsync / link(), the monthly link and the sweep;
//      this file records what it must record BEFORE the link (detail.export) through its `record` callback;
//   6. the `ok` row of backup_runs: counts, detail.export = { name, sha256, size }, detail.folder = { files, bytes, free_bytes } (the budget less the folder, not statfs); the day's row is ok;
//   7. pruning (prune of backup-folder.mjs: only after this good write, never with fewer files than the last recorded count, the first real one after a logged dry run) and its outcome in the row.
// A failure is written down (a backup_runs row with ok = 0, the day's row `failed`, an error-log row) and the next hourly run tries again. The photo copy is not here: it works in the slices of the tick.
import { randomBytes } from 'node:crypto';
import mysql from 'mysql2/promise';
import { exportDatabase } from './backup.mjs';
import { businessDate, folderStats, probeBackupSetting, prune, readPruneState, readRecordedExport, recordBackupRun, writeDailyExport } from './backup-folder.mjs';
import { loadPublicKey } from './export-file.mjs';
import { logError, withJobLock } from './housekeeping.mjs';
import { createPacer, pacedConnect } from './pacing.mjs';

export const DUMP_JOB = 'db_dump';
/** I8: a `running` row of the dump older than this is abandoned (the tick's phases: 10 minutes, src/jobs/schedule.ts JOB_LIMITS). */
export const DUMP_ABANDONED_AFTER_MS = 30 * 60 * 1000;
/** I8: the nightly work is due from this hour on, Asia/Kolkata. */
export const NIGHTLY_FROM_HOUR = 2;
/** B2: the plan's disk is 50 GB [H]. `statfs` shows the whole server's volume (9.9 TB free on the proof), so the folder is judged against this stated budget instead. */
export const BACKUP_FOLDER_BUDGET_BYTES = 50 * 1024 ** 3;
/** The same failed probe is written again after this long: one row a day, not one an hour (spec 5.2.2 asks that it be seen, not that it be repeated). */
export const FOLDER_PROBE_REPEAT_MS = 24 * 60 * 60 * 1000;

/** S11, with I8's limit of 20 seconds a statement for the tick and the dump (the pool's own is 8). src/db/pool.ts SESSION_SETTINGS is the other copy; a test keeps them equal. */
export const DUMP_SESSION = Object.freeze({
  isolation: 'READ-COMMITTED',
  sqlMode: 'STRICT_ALL_TABLES,ERROR_FOR_DIVISION_BY_ZERO',
  timeZone: '+00:00',
  lockWaitTimeout: 5,
  maxStatementTime: 20,
  waitTimeout: 300,
  charset: 'utf8mb4',
  collation: 'utf8mb4_unicode_ci',
});
// Constants only, no user input.
const SESSION_SQL = `SET SESSION transaction_isolation = '${DUMP_SESSION.isolation}', sql_mode = '${DUMP_SESSION.sqlMode}', time_zone = '${DUMP_SESSION.timeZone}', innodb_lock_wait_timeout = ${DUMP_SESSION.lockWaitTimeout}, max_statement_time = ${DUMP_SESSION.maxStatementTime}, wait_timeout = ${DUMP_SESSION.waitTimeout}, character_set_client = '${DUMP_SESSION.charset}', character_set_connection = '${DUMP_SESSION.charset}', character_set_results = '${DUMP_SESSION.charset}', collation_connection = '${DUMP_SESSION.collation}'`;
const REFUSED_RETRY_MS = 1100;

const BUSINESS_OFFSET_MS = 19_800_000; // +05:30, India has no daylight saving
const DAY_MS = 86_400_000;
/** Whether the instant is 02:00:00 in Asia/Kolkata or later on its business date (the nightly work is due). The TypeScript copy is afterNightlyGate in src/jobs/schedule.ts. */
export const afterNightlyGate = (ms) => (((ms + BUSINESS_OFFSET_MS) % DAY_MS) + DAY_MS) % DAY_MS >= NIGHTLY_FROM_HOUR * 3_600_000;

/** The instant as DATETIME(6) text in UTC, as the tick writes the API's clock. */
const stamp = (ms) => `${new Date(ms).toISOString().slice(0, 23).replace('T', ' ')}000`;
const utcMs = (text) => Date.parse(`${String(text).replace(' ', 'T')}Z`);
/** JSON_VALUE of a JSON false: MariaDB gives the text '0' (and '1' for true), another version may give 'false'. */
const isFalse = (v) => v === '0' || v === 'false' || v === 0 || v === false;

/** A setting that is missing: the command is wrong and nothing was opened. Names variables, never values. */
export class DumpUsageError extends Error {
  exitCode = 2;
  constructor(message) {
    super(message);
    this.name = 'DumpUsageError';
  }
}

const consoleLog = { info: (m) => console.log(m), warn: (m) => console.warn(m), error: (m) => console.error(m) };

function connectionSettings(env) {
  const missing = ['DB_HOST', 'DB_NAME', 'DB_USER', 'DB_PASSWORD'].filter((k) => !env[k]);
  if (missing.length) throw new DumpUsageError(`missing settings in the environment: ${missing.join(', ')} (the connection is never taken from the command line)`);
  const port = env.DB_PORT === undefined || env.DB_PORT === '' ? 3306 : Number(env.DB_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new DumpUsageError('DB_PORT is not a port number');
  return {
    host: env.DB_HOST,
    port,
    user: env.DB_USER,
    password: env.DB_PASSWORD,
    database: env.DB_NAME,
    charset: 'utf8mb4',
    connectTimeout: 15000,
    decimalNumbers: false,
    supportBigNumbers: true,
    bigNumberStrings: true,
    dateStrings: true,
    multipleStatements: false,
  };
}

const describeError = (e) => ({ name: String(e?.name ?? 'Error'), code: e?.code ? String(e.code) : null, message: String(e?.message ?? e).slice(0, 300) });

// ---------------------------------------------------------------- the day's row in sys_job_runs (D25, I8)

const READ_RUN = "SELECT id, status, started_at < CAST(? AS DATETIME(6)) AS stale, DATE_FORMAT(started_at, '%Y-%m-%d %H:%i:%s.%f') AS started_text, detail FROM sys_job_runs WHERE job = ? AND run_date = ?";
const INSERT_RUN = "INSERT INTO sys_job_runs (job, run_date, status, started_at) VALUES (?, ?, 'running', ?)";
const TAKE_RUN = "UPDATE sys_job_runs SET status = 'running', started_at = ?, finished_at = NULL WHERE id = ? AND status = ? AND started_at = CAST(? AS DATETIME(6))";
const parseDetail = (detail) => (typeof detail === 'string' ? JSON.parse(detail) : detail);

/**
 * The dump's row for a business date (unique on job and run_date, so a retry is an UPDATE): none = inserted as `running`; `failed` goes back to `running`; a `running` row older than 30 minutes is
 * abandoned and taken over; `ok` ends the date; any other `running` row is somebody else's. A takeover is a conditional UPDATE on the status AND the start time that were read, so two callers
 * cannot both win. The same rules as claimRun of src/jobs/runs.ts for a phase that is never sliced.
 */
export async function claimDumpRun(conn, { runDate, nowMs }) {
  const abandonedBefore = stamp(nowMs - DUMP_ABANDONED_AFTER_MS);
  const [[row]] = await conn.query(READ_RUN, [abandonedBefore, DUMP_JOB, runDate]);
  if (!row) {
    try {
      const [made] = await conn.query(INSERT_RUN, [DUMP_JOB, runDate, stamp(nowMs)]);
      return { claimed: true, id: Number(made.insertId), previous: null };
    } catch (e) {
      if (e?.errno === 1062) return { claimed: false, reason: 'running_elsewhere' }; // somebody inserted the row a moment ago
      throw e;
    }
  }
  if (row.status === 'ok') return { claimed: false, reason: 'already_done' };
  const abandoned = row.status === 'running' && Number(row.stale) === 1;
  if (!(row.status === 'failed' || abandoned)) return { claimed: false, reason: 'running_elsewhere' };
  const [taken] = await conn.query(TAKE_RUN, [stamp(nowMs), Number(row.id), row.status, row.started_text]);
  if (taken.affectedRows !== 1) return { claimed: false, reason: 'running_elsewhere' };
  return { claimed: true, id: Number(row.id), previous: { status: row.status, detail: parseDetail(row.detail) } };
}

async function finishDumpRun(conn, { id, status, nowMs, detail }) {
  await conn.query('UPDATE sys_job_runs SET status = ?, finished_at = ?, detail = ? WHERE id = ?', [status, stamp(nowMs), JSON.stringify(detail ?? null), id]);
}

// ---------------------------------------------------------------- the folder signal (spec 5.2.2, B2, I12)

/**
 * Writes down what the probe found, so that the owner's line can turn red. THE SIGNAL: a backup_runs row of kind `db_dump`, ok = 0, detail = { phase: 'folder_probe', folder_probe: { ok, code, where } }.
 * A failure is written when the newest such row is not the same failure of the last 24 hours, together with a sys_error_log row (code JV_BACKUP_FOLDER, via logError); a probe that passes while the
 * newest such row is a failure writes the heal row (folder_probe.ok = true). The TypeScript copy for the start-up check is recordFolderProbe in src/jobs/backupFolder.ts.
 * Returns { written, healed }.
 */
export async function recordFolderProbe(conn, probe, { nowMs }) {
  const [rows] = await conn.query(
    "SELECT DATE_FORMAT(ran_at, '%Y-%m-%d %H:%i:%s.%f') AS at, JSON_VALUE(detail, '$.folder_probe.ok') AS ok, JSON_VALUE(detail, '$.folder_probe.code') AS code, JSON_VALUE(detail, '$.folder_probe.where') AS wh FROM backup_runs WHERE kind = 'db_dump' AND JSON_CONTAINS_PATH(detail, 'one', '$.folder_probe') ORDER BY id DESC LIMIT 1"
  );
  const last = rows[0];
  if (probe.ok) {
    if (!last || !isFalse(last.ok)) return { written: false, healed: false };
    await recordBackupRun(conn, { kind: 'db_dump', ok: false, ranAt: stamp(nowMs), detail: { phase: 'folder_probe', folder_probe: { ok: true } } });
    return { written: false, healed: true };
  }
  const same = last && isFalse(last.ok) && last.code === probe.code && last.wh === probe.where && nowMs - utcMs(last.at) < FOLDER_PROBE_REPEAT_MS;
  if (same) return { written: false, healed: false };
  await recordBackupRun(conn, { kind: 'db_dump', ok: false, ranAt: stamp(nowMs), detail: { phase: 'folder_probe', folder_probe: { ok: false, code: probe.code, where: probe.where } } });
  await logError(
    conn,
    { level: 'error', code: 'JV_BACKUP_FOLDER', message: `The backup folder cannot be used: ${probe.message}. Nothing can be backed up until it is fixed.`, detail: { code: probe.code, where: probe.where } },
    { now: new Date(nowMs) }
  );
  return { written: true, healed: false };
}

// ---------------------------------------------------------------- one night

/** The folder as backup_runs.detail.folder records it: files, bytes, and the free figure as the budget less the folder (statfs is the whole server's volume, no figure for the plan's 50 GB). */
async function budgetedFolder(dir) {
  const stats = await folderStats(dir);
  return { files: stats.files, bytes: stats.bytes, free_bytes: Math.max(0, BACKUP_FOLDER_BUDGET_BYTES - stats.bytes), budget_bytes: BACKUP_FOLDER_BUDGET_BYTES, daily: stats.daily, monthly: stats.monthly, photos: stats.photos };
}

const countsOf = (manifest) => Object.fromEntries(manifest.tables.map((t) => [t.name, t.rows]));

async function countsOfRecord(conn, name) {
  const [rows] = await conn.query("SELECT JSON_EXTRACT(detail, '$.counts') AS counts FROM backup_runs WHERE kind = 'db_dump' AND JSON_VALUE(detail, '$.export.name') = ? AND JSON_EXTRACT(detail, '$.counts') IS NOT NULL ORDER BY id DESC LIMIT 1", [name]);
  return rows.length ? parseDetail(rows[0].counts) : null;
}

async function dumpNight(conn, { dir, date, env, nowMs, log, exportOptions, afterLink }) {
  const now = nowMs();
  const claim = await claimDumpRun(conn, { runDate: date, nowMs: now });
  if (!claim.claimed) {
    if (claim.reason === 'already_done') {
      log.info(`dump: already done for ${date}`);
      return { status: 'already_done', exitCode: 0, date };
    }
    log.info(`dump: a run for ${date} started less than 30 minutes ago and is not finished; nothing to do yet`);
    return { status: 'running_elsewhere', exitCode: 0, date };
  }
  const runId = `${claim.id}-${randomBytes(3).toString('hex')}`;
  const at = () => new Date(nowMs());

  let written;
  let manifest = null;
  let state;
  try {
    const publicKey = loadPublicKey(env.BACKUP_PUBLIC_KEY);
    state = await readPruneState(conn); // BEFORE tonight's row is written
    const recorded = await readRecordedExport(conn, date);
    written = await writeDailyExport({
      dir,
      date,
      runId,
      publicKey,
      nowMs: now,
      recorded,
      exportFn: async (sink) => (manifest = await exportDatabase(conn, sink, exportOptions)),
      // BEFORE the file is linked: if the process dies between the link and the ok row, the next run finds this record, sees that the final file matches it and only writes the ok row
      record: (info) =>
        recordBackupRun(conn, {
          kind: 'db_dump',
          ok: false,
          ranAt: stamp(nowMs()),
          detail: { phase: 'linking', run_id: info.run_id, export: { name: info.name, sha256: info.sha256, size: info.size }, ...(manifest ? { counts: countsOf(manifest) } : {}) },
        }).then(() => undefined),
    });
  } catch (e) {
    return failNight(conn, e, { claim, runId, date, nowMs, log });
  }
  if (afterLink) await afterLink(written); // a seam of the tests: whatever it throws is a crash, and nothing is recorded

  try {
    for (const alert of written.alerts) {
      await logError(conn, { level: 'warn', code: 'JV_BACKUP_ALERT', message: `The nightly dump of ${date} raised an alert (${alert.code}).`, detail: { alert: alert.code, ...alert.detail } }, { now: at() });
    }
    const exportInfo = { name: written.name, sha256: written.sha256, size: written.size };
    const counts = written.manifest ? countsOf(written.manifest) : await countsOfRecord(conn, written.name);
    const folder = await budgetedFolder(dir);
    const detail = { phase: 'done', run_id: runId, status: written.status, export: exportInfo, counts, monthly: written.monthly, folder, ...(written.alerts.length ? { alerts: written.alerts.map((a) => a.code) } : {}) };
    const okRow = await recordBackupRun(conn, { kind: 'db_dump', ok: true, bytes: written.size, ranAt: stamp(nowMs()), detail });
    await finishDumpRun(conn, { id: claim.id, status: 'ok', nowMs: nowMs(), detail: { run_id: runId, export: exportInfo, backup_run_id: okRow.id } });

    // pruning is the last step, after the ok row (B2): a failure here never takes the night's ok away
    let outcome;
    try {
      outcome = await prune(dir, { goodWriteTonight: true, lastRecordedFiles: state.lastRecordedFiles, dryRunDone: state.dryRunDone });
      const more = {};
      if (outcome.action === 'dry_run') more.prune_dry_run = { names: outcome.candidates };
      if (outcome.action === 'pruned') {
        more.pruned = outcome.removed.length;
        more.folder = await budgetedFolder(dir); // the folder as it is NOW, so that the dashboard does not read the removal as a loss
      }
      if (outcome.action === 'refused') {
        more.prune_refused = { reason: outcome.reason, files: outcome.files ?? null, recorded: outcome.recorded ?? null };
        await logError(conn, { level: 'warn', code: 'JV_BACKUP_ALERT', message: `Pruning was refused (${outcome.reason}); nothing was deleted.`, detail: { alert: 'prune_refused', reason: outcome.reason, files: outcome.files ?? null, recorded: outcome.recorded ?? null } }, { now: at() });
      }
      if (Object.keys(more).length) {
        Object.assign(detail, more);
        await conn.query('UPDATE backup_runs SET detail = ? WHERE id = ?', [JSON.stringify(detail), okRow.id]);
      }
    } catch (e) {
      const error = describeError(e);
      outcome = { action: 'failed', error: error.message };
      log.warn(`dump: pruning failed: ${error.message}`);
      await logError(conn, { level: 'warn', code: 'JV_BACKUP_ALERT', message: 'Pruning failed; the night itself is ok.', detail: { alert: 'prune_failed', error } }, { now: at() }).catch(() => undefined);
    }
    log.info(`dump: done ${date} ${written.name} ${written.size} bytes (${written.status === 'already_done' ? 'recorded by an earlier attempt of the night' : 'written now'}); folder ${detail.folder.files} files, prune ${outcome.action}`);
    return { status: 'done', exitCode: 0, date, written: written.status, export: exportInfo, counts, folder: detail.folder, prune: outcome, backupRunId: okRow.id };
  } catch (e) {
    return failNight(conn, e, { claim, runId, date, nowMs, log });
  }
}

/** Writes a failed night down: a backup_runs row with ok = 0, the day's row `failed`, an error-log row. Whatever cannot be written is only said on the output. */
async function failNight(conn, e, { claim, runId, date, nowMs, log }) {
  const error = describeError(e);
  log.error(`dump: failed: ${error.message}`);
  try {
    await recordBackupRun(conn, { kind: 'db_dump', ok: false, ranAt: stamp(nowMs()), detail: { phase: 'failed', run_id: runId, error } });
    await finishDumpRun(conn, { id: claim.id, status: 'failed', nowMs: nowMs(), detail: { run_id: runId, error } });
    await logError(conn, { level: 'error', code: 'JV_BACKUP_FAILED', message: `The nightly dump of ${date} failed (${error.name}${error.code ? ` ${error.code}` : ''}).`, detail: { run_id: runId, error } }, { now: new Date(nowMs()) });
  } catch (recordError) {
    log.error(`dump: the failure could not be recorded: ${describeError(recordError).message}`);
  }
  return { status: 'failed', exitCode: 1, error };
}

// ---------------------------------------------------------------- the job

async function openConnection(settings, { pacer, connect, sleep }) {
  const open = () => pacedConnect(pacer, () => connect(settings));
  try {
    return await open();
  } catch (e) {
    if (e?.code !== 'EPERM') throw e;
    await sleep(REFUSED_RETRY_MS); // S11: a refused new connection is retried once after 1.1 seconds
    return open();
  }
}

/**
 * One run of the nightly dump job. Throws DumpUsageError (exit code 2) when a database setting is missing; everything else is a result with an exitCode: 0 for done, not due, already done and
 * another run in charge, 1 for an unusable folder and for a failure.
 */
export async function runDumpJob(options = {}) {
  const env = options.env ?? process.env;
  const log = options.log ?? consoleLog;
  const nowMs = options.nowMs ?? (() => Date.now());
  const settings = connectionSettings(env);
  const pacer = options.pacer ?? createPacer();
  const connect = options.connect ?? ((s) => mysql.createConnection(s));
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  let conn;
  try {
    conn = await openConnection(settings, { pacer, connect, sleep });
  } catch (e) {
    const error = describeError(e);
    log.error(`dump: cannot connect to the database: ${error.code ?? error.name}`);
    return { status: 'failed', exitCode: 1, error };
  }
  try {
    await conn.query(SESSION_SQL);

    // 2. the folder, on every run
    const probe = await probeBackupSetting(env.JV_BACKUP_DIR);
    await recordFolderProbe(conn, probe, { nowMs: nowMs() });
    if (!probe.ok) {
      log.error(`dump: the backup folder cannot be used: ${probe.code} (${probe.where}). ${probe.message}`);
      return { status: 'folder_unusable', exitCode: 1, probe };
    }

    // 3. what is due
    const now = nowMs();
    const date = businessDate(now);
    if (!afterNightlyGate(now)) {
      log.info('dump: not due (before 02:00 Asia/Kolkata)');
      return { status: 'not_due', exitCode: 0, date };
    }
    const [done] = await conn.query("SELECT 1 AS done FROM sys_job_runs WHERE job = ? AND run_date = ? AND status = 'ok'", [DUMP_JOB, date]);
    if (done.length > 0) {
      log.info(`dump: already done for ${date}`);
      return { status: 'already_done', exitCode: 0, date };
    }

    // 4. one at a time
    const locked = await withJobLock(conn, 'dump', () => dumpNight(conn, { dir: probe.dir, date, env, nowMs, log, exportOptions: options.exportOptions ?? {}, afterLink: options.afterLink }));
    if (!locked.ran) {
      log.info('dump: another dump is running');
      return { status: 'locked', exitCode: 0 };
    }
    return locked.value;
  } catch (e) {
    const error = describeError(e);
    log.error(`dump: failed: ${error.message}`);
    return { status: 'failed', exitCode: 1, error };
  } finally {
    await conn.end().catch(() => conn.destroy());
  }
}
