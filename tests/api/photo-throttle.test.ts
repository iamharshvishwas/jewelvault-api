import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { THROTTLES } from '../../src/auth/limiter';
import { etagMapOf } from '../../src/photos/routes';
import { type EditWorld, addDesign, editWorld } from './edit-support';
import { codeOf, countPhotoRows, jpeg, read, remove, sha256, upload, uploadWhole } from './photo-support';

// T-D24 (A13), the rows that belong to the photo routes and are proved where the routes are built: the upload (30 a minute for each user; the wrapper applies the row, API08), the read of a photo with
// no session (600 a minute for each address, or a global 120 a second when the address cannot be trusted), and the ETag map: a repeated read with If-None-Match is a 304 without a database read for a
// photo seen since the process started, a photo not yet seen costs one read of its sha256 and never of its bytes, and a removed photo is 404 and never 304.

const SECOND = 1_000_000n;
const MINUTE = 60n * SECOND;
const quiet = (statements: string[]) => statements.filter((q) => !/^SET SESSION\b/i.test(q));
const retryAfter = (res: { headers: Record<string, unknown> }) => Number(res.headers['retry-after']);

describe('T-D24 photo upload: 30 a minute for each user (A13)', () => {
  let w: EditWorld;
  beforeAll(async () => {
    w = await editWorld('photoup');
  }, 120_000);
  afterAll(async () => {
    await w?.world.close();
  });

  it('the 31st upload in a minute by one user is 429 JV_RATE_LIMITED with Retry-After; the first 30 all go through (the row is applied once, not twice); nothing is stored for the 31st', async () => {
    const calls: number[] = [];
    for (let i = 0; i < THROTTLES.photoUpload.limit; i++) calls.push((await upload(w, 'staff', randomUUID(), randomUUID(), 'full', jpeg(100))).statusCode);
    expect(calls.every((s) => s === 201), JSON.stringify(calls)).toBe(true);
    const rows = await countPhotoRows(w);
    const over = await upload(w, 'staff', randomUUID(), randomUUID(), 'full', jpeg(100));
    expect([over.statusCode, codeOf(over)]).toEqual([429, 'JV_RATE_LIMITED']);
    expect(retryAfter(over)).toBeGreaterThanOrEqual(1);
    expect(retryAfter(over)).toBeLessThanOrEqual(60);
    expect(await countPhotoRows(w)).toBe(rows);
  });

  it('is counted for each user: the owner has 30 of their own, and an ordinary call of the limited user is not refused (it has its own row of 300 a minute)', async () => {
    const own = await upload(w, 'owner', randomUUID(), randomUUID(), 'full', jpeg(100));
    expect(own.statusCode).toBe(201);
    const staffRead = await w.world.call('staff', 'GET', '/v1/sync/categories');
    expect(staffRead.statusCode).toBe(200);
  });

  it('starts again with the next minute', async () => {
    w.time.time.micros += MINUTE + SECOND;
    const again = await upload(w, 'staff', randomUUID(), randomUUID(), 'full', jpeg(100));
    expect(again.statusCode).toBe(201);
  });
});

