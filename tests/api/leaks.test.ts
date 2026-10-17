import { randomUUID } from 'node:crypto';
import net from 'node:net';
import Fastify, { type FastifyInstance, type LightMyRequestResponse } from 'fastify';
import pino from 'pino';
import { z } from 'zod';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app';
import { type DbPool, createDbPool } from '../../src/db/pool';
import { TX_LIMITS } from '../../src/db/tx';
import { SESSION_SETTINGS } from '../../src/db/pool';
import { MATRIX, PUBLIC_ROUTES } from '../../src/permissions/matrix';
import { createRoute, route } from '../../src/permissions/route';
import { SESSION_COOKIE, newTicket } from '../../src/permissions/session';
import { handlerTimeoutFor, requestLimits, TICK_PATH } from '../../src/security/requestLimits';
import * as wire from '../../src/wire/zod';
import { type Scratch, scratchDatabase, sleep } from '../helpers';
import { TEST_ORIGIN, csrfHeaders, freePort, logSink, secret, testConfig, toyRoutes } from './support';
import { dbError } from './tx-support';

// T-D28 (A14, API07): nothing leaks. JV_INTERNAL carries no SQL or stack; every answer carries Cache-Control: no-store and X-Request-Id (the photo files excepted); the security headers are
// there; a body full of marker strings is absent from the log; the body limits, the unknown-key rule and the timers; /healthz and /readyz say only {"ok":true|false}.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const body = (res: { body: string }) => JSON.parse(res.body) as { error: { code: string; message: string; details: Record<string, unknown> }; request_id: string };

async function withToy<T>(fn: (c: { app: FastifyInstance; toy: ReturnType<typeof toyRoutes>; sink: ReturnType<typeof logSink> }) => Promise<T>, options: Partial<Parameters<typeof buildApp>[0]> = {}): Promise<T> {
  const sink = logSink();
  const app = buildApp({ config: testConfig(), logStream: sink.stream, ...options });
  try {
    return await fn({ app, toy: toyRoutes(app), sink });
  } finally {
    await app.close();
  }
}

/** A toy route with a body schema (a table of its own, like toyRoutes). */
function strictToy(app: FastifyInstance, method: 'POST' | 'PUT' | 'PATCH', path: string, schema?: z.ZodType) {
  const name = `strict-${app.routeTable.length}`;
  createRoute({ matrix: {}, publicRoutes: { [name]: { method, path } }, tokenDoors: {} })(app, { public: name, body: schema, handler: ({ body: b }) => ({ got: b }) });
}

// ------------------------------------------------------------------ every answer carries the headers

