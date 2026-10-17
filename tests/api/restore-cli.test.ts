import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql, { type Connection } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { paced } from '../helpers';
import { folderRemote, sftpRemote, batchQuote, parseListing } from '../../scripts/backup-remote.mjs';
import {
  EXIT, ToolError, adminRecordPullCommand, checkKeyTestFile, dbRecords, drillCommandArgs, exitCodeFor, makeKeyTestFile, manualRecords, newestOf, pullBackup, removeDrillDatabase,
  restoreBackup, runAdminRecordPull, startDrillDatabase,
} from '../../scripts/restore-cli.mjs';
import { type Shop, cleanUp, copyFolder, fakePng, listDir, makeFakeOpenSsh, makeKeys, makeShop, makeTarget, onCleanUp, readText, sha256Hex, tableCounts, tempDir } from './restore-support';

// PT-R1, the plan test of API36: the restore and pull tool on Harsh's Mac (scripts/restore-cli.mjs), tried on lane databases.
// A source shop is exported the way API34's nightly dump will write it (MB05 writeDailyExport + MB03 exportDatabase; API34 does not exist yet, so the check against its real file is OPS05's),
// then rebuilt by the CLI's functions from a local folder, from a file downloaded by hand, and over SFTP (a stand-in for the OpenSSH programs; the real plan is OPS05's).
// The ten-box user of A3 does the restore. Every key and password is made up at run time.

const TEXT_SECRETS = ['BEGIN PRIVATE KEY', 'BEGIN RSA PRIVATE KEY'];
const docker = (...args: string[]) => execFileSync('docker', args, { encoding: 'utf8' }).trim();

let shop: Shop;
beforeAll(async () => {
  shop = await makeShop();
}, 120_000);
afterAll(async () => {
  await cleanUp();
}, 60_000);

async function tablesIn(settings: { host: string; port: number; database: string; user: string; password: string }) {
  const c = await paced(() => mysql.createConnection({ ...settings, decimalNumbers: false, supportBigNumbers: true, bigNumberStrings: true, dateStrings: true }));
  try {
    return { conn: c, counts: await tableCounts(c) };
  } catch (e) {
    await c.end();
    throw e;
  }
}
const photoRows = async (c: Connection) =>
  (await c.query<any[]>('SELECT id, kind, LOWER(HEX(sha256)) AS sha, byte_size, removed_at IS NULL AS live, bytes IS NOT NULL AS has_bytes, removed_at FROM design_photos ORDER BY id, kind'))[0].map((r) => ({ ...r }));

const OMITTED_EMPTY = ['sessions', 'sys_login_attempts'];

