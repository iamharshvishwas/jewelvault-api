import { randomUUID } from 'node:crypto';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { installUserRates } from '../../src/auth/throttle';
import { limits } from '../../src/limits';
import { DB_RED_LINE_BYTES } from '../../src/reads/health';
import { registerPhotoRoutes } from '../../src/photos/routes';
import { type World, makeWorld } from './cells';
import { TEST_ORIGIN } from './support';
import { type EditWorld, addDesign, auditRows, body, detailsOf, editWorld, patch, stampOf } from './edit-support';
import { codeOf, countPhotoRows, jpeg, json, photoRows, png, read, readUrl, remove, sha256, upload, uploadUrl, uploadWhole, webp } from './photo-support';
import { createDesign, designPayload, errorField } from './stock-support';

// T-D21 (P1 to P3, D26, A5) over HTTP, with the real routes on a scratch database: what an upload accepts and refuses, who may upload and remove, the rows as the table holds them, the public read,
// the owner's removal as a tombstone, and the attach checks of X8 and the design PATCH (T-C03 clause) with photos that were really uploaded. The caps of P2 (60 photos, 100 MB, the red size
// line) have their own worlds below, because they count the whole database. The PhotoStore contract and the SQL twins are in photo-store.test.ts, the throttle rows (T-D24) in photo-throttle.test.ts.

const MIB = 1024 * 1024;

