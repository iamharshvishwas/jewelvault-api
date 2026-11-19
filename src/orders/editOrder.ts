// FB-E1 (FB-D8, Siddhi #13), A5: the edit of an order (PATCH /v1/orders/:id, { expected_updated_at, changes }). The columns are the matrix's (WRITE_COLUMNS: the owner and a biller `description`,
// `delivery_date`, `status`, `notes` and `photo_ids`); the number, the customer and the stamps are never sent. An order is MADE by X13 create_order (x13CreateOrder.ts), never here. The edit engine
// (src/edit/engine.ts) does the rest as for every other table: the stale check (409 JV_STALE with the row in details.current), the fields that really change, one stamped UPDATE, the row back in the
// sync wire format, the audit row of either mechanism of L1.
//
// The rules that are code and not columns, here:
//   - the status is one of open, in_progress, ready, delivered, cancelled (422 on anything else: the field's own check, before the database's CHECK). Among the open ones (open, in_progress, ready)
//     any change is allowed: the screen walks open -> in_progress -> ready -> delivered, and a step taken by mistake can be taken back; any open order can be cancelled.
//   - a delivered or cancelled order is CLOSED: only the owner changes its status (FIELD_RIGHTS change_closed_order). So delivered -> cancelled is the owner's, as the plan says, and so is taking a
//     closed order back. A biller still edits the description, the delivery date, the notes and the photos of a closed order.
//   - the photo ids, as a design's (P2, A5): at most 3, each new id has BOTH kinds stored for THIS order and not removed (assertAttachable with `of` 'order'), and only a caller who holds `photo_rewrite` may
//     remove, reorder or replace an id (FIELD_RIGHTS rewrite_photo_ids); the others add ids at the end.
// No money is in an order: an advance is an ordinary payment in the customer's ledger (FB-D8).
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { assertAttachable } from '../edit/designs.js';
import { type EditTable, type UpdateBody, type UpdateRule, invalid, notAllowed, updateRecord } from '../edit/engine.js';
import * as f from '../edit/fields.js';
import { mayUseField } from '../permissions/matrix.js';
import type { Auth } from '../permissions/route.js';

/** The five statuses of FB-D8, as the CHECK of db/migrations/0011 has them. */
export const ORDER_STATUSES = ['open', 'in_progress', 'ready', 'delivered', 'cancelled'] as const;
/** A delivered or cancelled order: its status is the owner's to change. */
export const CLOSED_STATUSES: readonly string[] = ['delivered', 'cancelled'];
/** The widths of the columns (VARCHAR(2000)). */
export const ORDER_TEXT_MAX = 2000;

export const ORDERS: EditTable = {
  table: 'orders',
  update: 'edit:orders.update',
  fields: {
    description: f.requiredText(ORDER_TEXT_MAX),
    delivery_date: f.dateOrNull,
    status: f.oneOf(ORDER_STATUSES),
    notes: f.optionalText(ORDER_TEXT_MAX),
    photo_ids: f.photoIds,
  },
};

const orderRules: UpdateRule = async ({ tx, grants, id, current, diff }) => {
  if ('status' in diff && CLOSED_STATUSES.includes(String(current.status)) && !mayUseField(grants, 'change_closed_order')) {
    throw notAllowed('changes.status', `This order is ${String(current.status)}. Your role cannot change its status now.`);
  }
  if (!('photo_ids' in diff)) return;
  const before = f.parseList(current.photo_ids) as string[];
  const ids = diff.photo_ids as string[];
  const addsOnly = ids.length >= before.length && before.every((x, i) => ids[i] === x);
  if (!addsOnly && !mayUseField(grants, 'rewrite_photo_ids')) throw invalid('changes.photo_ids', 'can only get new photo ids added at the end');
  const added = ids.filter((x) => !before.includes(x)); // an id attached before is not asked again: it may have been removed since, and the list should still be editable
  if (added.length > 0) await assertAttachable(tx, id, added, 'changes.photo_ids', 'order');
};

export const editOrder = (app: FastifyInstance, request: FastifyRequest, auth: Auth, id: string, body: UpdateBody) => updateRecord(app, request, auth, ORDERS, id, body, orderRules);
