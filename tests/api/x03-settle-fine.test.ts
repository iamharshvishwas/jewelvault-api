import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { timestampToWire } from '../../src/wire/format';
import { AFTER_MIDNIGHT_IN_INDIA } from './edit-13b-support';
import { type Payload, addFineAllocation, addFineBill, addSilver, cashFine, cashRow, fineAgrees, finePendingByBill, moneyPendingByBill, settle, settled, silver } from './x03-support';
import {
  type EditWorld,
  TODAY,
  WALKIN,
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
  footprint,
  i10Holds,
  newKey,
  receiptsOf,
  refusal,
  rows,
  stamp,
} from './x02-support';

// API24, X3 settle_fine (POST /v1/customers/:id/fine-settlements; X3, SF1, SF2, Y1, Y3, K5, O52, D13, D23): silver or cash against the fine weight of a customer's bills. T-B11 (oldest first, the named
// bill first, more than the outstanding is refused with the maximum), T-B12 (a fine settled in cash is money received and does not reduce rupees owed), T-B13 (a cash settlement needs a rate above 0
// and an amount above 0.00), the clause of T-B17 (the walk-in names its bill), the clause of T-A09 (the fine_cash amount), the clause of T-D09 (the matrix row), L5, Y8, D23 and X0 for this function.
// The cash rules (T-B23) are in x03-cash-rules.test.ts, the audit rows (T-D14) in x03-audit.test.ts, the two-session test (T-C09 style) in x03-two-sessions.test.ts.
//
// The world is the scratch database of the other money tests: the real routes, the seeds (the walk-in customer among them), a clock fixed at 17 Oct 2026 10:00 UTC (15:30 in Kolkata, "today" is
// 2026-10-17). Every test makes its own customer (the walk-in is one row for all the tests; its tests name their bills). A customer's history is typed in by SQL, with stamps earlier than the API
// clock's. Expected figures are written in the test, never read back from the code under test; the books are checked with V1, V2, V4 and I10 of the database half, which are another opinion.

let w: EditWorld;

beforeAll(async () => {
  w = await editWorld('x03fine');
}, 120_000);
afterAll(async () => {
  await w?.world.close();
}, 60_000);

/** The refusal is exactly this, and the call left no trace: no receipt, no allocation, no claim, no audit row, no stamp (the claim rolls back with the rest). */
async function refused(
  customer: string,
  payload: unknown,
  expected: { status: number; code: string; field?: string; details?: Record<string, unknown> },
  caller: 'owner' | 'biller' = 'owner',
  key = newKey(),
): Promise<Record<string, any>> {
  const before = await footprint(w);
  const res = await settle(w, caller, customer, payload, key);
  expect(refusal(res), res.body).toMatchObject({ status: expected.status, code: expected.code, ...(expected.field === undefined ? {} : { field: expected.field }) });
  if (expected.details) expect(body(res).error.details, res.body).toMatchObject(expected.details);
  expect(await footprint(w), 'a refused settlement leaves no trace').toEqual(before);
  return body(res).error;
}

let obSeq = 0;
/** An opening-balance bill that owes silver (the import's: doc_type opening_balance, dated the cut-over day, D15, Y9). */
const addOpeningFineBill = (customer: string, total: string, fine: string): Promise<string> =>
  addFineBill(w, customer, total, fine, '2026-04-01', { doc_type: 'opening_balance', sale_type: 'Retail', bill_no: `OB-${700000 + ++obSeq}` });

/** The three bills of the examples: 1,000 rupees each owing 10, 6 and 4 grams, oldest first. */
async function threeBills(customer: string) {
  return {
    a: await addFineBill(w, customer, '1000.00', '10.000', '2026-10-01'),
    b: await addFineBill(w, customer, '1000.00', '6.000', '2026-10-05'),
    c: await addFineBill(w, customer, '1000.00', '4.000', '2026-10-10'),
  };
}

