import { generateKeyPairSync, createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Connection } from 'mysql2/promise';
import { afterAll, describe, expect, it } from 'vitest';
import { appConn, dropDb, freshDb } from '../helpers';
import { directoryPhotos, directoryStore, exportDatabase, memoryPhotos } from '../../scripts/backup.mjs';
import {
  KEEP_DAILY, KEEP_MONTHLY, businessDate, checkRecordedExport, dailyName, dailyRunName, fileDigest, folderStats, linkMonthly, monthlyName, planPrune, prepareFolder, prune,
  readPruneState, readRecordedExport, recordBackupRun, resolveBackupDir, sweepPartials, writeDailyExport,
} from '../../scripts/backup-folder.mjs';
import { createExportWriter, loadPublicKey, unpackExport } from '../../scripts/export-file.mjs';
import { readHealth } from '../../scripts/health.mjs';
import { createPacer, pacedConnect } from '../../scripts/pacing.mjs';
import { restoreDatabase } from '../../scripts/restore.mjs';
import { V, cleanWorld, insert, migratedDb, uuid } from './support';

// Spec B2 (draft 5.2, RF5-2, RF5-4, RF5-5), T-R03 and S11 pacing: the encrypted export as one file, the backup folder's create-once rules, the retry rule, the monthly link, the
// pruning guard rails, the `.partial` sweep and the pacing of new connections. The folder tests need no database; the last two groups do.

const dirs: string[] = [];
const dbs: string[] = [];
afterAll(async () => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  for (const d of dbs) await dropDb(d);
});
const tmp = (prefix = 'jv19-') => {
  const d = mkdtempSync(path.join(tmpdir(), prefix));
  dirs.push(d);
  return d;
};
const keys = generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
const other = generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
const publicKey = loadPublicKey(keys.publicKey);
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

/** A tiny stand-in for exportDatabase: a manifest and two data files, written through the sink. */
const fakeExport = (marker = 'plain-marker-silver-ornament') => async (sink: any) => {
  const f = sink.file('data/customers.ndjson');
  await f.write(`{"id":"1","name":"${marker}"}\n`);
  await f.write(`{"id":"2","name":"सिद्धि 💍"}\n`);
  await f.close();
  const e = sink.file('data/empty.ndjson');
  await e.close();
  const m = sink.file('manifest.json');
  await m.write(JSON.stringify({ format: 'jewelvault-export-1', marker }, null, 2));
  await m.close();
  return { format: 'jewelvault-export-1' } as any;
};
const mk = (dir: string, rel: string, content = 'x', ageMs = 0) => {
  const full = path.join(dir, rel);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, content);
  if (ageMs) {
    const t = (Date.now() - ageMs) / 1000;
    utimesSync(full, t, t);
  }
  return full;
};
const names = (dir: string, sub: string) => (existsSync(path.join(dir, sub)) ? readdirSync(path.join(dir, sub)).sort() : []);
const day = (i: number) => new Date(Date.parse('2026-09-01T00:00:00Z') + i * 86400_000).toISOString().slice(0, 10);

describe('JV_BACKUP_DIR and the names', () => {
  it('must be set, absolute, without "~" or ".." and not the root; a trailing slash is dropped', () => {
    expect(() => resolveBackupDir(undefined)).toThrow(/not set/);
    expect(() => resolveBackupDir('   ')).toThrow(/not set/);
    expect(() => resolveBackupDir('jv-backup')).toThrow(/absolute/);
    expect(() => resolveBackupDir('~/domains/site/jv-backup')).toThrow(/~/);
    expect(() => resolveBackupDir('/home/u/~backup')).toThrow(/~/);
    expect(() => resolveBackupDir('/home/u/../other/jv-backup')).toThrow(/\.\./);
    expect(() => resolveBackupDir('/')).toThrow(/root/);
    expect(resolveBackupDir('/home/u123/domains/site/jv-backup/')).toBe('/home/u123/domains/site/jv-backup');
    expect(resolveBackupDir('/home/u123//domains/site')).toBe('/home/u123/domains/site');
  });

  it('daily/<date>.enc, monthly/<yyyy-mm>.enc and the run name daily/<date>-<run id>.enc; only real dates and plain run ids', () => {
    expect(dailyName('2026-10-16')).toBe('daily/2026-10-16.enc');
    expect(monthlyName('2026-10-16')).toBe('monthly/2026-10.enc');
    expect(dailyRunName('2026-10-16', 17)).toBe('daily/2026-10-16-17.enc');
    expect(dailyRunName('2026-10-16', 'a3f-9')).toBe('daily/2026-10-16-a3f-9.enc');
    for (const bad of ['2026-13-01', '2026-02-30', '16-10-2026', '2026-10-16/../x', '']) expect(() => dailyName(bad), bad).toThrow(/business date/);
    for (const bad of ['', '../x', 'a/b', 'a b', '-x', 'x'.repeat(41)]) expect(() => dailyRunName('2026-10-16', bad), bad).toThrow(/run id/);
  });

  it('the business date is the Asia/Kolkata date: 18:29 UTC is still the 15th, 18:30 UTC is the 16th', () => {
    expect(businessDate(Date.parse('2026-10-15T18:29:59Z'))).toBe('2026-10-15');
    expect(businessDate(Date.parse('2026-10-15T18:30:00Z'))).toBe('2026-10-16');
  });
});

