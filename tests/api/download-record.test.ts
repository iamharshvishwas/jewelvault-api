import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../../scripts/migrate.mjs';
import { createClock, formatTimestamp } from '../../src/clock';
import { MATRIX } from '../../src/permissions/matrix';
import { V, insert, ledgerWorld } from '../schema/support';
import { type CallerName, T0, type World, checkCell, makeWorld } from './cells';
import { type Counts, DAY, HOUR, MINUTE, SECOND, ZIP_FILES, ageEverything, dbCounts, dropSetting, isoAt, putSetting, resetHealth } from './download-support';
import { REPO } from './support';
import { bodyOf } from './sync-support';

// T-R05 (API35; B3, I12, O53): Download everything and its record. The zip itself is built in the browser (WEB12b) and its contents are a drill (OPS05, scripts/zip-balances.mjs, tests/api/zip-balances.test.ts);
// what the server owns is
//   1. POST /v1/owner/download-record: the screen sends the date and the row count of every file; the API accepts them only if every count equals the database's count of that table, give or take
//      the rows made in the last two minutes, and stores {at, by, counts} in settings.last_download, with exactly one audit row (L1); counts that do not match are JV_INVALID_INPUT and change nothing;
//   2. the figures: the dashboard card and the health line count whole Asia/Kolkata days from settings.last_download, or from the oldest check_runs row when there is none; amber at 28 or more,
//      red at more than 35 (36 or more).
// The API's clock is "now" (S5): 17 Oct 2026 10:00 UTC, which is 15:30 on 17 Oct in India. The audit triggers of db/optional are installed, as on the plan (L1 mechanism (a)): a call that writes
// a setting leaves one row from the trigger, and the route writes no event row of its own (that would be a second row for one change).

const URL = '/v1/owner/download-record';
const time = { micros: T0 };
const clock = createClock(() => time.micros);

let world: World;
let root: Awaited<ReturnType<World['scratch']['root']>>;
let ownerId: string;

beforeAll(async () => {
  world = await makeWorld({ label: 'dlrec', routes: true, clock });
  root = await world.scratch.root();
  await migrate(world.sql, { seeds: true, optional: true });
  await ledgerWorld(world.sql);
  await insert(world.sql, 'daily_rates', V.dailyRate());
  ownerId = world.fixtures.owner.userId;
}, 120_000);
afterAll(async () => {
  await root?.end();
  await world?.close();
});
beforeEach(async () => {
  await ageEverything(world.sql);
  await dropSetting(root, world, 'last_download');
  await dropSetting(root, world, 'last_pulled');
});

const today = () => clock.read().date;
const record = (payload: unknown, caller: CallerName = 'owner') => world.call(caller, 'POST', URL, { payload });
const errorOf = (res: LightMyRequestResponse) => (JSON.parse(res.body) as { error?: { code: string; message: string; details: Record<string, unknown> } }).error;
const stored = async (): Promise<{ value: any; updated_by: string | null } | null> => {
  const [rows] = await world.sql.query<any[]>("SELECT value, updated_by FROM settings WHERE setting_key = 'last_download'");
  if (rows.length === 0) return null;
  const v = rows[0].value;
  return { value: typeof v === 'string' ? JSON.parse(v) : v, updated_by: rows[0].updated_by };
};
const auditCount = async () => Number((await world.sql.query<any[]>('SELECT COUNT(*) AS n FROM audit_log'))[0][0].n);
const settingsRows = async () => JSON.stringify((await world.sql.query<any[]>('SELECT setting_key, value, updated_by, updated_at FROM settings ORDER BY setting_key'))[0]);
const body = (counts: Counts, date = today()) => ({ date, counts });

/** Everything a refused call must leave as it found it. */
const snapshot = async () => ({ settings: await settingsRows(), audit: await auditCount() });

describe('T-R05 POST /v1/owner/download-record: matching counts are stored as settings.last_download, with one audit row', () => {
  it('accepts the counts the database has: 200, and settings.last_download = {at, by, counts} with `at` from the API clock and `by` the owner', async () => {
    expect(await stored()).toBeNull();
    const counts = await dbCounts(world.sql);
    const auditBefore = await auditCount();
    const res = await record(body(counts));
    expect(res.statusCode, res.body).toBe(200);
    const row = await stored();
    expect(row?.value).toEqual({ at: expect.stringMatching(/^2026-10-17T10:00:00\.\d{3}Z$/), by: ownerId, counts });
    expect(Math.abs(Date.parse(row!.value.at) - Number(T0 / 1000n))).toBeLessThan(5000); // the API's clock, not the client's and not the database's
    expect(row?.updated_by).toBe(ownerId);
    expect(bodyOf<any>(res)).toEqual({ last_download: row?.value });
    expect(await auditCount()).toBe(auditBefore + 1); // exactly one audit row (L1)
  });
});

