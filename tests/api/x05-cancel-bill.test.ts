import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Body, type Designs, addDesigns, billBody, item, piece, pieceRow, postBill, saved } from './x01-support';
import { NO_BODY, addSoldPiece, billStates, cancelBill, cancelled, ledgerOf, receiptRow, trace, voidReceipt, voided } from './x04-support';
import { addFineAllocation, addFineBill, addSilver } from './x03-support';
import {
  type EditWorld,
  TODAY,
  WALKIN,
  addAllocation,
  addBill,
  addCancelledBill,
  addCustomer,
  addMoney,
  addOpeningBill,
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
  pendingAgrees,
  pendingByBill,
  receiptsOf,
  refusal,
  rows,
} from './x02-support';

// API25, X5 cancel_bill (POST /v1/bills/:id/cancel, owner; X5, K3, K5, IM5, I1, I3, D11, D23, L5, X0): a bill is cancelled, never deleted. T-B10 (the pieces return to In Stock, the bill leaves the
// totals, its allocations are released, its receipts stay and become an advance that is applied to the customer's other pending bills), the clause of T-B17 (a walk-in bill with money received is not
// cancelled until its receipts are voided), the clause of T-D09 (the matrix row), and the rest of X5: the answer, the order of work, the touches, the repeat of a key. The audit rows (T-D14) are in
// x05-audit.test.ts, the cancel across midnight and the year (T-B16) in x04-dates.test.ts, the two-session tests (T-C13) in x05-two-sessions.test.ts.
//
// The world is the scratch database of the other money tests (real routes, seeds, a clock fixed at 17 Oct 2026 10:00 UTC = 15:30 in Kolkata, "today" is 2026-10-17). Bills with pieces are made through
// the real create_bill route (one Per Piece line priced like the total, as in x01-payments.test.ts) or typed by SQL; receipts are typed by SQL or made through the payment routes. Every test makes its
// own customer. Expected figures are written in the test; the books are checked with V1 to V4 and I10 of the database half, which are another opinion.

let w: EditWorld;
let d: Designs;

beforeAll(async () => {
  w = await editWorld('x05cancel');
  d = await addDesigns(w);
}, 120_000);
afterAll(async () => {
  await w?.world.close();
}, 60_000);

const owner = () => w.world.fixtures.owner.userId;

/** The refusal is exactly this, and the call left no trace: no bill changed, no allocation released, no piece moved, no claim, no audit row, no stamp. */
async function refused(
  bill: string,
  payload: unknown,
  expected: { status: number; code: string; field?: string; details?: Record<string, unknown> },
  caller: 'owner' | 'biller' | 'staff' = 'owner',
  key = newKey(),
): Promise<Record<string, any>> {
  const before = await trace(w);
  const res = await cancelBill(w, caller, bill, payload, key);
  expect(refusal(res), res.body).toMatchObject({ status: expected.status, code: expected.code, ...(expected.field === undefined ? {} : { field: expected.field }) });
  if (expected.details) expect(body(res).error.details, res.body).toMatchObject(expected.details);
  expect(await trace(w), 'a refused cancel leaves no trace').toEqual(before);
  return body(res).error;
}

/** A bill of ONE Per Piece line priced `total` (a whole number of rupees), made by create_bill with `extra` merged into the body. Returns the bill, its piece and what create_bill made. */
async function sell(customer: string, total: string, extra: Body = {}) {
  const p = await piece(w, d.gold24pp, { retail: total });
  const made = await saved(await postBill(w, 'owner', billBody(customer, 'Retail', [item(p, { metal_rate: total })], extra)));
  return { id: String(made.bill.id), piece: p, made };
}
const upi = (amount: string) => ({ mode: 'UPI', amount });

// ------------------------------------------------------------------ T-B10

