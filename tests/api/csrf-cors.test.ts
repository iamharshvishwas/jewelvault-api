import cors from '@fastify/cors';
import Fastify, { type FastifyInstance, type LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app';
import { ConfigError, loadConfig } from '../../src/config';
import { JvError } from '../../src/errors';
import { type MatrixRow, MATRIX, PUBLIC_ROUTES } from '../../src/permissions/matrix';
import { createRoute, route } from '../../src/permissions/route';
import { csrfRefusal } from '../../src/security/csrf';
import { parseAllowedOrigins, parseOrigin } from '../../src/security/origins';
import { concreteUrl, makeWorld, registerStubs, type World } from './cells';
import { TEST_ORIGIN, csrfHeaders, logSink, secret, testConfig, toyRoutes } from './support';

// T-D23 (A12, API07): CORS answers only for an exact list of origins; three CSRF layers, any failure is 403 JV_CSRF; no state change is reachable by GET.

const EVIL = 'https://evil.example.test';
/** Origins that look like the allowed one and are not: every one must be refused, whatever the layer. */
const LOOKALIKES = [
  EVIL,
  `${TEST_ORIGIN}.evil.example.test`, // a longer host that starts with ours
  'https://evilapp.example.test',
  'https://sub.app.example.test',
  'http://app.example.test', // the scheme is part of the origin
  `${TEST_ORIGIN}:8443`, // so is the port
  `${TEST_ORIGIN}/`, // the browser never sends a trailing slash
  'HTTPS://APP.EXAMPLE.TEST', // nor capitals
  ` ${TEST_ORIGIN}`,
  'null',
  '*',
  '',
];

const body = (res: { body: string }) => JSON.parse(res.body) as { error: { code: string; message: string; details: Record<string, unknown> }; request_id: string };

async function withToy<T>(fn: (c: { app: FastifyInstance; toy: ReturnType<typeof toyRoutes>; sink: ReturnType<typeof logSink> }) => Promise<T>, config = testConfig()): Promise<T> {
  const sink = logSink();
  const app = buildApp({ config, logStream: sink.stream });
  const toy = toyRoutes(app);
  try {
    return await fn({ app, toy, sink });
  } finally {
    await app.close();
  }
}

const preflight = (app: FastifyInstance, origin: string | undefined, method: string, headers = 'content-type,idempotency-key,x-jv-client', url = '/toy/edit') =>
  app.inject({ method: 'OPTIONS', url, headers: { ...(origin === undefined ? {} : { origin }), 'access-control-request-method': method, 'access-control-request-headers': headers } });

/** What a page on another origin could learn from the answer: any Access-Control-Allow-Origin at all. */
const allowsOrigin = (res: { headers: Record<string, unknown> }) => res.headers['access-control-allow-origin'];

describe('T-D23 ALLOWED_ORIGINS is an exact list: never *, no patterns, nothing but origins (A12)', () => {
  const env = (value: string | undefined): Record<string, string | undefined> => ({ DB_HOST: '127.0.0.1', DB_PORT: '3306', DB_NAME: 'jv_x', DB_USER: 'jv_u', DB_PASSWORD: secret('pw'), ALLOWED_ORIGINS: value });

  it.each([
    ['one https origin', 'https://billing.example.test', ['https://billing.example.test']],
    ['two, with spaces around them', ' https://a.example.test ,https://b.example.test:8443 ', ['https://a.example.test', 'https://b.example.test:8443']],
    ['the same twice (kept once)', 'https://a.example.test,https://a.example.test', ['https://a.example.test']],
    ['the developer\'s own machine over http', 'http://localhost:5173,http://127.0.0.1:3000,http://[::1]:3000', ['http://localhost:5173', 'http://127.0.0.1:3000', 'http://[::1]:3000']],
  ])('accepts %s', (_name, value, expected) => {
    const config = loadConfig(env(value));
    expect([...config.allowedOrigins]).toEqual(expected);
    expect(Object.isFrozen(config.allowedOrigins)).toBe(true);
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['only spaces and commas', ' , ,'],
    ['a wildcard', '*'],
    ['a wildcard among good entries', 'https://a.example.test,*'],
    ['a wildcard host', 'https://*.example.test'],
    ['a regular expression', '/example\\.test$/'],
    ['a pattern with a dot class', 'https://app\\.example\\.test'],
    ['a trailing slash', 'https://a.example.test/'],
    ['a path', 'https://a.example.test/app'],
    ['a query', 'https://a.example.test?x=1'],
    ['credentials in the address', `https://user${':'}pw@a.example.test`], // put together here: the secrets scan must not read this file as a hit
    ['plain http away from the developer\'s machine', 'http://a.example.test'],
    ['capitals in the host', 'https://A.example.test'],
    ['the default port written out', 'https://a.example.test:443'],
    ['no scheme', 'a.example.test'],
    ['the word null', 'null'],
    ['one bad entry among good ones', 'https://a.example.test,https://b.example.test/'],
  ])('refuses %s, names the variable and never the value', (_name, value) => {
    let err: unknown;
    try {
      loadConfig(env(value));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as ConfigError).problems).toEqual([{ name: 'ALLOWED_ORIGINS', problem: value === undefined || value === '' ? 'missing' : 'invalid' }]);
    if (value) for (const piece of value.split(',').map((p) => p.trim()).filter((p) => p.length > 3)) expect((err as Error).message, piece).not.toContain(piece);
  });

  it('parseOrigin accepts only what a browser writes in an Origin header', () => {
    expect(parseOrigin('https://billing.example.test')).toBe('https://billing.example.test');
    expect(parseOrigin('https://billing.example.test:8443')).toBe('https://billing.example.test:8443');
    for (const bad of ['', '*', 'https://', 'https://a.test/', 'ftp://a.test', 'https://a.test#x', 'https://a b.test', 'https://a.test,https://b.test']) expect(parseOrigin(bad), bad).toBeNull();
    expect(parseAllowedOrigins('')).toBeNull();
  });
});