// L1 has two mechanisms and a change is audited by exactly one of them: the generated triggers (a, the default) or the Node writer of API15 (b, JV_AUDIT_MODE=node, on a database without the
// triggers). T-D14: the record leaves exactly one audit row, and the same row, in both.
const auditRowKeys: Record<string, string[]> = {};
describe.each(['triggers', 'node'] as const)('T-R05 (T-D14 clause) the record leaves exactly one audit row, mechanism %s of L1', (mode) => {
  let w: World;
  let auditClock: ReturnType<typeof createClock>;
  const t = { micros: T0 };
  beforeAll(async () => {
    auditClock = createClock(() => t.micros);
    w = await makeWorld({ label: mode === 'triggers' ? 'dlaudt' : 'dlaudn', routes: true, clock: auditClock, config: mode === 'node' ? { auditMode: 'node' } : {} });
    await migrate(w.sql, { seeds: true, optional: mode === 'triggers' });
  }, 120_000);
  afterAll(async () => {
    await w?.close();
  });
  const post = (payload: unknown) => w.call('owner', 'POST', URL, { payload });
  const counts = () => dbCounts(w.sql);
  const rowsAfter = async (id: number) => (await w.sql.query<any[]>('SELECT actor, actor_role, request_id, table_name, row_id, action, old_row, new_row FROM audit_log WHERE id > ? ORDER BY id', [id]))[0];
  const lastId = async () => Number((await w.sql.query<any[]>('SELECT COALESCE(MAX(id), 0) AS m FROM audit_log'))[0][0].m);
  const json = (v: unknown) => (typeof v === 'string' ? JSON.parse(v) : v) as any;

  it('the first download: one row, a settings insert by the owner holding the new value; no event row of the route\'s own', async () => {
    const before = await lastId();
    const res = await post({ date: auditClock.read().date, counts: await counts() });
    expect(res.statusCode, res.body).toBe(200);
    const rows = await rowsAfter(before);
    expect(rows).toHaveLength(1);
    const ownerOfW = w.fixtures.owner.userId;
    expect(rows[0]).toMatchObject({ actor: ownerOfW, actor_role: 'owner', table_name: 'settings', row_id: 'last_download', action: 'insert', request_id: res.headers['x-request-id'] });
    expect(rows[0].old_row).toBeNull();
    const newRow = json(rows[0].new_row);
    expect(newRow.setting_key).toBe('last_download');
    expect(json(newRow.value)).toEqual({ at: expect.any(String), by: ownerOfW, counts: expect.objectContaining({ customers: expect.any(Number), users: expect.any(Number) }) });
    expect(newRow.updated_by).toBe(ownerOfW);
    auditRowKeys[mode] = Object.keys(newRow).sort();
  });

  it('a second download: again exactly one row, an update that holds the old value and the new one', async () => {
    const first = json((await w.sql.query<any[]>("SELECT value FROM settings WHERE setting_key = 'last_download'"))[0][0].value);
    t.micros += 2n * MINUTE;
    const before = await lastId();
    const res = await post({ date: auditClock.read().date, counts: await counts() });
    expect(res.statusCode, res.body).toBe(200);
    const rows = await rowsAfter(before);
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe('update');
    expect(json(json(rows[0].old_row).value).at).toBe(first.at);
    expect(json(json(rows[0].new_row).value).at).not.toBe(first.at);
  });

  it('a refused record leaves no audit row and no row of settings changed', async () => {
    const before = await lastId();
    const stored = JSON.stringify((await w.sql.query<any[]>("SELECT value, updated_at FROM settings WHERE setting_key = 'last_download'"))[0]);
    const wrong = await counts();
    const res = await post({ date: auditClock.read().date, counts: { ...wrong, bills: wrong.bills + 5 } });
    expect(res.statusCode).toBe(422);
    expect(await rowsAfter(before)).toHaveLength(0);
    expect(JSON.stringify((await w.sql.query<any[]>("SELECT value, updated_at FROM settings WHERE setting_key = 'last_download'"))[0])).toBe(stored);
  });

  it.runIf(mode === 'node')('the Node writer writes the row the trigger writes: the same columns, in the same order', () => {
    expect(auditRowKeys.node).toBeDefined();
    expect(auditRowKeys.triggers).toBeDefined(); // (the triggers world ran first)
    expect(auditRowKeys.node).toEqual(auditRowKeys.triggers);
  });
});

