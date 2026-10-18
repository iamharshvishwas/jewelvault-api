import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyBaseLogger, type FastifyInstance, type FastifyRequest } from 'fastify';
import { type Clock, systemClock } from './clock.js';
import type { Config } from './config.js';
import type { DbPool } from './db/pool.js';
import { BusyError, type JvError, classifyError, describeCause, errorBody, unavailableError } from './errors.js';
import { checkBackupFolderAtStart } from './jobs/backupProbe.js';
import { createLogger } from './logging.js';
import { installPermissions, route } from './permissions/route.js';
import { type PreflightResult, runPreflight } from './preflight.js';
import { registerRoutes } from './routes.js';
import { answerBadAddress } from './security/badAddress.js';
import { type ErrorLog, createErrorLog, errorLogEntry, startupEntries } from './security/errorLog.js';
import { installSecurity } from './security/index.js';
import { type RequestTimers, defaultTimers, requestLimits } from './security/requestLimits.js';

declare module 'fastify' {
  interface FastifyInstance {
    /** The API's one clock (S5). Read-only: there is no setter. */
    clock: Clock;
    config: Config;
    /** The one connection pool (S11), or null in a test that never touches a database. */
    db: DbPool | null;
    /** The result of the start-up check; null until it has run, and always null without a pool. */
    startup: PreflightResult | null;
    /** D25, A14: where the unexpected errors are kept (sys_error_log, at most 20 rows a minute for each code). record() returns at once; idle() waits for what was handed over. */
    errorLog: ErrorLog;
  }
  interface FastifyRequest {
    /** When the request arrived, on the monotonic clock (performance.now()): the 12-second deadline of S12 counts from here, the wait for a pool connection included. */
    arrivedAt: number;
  }
}

export interface BuildAppOptions {
  /** Read and checked by server.ts, once; tests pass their own. The app never reads the environment itself. */
  config: Config;
  /** A seam for tests. server.ts never passes it, so a production process always runs on the system clock. */
  clock?: Clock;
  /** A seam for tests: where the log lines go. Default: standard output. */
  logStream?: NodeJS.WritableStream;
  /**
   * The one pool (S11), made by server.ts. With a pool the start-up check runs when the app becomes ready (before listen() accepts anything) and, until it has passed, every request except
   * /healthz is answered 503 JV_UNAVAILABLE. Without one (the tests of tasks that never touch a database) there is no check and no gate.
   */
  db?: DbPool;
  /**
   * A seam for tests: false builds the app without the application's routes (src/routes.ts), keeping the permission wrapper, /healthz, the error handler and the start-up gate, so a test can
   * register routes of its own (a toy route, a stub for every row of the matrix) without meeting the real ones. server.ts never passes it.
   */
  routes?: boolean;
  /**
   * A seam for tests: shorter timers than the spec's (A14: 30 s to receive a request, 25 s for a call, 30 s for the login, 50 s for the job tick), so that a test of a timer need not wait that long.
   * server.ts never passes it.
   */
  timers?: Partial<RequestTimers>;
}

/** S11: the one thing a client is told when the start-up check failed. The reason is in the log only. The S8 body: error code, message and details, and the request id. */
const unavailableBody = (request: FastifyRequest) => errorBody(unavailableError(), request.id);

/** What the log says about an answered error. A busy answer is a warning with its reason; an internal error or a bug is an error with the cause; the rest (a refused input, a business rule) is the caller's and not logged here. */
function logAnswer(request: FastifyRequest, answer: JvError, original: unknown) {
  const cause = describeCause(answer.cause ?? original);
  if (answer.code === 'JV_INTERNAL' || answer.bug) request.log.error({ request_id: request.id, code: answer.code, bug: answer.bug, cause }, answer.bug ? 'the database refused what the API\'s own checks should have caught: a bug' : 'request failed');
  else if (answer instanceof BusyError) request.log.warn({ request_id: request.id, code: answer.code, reason: answer.reason, outcome_unknown: answer.outcomeUnknown, cause: answer.cause === undefined ? undefined : cause }, 'answered JV_BUSY');
  else if (answer.code === 'JV_UNAVAILABLE') request.log.warn({ request_id: request.id, code: answer.code, cause }, 'answered JV_UNAVAILABLE');
}

/** The two routes that answer while the start-up check has not passed: /healthz (the process is up) and /readyz (it says whether the check passed). Neither says why. */
const isHealthCheck = (request: FastifyRequest) => (request.method === 'GET' || request.method === 'HEAD') && ['/healthz', '/readyz'].includes(request.url.split('?')[0]);

function logStartup(log: FastifyBaseLogger, r: PreflightResult) {
  if (r.ok) log.info({ version: r.version, amber: r.amber }, 'start-up check passed');
  else log.error({ problems: r.problems }, 'start-up check failed: every request except /healthz and /readyz now answers 503 JV_UNAVAILABLE');
  if (r.amber) log.warn({ rights: r.outsideTenBoxes }, 'the database user holds a Delete or Drop right (S7): the owner\'s dashboard line is amber (I12)');
  if (r.outsideTenBoxes.length > 0) log.warn({ rights: r.outsideTenBoxes }, 'the database user holds rights outside the ten boxes of A3');
}

