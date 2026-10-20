import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Connection } from 'mysql2/promise';
import { afterAll, describe, expect, it } from 'vitest';
import { FILTERED, copyPhotosOnce, directoryPhotos, exportDatabase, memoryPhotos, memoryStore } from '../../scripts/backup.mjs';
import { restoreBackup } from '../../scripts/restore-cli.mjs';
import { restoreDatabase } from '../../scripts/restore.mjs';
import { appConn, dropDb, freshDb, scratchDatabase, sleep } from '../helpers';
import { V, cleanWorld, insert, migratedDb } from '../schema/support';
import { cleanUp, dump, dumpWorld, onCleanUp } from './dump-support';

// RV3a-F2 (implementation review 3, finding F2; B2, B4, T-R02): the export keeps the `sys_idempotency` rows younger than 90 days, "younger" being worked out at the moment of the export. The restore
// then exports the restored copy again and compares every table's sha256 with the manifest, and used to work "younger than 90 days" out AGAIN, at the moment of the restore: a row that was 3 seconds
// inside the window at the export is outside it at the restore, the re-export has one row fewer, and a CORRECT restore was reported "CHECKS FAILED" (exit code 1). The export now writes the cutoff it
// used into the manifest (`filter_cutoffs`), and the restore's re-export uses that same cutoff. An export made before this change has no cutoff in its manifest: it still restores, and the report says
// how the table was compared.

const dbs: string[] = [];
afterAll(async () => {
  for (const d of dbs) await dropDb(d);
  await cleanUp();
});

/** A small shop with three request rows: well inside the window, 3 seconds inside its edge, and long expired. */
async function shopWithEdgeRow(name: string) {
  const { db, c } = await migratedDb(name);
  dbs.push(db);
  await cleanWorld(c);
  await insert(c, 'customers', V.customer({ name: 'Siddhi', mobile: '9000000077' }));
  const actor = randomUUID();
  const add = (created: string, fn: string, hash: string) =>
    c.query(`INSERT INTO sys_idempotency (request_id, fn, actor, args_hash, result, created_at) VALUES (UUID_v4(), ?, ?, ?, '{}', ${created})`, [fn, actor, hash.repeat(64)]);
  await add('UTC_TIMESTAMP(6) - INTERVAL 10 DAY', 'inside', 'a');
  await add('UTC_TIMESTAMP(6) - INTERVAL 90 DAY + INTERVAL 3 SECOND', 'edge', 'b');
  await add('UTC_TIMESTAMP(6) - INTERVAL 91 DAY', 'expired', 'c');
  return { db, c };
}

async function emptyDb(name: string) {
  const db = await freshDb(name);
  dbs.push(db);
  return { db, c: await appConn(db) };
}

const DATETIME6 = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{6}$/;
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const linesOf = (store: ReturnType<typeof memoryStore>, file: string) => store.files.get(file)!.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));

describe('RV3a-F2 the export writes the cutoff of its 90-day rule into the manifest', () => {
  it('filter_cutoffs.sys_idempotency is DATETIME(6) text about 90 days before the export, and the table holds exactly the rows created at or after it', async () => {
    const s = await shopWithEdgeRow('rv3af2a');
    const store = memoryStore();
    const before = Date.now();
    const m = await exportDatabase(s.c, store.sink);
    const after = Date.now();
    expect(m.filter_cutoffs).toEqual({ sys_idempotency: expect.stringMatching(DATETIME6) });
    const cutoff = Date.parse(`${m.filter_cutoffs!.sys_idempotency.replace(' ', 'T')}Z`);
    expect(cutoff).toBeGreaterThanOrEqual(before - 90 * 86_400_000 - 2_000);
    expect(cutoff).toBeLessThanOrEqual(after - 90 * 86_400_000 + 2_000);
    expect(m.filtered).toEqual({ sys_idempotency: expect.stringContaining('90 days') }); // the old key is unchanged
    expect(linesOf(store, 'data/sys_idempotency.ndjson').map((r) => r.fn).sort()).toEqual(['edge', 'inside']);
    expect(JSON.parse(store.files.get('manifest.json')!)).toEqual(m);
    expect(Object.keys(FILTERED)).toEqual(['sys_idempotency']);
    await s.c.end();
  });
});

