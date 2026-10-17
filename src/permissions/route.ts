// A1, A6, A11, D2, S10, U11: route() is the only way to register an endpoint.
//
//   route(app, { action: 'fn:create_bill', body: schema, handler })    a session route: its address and its roles come from the row of the permission matrix (matrix.ts)
//   route(app, { public: 'ready', handler })                           one of the short list of public routes (PUBLIC_ROUTES): no session is looked up
//   route(app, { token: 'admin', method, url, verify, handler })       a route of a token door (/admin/v1/*, /internal/jobs/*), with its own token check, `verify`
//
// For a session route the order of work is fixed (A6, NODE-DESIGN 3.1), and each step ends the call when it refuses, so that a refused caller learns nothing about the next:
//   1. the session: the cookie's ticket to a `sessions` row and then the `users` row; no ticket, an ended or expired session, a user who is not active: 401 (D2, session.ts)
//   2. the must-change-password gate: a user who must still change the password may call only the rows marked `mustChange` (U11): 403 JV_PASSWORD_CHANGE_REQUIRED
//   3. the matrix row: a role that is not on the row: 403 JV_FORBIDDEN
//      then, for a call that got through and is not polling (U4): `last_seen_at` moves, in a statement of its own in autocommit (touchSession)
//   4. the body, with the route's strict Zod schema (a route without one takes no body): 422 JV_INVALID_INPUT
//   5. the handler, which is given `auth` (the user and the role as the read of step 1 found them), the parsed `body`, the request and the reply
// Steps 1 to 3 run in Fastify's onRequest, before the body is read: a caller who is refused is not told whether the body parses either.
//
// A route registered any other way fails the start: installRouteGuard() makes every route that did not come through route() throw. A call with no action, an action that is not in the matrix,
// a public name that is not on the list, a token route outside its door or without its check throws a RouteDeclarationError, and the types of the specs below make the compiler refuse the
// same calls, so a route without an action fails the build and not only the start. Nothing here holds a role string: roles are read from the matrix, and a service function that wants to check
// again at its start calls assertMayCall(role, action).
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodType, output } from 'zod';
import { JvError, errorBody } from '../errors.js';
import * as wire from '../wire/zod.js';
import {
  type Action,
  FRAMEWORK_ROUTES,
  type HttpMethod,
  MATRIX,
  type MatrixRow,
  PUBLIC_ROUTES,
  type PublicName,
  type PublicRoute,
  type Role,
  TOKEN_DOORS,
  type TokenDoor,
  type TokenDoorName,
  mayCall,
} from './matrix.js';
import { type Auth, countsAsActivity, lookupSession, touchSession } from './session.js';

export type { Auth } from './session.js';

/** A bug in the code that registers a route. It stops the start; it never reaches a client. */
export class RouteDeclarationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RouteDeclarationError';
  }
}

/** One registered route, as the route list shows it (T-D01). */
export interface RouteInfo {
  readonly method: HttpMethod;
  readonly url: string;
  readonly kind: 'matrix' | 'public' | 'token';
  /** the action of a matrix route */
  readonly action?: string;
  /** the name of a public route, or the door of a token route */
  readonly name?: string;
  /** who may call a matrix route; empty for the others (a public route is open, a token route has its own check) */
  readonly roles: readonly Role[];
  /** U11: a user who must still change the password may call it */
  readonly mustChange: boolean;
}

declare module 'fastify' {
  interface FastifyInstance {
    /** Every route registered through route(), in order (T-D01, check:routes, the generated test). */
    routeTable: RouteInfo[];
  }
  interface FastifyRequest {
    /** The user and the session of step 1; null on a public or token route. */
    auth: Auth | null;
  }
}

/** Only this module can put the mark on a route's config, so a route can not claim to have come through route(). */
const MARK = Symbol('jv.route');

type BodyOf<S> = S extends ZodType ? output<S> : undefined;

