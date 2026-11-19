import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../../scripts/migrate.mjs';
import { passwords } from '../../src/auth/password';
import { createClock } from '../../src/clock';
import { type DbPool, createDbPool } from '../../src/db/pool';
import { txContext, withTx } from '../../src/db/tx';
import { assertActiveRole, getRole, roleKeyField } from '../../src/permissions/roleStore';
import { TICK_KEYS } from '../../src/permissions/ticks';
import { T0, type World, makeWorld } from './cells';
import { csrfHeaders, secret } from './support';

// Task 10 of the access plan (R2, R3, R12, R13, R14; DESIGN.md 6.1, 6.3, 6.6): the admin door and the Super Admin.
//   - add-user and role take the key of ANY active role (not only owner, biller and staff) and refuse a key that is not an active role (422 on `role`); what is written is the key as the `roles` table STORES it;
//   - every user answer of the door carries `is_super_admin`;
//   - POST /admin/v1/super-admin {email, full_name} (`npm run admin -- make-super-admin`) makes the one Super Admin login, or promotes the login that has the e-mail, and refuses a second ACTIVE one (R13 with `activate`).
// The terminal side of make-super-admin is in tests/api/admin-scripts.test.ts; the routes, the 404 while the door is shut and the throttles are in admin-door.test.ts.
//
// One world: a scratch database with the real schema and the audit triggers of db/optional, the application's own routes, and a clock fixed at T0. The world's fixture holds an ACTIVE Super Admin (`super`),
// so every test that needs a known state starts by switching the flagged logins off (SQL) and makes what it needs.

const TOKEN = randomBytes(32).toString('base64url');
const HASH = createHash('sha256').update(TOKEN).digest('hex');
const clock = createClock(() => T0);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

let world: World;
let pool: DbPool;

beforeAll(async () => {
  world = await makeWorld({ label: 'admsuper', routes: true, clock, config: { adminTokenHash: HASH, logLevel: 'info' } });
  await migrate(world.sql, { seeds: false, optional: true }); // the audit triggers: "one event row" can be told from the rows a trigger writes
  pool = createDbPool(world.scratch.db);
}, 120_000);
afterAll(async () => {
  await pool?.end().catch(() => undefined);
  await world?.close();
});

// ------------------------------------------------------------------ calls and reads

// every call from its own address: the door counts ten a minute for each address and the clock is fixed
let addresses = 0;
const freshIp = () => `198.51.${Math.floor(++addresses / 250)}.${(addresses % 250) + 1}`;

const call = (method: 'GET' | 'POST', url: string, payload?: unknown): Promise<LightMyRequestResponse> =>
  world.app.inject({ method, url, payload: payload as object | undefined, headers: { authorization: `Bearer ${TOKEN}`, 'x-real-ip': freshIp() } });

const errorOf = (res: LightMyRequestResponse) => (res.json() as { error: { code: string; message: string; details: Record<string, unknown> } }).error;
const requestIdOf = (res: LightMyRequestResponse) => String(res.headers['x-request-id']);
const newEmail = (label = 'u') => `${label}-${randomUUID().slice(0, 8)}@example.test`;
const asObject = (v: unknown) => (typeof v === 'string' ? JSON.parse(v) : v) as Record<string, any>;

const userRow = async (id: string) => (await world.sql.query<any[]>('SELECT * FROM users WHERE id = ?', [id]))[0][0] as Record<string, any>;
const userByEmail = async (email: string) => (await world.sql.query<any[]>('SELECT * FROM users WHERE email = ?', [email]))[0][0] as Record<string, any> | undefined;
const countOf = async (table: string) => Number((await world.sql.query<any[]>(`SELECT COUNT(*) AS n FROM ${table}`))[0][0].n);
const auditOf = async (requestId: string) =>
  (await world.sql.query<any[]>('SELECT actor, actor_role, request_id, table_name, row_id, action, old_row, new_row FROM audit_log WHERE request_id = ? ORDER BY id', [requestId]))[0] as Record<string, any>[];
const eventsOf = async (requestId: string) => (await auditOf(requestId)).filter((r) => r.action === 'event');
const activeSuperAdmins = async () => (await world.sql.query<any[]>('SELECT email FROM users WHERE is_super_admin = 1 AND active = 1 ORDER BY email'))[0].map((r) => String(r.email));

/** Every flagged login is switched off, so the test starts with no active Super Admin (the fixture has one, and so do the tests before). */
const noSuperAdmin = () => world.sql.query('UPDATE users SET active = 0 WHERE is_super_admin = 1');

/** A login made through the door, as Harsh makes one. */
async function addLogin(role: string, o: { name?: string } = {}) {
  const email = newEmail(role);
  const res = await call('POST', '/admin/v1/users', { email, full_name: o.name ?? `Made ${role}`, role });
  if (res.statusCode !== 201) throw new Error(`add user failed: ${res.statusCode} ${res.body}`);
  const body = res.json() as { user: { id: string }; temporary_password: string };
  return { id: body.user.id, email, password: body.temporary_password };
}

const setCookieOf = (res: LightMyRequestResponse): string => {
  const h = res.headers['set-cookie'];
  return String(Array.isArray(h) ? h[0] : h).split(';')[0];
};
const login = (email: string, password: string) => world.app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email, password }, headers: csrfHeaders() });
const meOf = (cookie: string) => world.app.inject({ method: 'GET', url: '/v1/auth/me', headers: { cookie } });

/**
 * Runs `run` while the database takes 0.4 s to make a login an ACTIVE Super Admin (a BEFORE trigger on the insert of a flagged login and on the update that flags a login or switches a flagged one on): the time
 * between a call's check for another Super Admin and its commit becomes wide, so calls made at the same moment overlap there for sure, and a missing lock shows. The triggers are dropped again whatever happens.
 */
