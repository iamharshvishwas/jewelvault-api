// P1, P2, P3, P7, D26 (API17): the PhotoStore. ALL photo code goes through this one interface (put, get, remove, sizes); the routes know nothing of the table. There is one implementation, the table
// design_photos (createDbPhotoStore), and a second one on an outside bucket could take its place without touching a route if Siddhi's catalogue turns out larger than the budget of P5 (O47).
// tests/api/photo-store.test.ts runs ONE contract test against the in-database store and against a fake, so the interface is what a second store has to pass.
import { createHash } from 'node:crypto';
import { withAutocommit } from '../db/autocommit.js';
import { writeEvent } from '../db/events.js';
import { type TxContext, withRead, withTx } from '../db/tx.js';
import { duplicateKeyName } from '../errors.js';
import { type Limits, limits } from '../limits.js';
import { P2_INSERT_TEXT, P2_UNATTACHED_TEXT } from './queries.js';

export type PhotoKind = 'full' | 'thumb';
export const PHOTO_KINDS: readonly PhotoKind[] = Object.freeze(['full', 'thumb'] as const);
export type PhotoMime = 'image/jpeg' | 'image/png' | 'image/webp';

/** P2: the caps of one upload. The defaults of the application are `photoCaps`. */
export interface PhotoCaps {
  /** fewer than this many DISTINCT live photo ids may already be stored for the design id */
  perDesign: number;
  /** a design id that is not a design yet: fewer than this many unattached photos ... */
  unattachedPhotos: number;
  /** ... and the unattached bytes plus this photo within this many */
  unattachedBytes: number;
}

export function photoCapsOf(limits: Pick<Limits, 'maxPhotosPerDesign' | 'maxUnattachedPhotos' | 'maxUnattachedPhotoBytes'>): PhotoCaps {
  return Object.freeze({ perDesign: limits.maxPhotosPerDesign, unattachedPhotos: limits.maxUnattachedPhotos, unattachedBytes: limits.maxUnattachedPhotoBytes });
}

export interface PhotoToPut {
  photoId: string;
  kind: PhotoKind;
  /** the design the screen will attach the photo to; it need not exist yet (no foreign key, D26) */
  designId: string;
  mime: PhotoMime;
  bytes: Buffer;
  createdBy: string | null;
}

/** Why a photo was not stored: the pair is taken (insert-only), the design has its photos, or the unattached photos are at their caps. */
export type PutRefusal = 'duplicate' | 'design_full' | 'unattached_count' | 'unattached_bytes';
export type PutOutcome = { stored: true; sha256: string; byteSize: number } | { stored: false; reason: PutRefusal };

export interface StoredPhoto {
  mime: PhotoMime;
  /** the hex of the SHA-256 of the bytes as uploaded: the ETag */
  sha256: string;
  byteSize: number;
  bytes: Buffer;
}

export type RemoveOutcome =
  | { state: 'removed' | 'already_removed'; designId: string; kinds: PhotoKind[]; removedAt: string }
  | { state: 'unknown' };

export interface PhotoSizes {
  /** live photos (distinct ids) and their bytes */
  photos: number;
  bytes: number;
  /** live photos whose design id is not a design (P2): the figures the caps are judged by */
  unattachedPhotos: number;
  unattachedBytes: number;
}

export interface PhotoStore {
  /** Stores one photo object (a full image or its thumbnail) if the caps allow it; the rows are insert-only. */
  put(photo: PhotoToPut, caps?: PhotoCaps): Promise<PutOutcome>;
  /** One object, or null when there is none or it was removed. `sha256Only` reads the fingerprint and never the bytes (A13: a 304 needs nothing else). */
  get(photoId: string, kind: PhotoKind): Promise<StoredPhoto | null>;
  get(photoId: string, kind: PhotoKind, options: { sha256Only: true }): Promise<{ sha256: string } | null>;
  /** Removes both kinds of a photo: a tombstone, the row stays and the bytes go (P3, S7). `at` is the API clock's reading as DATETIME(6) text. Removing a removed photo changes nothing. */
  remove(photoId: string, at: string): Promise<RemoveOutcome>;
  sizes(): Promise<PhotoSizes>;
}

/** P1: the type of a file from its FIRST BYTES (JPEG FF D8 FF, PNG 89 50 4E 47, WebP RIFF....WEBP), never from its name or from the type the caller declared. */
export function sniffImage(bytes: Uint8Array): PhotoMime | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  // RIFF, four bytes of length, WEBP
  if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp';
  return null;
}

/** The application's caps (P1, P2, O56), from src/limits.ts. */
export const photoCaps: PhotoCaps = photoCapsOf(limits);

const hex = (value: unknown): string => Buffer.from(value as Buffer).toString('hex');

/** The (photo id, kind) pair is the primary key of design_photos: a second row for it is error 1062 on PRIMARY. withAutocommit has already mapped the driver's error, which it keeps as the cause. */
function isDuplicatePair(e: unknown): boolean {
  for (let x = e as { errno?: number; cause?: unknown } | undefined, depth = 0; x && depth < 3; x = x.cause as typeof x, depth++) {
    if (x.errno === 1062 && duplicateKeyName(x) === 'PRIMARY') return true;
  }
  return false;
}

