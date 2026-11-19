import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { passwords } from '../../src/auth/password';
import { grantsOf } from '../../src/permissions/grants';
import { MATRIX } from '../../src/permissions/matrix';
import type { Auth } from '../../src/permissions/route';
import { type EditWorld, editWorld } from './edit-support';
import { REPO, csrfHeaders, secret } from './support';

// Task 14 of the access plan (DESIGN.md 6.3 and 6.6 rules 2 and 6; R9, R11, R12; Review Focus 3 and 4; P6, A8): the PEOPLE WRITES of the Super Admin's own API. Five calls under /v1/super/people, each a row of the
// permission matrix of kind `super` (who is refused is walked in tests/api/super-escalation.test.ts):
//   POST  /v1/super/people                        add a person with a role: a temporary password shown once (201)
//   PATCH /v1/super/people/:id                    edit the name and/or the e-mail
//   POST  /v1/super/people/:id/role               change the role
//   POST  /v1/super/people/:id/active             switch off (every session ends) or on (the role must be on)
//   POST  /v1/super/people/:id/reset-password     a new temporary password, shown once; every session ends
// Every write carries the Super Admin's own password (the same run of wrong passwords as the role writes of tests/api/super-roles.test.ts) and is one transaction that locks the person's row first, writes, leaves the
// audit row of the users table and one `event` row, and answers `{ person }` exactly as GET /v1/super/people lists that person. The answers and the sentences are typed in here as an independent oracle (the plan, the
// brief), never read back from the code under test, except where a test says it compares with the list on purpose. A refused, invalid or no-change write leaves NOTHING behind (see nothingWritten: users, sessions,
// roles, audit log, claims, login counters).
//
// The world is the scratch database of the edit tests (the real routes, the seeds, the generated audit triggers, a clock the test moves). Every password of this file is made up for this run and never printed.

const DOOR_TOKEN = randomBytes(32).toString('base64url');
const DOOR_HASH = createHash('sha256').update(DOOR_TOKEN).digest('hex');

// ------------------------------------------------------------------ the oracle, typed from the plan and the brief

const BILLER = ['customer_view', 'bill_view', 'cashbook_recent', 'customer_edit', 'bill_make', 'payment_receive', 'rate_enter', 'order_view', 'order_edit'];
const SUPER_SENTENCE = 'A Super Admin login is managed in the terminal.';
const ROLE_OFF_SENTENCE = 'Its role is switched off. Change the role first.';
const TAKEN_SENTENCE = 'email is already used by another user';
const NOT_ACTIVE_ROLE_SENTENCE = 'role is not an active role';
const WIRE_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const TEMPORARY = /^[A-HJ-NP-Za-km-z2-9]{4}(-[A-HJ-NP-Za-km-z2-9]{4}){3}$/; // the shape the terminal door's temporary password has: four groups of four, no look-alikes
const PERSON_KEYS = ['id', 'full_name', 'email', 'role', 'role_name', 'active', 'is_super_admin', 'last_login_at', 'updated_at'];
const PEOPLE = '/v1/super/people';
/** The five rows of the matrix this task gives a route, typed from the plan. */
const FIVE = [
  'POST /v1/super/people super:people.add',
  'PATCH /v1/super/people/:id super:people.edit',
  'POST /v1/super/people/:id/role super:people.role',
  'POST /v1/super/people/:id/active super:people.active',
  'POST /v1/super/people/:id/reset-password super:people.reset',
];

// ------------------------------------------------------------------ the world

interface Admin {
  userId: string;
  email: string;
  cookie: string;
}
interface Person {
  id: string;
  full_name: string;
  email: string;
  role: string;
  role_name: string;
  active: boolean;
  is_super_admin: boolean;
  last_login_at: string | null;
  updated_at: string;
}

/** Every password this file made up (the Super Admin's, the wrong ones, every temporary password the API showed), so that a test can look for them in the log and in the audit rows. */
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
  w = await editWorld('superpeople', { triggers: true, config: { logLevel: 'info', adminTokenHash: DOOR_HASH } });
  await w.world.sql.query('SET SESSION group_concat_max_len = 1000000'); // the digests below hold whole tables
  await w.world.sql.query('UPDATE users SET password_hash = ? WHERE id = ?', [storedHash, w.world.fixtures.super.userId]);
  const email = ((await w.world.sql.query<any[]>('SELECT email FROM users WHERE id = ?', [w.world.fixtures.super.userId]))[0] as any[])[0].email as string;
  main = { userId: w.world.fixtures.super.userId, email, cookie: w.world.cookieOf('super') as string };
}, 120_000);
afterAll(async () => {
  await w?.world.close();
}, 60_000);
// every user may make 300 calls a minute (A13) in the API's own clock, which a test moves and which otherwise stands almost still: each test starts a minute later, so that none of them is paced by the calls of those before it
beforeEach(() => {
  w.time.time.micros += 61_000_000n;
});

// ------------------------------------------------------------------ calls and SQL

const send = (as: Admin, method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, payload?: unknown): Promise<LightMyRequestResponse> =>
  w.world.app.inject({ method, url, headers: { ...(method === 'GET' ? {} : csrfHeaders()), cookie: as.cookie }, payload: payload as object | undefined });

/** Every temporary password an answer shows is remembered, so that the last test can look for it in the log and in the audit rows. */
async function shown(res: LightMyRequestResponse): Promise<LightMyRequestResponse> {
  const temporary = res.statusCode < 300 ? (res.json() as { temporary_password?: unknown }).temporary_password : undefined;
  if (typeof temporary === 'string') remember(temporary);
  return res;
}
const addPerson = async (body: object, as: Admin = main) => shown(await send(as, 'POST', PEOPLE, { password: PASSWORD, ...body }));
const editPerson = (id: string, body: object, as: Admin = main) => send(as, 'PATCH', `${PEOPLE}/${id}`, { password: PASSWORD, ...body });
const setRole = (id: string, body: object, as: Admin = main) => send(as, 'POST', `${PEOPLE}/${id}/role`, { password: PASSWORD, ...body });
const setActive = (id: string, body: object, as: Admin = main) => send(as, 'POST', `${PEOPLE}/${id}/active`, { password: PASSWORD, ...body });
const resetPassword = async (id: string, body: object = {}, as: Admin = main) => shown(await send(as, 'POST', `${PEOPLE}/${id}/reset-password`, { password: PASSWORD, ...body }));

const errorOf = (res: LightMyRequestResponse) => (res.json() as { error: { code: string; message: string; details: Record<string, any> } }).error;
const requestIdOf = (res: LightMyRequestResponse) => String(res.headers['x-request-id']);

async function sql<T = Record<string, any>>(text: string, params: unknown[] = []): Promise<T[]> {
  const [rows] = await w.world.sql.query<any[]>(text, params);
  return rows as T[];
}
const parse = (v: unknown) => (typeof v === 'string' ? JSON.parse(v) : v);

const login = (email: string, password: string) => w.world.app.inject({ method: 'POST', url: '/v1/auth/login', headers: csrfHeaders(), payload: { email, password } });
/** The cookie a login answered with, as a Cookie header. */
const cookieOfLogin = (res: LightMyRequestResponse): string => String(([] as string[]).concat(res.headers['set-cookie'] as string | string[])[0]).split(';')[0];
const meOf = (cookie: string) => w.world.app.inject({ method: 'GET', url: '/v1/auth/me', headers: { cookie } });
const pollOf = (cookie: string) => w.world.app.inject({ method: 'POST', url: '/v1/sync/poll', headers: { ...csrfHeaders(), cookie }, payload: { cursors: { 'daily-rates': null } } });

async function listPeople(): Promise<Person[]> {
  const res = await send(main, 'GET', PEOPLE);
  expect(res.statusCode, res.body).toBe(200);
  return res.json().people as Person[];
}
async function listed(id: string): Promise<Person> {
  const found = (await listPeople()).find((p) => p.id === id);
  expect(found, `person ${id} is listed`).toBeDefined();
  return found as Person;
}

/** Letters only, so that nothing is lost when a name is made into an e-mail. */
const letters = (n: number): string => Array.from(randomBytes(n), (b) => String.fromCharCode(97 + (b % 26))).join('');
const mail = (label = 'p') => `${label}-${letters(8)}@example.test`;
/** A name no other test uses: roles are unique by name, ignoring case and accents. */
const fresh = (label = 'Role') => `${label} ${letters(8)}`;

/** A login that exists already (made by the world, as the terminal door would), on a role, with the Super Admin's password as its own, so that it can sign in; it holds one live session (its cookie). */
async function newPerson(o: { role?: string; email?: string; active?: boolean; superAdmin?: boolean } = {}): Promise<Admin> {
  const u = await w.world.addUser({ role: o.role ?? 'staff', email: o.email ?? mail('person'), active: o.active, superAdmin: o.superAdmin, passwordHash: storedHash });
  return { userId: u.userId, email: u.email, cookie: u.cookie };
}
/** A Super Admin of her own (the run of wrong passwords is counted for each Super Admin) with the same password as the fixture. */
const newAdmin = () => newPerson({ role: 'owner', superAdmin: true });

/** The sessions of a login: how many are live and how many are over. */
async function sessionsOf(userId: string): Promise<{ live: number; ended: number }> {
  const rows = await sql<{ revoked_at: string | null }>('SELECT revoked_at FROM sessions WHERE user_id = ?', [userId]);
  return { live: rows.filter((r) => r.revoked_at === null).length, ended: rows.filter((r) => r.revoked_at !== null).length };
}

/**
 * What a refused, invalid or no-change write must leave as it found it: the audit log (the triggers write the rows of users, and `event` rows are the code's own), users (every column, the hash and the flag included),
 * the sessions (which are live), roles, claims and the login counters.
 */
