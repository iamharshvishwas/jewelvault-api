import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { LightMyRequestResponse } from 'fastify';
import { type PhotoCaps, type PhotoKind, type PhotoSizes, type PhotoStore, type PhotoToPut, type PutOutcome, type RemoveOutcome, type StoredPhoto } from '../../src/photos/photoStore';
import type { CallerName } from './cells';
import type { EditWorld } from './edit-support';

// Shared by the tests of API17 (photos: T-D21, T-F10, and the clauses of T-D24, T-D02 and T-C03): images made of their first bytes, the calls with their headers, the rows as the table holds them, and
// a fake second PhotoStore (P7) that has to pass the same contract test as the in-database store.

// ------------------------------------------------------------------ files

const filler = (n: number, head: number[]): Buffer => {
  if (n < head.length) throw new Error('the file is shorter than its own header');
  return Buffer.concat([Buffer.from(head), randomBytes(n - head.length)]);
};

/** A JPEG as far as its first bytes go: FF D8 FF E0, then n - 4 bytes of noise. */
export const jpeg = (n = 600): Buffer => filler(n, [0xff, 0xd8, 0xff, 0xe0]);
/** A PNG as far as its first bytes go: 89 50 4E 47 0D 0A 1A 0A. */
export const png = (n = 600): Buffer => filler(n, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** A WebP as far as its first bytes go: RIFF, four bytes of size, WEBP, then noise. */
export const webp = (n = 600): Buffer => filler(n, [0x52, 0x49, 0x46, 0x46, 0x10, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]);
export const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

// ------------------------------------------------------------------ calls

export const uploadUrl = (designId: string, photoId: string, kind: string | null = 'full'): string => `/v1/designs/${designId}/photos/${photoId}${kind === null ? '' : `?kind=${kind}`}`;
export const readUrl = (photoId: string, kind: PhotoKind | string = 'full'): string => `/v1/photos/${photoId}/${kind}`;

/** PUT /v1/designs/{design_id}/photos/{photo_id}?kind= with the raw bytes (a call of the website's: the CSRF headers are added by the world). */
export function upload(
  w: EditWorld,
  caller: CallerName,
  designId: string,
  photoId: string,
  kind: PhotoKind | string | null,
  bytes: Buffer | string,
  contentType: string | null = 'image/jpeg',
  headers: Record<string, string> = {},
): Promise<LightMyRequestResponse> {
  return w.world.call(caller, 'PUT', uploadUrl(designId, photoId, kind), { payload: bytes as string, headers: { ...(contentType === null ? {} : { 'content-type': contentType }), ...headers } });
}

/** GET a photo with NO session: the call of the website's <img>. */
export function read(w: EditWorld, photoId: string, kind: PhotoKind | string = 'full', headers: Record<string, string> = {}): Promise<LightMyRequestResponse> {
  return w.world.app.inject({ method: 'GET', url: readUrl(photoId, kind), headers });
}

export function remove(w: EditWorld, caller: CallerName, photoId: string): Promise<LightMyRequestResponse> {
  return w.world.call(caller, 'POST', `/v1/photos/${photoId}/remove`);
}

/** A whole photo: the full image and its thumbnail under one new id. Returns the id and the answers. */
export async function uploadWhole(w: EditWorld, caller: CallerName, designId: string, photoId: string = randomUUID(), size = 600): Promise<{ id: string; full: LightMyRequestResponse; thumb: LightMyRequestResponse }> {
  const full = await upload(w, caller, designId, photoId, 'full', jpeg(size));
  const thumb = await upload(w, caller, designId, photoId, 'thumb', jpeg(Math.max(60, Math.floor(size / 4))));
  return { id: photoId, full, thumb };
}

export const json = <T = any>(res: LightMyRequestResponse): T => JSON.parse(res.body) as T;
export const codeOf = (res: LightMyRequestResponse): string | undefined => json<{ error?: { code: string } }>(res).error?.code;

// ------------------------------------------------------------------ rows

export async function photoRows(w: EditWorld, photoId: string): Promise<any[]> {
  const [rows] = await w.world.sql.query<any[]>('SELECT id, kind, design_id, mime, byte_size, HEX(sha256) AS sha, bytes, removed_at, created_by FROM design_photos WHERE id = ? ORDER BY kind', [photoId]);
  return rows;
}

export async function countPhotoRows(w: EditWorld): Promise<number> {
  const [rows] = await w.world.sql.query<any[]>('SELECT COUNT(*) AS n FROM design_photos');
  return Number(rows[0].n);
}

// ------------------------------------------------------------------ a second PhotoStore

const DEFAULT_CAPS: PhotoCaps = { perDesign: 3, unattachedPhotos: 60, unattachedBytes: 100 * 1024 * 1024 };

interface FakeRow {
  designId: string;
  mime: StoredPhoto['mime'];
  sha256: string;
  byteSize: number;
  bytes: Buffer | null;
  removedAt: string | null;
}

/**
 * A PhotoStore in memory: the second implementation of P7. It has to pass the same contract as the table (tests/api/photo-store.test.ts), which is what makes the interface the thing a store on an
 * outside bucket would have to meet. `designs` is the set of design ids that exist: a photo whose design id is not in it is unattached.
 */
export class FakePhotoStore implements PhotoStore {
  readonly designs = new Set<string>();
  private readonly rows = new Map<string, FakeRow>();
  private readonly key = (id: string, kind: string) => `${id}/${kind}`;

  private live(): [string, string, FakeRow][] {
    return [...this.rows].filter(([, r]) => r.removedAt === null).map(([k, r]) => [k.split('/')[0], k.split('/')[1], r]);
  }

  async put(photo: PhotoToPut, caps: PhotoCaps = DEFAULT_CAPS): Promise<PutOutcome> {
    const others = new Set(this.live().filter(([id, , r]) => r.designId === photo.designId && id !== photo.photoId).map(([id]) => id));
    if (others.size >= caps.perDesign) return { stored: false, reason: 'design_full' };
    if (!this.designs.has(photo.designId)) {
      const unattached = this.live().filter(([, , r]) => !this.designs.has(r.designId));
      if (new Set(unattached.filter(([id]) => id !== photo.photoId).map(([id]) => id)).size >= caps.unattachedPhotos) return { stored: false, reason: 'unattached_count' };
      if (unattached.reduce((sum, [, , r]) => sum + r.byteSize, 0) + photo.bytes.length > caps.unattachedBytes) return { stored: false, reason: 'unattached_bytes' };
    }
    if (this.rows.has(this.key(photo.photoId, photo.kind))) return { stored: false, reason: 'duplicate' };
    const digest = sha256(photo.bytes);
    this.rows.set(this.key(photo.photoId, photo.kind), { designId: photo.designId, mime: photo.mime, sha256: digest, byteSize: photo.bytes.length, bytes: Buffer.from(photo.bytes), removedAt: null });
    return { stored: true, sha256: digest, byteSize: photo.bytes.length };
  }

  get(photoId: string, kind: PhotoKind): Promise<StoredPhoto | null>;
  get(photoId: string, kind: PhotoKind, options: { sha256Only: true }): Promise<{ sha256: string } | null>;
  async get(photoId: string, kind: PhotoKind, options?: { sha256Only: true }): Promise<StoredPhoto | { sha256: string } | null> {
    const r = this.rows.get(this.key(photoId, kind));
    if (!r || r.removedAt !== null || r.bytes === null) return null;
    if (options?.sha256Only) return { sha256: r.sha256 };
    return { mime: r.mime, sha256: r.sha256, byteSize: r.byteSize, bytes: Buffer.from(r.bytes) };
  }

  async remove(photoId: string, at: string): Promise<RemoveOutcome> {
    const mine = [...this.rows].filter(([k]) => k.startsWith(`${photoId}/`));
    if (mine.length === 0) return { state: 'unknown' };
    const kinds = mine.map(([k]) => k.split('/')[1] as PhotoKind).sort();
    const designId = mine[0][1].designId;
    if (mine.every(([, r]) => r.removedAt !== null)) return { state: 'already_removed', designId, kinds, removedAt: mine[0][1].removedAt as string };
    for (const [, r] of mine) {
      if (r.removedAt === null) {
        r.removedAt = at;
        r.bytes = null;
      }
    }
    return { state: 'removed', designId, kinds, removedAt: at };
  }

  async sizes(): Promise<PhotoSizes> {
    const live = this.live();
    const unattached = live.filter(([, , r]) => !this.designs.has(r.designId));
    return {
      photos: new Set(live.map(([id]) => id)).size,
      bytes: live.reduce((sum, [, , r]) => sum + r.byteSize, 0),
      unattachedPhotos: new Set(unattached.map(([id]) => id)).size,
      unattachedBytes: unattached.reduce((sum, [, , r]) => sum + r.byteSize, 0),
    };
  }
}