describe('T-B11 settle_fine goes oldest first and the named bill first; more than the fine outstanding is rejected with the maximum (SF1, SF2, Y3, X3)', () => {
  it('12 g in silver with no bill named on bills owing 10, 6 and 4 g: the oldest takes 10, the next 2; the receipt is a fine_silver with no mode and amount 0; 8 g remain', async () => {
    const c = await addCustomer(w);
    const { a, b, c: n } = await threeBills(c);
    const r = await settled(await settle(w, 'owner', c, silver('12.000', { reference: 'S-1', notes: 'bar returned' })));
    expect(r.allocations.map((x) => [x.bill_id, x.fine_grams, x.amount])).toEqual([
      [a, '10.000', '0.00'],
      [b, '2.000', '0.00'],
    ]);
    expect(r.fine_remaining).toBe('8.000');
    expect(r.receipt).toMatchObject({ customer_id: c, kind: 'fine_silver', mode: null, amount: '0.00', fine_grams: '12.000', silver_rate: null, paid_on: TODAY, reference: 'S-1', notes: 'bar returned', is_opening: false, status: 'active', cash_override_reason: null });
    for (const x of r.allocations) expect(x).toMatchObject({ receipt_id: r.receipt.id, customer_id: c, released_at: null });
    // the tables say the same, and so do V1 and V2 of the database half
    const asRows = (list: Record<string, any>[]) => list.map((x) => [x.id, x.bill_id, x.fine_grams, x.receipt_id].join(' ')).sort();
    expect(asRows(await allocationsOf(w, c)), 'the answer holds the rows the tables hold').toEqual(asRows(r.allocations));
    expect(await finePendingByBill(w, c)).toEqual({ [a]: '0.000', [b]: '4.000', [n]: '4.000' });
    expect(await figures(w, c)).toEqual({ outstanding: '3000.00', advance: '0.00', fine_outstanding: '8.000', fine_advance: '0.000' });
    expect(await fineAgrees(w, c)).toEqual({ bills: 8000n, outstanding: 8000n });
    await i10Holds(w, c);
  });

  it('5 g naming the newest bill (4 g owed): it takes 4 g, then the oldest takes 1 g; the middle bill is untouched', async () => {
    const c = await addCustomer(w);
    const { a, b, c: n } = await threeBills(c);
    const r = await settled(await settle(w, 'biller', c, silver('5.000', { bill_id: n })));
    expect(r.allocations.map((x) => [x.bill_id, x.fine_grams])).toEqual([
      [n, '4.000'],
      [a, '1.000'],
    ]);
    expect(r.fine_remaining).toBe('15.000');
    expect(await finePendingByBill(w, c)).toEqual({ [a]: '9.000', [b]: '6.000', [n]: '0.000' });
    await i10Holds(w, c);
  });

  it('a part settlement of the named middle bill: all of it goes to that bill, which stays part settled', async () => {
    const c = await addCustomer(w);
    const { a, b, c: n } = await threeBills(c);
    const r = await settled(await settle(w, 'owner', c, silver('2.500', { bill_id: b })));
    expect(r.allocations.map((x) => [x.bill_id, x.fine_grams])).toEqual([[b, '2.500']]);
    expect(await finePendingByBill(w, c)).toEqual({ [a]: '10.000', [b]: '3.500', [n]: '4.000' });
    expect(r.fine_remaining).toBe('17.500');
  });

  it('the opening-balance bill that owes silver is the oldest and is settled first (Y9, D15); a named bill still goes before it', async () => {
    const c = await addCustomer(w);
    const ob = await addOpeningFineBill(c, '500.00', '2.000');
    const sale = await addFineBill(w, c, '1000.00', '5.000', '2026-10-01');
    const first = await settled(await settle(w, 'owner', c, silver('3.000')));
    expect(first.allocations.map((x) => [x.bill_id, x.fine_grams])).toEqual([
      [ob, '2.000'],
      [sale, '1.000'],
    ]);
    const named = await settled(await settle(w, 'owner', c, silver('1.000', { bill_id: sale })));
    expect(named.allocations.map((x) => [x.bill_id, x.fine_grams])).toEqual([[sale, '1.000']]);
    await i10Holds(w, c);
  });

  it('what is already settled does not count again: a bill with 4 g of its 10 g settled has 6 g pending, and 6.000 passes while 6.001 is refused with the maximum 6.000', async () => {
    const c = await addCustomer(w);
    const a = await addFineBill(w, c, '1000.00', '10.000', '2026-10-01');
    const earlier = await addSilver(w, c, '4.000', '2026-10-03');
    await addFineAllocation(w, earlier, a, c, '4.000');
    const error = await refused(c, silver('6.001'), { status: 409, code: 'JV_FINE_EXCEEDS', field: 'grams' });
    expect(error.details).toMatchObject({ max_grams: '6.000' });
    const r = await settled(await settle(w, 'owner', c, silver('6.000')));
    expect(r.allocations.map((x) => [x.bill_id, x.fine_grams])).toEqual([[a, '6.000']]);
    expect(r.fine_remaining).toBe('0.000');
  });

  it('more than the outstanding is refused with the maximum allowed, whatever the mode, and nothing is capped silently: the receipt, the allocations and the claim are not written (SF2, LED-12)', async () => {
    const c = await addCustomer(w);
    await threeBills(c);
    for (const payload of [silver('20.001'), silver('500.000'), cashFine('20.001', '90.00'), silver('20.001', { bill_id: (await rows(w, 'SELECT id FROM bills WHERE customer_id = ? ORDER BY bill_date LIMIT 1', [c]))[0].id })]) {
      const error = await refused(c, payload, { status: 409, code: 'JV_FINE_EXCEEDS', field: 'grams' });
      expect(error.details).toMatchObject({ max_grams: '20.000' });
      expect(error.message).toMatch(/20\.000/);
    }
    expect(await receiptsOf(w, c)).toEqual([]);
    expect(await figures(w, c)).toMatchObject({ fine_outstanding: '20.000', fine_advance: '0.000' });
  });

  it('exactly the outstanding is saved and leaves nothing; one milligram more is then refused with the maximum 0.000', async () => {
    const c = await addCustomer(w);
    const { a, b, c: n } = await threeBills(c);
    const r = await settled(await settle(w, 'owner', c, silver('20.000')));
    expect(r.allocations.map((x) => [x.bill_id, x.fine_grams])).toEqual([
      [a, '10.000'],
      [b, '6.000'],
      [n, '4.000'],
    ]);
    expect(r.fine_remaining).toBe('0.000');
    await refused(c, silver('0.001'), { status: 409, code: 'JV_FINE_EXCEEDS', details: { max_grams: '0.000' } });
    expect(await figures(w, c)).toMatchObject({ outstanding: '3000.00', fine_outstanding: '0.000', fine_advance: '0.000' });
    await i10Holds(w, c);
  });

  it('a customer who owes no silver cannot settle any (maximum 0.000), and neither can one who holds silver already received and not applied: that is not fine outstanding', async () => {
    const none = await addCustomer(w);
    await addBill(w, none, '100.00', '2026-10-10');
    await refused(none, silver('1.000'), { status: 409, code: 'JV_FINE_EXCEEDS', details: { max_grams: '0.000' } });
    const advance = await addCustomer(w);
    await addSilver(w, advance, '3.000', '2026-10-02');
    expect(await figures(w, advance)).toMatchObject({ fine_outstanding: '0.000', fine_advance: '3.000' });
    await refused(advance, silver('1.000'), { status: 409, code: 'JV_FINE_EXCEEDS', details: { max_grams: '0.000' } });
  });

  it('a cancelled bill owes no silver: its 50 g are not outstanding, so only the live bill\'s 3 g can be settled', async () => {
    const c = await addCustomer(w);
    await addFineBill(w, c, '100.00', '50.000', '2026-10-01', { status: 'cancelled', cancel_reason: 'test', cancelled_at: stamp('2026-10-01', 99), cancelled_on: '2026-10-01', cancelled_by: w.world.fixtures.owner.userId });
    const live = await addFineBill(w, c, '100.00', '3.000', '2026-10-02');
    await refused(c, silver('3.001'), { status: 409, code: 'JV_FINE_EXCEEDS', details: { max_grams: '3.000' } });
    const r = await settled(await settle(w, 'owner', c, silver('3.000')));
    expect(r.allocations.map((x) => [x.bill_id, x.fine_grams])).toEqual([[live, '3.000']]);
  });

  it('a named bill that is not this customer\'s, is cancelled, is paid up in silver, owes only money, does not exist or is not an id is 422 JV_INVALID_INPUT on bill_id (Y3); nothing is saved', async () => {
    const c = await addCustomer(w);
    const other = await addCustomer(w);
    const mine = await addFineBill(w, c, '100.00', '5.000', '2026-10-01');
    const foreign = await addFineBill(w, other, '100.00', '5.000', '2026-10-01');
    const moneyOnly = await addBill(w, c, '100.00', '2026-10-02');
    const cancelled = await addCancelledBill(w, c, '100.00', '2026-10-03');
    const paidUp = await addFineBill(w, c, '100.00', '2.000', '2026-10-04');
    const receipt = await addSilver(w, c, '2.000', '2026-10-05');
    await addFineAllocation(w, receipt, paidUp, c, '2.000');
    for (const bill_id of [foreign, moneyOnly, cancelled, paidUp, '00000000-0000-4000-8000-0000000000aa', 'not-an-id', 7]) {
      await refused(c, silver('1.000', { bill_id }), { status: 422, code: 'JV_INVALID_INPUT', field: 'bill_id' });
    }
    const ok = await settled(await settle(w, 'owner', c, silver('1.000', { bill_id: mine })));
    expect(ok.allocations.map((x) => x.bill_id)).toEqual([mine]);
    // null or no bill_id is "none named"
    await settled(await settle(w, 'owner', c, silver('1.000', { bill_id: null })));
  });

  it('a settlement never touches the rupees: the money pending of every bill and the outstanding of the customer are as they were', async () => {
    const c = await addCustomer(w);
    const { a, b, c: n } = await threeBills(c);
    const before = await moneyPendingByBill(w, c);
    await settled(await settle(w, 'owner', c, silver('9.000')));
    expect(await moneyPendingByBill(w, c)).toEqual(before);
    expect(before).toEqual({ [a]: '1000.00', [b]: '1000.00', [n]: '1000.00' });
    expect(await figures(w, c)).toMatchObject({ outstanding: '3000.00', advance: '0.00' });
  });

  it('a money advance the customer holds is not spent on silver: it stays an advance in the books (a customer with a money advance owes no rupees, I10)', async () => {
    const c = await addCustomer(w);
    await addFineBill(w, c, '0.00', '4.000', '2026-10-01');
    await addMoney(w, c, '250.00', '2026-10-02');
    expect(await figures(w, c)).toMatchObject({ outstanding: '0.00', advance: '250.00', fine_outstanding: '4.000' });
    const r = await settled(await settle(w, 'owner', c, silver('1.500')));
    expect(r.allocations.map((x) => x.fine_grams)).toEqual(['1.500']);
    expect(await figures(w, c)).toEqual({ outstanding: '0.00', advance: '250.00', fine_outstanding: '2.500', fine_advance: '0.000' });
    await i10Holds(w, c);
  });

  it('30 settlements of odd sizes on five bills: after each one the pending silver of the bills is the fine outstanding of V2 and I10 holds', async () => {
    const c = await addCustomer(w);
    for (const [i, fine] of ['7.125', '3.500', '12.250', '0.875', '9.000'].entries()) await addFineBill(w, c, '500.00', fine, `2026-09-0${i + 1}`);
    let left = 32_750n; // milligrams owed
    const sizes = [1_111n, 2_222n, 333n, 4_444n, 555n, 666n, 1_777n, 88n, 999n, 1_010n];
    for (let i = 0; i < 30 && left > 0n; i++) {
      const take = sizes[i % sizes.length] < left ? sizes[i % sizes.length] : left;
      const grams = `${take / 1000n}.${String(take % 1000n).padStart(3, '0')}`;
      await settled(await settle(w, i % 2 ? 'biller' : 'owner', c, silver(grams)));
      left -= take;
      const agree = await fineAgrees(w, c);
      expect(agree.bills, `after settlement ${i}`).toBe(left);
      expect(agree.outstanding).toBe(left);
    }
    expect(left).toBe(0n);
    await i10Holds(w, c);
  });
});