export interface SessionSpec<A extends string, S extends ZodType | undefined> {
  /** A row of the permission matrix: its address, its roles and its U11 flag come from there. */
  action: A;
  public?: never;
  token?: never;
  method?: never;
  url?: never;
  /** The strict schema of the body (wire.strictObject). A route without one takes no body. */
  body?: S;
  /** Return the payload, or send the reply yourself and return `reply`. */
  handler: (c: { app: FastifyInstance; request: FastifyRequest; reply: FastifyReply; auth: Auth; body: BodyOf<S> }) => unknown;
}

export interface PublicSpec<N extends string, S extends ZodType | undefined> {
  /** A name on the public list (PUBLIC_ROUTES): its address comes from there. */
  public: N;
  action?: never;
  token?: never;
  method?: never;
  url?: never;
  body?: S;
  handler: (c: { app: FastifyInstance; request: FastifyRequest; reply: FastifyReply; body: BodyOf<S> }) => unknown;
}

export interface TokenSpec<D extends string, S extends ZodType | undefined> {
  /** The door: its routes live under its address (TOKEN_DOORS). */
  token: D;
  action?: never;
  public?: never;
  method: HttpMethod;
  /** Under the door's address. */
  url: string;
  /** The door's own token check: throws a JvError to refuse. It runs first and alone; no session is looked up. */
  verify: (request: FastifyRequest) => void | Promise<void>;
  body?: S;
  handler: (c: { app: FastifyInstance; request: FastifyRequest; reply: FastifyReply; body: BodyOf<S> }) => unknown;
}

export type RouteSpec<S extends ZodType | undefined = undefined> = SessionSpec<Action, S> | PublicSpec<PublicName, S> | TokenSpec<TokenDoorName, S>;

/** What the wrapper checks a spec against. The application has one (the matrix file); a test may build another. */
export interface PermissionTable {
  readonly matrix: Readonly<Record<string, MatrixRow>>;
  readonly publicRoutes: Readonly<Record<string, PublicRoute>>;
  readonly tokenDoors: Readonly<Record<string, TokenDoor>>;
}

const PERMISSIONS: PermissionTable = { matrix: MATRIX, publicRoutes: PUBLIC_ROUTES, tokenDoors: TOKEN_DOORS };

/** A spec as the wrapper meets it at run time, where nothing the types promised can be trusted. */
interface LooseSpec {
  action?: unknown;
  public?: unknown;
  token?: unknown;
  method?: unknown;
  url?: unknown;
  verify?: unknown;
  body?: ZodType;
  handler?: unknown;
}

// ------------------------------------------------------------------ what a route does

/** A call without a schema takes no body: an empty one (none, null or {}) is fine, anything else is an unknown field (A14). */
function noBody(request: FastifyRequest): undefined {
  const b = request.body;
  if (b === undefined || b === null) return undefined;
  if (typeof b === 'object' && !Array.isArray(b) && Object.keys(b).length === 0) return undefined;
  throw new wire.InvalidInputError('body', 'is not accepted by this call');
}

const parseBody = (spec: LooseSpec, request: FastifyRequest): unknown => (spec.body ? wire.parseInput(spec.body, request.body) : noBody(request));

/** Steps 1 to 3 for a session route. */
function sessionHook(app: FastifyInstance, info: RouteInfo) {
  return async (request: FastifyRequest): Promise<void> => {
    const auth = await lookupSession(app, request); // 1. D2
    if (auth.user.mustChangePassword && !info.mustChange) throw new JvError('JV_PASSWORD_CHANGE_REQUIRED', 'Change your password to continue.'); // 2. U11
    if (!info.roles.includes(auth.user.role)) throw new JvError('JV_FORBIDDEN', 'You are not allowed to do this.'); // 3. A4
    if (countsAsActivity(info)) await touchSession(app, request, auth.session.id); // U4: last_seen_at, its own autocommit statement, before the handler and so before any claim of a money call
    request.auth = auth;
  };
}

