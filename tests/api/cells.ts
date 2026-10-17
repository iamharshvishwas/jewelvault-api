import { randomUUID } from 'node:crypto';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import type { Connection } from 'mysql2/promise';
import { buildApp } from '../../src/app';
import { type Clock, createClock, formatTimestamp } from '../../src/clock';
import type { Config } from '../../src/config';
import { type DbPool, createDbPool } from '../../src/db/pool';
import { limits } from '../../src/limits';
import { type Action, MATRIX, type MatrixRow, PUBLIC_ROUTES, type PublicName, type Role } from '../../src/permissions/matrix';
import { route } from '../../src/permissions/route';
import { SESSION_COOKIE, hashTicket, newTicket } from '../../src/permissions/session';
import { type Scratch, scratchDatabase } from '../helpers';
import { csrfHeaders, logSink, secret, testConfig } from './support';
import { type Spy, spyOn } from './tx-support';

// Shared by T-D02 (tests/matrix.generated.test.ts and tests/api/permissions-*.test.ts): the callers of A4, a database holding one fixture of them, and the CELL: one row of the matrix, one
// caller, one expected answer. A cell returns null when the answer is the one the matrix gives, and a sentence when it is not, so the same function that the generated test asserts on can be
// shown to FAIL on a wrong cell (the negative control of tests/api/cells.test.ts).

/** The callers of A4 (the spec says five and lists six; the ones that end in a 401 are told apart because each ends differently) plus a user who must still change the password (U11). */
export const CALLERS = ['anon', 'ended', 'expired', 'idle', 'inactive', 'must_change', 'staff', 'biller', 'owner'] as const;
export type CallerName = (typeof CALLERS)[number];

/** The answer the matrix gives a caller for a row. */
export type Expected = { kind: 'unauthorized'; code: 'JV_UNAUTHENTICATED' | 'JV_SESSION_EXPIRED' } | { kind: 'password_change' } | { kind: 'forbidden' } | { kind: 'allowed' };

export function expectedFor(row: Pick<MatrixRow, 'roles' | 'mustChange'>, caller: CallerName): Expected {
  switch (caller) {
    case 'anon':
    case 'ended':
    case 'inactive':
      return { kind: 'unauthorized', code: 'JV_UNAUTHENTICATED' };
    case 'expired':
    case 'idle':
      return { kind: 'unauthorized', code: 'JV_SESSION_EXPIRED' };
    case 'must_change':
      // U11 and A6: the gate comes before the matrix row, so the answer does not depend on whether the staff role may call the row
      return row.mustChange ? (row.roles.includes('staff') ? { kind: 'allowed' } : { kind: 'forbidden' }) : { kind: 'password_change' };
    default:
      return row.roles.includes(caller) ? { kind: 'allowed' } : { kind: 'forbidden' };
  }
}

// ------------------------------------------------------------------ the fixture

/** The clock of the fixture: a fixed instant, 17 October 2026 10:00 UTC. */
export const T0 = BigInt(Date.UTC(2026, 9, 17, 10, 0, 0)) * 1000n;
const HOUR = 3_600_000_000n;
const ts = (micros: bigint) => formatTimestamp(micros);

interface Fixture {
  userId: string;
  sessionId: string;
  ticket: string;
  /** the session row as the fixture made it: restore() puts it back after a call that changed it (a logout, the ending of an expired session) */
  initial: { revokedAt: string | null; lastSeenAt: string };
}

export interface UserSpec {
  role: Role;
  active?: boolean;
  mustChange?: boolean;
  /** the login name (default: a made-up address) */
  email?: string;
  /** what `users.password_hash` holds (default: a made-up value that no password matches) */
  passwordHash?: string;
  session?: { createdAgo?: bigint; lastSeenAgo?: bigint; expiresIn?: bigint; revoked?: boolean };
}

