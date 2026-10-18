import type { Connection } from 'mysql2/promise';
import type { KeyObject } from 'node:crypto';
import type { Manifest, Sink } from './backup.mjs';

export const KEEP_DAILY: number;
export const KEEP_MONTHLY: number;
export const PARTIAL_MAX_AGE_MS: number;
export const SUBFOLDERS: string[];
/** The business date (Asia/Kolkata) of an instant, yyyy-mm-dd. */
export function businessDate(ms?: number): string;
export function dailyName(date: string): string;
export function dailyRunName(date: string, runId: string | number): string;
export function monthlyName(date: string): string;
/** JV_BACKUP_DIR: absolute, no "~", no "..", not the root. Returns the normalised path. */
export function resolveBackupDir(value: string | undefined): string;
/** Why the folder cannot be used: ENOENT (missing), ENOTDIR, EACCES (read-only), EROFS, ENOSPC ... or CONFIG (the setting itself). `where` is `folder`, a sub-folder, or `JV_BACKUP_DIR`. No path is in it. */
export interface FolderProbeFailure { ok: false; code: string; where: string; message: string }
export type FolderProbe = { ok: true } | FolderProbeFailure;
/** Spec 5.2.2: the folder exists, is a folder and is writable (a file is created and removed in it and in each sub-folder that exists). Never makes the folder. */
export function probeBackupDir(dir: string): Promise<FolderProbe>;
/** resolveBackupDir, then probeBackupDir: a value that is no usable path is `CONFIG`. On success the answer carries the resolved folder. */
export function probeBackupSetting(value: string | undefined): Promise<FolderProbe & { dir?: string }>;
export function prepareFolder(dir: string): Promise<void>;
export function sweepPartials(dir: string, opts?: { nowMs?: number; maxAgeMs?: number }): Promise<string[]>;
export interface FolderStats { files: number; bytes: number; free_bytes: number | null; daily: number; monthly: number; photos: number }
export function folderStats(dir: string): Promise<FolderStats>;
export function fileDigest(file: string): Promise<{ sha256: string; size: number }>;
export interface RecordedExport { name: string; sha256: string; size: number }
export function checkRecordedExport(dir: string, recorded: RecordedExport | null): Promise<{ done: true; name: string; sha256: string; size: number } | { done: false; reason: 'no_record' | 'bad_record' | 'missing' | 'differs' }>;
export function linkMonthly(dir: string, finalName: string, date: string): Promise<boolean>;
export interface WriteDailyOptions {
  dir: string;
  date: string;
  runId: string | number;
  publicKey: KeyObject;
  exportFn: (sink: Sink) => Promise<Manifest>;
  /** Called BEFORE the file is linked, with what to store in backup_runs.detail. May be called a second time if the plain name was taken in between. */
  record?: (info: RecordedExport & { run_id: string }) => Promise<void>;
  recorded?: RecordedExport | null;
  nowMs?: number;
}
export interface WriteDailyResult {
  status: 'written' | 'already_done';
  name: string;
  sha256: string;
  size: number;
  /** The plain daily/<date>.enc was already there (and left alone): this run's file has its own name. */
  conflict: boolean;
  /** Alerts to raise: export_name_taken, export_record_mismatch. */
  alerts: { code: string; detail: Record<string, unknown> }[];
  /** The monthly name created by this run, or null. */
  monthly: string | null;
  manifest: Manifest | null;
}
/** B2: sweep old partials, apply the retry rule, dump into <run name>.partial (fsync), record the sha256 and size, link create-once, link monthly. */
export function writeDailyExport(opts: WriteDailyOptions): Promise<WriteDailyResult>;
export function planPrune(dir: string, opts?: { keepDaily?: number; keepMonthly?: number }): Promise<{ keep: string[]; remove: string[] }>;
export interface PruneResult { action: 'refused' | 'nothing' | 'dry_run' | 'pruned'; reason?: 'no_good_write_tonight' | 'fewer_files_than_recorded'; candidates: string[]; removed: string[]; files?: number; recorded?: number }
/** B2 guard rails: only after a good write tonight, never with fewer files than the last recorded count, the first real prune after a logged dry run, newest 30 daily and 13 monthly always kept. */
export function prune(dir: string, opts: { goodWriteTonight: boolean; lastRecordedFiles?: number | null; dryRunDone?: boolean; keepDaily?: number; keepMonthly?: number }): Promise<PruneResult>;
export function readPruneState(conn: Connection): Promise<{ lastRecordedFiles: number | null; dryRunDone: boolean }>;
/** detail.export = { name, sha256, size } of the latest db_dump row for this business date (written before the link), or null: the `recorded` input of writeDailyExport. */
export function readRecordedExport(conn: Connection, date: string): Promise<RecordedExport | null>;
export function recordBackupRun(conn: Connection, run: { kind: 'db_dump' | 'photo_copy' | 'restore_drill'; ok: boolean; bytes?: number; detail?: Record<string, unknown>; ranAt?: string | null }): Promise<{ id: number }>;
