import type { Connection } from 'mysql2/promise';

/** Where an export is written. One call to file() per output file. The job spools each file to disk, closes the snapshot, and only then gzips, encrypts and uploads (B2). */
export interface Sink { file(path: string): { write(chunk: string): Promise<void>; close(): Promise<void> } }
/** Where an export is read from (restore). */
export interface Source { text(path: string): Promise<string>; lines(path: string): AsyncIterable<string> }
/** The photo copy: objects named photos/<photo id>-<kind> in the off-site bucket, a folder, or memory. */
export interface PhotoStore {
  /** Upload once. A key that already exists with the same size and sha256 counts as success (R2 answers 412, B2). */
  put(id: string, kind: string, bytes: Buffer): Promise<void>;
  /** HEAD: the stored size, or null when there is no such object. A copy is recorded only after this confirms the size (D25). */
  head(id: string, kind: string): Promise<{ size: number } | null>;
  get(id: string, kind: string): Promise<Buffer | null>;
}

export interface ColumnMeta { name: string; binary: boolean }
export interface TableMeta {
  name: string;
  columns: ColumnMeta[];
  primary_key: string[];
  rows: number;
  file: string;
  sha256: string;
}
export interface Manifest {
  format: 'jewelvault-export-1';
  created_at: string;
  server: string;
  database: string;
  /** The migration files the database was built with (version, name, checksum). The export holds NO table definitions (B2): these files are the schema, and a restore refuses other ones. */
  migrations: { version: string; name: string; checksum: string }[];
  /** Columns left out on purpose (the photo bytes travel through the photo copy). */
  excluded: Record<string, string[]>;
  /** Tables not exported at all, and why. */
  omitted: Record<string, string>;
  /** Tables exported in part, and which part. */
  filtered: Record<string, string>;
  tables: TableMeta[];
  /** Live photos (removed_at IS NULL) the export refers to; a restore needs the bytes of each. */
  live_photos: number;
  /** The source database had triggers (the optional files of db/optional): a restore applies them last. */
  has_triggers: boolean;
}

export interface ExportOptions {
  /** Rows per keyset page. Default 1000. */
  pageSize?: number;
  /** Test seam: called after each table is read, so a test can commit a change while the export is in progress. */
  between?: (table: string) => Promise<void>;
}
/**
 * B2: a full export of the data without the photo bytes, inside ONE read-only snapshot (REPEATABLE READ, START TRANSACTION READ ONLY, WITH CONSISTENT SNAPSHOT).
 * Left out: sessions, sys_login_attempts, the rows of sys_idempotency older than 90 days, and the table definitions. The connection must not be inside a transaction.
 */
export function exportDatabase(conn: Connection, sink: Sink, opts?: ExportOptions): Promise<Manifest>;

export function memoryStore(): { files: Map<string, string>; sink: Sink; source: Source };
export function directoryStore(dir: string): { sink: Sink; source: Source };
export function memoryPhotos(): PhotoStore & { objects: Map<string, Buffer> };
export function directoryPhotos(dir: string): PhotoStore;

/**
 * B2 (2): every live photo that has no row in sys_photo_copies is uploaded once (oldest first), the store is asked for its size (HEAD), and only when it equals the
 * recorded size is the copy remembered. A failed upload or a wrong size records nothing and does not stop the others.
 */
export function copyPhotosOnce(conn: Connection, store: PhotoStore, opts?: { limit?: number }): Promise<{ copied: number; bytes: number; failed: { id: string; kind: string; error: string }[] }>;
