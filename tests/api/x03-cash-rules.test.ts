import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { V, insert } from '../schema/support';
import type { CallerName } from './cells';
import { type Designs, addDesigns, billBody, item, piece, postBill, saved } from './x01-support';
import { addFineBill, cashFine, settle, settled, silver } from './x03-support';
import { type EditWorld, TODAY, WALKIN, addCustomer, body, editWorld, footprint, paid, pay, receiptsOf, refusal, rows } from './x02-support';

// API24, the cash rules of section 13 in X3 settle_fine for a fine settled in cash (T-B23: Z1, Z2, X3), and the two functions agreeing: the day's cash of a customer is one total over a payment (X2),
// the Cash row of a bill (X1) and a fine settled in cash (X3). The same rule is proved for record_payment in x02-cash-rules.test.ts and for the payment rows of a bill in x01-payments.test.ts.
//
// The world is the scratch database of the other money tests (the real routes, the seeds, a clock fixed at 17 Oct 2026 10:00 UTC = 15:30 in Kolkata, "today" is 2026-10-17). Every test makes its own
// customer, because the day's cash is per customer. The cash of a fine is grams x rate, so 2,000 g at 100.00 is 2,00,000.00, the limit. Expected figures are written in the test.

let w: EditWorld;
let d: Designs;

beforeAll(async () => {
  w = await editWorld('x03cash');
  d = await addDesigns(w);
}, 120_000);
afterAll(async () => {
  await w?.world.close();
}, 60_000);

const REASON = 'abcdefghij'; // exactly 10 characters
const cashPay = (amount: string, extra: Record<string, unknown> = {}) => ({ amount, mode: 'Cash', ...extra });

/** The settlement is refused with exactly this status and code and leaves no trace. */
async function refused(customer: string, payload: unknown, status: number, code: string, caller: CallerName = 'biller') {
  const before = await footprint(w);
  const res = await settle(w, caller, customer, payload);
  expect(refusal(res), res.body).toMatchObject({ status, code });
  expect(await footprint(w), 'the refused settlement left something behind').toEqual(before);
  return body(res).error as { message: string; details: Record<string, any> };
}

/** A customer who owes `fine` grams of silver on one bill. */
async function owing(fine = '5000.000'): Promise<{ customer: string; bill: string }> {
  const customer = await addCustomer(w);
  return { customer, bill: await addFineBill(w, customer, '1000.00', fine, '2026-10-01') };
}

/** A bill of ONE Per Piece line priced `total`, through X1. */
async function sell(customer: string, total: string, extra: Record<string, unknown> = {}, caller: CallerName = 'biller') {
  const p = await piece(w, d.gold24pp, { retail: total });
  return postBill(w, caller, billBody(customer, 'Retail', [item(p, { metal_rate: total })], extra));
}

