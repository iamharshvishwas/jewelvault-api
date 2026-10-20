import type { Connection } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../../scripts/migrate.mjs';
import { readHealth as original } from '../../scripts/health.mjs';
import { CLOCK_SKEW_MINUTES, DB_RED_LINE_BYTES, FOLDER_FALL_WINDOW_DAYS, DOWNLOAD_AMBER_DAYS, DOWNLOAD_RED_DAYS, PULL_AMBER_DAYS, RED_AFTER_HOURS, readHealth as twin } from '../../src/reads/health';
import { type Scratch, scratchDatabase } from '../helpers';

// T-D18 (API12), the dashboard line of spec section 12 and I12: src/reads/health.ts is the TypeScript twin of readHealth in scripts/health.mjs (src cannot import scripts/*.mjs: tsconfig.build.json
// compiles src alone). The twin must give the answer of the original on every state of the database, so each scenario below is asked of both, on the same connection and with the same "now".

const NOW = '2026-10-17 10:00:00';
const ago = (hours: number) => `${new Date(Date.parse('2026-10-17T10:00:00Z') - hours * 3600_000).toISOString().slice(0, 19).replace('T', ' ')}.000000`;

let scratch: Scratch;
let u: Connection;
let root: Connection;

beforeAll(async () => {
  scratch = await scratchDatabase('hlthtwin', { schema: true });
  u = await scratch.connect();
  await migrate(u, { seeds: true, optional: false });
  root = await scratch.root();
}, 120_000);
afterAll(async () => {
  await u?.end();
  await root?.end();
  await scratch?.drop();
});

const clean = async () => {
  await root.query(`DELETE FROM \`${scratch.database}\`.check_runs`);
  await root.query(`DELETE FROM \`${scratch.database}\`.backup_runs`);
  await root.query(`DELETE FROM \`${scratch.database}\`.settings WHERE setting_key IN ('last_download', 'last_pulled')`);
};
const check = (hours: number, ok = 1) => u.query('INSERT INTO check_runs (ran_at, ok, details) VALUES (?, ?, ?)', [ago(hours), ok, JSON.stringify({ counts: {} })]);
const backup = (kind: string, hours: number, detail: unknown = null, ok = 1) => u.query('INSERT INTO backup_runs (ran_at, kind, ok, bytes, detail) VALUES (?, ?, ?, ?, ?)', [ago(hours), kind, ok, 1000, detail === null ? null : JSON.stringify(detail)]);
const setting = (key: string, at: string) => u.query('INSERT INTO settings (setting_key, value) VALUES (?, ?)', [key, JSON.stringify({ at })]);
const healthy = async () => {
  await clean();
  await check(1);
  await backup('photo_copy', 3, { folder: { files: 6, bytes: 6000, free_bytes: 900000 } });
  await backup('db_dump', 2, { folder: { files: 7, bytes: 7000, free_bytes: 800000 } });
};
const SIZE = { now: NOW, sizeBytes: 123_456_789 };

/** Asks the original and the twin, and says they agree. Returns the answer for the checks of the scenario. */
async function both(opts: Parameters<typeof original>[1] = SIZE, conn: Connection = u) {
  const a = await original(conn, opts);
  const b = await twin(conn, opts);
  expect(b).toEqual(a);
  return b;
}

