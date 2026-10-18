import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { timestampToWire } from '../../src/wire/format';
import { AFTER_MIDNIGHT_IN_INDIA } from './edit-13b-support';
import { type Designs, addDesigns, billBody, item, piece, postBill, saved } from './x01-support';
import {
  type EditWorld,
  TODAY,
  WALKIN,
  addAllocation,
  addBill,
  addCustomer,
  addMoney,
  allocationsOf,
  billRow,
  body,
  codeOf,
  customerRow,
  editWorld,
  figures,
  i10Holds,
  newKey,
  paid,
  pay,
  pendingAgrees,
  pendingByBill,
  receiptsOf,
  refusal,
  rows,
  stamp,
} from './x02-support';
import { cancelBill, cancelled, dayRow, ledgerOf, receiptRow, trace, voidReceipt, voided } from './x04-support';
import { type Payload, refund, refunded, upi } from './x11-support';

// API28, X11 issue_refund (POST /v1/customers/:id/refunds, owner only; X11, Y10, Y6, Y8, D13, D23, K3, K5, L5, X0): money handed back to a customer out of the advance they hold. T-B20 is the
// test of the whole: a refund is not more than the advance; it shows as money out on its own date in V4 and as a debit in V3 and reduces the advance; voiding it restores the advance; after a cancel
// the advance can be refunded; money handed back is not spent twice by a later bill; a payment is not voided while its money was handed back. The rest is the clauses X11 owns of other tests: T-A09
// (the amount), T-D09 (the matrix row), L5 (the key), X0 (the order of work), D23 (the touch). The audit rows (T-D14, both mechanisms) are in x11-audit.test.ts and the two-session test in
// x11-two-sessions.test.ts.
//
// The world is the scratch database of the other money tests: the real routes, the seeds (the walk-in customer among them), a clock fixed at 17 Oct 2026 10:00 UTC (15:30 in Kolkata, "today" is
// 2026-10-17). The advance a refund is paid out of is made by the real X2 record_payment (or typed by SQL where a state the routes cannot make is the point); the books are checked with V1 to V4
// and I10 of the database half, which are another opinion than the code under test. Expected figures are written in the test, never read back from the code under test.

let w: EditWorld;
let d: Designs;

beforeAll(async () => {
  w = await editWorld('x11ref');
  d = await addDesigns(w);
}, 120_000);
afterAll(async () => {
  await w?.world.close();
}, 60_000);

/** The refusal is exactly this, and the call left no trace: no receipt, no allocation, no claim, no audit row, no stamp (the claim rolls back with the rest). */
async function refused(
  customer: string,
  payload: unknown,
  expected: { status: number; code: string; field?: string; details?: Record<string, unknown> },
  caller: 'owner' | 'biller' | 'staff' = 'owner',
  key = newKey(),
): Promise<Record<string, any>> {
  const before = await trace(w);
  const res = await refund(w, caller, customer, payload, key);
  expect(refusal(res), res.body).toMatchObject({ status: expected.status, code: expected.code, ...(expected.field === undefined ? {} : { field: expected.field }) });
  if (expected.details) expect(body(res).error.details, res.body).toMatchObject(expected.details);
  expect(await trace(w), 'a refused refund leaves no trace').toEqual(before);
  return body(res).error;
}

/** A customer who holds an advance of `amount`: it was paid in with the real record_payment, so there is a receipt and nothing to spend it on. */
async function withAdvance(amount: string, o: { mode?: string; paid_on?: string } = {}): Promise<{ customer: string; payment: string }> {
  const customer = await addCustomer(w);
  const r = await paid(await pay(w, 'owner', customer, { amount, mode: o.mode ?? 'UPI', ...(o.paid_on ? { paid_on: o.paid_on } : {}) }));
  expect(r.advance_remaining).toBe(amount);
  return { customer, payment: r.receipt.id as string };
}

/** A bill of the Per Piece design that sells for exactly `price` rupees, saved through the real X1. */
async function bill(c: string, price: string, extra: Payload = {}) {
  const p = await piece(w, d.gold24pp, { retail: price });
  const res = await postBill(w, 'owner', billBody(c, 'Retail', [item(p, { metal_rate: price })], extra), newKey());
  return saved(res);
}

// ------------------------------------------------------------------ T-B20