describe('T-D24 photo read: 600 a minute for each address, or 120 a second for all when the address cannot be trusted (A13)', () => {
  let w: EditWorld;
  let photo: string;
  let etag: string;
  beforeAll(async () => {
    w = await editWorld('photoread');
    const design = await addDesign(w);
    photo = (await uploadWhole(w, 'owner', design)).id;
    const first = await read(w, photo, 'full');
    etag = String(first.headers.etag);
    expect(first.statusCode).toBe(200);
  }, 120_000);
  afterAll(async () => {
    await w?.world.close();
  });

  const from = (address: string | null): Record<string, string> => (address === null ? {} : { 'x-real-ip': address });
  /** the cheap read: a 304 out of the map, so a few hundred of them cost no database read */
  const again = (address: string | null) => read(w, photo, 'full', { 'if-none-match': etag, ...from(address) });

  it('with an address that cannot be trusted (none, or not one address) the whole API shares 120 a second: the 121st read is 429 JV_RATE_LIMITED with Retry-After; a second later it is fine', async () => {
    w.time.time.micros += 5n * MINUTE; // a clean window
    const statuses: number[] = [];
    for (let i = 0; i < THROTTLES.photoReadUntrusted.limit; i++) statuses.push((await again(null)).statusCode);
    expect(statuses.every((s) => s === 304), JSON.stringify([...new Set(statuses)])).toBe(true);
    const over = await again(null);
    expect([over.statusCode, codeOf(over)]).toEqual([429, 'JV_RATE_LIMITED']);
    expect(retryAfter(over)).toBe(1);
    for (const junk of ['1.2.3.4, 5.6.7.8', 'not-an-address', '1.2.3.4:80']) expect((await again(junk)).statusCode, junk).toBe(429); // the same shared key
    w.time.time.micros += 2n * SECOND;
    expect((await again(null)).statusCode).toBe(304);
  });

  it('a 429 is a refusal like any other: no database read, and no ETag, no immutable caching, nothing of the photo', async () => {
    w.time.time.micros += 5n * MINUTE;
    for (let i = 0; i < THROTTLES.photoReadUntrusted.limit; i++) await again(null);
    const before = w.world.spy.sent.length;
    const over = await read(w, photo, 'full', from(null));
    expect(over.statusCode).toBe(429);
    expect(w.world.spy.sent.length).toBe(before);
    expect(over.headers.etag).toBeUndefined();
    expect(over.headers['cache-control']).toBe('no-store');
    expect(over.rawPayload.length).toBeLessThan(500);
  });

  it('with a trusted address (x-real-ip) each address has 600 a minute: the 601st from one address is 429, another address is not affected, and the global 120 a second does not apply', async () => {
    w.time.time.micros += 5n * MINUTE;
    const a = '203.0.113.7';
    const statuses: number[] = [];
    for (let i = 0; i < THROTTLES.photoReadPerAddress.limit; i++) statuses.push((await again(a)).statusCode);
    expect(statuses.every((s) => s === 304), JSON.stringify([...new Set(statuses)])).toBe(true); // 600 in one second: the per-second cap is for untrusted addresses only
    const over = await again(a);
    expect([over.statusCode, codeOf(over)]).toEqual([429, 'JV_RATE_LIMITED']);
    expect(retryAfter(over)).toBeGreaterThanOrEqual(1);
    expect(retryAfter(over)).toBeLessThanOrEqual(60);
    expect((await again('203.0.113.8')).statusCode).toBe(304);
    w.time.time.micros += MINUTE + SECOND;
    expect((await again(a)).statusCode).toBe(304);
  });

  it('an IPv6 address is counted by its first 64 bits: two addresses of one network share the 600', async () => {
    w.time.time.micros += 5n * MINUTE;
    for (let i = 0; i < 300; i++) await again('2001:db8:aaaa:1::1');
    for (let i = 0; i < 300; i++) await again('2001:db8:aaaa:1::ffff');
    expect((await again('2001:db8:aaaa:1:abcd::5')).statusCode).toBe(429);
    expect((await again('2001:db8:aaaa:2::1')).statusCode).toBe(304);
  });

  it('many trusted addresses in one second are not held to the global cap (125 different addresses, all answered)', async () => {
    w.time.time.micros += 5n * MINUTE;
    const statuses: number[] = [];
    for (let i = 0; i < 125; i++) statuses.push((await again(`198.51.100.${i + 1}`)).statusCode);
    expect(new Set(statuses)).toEqual(new Set([304]));
  });
});