/** The in-database PhotoStore: one implementation on the table design_photos (D26). It is bound to the context of one call (the deadline and the actor of that request). */
class DbPhotoStore implements PhotoStore {
  constructor(private readonly ctx: TxContext) {}

  async put(photo: PhotoToPut, caps: PhotoCaps = photoCaps): Promise<PutOutcome> {
    const digest = createHash('sha256').update(photo.bytes).digest('hex');
    try {
      return await withAutocommit(this.ctx, async (db): Promise<PutOutcome> => {
        // P2: the count and the insert are ONE statement (the text of db/queries/P2_insert_photo.sql); zero rows affected means refused, and the reads below say why
        const done = await db.run(P2_INSERT_TEXT, [
          photo.photoId, photo.kind, photo.designId, photo.mime, photo.bytes.length, digest, photo.bytes, photo.createdBy,
          photo.designId, photo.photoId, caps.perDesign,
          photo.designId,
          photo.photoId, caps.unattachedPhotos, photo.bytes.length, caps.unattachedBytes,
        ]);
        if (done.affectedRows === 1) return { stored: true, sha256: digest, byteSize: photo.bytes.length };
        const [others] = await db.rows<{ n: number | string }>('SELECT COUNT(DISTINCT id) AS n FROM design_photos WHERE design_id = ? AND removed_at IS NULL AND id <> ?', [photo.designId, photo.photoId]);
        if (Number(others.n) >= caps.perDesign) return { stored: false, reason: 'design_full' };
        const [unattached] = await db.rows<{ photos: number | string }>(P2_UNATTACHED_TEXT);
        if (Number(unattached.photos) >= caps.unattachedPhotos) return { stored: false, reason: 'unattached_count' };
        return { stored: false, reason: 'unattached_bytes' };
      });
    } catch (e) {
      if (isDuplicatePair(e)) return { stored: false, reason: 'duplicate' };
      throw e;
    }
  }

  get(photoId: string, kind: PhotoKind): Promise<StoredPhoto | null>;
  get(photoId: string, kind: PhotoKind, options: { sha256Only: true }): Promise<{ sha256: string } | null>;
  async get(photoId: string, kind: PhotoKind, options?: { sha256Only: true }): Promise<StoredPhoto | { sha256: string } | null> {
    if (options?.sha256Only) {
      const rows = await withRead(this.ctx, (db) => db.rows<{ sha256: Buffer }>('SELECT sha256 FROM design_photos WHERE id = ? AND kind = ? AND removed_at IS NULL', [photoId, kind]));
      return rows.length === 0 ? null : { sha256: hex(rows[0].sha256) };
    }
    const rows = await withRead(this.ctx, (db) =>
      db.rows<{ mime: PhotoMime; sha256: Buffer; byte_size: number; bytes: Buffer }>('SELECT mime, sha256, byte_size, bytes FROM design_photos WHERE id = ? AND kind = ? AND removed_at IS NULL', [photoId, kind]),
    );
    if (rows.length === 0) return null;
    return { mime: rows[0].mime, sha256: hex(rows[0].sha256), byteSize: Number(rows[0].byte_size), bytes: rows[0].bytes };
  }

  async remove(photoId: string, at: string): Promise<RemoveOutcome> {
    return withTx(this.ctx, async (tx): Promise<RemoveOutcome> => {
      const rows = await tx.rows<{ kind: PhotoKind; design_id: string; removed_at: string | null }>('SELECT kind, design_id, removed_at FROM design_photos WHERE id = ? ORDER BY kind FOR UPDATE', [photoId]);
      if (rows.length === 0) return { state: 'unknown' };
      const kinds = rows.map((r) => r.kind);
      const designId = rows[0].design_id;
      const taken = rows.find((r) => r.removed_at !== null);
      if (rows.every((r) => r.removed_at !== null)) return { state: 'already_removed', designId, kinds, removedAt: taken!.removed_at as string };
      // S7: nothing is deleted. The row stays; removed_at is set and the bytes are emptied in the same statement (the CHECK of D26 allows no other state), which frees the space for new photos.
      await tx.run('UPDATE design_photos SET removed_at = ?, bytes = NULL WHERE id = ? AND removed_at IS NULL', [at, photoId]);
      await writeEvent(tx, { table: 'design_photos', rowId: photoId, facts: { event: 'photo_removed', photo_id: photoId, design_id: designId, kinds } });
      return { state: 'removed', designId, kinds, removedAt: at };
    });
  }

  async sizes(): Promise<PhotoSizes> {
    return withRead(this.ctx, async (db) => {
      const [live] = await db.rows<{ photos: number | string; total: string }>('SELECT COUNT(DISTINCT id) AS photos, CAST(COALESCE(SUM(byte_size), 0) AS CHAR) AS total FROM design_photos WHERE removed_at IS NULL');
      const [unattached] = await db.rows<{ photos: number | string; bytes: string }>(P2_UNATTACHED_TEXT);
      return { photos: Number(live.photos), bytes: Number(live.total), unattachedPhotos: Number(unattached.photos), unattachedBytes: Number(unattached.bytes) };
    });
  }
}

/** The PhotoStore of a call: the table design_photos, with the deadline and the actor of `ctx`. */
export function createDbPhotoStore(ctx: TxContext): PhotoStore {
  return new DbPhotoStore(ctx);
}
