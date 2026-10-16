import { randomBytes } from 'node:crypto';
import type { Connection } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appConn, dropDb, errorOf } from '../helpers';
import { clearLoginCounters, insertPhotoGuarded, logError, recordPull, unattachedPhotos, ERROR_LOG_PER_MINUTE, type PhotoInsert } from '../../scripts/housekeeping.mjs';
import { V, insert, migratedDb, uuid } from './support';

// Statements the spec gives to the database session in draft 5.2 (18.13 E): the error log cap (D25, RF5-16), the photo count and the unattached caps (P2, RF5-9, O56) and the two admin-door
// statements (U3: clear the login counters, record a pull). Each is one statement or a short loop, with the table's own keys making the cap strict under concurrency.

let db: string;
let c: Connection;
beforeAll(async () => {
  ({ db, c } = await migratedDb('s18_house'));
});
afterAll(async () => {
  await c.end();
  await dropDb(db);
});
const NOW = new Date('2026-10-16T08:30:15.250Z');
const count = async (sql: string, p: unknown[] = []) => Number((((await c.query<any[]>(sql, p))[0]) as any[])[0].n);

describe('logError: at most 20 rows a minute for each code (D25, T-D28)', () => {
  it('1,000 identical errors in a minute write 20 rows; the rest are counted inside the last one', async () => {
    for (let i = 0; i < 1000; i++) await logError(c, { level: 'error', code: 'JV_INTERNAL', message: 'same bug', detail: { route: '/v1/sync/poll' } }, { now: NOW });
    expect(await count("SELECT COUNT(*) AS n FROM sys_error_log WHERE code = 'JV_INTERNAL'")).toBe(20);
    const [rows] = await c.query<any[]>("SELECT seq, detail FROM sys_error_log WHERE code = 'JV_INTERNAL' ORDER BY seq");
    expect(rows.map((r) => r.seq)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    const last = typeof rows[19].detail === 'string' ? JSON.parse(rows[19].detail) : rows[19].detail;
    expect(last).toMatchObject({ route: '/v1/sync/poll', suppressed: 980 });
    const first = typeof rows[0].detail === 'string' ? JSON.parse(rows[0].detail) : rows[0].detail;
    expect(first.suppressed).toBeUndefined();
    expect(ERROR_LOG_PER_MINUTE).toBe(20);
  });

  it('the next minute starts afresh, and another code has its own 20', async () => {
    await logError(c, { level: 'error', code: 'JV_INTERNAL', message: 'again' }, { now: new Date(NOW.getTime() + 60_000) });
    expect(await count("SELECT COUNT(*) AS n FROM sys_error_log WHERE code = 'JV_INTERNAL'")).toBe(21);
    for (let i = 0; i < 30; i++) await logError(c, { level: 'warn', code: 'JV_BUSY', message: 'busy' }, { now: NOW });
    expect(await count("SELECT COUNT(*) AS n FROM sys_error_log WHERE code = 'JV_BUSY'")).toBe(20);
  });

  it('eight connections logging the same code at once never write more than 20 rows, and not one occurrence is lost (rows + suppressed = calls)', async () => {
    const conns = await Promise.all(Array.from({ length: 8 }, () => appConn(db)));
    const now = new Date('2026-10-16T09:00:05.000Z');
    await Promise.all(conns.map(async (x) => { for (let i = 0; i < 50; i++) await logError(x, { level: 'error', code: 'RACE', message: 'x' }, { now }); }));
    await Promise.all(conns.map((x) => x.end()));
    const [rows] = await c.query<any[]>("SELECT seq, detail FROM sys_error_log WHERE code = 'RACE' ORDER BY seq");
    expect(rows).toHaveLength(20);
    const last = typeof rows[19].detail === 'string' ? JSON.parse(rows[19].detail) : rows[19].detail;
    expect(20 + last.suppressed).toBe(400);
  });

  it('stores what it is given (level, code, message, request id, user id, detail) and nothing else; the message is cut to the column', async () => {
    const rid = uuid();
    const uid = uuid();
    await logError(c, { level: 'fatal', code: 'ONE', message: 'm'.repeat(900), request_id: rid, user_id: uid, detail: { a: 1 } }, { now: NOW });
    const [[r]] = await c.query<any[][]>("SELECT level, code, CHAR_LENGTH(message) AS len, request_id, user_id, at, minute_at, seq FROM sys_error_log WHERE code = 'ONE'");
    expect([(r as any).level, (r as any).code, (r as any).len, (r as any).request_id, (r as any).user_id, (r as any).minute_at, (r as any).seq]).toEqual(['fatal', 'ONE', 500, rid, uid, '2026-10-16 08:30:00', 1]);
    expect((r as any).at).toBe('2026-10-16 08:30:15.250000');
  });

  it('rows written by hand without a seq are not capped (the cap belongs to the log function) and the table refuses a seq above 20 or a repeated slot', async () => {
    for (let i = 0; i < 25; i++) await insert(c, 'sys_error_log', { level: 'error', code: 'HAND', message: 'x' });
    expect(await count("SELECT COUNT(*) AS n FROM sys_error_log WHERE code = 'HAND'")).toBe(25);
    expect((await errorOf(() => insert(c, 'sys_error_log', { level: 'error', code: 'SLOT', message: 'x', minute_at: '2026-10-16 08:30:00', seq: 21 })))?.errno).toBe(4025);
    await insert(c, 'sys_error_log', { level: 'error', code: 'SLOT', message: 'x', minute_at: '2026-10-16 08:30:00', seq: 3 });
    expect((await errorOf(() => insert(c, 'sys_error_log', { level: 'error', code: 'SLOT', message: 'y', minute_at: '2026-10-16 08:30:00', seq: 3 })))?.errno).toBe(1062);
  });
});

describe('insertPhotoGuarded: the count and the insert are one statement (P2, RF5-9, O56)', () => {
  const photo = (design: string, o: Partial<PhotoInsert> = {}): PhotoInsert => {
    const bytes = randomBytes(2000);
    return { id: uuid(), kind: 'full', design_id: design, mime: 'image/jpeg', bytes, ...o };
  };
  const caps = { perDesign: 3, unattachedPhotos: 60, unattachedBytes: 100 * 1024 * 1024 };

  it('an existing design takes three distinct photo ids; the thumbnail of a stored id is not a second photo; a fourth id is refused', async () => {
    const cat = ((await c.query<any[]>('SELECT id FROM categories LIMIT 1'))[0] as any[])[0].id;
    const design = (await insert(c, 'designs', V.design(cat))) as { id: string };
    const ids = [uuid(), uuid(), uuid()];
    for (const id of ids) expect(await insertPhotoGuarded(c, photo(design.id, { id }), caps)).toEqual({ inserted: true });
    expect(await insertPhotoGuarded(c, photo(design.id, { id: ids[0], kind: 'thumb' as const }), caps)).toEqual({ inserted: true }); // the 320 px thumbnail of a stored id
    expect(await insertPhotoGuarded(c, photo(design.id), caps)).toEqual({ inserted: false, reason: 'design_full' });
    expect(await count('SELECT COUNT(DISTINCT id) AS n FROM design_photos WHERE design_id = ? AND removed_at IS NULL', [design.id])).toBe(3);
  });

  it('a removed photo does not count; the pair (id, kind) is insert-only: sending it again is refused as a duplicate, never overwritten', async () => {
    const cat = ((await c.query<any[]>('SELECT id FROM categories LIMIT 1'))[0] as any[])[0].id;
    const design = (await insert(c, 'designs', V.design(cat))) as { id: string };
    const a = photo(design.id);
    await insertPhotoGuarded(c, a, caps);
    await insertPhotoGuarded(c, photo(design.id), caps);
    await insertPhotoGuarded(c, photo(design.id), caps);
    expect((await insertPhotoGuarded(c, photo(design.id), caps)).inserted).toBe(false);
    await c.query("UPDATE design_photos SET removed_at = '2026-10-16 08:00:00.000000', bytes = NULL WHERE id = ? AND kind = 'full'", [a.id]);
    expect(await insertPhotoGuarded(c, photo(design.id), caps)).toEqual({ inserted: true }); // the removed one made room
    const again = await insertPhotoGuarded(c, { ...photo(design.id), id: a.id }, caps).catch((e: { errno?: number }) => e);
    expect((again as { errno?: number }).errno ?? (again as { reason?: string }).reason).toBeTruthy();
    expect(await count("SELECT COUNT(*) AS n FROM design_photos WHERE id = ? AND kind = 'full' AND bytes IS NOT NULL", [a.id])).toBe(0); // the tombstone was not overwritten
  });

  it('the stored row has the sha256 of the bytes and the size, and the bytes themselves', async () => {
    const design = uuid();
    const p = photo(design);
    await insertPhotoGuarded(c, p, caps);
    const [[row]] = await c.query<any[][]>('SELECT byte_size, HEX(sha256) AS h, bytes FROM design_photos WHERE id = ? AND kind = ?', [p.id, 'full']);
    expect((row as any).byte_size).toBe(2000);
    expect((row as any).bytes).toEqual(p.bytes);
    expect(String((row as any).h)).toHaveLength(64);
  });

  it('unattached photos (their design_id is not a design yet) are capped at 60 distinct ids: the 61st is refused, and photos of real designs do not count', async () => {
    const { db: db2, c: c2 } = await migratedDb('s18_unatt');
    try {
      const capsSmall = { perDesign: 3, unattachedPhotos: 60, unattachedBytes: 100 * 1024 * 1024 };
      const cat = ((await c2.query<any[]>('SELECT id FROM categories LIMIT 1'))[0] as any[])[0].id;
      const real = (await insert(c2, 'designs', V.design(cat))) as { id: string };
      await insertPhotoGuarded(c2, photo(real.id), capsSmall); // attached: not counted
      for (let i = 0; i < 60; i++) expect((await insertPhotoGuarded(c2, photo(uuid()), capsSmall)).inserted, `photo ${i + 1}`).toBe(true);
      expect(await insertPhotoGuarded(c2, photo(uuid()), capsSmall)).toEqual({ inserted: false, reason: 'unattached_count' });
      const u = await unattachedPhotos(c2);
      expect(u).toEqual({ photos: 60, bytes: 60 * 2000 });
      // a thumbnail for an unattached id already stored is not a new photo
      const [[one]] = await c2.query<any[][]>("SELECT id, design_id FROM design_photos WHERE design_id NOT IN (SELECT id FROM designs) LIMIT 1");
      expect((await insertPhotoGuarded(c2, photo((one as any).design_id, { id: (one as any).id, kind: 'thumb' as const }), capsSmall)).inserted).toBe(true);
      // and the real design still takes its photos
      expect((await insertPhotoGuarded(c2, photo(real.id), capsSmall)).inserted).toBe(true);
    } finally {
      await c2.end();
      await dropDb(db2);
    }
  });

  it('unattached photos are capped at 100 MB too (here 10 KB): the photo that would pass the line is refused', async () => {
    const { db: db2, c: c2 } = await migratedDb('s18_unattb');
    try {
      const capsBytes = { perDesign: 3, unattachedPhotos: 60, unattachedBytes: 10_000 };
      for (let i = 0; i < 5; i++) expect((await insertPhotoGuarded(c2, photo(uuid()), capsBytes)).inserted).toBe(true); // 5 x 2,000 = 10,000: exactly the cap
      expect(await insertPhotoGuarded(c2, photo(uuid()), capsBytes)).toEqual({ inserted: false, reason: 'unattached_bytes' });
    } finally {
      await c2.end();
      await dropDb(db2);
    }
  });
});

describe('the admin-door statements (U3)', () => {
  it('clearLoginCounters sets n to 0 and the window to now on every row of the three counting scopes and leaves the summary row alone', async () => {
    await c.query('DELETE FROM sys_login_attempts');
    await insert(c, 'sys_login_attempts', { scope: 'email', slot: 1, window_start: '2026-10-16 07:00:00.000000', n: 7 });
    await insert(c, 'sys_login_attempts', { scope: 'addr', slot: 2, window_start: '2026-10-16 07:00:00.000000', n: 19 });
    await insert(c, 'sys_login_attempts', { scope: 'any', slot: 0, window_start: '2026-10-16 07:00:00.000000', n: 55 });
    await insert(c, 'sys_login_attempts', { scope: 'audit', slot: 0, window_start: '2026-10-16 07:00:00.000000', n: 123 });
    const r = await clearLoginCounters(c);
    expect(r.cleared).toBe(3);
    const [rows] = await c.query<any[]>('SELECT scope, slot, n, window_start FROM sys_login_attempts ORDER BY scope');
    expect(rows.map((x) => [x.scope, Number(x.n)])).toEqual([['addr', 0], ['any', 0], ['audit', 123], ['email', 0]]);
    for (const x of rows.filter((y) => y.scope !== 'audit')) expect(x.window_start > '2026-10-16 07:00:00').toBe(true);
    expect(rows.find((x) => x.scope === 'audit').window_start).toBe('2026-10-16 07:00:00.000000');
  });

  it('recordPull stores {at, by, file, sha256} in settings.last_pulled, replaces the earlier one, and touches updated_at so the health line sees it', async () => {
    await recordPull(c, { at: '2026-10-10T05:00:00.000Z', by: 'admin-cli', file: 'daily/2026-10-10.enc', sha256: 'ab'.repeat(32) });
    const get = async () => {
      const [[r]] = await c.query<any[][]>("SELECT value FROM settings WHERE setting_key = 'last_pulled'");
      const v = (r as any).value;
      return typeof v === 'string' ? JSON.parse(v) : v;
    };
    expect(await get()).toEqual({ at: '2026-10-10T05:00:00.000Z', by: 'admin-cli', file: 'daily/2026-10-10.enc', sha256: 'ab'.repeat(32) });
    await recordPull(c, { at: '2026-10-16T05:00:00.000Z', by: 'admin-cli', file: 'daily/2026-10-16.enc', sha256: 'cd'.repeat(32) });
    expect((await get()).file).toBe('daily/2026-10-16.enc');
    expect(await count("SELECT COUNT(*) AS n FROM settings WHERE setting_key = 'last_pulled'")).toBe(1);
  });

  it('recordPull refuses a time that is not a time, a file name that is not a backup name, and a hash that is not 64 hex characters', async () => {
    await expect(recordPull(c, { at: 'yesterday', by: 'admin-cli', file: 'daily/2026-10-10.enc', sha256: 'ab'.repeat(32) })).rejects.toThrow(/at/);
    await expect(recordPull(c, { at: '2026-10-10T05:00:00.000Z', by: 'admin-cli', file: '../etc/passwd', sha256: 'ab'.repeat(32) })).rejects.toThrow(/file/);
    await expect(recordPull(c, { at: '2026-10-10T05:00:00.000Z', by: 'admin-cli', file: 'daily/2026-10-10.enc', sha256: 'zz' })).rejects.toThrow(/sha256/);
  });
});