describe('T-B20 a refund is not more than the advance the customer holds (Y10, X11)', () => {
  it('2,000 held: 2,000.01 is refused (409 JV_NOT_ALLOWED naming the amount, with the advance and how much it is over); exactly 2,000.00 is saved and the advance is 0; then even 0.01 is refused', async () => {
    const { customer: c } = await withAdvance('2000.00');
    const error = await refused(c, upi('2000.01'), { status: 409, code: 'JV_NOT_ALLOWED', field: 'amount', details: { reason: 'more_than_advance', advance: '2000.00', short_by: '0.01' } });
    expect(error.message).not.toMatch(/2000/); // a message never repeats a figure
    expect(await figures(w, c)).toMatchObject({ advance: '2000.00' });
    const r = await refunded(await refund(w, 'owner', c, upi('2000.00')));
    expect(r.advance).toBe('0.00');
    expect(await figures(w, c)).toMatchObject({ advance: '0.00', outstanding: '0.00' });
    await refused(c, upi('0.01'), { status: 409, code: 'JV_NOT_ALLOWED', field: 'amount', details: { reason: 'more_than_advance', advance: '0.00', short_by: '0.01' } });
    await i10Holds(w, c);
  });

  it('a customer who holds no advance (nothing at all, or only dues) cannot be refunded anything', async () => {
    const empty = await addCustomer(w);
    await refused(empty, upi('1.00'), { status: 409, code: 'JV_NOT_ALLOWED', field: 'amount', details: { reason: 'more_than_advance', advance: '0.00' } });
    const owes = await addCustomer(w);
    await addBill(w, owes, '700.00', '2026-10-10');
    await refused(owes, upi('1.00'), { status: 409, code: 'JV_NOT_ALLOWED', field: 'amount', details: { advance: '0.00' } });
    expect(await figures(w, owes)).toMatchObject({ outstanding: '700.00', advance: '0.00' });
  });

  it('only money that is not spent counts: 2,000 received, 1,800 of it on a bill, so 200 is the advance and 200.01 is refused', async () => {
    const c = await addCustomer(w);
    const a = await addBill(w, c, '1800.00', '2026-10-01');
    const r1 = await addMoney(w, c, '2000.00', '2026-10-02');
    await addAllocation(w, r1, a, c, '1800.00');
    await refused(c, upi('200.01'), { status: 409, code: 'JV_NOT_ALLOWED', field: 'amount', details: { advance: '200.00', short_by: '0.01' } });
    const r = await refunded(await refund(w, 'owner', c, upi('200.00')));
    expect(r.advance).toBe('0.00');
    expect(await pendingByBill(w, c)).toEqual({ [a]: '0.00' });
  });

  it('money already handed back is gone from the advance: 1,000 held, 600 refunded, 400.01 is refused and 400.00 is saved; the second answer carries the advance after it', async () => {
    const { customer: c } = await withAdvance('1000.00');
    expect((await refunded(await refund(w, 'owner', c, upi('600.00')))).advance).toBe('400.00');
    await refused(c, upi('400.01'), { status: 409, code: 'JV_NOT_ALLOWED', field: 'amount', details: { advance: '400.00' } });
    expect((await refunded(await refund(w, 'owner', c, upi('400.00')))).advance).toBe('0.00');
    expect((await receiptsOf(w, c)).filter((r) => r.kind === 'refund')).toHaveLength(2);
  });

  it('the walk-in customer never holds an advance (K5), so no refund is made for it; the books are untouched', async () => {
    await refused(WALKIN, upi('1.00'), { status: 409, code: 'JV_NOT_ALLOWED', field: 'amount', details: { reason: 'more_than_advance', advance: '0.00' } });
  });
});

describe('T-B20 a refund shows as money out on its own date in V4 and as a debit in V3, and reduces the advance (Y10, V3, V4)', () => {
  it('2,000 paid in Cash on 3 Sep and 500 refunded by UPI dated 5 Sep: V4 has 500 out on 5 Sep in the UPI row and the 3 Sep Cash row is as it was; V3 has a Refund line of 500 as a debit dated 5 Sep; the advance is 1,500', async () => {
    const c = await addCustomer(w);
    await paid(await pay(w, 'owner', c, { amount: '2000.00', mode: 'Cash', paid_on: '2026-09-03' }));
    expect(await dayRow(w, '2026-09-03', 'Cash')).toEqual({ money_in: '2000.00', money_out: '0.00', net: '2000.00' });
    expect(await dayRow(w, '2026-09-05', 'UPI')).toEqual({ money_in: '0.00', money_out: '0.00', net: '0.00' });

    const res = await refund(w, 'owner', c, upi('500.00', { paid_on: '2026-09-05', reference: 'UPI-REF-9', notes: 'customer cancelled the order' }));
    const r = await refunded(res);
    expect(r.advance).toBe('1500.00');
    expect(r.receipt).toMatchObject({ customer_id: c, kind: 'refund', mode: 'UPI', amount: '500.00', fine_grams: '0.000', silver_rate: null, paid_on: '2026-09-05', reference: 'UPI-REF-9', notes: 'customer cancelled the order', is_opening: false, cash_override_reason: null, status: 'active', void_reason: null, voided_at: null, voided_on: null, voided_by: null });
    expect(r.receipt.created_by).toBe(w.world.fixtures.owner.userId);
    expect(r.receipt.created_at).toBe(r.receipt.updated_at);

    // V4: money out on its own date, in its own mode; nothing moves on the day of the payment or on today
    expect(await dayRow(w, '2026-09-05', 'UPI')).toEqual({ money_in: '0.00', money_out: '500.00', net: '-500.00' });
    expect(await dayRow(w, '2026-09-03', 'Cash')).toEqual({ money_in: '2000.00', money_out: '0.00', net: '2000.00' });
    // V3: a debit of 500 on that date, after the payment
    const ledger = await ledgerOf(w, c);
    expect(ledger.map((x) => [x.kind, x.entry_date, x.debit, x.credit])).toEqual([
      ['Payment', '2026-09-03', '0.00', '2000.00'],
      ['Refund', '2026-09-05', '500.00', '0.00'],
    ]);
    expect(ledger[1].description).toBe('Refund (UPI)');
    expect(ledger[1].balance).toBe('-1500.00'); // the customer is owed 1,500 (V2: balance = billed - received + refunded)
    // the books: 1,500 advance, in V2 and in the tables
    expect(await figures(w, c)).toMatchObject({ advance: '1500.00', outstanding: '0.00' });
    const stored = (await receiptsOf(w, c)).filter((x) => x.kind === 'refund');
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ id: r.receipt.id, amount: '500.00', mode: 'UPI', status: 'active', is_opening: 0 });
    expect(await allocationsOf(w, c), 'a refund has no allocations').toEqual([]);
    await i10Holds(w, c);
  });

  it('a refund dated today is money out today; a refund with no date, or a date of null, is dated today (Asia/Kolkata, from the API clock)', async () => {
    const { customer: c } = await withAdvance('300.00');
    const before = await dayRow(w, TODAY, 'Card');
    for (const extra of [{}, { paid_on: null }]) expect((await refunded(await refund(w, 'owner', c, { amount: '100.00', mode: 'Card', ...extra }))).receipt.paid_on).toBe(TODAY);
    const after = await dayRow(w, TODAY, 'Card');
    expect(BigInt(after.money_out.replace('.', '')) - BigInt(before.money_out.replace('.', ''))).toBe(20_000n);
    expect(after.money_in).toBe(before.money_in);
  });

  it('a refund does not reduce the customer\'s cash of the day (section 13, Z1): 1,50,000 paid in Cash and all of it refunded in Cash on one day, then 1,00,000 more in Cash from the same customer on that day is JV_CASH_LIMIT', async () => {
    const day = '2026-08-20';
    const { customer: a } = await withAdvance('150000.00', { mode: 'Cash', paid_on: day });
    const r = await refunded(await refund(w, 'owner', a, { amount: '150000.00', mode: 'Cash', paid_on: day })); // no cash limit stops money going out
    expect(r.advance).toBe('0.00');
    expect(await dayRow(w, day, 'Cash')).toEqual({ money_in: '150000.00', money_out: '150000.00', net: '0.00' });
    const res = await pay(w, 'owner', a, { amount: '100000.00', mode: 'Cash', paid_on: day });
    expect(refusal(res), res.body).toMatchObject({ status: 409, code: 'JV_CASH_LIMIT' });
    expect(body(res).error.details).toMatchObject({ cash_today: '150000.00', this_call: '100000.00', date: day });
    // the same payment on a day on which the customer paid no cash is fine: it is the day's total that stopped it, not the amount
    expect((await pay(w, 'owner', a, { amount: '100000.00', mode: 'Cash', paid_on: '2026-08-21' })).statusCode).toBe(201);
  });
});

