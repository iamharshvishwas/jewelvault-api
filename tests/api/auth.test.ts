import nodeCrypto, { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sleep } from '../helpers';
import { migrate } from '../../scripts/migrate.mjs';
import { registerAuthRoutes } from '../../src/auth/loginRoutes';
import { passwords } from '../../src/auth/password';
import { buildApp } from '../../src/app';
import { createClock } from '../../src/clock';
import { withTx, txContextFor } from '../../src/db/tx';
import { limits } from '../../src/limits';
import { MATRIX } from '../../src/permissions/matrix';
import { route } from '../../src/permissions/route';
import { SESSION_COOKIE, microsOfDbTimestamp, newTicket } from '../../src/permissions/session';
import { registerSyncRoutes } from '../../src/sync/routes';
import { T0, type World, concreteUrl, makeWorld, registerStubs } from './cells';
import { csrfHeaders, secret, testConfig } from './support';

// API05: the session routes and the login. T-D13, T-D25 (HTTP half), T-D26, T-D06 (HTTP half), T-D15, and the clauses of T-D14 (one event row for a login, a logout and a change-password, no secret in it)
// and T-D02 (the rows of the session calls; the generated test walks them, tests/matrix.generated.test.ts). The password rules and the hash strings are tests/api/password.test.ts.
//
// Two worlds (a scratch database with the real schema, the real session routes, a stub behind every other row of the matrix): one on a fixed clock for everything that does not move time, one on a clock
// the test moves for T-D26. Passwords are made up at run time; one hash is made once and shared by the users, because a real hash takes a fifth of a second.

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const ABSOLUTE_S = limits.sessionAbsoluteMs / 1000;

interface Parsed {
  name: string;
  value: string;
  flags: string[];
  attrs: Record<string, string>;
}

function parseSetCookie(header: string): Parsed {
  const [first, ...rest] = header.split(';').map((p) => p.trim());
  const eq = first.indexOf('=');
  const flags: string[] = [];
  const attrs: Record<string, string> = {};
  for (const part of rest) {
    const i = part.indexOf('=');
    if (i < 0) flags.push(part.toLowerCase());
    else attrs[part.slice(0, i).toLowerCase()] = part.slice(i + 1);
  }
  return { name: first.slice(0, eq), value: first.slice(eq + 1), flags, attrs };
}

const setCookies = (res: LightMyRequestResponse): string[] => {
  const h = res.headers['set-cookie'];
  return h === undefined ? [] : Array.isArray(h) ? h : [h];
};

const errorOf = (res: LightMyRequestResponse) => (res.json() as { error: { code: string; message: string; details: Record<string, unknown> }; request_id: string }).error;

// ------------------------------------------------------------------------------------------------ the first world: a fixed clock

let world: World;
let PASSWORD: string;
let HASH: string;

const inject = (method: 'GET' | 'POST' | 'PATCH' | 'PUT', url: string, o: { payload?: unknown; cookie?: string; headers?: Record<string, string>; app?: World['app'] } = {}) =>
  (o.app ?? world.app).inject({ method, url, payload: o.payload as object | undefined, headers: { ...(method === 'GET' ? {} : csrfHeaders()), ...(o.cookie ? { cookie: o.cookie } : {}), ...o.headers } });

// A13 (API08): a login from no usable address shares the 60 a minute of every such login, and this file logs in more than that, so every call of the helper comes from an address of its own
// (a test of the address rows gives its own header, which wins).
let loginNumber = 0;
const loginWith = (email: string, password: string, o: { cookie?: string; headers?: Record<string, string>; app?: World['app'] } = {}) => {
  loginNumber += 1;
  return inject('POST', '/v1/auth/login', { payload: { email, password }, ...o, headers: { 'x-real-ip': `198.18.${(loginNumber >> 8) & 255}.${loginNumber & 255}`, ...o.headers } });
};

/** A user with a real hash of PASSWORD. The fixture session that addUser makes is "another browser". */
const makeUser = (role: 'owner' | 'biller' | 'staff', extra: { active?: boolean; mustChange?: boolean; hash?: string } = {}, w: World = world) =>
  w.addUser({ role, active: extra.active, mustChange: extra.mustChange, passwordHash: extra.hash ?? HASH });

async function signIn(role: 'owner' | 'biller' | 'staff' = 'biller', extra: { active?: boolean; mustChange?: boolean } = {}, w: World = world) {
  const u = await makeUser(role, extra, w);
  const res = await loginWith(u.email, PASSWORD, { app: w.app });
  if (res.statusCode !== 200) throw new Error(`login failed: ${res.statusCode} ${res.body}`);
  const cookie = parseSetCookie(setCookies(res)[0]);
  return { ...u, res, ticket: cookie.value, cookie: `${SESSION_COOKIE}=${cookie.value}`, loginCookie: cookie };
}

const sessionsOf = async (userId: string, w: World = world) =>
  (await w.sql.query<any[]>('SELECT id, HEX(token_hash) AS token_hash, created_at, last_seen_at, expires_at, revoked_at, user_agent FROM sessions WHERE user_id = ? ORDER BY created_at, id', [userId]))[0] as {
    id: string;
    token_hash: string;
    created_at: string;
    last_seen_at: string;
    expires_at: string;
    revoked_at: string | null;
    user_agent: string | null;
  }[];

const userRow = async (userId: string, w: World = world) => (await w.sql.query<any[]>('SELECT * FROM users WHERE id = ?', [userId]))[0][0] as Record<string, any>;
const countOf = async (table: string, w: World = world) => Number((await w.sql.query<any[]>(`SELECT COUNT(*) AS n FROM ${table}`))[0][0].n);
const maxAuditId = async (w: World = world) => Number((await w.sql.query<any[]>('SELECT COALESCE(MAX(id), 0) AS n FROM audit_log'))[0][0].n);
const auditSince = async (id: number, w: World = world) =>
  (await w.sql.query<any[]>('SELECT id, actor, actor_role, request_id, table_name, row_id, action, old_row, new_row FROM audit_log WHERE id > ? ORDER BY id', [id]))[0] as Record<string, any>[];

beforeAll(async () => {
  PASSWORD = secret('Pw');
  HASH = await passwords.hash(PASSWORD);
  world = await makeWorld({ label: 'auth', routes: true, build: (app, w) => registerStubs(app, w.handled) });
  // with the audit triggers of db/optional, as on the plan (L1): then "one event row" can be told from the rows a trigger writes
  await migrate(world.sql, { seeds: false, optional: true });
}, 120_000);

afterAll(async () => {
  await world?.close();
});

// ------------------------------------------------------------------------------------------------ T-D02 / T-D01: the routes exist as the matrix says

describe('T-D02 the session calls are routes of the application, registered through route() with the rows of the matrix; the login is the public route', () => {
  it('me, logout, change-password and activity have their rows and the login its place on the public list: registered by the application itself, not by the stubs of the test', async () => {
    const catalog = buildApp({ config: testConfig({ logLevel: 'silent' }) }); // the application's own routes (src/routes.ts), no database
    await catalog.ready();
    const table = catalog.routeTable;
    await catalog.close();
    for (const action of ['session:me', 'session:logout', 'session:change-password', 'session:activity'] as const) {
      const r = table.find((t) => t.action === action);
      expect(r, action).toBeDefined();
      expect(r).toMatchObject({ kind: 'matrix', method: MATRIX[action].method, url: MATRIX[action].path });
    }
    expect(table.find((t) => t.kind === 'public' && t.name === 'login')).toMatchObject({ method: 'POST', url: '/v1/auth/login' });
  });
});

