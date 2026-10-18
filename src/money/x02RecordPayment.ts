// X2 record_payment (POST /v1/customers/:id/payments, 201 {receipt, allocations, advance_remaining}), X2, Y1, Y3, Y4, Y5, Y8, Z1, Z2, K5, D13, D14, D23, L5, X0, T-B01, T-B04, T-B05, T-B06, T-B17, T-B22, T-B23, T-C09.
//
//   path     the customer (`p_customer_id`): a lower-case UUID, else 422 on `id`; no such customer is 404 JV_NOT_FOUND.
//   body     amount (a text above 0, at most 2 decimals, at most 1,000,000,000), mode (Cash, UPI, Card, Bank Transfer, Other: there is no Credit, D13, Y2), paid_on (absent or null: today; Y8: a biller
//            only today, the owner any day up to today, never the future), reference (at most 120), notes, bill_id (optional: the bill to pay first), cash_override_reason (the owner's right, Z1).
//   header   Idempotency-Key (a UUID the screen makes once for each payment and reuses for a retry).
//   answer   201 {receipt, allocations, advance_remaining}: `receipt` and `allocations` are the rows in the wire format of the sync read of the caller's role (so the cache applies them as it applies a
//            polled row). `allocations` are all the rows the call made, in the order made: the payment's own (Y3: the named bill first, then the oldest) and then those of the rebalance (Y6), if any.
//            `advance_remaining` is what is left of THIS payment after those allocations: money received that is neither allocated to a bill nor handed back (Y5), "0.00" when it all went to bills.
//            A repeat of the key answers the same body and status with `Idempotent-Replay: true`.
//
// THE CASH RULES (section 13, Z1, Z2, API23): a `Cash` payment that would make the customer's cash of the day (`paid_on`) reach the limit raises JV_CASH_LIMIT unless the owner gives a
// `cash_override_reason`, which is stored on the receipt; for the walk-in a single Cash payment at the limit raises it with 'Select or create the customer' (src/domain/cashRules.ts). A biller who
// sends a reason is refused (JV_FORBIDDEN, T-D09). The rules run before the first write.
//
// ORDER OF WORK (X0). The route wrapper has already refused everything it can without a database (no session, a role not on the row, an invalid body); then the key is read from the header (missing
// or not a UUID: 422 naming the header, nothing claimed) and ONE transaction runs:
//   1. the claim of the key (L5, the first statement), the role check again (X0 item 2), the stored answer if the key is a repeat (before any lock or date check, so a retry after midnight is not
//      refused by Y8);
//   2. the customer row FOR UPDATE (X0 item 3), "exists, not archived" (T-C20: a payment waits for the lock and is refused if the archive committed first), then ONE reading of the API clock (`now`):
//      its date is the business day for Y8, its stamp is every stamp of the call (C4: taken after the lock, so a payment that waited is stamped after the one it waited for);
//   3. the state of the customer, read ONCE (X0 item 8, `x02.after_read` of the test build: the hook is a wrapper of the test build, not a line of this file); everything below allocates from it and
//      reads nothing again: the named bill must be one of its open bills with money pending (Y3, else JV_INVALID_INPUT), and the walk-in's rules of K5 are decided on it;
//   4. no number is taken (a receipt has none) and no piece is locked; the cash rules (Z1, Z2) are decided here, on a plain read of the day's cash, before the first write; the writes, all stamped `now`:
//      the receipt, its audit row (L1 b), the payment's own allocation by Y3 (planRebalance with the
//      one receipt: the named bill first, then the oldest, each taking the smaller of what is left and what is pending), the touches of D23 (the bills that received money and the customer,
//      also when nothing was allocated: the advance moved the customer's figures), then the rebalance of Y6 on the state as the payment left it (the walk-in is never rebalanced, K5), which applies
//      any older advance to what is still pending: with the books in the state I10 leaves them (an advance only when nothing is pending) it applies nothing and sends nothing;
//   5. the result is stored in the claim row, in the same transaction.
// A failure anywhere rolls everything back, the claim included.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { claim, idempotencyKey, markReplay, storeResult } from '../db/idempotency.js';
import { newId } from '../db/ids.js';
import { lockCustomer } from '../db/locks.js';
import { type CustomerState, type OpenBill, readCustomerState } from '../db/state.js';
import { touchForReceiptWrite } from '../db/touch.js';
import { txContextFor, withTx } from '../db/tx.js';
import { applyCashRules } from '../domain/cashRules.js';
import { type AllocationRow, fromUnits, insertAllocations, planRebalance, rebalance, toUnits } from '../domain/rebalance.js';
import { type Row, invalid, notFound, wireRow } from '../edit/engine.js';
import * as f from '../edit/fields.js';
import { JvError, unavailableError } from '../errors.js';
import { mayUseField } from '../permissions/matrix.js';
import { type Auth, assertMayCall, route } from '../permissions/route.js';
import * as wire from '../wire/zod.js';
import { REFERENCE_MAX, cashOverrideReason, paymentAmount, paymentMode } from './x01CreateBill.js';
import { insertReceipt } from './receiptWrite.js';
import { checkBillDate } from './x07QuoteBill.js';

