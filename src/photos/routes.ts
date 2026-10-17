// P1 to P3, P7, A13, D26 (API17): the photo routes.
//
//   PUT  /v1/designs/:design_id/photos/:photo_id?kind=full|thumb   upload one object of a photo (matrix row photo:upload; the owner and staff). The raw bytes are the body. Insert-only.
//   GET  /v1/photos/:photo_id/full  and  /thumb                    read one object, with NO session (the public list): immutable caching, ETag = sha256, nosniff, cross-origin resource policy.
//   POST /v1/photos/:photo_id/remove                                the removal (matrix row photo:remove; the owner alone): a tombstone, audited. A DELETE has no route.
//
// All of it goes through the PhotoStore (photoStore.ts); nothing here knows the table. What is checked, and in which order:
//   upload: the user's rate of 30 a minute and the matrix row are the route wrapper's (A13, A4); then both ids are lower-case UUIDs and the kind is full or thumb (422 JV_INVALID_INPUT); the body is
//   raw bytes (415 when it is anything else); 2 MiB at most (413 JV_PAYLOAD_TOO_LARGE; the route's body limit of 2 MiB and 16 KiB lets the last 16 KiB through to this check); the type is read from the
//   FIRST BYTES, never from the name or the declared type (415 JV_UNSUPPORTED_MEDIA_TYPE); the database size line must not be red (O46); then the store puts the object under the caps of P2 and the
//   rows are insert-only, and a refusal there is 409 JV_NOT_ALLOWED with the reason in details. The design need not exist yet: the screen uploads first, so there is no foreign key (D26).
//   read: the visitor's rate (600 a minute for each address, or 120 a second for all when the address cannot be trusted), then the ETag map: a repeated read with If-None-Match is a 304 without a
//   database read for a photo seen since the process started, a photo not yet seen costs one read of its sha256 (never of its bytes), a removed photo is 404 and never 304.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { THROTTLES, limiterOf, visitorAddress } from '../auth/limiter.js';
import { type TxContext, txContextFor, withRead } from '../db/tx.js';
import { JvError } from '../errors.js';
import { limits } from '../limits.js';
import { MATRIX } from '../permissions/matrix.js';
import { assertMayCall, route } from '../permissions/route.js';
import { DB_RED_LINE_BYTES } from '../reads/health.js';
import { UUID_TEXT, timestampToWire } from '../wire/format.js';
import * as wire from '../wire/zod.js';
import { EtagMap } from './etagMap.js';
import { type PhotoKind, type PhotoStore, type PutRefusal, createDbPhotoStore, sniffImage } from './photoStore.js';
import { readDbSizeBytes } from './sizeLine.js';

/** P3: a photo's id never changes its content, so a browser or a shared cache may keep it for a year. */
export const PHOTO_CACHE_CONTROL = 'public, max-age=31536000, immutable';

/** The declared types the raw-bytes parser takes. What the file IS is decided by its first bytes; a declared type that is none of these is 415 before the body is read. */
const RAW_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/octet-stream'];

export interface PhotoRouteOptions {
  /** A seam for tests: the database size in bytes, instead of reading it (O46: a size above 2 GB refuses every upload). server.ts never passes it. */
  sizeBytes?: () => number | Promise<number>;
  /** A seam for a second PhotoStore (P7). server.ts never passes it: the table is the store. */
  store?: (ctx: TxContext) => PhotoStore;
}

const etagMaps = new WeakMap<FastifyInstance, EtagMap>();

/** The application's one ETag map (A13). A new application is a new process: it starts empty. */
export function etagMapOf(app: FastifyInstance): EtagMap {
  let map = etagMaps.get(app);
  if (!map) etagMaps.set(app, (map = new EtagMap()));
  return map;
}

const unavailable = () => new JvError('JV_UNAVAILABLE', 'The service is not available. Try again in a moment.');
const notFound = () => new JvError('JV_NOT_FOUND', 'There is nothing at this address.');
const notAllowed = (message: string, details: Record<string, unknown>) => new JvError('JV_NOT_ALLOWED', message, { details });