export interface World {
  app: FastifyInstance;
  scratch: Scratch;
  /** the ten-box user's own connection to the fixture database: tests change users and sessions with it */
  sql: Connection;
  spy: Spy;
  fixtures: Record<Exclude<CallerName, 'anon'>, Fixture>;
  /** the actions whose handler ran (the stub handlers push here) */
  handled: string[];
  logs: ReturnType<typeof logSink>;
  /** the cookie header of a caller, or undefined */
  cookieOf(caller: CallerName): string | undefined;
  /** A new user with a live session (the spec says how it differs), for a test that changes the user or the session. Returns the user id, the e-mail, the session id and the cookie header. */
  addUser(spec: UserSpec): Promise<{ userId: string; email: string; sessionId: string; cookie: string }>;
  /** Puts the fixture caller's session row back as the fixture made it (a call may have ended or moved it): the cells of T-D02 are independent of each other. */
  restore(caller: CallerName): Promise<void>;
  call(caller: CallerName, method: string, url: string, init?: { payload?: unknown; headers?: Record<string, string> }): Promise<LightMyRequestResponse>;
  close(): Promise<void>;
}

export interface WorldOptions {
  /** Registers routes on the app after buildApp() and before it is ready. */
  build?: (app: FastifyInstance, world: { handled: string[] }) => void;
  /** Names the scratch database (letters and digits, at most 12). */
  label?: string;
  /** true: the application's own routes (src/routes.ts) are in the app; false (the default): only the wrapper, /healthz and what `build` registers. */
  routes?: boolean;
  /** The API's clock. Default: fixed at T0, the instant the fixtures are made relative to. A test that moves time passes a clock over its own source, which starts at T0. */
  clock?: Clock;
  /** Config values over `testConfig` (API09: the admin door exists only while `adminTokenHash` is set). */
  config?: Partial<Config>;
}

