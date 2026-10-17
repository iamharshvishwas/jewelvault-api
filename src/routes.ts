// The application's routes: the one place buildApp() asks for them. Each task that builds routes adds its registration function here and calls it from registerRoutes(); a registration is
// route() calls and nothing else (src/permissions/route.ts), so every endpoint has an action of the permission matrix, a place on the public list or a token door (A1), and the generated test
// (tests/matrix.generated.test.ts) walks it for every caller as soon as it is registered.
//
// Registration happens when the app is built, before any request and before a database is needed: take `app.db` and `app.clock` inside a handler, never here. A test that wants the wrapper
// and the error handling without the application's routes builds the app with `routes: false`.
//
//   API05  the session routes (me, logout, change-password, activity) and the login
//   API09  the admin door and the job routes
//   API11  the read side (the sync resources, the poll) ...
import type { FastifyInstance } from 'fastify';
import { registerAuthRoutes } from './auth/loginRoutes.js';

export function registerRoutes(app: FastifyInstance): void {
  // /healthz is registered by buildApp() itself, because the start-up gate (S11) names it
  registerAuthRoutes(app);
}
