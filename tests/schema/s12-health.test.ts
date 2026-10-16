import { createHash, randomBytes } from 'node:crypto';
import mysql, { type Connection } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HOST, PORT, dropDb, rootConn } from '../helpers';
import { DB_RED_LINE_BYTES, RED_AFTER_HOURS, readHealth } from '../../scripts/health.mjs';
import { insert, migratedDb, uuid } from './support';

// Spec I12 + the dashboard line + T-R03 (database half): how old the last good export and photo copy and the last check are, how big the database is, and what the user may do.
// All ages are measured in hours from one fixed "now", so the tests do not depend on the clock.

const NOW = '2026-10-15 20:00:00';
const ago = (hours: number) => {
  const d = new Date(Date.parse('2026-10-15T20:00:00Z') - hours * 3600_000);
  return d.toISOString().slice(0, 19).replace('T', ' ') + '.000000';
};
let db: string;
let c: Connection;
beforeAll(async () => {
  ({ db, c } = await migratedDb('s12_health'));
});
afterAll(async () => {
  await c.end();
  await dropDb(db);
});
async function clean() {
  await c.query('DELETE FROM check_runs');
  await c.query('DELETE FROM backup_runs');
  await c.query("DELETE FROM settings WHERE setting_key IN ('last_download', 'last_pulled')");
}
const check = (hours: number, ok = 1) => insert(c, 'check_runs', { ran_at: ago(hours), ok, details: { counts: {} } });
const backup = (kind: string, hours: number, ok = 1) => insert(c, 'backup_runs', { ran_at: ago(hours), kind, ok, bytes: 1000 });
const healthy = async () => {
  await clean();
  await check(1);
  await backup('db_dump', 2);
  await backup('photo_copy', 3);
};

describe('constants', () => {
  it('red after 26 hours, and at more than 2 GB of the plan\'s 3 GB (P5, O46)', () => {
    expect(RED_AFTER_HOURS).toBe(26);
    expect(DB_RED_LINE_BYTES).toBe(2 * 1024 * 1024 * 1024);
  });
});