async function whileFlaggingIsSlow<T>(run: () => Promise<T>): Promise<T> {
  const drop = async () => {
    await world.sql.query('DROP TRIGGER IF EXISTS trg_test_slow_flag_insert');
    await world.sql.query('DROP TRIGGER IF EXISTS trg_test_slow_flag_update');
  };
  await drop();
  await world.sql.query('CREATE TRIGGER trg_test_slow_flag_insert BEFORE INSERT ON users FOR EACH ROW BEGIN IF NEW.is_super_admin = 1 THEN DO SLEEP(0.4); END IF; END');
  await world.sql.query('CREATE TRIGGER trg_test_slow_flag_update BEFORE UPDATE ON users FOR EACH ROW BEGIN IF NEW.is_super_admin = 1 AND NEW.active = 1 AND (OLD.is_super_admin = 0 OR OLD.active = 0) THEN DO SLEEP(0.4); END IF; END');
  try {
    return await run();
  } finally {
    await drop();
  }
}

/**
 * Runs `run` while the database takes `seconds` to switch a login on (a BEFORE trigger on the update that sets `active` from 0 to 1): the call that switches it on sits inside its transaction, holding its locks,
 * for that long, and the test can do something at that moment (see untilSleeping). The trigger is dropped again whatever happens.
 */
async function whileActivationIsSlow<T>(seconds: number, run: () => Promise<T>): Promise<T> {
  await world.sql.query('DROP TRIGGER IF EXISTS trg_test_slow_activation');
  await world.sql.query(`CREATE TRIGGER trg_test_slow_activation BEFORE UPDATE ON users FOR EACH ROW BEGIN IF OLD.active = 0 AND NEW.active = 1 THEN DO SLEEP(${seconds}); END IF; END`);
  try {
    return await run();
  } finally {
    await world.sql.query('DROP TRIGGER IF EXISTS trg_test_slow_activation');
  }
}

/** Waits until a statement of this database is inside SLEEP() (the slow trigger), so that what the test does next happens while the call holds its locks. */
async function untilSleeping(): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const n = Number((await world.sql.query<any[]>("SELECT COUNT(*) AS n FROM information_schema.PROCESSLIST WHERE STATE LIKE 'User sleep%'"))[0][0].n);
    if (n > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('no statement reached the slow trigger');
}

/** Runs `run` with the foreign keys of this test connection off (a hand edit of the database), and puts them back whatever happens. */
async function withForeignKeysOff<T>(run: () => Promise<T>): Promise<T> {
  await world.sql.query('SET FOREIGN_KEY_CHECKS = 0');
  try {
    return await run();
  } finally {
    await world.sql.query('SET FOREIGN_KEY_CHECKS = 1');
  }
}

/** The text of the refusal of a second Super Admin (R13), the same for make-super-admin and activate. */
const SECOND = (email: string) => `Another Super Admin is active (${email}). Switch that login off first with deactivate.`;

// ------------------------------------------------------------------ the role key of add-user and role

describe('roleKeyField is the shape of a role key and nothing more (R2)', () => {
  it('accepts a lower-case letter and up to eleven lower-case letters or hyphens, and refuses every other text and every value that is not text, without mending it', () => {
    for (const key of ['a', 'owner', 'cashier', 'a-b', 'abcdefghijkl', 'a-----------', 'night-shift']) expect(roleKeyField.safeParse(key).success, key).toBe(true);
    const refused = ['', 'A', 'Owner', 'owner ', ' owner', 'owner\n', 'a1', '1a', 'a b', 'a_b', '-a', 'abcdefghijklm', 'caf\u00e9', 'a\u200bb', 'a/b', "a'b", 'a;b'];
    for (const key of refused) expect(roleKeyField.safeParse(key).success, JSON.stringify(key)).toBe(false);
    for (const value of [undefined, null, 12, true, {}, ['owner']]) expect(roleKeyField.safeParse(value).success, String(value)).toBe(false);
    expect(roleKeyField.parse('cashier')).toBe('cashier');
  });
});

