import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NO_BODY, type Payload, allocationRows, billStates, dayRow, ledgerOf, receiptRow, trace, voidReceipt, voided } from './x04-support';
import { addFineAllocation, addFineBill, addSilver, cashFine, settle, settled, silver } from './x03-support';
import {
  type EditWorld,
  TODAY,
  WALKIN,
  addAllocation,
  addBill,
  addCancelledBill,
  addCustomer,
  addMoney,
  allocationsOf,
  billRow,
  body,
  codeOf,
  customerRow,
  editWorld,
  errorField,
  figures,
  i10Holds,
  newKey,
  pay,
  paid,
  pendingAgrees,
  pendingByBill,
  receiptsOf,
  refusal,
  rows,
  stamp,
} from './x02-support';

// API25, X4 void_receipt (POST /v1/receipts/:id/void, owner; X4, Y7, Y10, D13, D23, L5, X0): a receipt is voided, never deleted. T-B08 (a payment: bill pending and customer outstanding come back exactly,
// the ledger shows a Void row on the day of the void), T-B09 (a silver and a cash fine settlement: the fine pending comes back exactly), the clause of T-B20 (a refund that is voided gives the advance
// back; a payment is not voided while the money was handed back), the clause of T-D09 (the matrix row), and the rest of X4: the answer, the order of work, the touches, the repeat of a key. The audit
// rows (T-D14) are in x04-audit.test.ts, the dates across midnight and the year (T-B16) in x04-dates.test.ts, the two-session tests (T-C12) in x04-two-sessions.test.ts.
//
// The world is the scratch database of the other money tests: the real routes, the seeds (the walk-in customer among them), a clock fixed at 17 Oct 2026 10:00 UTC (15:30 in Kolkata, "today" is
// 2026-10-17). Every test makes its own customer. A customer's history is typed in by SQL, with stamps earlier than the API clock's, or made through the real payment routes. Expected figures are
// written in the test, never read back from the code under test; the books are checked with V1 to V4 and I10 of the database half, which are another opinion.

let w: EditWorld;

beforeAll(async () => {
  w = await editWorld('x04void');
}, 120_000);
afterAll(async () => {
  await w?.world.close();
}, 60_000);

const owner = () => w.world.fixtures.owner.userId;

/** The refusal is exactly this, and the call left no trace: no receipt changed, no allocation, no claim, no audit row, no stamp (the claim rolls back with the rest). */
async function refused(
  receipt: string,
  payload: unknown,
  expected: { status: number; code: string; field?: string; details?: Record<string, unknown> },
  caller: 'owner' | 'biller' | 'staff' = 'owner',
  key = newKey(),
): Promise<Record<string, any>> {
  const before = await trace(w);
  const res = await voidReceipt(w, caller, receipt, payload, key);
  expect(refusal(res), res.body).toMatchObject({ status: expected.status, code: expected.code, ...(expected.field === undefined ? {} : { field: expected.field }) });
  if (expected.details) expect(body(res).error.details, res.body).toMatchObject(expected.details);
  expect(await trace(w), 'a refused void leaves no trace').toEqual(before);
  return body(res).error;
}

const upi = (amount: string, extra: Payload = {}): Payload => ({ amount, mode: 'UPI', ...extra });

// ------------------------------------------------------------------ T-B08

