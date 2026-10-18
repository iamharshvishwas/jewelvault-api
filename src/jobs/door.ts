// I8, A13: the check that stands in front of the job door (/internal/jobs/*): the hourly tick, and the read-only jobs health route of API33b. It is the `verify` of route(app, { token: 'job', ... })
// and runs alone, before the body is read and with no session (the door has none), in this order, so that a call that is refused costs the least and tells the least:
//
//   1. an `Origin` header: refused (403 JV_FORBIDDEN) whatever else is in the request. The callers are curl in an hPanel cron job and a GitHub Actions step: neither is a browser and neither sends
//      one, a web page always does. It comes first and counts nothing, so a page cannot use up the schedulers' calls. The door sends no CORS headers (src/security/index.ts gives its routes
//      `cors: false`), so a page could not read an answer anyway.
//   2. the throttle of A13: 6 calls a minute for each address and 20 a minute in all (429 with Retry-After). EVERY call that has no Origin counts, the wrong token too: the 20 in all is what stops a
//      guesser from getting a fresh bucket by changing address. The schedulers call twice an hour, so neither number is ever near.
//   3. the token: `Authorization: Bearer <token>`, its SHA-256 compared in constant time with JV_JOB_TOKEN_HASH (src/admin/door.ts tokenMatches, the same function as the admin door's). A wrong
//      or missing token is 401 JV_UNAUTHENTICATED.
//
// A flood of wrong tokens from many addresses can fill the 20 in all for as long as it lasts and so refuse the schedulers' calls too; they call again an hour later, and the dashboard turns red after
// 26 hours without a check (I12). That is what A13 chose ("a wrong token must not get a fresh bucket each time"); the admin door's answer to the same problem (the right token is never counted) is
// not copied here because the row says otherwise.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { tokenMatches } from '../admin/door.js';
import { THROTTLES, limiterOf, rateLimited, visitorAddress } from '../auth/limiter.js';
import { JvError } from '../errors.js';

/** The `verify` of the job door's routes. `tokenHash` is JV_JOB_TOKEN_HASH, 64 hex characters. */
export function jobDoor(app: FastifyInstance, tokenHash: string): (request: FastifyRequest) => void {
  const expected = Buffer.from(tokenHash, 'hex');
  if (expected.length !== 32) throw new TypeError('the job token hash is the SHA-256 of the token: 64 hex characters');
  return (request) => {
    if (request.headers.origin !== undefined) throw new JvError('JV_FORBIDDEN', 'This address does not take requests from a web page.');

    const limiter = limiterOf(app);
    const visitor = visitorAddress(request.headers);
    const mine = limiter.take(`job-calls:${visitor.key}`, THROTTLES.jobPerAddress);
    if (!mine.ok) throw rateLimited(mine.retryAfterS);
    const all = limiter.take('job-calls:all', THROTTLES.jobTotal);
    if (!all.ok) throw rateLimited(all.retryAfterS);

    if (!tokenMatches(request.headers.authorization, expected)) throw new JvError('JV_UNAUTHENTICATED', 'The token was not accepted.');
  };
}