describe('add-user and role take the key of any ACTIVE role, refuse a key that is not one with 422 on `role`, and write the key as STORED (R2, R3)', () => {
  beforeAll(async () => {
    await world.addRole({ key: 'cashier', name: 'Cashier', ticks: ['customer_view', 'bill_view'] });
    await world.addRole({ key: 'retired', name: 'Retired', ticks: ['stock_add'], active: false });
  });

  it('add-user: a custom role key makes the login; the answer, the row and the event hold the key, and the login holds the ticks of that role', async () => {
    const email = newEmail('cashier');
    const res = await call('POST', '/admin/v1/users', { email, full_name: 'Counter Cashier', role: 'cashier' });
    expect(res.statusCode, res.body).toBe(201);
    const made = res.json() as { user: Record<string, any>; temporary_password: string };
    expect(made.user).toEqual({ id: expect.stringMatching(UUID), email, full_name: 'Counter Cashier', role: 'cashier', active: true, must_change_password: true, is_super_admin: false });
    expect(await userRow(made.user.id)).toMatchObject({ role: 'cashier', active: 1, must_change_password: 1, is_super_admin: 0 });
    const events = await eventsOf(requestIdOf(res));
    expect(events).toHaveLength(1);
    expect(asObject(events[0].new_row)).toEqual({ event: 'admin_add_user', role: 'cashier' });

    const signedIn = await login(email, made.temporary_password);
    expect(signedIn.statusCode, signedIn.body).toBe(200);
    const me = await meOf(setCookieOf(signedIn));
    expect(me.json().user).toMatchObject({ role: 'cashier', role_name: 'Cashier', permissions: ['customer_view', 'bill_view'], is_super_admin: false });
  });

  it('add-user: the three built-in keys still work, and an owner made here is NOT a Super Admin', async () => {
    for (const role of ['owner', 'biller', 'staff']) {
      const made = await addLogin(role);
      expect(await userRow(made.id), role).toMatchObject({ role, is_super_admin: 0 });
    }
  });

  it('add-user: a key that is not an active role is 422 on `role` (an unknown key, a switched-off role), a text that is not a role key is 422 on `role` too, and nothing is written', async () => {
    const usersBefore = await countOf('users');
    const auditBefore = await countOf('audit_log');
    const refusals: [string, unknown, string][] = [
      ['an unknown key', 'nosuchrole', 'is not an active role'],
      ['a role that is switched off', 'retired', 'is not an active role'],
      ['a capital letter', 'Biller', 'must be a role key'],
      ['all capitals', 'OWNER', 'must be a role key'],
      ['a trailing space', 'biller ', 'must be a role key'],
      ['a trailing line break', 'biller\n', 'must be a role key'],
      ['an empty text', '', 'must be a role key'],
      ['a digit', 'role1', 'must be a role key'],
      ['an underscore', 'my_role', 'must be a role key'],
      ['a hyphen first', '-role', 'must be a role key'],
      ['13 characters', 'abcdefghijklm', 'must be a role key'],
      ['no role at all', undefined, 'is required'],
      ['a number', 12, 'must be text'],
    ];
    for (const [name, role, reason] of refusals) {
      const res = await call('POST', '/admin/v1/users', { email: newEmail('refused'), full_name: 'Nobody', ...(role === undefined ? {} : { role }) });
      expect(res.statusCode, `${name}: ${res.body}`).toBe(422);
      expect(errorOf(res), name).toMatchObject({ code: 'JV_INVALID_INPUT', details: { field: 'role' } });
      expect(errorOf(res).message, name).toBe(`role ${reason}`);
    }
    expect(await countOf('users')).toBe(usersBefore);
    expect(await countOf('audit_log'), 'a refused call writes no row at all, not even an event').toBe(auditBefore);
  });

  it('add-user cannot set the flag: is_super_admin in the body is an unknown field (422), and the answer of every add-user says false', async () => {
    const res = await call('POST', '/admin/v1/users', { email: newEmail('flag'), full_name: 'Flag Try', role: 'owner', is_super_admin: true });
    expect(res.statusCode).toBe(422);
    expect(errorOf(res).details).toEqual({ field: 'is_super_admin' });
    const made = await call('POST', '/admin/v1/users', { email: newEmail('plain'), full_name: 'Plain Owner', role: 'owner' });
    expect(made.json().user.is_super_admin).toBe(false);
  });

  it('role (change): any active role key, the previous role in the answer, the key written as stored and named in the event; a key that is not an active role is 422 on `role` and the role stays', async () => {
    const made = await addLogin('biller');
    const to = await call('POST', `/admin/v1/users/${made.id}/role`, { role: 'cashier' });
    expect(to.statusCode, to.body).toBe(200);
    expect(to.json()).toEqual({ user: { id: made.id, email: made.email, full_name: 'Made biller', role: 'cashier', active: true, must_change_password: true, is_super_admin: false }, previous_role: 'biller' });
    expect((await userRow(made.id)).role).toBe('cashier');
    expect(asObject((await eventsOf(requestIdOf(to)))[0].new_row)).toEqual({ event: 'admin_change_role', from: 'biller', to: 'cashier' });

    const before = await countOf('audit_log');
    for (const [name, role, reason] of [
      ['an unknown key', 'nosuchrole', 'is not an active role'],
      ['a role that is switched off', 'retired', 'is not an active role'],
      ['a capital letter', 'Cashier', 'must be a role key'],
    ] as const) {
      const refused = await call('POST', `/admin/v1/users/${made.id}/role`, { role });
      expect(refused.statusCode, name).toBe(422);
      expect(errorOf(refused), name).toMatchObject({ code: 'JV_INVALID_INPUT', message: `role ${reason}`, details: { field: 'role' } });
    }
    expect((await userRow(made.id)).role, 'a refused change leaves the role as it was').toBe('cashier');
    expect(await countOf('audit_log')).toBe(before);

    const back = await call('POST', `/admin/v1/users/${made.id}/role`, { role: 'staff' });
    expect(back.json()).toMatchObject({ user: { role: 'staff' }, previous_role: 'cashier' });
  });

  it('role (change) on a person who does not exist is still 404 whatever role is named', async () => {
    const res = await call('POST', `/admin/v1/users/${randomUUID()}/role`, { role: 'cashier' });
    expect([res.statusCode, errorOf(res).code]).toEqual([404, 'JV_NOT_FOUND']);
  });

  it('the foreign key accepts a role key in any letter case, so what the door writes is the STORED key: getRole and assertActiveRole find the row by any case and return it as stored', async () => {
    // the hazard: the database itself does not refuse "Biller", it stores the text it was given
    const person = await world.addUser({ role: 'staff' });
    await world.sql.query("UPDATE users SET role = 'Biller' WHERE id = ?", [person.userId]);
    expect((await userRow(person.userId)).role, 'the foreign key let a capital in').toBe('Biller');
    await world.sql.query("UPDATE users SET role = 'staff' WHERE id = ?", [person.userId]);

    const ctx = () => txContext(pool, { requestId: randomUUID(), actor: { id: null, role: 'admin-cli' } });
    await withTx(ctx(), async (tx) => {
      const stored = await getRole(tx, 'biller');
      expect(stored).toMatchObject({ role_key: 'biller', name: 'Biller' });
      expect(Number(stored?.active)).toBe(1);
      expect(await getRole(tx, 'Biller')).toEqual(stored);
      expect((await getRole(tx, 'BILLER'))?.role_key).toBe('biller');
      expect(await getRole(tx, 'nosuchrole')).toBeUndefined();
      expect(await getRole(tx, 'biller', { forUpdate: true })).toEqual(stored);
      expect((await assertActiveRole(tx, 'Biller')).role_key, 'the key to write is the stored one').toBe('biller');
      expect(asObject((await assertActiveRole(tx, 'cashier')).ticks), 'the ticks column as stored, parsed or as text').toEqual(['customer_view', 'bill_view']);
      expect(Number((await getRole(tx, 'retired'))?.active), 'getRole shows a switched-off role as it is').toBe(0);
    });
  });

  it('assertActiveRole refuses what is not an active role with 422 on the field it is given (role when none is given), and says so in the same words', async () => {
    const ctx = () => txContext(pool, { requestId: randomUUID(), actor: { id: null, role: 'admin-cli' } });
    const refusal = (run: (tx: Parameters<typeof assertActiveRole>[0]) => Promise<unknown>) => withTx(ctx(), (tx) => run(tx)).then(() => 'not refused', (e: any) => [e.status, e.code, e.message, e.details]);
    expect(await refusal((tx) => assertActiveRole(tx, 'nosuchrole'))).toEqual([422, 'JV_INVALID_INPUT', 'role is not an active role', { field: 'role' }]);
    expect(await refusal((tx) => assertActiveRole(tx, 'retired'))).toEqual([422, 'JV_INVALID_INPUT', 'role is not an active role', { field: 'role' }]);
    expect(await refusal((tx) => assertActiveRole(tx, 'retired', 'copy_of'))).toEqual([422, 'JV_INVALID_INPUT', 'copy_of is not an active role', { field: 'copy_of' }]);
    expect(await refusal((tx) => assertActiveRole(tx, 'staff'))).toBe('not refused');
  });

  it('assertActiveRole holds the role row until the transaction ends: a switch-off from another connection waits, so a login is never given a role that is being switched off', async () => {
    await world.addRole({ key: 'switching', name: 'Switching', ticks: [] });
    const other = await world.scratch.connect();
    try {
      await other.query('SET SESSION innodb_lock_wait_timeout = 1');
      await withTx(txContext(pool, { requestId: randomUUID(), actor: { id: null, role: 'admin-cli' } }), async (tx) => {
        await assertActiveRole(tx, 'switching');
        await expect(other.query("UPDATE roles SET active = 0 WHERE role_key = 'switching'")).rejects.toMatchObject({ errno: 1205 });
      });
      await other.query("UPDATE roles SET active = 0 WHERE role_key = 'switching'"); // the lock went with the transaction
    } finally {
      await other.end();
    }
  });
});