describe('T-R05 the record refuses a zip that is not the books: JV_INVALID_INPUT, and nothing changes', () => {
  it('an empty zip (no counts) and each missing file are refused, naming the file', async () => {
    const counts = await dbCounts(world.sql);
    const before = await snapshot();
    const empty = await record(body({} as Counts));
    expect(empty.statusCode).toBe(422);
    expect(errorOf(empty)?.code).toBe('JV_INVALID_INPUT');
    for (const file of ZIP_FILES) {
      const { [file]: _missing, ...rest } = counts;
      const res = await record(body(rest as Counts));
      expect(res.statusCode, `without ${file}`).toBe(422);
      expect(errorOf(res)?.code, `without ${file}`).toBe('JV_INVALID_INPUT');
      expect(errorOf(res)?.details, `without ${file}`).toEqual({ field: `counts.${file}` });
    }
    expect(await snapshot()).toEqual(before);
  });

  it('a file that holds no rows although the table does, and a count above or below, are refused, naming the file; the message repeats no number', async () => {
    const counts = await dbCounts(world.sql);
    const before = await snapshot();
    for (const file of ZIP_FILES) {
      for (const wrong of [0, counts[file] - 1, counts[file] + 1, counts[file] + 1000]) {
        if (wrong === counts[file] || wrong < 0) continue;
        const res = await record(body({ ...counts, [file]: wrong }));
        expect(res.statusCode, `${file}=${wrong}`).toBe(422);
        expect(errorOf(res)?.code, `${file}=${wrong}`).toBe('JV_INVALID_INPUT');
        expect(errorOf(res)?.details, `${file}=${wrong}`).toEqual({ field: `counts.${file}` });
        expect(errorOf(res)?.message, `${file}=${wrong}`).not.toMatch(/\d/);
      }
    }
    const all = Object.fromEntries(ZIP_FILES.map((f) => [f, 0])) as Counts;
    const zeros = await record(body(all));
    expect(zeros.statusCode).toBe(422);
    expect(await snapshot()).toEqual(before);
  });

  it('a refusal after an earlier download leaves that download as it was', async () => {
    const counts = await dbCounts(world.sql);
    expect((await record(body(counts))).statusCode).toBe(200);
    const kept = await snapshot();
    time.micros += 5n * MINUTE;
    expect((await record(body({ ...counts, bills: counts.bills + 1 }))).statusCode).toBe(422);
    expect(await snapshot()).toEqual(kept);
  });
});

describe('T-R05 "give or take the rows made in the last two minutes" (the cache is up to one poll behind)', () => {
  const addCustomers = async (n: number, agoMicros: bigint) => {
    for (let i = 0; i < n; i++) await insert(world.sql, 'customers', V.customer({ created_at: formatTimestamp(time.micros - agoMicros) }));
  };

  it('each row made in the last two minutes lets the count of its file be off by one, either way; a row made earlier does not', async () => {
    await addCustomers(2, 90n * SECOND); // inside the window
    await addCustomers(1, 150n * SECOND); // outside it
    const counts = await dbCounts(world.sql);
    const before = await snapshot();
    for (const off of [3, -3]) expect((await record(body({ ...counts, customers: counts.customers + off }))).statusCode, `customers ${off}`).toBe(422);
    expect(await snapshot()).toEqual(before);
    for (const off of [-2, 2, 0, -1]) {
      time.micros += SECOND;
      expect((await record(body({ ...counts, customers: counts.customers + off }))).statusCode, `customers ${off}`).toBe(200);
    }
    // the allowance belongs to the file whose table has the new rows: bills have none, so one more or less is refused
    expect((await record(body({ ...counts, bills: counts.bills + 1 }))).statusCode).toBe(422);
    expect((await record(body({ ...counts, bills: counts.bills - 1 }))).statusCode).toBe(422);
  });

  it('the window is two minutes of the API\'s clock: a row 119 seconds old counts, one 121 seconds old does not', async () => {
    await addCustomers(1, 119n * SECOND);
    let counts = await dbCounts(world.sql);
    expect((await record(body({ ...counts, customers: counts.customers - 1 }))).statusCode).toBe(200);
    await ageEverything(world.sql);
    await addCustomers(1, 121n * SECOND);
    counts = await dbCounts(world.sql);
    expect((await record(body({ ...counts, customers: counts.customers - 1 }))).statusCode).toBe(422);
  });
});

