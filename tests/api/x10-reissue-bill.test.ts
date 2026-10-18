import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as receiptWrite from '../../src/money/receiptWrite';
import { type Designs, addDesigns, billBody, counterOf, item, piece, pieceRow, postBill, saved, setEstimate } from './x01-support';
import { addFineBill, finePendingByBill, settle, settled } from './x03-support';
import { billStates, cancelBill, cancelled, ledgerOf } from './x04-support';
import { type EditWorld, TODAY, WALKIN, addAllocation, addBill, addCancelledBill, addCustomer, addMoney, addOpeningBill, billRow, body, codeOf, customerRow, editWorld, figures, i10Holds, newKey, pay, paid, pendingAgrees, pendingByBill, receiptsOf, refusal, rows } from './x02-support';
import { type Body, cash, firstBadBalance, ledgerKinds, line, liveOn, reissueBill, reissueBody, reissued, sell, trace, upi, v2 } from './x10-support';

// API26, X10 reissue_bill (POST /v1/bills/:id/reissue, owner; X10, K1, K6, K3, K5, Y3, Y6, Y8, Z1 to Z3, L5, X0, D23): the correction path. The wrong bill is cancelled and the right one is saved in one
// transaction, and the money received moves to the new bill. T-B19 (the old bill is cancelled and the new one saved in one step; the money moves to the new bill, with and without older pending bills,
// and is not counted twice; the new bill points back; a second re-issue and a change of customer are refused), T-B25 (ledger order: in one create_bill the Invoice comes before its Payment rows, a
// re-issue lists Cancellation, Invoice, Payment in that order, the running balance never goes ahead of its events), the clause of T-B17 (the walk-in: a surplus of money or of silver grams is refused),
// the clause of T-D09 (the matrix row) and the rest of X10: the answer, the order of work, the touches, the repeat of a key. The audit rows (T-D14) are in x10-audit.test.ts and the two-session tests
// (T-C13 (c)) in x10-two-sessions.test.ts.
//
// The world is the scratch database of the other money tests (real routes, seeds, a clock fixed at 17 Oct 2026 10:00 UTC = 15:30 in Kolkata, "today" is 2026-10-17). The bills that are re-issued are made
// through the real create_bill route (so they have lines, pieces and receipts as the application writes them); older pending bills and silver are typed by SQL. Expected figures are written in the test;
// the books are checked with V1 to V3 and I10 of the database half, which are another opinion.

let w: EditWorld;
let d: Designs;

beforeAll(async () => {
  w = await editWorld('x10reissue');
  d = await addDesigns(w);
}, 120_000);
afterAll(async () => {
  await w?.world.close();
}, 60_000);

const owner = () => w.world.fixtures.owner.userId;
const bill = (customer: string, total: string, extra: Body = {}) => sell(w, d, customer, total, extra);

/** The refusal is exactly this, and the call left no trace: nothing cancelled, no allocation released, no piece moved, no claim, no audit row, no number, no stamp. */
async function refused(
  billId: string,
  payload: unknown,
  expected: { status: number; code: string; field?: string; details?: Record<string, unknown> },
  caller: 'owner' | 'biller' | 'staff' = 'owner',
  key = newKey(),
): Promise<Record<string, any>> {
  const before = { trace: await trace(w), numbers: await numbers() };
  const res = await reissueBill(w, caller, billId, payload, key);
  expect(refusal(res), res.body).toMatchObject({ status: expected.status, code: expected.code, ...(expected.field === undefined ? {} : { field: expected.field }) });
  if (expected.details) expect(body(res).error.details, res.body).toMatchObject(expected.details);
  expect({ trace: await trace(w), numbers: await numbers() }, 'a refused re-issue leaves no trace and takes no number').toEqual(before);
  return body(res).error;
}
const numbers = async (): Promise<number> => Number((await rows(w, 'SELECT COALESCE(SUM(last_value), 0) AS n FROM sys_counters'))[0].n);

// ------------------------------------------------------------------ T-B19