describe('T-B08 voiding a payment restores the bill pending and the customer outstanding exactly; the ledger shows a Void row on the day of the void (Y7, X4, V3, V4)', () => {
  it('a payment of 400 made on the 10th and voided on the 17th: the pending of every bill and the outstanding are what they were before the payment; the Void is a reversing line in the ledger and in the cash book of the 17th, the 10th is not touched', async () => {
    const c = await addCustomer(w);
    const a = await addBill(w, c, '1000.00', '2026-10-01');
    const b = await addBill(w, c, '500.00', '2026-10-05');
    const pendingBefore = await pendingByBill(w, c);
    const figuresBefore = await figures(w, c);
    expect(pendingBefore).toEqual({ [a]: '1000.00', [b]: '500.00' });
    expect(figuresBefore).toMatchObject({ outstanding: '1500.00', advance: '0.00' });
    const r = await paid(await pay(w, 'owner', c, upi('400.00', { paid_on: '2026-10-10' })));
    expect(await pendingByBill(w, c)).toEqual({ [a]: '600.00', [b]: '500.00' });
    const tenth = await dayRow(w, '2026-10-10', 'UPI');
    const today = await dayRow(w, TODAY, 'UPI');

    const res = await voidReceipt(w, 'owner', r.receipt.id, { reason: 'wrong customer' });
    const v = await voided(res);

    // the answer: the receipt as it is now, nothing for the rebalance to do, the bill that came back
    expect(v.receipt).toMatchObject({ id: r.receipt.id, customer_id: c, kind: 'money', amount: '400.00', status: 'voided', void_reason: 'wrong customer', voided_on: TODAY, voided_by: owner(), paid_on: '2026-10-10', updated_by: owner() });
    expect(v.receipt.voided_at).toBe(v.receipt.updated_at);
    expect(v.allocations).toEqual([]);
    expect(v.bills.map((x) => [x.id, x.status, x.pending, x.received, x.payment_status])).toEqual([[a, 'active', '1000.00', '0.00', 'Pending']]);

    // the books say what they said before the payment
    expect(await pendingByBill(w, c)).toEqual(pendingBefore);
    expect(await figures(w, c)).toEqual(figuresBefore);
    await pendingAgrees(w, c);
    await i10Holds(w, c);

    // the row in the table: voided with the day and the person from the one reading of the clock, the receipt is not deleted and its allocation stays (it just stops counting)
    const stored = await receiptRow(w, r.receipt.id);
    expect({ status: stored.status, void_reason: stored.void_reason, voided_on: stored.voided_on, voided_by: stored.voided_by, amount: stored.amount }).toEqual({ status: 'voided', void_reason: 'wrong customer', voided_on: TODAY, voided_by: owner(), amount: '400.00' });
    expect(String(stored.voided_at).slice(0, 10)).toBe(TODAY);
    expect(stored.voided_at).toBe(stored.updated_at);
    const allocs = await allocationRows(w, 'receipt_id = ?', [r.receipt.id]);
    expect(allocs.map((x) => [x.bill_id, x.amount, x.released_at])).toEqual([[a, '400.00', null]]);

    // the ledger: the payment on the 10th and its exact reverse on the 17th; the running balance ends at the outstanding
    const ledger = await ledgerOf(w, c);
    expect(ledger.map((x) => [x.kind, x.entry_date, x.debit, x.credit])).toEqual([
      ['Invoice', '2026-10-01', '1000.00', '0.00'],
      ['Invoice', '2026-10-05', '500.00', '0.00'],
      ['Payment', '2026-10-10', '0.00', '400.00'],
      ['Void', TODAY, '400.00', '0.00'],
    ]);
    expect(ledger[ledger.length - 1].balance).toBe('1500.00');

    // the cash book: the 10th is closed and keeps the money in; the reverse is on the 17th
    expect(await dayRow(w, '2026-10-10', 'UPI')).toEqual(tenth);
    const after = await dayRow(w, TODAY, 'UPI');
    expect(BigInt(after.money_out.replace('.', '')) - BigInt(today.money_out.replace('.', ''))).toBe(40_000n);
    expect(BigInt(after.net.replace('.', '')) - BigInt(today.net.replace('.', ''))).toBe(-40_000n);
  });

  it('a payment that paid two bills: both come back with what they had', async () => {
    const c = await addCustomer(w);
    const a = await addBill(w, c, '1000.00', '2026-10-01');
    const b = await addBill(w, c, '1000.00', '2026-10-02');
    const r = await paid(await pay(w, 'owner', c, upi('1500.00')));
    expect(r.allocations.map((x) => [x.bill_id, x.amount])).toEqual([[a, '1000.00'], [b, '500.00']]);
    const v = await voided(await voidReceipt(w, 'owner', r.receipt.id));
    expect(await pendingByBill(w, c)).toEqual({ [a]: '1000.00', [b]: '1000.00' });
    expect(await figures(w, c)).toMatchObject({ outstanding: '2000.00', advance: '0.00' });
    expect(v.bills.map((x) => [x.id, x.pending]).sort()).toEqual([[a, '1000.00'], [b, '1000.00']].sort());
    expect(v.allocations).toEqual([]);
    await i10Holds(w, c);
  });

  it('a bill with two payments: voiding one leaves the other counted', async () => {
    const c = await addCustomer(w);
    const a = await addBill(w, c, '1000.00', '2026-10-01');
    const first = await paid(await pay(w, 'owner', c, upi('300.00')));
    const second = await paid(await pay(w, 'owner', c, upi('200.00')));
    expect(await pendingByBill(w, c)).toEqual({ [a]: '500.00' });
    await voided(await voidReceipt(w, 'owner', first.receipt.id));
    expect(await pendingByBill(w, c)).toEqual({ [a]: '800.00' });
    expect((await receiptsOf(w, c)).map((x) => [x.id, x.status])).toEqual([[first.receipt.id, 'voided'], [second.receipt.id, 'active']]);
    expect((await billStates(w, c))[a]).toMatchObject({ received: '200.00', pending: '800.00', payment_status: 'Partial' });
  });

  it('a payment of 1,500 on a bill of 1,000 (500 kept as an advance): voiding it removes the advance too, and the bill is unpaid again', async () => {
    const c = await addCustomer(w);
    const a = await addBill(w, c, '1000.00', '2026-10-01');
    const r = await paid(await pay(w, 'owner', c, upi('1500.00')));
    expect(r.advance_remaining).toBe('500.00');
    expect(await figures(w, c)).toMatchObject({ outstanding: '0.00', advance: '500.00' });
    const v = await voided(await voidReceipt(w, 'owner', r.receipt.id));
    expect(await figures(w, c)).toMatchObject({ outstanding: '1000.00', advance: '0.00' });
    expect(await pendingByBill(w, c)).toEqual({ [a]: '1000.00' });
    expect(v.allocations).toEqual([]);
    await i10Holds(w, c);
  });

  it('money waiting as an advance pays the bill the void re-opened (Y6): a bill of 1,000 paid by R1, 300 spare in R2; voiding R1 leaves the bill 700 pending and R2 spent', async () => {
    const c = await addCustomer(w);
    const a = await addBill(w, c, '1000.00', '2026-10-01');
    const r1 = await addMoney(w, c, '1000.00', '2026-10-02');
    await addAllocation(w, r1, a, c, '1000.00');
    const r2 = await addMoney(w, c, '300.00', '2026-10-03');
    expect(await figures(w, c)).toMatchObject({ outstanding: '0.00', advance: '300.00' });
    const v = await voided(await voidReceipt(w, 'owner', r1));
    expect(v.allocations.map((x) => [x.receipt_id, x.bill_id, x.amount, x.fine_grams, x.released_at])).toEqual([[r2, a, '300.00', '0.000', null]]);
    expect(v.bills.map((x) => [x.id, x.pending, x.received, x.payment_status])).toEqual([[a, '700.00', '300.00', 'Partial']]);
    expect(await pendingByBill(w, c)).toEqual({ [a]: '700.00' });
    expect(await figures(w, c)).toMatchObject({ outstanding: '700.00', advance: '0.00' });
    const ledger = await ledgerOf(w, c);
    expect(ledger[ledger.length - 1]).toMatchObject({ kind: 'Void', debit: '1000.00', balance: '700.00' });
    await pendingAgrees(w, c);
    await i10Holds(w, c);
  });

  it('the voided receipt is never spent again: R2 of 1,500 paid a bill of 1,000 and kept 500, R3 holds 300 beside it; voiding R2 leaves the bill to R3 (300), not to the voided R2', async () => {
    const c = await addCustomer(w);
    const a = await addBill(w, c, '1000.00', '2026-10-01');
    const r2 = await addMoney(w, c, '1500.00', '2026-10-02');
    await addAllocation(w, r2, a, c, '1000.00');
    const r3 = await addMoney(w, c, '300.00', '2026-10-03');
    expect(await figures(w, c)).toMatchObject({ outstanding: '0.00', advance: '800.00' });
    const v = await voided(await voidReceipt(w, 'owner', r2));
    expect(v.allocations.map((x) => [x.receipt_id, x.bill_id, x.amount])).toEqual([[r3, a, '300.00']]);
    expect(await pendingByBill(w, c)).toEqual({ [a]: '700.00' });
    expect(await figures(w, c)).toMatchObject({ outstanding: '700.00', advance: '0.00' });
    expect((await allocationsOf(w, c)).filter((x) => x.receipt_id === r2).length, 'the voided receipt got no new allocation').toBe(1);
    await i10Holds(w, c);
  });

  it('two bills re-opened and two spare receipts: the older receipt pays the older bill first (oldest receipt first, oldest bill first)', async () => {
    const c = await addCustomer(w);
    const a = await addBill(w, c, '500.00', '2026-10-01');
    const b = await addBill(w, c, '500.00', '2026-10-02');
    const r1 = await addMoney(w, c, '1000.00', '2026-10-03');
    await addAllocation(w, r1, a, c, '500.00');
    await addAllocation(w, r1, b, c, '500.00');
    const old = await addMoney(w, c, '300.00', '2026-10-04');
    const newer = await addMoney(w, c, '300.00', '2026-10-05');
    const v = await voided(await voidReceipt(w, 'owner', r1));
    expect(v.allocations.map((x) => [x.receipt_id, x.bill_id, x.amount])).toEqual([
      [old, a, '300.00'],
      [newer, a, '200.00'],
      [newer, b, '100.00'],
    ]);
    expect(await pendingByBill(w, c)).toEqual({ [a]: '0.00', [b]: '400.00' });
    await i10Holds(w, c);
  });

  it('an opening advance (money brought forward, D15) is voided like any money received; V4 never counted it, so it adds nothing to the cash book', async () => {
    const c = await addCustomer(w);
    const r = await addMoney(w, c, '500.00', '2026-04-01', { is_opening: 1, mode: 'Other' });
    expect(await figures(w, c)).toMatchObject({ advance: '500.00' });
    const before = await dayRow(w, TODAY, 'Other');
    await voided(await voidReceipt(w, 'owner', r));
    expect(await figures(w, c)).toMatchObject({ advance: '0.00', outstanding: '0.00' });
    expect(await dayRow(w, TODAY, 'Other')).toEqual(before);
    const ledger = await ledgerOf(w, c);
    expect(ledger.map((x) => [x.kind, x.entry_date])).toEqual([['Opening advance', '2026-04-01'], ['Void', TODAY]]);
  });

  it('the owner may void a receipt of an earlier day, also one the owner back-dated (Y7, Y8): the void is on the day it is done, the earlier day is not changed', async () => {
    const c = await addCustomer(w);
    await addBill(w, c, '1000.00', '2026-09-20');
    const r = await paid(await pay(w, 'owner', c, upi('250.00', { paid_on: '2026-09-25' })));
    const closed = await dayRow(w, '2026-09-25', 'UPI');
    const v = await voided(await voidReceipt(w, 'owner', r.receipt.id));
    expect(v.receipt).toMatchObject({ paid_on: '2026-09-25', voided_on: TODAY });
    expect(await dayRow(w, '2026-09-25', 'UPI')).toEqual(closed);
  });
});

