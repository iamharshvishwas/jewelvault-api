import type { Connection } from 'mysql2/promise';
export const RED_AFTER_HOURS: number;
export const DB_RED_LINE_BYTES: number;
export interface Age { last_at: string | null; age_hours: number | null }
export interface Health {
  /** 'red' (something is wrong), 'amber' (the database user may delete or drop), or 'green'. */
  level: 'red' | 'amber' | 'green';
  /** Why it is red or amber, in the order of the dashboard: check_problem, check_stale, check_never, dump_stale, dump_never, photo_copy_stale, photo_copy_never, db_size, delete_or_drop_right. */
  reasons: string[];
  /** The last nightly check of any result (check_runs), and whether that last run said the books are fine. */
  check: Age & { ok: boolean | null };
  /** The last backup_runs row with ok = 1 for the export (db_dump) and for the once-only photo copy. */
  db_dump: Age;
  photo_copy: Age;
  /** P5: (DATA_LENGTH + INDEX_LENGTH of every table except design_photos, after ANALYZE TABLE of each, + SUM(byte_size) of the live photos) x 1.12. */
  db_size: { bytes: number; data_bytes: number; index_bytes: number; photo_bytes: number; overhead_percent: number; red_line_bytes: number; injected: boolean };
  /** What the database user may do: S11/S7 say Delete and Drop stay unticked. */
  rights: { delete: boolean; drop: boolean; /** boxes of A3 that are on although they should be off (besides Delete and Drop, which have their own flags and the amber level), sorted */ extra: string[] };
  now: string;
}
export interface HealthOptions {
  /** 'YYYY-MM-DD HH:MM:SS' in UTC; default: the database's own UTC_TIMESTAMP(). Test seam. */
  now?: string;
  /** Replaces the measured database size. Test seam (T-F10). */
  sizeBytes?: number;
  /** Run ANALYZE TABLE on the other tables before measuring (default true; the API may cache the answer instead of asking every time). */
  analyze?: boolean;
}
/** I12 and the dashboard line of spec section 12 (read only). */
export function readHealth(conn: Connection, opts?: HealthOptions): Promise<Health>;
