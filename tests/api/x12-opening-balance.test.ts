import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { limits } from '../../src/limits';
import { timestampToWire } from '../../src/wire/format';
import { finePendingByBill } from './x03-support';
import { billStates, cancelBill, cancelled, dayRow, ledgerOf, voidReceipt, voided } from './x04-support';
import { CUT_OVER, addOpening, billsOf, footprint, lineCount, numberOf, opened, opening, openingBillsOf, openingCounter, openingReceiptsOf, salesBillsOf, totalsOf } from './x12-support';
import {
  type EditWorld,
  TODAY,
  WALKIN,
  addBill,
  addCustomer,
  allocationsOf,
  billRow,
  body,
  codeOf,
  customerRow,
  editWorld,
  i10Holds,
  newKey,
  paid,
  pay,
  pendingAgrees,
  pendingByBill,
  receiptsOf,
  refusal,
} from './x02-support';

// API27, X12 add_opening_balance (POST /v1/customers/:id/opening-balance, owner; X12, IM5, D15, K5, Y6, Y9, D13, D23, L5, X0). T-B21 (dues and fine become an OB- bill, an advance an is_opening receipt;
// they are paid first, net off, and are left out of sales, daily cash and the cash limit; a wrong figure is fixed by cancelling and adding a new one; one call with a money and a silver advance saves
// two receipts; voiding an opening advance leaves V4 unchanged), and the clauses of T-B17 (the walk-in takes no opening advance), T-A09 (opening-balance amounts), T-D09 (the matrix row) and the rest of
// X12: the answer, the order of work, the touches, the repeat of a key. The audit rows (T-D14) are in x12-audit.test.ts, the two-session test in x12-two-sessions.test.ts, the clause of T-C16 (after an
// import an X12 call and a create_bill keep I5 and I10) in x12-import.test.ts.
//
// The world is the scratch database of the other money tests (real routes, seeds, a clock fixed at 17 Oct 2026 10:00 UTC = 15:30 in Kolkata, "today" is 2026-10-17). Every test makes its own customer
// (the walk-in is one row for all the tests; its tests compare before and after). Bills and receipts of a customer's earlier history are typed in by SQL, with stamps earlier than the API clock's.
// Expected figures are written in the test, never read back from the code under test; the books are checked with V1 to V4 and I10 of the database half, which are another opinion.

let w: EditWorld;

beforeAll(async () => {
  w = await editWorld('x12open');
}, 120_000);
afterAll(async () => {
  await w?.world.close();
}, 60_000);

const owner = () => w.world.fixtures.owner.userId;

/** The refusal is exactly this, and the call left no trace: no bill, no receipt, no allocation, no claim, no audit row, no number, no stamp (the claim rolls back with the rest). */
async function refused(
  customer: string,
  payload: unknown,
  expected: { status: number; code: string; field?: string; details?: Record<string, unknown> },
  caller: 'owner' | 'biller' | 'staff' = 'owner',
  key = newKey(),
): Promise<Record<string, any>> {
  const before = await footprint(w);
  const res = await addOpening(w, caller, customer, payload, key);
  expect(refusal(res), res.body).toMatchObject({ status: expected.status, code: expected.code, ...(expected.field === undefined ? {} : { field: expected.field }) });
  if (expected.details) expect(body(res).error.details, res.body).toMatchObject(expected.details);
  expect(await footprint(w), 'a refused call leaves no trace').toEqual(before);
  return body(res).error;
}

// ------------------------------------------------------------------ T-B21

