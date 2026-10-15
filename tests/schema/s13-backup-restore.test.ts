import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Connection } from 'mysql2/promise';
import { afterAll, describe, expect, it } from 'vitest';
import { appConn, dropDb, errorOf, freshDb } from '../helpers';
import { copyPhotosOnce, directoryPhotos, directoryStore, exportDatabase, memoryPhotos, memoryStore, stripDefiner } from '../../scripts/backup.mjs';
import { restoreDatabase } from '../../scripts/restore.mjs';
import { runInvariants } from '../../scripts/invariants.mjs';
import { V, cleanWorld, insert, migratedDb, uuid } from './support';

// Spec B2 (the export and the once-only photo copy) and B4 / T-R02 (restore into an empty MariaDB and prove it equal), database half.
// The encryption, the bucket and the Docker drill on the Mac are not here; this is the part that reads and writes the database.

const dbs: string[] = [];
const dirs: string[] = [];
afterAll(async () => {
  for (const d of dbs) await dropDb(d);
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const sha = (b: Buffer) => createHash('sha256').update(b).digest();

/** A source shop: the clean books of the invariants tests plus a Hindi/emoji name, a login session (binary token), live and removed photos, audit rows. */
async function sourceShop(name: string, opts: { optional?: boolean } = {}) {
  const { db, c } = await migratedDb(name, { optional: opts.optional });
  dbs.push(db);
  const w = await cleanWorld(c);
  await insert(c, 'customers', V.customer({ name: 'Siddhi 💍 सिद्धि जैन', mobile: '9000000001', address: 'Jaishri Gold Palace, "Main" Road\nline two \\ backslash' }));
  const user = V.user({ active: 1 });
  await insert(c, 'users', user);
  await insert(c, 'sessions', V.session(user.id));
  const photoRows: { id: string; kind: string; bytes: Buffer }[] = [];
  const ids = [uuid(), uuid()];
  for (const id of ids) {
    for (const [kind, size] of [['full', 6000], ['thumb', 900]] as const) {
      const bytes = randomBytes(size);
      photoRows.push({ id, kind, bytes });
      await insert(c, 'design_photos', { id, kind, design_id: w.design.id, mime: 'image/jpeg', byte_size: size, sha256: sha(bytes), bytes });
    }
  }
  const gone = uuid(); // a removed photo: the row stays, the bytes are gone (D26)
  await insert(c, 'design_photos', { id: gone, kind: 'full', design_id: w.design.id, mime: 'image/jpeg', byte_size: 500, sha256: sha(Buffer.from('x')), bytes: null, removed_at: '2026-10-10 05:00:00.000000' });
  await c.query('UPDATE designs SET photo_ids = ? WHERE id = ?', [JSON.stringify(ids), w.design.id]);
  await insert(c, 'audit_log', { actor: user.id, actor_role: 'owner', table_name: 'customers', row_id: w.a.id, action: 'insert', new_row: { name: 'Customer A' } });
  return { db, c, w, photoRows, ids, gone };
}

async function emptyDb(name: string) {
  const db = await freshDb(name);
  dbs.push(db);
  return { db, c: await appConn(db) };
}

const baseTables = async (c: Connection) =>
  ((await c.query<any[]>("SELECT TABLE_NAME n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE'"))[0] as any[]).map((r) => r.n as string).sort();

describe('exportDatabase (B2)', () => {
  it('writes a manifest naming every table with its create statement, row count and file hash; the four views and no photo bytes', async () => {
    const s = await sourceShop('s13_a');
    const store = memoryStore();
    const m = await exportDatabase(s.c, store.sink);
    expect(m.format).toBe('jewelvault-export-1');
    expect(m.tables.map((t) => t.name)).toEqual(await baseTables(s.c));
    expect(m.views.map((v) => v.name).sort()).toEqual(['bill_summary', 'customer_balances', 'customer_ledger', 'daily_totals']);
    for (const t of m.tables) {
      expect(t.create, t.name).toMatch(/^CREATE TABLE/);
      expect(t.primary_key.length, t.name).toBeGreaterThan(0);
      const text = store.files.get(t.file)!;
      expect(createHash('sha256').update(text).digest('hex'), t.name).toBe(t.sha256);
      expect(text === '' ? 0 : text.trimEnd().split('\n').length, t.name).toBe(t.rows);
      const [[n]] = await s.c.query<any[][]>(`SELECT COUNT(*) AS n FROM \`${t.name}\``);
      expect(t.rows, t.name).toBe(Number((n as any).n));
    }
    expect(JSON.parse(store.files.get('manifest.json')!)).toEqual(m);
    expect(m.excluded).toEqual({ design_photos: ['bytes'] });
    expect(m.live_photos).toBe(4);
    await s.c.end();
  });

  it('leaves the photo bytes out completely: not as a column and not as hex anywhere in any file', async () => {
    const s = await sourceShop('s13_b');
    const store = memoryStore();
    await exportDatabase(s.c, store.sink);
    const photoRows = store.files.get('data/design_photos.ndjson')!.trim().split('\n').map((l) => JSON.parse(l));
    expect(photoRows).toHaveLength(5);
    for (const r of photoRows) expect(Object.keys(r)).not.toContain('bytes');
    const all = [...store.files.values()].join('\n').toUpperCase();
    for (const p of s.photoRows) expect(all).not.toContain(p.bytes.subarray(0, 24).toString('hex').toUpperCase());
    const sizeOfPhotoFile = store.files.get('data/design_photos.ndjson')!.length;
    expect(sizeOfPhotoFile).toBeLessThan(3000); // 5 rows of metadata, not 15 kB of photo
    await s.c.end();
  });

  it('keeps binary columns (a session token) as hex, text as text, NULL as null, and money as exact text', async () => {
    const s = await sourceShop('s13_c');
    const store = memoryStore();
    await exportDatabase(s.c, store.sink);
    const [[sess]] = await s.c.query<any[][]>('SELECT HEX(token_hash) AS h FROM sessions LIMIT 1');
    const row = JSON.parse(store.files.get('data/sessions.ndjson')!.trim().split('\n')[0]);
    expect(row.token_hash).toBe((sess as any).h);
    const bill = store.files.get('data/bills.ndjson')!.trim().split('\n').map((l) => JSON.parse(l)).find((b) => b.bill_no === 'OB-0001');
    expect(bill.grand_total).toBe('300.50');
    expect(bill.fine_weight_due).toBe('2.000');
    expect(bill.cancelled_at).toBeNull();
    await s.c.end();
  });

  it('pages by key: a page size of 2 gives byte-identical files to a page size of 1000', async () => {
    const s = await sourceShop('s13_d');
    const big = memoryStore();
    const small = memoryStore();
    await exportDatabase(s.c, big.sink, { pageSize: 1000 });
    await exportDatabase(s.c, small.sink, { pageSize: 2 });
    for (const [k, v] of big.files) if (k.startsWith('data/')) expect(small.files.get(k), k).toBe(v);
    await s.c.end();
  });

  it('uses ONE snapshot: a row committed by someone else while the export runs is not in it', async () => {
    const s = await sourceShop('s13_e');
    const other = await appConn(s.db);
    const store = memoryStore();
    let done = false;
    const m = await exportDatabase(s.c, store.sink, {
      between: async (table) => {
        if (table !== 'bills' || done) return;
        done = true;
        await insert(other, 'customers', V.customer({ name: 'Late customer', mobile: '9111111111' }));
      },
    });
    expect(done).toBe(true);
    const customers = store.files.get('data/customers.ndjson')!;
    expect(customers).not.toContain('Late customer'); // customers is read after bills, but inside the same snapshot
    expect(m.tables.find((t) => t.name === 'customers')!.rows).toBe(4);
    await other.end();
    await s.c.end();
  });

  it('leaves the isolation level of the caller alone and ends its transaction', async () => {
    const s = await sourceShop('s13_f');
    await exportDatabase(s.c, memoryStore().sink);
    const [[r]] = await s.c.query<any[][]>('SELECT @@session.tx_isolation AS l, @@in_transaction AS t');
    expect([(r as any).l, String((r as any).t)]).toEqual(['READ-COMMITTED', '0']);
    await s.c.end();
  });
});

describe('copyPhotosOnce (B2 part 2)', () => {
  it('copies each live photo that has no copy row, once; removed photos are never copied; a second run copies nothing', async () => {
    const s = await sourceShop('s13_g');
    const photos = memoryPhotos();
    const first = await copyPhotosOnce(s.c, photos);
    expect(first).toEqual({ copied: 4, bytes: 2 * 6000 + 2 * 900, failed: [] });
    expect(photos.objects.size).toBe(4);
    for (const p of s.photoRows) expect(await photos.get(p.id, p.kind)).toEqual(p.bytes);
    expect(await photos.get(s.gone, 'full')).toBeNull();
    const [rows] = await s.c.query<any[]>('SELECT photo_id, kind, HEX(sha256) h, object_key FROM sys_photo_copies ORDER BY photo_id, kind');
    expect(rows).toHaveLength(4);
    expect(rows[0].object_key).toMatch(/^photos\//);
    const second = await copyPhotosOnce(s.c, photos);
    expect(second.copied).toBe(0);
    await s.c.end();
  });

  it('a new photo is copied on the next run and only that one; a limit stops early', async () => {
    const s = await sourceShop('s13_h');
    const photos = memoryPhotos();
    expect((await copyPhotosOnce(s.c, photos, { limit: 3 })).copied).toBe(3);
    expect((await copyPhotosOnce(s.c, photos)).copied).toBe(1);
    const bytes = randomBytes(700);
    await insert(s.c, 'design_photos', { id: uuid(), kind: 'full', design_id: s.w.design.id, mime: 'image/png', byte_size: 700, sha256: sha(bytes), bytes });
    expect((await copyPhotosOnce(s.c, photos)).copied).toBe(1);
    await s.c.end();
  });

  it('a photo whose stored bytes no longer match its sha256 is not copied and is reported', async () => {
    const s = await sourceShop('s13_i');
    await s.c.query("UPDATE design_photos SET sha256 = UNHEX(REPEAT('ab', 32)) WHERE id = ? AND kind = 'thumb'", [s.ids[0]]);
    const photos = memoryPhotos();
    const r = await copyPhotosOnce(s.c, photos);
    expect(r.copied).toBe(3);
    expect(r.failed).toHaveLength(1);
    expect(r.failed[0]).toMatchObject({ id: s.ids[0], kind: 'thumb' });
    expect(r.failed[0].error).toMatch(/sha256/);
    const [[n]] = await s.c.query<any[][]>('SELECT COUNT(*) AS n FROM sys_photo_copies');
    expect(Number((n as any).n)).toBe(3);
    await s.c.end();
  });

  it('a store that fails on one photo does not stop the others and records nothing for the failed one', async () => {
    const s = await sourceShop('s13_j');
    const mem = memoryPhotos();
    const flaky = { ...mem, put: async (id: string, kind: string, b: Buffer) => { if (id === s.ids[1] && kind === 'full') throw new Error('bucket said 503'); return mem.put(id, kind, b); }, get: mem.get };
    const r = await copyPhotosOnce(s.c, flaky);
    expect(r.copied).toBe(3);
    expect(r.failed).toEqual([{ id: s.ids[1], kind: 'full', error: 'bucket said 503' }]);
    const retry = await copyPhotosOnce(s.c, mem);
    expect(retry.copied).toBe(1);
    await s.c.end();
  });
});

describe('restoreDatabase (B4, T-R02 database half)', () => {
  async function roundTrip(name: string) {
    const s = await sourceShop(name);
    const photos = memoryPhotos();
    await copyPhotosOnce(s.c, photos);
    const store = memoryStore();
    const manifest = await exportDatabase(s.c, store.sink);
    const t = await emptyDb(`${name}_r`);
    const report = await restoreDatabase(t.c, store.source, photos);
    return { s, t, store, photos, manifest, report };
  }

  it('rebuilds an empty database: every table has the same rows, the same content hash, the photos are back with their bytes, and the nightly check passes', async () => {
    const { s, t, report } = await roundTrip('s13_k');
    expect(report.problems).toEqual([]);
    expect(report.ok).toBe(true);
    for (const x of report.tables) expect([x.name, x.rows_restored, x.hash_ok]).toEqual([x.name, x.rows_expected, true]);
    expect(report.photos).toEqual({ live_expected: 4, restored: 4, missing: [] });
    expect(report.views).toBe(4);
    expect(report.fk_orphans).toEqual([]);
    expect(report.invariants).toMatchObject({ ok: true });
    expect(await baseTables(t.c)).toEqual(await baseTables(s.c));
    const [src] = await s.c.query<any[]>('SELECT id, kind, HEX(sha256) h, byte_size, removed_at, bytes IS NULL AS nb FROM design_photos ORDER BY id, kind');
    const [dst] = await t.c.query<any[]>('SELECT id, kind, HEX(sha256) h, byte_size, removed_at, bytes IS NULL AS nb FROM design_photos ORDER BY id, kind');
    expect(dst).toEqual(src);
    const [bytes] = await t.c.query<any[]>('SELECT sha256, bytes FROM design_photos WHERE bytes IS NOT NULL');
    for (const b of bytes) expect(sha(b.bytes).equals(b.sha256)).toBe(true);
    await s.c.end();
    await t.c.end();
  });

  it('the customers, balances and ledger of the restored copy are the same as the source (views included)', async () => {
    const { s, t } = await roundTrip('s13_l');
    for (const q of [
      'SELECT id, name, mobile, address FROM customers ORDER BY id',
      'SELECT * FROM customer_balances ORDER BY id',
      'SELECT * FROM customer_ledger ORDER BY customer_id, entry_date, entry_at, kind_rank, id',
      'SELECT * FROM bill_summary ORDER BY id',
      'SELECT * FROM daily_totals ORDER BY business_date, mode',
    ]) {
      expect((await t.c.query<any[]>(q))[0], q).toEqual((await s.c.query<any[]>(q))[0]);
    }
    const [r] = await t.c.query<any[]>("SELECT name, address FROM customers WHERE mobile = '9000000001'");
    expect(r[0].name).toBe('Siddhi 💍 सिद्धि जैन');
    expect(r[0].address).toBe('Jaishri Gold Palace, "Main" Road\nline two \\ backslash');
    expect((await runInvariants(t.c)).ok).toBe(true);
    await s.c.end();
    await t.c.end();
  });

  it('keeps what the application relies on: constraints still refuse bad rows, the counters continue, AUTO_INCREMENT continues', async () => {
    const { s, t } = await roundTrip('s13_m');
    expect((await errorOf(() => t.c.query("INSERT INTO receipts (id, customer_id, kind, mode, amount, paid_on) VALUES (UUID(), ?, 'money', 'Credit', 10, '2026-10-15')", [s.w.a.id])))?.errno).toBe(4025);
    const [c1] = await t.c.query<any[]>("SELECT series, last_value, seed_value FROM sys_counters ORDER BY series");
    expect(c1).toEqual((await s.c.query<any[]>("SELECT series, last_value, seed_value FROM sys_counters ORDER BY series"))[0]);
    await t.c.query("INSERT INTO audit_log (table_name, row_id, action) VALUES ('x', '1', 'event')");
    const [[a]] = await t.c.query<any[][]>('SELECT MAX(id) AS m, COUNT(*) AS n FROM audit_log');
    expect(Number((a as any).m)).toBeGreaterThan(Number((a as any).n) - 1);
    const [m] = await t.c.query<any[]>('SELECT version, checksum FROM schema_migrations ORDER BY version');
    expect(m).toEqual((await s.c.query<any[]>('SELECT version, checksum FROM schema_migrations ORDER BY version'))[0]);
    await s.c.end();
    await t.c.end();
  });

  it('refuses a database that already has tables, and changes nothing in it', async () => {
    const s = await sourceShop('s13_n');
    const photos = memoryPhotos();
    await copyPhotosOnce(s.c, photos);
    const store = memoryStore();
    await exportDatabase(s.c, store.sink);
    const t = await emptyDb('s13_n_r');
    await t.c.query('CREATE TABLE precious (id INT PRIMARY KEY)');
    await t.c.query('INSERT INTO precious VALUES (1)');
    await expect(restoreDatabase(t.c, store.source, photos)).rejects.toThrow(/not empty/);
    expect(await baseTables(t.c)).toEqual(['precious']);
    const live = await restoreDatabase(s.c, store.source, photos).catch((e: Error) => e);
    expect(String(live)).toMatch(/not empty/); // never over the live database
    await s.c.end();
    await t.c.end();
  });

  it('a photo missing from the photo copy fails the restore and names it; with allowMissingPhotos it is skipped and listed, and so is its copy row', async () => {
    const s = await sourceShop('s13_o');
    const photos = memoryPhotos();
    await copyPhotosOnce(s.c, photos);
    const store = memoryStore();
    await exportDatabase(s.c, store.sink);
    photos.objects.delete(`${s.ids[0]}/thumb`);
    const t1 = await emptyDb('s13_o_r1');
    const bad = await restoreDatabase(t1.c, store.source, photos).catch((e: Error) => e);
    expect(String(bad)).toContain(s.ids[0]);
    expect(String(bad)).toMatch(/missing/i);
    const t2 = await emptyDb('s13_o_r2');
    const report = await restoreDatabase(t2.c, store.source, photos, { allowMissingPhotos: true });
    expect(report.photos.missing).toEqual([{ id: s.ids[0], kind: 'thumb' }]);
    expect(report.photos.restored).toBe(3);
    expect(report.ok).toBe(false); // an incomplete restore is never "ok"
    expect(report.problems.join(' ')).toContain('thumb');
    const [[n]] = await t2.c.query<any[][]>("SELECT COUNT(*) AS n FROM sys_photo_copies WHERE photo_id = ? AND kind = 'thumb'", [s.ids[0]]);
    expect(Number((n as any).n)).toBe(0);
    for (const x of [s.c, t1.c, t2.c]) await x.end();
  });

  it('a photo object whose bytes do not hash to the recorded sha256 is refused', async () => {
    const s = await sourceShop('s13_p');
    const photos = memoryPhotos();
    await copyPhotosOnce(s.c, photos);
    const store = memoryStore();
    await exportDatabase(s.c, store.sink);
    photos.objects.set(`${s.ids[1]}/full`, randomBytes(6000));
    const t = await emptyDb('s13_p_r');
    const err = await restoreDatabase(t.c, store.source, photos).catch((e: Error) => e);
    expect(String(err)).toMatch(/sha256/);
    expect(String(err)).toContain(s.ids[1]);
    await s.c.end();
    await t.c.end();
  });

  it('an export file changed after it was written is refused before anything is loaded (its hash is in the manifest)', async () => {
    const s = await sourceShop('s13_q');
    const photos = memoryPhotos();
    await copyPhotosOnce(s.c, photos);
    const store = memoryStore();
    await exportDatabase(s.c, store.sink);
    store.files.set('data/receipts.ndjson', store.files.get('data/receipts.ndjson')!.replace('400.00', '4000.00'));
    const t = await emptyDb('s13_q_r');
    const err = await restoreDatabase(t.c, store.source, photos).catch((e: Error) => e);
    expect(String(err)).toMatch(/receipts/);
    expect(String(err)).toMatch(/hash/i);
    expect(await baseTables(t.c)).toEqual([]); // nothing was created: the check runs first
    await s.c.end();
    await t.c.end();
  });

  it('a manifest from another format is refused', async () => {
    const store = memoryStore();
    store.files.set('manifest.json', JSON.stringify({ format: 'something-else' }));
    const t = await emptyDb('s13_r_r');
    await expect(restoreDatabase(t.c, store.source, memoryPhotos())).rejects.toThrow(/format/);
    await t.c.end();
  });

  it('optional triggers (the append-only audit log) are exported and come back last, working', async () => {
    const s = await sourceShop('s13_s', { optional: true });
    const photos = memoryPhotos();
    await copyPhotosOnce(s.c, photos);
    const store = memoryStore();
    const m = await exportDatabase(s.c, store.sink);
    expect(m.triggers.length).toBeGreaterThanOrEqual(2);
    const t = await emptyDb('s13_s_r');
    const report = await restoreDatabase(t.c, store.source, photos);
    expect(report.ok).toBe(true);
    expect(report.triggers).toBe(m.triggers.length);
    const err = await errorOf(() => t.c.query("UPDATE audit_log SET row_id = 'changed'"));
    expect(err).not.toBeNull(); // the trigger refuses
    await s.c.end();
    await t.c.end();
  });

  it('works through folders on disk as well as memory (what the job and the Mac tool will use)', async () => {
    const s = await sourceShop('s13_t');
    const dir = mkdtempSync(path.join(tmpdir(), 'jv-export-'));
    dirs.push(dir);
    const photosDir = path.join(dir, 'photos');
    const photos = directoryPhotos(photosDir);
    await copyPhotosOnce(s.c, photos);
    const store = directoryStore(path.join(dir, 'export'));
    await exportDatabase(s.c, store.sink);
    const t = await emptyDb('s13_t_r');
    const report = await restoreDatabase(t.c, store.source, directoryPhotos(photosDir), { pageSize: 3 });
    expect(report.ok).toBe(true);
    expect(report.photos.restored).toBe(4);
    await s.c.end();
    await t.c.end();
  });

  it('a restore that damages data would be caught: the content hash of every table is compared after the load', async () => {
    const s = await sourceShop('s13_u');
    const photos = memoryPhotos();
    await copyPhotosOnce(s.c, photos);
    const store = memoryStore();
    await exportDatabase(s.c, store.sink);
    const t = await emptyDb('s13_u_r');
    const report = await restoreDatabase(t.c, store.source, photos);
    expect(report.tables.every((x) => x.hash_ok)).toBe(true);
    await t.c.query("UPDATE customers SET name = CONCAT(name, 'x') WHERE mobile = '9000000001'");
    const again = memoryStore();
    const m2 = await exportDatabase(t.c, again.sink);
    const original = JSON.parse(store.files.get('manifest.json')!);
    const changed = m2.tables.filter((x) => x.sha256 !== original.tables.find((o: any) => o.name === x.name).sha256).map((x) => x.name);
    expect(changed).toEqual(['customers']);
    await s.c.end();
    await t.c.end();
  });
});

describe('stripDefiner', () => {
  it('removes the DEFINER clause of a view or trigger and nothing else', () => {
    expect(stripDefiner('CREATE ALGORITHM=UNDEFINED DEFINER=`jv_app`@`%` SQL SECURITY INVOKER VIEW `v` AS select 1')).toBe('CREATE ALGORITHM=UNDEFINED SQL SECURITY INVOKER VIEW `v` AS select 1');
    expect(stripDefiner("CREATE DEFINER=`u123_x`@`localhost` TRIGGER t BEFORE UPDATE ON a FOR EACH ROW SIGNAL SQLSTATE '45000'")).toBe("CREATE TRIGGER t BEFORE UPDATE ON a FOR EACH ROW SIGNAL SQLSTATE '45000'");
    expect(stripDefiner("CREATE DEFINER=CURRENT_USER TRIGGER t BEFORE UPDATE ON a FOR EACH ROW SET @definer = 'DEFINER=x'")).toContain("'DEFINER=x'");
    expect(stripDefiner('CREATE TABLE a (b INT)')).toBe('CREATE TABLE a (b INT)');
  });
});

describe('a deep shop (30,000 bills): the drill\'s time budget is 2 hours; this takes seconds', () => {
  it('exports and restores 30,000 bills, 15,000 receipts and their allocations, equal in every table', async () => {
    const { db, c } = await migratedDb('s13_scale');
    dbs.push(db);
    await c.query(`INSERT INTO customers (id, name, mobile, customer_type) SELECT UUID_v4(), CONCAT('Scale ', seq), CONCAT('9', LPAD(seq, 9, '0')), 'Retail' FROM seq_1_to_3000`);
    await c.query(`INSERT INTO bills (id, bill_no, customer_id, bill_date, doc_type, sale_type, subtotal, grand_total, created_at)
                   SELECT UUID_v4(), CONCAT('JV-2026-', LPAD(s.seq, 5, '0')), cu.id, DATE_ADD('2024-01-01', INTERVAL (s.seq DIV 40) DAY), 'estimate', 'Retail', 1000, 1000, TIMESTAMPADD(SECOND, s.seq, '2024-01-01 05:00:00')
                   FROM seq_1_to_30000 s JOIN (SELECT id, ROW_NUMBER() OVER (ORDER BY mobile) AS rn FROM customers WHERE name LIKE 'Scale %') cu ON cu.rn = ((s.seq - 1) MOD 3000) + 1`);
    await c.query("INSERT INTO sys_counters (series, last_value, seed_value) VALUES ('bill:JV:2026', 30000, 0)");
    await c.query(`INSERT INTO receipts (id, customer_id, kind, mode, amount, paid_on, created_at) SELECT b.id, b.customer_id, 'money', 'Cash', 1000, b.bill_date, b.created_at FROM bills b WHERE CAST(SUBSTRING_INDEX(b.bill_no, '-', -1) AS UNSIGNED) MOD 2 = 1`);
    await c.query(`INSERT INTO receipt_allocations (id, receipt_id, bill_id, customer_id, amount) SELECT UUID_v4(), b.id, b.id, b.customer_id, 1000 FROM bills b WHERE CAST(SUBSTRING_INDEX(b.bill_no, '-', -1) AS UNSIGNED) MOD 2 = 1`);
    const store = memoryStore();
    const t0 = Date.now();
    const manifest = await exportDatabase(c, store.sink);
    const tExport = Date.now() - t0;
    const t = await emptyDb('s13_scale_r');
    const t1 = Date.now();
    const report = await restoreDatabase(t.c, store.source, memoryPhotos());
    const tRestore = Date.now() - t1;
    console.log(`[s13] export ${tExport} ms, restore + verify ${tRestore} ms for ${manifest.tables.reduce((n, x) => n + x.rows, 0)} rows`);
    expect(report.problems).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.tables.find((x) => x.name === 'bills')!.rows_restored).toBe(30000);
    // counted straight in both databases, not through the export code: no page may overlap or skip a row (a UUID key once did, through an ORDER BY alias)
    for (const tb of manifest.tables) {
      const [[src]] = await c.query<any[][]>(`SELECT COUNT(*) AS n FROM \`${tb.name}\``);
      const [[dst]] = await t.c.query<any[][]>(`SELECT COUNT(*) AS n FROM \`${tb.name}\``);
      expect([tb.name, tb.rows, Number((dst as any).n)], tb.name).toEqual([tb.name, Number((src as any).n), Number((src as any).n)]);
    }
    const [[distinct]] = await t.c.query<any[][]>('SELECT COUNT(DISTINCT id) AS n FROM bills');
    expect(Number((distinct as any).n)).toBe(30000);
    expect(tExport + tRestore).toBeLessThan(120_000);
    await c.end();
    await t.c.end();
  }, 300000);
});
