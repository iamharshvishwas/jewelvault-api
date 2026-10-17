import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { Connection } from 'mysql2/promise';
import ts from 'typescript';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { insertPhotoGuarded, unattachedPhotos } from '../../scripts/housekeeping.mjs';
import { readHealth as readHealthScript } from '../../scripts/health.mjs';
import { loadQueries } from '../../scripts/queries.mjs';
import { type DbPool, createDbPool } from '../../src/db/pool';
import { txContext, withRead, withTx } from '../../src/db/tx';
import { limits } from '../../src/limits';
import { EtagMap } from '../../src/photos/etagMap';
import { photoCaps as caps, type PhotoCaps, type PhotoKind, type PhotoMime, type PhotoStore, createDbPhotoStore, photoCapsOf, sniffImage } from '../../src/photos/photoStore';
import { P2_INSERT_TEXT, P2_UNATTACHED_TEXT } from '../../src/photos/queries';
import { readDbSizeBytes } from '../../src/photos/sizeLine';
import { DB_RED_LINE_BYTES, readHealth } from '../../src/reads/health';
import { type Scratch, scratchDatabase } from '../helpers';
import { V, insert } from '../schema/support';
import { REPO } from './support';
import { spyOn } from './tx-support';
import { FakePhotoStore, jpeg, png, sha256, webp } from './photo-support';

// T-F10 (P5, P7, D26): the PhotoStore is ONE interface, and the same contract test passes for the table and for a fake second store; the file's type is read from its first bytes; the two SQL texts are
// the database half's, character for character; no list query selects `bytes`; the size line of P5 is right against a real bulk insert (400 photo rows) where information_schema alone is not.

// ------------------------------------------------------------------ the first bytes (P1)

