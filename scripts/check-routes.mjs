#!/usr/bin/env node
// npm run check:routes: prints every route the built app registers (dist/app.js). API04 replaces this with the permission matrix and its roles per route.
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
if (!existsSync(join(dist, 'app.js'))) {
  console.error('dist/app.js is missing: run npm run build first');
  process.exit(1);
}
const { buildApp } = await import(join(dist, 'app.js'));
const config = { port: 0, logLevel: 'silent', db: { host: '127.0.0.1', port: 3306, name: 'check', user: 'check', password: 'not-used' } };
const app = buildApp({ config });
await app.ready();
const printed = app.printRoutes({ commonPrefix: false });
console.log(printed.trimEnd());
await app.close();
if (!/healthz/.test(printed)) {
  console.error('/healthz is not registered');
  process.exit(1);
}