describe('T-R05 the date of the zip, and what the client may not say', () => {
  it('the date is today\'s or yesterday\'s business date in India (a zip built before midnight may be recorded just after); an older, a later or a malformed date is refused', async () => {
    const counts = await dbCounts(world.sql);
    expect(today()).toBe('2026-10-17');
    for (const date of ['2026-10-17', '2026-10-16']) expect((await record(body(counts, date))).statusCode, date).toBe(200);
    const before = await snapshot();
    for (const date of ['2026-10-15', '2026-10-18', '2025-10-17', '2026-02-30', '17-10-2026', '', 'today']) {
      const res = await record(body(counts, date));
      expect(res.statusCode, date).toBe(422);
      expect(errorOf(res)?.details, date).toEqual({ field: 'date' });
    }
    const noDate = await record({ counts });
    expect(noDate.statusCode).toBe(422);
    expect(errorOf(noDate)?.details).toEqual({ field: 'date' });
    expect(await snapshot()).toEqual(before);
  });

  it('the screen cannot choose `at` or `by`, add a file the zip does not have, or send a count that is not a whole number; the body must be an object', async () => {
    const counts = await dbCounts(world.sql);
    const before = await snapshot();
    const bad: [string, unknown, string][] = [
      ['at', { ...body(counts), at: '2020-01-01T00:00:00.000Z' }, 'at'],
      ['by', { ...body(counts), by: 'someone' }, 'by'],
      ['counts.at', { ...body(counts), counts: { ...counts, at: 1 } }, 'counts.at'],
      ['a file the zip does not have', { ...body(counts), counts: { ...counts, audit_log: 5 } }, 'counts.audit_log'],
      ['sku_private', { ...body(counts), counts: { ...counts, sku_private: 5 } }, 'counts.sku_private'],
      ['a count as text', { ...body(counts), counts: { ...counts, bills: String(counts.bills) } }, 'counts.bills'],
      ['a negative count', { ...body(counts), counts: { ...counts, bills: -1 } }, 'counts.bills'],
      ['a fraction', { ...body(counts), counts: { ...counts, bills: counts.bills + 0.5 } }, 'counts.bills'],
      ['a count of ten billion', { ...body(counts), counts: { ...counts, bills: 10_000_000_000 } }, 'counts.bills'],
      ['null', { ...body(counts), counts: { ...counts, bills: null } }, 'counts.bills'],
      ['counts as a list', { ...body(counts), counts: [1, 2, 3] }, 'counts'],
      ['no counts', { date: today() }, 'counts'],
    ];
    for (const [name, payload, field] of bad) {
      const res = await record(payload);
      expect(res.statusCode, name).toBe(422);
      expect(errorOf(res)?.code, name).toBe('JV_INVALID_INPUT');
      expect(errorOf(res)?.details, name).toEqual({ field });
    }
    const noBody = await world.call('owner', 'POST', URL);
    expect(noBody.statusCode).toBe(422);
    const list = await record([1, 2]);
    expect(list.statusCode).toBe(422);
    expect(await snapshot()).toEqual(before);
  });
});