describe('T-B10 cancelling a bill returns its pieces to In Stock, leaves it out of the totals, releases its allocations and keeps its receipts as an advance that is applied to the other pending bills (K3, X5, Y6)', () => {
  it('a bill of 1,000 paid in full beside a bill of 600: the piece is In Stock again, the bill is out of billed and out of the ledger totals, the allocation is released, the receipt is still active and its 1,000 pays the other bill 600 and leaves an advance of 400', async () => {
    const c = await addCustomer(w);
    const a = await sell(c, '1000.00', { payments: [upi('1000.00')] });
    const b = await sell(c, '600.00');
    const r1 = String(a.made.receipts[0].id);
    expect(await figures(w, c)).toMatchObject({ outstanding: '600.00', advance: '0.00' });
    expect((await pieceRow(w, a.piece)).status).toBe('Sold');

    const res = await cancelBill(w, 'owner', a.id, { reason: 'the customer returned the goods' });
    const r = await cancelled(res);

    // the answer: the bill as it is now, the piece that went back, the allocation that was released, and the rows the rebalance made
    expect(r.bill).toMatchObject({ id: a.id, status: 'cancelled', cancel_reason: 'the customer returned the goods', cancelled_on: TODAY, cancelled_by: owner(), updated_by: owner(), grand_total: '1000.00' });
    expect(r.bill.cancelled_at).toBe(r.bill.updated_at);
    expect(r.skus.map((s) => [s.id, s.status, s.sold_bill_id])).toEqual([[a.piece, 'In Stock', null]]);
    expect(r.released_allocations.map((x) => [x.receipt_id, x.bill_id, x.amount])).toEqual([[r1, a.id, '1000.00']]);
    expect(r.released_allocations[0].released_at).toBe(r.bill.cancelled_at);
    expect(r.allocations.map((x) => [x.receipt_id, x.bill_id, x.amount, x.released_at])).toEqual([[r1, b.id, '600.00', null]]);

    // the tables: the piece is back in stock (and was not the other bill's), the bill is cancelled with the person, the day and the time of ONE reading
    const stored = await billRow(w, a.id);
    expect({ status: stored.status, cancel_reason: stored.cancel_reason, cancelled_on: stored.cancelled_on, cancelled_by: stored.cancelled_by }).toEqual({ status: 'cancelled', cancel_reason: 'the customer returned the goods', cancelled_on: TODAY, cancelled_by: owner() });
    expect(stored.cancelled_at).toBe(stored.updated_at);
    expect(await pieceRow(w, a.piece)).toMatchObject({ status: 'In Stock', sold_bill_id: null, updated_by: owner() });
    expect((await pieceRow(w, b.piece)).status, 'the other bill\'s piece is untouched').toBe('Sold');

    // the money: the receipt stays active, its allocation to the cancelled bill is released (not counted, not open), the advance went to the other bill
    expect((await receiptRow(w, r1)).status).toBe('active');
    expect((await allocationsOf(w, c)).map((x) => [x.bill_id, x.amount, x.released_at !== null])).toEqual([[a.id, '1000.00', true], [b.id, '600.00', false]]);
    expect(await billStates(w, c)).toMatchObject({
      [a.id]: { status: 'cancelled', received: '0.00', pending: '0.00', payment_status: 'Cancelled' },
      [b.id]: { status: 'active', received: '600.00', pending: '0.00', payment_status: 'Paid' },
    });
    expect(await figures(w, c)).toMatchObject({ outstanding: '0.00', advance: '400.00' });
    await pendingAgrees(w, c);
    await i10Holds(w, c);

    // the ledger: the bill, the payment, and the cancellation on its own day as a credit of the bill; the running balance ends at billed 600 - received 1,000
    const ledger = await ledgerOf(w, c);
    expect(ledger.map((x) => [x.kind, x.debit, x.credit])).toEqual([
      ['Invoice', '1000.00', '0.00'],
      ['Payment', '0.00', '1000.00'],
      ['Invoice', '600.00', '0.00'],
      ['Cancellation', '0.00', '1000.00'],
    ]);
    expect(ledger[ledger.length - 1]).toMatchObject({ entry_date: TODAY, balance: '-400.00' });
  });

  it('the piece can be sold again at once: it is In Stock with no bill, so create_bill takes it', async () => {
    const c = await addCustomer(w);
    const a = await sell(c, '700.00');
    await cancelled(await cancelBill(w, 'owner', a.id));
    const again = await postBill(w, 'owner', billBody(c, 'Retail', [item(a.piece, { metal_rate: '700.00' })]));
    expect(again.statusCode, again.body).toBe(201);
    expect((await pieceRow(w, a.piece)).status).toBe('Sold');
    expect((await pieceRow(w, a.piece)).sold_bill_id).toBe(String(body(again).bill.id));
  });

  it('a bill of three pieces: all three go back, in the answer in the order the database holds them', async () => {
    const c = await addCustomer(w);
    const [p1, p2, p3] = [await piece(w, d.gold24pp, { retail: '100.00' }), await piece(w, d.gold24pp, { retail: '200.00' }), await piece(w, d.gold24pp, { retail: '300.00' })];
    const made = await saved(await postBill(w, 'owner', billBody(c, 'Retail', [item(p1, { metal_rate: '100.00' }), item(p2, { metal_rate: '200.00' }), item(p3, { metal_rate: '300.00' })])));
    const r = await cancelled(await cancelBill(w, 'owner', String(made.bill.id)));
    expect(new Set(r.skus.map((s) => s.id))).toEqual(new Set([p1, p2, p3]));
    for (const s of r.skus) expect([s.status, s.sold_bill_id]).toEqual(['In Stock', null]);
    for (const p of [p1, p2, p3]) expect((await pieceRow(w, p)).status).toBe('In Stock');
    expect(r.released_allocations).toEqual([]);
    expect(r.allocations).toEqual([]);
  });

  it('a bill nobody paid: only the totals change; the customer\'s advance is as it was', async () => {
    const c = await addCustomer(w);
    const a = await sell(c, '250.00');
    await sell(c, '300.00');
    expect(await figures(w, c)).toMatchObject({ outstanding: '550.00', advance: '0.00' });
    const r = await cancelled(await cancelBill(w, 'owner', a.id));
    expect(r.released_allocations).toEqual([]);
    expect(r.allocations).toEqual([]);
    expect(await figures(w, c)).toMatchObject({ outstanding: '300.00', advance: '0.00' });
    await i10Holds(w, c);
  });

  it('the only bill, paid: the receipt becomes an advance of the same amount and nothing else is pending', async () => {
    const c = await addCustomer(w);
    const a = await sell(c, '1000.00', { payments: [upi('1000.00')] });
    const r = await cancelled(await cancelBill(w, 'owner', a.id));
    expect(r.allocations).toEqual([]);
    expect(await figures(w, c)).toMatchObject({ outstanding: '0.00', advance: '1000.00' });
    expect((await receiptRow(w, String(a.made.receipts[0].id))).status).toBe('active');
    await i10Holds(w, c);
  });

  it('two older bills pending and a paid bill cancelled: the freed money goes to the OLDEST bill first and then the next, from the oldest receipt first (Y3, Y6)', async () => {
    const c = await addCustomer(w);
    const b1 = await addBill(w, c, '500.00', '2026-10-01');
    const b2 = await addBill(w, c, '500.00', '2026-10-03');
    const a = await addBill(w, c, '1000.00', '2026-10-02');
    const r1 = await addMoney(w, c, '600.00', '2026-10-04');
    const r2 = await addMoney(w, c, '400.00', '2026-10-05');
    await addAllocation(w, r1, a, c, '600.00');
    await addAllocation(w, r2, a, c, '400.00');
    const r = await cancelled(await cancelBill(w, 'owner', a));
    expect(r.released_allocations.map((x) => [x.receipt_id, x.amount])).toEqual([[r1, '600.00'], [r2, '400.00']]);
    expect(r.allocations.map((x) => [x.receipt_id, x.bill_id, x.amount])).toEqual([
      [r1, b1, '500.00'],
      [r1, b2, '100.00'],
      [r2, b2, '400.00'],
    ]);
    expect(await pendingByBill(w, c)).toMatchObject({ [b1]: '0.00', [b2]: '0.00', [a]: '0.00' });
    expect(await figures(w, c)).toMatchObject({ outstanding: '0.00', advance: '0.00' });
    await i10Holds(w, c);
  });

  it('a receipt that also paid another bill: only what it spent on the cancelled bill is freed', async () => {
    const c = await addCustomer(w);
    const a = await addBill(w, c, '300.00', '2026-10-01');
    const b = await addBill(w, c, '300.00', '2026-10-02');
    const r1 = await addMoney(w, c, '500.00', '2026-10-03');
    await addAllocation(w, r1, a, c, '300.00');
    await addAllocation(w, r1, b, c, '200.00');
    const r = await cancelled(await cancelBill(w, 'owner', a));
    expect(r.allocations.map((x) => [x.bill_id, x.amount])).toEqual([[b, '100.00']]);
    expect(await pendingByBill(w, c)).toMatchObject({ [b]: '0.00' });
    expect(await figures(w, c)).toMatchObject({ outstanding: '0.00', advance: '200.00' });
    await i10Holds(w, c);
  });

  it('EVERY open allocation is released, also the one of a voided receipt (I3: no allocation that is not released points to a cancelled bill); the voided receipt stays voided and adds nothing to the advance', async () => {
    const c = await addCustomer(w);
    const a = await addBill(w, c, '500.00', '2026-10-01');
    const r1 = await addMoney(w, c, '300.00', '2026-10-02');
    const r2 = await addMoney(w, c, '200.00', '2026-10-03');
    await addAllocation(w, r1, a, c, '300.00');
    await addAllocation(w, r2, a, c, '200.00');
    await voided(await voidReceipt(w, 'owner', r2));
    expect((await billStates(w, c))[a]).toMatchObject({ received: '300.00', pending: '200.00' });
    const r = await cancelled(await cancelBill(w, 'owner', a));
    expect(r.released_allocations.map((x) => [x.receipt_id, x.amount]).sort()).toEqual([[r1, '300.00'], [r2, '200.00']].sort());
    const open = await rows(w, 'SELECT a.id FROM receipt_allocations a JOIN bills b ON b.id = a.bill_id WHERE b.customer_id = ? AND b.status = ? AND a.released_at IS NULL', [c, 'cancelled']);
    expect(open, 'no unreleased allocation points to a cancelled bill').toEqual([]);
    expect((await receiptRow(w, r2)).status).toBe('voided');
    expect(await figures(w, c)).toMatchObject({ outstanding: '0.00', advance: '300.00' });
    await i10Holds(w, c);
  });

  it('silver: a bill that owes 10 g and was settled in silver; cancelled, the silver is a fine advance that is applied to the other bill\'s fine, the rest stays as a fine advance', async () => {
    const c = await addCustomer(w);
    const a = await addFineBill(w, c, '100.00', '10.000', '2026-10-01');
    const b = await addFineBill(w, c, '100.00', '4.000', '2026-10-02');
    const s1 = await addSilver(w, c, '10.000', '2026-10-03');
    await addFineAllocation(w, s1, a, c, '10.000');
    const r = await cancelled(await cancelBill(w, 'owner', a));
    expect(r.released_allocations.map((x) => [x.receipt_id, x.fine_grams, x.amount])).toEqual([[s1, '10.000', '0.00']]);
    expect(r.allocations.map((x) => [x.receipt_id, x.bill_id, x.fine_grams, x.amount])).toEqual([[s1, b, '4.000', '0.00']]);
    expect((await billStates(w, c))[b]).toMatchObject({ fine_pending: '0.000', pending: '100.00' });
    expect(await figures(w, c)).toMatchObject({ fine_outstanding: '0.000', fine_advance: '6.000', outstanding: '100.00' });
    await i10Holds(w, c);
  });

  it('an opening-balance bill may be cancelled (IM5): no pieces, its receipts stay, the opening dues leave the totals', async () => {
    const c = await addCustomer(w);
    const ob = await addOpeningBill(w, c, '700.00');
    const r1 = await addMoney(w, c, '200.00', '2026-04-02');
    await addAllocation(w, r1, ob, c, '200.00');
    const r = await cancelled(await cancelBill(w, 'owner', ob, { reason: 'the opening figure was wrong' }));
    expect(r.skus).toEqual([]);
    expect(r.bill).toMatchObject({ doc_type: 'opening_balance', status: 'cancelled' });
    expect(r.released_allocations.map((x) => [x.receipt_id, x.amount])).toEqual([[r1, '200.00']]);
    expect(await figures(w, c)).toMatchObject({ outstanding: '0.00', advance: '200.00' });
    const ledger = await ledgerOf(w, c);
    expect(ledger.map((x) => x.kind)).toEqual(['Opening', 'Payment', 'Cancellation']);
  });

  it('K3: only the pieces whose sold_bill_id is THIS bill go back; a line whose piece is on another bill or already in stock is left alone', async () => {
    const c = await addCustomer(w);
    const a = await addBill(w, c, '300.00', '2026-10-01');
    const other = await addBill(w, c, '100.00', '2026-10-02');
    const mine = await addSoldPiece(w, d.gold24pp, a, 1);
    const elsewhere = await addSoldPiece(w, d.gold24pp, other, 2, {}); // sold on `other`
    await w.world.sql.query('UPDATE bill_items SET bill_id = ?, line_no = 2 WHERE sku_id = ?', [a, elsewhere]); // a line of `a` that names a piece that is on `other`
    const r = await cancelled(await cancelBill(w, 'owner', a));
    expect(r.skus.map((s) => s.id)).toEqual([mine]);
    expect((await pieceRow(w, mine)).status).toBe('In Stock');
    expect(await pieceRow(w, elsewhere)).toMatchObject({ status: 'Sold', sold_bill_id: other });
  });

  it('a cancelled bill\'s receipts stay in the ledger and can be voided afterwards (the advance the cancel made goes with them)', async () => {
    const c = await addCustomer(w);
    const a = await sell(c, '1000.00', { payments: [upi('1000.00')] });
    await cancelled(await cancelBill(w, 'owner', a.id));
    expect(await figures(w, c)).toMatchObject({ advance: '1000.00' });
    await voided(await voidReceipt(w, 'owner', String(a.made.receipts[0].id)));
    expect(await figures(w, c)).toMatchObject({ advance: '0.00', outstanding: '0.00' });
    await i10Holds(w, c);
  });
});

