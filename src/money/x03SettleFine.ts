// X3 settle_fine (POST /v1/customers/:id/fine-settlements, 201 {receipt, allocations, fine_remaining}), X3, SF1, SF2, Y1, Y3, Y8, Z1, Z2, K5, O52, D13, D14, D23, S4, L5, X0, T-B11, T-B12, T-B13, T-B17,
// T-B23, T-A09, T-C09.
//
// Fine is the silver weight a customer owes from wholesale silver By Weight lines (R4, SF1). It is settled here, either in SILVER (a `fine_silver` receipt: grams, no mode, amount 0) or in CASH at
// that day's silver rate (a `fine_cash` receipt: grams, the rate, mode Cash and `amount = round(grams x rate, 2)`). The cash amount is money received (Y1): it is in V4's Cash row and in the cash
// of the day (Z1) but it is not a `money` receipt, so it does not reduce the rupees owed; it reduces the fine, through allocations that carry grams and no rupees.
//
//   path     the customer (`p_customer_id`): a lower-case UUID, else 422 on `id`; no such customer is 404 JV_NOT_FOUND.
//   body     grams (a weight above 0, at most 3 decimals), mode (Silver or Cash), silver_rate (Cash: required and above 0; Silver: none, a rate there is 422 so that nothing sent is dropped silently),
//            bill_id (optional: the bill to settle first), paid_on (absent or null: today; Y8), reference (at most 120), notes, cash_override_reason (the owner's right, Z1).
//   header   Idempotency-Key.
//   answer   201 {receipt, allocations, fine_remaining}: `receipt` and `allocations` are the rows in the wire format of the sync read of the caller's role. `allocations` are all the rows the call made,
//            in the order made: the settlement's own (Y3: the named bill first, then the oldest) and then those of the rebalance (Y6), if any. `fine_remaining` is the customer's fine outstanding (V2)
//            AFTER the call, in grams: what is still owed in silver. (Not "what is left of this receipt": SF2 lets nobody settle more than is owed, so every gram of the receipt is allocated.)
//
// THE RULES. SF2: the grams are above 0 and not more than the customer's fine outstanding, else JV_FINE_EXCEEDS (409) with `details.max_grams`; the prototype capped silently and lost the silver.
// K5, O52: for the walk-in the bill must be named and the grams are not more than THAT bill's fine pending (JV_FINE_EXCEEDS with that maximum; one row stands for strangers whose silver must not
// settle each other's bills). Y3: the named bill must be one of the customer's active bills with SILVER pending, else JV_INVALID_INPUT on `bill_id`. A cash settlement whose amount rounds to 0.00 is
// JV_INVALID_INPUT, and so is one over the amount cap of S4 (grams x rate, at most 1,000,000,000). The amount is worked out in whole paise (BigInt), half up, never in floating point.
// Z1, Z2: the cash rules of section 13 judge a `fine_cash` amount like a Cash payment (src/domain/cashRules.ts); a Silver settlement adds no cash. A biller who sends a reason is refused (403).
//
// ORDER OF WORK (X0). The route wrapper has already refused everything it can without a database (no session, a role not on the row, an invalid body). Before the transaction, and so before the
// key is claimed, the rules that need only the body are decided (the rate, the amount): a refusal there does not use the key up. Then ONE transaction:
//   1. the claim of the key (L5, the first statement), the role check again (X0 item 2), the stored answer if the key is a repeat (before any lock or date check);
//   2. the customer row FOR UPDATE (X0 item 3), "exists, not archived", then ONE reading of the API clock: its date is the business day for Y8, its stamp is every stamp of the call (C4);
//   3. the state of the customer, read ONCE (X0 item 8, `x03.after_read` of the test build: the hook is a wrapper of the test build, not a line of this file); everything below allocates from it
//      and reads nothing again;
//   4. the checks (the named bill, the walk-in, SF2), the cash rules, then the writes, all stamped by the one reading: the receipt and its audit row, the call's own allocation (planRebalance with
//      the one receipt: the named bill first, then the oldest, grams only), the touches of D23, then the rebalance of Y6 on the state as the settlement left it (the walk-in is never rebalanced, K5);
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
import { limits } from '../limits.js';
import { mayUseField } from '../permissions/matrix.js';
import { type Auth, assertMayCall, route } from '../permissions/route.js';
import * as wire from '../wire/zod.js';
import { insertReceipt } from './receiptWrite.js';
import { REFERENCE_MAX, cashOverrideReason } from './x01CreateBill.js';
import { checkBillDate } from './x07QuoteBill.js';

