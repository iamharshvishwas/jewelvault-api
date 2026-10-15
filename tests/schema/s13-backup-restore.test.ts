import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import mysql, { type Connection } from 'mysql2/promise';
import { afterAll, describe, expect, it } from 'vitest';
import { HOST, PORT, appConn, dropDb, errorOf, freshDb, rootConn } from '../helpers';
import { copyPhotosOnce, directoryPhotos, directoryStore, exportDatabase, memoryPhotos, memoryStore } from '../../scripts/backup.mjs';
import { listMigrations } from '../../scripts/migrate.mjs';
import { restoreDatabase } from '../../scripts/restore.mjs';
import { runInvariants } from '../../scripts/invariants.mjs';
import { T, V, cleanWorld, insert, migratedDb, uuid } from './support';

// Spec B2 (the export and the once-only photo copy, draft 5) and B4 / T-R02 (restore into an empty MariaDB and prove it equal), database half.
// The encryption, the bucket and the Docker drill on the Mac are not here; this is the part that reads and writes the database.
// Draft 5: the export holds NO table definitions (the migration files are the schema), leaves out sessions, the login counters and old idempotency rows, is read in a READ ONLY snapshot,
// and the restore applies the migration files, loads in foreign-key order, inserts each live photo with its bytes, tombstones what the photo copy cannot supply, and applies triggers last.