describe('PT-R1 restore CLI round trip on lane databases', () => {
  describe('from a local folder (a pulled copy of the backup folder) into an empty database', () => {
    it('rebuilds a second empty database: equal row counts in every table, equal photo hashes, triggers back, and a report that says so', async () => {
      const t = await makeTarget();
      const lines: string[] = [];
      const workRoot = tempDir('jv work ');
      const r = await restoreBackup({ key: shop.privateFile, fromFolder: shop.folder, target: t.settings, workRoot, log: (l) => lines.push(l) });
      expect(r.report.problems).toEqual([]);
      expect(r.status).toBe('restored');
      expect(exitCodeFor(r)).toBe(EXIT.ok);
      expect(r.file.name).toBe(shop.newest.name);
      expect(r.file.sha256).toBe(shop.newest.sha256);

      const { conn, counts } = await tablesIn(t.settings);
      try {
        // independent of the library's own report: the restored database against the source, table by table
        for (const [name, n] of Object.entries(shop.counts)) expect(counts[name], name).toBe(OMITTED_EMPTY.includes(name) ? 0 : n);
        expect(Object.keys(counts).sort()).toEqual(Object.keys(shop.counts).sort());
        const [srcPhotos, dstPhotos] = [await photoRows(shop.conn), await photoRows(conn)];
        expect(dstPhotos).toEqual(srcPhotos);
        expect(dstPhotos.filter((p) => p.live).length).toBe(6);
        const [[bad]] = await conn.query<any[][]>('SELECT COUNT(*) AS n FROM design_photos WHERE bytes IS NOT NULL AND UNHEX(SHA2(bytes, 256)) <> sha256');
        expect(Number((bad as any).n)).toBe(0);
        const [[trig]] = await conn.query<any[][]>('SELECT COUNT(*) AS n FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = DATABASE()');
        expect(Number((trig as any).n)).toBe(shop.triggers);
        expect(shop.triggers).toBeGreaterThan(0);
        const [mig] = await conn.query<any[]>('SELECT version, checksum FROM schema_migrations ORDER BY version');
        const [smig] = await shop.conn.query<any[]>('SELECT version, checksum FROM schema_migrations ORDER BY version');
        expect(mig).toEqual(smig);
      } finally {
        await conn.end();
      }
      expect(lines.length).toBeGreaterThan(3); // progress is printed while it works
      expect(listDir(workRoot)).toEqual([]); // the decrypted export (plain customer data) is gone
    }, 120_000);

    it('prints the report: every table against the manifest, the photo sha256 values, the nightly check, the time and no secret', async () => {
      const t = await makeTarget();
      const r = await restoreBackup({ key: shop.privateFile, fromFolder: shop.folder, target: t.settings, workRoot: tempDir('jv work ') });
      const text = r.text;
      for (const tb of r.report.tables) expect(text, tb.name).toMatch(new RegExp(`^\\s*${tb.name}\\s+${tb.rows_expected}\\s+${tb.rows_restored}\\s+same\\s*$`, 'm'));
      expect(r.report.tables.length).toBeGreaterThan(15);
      for (const p of shop.photos) expect(text).toContain(p.sha);
      for (const p of shop.photos) expect(text).toContain(`${p.id}/${p.kind}`);
      expect(text).toMatch(/Nightly check on the copy: passed/);
      expect(text).toMatch(/Photos: 6 live in the export, 6 restored with their bytes, 0 tombstoned/);
      expect(text).toMatch(/6 of 6 sampled photos open/);
      expect(text).toContain(shop.newest.sha256);
      expect(text).toMatch(/under 2 hours/);
      expect(text).not.toContain(t.settings.password);
      expect(text).not.toContain(shop.privatePem.split('\n')[1]);
      for (const s of TEXT_SECRETS) expect(text).not.toContain(s);
      expect(r.photos.opened).toBe(6);
      expect(r.photos.sampled).toBe(6);
    }, 120_000);

    it('refuses a target that already has tables, before it reads the key or the export, and leaves the target exactly as it was', async () => {
      const t = await makeTarget();
      const c = await paced(() => mysql.createConnection({ ...t.settings, database: t.settings.database }));
      await c.query('CREATE TABLE customers (id INT PRIMARY KEY)');
      await c.query('INSERT INTO customers (id) VALUES (7)');
      const other = makeKeys(); // the wrong key as well: the emptiness is checked FIRST, so this must still say "not empty"
      const workRoot = tempDir('jv work ');
      await expect(restoreBackup({ key: other.privateFile, fromFolder: shop.folder, target: t.settings, workRoot })).rejects.toThrow(/not empty/);
      const [tables] = await c.query<any[]>("SELECT TABLE_NAME AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()");
      expect(tables.map((x) => x.n)).toEqual(['customers']);
      const [[row]] = await c.query<any[][]>('SELECT COUNT(*) AS n FROM customers');
      expect(Number((row as any).n)).toBe(1);
      expect(listDir(workRoot)).toEqual([]);
      await c.end();
    }, 60_000);

    it('fails with a clear message with the wrong private key, restores nothing and leaves nothing on disk', async () => {
      const t = await makeTarget();
      const wrong = makeKeys();
      const workRoot = tempDir('jv work ');
      const err = await restoreBackup({ key: wrong.privateFile, fromFolder: shop.folder, target: t.settings, workRoot }).catch((e) => e);
      expect(err).toBeInstanceOf(ToolError);
      expect(err.code).toBe('wrong_key');
      expect(err.message).toMatch(/private key/i);
      expect(err.message).toMatch(/does not open this export/);
      expect(err.message).toMatch(/Nothing was restored/);
      expect(err.message).not.toContain('BEGIN');
      const { conn, counts } = await tablesIn(t.settings);
      await conn.end();
      expect(counts).toEqual({});
      expect(listDir(workRoot)).toEqual([]);
    }, 60_000);

    it('says what is wrong with a key file that is not a private key, or not there', async () => {
      const t = await makeTarget();
      const junk = path.join(tempDir('jv keys '), 'k.pem');
      writeFileSync(junk, 'this is not a key\n');
      await expect(restoreBackup({ key: junk, fromFolder: shop.folder, target: t.settings })).rejects.toMatchObject({ code: 'bad_key_file' });
      await expect(restoreBackup({ key: path.join(path.dirname(junk), 'nope.pem'), fromFolder: shop.folder, target: t.settings })).rejects.toThrow(/key file .* cannot be read/);
      const pub = path.join(path.dirname(junk), 'pub.pem');
      writeFileSync(pub, shop.publicPem);
      await expect(restoreBackup({ key: pub, fromFolder: shop.folder, target: t.settings })).rejects.toMatchObject({ code: 'bad_key_file' });
    }, 60_000);

    it('a file changed after it was written is refused as damaged, with nothing restored', async () => {
      const t = await makeTarget();
      const folder = copyFolder(shop.folder);
      const file = path.join(folder, shop.newest.name);
      const bytes = readFileSync(file);
      bytes[bytes.length - 40] ^= 0xff;
      writeFileSync(file, bytes);
      const workRoot = tempDir('jv work ');
      const err = await restoreBackup({ key: shop.privateFile, fromFolder: folder, target: t.settings, workRoot }).catch((e) => e);
      expect(err).toBeInstanceOf(ToolError);
      expect(err.code).toBe('damaged');
      expect(err.message).toMatch(/damaged or was changed/);
      const { conn, counts } = await tablesIn(t.settings);
      await conn.end();
      expect(counts).toEqual({});
      expect(listDir(workRoot)).toEqual([]);
    }, 60_000);

    it('lists a deliberately removed photo as missing and inserts its row as a tombstone; the other photos come back with their bytes', async () => {
      const t = await makeTarget();
      const folder = copyFolder(shop.folder);
      const gone = shop.photos[2]; // the full photo of the second id
      rmSync(path.join(folder, 'photos', `${gone.id}-${gone.kind}`));
      const r = await restoreBackup({ key: shop.privateFile, fromFolder: folder, target: t.settings, workRoot: tempDir('jv work ') });
      expect(r.status).toBe('restored_photos_missing');
      expect(exitCodeFor(r)).toBe(EXIT.photosMissing);
      expect(r.photos.tombstoned).toEqual([{ id: gone.id, kind: gone.kind, reason: 'missing' }]);
      expect(r.photos.restored).toBe(5);
      expect(r.text).toMatch(new RegExp(`TOMBSTONE ${gone.id}/${gone.kind}: missing`));
      expect(r.text).toMatch(/the owner decides/);
      expect(r.text).toMatch(/Photos: 6 live in the export, 5 restored with their bytes, 1 tombstoned/);
      const { conn } = await tablesIn(t.settings);
      try {
        const rows = await photoRows(conn);
        const row = rows.find((p) => p.id === gone.id && p.kind === gone.kind)!;
        expect(row.live).toBe(0);
        expect(row.has_bytes).toBe(0);
        expect(row.removed_at).toBeTruthy(); // removed_at = the restore time, so the CHECK of D26 holds
        expect(rows.filter((p) => p.live && p.has_bytes)).toHaveLength(5);
      } finally {
        await conn.end();
      }
    }, 120_000);

    it('a photo whose bytes in the copy are not the recorded ones is a tombstone too (sha256), never loaded', async () => {
      const t = await makeTarget();
      const folder = copyFolder(shop.folder);
      const bad = shop.photos[1];
      writeFileSync(path.join(folder, 'photos', `${bad.id}-${bad.kind}`), fakePng(bad.size)); // same size, other bytes
      const r = await restoreBackup({ key: shop.privateFile, fromFolder: folder, target: t.settings, workRoot: tempDir('jv work ') });
      expect(r.photos.tombstoned).toEqual([{ id: bad.id, kind: bad.kind, reason: 'sha256' }]);
      expect(r.status).toBe('restored_photos_missing');
      expect(r.text).toMatch(new RegExp(`TOMBSTONE ${bad.id}/${bad.kind}: .*sha256`));
    }, 120_000);

    it('opens a sample of the restored photos and fails the restore when one does not open (negative control)', async () => {
      const src = await makeShop({ dates: ['2026-10-17'], gifAsPng: true }); // one photo row says image/png and holds a GIF
      const t = await makeTarget();
      const r = await restoreBackup({ key: src.privateFile, fromFolder: src.folder, target: t.settings, workRoot: tempDir('jv work '), sample: 50 });
      expect(r.photos.failedToOpen).toEqual([`${src.gifPhoto}/thumb`]);
      expect(r.status).toBe('failed_checks');
      expect(exitCodeFor(r)).toBe(EXIT.failed);
      expect(r.text).toMatch(/does not open/);
      expect(r.photos.opened).toBe(6); // the six real ones open, the GIF does not
    }, 180_000);

    it('opens every connection through the pacer (S11): one wait() per new connection, a handful in all', async () => {
      const t = await makeTarget();
      const pacer = { wait: vi.fn(async () => undefined) };
      const r = await restoreBackup({ key: shop.privateFile, fromFolder: shop.folder, target: t.settings, workRoot: tempDir('jv work '), pacer });
      expect(r.connections).toBeGreaterThanOrEqual(1);
      expect(r.connections).toBeLessThanOrEqual(3);
      expect(pacer.wait).toHaveBeenCalledTimes(r.connections);
    }, 120_000);

    it('restores an earlier export when asked for it by name', async () => {
      const t = await makeTarget();
      const first = shop.exports[0];
      const r = await restoreBackup({ key: shop.privateFile, fromFolder: shop.folder, name: first.name, target: t.settings, workRoot: tempDir('jv work ') });
      expect(r.file.name).toBe(first.name);
      expect(r.file.sha256).toBe(first.sha256);
      expect(r.report.problems).toEqual([]);
    }, 120_000);
  });

  describe('from one file downloaded by hand from hPanel (the path proved byte for byte on 17 Oct)', () => {
    it('restores from the .enc file and a photo folder', async () => {
      const t = await makeTarget();
      const r = await restoreBackup({ key: shop.privateFile, file: path.join(shop.folder, shop.newest.name), photosDir: path.join(shop.folder, 'photos'), target: t.settings, workRoot: tempDir('jv work ') });
      expect(r.report.problems).toEqual([]);
      expect(r.status).toBe('restored');
      expect(r.file.sha256).toBe(shop.newest.sha256);
      expect(r.file.name).toBeNull();
    }, 120_000);

    it('without a photo folder every live photo is a tombstone and is listed', async () => {
      const t = await makeTarget();
      const r = await restoreBackup({ key: shop.privateFile, file: path.join(shop.folder, shop.newest.name), target: t.settings, workRoot: tempDir('jv work ') });
      expect(r.photos.tombstoned).toHaveLength(6);
      expect(r.status).toBe('restored_photos_missing');
    }, 120_000);
  });

  describe('over SFTP (a stand-in for the OpenSSH programs; the real plan is OPS05)', () => {
    it('quotes a path with spaces for an sftp batch line, and reads the names out of a listing', () => {
      expect(batchQuote('/Users/x/Harsh Vishwas/a"b\\c')).toBe('"/Users/x/Harsh Vishwas/a\\"b\\\\c"');
      expect(parseListing('sftp> ls -1 "jv-backup/daily"\n2026-10-16.enc\n\n2026-10-17.enc\nsftp> bye\n')).toEqual(['2026-10-16.enc', '2026-10-17.enc']);
    });

    it('restores the newest export: the login is opened once, the live photos come in ONE batch, paths with spaces work, and no secret is on any command line', async () => {
      const server = tempDir('jv fake server ');
      const { cpSync } = await import('node:fs');
      cpSync(shop.folder, path.join(server, 'jv-backup'), { recursive: true });
      const fake = makeFakeOpenSsh(server);
      const remote = sftpRemote({ target: 'u123456789@203.0.113.9', port: 65002, dir: 'jv-backup', bin: fake.bin, env: fake.env, masterStdio: 'ignore', tmpRoot: tempDir('jv sock ') });
      const t = await makeTarget();
      const workRoot = tempDir('jv work ');
      const r = await restoreBackup({ key: shop.privateFile, remote, target: t.settings, workRoot });
      await remote.close();
      expect(r.report.problems).toEqual([]);
      expect(r.status).toBe('restored');
      expect(r.file.name).toBe(shop.newest.name);
      expect(r.file.sha256).toBe(shop.newest.sha256);
      const calls = fake.calls();
      const masters = calls.filter((c) => c.tool === 'ssh' && c.args.includes('-M'));
      expect(masters).toHaveLength(1);
      expect(calls.filter((c) => c.tool === 'ssh' && c.args.includes('-O'))).toHaveLength(1); // closed again
      const batches = calls.filter((c) => c.tool === 'sftp');
      const photoBatches = batches.filter((c) => c.commands!.filter((l) => l.startsWith('get ')).length > 1);
      expect(photoBatches).toHaveLength(1);
      expect(photoBatches[0].commands!.filter((l) => l.startsWith('get '))).toHaveLength(6);
      for (const c of calls) {
        expect(c.args.join(' ')).not.toMatch(/password|passwd|secret/i);
        expect(c.args).toContain(c.tool === 'sftp' ? '-P' : '-p');
        expect(c.args).toContain('65002');
        expect(c.args.join(' ')).toContain('u123456789@203.0.113.9');
      }
      expect(batches.every((c) => c.args.includes('-b'))).toBe(true);
      expect(listDir(workRoot)).toEqual([]);
    }, 120_000);

    it('a missing remote file stops with its name, an unreachable login with a plain message', async () => {
      const server = tempDir('jv fake server ');
      const fake = makeFakeOpenSsh(server);
      const remote = sftpRemote({ target: 'u1@203.0.113.9', dir: 'jv-backup', bin: fake.bin, env: fake.env, masterStdio: 'ignore', tmpRoot: tempDir('jv sock ') });
      const t = await makeTarget();
      await expect(restoreBackup({ key: shop.privateFile, remote, target: t.settings, workRoot: tempDir('jv work ') })).rejects.toThrow(/jv-backup\/daily/);
      await remote.close();
      const broken = sftpRemote({ target: 'u1@203.0.113.9', dir: 'jv-backup', bin: { ssh: '/nonexistent/ssh', sftp: '/nonexistent/sftp' }, masterStdio: 'ignore', tmpRoot: tempDir('jv sock ') });
      await expect(broken.list('daily')).rejects.toThrow(/cannot start .*ssh/);
      expect(() => sftpRemote({ target: '-oProxyCommand=x', dir: 'jv-backup' })).toThrow(/user@host/);
    }, 60_000);
  });
});

