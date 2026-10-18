// X12 add_opening_balance (POST /v1/customers/:id/opening-balance, 201 {bill, receipts, allocations}), X12, IM5, D15, D11, D13, D23, Y6, Y8, Y9, K5, I5, L3, L5, X0, T-B21, T-B17, T-A09, T-D09, T-D14, T-C16.
//
// Opening balances are ORDINARY ROWS (D15). What a customer owed on the first day is one `bills` row with doc_type `opening_balance`, no lines, `grand_total` and `fine_weight_due` set to the figures,
// dated the cut-over day and numbered `OB-nnnn`; what a customer had paid in advance is a `receipts` row with `is_opening` (kind `money` with mode `Other`, or `fine_silver` with no mode; reference
// "Opening advance"). The import writes the same rows (scripts/import.mjs, IM1) and calls the same rebalance (IM4). X12 is for a correction after the import (IM5: a wrong figure is fixed by cancelling
// the opening bill with X5 and adding a new one here; a wrong opening advance is voided with X4) and for customers created later. Opening rows are NOT sales (V2 `total_purchases` and V5 leave the
// bills out), NOT money received today (V4 leaves the receipts out, also when voided) and NOT cash for the limit of Z1 (cashToday leaves them out, and D13 forbids a Cash opening row), so none of the
// cash rules runs here. Payments, "oldest first", pending and the ledger then work with no special case: Y9 lets the rebalance pay the opening bill first when it is the oldest.
//
//   path     the customer (`p_customer_id`): a lower-case UUID, else 422 on `id`; no such customer is 404 JV_NOT_FOUND; an archived one is 409 JV_CUSTOMER_ARCHIVED (as X1 to X3 say).
//   body     dues, fine_due, advance, fine_advance (each absent, null or a text at least 0: money with at most 2 decimals, silver in grams with at most 3; not all of them 0), as_of (required: the
//            day the bill and the receipts are dated; Y8 as for every business date, so the owner may use any day up to and including today and never a future one). Nothing else.
//   header   Idempotency-Key.
//   answer   201 {bill, receipts, allocations}: `bill` is the opening bill (null when the call had neither dues nor fine due), `receipts` the opening advances in the order money, silver, and
//            `allocations` the rows the rebalance made (an advance and dues of one customer net off), all in the wire format of the sync read of the caller's role.
//
// THE RULES. Dues or fine due above 0 make the bill (one for both); an advance above 0 makes a `money` receipt, a fine advance above 0 a `fine_silver` receipt (so one call can save two). The walk-in
// customer never holds an advance (K5, I10): an advance or a fine advance for it is 409 JV_NOT_ALLOWED naming the field and nothing is saved (not the bill either); opening DUES for the walk-in are
// allowed, like any dues (the import loads them), and the walk-in is never rebalanced. A figure above the caps of S4 is refused by the parser, never by the CHECK.
//
// ORDER OF WORK (X0). The route wrapper has already refused everything it can without a database (no session, a role other than the owner, an invalid body). Before the transaction, and so before the
// key is claimed, the counter row of the `opening` series is made when the call will take a number (L3: ensureSeries). Then ONE transaction:
//   1. the claim of the key (L5, the first statement), the role check again (X0 item 2), the stored answer if the key is a repeat (before any lock or date check);
//   2. the customer row FOR UPDATE (X0 item 3), "exists, not archived", then ONE reading of the API clock: its date is the business day for Y8, its stamp is every stamp of the call (C4); the walk-in
//      rule, which needs nothing but the customer row, is decided here;
//   3. the state of the customer, read ONCE (X0 item 8, `x12.after_read` of the test build: the hook is a wrapper of the test build, not a line of this file); the rebalance allocates from it and
//      reads nothing again;
//   4. the number of the bill, LAST of the locks and after every check (X0 item 6): `OB-nnnn` from the `opening` counter, skipping a number that already exists (an imported one, L3, IM3). A call
//      with no dues and no fine due takes no number and sends no counter statement;
//   5. the writes, all stamped by the one reading: the bill and its audit row, the receipts and theirs, the touch of the customer (D23), then the rebalance of Y6 with the call's own bill and
//      receipts handed over (it places them by date and stamp, so the opening bill is paid before the newer bills and an advance pays the oldest bills first);
//   6. the result is stored in the claim row, in the same transaction.
// A failure anywhere rolls everything back, the claim and the number included.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { type AuditedRow, auditChange } from '../db/audit.js';
import { claim, idempotencyKey, markReplay, storeResult } from '../db/idempotency.js';
import { newId } from '../db/ids.js';
import { lockCustomer } from '../db/locks.js';
import { ensureSeries, nextBillNo, openingNumbers } from '../db/numbers.js';
import { readCustomerState } from '../db/state.js';
import { touchForBillWrite, touchForReceiptWrite } from '../db/touch.js';
import { txContextFor, withTx } from '../db/tx.js';
import { type NewReceipt, fromUnits, rebalance, toUnits } from '../domain/rebalance.js';
import { type Row, notFound, readRow, wireRow } from '../edit/engine.js';
import { JvError, unavailableError } from '../errors.js';
import { type Auth, assertMayCall, route } from '../permissions/route.js';
import * as wire from '../wire/zod.js';
import { insertReceipt } from './receiptWrite.js';
import { checkBillDate } from './x07QuoteBill.js';