// ------------------------------------------------------------------ T-B09

describe('T-B09 voiding a fine settlement, in silver and in cash, restores the fine pending exactly (Y7, X4, SF1, V3, V4)', () => {
  it('silver: 4 g settled on a bill owing 10 g, voided: 10.000 g pending again, the rupees were never touched, the ledger shows the Void in grams on the day of the void', async () => {
    const c = await addCustomer(w);
    const a = await addFineBill(w, c, '500.00', '10.000', '2026-10-01');
    const figuresBefore = await figures(w, c);
    const s = await settled(await settle(w, 'owner', c, silver('4.000', { paid_on: '2026-10-12' })));
    expect((await billStates(w, c))[a]).toMatchObject({ fine_pending: '6.000', fine_settled: '4.000', pending: '500.00' });
    const v = await voided(await voidReceipt(w, 'owner', s.receipt.id, { reason: 'silver weighed wrongly' }));
    expect(v.receipt).toMatchObject({ kind: 'fine_silver', status: 'voided', voided_on: TODAY, void_reason: 'silver weighed wrongly' });
    expect(v.allocations).toEqual([]);
    expect(v.bills.map((x) => [x.id, x.fine_pending, x.fine_settled, x.pending])).toEqual([[a, '10.000', '0.000', '500.00']]);
    expect((await billStates(w, c))[a]).toMatchObject({ fine_pending: '10.000', fine_settled: '0.000', pending: '500.00', received: '0.00' });
    expect(await figures(w, c)).toEqual(figuresBefore);
    const ledger = await ledgerOf(w, c);
    expect(ledger.map((x) => [x.kind, x.entry_date, x.fine_debit, x.fine_credit, x.debit, x.credit])).toEqual([
      ['Invoice', '2026-10-01', '10.000', '0.000', '500.00', '0.00'],
      ['Fine', '2026-10-12', '0.000', '4.000', '0.00', '0.00'],
      ['Void', TODAY, '4.000', '0.000', '0.00', '0.00'],
    ]);
    expect(ledger[2].fine_balance).toBe('10.000');
    await i10Holds(w, c);
  });

  it('cash: 3 g settled in cash at 90.00 (270.00 into the Cash book of the 12th), voided: the grams come back, the rupees of the bill never moved, the Cash book of the 12th keeps the money in and the 17th has the reverse', async () => {
    const c = await addCustomer(w);
    const a = await addFineBill(w, c, '500.00', '10.000', '2026-10-01');
    const s = await settled(await settle(w, 'owner', c, cashFine('3.000', '90.00', { paid_on: '2026-10-12' })));
    expect(s.receipt).toMatchObject({ kind: 'fine_cash', amount: '270.00' });
    const closed = await dayRow(w, '2026-10-12', 'Cash');
    const today = await dayRow(w, TODAY, 'Cash');
    expect((await billStates(w, c))[a]).toMatchObject({ fine_pending: '7.000', pending: '500.00' });
    const v = await voided(await voidReceipt(w, 'owner', s.receipt.id));
    expect(v.receipt).toMatchObject({ kind: 'fine_cash', status: 'voided', amount: '270.00' });
    expect(v.bills.map((x) => [x.id, x.fine_pending, x.pending])).toEqual([[a, '10.000', '500.00']]);
    expect((await billStates(w, c))[a]).toMatchObject({ fine_pending: '10.000', fine_settled: '0.000', pending: '500.00' });
    expect(await figures(w, c)).toMatchObject({ outstanding: '500.00', fine_outstanding: '10.000', advance: '0.00', fine_advance: '0.000' });
    expect(await dayRow(w, '2026-10-12', 'Cash')).toEqual(closed);
    const after = await dayRow(w, TODAY, 'Cash');
    expect(BigInt(after.money_out.replace('.', '')) - BigInt(today.money_out.replace('.', ''))).toBe(27_000n);
    const ledger = await ledgerOf(w, c);
    expect(ledger.map((x) => x.kind)).toEqual(['Invoice', 'Fine', 'Void']);
    expect(ledger[2]).toMatchObject({ entry_date: TODAY, fine_debit: '3.000', debit: '0.00', credit: '0.00', fine_balance: '10.000', balance: '500.00' });
    await i10Holds(w, c);
  });

  it('silver that paid two bills (12 g on bills owing 10 and 6): both come back, and nothing is left over', async () => {
    const c = await addCustomer(w);
    const a = await addFineBill(w, c, '500.00', '10.000', '2026-10-01');
    const b = await addFineBill(w, c, '300.00', '6.000', '2026-10-05');
    const s = await settled(await settle(w, 'owner', c, silver('12.000')));
    expect(s.allocations.map((x) => [x.bill_id, x.fine_grams])).toEqual([[a, '10.000'], [b, '2.000']]);
    const v = await voided(await voidReceipt(w, 'owner', s.receipt.id));
    expect(v.bills.map((x) => [x.id, x.fine_pending]).sort()).toEqual([[a, '10.000'], [b, '6.000']].sort());
    expect(await figures(w, c)).toMatchObject({ fine_outstanding: '16.000', fine_advance: '0.000' });
    await i10Holds(w, c);
  });

  it('silver waiting beside a bill that the void re-opened pays it (Y6, in grams): 5 g paid the bill, 3 g were spare; voiding the 5 g leaves the bill owing 2 g', async () => {
    const c = await addCustomer(w);
    const a = await addFineBill(w, c, '100.00', '5.000', '2026-10-01');
    const s1 = await addSilver(w, c, '5.000', '2026-10-02');
    await addFineAllocation(w, s1, a, c, '5.000');
    const s2 = await addSilver(w, c, '3.000', '2026-10-03');
    const v = await voided(await voidReceipt(w, 'owner', s1));
    expect(v.allocations.map((x) => [x.receipt_id, x.bill_id, x.fine_grams, x.amount])).toEqual([[s2, a, '3.000', '0.00']]);
    expect(v.bills.map((x) => [x.id, x.fine_pending, x.pending])).toEqual([[a, '2.000', '100.00']]);
    expect(await figures(w, c)).toMatchObject({ fine_outstanding: '2.000', fine_advance: '0.000' });
    await i10Holds(w, c);
  });

  it('a settlement with silver left over in its own receipt (an import can leave one): voiding it takes the spare silver away with it', async () => {
    const c = await addCustomer(w);
    const a = await addFineBill(w, c, '100.00', '5.000', '2026-10-01');
    const s1 = await addSilver(w, c, '8.000', '2026-10-02');
    await addFineAllocation(w, s1, a, c, '5.000');
    expect(await figures(w, c)).toMatchObject({ fine_outstanding: '0.000', fine_advance: '3.000' });
    await voided(await voidReceipt(w, 'owner', s1));
    expect(await figures(w, c)).toMatchObject({ fine_outstanding: '5.000', fine_advance: '0.000' });
  });
});

