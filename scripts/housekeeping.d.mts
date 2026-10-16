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
export const LOCK_NAME_MAX: number;
/** `jv_tick:<database>` or `jv_dump:<database>`: lock names are server-wide in MariaDB, so the database name is part of them (RF5-3). Throws above 64 characters. */
export function jobLockName(conn: Connection, kind: 'tick' | 'dump'): Promise<string>;
/**
 * Runs fn only when nobody holds the job lock (GET_LOCK, timeout 0) and releases it in a finally. An error thrown by fn is rethrown with `destroyConnection = true`: destroy the pooled
 * connection instead of returning it. { ran: false } when the lock is taken.
 */
export function withJobLock<T>(conn: Connection, kind: 'tick' | 'dump', fn: () => Promise<T>): Promise<{ ran: false; name: string } | { ran: true; name: string; value: T; released: boolean }>;
