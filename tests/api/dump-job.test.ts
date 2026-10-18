import { generateKeyPairSync } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { copyPhotosOnce, directoryPhotos } from '../../scripts/backup.mjs';
import { folderStats, recordBackupRun } from '../../scripts/backup-folder.mjs';
import { BACKUP_FOLDER_BUDGET_BYTES } from '../../scripts/dump-job.mjs';
import { unpackExport } from '../../scripts/export-file.mjs';
import { readHealth } from '../../scripts/health.mjs';
import { createPacer } from '../../scripts/pacing.mjs';
import {
  type DumpWorld, addDays, asJson, backupRuns, cleanUp, dump, dumpWorld, errorRows, jobRuns, logCapture, night, nightAt, names, plant, rows, sha256Hex, stampOf, tempDir,
} from './dump-support';

// T-R03 (B2, I12, D17, D25), the job half: `scripts/job.js dump` through its library (scripts/dump-job.mjs) with the clock in the test's hands. The folder is a temporary folder, the key pair is made
// by `npm run keygen` (scripts/keygen.mjs) at run time, the database is a scratch database of the lane with the real schema, the seeds and the audit triggers. The functions of the database half
// (writeDailyExport, exportDatabase, prune, recordBackupRun) are tested by tests/schema; what is proved here is that the JOB uses them in the order B2 gives and records what the dashboard reads.

afterAll(cleanUp);

const DATE = '2026-11-02';