// ------------------------------------------------------------------------------------------------ T-D13

describe('T-D13 there is no sign-up; a wrong e-mail and a wrong password give the same JV_BAD_LOGIN', () => {
  const PATHS = ['/v1/auth/register', '/v1/auth/signup', '/v1/auth/sign-up', '/v1/auth/signUp', '/v1/auth/create-account', '/v1/signup', '/v1/register', '/v1/users', '/v1/auth/users', '/auth/v1/signup', '/signup', '/register', '/v1/auth/invite'];

  it('sign-up-looking paths answer 404 JV_NOT_FOUND to everyone (no session, an owner), for GET and POST, and no user is made', async () => {
    const owner = await signIn('owner');
    const before = await countOf('users');
    for (const path of PATHS) {
      for (const method of ['GET', 'POST'] as const) {
        for (const cookie of [undefined, owner.cookie]) {
          const res = await inject(method, path, { payload: method === 'POST' ? { email: 'new.person@example.test', password: secret('Pw'), full_name: 'New Person', role: 'owner' } : undefined, cookie });
          expect(res.statusCode, `${method} ${path}`).toBe(404);
          expect(errorOf(res).code).toBe('JV_NOT_FOUND');
        }
      }
    }
    expect(await countOf('users')).toBe(before);
  });

  it('a login with an e-mail that does not exist and one with a wrong password give the same answer: status, code, message and details', async () => {
    const u = await makeUser('biller');
    const wrong = await loginWith(u.email, secret('Wrong'));
    const unknown = await loginWith(`nobody-${randomUUID().slice(0, 8)}@example.test`, secret('Wrong'));
    for (const res of [wrong, unknown]) {
      expect(res.statusCode).toBe(401);
      expect(errorOf(res)).toEqual({ code: 'JV_BAD_LOGIN', message: 'Wrong email or password.', details: {} });
      expect(setCookies(res)).toEqual([]);
    }
    expect(wrong.json().error).toEqual(unknown.json().error);
  });

  it('both ran one password verification (the unknown e-mail runs the dummy hash), and took about the same time', async () => {
    const u = await makeUser('biller');
    const verify = vi.spyOn(passwords, 'verify');
    try {
      const time = async (email: string) => {
        const t = performance.now();
        const res = await loginWith(email, secret('Wrong'));
        expect(res.statusCode).toBe(401);
        return performance.now() - t;
      };
      const wrongTimes: number[] = [];
      const unknownTimes: number[] = [];
      let wrongCalls = 0;
      let unknownCalls = 0;
      for (let i = 0; i < 3; i++) {
        let before = verify.mock.calls.length;
        wrongTimes.push(await time(u.email));
        wrongCalls += verify.mock.calls.length - before;
        before = verify.mock.calls.length;
        unknownTimes.push(await time(`nobody-${randomUUID().slice(0, 8)}@example.test`));
        unknownCalls += verify.mock.calls.length - before;
      }
      expect(wrongCalls).toBe(3);
      expect(unknownCalls).toBe(3);
      const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[1];
      // about the same time: the hash dominates both; without the dummy hash the unknown e-mail would answer in a few milliseconds
      expect(median(unknownTimes)).toBeGreaterThan(median(wrongTimes) / 3);
      expect(median(unknownTimes)).toBeLessThan(median(wrongTimes) * 3);
    } finally {
      verify.mockRestore();
    }
  });

  it('a correct password for an e-mail in other letters still logs in (the login name ignores case, D1), and a wrong password for it is the same bad login', async () => {
    const u = await makeUser('staff');
    expect((await loginWith(u.email.toUpperCase(), PASSWORD)).statusCode).toBe(200);
    expect((await loginWith(u.email.toUpperCase(), `${PASSWORD}x`)).statusCode).toBe(401);
  });
});

// ------------------------------------------------------------------------------------------------ T-D25 (HTTP half)