describe('T-B21 opening balances: dues and fine become an OB- bill, an advance an is_opening receipt (D15, X12, IM5)', () => {
  it('dues of 1,500.50 and fine of 2.500 g become ONE opening_balance bill: number OB-nnnn, no lines, dated as_of, grand_total and fine_weight_due set to the figures; nothing else is made', async () => {
    const c = await addCustomer(w, { customer_type: 'Wholesale' });
    const res = await addOpening(w, 'owner', c, opening({ dues: '1500.50', fine_due: '2.500' }));
    const r = await opened(res);
    expect(r.receipts).toEqual([]);
    expect(r.allocations).toEqual([]);
    expect(r.bill).toMatchObject({
      customer_id: c,
      doc_type: 'opening_balance',
      status: 'active',
      bill_date: CUT_OVER,
      sale_type: 'Wholesale', // the customer's own type, as the import writes it
      subtotal: '0.00',
      discount: '0.00',
      additional_charges: '0.00',
      gst_percent: '0.00',
      gst_amount: '0.00',
      grand_total: '1500.50',
      round_off: '0.00',
      fine_weight_due: '2.500',
      pricing_version: 1,
      reissue_of: null,
      cancel_reason: null,
      notes: null,
      cash_override_reason: null,
      created_by: owner(),
      updated_by: owner(),
    });
    expect(r.bill?.bill_no).toMatch(/^OB-\d{4,}$/);

    // the tables: one bill, no lines, no receipt, no allocation; the figures of V1 and V2 of the database half
    const stored = await billsOf(w, c);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ id: r.bill?.id, bill_no: r.bill?.bill_no, doc_type: 'opening_balance', grand_total: '1500.50', fine_weight_due: '2.500', import_batch_id: null });
    expect(await lineCount(w, String(r.bill?.id))).toBe(0);
    expect(await receiptsOf(w, c)).toEqual([]);
    expect(await allocationsOf(w, c)).toEqual([]);
    expect((await billStates(w, c))[String(r.bill?.id)]).toMatchObject({ status: 'active', received: '0.00', pending: '1500.50', fine_pending: '2.500', payment_status: 'Pending' });
    expect(await totalsOf(w, c)).toMatchObject({ billed: '1500.50', outstanding: '1500.50', advance: '0.00', fine_billed: '2.500', fine_outstanding: '2.500', fine_advance: '0.000' });
    await pendingAgrees(w, c);
    await i10Holds(w, c);
  });

  it('dues alone and fine due alone are each enough for a bill: dues 300 gives a bill with no silver, fine 4 g alone gives a bill of 0.00 that owes 4 g', async () => {
    const [a, b] = [await addCustomer(w), await addCustomer(w)];
    const moneyOnly = await opened(await addOpening(w, 'owner', a, opening({ dues: '300.00' })));
    expect(moneyOnly.bill).toMatchObject({ grand_total: '300.00', fine_weight_due: '0.000' });
    const silverOnly = await opened(await addOpening(w, 'owner', b, opening({ fine_due: '4.000' })));
    expect(silverOnly.bill).toMatchObject({ grand_total: '0.00', fine_weight_due: '4.000' });
    expect(await totalsOf(w, b)).toMatchObject({ outstanding: '0.00', fine_outstanding: '4.000' });
    expect(await finePendingByBill(w, b)).toEqual({ [String(silverOnly.bill?.id)]: '4.000' });
  });

  it('a money advance becomes an is_opening receipt of kind money and mode Other, reference "Opening advance", dated as_of; a silver advance one of kind fine_silver with no mode and amount 0; no bill is made and no number is taken', async () => {
    const [a, b] = [await addCustomer(w), await addCustomer(w)];
    const counter = await openingCounter(w);
    const money = await opened(await addOpening(w, 'owner', a, opening({ advance: '750.25' })));
    expect(money.bill).toBeNull();
    expect(money.allocations).toEqual([]);
    expect(money.receipts).toHaveLength(1);
    expect(money.receipts[0]).toMatchObject({ customer_id: a, kind: 'money', mode: 'Other', amount: '750.25', fine_grams: '0.000', silver_rate: null, paid_on: CUT_OVER, reference: 'Opening advance', is_opening: true, status: 'active', cash_override_reason: null, created_by: owner(), updated_by: owner() });
    const silver = await opened(await addOpening(w, 'owner', b, opening({ fine_advance: '3.250' })));
    expect(silver.bill).toBeNull();
    expect(silver.receipts).toHaveLength(1);
    expect(silver.receipts[0]).toMatchObject({ customer_id: b, kind: 'fine_silver', mode: null, amount: '0.00', fine_grams: '3.250', silver_rate: null, paid_on: CUT_OVER, reference: 'Opening advance', is_opening: true, status: 'active' });
    expect(await openingCounter(w), 'an advance alone takes no OB number').toBe(counter);
    expect(await billsOf(w, a)).toEqual([]);
    expect((await openingReceiptsOf(w, a)).map((r) => [r.kind, r.mode, r.amount, r.is_opening])).toEqual([['money', 'Other', '750.25', 1]]);
    expect(await totalsOf(w, a)).toMatchObject({ received: '750.25', advance: '750.25', outstanding: '0.00', fine_advance: '0.000' });
    expect(await totalsOf(w, b)).toMatchObject({ received: '0.00', fine_received: '3.250', advance: '0.00', fine_advance: '3.250' });
    await i10Holds(w, a);
    await i10Holds(w, b);
  });

  it('ONE call with a money advance and a silver advance saves TWO receipts (money first, then silver), both is_opening, in the one answer', async () => {
    const c = await addCustomer(w);
    const r = await opened(await addOpening(w, 'owner', c, opening({ advance: '250.00', fine_advance: '1.250' })));
    expect(r.bill).toBeNull();
    expect(r.receipts.map((x) => [x.kind, x.mode, x.amount, x.fine_grams, x.is_opening])).toEqual([
      ['money', 'Other', '250.00', '0.000', true],
      ['fine_silver', null, '0.00', '1.250', true],
    ]);
    const stored = await openingReceiptsOf(w, c);
    expect(stored).toHaveLength(2);
    expect(new Set(stored.map((x) => x.id))).toEqual(new Set(r.receipts.map((x) => x.id)));
    expect(await receiptsOf(w, c)).toHaveLength(2);
    expect(await totalsOf(w, c)).toMatchObject({ advance: '250.00', fine_advance: '1.250' });
  });

  it('every row of one call carries the stamp of the call\'s ONE clock reading: the bill, the receipts, the allocations and the customer', async () => {
    const c = await addCustomer(w);
    const r = await opened(await addOpening(w, 'owner', c, opening({ dues: '1000.00', fine_due: '2.000', advance: '400.00', fine_advance: '1.000' })));
    const at = r.bill?.created_at as string;
    expect(at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
    expect(r.bill?.updated_at).toBe(at);
    for (const x of [...r.receipts, ...r.allocations]) {
      expect(x.created_at).toBe(at);
      expect(x.updated_at).toBe(at);
    }
    expect(timestampToWire((await customerRow(w, c)).updated_at), 'the customer is touched with the same stamp (D23)').toBe(at);
  });

  describe('they are paid first (Y9): an opening bill is the oldest by construction', () => {
    it('a customer with a sale bill of October and an opening bill of April: a payment of 300 goes to the opening bill; a second payment of 700 clears it and pays the sale bill', async () => {
      const c = await addCustomer(w);
      const sale = await addBill(w, c, '1000.00', '2026-10-01');
      const o = await opened(await addOpening(w, 'owner', c, opening({ dues: '500.00' })));
      const ob = String(o.bill?.id);
      const first = await paid(await pay(w, 'owner', c, { amount: '300.00', mode: 'UPI' }));
      expect(first.allocations.map((a) => [a.bill_id, a.amount])).toEqual([[ob, '300.00']]);
      expect(await pendingByBill(w, c)).toMatchObject({ [ob]: '200.00', [sale]: '1000.00' });
      const second = await paid(await pay(w, 'owner', c, { amount: '700.00', mode: 'UPI' }));
      expect(second.allocations.map((a) => [a.bill_id, a.amount])).toEqual([[ob, '200.00'], [sale, '500.00']]);
      expect(await pendingByBill(w, c)).toMatchObject({ [ob]: '0.00', [sale]: '500.00' });
      await pendingAgrees(w, c);
      await i10Holds(w, c);
    });

    it('an opening advance is applied to the oldest pending bill at once: 300 on a customer with a bill of 1,000 in October leaves it pending 700 and no advance', async () => {
      const c = await addCustomer(w);
      const sale = await addBill(w, c, '1000.00', '2026-10-01');
      const before = (await billRow(w, sale)).updated_at;
      const r = await opened(await addOpening(w, 'owner', c, opening({ advance: '300.00' })));
      expect(r.allocations.map((a) => [a.receipt_id, a.bill_id, a.amount, a.fine_grams])).toEqual([[r.receipts[0].id, sale, '300.00', '0.000']]);
      expect(await pendingByBill(w, c)).toEqual({ [sale]: '700.00' });
      expect(await totalsOf(w, c)).toMatchObject({ outstanding: '700.00', advance: '0.00' });
      expect((await billRow(w, sale)).updated_at, 'the bill that received money is touched (D23)').not.toBe(before);
      expect(timestampToWire((await billRow(w, sale)).updated_at)).toBe(r.receipts[0].created_at);
      await i10Holds(w, c);
    });
  });

  describe('they net off (Y6): an advance and dues of one customer cancel each other', () => {
    it('dues 1,000 and advance 400 in one call: the advance pays the opening bill (one allocation of 400), pending 600, no advance left', async () => {
      const c = await addCustomer(w);
      const r = await opened(await addOpening(w, 'owner', c, opening({ dues: '1000.00', advance: '400.00' })));
      expect(r.allocations.map((a) => [a.receipt_id, a.bill_id, a.amount, a.fine_grams, a.released_at])).toEqual([[r.receipts[0].id, r.bill?.id, '400.00', '0.000', null]]);
      expect((await billStates(w, c))[String(r.bill?.id)]).toMatchObject({ received: '400.00', pending: '600.00', payment_status: 'Partial' });
      expect(await totalsOf(w, c)).toMatchObject({ billed: '1000.00', received: '400.00', allocated: '400.00', outstanding: '600.00', advance: '0.00' });
      await pendingAgrees(w, c);
      await i10Holds(w, c);
    });

    it('dues 300 and advance 500: the bill is paid in full and 200 stays as the customer\'s advance', async () => {
      const c = await addCustomer(w);
      const r = await opened(await addOpening(w, 'owner', c, opening({ dues: '300.00', advance: '500.00' })));
      expect(r.allocations.map((a) => a.amount)).toEqual(['300.00']);
      expect((await billStates(w, c))[String(r.bill?.id)]).toMatchObject({ received: '300.00', pending: '0.00', payment_status: 'Paid' });
      expect(await totalsOf(w, c)).toMatchObject({ outstanding: '0.00', advance: '200.00' });
      await i10Holds(w, c);
    });

    it('silver nets off the same way: fine 2.000 g and silver advance 3.000 g give one allocation of 2.000 g (no rupees), the bill owes nothing and 1.000 g stays as silver advance', async () => {
      const c = await addCustomer(w);
      const r = await opened(await addOpening(w, 'owner', c, opening({ fine_due: '2.000', fine_advance: '3.000' })));
      expect(r.allocations.map((a) => [a.amount, a.fine_grams])).toEqual([['0.00', '2.000']]);
      expect(await finePendingByBill(w, c)).toEqual({ [String(r.bill?.id)]: '0.000' });
      expect(await totalsOf(w, c)).toMatchObject({ fine_outstanding: '0.000', fine_advance: '1.000', outstanding: '0.00', advance: '0.00' });
      await i10Holds(w, c);
    });

    it('money and silver at once: dues 1,000 with advance 400 and fine 5 g with silver advance 5 g give two allocations, money first; the advance of one kind never pays the other', async () => {
      const c = await addCustomer(w);
      const r = await opened(await addOpening(w, 'owner', c, opening({ dues: '1000.00', fine_due: '5.000', advance: '400.00', fine_advance: '5.000' })));
      expect(r.allocations.map((a) => [a.amount, a.fine_grams])).toEqual([['400.00', '0.000'], ['0.00', '5.000']]);
      expect(await totalsOf(w, c)).toMatchObject({ outstanding: '600.00', advance: '0.00', fine_outstanding: '0.000', fine_advance: '0.000' });
      // an advance of money and dues of silver only (and the other way round) do not meet
      const d = await addCustomer(w);
      const m = await opened(await addOpening(w, 'owner', d, opening({ fine_due: '5.000', advance: '400.00' })));
      expect(m.allocations).toEqual([]);
      expect(await totalsOf(w, d)).toMatchObject({ outstanding: '0.00', advance: '400.00', fine_outstanding: '5.000', fine_advance: '0.000' });
      await i10Holds(w, c);
      await i10Holds(w, d);
    });

    it('across two calls: an advance the customer already holds pays the dues added later, and dues added first are paid by an advance added later', async () => {
      const [a, b] = [await addCustomer(w), await addCustomer(w)];
      await opened(await addOpening(w, 'owner', a, opening({ advance: '400.00' })));
      const later = await opened(await addOpening(w, 'owner', a, opening({ dues: '1000.00' })));
      expect(later.allocations.map((x) => x.amount)).toEqual(['400.00']);
      expect(await totalsOf(w, a)).toMatchObject({ outstanding: '600.00', advance: '0.00' });
      await opened(await addOpening(w, 'owner', b, opening({ dues: '1000.00' })));
      const second = await opened(await addOpening(w, 'owner', b, opening({ advance: '250.00' })));
      expect(second.allocations.map((x) => x.amount)).toEqual(['250.00']);
      expect(await totalsOf(w, b)).toMatchObject({ outstanding: '750.00', advance: '0.00' });
      await i10Holds(w, a);
      await i10Holds(w, b);
    });
  });

  describe('they are left out of sales, daily cash and the cash limit (D15, C14, IM4)', () => {
    it('sales: the opening bill is in billed and outstanding but NOT in total_purchases, and the bills a sales figure adds up (V1 without opening_balance) do not hold it; a real sale bill is', async () => {
      const c = await addCustomer(w);
      await opened(await addOpening(w, 'owner', c, opening({ dues: '900.00' })));
      expect(await totalsOf(w, c)).toMatchObject({ billed: '900.00', total_purchases: '0.00', outstanding: '900.00' });
      expect(await salesBillsOf(w, c)).toEqual([]);
      const sale = await addBill(w, c, '500.00', '2026-10-05');
      expect(await totalsOf(w, c)).toMatchObject({ billed: '1400.00', total_purchases: '500.00' });
      expect((await salesBillsOf(w, c)).map((b) => [b.id, b.grand_total])).toEqual([[sale, '500.00']]);
    });

    it('daily cash: an opening advance dated TODAY adds nothing to any row of V4, and voiding it adds nothing either (no reverse row)', async () => {
      const c = await addCustomer(w);
      const modes = ['Cash', 'UPI', 'Card', 'Bank Transfer', 'Other'];
      const before = await Promise.all(modes.map((m) => dayRow(w, TODAY, m)));
      await opened(await addOpening(w, 'owner', c, opening({ advance: '5000.00', fine_advance: '2.000' }, { as_of: TODAY })));
      expect(await Promise.all(modes.map((m) => dayRow(w, TODAY, m))), 'V4 is unchanged by an opening advance').toEqual(before);
      // an ordinary payment of the same size DOES show, which proves the rows above could have shown
      const d = await addCustomer(w);
      await paid(await pay(w, 'owner', d, { amount: '5000.00', mode: 'Other' }));
      expect((await dayRow(w, TODAY, 'Other')).money_in).not.toBe(before[4].money_in);
    });

    it('the cash limit: opening advances of any size are no cash (no JV_CASH_LIMIT for the owner, no reason asked), and they do not count towards a customer\'s cash of the day: 150,000 opening advance dated today and then 150,000 in cash today by a biller is allowed, the limit being 200,000', async () => {
      expect(limits.cashLimit).toBe(200000);
      const c = await addCustomer(w);
      const huge = await opened(await addOpening(w, 'owner', c, opening({ advance: '999999999.00' }, { as_of: TODAY })));
      expect(huge.receipts[0].amount).toBe('999999999.00');
      const d = await addCustomer(w);
      await opened(await addOpening(w, 'owner', d, opening({ advance: '150000.00' }, { as_of: TODAY })));
      const cash = await pay(w, 'biller', d, { amount: '150000.00', mode: 'Cash' });
      expect(cash.statusCode, cash.body).toBe(201);
    });
  });

  describe('a wrong figure is fixed by cancelling the opening bill (X5) and adding a new one (IM5)', () => {
    it('dues 1,500 with an advance of 400 entered by mistake: the cancel releases the 400, which is an advance again; the new call (dues 1,050) takes the next OB number and the 400 pays it; the ledger shows the Opening, its cancellation and the new Opening', async () => {
      const c = await addCustomer(w);
      const first = await opened(await addOpening(w, 'owner', c, opening({ dues: '1500.00', advance: '400.00' })));
      const wrong = String(first.bill?.id);
      expect(await totalsOf(w, c)).toMatchObject({ outstanding: '1100.00', advance: '0.00' });

      const done = await cancelled(await cancelBill(w, 'owner', wrong, { reason: 'the figure in the old book was 1,050' }));
      expect(done.bill).toMatchObject({ id: wrong, status: 'cancelled', doc_type: 'opening_balance' });
      expect(done.released_allocations.map((a) => a.amount)).toEqual(['400.00']);
      expect(done.skus).toEqual([]);
      expect(await totalsOf(w, c)).toMatchObject({ billed: '0.00', outstanding: '0.00', advance: '400.00' });

      const second = await opened(await addOpening(w, 'owner', c, opening({ dues: '1050.00' })));
      expect(numberOf(String(second.bill?.bill_no)), 'the next number of the series, no gap').toBe(numberOf(String(first.bill?.bill_no)) + 1);
      expect(second.allocations.map((a) => [a.receipt_id, a.amount])).toEqual([[first.receipts[0].id, '400.00']]);
      expect(await totalsOf(w, c)).toMatchObject({ billed: '1050.00', outstanding: '650.00', advance: '0.00' });
      expect((await billStates(w, c))[wrong]).toMatchObject({ status: 'cancelled', pending: '0.00', payment_status: 'Cancelled' });
      const ledger = await ledgerOf(w, c);
      expect(ledger.map((x) => x.kind)).toEqual(['Opening', 'Opening advance', 'Opening', 'Cancellation']);
      expect(ledger.map((x) => [x.debit, x.credit])).toEqual([['1500.00', '0.00'], ['0.00', '400.00'], ['1050.00', '0.00'], ['0.00', '1500.00']]);
      await pendingAgrees(w, c);
      await i10Holds(w, c);
      // a cancelled opening bill is on no sales line, cancelled or not
      expect(await salesBillsOf(w, c)).toEqual([]);
    });

    it('the numbers of the series are the counter\'s, one for each opening bill, with no gap: three calls in a row take n, n+1, n+2 and the counter says n+2', async () => {
      const c = await addCustomer(w);
      const nums: number[] = [];
      for (const dues of ['10.00', '20.00', '30.00']) nums.push(numberOf(String((await opened(await addOpening(w, 'owner', c, opening({ dues })))).bill?.bill_no)));
      expect([nums[1] - nums[0], nums[2] - nums[1]]).toEqual([1, 1]);
      expect(await openingCounter(w)).toBe(nums[2]);
    });
  });

  describe('a wrong opening advance is fixed by voiding it (X4) and leaves V4 unchanged', () => {
    it('dues 1,000 with an advance 400 dated today: the void re-opens the bill (pending 1,000 again), the advance is gone from received, and no row of V4 moved - not on entry, not on the void', async () => {
      const c = await addCustomer(w);
      const modes = ['Cash', 'UPI', 'Card', 'Bank Transfer', 'Other'];
      const v4 = async () => Promise.all(modes.map((m) => dayRow(w, TODAY, m)));
      const before = await v4();
      const r = await opened(await addOpening(w, 'owner', c, opening({ dues: '1000.00', advance: '400.00' }, { as_of: TODAY })));
      expect(await v4()).toEqual(before);
      const v = await voided(await voidReceipt(w, 'owner', String(r.receipts[0].id), { reason: 'the advance was entered for the wrong customer' }));
      expect(v.receipt).toMatchObject({ status: 'voided', is_opening: true, voided_on: TODAY });
      expect(await v4(), 'a voided opening advance adds no reverse row to V4').toEqual(before);
      expect(await totalsOf(w, c)).toMatchObject({ billed: '1000.00', received: '0.00', outstanding: '1000.00', advance: '0.00' });
      expect((await billStates(w, c))[String(r.bill?.id)]).toMatchObject({ received: '0.00', pending: '1000.00' });
      expect((await ledgerOf(w, c)).map((x) => x.description)).toContain('Void of opening advance');
      await pendingAgrees(w, c);
      await i10Holds(w, c);
    });

    it('a voided silver opening advance puts the silver back: the bill owes its 5 g again', async () => {
      const c = await addCustomer(w);
      const r = await opened(await addOpening(w, 'owner', c, opening({ fine_due: '5.000', fine_advance: '5.000' })));
      expect(await finePendingByBill(w, c)).toEqual({ [String(r.bill?.id)]: '0.000' });
      await voided(await voidReceipt(w, 'owner', String(r.receipts[0].id), { reason: 'wrong customer' }));
      expect(await finePendingByBill(w, c)).toEqual({ [String(r.bill?.id)]: '5.000' });
      expect(await totalsOf(w, c)).toMatchObject({ fine_outstanding: '5.000', fine_advance: '0.000' });
      await i10Holds(w, c);
    });
  });

  it('the opening rows are the rows the import writes: same columns, same values (the import is the other opinion on D15)', async () => {
    const c = await addCustomer(w);
    const r = await opened(await addOpening(w, 'owner', c, opening({ dues: '120.00', fine_due: '1.500', advance: '20.00', fine_advance: '0.500' })));
    const bill = (await openingBillsOf(w, c))[0];
    // the facts D15 gives: no lines, grand_total and fine_weight_due set, dated the cut-over day, subtotal 0, a customer's own type, not an estimate (so not a whole-rupee rule), not a reissue
    expect(bill).toMatchObject({ doc_type: 'opening_balance', subtotal: '0.00', grand_total: '120.00', fine_weight_due: '1.500', bill_date: CUT_OVER, reissue_of: null, status: 'active' });
    expect(bill.request_id, 'the bill remembers the call that made it').toBeTruthy();
    expect((await openingReceiptsOf(w, c)).map((x) => [x.kind, x.mode, x.amount, x.fine_grams, x.paid_on, x.reference, x.is_opening])).toEqual([
      ['money', 'Other', '20.00', '0.000', CUT_OVER, 'Opening advance', 1],
      ['fine_silver', null, '0.00', '0.500', CUT_OVER, 'Opening advance', 1],
    ]);
    expect(r.allocations.map((a) => [a.amount, a.fine_grams])).toEqual([['20.00', '0.000'], ['0.00', '0.500']]);
  });
});

