// U3, A13, NODE-DESIGN 2.8: the check that stands in front of every call of the admin door (/admin/v1/*). It is the `verify` of route(app, { token: 'admin', ... }) and runs alone, before the body is read and
// with no session (the door has none), in this order, so that a call that is refused costs the least and tells the least:
//
//   1. an `Origin` header: refused (403 JV_FORBIDDEN) whatever else is in the request, the right token and an allowed origin included. A browser always sends one on a call made by a page, so a web page
//      can never call the door. It comes first and counts nothing, so a page cannot use up Harsh's calls either. The door sends no CORS headers (src/security/index.ts gives its routes `cors: false`),
//      so the page could not read an answer anyway.
//   2. a pause: after two wrong tokens in a row an address is paused for 15 minutes, and a call from it (the right token too) is 429 JV_RATE_LIMITED with the seconds left.
//   3. 10 calls a minute for each address (429 with Retry-After).
//   4. the token: `Authorization: Bearer <token>`. The SHA-256 of what was sent is compared in constant time with JV_ADMIN_TOKEN_HASH (both 32 bytes; a missing or malformed header is hashed as
//      the empty text, so every call does the same work). A wrong token is 401 JV_UNAUTHENTICATED and counts a wrong answer in a row; the second starts the pause. The right token ends the run.
//
// An address that cannot be trusted (no x-real-ip, or not one address, src/auth/limiter.ts visitorAddress) shares one key for the ten a minute, and gets no pause, because a stranger writing that
// address could pause Harsh out for 15 minutes again and again. In its place: at most 5 wrong tokens an hour for the whole API; the sixth is 429 with the seconds left. The right token is never
// refused for that reason, so a stranger cannot lock Harsh out at all.
import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { THROTTLES, limiterOf, rateLimited, visitorAddress } from '../auth/limiter.js';
import { JvError } from '../errors.js';

/** `Bearer`, one space, one token of printable characters (RFC 6750 allows more; the tokens made by make-token are 43 base64url characters). The scheme word is not case sensitive (RFC 9110). */
const BEARER = /^bearer ([!-~]{1,512})$/i;

/** Whether the header carries the token whose SHA-256 is `expected` (32 bytes). Constant time in the hash; the same work whether or not a token was sent. */
export function tokenMatches(header: unknown, expected: Buffer): boolean {
  const found = typeof header === 'string' ? BEARER.exec(header) : null;
  const presented = createHash('sha256').update(found ? found[1] : '', 'utf8').digest();
  const equal = presented.length === expected.length && timingSafeEqual(presented, expected);
  return equal && found !== null;
}

/** The `verify` of the admin door's routes. `tokenHash` is JV_ADMIN_TOKEN_HASH, 64 hex characters. */
export function adminDoor(app: FastifyInstance, tokenHash: string): (request: FastifyRequest) => void {
  const expected = Buffer.from(tokenHash, 'hex');
  if (expected.length !== 32) throw new TypeError('the admin token hash is the SHA-256 of the token: 64 hex characters');
  return (request) => {
    if (request.headers.origin !== undefined) throw new JvError('JV_FORBIDDEN', 'This address does not take requests from a web page.');

    const limiter = limiterOf(app);
    const visitor = visitorAddress(request.headers);
    const pauseKey = `admin-pause:${visitor.key}`;
    const wrongKey = `admin-wrong:${visitor.key}`;

    if (visitor.trusted) {
      const left = limiter.pausedFor(pauseKey);
      if (left > 0) throw rateLimited(left / 1000);
    }
    const calls = limiter.take(`admin-calls:${visitor.key}`, THROTTLES.adminCalls);
    if (!calls.ok) throw rateLimited(calls.retryAfterS);

    if (tokenMatches(request.headers.authorization, expected)) {
      if (visitor.trusted) limiter.clearStrikes(wrongKey);
      return;
    }

    if (visitor.trusted) {
      if (limiter.strike(wrongKey) >= THROTTLES.adminWrongInARow) {
        limiter.pause(pauseKey, THROTTLES.adminPauseMs);
        limiter.clearStrikes(wrongKey);
      }
    } else {
      const budget = limiter.take('admin-wrong-untrusted', THROTTLES.adminWrongUntrusted);
      if (!budget.ok) throw rateLimited(budget.retryAfterS);
    }
    throw new JvError('JV_UNAUTHENTICATED', 'The token was not accepted.');
  };
}