describe('PT-R1 the pull (O54, T-R06): the newest export and the new photos, checked against the record, create-once', () => {
  const fromDb = async (s: Shop) => {
    const c = await s.source.connect();
    onCleanUp(() => c.end());
    return dbRecords(c);
  };

  it('pulls the newest daily file from a folder, checks its sha256 and size against backup_runs.detail, keeps it, and reports the pull once', async () => {
    const dest = tempDir('jv pulled ');
    const reportPull = vi.fn(async () => undefined);
    const now = () => new Date('2026-10-18T05:30:00.000Z');
    const r = await pullBackup({ dest, fromFolder: shop.folder, records: await fromDb(shop), reportPull, by: 'harsh', now, workRoot: tempDir('jv work ') });
    expect(r.status).toBe('pulled');
    expect(r.problems).toEqual([]);
    expect(r.newest).toEqual({ name: shop.newest.name, sha256: shop.newest.sha256, size: shop.newest.size });
    expect(sha256Hex(readFileSync(path.join(dest, shop.newest.name)))).toBe(shop.newest.sha256);
    expect(listDir(path.join(dest, 'daily'))).toEqual([path.basename(shop.newest.name)]);
    expect(listDir(path.join(dest, 'monthly'))).toEqual([]);
    expect(reportPull).toHaveBeenCalledTimes(1);
    expect(reportPull).toHaveBeenCalledWith({ at: '2026-10-18T05:30:00.000Z', by: 'harsh', file: shop.newest.name, sha256: shop.newest.sha256 });
    expect(r.reported).toBe(true);
    expect(r.text).toContain(shop.newest.sha256);
  }, 60_000);

  it('a file that does not match the record is refused: not kept, not reported', async () => {
    const folder = copyFolder(shop.folder);
    const file = path.join(folder, shop.newest.name);
    const bytes = readFileSync(file);
    bytes[100] ^= 0x01;
    writeFileSync(file, bytes);
    const dest = tempDir('jv pulled ');
    const reportPull = vi.fn(async () => undefined);
    const r = await pullBackup({ dest, fromFolder: folder, records: await fromDb(shop), reportPull, workRoot: tempDir('jv work ') });
    expect(r.status).toBe('failed');
    expect(r.items.find((i) => i.name === shop.newest.name)?.state).toBe('mismatch');
    expect(r.problems.join('\n')).toMatch(/sha256 .* does not match/);
    expect(listDir(path.join(dest, 'daily'))).toEqual([]); // no file of that name, no .partial left
    expect(reportPull).not.toHaveBeenCalled();
    expect(r.reported).toBe(false);
  }, 60_000);

  it('a file without any record cannot be checked and is refused too', async () => {
    const folder = copyFolder(shop.folder);
    const extra = path.join(folder, 'daily', '2026-10-20.enc');
    writeFileSync(extra, readFileSync(path.join(folder, shop.newest.name)));
    const dest = tempDir('jv pulled ');
    const r = await pullBackup({ dest, fromFolder: folder, records: await fromDb(shop), reportPull: vi.fn(), workRoot: tempDir('jv work ') });
    expect(r.status).toBe('failed');
    expect(r.items[0]).toMatchObject({ name: 'daily/2026-10-20.enc', state: 'missing_record' });
    expect(r.problems.join('\n')).toMatch(/no record/);
  }, 60_000);

  it('also verifies a file downloaded by hand: the name tells daily or monthly, or --as does; a wrong hash is refused', async () => {
    const hand = tempDir('jv Downloads ');
    const byHand = path.join(hand, path.basename(shop.newest.name));
    writeFileSync(byHand, readFileSync(path.join(shop.folder, shop.newest.name)));
    const dest = tempDir('jv pulled ');
    const reportPull = vi.fn(async () => undefined);
    const ok = await pullBackup({ dest, file: byHand, records: await fromDb(shop), reportPull, workRoot: tempDir('jv work ') });
    expect(ok.status).toBe('pulled');
    expect(existsSync(path.join(dest, shop.newest.name))).toBe(true);
    expect(reportPull).toHaveBeenCalledTimes(1);

    const damaged = path.join(hand, 'export.enc');
    const bytes = readFileSync(byHand);
    bytes[bytes.length - 1] ^= 0xff;
    writeFileSync(damaged, bytes);
    await expect(pullBackup({ dest: tempDir('jv pulled '), file: damaged, records: await fromDb(shop), workRoot: tempDir('jv work ') })).rejects.toMatchObject({ code: 'usage' }); // the name says nothing: --as is needed
    const bad = await pullBackup({ dest: tempDir('jv pulled '), file: damaged, as: shop.newest.name, records: await fromDb(shop), reportPull, workRoot: tempDir('jv work ') });
    expect(bad.status).toBe('failed');
    expect(bad.items[0].state).toBe('mismatch');
    expect(reportPull).toHaveBeenCalledTimes(1); // still only the first
  }, 60_000);

  it('without a database the sha256 typed in from the dashboard or phpMyAdmin checks a hand-downloaded file', async () => {
    const hand = tempDir('jv Downloads ');
    const byHand = path.join(hand, path.basename(shop.newest.name));
    writeFileSync(byHand, readFileSync(path.join(shop.folder, shop.newest.name)));
    const good = await pullBackup({ dest: tempDir('jv pulled '), file: byHand, records: manualRecords(shop.newest.sha256.toUpperCase()), workRoot: tempDir('jv work ') });
    expect(good.status).toBe('pulled');
    const bad = await pullBackup({ dest: tempDir('jv pulled '), file: byHand, records: manualRecords('0'.repeat(64)), workRoot: tempDir('jv work ') });
    expect(bad.status).toBe('failed');
    expect(() => manualRecords('not-a-hash')).toThrow(/64 hex/);
  }, 60_000);

  it('monthly: also the newest monthly file and the photos that are new; a second pull downloads nothing; a photo that does not match sys_photo_copies is refused', async () => {
    const dest = tempDir('jv pulled ');
    const records = await fromDb(shop);
    const spy = { fetched: [] as string[] };
    const remote = folderRemote(shop.folder);
    const counting = { ...remote, fetch: async (items: { name: string; to: string }[]) => { spy.fetched.push(...items.map((i) => i.name)); return remote.fetch(items); } };
    const first = await pullBackup({ dest, remote: counting, monthly: true, records, workRoot: tempDir('jv work ') });
    expect(first.problems).toEqual([]);
    expect(first.status).toBe('pulled');
    expect(listDir(path.join(dest, 'monthly'))).toEqual(['2026-10.enc']);
    expect(listDir(path.join(dest, 'photos'))).toEqual(shop.photos.map((p) => `${p.id}-${p.kind}`).sort());
    expect(first.items.filter((i) => i.state === 'new')).toHaveLength(2 + 6);
    for (const p of shop.photos) expect(sha256Hex(readFileSync(path.join(dest, 'photos', `${p.id}-${p.kind}`)))).toBe(p.sha);
    // the monthly file is the first export of the month, hard-linked: same bytes as daily/2026-10-15.enc, whose record is the first export's
    expect(first.items.find((i) => i.name === 'monthly/2026-10.enc')?.sha256).toBe(shop.exports[0].sha256);

    spy.fetched.length = 0;
    const second = await pullBackup({ dest, remote: counting, monthly: true, records, workRoot: tempDir('jv work ') });
    expect(second.status).toBe('pulled');
    expect(spy.fetched).toEqual([]); // nothing new: nothing downloaded
    expect(second.items.every((i) => i.state === 'already')).toBe(true);

    // a photo in the folder whose bytes are not the recorded ones
    const folder = copyFolder(shop.folder);
    const bad = shop.photos[0];
    writeFileSync(path.join(folder, 'photos', `${bad.id}-${bad.kind}`), fakePng(bad.size));
    const dest2 = tempDir('jv pulled ');
    const r = await pullBackup({ dest: dest2, fromFolder: folder, monthly: true, records, reportPull: vi.fn(), workRoot: tempDir('jv work ') });
    expect(r.status).toBe('failed');
    expect(r.items.find((i) => i.name === `photos/${bad.id}-${bad.kind}`)?.state).toBe('mismatch');
    expect(existsSync(path.join(dest2, 'photos', `${bad.id}-${bad.kind}`))).toBe(false);
    expect(listDir(path.join(dest2, 'photos'))).toHaveLength(5);
  }, 120_000);

  it('a photo object with no sys_photo_copies row is not taken and is listed', async () => {
    const folder = copyFolder(shop.folder);
    const stray = '22222222-2222-4222-8222-222222222222-full';
    writeFileSync(path.join(folder, 'photos', stray), fakePng(300));
    const r = await pullBackup({ dest: tempDir('jv pulled '), fromFolder: folder, monthly: true, records: await fromDb(shop), workRoot: tempDir('jv work ') });
    expect(r.status).toBe('pulled');
    expect(r.items.find((i) => i.name === `photos/${stray}`)?.state).toBe('skipped_unrecorded');
    expect(r.text).toMatch(/no sys_photo_copies row/);
  }, 60_000);

  it('with a holder\'s private key it decrypts the pulled export in a throw-away folder; the wrong key fails the pull', async () => {
    const work = tempDir('jv work ');
    const good = await pullBackup({ dest: tempDir('jv pulled '), fromFolder: shop.folder, records: await fromDb(shop), key: shop.privateFile, workRoot: work });
    expect(good.decrypted).toBe(true);
    expect(good.status).toBe('pulled');
    expect(listDir(work)).toEqual([]);
    const reportPull = vi.fn();
    const bad = await pullBackup({ dest: tempDir('jv pulled '), fromFolder: shop.folder, records: await fromDb(shop), key: makeKeys().privateFile, reportPull, workRoot: work });
    expect(bad.status).toBe('failed');
    expect(bad.decrypted).toBe(false);
    expect(bad.problems.join('\n')).toMatch(/does not open this export/);
    expect(reportPull).not.toHaveBeenCalled();
  }, 120_000);

  it('picks the newest by the date in the name; a retried night ties and the recorded name wins', () => {
    expect(newestOf(['2026-10-16.enc', '2026-10-17.enc', '2026-10-09.enc'])).toBe('2026-10-17.enc');
    expect(newestOf([])).toBeNull();
    expect(newestOf(['2026-10-17.enc', '2026-10-17-r2.enc'], ['2026-10-17-r2.enc'])).toBe('2026-10-17-r2.enc');
    expect(newestOf(['2026-10-17.enc', '2026-10-17-r2.enc'])).toBe('2026-10-17.enc');
    expect(newestOf(['notes.txt', '2026-10-17.enc.bak', '2026-10-16.enc'])).toBe('2026-10-16.enc'); // only exact backup names
    expect(newestOf(['2026-09.enc', '2026-10.enc'])).toBe('2026-10.enc'); // monthly names too
  });

  it('reports through the admin door: the command is `npm run admin -- record-pull` with the facts; a missing command is said plainly', async () => {
    const facts = { at: '2026-10-18T05:30:00.000Z', by: 'harsh', file: 'daily/2026-10-17.enc', sha256: 'a'.repeat(64) };
    const c = adminRecordPullCommand(facts);
    expect(c.command).toBe('npm');
    expect(c.args).toEqual(['run', 'admin', '--', 'record-pull', '--file', facts.file, '--sha256', facts.sha256, '--at', facts.at, '--by', 'harsh']);
    const run = vi.fn(async () => ({ code: 0, stderr: '' }));
    await runAdminRecordPull(facts, { run, cwd: '/somewhere' });
    expect(run).toHaveBeenCalledWith('npm', c.args, '/somewhere');
    await expect(runAdminRecordPull(facts, { run: async () => ({ code: 1, stderr: 'npm error Missing script: "admin"' }) })).rejects.toThrow(/admin door command is not built/);
    await expect(runAdminRecordPull(facts, { run: async () => ({ code: 1, stderr: 'token refused' }) })).rejects.toThrow(/admin door refused|did not record/);
  });
});