describe('T-D24 the ETag map: 304 without a database read, one read of the sha256 for a photo not yet seen, and a removed photo is 404 and never 304 (A13)', () => {
  let w: EditWorld;
  beforeAll(async () => {
    w = await editWorld('photoetag');
  }, 120_000);
  afterAll(async () => {
    await w?.world.close();
  });

  /** A whole photo (both kinds, so the removal has two objects to take away); `bytes` and `etag` are those of the full image. */
  const newPhoto = async (size = 640) => {
    const design = await addDesign(w);
    const bytes = jpeg(size);
    const id = randomUUID();
    await upload(w, 'owner', design, id, 'full', bytes);
    await upload(w, 'owner', design, id, 'thumb', jpeg(100));
    return { id, bytes, etag: `"${sha256(bytes)}"` };
  };
  const sent = () => w.world.spy.sent.length;
  const statementsSince = (n: number) => quiet(w.world.spy.sqls().slice(n));

  it('a photo that was read since the process started: the repeated read with If-None-Match is 304, with the same headers, no body, and NOT ONE statement sent to the database (not even a checkout)', async () => {
    const p = await newPhoto();
    const first = await read(w, p.id, 'full');
    expect([first.statusCode, first.headers.etag]).toEqual([200, p.etag]);
    const before = sent();
    const second = await read(w, p.id, 'full', { 'if-none-match': p.etag });
    expect(second.statusCode).toBe(304);
    expect(sent()).toBe(before); // no statement of any kind: the session is not looked up and the pool is not asked
    expect(second.rawPayload.length).toBe(0);
    expect(second.headers.etag).toBe(p.etag);
    expect(second.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(second.headers['cross-origin-resource-policy']).toBe('cross-origin');
    expect(second.headers['x-content-type-options']).toBe('nosniff');
  });

  it('the validator may be weak, one of a list, or *', async () => {
    const p = await newPhoto();
    await read(w, p.id, 'full');
    const before = sent();
    for (const header of [`W/${p.etag}`, `"nothing", ${p.etag}`, `${p.etag}, "other"`, '*']) {
      const res = await read(w, p.id, 'full', { 'if-none-match': header });
      expect([header, res.statusCode]).toEqual([header, 304]);
    }
    expect(sent()).toBe(before);
  });

  it('another ETag is not a match: the photo is answered whole (the bytes are read), and the map keeps its sha256', async () => {
    const p = await newPhoto();
    await read(w, p.id, 'full');
    const before = sent();
    const res = await read(w, p.id, 'full', { 'if-none-match': `"${'0'.repeat(64)}"` });
    expect(res.statusCode).toBe(200);
    expect(Buffer.compare(res.rawPayload, p.bytes)).toBe(0);
    expect(statementsSince(before).some((q) => /\bbytes\b/.test(q))).toBe(true);
  });

  it('a photo not seen since the process started costs ONE read of its sha256 and never of its bytes; a match is 304, and the next repeat needs no read at all', async () => {
    const p = await newPhoto(2000);
    etagMapOf(w.world.app).clear(); // the state of a process that has just started
    let before = sent();
    const first = await read(w, p.id, 'full', { 'if-none-match': p.etag });
    expect(first.statusCode).toBe(304);
    const q = statementsSince(before);
    expect(q).toHaveLength(1);
    expect(q[0]).toBe('SELECT sha256 FROM design_photos WHERE id = ? AND kind = ? AND removed_at IS NULL');
    before = sent();
    expect((await read(w, p.id, 'full', { 'if-none-match': p.etag })).statusCode).toBe(304);
    expect(sent()).toBe(before);
  });

  it('a photo not seen and an ETag that does not match: the sha256 is read, then the photo (bytes included), and the map is filled', async () => {
    const p = await newPhoto(1500);
    etagMapOf(w.world.app).clear();
    const before = sent();
    const res = await read(w, p.id, 'full', { 'if-none-match': '"stale"' });
    expect(res.statusCode).toBe(200);
    expect(Buffer.compare(res.rawPayload, p.bytes)).toBe(0);
    expect(statementsSince(before).filter((q) => /\bbytes\b/.test(q))).toHaveLength(1);
    const after = sent();
    expect((await read(w, p.id, 'full', { 'if-none-match': p.etag })).statusCode).toBe(304);
    expect(sent()).toBe(after);
  });

  it('a removed photo is 404 and never 304: whether the map held it or not, with or without a matching If-None-Match', async () => {
    const seen = await newPhoto();
    await read(w, seen.id, 'full');
    const unseen = await newPhoto();
    await read(w, seen.id, 'thumb');
    expect((await remove(w, 'owner', seen.id)).statusCode).toBe(200);
    expect((await remove(w, 'owner', unseen.id)).statusCode).toBe(200);
    for (const p of [seen, unseen]) {
      for (const kind of ['full', 'thumb']) {
        for (const headers of [{}, { 'if-none-match': p.etag }, { 'if-none-match': '*' }] as Record<string, string>[]) {
          const res = await read(w, p.id, kind, headers);
          expect([p.id.slice(0, 4), kind, JSON.stringify(headers), res.statusCode, codeOf(res)]).toEqual([p.id.slice(0, 4), kind, JSON.stringify(headers), 404, 'JV_NOT_FOUND']);
          expect(res.headers.etag).toBeUndefined();
        }
      }
    }
    etagMapOf(w.world.app).clear(); // after a restart as well
    expect((await read(w, seen.id, 'full', { 'if-none-match': seen.etag })).statusCode).toBe(404);
  });

  it('a read that saw the photo alive and finishes after the removal does not leave the sha256 in the map: the next conditional read is 404, not 304', async () => {
    const p = await newPhoto(900);
    etagMapOf(w.world.app).clear();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let held = false;
    const spy = w.world.spy;
    spy.intercept = async (e) => {
      if (!held && /FROM design_photos/.test(e.sql) && /\bbytes\b/.test(e.sql)) {
        held = true;
        const result = await e.real(); // the row is read while the photo is alive ...
        await gate; // ... and the answer waits here while the owner removes the photo
        return { result };
      }
      return undefined;
    };
    try {
      const reading = read(w, p.id, 'full');
      while (!held) await new Promise((r) => setTimeout(r, 5));
      await new Promise((r) => setTimeout(r, 50));
      spy.intercept = null; // the removal and everything after it run unheld
      expect((await remove(w, 'owner', p.id)).statusCode).toBe(200);
      release();
      expect((await reading).statusCode).toBe(200); // it began before the removal: it may be answered
    } finally {
      spy.intercept = null;
      release();
    }
    const after = await read(w, p.id, 'full', { 'if-none-match': p.etag });
    expect([after.statusCode, codeOf(after)]).toEqual([404, 'JV_NOT_FOUND']);
  });

  it('the map is the one shared by the whole application and holds at most 5,000 entries', async () => {
    const map = etagMapOf(w.world.app);
    expect(etagMapOf(w.world.app)).toBe(map);
    expect(map.maxEntries).toBe(5000);
  });
});