describe('the export as one encrypted file (export-file.mjs)', () => {
  const write = async (partial: string, fn = fakeExport(), key = publicKey) => {
    const w = await createExportWriter(partial, key);
    await fn(w.sink);
    return w.finish();
  };

  it('round trip: every file comes back byte for byte (Hindi, emoji, an empty file, a file bigger than one frame); the sha256 and size returned are those of the bytes on disk', async () => {
    const d = tmp();
    const big = Array.from({ length: 4000 }, (_, i) => `{"i":${i},"v":"${'abc'.repeat(30)}"}`).join('\n') + '\n'; // about 400 KB: more than one 256 KiB frame
    const fn = async (sink: any) => {
      await fakeExport()(sink);
      const f = sink.file('data/big.ndjson');
      await f.write(big);
      await f.close();
    };
    const partial = path.join(d, 'a.enc.partial');
    const digest = await write(partial, fn);
    const onDisk = readFileSync(partial);
    expect(digest).toEqual({ sha256: sha(onDisk), size: onDisk.length });
    const out = path.join(d, 'out');
    const files = await unpackExport(partial, keys.privateKey, out);
    expect(files.map((f) => f.name)).toEqual(['data/customers.ndjson', 'data/empty.ndjson', 'manifest.json', 'data/big.ndjson']);
    expect(readFileSync(path.join(out, 'data/customers.ndjson'), 'utf8')).toBe('{"id":"1","name":"plain-marker-silver-ornament"}\n{"id":"2","name":"सिद्धि 💍"}\n');
    expect(readFileSync(path.join(out, 'data/empty.ndjson'), 'utf8')).toBe('');
    expect(readFileSync(path.join(out, 'data/big.ndjson'), 'utf8')).toBe(big);
    expect(JSON.parse(readFileSync(path.join(out, 'manifest.json'), 'utf8')).marker).toBe('plain-marker-silver-ornament');
  });

  it('the file shows nothing: no marker text, not gzip, and two exports of the same data differ (a fresh key and iv each time) yet both unpack', async () => {
    const d = tmp();
    const a = path.join(d, 'a.enc');
    const b = path.join(d, 'b.enc');
    const da = await write(a);
    const db_ = await write(b);
    expect(da.sha256).not.toBe(db_.sha256);
    const bytes = readFileSync(a);
    expect(bytes.subarray(0, 4).toString()).toBe('JVE1');
    expect(bytes.includes(Buffer.from('plain-marker'))).toBe(false);
    expect(bytes.includes(Buffer.from('customers'))).toBe(false);
    for (const f of [a, b]) {
      const out = path.join(d, `out-${path.basename(f)}`);
      await unpackExport(f, keys.privateKey, out);
      expect(readFileSync(path.join(out, 'manifest.json'), 'utf8')).toContain('plain-marker');
    }
  });

  it('a wrong key, a changed byte anywhere (header, key, body, tag), a cut file and trailing bytes all fail, and say so', async () => {
    const d = tmp();
    const good = path.join(d, 'g.enc');
    await write(good);
    const bytes = readFileSync(good);
    const tryFile = async (name: string, mutate: (b: Buffer) => Buffer, key = keys.privateKey) => {
      const p = path.join(d, name);
      writeFileSync(p, mutate(Buffer.from(bytes)));
      await expect(unpackExport(p, key, path.join(d, `o-${name}`)), name).rejects.toThrow();
    };
    await tryFile('wrongkey.enc', (b) => b, other.privateKey);
    await tryFile('magic.enc', (b) => ((b[0] ^= 1), b));
    await tryFile('wrapped.enc', (b) => ((b[10] ^= 1), b)); // inside the wrapped key
    await tryFile('iv.enc', (b) => ((b[6 + b.readUInt16BE(4) + 3] ^= 1), b));
    await tryFile('body.enc', (b) => ((b[6 + b.readUInt16BE(4) + 12 + 5] ^= 1), b)); // five bytes into the ciphertext
    await tryFile('tag.enc', (b) => ((b[b.length - 1] ^= 1), b));
    await tryFile('cut.enc', (b) => b.subarray(0, b.length - 20));
    await tryFile('cutheader.enc', (b) => b.subarray(0, 20));
    await tryFile('empty.enc', () => Buffer.alloc(0));
    await tryFile('tail.enc', (b) => Buffer.concat([b, Buffer.from('extra')]));
    await expect(unpackExport(path.join(d, 'body.enc'), keys.privateKey, path.join(d, 'o2'))).rejects.toThrow(/cannot unpack the export/);
    await expect(unpackExport(good, other.privateKey, path.join(d, 'o3'))).rejects.toThrow(/not the private key/);
  });

  it('refuses paths that leave the folder (a container written by someone else is not trusted)', async () => {
    const d = tmp();
    for (const [i, evil] of ['../evil.txt', '/etc/evil.txt', 'a/../../evil.txt', 'a//b'].entries()) {
      const p = path.join(d, `e${i}.enc`);
      const w = await createExportWriter(p, publicKey);
      const f = w.sink.file(evil);
      await f.write('x');
      await f.close();
      await w.finish();
      await expect(unpackExport(p, keys.privateKey, path.join(d, `o${i}`)), evil).rejects.toThrow(/unsafe path/);
    }
    expect(existsSync(path.join(d, 'evil.txt'))).toBe(false);
  });

  it('writer rules: one file at a time, finish only when closed, a partial path that exists is an error, abort removes the partial', async () => {
    const d = tmp();
    const p = path.join(d, 'w.enc.partial');
    const w = await createExportWriter(p, publicKey);
    const f = w.sink.file('data/a.ndjson');
    expect(() => w.sink.file('data/b.ndjson')).toThrow(/one export file/);
    await f.write('{}\n');
    await expect(w.finish()).rejects.toThrow(/still open/);
    await f.close();
    await w.abort();
    expect(existsSync(p)).toBe(false);
    writeFileSync(p, 'x');
    await expect(createExportWriter(p, publicKey)).rejects.toThrow(/EEXIST/);
  });

  it('the public key is accepted as PEM, as the base64 of the PEM (one line, as an environment variable) or as base64 DER; garbage and nothing are refused', () => {
    expect(() => loadPublicKey(keys.publicKey)).not.toThrow();
    expect(() => loadPublicKey(Buffer.from(keys.publicKey).toString('base64'))).not.toThrow();
    const der = (loadPublicKey(keys.publicKey).export({ type: 'spki', format: 'der' }) as Buffer).toString('base64');
    expect(() => loadPublicKey(der)).not.toThrow();
    expect(() => loadPublicKey('')).toThrow(/missing/);
    expect(() => loadPublicKey('not a key at all')).toThrow(/cannot be read/);
  });
});

