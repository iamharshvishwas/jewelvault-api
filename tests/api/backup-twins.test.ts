import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Connection } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as scriptBackup from '../../scripts/backup.mjs';
import * as scriptFolder from '../../scripts/backup-folder.mjs';
import { type DbPool, createDbPool } from '../../src/db/pool';
import { type TxContext, txContext } from '../../src/db/tx';
import * as twinFolder from '../../src/jobs/backupFolder';
import { recordBackupRun as twinRecord } from '../../src/jobs/backupRuns';
import { copyPhotos } from '../../src/jobs/photoCopy';
import { type Scratch, scratchDatabase } from '../helpers';

// T-R04 (I8, B2, D25): src cannot import scripts/*.mjs (the build's rootDir is src), so the tick's photo copy has TypeScript twins of what the database half wrote in MB03 and MB05: `copyPhotosOnce`
// (scripts/backup.mjs), the directory store `directoryPhotos` of that file, and `resolveBackupDir`, `folderStats` and `recordBackupRun` (scripts/backup-folder.mjs). This file keeps each twin equal
// to its script on the same inputs and on a real database: the same answers, the same errors, the same files and rows. A change to a script is a change to its twin, or this test fails.
// (The twin of closeFinishedHour is src/auth/loginCounters.ts, API08, kept equal by tests/api/login-counters-twin.test.ts; the twin of withJobLock is src/jobs/lock.ts, API33.)