// ------------------------------------------------------------------ the body

const hasFigure = (text: string | null | undefined): boolean => text != null && /[1-9]/.test(text);

export const addOpeningBalanceBody = wire
  .strictObject({
    /** what the customer owed on the day, in rupees (a bill of this grand total) */
    dues: wire.amount.nullish(),
    /** the silver the customer owed on the day, in grams (the fine weight due of the same bill) */
    fine_due: wire.weight.nullish(),
    /** what the customer had paid in advance, in rupees (a `money` receipt of mode Other) */
    advance: wire.amount.nullish(),
    /** the silver the customer had paid in advance, in grams (a `fine_silver` receipt) */
    fine_advance: wire.weight.nullish(),
    /** the day the rows are dated: the cut-over day (Y8: any day up to today for the owner) */
    as_of: wire.businessDate,
  })
  .check((ctx) => {
    const v = ctx.value;
    if (!hasFigure(v.dues) && !hasFigure(v.fine_due) && !hasFigure(v.advance) && !hasFigure(v.fine_advance)) {
      ctx.issues.push({ code: 'custom', message: 'at least one of dues, fine_due, advance and fine_advance must be above 0', input: ctx.value, path: ['dues'] });
    }
  });
export type AddOpeningBalanceBody = z.output<typeof addOpeningBalanceBody>;

// ------------------------------------------------------------------ the answer

export interface AddOpeningBalanceResult {
  /** the opening_balance bill, or null when the call had neither dues nor fine due */
  bill: Row | null;
  /** the is_opening receipts made: the money advance first, then the silver one */
  receipts: Row[];
  /** the rows the rebalance made (an advance and dues of one customer net off, Y6) */
  allocations: Row[];
}

const ACTION = 'fn:add_opening_balance';
const ROUTE_NAME = 'POST /v1/customers/:id/opening-balance';
const MONEY = 2;
const FINE = 3;
/** D15: the reference of an opening advance (the import writes the same words) */
export const OPENING_REFERENCE = 'Opening advance';

const BILL_INSERT =
  'INSERT INTO bills (id, bill_no, customer_id, bill_date, doc_type, sale_type, status, pricing_version, subtotal, discount, additional_charges, gst_percent, gst_amount, grand_total, round_off, fine_weight_due, notes, cash_override_reason, request_id, created_at, updated_at, created_by, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';

function contextOf(app: FastifyInstance, request: FastifyRequest, auth: Auth) {
  if (!app.db) throw unavailableError();
  return txContextFor(app.db, request, { id: auth.user.id, role: auth.user.role });
}

// ------------------------------------------------------------------ the function

/**
 * X12. `key` is the Idempotency-Key as idempotencyKey() read it, `customerId` the id in the path. Returns the answer and whether it is the stored answer of an earlier call with the same key.
 */