describe('writing the daily export (create-once, the retry rule, the monthly link)', () => {
  const run = (dir: string, over: Record<string, unknown> = {}) =>
    writeDailyExport({ dir, date: '2026-10-16', runId: 1, publicKey, exportFn: fakeExport(), ...over } as any);

  it('writes daily/<date>.enc and links monthly/<yyyy-mm>.enc to the same file; no .partial is left; the sha256 and size are recorded BEFORE the link', async () => {
    const dir = tmp();
    const seen: any[] = [];
    const r = await run(dir, {
      record: async (info: any) => {
        seen.push({ ...info, finalThere: existsSync(path.join(dir, 'daily/2026-10-16.enc')), partial: names(dir, 'daily').filter((n) => n.endsWith('.partial')) });
      },
    });
    expect(r).toMatchObject({ status: 'written', name: 'daily/2026-10-16.enc', conflict: false, monthly: 'monthly/2026-10.enc', alerts: [] });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ name: 'daily/2026-10-16.enc', run_id: '1', finalThere: false, partial: ['2026-10-16-1.enc.partial'] });
    const final = path.join(dir, 'daily/2026-10-16.enc');
    expect(seen[0].sha256).toBe(sha(readFileSync(final)));
    expect(seen[0].size).toBe(statSync(final).size);
    expect(r.sha256).toBe(seen[0].sha256);
    expect(names(dir, 'daily')).toEqual(['2026-10-16.enc']);
    expect(names(dir, 'monthly')).toEqual(['2026-10.enc']);
    expect(statSync(path.join(dir, 'monthly/2026-10.enc')).ino).toBe(statSync(final).ino);
    expect(statSync(final).nlink).toBe(2);
    const out = path.join(dir, '..', path.basename(dir) + '-out');
    dirs.push(out);
    await unpackExport(final, keys.privateKey, out);
    expect(readFileSync(path.join(out, 'manifest.json'), 'utf8')).toContain('plain-marker');
  });

  it('a later night of the same month writes its own daily file and leaves monthly/ alone; pruning a daily file does not remove the monthly one', async () => {
    const dir = tmp();
    const first = await run(dir, { date: '2026-10-01' });
    const monthlyBytes = readFileSync(path.join(dir, 'monthly/2026-10.enc'));
    const second = await run(dir, { date: '2026-10-02', runId: 2 });
    expect(second.monthly).toBeNull();
    expect(readFileSync(path.join(dir, 'monthly/2026-10.enc')).equals(monthlyBytes)).toBe(true);
    expect(first.sha256).toBe(sha(monthlyBytes));
    rmSync(path.join(dir, 'daily/2026-10-01.enc'));
    expect(readFileSync(path.join(dir, 'monthly/2026-10.enc')).equals(monthlyBytes)).toBe(true);
    const next = await run(dir, { date: '2026-11-01', runId: 3 });
    expect(next.monthly).toBe('monthly/2026-11.enc');
  });

  it('a crash between the link and the `ok` row is repaired on the retry: the recorded sha256 matches, nothing is dumped again, nothing changes', async () => {
    const dir = tmp();
    let recorded: any = null;
    const first = await run(dir, { record: async (i: any) => void (recorded = { name: i.name, sha256: i.sha256, size: i.size }) });
    const before = names(dir, 'daily');
    let called = 0;
    const again = await run(dir, { runId: 2, recorded, exportFn: async (s: any) => (called++, fakeExport()(s)) });
    expect(called).toBe(0);
    expect(again).toMatchObject({ status: 'already_done', name: first.name, sha256: first.sha256, conflict: false });
    expect(names(dir, 'daily')).toEqual(before);
    expect(await checkRecordedExport(dir, recorded)).toMatchObject({ done: true });
  });

  it('a final file that differs from the record (or no record at all) is left alone, an alert is raised and this run writes daily/<date>-<run id>.enc', async () => {
    const dir = tmp();
    let recorded: any = null;
    await run(dir, { record: async (i: any) => void (recorded = { name: i.name, sha256: i.sha256, size: i.size }) });
    const final = path.join(dir, 'daily/2026-10-16.enc');
    const original = readFileSync(final);
    // 1. the record is of another file: a different night's attempt, or the file was changed
    const r1 = await run(dir, { runId: 7, recorded: { ...recorded, sha256: 'a'.repeat(64) } });
    expect(r1).toMatchObject({ status: 'written', name: 'daily/2026-10-16-7.enc', conflict: true });
    expect(r1.alerts.map((a) => a.code).sort()).toEqual(['export_name_taken', 'export_record_mismatch']);
    expect(readFileSync(final).equals(original)).toBe(true);
    // 2. no record at all, the plain name is taken
    const r2 = await run(dir, { runId: 8 });
    expect(r2).toMatchObject({ name: 'daily/2026-10-16-8.enc', conflict: true });
    expect(r2.alerts.map((a) => a.code)).toEqual(['export_name_taken']);
    expect(readFileSync(final).equals(original)).toBe(true);
    expect(names(dir, 'daily')).toEqual(['2026-10-16-7.enc', '2026-10-16-8.enc', '2026-10-16.enc']);
    // 3. the recorded file was changed after it was linked (a damaged disk): the size or the hash no longer fits
    writeFileSync(final, Buffer.concat([original, Buffer.from('!')]));
    expect(await checkRecordedExport(dir, recorded)).toMatchObject({ done: false, reason: 'differs' });
  });

  it('the plain name appearing between the check and the link is never overwritten: this run goes under its own name and records that', async () => {
    const dir = tmp();
    const calls: string[] = [];
    const r = await run(dir, {
      runId: 5,
      record: async (i: any) => {
        calls.push(i.name);
        if (calls.length === 1) mk(dir, 'daily/2026-10-16.enc', 'somebody else was faster');
      },
    });
    expect(calls).toEqual(['daily/2026-10-16.enc', 'daily/2026-10-16-5.enc']);
    expect(r).toMatchObject({ name: 'daily/2026-10-16-5.enc', conflict: true });
    expect(readFileSync(path.join(dir, 'daily/2026-10-16.enc'), 'utf8')).toBe('somebody else was faster');
  });

  it('a failed export or a failed record leaves no final file and no partial, and the error comes through', async () => {
    const dir = tmp();
    await expect(run(dir, { exportFn: async (s: any) => { const f = s.sink ? null : s.file('data/a.ndjson'); await f!.write('{}\n'); throw new Error('database went away'); } })).rejects.toThrow('database went away');
    expect(names(dir, 'daily')).toEqual([]);
    expect(names(dir, 'monthly')).toEqual([]);
    await expect(run(dir, { record: async () => { throw new Error('backup_runs is not writable'); } })).rejects.toThrow('not writable');
    expect(names(dir, 'daily')).toEqual([]);
    expect(names(dir, 'monthly')).toEqual([]);
  });

  it('at the start of a job `.partial` files older than an hour go and younger ones stay (also in photos/); finals and other names are never touched', async () => {
    const dir = tmp();
    await prepareFolder(dir);
    mk(dir, 'daily/2026-10-10.enc.partial', 'old', 61 * 60_000);
    mk(dir, 'daily/2026-10-11.enc.partial', 'young', 10 * 60_000);
    mk(dir, 'monthly/2026-09.enc.partial', 'old', 3 * 3600_000);
    mk(dir, `photos/${uuid()}-full.abc.partial`, 'old', 2 * 3600_000);
    mk(dir, 'daily/2026-10-09.enc', 'final, old', 90 * 86400_000);
    mk(dir, 'daily/notes.txt', 'mine', 5 * 3600_000);
    const removed = await sweepPartials(dir);
    expect(removed).toHaveLength(3);
    expect(removed).toEqual(expect.arrayContaining(['daily/2026-10-10.enc.partial', 'monthly/2026-09.enc.partial']));
    expect(removed.filter((n) => n.startsWith('photos/') && n.endsWith('.partial'))).toHaveLength(1);
    expect(names(dir, 'daily')).toEqual(['2026-10-09.enc', '2026-10-11.enc.partial', 'notes.txt']);
    const r = await run(dir, { date: '2026-10-12' }); // the job's own start sweeps too
    expect(r.status).toBe('written');
    mk(dir, 'daily/stale.enc.partial', 'old', 2 * 3600_000);
    await run(dir, { date: '2026-10-13', runId: 2 });
    expect(names(dir, 'daily')).not.toContain('stale.enc.partial');
  });

  it('linkMonthly never overwrites and says whether it created the file', async () => {
    const dir = tmp();
    await prepareFolder(dir);
    mk(dir, 'daily/2026-10-01.enc', 'one');
    mk(dir, 'daily/2026-10-02.enc', 'two');
    expect(await linkMonthly(dir, 'daily/2026-10-01.enc', '2026-10-01')).toBe(true);
    expect(await linkMonthly(dir, 'daily/2026-10-02.enc', '2026-10-02')).toBe(false);
    expect(readFileSync(path.join(dir, 'monthly/2026-10.enc'), 'utf8')).toBe('one');
  });
});

