// X4 void_receipt (POST /v1/receipts/:id/void, 200 {receipt, allocations, bills}), X4, Y7, Y6, Y8, Y10, D13, D23, L1, L5, X0, T-B08, T-B09, T-B16, T-B20, T-C12.
//
// A receipt is VOIDED, never deleted (Y7, S7): it keeps its row and its allocations, and from now on it counts for nothing. Balances are derived (V1, V2), so a void restores exactly what the receipt
// had applied: the bills it paid have that money (or silver) pending again, the customer's advance falls by what the receipt still held, and a voided REFUND gives its money back to the advance
// (Y10). The ledger and the cash book show the void as a reversing line on the day it is done (V3, V4: `voided_on`), so a closed day never changes because of it.
//
//   path     the receipt (`p_receipt_id`): a lower-case UUID, else 422 on `id`; no such receipt is 404 JV_NOT_FOUND.
//   body     reason (3 to 500 characters once trimmed). Nothing else.
//   header   Idempotency-Key.
//   answer   200 {receipt, allocations, bills}: `receipt` is the row as it is now (status voided, the reason, voided_at, voided_on, voided_by), `allocations` are the rows the REBALANCE made (Y6), and
//            `bills` are the affected bills in the form of the bill-summary read (V1: pending, received, fine, payment status): the bills the receipt had paid and the bills the rebalance then paid.
//
// THE RULES. The receipt must be active, else JV_ALREADY_VOID (409). When the customer's advance after the void would be below 0 the void is refused with JV_NOT_ALLOWED ("void the refund first"):
// that happens only when money received was already handed back (a payment that bounced after a refund is booked as dues with X12). Then the customer is rebalanced (Y6): money that was waiting as an
// advance now pays a bill the void re-opened. The walk-in is never rebalanced (K5: one row stands for strangers). A customer who is archived (K4) is refused with JV_CUSTOMER_ARCHIVED, as every
// money function is: a void would leave dues on a customer who is archived only because they owe nothing.
//
// ORDER OF WORK (X0). The route wrapper has already refused everything it can without a database (no session, a role that is not the owner, an invalid body). Then ONE transaction:
//   1. the claim of the key (L5, the first statement), the role check again (X0 item 2), the stored answer if the key is a repeat;
//   2. the customer is found from the receipt WITHOUT a lock, locked, and the receipt is read again FOR UPDATE and must be the SAME customer's (X0 item 3: `lockCustomerOf`). Everything else is decided
//      after the lock: a second void of one receipt is JV_ALREADY_VOID, never a false JV_BUSY. Then ONE reading of the API clock: `voided_at` and `voided_on` are that one instant (S5, D13);
//   3. what the receipt gave each bill (its live allocations summed) and the state of the customer, read ONCE (X0 item 8: `x04.after_read` of the test build; the S3 rows are in it). Nothing below reads
//      the customer's books again: the state AFTER the void is worked out in memory from what was read (src/domain/reopen.ts), and the rebalance allocates from it;
//   4. the checks (already void, archived, the advance), then the writes, all stamped by the one reading: the receipt, its audit row, the touches of D23 (the bills it paid and the customer), the
//      rebalance (its allocations, audit rows and touches);
//   5. the answer is read from the tables (V1 of the affected bills) and stored in the claim row, in the same transaction.
// No piece is locked and no number is taken. A failure anywhere rolls everything back, the claim included.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { type AuditedRow, auditChange } from '../db/audit.js';
import { claim, idempotencyKey, markReplay, storeResult } from '../db/idempotency.js';
import { lockCustomerOf } from '../db/locks.js';
import { readCustomerState } from '../db/state.js';
import { touchForReceiptWrite } from '../db/touch.js';
import { type Tx, txContextFor, withTx } from '../db/tx.js';
import { fromUnits, rebalance, toUnits } from '../domain/rebalance.js';
import { type Share, stateAfterVoid } from '../domain/reopen.js';
import { type Row, notFound, readRow, wireRow } from '../edit/engine.js';
import { JvError, unavailableError } from '../errors.js';
import { type Auth, assertMayCall, route } from '../permissions/route.js';
import { billSummaryFigures } from '../sync/derived.js';
import * as wire from '../wire/zod.js';
import { reasonText } from './reason.js';