describe('T-D21 photos: upload, read, removal', () => {
  let w: EditWorld;
  beforeAll(async () => {
    w = await editWorld('photos');
    // the rate of 30 uploads a minute is the subject of photo-throttle.test.ts; with the clock of the world standing still, these tests would use it up
    installUserRates(w.world.app, { photoUpload: { limit: 1_000_000, windowMs: 60_000 }, everything: { limit: 1_000_000, windowMs: 60_000 } });
  }, 120_000);
  afterAll(async () => {
    await w?.world.close();
  });

  describe('what an upload accepts and refuses (P1)', () => {
    it('a non-image sent as an image is 415 JV_UNSUPPORTED_MEDIA_TYPE, whatever type it declares, and nothing is stored', async () => {
      const design = await addDesign(w);
      const before = await countPhotoRows(w);
      const text = Buffer.from('This is a text file that somebody renamed to photo.jpg. '.repeat(20));
      for (const type of ['image/jpeg', 'image/png', 'image/webp', 'application/octet-stream']) {
        const res = await upload(w, 'owner', design, randomUUID(), 'full', text, type);
        expect([res.statusCode, codeOf(res), type]).toEqual([415, 'JV_UNSUPPORTED_MEDIA_TYPE', type]);
      }
      expect(await countPhotoRows(w)).toBe(before);
    });

    it('a body that is not raw bytes at all, or no body, is 415 too', async () => {
      const design = await addDesign(w);
      for (const [type, payload] of [
        ['text/plain', 'plain words'],
        ['application/json', JSON.stringify({ photo: 'data:image/png;base64,AAAA' })],
        ['image/svg+xml', '<svg xmlns="http://www.w3.org/2000/svg"></svg>'],
        ['image/gif', 'GIF89a......'],
        [null, ''],
        ['image/jpeg', ''],
      ] as const) {
        const res = await upload(w, 'staff', design, randomUUID(), 'full', payload, type);
        expect([res.statusCode, codeOf(res), type]).toEqual([415, 'JV_UNSUPPORTED_MEDIA_TYPE', type]);
      }
    });

    it('a file over 2 MiB is 413 JV_PAYLOAD_TOO_LARGE: a 5 MB file, and one byte over 2 MiB (which the route\'s 16 KiB of room lets through to the check)', async () => {
      const design = await addDesign(w);
      const before = await countPhotoRows(w);
      for (const size of [5 * 1000 * 1000, limits.maxPhotoBytes + 1, limits.maxPhotoBytes + 16 * 1024]) {
        const res = await upload(w, 'owner', design, randomUUID(), 'full', jpeg(size));
        expect([res.statusCode, codeOf(res), size]).toEqual([413, 'JV_PAYLOAD_TOO_LARGE', size]);
      }
      expect(await countPhotoRows(w)).toBe(before);
    }, 60_000);

    it('exactly 2 MiB is stored (it fits the MEDIUMBLOB), byte for byte, with its sha256', async () => {
      const design = await addDesign(w);
      const id = randomUUID();
      const bytes = jpeg(limits.maxPhotoBytes);
      const res = await upload(w, 'owner', design, id, 'full', bytes);
      expect(res.statusCode).toBe(201);
      const [row] = await photoRows(w, id);
      expect(row.byte_size).toBe(limits.maxPhotoBytes);
      expect(Buffer.compare(row.bytes, bytes)).toBe(0);
      expect(row.sha.toLowerCase()).toBe(sha256(bytes));
      const back = await read(w, id, 'full');
      expect(back.statusCode).toBe(200);
      expect(Buffer.compare(back.rawPayload, bytes)).toBe(0);
    }, 60_000);

    it('JPEG, PNG and WebP are recognised by their first bytes: the table holds the type of the bytes, not the type the caller declared', async () => {
      const cases: [string, Buffer, string, string][] = [
        ['a JPEG', jpeg(), 'image/jpeg', 'image/jpeg'],
        ['a PNG', png(), 'image/png', 'image/png'],
        ['a WebP', webp(), 'image/webp', 'image/webp'],
        ['a PNG declared as a JPEG', png(), 'image/jpeg', 'image/png'],
        ['a WebP with no type but octet-stream', webp(), 'application/octet-stream', 'image/webp'],
      ];
      for (const [label, bytes, declared, stored] of cases) {
        const id = randomUUID();
        const design = await addDesign(w); // a design takes three photos, and these are five
        const res = await upload(w, 'owner', design, id, 'thumb', bytes, declared);
        expect([label, res.statusCode]).toEqual([label, 201]);
        expect(json(res)).toMatchObject({ photo_id: id, design_id: design, kind: 'thumb', mime: stored, byte_size: bytes.length, sha256: sha256(bytes) });
        expect((await photoRows(w, id))[0].mime).toBe(stored);
        expect((await read(w, id, 'thumb')).headers['content-type']).toBe(stored);
      }
    });

    it('anything whose first bytes are not one of the three is refused, also when the name or the type says image: GIF, BMP, a truncated signature, RIFF that is not WebP, WEBP in the wrong place', async () => {
      const design = await addDesign(w);
      const tail = Buffer.alloc(40, 7);
      const files: [string, Buffer][] = [
        ['GIF', Buffer.concat([Buffer.from('GIF89a'), tail])],
        ['BMP', Buffer.concat([Buffer.from('BM'), tail])],
        ['two bytes of a JPEG', Buffer.from([0xff, 0xd8])],
        ['a JPEG whose third byte is wrong', Buffer.concat([Buffer.from([0xff, 0xd8, 0xfe]), tail])],
        ['three bytes of a PNG', Buffer.from([0x89, 0x50, 0x4e])],
        ['RIFF that is a WAVE', Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x10, 0, 0, 0]), Buffer.from('WAVE'), tail])],
        ['RIFF with WEBP too late', Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x10, 0, 0, 0, 0]), Buffer.from('WEBP'), tail])],
        ['a RIFF header cut before WEBP', Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x10, 0, 0, 0]), Buffer.from('WEB')])],
      ];
      for (const [label, bytes] of files) {
        const res = await upload(w, 'owner', design, randomUUID(), 'full', bytes, 'image/jpeg');
        expect([label, res.statusCode, codeOf(res)]).toEqual([label, 415, 'JV_UNSUPPORTED_MEDIA_TYPE']);
      }
    });

    it('both ids must be lower-case UUIDs and the kind full or thumb, and nothing else is accepted in the query (S6, P2)', async () => {
      const design = await addDesign(w);
      const id = randomUUID();
      const bytes = jpeg();
      const bad = (res: LightMyRequestResponse, field: string) => {
        expect([res.statusCode, codeOf(res), errorField(res)]).toEqual([422, 'JV_INVALID_INPUT', field]);
      };
      bad(await upload(w, 'owner', 'not-a-uuid', id, 'full', bytes), 'design_id');
      bad(await upload(w, 'owner', design.toUpperCase(), id, 'full', bytes), 'design_id');
      bad(await upload(w, 'owner', design, 'not-a-photo', 'full', bytes), 'photo_id');
      bad(await upload(w, 'owner', design, id.toUpperCase(), 'full', bytes), 'photo_id');
      bad(await upload(w, 'owner', design, id, null, bytes), 'kind');
      bad(await upload(w, 'owner', design, id, 'big', bytes), 'kind');
      bad(await w.world.call('owner', 'PUT', `${uploadUrl(design, id, 'full')}&extra=1`, { payload: bytes, headers: { 'content-type': 'image/jpeg' } }), 'extra');
      expect(await photoRows(w, id)).toEqual([]);
    });
  });

  describe('who may upload (P3, A4)', () => {
    it('the owner and staff can add a photo; a biller cannot; a caller with no session cannot; a refused call stores nothing', async () => {
      const design = await addDesign(w);
      const before = await countPhotoRows(w);
      const owner = await upload(w, 'owner', design, randomUUID(), 'full', jpeg());
      const staff = await upload(w, 'staff', design, randomUUID(), 'full', jpeg());
      expect([owner.statusCode, staff.statusCode]).toEqual([201, 201]);
      expect(await countPhotoRows(w)).toBe(before + 2);
      const biller = await upload(w, 'biller', design, randomUUID(), 'full', jpeg());
      expect([biller.statusCode, codeOf(biller)]).toEqual([403, 'JV_FORBIDDEN']);
      for (const caller of ['anon', 'ended', 'expired', 'inactive'] as const) {
        const res = await upload(w, caller, design, randomUUID(), 'full', jpeg());
        expect([caller, res.statusCode]).toEqual([caller, 401]);
      }
      expect(await countPhotoRows(w)).toBe(before + 2);
    });

    it('the row records who uploaded it and when the table made it (created_by is the session user)', async () => {
      const design = await addDesign(w);
      const id = randomUUID();
      await upload(w, 'staff', design, id, 'full', jpeg());
      const [row] = await photoRows(w, id);
      expect(row.created_by).toBe(w.world.fixtures.staff.userId);
    });
  });

  describe('the rows are insert-only and a design has at most 3 photos (P2)', () => {
    it('an upload for a design id that does not exist yet is accepted (no foreign key), both kinds', async () => {
      const unborn = randomUUID();
      const id = randomUUID();
      expect((await upload(w, 'staff', unborn, id, 'full', jpeg())).statusCode).toBe(201);
      expect((await upload(w, 'staff', unborn, id, 'thumb', jpeg(200))).statusCode).toBe(201);
      const rows = await photoRows(w, id);
      expect(rows.map((r) => [r.kind, r.design_id])).toEqual([['full', unborn], ['thumb', unborn]]);
    });

    it('a repeated (photo id, kind) pair is 409 JV_NOT_ALLOWED and nothing is overwritten, while the thumbnail after the full image under one id is accepted', async () => {
      const design = await addDesign(w);
      const id = randomUUID();
      const first = jpeg(500);
      expect((await upload(w, 'owner', design, id, 'full', first)).statusCode).toBe(201);
      for (const caller of ['owner', 'staff'] as const) {
        const again = await upload(w, caller, design, id, 'full', jpeg(500));
        expect([caller, again.statusCode, codeOf(again)]).toEqual([caller, 409, 'JV_NOT_ALLOWED']);
      }
      const elsewhere = await upload(w, 'owner', randomUUID(), id, 'full', jpeg(500)); // the pair is the key, whatever design id comes with it
      expect([elsewhere.statusCode, codeOf(elsewhere)]).toEqual([409, 'JV_NOT_ALLOWED']);
      const [row] = await photoRows(w, id);
      expect(Buffer.compare(row.bytes, first)).toBe(0);
      expect(row.design_id).toBe(design);
      expect((await upload(w, 'staff', design, id, 'thumb', jpeg(200))).statusCode).toBe(201); // the 320 px thumbnail of a stored id
      expect((await upload(w, 'staff', design, id, 'thumb', jpeg(200))).statusCode).toBe(409);
    });

    it('the 4th photo for one design id is 409 JV_NOT_ALLOWED; the thumbnails of the three stored ids are still accepted; a removed photo does not count', async () => {
      const design = await addDesign(w);
      const ids: string[] = [];
      for (let i = 0; i < 3; i++) {
        const id = randomUUID();
        expect((await upload(w, 'staff', design, id, 'full', jpeg())).statusCode, `photo ${i + 1}`).toBe(201);
        ids.push(id);
      }
      const fourth = await upload(w, 'staff', design, randomUUID(), 'full', jpeg());
      expect([fourth.statusCode, codeOf(fourth)]).toEqual([409, 'JV_NOT_ALLOWED']);
      expect(detailsOf(fourth)).toMatchObject({ reason: 'design_full' });
      for (const id of ids) expect((await upload(w, 'staff', design, id, 'thumb', jpeg(150))).statusCode).toBe(201);
      expect((await remove(w, 'owner', ids[1])).statusCode).toBe(200);
      expect((await upload(w, 'staff', design, randomUUID(), 'full', jpeg())).statusCode).toBe(201); // the removed one made room
    });

    it('the count is of DISTINCT photo ids: a full image and its thumbnail are one photo', async () => {
      const design = await addDesign(w);
      await uploadWhole(w, 'owner', design);
      await uploadWhole(w, 'owner', design);
      const third = await uploadWhole(w, 'owner', design);
      expect([third.full.statusCode, third.thumb.statusCode]).toEqual([201, 201]); // 6 rows, 3 photos
      expect((await upload(w, 'owner', design, randomUUID(), 'full', jpeg())).statusCode).toBe(409);
    });

    it('the limit is per design id: another design id has its own three', async () => {
      const a = await addDesign(w);
      const b = await addDesign(w);
      for (let i = 0; i < 3; i++) await uploadWhole(w, 'owner', a);
      expect((await uploadWhole(w, 'owner', b)).full.statusCode).toBe(201);
    });
  });

  describe('the public read (P3, O11)', () => {
    it('needs no session and answers the bytes with the immutable cache headers, an ETag that is the sha256, nosniff and the cross-origin resource policy', async () => {
      const design = await addDesign(w);
      const full = jpeg(900);
      const thumb = png(300);
      const id = randomUUID();
      await upload(w, 'owner', design, id, 'full', full);
      await upload(w, 'owner', design, id, 'thumb', thumb, 'image/png');
      const a = await read(w, id, 'full');
      expect(a.statusCode).toBe(200);
      expect(Buffer.compare(a.rawPayload, full)).toBe(0);
      expect(a.headers['content-type']).toBe('image/jpeg');
      expect(a.headers['cache-control']).toBe('public, max-age=31536000, immutable');
      expect(a.headers.etag).toBe(`"${sha256(full)}"`);
      expect(a.headers['x-content-type-options']).toBe('nosniff');
      expect(a.headers['cross-origin-resource-policy']).toBe('cross-origin');
      expect(a.headers['set-cookie']).toBeUndefined();
      expect(a.headers['content-length']).toBe(String(full.length));
      const b = await read(w, id, 'thumb');
      expect(Buffer.compare(b.rawPayload, thumb)).toBe(0);
      expect([b.headers['content-type'], b.headers.etag]).toEqual(['image/png', `"${sha256(thumb)}"`]);
      expect(b.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    });

    it('does not care about a cookie: a dead session, a biller and the owner read the same photo (the website\'s <img> carries none)', async () => {
      const design = await addDesign(w);
      const id = randomUUID();
      await upload(w, 'owner', design, id, 'full', jpeg());
      for (const caller of ['anon', 'ended', 'expired', 'inactive', 'biller', 'owner'] as const) {
        const res = await w.world.call(caller, 'GET', readUrl(id, 'full'));
        expect([caller, res.statusCode]).toEqual([caller, 200]);
      }
    });

    it('HEAD answers the headers without the bytes', async () => {
      const design = await addDesign(w);
      const id = randomUUID();
      const bytes = jpeg(777);
      await upload(w, 'owner', design, id, 'full', bytes);
      const res = await w.world.app.inject({ method: 'HEAD', url: readUrl(id, 'full') });
      expect(res.statusCode).toBe(200);
      expect(res.headers.etag).toBe(`"${sha256(bytes)}"`);
      expect(res.rawPayload.length).toBe(0);
    });

    it('a photo nobody uploaded, a kind that was not uploaded, an id that is not a UUID and a kind that does not exist are 404 and are not cached', async () => {
      const design = await addDesign(w);
      const id = randomUUID();
      await upload(w, 'owner', design, id, 'full', jpeg()); // no thumbnail
      for (const url of [readUrl(randomUUID(), 'full'), readUrl(id, 'thumb'), readUrl('not-a-uuid', 'full'), readUrl(id.toUpperCase(), 'full'), readUrl(id, 'original')]) {
        const res = await w.world.app.inject({ method: 'GET', url });
        expect([url.slice(-12), res.statusCode, codeOf(res)]).toEqual([url.slice(-12), 404, 'JV_NOT_FOUND']);
        expect(res.headers['cache-control']).toBe('no-store');
        expect(res.headers.etag).toBeUndefined();
      }
    });
  });

  describe('the removal (P3, S7): a tombstone, by the owner alone', () => {
    it('only the owner removes: staff and a biller are 403, no session is 401, and the photo is still served', async () => {
      const design = await addDesign(w);
      const { id } = await uploadWhole(w, 'staff', design);
      for (const [caller, status, code] of [['staff', 403, 'JV_FORBIDDEN'], ['biller', 403, 'JV_FORBIDDEN'], ['anon', 401, 'JV_UNAUTHENTICATED']] as const) {
        const res = await remove(w, caller, id);
        expect([caller, res.statusCode, codeOf(res)]).toEqual([caller, status, code]);
      }
      expect((await read(w, id, 'full')).statusCode).toBe(200);
      expect((await photoRows(w, id)).every((r) => r.removed_at === null && r.bytes !== null)).toBe(true);
    });

    it('a removal keeps the row, empties the bytes of both kinds, keeps the size and the fingerprint, stamps the time of the API clock, and makes both reads 404', async () => {
      const design = await addDesign(w);
      const { id } = await uploadWhole(w, 'staff', design, randomUUID(), 800);
      const rowsBefore = await photoRows(w, id);
      const total = await countPhotoRows(w);
      const res = await remove(w, 'owner', id);
      expect(res.statusCode).toBe(200);
      expect(json(res)).toMatchObject({ photo_id: id, removed: true });
      expect(await countPhotoRows(w)).toBe(total);
      const rowsAfter = await photoRows(w, id);
      expect(rowsAfter).toHaveLength(2);
      for (const [i, row] of rowsAfter.entries()) {
        expect(row.bytes).toBeNull();
        expect(row.removed_at).not.toBeNull();
        expect(row.byte_size).toBe(rowsBefore[i].byte_size);
        expect(row.sha).toBe(rowsBefore[i].sha);
        expect(row.design_id).toBe(design);
      }
      const now = w.time.clock.read().timestamp;
      expect(String(rowsAfter[0].removed_at).slice(0, 10)).toBe(now.slice(0, 10));
      for (const kind of ['full', 'thumb']) {
        const gone = await read(w, id, kind);
        expect([kind, gone.statusCode, codeOf(gone)]).toEqual([kind, 404, 'JV_NOT_FOUND']);
        expect(gone.headers['cache-control']).toBe('no-store');
      }
    });

    it('is audited: one event row for the photo, with the owner as actor, and nothing about the bytes', async () => {
      const design = await addDesign(w);
      const { id } = await uploadWhole(w, 'owner', design);
      expect(await auditRows(w, 'design_photos', id)).toHaveLength(0); // an upload is not an audited change
      await remove(w, 'owner', id);
      const rows = await auditRows(w, 'design_photos', id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ action: 'event', actor: w.world.fixtures.owner.userId, actor_role: 'owner', table_name: 'design_photos', row_id: id });
      const facts = typeof rows[0].new_row === 'string' ? JSON.parse(rows[0].new_row) : rows[0].new_row;
      expect(facts).toMatchObject({ event: 'photo_removed', photo_id: id, design_id: design, kinds: ['full', 'thumb'] });
    });

    it('removing again changes nothing and writes no second audit row; an unknown photo is 404 JV_NOT_FOUND', async () => {
      const design = await addDesign(w);
      const { id } = await uploadWhole(w, 'owner', design);
      const first = await remove(w, 'owner', id);
      const again = await remove(w, 'owner', id);
      expect([first.statusCode, again.statusCode]).toEqual([200, 200]);
      expect(json(again).removed_at).toBe(json(first).removed_at);
      expect(await auditRows(w, 'design_photos', id)).toHaveLength(1);
      const unknown = await remove(w, 'owner', randomUUID());
      expect([unknown.statusCode, codeOf(unknown)]).toEqual([404, 'JV_NOT_FOUND']);
      const malformed = await w.world.call('owner', 'POST', '/v1/photos/not-a-uuid/remove');
      expect([malformed.statusCode, codeOf(malformed)]).toEqual([404, 'JV_NOT_FOUND']);
    });

    it('takes no body, and does not touch the design that lists the photo (the owner takes it out of photo_ids with an ordinary edit)', async () => {
      const design = await addDesign(w);
      const { id } = await uploadWhole(w, 'owner', design);
      const stamp = await stampOf(w, 'designs', design);
      const attached = await patch(w, 'owner', 'designs', design, stamp, { photo_ids: [id] });
      expect(attached.statusCode).toBe(200);
      const withBody = await w.world.call('owner', 'POST', `/v1/photos/${id}/remove`, { payload: { reason: 'x' } });
      expect([withBody.statusCode, codeOf(withBody)]).toEqual([422, 'JV_INVALID_INPUT']);
      expect((await remove(w, 'owner', id)).statusCode).toBe(200);
      const row = body(await patch(w, 'owner', 'designs', design, body(attached).row.updated_at, { name: 'Renamed' })).row;
      expect(row.photo_ids).toEqual([id]); // still listed: removing a photo is not editing the design
    });

    it('a removed photo cannot be uploaded again under its id (the pair is still the key)', async () => {
      const design = await addDesign(w);
      const { id } = await uploadWhole(w, 'owner', design);
      await remove(w, 'owner', id);
      const again = await upload(w, 'owner', design, id, 'full', jpeg());
      expect([again.statusCode, codeOf(again)]).toEqual([409, 'JV_NOT_ALLOWED']);
    });
  });

  describe('nothing is deleted, nothing lists the bytes', () => {
    it('DELETE has no route, on any of the photo addresses', async () => {
      const design = await addDesign(w);
      const { id } = await uploadWhole(w, 'owner', design);
      for (const url of [readUrl(id, 'full'), readUrl(id, 'thumb'), `/v1/photos/${id}`, `/v1/photos/${id}/remove`, uploadUrl(design, id, 'full'), `/v1/designs/${design}/photos/${id}`, `/v1/designs/${design}/photos`]) {
        const res = await w.world.call('owner', 'DELETE', url);
        expect([url, res.statusCode, codeOf(res)]).toEqual([url, 404, 'JV_NOT_FOUND']);
      }
      expect(w.world.app.routeTable.filter((r) => r.method === ('DELETE' as string))).toEqual([]);
      expect((await read(w, id, 'full')).statusCode).toBe(200);
    });

    it('the photo calls are exactly the three rows of the matrix and the two public reads', () => {
      const photo = w.world.app.routeTable.filter((r) => /photo/.test(r.url));
      expect(photo.map((r) => `${r.method} ${r.url} ${r.kind}`).sort()).toEqual(
        ['GET /v1/photos/:photo_id/full public', 'GET /v1/photos/:photo_id/thumb public', 'POST /v1/photos/:photo_id/remove matrix', 'PUT /v1/designs/:design_id/photos/:photo_id matrix'].sort(),
      );
    });
  });

  describe('the attach checks of X8 and the design PATCH with photos that were really uploaded (P2 (a) to (e), A5; T-C03 clause)', () => {
    it('X8 accepts the ids of whole photos uploaded for this design id, and refuses an unknown id, another design\'s photo, a photo with one kind and a removed photo: JV_INVALID_INPUT on design.photo_ids', async () => {
      const designId = randomUUID();
      const good = (await uploadWhole(w, 'staff', designId)).id;
      const other = (await uploadWhole(w, 'staff', randomUUID())).id; // belongs to another design id
      const fullOnly = randomUUID();
      await upload(w, 'staff', designId, fullOnly, 'full', jpeg());
      const thumbOnly = randomUUID();
      await upload(w, 'staff', designId, thumbOnly, 'thumb', jpeg());
      const removed = (await uploadWhole(w, 'staff', designId)).id;
      await remove(w, 'owner', removed);
      const attempt = (ids: string[], design = designId) => createDesign(w, 'staff', designPayload(w, { design_id: design, design: { photo_ids: ids } }));
      for (const [label, ids] of [
        ['an unknown id', [randomUUID()]],
        ["another design's photo", [other]],
        ['a photo with the full image only', [fullOnly]],
        ['a photo with the thumbnail only', [thumbOnly]],
        ['a removed photo', [removed]],
        ['one good and one bad', [good, other]],
      ] as const) {
        const res = await attempt([...ids]);
        expect([label, res.statusCode, codeOf(res), errorField(res)]).toEqual([label, 422, 'JV_INVALID_INPUT', 'design.photo_ids']);
      }
      const ok = await attempt([good]);
      expect(ok.statusCode).toBe(201);
      expect(body(ok).design).toMatchObject({ photo_ids: [good], primary_photo_id: good });
    });

    it('the PATCH of a design checks the same: a staff caller may ADD ids at the end and never remove, reorder or replace one; the owner may do all four', async () => {
      const design = await addDesign(w);
      const [a, b, c] = [(await uploadWhole(w, 'staff', design)).id, (await uploadWhole(w, 'staff', design)).id, (await uploadWhole(w, 'staff', design)).id];
      let stamp = await stampOf(w, 'designs', design);
      const edit = async (caller: 'staff' | 'owner', ids: string[]) => {
        const res = await patch(w, caller, 'designs', design, stamp, { photo_ids: ids });
        if (res.statusCode === 200) stamp = body(res).row.updated_at;
        return res;
      };
      expect((await edit('staff', [a])).statusCode).toBe(200); // adding one is accepted
      expect((await edit('staff', [a, b])).statusCode).toBe(200);
      for (const [label, ids] of [
        ['removing one', [a]],
        ['reordering', [b, a]],
        ['replacing one', [a, c]],
        ['emptying the list', []],
      ] as const) {
        const res = await edit('staff', [...ids]);
        expect([label, res.statusCode, codeOf(res)]).toEqual([label, 422, 'JV_INVALID_INPUT']);
      }
      expect((await edit('staff', [a, b, c])).statusCode).toBe(200);
      expect((await edit('owner', [c, a])).statusCode).toBe(200); // the owner reorders and removes in one edit
      expect((await edit('owner', [a, b])).statusCode).toBe(200); // and replaces
    });

    it('the PATCH refuses to add a photo that has one kind, belongs to another design id or was removed (the same JV_INVALID_INPUT)', async () => {
      const design = await addDesign(w);
      const fullOnly = randomUUID();
      await upload(w, 'staff', design, fullOnly, 'full', jpeg());
      const foreign = (await uploadWhole(w, 'staff', randomUUID())).id;
      const removed = (await uploadWhole(w, 'staff', design)).id;
      await remove(w, 'owner', removed);
      const stamp = await stampOf(w, 'designs', design);
      for (const [label, id] of [['one kind', fullOnly], ['another design', foreign], ['removed', removed], ['unknown', randomUUID()]] as const) {
        const res = await patch(w, 'staff', 'designs', design, stamp, { photo_ids: [id] });
        expect([label, res.statusCode, codeOf(res)]).toEqual([label, 422, 'JV_INVALID_INPUT']);
      }
    });
  });
});

