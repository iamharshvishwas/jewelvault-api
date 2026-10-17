export type Sub = 'daily' | 'monthly' | 'photos';
export interface FetchItem {
  /** the name in the backup folder, like `daily/2026-10-16.enc` or `photos/<id>-full` */
  name: string;
  /** the local path to write (the caller names it `.partial` and renames it after the check) */
  to: string;
}
/** The backup folder as the Mac sees it (B2 layout: daily/, monthly/, photos/): a local folder, or the server over SFTP. */
export interface Remote {
  describe: string;
  /** The folder itself when it is on this computer (a copy, a USB stick), so the restore reads its photos in place; null for a server. */
  localRoot: string | null;
  /** File names in one sub-folder (no `.partial`). A sub-folder that is not there is an empty list. */
  list(sub: Sub): Promise<string[]>;
  /** Copies the files to the local paths in ONE session; throws naming the first file that cannot be read. */
  fetch(items: FetchItem[]): Promise<void>;
  close(): Promise<void>;
}
export function folderRemote(dir: string): Remote;

export interface SftpOptions {
  /** `user@host`, Harsh's own login (O54); never a secret of the app */
  target: string;
  /** default 65002 (Hostinger's SSH port) */
  port?: number;
  /** the backup folder on the server (JV_BACKUP_DIR; absolute, or relative to the login's home) */
  dir: string;
  /** a private key file for the login; without one the password is asked for by ssh itself on the terminal */
  identityFile?: string;
  /** extra ssh options, each as `-o`, `Name=value` (for example UserKnownHostsFile=...); the tests use them for a throw-away server */
  sshOptions?: string[];
  /** test seam: the `ssh` and `sftp` programs (default: the ones on the PATH) */
  bin?: { ssh?: string; sftp?: string };
  env?: NodeJS.ProcessEnv;
  /** where the control socket lives (default: the system temp folder) */
  tmpRoot?: string;
  /** child-process stdio for the master connection (default 'inherit', so a password prompt reaches the terminal) */
  masterStdio?: 'inherit' | 'ignore';
}
/** SFTP through the OpenSSH programs that ship with macOS: one master connection (ControlMaster) is opened once, so the login is asked for once; every listing and download is an `sftp -b` batch over it. */
export function sftpRemote(opts: SftpOptions): Remote;
/** A path as one word of an sftp batch line: in double quotes, with `"` and `\` escaped. */
export function batchQuote(text: string): string;
/** The file names in the output of a batched `ls -1` (the echoed `sftp>` lines and blank lines are dropped). */
export function parseListing(stdout: string): string[];