describe('T-D28 every answer carries Cache-Control: no-store and X-Request-Id, and the security headers (A14)', () => {
  async function answers(app: FastifyInstance, toy: ReturnType<typeof toyRoutes>): Promise<[string, LightMyRequestResponse][]> {
    toy.get('/toy/read', async () => ({ rows: [] }));
    toy.post('/toy/boom', async () => {
      throw new Error('unexpected');
    });
    strictToy(app, 'POST', '/toy/strict', wire.strictObject({ a: z.string() }));
    return [
      ['a data read', await app.inject({ method: 'GET', url: '/toy/read' })],
      ['a 404', await app.inject({ method: 'GET', url: '/nothing-here' })],
      ['a refused input (422)', await app.inject({ method: 'POST', url: '/toy/strict', headers: csrfHeaders(), payload: { b: 1 } })],
      ['an unexpected error (500)', await app.inject({ method: 'POST', url: '/toy/boom', headers: csrfHeaders(), payload: {} })],
      ['a CSRF refusal (403)', await app.inject({ method: 'POST', url: '/toy/boom', payload: {} })],
      ['a too large body (413)', await app.inject({ method: 'POST', url: '/toy/strict', headers: csrfHeaders(), payload: JSON.stringify({ a: 'x'.repeat(requestLimits.bodyBytes) }) })],
      ['a preflight (204)', await app.inject({ method: 'OPTIONS', url: '/toy/read', headers: { origin: TEST_ORIGIN, 'access-control-request-method': 'POST' } })],
      ['/healthz', await app.inject({ method: 'GET', url: '/healthz' })],
    ];
  }

  it('data, errors, refusals, preflights and the health route all say no-store and carry the request id; the id of an error answer is the one in its body', async () => {
    await withToy(async ({ app, toy }) => {
      for (const [name, res] of await answers(app, toy)) {
        expect(res.headers['cache-control'], name).toBe('no-store');
        const id = String(res.headers['x-request-id']);
        expect(id, name).toMatch(UUID);
        if (res.statusCode >= 400 && res.headers['content-type']?.toString().includes('json')) expect(body(res).request_id, name).toBe(id);
      }
    });
  });

  it('the id is the API\'s own: a request id sent by the client is not taken over', async () => {
    await withToy(async ({ app, toy }) => {
      toy.get('/toy/read', async () => ({}));
      const mine = randomUUID();
      const res = await app.inject({ method: 'GET', url: '/toy/read', headers: { 'x-request-id': mine } });
      expect(res.headers['x-request-id']).toMatch(UUID);
      expect(res.headers['x-request-id']).not.toBe(mine);
    });
  });

  it('the standard security headers of helmet are set, with a policy that suits an API, and nothing says what the server is', async () => {
    await withToy(async ({ app, toy }) => {
      toy.get('/toy/read', async () => ({}));
      const res = await app.inject({ method: 'GET', url: '/toy/read' });
      const h = res.headers;
      expect(h['x-content-type-options']).toBe('nosniff');
      expect(String(h['strict-transport-security'])).toMatch(/^max-age=\d+/);
      expect(String(h['content-security-policy'])).toContain("default-src 'none'");
      expect(String(h['content-security-policy'])).toContain("frame-ancestors 'none'");
      expect(h['referrer-policy']).toBe('no-referrer');
      expect(h['x-frame-options']).toBeDefined();
      expect(h['cross-origin-resource-policy']).toBe('same-origin');
      expect(h['cross-origin-opener-policy']).toBe('same-origin');
      expect(h['x-dns-prefetch-control']).toBe('off');
      expect(h['x-powered-by']).toBeUndefined();
      expect(h.server).toBeUndefined();
    });
  });

  it('error answers carry them too (the 404 and the 500 of the same app)', async () => {
    await withToy(async ({ app, toy }) => {
      toy.post('/toy/boom', async () => {
        throw new Error('x');
      });
      for (const res of [await app.inject({ method: 'GET', url: '/nothing-here' }), await app.inject({ method: 'POST', url: '/toy/boom', headers: csrfHeaders() })]) {
        expect(res.headers['x-content-type-options']).toBe('nosniff');
        expect(res.headers['strict-transport-security']).toBeDefined();
      }
    });
  });

  it('the photo files are the one exception: a photo that is found keeps the caching its own route sets and may be shown by the website; one that is not found is not cached', async () => {
    const sink = logSink();
    const app = buildApp({ config: testConfig(), logStream: sink.stream, routes: false });
    const photo = (found: boolean) =>
      createRoute({ matrix: {}, publicRoutes: { 'photo-full': PUBLIC_ROUTES['photo-full'] }, tokenDoors: {} })(app, {
        public: 'photo-full',
        handler: ({ request, reply }) => {
          if (!found) return reply.code(404).send({ error: { code: 'JV_NOT_FOUND', message: 'There is nothing at this address.', details: {} }, request_id: request.id });
          reply.header('Cache-Control', 'public, max-age=31536000, immutable').header('Content-Type', 'image/jpeg');
          return reply.send(Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
        },
      });
    photo(true);
    try {
      const url = PUBLIC_ROUTES['photo-full'].path.replace(':photo_id', randomUUID());
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(200);
      expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable');
      expect(res.headers['cross-origin-resource-policy']).toBe('cross-origin');
      expect(res.headers['x-request-id']).toMatch(UUID);
      expect(res.headers['x-content-type-options']).toBe('nosniff');
    } finally {
      await app.close();
    }
    const missing = buildApp({ config: testConfig(), logStream: logSink().stream, routes: false });
    createRoute({ matrix: {}, publicRoutes: { 'photo-full': PUBLIC_ROUTES['photo-full'] }, tokenDoors: {} })(missing, {
      public: 'photo-full',
      handler: ({ request, reply }) => reply.code(404).send({ error: { code: 'JV_NOT_FOUND', message: 'There is nothing at this address.', details: {} }, request_id: request.id }),
    });
    try {
      const res = await missing.inject({ method: 'GET', url: PUBLIC_ROUTES['photo-full'].path.replace(':photo_id', randomUUID()) });
      expect(res.statusCode).toBe(404);
      expect(res.headers['cache-control']).toBe('no-store');
    } finally {
      await missing.close();
    }
  });
});

// ------------------------------------------------------------------ JV_INTERNAL carries no SQL, stack or table name

describe('T-D28 JV_INTERNAL carries no SQL, stack or table name; nothing from the server reaches the client (A14)', () => {
  const FORBIDDEN = /select|insert|update|delete|from |where|customers|bills|sys_|table|column|syntax|sql|errno|ER_|stack|node_modules|\.ts\b|\.js\b|at .*\(|\/Users\//i;
  const GENERIC = { error: { code: 'JV_INTERNAL', message: 'Something unexpected went wrong.', details: {} } };

  const throwers: [string, () => Error][] = [
    ['a driver error that quotes the statement', () => dbError(1064, 'ER_PARSE_ERROR', "You have an error in your SQL syntax near 'SELECT * FROM customers WHERE mobile = 9999999999'", { sql: 'SELECT * FROM customers WHERE mobile = 9999999999' })],
    ['a missing table', () => dbError(1146, 'ER_NO_SUCH_TABLE', "Table 'jv_prod.customers' doesn't exist")],
    ['a foreign key failure that names the constraint', () => dbError(1452, 'ER_NO_REFERENCED_ROW_2', 'Cannot add or update a child row: a foreign key constraint fails (`jv_prod`.`bills`, CONSTRAINT `fk_bills_customer` FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`))')],
    ['a duplicate on a key that is not a business key', () => dbError(1062, 'ER_DUP_ENTRY', "Duplicate entry 'INV-2026-0001' for key 'uq_bills_no'")],
    ['a bug in the code (TypeError with a stack)', () => new TypeError("Cannot read properties of undefined (reading 'id')")],
    ['an error with a cause chain', () => new Error('outer', { cause: dbError(1146, 'ER_NO_SUCH_TABLE', "Table 'jv_prod.sessions' doesn't exist") })],
  ];

  it.each(throwers)('%s is answered with the one generic body and nothing else', async (_name, make) => {
    await withToy(async ({ app, toy }) => {
      toy.post('/toy/boom', async () => {
        throw make();
      });
      const res = await app.inject({ method: 'POST', url: '/toy/boom', headers: csrfHeaders(), payload: {} });
      expect(res.statusCode).toBe(500);
      const b = body(res);
      expect({ error: b.error }).toEqual(GENERIC);
      expect(Object.keys(b).sort()).toEqual(['error', 'request_id']);
      expect(res.body).not.toMatch(FORBIDDEN);
      for (const [name, value] of Object.entries(res.headers)) expect(`${name}: ${String(value)}`, name).not.toMatch(/select|sql|customers|stack/i);
    });
  });

  it('the busy and unavailable answers are as plain: a lock timeout, a lost connection, a refused login to the database', async () => {
    await withToy(async ({ app, toy }) => {
      toy.post('/toy/lock', async () => {
        throw dbError(1205, 'ER_LOCK_WAIT_TIMEOUT', 'Lock wait timeout exceeded; try restarting transaction (UPDATE customers SET ...)');
      });
      toy.post('/toy/denied', async () => {
        throw dbError(1045, 'ER_ACCESS_DENIED_ERROR', "Access denied for user 'jv_prod'@'10.0.0.8' (using password: YES)");
      });
      for (const [url, status, code] of [['/toy/lock', 503, 'JV_BUSY'], ['/toy/denied', 503, 'JV_UNAVAILABLE']] as const) {
        const res = await app.inject({ method: 'POST', url, headers: csrfHeaders(), payload: {} });
        expect([res.statusCode, body(res).error.code], url).toEqual([status, code]);
        expect(res.body, url).not.toMatch(/customers|update|access denied|jv_prod|10\.0\.0\.8|password/i);
      }
    });
  });

  it('the stack and the statement are in the LOG of the error, where the person fixing it needs them (control: the test can see them there)', async () => {
    await withToy(async ({ app, toy, sink }) => {
      toy.post('/toy/boom', async () => {
        throw dbError(1146, 'ER_NO_SUCH_TABLE', "Table 'jv_prod.customers' doesn't exist");
      });
      await app.inject({ method: 'POST', url: '/toy/boom', headers: csrfHeaders(), payload: {} });
      expect(sink.text()).toMatch(/customers/);
    });
  });
});

// ------------------------------------------------------------------ the log holds no secret and no customer data

describe('T-D28 a body full of marker strings is absent from the log (A14)', () => {
  const markers = () => ({
    password: secret('password'),
    pan: secret('pan'),
    mobile: secret('mobile'),
    gst: secret('gst'),
    email: secret('email'),
    cookie: newTicket(), // shaped like a real ticket, so that the session lookup is really tried
    bearer: secret('bearer'),
    query: secret('query'),
    referer: secret('referer'),
    forwarded: secret('forwarded'),
  });

  /** One body of every kind, to every kind of answer. */
  async function post(app: FastifyInstance, m: ReturnType<typeof markers>) {
    const payload = { password: m.password, new_password: m.password, pan: m.pan, mobile: m.mobile, gstin: m.gst, email: m.email, customer: { name: m.pan, phone: m.mobile, pan: m.pan }, items: [{ note: m.gst }] };
    const headers: Record<string, string> = { ...csrfHeaders(), cookie: `${SESSION_COOKIE}=${m.cookie}`, authorization: `Bearer ${m.bearer}`, referer: `https://x.example.test/?q=${m.referer}`, 'x-forwarded-for': m.forwarded };
    const query = `?mobile=${m.mobile}&pan=${m.pan}&q=${m.query}`;
    const sent: [string, LightMyRequestResponse][] = [];
    const send = async (name: string, url: string, init: { headers?: Record<string, string>; payload?: string } = {}) =>
      void sent.push([name, await app.inject({ method: 'POST', url: `${url}${query}`, headers: init.headers ?? headers, payload: init.payload ?? payload })]);
    const json = { ...headers, 'content-type': 'application/json' };
    await send('a call that works', '/toy/ok');
    await send('a refused body (422)', '/toy/strict');
    await send('a call that fails unexpectedly (500)', '/toy/boom');
    await send('a body that is not JSON (400)', '/toy/ok', { headers: json, payload: `{"password":"${m.password}","pan":"${m.pan}` });
    await send('a content type that is not accepted (415)', '/toy/ok', { headers: { ...headers, 'content-type': 'application/x-www-form-urlencoded' }, payload: `password=${m.password}&pan=${m.pan}` });
    await send('a body that is too large (413)', '/toy/ok', { headers: json, payload: `{"password":"${m.password}","pad":"${'x'.repeat(requestLimits.bodyBytes)}"}` });
    await send('a CSRF refusal (403)', '/toy/ok', { headers: { cookie: headers.cookie, authorization: headers.authorization, referer: headers.referer, 'x-forwarded-for': headers['x-forwarded-for'] } });
    await send('a path that is not a route (404)', '/v1/not-a-route');
    await send('a session route with nowhere to look the cookie up (503)', MATRIX['fn:create_customer'].path);
    sent.push(['a GET with the markers in its query', await app.inject({ method: 'GET', url: `/toy/read${query}`, headers })]);
    sent.push(['a preflight with the markers in its query', await app.inject({ method: 'OPTIONS', url: `/toy/read${query}`, headers: { origin: TEST_ORIGIN, 'access-control-request-method': 'POST' } })]);
    return sent;
  }

  function build() {
    const sink = logSink();
    const app = buildApp({ config: testConfig({ logLevel: 'trace' }), logStream: sink.stream, routes: false }); // API19: the real route of X6 is registered now, and the stub below stands in for any row
    const toy = toyRoutes(app);
    toy.post('/toy/ok', async () => ({ ok: true }));
    toy.post('/toy/boom', async () => {
      throw new Error('unexpected');
    });
    toy.get('/toy/read', async () => ({ ok: true }));
    strictToy(app, 'POST', '/toy/strict', wire.strictObject({ nothing: z.string() }));
    route(app, { action: 'fn:create_customer', handler: async () => ({ ok: true }) });
    return { app, sink };
  }

  it('the password, the PAN, the mobile number, the GST number, the e-mail, the cookie, the token and a query string never reach the log, whatever the answer was', async () => {
    const m = markers();
    const { app, sink } = build();
    try {
      const sent = await post(app, m);
      const statuses = Object.fromEntries(sent.map(([name, res]) => [name, res.statusCode]));
      expect(statuses).toMatchObject({
        'a call that works': 200,
        'a refused body (422)': 422,
        'a call that fails unexpectedly (500)': 500,
        'a body that is not JSON (400)': 422,
        'a content type that is not accepted (415)': 415,
        'a body that is too large (413)': 413,
        'a CSRF refusal (403)': 403,
        'a path that is not a route (404)': 404,
        'a session route with nowhere to look the cookie up (503)': 503,
      });
      expect(sink.lines().length).toBeGreaterThan(sent.length); // the requests were logged at all
      const text = sink.text();
      for (const [name, value] of Object.entries(m)) expect(text, name).not.toContain(value);
      for (const [name, res] of sent) for (const [what, value] of Object.entries(m)) expect(res.body, `${name} answers with ${what}`).not.toContain(value);
    } finally {
      await app.close();
    }
  });

  it('what is logged about a request is its method and its path: the request line has no query string', async () => {
    const m = markers();
    const { app, sink } = build();
    try {
      await app.inject({ method: 'GET', url: `/toy/read?mobile=${m.mobile}&q=${m.query}` });
      const line = sink.lines().find((l) => l.msg === 'incoming request')!;
      expect(line.req).toMatchObject({ method: 'GET', url: '/toy/read' });
    } finally {
      await app.close();
    }
  });

  it('NEGATIVE CONTROL: a logger with Fastify\'s own request serializer would hold the query string (so the test above can fail)', async () => {
    const m = markers();
    const sink = logSink();
    const plain = Fastify({ loggerInstance: pino(sink.stream) });
    plain.get('/x', async () => ({}));
    await plain.inject({ method: 'GET', url: `/x?mobile=${m.mobile}` });
    expect(sink.text()).toContain(m.mobile);
    await plain.close();
  });

  it('the shapes of a mobile number, a PAN, a GST number and an e-mail address are cut out of an error that is logged, wherever a careless message put them', async () => {
    const sink = logSink();
    const app = buildApp({ config: testConfig(), logStream: sink.stream });
    const careless = 'no customer 9876543210 / +91 98765 43210 / ABCDE1234F / 27ABCDE1234F1Z5 / siddhi@example.test';
    toyRoutes(app).post('/toy/careless', async () => {
      throw new Error(careless);
    });
    toyRoutes(app).post('/toy/careless-db', async () => {
      throw dbError(1366, 'ER_TRUNCATED_WRONG_VALUE_FOR_FIELD', `Incorrect decimal value: '9876543210' for column 'amount' at row 1 (${careless})`);
    });
    try {
      for (const url of ['/toy/careless', '/toy/careless-db']) expect((await app.inject({ method: 'POST', url, headers: csrfHeaders(), payload: {} })).statusCode).toBe(500);
      for (const piece of ['9876543210', '98765 43210', 'ABCDE1234F', '27ABCDE1234F1Z5', 'siddhi@example.test']) expect(sink.text(), piece).not.toContain(piece);
      expect(sink.text()).toContain('no customer'); // the rest of the message is still there, for the person who reads the log
    } finally {
      await app.close();
    }
  });
});

// ------------------------------------------------------------------ limits on what comes in

describe('T-D28 limits on a request: 1 MiB, a photo 2 MiB and 16 KiB, unknown keys refused (A14)', () => {
  /** A JSON body of exactly n bytes. */
  const jsonOf = (n: number) => JSON.stringify({ pad: 'x'.repeat(n - 10) });
  const send = (app: FastifyInstance, method: 'POST' | 'PUT', url: string, payload: string) => app.inject({ method, url, headers: { ...csrfHeaders(), 'content-type': 'application/json' }, payload });

  it('the application\'s limit is 1 MiB: a body of exactly 1 MiB is read, one byte more is 413 JV_PAYLOAD_TOO_LARGE in the S8 body', async () => {
    await withToy(async ({ app, toy }) => {
      toy.post('/toy/take', async () => ({ ok: true }));
      expect(app.initialConfig.bodyLimit).toBe(1024 * 1024);
      expect((await send(app, 'POST', '/toy/take', jsonOf(1024 * 1024))).statusCode).toBe(200);
      const big = await send(app, 'POST', '/toy/take', jsonOf(1024 * 1024 + 1));
      expect([big.statusCode, body(big).error.code]).toEqual([413, 'JV_PAYLOAD_TOO_LARGE']);
    });
  });

  it('the photo upload (PUT of the matrix) takes 2 MiB and 16 KiB; every other route keeps 1 MiB', async () => {
    await withToy(async ({ app, toy }) => {
      const photo = MATRIX['photo:upload'];
      createRoute({ matrix: {}, publicRoutes: { photo: { method: photo.method, path: photo.path } }, tokenDoors: {} })(app, { public: 'photo', body: z.unknown(), handler: () => ({ ok: true }) });
      toy.put('/toy/other', async () => ({ ok: true }));
      const url = photo.path.replace(':design_id', randomUUID()).replace(':photo_id', randomUUID());
      const limit = 2 * 1024 * 1024 + 16 * 1024;
      expect(requestLimits.photoBodyBytes).toBe(limit);
      expect((await send(app, 'PUT', url, jsonOf(1024 * 1024 + 5))).statusCode).toBe(200); // more than the ordinary limit
      expect((await send(app, 'PUT', url, jsonOf(limit))).statusCode).toBe(200);
      const big = await send(app, 'PUT', url, jsonOf(limit + 1));
      expect([big.statusCode, body(big).error.code]).toEqual([413, 'JV_PAYLOAD_TOO_LARGE']);
      const other = await send(app, 'PUT', '/toy/other', jsonOf(1024 * 1024 + 5));
      expect(other.statusCode).toBe(413);
    }, { routes: false }); // the toy stands at the address of the real upload (API17), so the application's own routes are left out
  });

  it('unknown JSON keys are refused: at the top, inside a nested object, and in a call that takes no body at all', async () => {
    await withToy(async ({ app }) => {
      strictToy(app, 'POST', '/toy/strict', wire.strictObject({ a: z.string(), inner: wire.strictObject({ b: z.string() }) }));
      strictToy(app, 'PATCH', '/toy/nobody');
      const ok = await app.inject({ method: 'POST', url: '/toy/strict', headers: csrfHeaders(), payload: { a: 'x', inner: { b: 'y' } } });
      expect(ok.statusCode).toBe(200);
      for (const payload of [{ a: 'x', inner: { b: 'y' }, extra: 1 }, { a: 'x', inner: { b: 'y', extra: 1 } }]) {
        const res = await app.inject({ method: 'POST', url: '/toy/strict', headers: csrfHeaders(), payload });
        expect([res.statusCode, body(res).error.code], JSON.stringify(payload)).toEqual([422, 'JV_INVALID_INPUT']);
      }
      expect((await app.inject({ method: 'PATCH', url: '/toy/nobody', headers: csrfHeaders(), payload: { a: 1 } })).statusCode).toBe(422);
    });
  });

  it('receiving a request may take 30 seconds (Fastify\'s requestTimeout); the handler timers are 25 s, 30 s for the login and 50 s for the tick', async () => {
    const app = buildApp({ config: testConfig(), logStream: logSink().stream });
    try {
      expect((app.initialConfig as Record<string, unknown>).handlerTimeout).toBe(25_000);
      expect(app.server.requestTimeout).toBe(30_000);
    } finally {
      await app.close();
    }
  });
});

// ------------------------------------------------------------------ the timers

describe('T-D28 the handler timers answer 503 JV_BUSY after the work has stopped, never before (A14, S12)', () => {
  it('each timer is longer than the work it guards: the transaction deadline plus the statement limit, so by then the work has stopped', () => {
    const work = TX_LIMITS.deadlineMs + SESSION_SETTINGS.maxStatementTime * 1000; // 12 s + 8 s
    expect(work).toBe(20_000);
    expect(requestLimits.handlerMs).toBe(25_000);
    expect(requestLimits.loginMs).toBe(30_000);
    expect(requestLimits.tickMs).toBe(50_000);
    expect(requestLimits.requestMs).toBe(30_000);
    expect(requestLimits.handlerMs).toBeGreaterThan(work);
    expect(requestLimits.loginMs).toBeGreaterThan(work);
    expect(requestLimits.tickMs).toBeGreaterThan(TX_LIMITS.deadlineMs + 20_000); // the tick's own statement limit is 20 s (I8)
    expect(requestLimits.tickMs).toBeLessThan(60_000); // Hostinger's front end cuts a request at about 60 s whatever the app does
  });

  it('the login route has 30 s, the job tick 50 s and every other route 25 s', () => {
    const timers = { requestMs: 1, handlerMs: 25_000, loginMs: 30_000, tickMs: 50_000 };
    expect(handlerTimeoutFor(timers, PUBLIC_ROUTES.login.method, PUBLIC_ROUTES.login.path)).toBe(30_000);
    expect(handlerTimeoutFor(timers, 'POST', TICK_PATH)).toBe(50_000);
    expect(TICK_PATH).toBe('/internal/jobs/tick');
    expect(handlerTimeoutFor(timers, 'GET', '/healthz')).toBe(25_000);
    expect(handlerTimeoutFor(timers, 'POST', MATRIX['fn:create_bill'].path)).toBe(25_000);
    expect(handlerTimeoutFor(timers, 'GET', '/internal/jobs/health')).toBe(25_000);
  });

  it('as registered: the application\'s own routes carry them (read back from the route options)', async () => {
    const sink = logSink();
    const app = buildApp({ config: testConfig(), logStream: sink.stream, routes: false });
    const seen: Record<string, number | undefined> = {};
    const note = (name: string) => async (request: { routeOptions: { handlerTimeout?: number } }) => {
      seen[name] = request.routeOptions.handlerTimeout;
      return { ok: true };
    };
    createRoute({ matrix: {}, publicRoutes: { login: PUBLIC_ROUTES.login }, tokenDoors: {} })(app, { public: 'login', handler: ({ request }) => note('login')(request) });
    route(app, { token: 'job', method: 'POST', url: TICK_PATH, verify: () => undefined, handler: ({ request }) => note('tick')(request) });
    try {
      await app.inject({ method: 'POST', url: PUBLIC_ROUTES.login.path, headers: csrfHeaders(), payload: {} });
      await app.inject({ method: 'POST', url: TICK_PATH });
      expect(seen).toEqual({ login: 30_000, tick: 50_000 });
      const health = await app.inject({ method: 'GET', url: '/healthz' });
      expect(health.statusCode).toBe(200);
      expect(app.printRoutes()).toContain('healthz');
    } finally {
      await app.close();
    }
  });

  describe('with shorter timers (200 ms, login 300 ms, tick 500 ms) so that the test need not wait 25 seconds', () => {
    const timers = { requestMs: 30_000, handlerMs: 200, loginMs: 300, tickMs: 500 };
    /** A piece of work that stops when it is told to (request.signal) or when it is done. */
    const work = (ms: number, log: { stoppedBy?: string }) => async (request: { signal: AbortSignal }) => {
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => ((log.stoppedBy ??= 'finished'), resolve()), ms);
        request.signal.addEventListener('abort', () => (clearTimeout(t), (log.stoppedBy ??= 'aborted'), resolve()), { once: true });
      });
      return { done: true };
    };

    it('work that runs past the timer is answered 503 JV_BUSY with Retry-After at the timer and not before, and its signal tells it to stop', async () => {
      await withToy(
        async ({ app, toy }) => {
          const log: { stoppedBy?: string } = {};
          toy.get('/toy/slow', async (request) => work(2000, log)(request));
          const t0 = performance.now();
          const res = await app.inject({ method: 'GET', url: '/toy/slow' });
          const took = performance.now() - t0;
          expect([res.statusCode, body(res).error.code]).toEqual([503, 'JV_BUSY']);
          expect(res.headers['retry-after']).toBe('1');
          expect(took).toBeGreaterThanOrEqual(timers.handlerMs - 5); // never before
          expect(took).toBeLessThan(timers.handlerMs + 400);
          await sleep(50);
          expect(log.stoppedBy).toBe('aborted'); // the work was told to stop, so that it does
        },
        { timers },
      );
    });

    it('work that is done in time is answered by itself; the same work takes the login 300 ms and the tick 500 ms', async () => {
      await withToy(
        async ({ app, toy }) => {
          const log: { stoppedBy?: string } = {};
          toy.get('/toy/quick', async (request) => work(50, log)(request));
          toy.get('/toy/250', async (request) => work(250, {})(request));
          createRoute({ matrix: {}, publicRoutes: { login: PUBLIC_ROUTES.login }, tokenDoors: {} })(app, { public: 'login', handler: ({ request }) => work(250, {})(request) });
          route(app, { token: 'job', method: 'POST', url: TICK_PATH, verify: () => undefined, handler: ({ request }) => work(450, {})(request) });
          expect((await app.inject({ method: 'GET', url: '/toy/quick' })).statusCode).toBe(200);
          expect((await app.inject({ method: 'GET', url: '/toy/250' })).statusCode).toBe(503); // 250 ms is past the ordinary 200
          expect((await app.inject({ method: 'POST', url: PUBLIC_ROUTES.login.path, headers: csrfHeaders(), payload: {} })).statusCode).toBe(200); // and inside the login's 300
          expect((await app.inject({ method: 'POST', url: TICK_PATH })).statusCode).toBe(200); // 450 ms is inside the tick's 500
        },
        { timers, routes: false }, // the application's own routes are left out: this test registers a login route of its own
      );
    });

    it('receiving a request has its own timer: a request that never finishes arriving is cut (Fastify requestTimeout, here 400 ms)', async () => {
      const sink = logSink();
      const app = buildApp({ config: testConfig(), logStream: sink.stream, timers: { ...timers, requestMs: 400 } });
      toyRoutes(app).post('/toy/take', async () => ({ ok: true }));
      const port = await freePort();
      await app.listen({ port, host: '127.0.0.1' });
      const socket = net.connect({ port, host: '127.0.0.1' });
      try {
        const closed = new Promise<string>((resolve) => {
          let got = '';
          socket.on('data', (d) => (got += d.toString()));
          socket.on('close', () => resolve(got));
          socket.on('error', () => resolve(got));
        });
        socket.write('POST /toy/take HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{"a"');
        const t0 = performance.now();
        const answer = await Promise.race([closed, sleep(5000).then(() => 'still open')]);
        const took = performance.now() - t0;
        expect(answer).not.toBe('still open');
        expect(took).toBeGreaterThanOrEqual(300);
        expect(took).toBeLessThan(3000);
      } finally {
        socket.destroy();
        await app.close();
      }
    });
  });
});