describe('T-B19 the old bill is cancelled and the new one saved in one step; the money received moves to the new bill and is not counted twice (K1, K6, X10)', () => {
  it('a bill of 1,000 with 600 received is re-issued at 900: both bills in the answer, the new one points back, the 600 is on the new bill once, 300 is pending, the piece is on the new bill', async () => {
    const c = await addCustomer(w);
    const a = await bill(c, '1000.00', { payments: [upi('600.00')] });
    const r1 = String(a.made.receipts[0].id);
    const key = newKey();
    const res = await reissueBill(w, 'owner', a.id, reissueBody('Retail', [line(a.piece, '900.00')], {}, 'the rate was wrong'), key);
    const r = await reissued(res);
    const id = String(r.new_bill.id);

    // the old bill: cancelled, with the reason, the day and the person (K3), and the stamp of the cancel
    expect(r.old_bill).toMatchObject({ id: a.id, status: 'cancelled', cancel_reason: 'the rate was wrong', cancelled_on: TODAY, cancelled_by: owner(), grand_total: '1000.00', reissue_of: null });
    expect(r.old_bill.cancelled_at).toBe(r.old_bill.updated_at);
    // the new bill: active, an estimate, the same customer, pointing back (K6), priced at 900
    expect(r.new_bill).toMatchObject({ status: 'active', doc_type: 'estimate', customer_id: c, reissue_of: a.id, grand_total: '900.00', sale_type: 'Retail', bill_date: TODAY, created_by: owner(), cancelled_at: null });
    expect(r.new_bill.bill_no).not.toBe(a.made.bill.bill_no);
    expect(r.items.map((x) => [x.bill_id, x.sku_id, x.line_no, x.item_total])).toEqual([[id, a.piece, 1, '900.00']]);
    expect(r.receipts).toEqual([]);
    // the money: the allocation to the old bill is released, the same receipt pays the new bill, and the answer says so
    expect(r.released_allocations.map((x) => [x.receipt_id, x.bill_id, x.amount])).toEqual([[r1, a.id, '600.00']]);
    expect(r.allocations.map((x) => [x.receipt_id, x.bill_id, x.amount, x.released_at])).toEqual([[r1, id, '600.00', null]]);
    expect(r.advance_applied).toBe('600.00');
    expect(r.warnings).toEqual([]);

    // the tables
    expect(await billRow(w, a.id)).toMatchObject({ status: 'cancelled', cancel_reason: 'the rate was wrong', cancelled_on: TODAY, cancelled_by: owner(), reissue_of: null });
    expect(await billRow(w, id)).toMatchObject({ status: 'active', reissue_of: a.id, request_id: key, customer_id: c });
    expect(await pieceRow(w, a.piece)).toMatchObject({ status: 'Sold', sold_bill_id: id, updated_by: owner() });
    expect(await billStates(w, c)).toMatchObject({
      [a.id]: { status: 'cancelled', received: '0.00', pending: '0.00', payment_status: 'Cancelled' },
      [id]: { status: 'active', received: '600.00', pending: '300.00' },
    });

    // not counted twice: one receipt of 600, received 600, allocated 600, 300 outstanding, no advance
    expect(await v2(w, c)).toMatchObject({ received: '600.00', allocated: '600.00', billed: '900.00', outstanding: '300.00', advance: '0.00' });
    expect((await receiptsOf(w, c)).map((x) => [x.id, x.amount, x.status])).toEqual([[r1, '600.00', 'active']]);
    expect(await liveOn(w, a.id)).toEqual({ money: '0.00', fine: '0.000' });
    expect(await liveOn(w, id)).toEqual({ money: '600.00', fine: '0.000' });
    expect(await figures(w, c)).toMatchObject({ outstanding: '300.00', advance: '0.00' });
    await pendingAgrees(w, c);
    await i10Holds(w, c);
  });

  it('with older pending bills: the 1,000 of the old bill goes to the NEW bill first (400), then to the older bill (500), and 100 is left as an advance (Y3 with a named bill, Y6)', async () => {
    const c = await addCustomer(w);
    const older = await addBill(w, c, '500.00', '2026-10-01'); // pending, dated before everything
    const a = await bill(c, '1000.00', { payments: [upi('1000.00')] });
    const r1 = String(a.made.receipts[0].id);
    expect(await figures(w, c)).toMatchObject({ outstanding: '500.00', advance: '0.00' });
    const r = await reissued(await reissueBill(w, 'owner', a.id, reissueBody('Retail', [line(a.piece, '400.00')])));
    const id = String(r.new_bill.id);
    expect(r.allocations.map((x) => [x.receipt_id, x.bill_id, x.amount])).toEqual([[r1, id, '400.00'], [r1, older, '500.00']]);
    expect(r.advance_applied).toBe('400.00');
    expect(await pendingByBill(w, c)).toMatchObject({ [a.id]: '0.00', [id]: '0.00', [older]: '0.00' });
    expect(await figures(w, c)).toMatchObject({ outstanding: '0.00', advance: '100.00' });
    expect(await v2(w, c)).toMatchObject({ received: '1000.00', allocated: '900.00' });
    await pendingAgrees(w, c);
    await i10Holds(w, c);
  });

  it('the new bill is dearer than the money: it takes all of it and the older pending bill gets nothing (the new bill is first, not the oldest)', async () => {
    const c = await addCustomer(w);
    const older = await addBill(w, c, '500.00', '2026-10-01');
    const a = await bill(c, '1000.00', { payments: [upi('1000.00')] });
    const r = await reissued(await reissueBill(w, 'owner', a.id, reissueBody('Retail', [line(a.piece, '1500.00')])));
    const id = String(r.new_bill.id);
    expect(r.allocations.map((x) => [x.bill_id, x.amount])).toEqual([[id, '1000.00']]);
    expect(await pendingByBill(w, c)).toMatchObject({ [id]: '500.00', [older]: '500.00' });
    expect(await figures(w, c)).toMatchObject({ outstanding: '1000.00', advance: '0.00' });
    await i10Holds(w, c);
  });

  it('money from several receipts goes to the new bill oldest receipt first (Y6): 300 then 500 against a new bill of 700 leaves 100 of the second receipt as an advance', async () => {
    const c = await addCustomer(w);
    const a = await bill(c, '800.00', { payments: [upi('300.00')] });
    const r1 = String(a.made.receipts[0].id);
    const second = await paid(await pay(w, 'owner', c, { amount: '500.00', mode: 'UPI', bill_id: a.id }));
    const r2 = String(second.receipt.id);
    const r = await reissued(await reissueBill(w, 'owner', a.id, reissueBody('Retail', [line(a.piece, '700.00')])));
    const id = String(r.new_bill.id);
    expect(r.released_allocations.map((x) => [x.receipt_id, x.amount]).sort()).toEqual([[r1, '300.00'], [r2, '500.00']].sort());
    expect(r.allocations.map((x) => [x.receipt_id, x.bill_id, x.amount])).toEqual([[r1, id, '300.00'], [r2, id, '400.00']]);
    expect(await v2(w, c)).toMatchObject({ received: '800.00', allocated: '700.00', outstanding: '0.00', advance: '100.00' });
    await i10Holds(w, c);
  });

  it('the explicit new payments are recorded AFTER the carried money and the overpayment check counts what was carried: 600 carried + 400 paid fills a bill of 1,000; 500 is JV_OVERPAYMENT and nothing is saved', async () => {
    const c = await addCustomer(w);
    const a = await bill(c, '1000.00', { payments: [upi('600.00')] });
    const r1 = String(a.made.receipts[0].id);
    await refused(a.id, reissueBody('Retail', [line(a.piece, '1000.00')], { payments: [upi('500.00')] }), { status: 409, code: 'JV_OVERPAYMENT', field: 'payments' });
    expect((await billRow(w, a.id)).status, 'the refusal left the old bill active').toBe('active');
    const r = await reissued(await reissueBill(w, 'owner', a.id, reissueBody('Retail', [line(a.piece, '1000.00')], { payments: [upi('400.00'), upi('0.00')] })));
    const id = String(r.new_bill.id);
    expect(r.receipts).toHaveLength(1);
    expect(r.receipts[0]).toMatchObject({ customer_id: c, kind: 'money', mode: 'UPI', amount: '400.00', paid_on: TODAY, status: 'active' });
    // the carried money first (the rebalance), then the explicit payment (X1 (i)): the order of the writes
    expect(r.allocations.map((x) => [x.receipt_id, x.bill_id, x.amount])).toEqual([[r1, id, '600.00'], [String(r.receipts[0].id), id, '400.00']]);
    expect(r.advance_applied).toBe('600.00');
    expect((await billStates(w, c))[id]).toMatchObject({ received: '1000.00', pending: '0.00', payment_status: 'Paid' });
    expect(await v2(w, c)).toMatchObject({ received: '1000.00', allocated: '1000.00', outstanding: '0.00', advance: '0.00' });
    await i10Holds(w, c);
  });

  it('the money already covers the new bill: an explicit payment of any size is JV_OVERPAYMENT, and an explicit payment of 0 is ignored', async () => {
    const c = await addCustomer(w);
    const a = await bill(c, '1000.00', { payments: [upi('1000.00')] });
    await refused(a.id, reissueBody('Retail', [line(a.piece, '800.00')], { payments: [upi('1.00')] }), { status: 409, code: 'JV_OVERPAYMENT' });
    const r = await reissued(await reissueBill(w, 'owner', a.id, reissueBody('Retail', [line(a.piece, '800.00')], { payments: [upi('0.00')] })));
    expect(r.receipts).toEqual([]);
    expect(await figures(w, c)).toMatchObject({ outstanding: '0.00', advance: '200.00' });
  });

  it('silver: the grams settled on the old bill go to the new bill first, not to an older bill that owes silver', async () => {
    const c = await addCustomer(w);
    const p = await piece(w, d.silver999, { nw: '10.000', retail: '2.00' });
    const older = await addFineBill(w, c, '100.00', '5.000', '2026-10-01');
    const a = await saved(await postBill(w, 'owner', billBody(c, 'Wholesale', [item(p, { metal_rate: '80.00', labour_rate: '2.00' })])));
    expect(a.bill).toMatchObject({ fine_weight_due: '10.000', grand_total: '20.00' });
    await settled(await settle(w, 'owner', c, { grams: '4.000', mode: 'Silver', bill_id: String(a.bill.id) }));
    const r = await reissued(await reissueBill(w, 'owner', String(a.bill.id), reissueBody('Wholesale', [item(p, { metal_rate: '80.00', labour_rate: '3.00' })])));
    const id = String(r.new_bill.id);
    expect(r.new_bill).toMatchObject({ fine_weight_due: '10.000', grand_total: '30.00', reissue_of: String(a.bill.id) });
    expect(r.allocations.map((x) => [x.bill_id, x.fine_grams, x.amount])).toEqual([[id, '4.000', '0.00']]);
    expect(await finePendingByBill(w, c)).toMatchObject({ [id]: '6.000', [older]: '5.000', [String(a.bill.id)]: '0.000' });
    expect(await v2(w, c)).toMatchObject({ fine_outstanding: '11.000', fine_advance: '0.000' });
    await i10Holds(w, c);
  });

  it('a second re-issue of the same bill meets a cancelled bill: 409 JV_BILL_CANCELLED, nothing changes, no number is taken (K6)', async () => {
    const c = await addCustomer(w);
    const a = await bill(c, '500.00');
    const first = await reissued(await reissueBill(w, 'owner', a.id, reissueBody('Retail', [line(a.piece, '450.00')])));
    const stored = await billRow(w, a.id);
    const error = await refused(a.id, reissueBody('Retail', [line(a.piece, '400.00')]), { status: 409, code: 'JV_BILL_CANCELLED' });
    expect(error.message).toMatch(/cancelled/i);
    expect(await billRow(w, a.id)).toEqual(stored);
    expect((await billRow(w, String(first.new_bill.id))).status).toBe('active');
    expect(await pieceRow(w, a.piece)).toMatchObject({ status: 'Sold', sold_bill_id: String(first.new_bill.id) });
  });

  it('the new bill can be re-issued in its turn (a chain), each pointing back to the one it replaces; a bill cancelled by X5 (no replacement) is refused like a re-issued one', async () => {
    const c = await addCustomer(w);
    const a = await bill(c, '500.00', { payments: [upi('500.00')] });
    const second = await reissued(await reissueBill(w, 'owner', a.id, reissueBody('Retail', [line(a.piece, '450.00')])));
    const third = await reissued(await reissueBill(w, 'owner', String(second.new_bill.id), reissueBody('Retail', [line(a.piece, '420.00')])));
    expect(third.new_bill.reissue_of).toBe(second.new_bill.id);
    expect(third.old_bill).toMatchObject({ id: second.new_bill.id, status: 'cancelled', reissue_of: a.id });
    expect(await figures(w, c)).toMatchObject({ outstanding: '0.00', advance: '80.00' });
    await i10Holds(w, c);

    const x = await bill(c, '300.00');
    await cancelled(await cancelBill(w, 'owner', x.id));
    await refused(x.id, reissueBody('Retail', [line(x.piece, '300.00')]), { status: 409, code: 'JV_BILL_CANCELLED' });
  });

  it('the customer cannot change: customer_id is not an input of a re-issue, not even the old bill\'s own, and the new bill is always the old bill\'s customer\'s', async () => {
    const c = await addCustomer(w);
    const other = await addCustomer(w);
    const a = await bill(c, '500.00');
    for (const customer_id of [other, c]) await refused(a.id, reissueBody('Retail', [line(a.piece, '450.00')], { customer_id }), { status: 422, code: 'JV_INVALID_INPUT' });
    const r = await reissued(await reissueBill(w, 'owner', a.id, reissueBody('Retail', [line(a.piece, '450.00')])));
    expect(r.new_bill.customer_id).toBe(c);
    expect((await rows(w, 'SELECT customer_id FROM bills WHERE id = ?', [r.new_bill.id]))[0].customer_id).toBe(c);
  });

  it('the pieces: one that is left off the new bill returns to stock, one that stays or is added is Sold on the new bill (K3 for the old list, K2 for the new)', async () => {
    const c = await addCustomer(w);
    const [p1, p2, p3] = [await piece(w, d.gold24pp, { retail: '100.00' }), await piece(w, d.gold24pp, { retail: '200.00' }), await piece(w, d.gold24pp, { retail: '300.00' })];
    const a = await saved(await postBill(w, 'owner', billBody(c, 'Retail', [item(p1, { metal_rate: '100.00' }), item(p2, { metal_rate: '200.00' })])));
    const r = await reissued(await reissueBill(w, 'owner', String(a.bill.id), reissueBody('Retail', [item(p2, { metal_rate: '250.00' }), item(p3, { metal_rate: '300.00' })])));
    const id = String(r.new_bill.id);
    expect(await pieceRow(w, p1)).toMatchObject({ status: 'In Stock', sold_bill_id: null });
    expect(await pieceRow(w, p2)).toMatchObject({ status: 'Sold', sold_bill_id: id });
    expect(await pieceRow(w, p3)).toMatchObject({ status: 'Sold', sold_bill_id: id });
    expect(r.new_bill.grand_total).toBe('550.00');
    expect(r.items.map((x) => [x.sku_id, x.line_no])).toEqual([[p2, 1], [p3, 2]]);
  });

  it('a piece that is on ANOTHER bill, or held and not confirmed, cannot go on the new bill: 409 JV_PIECE_UNAVAILABLE, the old bill stays as it was (the cancel is rolled back with the rest)', async () => {
    const c = await addCustomer(w);
    const a = await bill(c, '500.00', { payments: [upi('500.00')] });
    const elsewhere = await bill(await addCustomer(w), '700.00');
    const held = await piece(w, d.gold24pp, { retail: '100.00', status: 'Reserved' });
    const before = await pieceRow(w, a.piece);
    const e1 = await refused(a.id, reissueBody('Retail', [line(a.piece, '500.00'), line(elsewhere.piece, '700.00')]), { status: 409, code: 'JV_PIECE_UNAVAILABLE' });
    expect(e1.details.sku_ids).toEqual([elsewhere.piece]);
    await refused(a.id, reissueBody('Retail', [line(held, '100.00')]), { status: 409, code: 'JV_PIECE_UNAVAILABLE' });
    expect(await pieceRow(w, a.piece)).toEqual(before);
    expect(await liveOn(w, a.id)).toEqual({ money: '500.00', fine: '0.000' });
    const ok = await reissueBill(w, 'owner', a.id, reissueBody('Retail', [line(held, '100.00')], { confirm_held: [held] }));
    expect(ok.statusCode, ok.body).toBe(201);
    expect(await pieceRow(w, held)).toMatchObject({ status: 'Sold' });
    expect(await pieceRow(w, a.piece)).toMatchObject({ status: 'In Stock', sold_bill_id: null });
  });

  it('IN ONE STEP: a failure after the cancel has been written rolls the cancel back with the rest (the old bill is active, its allocation live, its piece Sold, the key unused)', async () => {
    const c = await addCustomer(w);
    const a = await bill(c, '1000.00', { payments: [upi('600.00')] });
    const key = newKey();
    const before = { trace: await trace(w), numbers: await numbers() };
    const spy = vi.spyOn(receiptWrite, 'insertReceipt').mockImplementation(async () => {
      throw new Error('the disk is full');
    });
    try {
      const res = await reissueBill(w, 'owner', a.id, reissueBody('Retail', [line(a.piece, '1000.00')], { payments: [upi('400.00')] }), key);
      expect(res.statusCode, res.body).toBe(500);
      expect(codeOf(res)).toBe('JV_INTERNAL');
    } finally {
      spy.mockRestore();
    }
    expect({ trace: await trace(w), numbers: await numbers() }).toEqual(before);
    expect((await billRow(w, a.id)).status).toBe('active');
    expect(await liveOn(w, a.id)).toEqual({ money: '600.00', fine: '0.000' });
    expect(await pieceRow(w, a.piece)).toMatchObject({ status: 'Sold', sold_bill_id: a.id });
    const again = await reissueBill(w, 'owner', a.id, reissueBody('Retail', [line(a.piece, '1000.00')], { payments: [upi('400.00')] }), key);
    expect(again.statusCode, again.body).toBe(201);
    expect(again.headers['idempotent-replay']).toBeUndefined();
  });
});