// ------------------------------------------------------------------ T-B17 (the walk-in clause)

describe('T-B17 (the clause of X12, K5) the walk-in customer takes no opening advance; it may carry opening dues', () => {
  it('a money advance for the walk-in is 409 JV_NOT_ALLOWED naming advance, a silver advance names fine_advance; nothing is saved and the key is not used up', async () => {
    const key = newKey();
    await refused(WALKIN, opening({ advance: '100.00' }), { status: 409, code: 'JV_NOT_ALLOWED', field: 'advance', details: { field: 'advance' } }, 'owner', key);
    await refused(WALKIN, opening({ fine_advance: '1.000' }), { status: 409, code: 'JV_NOT_ALLOWED', field: 'fine_advance', details: { field: 'fine_advance' } });
    // the same key with a body that is allowed is the first call
    const ok = await addOpening(w, 'owner', WALKIN, opening({ dues: '10.00' }), key);
    expect(ok.statusCode, ok.body).toBe(201);
    expect(ok.headers['idempotent-replay']).toBeUndefined();
  });

  it('dues AND an advance in one call for the walk-in: the whole call is refused, no bill is made either', async () => {
    const before = (await totalsOf(w, WALKIN)).outstanding;
    await refused(WALKIN, opening({ dues: '700.00', advance: '50.00' }), { status: 409, code: 'JV_NOT_ALLOWED', field: 'advance' });
    await refused(WALKIN, opening({ dues: '700.00', fine_due: '2.000', fine_advance: '1.000' }), { status: 409, code: 'JV_NOT_ALLOWED', field: 'fine_advance' });
    expect((await totalsOf(w, WALKIN)).outstanding).toBe(before);
  });

  it('opening dues for the walk-in are allowed (they count in the outstanding figures): a bill is made, nothing is allocated, the walk-in still holds no advance (I10)', async () => {
    const before = await totalsOf(w, WALKIN);
    const r = await opened(await addOpening(w, 'owner', WALKIN, opening({ dues: '700.00', fine_due: '2.000' })));
    expect(r.bill).toMatchObject({ customer_id: WALKIN, doc_type: 'opening_balance', grand_total: '700.00', fine_weight_due: '2.000' });
    expect(r.receipts).toEqual([]);
    expect(r.allocations).toEqual([]);
    const after = await totalsOf(w, WALKIN);
    expect(Number(after.outstanding) - Number(before.outstanding)).toBe(700);
    expect(after.advance).toBe('0.00');
    expect(after.fine_advance).toBe('0.000');
    await i10Holds(w, WALKIN);
  });
});