async function digest(): Promise<string[]> {
  const one = async (text: string) => JSON.stringify((await sql(text))[0]);
  return [
    await one('SELECT COUNT(*) AS n, MAX(id) AS last FROM audit_log'),
    await one("SELECT COUNT(*) AS n, MD5(GROUP_CONCAT(CONCAT_WS('|', id, email, full_name, role, active, is_super_admin, must_change_password, password_hash, last_login_at, created_at, updated_at, created_by, updated_by) ORDER BY id)) AS d FROM users"),
    await one("SELECT COUNT(*) AS n, MD5(GROUP_CONCAT(CONCAT_WS('|', id, user_id, token_hash, revoked_at) ORDER BY id)) AS d FROM sessions"),
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
  expect(await digest(), 'the call changed the audit log, the users, the sessions, the roles, the claims or the login counters').toEqual(before);
  const writes = w.world.spy
    .sqls()
    .slice(from)
    .filter((s) => /^\s*(INSERT|UPDATE|REPLACE)\b/i.test(s) && !/^UPDATE sessions SET last_seen_at/i.test(s.trim()));
  expect(writes, 'a statement of the call changed a row').toEqual([]);
  return res;
}

/** The audit rows of one request: the trigger's row of the users table, then the `event` row; JSON columns parsed. */
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

/** The body without one of its keys. */
function withoutKey(body: Record<string, unknown>, key: string): Record<string, unknown> {
  const { [key]: _gone, ...rest } = body;
  return rest;
}

/** The role writes of Task 13 (a role is switched off or on with the stamp the list shows), for the tests that need a role to change under a person. */
async function switchRole(key: string, active: boolean): Promise<LightMyRequestResponse> {
  const list = await send(main, 'GET', '/v1/super/roles');
  const role = (list.json().roles as { key: string; updated_at: string }[]).find((r) => r.key === key);
  expect(role, `role ${key} is listed`).toBeDefined();
  return send(main, 'POST', `/v1/super/roles/${key}/active`, { expected_updated_at: role?.updated_at, active, password: PASSWORD });
}

/** The invariant of Review Focus 3, over the whole database: no active login holds a role that is switched off (the session would refuse it with a 401 for ever). */
async function noActiveLoginOnASwitchedOffRole(): Promise<unknown[]> {
  return sql('SELECT u.id FROM users u JOIN roles r ON r.role_key = u.role WHERE u.active = 1 AND r.active = 0');
}

// ------------------------------------------------------------------ the password and its throttle (R9, DESIGN 6.6 rule 6)

describe('every write asks for the Super Admin\'s own password', () => {
  it('a wrong password is 422 on password on all five calls, writes nothing and makes no hash; five wrong in a row pause that Super Admin (429, and no password is looked at or hashed while paused)', async () => {
    const admin = await newAdmin();
    const target = await newPerson();
    const hashing = vi.spyOn(passwords, 'hash');
    const verifying = vi.spyOn(passwords, 'verify');
    try {
      const calls: [string, () => Promise<LightMyRequestResponse>][] = [
        ['add', () => addPerson({ full_name: 'Nobody', email: mail(), role: 'staff', password: wrongOne() }, admin)],
        ['edit', () => editPerson(target.userId, { changes: { full_name: 'Nobody' }, password: wrongOne() }, admin)],
        ['role', () => setRole(target.userId, { role: 'biller', password: wrongOne() }, admin)],
        ['active', () => setActive(target.userId, { active: false, password: wrongOne() }, admin)],
        ['reset', () => resetPassword(target.userId, { password: wrongOne() }, admin)],
      ];
      for (const [what, call] of calls) {
        // a wrong password is a refused input (422 on `password`, the words the screen waits for), never a 401 (a 401 makes the screen drop the session), and the call writes nothing at all
        const res = await nothingWritten(call);
        const e = refused(res, 422, 'JV_INVALID_INPUT', { field: 'password' });
        expect(e.message, what).toBe('password is not correct');
      }
      expect(hashing, 'no temporary password is made or hashed for a wrong password').not.toHaveBeenCalled();
      expect(verifying).toHaveBeenCalledTimes(5);

      // that was five wrong passwords in a row: the fifth began the pause, and the RIGHT password is refused now, on every call, before anything is looked at or hashed
      verifying.mockClear();
      const before = w.world.spy.sent.length;
      for (const [what, call] of [
        ['add', () => addPerson({ full_name: 'Nobody', email: mail(), role: 'staff' }, admin)],
        ['edit', () => editPerson(target.userId, { changes: { full_name: 'Nobody' } }, admin)],
        ['role', () => setRole(target.userId, { role: 'biller' }, admin)],
        ['active', () => setActive(target.userId, { active: false }, admin)],
        ['reset', () => resetPassword(target.userId, {}, admin)],
      ] as const) {
        const paused = await nothingWritten(call);
        expect([paused.statusCode, paused.headers['retry-after']], what).toEqual([429, '900']);
        expect(paused.json()).toMatchObject({ error: { code: 'JV_RATE_LIMITED', details: {} } });
      }
      expect(verifying, 'a paused Super Admin has nothing verified').not.toHaveBeenCalled();
      expect(hashing, 'a paused Super Admin has nothing hashed (the hashing places are shared with the login)').not.toHaveBeenCalled();
      expect(w.world.spy.sqls().slice(before).filter((s) => /password_hash/i.test(s)), 'the stored hash is not even read while paused').toEqual([]);
    } finally {
      hashing.mockRestore();
      verifying.mockRestore();
    }
    // the pause is for that Super Admin only
    expect((await addPerson({ full_name: 'Somebody', email: mail(), role: 'staff' })).statusCode, 'another Super Admin is not paused').toBe(201);
  });

  it('the people writes and the role writes share ONE run of wrong passwords: three wrong on role writes and two on people writes pause the Super Admin on both; a right password ends the run', async () => {
    const admin = await newAdmin();
    const target = await newPerson();
    const makeRole = (password: string) => send(admin, 'POST', '/v1/super/roles', { copy_of: 'staff', name: fresh('Shared'), password });
    for (let i = 0; i < 3; i++) expect((await makeRole(wrongOne())).statusCode, `role write ${i + 1}`).toBe(422);
    for (let i = 0; i < 2; i++) expect((await setRole(target.userId, { role: 'biller', password: wrongOne() }, admin)).statusCode, `people write ${i + 1}`).toBe(422);
    expect((await makeRole(PASSWORD)).statusCode, 'five wrong in a row, whichever family: the role writes are paused').toBe(429);
    expect((await setRole(target.userId, { role: 'biller' }, admin)).statusCode, 'and the people writes').toBe(429);

    // another Super Admin: four wrong (two of each) then the right password: the run is over, so four more wrong ones do not pause
    const second = await newAdmin();
    const makeRoleSecond = (password: string) => send(second, 'POST', '/v1/super/roles', { copy_of: 'staff', name: fresh('Run'), password });
    for (let i = 0; i < 2; i++) {
      expect((await makeRoleSecond(wrongOne())).statusCode).toBe(422);
      expect((await setActive(target.userId, { active: false, password: wrongOne() }, second)).statusCode).toBe(422);
    }
    expect((await addPerson({ full_name: 'Run One', email: mail(), role: 'staff' }, second)).statusCode, 'the fifth try is the right password: not paused').toBe(201);
    for (let i = 0; i < 4; i++) expect((await editPerson(target.userId, { changes: { full_name: 'Run' }, password: wrongOne() }, second)).statusCode, `wrong ${i + 1} after the clear`).toBe(422);
    expect((await addPerson({ full_name: 'Run Two', email: mail(), role: 'staff' }, second)).statusCode, 'four wrong in a row after a right one are not five').toBe(201);
  });

  it('a bad input costs no password check and no strike: the words of the body and the id are judged first, so six of them with a wrong password do not pause the Super Admin', async () => {
    const admin = await newAdmin();
    const target = await newPerson();
    const verifying = vi.spyOn(passwords, 'verify');
    try {
      const bad: [string, () => Promise<LightMyRequestResponse>, string][] = [
        ['a name that is empty', () => addPerson({ full_name: '   ', email: mail(), role: 'staff', password: wrongOne() }, admin), 'full_name'],
        ['a name over 120 characters', () => addPerson({ full_name: 'x'.repeat(121), email: mail(), role: 'staff', password: wrongOne() }, admin), 'full_name'],
        ['an e-mail with no @', () => addPerson({ full_name: 'Asha', email: 'not-an-email', role: 'staff', password: wrongOne() }, admin), 'email'],
        ['a role key with a capital', () => addPerson({ full_name: 'Asha', email: mail(), role: 'Biller', password: wrongOne() }, admin), 'role'],
        ['an unknown field', () => editPerson(target.userId, { changes: { full_name: 'Asha' }, is_super_admin: true, password: wrongOne() }, admin), 'is_super_admin'],
        ['an id that is not an id', () => resetPassword('not-an-id', { password: wrongOne() }, admin), 'id'],
      ];
      for (const [what, call, field] of bad) {
        const res = await nothingWritten(call);
        const e = refused(res, 422, 'JV_INVALID_INPUT');
        expect(e.details.field, what).toBe(field);
      }
      expect(verifying, 'no password was looked at for a bad input').not.toHaveBeenCalled();
    } finally {
      verifying.mockRestore();
    }
    expect((await addPerson({ full_name: 'Asha', email: mail(), role: 'staff' }, admin)).statusCode, 'six bad inputs were no strike: the right password is not paused').toBe(201);
  });
});

// ------------------------------------------------------------------ add

describe('POST /v1/super/people (super:people.add)', () => {
  it('add: an active login with the given role, a temporary password shown once, must_change_password 1; the new person signs in and is told to change it', async () => {
    const email = mail('asha');
    const res = await addPerson({ full_name: 'Asha Verma', email, role: 'biller' });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.headers['content-type']).toMatch(/^application\/json/);
    expect(Object.keys(res.json())).toEqual(['person', 'temporary_password']); // the person, the one-time password, nothing else: no echo of the Super Admin's password
    const person = res.json().person as Person;
    const temporary = res.json().temporary_password as string; // remembered by the helper: the last test looks for it in the log and the audit rows
    expect(temporary).toMatch(TEMPORARY);
    expect(Object.keys(person)).toEqual(PERSON_KEYS); // the shape of a row of the list
    expect(person).toMatchObject({ full_name: 'Asha Verma', email, role: 'biller', role_name: 'Biller', active: true, is_super_admin: false, last_login_at: null });
    expect(person.updated_at).toMatch(WIRE_TIMESTAMP);
    expect(person, 'the answer is the person as the list shows that person').toEqual(await listed(person.id));

    // the row: switched on, must change the password, stamped from the API clock (S6) by the session user; only the HASH of the temporary password is stored
    const [row] = await sql('SELECT id, active, must_change_password, is_super_admin, password_hash, created_at, updated_at, created_by, updated_by FROM users WHERE id = ?', [person.id]);
    expect([Number(row.active), Number(row.must_change_password), Number(row.is_super_admin)]).toEqual([1, 1, 0]);
    expect([row.created_by, row.updated_by]).toEqual([main.userId, main.userId]);
    expect(row.created_at).toBe(row.updated_at);
    expect(String(row.created_at).startsWith('2026-10-17')).toBe(true); // the fixed clock of the world, not the database's own
    expect(`${String(row.updated_at).replace(' ', 'T')}Z`).toBe(person.updated_at);
    expect(String(row.password_hash)).not.toContain(temporary);
    expect(await passwords.verify(temporary, String(row.password_hash)), 'the stored hash is the hash of the temporary password').toBe(true);

    // the new person signs in with it and is told to change it: the answer says so, and every call but the three of U11 is 403 until they have
    const signedIn = await login(email, temporary);
    expect(signedIn.statusCode, signedIn.body).toBe(200);
    expect(signedIn.json().user).toMatchObject({ id: person.id, email, role: 'biller', must_change_password: true });
    const cookie = cookieOfLogin(signedIn);
    const blocked = await w.world.app.inject({ method: 'GET', url: '/v1/sync/users', headers: { cookie } });
    refused(blocked, 403, 'JV_PASSWORD_CHANGE_REQUIRED');
    expect((await meOf(cookie)).json().user).toMatchObject({ must_change_password: true, permissions: BILLER });
    const next = remember(secret('Np'));
    const changed = await w.world.app.inject({ method: 'POST', url: '/v1/auth/change-password', headers: { ...csrfHeaders(), cookie }, payload: { current_password: temporary, new_password: next } });
    expect(changed.statusCode, changed.body).toBe(200);
    expect((await w.world.app.inject({ method: 'GET', url: '/v1/sync/users', headers: { cookie } })).statusCode, 'after the change the person works').toBe(200);
    // the temporary password is shown once: the list and `me` never carry it
    expect(JSON.stringify(await listPeople())).not.toContain(temporary);
    expect((await meOf(cookie)).body).not.toContain(temporary);
  });

  it('add: an unknown or switched-off role is 422 on role; a taken e-mail in any case is 422 on email; the e-mail is stored in lower case', async () => {
    const off = await w.world.addRole({ name: fresh('Off'), ticks: ['order_view'], active: false });
    const taken = await newPerson({ email: mail('taken') });
    const before = await listPeople();

    // a role that is not an active role: one that does not exist, one that is switched off, and a key that is not shaped like one; each is 422 on `role` and writes nothing
    for (const [what, role] of [['an unknown role', 'nosuchrole'], ['a switched-off role', off.key], ['a key with a capital', 'Biller'], ['a key with a space', 'bi ller']] as const) {
      const res = await nothingWritten(() => addPerson({ full_name: 'Asha Verma', email: mail(), role }));
      const e = refused(res, 422, 'JV_INVALID_INPUT', { field: 'role' });
      expect(e.message, what).toBe(what === 'an unknown role' || what === 'a switched-off role' ? NOT_ACTIVE_ROLE_SENTENCE : 'role must be a role key');
    }

    // a taken e-mail in any spelling the table takes for the same one: letter case, spaces at the ends, an accent
    const [local, domain] = taken.email.split('@');
    const spellings = [taken.email, taken.email.toUpperCase(), ` ${taken.email} `, `${local.replace('a', '\u00e1')}@${domain}`, `${local}@${domain.toUpperCase()}`];
    for (const email of spellings) {
      const res = await nothingWritten(() => addPerson({ full_name: 'Asha Verma', email, role: 'staff' }));
      const e = refused(res, 422, 'JV_INVALID_INPUT', { field: 'email' });
      expect(e.message, JSON.stringify(email)).toBe(TAKEN_SENTENCE);
    }
    // the e-mail of a login that is switched off is taken too: nothing is ever deleted, so the name is never free again
    const gone = await newPerson({ email: mail('gone'), active: false });
    refused(await nothingWritten(() => addPerson({ full_name: 'Asha Verma', email: gone.email, role: 'staff' })), 422, 'JV_INVALID_INPUT', { field: 'email' });
    expect(await listPeople()).toHaveLength(before.length + 1); // only the login of `gone` was added since: no refused call made a person

    // the e-mail is stored in lower case, whatever was typed, and the new person signs in with it (and with the capitals too: the login ignores letter case)
    const typed = `Mixed.Case-${letters(6)}@Example.TEST`;
    const made = await addPerson({ full_name: '  Asha Verma  ', email: `  ${typed}  `, role: 'staff' });
    expect(made.statusCode, made.body).toBe(201);
    expect(made.json().person).toMatchObject({ full_name: 'Asha Verma', email: typed.toLowerCase() }); // the name is trimmed, the e-mail trimmed and lower-cased
    const temporary = made.json().temporary_password as string;
    expect((await sql('SELECT email FROM users WHERE id = ?', [made.json().person.id]))[0].email).toBe(typed.toLowerCase());
    expect((await login(typed, temporary)).statusCode).toBe(200);
    // and now that e-mail is taken in the spelling that was typed
    refused(await addPerson({ full_name: 'Asha Again', email: typed, role: 'staff' }), 422, 'JV_INVALID_INPUT', { field: 'email' });
  });

  it('add: the new login can never be a Super Admin, whatever the role; an Owner-role login made here is an ordinary one; the Owner role may be given', async () => {
    const res = await addPerson({ full_name: 'Second Owner', email: mail('owner'), role: 'owner' });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().person).toMatchObject({ role: 'owner', role_name: 'Owner', is_super_admin: false });
    expect(Number((await sql('SELECT is_super_admin FROM users WHERE id = ?', [res.json().person.id]))[0].is_super_admin)).toBe(0);
    // no body can ask for the flag, nor for any other column of the row
    for (const extra of [{ is_super_admin: true }, { is_super_admin: false }, { active: false }, { must_change_password: false }, { password_hash: 'x' }]) {
      const key = Object.keys(extra)[0];
      const bad = await nothingWritten(() => addPerson({ full_name: 'Flag', email: mail(), role: 'staff', ...extra }));
      expect(refused(bad, 422, 'JV_INVALID_INPUT', { field: key }).message).toBe(`${key} is not a field this call accepts`);
    }
  });

  it('add: the name and the e-mail follow the rules of the terminal door: 1 to 120 characters, the e-mail of a plain shape up to 254', async () => {
    const invalid: [string, object, string, string][] = [
      ['an empty name', { full_name: '' }, 'full_name', 'full_name is required'],
      ['a name of spaces', { full_name: '    ' }, 'full_name', 'full_name is required'],
      ['a name of 121 characters', { full_name: 'x'.repeat(121) }, 'full_name', 'full_name must be at most 120 characters'],
      ['a name that is not text', { full_name: 42 }, 'full_name', 'full_name must be text'],
      ['no name', { full_name: undefined }, 'full_name', 'full_name is required'],
      ['an e-mail with no @', { email: 'asha.example.test' }, 'email', 'email must be an e-mail address such as name@example.com'],
      ['an e-mail with no dot after the @', { email: 'asha@example' }, 'email', 'email must be an e-mail address such as name@example.com'],
      ['an e-mail with a space inside', { email: 'as ha@example.test' }, 'email', 'email must be an e-mail address such as name@example.com'],
      ['an e-mail over 254 characters', { email: `${'a'.repeat(250)}@example.test` }, 'email', 'email must be at most 254 characters'],
      ['no e-mail', { email: undefined }, 'email', 'email is required'],
      ['no role', { role: undefined }, 'role', 'role is required'],
    ];
    for (const [what, patch, field, message] of invalid) {
      const res = await nothingWritten(() => addPerson({ full_name: 'Asha Verma', email: mail(), role: 'staff', ...patch }));
      expect(refused(res, 422, 'JV_INVALID_INPUT', { field }).message, what).toBe(message);
    }
    // the edges: 120 characters is a name, and an e-mail of 254 characters is one
    const longName = 'n'.repeat(120);
    const edge = await addPerson({ full_name: longName, email: `${'e'.repeat(254 - '@example.test'.length)}@example.test`, role: 'staff' });
    expect(edge.statusCode, edge.body).toBe(201);
    expect(edge.json().person.full_name).toHaveLength(120);
    // no password at all, and an empty one, are 422 on password and write nothing
    expect(errorOf(await nothingWritten(() => send(main, 'POST', PEOPLE, withoutKey({ full_name: 'Asha', email: mail(), role: 'staff', password: PASSWORD }, 'password')))).message).toBe('password is required');
    expect(errorOf(await nothingWritten(() => addPerson({ full_name: 'Asha', email: mail(), role: 'staff', password: '' }))).details).toEqual({ field: 'password' });
  });
});