// ------------------------------------------------------------------ /healthz and /readyz

describe('T-D28 /healthz and /readyz answer only {"ok":true} or {"ok":false}, also when the start-up check fails for a named reason (A14)', () => {
  let scratch: Scratch;
  const pools: DbPool[] = [];
  const apps: FastifyInstance[] = [];
  beforeEach(async () => {
    scratch = await scratchDatabase('leaks', { schema: true });
  }, 120_000);
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((a) => a.close().catch(() => undefined)));
    await Promise.all(pools.splice(0).map((p) => p.end().catch(() => undefined)));
    await scratch?.drop();
  }, 60_000);

  async function start() {
    const pool = createDbPool(scratch.db);
    pools.push(pool);
    const sink = logSink();
    const app = buildApp({ config: testConfig(), db: pool, logStream: sink.stream });
    apps.push(app);
    await app.ready();
    await app.errorLog.idle();
    return { app, sink };
  }
  const exact = async (app: FastifyInstance, url: string, method: 'GET' | 'HEAD' = 'GET') => {
    const res = await app.inject({ method, url });
    return { status: res.statusCode, body: res.body, headers: res.headers };
  };

  it('the start-up check passes: both say {"ok":true}', async () => {
    const { app } = await start();
    expect(app.startup?.ok).toBe(true);
    expect(await exact(app, '/healthz')).toMatchObject({ status: 200, body: '{"ok":true}' });
    expect(await exact(app, '/readyz')).toMatchObject({ status: 200, body: '{"ok":true}' });
    expect((await exact(app, '/readyz', 'HEAD')).status).toBe(200);
  });

  it('a table is missing: /healthz still says the process is up, /readyz says {"ok":false}; neither says why, and no other route is open (JV_UNAVAILABLE)', async () => {
    const root = await scratch.root();
    await root.query(`DROP TABLE \`${scratch.database}\`.sys_photo_copies`);
    await root.end();
    const { app } = await start();
    expect(app.startup?.ok).toBe(false);
    const health = await exact(app, '/healthz');
    const ready = await exact(app, '/readyz');
    expect([health.status, health.body]).toEqual([200, '{"ok":true}']);
    expect([ready.status, ready.body]).toEqual([503, '{"ok":false}']);
    expect((await exact(app, '/readyz', 'HEAD')).status).toBe(503);
    for (const r of [health, ready]) {
      expect(JSON.parse(r.body)).toEqual({ ok: expect.any(Boolean) });
      expect(JSON.stringify(r)).not.toMatch(/sys_photo_copies|missing|table|check|isolation|grant/i);
    }
    const other = await app.inject({ method: 'GET', url: '/v1/auth/me' });
    expect([other.statusCode, body(other).error.code]).toEqual([503, 'JV_UNAVAILABLE']);
    expect(other.body).not.toMatch(/sys_photo_copies/);
  });

  it('the reason goes to sys_error_log, where the owner\'s dashboard line reads it, and to nobody else', async () => {
    const root = await scratch.root();
    await root.query(`DROP TABLE \`${scratch.database}\`.sys_photo_copies`);
    await root.end();
    await start();
    const u = await scratch.connect();
    try {
      const [rows] = await u.query<any[]>("SELECT level, code, message, request_id, user_id, detail FROM sys_error_log WHERE code = 'JV_STARTUP'");
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ level: 'error', request_id: null, user_id: null });
      const detail = typeof rows[0].detail === 'string' ? JSON.parse(rows[0].detail) : rows[0].detail;
      expect(detail.problems).toEqual([{ check: 'tables', detail: expect.stringContaining('sys_photo_copies') }]);
      expect(String(rows[0].message)).not.toContain('sys_photo_copies'); // the message is short; the detail has the reason
    } finally {
      await u.end();
    }
  });

  it('a Delete right that is on is a warning row of its own (the dashboard line is amber) and the API serves', async () => {
    const root = await scratch.root();
    await root.query(`GRANT DELETE ON \`${scratch.database}\`.* TO ?@'%'`, [scratch.user]);
    await root.end();
    const { app } = await start();
    expect(app.startup).toMatchObject({ ok: true, amber: true });
    expect(await exact(app, '/readyz')).toMatchObject({ status: 200, body: '{"ok":true}' });
    const u = await scratch.connect();
    try {
      const [rows] = await u.query<any[]>("SELECT level, code, detail FROM sys_error_log WHERE code = 'JV_RIGHTS'");
      expect(rows).toHaveLength(1);
      expect(rows[0].level).toBe('warn');
      const detail = typeof rows[0].detail === 'string' ? JSON.parse(rows[0].detail) : rows[0].detail;
      expect(detail.rights).toContain('DELETE');
    } finally {
      await u.end();
    }
  });

  it('a healthy start writes nothing to the error log', async () => {
    await start();
    const u = await scratch.connect();
    try {
      const [rows] = await u.query<any[]>('SELECT COUNT(*) AS n FROM sys_error_log');
      expect(Number(rows[0].n)).toBe(0);
    } finally {
      await u.end();
    }
  });

  it('the database cannot be reached: /healthz says {"ok":true} (the process is up), /readyz {"ok":false}, and nothing can be written, which the log says', async () => {
    const port = await freePort();
    const pool = createDbPool({ ...scratch.db, port });
    pools.push(pool);
    const sink = logSink();
    const app = buildApp({ config: testConfig(), db: pool, logStream: sink.stream });
    apps.push(app);
    await app.ready();
    await app.errorLog.idle();
    expect(await exact(app, '/healthz')).toMatchObject({ status: 200, body: '{"ok":true}' });
    expect(await exact(app, '/readyz')).toMatchObject({ status: 503, body: '{"ok":false}' });
    expect(sink.lines().some((l) => /error log/.test(l.msg))).toBe(true);
  });

  it('an application with no database has no check: /healthz is up and /readyz is not (there is nothing to serve from)', async () => {
    await withToy(async ({ app }) => {
      expect(await exact(app, '/healthz')).toMatchObject({ status: 200, body: '{"ok":true}' });
      expect(await exact(app, '/readyz')).toMatchObject({ status: 503, body: '{"ok":false}' });
    });
  });
});
