import { createHash, randomBytes } from 'node:crypto';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { passwords } from '../../src/auth/password';
import { grantsOf } from '../../src/permissions/grants';
import type { Auth } from '../../src/permissions/route';
import { type EditWorld, editWorld } from './edit-support';
import { csrfHeaders, secret } from './support';

// Task 13 of the access plan (DESIGN.md 6.3, 6.6; R2, R9; Review Focus 1, 2 and 5): the ROLE WRITES of the Super Admin's own API. Four calls under /v1/super, each a row of the permission matrix of kind `super`
// (who is refused is walked in tests/api/super-escalation.test.ts):
//   POST  /v1/super/roles               create a role as a copy of another (201)
//   PATCH /v1/super/roles/:key          rename it, change its description
//   PUT   /v1/super/roles/:key/ticks    set its ticks
//   POST  /v1/super/roles/:key/active   switch it off or on
// Every write carries the Super Admin's own password (checked on the change-password path and throttled: five wrong in a row pause that Super Admin for 15 minutes) and is one transaction that locks the role row,
// compares `expected_updated_at`, writes the row, leaves the audit row of the roles table and one `event` row. The answers are typed in here as an independent oracle (the plan's tick table, the sentences of the
// brief), never read back from the code under test, except where a test says it compares with the list on purpose. A refused, stale or invalid write leaves NOTHING behind (see nothingWritten).
//
// The world is the scratch database of the edit tests (the real routes, the seeds, the generated audit triggers, a clock the test moves). The Super Admin's password is made up for this run and never printed.

const DOOR_TOKEN = randomBytes(32).toString('base64url');
const DOOR_HASH = createHash('sha256').update(DOOR_TOKEN).digest('hex');

// ------------------------------------------------------------------ the oracle, typed from the plan

const KEYS = [
  'stock_add', 'stock_edit', 'stock_status', 'category_add', 'category_edit', 'design_material', 'secret_weight',
  'photo_rewrite',
  'customer_view', 'bill_view', 'cashbook_recent', 'cashbook_all', 'customer_edit', 'customer_archive', 'bill_make', 'payment_receive', 'rate_enter', 'rate_correct', 'back_date', 'bill_cancel', 'bill_reissue', 'payment_void', 'refund_give', 'opening_balance', 'cash_over_limit',
  'order_view', 'order_edit', 'order_closed_change',
  'reports_open', 'activity_log', 'download_all',
  'settings_change',
];
/** Today's Biller and Staff as tick sets (the day-one truth of the plan). */
const BILLER = ['customer_view', 'bill_view', 'cashbook_recent', 'customer_edit', 'bill_make', 'payment_receive', 'rate_enter', 'order_view', 'order_edit'];
const STAFF = ['stock_add', 'stock_edit', 'stock_status', 'category_add', 'order_view'];
/** The words of the plan's table, for the sentences of a set that breaks a need. */
const LABEL: Record<string, string> = {
  customer_view: 'See customers (name, phone, address, GST)',
  bill_view: 'See bills, payments and customer ledgers',
  bill_make: 'Make bills and estimates',
  cashbook_recent: 'See the cash book for today and yesterday',
  cashbook_all: 'See the cash book for all days',
  customer_edit: 'Add and edit customers',
};
/** `\u201c<label>\u201d also needs \u201c<label>\u201d.` with the curly quotes written as escapes (this file is ASCII). */
const alsoNeeds = (tick: string, need: string) => `\u201c${LABEL[tick]}\u201d also needs \u201c${LABEL[need]}\u201d.`;

const OWNER_SENTENCE = 'The Owner role is fixed and cannot be changed.';
const STALE_SENTENCE = 'This role was changed by someone else. Reload it and try again.';
const CLASH_SENTENCE = 'name is already used by another role';
const WIRE_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const KEY_SHAPE = /^[a-z][a-z-]{0,11}$/;
const ROLES = '/v1/super/roles';

// ------------------------------------------------------------------ the world

interface Admin {
  userId: string;
  email: string;
  cookie: string;
}
interface Role {
  key: string;
  name: string;
  description: string;
  active: boolean;
  fixed: boolean;
  ticks: string[];
  people: number;
  updated_at: string;
}

/** Every password this file made up, so that the last test can look for them in the log and in the audit rows. */
const everyPassword: string[] = [];
function remember(p: string): string {
  everyPassword.push(p);
  return p;
}
const PASSWORD = remember(secret('Pw'));
const wrongOne = () => remember(secret('Wrong'));

let w: EditWorld;
let main: Admin;
let storedHash: string;

beforeAll(async () => {
  storedHash = await passwords.hash(PASSWORD);
  w = await editWorld('superroles', { triggers: true, config: { logLevel: 'info', adminTokenHash: DOOR_HASH } });
  await w.world.sql.query('SET SESSION group_concat_max_len = 1000000'); // the digests below hold whole tables
  await w.world.sql.query('UPDATE users SET password_hash = ? WHERE id = ?', [storedHash, w.world.fixtures.super.userId]);
  const email = ((await w.world.sql.query<any[]>('SELECT email FROM users WHERE id = ?', [w.world.fixtures.super.userId]))[0] as any[])[0].email as string;
  main = { userId: w.world.fixtures.super.userId, email, cookie: w.world.cookieOf('super') as string };
}, 120_000);
afterAll(async () => {
  await w?.world.close();
}, 60_000);

// ------------------------------------------------------------------ calls and SQL

const send = (as: Admin, method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, payload?: unknown): Promise<LightMyRequestResponse> =>
  w.world.app.inject({ method, url, headers: { ...(method === 'GET' ? {} : csrfHeaders()), cookie: as.cookie }, payload: payload as object | undefined });

const create = (body: object, as: Admin = main) => send(as, 'POST', ROLES, { password: PASSWORD, ...body });
const edit = (key: string, body: object, as: Admin = main) => send(as, 'PATCH', `${ROLES}/${key}`, { password: PASSWORD, ...body });
const setTicks = (key: string, body: object, as: Admin = main) => send(as, 'PUT', `${ROLES}/${key}/ticks`, { password: PASSWORD, ...body });
const setActive = (key: string, body: object, as: Admin = main) => send(as, 'POST', `${ROLES}/${key}/active`, { password: PASSWORD, ...body });

const errorOf = (res: LightMyRequestResponse) => (res.json() as { error: { code: string; message: string; details: Record<string, any> } }).error;
const requestIdOf = (res: LightMyRequestResponse) => String(res.headers['x-request-id']);

async function sql<T = Record<string, any>>(text: string, params: unknown[] = []): Promise<T[]> {
  const [rows] = await w.world.sql.query<any[]>(text, params);
  return rows as T[];
}
const parse = (v: unknown) => (typeof v === 'string' ? JSON.parse(v) : v);

async function listRoles(): Promise<Role[]> {
  const res = await send(main, 'GET', ROLES);
  expect(res.statusCode, res.body).toBe(200);
  return res.json().roles as Role[];
}
async function listed(key: string): Promise<Role> {
  const found = (await listRoles()).find((r) => r.key === key);
  expect(found, `role ${key} is listed`).toBeDefined();
  return found as Role;
}

/** Letters only, so that the key made from a name has no digit to lose. */
const letters = (n: number): string => Array.from(randomBytes(n), (b) => String.fromCharCode(97 + (b % 26))).join('');
/** A name no other test uses: roles are unique by name, ignoring case and accents. */
const fresh = (label = 'Role') => `${label} ${letters(8)}`;

/** A role made through the API (201), a copy of the Biller unless told otherwise. */
async function madeRole(o: { name?: string; copyOf?: string; description?: string } = {}): Promise<Role> {
  const res = await create({ copy_of: o.copyOf ?? 'biller', name: o.name ?? fresh(), ...(o.description === undefined ? {} : { description: o.description }) });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().role as Role;
}

/** A Super Admin of her own (the run of wrong passwords is counted for each Super Admin) with the same password as the fixture. */
async function newAdmin(): Promise<Admin> {
  const u = await w.world.addUser({ role: 'owner', superAdmin: true, passwordHash: storedHash });
  return { userId: u.userId, email: u.email, cookie: u.cookie };
}

/** What a refused or invalid write must leave as it found it: the audit log (the triggers write the rows of roles, and `event` rows are the code's own), users, roles, claims and the login counters. */
async function digest(): Promise<string[]> {
  const one = async (text: string) => JSON.stringify((await sql(text))[0]);
  return [
    await one('SELECT COUNT(*) AS n, MAX(id) AS last FROM audit_log'),
    await one("SELECT COUNT(*) AS n, MD5(GROUP_CONCAT(CONCAT_WS('|', id, email, full_name, role, active, is_super_admin, must_change_password, password_hash, last_login_at, updated_at) ORDER BY id)) AS d FROM users"),
    await one("SELECT COUNT(*) AS n, MD5(GROUP_CONCAT(CONCAT_WS('|', role_key, name, description, active, ticks, created_at, updated_at, created_by, updated_by) ORDER BY role_key)) AS d FROM roles"),
    await one('SELECT COUNT(*) AS n FROM sys_idempotency'),
    await one('SELECT COUNT(*) AS n FROM sys_login_attempts'),
  ];
}

/** Runs a call and proves it wrote nothing: the digest is as it was, and no statement of it changed a row but the session's own last_seen_at (U4). */
async function nothingWritten(call: () => Promise<LightMyRequestResponse>): Promise<LightMyRequestResponse> {
  const before = await digest();
  const from = w.world.spy.sent.length;
  const res = await call();
  expect(await digest(), 'the call changed the audit log, the users, the roles, the claims or the login counters').toEqual(before);
  const writes = w.world.spy
    .sqls()
    .slice(from)
    .filter((s) => /^\s*(INSERT|UPDATE|REPLACE)\b/i.test(s) && !/^UPDATE sessions SET last_seen_at/i.test(s.trim()));
  expect(writes, 'a statement of the call changed a row').toEqual([]);
  return res;
}

/** The audit rows of one request: the trigger's row of the roles table, then the `event` row; JSON columns parsed. */
async function auditOf(res: LightMyRequestResponse) {
  const rows = await sql<any>('SELECT actor, actor_role, request_id, table_name, row_id, action, old_row, new_row FROM audit_log WHERE request_id = ? ORDER BY id', [requestIdOf(res)]);
  return rows.map((r) => ({ ...r, old_row: parse(r.old_row), new_row: parse(r.new_row) })) as { actor: string | null; actor_role: string; request_id: string; table_name: string; row_id: string; action: string; old_row: any; new_row: any }[];
}
const eventsOf = async (res: LightMyRequestResponse) => (await auditOf(res)).filter((r) => r.action === 'event');