// ------------------------------------------------------------------ T-B25

describe('T-B25 ledger order: in one create_bill the Invoice comes before its Payment rows; a re-issue lists Cancellation, Invoice, Payment in that order; the running balance never goes ahead of its events (V3)', () => {
  it('create_bill with two payment rows: the Invoice, then the two Payments, and the balance after each row is the sum of the rows before it', async () => {
    const c = await addCustomer(w);
    await bill(c, '1000.00', { payments: [upi('300.00'), cash('200.00')] });
    const kinds = await ledgerKinds(w, c);
    expect(kinds.map((k) => k[0])).toEqual(['Invoice', 'Payment', 'Payment']);
    expect(kinds[0]).toEqual(['Invoice', '1000.00', '0.00']);
    expect(kinds.slice(1).map((k) => k[2]).sort()).toEqual(['200.00', '300.00']);
    expect(await firstBadBalance(w, c)).toBeNull();
    expect((await ledgerOf(w, c)).at(-1)).toMatchObject({ balance: '500.00' });
    expect((await v2(w, c)).outstanding).toBe('500.00');
  });

  it('a re-issue with a new payment lists Cancellation, Invoice, Payment in that order; the cancel is stamped before the new bill, and the balance ends at what V2 says', async () => {
    const c = await addCustomer(w);
    const a = await bill(c, '1000.00', { payments: [upi('600.00')] });
    const r = await reissued(await reissueBill(w, 'owner', a.id, reissueBody('Retail', [line(a.piece, '1000.00')], { payments: [upi('400.00')] })));
    const kinds = await ledgerKinds(w, c);
    expect(kinds).toEqual([
      ['Invoice', '1000.00', '0.00'],
      ['Payment', '0.00', '600.00'],
      ['Cancellation', '0.00', '1000.00'],
      ['Invoice', '1000.00', '0.00'],
      ['Payment', '0.00', '400.00'],
    ]);
    expect(await firstBadBalance(w, c)).toBeNull();
    const ledger = await ledgerOf(w, c);
    expect(ledger.at(-1)).toMatchObject({ balance: '0.00', fine_balance: '0.000' });
    // the order rests on distinct stamps (S5): the cancel first, then the new bill, then its payment
    const oldRow = await billRow(w, a.id);
    const newRow = await billRow(w, String(r.new_bill.id));
    const receipt = (await receiptsOf(w, c)).find((x) => x.id === r.receipts[0].id);
    expect(oldRow.cancelled_at < newRow.created_at).toBe(true);
    expect(newRow.created_at <= receipt.created_at).toBe(true);
  });

  it('a re-issue that moves the money without a new payment: the balance never goes ahead (it falls by the cancelled bill and rises by the new one)', async () => {
    const c = await addCustomer(w);
    const a = await bill(c, '1000.00', { payments: [upi('1000.00')] });
    await reissued(await reissueBill(w, 'owner', a.id, reissueBody('Retail', [line(a.piece, '900.00')])));
    expect((await ledgerKinds(w, c)).map((k) => k[0])).toEqual(['Invoice', 'Payment', 'Cancellation', 'Invoice']);
    expect(await firstBadBalance(w, c)).toBeNull();
    expect((await ledgerOf(w, c)).at(-1)).toMatchObject({ balance: '-100.00' }); // billed 900, received 1,000: an advance of 100 (I4: the last balance is V2's)
    expect((await v2(w, c)).advance).toBe('100.00');
  });
});