describe('T-D25 login: the cookie, a new ticket every time, the old session ended, the inactive user, the stored hash', () => {
  it('the cookie is __Host-jv_session with HttpOnly, Secure, SameSite=Strict, Path=/, no Domain and a Max-Age of 14 days; the ticket is 32 random bytes', async () => {
    const u = await signIn('biller');
    const cookies = setCookies(u.res);
    expect(cookies).toHaveLength(1);
    const c = parseSetCookie(cookies[0]);
    expect(c.name).toBe('__Host-jv_session');
    expect(c.name).toBe(SESSION_COOKIE);
    expect(c.value).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(c.value, 'base64url')).toHaveLength(32);
    expect(c.flags).toContain('httponly');
    expect(c.flags).toContain('secure');
    expect(c.attrs.samesite).toBe('Strict');
    expect(c.attrs.path).toBe('/');
    expect(c.attrs['max-age']).toBe(String(14 * 24 * 3600));
    expect(Number(c.attrs['max-age'])).toBe(ABSOLUTE_S);
    expect(Object.keys(c.attrs)).not.toContain('domain'); // a __Host- cookie has none: it belongs to the API's host only
  });

  it('the body names the user and the limits, and holds no hash, ticket or flag of the database', async () => {
    const u = await signIn('owner');
    const body = u.res.json();
    expect(body).toEqual({
      user: { id: u.userId, email: u.email, full_name: expect.any(String), role: 'owner', must_change_password: false },
      idle_timeout_s: limits.sessionIdleMs / 1000,
      absolute_expires_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/),
    });
    expect(u.res.body).not.toContain(u.ticket);
    expect(u.res.body).not.toContain(HASH);
    expect(u.res.body).not.toMatch(/password_hash|token_hash/);
  });

  it('only the SHA-256 of the ticket is stored; the session lives 14 days from the login, in the API clock', async () => {
    const u = await signIn('biller');
    const rows = (await sessionsOf(u.userId)).filter((s) => s.id !== u.sessionId); // not the fixture session
    expect(rows).toHaveLength(1);
    expect(rows[0].token_hash.toLowerCase()).toBe(createHash('sha256').update(u.ticket).digest('hex'));
    expect(JSON.stringify(rows)).not.toContain(u.ticket);
    expect(rows[0].revoked_at).toBeNull();
    expect(microsOfDbTimestamp(rows[0].expires_at) - microsOfDbTimestamp(rows[0].created_at)).toBe(BigInt(limits.sessionAbsoluteMs) * 1000n);
    expect(rows[0].last_seen_at).toBe(rows[0].created_at);
    expect(rows[0].created_at.slice(0, 10)).toBe('2026-10-17'); // the injected clock, not the database's
  });

  it('a new ticket at every login, and the old session of that browser is ended (the row stays); the old cookie is a 401', async () => {
    const first = await signIn('biller');
    const second = await loginWith(first.email, PASSWORD, { cookie: first.cookie });
    expect(second.statusCode).toBe(200);
    const newTicket = parseSetCookie(setCookies(second)[0]).value;
    expect(newTicket).not.toBe(first.ticket);
    const rows = (await sessionsOf(first.userId)).filter((s) => s.id !== first.sessionId);
    expect(rows).toHaveLength(2); // revoked sessions stay as rows
    const byHash = (t: string) => rows.find((r) => r.token_hash.toLowerCase() === createHash('sha256').update(t).digest('hex'))!;
    expect(byHash(first.ticket).revoked_at).not.toBeNull();
    expect(byHash(newTicket).revoked_at).toBeNull();
    const old = await inject('GET', '/v1/auth/me', { cookie: first.cookie });
    expect(old.statusCode).toBe(401);
    expect(errorOf(old).code).toBe('JV_UNAUTHENTICATED');
    expect((await inject('GET', '/v1/auth/me', { cookie: `${SESSION_COOKIE}=${newTicket}` })).statusCode).toBe(200);
  });

  it('against session fixation: a login by another user in a browser that holds a session ends that session, and a ticket the browser made up is not adopted', async () => {
    const a = await signIn('owner');
    const b = await makeUser('staff');
    const res = await loginWith(b.email, PASSWORD, { cookie: a.cookie });
    expect(res.statusCode).toBe(200);
    expect((await inject('GET', '/v1/auth/me', { cookie: a.cookie })).statusCode).toBe(401);
    // a ticket of the right shape that nobody holds is not accepted as the new session's ticket
    const planted = randomBytes(32).toString('base64url');
    const res2 = await loginWith(b.email, PASSWORD, { cookie: `${SESSION_COOKIE}=${planted}` });
    expect(res2.statusCode).toBe(200);
    expect(parseSetCookie(setCookies(res2)[0]).value).not.toBe(planted);
  });

  it('a login does not end the same user\'s sessions in other browsers (only a password change does)', async () => {
    const u = await signIn('biller');
    expect((await inject('GET', '/v1/auth/me', { cookie: u.cookie })).statusCode).toBe(200);
    const other = await loginWith(u.email, PASSWORD); // no cookie: another browser
    expect(other.statusCode).toBe(200);
    expect((await inject('GET', '/v1/auth/me', { cookie: u.cookie })).statusCode).toBe(200);
    expect((await inject('GET', '/v1/auth/me', { cookie: u.loginCookie.name + '=' + parseSetCookie(setCookies(other)[0]).value })).statusCode).toBe(200);
  });

  it('a correct password for a user who is not active: 403 JV_FORBIDDEN with details.reason "inactive", no session, no cookie; a wrong password for that user is the plain bad login', async () => {
    const u = await makeUser('biller', { active: false });
    const before = (await sessionsOf(u.userId)).length;
    const ok = await loginWith(u.email, PASSWORD);
    expect(ok.statusCode).toBe(403);
    expect(errorOf(ok)).toMatchObject({ code: 'JV_FORBIDDEN', details: { reason: 'inactive' } });
    expect(setCookies(ok)).toEqual([]);
    expect((await sessionsOf(u.userId)).length).toBe(before);
    const bad = await loginWith(u.email, secret('Wrong'));
    expect(bad.statusCode).toBe(401);
    expect(errorOf(bad).code).toBe('JV_BAD_LOGIN'); // nobody learns that the account exists and is inactive without the password
  });

  it('a user who must change the password logs in, and is told so', async () => {
    const u = await signIn('staff', { mustChange: true });
    expect(u.res.json().user.must_change_password).toBe(true);
  });

  it('the body takes e-mail and password and nothing else: a role or any other key is refused (strict), and no session is made', async () => {
    const u = await makeUser('biller');
    const before = await countOf('sessions');
    for (const extra of [{ role: 'owner' }, { active: true }, { remember: true }]) {
      const res = await inject('POST', '/v1/auth/login', { payload: { email: u.email, password: PASSWORD, ...extra } });
      expect(res.statusCode).toBe(422);
      expect(errorOf(res).code).toBe('JV_INVALID_INPUT');
    }
    for (const bad of [{}, { email: u.email }, { password: PASSWORD }, { email: 5, password: PASSWORD }, { email: u.email, password: 7 }]) expect((await inject('POST', '/v1/auth/login', { payload: bad })).statusCode).toBe(422);
    expect((await inject('POST', '/v1/auth/login')).statusCode).toBe(422);
    expect(await countOf('sessions')).toBe(before);
  });

  it('a password longer than 128 characters can never be right: the plain bad login, not a different answer', async () => {
    const u = await makeUser('biller');
    const res = await loginWith(u.email, 'x'.repeat(129));
    expect(res.statusCode).toBe(401);
    expect(errorOf(res).code).toBe('JV_BAD_LOGIN');
  });

  it('the user agent is kept (cut to the column\'s 200 characters), never the password', async () => {
    const u = await makeUser('staff');
    const res = await loginWith(u.email, PASSWORD, { headers: { 'user-agent': `Browser/1.0 ${'x'.repeat(500)}` } });
    expect(res.statusCode).toBe(200);
    const row = (await sessionsOf(u.userId)).find((s) => s.id !== u.sessionId)!;
    expect(row.user_agent).toHaveLength(200);
  });

  it('at most 2 password checks run at the same time, however many logins arrive together', async () => {
    const u = await makeUser('biller');
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => loginWith(i % 2 ? u.email : `nobody-${i}@example.test`, secret('Wrong'))));
    expect(results.every((r) => r.statusCode === 401)).toBe(true);
    const stats = passwords.stats();
    expect(stats.peak).toBe(2);
    expect(stats.inFlight).toBe(0);
    expect(stats.waiting).toBe(0);
  });

  it('what the database stores for a password is a self-describing hash string, never the password', async () => {
    const u = await makeUser('biller');
    const row = await userRow(u.userId);
    expect(row.password_hash).toMatch(passwords.scheme === 'argon2id' ? /^\$argon2id\$v=19\$m=65536,t=3,p=1\$/ : /^\$scrypt\$ln=17,r=8,p=1\$/);
    expect(row.password_hash).not.toContain(PASSWORD);
  });
});

// ------------------------------------------------------------------------------------------------ PT-RV1b (RV1-3): the ticket is random

describe('PT-RV1b T-D25 (RV1-3) the session ticket is random, not only 32 bytes long (U12, impl-review-1 N08)', () => {
  it('2,000 tickets are all different and every one of the 32 byte positions takes more than 100 different values (a ticket of 4 random bytes and 28 zero bytes has 43 characters too, and fails this)', () => {
    const CALLS = 2_000;
    const tickets = Array.from({ length: CALLS }, () => newTicket());
    expect(new Set(tickets).size).toBe(CALLS);
    const seen = Array.from({ length: 32 }, () => new Set<number>());
    for (const ticket of tickets) {
      expect(ticket).toMatch(/^[A-Za-z0-9_-]{43}$/);
      const bytes = Buffer.from(ticket, 'base64url');
      expect(bytes).toHaveLength(32);
      bytes.forEach((byte, position) => seen[position].add(byte));
    }
    // 2,000 draws from 256 values leave about 256 different ones in each position; 100 is far below any chance and far above a position that is fixed or has only a few bits
    seen.forEach((values, position) => expect(values.size, `byte ${position} of the ticket`).toBeGreaterThan(100));
  });

  it('a ticket is exactly what crypto.randomBytes(32) returned, nothing mixed in, cut or padded: the spy sees one call, with 32', () => {
    const spy = vi.spyOn(nodeCrypto, 'randomBytes');
    syncBuiltinESMExports(); // the named export src/permissions/session.ts imported follows the spy
    try {
      const ticket = newTicket();
      expect(spy.mock.calls).toEqual([[32]]);
      expect(ticket).toBe((spy.mock.results[0].value as Buffer).toString('base64url'));
    } finally {
      spy.mockRestore();
      syncBuiltinESMExports();
    }
  });
});

// ------------------------------------------------------------------------------------------------ PT-RV1b (RV1-4): the password changed while the login was verified

