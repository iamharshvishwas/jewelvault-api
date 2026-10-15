import type { Connection } from 'mysql2/promise';

/** Where an export is written. One call to file() per output file; the job can pipe each into gzip, encryption and the upload. */
export interface Sink { file(path: string): { write(chunk: string): Promise<void>; close(): Promise<void> } }
/** Where an export is read from (restore). */
export interface Source { text(path: string): Promise<string>; lines(path: string): AsyncIterable<string> }
/** Photo bytes by (id, kind): the photo copy in the off-site bucket, a folder, or memory. */
export interface PhotoStore {
  put(id: string, kind: string, bytes: Buffer): Promise<{ key: string }>;
  get(id: string, kind: string): Promise<Buffer | null>;
}

export interface ColumnMeta { name: string; binary: boolean }
export interface TableMeta {
  name: string;
  create: string;
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
  /** Columns left out on purpose (the photo bytes: they travel through the photo copy). */
  excluded: Record<string, string[]>;
  tables: TableMeta[];
  views: { name: string; create: string }[];
  triggers: { name: string; table: string; create: string }[];
  /** Live photos (removed_at IS NULL) the export refers to; a restore needs the bytes of each. */
  live_photos: number;
}

export interface ExportOptions {
  /** Rows per keyset page. Default 1000. */
  pageSize?: number;
  /** Test seam: called after each table is read, so a test can commit a change while the export is in progress. */
  between?: (table: string) => Promise<void>;
}
/** B2: a full export of the data without the photo bytes, inside ONE REPEATABLE READ snapshot. The connection must not be inside a transaction. */
export function exportDatabase(conn: Connection, sink: Sink, opts?: ExportOptions): Promise<Manifest>;

export function memoryStore(): { files: Map<string, string>; sink: Sink; source: Source };
export function directoryStore(dir: string): { sink: Sink; source: Source };
export function memoryPhotos(): PhotoStore & { objects: Map<string, Buffer> };
export function directoryPhotos(dir: string): PhotoStore;

/** B2 (2): every live photo that has no row in sys_photo_copies is written to the store once, then recorded. Oldest first. */
export function copyPhotosOnce(conn: Connection, store: PhotoStore, opts?: { limit?: number }): Promise<{ copied: number; bytes: number; failed: { id: string; kind: string; error: string }[] }>;

/** Removes the DEFINER clause of a SHOW CREATE VIEW / TRIGGER statement (the account that made it may not exist where it is restored). */
export function stripDefiner(sql: string): string;
