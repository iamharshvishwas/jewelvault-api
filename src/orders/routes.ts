// FB-E1 (FB-D8, Siddhi #13): the routes of the Order Book. X13 create_order (POST /v1/orders, x13CreateOrder.ts) and the edit (PATCH /v1/orders/:id, editOrder.ts), each route() with the row of the
// matrix that gives its address and its roles. The read is the sync resource `orders` (src/sync, GET /v1/sync/orders and the poll) and the photo upload is the PhotoStore's (src/photos/routes.ts).
//
//   POST  /v1/orders       { order_id, customer_id, description, delivery_date?, notes?, photo_ids? } + Idempotency-Key      201 { order }
//   PATCH /v1/orders/:id   { expected_updated_at, changes: { description?, delivery_date?, status?, notes?, photo_ids? } }      200 { row }
import type { FastifyInstance } from 'fastify';
import { updateBody } from '../edit/engine.js';
import { route } from '../permissions/route.js';
import { editOrder } from './editOrder.js';
import { registerCreateOrder } from './x13CreateOrder.js';

/** The `:id` of the address, as Fastify parsed it. */
const idOf = (params: unknown): string => String((params as { id?: unknown }).id ?? '');

export function registerOrderRoutes(app: FastifyInstance): void {
  registerCreateOrder(app);
  route(app, { action: 'edit:orders.update', body: updateBody, handler: ({ app: a, request, auth, body }) => editOrder(a, request, auth, idOf(request.params), body) });
}