type Outcome = { ok: unknown } | { error: string };
async function outcomeOf(fn: () => unknown): Promise<Outcome> {
  try {
    return { ok: await fn() };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

describe('T-R04 resolveBackupDir: the twin equals the script (JV_BACKUP_DIR, B2)', () => {
  const values: unknown[] = ['/home/u/jv-backup', '/home/u/jv-backup/', '/home/u//jv-backup/./x', ' /home/u/jv-backup ', '', '   ', undefined, null, 5, '~/jv-backup', '/home/u/~x', 'jv-backup', './jv-backup', '/home/u/../root', '/', '//', '/a/b/..', '/home/u/jv backup'];
  it.each(values.map((v) => [JSON.stringify(v) ?? 'undefined', v]))('%s', async (_label, value) => {
    expect(await outcomeOf(() => twinFolder.resolveBackupDir(value))).toEqual(await outcomeOf(() => scriptFolder.resolveBackupDir(value as string)));
  });
});

describe('T-R04 directoryPhotos: the twin equals the script (create-once, fsync, link)', () => {
  const dirs: string[] = [];
  const fresh = async () => {
    const d = await mkdtemp(path.join(tmpdir(), 'jv-twin-photos-'));
    dirs.push(d);
    return d;
  };
  afterAll(async () => {
    for (const d of dirs) await rm(d, { recursive: true, force: true });
  });

  /** The same story told to a store, written down as what it answered and what was left in the folder. */
  async function story(make: (dir: string) => ReturnType<typeof scriptBackup.directoryPhotos>) {
    const dir = path.join(await fresh(), 'photos'); // does not exist yet: the first put makes it
    const store = make(dir);
    const id = '11111111-1111-4111-8111-111111111111';
    const out: Record<string, unknown> = {};
    out.missingHead = await store.head(id, 'full');
    out.missingGet = await store.get(id, 'full');
    out.putNew = await outcomeOf(() => store.put(id, 'full', Buffer.from('first bytes')));
    out.head = await store.head(id, 'full');
    out.get = (await store.get(id, 'full'))?.toString();
    out.putSameBytes = await outcomeOf(() => store.put(id, 'full', Buffer.from('first bytes')));
    out.putOtherBytes = (await outcomeOf(() => store.put(id, 'full', Buffer.from('other bytes')))) as Outcome;
    out.putOtherSize = (await outcomeOf(() => store.put(id, 'full', Buffer.from('longer other bytes')))) as Outcome;
    out.stillFirst = (await store.get(id, 'full'))?.toString();
    out.thumb = await outcomeOf(() => store.put(id, 'thumb', Buffer.from('t')));
    out.names = (await readdir(dir)).sort(); // no .partial is left behind, whatever happened
    // a path whose parent is a file: an error that is not "missing" is NOT swallowed
    const file = path.join(await fresh(), 'a-file');
    await writeFile(file, 'x');
    out.notADirectory = await outcomeOf(() => make(path.join(file, 'photos')).head(id, 'full')).then((o) => ('error' in o ? { error: o.error.replace(file, '<file>') } : o));
    return out;
  }

  it('answers, errors and files are the same for the script and the twin', async () => {
    const script = await story((d) => scriptBackup.directoryPhotos(d));
    const twin = await story((d) => twinFolder.directoryPhotos(d));
    expect(twin).toEqual(script);
    expect(script.putNew).toEqual({ ok: undefined });
    expect(script.putSameBytes).toEqual({ ok: undefined }); // the same bytes again are accepted
    expect(script.putOtherBytes).toMatchObject({ error: expect.stringMatching(/already exists with different content/) }); // other bytes are refused, never written over
    expect(script.putOtherSize).toMatchObject({ error: expect.stringMatching(/already exists with different content/) });
    expect(script.stillFirst).toBe('first bytes');
    expect(script.head).toEqual({ size: 11 });
    expect(script.names).toEqual(['11111111-1111-4111-8111-111111111111-full', '11111111-1111-4111-8111-111111111111-thumb']);
  });
});

describe('T-R04 folderStats: the twin equals the script (the figures of backup_runs.detail.folder)', () => {
  let root: string;
  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'jv-twin-folder-'));
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const stats = async (dir: string) => {
    const [a, b] = [await scriptFolder.folderStats(dir), await twinFolder.folderStats(dir)];
    return { script: a, twin: b };
  };

  it('counts final files of daily, monthly and photos (not .partial, not a sub-folder), their bytes, and the free disk', async () => {
    for (const sub of ['daily', 'monthly', 'photos']) await mkdir(path.join(root, sub));
    await writeFile(path.join(root, 'daily', '2026-10-16.enc'), Buffer.alloc(10));
    await writeFile(path.join(root, 'daily', '2026-10-17.enc'), Buffer.alloc(20));
    await writeFile(path.join(root, 'daily', '2026-10-17.enc.x.partial'), Buffer.alloc(99));
    await writeFile(path.join(root, 'monthly', '2026-10.enc'), Buffer.alloc(30));
    await writeFile(path.join(root, 'photos', 'a-full'), Buffer.alloc(5));
    await writeFile(path.join(root, 'photos', 'b-thumb'), Buffer.alloc(7));
    await writeFile(path.join(root, 'photos', 'c-full.y.partial'), Buffer.alloc(9));
    await mkdir(path.join(root, 'photos', 'a-folder'));
    await writeFile(path.join(root, 'other.txt'), Buffer.alloc(1234)); // outside the three folders: not counted
    const { script, twin } = await stats(root);
    const { free_bytes: scriptFree, ...scriptRest } = script;
    const { free_bytes: twinFree, ...twinRest } = twin;
    expect(twinRest).toEqual(scriptRest);
    expect(scriptRest).toEqual({ files: 5, bytes: 72, daily: 2, monthly: 1, photos: 2 });
    expect(typeof twinFree).toBe(typeof scriptFree);
    expect(twinFree === null).toBe(scriptFree === null);
    expect(twinFree).toBeGreaterThan(0);
  });

  it('a folder with a sub-folder missing counts it as nothing; a missing folder has no files and no free figure; both the same', async () => {
    const half = await mkdtemp(path.join(tmpdir(), 'jv-twin-half-'));
    try {
      await mkdir(path.join(half, 'daily'));
      await writeFile(path.join(half, 'daily', '2026-10-17.enc'), Buffer.alloc(3));
      const { script, twin } = await stats(half);
      expect({ ...twin, free_bytes: null }).toEqual({ ...script, free_bytes: null });
      expect(script).toMatchObject({ files: 1, bytes: 3, daily: 1, monthly: 0, photos: 0 });
    } finally {
      await rm(half, { recursive: true, force: true });
    }
    const gone = path.join(root, 'no-such-folder');
    const { script, twin } = await stats(gone);
    expect(twin).toEqual(script);
    expect(script).toEqual({ files: 0, bytes: 0, free_bytes: null, daily: 0, monthly: 0, photos: 0 });
  });

  it('assertFolderUsable: a folder that is there and can be written passes; a missing one is ENOENT and is NOT made; a file is ENOTDIR', async () => {
    await expect(twinFolder.assertFolderUsable(root)).resolves.toBeUndefined();
    const missing = path.join(root, 'not-made');
    await expect(twinFolder.assertFolderUsable(missing)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readdir(root)).not.toContain('not-made'); // the check never makes the folder (B2: a missing folder is never read as "nothing due")
    const file = path.join(root, 'other.txt');
    await expect(twinFolder.assertFolderUsable(file)).rejects.toMatchObject({ code: 'ENOTDIR' });
  });
});