// ------------------------------------------------------------------ the clause of T-B17

describe('T-B17 (the clause of X5, K5) a walk-in bill with money received cannot be cancelled until its receipts are voided; the walk-in never holds an advance', () => {
  it('a walk-in bill with a payment: JV_NOT_ALLOWED and nothing changes; after the receipt is voided (its own day, with a reason) the bill can be cancelled, and the walk-in holds no advance at any point', async () => {
    const a = await addBill(w, WALKIN, '600.00', '2026-10-01');
    await addSoldPiece(w, d.gold24pp, a, 1);
    const r = await addMoney(w, WALKIN, '600.00', '2026-10-02');
    await addAllocation(w, r, a, WALKIN, '600.00');
    const error = await refused(a, { reason: 'the customer came back' }, { status: 409, code: 'JV_NOT_ALLOWED' });
    expect(error.message).toMatch(/void/i);
    expect((await billRow(w, a)).status).toBe('active');
    await voided(await voidReceipt(w, 'owner', r, { reason: 'the money goes back to the customer' }));
    const done = await cancelled(await cancelBill(w, 'owner', a, { reason: 'the customer came back' }));
    expect(done.bill.status).toBe('cancelled');
    expect(done.skus).toHaveLength(1);
    expect(done.released_allocations.map((x) => [x.receipt_id, x.amount])).toEqual([[r, '600.00']]); // the voided receipt's allocation is released too
    expect(done.allocations).toEqual([]);
    const books = await figures(w, WALKIN);
    expect([books.advance, books.fine_advance]).toEqual(['0.00', '0.000']);
  });

  it('a walk-in bill with silver received is refused the same way; one with nothing received, or whose only allocation is a voided receipt\'s, is cancelled', async () => {
    const withSilver = await addFineBill(w, WALKIN, '100.00', '5.000', '2026-10-01');
    const s = await addSilver(w, WALKIN, '2.000', '2026-10-02');
    await addFineAllocation(w, s, withSilver, WALKIN, '2.000');
    await refused(withSilver, { reason: 'wrong bill' }, { status: 409, code: 'JV_NOT_ALLOWED' });
    const unpaid = await addBill(w, WALKIN, '100.00', '2026-10-03');
    expect((await cancelled(await cancelBill(w, 'owner', unpaid))).released_allocations).toEqual([]);
    const voidedOnly = await addBill(w, WALKIN, '100.00', '2026-10-04');
    const r = await addMoney(w, WALKIN, '100.00', '2026-10-05', { status: 'voided', void_reason: 'twice', voided_at: '2026-10-06 05:00:00.000000', voided_on: '2026-10-06', voided_by: owner() });
    await addAllocation(w, r, voidedOnly, WALKIN, '100.00');
    expect((await cancelled(await cancelBill(w, 'owner', voidedOnly))).released_allocations.map((x) => x.receipt_id)).toEqual([r]);
  });
});

