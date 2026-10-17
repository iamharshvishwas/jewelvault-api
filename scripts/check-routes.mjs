#!/usr/bin/env node
// npm run check:routes (T-D01, A1): prints every route the built app registers, with what it is (a session route with its action and roles, a public route, a token door), and every row of the
// permission matrix that has no route yet, with its address. Exits 1 when the build is missing, when the app cannot be built (a route registered without route() fails the start) or when
// /healthz is not there. Usage: node scripts/check-routes.mjs [dist-folder]   (default: dist, the output of npm run build)
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const dist = process.argv[2] ? resolve(process.argv[2]) : join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
if (!existsSync(join(dist, 'app.js')) || !existsSync(join(dist, 'permissions', 'route.js'))) {
  console.error(`${dist}/app.js or permissions/route.js is missing: run npm run build first`);
  process.exit(1);
}
const load = (file) => import(pathToFileURL(join(dist, file)).href);
const { buildApp } = await load('app.js');
const { describeRoutes, unroutedActions, unroutedPublic } = await load('permissions/route.js');
const { MATRIX, PUBLIC_ROUTES } = await load('permissions/matrix.js');

const config = { port: 0, logLevel: 'silent', allowedOrigins: ['https://check.example.test'], db: { host: '127.0.0.1', port: 3306, name: 'check', user: 'check', password: 'not-used' } };
let app;
try {
  app = buildApp({ config });
  await app.ready();
} catch (error) {
  console.error(`the application could not be built: ${error.message}`);
  process.exit(1);
}
const lines = describeRoutes(app);
const waiting = unroutedActions(app);
console.log(`${lines.length} routes registered:`);
for (const line of lines) console.log(`  ${line}`);
console.log('');
console.log(`${waiting.length} of ${Object.keys(MATRIX).length} rows of the matrix are waiting for their route (the task that builds the route registers it with route(); the generated test walks it from then on):`);
for (const action of waiting) {
  const row = MATRIX[action];
  console.log(`  ${row.method} ${row.path}  ${action}  roles=${row.roles.join(',')}`);
}
const waitingPublic = unroutedPublic(app);
console.log('');
console.log(`${waitingPublic.length} of ${Object.keys(PUBLIC_ROUTES).length} places on the public list are waiting for their route:`);
for (const name of waitingPublic) console.log(`  ${PUBLIC_ROUTES[name].method} ${PUBLIC_ROUTES[name].path}  public ${name}`);
const hasHealth = app.routeTable.some((r) => r.url === '/healthz');
await app.close();
if (!hasHealth) {
  console.error('/healthz is not registered');
  process.exit(1);
}