describe('T-D21 the caps of P2: 60 unattached photos (O56)', () => {
  let w: EditWorld;
  beforeAll(async () => {
    w = await editWorld('photocaps');
    // 60 uploads in a minute are not the thing under test here (T-D24 has the rate): the user rate is lifted for this world
    installUserRates(w.world.app, { photoUpload: { limit: 1_000_000, windowMs: 60_000 } });
  }, 120_000);
  afterAll(async () => {
    await w?.world.close();
  });

  it('the 61st unattached photo is 409 JV_NOT_ALLOWED; the thumbnail of a stored unattached id, and an upload for a design that exists, are not', async () => {
    const stored: string[] = [];
    for (let i = 0; i < limits.maxUnattachedPhotos; i++) {
      const id = randomUUID();
      const res = await upload(w, 'staff', randomUUID(), id, 'full', jpeg(100));
      expect([i + 1, res.statusCode]).toEqual([i + 1, 201]);
      stored.push(id);
    }
    const sixtyFirst = await upload(w, 'staff', randomUUID(), randomUUID(), 'full', jpeg(100));
    expect([sixtyFirst.statusCode, codeOf(sixtyFirst)]).toEqual([409, 'JV_NOT_ALLOWED']);
    expect(detailsOf(sixtyFirst)).toMatchObject({ reason: 'unattached_count' });
    const thumb = await upload(w, 'staff', (await photoRows(w, stored[0]))[0].design_id, stored[0], 'thumb', jpeg(60));
    expect(thumb.statusCode).toBe(201);
    const real = await addDesign(w);
    expect((await upload(w, 'staff', real, randomUUID(), 'full', jpeg(100))).statusCode).toBe(201); // a photo of a design that exists is not "unattached"
    // the owner removes one: its place is free again (the bytes are gone and the tombstone does not count)
    expect((await remove(w, 'owner', stored[1])).statusCode).toBe(200);
    expect((await upload(w, 'staff', randomUUID(), randomUUID(), 'full', jpeg(100))).statusCode).toBe(201);
    expect((await upload(w, 'staff', randomUUID(), randomUUID(), 'full', jpeg(100))).statusCode).toBe(409);
  }, 120_000);
});