describe('T-B20 voiding a refund restores the advance (Y10, X4)', () => {
  it('2,000 held, 500 refunded, the refund voided: the advance is 2,000 again, the receipt is voided with its reason and day, V4 gives the 500 back on the day of the void and not on the day of the refund, V3 has a Void line as a credit', async () => {
    const { customer: c } = await withAdvance('2000.00', { paid_on: '2026-09-06' });
    const r = await refunded(await refund(w, 'owner', c, upi('500.00', { paid_on: '2026-09-07' })));
    expect(await figures(w, c)).toMatchObject({ advance: '1500.00' });
    const closed = await dayRow(w, '2026-09-07', 'UPI');
    expect(closed).toEqual({ money_in: '0.00', money_out: '500.00', net: '-500.00' });
    const todayBefore = await dayRow(w, TODAY, 'UPI');

    const v = await voided(await voidReceipt(w, 'owner', r.receipt.id, { reason: 'refunded by mistake' }));
    expect(v.receipt).toMatchObject({ id: r.receipt.id, kind: 'refund', status: 'voided', void_reason: 'refunded by mistake', voided_on: TODAY });
    expect(v.allocations).toEqual([]);
    expect(await figures(w, c)).toMatchObject({ advance: '2000.00', outstanding: '0.00' });
    expect(await dayRow(w, '2026-09-07', 'UPI'), 'a closed day never changes because of a void (Y7)').toEqual(closed);
    const todayAfter = await dayRow(w, TODAY, 'UPI');
    expect(BigInt(todayAfter.money_in.replace('.', '')) - BigInt(todayBefore.money_in.replace('.', ''))).toBe(50_000n);
    const ledger = await ledgerOf(w, c);
    expect(ledger.map((x) => [x.kind, x.debit, x.credit])).toEqual([
      ['Payment', '0.00', '2000.00'],
      ['Refund', '500.00', '0.00'],
      ['Void', '0.00', '500.00'],
    ]);
    // and the whole 2,000 can be refunded again
    expect((await refunded(await refund(w, 'owner', c, upi('2000.00')))).advance).toBe('0.00');
  });
});

describe('T-B20 after a cancel the advance can be refunded (K3, X5, X11)', () => {
  it('a bill of 1,000 paid in full is cancelled: the receipt stays, so the customer holds 1,000; 1,000.01 cannot be refunded, 1,000.00 can, and the cancelled bill stays cancelled', async () => {
    const c = await addCustomer(w);
    const billed = await bill(c, '1000.00', { payments: [{ mode: 'UPI', amount: '1000.00' }] });
    expect(await figures(w, c)).toMatchObject({ outstanding: '0.00', advance: '0.00' });
    await refused(c, upi('1.00'), { status: 409, code: 'JV_NOT_ALLOWED', field: 'amount', details: { advance: '0.00' } }); // nothing to hand back while the money is on the bill
    await cancelled(await cancelBill(w, 'owner', billed.bill.id as string));
    expect(await figures(w, c)).toMatchObject({ outstanding: '0.00', advance: '1000.00' });
    await refused(c, upi('1000.01'), { status: 409, code: 'JV_NOT_ALLOWED', field: 'amount', details: { advance: '1000.00', short_by: '0.01' } });
    const r = await refunded(await refund(w, 'owner', c, upi('1000.00')));
    expect(r.advance).toBe('0.00');
    expect(await figures(w, c)).toMatchObject({ outstanding: '0.00', advance: '0.00' });
    expect((await billRow(w, billed.bill.id as string)).status).toBe('cancelled');
    await i10Holds(w, c);
  });
});