describe('T-B12 a fine settled in cash is money received: it is in the Cash total of the day and does not reduce rupees owed (Y1, V4, X3)', () => {
  it('4 g at 85.50: a fine_cash receipt of 342.00 in mode Cash with the rate and the grams; the allocation carries grams and no rupees; the Cash row of the day gains 342.00', async () => {
    const c = await addCustomer(w);
    const a = await addFineBill(w, c, '5000.00', '10.000', '2026-10-01');
    const day = '2026-03-03'; // a day of its own, so that the figures of V4 are this call's alone (the owner may back-date, Y8)
    const before = await cashRow(w, day);
    expect(before).toEqual({ money_in: '0.00', money_out: '0.00', net: '0.00' });
    const r = await settled(await settle(w, 'owner', c, cashFine('4.000', '85.50', { paid_on: day })));
    expect(r.receipt).toMatchObject({ customer_id: c, kind: 'fine_cash', mode: 'Cash', amount: '342.00', fine_grams: '4.000', silver_rate: '85.50', paid_on: day, status: 'active', is_opening: false });
    expect(r.allocations.map((x) => [x.bill_id, x.fine_grams, x.amount])).toEqual([[a, '4.000', '0.00']]);
    expect(r.fine_remaining).toBe('6.000');
    expect(await cashRow(w, day)).toEqual({ money_in: '342.00', money_out: '0.00', net: '342.00' });
  });

  it('it does not reduce the rupees owed, and it is not a money receipt: the bill\'s pending, the customer\'s outstanding, received and advance are as they were; only the silver went down', async () => {
    const c = await addCustomer(w);
    const a = await addFineBill(w, c, '5000.00', '10.000', '2026-10-01');
    const before = await figures(w, c);
    expect(before).toEqual({ outstanding: '5000.00', advance: '0.00', fine_outstanding: '10.000', fine_advance: '0.000' });
    await settled(await settle(w, 'owner', c, cashFine('10.000', '90.00')));
    expect(await moneyPendingByBill(w, c)).toEqual({ [a]: '5000.00' });
    expect(await finePendingByBill(w, c)).toEqual({ [a]: '0.000' });
    expect(await figures(w, c)).toEqual({ outstanding: '5000.00', advance: '0.00', fine_outstanding: '0.000', fine_advance: '0.000' });
    const [v2] = await rows(w, 'SELECT 1 AS x FROM receipts WHERE customer_id = ? AND kind = ? AND amount = ?', [c, 'fine_cash', '900.00']);
    expect(v2).toBeDefined();
    const [{ received }] = await rows(w, "SELECT COALESCE(SUM(amount), 0) AS received FROM receipts WHERE customer_id = ? AND status = 'active' AND kind = 'money'", [c]);
    expect(String(received), 'the money received (V2: money receipts only) is untouched').toBe('0.00');
    await i10Holds(w, c);
  });

  it('a silver settlement adds nothing to any day\'s Cash total (its amount is 0), and a cash one adds exactly its amount to Cash and to no other mode', async () => {
    const c = await addCustomer(w);
    await addFineBill(w, c, '100.00', '10.000', '2026-10-01');
    const day = '2026-03-04';
    await settled(await settle(w, 'owner', c, silver('2.000', { paid_on: day })));
    expect(await cashRow(w, day)).toEqual({ money_in: '0.00', money_out: '0.00', net: '0.00' });
    await settled(await settle(w, 'owner', c, cashFine('2.000', '10.00', { paid_on: day })));
    expect(await cashRow(w, day)).toEqual({ money_in: '20.00', money_out: '0.00', net: '20.00' });
    const [others] = await rows(w, "SELECT COUNT(*) AS n FROM receipts WHERE customer_id = ? AND kind = 'fine_cash' AND mode <> 'Cash'", [c]);
    expect(Number(others.n)).toBe(0);
  });

  it('the amount is round(grams x rate, 2), half up, in whole paise with no float: 1.005 g at 1.00 is 1.01, 0.333 g at 99.99 is 33.30, 12.345 g at 87.65 is 1082.04, 0.001 g at 5.00 is 0.01', async () => {
    const c = await addCustomer(w);
    await addFineBill(w, c, '100.00', '100.000', '2026-10-01');
    for (const [grams, rate, amount] of [
      ['1.005', '1.00', '1.01'],
      ['0.333', '99.99', '33.30'],
      ['12.345', '87.65', '1082.04'],
      ['0.001', '5.00', '0.01'],
      ['2.500', '10.00', '25.00'],
      ['3.000', '0.01', '0.03'],
    ] as const) {
      const r = await settled(await settle(w, 'owner', c, cashFine(grams, rate)));
      expect(r.receipt, `${grams} g at ${rate}`).toMatchObject({ amount, fine_grams: grams, silver_rate: rate });
    }
  });

  it('the cash fine is allocated like the silver one: oldest first, the named bill first (Y3)', async () => {
    const c = await addCustomer(w);
    const { a, b, c: n } = await threeBills(c);
    const r = await settled(await settle(w, 'biller', c, cashFine('11.000', '80.00', { bill_id: b })));
    expect(r.allocations.map((x) => [x.bill_id, x.fine_grams, x.amount])).toEqual([
      [b, '6.000', '0.00'],
      [a, '5.000', '0.00'],
    ]);
    expect(r.receipt.amount).toBe('880.00');
    expect(await finePendingByBill(w, c)).toEqual({ [a]: '5.000', [b]: '0.000', [n]: '4.000' });
    await refused(c, cashFine('9.001', '80.00'), { status: 409, code: 'JV_FINE_EXCEEDS', details: { max_grams: '9.000' } });
  });
});