describe('T-B23 the cash rules in settle_fine: a biller is stopped at the limit and the owner with a reason is not (Z1, X3)', () => {
  it('2,000 g at 100.00 is 2,00,000.00 and raises JV_CASH_LIMIT for a biller (cash_today, this_call and the limit are in the details); 1,999.999 g at 100.00 is 1,99,999.90 and passes', async () => {
    const { customer } = await owing();
    const error = await refused(customer, cashFine('2000.000', '100.00'), 409, 'JV_CASH_LIMIT');
    expect(error.details).toMatchObject({ limit: '200000.00', cash_today: '0.00', this_call: '200000.00', date: TODAY });
    const ok = await settled(await settle(w, 'biller', customer, cashFine('1999.999', '100.00')));
    expect(ok.receipt).toMatchObject({ kind: 'fine_cash', mode: 'Cash', amount: '199999.90', cash_override_reason: null });
  });

  it('only Cash is stopped: 5,000 g settled in SILVER (amount 0) is saved, and it adds nothing to the day\'s cash: a cash fine of 1,99,999.90 still passes after it', async () => {
    const { customer } = await owing('9000.000');
    const r = await settled(await settle(w, 'biller', customer, silver('4000.000')));
    expect(r.receipt).toMatchObject({ kind: 'fine_silver', amount: '0.00' });
    await settled(await settle(w, 'biller', customer, cashFine('1999.999', '100.00')));
  });

  it('the owner without a reason is stopped; the owner with a reason of 10 characters saves 2,00,000.00: the reason is stored on the receipt (trimmed) and shown in the answer', async () => {
    const { customer } = await owing();
    const error = await refused(customer, cashFine('2000.000', '100.00'), 409, 'JV_CASH_LIMIT', 'owner');
    expect(error.message).toMatch(/reason/i);
    const r = await settled(await settle(w, 'owner', customer, cashFine('2000.000', '100.00', { cash_override_reason: `  ${REASON} ` })));
    expect(r.receipt.cash_override_reason).toBe(REASON);
    expect((await receiptsOf(w, customer)).map((x) => [x.kind, x.amount, x.cash_override_reason])).toEqual([['fine_cash', '200000.00', REASON]]);
    // a reason under 10 characters is refused for everybody, a biller's reason is the owner's right (403), and a reason that is not needed is not stored
    await refused(customer, cashFine('2000.000', '100.00', { cash_override_reason: 'abcdefghi' }), 422, 'JV_INVALID_INPUT', 'owner');
    await refused(customer, cashFine('2000.000', '100.00', { cash_override_reason: REASON }), 403, 'JV_FORBIDDEN', 'biller');
    const small = await owing();
    const noNeed = await settled(await settle(w, 'owner', small.customer, cashFine('10.000', '100.00', { cash_override_reason: REASON })));
    expect(noNeed.receipt.cash_override_reason).toBeNull();
    const silverOnly = await settled(await settle(w, 'owner', small.customer, silver('10.000', { cash_override_reason: REASON })));
    expect(silverOnly.receipt.cash_override_reason).toBeNull();
  });

  it('the day\'s Cash is added: 1,00,000 + 99,999.90 passes, 0.10 more (0.001 g at 100.00) is stopped; the day is the date of the settlement (the owner\'s back-dating counts that day\'s cash)', async () => {
    const { customer } = await owing();
    await settled(await settle(w, 'biller', customer, cashFine('1000.000', '100.00')));
    await settled(await settle(w, 'biller', customer, cashFine('999.999', '100.00')));
    const error = await refused(customer, cashFine('0.001', '100.00'), 409, 'JV_CASH_LIMIT');
    expect(error.details).toMatchObject({ cash_today: '199999.90', this_call: '0.10' });
    // yesterday has no cash of this customer: the owner may back-date a fine in cash to it, and the limit is judged on that day
    await settled(await settle(w, 'owner', customer, cashFine('1999.999', '100.00', { paid_on: '2026-10-16' })));
    await refused(customer, cashFine('0.001', '100.00', { paid_on: '2026-10-16' }), 409, 'JV_CASH_LIMIT', 'owner');
    await settled(await settle(w, 'owner', customer, cashFine('0.001', '100.00', { paid_on: '2026-10-15' })));
  });

  it('the limit is a limit on the sum, not on one call: five cash fines of 40,000 are four saved and the fifth (which would make 2,00,000) is stopped', async () => {
    const { customer } = await owing();
    for (let i = 0; i < 4; i++) await settled(await settle(w, 'biller', customer, cashFine('400.000', '100.00')));
    await refused(customer, cashFine('400.000', '100.00'), 409, 'JV_CASH_LIMIT');
    await settled(await settle(w, 'biller', customer, cashFine('399.999', '100.00')));
  });
});

