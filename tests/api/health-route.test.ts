import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClock } from '../../src/clock';
import { DB_RED_LINE_BYTES } from '../../src/reads/health';
import { type CallerName, T0, type World } from './cells';
import { bodyOf, syncWorld } from './sync-support';

// T-D18 (API12; I12, spec section 12): GET /v1/dashboard/health, the dashboard line of the owner in one call. The line itself is readHealth (scripts/health.mjs, MB03/MB05), asked through its twin in
// src/reads/health.ts (tests/api/health-twin.test.ts keeps the two equal); the route repeats its figures and reasons and adds nothing of its own. The API's clock is "now" (S5): 17 Oct 2026 10:00 UTC.

let world: World;
let root: Awaited<ReturnType<World['scratch']['root']>>;
const time = { micros: T0 };

beforeAll(async () => {
  ({ world } = await syncWorld('hlthrt', { clock: createClock(() => time.micros) }));
  root = await world.scratch.root();
}, 120_000);
afterAll(async () => {
  await root?.end();
  await world?.close();
});

const get = (caller: CallerName, url = '/v1/dashboard/health') => world.call(caller, 'GET', url);
const errorOf = (res: { body: string }) => (JSON.parse(res.body) as { error?: { code: string } }).error;
const line = async () => {
  const res = await get('owner');
  expect(res.statusCode, res.body.slice(0, 300)).toBe(200);
  return bodyOf<any>(res);
};
const clean = async () => {
  await root.query(`DELETE FROM \`${world.scratch.database}\`.check_runs`);
  await root.query(`DELETE FROM \`${world.scratch.database}\`.backup_runs`);
  await root.query(`DELETE FROM \`${world.scratch.database}\`.settings WHERE setting_key IN ('last_download', 'last_pulled')`);
};
const check = (at: string, ok: number) => world.sql.query('INSERT INTO check_runs (ran_at, ok, details) VALUES (?, ?, ?)', [at, ok, JSON.stringify({ invariants: [] })]);
const backup = (at: string, kind: string, detail: unknown) => world.sql.query('INSERT INTO backup_runs (ran_at, kind, ok, bytes, detail) VALUES (?, ?, 1, 1000, ?)', [at, kind, JSON.stringify(detail)]);
const setting = (key: string, at: string) => world.sql.query('INSERT INTO settings (setting_key, value) VALUES (?, ?)', [key, JSON.stringify({ at })]);
const healthy = async () => {
  await clean();
  await check('2026-10-17 08:30:00.000000', 1);
  await backup('2026-10-17 07:00:00.000000', 'db_dump', { folder: { files: 6, bytes: 6000, free_bytes: 5000000 } });
  await backup('2026-10-17 07:10:00.000000', 'photo_copy', { folder: { files: 7, bytes: 7000, free_bytes: 4999000 } });
  await setting('last_download', '2026-10-12T05:00:00.000Z');
  await setting('last_pulled', '2026-10-15T05:00:00.000Z');
};

