import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import Fastify from 'fastify';
import ts from 'typescript';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildApp } from '../../src/app';
import { JvError } from '../../src/errors';
import { MATRIX, PUBLIC_ROUTES } from '../../src/permissions/matrix';
import { RouteDeclarationError, createRoute, describeRoutes, installRouteGuard, route, unroutedActions, unroutedPublic } from '../../src/permissions/route';
import { SESSION_COOKIE } from '../../src/permissions/session';
import * as wire from '../../src/wire/zod';
import { CALLERS, type CallerName, type World, makeWorld, registerStubs } from './cells';
import { REPO, buildDist, secret, testConfig } from './support';

/** The application with its wrapper and its error handling and none of its own routes (routes: false), so a test can register what it likes. */
const bare = () => buildApp({ config: testConfig({ logLevel: 'silent' }), routes: false });
const body = (res: { body: string }) => JSON.parse(res.body) as { error: { code: string; message: string; details: Record<string, unknown> }; request_id: string };

// ------------------------------------------------------------------ T-D01

describe('T-D01 an endpoint is registered through route(), with an action of the matrix or a place on the public or token list', () => {
  const handler = async () => ({});

  it.each([
    ['nothing at all but a method, an address and a handler', { method: 'GET', url: '/x', handler }],
    ['an action that is not in the matrix', { action: 'fn:make_it_up', handler }],
    ['an action in the wrong case', { action: 'FN:CREATE_BILL', handler }],
    ['a public name that is not on the list', { public: 'secret-door', handler }],
    ['a public route with an address of its own', { public: 'health', url: '/other', handler }],
    ['a token route for a door that does not exist', { token: 'backdoor', method: 'GET', url: '/admin/v1/x', verify: () => undefined, handler }],
    ['a token route outside the address of its door', { token: 'admin', method: 'GET', url: '/v1/bills', verify: () => undefined, handler }],
    ['a token route for the job door under the admin address', { token: 'job', method: 'POST', url: '/admin/v1/x', verify: () => undefined, handler }],
    ['a token route without its token check', { token: 'admin', method: 'GET', url: '/admin/v1/x', handler }],
    ['a route with an action and a public name', { action: 'fn:create_bill', public: 'health', handler }],
    ['a matrix route without a handler', { action: 'fn:create_bill' }],
    ['a matrix route with an address of its own', { action: 'fn:create_bill', method: 'GET', url: '/elsewhere', handler }],
  ])('refuses %s, when it is registered, with a RouteDeclarationError', (_name, spec) => {
    const app = bare();
    expect(() => route(app, spec as never)).toThrow(RouteDeclarationError);
    expect(app.routeTable.filter((r) => r.url !== '/healthz')).toEqual([]);
  });

  it('refuses a second route for an action that has one (a row of the matrix has one route)', () => {
    const app = bare();
    route(app, { action: 'fn:create_customer', handler });
    expect(() => route(app, { action: 'fn:create_customer', handler })).toThrow(RouteDeclarationError);
  });

  it('registers a route whose action is in the matrix, a public route of the list and a token route inside its door, and lists each as what it is', () => {
    const app = bare();
    route(app, { action: 'fn:void_receipt', handler });
    route(app, { public: 'ready', handler });
    route(app, { token: 'admin', method: 'POST', url: '/admin/v1/users', verify: () => undefined, handler });
    route(app, { token: 'job', method: 'GET', url: '/internal/jobs/health', verify: () => undefined, handler });
    const byUrl = Object.fromEntries(app.routeTable.map((r) => [r.url, r]));
    expect(byUrl['/v1/receipts/:id/void']).toMatchObject({ kind: 'matrix', method: 'POST', action: 'fn:void_receipt', roles: ['owner'] });
    expect(byUrl['/readyz']).toMatchObject({ kind: 'public', method: 'GET', name: 'ready' });
    expect(byUrl['/admin/v1/users']).toMatchObject({ kind: 'token', method: 'POST', name: 'admin' });
    expect(byUrl['/internal/jobs/health']).toMatchObject({ kind: 'token', method: 'GET', name: 'job' });
    expect(byUrl['/healthz']).toMatchObject({ kind: 'public', name: 'health' });
  });

  it('a route registered straight on Fastify fails the start (the guard is a Fastify onRoute hook), also from inside a plugin, for every verb', async () => {
    const direct = bare();
    for (const verb of ['get', 'post', 'put', 'patch', 'delete', 'options'] as const) expect(() => direct[verb](`/direct-${verb}`, async () => ({})), verb).toThrow(RouteDeclarationError);
    expect(() => direct.route({ method: 'GET', url: '/r', handler })).toThrow(/route\(\)/);
    expect(() => direct.all('/all', handler)).toThrow(RouteDeclarationError);

    const nested = bare();
    await expect(
      (async () => {
        await nested.register(async (child) => {
          child.get('/inside-a-plugin', async () => ({}));
        });
        await nested.ready();
      })(),
    ).rejects.toThrow(/route\(\)/);

    // and a route that claims to have been registered through route() by carrying a config of its own is not let through
    const faked = bare();
    expect(() => faked.route({ method: 'GET', url: '/fake', config: { jvRoute: true, route: { kind: 'public' } } as never, handler })).toThrow(RouteDeclarationError);
  });

  it('the guard lets through only what a list of framework routes names, exactly (a plugin that must answer a preflight, say), and nothing else', async () => {
    const app = Fastify({ logger: false });
    installRouteGuard(app, [{ method: 'OPTIONS', url: '*', why: 'test: a plugin answers a preflight' }]);
    expect(() => app.options('*', async () => ({}))).not.toThrow();
    expect(() => app.get('*', async () => ({}))).toThrow(RouteDeclarationError);
    expect(() => app.options('/other', async () => ({}))).toThrow(RouteDeclarationError);
    await app.close();
  });

  it('the production list of framework routes is empty: nothing is exempt yet', async () => {
    const { FRAMEWORK_ROUTES } = await import('../../src/permissions/matrix');
    expect(FRAMEWORK_ROUTES).toEqual([]);
  });

  it('the compiler refuses route() without an action, and accepts it with one (the build fails, not only the start)', () => {
    const dir = join(REPO, 'node_modules', '.cache', 'jv-route-types', secret('t'));
    mkdirSync(dir, { recursive: true });
    const routeModule = join(REPO, 'src', 'permissions', 'route.js').replaceAll('\\', '/');
    const header = `import type { FastifyInstance } from 'fastify';\nimport { route } from '${routeModule}';\ndeclare const app: FastifyInstance;\n`;
    const files: Record<string, string> = {
      'bad-no-action.ts': `${header}route(app, { method: 'GET', url: '/x', handler: async () => ({}) });\n`,
      'bad-unknown-action.ts': `${header}route(app, { action: 'fn:make_it_up', handler: async () => ({}) });\n`,
      'bad-token-without-check.ts': `${header}route(app, { token: 'admin', method: 'GET', url: '/admin/v1/x', handler: async () => ({}) });\n`,
      'good.ts': `${header}route(app, { action: 'fn:create_customer', handler: async () => ({}) });\nroute(app, { public: 'ready', handler: async () => ({}) });\nroute(app, { token: 'job', method: 'POST', url: '/internal/jobs/tick', verify: () => undefined, handler: async () => ({}) });\n`,
    };
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
    let output = '';
    try {
      output = execFileSync(process.execPath, [join(REPO, 'node_modules', 'typescript', 'bin', 'tsc'), '--noEmit', '--strict', '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--skipLibCheck', '--types', 'node', ...Object.keys(files).map((f) => join(dir, f))], { cwd: REPO, encoding: 'utf8', stdio: 'pipe' });
    } catch (e) {
      output = String((e as { stdout?: string }).stdout ?? '');
    }
    for (const bad of ['bad-no-action.ts', 'bad-unknown-action.ts', 'bad-token-without-check.ts']) expect(output, bad).toMatch(new RegExp(`${bad.replace('.', '\\.')}\\(\\d+,\\d+\\): error TS`));
    expect(output).not.toMatch(/good\.ts\(\d+,\d+\): error/);
  }, 120_000);
});