describe('T-D21 the byte cap of P2: the 101st megabyte', () => {
  let w: EditWorld;
  beforeAll(async () => {
    w = await editWorld('photobytes');
    installUserRates(w.world.app, { photoUpload: { limit: 1_000_000, windowMs: 60_000 } });
  }, 120_000);
  afterAll(async () => {
    await w?.world.close();
  });

  it('100 MiB of unattached photos fit exactly; one byte more is 409 JV_NOT_ALLOWED, and an upload for a design that exists is not counted against it', async () => {
    // 49 files of 2 MiB typed in by SQL (the rows an earlier run of the screen would have left), then the 50th through the route
    for (let i = 0; i < 49; i++) {
      const bytes = jpeg(2 * MIB);
      await w.world.sql.query('INSERT INTO design_photos (id, kind, design_id, mime, byte_size, sha256, bytes) VALUES (?, ?, ?, ?, ?, ?, ?)', [randomUUID(), 'full', randomUUID(), 'image/jpeg', bytes.length, Buffer.from(sha256(bytes), 'hex'), bytes]);
    }
    const last = await upload(w, 'staff', randomUUID(), randomUUID(), 'full', jpeg(2 * MIB));
    expect(last.statusCode).toBe(201); // 100 MiB in all, exactly the cap
    const over = await upload(w, 'staff', randomUUID(), randomUUID(), 'full', jpeg(100));
    expect([over.statusCode, codeOf(over)]).toEqual([409, 'JV_NOT_ALLOWED']);
    expect(detailsOf(over)).toMatchObject({ reason: 'unattached_bytes' });
    const real = await addDesign(w);
    expect((await upload(w, 'staff', real, randomUUID(), 'full', jpeg(100))).statusCode).toBe(201);
  }, 180_000);
});