describe('T-B20 the money handed back is not spent twice: advance 2,000, refund 500, then a bill of 1,800 left unpaid gives pending 300 and advance 0 (Y6)', () => {
  it('the new bill takes only the 1,500 that is still held; the 500 is not spent a second time; voiding the refund then pays the 300', async () => {
    const { customer: c, payment } = await withAdvance('2000.00');
    const rf = await refunded(await refund(w, 'owner', c, upi('500.00')));
    expect(rf.advance).toBe('1500.00');

    const billed = await bill(c, '1800.00'); // left unpaid
    expect(billed.advance_applied).toBe('1500.00');
    expect(billed.allocations.map((x) => [x.receipt_id, x.amount])).toEqual([[payment, '1500.00']]);
    expect(await pendingByBill(w, c)).toEqual({ [billed.bill.id as string]: '300.00' });
    expect(await figures(w, c)).toMatchObject({ outstanding: '300.00', advance: '0.00' });
    // the money in the tables: 2,000 received, 1,500 allocated, 500 handed back, nothing left
    const [t] = await rows(
      w,
      `SELECT (SELECT COALESCE(SUM(amount), 0) FROM receipts WHERE customer_id = ? AND status = 'active' AND kind = 'money') AS received,
              (SELECT COALESCE(SUM(amount), 0) FROM receipts WHERE customer_id = ? AND status = 'active' AND kind = 'refund') AS refunded,
              (SELECT COALESCE(SUM(amount), 0) FROM receipt_allocations WHERE customer_id = ? AND released_at IS NULL) AS allocated`,
      [c, c, c],
    );
    expect([String(t.received), String(t.refunded), String(t.allocated)]).toEqual(['2000.00', '500.00', '1500.00']);
    await pendingAgrees(w, c);
    await i10Holds(w, c);

    // the refund is voided: its 500 is an advance again and pays what is pending, 300; the other 200 stays
    const v = await voided(await voidReceipt(w, 'owner', rf.receipt.id, { reason: 'the customer kept the goods' }));
    expect(v.allocations.map((x) => [x.receipt_id, x.amount])).toEqual([[payment, '300.00']]);
    expect(await pendingByBill(w, c)).toEqual({ [billed.bill.id as string]: '0.00' });
    expect(await figures(w, c)).toMatchObject({ outstanding: '0.00', advance: '200.00' });
    await i10Holds(w, c);
  });

  it('an old state with an advance held BESIDE a pending bill (an import can leave one; I10 forbids it): the rebalance of the refund applies at most the advance that is left after it, so the 100 that went out is not spent on the bill', async () => {
    // advance 500 held beside a bill of 450 pending: I10 forbids it, an import can leave it; the refund must still never let the rebalance spend the 100 that went out
    const c = await addCustomer(w);
    const a = await addBill(w, c, '450.00', '2026-10-01');
    const r1 = await addMoney(w, c, '500.00', '2026-10-02');
    expect(await figures(w, c)).toMatchObject({ outstanding: '450.00', advance: '500.00' });
    const r = await refunded(await refund(w, 'owner', c, upi('100.00')));
    // the advance after the refund is 400; the rebalance of the same call applies at most that, so 400 goes to the bill and 50 stays pending; nothing is left over
    expect((await allocationsOf(w, c)).map((x) => [x.receipt_id, x.bill_id, x.amount])).toEqual([[r1, a, '400.00']]);
    expect(await pendingByBill(w, c)).toEqual({ [a]: '50.00' });
    expect(await figures(w, c)).toMatchObject({ outstanding: '50.00', advance: '0.00' });
    expect(r.advance, 'the answer says the advance that is left after the rebalance').toBe('0.00');
    await i10Holds(w, c);
  });
});

describe('T-B20 a payment is not voided while its money was handed back: "void the refund first" (Y7, X4, X11)', () => {
  it('the 2,000 payment cannot be voided after 500 was refunded (JV_NOT_ALLOWED, short by 500); after the refund is voided it can, and the customer then holds nothing', async () => {
    const { customer: c, payment } = await withAdvance('2000.00');
    const rf = await refunded(await refund(w, 'owner', c, upi('500.00')));
    const before = await trace(w);
    const res = await voidReceipt(w, 'owner', payment, { reason: 'wrong customer' });
    expect(refusal(res), res.body).toMatchObject({ status: 409, code: 'JV_NOT_ALLOWED' });
    expect(body(res).error.message).toMatch(/void the refund first/i);
    expect(body(res).error.details).toMatchObject({ reason: 'void_the_refund_first', short_by: '500.00' });
    expect(await trace(w)).toEqual(before);
    expect((await receiptRow(w, payment)).status).toBe('active');

    await voided(await voidReceipt(w, 'owner', rf.receipt.id, { reason: 'refund entered by mistake' }));
    await voided(await voidReceipt(w, 'owner', payment, { reason: 'wrong customer' }));
    expect(await figures(w, c)).toMatchObject({ advance: '0.00', outstanding: '0.00' });
    await i10Holds(w, c);
  });
});