// ------------------------------------------------------------------ make-super-admin

describe('POST /admin/v1/super-admin (make-super-admin, R14): a new login, or the promotion of the login that has the e-mail', () => {
  it('a new e-mail makes a login with role owner, is_super_admin 1, active and must_change_password 1, and a temporary password that is shown once', async () => {
    await noSuperAdmin();
    const email = newEmail('Sid.Admin');
    const res = await call('POST', '/admin/v1/super-admin', { email: `  ${email.toUpperCase()}  `, full_name: '  Siddhi Test ' });
    expect(res.statusCode, res.body).toBe(201);
    const body = res.json() as { user: Record<string, any>; created: boolean; temporary_password: string };
    expect(Object.keys(body).sort()).toEqual(['created', 'temporary_password', 'user']);
    expect(body.created).toBe(true);
    expect(body.user).toEqual({ id: expect.stringMatching(UUID), email: email.toLowerCase(), full_name: 'Siddhi Test', role: 'owner', active: true, must_change_password: true, is_super_admin: true });
    expect(body.temporary_password.length).toBeGreaterThanOrEqual(16);

    const row = await userRow(body.user.id);
    expect(row).toMatchObject({ email: email.toLowerCase(), role: 'owner', is_super_admin: 1, active: 1, must_change_password: 1, last_login_at: null });
    expect(row.password_hash).toMatch(/^\$(argon2id|scrypt)\$/);
    expect(row.password_hash).not.toContain(body.temporary_password);
    expect(await passwords.verify(body.temporary_password, row.password_hash)).toBe(true);

    // the login works, must change the password, and holds every tick as the Super Admin
    const signedIn = await login(email, body.temporary_password);
    expect(signedIn.statusCode, signedIn.body).toBe(200);
    expect(signedIn.json().user.must_change_password).toBe(true);
    const me = (await meOf(setCookieOf(signedIn))).json().user;
    expect(me).toMatchObject({ role: 'owner', role_name: 'Owner', is_super_admin: true });
    expect(me.permissions).toEqual(TICK_KEYS);

    // shown once: the list, the audit rows and the log never hold it; the database holds only its hash
    expect((await call('GET', '/admin/v1/users')).body).not.toContain(body.temporary_password);
    const audit = JSON.stringify(await auditOf(requestIdOf(res)));
    expect(audit).not.toContain(body.temporary_password);
    expect(audit).not.toContain(row.password_hash);
    expect(world.logs.text()).not.toContain(body.temporary_password);
  });

  it('an existing login keeps its password and is promoted (role owner, flag 1, name and must_change_password as they were); created is false and no temporary password is returned', async () => {
    await noSuperAdmin();
    const made = await addLogin('biller');
    const mine = secret('Np');
    const first = await login(made.email, made.password);
    const cookie = setCookieOf(first);
    const changed = await world.app.inject({ method: 'POST', url: '/v1/auth/change-password', payload: { current_password: made.password, new_password: mine }, headers: { ...csrfHeaders(), cookie } });
    expect(changed.statusCode, changed.body).toBe(200);
    const before = await userRow(made.id);
    const usersBefore = await countOf('users');

    const res = await call('POST', '/admin/v1/super-admin', { email: made.email.toUpperCase(), full_name: 'A Different Name' });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as Record<string, any>;
    expect(Object.keys(body).sort()).toEqual(['created', 'user']);
    expect(body.created).toBe(false);
    expect(body.user).toEqual({ id: made.id, email: made.email, full_name: 'Made biller', role: 'owner', active: true, must_change_password: false, is_super_admin: true });
    const after = await userRow(made.id);
    expect(after).toMatchObject({ role: 'owner', is_super_admin: 1, active: 1, must_change_password: 0, full_name: 'Made biller' });
    expect(after.password_hash, 'the password is kept').toBe(before.password_hash);
    expect(await countOf('users'), 'no second login').toBe(usersBefore);
    expect((await login(made.email, mine)).statusCode, 'they sign in with their own password').toBe(200);
    // their session reads the role on every call: from the next call it is the Owner's, with the flag
    expect((await meOf(cookie)).json().user).toMatchObject({ role: 'owner', is_super_admin: true });
  });

  it('a login that is not active stays not active and the answer says so (it is never silently activated)', async () => {
    await noSuperAdmin();
    const made = await addLogin('staff');
    expect((await call('POST', `/admin/v1/users/${made.id}/deactivate`)).statusCode).toBe(200);
    const res = await call('POST', '/admin/v1/super-admin', { email: made.email, full_name: 'Ignored' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ created: false, user: { id: made.id, email: made.email, full_name: 'Made staff', role: 'owner', active: false, must_change_password: true, is_super_admin: true } });
    expect(await userRow(made.id)).toMatchObject({ active: 0, role: 'owner', is_super_admin: 1 });
    expect((await login(made.email, made.password)).statusCode, 'it still cannot sign in').toBe(403);
  });

  it('refuses a second ACTIVE Super Admin with 409 JV_NOT_ALLOWED and one sentence naming the other e-mail and the fix; nothing is written, for a new e-mail and for an existing login', async () => {
    await noSuperAdmin();
    const first = (await world.addUser({ role: 'owner', superAdmin: true })).email;
    const biller = await addLogin('biller');
    const usersBefore = await countOf('users');
    const auditBefore = await countOf('audit_log');
    const fresh = newEmail('second');

    const made = await call('POST', '/admin/v1/super-admin', { email: fresh, full_name: 'Second One' });
    expect([made.statusCode, errorOf(made).code]).toEqual([409, 'JV_NOT_ALLOWED']);
    expect(errorOf(made).message).toBe(SECOND(first));
    expect(made.body).not.toContain(fresh);
    const promoted = await call('POST', '/admin/v1/super-admin', { email: biller.email, full_name: 'Made biller' });
    expect([promoted.statusCode, errorOf(promoted).code, errorOf(promoted).message]).toEqual([409, 'JV_NOT_ALLOWED', SECOND(first)]);

    expect(await userByEmail(fresh)).toBeUndefined();
    expect(await userRow(biller.id)).toMatchObject({ role: 'biller', is_super_admin: 0 });
    expect(await countOf('users')).toBe(usersBefore);
    expect(await countOf('audit_log'), 'a refused call writes no row at all').toBe(auditBefore);
    expect(await activeSuperAdmins()).toEqual([first]);
  });

  it('after deactivate of the first one it works; the same e-mail again is accepted and changes nothing; a third e-mail is refused naming the second; list shows who is the Super Admin', async () => {
    await noSuperAdmin();
    const firstEmail = newEmail('first');
    const first = await call('POST', '/admin/v1/super-admin', { email: firstEmail, full_name: 'First One' });
    expect(first.statusCode, first.body).toBe(201);
    const firstId = first.json().user.id as string;
    expect((await call('POST', '/admin/v1/super-admin', { email: newEmail('early'), full_name: 'Too Early' })).statusCode, 'while the first is active').toBe(409);
    const off = await call('POST', `/admin/v1/users/${firstId}/deactivate`);
    expect(off.statusCode, off.body).toBe(200);

    const secondEmail = newEmail('second');
    const second = await call('POST', '/admin/v1/super-admin', { email: secondEmail, full_name: 'Second One' });
    expect(second.statusCode, second.body).toBe(201);
    const secondId = second.json().user.id as string;
    expect(await activeSuperAdmins()).toEqual([secondEmail]);

    // the same e-mail again: accepted, nothing changes, and it is still the login that was made (no second temporary password)
    const rowBefore = await userRow(secondId);
    const usersBefore = await countOf('users');
    const again = await call('POST', '/admin/v1/super-admin', { email: secondEmail.toUpperCase(), full_name: 'Second One Again' });
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json()).toEqual({ created: false, user: { id: secondId, email: secondEmail, full_name: 'Second One', role: 'owner', active: true, must_change_password: true, is_super_admin: true } });
    expect(await userRow(secondId)).toEqual(rowBefore);
    expect(await countOf('users')).toBe(usersBefore);

    const third = await call('POST', '/admin/v1/super-admin', { email: newEmail('third'), full_name: 'Third One' });
    expect([third.statusCode, errorOf(third).code, errorOf(third).message]).toEqual([409, 'JV_NOT_ALLOWED', SECOND(secondEmail)]);

    const list = (await call('GET', '/admin/v1/users')).json().users as Record<string, any>[];
    expect(list.find((u) => u.id === firstId)).toMatchObject({ is_super_admin: true, active: false });
    expect(list.find((u) => u.id === secondId)).toMatchObject({ is_super_admin: true, active: true });
  });

  it('five calls at the same moment make exactly one Super Admin: one 201 and four 409, and one flagged login is active at the end (the lock of the Owner role row, not luck: the insert is made slow)', async () => {
    await noSuperAdmin();
    const results = await whileFlaggingIsSlow(() => Promise.all(Array.from({ length: 5 }, (_, i) => call('POST', '/admin/v1/super-admin', { email: newEmail(`race${i}`), full_name: `Race ${i}` }))));
    expect(results.map((r) => r.statusCode).sort()).toEqual([201, 409, 409, 409, 409]);
    expect(await activeSuperAdmins()).toHaveLength(1);
  });

  it('a promotion and a creation at the same moment make one Super Admin too: the login that is promoted and the login that is made cannot both end up active', async () => {
    await noSuperAdmin();
    const biller = await addLogin('biller');
    const results = await whileFlaggingIsSlow(() =>
      Promise.all([call('POST', '/admin/v1/super-admin', { email: biller.email, full_name: 'Made biller' }), call('POST', '/admin/v1/super-admin', { email: newEmail('raceb'), full_name: 'Race B' })]),
    );
    expect(results.filter((r) => r.statusCode === 409), 'one of the two is refused').toHaveLength(1);
    expect(results.filter((r) => r.statusCode === 200 || r.statusCode === 201), 'and the other goes through').toHaveLength(1);
    expect(await activeSuperAdmins()).toHaveLength(1);
  });

  it('a body that is not exactly {email, full_name} is refused with 422 and nothing is written: unknown fields (role, is_super_admin, active, password), no name, a blank name, a bad e-mail, no body', async () => {
    await noSuperAdmin();
    const good = { email: newEmail('body'), full_name: 'Good Name' };
    const before = await countOf('audit_log');
    const bad: [string, unknown][] = [
      ['a role', { ...good, role: 'owner' }],
      ['is_super_admin', { ...good, is_super_admin: true }],
      ['active', { ...good, active: false }],
      ['a password', { ...good, password: 'x'.repeat(20) }],
      ['no name', { email: good.email }],
      ['a blank name', { ...good, full_name: '   ' }],
      ['a name over 120 characters', { ...good, full_name: 'n'.repeat(121) }],
      ['no e-mail', { full_name: 'Good Name' }],
      ['an e-mail without @', { ...good, email: 'nobody.example.test' }],
      ['a number for the name', { ...good, full_name: 12 }],
      ['no body at all', undefined],
    ];
    for (const [name, payload] of bad) {
      const res = await call('POST', '/admin/v1/super-admin', payload);
      expect(res.statusCode, `${name}: ${res.body}`).toBe(422);
      expect(errorOf(res).code, name).toBe('JV_INVALID_INPUT');
    }
    expect(await userByEmail(good.email)).toBeUndefined();
    expect(await countOf('audit_log')).toBe(before);
  });

  it('the terminal still manages a Super Admin login (R12): role, reset and deactivate work on it and every answer says it is one; on a role that is not the Owner\'s it still holds every tick (R4)', async () => {
    await noSuperAdmin();
    const made = await call('POST', '/admin/v1/super-admin', { email: newEmail('moved'), full_name: 'Moved Super' });
    const id = made.json().user.id as string;
    const changed = await call('POST', `/admin/v1/users/${id}/role`, { role: 'staff' });
    expect(changed.statusCode, changed.body).toBe(200);
    expect(changed.json()).toMatchObject({ user: { role: 'staff', is_super_admin: true }, previous_role: 'owner' });
    expect(await userRow(id)).toMatchObject({ role: 'staff', is_super_admin: 1 });
    const signedIn = await login(made.json().user.email, made.json().temporary_password);
    const me = (await meOf(setCookieOf(signedIn))).json().user;
    expect(me).toMatchObject({ role: 'staff', is_super_admin: true });
    expect(me.permissions, 'a flagged login on a non-owner role holds every tick').toEqual(TICK_KEYS);

    // a forgotten Super Admin password is `reset`, not a new account
    const reset = await call('POST', `/admin/v1/users/${id}/reset-password`);
    expect(reset.statusCode, reset.body).toBe(200);
    expect(reset.json()).toMatchObject({ user: { id, role: 'staff', is_super_admin: true, must_change_password: true }, sessions_ended: 1 });
    expect((await login(made.json().user.email, made.json().temporary_password)).statusCode, 'the first temporary password is gone').toBe(401);
    expect((await login(made.json().user.email, reset.json().temporary_password)).statusCode).toBe(200);

    const off = await call('POST', `/admin/v1/users/${id}/deactivate`);
    expect(off.json()).toMatchObject({ user: { id, active: false, is_super_admin: true } });
    expect(await activeSuperAdmins()).toEqual([]);
  });
});

