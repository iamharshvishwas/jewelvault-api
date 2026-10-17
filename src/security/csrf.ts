// A12, NODE-DESIGN 2.6: THREE independent layers against a forged cross-site request, because SameSite alone is not a defence in every deployment (OWASP):
//   1. the session cookie is SameSite=Strict (U12, the login route sets it);
//   2. every call that changes state (anything but GET, HEAD and OPTIONS: POST, PATCH, PUT, DELETE) must carry `X-JV-Client: web`. A custom header makes the browser send a preflight first, and
//      the CORS list answers a preflight only for our own origin, so a page on another origin cannot add the header;
//   3. for such a call the `Origin` header must equal an allowed origin exactly. A missing or `null` Origin is refused: it is not proof that the call came from our page.
// Any failure is 403 JV_CSRF. The check runs for every route that is not a token route, ahead of the session lookup (it is an application hook, the session is a route hook), so a refused call
// reads nothing. It covers the login too (login CSRF, same rules).
//
// What it does not cover, on purpose: GET, HEAD and OPTIONS (no state change is reachable by GET: the matrix gives GET only to reads, tests/api/csrf.test.ts); a path that is not a route (it is a
// 404 whatever the headers, A11); and the token doors /admin/v1/* and /internal/jobs/* (a bearer token of their own, no cookie, no browser: there is nothing ambient to forge; the admin door
// refuses any call that carries an Origin header, API09).
import type { FastifyReply, FastifyRequest } from 'fastify';
import { JvError } from '../errors.js';
import { routeKindOf } from '../permissions/route.js';
import { isAllowedOrigin } from './origins.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** The header every state-changing call of the website carries, and its one value. */
export const CLIENT_HEADER = 'x-jv-client';
export const CLIENT_VALUE = 'web';

export type CsrfReason = 'client_header' | 'origin_missing' | 'origin_null' | 'origin_not_allowed';

/** Why a call is refused, or null when it passes. Pure: a function of the method, the headers and the list. */
export function csrfRefusal(method: string, headers: Record<string, unknown>, allowedOrigins: readonly string[]): CsrfReason | null {
  if (SAFE_METHODS.has(method)) return null;
  if (headers[CLIENT_HEADER] !== CLIENT_VALUE) return 'client_header';
  const origin = headers.origin;
  if (origin === undefined) return 'origin_missing';
  if (origin === 'null') return 'origin_null';
  return isAllowedOrigin(allowedOrigins, origin) ? null : 'origin_not_allowed';
}

/** The onRequest hook. The refusal is logged with its reason and the origin that was sent (a header is not secret; it is cut short); the client is told only that the call was refused. */
export function csrfHook(allowedOrigins: readonly string[]) {
  return async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    if (SAFE_METHODS.has(request.method) || request.is404) return;
    if (routeKindOf(request) === 'token') return;
    const reason = csrfRefusal(request.method, request.headers, allowedOrigins);
    if (reason === null) return;
    const origin = request.headers.origin;
    request.log.warn({ request_id: request.id, reason, origin: typeof origin === 'string' ? origin.slice(0, 200) : undefined }, 'answered JV_CSRF');
    throw new JvError('JV_CSRF', 'The request was refused. Reload the page and try again.');
  };
}