describe('PT-RV1b T-D25 (RV1-4) a login whose password changed, or whose user was deactivated, while it was being verified is refused (U11, impl-review-1 N23)', () => {
  /**
   * Holds the FIRST verification asked for, after its answer is known and before the login goes on: the password has been checked against the hash the login read, no connection is held, and the
   * transaction that makes the session has not begun. Every other verification (the change of password in between) runs at once.
   */
  function holdFirstVerification() {
    const real = passwords.verify.bind(passwords);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let verified!: (answer: boolean) => void;
    const reached = new Promise<boolean>((resolve) => (verified = resolve));
    let held = false;
    const spy = vi.spyOn(passwords, 'verify').mockImplementation(async (password, stored) => {
      const answer = await real(password, stored);
      if (!held) {
        held = true;
        verified(answer);
        await gate;
      }
      return answer;
    });
    return {
      reached,
      release,
      end: () => {
        release();
        spy.mockRestore();
      },
    };
  }

  const factsOf = (row: Record<string, any>) => (typeof row.new_row === 'string' ? JSON.parse(row.new_row) : row.new_row) as Record<string, any>;
  const loginEventsSince = async (userId: string, after: number) => (await auditSince(after)).filter((r) => r.action === 'event' && r.table_name === 'users' && r.row_id === userId && factsOf(r).event === 'login');
  const otherSessions = async (u: { userId: string; sessionId: string }) => (await sessionsOf(u.userId)).filter((s) => s.id !== u.sessionId);

  /**
   * Starts a login with the RIGHT password and waits until its verification is held with the answer "right"; the login's own answer is `pending`. (It is returned inside an object: an async
   * function that returned the promise itself would not be done until the login was, and the test would go on before the hold.)
   */
  async function heldLogin(email: string, hold: ReturnType<typeof holdFirstVerification>) {
    const pending = loginWith(email, PASSWORD);
    const first = await Promise.race([hold.reached, pending.then(() => 'the login ended before its password was verified')]);
    expect(first).toBe(true);
    return { pending };
  }

  it('control: nothing changes while the verification is held, and the login goes through (so the tests below are refused for the change, not for the hold)', async () => {
    const u = await makeUser('biller');
    const before = await maxAuditId();
    const hold = holdFirstVerification();
    try {
      const { pending } = await heldLogin(u.email, hold);
      await sleep(50);
      hold.release();
      const res = await pending;
      expect(res.statusCode).toBe(200);
      expect(await otherSessions(u)).toHaveLength(1);
      expect(await loginEventsSince(u.userId, before)).toHaveLength(1);
    } finally {
      hold.end();
    }
  });

  it('the password is changed from another browser while the old one is being verified: the held login is the plain bad login (401), with no cookie, no session and no login event; the new password works and the old one does not', async () => {
    const u = await makeUser('biller');
    const before = await maxAuditId();
    const newPassword = secret('Pw');
    const hold = holdFirstVerification();
    try {
      const { pending } = await heldLogin(u.email, hold);
      const changed = await inject('POST', '/v1/auth/change-password', { cookie: u.cookie, payload: { current_password: PASSWORD, new_password: newPassword } });
      expect(changed.statusCode, changed.body).toBe(200);
      hold.release();
      const res = await pending;
      expect(res.statusCode).toBe(401);
      expect(errorOf(res)).toEqual({ code: 'JV_BAD_LOGIN', message: 'Wrong email or password.', details: {} });
      expect(setCookies(res)).toEqual([]);
    } finally {
      hold.end();
    }
    expect(await otherSessions(u)).toEqual([]);
    expect(await loginEventsSince(u.userId, before)).toEqual([]);
    expect((await loginWith(u.email, newPassword)).statusCode).toBe(200);
    expect((await loginWith(u.email, PASSWORD)).statusCode).toBe(401);
  });

  it('the stored hash is replaced by an UPDATE (as a reset does) while the old password is being verified: refused the same way', async () => {
    const u = await makeUser('staff');
    const before = await maxAuditId();
    const hold = holdFirstVerification();
    try {
      const { pending } = await heldLogin(u.email, hold);
      await world.sql.query('UPDATE users SET password_hash = ? WHERE id = ?', [await passwords.hash(secret('Pw')), u.userId]);
      hold.release();
      const res = await pending;
      expect(res.statusCode).toBe(401);
      expect(errorOf(res).code).toBe('JV_BAD_LOGIN');
      expect(setCookies(res)).toEqual([]);
    } finally {
      hold.end();
    }
    expect(await otherSessions(u)).toEqual([]);
    expect(await loginEventsSince(u.userId, before)).toEqual([]);
  });

  it('the user is deactivated while the right password is being verified: 403 JV_FORBIDDEN "inactive", no cookie, no session, no login event', async () => {
    const u = await makeUser('biller');
    const before = await maxAuditId();
    const hold = holdFirstVerification();
    try {
      const { pending } = await heldLogin(u.email, hold);
      await world.sql.query('UPDATE users SET active = 0 WHERE id = ?', [u.userId]);
      hold.release();
      const res = await pending;
      expect(res.statusCode).toBe(403);
      expect(errorOf(res)).toMatchObject({ code: 'JV_FORBIDDEN', details: { reason: 'inactive' } });
      expect(setCookies(res)).toEqual([]);
    } finally {
      hold.end();
    }
    expect(await otherSessions(u)).toEqual([]);
    expect(await loginEventsSince(u.userId, before)).toEqual([]);
  });
});

// ------------------------------------------------------------------------------------------------ me, activity, logout, change-password

describe('T-D25 me, logout and activity', () => {
  it('me returns the user, the role as the database has it, the limits and pricing_sha256 (the SHA-256 of src/domain/pricing.ts, API18)', async () => {
    const u = await signIn('owner');
    const res = await inject('GET', '/v1/auth/me', { cookie: u.cookie });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      user: { id: u.userId, email: u.email, full_name: expect.any(String), role: 'owner', must_change_password: false },
      pricing_sha256: createHash('sha256').update(readFileSync(new URL('../../src/domain/pricing.ts', import.meta.url))).digest('hex'),
      idle_timeout_s: limits.sessionIdleMs / 1000,
      absolute_expires_at: u.res.json().absolute_expires_at,
    });
  });

  it('logout ends the session (the row stays, with revoked_at), clears the cookie with the same attributes, and the next call is 401', async () => {
    const u = await signIn('biller');
    const res = await inject('POST', '/v1/auth/logout', { cookie: u.cookie });
    expect(res.statusCode).toBe(200);
    const c = parseSetCookie(setCookies(res)[0]);
    expect(c.name).toBe(SESSION_COOKIE);
    expect(c.value).toBe('');
    expect(c.attrs['max-age']).toBe('0');
    expect(c.attrs.path).toBe('/');
    expect(c.flags).toEqual(expect.arrayContaining(['httponly', 'secure']));
    expect(c.attrs.samesite).toBe('Strict');
    const row = (await sessionsOf(u.userId)).find((s) => s.token_hash.toLowerCase() === createHash('sha256').update(u.ticket).digest('hex'))!;
    expect(row.revoked_at).not.toBeNull();
    const next = await inject('GET', '/v1/auth/me', { cookie: u.cookie });
    expect(next.statusCode).toBe(401);
    expect(errorOf(next).code).toBe('JV_UNAUTHENTICATED');
    expect((await inject('POST', '/v1/auth/logout', { cookie: u.cookie })).statusCode).toBe(401); // a second logout has no session to end
  });

  it('activity answers 200 and takes no body', async () => {
    const u = await signIn('biller');
    expect((await inject('POST', '/v1/auth/activity', { cookie: u.cookie })).statusCode).toBe(200);
    expect((await inject('POST', '/v1/auth/activity', { cookie: u.cookie, payload: {} })).statusCode).toBe(200);
    const res = await inject('POST', '/v1/auth/activity', { cookie: u.cookie, payload: { role: 'owner' } });
    expect(res.statusCode).toBe(422);
  });
});