function refused(res: LightMyRequestResponse, status: number, code: string, details?: Record<string, unknown>) {
  const e = errorOf(res);
  expect([res.statusCode, e.code], res.body).toEqual([status, code]);
  if (details !== undefined) expect(e.details, res.body).toEqual(details);
  return e;
}

// ------------------------------------------------------------------ the password and its throttle (R9, DESIGN 6.6 rule 6)

describe('every write asks for the Super Admin\'s own password', () => {
  it('a wrong password is 422 on password and writes nothing; five wrong in a row pause that Super Admin for 15 minutes (429 with Retry-After); a right password clears the run', async () => {
    const admin = await newAdmin();
    const attempt = (password: string) => send(admin, 'POST', ROLES, { copy_of: 'biller', name: fresh('Throttle'), password });

    // a wrong password is a refused input (422 on `password`, the words the screen waits for), never a 401 (a 401 makes the screen drop the session), and the call writes nothing at all
    const first = await nothingWritten(() => attempt(wrongOne()));
    expect(first.statusCode).toBe(422);
    expect(first.json()).toMatchObject({ error: { code: 'JV_INVALID_INPUT', message: 'password is not correct', details: { field: 'password' } } });
    // the wrong password is refused on every one of the four calls
    const target = await madeRole();
    for (const res of [
      await nothingWritten(() => edit(target.key, { expected_updated_at: target.updated_at, changes: { name: fresh() }, password: wrongOne() }, admin)),
      await nothingWritten(() => setTicks(target.key, { expected_updated_at: target.updated_at, ticks: [], password: wrongOne() }, admin)),
      await nothingWritten(() => setActive(target.key, { expected_updated_at: target.updated_at, active: false, password: wrongOne() }, admin)),
    ]) {
      refused(res, 422, 'JV_INVALID_INPUT', { field: 'password' });
    }
    // a password that is not text, and one that is far longer than a password can be, are refused too (the long one is not even hashed)
    refused(await attempt(123 as unknown as string), 422, 'JV_INVALID_INPUT', { field: 'password' });
    const longTry = vi.spyOn(passwords, 'verify');
    try {
      const long = await attempt('x'.repeat(130));
      refused(long, 422, 'JV_INVALID_INPUT', { field: 'password' });
      expect(long.json().error.message).toBe('password is not correct'); // wrong, not invalid: it counts as a wrong try, like the login
      expect(longTry, 'a password over 128 characters is not hashed').not.toHaveBeenCalled();
    } finally {
      longTry.mockRestore();
    }

    // that was 5 wrong passwords in a row for this Super Admin (the first, the three of the other calls, and the long one, which counts and is not hashed): the fifth began the pause
    expect((await attempt(PASSWORD)).statusCode, 'the fifth wrong password in a row began the pause: even the right password is refused now').toBe(429);

    // another Super Admin has a run of her own (a fresh one keeps the arithmetic simple)
    const second = await newAdmin();
    const again = (password: string) => send(second, 'POST', ROLES, { copy_of: 'biller', name: fresh('Run'), password });
    for (let i = 0; i < 4; i++) expect((await again(wrongOne())).statusCode, `wrong ${i + 1}`).toBe(422);
    expect((await again(PASSWORD)).statusCode, 'the fifth try is the right password: not paused').toBe(201);
    // the right one cleared the run: four more wrong ones do not pause, and the right one works again
    for (let i = 0; i < 4; i++) expect((await again(wrongOne())).statusCode, `wrong ${i + 1} after the clear`).toBe(422);
    expect((await again(PASSWORD)).statusCode, 'four wrong in a row after a right one are not five').toBe(201);

    // five wrong in a row: each is 422, the fifth starts the pause
    for (let i = 0; i < 5; i++) expect((await again(wrongOne())).statusCode, `wrong ${i + 1} of five`).toBe(422);
    const verify = vi.spyOn(passwords, 'verify');
    try {
      const from = w.world.spy.sent.length;
      const paused = await nothingWritten(() => again(PASSWORD)); // the RIGHT password, while paused
      expect(paused.statusCode).toBe(429);
      expect(paused.json()).toMatchObject({ error: { code: 'JV_RATE_LIMITED', message: 'Too many requests. Try again later.', details: {} } });
      expect(paused.headers['retry-after'], 'Retry-After says the seconds left, whole').toBe('900');
      // the pause answers BEFORE the password is even looked at: nothing was hashed and the stored hash was not read
      expect(verify).not.toHaveBeenCalled();
      expect(w.world.spy.sqls().slice(from).filter((s) => /password_hash/i.test(s))).toEqual([]);
      // a wrong password while paused is 429 as well, not 422
      expect((await again(wrongOne())).statusCode).toBe(429);
      expect(verify).not.toHaveBeenCalled();
    } finally {
      verify.mockRestore();
    }

    // a pause is for that Super Admin only: a third one writes while two are paused, a paused one still reads and still signs in (the login has its own throttle)
    const third = await newAdmin();
    expect((await create({ copy_of: 'biller', name: fresh('Other') }, third)).statusCode, 'another Super Admin is not paused').toBe(201);
    expect((await send(second, 'GET', ROLES)).statusCode).toBe(200);
    const login = await w.world.app.inject({ method: 'POST', url: '/v1/auth/login', headers: csrfHeaders(), payload: { email: second.email, password: PASSWORD } });
    expect(login.statusCode, 'the login of a paused Super Admin is not paused').toBe(200);

    // time: 899 seconds on, one second is left; at 900 the pause is over, the right password works, and the run starts from zero
    w.time.time.micros += 899_000_000n;
    const almost = await again(PASSWORD);
    expect([almost.statusCode, almost.headers['retry-after']]).toEqual([429, '1']);
    w.time.time.micros += 1_000_000n;
    expect((await again(PASSWORD)).statusCode, 'the pause is over after 15 minutes').toBe(201);
    expect((await again(wrongOne())).statusCode, 'the run was cleared when the pause began').toBe(422);
    expect((await attempt(PASSWORD)).statusCode, 'the first Super Admin was paused at the same moment and is free at the same moment too').toBe(201);
  });

  it('a burst of wrong passwords started together is no way round the pause: five get "not correct", the rest 429, and the right password is 429 while paused', async () => {
    const admin = await newAdmin();
    const attempt = (password: string) => send(admin, 'POST', ROLES, { copy_of: 'staff', name: fresh('Burst'), password });
    const before = await digest();
    const answers = await Promise.all(Array.from({ length: 12 }, () => attempt(wrongOne())));
    expect(answers.filter((a) => a.statusCode === 422)).toHaveLength(5); // the answers about the password stop at the fifth wrong one, whatever order the checks finish in
    expect(answers.filter((a) => a.statusCode === 429)).toHaveLength(7);
    for (const a of answers.filter((x) => x.statusCode === 429)) expect(a.headers['retry-after']).toMatch(/^\d+$/);
    expect(await digest()).toEqual(before);
    expect((await attempt(PASSWORD)).statusCode).toBe(429);
  });

  it('the password appears in no log line, no audit row and no event fact', async () => {
    // one of every kind of outcome: a right password and a wrong one on each call, a stale copy, a refused Owner, a name clash, a paused Super Admin
    const admin = await newAdmin();
    const made = await madeRole();
    await edit(made.key, { expected_updated_at: made.updated_at, changes: { name: fresh(), description: 'about the role' } });
    const now = await listed(made.key);
    await setTicks(made.key, { expected_updated_at: now.updated_at, ticks: ['order_view'] });
    const later = await listed(made.key);
    await setActive(made.key, { expected_updated_at: later.updated_at, active: false });
    await edit(made.key, { expected_updated_at: made.updated_at, changes: { name: fresh() } }); // stale
    await edit('owner', { expected_updated_at: made.updated_at, changes: { name: 'Boss' } }); // the Owner
    await create({ copy_of: 'biller', name: made.name }); // a clash
    for (let i = 0; i < 6; i++) await send(admin, 'POST', ROLES, { copy_of: 'biller', name: fresh(), password: wrongOne() }); // wrong, then paused
    await send(admin, 'POST', ROLES, { copy_of: 'biller', name: fresh() }); // no password at all
    expect(everyPassword.length).toBeGreaterThan(5);

    const logged = w.world.logs.text();
    expect(logged.length, 'the log is on and holds the requests of this file').toBeGreaterThan(1000);
    const asText = (v: unknown) => (v === null || v === undefined ? '' : typeof v === 'string' ? v : JSON.stringify(v)); // the driver may hand a JSON column over parsed
    const audited = (await sql<{ o: unknown; n: unknown }>('SELECT old_row AS o, new_row AS n FROM audit_log')).map((r) => `${asText(r.o)}${asText(r.n)}`).join('\n');
    expect(audited.length).toBeGreaterThan(1000);
    const stored = (await sql<{ password_hash: string }>('SELECT password_hash FROM users')).map((r) => r.password_hash);
    for (const p of everyPassword) {
      expect(logged, 'a password is in the log').not.toContain(p);
      expect(audited, 'a password is in an audit row or an event fact').not.toContain(p);
    }
    // nor is the stored hash of any login (the audit shape of users leaves it out; the events never carry one)
    for (const h of stored) {
      expect(logged, 'a stored hash is in the log').not.toContain(h);
      expect(audited, 'a stored hash is in an audit row').not.toContain(h);
    }
    // no key of any event fact names a password, a hash, a token or a ticket
    const facts = await sql<{ n: string }>("SELECT new_row AS n FROM audit_log WHERE action = 'event' AND table_name = 'roles'");
    expect(facts.length).toBeGreaterThan(3);
    for (const f of facts) expect(Object.keys(parse(f.n) as object).filter((k) => /pass|hash|token|ticket|secret|cookie/i.test(k))).toEqual([]);
  });
});

// ------------------------------------------------------------------ create