// ------------------------------------------------------------------ the clause of T-A09

describe('T-A09 (the clause of X11) a negative, zero, over-cap or badly written refund amount reaches no row', () => {
  it('-5.00, 0, 0.00, 1000000000.01, 1.234, .5, 5., +5, 1e3, a number, null, a list and nothing are 422 on amount; the receipt, the claim and the audit log are untouched', async () => {
    const { customer: c } = await withAdvance('100.00');
    for (const amount of ['-5.00', '0', '0.00', '1000000000.01', '1.234', '.5', '5.', '+5', '1e3', ' 7.50 ', '', 'abc', 5, 5.5, null, [5], { v: 5 }, true]) {
      await refused(c, { amount, mode: 'Cash' }, { status: 422, code: 'JV_INVALID_INPUT', field: 'amount' });
    }
    await refused(c, { mode: 'Cash' }, { status: 422, code: 'JV_INVALID_INPUT', field: 'amount' });
    expect((await receiptsOf(w, c)).filter((r) => r.kind === 'refund')).toEqual([]);
  });

  it('the largest amount of the cap, 1,000,000,000.00, is a refund of a customer who holds that much; 0.01 is the smallest; neither is a float on the way', async () => {
    const [big, small] = [await addCustomer(w), await addCustomer(w)];
    await addMoney(w, big, '1000000000.00', '2026-10-01');
    await addMoney(w, small, '0.01', '2026-10-01');
    expect((await refunded(await refund(w, 'owner', big, upi('1000000000.00')))).advance).toBe('0.00');
    expect((await refunded(await refund(w, 'owner', small, upi('0.01')))).advance).toBe('0.00');
  });

  it('the mode is one of the five (D13): Credit, credit, a blank mode, no mode and a number are 422 on mode; all five are saved as sent and the key of a refused call is not used up', async () => {
    const { customer: c } = await withAdvance('100.00');
    const key = newKey();
    for (const mode of ['Credit', 'credit', 'CREDIT', '', ' Cash', 'Cheque', 5, null, ['Cash']]) await refused(c, { amount: '1.00', mode }, { status: 422, code: 'JV_INVALID_INPUT', field: 'mode' }, 'owner', key);
    await refused(c, { amount: '1.00' }, { status: 422, code: 'JV_INVALID_INPUT', field: 'mode' }, 'owner', key);
    for (const mode of ['Cash', 'UPI', 'Card', 'Bank Transfer', 'Other']) {
      const r = await refunded(await refund(w, 'owner', c, { amount: '1.00', mode }, mode === 'Cash' ? key : newKey()));
      expect(r.receipt).toMatchObject({ kind: 'refund', mode, amount: '1.00' });
    }
    expect((await receiptsOf(w, c)).filter((r) => r.kind === 'refund').map((r) => r.mode).sort()).toEqual(['Bank Transfer', 'Card', 'Cash', 'Other', 'UPI']);
  });

  it('a field this call does not take (the customer, a bill, grams, a cash reason), a reference over 120 characters, notes over 10,000 and a date that is not a date are 422 on that field', async () => {
    const { customer: c } = await withAdvance('100.00');
    await refused(c, upi('1.00', { surprise: 1 }), { status: 422, code: 'JV_INVALID_INPUT', field: 'surprise' });
    await refused(c, upi('1.00', { customer_id: c }), { status: 422, code: 'JV_INVALID_INPUT', field: 'customer_id' }); // the customer is the one in the path, never in the body
    await refused(c, upi('1.00', { bill_id: randomUUID() }), { status: 422, code: 'JV_INVALID_INPUT', field: 'bill_id' }); // a refund has no allocations
    await refused(c, upi('1.00', { grams: '1.000' }), { status: 422, code: 'JV_INVALID_INPUT', field: 'grams' }); // silver cannot be handed back in M1 (O24)
    await refused(c, upi('1.00', { cash_override_reason: 'a reason of enough length' }), { status: 422, code: 'JV_INVALID_INPUT', field: 'cash_override_reason' }); // money out has no cash limit
    await refused(c, upi('1.00', { reference: 'x'.repeat(121) }), { status: 422, code: 'JV_INVALID_INPUT', field: 'reference' });
    await refused(c, upi('1.00', { notes: 'x'.repeat(10_001) }), { status: 422, code: 'JV_INVALID_INPUT', field: 'notes' });
    await refused(c, upi('1.00', { paid_on: '17/10/2026' }), { status: 422, code: 'JV_INVALID_INPUT', field: 'paid_on' });
    const ok = await refunded(await refund(w, 'owner', c, upi('1.00', { reference: ' R-1 ', notes: '', paid_on: null })));
    expect(ok.receipt).toMatchObject({ reference: 'R-1', notes: null, paid_on: TODAY });
  });
});

// ------------------------------------------------------------------ Y8