// ------------------------------------------------------------------ edit

describe('PATCH /v1/super/people/:id (super:people.edit)', () => {
  it('edit name and e-mail: the new e-mail signs in, the old one does not, the person\'s sessions end', async () => {
    const oldEmail = mail('old');
    const person = await newPerson({ role: 'staff', email: oldEmail });
    const bystander = await newPerson({ role: 'staff' });
    const second = await login(oldEmail, PASSWORD); // a second session of the same person
    expect(second.statusCode, second.body).toBe(200);
    const secondCookie = cookieOfLogin(second);
    expect(await sessionsOf(person.userId)).toEqual({ live: 2, ended: 0 });
    const before = await listed(person.userId);

    const newEmail = mail('new');
    const res = await editPerson(person.userId, { changes: { full_name: 'Renamed Person', email: newEmail } });
    expect(res.statusCode, res.body).toBe(200);
    expect(Object.keys(res.json())).toEqual(['person']);
    expect(Object.keys(res.json().person)).toEqual(PERSON_KEYS);
    expect(res.json().person).toMatchObject({ id: person.userId, full_name: 'Renamed Person', email: newEmail, role: 'staff', role_name: 'Staff', active: true, is_super_admin: false });
    expect(res.json().person.updated_at, 'the row was written: its stamp moved').not.toBe(before.updated_at);
    expect(res.json().person, 'the answer is the person as the list shows that person').toEqual(await listed(person.userId));
    expect((await sql('SELECT updated_by FROM users WHERE id = ?', [person.userId]))[0].updated_by).toBe(main.userId);

    // the new e-mail signs in with the same password, the old one does not (the same answer as an unknown e-mail)
    refused(await login(oldEmail, PASSWORD), 401, 'JV_BAD_LOGIN');
    const signedInNew = await login(newEmail, PASSWORD);
    expect(signedInNew.statusCode, signedInNew.body).toBe(200);
    expect(signedInNew.json().user).toMatchObject({ id: person.userId, email: newEmail });
    // every session the person had is over (a cookie of the person is a 401 now), and nobody else's is touched
    for (const cookie of [person.cookie, secondCookie]) refused(await meOf(cookie), 401, 'JV_UNAUTHENTICATED');
    expect(await sessionsOf(person.userId)).toEqual({ live: 1, ended: 2 }); // the two that ended, and the one the new sign-in just made
    expect((await meOf(bystander.cookie)).statusCode).toBe(200);
    expect(await sessionsOf(bystander.userId)).toEqual({ live: 1, ended: 0 });
    // the event says what changed, and nothing but the person, the name and the fields
    const events = await eventsOf(res);
    expect(events.map((e) => e.new_row)).toEqual([{ event: 'person_edited', person: person.userId, name: 'Renamed Person', fields: ['full_name', 'email'] }]);
  });

  it('edit: a name alone, or an e-mail alone, is a change of that field only; the name alone ends no session; a field sent with the value it has is no change', async () => {
    const person = await newPerson({ role: 'staff' });
    const start = await listed(person.userId);

    // the name alone: no session ends (the e-mail did not change), the event names the one field
    const renamed = await editPerson(person.userId, { changes: { full_name: '  Only The Name  ' } });
    expect(renamed.statusCode, renamed.body).toBe(200);
    expect(renamed.json().person).toMatchObject({ full_name: 'Only The Name', email: start.email });
    expect((await eventsOf(renamed)).map((e) => e.new_row)).toEqual([{ event: 'person_edited', person: person.userId, name: 'Only The Name', fields: ['full_name'] }]);
    expect((await meOf(person.cookie)).statusCode, 'the name changed: the session lives').toBe(200);
    expect(await sessionsOf(person.userId)).toEqual({ live: 1, ended: 0 });

    // the same words again, in every shape that says the same: nothing is written, the answer is the person as listed
    const current = await listed(person.userId);
    for (const changes of [{ full_name: 'Only The Name' }, { full_name: ' Only The Name ' }, { email: start.email }, { email: start.email.toUpperCase() }, { full_name: 'Only The Name', email: ` ${start.email} ` }]) {
      const res = await nothingWritten(() => editPerson(person.userId, { changes }));
      expect(res.statusCode, `${JSON.stringify(changes)}: ${res.body}`).toBe(200);
      expect(res.json().person, JSON.stringify(changes)).toEqual(current); // as listed, with the stamp as it was
    }

    // the e-mail alone ends the sessions; a name that is sent with the value it has is not among the fields
    const newEmail = mail('only');
    const moved = await editPerson(person.userId, { changes: { full_name: 'Only The Name', email: newEmail } });
    expect(moved.statusCode, moved.body).toBe(200);
    expect(moved.json().person).toMatchObject({ full_name: 'Only The Name', email: newEmail });
    expect((await eventsOf(moved)).map((e) => e.new_row)).toEqual([{ event: 'person_edited', person: person.userId, name: 'Only The Name', fields: ['email'] }]);
    refused(await meOf(person.cookie), 401, 'JV_UNAUTHENTICATED');
  });

  it('edit: an e-mail that another login holds, in any spelling, is 422 on email and writes nothing; the person\'s own e-mail in another spelling is no clash; the words of changes are judged', async () => {
    const holder = await newPerson({ email: mail('holder') });
    const person = await newPerson({ email: mail('mine') });
    const [local, domain] = holder.email.split('@');
    for (const email of [holder.email, holder.email.toUpperCase(), ` ${holder.email} `, `${local.replace('o', '\u00f3')}@${domain}`]) {
      const res = await nothingWritten(() => editPerson(person.userId, { changes: { email } }));
      expect(refused(res, 422, 'JV_INVALID_INPUT', { field: 'email' }).message, JSON.stringify(email)).toBe(TAKEN_SENTENCE);
    }
    // the e-mail of a switched-off login is taken as well
    const off = await newPerson({ email: mail('off'), active: false });
    refused(await nothingWritten(() => editPerson(person.userId, { changes: { email: off.email } })), 422, 'JV_INVALID_INPUT', { field: 'email' });
    // the person's own e-mail in a spelling the table takes for the same (an accent) is not a clash with another login: it is a change of the stored text, and the person's sessions end
    const [mineLocal, mineDomain] = (await listed(person.userId)).email.split('@');
    const accent = `${mineLocal.replace('i', '\u00ed')}@${mineDomain}`; // `mine-...` becomes `m` + i with an acute accent + `ne-...`
    const own = await editPerson(person.userId, { changes: { email: accent } });
    expect(own.statusCode, own.body).toBe(200);
    expect(own.json().person.email).toBe(accent);
    expect((await login(accent, PASSWORD)).statusCode).toBe(200);

    // the words of `changes`
    const target = await newPerson();
    const invalid: [string, unknown, string, string][] = [
      ['an empty changes', {}, 'changes', 'changes must name at least one field to change'],
      ['no changes at all', undefined, 'changes', 'changes is required'],
      ['changes that is not an object', 'x', 'changes', 'changes must be an object holding the fields to change'],
      ['a role among the changes', { role: 'owner' }, 'changes.role', 'changes.role is not a field this call accepts'],
      ['the flag among the changes', { is_super_admin: true }, 'changes.is_super_admin', 'changes.is_super_admin is not a field this call accepts'],
      ['an active among the changes', { active: false, full_name: 'Asha' }, 'changes.active', 'changes.active is not a field this call accepts'],
      ['an empty name', { full_name: '  ' }, 'changes.full_name', 'changes.full_name is required'],
      ['a name over 120 characters', { full_name: 'x'.repeat(121) }, 'changes.full_name', 'changes.full_name must be at most 120 characters'],
      ['an e-mail of no shape', { email: 'nope' }, 'changes.email', 'changes.email must be an e-mail address such as name@example.com'],
    ];
    for (const [what, changes, field, message] of invalid) {
      const res = await nothingWritten(() => editPerson(target.userId, { changes }));
      expect(refused(res, 422, 'JV_INVALID_INPUT', { field }).message, what).toBe(message);
    }
    // a person that does not exist is 404 (after the password), and an id that is not an id is 422 on id
    expect(refused(await nothingWritten(() => editPerson('00000000-0000-4000-8000-000000000000', { changes: { full_name: 'Nobody' } })), 404, 'JV_NOT_FOUND').message).toBe('There is no such user.');
    refused(await nothingWritten(() => editPerson('not-an-id', { changes: { full_name: 'Nobody' } })), 422, 'JV_INVALID_INPUT', { field: 'id' });
    refused(await nothingWritten(() => editPerson(target.userId.toUpperCase(), { changes: { full_name: 'Nobody' } })), 422, 'JV_INVALID_INPUT', { field: 'id' });
  });

  it('the Super Admin changing her own e-mail keeps her current session, ends her other sessions, and she signs in with the new e-mail (Review Focus 4)', async () => {
    const admin = await newAdmin();
    const oldEmail = admin.email;
    const other = await login(oldEmail, PASSWORD); // her other session: a second browser
    expect(other.statusCode, other.body).toBe(200);
    const otherCookie = cookieOfLogin(other);
    expect(await sessionsOf(admin.userId)).toEqual({ live: 2, ended: 0 });

    // the name alone changes no session at all
    const named = await editPerson(admin.userId, { changes: { full_name: 'Siddhi Test' } }, admin);
    expect(named.statusCode, named.body).toBe(200);
    expect(await sessionsOf(admin.userId)).toEqual({ live: 2, ended: 0 });

    const newEmail = mail('siddhi');
    const res = await editPerson(admin.userId, { changes: { email: newEmail } }, admin);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().person).toMatchObject({ id: admin.userId, full_name: 'Siddhi Test', email: newEmail, is_super_admin: true, active: true });
    expect(res.json().person).toEqual(await listed(admin.userId));
    // her CURRENT session (the cookie this call was made with) lives, and is told the new e-mail; the OTHER session is over
    const mine = await meOf(admin.cookie);
    expect(mine.statusCode, mine.body).toBe(200);
    expect(mine.json().user).toMatchObject({ email: newEmail, is_super_admin: true });
    refused(await meOf(otherCookie), 401, 'JV_UNAUTHENTICATED');
    expect(await sessionsOf(admin.userId)).toEqual({ live: 1, ended: 1 });
    // she still works with it: the next write with the same cookie is accepted
    expect((await editPerson(admin.userId, { changes: { full_name: 'Siddhi Again' } }, admin)).statusCode, 'the current session still writes').toBe(200);
    // she signs in with the new e-mail, and the old one is no login any more
    const again = await login(newEmail, PASSWORD);
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json().user).toMatchObject({ id: admin.userId, email: newEmail });
    refused(await login(oldEmail, PASSWORD), 401, 'JV_BAD_LOGIN');
    expect((await eventsOf(res)).map((e) => e.new_row)).toEqual([{ event: 'person_edited', person: admin.userId, name: 'Siddhi Test', fields: ['email'] }]);
    // the e-mail she took is taken, and the one she gave up is free for another login
    refused(await addPerson({ full_name: 'Impostor', email: newEmail, role: 'staff' }, admin), 422, 'JV_INVALID_INPUT', { field: 'email' });
    expect((await addPerson({ full_name: 'Newcomer', email: oldEmail, role: 'staff' }, admin)).statusCode).toBe(201);
  });
});