describe('POST /v1/super/roles (super:roles.create)', () => {
  it('create copies the source ticks closed by needs, makes a key from the name, answers 201 and writes role_created', async () => {
    const name = `Cashier ${letters(5)}`;
    const res = await create({ copy_of: 'biller', name, description: 'Takes the counter.' });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.headers['content-type']).toMatch(/^application\/json/);
    const role = res.json().role as Role;
    expect(Object.keys(res.json())).toEqual(['role']); // { role }, nothing else: no password, no echo
    expect(Object.keys(role)).toEqual(['key', 'name', 'description', 'active', 'fixed', 'ticks', 'people', 'updated_at']); // the shape of the list
    expect(role).toMatchObject({ key: expect.stringMatching(KEY_SHAPE), name, description: 'Takes the counter.', active: true, fixed: false, ticks: BILLER, people: 0 });
    expect(role.key).toBe(`cashier-${name.slice(8).toLowerCase()}`.slice(0, 10).replace(/-+$/, '')); // lower-case letters of the name, the rest hyphens, cut to 10
    expect(role.updated_at).toMatch(WIRE_TIMESTAMP);
    expect(role).toEqual(await listed(role.key)); // the answer is the role as the list shows it

    // the row: the ticks as the source held them (the Biller's nine, already closed), stamped from the API clock (S6) by the session user
    const [row] = await sql('SELECT role_key, name, description, active, ticks, created_at, updated_at, created_by, updated_by FROM roles WHERE role_key = ?', [role.key]);
    expect(parse(row.ticks)).toEqual(BILLER);
    expect([row.created_by, row.updated_by]).toEqual([main.userId, main.userId]);
    expect(row.created_at).toBe(row.updated_at);
    expect(String(row.created_at).startsWith('2026-10-17')).toBe(true); // the fixed clock of the world, not the database's own
    expect(`${String(row.updated_at).replace(' ', 'T')}Z`).toBe(role.updated_at);

    // exactly the trigger's insert row and ONE event row, with the facts of the plan and the actor and request of the call
    const audit = await auditOf(res);
    expect(audit.map((r) => [r.table_name, r.action, r.row_id])).toEqual([['roles', 'insert', role.key], ['roles', 'event', role.key]]);
    for (const r of audit) expect([r.actor, r.actor_role, r.request_id]).toEqual([main.userId, 'owner', requestIdOf(res)]);
    expect(audit[0].old_row).toBeNull();
    expect(audit[0].new_row).toMatchObject({ role_key: role.key, name, description: 'Takes the counter.', active: 1, ticks: BILLER });
    expect(audit[1].new_row).toEqual({ event: 'role_created', role: role.key, name, copied_from: 'biller' });
  });

  it('create copies a source whose ticks do not close: the needs come with them; the Owner as source gives all 32; a switched-off role may be copied', async () => {
    // a hand-made source: bill_make and customer_edit without the ticks they need, in no order, with a key this version does not know
    const odd = await w.world.addRole({ name: fresh('Odd'), ticks: ['bill_make', 'dropped_tick', 'customer_edit'] });
    const copy = (await (await create({ copy_of: odd.key, name: fresh('Closed') })).json().role) as Role;
    expect(copy.ticks).toEqual(['customer_view', 'bill_view', 'customer_edit', 'bill_make']); // closed over needs, in catalogue order
    expect(parse((await sql('SELECT ticks FROM roles WHERE role_key = ?', [copy.key]))[0].ticks)).toEqual(copy.ticks);

    const owner = (await create({ copy_of: 'owner', name: fresh('Everything') })).json().role as Role;
    expect(owner.ticks).toEqual(KEYS);
    expect(owner.ticks).toHaveLength(32);
    expect(parse((await sql('SELECT ticks FROM roles WHERE role_key = ?', [owner.key]))[0].ticks)).toEqual(KEYS); // the 32 are stored: the copy is an ordinary role

    const off = await w.world.addRole({ name: fresh('Off'), ticks: STAFF, active: false });
    const fromOff = await create({ copy_of: off.key, name: fresh('FromOff') });
    expect(fromOff.statusCode, fromOff.body).toBe(201);
    expect(fromOff.json().role).toMatchObject({ ticks: STAFF, active: true }); // the copy starts switched on

    // a source that does not exist is 422 on copy_of (the field of the body), and writes nothing
    refused(await nothingWritten(() => create({ copy_of: 'nosuchrole', name: fresh() })), 422, 'JV_INVALID_INPUT', { field: 'copy_of' });
    // a key with a capital or a space is refused by its shape, as everywhere
    refused(await nothingWritten(() => create({ copy_of: 'Biller', name: fresh() })), 422, 'JV_INVALID_INPUT', { field: 'copy_of' });
  });

  it('role keys: Cashier -> cashier; a clash gets -x; punctuation and digits become hyphens; nothing left gives "role"; the key always matches ^[a-z][a-z-]{0,11}$', async () => {
    const { makeRoleKey } = await import('../../src/super/roleKey');
    const free = new Set<string>();
    expect(makeRoleKey('Cashier', free)).toBe('cashier');
    expect(makeRoleKey('  CASHIER  ', free)).toBe('cashier');
    expect(makeRoleKey('Cashier', new Set(['cashier']), () => 'x')).toBe('cashier-x');
    expect(makeRoleKey('Cashier', new Set(['cashier']))).toMatch(/^cashier-[a-z]$/); // the letter is drawn when none is given
    const drawn = ['x', 'x', 'y'];
    expect(makeRoleKey('Cashier', new Set(['cashier', 'cashier-x']), () => drawn.shift() as string)).toBe('cashier-y'); // x is taken too: the next letter drawn
    expect(makeRoleKey('Biller', new Set(['owner', 'biller', 'staff']), () => 'q')).toBe('biller-q');
    // punctuation and digits become hyphens, runs fold, the ends are trimmed, the key is cut to 10 characters
    expect(makeRoleKey('Front-desk 2', free)).toBe('front-desk');
    expect(makeRoleKey('Sales & Returns!', free)).toBe('sales-retu');
    expect(makeRoleKey('A1B2C3', free)).toBe('a-b-c');
    expect(makeRoleKey('Caf\u00e9 Manager', free)).toBe('cafe-manag'); // an accent is folded into its letter
    expect(makeRoleKey('abcdefghi jk', free)).toBe('abcdefghi'); // the cut falls on a hyphen: it goes
    // nothing left: `role`
    for (const name of ['123', '\u00b7\u00b7\u00b7', '', ' ', '---', '\u0436\u0435', '42 !!']) expect(makeRoleKey(name, free), JSON.stringify(name)).toBe('role');
    expect(makeRoleKey('123', new Set(['role']), () => 'z')).toBe('role-z');
    // a long name and a clash keep to 12 characters
    expect(makeRoleKey('abcdefghijklmnop', new Set(['abcdefghij']), () => 'k')).toBe('abcdefghij-k');
    // all 26 letters taken (a name like "Cashier 1" to "Cashier 27" folds to one key): the walk goes on to two letters, and an exhausted name stops with an error instead of looping for ever
    const letterTails = [...'abcdefghijklmnopqrstuvwxyz'];
    const taken = new Set(['cashier', ...letterTails.map((l) => `cashier-${l}`)]);
    expect(makeRoleKey('Cashier', taken, () => 'a')).toBe('cashier-aa');
    for (const a of letterTails) for (const b of letterTails) taken.add(`cashier-${a}${b}`);
    expect(() => makeRoleKey('Cashier', taken)).toThrow(/every role key/);
    // the shape holds for whatever a name is, with and without a clash
    const nasty = ['x', 'Zoe\u0301', '\ud83d\ude00\ud83d\ude00', 'A'.repeat(100), 'a-'.repeat(50), '\n\t', 'ALL CAPS NAME', '\u00df', '-a-', 'a--b', 'z'.repeat(10) + '-y', '\u0000', 'Ab1'.repeat(30)];
    for (const name of nasty) {
      for (const taken2 of [new Set<string>(), new Set(['role', 'x', 'zo', 'a', 'all-caps-n', 'z'.repeat(10), 'a-a-a-a-a-'.slice(0, 9)])]) {
        const key = makeRoleKey(name, taken2, () => 'm');
        expect(key, JSON.stringify(name)).toMatch(KEY_SHAPE);
        expect(taken2.has(key), `${key} is free`).toBe(false);
      }
    }

    // through the API: the key is made from the first name and never changes; a clash gets a letter; digits become hyphens; nothing left gives `role`
    const teller = await madeRole({ name: 'Teller' });
    expect(teller.key).toBe('teller');
    const second = await madeRole({ name: 'Teller 2' });
    expect(second.key).toMatch(/^teller-[a-z]$/);
    const nothing = await madeRole({ name: '123 456' });
    expect(nothing.key).toMatch(/^role(-[a-z])?$/);
    const renamed = await edit(teller.key, { expected_updated_at: teller.updated_at, changes: { name: 'Senior Teller' } });
    expect(renamed.json().role.key, 'a rename never changes the key').toBe('teller');
    for (const r of await sql<{ role_key: string }>('SELECT role_key FROM roles')) expect(r.role_key).toMatch(KEY_SHAPE);
  });

  it('names: Cashier, cashier, " Cashier " and "Cashier\u200b" are duplicates; "", "   ", "\u00b7\u00b7\u00b7" and 41 characters are 422 (Review Focus 5)', async () => {
    const label = `Dupe ${letters(6)}`;
    const first = await madeRole({ name: label });
    // every spelling the roles table takes for the same name: letter case, spaces at the ends and inside, a zero-width space, an accent
    const spellings = [label.toLowerCase(), label.toUpperCase(), ` ${label} `, `${label}\u200b`, label.replace(' ', '   '), label.replace('Dupe', 'Dup\u00e9'), `${label}\u00a0`];
    for (const name of spellings) {
      const e = refused(await nothingWritten(() => create({ copy_of: 'biller', name })), 422, 'JV_INVALID_INPUT', { field: 'name' });
      expect(e.message, JSON.stringify(name)).toBe(CLASH_SENTENCE);
    }
    expect((await listed(first.key)).name).toBe(label); // the first role is as it was made

    const invalid: [unknown, string][] = [
      ['', 'name is required'],
      ['   ', 'name is required'],
      ['\u00b7\u00b7\u00b7', 'name must contain a letter or a number'],
      ['\u200b', 'name must contain a letter or a number'],
      ['x'.repeat(41), 'name must be at most 40 characters'],
      [`ab${'\ud83d\ude00'.repeat(39)}`, 'name must be at most 40 characters'], // 41 characters, 80 code units: characters are counted, not UTF-16 units
      ['Cash\u0000ier', 'name must not contain control characters'],
      ['Cash\tier', 'name must not contain control characters'],
      ['Cash\nier', 'name must not contain control characters'],
      ['Cash\u0085ier', 'name must not contain control characters'],
      ['Cash\u007fier', 'name must not contain control characters'],
      [123, 'name must be text'],
    ];
    for (const [name, message] of invalid) {
      const e = refused(await nothingWritten(() => create({ copy_of: 'biller', name })), 422, 'JV_INVALID_INPUT', { field: 'name' });
      expect(e.message, JSON.stringify(name)).toBe(message);
    }
    expect(errorOf(await create({ copy_of: 'biller' })).message).toBe('name is required'); // no name at all

    // the edges: 40 characters is a name (so is a name of 40 characters that are 80 UTF-16 units), and the edges and inner spaces of a name are tidied
    const forty = `${letters(3)}${'\ud83d\ude00'.repeat(37)}`;
    expect([...forty]).toHaveLength(40);
    expect((await create({ copy_of: 'biller', name: forty })).statusCode).toBe(201);
    const tidy = await create({ copy_of: 'biller', name: `  ${fresh('Tidy')}  \t `.replace(' ', '   ') });
    expect(tidy.statusCode, tidy.body).toBe(201);
    expect(tidy.json().role.name).toMatch(/^Tidy [a-z]{8}$/);
    // no name is ever stored with a control character, an edge space or a run of spaces
    for (const r of await sql<{ name: string }>('SELECT name FROM roles')) expect(r.name).toBe(r.name.trim().replace(/\s+/g, ' '));
  });

  it('descriptions are optional, at most 200 characters, trimmed, and refuse control characters', async () => {
    const none = await madeRole();
    expect(none.description).toBe(''); // left out: the empty text
    expect((await madeRole({ description: '' })).description).toBe('');
    expect((await madeRole({ description: '   \t ' })).description).toBe(''); // empty after trimming: stored as the empty text
    expect((await madeRole({ description: '  Sells at the counter.  ' })).description).toBe('Sells at the counter.');
    expect((await madeRole({ description: 'd'.repeat(200) })).description).toHaveLength(200);
    expect((await madeRole({ description: 'ab'.concat('\ud83d\ude00'.repeat(198)) })).description).toHaveLength(2 + 198 * 2); // 200 characters
    for (const [description, message] of [
      ['d'.repeat(201), 'description must be at most 200 characters'],
      ['one\ntwo', 'description must not contain control characters'],
      ['one\u0000two', 'description must not contain control characters'],
      [5, 'description must be text'],
    ] as const) {
      const e = refused(await nothingWritten(() => create({ copy_of: 'biller', name: fresh(), description })), 422, 'JV_INVALID_INPUT', { field: 'description' });
      expect(e.message).toBe(message);
    }
  });
});

