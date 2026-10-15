import type { Connection } from 'mysql2/promise';
import type { PhotoStore, Source } from './backup.mjs';

export interface RestoreOptions {
  pageSize?: number;
  /** Skip a photo row whose bytes are not in the photo store instead of failing (and list it). Default false. */
  allowMissingPhotos?: boolean;
  /** Do not run the nightly check on the restored copy. */
  skipInvariants?: boolean;
}
export interface RestoreReport {
  ok: boolean;
  tables: { name: string; rows_expected: number; rows_restored: number; hash_ok: boolean }[];
  views: number;
  triggers: number;
  photos: { live_expected: number; restored: number; missing: { id: string; kind: string }[] };
  /** Rows whose foreign key points at nothing (found after the load, with the keys switched on again). */
  fk_orphans: { constraint: string; table: string; rows: number }[];
  invariants: { ok: boolean; counts: Record<string, number> } | null;
  problems: string[];
  ms: number;
}
/** B4: rebuild an EMPTY database from an export and the photo copy, then prove it equal. Refuses a database that already has tables. */
export function restoreDatabase(conn: Connection, source: Source, photos: PhotoStore, opts?: RestoreOptions): Promise<RestoreReport>;
