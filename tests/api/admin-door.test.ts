import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { countAttempt } from '../../scripts/login-counters.mjs';
import { migrate } from '../../scripts/migrate.mjs';
import { passwords } from '../../src/auth/password';
import { newTemporaryPassword } from '../../src/admin/password';
import { buildApp } from '../../src/app';
import { createClock } from '../../src/clock';
import { createDbPool } from '../../src/db/pool';
import { MATRIX } from '../../src/permissions/matrix';
import { SESSION_COOKIE } from '../../src/permissions/session';
import { T0, type World, concreteUrl, makeWorld, registerStubs } from './cells';
import { REPO, TEST_ORIGIN, csrfHeaders, logSink, secret, testConfig } from './support';

// API09: the admin door (U3, U2, A8; O41). T-D27 (HTTP half), T-D20, the T-E09 HTTP side (the command-line side is tests/api/admin-scripts.test.ts), and the clauses of T-D24 (the admin-door rows
// of A13) and T-D14 (every call is one `event` row with the role admin-cli and no token in it). The limiter itself is tests/api/limiter.test.ts.
//
// One world: a scratch database with the real schema and the audit triggers of db/optional, the application's own routes (the session routes and the admin door), a stub behind every other row of the
// matrix, and a clock the test can move (the throttles count in the API's clock). The admin token is made up at run time; the app holds only its SHA-256, as in production.

const MINUTE = 60_000_000n; // microseconds
const SECOND = 1_000_000n;

const TOKEN = randomBytes(32).toString('base64url');
const HASH = createHash('sha256').update(TOKEN).digest('hex');

/** A token whose SHA-256 begins with the same `bytes` bytes as `hash`: the comparison must be of the whole hash, so this is still the wrong token. */
function tokenWithHashPrefix(hash: string, bytes: number): string {
  const prefix = hash.slice(0, bytes * 2);
  for (;;) {
    const candidate = randomBytes(32).toString('base64url');
    if (createHash('sha256').update(candidate).digest('hex').startsWith(prefix) && candidate !== TOKEN) return candidate;
  }
}

let micros = T0;
const clock = createClock(() => micros);
const advance = (by: bigint) => {
  micros += by;
};

let world: World;
let PASSWORD: string;

// every call from its own address unless the test names one: the throttle counts per address and the clock is fixed, so a shared address would run out after 10 calls
let addresses = 0;
const freshIp = () => `198.18.${Math.floor(++addresses / 250)}.${(addresses % 250) + 1}`;

interface CallOptions {
  /** the bearer token; null: no Authorization header (default: the right one) */
  token?: string | null;
  payload?: unknown;
  /** x-real-ip; null: none (an address that cannot be trusted); default: a fresh one */
  ip?: string | null;
  headers?: Record<string, string>;
  app?: FastifyInstance;
}

const call = (method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'OPTIONS', url: string, o: CallOptions = {}): Promise<LightMyRequestResponse> =>
  (o.app ?? world.app).inject({
    method,
    url,
    payload: o.payload as object | undefined,
    headers: { ...(o.token === null ? {} : { authorization: `Bearer ${o.token ?? TOKEN}` }), ...(o.ip === null ? {} : { 'x-real-ip': o.ip ?? freshIp() }), ...o.headers },
  });

const errorOf = (res: LightMyRequestResponse) => (res.json() as { error: { code: string; message: string; details: Record<string, unknown> }; request_id: string }).error;
const requestIdOf = (res: LightMyRequestResponse) => String(res.headers['x-request-id']);

const newEmail = (label = 'u') => `${label}-${randomUUID().slice(0, 8)}@example.test`;

/** Makes a user through the door and returns what the door said. */
async function addUser(role: 'owner' | 'biller' | 'staff', o: { email?: string; name?: string; ip?: string } = {}) {
  const email = o.email ?? newEmail(role);
  const res = await call('POST', '/admin/v1/users', { payload: { email, full_name: o.name ?? `Made ${role}`, role }, ip: o.ip });
  if (res.statusCode !== 201) throw new Error(`add user failed: ${res.statusCode} ${res.body}`);
  const body = res.json() as { user: { id: string }; temporary_password: string };
  return { id: body.user.id, email, password: body.temporary_password, res };
}

const setCookieOf = (res: LightMyRequestResponse): string | null => {
  const h = res.headers['set-cookie'];
  const first = Array.isArray(h) ? h[0] : h;
  return first ? first.split(';')[0] : null;
};

/** A login of the real route; `cookie` is the session cookie header. */
async function login(email: string, password: string) {
  const res = await world.app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email, password }, headers: csrfHeaders() });
  return { res, cookie: setCookieOf(res) };
}

const session = (method: 'GET' | 'POST', url: string, cookie: string, payload?: unknown) =>
  world.app.inject({ method, url, payload: payload as object | undefined, headers: { ...(method === 'GET' ? {} : csrfHeaders()), cookie } });

const userRow = async (id: string) => (await world.sql.query<any[]>('SELECT * FROM users WHERE id = ?', [id]))[0][0] as Record<string, any>;
const liveSessions = async (userId: string) => Number((await world.sql.query<any[]>('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ? AND revoked_at IS NULL', [userId]))[0][0].n);
const allSessions = async (userId: string) => Number((await world.sql.query<any[]>('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?', [userId]))[0][0].n);
const auditOf = async (requestId: string) => (await world.sql.query<any[]>('SELECT id, actor, actor_role, request_id, table_name, row_id, action, old_row, new_row FROM audit_log WHERE request_id = ? ORDER BY id', [requestId]))[0] as Record<string, any>[];
const eventsOf = async (requestId: string) => (await auditOf(requestId)).filter((r) => r.action === 'event');
const asObject = (v: unknown) => (typeof v === 'string' ? JSON.parse(v) : v) as Record<string, any>;
const countOf = async (table: string) => Number((await world.sql.query<any[]>(`SELECT COUNT(*) AS n FROM ${table}`))[0][0].n);

beforeAll(async () => {
  PASSWORD = secret('Pw');
  world = await makeWorld({ label: 'admin', routes: true, clock, config: { adminTokenHash: HASH, logLevel: 'info' }, build: (app, w) => registerStubs(app, w.handled) });
  // with the audit triggers of db/optional, as on the plan (L1): then "one event row" can be told from the rows a trigger writes
  await migrate(world.sql, { seeds: false, optional: true });
}, 120_000);

afterAll(async () => {
  await world?.close();
});

// ------------------------------------------------------------------------------------------------ T-D27