// ------------------------------------------------------------------ the clause of T-B20

describe('T-B20 (the clause of X4, Y10) voiding a refund restores the advance; a payment is not voided while the money was handed back: "void the refund first"', () => {
  it('a refund voided: the advance comes back, and it applies to a bill that is pending (the refund then bill example: 2,000 received, 500 refunded, a bill of 1,800 left 300 pending; voiding the refund pays the 300)', async () => {
    const c = await addCustomer(w);
    const r1 = await addMoney(w, c, '2000.00', '2026-10-01');
    const refund = await addMoney(w, c, '500.00', '2026-10-05', { kind: 'refund' });
    const a = await addBill(w, c, '1800.00', '2026-10-06');
    await addAllocation(w, r1, a, c, '1500.00'); // what Y6 applied: at most the advance of 1,500
    expect(await figures(w, c)).toMatchObject({ outstanding: '300.00', advance: '0.00' });
    const v = await voided(await voidReceipt(w, 'owner', refund));
    expect(v.receipt).toMatchObject({ kind: 'refund', status: 'voided' });
    expect(v.allocations.map((x) => [x.receipt_id, x.bill_id, x.amount])).toEqual([[r1, a, '300.00']]);
    expect(await pendingByBill(w, c)).toEqual({ [a]: '0.00' });
    expect(await figures(w, c)).toMatchObject({ outstanding: '0.00', advance: '200.00' });
    const ledger = await ledgerOf(w, c);
    expect(ledger.at(-1)).toMatchObject({ kind: 'Void', entry_date: TODAY, credit: '500.00', debit: '0.00' });
    await i10Holds(w, c);
  });

  it('a refund voided with no bill pending: the advance is whole again', async () => {
    const c = await addCustomer(w);
    await addMoney(w, c, '2000.00', '2026-10-01');
    const refund = await addMoney(w, c, '500.00', '2026-10-05', { kind: 'refund' });
    expect(await figures(w, c)).toMatchObject({ advance: '1500.00' });
    const closed = await dayRow(w, '2026-10-05', 'Other');
    const v = await voided(await voidReceipt(w, 'owner', refund));
    expect(v.allocations).toEqual([]);
    expect(await figures(w, c)).toMatchObject({ advance: '2000.00' });
    expect(await dayRow(w, '2026-10-05', 'Other')).toEqual(closed);
  });

  it('the 2,000 payment cannot be voided after 500 of it was refunded (JV_NOT_ALLOWED, void the refund first); nothing changes; after the refund is voided it can', async () => {
    const c = await addCustomer(w);
    const r1 = await addMoney(w, c, '2000.00', '2026-10-01');
    const refund = await addMoney(w, c, '500.00', '2026-10-05', { kind: 'refund' });
    const error = await refused(r1, { reason: 'wrong customer' }, { status: 409, code: 'JV_NOT_ALLOWED' });
    expect(error.message).toMatch(/void the refund first/i);
    expect(error.details).toMatchObject({ short_by: '500.00' });
    expect((await receiptRow(w, r1)).status).toBe('active');
    await voided(await voidReceipt(w, 'owner', refund));
    await voided(await voidReceipt(w, 'owner', r1));
    expect(await figures(w, c)).toMatchObject({ advance: '0.00', outstanding: '0.00' });
  });

  it('the money was spent on a bill and the rest handed back: voiding the payment would leave the advance below 0 (1,800 on a bill, 200 refunded)', async () => {
    const c = await addCustomer(w);
    const a = await addBill(w, c, '1800.00', '2026-10-01');
    const r1 = await addMoney(w, c, '2000.00', '2026-10-02');
    await addAllocation(w, r1, a, c, '1800.00');
    await addMoney(w, c, '200.00', '2026-10-05', { kind: 'refund' });
    expect(await figures(w, c)).toMatchObject({ outstanding: '0.00', advance: '0.00' });
    await refused(r1, { reason: 'wrong customer' }, { status: 409, code: 'JV_NOT_ALLOWED', details: { short_by: '200.00' } });
  });

  it('the boundary: a void that leaves the advance at exactly 0 is allowed (1,000 + 500 received, 500 refunded: the 1,000 can go, the 500 cannot go first)', async () => {
    const c = await addCustomer(w);
    const r1 = await addMoney(w, c, '1000.00', '2026-10-01');
    const r2 = await addMoney(w, c, '500.00', '2026-10-02');
    await addMoney(w, c, '500.00', '2026-10-05', { kind: 'refund' });
    expect(await figures(w, c)).toMatchObject({ advance: '1000.00' });
    await voided(await voidReceipt(w, 'owner', r1));
    expect(await figures(w, c)).toMatchObject({ advance: '0.00' });
    await refused(r2, { reason: 'wrong customer' }, { status: 409, code: 'JV_NOT_ALLOWED' });
  });

  it('a payment that paid a bill in full can be voided even when money was refunded from another receipt (its own remaining is 0)', async () => {
    const c = await addCustomer(w);
    const a = await addBill(w, c, '1000.00', '2026-10-01');
    const r1 = await addMoney(w, c, '1000.00', '2026-10-02');
    await addAllocation(w, r1, a, c, '1000.00');
    await addMoney(w, c, '300.00', '2026-10-03');
    await addMoney(w, c, '300.00', '2026-10-05', { kind: 'refund' });
    expect(await figures(w, c)).toMatchObject({ advance: '0.00' });
    const v = await voided(await voidReceipt(w, 'owner', r1));
    // the 300 that was received beside it was handed back: it is not spent a second time on the bill that came back (Y6: at most the advance, and the advance is 0)
    expect(v.allocations).toEqual([]);
    expect(await pendingByBill(w, c)).toEqual({ [a]: '1000.00' });
    expect(await figures(w, c)).toMatchObject({ outstanding: '1000.00', advance: '0.00' });
    await i10Holds(w, c);
  });
});