const dbs: string[] = [];
const dirs: string[] = [];
afterAll(async () => {
  for (const d of dbs) await dropDb(d);
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const sha = (b: Buffer) => createHash('sha256').update(b).digest();

/**
 * A source shop: the clean books of the invariants tests plus a Hindi/emoji name, a login session (not exported), live and removed photos, audit rows,
 * old and new idempotency rows, and re-issued bills whose ids sort BEFORE the bill they replace (a foreign key inside one table).
 */
async function sourceShop(name: string, opts: { optional?: boolean } = {}) {
  const { db, c } = await migratedDb(name, { optional: opts.optional });
  dbs.push(db);
  const w = await cleanWorld(c);
  await insert(c, 'customers', V.customer({ name: 'Siddhi 💍 सिद्धि जैन', mobile: '9000000001', address: 'Jaishri Gold Palace, "Main" Road\nline two \\ backslash' }));
  const user = V.user({ active: 1 });
  await insert(c, 'users', user);
  await insert(c, 'sessions', V.session(user.id));
  await insert(c, 'sys_login_attempts', { scope: 'email', slot: 5, window_start: '2026-10-15 10:00:00.000000', n: 2 });
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
  const batch = uuid();
  await insert(c, 'sys_import_batches', { id: batch, name: `b-${batch}` });
  for (let i = 0; i < 12; i++) {
    const parent = (await insert(c, 'bills', V.bill(w.a.id, { bill_no: `JV-2026-9${String(i).padStart(3, '0')}`, status: 'cancelled', cancel_reason: 'wrong', cancelled_at: '2026-10-04 09:00:00.000000', cancelled_on: '2026-10-04', cancelled_by: uuid(), import_batch_id: batch, request_id: null }))) as { id: string };
    await insert(c, 'bills', V.bill(w.a.id, { bill_no: `JV-2026-8${String(i).padStart(3, '0')}`, reissue_of: parent.id, import_batch_id: batch, request_id: null }));
  }
  await insert(c, 'sys_idempotency', { request_id: uuid(), fn: 'create_bill', actor: user.id, args_hash: 'a'.repeat(64) });
  await c.query("INSERT INTO sys_idempotency (request_id, fn, actor, args_hash, created_at) VALUES (UUID_v4(), 'create_bill', ?, ?, UTC_TIMESTAMP(6) - INTERVAL 100 DAY)", [user.id, 'b'.repeat(64)]);
  await c.query("INSERT INTO sys_counters (series, last_value, seed_value) VALUES ('bill:JV:2026', 9011, 4) ON DUPLICATE KEY UPDATE last_value = 9011, seed_value = 9011");
  return { db, c, w, photoRows, ids, gone, user };
}

async function emptyDb(name: string) {
  const db = await freshDb(name);
  dbs.push(db);
  return { db, c: await appConn(db) };
}

const baseTables = async (c: Connection) =>
  ((await c.query<any[]>("SELECT TABLE_NAME n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE'"))[0] as any[]).map((r) => r.n as string).sort();
const createOf = async (c: Connection, table: string) => String(((await c.query<any[]>(`SHOW CREATE TABLE \`${table}\``))[0] as any[])[0]['Create Table']).replace(/ AUTO_INCREMENT=\d+/, '');

describe('exportDatabase (B2)', () => {
  it('writes a manifest naming every exported table with its row count and file hash, the migration files it was made with, and NO table definition, view or trigger', async () => {
    const s = await sourceShop('s13_a');
    const store = memoryStore();
    const m = await exportDatabase(s.c, store.sink);
    expect(m.format).toBe('jewelvault-export-1');
    const all = await baseTables(s.c);
    expect(m.tables.map((t) => t.name).sort()).toEqual(all.filter((t) => !['schema_migrations', 'sessions', 'sys_login_attempts'].includes(t)));
    expect(m.omitted).toEqual({
      schema_migrations: expect.stringContaining('migration'),
      sessions: expect.stringContaining('login'),
      sys_login_attempts: expect.stringContaining('counters'),
    });
    expect(m.migrations).toEqual(listMigrations().map((x) => ({ version: x.version, name: x.name, checksum: x.checksum })));
    expect(m).not.toHaveProperty('views');
    expect(m).not.toHaveProperty('triggers');
    for (const t of m.tables) {
      expect(t).not.toHaveProperty('create');
      expect(t.primary_key.length, t.name).toBeGreaterThan(0);
      const text = store.files.get(t.file)!;
      expect(createHash('sha256').update(text).digest('hex'), t.name).toBe(t.sha256);
      expect(text === '' ? 0 : text.trimEnd().split('\n').length, t.name).toBe(t.rows);
      if (t.name === 'sys_idempotency') continue; // exported in part, below
      const [[n]] = await s.c.query<any[][]>(`SELECT COUNT(*) AS n FROM \`${t.name}\``);
      expect(t.rows, t.name).toBe(Number((n as any).n));
    }
    expect(JSON.parse(store.files.get('manifest.json')!)).toEqual(m);
    expect(m.excluded).toEqual({ design_photos: ['bytes'] });
    expect(m.live_photos).toBe(4);
    expect(m.has_triggers).toBe(false);
    for (const k of store.files.keys()) expect(k).not.toMatch(/sessions|login_attempts|schema_migrations/);
    await s.c.end();
  });

  it('leaves out sessions, the login counters and the idempotency rows older than 90 days (and says so); recent ones stay', async () => {
    const s = await sourceShop('s13_a2');
    const store = memoryStore();
    const m = await exportDatabase(s.c, store.sink);
    expect(m.filtered).toEqual({ sys_idempotency: expect.stringContaining('90 days') });
    const rows = store.files.get('data/sys_idempotency.ndjson')!.trim().split('\n').map((l) => JSON.parse(l));
    expect(rows).toHaveLength(1);
    expect(rows[0].args_hash).toBe('a'.repeat(64));
    const [[total]] = await s.c.query<any[][]>('SELECT COUNT(*) AS n FROM sys_idempotency');
    expect(Number((total as any).n)).toBe(2);
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
    expect(store.files.get('data/design_photos.ndjson')!.length).toBeLessThan(3000); // 5 rows of metadata, not 15 kB of photo
    await s.c.end();
  });

  it('keeps binary columns (a photo hash) as hex, text as text, NULL as null, and money as exact text', async () => {
    const s = await sourceShop('s13_c');
    const store = memoryStore();
    await exportDatabase(s.c, store.sink);
    const p0 = s.photoRows[0];
    const row = store.files.get('data/design_photos.ndjson')!.trim().split('\n').map((l) => JSON.parse(l)).find((r) => r.id === p0.id && r.kind === p0.kind);
    expect(row.sha256).toBe(sha(p0.bytes).toString('hex').toUpperCase());
    expect(row.removed_at).toBeNull();
    const bill = store.files.get('data/bills.ndjson')!.trim().split('\n').map((l) => JSON.parse(l)).find((b) => b.bill_no === 'OB-0001');
    expect(bill.grand_total).toBe('300.50');
    expect(bill.fine_weight_due).toBe('2.000');
    expect(bill.cancelled_at).toBeNull();
    expect(bill.cancelled_on).toBeNull();
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

  it('uses ONE snapshot, and it is READ ONLY: a row committed by someone else while the export runs is not in it, and the session cannot write meanwhile', async () => {
    const s = await sourceShop('s13_e');
    const other = await appConn(s.db);
    const store = memoryStore();
    let done = false;
    let writeError: number | undefined;
    const m = await exportDatabase(s.c, store.sink, {
      between: async (table) => {
        if (table !== 'bills' || done) return;
        done = true;
        writeError = (await errorOf(() => s.c.query("INSERT INTO sys_error_log (level, code, message) VALUES ('error', 'X', 'y')")))?.errno;
        await insert(other, 'customers', V.customer({ name: 'Late customer', mobile: '9111111111' }));
      },
    });
    expect(done).toBe(true);
    expect(writeError).toBe(1792); // ER_CANT_EXECUTE_IN_READ_ONLY_TRANSACTION
    expect(store.files.get('data/customers.ndjson')!).not.toContain('Late customer'); // customers is read after bills, inside the same snapshot
    expect(m.tables.find((t) => t.name === 'customers')!.rows).toBe(4);
    await other.end();
    await s.c.end();
  });

  it('leaves the isolation level of the caller alone and ends its transaction', async () => {
    const s = await sourceShop('s13_f');
    await exportDatabase(s.c, memoryStore().sink);
    const [[r]] = await s.c.query<any[][]>('SELECT @@session.tx_isolation AS l, @@in_transaction AS t, @@session.tx_read_only AS ro');
    expect([(r as any).l, String((r as any).t), String((r as any).ro)]).toEqual(['READ-COMMITTED', '0', '0']);
    await s.c.end();
  });

  it('exports a database with the optional triggers and says so (the restore applies them last)', async () => {
    const s = await sourceShop('s13_f2', { optional: true });
    expect((await exportDatabase(s.c, memoryStore().sink)).has_triggers).toBe(true);
    await s.c.end();
  });
});

describe('copyPhotosOnce (B2 part 2, D25)', () => {
  it('copies each live photo that has no copy row, once, and records its sha256 and size; removed photos are never copied; a second run copies nothing', async () => {
    const s = await sourceShop('s13_g');
    const photos = memoryPhotos();
    const first = await copyPhotosOnce(s.c, photos);
    expect(first).toEqual({ copied: 4, bytes: 2 * 6000 + 2 * 900, failed: [] });
    expect(photos.objects.size).toBe(4);
    for (const p of s.photoRows) expect(await photos.get(p.id, p.kind)).toEqual(p.bytes);
    expect(await photos.get(s.gone, 'full')).toBeNull();
    const [rows] = await s.c.query<any[]>('SELECT photo_id, kind, HEX(sha256) h, size FROM sys_photo_copies ORDER BY photo_id, kind');
    expect(rows).toHaveLength(4);
    for (const r of rows) {
      const p = s.photoRows.find((x) => x.id === r.photo_id && x.kind === r.kind)!;
      expect([r.h, r.size]).toEqual([sha(p.bytes).toString('hex').toUpperCase(), p.bytes.length]);
    }
    expect((await copyPhotosOnce(s.c, photos)).copied).toBe(0);
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

  it('a photo whose stored bytes no longer match its sha256 is not uploaded, not recorded, and reported', async () => {
    const s = await sourceShop('s13_i');
    await s.c.query("UPDATE design_photos SET sha256 = UNHEX(REPEAT('ab', 32)) WHERE id = ? AND kind = 'thumb'", [s.ids[0]]);
    const photos = memoryPhotos();
    const r = await copyPhotosOnce(s.c, photos);
    expect(r.copied).toBe(3);
    expect(r.failed).toHaveLength(1);
    expect(r.failed[0]).toMatchObject({ id: s.ids[0], kind: 'thumb' });
    expect(r.failed[0].error).toMatch(/sha256/);
    expect(photos.objects.has(`${s.ids[0]}/thumb`)).toBe(false);
    expect(Number((((await s.c.query<any[]>('SELECT COUNT(*) AS n FROM sys_photo_copies'))[0]) as any[])[0].n)).toBe(3);
    await s.c.end();
  });

  it('a store that fails on one upload does not stop the others and records nothing for the failed one; the next run retries only that one', async () => {
    const s = await sourceShop('s13_j');
    const mem = memoryPhotos();
    const flaky = { ...mem, put: async (id: string, kind: string, b: Buffer) => { if (id === s.ids[1] && kind === 'full') throw new Error('bucket said 503'); return mem.put(id, kind, b); } };
    const r = await copyPhotosOnce(s.c, flaky);
    expect(r.copied).toBe(3);
    expect(r.failed).toEqual([{ id: s.ids[1], kind: 'full', error: 'bucket said 503' }]);
    expect((await copyPhotosOnce(s.c, mem)).copied).toBe(1);
    await s.c.end();
  });

  it('a copy is remembered only after HEAD confirms the stored size: a wrong size or a missing object records nothing (T-R03)', async () => {
    const s = await sourceShop('s13_j2');
    const mem = memoryPhotos();
    const lying = {
      ...mem,
      head: async (id: string, kind: string) => (id === s.ids[0] && kind === 'full' ? { size: 5999 } : id === s.ids[0] && kind === 'thumb' ? null : mem.head(id, kind)),
    };
    const r = await copyPhotosOnce(s.c, lying);
    expect(r.copied).toBe(2);
    expect(r.failed.map((f) => [f.id, f.kind])).toEqual(expect.arrayContaining([[s.ids[0], 'full'], [s.ids[0], 'thumb']]));
    expect(r.failed.find((f) => f.kind === 'full')!.error).toMatch(/size/);
    expect(r.failed.find((f) => f.kind === 'thumb')!.error).toMatch(/not in the bucket|missing/i);
    const [rows] = await s.c.query<any[]>('SELECT photo_id FROM sys_photo_copies WHERE photo_id = ?', [s.ids[0]]);
    expect(rows).toHaveLength(0);
    await s.c.end();
  });

  it('a photo removed after it was copied keeps its copy row (no foreign key, P3)', async () => {
    const s = await sourceShop('s13_j3');
    await copyPhotosOnce(s.c, memoryPhotos());
    await s.c.query("UPDATE design_photos SET removed_at = '2026-10-15 12:00:00.000000', bytes = NULL WHERE id = ? AND kind = 'full'", [s.ids[0]]);
    expect(Number((((await s.c.query<any[]>('SELECT COUNT(*) AS n FROM sys_photo_copies'))[0]) as any[])[0].n)).toBe(4);
    expect((await copyPhotosOnce(s.c, memoryPhotos())).copied).toBe(0);
    await s.c.end();
  });
});

describe('restoreDatabase (B4, T-R02 database half)', () => {
  async function roundTrip(name: string, opts: { optional?: boolean } = {}) {
    const s = await sourceShop(name, opts);
    const photos = memoryPhotos();
    await copyPhotosOnce(s.c, photos);
    const store = memoryStore();
    const manifest = await exportDatabase(s.c, store.sink);
    const t = await emptyDb(`${name}_r`);
    const report = await restoreDatabase(t.c, store.source, photos);
    return { s, t, store, photos, manifest, report };
  }

  it('rebuilds an empty database from the migration files and the data: every table has the same rows and content hash, the photos are back with their bytes, and the nightly check passes', async () => {
    const { s, t, report } = await roundTrip('s13_k');
    expect(report.problems).toEqual([]);
    expect(report.ok).toBe(true);
    for (const x of report.tables) expect([x.name, x.rows_restored, x.hash_ok]).toEqual([x.name, x.rows_expected, true]);
    expect(report.photos).toEqual({ live_expected: 4, restored: 4, tombstoned: [] });
    expect(report.fk_orphans).toEqual([]);
    expect(report.invariants).toMatchObject({ ok: true });
    expect(await baseTables(t.c)).toEqual(await baseTables(s.c));
    for (const table of await baseTables(s.c)) expect(await createOf(t.c, table), table).toBe(await createOf(s.c, table)); // the migrations gave the same schema
    const [src] = await s.c.query<any[]>('SELECT id, kind, HEX(sha256) h, byte_size, removed_at, bytes IS NULL AS nb FROM design_photos ORDER BY id, kind');
    const [dst] = await t.c.query<any[]>('SELECT id, kind, HEX(sha256) h, byte_size, removed_at, bytes IS NULL AS nb FROM design_photos ORDER BY id, kind');
    expect(dst).toEqual(src);
    for (const b of (await t.c.query<any[]>('SELECT sha256, bytes FROM design_photos WHERE bytes IS NOT NULL'))[0]) expect(sha(b.bytes).equals(b.sha256)).toBe(true);
    await s.c.end();
    await t.c.end();
  });

  it('what was left out of the export is empty in the copy (sessions, login counters, old idempotency rows) and the migration record is the repository\'s', async () => {
    const { s, t } = await roundTrip('s13_k2');
    for (const table of ['sessions', 'sys_login_attempts']) expect(Number((((await t.c.query<any[]>(`SELECT COUNT(*) AS n FROM ${table}`))[0]) as any[])[0].n), table).toBe(0);
    expect(Number((((await t.c.query<any[]>('SELECT COUNT(*) AS n FROM sys_idempotency'))[0]) as any[])[0].n)).toBe(1);
    const [m] = await t.c.query<any[]>('SELECT version, checksum FROM schema_migrations ORDER BY version');
    expect(m).toEqual((await s.c.query<any[]>('SELECT version, checksum FROM schema_migrations ORDER BY version'))[0]);
    await s.c.end();
    await t.c.end();
  });

  it('loads in foreign-key order with the keys ON: bills that replace others (reissue_of) come after the bill they replace, whatever order their ids sort in', async () => {
    const { s, t, report } = await roundTrip('s13_k3');
    expect(report.ok).toBe(true);
    const [pairs] = await s.c.query<any[]>('SELECT id, reissue_of FROM bills WHERE reissue_of IS NOT NULL ORDER BY id');
    expect(pairs).toHaveLength(12);
    // in the source's own id order at least one replacement sorts before the bill it replaces (otherwise this test would prove nothing)
    const order = new Map((await s.c.query<any[]>('SELECT id FROM bills ORDER BY id'))[0].map((r: any, i: number) => [r.id, i]));
    expect(pairs.some((p) => (order.get(p.id) as number) < (order.get(p.reissue_of) as number))).toBe(true);
    expect(Number((((await t.c.query<any[]>('SELECT COUNT(*) AS n FROM bills WHERE reissue_of IS NOT NULL'))[0]) as any[])[0].n)).toBe(12);
    await s.c.end();
    await t.c.end();
  });

  it('the customers, balances and ledger of the restored copy are the same as the source (the four reads included)', async () => {
    const { s, t } = await roundTrip('s13_l');
    for (const q of [
      'SELECT id, name, mobile, address FROM customers ORDER BY id',
      `SELECT * FROM ${T.customer_balances} ORDER BY id`,
      `SELECT * FROM ${T.customer_ledger} ORDER BY customer_id, entry_date, entry_at, kind_rank, id`,
      `SELECT * FROM ${T.bill_summary} ORDER BY id`,
      `SELECT * FROM ${T.daily_totals} ORDER BY business_date, mode`,
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
    expect((await t.c.query<any[]>('SELECT series, last_value, seed_value FROM sys_counters ORDER BY series'))[0]).toEqual((await s.c.query<any[]>('SELECT series, last_value, seed_value FROM sys_counters ORDER BY series'))[0]);
    await t.c.query("INSERT INTO audit_log (table_name, row_id, action) VALUES ('x', '1', 'event')");
    const [[a]] = await t.c.query<any[][]>('SELECT MAX(id) AS m, COUNT(*) AS n FROM audit_log');
    expect(Number((a as any).m)).toBeGreaterThan(Number((a as any).n) - 1);
    await s.c.end();
    await t.c.end();
  });

  it('refuses a database that already has tables, and changes nothing in it (never over the live database)', async () => {
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
    expect(String(await restoreDatabase(s.c, store.source, photos).catch((e: Error) => e))).toMatch(/not empty/);
    await s.c.end();
    await t.c.end();
  });

  it('a photo missing from the photo copy is inserted as a TOMBSTONE (removed_at = the restore time), listed in the report, and the report is not ok; the others are restored with their bytes', async () => {
    const s = await sourceShop('s13_o');
    const photos = memoryPhotos();
    await copyPhotosOnce(s.c, photos);
    const store = memoryStore();
    await exportDatabase(s.c, store.sink);
    photos.objects.delete(`${s.ids[0]}/thumb`);
    const t = await emptyDb('s13_o_r');
    const before = Date.now();
    const report = await restoreDatabase(t.c, store.source, photos);
    expect(report.photos.tombstoned).toEqual([{ id: s.ids[0], kind: 'thumb', reason: 'missing' }]);
    expect(report.photos.restored).toBe(3);
    expect(report.ok).toBe(false);
    expect(report.problems.join(' ')).toContain(s.ids[0]);
    const [[row]] = await t.c.query<any[][]>("SELECT removed_at, bytes IS NULL AS nb, byte_size, HEX(sha256) AS h FROM design_photos WHERE id = ? AND kind = 'thumb'", [s.ids[0]]);
    expect(Number((row as any).nb)).toBe(1);
    expect(Date.parse(String((row as any).removed_at).replace(' ', 'T') + 'Z')).toBeGreaterThan(before - 5000);
    expect((row as any).byte_size).toBe(900); // what the photo was is kept
    const [live] = await t.c.query<any[]>('SELECT COUNT(*) AS n FROM design_photos WHERE bytes IS NOT NULL');
    expect(Number(live[0].n)).toBe(3);
    expect((await runInvariants(t.c)).ok).toBe(true); // the books are fine; only a photo is gone
    await s.c.end();
    await t.c.end();
  });

  it('a photo object whose bytes do not hash to the recorded sha256 is also tombstoned and listed, never loaded', async () => {
    const s = await sourceShop('s13_p');
    const photos = memoryPhotos();
    await copyPhotosOnce(s.c, photos);
    const store = memoryStore();
    await exportDatabase(s.c, store.sink);
    photos.objects.set(`${s.ids[1]}/full`, randomBytes(6000));
    photos.objects.set(`${s.ids[1]}/thumb`, randomBytes(77)); // wrong size as well
    const t = await emptyDb('s13_p_r');
    const report = await restoreDatabase(t.c, store.source, photos);
    expect(report.photos.tombstoned.map((x) => `${x.kind}:${x.reason}`).sort()).toEqual(['full:sha256', 'thumb:size']);
    expect(report.ok).toBe(false);
    const [rows] = await t.c.query<any[]>('SELECT kind, bytes IS NULL AS nb, removed_at IS NOT NULL AS rm FROM design_photos WHERE id = ? ORDER BY kind', [s.ids[1]]);
    expect(rows.map((r) => [r.kind, Number(r.nb), Number(r.rm)])).toEqual([['full', 1, 1], ['thumb', 1, 1]]);
    await s.c.end();
    await t.c.end();
  });

  it('a photo removed in the source stays a tombstone as it was (removed_at unchanged) and is not reported', async () => {
    const { s, t, report } = await roundTrip('s13_p2');
    const [[row]] = await t.c.query<any[][]>('SELECT removed_at FROM design_photos WHERE id = ?', [s.gone]);
    expect((row as any).removed_at).toBe('2026-10-10 05:00:00.000000');
    expect(report.photos.tombstoned).toEqual([]);
    await s.c.end();
    await t.c.end();
  });

  it('an export file changed after it was written is refused before anything is created (its hash is in the manifest)', async () => {
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
    expect(await baseTables(t.c)).toEqual([]);
    await s.c.end();
    await t.c.end();
  });

  it('migration files other than the ones the export was made with are refused before anything is created: the files ARE the schema', async () => {
    const s = await sourceShop('s13_q2');
    const store = memoryStore();
    await exportDatabase(s.c, store.sink);
    const manifest = JSON.parse(store.files.get('manifest.json')!);
    manifest.migrations[3].checksum = 'f'.repeat(64);
    store.files.set('manifest.json', JSON.stringify(manifest));
    const t = await emptyDb('s13_q2_r');
    const err = await restoreDatabase(t.c, store.source, memoryPhotos()).catch((e: Error) => e);
    expect(String(err)).toMatch(/migration/i);
    expect(String(err)).toContain(manifest.migrations[3].version);
    expect(await baseTables(t.c)).toEqual([]);
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

  it('optional triggers (the append-only audit log) come back LAST, so loading writes no audit rows of its own, and they work', async () => {
    const s = await sourceShop('s13_s', { optional: true });
    const photos = memoryPhotos();
    await copyPhotosOnce(s.c, photos);
    const store = memoryStore();
    const m = await exportDatabase(s.c, store.sink);
    expect(m.has_triggers).toBe(true);
    const t = await emptyDb('s13_s_r');
    const report = await restoreDatabase(t.c, store.source, photos);
    expect(report.ok).toBe(true);
    expect(report.triggers).toBe(2);
    expect((await errorOf(() => t.c.query("UPDATE audit_log SET row_id = 'changed'")))).not.toBeNull(); // the trigger refuses
    expect((await t.c.query<any[]>('SELECT COUNT(*) AS n FROM audit_log'))[0]).toEqual((await s.c.query<any[]>('SELECT COUNT(*) AS n FROM audit_log'))[0]);
    const t2 = await emptyDb('s13_s_r2');
    expect((await restoreDatabase(t2.c, store.source, photos, { triggers: false })).triggers).toBe(0);
    for (const x of [s.c, t.c, t2.c]) await x.end();
  });

  it('works as the restricted user of A3 (no Delete, Drop, Create view, Show view, Execute, Create routine, Alter routine, Event): it needs only the ten ticked boxes', async () => {
    const s = await sourceShop('s13_u0', { optional: true });
    const photos = memoryPhotos();
    await copyPhotosOnce(s.c, photos);
    const store = memoryStore();
    await exportDatabase(s.c, store.sink);
    const db = await freshDb('s13_u0_r');
    dbs.push(db);
    const root = await rootConn();
    await root.query("CREATE USER IF NOT EXISTS 'jv_a3b'@'%' IDENTIFIED BY 'spike_a3b_only'");
    await root.query(`GRANT SELECT, INSERT, UPDATE, CREATE, ALTER, INDEX, REFERENCES, TRIGGER, CREATE TEMPORARY TABLES, LOCK TABLES ON \`${db}\`.* TO 'jv_a3b'@'%'`);
    const u = await mysql.createConnection({ host: HOST, port: PORT, user: 'jv_a3b', password: 'spike_a3b_only', database: db, decimalNumbers: false, supportBigNumbers: true, bigNumberStrings: true, dateStrings: true });
    const report = await restoreDatabase(u, store.source, photos);
    expect(report.problems).toEqual([]);
    expect(report.ok).toBe(true);
    await u.end();
    await root.query("DROP USER IF EXISTS 'jv_a3b'@'%'");
    await root.end();
    await s.c.end();
  });

  it('works through folders on disk as well as memory (what the job spools to and the Mac tool reads)', async () => {
    const s = await sourceShop('s13_t');
    const dir = mkdtempSync(path.join(tmpdir(), 'jv-export-'));
    dirs.push(dir);
    const photosDir = path.join(dir, 'photos');
    const photos = directoryPhotos(photosDir);
    await copyPhotosOnce(s.c, photos);
    expect((await photos.head(s.ids[0], 'full'))?.size).toBe(6000);
    expect(await photos.head(uuid(), 'full')).toBeNull();
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
    const { s, t, store, report } = await roundTrip('s13_u');
    expect(report.tables.every((x) => x.hash_ok)).toBe(true);
    await t.c.query("UPDATE customers SET name = CONCAT(name, 'x') WHERE mobile = '9000000001'");
    const again = memoryStore();
    const m2 = await exportDatabase(t.c, again.sink);
    const original = JSON.parse(store.files.get('manifest.json')!);
    expect(m2.tables.filter((x) => x.sha256 !== original.tables.find((o: any) => o.name === x.name).sha256).map((x) => x.name)).toEqual(['customers']);
    await s.c.end();
    await t.c.end();
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