describe('T-D25 change-password (U9, U11): verifies the current password, the rules, ends the other sessions, clears the flag', () => {
  const change = (cookie: string, current: string, next: string) => inject('POST', '/v1/auth/change-password', { cookie, payload: { current_password: current, new_password: next } });

  it('a wrong current password is 422 JV_INVALID_INPUT on current_password (not a 401, which would log the person out), and nothing changes', async () => {
    const u = await signIn('biller');
    const other = await makeUser('biller');
    const before = await userRow(u.userId);
    const res = await change(u.cookie, secret('Wrong'), secret('Np'));
    expect(res.statusCode).toBe(422);
    expect(errorOf(res)).toMatchObject({ code: 'JV_INVALID_INPUT', details: { field: 'current_password' } });
    expect((await userRow(u.userId)).password_hash).toBe(before.password_hash);
    expect((await sessionsOf(u.userId)).every((s) => s.revoked_at === null)).toBe(true);
    expect((await sessionsOf(other.userId)).every((s) => s.revoked_at === null)).toBe(true);
  });

  it('the rules of U9 are checked on the new password: 9 and 129 characters, a very common password, the local part of the e-mail, the same as the current one', async () => {
    const u = await signIn('biller');
    const local = u.email.split('@')[0];
    const cases: [string, string][] = [
      ['9 characters', randomBytes(9).toString('base64url').slice(0, 9)],
      ['129 characters', 'a1'.repeat(64) + 'z'],
      ['the local part of the e-mail', `${randomBytes(4).toString('hex')}${local.toUpperCase()}${randomBytes(4).toString('hex')}`],
      ['the current password', PASSWORD],
    ];
    for (const [name, next] of cases) {
      const res = await change(u.cookie, PASSWORD, next);
      expect(res.statusCode, name).toBe(422);
      expect(errorOf(res), name).toMatchObject({ code: 'JV_INVALID_INPUT', details: { field: 'new_password' } });
      expect(res.body, name).not.toContain(next);
    }
    expect((await userRow(u.userId)).password_hash).toBe(HASH);
  });

  it('a very common password is refused through the route too', async () => {
    const { COMMON_PASSWORDS } = await import('../../src/auth/password');
    const u = await signIn('biller');
    const res = await change(u.cookie, PASSWORD, [...COMMON_PASSWORDS][0]);
    expect(res.statusCode).toBe(422);
    expect(errorOf(res).details).toMatchObject({ field: 'new_password' });
  });

  it('it stores the new hash, ends the user\'s OTHER sessions (rows stay), keeps this one, and the old password no longer logs in while the new one does', async () => {
    const u = await signIn('biller'); // u.sessionId is the fixture session of "another browser"
    const elsewhere = await loginWith(u.email, PASSWORD); // a third browser
    const elsewhereCookie = `${SESSION_COOKIE}=${parseSetCookie(setCookies(elsewhere)[0]).value}`;
    const bystander = await signIn('biller'); // another user: untouched
    const next = secret('Np');
    const res = await change(u.cookie, PASSWORD, next);
    expect(res.statusCode).toBe(200);
    expect(res.json().user).toMatchObject({ id: u.userId, must_change_password: false });
    const row = await userRow(u.userId);
    expect(row.password_hash).not.toBe(HASH);
    expect(row.password_hash).toMatch(/^\$(argon2id|scrypt)\$/);
    expect(row.password_hash).not.toContain(next);
    expect(await passwords.verify(next, row.password_hash)).toBe(true);
    // the other sessions of this user are over, this one lives, the bystander's lives
    expect((await inject('GET', '/v1/auth/me', { cookie: u.cookie })).statusCode).toBe(200);
    const gone = await inject('GET', '/v1/auth/me', { cookie: elsewhereCookie });
    expect(gone.statusCode).toBe(401);
    expect(errorOf(gone).code).toBe('JV_UNAUTHENTICATED');
    const fixture = (await sessionsOf(u.userId)).find((s) => s.id === u.sessionId)!;
    expect(fixture.revoked_at).not.toBeNull();
    expect((await sessionsOf(u.userId)).length).toBe(3); // nothing is deleted
    expect((await inject('GET', '/v1/auth/me', { cookie: bystander.cookie })).statusCode).toBe(200);
    expect((await loginWith(u.email, PASSWORD)).statusCode).toBe(401);
    expect((await loginWith(u.email, next)).statusCode).toBe(200);
  });

  it('U11: a user who must change the password can call only change-password, logout and me; the change clears the flag and opens the rest', async () => {
    const u = await signIn('staff', { mustChange: true });
    expect((await inject('GET', '/v1/auth/me', { cookie: u.cookie })).statusCode).toBe(200);
    for (const [method, url] of [['POST', '/v1/auth/activity'], ['POST', '/v1/designs'], ['GET', '/v1/sync/users']] as const) {
      const res = await inject(method, url, { cookie: u.cookie, payload: method === 'POST' ? {} : undefined });
      expect(res.statusCode, url).toBe(403);
      expect(errorOf(res).code, url).toBe('JV_PASSWORD_CHANGE_REQUIRED');
    }
    const res = await change(u.cookie, PASSWORD, secret('Np'));
    expect(res.statusCode).toBe(200);
    expect(res.json().user.must_change_password).toBe(false);
    expect(Number((await userRow(u.userId)).must_change_password)).toBe(0);
    expect((await inject('POST', '/v1/auth/activity', { cookie: u.cookie })).statusCode).toBe(200);
    expect((await inject('GET', '/v1/sync/users', { cookie: u.cookie })).statusCode).toBe(200);
  });
});

// ------------------------------------------------------------------------------------------------ T-D14 clause