// ------------------------------------------------------------------ T-A09 (opening-balance amounts)

describe('T-A09 (the clause of X12) a negative, over-cap or badly written opening amount reaches no row', () => {
  const BAD_MONEY = ['-1.00', '-0.01', '1000000000.01', '10000000000.00', '1.005', '1.230', '10.500', '.5', '5.', '+5', '1e3', ' 7.50 ', '', 'abc', 5, 5.5, true, [5], { v: 5 }];
  const BAD_WEIGHT = ['-1.000', '-0.001', '100000.001', '1000000.000', '1.2300', '.5', '5.', '+5', '1e3', ' 7.500 ', '', 'abc', 5, 5.5, true, [5], { v: 5 }];

  it('dues and advance: -1.00, 1,000,000,000.01, three decimals (a trailing zero counts), loose text, a JSON number and the rest are 422 on that field', async () => {
    const c = await addCustomer(w);
    for (const field of ['dues', 'advance'] as const) {
      for (const bad of BAD_MONEY) await refused(c, opening({ [field]: bad }), { status: 422, code: 'JV_INVALID_INPUT', field });
    }
    expect(await billsOf(w, c)).toEqual([]);
    expect(await receiptsOf(w, c)).toEqual([]);
  });

  it('fine_due and fine_advance: -1.000, 100,000.001, four decimals (1.230 is fine: three are allowed for a weight), loose text and a JSON number are 422 on that field', async () => {
    const c = await addCustomer(w);
    for (const field of ['fine_due', 'fine_advance'] as const) {
      for (const bad of BAD_WEIGHT) await refused(c, opening({ [field]: bad }), { status: 422, code: 'JV_INVALID_INPUT', field });
    }
    const ok = await opened(await addOpening(w, 'owner', c, opening({ fine_due: '1.230' })));
    expect(ok.bill?.fine_weight_due).toBe('1.230');
  });

  it('not all zero: nothing, null, 0, 0.00 and 0.000 in every field is 422 and says so; one figure above 0 is enough', async () => {
    const c = await addCustomer(w);
    await refused(c, { as_of: CUT_OVER }, { status: 422, code: 'JV_INVALID_INPUT', field: 'dues' });
    await refused(c, opening({ dues: null, fine_due: null, advance: null, fine_advance: null }), { status: 422, code: 'JV_INVALID_INPUT', field: 'dues' });
    await refused(c, opening({ dues: '0.00', fine_due: '0.000', advance: '0', fine_advance: '0.000' }), { status: 422, code: 'JV_INVALID_INPUT', field: 'dues' });
    const ok = await addOpening(w, 'owner', c, opening({ dues: '0.00', fine_due: '0.000', advance: '0.01', fine_advance: '0.000' }));
    expect(ok.statusCode, ok.body).toBe(201);
  });

  it('at the caps exactly: dues and advance of 1,000,000,000.00 and fine and silver advance of 100,000.000 g are saved and net off, with no database error', async () => {
    const c = await addCustomer(w);
    const r = await opened(await addOpening(w, 'owner', c, opening({ dues: '1000000000.00', fine_due: '100000.000', advance: '1000000000.00', fine_advance: '100000.000' })));
    expect(r.bill).toMatchObject({ grand_total: '1000000000.00', fine_weight_due: '100000.000' });
    expect(r.allocations.map((a) => [a.amount, a.fine_grams])).toEqual([['1000000000.00', '0.000'], ['0.00', '100000.000']]);
    expect(await totalsOf(w, c)).toMatchObject({ outstanding: '0.00', advance: '0.00', fine_outstanding: '0.000', fine_advance: '0.000' });
    await i10Holds(w, c);
  });

  it('as_of: missing, null, not a date, not a calendar day and a day in the future are 422 on as_of (the owner may use any day up to today, Y8); today and the cut-over day are saved', async () => {
    const c = await addCustomer(w);
    for (const as_of of [undefined, null, '', '17/10/2026', '2026-10-17T00:00:00Z', '2026-02-30', '2026-13-01', 20261017, '2026-10-18', '2027-01-01']) {
      await refused(c, { dues: '10.00', ...(as_of === undefined ? {} : { as_of }) }, { status: 422, code: 'JV_INVALID_INPUT', field: 'as_of' });
    }
    expect((await opened(await addOpening(w, 'owner', c, opening({ dues: '10.00' }, { as_of: TODAY })))).bill?.bill_date).toBe(TODAY);
    expect((await opened(await addOpening(w, 'owner', c, opening({ dues: '10.00' }, { as_of: '2019-04-01' })))).bill?.bill_date).toBe('2019-04-01');
  });

  it('a field this call does not take is 422 on that field: the customer is the one in the path, a bill number, a mode, a reference, a note, an id, a role; and a body that is not an object', async () => {
    const c = await addCustomer(w);
    for (const extra of [{ customer_id: c }, { bill_no: 'OB-9999' }, { mode: 'Cash' }, { reference: 'x' }, { notes: 'x' }, { id: c }, { role: 'owner' }, { cash_override_reason: 'a reason of ten characters' }]) {
      const field = Object.keys(extra)[0];
      await refused(c, opening({ dues: '10.00' }, extra), { status: 422, code: 'JV_INVALID_INPUT', field });
    }
    for (const bad of [[], [{ as_of: CUT_OVER, dues: '1.00' }]]) {
      const res = await addOpening(w, 'owner', c, bad);
      expect(res.statusCode, JSON.stringify(bad)).toBe(422);
    }
  });
});