// ------------------------------------------------------------------ rename and describe

describe('PATCH /v1/super/roles/:key (super:roles.edit)', () => {
  it('rename changes name only: key and access stay, a signed-in person keeps working, role_renamed is written', async () => {
    const role = await madeRole({ name: fresh('Counter'), description: 'At the counter.' });
    const person = await w.world.addUser({ role: role.key });
    const meOf = () => w.world.app.inject({ method: 'GET', url: '/v1/auth/me', headers: { cookie: person.cookie } });
    const before = await meOf();
    expect(before.statusCode).toBe(200);
    const usersBefore = await sql('SELECT role, updated_at FROM users WHERE id = ?', [person.userId]);

    const to = fresh('Front');
    const res = await edit(role.key, { expected_updated_at: role.updated_at, changes: { name: to } });
    expect(res.statusCode, res.body).toBe(200);
    const after = res.json().role as Role;
    expect(Object.keys(res.json())).toEqual(['role']);
    expect(after).toMatchObject({ key: role.key, name: to, description: 'At the counter.', active: true, fixed: false, ticks: role.ticks, people: 1 });
    expect(after.updated_at).not.toBe(role.updated_at);
    expect(after).toEqual(await listed(role.key));

    // key and access stay: the person's very next call, with the same cookie, works, holds the same role key and ticks and the same access fingerprint; only the name shown is new
    const now = await meOf();
    expect(now.statusCode, now.body).toBe(200);
    const [was, is] = [before.json().user, now.json().user];
    expect([is.role, is.permissions, is.access, is.is_super_admin]).toEqual([was.role, was.permissions, was.access, was.is_super_admin]);
    expect(is.role_name).toBe(to);
    expect(was.role_name).toBe(role.name);
    expect(await sql('SELECT role, updated_at FROM users WHERE id = ?', [person.userId])).toEqual(usersBefore); // nobody's login row was touched

    // the trigger's update row and one event, role_renamed, with from and to
    const audit = await auditOf(res);
    expect(audit.map((r) => [r.table_name, r.action, r.row_id])).toEqual([['roles', 'update', role.key], ['roles', 'event', role.key]]);
    expect(audit[0].old_row).toMatchObject({ name: role.name, updated_by: main.userId });
    expect(audit[0].new_row).toMatchObject({ name: to, description: 'At the counter.', ticks: role.ticks, updated_by: main.userId });
    expect(audit[1].new_row).toEqual({ event: 'role_renamed', role: role.key, name: to, from: role.name, to });
    for (const r of audit) expect([r.actor, r.actor_role, r.request_id]).toEqual([main.userId, 'owner', requestIdOf(res)]);
  });

  it('a description is changed on its own (role_described); both together write both events; the same words again write nothing; a name that is another role\'s is 422', async () => {
    const role = await madeRole({ name: fresh('Words'), description: 'Old words.' });
    const other = await madeRole({ name: fresh('Other') });

    // description only: role_described, with the role's name as it is
    const d = await edit(role.key, { expected_updated_at: role.updated_at, changes: { description: '  New words.  ' } });
    expect(d.statusCode, d.body).toBe(200);
    expect(d.json().role).toMatchObject({ name: role.name, description: 'New words.' });
    expect((await eventsOf(d)).map((e) => e.new_row)).toEqual([{ event: 'role_described', role: role.key, name: role.name }]);

    // both: role_renamed then role_described, each with the name as it is NOW
    const to = fresh('Both');
    const both = await edit(role.key, { expected_updated_at: d.json().role.updated_at, changes: { name: to, description: 'Both words.' } });
    expect(both.statusCode, both.body).toBe(200);
    expect((await eventsOf(both)).map((e) => e.new_row)).toEqual([
      { event: 'role_renamed', role: role.key, name: to, from: role.name, to },
      { event: 'role_described', role: role.key, name: to },
    ]);
    expect((await auditOf(both)).filter((r) => r.action === 'update')).toHaveLength(1); // one change of the row, whatever the number of events

    // an empty description clears it
    const cleared = await edit(role.key, { expected_updated_at: both.json().role.updated_at, changes: { description: '' } });
    expect(cleared.json().role.description).toBe('');

    // the name another role holds, in any spelling, is 422 on name; the role's own name in another case is allowed (it is not a clash with itself)
    const stamp = (await listed(role.key)).updated_at;
    for (const name of [other.name, other.name.toUpperCase(), ` ${other.name} `]) {
      const e = refused(await nothingWritten(() => edit(role.key, { expected_updated_at: stamp, changes: { name } })), 422, 'JV_INVALID_INPUT', { field: 'name' });
      expect(e.message).toBe(CLASH_SENTENCE);
    }
    const cased = await edit(role.key, { expected_updated_at: stamp, changes: { name: to.toUpperCase() } });
    expect(cased.statusCode, cased.body).toBe(200);
    expect(cased.json().role.name).toBe(to.toUpperCase());
    expect((await eventsOf(cased)).map((e) => e.new_row)).toEqual([{ event: 'role_renamed', role: role.key, name: to.toUpperCase(), from: to, to: to.toUpperCase() }]);

    // the same words again: nothing is written, the stamp stays, the answer is the role as it is (a no-change save is not an error)
    const current = await listed(role.key);
    const same = await nothingWritten(() => edit(role.key, { expected_updated_at: current.updated_at, changes: { name: current.name, description: current.description } }));
    expect(same.statusCode, same.body).toBe(200);
    expect(same.json().role).toEqual(current);

    // no change at all is not a call: `changes` must name a field
    refused(await nothingWritten(() => edit(role.key, { expected_updated_at: current.updated_at, changes: {} })), 422, 'JV_INVALID_INPUT', { field: 'changes' });
    // the name and the description are judged by the same rules as at creation, on the same fields
    for (const [changes, field] of [[{ name: '' }, 'name'], [{ name: '\u00b7' }, 'name'], [{ name: 'x'.repeat(41) }, 'name'], [{ description: 'd'.repeat(201) }, 'description'], [{ description: 'a\nb' }, 'description']] as const) {
      refused(await nothingWritten(() => edit(role.key, { expected_updated_at: current.updated_at, changes })), 422, 'JV_INVALID_INPUT', { field });
    }
  });

  it('an unknown role is 404; a key that is not a key is 422 on key', async () => {
    const stamp = '2026-10-17T10:00:00.000000Z';
    for (const [res, code, status] of [
      [await nothingWritten(() => edit('nosuchrole', { expected_updated_at: stamp, changes: { name: fresh() } })), 'JV_NOT_FOUND', 404],
      [await nothingWritten(() => setTicks('nosuchrole', { expected_updated_at: stamp, ticks: [] })), 'JV_NOT_FOUND', 404],
      [await nothingWritten(() => setActive('nosuchrole', { expected_updated_at: stamp, active: false })), 'JV_NOT_FOUND', 404],
      [await nothingWritten(() => edit('Biller', { expected_updated_at: stamp, changes: { name: fresh() } })), 'JV_INVALID_INPUT', 422],
      [await nothingWritten(() => edit('a_b', { expected_updated_at: stamp, changes: { name: fresh() } })), 'JV_INVALID_INPUT', 422],
    ] as const) {
      expect([res.statusCode, errorOf(res).code], res.body).toEqual([status, code]);
    }
    expect(errorOf(await edit('Biller', { expected_updated_at: stamp, changes: { name: fresh() } })).details).toEqual({ field: 'key' });
    expect(errorOf(await edit('nosuchrole', { expected_updated_at: stamp, changes: { name: fresh() } })).message).toBe('There is no such role.');
  });
});