// ------------------------------------------------------------------ the rest of X5

describe('X5 what is refused, and that a refusal leaves no trace', () => {
  it('a second cancel of the same bill (another key) is 409 JV_BILL_CANCELLED and changes nothing; never a JV_BUSY', async () => {
    const c = await addCustomer(w);
    const a = await sell(c, '100.00');
    await cancelled(await cancelBill(w, 'owner', a.id, { reason: 'first' }));
    const stored = await billRow(w, a.id);
    await refused(a.id, { reason: 'second' }, { status: 409, code: 'JV_BILL_CANCELLED' });
    expect(await billRow(w, a.id)).toEqual(stored);
  });

  it('a bill that does not exist is 404, a path that is not an id is 422 on id', async () => {
    await refused('00000000-0000-4000-8000-0000000000aa', { reason: 'never made' }, { status: 404, code: 'JV_NOT_FOUND' });
    const res = await cancelBill(w, 'owner', 'not-an-id', { reason: 'never made' });
    expect(refusal(res)).toMatchObject({ status: 422, code: 'JV_INVALID_INPUT', field: 'id' });
  });

  it('the reason is required and is 3 to 500 characters once trimmed; anything else in the body is refused; nothing is saved', async () => {
    const c = await addCustomer(w);
    const a = await sell(c, '100.00');
    await refused(a.id, NO_BODY, { status: 422, code: 'JV_INVALID_INPUT', field: 'body' });
    for (const payload of [{}, { reason: '' }, { reason: 'ab' }, { reason: '  ab  ' }, { reason: '   ' }, { reason: 'x'.repeat(501) }, { reason: 12345 }, { reason: null }]) {
      await refused(a.id, payload, { status: 422, code: 'JV_INVALID_INPUT', field: 'reason' });
    }
    await refused(a.id, { reason: 'fine', replacement: 'x' }, { status: 422, code: 'JV_INVALID_INPUT' });
    const ok = await cancelBill(w, 'owner', a.id, { reason: '  abc  ' });
    expect(ok.statusCode, ok.body).toBe(200);
    expect((await billRow(w, a.id)).cancel_reason).toBe('abc');
    const long = await addBill(w, c, '10.00', '2026-10-02');
    expect((await cancelBill(w, 'owner', long, { reason: 'y'.repeat(500) })).statusCode).toBe(200);
  });

  it('an archived customer: JV_CUSTOMER_ARCHIVED (a cancel would leave an advance on a customer who is archived only while they hold nothing, K4); a bill already cancelled is JV_BILL_CANCELLED first', async () => {
    const c = await addCustomer(w);
    const a = await addBill(w, c, '100.00', '2026-10-01');
    const done = await addCancelledBill(w, c, '50.00', '2026-10-02');
    await w.world.sql.query('UPDATE customers SET archived_at = ? WHERE id = ?', ['2026-10-03 05:00:00.000000', c]);
    await refused(a, { reason: 'wrong customer' }, { status: 409, code: 'JV_CUSTOMER_ARCHIVED' });
    await refused(done, { reason: 'again' }, { status: 409, code: 'JV_BILL_CANCELLED' });
    await w.world.sql.query('UPDATE customers SET archived_at = NULL WHERE id = ?', [c]);
    expect((await cancelBill(w, 'owner', a, { reason: 'wrong customer' })).statusCode).toBe(200);
  });
});

