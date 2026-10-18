// X11 issue_refund (POST /v1/customers/:id/refunds, 201 {receipt, advance}), X11, Y10, Y6, Y8, Y1, D13, D23, V2, V3, V4, K5, L5, X0, T-B20, T-A09, T-D09, T-D14.
//
// A REFUND is money HANDED BACK to the customer (Y1, Y10): a `receipts` row of kind `refund`, a mode, an amount above 0 and not more than the customer's current advance, dated by Y8. It has NO
// allocations (it pays no bill), it reduces the advance (V2: `advance = received - allocated - refunded`), it is a debit in the ledger (V3: kind Refund) and money OUT on its own date in the cash book
// (V4: `money_out` on `paid_on`, in its own mode). Voiding it (X4) gives the advance back, with the reversing line on the day of the void. It is the first thing to leave M1 if the calendar slips (X11,
// plan task API28): cutting it removes this file, its row in routes.ts (the row of the permission matrix stays and is a `todo` of the generated test) and the refund form of WEB11.
//
//   path     the customer (`p_customer_id`): a lower-case UUID, else 422 on `id`; no such customer is 404 JV_NOT_FOUND; an archived one is 409 JV_CUSTOMER_ARCHIVED (as X1 to X5 say).
//   body     amount (a text above 0, at most 2 decimals, at most 1,000,000,000), mode (Cash, UPI, Card, Bank Transfer, Other: D13 gives a refund the five modes of a payment), paid_on (absent or null:
//            today; Y8: the owner, who is the only caller, any day up to and including today, never the future), reference (at most 120), notes. Nothing else: the customer is the path, a refund
//            names no bill, hands back no silver (O24: silver cannot be handed back in M1) and needs no cash-limit reason (money going out has no limit).
//   header   Idempotency-Key.
//   answer   201 {receipt, advance}: `receipt` is the row in the wire format of the sync read of the caller's role (so the cache applies it as it applies a polled row), `advance` the customer's
//            advance AFTER the call, money text (V2). A repeat of the key answers the same body and status with `Idempotent-Replay: true`.
//
// THE RULE OF Y10. The amount may not be more than the customer's advance as the books stand AFTER the customer lock: 409 JV_NOT_ALLOWED naming `amount`, with `details {field, reason:
// 'more_than_advance', advance, short_by}` (the spec names no code for this refusal; JV_NOT_ALLOWED is the one X4 uses for the same sum from the other side, "void the refund first"). The walk-in
// customer never holds an advance (K5, I10), so for it the advance is 0.00 and no refund is possible; there is no rule of its own for it.
//
// Y6 AND THE REBALANCE. After a refund the call runs the rebalance of Y6 on the state as the refund leaves it: the figures of V2 in the copy of the state handed to it are the ones AFTER the refund
// (`refunded` up by the amount, `advance` down by the amount, `balance` up by the amount), because the rebalance applies at most the advance of V2, which is how money that was handed back is never
// spent a second time. With the books in the state I10 leaves them (an advance only when nothing is pending) it applies nothing and sends nothing; a customer who holds an advance BESIDE a pending
// bill (an import can leave one, the way the rebalance of X2 can meet one) has the part of the advance that is left after the refund applied to that bill.
//
// ORDER OF WORK (X0). The route wrapper has already refused everything it can without a database (no session, a role that is not the owner, an invalid body); then the key is read from the header
// (missing or not a UUID: 422 naming the header, nothing claimed) and ONE transaction runs:
//   1. the claim of the key (L5, the first statement), the role check again (X0 item 2), the stored answer if the key is a repeat (before any lock or date check, so a retry after midnight is not
//      refused by Y8);
//   2. the customer row FOR UPDATE (X0 item 3), "exists, not archived", then ONE reading of the API clock (`now`): its date is the business day for Y8, its stamp is every stamp of the call (C4: taken
//      after the lock, so a refund that waited is stamped after the one it waited for);
//   3. the state of the customer, read ONCE (X0 item 8, `x11.after_read` of the test build: the hook is a wrapper of the test build, not a line of this file); the check of Y10 and the rebalance use
//      it and read nothing again;
//   4. no number is taken and no piece is locked; the cash rules of section 13 do not apply to money going out; the writes, all stamped `now`: the receipt and its audit row (L1 b), the touch of
//      the customer (D23: the customer's figures changed, no bill did), then the rebalance (nothing to apply);
//   5. the result is stored in the claim row, in the same transaction.
// A failure anywhere rolls everything back, the claim included.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { claim, idempotencyKey, markReplay, storeResult } from '../db/idempotency.js';
import { newId } from '../db/ids.js';
import { lockCustomer } from '../db/locks.js';
import { type CustomerState, readCustomerState } from '../db/state.js';
import { touchForReceiptWrite } from '../db/touch.js';
import { txContextFor, withTx } from '../db/tx.js';
import { fromUnits, rebalance, toUnits } from '../domain/rebalance.js';
import { type Row, notFound, wireRow } from '../edit/engine.js';
import * as f from '../edit/fields.js';
import { JvError, unavailableError } from '../errors.js';
import { type Auth, assertMayCall, route } from '../permissions/route.js';
import * as wire from '../wire/zod.js';
import { insertReceipt } from './receiptWrite.js';
import { REFERENCE_MAX, paymentAmount, paymentMode } from './x01CreateBill.js';
import { checkBillDate } from './x07QuoteBill.js';

// ------------------------------------------------------------------ the body