describe('readHealth: the dashboard line', () => {
  it('a new shop that has never run the check or a backup is red, and says so for each', async () => {
    await clean();
    const h = await readHealth(c, { now: NOW });
    expect(h.level).toBe('red');
    expect(h.reasons).toEqual(expect.arrayContaining(['check_never', 'dump_never', 'photo_copy_never']));
    expect(h.check).toEqual({ last_at: null, age_hours: null, ok: null });
    expect(h.db_dump.age_hours).toBeNull();
    expect(h.photo_copy.age_hours).toBeNull();
  });

  it('fresh check, export and photo copy: the ages are exact, nothing is red', async () => {
    await healthy();
    const h = await readHealth(c, { now: NOW });
    expect([h.check.age_hours, h.db_dump.age_hours, h.photo_copy.age_hours]).toEqual([1, 2, 3]);
    expect(h.check.ok).toBe(true);
    expect(h.reasons.filter((r) => r !== 'delete_or_drop_right')).toEqual([]);
    expect(h.level).not.toBe('red');
    expect(h.check.last_at).toBe(ago(1));
  });

  it('each age turns red only ABOVE 26 hours: 26.0 is fine, 26.5 is not', async () => {
    for (const [name, make, reason] of [
      ['check', async (hours: number) => { await healthy(); await clean(); await check(hours); await backup('db_dump', 2); await backup('photo_copy', 3); }, 'check_stale'],
      ['dump', async (hours: number) => { await clean(); await check(1); await backup('db_dump', hours); await backup('photo_copy', 3); }, 'dump_stale'],
      ['photo', async (hours: number) => { await clean(); await check(1); await backup('db_dump', 2); await backup('photo_copy', hours); }, 'photo_copy_stale'],
    ] as const) {
      await make(26);
      expect((await readHealth(c, { now: NOW })).reasons, `${name} at 26.0`).not.toContain(reason);
      await make(26.5);
      const h = await readHealth(c, { now: NOW });
      expect(h.level, `${name} at 26.5`).toBe('red');
      expect(h.reasons, `${name} at 26.5`).toContain(reason);
    }
  });

  it('a failed backup run after a good one does not reset the age: only ok = 1 counts', async () => {
    await healthy();
    await backup('db_dump', 0.5, 0); // a failed export half an hour ago
    await backup('db_dump', 30, 1);
    await c.query("DELETE FROM backup_runs WHERE kind = 'db_dump' AND ok = 1 AND ran_at = ?", [ago(2)]);
    const h = await readHealth(c, { now: NOW });
    expect(h.db_dump.age_hours).toBe(30);
    expect(h.reasons).toContain('dump_stale');
  });

  it('a restore drill is not a backup: kind restore_drill never counts for the export or the photo copy', async () => {
    await clean();
    await check(1);
    await backup('restore_drill', 0.1);
    const h = await readHealth(c, { now: NOW });
    expect(h.db_dump.age_hours).toBeNull();
    expect(h.photo_copy.age_hours).toBeNull();
  });

  it('the last check saying Problem is red at once, even when it ran a minute ago', async () => {
    await healthy();
    await check(0.02, 0);
    const h = await readHealth(c, { now: NOW });
    expect(h.check.ok).toBe(false);
    expect(h.level).toBe('red');
    expect(h.reasons[0]).toBe('check_problem');
    expect(h.reasons).not.toContain('check_stale');
  });

  it('an older failed check does not matter once a newer good one exists', async () => {
    await healthy();
    await check(5, 0);
    expect((await readHealth(c, { now: NOW })).reasons).not.toContain('check_problem');
  });

  it('the size is worked out as P5 says: the other tables after ANALYZE TABLE, plus the live photo bytes, plus 12 percent', async () => {
    await healthy();
    const h = await readHealth(c, { now: NOW });
    expect(h.db_size.injected).toBe(false);
    expect(h.db_size.overhead_percent).toBe(12);
    expect(h.db_size.photo_bytes).toBe(0);
    expect(h.db_size.data_bytes + h.db_size.index_bytes).toBeGreaterThan(100_000);
    expect(h.db_size.bytes).toBe(Math.round((h.db_size.data_bytes + h.db_size.index_bytes + h.db_size.photo_bytes) * 1.12));
    expect(h.db_size.red_line_bytes).toBe(DB_RED_LINE_BYTES);
    expect(h.reasons).not.toContain('db_size');
  });

  it('live photo bytes are counted by SUM(byte_size), which information_schema lags behind (it said 0.0 MB after 65 MB of photos): removed photos count nothing', async () => {
    await healthy();
    const before = await readHealth(c, { now: NOW });
    const design = uuid();
    for (let i = 0; i < 3; i++) {
      const bytes = randomBytes(1_500_000);
      await insert(c, 'design_photos', { id: uuid(), kind: 'full', design_id: design, mime: 'image/jpeg', byte_size: bytes.length, sha256: createHash('sha256').update(bytes).digest(), bytes });
    }
    await insert(c, 'design_photos', { id: uuid(), kind: 'full', design_id: design, mime: 'image/jpeg', byte_size: 1_000_000, sha256: Buffer.alloc(32), bytes: null, removed_at: '2026-10-10 05:00:00.000000' });
    const after = await readHealth(c, { now: NOW });
    expect(after.db_size.photo_bytes).toBe(4_500_000);
    expect(after.db_size.bytes - before.db_size.bytes).toBeGreaterThanOrEqual(Math.round(4_500_000 * 1.12));
    expect(after.db_size.bytes - before.db_size.bytes).toBeLessThan(Math.round(4_500_000 * 1.12) + 600_000); // the other tables barely moved
  });

  it('runs ANALYZE TABLE on every base table except design_photos (whose rows are few and large) before it measures, and not at all with analyze: false', async () => {
    await healthy();
    const seen: string[] = [];
    const spy = new Proxy(c, { get: (t, k) => (k === 'query' ? (sql: any, ...rest: any[]) => { seen.push(String(sql)); return (t as any).query(sql, ...rest); } : (t as any)[k]) }) as Connection;
    await readHealth(spy, { now: NOW });
    const analysed = seen.filter((q) => /^ANALYZE TABLE/i.test(q)).map((q) => q.replace(/^ANALYZE TABLE /i, '').replace(/`/g, ''));
    const [tables] = await c.query<any[]>("SELECT TABLE_NAME AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE'");
    expect([...analysed].sort()).toEqual(tables.map((t) => t.n).filter((n) => n !== 'design_photos').sort());
    seen.length = 0;
    await readHealth(spy, { now: NOW, analyze: false });
    expect(seen.filter((q) => /^ANALYZE/i.test(q))).toEqual([]);
  });

  it('above 2 GB is red; exactly 2 GB is not (an injected size)', async () => {
    await healthy();
    const over = await readHealth(c, { now: NOW, sizeBytes: DB_RED_LINE_BYTES + 1 });
    expect(over.level).toBe('red');
    expect(over.reasons).toContain('db_size');
    expect(over.db_size.injected).toBe(true);
    expect((await readHealth(c, { now: NOW, sizeBytes: DB_RED_LINE_BYTES })).reasons).not.toContain('db_size');
  });

  it('reasons come in dashboard order: check, export, photo copy, size', async () => {
    await clean();
    const h = await readHealth(c, { now: NOW, sizeBytes: DB_RED_LINE_BYTES + 1 });
    const order = ['check_problem', 'check_stale', 'check_never', 'dump_stale', 'dump_never', 'photo_copy_stale', 'photo_copy_never', 'db_size', 'delete_or_drop_right'];
    const idx = h.reasons.map((r) => order.indexOf(r));
    expect(idx.every((i) => i >= 0)).toBe(true);
    expect(idx).toEqual([...idx].sort((a, b) => a - b));
  });

  it('the default "now" is the database\'s own UTC clock', async () => {
    await clean();
    const [[t]] = await c.query<any[][]>('SELECT DATE_FORMAT(UTC_TIMESTAMP(6), "%Y-%m-%d %H:%i:%s.%f") AS t');
    await insert(c, 'check_runs', { ran_at: (t as any).t, ok: 1 });
    const h = await readHealth(c);
    expect(h.check.age_hours).toBeLessThan(0.01);
  });
});

// Draft 5.1 / 5.2 (I12, B3, B2, O53, O54; T-R03, T-R05, T-R06): the owner's monthly download, Harsh's weekly pull and the backup folder's file count. Days are whole Asia/Kolkata calendar dates:
// NOW is 20:00 UTC on 15 Oct, which is 01:30 on 16 Oct in Kolkata, so "today" is 2026-10-16.
describe('readHealth: the download flag, the weekly pull and the folder (draft 5.2)', () => {
  const TODAY = '2026-10-16';
  const dayN = (n: number) => new Date(Date.parse(`${TODAY}T12:00:00Z`) - n * 86400_000).toISOString().slice(0, 10); // the Kolkata date n days ago
  const at = (n: number) => (n === 0 ? ago(1) : `${dayN(n)} 06:00:00.000000`); // 06:00 UTC is 11:30 in Kolkata, the same date; day 0 is an hour ago (00:30 on the 16th in Kolkata)
  const setting = async (key: string, value: unknown | null) => {
    await c.query('DELETE FROM settings WHERE setting_key = ?', [key]);
    if (value !== null) await insert(c, 'settings', { setting_key: key, value });
  };
  const download = async (n: number) => setting('last_download', { at: `${dayN(n)}T06:00:00.000Z`, by: uuid(), counts: { customers: 3 } });
  const pulled = async (n: number) => setting('last_pulled', { at: `${dayN(n)}T06:00:00.000Z`, by: 'admin-cli', file: 'daily/2026-10-01.enc', sha256: 'ab'.repeat(32) });
  const fresh = async () => {
    await healthy();
    await setting('last_download', null);
    await setting('last_pulled', null);
  };
  const level = async (extra: Record<string, unknown> = {}) => readHealth(c, { now: NOW, ...extra });

  it('with no download the days run from the first night the system ran (the oldest check_runs row): day 27 is green, day 28 amber, day 35 amber, day 36 red', async () => {
    const results: Record<number, [string, string[]]> = {};
    for (const n of [0, 27, 28, 35, 36, 60]) {
      await fresh();
      await insert(c, 'check_runs', { ran_at: at(n), ok: 1 }); // the oldest night
      const h = await level();
      results[n] = [h.download.state, h.reasons.filter((r) => r.startsWith('download'))];
      expect(h.download).toMatchObject({ from: 'first_night', age_days: n, reference_date: dayN(n) });
    }
    expect(results[27]).toEqual(['ok', []]);
    expect(results[28]).toEqual(['amber', ['download_amber']]);
    expect(results[35]).toEqual(['amber', ['download_amber']]);
    expect(results[36]).toEqual(['red', ['download_red']]);
    expect(results[60]).toEqual(['red', ['download_red']]);
    expect(results[0]).toEqual(['ok', []]);
  });

  it('with a download the days run from its Kolkata date (settings.last_download.at); a new download clears the flag', async () => {
    await fresh();
    await download(40);
    expect((await level()).download).toMatchObject({ from: 'last_download', age_days: 40, state: 'red', reference_date: dayN(40) });
    await download(0);
    const h = await level();
    expect(h.download).toMatchObject({ from: 'last_download', age_days: 0, state: 'ok' });
    expect(h.reasons.filter((r) => r.startsWith('download'))).toEqual([]);
  });

  it('the day is the Kolkata date of the download, not the UTC date: 18:29 UTC is still the 15th in Kolkata, 18:30 UTC is already the 16th', async () => {
    await fresh();
    await setting('last_download', { at: '2026-10-15T18:29:59.000Z', by: uuid(), counts: {} });
    expect((await level()).download).toMatchObject({ reference_date: '2026-10-15', age_days: 1 });
    await setting('last_download', { at: '2026-10-15T18:30:00.000Z', by: uuid(), counts: {} });
    expect((await level()).download).toMatchObject({ reference_date: '2026-10-16', age_days: 0 });
  });

  it('the level follows: amber alone makes the line amber, red makes it red; before the first night there is no figure and no download reason', async () => {
    await fresh();
    await download(30);
    const amber = await level();
    expect(amber.reasons).toContain('download_amber');
    expect(amber.level).toBe('amber'); // nothing red, so amber (also because the test user holds Delete and Drop)
    await download(36);
    expect((await level()).level).toBe('red');
    await clean();
    await setting('last_download', null);
    const none = await level();
    expect(none.download).toMatchObject({ state: 'unknown', age_days: null, from: null });
    expect(none.reasons.filter((r) => r.startsWith('download'))).toEqual([]);
  });

  it('the weekly pull: amber ABOVE 10 days; with no pull at all the days run from the first export (the oldest good db_dump)', async () => {
    await fresh();
    await pulled(10);
    expect((await level()).pull).toMatchObject({ from: 'last_pulled', age_days: 10, state: 'ok' });
    await pulled(11);
    const h = await level();
    expect(h.pull).toMatchObject({ age_days: 11, state: 'amber' });
    expect(h.reasons).toContain('pulled_amber');
    await pulled(0);
    expect((await level()).reasons).not.toContain('pulled_amber');
    // no pull at all: counted from the first export
    await setting('last_pulled', null);
    await insert(c, 'backup_runs', { ran_at: at(11), kind: 'db_dump', ok: 1, bytes: 1 });
    const none = await level();
    expect(none.pull).toMatchObject({ from: 'first_export', age_days: 11, state: 'amber' });
    expect(none.reasons).toContain('pulled_amber');
    await clean();
    expect((await level()).pull).toMatchObject({ state: 'unknown', from: null, age_days: null });
  });

  it('a failed export is not the first export: only ok = 1 rows count', async () => {
    await fresh();
    await clean();
    await check(1);
    await insert(c, 'backup_runs', { ran_at: at(20), kind: 'db_dump', ok: 0, bytes: 0 });
    await insert(c, 'backup_runs', { ran_at: at(3), kind: 'db_dump', ok: 1, bytes: 1 });
    expect((await level()).pull).toMatchObject({ from: 'first_export', age_days: 3, state: 'ok' });
  });

  it('the backup folder: the figures of the latest good run are shown; red when the file count FALLS without a prune (T-R03), not when it grows or falls by what was pruned', async () => {
    const run = (hours: number, files: number, extra: Record<string, unknown> = {}, kind = 'db_dump') =>
      insert(c, 'backup_runs', { ran_at: ago(hours), kind, ok: 1, bytes: 1, detail: { folder: { files, bytes: files * 1000, free_bytes: 5_000_000_000 }, ...extra } });
    const start = async () => {
      await clean();
      await check(1);
      await backup('photo_copy', 3);
    };
    await start();
    await run(6, 40);
    await run(5, 41);
    await run(4, 42);
    let h = await level();
    expect(h.folder).toMatchObject({ files: 42, previous_files: 41, bytes: 42000, free_bytes: 5_000_000_000, fell: false });
    expect(h.reasons).not.toContain('backup_files_fell');
    await run(3, 38); // later: four files vanished and nothing was pruned
    h = await level();
    expect(h.folder).toMatchObject({ files: 38, previous_files: 42, fell: true });
    expect(h.reasons).toContain('backup_files_fell');
    expect(h.level).toBe('red');
    await start();
    await run(6, 42);
    await run(5, 41, { pruned: 1 }); // one file pruned on purpose: the count fell by exactly what the prune removed
    h = await level();
    expect(h.folder).toMatchObject({ files: 41, previous_files: 42, fell: false });
    expect(h.reasons).not.toContain('backup_files_fell');
    await run(4, 38, { pruned: 1 }); // fell by more than was pruned
    expect((await level()).reasons).toContain('backup_files_fell');
    await start();
    await run(6, 42);
    await run(5, 45); // growth is never a fall
    await run(4, 45, {}, 'photo_copy'); // a photo copy run that also recorded the folder counts too
    h = await level();
    expect(h.folder).toMatchObject({ files: 45, fell: false });
  });

  it('a fall stays red for 7 days (the dashboard may not be looked at the next morning) and then stops being reported; a failed run is not an observation', async () => {
    const run = (hours: number, files: number, ok = 1) =>
      insert(c, 'backup_runs', { ran_at: ago(hours), kind: 'db_dump', ok, bytes: 1, detail: { folder: { files, bytes: 1, free_bytes: 1 } } });
    await clean();
    await check(1);
    await backup('photo_copy', 3);
    await run(130, 42);
    await run(120, 38); // five days ago
    await run(100, 38);
    await run(50, 38);
    await run(5, 38);
    let h = await level();
    expect(h.folder).toMatchObject({ files: 38, previous_files: 38, fell: true, fell_at: ago(120) });
    expect(h.reasons).toContain('backup_files_fell');
    await clean();
    await check(1);
    await backup('photo_copy', 3);
    await run(210, 42);
    await run(192, 38); // eight days ago
    await run(5, 38);
    h = await level();
    expect(h.folder).toMatchObject({ files: 38, fell: false, fell_at: null });
    expect(h.reasons).not.toContain('backup_files_fell');
    await clean();
    await check(1);
    await backup('photo_copy', 3);
    await run(6, 42);
    await run(5, 10, 0); // a failed run says nothing about the folder
    await run(4, 42);
    expect((await level()).folder).toMatchObject({ files: 42, previous_files: 42, fell: false });
  });

  it('with no run that recorded the folder there is no folder figure and no flag', async () => {
    await fresh();
    const h = await level();
    expect(h.folder).toBeNull();
    expect(h.reasons).not.toContain('backup_files_fell');
  });

  it('the dashboard order of the reasons: the check, the export, the photo copy, the folder, the size, the download, the pull, then the rights', async () => {
    await fresh();
    await clean();
    await download(40);
    await pulled(20);
    const h = await level({ sizeBytes: DB_RED_LINE_BYTES + 1 });
    const order = ['check_problem', 'check_stale', 'check_never', 'dump_stale', 'dump_never', 'photo_copy_stale', 'photo_copy_never', 'backup_files_fell', 'db_size', 'download_red', 'download_amber', 'pulled_amber', 'delete_or_drop_right'];
    const idx = h.reasons.map((r) => order.indexOf(r));
    expect(idx.every((i) => i >= 0)).toBe(true);
    expect(idx).toEqual([...idx].sort((a, b) => a - b));
    expect(h.reasons).toEqual(expect.arrayContaining(['download_red', 'pulled_amber', 'db_size']));
  });
});

describe('readHealth: what the database user may do (amber)', () => {
  let limited: Connection;
  let rootC: Connection;
  beforeAll(async () => {
    rootC = await rootConn();
    await rootC.query("CREATE USER IF NOT EXISTS 'jv_limited'@'%' IDENTIFIED BY 'spike_limited_only'");
    await rootC.query(`GRANT SELECT, INSERT, UPDATE, CREATE, ALTER, INDEX, REFERENCES, TRIGGER ON \`${db}\`.* TO 'jv_limited'@'%'`);
    limited = await mysql.createConnection({ host: HOST, port: PORT, user: 'jv_limited', password: 'spike_limited_only', database: db, decimalNumbers: false, supportBigNumbers: true, bigNumberStrings: true, dateStrings: true });
  });
  afterAll(async () => {
    await limited.end();
    await rootC.query("DROP USER IF EXISTS 'jv_limited'@'%'");
    await rootC.end();
  });

  it('a user with ALL PRIVILEGES can delete and drop: amber', async () => {
    await healthy();
    const h = await readHealth(c, { now: NOW });
    expect(h.rights).toMatchObject({ delete: true, drop: true });
    expect(h.level).toBe('amber');
    expect(h.reasons).toEqual(['delete_or_drop_right']);
  });

  it('a user without Delete and Drop (the S7 setting) is green', async () => {
    await healthy();
    const h = await readHealth(limited, { now: NOW });
    expect(h.rights).toMatchObject({ delete: false, drop: false });
    expect(h.level).toBe('green');
    expect(h.reasons).toEqual([]);
  });

  it('rights outside the ten ticked boxes of A3 are listed (T-F08: the start-up check notes them in the log)', async () => {
    await healthy();
    expect((await readHealth(limited, { now: NOW })).rights.extra).toEqual([]); // Select, Insert, Update, Create, Alter, Index, References, Trigger, Create temporary tables, Lock tables
    expect((await readHealth(c, { now: NOW })).rights.extra).toEqual(['ALTER ROUTINE', 'CREATE ROUTINE', 'CREATE VIEW', 'DELETE', 'DROP', 'EVENT', 'EXECUTE', 'SHOW VIEW']);
    await rootC.query(`GRANT EVENT, SHOW VIEW ON \`${db}\`.* TO 'jv_limited'@'%'`);
    expect((await readHealth(limited, { now: NOW })).rights.extra).toEqual(['EVENT', 'SHOW VIEW']);
    await rootC.query(`REVOKE EVENT, SHOW VIEW ON \`${db}\`.* FROM 'jv_limited'@'%'`);
  });

  it('either right alone is enough for amber', async () => {
    await healthy();
    await rootC.query(`GRANT DELETE ON \`${db}\`.* TO 'jv_limited'@'%'`);
    expect((await readHealth(limited, { now: NOW })).rights).toMatchObject({ delete: true, drop: false });
    await rootC.query(`REVOKE DELETE ON \`${db}\`.* FROM 'jv_limited'@'%'`);
    await rootC.query(`GRANT DROP ON \`${db}\`.* TO 'jv_limited'@'%'`);
    expect((await readHealth(limited, { now: NOW })).rights).toMatchObject({ delete: false, drop: true });
    await rootC.query(`REVOKE DROP ON \`${db}\`.* FROM 'jv_limited'@'%'`);
  });

  it('a right on another database does not count; red wins over amber', async () => {
    await clean();
    await rootC.query("GRANT DELETE ON `jv_other_%`.* TO 'jv_limited'@'%'");
    const h = await readHealth(limited, { now: NOW });
    expect(h.rights.delete).toBe(false);
    expect(h.level).toBe('red');
    await rootC.query("REVOKE DELETE ON `jv_other_%`.* FROM 'jv_limited'@'%'");
  });
});