// ------------------------------------------------------------------ the clause of T-B17

describe('T-B17 (the clause of X10, K5) the walk-in never holds an advance: a re-issue with a surplus of money or of silver grams is refused (void the receipts first)', () => {
  it('money: a walk-in bill of 1,000 paid in full cannot be re-issued at 600 (400 would be left over); at 1,000 or at 1,200 it can, and the walk-in holds no advance afterwards', async () => {
    const a = await bill(WALKIN, '1000.00', { payments: [upi('1000.00')] });
    const error = await refused(a.id, reissueBody('Retail', [line(a.piece, '600.00')]), { status: 409, code: 'JV_NOT_ALLOWED', details: { reason: 'void_its_receipts_first' } });
    expect(error.message).toMatch(/void/i);
    expect((await billRow(w, a.id)).status).toBe('active');
    const same = await reissued(await reissueBill(w, 'owner', a.id, reissueBody('Retail', [line(a.piece, '1000.00')])));
    expect(same.allocations.map((x) => [x.bill_id, x.amount])).toEqual([[same.new_bill.id, '1000.00']]);
    const dearer = await reissued(await reissueBill(w, 'owner', String(same.new_bill.id), reissueBody('Retail', [line(a.piece, '1200.00')])));
    expect(dearer.allocations.map((x) => [x.bill_id, x.amount])).toEqual([[dearer.new_bill.id, '1000.00']]);
    expect((await billStates(w, WALKIN))[String(dearer.new_bill.id)]).toMatchObject({ received: '1000.00', pending: '200.00' });
    const books = await figures(w, WALKIN);
    expect([books.advance, books.fine_advance]).toEqual(['0.00', '0.000']);
    await i10Holds(w, WALKIN);
  });

  it('money: the freed money never pays another stranger\'s older pending bill (one row stands for strangers): with the surplus it is refused, not spread', async () => {
    const strangers = await addBill(w, WALKIN, '500.00', '2026-10-01');
    const a = await bill(WALKIN, '1000.00', { payments: [upi('1000.00')] });
    await refused(a.id, reissueBody('Retail', [line(a.piece, '400.00')]), { status: 409, code: 'JV_NOT_ALLOWED', details: { reason: 'void_its_receipts_first' } });
    expect((await pendingByBill(w, WALKIN))[strangers]).toBe('500.00');
    // equal to the money: fine, and the older bill is still untouched
    const ok = await reissued(await reissueBill(w, 'owner', a.id, reissueBody('Retail', [line(a.piece, '1000.00')])));
    expect(ok.allocations.every((x) => x.bill_id === ok.new_bill.id)).toBe(true);
    expect((await pendingByBill(w, WALKIN))[strangers]).toBe('500.00');
  });

  it('silver: a walk-in Wholesale silver By Weight bill with 10 g of fine and 5 g settled in silver cannot be re-issued as Retail (no fine due) or with fewer grams; with the same grams the 5 g moves to the new bill', async () => {
    const heavy = await piece(w, d.silver999, { nw: '10.000', retail: '2.00' });
    const light = await piece(w, d.silver999, { nw: '3.000', retail: '2.00' });
    const a = await saved(await postBill(w, 'owner', billBody(WALKIN, 'Wholesale', [item(heavy, { metal_rate: '80.00', labour_rate: '2.00' })])));
    const aid = String(a.bill.id);
    expect(a.bill.fine_weight_due).toBe('10.000');
    await settled(await settle(w, 'owner', WALKIN, { grams: '5.000', mode: 'Silver', bill_id: aid }));
    // as Retail: no fine due at all
    const retail = await refused(aid, reissueBody('Retail', [item(heavy, { metal_rate: '80.00', labour_rate: '2.00' })]), { status: 409, code: 'JV_NOT_ALLOWED', details: { reason: 'void_its_receipts_first' } });
    expect(retail.details.fine_surplus).toBe('5.000');
    // with fewer grams: 3 g of fine due against 5 g received
    const fewer = await refused(aid, reissueBody('Wholesale', [item(light, { metal_rate: '80.00', labour_rate: '2.00' })]), { status: 409, code: 'JV_NOT_ALLOWED', details: { reason: 'void_its_receipts_first' } });
    expect(fewer.details.fine_surplus).toBe('2.000');
    expect(await liveOn(w, aid)).toEqual({ money: '0.00', fine: '5.000' });
    // the same grams: the 5 g follows the bill, the walk-in holds no silver advance
    const ok = await reissued(await reissueBill(w, 'owner', aid, reissueBody('Wholesale', [item(heavy, { metal_rate: '80.00', labour_rate: '3.00' })])));
    const id = String(ok.new_bill.id);
    expect(ok.allocations.map((x) => [x.bill_id, x.fine_grams, x.amount])).toEqual([[id, '5.000', '0.00']]);
    expect((await finePendingByBill(w, WALKIN))[id]).toBe('5.000');
    const books = await figures(w, WALKIN);
    expect([books.advance, books.fine_advance]).toEqual(['0.00', '0.000']);
    await i10Holds(w, WALKIN);
  });

  it('a walk-in bill with nothing received is re-issued freely, at any price', async () => {
    const a = await bill(WALKIN, '300.00');
    const r = await reissued(await reissueBill(w, 'owner', a.id, reissueBody('Retail', [line(a.piece, '50.00')])));
    expect(r.allocations).toEqual([]);
    expect(r.new_bill.grand_total).toBe('50.00');
  });

  it('a payment row of the re-issue itself (money handed over today) is judged like create_bill\'s: above the new total it is JV_OVERPAYMENT', async () => {
    const a = await bill(WALKIN, '300.00');
    await refused(a.id, reissueBody('Retail', [line(a.piece, '300.00')], { payments: [upi('300.01')] }), { status: 409, code: 'JV_OVERPAYMENT' });
    const r = await reissued(await reissueBill(w, 'owner', a.id, reissueBody('Retail', [line(a.piece, '300.00')], { payments: [upi('300.00')] })));
    expect(r.advance_applied).toBe('0.00');
    expect((await billStates(w, WALKIN))[String(r.new_bill.id)]).toMatchObject({ received: '300.00', pending: '0.00' });
  });
});