describe('T-B13 a cash fine settlement without a silver rate above 0 is rejected, and so is one whose amount round(grams x rate, 2) is 0.00 (SF1, X3, Y3)', () => {
  it('no rate, a null rate, 0 and 0.00 are 422 on silver_rate; nothing is saved and the key is not used up', async () => {
    const c = await addCustomer(w);
    await addFineBill(w, c, '100.00', '10.000', '2026-10-01');
    const key = newKey();
    await refused(c, { grams: '1.000', mode: 'Cash' }, { status: 422, code: 'JV_INVALID_INPUT', field: 'silver_rate' }, 'owner', key);
    for (const silver_rate of [null, '0', '0.00', '0.0', '000.00']) {
      await refused(c, { grams: '1.000', mode: 'Cash', silver_rate }, { status: 422, code: 'JV_INVALID_INPUT', field: 'silver_rate' }, 'owner', key);
    }
    const ok = await settle(w, 'owner', c, cashFine('1.000', '0.01'), key);
    expect(ok.statusCode, ok.body).toBe(201);
    expect(ok.headers['idempotent-replay']).toBeUndefined();
  });

  it('an amount that rounds to 0.00 is 422 JV_INVALID_INPUT: 0.004 g at 1.00 and 0.001 g at 4.99 are 0.00, while 0.005 g at 1.00 and 0.001 g at 5.00 are 0.01 and are saved', async () => {
    const c = await addCustomer(w);
    await addFineBill(w, c, '100.00', '10.000', '2026-10-01');
    await refused(c, cashFine('0.004', '1.00'), { status: 422, code: 'JV_INVALID_INPUT', field: 'grams' });
    await refused(c, cashFine('0.001', '4.99'), { status: 422, code: 'JV_INVALID_INPUT', field: 'grams' });
    await refused(c, cashFine('0.001', '0.01'), { status: 422, code: 'JV_INVALID_INPUT', field: 'grams' });
    expect((await settled(await settle(w, 'owner', c, cashFine('0.005', '1.00')))).receipt.amount).toBe('0.01');
    expect((await settled(await settle(w, 'owner', c, cashFine('0.001', '5.00')))).receipt.amount).toBe('0.01');
    // the same grams in SILVER need no rate and are saved: only the cash amount must be above 0.00
    expect((await settled(await settle(w, 'owner', c, silver('0.001')))).receipt).toMatchObject({ kind: 'fine_silver', amount: '0.00', fine_grams: '0.001' });
  });

  it('the rate is for cash only: a silver settlement that carries a rate is 422 on silver_rate (the receipt of fine_silver has none, D13) rather than dropping it', async () => {
    const c = await addCustomer(w);
    await addFineBill(w, c, '100.00', '10.000', '2026-10-01');
    await refused(c, silver('1.000', { silver_rate: '90.00' }), { status: 422, code: 'JV_INVALID_INPUT', field: 'silver_rate' });
    await settled(await settle(w, 'owner', c, silver('1.000', { silver_rate: null })));
  });

  it('the mode is Silver or Cash, written so: Credit, UPI, silver, cash, a blank, none, a number and a list are 422 on mode', async () => {
    const c = await addCustomer(w);
    await addFineBill(w, c, '100.00', '10.000', '2026-10-01');
    for (const mode of ['Credit', 'UPI', 'silver', 'cash', 'SILVER', '', ' Cash', 5, null, ['Cash']]) {
      await refused(c, { grams: '1.000', mode, silver_rate: '90.00' }, { status: 422, code: 'JV_INVALID_INPUT', field: 'mode' });
    }
    await refused(c, { grams: '1.000' }, { status: 422, code: 'JV_INVALID_INPUT', field: 'mode' });
  });
});