export const issueRefundBody = wire.strictObject({
  amount: paymentAmount,
  mode: paymentMode,
  paid_on: wire.businessDate.nullish(),
  reference: (f.optionalText(REFERENCE_MAX).schema as z.ZodType<string | null>).optional(),
  notes: (f.optionalText(f.TEXT_MAX).schema as z.ZodType<string | null>).optional(),
});
export type IssueRefundBody = z.output<typeof issueRefundBody>;

// ------------------------------------------------------------------ the answer

export interface IssueRefundResult {
  receipt: Row;
  /** money text: the customer's advance after the call (V2) */
  advance: string;
}

const ACTION = 'fn:issue_refund';
const ROUTE_NAME = 'POST /v1/customers/:id/refunds';
const MONEY = 2;
const FINE = 3;

function contextOf(app: FastifyInstance, request: FastifyRequest, auth: Auth) {
  if (!app.db) throw unavailableError();
  return txContextFor(app.db, request, { id: auth.user.id, role: auth.user.role });
}

/** The state as the refund leaves it, in the figures the rebalance reads: V2 of the customer with the refund in it. Nothing else changes (a refund has no allocation: no bill and no receipt moves). */
function stateAfterRefund(state: CustomerState, amount: bigint): CustomerState {
  const plus = (text: string, delta: bigint): string => fromUnits(toUnits(text, MONEY) + delta, MONEY);
  return { ...state, totals: { ...state.totals, refunded: plus(state.totals.refunded, amount), advance: plus(state.totals.advance, -amount), balance: plus(state.totals.balance, amount) } };
}

// ------------------------------------------------------------------ the function

/**
 * X11. `key` is the Idempotency-Key as idempotencyKey() read it, `customerId` the id in the path. Returns the answer and whether it is the stored answer of an earlier call with the same key.
 */
export async function issueRefund(
  app: FastifyInstance,
  request: FastifyRequest,
  auth: Auth,
  key: string,
  customerId: string,
  input: IssueRefundBody,
): Promise<{ value: IssueRefundResult; replayed: boolean }> {
  const role = auth.user.role;
  const by = auth.user.id;
  const ctx = contextOf(app, request, auth);

  return withTx(ctx, async (tx) => {
    // 1. the claim, the role check, a repeat of the key
    const c = await claim(tx, { key, fn: 'issue_refund', route: ROUTE_NAME, pathIds: { id: customerId }, body: input });
    assertMayCall(role, ACTION); // X0 item 2: after the claim, whose row the rollback removes when this refuses
    if (!c.first) return { value: c.result as IssueRefundResult, replayed: true };

    // 2. the customer row FOR UPDATE, then "exists and is not archived"; one reading of the clock after the lock
    const customer = await lockCustomer(tx, customerId);
    if (!customer) throw notFound();
    if (customer.archived_at !== null) throw new JvError('JV_CUSTOMER_ARCHIVED', 'This customer is archived. Bring the customer back before handing money back.', { details: { customer_id: customer.id } });
    const now = app.clock.read();
    const at = now.timestamp;
    const paidOn = checkBillDate(input.paid_on, now.date, role, 'paid_on'); // Y8
    const walkin = Number(customer.is_walkin) === 1;
    const amount = toUnits(input.amount, MONEY);

    // 3. the state of the customer, read ONCE (X0 item 8); the hook of the test build is the return of this call. Y10: not more than the advance of V2.
    const state = await readCustomerState(tx, { fn: 'x11', customerId: customer.id });
    const advance = toUnits(state.totals.advance, MONEY);
    if (amount > advance) {
      throw new JvError('JV_NOT_ALLOWED', 'A refund cannot be more than the advance the customer holds.', {
        details: { field: 'amount', reason: 'more_than_advance', advance: fromUnits(advance, MONEY), short_by: fromUnits(amount - advance, MONEY) },
      });
    }

    // 4. the writes, all stamped by the one reading. The receipt (kind refund: no silver, no rate, not an opening advance, no cash reason) and its audit row, then the touch of D23.
    const receiptRow = await insertReceipt(tx, {
      id: newId(),
      customerId: customer.id,
      kind: 'refund',
      mode: input.mode,
      amount: fromUnits(amount, MONEY),
      fineGrams: fromUnits(0n, FINE),
      silverRate: null,
      paidOn,
      reference: input.reference ?? null,
      notes: input.notes ?? null,
      cashOverrideReason: null,
      at,
      by,
    });
    // D23: the customer's figures changed (the advance); a refund pays no bill, so no bill is touched
    await touchForReceiptWrite(tx, { customerId: customer.id, billIds: [], at });

    // Y6: the rebalance on the state as the refund leaves it, so that the money that went out cannot be applied to a bill. Nothing to apply in a state I10 allows; the walk-in is never rebalanced (K5).
    const rebalanced = await rebalance(tx, { customerId: customer.id, walkin, state: stateAfterRefund(state, amount), at });

    const value: IssueRefundResult = {
      receipt: wireRow('receipts', role, receiptRow),
      advance: fromUnits(advance - amount - toUnits(rebalanced.applied, MONEY), MONEY),
    };
    await storeResult(tx, c.key, value);
    return { value, replayed: false };
  });
}

/** Registers `fn:issue_refund`. */
export function registerIssueRefund(app: FastifyInstance): void {
  route(app, {
    action: ACTION,
    body: issueRefundBody,
    handler: async ({ app: a, request, reply, auth, body }) => {
      const { id } = wire.parseInput(wire.strictObject({ id: wire.uuid }), request.params); // the customer: a lower-case UUID in the path
      const key = idempotencyKey(request.headers); // before the transaction: a missing or malformed key claims nothing
      const { value, replayed } = await issueRefund(a, request, auth, key, id, body);
      markReplay(reply, replayed);
      return reply.code(201).send(value);
    },
  });
}