// ------------------------------------------------------------------ role

describe('POST /v1/super/people/:id/role (super:people.role)', () => {
  it('a role change applies on the person\'s next call with the same cookie, and their next poll answer carries another access (P6, API half)', async () => {
    const narrow = await w.world.addRole({ name: fresh('Narrow'), ticks: ['order_view'] });
    const person = await newPerson({ role: narrow.key });
    const sessionsBefore = await sessionsOf(person.userId);

    // before: the role holds one tick, so the call that needs the customers is refused
    const me1 = (await meOf(person.cookie)).json().user;
    expect(me1).toMatchObject({ role: narrow.key, permissions: ['order_view'] });
    refused(await w.world.app.inject({ method: 'GET', url: '/v1/sync/customers', headers: { cookie: person.cookie } }), 403, 'JV_FORBIDDEN');
    const poll1 = (await pollOf(person.cookie)).json();
    expect(poll1.role).toBe(narrow.key);

    const res = await setRole(person.userId, { role: 'biller' });
    expect(res.statusCode, res.body).toBe(200);
    expect(Object.keys(res.json())).toEqual(['person']);
    expect(res.json().person).toMatchObject({ id: person.userId, role: 'biller', role_name: 'Biller', active: true });
    expect(res.json().person, 'the answer is the person as the list shows that person').toEqual(await listed(person.userId));

    // after: the SAME cookie, the next call, is a Biller's: the customers are read, `me` tells the new ticks and another access, and the poll carries the other access and the new role
    expect((await w.world.app.inject({ method: 'GET', url: '/v1/sync/customers', headers: { cookie: person.cookie } })).statusCode).toBe(200);
    const me2 = (await meOf(person.cookie)).json().user;
    expect(me2).toMatchObject({ role: 'biller', role_name: 'Biller', permissions: BILLER });
    expect(me2.access).not.toBe(me1.access);
    const poll2 = (await pollOf(person.cookie)).json();
    expect(poll2.role).toBe('biller');
    expect(poll2.access, 'the next poll answer carries another access').not.toBe(poll1.access);
    expect(poll2.access).toBe(me2.access); // the one fingerprint, the same text in `me` and in the poll
    // no session was touched by the change: the person did not sign in again
    expect(await sessionsOf(person.userId)).toEqual(sessionsBefore);

    // and back: refused again on the very next call
    expect((await setRole(person.userId, { role: narrow.key })).statusCode).toBe(200);
    refused(await w.world.app.inject({ method: 'GET', url: '/v1/sync/customers', headers: { cookie: person.cookie } }), 403, 'JV_FORBIDDEN');
    expect((await pollOf(person.cookie)).json().access).toBe(poll1.access);
  });

  it('role: only an active role is accepted (422 on role); the same role writes nothing; the answer and the event name the new role; a person on a switched-off role, switched off, can be given one', async () => {
    const off = await w.world.addRole({ name: fresh('Closed'), ticks: ['order_view'], active: false });
    const named = await w.world.addRole({ name: 'Cashier North', ticks: ['order_view', 'customer_view'] });
    const person = await newPerson({ role: 'staff' });

    // an unknown role, a switched-off one and a key of no shape are 422 on `role`; nothing is written, and no session ends
    for (const role of ['nosuchrole', off.key, 'Staff', '']) {
      const res = await nothingWritten(() => setRole(person.userId, { role }));
      refused(res, 422, 'JV_INVALID_INPUT', { field: 'role' });
    }
    expect(errorOf(await setRole(person.userId, { role: off.key })).message).toBe(NOT_ACTIVE_ROLE_SENTENCE);
    expect(errorOf(await setRole(person.userId, {})).message).toBe('role is required');

    // the role the person has: nothing is written (no row, no audit row, no event), the answer is the person as listed
    const same = await nothingWritten(() => setRole(person.userId, { role: 'staff' }));
    expect(same.statusCode, same.body).toBe(200);
    expect(same.json().person).toEqual(await listed(person.userId));

    // a role the Super Admin made, by its key; the event holds the keys and the NEW role's name
    const res = await setRole(person.userId, { role: named.key });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().person).toMatchObject({ role: named.key, role_name: 'Cashier North' });
    expect((await eventsOf(res)).map((e) => e.new_row)).toEqual([{ event: 'person_role_changed', person: person.userId, name: 'Fixture extra', from: 'staff', to: named.key, to_name: 'Cashier North' }]);
    // the Owner role may be given too, and that is not the flag
    const owner = await setRole(person.userId, { role: 'owner' });
    expect(owner.statusCode, owner.body).toBe(200);
    expect(owner.json().person).toMatchObject({ role: 'owner', role_name: 'Owner', is_super_admin: false });

    // the people of a role that is switched off are switched-off people: one of them is given an active role (it is allowed while it is off) and then switched on
    const parked = await newPerson({ role: 'staff', active: false });
    await w.world.sql.query('UPDATE users SET role = ? WHERE id = ?', [off.key, parked.userId]); // a login that was left on a role that was switched off afterwards
    expect((await setRole(parked.userId, { role: 'staff' })).statusCode).toBe(200);
    expect((await setActive(parked.userId, { active: true })).statusCode).toBe(200);
    expect(await noActiveLoginOnASwitchedOffRole()).toEqual([]);
  });
});

// ------------------------------------------------------------------ switch off and on

describe('POST /v1/super/people/:id/active (super:people.active)', () => {
  it('switch off ends every session and the person gets 401; switching on a person whose role is switched off is 409 with the sentence (Review Focus 3); switching on with an active role works', async () => {
    const person = await newPerson({ role: 'staff' });
    const second = await login(person.email, PASSWORD);
    expect(second.statusCode, second.body).toBe(200);
    const secondCookie = cookieOfLogin(second);
    expect(await sessionsOf(person.userId)).toEqual({ live: 2, ended: 0 });
    const bystander = await newPerson();

    // off: every session of the person ends, the person gets 401 on the next call, and cannot sign in (403 with the reason `inactive`)
    const off = await setActive(person.userId, { active: false });
    expect(off.statusCode, off.body).toBe(200);
    expect(Object.keys(off.json())).toEqual(['person']);
    expect(off.json().person).toMatchObject({ id: person.userId, active: false, role: 'staff' });
    expect(off.json().person, 'the answer is the person as the list shows that person').toEqual(await listed(person.userId));
    for (const cookie of [person.cookie, secondCookie]) refused(await meOf(cookie), 401, 'JV_UNAUTHENTICATED');
    expect(await sessionsOf(person.userId)).toEqual({ live: 0, ended: 2 });
    expect(refused(await login(person.email, PASSWORD), 403, 'JV_FORBIDDEN').details).toMatchObject({ reason: 'inactive' });
    expect((await meOf(bystander.cookie)).statusCode, 'nobody else is touched').toBe(200);
    expect((await eventsOf(off)).map((e) => e.new_row)).toEqual([{ event: 'person_switched_off', person: person.userId, name: 'Fixture extra' }]);

    // off again: it is so already, nothing is written
    const again = await nothingWritten(() => setActive(person.userId, { active: false }));
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json().person).toEqual(await listed(person.userId));

    // on, with an active role: it works; the sessions that ended stay ended, and the person signs in again
    const on = await setActive(person.userId, { active: true });
    expect(on.statusCode, on.body).toBe(200);
    expect(on.json().person).toMatchObject({ id: person.userId, active: true });
    expect((await eventsOf(on)).map((e) => e.new_row)).toEqual([{ event: 'person_switched_on', person: person.userId, name: 'Fixture extra' }]);
    refused(await meOf(person.cookie), 401, 'JV_UNAUTHENTICATED'); // switching on does not bring an old session back
    expect(await sessionsOf(person.userId)).toEqual({ live: 0, ended: 2 });
    expect((await login(person.email, PASSWORD)).statusCode).toBe(200);
    // on again: it is so already, nothing is written
    expect((await nothingWritten(() => setActive(person.userId, { active: true }))).statusCode).toBe(200);

    // Review Focus 3: a person whose role is switched off cannot be switched on. The role is switched off while the person is off (nobody ACTIVE holds it: the Super Admin may switch it off)
    const role = await w.world.addRole({ name: fresh('Parked'), ticks: ['order_view'] });
    const parked = await newPerson({ role: role.key });
    expect((await setActive(parked.userId, { active: false })).statusCode).toBe(200);
    const roleOff = await switchRole(role.key, false);
    expect(roleOff.statusCode, roleOff.body).toBe(200); // no ACTIVE person holds the role

    const refusedOn = await nothingWritten(() => setActive(parked.userId, { active: true }));
    const e = refused(refusedOn, 409, 'JV_NOT_ALLOWED', {});
    expect(e.message).toBe(ROLE_OFF_SENTENCE);
    expect((await listed(parked.userId)).active, 'the person is still off').toBe(false);
    // the way out is the one the sentence names: give the person another role first (it works while the person is off), then switch on
    refused(await nothingWritten(() => setRole(parked.userId, { role: role.key })), 422, 'JV_INVALID_INPUT', { field: 'role' });
    expect((await setRole(parked.userId, { role: 'staff' })).statusCode).toBe(200);
    expect((await setActive(parked.userId, { active: true })).statusCode).toBe(200);
    expect(await noActiveLoginOnASwitchedOffRole(), 'no login can end up on a switched-off role').toEqual([]);

    // a body that is not exactly { active: boolean, password }
    refused(await nothingWritten(() => setActive(person.userId, { active: 'no' })), 422, 'JV_INVALID_INPUT', { field: 'active' });
    expect(errorOf(await setActive(person.userId, {})).message).toBe('active is required');
    // no such person is 404
    refused(await nothingWritten(() => setActive('00000000-0000-4000-8000-000000000000', { active: false })), 404, 'JV_NOT_FOUND');
  });
});