// ------------------------------------------------------------------ the customer

describe('X12 the customer: a path id that is not a customer is 404, a malformed one 422, an archived customer 409 JV_CUSTOMER_ARCHIVED', () => {
  it('an id that is no customer is 404 JV_NOT_FOUND and the claim is rolled back', async () => {
    await refused('00000000-0000-4000-8000-0000000000bb', opening({ dues: '10.00' }), { status: 404, code: 'JV_NOT_FOUND' });
  });

  it('a path id that is not a lower-case UUID is 422 on id', async () => {
    const before = await footprint(w);
    for (const id of ['abc', '12345', '00000000-0000-4000-8000-0000000000BB']) {
      const res = await addOpening(w, 'owner', id, opening({ dues: '10.00' }));
      expect(refusal(res), id).toMatchObject({ status: 422, code: 'JV_INVALID_INPUT', field: 'id' });
    }
    expect(await footprint(w)).toEqual(before);
  });

  it('an archived customer takes no opening balance: 409 JV_CUSTOMER_ARCHIVED and nothing is saved; brought back, the call is saved', async () => {
    const c = await addCustomer(w);
    await w.world.sql.query("UPDATE customers SET archived_at = '2026-10-10 05:00:00.000000' WHERE id = ?", [c]);
    await refused(c, opening({ dues: '10.00' }), { status: 409, code: 'JV_CUSTOMER_ARCHIVED' });
    await w.world.sql.query('UPDATE customers SET archived_at = NULL WHERE id = ?', [c]);
    await opened(await addOpening(w, 'owner', c, opening({ dues: '10.00' })));
  });
});