describe('Y8 the date of a refund: today by default; the owner any day up to today; never the future', () => {
  it('a past date is saved with that date; today written out is fine; tomorrow is 422 on paid_on and nothing is saved', async () => {
    const { customer: c } = await withAdvance('50.00');
    expect((await refunded(await refund(w, 'owner', c, upi('1.00', { paid_on: '2026-10-15' })))).receipt.paid_on).toBe('2026-10-15');
    expect((await refunded(await refund(w, 'owner', c, upi('1.00', { paid_on: TODAY })))).receipt.paid_on).toBe(TODAY);
    await refused(c, upi('1.00', { paid_on: '2026-10-18' }), { status: 422, code: 'JV_INVALID_INPUT', field: 'paid_on' });
    expect((await receiptsOf(w, c)).filter((r) => r.kind === 'refund').map((r) => r.paid_on).sort()).toEqual(['2026-10-15', TODAY]);
  });

  it('a refund dated BEFORE the payment it comes out of is allowed: the advance is a figure of the whole customer, not of one day (the owner may back-date, Y8)', async () => {
    const { customer: c } = await withAdvance('50.00', { paid_on: '2026-10-10' });
    const r = await refunded(await refund(w, 'owner', c, upi('20.00', { paid_on: '2026-10-01' })));
    expect(r.receipt.paid_on).toBe('2026-10-01');
    expect(r.advance).toBe('30.00');
  });
});

// ------------------------------------------------------------------ D23

describe('D23 touches: the customer carries the stamp of the call, and no bill of the customer is touched', () => {
  it('the customer\'s updated_at is the receipt\'s created_at; a bill the customer has is not touched (a refund allocates nothing)', async () => {
    const c = await addCustomer(w);
    const paidBill = await addBill(w, c, '100.00', '2026-10-01');
    const r1 = await addMoney(w, c, '600.00', '2026-10-02');
    await addAllocation(w, r1, paidBill, c, '100.00'); // 100 on the bill, 500 held
    const billBefore = (await billRow(w, paidBill)).updated_at;
    const customerBefore = (await customerRow(w, c)).updated_at;
    const r = await refunded(await refund(w, 'owner', c, upi('200.00')));
    const customerAfter = (await customerRow(w, c)).updated_at;
    expect(customerAfter).not.toBe(customerBefore);
    expect(timestampToWire(customerAfter)).toBe(r.receipt.created_at);
    expect((await billRow(w, paidBill)).updated_at, 'no bill is touched').toBe(billBefore);
  });
});

// ------------------------------------------------------------------ the customer

describe('X11 the customer: a path id that is not a customer is 404, a malformed one 422, an archived customer 409 JV_CUSTOMER_ARCHIVED', () => {
  it('an id that is no customer is 404 JV_NOT_FOUND and the claim is rolled back', async () => {
    const { customer: real } = await withAdvance('10.00');
    expect((await refund(w, 'owner', real, upi('1.00'))).statusCode, 'the address itself exists').toBe(201);
    const before = await trace(w);
    const res = await refund(w, 'owner', randomUUID(), upi('10.00'));
    expect(refusal(res)).toMatchObject({ status: 404, code: 'JV_NOT_FOUND' });
    expect(await trace(w)).toEqual(before);
  });

  it('a path id that is not a lower-case UUID is 422 on id', async () => {
    for (const id of ['not-a-uuid', '12345', randomUUID().toUpperCase()]) {
      const res = await refund(w, 'owner', id, upi('10.00'));
      expect(refusal(res), id).toMatchObject({ status: 422, code: 'JV_INVALID_INPUT', field: 'id' });
    }
  });

  it('an archived customer is not refunded: 409 JV_CUSTOMER_ARCHIVED, nothing is saved; brought back, the refund is saved', async () => {
    const { customer: c } = await withAdvance('100.00');
    await w.world.sql.query('UPDATE customers SET archived_at = ? WHERE id = ?', [stamp('2026-10-10'), c]);
    await refused(c, upi('10.00'), { status: 409, code: 'JV_CUSTOMER_ARCHIVED' });
    await w.world.sql.query('UPDATE customers SET archived_at = NULL WHERE id = ?', [c]);
    expect((await refund(w, 'owner', c, upi('10.00'))).statusCode).toBe(201);
  });
});

// ------------------------------------------------------------------ L5