// ------------------------------------------------------------------ reset

describe('POST /v1/super/people/:id/reset-password (super:people.reset)', () => {
  it('reset password: a new temporary password, must change, every session ended, the old password refused', async () => {
    const person = await newPerson({ role: 'biller' });
    const second = await login(person.email, PASSWORD);
    expect(second.statusCode, second.body).toBe(200);
    const secondCookie = cookieOfLogin(second);
    await w.world.sql.query('UPDATE users SET must_change_password = 0 WHERE id = ?', [person.userId]); // a person who changed the password long ago
    expect(await sessionsOf(person.userId)).toEqual({ live: 2, ended: 0 });
    const bystander = await newPerson();

    const res = await resetPassword(person.userId);
    expect(res.statusCode, res.body).toBe(200);
    expect(Object.keys(res.json())).toEqual(['person', 'temporary_password', 'sessions_ended']);
    expect(res.json().sessions_ended, 'a number: the sessions that were live').toBe(2);
    expect(typeof res.json().sessions_ended).toBe('number');
    const temporary = res.json().temporary_password as string;
    expect(temporary).toMatch(TEMPORARY);
    expect(res.json().person).toMatchObject({ id: person.userId, active: true, role: 'biller' });
    expect(res.json().person, 'the answer is the person as the list shows that person').toEqual(await listed(person.userId));

    // every session is over, the old password is refused, the new temporary one signs in and the person must change it
    for (const cookie of [person.cookie, secondCookie]) refused(await meOf(cookie), 401, 'JV_UNAUTHENTICATED');
    expect(await sessionsOf(person.userId)).toEqual({ live: 0, ended: 2 });
    refused(await login(person.email, PASSWORD), 401, 'JV_BAD_LOGIN');
    const signedIn = await login(person.email, temporary);
    expect(signedIn.statusCode, signedIn.body).toBe(200);
    expect(signedIn.json().user).toMatchObject({ id: person.userId, must_change_password: true });
    refused(await w.world.app.inject({ method: 'GET', url: '/v1/sync/users', headers: { cookie: cookieOfLogin(signedIn) } }), 403, 'JV_PASSWORD_CHANGE_REQUIRED');
    const [row] = await sql('SELECT password_hash, must_change_password, updated_by FROM users WHERE id = ?', [person.userId]);
    expect(Number(row.must_change_password)).toBe(1);
    expect(row.updated_by).toBe(main.userId);
    expect(await passwords.verify(temporary, String(row.password_hash)), 'the hash is the hash of the temporary password').toBe(true);
    expect(String(row.password_hash)).not.toContain(temporary);
    expect((await meOf(bystander.cookie)).statusCode, 'nobody else is touched').toBe(200);
    expect((await eventsOf(res)).map((e) => e.new_row)).toEqual([{ event: 'person_password_reset', person: person.userId, name: 'Fixture extra', sessions_ended: 2 }]);

    // a second reset: the sign-in above made one session, which ends now; a reset always writes, and the new password is another one
    const next = await resetPassword(person.userId);
    expect(next.statusCode, next.body).toBe(200);
    expect(next.json().sessions_ended).toBe(1);
    expect(next.json().temporary_password).not.toBe(temporary);
    refused(await login(person.email, temporary), 401, 'JV_BAD_LOGIN');
    // the person that is switched off can be reset too (the password is for the day the person is switched on)
    const gone = await newPerson({ active: false });
    expect((await resetPassword(gone.userId)).statusCode).toBe(200);
    // no body but the password, and no such person is 404
    refused(await nothingWritten(() => resetPassword(person.userId, { person: 'x' })), 422, 'JV_INVALID_INPUT', { field: 'person' });
    refused(await nothingWritten(() => resetPassword('00000000-0000-4000-8000-000000000000')), 404, 'JV_NOT_FOUND');
  });
});

// ------------------------------------------------------------------ the guardrails

describe('the guardrails', () => {
  it('guardrail 2 and R12: every write on a Super Admin login except her own edit is 409; no body can set, change or clear the flag', async () => {
    const admin = await newAdmin(); // the caller
    const other = await newAdmin(); // another login with the flag, active
    const flaggedStaff = await newPerson({ role: 'staff', superAdmin: true }); // the flag on another role: the flag is what counts, not the role
    const flaggedOff = await newPerson({ role: 'owner', superAdmin: true, active: false }); // a Super Admin login that is switched off is managed in the terminal too
    const ordinary = await newPerson({ role: 'owner' }); // the Owner role without the flag: an ordinary login
    const flaggedBefore = await sql<{ id: string }>('SELECT id FROM users WHERE is_super_admin = 1 ORDER BY id');
    const ordinaryBefore = await listed(ordinary.userId);

    // every write on a login with the flag but the caller's own edit: 409 JV_NOT_ALLOWED, the one sentence, nothing written. The call that would have changed nothing (the role it has, the state it is in, the
    // name it bears) is refused as well: the refusal is not hidden behind a no-change answer.
    for (const [who, target] of [['another Super Admin', other], ['the flag on a role that is not the Owner\'s', flaggedStaff], ['a Super Admin who is switched off', flaggedOff]] as const) {
      const now = await listed(target.userId);
      const calls: [string, () => Promise<LightMyRequestResponse>][] = [
        ['edit the name', () => editPerson(target.userId, { changes: { full_name: 'Taken Over' } }, admin)],
        ['edit the e-mail', () => editPerson(target.userId, { changes: { email: mail('takeover') } }, admin)],
        ['edit with the words it has', () => editPerson(target.userId, { changes: { full_name: now.full_name, email: now.email } }, admin)],
        ['change the role', () => setRole(target.userId, { role: now.role === 'staff' ? 'biller' : 'staff' }, admin)],
        ['change to the role it has', () => setRole(target.userId, { role: now.role }, admin)],
        ['switch off', () => setActive(target.userId, { active: false }, admin)],
        ['switch on', () => setActive(target.userId, { active: true }, admin)],
        ['reset the password', () => resetPassword(target.userId, {}, admin)],
      ];
      for (const [what, call] of calls) {
        const e = refused(await nothingWritten(call), 409, 'JV_NOT_ALLOWED', {});
        expect(e.message, `${who}: ${what}`).toBe(SUPER_SENTENCE);
      }
      expect(await listed(target.userId), who).toEqual(now);
    }

    // the caller's OWN row: role, switch and reset are refused (the Super Admin cannot switch herself off, change her role or reset her own password here); the edit of her name and e-mail is the one thing that works
    const own = await listed(admin.userId);
    for (const [what, call] of [
      ['change the role', () => setRole(admin.userId, { role: 'staff' }, admin)],
      ['change to the role she has', () => setRole(admin.userId, { role: own.role }, admin)],
      ['switch off', () => setActive(admin.userId, { active: false }, admin)],
      ['switch on (she is on)', () => setActive(admin.userId, { active: true }, admin)],
      ['reset the password', () => resetPassword(admin.userId, {}, admin)],
    ] as [string, () => Promise<LightMyRequestResponse>][]) {
      expect(refused(await nothingWritten(call), 409, 'JV_NOT_ALLOWED', {}).message, `her own row: ${what}`).toBe(SUPER_SENTENCE);
    }
    const edited = await editPerson(admin.userId, { changes: { full_name: 'Siddhi Own', email: mail('own') } }, admin);
    expect(edited.statusCode, edited.body).toBe(200);
    expect(edited.json().person).toMatchObject({ id: admin.userId, full_name: 'Siddhi Own', is_super_admin: true, active: true, role: 'owner' });

    // the guardrail is the flag, not the role: an ordinary login on the Owner role is managed like anybody (its password, its role, its switch, its words)
    expect((await setRole(ordinary.userId, { role: 'biller' }, admin)).statusCode).toBe(200);
    expect((await setActive(ordinary.userId, { active: false }, admin)).statusCode).toBe(200);
    expect((await setActive(ordinary.userId, { active: true }, admin)).statusCode).toBe(200);
    expect((await resetPassword(ordinary.userId, {}, admin)).statusCode).toBe(200);
    expect((await editPerson(ordinary.userId, { changes: { full_name: 'Ordinary Owner' } }, admin)).statusCode).toBe(200);
    expect((await listed(ordinary.userId)).is_super_admin, 'it never became a Super Admin').toBe(false);
    expect(ordinaryBefore.is_super_admin).toBe(false);

    // no body can set, change or clear the flag: every call refuses the field by name (and inside `changes`), for a login that has it and for one that has not; nothing is written
    const bodies: [string, (extra: object) => Promise<LightMyRequestResponse>][] = [
      ['add', (extra) => addPerson({ full_name: 'Flag', email: mail(), role: 'staff', ...extra }, admin)],
      ['edit', (extra) => editPerson(ordinary.userId, { changes: { full_name: 'Flag' }, ...extra }, admin)],
      ['role', (extra) => setRole(ordinary.userId, { role: 'staff', ...extra }, admin)],
      ['active', (extra) => setActive(ordinary.userId, { active: false, ...extra }, admin)],
      ['reset', (extra) => resetPassword(ordinary.userId, extra, admin)],
    ];
    for (const [what, call] of bodies) {
      for (const value of [true, false]) {
        const e = refused(await nothingWritten(() => call({ is_super_admin: value })), 422, 'JV_INVALID_INPUT', { field: 'is_super_admin' });
        expect(e.message, `${what} ${value}`).toBe('is_super_admin is not a field this call accepts');
      }
    }
    for (const target of [ordinary, other]) {
      for (const value of [true, false]) {
        const e = refused(await nothingWritten(() => editPerson(target.userId, { changes: { is_super_admin: value } }, admin)), 422, 'JV_INVALID_INPUT', { field: 'changes.is_super_admin' });
        expect(e.message).toBe('changes.is_super_admin is not a field this call accepts');
      }
    }
    expect(await sql<{ id: string }>('SELECT id FROM users WHERE is_super_admin = 1 ORDER BY id'), 'the flag is where the terminal put it, on the same logins').toEqual(flaggedBefore);
  });

  it('each write checks the caller again at its start (X0 item 2): grants that are not the Super Admin\'s are refused before the application, the request or the database is touched', async () => {
    const people = await import('../../src/super/people');
    const { TICK_KEYS } = await import('../../src/permissions/ticks');
    const untouched = new Proxy({}, {
      get(_t, prop) {
        throw new Error(`touched ${String(prop)}`);
      },
    });
    const as = (grants: ReturnType<typeof grantsOf>) => ({ user: { grants }, session: {} }) as unknown as Auth;
    const owner = as(grantsOf({ roleKey: 'owner', roleTicks: [], isSuperAdmin: false }));
    const everything = as(grantsOf({ roleKey: 'made-up', roleTicks: [...TICK_KEYS], isSuperAdmin: false }));
    const params = { id: '00000000-0000-4000-8000-000000000000' };
    const body = { password: 'not-used' };
    for (const who of [owner, everything]) {
      for (const call of [
        () => people.addPerson(untouched as never, untouched as never, who, { full_name: 'x', email: 'x@example.test', role: 'staff', ...body }),
        () => people.editPerson(untouched as never, untouched as never, who, params, { changes: { full_name: 'x' }, ...body }),
        () => people.setPersonRole(untouched as never, untouched as never, who, params, { role: 'staff', ...body }),
        () => people.setPersonActive(untouched as never, untouched as never, who, params, { active: false, ...body }),
        () => people.resetPassword(untouched as never, untouched as never, who, params, body),
      ]) {
        const err = (await call().then(
          () => undefined,
          (e: unknown) => e,
        )) as { code?: string; status?: number; message?: string } | undefined;
        expect([err?.code, err?.status, err?.message]).toEqual(['JV_FORBIDDEN', 403, 'You are not allowed to do this.']);
      }
    }
  });

  it('readPerson, the read behind every answer, is the same wall as the list: refused for grants that are not the Super Admin\'s before the database is asked; for the Super Admin it is the list\'s own SELECT for one id', async () => {
    const { readPerson } = await import('../../src/super/queries');
    const { TICK_KEYS } = await import('../../src/permissions/ticks');
    const asked: string[] = [];
    const reader = {
      rows: async (text: string) => {
        asked.push(text);
        return [];
      },
    };
    for (const grants of [grantsOf({ roleKey: 'owner', roleTicks: [], isSuperAdmin: false }), grantsOf({ roleKey: 'made-up', roleTicks: [...TICK_KEYS], isSuperAdmin: false })]) {
      const err = (await readPerson(reader, grants, '00000000-0000-4000-8000-000000000000').then(
        () => undefined,
        (e: unknown) => e,
      )) as { code?: string } | undefined;
      expect(err?.code).toBe('JV_FORBIDDEN');
    }
    expect(asked, 'a refused read asked the database something').toEqual([]);
    expect(await readPerson(reader, grantsOf({ roleKey: 'owner', roleTicks: [], isSuperAdmin: true }), '00000000-0000-4000-8000-000000000000')).toBeUndefined(); // no such login: undefined, not an error
    expect(asked).toHaveLength(1);
    // the same SELECT as the list, narrowed to one id (so that the answer of a write can never differ from the list's row)
    const from = w.world.spy.sent.length;
    await listPeople();
    const list = w.world.spy.sqls().slice(from).find((s) => /^SELECT u\.id, u\.full_name/.test(s)) as string;
    expect(list, 'the list statement was seen').toMatch(/ORDER BY u\.created_at, u\.id$/);
    expect(asked[0]).toBe(`${list.replace(/ ORDER BY .*$/, '')} WHERE u.id = ?`);
  });
});