// ------------------------------------------------------------------ D23

describe('D23 touches: the bill, the bills that received the advance and the customer carry the stamp of the call, and no other bill does', () => {
  it('a customer with two pending bills gets an advance that pays only the oldest: the oldest and the customer are touched, the other bill is not', async () => {
    const c = await addCustomer(w);
    const a = await addBill(w, c, '1000.00', '2026-10-01');
    const b = await addBill(w, c, '1000.00', '2026-10-02');
    const beforeB = (await billRow(w, b)).updated_at;
    const beforeCustomer = (await customerRow(w, c)).updated_at;
    const r = await opened(await addOpening(w, 'owner', c, opening({ advance: '300.00' })));
    const at = r.receipts[0].created_at;
    expect(timestampToWire((await billRow(w, a)).updated_at)).toBe(at);
    expect((await billRow(w, b)).updated_at, 'a bill that received nothing is not touched').toBe(beforeB);
    const stamp = (await customerRow(w, c)).updated_at;
    expect(stamp).not.toBe(beforeCustomer);
    expect(timestampToWire(stamp)).toBe(at);
  });

  it('an advance that pays nothing (no pending bill) still touches the customer: its advance moved', async () => {
    const c = await addCustomer(w);
    const before = (await customerRow(w, c)).updated_at;
    const r = await opened(await addOpening(w, 'owner', c, opening({ advance: '300.00' })));
    const stamp = (await customerRow(w, c)).updated_at;
    expect(stamp).not.toBe(before);
    expect(timestampToWire(stamp)).toBe(r.receipts[0].created_at);
  });

  it('dues alone touch the customer too (its outstanding moved)', async () => {
    const c = await addCustomer(w);
    const before = (await customerRow(w, c)).updated_at;
    const r = await opened(await addOpening(w, 'owner', c, opening({ dues: '100.00' })));
    expect(timestampToWire((await customerRow(w, c)).updated_at)).toBe(r.bill?.created_at);
    expect((await customerRow(w, c)).updated_at).not.toBe(before);
  });
});

