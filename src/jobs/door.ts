// I8, A13: the check that stands in front of the job door (/internal/jobs/*): the hourly tick, and the read-only jobs health route of API33b. It is the `verify` of route(app, { token: 'job', ... })
// and runs alone, before the body is read and with no session (the door has none), in this order, so that a call that is refused costs the least and tells the least:
//
//   1. an `Origin` header: refused (403 JV_FORBIDDEN) whatever else is in the request. The callers are curl in an hPanel cron job and a GitHub Actions step: neither is a browser and neither sends
//      one, a web page always does. It comes first and counts nothing, so a page cannot use up the schedulers' calls. The door sends no CORS headers (src/security/index.ts gives its routes
//      `cors: false`), so a page could not read an answer anyway.
//   2. the token: `Authorization: Bearer <token>`, its SHA-256 compared in constant time with JV_JOB_TOKEN_HASH (src/admin/door.ts tokenMatches, the same function as the admin door's). The RIGHT
//      token passes here and is counted nowhere (RV1-10): the schedulers call twice an hour, and no stranger can use up anything that belongs to them.
//   3. only a WRONG token (or none) goes on to the throttle of A13 for the tick row: 6 a minute for each address and 20 a minute in all (429 with Retry-After; a refused call is not counted). The 20
//      in all is what stops a guesser from getting a fresh bucket by changing address ("a wrong token must not get a fresh bucket each time"); it fills with wrong tokens only, so four addresses
//      sending wrong tokens at 20 a minute (the first draft counted every call, the right one too) can no longer make the scheduler's right token get 429 and keep the nightly check, the housekeeping
//      and the photo copy from running. A guesser still gets nothing new: the token has 256 bits. A wrong token is 401 JV_UNAUTHENTICATED.
//
// This is the shape RV1-7 gave the admin door's untrusted case (src/admin/door.ts). The spec row of A13 reads "6 a minute per address and 20 a minute in all" without saying whose calls; it is read
// here as the figures for wrong tokens, which is what its own reason ("a wrong token must not get a fresh bucket each time") is about.
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

    // RV1-10: the token first; a right token passes and is not counted anywhere
    if (tokenMatches(request.headers.authorization, expected)) return;

    // only a wrong token (or none) is counted: against its address's six a minute, then against the twenty a minute of the whole API
    const limiter = limiterOf(app);
    const visitor = visitorAddress(request.headers);
    const mine = limiter.take(`job-wrong:${visitor.key}`, THROTTLES.jobPerAddress);
    if (!mine.ok) throw rateLimited(mine.retryAfterS);
    const all = limiter.take('job-wrong:all', THROTTLES.jobTotal);
    if (!all.ok) throw rateLimited(all.retryAfterS);
    throw new JvError('JV_UNAUTHENTICATED', 'The token was not accepted.');
  };
}
