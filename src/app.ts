import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyBaseLogger, type FastifyInstance, type FastifyRequest } from 'fastify';
import { type Clock, systemClock } from './clock.js';
import type { Config } from './config.js';
import type { DbPool } from './db/pool.js';
import { BusyError, type JvError, classifyError, describeCause, errorBody, unavailableError } from './errors.js';
import { createLogger } from './logging.js';
import { type PreflightResult, runPreflight } from './preflight.js';

declare module 'fastify' {
  interface FastifyInstance {
    /** The API's one clock (S5). Read-only: there is no setter. */
    clock: Clock;
    config: Config;
    /** The one connection pool (S11), or null in a test that never touches a database. */
    db: DbPool | null;
    /** The result of the start-up check; null until it has run, and always null without a pool. */
    startup: PreflightResult | null;
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

const isHealthz = (request: FastifyRequest) => (request.method === 'GET' || request.method === 'HEAD') && request.url.split('?')[0] === '/healthz';

function logStartup(log: FastifyBaseLogger, r: PreflightResult) {
  if (r.ok) log.info({ version: r.version, amber: r.amber }, 'start-up check passed');
  else log.error({ problems: r.problems }, 'start-up check failed: every request except /healthz now answers 503 JV_UNAVAILABLE');
  if (r.amber) log.warn({ rights: r.outsideTenBoxes }, 'the database user holds a Delete or Drop right (S7): the owner\'s dashboard line is amber (I12)');
  if (r.outsideTenBoxes.length > 0) log.warn({ rights: r.outsideTenBoxes }, 'the database user holds rights outside the ten boxes of A3');
}

/** The Fastify application, not yet listening. inject() works on it; server.ts listens. */
export function buildApp(options: BuildAppOptions): FastifyInstance {
  const { config } = options;
  // the request id is a UUID: it goes to audit_log.request_id (a UUID column) through @jv_request, and back to the client in the error body
  const app = Fastify({ loggerInstance: createLogger(config.logLevel, options.logStream), genReqId: () => randomUUID() });
  app.decorate('config', config);
  app.decorate('clock', options.clock ?? systemClock);
  app.decorate('db', options.db ?? null);
  app.decorate('startup', null);
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
    });
    // S11: a failed check keeps the API up and answers 503 JV_UNAVAILABLE to everything except /healthz; until the check has run, nothing is served either.
    app.addHook('onRequest', async (request, reply) => {
      if (app.startup?.ok || isHealthz(request)) return;
      return reply.code(503).send(unavailableBody(request));
    });
    app.addHook('onClose', async () => {
      await db.end();
    });
  }

  app.get('/healthz', async () => ({ ok: true }));

  return app;
}