describe('T-D18 the TypeScript twin of readHealth gives the answer of scripts/health.mjs on every state of the database', () => {
  it('the constants are the original\'s', async () => {
    const m = await import('../../scripts/health.mjs');
    expect({ RED_AFTER_HOURS, DB_RED_LINE_BYTES, DOWNLOAD_AMBER_DAYS, DOWNLOAD_RED_DAYS, PULL_AMBER_DAYS, FOLDER_FALL_WINDOW_DAYS, CLOCK_SKEW_MINUTES }).toEqual({
      RED_AFTER_HOURS: m.RED_AFTER_HOURS,
      DB_RED_LINE_BYTES: m.DB_RED_LINE_BYTES,
      DOWNLOAD_AMBER_DAYS: m.DOWNLOAD_AMBER_DAYS,
      DOWNLOAD_RED_DAYS: m.DOWNLOAD_RED_DAYS,
      PULL_AMBER_DAYS: m.PULL_AMBER_DAYS,
      FOLDER_FALL_WINDOW_DAYS: m.FOLDER_FALL_WINDOW_DAYS,
      CLOCK_SKEW_MINUTES: m.CLOCK_SKEW_MINUTES,
    });
  });

  it('a new shop that has never run the check or a backup', async () => {
    await clean();
    const h = await both();
    expect(h.level).toBe('red');
    expect(h.reasons).toEqual(['check_never', 'dump_never', 'photo_copy_never']);
  });

  it('fresh check, export and photo copy, a download and a pull on record', async () => {
    await healthy();
    await setting('last_download', '2026-10-12T05:00:00.000Z');
    await setting('last_pulled', '2026-10-15T05:00:00.000Z');
    const h = await both();
    expect(h.reasons).toEqual([]);
    expect(h.level).toBe('green');
  });

  it('a check that says Problem; a check, an export and a photo copy older than 26 hours (26.0 fine, 26.5 not)', async () => {
    await healthy();
    await check(0.5, 0);
    expect((await both()).reasons).toContain('check_problem');
    for (const hours of [26, 26.5, 30]) {
      await clean();
      await check(hours);
      await backup('db_dump', hours, { folder: { files: 1 } });
      await backup('photo_copy', hours, { folder: { files: 1 } });
      const h = await both();
      expect(h.reasons.includes('check_stale'), `${hours} h`).toBe(hours > RED_AFTER_HOURS);
    }
  });

  it('the file count of the backup folder falls: red for a week unless the run pruned that many files', async () => {
    await clean();
    await check(1);
    await backup('db_dump', 30, { folder: { files: 10 } });
    await backup('db_dump', 5, { folder: { files: 7 } });
    await backup('photo_copy', 4, { folder: { files: 7 } });
    const fell = await both();
    expect(fell.reasons).toContain('backup_files_fell');
    await clean();
    await check(1);
    await backup('db_dump', 30, { folder: { files: 10 } });
    await backup('db_dump', 5, { folder: { files: 7 }, pruned: 3 });
    await backup('photo_copy', 4, { folder: { files: 7 } });
    expect((await both()).reasons).not.toContain('backup_files_fell');
    await clean();
    await check(1);
    await backup('db_dump', 24 * 9, { folder: { files: 10 } });
    await backup('db_dump', 24 * 8, { folder: { files: 7 } }); // fell eight days ago: out of the seven-day window
    await backup('photo_copy', 2, { folder: { files: 7 } });
    expect((await both()).reasons).not.toContain('backup_files_fell');
  });

  it('Download everything: 27 days is fine, 28 amber, 35 amber, 36 red; with none the first night counts; and Harsh\'s pull: 10 days fine, 11 amber', async () => {
    const days = (d: number) => new Date(Date.parse('2026-10-17T05:00:00Z') - d * 86_400_000).toISOString();
    for (const d of [27, 28, 35, 36]) {
      await healthy();
      await setting('last_download', days(d));
      const h = await both();
      expect(h.download.age_days).toBe(d);
      expect(h.download.state).toBe(d > DOWNLOAD_RED_DAYS ? 'red' : d >= DOWNLOAD_AMBER_DAYS ? 'amber' : 'ok');
    }
    for (const d of [10, 11]) {
      await healthy();
      await setting('last_pulled', days(d));
      const h = await both();
      expect(h.pull.state).toBe(d > PULL_AMBER_DAYS ? 'amber' : 'ok');
    }
    await clean();
    await check(24 * 40); // the first night was 40 days ago
    await check(1);
    await backup('db_dump', 24 * 12, { folder: { files: 1 } });
    await backup('db_dump', 2, { folder: { files: 1 } });
    await backup('photo_copy', 3, { folder: { files: 1 } });
    const h = await both();
    expect([h.download.from, h.download.age_days, h.pull.from, h.pull.age_days]).toEqual(['first_night', 40, 'first_export', 12]);
  });

  it('the database size against the red line of 2 GB: measured (with and without ANALYZE TABLE), and injected', async () => {
    await healthy();
    const below = await both({ now: NOW, sizeBytes: DB_RED_LINE_BYTES });
    expect(below.reasons).not.toContain('db_size');
    expect((await both({ now: NOW, sizeBytes: DB_RED_LINE_BYTES + 1 })).reasons).toContain('db_size');
    const measured = await both({ now: NOW, analyze: false });
    expect(measured.db_size.injected).toBe(false);
    expect(measured.db_size.bytes).toBeGreaterThan(0);
    await both({ now: NOW });
  });

  it('what the database user may do: the ten boxes of A3 are green; Delete or Drop makes it amber; other rights are listed', async () => {
    await healthy();
    expect((await both()).rights).toEqual({ delete: false, drop: false, extra: [] });
    const name = `${scratch.user}`;
    await root.query(`GRANT DELETE, EXECUTE ON \`${scratch.database}\`.* TO ?@'%'`, [name]);
    const withDelete = await both();
    expect(withDelete.rights.delete).toBe(true);
    expect(withDelete.rights.extra).toContain('EXECUTE');
    expect(withDelete.reasons).toContain('delete_or_drop_right');
    expect(withDelete.level).toBe('amber');
    await root.query(`GRANT DROP ON \`${scratch.database}\`.* TO ?@'%'`, [name]);
    expect((await both()).rights.drop).toBe(true);
    await root.query(`REVOKE DELETE, DROP, EXECUTE ON \`${scratch.database}\`.* FROM ?@'%'`, [name]);
    expect((await both()).rights).toEqual({ delete: false, drop: false, extra: [] });
  });
});