describe('T-B23 record_payment and settle_fine agree: one total over a payment, a bill\'s Cash row and a cash fine, in every order (Z1)', () => {
  it('a Cash payment of 1,50,000 (X2) and then a cash fine of 50,000.00 (X3) is stopped, while 49,999.90 passes and then 0.10 is stopped', async () => {
    const { customer } = await owing();
    await paid(await pay(w, 'biller', customer, cashPay('150000.00')));
    await refused(customer, cashFine('500.000', '100.00'), 409, 'JV_CASH_LIMIT');
    await settled(await settle(w, 'biller', customer, cashFine('499.999', '100.00')));
    await refused(customer, cashFine('0.001', '100.00'), 409, 'JV_CASH_LIMIT');
  });

  it('the other way round: a cash fine of 1,50,000.00 (X3) and then a Cash payment of 50,000 (X2) is stopped, and so is the Cash row of a bill (X1); UPI is not', async () => {
    const { customer } = await owing();
    await settled(await settle(w, 'biller', customer, cashFine('1500.000', '100.00')));
    const stopped = await pay(w, 'biller', customer, cashPay('50000.00'));
    expect(refusal(stopped), stopped.body).toMatchObject({ status: 409, code: 'JV_CASH_LIMIT' });
    expect(body(stopped).error.details).toMatchObject({ cash_today: '150000.00', this_call: '50000.00' });
    const before = await footprint(w);
    const bill = await sell(customer, '300000.00', { payments: [{ mode: 'Cash', amount: '50000.00' }] });
    expect(bill.statusCode, bill.body).toBe(409);
    expect(refusal(bill).code).toBe('JV_CASH_LIMIT');
    expect(await footprint(w)).toEqual(before);
    await paid(await pay(w, 'biller', customer, cashPay('49999.99')));
    await paid(await pay(w, 'biller', customer, { amount: '500000.00', mode: 'UPI' }));
    const ok = await saved(await sell(customer, '300000.00', { payments: [{ mode: 'UPI', amount: '100000.00' }] }));
    expect(ok.receipts).toHaveLength(1);
  });

  it('the owner with a reason is let through in both functions, once for each call, and each stores its own reason', async () => {
    const { customer } = await owing();
    await settled(await settle(w, 'biller', customer, cashFine('1900.000', '100.00')));
    const fine = await settled(await settle(w, 'owner', customer, cashFine('200.000', '100.00', { cash_override_reason: 'the buyer paid for three families' })));
    expect(fine.receipt.cash_override_reason).toBe('the buyer paid for three families');
    const payment = await paid(await pay(w, 'owner', customer, cashPay('10000.00', { cash_override_reason: 'the same buyer, same day' })));
    expect(payment.receipt.cash_override_reason).toBe('the same buyer, same day');
  });
});