describe('D23 touches: the bill, the customer and the bills that received the freed money carry the stamp of the cancel; no other bill does', () => {
  it('stamps come from the one reading of the clock; an unrelated paid bill of the same customer keeps its stamp', async () => {
    const c = await addCustomer(w);
    const a = await addBill(w, c, '100.00', '2026-10-01');
    const pending = await addBill(w, c, '60.00', '2026-10-02');
    const unrelated = await addBill(w, c, '40.00', '2026-10-03');
    const r1 = await addMoney(w, c, '100.00', '2026-10-04');
    const r2 = await addMoney(w, c, '40.00', '2026-10-04');
    await addAllocation(w, r1, a, c, '100.00');
    await addAllocation(w, r2, unrelated, c, '40.00');
    const before = { unrelated: (await billRow(w, unrelated)).updated_at, pending: (await billRow(w, pending)).updated_at, customer: (await customerRow(w, c)).updated_at };
    const r = await cancelled(await cancelBill(w, 'owner', a));
    const at = (await billRow(w, a)).cancelled_at as string;
    expect((await billRow(w, a)).updated_at).toBe(at);
    expect((await billRow(w, pending)).updated_at, 'the bill that received the freed money').toBe(at);
    expect((await customerRow(w, c)).updated_at).toBe(at);
    expect((await billRow(w, unrelated)).updated_at).toBe(before.unrelated);
    expect(at > before.pending).toBe(true);
    expect((await customerRow(w, c)).updated_at).not.toBe(before.customer);
    const released = await allocationsOf(w, c);
    expect(released.find((x) => x.bill_id === a)?.released_at).toBe(at);
    expect(released.find((x) => x.bill_id === a)?.updated_at, 'a released allocation is stamped too, so the screens polling by updated_at see it').toBe(at);
    expect(r.allocations.map((x) => x.created_at)).toEqual([r.bill.updated_at]);
  });
});