// ------------------------------------------------------------------ the body

export const recordPaymentBody = wire.strictObject({
  amount: paymentAmount,
  mode: paymentMode,
  paid_on: wire.businessDate.nullish(),
  reference: (f.optionalText(REFERENCE_MAX).schema as z.ZodType<string | null>).optional(),
  notes: (f.optionalText(f.TEXT_MAX).schema as z.ZodType<string | null>).optional(),
  /** Y3: the bill to pay first. It must be an active bill of this customer with money pending, else JV_INVALID_INPUT. */
  bill_id: wire.uuid.nullish(),
  /** Z1: the owner's right (FIELD_RIGHTS), stored on the receipt when a Cash payment needed it; a biller who sends it is refused after the claim. */
  cash_override_reason: cashOverrideReason,
});
export type RecordPaymentBody = z.output<typeof recordPaymentBody>;

// ------------------------------------------------------------------ the answer

export interface RecordPaymentResult {
  receipt: Row;
  /** every allocation the call made, in the order made: the payment's own (Y3), then those of the rebalance (Y6) */
  allocations: Row[];
  /** money text: what is left of this payment after its allocations, kept as an advance (Y5) */
  advance_remaining: string;
}

const ACTION = 'fn:record_payment';
const ROUTE_NAME = 'POST /v1/customers/:id/payments';
const MONEY = 2;
const FINE = 3;

function contextOf(app: FastifyInstance, request: FastifyRequest, auth: Auth) {
  if (!app.db) throw unavailableError();
  return txContextFor(app.db, request, { id: auth.user.id, role: auth.user.role });
}

/** The state as the payment's own allocation left it: the bills that received money have less pending (and more received); a bill with nothing left of either kind is no longer open. */
function afterOwnAllocation(state: CustomerState, own: readonly AllocationRow[]): CustomerState {
  const taken = new Map<string, bigint>();
  for (const a of own) taken.set(a.bill_id, (taken.get(a.bill_id) ?? 0n) + toUnits(a.amount, MONEY));
  const openBills: OpenBill[] = [];
  for (const b of state.openBills) {
    const got = taken.get(b.id) ?? 0n;
    const pending = toUnits(b.pending, MONEY) - got;
    if (pending <= 0n && toUnits(b.fine_pending, FINE) <= 0n) continue;
    openBills.push(got === 0n ? b : { ...b, received: fromUnits(toUnits(b.received, MONEY) + got, MONEY), pending: fromUnits(pending, MONEY) });
  }
  return { ...state, openBills };
}

// ------------------------------------------------------------------ the function

/**
 * X2. `key` is the Idempotency-Key as idempotencyKey() read it, `customerId` the id in the path. Returns the answer and whether it is the stored answer of an earlier call with the same key.
 */
