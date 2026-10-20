import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runDumpJob } from '../../scripts/dump-job.mjs';
import { createPacer } from '../../scripts/pacing.mjs';
import { formatTimestamp } from '../../src/clock';
import { CLOCK_SKEW_MINUTES, readHealth } from '../../src/reads/health';
import { keysOnce, logCapture } from './dump-support';
import { type TickWorld, at, body, tickWorld } from './tick-support';

// RV3a-F4 (implementation review 3, finding F4; I12, I8): the age of the last good export and of the last good photo copy was worked out from MAX(ran_at), and the dump stamps `ran_at` from the clock
// of the cron host. One good run written with a clock that is wrong and AHEAD made a negative age ("-960 hours"), which is never stale: a dead export looked fresh until the future arrived. The age is
// now taken from the newest good run that is NOT in the future (a skew of 5 minutes is tolerated, the clocks of the app and of cron differ by seconds), and a good run in the future is itself a RED
// reason, `backup_clock_ahead`, with the figure clock_ahead {last_at, hours}. A future row is also left out of the folder figures and cannot heal the folder signal.

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const IST = (date: string, hhmm = '03:00') => Date.parse(`${date}T${hhmm}:00+05:30`);

describe('RV3a-F4 the age of the last good run ignores a run dated in the future, and a run dated in the future is red', () => {
  let w: TickWorld;
  let root: Awaited<ReturnType<TickWorld['world']['scratch']['root']>>;
  const NOW = at('2026-10-20T10:00:00Z');
  const ms = (micros: bigint) => Number(micros / 1000n);
  const when = (offsetMs: number) => formatTimestamp(NOW + BigInt(offsetMs) * 1000n);
  const line = () => readHealth(w.sql, { now: formatTimestamp(NOW), sizeBytes: 1, analyze: false });
  const insert = (kind: string, offsetMs: number, ok = 1, detail: unknown = { folder: { files: 7, bytes: 7000 } }) =>
    w.sql.query('INSERT INTO backup_runs (ran_at, kind, ok, bytes, detail) VALUES (?, ?, ?, 1000, ?)', [when(offsetMs), kind, ok, JSON.stringify(detail)]);
  /** a shop whose export and photo copy ran 5 days ago and whose nightly check is fresh: the export is DEAD (older than 26 hours) */
  const deadExport = async () => {
    await root.query(`DELETE FROM \`${w.database}\`.backup_runs`);
    await root.query(`DELETE FROM \`${w.database}\`.check_runs`);
    await w.sql.query('INSERT INTO check_runs (ran_at, ok, details) VALUES (?, 1, ?)', [when(-HOUR), JSON.stringify({ invariants: [] })]);
    await insert('db_dump', -5 * DAY);
    await insert('photo_copy', -5 * DAY);
  };

  beforeAll(async () => {
    w = await tickWorld('rv3af4', { routes: true, seeds: true });
    root = await w.world.scratch.root();
  }, 180_000);
  afterAll(async () => {
    await root?.end();
    await w?.close();
  });

  it('the skew that is tolerated is 5 minutes', () => {
    expect(CLOCK_SKEW_MINUTES).toBe(5);
  });

  it('negative control: a dead export with no run in the future is red as ever (dump_stale and photo_copy_stale), and says nothing about a clock', async () => {
    await deadExport();
    const h = await line();
    expect(h.reasons).toEqual(['dump_stale', 'photo_copy_stale']);
    expect(h.db_dump.age_hours).toBe(120);
    expect(h.clock_ahead).toBeNull();
  });

  it('THE FALSE GREEN of the review: a good export and a good photo copy dated 40 days ahead no longer hide the dead export: the age is the real one, and the clock is named', async () => {
    await deadExport();
    await insert('db_dump', 40 * DAY);
    await insert('photo_copy', 40 * DAY);
    const h = await line();
    expect(h.level).toBe('red');
    expect(h.reasons).toEqual(['dump_stale', 'photo_copy_stale', 'backup_clock_ahead']);
    expect(h.db_dump.age_hours, 'the newest run that is not in the future: five days, not -960 hours').toBe(120);
    expect(h.db_dump.last_at).toBe(when(-5 * DAY));
    expect(h.photo_copy.age_hours).toBe(120);
    expect(h.clock_ahead).toEqual({ last_at: when(40 * DAY), hours: 960 });
  });

  it('only a good run in the future is a clock fault: a failed run, a restore drill, or a run of the past are not', async () => {
    await deadExport();
    await insert('db_dump', 40 * DAY, 0, { phase: 'failed' }); // a failed run says nothing about a dead export
    await insert('restore_drill', 40 * DAY);
    const h = await line();
    expect(h.reasons).toEqual(['dump_stale', 'photo_copy_stale']);
    expect(h.clock_ahead).toBeNull();
  });

  it('a run a few minutes ahead is skew, not a fault: 5 minutes is tolerated and counts as fresh; 5 minutes and a second is not', async () => {
    await deadExport();
    await insert('db_dump', 5 * 60_000);
    await insert('photo_copy', 3 * 60_000);
    const near = await line();
    expect(near.reasons).toEqual([]);
    expect(near.level).toBe('green');
    expect(near.db_dump.last_at).toBe(when(5 * 60_000));
    expect(near.clock_ahead).toBeNull();
    await insert('db_dump', 5 * 60_000 + 1000);
    const over = await line();
    expect(over.reasons).toEqual(['backup_clock_ahead']);
    expect(over.clock_ahead).toMatchObject({ last_at: when(5 * 60_000 + 1000) });
    expect(over.db_dump.last_at, 'the age is taken from the run before it').toBe(when(5 * 60_000));
  });

  it('when the future arrives the row is just a good run: the reason is gone and the row counts', async () => {
    await deadExport();
    await insert('db_dump', 2 * DAY);
    await insert('photo_copy', 2 * DAY);
    const before = await line();
    expect(before.reasons).toContain('backup_clock_ahead');
    const later = await readHealth(w.sql, { now: when(2 * DAY + 2 * HOUR), sizeBytes: 1, analyze: false });
    expect(later.reasons).not.toContain('backup_clock_ahead');
    expect(later.reasons).not.toContain('dump_stale');
    expect(later.db_dump.age_hours).toBe(2);
  });

  it('a run in the future cannot heal the folder signal, and is not the folder figure', async () => {
    await deadExport();
    await insert('db_dump', -2 * HOUR);
    await insert('photo_copy', -2 * HOUR);
    await insert('db_dump', -HOUR, 0, { phase: 'folder_probe', folder_probe: { ok: false, code: 'ENOENT', where: 'folder' } });
    await insert('photo_copy', 40 * DAY, 1, { folder: { files: 1, bytes: 1 } }); // a good run "after" the probe, by a clock that is wrong
    const h = await line();
    expect(h.reasons).toEqual(['backup_folder_unusable', 'backup_clock_ahead']);
    expect(h.folder?.files, 'the folder figure is the newest run that is not in the future').toBe(7);
    expect(h.folder?.fell).toBe(false);
  });

  it('the outside check (GET /internal/jobs/health) follows: 503 naming dump_stale, with the real age of the export', async () => {
    await deadExport();
    await insert('db_dump', 40 * DAY);
    await insert('photo_copy', 40 * DAY);
    w.time.time.micros = NOW;
    const res = await w.health();
    expect(res.statusCode, res.body).toBe(503);
    expect(body(res)).toMatchObject({ ok: false, failing: ['dump_stale'], dump: { age_hours: 120 } });
    await deadExport();
    expect((await w.health()).statusCode, 'the same shop without the run in the future is 503 too').toBe(503);
  });
});

