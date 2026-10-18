// X10 reissue_bill (POST /v1/bills/:id/reissue, 201 {old_bill, new_bill, items, receipts, allocations, released_allocations, warnings, advance_applied}), X10, K1, K3, K5, K6, Y3, Y5, Y6, Y8, Z1 to Z3,
// L3, L5, X0, D23, T-B17, T-B19, T-B25, T-C13, T-C21.
//
// THE CORRECTION PATH. A bill is never edited (K1): the wrong one is CANCELLED and the right one is SAVED in the same transaction, and the money already received moves to the right one. The new
// bill points back to the one it replaces (`reissue_of`, K6), is made by the rules of X1 (the same pricing, the same piece rules, the same cash and PAN rules, a number of its own from the series)
// and belongs to the old bill's customer; the customer cannot change, so `customer_id` is not an input.
//
//   path     the old bill (`p_old_bill_id`): a lower-case UUID, else 422 on `id`; no such bill is 404 JV_NOT_FOUND.
//   body     reason (3 to 500 characters once trimmed), then the body of X1 without `customer_id`: sale_type, bill_date, items, discount, additional_charges, notes, payments, confirm_held,
//            cash_override_reason.
//   header   Idempotency-Key.
//   answer   201 {old_bill, new_bill, items, receipts, allocations, released_allocations, warnings, advance_applied}: the keys of NODE-DESIGN 4.3 and, besides them, `released_allocations`, the
//            allocations of the old bill that the cancel released (the cache cannot guess them). `allocations` are the rows the call MADE: first those of the carried-over money, then those of the
//            explicit payments. `advance_applied` is the money that was carried to the new bill ("Advance adjusted", O23).
//
// THE RULES. The old bill must be `active` and an `estimate`: a cancelled one (also one that was re-issued already: a re-issue cancels the old bill, so it meets a cancelled bill, K6) is
// JV_BILL_CANCELLED; an opening-balance bill is JV_NOT_ALLOWED (it has no lines to correct: cancel it with X5 and add a new opening balance with X12). An archived customer is refused like in every
// money function. Then the carried-over money: the receipts stay active when the bill is cancelled (K3), so what they had paid on it is the customer's advance, and the rebalance gives it to the NEW
// bill before any other bill, oldest receipt first (Y3 with a named bill, Y6); silver grams the same way. What is left goes to the customer's other pending bills as it would after any cancel.
// Only then are the explicit payments recorded (X1 (i)), and the overpayment check (Y5) counts what was carried over. For the WALK-IN, who never holds an advance (K5, one row stands for
// strangers), the carried money may go to the new bill ONLY: a surplus of money over the new bill's total, or of silver grams over its fine due, is refused with JV_NOT_ALLOWED and nothing changes
// (void the receipts first, so that the money going back shows on its own day); the other pending bills of the walk-in are never paid.
//
// ORDER OF WORK (X0). Before the transaction, as in X1: ONE clock reading (the business date for Y8 and the year of the number), the prefix of the bill numbers and the counter row of the series. Then
// ONE transaction:
//   1. the claim of the key (L5, the first statement), the role check again (X0 item 2), the stored answer if the key is a repeat;
//   2. the customer is found from the old bill WITHOUT a lock, locked, and the bill is read again FOR UPDATE and must be the SAME customer's (X0 item 3): a second re-issue of one bill is
//      JV_BILL_CANCELLED, never a false JV_BUSY. Then what needs no more reading: the status and kind of the old bill, the archive, Y8, each piece once, the confirm list;
//   3. the plain reads of the cancel (the bill's open allocations and lines), then the state of the customer, read ONCE and including the old bill and the receipts allocated to it
//      (X0 item 8: `x10.after_read` of the test build);
//   4. the pieces of BOTH lists, the old bill's and the new lines', by ONE statement in MariaDB's id order (X0 item 5; a piece on both lists is locked once); R10 is judged on the locked rows with
//      the old bill's pieces counted as freed (the cancel returns them to stock in this transaction); the plain reads and the pricing of X1;
//   5. all the checks, in memory: the state as the cancel leaves it (src/domain/reopen.ts), the rebalance PLANNED with the new bill first, the walk-in's surplus (K5), the explicit payments against
//      what is carried over (Y5), the cash rules (Z1, Z2); then the number, LAST (X0 item 6);
//   6. the writes, in this order: the cancel (K3, no rebalance of its own: stamped by its own clock reading), the new bill and its lines and its pieces (stamped by a second reading, so the cancel
//      comes first in the ledger of V3: Cancellation, Invoice, Payment, T-B25), the carried-over money, the explicit payments; the audit rows and the touches are written with each (L1, D23);
//   7. the answer is stored in the claim row, in the same transaction.
// A failure anywhere rolls everything back, the claim and the number included: the old bill is still active and nothing else has changed.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { claim, idempotencyKey, markReplay, storeResult } from '../db/idempotency.js';
import { newId } from '../db/ids.js';
import { lockCustomerOf, lockPieces } from '../db/locks.js';
import { billNumbers, ensureSeries, nextBillNo } from '../db/numbers.js';
import { readCustomerState } from '../db/state.js';
import { txContextFor, withRead, withTx } from '../db/tx.js';
import { applyCashRules } from '../domain/cashRules.js';
import { CURRENT_PRICING_VERSION } from '../domain/pricing.js';
import { type NewBill, applyRebalance, fromUnits, planRebalanceOf, toUnits } from '../domain/rebalance.js';
import { stateAfterCancel } from '../domain/reopen.js';
import { type Row, notFound, wireRow } from '../edit/engine.js';
import { JvError, unavailableError } from '../errors.js';
import { type Auth, assertMayCall, route } from '../permissions/route.js';
import * as wire from '../wire/zod.js';
import { reasonText } from './reason.js';
import { readBillToCancel, writeCancel } from './x05CancelBill.js';
import { type CreateBillOptions, confirmedPieces, createBillBody, planPayments, priceNewBill, writeNewBill, writePayments } from './x01CreateBill.js';
import { PRICING_VERSIONS, assertEachPieceOnce, checkBillDate, readEstimate } from './x07QuoteBill.js';

