// A12, A14 (API07): the layers around every request, installed once by buildApp(), in the order that matters:
//
//   1. helmet           the standard security headers, on every answer (it is an onRequest hook, so it runs first among these)
//   2. CORS             an exact list of origins from ALLOWED_ORIGINS, never *; a preflight is answered here, in the hook, before any session or route is touched
//   3. CSRF             X-JV-Client: web and an allowed Origin on every call that changes state (src/security/csrf.ts), else 403 JV_CSRF
//   (then the route's own hooks: the session lookup, the must-change gate, the matrix row, the body)
//   onSend: X-Request-Id and Cache-Control: no-store on every answer, the photo files excepted (src/security/headers.ts)
//   onRoute: the body limit of a route that is not the application's 1 MiB (the photo upload), and the handler timer of every route (25 s; the login 30 s; the job tick 50 s)
//
// Hooks run in the order they are added, and a plugin adds its hook when it is loaded, after the code that registered it has finished. So the three hooks above are added in one place, in
// order, after the plugins are loaded (app.after), and buildApp adds its own first hooks (the arrival time, the start-up gate) before this runs.
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import type { FastifyInstance } from 'fastify';
import type { Config } from '../config.js';
import { TOKEN_DOORS } from '../permissions/matrix.js';
import { csrfHook } from './csrf.js';
import { helmetOptions, responseHeaders } from './headers.js';
import { type RequestTimers, bodyLimitFor, handlerTimeoutFor } from './requestLimits.js';

export function installSecurity(app: FastifyInstance, config: Pick<Config, 'allowedOrigins'>, timers: RequestTimers): void {
  const allowed = config.allowedOrigins;
  const doorPrefixes = Object.values(TOKEN_DOORS).map((door) => door.prefix);
  if (allowed.length === 0 || allowed.some((o) => o === '*')) throw new TypeError('ALLOWED_ORIGINS is an exact list of origins: never empty, never *');

  app.addHook('onRoute', (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const method of methods) {
      const limit = bodyLimitFor(method, route.url);
      if (limit !== undefined) route.bodyLimit = limit;
    }
    route.handlerTimeout = handlerTimeoutFor(timers, methods[0], route.url);
    // a token door has a token of its own and no browser behind it: no CORS answer, whatever the origin (the admin door also refuses a call that carries an Origin header, U3)
    if (doorPrefixes.some((prefix) => route.url.startsWith(prefix))) route.config = { ...route.config, cors: false };
  });

  app.register(helmet, helmetOptions);
  app.register(cors, {
    // a LIST of strings, never a string, a boolean or a pattern: a list is answered with the request's own origin when it is equal to an entry, and with nothing else
    origin: [...allowed],
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Idempotency-Key', 'X-JV-Client'],
    exposedHeaders: ['Retry-After', 'X-Request-Id', 'Idempotent-Replay'],
    maxAge: 600,
    strictPreflight: true,
  });
  app.after(() => {
    app.addHook('onRequest', csrfHook(allowed));
  });
  app.addHook('onSend', responseHeaders);
}