// ------------------------------------------------------------------ the rest of X10

describe('X10 the rules of X1 apply to the new bill (Y8, Z1 to Z3, K2) and what is refused leaves no trace', () => {
  it('only an active ESTIMATE can be re-issued: an opening-balance bill is refused (cancel it with X5 and add a new opening balance with X12); a bill that is not there is 404, a path that is not an id 422', async () => {
    const c = await addCustomer(w);
    const ob = await addOpeningBill(w, c, '700.00');
    const a = await bill(c, '100.00');
    const error = await refused(ob, reissueBody('Retail', [line(a.piece, '100.00')]), { status: 409, code: 'JV_NOT_ALLOWED', details: { reason: 'not_an_estimate' } });
    expect(error.message).toMatch(/estimate/i);
    await refused('00000000-0000-4000-8000-0000000000aa', reissueBody('Retail', [line(a.piece, '100.00')]), { status: 404, code: 'JV_NOT_FOUND' });
    const res = await reissueBill(w, 'owner', 'not-an-id', reissueBody('Retail', [line(a.piece, '100.00')]));
    expect(refusal(res)).toMatchObject({ status: 422, code: 'JV_INVALID_INPUT', field: 'id' });
  });

  it('an archived customer is refused (JV_CUSTOMER_ARCHIVED); a bill already cancelled is JV_BILL_CANCELLED first', async () => {
    const c = await addCustomer(w);
    const a = await bill(c, '100.00');
    const done = await addCancelledBill(w, c, '50.00', '2026-10-02');
    await w.world.sql.query('UPDATE customers SET archived_at = ? WHERE id = ?', ['2026-10-03 05:00:00.000000', c]);
    await refused(a.id, reissueBody('Retail', [line(a.piece, '100.00')]), { status: 409, code: 'JV_CUSTOMER_ARCHIVED' });
    await refused(done, reissueBody('Retail', [line(a.piece, '100.00')]), { status: 409, code: 'JV_BILL_CANCELLED' });
    await w.world.sql.query('UPDATE customers SET archived_at = NULL WHERE id = ?', [c]);
    expect((await reissueBill(w, 'owner', a.id, reissueBody('Retail', [line(a.piece, '100.00')]))).statusCode).toBe(201);
  });

  it('the reason is required and is 3 to 500 characters once trimmed; the body of create_bill is checked as create_bill checks it (items, dates, charges); unknown keys are refused', async () => {
    const c = await addCustomer(w);
    const a = await bill(c, '100.00');
    const items = [line(a.piece, '100.00')];
    for (const reason of [undefined, '', 'ab', '  ab  ', '   ', 'x'.repeat(501), 12345, null]) {
      const payload: Body = { sale_type: 'Retail', items, ...(reason === undefined ? {} : { reason }) };
      await refused(a.id, payload, { status: 422, code: 'JV_INVALID_INPUT', field: 'reason' });
    }
    await refused(a.id, { reason: 'fine', sale_type: 'Retail' }, { status: 422, code: 'JV_INVALID_INPUT', field: 'items' });
    await refused(a.id, reissueBody('Retail', [], {}), { status: 422, code: 'JV_INVALID_INPUT', field: 'items' });
    await refused(a.id, reissueBody('Wholesale ', items), { status: 422, code: 'JV_INVALID_INPUT', field: 'sale_type' });
    await refused(a.id, reissueBody('Retail', items, { bill_date: '2999-01-01' }), { status: 422, code: 'JV_INVALID_INPUT', field: 'bill_date' });
    await refused(a.id, reissueBody('Retail', items, { unknown_key: 1 }), { status: 422, code: 'JV_INVALID_INPUT' });
    await refused(a.id, reissueBody('Retail', [line(a.piece, '100.00'), line(a.piece, '100.00')]), { status: 422, code: 'JV_INVALID_INPUT', field: 'items[1].sku_id' });
    await refused(a.id, reissueBody('Retail', items, { payments: [{ mode: 'Credit', amount: '10.00' }] }), { status: 422, code: 'JV_INVALID_INPUT' });
    await refused(a.id, reissueBody('Retail', items, { confirm_held: ['00000000-0000-4000-8000-0000000000bb'] }), { status: 422, code: 'JV_INVALID_INPUT', field: 'confirm_held[0]' });
    await refused(a.id, reissueBody('Retail', [line('00000000-0000-4000-8000-0000000000cc', '1.00')]), { status: 422, code: 'JV_INVALID_INPUT', field: 'items[0].sku_id' });
    const ok = await reissueBill(w, 'owner', a.id, reissueBody('Retail', items, {}, '  abc  '));
    expect(ok.statusCode, ok.body).toBe(201);
    expect((await billRow(w, a.id)).cancel_reason).toBe('abc');
  });

  it('Y8: the owner may date the new bill any day up to today and a future date is refused; the new bill is dated what was sent', async () => {
    const c = await addCustomer(w);
    const a = await bill(c, '100.00');
    const r = await reissued(await reissueBill(w, 'owner', a.id, reissueBody('Retail', [line(a.piece, '100.00')], { bill_date: '2026-10-10' })));
    expect(r.new_bill.bill_date).toBe('2026-10-10');
    expect(r.old_bill.cancelled_on).toBe(TODAY);
  });

  it('Z1 and Z3: the day\'s cash counts the old bill\'s Cash receipt (it stays active) and the carried money is not new cash; 199,999.99 in all passes, 2,00,000 is JV_CASH_LIMIT unless the owner gives a reason, which is stored on the new bill; a named customer without a PAN gets PAN_MISSING', async () => {
    // nothing new in cash: the 150,000 moves to the new bill, the limit is not in play
    const a = await bill(await addCustomer(w), '150000.00', { payments: [cash('150000.00')] });
    const stays = await reissued(await reissueBill(w, 'owner', a.id, reissueBody('Retail', [line(a.piece, '150000.00')])));
    expect(stays.warnings).toEqual([]);
    expect(stays.new_bill.cash_override_reason).toBeNull();
    // 150,000 received today + 49,999.99 = 199,999.99: passes
    const a2 = await bill(await addCustomer(w), '150000.00', { payments: [cash('150000.00')] });
    const passes = await reissued(await reissueBill(w, 'owner', a2.id, reissueBody('Retail', [line(a2.piece, '250000.00')], { payments: [cash('49999.99')] })));
    expect(passes.new_bill.cash_override_reason).toBeNull();
    expect(passes.warnings).toEqual(['PAN_MISSING']);
    // 150,000 + 50,000 = 200,000: stopped, then allowed with a reason
    const a3 = await bill(await addCustomer(w), '150000.00', { payments: [cash('150000.00')] });
    await refused(a3.id, reissueBody('Retail', [line(a3.piece, '250000.00')], { payments: [cash('50000.00')] }), { status: 409, code: 'JV_CASH_LIMIT' });
    await refused(a3.id, reissueBody('Retail', [line(a3.piece, '250000.00')], { payments: [cash('50000.00')], cash_override_reason: 'short' }), { status: 422, code: 'JV_INVALID_INPUT', field: 'cash_override_reason' });
    const REASON = 'customer is paying a deposit for a wedding order';
    const ok = await reissued(await reissueBill(w, 'owner', a3.id, reissueBody('Retail', [line(a3.piece, '250000.00')], { payments: [cash('50000.00')], cash_override_reason: `  ${REASON}  ` })));
    expect(ok.new_bill.cash_override_reason).toBe(REASON);
    expect((await billRow(w, String(ok.new_bill.id))).cash_override_reason).toBe(REASON);
  });

  it('Z2: the walk-in\'s new bill of 2,00,000 or more is refused, and nothing is cancelled', async () => {
    const a = await bill(WALKIN, '1000.00');
    await refused(a.id, reissueBody('Retail', [line(a.piece, '200000.00')]), { status: 409, code: 'JV_NOT_ALLOWED' });
    expect((await billRow(w, a.id)).status).toBe('active');
  });

  it('the NUMBER: the new bill takes the next number of the series (L3, X0 item 6), the old number is not reused, and a refused re-issue takes none; the year is the year the new bill is saved', async () => {
    await setEstimate(w, { prefix: 'NUM' });
    const c = await addCustomer(w);
    const a = await bill(c, '500.00');
    expect(a.made.bill.bill_no).toBe('NUM-2026-0001');
    expect(await counterOf(w, 'bill:NUM:2026')).toBe(1);
    const first = await reissued(await reissueBill(w, 'owner', a.id, reissueBody('Retail', [line(a.piece, '450.00')])));
    expect(first.new_bill.bill_no).toBe('NUM-2026-0002');
    expect(await counterOf(w, 'bill:NUM:2026')).toBe(2);
    await refused(a.id, reissueBody('Retail', [line(a.piece, '400.00')]), { status: 409, code: 'JV_BILL_CANCELLED' });
    await refused(String(first.new_bill.id), reissueBody('Retail', [line(a.piece, '400.00')], { payments: [upi('9999.00')] }), { status: 409, code: 'JV_OVERPAYMENT' });
    expect(await counterOf(w, 'bill:NUM:2026')).toBe(2);
    const second = await reissued(await reissueBill(w, 'owner', String(first.new_bill.id), reissueBody('Retail', [line(a.piece, '400.00')])));
    expect(second.new_bill.bill_no).toBe('NUM-2026-0003');
    expect((await rows(w, 'SELECT bill_no FROM bills WHERE id = ?', [a.id]))[0].bill_no, 'the cancelled bill keeps its number').toBe('NUM-2026-0001');
    await setEstimate(w, { prefix: 'JV' });
  });
});