describe('T-D18 GET /v1/dashboard/health: the owner\'s line in one call', () => {
  it('a new shop that has never run the check or a backup is red, and says so for each: nothing is made up', async () => {
    await clean();
    const h = await line();
    expect(h).toMatchObject({
      level: 'red',
      reasons: ['check_never', 'dump_never', 'photo_copy_never'],
      check: { last_at: null, age_hours: null, ok: null },
      db_dump: { last_at: null, age_hours: null },
      photo_copy: { last_at: null, age_hours: null },
      folder: null,
      download: { state: 'unknown', from: null, reference_date: null, age_days: null },
      pull: { state: 'unknown', from: null, reference_date: null, age_days: null },
      rights: { delete: false, drop: false, extra: [] },
      now: expect.stringMatching(/^2026-10-17T10:00:00\.\d{6}Z$/), // the API's clock; it never gives the same instant twice, so the last microseconds move
    });
  });

  it('a healthy day: the ages from the API\'s clock, the instants on the wire format, the folder, the download and the pull, the size against the red line, green', async () => {
    await healthy();
    const h = await line();
    expect(h).toMatchObject({
      level: 'green',
      reasons: [],
      check: { last_at: '2026-10-17T08:30:00.000000Z', age_hours: 1.5, ok: true },
      db_dump: { last_at: '2026-10-17T07:00:00.000000Z', age_hours: 3 },
      photo_copy: { last_at: '2026-10-17T07:10:00.000000Z', age_hours: 2.83 },
      folder: { files: 7, bytes: 7000, free_bytes: 4999000, previous_files: 6, recorded_at: '2026-10-17T07:10:00.000000Z', fell: false, fell_at: null },
      download: { state: 'ok', from: 'last_download', reference_date: '2026-10-12', age_days: 5 },
      pull: { state: 'ok', from: 'last_pulled', reference_date: '2026-10-15', age_days: 2 },
      rights: { delete: false, drop: false, extra: [] },
      now: expect.stringMatching(/^2026-10-17T10:00:00\.\d{6}Z$/), // the API's clock; it never gives the same instant twice, so the last microseconds move
    });
    expect(h.db_size.injected).toBe(false);
    expect(h.db_size.red_line_bytes).toBe(DB_RED_LINE_BYTES);
    expect(h.db_size.bytes).toBeGreaterThan(0);
    expect(h.db_size.bytes).toBeLessThan(DB_RED_LINE_BYTES);
    expect(Object.keys(h).sort()).toEqual(['check', 'db_dump', 'db_size', 'download', 'folder', 'level', 'now', 'photo_copy', 'pull', 'reasons', 'rights'].sort());
  });

  it('a check that says Problem turns it red', async () => {
    await healthy();
    await check('2026-10-17 09:00:00.000000', 0);
    const h = await line();
    expect([h.level, h.reasons, h.check.ok]).toEqual(['red', ['check_problem'], false]);
  });

  it('older than 26 hours is red for the check, the export and the photo copy; the age comes from the clock, so moving the clock moves it', async () => {
    await healthy();
    time.micros = T0 + 2n * 3_600_000_000n; // 12:00 UTC: the check is 3.5 h old, the export 5 h, the photo copy 4.83 h
    expect((await line()).level).toBe('green');
    await clean();
    await check('2026-10-16 05:00:00.000000', 1); // 29 hours before 10:00
    await backup('2026-10-16 05:00:00.000000', 'db_dump', { folder: { files: 1 } });
    await backup('2026-10-16 05:00:00.000000', 'photo_copy', { folder: { files: 1 } });
    time.micros = T0;
    const h = await line();
    expect(h.level).toBe('red');
    expect(h.reasons).toEqual(['check_stale', 'dump_stale', 'photo_copy_stale']);
  });

  it('a Delete right on the database user turns the line amber (S11, I12); taking it away turns it back', async () => {
    await healthy();
    const grant = `\`${world.scratch.database}\`.*`;
    await root.query(`GRANT DELETE ON ${grant} TO ?@'%'`, [world.scratch.user]);
    try {
      const h = await line();
      expect([h.level, h.reasons, h.rights.delete]).toEqual(['amber', ['delete_or_drop_right'], true]);
    } finally {
      await root.query(`REVOKE DELETE ON ${grant} FROM ?@'%'`, [world.scratch.user]);
    }
    expect((await line()).level).toBe('green');
  });

  it('the owner alone: a biller and staff are 403 JV_FORBIDDEN, no session is 401; and nothing is read for them', async () => {
    const before = world.spy.sent.length;
    for (const caller of ['biller', 'staff'] as const) {
      const res = await get(caller);
      expect([res.statusCode, errorOf(res)?.code], caller).toEqual([403, 'JV_FORBIDDEN']);
    }
    expect((await get('anon')).statusCode).toBe(401);
    expect(world.spy.sqls().slice(before).filter((s) => /check_runs|backup_runs|SHOW GRANTS|ANALYZE/i.test(s))).toEqual([]);
  });

  it('it takes no input: any query key is 422', async () => {
    for (const q of ['?limit=5', '?now=2026-01-01', '?analyze=false']) {
      const res = await get('owner', `/v1/dashboard/health${q}`);
      expect([res.statusCode, errorOf(res)?.code], q).toEqual([422, 'JV_INVALID_INPUT']);
    }
  });

  it('it only reads: the statements of the call are selects, SHOW GRANTS and the ANALYZE TABLE of the size (P5), on one connection from the pool', async () => {
    await healthy();
    const before = world.spy.sent.length;
    await line();
    const sqls = world.spy.sqls().slice(before);
    const mine = sqls.filter((s) => !/\b(users|sessions)\b/i.test(s) || /information_schema/i.test(s)).filter((s) => !/^SET SESSION/i.test(s));
    expect(mine.length).toBeGreaterThan(5);
    for (const s of mine) expect(s, s.slice(0, 60)).toMatch(/^\s*(SELECT|SHOW GRANTS|ANALYZE TABLE)\b/i);
    expect(mine.some((s) => /ANALYZE TABLE/i.test(s))).toBe(true);
  });
});