// ------------------------------------------------------------------ L5

describe('L5 repeat-safety of add_opening_balance (the clause of T-C05): the same Idempotency-Key makes one bill, one set of receipts, and answers the same', () => {
  it('the same key and body twice: one bill, one number, one set of receipts and allocations, the same answer with Idempotent-Replay: true and the same status', async () => {
    const c = await addCustomer(w);
    const key = newKey();
    const payload = opening({ dues: '1000.00', advance: '400.00', fine_advance: '1.000' });
    const counter = await openingCounter(w);
    const first = await addOpening(w, 'owner', c, payload, key);
    expect(first.statusCode).toBe(201);
    expect(first.headers['idempotent-replay']).toBeUndefined();
    const again = await addOpening(w, 'owner', c, payload, key);
    expect(again.statusCode).toBe(201);
    expect(again.headers['idempotent-replay']).toBe('true');
    expect(body(again)).toEqual(body(first));
    expect(await billsOf(w, c)).toHaveLength(1);
    expect(await receiptsOf(w, c)).toHaveLength(2);
    expect(await allocationsOf(w, c)).toHaveLength(1);
    expect(await openingCounter(w)).toBe((counter ?? 0) + 1);
  });

  it('the same key with other figures, another day, another customer or another caller is refused (422 on the header), and saves nothing', async () => {
    const [c, other] = [await addCustomer(w), await addCustomer(w)];
    const key = newKey();
    await opened(await addOpening(w, 'owner', c, opening({ dues: '1000.00' }), key));
    const before = await footprint(w);
    for (const [customer, payload] of [
      [c, opening({ dues: '1000.01' })],
      [c, opening({ dues: '1000.00' }, { as_of: TODAY })],
      [c, opening({ dues: '1000.00', advance: '1.00' })],
      [other, opening({ dues: '1000.00' })],
    ] as const) {
      const res = await addOpening(w, 'owner', customer, payload, key);
      expect(refusal(res), JSON.stringify(payload)).toMatchObject({ status: 422, code: 'JV_INVALID_INPUT', field: 'Idempotency-Key' });
    }
    expect(await footprint(w)).toEqual(before);
  });

  it('a missing or malformed Idempotency-Key is 422 on the header and claims nothing', async () => {
    const c = await addCustomer(w);
    const before = await footprint(w);
    for (const key of [null, 'abc', '12345']) {
      const res = await addOpening(w, 'owner', c, opening({ dues: '1.00' }), key);
      expect(refusal(res), String(key)).toMatchObject({ status: 422, code: 'JV_INVALID_INPUT', field: 'Idempotency-Key' });
    }
    expect(await footprint(w)).toEqual(before);
  });

  it('a refusal (the walk-in, an archived customer) does not use the key up: the same key is the first call when it is fixed', async () => {
    const key = newKey();
    await refused(WALKIN, opening({ advance: '5.00' }), { status: 409, code: 'JV_NOT_ALLOWED' }, 'owner', key);
    const c = await addCustomer(w);
    const ok = await addOpening(w, 'owner', c, opening({ advance: '5.00' }), key);
    expect(ok.statusCode, ok.body).toBe(201); // the refusal rolled its claim back, so the key is free: this call is a first call, whatever customer and body
    expect(ok.headers['idempotent-replay']).toBeUndefined();
  });
});

// ------------------------------------------------------------------ X0

