import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type MatrixRow, MATRIX } from '../../src/permissions/matrix';
import { createRoute } from '../../src/permissions/route';
import { TICK_KEYS } from '../../src/permissions/ticks';
import { type World, makeWorld } from './cells';
import { csrfHeaders } from './support';

// Task 5 of the access plan (R4, R5, R6; DESIGN.md 6.3, G4): the session reads the user row joined with its `roles` row on every request, so the role's ticks, its name, its switch and the
// Super Admin flag are what the database says now. The route gate asks those grants; `me` and the poll answer carry what the website needs (the ticks, the flag, the access fingerprint, the
// sync resources the person reads).
//
// Until Tasks 6 to 9 hand the handlers the session's grants, a handler's own second check still resolves the role KEY through the built-in sets, so a custom role is tested here only where this
// task reaches: the session lookup, the gate (two rows of a table made for the test, served by the real wrapper), `me`, and the poll of an open resource.

/** Two rows that exist only in this test: one opened by either of two ticks, one for the Super Admin alone. Their handlers do no check of their own, so the answer is the gate's. */
const TEST_ROWS: Record<string, MatrixRow> = {
  'test:any': { kind: 'read', method: 'GET', path: '/v1/test-access/any', access: { anyOf: ['cashbook_recent', 'cashbook_all'] }, mustChange: false, spec: 'access-session test' },
  'test:super': { kind: 'read', method: 'GET', path: '/v1/test-access/super', access: { superAdmin: true }, mustChange: false, spec: 'access-session test' },
};

function registerTestRows(app: FastifyInstance): void {
  const testRoute = createRoute({ matrix: TEST_ROWS, publicRoutes: {}, tokenDoors: {} });
  for (const action of Object.keys(TEST_ROWS)) testRoute(app, { action, handler: async () => ({ ok: true }) });
}

/** The golden fixture of Task 1: what the three built-in roles might read on the day this work began. Read as data, never recorded here. */
const GOLDEN = JSON.parse(readFileSync(new URL('./fixtures/access-golden.json', import.meta.url), 'utf8')) as { rows: Record<string, Record<'owner' | 'biller' | 'staff', boolean>> };

/** The sync resources as the poll names them (the address segment), with their read row: read off the matrix's addresses here, not from src/sync. */
const SYNC = Object.entries(MATRIX)
  .filter(([, r]) => r.kind === 'read' && r.method === 'GET' && r.path.startsWith('/v1/sync/'))
  .map(([action, r]) => ({ action, name: r.path.slice('/v1/sync/'.length) }));

/** R5 written out again, independently of src/permissions/grants.ts. */
const fingerprint = (roleKey: string, ticks: readonly string[], superAdmin: boolean) =>
  createHash('sha256').update(JSON.stringify([roleKey, ticks, superAdmin])).digest('hex').slice(0, 16);

/** The day-one tick sets in catalogue order, typed from the plan's table (not read from the code). */
const BILLER = ['customer_view', 'bill_view', 'cashbook_recent', 'customer_edit', 'bill_make', 'payment_receive', 'rate_enter', 'order_view', 'order_edit'];
const STAFF = ['stock_add', 'stock_edit', 'stock_status', 'category_add', 'order_view'];

let w: World;
beforeAll(async () => {
  w = await makeWorld({ label: 'accsess', routes: true, build: (app) => registerTestRows(app) });
}, 120_000);
afterAll(async () => {
  await w?.close();
});

const get = (cookie: string, url: string) => w.app.inject({ method: 'GET', url, headers: { cookie } });
const pollAs = (cookie: string, cursors: Record<string, null>) => w.app.inject({ method: 'POST', url: '/v1/sync/poll', headers: { ...csrfHeaders(), cookie }, payload: { cursors } });
const json = (res: LightMyRequestResponse) => JSON.parse(res.body);
const meOf = async (cookie: string) => {
  const res = await get(cookie, '/v1/auth/me');
  expect(res.statusCode, res.body).toBe(200);
  return json(res).user;
};
const errorCode = (res: LightMyRequestResponse) => json(res).error?.code as string | undefined;
const setTicks = (key: string, ticks: readonly string[]) => w.sql.query('UPDATE roles SET ticks = ? WHERE role_key = ?', [JSON.stringify(ticks), key]);
const cookieOf = (caller: 'owner' | 'biller' | 'staff' | 'super') => w.cookieOf(caller)!;