describe('T-D14 clause: a login, a logout and a change-password each write exactly one `event` audit row, with no secret in it', () => {
  const NO_SECRETS = (rows: unknown, secrets: string[]) => {
    const text = JSON.stringify(rows);
    for (const s of secrets) expect(text).not.toContain(s);
    expect(text).not.toMatch(/password_hash|new_password|current_password|"password"|ticket|token_hash|set-cookie|"cookie"|authorization/i);
  };

  it('login: one event row, actor and role of the user, the request id, facts without secrets', async () => {
    const u = await makeUser('biller');
    const before = await maxAuditId();
    const res = await loginWith(u.email, PASSWORD);
    expect(res.statusCode).toBe(200);
    const ticket = parseSetCookie(setCookies(res)[0]).value;
    const rows = await auditSince(before);
    expect(rows).toHaveLength(1); // a login changes no row of users: the trigger writes nothing else
    const e = rows[0];
    expect(e).toMatchObject({ action: 'event', table_name: 'users', row_id: u.userId, actor: u.userId, actor_role: 'biller', old_row: null });
    expect(e.request_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    const facts = typeof e.new_row === 'string' ? JSON.parse(e.new_row) : e.new_row;
    const session = (await sessionsOf(u.userId)).find((s) => s.id !== u.sessionId)!;
    expect(facts).toMatchObject({ event: 'login', session_id: session.id });
    NO_SECRETS(rows, [PASSWORD, ticket, HASH, session.token_hash, session.token_hash.toLowerCase()]);
  });

  it('logout: one event row; the session id in the facts, nothing secret', async () => {
    const u = await signIn('staff');
    const before = await maxAuditId();
    expect((await inject('POST', '/v1/auth/logout', { cookie: u.cookie })).statusCode).toBe(200);
    const rows = await auditSince(before);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: 'event', table_name: 'users', row_id: u.userId, actor: u.userId, actor_role: 'staff' });
    const facts = typeof rows[0].new_row === 'string' ? JSON.parse(rows[0].new_row) : rows[0].new_row;
    expect(facts).toMatchObject({ event: 'logout' });
    NO_SECRETS(rows, [PASSWORD, u.ticket, HASH]);
  });

  it('change-password: one event row (a user who did not have to change it: nothing else is written); the new password and both hashes are nowhere in it', async () => {
    const u = await signIn('owner');
    const next = secret('Np');
    const before = await maxAuditId();
    const res = await inject('POST', '/v1/auth/change-password', { cookie: u.cookie, payload: { current_password: PASSWORD, new_password: next } });
    expect(res.statusCode).toBe(200);
    const newHash = (await userRow(u.userId)).password_hash as string;
    const rows = await auditSince(before);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: 'event', table_name: 'users', row_id: u.userId, actor: u.userId, actor_role: 'owner' });
    const facts = typeof rows[0].new_row === 'string' ? JSON.parse(rows[0].new_row) : rows[0].new_row;
    expect(facts).toMatchObject({ event: 'change_password' });
    expect(Number(facts.other_sessions_ended)).toBeGreaterThanOrEqual(1);
    NO_SECRETS(rows, [PASSWORD, next, HASH, newHash, u.ticket]);
  });

  it('change-password of a user who had to change it: the event row, and the trigger\'s own row for the flag, which names the same actor and holds no hash (L1)', async () => {
    const u = await signIn('staff', { mustChange: true });
    const next = secret('Np');
    const before = await maxAuditId();
    expect((await inject('POST', '/v1/auth/change-password', { cookie: u.cookie, payload: { current_password: PASSWORD, new_password: next } })).statusCode).toBe(200);
    const rows = await auditSince(before);
    expect(rows.filter((r) => r.action === 'event')).toHaveLength(1);
    const update = rows.filter((r) => r.action === 'update');
    expect(update).toHaveLength(1);
    expect(update[0]).toMatchObject({ table_name: 'users', row_id: u.userId, actor: u.userId, actor_role: 'staff' });
    expect(rows).toHaveLength(2);
    NO_SECRETS(rows, [PASSWORD, next, HASH, (await userRow(u.userId)).password_hash as string, u.ticket]);
  });

  it('a refused login, a wrong current password and a refused rule write no event row (failed logins are the hourly summary of API08)', async () => {
    const u = await signIn('biller');
    const before = await maxAuditId();
    await loginWith(u.email, secret('Wrong'));
    await loginWith(`nobody-${randomUUID().slice(0, 8)}@example.test`, secret('Wrong'));
    await inject('POST', '/v1/auth/change-password', { cookie: u.cookie, payload: { current_password: secret('Wrong'), new_password: secret('Np') } });
    await inject('POST', '/v1/auth/change-password', { cookie: u.cookie, payload: { current_password: PASSWORD, new_password: 'short' } });
    expect(await auditSince(before)).toEqual([]);
  });
});

// ------------------------------------------------------------------------------------------------ T-D06 and T-D15

describe('T-D06 (HTTP half) a user cannot change their own role or active; no route could', () => {
  it('no route updates users: none in the route table, and no row of the matrix is an edit of users', () => {
    const writing = world.app.routeTable.filter((r) => r.kind !== 'token' && r.method !== 'GET' && /\/users\b/.test(r.url)); // the admin door (a token route) is the only way (A8)
    expect(writing).toEqual([]);
    for (const [action, row] of Object.entries(MATRIX)) {
      if ('edit' in row && row.edit) expect(row.edit.table, action).not.toBe('users');
    }
  });

  it('PATCH, PUT and POST on /v1/users/:id with a role or active in the body are 404 for the owner, the biller and the staff, and the row does not change', async () => {
    for (const role of ['owner', 'biller', 'staff'] as const) {
      const u = await signIn(role);
      const before = await userRow(u.userId);
      for (const method of ['PATCH', 'PUT', 'POST'] as const) {
        for (const body of [{ role: 'owner' }, { active: false }, { role: 'owner', active: true }]) {
          const res = await inject(method, `/v1/users/${u.userId}`, { cookie: u.cookie, payload: body });
          expect(res.statusCode, `${role} ${method}`).toBe(404);
          expect(errorOf(res).code).toBe('JV_NOT_FOUND');
        }
      }
      const after = await userRow(u.userId);
      expect(after.role).toBe(before.role);
      expect(Number(after.active)).toBe(Number(before.active));
    }
  });

  it('a body that names a role or active on the session calls is refused (unknown key), and nothing changes', async () => {
    const u = await signIn('biller');
    const sent: [string, string, object][] = [
      ['POST', '/v1/auth/activity', { role: 'owner' }],
      ['POST', '/v1/auth/logout', { active: true }],
      ['POST', '/v1/auth/change-password', { current_password: PASSWORD, new_password: secret('Np'), role: 'owner' }],
    ];
    for (const [method, url, payload] of sent) {
      const res = await inject(method as 'GET', url, { cookie: u.cookie, payload });
      expect(res.statusCode, url).toBe(422);
    }
    const row = await userRow(u.userId);
    expect(row.role).toBe('biller');
    expect((await inject('GET', '/v1/auth/me', { cookie: u.cookie })).json().user.role).toBe('biller');
  });

  it('a user deactivated in the middle of a shift gets 401 at the next call, an open session included; reactivated, the session works again (nothing was lost on the way)', async () => {
    const u = await signIn('owner');
    expect((await inject('GET', '/v1/auth/me', { cookie: u.cookie })).statusCode).toBe(200);
    await world.sql.query('UPDATE users SET active = 0 WHERE id = ?', [u.userId]);
    const res = await inject('GET', '/v1/auth/me', { cookie: u.cookie });
    expect(res.statusCode).toBe(401);
    expect(errorOf(res).code).toBe('JV_UNAUTHENTICATED');
    // a call that would write is cut off as well, and the handler never runs
    const handled = world.handled.length;
    expect((await inject('POST', '/v1/bills', { cookie: u.cookie, payload: {} })).statusCode).toBe(401);
    expect(world.handled.length).toBe(handled);
    // and the correct password gets "not active" at the door
    expect((await loginWith(u.email, PASSWORD)).statusCode).toBe(403);
    await world.sql.query('UPDATE users SET active = 1 WHERE id = ?', [u.userId]);
    expect((await inject('GET', '/v1/auth/me', { cookie: u.cookie })).statusCode).toBe(200);
  });
});

