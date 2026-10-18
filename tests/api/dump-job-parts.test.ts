import { chmodSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import type { Connection } from 'mysql2/promise';
import { afterAll, describe, expect, it } from 'vitest';
import { SUBFOLDERS, probeBackupDir as scriptProbe, probeBackupSetting as scriptSetting, resolveBackupDir as scriptResolve } from '../../scripts/backup-folder.mjs';
import { DUMP_ABANDONED_AFTER_MS, DUMP_SESSION, FOLDER_PROBE_REPEAT_MS, NIGHTLY_FROM_HOUR, afterNightlyGate as scriptGate, claimDumpRun, recordFolderProbe as scriptRecord } from '../../scripts/dump-job.mjs';
import { SESSION_SETTINGS } from '../../src/db/pool';
import { probeBackupDir as srcProbe, probeBackupSetting as srcSetting, recordFolderProbe as srcRecord, resolveBackupDir as srcResolve, FOLDER_PROBE_REPEAT_MS as srcRepeat } from '../../src/jobs/backupProbe';
import { JOB_LIMITS, afterNightlyGate as srcGate } from '../../src/jobs/schedule';
import { scratchDatabase } from '../helpers';
import { cleanUp, onCleanUp, plant, stampOf, tempDir } from './dump-support';

// T-R03 (API34): the pieces of the dump job that exist twice, because src/ is compiled alone and cannot import scripts/*.mjs (the folder probe, the 02:00 gate, the numbers of I8, the session of S11,
// the way a failed probe is recorded), and the rules of the claim of the dump's row in sys_job_runs. A change to one of a pair is a change to the other, and these tests say so.

afterAll(cleanUp);

const listNames = (d: string): string[] => (existsSync(d) ? readdirSync(d) : []);

const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

describe('T-R03 the numbers of I8 are in one place for the tick and the dump', () => {
  it('the gate is 02:00 Asia/Kolkata in both files, on the same instants', () => {
    expect(NIGHTLY_FROM_HOUR).toBe(JOB_LIMITS.nightlyFromHour);
    for (const iso of ['2026-11-02T20:29:59Z', '2026-11-02T20:30:00Z', '2026-11-02T20:30:01Z', '2026-11-03T00:00:00Z', '2026-11-02T18:29:59Z', '2026-11-02T18:30:00Z', '2026-12-31T20:29:59Z', '2026-12-31T20:30:00Z']) {
      const ms = Date.parse(iso);
      expect(scriptGate(ms), iso).toBe(srcGate({ micros: BigInt(ms) * 1000n }));
    }
    expect(scriptGate(Date.parse('2026-11-02T20:29:59Z'))).toBe(false); // 01:59:59 in India
    expect(scriptGate(Date.parse('2026-11-02T20:30:00Z'))).toBe(true); // 02:00:00
    expect(scriptGate(Date.parse('2026-11-03T18:29:59Z'))).toBe(true); // 23:59:59
    expect(scriptGate(Date.parse('2026-11-03T18:30:00Z'))).toBe(false); // 00:00:00 of the next date
  });

  it('a running row of the dump is abandoned after 30 minutes (the tick\'s 10 are JOB_LIMITS.abandonedAfterMs)', () => {
    expect(DUMP_ABANDONED_AFTER_MS).toBe(30 * 60_000);
    expect(JOB_LIMITS.dumpAbandonedAfterMs).toBe(DUMP_ABANDONED_AFTER_MS);
    expect(JOB_LIMITS.abandonedAfterMs).toBe(10 * 60_000);
  });

  it('the dump\'s own session is the S11 session of the pool, with the statement limit of 20 seconds that I8 gives to the tick and the dump', () => {
    expect(DUMP_SESSION).toEqual({ ...SESSION_SETTINGS, maxStatementTime: 20 });
    expect(FOLDER_PROBE_REPEAT_MS).toBe(srcRepeat);
    expect(FOLDER_PROBE_REPEAT_MS).toBe(24 * 3_600_000);
  });
});

describe('T-R03 JV_BACKUP_DIR: the same value is read the same way by the job and by the start-up check', () => {
  const values = [undefined, '', '   ', 'jv-backup', '~/jv-backup', '/home/u/~x', '/home/u/../x', '/', '/home/u123/jv-backup', '/home/u123/jv-backup/', '/home/u123//domains/site'];
  for (const v of values) {
    it(`${JSON.stringify(v)}`, () => {
      const a = (() => { try { return scriptResolve(v); } catch (e) { return `error: ${(e as Error).message}`; } })();
      const b = (() => { try { return srcResolve(v); } catch (e) { return `error: ${(e as Error).message}`; } })();
      expect(b).toBe(a);
    });
  }
});

describe('T-R03 the folder probe: the folder exists and is writable, tested by writing and removing a file (a mode alone does not tell: a read-only mount, a quota)', () => {
  const impls = [
    ['scripts/backup-folder.mjs', scriptProbe, scriptSetting],
    ['src/jobs/backupProbe.ts', srcProbe, srcSetting],
  ] as const;
  for (const [label, probe, setting] of impls) {
    describe(label, () => {
      it('a good folder is ok and leaves nothing behind, in the folder and in the sub-folders that exist', async () => {
        const dir = tempDir();
        for (const sub of SUBFOLDERS) mkdirSync(path.join(dir, sub));
        expect(await probe(dir)).toEqual({ ok: true });
        for (const where of ['', ...SUBFOLDERS]) expect(listNames(path.join(dir, where)).filter((n) => /probe/.test(n))).toEqual([]);
      });

      it('a folder that is not there is ENOENT (where: folder), and it is not made', async () => {
        const dir = path.join(tempDir(), 'missing-parent', 'jv-backup');
        expect(await probe(dir)).toMatchObject({ ok: false, code: 'ENOENT', where: 'folder' });
        expect(listNames(path.dirname(path.dirname(dir)))).toEqual([]);
      });

      it('a path that is a file is ENOTDIR', async () => {
        const file = plant(tempDir(), 'afile', 'x');
        expect(await probe(file)).toMatchObject({ ok: false, code: 'ENOTDIR', where: 'folder' });
      });

      it.skipIf(isRoot)('a read-only folder is EACCES (where: folder), a read-only sub-folder is EACCES with its name', async () => {
        const dir = tempDir();
        chmodSync(dir, 0o555);
        try {
          expect(await probe(dir)).toMatchObject({ ok: false, code: 'EACCES', where: 'folder' });
        } finally {
          chmodSync(dir, 0o755);
        }
        mkdirSync(path.join(dir, 'monthly'));
        chmodSync(path.join(dir, 'monthly'), 0o555);
        try {
          expect(await probe(dir)).toMatchObject({ ok: false, code: 'EACCES', where: 'monthly' });
        } finally {
          chmodSync(path.join(dir, 'monthly'), 0o755);
        }
      });

      it('the setting is resolved first: a value that is no usable path is CONFIG, with the reason and without the path', async () => {
        for (const bad of [undefined, 'relative/path', '~/x', '/a/../b']) {
          const r = await setting(bad);
          expect(r).toMatchObject({ ok: false, code: 'CONFIG', where: 'JV_BACKUP_DIR' });
        }
        const dir = tempDir();
        expect(await setting(dir)).toEqual({ ok: true, dir });
      });
    });
  }
  it('the two give equal answers on the same states', async () => {
    const dir = tempDir();
    const missing = path.join(dir, 'nope');
    const file = plant(dir, 'f', 'x');
    for (const target of [dir, missing, file]) expect(await srcProbe(target)).toEqual(await scriptProbe(target));
    for (const v of [undefined, 'x', dir, missing]) expect(await srcSetting(v)).toEqual(await scriptSetting(v));
  });
});
describe('T-R03 how a failed or healed probe is recorded: the same rows from the job and from the start-up check', () => {
  const run = async (record: typeof scriptRecord | typeof srcRecord, steps: { probe: any; at: number }[]) => {
    const s = await scratchDatabase('probetwin', { schema: true });
    onCleanUp(() => s.drop());
    const conn = await s.connect();
    onCleanUp(() => conn.end());
    const results: unknown[] = [];
    for (const step of steps) results.push(await (record as any)(conn as unknown as Connection, step.probe, { nowMs: step.at }));
    const [runs] = await conn.query<any[]>("SELECT DATE_FORMAT(ran_at, '%Y-%m-%d %H:%i:%s.%f') AS ran_at, kind, ok, bytes, detail FROM backup_runs ORDER BY id");
    const [errors] = await conn.query<any[]>('SELECT level, code, message, detail FROM sys_error_log ORDER BY id');
    const j = (v: unknown) => (typeof v === 'string' ? JSON.parse(v) : v);
    return { results, runs: runs.map((r) => ({ ...r, detail: j(r.detail) })), errors: errors.map((r) => ({ ...r, detail: j(r.detail) })) };
  };
  const T0 = Date.parse('2026-11-02T21:30:00Z');
  const HOUR = 3_600_000;
  const missing = { ok: false, code: 'ENOENT', where: 'folder' };
  const denied = { ok: false, code: 'EACCES', where: 'daily' };
  const steps = [
    { probe: { ok: true }, at: T0 }, // nothing to heal
    { probe: missing, at: T0 + HOUR }, // first failure: a row and an error
    { probe: missing, at: T0 + 2 * HOUR }, // the same failure within a day: nothing
    { probe: denied, at: T0 + 3 * HOUR }, // another failure: a row and an error
    { probe: denied, at: T0 + 3 * HOUR + 24 * HOUR + 1 }, // more than a day later: a row and an error again
    { probe: { ok: true }, at: T0 + 30 * HOUR }, // healed: one row
    { probe: { ok: true }, at: T0 + 31 * HOUR }, // nothing more
  ];

  it('both write the same rows, and the rows are the signal: ok = 0, kind db_dump, detail.folder_probe', async () => {
    const a = await run(scriptRecord, steps);
    const b = await run(srcRecord as any, steps);
    expect(b).toEqual(a);
    expect(a.results).toEqual([{ written: false, healed: false }, { written: true, healed: false }, { written: false, healed: false }, { written: true, healed: false }, { written: true, healed: false }, { written: false, healed: true }, { written: false, healed: false }]);
    expect(a.runs.map((r) => [r.kind, r.ok, r.detail.folder_probe.ok, r.detail.folder_probe.code ?? null])).toEqual([
      ['db_dump', 0, false, 'ENOENT'],
      ['db_dump', 0, false, 'EACCES'],
      ['db_dump', 0, false, 'EACCES'],
      ['db_dump', 0, true, null],
    ]);
    expect(a.runs[0].ran_at).toBe(stampOf(T0 + HOUR));
    expect(a.runs[0].detail).toMatchObject({ phase: 'folder_probe' });
    expect(a.errors.map((e) => [e.level, e.code, e.detail.code])).toEqual([['error', 'JV_BACKUP_FOLDER', 'ENOENT'], ['error', 'JV_BACKUP_FOLDER', 'EACCES'], ['error', 'JV_BACKUP_FOLDER', 'EACCES']]);
  }, 120_000);
});

describe('T-R03 the claim of the dump\'s row in sys_job_runs: failed goes back to running, ok ends the date, a running row is abandoned after 30 minutes', () => {
  it('follows the table of I8 for the job `db_dump`', async () => {
    const s = await scratchDatabase('claimdump', { schema: true });
    onCleanUp(() => s.drop());
    const conn = await s.connect();
    onCleanUp(() => conn.end());
    const T = Date.parse('2026-11-02T21:30:00Z');
    const claim = (date: string, nowMs: number) => claimDumpRun(conn as any, { runDate: date, nowMs });
    const first = await claim('2026-11-03', T);
    expect(first).toMatchObject({ claimed: true, previous: null });
    const id = (first as any).id;
    expect(await claim('2026-11-03', T + 29 * 60_000)).toEqual({ claimed: false, reason: 'running_elsewhere' });
    expect(await claim('2026-11-03', T + 31 * 60_000)).toMatchObject({ claimed: true, id, previous: { status: 'running' } });
    await conn.query("UPDATE sys_job_runs SET status = 'failed', finished_at = ? WHERE id = ?", [stampOf(T + 40 * 60_000), id]);
    expect(await claim('2026-11-03', T + 41 * 60_000)).toMatchObject({ claimed: true, id, previous: { status: 'failed' } });
    await conn.query("UPDATE sys_job_runs SET status = 'ok', finished_at = ? WHERE id = ?", [stampOf(T + 50 * 60_000), id]);
    expect(await claim('2026-11-03', T + 60 * 60_000)).toEqual({ claimed: false, reason: 'already_done' });
    expect(await claim('2026-11-04', T + 60 * 60_000)).toMatchObject({ claimed: true, previous: null });
    const [[count]] = await conn.query<any[]>("SELECT COUNT(*) AS n FROM sys_job_runs WHERE job = 'db_dump'");
    expect(Number(count.n)).toBe(2);
  }, 120_000);

  it('two callers racing for the same abandoned row: one wins (a conditional UPDATE on the status and the start time it read)', async () => {
    const s = await scratchDatabase('claimrace', { schema: true });
    onCleanUp(() => s.drop());
    const [a, b] = [await s.connect(), await s.connect()];
    onCleanUp(() => a.end());
    onCleanUp(() => b.end());
    const T = Date.parse('2026-11-02T21:30:00Z');
    await a.query("INSERT INTO sys_job_runs (job, run_date, status, started_at) VALUES ('db_dump', '2026-11-03', 'running', ?)", [stampOf(T)]);
    const wins: boolean[] = [];
    for (let round = 0; round < 5; round++) {
      await a.query("UPDATE sys_job_runs SET status = 'failed', started_at = ? WHERE job = 'db_dump'", [stampOf(T + round)]);
      const results = await Promise.all([claimDumpRun(a as any, { runDate: '2026-11-03', nowMs: T + 3_600_000 }), claimDumpRun(b as any, { runDate: '2026-11-03', nowMs: T + 3_600_000 })]);
      wins.push(results.filter((r) => r.claimed).length === 1);
    }
    expect(wins).toEqual([true, true, true, true, true]);
  }, 120_000);
});