describe('D23 touches (a cancel with nothing to rebalance): the customer still carries the stamp of the call, because the cancel changed their figures', () => {
  it('an unpaid single bill is cancelled: no allocation is made, and the customer\'s updated_at is the stamp of the cancel, so a screen polling by updated_at re-reads the balances', async () => {
    const c = await addCustomer(w);
    const a = await addBill(w, c, '100.00', '2026-10-01');
    const before = (await customerRow(w, c)).updated_at;
    const r = await cancelled(await cancelBill(w, 'owner', a));
    expect(r.allocations).toEqual([]);
    const at = (await billRow(w, a)).cancelled_at;
    expect((await customerRow(w, c)).updated_at).toBe(at);
    expect(at).not.toBe(before);
  });
});

describe('X0 the order of work inside the transaction, as the statements say it', () => {
  it('claim first, the bill found, the customer locked, the bill read again FOR UPDATE, the open allocations and the lines read, the state read ONCE, the pieces locked by ONE statement, then the writes; no lock after a write; no number', async () => {
    const c = await addCustomer(w);
    const a = await sell(c, '1000.00', { payments: [upi('1000.00')] });
    await sell(c, '300.00');
    const from = w.world.spy.sent.length;
    const res = await cancelBill(w, 'owner', a.id);
    expect(res.statusCode, res.body).toBe(200);
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
    const cancel = at(/^UPDATE bills SET status = \?/);
    const release = at(/^UPDATE receipt_allocations SET released_at = \?/);
    const back = at(/^UPDATE skus SET status = \?/);
    const touchCustomer = at(/^UPDATE customers SET updated_at = \?/);
    const store = at(/^UPDATE sys_idempotency SET result = \?/);
    expect(claim, 'the claim is the first statement of the transaction').toBe(Math.min(...sqls.map((s, i) => (/^INSERT INTO sys_idempotency\b/.test(s) ? i : 1e9))));
    expect(find).toBeGreaterThan(claim);
    expect(customer).toBeGreaterThan(find);
    expect(again).toBeGreaterThan(customer);
    expect(open, 'the open allocations are read before the state, so before the test hook').toBeGreaterThan(again);
    expect(lines).toBeGreaterThan(again);
    expect(state).toBeGreaterThan(Math.max(open, lines));
    expect(pieces, 'the pieces are locked after the state read and the customer lock (X0 items 3 and 5)').toBeGreaterThan(state);
    expect(cancel).toBeGreaterThan(pieces);
    expect(release).toBeGreaterThan(cancel);
    expect(back).toBeGreaterThan(cancel);
    expect(touchCustomer).toBeGreaterThan(Math.min(release, back));
    expect(store).toBeGreaterThan(touchCustomer);
    expect(sqls.filter((s) => /WHERE b\.customer_id = \? AND b\.status = 'active'/.test(s)), 'the state of the customer is read once').toHaveLength(1);
    expect(sqls.filter((s) => /FROM skus\b/.test(s) && /FOR UPDATE/.test(s)), 'the pieces are locked by one statement, never one at a time').toHaveLength(1);
    expect(sqls.slice(cancel).filter((s) => /FOR UPDATE/.test(s)), 'no lock is taken after the first write').toEqual([]);
    expect(sqls.some((s) => /sys_counters/.test(s)), 'a cancel takes no number').toBe(false);
    expect(sqls.some((s) => /^(DELETE|REPLACE|TRUNCATE)\b/i.test(s)), 'nothing is deleted').toBe(false);
    expect(sqls.some((s) => /WHERE\s+sold_bill_id\s*=/.test(s)), 'the pieces come back by the ids that were locked, never by WHERE sold_bill_id = ?').toBe(false);
  });
});