describe('Task 5: the session reads the role row; the gate, me and the poll use what it read', () => {
  it('ticks come from the role row on every request: change roles.ticks in SQL and the same cookie sees the new grants on the next call (G4)', async () => {
    const role = await w.addRole({ ticks: [] });
    const u = await w.addUser({ role: role.key });
    const before = await meOf(u.cookie);
    expect(before.permissions).toEqual([]);
    const refused = await get(u.cookie, '/v1/test-access/any');
    expect(refused.statusCode).toBe(403);
    expect(errorCode(refused)).toBe('JV_FORBIDDEN');

    await setTicks(role.key, ['cashbook_recent', 'cashbook_all']); // a role the screen could save: the cash book for all days needs the cash book for today and yesterday
    const after = await meOf(u.cookie); // the same cookie, the next call
    expect(after.permissions).toEqual(['cashbook_recent', 'cashbook_all']);
    expect(after.access).not.toBe(before.access);
    expect((await get(u.cookie, '/v1/test-access/any')).statusCode).toBe(200);

    await setTicks(role.key, []); // taken away again: refused again at once
    expect((await get(u.cookie, '/v1/test-access/any')).statusCode).toBe(403);
    expect((await meOf(u.cookie)).access).toBe(before.access);
  });

  it('a role switched off, or a user whose role row is missing, gets 401 JV_UNAUTHENTICATED', async () => {
    const role = await w.addRole({ ticks: ['cashbook_recent'] });
    const u = await w.addUser({ role: role.key });
    expect((await get(u.cookie, '/v1/auth/me')).statusCode).toBe(200);

    await w.sql.query('UPDATE roles SET active = 0 WHERE role_key = ?', [role.key]);
    for (const url of ['/v1/auth/me', '/v1/test-access/any', '/v1/sync/users']) {
      const res = await get(u.cookie, url);
      expect(res.statusCode, url).toBe(401);
      expect(errorCode(res), url).toBe('JV_UNAUTHENTICATED');
    }
    await w.sql.query('UPDATE roles SET active = 1 WHERE role_key = ?', [role.key]);
    expect((await get(u.cookie, '/v1/auth/me')).statusCode).toBe(200); // switched on again: the same session works

    // a role key with no row: the foreign key forbids it, so the test switches the check off for its own statement only
    const ghost = await w.addUser({ role: 'staff' });
    await w.sql.query('SET SESSION foreign_key_checks = 0');
    try {
      await w.sql.query("UPDATE users SET role = 'ghost' WHERE id = ?", [ghost.userId]);
    } finally {
      await w.sql.query('SET SESSION foreign_key_checks = 1');
    }
    for (const url of ['/v1/auth/me', '/v1/sync/users']) {
      const res = await get(ghost.cookie, url);
      expect(res.statusCode, url).toBe(401);
      expect(errorCode(res), url).toBe('JV_UNAUTHENTICATED');
    }
  });

  it('unknown tick keys in roles.ticks are ignored and the known ones still apply (Review Focus 2)', async () => {
    const role = await w.addRole({ ticks: ['no_such_tick', 'cashbook_recent', 'Cashbook_All', ''] });
    const u = await w.addUser({ role: role.key });
    const me = await meOf(u.cookie);
    expect(me.permissions).toEqual(['cashbook_recent']);
    expect(me.access).toBe(fingerprint(role.key, ['cashbook_recent'], false));
    expect((await get(u.cookie, '/v1/test-access/any')).statusCode).toBe(200);
  });

  it('the owner key and a Super Admin hold all 32 ticks whatever roles.ticks says; only the Super Admin has isSuperAdmin', async () => {
    expect(TICK_KEYS).toHaveLength(32);
    await setTicks('owner', ['bill_view']);
    try {
      const owner = await meOf(cookieOf('owner'));
      expect(owner.permissions).toEqual([...TICK_KEYS]);
      expect(owner.is_super_admin).toBe(false);
      const sup = await meOf(cookieOf('super'));
      expect(sup.permissions).toEqual([...TICK_KEYS]);
      expect(sup.is_super_admin).toBe(true);
      expect(sup.role).toBe('owner');
      expect(sup.access).not.toBe(owner.access); // the flag is part of the fingerprint
    } finally {
      await setTicks('owner', []);
    }
    // the flag gives every tick whatever the role (R4), and the others are not the Super Admin
    const flagged = await w.addUser({ role: 'staff', superAdmin: true });
    const me = await meOf(flagged.cookie);
    expect(me.permissions).toEqual([...TICK_KEYS]);
    expect(me.is_super_admin).toBe(true);
    for (const caller of ['biller', 'staff'] as const) expect((await meOf(cookieOf(caller))).is_super_admin, caller).toBe(false);
  });

  it('me returns role, role_name, permissions in catalogue order, is_super_admin, access and reads; a biller reads no sku_private, audit_log, check_runs or backup_runs; reads equals the read rows the golden fixture allows', async () => {
    const expected = { owner: { name: 'Owner', ticks: [...TICK_KEYS] }, biller: { name: 'Biller', ticks: BILLER }, staff: { name: 'Staff', ticks: STAFF } } as const;
    for (const role of ['owner', 'biller', 'staff'] as const) {
      const res = await get(cookieOf(role), '/v1/auth/me');
      expect(res.statusCode).toBe(200);
      const body = json(res);
      expect(Object.keys(body).sort()).toEqual(['absolute_expires_at', 'idle_timeout_s', 'pricing_sha256', 'user']);
      expect(body.user).toEqual({
        id: w.fixtures[role].userId,
        email: expect.any(String),
        full_name: `Fixture ${role}`,
        role,
        must_change_password: false,
        role_name: expected[role].name,
        permissions: expected[role].ticks,
        is_super_admin: false,
        access: fingerprint(role, expected[role].ticks, false),
        reads: SYNC.filter((r) => GOLDEN.rows[r.action][role]).map((r) => r.name),
      });
      expect(body.user.access).toMatch(/^[0-9a-f]{16}$/);
    }
    const biller = await meOf(cookieOf('biller'));
    for (const name of ['sku-private', 'sku_private', 'audit-log', 'audit_log', 'check-runs', 'check_runs', 'backup-runs', 'backup_runs']) expect(biller.reads, name).not.toContain(name);
    expect(biller.reads).toContain('bills');
    expect((await meOf(cookieOf('owner'))).reads).toEqual(SYNC.map((r) => r.name));
    expect((await meOf(cookieOf('staff'))).reads).toEqual(['users', 'settings', 'daily-rates', 'categories', 'subcategories', 'designs', 'skus', 'orders']);
  });

  it('the poll answer carries the same access as me, and it changes when a tick is added to the role (P6, API half)', async () => {
    const role = await w.addRole({ ticks: ['order_view'] });
    const u = await w.addUser({ role: role.key });
    const first = await pollAs(u.cookie, { users: null });
    expect(first.statusCode, first.body).toBe(200);
    const me = await meOf(u.cookie);
    expect(json(first)).toMatchObject({ role: role.key, access: me.access });
    expect(Object.keys(json(first)).sort()).toEqual(['access', 'results', 'role', 'server_time']);

    await setTicks(role.key, ['order_view', 'reports_open']);
    const second = await pollAs(u.cookie, { users: null });
    expect(second.statusCode).toBe(200);
    expect(json(second).access).not.toBe(me.access);
    expect(json(second).access).toBe((await meOf(u.cookie)).access);
    expect(json(second).access).toBe(fingerprint(role.key, ['order_view', 'reports_open'], false));

    // a built-in role too: the biller's poll of an open resource carries the biller's access
    const billerPoll = await w.call('biller', 'POST', '/v1/sync/poll', { payload: { cursors: { 'daily-rates': null } } });
    expect(billerPoll.statusCode).toBe(200);
    expect(json(billerPoll)).toMatchObject({ role: 'biller', access: (await meOf(cookieOf('biller'))).access });
  });

  it('renaming a role changes role_name and not access; changing a tick changes access and not role_name', async () => {
    const role = await w.addRole({ name: 'Counter desk', ticks: ['customer_view'] });
    const u = await w.addUser({ role: role.key });
    const a = await meOf(u.cookie);
    expect(a.role_name).toBe('Counter desk');
    await w.sql.query("UPDATE roles SET name = 'Front counter' WHERE role_key = ?", [role.key]);
    const b = await meOf(u.cookie);
    expect(b.role_name).toBe('Front counter');
    expect(b.access).toBe(a.access);
    await setTicks(role.key, ['customer_view', 'bill_view']);
    const c = await meOf(u.cookie);
    expect(c.role_name).toBe('Front counter');
    expect(c.access).not.toBe(b.access);
    expect(c.permissions).toEqual(['customer_view', 'bill_view']);

    // a built-in role whose ticks are edited in SQL: its fingerprint and permissions follow the row, its name does not move
    const before = await meOf(cookieOf('biller'));
    await setTicks('biller', ['reports_open', ...BILLER].reverse()); // stored in any order: me lists them in catalogue order
    try {
      const after = await meOf(cookieOf('biller'));
      expect(after.role_name).toBe('Biller');
      expect(after.permissions).toEqual([...BILLER, 'reports_open']);
      expect(after.access).not.toBe(before.access);
    } finally {
      await setTicks('biller', BILLER);
    }
    expect((await meOf(cookieOf('biller'))).access).toBe(before.access);
  });

  it('a row with anyOf is open to a person holding any one of its ticks; a superAdmin row refuses the Owner with 403 and a non-active user with 401', async () => {
    for (const ticks of [['cashbook_recent'], ['cashbook_all'], ['cashbook_recent', 'cashbook_all']]) {
      const role = await w.addRole({ ticks });
      const u = await w.addUser({ role: role.key });
      expect((await get(u.cookie, '/v1/test-access/any')).statusCode, ticks.join(',')).toBe(200);
      expect((await get(u.cookie, '/v1/test-access/super')).statusCode, ticks.join(',')).toBe(403);
    }
    const none = await w.addUser({ role: (await w.addRole({ ticks: ['bill_view'] })).key });
    expect((await get(none.cookie, '/v1/test-access/any')).statusCode).toBe(403);
    expect((await get(cookieOf('biller'), '/v1/test-access/any')).statusCode).toBe(200); // the biller holds cashbook_recent
    expect((await get(cookieOf('staff'), '/v1/test-access/any')).statusCode).toBe(403);

    const owner = await get(cookieOf('owner'), '/v1/test-access/super');
    expect(owner.statusCode).toBe(403); // all 32 ticks without the flag do not pass
    expect(errorCode(owner)).toBe('JV_FORBIDDEN');
    expect((await get(cookieOf('super'), '/v1/test-access/super')).statusCode).toBe(200);
    expect((await get(cookieOf('super'), '/v1/test-access/any')).statusCode).toBe(200);

    const inactive = await w.addUser({ role: 'owner', superAdmin: true, active: false });
    const res = await get(inactive.cookie, '/v1/test-access/super');
    expect(res.statusCode).toBe(401);
    expect(errorCode(res)).toBe('JV_UNAUTHENTICATED');
  });
});