function register(table: PermissionTable, app: FastifyInstance, loose: LooseSpec): void {
  const fail = (message: string): never => {
    throw new RouteDeclarationError(message);
  };
  if (typeof loose.handler !== 'function') fail('route() needs a handler');
  const handler = loose.handler as (c: Record<string, unknown>) => unknown;
  if (!Array.isArray(app.routeTable)) fail('this application was not built with installPermissions(): it has no route table');

  const given = [loose.action, loose.public, loose.token].filter((v) => v !== undefined);
  if (given.length !== 1) fail('every endpoint has an action of the permission matrix, or a place on the public list, or a token door: exactly one of `action`, `public` and `token`');

  let info: RouteInfo;
  if (loose.action !== undefined) {
    const action = loose.action;
    if (typeof action !== 'string' || !Object.hasOwn(table.matrix, action)) return fail(`the action ${JSON.stringify(String(action))} is not a row of the permission matrix (src/permissions/matrix.ts)`);
    if (loose.method !== undefined || loose.url !== undefined || loose.verify !== undefined) fail(`the route of ${action} comes from its row of the matrix: give an action and a handler, nothing else`);
    if (app.routeTable.some((r) => r.action === action)) fail(`${action} already has a route: a row of the matrix has one`);
    const row = table.matrix[action];
    info = { method: row.method, url: row.path, kind: 'matrix', action, roles: row.roles, mustChange: row.mustChange };
  } else if (loose.public !== undefined) {
    const name = loose.public;
    if (typeof name !== 'string' || !Object.hasOwn(table.publicRoutes, name)) return fail(`${JSON.stringify(String(name))} is not on the public list (src/permissions/matrix.ts PUBLIC_ROUTES)`);
    if (loose.method !== undefined || loose.url !== undefined || loose.verify !== undefined) fail(`the address of the public route ${name} comes from the list: give the name and a handler, nothing else`);
    if (app.routeTable.some((r) => r.kind === 'public' && r.name === name)) fail(`the public route ${name} is already registered`);
    const p = table.publicRoutes[name];
    info = { method: p.method, url: p.path, kind: 'public', name, roles: [], mustChange: false };
  } else {
    const door = loose.token;
    if (typeof door !== 'string' || !Object.hasOwn(table.tokenDoors, door)) return fail(`${JSON.stringify(String(door))} is not a token door (src/permissions/matrix.ts TOKEN_DOORS)`);
    if (typeof loose.verify !== 'function') fail(`a route of the ${door} door needs its token check (verify)`);
    if (typeof loose.url !== 'string' || !loose.url.startsWith(table.tokenDoors[door].prefix)) fail(`a route of the ${door} door lives under ${table.tokenDoors[door].prefix}`);
    if (typeof loose.method !== 'string') fail(`a route of the ${door} door needs a method`);
    info = { method: loose.method as HttpMethod, url: loose.url as string, kind: 'token', name: door, roles: [], mustChange: false };
  }

  const verify = loose.verify as ((request: FastifyRequest) => void | Promise<void>) | undefined;
  app.route({
    method: info.method,
    url: info.url,
    // a session or token route answers its own method only; the public routes keep the HEAD that Fastify adds for a GET (a health probe may use it)
    exposeHeadRoute: info.kind === 'public',
    config: { [MARK]: info },
    onRequest: info.kind === 'matrix' ? [sessionHook(app, info)] : info.kind === 'token' ? [async (request: FastifyRequest) => void (await verify!(request))] : [],
    handler: async (request, reply) => {
      const body = parseBody(loose, request); // 4
      const context: Record<string, unknown> = { app, request, reply, body };
      if (info.kind === 'matrix') context.auth = request.auth; // 5
      return handler(context);
    },
  });
  app.routeTable.push(info);
}

/** A spec for a wrapper over a table of its own (createRoute): the names are plain strings, the body is not typed, and what route() forbids by type is checked when it is registered. */
export interface TableSpec {
  action?: string;
  public?: string;
  token?: string;
  method?: HttpMethod;
  url?: string;
  verify?: (request: FastifyRequest) => void | Promise<void>;
  body?: ZodType;
  handler: (c: { app: FastifyInstance; request: FastifyRequest; reply: FastifyReply; body: unknown; auth: Auth }) => unknown;
}