describe('PT-R1 the key holders\' proof at drill 1 (B4): decrypt a small test file with your own copy of the private key', () => {
  it('a test file made with the public key opens with the right private key and not with another', async () => {
    const dir = tempDir('jv keytest ');
    const out = path.join(dir, 'key-test.enc');
    const made = await makeKeyTestFile(shop.publicPem, out);
    expect(made.size).toBeGreaterThan(100);
    expect(made.sha256).toBe(sha256Hex(readFileSync(out)));
    expect(await checkKeyTestFile(out, shop.privateFile, tempDir('jv work '))).toEqual({ ok: true });
    await expect(checkKeyTestFile(out, makeKeys().privateFile, tempDir('jv work '))).rejects.toMatchObject({ code: 'wrong_key' });
    await expect(makeKeyTestFile(shop.publicPem, out)).rejects.toThrow(); // create-once: never overwritten
  });
});

describe('PT-R1 drill 1: the throw-away MariaDB 11.8 in Docker on the Mac', () => {
  it('is started the way the lane harness starts its own: tmpfs, no volume, 127.0.0.1 only, Hostinger\'s settings, secrets in the environment and not on the command line', () => {
    const args = drillCommandArgs({ name: 'jv-restore-drill', image: 'mariadb:11.8', tmpfsSize: '3g' });
    const text = args.join(' ');
    expect(args.slice(0, 3)).toEqual(['run', '-d', '--name']);
    expect(text).toContain('--tmpfs /var/lib/mysql:rw,size=3g');
    expect(text).toContain('-p 127.0.0.1::3306');
    expect(text).toContain('mariadb:11.8');
    expect(text).toContain('--transaction-isolation=READ-COMMITTED');
    expect(text).toMatch(/--sql-mode=NO_AUTO_CREATE_USER,NO_ENGINE_SUBSTITUTION/);
    expect(args).toContain('MARIADB_ROOT_PASSWORD');
    expect(text).not.toMatch(/(^| )(-v|--volume|--mount)( |=)/);
    expect(text).not.toMatch(/MARIADB_ROOT_PASSWORD=/);
  });

  it('only ever touches containers named jv-restore-drill*: never the guard container, a lane or the spike', async () => {
    const docker = vi.fn(async () => '');
    await expect(startDrillDatabase({ name: 'keep-tourstack-and-unknown-volumes', docker })).rejects.toThrow(/jv-restore-drill/);
    await expect(removeDrillDatabase('jv-mariadb-a', { docker })).rejects.toThrow(/jv-restore-drill/);
    await expect(removeDrillDatabase('jv-mariadb-spike', { docker })).rejects.toThrow(/jv-restore-drill/);
    expect(docker).not.toHaveBeenCalled();
  });

  it('refuses to replace a drill container that already exists, and says how to remove it', async () => {
    const docker = vi.fn(async (args: string[]) => (args[0] === 'inspect' ? '[{"Name":"/jv-restore-drill"}]' : ''));
    await expect(startDrillDatabase({ docker })).rejects.toThrow(/already exists.*docker rm -fv jv-restore-drill/s);
  });

  it('starts a real container, restores the shop into it as the ten-box user, and removes it with its data (no volume)', async () => {
    const name = `jv-restore-drill-t${randomBytes(3).toString('hex')}`;
    const drill = await startDrillDatabase({ name, tmpfsSize: '1g' });
    try {
      const info = JSON.parse(docker('inspect', name))[0];
      expect(info.Mounts.filter((m: any) => m.Type === 'volume')).toEqual([]);
      expect(Object.keys(info.HostConfig.Tmpfs ?? {})).toEqual(['/var/lib/mysql']);
      const bindings = info.NetworkSettings.Ports['3306/tcp'];
      expect(bindings).toHaveLength(1);
      expect(bindings[0].HostIp).toBe('127.0.0.1');
      expect(drill.target.port).toBe(Number(bindings[0].HostPort));
      expect(JSON.stringify(info.Config.Cmd)).toMatch(/READ-COMMITTED/);
      const r = await restoreBackup({ key: shop.privateFile, fromFolder: shop.folder, target: drill.target, workRoot: tempDir('jv work ') });
      expect(r.report.problems).toEqual([]);
      expect(r.status).toBe('restored');
      expect(r.text).not.toContain(drill.target.password);
    } finally {
      await drill.remove();
    }
    expect(docker('ps', '-a', '--filter', `name=^${name}$`, '--format', '{{.Names}}')).toBe('');
    expect(await removeDrillDatabase(name)).toBe(false); // already gone
  }, 240_000);
});