// ------------------------------------------------------------------ activate (R13)

describe('activate refuses a login with the flag while another ACTIVE Super Admin exists (R13)', () => {
  it('409 JV_NOT_ALLOWED with the sentence naming the other e-mail, nothing written; once the other is switched off it works; the one that is active can be activated again; ordinary logins are not affected', async () => {
    await noSuperAdmin();
    const a = await world.addUser({ role: 'owner', superAdmin: true, active: false });
    const b = await world.addUser({ role: 'owner', superAdmin: true });

    const auditBefore = await countOf('audit_log');
    const refused = await call('POST', `/admin/v1/users/${a.userId}/activate`);
    expect([refused.statusCode, errorOf(refused).code, errorOf(refused).message]).toEqual([409, 'JV_NOT_ALLOWED', SECOND(b.email)]);
    expect(await userRow(a.userId)).toMatchObject({ active: 0, is_super_admin: 1 });
    expect(await countOf('audit_log'), 'a refused activation writes no row at all').toBe(auditBefore);
    expect(await auditOf(requestIdOf(refused))).toEqual([]);

    // a login without the flag is not touched by the rule while a Super Admin is active
    const biller = await addLogin('biller');
    expect((await call('POST', `/admin/v1/users/${biller.id}/deactivate`)).statusCode).toBe(200);
    expect((await call('POST', `/admin/v1/users/${biller.id}/activate`)).json()).toMatchObject({ user: { id: biller.id, active: true, is_super_admin: false } });

    // the active one is switched off: now the other may be switched on, and the first is the one refused
    expect((await call('POST', `/admin/v1/users/${b.userId}/deactivate`)).statusCode).toBe(200);
    const on = await call('POST', `/admin/v1/users/${a.userId}/activate`);
    expect(on.statusCode, on.body).toBe(200);
    expect(on.json()).toMatchObject({ user: { id: a.userId, email: a.email, active: true, is_super_admin: true, role: 'owner' } });
    expect(await activeSuperAdmins()).toEqual([a.email]);
    const again = await call('POST', `/admin/v1/users/${a.userId}/activate`);
    expect(again.statusCode, 'the only active Super Admin may be activated again').toBe(200);
    const back = await call('POST', `/admin/v1/users/${b.userId}/activate`);
    expect([back.statusCode, errorOf(back).message]).toEqual([409, SECOND(a.email)]);
    expect(await activeSuperAdmins()).toEqual([a.email]);
  });

  it('two flagged logins activated at the same moment: one is activated, the other is refused, and one flagged login is active at the end', async () => {
    await noSuperAdmin();
    const x = await world.addUser({ role: 'owner', superAdmin: true, active: false });
    const y = await world.addUser({ role: 'owner', superAdmin: true, active: false });
    const results = await whileFlaggingIsSlow(() => Promise.all([call('POST', `/admin/v1/users/${x.userId}/activate`), call('POST', `/admin/v1/users/${y.userId}/activate`)]));
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    expect(await activeSuperAdmins()).toHaveLength(1);
  });
});