describe('X0 the order of work inside the transaction, as the statements say it', () => {
  it('claim first, then the customer FOR UPDATE, then the state read ONCE, then the number (the counter), then the bill, the receipts, the allocations and the touches, then the stored result; no lock after a write; no piece', async () => {
    const c = await addCustomer(w);
    await addBill(w, c, '100.00', '2026-10-01');
    const from = w.world.spy.sent.length;
    const res = await addOpening(w, 'owner', c, opening({ dues: '1000.00', advance: '400.00', fine_advance: '1.000' }));
    expect(res.statusCode, res.body).toBe(201);
    const sqls = w.world.spy.sqls().slice(from);
    const at = (re: RegExp, nth = 0): number => sqls.map((s, i) => [s, i] as const).filter(([s]) => re.test(s.trim()))[nth]?.[1] ?? -1;
    const claim = at(/^INSERT INTO sys_idempotency\b/);
    const customer = at(/^SELECT .* FROM customers WHERE id = \? FOR UPDATE$/s);
    const openBills = at(/ORDER BY t\.bill_date, t\.created_at, t\.id$/);
    const counter = at(/^UPDATE sys_counters SET last_value = LAST_INSERT_ID/);
    const bill = at(/^INSERT INTO bills\b/);
    const receipt = at(/^INSERT INTO receipts\b/);
    const allocations = at(/^INSERT INTO receipt_allocations\b/);
    const store = at(/^UPDATE sys_idempotency SET result = \?/);
    expect(claim, 'the claim is the first statement of the transaction').toBe(Math.min(...sqls.map((s, i) => (/^INSERT INTO sys_idempotency\b/.test(s.trim()) ? i : 1e9))));
    expect(customer, 'the customer row is locked right after the claim and its read-back').toBe(claim + 2);
    expect(openBills).toBeGreaterThan(customer);
    expect(counter, 'the number comes after the state read and before the first write').toBeGreaterThan(openBills);
    expect(bill).toBeGreaterThan(counter);
    expect(receipt).toBeGreaterThan(bill);
    expect(allocations).toBeGreaterThan(receipt);
    expect(store).toBeGreaterThan(allocations);
    expect(sqls.filter((s) => /ORDER BY t\.bill_date, t\.created_at, t\.id$/.test(s.trim())), 'the state of the customer is read once').toHaveLength(1);
    expect(sqls.filter((s) => /^UPDATE sys_counters\b/.test(s.trim())), 'one number for the one bill').toHaveLength(1);
    expect(sqls.slice(bill).filter((s) => /FOR UPDATE/.test(s)), 'no lock is taken after the first write').toEqual([]);
    expect(sqls.some((s) => /\bFROM skus\b|\bFROM sku_private\b/.test(s)), 'an opening balance reads no piece').toBe(false);
    expect(sqls.some((s) => /SELECT SUM\(amount\) AS total FROM receipts WHERE customer_id/.test(s)), 'opening rows are no cash: the cash of the day is not read').toBe(false);
  });

  it('a call with no dues takes no number: the counter statement is not sent at all', async () => {
    const c = await addCustomer(w);
    const from = w.world.spy.sent.length;
    await opened(await addOpening(w, 'owner', c, opening({ advance: '10.00' })));
    expect(w.world.spy.sqls().slice(from).some((s) => /sys_counters/.test(s))).toBe(false);
  });

  it('the state of the customer is read exactly once and the rebalance reads nothing again, also when it applies an advance to older bills', async () => {
    const c = await addCustomer(w);
    await addBill(w, c, '100.00', '2026-10-01');
    await addBill(w, c, '100.00', '2026-10-02');
    const from = w.world.spy.sent.length;
    await opened(await addOpening(w, 'owner', c, opening({ advance: '150.00' })));
    const sqls = w.world.spy.sqls().slice(from).map((s) => s.trim());
    expect(sqls.filter((s) => /ORDER BY t\.bill_date, t\.created_at, t\.id$/.test(s))).toHaveLength(1);
    expect(sqls.filter((s) => /^INSERT INTO receipt_allocations\b/.test(s))).toHaveLength(1);
  });
});

// ------------------------------------------------------------------ T-D09

describe('T-D09 the matrix row of X12 (POST /v1/customers/:id/opening-balance: the owner only) and its field rules', () => {
  it('the route is registered through route() with the action of the row', () => {
    expect(w.world.app.routeTable.find((r) => r.action === 'fn:add_opening_balance')).toMatchObject({ method: 'POST', url: '/v1/customers/:id/opening-balance', kind: 'matrix', roles: ['owner'], mustChange: false });
  });

  it('no session is 401, a user who must change the password 403 JV_PASSWORD_CHANGE_REQUIRED, the biller and staff 403 JV_FORBIDDEN, and none of them reads or writes the books', async () => {
    for (const [caller, status, code] of [['anon', 401, 'JV_UNAUTHENTICATED'], ['ended', 401, 'JV_UNAUTHENTICATED'], ['expired', 401, 'JV_SESSION_EXPIRED'], ['idle', 401, 'JV_SESSION_EXPIRED'], ['inactive', 401, 'JV_UNAUTHENTICATED'], ['must_change', 403, 'JV_PASSWORD_CHANGE_REQUIRED'], ['biller', 403, 'JV_FORBIDDEN'], ['staff', 403, 'JV_FORBIDDEN']] as const) {
      const c = await addCustomer(w);
      const from = w.world.spy.sent.length;
      const res = await addOpening(w, caller, c, opening({ dues: '100.00', advance: '10.00' }));
      expect(res.statusCode, caller).toBe(status);
      expect(codeOf(res), caller).toBe(code);
      await w.world.restore(caller);
      expect(w.world.spy.sqls().slice(from).some((s) => /\bFROM\s+(customers|bills|receipts|receipt_allocations|sys_idempotency|sys_counters)\b/i.test(s) || /^INSERT\b/i.test(s.trim())), `${caller} caused a read or write of the books`).toBe(false);
      expect(await billsOf(w, c), caller).toEqual([]);
      expect(await receiptsOf(w, c), caller).toEqual([]);
    }
  });

  it('the owner is let in, and the rows name the owner as their maker', async () => {
    const c = await addCustomer(w);
    const r = await opened(await addOpening(w, 'owner', c, opening({ dues: '100.00', advance: '10.00' })));
    expect(r.bill).toMatchObject({ created_by: owner(), updated_by: owner() });
    expect(r.receipts[0]).toMatchObject({ created_by: owner(), updated_by: owner() });
  });

  it('a refused role is refused BEFORE the body is read: a biller with a bad body gets 403 and not 422', async () => {
    const c = await addCustomer(w);
    const res = await addOpening(w, 'biller', c, { dues: '-1' });
    expect(res.statusCode).toBe(403);
    expect(codeOf(res)).toBe('JV_FORBIDDEN');
  });

  it('the answer is what the wire says (S3): money and weight as text, flags as booleans, ids and stamps in the sync form', async () => {
    const c = await addCustomer(w);
    const r = await opened(await addOpening(w, 'owner', c, opening({ dues: '1000.00', fine_due: '1.000', advance: '400.00', fine_advance: '0.500' })));
    expect(typeof r.bill?.grand_total).toBe('string');
    expect(typeof r.bill?.fine_weight_due).toBe('string');
    expect(typeof r.bill?.pricing_version).toBe('number');
    for (const x of r.receipts) {
      expect(typeof x.amount).toBe('string');
      expect(typeof x.fine_grams).toBe('string');
      expect(typeof x.is_opening).toBe('boolean');
    }
    for (const a of r.allocations) {
      expect(typeof a.amount).toBe('string');
      expect(typeof a.fine_grams).toBe('string');
      expect(a.released_at).toBeNull();
    }
    for (const key of Object.keys(r)) expect(['bill', 'receipts', 'allocations']).toContain(key);
  });
});
