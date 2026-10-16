import type { Connection } from 'mysql2/promise';
export const ERROR_LOG_PER_MINUTE: number;
export interface ErrorEntry { level: 'debug' | 'info' | 'warn' | 'error' | 'fatal'; code: string; message: string; request_id?: string | null; user_id?: string | null; detail?: Record<string, unknown> | null }
/** D25: at most 20 rows a minute for each code; beyond that the count goes into detail.suppressed of the row with seq 20. */
export function logError(conn: Connection, entry: ErrorEntry, opts?: { now?: Date }): Promise<{ written: boolean; suppressed?: boolean }>;
export function unattachedPhotos(conn: Connection): Promise<{ photos: number; bytes: number }>;
export interface PhotoInsert { id: string; kind: 'full' | 'thumb'; design_id: string; mime: string; bytes: Buffer; created_by?: string | null }
export interface PhotoCaps { perDesign: number; unattachedPhotos: number; unattachedBytes: number }
export function insertPhotoGuarded(conn: Connection, photo: PhotoInsert, caps: PhotoCaps): Promise<{ inserted: true } | { inserted: false; reason: 'design_full' | 'unattached_count' | 'unattached_bytes' }>;
/** U3: n = 0 and the window to now on every row of the scopes email, addr and any; the summary row is left alone. */
export function clearLoginCounters(conn: Connection): Promise<{ cleared: number }>;
/** U3 / O54: settings.last_pulled = { at, by, file, sha256 }. */
export function recordPull(conn: Connection, pull: { at: string; by: string; file: string; sha256: string }): Promise<{ recorded: boolean }>;