describe('RV3a-F1 the twin and the original agree on the nightly check of the photo copies: a repair is amber for seven days, a damaged copy is red until a newer row says none', () => {
  const verify = (detail: Record<string, unknown>, files = 6) => ({ folder: { files, bytes: 6000, free_bytes: 900000 }, verify: { checked: 6, missing: 0, repaired: 0, damaged_total: 0, damaged: [], ...detail } });

  it('a repair within the last seven days is amber and adds up over the nights; one older than seven days is history; the figure says how many and when', async () => {
    await healthy();
    await backup('photo_copy', 30, verify({ repaired: 2 }));
    await backup('photo_copy', 54, verify({ repaired: 1 }));
    const h = await both();
    expect(h.reasons).toEqual(['backup_photos_repaired']);
    expect(h.level).toBe('amber');
    expect(h.photo_files).toEqual({ repaired: 3, repaired_at: ago(30), damaged: 0, damaged_at: null });

    await healthy();
    await backup('photo_copy', 24 * 7 + 1, verify({ repaired: 4 })); // seven days and an hour ago: out of the window
    const old = await both();
    expect(old.reasons).toEqual([]);
    expect(old.photo_files).toEqual({ repaired: 0, repaired_at: null, damaged: 0, damaged_at: null });
  });

  it('negative control: rows without a verify (before RV3a), or a verify with nothing repaired and nothing damaged, add no reason and no figure', async () => {
    await healthy();
    await backup('photo_copy', 30, verify({}));
    await backup('photo_copy', 40, { folder: { files: 6 } });
    const h = await both();
    expect(h.reasons).toEqual([]);
    expect(h.level).toBe('green');
    expect(h.photo_files).toEqual({ repaired: 0, repaired_at: null, damaged: 0, damaged_at: null });
  });

  it('a damaged copy is red (and the line says how many and when) until a NEWER row that has a verify says none; a newer failed row without a verify does not clear it', async () => {
    await healthy();
    await backup('photo_copy', 5, verify({ damaged_total: 2, damaged: [{ id: 'a', kind: 'full', reason: 'sha256' }] }), 0);
    const red = await both();
    expect(red.reasons).toEqual(['backup_photos_damaged']);
    expect(red.level).toBe('red');
    expect(red.photo_files).toMatchObject({ damaged: 2, damaged_at: ago(5) });

    await backup('photo_copy', 1, { error: { name: 'Error', code: 'ENOENT' } }, 0); // the folder was gone: says nothing about the copies
    expect((await both()).reasons).toContain('backup_photos_damaged');

    await backup('photo_copy', 0.5, verify({ repaired: 1 }, 7)); // the damaged file was removed by hand and written again: the newest verify says none
    const cleared = await both();
    expect(cleared.reasons).toEqual(['backup_photos_repaired']);
    expect(cleared.photo_files).toMatchObject({ damaged: 0, damaged_at: null });
  });

  it('the order of the reasons: the damaged copy is red after the fallen file count, the repair is amber after the pull', async () => {
    await clean();
    await check(1);
    await backup('db_dump', 30, { folder: { files: 10 } });
    await backup('db_dump', 5, { folder: { files: 7 } });
    await backup('photo_copy', 4, verify({ repaired: 1, damaged_total: 1, damaged: [{ id: 'a', kind: 'thumb', reason: 'size' }] }));
    await setting('last_pulled', '2026-10-01T05:00:00.000Z');
    await setting('last_download', '2026-09-01T05:00:00.000Z');
    const h = await both();
    expect(h.reasons).toEqual(['backup_files_fell', 'backup_photos_damaged', 'download_red', 'pulled_amber', 'backup_photos_repaired']);
  });
});