/** The Fastify application, not yet listening. inject() works on it; server.ts listens. */
export function buildApp(options: BuildAppOptions): FastifyInstance {
  const { config } = options;
  const timers: RequestTimers = { ...defaultTimers(), ...options.timers };
  // the request id is a UUID: it goes to audit_log.request_id (a UUID column) through @jv_request, and back to the client in the error body
  const app: FastifyInstance = Fastify({
    loggerInstance: createLogger(config.logLevel, options.logStream),
    genReqId: () => randomUUID(),
    // RV1-6, A14: an address the router cannot take (a broken percent sign, a segment over 100 characters) would be answered by Fastify itself, with its own body and none of our headers; it is made
    // readable and put through the router again instead, and is then an address that is not a route (src/security/badAddress.ts)
    frameworkErrors: (error, request, reply) => answerBadAddress(app, error, request, reply),
    // A14: a body is at most 1 MiB (the photo upload has its own, src/security), receiving a request may take 30 s, a call 25 s (the login and the job tick have their own).
    // Node enforces requestTimeout only when headersTimeout is not longer than it (its default is 60 s: measured, a 30 s requestTimeout then cuts nothing), so the headers get the same 30 s; and it
    // looks for requests that have run out of time every 30 s unless told otherwise, so it is told to look every second.
    bodyLimit: requestLimits.bodyBytes,
    requestTimeout: timers.requestMs,
    handlerTimeout: timers.handlerMs,
    http: { headersTimeout: timers.requestMs, connectionsCheckingInterval: Math.min(1000, timers.requestMs) },
  });
  // A1: from here on every route must come through route() (src/permissions/route.ts), and a path that is not a route answers 404 (A11)
  installPermissions(app);
  app.decorate('config', config);
  app.decorate('clock', options.clock ?? systemClock);
  app.decorate('db', options.db ?? null);
  app.decorate('startup', null);
  app.decorate('errorLog', createErrorLog(options.db ?? null, app.log));
  app.decorateRequest('arrivedAt', 0);
  // the first hook of every request: the deadline of S12 starts here
  app.addHook('onRequest', async (request) => {
    request.arrivedAt = performance.now();
  });
  // H7, shutdown: once close() has begun (SIGTERM) a call that is already running finishes, and every response says Connection: close. Without it Fastify keeps an idle keep-alive connection
  // for 72 s (and Hostinger's front end keeps connections to the app), which would hold the shutdown to its limit although every call had finished.
  let closing = false;
  app.addHook('preClose', async () => {
    closing = true;
  });
  app.addHook('onSend', async (_request, reply) => {
    if (closing) reply.header('Connection', 'close');
  });
  // S8: every error is answered as {"error":{"code","message","details"},"request_id"} with its status; JV_BUSY carries Retry-After: 1. A JvError goes out as it is, a database error by the map of
  // src/errors.ts, anything else is JV_INTERNAL with no detail (A14); the detail goes to the log.
  app.setErrorHandler((error, request, reply) => {
    const answer = classifyError(error);
    logAnswer(request, answer, error);
    // D25: an unexpected error is kept in sys_error_log beyond the log window; the row is written after the answer is on its way (it never waits for it) and holds no customer data
    try {
      const entry = errorLogEntry(request, answer, error);
      if (entry) app.errorLog.record(entry, new Date(Number(app.clock.read().micros / 1000n)));
    } catch (e) {
      request.log.warn({ cause: describeCause(e) }, 'error log: an entry could not be made'); // the answer must go out whatever happens here
    }
    if (answer.retryAfter !== undefined) reply.header('Retry-After', String(answer.retryAfter));
    return reply.code(answer.status).send(errorBody(answer, request.id));
  });

  const db = options.db;
  if (db) {
    db.setLogger(app.log);
    // fastify runs onReady hooks before listen() accepts a connection (and before the first inject()): the check comes first. It never throws; a failure is its result.
    app.addHook('onReady', async () => {
      app.startup = await runPreflight(db);
      logStartup(app.log, app.startup);
      // A14: the reason goes to sys_error_log (and so to the owner's dashboard line) and to nobody else; /healthz and /readyz say only whether
      const at = new Date(Number(app.clock.read().micros / 1000n));
      for (const startupEntry of startupEntries(app.startup)) app.errorLog.record(startupEntry, at);
      // B2, I12 (spec 5.2.2): the backup folder exists and is writable. A folder that is not does NOT stop the start (the shop works without it): it is recorded for the owner's dashboard line
      if (config.backupDir !== undefined) await checkBackupFolderAtStart(db, config.backupDir, at.getTime(), app.log);
    });
    // S11: a failed check keeps the API up and answers 503 JV_UNAVAILABLE to everything except /healthz and /readyz; until the check has run, nothing is served either.
    app.addHook('onRequest', async (request, reply) => {
      if (app.startup?.ok || isHealthCheck(request)) return;
      return reply.code(503).send(unavailableBody(request));
    });
    app.addHook('onClose', async () => {
      await app.errorLog.idle(); // what is queued is written before the pool is closed
      await db.end();
    });
  }

  // A12, A14: CORS, the CSRF layers, the security headers, the body limits and the timers. Before the first route is registered: it hooks the registration of every route.
  installSecurity(app, config, timers);

  route(app, { public: 'health', handler: async () => ({ ok: true }) });
  if (options.routes !== false) registerRoutes(app);

  return app;
}
