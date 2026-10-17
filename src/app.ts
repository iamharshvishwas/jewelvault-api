import Fastify, { type FastifyInstance } from 'fastify';
import { type Clock, systemClock } from './clock.js';
import type { Config } from './config.js';
import { createLogger } from './logging.js';

declare module 'fastify' {
  interface FastifyInstance {
    /** The API's one clock (S5). Read-only: there is no setter. */
    clock: Clock;
    config: Config;
  }
}

export interface BuildAppOptions {
  /** Read and checked by server.ts, once; tests pass their own. The app never reads the environment itself. */
  config: Config;
  /** A seam for tests. server.ts never passes it, so a production process always runs on the system clock. */
  clock?: Clock;
  /** A seam for tests: where the log lines go. Default: standard output. */
  logStream?: NodeJS.WritableStream;
}

/** The Fastify application, not yet listening. inject() works on it; server.ts listens. */
export function buildApp(options: BuildAppOptions): FastifyInstance {
  const { config } = options;
  const app = Fastify({ loggerInstance: createLogger(config.logLevel, options.logStream) });
  app.decorate('config', config);
  app.decorate('clock', options.clock ?? systemClock);

  app.get('/healthz', async () => ({ ok: true }));

  return app;
}