describe('T-D01 the route list is printed, with the roles of every route', () => {
  it('describeRoutes names every registered route with its address, its kind, its action and its roles; unroutedActions names the rows that have no route yet', () => {
    const app = bare();
    registerStubs(app, []);
    const lines = describeRoutes(app);
    for (const [action, row] of Object.entries(MATRIX)) {
      const line = lines.find((l) => l.includes(` ${row.path} `) && l.startsWith(row.method));
      expect(line, action).toBeDefined();
      expect(line, action).toContain(action);
      expect(line, action).toContain(`roles=${row.roles.join(',')}`);
    }
    for (const [name, p] of Object.entries(PUBLIC_ROUTES)) expect(lines.some((l) => l.startsWith(p.method) && l.includes(` ${p.path} `) && l.includes('public') && l.includes(name)), name).toBe(true);
    expect(unroutedActions(app)).toEqual([]);
    expect(unroutedPublic(app)).toEqual([]);
    expect(unroutedActions(bare()).sort()).toEqual(Object.keys(MATRIX).sort());
    expect(unroutedPublic(bare()).sort()).toEqual(['login', 'photo-full', 'photo-thumb', 'ready']); // /healthz is the one public route the application has so far
  });

  it('npm run check:routes (the compiled app) prints the routes with their roles and the rows still waiting for their route, and exits 0', () => {
    const dist = buildDist();
    const out = execFileSync(process.execPath, [join(REPO, 'scripts', 'check-routes.mjs'), dist], { cwd: REPO, encoding: 'utf8' });
    expect(out).toMatch(/GET\s+\/healthz\s+public/);
    expect(out).toMatch(/routes registered/i);
    expect(out).toMatch(/waiting for their route/i);
    for (const row of Object.values(MATRIX)) expect(out, row.path).toContain(row.path); // every row is on the page: as a route, or as one still waiting for its route
    for (const p of Object.values(PUBLIC_ROUTES)) expect(out, p.path).toContain(p.path);
    console.log(out);
  }, 120_000);
});