describe('folderStats', () => {
  it('counts the final files of daily/, monthly/ and photos/ with their size and the free disk; partials and loose files are not counted', async () => {
    const dir = tmp();
    await prepareFolder(dir);
    mk(dir, 'daily/2026-10-01.enc', '12345');
    mk(dir, 'daily/2026-10-02.enc', '123');
    mk(dir, 'monthly/2026-10.enc', '12');
    mk(dir, `photos/${uuid()}-full`, '1234567');
    mk(dir, 'daily/2026-10-03.enc.partial', 'partial');
    mk(dir, 'README.txt', 'not in a sub-folder');
    const s = await folderStats(dir);
    expect(s).toMatchObject({ files: 4, bytes: 5 + 3 + 2 + 7, daily: 2, monthly: 1, photos: 1 });
    expect(s.free_bytes).toBeGreaterThan(0);
    expect(await fileDigest(path.join(dir, 'daily/2026-10-01.enc'))).toEqual({ sha256: sha('12345'), size: 5 });
  });
});

describe('pruning (T-R03): guard rails, because there is no lock to lean on', () => {
  const fill = (dir: string, nDaily: number, nMonthly = 0) => {
    for (let i = 0; i < nDaily; i++) mk(dir, `daily/${day(i)}.enc`, `d${i}`);
    for (let i = 0; i < nMonthly; i++) mk(dir, `monthly/${2025 + Math.floor((i + 8) / 12)}-${String(((i + 8) % 12) + 1).padStart(2, '0')}.enc`, `m${i}`);
  };

  it('constants: 30 daily and 13 monthly are always kept; asking to keep fewer is an error', async () => {
    expect([KEEP_DAILY, KEEP_MONTHLY]).toEqual([30, 13]);
    const dir = tmp();
    await prepareFolder(dir);
    await expect(planPrune(dir, { keepDaily: 29 })).rejects.toThrow(/always kept/);
    await expect(planPrune(dir, { keepMonthly: 12 })).rejects.toThrow(/always kept/);
  });

  it('after 40 failed nights nothing is deleted: no good write tonight, no prune, however many files or however old', async () => {
    const dir = tmp();
    await prepareFolder(dir);
    fill(dir, 45, 16);
    for (const ok of [false, undefined, 'yes'] as any[]) {
      const r = await prune(dir, { goodWriteTonight: ok, lastRecordedFiles: 0, dryRunDone: true });
      expect(r).toMatchObject({ action: 'refused', reason: 'no_good_write_tonight', removed: [] });
    }
    expect(names(dir, 'daily')).toHaveLength(45);
    expect(names(dir, 'monthly')).toHaveLength(16);
  });

  it('after a good night the 31st daily file goes, after a logged dry run; the first real prune is always preceded by one', async () => {
    const dir = tmp();
    await prepareFolder(dir);
    fill(dir, 31);
    const dry = await prune(dir, { goodWriteTonight: true, lastRecordedFiles: 30, dryRunDone: false });
    expect(dry).toMatchObject({ action: 'dry_run', candidates: [`daily/${day(0)}.enc`], removed: [] });
    expect(names(dir, 'daily')).toHaveLength(31);
    const real = await prune(dir, { goodWriteTonight: true, lastRecordedFiles: 30, dryRunDone: true });
    expect(real).toMatchObject({ action: 'pruned', removed: [`daily/${day(0)}.enc`] });
    expect(names(dir, 'daily')).toEqual(Array.from({ length: 30 }, (_, i) => `${day(i + 1)}.enc`));
    expect(await prune(dir, { goodWriteTonight: true, lastRecordedFiles: 30, dryRunDone: true })).toMatchObject({ action: 'nothing', removed: [] });
  });

  it('13 monthly files stay, the 14th goes; the newest are kept whatever their age', async () => {
    const dir = tmp();
    await prepareFolder(dir);
    fill(dir, 3, 14);
    const r = await prune(dir, { goodWriteTonight: true, lastRecordedFiles: 0, dryRunDone: true });
    expect(r.removed).toEqual(['monthly/2025-09.enc']);
    expect(names(dir, 'monthly')).toHaveLength(13);
    expect(names(dir, 'daily')).toHaveLength(3);
    // very old files that are among the newest 30 are kept
    const dir2 = tmp();
    await prepareFolder(dir2);
    for (let i = 0; i < 10; i++) mk(dir2, `daily/${day(i)}.enc`, 'x', 2000 * 86400_000);
    expect((await prune(dir2, { goodWriteTonight: true, dryRunDone: true })).action).toBe('nothing');
    expect(names(dir2, 'daily')).toHaveLength(10);
  });

  it('refuses a folder with fewer files than the last recorded count (files went that this job did not remove), and says the numbers', async () => {
    const dir = tmp();
    await prepareFolder(dir);
    fill(dir, 35);
    const r = await prune(dir, { goodWriteTonight: true, lastRecordedFiles: 36, dryRunDone: true });
    expect(r).toMatchObject({ action: 'refused', reason: 'fewer_files_than_recorded', files: 35, recorded: 36, removed: [] });
    expect(names(dir, 'daily')).toHaveLength(35);
    expect((await prune(dir, { goodWriteTonight: true, lastRecordedFiles: 35, dryRunDone: true })).action).toBe('pruned');
  });

  it('only exact name patterns are touched: photos/, partials, other names, folders and symbolic links stay; "newest" is by the date in the name, not by the file time', async () => {
    const dir = tmp();
    await prepareFolder(dir);
    fill(dir, 33);
    mk(dir, 'daily/README.txt', 'mine', 400 * 86400_000);
    mk(dir, 'daily/2026-09-01.enc.bak', 'backup of a backup', 400 * 86400_000);
    mk(dir, 'daily/2026-9-1.enc', 'not a date', 400 * 86400_000);
    mk(dir, 'daily/2026-09-01-.enc', 'not a run id', 400 * 86400_000);
    mk(dir, 'daily/2026-09-01.enc.partial', 'partial', 400 * 86400_000);
    mk(dir, 'monthly/latest.enc', 'mine', 400 * 86400_000);
    for (let i = 0; i < 40; i++) mk(dir, `photos/${uuid()}-full`, 'photo', 900 * 86400_000);
    mkdirSync(path.join(dir, 'daily/2026-08-01.enc'));
    symlinkSync(path.join(dir, 'README-target'), path.join(dir, 'daily/2026-08-02.enc'));
    // the OLDEST date gets the NEWEST file time; it must still be the first to go
    const oldest = path.join(dir, `daily/${day(0)}.enc`);
    utimesSync(oldest, Date.now() / 1000 + 100, Date.now() / 1000 + 100);
    const r = await prune(dir, { goodWriteTonight: true, dryRunDone: true });
    expect(r.removed).toEqual([`daily/${day(2)}.enc`, `daily/${day(1)}.enc`, `daily/${day(0)}.enc`]); // newest first; the oldest date goes although its file time is the newest
    expect(names(dir, 'daily').filter((n) => !/^2026-(09|10)-\d\d\.enc$/.test(n))).toEqual(['2026-08-01.enc', '2026-08-02.enc', '2026-09-01-.enc', '2026-09-01.enc.bak', '2026-09-01.enc.partial', '2026-9-1.enc', 'README.txt']);
    expect(names(dir, 'monthly')).toEqual(['latest.enc']);
    expect(names(dir, 'photos')).toHaveLength(40);
  });

  it('a retried night can leave two files for one date: "newest 30" counts files, and of two with one date the newer file is kept first', async () => {
    const dir = tmp();
    await prepareFolder(dir);
    fill(dir, 30);
    mk(dir, `daily/${day(29)}-7.enc`, 'second file for the same date', 0);
    const plain = path.join(dir, `daily/${day(29)}.enc`);
    utimesSync(plain, Date.now() / 1000 - 5000, Date.now() / 1000 - 5000);
    const plan = await planPrune(dir);
    expect(plan.remove).toEqual([`daily/${day(0)}.enc`]);
    expect(plan.keep).toContain(`daily/${day(29)}-7.enc`);
    expect(plan.keep).toContain(`daily/${day(29)}.enc`);
  });
});