describe('T-B23 the per-day total counts bills, payments and cash fine together and leaves out voided, refunded and opening amounts, other days, other customers and other modes (Z1)', () => {
  it('nothing here counts: a voided Cash receipt, a Cash refund, an opening advance, UPI, Cash of yesterday and Cash of another customer add nothing, so 1,99,999.90 of cash fine passes', async () => {
    const { customer } = await owing();
    const { customer: stranger } = await owing();
    await insert(
      w.world.sql,
      'receipts',
      V.receipt(customer, { amount: '90000.00', paid_on: TODAY, status: 'voided', void_reason: 'wrong customer', voided_at: '2026-10-17 06:00:00.000000', voided_on: TODAY, voided_by: w.world.fixtures.owner.userId }),
    );
    await insert(w.world.sql, 'receipts', V.receipt(customer, { kind: 'refund', mode: 'Cash', amount: '40000.00', paid_on: TODAY }));
    await insert(w.world.sql, 'receipts', V.receipt(customer, { mode: 'Other', amount: '500000.00', paid_on: TODAY, is_opening: 1 }));
    await insert(w.world.sql, 'receipts', V.receipt(customer, { mode: 'UPI', amount: '70000.00', paid_on: TODAY }));
    await insert(w.world.sql, 'receipts', V.receipt(customer, { mode: 'Cash', amount: '90000.00', paid_on: '2026-10-16' }));
    await insert(w.world.sql, 'receipts', V.receipt(stranger, { mode: 'Cash', amount: '90000.00', paid_on: TODAY }));
    const counted = await rows(
      w,
      "SELECT CAST(COALESCE(SUM(amount), 0) AS CHAR) AS n FROM receipts WHERE customer_id = ? AND paid_on = ? AND status = 'active' AND is_opening = 0 AND ((kind = 'money' AND mode = 'Cash') OR kind = 'fine_cash')",
      [customer, TODAY],
    );
    expect(counted[0].n, 'the figures typed in above add up to nothing by hand').toBe('0.00');
    const ok = await settled(await settle(w, 'biller', customer, cashFine('1999.999', '100.00')));
    expect(ok.receipt.amount).toBe('199999.90');
  });

  it('a refund is not taken off: 1,50,000 of Cash and a Cash refund of 40,000 the same day still make 1,50,000, so a cash fine of 50,000.00 is stopped', async () => {
    const { customer } = await owing();
    await insert(w.world.sql, 'receipts', V.receipt(customer, { mode: 'Cash', amount: '150000.00', paid_on: TODAY }));
    await insert(w.world.sql, 'receipts', V.receipt(customer, { kind: 'refund', mode: 'Cash', amount: '40000.00', paid_on: TODAY }));
    const error = await refused(customer, cashFine('500.000', '100.00'), 409, 'JV_CASH_LIMIT');
    expect(error.details).toMatchObject({ cash_today: '150000.00' });
  });

  it('a fine settled in cash is counted by the day total whatever made it: 75,000 of typed rows (a payment, a bill\'s Cash, a fine_cash) and 1,25,000 more is the limit', async () => {
    const { customer } = await owing();
    await paid(await pay(w, 'biller', customer, cashPay('20000.00')));
    await saved(await sell(customer, '300000.00', { payments: [{ mode: 'Cash', amount: '30000.00' }, { mode: 'UPI', amount: '10000.00' }] }));
    await insert(w.world.sql, 'receipts', V.receipt(customer, { kind: 'fine_cash', mode: 'Cash', amount: '25000.00', fine_grams: '250.000', silver_rate: '100.00', paid_on: TODAY }));
    await refused(customer, cashFine('1250.000', '100.00'), 409, 'JV_CASH_LIMIT');
    await settled(await settle(w, 'biller', customer, cashFine('1249.999', '100.00')));
  });
});

describe('T-B23 the walk-in: a single cash fine of the limit or more is refused with "Select or create the customer", for the owner too; nothing is added over the day (Z2, K5)', () => {
  it('a bill owing 3,000 g named: 2,000 g at 100.00 (2,00,000.00) is JV_CASH_LIMIT for a biller and for the owner with a reason; 1,999.999 g passes, and so do two of them the same day', async () => {
    const bill = await addFineBill(w, WALKIN, '1000.00', '3000.000', '2026-10-12');
    const bill2 = await addFineBill(w, WALKIN, '1000.00', '3000.000', '2026-10-13');
    const error = await refused(WALKIN, cashFine('2000.000', '100.00', { bill_id: bill }), 409, 'JV_CASH_LIMIT');
    expect(error.message).toBe('Select or create the customer');
    await refused(WALKIN, cashFine('2000.000', '100.00', { bill_id: bill, cash_override_reason: REASON }), 409, 'JV_CASH_LIMIT', 'owner');
    const one = await settled(await settle(w, 'biller', WALKIN, cashFine('1999.999', '100.00', { bill_id: bill })));
    expect(one.receipt).toMatchObject({ customer_id: WALKIN, amount: '199999.90', cash_override_reason: null });
    const two = await settled(await settle(w, 'biller', WALKIN, cashFine('1999.999', '100.00', { bill_id: bill2 })));
    expect(two.receipt.amount).toBe('199999.90');
  });

  it('the walk-in\'s bill rule comes first: more grams than the named bill has pending is JV_FINE_EXCEEDS even when the cash is over the limit as well', async () => {
    const small = await addFineBill(w, WALKIN, '1000.00', '100.000', '2026-10-14');
    const error = await refused(WALKIN, cashFine('2000.000', '100.00', { bill_id: small }), 409, 'JV_FINE_EXCEEDS');
    expect(error.details).toMatchObject({ max_grams: '100.000' });
  });
});
