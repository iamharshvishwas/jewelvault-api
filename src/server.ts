// The production entry (dist/server.js). The environment is read here, once; a missing variable stops the start with exit code 1 before any port is opened.
import { buildApp } from './app.js';
import { ConfigError, loadConfig } from './config.js';

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

const app = buildApp({ config });
try {
  await app.listen({ port: config.port, host: '0.0.0.0' });
} catch (error) {
  app.log.error(error, 'could not listen');
  process.exit(1);
}
