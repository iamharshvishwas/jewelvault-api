// RV1-6, A11, A14: an address the router cannot take is answered like any address that is not a route.
//
// Fastify answers an address with a broken percent sign (`/%zz`, `/v1/sync/skus%zz`, an escape that is not UTF-8) or a path segment longer than its limit for a parameter (100 characters) itself, before
// a single hook has run: its own JSON (`FST_ERR_BAD_URL`, the path repeated in the message), no request id, none of the headers of A14. The `frameworkErrors` option of Fastify is the one place to
// change that, and what it is handed has no lifecycle (no hooks, so no helmet, no CORS, no `X-Request-Id`, no `no-store`). So the address is not answered here: it is MADE READABLE and put through
// the router again (`app.routing`), and then it is an ordinary request in every respect: the permission layer's 404 JV_NOT_FOUND (S8) with the request id, and every hook that runs for any other
// address, so the headers can never differ from those of a plain "nothing here". The rule that makes it readable:
//   - a percent sign that does not start a valid escape, and an escape that is not valid UTF-8, is the character `%` itself (written `%25`): `/v1/sync/skus%zz` is the address `/v1/sync/skus%zz`,
//     which no route has; a parameter that takes it (`/v1/customers/%zz/ledger`) is judged by its own rule (not an id: 422), as for `%25zz`;
//   - a segment longer than 100 characters is no value any route takes (an id is 36 characters): it becomes the one character `x`, which a parameter refuses and a fixed segment never equals. The
//     segments before it stay, so the prefix of a token door (`/admin/v1/`, `/internal/jobs/`) is still the prefix and its preflight is still a 404 without CORS headers (U3).
// The query string is not touched (the router does not decode it). Nothing of the address reaches the answer.
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { JvError, errorBody } from '../errors.js';

/** Fastify's limit for the value of a path parameter (routerOptions.maxParamLength): a longer one is `FST_ERR_MAX_PARAM_LENGTH`. */
export const MAX_SEGMENT_LENGTH = 100;

const ESCAPE_RUN = /(?:%[0-9A-Fa-f]{2})+|%/g;

/** The address with every percent sign the router could not decode written as `%25`, and every segment over the limit replaced by `x`. Idempotent. */
export function readableAddress(url: string): string {
  const cut = url.search(/[?#]/);
  const path = cut < 0 ? url : url.slice(0, cut);
  const rest = cut < 0 ? '' : url.slice(cut);
  const decodable = path.replace(ESCAPE_RUN, (run) => {
    if (run === '%') return '%25';
    try {
      decodeURIComponent(run);
      return run;
    } catch {
      return run.replace(/%/g, '%25');
    }
  });
  const short = decodable
    .split('/')
    .map((segment) => (segment.length > MAX_SEGMENT_LENGTH ? 'x' : segment))
    .join('/');
  return short + rest;
}

/** The `frameworkErrors` handler of the application (see the top of this file). */
export function answerBadAddress(app: FastifyInstance, _error: FastifyError, request: FastifyRequest, reply: FastifyReply): void {
  const raw = request.raw;
  const url = raw.url ?? '/';
  const readable = readableAddress(url);
  if (readable !== url) {
    raw.url = readable;
    app.routing(raw, reply.raw); // a full request now: the 404 handler, every hook, a new request id
    return;
  }
  // Not reachable while readableAddress makes every address decodable (a test fuzzes that); if it ever is, the answer is still the S8 404 with the two headers that matter most, and it ends here
  // instead of asking the router again for the same address.
  reply
    .code(404)
    .header('Cache-Control', 'no-store')
    .header('X-Request-Id', request.id)
    .send(errorBody(new JvError('JV_NOT_FOUND', 'There is nothing at this address.'), request.id));
}