describe('T-D15 the role is read from users on every request; nothing the caller sends names it', () => {
  it('a changed role takes effect at the next call, with the same cookie, up and down', async () => {
    const u = await signIn('biller');
    const callVoid = () => inject('POST', concreteUrl('/v1/receipts/:id/void'), { cookie: u.cookie, payload: {} });
    expect((await inject('GET', '/v1/auth/me', { cookie: u.cookie })).json().user.role).toBe('biller');
    const refused = await callVoid();
    expect(refused.statusCode).toBe(403);
    expect(errorOf(refused).code).toBe('JV_FORBIDDEN');
    await world.sql.query("UPDATE users SET role = 'owner' WHERE id = ?", [u.userId]);
    expect((await inject('GET', '/v1/auth/me', { cookie: u.cookie })).json().user.role).toBe('owner');
    const before = world.handled.length;
    expect((await callVoid()).statusCode).toBe(200);
    expect(world.handled.slice(before)).toEqual(['fn:void_receipt']);
    await world.sql.query("UPDATE users SET role = 'staff' WHERE id = ?", [u.userId]);
    expect((await inject('GET', '/v1/auth/me', { cookie: u.cookie })).json().user.role).toBe('staff');
    expect((await callVoid()).statusCode).toBe(403);
  });

  it('a role in a header, in a second cookie, in the query or in the body has no effect', async () => {
    const u = await signIn('biller');
    const url = concreteUrl('/v1/receipts/:id/void');
    const handled = world.handled.length;
    const tries: { headers?: Record<string, string>; cookie?: string; url?: string; payload?: object }[] = [
      { headers: { 'x-role': 'owner', 'x-user-role': 'owner', 'x-jv-role': 'owner', role: 'owner' } },
      { headers: { authorization: 'Bearer owner', 'x-forwarded-user': 'owner' } },
      { cookie: `${u.cookie}; role=owner; jv_role=owner; user_role=owner; __Host-jv_role=owner` },
      { cookie: `role=owner; ${u.cookie}` },
      { url: `${url}?role=owner&as=owner` },
      { payload: { role: 'owner', actor_role: 'owner' } },
    ];
    for (const t of tries) {
      const res = await inject('POST', t.url ?? url, { cookie: t.cookie ?? u.cookie, headers: t.headers, payload: t.payload ?? {} });
      expect(res.statusCode, JSON.stringify(t)).toBe(403);
      expect(errorOf(res).code).toBe('JV_FORBIDDEN');
    }
    const me = await inject('GET', '/v1/auth/me', { cookie: `${u.cookie}; role=owner`, headers: { 'x-role': 'owner' } });
    expect(me.json().user.role).toBe('biller');
    expect(world.handled.length).toBe(handled); // the owner-only handler never ran
  });

  it('the cookie holds only an opaque ticket: random, the same shape for every role, nothing of the user or the role in it', async () => {
    const tickets: string[] = [];
    for (const role of ['owner', 'biller', 'staff'] as const) {
      const u = await signIn(role);
      expect(u.ticket).toMatch(/^[A-Za-z0-9_-]{43}$/);
      const decoded = Buffer.from(u.ticket, 'base64url').toString('latin1').toLowerCase();
      for (const word of [role, u.userId, u.email.split('@')[0]]) expect(decoded).not.toContain(word);
      tickets.push(u.ticket);
    }
    expect(new Set(tickets).size).toBe(3);
    // a cookie that is not a ticket (a role, a JSON object, a JWT-looking value) is no session
    for (const bad of ['owner', '{"role":"owner"}', 'eyJhbGciOiJub25lIn0.eyJyb2xlIjoib3duZXIifQ.', `${tickets[0]}x`, tickets[0].slice(1)]) {
      const res = await inject('GET', '/v1/auth/me', { cookie: `${SESSION_COOKIE}=${bad}` });
      expect(res.statusCode, bad).toBe(401);
    }
  });
});

// ------------------------------------------------------------------------------------------------ T-D26: the second world, with a clock the test moves