describe('T-D09 the matrix row of X5 (POST /v1/bills/:id/cancel: owner only)', () => {
  it('the route is registered through route() with the action of the row', () => {
    expect(w.world.app.routeTable.find((r) => r.action === 'fn:cancel_bill')).toMatchObject({ method: 'POST', url: '/v1/bills/:id/cancel', kind: 'matrix', roles: ['owner'], mustChange: false });
  });

  it('no session is 401, staff and a biller are 403 JV_FORBIDDEN, a user who must change the password is 403 JV_PASSWORD_CHANGE_REQUIRED, and none of them reads or writes the books', async () => {
    for (const [caller, status, code] of [['anon', 401, 'JV_UNAUTHENTICATED'], ['ended', 401, 'JV_UNAUTHENTICATED'], ['expired', 401, 'JV_SESSION_EXPIRED'], ['idle', 401, 'JV_SESSION_EXPIRED'], ['inactive', 401, 'JV_UNAUTHENTICATED'], ['staff', 403, 'JV_FORBIDDEN'], ['biller', 403, 'JV_FORBIDDEN'], ['must_change', 403, 'JV_PASSWORD_CHANGE_REQUIRED']] as const) {
      const c = await addCustomer(w);
      const a = await addBill(w, c, '100.00', '2026-10-01');
      const from = w.world.spy.sent.length;
      const res = await cancelBill(w, caller, a);
      expect(res.statusCode, caller).toBe(status);
      expect(codeOf(res), caller).toBe(code);
      await w.world.restore(caller);
      expect(w.world.spy.sqls().slice(from).some((s) => /\bFROM\s+(customers|bills|receipts|receipt_allocations|skus|sys_idempotency)\b/i.test(s) || /^INSERT\b/i.test(s.trim())), `${caller} caused a read or write of the books`).toBe(false);
      expect((await billRow(w, a)).status, caller).toBe('active');
    }
  });

  it('the owner is let in, and the bill names the owner as the person who cancelled it', async () => {
    const c = await addCustomer(w);
    const a = await addBill(w, c, '100.00', '2026-10-01');
    const r = await cancelled(await cancelBill(w, 'owner', a));
    expect(r.bill.cancelled_by).toBe(owner());
  });
});