// ------------------------------------------------------------------ the body

/** `reason`, then the body of X1 without `customer_id`. The object stays strict, so a `customer_id` (the old bill's own or another) is refused: the customer cannot change. */
export const reissueBillBody = createBillBody.omit({ customer_id: true }).extend({ reason: reasonText });
export type ReissueBillBody = z.output<typeof reissueBillBody>;

// ------------------------------------------------------------------ the answer

export interface ReissueBillResult {
  /** the cancelled bill, as it is now */
  old_bill: Row;
  /** the new bill; `reissue_of` is the old bill's id */
  new_bill: Row;
  /** the lines of the new bill */
  items: Row[];
  /** the money receipts of the new payment rows (rows of amount 0 are left out) */
  receipts: Row[];
  /** the allocations the call made, in the order of the writes: the carried-over money (the new bill first), then the new payments */
  allocations: Row[];
  /** the allocations of the old bill that the cancel released */
  released_allocations: Row[];
  warnings: string[];
  /** money carried over to THE NEW BILL by the rebalance, money text ("0.00" when the old bill had received nothing) */
  advance_applied: string;
}

const ACTION = 'fn:reissue_bill';
const ROUTE_NAME = 'POST /v1/bills/:id/reissue';

function contextOf(app: FastifyInstance, request: FastifyRequest, auth: Auth) {
  if (!app.db) throw unavailableError();
  return txContextFor(app.db, request, { id: auth.user.id, role: auth.user.role });
}

const internal = (what: string): JvError => new JvError('JV_INTERNAL', 'Something unexpected went wrong.', { cause: new Error(what) });

// ------------------------------------------------------------------ the function

