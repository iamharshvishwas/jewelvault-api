import { mkdirSync, rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runDumpJob } from '../../scripts/dump-job.mjs';
import { createPacer } from '../../scripts/pacing.mjs';
import { formatTimestamp } from '../../src/clock';
import { JOB_HEALTH_REASONS } from '../../src/jobs/health';
import { readHealth } from '../../src/reads/health';
import { keysOnce, logCapture } from './dump-support';
import { type TickWorld, at, body, tickWorld } from './tick-support';

// RV3a-F3 (implementation review 3, finding F3; B2, I12, I8): the dump writes a signal when the backup folder cannot be used (API34: a `backup_runs` row of kind `db_dump`, ok 0, detail
// {phase: 'folder_probe', folder_probe: {ok, code, where}}, and the heal row {ok: true} when a later probe passes), and nothing read it: with the folder gone the tick answered 500 and the dump exited 1
// from the first hour, and the owner's line stayed GREEN and the outside check 200 until the last good export was 26 hours old. readHealth now reads it: a RED reason `backup_folder_unusable` (after
// `backup_files_fell`) while the newest probe row says ok false and no good `db_dump` or `photo_copy` row is newer, and the figure folder_probe {ok, code, where, at}. The reason also fails the outside
// check (GET /internal/jobs/health, 503).

const HOUR = 3_600_000;
const IST = (date: string, hhmm = '03:00') => Date.parse(`${date}T${hhmm}:00+05:30`);

describe('RV3a-F3 the outside check names the folder: backup_folder_unusable is one of the reasons that make it answer 503', () => {
  it('JOB_HEALTH_REASONS holds the reasons of I8 in the order readHealth lists them: the export, the folder, the download', () => {
    expect(JOB_HEALTH_REASONS).toEqual(['dump_never', 'dump_stale', 'backup_folder_unusable', 'download_red']);
  });
});

