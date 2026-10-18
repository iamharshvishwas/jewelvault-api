import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { V, insert } from '../schema/support';
import type { CallerName } from './cells';
import { type Designs, addDesigns, billBody, item, piece, postBill, saved } from './x01-support';
import {
  type EditWorld,
  TODAY,
  WALKIN,
  addBill,
  addCustomer,
  addMoney,
  body,
  codeOf,
  editWorld,
  footprint,
  paid,
  pay,
  receiptsOf,
  refusal,
  rows,
} from './x02-support';

// API23, the cash rules of section 13 in X2 record_payment (T-B23: Z1, Z2, X2) and the per-day total across the functions that make cash receipts: a bill's payment rows (X1), record_payment (X2) and a
// fine settled in cash (X3, API24: its receipts are typed in here the way X3 will write them, kind fine_cash). The same rule is proved in the payment rows of a bill in x01-payments.test.ts.
//
// The world is the scratch database of the other money tests (the real routes, the seeds, a clock fixed at 17 Oct 2026 10:00 UTC = 15:30 in Kolkata, "today" is 2026-10-17). Every test makes its own
// customer, because the day's cash is per customer. Expected figures are written in the test.

let w: EditWorld;
let d: Designs;

beforeAll(async () => {
  w = await editWorld('x02cash');
  d = await addDesigns(w);
}, 120_000);
afterAll(async () => {
  await w?.world.close();
}, 60_000);

const REASON = 'abcdefghij'; // exactly 10 characters
const cash = (amount: string, extra: Record<string, unknown> = {}) => ({ amount, mode: 'Cash', ...extra });

/** The payment is refused with exactly this status and code and leaves no trace. */
async function refused(customer: string, payload: unknown, status: number, code: string, caller: CallerName = 'biller') {
  const before = await footprint(w);
  const res = await pay(w, caller, customer, payload);
  expect(refusal(res), res.body).toMatchObject({ status, code });
  expect(await footprint(w), 'the refused payment left something behind').toEqual(before);
  return body(res).error as { message: string; details: Record<string, any> };
}

/** A bill of ONE Per Piece line priced `total`, through X1. */
async function sell(customer: string, total: string, extra: Record<string, unknown> = {}, caller: CallerName = 'biller') {
  const p = await piece(w, d.gold24pp, { retail: total });
  return postBill(w, caller, billBody(customer, 'Retail', [item(p, { metal_rate: total })], extra));
}