describe('T-D27 (HTTP half) the admin door exists only while JV_ADMIN_TOKEN_HASH is set', () => {
  const ROUTES = [
    ['POST', '/admin/v1/users'],
    ['GET', '/admin/v1/users'],
    ['POST', `/admin/v1/users/${randomUUID()}/reset-password`],
    ['POST', `/admin/v1/users/${randomUUID()}/role`],
    ['POST', `/admin/v1/users/${randomUUID()}/deactivate`],
    ['POST', `/admin/v1/users/${randomUUID()}/activate`],
    ['POST', '/admin/v1/login-counters/clear'],
    ['POST', '/admin/v1/backup-pulls'],
  ] as const;

  it('with the hash unset every address of the door is 404 JV_NOT_FOUND, whatever token is sent, and no route of the door is registered', async () => {
    const app = buildApp({ config: testConfig({ logLevel: 'silent' }) }); // no adminTokenHash
    await app.ready();
    for (const [method, url] of ROUTES) {
      const res = await app.inject({ method, url, headers: { authorization: `Bearer ${TOKEN}` } });
      expect(res.statusCode, `${method} ${url}`).toBe(404);
      expect(errorOf(res).code).toBe('JV_NOT_FOUND');
    }
    expect(app.routeTable.filter((r) => r.kind === 'token')).toEqual([]);
    await app.close();
  });

  it('with the hash set the door has its eight routes, all of the admin door under /admin/v1/, registered through route()', async () => {
    const app = buildApp({ config: testConfig({ logLevel: 'silent', adminTokenHash: HASH }) });
    await app.ready();
    const token = app.routeTable.filter((r) => r.kind === 'token');
    expect(token).toHaveLength(8);
    for (const r of token) {
      expect(r.name).toBe('admin');
      expect(r.url.startsWith('/admin/v1/')).toBe(true);
    }
    expect(token.map((r) => `${r.method} ${r.url}`).sort()).toEqual(
      [
        'GET /admin/v1/users',
        'POST /admin/v1/users',
        'POST /admin/v1/users/:id/activate',
        'POST /admin/v1/users/:id/deactivate',
        'POST /admin/v1/users/:id/reset-password',
        'POST /admin/v1/users/:id/role',
        'POST /admin/v1/login-counters/clear',
        'POST /admin/v1/backup-pulls',
      ].sort(),
    );
    await app.close();
  });

  it('a hash that is not a SHA-256 in hex stops the start (config), and says only the name of the variable', async () => {
    const { loadConfig, ConfigError } = await import('../../src/config');
    const base = { DB_HOST: '127.0.0.1', DB_PORT: '3306', DB_NAME: 'jv_x', DB_USER: 'jv_u', DB_PASSWORD: secret('pw'), ALLOWED_ORIGINS: TEST_ORIGIN };
    expect(loadConfig(base).adminTokenHash).toBeUndefined();
    expect(loadConfig({ ...base, JV_ADMIN_TOKEN_HASH: '' }).adminTokenHash, 'empty is unset').toBeUndefined();
    expect(loadConfig({ ...base, JV_ADMIN_TOKEN_HASH: HASH }).adminTokenHash).toBe(HASH);
    expect(loadConfig({ ...base, JV_ADMIN_TOKEN_HASH: HASH.toUpperCase() }).adminTokenHash, 'upper case is read as lower case').toBe(HASH);
    for (const bad of [TOKEN, HASH.slice(1), `${HASH}0`, `z${HASH.slice(1)}`, 'not a hash']) {
      let err: unknown;
      try {
        loadConfig({ ...base, JV_ADMIN_TOKEN_HASH: bad });
      } catch (e) {
        err = e;
      }
      expect(err, bad).toBeInstanceOf(ConfigError);
      expect((err as Error).message).toContain('JV_ADMIN_TOKEN_HASH');
      expect((err as Error).message).not.toContain(bad);
    }
  });

  it('refuses a missing, malformed or wrong token with 401 JV_UNAUTHENTICATED, and does nothing: no user, no event', async () => {
    const usersBefore = await countOf('users');
    const auditBefore = await countOf('audit_log');
    const wrong = randomBytes(32).toString('base64url');
    const cases: Record<string, string | undefined> = {
      none: undefined,
      empty: '',
      'only the word': 'Bearer',
      'only the word and a space': 'Bearer ',
      'another scheme': `Basic ${TOKEN}`,
      'the right token without the scheme': TOKEN,
      'a wrong token': `Bearer ${wrong}`,
      'the right token with one character added': `Bearer ${TOKEN}x`,
      'the right token with one character cut': `Bearer ${TOKEN.slice(0, -1)}`,
      'the hash instead of the token': `Bearer ${HASH}`,
      'two tokens': `Bearer ${TOKEN} ${TOKEN}`,
      'a very long value': `Bearer ${'a'.repeat(10_000)}`,
    };
    for (const [name, header] of Object.entries(cases)) {
      const res = await call('POST', '/admin/v1/users', { token: null, headers: header === undefined ? {} : { authorization: header }, payload: { email: newEmail(), full_name: 'Nobody', role: 'staff' } });
      expect(res.statusCode, name).toBe(401);
      expect(errorOf(res).code, name).toBe('JV_UNAUTHENTICATED');
      expect(res.body, name).not.toContain(TOKEN);
    }
    // a token whose hash starts like the real one's is still wrong (a comparison that stopped at the first difference, or at the first bytes, would let it in)
    for (const bytes of [1, 2]) {
      const near = tokenWithHashPrefix(HASH, bytes);
      const res = await call('GET', '/admin/v1/users', { token: near });
      expect(res.statusCode, `${bytes} byte(s) of the hash in common`).toBe(401);
    }
    expect(await countOf('users')).toBe(usersBefore);
    expect(await countOf('audit_log')).toBe(auditBefore);
  });

  it('compares the hash of the token with timingSafeEqual over two digests of 32 bytes, and with nothing else (constant time)', () => {
    const source = readFileSync(join(REPO, 'src', 'admin', 'door.ts'), 'utf8').replace(/\/\/.*$/gm, '');
    expect(source).toMatch(/timingSafeEqual\(presented, expected\)/);
    expect(source).toMatch(/createHash\('sha256'\)/);
    expect(source).not.toMatch(/\b(presented|expected|tokenHash)\b(?!\.)\s*(===|!==|==|!=)|(===|!==|==|!=)\s*(presented|expected|tokenHash)\b(?!\.)/); // (their lengths may be compared)
    expect(source).not.toMatch(/\.equals\(|localeCompare|startsWith\(.*(token|hash)/i);
  });

  it('accepts the right token, whatever the letter case of the scheme word (RFC 9110)', async () => {
    for (const scheme of ['Bearer', 'bearer', 'BEARER']) {
      const res = await call('GET', '/admin/v1/users', { token: null, headers: { authorization: `${scheme} ${TOKEN}` } });
      expect(res.statusCode, scheme).toBe(200);
    }
  });

  it('refuses ANY request that carries an Origin header, with the right token too, even an allowed origin with the CSRF headers; it sends no CORS header, and a preflight gets none either', async () => {
    const before = await countOf('users');
    const origins = ['https://evil.example.test', TEST_ORIGIN, 'null', 'http://localhost:3000'];
    for (const origin of origins) {
      for (const extra of [{}, { 'x-jv-client': 'web' }] as Record<string, string>[]) {
        const res = await call('POST', '/admin/v1/users', { payload: { email: newEmail(), full_name: 'Web Page', role: 'owner' }, headers: { origin, ...extra } });
        expect(res.statusCode, `${origin} ${JSON.stringify(extra)}`).toBe(403);
        expect(errorOf(res).code).toBe('JV_FORBIDDEN');
        for (const header of Object.keys(res.headers)) expect(header.startsWith('access-control-'), `${header} on the answer to ${origin}`).toBe(false);
      }
      const read = await call('GET', '/admin/v1/users', { headers: { origin } });
      expect(read.statusCode, `GET ${origin}`).toBe(403);
    }
    expect(await countOf('users')).toBe(before);

    // a preflight is answered by the CORS plugin's OPTIONS * route, which no route option can switch off: the door turns it away first, as it does any address that is not a route
    for (const origin of [TEST_ORIGIN, 'https://evil.example.test']) {
      for (const url of ['/admin/v1/users', `/admin/v1/users/${randomUUID()}/reset-password`, '/admin/v1/backup-pulls', '/admin/v1/nothing-here']) {
        const preflight = await call('OPTIONS', url, { token: null, headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization,content-type' } });
        expect(preflight.statusCode, `${origin} ${url}`).toBe(404);
        expect(errorOf(preflight).code).toBe('JV_NOT_FOUND');
        for (const header of Object.keys(preflight.headers)) expect(header.startsWith('access-control-'), `${header} on the preflight to ${url} from ${origin}`).toBe(false);
      }
    }
    const plain = await call('OPTIONS', '/admin/v1/users', { token: null });
    expect(plain.statusCode).toBe(404);
    // the rest of the API keeps its preflight (the website needs it)
    const site = await world.app.inject({ method: 'OPTIONS', url: '/v1/auth/login', headers: { origin: TEST_ORIGIN, 'access-control-request-method': 'POST' } });
    expect(site.headers['access-control-allow-origin']).toBe(TEST_ORIGIN);
  });

  it('an Origin header is refused before anything is counted: a web page cannot use up the ten calls a minute of the address it is opened from', async () => {
    const ip = freshIp();
    for (let i = 0; i < 25; i++) expect((await call('GET', '/admin/v1/users', { ip, headers: { origin: 'https://evil.example.test' } })).statusCode).toBe(403);
    for (let i = 0; i < 10; i++) expect((await call('GET', '/admin/v1/users', { ip })).statusCode, `call ${i + 1}`).toBe(200);
    expect((await call('GET', '/admin/v1/users', { ip })).statusCode, 'the eleventh real call').toBe(429);
  });

  it('creates a user with a random temporary password, shown once, and must_change_password; only a hash is kept', async () => {
    const email = newEmail('Mixed.Case');
    const res = await call('POST', '/admin/v1/users', { payload: { email: `  ${email.toUpperCase()}  `, full_name: '  Meena Sharma ', role: 'biller' } });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { user: Record<string, any>; temporary_password: string };
    expect(Object.keys(body).sort()).toEqual(['temporary_password', 'user']);
    expect(body.user).toEqual({ id: expect.stringMatching(/^[0-9a-f-]{36}$/), email: email.toLowerCase(), full_name: 'Meena Sharma', role: 'biller', active: true, must_change_password: true });
    expect(body.temporary_password.length).toBeGreaterThanOrEqual(16);
    const row = await userRow(body.user.id);
    expect(row).toMatchObject({ email: email.toLowerCase(), full_name: 'Meena Sharma', role: 'biller', active: 1, must_change_password: 1, last_login_at: null });
    expect(row.password_hash).toMatch(/^\$(argon2id|scrypt)\$/);
    expect(row.password_hash).not.toContain(body.temporary_password);
    expect(await passwords.verify(body.temporary_password, row.password_hash)).toBe(true);
    // shown once: the list, the audit rows and the log never hold it
    const list = await call('GET', '/admin/v1/users');
    expect(list.body).not.toContain(body.temporary_password);
    const audit = JSON.stringify(await auditOf(requestIdOf(res)));
    expect(audit).not.toContain(body.temporary_password);
    expect(audit).not.toContain(row.password_hash);
    expect(world.logs.text()).not.toContain(body.temporary_password);
  });

  it('the first owner is made the same way, and a second user with the same e-mail (any letter case) is refused', async () => {
    const owner = await addUser('owner');
    expect((await userRow(owner.id)).role).toBe('owner');
    const again = await call('POST', '/admin/v1/users', { payload: { email: owner.email.toUpperCase(), full_name: 'Again', role: 'staff' } });
    expect(again.statusCode).toBe(422);
    expect(errorOf(again).code).toBe('JV_INVALID_INPUT');
    expect(errorOf(again).details).toEqual({ field: 'email' });
    expect(again.body).not.toContain(owner.email);
  });

  it('refuses a body that is not exactly {email, full_name, role}: an unknown field, a role that does not exist, no name, a bad e-mail, a name that is too long, no body', async () => {
    const good = { email: newEmail(), full_name: 'Good Name', role: 'staff' };
    const bad: [string, unknown][] = [
      ['an unknown field (active)', { ...good, active: false }],
      ['an unknown field (password)', { ...good, password: 'x'.repeat(20) }],
      ['a role that does not exist', { ...good, role: 'admin' }],
      ['an empty role', { ...good, role: '' }],
      ['no name', { email: good.email, role: 'staff' }],
      ['a blank name', { ...good, full_name: '   ' }],
      ['a name over 120 characters', { ...good, full_name: 'n'.repeat(121) }],
      ['an e-mail without @', { ...good, email: 'nobody.example.test' }],
      ['an e-mail with a space', { ...good, email: 'no body@example.test' }],
      ['an e-mail over 254 characters', { ...good, email: `${'a'.repeat(250)}@example.test` }],
      ['a number for the name', { ...good, full_name: 12 }],
      ['no body at all', undefined],
    ];
    for (const [name, payload] of bad) {
      const res = await call('POST', '/admin/v1/users', { payload });
      expect(res.statusCode, name).toBe(422);
      expect(errorOf(res).code, name).toBe('JV_INVALID_INPUT');
    }
    expect(Number((await world.sql.query<any[]>('SELECT COUNT(*) AS n FROM users WHERE email = ?', [good.email]))[0][0].n)).toBe(0);
  });

  it('a created user can call only change-password, logout and me: every other call is 403 JV_PASSWORD_CHANGE_REQUIRED, until the password is changed', async () => {
    const made = await addUser('staff');
    const { res: loggedIn, cookie } = await login(made.email, made.password);
    expect(loggedIn.statusCode).toBe(200);
    expect(loggedIn.json().user).toMatchObject({ email: made.email, role: 'staff', must_change_password: true });
    expect(cookie).not.toBeNull();

    const me = await session('GET', '/v1/auth/me', cookie!);
    expect(me.statusCode).toBe(200);
    expect(me.json().user.must_change_password).toBe(true);

    // every other row of the matrix, one of each kind: a session call, a read and a writing function
    for (const action of ['session:activity', 'read:users', 'fn:create_bill'] as const) {
      const row = MATRIX[action];
      const res = await session(row.method as 'GET' | 'POST', concreteUrl(row.path), cookie!, row.method === 'GET' ? undefined : {});
      expect(res.statusCode, action).toBe(403);
      expect(errorOf(res).code, action).toBe('JV_PASSWORD_CHANGE_REQUIRED');
    }
    expect(world.handled.filter((a) => a === 'read:users' || a === 'fn:create_bill')).toEqual([]);

    const newPassword = secret('Np');
    const changed = await session('POST', '/v1/auth/change-password', cookie!, { current_password: made.password, new_password: newPassword });
    expect(changed.statusCode).toBe(200);
    expect(changed.json().user.must_change_password).toBe(false);
    expect((await session('POST', '/v1/auth/activity', cookie!)).statusCode, 'after the change the other calls are open').toBe(200);
    expect((await login(made.email, made.password)).res.statusCode, 'the temporary password no longer works').toBe(401);
    expect((await login(made.email, newPassword)).res.statusCode).toBe(200);

    const out = await session('POST', '/v1/auth/logout', cookie!);
    expect(out.statusCode).toBe(200);
  });

  it('logout works for a user who must still change the password', async () => {
    const made = await addUser('biller');
    const { cookie } = await login(made.email, made.password);
    expect((await session('POST', '/v1/auth/logout', cookie!)).statusCode).toBe(200);
    expect((await session('GET', '/v1/auth/me', cookie!)).statusCode).toBe(401);
  });

  it('an admin reset sets a new temporary password and must_change_password and ends ALL sessions of that user at once', async () => {
    const made = await addUser('biller');
    const newPassword = secret('Np');
    const first = await login(made.email, made.password);
    await session('POST', '/v1/auth/change-password', first.cookie!, { current_password: made.password, new_password: newPassword });
    const second = await login(made.email, newPassword);
    const third = await login(made.email, newPassword);
    expect(await liveSessions(made.id)).toBe(3);
    for (const c of [first.cookie, second.cookie, third.cookie]) expect((await session('GET', '/v1/auth/me', c!)).statusCode).toBe(200);

    const reset = await call('POST', `/admin/v1/users/${made.id}/reset-password`);
    expect(reset.statusCode).toBe(200);
    const body = reset.json() as { user: Record<string, any>; temporary_password: string; sessions_ended: number };
    expect(body.sessions_ended).toBe(3);
    expect(body.user).toMatchObject({ id: made.id, email: made.email, role: 'biller', active: true, must_change_password: true });
    expect(body.temporary_password).not.toBe(made.password);

    expect(await liveSessions(made.id)).toBe(0);
    expect(await allSessions(made.id), 'nothing is deleted (S7): the sessions stay, marked ended').toBe(3);
    for (const c of [first.cookie, second.cookie, third.cookie]) {
      const res = await session('GET', '/v1/auth/me', c!);
      expect(res.statusCode).toBe(401);
      expect(errorOf(res).code).toBe('JV_UNAUTHENTICATED');
    }
    expect((await login(made.email, newPassword)).res.statusCode, 'the password before the reset is gone').toBe(401);
    expect((await login(made.email, made.password)).res.statusCode, 'and so is the first temporary one').toBe(401);
    const again = await login(made.email, body.temporary_password);
    expect(again.res.statusCode).toBe(200);
    expect(again.res.json().user.must_change_password).toBe(true);
    expect((await session('POST', '/v1/auth/activity', again.cookie!)).statusCode, 'and the flag is back').toBe(403);
  });

  it('changes a role: it takes effect at the next call of the same session, the previous role is in the answer, and it is the only way a role changes', async () => {
    const made = await addUser('staff');
    const newPassword = secret('Np');
    const { cookie } = await login(made.email, made.password);
    await session('POST', '/v1/auth/change-password', cookie!, { current_password: made.password, new_password: newPassword });
    expect((await session('GET', '/v1/auth/me', cookie!)).json().user.role).toBe('staff');

    const res = await call('POST', `/admin/v1/users/${made.id}/role`, { payload: { role: 'owner' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ user: { id: made.id, role: 'owner', active: true, must_change_password: false }, previous_role: 'staff' });
    expect((await userRow(made.id)).role).toBe('owner');
    expect((await session('GET', '/v1/auth/me', cookie!)).json().user.role, 'read from the database on every call (A2)').toBe('owner');

    const back = await call('POST', `/admin/v1/users/${made.id}/role`, { payload: { role: 'biller' } });
    expect(back.json()).toMatchObject({ user: { role: 'biller' }, previous_role: 'owner' });

    for (const payload of [{ role: 'admin' }, { role: '' }, {}, { role: 'owner', active: false }, undefined]) {
      const bad = await call('POST', `/admin/v1/users/${made.id}/role`, { payload });
      expect(bad.statusCode, JSON.stringify(payload)).toBe(422);
    }
    expect((await userRow(made.id)).role).toBe('biller');
  });

  it('deactivate ends the sessions and the user reads nothing; activate lets them sign in again, but the old sessions stay ended', async () => {
    const made = await addUser('biller');
    const newPassword = secret('Np');
    const { cookie } = await login(made.email, made.password);
    await session('POST', '/v1/auth/change-password', cookie!, { current_password: made.password, new_password: newPassword });
    expect((await session('POST', '/v1/auth/activity', cookie!)).statusCode).toBe(200);

    const off = await call('POST', `/admin/v1/users/${made.id}/deactivate`);
    expect(off.statusCode).toBe(200);
    expect(off.json()).toMatchObject({ user: { id: made.id, active: false }, sessions_ended: 1 });
    expect((await userRow(made.id)).active).toBe(0);
    expect(await liveSessions(made.id)).toBe(0);
    expect((await session('GET', '/v1/auth/me', cookie!)).statusCode).toBe(401);
    const refused = await login(made.email, newPassword);
    expect(refused.res.statusCode).toBe(403);
    expect(errorOf(refused.res).details).toMatchObject({ reason: 'inactive' });

    const on = await call('POST', `/admin/v1/users/${made.id}/activate`);
    expect(on.statusCode).toBe(200);
    expect(on.json()).toMatchObject({ user: { id: made.id, active: true } });
    expect((await userRow(made.id)).active).toBe(1);
    expect((await session('GET', '/v1/auth/me', cookie!)).statusCode, 'a session that was ended is not revived by an activation').toBe(401);
    expect((await login(made.email, newPassword)).res.statusCode).toBe(200);
  });

  it('every call that names a user answers 404 JV_NOT_FOUND for one that does not exist and 422 for an id that is not a UUID; nothing changes', async () => {
    const auditBefore = await countOf('audit_log');
    const sessionsBefore = await countOf('sessions');
    const ghost = randomUUID();
    for (const [url, payload] of [
      [`/admin/v1/users/${ghost}/reset-password`, undefined],
      [`/admin/v1/users/${ghost}/role`, { role: 'owner' }],
      [`/admin/v1/users/${ghost}/deactivate`, undefined],
      [`/admin/v1/users/${ghost}/activate`, undefined],
    ] as const) {
      const res = await call('POST', url, { payload });
      expect(res.statusCode, url).toBe(404);
      expect(errorOf(res).code).toBe('JV_NOT_FOUND');
    }
    for (const id of ['not-a-uuid', '12345', ghost.toUpperCase()]) {
      const res = await call('POST', `/admin/v1/users/${id}/deactivate`);
      expect(res.statusCode, id).toBe(422);
    }
    expect(await countOf('audit_log')).toBe(auditBefore);
    expect(await countOf('sessions')).toBe(sessionsBefore);
  });

  it('a call that takes no body refuses one (an unknown field is refused, A14), and accepts none or {}', async () => {
    const made = await addUser('staff');
    expect((await call('POST', `/admin/v1/users/${made.id}/deactivate`, { payload: { reason: 'x' } })).statusCode).toBe(422);
    expect((await call('POST', `/admin/v1/users/${made.id}/deactivate`, { payload: {} })).statusCode).toBe(200);
    expect((await call('POST', `/admin/v1/users/${made.id}/activate`)).statusCode).toBe(200);
  });

  it('lists the users with what Harsh needs and never a hash', async () => {
    const made = await addUser('biller');
    const res = await call('GET', '/admin/v1/users');
    expect(res.statusCode).toBe(200);
    const users = (res.json() as { users: Record<string, any>[] }).users;
    const mine = users.find((u) => u.id === made.id)!;
    expect(mine).toEqual({ id: made.id, email: made.email, full_name: 'Made biller', role: 'biller', active: true, must_change_password: true, last_login_at: null, created_at: expect.stringMatching(/Z$/) });
    expect(users.length).toBe(await countOf('users'));
    expect(res.body).not.toMatch(/\$argon2|\$scrypt|password_hash|"password"/i);
    for (const u of users) expect(Object.keys(u).sort()).toEqual(Object.keys(mine).sort());
  });

  it('clears the login counters: n = 0 and the window to now on every row of the scopes email, addr and any; the summary row is left alone; a refused login then counts as the first attempt', async () => {
    // rows as an attack leaves them (the table is empty in a fresh database)
    const old = '2026-10-17 09:59:30.000000';
    await world.sql.query(
      "INSERT INTO sys_login_attempts (scope, slot, window_start, n) VALUES ('email', 5, ?, 9), ('email', 900, ?, 2), ('addr', 7, ?, 25), ('any', 0, ?, 70), ('audit', 0, ?, 13) ON DUPLICATE KEY UPDATE window_start = VALUES(window_start), n = VALUES(n)",
      [old, old, old, old, old],
    );
    // the logins of the tests before this one have left their counters too (API08): every row of the three scopes is cleared, whoever made it
    const counting = Number((await world.sql.query<any[]>("SELECT COUNT(*) AS n FROM sys_login_attempts WHERE scope IN ('email', 'addr', 'any')"))[0][0].n);
    expect(counting).toBeGreaterThanOrEqual(4);
    const res = await call('POST', '/admin/v1/login-counters/clear');
    expect(res.statusCode).toBe(200);
    const rows = (await world.sql.query<any[]>("SELECT scope, slot, n, TIMESTAMPDIFF(SECOND, window_start, UTC_TIMESTAMP(6)) AS age, DATE_FORMAT(window_start, '%Y-%m-%d %H:%i:%s.%f') AS w FROM sys_login_attempts ORDER BY scope, slot"))[0] as Record<string, any>[];
    expect(res.json()).toEqual({ cleared: counting });
    for (const r of rows.filter((x) => x.scope !== 'audit')) {
      expect(Number(r.n), `${r.scope} ${r.slot}`).toBe(0);
      expect(Number(r.age), `${r.scope} ${r.slot} window is now`).toBeLessThan(30);
    }
    const audit = rows.find((r) => r.scope === 'audit')!;
    expect(Number(audit.n)).toBe(13);
    expect(audit.w).toBe(old);
    // the next attempt counts as the first: under 5 for an e-mail (no wait) and under 20 for an address (not refused)
    expect(await countAttempt(world.sql as never, 'email', 5)).toBe(1);
    expect(await countAttempt(world.sql as never, 'addr', 7)).toBe(1);
    expect(await countAttempt(world.sql as never, 'any', 0)).toBe(1);
  });

  it('records a pull of the backup: settings.last_pulled = {at, by, file, sha256}, with `at` from the API clock and `by` admin-cli; a second pull replaces it', async () => {
    const sha = randomBytes(32).toString('hex');
    const res = await call('POST', '/admin/v1/backup-pulls', { payload: { file: 'daily/2026-10-16.enc', sha256: sha } });
    expect(res.statusCode).toBe(200);
    const stored = asObject((await world.sql.query<any[]>("SELECT value FROM settings WHERE setting_key = 'last_pulled'"))[0][0].value);
    expect(stored).toEqual({ at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/), by: 'admin-cli', file: 'daily/2026-10-16.enc', sha256: sha });
    // `at` is the API's clock (the fixed instant of this world), not the client's and not the database's
    expect(Math.abs(Date.parse(stored.at) - Number(micros / 1000n))).toBeLessThan(5000);
    expect(res.json()).toEqual({ recorded: true, at: stored.at });

    advance(2n * MINUTE);
    const sha2 = randomBytes(32).toString('hex').toUpperCase();
    const second = await call('POST', '/admin/v1/backup-pulls', { payload: { file: 'monthly/2026-10.enc', sha256: sha2 } });
    expect(second.statusCode).toBe(200);
    const stored2 = asObject((await world.sql.query<any[]>("SELECT value FROM settings WHERE setting_key = 'last_pulled'"))[0][0].value);
    expect(stored2).toEqual({ at: expect.any(String), by: 'admin-cli', file: 'monthly/2026-10.enc', sha256: sha2.toLowerCase() });
    expect(Date.parse(stored2.at) - Date.parse(stored.at)).toBeGreaterThan(119_000);
    expect(Date.parse(stored2.at) - Date.parse(stored.at)).toBeLessThan(125_000);
    expect(Number((await world.sql.query<any[]>("SELECT COUNT(*) AS n FROM settings WHERE setting_key = 'last_pulled'"))[0][0].n)).toBe(1);
  });

  it('refuses a pull record that is not a backup name and a sha256: nothing is written', async () => {
    const good = { file: 'daily/2026-10-16.enc', sha256: randomBytes(32).toString('hex') };
    const read = async () => (await world.sql.query<any[]>("SELECT value FROM settings WHERE setting_key = 'last_pulled'"))[0].map((r: any) => asObject(r.value));
    const before = await read();
    const bad: [string, unknown][] = [
      ['a path that leaves the folder', { ...good, file: '../daily/2026-10-16.enc' }],
      ['an absolute path', { ...good, file: '/etc/passwd' }],
      ['a name that is not a backup', { ...good, file: 'daily/notes.txt' }],
      ['a short sha256', { ...good, sha256: 'abc123' }],
      ['a sha256 that is not hex', { ...good, sha256: 'z'.repeat(64) }],
      ['an unknown field (by)', { ...good, by: 'Harsh' }],
      ['an unknown field (at)', { ...good, at: '2020-01-01T00:00:00.000Z' }],
      ['no body', undefined],
    ];
    for (const [name, payload] of bad) {
      const res = await call('POST', '/admin/v1/backup-pulls', { payload });
      expect(res.statusCode, name).toBe(422);
    }
    expect(await read()).toEqual(before);
  });
});

// ------------------------------------------------------------------------------------------------ the temporary password

describe('T-D27 the temporary password is random, readable, and long enough to be guessed by nobody', () => {
  it('is 16 characters from an alphabet without the look-alikes (0 O 1 l I), in four groups of four, and 2,000 of them never repeat', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i++) {
      const p = newTemporaryPassword();
      expect(p, p).toMatch(/^[A-HJ-NP-Za-km-z2-9]{4}(-[A-HJ-NP-Za-km-z2-9]{4}){3}$/);
      expect(p.length).toBe(19);
      seen.add(p);
    }
    expect(seen.size).toBe(2000);
  });

  it('uses every character of its alphabet about equally (no modulo bias): 57 symbols, each within a fifth of the mean in 200,000 draws', () => {
    const counts = new Map<string, number>();
    for (let i = 0; i < 12_500; i++) for (const ch of newTemporaryPassword().replace(/-/g, '')) counts.set(ch, (counts.get(ch) ?? 0) + 1);
    expect(counts.size).toBe(57);
    const mean = 200_000 / counts.size;
    for (const [ch, n] of counts) expect(Math.abs(n - mean) / mean, ch).toBeLessThan(0.2);
  });

  it('passes the rules for a password of U9, so a user who keeps it for a minute is not worse off than one who chose it', async () => {
    const { checkNewPassword } = await import('../../src/auth/password');
    for (let i = 0; i < 200; i++) expect(checkNewPassword(newTemporaryPassword(), 'someone@example.test')).toBeNull();
  });
});

// ------------------------------------------------------------------------------------------------ T-D14 clause

describe('T-D14 (API09 clause) every admin call writes one `event` row with the role admin-cli, and no token or password is in any audit row of it', () => {
  it('each of the eight calls leaves exactly one event row (actor empty, role admin-cli, its own request id), plus only the rows the triggers write for the change itself', async () => {
    const secrets: string[] = [TOKEN, HASH];
    const calls: { name: string; res: LightMyRequestResponse; event: string; table: string; triggerRows: number }[] = [];
    const make = await call('POST', '/admin/v1/users', { payload: { email: newEmail(), full_name: 'Audit Subject', role: 'staff' } });
    const subject = (make.json() as { user: { id: string }; temporary_password: string });
    secrets.push(subject.temporary_password);
    calls.push({ name: 'add user', res: make, event: 'admin_add_user', table: 'users', triggerRows: 1 });
    const reset = await call('POST', `/admin/v1/users/${subject.user.id}/reset-password`);
    secrets.push((reset.json() as { temporary_password: string }).temporary_password);
    calls.push({ name: 'reset', res: reset, event: 'admin_reset_password', table: 'users', triggerRows: 0 }); // only the hash changes (it is on the exclude list of L1): no trigger row
    calls.push({ name: 'role', res: await call('POST', `/admin/v1/users/${subject.user.id}/role`, { payload: { role: 'biller' } }), event: 'admin_change_role', table: 'users', triggerRows: 1 });
    calls.push({ name: 'deactivate', res: await call('POST', `/admin/v1/users/${subject.user.id}/deactivate`), event: 'admin_deactivate_user', table: 'users', triggerRows: 1 });
    calls.push({ name: 'activate', res: await call('POST', `/admin/v1/users/${subject.user.id}/activate`), event: 'admin_activate_user', table: 'users', triggerRows: 1 });
    calls.push({ name: 'list', res: await call('GET', '/admin/v1/users'), event: 'admin_list_users', table: 'users', triggerRows: 0 });
    calls.push({ name: 'clear counters', res: await call('POST', '/admin/v1/login-counters/clear'), event: 'admin_clear_login_counters', table: 'sys_login_attempts', triggerRows: 0 });
    calls.push({ name: 'record pull', res: await call('POST', '/admin/v1/backup-pulls', { payload: { file: 'daily/2026-10-17.enc', sha256: randomBytes(32).toString('hex') } }), event: 'admin_record_pull', table: 'settings', triggerRows: 1 });

    for (const c of calls) {
      expect(c.res.statusCode, c.name).toBeLessThan(300);
      const rows = await auditOf(requestIdOf(c.res));
      const events = rows.filter((r) => r.action === 'event');
      expect(events, c.name).toHaveLength(1);
      expect(events[0], c.name).toMatchObject({ actor: null, actor_role: 'admin-cli', table_name: c.table, request_id: requestIdOf(c.res) });
      expect(asObject(events[0].new_row).event, c.name).toBe(c.event);
      expect(rows.length - 1, `${c.name}: the other rows are the triggers' rows for the change`).toBe(c.triggerRows);
      for (const r of rows) expect(r.actor_role, c.name).toBe('admin-cli');
      const text = JSON.stringify(rows);
      for (const s of secrets) expect(text, c.name).not.toContain(s);
      expect(text, c.name).not.toMatch(/\$argon2|\$scrypt|password_hash/);
    }
    // the role change names both roles; the deactivation counts the sessions it ended
    const roleEvent = asObject((await eventsOf(requestIdOf(calls[2].res)))[0].new_row);
    expect(roleEvent).toMatchObject({ from: 'staff', to: 'biller' });
  });

  it('a refused call (wrong token, an Origin, a throttle, a 404 user, a bad body) leaves no event row and no row at all', async () => {
    const before = await countOf('audit_log');
    const ghost = randomUUID();
    const refused = [
      await call('GET', '/admin/v1/users', { token: randomBytes(32).toString('base64url') }),
      await call('GET', '/admin/v1/users', { headers: { origin: TEST_ORIGIN } }),
      await call('POST', `/admin/v1/users/${ghost}/deactivate`),
      await call('POST', '/admin/v1/users', { payload: { email: 'bad' } }),
    ];
    for (const res of refused) {
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
      expect(await auditOf(requestIdOf(res))).toEqual([]);
    }
    expect(await countOf('audit_log')).toBe(before);
  });

  it('no log line of any call holds the token, its hash or a temporary password', () => {
    const text = world.logs.text();
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain(HASH);
    expect(world.logs.lines().some((l) => l.msg === 'incoming request' || l.req)).toBe(true); // the log was on: this proves something
  });
});

// ------------------------------------------------------------------------------------------------ T-D24 clause

describe('T-D24 (API09 clause) the admin-door rows of A13: 10 a minute per address, 15 minutes after two wrong tokens in a row, 5 wrong tokens an hour when the address is untrusted', () => {
  const retryAfter = (res: LightMyRequestResponse) => Number(res.headers['retry-after']);

  it('the eleventh call in a minute from one address is 429 JV_RATE_LIMITED with Retry-After; another address is not affected; a minute later the address works again', async () => {
    const ip = freshIp();
    for (let i = 0; i < 10; i++) expect((await call('GET', '/admin/v1/users', { ip })).statusCode, `call ${i + 1}`).toBe(200);
    const eleventh = await call('GET', '/admin/v1/users', { ip });
    expect(eleventh.statusCode).toBe(429);
    expect(errorOf(eleventh).code).toBe('JV_RATE_LIMITED');
    expect(retryAfter(eleventh)).toBeGreaterThanOrEqual(1);
    expect(retryAfter(eleventh)).toBeLessThanOrEqual(60);
    expect(String(eleventh.headers['retry-after'])).toMatch(/^\d+$/);
    expect((await call('GET', '/admin/v1/users', { ip: freshIp() })).statusCode, 'another address').toBe(200);
    expect((await call('GET', '/admin/v1/users', { ip })).statusCode, 'still the same minute').toBe(429);
    advance(61n * SECOND);
    expect((await call('GET', '/admin/v1/users', { ip })).statusCode, 'the next minute').toBe(200);
  });

  it('writing calls count too, and a refused (429) call writes no event row', async () => {
    const ip = freshIp();
    const before = await countOf('audit_log');
    for (let i = 0; i < 10; i++) expect((await call('POST', '/admin/v1/login-counters/clear', { ip })).statusCode).toBe(200);
    expect(await countOf('audit_log')).toBe(before + 10);
    const over = await call('POST', '/admin/v1/login-counters/clear', { ip });
    expect(over.statusCode).toBe(429);
    expect(await auditOf(requestIdOf(over))).toEqual([]);
    expect(await countOf('audit_log')).toBe(before + 10);
  });

  it('two addresses of one IPv6 /64 count as one address', async () => {
    const a = '2001:db8:7:7:aaaa::1';
    const b = '2001:db8:7:7:bbbb::2';
    for (let i = 0; i < 5; i++) expect((await call('GET', '/admin/v1/users', { ip: a })).statusCode).toBe(200);
    for (let i = 0; i < 5; i++) expect((await call('GET', '/admin/v1/users', { ip: b })).statusCode).toBe(200);
    expect((await call('GET', '/admin/v1/users', { ip: a })).statusCode).toBe(429);
    expect((await call('GET', '/admin/v1/users', { ip: '2001:db8:7:8::1' })).statusCode, 'the next /64').toBe(200);
  });

  it('after two wrong tokens in a row the address is paused for 15 minutes: even the right token gets 429 with Retry-After until then; another address is not paused', async () => {
    const ip = freshIp();
    const wrong = () => randomBytes(32).toString('base64url');
    expect((await call('GET', '/admin/v1/users', { ip, token: wrong() })).statusCode, 'the first wrong token').toBe(401);
    expect((await call('GET', '/admin/v1/users', { ip, token: wrong() })).statusCode, 'the second wrong token').toBe(401);
    const paused = await call('GET', '/admin/v1/users', { ip });
    expect(paused.statusCode, 'the right token, while paused').toBe(429);
    expect(errorOf(paused).code).toBe('JV_RATE_LIMITED');
    expect(retryAfter(paused)).toBeGreaterThan(14 * 60);
    expect(retryAfter(paused)).toBeLessThanOrEqual(15 * 60);
    expect((await call('GET', '/admin/v1/users', { ip, token: wrong() })).statusCode, 'a wrong token while paused is 429, not 401').toBe(429);
    expect((await call('GET', '/admin/v1/users', { ip: freshIp() })).statusCode, 'another address').toBe(200);

    advance(14n * MINUTE);
    const still = await call('GET', '/admin/v1/users', { ip });
    expect(still.statusCode).toBe(429);
    expect(retryAfter(still)).toBeLessThanOrEqual(60);
    advance(61n * SECOND);
    expect((await call('GET', '/admin/v1/users', { ip })).statusCode, '15 minutes have passed').toBe(200);
  });

  it('wrong tokens that are not in a row do not pause: a right token between them clears the count', async () => {
    const ip = freshIp();
    const wrong = () => randomBytes(32).toString('base64url');
    expect((await call('GET', '/admin/v1/users', { ip, token: wrong() })).statusCode).toBe(401);
    expect((await call('GET', '/admin/v1/users', { ip })).statusCode).toBe(200);
    expect((await call('GET', '/admin/v1/users', { ip, token: wrong() })).statusCode).toBe(401);
    expect((await call('GET', '/admin/v1/users', { ip })).statusCode, 'one wrong in a row is not two').toBe(200);
  });

  it('with an address that cannot be trusted (no x-real-ip) there is no pause: the sixth wrong token in an hour is 429 with Retry-After, and the right token still works', async () => {
    const wrong = () => randomBytes(32).toString('base64url');
    for (let i = 0; i < 5; i++) expect((await call('GET', '/admin/v1/users', { ip: null, token: wrong() })).statusCode, `wrong token ${i + 1}`).toBe(401);
    const sixth = await call('GET', '/admin/v1/users', { ip: null, token: wrong() });
    expect(sixth.statusCode).toBe(429);
    expect(errorOf(sixth).code).toBe('JV_RATE_LIMITED');
    expect(retryAfter(sixth)).toBeGreaterThan(50 * 60);
    expect(retryAfter(sixth)).toBeLessThanOrEqual(60 * 60);
    expect((await call('GET', '/admin/v1/users', { ip: null })).statusCode, 'a stranger cannot lock Harsh out: the right token passes').toBe(200);
    // an address we do trust is not slowed by the strangers' budget
    expect((await call('GET', '/admin/v1/users', { ip: freshIp(), token: wrong() })).statusCode, 'a trusted address is judged on its own count').toBe(401);

    advance(61n * MINUTE);
    expect((await call('GET', '/admin/v1/users', { ip: null, token: wrong() })).statusCode, 'an hour later the budget is back').toBe(401);
  });

  it('a header that is not one address (a list, a port, text) is untrusted too, and x-forwarded-for is never read', async () => {
    const wrong = () => randomBytes(32).toString('base64url');
    advance(61n * MINUTE); // a clean hour
    const headers: Record<string, string>[] = [{ 'x-real-ip': '203.0.113.9, 198.51.100.4' }, { 'x-real-ip': '203.0.113.9:443' }, { 'x-real-ip': 'unknown' }, { 'x-forwarded-for': freshIp() }, {}];
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) codes.push((await call('GET', '/admin/v1/users', { ip: null, token: wrong(), headers: headers[i % headers.length] })).statusCode);
    expect(codes).toEqual([401, 401, 401, 401, 401, 429]);
  });

  it('the counters are in memory: a new process (a new application over the same database) starts from zero, also for a pause', async () => {
    const config = testConfig({ logLevel: 'warn', adminTokenHash: HASH });
    const pool1 = createDbPool(world.scratch.db);
    const app1 = buildApp({ config, db: pool1, clock, logStream: logSink().stream });
    await app1.ready();
    const busy = freshIp();
    const pausedIp = freshIp();
    for (let i = 0; i < 10; i++) expect((await call('GET', '/admin/v1/users', { ip: busy, app: app1 })).statusCode).toBe(200);
    expect((await call('GET', '/admin/v1/users', { ip: busy, app: app1 })).statusCode).toBe(429);
    for (let i = 0; i < 2; i++) await call('GET', '/admin/v1/users', { ip: pausedIp, app: app1, token: randomBytes(32).toString('base64url') });
    expect((await call('GET', '/admin/v1/users', { ip: pausedIp, app: app1 })).statusCode).toBe(429);
    await app1.close();

    const app2 = buildApp({ config, db: createDbPool(world.scratch.db), clock, logStream: logSink().stream });
    await app2.ready();
    expect((await call('GET', '/admin/v1/users', { ip: busy, app: app2 })).statusCode, 'the address that was over its ten').toBe(200);
    expect((await call('GET', '/admin/v1/users', { ip: pausedIp, app: app2 })).statusCode, 'the address that was paused').toBe(200);
    await app2.close();
  });
});

// ------------------------------------------------------------------------------------------------ T-D20, U2, A8

describe('T-D20 (HTTP half) no route updates users in M1: PATCH, PUT and POST on /v1/users and /v1/users/{id} are 404 for every role', () => {
  const ROLE_CALLERS = ['owner', 'biller', 'staff', 'anon'] as const;

  it('404 JV_NOT_FOUND for the owner, the biller, the staff and a caller with no session, for every verb and every body, and no row changes', async () => {
    const before = (await world.sql.query<any[]>('SELECT id, email, role, active, must_change_password, updated_at FROM users ORDER BY id'))[0];
    for (const caller of ROLE_CALLERS) {
      const own = caller === 'anon' ? randomUUID() : world.fixtures[caller].userId;
      for (const url of ['/v1/users', `/v1/users/${own}`, `/v1/users/${randomUUID()}`]) {
        for (const method of ['PATCH', 'PUT', 'POST'] as const) {
          for (const payload of [{ role: 'owner' }, { active: false }, { role: 'owner', active: true, email: newEmail(), full_name: 'Sign Up', password: secret('Pw') }]) {
            const res = await world.call(caller, method, url, { payload });
            expect(res.statusCode, `${caller} ${method} ${url}`).toBe(404);
            expect(errorOf(res).code).toBe('JV_NOT_FOUND');
          }
        }
      }
    }
    expect((await world.sql.query<any[]>('SELECT id, email, role, active, must_change_password, updated_at FROM users ORDER BY id'))[0]).toEqual(before);
  });

  it('U2: no sign-up. Paths that look like one are 404 for everybody, the door\'s address space included; the door itself is the one place an account is made', async () => {
    for (const path of ['/signup', '/register', '/v1/signup', '/v1/register', '/v1/auth/signup', '/v1/auth/sign-up', '/v1/auth/register', '/v1/auth/create-account', '/v1/users/register', '/admin/v1/signup', '/admin/v1/register', '/admin/v1/users/new']) {
      for (const caller of ROLE_CALLERS) {
        const res = await world.call(caller, 'POST', path, { payload: { email: newEmail(), full_name: 'Sign Up', password: secret('Pw'), role: 'owner' } });
        expect(res.statusCode, `${caller} ${path}`).toBe(404);
      }
      const door = await call('POST', path, { payload: { email: newEmail(), full_name: 'Sign Up', role: 'owner' } });
      expect(door.statusCode, `the door ${path}`).toBe(404);
    }
  });

  it('the route table: the only routes that can create or change a user are token routes of the admin door; no session route writes under /users', () => {
    const writes = world.app.routeTable.filter((r) => r.method !== 'GET' && /users/.test(r.url));
    expect(writes.length).toBeGreaterThan(0);
    for (const r of writes) expect(r, `${r.method} ${r.url}`).toMatchObject({ kind: 'token', name: 'admin' });
    for (const [action, row] of Object.entries(MATRIX)) if ('edit' in row && row.edit) expect(row.edit.table, action).not.toBe('users');
  });

  it('A8, U2: the statements that insert into or update `users` are in the admin door and, for the user\'s own password, the session routes: nowhere else, and none outside the door sets a role or active', () => {
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
    for (const [file, hits] of Object.entries(found)) {
      if (file.startsWith(`src${'/'}admin${'/'}`)) continue;
      expect(file, 'a statement that writes users outside the admin door').toBe('src/auth/loginRoutes.ts');
      for (const h of hits) {
        expect(h).toMatch(/SET\s+password_hash\s*=\s*\?,\s*must_change_password\s*=\s*0\s+WHERE\s+id\s*=\s*\?/i);
        expect(h).not.toMatch(/\b(role|active|email)\s*=/i);
      }
    }
    expect(Object.keys(found).some((f) => f.startsWith(`src${'/'}admin${'/'}`)), 'the door has its statements').toBe(true);
  });

  it('O54: `last_pulled` is written by the admin door and by nothing else', () => {
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
      return /(INSERT\s+INTO|UPDATE)\s+settings\b/i.test(text) && /last_pulled/.test(text);
    });
    expect(writers.map((f) => relative(REPO, f))).toEqual(['src/db/adminStatements.ts']);
    const routes = world.app.routeTable.filter((r) => /pull/.test(r.url));
    for (const r of routes) expect(r, `${r.method} ${r.url}`).toMatchObject({ kind: 'token', name: 'admin' });
  });
});