describe('RV3a-F3 the twin and the original agree on the folder signal: backup_folder_unusable is red until a good run is newer than the failed probe, and the figure folder_probe says what the newest probe found', () => {
  const probe = (hours: number, p: Record<string, unknown>) => backup('db_dump', hours, { phase: 'folder_probe', folder_probe: p }, 0);

  it('no probe ever: the figure is null and nothing is red', async () => {
    await healthy();
    const h = await both();
    expect(h.folder_probe).toBeNull();
    expect(h.reasons).toEqual([]);
  });

  it('a failed probe newer than the good runs: red, the figure names code, where and when; a good export or photo copy newer than it clears the reason, an older one or a failed run does not', async () => {
    await healthy(); // the photo copy is 3 hours old, the export 2 hours
    await probe(1, { ok: false, code: 'ENOENT', where: 'folder' });
    const red = await both();
    expect(red.reasons).toEqual(['backup_folder_unusable']);
    expect(red.level).toBe('red');
    expect(red.folder_probe).toEqual({ ok: false, code: 'ENOENT', where: 'folder', at: ago(1) });

    await backup('photo_copy', 0.75, null, 0); // a failed run is no proof that the folder works
    expect((await both()).reasons).toEqual(['backup_folder_unusable']);

    await backup('photo_copy', 0.5, { folder: { files: 7, bytes: 7000, free_bytes: 800000 } }); // a good run after the probe
    const healed = await both();
    expect(healed.reasons).toEqual([]);
    expect(healed.folder_probe).toMatchObject({ ok: false, code: 'ENOENT' }); // the figure is still the newest probe: it is the reason that went
  });

  it('the heal row is the newest probe: ok true, not red; JSON false is the text 0 (or false) for the reader, JSON true anything else', async () => {
    await healthy();
    await probe(5, { ok: false, code: 'EACCES', where: 'photos' });
    await probe(1, { ok: true });
    const h = await both();
    expect(h.reasons).toEqual([]);
    expect(h.folder_probe).toEqual({ ok: true, code: null, where: null, at: ago(1) });
  });

  it('the reason follows backup_files_fell and comes before backup_photos_damaged', async () => {
    await clean();
    await check(1);
    await backup('db_dump', 30, { folder: { files: 10 } });
    await backup('db_dump', 5, { folder: { files: 7 } });
    await backup('photo_copy', 4, { folder: { files: 7 } });
    await backup('photo_copy', 3, { verify: { damaged_total: 1, damaged: [{ id: 'a', kind: 'full', reason: 'size' }] } }, 0);
    await probe(0.5, { ok: false, code: 'ENOENT', where: 'folder' });
    expect((await both()).reasons).toEqual(['backup_files_fell', 'backup_folder_unusable', 'backup_photos_damaged']);
  });
});

describe('RV3a-F4 the twin and the original agree on a good run dated in the future: the age ignores it, it is red by itself, a skew of 5 minutes is fine', () => {
  const inFuture = (minutes: number) => -minutes / 60; // ago() of a negative number of hours is a time after NOW

  it('a dead export (5 days old) with a good export and photo copy 40 days ahead: stale as it really is, plus backup_clock_ahead; the figure says how far ahead', async () => {
    await clean();
    await check(1);
    await backup('db_dump', 24 * 5, { folder: { files: 7 } });
    await backup('photo_copy', 24 * 5, { folder: { files: 7 } });
    await backup('db_dump', inFuture(40 * 24 * 60), { folder: { files: 7 } });
    await backup('photo_copy', inFuture(40 * 24 * 60), { folder: { files: 7 } });
    const h = await both();
    expect(h.reasons).toEqual(['dump_stale', 'photo_copy_stale', 'backup_clock_ahead']);
    expect(h.db_dump.age_hours).toBe(120);
    expect(h.clock_ahead).toEqual({ last_at: ago(inFuture(40 * 24 * 60)), hours: 960 });
  });

  it('a failed run or a restore drill in the future is not a good run; a good run 5 minutes ahead is skew and counts as fresh, 6 minutes is a fault', async () => {
    await healthy();
    await backup('db_dump', inFuture(60 * 24), { phase: 'failed' }, 0);
    await backup('restore_drill', inFuture(60 * 24), {});
    expect((await both()).reasons).toEqual([]);
    await backup('db_dump', inFuture(5), { folder: { files: 7 } });
    const skew = await both();
    expect(skew.reasons).toEqual([]);
    expect(skew.db_dump.age_hours).toBe(-0.08);
    await backup('db_dump', inFuture(6), { folder: { files: 7 } });
    const over = await both();
    expect(over.reasons).toEqual(['backup_clock_ahead']);
    expect(over.db_dump.last_at).toBe(ago(inFuture(5)));
    expect(over.clock_ahead).toEqual({ last_at: ago(inFuture(6)), hours: 0.1 });
  });

  it('a run in the future does not heal the folder signal, does not become the folder figure, and does not clear a damaged copy', async () => {
    await healthy();
    await backup('db_dump', 1, { phase: 'folder_probe', folder_probe: { ok: false, code: 'ENOENT', where: 'folder' } }, 0);
    await backup('photo_copy', 0.8, { folder: { files: 7 }, verify: { damaged_total: 1, damaged: [{ id: 'a', kind: 'full', reason: 'size' }] } }, 0);
    await backup('photo_copy', inFuture(24 * 60), { folder: { files: 1 }, verify: { damaged_total: 0, damaged: [] } });
    const h = await both();
    expect(h.reasons).toEqual(['backup_folder_unusable', 'backup_photos_damaged', 'backup_clock_ahead']);
    expect(h.folder?.files).toBe(7);
    expect(h.folder?.fell).toBe(false);
  });
});