describe('T-D26 sessions: 12 hours idle, 14 days absolute, polling does not extend, activity and every other call do; a deactivation, a password change and a logout end the session at once', () => {
  const time = { micros: T0 };
  const advance = (ms: number) => {
    time.micros += BigInt(ms) * 1000n;
  };
  let w: World;

  beforeAll(async () => {
    w = await makeWorld({
      label: 'sess',
      routes: false, // the toy below stands behind a row of the matrix (fn:record_payment, which API22 built for real), so the application's own routes are registered one group at a time
      clock: createClock(() => time.micros),
      build: (app, state) => {
        registerAuthRoutes(app);
        registerSyncRoutes(app);
        // a toy money call: it opens its own transaction after the wrapper has done the session's work
        route(app, {
          action: 'fn:record_payment',
          handler: async ({ app: a, request, auth }) => withTx(txContextFor(a.db!, request, { id: auth.user.id, role: auth.user.role }), async (tx) => (await tx.rows('SELECT 1 AS one'))[0]),
        });
        registerStubs(app, state.handled);
      },
    });
  }, 120_000);
  afterAll(async () => {
    await w?.close();
  });

  const me = (cookie: string) => inject('GET', '/v1/auth/me', { cookie, app: w.app });
  const activity = (cookie: string) => inject('POST', '/v1/auth/activity', { cookie, app: w.app });
  // a poll: the paths under /v1/sync/ never move last_seen_at (U4), so it is the probe that shows a session is still alive without extending it
  const probe = (cookie: string) => inject('GET', '/v1/sync/customers', { cookie, app: w.app });
  const login = async (role: 'owner' | 'biller' | 'staff' = 'owner') => signIn(role, {}, w);
  const expectEnded = (res: LightMyRequestResponse, code: 'JV_SESSION_EXPIRED' | 'JV_UNAUTHENTICATED') => {
    expect(res.statusCode).toBe(401);
    expect(errorOf(res).code).toBe(code);
  };

  it('idle: after 12 hours with no activity the session is over (401 JV_SESSION_EXPIRED); a poll at 11 h 59 m works and does NOT extend it', async () => {
    const u = await login();
    advance(12 * HOUR - 60_000);
    expect((await probe(u.cookie)).statusCode).toBe(200);
    advance(2 * 60_000); // 12 h 01 m after the login: the poll did not move the clock of the session
    expectEnded(await probe(u.cookie), 'JV_SESSION_EXPIRED');
  });

  it('idle, the border: just inside 12 hours is alive and just past it is over', async () => {
    const u = await login();
    advance(12 * HOUR - 1000);
    expect((await probe(u.cookie)).statusCode).toBe(200);
    advance(2000);
    expectEnded(await probe(u.cookie), 'JV_SESSION_EXPIRED');
  });

  it('activity extends it: 11 h after the login an activity call restarts the 12 hours', async () => {
    const u = await login();
    advance(11 * HOUR);
    expect((await activity(u.cookie)).statusCode).toBe(200);
    advance(12 * HOUR - 60_000); // 23 h 59 m after the login, 11 h 59 m after the activity
    expect((await probe(u.cookie)).statusCode).toBe(200);
    advance(2 * 60_000);
    expectEnded(await probe(u.cookie), 'JV_SESSION_EXPIRED');
  });

  it('polling does not extend it: GET /v1/sync/* and POST /v1/sync/poll never move last_seen_at (API11\'s read routes stand behind them now; the full clause, on data, is tests/api/sync-session.test.ts)', async () => {
    const u = await login('owner');
    const rowBefore = (await sessionsOf(u.userId, w)).find((s) => s.id !== u.sessionId)!;
    advance(6 * HOUR);
    for (const [method, url] of [['GET', '/v1/sync/customers'], ['GET', '/v1/sync/settings'], ['POST', '/v1/sync/poll']] as const) {
      expect((await inject(method, url, { cookie: u.cookie, payload: method === 'POST' ? { cursors: {} } : undefined, app: w.app })).statusCode, url).toBe(200);
    }
    const rowAfter = (await sessionsOf(u.userId, w)).find((s) => s.id !== u.sessionId)!;
    expect(rowAfter.last_seen_at).toBe(rowBefore.last_seen_at);
    advance(6 * HOUR + 60_000); // 12 h 01 m since the login, 6 h 01 m since the last poll
    expectEnded(await me(u.cookie), 'JV_SESSION_EXPIRED');
  });

  it('me is not a poll: it restarts the 12 hours like every other call (U4)', async () => {
    const u = await login();
    advance(11 * HOUR);
    expect((await me(u.cookie)).statusCode).toBe(200);
    advance(12 * HOUR - 60_000);
    expect((await probe(u.cookie)).statusCode).toBe(200);
    advance(2 * 60_000);
    expectEnded(await probe(u.cookie), 'JV_SESSION_EXPIRED');
  });

  it('every other call does: a read of the audit log (not a poll) restarts the 12 hours (U4: "every other call does")', async () => {
    const u = await login('owner');
    advance(6 * HOUR);
    expect((await inject('GET', '/v1/audit-log', { cookie: u.cookie, app: w.app })).statusCode).toBe(200);
    advance(11 * HOUR); // 17 h since the login, 11 h since the call
    expect((await me(u.cookie)).statusCode).toBe(200);
  });

  it('a call that is refused (403) does not extend it: only a call that gets through does', async () => {
    const u = await login('staff');
    advance(6 * HOUR);
    expect((await inject('GET', '/v1/audit-log', { cookie: u.cookie, app: w.app })).statusCode).toBe(403);
    advance(6 * HOUR + 60_000);
    expectEnded(await me(u.cookie), 'JV_SESSION_EXPIRED');
  });

  it('absolute: 14 days after the login the session is over even if the person was active a moment ago (401 JV_SESSION_EXPIRED)', async () => {
    const u = await login();
    const started = time.micros;
    for (let i = 0; i < 30; i++) {
      advance(11 * HOUR);
      expect((await activity(u.cookie)).statusCode, `step ${i}`).toBe(200);
    }
    // 13 days 18 hours in, active just now
    time.micros = started + BigInt(limits.sessionAbsoluteMs) * 1000n - 1_000_000n; // one second before the 14 days
    expect((await me(u.cookie)).statusCode).toBe(200);
    time.micros = started + BigInt(limits.sessionAbsoluteMs) * 1000n + 1_000_000n; // one second after
    expectEnded(await me(u.cookie), 'JV_SESSION_EXPIRED');
    expectEnded(await activity(u.cookie), 'JV_SESSION_EXPIRED'); // activity does not bring it back
    expect(u.res.json().absolute_expires_at).toMatch(/Z$/);
    // log in again: a new session
    time.micros += 1_000_000n;
    const again = await loginWith(u.email, PASSWORD, { app: w.app });
    expect(again.statusCode).toBe(200);
  }, 120_000);

  it('an expired session is marked ended (revoked_at), the row stays, and the cookie keeps answering "expired" (no loop between two answers)', async () => {
    const u = await login();
    const rows = await countOf('sessions', w);
    advance(13 * HOUR);
    expectEnded(await me(u.cookie), 'JV_SESSION_EXPIRED');
    const row = (await sessionsOf(u.userId, w)).find((s) => s.id !== u.sessionId)!;
    expect(row.revoked_at).not.toBeNull();
    expect(await countOf('sessions', w)).toBe(rows);
    expectEnded(await me(u.cookie), 'JV_SESSION_EXPIRED');
    expectEnded(await activity(u.cookie), 'JV_SESSION_EXPIRED');
  });

  it('a deactivation ends the session at once: the next call is a 401; the session row is untouched', async () => {
    const u = await login();
    expect((await me(u.cookie)).statusCode).toBe(200);
    await w.sql.query('UPDATE users SET active = 0 WHERE id = ?', [u.userId]);
    expectEnded(await me(u.cookie), 'JV_UNAUTHENTICATED');
    expectEnded(await activity(u.cookie), 'JV_UNAUTHENTICATED');
    expect((await sessionsOf(u.userId, w)).find((s) => s.id !== u.sessionId)!.revoked_at).toBeNull();
  });

  it('a logout ends the session at once', async () => {
    const u = await login();
    expect((await inject('POST', '/v1/auth/logout', { cookie: u.cookie, app: w.app })).statusCode).toBe(200);
    expectEnded(await me(u.cookie), 'JV_UNAUTHENTICATED');
  });

  it('a password change ends the user\'s other sessions at once (the next call there is a 401) and keeps the one it was made from', async () => {
    const u = await login('biller');
    const other = await loginWith(u.email, PASSWORD, { app: w.app });
    const otherCookie = `${SESSION_COOKIE}=${parseSetCookie(setCookies(other)[0]).value}`;
    expect((await me(otherCookie)).statusCode).toBe(200);
    const res = await inject('POST', '/v1/auth/change-password', { cookie: u.cookie, payload: { current_password: PASSWORD, new_password: secret('Np') }, app: w.app });
    expect(res.statusCode).toBe(200);
    expectEnded(await me(otherCookie), 'JV_UNAUTHENTICATED');
    expect((await me(u.cookie)).statusCode).toBe(200);
  });

  it('the write of last_seen_at is its own statement in autocommit, made before the handler\'s transaction, never inside one', async () => {
    const u = await login('biller');
    advance(60_000);
    const from = w.spy.sent.length;
    const res = await inject('POST', concreteUrl('/v1/customers/:id/payments'), { cookie: u.cookie, payload: {}, app: w.app });
    expect(res.statusCode).toBe(200);
    const sent = w.spy.sent.slice(from);
    const touch = sent.findIndex((s) => /^UPDATE sessions SET last_seen_at/i.test(s.sql));
    const start = sent.findIndex((s) => /^START TRANSACTION$/i.test(s.sql));
    expect(touch).toBeGreaterThanOrEqual(0);
    expect(start).toBeGreaterThan(touch); // before the claim of any money call
    // not inside a transaction: nothing was opened on that connection before the statement
    const threadBefore = sent.slice(0, touch).filter((s) => s.thread === sent[touch].thread);
    const open = threadBefore.reduce((depth, s) => (/^START TRANSACTION$/i.test(s.sql) ? depth + 1 : /^(COMMIT|ROLLBACK)$/i.test(s.sql) ? depth - 1 : depth), 0);
    expect(open).toBe(0);
    // and it is the only statement on that checkout that writes
    expect(sent.filter((s) => /^UPDATE sessions/i.test(s.sql))).toHaveLength(1);
    // the statement moved the column (the session's last_seen_at is the clock's now, not the database's)
    const row = (await sessionsOf(u.userId, w)).find((s) => s.id !== u.sessionId)!;
    expect(microsOfDbTimestamp(row.last_seen_at)).toBeGreaterThanOrEqual(time.micros);
  });

  it('the polls send no write for the session at all; me, like every other call, sends one', async () => {
    const u = await login('owner');
    const from = w.spy.sent.length;
    await inject('GET', '/v1/sync/customers', { cookie: u.cookie, app: w.app });
    await inject('POST', '/v1/sync/poll', { cookie: u.cookie, payload: { cursors: {} }, app: w.app });
    expect(w.spy.sent.slice(from).filter((x) => /^(UPDATE|INSERT)/i.test(x.sql))).toEqual([]);
    const fromMe = w.spy.sent.length;
    await me(u.cookie);
    expect(w.spy.sent.slice(fromMe).filter((x) => /^UPDATE sessions\b/i.test(x.sql))).toHaveLength(1);
  });

  it('control: the same walk with the clock never moving keeps the session (the tests above end it only because time moved)', async () => {
    const u = await login();
    for (let i = 0; i < 5; i++) expect((await me(u.cookie)).statusCode).toBe(200);
  });
});