/** X10. `key` is the Idempotency-Key as idempotencyKey() read it, `oldBillId` the id in the path. Returns the answer and whether it is the stored answer of an earlier call with the same key. */
export async function reissueBill(
  app: FastifyInstance,
  request: FastifyRequest,
  auth: Auth,
  key: string,
  oldBillId: string,
  input: ReissueBillBody,
  options: CreateBillOptions = {},
): Promise<{ value: ReissueBillResult; replayed: boolean }> {
  const role = auth.user.role;
  const by = auth.user.id;
  const versions = options.versions ?? PRICING_VERSIONS;
  const version = options.pricingVersion ?? CURRENT_PRICING_VERSION;
  if (!Object.hasOwn(versions, version)) throw new Error(`the bill is to be priced with version ${version}, which the version table does not hold`);
  const ctx = contextOf(app, request, auth);

  // before the transaction (L3), as X1 does it: ONE reading of the clock for the business date and the year of the series, the prefix, and the counter row of the series
  const day = app.clock.read();
  const estimate = await withRead(ctx, (r) => readEstimate(r));
  const series = billNumbers(day, estimate.prefix);
  await ensureSeries(ctx, series.key);

  return withTx(ctx, async (tx) => {
    // 1. the claim, the role check, a repeat of the key
    const c = await claim(tx, { key, fn: 'reissue_bill', route: ROUTE_NAME, pathIds: { id: oldBillId }, body: input });
    assertMayCall(role, ACTION); // X0 item 2: after the claim, whose row the rollback removes when this refuses
    if (!c.first) return { value: c.result as ReissueBillResult, replayed: true };

    // 2. the customer from the old bill, locked, the bill read again FOR UPDATE (the same customer, or JV_BUSY); everything that needs no more reading is decided now, after the lock
    const found = await lockCustomerOf(tx, 'bills', oldBillId);
    if (!found) throw notFound();
    const { customer, row: old } = found;
    if (old.status !== 'active') throw new JvError('JV_BILL_CANCELLED', 'This bill has already been cancelled, so it cannot be re-issued. A bill can be re-issued once.', { details: { bill_id: oldBillId } });
    if (old.doc_type !== 'estimate') {
      throw new JvError('JV_NOT_ALLOWED', 'Only an estimate can be re-issued. Cancel this bill and add a new opening balance instead.', { details: { reason: 'not_an_estimate', bill_id: oldBillId, doc_type: old.doc_type } });
    }
    if (customer.archived_at !== null) throw new JvError('JV_CUSTOMER_ARCHIVED', 'This customer is archived. Bring the customer back before re-issuing a bill.', { details: { customer_id: customer.id } });
    const billDate = checkBillDate(input.bill_date, day.date, role); // Y8
    assertEachPieceOnce(input.items); // X1 (a)
    const confirmed = confirmedPieces(input);
    const walkin = Number(customer.is_walkin) === 1;

    // 3. the plain reads of the cancel, then the state of the customer, read ONCE (X0 item 8): it includes the old bill (V1) and the receipts with live allocations to it (S4)
    const toCancel = await readBillToCancel(tx, { id: old.id, customer_id: customer.id });
    const state = await readCustomerState(tx, { fn: 'x10', customerId: customer.id, reopen: { billId: old.id } });
    const figures = state.bill;
    if (!figures) throw internal(`the state read of X10 did not return bill ${old.id}`);

    // 4. the pieces of BOTH lists by ONE statement (X0 item 5), after the customer and before any write; the old bill's pieces are freed by the cancel, so they may go on the new bill
    const locked = await lockPieces(tx, [...toCancel.skuIds, ...input.items.map((i) => i.sku_id)]);
    const freed = new Set(locked.filter((p) => p.sold_bill_id === old.id).map((p) => p.id));
    const priced = await priceNewBill(tx, { customer, input, billDate, locked, confirmed, freed, estimate, versions, version });
    const { quote, grand, warnings } = priced;

    // 5. the checks, all in memory. The state as the cancel leaves it; the rebalance planned with the NEW bill first (it is handed over as a bill the call makes, and named, Y3), so that the
    // money and the silver the old bill had received go to it before any other bill, oldest receipt first (Y6).
    const adjusted = stateAfterCancel(state, figures, toCancel.open.map((r) => ({ receipt_id: String(r.receipt_id), amount: String(r.amount), fine_grams: String(r.fine_grams) })));
    const newBillId = newId();
    const fresh: NewBill = { id: newBillId, bill_date: billDate, created_at: day.timestamp, pending: fromUnits(grand, 2), fine_pending: quote.totals.fine_weight_due }; // `first` decides its place, not the stamp
    // K5: the walk-in is not rebalanced; its carried-over money may go to the new bill and to no other (one row stands for strangers), so only the new bill takes part
    const planned = planRebalanceOf({ customerId: customer.id, walkin: false, state: walkin ? { ...adjusted, openBills: [] } : adjusted, first: newBillId, newBills: [fresh] });
    if (walkin) {
      const surplus = toUnits(adjusted.totals.advance, 2) - toUnits(planned.plan.applied, 2);
      const fineSurplus = toUnits(adjusted.totals.fine_advance, 3) - toUnits(planned.plan.fine_applied, 3);
      if (surplus > 0n || fineSurplus > 0n) {
        throw new JvError(
          'JV_NOT_ALLOWED',
          'The money or silver received on the old bill is more than the new bill needs, and the walk-in customer cannot hold an advance. Void those receipts first, with the reason, then re-issue the bill.',
          { details: { reason: 'void_its_receipts_first', surplus: fromUnits(surplus > 0n ? surplus : 0n, 2), fine_surplus: fromUnits(fineSurplus > 0n ? fineSurplus : 0n, 3) } },
        );
      }
    }
    const carried = planned.plan.allocations.filter((a) => a.bill_id === newBillId).reduce((n, a) => n + toUnits(a.amount, 2), 0n);
    // (e) the explicit payments may not exceed what the new bill still needs after the carried-over money (Y5), and the cash rules judge the Cash rows (Z1, Z2): the old bill's Cash receipts stay
    // active, so they are in the day's cash already, and the carried-over money is not new cash
    const payments = planPayments(input.payments ?? [], grand, carried);
    const cash = await applyCashRules(tx, { customerId: customer.id, walkin, day: billDate, cash: payments.cash, role, reason: input.cash_override_reason });

    // the number, last (X0 item 6)
    const issued = await nextBillNo(tx, series);

    // 6. the writes. The cancel has a clock reading of its own and the new bill a second one: two rows of one transaction never tie (S5), so the ledger lists the Cancellation before the Invoice (T-B25)
    const cancelNow = app.clock.read();
    const cancelled = await writeCancel(tx, { bill: old, open: toCancel.open, pieces: locked, reason: input.reason, at: cancelNow.timestamp, day: cancelNow.date, by });
    const at = app.clock.read().timestamp;
    const made = await writeNewBill(tx, { customerId: customer.id, billDate, billNo: issued.no, priced, notes: input.notes, cashReason: cash.reason, requestId: c.key, reissueOf: old.id, at, by, billId: newBillId });
    const rebalanced = await applyRebalance(tx, { customerId: customer.id, at }, planned);
    const written = await writePayments(tx, { plan: payments, customerId: customer.id, billId: newBillId, billDate, at, by });

    const value: ReissueBillResult = {
      old_bill: wireRow('bills', role, cancelled.bill),
      new_bill: wireRow('bills', role, made.billRow),
      items: made.lineRows.map((r) => wireRow('bill_items', role, r)),
      receipts: written.receipts.map((r) => wireRow('receipts', role, r)),
      allocations: [...rebalanced.allocations, ...written.allocations].map((a) => wireRow('receipt_allocations', role, { ...a })),
      released_allocations: cancelled.released.map((r) => wireRow('receipt_allocations', role, r)),
      warnings: [...warnings].sort(),
      advance_applied: fromUnits(carried, 2),
    };
    await storeResult(tx, c.key, value);
    return { value, replayed: false };
  });
}

/** Registers `fn:reissue_bill`. */
export function registerReissueBill(app: FastifyInstance, options: CreateBillOptions = {}): void {
  route(app, {
    action: ACTION,
    body: reissueBillBody,
    handler: async ({ app: a, request, reply, auth, body }) => {
      const { id } = wire.parseInput(wire.strictObject({ id: wire.uuid }), request.params); // the old bill: a lower-case UUID in the path
      const key = idempotencyKey(request.headers); // before the transaction: a missing or malformed key claims nothing
      const { value, replayed } = await reissueBill(a, request, auth, key, id, body, options);
      markReplay(reply, replayed);
      return reply.code(201).send(value);
    },
  });
}