describe('T-A09 (the clause of X3) a negative, zero, over-cap or badly written grams, rate or fine_cash amount reaches no row', () => {
  it('grams: -1.000, 0, 0.000, 100000.001, 1.2345, .5, 5., +5, 1e3, a padded text, a number, null, a list and nothing are 422 on grams (1.230 is accepted: three decimals are fine for a weight)', async () => {
    const c = await addCustomer(w);
    await addFineBill(w, c, '100.00', '50.000', '2026-10-01');
    for (const grams of ['-1.000', '0', '0.000', '100000.001', '1.2345', '.5', '5.', '+5', '1e3', ' 7.500 ', '', 'abc', 5, 5.5, null, [5], { v: 5 }, true]) {
      await refused(c, { grams, mode: 'Silver' }, { status: 422, code: 'JV_INVALID_INPUT', field: 'grams' });
      await refused(c, { grams, mode: 'Cash', silver_rate: '90.00' }, { status: 422, code: 'JV_INVALID_INPUT', field: 'grams' });
    }
    await refused(c, { mode: 'Silver' }, { status: 422, code: 'JV_INVALID_INPUT', field: 'grams' });
    expect((await settled(await settle(w, 'owner', c, silver('1.230')))).receipt.fine_grams).toBe('1.230');
    expect(await receiptsOf(w, c)).toHaveLength(1);
  });

  it('silver_rate: -5.00, 1.234, 1.230 (a trailing zero counts), 100000000.01, .5, 5., +5, a number and a list are 422 on silver_rate', async () => {
    const c = await addCustomer(w);
    await addFineBill(w, c, '100.00', '50.000', '2026-10-01');
    for (const silver_rate of ['-5.00', '1.234', '1.230', '100000000.01', '.5', '5.', '+5', '1e2', ' 90.00 ', 'abc', 90, 90.5, [90], true]) {
      await refused(c, { grams: '1.000', mode: 'Cash', silver_rate }, { status: 422, code: 'JV_INVALID_INPUT', field: 'silver_rate' });
    }
  });

  it('a fine_cash amount over the cap of 1,000,000,000 (grams x rate) is 422 JV_INVALID_INPUT and never a database error; exactly the cap is saved (the owner gives the reason the cash limit asks for)', async () => {
    const c = await addCustomer(w);
    await addFineBill(w, c, '100.00', '100000.000', '2026-10-01');
    await refused(c, cashFine('100000.000', '10000.01'), { status: 422, code: 'JV_INVALID_INPUT', field: 'grams' });
    await refused(c, cashFine('100000.000', '100000000.00'), { status: 422, code: 'JV_INVALID_INPUT', field: 'grams' });
    const r = await settled(await settle(w, 'owner', c, cashFine('100000.000', '10000.00', { cash_override_reason: 'a bar sold back to the shop in cash' })));
    expect(r.receipt).toMatchObject({ kind: 'fine_cash', amount: '1000000000.00', fine_grams: '100000.000', silver_rate: '10000.00' });
  });

  it('a field this call does not take, a reference over 120 characters, notes over 10,000 and a date that is not a date are 422 on that field; the customer is the one in the path and never in the body', async () => {
    const c = await addCustomer(w);
    await addFineBill(w, c, '100.00', '10.000', '2026-10-01');
    await refused(c, silver('1.000', { surprise: 1 }), { status: 422, code: 'JV_INVALID_INPUT', field: 'surprise' });
    await refused(c, silver('1.000', { customer_id: c }), { status: 422, code: 'JV_INVALID_INPUT', field: 'customer_id' });
    await refused(c, silver('1.000', { amount: '5.00' }), { status: 422, code: 'JV_INVALID_INPUT', field: 'amount' }); // the amount of a cash fine is worked out, never sent
    await refused(c, silver('1.000', { reference: 'x'.repeat(121) }), { status: 422, code: 'JV_INVALID_INPUT', field: 'reference' });
    await refused(c, silver('1.000', { notes: 'x'.repeat(10_001) }), { status: 422, code: 'JV_INVALID_INPUT', field: 'notes' });
    await refused(c, silver('1.000', { paid_on: '17/10/2026' }), { status: 422, code: 'JV_INVALID_INPUT', field: 'paid_on' });
    const ok = await settled(await settle(w, 'owner', c, silver('1.000', { reference: ' R-1 ', notes: '', paid_on: null })));
    expect(ok.receipt).toMatchObject({ reference: 'R-1', notes: null, paid_on: TODAY });
  });
});

describe('T-B17 (the clause of X3, O52) the walk-in customer\'s silver settlement names its bill and takes no more grams than that bill has pending', () => {
  it('without a named bill: 409 JV_FINE_EXCEEDS on bill_id, in silver and in cash, whatever the grams; nothing is saved', async () => {
    await addFineBill(w, WALKIN, '1000.00', '34.190', '2026-10-10');
    for (const payload of [silver('0.001'), silver('5.000'), cashFine('1.000', '90.00'), silver('5.000', { bill_id: null })]) {
      await refused(WALKIN, payload, { status: 409, code: 'JV_FINE_EXCEEDS', field: 'bill_id' }, 'biller');
    }
  });

  it('above the named bill\'s fine pending by one milligram: 409 JV_FINE_EXCEEDS with that bill\'s maximum, though the walk-in\'s other bills owe silver too; the older stranger\'s bill is not settled instead', async () => {
    const old = await addFineBill(w, WALKIN, '400.00', '8.000', '2026-01-01');
    const bill = await addFineBill(w, WALKIN, '1000.00', '34.190', '2026-10-10');
    const error = await refused(WALKIN, silver('34.191', { bill_id: bill }), { status: 409, code: 'JV_FINE_EXCEEDS', field: 'grams' });
    expect(error.details).toMatchObject({ max_grams: '34.190' });
    await refused(WALKIN, cashFine('40.000', '90.00', { bill_id: bill }), { status: 409, code: 'JV_FINE_EXCEEDS', details: { max_grams: '34.190' } });
    expect((await finePendingByBill(w, WALKIN))[old]).toBe('8.000');
    expect((await finePendingByBill(w, WALKIN))[bill]).toBe('34.190');
  });

  it('a walk-in Wholesale silver bill of 34.190 g settled 5.000 g in silver: all 5 g go to that bill and never to an older one; the rest later, exactly, then the bill is settled and naming it again is a 422', async () => {
    const old = await addFineBill(w, WALKIN, '400.00', '6.000', '2026-01-02');
    const bill = await addFineBill(w, WALKIN, '1000.00', '34.190', '2026-10-11');
    const part = await settled(await settle(w, 'biller', WALKIN, silver('5.000', { bill_id: bill })));
    expect(part.allocations.map((x) => [x.bill_id, x.fine_grams])).toEqual([[bill, '5.000']]);
    const rest = await settled(await settle(w, 'owner', WALKIN, cashFine('29.190', '90.00', { bill_id: bill })));
    expect(rest.allocations.map((x) => [x.bill_id, x.fine_grams])).toEqual([[bill, '29.190']]);
    expect(rest.receipt.amount).toBe('2627.10');
    const pending = await finePendingByBill(w, WALKIN);
    expect(pending[bill]).toBe('0.000');
    expect(pending[old]).toBe('6.000');
    await refused(WALKIN, silver('0.001', { bill_id: bill }), { status: 422, code: 'JV_INVALID_INPUT', field: 'bill_id' });
  });

  it('a named bill that is not the walk-in\'s is 422 on bill_id (the named-bill rule comes first), and a named customer is not held to the walk-in rule: it need not name a bill', async () => {
    const c = await addCustomer(w);
    const foreign = await addFineBill(w, c, '100.00', '5.000', '2026-10-10');
    await refused(WALKIN, silver('1.000', { bill_id: foreign }), { status: 422, code: 'JV_INVALID_INPUT', field: 'bill_id' });
    const r = await settled(await settle(w, 'owner', c, silver('2.000')));
    expect(r.allocations.map((x) => [x.bill_id, x.fine_grams])).toEqual([[foreign, '2.000']]);
  });

  it('the walk-in never holds silver in advance and its books satisfy I10 after all of it', async () => {
    expect((await figures(w, WALKIN)).fine_advance).toBe('0.000');
    await i10Holds(w, WALKIN);
  });
});