export async function addOpeningBalance(
  app: FastifyInstance,
  request: FastifyRequest,
  auth: Auth,
  key: string,
  customerId: string,
  input: AddOpeningBalanceBody,
): Promise<{ value: AddOpeningBalanceResult; replayed: boolean }> {
  const role = auth.user.role;
  const by = auth.user.id;
  const ctx = contextOf(app, request, auth);
  const dues = toUnits(input.dues ?? '0.00', MONEY);
  const fineDue = toUnits(input.fine_due ?? '0.000', FINE);
  const advance = toUnits(input.advance ?? '0.00', MONEY);
  const fineAdvance = toUnits(input.fine_advance ?? '0.000', FINE);
  const makesBill = dues > 0n || fineDue > 0n;

  // before the transaction (L3): the counter row of the series exists, when this call will take a number
  if (makesBill) await ensureSeries(ctx, openingNumbers.key);

  return withTx(ctx, async (tx) => {
    // 1. the claim, the role check, a repeat of the key
    const c = await claim(tx, { key, fn: 'add_opening_balance', route: ROUTE_NAME, pathIds: { id: customerId }, body: input });
    assertMayCall(role, ACTION); // X0 item 2: after the claim, whose row the rollback removes when this refuses
    if (!c.first) return { value: c.result as AddOpeningBalanceResult, replayed: true };

    // 2. the customer row FOR UPDATE, then "exists and is not archived"; one reading of the clock after the lock
    const customer = await lockCustomer(tx, customerId);
    if (!customer) throw notFound();
    if (customer.archived_at !== null) throw new JvError('JV_CUSTOMER_ARCHIVED', 'This customer is archived. Bring the customer back before adding an opening balance.', { details: { customer_id: customer.id } });
    const now = app.clock.read();
    const at = now.timestamp;
    const asOf = checkBillDate(input.as_of, now.date, role, 'as_of'); // Y8
    const walkin = Number(customer.is_walkin) === 1;
    // K5: one row stands for strangers whose money must not pay each other's bills, so the walk-in never holds an advance (I10); its opening dues are fine
    if (walkin && (advance > 0n || fineAdvance > 0n)) {
      throw new JvError('JV_NOT_ALLOWED', 'The walk-in customer cannot hold an advance, because one row stands for many different people. Add opening dues only, or choose or create the customer.', {
        details: { field: advance > 0n ? 'advance' : 'fine_advance', reason: 'walkin_holds_no_advance' },
      });
    }

    // 3. the state of the customer, read ONCE (X0 item 8); the hook of the test build is the return of this call
    const state = await readCustomerState(tx, { fn: 'x12', customerId: customer.id });

    // 4. the number, last (X0 item 6): only a call that makes the bill takes one
    const issued = makesBill ? await nextBillNo(tx, openingNumbers) : null;

    // 5. the writes, stamped from the one reading taken after the locks (C4)
    let billRow: Row | null = null;
    const billId = newId();
    if (issued) {
      await tx.run(BILL_INSERT, [
        billId, issued.no, customer.id, asOf, 'opening_balance', customer.customer_type, 'active', 1, '0.00', '0.00', '0.00', '0.00', '0.00', fromUnits(dues, MONEY), '0.00', fromUnits(fineDue, FINE), null, null, c.key, at, at, by, by,
      ]);
      billRow = (await readRow(tx, 'bills', billId, false)) ?? null;
      if (!billRow) throw new Error('the opening bill is gone after its own insert');
      await auditChange(tx, { table: 'bills', action: 'insert', before: null, after: billRow as AuditedRow });
    }

    const receipts: Row[] = [];
    const fresh: NewReceipt[] = [];
    if (advance > 0n) {
      const id = newId();
      receipts.push(await insertReceipt(tx, { id, customerId: customer.id, kind: 'money', mode: 'Other', amount: fromUnits(advance, MONEY), fineGrams: fromUnits(0n, FINE), silverRate: null, paidOn: asOf, reference: OPENING_REFERENCE, notes: null, cashOverrideReason: null, isOpening: true, at, by }));
      fresh.push({ id, kind: 'money', paid_on: asOf, created_at: at, remaining: fromUnits(advance, MONEY), fine_remaining: fromUnits(0n, FINE) });
    }
    if (fineAdvance > 0n) {
      const id = newId();
      receipts.push(await insertReceipt(tx, { id, customerId: customer.id, kind: 'fine_silver', mode: null, amount: fromUnits(0n, MONEY), fineGrams: fromUnits(fineAdvance, FINE), silverRate: null, paidOn: asOf, reference: OPENING_REFERENCE, notes: null, cashOverrideReason: null, isOpening: true, at, by }));
      fresh.push({ id, kind: 'fine_silver', paid_on: asOf, created_at: at, remaining: fromUnits(0n, MONEY), fine_remaining: fromUnits(fineAdvance, FINE) });
    }
    // D23: the customer's figures changed (the bill carries the stamp already); the bills that receive the advance are touched by the rebalance
    if (receipts.length > 0) await touchForReceiptWrite(tx, { customerId: customer.id, billIds: [], at });
    else await touchForBillWrite(tx, { customerId: customer.id, at });

    // Y6, Y9: an advance and dues of one customer net off. The call's own bill and receipts are handed over (they were written after the state was read); the walk-in is never rebalanced (K5).
    const rebalanced = await rebalance(tx, {
      customerId: customer.id,
      walkin,
      state,
      at,
      newBills: billRow ? [{ id: billId, bill_date: asOf, created_at: at, pending: fromUnits(dues, MONEY), fine_pending: fromUnits(fineDue, FINE) }] : [],
      newReceipts: fresh,
    });

    const value: AddOpeningBalanceResult = {
      bill: billRow ? wireRow('bills', role, billRow) : null,
      receipts: receipts.map((r) => wireRow('receipts', role, r)),
      allocations: rebalanced.allocations.map((a) => wireRow('receipt_allocations', role, { ...a })),
    };
    await storeResult(tx, c.key, value);
    return { value, replayed: false };
  });
}

/** Registers `fn:add_opening_balance`. */
export function registerAddOpeningBalance(app: FastifyInstance): void {
  route(app, {
    action: ACTION,
    body: addOpeningBalanceBody,
    handler: async ({ app: a, request, reply, auth, body }) => {
      const { id } = wire.parseInput(wire.strictObject({ id: wire.uuid }), request.params); // the customer: a lower-case UUID in the path
      const key = idempotencyKey(request.headers); // before the transaction: a missing or malformed key claims nothing
      const { value, replayed } = await addOpeningBalance(a, request, auth, key, id, body);
      markReplay(reply, replayed);
      return reply.code(201).send(value);
    },
  });
}