describe('T-R05 only the owner records a download', () => {
  it('`last_download` is written by the record route and by nothing else in src/ (B3, A4: the generic settings edit never writes it, so it cannot be set around the check, RF5-17)', () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.ts$/.test(name)) files.push(p);
      }
    };
    walk(join(REPO, 'src'));
    const writers = files.filter((f) => {
      const text = readFileSync(f, 'utf8');
      return /(INSERT\s+INTO|UPDATE)\s+settings\b/i.test(text) && /last_download/.test(text);
    });
    expect(writers.map((f) => relative(REPO, f))).toEqual(['src/download/record.ts']);
    expect(world.app.routeTable.filter((r) => r.action === 'owner:download_record')).toHaveLength(1);
  });

  it('the row of the matrix lets the owner in and nobody else', () => {
    expect(MATRIX['owner:download_record']).toMatchObject({ method: 'POST', path: URL, roles: ['owner'] });
  });

  it('the generic settings edit cannot write `last_download`, not even for the owner, not to make a first one and not to change a recorded one (RF5-17): 403 JV_FORBIDDEN, and the books are as they were', async () => {
    const value = { at: '2020-01-01T00:00:00.000Z', by: ownerId, counts: await dbCounts(world.sql) };
    for (const recorded of [false, true]) {
      if (recorded) expect((await record(body(await dbCounts(world.sql)))).statusCode).toBe(200);
      const before = await snapshot();
      const res = await world.call('owner', 'PUT', '/v1/settings/last_download', { payload: { value } });
      expect(res.statusCode, `recorded=${recorded}: ${res.body.slice(0, 200)}`).toBe(403);
      expect(errorOf(res)?.code).toBe('JV_FORBIDDEN');
      // another spelling of the key is the same row in the database (its collation ignores case and trailing spaces), so it must not get through either
      for (const key of ['Last_Download', 'LAST_DOWNLOAD', 'last_download%20']) {
        const other = await world.call('owner', 'PUT', `/v1/settings/${key}`, { payload: { value } });
        expect(other.statusCode, `${key}: ${other.body.slice(0, 200)}`).toBeGreaterThanOrEqual(400);
      }
      expect(await snapshot()).toEqual(before);
    }
  });

  it('every other caller is refused with a good body, the handler never runs, and nothing changes', async () => {
    const counts = await dbCounts(world.sql);
    const before = await snapshot();
    const row = MATRIX['owner:download_record'];
    for (const caller of ['anon', 'ended', 'expired', 'idle', 'inactive', 'must_change', 'staff', 'biller'] as const) {
      const problem = await checkCell(world, { action: 'owner:download_record', method: row.method, path: row.path, roles: row.roles, mustChange: row.mustChange, payload: body(counts) }, caller);
      expect(problem, caller).toBeNull();
      const res = await record(body(counts), caller);
      expect([401, 403], caller).toContain(res.statusCode);
    }
    expect(await snapshot()).toEqual(before);
  });
});

// ------------------------------------------------------------------ the figures: whole Asia/Kolkata days, amber at 28, red above 35