describe('L5 repeat-safety of issue_refund (the clause of T-C05): the same Idempotency-Key makes one refund and answers the same', () => {
  it('the same key and body twice: one receipt, the same answer with Idempotent-Replay: true and the same status; the advance went down once', async () => {
    const { customer: c } = await withAdvance('1000.00');
    const key = newKey();
    const first = await refund(w, 'owner', c, upi('300.00', { reference: 'R-9' }), key);
    expect(first.statusCode).toBe(201);
    expect(first.headers['idempotent-replay']).toBeUndefined();
    const again = await refund(w, 'owner', c, upi('300.00', { reference: 'R-9' }), key);
    expect(again.statusCode).toBe(201);
    expect(again.headers['idempotent-replay']).toBe('true');
    expect(body(again)).toEqual(body(first));
    expect((await receiptsOf(w, c)).filter((r) => r.kind === 'refund')).toHaveLength(1);
    expect(await figures(w, c)).toMatchObject({ advance: '700.00' });
    expect(body(again).advance, 'the stored answer is the first one: the advance then').toBe('700.00');
  });

  it('a repeat whose refund is now more than the advance is still the first answer: the claim is looked at before the books', async () => {
    const { customer: c } = await withAdvance('500.00');
    const key = newKey();
    await refunded(await refund(w, 'owner', c, upi('500.00'), key));
    const again = await refund(w, 'owner', c, upi('500.00'), key);
    expect(again.statusCode, again.body).toBe(201);
    expect(again.headers['idempotent-replay']).toBe('true');
    expect((await receiptsOf(w, c)).filter((r) => r.kind === 'refund')).toHaveLength(1);
  });

  it('the same key with another amount, another customer, another mode or another path is refused (422 on the header), and saves nothing', async () => {
    const [{ customer: c }, { customer: other }] = [await withAdvance('1000.00'), await withAdvance('1000.00')];
    const key = newKey();
    await refunded(await refund(w, 'owner', c, upi('100.00'), key));
    const before = await trace(w);
    for (const [customer, payload] of [[c, upi('101.00')], [other, upi('100.00')], [c, { amount: '100.00', mode: 'Cash' }]] as const) {
      const res = await refund(w, 'owner', customer, payload, key);
      expect(refusal(res), JSON.stringify(payload)).toMatchObject({ status: 422, code: 'JV_INVALID_INPUT', field: 'Idempotency-Key' });
    }
    expect(await trace(w)).toEqual(before);
  });

  it('a missing or malformed Idempotency-Key is 422 on the header and claims nothing', async () => {
    const { customer: c } = await withAdvance('100.00');
    const before = await trace(w);
    for (const key of [null, 'abc', '12345']) {
      const res = await refund(w, 'owner', c, upi('10.00'), key);
      expect(refusal(res), String(key)).toMatchObject({ status: 422, code: 'JV_INVALID_INPUT', field: 'Idempotency-Key' });
    }
    expect(await trace(w)).toEqual(before);
  });
});

// ------------------------------------------------------------------ X0

describe('X0 the order of work inside the transaction, as the statements say it', () => {
  it('claim first, then the customer FOR UPDATE, then the state read ONCE, then the receipt, then the touch of the customer and the stored result; no lock is taken after a write, no number, no piece, no allocation', async () => {
    const { customer: c } = await withAdvance('400.00');
    const from = w.world.spy.sent.length;
    const res = await refund(w, 'owner', c, upi('150.00'));
    expect(res.statusCode, res.body).toBe(201);
    const sqls = w.world.spy.sqls().slice(from);
    const at = (re: RegExp, nth = 0): number => sqls.map((s, i) => [s, i] as const).filter(([s]) => re.test(s.trim()))[nth]?.[1] ?? -1;
    const claim = at(/^INSERT INTO sys_idempotency\b/);
    const customer = at(/^SELECT .* FROM customers WHERE id = \? FOR UPDATE$/s);
    const openBills = at(/ORDER BY t\.bill_date, t\.created_at, t\.id$/);
    const receipt = at(/^INSERT INTO receipts\b/);
    const touchCustomer = at(/^UPDATE customers SET updated_at = \?/);
    const store = at(/^UPDATE sys_idempotency SET result = \?/);
    expect(claim, 'the claim is the first statement of the transaction').toBe(Math.min(...sqls.map((s, i) => (/^INSERT INTO sys_idempotency\b/.test(s.trim()) ? i : 1e9))));
    expect(customer, 'the customer row is locked right after the claim and its read-back').toBe(claim + 2);
    expect(openBills).toBeGreaterThan(customer);
    expect(receipt).toBeGreaterThan(openBills);
    expect(touchCustomer).toBeGreaterThan(receipt);
    expect(store).toBeGreaterThan(touchCustomer);
    expect(sqls.filter((s) => /ORDER BY t\.bill_date, t\.created_at, t\.id$/.test(s.trim())), 'the state of the customer is read once').toHaveLength(1);
    expect(sqls.filter((s) => /^SELECT\b.*\bFOR UPDATE$/s.test(s.trim())).length, 'two row locks only: the claim row and the customer').toBe(2);
    expect(sqls.slice(receipt).filter((s) => /FOR UPDATE/.test(s)), 'no lock is taken after the first write').toEqual([]);
    expect(sqls.some((s) => /sys_counters/.test(s)), 'a refund takes no number').toBe(false);
    expect(sqls.some((s) => /\bFROM skus\b|\bFROM sku_private\b/.test(s)), 'a refund reads no piece').toBe(false);
    expect(sqls.filter((s) => /^INSERT INTO receipt_allocations/.test(s.trim())), 'a refund has no allocations, and the rebalance had nothing to apply').toEqual([]);
    expect(sqls.filter((s) => /^UPDATE bills\b/.test(s.trim())), 'no bill is touched').toEqual([]);
    expect(sqls.filter((s) => /^UPDATE customers SET updated_at/.test(s.trim()))).toHaveLength(1);
  });
});

// ------------------------------------------------------------------ T-D09