describe('the photo copy in the same folder: .partial, fsync, link', () => {
  it('a photo is written once; the same bytes again are accepted; other bytes under the same name are refused and the file is not changed; no partial is left', async () => {
    const dir = tmp();
    await prepareFolder(dir);
    const store = directoryPhotos(path.join(dir, 'photos'));
    const id = uuid();
    const bytes = randomBytes(5000);
    await store.put(id, 'full', bytes);
    await store.put(id, 'full', bytes);
    await expect(store.put(id, 'full', randomBytes(5000))).rejects.toThrow(/already exists with different content/);
    await expect(store.put(id, 'full', Buffer.concat([bytes, Buffer.from('x')]))).rejects.toThrow(/already exists with different content/);
    expect(readFileSync(path.join(dir, 'photos', `${id}-full`)).equals(bytes)).toBe(true);
    expect(names(dir, 'photos')).toEqual([`${id}-full`]);
    expect(await store.head(id, 'full')).toEqual({ size: 5000 });
    expect(await store.head(id, 'thumb')).toBeNull();
    expect((await store.get(id, 'full'))!.equals(bytes)).toBe(true);
    expect(await store.get(id, 'thumb')).toBeNull();
  });
});

describe('the dashboard rows (database)', () => {
  it('recordBackupRun writes the keys the dashboard reads; readPruneState gives the last good folder count and whether a dry run was ever logged', async () => {
    const { db, c } = await migratedDb('s19_rows');
    dbs.push(db);
    expect(await readPruneState(c)).toEqual({ lastRecordedFiles: null, dryRunDone: false });
    await expect(recordBackupRun(c, { kind: 'backup' as any, ok: true })).rejects.toThrow(/unknown backup kind/);
    await expect(recordBackupRun(c, { kind: 'db_dump', ok: true, detail: { folder: { files: 'many', bytes: 1 } } })).rejects.toThrow(/detail.folder.files/);
    await expect(recordBackupRun(c, { kind: 'db_dump', ok: true, detail: { pruned: -1 } })).rejects.toThrow(/pruned/);
    await recordBackupRun(c, { kind: 'db_dump', ok: true, bytes: 10, detail: { folder: { files: 40, bytes: 4000, free_bytes: 1 } }, ranAt: '2026-10-14 21:00:00.000000' });
    await recordBackupRun(c, { kind: 'db_dump', ok: false, detail: { folder: { files: 3, bytes: 3 } }, ranAt: '2026-10-15 21:00:00.000000' }); // a failed run is not an observation
    expect(await readPruneState(c)).toEqual({ lastRecordedFiles: 40, dryRunDone: false });
    await recordBackupRun(c, { kind: 'db_dump', ok: true, detail: { folder: { files: 41, bytes: 4100 }, prune_dry_run: { names: ['daily/2026-09-01.enc'] } }, ranAt: '2026-10-15 22:00:00.000000' });
    expect(await readPruneState(c)).toEqual({ lastRecordedFiles: 41, dryRunDone: true });
    // the dashboard: 41 -> 38 with nothing pruned is red; with pruned: 3 it is not
    await recordBackupRun(c, { kind: 'photo_copy', ok: true, detail: { folder: { files: 38, bytes: 3800 } }, ranAt: '2026-10-15 23:00:00.000000' });
    const now = '2026-10-16 01:00:00';
    await c.query("INSERT INTO check_runs (ran_at, ok) VALUES ('2026-10-15 23:30:00.000000', 1)");
    expect((await readHealth(c, { now, sizeBytes: 1 })).reasons).toContain('backup_files_fell');
    await c.query('DELETE FROM backup_runs WHERE kind = ?', ['photo_copy']);
    await recordBackupRun(c, { kind: 'photo_copy', ok: true, detail: { folder: { files: 38, bytes: 3800 }, pruned: 3 }, ranAt: '2026-10-15 23:00:00.000000' });
    expect((await readHealth(c, { now, sizeBytes: 1 })).reasons).not.toContain('backup_files_fell');
    await c.end();
  });

  it('the retry rule end to end: the record written before the link is read back for the business date and makes the next try a no-op', async () => {
    const { db, c } = await migratedDb('s19_retry');
    dbs.push(db);
    const dir = tmp();
    expect(await readRecordedExport(c, '2026-10-16')).toBeNull();
    const first = await writeDailyExport({
      dir, date: '2026-10-16', runId: 1, publicKey, exportFn: fakeExport(),
      record: async (info: any) => void (await recordBackupRun(c, { kind: 'db_dump', ok: false, detail: { export: { name: info.name, sha256: info.sha256, size: info.size } } })), // written before the link, not ok yet
    });
    // the process "died" before the ok row: the next hourly try finds the record and does nothing
    const recorded = await readRecordedExport(c, '2026-10-16');
    expect(recorded).toEqual({ name: first.name, sha256: first.sha256, size: first.size });
    expect(await readRecordedExport(c, '2026-10-17')).toBeNull();
    let dumped = 0;
    const retry = await writeDailyExport({ dir, date: '2026-10-16', runId: 2, publicKey, recorded, exportFn: async (s: any) => (dumped++, fakeExport()(s)) });
    expect(retry).toMatchObject({ status: 'already_done', name: 'daily/2026-10-16.enc' });
    expect(dumped).toBe(0);
    // a later conflict file is the newest record for that date
    await recordBackupRun(c, { kind: 'db_dump', ok: true, detail: { export: { name: 'daily/2026-10-16-9.enc', sha256: 'b'.repeat(64), size: 5 } } });
    expect(await readRecordedExport(c, '2026-10-16')).toEqual({ name: 'daily/2026-10-16-9.enc', sha256: 'b'.repeat(64), size: 5 });
    await c.end();
  });

  it('the whole chain: export -> one encrypted file in the folder -> unpack with the private key -> restore into an empty database equals the source', async () => {
    const src = await migratedDb('s19_chain_src');
    dbs.push(src.db);
    const w = await cleanWorld(src.c);
    await insert(src.c, 'customers', V.customer({ name: 'Siddhi 💍 सिद्धि', mobile: '9000000042' }));
    const dir = tmp();
    const manifest = await writeDailyExport({
      dir,
      date: '2026-10-16',
      runId: 1,
      publicKey,
      exportFn: (sink: any) => exportDatabase(src.c, sink, { pageSize: 2 }),
    });
    expect(manifest.status).toBe('written');
    expect(manifest.manifest!.tables.length).toBeGreaterThan(10);
    const out = tmp();
    await unpackExport(path.join(dir, manifest.name), keys.privateKey, out);
    const tdb = await freshDb('s19_chain_dst');
    dbs.push(tdb);
    const tc: Connection = await appConn(tdb);
    const report = await restoreDatabase(tc, directoryStore(out).source, memoryPhotos());
    expect(report.problems).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.tables.every((t: any) => t.hash_ok && t.rows_expected === t.rows_restored)).toBe(true);
    expect(w.a.id).toBeTruthy();
    await tc.end();
    await src.c.end();
  });
});