// ------------------------------------------------------------------ ticks

describe('PUT /v1/super/roles/:key/ticks (super:roles.ticks)', () => {
  it('ticks: unknown key 422; a set that breaks a need is 422 with the words and details.broken; a closed set is stored in catalogue order; role_ticks_changed lists turned_on and turned_off', async () => {
    const role = await madeRole({ name: fresh('Ticks'), copyOf: 'staff' });
    expect(role.ticks).toEqual(STAFF);
    const at = role.updated_at;

    // an unknown key: 422 on ticks, with the key in the words; a list that is not text keys, or too long, is refused too
    const unknown = refused(await nothingWritten(() => setTicks(role.key, { expected_updated_at: at, ticks: ['order_view', 'not_a_tick'] })), 422, 'JV_INVALID_INPUT', { field: 'ticks' });
    expect(unknown.message).toBe('ticks contains a tick this version does not know: not_a_tick');
    for (const bad of ['__proto__', 'Order_View', 'constructor', '']) {
      refused(await nothingWritten(() => setTicks(role.key, { expected_updated_at: at, ticks: [bad] })), 422, 'JV_INVALID_INPUT', { field: 'ticks' });
    }
    refused(await nothingWritten(() => setTicks(role.key, { expected_updated_at: at, ticks: [7] })), 422, 'JV_INVALID_INPUT', { field: 'ticks[0]' });
    refused(await nothingWritten(() => setTicks(role.key, { expected_updated_at: at, ticks: 'order_view' })), 422, 'JV_INVALID_INPUT', { field: 'ticks' });
    refused(await nothingWritten(() => setTicks(role.key, { expected_updated_at: at, ticks: Array(33).fill('order_view') })), 422, 'JV_INVALID_INPUT', { field: 'ticks' }); // at most 32
    const longKey = refused(await nothingWritten(() => setTicks(role.key, { expected_updated_at: at, ticks: ['k'.repeat(5000)] })), 422, 'JV_INVALID_INPUT', { field: 'ticks' });
    expect(longKey.message.length, 'a long key is not echoed whole').toBeLessThan(150);

    // a set that breaks a need: the words of the plan for each break, and the breaks as data
    const one = refused(await nothingWritten(() => setTicks(role.key, { expected_updated_at: at, ticks: ['cashbook_all'] })), 422, 'JV_INVALID_INPUT');
    expect(one.details).toEqual({ field: 'ticks', broken: [{ tick: 'cashbook_all', missing: ['cashbook_recent'] }] });
    expect(one.message).toBe(alsoNeeds('cashbook_all', 'cashbook_recent'));
    const many = refused(await nothingWritten(() => setTicks(role.key, { expected_updated_at: at, ticks: ['customer_edit', 'bill_make', 'cashbook_all', 'order_view'] })), 422, 'JV_INVALID_INPUT');
    expect(many.details).toEqual({
      field: 'ticks',
      broken: [
        { tick: 'cashbook_all', missing: ['cashbook_recent'] },
        { tick: 'customer_edit', missing: ['customer_view'] },
        { tick: 'bill_make', missing: ['customer_view', 'bill_view'] },
      ],
    });
    expect(many.message).toBe([alsoNeeds('cashbook_all', 'cashbook_recent'), alsoNeeds('customer_edit', 'customer_view'), alsoNeeds('bill_make', 'customer_view'), alsoNeeds('bill_make', 'bill_view')].join(' '));
    // the API refuses a broken set; it never closes one for the caller (the screen does that)
    expect((await listed(role.key)).ticks).toEqual(STAFF);

    // a closed set, sent in no order and with a repeat, is stored in catalogue order, once each
    const res = await setTicks(role.key, { expected_updated_at: at, ticks: ['order_view', 'customer_edit', 'customer_view', 'stock_add', 'customer_view'] });
    expect(res.statusCode, res.body).toBe(200);
    const after = res.json().role as Role;
    expect(Object.keys(res.json())).toEqual(['role']);
    expect(after).toMatchObject({ key: role.key, name: role.name, active: true, ticks: ['stock_add', 'customer_view', 'customer_edit', 'order_view'] });
    expect(after).toEqual(await listed(role.key));
    expect(parse((await sql('SELECT ticks FROM roles WHERE role_key = ?', [role.key]))[0].ticks)).toEqual(['stock_add', 'customer_view', 'customer_edit', 'order_view']);

    // role_ticks_changed lists what was turned on and what was turned off, in catalogue order
    const audit = await auditOf(res);
    expect(audit.map((r) => [r.table_name, r.action])).toEqual([['roles', 'update'], ['roles', 'event']]);
    expect(audit[0].old_row.ticks).toEqual(STAFF);
    expect(audit[0].new_row.ticks).toEqual(['stock_add', 'customer_view', 'customer_edit', 'order_view']);
    expect(audit[1].new_row).toEqual({ event: 'role_ticks_changed', role: role.key, name: role.name, turned_on: ['customer_view', 'customer_edit'], turned_off: ['stock_edit', 'stock_status', 'category_add'] });

    // the same set again changes nothing and writes nothing; an empty set is a role with no ticks
    const current = await listed(role.key);
    const same = await nothingWritten(() => setTicks(role.key, { expected_updated_at: current.updated_at, ticks: [...current.ticks].reverse() }));
    expect(same.statusCode, same.body).toBe(200);
    expect(same.json().role).toEqual(current);
    const empty = await setTicks(role.key, { expected_updated_at: current.updated_at, ticks: [] });
    expect(empty.json().role.ticks).toEqual([]);
    expect((await eventsOf(empty))[0].new_row).toMatchObject({ event: 'role_ticks_changed', turned_on: [], turned_off: ['stock_add', 'customer_view', 'customer_edit', 'order_view'] });
    // all 32 are a role like any other (only the Owner is fixed)
    const everything = await setTicks(role.key, { expected_updated_at: empty.json().role.updated_at, ticks: KEYS });
    expect(everything.json().role.ticks).toEqual(KEYS);
  });

  it('a tick key the code does not know, already stored: the list shows the known ones, a save works, copying drops the unknown one (Review Focus 2)', async () => {
    // written out of catalogue order and with a key a later release dropped
    const legacy = await w.world.addRole({ name: fresh('Legacy'), ticks: ['order_view', 'dropped_tick', 'stock_add'] });
    const shown = await listed(legacy.key);
    expect(shown.ticks).toEqual(['stock_add', 'order_view']); // the known ones, in catalogue order; nothing crashes

    // copying drops the unknown one: the copy holds the known ticks only, in the column too
    const copy = await create({ copy_of: legacy.key, name: fresh('Copy') });
    expect(copy.statusCode, copy.body).toBe(201);
    expect(copy.json().role.ticks).toEqual(['stock_add', 'order_view']);
    expect(parse((await sql('SELECT ticks FROM roles WHERE role_key = ?', [copy.json().role.key]))[0].ticks)).toEqual(['stock_add', 'order_view']);
    expect(parse((await sql('SELECT ticks FROM roles WHERE role_key = ?', [legacy.key]))[0].ticks), 'the source is not touched by a copy').toEqual(['order_view', 'dropped_tick', 'stock_add']);

    // a save works: the stamp of the list is enough; the unknown key leaves the column with the save, and is not named in the event (only keys of the catalogue are)
    const res = await setTicks(legacy.key, { expected_updated_at: shown.updated_at, ticks: ['stock_add', 'category_add', 'order_view'] });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().role.ticks).toEqual(['stock_add', 'category_add', 'order_view']);
    expect(parse((await sql('SELECT ticks FROM roles WHERE role_key = ?', [legacy.key]))[0].ticks)).toEqual(['stock_add', 'category_add', 'order_view']);
    expect((await eventsOf(res))[0].new_row).toEqual({ event: 'role_ticks_changed', role: legacy.key, name: shown.name, turned_on: ['category_add'], turned_off: [] });

    // a role whose column is not even a list of text keys is listed with no ticks and can be saved (the hand edit the migration's CHECK allows: a JSON array of anything)
    const messy = await w.world.addRole({ name: fresh('Messy'), ticks: [7, null, 'stock_add', { a: 1 }] as unknown as string[] });
    const messyShown = await listed(messy.key);
    expect(messyShown.ticks).toEqual(['stock_add']);
    const saved = await setTicks(messy.key, { expected_updated_at: messyShown.updated_at, ticks: ['order_view'] });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(parse((await sql('SELECT ticks FROM roles WHERE role_key = ?', [messy.key]))[0].ticks)).toEqual(['order_view']);
  });
});

// ------------------------------------------------------------------ switch off and on

