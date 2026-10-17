import type { Connection } from 'mysql2/promise';
import type { Remote } from './backup-remote.mjs';
import type { RestoreReport } from './restore.mjs';

export const EXIT: { ok: 0; failed: 1; usage: 2; photosMissing: 4 };

/** A refusal with a plain message for Harsh (code: wrong_key, damaged, not_empty, no_export, bad_key_file, usage, no_record, mismatch, docker). */
export class ToolError extends Error {
  code: string;
  constructor(code: string, message: string);
}
export interface DbSettings { host: string; port: number; database: string; user: string; password: string }
export interface Pacer { wait(): Promise<void> }

export interface RestoreOptions {
  /** the private key FILE (PEM) of one key holder; it is read here and never copied anywhere */
  key: string;
  /** exactly one of these three: a folder with the backup layout (a pulled copy, a USB stick), a Remote (SFTP), or one encrypted file downloaded by hand */
  fromFolder?: string;
  remote?: Remote;
  file?: string;
  /** which export of the folder or the server (default: the newest `daily/` file), like `daily/2026-10-16.enc` or `monthly/2026-10.enc` */
  name?: string;
  /** a folder of photo objects (`<id>-<kind>`); default: the `photos/` of the folder or, over SFTP, the live photos the export names are fetched */
  photosDir?: string;
  /** where the database is rebuilt: an EMPTY database (a database with tables is refused before anything is read) */
  target: DbSettings;
  /** where the decrypted export is unpacked (plain customer data: removed again, also after a failure); default: the system temp folder */
  workRoot?: string;
  pacer?: Pacer;
  migrationsDir?: string;
  /** print the sha256 line of every restored photo (default: the first 40) */
  listPhotos?: boolean;
  /** how many random live photos are opened and checked (default 20) */
  sample?: number;
  log?: (line: string) => void;
  now?: () => number;
}
export type RestoreStatus = 'restored' | 'restored_photos_missing' | 'failed_checks';
export interface RestoreResult {
  status: RestoreStatus;
  report: RestoreReport;
  /** the report as the tool prints it (no password and no key in it) */
  text: string;
  /** new connections the tool opened, each through the pacer (S11) */
  connections: number;
  file: { name: string | null; sha256: string; size: number };
  photos: { live: number; restored: number; tombstoned: { id: string; kind: string; reason: string }[]; opened: number; sampled: number; failedToOpen: string[] };
  ms: number;
}
/** B4 on Harsh's Mac: get the export, decrypt it with the private key file, rebuild the EMPTY target database with restoreDatabase, prove it, print the report. */
export function restoreBackup(opts: RestoreOptions): Promise<RestoreResult>;
export function exitCodeFor(result: Pick<RestoreResult, 'status'>): number;

export interface DrillDatabase {
  name: string;
  target: DbSettings;
  /** `docker rm -fv` of this container and of nothing else */
  remove(): Promise<void>;
}
export interface DrillOptions {
  /** default `jv-restore-drill`; only names `jv-restore-drill` or `jv-restore-drill-<letters and digits>` are accepted */
  name?: string;
  image?: string;
  /** size of the RAM disk that holds the data (default 3g) */
  tmpfsSize?: string;
  database?: string;
  /** test seam: runs `docker <args>` and returns stdout */
  docker?: (args: string[], env?: NodeJS.ProcessEnv) => Promise<string>;
  pacer?: Pacer;
}
/** Drill 1 (B4): a throw-away MariaDB 11.8 in Docker on this Mac, data in tmpfs, no volume, published on 127.0.0.1 only, Hostinger's settings, an empty database and the ten-box user of A3. */
export function startDrillDatabase(opts?: DrillOptions): Promise<DrillDatabase>;
export function removeDrillDatabase(name?: string, opts?: Pick<DrillOptions, 'docker'>): Promise<boolean>;
export function drillCommandArgs(opts: { name: string; image: string; tmpfsSize: string }): string[];

export type RecordsReader = {
  /** backup_runs.detail.export of every dump, oldest first (the newest record of a name wins); `name` is null for a hash typed in by hand, which applies to the file given */
  exportRecords(): Promise<{ name: string | null; sha256: string; size: number | null }[]>;
  /** sys_photo_copies: `<id>-<kind>` to sha256 and size */
  photoRecords(): Promise<Map<string, { sha256: string; size: number }>>;
};
/** What the pull compares against: backup_runs.detail.export and sys_photo_copies, read through a (read-only) connection. */
export function dbRecords(conn: Connection): RecordsReader;
/** For a file downloaded by hand when no database can be reached: the sha256 (from phpMyAdmin or the dashboard) typed in. Photos cannot be checked this way. */
export function manualRecords(sha256: string, size?: number): RecordsReader;

export interface PullFacts { at: string; by: string; file: string; sha256: string }
export interface PullOptions {
  /** the folder the pulled copy is kept in (same layout as the server: daily/, monthly/, photos/); files are created once and never overwritten */
  dest: string;
  fromFolder?: string;
  remote?: Remote;
  /** one file downloaded by hand from hPanel's File Manager */
  file?: string;
  /** the backup name of that file, when its file name does not say (`daily/2026-10-16.enc`) */
  as?: string;
  /** also pull the newest `monthly/` file and the photos that are new since the last pull */
  monthly?: boolean;
  records: RecordsReader;
  /** a private key file: the pulled export is decrypted in a throw-away folder to prove this holder can read it (T-R06) */
  key?: string;
  /** reports the pull through the admin door; not called unless every check passed */
  reportPull?: (facts: PullFacts) => Promise<void>;
  by?: string;
  now?: () => Date;
  workRoot?: string;
  log?: (line: string) => void;
}
export interface PullItem { name: string; state: 'new' | 'already' | 'skipped_unrecorded' | 'mismatch' | 'missing_record'; sha256?: string; size?: number }
export interface PullResult {
  status: 'pulled' | 'failed';
  newest: { name: string; sha256: string; size: number } | null;
  items: PullItem[];
  problems: string[];
  decrypted: boolean | null;
  reported: boolean;
  text: string;
}
/** O54 / T-R06: the weekly pull. Newest `daily/` file (monthly: also `monthly/` and the new photos), each checked against the record, kept create-once, optionally decrypted with a holder's key, then reported. */
export function pullBackup(opts: PullOptions): Promise<PullResult>;
/** `daily/`, `monthly/` file names from a listing: the newest by the date in the name; a retried night's `<date>-<run id>.enc` ties with `<date>.enc` and `prefer` (a recorded name) wins. */
export function newestOf(names: string[], prefer?: string[]): string | null;
/** The command that reports a pull through the admin door: `npm run admin -- record-pull ...` (API09). */
export function adminRecordPullCommand(facts: PullFacts): { command: string; args: string[] };
export function runAdminRecordPull(facts: PullFacts, opts?: { run?: (command: string, args: string[], cwd: string) => Promise<{ code: number; stderr: string }>; cwd?: string }): Promise<void>;

/** A small encrypted file for the key holders' proof at drill 1 (B4): encrypted with the PUBLIC key, opened with each holder's private key. */
export function makeKeyTestFile(publicKeyText: string, outFile: string): Promise<{ sha256: string; size: number }>;
export function checkKeyTestFile(encFile: string, keyFile: string, workRoot?: string): Promise<{ ok: true }>;