describe('pacing the opening of new connections (S11, IM1, B4)', () => {
  it('never more than 10 openings in any 1.2 seconds, 35 callers, served in order (a fake clock)', async () => {
    let t = 0;
    const times: number[] = [];
    const pacer = createPacer({ max: 10, windowMs: 1200, now: () => t, sleep: async (ms) => void (t += ms) });
    const order: number[] = [];
    await Promise.all(
      Array.from({ length: 35 }, async (_, i) => {
        await pacer.wait();
        times.push(t);
        order.push(i);
      })
    );
    expect(order).toEqual(Array.from({ length: 35 }, (_, i) => i));
    expect(times.slice(0, 10)).toEqual(Array(10).fill(0));
    for (let i = 10; i < times.length; i++) expect(times[i] - times[i - 10], `opening ${i}`).toBeGreaterThanOrEqual(1200);
    expect(times[34]).toBeGreaterThanOrEqual(3600);
    expect(times[34]).toBeLessThan(3700);
  });

  it('a quiet spell empties the window; a pacer needs a positive whole limit; pacedConnect waits and then connects (real timers, small numbers)', async () => {
    expect(() => createPacer({ max: 0 })).toThrow(/positive/);
    const pacer = createPacer({ max: 3, windowMs: 120 });
    const started = Date.now();
    const got: string[] = [];
    for (let i = 0; i < 7; i++) got.push(await pacedConnect(pacer, async () => `conn${i}`));
    expect(got).toEqual(['conn0', 'conn1', 'conn2', 'conn3', 'conn4', 'conn5', 'conn6']);
    expect(Date.now() - started).toBeGreaterThanOrEqual(230); // 7 openings, 3 per 120 ms: the 7th cannot come before 240 ms (small timer slack)
    await new Promise((r) => setTimeout(r, 140));
    const t0 = Date.now();
    await pacer.wait();
    await pacer.wait();
    await pacer.wait();
    expect(Date.now() - t0).toBeLessThan(60);
    const failing = createPacer({ max: 1, windowMs: 30 });
    await expect(pacedConnect(failing, async () => { throw new Error('EPERM'); })).rejects.toThrow('EPERM');
    await expect(pacedConnect(failing, async () => 'next')).resolves.toBe('next'); // a failed connect does not break the queue
  });
});