describe('T-B23 the cash rules in record_payment: a biller is stopped at the limit and the owner with a reason is not (Z1, X2)', () => {
  it('a Cash payment of 1,99,999.99 passes and 2,00,000 raises JV_CASH_LIMIT for a biller; the refused call saves nothing and the key stays free', async () => {
    const c = await addCustomer(w);
    const error = await refused(c, cash('200000.00'), 409, 'JV_CASH_LIMIT');
    expect(error.details).toMatchObject({ limit: '200000.00', cash_today: '0.00' });
    const ok = await paid(await pay(w, 'biller', c, cash('199999.99')));
    expect(ok.receipt).toMatchObject({ mode: 'Cash', amount: '199999.99', cash_override_reason: null });
    expect(ok.advance_remaining).toBe('199999.99');
  });

  it('only Cash is stopped: UPI, Card, Bank Transfer and Other of 5,00,000 are saved', async () => {
    const c = await addCustomer(w);
    for (const mode of ['UPI', 'Card', 'Bank Transfer', 'Other']) {
      const r = await paid(await pay(w, 'biller', c, { amount: '500000.00', mode }));
      expect(r.receipt).toMatchObject({ mode, amount: '500000.00' });
    }
  });

  it('the owner with a reason of 10 characters saves Cash of 2,00,000: the reason is stored on the receipt (trimmed) and shows in the answer; the owner without a reason is stopped', async () => {
    const c = await addCustomer(w);
    const error = await refused(c, cash('200000.00'), 409, 'JV_CASH_LIMIT', 'owner');
    expect(error.message).toMatch(/reason/i);
    const r = await paid(await pay(w, 'owner', c, cash('200000.00', { cash_override_reason: `  ${REASON} ` })));
    expect(r.receipt.cash_override_reason).toBe(REASON);
    expect((await receiptsOf(w, c)).map((x) => [x.amount, x.cash_override_reason])).toEqual([['200000.00', REASON]]);
    // a reason under 10 characters is refused for everybody, a biller's reason is the owner's right (403) and a reason that is not needed is not stored
    await refused(c, cash('200000.00', { cash_override_reason: 'abcdefghi' }), 422, 'JV_INVALID_INPUT', 'owner');
    await refused(c, cash('200000.00', { cash_override_reason: REASON }), 403, 'JV_FORBIDDEN', 'biller');
    const small = await paid(await pay(w, 'owner', await addCustomer(w), cash('1000.00', { cash_override_reason: REASON })));
    expect(small.receipt.cash_override_reason).toBeNull();
  });

  it('the day\'s Cash is added: 1,00,000 + 99,999.99 passes, 0.01 more is stopped; with paid_on the day is the date of the payment (the owner\'s back-dating counts that day\'s cash)', async () => {
    const c = await addCustomer(w);
    await paid(await pay(w, 'biller', c, cash('100000.00')));
    await paid(await pay(w, 'biller', c, cash('99999.99')));
    await refused(c, cash('0.01'), 409, 'JV_CASH_LIMIT');
    await paid(await pay(w, 'biller', c, { amount: '5000.00', mode: 'UPI' })); // not Cash
    // the 16th holds 1,50,000 of cash: 50,000 more on the 16th is stopped, 49,999.99 passes, and the 17th is not affected
    const back = await addCustomer(w);
    await addMoney(w, back, '150000.00', '2026-10-16', { mode: 'Cash' });
    await refused(back, cash('50000.00', { paid_on: '2026-10-16' }), 409, 'JV_CASH_LIMIT', 'owner');
    await paid(await pay(w, 'owner', back, cash('49999.99', { paid_on: '2026-10-16' })));
    await paid(await pay(w, 'biller', back, cash('150000.00')));
  });
});

describe('T-B23 / T-B17 the walk-in: a single Cash payment at the limit is refused with "Select or create the customer", and its cash is never added up (Z2, K5)', () => {
  it('Cash of 1,99,999.99 on a named bill passes; 2,00,000 is JV_CASH_LIMIT for a biller, for the owner and for the owner with a reason; UPI of 2,00,000 passes', async () => {
    const big = await addBill(w, WALKIN, '250000.00', '2026-10-10');
    for (const [caller, extra] of [['biller', {}], ['owner', {}], ['owner', { cash_override_reason: REASON }]] as [CallerName, Record<string, unknown>][]) {
      const error = await refused(WALKIN, cash('200000.00', { bill_id: big, ...extra }), 409, 'JV_CASH_LIMIT', caller);
      expect(error.message).toBe('Select or create the customer');
    }
    await paid(await pay(w, 'biller', WALKIN, { amount: '200000.00', mode: 'UPI', bill_id: big }));
    const other = await addBill(w, WALKIN, '250000.00', '2026-10-11');
    const ok = await paid(await pay(w, 'biller', WALKIN, cash('199999.99', { bill_id: other })));
    expect(ok.receipt).toMatchObject({ customer_id: WALKIN, amount: '199999.99', cash_override_reason: null });
  });

  it('two Cash payments of 1,50,000 on one day for the walk-in are both saved (many strangers, not added); the walk-in\'s overpayment rule still comes first', async () => {
    const [a, b] = [await addBill(w, WALKIN, '150000.00', '2026-10-12'), await addBill(w, WALKIN, '150000.00', '2026-10-12')];
    await paid(await pay(w, 'biller', WALKIN, cash('150000.00', { bill_id: a })));
    await paid(await pay(w, 'biller', WALKIN, cash('150000.00', { bill_id: b })));
    const small = await addBill(w, WALKIN, '1000.00', '2026-10-13');
    const error = await refused(WALKIN, cash('300000.00', { bill_id: small }), 409, 'JV_OVERPAYMENT');
    expect(error.details).toMatchObject({ field: 'amount' });
  });
});

