import type { Connection, ConnectionOptions } from 'mysql2/promise';
import type { FolderProbe, PruneResult, WriteDailyResult } from './backup-folder.mjs';
import type { Pacer } from './pacing.mjs';

/** The job name of the dump: sys_job_runs.job and backup_runs.kind. */
export const DUMP_JOB: 'db_dump';
/** A `running` row of the dump older than this is abandoned and taken over (I8: the tick's is 10 minutes, the dump's 30). */
export const DUMP_ABANDONED_AFTER_MS: number;
/** The nightly work is due from this hour on, Asia/Kolkata (I8). */
export const NIGHTLY_FROM_HOUR: number;
/** The folder's stated budget: the plan's 50 GB of disk (B2, [H]). `statfs` shows the whole server's volume and is no figure for it. */
export const BACKUP_FOLDER_BUDGET_BYTES: number;
/** A failed folder probe is written again only after this long, if it is the same failure (once a day, not once an hour). */
export const FOLDER_PROBE_REPEAT_MS: number;
/** The S11 session of the pool, with the 20 s statement limit of I8 for the tick and the dump. */
export const DUMP_SESSION: Readonly<{
  isolation: string;
  sqlMode: string;
  timeZone: string;
  lockWaitTimeout: number;
  maxStatementTime: number;
  waitTimeout: number;
  charset: string;
  collation: string;
}>;

/** Whether the instant is 02:00:00 in Asia/Kolkata or later on its business date. */
export function afterNightlyGate(ms: number): boolean;

/** A setting that is missing or unusable at the start: the command line is wrong, nothing was opened. exitCode is 2. */
export class DumpUsageError extends Error {
  exitCode: 2;
}

export interface DumpLog {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export type ClaimResult = { claimed: true; id: number; previous: { status: string; detail: unknown } | null } | { claimed: false; reason: 'already_done' | 'running_elsewhere' };
/** The dump's row in sys_job_runs for a business date (unique on job and run_date): taken, retried by UPDATE, or somebody else's. */
export function claimDumpRun(conn: Connection, input: { runDate: string; nowMs: number }): Promise<ClaimResult>;

/** Writes the signal the dashboard reads (backup_runs ok = 0, detail.folder_probe) and the error-log row, or the heal row. */
export function recordFolderProbe(conn: Connection, probe: FolderProbe, opts: { nowMs: number }): Promise<{ written: boolean; healed: boolean }>;

export interface RunDumpOptions {
  env?: Record<string, string | undefined>;
  nowMs?: () => number;
  pacer?: Pacer;
  log?: DumpLog;
  /** passed to exportDatabase (pageSize, between: called after each table) */
  exportOptions?: { pageSize?: number; between?: (table: string) => Promise<void> | void };
  /** test seam: opens the one connection (default: mysql2 createConnection) */
  connect?: (settings: ConnectionOptions) => Promise<Connection>;
  /** test seam: called after the export is linked and before the ok row; a throw here is a crash (nothing is recorded) */
  afterLink?: (written: WriteDailyResult) => Promise<void> | void;
}

export interface DumpDone {
  status: 'done';
  exitCode: 0;
  date: string;
  /** `written`: this run dumped; `already_done`: an earlier attempt of the night had linked the file and only lacked its ok row */
  written: 'written' | 'already_done';
  export: { name: string; sha256: string; size: number };
  counts: Record<string, number>;
  folder: { files: number; bytes: number; free_bytes: number; budget_bytes: number };
  prune: PruneResult | { action: 'failed'; error: string };
  backupRunId: number;
}
export type DumpResult =
  | DumpDone
  | { status: 'not_due'; exitCode: 0; date: string }
  | { status: 'already_done'; exitCode: 0; date: string }
  | { status: 'locked'; exitCode: 0 }
  | { status: 'running_elsewhere'; exitCode: 0; date: string }
  | { status: 'folder_unusable'; exitCode: 1; probe: FolderProbe }
  | { status: 'failed'; exitCode: 1; error: { name: string; code: string | null; message: string } };

/** B2, I8 (B): one run of the nightly dump job. Throws DumpUsageError when a database setting is missing; everything else is a result. */
export function runDumpJob(options?: RunDumpOptions): Promise<DumpResult>;