// ------------------------------------------------------------------ the rest of X4

describe('X4 what is refused, and that a refusal leaves no trace', () => {
  it('a second void of the same receipt (another key) is 409 JV_ALREADY_VOID and changes nothing; never a JV_BUSY', async () => {
    const c = await addCustomer(w);
    await addBill(w, c, '100.00', '2026-10-01');
    const r = await paid(await pay(w, 'owner', c, upi('40.00')));
    await voided(await voidReceipt(w, 'owner', r.receipt.id, { reason: 'first' }));
    const stored = await receiptRow(w, r.receipt.id);
    await refused(r.receipt.id, { reason: 'second' }, { status: 409, code: 'JV_ALREADY_VOID' });
    expect(await receiptRow(w, r.receipt.id)).toEqual(stored);
  });

  it('a receipt that does not exist is 404, a path that is not an id is 422 on id; the database is not asked about the second', async () => {
    await refused('00000000-0000-4000-8000-0000000000aa', { reason: 'never made' }, { status: 404, code: 'JV_NOT_FOUND' });
    const res = await voidReceipt(w, 'owner', 'not-an-id', { reason: 'never made' });
    expect(refusal(res)).toMatchObject({ status: 422, code: 'JV_INVALID_INPUT', field: 'id' });
  });

  it('the reason is required and is 3 to 500 characters once trimmed; anything else in the body is refused; nothing is saved', async () => {
    const c = await addCustomer(w);
    await addBill(w, c, '100.00', '2026-10-01');
    const r = await paid(await pay(w, 'owner', c, upi('40.00')));
    await refused(r.receipt.id, NO_BODY, { status: 422, code: 'JV_INVALID_INPUT', field: 'body' });
    for (const payload of [{}, { reason: '' }, { reason: 'ab' }, { reason: '  ab  ' }, { reason: '   ' }, { reason: 'x'.repeat(501) }, { reason: 12345 }, { reason: null }]) {
      await refused(r.receipt.id, payload, { status: 422, code: 'JV_INVALID_INPUT', field: 'reason' });
    }
    await refused(r.receipt.id, { reason: 'fine', amount: '1.00' }, { status: 422, code: 'JV_INVALID_INPUT' });
    const ok = await voidReceipt(w, 'owner', r.receipt.id, { reason: '  abc  ' });
    expect(ok.statusCode, ok.body).toBe(200);
    expect((await receiptRow(w, r.receipt.id)).void_reason).toBe('abc');
    const long = await addMoney(w, c, '10.00', '2026-10-02');
    expect((await voidReceipt(w, 'owner', long, { reason: 'y'.repeat(500) })).statusCode).toBe(200);
  });

  it('an archived customer: the call is refused with JV_CUSTOMER_ARCHIVED (a void would leave dues on a customer who is archived only while they owe nothing, K4)', async () => {
    const c = await addCustomer(w);
    const r = await addMoney(w, c, '40.00', '2026-10-01');
    await w.world.sql.query('UPDATE customers SET archived_at = ? WHERE id = ?', ['2026-10-02 05:00:00.000000', c]);
    await refused(r, { reason: 'wrong customer' }, { status: 409, code: 'JV_CUSTOMER_ARCHIVED' });
    await w.world.sql.query('UPDATE customers SET archived_at = NULL WHERE id = ?', [c]);
    expect((await voidReceipt(w, 'owner', r, { reason: 'wrong customer' })).statusCode).toBe(200);
  });

  it('the order of the checks: a voided receipt of an archived customer is JV_ALREADY_VOID, a plain fact', async () => {
    const c = await addCustomer(w);
    const r = await addMoney(w, c, '40.00', '2026-10-01');
    await voided(await voidReceipt(w, 'owner', r));
    await w.world.sql.query('UPDATE customers SET archived_at = ? WHERE id = ?', ['2026-10-02 05:00:00.000000', c]);
    await refused(r, { reason: 'again' }, { status: 409, code: 'JV_ALREADY_VOID' });
  });
});

