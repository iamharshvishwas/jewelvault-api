// C3, C4: the read side of the screens. GET /v1/sync/<resource>?updated_after=&after_key=&limit= (hydrate, and one resource of a poll) and POST /v1/sync/poll (all the resources of a screen in one call).
//
//   GET  → 200 { rows, next, server_time }          next: { updated_at, key } when the page was full, else null (the load ends)
//   POST → 200 { results: { <resource>: { rows, next } }, server_time, role }
//   POST body: { limit?: 1 to 1,000, cursors: { <resource>: null | { updated_at, key? } } }
//
// What each answer promises, in the order the spec gives it:
//   - the pages of a poll are read inside ONE read-only snapshot (REPEATABLE READ, WITH CONSISTENT SNAPSHOT), so a poll never shows a bill without its lines or a payment without its allocation (C4);
//     a GET is read in a snapshot too, so the two statements of a derived read see one moment;
//   - `server_time` is the API's clock read BEFORE the first page is read: the first poll after a hydrate starts from the server_time of the hydrate's FIRST page minus 30 seconds (C3, RF4-5);
//   - the call is 403 JV_FORBIDDEN as a whole when the role may not read one of the resources it names, with nothing read and no partial answer (C4), and it reports the caller's CURRENT role;
//   - the page size is the constant `limits.syncPageRows` (1,000); asking for more is refused, not cut. A server that is made to cap pages lower (the test of T-F03) answers fewer rows with `next`
//     set, and the screen advances by the rows it received;
//   - a path that is not a resource is not a route (404, A11), and nothing the client sends is a table or column name: an unknown key in the query or the body is refused (422);
//   - the paths under /v1/sync/ never move the session's `last_seen_at` (U4, session.ts).
// The session, the matrix row and the body schema are the wrapper's (route.ts); the handlers hold no role string (S10).
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { txContextFor, withRead } from '../db/tx.js';
import { JvError } from '../errors.js';
import { limits } from '../limits.js';
import { mayCall } from '../permissions/matrix.js';
import { route } from '../permissions/route.js';
import { UUID_TEXT, timestampFromWire, timestampToWire } from '../wire/format.js';
import * as wire from '../wire/zod.js';
import { type WirePage, readPage } from './page.js';
import { SYNC_RESOURCES, type SyncResource, resourceByName } from './resources.js';

export interface SyncRoutesOptions {
  /**
   * A cap on the rows of a page below the constant of the API (default: limits.syncPageRows). The server of the plan never needs it; the test of T-F03 lowers it to 500 to show that the screen
   * advances by the rows it received and not by the rows it asked for.
   */
  maxRows?: number;
}

/** The text of a settings key: letters, digits and a few signs, at most the 64 characters of the column. */
const TEXT_KEY = /^[A-Za-z0-9_.:-]{1,64}$/;

const keyProblem = (r: SyncResource, key: string): string | null => {
  if (r.keyType === 'uuid') return UUID_TEXT.test(key) ? null : 'must be a lower-case UUID';
  return TEXT_KEY.test(key) ? null : 'must be the key text the server sent';
};

const limitMessage = `must be a whole number from 1 to ${limits.syncPageRows.toLocaleString('en-US')}`;

const pageQuery = wire.strictObject({
  updated_after: wire.timestamp.optional(),
  after_key: z.string({ error: 'must be the key text the server sent' }).max(64, 'must be the key text the server sent').optional(),
  limit: z.string({ error: limitMessage }).regex(/^[1-9][0-9]{0,3}$/, limitMessage).optional(),
});

const cursor = wire.strictObject({
  updated_at: wire.timestamp,
  key: z.string({ error: 'must be the key text the server sent' }).max(64, 'must be the key text the server sent').nullish(),
});

const pollBody = wire.strictObject({
  limit: z.number({ error: limitMessage }).int(limitMessage).min(1, limitMessage).max(limits.syncPageRows, limitMessage).optional(),
  cursors: z.record(z.string(), cursor.nullable()),
});