// ------------------------------------------------------------------ events and audit rows

describe('every write leaves its audit row and its event, and none holds a password or a hash', () => {
  it('each write leaves its event and its audit row, and none holds a password or a hash', async () => {
    const email = mail('asha');
    const added = await addPerson({ full_name: 'Asha Verma', email, role: 'biller' });
    expect(added.statusCode, added.body).toBe(201);
    const id = added.json().person.id as string;
    await w.world.sql.query('UPDATE users SET must_change_password = 0 WHERE id = ?', [id]); // so that the reset below changes something an audit row can show
    const newEmail = mail('verma');
    const edited = await editPerson(id, { changes: { full_name: 'Asha V', email: newEmail } });
    const roled = await setRole(id, { role: 'staff' });
    const off = await setActive(id, { active: false });
    const on = await setActive(id, { active: true });
    const reset = await resetPassword(id);
    for (const res of [edited, roled, off, on, reset]) expect(res.statusCode, res.body).toBe(200);

    const steps: [string, LightMyRequestResponse, Record<string, unknown>, (old: any, now: any) => void][] = [
      ['add', added, { event: 'person_added', person: id, name: 'Asha Verma', role: 'biller' }, (old, now) => {
        expect(old).toBeNull();
        expect(now).toMatchObject({ id, email, full_name: 'Asha Verma', role: 'biller', active: 1, must_change_password: 1, is_super_admin: 0, created_by: main.userId, updated_by: main.userId });
      }],
      ['edit', edited, { event: 'person_edited', person: id, name: 'Asha V', fields: ['full_name', 'email'] }, (old, now) => {
        expect([old.full_name, old.email, now.full_name, now.email]).toEqual(['Asha Verma', email, 'Asha V', newEmail]);
        expect(now.updated_by).toBe(main.userId);
      }],
      ['role', roled, { event: 'person_role_changed', person: id, name: 'Asha V', from: 'biller', to: 'staff', to_name: 'Staff' }, (old, now) => {
        expect([old.role, now.role]).toEqual(['biller', 'staff']);
      }],
      ['off', off, { event: 'person_switched_off', person: id, name: 'Asha V' }, (old, now) => {
        expect([old.active, now.active]).toEqual([1, 0]);
      }],
      ['on', on, { event: 'person_switched_on', person: id, name: 'Asha V' }, (old, now) => {
        expect([old.active, now.active]).toEqual([0, 1]);
      }],
      ['reset', reset, { event: 'person_password_reset', person: id, name: 'Asha V', sessions_ended: 0 }, (old, now) => {
        expect([old.must_change_password, now.must_change_password]).toEqual([0, 1]);
      }],
    ];
    for (const [what, res, facts, rowCheck] of steps) {
      const rows = await auditOf(res);
      // exactly the trigger's row of the users table, then the `event` row; the actor is the Super Admin (the person and the role KEY) and the request is the call's
      expect(rows.map((r) => [r.table_name, r.action, r.row_id]), what).toEqual([['users', what === 'add' ? 'insert' : 'update', id], ['users', 'event', id]]);
      for (const r of rows) expect([r.actor, r.actor_role, r.request_id], what).toEqual([main.userId, 'owner', requestIdOf(res)]);
      rowCheck(rows[0].old_row, rows[0].new_row);
      expect(rows[1].new_row, `${what}: the event holds the facts of the plan and nothing else`).toEqual(facts);
      // no hash and no password in the row images (the audit shape of users leaves the hash out) and no key of a fact that names one
      for (const image of [rows[0].old_row, rows[0].new_row]) if (image !== null) expect(Object.keys(image), `${what}: a row image`).not.toContain('password_hash');
      expect(Object.keys(rows[1].new_row).filter((k) => /pass|hash|token|ticket|secret|cookie/i.test(k)), `${what}: a key of the event`).toEqual([]);
      const text = JSON.stringify(rows);
      for (const p of everyPassword) expect(text, `${what}: a password is in its audit rows`).not.toContain(p);
    }

    // a call that changes nothing leaves nothing: no audit row, no event (the whole footprint is the digest, checked by nothingWritten)
    const nothing = await nothingWritten(() => setRole(id, { role: 'staff' }));
    expect(await auditOf(nothing)).toEqual([]);
    expect(await nothingWritten(() => setActive(id, { active: true }))).toBeDefined();
    expect(await nothingWritten(() => editPerson(id, { changes: { full_name: 'Asha V' } }))).toBeDefined();
  });
});

// ------------------------------------------------------------------ the order of the locks

describe('the order in which a write takes its locks', () => {
  it('lock order: the password is read before the transaction; a temporary password is hashed after that and still before it; inside it the login row is locked FIRST, the role row (when a role is given) after it, and no login row is locked after a role row', async () => {
    const role = await w.world.addRole({ name: fresh('Order'), ticks: ['order_view'] });
    const person = await newPerson({ role: 'staff' });
    const parked = await newPerson({ role: 'staff', active: false });
    const steps: [string, () => Promise<LightMyRequestResponse>, ('users' | 'roles')[]][] = [
      ['add', () => addPerson({ full_name: 'Order Add', email: mail('order'), role: role.key }), ['roles']],
      ['edit', () => editPerson(person.userId, { changes: { full_name: 'Order Edit', email: mail('order') } }), ['users']],
      ['role', () => setRole(person.userId, { role: role.key }), ['users', 'roles']],
      ['switch off', () => setActive(person.userId, { active: false }), ['users']],
      ['switch on', () => setActive(parked.userId, { active: true }), ['users', 'roles']],
      ['reset', () => resetPassword(person.userId), ['users']],
    ];
    let from = 0;
    const hashedAt: number[] = [];
    const real = passwords.hash.bind(passwords);
    const hashing = vi.spyOn(passwords, 'hash').mockImplementation(async (p: string) => {
      hashedAt.push(w.world.spy.sent.length - from); // how many statements the call had sent when the hash was asked for
      return real(p);
    });
    try {
      for (const [what, call, locks] of steps) {
        from = w.world.spy.sent.length;
        hashedAt.length = 0;
        const res = await call();
        expect([200, 201], `${what}: ${res.body}`).toContain(res.statusCode);
        const sent = w.world.spy.sqls().slice(from).map((s) => s.replace(/\s+/g, ' ').trim());
        const begin = sent.indexOf('START TRANSACTION');
        expect(sent.filter((s) => s === 'START TRANSACTION'), `${what}: one transaction`).toHaveLength(1);
        const hashRead = sent.findIndex((s) => /^SELECT password_hash FROM users WHERE id = \?$/.test(s));
        expect(hashRead, `${what}: the password is read (a plain read) ...`).toBeGreaterThan(-1);
        expect(hashRead, `${what}: ... before the transaction begins`).toBeLessThan(begin);
        // a temporary password is made after the password was confirmed and before the transaction: no hash runs while a lock is held
        if (what === 'add' || what === 'reset') {
          expect(hashedAt, `${what}: one temporary password is hashed`).toHaveLength(1);
          expect(hashedAt[0], `${what}: after the password was read ...`).toBeGreaterThan(hashRead);
          expect(hashedAt[0], `${what}: ... and before the transaction began`).toBeLessThanOrEqual(begin);
        } else {
          expect(hashedAt, `${what}: nothing is hashed`).toEqual([]);
        }
        // the locking reads, in the order they were sent, and what they lock
        const locking = sent.map((s, i) => [s, i] as const).filter(([s]) => /\bFOR UPDATE\b/i.test(s));
        const tables = locking.map(([s]) => /^SELECT [a-z_, ]+ FROM (users|roles) WHERE (?:id|role_key) = \? FOR UPDATE$/.exec(s)?.[1]);
        expect(tables, `${what}: the locks, in order (the login row first, then the role row)`).toEqual(locks);
        for (const [, at] of locking) expect(at, `${what}: a lock is inside the transaction`).toBeGreaterThan(begin);
        // no write before the last lock, and (for an add) the e-mail is read before the role row is locked
        const firstWrite = sent.findIndex((s) => /^(INSERT INTO users|UPDATE users)\b/.test(s));
        expect(firstWrite, `${what}: the login is written`).toBeGreaterThan(-1);
        expect(firstWrite, `${what}: the login is written after its locks`).toBeGreaterThan(locking[locking.length - 1][1]);
        if (what === 'add') {
          const emailRead = sent.findIndex((s) => /^SELECT id FROM users WHERE email = \?$/.test(s));
          expect(emailRead, 'add: the e-mail is read (a plain read) inside the transaction ...').toBeGreaterThan(begin);
          expect(emailRead, 'add: ... before the role row is locked').toBeLessThan(locking[0][1]);
        }
        // the role writes of Task 13 take the role row first and count the people with a plain read; the people writes never lock a login after a role row
        expect(sent.some((s) => /\bFROM users\b/i.test(s) && /\bFOR UPDATE\b/i.test(s) && locking.some(([l, at]) => /FROM roles\b/.test(l) && at < sent.indexOf(s))), `${what}: a login row is locked after a role row`).toBe(false);
      }
    } finally {
      hashing.mockRestore();
    }
  });
});

// ------------------------------------------------------------------ a person gets a role while the role is being switched off

/** One person-gets-a-role write of this task, and what each order of the race with the role's switch-off must leave. */
interface Entry {
  name: string;
  /** the trigger that holds the write inside its statement, with the role row locked */
  gate: (ctx: Ctx) => { when: 'BEFORE INSERT' | 'BEFORE UPDATE'; table: 'users'; condition: string };
  setup(role: string): Promise<Ctx>;
  call(ctx: Ctx, role: string): Promise<LightMyRequestResponse>;
  /** what the call answers when the switch-off ran first: the role is off */
  late: { status: number; code: string; message: string; details?: Record<string, unknown> };
  /** the state the write leaves when it ran first (won) or was refused (lost) */
  state(ctx: Ctx): Promise<{ role: string | null; active: boolean | null }>;
  won: { role: string; active: boolean } | 'new';
  lost: { role: string | null; active: boolean | null };
}
interface Ctx {
  name: string;
  email: string;
  id: string | null;
}