describe('T-D09 the matrix row of X11 (POST /v1/customers/:id/refunds: owner only) for the five callers', () => {
  it('the route is registered through route() with the action of the row', () => {
    expect(w.world.app.routeTable.find((r) => r.action === 'fn:issue_refund')).toMatchObject({ method: 'POST', url: '/v1/customers/:id/refunds', kind: 'matrix', roles: ['owner'], mustChange: false });
  });

  it('no session is 401, a biller and staff are 403 JV_FORBIDDEN, a user who must change the password is 403 JV_PASSWORD_CHANGE_REQUIRED, and none of them reads or writes the books', async () => {
    for (const [caller, status, code] of [['anon', 401, 'JV_UNAUTHENTICATED'], ['ended', 401, 'JV_UNAUTHENTICATED'], ['expired', 401, 'JV_SESSION_EXPIRED'], ['idle', 401, 'JV_SESSION_EXPIRED'], ['inactive', 401, 'JV_UNAUTHENTICATED'], ['biller', 403, 'JV_FORBIDDEN'], ['staff', 403, 'JV_FORBIDDEN'], ['must_change', 403, 'JV_PASSWORD_CHANGE_REQUIRED']] as const) {
      const { customer: c } = await withAdvance('100.00');
      const from = w.world.spy.sent.length;
      const res = await refund(w, caller, c, upi('10.00'));
      expect(res.statusCode, caller).toBe(status);
      expect(codeOf(res), caller).toBe(code);
      await w.world.restore(caller);
      expect(w.world.spy.sqls().slice(from).some((s) => /\bFROM\s+(customers|bills|receipts|receipt_allocations|sys_idempotency)\b/i.test(s) || /^INSERT\b/i.test(s.trim())), `${caller} caused a read or write of the books`).toBe(false);
      expect((await receiptsOf(w, c)).filter((r) => r.kind === 'refund')).toEqual([]);
      expect(await figures(w, c)).toMatchObject({ advance: '100.00' });
    }
  });

  it('the owner is let in, and the receipt names the one who made it', async () => {
    const { customer: c } = await withAdvance('100.00');
    const r = await refunded(await refund(w, 'owner', c, upi('10.00')));
    expect(r.receipt.created_by).toBe(w.world.fixtures.owner.userId);
    expect(r.receipt.updated_by).toBe(w.world.fixtures.owner.userId);
  });

  it('a biller\'s refused call leaves the key unused: the owner can make the refund with it', async () => {
    const { customer: c } = await withAdvance('100.00');
    const key = newKey();
    await refused(c, upi('10.00'), { status: 403, code: 'JV_FORBIDDEN' }, 'biller', key);
    expect((await refund(w, 'owner', c, upi('10.00'), key)).statusCode).toBe(201);
  });
});

// ------------------------------------------------------------------ the wire

describe('X11 the answer is what the wire says (S3): money as text, the receipt in the sync form of the caller\'s role', () => {
  it('{receipt, advance} and nothing else; no JSON number in a money field of the answer or of the stored result; the keys of the receipt are those of the sync read', async () => {
    const { customer: c } = await withAdvance('130.00');
    const key = newKey();
    const res = await refund(w, 'owner', c, upi('30.00'), key);
    const r = await refunded(res);
    expect(Object.keys(r).sort()).toEqual(['advance', 'receipt']);
    for (const v of [r.receipt.amount, r.receipt.fine_grams, r.advance]) expect(typeof v).toBe('string');
    expect(r.receipt.is_opening).toBe(false);
    expect(Object.keys(r.receipt).sort()).toEqual(['amount', 'cash_override_reason', 'created_at', 'created_by', 'customer_id', 'fine_grams', 'id', 'is_opening', 'kind', 'mode', 'notes', 'paid_on', 'reference', 'silver_rate', 'status', 'updated_at', 'updated_by', 'void_reason', 'voided_at', 'voided_by', 'voided_on']);
    expect(r.advance).toBe('100.00');
    const [claim] = await rows(w, 'SELECT result FROM sys_idempotency WHERE request_id = ?', [key]);
    const stored = typeof claim.result === 'string' ? JSON.parse(claim.result) : claim.result;
    expect(stored).toEqual(r);
  });
});

// last in the file: the API clock never runs backwards (S5), so this moves it forward and leaves it there
describe('L5 + Y8 a retry after midnight in India with the same key is the first answer, not a refusal of the date (the repeat is answered before any date is checked)', () => {
  it('the owner refunds at 15:30 on the 17th; at 00:30 on the 18th the same call with the same key is the stored answer with Idempotent-Replay: true, and a NEW key with the 18th is today and is saved', async () => {
    const { customer: c } = await withAdvance('100.00');
    const key = newKey();
    const first = await refund(w, 'owner', c, upi('10.00', { paid_on: TODAY }), key);
    expect(first.statusCode, first.body).toBe(201);
    w.time.time.micros = AFTER_MIDNIGHT_IN_INDIA;
    const again = await refund(w, 'owner', c, upi('10.00', { paid_on: TODAY }), key);
    expect(again.statusCode, again.body).toBe(201);
    expect(again.headers['idempotent-replay']).toBe('true');
    expect(body(again).receipt.paid_on).toBe(TODAY);
    const fresh = await refund(w, 'owner', c, upi('10.00', { paid_on: '2026-10-18' }));
    expect(fresh.statusCode, fresh.body).toBe(201);
    const tomorrow = await refund(w, 'owner', c, upi('10.00', { paid_on: '2026-10-19' }));
    expect(refusal(tomorrow)).toMatchObject({ status: 422, code: 'JV_INVALID_INPUT', field: 'paid_on' });
    expect((await receiptsOf(w, c)).filter((r) => r.kind === 'refund')).toHaveLength(2);
  });
});