describe('POST /v1/super/roles/:key/active (super:roles.active)', () => {
  it('guardrail 4: a role with active people cannot be switched off; with none it can, and on again', async () => {
    const role = await madeRole({ name: fresh('Guard') });
    const holders = [await w.world.addUser({ role: role.key }), await w.world.addUser({ role: role.key })];
    await w.world.addUser({ role: role.key, active: false }); // a login that is switched off is not a person of the role for this rule
    expect((await listed(role.key)).people).toBe(2);

    // two people: refused with the sentence, nothing written, the role stays on
    const two = refused(await nothingWritten(() => setActive(role.key, { expected_updated_at: role.updated_at, active: false })), 409, 'JV_NOT_ALLOWED', {});
    expect(two.message).toBe('2 people still have this role. Move them to another role first.');
    // one person is counted the same way
    await sql('UPDATE users SET role = ? WHERE id = ?', ['staff', holders[1].userId]);
    const one = refused(await nothingWritten(() => setActive(role.key, { expected_updated_at: role.updated_at, active: false })), 409, 'JV_NOT_ALLOWED', {});
    expect(one.message).toBe('1 people still have this role. Move them to another role first.');
    expect((await listed(role.key)).active).toBe(true);

    // nobody left: it goes off; the answer is the role as listed; the event says so; the login that was switched off does not stop it
    await sql('UPDATE users SET role = ? WHERE id = ?', ['staff', holders[0].userId]);
    const off = await setActive(role.key, { expected_updated_at: role.updated_at, active: false });
    expect(off.statusCode, off.body).toBe(200);
    expect(Object.keys(off.json())).toEqual(['role']);
    expect(off.json().role).toMatchObject({ key: role.key, name: role.name, active: false, people: 0, ticks: BILLER });
    expect(off.json().role).toEqual(await listed(role.key));
    const audit = await auditOf(off);
    expect(audit.map((r) => [r.table_name, r.action])).toEqual([['roles', 'update'], ['roles', 'event']]);
    expect([audit[0].old_row.active, audit[0].new_row.active]).toEqual([1, 0]);
    expect(audit[1].new_row).toEqual({ event: 'role_switched_off', role: role.key, name: role.name });

    // a switched-off role can be switched on again, with the new stamp; the event is role_switched_on
    const on = await setActive(role.key, { expected_updated_at: off.json().role.updated_at, active: true });
    expect(on.statusCode, on.body).toBe(200);
    expect(on.json().role).toMatchObject({ active: true });
    expect((await eventsOf(on)).map((e) => e.new_row)).toEqual([{ event: 'role_switched_on', role: role.key, name: role.name }]);
    expect((await listed(role.key)).active).toBe(true);

    // switching off a role that is off, or on one that is on, changes nothing and writes nothing
    const current = await listed(role.key);
    const already = await nothingWritten(() => setActive(role.key, { expected_updated_at: current.updated_at, active: true }));
    expect(already.statusCode).toBe(200);
    expect(already.json().role).toEqual(current);
  });

  it('switching a role off writes the role row only: once its people are moved away, no login of anybody is touched', async () => {
    const role = await madeRole({ name: fresh('Quiet') });
    const person = await w.world.addUser({ role: role.key });
    await sql('UPDATE users SET role = ? WHERE id = ?', ['biller', person.userId]);
    const usersBefore = await sql('SELECT id, role, active, updated_at FROM users ORDER BY id');
    const off = await setActive(role.key, { expected_updated_at: role.updated_at, active: false });
    expect(off.statusCode, off.body).toBe(200);
    expect(await sql('SELECT id, role, active, updated_at FROM users ORDER BY id'), 'a role switch touches no login').toEqual(usersBefore);
  });
});

// ------------------------------------------------------------------ stale copies

describe('a second tab or phone saving an old copy (Review Focus 1)', () => {
  it('a second tab saving an old copy is 409 JV_STALE with the current role and the first save stays (Review Focus 1)', async () => {
    const role = await madeRole({ name: fresh('Tabs') });
    const copyOfTab = role.updated_at;

    // the first tab saves: a new name
    const to = fresh('First');
    const first = await edit(role.key, { expected_updated_at: copyOfTab, changes: { name: to } });
    expect(first.statusCode, first.body).toBe(200);
    const current = await listed(role.key);

    // the second tab still holds the old copy: each of the four calls is refused with the role as it is now, and writes nothing, so the first save stays
    const stale: [string, () => Promise<LightMyRequestResponse>][] = [
      ['edit', () => edit(role.key, { expected_updated_at: copyOfTab, changes: { name: fresh('Second') } })],
      ['ticks', () => setTicks(role.key, { expected_updated_at: copyOfTab, ticks: ['order_view'] })],
      ['active', () => setActive(role.key, { expected_updated_at: copyOfTab, active: false })],
    ];
    for (const [what, call] of stale) {
      const res = await nothingWritten(call);
      const e = refused(res, 409, 'JV_STALE');
      expect(e.message, what).toBe(STALE_SENTENCE);
      expect(e.details, what).toEqual({ current }); // the role as the list shows it now: the first tab's name, its stamp
    }
    expect(await listed(role.key)).toEqual(current);
    expect(current.name).toBe(to);
    expect(current.ticks).toEqual(BILLER); // the second tab's ticks did not land

    // a stamp that is not the stamp of any copy is stale too (one microsecond off), and one that is not a stamp at all is 422
    const off = current.updated_at.replace(/(\d)Z$/, (_m, d: string) => `${(Number(d) + 1) % 10}Z`);
    refused(await nothingWritten(() => edit(role.key, { expected_updated_at: off, changes: { name: fresh() } })), 409, 'JV_STALE');
    refused(await nothingWritten(() => edit(role.key, { expected_updated_at: '2026-10-17 10:00:00', changes: { name: fresh() } })), 422, 'JV_INVALID_INPUT', { field: 'expected_updated_at' });
    refused(await nothingWritten(() => edit(role.key, { changes: { name: fresh() } })), 422, 'JV_INVALID_INPUT', { field: 'expected_updated_at' });

    // the current stamp works, and each save moves the stamp, so the copy before it is stale in its turn
    const next = await setTicks(role.key, { expected_updated_at: current.updated_at, ticks: ['order_view', 'customer_view'] });
    expect(next.statusCode, next.body).toBe(200);
    expect(next.json().role.updated_at).not.toBe(current.updated_at);
    refused(await nothingWritten(() => setTicks(role.key, { expected_updated_at: current.updated_at, ticks: [] })), 409, 'JV_STALE');
  });
});

// ------------------------------------------------------------------ the Owner, and a body that is not the call's

describe('the guardrails', () => {
  it('guardrail 1: the Owner role cannot be renamed, changed or switched off (409) but can be copied', async () => {
    const owner = await listed('owner');
    const ownerRow = async () => JSON.stringify(await sql('SELECT * FROM roles WHERE role_key = ?', ['owner']));
    const before = await ownerRow();
    const writes: [string, (stamp: string) => Promise<LightMyRequestResponse>][] = [
      ['rename', (s) => edit('owner', { expected_updated_at: s, changes: { name: 'Boss' } })],
      ['describe', (s) => edit('owner', { expected_updated_at: s, changes: { description: 'Not the owner.' } })],
      ['no ticks', (s) => setTicks('owner', { expected_updated_at: s, ticks: [] })],
      ['all ticks (the same as today)', (s) => setTicks('owner', { expected_updated_at: s, ticks: KEYS })],
      ['switch off', (s) => setActive('owner', { expected_updated_at: s, active: false })],
      ['switch on (it is on)', (s) => setActive('owner', { expected_updated_at: s, active: true })],
    ];
    // with the right stamp and with a stamp that is wrong: the Owner is refused first, the same way, and nothing is written
    for (const stamp of [owner.updated_at, '2001-01-01T00:00:00.000000Z']) {
      for (const [what, call] of writes) {
        const e = refused(await nothingWritten(() => call(stamp)), 409, 'JV_NOT_ALLOWED', {});
        expect(e.message, what).toBe(OWNER_SENTENCE);
      }
    }
    expect(await ownerRow()).toBe(before);
    expect(await listed('owner')).toEqual(owner);
    expect(owner).toMatchObject({ fixed: true, active: true, ticks: KEYS });

    // but it can be copied: all 32 ticks, a role like any other
    const copy = await create({ copy_of: 'owner', name: fresh('Second owner') });
    expect(copy.statusCode, copy.body).toBe(201);
    expect(copy.json().role).toMatchObject({ fixed: false, active: true, ticks: KEYS });
    expect((await eventsOf(copy))[0].new_row).toMatchObject({ event: 'role_created', copied_from: 'owner' });
    expect(await ownerRow()).toBe(before);
    // and the copy is not fixed: it can be renamed
    const renamed = await edit(copy.json().role.key, { expected_updated_at: copy.json().role.updated_at, changes: { name: fresh('Renamed') } });
    expect(renamed.statusCode, renamed.body).toBe(200);
  });

  it('guardrail 5: is_super_admin or any other unknown field in a body is 422 unknown field; a body without password is 422', async () => {
    const role = await madeRole();
    const stamp = role.updated_at;
    const calls: [string, (extra: object) => Promise<LightMyRequestResponse>, (without: string) => Promise<LightMyRequestResponse>][] = [
      [
        'create',
        (extra) => create({ copy_of: 'biller', name: fresh(), ...extra }),
        (without) => send(main, 'POST', ROLES, withoutKey({ copy_of: 'biller', name: fresh(), password: PASSWORD }, without)),
      ],
      [
        'edit',
        (extra) => edit(role.key, { expected_updated_at: stamp, changes: { name: fresh() }, ...extra }),
        (without) => send(main, 'PATCH', `${ROLES}/${role.key}`, withoutKey({ expected_updated_at: stamp, changes: { name: fresh() }, password: PASSWORD }, without)),
      ],
      [
        'ticks',
        (extra) => setTicks(role.key, { expected_updated_at: stamp, ticks: ['order_view'], ...extra }),
        (without) => send(main, 'PUT', `${ROLES}/${role.key}/ticks`, withoutKey({ expected_updated_at: stamp, ticks: ['order_view'], password: PASSWORD }, without)),
      ],
      [
        'active',
        (extra) => setActive(role.key, { expected_updated_at: stamp, active: false, ...extra }),
        (without) => send(main, 'POST', `${ROLES}/${role.key}/active`, withoutKey({ expected_updated_at: stamp, active: false, password: PASSWORD }, without)),
      ],
    ];
    for (const [what, withExtra, withoutField] of calls) {
      // the flag, and anything else the call does not take: refused by name, nothing written, and the flag stays where the terminal put it
      for (const field of ['is_super_admin', 'role', 'created_by', 'updated_at', 'fixed']) {
        const res = await nothingWritten(() => withExtra({ [field]: true }));
        const e = refused(res, 422, 'JV_INVALID_INPUT', { field });
        expect(e.message, `${what} ${field}`).toBe(`${field} is not a field this call accepts`);
      }
      // no password: 422 on password, and the write does not happen
      const e = refused(await nothingWritten(() => withoutField('password')), 422, 'JV_INVALID_INPUT', { field: 'password' });
      expect(e.message, what).toBe('password is required');
      expect(errorOf(await nothingWritten(() => withExtra({ password: '' }))).details).toEqual({ field: 'password' }); // an empty password is no password
    }
    // inside `changes`, an unknown key is refused as well, by its path
    const nested = refused(await nothingWritten(() => edit(role.key, { expected_updated_at: stamp, changes: { name: fresh(), is_super_admin: true } })), 422, 'JV_INVALID_INPUT', { field: 'changes.is_super_admin' });
    expect(nested.message).toBe('changes.is_super_admin is not a field this call accepts');
    // `active` must be a boolean; the stamp, the key of the copy and the list of ticks are judged by their shape before anything is asked of the database
    refused(await nothingWritten(() => setActive(role.key, { expected_updated_at: stamp, active: 'no' })), 422, 'JV_INVALID_INPUT', { field: 'active' });
    refused(await nothingWritten(() => setActive(role.key, { active: false })), 422, 'JV_INVALID_INPUT', { field: 'expected_updated_at' });
    // (every call above went through nothingWritten, whose digest of the users table holds the flag of every login: no body can set, change or clear it)
  });

  it('each write checks the caller again at its start (X0 item 2): grants that are not the Super Admin\'s are refused before the application, the request or the database is touched', async () => {
    const { createRole, editRole, setRoleActive, setRoleTicks } = await import('../../src/super/roles');
    const untouched = new Proxy({}, {
      get(_t, prop) {
        throw new Error(`touched ${String(prop)}`);
      },
    });
    const as = (grants: ReturnType<typeof grantsOf>) => ({ user: { grants }, session: {} }) as unknown as Auth;
    const body = { password: 'not-used' };
    const owner = as(grantsOf({ roleKey: 'owner', roleTicks: [], isSuperAdmin: false }));
    const everything = as(grantsOf({ roleKey: 'made-up', roleTicks: KEYS, isSuperAdmin: false }));
    for (const who of [owner, everything]) {
      for (const call of [
        () => createRole(untouched as never, untouched as never, who, { copy_of: 'biller', name: 'x', ...body }),
        () => editRole(untouched as never, untouched as never, who, 'biller', { expected_updated_at: '2026-10-17T10:00:00.000000Z', changes: { name: 'x' }, ...body }),
        () => setRoleTicks(untouched as never, untouched as never, who, 'biller', { expected_updated_at: '2026-10-17T10:00:00.000000Z', ticks: [], ...body }),
        () => setRoleActive(untouched as never, untouched as never, who, 'biller', { expected_updated_at: '2026-10-17T10:00:00.000000Z', active: false, ...body }),
      ]) {
        const err = (await call().then(
          () => undefined,
          (e: unknown) => e,
        )) as { code?: string; status?: number; message?: string } | undefined;
        expect([err?.code, err?.status, err?.message]).toEqual(['JV_FORBIDDEN', 403, 'You are not allowed to do this.']);
      }
    }
  });

  it('readRole, the read behind every answer, is the same wall as the list: refused for grants that are not the Super Admin\'s before the database is asked; for the Super Admin it is the list\'s own row', async () => {
    const { readRole } = await import('../../src/super/queries');
    const asked: string[] = [];
    const reader = {
      rows: async (text: string) => {
        asked.push(text);
        return [];
      },
    };
    for (const grants of [grantsOf({ roleKey: 'owner', roleTicks: [], isSuperAdmin: false }), grantsOf({ roleKey: 'made-up', roleTicks: KEYS, isSuperAdmin: false })]) {
      const err = (await readRole(reader, grants, 'biller').then(
        () => undefined,
        (e: unknown) => e,
      )) as { code?: string } | undefined;
      expect(err?.code).toBe('JV_FORBIDDEN');
    }
    expect(asked, 'a refused read asked the database something').toEqual([]);
    expect(await readRole(reader, grantsOf({ roleKey: 'owner', roleTicks: [], isSuperAdmin: true }), 'nosuchrole')).toBeUndefined(); // no such role: undefined, not an error
    expect(asked).toHaveLength(1);
    // the same SELECT as the list, narrowed to one key (so the answer of a write can never differ from the list's row)
    const from = w.world.spy.sent.length;
    await listRoles();
    const list = w.world.spy.sqls().slice(from).find((s) => /^SELECT r\.role_key, r\.name/.test(s)) as string;
    expect(list, 'the list statement was seen').toMatch(/ORDER BY r\.created_at, r\.role_key$/);
    expect(asked[0]).toBe(`${list.replace(/ ORDER BY .*$/, '')} WHERE r.role_key = ?`);
  });
});

