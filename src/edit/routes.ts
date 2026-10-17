// A4, A5, C5 (a): the routes of the ordinary edits of this task: designs, pieces, categories and subcategories. A route is route() and a handler that hands the body to the edit engine
// (src/edit/engine.ts); the rows of the matrix give the address and the roles. API13b adds the daily rates, the settings and the customers to this list, on the same engine.
//
//   PATCH /v1/designs/:id  PATCH /v1/skus/:id  PATCH /v1/categories/:id  PATCH /v1/subcategories/:id    { expected_updated_at, changes: {...} }   200 { row }
//   POST  /v1/categories   POST  /v1/subcategories                                                       { the fields }                            201 { row }
// A refusal is an S8 body: 403 JV_FORBIDDEN (a field the caller may not send), 422 JV_INVALID_INPUT (an unknown field, a bad value), 404 JV_NOT_FOUND, 409 JV_STALE (details.current is the row),
// 409 JV_NOT_ALLOWED (a rule of the business). No Idempotency-Key: the same edit sent twice is refused the second time by the stale check (A5).
import type { FastifyInstance } from 'fastify';
import { route } from '../permissions/route.js';
import { addCategory, addSubcategory, editCategory, editSubcategory } from './catalogue.js';
import { editDesign } from './designs.js';
import { insertBody, updateBody } from './engine.js';
import { editSku } from './skus.js';

/** The `:id` of an address, as Fastify parsed it. */
const idOf = (params: unknown): string => String((params as { id?: unknown }).id ?? '');

export function registerEditRoutes(app: FastifyInstance): void {
  route(app, { action: 'edit:designs.update', body: updateBody, handler: ({ app: a, request, auth, body }) => editDesign(a, request, auth, idOf(request.params), body) });
  route(app, { action: 'edit:skus.update', body: updateBody, handler: ({ app: a, request, auth, body }) => editSku(a, request, auth, idOf(request.params), body) });
  route(app, { action: 'edit:categories.update', body: updateBody, handler: ({ app: a, request, auth, body }) => editCategory(a, request, auth, idOf(request.params), body) });
  route(app, { action: 'edit:subcategories.update', body: updateBody, handler: ({ app: a, request, auth, body }) => editSubcategory(a, request, auth, idOf(request.params), body) });
  route(app, {
    action: 'edit:categories.insert',
    body: insertBody,
    handler: async ({ app: a, request, reply, auth, body }) => {
      const made = await addCategory(a, request, auth, body);
      return reply.code(201).send(made);
    },
  });
  route(app, {
    action: 'edit:subcategories.insert',
    body: insertBody,
    handler: async ({ app: a, request, reply, auth, body }) => {
      const made = await addSubcategory(a, request, auth, body);
      return reply.code(201).send(made);
    },
  });
}
