// U3, O54: the two statements of the admin door that belong to the database half: the call that clears the login counters and the call that records a pull of the backup.
// This is the TypeScript twin of clearLoginCounters and recordPull in scripts/housekeeping.mjs (MB05, tested by tests/schema/s18-housekeeping.test.ts). The build compiles src/ alone, so src cannot
// import a scripts/*.mjs file (src/db/errorLog.ts is the twin of logError the same way); tests/api/admin-statements.test.ts keeps the two identical: the same statements, character for character,
// the same rows for the same calls and the same refusals in the same words.
//
// `last_pulled` is written here and nowhere else (O54: the generic settings edit never writes it; tests/api/admin-door.test.ts looks for any other writer in src/).
import type { Tx } from './tx.js';

/** U3: n = 0 and the window to now (the database's clock, as the counters themselves use) on every row of the counting scopes; the summary row (scope audit) is left alone. The scopes are named, so the primary key is used. */
export const CLEAR_COUNTERS_SQL = "UPDATE sys_login_attempts SET n = 0, window_start = UTC_TIMESTAMP(6) WHERE scope IN ('email', 'addr', 'any')";

/** O54: settings.last_pulled = { at, by, file, sha256 }; the health line reads it (I12). */
export const RECORD_PULL_SQL = "INSERT INTO settings (setting_key, value) VALUES ('last_pulled', ?) ON DUPLICATE KEY UPDATE value = VALUES(value)";

export async function clearLoginCounters(tx: Pick<Tx, 'run'>): Promise<{ cleared: number }> {
  const res = await tx.run(CLEAR_COUNTERS_SQL);
  return { cleared: res.affectedRows };
}

export interface Pull {
  /** the time of the pull, an ISO time such as 2026-10-10T05:00:00.000Z */
  at: string;
  by: string;
  /** the backup file that was pulled, such as daily/2026-10-10.enc */
  file: string;
  /** the SHA-256 of that file, 64 hex characters */
  sha256: string;
}

/** The name of a backup file as the backup folder writes it (the same pattern as recordPull of the script). */
export const BACKUP_FILE_PATTERN = /^(daily|monthly)\/\d{4}-\d{2}(-\d{2})?(-[0-9A-Za-z][0-9A-Za-z-]{0,39})?\.enc$/;
export const SHA256_PATTERN = /^[0-9a-f]{64}$/i;

export async function recordPull(tx: Pick<Tx, 'run'>, pull: Pull): Promise<{ recorded: true }> {
  if (typeof pull.at !== 'string' || Number.isNaN(Date.parse(pull.at))) throw new Error('recordPull: at must be a time like 2026-10-10T05:00:00.000Z');
  if (typeof pull.by !== 'string' || pull.by.trim() === '') throw new Error('recordPull: by is blank');
  if (typeof pull.file !== 'string' || !BACKUP_FILE_PATTERN.test(pull.file)) throw new Error('recordPull: file must be a backup name like daily/2026-10-10.enc');
  if (typeof pull.sha256 !== 'string' || !SHA256_PATTERN.test(pull.sha256)) throw new Error('recordPull: sha256 must be 64 hex characters');
  const value = JSON.stringify({ at: pull.at, by: pull.by, file: pull.file, sha256: pull.sha256.toLowerCase() });
  await tx.run(RECORD_PULL_SQL, [value]);
  return { recorded: true };
}