export async function recordPayment(
  app: FastifyInstance,
  request: FastifyRequest,
  auth: Auth,
  key: string,
  customerId: string,
  input: RecordPaymentBody,
): Promise<{ value: RecordPaymentResult; replayed: boolean }> {
  const role = auth.user.role;
  const by = auth.user.id;
  const ctx = contextOf(app, request, auth);

  return withTx(ctx, async (tx) => {
    // 1. the claim, the role check, a repeat of the key
    const c = await claim(tx, { key, fn: 'record_payment', route: ROUTE_NAME, pathIds: { id: customerId }, body: input });
    assertMayCall(role, ACTION); // X0 item 2: after the claim, whose row the rollback removes when this refuses
    if (input.cash_override_reason != null && !mayUseField(role, 'cash_override_reason')) {
      throw new JvError('JV_FORBIDDEN', 'Only the owner can give a reason for cash over the limit.', { details: { field: 'cash_override_reason' } });
    }
    if (!c.first) return { value: c.result as RecordPaymentResult, replayed: true };

    // 2. the customer row FOR UPDATE, then "exists and is not archived"; one reading of the clock after the lock
    const customer = await lockCustomer(tx, customerId);
    if (!customer) throw notFound();
    if (customer.archived_at !== null) throw new JvError('JV_CUSTOMER_ARCHIVED', 'This customer is archived. Bring the customer back before taking a payment.', { details: { customer_id: customer.id } });
    const now = app.clock.read();
    const at = now.timestamp;
    const paidOn = checkBillDate(input.paid_on, now.date, role, 'paid_on'); // Y8
    const walkin = Number(customer.is_walkin) === 1;
    const amount = toUnits(input.amount, MONEY);

    // 3. the state of the customer, read ONCE (X0 item 8); the hook of the test build is the return of this call. The bills with MONEY pending are the ones a money payment can pay (Y3).
    const state = await readCustomerState(tx, { fn: 'x02', customerId: customer.id });
    const pending = state.openBills.filter((b) => toUnits(b.pending, MONEY) > 0n);
    const named = input.bill_id == null ? null : (pending.find((b) => b.id === input.bill_id) ?? null);
    if (input.bill_id != null && named === null) {
      // not this customer's, cancelled, paid, or only silver pending: one answer for all of them, which tells a stranger nothing about another customer's bills
      throw invalid('bill_id', 'must be an active bill of this customer with money still to pay');
    }
    if (walkin) {
      // K5: one row stands for strangers whose money must not pay each other's bills, so the payment names its bill and takes no more than that bill's pending
      if (named === null) throw new JvError('JV_OVERPAYMENT', 'A payment for the walk-in customer must name the bill it pays.', { details: { field: 'bill_id' } });
      if (amount > toUnits(named.pending, MONEY)) {
        throw new JvError('JV_OVERPAYMENT', 'A payment for the walk-in customer cannot be more than is pending on the bill it pays.', { details: { field: 'amount', pending: named.pending } });
      }
    }

    // The cash rules of section 13 (Z1, Z2), before the first write: only a Cash payment is judged; the day is the date of the payment; the reason comes back only when the override was needed.
    const cashRules = await applyCashRules(tx, { customerId: customer.id, walkin, day: paidOn, cash: input.mode === 'Cash' ? amount : 0n, role, reason: input.cash_override_reason });

    // 4. the writes. The receipt (a money receipt: kind, no silver, not an opening advance), its audit row, then the payment's own allocation by Y3.
    const receiptId = newId();
    const receiptRow = await insertReceipt(tx, {
      id: receiptId,
      customerId: customer.id,
      kind: 'money',
      mode: input.mode,
      amount: fromUnits(amount, MONEY),
      fineGrams: '0.000',
      silverRate: null,
      paidOn,
      reference: input.reference ?? null,
      notes: input.notes ?? null,
      cashOverrideReason: cashRules.reason,
      at,
      by,
    });

    const plan = planRebalance(
      {
        bills: pending.map((b) => ({ id: b.id, pending: b.pending, fine_pending: b.fine_pending })),
        receipts: [{ id: receiptId, kind: 'money', remaining: fromUnits(amount, MONEY), fine_remaining: fromUnits(0n, FINE) }],
        advance: fromUnits(amount, MONEY),
        fine_advance: fromUnits(0n, FINE),
        first: named?.id ?? null,
      },
      newId,
    );
    const own: AllocationRow[] = plan.allocations.map((a) => ({ ...a, customer_id: customer.id, released_at: null, created_at: at, updated_at: at }));
    await insertAllocations(tx, own);
    // D23: the bills that received money and the customer carry the stamp of the call, also when nothing was allocated (the advance moved the customer's figures)
    await touchForReceiptWrite(tx, { customerId: customer.id, billIds: own.map((a) => a.bill_id), at });

    // Y6: the rebalance on the state as the payment left it. The leftover of this receipt is money the customer now holds (it can only be spent when nothing is pending, so it applies nothing itself);
    // an older advance held beside a pending bill, which I10 forbids but an import may have left, is applied here, oldest receipt first. The walk-in is never rebalanced (K5).
    const left = amount - own.reduce((n, a) => n + toUnits(a.amount, MONEY), 0n);
    const rebalanced = await rebalance(tx, {
      customerId: customer.id,
      walkin,
      state: afterOwnAllocation(state, own),
      at,
      newReceipts: [{ id: receiptId, kind: 'money', paid_on: paidOn, created_at: at, remaining: fromUnits(left, MONEY), fine_remaining: fromUnits(0n, FINE) }],
    });

    const all = [...own, ...rebalanced.allocations];
    const toThisReceipt = all.filter((a) => a.receipt_id === receiptId).reduce((n, a) => n + toUnits(a.amount, MONEY), 0n);
    const value: RecordPaymentResult = {
      receipt: wireRow('receipts', role, receiptRow),
      allocations: all.map((a) => wireRow('receipt_allocations', role, { ...a })),
      advance_remaining: fromUnits(amount - toThisReceipt, MONEY),
    };
    await storeResult(tx, c.key, value);
    return { value, replayed: false };
  });
}

/** Registers `fn:record_payment`. */
export function registerRecordPayment(app: FastifyInstance): void {
  route(app, {
    action: ACTION,
    body: recordPaymentBody,
    handler: async ({ app: a, request, reply, auth, body }) => {
      const { id } = wire.parseInput(wire.strictObject({ id: wire.uuid }), request.params); // the customer: a lower-case UUID in the path
      const key = idempotencyKey(request.headers); // before the transaction: a missing or malformed key claims nothing
      const { value, replayed } = await recordPayment(a, request, auth, key, id, body);
      markReplay(reply, replayed);
      return reply.code(201).send(value);
    },
  });
}