describe('T-R03 the nightly dump is one encrypted snapshot of the shop, counted and recorded', () => {
  it('decrypts with the private key (unpackExport) and its row counts equal the manifest, the shop and the run record; there are no photo bytes in it', async () => {
    const world = await dumpWorld();
    const before = await world.counts();
    const res = await dump(world, night(DATE));
    expect(res).toMatchObject({ status: 'done', exitCode: 0, date: DATE });

    const file = path.join(world.folder, `daily/${DATE}.enc`);
    const out = tempDir('jv dump out ');
    await unpackExport(file, world.keys.privatePem, out);
    const manifest = JSON.parse(readFileSync(path.join(out, 'manifest.json'), 'utf8'));
    expect(manifest.format).toBe('jewelvault-export-1');
    expect(manifest.tables.length).toBeGreaterThan(20);
    for (const t of manifest.tables as { name: string; rows: number; file: string }[]) {
      const lines = readFileSync(path.join(out, t.file), 'utf8').split('\n').filter(Boolean).length;
      expect(lines, `${t.name}: lines in the file`).toBe(t.rows);
      // the job's own claim (sys_job_runs, `running`) is in the snapshot; its pending record and ok row (backup_runs) are written after it
      const expected = t.name === 'sys_job_runs' ? 1 : t.name === 'backup_runs' ? 0 : t.name === 'sys_idempotency' ? undefined : before[t.name];
      if (expected !== undefined) expect(t.rows, `${t.name}: rows in the manifest`).toBe(expected);
    }
    expect(manifest.tables.find((t: { name: string }) => t.name === 'customers').rows).toBeGreaterThanOrEqual(3);

    // the record says the same as the manifest
    const ok = (await backupRuns(world, 'db_dump')).filter((r) => r.ok === 1);
    expect(ok).toHaveLength(1);
    const counts = Object.fromEntries((manifest.tables as { name: string; rows: number }[]).map((t) => [t.name, t.rows]));
    expect(asJson(ok[0].detail).counts).toEqual(counts);

    // no photo bytes: the photo copy carries them, and the live photos are counted
    const photoRows = readFileSync(path.join(out, 'data/design_photos.ndjson'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    expect(photoRows).toHaveLength(world.photos.length);
    for (const r of photoRows) expect(Object.keys(r)).not.toContain('bytes');
    expect(manifest.live_photos).toBe(world.photos.length);
    // customer data is not readable in the file on the folder
    const raw = readFileSync(file);
    expect(raw.includes(Buffer.from('Gold Palace'))).toBe(false);
    expect(raw.subarray(0, 4).toString()).toBe('JVE1');
    // and a stranger's key cannot open it
    const stranger = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
    await expect(unpackExport(file, stranger.privateKey, tempDir('jv dump bad '))).rejects.toThrow(/cannot unpack/);
  }, 180_000);

  it('records the run: detail.export = {name, sha256, size} (first as a pending row BEFORE the link), detail.folder = {files, bytes, free_bytes}, ok only for the complete phase', async () => {
    const world = await dumpWorld();
    const res = await dump(world, night(DATE));
    expect(res.status).toBe('done');
    const file = path.join(world.folder, `daily/${DATE}.enc`);
    const onDisk = readFileSync(file);
    const exportInfo = { name: `daily/${DATE}.enc`, sha256: sha256Hex(onDisk), size: onDisk.length };

    const runs = await backupRuns(world, 'db_dump');
    expect(runs.map((r) => r.ok)).toEqual([0, 1]); // the pending record, then the ok row
    const [pending, ok] = runs;
    expect(asJson(pending.detail)).toMatchObject({ phase: 'linking', export: exportInfo });
    expect(asJson(ok.detail).export).toEqual(exportInfo);
    expect(Number(ok.bytes)).toBe(onDisk.length);
    expect(ok.ran_at).toBe(stampOf(night(DATE))); // the row carries the job's clock

    // the folder figures: a daily file and the monthly hard link; the free-disk figure is the budget less what the folder holds, NOT statfs (which shows the server's whole volume)
    const stats = await folderStats(world.folder);
    const folder = asJson(ok.detail).folder;
    expect(folder).toMatchObject({ files: 2, bytes: stats.bytes });
    expect(folder.budget_bytes).toBe(BACKUP_FOLDER_BUDGET_BYTES);
    expect(folder.free_bytes).toBe(BACKUP_FOLDER_BUDGET_BYTES - stats.bytes);
    expect(folder.free_bytes).not.toBe(stats.free_bytes);

    // the day's row in sys_job_runs is ok, with the same export
    const job = await jobRuns(world);
    expect(job).toHaveLength(1);
    expect(job[0]).toMatchObject({ run_date: DATE, status: 'ok' });
    expect(asJson(job[0].detail).export).toEqual(exportInfo);
    expect(job[0].finished_at).not.toBeNull();
  }, 180_000);

  it('the first run of a month also puts the file in monthly/<yyyy-mm>.enc (one inode, no second copy); the next night does not; the first night of December does', async () => {
    const world = await dumpWorld();
    await dump(world, night('2026-11-30'));
    await dump(world, night('2026-12-01'));
    await dump(world, night('2026-12-02'));
    expect(names(world.folder, 'daily')).toEqual(['2026-11-30.enc', '2026-12-01.enc', '2026-12-02.enc']);
    expect(names(world.folder, 'monthly')).toEqual(['2026-11.enc', '2026-12.enc']);
    const a = statSync(path.join(world.folder, 'daily/2026-11-30.enc'));
    const b = statSync(path.join(world.folder, 'monthly/2026-11.enc'));
    expect(b.ino).toBe(a.ino);
    expect(a.nlink).toBe(2);
    expect(statSync(path.join(world.folder, 'daily/2026-12-02.enc')).nlink).toBe(1);
  }, 180_000);
});

describe('T-R03 what is due: not before 02:00 Asia/Kolkata, once a business date, one run at a time', () => {
  it('before 02:00 nothing is done and nothing is written (no lock row, no file); from 02:00 it runs', async () => {
    const world = await dumpWorld();
    const early = await dump(world, nightAt(DATE, '01:59'));
    expect(early).toMatchObject({ status: 'not_due', exitCode: 0 });
    expect(await jobRuns(world)).toHaveLength(0);
    expect(await backupRuns(world)).toHaveLength(0);
    expect(names(world.folder, 'daily')).toEqual([]);
    const gate = await dump(world, nightAt(DATE, '02:00'));
    expect(gate.status).toBe('done');
    expect(names(world.folder, 'daily')).toEqual([`${DATE}.enc`]);
  }, 180_000);

  it('the business date is the Asia/Kolkata one: 20:29 UTC is 01:59 of the next date (not due), 20:30 UTC is 02:00 (due, for that next date)', async () => {
    const world = await dumpWorld();
    expect((await dump(world, Date.parse('2026-11-02T20:29:00Z'))).status).toBe('not_due');
    const res = await dump(world, Date.parse('2026-11-02T20:30:00Z'));
    expect(res).toMatchObject({ status: 'done', date: '2026-11-03' });
  }, 180_000);

  it('a second call the same day ends at once: today\'s db_dump is ok in sys_job_runs, so there is no new file, no new row and no export', async () => {
    const world = await dumpWorld();
    await dump(world, night(DATE));
    const files = names(world.folder, 'daily');
    const runsBefore = (await backupRuns(world)).length;
    const again = await dump(world, nightAt(DATE, '09:00'));
    expect(again).toMatchObject({ status: 'already_done', exitCode: 0 });
    expect(names(world.folder, 'daily')).toEqual(files);
    expect(await backupRuns(world)).toHaveLength(runsBefore);
    expect(await jobRuns(world)).toHaveLength(1);
    // the next business date is due again
    expect((await dump(world, night(addDays(DATE, 1)))).status).toBe('done');
    expect(await jobRuns(world)).toHaveLength(2);
  }, 180_000);

  it('a failed run is retried on the SAME sys_job_runs row (failed goes back to running, then ok), and every failure is a visible ok=0 row and an error-log row', async () => {
    const world = await dumpWorld();
    const failed = await dump(world, night(DATE), {
      exportOptions: {
        between: async (table: string) => {
          if (table === 'bill_items') throw new Error('the connection to the server was lost');
        },
      },
    });
    expect(failed).toMatchObject({ status: 'failed', exitCode: 1 });
    let job = await jobRuns(world);
    expect(job).toHaveLength(1);
    expect(job[0].status).toBe('failed');
    const failedId = job[0].id;
    const bad = (await backupRuns(world, 'db_dump')).filter((r) => r.ok === 0);
    expect(bad).toHaveLength(1);
    expect(asJson(bad[0].detail).error.message).toMatch(/connection to the server was lost/);
    expect((await errorRows(world, 'JV_BACKUP_FAILED')).length).toBe(1);

    const retry = await dump(world, nightAt(DATE, '04:00'));
    expect(retry.status).toBe('done');
    job = await jobRuns(world);
    expect(job).toHaveLength(1);
    expect(job[0]).toMatchObject({ id: failedId, status: 'ok' });
  }, 180_000);

  it('a running row younger than 30 minutes is left alone (somebody may be dumping); one older than 30 minutes is abandoned and taken over (I8: the dump\'s 30)', async () => {
    const world = await dumpWorld();
    const started = night(DATE);
    await world.conn.query("INSERT INTO sys_job_runs (job, run_date, status, started_at) VALUES ('db_dump', ?, 'running', ?)", [DATE, stampOf(started)]);
    const young = await dump(world, started + 29 * 60_000);
    expect(young).toMatchObject({ status: 'running_elsewhere', exitCode: 0 });
    expect(names(world.folder, 'daily')).toEqual([]);
    const old = await dump(world, started + 31 * 60_000);
    expect(old.status).toBe('done');
    const job = await jobRuns(world);
    expect(job).toHaveLength(1);
    expect(job[0].status).toBe('ok');
  }, 180_000);

  it('takes GET_LOCK(jv_dump:<database>, 0): a dump that finds it taken ends at once with nothing written; the lock is free again after a run and after a failed one', async () => {
    const world = await dumpWorld();
    const lock = `jv_dump:${world.scratch.db.name}`;
    const other = await world.scratch.connect();
    try {
      expect((await other.query<any[]>('SELECT GET_LOCK(?, 0) AS got', [lock]))[0][0].got).toBe(1);
      const res = await dump(world, night(DATE));
      expect(res).toMatchObject({ status: 'locked', exitCode: 0 });
      expect(await jobRuns(world)).toHaveLength(0);
      expect(names(world.folder, 'daily')).toEqual([]);
      await other.query('SELECT RELEASE_LOCK(?)', [lock]);
      const failed = await dump(world, night(DATE), { exportOptions: { between: () => { throw new Error('boom'); } } });
      expect(failed.status).toBe('failed');
      expect((await other.query<any[]>('SELECT IS_FREE_LOCK(?) AS free', [lock]))[0][0].free).toBe(1);
      const good = await dump(world, nightAt(DATE, '05:00'));
      expect(good.status).toBe('done');
      expect((await other.query<any[]>('SELECT IS_FREE_LOCK(?) AS free', [lock]))[0][0].free).toBe(1);
    } finally {
      await other.end();
    }
  }, 180_000);

  it('two dumps started together run once: while the first holds the snapshot the second finds the lock, and there is one file and one ok row', async () => {
    const world = await dumpWorld();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let reached!: () => void;
    const paused = new Promise<void>((r) => (reached = r));
    const first = dump(world, night(DATE), {
      exportOptions: {
        between: async (table: string) => {
          if (table === 'audit_log' || table === 'bill_items') {
            reached();
            await gate;
          }
        },
      },
    });
    await paused;
    const second = await dump(world, night(DATE));
    expect(second).toMatchObject({ status: 'locked', exitCode: 0 });
    release();
    expect((await first).status).toBe('done');
    expect(names(world.folder, 'daily')).toEqual([`${DATE}.enc`]);
    expect((await backupRuns(world, 'db_dump')).filter((r) => r.ok === 1)).toHaveLength(1);
    expect(await jobRuns(world)).toHaveLength(1);
  }, 180_000);

  it('its session is its own: ONE connection opened through the pacer, wait_timeout 300 and max_statement_time 20 (I8, S11), the isolation of the export is set by exportDatabase', async () => {
    const world = await dumpWorld();
    const sql: string[] = [];
    let opened = 0;
    let waited = 0;
    const inner = createPacer({ max: 10_000 });
    const pacer = { ...inner, wait: async () => { waited += 1; await inner.wait(); } };
    const { default: mysql } = await import('mysql2/promise');
    await dump(world, night(DATE), {
      pacer,
      connect: async (settings: any) => {
        opened += 1;
        const conn: any = await mysql.createConnection(settings);
        const query = conn.query.bind(conn);
        conn.query = (s: any, ...rest: any[]) => {
          sql.push(typeof s === 'string' ? s : s.sql);
          return query(s, ...rest);
        };
        return conn;
      },
    });
    expect(opened).toBe(1);
    expect(waited).toBe(1);
    const set = sql.find((s) => /^SET SESSION/.test(s) && /wait_timeout/.test(s));
    expect(set).toBeDefined();
    expect(set).toMatch(/wait_timeout = 300/);
    expect(set).toMatch(/max_statement_time = 20/);
    expect(set).toMatch(/STRICT_ALL_TABLES/);
    expect(sql).toContain('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    expect(sql.filter((s) => /^START TRANSACTION READ ONLY, WITH CONSISTENT SNAPSHOT/.test(s))).toHaveLength(1); // one snapshot, never sliced
  }, 180_000);
});

// ---------------------------------------------------------------------------------------------------------------- the photo copy (the tick's phase, API33b)

describe('T-R03 the photo copy: each photo once, a second run copies nothing and records an ok "nothing new" run, a size mismatch on the stat check is not recorded', () => {
  // The phase itself is API33b's (a TypeScript twin in the tick); what is proved here are the clauses of T-R03 on the writer it calls: directoryPhotos over JV_BACKUP_DIR/photos, compared by size
  // and sha256, never overwritten, recorded in sys_photo_copies only after a stat of the file in the folder.
  const photoPhase = async (world: DumpWorld, nowMs: number, store = directoryPhotos(path.join(world.folder, 'photos'))) => {
    const r = await copyPhotosOnce(world.conn, store);
    const ok = r.failed.length === 0;
    await recordBackupRun(world.conn, { kind: 'photo_copy', ok, bytes: r.bytes, ranAt: stampOf(nowMs), detail: { copied: r.copied, nothing_new: ok && r.copied === 0, failed: r.failed.length, folder: await folderStats(world.folder) } });
    return r;
  };

  it('copies every photo object once; the second run copies nothing and records an ok run that says nothing was new; the files are in photos/ and never overwritten', async () => {
    const world = await dumpWorld();
    const first = await photoPhase(world, night(DATE));
    expect(first).toMatchObject({ copied: world.photos.length, failed: [] });
    expect(names(world.folder, 'photos')).toEqual(world.photos.map((p) => `${p.id}-${p.kind}`).sort());
    for (const p of world.photos) expect(sha256Hex(readFileSync(path.join(world.folder, `photos/${p.id}-${p.kind}`)))).toBe(p.sha);
    expect(Number((await rows(world, 'SELECT COUNT(*) AS n FROM sys_photo_copies'))[0].n)).toBe(world.photos.length);
    const second = await photoPhase(world, night(addDays(DATE, 1)));
    expect(second).toMatchObject({ copied: 0, failed: [] });
    const runs = await backupRuns(world, 'photo_copy');
    expect(runs.map((r) => r.ok)).toEqual([1, 1]);
    expect(asJson(runs[1].detail)).toMatchObject({ copied: 0, nothing_new: true });
    // a name that exists with other bytes is refused and never overwritten
    const store = directoryPhotos(path.join(world.folder, 'photos'));
    const p = world.photos[0];
    await expect(store.put(p.id, p.kind, Buffer.from('other bytes'))).rejects.toThrow(/already exists with different content/);
    expect(sha256Hex(readFileSync(path.join(world.folder, `photos/${p.id}-${p.kind}`)))).toBe(p.sha);
  }, 180_000);

  it('a size mismatch on the stat check is not recorded in sys_photo_copies (and the run is not ok); the next run copies it', async () => {
    const world = await dumpWorld();
    const real = directoryPhotos(path.join(world.folder, 'photos'));
    const wrong = { ...real, head: async (id: string, kind: string) => (await real.head(id, kind)) && { size: 7 } };
    const r = await photoPhase(world, night(DATE), wrong as any);
    expect(r.copied).toBe(0);
    expect(r.failed).toHaveLength(world.photos.length);
    expect(r.failed[0].error).toMatch(/size mismatch/);
    expect(Number((await rows(world, 'SELECT COUNT(*) AS n FROM sys_photo_copies'))[0].n)).toBe(0);
    expect((await backupRuns(world, 'photo_copy')).map((x) => x.ok)).toEqual([0]);
    const next = await photoPhase(world, night(addDays(DATE, 1)));
    expect(next.copied).toBe(world.photos.length);
    expect((await backupRuns(world, 'photo_copy')).map((x) => x.ok)).toEqual([0, 1]);
  }, 180_000);
});

// ---------------------------------------------------------------------------------------------------------------- pruning

const DAILY_OLD = (i: number) => `daily/${addDays('2025-01-01', i)}.enc`;
const MONTHLY_OLD = (i: number) => `monthly/${new Date(Date.UTC(2025, i, 1)).toISOString().slice(0, 7)}.enc`;
const failingExport = { between: () => { throw new Error('the database went away'); } };

describe('T-R03 pruning is the last step of a good night, with the guard rails of B2', () => {
  it('after 40 failed nights nothing is deleted from daily/ or monthly/: the newest 30 and 13 files stay, whatever their age', async () => {
    const world = await dumpWorld();
    const start = night('2026-11-01');
    for (let i = 0; i < 45; i++) plant(world.folder, DAILY_OLD(i), 'x', 600 * 86_400_000, start);
    for (let i = 0; i < 15; i++) plant(world.folder, MONTHLY_OLD(i), 'x', 600 * 86_400_000, start);
    // the last good run recorded 60 files, and a dry run was logged long ago: the next real prune is allowed to delete
    await recordBackupRun(world.conn, { kind: 'db_dump', ok: true, ranAt: stampOf(start - 86_400_000), detail: { folder: { files: 60, bytes: 60 }, prune_dry_run: { names: [DAILY_OLD(0)] } } });
    for (let n = 0; n < 40; n++) {
      const res = await dump(world, night(addDays('2026-11-01', n)), { exportOptions: failingExport });
      expect(res.status, `night ${n}`).toBe('failed');
    }
    expect(names(world.folder, 'daily')).toHaveLength(45);
    expect(names(world.folder, 'monthly')).toHaveLength(15);
    expect((await backupRuns(world, 'db_dump')).filter((r) => r.ok === 0)).toHaveLength(40);
    // the first good night after them: the pruning may now act, and it keeps exactly the newest 30 and 13 (the planted files are all older than a year)
    const good = await dump(world, night('2026-12-20'));
    expect(good.status).toBe('done');
    const daily = names(world.folder, 'daily');
    const monthly = names(world.folder, 'monthly');
    expect(daily).toHaveLength(30);
    expect(monthly).toHaveLength(13);
    expect(daily).toContain('2026-12-20.enc');
    expect(daily).not.toContain(path.basename(DAILY_OLD(0)));
    expect(daily).toContain(path.basename(DAILY_OLD(44))); // the newest of the old ones is still there
    expect(monthly).toContain('2026-12.enc');
  }, 300_000);

  it('after a good night the 31st daily file goes, but only after a logged dry run: the first night logs the candidates and deletes nothing, the next one deletes', async () => {
    const world = await dumpWorld();
    const first = night('2026-11-01');
    for (let i = 0; i < 30; i++) plant(world.folder, `daily/${addDays('2026-10-02', i)}.enc`, 'x', 20 * 86_400_000, first); // 2026-10-02 .. 2026-10-31
    await recordBackupRun(world.conn, { kind: 'db_dump', ok: true, ranAt: stampOf(first - 86_400_000), detail: { folder: { files: 30, bytes: 30 } } });

    const one = await dump(world, first); // daily is now 31 files
    expect(one).toMatchObject({ status: 'done' });
    expect(names(world.folder, 'daily')).toHaveLength(31); // the dry run deleted nothing
    const okOne = (await backupRuns(world, 'db_dump')).filter((r) => r.ok === 1).at(-1)!;
    expect(asJson(okOne.detail).prune_dry_run).toEqual({ names: ['daily/2026-10-02.enc'] });
    expect(asJson(okOne.detail).pruned).toBeUndefined();

    const two = await dump(world, night('2026-11-02'));
    expect(two.status).toBe('done');
    const daily = names(world.folder, 'daily');
    expect(daily).toHaveLength(30);
    expect(daily).not.toContain('2026-10-02.enc'); // the 31st
    expect(daily).not.toContain('2026-10-03.enc'); // and the 32nd, which the second night's file made
    expect(daily).toContain('2026-11-02.enc');
    const okTwo = (await backupRuns(world, 'db_dump')).filter((r) => r.ok === 1).at(-1)!;
    expect(asJson(okTwo.detail).pruned).toBe(2);
    // the row records the folder AFTER the prune, so the dashboard does not read the removal as a loss
    expect(asJson(okTwo.detail).folder.files).toBe((await folderStats(world.folder)).files);
    const health = await readHealth(world.conn, { now: stampOf(night('2026-11-02') + 3_600_000), sizeBytes: 1 });
    expect(health.reasons).not.toContain('backup_files_fell');
  }, 300_000);

  it('refuses a folder with fewer files than the last recorded count: nothing is deleted, an alert is raised, the night itself is still ok', async () => {
    const world = await dumpWorld();
    const start = night('2026-11-01');
    for (let i = 0; i < 33; i++) plant(world.folder, `daily/${addDays('2026-09-20', i)}.enc`, 'x', 30 * 86_400_000, start); // 33 daily files: a prune would remove 4
    await recordBackupRun(world.conn, { kind: 'db_dump', ok: true, ranAt: stampOf(start - 86_400_000), detail: { folder: { files: 100, bytes: 100 }, prune_dry_run: { names: [] } } });
    const res = await dump(world, start);
    expect(res.status).toBe('done');
    expect(names(world.folder, 'daily')).toHaveLength(34); // 33 + tonight's: nothing removed
    const alerts = await errorRows(world, 'JV_BACKUP_ALERT');
    expect(alerts).toHaveLength(1);
    expect(asJson(alerts[0].detail)).toMatchObject({ alert: 'prune_refused', reason: 'fewer_files_than_recorded', recorded: 100 });
    const ok = (await backupRuns(world, 'db_dump')).filter((r) => r.ok === 1).at(-1)!;
    expect(asJson(ok.detail).prune_refused).toMatchObject({ reason: 'fewer_files_than_recorded' });
    // the same folder with a record that it holds (30 files) is pruned: the refusal was the count, not something else
    const control = await dumpWorld();
    for (let i = 0; i < 33; i++) plant(control.folder, `daily/${addDays('2026-09-20', i)}.enc`, 'x', 30 * 86_400_000, start);
    await recordBackupRun(control.conn, { kind: 'db_dump', ok: true, ranAt: stampOf(start - 86_400_000), detail: { folder: { files: 30, bytes: 30 }, prune_dry_run: { names: [] } } });
    await dump(control, start);
    expect(names(control.folder, 'daily')).toHaveLength(30);
  }, 300_000);

  it('the dashboard goes red when the file count falls without a prune (someone deleted files), and not when the job pruned', async () => {
    const world = await dumpWorld();
    await dump(world, night('2026-11-02'));
    await dump(world, night('2026-11-03'));
    const calm = await readHealth(world.conn, { now: stampOf(night('2026-11-03') + 3_600_000), sizeBytes: 1 });
    expect(calm.reasons).not.toContain('backup_files_fell');
    // an attacker, a mistake in hPanel: two daily files are gone
    unlinkSync(path.join(world.folder, 'daily/2026-11-02.enc'));
    unlinkSync(path.join(world.folder, 'daily/2026-11-03.enc'));
    await dump(world, night('2026-11-04'));
    const red = await readHealth(world.conn, { now: stampOf(night('2026-11-04') + 3_600_000), sizeBytes: 1 });
    expect(red.level).toBe('red');
    expect(red.reasons).toContain('backup_files_fell');
    expect(red.folder?.fell).toBe(true);
  }, 300_000);
});

// ---------------------------------------------------------------------------------------------------------------- retry, crash, partial files

describe('T-R03 a night that was cut or crashed is repaired on the retry, and nothing is ever overwritten', () => {
  const crash = () => {
    throw new CrashForTest();
  };
  class CrashForTest extends Error {}

  it('a crash between the linking and the ok row is repaired on the retry: the recorded sha256 matches, the phase is ok, nothing is dumped again', async () => {
    const world = await dumpWorld();
    const lost = await dump(world, night(DATE), { afterLink: crash });
    expect(lost.status).toBe('failed'); // the process "died": the test sees it as a throw out of the job
    expect(names(world.folder, 'daily')).toEqual([`${DATE}.enc`]); // linked
    expect((await backupRuns(world, 'db_dump')).map((r) => r.ok)).toEqual([0]); // only the pending record is there: no ok row, no failure row either
    expect((await jobRuns(world))[0].status).toBe('running');
    const digest = sha256Hex(readFileSync(path.join(world.folder, `daily/${DATE}.enc`)));

    const retry = await dump(world, nightAt(DATE, '04:00')); // the next hourly run: the row is older than 30 minutes
    expect(retry).toMatchObject({ status: 'done', written: 'already_done' });
    expect(names(world.folder, 'daily')).toEqual([`${DATE}.enc`]); // no second file
    expect(sha256Hex(readFileSync(path.join(world.folder, `daily/${DATE}.enc`)))).toBe(digest);
    const ok = (await backupRuns(world, 'db_dump')).filter((r) => r.ok === 1);
    expect(ok).toHaveLength(1);
    expect(asJson(ok[0].detail).export.sha256).toBe(digest);
    expect(asJson(ok[0].detail).counts).toBeTruthy(); // the counts come from the pending record: the snapshot is not repeated
    expect((await jobRuns(world))[0].status).toBe('ok');
    // and the file still opens with the key
    await unpackExport(path.join(world.folder, `daily/${DATE}.enc`), world.keys.privatePem, tempDir('jv dump out '));
  }, 180_000);

  it('when the final file is not the one that was recorded, it is left alone, an alert is raised and this run writes daily/<date>-<run id>.enc', async () => {
    const world = await dumpWorld();
    await dump(world, night(DATE), { afterLink: crash });
    const plain = path.join(world.folder, `daily/${DATE}.enc`);
    const tampered = Buffer.concat([readFileSync(plain), Buffer.from('x')]);
    chmodSync(plain, 0o644);
    writeFileSync(plain, tampered); // writes through the hard link, so monthly/ changes as well: that is the damage the retry must not repair
    const retry = await dump(world, nightAt(DATE, '04:00'));
    expect(retry).toMatchObject({ status: 'done', written: 'written' });
    const daily = names(world.folder, 'daily');
    expect(daily).toHaveLength(2);
    const own = daily.find((n) => n !== `${DATE}.enc`)!;
    expect(own).toMatch(new RegExp(`^${DATE}-[0-9A-Za-z-]+\\.enc$`));
    expect(readFileSync(plain).equals(tampered)).toBe(true); // never overwritten
    await unpackExport(path.join(world.folder, 'daily', own), world.keys.privatePem, tempDir('jv dump out '));
    const ok = (await backupRuns(world, 'db_dump')).filter((r) => r.ok === 1);
    expect(asJson(ok[0].detail).export.name).toBe(`daily/${own}`);
    const alerts = (await errorRows(world, 'JV_BACKUP_ALERT')).map((r) => asJson(r.detail).alert).sort();
    expect(alerts).toEqual(['export_name_taken', 'export_record_mismatch']);
  }, 180_000);

  it('`.partial` files older than an hour are swept at the start of the job; a younger one stays', async () => {
    const world = await dumpWorld();
    const now = night(DATE);
    plant(world.folder, 'daily/2026-10-31.enc.partial', 'x', 2 * 3_600_000, now);
    plant(world.folder, 'photos/abc-full.1234.partial', 'x', 61 * 60_000, now);
    plant(world.folder, 'monthly/2026-10.enc.partial', 'x', 10 * 60_000, now);
    await dump(world, now);
    expect(names(world.folder, 'daily')).toEqual([`${DATE}.enc`]);
    expect(names(world.folder, 'photos')).toEqual([]);
    expect(names(world.folder, 'monthly')).toEqual(['2026-11.enc', '2026-10.enc.partial'].sort());
  }, 180_000);

  it('the dump cut halfway leaves no final file, no partial file and no ok row; the retry then writes it', async () => {
    const world = await dumpWorld();
    let tables = 0;
    const cut = await dump(world, night(DATE), {
      exportOptions: {
        between: () => {
          tables += 1;
          if (tables === 4) throw new Error('lost connection to the server during the export');
        },
      },
    });
    expect(cut).toMatchObject({ status: 'failed', exitCode: 1 });
    expect(tables).toBe(4);
    expect(readdirSync(path.join(world.folder, 'daily'))).toEqual([]);
    expect(existsSync(path.join(world.folder, 'monthly/2026-11.enc'))).toBe(false);
    expect((await backupRuns(world, 'db_dump')).filter((r) => r.ok === 1)).toHaveLength(0);
    expect((await jobRuns(world))[0].status).toBe('failed');
    const health = await readHealth(world.conn, { now: stampOf(night(DATE) + 3_600_000), sizeBytes: 1 });
    expect(health.reasons).toContain('dump_never');
    expect((await dump(world, nightAt(DATE, '04:00'))).status).toBe('done');
    expect(names(world.folder, 'daily')).toEqual([`${DATE}.enc`]);
  }, 180_000);
});

// ---------------------------------------------------------------------------------------------------------------- the dashboard

describe('T-R03 the dashboard (I12) goes red after 26 hours without a good export or a good photo copy', () => {
  it('green at 25 hours, red at 26 hours and a minute: for the export and, separately, for the photo copy', async () => {
    const world = await dumpWorld();
    const at0 = night(DATE);
    await dump(world, at0);
    const photos = directoryPhotos(path.join(world.folder, 'photos'));
    const r = await copyPhotosOnce(world.conn, photos);
    await recordBackupRun(world.conn, { kind: 'photo_copy', ok: r.failed.length === 0, bytes: r.bytes, ranAt: stampOf(at0 + 30 * 60_000), detail: { copied: r.copied, folder: await folderStats(world.folder) } });
    const hours = (h: number, extraMin = 0) => stampOf(at0 + h * 3_600_000 + extraMin * 60_000);
    const fresh = await readHealth(world.conn, { now: hours(25), sizeBytes: 1 });
    expect(fresh.reasons).not.toContain('dump_stale');
    expect(fresh.reasons).not.toContain('photo_copy_stale');
    // 26 h 1 min after the export, the photo copy (30 minutes younger) is still inside its 26 hours
    const exportOnly = await readHealth(world.conn, { now: hours(26, 1), sizeBytes: 1 });
    expect(exportOnly.reasons).toContain('dump_stale');
    expect(exportOnly.reasons).not.toContain('photo_copy_stale');
    expect(exportOnly.level).toBe('red');
    const both = await readHealth(world.conn, { now: hours(26, 40), sizeBytes: 1 });
    expect(both.reasons).toEqual(expect.arrayContaining(['dump_stale', 'photo_copy_stale']));
    // a failed night is no good export: only an ok row counts
    await dump(world, night(addDays(DATE, 1)), { exportOptions: failingExport });
    const afterFailure = await readHealth(world.conn, { now: stampOf(night(addDays(DATE, 1)) + 3_600_000), sizeBytes: 1 });
    expect(afterFailure.db_dump.last_at).toMatch(/^2026-11-0[12]/);
    expect(afterFailure.db_dump.age_hours).toBeGreaterThan(24);
    // and a good night after it makes the line fresh again
    await dump(world, nightAt(addDays(DATE, 1), '05:00'));
    const healed = await readHealth(world.conn, { now: stampOf(nightAt(addDays(DATE, 1), '05:00') + 3_600_000), sizeBytes: 1 });
    expect(healed.reasons).not.toContain('dump_stale');
  }, 300_000);
});

// ---------------------------------------------------------------------------------------------------------------- the folder (spec 5.2.2: B2, I12)

describe('T-R03 JV_BACKUP_DIR must exist and be writable on every hourly run (spec 5.2.2, B2, I12)', () => {
  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  const probeRows = async (world: DumpWorld) => (await backupRuns(world, 'db_dump')).filter((r) => asJson(r.detail)?.folder_probe);

  it('a MISSING folder (ENOENT) is not "nothing due": it is not created, nothing is dumped, the run fails (exit 1), logError writes JV_BACKUP_FOLDER and a backup_runs row says folder_probe.ok = false', async () => {
    const world = await dumpWorld({ folderExists: false });
    const log = logCapture();
    const res = await dump(world, night(DATE), { log });
    expect(res).toMatchObject({ status: 'folder_unusable', exitCode: 1, probe: { ok: false, code: 'ENOENT' } });
    expect(existsSync(world.env.JV_BACKUP_DIR)).toBe(false); // the folder is never made for the job: a stale absolute path must not grow a new tree under domains/
    expect(await jobRuns(world)).toHaveLength(0);
    const marks = await probeRows(world);
    expect(marks).toHaveLength(1);
    expect(marks[0]).toMatchObject({ kind: 'db_dump', ok: 0 });
    expect(asJson(marks[0].detail).folder_probe).toMatchObject({ ok: false, code: 'ENOENT', where: 'folder' });
    const errors = await errorRows(world, 'JV_BACKUP_FOLDER');
    expect(errors).toHaveLength(1);
    expect(errors[0].level).toBe('error');
    expect(asJson(errors[0].detail)).toMatchObject({ code: 'ENOENT', where: 'folder' });
    expect(log.lines.join('\n')).toMatch(/ENOENT/);
    // the owner's line cannot be red for this yet (readHealth reads no such field: the open point for the database session), but the old rule still catches it: no good export
    const health = await readHealth(world.conn, { now: stampOf(night(DATE) + 27 * 3_600_000), sizeBytes: 1 });
    expect(health.reasons).toContain('dump_never');
  }, 180_000);

  it('it is tested on EVERY run, also before 02:00 and also when today\'s dump is already ok; the same failure is written once a day, not once an hour', async () => {
    const world = await dumpWorld();
    expect((await dump(world, night(DATE))).status).toBe('done');
    const { rmSync } = await import('node:fs');
    rmSync(world.folder, { recursive: true, force: true }); // the folder is gone after the night's dump
    const sameDay = await dump(world, nightAt(DATE, '09:00')); // today's db_dump is ok: this would end at once as "already done"
    expect(sameDay).toMatchObject({ status: 'folder_unusable', exitCode: 1 });
    const early = await dump(world, nightAt(addDays(DATE, 1), '01:00')); // and before 02:00 it would be "not due"
    expect(early).toMatchObject({ status: 'folder_unusable', exitCode: 1 });
    expect(await probeRows(world)).toHaveLength(1); // the second run within a day adds no row...
    expect(await errorRows(world, 'JV_BACKUP_FOLDER')).toHaveLength(1);
    const nextDay = await dump(world, nightAt(addDays(DATE, 2), '01:00')); // ...a day later it does
    expect(nextDay.status).toBe('folder_unusable');
    expect(await probeRows(world)).toHaveLength(2);
    expect(await errorRows(world, 'JV_BACKUP_FOLDER')).toHaveLength(2);
  }, 180_000);

  it.skipIf(isRoot)('a READ-ONLY folder (EACCES) is the same: nothing is dumped, JV_BACKUP_FOLDER and the row say EACCES; so is a read-only sub-folder', async () => {
    const world = await dumpWorld();
    chmodSync(world.folder, 0o555);
    try {
      const res = await dump(world, night(DATE));
      expect(res).toMatchObject({ status: 'folder_unusable', exitCode: 1, probe: { ok: false, code: 'EACCES' } });
      expect(names(world.folder, 'daily')).toEqual([]);
      expect(asJson((await probeRows(world))[0].detail).folder_probe).toMatchObject({ ok: false, code: 'EACCES' });
      expect(asJson((await errorRows(world, 'JV_BACKUP_FOLDER'))[0].detail)).toMatchObject({ code: 'EACCES' });
    } finally {
      chmodSync(world.folder, 0o755);
    }
    const dumpOnly = await dumpWorld();
    plant(dumpOnly.folder, 'daily/2026-10-01.enc', 'x', 0);
    chmodSync(path.join(dumpOnly.folder, 'daily'), 0o555);
    try {
      const res = await dump(dumpOnly, night(DATE));
      expect(res).toMatchObject({ status: 'folder_unusable', probe: { ok: false, code: 'EACCES', where: 'daily' } });
    } finally {
      chmodSync(path.join(dumpOnly.folder, 'daily'), 0o755);
    }
  }, 180_000);

  it('a path that is a file (ENOTDIR) and a value that is no absolute path (CONFIG) are folder problems too', async () => {
    const world = await dumpWorld();
    const file = plant(tempDir('jv dump file '), 'not-a-folder', 'x');
    const a = await dump(world, night(DATE), { env: { ...world.env, JV_BACKUP_DIR: file } });
    expect(a).toMatchObject({ status: 'folder_unusable', probe: { ok: false, code: 'ENOTDIR' } });
    const b = await dump(world, night(DATE), { env: { ...world.env, JV_BACKUP_DIR: 'jv-backup' } });
    expect(b).toMatchObject({ status: 'folder_unusable', probe: { ok: false, code: 'CONFIG' } });
    const c = await dump(world, night(DATE), { env: { ...world.env, JV_BACKUP_DIR: '~/jv-backup' } });
    expect(c).toMatchObject({ status: 'folder_unusable', probe: { ok: false, code: 'CONFIG' } });
    const d = await dump(world, night(DATE), { env: { ...world.env, JV_BACKUP_DIR: undefined } });
    expect(d).toMatchObject({ status: 'folder_unusable', probe: { ok: false, code: 'CONFIG' } });
  }, 180_000);

  it('once the folder is there again a heal row is written (folder_probe.ok = true, ok = 0) and the dump goes on; with today already ok the heal row still clears the signal', async () => {
    const world = await dumpWorld({ folderExists: false });
    await dump(world, night(DATE));
    const { mkdirSync } = await import('node:fs');
    mkdirSync(world.env.JV_BACKUP_DIR);
    const later = await dump(world, nightAt(DATE, '04:00'));
    expect(later.status).toBe('done');
    const marks = (await probeRows(world)).map((r) => asJson(r.detail).folder_probe.ok);
    expect(marks).toEqual([false, true]);
    // the order of the rows: failure, heal, pending record, ok row
    expect((await backupRuns(world, 'db_dump')).map((r) => `${r.ok}${asJson(r.detail).folder_probe ? 'p' : ''}`)).toEqual(['0p', '0p', '0', '1']);
  }, 180_000);

  it('with today\'s dump already ok, a folder that vanished and came back still gets its heal row, so the signal clears the same day', async () => {
    const world = await dumpWorld();
    expect((await dump(world, night(DATE))).status).toBe('done');
    const { mkdirSync, rmSync } = await import('node:fs');
    rmSync(world.folder, { recursive: true, force: true });
    expect((await dump(world, nightAt(DATE, '09:00'))).status).toBe('folder_unusable');
    mkdirSync(world.folder);
    const noon = await dump(world, nightAt(DATE, '12:00'));
    expect(noon.status).toBe('already_done');
    expect((await probeRows(world)).map((r) => asJson(r.detail).folder_probe.ok)).toEqual([false, true]);
  }, 180_000);
});

// ---------------------------------------------------------------------------------------------------------------- the settings

describe('T-R03 the settings of the job: a missing key or an unreadable one is a recorded failure; the environment is the only source', () => {
  it('BACKUP_PUBLIC_KEY missing or not a key: the run fails, is recorded, and nothing about the value is printed or stored', async () => {
    const world = await dumpWorld();
    const log = logCapture();
    const res = await dump(world, night(DATE), { env: { ...world.env, BACKUP_PUBLIC_KEY: 'definitely-not-a-key-0123456789' }, log });
    expect(res).toMatchObject({ status: 'failed', exitCode: 1 });
    const bad = (await backupRuns(world, 'db_dump')).filter((r) => r.ok === 0);
    expect(bad).toHaveLength(1);
    expect(JSON.stringify(bad[0].detail)).not.toContain('definitely-not-a-key');
    expect(log.lines.join('\n')).not.toContain('definitely-not-a-key');
    expect(names(world.folder, 'daily')).toEqual([]);
    const none = await dump(world, nightAt(DATE, '04:00'), { env: { ...world.env, BACKUP_PUBLIC_KEY: undefined } });
    expect(none).toMatchObject({ status: 'failed' });
  }, 180_000);

  it('the database settings are all required and are named, never their values, when one is missing: a usage error (exit 2), before anything is opened', async () => {
    const { runDumpJob, DumpUsageError } = await import('../../scripts/dump-job.mjs');
    const env = { DB_HOST: '203.0.113.9', DB_PORT: '3306', DB_NAME: 'shop_db_name', DB_USER: 'shop_user' };
    const caught = await runDumpJob({ env }).catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(DumpUsageError);
    expect((caught as Error).message).toMatch(/DB_PASSWORD/);
    for (const value of Object.values(env)) expect((caught as Error).message).not.toContain(value);
    expect((caught as { exitCode?: number }).exitCode).toBe(2);
  }, 60_000);
});