describe('RV3a-F2 a correct restore is not called a failure because a request row crossed the 90-day edge between the export and the restore', () => {
  it('the row that was 3 seconds inside the window at the export is outside it at the restore: the report is ok, the table says "same", both rows are in the restored table', async () => {
    const s = await shopWithEdgeRow('rv3af2b');
    const store = memoryStore();
    await exportDatabase(s.c, store.sink);
    await sleep(3500); // the restore happens later than the export: the edge row is now older than 90 days
    const t = await emptyDb('rv3af2b_r');
    const report = await restoreDatabase(t.c, store.source, memoryPhotos());
    expect(report.problems).toEqual([]);
    expect(report.ok).toBe(true);
    const table = report.tables.find((x) => x.name === 'sys_idempotency')!;
    expect([table.rows_expected, table.rows_restored, table.hash_ok]).toEqual([2, 2, true]);
    expect(report.tables.every((x) => x.hash_ok)).toBe(true);
    expect(report.notes ?? []).toEqual([]); // the manifest names its cutoff: nothing to explain
    const [[n]] = await t.c.query<any[][]>('SELECT COUNT(*) AS n FROM sys_idempotency');
    expect(Number((n as any).n)).toBe(2);
    await s.c.end();
    await t.c.end();
  }, 120_000);

  it('an export made before this change (no filter_cutoffs in its manifest) still restores ok after the edge, and the report says how the table was compared', async () => {
    const s = await shopWithEdgeRow('rv3af2c');
    const store = memoryStore();
    await exportDatabase(s.c, store.sink);
    const old = JSON.parse(store.files.get('manifest.json')!);
    delete old.filter_cutoffs;
    store.files.set('manifest.json', JSON.stringify(old, null, 2));
    await sleep(3500);
    const t = await emptyDb('rv3af2c_r');
    const report = await restoreDatabase(t.c, store.source, memoryPhotos());
    expect(report.problems).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.tables.find((x) => x.name === 'sys_idempotency')).toMatchObject({ rows_expected: 2, rows_restored: 2, hash_ok: true });
    expect(report.notes).toEqual([expect.stringMatching(/sys_idempotency.*no cutoff.*without the 90-day filter/)]);
    await s.c.end();
    await t.c.end();
  }, 120_000);

  it('negative control: the content of that table is still compared. A row changed on its way into the restored copy is reported "differs", also with the cutoff in the manifest', async () => {
    const s = await shopWithEdgeRow('rv3af2d');
    const store = memoryStore();
    await exportDatabase(s.c, store.sink);
    let reads = 0;
    const tampered = {
      text: (p: string) => store.source.text(p),
      async *lines(p: string) {
        if (p !== 'data/sys_idempotency.ndjson') return yield* store.source.lines(p);
        reads += 1; // the first read is the check of the file against the manifest; the second is the load
        for await (const line of store.source.lines(p)) yield reads >= 2 ? line.replace('"fn":"inside"', '"fn":"insidX"') : line;
      },
    };
    const t = await emptyDb('rv3af2d_r');
    const report = await restoreDatabase(t.c, tampered as any, memoryPhotos());
    expect(report.ok).toBe(false);
    expect(report.problems).toEqual([expect.stringMatching(/^table sys_idempotency: restored content differs from the export/)]);
    expect(report.tables.find((x) => x.name === 'sys_idempotency')!.hash_ok).toBe(false);
    expect(report.tables.filter((x) => !x.hash_ok).map((x) => x.name)).toEqual(['sys_idempotency']);
    await s.c.end();
    await t.c.end();
  }, 120_000);

  it('negative control: a data file that holds a row OLDER than the cutoff its own manifest names (a damaged or doctored export) is still reported, because the re-export obeys the cutoff', async () => {
    const s = await shopWithEdgeRow('rv3af2e');
    const store = memoryStore();
    const m = await exportDatabase(s.c, store.sink);
    const rows = linesOf(store, 'data/sys_idempotency.ndjson');
    const stale = { ...rows[0], request_id: randomUUID(), fn: 'stale', created_at: '2020-01-01 00:00:00.000000' };
    const text = `${[...rows, stale].map((r) => JSON.stringify(r)).join('\n')}\n`;
    store.files.set('data/sys_idempotency.ndjson', text);
    const entry = m.tables.find((x) => x.name === 'sys_idempotency')!;
    entry.rows = rows.length + 1;
    entry.sha256 = sha(text); // a consistent doctored export: the file hash in the manifest matches the file
    store.files.set('manifest.json', JSON.stringify(m, null, 2));
    const t = await emptyDb('rv3af2e_r');
    const report = await restoreDatabase(t.c, store.source, memoryPhotos());
    expect(report.ok).toBe(false);
    expect(report.problems).toEqual([expect.stringMatching(/^table sys_idempotency: restored content differs from the export \(2 rows, expected 3\)/)]);
    await s.c.end();
    await t.c.end();
  }, 120_000);
});

describe('RV3a-F2 end to end, with the real encrypted dump and the restore command: a restore a few seconds after the export is "RESTORED"', () => {
  it('a request row 4 seconds inside the window at the night\'s dump, restored 6 seconds later (the attack of the review, 8a)', async () => {
    const w = await dumpWorld();
    await w.conn.query("INSERT INTO sys_idempotency (request_id, fn, actor, args_hash, result, created_at) VALUES (?, 'x', ?, REPEAT('a', 64), '{}', UTC_TIMESTAMP(6) - INTERVAL 90 DAY + INTERVAL 4 SECOND), (?, 'x', ?, REPEAT('b', 64), '{}', UTC_TIMESTAMP(6) - INTERVAL 10 DAY), (?, 'x', ?, REPEAT('c', 64), NULL, UTC_TIMESTAMP(6) - INTERVAL 91 DAY)", [
      randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID(),
    ]);
    await copyPhotosOnce(w.conn, directoryPhotos(path.join(w.folder, 'photos'))); // the photo copy of the night, so that the restore has every photo
    const r = await dump(w, Date.now());
    expect(r.status).toBe('done');
    await sleep(6000);
    const target = await scratchDatabase('rv3af2f');
    onCleanUp(() => target.drop());
    const res = await restoreBackup({ key: w.keys.privateFile, fromFolder: w.env.JV_BACKUP_DIR, target: { host: target.db.host, port: target.db.port, database: target.db.name, user: target.db.user, password: target.db.password }, workRoot: tmpdir() });
    expect(res.report.problems).toEqual([]);
    expect(res.status).toBe('restored');
    expect(res.report.tables.find((t: any) => t.name === 'sys_idempotency')).toMatchObject({ rows_expected: 2, rows_restored: 2, hash_ok: true });
    expect(res.text).not.toMatch(/CHECKS FAILED|DIFFERENT/);
    const c: Connection = await target.connect();
    const [[n]] = (await c.query<any[]>('SELECT COUNT(*) AS n FROM sys_idempotency')) as any;
    await c.end();
    expect(Number(n.n)).toBe(2);
  }, 300_000);
});