describe('D23 touches: the old bill, the new bill, the customer and the bills that received freed money carry the stamps of the call; no other bill does', () => {
  it('the cancel is stamped first, the new bill and the rebalance after it; the older pending bill that got the rest of the money and the customer carry the last stamp; an unrelated paid bill keeps its stamp', async () => {
    const c = await addCustomer(w);
    const older = await addBill(w, c, '500.00', '2026-10-01');
    const unrelated = await addBill(w, c, '40.00', '2026-10-03');
    const spent = await addMoney(w, c, '40.00', '2026-10-04');
    await addAllocation(w, spent, unrelated, c, '40.00');
    const a = await bill(c, '1000.00', { payments: [upi('1000.00')] });
    const before = { unrelated: (await billRow(w, unrelated)).updated_at, customer: (await customerRow(w, c)).updated_at };
    const r = await reissued(await reissueBill(w, 'owner', a.id, reissueBody('Retail', [line(a.piece, '400.00')])));
    const id = String(r.new_bill.id);
    const oldRow = await billRow(w, a.id);
    const newRow = await billRow(w, id);
    expect(oldRow.updated_at).toBe(oldRow.cancelled_at);
    expect(newRow.created_at > oldRow.cancelled_at, 'the new bill is stamped after the cancel').toBe(true);
    const allocs = await rows(w, 'SELECT * FROM receipt_allocations WHERE customer_id = ?', [c]);
    expect(allocs.find((x) => x.bill_id === a.id).released_at).toBe(oldRow.cancelled_at);
    const made = new Set(r.allocations.map((x) => String(x.id)));
    expect(made.size).toBe(2);
    for (const x of allocs.filter((z) => made.has(String(z.id)))) expect(x.created_at).toBe(newRow.created_at);
    expect((await billRow(w, older)).updated_at, 'the older bill received the rest of the freed money').toBe(newRow.created_at);
    expect((await customerRow(w, c)).updated_at).toBe(newRow.created_at);
    expect((await customerRow(w, c)).updated_at).not.toBe(before.customer);
    expect((await billRow(w, unrelated)).updated_at).toBe(before.unrelated);
  });
});