describe('T-B17 (the clause of X4, K5) the walk-in customer: a voided receipt re-opens its bill and the walk-in never holds an advance', () => {
  it('a walk-in bill paid in full, its receipt voided: the bill is pending again, nothing is rebalanced, the walk-in holds no advance', async () => {
    const a = await addBill(w, WALKIN, '600.00', '2026-10-01');
    const r = await addMoney(w, WALKIN, '600.00', '2026-10-02');
    await addAllocation(w, r, a, WALKIN, '600.00');
    expect((await pendingByBill(w, WALKIN))[a]).toBe('0.00');
    const v = await voided(await voidReceipt(w, 'owner', r, { reason: 'the customer paid by cheque instead' }));
    expect(v.allocations).toEqual([]);
    expect(v.bills.map((x) => [x.id, x.pending])).toEqual([[a, '600.00']]);
    expect((await pendingByBill(w, WALKIN))[a]).toBe('600.00');
    const books = await figures(w, WALKIN);
    expect(books.advance).toBe('0.00');
    expect(books.fine_advance).toBe('0.000');
  });
});

describe('D23 touches: the receipt, the bills it paid and the customer carry the stamp of the void; no other bill does', () => {
  it('stamps come from the one reading of the clock; an unrelated bill of the same customer keeps its stamp', async () => {
    const c = await addCustomer(w);
    const a = await addBill(w, c, '100.00', '2026-10-01');
    const other = await addBill(w, c, '900.00', '2026-10-02');
    const r = await addMoney(w, c, '100.00', '2026-10-03');
    await addAllocation(w, r, a, c, '100.00');
    const otherBefore = (await billRow(w, other)).updated_at;
    const aBefore = (await billRow(w, a)).updated_at;
    const customerBefore = (await customerRow(w, c)).updated_at;
    const v = await voided(await voidReceipt(w, 'owner', r));
    const at = (await receiptRow(w, r)).voided_at as string;
    expect((await receiptRow(w, r)).updated_at).toBe(at);
    expect((await billRow(w, a)).updated_at).toBe(at);
    expect((await customerRow(w, c)).updated_at).toBe(at);
    expect((await billRow(w, other)).updated_at).toBe(otherBefore);
    expect(at > aBefore, 'the stamp of the call is later than the bill\'s own').toBe(true);
    expect((await customerRow(w, c)).updated_at).not.toBe(customerBefore);
    expect(v.bills.map((x) => x.id)).toEqual([a]);
    expect(v.bills[0].updated_at).toBe(v.receipt.updated_at);
  });
});