// ------------------------------------------------------------------ the token and public routes need no database

describe('T-D01 token and public routes: no session is read for them (A1)', () => {
  it('a public route answers without a cookie and without a database', async () => {
    const app = bare();
    route(app, { public: 'ready', handler: async () => ({ ok: true }) });
    await app.ready();
    const res = await app.inject({ method: 'GET', url: '/readyz', headers: { cookie: `${SESSION_COOKIE}=not-a-ticket` } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    await app.close();
  });

  it('a token route runs its own check first and nothing else: a refusal of the check is the answer, the handler does not run, no session is looked up', async () => {
    const app = bare();
    const calls: string[] = [];
    route(app, {
      token: 'admin',
      method: 'POST',
      url: '/admin/v1/users',
      verify: (request) => {
        calls.push('verify');
        if (request.headers.authorization !== 'Bearer fixture') throw new JvError('JV_UNAUTHENTICATED', 'The token was refused.');
      },
      body: wire.strictObject({ email: z.string() }),
      handler: async ({ body: b }) => {
        calls.push('handler');
        return { email: b.email };
      },
    });
    await app.ready();
    const refused = await app.inject({ method: 'POST', url: '/admin/v1/users', payload: '{bad json', headers: { 'content-type': 'application/json' } });
    expect(refused.statusCode).toBe(401);
    expect(body(refused).error.code).toBe('JV_UNAUTHENTICATED');
    expect(calls).toEqual(['verify']);
    const wrongBody = await app.inject({ method: 'POST', url: '/admin/v1/users', headers: { authorization: 'Bearer fixture' }, payload: { nope: 1 } });
    expect(wrongBody.statusCode).toBe(422);
    const ok = await app.inject({ method: 'POST', url: '/admin/v1/users', headers: { authorization: 'Bearer fixture' }, payload: { email: 'a@example.test' } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ email: 'a@example.test' });
    await app.close();
  });

  it('a session route with no database to look in is JV_UNAVAILABLE, never an open door', async () => {
    const app = bare();
    route(app, { action: 'fn:void_receipt', handler: async () => ({ ok: true }) });
    await app.ready();
    const res = await app.inject({ method: 'POST', url: '/v1/receipts/6c1f1e0e-0f3b-4b4e-9a53-2f5f2d9c7a10/void', headers: { cookie: `${SESSION_COOKIE}=${'a'.repeat(43)}` } });
    expect(res.statusCode).toBe(503);
    expect(body(res).error.code).toBe('JV_UNAVAILABLE');
    await app.close();
  });
});

// ------------------------------------------------------------------ the world: one fixture user for each caller

describe('T-D02 (D2, A2, A6, A10) the order of work: session, then the must-change-password gate, then the matrix row, then the body, then the handler', () => {
  let world: World;
  const log: string[] = [];
  let bodyChecks = 0;
  beforeAll(async () => {
    world = await makeWorld({
      label: 'routeord',
      build: (app) => {
        route(app, {
          action: 'fn:create_customer',
          body: wire.strictObject({ name: z.string() }).check(() => {
            bodyChecks++;
          }),
          handler: async ({ body: b, auth }) => {
            log.push('create_customer');
            return { name: b.name, as: auth.user.role };
          },
        });
        route(app, {
          action: 'fn:void_receipt',
          handler: async () => {
            log.push('void_receipt');
            return { ok: true };
          },
        });
        route(app, { action: 'session:me', handler: async ({ auth }) => ({ id: auth.user.id, role: auth.user.role, must_change_password: auth.user.mustChangePassword }) });
        route(app, { action: 'read:audit_log', handler: async () => ({ rows: [] }) });
      },
    });
  }, 120_000);
  afterAll(async () => {
    await world?.close();
  });

  const reset = () => {
    log.length = 0;
    bodyChecks = 0;
    world.spy.sent.length = 0;
  };
  /** The statements a call sent, without the checkout's own SET SESSION. */
  const statements = () => world.spy.sqls().filter((s) => !/^SET SESSION/i.test(s.trim()));
  const url = '/v1/customers';

  it('a caller with no session is refused before the body is even read: a body that is not JSON gets 401, not 400', async () => {
    reset();
    const res = await world.call('anon', 'POST', url, { payload: '{not json', headers: { 'content-type': 'application/json' } });
    expect(res.statusCode).toBe(401);
    expect(body(res).error.code).toBe('JV_UNAUTHENTICATED');
    expect(log).toEqual([]);
    expect(bodyChecks).toBe(0);
    expect(statements()).toEqual([]); // no cookie: nothing is read at all
  });

  it('a forbidden caller learns nothing about the body: staff on a biller\'s route get 403 for a body that is not JSON, for an empty body, for a wrong body and for a right one', async () => {
    for (const payload of ['{not json', undefined, { zzz: 1 }, { name: 'Asha' }]) {
      reset();
      const res = await world.call('staff', 'POST', url, { payload: payload as never, headers: typeof payload === 'string' ? { 'content-type': 'application/json' } : undefined });
      expect(res.statusCode, JSON.stringify(payload)).toBe(403);
      expect(body(res).error.code).toBe('JV_FORBIDDEN');
      expect(log).toEqual([]);
      expect(bodyChecks).toBe(0);
    }
  });

  it('an allowed caller\'s body is checked after the matrix: 422 for a missing field and for an unknown one, with the field named and the value never repeated', async () => {
    reset();
    const missing = await world.call('biller', 'POST', url, { payload: {} });
    expect(missing.statusCode).toBe(422);
    expect(body(missing).error).toMatchObject({ code: 'JV_INVALID_INPUT', details: { field: 'name' } });
    const unknown = await world.call('biller', 'POST', url, { payload: { name: 'Asha', role: 'owner' } });
    expect(unknown.statusCode).toBe(422);
    expect(body(unknown).error).toMatchObject({ code: 'JV_INVALID_INPUT', details: { field: 'role' } });
    expect(unknown.body).not.toContain('"owner"');
    expect(log).toEqual([]);
    reset();
    const ok = await world.call('biller', 'POST', url, { payload: { name: 'Asha' } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ name: 'Asha', as: 'biller' });
    expect(log).toEqual(['create_customer']);
  });

  it('the must-change-password gate comes before the matrix row: a user who must change the password gets JV_PASSWORD_CHANGE_REQUIRED even on a row their role may not call, and may call me', async () => {
    reset();
    const owners = await world.call('must_change', 'POST', '/v1/receipts/6c1f1e0e-0f3b-4b4e-9a53-2f5f2d9c7a10/void');
    expect(owners.statusCode).toBe(403);
    expect(body(owners).error.code).toBe('JV_PASSWORD_CHANGE_REQUIRED');
    const billers = await world.call('must_change', 'POST', url, { payload: { name: 'Asha' } });
    expect(body(billers).error.code).toBe('JV_PASSWORD_CHANGE_REQUIRED');
    expect(log).toEqual([]);
    const me = await world.call('must_change', 'GET', '/v1/auth/me');
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ role: 'staff', must_change_password: true });
  });

  it('the session is looked up in sessions, then users, and nothing is written (D2): two reads, in that order', async () => {
    reset();
    const res = await world.call('biller', 'GET', '/v1/auth/me');
    expect(res.statusCode).toBe(200);
    const sent = statements();
    expect(sent).toHaveLength(2);
    expect(sent[0]).toMatch(/^SELECT[\s\S]*\bFROM sessions\b/i);
    expect(sent[1]).toMatch(/^SELECT[\s\S]*\bFROM users\b/i);
    expect(sent.join('\n')).not.toMatch(/\b(INSERT|UPDATE)\b/i);
    expect(sent.join('\n')).not.toMatch(/SELECT\s+\*/i); // a read names its columns (A4)
    expect(sent.join('\n')).not.toMatch(/password_hash/i); // the hash is never read
  });

  it.each([
    { name: 'a cookie that is not a ticket', ticket: 'ticket-with-spaces and symbols!', reads: 0 },
    { name: 'a ticket of the wrong length', ticket: 'a'.repeat(42), reads: 0 },
    { name: 'a ticket nobody holds', ticket: 'b'.repeat(43), reads: 1 },
  ])('$name is 401 JV_UNAUTHENTICATED and reads $reads time(s)', async ({ ticket, reads }) => {
    reset();
    const res = await world.app.inject({ method: 'GET', url: '/v1/auth/me', headers: { cookie: `${SESSION_COOKIE}=${ticket}` } });
    expect(res.statusCode).toBe(401);
    expect(body(res).error.code).toBe('JV_UNAUTHENTICATED');
    expect(statements()).toHaveLength(reads);
  });

  it.each([
    { name: 'an ended session', caller: 'ended', code: 'JV_UNAUTHENTICATED', reads: 1 },
    { name: 'a session past its absolute lifetime', caller: 'expired', code: 'JV_SESSION_EXPIRED', reads: 1 },
    { name: 'a session idle for more than 12 hours', caller: 'idle', code: 'JV_SESSION_EXPIRED', reads: 1 },
    { name: 'a user who is not active', caller: 'inactive', code: 'JV_UNAUTHENTICATED', reads: 2 },
  ] as { name: string; caller: CallerName; code: string; reads: number }[])('$name is 401 $code after $reads read(s), and nothing is written (D2, A10)', async ({ caller, code, reads }) => {
    reset();
    const res = await world.call(caller, 'GET', '/v1/auth/me');
    expect(res.statusCode).toBe(401);
    expect(body(res).error.code).toBe(code);
    expect(statements()).toHaveLength(reads);
    expect(statements().join('\n')).not.toMatch(/\b(INSERT|UPDATE)\b/i);
  });

  it('the cookie carries only the ticket: the role, the active flag and the answer come from users on every call, so a change takes effect at the next call (A2, A10)', async () => {
    const u = await world.addUser({ role: 'staff' });
    const as = async () => world.app.inject({ method: 'GET', url: '/v1/auth/me', headers: { cookie: u.cookie } });
    expect((await as()).json()).toMatchObject({ id: u.userId, role: 'staff' });
    expect((await world.app.inject({ method: 'GET', url: '/v1/audit-log', headers: { cookie: u.cookie } })).statusCode).toBe(403);
    await world.sql.query("UPDATE users SET role = 'owner' WHERE id = ?", [u.userId]);
    expect((await as()).json()).toMatchObject({ role: 'owner' }); // the same cookie, the next call
    expect((await world.app.inject({ method: 'GET', url: '/v1/audit-log', headers: { cookie: u.cookie } })).statusCode).toBe(200);
    await world.sql.query("UPDATE users SET role = 'biller' WHERE id = ?", [u.userId]);
    expect((await world.app.inject({ method: 'GET', url: '/v1/audit-log', headers: { cookie: u.cookie } })).statusCode).toBe(403);
    // a user deactivated in the middle of a shift is cut off at the next call, the open session included (A10)
    await world.sql.query('UPDATE users SET active = 0 WHERE id = ?', [u.userId]);
    const cut = await as();
    expect(cut.statusCode).toBe(401);
    expect(body(cut).error.code).toBe('JV_UNAUTHENTICATED');
    await world.sql.query('UPDATE users SET active = 1 WHERE id = ?', [u.userId]);
    expect((await as()).statusCode).toBe(200);
    // a session that is revoked is over at once
    await world.sql.query('UPDATE sessions SET revoked_at = ? WHERE id = ?', ['2026-10-17 09:59:00.000000', u.sessionId]);
    expect((await as()).statusCode).toBe(401);
  });

  it('a header, a query string, a body or another cookie that names a role is ignored: the role is the one in users', async () => {
    const u = await world.addUser({ role: 'staff' });
    const ticket = u.cookie;
    const tries: Record<string, string>[] = [
      { 'x-role': 'owner' },
      { 'x-user-role': 'owner', 'x-jv-role': 'owner' },
      { authorization: 'Bearer owner' },
      { cookie: `role=owner; ${ticket}` },
      { cookie: `${ticket}; role=owner; jv_role=owner` },
    ];
    for (const headers of tries) {
      const res = await world.app.inject({ method: 'GET', url: '/v1/auth/me?role=owner&user_role=owner', headers: { cookie: ticket, ...headers } });
      expect(res.json(), JSON.stringify(headers)).toMatchObject({ role: 'staff' });
    }
    const post = await world.app.inject({ method: 'POST', url, headers: { cookie: u.cookie }, payload: { name: 'x', role: 'owner' } });
    expect(post.statusCode).toBe(403); // staff may not call this row, whatever the body says
    // a cookie that holds a role in place of the ticket gets nothing
    const fake = await world.app.inject({ method: 'GET', url: '/v1/auth/me', headers: { cookie: `${SESSION_COOKIE}=owner` } });
    expect(fake.statusCode).toBe(401);
  });

  it('a path that is not in the matrix is a 404 for everyone, the signed-in included, and reads nothing: no GraphQL, no generic table route, no sign-up (A11)', async () => {
    const paths: [string, string][] = [
      ['POST', '/graphql'],
      ['GET', '/graphql'],
      ['GET', '/v1/sync/sessions'],
      ['GET', '/v1/sync/sys_counters'],
      ['GET', '/v1/sync/users;drop'],
      ['GET', '/v1/table/customers'],
      ['GET', '/v1/customers/anything/../../users'],
      ['POST', '/v1/auth/signup'],
      ['POST', '/v1/auth/register'],
      ['POST', '/signup'],
      ['PATCH', '/v1/users/6c1f1e0e-0f3b-4b4e-9a53-2f5f2d9c7a10'],
      ['PUT', '/v1/users'],
      ['GET', '/'],
      ['GET', '/v1'],
    ];
    for (const caller of CALLERS) {
      for (const [method, path] of paths) {
        reset();
        const res = await world.call(caller, method, path);
        expect(res.statusCode, `${caller} ${method} ${path}`).toBe(404);
        const e = body(res);
        expect(e.error.code).toBe('JV_NOT_FOUND');
        expect(e.request_id).toMatch(/^[0-9a-f]{8}-/);
        expect(statements(), `${caller} ${method} ${path}`).toEqual([]);
      }
    }
  });
});