describe('X0 the order of work inside the transaction, as the statements say it', () => {
  it('claim, bill found, customer locked, bill re-read FOR UPDATE, open allocations and lines read, the state read ONCE, the pieces of BOTH lists locked by ONE statement, the number, then the cancel, the new bill, the carried money, the new payment, the stored answer; no lock after a write', async () => {
    const c = await addCustomer(w);
    const a = await bill(c, '1000.00', { payments: [upi('600.00')] });
    await bill(c, '300.00');
    const from = w.world.spy.sent.length;
    const res = await reissueBill(w, 'owner', a.id, reissueBody('Retail', [line(a.piece, '1000.00')], { payments: [upi('400.00')] }));
    expect(res.statusCode, res.body).toBe(201);
    const sqls = w.world.spy.sqls().slice(from).map((s) => s.trim());
    const at = (re: RegExp, nth = 0): number => sqls.map((s, i) => [s, i] as const).filter(([s]) => re.test(s))[nth]?.[1] ?? -1;
    const claim = at(/^INSERT INTO sys_idempotency\b/);
    const find = at(/^SELECT customer_id FROM bills WHERE id = \?$/);
    const customer = at(/^SELECT .* FROM customers WHERE id = \? FOR UPDATE$/s);
    const again = at(/^SELECT \* FROM bills WHERE id = \? FOR UPDATE$/);
    const open = at(/FROM receipt_allocations WHERE bill_id = \? AND customer_id = \? AND released_at IS NULL/);
    const lines = at(/^SELECT sku_id FROM bill_items WHERE bill_id = \?/);
    const state = at(/WHERE b\.customer_id = \? AND b\.status = 'active'/);
    const pieces = at(/FROM skus WHERE id IN \(.*\) ORDER BY id FOR UPDATE$/s);
    const counter = at(/^UPDATE sys_counters SET last_value/);
    const cancel = at(/^UPDATE bills SET status = \?/);
    const release = at(/^UPDATE receipt_allocations SET released_at = \?/);
    const back = at(/^UPDATE skus SET status = \?, sold_bill_id = NULL/);
    const insertBill = at(/^INSERT INTO bills\b/);
    const insertLines = at(/^INSERT INTO bill_items\b/);
    const sold = at(/^UPDATE skus SET status = \?, sold_bill_id = \?/);
    const carried = at(/^INSERT INTO receipt_allocations\b/, 0);
    const receipt = at(/^INSERT INTO receipts\b/);
    const paid = at(/^INSERT INTO receipt_allocations\b/, 1);
    const store = at(/^UPDATE sys_idempotency SET result = \?/);
    expect(claim, 'the claim is the first statement of the transaction').toBe(Math.min(...sqls.map((s, i) => (/^INSERT INTO sys_idempotency\b/.test(s) ? i : 1e9))));
    expect(find).toBeGreaterThan(claim);
    expect(customer).toBeGreaterThan(find);
    expect(again).toBeGreaterThan(customer);
    expect(open, 'the open allocations are read before the state, so before the test hook').toBeGreaterThan(again);
    expect(lines).toBeGreaterThan(again);
    expect(state).toBeGreaterThan(Math.max(open, lines));
    expect(pieces, 'the pieces are locked after the state read and the customer lock (X0 items 3 and 5)').toBeGreaterThan(state);
    expect(counter, 'the number is the last lock (X0 item 6): after the pieces, before the first write').toBeGreaterThan(pieces);
    expect(cancel).toBeGreaterThan(counter);
    expect(release).toBeGreaterThan(cancel);
    expect(back).toBeGreaterThan(cancel);
    expect(insertBill, 'the cancel is written before the new bill').toBeGreaterThan(Math.max(release, back));
    expect(insertLines).toBeGreaterThan(insertBill);
    expect(sold).toBeGreaterThan(insertLines);
    expect(carried, 'the carried money is allocated after the new bill exists').toBeGreaterThan(sold);
    expect(receipt, 'the explicit payment comes AFTER the carried money (X10)').toBeGreaterThan(carried);
    expect(paid).toBeGreaterThan(receipt);
    expect(store).toBeGreaterThan(paid);
    expect(sqls.filter((s) => /WHERE b\.customer_id = \? AND b\.status = 'active'/.test(s)), 'the state of the customer is read once').toHaveLength(1);
    expect(sqls.filter((s) => /FROM skus\b/.test(s) && /FOR UPDATE/.test(s)), 'the pieces of both lists are locked by one statement, never one at a time').toHaveLength(1);
    expect(sqls.filter((s) => /^UPDATE sys_counters/.test(s)), 'one number').toHaveLength(1);
    expect(sqls.slice(cancel).filter((s) => /FOR UPDATE/.test(s)), 'no lock is taken after the first write').toEqual([]);
    expect(sqls.some((s) => /^(DELETE|REPLACE|TRUNCATE)\b/i.test(s)), 'nothing is deleted').toBe(false);
    expect(sqls.some((s) => /WHERE\s+sold_bill_id\s*=/.test(s)), 'the pieces come back by the ids that were locked, never by WHERE sold_bill_id = ?').toBe(false);
  });
});

describe('X0 item 5: the ONE statement that locks the pieces names the pieces of BOTH lists (a piece on both once)', () => {
  it('an old bill of P1 and P2 re-issued with P2 and P3 locks three pieces; the new bill of P2 and P3 re-issued with P1 alone locks three again (nothing in common)', async () => {
    const c = await addCustomer(w);
    const [p1, p2, p3] = [await piece(w, d.gold24pp, { retail: '100.00' }), await piece(w, d.gold24pp, { retail: '200.00' }), await piece(w, d.gold24pp, { retail: '300.00' })];
    const a = await saved(await postBill(w, 'owner', billBody(c, 'Retail', [item(p1, { metal_rate: '100.00' }), item(p2, { metal_rate: '200.00' })])));
    const lockStatements = (from: number) => w.world.spy.sqls().slice(from).map((x) => x.trim()).filter((x) => /FROM skus\b/.test(x) && /FOR UPDATE/.test(x));
    const placeholders = (sql: string) => (sql.match(/\?/g) ?? []).length;

    const first = w.world.spy.sent.length;
    const r = await reissued(await reissueBill(w, 'owner', String(a.bill.id), reissueBody('Retail', [item(p2, { metal_rate: '200.00' }), item(p3, { metal_rate: '300.00' })])));
    const one = lockStatements(first);
    expect(one, 'one statement, never one piece at a time').toHaveLength(1);
    expect(placeholders(one[0]), 'P1 and P2 of the old bill, P2 and P3 of the new lines: three pieces').toBe(3);

    const second = w.world.spy.sent.length;
    await reissued(await reissueBill(w, 'owner', String(r.new_bill.id), reissueBody('Retail', [item(p1, { metal_rate: '100.00' })])));
    const two = lockStatements(second);
    expect(two).toHaveLength(1);
    expect(placeholders(two[0]), 'P2 and P3 of the old bill, P1 of the new line: three pieces').toBe(3);
  });
});