// ------------------------------------------------------------------ activate and the role of the login (Review Focus 3)

describe('activate refuses a login whose role is switched off: it would be a login that is refused with a 401 on every call (Review Focus 3)', () => {
  /** The sentence of the refusal: the role by its NAME, and what to do. */
  const OFF = (name: string) => `The role ${name} is switched off. Give this login an active role first.`;
  const switchRole = (key: string, active: boolean) => world.sql.query('UPDATE roles SET active = ? WHERE role_key = ?', [active ? 1 : 0, key]);
  const roleActive = async (key: string) => Number((await world.sql.query<any[]>('SELECT active FROM roles WHERE role_key = ?', [key]))[0][0].active);

  /** A role of its own (a name nobody else has: the table keeps names apart) and a login on it that has been switched off. Each test makes its own, so none depends on another. */
  async function sleepingLogin() {
    const roleName = `Night Cashier ${randomUUID().slice(0, 8)}`;
    const role = await world.addRole({ name: roleName, ticks: ['customer_view'] });
    const made = await addLogin(role.key);
    expect((await call('POST', `/admin/v1/users/${made.id}/deactivate`)).statusCode).toBe(200);
    return { ...made, role: role.key, roleName };
  }

  it('409 JV_NOT_ALLOWED with a sentence that names the role by its NAME; the login stays switched off and nothing is written; once the role is switched on again the same call works and the login signs in', async () => {
    const asleep = await sleepingLogin();
    await switchRole(asleep.role, false);
    const usersBefore = await countOf('users');
    const auditBefore = await countOf('audit_log');

    const refused = await call('POST', `/admin/v1/users/${asleep.id}/activate`);
    expect(refused.statusCode, refused.body).toBe(409);
    expect([errorOf(refused).code, errorOf(refused).message]).toEqual(['JV_NOT_ALLOWED', OFF(asleep.roleName)]);
    expect(refused.body, 'the role is named by its name, never by its key').not.toContain(asleep.role);
    expect(await userRow(asleep.id)).toMatchObject({ active: 0, role: asleep.role });
    expect(await countOf('users')).toBe(usersBefore);
    expect(await countOf('audit_log'), 'a refused activation writes no row at all: no event, no trigger row').toBe(auditBefore);
    expect(await auditOf(requestIdOf(refused))).toEqual([]);

    await switchRole(asleep.role, true);
    const on = await call('POST', `/admin/v1/users/${asleep.id}/activate`);
    expect(on.statusCode, on.body).toBe(200);
    expect(on.json()).toEqual({ user: { id: asleep.id, email: asleep.email, full_name: `Made ${asleep.role}`, role: asleep.role, active: true, must_change_password: true, is_super_admin: false } });
    expect(await userRow(asleep.id)).toMatchObject({ active: 1 });
    const signedIn = await login(asleep.email, asleep.password);
    expect(signedIn.statusCode, signedIn.body).toBe(200);
    expect((await meOf(setCookieOf(signedIn))).json().user, 'and it is a login that works, not one that is refused for ever').toMatchObject({ role: asleep.role, role_name: asleep.roleName, permissions: ['customer_view'] });
  });

  it('a login on an ACTIVE role is activated as before, with its one event: a role the Super Admin made and a built-in one', async () => {
    const custom = await sleepingLogin();
    const biller = await addLogin('biller');
    expect((await call('POST', `/admin/v1/users/${biller.id}/deactivate`)).statusCode).toBe(200);
    for (const [name, id, role] of [
      ['a role the Super Admin made', custom.id, custom.role],
      ['a built-in role', biller.id, 'biller'],
    ] as const) {
      const on = await call('POST', `/admin/v1/users/${id}/activate`);
      expect(on.statusCode, `${name}: ${on.body}`).toBe(200);
      expect(on.json(), name).toMatchObject({ user: { id, role, active: true } });
      expect((await userRow(id)).active, name).toBe(1);
      const events = await eventsOf(requestIdOf(on));
      expect(events, name).toHaveLength(1);
      expect(asObject(events[0].new_row), name).toEqual({ event: 'admin_activate_user' });
    }
  });

  it('a login whose role has no row at all (the foreign key forbids it; a hand edit with the checks off can leave it) is refused the same way, naming the key because there is no name', async () => {
    const ghost = await withForeignKeysOff(() => world.addUser({ role: 'ghostrole', active: false }));
    const auditBefore = await countOf('audit_log');
    const refused = await call('POST', `/admin/v1/users/${ghost.userId}/activate`);
    expect(refused.statusCode, refused.body).toBe(409);
    expect([errorOf(refused).code, errorOf(refused).message]).toEqual(['JV_NOT_ALLOWED', OFF('ghostrole')]);
    expect((await userRow(ghost.userId)).active).toBe(0);
    expect(await countOf('audit_log')).toBe(auditBefore);
  });

  it('a Super Admin login on a role that is switched off is refused for its role first (the checks follow the locks: the login, its role, then the Owner row); with the role on again the guard of R13 speaks, and once the other Super Admin is off it works', async () => {
    await noSuperAdmin();
    const roleName = `Flagged Role ${randomUUID().slice(0, 8)}`;
    const role = await world.addRole({ name: roleName, ticks: [] });
    const asleep = await world.addUser({ role: role.key, superAdmin: true, active: false });
    const other = await world.addUser({ role: 'owner', superAdmin: true });
    await switchRole(role.key, false);

    const byRole = await call('POST', `/admin/v1/users/${asleep.userId}/activate`);
    expect(byRole.statusCode, byRole.body).toBe(409);
    expect(errorOf(byRole).message, 'the role is refused first, although another Super Admin is active').toBe(OFF(roleName));
    await switchRole(role.key, true);
    const byGuard = await call('POST', `/admin/v1/users/${asleep.userId}/activate`);
    expect(byGuard.statusCode, byGuard.body).toBe(409);
    expect(errorOf(byGuard).message).toBe(SECOND(other.email));
    expect((await call('POST', `/admin/v1/users/${other.userId}/deactivate`)).statusCode).toBe(200);
    const on = await call('POST', `/admin/v1/users/${asleep.userId}/activate`);
    expect(on.statusCode, on.body).toBe(200);
    expect(on.json()).toMatchObject({ user: { id: asleep.userId, role: role.key, active: true, is_super_admin: true } });
    expect(await activeSuperAdmins()).toEqual([asleep.email]);
  });

  it('activate holds the role row until it commits: a switch-off of the role from another connection waits, so the role cannot be switched off between the check and the activation', async () => {
    const asleep = await sleepingLogin();
    const other = await world.scratch.connect();
    try {
      await other.query('SET SESSION innodb_lock_wait_timeout = 1');
      // the activation sleeps 3 s holding its locks and the other connection gives up after 1 s: a wide margin, however busy the machine is
      const res = await whileActivationIsSlow(3, async () => {
        const pending = call('POST', `/admin/v1/users/${asleep.id}/activate`);
        await untilSleeping();
        await expect(other.query('UPDATE roles SET active = 0 WHERE role_key = ?', [asleep.role])).rejects.toMatchObject({ errno: 1205 });
        return pending;
      });
      expect(res.statusCode, res.body).toBe(200);
    } finally {
      await other.end();
    }
    expect(await roleActive(asleep.role), 'the switch-off never got through while the activation held the role').toBe(1);
  });
});

