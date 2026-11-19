// DESIGN.md 6.3 and the access plan's Task 12: THE SUPER ADMIN'S OWN API, the read side. Three GET routes under /v1/super, each the route of a row of the permission matrix of kind `super`:
//
//   GET /v1/super/ticks    { groups, ticks }    the catalogue of the 32 ticks: group, words, help text, sensitive, direct needs
//   GET /v1/super/people   { people }           every login: id, name, e-mail, role key and role name, active, is_super_admin, last_login_at, updated_at
//   GET /v1/super/roles    { roles }            every role: key, name, description, active, fixed, ticks, people (ACTIVE ones), updated_at
//
// Only the Super Admin passes (the wrapper of src/permissions/route.ts asks the flag alone, R8): a caller with no session gets 401, the Owner and everyone else 403 JV_FORBIDDEN, with the sentences that
// exist already. The reads write nothing: no audit row, no event, no change of a row. Each takes the person's grants from the session (`auth.user.grants`) and hands them to the read, which checks them
// again (src/super/queries.ts). The query string is refused when it has a key (these reads take none), as every read of the API does (reads/routes.ts).
//
// The nine writes of the screen (the rows `super:roles.*` and `super:people.*` that change something) have no route yet: Task 13 builds the role writes and Task 14 the people writes.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { txContextFor, withRead } from '../db/tx.js';
import { unavailableError } from '../errors.js';
import { route } from '../permissions/route.js';
import * as wire from '../wire/zod.js';
import { readPeople, readRoles, tickCatalogue } from './queries.js';

const noQuery = wire.strictObject({});

export function registerSuperRoutes(app: FastifyInstance): void {
  const contextOf = (a: FastifyInstance, request: FastifyRequest, user: { id: string; role: string }) => {
    if (!a.db) throw unavailableError();
    return txContextFor(a.db, request, { id: user.id, role: user.role }); // the audit actor: the person and the role KEY (a read writes no row, but the context is the same as every read's)
  };

  route(app, {
    action: 'super:ticks',
    handler: async ({ request, auth }) => {
      wire.parseInput(noQuery, request.query);
      return tickCatalogue(auth.user.grants);
    },
  });

  route(app, {
    action: 'super:people.list',
    handler: async ({ app: a, request, auth }) => {
      wire.parseInput(noQuery, request.query);
      return withRead(contextOf(a, request, auth.user), (db) => readPeople(db, auth.user.grants));
    },
  });

  route(app, {
    action: 'super:roles.list',
    handler: async ({ app: a, request, auth }) => {
      wire.parseInput(noQuery, request.query);
      return withRead(contextOf(a, request, auth.user), (db) => readRoles(db, auth.user.grants));
    },
  });
}