describe('Y8 the date of a settlement: today by default; a biller only today; the owner any day up to today; never the future', () => {
  it('paid_on absent or null is today (Asia/Kolkata, from the API clock); today written out is fine', async () => {
    const c = await addCustomer(w);
    await addFineBill(w, c, '100.00', '10.000', '2026-10-01');
    for (const extra of [{}, { paid_on: null }, { paid_on: TODAY }]) {
      expect((await settled(await settle(w, 'biller', c, silver('0.500', extra)))).receipt.paid_on).toBe(TODAY);
    }
  });

  it('a past date from a biller is 422 on paid_on; from the owner it is saved with that date; tomorrow is 422 for both', async () => {
    const c = await addCustomer(w);
    await addFineBill(w, c, '100.00', '10.000', '2026-10-01');
    await refused(c, silver('1.000', { paid_on: '2026-10-16' }), { status: 422, code: 'JV_INVALID_INPUT', field: 'paid_on' }, 'biller');
    expect((await settled(await settle(w, 'owner', c, silver('1.000', { paid_on: '2026-10-16' })))).receipt.paid_on).toBe('2026-10-16');
    for (const caller of ['owner', 'biller'] as const) await refused(c, silver('1.000', { paid_on: '2026-10-18' }), { status: 422, code: 'JV_INVALID_INPUT', field: 'paid_on' }, caller);
  });

  it('a settlement dated before an older allocation still allocates by Y3 (bill order), not by the receipt dates', async () => {
    const c = await addCustomer(w);
    const a = await addFineBill(w, c, '100.00', '3.000', '2026-10-01');
    const b = await addFineBill(w, c, '100.00', '3.000', '2026-10-09');
    const r = await settled(await settle(w, 'owner', c, silver('4.000', { paid_on: '2026-09-01' })));
    expect(r.allocations.map((x) => [x.bill_id, x.fine_grams])).toEqual([
      [a, '3.000'],
      [b, '1.000'],
    ]);
  });
});

describe('D23 touches: the bills that received silver and the customer carry the stamp of the call, and no other bill does', () => {
  it('the settled bills and the customer have updated_at = the receipt\'s created_at; a bill that got nothing is not touched; nothing else of the bill changes', async () => {
    const c = await addCustomer(w);
    const { a, b, c: n } = await threeBills(c);
    const beforeN = await billRow(w, n);
    const beforeA = await billRow(w, a);
    const beforeCustomer = (await customerRow(w, c)).updated_at;
    const r = await settled(await settle(w, 'owner', c, silver('12.000')));
    const stampOfCall = r.receipt.created_at; // wire form: 2026-10-17T10:00:00.000000Z
    expect(timestampToWire((await billRow(w, a)).updated_at)).toBe(stampOfCall);
    expect(timestampToWire((await billRow(w, b)).updated_at)).toBe(stampOfCall);
    expect((await billRow(w, n)).updated_at, 'a bill that received nothing is not touched').toBe(beforeN.updated_at);
    const customerStamp = (await customerRow(w, c)).updated_at;
    expect(customerStamp).not.toBe(beforeCustomer);
    expect(timestampToWire(customerStamp)).toBe(stampOfCall);
    const { updated_at: _u1, ...was } = beforeA;
    const { updated_at: _u2, ...now } = await billRow(w, a);
    expect(now).toEqual(was);
    expect(r.receipt.updated_at).toBe(stampOfCall);
  });
});

describe('X3 the customer: a path id that is not a customer is 404, a malformed one 422, an archived customer 409 JV_CUSTOMER_ARCHIVED', () => {
  it('an id that is no customer is 404 JV_NOT_FOUND and the claim is rolled back', async () => {
    await refused('00000000-0000-4000-8000-0000000000bb', silver('1.000'), { status: 404, code: 'JV_NOT_FOUND' });
  });

  it('a path id that is not a lower-case UUID is 422 on id', async () => {
    const before = await footprint(w);
    for (const id of ['abc', '12345', '00000000-0000-4000-8000-0000000000BB']) {
      const res = await settle(w, 'owner', id, silver('1.000'));
      expect(refusal(res), id).toMatchObject({ status: 422, code: 'JV_INVALID_INPUT', field: 'id' });
    }
    expect(await footprint(w)).toEqual(before);
  });

  it('an archived customer cannot settle: 409 JV_CUSTOMER_ARCHIVED, nothing is saved; brought back, the settlement is saved', async () => {
    const c = await addCustomer(w);
    await addFineBill(w, c, '100.00', '5.000', '2026-10-01');
    await w.world.sql.query('UPDATE customers SET archived_at = ? WHERE id = ?', [stamp('2026-10-10'), c]);
    await refused(c, silver('1.000'), { status: 409, code: 'JV_CUSTOMER_ARCHIVED' });
    await w.world.sql.query('UPDATE customers SET archived_at = NULL WHERE id = ?', [c]);
    await settled(await settle(w, 'owner', c, silver('1.000')));
  });
});