describe('a person that is given a role while the role is being switched off: the two are serialised (the switch-off counts the person, or the person is refused)', () => {
  /** A slow trigger that waits on a NAMED LOCK the test holds (GET_LOCK on a connection of its own), instead of sleeping for a fixed time: the call under test is held inside its statement until the test has SEEN the other call
   *  waiting and opens the gate. The trigger gives the lock back at once, so that a second waiter passes too. The name of the lock is made up for this run; the trigger is dropped whatever happens. */
  async function withGate<T>(trigger: string, when: string, table: string, condition: string, run: (gate: { waiting(): Promise<number>; open(): Promise<void> }) => Promise<T>): Promise<T> {
    const lockName = `jv-gate-${randomBytes(6).toString('hex')}`;
    const holder = await w.world.scratch.connect();
    const root = await w.world.scratch.root();
    let closed = true;
    const open = async () => {
      if (!closed) return;
      closed = false;
      await holder.query('SELECT RELEASE_LOCK(?)', [lockName]);
    };
    try {
      const [rows] = await holder.query<any[]>('SELECT GET_LOCK(?, 0) AS got', [lockName]);
      expect(Number((rows as any[])[0].got), 'the gate is closed').toBe(1);
      await w.world.sql.query(`DROP TRIGGER IF EXISTS ${trigger}`);
      await w.world.sql.query(`CREATE TRIGGER ${trigger} ${when} ON ${table} FOR EACH ROW BEGIN IF ${condition} THEN DO GET_LOCK('${lockName}', 60); DO RELEASE_LOCK('${lockName}'); END IF; END`);
      return await run({
        waiting: async () => Number(((await root.query<any[]>("SELECT COUNT(*) AS n FROM information_schema.PROCESSLIST WHERE STATE = 'User lock' AND INFO LIKE ?", [`%${lockName}%`]))[0] as any[])[0].n),
        open,
      });
    } finally {
      await open().catch(() => undefined);
      await w.world.sql.query(`DROP TRIGGER IF EXISTS ${trigger}`).catch(() => undefined);
      await holder.end().catch(() => undefined);
      await root.end().catch(() => undefined);
    }
  }
  /** Polls for a thing that happens in the database; there is no clock in it but the bound after which the test gives up. */
  async function until(what: string, ready: () => Promise<boolean>): Promise<void> {
    for (let i = 0; i < 2400; i++) {
      if (await ready()) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`never reached: ${what}`);
  }
  /** A call of this database waits for a row lock of the roles table now (read as root: the ten-box user cannot see other sessions). */
  async function waitingForARole(): Promise<boolean> {
    const root = await w.world.scratch.root();
    try {
      const [rows] = await root.query<any[]>(
        "SELECT COUNT(*) AS n FROM information_schema.INNODB_TRX t JOIN information_schema.PROCESSLIST p ON p.ID = t.trx_mysql_thread_id WHERE t.trx_state = 'LOCK WAIT' AND t.trx_query LIKE '%FROM roles%' AND p.DB = ?",
        [w.world.scratch.database],
      );
      return Number((rows as any[])[0].n) > 0;
    } finally {
      await root.end();
    }
  }
  const stateOf = async (email: string) => {
    const [row] = await sql<{ role: string; active: number }>('SELECT role, active FROM users WHERE email = ?', [email]);
    return row === undefined ? { role: null, active: null } : { role: row.role, active: Number(row.active) === 1 };
  };

  const ENTRIES: Entry[] = [
    {
      name: 'add',
      gate: (c) => ({ when: 'BEFORE INSERT', table: 'users', condition: `NEW.full_name = '${c.name}'` }),
      setup: async () => ({ name: fresh('Gate Add'), email: mail('gate'), id: null }),
      call: (c, role) => addPerson({ full_name: c.name, email: c.email, role }),
      late: { status: 422, code: 'JV_INVALID_INPUT', message: NOT_ACTIVE_ROLE_SENTENCE, details: { field: 'role' } },
      state: (c) => stateOf(c.email),
      won: 'new',
      lost: { role: null, active: null },
    },
    {
      name: 'change the role',
      gate: (c) => ({ when: 'BEFORE UPDATE', table: 'users', condition: `NEW.full_name = '${c.name}' AND OLD.role <> NEW.role` }),
      setup: async () => {
        const c = { name: fresh('Gate Role'), email: mail('gate'), id: null as string | null };
        c.id = (await newPerson({ role: 'staff', email: c.email })).userId;
        await w.world.sql.query('UPDATE users SET full_name = ? WHERE id = ?', [c.name, c.id]);
        return c;
      },
      call: (c, role) => setRole(c.id as string, { role }),
      late: { status: 422, code: 'JV_INVALID_INPUT', message: NOT_ACTIVE_ROLE_SENTENCE, details: { field: 'role' } },
      state: (c) => stateOf(c.email),
      won: { role: '<the race role>', active: true },
      lost: { role: 'staff', active: true },
    },
    {
      name: 'switch on',
      gate: (c) => ({ when: 'BEFORE UPDATE', table: 'users', condition: `NEW.full_name = '${c.name}' AND OLD.active = 0 AND NEW.active = 1` }),
      setup: async (role) => {
        const c = { name: fresh('Gate On'), email: mail('gate'), id: null as string | null };
        c.id = (await newPerson({ role, email: c.email, active: false })).userId;
        await w.world.sql.query('UPDATE users SET full_name = ? WHERE id = ?', [c.name, c.id]);
        return c;
      },
      call: (c) => setActive(c.id as string, { active: true }),
      late: { status: 409, code: 'JV_NOT_ALLOWED', message: ROLE_OFF_SENTENCE, details: {} },
      state: (c) => stateOf(c.email),
      won: { role: '<the race role>', active: true },
      lost: { role: '<the race role>', active: false },
    },
  ];

  for (const entry of ENTRIES) {
    it(`${entry.name}: the write runs first and holds the role row; the switch-off arrives, WAITS for it, and counts the person (409, the role stays on); the switch-off runs first and holds the role row; the write arrives, WAITS, and finds the role off`, async () => {
      // the password work is not what is raced: no hash is made for this test, so that nothing but the locks decides how long each call takes
      const verifying = vi.spyOn(passwords, 'verify').mockResolvedValue(true);
      const hashing = vi.spyOn(passwords, 'hash').mockResolvedValue('stand-in-hash-of-a-temporary-password');
      try {
        // A. the write holds the role row (it is inside its INSERT or UPDATE, held by the gate); the switch-off arrives, waits for the lock, and counts the new holder
        {
          const role = await w.world.addRole({ name: fresh('RaceA'), ticks: ['order_view'] });
          const ctx = await entry.setup(role.key);
          const g = entry.gate(ctx);
          await withGate(`trg_gate_${letters(6)}`, g.when, g.table, g.condition, async (gate) => {
            const writing = entry.call(ctx, role.key);
            await until('the write is inside its statement, holding the role row', async () => (await gate.waiting()) === 1);
            const switching = switchRole(role.key, false);
            await until('the switch-off waits for the role row', waitingForARole);
            await gate.open();
            const [wrote, off] = await Promise.all([writing, switching]);
            expect([200, 201], wrote.body).toContain(wrote.statusCode);
            const e = refused(off, 409, 'JV_NOT_ALLOWED', {});
            expect(e.message, 'the switch-off counted the person the write gave the role to').toBe('1 people still have this role. Move them to another role first.');
          });
          const list = await send(main, 'GET', '/v1/super/roles');
          expect((list.json().roles as { key: string; active: boolean; people: number }[]).find((r) => r.key === role.key)).toMatchObject({ active: true, people: 1 });
          const now = await entry.state(ctx);
          const expected = entry.won === 'new' ? { role: role.key, active: true } : { role: entry.won.role === '<the race role>' ? role.key : entry.won.role, active: entry.won.active };
          expect(now).toEqual(expected);
        }
        // B. the switch-off holds the role row (it is inside its UPDATE, after it counted nobody); the write arrives, waits for the lock, finds the role off, and is refused: no login ends up on a switched-off role
        {
          const role = await w.world.addRole({ name: fresh('RaceB'), ticks: ['order_view'] });
          const ctx = await entry.setup(role.key);
          await withGate(`trg_gate_${letters(6)}`, 'BEFORE UPDATE', 'roles', `OLD.active = 1 AND NEW.active = 0 AND NEW.role_key = '${role.key}'`, async (gate) => {
            const switching = switchRole(role.key, false);
            await until('the switch-off is inside its UPDATE, holding the role row', async () => (await gate.waiting()) === 1);
            const writing = entry.call(ctx, role.key);
            await until('the write waits for the role row', waitingForARole);
            await gate.open();
            const [off, wrote] = await Promise.all([switching, writing]);
            expect(off.statusCode, off.body).toBe(200);
            const e = refused(wrote, entry.late.status, entry.late.code, entry.late.details);
            expect(e.message).toBe(entry.late.message);
          });
          const list = await send(main, 'GET', '/v1/super/roles');
          expect((list.json().roles as { key: string; active: boolean; people: number }[]).find((r) => r.key === role.key)).toMatchObject({ active: false, people: 0 });
          const now = await entry.state(ctx);
          const expected = { role: entry.lost.role === '<the race role>' ? role.key : entry.lost.role, active: entry.lost.active };
          expect(now).toEqual(expected);
        }
        // the invariant, over the whole database: no active login holds a role that is switched off
        expect(await noActiveLoginOnASwitchedOffRole()).toEqual([]);
      } finally {
        verifying.mockRestore();
        hashing.mockRestore();
      }
    }, 120_000);
  }

  it('two adds of one e-mail at the same moment (it differs in letter case): one makes the login, the other is 422 on email with the words of the check made first, from the unique key under the race; the same for two edits', async () => {
    const verifying = vi.spyOn(passwords, 'verify').mockResolvedValue(true);
    const hashing = vi.spyOn(passwords, 'hash').mockResolvedValue('stand-in-hash-of-a-temporary-password');
    try {
      // two adds, on different roles so that the two calls share no row lock and really overlap: both read the e-mail as free before either has inserted
      const email = mail('mailrace');
      await withGate(`trg_gate_${letters(6)}`, 'BEFORE INSERT', 'users', "NEW.full_name LIKE 'Mail race add%'", async (gate) => {
        const from = w.world.spy.sent.length;
        const first = addPerson({ full_name: 'Mail race add 1', email, role: 'biller' });
        const second = addPerson({ full_name: 'Mail race add 2', email: email.toUpperCase(), role: 'staff' });
        await until('both calls are inside their INSERT (both found the e-mail free)', async () => (await gate.waiting()) === 2);
        await gate.open();
        const answers = await Promise.all([first, second]);
        expect(answers.map((a) => a.statusCode).sort(), `${answers[0].body} ${answers[1].body}`).toEqual([201, 422]);
        const loser = answers.find((a) => a.statusCode === 422) as LightMyRequestResponse;
        expect(refused(loser, 422, 'JV_INVALID_INPUT', { field: 'email' }).message, 'the same words as the check made first').toBe(TAKEN_SENTENCE);
        expect(w.world.spy.sqls().slice(from).filter((s) => /^INSERT INTO users\b/.test(s.trim())), 'the race happened: both calls sent their INSERT').toHaveLength(2);
        expect(await sql('SELECT id FROM users WHERE email = ?', [email])).toHaveLength(1);
      });

      // two edits of two logins to one e-mail: the same
      const one = await newPerson();
      const two = await newPerson();
      const target = mail('editrace');
      await withGate(`trg_gate_${letters(6)}`, 'BEFORE UPDATE', 'users', `NEW.email = '${target}' AND OLD.email <> NEW.email`, async (gate) => {
        const from = w.world.spy.sent.length;
        const first = editPerson(one.userId, { changes: { email: target } });
        const second = editPerson(two.userId, { changes: { email: target.toUpperCase() } });
        await until('both calls are inside their UPDATE', async () => (await gate.waiting()) === 2);
        await gate.open();
        const answers = await Promise.all([first, second]);
        expect(answers.map((a) => a.statusCode).sort(), `${answers[0].body} ${answers[1].body}`).toEqual([200, 422]);
        const loser = answers.find((a) => a.statusCode === 422) as LightMyRequestResponse;
        expect(refused(loser, 422, 'JV_INVALID_INPUT', { field: 'email' }).message).toBe(TAKEN_SENTENCE);
        expect(w.world.spy.sqls().slice(from).filter((s) => /^UPDATE users SET full_name = \?, email = \?/.test(s.trim()))).toHaveLength(2);
        expect(await sql('SELECT id FROM users WHERE email = ?', [target])).toHaveLength(1);
        // the loser's login is as it was, and its sessions are not ended by a write that did not happen
        const loserId = loser === answers[0] ? one.userId : two.userId;
        expect(await sessionsOf(loserId)).toEqual({ live: 1, ended: 0 });
      });
    } finally {
      verifying.mockRestore();
      hashing.mockRestore();
    }
  }, 120_000);
});

// ------------------------------------------------------------------ the node writer writes what the trigger writes