// ------------------------------------------------------------------ the body

export const voidReceiptBody = wire.strictObject({ reason: reasonText });
export type VoidReceiptBody = z.output<typeof voidReceiptBody>;

// ------------------------------------------------------------------ the answer

export interface VoidReceiptResult {
  receipt: Row;
  /** the rows the rebalance made (Y6), in the order made */
  allocations: Row[];
  /** the affected bills as the bill-summary read gives them: the bills the receipt had paid, then the others the rebalance paid */
  bills: Row[];
}

const ACTION = 'fn:void_receipt';
const ROUTE_NAME = 'POST /v1/receipts/:id/void';
const MONEY = 2;

function contextOf(app: FastifyInstance, request: FastifyRequest, auth: Auth) {
  if (!app.db) throw unavailableError();
  return txContextFor(app.db, request, { id: auth.user.id, role: auth.user.role });
}

/** What the receipt's live allocations gave each bill: one row for each bill. A plain read under the customer lock, before the state read (and so before the test hook). */
const SHARES_SQL =
  'SELECT bill_id, SUM(amount) AS amount, SUM(fine_grams) AS fine_grams FROM receipt_allocations WHERE receipt_id = ? AND customer_id = ? AND released_at IS NULL GROUP BY bill_id';

/** The affected bills in the form of the bill-summary read (V1), in the order of `ids`. Read after the writes, so the figures are the ones the call left. */
async function billSummaries(tx: Tx, role: string, ids: readonly string[]): Promise<Row[]> {
  if (ids.length === 0) return [];
  const found = await tx.rows<Row>(billSummaryFigures(ids.length), [...ids]);
  const byId = new Map(found.map((r) => [String(r.id), r]));
  return ids.map((id) => {
    const r = byId.get(id);
    if (!r) throw new JvError('JV_INTERNAL', 'Something unexpected went wrong.', { cause: new Error(`bill ${id} is not there after the void`) });
    return wireRow('bill_summary', role, r);
  });
}

// ------------------------------------------------------------------ the function