// ------------------------------------------------------------------ the body

/** X3: how the silver is settled. */
export const FINE_MODES = ['Silver', 'Cash'] as const;
const modeMessage = `must be one of ${FINE_MODES.join(', ')}`;

/** A weight above 0: at most 3 decimals, at most 100,000 g (S4); zero is the screen's empty field and is refused here. */
const fineGrams = wire.weight.check((ctx) => {
  if (!/[1-9]/.test(ctx.value)) ctx.issues.push({ code: 'custom', message: 'must be above 0', input: ctx.value });
});

export const settleFineBody = wire.strictObject({
  grams: fineGrams,
  mode: z.enum(FINE_MODES, { error: (issue) => (issue.input === undefined ? 'is required' : modeMessage) }),
  /** the silver rate of the day in rupees a gram: needed for Cash (above 0, decided with the amount), refused for Silver */
  silver_rate: wire.rate.nullish(),
  /** Y3: the bill to settle first. It must be an active bill of this customer with silver pending, else JV_INVALID_INPUT; the walk-in must name one (K5, O52). */
  bill_id: wire.uuid.nullish(),
  paid_on: wire.businessDate.nullish(),
  reference: (f.optionalText(REFERENCE_MAX).schema as z.ZodType<string | null>).optional(),
  notes: (f.optionalText(f.TEXT_MAX).schema as z.ZodType<string | null>).optional(),
  /** Z1: the owner's right (FIELD_RIGHTS), stored on the receipt when a Cash settlement needed it; a biller who sends it is refused after the claim. */
  cash_override_reason: cashOverrideReason,
});
export type SettleFineBody = z.output<typeof settleFineBody>;

// ------------------------------------------------------------------ the answer

export interface SettleFineResult {
  receipt: Row;
  /** every allocation the call made, in the order made: the settlement's own (Y3), then those of the rebalance (Y6) */
  allocations: Row[];
  /** weight text: the customer's fine outstanding after the call (V2), in grams */
  fine_remaining: string;
}

const ACTION = 'fn:settle_fine';
const ROUTE_NAME = 'POST /v1/customers/:id/fine-settlements';
const MONEY = 2;
const FINE = 3;
const AMOUNT_CAP_PAISE = BigInt(limits.maxAmount) * 100n;

function contextOf(app: FastifyInstance, request: FastifyRequest, auth: Auth) {
  if (!app.db) throw unavailableError();
  return txContextFor(app.db, request, { id: auth.user.id, role: auth.user.role });
}

// ------------------------------------------------------------------ what the body alone decides

export interface Settlement {
  kind: 'fine_silver' | 'fine_cash';
  /** milligrams */
  grams: bigint;
  /** paise: the rate of a cash settlement, null for silver */
  rate: bigint | null;
  /** paise: round(grams x rate, 2) for a cash settlement, 0 for silver */
  amount: bigint;
}

/**
 * SF1, Y3, S4, D13: the receipt the body asks for, or the refusal. Pure: the grams and the rate are exact units, the product has 5 decimals (milligrams x paise) and is rounded half up to 2; no float.
 * A cash settlement needs a rate above 0, its amount must be above 0.00 and within the cap; a silver one carries no rate.
 */
export function judgeSettlement(input: { grams: string; mode: 'Silver' | 'Cash'; silver_rate?: string | null }): Settlement {
  const grams = toUnits(input.grams, FINE);
  if (input.mode === 'Silver') {
    if (input.silver_rate != null) throw invalid('silver_rate', 'is only for a settlement in Cash; a settlement in Silver has no rate');
    return { kind: 'fine_silver', grams, rate: null, amount: 0n };
  }
  if (input.silver_rate == null) throw invalid('silver_rate', 'is required for a settlement in Cash');
  const rate = toUnits(input.silver_rate, MONEY);
  if (rate <= 0n) throw invalid('silver_rate', 'must be above 0');
  const amount = (grams * rate + 500n) / 1000n; // milligrams x paise has 5 decimals of a rupee; 3 are dropped, half up
  if (amount === 0n) throw invalid('grams', 'is too small for this silver rate: grams x rate, rounded to 2 decimals, would be 0.00');
  if (amount > AMOUNT_CAP_PAISE) throw invalid('grams', `times the silver rate is above the cap of ${limits.maxAmount.toLocaleString('en-US')}`);
  return { kind: 'fine_cash', grams, rate, amount };
}