/** The body without one of its keys. */
function withoutKey(body: Record<string, unknown>, key: string): Record<string, unknown> {
  const { [key]: _gone, ...rest } = body;
  return rest;
}

// ------------------------------------------------------------------ the answers are the list; the order of the locks; the races

describe('what a write answers, and the order in which it takes its locks', () => {
  it('every write answers { role } exactly as GET /v1/super/roles lists the role, with the people counted as the list counts them', async () => {
    const role = await madeRole({ name: fresh('Same') });
    await w.world.addUser({ role: role.key });
    await w.world.addUser({ role: role.key });
    const answers = [
      await edit(role.key, { expected_updated_at: role.updated_at, changes: { description: 'Same as the list.' } }),
    ];
    answers.push(await setTicks(role.key, { expected_updated_at: answers[0].json().role.updated_at, ticks: ['stock_add', 'order_view'] }));
    answers.push(await edit(role.key, { expected_updated_at: answers[1].json().role.updated_at, changes: { name: fresh('Again') } }));
    for (const res of answers) {
      expect(res.statusCode, res.body).toBe(200);
      expect(Object.keys(res.json())).toEqual(['role']);
    }
    const last = answers[2].json().role as Role;
    expect(last).toEqual(await listed(role.key));
    expect(last.people).toBe(2);
    // the created role too, and a stale answer carries the same row as `details.current`
    const made = await create({ copy_of: role.key, name: fresh('Born') });
    expect(made.json().role).toEqual(await listed(made.json().role.key));
    const stale = errorOf(await edit(role.key, { expected_updated_at: role.updated_at, changes: { name: fresh() } }));
    expect(stale.details.current).toEqual(await listed(role.key));
  });

  it('lock order: the password is read before the transaction; inside it the role row is the only row locked, the people are counted by a plain read after that lock, and no login row is locked after it', async () => {
    const role = await madeRole({ name: fresh('Order') });
    let stamp = role.updated_at;
    const steps: [string, () => Promise<LightMyRequestResponse>][] = [
      ['create', () => create({ copy_of: role.key, name: fresh('Child') })],
      ['edit', () => edit(role.key, { expected_updated_at: stamp, changes: { name: fresh('Renamed') } })],
      ['ticks', () => setTicks(role.key, { expected_updated_at: stamp, ticks: ['order_view'] })],
      ['switch off', () => setActive(role.key, { expected_updated_at: stamp, active: false })],
      ['switch on', () => setActive(role.key, { expected_updated_at: stamp, active: true })],
    ];
    for (const [what, call] of steps) {
      const from = w.world.spy.sent.length;
      const res = await call();
      expect([200, 201], `${what}: ${res.body}`).toContain(res.statusCode);
      if (what !== 'create') stamp = res.json().role.updated_at;
      const sent = w.world.spy.sqls().slice(from);
      const begin = sent.indexOf('START TRANSACTION');
      const hashRead = sent.findIndex((s) => /^SELECT password_hash FROM users WHERE id = \?$/.test(s.trim()));
      expect(begin, `${what}: one transaction`).toBeGreaterThan(-1);
      expect(hashRead, `${what}: the password is read (a plain read) ...`).toBeGreaterThan(-1);
      expect(hashRead, `${what}: ... before the transaction begins`).toBeLessThan(begin);
      const locking = sent.map((s, i) => [s, i] as const).filter(([s]) => /\bFOR UPDATE\b/i.test(s));
      expect(locking, `${what}: one locking read`).toHaveLength(1);
      expect(locking[0][0].replace(/\s+/g, ' '), `${what}: it locks the role row by its key`).toMatch(/^SELECT [a-z_, ]+ FROM roles WHERE role_key = \? FOR UPDATE$/);
      const lockAt = locking[0][1];
      expect(lockAt, `${what}: the lock is inside the transaction`).toBeGreaterThan(begin);
      expect(sent.some((s) => /\bFROM\s+users\b/i.test(s) && /\bFOR UPDATE\b/i.test(s)), `${what}: no login row is locked`).toBe(false);
      const firstWrite = sent.findIndex((s) => /^\s*(INSERT INTO roles|UPDATE roles)\b/i.test(s));
      expect(firstWrite, `${what}: the role is written after its lock`).toBeGreaterThan(lockAt);
      if (what === 'switch off') {
        const count = sent.findIndex((s) => /^SELECT COUNT\(\*\) AS n FROM users WHERE role = \? AND active = 1$/.test(s.trim()));
        expect(count, 'the people are counted').toBeGreaterThan(-1);
        expect(count, 'the people are counted AFTER the role is locked').toBeGreaterThan(lockAt);
        expect(count, 'and BEFORE the role is written').toBeLessThan(firstWrite);
      }
    }
  });

  /** The slow triggers of the race tests: a statement sleeps inside the database, so that two calls overlap for sure. Dropped again whatever happens. */
  async function withTrigger<T>(name: string, ddl: string, run: () => Promise<T>): Promise<T> {
    await w.world.sql.query(`DROP TRIGGER IF EXISTS ${name}`);
    await w.world.sql.query(ddl);
    try {
      return await run();
    } finally {
      await w.world.sql.query(`DROP TRIGGER IF EXISTS ${name}`);
    }
  }
  async function until(what: string, ready: () => Promise<boolean>): Promise<void> {
    for (let i = 0; i < 300; i++) {
      if (await ready()) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`never reached: ${what}`);
  }
  const sleeping = async () => Number((await sql<{ n: string }>("SELECT COUNT(*) AS n FROM information_schema.PROCESSLIST WHERE STATE LIKE 'User sleep%'"))[0].n) > 0;
  /** A transaction of this database waits for a row lock now (read as root: the ten-box user cannot see other sessions). */
  async function lockWaiting(): Promise<boolean> {
    const root = await w.world.scratch.root();
    try {
      const [rows] = await root.query<any[]>("SELECT COUNT(*) AS n FROM information_schema.INNODB_TRX WHERE trx_state = 'LOCK WAIT' AND trx_query LIKE '%FROM roles%'");
      return Number((rows as any[])[0].n) > 0;
    } finally {
      await root.end();
    }
  }
  let doorCalls = 0;
  const door = (url: string, payload: object) =>
    w.world.app.inject({ method: 'POST', url, payload, headers: { authorization: `Bearer ${DOOR_TOKEN}`, 'x-real-ip': `198.51.${Math.floor(++doorCalls / 250)}.${(doorCalls % 250) + 1}` } });

  it('lock order against the terminal door: a login given this role while it is being switched off is counted (the switch-off waits for the door\'s lock and refuses), and a login given the role after it is refused', async () => {
    // A. the door holds the role row (it is inside its INSERT of the login, which the database is made to hold for two seconds); the switch-off arrives, WAITS for that lock, and then counts the new login
    const a = await madeRole({ name: fresh('RaceA') });
    const emailA = `race-a-${letters(6)}@example.test`;
    await withTrigger('trg_test_slow_login', "CREATE TRIGGER trg_test_slow_login BEFORE INSERT ON users FOR EACH ROW BEGIN IF NEW.full_name = 'Slow Newcomer' THEN DO SLEEP(2.5); END IF; END", async () => {
      const adding = door('/admin/v1/users', { email: emailA, full_name: 'Slow Newcomer', role: a.key });
      await until('the door call is inside its slow insert', sleeping);
      const switching = setActive(a.key, { expected_updated_at: a.updated_at, active: false });
      await until('the switch-off waits for the role row', lockWaiting);
      const [added, off] = await Promise.all([adding, switching]);
      expect(added.statusCode, added.body).toBe(201);
      const e = refused(off, 409, 'JV_NOT_ALLOWED', {});
      expect(e.message).toBe('1 people still have this role. Move them to another role first.');
    });
    expect((await listed(a.key)).active, 'the role is still on').toBe(true);
    expect(await sql('SELECT role, active FROM users WHERE email = ?', [emailA])).toEqual([{ role: a.key, active: 1 }]);

    // B. the switch-off holds the role row (inside its UPDATE, held for two seconds, after it counted nobody); the door arrives, WAITS for the lock, then finds the role off and refuses: no login ends up on a switched-off role
    const b = await madeRole({ name: fresh('RaceB') });
    const emailB = `race-b-${letters(6)}@example.test`;
    await withTrigger('trg_test_slow_off', 'CREATE TRIGGER trg_test_slow_off BEFORE UPDATE ON roles FOR EACH ROW BEGIN IF OLD.active = 1 AND NEW.active = 0 THEN DO SLEEP(2.5); END IF; END', async () => {
      const switching = setActive(b.key, { expected_updated_at: b.updated_at, active: false });
      await until('the switch-off is inside its slow update', sleeping);
      const adding = door('/admin/v1/users', { email: emailB, full_name: 'Late Newcomer', role: b.key });
      await until('the door call waits for the role row', lockWaiting);
      const [off, added] = await Promise.all([switching, adding]);
      expect(off.statusCode, off.body).toBe(200);
      const e = refused(added, 422, 'JV_INVALID_INPUT', { field: 'role' });
      expect(e.message).toBe('role is not an active role');
    });
    expect((await listed(b.key)).active).toBe(false);
    expect(await sql('SELECT id FROM users WHERE email = ?', [emailB]), 'no login was made').toEqual([]);
    // the invariant, over the whole database: no active login holds a role that is switched off
    expect(await sql('SELECT u.id FROM users u JOIN roles r ON r.role_key = u.role WHERE u.active = 1 AND r.active = 0')).toEqual([]);
  }, 60_000);

  it('two roles made at the same moment: the same key is chosen again by the one that lost (no 500), the same name in two spellings is 422 on name (the database\'s 1062 under the race)', async () => {
    const slow = 'slow race';
    await withTrigger('trg_test_slow_role', `CREATE TRIGGER trg_test_slow_role BEFORE INSERT ON roles FOR EACH ROW BEGIN IF NEW.description = '${slow}' THEN DO SLEEP(0.6); END IF; END`, async () => {
      // different sources, so that the two calls do not queue on the lock of one source row and really overlap
      // 1. two names that fold to one key: both read the keys before either has inserted; the loser is refused by the PRIMARY key, and chooses again
      const stem = letters(5);
      const [x, y] = await Promise.all([
        create({ copy_of: 'biller', name: `${stem} 1`, description: slow }),
        create({ copy_of: 'staff', name: `${stem} 2`, description: slow }),
      ]);
      expect([x.statusCode, y.statusCode], `${x.body} ${y.body}`).toEqual([201, 201]);
      const keys = [x.json().role.key, y.json().role.key].sort();
      expect(keys[0]).toBe(stem);
      expect(keys[1]).toMatch(new RegExp(`^${stem}-[a-z]$`));
      expect(x.json().role.key).not.toBe(y.json().role.key);

      // 2. one name in two spellings the table takes for the same (a zero-width space is ignorable), with keys that differ: both pass the check for a clash, the second INSERT meets the unique key uq_roles_name
      const word = letters(7);
      const [p, q] = await Promise.all([
        create({ copy_of: 'biller', name: word, description: slow }),
        create({ copy_of: 'staff', name: `${word.slice(0, 3)}\u200b${word.slice(3)}`, description: slow }),
      ]);
      const statuses = [p.statusCode, q.statusCode].sort();
      expect(statuses, `${p.body} ${q.body}`).toEqual([201, 422]);
      const loser = p.statusCode === 422 ? p : q;
      const e = refused(loser, 422, 'JV_INVALID_INPUT', { field: 'name' });
      expect(e.message, 'the same words as the check made first').toBe(CLASH_SENTENCE);
      expect(await sql('SELECT role_key FROM roles WHERE name = ?', [word])).toHaveLength(1);
    });
  }, 60_000);

  it('a rename that meets the unique key under a race is 422 on name too', async () => {
    const one = await madeRole({ name: fresh('RenA') });
    const two = await madeRole({ name: fresh('RenB') });
    const target = fresh('Target');
    await withTrigger('trg_test_slow_rename', `CREATE TRIGGER trg_test_slow_rename BEFORE UPDATE ON roles FOR EACH ROW BEGIN IF NEW.name = '${target}' OR NEW.name = '${target}x' THEN DO SLEEP(0.6); END IF; END`, async () => {
      const [a, b] = await Promise.all([
        edit(one.key, { expected_updated_at: one.updated_at, changes: { name: target } }),
        edit(two.key, { expected_updated_at: two.updated_at, changes: { name: target.toUpperCase() } }),
      ]);
      expect([a.statusCode, b.statusCode].sort(), `${a.body} ${b.body}`).toEqual([200, 422]);
      const loser = a.statusCode === 422 ? a : b;
      expect(refused(loser, 422, 'JV_INVALID_INPUT', { field: 'name' }).message).toBe(CLASH_SENTENCE);
    });
  }, 60_000);
});