describe('T-D21 the red size line: no upload while the database is above 2 GB (P2, O46)', () => {
  let world: World;
  let size = 0;
  beforeAll(async () => {
    // the application's routes are left out and the photo routes are registered with the size of the database in the test's hand (the real size would take 2 GB of photos)
    world = await makeWorld({ label: 'photored', build: (app) => registerPhotoRoutes(app, { sizeBytes: () => size }) });
  }, 120_000);
  afterAll(async () => {
    await world?.close();
  });

  const put = (caller: 'owner' | 'staff', photoId = randomUUID()) =>
    world.call(caller, 'PUT', uploadUrl(randomUUID(), photoId, 'full'), { payload: jpeg(200), headers: { 'content-type': 'image/jpeg' } });

  it('exactly 2 GB is not red; one byte more refuses every upload with 409 JV_NOT_ALLOWED, from the owner as well as from staff', async () => {
    size = DB_RED_LINE_BYTES;
    expect((await put('staff')).statusCode).toBe(201);
    size = DB_RED_LINE_BYTES + 1;
    for (const caller of ['staff', 'owner'] as const) {
      const res = await put(caller);
      expect([caller, res.statusCode, codeOf(res)]).toEqual([caller, 409, 'JV_NOT_ALLOWED']);
      expect(detailsOf(res)).toMatchObject({ reason: 'database_full' });
    }
  });

  it('only the uploads stop: a photo is still read and the owner can still remove one (which is how the space comes back); under the line again, the upload works', async () => {
    size = 0;
    const id = randomUUID();
    expect((await put('owner', id)).statusCode).toBe(201);
    size = DB_RED_LINE_BYTES + 1;
    expect((await world.app.inject({ method: 'GET', url: readUrl(id, 'full') })).statusCode).toBe(200);
    expect((await put('owner')).statusCode).toBe(409);
    expect((await world.call('owner', 'POST', `/v1/photos/${id}/remove`)).statusCode).toBe(200);
    size = DB_RED_LINE_BYTES - 1;
    expect((await put('owner')).statusCode).toBe(201);
  });

  it('a refused upload stores nothing', async () => {
    size = DB_RED_LINE_BYTES + 5;
    const [before] = await world.sql.query<any[]>('SELECT COUNT(*) AS n FROM design_photos');
    await put('staff');
    const [after] = await world.sql.query<any[]>('SELECT COUNT(*) AS n FROM design_photos');
    expect(after[0].n).toBe(before[0].n);
  });
});