describe('RV3a-F3 the folder signal, end to end: the folder is removed after a good night; the dump writes the signal; the owner\'s line is red at once and the outside check answers 503; the folder comes back and both heal', () => {
  let w: TickWorld;
  let env: Record<string, string>;
  const pacer = createPacer({ max: 10_000 });
  const D0 = '2026-10-20';
  const D1 = '2026-10-21';

  beforeAll(async () => {
    w = await tickWorld('rv3af3', { routes: true, seeds: true });
    const d = w.world.scratch.db;
    env = { DB_HOST: d.host, DB_PORT: String(d.port), DB_NAME: d.name, DB_USER: d.user, DB_PASSWORD: d.password, JV_BACKUP_DIR: w.backupDir as string, BACKUP_PUBLIC_KEY: keysOnce().publicLine };
  }, 180_000);
  afterAll(async () => {
    await w?.close();
  });

  const tickAt = (ms: number) => {
    w.time.time.micros = BigInt(ms) * 1000n;
    return w.tick();
  };
  const dumpAt = (ms: number) => runDumpJob({ env, nowMs: () => ms, pacer, log: logCapture() });
  /** the owner's line (readHealth, the function behind GET /v1/dashboard/health) and the outside check (GET /internal/jobs/health), both on the API's clock at `ms` */
  const looks = async (ms: number) => {
    w.time.time.micros = BigInt(ms) * 1000n;
    const line = await readHealth(w.sql, { now: formatTimestamp(w.time.time.micros), sizeBytes: 1, analyze: false });
    const outside = await w.health();
    return { line, outside, outsideBody: body(outside) };
  };

  it('night 0: everything is good (tick, dump, photo copy): the line is green, the outside check 200, and there has never been a probe: folder_probe is null', async () => {
    expect((await tickAt(IST(D0))).statusCode).toBe(200);
    expect((await dumpAt(IST(D0) + 30_000)).status).toBe('done');
    const { line, outside } = await looks(IST(D0) + HOUR);
    expect(line.reasons).toEqual([]);
    expect(line.level).toBe('green');
    expect(line.folder_probe).toBeNull();
    expect(outside.statusCode).toBe(200);
  });

  it('RV3a-F3 the folder is gone (a domain was connected, the site folder renamed): 24 hours after the last good run the tick fails and the dump exits 1 and writes the signal; THE LINE IS RED AT ONCE and the outside check is 503', async () => {
    rmSync(env.JV_BACKUP_DIR, { recursive: true, force: true });
    const tick = await tickAt(IST(D1));
    expect(tick.statusCode).toBe(500);
    const dump = await dumpAt(IST(D1) + 30_000);
    expect([dump.status, dump.exitCode]).toEqual(['folder_unusable', 1]);
    const { line, outside, outsideBody } = await looks(IST(D1) + HOUR);
    // 25 hours after the last good export: not yet the 26 of dump_stale. The signal is what says it.
    expect(line.db_dump.age_hours).toBeLessThan(26);
    expect(line.reasons).toContain('backup_folder_unusable');
    expect(line.reasons).not.toContain('dump_stale');
    expect(line.level).toBe('red');
    expect(line.folder_probe).toEqual({ ok: false, code: 'ENOENT', where: 'folder', at: expect.stringMatching(/^2026-10-2\d \d\d:\d\d:\d\d\.\d{6}$/) });
    expect(outside.statusCode, outside.body).toBe(503);
    expect(outsideBody).toMatchObject({ ok: false, failing: ['backup_folder_unusable'] });
  });

  it('the same failed probe is not written again within a day, and the line stays red hour after hour', async () => {
    const rows = async () => Number((await w.sql.query<any[]>("SELECT COUNT(*) AS n FROM backup_runs WHERE JSON_CONTAINS_PATH(detail, 'one', '$.folder_probe')"))[0][0].n);
    const before = await rows();
    expect((await dumpAt(IST(D1) + 2 * HOUR)).exitCode).toBe(1);
    expect(await rows()).toBe(before);
    const { line, outside } = await looks(IST(D1) + 2 * HOUR + 60_000);
    expect(line.reasons).toContain('backup_folder_unusable');
    expect(outside.statusCode).toBe(503);
  });

  it('RV3a-F3 the folder is made again: the next dump writes the heal row and a good export, the photo copy catches up; the reason is gone, the outside check is 200 and the figure says ok', async () => {
    mkdirSync(env.JV_BACKUP_DIR, { recursive: true });
    expect((await tickAt(IST(D1) + 3 * HOUR)).statusCode).toBe(200);
    const dump = await dumpAt(IST(D1) + 3 * HOUR + 30_000);
    expect(dump.status).toBe('done');
    const { line, outside } = await looks(IST(D1) + 4 * HOUR);
    // the exports that were in the folder are gone with it: the count of files fell, and that stays red for seven days (B2). What is gone from the line is the signal that the folder cannot be used.
    expect(line.reasons).toEqual(['backup_files_fell']);
    expect(line.reasons).not.toContain('backup_folder_unusable');
    expect(line.folder_probe).toEqual({ ok: true, code: null, where: null, at: expect.any(String) });
    expect(outside.statusCode, outside.body).toBe(200);
  });
});