/** X4. `key` is the Idempotency-Key as idempotencyKey() read it, `receiptId` the id in the path. Returns the answer and whether it is the stored answer of an earlier call with the same key. */
export async function voidReceipt(
  app: FastifyInstance,
  request: FastifyRequest,
  auth: Auth,
  key: string,
  receiptId: string,
  input: VoidReceiptBody,
): Promise<{ value: VoidReceiptResult; replayed: boolean }> {
  const role = auth.user.role;
  const by = auth.user.id;
  const ctx = contextOf(app, request, auth);

  return withTx(ctx, async (tx) => {
    // 1. the claim, the role check, a repeat of the key
    const c = await claim(tx, { key, fn: 'void_receipt', route: ROUTE_NAME, pathIds: { id: receiptId }, body: input });
    assertMayCall(role, ACTION); // X0 item 2: after the claim, whose row the rollback removes when this refuses
    if (!c.first) return { value: c.result as VoidReceiptResult, replayed: true };

    // 2. the customer from the receipt, locked, the receipt read again FOR UPDATE (the same customer, or JV_BUSY); everything else is decided now, after the lock
    const found = await lockCustomerOf(tx, 'receipts', receiptId);
    if (!found) throw notFound();
    const { customer, row: receipt } = found;
    if (receipt.status !== 'active') throw new JvError('JV_ALREADY_VOID', 'This receipt has already been voided.', { details: { receipt_id: receiptId } });
    if (customer.archived_at !== null) throw new JvError('JV_CUSTOMER_ARCHIVED', 'This customer is archived. Bring the customer back before voiding a receipt.', { details: { customer_id: customer.id } });
    const now = app.clock.read(); // ONE reading: voided_at, voided_on and every stamp of the call
    const at = now.timestamp;
    const walkin = Number(customer.is_walkin) === 1;

    // 3. what the receipt gave each bill, then the state of the customer, read ONCE (X0 item 8; the hook of the test build is the return of the state read)
    const shares = await tx.rows<Share>(SHARES_SQL, [receiptId, customer.id]);
    const state = await readCustomerState(tx, { fn: 'x04', customerId: customer.id, reopen: { receiptId } });

    // 4. the state as the void leaves it (in memory) and the check of Y7: the advance may not be below 0 afterwards
    const voidedReceipt = { id: receiptId, kind: String(receipt.kind), amount: String(receipt.amount), fine_grams: String(receipt.fine_grams) };
    const adjusted = stateAfterVoid(state, voidedReceipt, shares);
    const advanceAfter = toUnits(adjusted.totals.advance, MONEY);
    if (advanceAfter < 0n) {
      throw new JvError('JV_NOT_ALLOWED', 'The money of this payment was already handed back, so it cannot be voided yet. Void the refund first.', {
        details: { reason: 'void_the_refund_first', short_by: fromUnits(-advanceAfter, MONEY) },
      });
    }

    // the writes, all stamped by the one reading
    const done = await tx.run('UPDATE receipts SET status = ?, void_reason = ?, voided_at = ?, voided_on = ?, voided_by = ?, updated_at = ?, updated_by = ? WHERE id = ? AND status = ?', [
      'voided', input.reason, at, now.date, by, at, by, receiptId, 'active',
    ]);
    if (done.affectedRows !== 1) throw new JvError('JV_INTERNAL', 'Something unexpected went wrong.', { cause: new Error(`the void of receipt ${receiptId} changed ${done.affectedRows} rows`) });
    const row = await readRow(tx, 'receipts', receiptId, false);
    if (!row) throw new Error('the receipt is gone after its own update');
    await auditChange(tx, { table: 'receipts', action: 'update', before: receipt as AuditedRow, after: row as AuditedRow });
    // D23: the bills the receipt had paid and the customer carry the stamp of the call, also when it paid nothing (the advance moved the customer's figures)
    await touchForReceiptWrite(tx, { customerId: customer.id, billIds: shares.map((s) => s.bill_id), at });

    // Y6: the rebalance on the state as the void left it: money that was waiting as an advance pays a bill the void re-opened. The walk-in is never rebalanced (K5).
    const rebalanced = await rebalance(tx, { customerId: customer.id, walkin, state: adjusted, at });

    // 5. the answer: the receipt, the rows of the rebalance, and the bills the call touched in the order they were touched
    const billIds = [...new Set([...shares.map((s) => s.bill_id), ...rebalanced.allocations.map((a) => a.bill_id)])];
    const value: VoidReceiptResult = {
      receipt: wireRow('receipts', role, row),
      allocations: rebalanced.allocations.map((a) => wireRow('receipt_allocations', role, { ...a })),
      bills: await billSummaries(tx, role, billIds),
    };
    await storeResult(tx, c.key, value);
    return { value, replayed: false };
  });
}

/** Registers `fn:void_receipt`. */
export function registerVoidReceipt(app: FastifyInstance): void {
  route(app, {
    action: ACTION,
    body: voidReceiptBody,
    handler: async ({ app: a, request, reply, auth, body }) => {
      const { id } = wire.parseInput(wire.strictObject({ id: wire.uuid }), request.params); // the receipt: a lower-case UUID in the path
      const key = idempotencyKey(request.headers); // before the transaction: a missing or malformed key claims nothing
      const { value, replayed } = await voidReceipt(a, request, auth, key, id, body);
      markReplay(reply, replayed);
      return reply.code(200).send(value);
    },
  });
}