const kindError = (issue: { input?: unknown }) => (issue.input === undefined ? 'is required' : 'must be full or thumb');
const uploadParams = wire.strictObject({ design_id: wire.uuid, photo_id: wire.uuid });
const uploadQuery = wire.strictObject({ kind: z.enum(['full', 'thumb'], { error: kindError }) });

const REFUSALS: Record<PutRefusal, string> = {
  duplicate: 'This photo was already uploaded. A photo is never overwritten: send the new one under a new photo id.',
  design_full: `A design can have at most ${limits.maxPhotosPerDesign} photos.`,
  unattached_count: `At most ${limits.maxUnattachedPhotos} photos can wait for a design to be saved. Save the designs you have started first.`,
  unattached_bytes: `At most ${Math.round(limits.maxUnattachedPhotoBytes / (1024 * 1024))} MB of photos can wait for a design to be saved. Save the designs you have started first.`,
};

/** A13: a repeated read with If-None-Match. Weak validators and lists count, and * matches any photo that exists (RFC 9110 13.1.2: the comparison for this header is the weak one). */
function matches(header: string | string[] | undefined, sha256: string): boolean {
  if (header === undefined) return false;
  const text = Array.isArray(header) ? header.join(',') : header;
  if (text.trim() === '*') return true;
  return text.split(',').some((tag) => tag.trim().replace(/^W\//, '') === `"${sha256}"`);
}

/** A13: 600 a minute for each trusted address; with an address that cannot be trusted, 120 a second for the whole API (a stranger writing the header must not get a fresh bucket each time). */
function throttleRead(app: FastifyInstance, headers: Record<string, unknown>): void {
  const visitor = visitorAddress(headers);
  const limiter = limiterOf(app);
  if (visitor.trusted) limiter.require(`photo-read:${visitor.key}`, THROTTLES.photoReadPerAddress);
  else limiter.require('photo-read:untrusted', THROTTLES.photoReadUntrusted);
}

function notModified(reply: FastifyReply, sha256: string): FastifyReply {
  return reply.code(304).header('ETag', `"${sha256}"`).header('Cache-Control', PHOTO_CACHE_CONTROL).send();
}

export function registerPhotoRoutes(app: FastifyInstance, options: PhotoRouteOptions = {}): void {
  const storeOf = options.store ?? createDbPhotoStore;
  const contextOf = (a: FastifyInstance, request: FastifyRequest, actor: { id: string; role: string } | null): TxContext => {
    if (!a.db) throw unavailable();
    return txContextFor(a.db, request, actor);
  };

  // The upload's body is raw bytes. The parser answers only the photo upload: any other route that is sent one of these types keeps the 415 it had before. Parsing happens after the route's onRequest
  // hooks (the session, the rate, the matrix row), so a caller who is refused never has the body read.
  const uploadPath = MATRIX['photo:upload'].path;
  app.addContentTypeParser(RAW_TYPES, { parseAs: 'buffer' }, (request, body, done) => {
    if (request.routeOptions?.url !== uploadPath) {
      done(Object.assign(new Error('Unsupported Media Type'), { code: 'FST_ERR_CTP_INVALID_MEDIA_TYPE', statusCode: 415 }));
      return;
    }
    done(null, body);
  });

  route(app, {
    action: 'photo:upload',
    body: z.unknown(), // the bytes; whether they are bytes at all is judged below, so that "not an image" is 415 and not a 422 about a body
    handler: async ({ app: a, request, reply, auth, body }) => {
      assertMayCall(auth.user.role, 'photo:upload');
      const ids = wire.parseInput(uploadParams, request.params);
      const { kind } = wire.parseInput(uploadQuery, request.query);
      if (!Buffer.isBuffer(body)) throw new JvError('JV_UNSUPPORTED_MEDIA_TYPE', 'Send the photo as a JPEG, PNG or WebP image: the raw bytes of the file are the body.');
      if (body.length > limits.maxPhotoBytes) throw new JvError('JV_PAYLOAD_TOO_LARGE', `A photo can be at most ${limits.maxPhotoBytes / (1024 * 1024)} MiB.`);
      const mime = sniffImage(body);
      if (mime === null) throw new JvError('JV_UNSUPPORTED_MEDIA_TYPE', 'This file is not a JPEG, PNG or WebP image.');
      const ctx = contextOf(a, request, { id: auth.user.id, role: auth.user.role });
      // O46, P2: whenever the size line is red the upload is refused (at 3 GB the plan stops billing)
      const size = options.sizeBytes ? await options.sizeBytes() : await withRead(ctx, (db) => readDbSizeBytes(db));
      if (size > DB_RED_LINE_BYTES) throw notAllowed('The database is nearly full, so no photo can be added now.', { reason: 'database_full' });
      const outcome = await storeOf(ctx).put({ photoId: ids.photo_id, kind: kind as PhotoKind, designId: ids.design_id, mime, bytes: body, createdBy: auth.user.id });
      if (!outcome.stored) throw notAllowed(REFUSALS[outcome.reason], { field: outcome.reason === 'duplicate' ? 'photo_id' : 'design_id', reason: outcome.reason });
      return reply.code(201).send({ photo_id: ids.photo_id, design_id: ids.design_id, kind, mime, byte_size: outcome.byteSize, sha256: outcome.sha256 });
    },
  });

  const read = async (a: FastifyInstance, request: FastifyRequest, reply: FastifyReply, kind: PhotoKind) => {
    throttleRead(a, request.headers);
    const photoId = (request.params as { photo_id?: unknown }).photo_id;
    if (typeof photoId !== 'string' || !UUID_TEXT.test(photoId)) throw notFound();
    const etags = etagMapOf(a);
    const conditional = request.headers['if-none-match'];
    const known = etags.get(photoId, kind);
    if (known !== undefined && matches(conditional, known)) return notModified(reply, known); // no database read
    const store = storeOf(contextOf(a, request, null));
    const token = etags.begin(); // a removal that commits while this read is under way must not be undone by it
    if (known === undefined && conditional !== undefined) {
      const head = await store.get(photoId, kind, { sha256Only: true });
      if (head === null) throw notFound();
      etags.set(token, photoId, kind, head.sha256);
      if (matches(conditional, head.sha256)) return notModified(reply, head.sha256);
    }
    const photo = await store.get(photoId, kind);
    if (photo === null) throw notFound();
    etags.set(token, photoId, kind, photo.sha256);
    return reply.type(photo.mime).header('ETag', `"${photo.sha256}"`).header('Cache-Control', PHOTO_CACHE_CONTROL).header('X-Content-Type-Options', 'nosniff').send(photo.bytes);
  };
  route(app, { public: 'photo-full', handler: ({ app: a, request, reply }) => read(a, request, reply, 'full') });
  route(app, { public: 'photo-thumb', handler: ({ app: a, request, reply }) => read(a, request, reply, 'thumb') });

  route(app, {
    action: 'photo:remove',
    handler: async ({ app: a, request, reply, auth }) => {
      assertMayCall(auth.user.role, 'photo:remove');
      const photoId = (request.params as { photo_id?: unknown }).photo_id;
      if (typeof photoId !== 'string' || !UUID_TEXT.test(photoId)) throw notFound();
      const etags = etagMapOf(a);
      let outcome;
      try {
        outcome = await storeOf(contextOf(a, request, { id: auth.user.id, role: auth.user.role })).remove(photoId, a.clock.read().timestamp);
      } finally {
        etags.drop(photoId); // after the commit (or after a failure whose outcome is not known): a removed photo is 404 and never 304
      }
      if (outcome.state === 'unknown') throw notFound();
      return reply.code(200).send({ photo_id: photoId, removed: true, removed_at: timestampToWire(outcome.removedAt) });
    },
  });
}
