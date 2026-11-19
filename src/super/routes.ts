// DESIGN.md 6.3 and the access plan's Tasks 12 to 14: THE SUPER ADMIN'S OWN API. Routes under /v1/super, each the route of a row of the permission matrix of kind `super`:
//
//   GET   /v1/super/ticks             { groups, ticks }    the catalogue of the 32 ticks: group, words, help text, sensitive, direct needs
//   GET   /v1/super/people            { people }           every login: id, name, e-mail, role key and role name, active, is_super_admin, last_login_at, updated_at
//   GET   /v1/super/roles             { roles }            every role: key, name, description, active, fixed, ticks, people (ACTIVE ones), updated_at
//   POST  /v1/super/roles             { role }  (201)      create a role as a copy of another          { copy_of, name, description?, password }
//   PATCH /v1/super/roles/:key        { role }             rename it, change its description          { expected_updated_at, changes: { name?, description? }, password }
//   PUT   /v1/super/roles/:key/ticks  { role }             set its ticks                               { expected_updated_at, ticks, password }
//   POST  /v1/super/roles/:key/active { role }             switch it off or on                         { expected_updated_at, active, password }
//   POST  /v1/super/people            { person, temporary_password } (201)   add a person            { full_name, email, role, password }
//   PATCH /v1/super/people/:id        { person }           edit the name and/or the e-mail             { changes: { full_name?, email? }, password }
//   POST  /v1/super/people/:id/role   { person }           change the role                             { role, password }
//   POST  /v1/super/people/:id/active { person }           switch off or on                            { active, password }
//   POST  /v1/super/people/:id/reset-password { person, temporary_password, sessions_ended }   a new temporary password   { password }
//
// Only the Super Admin passes (the wrapper of src/permissions/route.ts asks the flag alone, R8): a caller with no session gets 401, the Owner and everyone else 403 JV_FORBIDDEN, with the sentences that
// exist already. The reads write nothing: no audit row, no event, no change of a row. Each takes the person's grants from the session (`auth.user.grants`) and hands them to the read, which checks them
// again (src/super/queries.ts). The query string is refused when it has a key (these reads take none), as every read of the API does (reads/routes.ts).
//
// The four role writes carry the Super Admin's own password and the stamp of the role they were drawn from, and are one transaction each (src/super/roles.ts: the order of the work, the locks, the events, the
// words of every refusal). The route only hands the person's Auth, the address's `:key` and the parsed body over, and says 201 for a create. The five writes of people carry the password too (no stamp) and are
// one transaction each as well (src/super/people.ts); the route hands over the person's Auth, the address's `:id` and the parsed body, and says 201 for an add. A person is answered as the list shows that person.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { txContextFor, withRead } from '../db/tx.js';
import { unavailableError } from '../errors.js';
import { route } from '../permissions/route.js';
import * as wire from '../wire/zod.js';
import { readPeople, readRoles, tickCatalogue } from './queries.js';
import { addPerson, addPersonBody, editPerson, editPersonBody, personActiveBody, personRoleBody, resetPassword, resetPersonBody, setPersonActive, setPersonRole } from './people.js';
import { createRole, createRoleBody, editRole, editRoleBody, roleActiveBody, setRoleActive, setRoleTicks, ticksBody } from './roles.js';

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

  // the four role writes (Task 13): each hands the person's Auth, the address's key and the parsed body to its function in src/super/roles.ts
  route(app, {
    action: 'super:roles.create',
    body: createRoleBody,
    handler: async ({ app: a, request, reply, auth, body }) => {
      const created = await createRole(a, request, auth, body);
      reply.code(201);
      return created;
    },
  });

  route(app, {
    action: 'super:roles.edit',
    body: editRoleBody,
    handler: ({ app: a, request, auth, body }) => editRole(a, request, auth, request.params, body),
  });

  route(app, {
    action: 'super:roles.ticks',
    body: ticksBody,
    handler: ({ app: a, request, auth, body }) => setRoleTicks(a, request, auth, request.params, body),
  });

  route(app, {
    action: 'super:roles.active',
    body: roleActiveBody,
    handler: ({ app: a, request, auth, body }) => setRoleActive(a, request, auth, request.params, body),
  });

  // the five people writes (Task 14): each hands the person's Auth, the address's id and the parsed body to its function in src/super/people.ts
  route(app, {
    action: 'super:people.add',
    body: addPersonBody,
    handler: async ({ app: a, request, reply, auth, body }) => {
      const added = await addPerson(a, request, auth, body);
      reply.code(201);
      return added;
    },
  });

  route(app, {
    action: 'super:people.edit',
    body: editPersonBody,
    handler: ({ app: a, request, auth, body }) => editPerson(a, request, auth, request.params, body),
  });

  route(app, {
    action: 'super:people.role',
    body: personRoleBody,
    handler: ({ app: a, request, auth, body }) => setPersonRole(a, request, auth, request.params, body),
  });

  route(app, {
    action: 'super:people.active',
    body: personActiveBody,
    handler: ({ app: a, request, auth, body }) => setPersonActive(a, request, auth, request.params, body),
  });

  route(app, {
    action: 'super:people.reset',
    body: resetPersonBody,
    handler: ({ app: a, request, auth, body }) => resetPassword(a, request, auth, request.params, body),
  });
}