describe('T-D09 the matrix row of X10 (POST /v1/bills/:id/reissue: owner only)', () => {
  it('the route is registered through route() with the action of the row', () => {
    expect(w.world.app.routeTable.find((r) => r.action === 'fn:reissue_bill')).toMatchObject({ method: 'POST', url: '/v1/bills/:id/reissue', kind: 'matrix', roles: ['owner'], mustChange: false });
  });

  it('no session is 401, staff and a biller are 403 JV_FORBIDDEN, a user who must change the password is 403 JV_PASSWORD_CHANGE_REQUIRED, and none of them reads or writes the books', async () => {
    for (const [caller, status, code] of [['anon', 401, 'JV_UNAUTHENTICATED'], ['ended', 401, 'JV_UNAUTHENTICATED'], ['expired', 401, 'JV_SESSION_EXPIRED'], ['idle', 401, 'JV_SESSION_EXPIRED'], ['inactive', 401, 'JV_UNAUTHENTICATED'], ['staff', 403, 'JV_FORBIDDEN'], ['biller', 403, 'JV_FORBIDDEN'], ['must_change', 403, 'JV_PASSWORD_CHANGE_REQUIRED']] as const) {
      const c = await addCustomer(w);
      const a = await bill(c, '100.00');
      const from = w.world.spy.sent.length;
      const res = await reissueBill(w, caller, a.id, reissueBody('Retail', [line(a.piece, '90.00')]));
      expect(res.statusCode, caller).toBe(status);
      expect(codeOf(res), caller).toBe(code);
      await w.world.restore(caller);
      expect(w.world.spy.sqls().slice(from).some((s) => /\bFROM\s+(customers|bills|receipts|receipt_allocations|skus|sys_idempotency)\b/i.test(s) || /^INSERT\b/i.test(s.trim())), `${caller} caused a read or write of the books`).toBe(false);
      expect((await billRow(w, a.id)).status, caller).toBe('active');
    }
  });

  it('the owner is let in, and the bills name the owner', async () => {
    const c = await addCustomer(w);
    const a = await bill(c, '100.00');
    const r = await reissued(await reissueBill(w, 'owner', a.id, reissueBody('Retail', [line(a.piece, '90.00')])));
    expect(r.old_bill.cancelled_by).toBe(owner());
    expect(r.new_bill.created_by).toBe(owner());
  });
});

describe('L5 repeat-safety of reissue_bill (the clause of T-C05): the same Idempotency-Key makes one re-issue and answers the same', () => {
  it('the same key and body twice: one re-issue, the same answer with Idempotent-Replay: true and the same status; the second call writes nothing and takes no number', async () => {
    const c = await addCustomer(w);
    const a = await bill(c, '100.00', { payments: [upi('100.00')] });
    const key = newKey();
    const payload = reissueBody('Retail', [line(a.piece, '80.00')]);
    const first = await reissueBill(w, 'owner', a.id, payload, key);
    expect(first.statusCode).toBe(201);
    expect(first.headers['idempotent-replay']).toBeUndefined();
    const before = { trace: await trace(w), numbers: await numbers() };
    const again = await reissueBill(w, 'owner', a.id, payload, key);
    expect(again.statusCode).toBe(201);
    expect(again.headers['idempotent-replay']).toBe('true');
    expect(body(again)).toEqual(body(first));
    expect({ trace: await trace(w), numbers: await numbers() }).toEqual(before);
  });

  it('the same key with another body, or on another bill, is refused (422 on the header), and saves nothing', async () => {
    const c = await addCustomer(w);
    const [a, b] = [await bill(c, '100.00'), await bill(c, '200.00')];
    const key = newKey();
    await reissued(await reissueBill(w, 'owner', a.id, reissueBody('Retail', [line(a.piece, '80.00')]), key));
    const before = await trace(w);
    for (const [target, payload] of [[a.id, reissueBody('Retail', [line(a.piece, '70.00')])], [b.id, reissueBody('Retail', [line(a.piece, '80.00')])]] as const) {
      const res = await reissueBill(w, 'owner', target, payload, key);
      expect(refusal(res), JSON.stringify(payload)).toMatchObject({ status: 422, code: 'JV_INVALID_INPUT', field: 'Idempotency-Key' });
    }
    expect(await trace(w)).toEqual(before);
  });

  it('a missing or malformed Idempotency-Key is 422 on the header and claims nothing', async () => {
    const c = await addCustomer(w);
    const a = await bill(c, '100.00');
    const before = await trace(w);
    for (const key of [null, 'abc', '12345']) {
      const res = await reissueBill(w, 'owner', a.id, reissueBody('Retail', [line(a.piece, '80.00')]), key);
      expect(refusal(res), String(key)).toMatchObject({ status: 422, code: 'JV_INVALID_INPUT', field: 'Idempotency-Key' });
    }
    expect(await trace(w)).toEqual(before);
  });

  it('a refusal does not use the key up: the same key is the first call once the cause is gone', async () => {
    const c = await addCustomer(w);
    const a = await bill(c, '100.00');
    const other = await bill(await addCustomer(w), '50.00');
    const key = newKey();
    const payload = reissueBody('Retail', [line(other.piece, '50.00')]);
    await refused(a.id, payload, { status: 409, code: 'JV_PIECE_UNAVAILABLE' }, 'owner', key);
    await cancelled(await cancelBill(w, 'owner', other.id)); // the piece is in stock again
    const ok = await reissueBill(w, 'owner', a.id, payload, key);
    expect(ok.statusCode, ok.body).toBe(201);
    expect(ok.headers['idempotent-replay']).toBeUndefined();
  });
});

describe('X10 the answer is what the wire says (S3): money as text, rows in the sync form of the caller\'s role', () => {
  it('no JSON number in a money field of the answer or of the stored result; the keys are those of NODE-DESIGN 4.3 (and the allocations released); the stored result is the answer', async () => {
    const c = await addCustomer(w);
    const a = await bill(c, '300.00', { payments: [upi('300.00')] });
    const key = newKey();
    const res = await reissueBill(w, 'owner', a.id, reissueBody('Retail', [line(a.piece, '250.00')], { payments: [] }), key);
    const r = await reissued(res);
    for (const x of [r.old_bill.grand_total, r.new_bill.grand_total, r.new_bill.subtotal, r.items[0].item_total, r.allocations[0].amount, r.allocations[0].fine_grams, r.released_allocations[0].amount, r.advance_applied]) expect(typeof x).toBe('string');
    expect(Object.keys(r).sort()).toEqual(['advance_applied', 'allocations', 'items', 'new_bill', 'old_bill', 'receipts', 'released_allocations', 'warnings']);
    expect(Object.keys(r.new_bill).sort()).toEqual(Object.keys(r.old_bill).sort());
    expect(Object.keys(r.new_bill)).not.toContain('request_id');
    const [claim] = await rows(w, 'SELECT result FROM sys_idempotency WHERE request_id = ?', [key]);
    const stored = typeof claim.result === 'string' ? JSON.parse(claim.result) : claim.result;
    expect(stored).toEqual(r);
    expect(await ledgerOf(w, c)).toHaveLength(4);
  });
});