describe('the audit rows of the users table in both mechanisms (L1)', () => {
  it('with JV_AUDIT_MODE=node (no triggers) the five writes leave the same audit rows and events the triggers leave', async () => {
    const node = await editWorld('superpeoplen', { config: { auditMode: 'node', logLevel: 'warn' } });
    try {
      const nodeAdmin = node.world.fixtures.super.userId;
      await node.world.sql.query('UPDATE users SET password_hash = ? WHERE id = ?', [storedHash, nodeAdmin]);
      const nodeSend = (method: 'POST' | 'PATCH', url: string, payload: object) => node.world.app.inject({ method, url, headers: { ...csrfHeaders(), cookie: node.world.cookieOf('super') as string }, payload });

      // the same sequence in the node world and in the world with the triggers: add, edit, role, off, on, reset. Each call's rows are read by its request id.
      const run = async (post: (method: 'POST' | 'PATCH', url: string, payload: object) => Promise<LightMyRequestResponse>, query: <T>(text: string, params?: unknown[]) => Promise<T[]>, setPlain: (id: string) => Promise<void>) => {
        const made = await post('POST', PEOPLE, { full_name: 'Twin Person', email: 'twin-person@example.test', role: 'biller', password: PASSWORD });
        expect(made.statusCode, made.body).toBe(201);
        remember(made.json().temporary_password);
        const id = made.json().person.id as string;
        await setPlain(id); // a person who changed the password long ago, so that the reset changes something an audit row can show
        const calls: [string, 'POST' | 'PATCH', string, object][] = [
          ['edit', 'PATCH', `${PEOPLE}/${id}`, { changes: { full_name: 'Twin Edited', email: 'twin-edited@example.test' } }],
          ['role', 'POST', `${PEOPLE}/${id}/role`, { role: 'staff' }],
          ['off', 'POST', `${PEOPLE}/${id}/active`, { active: false }],
          ['on', 'POST', `${PEOPLE}/${id}/active`, { active: true }],
          ['reset', 'POST', `${PEOPLE}/${id}/reset-password`, {}],
        ];
        const requests = [requestIdOf(made)];
        for (const [what, method, url, body] of calls) {
          const res = await post(method, url, { ...body, password: PASSWORD });
          expect(res.statusCode, `${what}: ${res.body}`).toBe(200);
          if (what === 'reset') remember(res.json().temporary_password);
          requests.push(requestIdOf(res));
        }
        // what each database holds in audit_log for those requests, with the ids and the stamps masked (the two worlds have other users and other moments)
        const rows: any[] = [];
        for (const request of requests) rows.push(await query<any>('SELECT actor, actor_role, table_name, row_id, action, old_row, new_row FROM audit_log WHERE request_id = ? ORDER BY id', [request]));
        return { id, rows };
      };
      const mask = (rows: any[], person: string, admin: string) =>
        JSON.parse(
          JSON.stringify(rows.map((group) => group.map((r: any) => ({ ...r, old_row: parse(r.old_row), new_row: parse(r.new_row) })))).split(person).join('<person>').split(admin).join('<admin>').replace(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}/g, '<time>'),
        ) as any[][];

      const viaNode = await run(
        nodeSend,
        async (text, params = []) => (await node.world.sql.query<any[]>(text, params))[0] as any[],
        async (id) => void (await node.world.sql.query('UPDATE users SET must_change_password = 0 WHERE id = ?', [id])),
      );
      const viaTriggers = await run((m, url, payload) => send(main, m, url, payload), sql, async (id) => void (await w.world.sql.query('UPDATE users SET must_change_password = 0 WHERE id = ?', [id])));
      const nodeRows = mask(viaNode.rows, viaNode.id, nodeAdmin);
      const triggerRows = mask(viaTriggers.rows, viaTriggers.id, main.userId);
      // six calls, each: the row of the users table (the Node writer in one world, the trigger in the other) and the event
      expect(nodeRows.map((group) => group.map((r: any) => r.action))).toEqual([['insert', 'event'], ['update', 'event'], ['update', 'event'], ['update', 'event'], ['update', 'event'], ['update', 'event']]);
      expect(nodeRows).toEqual(triggerRows);
      expect(nodeRows[0][0].new_row).toMatchObject({ email: 'twin-person@example.test', role: 'biller', must_change_password: 1, is_super_admin: 0, created_by: '<admin>', updated_by: '<admin>' });
      for (const group of nodeRows) for (const r of group) expect(Object.keys(r.new_row), 'no hash in a row').not.toContain('password_hash');
      // nothing is written twice: the node world has no trigger, so the six calls left six row images of the users table for that person, and the world with the triggers the same six
      const imagesOf = async (query: <T>(text: string, params?: unknown[]) => Promise<T[]>, id: string) => Number((await query<{ n: string }>("SELECT COUNT(*) AS n FROM audit_log WHERE table_name = 'users' AND action <> 'event' AND row_id = ? AND request_id IS NOT NULL", [id]))[0].n);
      expect(await imagesOf(async (text, params = []) => (await node.world.sql.query<any[]>(text, params))[0] as any[], viaNode.id)).toBe(6);
      expect(await imagesOf(sql, viaTriggers.id)).toBe(6);
    } finally {
      await node.world.close();
    }
  }, 120_000);
});

// ------------------------------------------------------------------ A8

describe('A8', () => {
  /** The statements of src/ that insert into or update `users` (the statement's text up to the next quote), by file. */
  function usersWriters(): Record<string, string[]> {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.ts$/.test(name)) files.push(p);
      }
    };
    walk(join(REPO, 'src'));
    const found: Record<string, string[]> = {};
    for (const file of files) {
      const hits = [...readFileSync(file, 'utf8').matchAll(/\b(?:INSERT\s+(?:IGNORE\s+)?INTO|UPDATE|REPLACE\s+INTO)\s+`?users`?\b[^'"`]*/gi)].map((m) => m[0]);
      if (hits.length > 0) found[relative(REPO, file)] = hits;
    }
    return found;
  }

  it('A8 now reads: the routes that write users are the admin door, login and change-password, and /v1/super/people (the test that pinned "no route updates users" is changed on purpose; the commit says why)', () => {
    // the route table: of everything that can write a login by its address, the session routes are the five of the Super Admin and nothing else; the rest is the admin door's
    const writes = w.world.app.routeTable.filter((r) => r.method !== 'GET' && /\/(users|people)\b/.test(r.url));
    const doorRoutes = writes.filter((r) => r.kind === 'token');
    const crmRoutes = writes.filter((r) => r.kind !== 'token');
    expect(doorRoutes.length, 'the admin door has its routes').toBeGreaterThan(0);
    for (const r of doorRoutes) expect(r, `${r.method} ${r.url}`).toMatchObject({ kind: 'token', name: 'admin' });
    expect(crmRoutes.map((r) => `${r.method} ${r.url} ${r.action}`).sort()).toEqual([...FIVE].sort());
    for (const r of crmRoutes) expect(r, `${r.method} ${r.url}`).toMatchObject({ kind: 'matrix', access: { superAdmin: true }, mustChange: false });
    // and no row of the matrix is a generic edit of users: the five are `super` rows with a function of their own, not an edit of a table
    for (const [action, row] of Object.entries(MATRIX)) if ('edit' in row && row.edit) expect(row.edit.table, action).not.toBe('users');
    for (const action of FIVE.map((f) => f.split(' ')[2])) expect(MATRIX[action as keyof typeof MATRIX], action).toMatchObject({ kind: 'super', access: { superAdmin: true } });

    // the source: a statement that writes users is in the admin door, in change-password (the person's own password, nothing else) and in the five people calls of the Super Admin: nowhere else
    const found = usersWriters();
    const door = Object.keys(found).filter((f) => f.startsWith(`src${'/'}admin${'/'}`));
    expect(door.length, 'the door has its statements').toBeGreaterThan(0);
    expect(Object.keys(found).filter((f) => !door.includes(f)).sort()).toEqual(['src/auth/loginRoutes.ts', 'src/super/people.ts']);
    for (const h of found['src/auth/loginRoutes.ts']) {
      expect(h).toMatch(/SET\s+password_hash\s*=\s*\?,\s*must_change_password\s*=\s*0\s+WHERE\s+id\s*=\s*\?/i);
      expect(h).not.toMatch(/\b(role|active|email)\s*=/i);
    }
    // the Super Admin's calls write the six things the screen shows (the person's row on add, the name and e-mail, the role, the switch, the password) and never the flag: the terminal door alone sets it (DESIGN 6.6 rule 3)
    expect(found['src/super/people.ts']).toHaveLength(5);
    for (const h of found['src/super/people.ts']) {
      expect(h, 'a statement of the people calls').not.toMatch(/is_super_admin/i);
      // anchored at both ends: the whole statement is one of these five texts, so an appended `OR 1=1`, an extra `SET` clause or a changed `VALUES` list fails
      expect(h).toMatch(/^(INSERT INTO users \(id, email, full_name, role, active, password_hash, must_change_password, created_at, updated_at, created_by, updated_by\) VALUES \(\?, \?, \?, \?, 1, \?, 1, \?, \?, \?, \?\)|UPDATE users SET (full_name = \?, email = \?|role = \?|active = \?|password_hash = \?, must_change_password = 1), updated_at = \?, updated_by = \? WHERE id = \?)$/);
    }
    const flagWriters = Object.entries(found).filter(([, hits]) => hits.some((h) => /is_super_admin/i.test(h))).map(([file]) => file);
    expect(flagWriters.length, 'the flag is written by the terminal door').toBeGreaterThan(0);
    for (const file of flagWriters) expect(file.startsWith(`src${'/'}admin${'/'}`), `${file} sets the Super Admin flag`).toBe(true);
  });
});

// ------------------------------------------------------------------ no password anywhere

describe('the temporary password and the Super Admin\'s password go nowhere but the answer that made the first', () => {
  it('no password, temporary or wrong or right, appears in a log line, an audit row or an event fact; no stored hash appears in the log or in an audit row; the temporary passwords are only hashes in the database', async () => {
    // one of every kind of outcome so far is in the log and the audit rows already; add one more of each of the five, and the refusals that must not leak a value
    const person = await newPerson();
    await addPerson({ full_name: 'Log Check', email: mail('log'), role: 'staff' });
    await editPerson(person.userId, { changes: { full_name: 'Log Checked' } });
    await resetPassword(person.userId);
    await setRole(person.userId, { role: 'biller', password: wrongOne() });
    await addPerson({ full_name: 'Log Check', email: person.email, role: 'staff' }); // a taken e-mail
    await addPerson({ full_name: 'Log Check', email: mail(), role: 'staff', password: undefined });
    expect(everyPassword.length, 'the file made up many passwords').toBeGreaterThan(30);

    const logged = w.world.logs.text();
    expect(logged.length, 'the log is on and holds the requests of this file').toBeGreaterThan(1000);
    const asText = (v: unknown) => (v === null || v === undefined ? '' : typeof v === 'string' ? v : JSON.stringify(v));
    const audited = (await sql<{ o: unknown; n: unknown }>('SELECT old_row AS o, new_row AS n FROM audit_log')).map((r) => `${asText(r.o)}${asText(r.n)}`).join('\n');
    expect(audited.length).toBeGreaterThan(1000);
    const hashes = (await sql<{ password_hash: string }>('SELECT password_hash FROM users')).map((r) => r.password_hash);
    for (const p of everyPassword) {
      expect(logged, 'a password is in the log').not.toContain(p);
      expect(audited, 'a password is in an audit row or an event fact').not.toContain(p);
      for (const h of hashes) expect(h, 'a password is stored in the clear').not.toContain(p);
    }
    for (const h of hashes) {
      expect(logged, 'a stored hash is in the log').not.toContain(h);
      expect(audited, 'a stored hash is in an audit row').not.toContain(h);
    }
    // no key of any event fact of the users table names a password, a hash, a token or a ticket
    const facts = await sql<{ n: string }>("SELECT new_row AS n FROM audit_log WHERE action = 'event' AND table_name = 'users' AND JSON_VALUE(new_row, '$.event') LIKE 'person\\_%'");
    expect(facts.length).toBeGreaterThan(10);
    for (const f of facts) expect(Object.keys(parse(f.n) as object).filter((k) => /pass|hash|token|ticket|secret|cookie/i.test(k))).toEqual([]);
    // nor a session id, nor the ticket of a session, in what the people calls wrote (a login's own event names its session; these do not): the facts of the people events and every image of a row of users
    const peopleAudit = (await sql<{ o: unknown; n: unknown }>("SELECT old_row AS o, new_row AS n FROM audit_log WHERE table_name = 'users' AND (action <> 'event' OR JSON_VALUE(new_row, '$.event') LIKE 'person\\_%')")).map((r) => `${asText(r.o)}${asText(r.n)}`).join('\n');
    expect(peopleAudit.length).toBeGreaterThan(1000);
    for (const s of await sql<{ id: string }>('SELECT id FROM sessions')) expect(peopleAudit, 'a session id is in the audit rows of the users table').not.toContain(s.id);
    expect(peopleAudit, 'a ticket is in the audit rows of the users table').not.toContain(main.cookie.split('=')[1]);
    // the Review Focus 3 invariant held through the whole file
    expect(await noActiveLoginOnASwitchedOffRole()).toEqual([]);
  });
});