// ------------------------------------------------------------------ T-D08

describe('T-D08 no route inserts or updates bills, bill_items, receipts or receipt_allocations directly', () => {
  const NAMES = ['bills', 'bill_items', 'bill-items', 'receipts', 'receipt_allocations', 'receipt-allocations'];
  const ID = '6c1f1e0e-0f3b-4b4e-9a53-2f5f2d9c7a10';

  /** Sends PATCH, PUT and DELETE (and a POST to the ones that are not a service function's address) to every name, for every caller; returns what did not answer 404. */
  async function probe(world: World): Promise<string[]> {
    const found: string[] = [];
    for (const caller of CALLERS) {
      for (const name of NAMES) {
        for (const path of [`/v1/${name}`, `/v1/${name}/${ID}`, `/v1/sync/${name}`]) {
          for (const method of ['PATCH', 'PUT', 'DELETE']) {
            const res = await world.call(caller, method, path, { payload: {} });
            if (res.statusCode !== 404) found.push(`${caller} ${method} ${path}: ${res.statusCode}`);
          }
        }
      }
      // POST /v1/bills is X1 and POST /v1/receipts/{id}/void is X4: those are service functions of section 10; nothing else under these names takes a POST
      for (const path of ['/v1/bill_items', '/v1/receipts', '/v1/receipt_allocations', '/v1/bill-items', '/v1/receipt-allocations']) {
        const res = await world.call(caller, 'POST', path, { payload: {} });
        if (res.statusCode !== 404) found.push(`${caller} POST ${path}: ${res.statusCode}`);
      }
    }
    return found;
  }

  let world: World;
  let real: World;
  beforeAll(async () => {
    world = await makeWorld({ label: 'routed08', build: (app, w) => registerStubs(app, w.handled) });
    real = await makeWorld({ label: 'routed08r', routes: true });
  }, 120_000);
  afterAll(async () => {
    await world?.close();
    await real?.close();
  });

  const forbiddenAddress = /\/(bills|bill[-_]items|receipts|receipt[-_]allocations)\b/;

  it('the route list shows none: no route PATCHes or PUTs a path of these tables (in the application, and with a stub behind every row of the matrix), and no row of the matrix is an edit of them', () => {
    for (const app of [world.app, real.app]) {
      for (const r of app.routeTable) {
        if (r.method === 'PATCH' || r.method === 'PUT') expect(r.url, `${r.method} ${r.url}`).not.toMatch(forbiddenAddress);
      }
    }
    expect(Object.values(MATRIX).filter((r) => r.edit && ['bills', 'bill_items', 'receipts', 'receipt_allocations'].includes(r.edit.table))).toEqual([]);
  });

  it('a PATCH, PUT or DELETE to their names answers 404 to every caller, an owner with a live session included (the application, and the app with a stub behind every row)', async () => {
    expect(await probe(real)).toEqual([]);
    expect(await probe(world)).toEqual([]);
  });

  it('control: with a route that does PATCH /v1/bills/:id behind the wrapper the same probe finds it', async () => {
    const wrong = createRoute({
      matrix: { 'edit:bills.update': { kind: 'edit', method: 'PATCH', path: '/v1/bills/:id', roles: ['owner'], mustChange: false, spec: 'a mutant', edit: { table: 'bills', op: 'update', shape: 'changes' } } },
      publicRoutes: {},
      tokenDoors: {},
    });
    const mutant = await makeWorld({ label: 'routed08m', build: (app, w) => { registerStubs(app, w.handled); wrong(app, { action: 'edit:bills.update', handler: async () => ({ ok: true }) } as never); } });
    try {
      const found = await probe(mutant);
      expect(found.length).toBeGreaterThan(0);
      expect(found.some((f) => f.includes('PATCH /v1/bills/'))).toBe(true);
    } finally {
      await mutant.close();
    }
  }, 120_000);
});