describe('T-F10 sniffImage: the type is read from the first bytes and from nothing else (P1)', () => {
  it('knows JPEG (FF D8 FF), PNG (89 50 4E 47) and WebP (RIFF, four bytes, WEBP)', () => {
    expect(sniffImage(jpeg())).toBe('image/jpeg');
    expect(sniffImage(Buffer.from([0xff, 0xd8, 0xff]))).toBe('image/jpeg'); // three bytes are enough
    expect(sniffImage(png())).toBe('image/png');
    expect(sniffImage(Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toBe('image/png');
    expect(sniffImage(webp())).toBe('image/webp');
    expect(sniffImage(new Uint8Array(webp()))).toBe('image/webp'); // any byte array
  });

  it('refuses everything else, among them a text that starts like a name, empty input and signatures that are cut short', () => {
    const none: Buffer[] = [
      Buffer.alloc(0),
      Buffer.from([0xff]),
      Buffer.from([0xff, 0xd8]),
      Buffer.from([0xff, 0xd8, 0x00]),
      Buffer.from([0x89, 0x50, 0x4e]),
      Buffer.from('GIF89a'),
      Buffer.from('%PDF-1.7'),
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
      Buffer.from('RIFF....WAVE'),
      Buffer.from('RIFF....WEB'),
      Buffer.from('RIFF....WEBX'),
      Buffer.from('xRIFF....WEBP'),
      Buffer.from('photo.jpg'),
    ];
    for (const bytes of none) expect(sniffImage(bytes), JSON.stringify(bytes.toString('latin1'))).toBeNull();
  });

  it('reads the first 12 bytes at most: a PNG signature later in the file does not make a JPEG', () => {
    expect(sniffImage(Buffer.concat([Buffer.from('xxxx'), png()]))).toBeNull();
  });
});

// ------------------------------------------------------------------ the 5,000-entry map (A13)

describe('T-F10 the ETag map: the last 5,000 (photo id, kind) to sha256, emptied for a removed photo (A13)', () => {
  const token = (m: EtagMap) => m.begin();

  it('holds 5,000 entries: the 5,001st pushes out the one least recently used, and a read counts as a use', () => {
    const m = new EtagMap();
    expect(m.maxEntries).toBe(5000);
    const ids = Array.from({ length: 5000 }, () => randomUUID());
    for (const id of ids) m.set(token(m), id, 'full', 'aa'.repeat(32));
    expect(m.size).toBe(5000);
    expect(m.get(ids[0], 'full')).toBe('aa'.repeat(32)); // ids[0] is used again: it is now the newest
    const extra = randomUUID();
    m.set(token(m), extra, 'thumb', 'bb'.repeat(32));
    expect(m.size).toBe(5000);
    expect(m.get(ids[1], 'full')).toBeUndefined(); // the oldest unused went
    expect(m.get(ids[0], 'full')).toBe('aa'.repeat(32));
    expect(m.get(extra, 'thumb')).toBe('bb'.repeat(32));
  });

  it('keeps the two kinds of one id apart, and drop() empties both kinds of that id and nothing else', () => {
    const m = new EtagMap(10);
    const [a, b] = [randomUUID(), randomUUID()];
    m.set(token(m), a, 'full', '11'.repeat(32));
    m.set(token(m), a, 'thumb', '22'.repeat(32));
    m.set(token(m), b, 'full', '33'.repeat(32));
    expect([m.get(a, 'full'), m.get(a, 'thumb')]).toEqual(['11'.repeat(32), '22'.repeat(32)]);
    m.drop(a);
    expect([m.get(a, 'full'), m.get(a, 'thumb'), m.get(b, 'full')]).toEqual([undefined, undefined, '33'.repeat(32)]);
    expect(m.size).toBe(1);
  });

  it('does not take an entry filled by a read that began before a removal and ended after it (the read saw the photo alive, the removal has since emptied the map)', () => {
    const m = new EtagMap(10);
    const id = randomUUID();
    const began = m.begin(); // a read starts
    m.drop(id); // the removal commits and empties the map
    expect(m.set(began, id, 'full', 'cc'.repeat(32))).toBe(false); // the read finishes: its sha256 is not kept
    expect(m.get(id, 'full')).toBeUndefined();
    expect(m.set(m.begin(), id, 'full', 'cc'.repeat(32))).toBe(true); // a read that began after the removal is fine (it will find the photo gone anyway)
  });

  it('refuses a size that is not a whole number of at least 1', () => {
    for (const bad of [0, -1, 1.5, Number.NaN]) expect(() => new EtagMap(bad)).toThrow(TypeError);
  });
});

// ------------------------------------------------------------------ the contract (P7)

interface Subject {
  store: PhotoStore;
  /** makes a design id one that exists (a photo for it is no longer unattached) */
  addDesign(id: string): Promise<void>;
}

/** The contract of P7: put, get, remove and sizes. The table passes it and so does a fake; a store on an outside bucket would have to. */
function photoStoreContract(name: string, make: () => Promise<Subject>): void {
  describe(`T-F10 PhotoStore contract: ${name}`, () => {
    const put = (s: Subject, o: { id?: string; kind?: PhotoKind; design?: string; bytes?: Buffer; mime?: PhotoMime; caps?: PhotoCaps } = {}) =>
      s.store.put({ photoId: o.id ?? randomUUID(), kind: o.kind ?? 'full', designId: o.design ?? randomUUID(), mime: o.mime ?? 'image/jpeg', bytes: o.bytes ?? jpeg(500), createdBy: null }, o.caps);

    it('put stores a photo object and says its sha256 and size; get gives the same bytes, the type and the same sha256 back; the sha256 is that of the bytes as uploaded', async () => {
      const s = await make();
      const id = randomUUID();
      const bytes = jpeg(900);
      const out = await put(s, { id, bytes });
      expect(out).toEqual({ stored: true, sha256: sha256(bytes), byteSize: 900 });
      const back = await s.store.get(id, 'full');
      expect(back).not.toBeNull();
      expect(back!.mime).toBe('image/jpeg');
      expect(back!.sha256).toBe(sha256(bytes));
      expect(back!.byteSize).toBe(900);
      expect(Buffer.compare(back!.bytes, bytes)).toBe(0);
      expect(await s.store.get(id, 'full', { sha256Only: true })).toEqual({ sha256: sha256(bytes) });
    });

    it('stores each of the three types as it was given, and the thumbnail of a stored id is a second object under the same id', async () => {
      const s = await make();
      const id = randomUUID();
      const design = randomUUID();
      for (const [kind, mime, bytes] of [['full', 'image/png', png(400)], ['thumb', 'image/webp', webp(200)]] as const) expect((await put(s, { id, design, kind, mime, bytes })).stored).toBe(true);
      expect((await s.store.get(id, 'full'))!.mime).toBe('image/png');
      expect((await s.store.get(id, 'thumb'))!.mime).toBe('image/webp');
      expect((await s.store.get(id, 'thumb'))!.byteSize).toBe(200);
    });

    it('a file of 2 MiB is stored and read back whole', async () => {
      const s = await make();
      const id = randomUUID();
      const bytes = jpeg(limits.maxPhotoBytes);
      expect((await put(s, { id, bytes })).stored).toBe(true);
      const back = await s.store.get(id, 'full');
      expect(back!.byteSize).toBe(limits.maxPhotoBytes);
      expect(Buffer.compare(back!.bytes, bytes)).toBe(0);
    });

    it('is insert-only: a (photo id, kind) pair that is stored is refused as a duplicate and the first bytes stay', async () => {
      const s = await make();
      const id = randomUUID();
      const design = randomUUID();
      const first = jpeg(300);
      await put(s, { id, design, bytes: first });
      expect(await put(s, { id, design, bytes: jpeg(300) })).toEqual({ stored: false, reason: 'duplicate' });
      expect(await put(s, { id, design: randomUUID(), bytes: jpeg(300) })).toEqual({ stored: false, reason: 'duplicate' }); // the pair is the key, whatever design comes with it
      expect(Buffer.compare((await s.store.get(id, 'full'))!.bytes, first)).toBe(0);
      expect((await put(s, { id, design, kind: 'thumb', bytes: jpeg(100) })).stored).toBe(true);
      expect((await put(s, { id, design, kind: 'thumb', bytes: jpeg(100) })).stored).toBe(false);
    });

    it('get is null for a photo nobody stored and for a kind that was not stored', async () => {
      const s = await make();
      const id = randomUUID();
      await put(s, { id });
      expect(await s.store.get(randomUUID(), 'full')).toBeNull();
      expect(await s.store.get(id, 'thumb')).toBeNull();
      expect(await s.store.get(id, 'thumb', { sha256Only: true })).toBeNull();
    });

    it('a design has at most 3 distinct live photo ids; the thumbnails of those ids are not new photos', async () => {
      const s = await make();
      const design = randomUUID();
      const ids = [randomUUID(), randomUUID(), randomUUID()];
      for (const id of ids) expect((await put(s, { id, design })).stored).toBe(true);
      expect(await put(s, { design })).toEqual({ stored: false, reason: 'design_full' });
      for (const id of ids) expect((await put(s, { id, design, kind: 'thumb', bytes: jpeg(100) })).stored).toBe(true);
      expect(await put(s, { design })).toEqual({ stored: false, reason: 'design_full' });
      expect((await put(s, { design: randomUUID() })).stored).toBe(true); // another design id has its own three
    });

    it('remove takes both kinds away: get is null, the design has room again, and removing again changes nothing; an unknown photo is unknown', async () => {
      const s = await make();
      const design = randomUUID();
      const [a, b, c] = [randomUUID(), randomUUID(), randomUUID()];
      for (const id of [a, b, c]) {
        await put(s, { id, design });
        await put(s, { id, design, kind: 'thumb', bytes: jpeg(100) });
      }
      expect((await put(s, { design })).stored).toBe(false);
      const at = '2026-10-17 10:00:00.250000';
      const out = await s.store.remove(b, at);
      expect(out).toMatchObject({ state: 'removed', designId: design, kinds: ['full', 'thumb'] });
      expect(String((out as { removedAt: string }).removedAt)).toContain('2026-10-17 10:00:00');
      expect(await s.store.get(b, 'full')).toBeNull();
      expect(await s.store.get(b, 'thumb')).toBeNull();
      expect(await s.store.get(b, 'full', { sha256Only: true })).toBeNull();
      expect((await s.store.get(a, 'full'))!.byteSize).toBe(500); // the others are untouched
      const again = await s.store.remove(b, '2026-10-18 10:00:00.000000');
      expect(again).toMatchObject({ state: 'already_removed', designId: design, kinds: ['full', 'thumb'] });
      expect(String((again as { removedAt: string }).removedAt)).toContain('2026-10-17 10:00:00'); // the first removal's time stays
      expect(await s.store.remove(randomUUID(), at)).toEqual({ state: 'unknown' });
      expect((await put(s, { design })).stored).toBe(true); // the removed photo does not count
      expect(await put(s, { id: b, design, kind: 'full' })).toMatchObject({ stored: false }); // and its id is not free again
    });

    it('sizes counts the live photos (distinct ids) and their bytes, never a removed one, and says how much of it is unattached', async () => {
      const s = await make();
      const home = randomUUID();
      await s.addDesign(home);
      const [a, b] = [randomUUID(), randomUUID()];
      await put(s, { id: a, design: home, bytes: jpeg(1000) });
      await put(s, { id: a, design: home, kind: 'thumb', bytes: jpeg(250) });
      await put(s, { id: b, design: randomUUID(), bytes: jpeg(2000) });
      expect(await s.store.sizes()).toEqual({ photos: 2, bytes: 3250, unattachedPhotos: 1, unattachedBytes: 2000 });
      await s.store.remove(b, '2026-10-17 10:00:00.000000');
      expect(await s.store.sizes()).toEqual({ photos: 1, bytes: 1250, unattachedPhotos: 0, unattachedBytes: 0 });
      await s.store.remove(a, '2026-10-17 10:00:00.000000');
      expect(await s.store.sizes()).toEqual({ photos: 0, bytes: 0, unattachedPhotos: 0, unattachedBytes: 0 });
    });

    it('a photo whose design exists is not unattached; the unattached caps count photos and bytes, a stored id\'s thumbnail passes them, and a design that exists is not held to them', async () => {
      const s = await make();
      const small: PhotoCaps = { perDesign: 3, unattachedPhotos: 2, unattachedBytes: 1000 };
      const [x, y] = [randomUUID(), randomUUID()];
      expect((await put(s, { id: x, bytes: jpeg(300), caps: small })).stored).toBe(true);
      expect((await put(s, { id: y, bytes: jpeg(300), caps: small })).stored).toBe(true);
      expect(await put(s, { bytes: jpeg(100), caps: small })).toEqual({ stored: false, reason: 'unattached_count' });
      const xDesign = randomUUID();
      expect((await put(s, { id: x, design: xDesign, kind: 'thumb', bytes: jpeg(100), caps: small })).stored).toBe(true); // a thumbnail of a stored id is not a new photo
      const home = randomUUID();
      await s.addDesign(home);
      expect((await put(s, { design: home, caps: small })).stored).toBe(true); // attached: no unattached cap
      const bytesCaps: PhotoCaps = { perDesign: 3, unattachedPhotos: 100, unattachedBytes: 1000 };
      const t = await make();
      expect((await put(t, { bytes: jpeg(600), caps: bytesCaps })).stored).toBe(true);
      expect((await put(t, { bytes: jpeg(400), caps: bytesCaps })).stored).toBe(true); // 1000 bytes: exactly the cap
      expect(await put(t, { bytes: jpeg(60), caps: bytesCaps })).toEqual({ stored: false, reason: 'unattached_bytes' });
    });
  });
}

photoStoreContract('the fake second store', async () => {
  const store = new FakePhotoStore();
  return { store, addDesign: async (id) => void store.designs.add(id) };
});

describe('T-F10 the in-database store', () => {
  let scratch: Scratch;
  let u: Connection;
  let pool: DbPool;
  let category: string;
  const ctx = () => txContext(pool, { requestId: randomUUID(), actor: { id: null, role: 'job' } });

  beforeAll(async () => {
    scratch = await scratchDatabase('photostore', { schema: true });
    u = await scratch.connect();
    pool = createDbPool(scratch.db);
    category = ((await insert(u, 'categories', V.category())) as { id: string }).id;
  }, 120_000);
  afterAll(async () => {
    await pool?.end().catch(() => undefined);
    await u?.end().catch(() => undefined);
    await scratch?.drop();
  });

  /** Every photo test starts from an empty table (as the root of the test server: the application user has no Delete). */
  const clean = async () => {
    const root = await scratch.root();
    try {
      await root.query(`DELETE FROM \`${scratch.database}\`.audit_log WHERE table_name = 'design_photos'`);
      await root.query(`DELETE FROM \`${scratch.database}\`.design_photos`);
      await root.query(`DELETE FROM \`${scratch.database}\`.designs`);
    } finally {
      await root.end();
    }
  };

  photoStoreContract('the table design_photos', async () => {
    await clean();
    return {
      store: createDbPhotoStore(ctx()),
      addDesign: async (id) => {
        await insert(u, 'designs', V.design(category, { id }));
      },
    };
  });

  it('the application\'s caps are those of P2 and O56: 3 photos a design, 60 unattached photos, 100 MB of them', () => {
    expect(photoCapsOf(limits)).toEqual({ perDesign: 3, unattachedPhotos: 60, unattachedBytes: 100 * 1024 * 1024 });
  });

  describe('the SQL is the database half\'s: the two texts of db/queries, character for character', () => {
    it('P2_INSERT_TEXT and P2_UNATTACHED_TEXT equal loadQueries() (the twin pattern of API09 and API12)', () => {
      const q = loadQueries();
      expect(P2_INSERT_TEXT).toBe(q.P2_insert);
      expect(P2_UNATTACHED_TEXT).toBe(q.P2_unattached);
      expect(P2_INSERT_TEXT.length).toBeGreaterThan(500);
    });

    it('the store answers what insertPhotoGuarded of scripts/housekeeping.mjs answers, step by step, for the same list of uploads (caps lowered so every refusal is reached)', async () => {
      const small: PhotoCaps = { perDesign: 2, unattachedPhotos: 5, unattachedBytes: 5000 };
      const real = randomUUID();
      const [u1, u2, u3] = [randomUUID(), randomUUID(), randomUUID()];
      const ids = Array.from({ length: 12 }, () => randomUUID());
      const steps: { id: string; kind: PhotoKind; design: string; size: number }[] = [
        { id: ids[0], kind: 'full', design: u1, size: 1000 },
        { id: ids[0], kind: 'thumb', design: u1, size: 200 },
        { id: ids[1], kind: 'full', design: u1, size: 1000 },
        { id: ids[2], kind: 'full', design: u1, size: 1000 }, // design_full: two distinct ids are stored for u1
        { id: ids[3], kind: 'full', design: u2, size: 1000 },
        { id: ids[4], kind: 'full', design: u2, size: 1000 }, // 4 unattached photos, 4,200 bytes
        { id: ids[5], kind: 'full', design: u3, size: 4000 }, // unattached_bytes: 4,200 + 4,000 is over 5,000
        { id: ids[6], kind: 'full', design: u3, size: 500 }, // the fifth unattached photo, 4,700 bytes
        { id: ids[7], kind: 'full', design: u3, size: 100 }, // unattached_count: five are waiting
        { id: ids[0], kind: 'full', design: u1, size: 100 }, // duplicate: the pair is stored, and every cap would have let it in
        { id: ids[8], kind: 'full', design: real, size: 3000 }, // a design that exists: no unattached cap
        { id: ids[8], kind: 'thumb', design: real, size: 100 },
        { id: ids[9], kind: 'full', design: real, size: 100 },
        { id: ids[10], kind: 'full', design: real, size: 100 }, // design_full
      ];
      const run = async (use: (s: (typeof steps)[number]) => Promise<string>) => {
        await clean();
        await insert(u, 'designs', V.design(category, { id: real }));
        const out: string[] = [];
        for (const s of steps) out.push(await use(s));
        return out;
      };
      const store = createDbPhotoStore(ctx());
      const viaStore = await run(async (s) => {
        const r = await store.put({ photoId: s.id, kind: s.kind, designId: s.design, mime: 'image/jpeg', bytes: jpeg(s.size), createdBy: null }, small);
        return r.stored ? 'stored' : r.reason;
      });
      const figuresStore = await store.sizes();
      const viaScript = await run(async (s) => {
        try {
          const r = await insertPhotoGuarded(u, { id: s.id, kind: s.kind, design_id: s.design, mime: 'image/jpeg', bytes: jpeg(s.size) }, small);
          return r.inserted ? 'stored' : r.reason;
        } catch (e) {
          if ((e as { errno?: number }).errno === 1062) return 'duplicate';
          throw e;
        }
      });
      const figuresScript = await unattachedPhotos(u);
      expect(viaStore).toEqual(viaScript);
      expect(new Set(viaStore)).toEqual(new Set(['stored', 'design_full', 'unattached_count', 'unattached_bytes', 'duplicate']));
      expect([figuresStore.unattachedPhotos, figuresStore.unattachedBytes]).toEqual([figuresScript.photos, figuresScript.bytes]);
    });
  });

  describe('what the store sends to the database', () => {
    it('get with sha256Only is ONE statement that reads the fingerprint of a live row and never mentions the bytes (A13: a photo not yet read costs one read of its sha256)', async () => {
      await clean();
      const id = randomUUID();
      await createDbPhotoStore(ctx()).put({ photoId: id, kind: 'full', designId: randomUUID(), mime: 'image/jpeg', bytes: jpeg(700), createdBy: null });
      const s = spyOn(pool);
      const got = await createDbPhotoStore(txContext(s.pool, { requestId: randomUUID(), actor: null })).get(id, 'full', { sha256Only: true });
      expect(got).toEqual({ sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
      const statements = s.sqls().filter((q) => !/^SET SESSION\b/i.test(q));
      expect(statements).toHaveLength(1);
      expect(statements[0]).toMatch(/^SELECT sha256 FROM design_photos WHERE id = \? AND kind = \? AND removed_at IS NULL$/);
      expect(statements[0]).not.toMatch(/\bbytes\b/i);
    });

    it('get reads one row by its primary key; the removal is one UPDATE that sets removed_at and empties the bytes of both kinds, with the audit event in the same transaction', async () => {
      await clean();
      const id = randomUUID();
      const design = randomUUID();
      const store = createDbPhotoStore(ctx());
      await store.put({ photoId: id, kind: 'full', designId: design, mime: 'image/jpeg', bytes: jpeg(700), createdBy: null });
      await store.put({ photoId: id, kind: 'thumb', designId: design, mime: 'image/jpeg', bytes: jpeg(100), createdBy: null });
      const s = spyOn(pool);
      const mine = createDbPhotoStore(txContext(s.pool, { requestId: randomUUID(), actor: { id: null, role: 'job' } }));
      await mine.get(id, 'full');
      const read = s.sqls().filter((q) => /design_photos/.test(q));
      expect(read).toHaveLength(1);
      expect(read[0]).toMatch(/^SELECT mime, sha256, byte_size, bytes FROM design_photos WHERE id = \? AND kind = \? AND removed_at IS NULL$/);
      const before = s.sent.length;
      expect((await mine.remove(id, '2026-10-17 10:00:00.250000')).state).toBe('removed');
      const updates = s.sqls().slice(before).filter((q) => /^UPDATE/i.test(q));
      expect(updates).toEqual(['UPDATE design_photos SET removed_at = ?, bytes = NULL WHERE id = ? AND removed_at IS NULL']);
      const [rows] = await u.query<any[]>("SELECT action, row_id, new_row FROM audit_log WHERE table_name = 'design_photos' AND row_id = ?", [id]);
      expect(rows).toHaveLength(1);
      expect(rows[0].action).toBe('event');
    });

    it('a removal keeps the row, empties the bytes and keeps byte_size and sha256; the CHECK of D26 allows no other state (T-F10)', async () => {
      await clean();
      const id = randomUUID();
      const bytes = jpeg(5000);
      const store = createDbPhotoStore(ctx());
      await store.put({ photoId: id, kind: 'full', designId: randomUUID(), mime: 'image/jpeg', bytes, createdBy: null });
      await store.remove(id, '2026-10-17 10:00:00.000000');
      const [rows] = await u.query<any[]>('SELECT byte_size, HEX(sha256) AS sha, bytes, removed_at FROM design_photos WHERE id = ?', [id]);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ byte_size: 5000, bytes: null });
      expect(rows[0].sha.toLowerCase()).toBe(sha256(bytes));
      expect(rows[0].removed_at).not.toBeNull();
      // the table's own CHECK: live rows have their bytes, removed rows have none, and nothing in between
      await expect(u.query("UPDATE design_photos SET bytes = ? WHERE id = ?", [bytes, id])).rejects.toMatchObject({ errno: 4025 });
      await expect(u.query('UPDATE design_photos SET removed_at = NULL WHERE id = ?', [id])).rejects.toMatchObject({ errno: 4025 });
    });
  });

  describe('the cap check scans design_photos and locks nothing (D19 rule 1, the judge of API10)', () => {
    it('the P2 insert reads every unattached photo to count it, yet at READ COMMITTED (the isolation of every connection, S11) the transaction holds no row lock but the row it wrote', async () => {
      await clean();
      const store = createDbPhotoStore(ctx());
      for (let i = 0; i < 40; i++) await store.put({ photoId: randomUUID(), kind: 'full', designId: randomUUID(), mime: 'image/jpeg', bytes: jpeg(300), createdBy: null });
      const root = await scratch.root();
      try {
        const held = await withTx(ctx(), async (tx) => {
          const id = randomUUID();
          const design = randomUUID();
          const done = await tx.run(P2_INSERT_TEXT, [id, 'full', design, 'image/jpeg', 300, 'ab'.repeat(32), jpeg(300), null, design, id, caps.perDesign, design, id, caps.unattachedPhotos, 300, caps.unattachedBytes]);
          expect(done.affectedRows).toBe(1);
          const [me] = await tx.rows<{ id: string }>('SELECT CONNECTION_ID() AS id');
          await new Promise((resolve) => setTimeout(resolve, 250)); // INNODB_TRX is a cache that is refreshed at most every 100 ms
          const [trx] = await root.query<any[]>('SELECT trx_rows_locked AS locked, trx_isolation_level AS level FROM information_schema.INNODB_TRX WHERE trx_mysql_thread_id = ?', [me.id]);
          return trx[0];
        });
        expect(held.level).toBe('READ COMMITTED');
        expect(Number(held.locked)).toBeLessThanOrEqual(2); // the inserted row, and not the 40 it counted
      } finally {
        await root.end();
      }
    });
  });

  describe('the size line of P5 (T-F10)', () => {
    it('the upload\'s reading of the size is the dashboard line\'s: the other tables, the live photo bytes, plus 12 percent (readHealth of the twin and of the database half agree with it)', async () => {
      await clean();
      const store = createDbPhotoStore(ctx());
      for (let i = 0; i < 5; i++) await store.put({ photoId: randomUUID(), kind: 'full', designId: randomUUID(), mime: 'image/jpeg', bytes: jpeg(300_000), createdBy: null });
      const viaUpload = await withRead(ctx(), (db) => readDbSizeBytes(db));
      const viaTwin = (await readHealth(u, { analyze: false })).db_size.bytes;
      const viaScript = (await readHealthScript(u, { analyze: false })).db_size.bytes;
      expect(viaUpload).toBe(viaTwin);
      expect(viaUpload).toBe(viaScript);
      expect(viaUpload).toBeGreaterThan(Math.round(1_500_000 * 1.12));
    });

    it('is red above 2 GB: the line is a number the route compares with DB_RED_LINE_BYTES (2 GiB)', () => {
      expect(DB_RED_LINE_BYTES).toBe(2 * 1024 * 1024 * 1024);
    });

    it('is right against a real bulk insert: after 400 photo rows of about 170 KB the computed size is within 15 percent of the real size of the table, where information_schema alone is far off', async () => {
      await clean();
      const root = await scratch.root();
      try {
        await root.query(`USE \`${scratch.database}\``); // the sequence table seq_1_to_400 is found through the current database
        const q = (sql: string) => root.query<any[]>(sql).then(([r]) => r);
        const file = async () => Number((await q(`SELECT FILE_SIZE AS f FROM information_schema.INNODB_SYS_TABLESPACES WHERE NAME = '${scratch.database}/design_photos'`))[0].f);
        // 400 rows of 174,080 bytes each (16 bytes repeated 10,880 times): about 70 MB, in one statement
        await root.query(
          `INSERT INTO \`${scratch.database}\`.design_photos (id, kind, design_id, mime, byte_size, sha256, bytes)
           SELECT UUID(), 'full', UUID(), 'image/jpeg', OCTET_LENGTH(REPEAT(UNHEX(MD5(seq)), 10880)), UNHEX(SHA2(seq, 256)), REPEAT(UNHEX(MD5(seq)), 10880) FROM seq_1_to_400`,
        );
        const rows = Number((await q(`SELECT COUNT(*) AS n FROM \`${scratch.database}\`.design_photos`))[0].n);
        expect(rows).toBe(400);
        const payload = Number((await q(`SELECT SUM(byte_size) AS s FROM \`${scratch.database}\`.design_photos`))[0].s);
        expect(payload).toBe(400 * 174_080);
        const realTable = await file(); // the tablespace file of design_photos as the disk holds it
        const lagging = Number((await q(`SELECT DATA_LENGTH + INDEX_LENGTH AS s FROM information_schema.TABLES WHERE TABLE_SCHEMA = '${scratch.database}' AND TABLE_NAME = 'design_photos'`))[0].s);
        // the computed size, from SUM(byte_size) and not from information_schema
        const line = await readHealth(u, { analyze: true });
        const computedPhotos = Math.round(line.db_size.photo_bytes * 1.12);
        expect(line.db_size.photo_bytes).toBe(payload);
        expect(Math.abs(computedPhotos - realTable) / realTable, `computed ${computedPhotos}, real ${realTable}`).toBeLessThanOrEqual(0.15);
        // the whole line against the disk: every tablespace of the database
        const allFiles = Number((await q(`SELECT SUM(FILE_SIZE) AS f FROM information_schema.INNODB_SYS_TABLESPACES WHERE NAME LIKE '${scratch.database}/%'`))[0].f);
        expect(Math.abs(line.db_size.bytes - allFiles) / allFiles, `line ${line.db_size.bytes}, disk ${allFiles}`).toBeLessThanOrEqual(0.15);
        const viaUpload = await withRead(ctx(), (db) => readDbSizeBytes(db));
        expect(Math.abs(viaUpload - allFiles) / allFiles).toBeLessThanOrEqual(0.15);
        // what information_schema said right after the insert, before ANALYZE TABLE, is only printed: its figure lags (P5), and when it refreshes is the server's business
        console.info(`[T-F10] 400 rows, payload ${payload}, disk ${realTable}, computed ${computedPhotos}, information_schema before ANALYZE ${lagging}`);
      } finally {
        await root.end();
      }
    }, 120_000);
  });
});

// ------------------------------------------------------------------ no list query selects bytes (D26)

describe('T-F10 no list query ever selects `bytes` (D26)', () => {
  function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) return sourceFiles(p);
      return /\.(ts|mts)$/.test(name) && !/\.d\.ts$/.test(name) ? [p] : [];
    });
  }

  const SQL = /^\s*(SELECT|INSERT|UPDATE|WITH)\b/i;
  /** The SQL texts of a source file: every string and template literal that is a statement and mentions design_photos. */
  function photoStatements(file: string, source: string): string[] {
    const sf = ts.createSourceFile(file, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
    const out: string[] = [];
    const visit = (n: ts.Node) => {
      if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && SQL.test(n.text) && /design_photos/i.test(n.text)) out.push(n.text);
      if (ts.isTemplateExpression(n)) {
        const text = n.head.text + n.templateSpans.map((s) => `\${}${s.literal.text}`).join('');
        if (SQL.test(text) && /design_photos/i.test(text)) out.push(text);
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
    return out;
  }

  /** The select lists of a statement (the text between SELECT and the next FROM) that name the bytes column or take every column. */
  function listsBytes(sql: string): boolean {
    const lists = [...sql.replace(/\s+/g, ' ').matchAll(/\bSELECT\b(.*?)\bFROM\b/gi)].map((m) => m[1].replace(/\bAS\s+bytes\b/gi, '')); // a figure named `bytes` (the sum of byte_size) is not the column
    return lists.some((l) => /\bbytes\b/i.test(l) || /(^|[\s,(])(\w+\.)?\*/.test(l.replace(/COUNT\(\*\)/gi, '')));
  }

  it('the scanner sees a list query that selects bytes, one that takes every column, and passes the counting ones (control)', () => {
    expect(listsBytes('SELECT id, bytes FROM design_photos WHERE design_id = ?')).toBe(true);
    expect(listsBytes('SELECT * FROM design_photos')).toBe(true);
    expect(listsBytes('SELECT p.* FROM design_photos p')).toBe(true);
    expect(listsBytes('SELECT id, kind, design_id, removed_at FROM design_photos WHERE id IN (?, ?)')).toBe(false);
    expect(listsBytes('SELECT COUNT(DISTINCT id) AS photos, SUM(byte_size) AS b FROM design_photos WHERE removed_at IS NULL')).toBe(false);
    expect(listsBytes('SELECT COUNT(*) FROM design_photos')).toBe(false);
    expect(listsBytes('SELECT COUNT(DISTINCT p.id) AS photos, CAST(COALESCE(SUM(p.byte_size), 0) AS CHAR) AS bytes FROM design_photos p')).toBe(false); // an alias is not the column
    expect(listsBytes('INSERT INTO design_photos (id, bytes) SELECT ?, ? FROM DUAL')).toBe(false); // the column list of an insert is not a select list
  });

  it('in src/ the one statement that selects the bytes reads ONE row by its primary key, and it lives in the PhotoStore; every other statement on design_photos leaves them alone', () => {
    const src = join(REPO, 'src');
    const withBytes: { file: string; sql: string }[] = [];
    let seen = 0;
    for (const file of sourceFiles(src)) {
      for (const sql of photoStatements(file, readFileSync(file, 'utf8'))) {
        seen++;
        if (listsBytes(sql)) withBytes.push({ file: relative(REPO, file), sql: sql.replace(/\s+/g, ' ').trim() });
      }
    }
    expect(seen).toBeGreaterThanOrEqual(6); // the photo statements were found at all
    expect(withBytes).toHaveLength(1);
    expect(withBytes[0].file).toBe('src/photos/photoStore.ts');
    expect(withBytes[0].sql).toMatch(/WHERE id = \? AND kind = \? AND removed_at IS NULL$/);
  });

  it('the sync and read routes list no photo table at all: design_photos is in no resource of the read side', async () => {
    const { MATRIX, READ_COLUMNS } = await import('../../src/permissions/matrix');
    expect(Object.keys(READ_COLUMNS)).not.toContain('design_photos');
    expect(Object.values(MATRIX).some((row) => 'reads' in row && (row.reads as readonly string[]).includes('design_photos'))).toBe(false);
  });
});

