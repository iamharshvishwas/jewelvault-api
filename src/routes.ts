// The application's routes: the one place buildApp() asks for them. Each task that builds routes adds its registration function here and calls it from registerRoutes(); a registration is
// route() calls and nothing else (src/permissions/route.ts), so every endpoint has an action of the permission matrix, a place on the public list or a token door (A1), and the generated test
// (tests/matrix.generated.test.ts) walks it for every caller as soon as it is registered.
//
// Registration happens when the app is built, before any request and before a database is needed: take `app.db` and `app.clock` inside a handler, never here. A test that wants the wrapper
// and the error handling without the application's routes builds the app with `routes: false`.
//
//   API05  the session routes (me, logout, change-password, activity) and the login
//   API07  /readyz (below)
//   API09  the admin door and the job routes
//   API11  the read side (the sync resources, the poll) ...
import type { FastifyInstance } from 'fastify';
import { registerAdminRoutes } from './admin/routes.js';
import { registerAuthRoutes } from './auth/loginRoutes.js';
import { registerQuoteBill } from './money/x07QuoteBill.js';
import { route } from './permissions/route.js';
import { registerSyncRoutes } from './sync/routes.js';

export function registerRoutes(app: FastifyInstance): void {
  // /healthz is registered by buildApp() itself, because the start-up gate (S11) names it.
  registerAuthRoutes(app);
  registerSyncRoutes(app);
  registerAdminRoutes(app); // API09: the admin door, only while JV_ADMIN_TOKEN_HASH is set
  registerQuoteBill(app); // API18: X7 quote_bill
  // A14: /readyz says only whether the start-up check passed, {"ok":true} or {"ok":false} (503 while it has not): never why. The reason is in sys_error_log and the owner's dashboard line.
  route(app, { public: 'ready', handler: ({ app: a, reply }) => reply.code(a.startup?.ok === true ? 200 : 503).send({ ok: a.startup?.ok === true }) });
}