describe('L5 repeat-safety of settle_fine (the clause of T-C05): the same Idempotency-Key makes one receipt and answers the same', () => {
  it('the same key and body twice: one receipt, one set of allocations, the same answer with Idempotent-Replay: true and the same status', async () => {
    const c = await addCustomer(w);
    const a = await addFineBill(w, c, '100.00', '10.000', '2026-10-01');
    const key = newKey();
    const first = await settle(w, 'owner', c, cashFine('4.000', '90.00', { reference: 'R-9' }), key);
    expect(first.statusCode).toBe(201);
    expect(first.headers['idempotent-replay']).toBeUndefined();
    const again = await settle(w, 'owner', c, cashFine('4.000', '90.00', { reference: 'R-9' }), key);
    expect(again.statusCode).toBe(201);
    expect(again.headers['idempotent-replay']).toBe('true');
    expect(body(again)).toEqual(body(first));
    expect(await receiptsOf(w, c)).toHaveLength(1);
    expect(await allocationsOf(w, c)).toHaveLength(1);
    expect(await finePendingByBill(w, c)).toEqual({ [a]: '6.000' });
  });

  it('the same key with other grams, another rate, another mode, another customer or another caller is refused (422 on the header), and saves nothing', async () => {
    const [c, other] = [await addCustomer(w), await addCustomer(w)];
    await addFineBill(w, c, '100.00', '10.000', '2026-10-01');
    const key = newKey();
    await settled(await settle(w, 'owner', c, cashFine('4.000', '90.00'), key));
    const before = await footprint(w);
    for (const [caller, customer, payload] of [
      ['owner', c, cashFine('4.001', '90.00')],
      ['owner', c, cashFine('4.000', '91.00')],
      ['owner', c, silver('4.000')],
      ['owner', other, cashFine('4.000', '90.00')],
      ['biller', c, cashFine('4.000', '90.00')],
    ] as const) {
      const res = await settle(w, caller, customer, payload as Payload, key);
      expect(refusal(res), `${caller} ${JSON.stringify(payload)}`).toMatchObject({ status: 422, code: 'JV_INVALID_INPUT', field: 'Idempotency-Key' });
    }
    expect(await footprint(w)).toEqual(before);
  });

  it('a missing or malformed Idempotency-Key is 422 on the header and claims nothing', async () => {
    const c = await addCustomer(w);
    await addFineBill(w, c, '100.00', '10.000', '2026-10-01');
    const before = await footprint(w);
    for (const key of [null, 'abc', '12345']) {
      const res = await settle(w, 'owner', c, silver('1.000'), key);
      expect(refusal(res), String(key)).toMatchObject({ status: 422, code: 'JV_INVALID_INPUT', field: 'Idempotency-Key' });
    }
    expect(await footprint(w)).toEqual(before);
  });

  it('a refusal (SF2, the walk-in rule, the cash rate) does not use the key up: the same key is the first call when it is fixed', async () => {
    const c = await addCustomer(w);
    await addFineBill(w, c, '100.00', '2.000', '2026-10-01');
    const key = newKey();
    await refused(c, silver('2.001'), { status: 409, code: 'JV_FINE_EXCEEDS' }, 'owner', key);
    const ok = await settle(w, 'owner', c, silver('2.000'), key);
    expect(ok.statusCode, ok.body).toBe(201);
    expect(ok.headers['idempotent-replay']).toBeUndefined();
  });
});

describe('X0 the order of work inside the transaction, as the statements say it', () => {
  it('claim first, then the customer FOR UPDATE, then the state read ONCE, then the receipt and the allocations, then the touches and the stored result; no lock is taken after a write; no number, no piece', async () => {
    const c = await addCustomer(w);
    await addFineBill(w, c, '100.00', '3.000', '2026-10-01');
    await addFineBill(w, c, '100.00', '3.000', '2026-10-02');
    const from = w.world.spy.sent.length;
    const res = await settle(w, 'owner', c, silver('4.000'));
    expect(res.statusCode, res.body).toBe(201);
    const sqls = w.world.spy.sqls().slice(from);
    const at = (re: RegExp, nth = 0): number => sqls.map((s, i) => [s, i] as const).filter(([s]) => re.test(s.trim()))[nth]?.[1] ?? -1;
    const claim = at(/^INSERT INTO sys_idempotency\b/);
    const customer = at(/^SELECT .* FROM customers WHERE id = \? FOR UPDATE$/s);
    const openBills = at(/ORDER BY t\.bill_date, t\.created_at, t\.id$/);
    const receipt = at(/^INSERT INTO receipts\b/);
    const allocations = at(/^INSERT INTO receipt_allocations\b/);
    const touchBills = at(/^UPDATE bills SET updated_at = \?/);
    const touchCustomer = at(/^UPDATE customers SET updated_at = \?/);
    const store = at(/^UPDATE sys_idempotency SET result = \?/);
    expect(claim, 'the claim is the first statement of the transaction').toBe(Math.min(...sqls.map((s, i) => (/^INSERT INTO sys_idempotency\b/.test(s.trim()) ? i : 1e9))));
    expect(customer, 'the customer row is locked right after the claim and its read-back').toBe(claim + 2);
    expect(openBills).toBeGreaterThan(customer);
    expect(receipt).toBeGreaterThan(openBills);
    expect(allocations).toBeGreaterThan(receipt);
    expect(touchBills).toBeGreaterThan(allocations);
    expect(touchCustomer).toBeGreaterThan(touchBills);
    expect(store).toBeGreaterThan(touchCustomer);
    expect(sqls.filter((s) => /ORDER BY t\.bill_date, t\.created_at, t\.id$/.test(s.trim())), 'the state of the customer is read once').toHaveLength(1);
    expect(sqls.filter((s) => /^SELECT\b.*\bFOR UPDATE$/s.test(s.trim())).length, 'two row locks only: the claim row and the customer').toBe(2);
    expect(sqls.slice(receipt).filter((s) => /FOR UPDATE/.test(s)), 'no lock is taken after the first write').toEqual([]);
    expect(sqls.some((s) => /sys_counters/.test(s)), 'a settlement takes no number').toBe(false);
    expect(sqls.some((s) => /\bFROM skus\b|\bFROM sku_private\b/.test(s)), 'a settlement reads no piece').toBe(false);
  });

  it('the cash rule reads the day\'s cash after the lock and before the first write, and only for a cash fine: a silver settlement reads no receipts for it', async () => {
    const c = await addCustomer(w);
    await addFineBill(w, c, '100.00', '3.000', '2026-10-01');
    let from = w.world.spy.sent.length;
    await settled(await settle(w, 'owner', c, cashFine('1.000', '90.00')));
    let sqls = w.world.spy.sqls().slice(from).map((s) => s.trim());
    const day = sqls.findIndex((s) => /^SELECT SUM\(amount\) AS total FROM receipts WHERE customer_id/.test(s));
    expect(day, 'a cash fine reads the cash of the day').toBeGreaterThan(sqls.findIndex((s) => /FROM customers WHERE id = \? FOR UPDATE$/s.test(s)));
    expect(day).toBeLessThan(sqls.findIndex((s) => /^INSERT INTO receipts\b/.test(s)));
    from = w.world.spy.sent.length;
    await settled(await settle(w, 'owner', c, silver('1.000')));
    sqls = w.world.spy.sqls().slice(from).map((s) => s.trim());
    expect(sqls.some((s) => /^SELECT SUM\(amount\) AS total FROM receipts WHERE customer_id/.test(s)), 'silver is not cash: the day is not read').toBe(false);
  });
});