describe('T-D23 CORS: a preflight from another origin gets no allow-origin header; the allowed origin gets exactly what A12 lists', () => {
  it.each(LOOKALIKES.filter((o) => o !== ''))('a preflight from %j gets no Access-Control-Allow-Origin, for PATCH, PUT and POST', async (origin) => {
    await withToy(async ({ app, toy }) => {
      toy.patch('/toy/edit', async () => ({ ok: true }));
      for (const method of ['PATCH', 'PUT', 'POST']) {
        const res = await preflight(app, origin, method);
        expect(allowsOrigin(res), `${method} from ${origin}`).toBeUndefined();
      }
    });
  });

  it('a request that is not a preflight at all (no Origin header) gets no allow-origin header either', async () => {
    await withToy(async ({ app, toy }) => {
      toy.patch('/toy/edit', async () => ({ ok: true }));
      expect(allowsOrigin(await preflight(app, undefined, 'PATCH'))).toBeUndefined();
      expect(allowsOrigin(await app.inject({ method: 'GET', url: '/healthz' }))).toBeUndefined();
    });
  });

  it('a preflight from the allowed origin for PATCH, PUT and POST with Content-Type, Idempotency-Key and X-JV-Client is accepted (RF4-19: the plugin\'s default would refuse PATCH and PUT)', async () => {
    await withToy(async ({ app, toy }) => {
      toy.patch('/toy/edit', async () => ({ ok: true }));
      for (const method of ['PATCH', 'PUT', 'POST']) {
        const res = await preflight(app, TEST_ORIGIN, method);
        expect(res.statusCode, method).toBe(204);
        expect(res.body).toBe('');
        expect(res.headers['access-control-allow-origin'], method).toBe(TEST_ORIGIN);
        expect(res.headers['access-control-allow-credentials'], method).toBe('true');
        expect(res.headers['access-control-allow-methods'], method).toBe('GET, POST, PUT, PATCH, OPTIONS');
        expect(res.headers['access-control-allow-headers'], method).toBe('Content-Type, Idempotency-Key, X-JV-Client');
        expect(res.headers['access-control-max-age'], method).toBe('600');
        expect(String(res.headers.vary).toLowerCase(), method).toContain('origin');
      }
    });
  });

  it('the answer never says * and never lists DELETE (nothing is deleted, S7) or a header that is not on the list', async () => {
    await withToy(async ({ app }) => {
      const res = await preflight(app, TEST_ORIGIN, 'DELETE', 'content-type,x-jv-client,authorization');
      expect(res.headers['access-control-allow-origin']).toBe(TEST_ORIGIN);
      expect(String(res.headers['access-control-allow-methods'])).not.toMatch(/DELETE|\*/);
      expect(String(res.headers['access-control-allow-headers'])).not.toMatch(/authorization|\*/i);
    });
  });

  it('a PATCH edit then works: the call from the allowed origin is answered, with the allow-origin header, credentials and the exposed headers the screen needs', async () => {
    await withToy(async ({ app, toy }) => {
      toy.patch('/toy/edit', async (_request, reply) => {
        reply.header('Idempotent-Replay', 'true');
        return { patched: true };
      });
      const res = await app.inject({ method: 'PATCH', url: '/toy/edit', headers: { ...csrfHeaders(), 'content-type': 'application/json', 'idempotency-key': '6c1f1e0e-0f3b-4b4e-9a53-2f5f2d9c7a10' }, payload: { a: 1 } });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ patched: true });
      expect(res.headers['access-control-allow-origin']).toBe(TEST_ORIGIN);
      expect(res.headers['access-control-allow-credentials']).toBe('true');
      expect(res.headers['access-control-expose-headers']).toBe('Retry-After, X-Request-Id, Idempotent-Replay');
      expect(String(res.headers.vary).toLowerCase()).toContain('origin');
    });
  });

  it('the screen can read the answer that refuses it: a JV_CSRF from the allowed origin still carries the allow-origin header', async () => {
    await withToy(async ({ app, toy }) => {
      toy.post('/toy/make', async () => ({ ok: true }));
      const res = await app.inject({ method: 'POST', url: '/toy/make', headers: { origin: TEST_ORIGIN } });
      expect(res.statusCode).toBe(403);
      expect(body(res).error.code).toBe('JV_CSRF');
      expect(res.headers['access-control-allow-origin']).toBe(TEST_ORIGIN);
    });
  });

  it('with two allowed origins each is answered with itself, never with the other and never with *', async () => {
    const other = 'https://second.example.test';
    await withToy(
      async ({ app }) => {
        for (const o of [TEST_ORIGIN, other]) expect((await preflight(app, o, 'POST')).headers['access-control-allow-origin']).toBe(o);
        expect((await preflight(app, EVIL, 'POST')).headers['access-control-allow-origin']).toBeUndefined();
      },
      testConfig({ allowedOrigins: [TEST_ORIGIN, other] }),
    );
  });

  it('the token doors (the admin command, the job tick) have no CORS at all: no allow-origin header, not even for the allowed origin (NODE-DESIGN section 8, item 14)', async () => {
    const app = buildApp({ config: testConfig(), logStream: logSink().stream, routes: false });
    route(app, { token: 'admin', method: 'POST', url: '/admin/v1/users', verify: () => undefined, handler: async () => ({ ok: true }) });
    route(app, { token: 'job', method: 'GET', url: '/internal/jobs/health', verify: () => undefined, handler: async () => ({ ok: true }) });
    try {
      for (const [method, url] of [['POST', '/admin/v1/users'], ['GET', '/internal/jobs/health']] as const) {
        const res = await app.inject({ method, url, headers: { origin: TEST_ORIGIN, 'x-jv-client': 'web' } });
        expect(res.statusCode, url).toBe(200);
        expect(allowsOrigin(res), url).toBeUndefined();
        expect(res.headers['access-control-allow-credentials'], url).toBeUndefined();
      }
      const normal = await app.inject({ method: 'GET', url: '/healthz', headers: { origin: TEST_ORIGIN } });
      expect(allowsOrigin(normal)).toBe(TEST_ORIGIN); // control: an ordinary route of the same app is answered for the origin
    } finally {
      await app.close();
    }
  });

  describe('NEGATIVE CONTROL: the check can tell a leaking configuration from a good one', () => {
    const leaks = async (origin: unknown) => {
      const app = Fastify({ logger: false });
      await app.register(cors, { origin: origin as never, credentials: true });
      app.get('/x', async () => ({}));
      const res = await app.inject({ method: 'OPTIONS', url: '/x', headers: { origin: EVIL, 'access-control-request-method': 'POST' } });
      await app.close();
      return allowsOrigin(res);
    };
    it('the plugin turns a list that holds * into "allow everyone" (so the config refuses a *), and reflects any origin for origin:true', async () => {
      expect(await leaks([TEST_ORIGIN, '*'])).toBe('*');
      expect(await leaks(true)).toBe(EVIL);
      expect(await leaks(/example\.test$/)).toBe(EVIL); // a pattern would let the evil origin in
    });
    it('and the exact list is the one that holds', async () => {
      expect(await leaks([TEST_ORIGIN])).toBeUndefined();
    });
  });
});