describe('T-R04 recordBackupRun and copyPhotos: the twins equal the scripts on a real database', () => {
  let a: Scratch; // the script writes here
  let b: Scratch; // the twin writes here, with the same photos
  let sqlA: Connection;
  let sqlB: Connection;
  let pool: DbPool;
  let ctx: () => TxContext;
  let dirA: string;
  let dirB: string;

  beforeAll(async () => {
    a = await scratchDatabase('twinsa', { schema: true });
    b = await scratchDatabase('twinsb', { schema: true });
    sqlA = await a.connect();
    sqlB = await b.connect();
    pool = createDbPool(b.db);
    ctx = () => txContext(pool, { requestId: randomUUID(), actor: { id: null, role: 'job' } });
    dirA = await mkdtemp(path.join(tmpdir(), 'jv-twin-a-'));
    dirB = await mkdtemp(path.join(tmpdir(), 'jv-twin-b-'));
  }, 120_000);
  afterAll(async () => {
    await pool?.end();
    await sqlA?.end();
    await sqlB?.end();
    await a?.drop();
    await b?.drop();
    await rm(dirA, { recursive: true, force: true });
    await rm(dirB, { recursive: true, force: true });
  });

  // ---------------------------------------------------------------- recordBackupRun

  const backupRows = async (sql: Connection) =>
    (await sql.query<any[]>('SELECT kind, ok, bytes, detail FROM backup_runs ORDER BY id'))[0].map((r) => ({ ...r, ok: Number(r.ok), bytes: Number(r.bytes), detail: typeof r.detail === 'string' ? JSON.parse(r.detail) : r.detail }));

  it('recordBackupRun writes the same rows for the same input, with the database clock and with a given time, and answers { id }', async () => {
    const inputs = [
      { kind: 'photo_copy', ok: true, bytes: 5, detail: { copied: 2, folder: { files: 3, bytes: 30, free_bytes: 100 } }, ranAt: '2026-10-17 10:00:00.000000' },
      { kind: 'db_dump', ok: false, detail: { error: 'x' } },
      { kind: 'restore_drill', ok: true },
      { kind: 'photo_copy', ok: true, bytes: 0, detail: { pruned: 4, folder: { files: '7', bytes: '70' } } },
    ];
    for (const input of inputs) {
      const s = await scriptFolder.recordBackupRun(sqlA as never, input as never);
      const t = await twinRecord(ctx(), input as never);
      expect(Object.keys(t)).toEqual(Object.keys(s));
      expect(typeof t.id).toBe(typeof s.id);
    }
    expect(await backupRows(sqlB)).toEqual(await backupRows(sqlA));
    const [times] = await sqlB.query<any[]>("SELECT DATE_FORMAT(ran_at, '%Y-%m-%d %H:%i:%s.%f') AS t FROM backup_runs ORDER BY id LIMIT 1");
    expect(times[0].t).toBe('2026-10-17 10:00:00.000000');
  });

  it('the same inputs are refused with the same words: an unknown kind, a folder figure that is not a number, a pruned count that is not a whole number', async () => {
    const bad = [
      { kind: 'other', ok: true },
      { kind: 'photo_copy', ok: true, detail: { folder: { files: 'many', bytes: 1 } } },
      { kind: 'photo_copy', ok: true, detail: { folder: { files: 1, bytes: 'big' } } },
      { kind: 'photo_copy', ok: true, detail: { pruned: -1 } },
      { kind: 'photo_copy', ok: true, detail: { pruned: 1.5 } },
    ];
    for (const input of bad) {
      const s = await outcomeOf(() => scriptFolder.recordBackupRun(sqlA as never, input as never));
      const t = await outcomeOf(() => twinRecord(ctx(), input as never));
      expect(t, JSON.stringify(input)).toEqual(s);
      expect(s).toHaveProperty('error');
    }
    expect(await backupRows(sqlB)).toEqual(await backupRows(sqlA)); // a refused call wrote nothing
  });

  // ---------------------------------------------------------------- copyPhotosOnce

  const T = (n: number) => `2026-10-01 00:00:${String(n).padStart(2, '0')}.000000`;
  const bytesOf = (label: string, n: number) => Buffer.concat([Buffer.from(`${label}:`), Buffer.alloc(n, label.charCodeAt(0))]);
  const sha = (b: Buffer) => createHash('sha256').update(b).digest();
  const ids = { p1: '00000000-0000-4000-8000-000000000001', p2: '00000000-0000-4000-8000-000000000002', p3: '00000000-0000-4000-8000-000000000003', p4: '00000000-0000-4000-8000-000000000004', p5: '00000000-0000-4000-8000-000000000005', p6: '00000000-0000-4000-8000-000000000006', p7: '00000000-0000-4000-8000-000000000007', p8: '00000000-0000-4000-8000-000000000008', p9: '00000000-0000-4000-8000-000000000009' };
  const photo = async (sql: Connection, id: string, kind: 'full' | 'thumb', at: number, o: { bytes?: Buffer; removed?: boolean; badSha?: boolean; copied?: boolean } = {}) => {
    const bytes = o.bytes ?? bytesOf(id.slice(-1) + kind[0], 100 + at);
    await sql.query('INSERT INTO design_photos (id, kind, design_id, mime, byte_size, sha256, bytes, removed_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [
      id,
      kind,
      randomUUID(),
      'image/jpeg',
      o.removed ? 10 : bytes.length,
      o.badSha ? Buffer.alloc(32, 9) : sha(bytes),
      o.removed ? null : bytes,
      o.removed ? '2026-10-02 00:00:00.000000' : null,
      T(at),
    ]);
    if (o.copied) await sql.query('INSERT INTO sys_photo_copies (photo_id, kind, sha256, size) VALUES (?, ?, ?, ?)', [id, kind, sha(bytes), bytes.length]);
  };
  const same = async (f: (sql: Connection) => Promise<void>) => {
    await f(sqlA);
    await f(sqlB);
  };
  const copies = async (sql: Connection) =>
    (await sql.query<any[]>('SELECT photo_id, kind, HEX(sha256) AS sha, size FROM sys_photo_copies ORDER BY photo_id, kind'))[0].map((r) => ({ ...r, size: Number(r.size) }));
  const files = async (dir: string) => {
    const out: Record<string, string> = {};
    for (const n of (await readdir(dir)).sort()) out[n] = createHash('sha256').update(await readFile(path.join(dir, n))).digest('hex');
    return out;
  };
  const strip = (r: { copied: number; bytes: number; failed: { id: string; kind: string; error: string }[] }) => ({ copied: r.copied, bytes: r.bytes, failed: r.failed });

  it('the same pending list in the same order, the same bytes copied, the same rows, the same failures, a removed photo and a copied one skipped; and a second run copies nothing', async () => {
    await same(async (sql) => {
      await photo(sql, ids.p1, 'full', 1);
      await photo(sql, ids.p1, 'thumb', 2);
      await photo(sql, ids.p2, 'full', 3);
      await photo(sql, ids.p3, 'full', 4, { removed: true });
      await photo(sql, ids.p4, 'full', 5, { badSha: true });
      await photo(sql, ids.p5, 'full', 6, { copied: true });
      await photo(sql, ids.p6, 'full', 7);
    });
    const s = await scriptBackup.copyPhotosOnce(sqlA as never, scriptBackup.directoryPhotos(dirA));
    const t = await copyPhotos(ctx, twinFolder.directoryPhotos(dirB));
    expect(strip(t)).toEqual(strip(s));
    expect(s.copied).toBe(4);
    expect(s.failed).toEqual([{ id: ids.p4, kind: 'full', error: 'the stored bytes do not match the recorded sha256 and size' }]);
    expect(t.stopped).toBe(false);
    expect(await copies(sqlB)).toEqual(await copies(sqlA));
    expect((await copies(sqlA)).map((r) => r.photo_id + r.kind)).toEqual([ids.p1 + 'full', ids.p1 + 'thumb', ids.p2 + 'full', ids.p5 + 'full', ids.p6 + 'full'].sort());
    expect(await files(dirB)).toEqual(await files(dirA));
    expect(Object.keys(await files(dirA))).toHaveLength(4); // p5 was already copied (its row exists): no file for it; p3 is removed; p4 failed

    const s2 = await scriptBackup.copyPhotosOnce(sqlA as never, scriptBackup.directoryPhotos(dirA));
    const t2 = await copyPhotos(ctx, twinFolder.directoryPhotos(dirB));
    expect(strip(t2)).toEqual(strip(s2));
    expect(s2.copied).toBe(0);
    expect(s2.failed).toHaveLength(1); // the damaged photo keeps failing, and keeps being reported
  });

  it('with a limit both take the first photos of the same order (oldest first; the damaged one counts)', async () => {
    await same(async (sql) => {
      await photo(sql, ids.p7, 'full', 10);
      await photo(sql, ids.p8, 'full', 11);
      await photo(sql, ids.p9, 'full', 12);
    });
    const s = await scriptBackup.copyPhotosOnce(sqlA as never, scriptBackup.directoryPhotos(dirA), { limit: 2 });
    const t = await copyPhotos(ctx, twinFolder.directoryPhotos(dirB), { limit: 2 });
    expect(strip(t)).toEqual(strip(s));
    expect(s.copied).toBe(1); // the damaged p4 is first in the list and fails; p7 is the second
    expect(t.more).toBe(true); // the list was cut by the limit: there may be more
    expect(await copies(sqlB)).toEqual(await copies(sqlA));
    const rest = await copyPhotos(ctx, twinFolder.directoryPhotos(dirB));
    expect(rest.copied).toBe(2);
    expect(rest.more).toBe(false);
  });

  it('a store that does not hold the object afterwards, or holds another size, is a failure with the same words, and no row is written', async () => {
    const id = '00000000-0000-4000-8000-0000000000a1';
    const lies = (head: (size: number) => { size: number } | null) => {
      const put = async () => undefined;
      let size = 0;
      return { put: async (_i: string, _k: string, b: Buffer) => { size = b.length; await put(); }, head: async () => head(size), get: async () => null };
    };
    for (const [label, head] of [['missing', () => null], ['bigger', (n: number) => ({ size: n + 1 })]] as const) {
      await same(async (sql) => photo(sql, `${id.slice(0, -1)}${label === 'missing' ? 'a' : 'b'}`, 'full', 20 + (label === 'missing' ? 0 : 1)));
      const idl = `${id.slice(0, -1)}${label === 'missing' ? 'a' : 'b'}`;
      const [beforeA, beforeB] = [(await copies(sqlA)).length, (await copies(sqlB)).length];
      const s = await scriptBackup.copyPhotosOnce(sqlA as never, lies(head) as never, { limit: 100 });
      const t = await copyPhotos(ctx, lies(head) as never, { limit: 100 });
      const mine = (r: { failed: { id: string; error: string }[] }) => r.failed.filter((f) => f.id === idl);
      expect(mine(t), label).toEqual(mine(s));
      expect(mine(s)).toHaveLength(1);
      expect((await copies(sqlA)).length, label).toBe(beforeA); // nothing was recorded for the lying store
      expect((await copies(sqlB)).length, label).toBe(beforeB);
    }
  });

  it('shouldStop is asked BEFORE each photo: it stops the slice cleanly, with the photos done so far recorded (the twin\'s own seam, for the 25 seconds)', async () => {
    const c = await scratchDatabase('twinsc', { schema: true });
    const sqlC = await c.connect();
    const poolC = createDbPool(c.db);
    const dir = await mkdtemp(path.join(tmpdir(), 'jv-twin-stop-'));
    const ctxC = () => txContext(poolC, { requestId: randomUUID(), actor: { id: null, role: 'job' } });
    try {
      for (let i = 0; i < 4; i++) await photo(sqlC, `00000000-0000-4000-8000-0000000000c${i}`, 'full', 30 + i);
      let asked = 0;
      const r = await copyPhotos(ctxC, twinFolder.directoryPhotos(dir), { shouldStop: () => ++asked > 2 });
      expect(r).toMatchObject({ copied: 2, stopped: true });
      expect(asked).toBe(3); // 1: before the first photo, 2: before the second, 3: before the third, which says stop
      expect((await copies(sqlC)).map((x) => x.photo_id)).toEqual(['00000000-0000-4000-8000-0000000000c0', '00000000-0000-4000-8000-0000000000c1']);
      expect(Object.keys(await files(dir))).toHaveLength(2);
      const rest = await copyPhotos(ctxC, twinFolder.directoryPhotos(dir)); // the next slice goes on where this one stopped
      expect(rest).toMatchObject({ copied: 2, stopped: false });
      expect(Object.keys(await files(dir))).toHaveLength(4);
    } finally {
      await poolC.end();
      await sqlC.end();
      await c.drop();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