describe('X0 the order of work inside the transaction, as the statements say it', () => {
  it('claim first, then the receipt is found, the customer locked, the receipt read again FOR UPDATE, the state read ONCE, then the one UPDATE of the receipt, the touches and the stored result; no lock after a write; no number, no piece', async () => {
    const c = await addCustomer(w);
    const a = await addBill(w, c, '100.00', '2026-10-01');
    const r = await addMoney(w, c, '100.00', '2026-10-02');
    await addAllocation(w, r, a, c, '100.00');
    const from = w.world.spy.sent.length;
    const res = await voidReceipt(w, 'owner', r);
    expect(res.statusCode, res.body).toBe(200);
    const sqls = w.world.spy.sqls().slice(from).map((s) => s.trim());
    const at = (re: RegExp, nth = 0): number => sqls.map((s, i) => [s, i] as const).filter(([s]) => re.test(s))[nth]?.[1] ?? -1;
    const claim = at(/^INSERT INTO sys_idempotency\b/);
    const find = at(/^SELECT customer_id FROM receipts WHERE id = \?$/);
    const customer = at(/^SELECT .* FROM customers WHERE id = \? FOR UPDATE$/s);
    const again = at(/^SELECT \* FROM receipts WHERE id = \? FOR UPDATE$/);
    const shares = at(/^SELECT bill_id, SUM\(amount\) AS amount, SUM\(fine_grams\) AS fine_grams FROM receipt_allocations WHERE receipt_id = \?/);
    const state = at(/WHERE b\.customer_id = \? AND b\.status = 'active'/);
    const update = at(/^UPDATE receipts SET\b/);
    const touchBills = at(/^UPDATE bills SET updated_at = \?/);
    const touchCustomer = at(/^UPDATE customers SET updated_at = \?/);
    const store = at(/^UPDATE sys_idempotency SET result = \?/);
    expect(claim, 'the claim is the first statement of the transaction').toBe(Math.min(...sqls.map((s, i) => (/^INSERT INTO sys_idempotency\b/.test(s) ? i : 1e9))));
    expect(find).toBeGreaterThan(claim);
    expect(customer).toBeGreaterThan(find);
    expect(again).toBeGreaterThan(customer);
    expect(shares, 'what the receipt gave each bill is read before the state, so before the test hook').toBeGreaterThan(again);
    expect(state).toBeGreaterThan(shares);
    expect(update).toBeGreaterThan(state);
    expect(touchBills).toBeGreaterThan(update);
    expect(touchCustomer).toBeGreaterThan(touchBills);
    expect(store).toBeGreaterThan(touchCustomer);
    expect(sqls.filter((s) => /WHERE b\.customer_id = \? AND b\.status = 'active'/.test(s)), 'the state of the customer is read once').toHaveLength(1);
    expect(sqls.filter((s) => /^SELECT\b.*\bFOR UPDATE$/s.test(s)).length, 'three row locks only: the claim row, the customer and the receipt').toBe(3);
    expect(sqls.slice(update).filter((s) => /FOR UPDATE/.test(s)), 'no lock is taken after the first write').toEqual([]);
    expect(sqls.some((s) => /sys_counters/.test(s)), 'a void takes no number').toBe(false);
    expect(sqls.some((s) => /\bFROM skus\b|\bFROM sku_private\b/.test(s)), 'a void reads no piece').toBe(false);
    expect(sqls.some((s) => /^(DELETE|REPLACE|TRUNCATE)\b/i.test(s)), 'nothing is deleted').toBe(false);
  });
});

describe('T-D09 the matrix row of X4 (POST /v1/receipts/:id/void: owner only)', () => {
  it('the route is registered through route() with the action of the row', () => {
    expect(w.world.app.routeTable.find((r) => r.action === 'fn:void_receipt')).toMatchObject({ method: 'POST', url: '/v1/receipts/:id/void', kind: 'matrix', roles: ['owner'], mustChange: false });
  });

  it('no session is 401, staff and a biller are 403 JV_FORBIDDEN, a user who must change the password is 403 JV_PASSWORD_CHANGE_REQUIRED, and none of them reads or writes the books', async () => {
    for (const [caller, status, code] of [['anon', 401, 'JV_UNAUTHENTICATED'], ['ended', 401, 'JV_UNAUTHENTICATED'], ['expired', 401, 'JV_SESSION_EXPIRED'], ['idle', 401, 'JV_SESSION_EXPIRED'], ['inactive', 401, 'JV_UNAUTHENTICATED'], ['staff', 403, 'JV_FORBIDDEN'], ['biller', 403, 'JV_FORBIDDEN'], ['must_change', 403, 'JV_PASSWORD_CHANGE_REQUIRED']] as const) {
      const c = await addCustomer(w);
      const r = await addMoney(w, c, '40.00', '2026-10-01');
      const from = w.world.spy.sent.length;
      const res = await voidReceipt(w, caller, r);
      expect(res.statusCode, caller).toBe(status);
      expect(codeOf(res), caller).toBe(code);
      await w.world.restore(caller);
      expect(w.world.spy.sqls().slice(from).some((s) => /\bFROM\s+(customers|bills|receipts|receipt_allocations|sys_idempotency)\b/i.test(s) || /^INSERT\b/i.test(s.trim())), `${caller} caused a read or write of the books`).toBe(false);
      expect((await receiptRow(w, r)).status, caller).toBe('active');
    }
  });

  it('the owner is let in, and the receipt names the owner as the person who voided it', async () => {
    const c = await addCustomer(w);
    const r = await addMoney(w, c, '40.00', '2026-10-01');
    const v = await voided(await voidReceipt(w, 'owner', r));
    expect(v.receipt.voided_by).toBe(owner());
  });
});