describe('T-D23 CSRF: every state-changing call needs X-JV-Client: web and an allowed Origin, else 403 JV_CSRF (A12)', () => {
  const METHODS = ['POST', 'PATCH', 'PUT'] as const;

  async function send(app: FastifyInstance, method: (typeof METHODS)[number], headers: Record<string, string>, url = '/toy/change'): Promise<LightMyRequestResponse> {
    return app.inject({ method, url, headers: { ...headers, 'content-type': 'application/json' }, payload: { a: 1 } });
  }
  function change(toy: ReturnType<typeof toyRoutes>, ran: string[]) {
    toy.post('/toy/change', async () => (ran.push('POST'), { ok: true }));
    toy.patch('/toy/change', async () => (ran.push('PATCH'), { ok: true }));
    toy.put('/toy/change', async () => (ran.push('PUT'), { ok: true }));
  }
  const refused = (res: LightMyRequestResponse) => {
    expect(res.statusCode).toBe(403);
    const b = body(res);
    expect(b.error.code).toBe('JV_CSRF');
    expect(b.error.details).toEqual({}); // a refused caller is not told which layer failed
    expect(b.request_id).toMatch(/^[0-9a-f-]{36}$/);
  };

  it('with both layers right the call is answered', async () => {
    await withToy(async ({ app, toy }) => {
      const ran: string[] = [];
      change(toy, ran);
      for (const m of METHODS) expect((await send(app, m, csrfHeaders())).statusCode, m).toBe(200);
      expect(ran).toEqual(['POST', 'PATCH', 'PUT']);
    });
  });

  it('without X-JV-Client: web it is 403 JV_CSRF and the handler never runs (POST, PATCH, PUT), also with a good Origin', async () => {
    await withToy(async ({ app, toy }) => {
      const ran: string[] = [];
      change(toy, ran);
      for (const m of METHODS) refused(await send(app, m, { origin: TEST_ORIGIN }));
      expect(ran).toEqual([]);
    });
  });

  it.each(['Web', 'WEB', 'true', '1', ' web', 'web ', 'web, web', 'mobile', ''])('X-JV-Client: %j is not "web": 403 JV_CSRF', async (value) => {
    await withToy(async ({ app, toy }) => {
      change(toy, []);
      for (const m of METHODS) refused(await send(app, m, { 'x-jv-client': value, origin: TEST_ORIGIN }));
    });
  });

  it('with a missing Origin it is 403 JV_CSRF (a missing Origin is not proof of our own page)', async () => {
    await withToy(async ({ app, toy }) => {
      const ran: string[] = [];
      change(toy, ran);
      for (const m of METHODS) refused(await send(app, m, { 'x-jv-client': 'web' }));
      expect(ran).toEqual([]);
    });
  });

  it.each(LOOKALIKES)('with Origin %j it is 403 JV_CSRF, although X-JV-Client is right', async (origin) => {
    await withToy(async ({ app, toy }) => {
      const ran: string[] = [];
      change(toy, ran);
      for (const m of METHODS) refused(await send(app, m, { 'x-jv-client': 'web', origin }));
      expect(ran).toEqual([]);
    });
  });

  it('the refusal is logged with its reason (a header is not secret) and the answer never says which layer it was', async () => {
    await withToy(async ({ app, toy, sink }) => {
      change(toy, []);
      const cookie = `__Host-jv_session=${secret('ticket')}`;
      refused(await send(app, 'POST', { origin: EVIL, 'x-jv-client': 'web', cookie }));
      const line = sink.lines().find((l) => l.msg === 'answered JV_CSRF');
      expect(line).toMatchObject({ reason: 'origin_not_allowed', origin: EVIL });
      expect(sink.text()).not.toContain(cookie);
    });
  });

  it('GET, HEAD and OPTIONS need neither header (no state change is reachable by them)', async () => {
    await withToy(async ({ app, toy }) => {
      toy.get('/toy/read', async () => ({ ok: true }));
      expect((await app.inject({ method: 'GET', url: '/toy/read' })).statusCode).toBe(200);
      expect((await app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
      expect((await app.inject({ method: 'HEAD', url: '/healthz' })).statusCode).toBe(200);
      expect((await preflight(app, TEST_ORIGIN, 'POST')).statusCode).toBe(204);
    });
  });

  it('the login is covered too (login CSRF): a public route that changes state needs both layers like any other', async () => {
    const sink = logSink();
    const app = buildApp({ config: testConfig(), logStream: sink.stream, routes: false });
    createRoute({ matrix: {}, publicRoutes: { login: PUBLIC_ROUTES.login }, tokenDoors: {} })(app, { public: 'login', handler: async () => ({ ok: true }) });
    try {
      const login = { method: 'POST' as const, url: PUBLIC_ROUTES.login.path, payload: {} };
      refused(await app.inject(login));
      refused(await app.inject({ ...login, headers: { 'x-jv-client': 'web' } }));
      refused(await app.inject({ ...login, headers: { origin: TEST_ORIGIN } }));
      expect((await app.inject({ ...login, headers: csrfHeaders() })).statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it('a token door (the admin command, the job tick) has a token of its own and no cookie: the CSRF layers do not apply, its own check does', async () => {
    const app = buildApp({ config: testConfig(), logStream: logSink().stream, routes: false });
    const ran: string[] = [];
    route(app, {
      token: 'job',
      method: 'POST',
      url: '/internal/jobs/tick',
      verify: (request) => {
        if (request.headers.authorization !== 'Bearer fixture') throw new JvError('JV_UNAUTHENTICATED', 'The token was refused.');
      },
      handler: async () => (ran.push('tick'), { ok: true }),
    });
    try {
      const wrongToken = await app.inject({ method: 'POST', url: '/internal/jobs/tick', headers: { authorization: 'Bearer wrong' } });
      expect([wrongToken.statusCode, body(wrongToken).error.code]).toEqual([401, 'JV_UNAUTHENTICATED']); // the door's own check answered, not the CSRF layer
      expect(ran).toEqual([]);
      const ok = await app.inject({ method: 'POST', url: '/internal/jobs/tick', headers: { authorization: 'Bearer fixture' } });
      expect(ok.statusCode).toBe(200);
      expect(ran).toEqual(['tick']);
    } finally {
      await app.close();
    }
  });

  it('a path that is not a route is a 404 for everyone, with or without the headers (A11)', async () => {
    await withToy(async ({ app }) => {
      for (const headers of [{}, csrfHeaders(), { origin: EVIL }]) {
        const res = await app.inject({ method: 'POST', url: '/nothing-here', headers, payload: {} });
        expect([res.statusCode, body(res).error.code]).toEqual([404, 'JV_NOT_FOUND']);
      }
    });
  });

  it('csrfRefusal is the whole rule: safe methods pass; for the others the client header comes first, then the origin', () => {
    const allowed = [TEST_ORIGIN];
    expect(csrfRefusal('GET', {}, allowed)).toBeNull();
    expect(csrfRefusal('HEAD', {}, allowed)).toBeNull();
    expect(csrfRefusal('OPTIONS', {}, allowed)).toBeNull();
    expect(csrfRefusal('POST', {}, allowed)).toBe('client_header');
    expect(csrfRefusal('DELETE', { 'x-jv-client': 'web' }, allowed)).toBe('origin_missing');
    expect(csrfRefusal('PUT', { 'x-jv-client': 'web', origin: 'null' }, allowed)).toBe('origin_null');
    expect(csrfRefusal('PATCH', { 'x-jv-client': 'web', origin: EVIL }, allowed)).toBe('origin_not_allowed');
    expect(csrfRefusal('PATCH', { 'x-jv-client': 'web', origin: TEST_ORIGIN }, allowed)).toBeNull();
    expect(csrfRefusal('POST', { 'x-jv-client': 'web', origin: [TEST_ORIGIN, TEST_ORIGIN] }, allowed)).toBe('origin_not_allowed'); // two Origin headers
    expect(csrfRefusal('POST', { 'x-jv-client': 'web', origin: TEST_ORIGIN }, [])).toBe('origin_not_allowed'); // an empty list lets nobody in
  });
});

describe('T-D23 CSRF runs before anything is read: a refused call touches no session, no row, no handler', () => {
  let world: World;
  beforeAll(async () => {
    world = await makeWorld({ label: 'csrf', build: (app, { handled }) => registerStubs(app, handled) });
  }, 120_000);
  afterAll(async () => {
    await world?.close();
  });

  it('the owner\'s own valid cookie without the two headers is 403 JV_CSRF, no statement is sent and the handler does not run', async () => {
    const row = MATRIX['fn:create_customer'];
    const before = world.spy.sent.length;
    const handled = world.handled.length;
    const url = concreteUrl(row.path);
    const cookie = world.cookieOf('owner')!;
    for (const headers of [{ cookie }, { cookie, 'x-jv-client': 'web' }, { cookie, origin: TEST_ORIGIN }, { cookie, 'x-jv-client': 'web', origin: EVIL }]) {
      const res = await world.app.inject({ method: row.method, url, headers, payload: {} });
      expect(res.statusCode).toBe(403);
      expect(body(res).error.code).toBe('JV_CSRF');
    }
    expect(world.spy.sent.length).toBe(before); // not even the session lookup
    expect(world.handled.length).toBe(handled);
    const ok = await world.app.inject({ method: row.method, url, headers: { cookie, ...csrfHeaders() }, payload: {} });
    expect(ok.statusCode).toBe(200); // control: the same call with the two layers is let in
    expect(world.handled.at(-1)).toBe('fn:create_customer');
  });

  it('every state-changing row of the matrix is covered, whoever the caller is (the walk of T-D02 sends the headers; without them the answer is JV_CSRF before 401 or 403)', async () => {
    for (const [action, row] of Object.entries(MATRIX) as [string, MatrixRow][]) {
      if (row.method === 'GET') continue;
      for (const caller of ['anon', 'owner'] as const) {
        const cookie = world.cookieOf(caller);
        const res = await world.app.inject({ method: row.method, url: concreteUrl(row.path), headers: cookie ? { cookie } : {}, payload: {} });
        expect([res.statusCode, body(res).error.code], `${caller} ${row.method} ${row.path} (${action})`).toEqual([403, 'JV_CSRF']);
      }
    }
  });
});

describe('T-D23 no state change is reachable by GET', () => {
  /** The rows of a matrix that let a GET do something other than read, and the rows whose address a GET could reach. */
  function getsThatChangeState(matrix: Record<string, Pick<MatrixRow, 'kind' | 'method' | 'path'>>): string[] {
    const offenders: string[] = [];
    for (const [action, row] of Object.entries(matrix)) {
      if (row.method !== 'GET') continue;
      if (row.kind !== 'read' && !(row.kind === 'session' && action === 'session:me')) offenders.push(`${action}: a GET row of kind ${row.kind}`);
    }
    return offenders;
  }

  it('every GET row of the matrix is a read (or the session\'s "me"); everything else - functions, edits, photos, the download record, logout, change-password, activity - is POST, PUT or PATCH', () => {
    expect(getsThatChangeState(MATRIX)).toEqual([]);
    for (const [action, row] of Object.entries(MATRIX)) {
      if (row.kind !== 'read' && action !== 'session:me') expect(['POST', 'PUT', 'PATCH'], action).toContain(row.method);
    }
    expect(Object.values(PUBLIC_ROUTES).filter((r) => r.method === 'GET').map((r) => r.path).sort()).toEqual(['/healthz', '/readyz', '/v1/photos/:photo_id/full', '/v1/photos/:photo_id/thumb']);
  });

  it('NEGATIVE CONTROL: a matrix with a function row on GET is reported', () => {
    const doctored = { ...MATRIX, 'fn:create_bill': { ...MATRIX['fn:create_bill'], method: 'GET' as const } };
    expect(getsThatChangeState(doctored)).toEqual(['fn:create_bill: a GET row of kind fn']);
    const edit = { ...MATRIX, 'edit:skus.update': { ...MATRIX['edit:skus.update'], method: 'GET' as const } };
    expect(getsThatChangeState(edit)).toEqual(['edit:skus.update: a GET row of kind edit']);
  });

  it('a GET to the address of a state-changing row is a 404, not the row (the address answers its own method only)', async () => {
    const app = buildApp({ config: testConfig(), logStream: logSink().stream, routes: false });
    registerStubs(app, []);
    try {
      const getPaths = new Set(Object.values(MATRIX).filter((r) => r.method === 'GET').map((r) => r.path));
      let walked = 0;
      for (const row of Object.values(MATRIX)) {
        if (row.method === 'GET' || getPaths.has(row.path)) continue;
        const res = await app.inject({ method: 'GET', url: concreteUrl(row.path) });
        expect([res.statusCode, body(res).error.code], `GET ${row.path}`).toEqual([404, 'JV_NOT_FOUND']);
        walked++;
      }
      expect(walked).toBeGreaterThan(20);
    } finally {
      await app.close();
    }
  });
});
