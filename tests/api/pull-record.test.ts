import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../../scripts/migrate.mjs';
import { createClock, formatTimestamp } from '../../src/clock';
import { NEVER_WRITTEN_SETTINGS } from '../../src/permissions/matrix';
import { T0, type World, makeWorld } from './cells';
import { DAY, HOUR, dropSetting, putSetting, resetHealth } from './download-support';
import { bodyOf } from './sync-support';

// T-R06 (API35; O54, B2, I12): the weekly pull. Harsh's Mac pulls the newest encrypted export (scripts/restore-cli.mjs pull, API36) and reports each pull through the admin door
// (POST /admin/v1/backup-pulls, API09, which writes settings.last_pulled). What API35 proves is the server side around it:
//   * the admin door records a pull, audited as admin-cli, and no other caller can (a session, even the owner's, is no token);
//   * the generic settings edit never writes `last_pulled` (or `last_download`): NEVER_WRITTEN_SETTINGS of the permission matrix is the list the edit of API13b reads;
//   * the dashboard line shows "last pulled" and turns amber when MORE THAN 10 whole Asia/Kolkata days have passed since the pull (section 12: "more than 10 days"), and with no pull at all
//     the same count runs from the first good export.
// The sha256 check of the pulled files against backup_runs.detail and sys_photo_copies, the SFTP path and the key holder's decryption are the tool's (tests/api/restore-cli.test.ts) and the
// drill's (OPS05).

const TOKEN = randomBytes(32).toString('base64url');
const HASH = createHash('sha256').update(TOKEN).digest('hex');
const time = { micros: T0 };
const clock = createClock(() => time.micros);

let world: World;
let root: Awaited<ReturnType<World['scratch']['root']>>;
let addresses = 0;

beforeAll(async () => {
  world = await makeWorld({ label: 'pullrec', routes: true, clock, config: { adminTokenHash: HASH } });
  root = await world.scratch.root();
  await migrate(world.sql, { seeds: true, optional: true });
}, 120_000);
afterAll(async () => {
  await root?.end();
  await world?.close();
});
beforeEach(async () => {
  await dropSetting(root, world, 'last_pulled');
  await dropSetting(root, world, 'last_download');
});

// every call from its own address: the door throttles per address and the clock stands still
const freshIp = () => `198.19.${Math.floor(++addresses / 250)}.${(addresses % 250) + 1}`;
const sha = () => randomBytes(32).toString('hex');
const pull = (o: { token?: string | null; payload?: unknown; headers?: Record<string, string> } = {}) =>
  world.app.inject({
    method: 'POST',
    url: '/admin/v1/backup-pulls',
    payload: (o.payload ?? { file: 'daily/2026-10-16.enc', sha256: sha() }) as object,
    headers: { ...(o.token === null ? {} : { authorization: `Bearer ${o.token ?? TOKEN}` }), 'x-real-ip': freshIp(), ...o.headers },
  });
const asObject = (v: unknown) => (typeof v === 'string' ? JSON.parse(v) : v) as Record<string, any>;
const lastPulled = async () => {
  const [rows] = await world.sql.query<any[]>("SELECT value FROM settings WHERE setting_key = 'last_pulled'");
  return rows.length === 0 ? null : asObject(rows[0].value);
};
const auditCount = async () => Number((await world.sql.query<any[]>('SELECT COUNT(*) AS n FROM audit_log'))[0][0].n);
const line = async () => {
  const res = await world.call('owner', 'GET', '/v1/dashboard/health');
  expect(res.statusCode, res.body.slice(0, 300)).toBe(200);
  return bodyOf<any>(res);
};