describe('L5 repeat-safety of void_receipt (the clause of T-C05): the same Idempotency-Key makes one void and answers the same', () => {
  it('the same key and body twice: one void, the same answer with Idempotent-Replay: true and the same status; the second call writes nothing', async () => {
    const c = await addCustomer(w);
    const a = await addBill(w, c, '100.00', '2026-10-01');
    const r = await paid(await pay(w, 'owner', c, upi('100.00')));
    const key = newKey();
    const first = await voidReceipt(w, 'owner', r.receipt.id, { reason: 'wrong customer' }, key);
    expect(first.statusCode).toBe(200);
    expect(first.headers['idempotent-replay']).toBeUndefined();
    const before = await trace(w);
    const again = await voidReceipt(w, 'owner', r.receipt.id, { reason: 'wrong customer' }, key);
    expect(again.statusCode).toBe(200);
    expect(again.headers['idempotent-replay']).toBe('true');
    expect(body(again)).toEqual(body(first));
    expect(await trace(w)).toEqual(before);
    expect(await pendingByBill(w, c)).toEqual({ [a]: '100.00' });
  });

  it('the same key with another reason or on another receipt is refused (422 on the header), and saves nothing', async () => {
    const c = await addCustomer(w);
    const [r1, r2] = [await addMoney(w, c, '10.00', '2026-10-01'), await addMoney(w, c, '10.00', '2026-10-02')];
    const key = newKey();
    await voided(await voidReceipt(w, 'owner', r1, { reason: 'first reason' }, key));
    const before = await trace(w);
    for (const [receipt, payload] of [[r1, { reason: 'another reason' }], [r2, { reason: 'first reason' }]] as const) {
      const res = await voidReceipt(w, 'owner', receipt, payload, key);
      expect(refusal(res), JSON.stringify(payload)).toMatchObject({ status: 422, code: 'JV_INVALID_INPUT', field: 'Idempotency-Key' });
    }
    expect(await trace(w)).toEqual(before);
  });

  it('a missing or malformed Idempotency-Key is 422 on the header and claims nothing', async () => {
    const c = await addCustomer(w);
    const r = await addMoney(w, c, '10.00', '2026-10-01');
    const before = await trace(w);
    for (const key of [null, 'abc', '12345']) {
      const res = await voidReceipt(w, 'owner', r, { reason: 'wrong customer' }, key);
      expect(refusal(res), String(key)).toMatchObject({ status: 422, code: 'JV_INVALID_INPUT', field: 'Idempotency-Key' });
    }
    expect(await trace(w)).toEqual(before);
  });

  it('a refusal does not use the key up: the same key is the first call once the cause is gone', async () => {
    const c = await addCustomer(w);
    const r1 = await addMoney(w, c, '2000.00', '2026-10-01');
    const refund = await addMoney(w, c, '500.00', '2026-10-05', { kind: 'refund' });
    const key = newKey();
    await refused(r1, { reason: 'wrong customer' }, { status: 409, code: 'JV_NOT_ALLOWED' }, 'owner', key);
    await voided(await voidReceipt(w, 'owner', refund));
    const ok = await voidReceipt(w, 'owner', r1, { reason: 'wrong customer' }, key);
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.headers['idempotent-replay']).toBeUndefined();
  });
});

describe('X4 the answer is what the wire says (S3): money and weight as text, rows in the sync form of the caller\'s role', () => {
  it('no JSON number in a money or weight field of the answer or of the stored result; the keys are those of the sync reads; the stored result is the answer', async () => {
    const c = await addCustomer(w);
    const a = await addBill(w, c, '300.00', '2026-10-01');
    const r1 = await addMoney(w, c, '300.00', '2026-10-02');
    await addAllocation(w, r1, a, c, '300.00');
    await addMoney(w, c, '50.00', '2026-10-03');
    const key = newKey();
    const res = await voidReceipt(w, 'owner', r1, { reason: 'wrong customer' }, key);
    const v = await voided(res);
    for (const x of [v.receipt.amount, v.receipt.fine_grams, v.allocations[0].amount, v.allocations[0].fine_grams, v.bills[0].grand_total, v.bills[0].pending, v.bills[0].received, v.bills[0].fine_pending]) expect(typeof x).toBe('string');
    expect(v.receipt.is_opening).toBe(false);
    expect(Object.keys(v).sort()).toEqual(['allocations', 'bills', 'receipt']);
    expect(Object.keys(v.receipt).sort()).toEqual(['amount', 'cash_override_reason', 'created_at', 'created_by', 'customer_id', 'fine_grams', 'id', 'is_opening', 'kind', 'mode', 'notes', 'paid_on', 'reference', 'silver_rate', 'status', 'updated_at', 'updated_by', 'void_reason', 'voided_at', 'voided_by', 'voided_on']);
    expect(Object.keys(v.bills[0]).sort()).toEqual(['bill_date', 'bill_no', 'created_at', 'customer_id', 'doc_type', 'fine_due', 'fine_pending', 'fine_settled', 'grand_total', 'id', 'item_count', 'payment_status', 'pending', 'received', 'reissue_of', 'sale_type', 'status', 'updated_at']);
    expect(Object.keys(v.allocations[0]).sort()).toEqual(['amount', 'bill_id', 'created_at', 'customer_id', 'fine_grams', 'id', 'receipt_id', 'released_at', 'updated_at']);
    const [claim] = await rows(w, 'SELECT result FROM sys_idempotency WHERE request_id = ?', [key]);
    const stored = typeof claim.result === 'string' ? JSON.parse(claim.result) : claim.result;
    expect(stored).toEqual(v);
    expect(errorField(res)).toBeUndefined();
  });
});

describe('I3 + K3 the cancelled bill and the void meet: a receipt that paid a bill which was cancelled is voided without any bill coming back', () => {
  it('the allocations were released by the cancel; the void removes the advance the cancel made, and re-opens nothing', async () => {
    const c = await addCustomer(w);
    const a = await addCancelledBill(w, c, '300.00', '2026-10-01');
    const r = await addMoney(w, c, '300.00', '2026-10-02');
    await addAllocation(w, r, a, c, '300.00', { released_at: stamp('2026-10-03', 5) });
    expect(await figures(w, c)).toMatchObject({ advance: '300.00', outstanding: '0.00' });
    const v = await voided(await voidReceipt(w, 'owner', r));
    expect(v.bills).toEqual([]);
    expect(v.allocations).toEqual([]);
    expect(await figures(w, c)).toMatchObject({ advance: '0.00', outstanding: '0.00' });
    expect((await allocationsOf(w, c)).map((x) => x.released_at !== null)).toEqual([true]);
  });
});
