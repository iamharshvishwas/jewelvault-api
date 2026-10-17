// A4, A5, C5 (a): the routes of the ordinary edits: designs, pieces, categories and subcategories (API13), daily rates, settings and customers (API13b). A route is route() and a handler that hands
// the body to the edit engine (src/edit/engine.ts); the rows of the matrix give the address and the roles.
//
//   PATCH /v1/designs/:id  PATCH /v1/skus/:id  PATCH /v1/categories/:id  PATCH /v1/subcategories/:id    { expected_updated_at, changes: {...} }   200 { row }
//   PATCH /v1/daily-rates/:id  PATCH /v1/customers/:id                                                   { expected_updated_at, changes: {...} }   200 { row }
//   POST  /v1/categories   POST  /v1/subcategories   POST  /v1/daily-rates                              { the fields }                            201 { row }
//   PUT   /v1/settings/:key                                                                              { value }                                 201 { row } made, 200 { row } changed
// A refusal is an S8 body: 403 JV_FORBIDDEN (a field the caller may not send), 422 JV_INVALID_INPUT (an unknown field, a bad value), 404 JV_NOT_FOUND, 409 JV_STALE (details.current is the row),
// 409 JV_NOT_ALLOWED (a rule of the business). No Idempotency-Key: the same edit sent twice is refused the second time by the stale check (A5).
import type { FastifyInstance } from 'fastify';
import { route } from '../permissions/route.js';
import { addCategory, addSubcategory, editCategory, editSubcategory } from './catalogue.js';
import { editCustomer } from './customers.js';
import { editDesign } from './designs.js';
import { insertBody, updateBody } from './engine.js';
import { addRate, editRate } from './rates.js';
import { putSetting } from './settings.js';
import { editSku } from './skus.js';

/** The `:id` of an address, as Fastify parsed it. */
const idOf = (params: unknown): string => String((params as { id?: unknown }).id ?? '');
/** The `:key` of the settings address, as Fastify parsed it (percent-decoded). */
const keyOf = (params: unknown): string => String((params as { key?: unknown }).key ?? '');

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
  route(app, { action: 'edit:daily_rates.update', body: updateBody, handler: ({ app: a, request, auth, body }) => editRate(a, request, auth, idOf(request.params), body) });
  route(app, {
    action: 'edit:daily_rates.insert',
    body: insertBody,
    handler: async ({ app: a, request, reply, auth, body }) => {
      const made = await addRate(a, request, auth, body);
      return reply.code(201).send(made);
    },
  });
  route(app, { action: 'edit:customers.update', body: updateBody, handler: ({ app: a, request, auth, body }) => editCustomer(a, request, auth, idOf(request.params), body) });
  route(app, {
    action: 'edit:settings.update',
    body: insertBody,
    handler: async ({ app: a, request, reply, auth, body }) => {
      const { row, created } = await putSetting(a, request, auth, keyOf(request.params), body);
      return reply.code(created ? 201 : 200).send({ row });
    },
  });
}