/** The rows a page may hold: what the screen asked for, never more than the API's cap. */
const clamp = (asked: number | undefined, cap: number): number => Math.min(asked ?? cap, cap);

export function registerSyncRoutes(app: FastifyInstance, options: SyncRoutesOptions = {}): void {
  const cap = options.maxRows ?? limits.syncPageRows;
  if (!Number.isInteger(cap) || cap < 1 || cap > limits.syncPageRows) throw new RangeError(`the page cap is a whole number from 1 to ${limits.syncPageRows}`);

  const contextOf = (a: FastifyInstance, request: Parameters<typeof txContextFor>[1], user: { id: string; role: string }) => {
    if (!a.db) throw new JvError('JV_UNAVAILABLE', 'The service is not available. Try again in a moment.');
    return txContextFor(a.db, request, { id: user.id, role: user.role });
  };

  for (const resource of SYNC_RESOURCES) {
    route(app, {
      action: resource.action,
      handler: async ({ app: a, request, auth }) => {
        const serverTime = timestampToWire(a.clock.read().timestamp); // before the page is read (C3)
        const q = wire.parseInput(pageQuery, request.query);
        if (q.after_key !== undefined && q.updated_after === undefined) throw new wire.InvalidInputError('after_key', 'needs updated_after');
        if (q.after_key !== undefined) {
          const problem = keyProblem(resource, q.after_key);
          if (problem) throw new wire.InvalidInputError('after_key', problem);
        }
        const asked = q.limit === undefined ? undefined : Number(q.limit);
        if (asked !== undefined && asked > limits.syncPageRows) throw new wire.InvalidInputError('limit', limitMessage); // the constant is the contract: asking for more is refused, not cut
        const limit = clamp(asked, cap);
        const after = q.updated_after === undefined ? undefined : { updatedAt: timestampFromWire(q.updated_after), key: q.after_key ?? null };
        const page = await withRead(contextOf(a, request, auth.user), (db) => readPage(db, resource, auth.user.role, { after, limit }), { snapshot: true });
        return { rows: page.rows, next: page.next, server_time: serverTime };
      },
    });
  }

  route(app, {
    action: 'read:poll',
    body: pollBody,
    handler: async ({ app: a, request, auth, body }) => {
      const serverTime = timestampToWire(a.clock.read().timestamp); // before the first page is read
      const asked: { resource: SyncResource; cursor: z.output<typeof cursor> | null }[] = [];
      for (const [name, c] of Object.entries(body.cursors)) {
        const resource = resourceByName(name);
        if (!resource) throw new wire.InvalidInputError(`cursors.${name.slice(0, 64)}`, 'is not a resource this call reads');
        asked.push({ resource, cursor: c });
      }
      // C4: if the role may not read one of them the whole call is 403, with no partial answer and nothing read
      if (asked.some((x) => !mayCall(auth.user.role, x.resource.action))) throw new JvError('JV_FORBIDDEN', 'You are not allowed to do this.');
      for (const { resource, cursor: c } of asked) {
        if (c?.key != null) {
          const problem = keyProblem(resource, c.key);
          if (problem) throw new wire.InvalidInputError(`cursors.${resource.name}.key`, problem);
        }
      }
      const limit = clamp(body.limit, cap);
      const results = await withRead(
        contextOf(a, request, auth.user),
        async (db) => {
          const out: Record<string, WirePage> = {};
          for (const { resource, cursor: c } of asked) {
            const after = c === null ? undefined : { updatedAt: timestampFromWire(c.updated_at), key: c.key ?? null };
            out[resource.name] = await readPage(db, resource, auth.user.role, { after, limit });
          }
          return out;
        },
        { snapshot: true },
      );
      return { results, server_time: serverTime, role: auth.user.role };
    },
  });
}