describe('T-R06 the admin door records a pull (audited as admin-cli) and no other caller can', () => {
  it('records settings.last_pulled = {at, by, file, sha256}, and the request leaves a settings row from the trigger and one event row, both as admin-cli with no user', async () => {
    const digest = sha();
    const res = await pull({ payload: { file: 'monthly/2026-10.enc', sha256: digest } });
    expect(res.statusCode, res.body).toBe(200);
    expect(await lastPulled()).toEqual({ at: expect.stringMatching(/^2026-10-17T10:\d\d:\d\d\.\d{3}Z$/), by: 'admin-cli', file: 'monthly/2026-10.enc', sha256: digest });
    const [rows] = await world.sql.query<any[]>('SELECT actor, actor_role, table_name, row_id, action FROM audit_log WHERE request_id = ? ORDER BY id', [res.headers['x-request-id']]);
    expect(rows).toHaveLength(2);
    for (const r of rows) expect(r, JSON.stringify(r)).toMatchObject({ actor: null, actor_role: 'admin-cli', table_name: 'settings', row_id: 'last_pulled' });
    expect(rows.map((r) => r.action).sort()).toEqual(['event', 'insert']);
  });

  it('a session is no token: the owner\'s cookie, with or without the website\'s headers, is refused and nothing is written', async () => {
    const before = await auditCount();
    const withHeaders = await world.call('owner', 'POST', '/admin/v1/backup-pulls', { payload: { file: 'daily/2026-10-16.enc', sha256: sha() }, headers: { 'x-real-ip': freshIp() } });
    expect(withHeaders.statusCode).toBe(403); // the door refuses a call that carries an Origin, and the owner's browser always does (API09)
    for (const caller of ['owner', 'biller', 'staff'] as const) {
      const cookieOnly = await pull({ token: null, headers: { cookie: world.cookieOf(caller) as string } });
      expect(cookieOnly.statusCode, caller).toBe(401);
    }
    expect((await pull({ token: null })).statusCode).toBe(401);
    expect((await pull({ token: randomBytes(32).toString('base64url') })).statusCode).toBe(401);
    expect(await lastPulled()).toBeNull();
    expect(await auditCount()).toBe(before);
  });

  it('the record of a download cannot write it: `last_pulled` is no field of that call, and a download leaves a recorded pull as it was', async () => {
    expect((await pull()).statusCode).toBe(200);
    const kept = await lastPulled();
    const counts = Object.fromEntries((await Promise.all(['customers', 'bills', 'bill_items', 'receipts', 'receipt_allocations', 'designs', 'skus', 'daily_rates', 'categories', 'subcategories', 'settings', 'users'].map(async (t) => [t, Number((await world.sql.query<any[]>(`SELECT COUNT(*) AS n FROM \`${t}\``))[0][0].n)]))));
    for (const payload of [
      { date: clock.read().date, counts, last_pulled: { at: '2020-01-01T00:00:00.000Z' } },
      { date: clock.read().date, counts: { ...counts, last_pulled: 1 } },
    ]) {
      const res = await world.call('owner', 'POST', '/v1/owner/download-record', { payload });
      expect(res.statusCode).toBe(422);
    }
    const ok = await world.call('owner', 'POST', '/v1/owner/download-record', { payload: { date: clock.read().date, counts } });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(await lastPulled()).toEqual(kept);
  });

  it('the generic settings edit has `last_download` and `last_pulled` on its never-written list, and the list names nothing else (A4, B3, O54)', () => {
    expect([...NEVER_WRITTEN_SETTINGS].sort()).toEqual(['last_download', 'last_pulled']);
  });

  it('the generic settings edit cannot write `last_pulled`, not even for the owner, not to make a first one and not to change a recorded one: 403 JV_FORBIDDEN, and the row is as it was', async () => {
    const value = { at: '2020-01-01T00:00:00.000Z', by: 'admin-cli', file: 'daily/2020-01-01.enc', sha256: sha() };
    for (const recorded of [false, true]) {
      if (recorded) expect((await pull()).statusCode).toBe(200);
      const before = { row: await lastPulled(), audit: await auditCount() };
      const res = await world.call('owner', 'PUT', '/v1/settings/last_pulled', { payload: { value } });
      expect(res.statusCode, `recorded=${recorded}: ${res.body.slice(0, 200)}`).toBe(403);
      expect((JSON.parse(res.body) as { error: { code: string } }).error.code).toBe('JV_FORBIDDEN');
      for (const key of ['Last_Pulled', 'LAST_PULLED', 'last_pulled%20']) {
        const other = await world.call('owner', 'PUT', `/v1/settings/${key}`, { payload: { value } });
        expect(other.statusCode, `${key}: ${other.body.slice(0, 200)}`).toBeGreaterThanOrEqual(400);
      }
      expect({ row: await lastPulled(), audit: await auditCount() }).toEqual(before);
    }
  });
});