// ------------------------------------------------------------------ after the settlement's own allocation

/** The state as the settlement's own allocation left it: the bills that received silver have less fine pending (and more settled); a bill with nothing left of either kind is no longer open. */
function afterOwnAllocation(state: CustomerState, own: readonly AllocationRow[]): CustomerState {
  const taken = new Map<string, bigint>();
  for (const a of own) taken.set(a.bill_id, (taken.get(a.bill_id) ?? 0n) + toUnits(a.fine_grams, FINE));
  const openBills: OpenBill[] = [];
  for (const b of state.openBills) {
    const got = taken.get(b.id) ?? 0n;
    const finePending = toUnits(b.fine_pending, FINE) - got;
    if (toUnits(b.pending, MONEY) <= 0n && finePending <= 0n) continue;
    openBills.push(got === 0n ? b : { ...b, fine_settled: fromUnits(toUnits(b.fine_settled, FINE) + got, FINE), fine_pending: fromUnits(finePending, FINE) });
  }
  return { ...state, openBills };
}

// ------------------------------------------------------------------ the function

/**
 * X3. `key` is the Idempotency-Key as idempotencyKey() read it, `customerId` the id in the path. Returns the answer and whether it is the stored answer of an earlier call with the same key.
 */
export async function settleFine(
  app: FastifyInstance,
  request: FastifyRequest,
  auth: Auth,
  key: string,
  customerId: string,
  input: SettleFineBody,
): Promise<{ value: SettleFineResult; replayed: boolean }> {
  const role = auth.user.role;
  const by = auth.user.id;
  const ctx = contextOf(app, request, auth);
  const settlement = judgeSettlement(input); // before the claim: a refusal that needs only the body does not use the key up

  return withTx(ctx, async (tx) => {
    // 1. the claim, the role check, a repeat of the key
    const c = await claim(tx, { key, fn: 'settle_fine', route: ROUTE_NAME, pathIds: { id: customerId }, body: input });
    assertMayCall(role, ACTION); // X0 item 2: after the claim, whose row the rollback removes when this refuses
    if (input.cash_override_reason != null && !mayUseField(role, 'cash_override_reason')) {
      throw new JvError('JV_FORBIDDEN', 'Only the owner can give a reason for cash over the limit.', { details: { field: 'cash_override_reason' } });
    }
    if (!c.first) return { value: c.result as SettleFineResult, replayed: true };

    // 2. the customer row FOR UPDATE, then "exists and is not archived"; one reading of the clock after the lock
    const customer = await lockCustomer(tx, customerId);
    if (!customer) throw notFound();
    if (customer.archived_at !== null) throw new JvError('JV_CUSTOMER_ARCHIVED', 'This customer is archived. Bring the customer back before settling silver.', { details: { customer_id: customer.id } });
    const now = app.clock.read();
    const at = now.timestamp;
    const paidOn = checkBillDate(input.paid_on, now.date, role, 'paid_on'); // Y8
    const walkin = Number(customer.is_walkin) === 1;

    // 3. the state of the customer, read ONCE (X0 item 8); the hook of the test build is the return of this call. The bills with SILVER pending are the ones a fine settlement can settle (Y3).
    const state = await readCustomerState(tx, { fn: 'x03', customerId: customer.id });
    const owing = state.openBills.filter((b) => toUnits(b.fine_pending, FINE) > 0n);
    const named = input.bill_id == null ? null : (owing.find((b) => b.id === input.bill_id) ?? null);
    if (input.bill_id != null && named === null) {
      // not this customer's, cancelled, settled, or only money pending: one answer for all of them, which tells a stranger nothing about another customer's bills
      throw invalid('bill_id', 'must be an active bill of this customer with silver still to settle');
    }
    if (walkin) {
      // K5, O52: one row stands for strangers whose silver must not settle each other's bills, so the settlement names its bill and takes no more than that bill's fine pending
      if (named === null) throw new JvError('JV_FINE_EXCEEDS', 'A silver settlement for the walk-in customer must name the bill it settles.', { details: { field: 'bill_id' } });
      const max = toUnits(named.fine_pending, FINE);
      if (settlement.grams > max) {
        throw new JvError('JV_FINE_EXCEEDS', `A silver settlement for the walk-in customer cannot be more than is pending on the bill it settles: at most ${fromUnits(max, FINE)} g.`, {
          details: { field: 'grams', max_grams: fromUnits(max, FINE) },
        });
      }
    }
    // SF2: not more than the customer's fine outstanding (V2); nothing is capped silently
    const outstanding = toUnits(state.totals.fine_outstanding, FINE);
    if (settlement.grams > outstanding) {
      const max = outstanding > 0n ? outstanding : 0n;
      throw new JvError('JV_FINE_EXCEEDS', `The silver to settle is more than is owed: at most ${fromUnits(max, FINE)} g can be settled.`, { details: { field: 'grams', max_grams: fromUnits(max, FINE) } });
    }

    // The cash rules of section 13 (Z1, Z2), before the first write: only a fine settled in cash is cash; the day is the date of the settlement; the reason comes back only when the override was needed.
    const cashRules = await applyCashRules(tx, { customerId: customer.id, walkin, day: paidOn, cash: settlement.amount, role, reason: input.cash_override_reason });

    // 4. the writes. The receipt (fine_silver: no mode, amount 0; fine_cash: mode Cash, the rate and the amount), its audit row, then the settlement's own allocation by Y3.
    const receiptId = newId();
    const grams = fromUnits(settlement.grams, FINE);
    const receiptRow = await insertReceipt(tx, {
      id: receiptId,
      customerId: customer.id,
      kind: settlement.kind,
      mode: settlement.kind === 'fine_cash' ? 'Cash' : null,
      amount: fromUnits(settlement.amount, MONEY),
      fineGrams: grams,
      silverRate: settlement.rate === null ? null : fromUnits(settlement.rate, MONEY),
      paidOn,
      reference: input.reference ?? null,
      notes: input.notes ?? null,
      cashOverrideReason: cashRules.reason,
      at,
      by,
    });

    const plan = planRebalance(
      {
        bills: owing.map((b) => ({ id: b.id, pending: b.pending, fine_pending: b.fine_pending })),
        receipts: [{ id: receiptId, kind: settlement.kind, remaining: fromUnits(0n, MONEY), fine_remaining: grams }],
        advance: fromUnits(0n, MONEY),
        fine_advance: grams,
        first: named?.id ?? null,
      },
      newId,
    );
    const own: AllocationRow[] = plan.allocations.map((a) => ({ ...a, customer_id: customer.id, released_at: null, created_at: at, updated_at: at }));
    await insertAllocations(tx, own);
    // D23: the bills that received silver and the customer carry the stamp of the call
    await touchForReceiptWrite(tx, { customerId: customer.id, billIds: own.map((a) => a.bill_id), at });

    // Y6: the rebalance on the state as the settlement left it. SF2 means every gram of this receipt was allocated; silver the customer already held beside a pending bill (which I10 forbids but an
    // import may have left) is applied here, oldest receipt first. The walk-in is never rebalanced (K5).
    const left = settlement.grams - own.reduce((n, a) => n + toUnits(a.fine_grams, FINE), 0n);
    const rebalanced = await rebalance(tx, {
      customerId: customer.id,
      walkin,
      state: afterOwnAllocation(state, own),
      at,
      newReceipts: [{ id: receiptId, kind: settlement.kind, paid_on: paidOn, created_at: at, remaining: fromUnits(0n, MONEY), fine_remaining: fromUnits(left, FINE) }],
    });

    const all = [...own, ...rebalanced.allocations];
    const settledNow = all.reduce((n, a) => n + toUnits(a.fine_grams, FINE), 0n);
    const value: SettleFineResult = {
      receipt: wireRow('receipts', role, receiptRow),
      allocations: all.map((a) => wireRow('receipt_allocations', role, { ...a })),
      fine_remaining: fromUnits(outstanding - settledNow, FINE),
    };
    await storeResult(tx, c.key, value);
    return { value, replayed: false };
  });
}

/** Registers `fn:settle_fine`. */
export function registerSettleFine(app: FastifyInstance): void {
  route(app, {
    action: ACTION,
    body: settleFineBody,
    handler: async ({ app: a, request, reply, auth, body }) => {
      const { id } = wire.parseInput(wire.strictObject({ id: wire.uuid }), request.params); // the customer: a lower-case UUID in the path
      const key = idempotencyKey(request.headers); // before the transaction: a missing or malformed key claims nothing
      const { value, replayed } = await settleFine(a, request, auth, key, id, body);
      markReplay(reply, replayed);
      return reply.code(201).send(value);
    },
  });
}