describe('T-D09 the matrix row of X3 (POST /v1/customers/:id/fine-settlements: owner and biller) and its field rules', () => {
  it('the route is registered through route() with the action of the row', () => {
    expect(w.world.app.routeTable.find((r) => r.action === 'fn:settle_fine')).toMatchObject({ method: 'POST', url: '/v1/customers/:id/fine-settlements', kind: 'matrix', roles: ['owner', 'biller'], mustChange: false });
  });

  it('no session is 401, staff is 403 JV_FORBIDDEN, a user who must change the password is 403 JV_PASSWORD_CHANGE_REQUIRED, and none of them reads or writes the books', async () => {
    for (const [caller, status, code] of [['anon', 401, 'JV_UNAUTHENTICATED'], ['ended', 401, 'JV_UNAUTHENTICATED'], ['expired', 401, 'JV_SESSION_EXPIRED'], ['idle', 401, 'JV_SESSION_EXPIRED'], ['inactive', 401, 'JV_UNAUTHENTICATED'], ['staff', 403, 'JV_FORBIDDEN'], ['must_change', 403, 'JV_PASSWORD_CHANGE_REQUIRED']] as const) {
      const c = await addCustomer(w);
      await addFineBill(w, c, '100.00', '5.000', '2026-10-10');
      const from = w.world.spy.sent.length;
      const res = await settle(w, caller, c, silver('1.000'));
      expect(res.statusCode, caller).toBe(status);
      expect(codeOf(res), caller).toBe(code);
      await w.world.restore(caller);
      expect(w.world.spy.sqls().slice(from).some((s) => /\bFROM\s+(customers|bills|receipts|receipt_allocations|sys_idempotency)\b/i.test(s) || /^INSERT\b/i.test(s.trim())), `${caller} caused a read or write of the books`).toBe(false);
      expect(await receiptsOf(w, c)).toEqual([]);
    }
  });

  it('the owner and the biller are let in, and the receipt names the one who made it', async () => {
    for (const caller of ['owner', 'biller'] as const) {
      const c = await addCustomer(w);
      await addFineBill(w, c, '100.00', '5.000', '2026-10-10');
      const r = await settled(await settle(w, caller, c, silver('1.000')));
      expect(r.receipt.created_by, caller).toBe(w.world.fixtures[caller].userId);
      expect(r.receipt.updated_by, caller).toBe(w.world.fixtures[caller].userId);
    }
  });

  it('a biller\'s cash_override_reason is 403 JV_FORBIDDEN naming the field (the owner\'s right, Z1), in silver as in cash; nothing is saved, and the key stays unused for the owner', async () => {
    const c = await addCustomer(w);
    await addFineBill(w, c, '100.00', '5.000', '2026-10-10');
    const key = newKey();
    const payload = silver('1.000', { cash_override_reason: 'the customer paid ten people in cash' });
    await refused(c, payload, { status: 403, code: 'JV_FORBIDDEN', field: 'cash_override_reason' }, 'biller', key);
    await refused(c, cashFine('1.000', '90.00', { cash_override_reason: 'the customer paid ten people in cash' }), { status: 403, code: 'JV_FORBIDDEN', field: 'cash_override_reason' }, 'biller');
    const ok = await settle(w, 'owner', c, payload, key);
    expect(ok.statusCode, ok.body).toBe(201);
    // a reason under 10 or over 500 characters is refused for everybody (Z1)
    await refused(c, silver('1.000', { cash_override_reason: 'too short' }), { status: 422, code: 'JV_INVALID_INPUT', field: 'cash_override_reason' });
    await refused(c, silver('1.000', { cash_override_reason: 'x'.repeat(501) }), { status: 422, code: 'JV_INVALID_INPUT', field: 'cash_override_reason' });
  });
});

describe('X3 the answer is what the wire says (S3): weight and money as text, the receipt and allocations in the sync form of the caller\'s role', () => {
  it('no JSON number in a money or weight field of the answer or of the stored result; the keys are those of the sync read', async () => {
    const c = await addCustomer(w);
    await addFineBill(w, c, '100.00', '10.000', '2026-10-10');
    const key = newKey();
    const res = await settle(w, 'biller', c, cashFine('4.000', '90.00'), key);
    const r = await settled(res);
    for (const v of [r.receipt.amount, r.receipt.fine_grams, r.receipt.silver_rate, r.fine_remaining, r.allocations[0].amount, r.allocations[0].fine_grams]) expect(typeof v).toBe('string');
    expect(r.receipt.is_opening).toBe(false);
    expect(Object.keys(r.receipt).sort()).toEqual(['amount', 'cash_override_reason', 'created_at', 'created_by', 'customer_id', 'fine_grams', 'id', 'is_opening', 'kind', 'mode', 'notes', 'paid_on', 'reference', 'silver_rate', 'status', 'updated_at', 'updated_by', 'void_reason', 'voided_at', 'voided_by', 'voided_on']);
    expect(Object.keys(r).sort()).toEqual(['allocations', 'fine_remaining', 'receipt']);
    const [claim] = await rows(w, 'SELECT result FROM sys_idempotency WHERE request_id = ?', [key]);
    const stored = typeof claim.result === 'string' ? JSON.parse(claim.result) : claim.result;
    expect(stored).toEqual(r);
    expect(errorField(res)).toBeUndefined();
  });
});

// last in the file: the API clock never runs backwards (S5), so this moves it forward and leaves it there
describe('L5 + Y8 a retry after midnight in India with the same key is the first answer, not a refusal of the date (the repeat is answered before any date is checked)', () => {
  it('a biller settles at 15:30 on the 17th; at 00:30 on the 18th the same call with the same key is the stored answer with Idempotent-Replay: true, and a NEW key with paid_on of the 17th is refused', async () => {
    const c = await addCustomer(w);
    await addFineBill(w, c, '100.00', '10.000', '2026-10-10');
    const key = newKey();
    const first = await settle(w, 'biller', c, silver('1.000', { paid_on: TODAY }), key);
    expect(first.statusCode, first.body).toBe(201);
    w.time.time.micros = AFTER_MIDNIGHT_IN_INDIA;
    const again = await settle(w, 'biller', c, silver('1.000', { paid_on: TODAY }), key);
    expect(again.statusCode, again.body).toBe(201);
    expect(again.headers['idempotent-replay']).toBe('true');
    expect(body(again).receipt.paid_on).toBe(TODAY);
    const fresh = await settle(w, 'biller', c, silver('1.000', { paid_on: TODAY }));
    expect(refusal(fresh)).toMatchObject({ status: 422, code: 'JV_INVALID_INPUT', field: 'paid_on' }); // a biller may use only today, and today is the 18th now
    expect((await receiptsOf(w, c)).length).toBe(1);
  });
});
