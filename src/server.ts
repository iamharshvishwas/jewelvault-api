// The production entry (dist/server.js). The environment is read here, once; a missing variable stops the start with exit code 1 before any port is opened.
import { buildApp } from './app.js';
import { ConfigError, loadConfig } from './config.js';
import { createDbPool } from './db/pool.js';

let config;
try {
  config = loadConfig(process.env);
} catch (error) {
  if (error instanceof ConfigError) {
    process.stderr.write(`jewelvault-api: not starting: ${error.message}\n`);
    process.exit(1);
  }
  throw error;
}

// S11: one pool of 8; the start-up check runs when the app becomes ready, before listen() accepts a request. A failed check keeps the API up and answers 503 JV_UNAVAILABLE to all but /healthz.
const app = buildApp({ config, db: createDbPool(config.db) });
try {
  await app.listen({ port: config.port, host: '0.0.0.0' });
} catch (error) {
  app.log.error(error, 'could not listen');
  process.exit(1);
}