describe('T-D21 the raw-bytes parser belongs to the upload alone', () => {
  let w: EditWorld;
  beforeAll(async () => {
    w = await editWorld('photoparse');
  }, 120_000);
  afterAll(async () => {
    await w?.world.close();
  });

  it('the website\'s upload is a state-changing call from another origin: a preflight for PUT with Content-Type and the two headers is accepted, and without the CSRF headers the call is 403 JV_CSRF before anything is read (A12)', async () => {
    const design = randomUUID();
    const url = uploadUrl(design, randomUUID(), 'full');
    const pre = await w.world.app.inject({ method: 'OPTIONS', url, headers: { origin: TEST_ORIGIN, 'access-control-request-method': 'PUT', 'access-control-request-headers': 'content-type,x-jv-client' } });
    expect(pre.statusCode).toBe(204);
    expect(pre.headers['access-control-allow-origin']).toBe(TEST_ORIGIN);
    expect(String(pre.headers['access-control-allow-methods'])).toContain('PUT');
    const before = w.world.spy.sent.length;
    const bare = await w.world.app.inject({ method: 'PUT', url, headers: { cookie: w.world.cookieOf('owner')!, 'content-type': 'image/jpeg' }, payload: jpeg() });
    expect([bare.statusCode, codeOf(bare)]).toEqual([403, 'JV_CSRF']);
    expect(w.world.spy.sent.length).toBe(before); // not even the session was read
  });

  it('every other route that is sent an image type still answers 415 JV_UNSUPPORTED_MEDIA_TYPE, as it did before the parser existed', async () => {
    const design = await addDesign(w);
    for (const [method, url] of [['POST', '/v1/customers'], ['PATCH', `/v1/designs/${design}`], ['POST', '/v1/designs'], ['POST', `/v1/photos/${randomUUID()}/remove`]] as const) {
      for (const type of ['image/jpeg', 'image/png', 'image/webp', 'application/octet-stream']) {
        const res = await w.world.call('owner', method, url, { payload: jpeg(300), headers: { 'content-type': type } });
        expect([method, url.slice(0, 14), type, res.statusCode, codeOf(res)]).toEqual([method, url.slice(0, 14), type, 415, 'JV_UNSUPPORTED_MEDIA_TYPE']);
      }
    }
  });
});
