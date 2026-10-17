import Fastify, { type FastifyBaseLogger, type FastifyInstance, type FastifyRequest } from 'fastify';
import { type Clock, systemClock } from './clock.js';
import type { Config } from './config.js';
import type { DbPool } from './db/pool.js';
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
function unavailableBody(request: FastifyRequest) {
  return { error: { code: 'JV_UNAVAILABLE', message: 'The service is not available. Try again in a moment.', details: {} }, request_id: request.id };
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
  const app = Fastify({ loggerInstance: createLogger(config.logLevel, options.logStream) });
  app.decorate('config', config);
  app.decorate('clock', options.clock ?? systemClock);
  app.decorate('db', options.db ?? null);
  app.decorate('startup', null);

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