describe('T-R05 the dashboard line counts whole Asia/Kolkata days from the last download: day 27 is green, 28 and 35 are amber, 36 is red', () => {
  const line = async () => {
    const res = await world.call('owner', 'GET', '/v1/dashboard/health');
    expect(res.statusCode, res.body.slice(0, 300)).toBe(200);
    return bodyOf<any>(res);
  };
  const withDownloadDaysAgo = async (days: number) => {
    await resetHealth(world, root, time.micros);
    await dropSetting(root, world, 'last_download');
    await putSetting(world.sql, 'last_download', time.micros - BigInt(days) * DAY);
  };

  it.each([
    [0, 'ok', 'green', []],
    [27, 'ok', 'green', []],
    [28, 'amber', 'amber', ['download_amber']],
    [35, 'amber', 'amber', ['download_amber']],
    [36, 'red', 'red', ['download_red']],
    [90, 'red', 'red', ['download_red']],
  ] as const)('a download %i days ago: the figure is %s, the line is %s, the reasons are %j', async (days, state, level, reasons) => {
    await withDownloadDaysAgo(days);
    const h = await line();
    expect(h.download).toMatchObject({ state, from: 'last_download', age_days: days });
    expect(h.reasons).toEqual(reasons);
    expect(h.level).toBe(level);
  });

  it('the days are Asia/Kolkata calendar dates, not periods of 24 hours: a download at 23:59 in India is one day old two minutes later', async () => {
    // now is 17 Oct 15:30 in India. A download on the evening of 19 Sep (18:29:59 UTC is 23:59:59 in India) is on the 19th: 28 days, amber, although 27 days and 15 hours have passed.
    await resetHealth(world, root, time.micros);
    await putSetting(world.sql, 'last_download', BigInt(Date.UTC(2026, 8, 19, 18, 29, 59)) * 1000n);
    let h = await line();
    expect(h.download).toMatchObject({ reference_date: '2026-09-19', age_days: 28, state: 'amber' });
    // one second later it is the 20th in India: 27 days, green
    await dropSetting(root, world, 'last_download');
    await putSetting(world.sql, 'last_download', BigInt(Date.UTC(2026, 8, 19, 18, 30, 0)) * 1000n);
    h = await line();
    expect(h.download).toMatchObject({ reference_date: '2026-09-20', age_days: 27, state: 'ok' });
  });

  it.each([
    [0, 'ok', 'green', []],
    [27, 'ok', 'green', []],
    [28, 'amber', 'amber', ['download_amber']],
    [35, 'amber', 'amber', ['download_amber']],
    [36, 'red', 'red', ['download_red']],
  ] as const)('no download at all: the same counts run from the first night the system ran (%i days ago): %s, %s, %j', async (days, state, level, reasons) => {
    await dropSetting(root, world, 'last_download');
    await resetHealth(world, root, time.micros, { firstNightAt: time.micros - BigInt(days) * DAY });
    // a newer check does not move the reference: the oldest row does
    const h = await line();
    expect(h.download).toMatchObject({ state, from: 'first_night', age_days: days });
    expect(h.reasons).toEqual(reasons);
    expect(h.level).toBe(level);
  });

  it('a shop that has never run a check has no figure to count from: `unknown`, nothing is made up', async () => {
    const db = `\`${world.scratch.database}\``;
    await root.query(`DELETE FROM ${db}.check_runs`);
    await dropSetting(root, world, 'last_download');
    const h = await line();
    expect(h.download).toEqual({ state: 'unknown', from: null, reference_date: null, age_days: null });
    expect(h.reasons).toContain('check_never');
    expect(h.reasons).not.toContain('download_red');
  });

  // The clock only moves forward (S5), so this one goes last: the sessions of the fixture are renewed by hand at each new instant.
  it('end to end: a recorded download clears the figure, ages through 27, 28, 35 and 36 days with the API\'s clock, and a new download clears both the amber and the red', async () => {
    await dropSetting(root, world, 'last_download');
    const keepSignedIn = () =>
      world.sql.query('UPDATE sessions SET last_seen_at = ?, expires_at = ?, created_at = ? WHERE id = ?', [
        formatTimestamp(time.micros),
        formatTimestamp(time.micros + 14n * DAY),
        formatTimestamp(time.micros - HOUR),
        world.fixtures.owner.sessionId,
      ]);
    const move = async (to: bigint) => {
      time.micros = to;
      await keepSignedIn();
      await resetHealth(world, root, time.micros);
    };
    const start = time.micros;
    await resetHealth(world, root, start);
    // (the first night is long ago: without a download the line would already be red)
    await root.query(`DELETE FROM \`${world.scratch.database}\`.check_runs`);
    await world.sql.query('INSERT INTO check_runs (ran_at, ok, details) VALUES (?, 1, ?)', [formatTimestamp(start - 50n * DAY), JSON.stringify({ invariants: [] })]);
    await world.sql.query('INSERT INTO check_runs (ran_at, ok, details) VALUES (?, 1, ?)', [formatTimestamp(start - HOUR), JSON.stringify({ invariants: [] })]);
    let h = await line();
    expect(h.download).toMatchObject({ state: 'red', from: 'first_night', age_days: 50 });

    expect((await record(body(await dbCounts(world.sql)))).statusCode).toBe(200);
    h = await line();
    expect(h.download).toMatchObject({ state: 'ok', from: 'last_download', age_days: 0 });
    expect(h.level).toBe('green');

    const recordedAt = time.micros;
    for (const [days, state, reasons] of [
      [27, 'ok', []],
      [28, 'amber', ['download_amber']],
      [35, 'amber', ['download_amber']],
      [36, 'red', ['download_red']],
    ] as const) {
      await move(recordedAt + BigInt(days) * DAY);
      h = await line();
      expect(h.download, `day ${days}`).toMatchObject({ state, from: 'last_download', age_days: days });
      expect(h.reasons, `day ${days}`).toEqual(reasons);
    }
    // day 36 is red; a new download clears it
    const res = await record(body(await dbCounts(world.sql)));
    expect(res.statusCode, res.body).toBe(200);
    h = await line();
    expect(h.download).toMatchObject({ state: 'ok', from: 'last_download', age_days: 0 });
    expect(h.reasons).toEqual([]);
    expect(h.level).toBe('green');
    expect(isoAt(time.micros)).toMatch(/^2026-11-22T/);
  });
});