// ------------------------------------------------------------------ the node writer writes what the trigger writes

describe('the audit rows of the roles table in both mechanisms (L1)', () => {
  it('with JV_AUDIT_MODE=node (no triggers) the four writes leave the same rows and events the triggers leave', async () => {
    const node = await editWorld('superrolesn', { config: { auditMode: 'node', logLevel: 'warn' } });
    try {
      const nodeAdmin = node.world.fixtures.super.userId;
      await node.world.sql.query('UPDATE users SET password_hash = ? WHERE id = ?', [storedHash, nodeAdmin]);
      const nodeSend = (method: 'POST' | 'PUT' | 'PATCH', url: string, payload: object) =>
        node.world.app.inject({ method, url, headers: { ...csrfHeaders(), cookie: node.world.cookieOf('super') as string }, payload });

      // the same sequence in the node world and in the world with the triggers: create, rename, describe, ticks, off, on
      const run = async (post: (m: 'POST' | 'PUT' | 'PATCH', url: string, payload: object) => Promise<LightMyRequestResponse>, label: string) => {
        const made = await post('POST', ROLES, { copy_of: 'biller', name: `Twin ${label}`, description: 'First.', password: PASSWORD });
        expect(made.statusCode, made.body).toBe(201);
        const key = made.json().role.key as string;
        let stamp = made.json().role.updated_at as string;
        for (const [method, url, body] of [
          ['PATCH', `${ROLES}/${key}`, { changes: { name: `Twin ${label} Two` } }],
          ['PATCH', `${ROLES}/${key}`, { changes: { description: 'Second.' } }],
          ['PUT', `${ROLES}/${key}/ticks`, { ticks: ['order_view', 'customer_view'] }],
          ['POST', `${ROLES}/${key}/active`, { active: false }],
          ['POST', `${ROLES}/${key}/active`, { active: true }],
        ] as const) {
          const res = await post(method, url, { expected_updated_at: stamp, ...body, password: PASSWORD });
          expect(res.statusCode, res.body).toBe(200);
          stamp = res.json().role.updated_at;
        }
        return key;
      };
      const nodeKey = await run(nodeSend, 'Node');
      const triggerKey = await run((m, url, payload) => send(main, m, url, payload), 'Node'); // the same names: unique in their own database
      expect(nodeKey).toBe(triggerKey);

      // what each database holds in audit_log for that role, with the ids and the stamps masked (the two worlds have other users and other moments)
      const rowsOf = async (query: <T>(text: string, params?: unknown[]) => Promise<T[]>, admin: string) => {
        const rows = await query<any>("SELECT actor, actor_role, table_name, row_id, action, old_row, new_row FROM audit_log WHERE table_name = 'roles' AND row_id = ? ORDER BY id", [nodeKey]);
        const masked = JSON.stringify(rows.map((r) => ({ ...r, old_row: parse(r.old_row), new_row: parse(r.new_row) })))
          .split(admin)
          .join('<admin>')
          .replace(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}/g, '<time>');
        return JSON.parse(masked) as any[];
      };
      const nodeRows = await rowsOf(async (text, params = []) => (await node.world.sql.query<any[]>(text, params))[0] as any[], nodeAdmin);
      const triggerRows = await rowsOf(sql, main.userId);
      expect(nodeRows.map((r) => `${r.action}`)).toEqual(['insert', 'event', 'update', 'event', 'update', 'event', 'update', 'event', 'update', 'event', 'update', 'event']);
      expect(nodeRows).toEqual(triggerRows);
      expect(nodeRows[0].new_row).toMatchObject({ role_key: nodeKey, name: 'Twin Node', ticks: BILLER, created_by: '<admin>', updated_by: '<admin>' });
      // the Node writer wrote the row changes (insert and update) and the code wrote the events: both are there, once each
      expect(nodeRows.filter((r) => r.action !== 'event')).toHaveLength(6);
      expect(nodeRows.filter((r) => r.action === 'event')).toHaveLength(6);
    } finally {
      await node.world.close();
    }
  }, 120_000);
});