/** A route() over a permission table of its own. The application uses route() below, over the matrix file; tests use this to build a wrapper over a table they control (a toy route for a test of something else is a public route of a table made for the test). */
export function createRoute(table: PermissionTable): (app: FastifyInstance, spec: TableSpec) => void {
  return (app, spec) => register(table, app, spec as LooseSpec);
}

/** The only way to register an endpoint (A1). */
export function route<S extends ZodType | undefined = undefined>(app: FastifyInstance, spec: RouteSpec<S>): void {
  register(PERMISSIONS, app, spec as LooseSpec);
}

// ------------------------------------------------------------------ the guard, the 404, the route list

/**
 * Every route that is not registered through route() throws when it is registered (Fastify's onRoute hook runs for every route of this instance and of every plugin inside it): the start fails,
 * and so does `app.get(...)` at the line that wrote it. `allowed` names the routes a plugin registers for itself and that cannot come through route(); the application's list is empty.
 */
export function installRouteGuard(app: FastifyInstance, allowed: readonly { method: string; url: string; why?: string }[] = FRAMEWORK_ROUTES): void {
  app.addHook('onRoute', (opts) => {
    if ((opts.config as Record<symbol, unknown> | undefined)?.[MARK] !== undefined) return;
    for (const method of Array.isArray(opts.method) ? opts.method : [opts.method]) {
      if (allowed.some((a) => a.method === method && a.url === opts.url)) continue;
      throw new RouteDeclarationError(`${method} ${opts.url} was registered without route(): every endpoint goes through route() with an action of the permission matrix (A1)`);
    }
  });
}

/** Everything that route() and the guard need from the application: the route table, the slot for `request.auth`, the guard, and the answer for a path that is not in the matrix (A11). */
export function installPermissions(app: FastifyInstance): void {
  app.decorate('routeTable', []);
  app.decorateRequest('auth', null);
  installRouteGuard(app);
  // A11: no GraphQL, no generic table route, no sign-up: whatever is not a route answers 404, to everyone, and no session is looked up
  app.setNotFoundHandler((request, reply) => reply.code(404).send(errorBody(new JvError('JV_NOT_FOUND', 'There is nothing at this address.'), request.id)));
}

/**
 * A service function checks the role again at its start (X0 item 2, A6): after the idempotency claim, whose row the rollback removes when this refuses. It asks the matrix for the action, so
 * it holds no role string.
 */
export function assertMayCall(role: string, action: Action): void {
  if (!mayCall(role, action)) throw new JvError('JV_FORBIDDEN', 'You are not allowed to do this.');
}

/** The route list (T-D01, A1), one line for every registered route: method, address, what it is, its action and its roles. */
export function describeRoutes(app: FastifyInstance): string[] {
  return app.routeTable.map((r) => {
    const what = r.kind === 'matrix' ? `session  ${r.action}  roles=${r.roles.join(',')}${r.mustChange ? '  (open while the password must be changed)' : ''}` : r.kind === 'public' ? `public   ${r.name}  (no session)` : `token    ${r.name}  (own token check)`;
    return `${r.method.padEnd(6)} ${r.url.padEnd(46)} ${what}`;
  });
}

/** The rows of the matrix that have no route yet: the task that builds the route registers it, and the generated test walks it from then on. */
export function unroutedActions(app: FastifyInstance, matrix: Readonly<Record<string, MatrixRow>> = MATRIX): string[] {
  const routed = new Set(app.routeTable.map((r) => r.action));
  return Object.keys(matrix).filter((a) => !routed.has(a));
}

/** The places on the public list that have no route yet (/readyz, the login and the photo read are built by later tasks). */
export function unroutedPublic(app: FastifyInstance, publicRoutes: Readonly<Record<string, PublicRoute>> = PUBLIC_ROUTES): string[] {
  const routed = new Set(app.routeTable.filter((r) => r.kind === 'public').map((r) => r.name));
  return Object.keys(publicRoutes).filter((n) => !routed.has(n));
}