describe('T-R06 the dashboard line shows "last pulled" and turns amber when more than 10 whole days have passed (section 12)', () => {
  const freshOtherwise = async (o: { firstExportAt?: bigint } = {}) => {
    await resetHealth(world, root, time.micros, o);
    await putSetting(world.sql, 'last_download', time.micros); // the download is not what this test is about
  };

  it.each([
    [0, 'ok', 'green', []],
    [7, 'ok', 'green', []],
    [10, 'ok', 'green', []],
    [11, 'amber', 'amber', ['pulled_amber']],
    [45, 'amber', 'amber', ['pulled_amber']],
  ] as const)('a pull %i days ago: the figure is %s, the line is %s, the reasons are %j', async (days, state, level, reasons) => {
    await freshOtherwise();
    await putSetting(world.sql, 'last_pulled', time.micros - BigInt(days) * DAY);
    const h = await line();
    expect(h.pull).toMatchObject({ state, from: 'last_pulled', age_days: days });
    expect(h.reasons).toEqual(reasons);
    expect(h.level).toBe(level);
  });

  it.each([
    [0, 'ok', 'green', []],
    [10, 'ok', 'green', []],
    [11, 'amber', 'amber', ['pulled_amber']],
  ] as const)('no pull at all: the same count runs from the first good export (%i days ago): %s, %s, %j', async (days, state, level, reasons) => {
    await freshOtherwise({ firstExportAt: time.micros - BigInt(days) * DAY });
    const h = await line();
    expect(h.pull).toMatchObject({ state, from: 'first_export', age_days: days });
    expect(h.reasons).toEqual(reasons);
    expect(h.level).toBe(level);
  });

  it('a shop that has no good export yet has no figure to count from: `unknown`, nothing is made up', async () => {
    await root.query(`DELETE FROM \`${world.scratch.database}\`.backup_runs`);
    const h = await line();
    expect(h.pull).toEqual({ state: 'unknown', from: null, reference_date: null, age_days: null });
    expect(h.reasons).not.toContain('pulled_amber');
  });

  // The clock only moves forward (S5), so this one goes last: the owner's session is renewed by hand at each new instant.
  it('end to end: a pull reported through the door clears the figure, stays quiet through day 10, turns amber on day 11, and the next pull clears it', async () => {
    const move = async (to: bigint) => {
      time.micros = to;
      await world.sql.query('UPDATE sessions SET last_seen_at = ?, expires_at = ?, created_at = ? WHERE id = ?', [
        formatTimestamp(time.micros),
        formatTimestamp(time.micros + 14n * DAY),
        formatTimestamp(time.micros - HOUR),
        world.fixtures.owner.sessionId,
      ]);
      await freshOtherwise();
    };
    await freshOtherwise({ firstExportAt: time.micros - 30n * DAY });
    let h = await line();
    expect(h.pull).toMatchObject({ state: 'amber', from: 'first_export', age_days: 30 });
    expect(h.reasons).toEqual(['pulled_amber']);

    const reported = await pull();
    expect(reported.statusCode, reported.body).toBe(200);
    h = await line();
    expect(h.pull).toMatchObject({ state: 'ok', from: 'last_pulled', age_days: 0 });
    expect(h.reasons).toEqual([]);

    const pulledAt = time.micros;
    for (const [days, state, reasons] of [
      [10, 'ok', []],
      [11, 'amber', ['pulled_amber']],
    ] as const) {
      await move(pulledAt + BigInt(days) * DAY);
      h = await line();
      expect(h.pull, `day ${days}`).toMatchObject({ state, from: 'last_pulled', age_days: days });
      expect(h.reasons, `day ${days}`).toEqual(reasons);
    }
    const again = await pull();
    expect(again.statusCode, again.body).toBe(200);
    h = await line();
    expect(h.pull).toMatchObject({ state: 'ok', from: 'last_pulled', age_days: 0 });
    expect(h.reasons).toEqual([]);
    expect(h.level).toBe('green');
  });
});
