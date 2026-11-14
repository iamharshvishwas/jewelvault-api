// X13 create_order (POST /v1/orders, the owner and a biller): FB-E1, FB-D8 (Siddhi #13), L3, L4, L5, P2, X0. The spec's own X13 was retired in draft 4, so the Order Book of the feedback plan takes
// the number. An order holds NO MONEY: an advance is an ordinary payment in the customer's ledger (X2).
//
// The screen makes the order's id (a version-4 UUID) and one id for each photo before it uploads the photos (PUT /v1/orders/:order_id/photos/:photo_id, as for a design, P2); it then sends
//   { order_id, customer_id, description, delivery_date?, notes?, photo_ids? }
// with an Idempotency-Key. description is 1 to 2,000 characters (trimmed), delivery_date YYYY-MM-DD or null, notes up to 2,000 characters (blank is none), photo_ids at most 3 distinct ids. The status
// is always `open`; the client names neither the status nor the number. The fields are the order edit's own (editOrder.ts), so an order cannot be made with something its PATCH would refuse.
//   answer   201 { order }: the row in the wire format of the sync read (GET /v1/sync/orders), so the cache applies it as it applies a polled row. A repeat of the key answers the same body and status
//            with `Idempotent-Replay: true`.
//   refused  422 JV_INVALID_INPUT naming the field (a bad value, an unknown field, an order id that is taken, a customer that does not exist, a photo that is not this order's whole and live photo),
//            409 JV_CUSTOMER_ARCHIVED (bring the customer back first), 403 JV_FORBIDDEN (staff), 401.
//
// ORDER OF WORK (X0). Before the transaction: the body is parsed (the route), ONE reading of the API clock gives the year of the series order:<YYYY> and the stamps (S5, S6), and the counter row is
// made (ensureSeries: a series made inside a transaction can deadlock, spike F3). Then one withTx: the claim (L5); the role check, after the claim so a refusal rolls the claim back (X0 item 2); the
// checks, all plain reads (the order id is new, the customer exists and is not archived, every photo id is attachable); the number, LAST (the counter row is the last lock, X0 item 6); the order id once
// more (two calls with one order id and different keys are serialised by the counter row, and the second reads here what the first committed); the insert; the audit row of mechanism (b) when
// JV_AUDIT_MODE=node (the triggers of mechanism (a) write their own); the stored result. A failure anywhere rolls back the claim and the number with the rest: the numbers stay gapless (L3).
// No customer lock: an order moves no money and changes nothing of the customer; the foreign key keeps the customer's row.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { z } from 'zod';
import { auditChange } from '../db/audit.js';
import { idempotencyKey, idempotent, markReplay } from '../db/idempotency.js';
import { ensureSeries, nextNumber, orderNumbers } from '../db/numbers.js';
import { type Tx, txContextFor, withTx } from '../db/tx.js';
import { assertAttachable } from '../edit/designs.js';
import { type Row, invalid, readRow, wireRow } from '../edit/engine.js';
import { JvError, unavailableError } from '../errors.js';
import { type Auth, assertMayCall, route } from '../permissions/route.js';
import * as wire from '../wire/zod.js';
import { ORDERS } from './editOrder.js';

const ACTION = 'fn:create_order';
const ROUTE_NAME = 'POST /v1/orders';

/** The schema of a column of the order edit, typed as what it gives back. */
const field = <T>(name: keyof typeof ORDERS.fields) => ORDERS.fields[name].schema as z.ZodType<T>;

export const createOrderBody = wire.strictObject({
  order_id: wire.uuid,
  customer_id: wire.uuid,
  description: field<string>('description'),
  delivery_date: field<string | null>('delivery_date').optional(),
  notes: field<string | null>('notes').optional(),
  photo_ids: field<string[]>('photo_ids').optional(),
});
export type CreateOrderBody = z.output<typeof createOrderBody>;

export interface CreatedOrder {
  order: Row;
}

const INSERT_SQL =
  "INSERT INTO orders (id, order_no, customer_id, description, delivery_date, status, photo_ids, notes, created_at, updated_at, created_by, updated_by) VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?)";

const orderIsUsed = async (tx: Tx, id: string): Promise<boolean> => (await tx.rows('SELECT id FROM orders WHERE id = ?', [id])).length > 0;

/** X13. `key` is the Idempotency-Key as idempotencyKey() read it. Returns the answer and whether it is the stored answer of an earlier call with the same key. */
export async function createOrder(app: FastifyInstance, request: FastifyRequest, auth: Auth, key: string, body: CreateOrderBody): Promise<{ value: CreatedOrder; replayed: boolean }> {
  if (!app.db) throw unavailableError();
  const { id: userId, role } = auth.user;
  const ctx = txContextFor(app.db, request, { id: userId, role });
  const at = app.clock.read(); // ONE reading: the year of the series and both stamps (S5, S6)
  const series = orderNumbers(at);
  await ensureSeries(ctx, series.key); // the counter row exists before the transaction (L3)
  const photoIds = body.photo_ids ?? [];

  return withTx(ctx, (tx) =>
    idempotent<CreatedOrder>(tx, { key, fn: 'create_order', route: ROUTE_NAME, body }, async () => {
      assertMayCall(role, ACTION); // X0 item 2: after the claim, whose row the rollback removes when this refuses

      // the checks: plain reads, all before the counter
      if (await orderIsUsed(tx, body.order_id)) throw invalid('order_id', 'is already used by an order');
      const [customer] = await tx.rows<{ id: string; archived_at: string | null }>('SELECT id, archived_at FROM customers WHERE id = ?', [body.customer_id]);
      if (!customer) throw invalid('customer_id', 'is not a customer');
      if (customer.archived_at !== null) throw new JvError('JV_CUSTOMER_ARCHIVED', 'This customer is archived. Bring the customer back before taking an order.', { details: { customer_id: customer.id } });
      if (photoIds.length > 0) await assertAttachable(tx, body.order_id, photoIds, 'photo_ids', 'order'); // P2 (b) to (d), as the order PATCH asks

      // the number, last; then the order id once more (the counter row serialised two calls with one order id)
      const issued = await nextNumber(tx, series);
      if (await orderIsUsed(tx, body.order_id)) throw invalid('order_id', 'is already used by an order');

      await tx.run(INSERT_SQL, [body.order_id, issued.no, body.customer_id, body.description, body.delivery_date ?? null, JSON.stringify(photoIds), body.notes ?? null, at.timestamp, at.timestamp, userId, userId]);
      const after = await readRow(tx, 'orders', body.order_id, false);
      if (!after) throw new Error(`orders ${body.order_id}: the row is gone after its own insert`);
      await auditChange(tx, { table: 'orders', rowId: body.order_id, action: 'insert', before: null, after }); // L1 (b): only when JV_AUDIT_MODE=node; the triggers of (a) write their own row
      return { order: wireRow('orders', role, after) };
    }),
  );
}

/** Registers `fn:create_order`. */
export function registerCreateOrder(app: FastifyInstance): void {
  route(app, {
    action: ACTION,
    body: createOrderBody,
    handler: async ({ app: a, request, reply, auth, body }) => {
      const key = idempotencyKey(request.headers); // before the transaction: a missing or malformed key claims nothing
      const { value, replayed } = await createOrder(a, request, auth, key, body);
      markReplay(reply, replayed);
      return reply.code(201).send(value);
    },
  });
}