describe('PT-R1 the command line (arguments, the environment, exit codes)', () => {
  const script = fileURLToPath(new URL('../../scripts/restore-cli.mjs', import.meta.url));
  const cli = (args: string[], env: Record<string, string> = {}) => {
    const clean = { ...process.env };
    for (const k of ['DB_HOST', 'DB_PORT', 'DB_NAME', 'DB_USER', 'DB_PASSWORD']) delete clean[k];
    const r = spawnSync(process.execPath, [script, ...args], { env: { ...clean, ...env }, encoding: 'utf8', timeout: 120_000 });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };
  const dbEnv = (s: { host: string; port: number; database?: string; name?: string; user: string; password: string }) => ({ DB_HOST: s.host, DB_PORT: String(s.port), DB_NAME: (s.database ?? s.name)!, DB_USER: s.user, DB_PASSWORD: s.password });

  it('no command, a missing option or an unknown one: exit 2 with the usage, and nothing is touched', () => {
    expect(cli([])).toMatchObject({ code: 2 });
    expect(cli([]).err + cli([]).out).toMatch(/usage:/);
    expect(cli(['restore'])).toMatchObject({ code: 2 });
    expect(cli(['restore']).err).toMatch(/restore needs --key/);
    expect(cli(['restore', '--key', 'k.pem']).err).toMatch(/exactly one of --from-folder, --file, --sftp/);
    expect(cli(['restore', '--key', 'k.pem', '--bogus']).err).toMatch(/unknown option --bogus/);
    expect(cli(['restore', '--key']).err).toMatch(/--key needs a value/);
    expect(cli(['restore', '--key', 'k.pem', '--sftp', 'u@h']).err).toMatch(/--sftp needs --remote-dir/);
    expect(cli(['restore', '--key', 'k.pem', '--from-folder', shop.folder], {}).code).toBe(2); // no DB_* settings and no --drill
    expect(cli(['pull', '--from-folder', shop.folder]).err).toMatch(/pull needs --dest/);
    expect(cli(['pull', '--dest', tempDir('jv pulled '), '--from-folder', shop.folder]).err).toMatch(/missing settings in the environment: DB_HOST/);
    expect(cli(['nonsense']).code).toBe(2);
  });

  it('restore: exit 0 with the report on stdout and progress on stderr; the database settings come from the environment and the password is never printed', async () => {
    const t = await makeTarget();
    const r = cli(['restore', '--key', shop.privateFile, '--from-folder', shop.folder], dbEnv(t.settings));
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/Result: RESTORED\n/);
    expect(r.out).toMatch(/Nightly check on the copy: passed/);
    expect(r.err).toMatch(/Decrypting with the private key/);
    expect(r.out + r.err).not.toContain(t.settings.password);
    // the same target again: it has tables now, so exit 1 and the message says so
    const again = cli(['restore', '--key', shop.privateFile, '--from-folder', shop.folder], dbEnv(t.settings));
    expect(again.code).toBe(1);
    expect(again.err).toMatch(/not empty/);
    expect(again.out + again.err).not.toContain(t.settings.password);
  }, 120_000);

  it('restore: exit 4 when photos had to be tombstoned, exit 1 with a key that is not a key or the wrong key', async () => {
    const folder = copyFolder(shop.folder);
    rmSync(path.join(folder, 'photos', `${shop.photos[0].id}-${shop.photos[0].kind}`));
    const t = await makeTarget();
    const missing = cli(['restore', '--key', shop.privateFile, '--from-folder', folder], dbEnv(t.settings));
    expect(missing.code).toBe(4);
    expect(missing.out).toMatch(/Result: RESTORED, BUT PHOTOS WERE MISSING/);
    expect(missing.out).toMatch(/TOMBSTONE/);
    const t2 = await makeTarget();
    const wrong = cli(['restore', '--key', makeKeys().privateFile, '--from-folder', shop.folder], dbEnv(t2.settings));
    expect(wrong.code).toBe(1);
    expect(wrong.err).toMatch(/does not open this export/);
    const pub = path.join(tempDir('jv keys '), 'pub.pem');
    writeFileSync(pub, shop.publicPem);
    expect(cli(['restore', '--key', pub, '--from-folder', shop.folder], dbEnv(t2.settings)).code).toBe(1);
  }, 180_000);

  it('pull: exit 0 and a report for a good file, exit 1 for a wrong hash; with the database settings the records come from backup_runs', () => {
    const dest = tempDir('jv pulled ');
    const ok = cli(['pull', '--dest', dest, '--from-folder', shop.folder, '--no-report'], dbEnv(shop.source.db));
    expect(ok.code).toBe(0);
    expect(ok.out).toMatch(/Result: PULLED/);
    expect(ok.out).toContain(shop.newest.sha256);
    expect(existsSync(path.join(dest, shop.newest.name))).toBe(true);
    const hand = path.join(tempDir('jv Downloads '), path.basename(shop.newest.name));
    writeFileSync(hand, readFileSync(path.join(shop.folder, shop.newest.name)));
    const byHand = cli(['pull', '--dest', tempDir('jv pulled '), '--file', hand, '--expect-sha256', shop.newest.sha256, '--no-report']);
    expect(byHand.code).toBe(0);
    const bad = cli(['pull', '--dest', tempDir('jv pulled '), '--file', hand, '--expect-sha256', '1'.repeat(64), '--no-report']);
    expect(bad.code).toBe(1);
    expect(bad.out).toMatch(/Result: FAILED/);
    expect(cli(['pull', '--dest', tempDir('jv pulled '), '--file', hand, '--expect-sha256', 'zz', '--no-report']).err).toMatch(/64 hex/);
  }, 120_000);

  it('restore --drill starts the throw-away container itself, restores into it, says how to remove it, and drill-down removes exactly that container', () => {
    const name = `jv-restore-drill-c${randomBytes(3).toString('hex')}`;
    try {
      const r = cli(['restore', '--key', shop.privateFile, '--from-folder', shop.folder, '--drill', '--drill-name', name, '--tmpfs-size', '1g']);
      expect(r.code).toBe(0);
      expect(r.err).toMatch(/Starting the throw-away MariaDB 11.8 in Docker/);
      expect(r.out).toMatch(/Result: RESTORED\n/);
      expect(r.out).toContain(`still running as ${name}`);
      expect(docker('ps', '--filter', `name=^${name}$`, '--format', '{{.Names}}')).toBe(name);
    } finally {
      const down = cli(['drill-down', '--drill-name', name]);
      expect(down.out).toMatch(/removed/);
    }
    expect(docker('ps', '-a', '--filter', `name=^${name}$`, '--format', '{{.Names}}')).toBe('');
  }, 240_000);

  it('key-test: make a test file with the public key, every holder opens it with their own copy; the wrong key exits 1; drill-down touches only drill containers', () => {
    const dir = tempDir('jv keytest ');
    const pub = path.join(dir, 'public.pem');
    writeFileSync(pub, shop.publicPem);
    const out = path.join(dir, 'key-test.enc');
    expect(cli(['key-test', 'make', '--public-key-file', pub, '--out', out]).code).toBe(0);
    expect(cli(['key-test', 'check', '--file', out, '--key', shop.privateFile])).toMatchObject({ code: 0 });
    expect(cli(['key-test', 'check', '--file', out, '--key', shop.privateFile]).out).toMatch(/this holder can decrypt/);
    const wrong = cli(['key-test', 'check', '--file', out, '--key', makeKeys().privateFile]);
    expect(wrong.code).toBe(1);
    expect(wrong.err).toMatch(/does not open this export/);
    expect(cli(['key-test', 'make', '--public-key-file', pub, '--out', out]).code).toBe(1); // never overwritten
    expect(cli(['drill-down', '--drill-name', 'jv-restore-drill-tnone']).out).toMatch(/no container jv-restore-drill-tnone/);
    expect(cli(['drill-down', '--drill-name', 'jv-mariadb-a']).code).toBe(2);
  });
});

describe('PT-R1 the files themselves', () => {
  it('no password, token or key is written in the new scripts', () => {
    for (const f of ['restore-cli.mjs', 'backup-remote.mjs', 'zip-balances.mjs']) {
      const text = readText(fileURLToPath(new URL(`../../scripts/${f}`, import.meta.url)));
      expect(text, f).not.toMatch(new RegExp('-{5}BEGIN')); // also keeps the secrets scan of API10 quiet
      expect(text, f).not.toMatch(/(password|passwd|secret|token)\s*[:=]\s*['"][^'"\s]{6,}['"]/i);
    }
  });

  it('the backup layout is the one the nightly dump writes: daily/, monthly/ and photos/', () => {
    expect(listDir(shop.folder)).toEqual(['daily', 'monthly', 'photos']);
    expect(listDir(path.join(shop.folder, 'daily'))).toEqual(['2026-10-15.enc', '2026-10-16.enc', '2026-10-17.enc']);
  });
});