// ------------------------------------------------------------------ list, events

describe('list shows is_super_admin; every call writes its event and no password or hash is in the facts', () => {
  it('list: every user carries is_super_admin (true for the flagged ones, false for the rest), with the same keys', async () => {
    await noSuperAdmin();
    const plain = await addLogin('biller');
    const made = await call('POST', '/admin/v1/super-admin', { email: newEmail('listed'), full_name: 'Listed Super' });
    const list = await call('GET', '/admin/v1/users');
    expect(list.statusCode).toBe(200);
    const users = list.json().users as Record<string, any>[];
    expect(users.find((u) => u.id === plain.id)).toMatchObject({ is_super_admin: false });
    expect(users.find((u) => u.id === made.json().user.id)).toMatchObject({ is_super_admin: true, role: 'owner', active: true });
    for (const u of users) {
      expect(typeof u.is_super_admin, u.email).toBe('boolean');
      expect(Object.keys(u).sort(), u.email).toEqual(['active', 'created_at', 'email', 'full_name', 'id', 'is_super_admin', 'last_login_at', 'must_change_password', 'role']);
    }
    expect(users.filter((u) => u.is_super_admin).length).toBe(Number((await world.sql.query<any[]>('SELECT COUNT(*) AS n FROM users WHERE is_super_admin = 1'))[0][0].n));
    expect(list.body).not.toMatch(/\$argon2|\$scrypt|password_hash|"password"/i);
  });

  it('make-super-admin writes ONE event row, role admin-cli, with the facts {event, created} and nothing else; the rows the triggers write hold no password or hash; the log holds none either', async () => {
    await noSuperAdmin();
    const email = newEmail('audited');
    const created = await call('POST', '/admin/v1/super-admin', { email, full_name: 'Audited Super' });
    const id = created.json().user.id as string;
    const temporary = created.json().temporary_password as string;
    const again = await call('POST', '/admin/v1/super-admin', { email, full_name: 'Audited Super' });
    const biller = await addLogin('biller');
    await noSuperAdmin();
    const promoted = await call('POST', '/admin/v1/super-admin', { email: biller.email, full_name: 'Made biller' });
    expect([created.statusCode, again.statusCode, promoted.statusCode]).toEqual([201, 200, 200]);

    const secrets = [TOKEN, HASH, temporary, biller.password, String((await userRow(id)).password_hash), String((await userRow(biller.id)).password_hash)];
    const calls: [string, LightMyRequestResponse, string, boolean, number][] = [
      // name, answer, the row of the event, the fact `created`, how many rows the audit triggers wrote for the change
      ['a created login', created, id, true, 1],
      ['the same e-mail again', again, id, false, 0],
      ['a promoted login', promoted, biller.id, false, 1],
    ];
    for (const [name, res, rowId, createdFact, triggerRows] of calls) {
      const rows = await auditOf(requestIdOf(res));
      const events = rows.filter((r) => r.action === 'event');
      expect(events, name).toHaveLength(1);
      expect(events[0], name).toMatchObject({ actor: null, actor_role: 'admin-cli', table_name: 'users', row_id: rowId, request_id: requestIdOf(res) });
      expect(asObject(events[0].new_row), name).toEqual({ event: 'admin_make_super_admin', created: createdFact });
      expect(rows.length - 1, `${name}: the other rows are the triggers' rows for the change`).toBe(triggerRows);
      for (const r of rows) expect(r.actor_role, name).toBe('admin-cli');
      const text = JSON.stringify(rows);
      for (const s of secrets) expect(text, name).not.toContain(s);
      expect(text, name).not.toMatch(/\$argon2|\$scrypt|password_hash|temporary/);
    }
    // the promotion is in the audit trail of the login: role and flag, old and new
    const update = (await auditOf(requestIdOf(promoted))).find((r) => r.action === 'update')!;
    expect(asObject(update.old_row)).toMatchObject({ role: 'biller', is_super_admin: 0 });
    expect(asObject(update.new_row)).toMatchObject({ role: 'owner', is_super_admin: 1 });
    const log = world.logs.text();
    for (const s of secrets) expect(log).not.toContain(s);
  });

  it('a refused make-super-admin or activate leaves no event row', async () => {
    await noSuperAdmin();
    const other = (await world.addUser({ role: 'owner', superAdmin: true })).email;
    const asleep = await world.addUser({ role: 'owner', superAdmin: true, active: false });
    const refused = [
      await call('POST', '/admin/v1/super-admin', { email: newEmail('refused'), full_name: 'Refused' }),
      await call('POST', `/admin/v1/users/${asleep.userId}/activate`),
    ];
    for (const res of refused) {
      expect(res.statusCode).toBe(409);
      expect(errorOf(res).message).toBe(SECOND(other));
      expect(await auditOf(requestIdOf(res))).toEqual([]);
    }
  });
});