describe('L5 repeat-safety of cancel_bill (the clause of T-C05): the same Idempotency-Key makes one cancel and answers the same', () => {
  it('the same key and body twice: one cancel, the same answer with Idempotent-Replay: true and the same status; the second call writes nothing', async () => {
    const c = await addCustomer(w);
    const a = await sell(c, '100.00', { payments: [upi('100.00')] });
    const key = newKey();
    const first = await cancelBill(w, 'owner', a.id, { reason: 'wrong customer' }, key);
    expect(first.statusCode).toBe(200);
    expect(first.headers['idempotent-replay']).toBeUndefined();
    const before = await trace(w);
    const again = await cancelBill(w, 'owner', a.id, { reason: 'wrong customer' }, key);
    expect(again.statusCode).toBe(200);
    expect(again.headers['idempotent-replay']).toBe('true');
    expect(body(again)).toEqual(body(first));
    expect(await trace(w)).toEqual(before);
  });

  it('the same key with another reason or on another bill is refused (422 on the header), and saves nothing', async () => {
    const c = await addCustomer(w);
    const [a, b] = [await addBill(w, c, '10.00', '2026-10-01'), await addBill(w, c, '10.00', '2026-10-02')];
    const key = newKey();
    await cancelled(await cancelBill(w, 'owner', a, { reason: 'first reason' }, key));
    const before = await trace(w);
    for (const [bill, payload] of [[a, { reason: 'another reason' }], [b, { reason: 'first reason' }]] as const) {
      const res = await cancelBill(w, 'owner', bill, payload, key);
      expect(refusal(res), JSON.stringify(payload)).toMatchObject({ status: 422, code: 'JV_INVALID_INPUT', field: 'Idempotency-Key' });
    }
    expect(await trace(w)).toEqual(before);
  });

  it('a missing or malformed Idempotency-Key is 422 on the header and claims nothing', async () => {
    const c = await addCustomer(w);
    const a = await addBill(w, c, '10.00', '2026-10-01');
    const before = await trace(w);
    for (const key of [null, 'abc', '12345']) {
      const res = await cancelBill(w, 'owner', a, { reason: 'wrong customer' }, key);
      expect(refusal(res), String(key)).toMatchObject({ status: 422, code: 'JV_INVALID_INPUT', field: 'Idempotency-Key' });
    }
    expect(await trace(w)).toEqual(before);
  });

  it('a refusal does not use the key up: the same key is the first call once the cause is gone', async () => {
    const a = await addBill(w, WALKIN, '100.00', '2026-10-01');
    const r = await addMoney(w, WALKIN, '100.00', '2026-10-02');
    await addAllocation(w, r, a, WALKIN, '100.00');
    const key = newKey();
    await refused(a, { reason: 'wrong customer' }, { status: 409, code: 'JV_NOT_ALLOWED' }, 'owner', key);
    await voided(await voidReceipt(w, 'owner', r));
    const ok = await cancelBill(w, 'owner', a, { reason: 'wrong customer' }, key);
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.headers['idempotent-replay']).toBeUndefined();
  });
});

describe('X5 the answer is what the wire says (S3): money as text, rows in the sync form of the caller\'s role', () => {
  it('no JSON number in a money field of the answer or of the stored result; the keys are those of the sync reads; the stored result is the answer', async () => {
    const c = await addCustomer(w);
    const a = await sell(c, '300.00', { payments: [upi('300.00')] });
    await sell(c, '100.00');
    const key = newKey();
    const res = await cancelBill(w, 'owner', a.id, { reason: 'wrong customer' }, key);
    const r = await cancelled(res);
    for (const x of [r.bill.grand_total, r.bill.subtotal, r.released_allocations[0].amount, r.released_allocations[0].fine_grams, r.allocations[0].amount, r.skus[0].gross_weight]) expect(typeof x).toBe('string');
    expect(Object.keys(r).sort()).toEqual(['allocations', 'bill', 'released_allocations', 'skus']);
    expect(Object.keys(r.bill).sort()).toEqual(['additional_charges', 'bill_date', 'bill_no', 'cancel_reason', 'cancelled_at', 'cancelled_by', 'cancelled_on', 'cash_override_reason', 'created_at', 'created_by', 'customer_id', 'discount', 'doc_type', 'fine_weight_due', 'gst_amount', 'gst_percent', 'grand_total', 'id', 'notes', 'pricing_version', 'reissue_of', 'round_off', 'sale_type', 'status', 'subtotal', 'updated_at', 'updated_by'].sort());
    expect(Object.keys(r.skus[0])).not.toContain('original_net_weight'); // the original weight is the owner's own read (sku-private), never part of a piece row
    const [claim] = await rows(w, 'SELECT result FROM sys_idempotency WHERE request_id = ?', [key]);
    const stored = typeof claim.result === 'string' ? JSON.parse(claim.result) : claim.result;
    expect(stored).toEqual(r);
    expect(errorField(res)).toBeUndefined();
    expect((await receiptsOf(w, c)).length).toBe(1);
  });
});