// ------------------------------------------------------------------ T-D10

describe('T-D10 roles are checked in one place: no role string outside the permissions folder, and every route goes through route()', () => {
  // A role string is a string literal that is a role name, or an object key spelled as one (`{ owner: ... }`, `x.role === 'owner'`, `['owner', 'staff'].includes(r)`). Words inside longer text
  // (a log message that says "the owner's dashboard line") are not role checks. The named list below is the one place a role name may stand outside src/permissions/.
  const ROLE_WORDS = new Set(['owner', 'biller', 'staff']);
  /** Named exceptions: file, then why. Empty on purpose. */
  const NAMED: Record<string, string> = {};
  const HTTP_VERBS = new Set(['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'all', 'route']);
  const SERVER_NAMES = new Set(['app', 'fastify', 'instance', 'server', 'scope', 'router', 'child', 'api']);

  interface Hit {
    file: string;
    line: number;
    text: string;
  }

  function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) return sourceFiles(p);
      return /\.(ts|mts)$/.test(name) && !/\.d\.ts$/.test(name) ? [p] : [];
    });
  }

  function scan(file: string, source: string): { roles: Hit[]; routes: Hit[] } {
    const sf = ts.createSourceFile(file, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
    const roles: Hit[] = [];
    const routes: Hit[] = [];
    const at = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
    const visit = (n: ts.Node) => {
      if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && ROLE_WORDS.has(n.text.trim().toLowerCase())) roles.push({ file, line: at(n), text: n.text });
      if (ts.isPropertyAssignment(n) || ts.isShorthandPropertyAssignment(n) || ts.isPropertySignature(n)) {
        const name = n.name;
        if (name && ts.isIdentifier(name) && ROLE_WORDS.has(name.text)) roles.push({ file, line: at(n), text: `{ ${name.text} }` });
      }
      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && HTTP_VERBS.has(n.expression.name.text)) {
        const receiver = n.expression.expression;
        if (ts.isIdentifier(receiver) && SERVER_NAMES.has(receiver.text)) routes.push({ file, line: at(n), text: `${receiver.text}.${n.expression.name.text}(` });
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
    return { roles, routes };
  }

  const outside = () => sourceFiles(join(REPO, 'src')).filter((f) => !relative(join(REPO, 'src'), f).startsWith(`permissions${'/'}`));

  it('the scanner can see a role string and a direct route (control): it finds them in a sample and ignores prose', () => {
    const sample = [
      "if (user.role === 'owner') {}",
      'const a = ["biller", `staff`];',
      'const b = { owner: 1, biller };',
      "app.get('/x', handler); app.route({}); fastify.post('/y', h);",
      "const c = 'the owner\\'s dashboard line'; map.get('owner-key'); headers.get('x');",
      "// 'owner' in a comment",
    ].join('\n');
    const r = scan('sample.ts', sample);
    expect(r.roles.map((h) => h.text)).toEqual(['owner', 'biller', 'staff', '{ owner }', '{ biller }']);
    expect(r.routes.map((h) => h.text)).toEqual(['app.get(', 'app.route(', 'fastify.post(']);
  });

  it('src/ outside src/permissions/ holds no role string (the named list is empty)', () => {
    const hits = outside().flatMap((f) => scan(f, readFileSync(f, 'utf8')).roles).filter((h) => !(relative(REPO, h.file) in NAMED));
    expect(hits.map((h) => `${relative(REPO, h.file)}:${h.line} ${h.text}`)).toEqual([]);
    expect(Object.keys(NAMED)).toEqual([]);
  });

  it('src/ outside src/permissions/ registers no route straight on a server object: every endpoint goes through route()', () => {
    const hits = outside().flatMap((f) => scan(f, readFileSync(f, 'utf8')).routes);
    expect(hits.map((h) => `${relative(REPO, h.file)}:${h.line} ${h.text}`)).toEqual([]);
  });

  it('the matrix and the roles live in src/permissions/ and nowhere else', () => {
    const inside = sourceFiles(join(REPO, 'src', 'permissions')).map((f) => relative(join(REPO, 'src', 'permissions'), f)).sort();
    expect(inside).toEqual(expect.arrayContaining(['matrix.ts', 'route.ts', 'session.ts']));
    const holders = sourceFiles(join(REPO, 'src')).filter((f) => scan(f, readFileSync(f, 'utf8')).roles.length > 0).map((f) => relative(join(REPO, 'src'), f));
    for (const h of holders) expect(h.startsWith('permissions/'), h).toBe(true);
  });

  it('a service function checks the role again at its start through the matrix, with no role string of its own (A6, X0 item 2)', async () => {
    const { assertMayCall } = await import('../../src/permissions/route');
    expect(() => assertMayCall('biller', 'fn:void_receipt')).toThrow(JvError);
    try {
      assertMayCall('biller', 'fn:void_receipt');
    } catch (e) {
      expect((e as JvError).code).toBe('JV_FORBIDDEN');
      expect((e as JvError).status).toBe(403);
    }
    expect(() => assertMayCall('owner', 'fn:void_receipt')).not.toThrow();
    expect(() => assertMayCall('whoever', 'fn:void_receipt')).toThrow(JvError);
  });
});