describe('RV3a-F4 end to end: the dump script of a cron host whose clock was 40 days ahead for one night', () => {
  it('the wrong night writes an ok row 40 days ahead; the export is then dead for three days, and the line says so instead of reading a negative age', async () => {
    const w = await tickWorld('rv3af4b', { routes: true, seeds: true });
    try {
      const d = w.world.scratch.db;
      const env = { DB_HOST: d.host, DB_PORT: String(d.port), DB_NAME: d.name, DB_USER: d.user, DB_PASSWORD: d.password, JV_BACKUP_DIR: w.backupDir as string, BACKUP_PUBLIC_KEY: keysOnce().publicLine };
      const pacer = createPacer({ max: 10_000 });
      const dumpAt = (t: number) => runDumpJob({ env, nowMs: () => t, pacer, log: logCapture() });
      const lineAt = (t: number) => {
        w.time.time.micros = BigInt(t) * 1000n;
        return readHealth(w.sql, { now: formatTimestamp(w.time.time.micros), sizeBytes: 1, analyze: false });
      };
      const D0 = IST('2026-10-20');
      w.time.time.micros = BigInt(D0) * 1000n;
      expect((await w.tick()).statusCode).toBe(200);
      expect((await dumpAt(D0 + 30_000)).status).toBe('done'); // the last good night, on the right clock
      expect((await dumpAt(D0 + 40 * DAY)).status).toBe('done'); // the wrong clock: 40 days ahead, the date is new, the dump is due
      const h = await lineAt(D0 + 3 * DAY); // three nights later nobody has exported anything on the right clock
      expect(h.db_dump.age_hours, 'not a negative age').toBeGreaterThan(24 * 2.9);
      expect(h.reasons).toContain('dump_stale');
      expect(h.reasons).toContain('backup_clock_ahead');
      expect(h.level).toBe('red');
      expect(h.clock_ahead!.hours).toBeGreaterThan(24 * 36);
      w.time.time.micros = BigInt(D0 + 3 * DAY) * 1000n;
      const outside = await w.health();
      expect(outside.statusCode, outside.body).toBe(503);
    } finally {
      await w.close();
    }
  }, 240_000);
});