describe('T-B23 the per-day total counts bills, payments and cash fine together and leaves out voided, refunded and opening amounts, other days, other customers and other modes (Z1)', () => {
  it('75,000 counted (a payment by X2, the Cash row of a bill by X1, a fine settled in cash) under 1,25,000 of rows that must not count: the limit is reached at exactly 1,25,000 more', async () => {
    const c = await addCustomer(w);
    const stranger = await addCustomer(w);
    // counted: a Cash payment (X2), the Cash row of a bill (X1) and a fine settled in cash (X3: a fine_cash receipt in mode Cash with the silver rate and grams)
    await paid(await pay(w, 'biller', c, cash('20000.00')));
    const bill = await saved(await sell(c, '300000.00', { payments: [{ mode: 'Cash', amount: '30000.00' }, { mode: 'UPI', amount: '10000.00' }] }));
    expect(bill.receipts).toHaveLength(2);
    await insert(w.world.sql, 'receipts', V.receipt(c, { kind: 'fine_cash', mode: 'Cash', amount: '25000.00', fine_grams: '250.000', silver_rate: '100.00', paid_on: TODAY }));
    // not counted: a voided Cash receipt, a refund paid out in Cash, an opening advance (an opening row is mode Other: D13), UPI, Cash of yesterday, Cash of another customer
    await insert(
      w.world.sql,
      'receipts',
      V.receipt(c, { amount: '90000.00', paid_on: TODAY, status: 'voided', void_reason: 'wrong customer', voided_at: '2026-10-17 06:00:00.000000', voided_on: TODAY, voided_by: w.world.fixtures.owner.userId }),
    );
    await insert(w.world.sql, 'receipts', V.receipt(c, { kind: 'refund', mode: 'Cash', amount: '40000.00', paid_on: TODAY }));
    await insert(w.world.sql, 'receipts', V.receipt(c, { mode: 'Other', amount: '500000.00', paid_on: TODAY, is_opening: 1 }));
    await insert(w.world.sql, 'receipts', V.receipt(c, { mode: 'UPI', amount: '70000.00', paid_on: TODAY }));
    await insert(w.world.sql, 'receipts', V.receipt(c, { mode: 'Cash', amount: '90000.00', paid_on: '2026-10-16' }));
    await insert(w.world.sql, 'receipts', V.receipt(stranger, { mode: 'Cash', amount: '90000.00', paid_on: TODAY }));
    const counted = await rows(
      w,
      "SELECT CAST(SUM(amount) AS CHAR) AS n FROM receipts WHERE customer_id = ? AND paid_on = ? AND status = 'active' AND is_opening = 0 AND ((kind = 'money' AND mode = 'Cash') OR kind = 'fine_cash')",
      [c, TODAY],
    );
    expect(counted[0].n, 'the figures typed in above add up to 75,000 by hand').toBe('75000.00');

    // 75,000 + 1,25,000 = 2,00,000: stopped, in record_payment and in a bill's payment rows alike; 1,24,999.99 passes
    await refused(c, cash('125000.00'), 409, 'JV_CASH_LIMIT');
    const before = await footprint(w);
    const res = await sell(c, '300000.00', { payments: [{ mode: 'Cash', amount: '125000.00' }] });
    expect(res.statusCode, res.body).toBe(409);
    expect(codeOf(res)).toBe('JV_CASH_LIMIT');
    expect(body(res).error.details).toMatchObject({ cash_today: '75000.00', limit: '200000.00' });
    expect(await footprint(w)).toEqual(before);
    await paid(await pay(w, 'biller', c, cash('124999.99')));
    await refused(c, cash('0.01'), 409, 'JV_CASH_LIMIT');
    // the owner with a reason is let through, once for each call
    const owner = await paid(await pay(w, 'owner', c, cash('0.01', { cash_override_reason: 'cashier short of change' })));
    expect(owner.receipt.cash_override_reason).toBe('cashier short of change');
  });

  it('a fine settled in cash alone can reach the limit: 1,99,999.99 of fine_cash plus 0.01 of Cash is stopped', async () => {
    const c = await addCustomer(w);
    await insert(w.world.sql, 'receipts', V.receipt(c, { kind: 'fine_cash', mode: 'Cash', amount: '199999.99', fine_grams: '2000.000', silver_rate: '100.00', paid_on: TODAY }));
    await refused(c, cash('0.01'), 409, 'JV_CASH_LIMIT');
    await paid(await pay(w, 'biller', c, { amount: '0.01', mode: 'UPI' }));
  });
});
