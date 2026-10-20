import type { Connection } from 'mysql2/promise';
import type { PhotoStore, Source } from './backup.mjs';

export interface RestoreOptions {
  pageSize?: number;
  /** The migration files to apply (default db/migrations of this repository). They must be the ones the export was made with. */
  migrationsDir?: string;
  /** Apply the trigger files of db/optional last when the export says the source had triggers (default true). */
  triggers?: boolean;
  /** Do not run the nightly check on the restored copy. */
  skipInvariants?: boolean;
}
export interface PhotoProblem { id: string; kind: string; reason: 'missing' | 'sha256' | 'size' }
export interface RestoreReport {
  /** true only when every table equals the export, no photo had to be tombstoned, and the nightly check passes. */
  ok: boolean;
  tables: { name: string; rows_expected: number; rows_restored: number; hash_ok: boolean }[];
  triggers: number;
  /** A live photo that is missing from the photo copy or does not match is inserted as a TOMBSTONE (removed_at = the restore time) and listed here; the owner decides about each one. */
  photos: { live_expected: number; restored: number; tombstoned: PhotoProblem[] };
  fk_orphans: { constraint: string; table: string; rows: number }[];
  invariants: { ok: boolean; counts: Record<string, number> } | null;
  problems: string[];
  /** Things the report says that are not problems: for example that a table of an older export was compared without a cutoff (RV3a-F2). */
  notes: string[];
  ms: number;
}
/**
 * B4: (1) apply the migration files to an EMPTY database without the trigger files, (2) load the data in foreign-key order, (3) insert each live photo row together with
 * its bytes, (4) tombstones as they are, (5) the trigger files last, (6) the nightly check and the row counts against the manifest. Refuses a database that has tables.
 */
export function restoreDatabase(conn: Connection, source: Source, photos: PhotoStore, opts?: RestoreOptions): Promise<RestoreReport>;