/** The pool, but every statement it sends is seen by the spy. */
function spiedPool(pool: DbPool, spy: Spy): DbPool {
  return new Proxy(pool, {
    get(target, prop) {
      if (prop === 'checkout') return () => spy.pool.checkout();
      const v = (target as unknown as Record<string | symbol, unknown>)[prop];
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}

export async function makeWorld(options: WorldOptions = {}): Promise<World> {
  const scratch = await scratchDatabase(options.label ?? 'cells', { schema: true });
  const sql = await scratch.connect();
  const now = T0;
  const fixtures = {} as World['fixtures'];

  async function insertUser(label: string, spec: UserSpec) {
    const userId = randomUUID();
    const email = spec.email ?? `${label}-${randomUUID().slice(0, 8)}@example.test`;
    await sql.query('INSERT INTO users (id, email, full_name, role, active, password_hash, must_change_password) VALUES (?, ?, ?, ?, ?, ?, ?)', [
      userId,
      email,
      `Fixture ${label}`,
      spec.role,
      spec.active === false ? 0 : 1,
      spec.passwordHash ?? secret('not-a-hash'),
      spec.mustChange ? 1 : 0,
    ]);
    const ticket = newTicket();
    const sessionId = randomUUID();
    const s = spec.session ?? {};
    const initial = { revokedAt: s.revoked ? ts(now - HOUR / 2n) : null, lastSeenAt: ts(now - (s.lastSeenAgo ?? 60_000_000n)) };
    await sql.query('INSERT INTO sessions (id, user_id, token_hash, created_at, last_seen_at, expires_at, revoked_at, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [
      sessionId,
      userId,
      hashTicket(ticket),
      ts(now - (s.createdAgo ?? HOUR)),
      initial.lastSeenAt,
      ts(now + (s.expiresIn ?? 14n * 24n * HOUR)),
      initial.revokedAt,
      'fixture',
    ]);
    return { userId, email, sessionId, ticket, initial };
  }
  async function add(caller: Exclude<CallerName, 'anon'>, spec: UserSpec) {
    const { userId, sessionId, ticket, initial } = await insertUser(caller, spec);
    fixtures[caller] = { userId, sessionId, ticket, initial };
  }

  await add('owner', { role: 'owner' });
  await add('biller', { role: 'biller' });
  await add('staff', { role: 'staff' });
  // the worst case for each way out: an owner, who could do anything, whose session is over for the named reason
  await add('inactive', { role: 'owner', active: false });
  await add('ended', { role: 'owner', session: { revoked: true } });
  await add('expired', { role: 'owner', session: { createdAgo: 15n * 24n * HOUR, expiresIn: -1_000_000n } });
  await add('idle', { role: 'owner', session: { lastSeenAgo: BigInt(limits.sessionIdleMs) * 1000n + 1_000_000n } });
  await add('must_change', { role: 'staff', mustChange: true });

  const realPool = createDbPool(scratch.db);
  const spy = spyOn(realPool);
  const logs = logSink();
  const handled: string[] = [];
  const app = buildApp({ config: testConfig({ logLevel: 'warn', ...options.config }), db: spiedPool(realPool, spy), clock: options.clock ?? createClock(() => now), logStream: logs.stream, routes: options.routes ?? false });
  options.build?.(app, { handled });
  await app.ready();
  if (!app.startup?.ok) throw new Error(`the start-up check of the fixture database failed: ${JSON.stringify(app.startup?.problems)}`);

  const world: World = {
    app,
    scratch,
    sql,
    spy,
    fixtures,
    handled,
    logs,
    cookieOf: (caller) => (caller === 'anon' ? undefined : `${SESSION_COOKIE}=${fixtures[caller].ticket}`),
    async addUser(spec) {
      const u = await insertUser('extra', spec);
      return { userId: u.userId, email: u.email, sessionId: u.sessionId, cookie: `${SESSION_COOKIE}=${u.ticket}` };
    },
    async restore(caller) {
      if (caller === 'anon') return;
      const f = fixtures[caller];
      await sql.query('UPDATE sessions SET revoked_at = ?, last_seen_at = ? WHERE id = ?', [f.initial.revokedAt, f.initial.lastSeenAt, f.sessionId]);
    },
    call(caller, method, url, init = {}) {
      const cookie = world.cookieOf(caller);
      // a call that changes state carries the two headers of the CSRF layers (A12, API07) like the website's does; a test of those layers sends its own calls with app.inject
      const csrf = method === 'GET' || method === 'HEAD' ? {} : csrfHeaders();
      return app.inject({ method: method as 'GET', url, headers: { ...csrf, ...(cookie ? { cookie } : {}), ...init.headers }, payload: init.payload as string | object | undefined });
    },
    async close() {
      await app.close().catch(() => undefined);
      await sql.end().catch(() => undefined);
      await scratch.drop();
    },
  };
  return world;
}

// ------------------------------------------------------------------ a route for every row

/**
 * Registers a stub handler for every row of the matrix and for every public route that the application has not registered itself, through the real route(): the wrapper's answers can then be walked for the whole
 * matrix before the tasks that build the real handlers have run. A stub says `{ok:true}` and notes the action in `handled`.
 */
export function registerStubs(app: FastifyInstance, handled: string[]) {
  for (const action of Object.keys(MATRIX) as Action[]) {
    if (app.routeTable.some((r) => r.action === action)) continue; // the application has its own route for it
    route(app, {
      action,
      handler: async () => {
        handled.push(action);
        return { ok: true };
      },
    });
  }
  for (const name of Object.keys(PUBLIC_ROUTES) as PublicName[]) {
    if (app.routeTable.some((r) => r.kind === 'public' && r.name === name)) continue;
    route(app, { public: name, handler: async () => ({ ok: true }) });
  }
}

// ------------------------------------------------------------------ the cells

/** `/v1/bills/:id/cancel` with a made-up id for each parameter (a key is a name, not an id). */
export const concreteUrl = (path: string) => path.replace(/:([a-z_]+)/g, (_m, name: string) => (name === 'key' ? 'numbering' : randomUUID()));

interface Answer {
  statusCode: number;
  body: string;
  headers: Record<string, unknown>;
}

function errorOf(res: Answer): { code: string; message: string; details: unknown; request_id: string } | null {
  try {
    const parsed = JSON.parse(res.body) as { error?: { code: string; message: string; details: unknown }; request_id?: string };
    return parsed.error && typeof parsed.request_id === 'string' ? { ...parsed.error, request_id: parsed.request_id } : null;
  } catch {
    return null;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const STATUS = { unauthorized: 401, password_change: 403, forbidden: 403 } as const;
const CODE = { password_change: 'JV_PASSWORD_CHANGE_REQUIRED', forbidden: 'JV_FORBIDDEN' } as const;

/** Statements that read the session and the user, and the checkout's own SET SESSION: all a refused caller may cause (D2, A10: nothing else is read or written). */
const isSessionRead = (sql: string) => /^SELECT\b[\s\S]*\bFROM\s+(sessions|users)\b/i.test(sql.trim()) || /^SET SESSION\b/i.test(sql.trim());
/** U4: the one write a refused caller may cause, and only a caller whose session is over its lifetime: the session is marked ended (revoked_at; the row stays, S7). */
const isEndMark = (sql: string) => /^UPDATE\s+sessions\s+SET\s+revoked_at\s*=\s*\?\s+WHERE\s+id\s*=\s*\?\s+AND\s+revoked_at\s+IS\s+NULL$/i.test(sql.trim());

/** What is checked about an answer that ends a call before the handler: the S8 body, and that only the session and the user were read. */
function refusalProblems(world: World, res: Answer, expected: Exclude<Expected, { kind: 'allowed' }>, sentBefore: number): string[] {
  const problems: string[] = [];
  const status = STATUS[expected.kind];
  const code = expected.kind === 'unauthorized' ? expected.code : CODE[expected.kind];
  const e = errorOf(res);
  if (res.statusCode !== status) problems.push(`status ${res.statusCode}, the matrix says ${status}`);
  if (!e) problems.push('the body is not the S8 error body {error:{code,message,details},request_id}');
  else {
    if (e.code !== code) problems.push(`code ${e.code}, the matrix says ${code}`);
    if (!UUID.test(e.request_id)) problems.push('request_id is not a UUID');
  }
  const mayEndSession = expected.kind === 'unauthorized' && expected.code === 'JV_SESSION_EXPIRED';
  const stray = world.spy.sqls().slice(sentBefore).filter((s) => !isSessionRead(s) && !(mayEndSession && isEndMark(s)));
  if (stray.length > 0) problems.push(`a refused caller caused a statement other than the session and user reads: ${stray[0].slice(0, 60)}`);
  return problems;
}

export interface CellRoute {
  action: string;
  method: string;
  /** the route's pattern; :names are filled in */
  path: string;
  roles: readonly Role[];
  mustChange: boolean;
  /** a body that is accepted for the route, if it needs one */
  payload?: unknown;
  /** The query string (with its ?) of a read whose page takes other keys than `limit`; checkReadColumns asks for `?limit=1000` without it (a sync page). A read refuses keys it does not know (422). */
  query?: string;
}

/**
 * One cell of T-D02: the call of one caller to one route, compared with what `route` (the matrix row, or a mutated copy of it) says. Returns null when they agree.
 * An allowed cell may end in 200, 201, 409 or 422 (the business rule or the body may say no) but never in 401 or 403.
 */
export async function checkCell(world: World, route: CellRoute, caller: CallerName): Promise<string | null> {
  const expected = expectedFor(route, caller);
  const before = world.spy.sent.length;
  const handledBefore = world.handled.length;
  const res = await world.call(caller, route.method, concreteUrl(route.path), route.payload === undefined ? {} : { payload: route.payload });
  const problems: string[] = [];
  await world.restore(caller); // a call may have ended or moved the session (a logout does): the next cell starts from the fixture
  if (expected.kind === 'allowed') {
    if (res.statusCode === 401 || res.statusCode === 403) problems.push(`status ${res.statusCode} ${errorOf(res)?.code ?? ''}, the matrix lets ${caller} in`);
  } else {
    problems.push(...refusalProblems(world, res, expected, before));
    if (world.handled.slice(handledBefore).includes(route.action)) problems.push('the handler ran for a refused caller');
  }
  return problems.length === 0 ? null : `${caller} on ${route.method} ${route.path} (${route.action}): ${problems.join('; ')}`;
}

/** A route whose public answer must not depend on any session: even a dead cookie gets in. */
export async function checkPublicCell(world: World, route: { method: string; path: string }, caller: CallerName): Promise<string | null> {
  const res = await world.call(caller, route.method, concreteUrl(route.path));
  return res.statusCode === 401 || res.statusCode === 403 ? `${caller} on ${route.method} ${route.path}: ${res.statusCode}, a public route answers everyone` : null;
}

/** The keys of the rows in a read answer ({rows: [...]}) must be among the columns the matrix lists for the caller's role (A4: a read names its columns). */
export async function checkReadColumns(world: World, route: CellRoute, caller: Role, allowed: readonly string[]): Promise<string | null> {
  const res = await world.call(caller, route.method, `${concreteUrl(route.path)}${route.query ?? '?limit=1000'}`);
  if (res.statusCode !== 200) return `${caller} on ${route.method} ${route.path}: status ${res.statusCode}, expected a 200 read`;
  const keys = new Set<string>();
  for (const row of (JSON.parse(res.body) as { rows?: Record<string, unknown>[] }).rows ?? []) for (const k of Object.keys(row)) keys.add(k);
  const extra = [...keys].filter((k) => !allowed.includes(k));
  return extra.length === 0 ? null : `${caller} on ${route.method} ${route.path}: columns outside READ_COLUMNS: ${extra.join(', ')}`;
}

/**
 * The column cells of an edit (NODE-DESIGN 3.5): an allowed column works, a column that exists but is not on the role's list is 403 JV_FORBIDDEN (not silently ignored), an unknown column is
 * 422 JV_INVALID_INPUT. `shape` says how the body is written: {expected_updated_at, changes:{...}} for a PATCH, or the fields themselves.
 */
export async function checkWriteColumns(
  world: World,
  route: CellRoute & { shape: 'changes' | 'fields' },
  caller: Role,
  columns: { allowed: readonly string[]; forbidden: readonly string[] },
): Promise<string[]> {
  const body = (column: string) => (route.shape === 'changes' ? { expected_updated_at: '2026-10-17T10:00:00.000000Z', changes: { [column]: null } } : { [column]: null });
  const problems: string[] = [];
  const send = (column: string) => world.call(caller, route.method, concreteUrl(route.path), { payload: body(column) });
  for (const column of columns.allowed) {
    const res = await send(column);
    const e = errorOf(res);
    if (res.statusCode === 401 || res.statusCode === 403 || (e?.code === 'JV_INVALID_INPUT' && /not a field/i.test(e.message))) problems.push(`${caller} on ${route.action}: the column ${column} is on the list and was refused (${res.statusCode} ${e?.code ?? ''})`);
  }
  for (const column of columns.forbidden) {
    const res = await send(column);
    if (res.statusCode !== 403 || errorOf(res)?.code !== 'JV_FORBIDDEN') problems.push(`${caller} on ${route.action}: the column ${column} is not on the list and the answer was ${res.statusCode} ${errorOf(res)?.code ?? ''}, not 403 JV_FORBIDDEN`);
  }
  const unknown = await send('no_such_column_x');
  if (unknown.statusCode !== 422 || errorOf(unknown)?.code !== 'JV_INVALID_INPUT') problems.push(`${caller} on ${route.action}: an unknown column was answered ${unknown.statusCode} ${errorOf(unknown)?.code ?? ''}, not 422 JV_INVALID_INPUT`);
  return problems;
}