describe('RV3a-F3 readHealth reads the signal: the newest probe row decides, a good run after it heals, JSON false is read as the text 0 or false', () => {
  let w: TickWorld;
  beforeAll(async () => {
    w = await tickWorld('rv3af3b', { routes: false, seeds: true });
  }, 120_000);
  afterAll(async () => {
    await w?.close();
  });

  const NOW = at('2026-10-20T10:00:00Z');
  const ago = (hours: number) => formatTimestamp(NOW - BigInt(Math.round(hours * 3_600_000)) * 1000n);
  const insert = (kind: string, hours: number, ok: number, detail: unknown) => w.sql.query('INSERT INTO backup_runs (ran_at, kind, ok, bytes, detail) VALUES (?, ?, ?, 1000, ?)', [ago(hours), kind, ok, JSON.stringify(detail)]);
  const probe = (hours: number, p: Record<string, unknown>) => insert('db_dump', hours, 0, { phase: 'folder_probe', folder_probe: p });
  const line = () => readHealth(w.sql, { now: formatTimestamp(NOW), sizeBytes: 1, analyze: false });
  /** the world's user has no Delete right (ten boxes): the rows of earlier tests are cleared through the root connection */
  let root: Awaited<ReturnType<TickWorld['world']['scratch']['root']>>;
  const reset = async () => {
    root ??= await w.world.scratch.root();
    await root.query(`DELETE FROM \`${w.database}\`.backup_runs`);
    await root.query(`DELETE FROM \`${w.database}\`.check_runs`);
    await w.sql.query('INSERT INTO check_runs (ran_at, ok, details) VALUES (?, 1, ?)', [ago(1), JSON.stringify({ invariants: [] })]);
    await insert('db_dump', 2, 1, { folder: { files: 7, bytes: 7000 } });
    await insert('photo_copy', 3, 1, { folder: { files: 7, bytes: 7000 } });
  };
  afterAll(async () => {
    await root?.end();
  });

  it('negative control: no probe row ever: the figure is null, nothing is red', async () => {
    await reset();
    const h = await line();
    expect(h.folder_probe).toBeNull();
    expect(h.reasons).toEqual([]);
  });

  it('a failed probe is red, with the figure (a JSON false comes back from JSON_VALUE as the text 0 on MariaDB 11.8, and is read as false)', async () => {
    await reset();
    await probe(1, { ok: false, code: 'EACCES', where: 'daily' });
    const h = await line();
    expect(h.reasons).toEqual(['backup_folder_unusable']);
    expect(h.level).toBe('red');
    expect(h.folder_probe).toEqual({ ok: false, code: 'EACCES', where: 'daily', at: ago(1) });
    const [[raw]] = await w.sql.query<any[][]>("SELECT JSON_VALUE(detail, '$.folder_probe.ok') AS ok FROM backup_runs WHERE JSON_CONTAINS_PATH(detail, 'one', '$.folder_probe')");
    expect(['0', 'false']).toContain((raw as any).ok);
  });

  it('a good export or a good photo copy NEWER than the failed probe heals it; one that is older does not', async () => {
    await reset();
    await probe(1, { ok: false, code: 'ENOENT', where: 'folder' });
    expect((await line()).reasons).toEqual(['backup_folder_unusable']); // the good rows of reset() are 2 and 3 hours old: older than the probe
    await insert('photo_copy', 0.5, 1, { folder: { files: 7, bytes: 7000 } });
    expect((await line()).reasons).toEqual([]);
    await reset();
    await probe(1, { ok: false, code: 'ENOENT', where: 'folder' });
    await insert('db_dump', 0.5, 1, { folder: { files: 7, bytes: 7000 } });
    expect((await line()).reasons).toEqual([]);
  });

  it('a newer FAILED run (ok 0) does not heal it', async () => {
    await reset();
    await probe(1, { ok: false, code: 'ENOENT', where: 'folder' });
    await insert('photo_copy', 0.5, 0, { error: { code: 'ENOENT' } });
    await insert('db_dump', 0.4, 0, { phase: 'failed' });
    expect((await line()).reasons).toEqual(['backup_folder_unusable']);
  });

  it('the heal row (folder_probe.ok true) is the newest probe: not red, and the figure says ok; a later failure is red again', async () => {
    await reset();
    await probe(5, { ok: false, code: 'ENOENT', where: 'folder' });
    await probe(1, { ok: true });
    const h = await line();
    expect(h.reasons).toEqual([]);
    expect(h.folder_probe).toEqual({ ok: true, code: null, where: null, at: ago(1) });
    await probe(0.5, { ok: false, code: 'ENOTDIR', where: 'photos' });
    const again = await line();
    expect(again.reasons).toEqual(['backup_folder_unusable']);
    expect(again.folder_probe).toMatchObject({ ok: false, code: 'ENOTDIR', where: 'photos' });
  });

  it('the reason comes after backup_files_fell and before the other reasons of the dashboard', async () => {
    await reset();
    await insert('db_dump', 30, 1, { folder: { files: 10 } });
    await insert('db_dump', 5, 1, { folder: { files: 7 } }); // the count fell from 10 to 7
    await probe(0.2, { ok: false, code: 'ENOENT', where: 'folder' });
    expect((await line()).reasons).toEqual(['backup_files_fell', 'backup_folder_unusable']);
  });
});
