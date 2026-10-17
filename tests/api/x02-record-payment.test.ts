import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { V, insert } from '../schema/support';
import { timestampToWire } from '../../src/wire/format';
import { AFTER_MIDNIGHT_IN_INDIA } from './edit-13b-support';
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
  footprint,
  i10Holds,
  newKey,
  paid,
  pay,
  pendingAgrees,
  pendingByBill,
  receiptsOf,
  refusal,
  requestIdOf,
  rows,
  stamp,
} from './x02-support';

// API22, X2 record_payment (POST /v1/customers/:id/payments; X2, Y1, Y3, Y4, Y5, K5, D13, D14, D23): the receipt, its allocation by Y3 (the named bill first, then the oldest), the remainder kept as an
// advance and reported, the walk-in's rules, the repeat-safety of the key, and the clauses of T-A09, T-D14 (in x02-audit.test.ts) and T-D09 for this function. The two-session test T-C09 is in
// x02-two-sessions.test.ts. The cash rules of section 13 are API23's: none is tested here.
//
// The world is the scratch database of the other money tests: the real routes, the seeds (the walk-in customer among them), a clock fixed at 17 Oct 2026 10:00 UTC (15:30 in Kolkata, so "today" is
// 2026-10-17). A customer's history is typed in by SQL (the way the import writes it), with stamps earlier than the API clock's. Expected figures are written in the test, never read back from the
// code under test; the books are checked with V1, V2 and I10 of the database half, which are another opinion.

let w: EditWorld;

beforeAll(async () => {
  w = await editWorld('x02pay');
}, 120_000);
afterAll(async () => {
  await w?.world.close();
}, 60_000);

/** The refusal is exactly this, and the call left no trace: no receipt, no allocation, no claim, no audit row, no stamp (the claim rolls back with the rest). */
async function refused(customer: string, payload: unknown, expected: { status: number; code: string; field?: string }, caller: 'owner' | 'biller' = 'owner', key = newKey()): Promise<void> {
  const before = await footprint(w);
  const res = await pay(w, caller, customer, payload, key);
  expect(refusal(res), res.body).toMatchObject({ status: expected.status, code: expected.code, ...(expected.field === undefined ? {} : { field: expected.field }) });
  expect(await footprint(w), 'a refused payment leaves no trace').toEqual(before);
}

const money = (amount: string, extra: Record<string, unknown> = {}) => ({ amount, mode: 'UPI', ...extra });

describe('T-B01 a payment with mode Credit is rejected everywhere: in record_payment and by a direct SQL insert (D13, Y2)', () => {
  it('record_payment: Credit, credit, a blank mode, no mode and a number are 422 on mode; nothing is saved and the key is not used up', async () => {
    const c = await addCustomer(w);
    await addBill(w, c, '100.00', '2026-10-10');
    const key = newKey();
    for (const mode of ['Credit', 'credit', 'CREDIT', '', ' Cash', 'Cheque', 5, null, ['Cash']]) {
      await refused(c, { amount: '10.00', mode }, { status: 422, code: 'JV_INVALID_INPUT', field: 'mode' }, 'owner', key);
    }
    await refused(c, { amount: '10.00' }, { status: 422, code: 'JV_INVALID_INPUT', field: 'mode' }, 'owner', key);
    // the same key is still free: the first good call with it is the first call
    const ok = await pay(w, 'owner', c, money('10.00'), key);
    expect(ok.statusCode, ok.body).toBe(201);
    expect(ok.headers['idempotent-replay']).toBeUndefined();
  });

  it('the five modes are saved as they were sent: a money receipt of that mode (Y1)', async () => {
    const c = await addCustomer(w);
    for (const mode of ['Cash', 'UPI', 'Card', 'Bank Transfer', 'Other']) {
      const r = await paid(await pay(w, 'owner', c, { amount: '5.00', mode }));
      expect(r.receipt).toMatchObject({ kind: 'money', mode, amount: '5.00', fine_grams: '0.000', silver_rate: null, is_opening: false, status: 'active' });
    }
    const stored = await receiptsOf(w, c);
    expect(stored.map((r) => r.mode).sort()).toEqual(['Bank Transfer', 'Card', 'Cash', 'Other', 'UPI']);
    expect(stored.every((r) => r.kind === 'money' && r.status === 'active' && r.is_opening === 0 && r.silver_rate === null && r.fine_grams === '0.000')).toBe(true);
  });

  it('a direct SQL insert of a receipt with mode Credit is refused by the CHECK of D13 (error 4025); so is a money receipt with no mode, with amount 0 and with a negative amount', async () => {
    const c = await addCustomer(w);
    const before = (await receiptsOf(w, c)).length;
    for (const bad of [{ mode: 'Credit' }, { mode: 'credit' }, { mode: null }, { amount: '0.00' }, { amount: '-1.00' }]) {
      await expect(insert(w.world.sql, 'receipts', V.receipt(c, { mode: 'UPI', ...bad })), JSON.stringify(bad)).rejects.toMatchObject({ errno: 4025 });
    }
    expect((await receiptsOf(w, c)).length).toBe(before);
  });
});

describe('T-B04 record_payment with a named bill fills it first, then the oldest, then keeps an advance; the result reports each part (Y3, Y5, X2)', () => {
  it('three bills 500 (1 Oct), 300 (5 Oct), 400 (10 Oct) and 1,500 paid naming the newest: it takes 400, then the oldest 500, then 300; 300 is kept as an advance and the answer says so', async () => {
    const c = await addCustomer(w);
    const [a, b, n] = [await addBill(w, c, '500.00', '2026-10-01'), await addBill(w, c, '300.00', '2026-10-05'), await addBill(w, c, '400.00', '2026-10-10')];
    const res = await pay(w, 'owner', c, money('1500.00', { bill_id: n, reference: 'UPI-77', notes: 'paid at the counter' }));
    const r = await paid(res);
    expect(r.allocations.map((x) => [x.bill_id, x.amount])).toEqual([
      [n, '400.00'],
      [a, '500.00'],
      [b, '300.00'],
    ]);
    expect(r.advance_remaining).toBe('300.00');
    expect(r.receipt).toMatchObject({ customer_id: c, kind: 'money', mode: 'UPI', amount: '1500.00', paid_on: TODAY, reference: 'UPI-77', notes: 'paid at the counter', status: 'active', is_opening: false });
    for (const x of r.allocations) expect(x).toMatchObject({ receipt_id: r.receipt.id, customer_id: c, fine_grams: '0.000', released_at: null });
    // the tables say the same
    const asRows = (list: Record<string, any>[]) => list.map((x) => [x.id, x.bill_id, x.amount, x.receipt_id].join(' ')).sort();
    expect(asRows(await allocationsOf(w, c)), 'the answer holds the rows the tables hold').toEqual(asRows(r.allocations));
    expect(await pendingByBill(w, c)).toEqual({ [a]: '0.00', [b]: '0.00', [n]: '0.00' });
    expect(await figures(w, c)).toEqual({ outstanding: '0.00', advance: '300.00', fine_outstanding: '0.000', fine_advance: '0.000' });
    await pendingAgrees(w, c);
    await i10Holds(w, c);
  });

  it('a part payment that names the middle bill: it takes its 300, the rest goes to the oldest; the newest is untouched and nothing is kept as an advance', async () => {
    const c = await addCustomer(w);
    const [a, b, n] = [await addBill(w, c, '500.00', '2026-10-01'), await addBill(w, c, '300.00', '2026-10-05'), await addBill(w, c, '400.00', '2026-10-10')];
    const r = await paid(await pay(w, 'owner', c, money('600.00', { bill_id: b })));
    expect(r.allocations.map((x) => [x.bill_id, x.amount])).toEqual([
      [b, '300.00'],
      [a, '300.00'],
    ]);
    expect(r.advance_remaining).toBe('0.00');
    expect(await pendingByBill(w, c)).toEqual({ [a]: '200.00', [b]: '0.00', [n]: '400.00' });
    expect(await figures(w, c)).toMatchObject({ outstanding: '600.00', advance: '0.00' });
    await i10Holds(w, c);
  });

  it('a payment smaller than the named bill: all of it goes to that bill, which stays part paid', async () => {
    const c = await addCustomer(w);
    const [a, b] = [await addBill(w, c, '500.00', '2026-10-01'), await addBill(w, c, '300.00', '2026-10-05')];
    const r = await paid(await pay(w, 'owner', c, money('120.50', { bill_id: b })));
    expect(r.allocations.map((x) => [x.bill_id, x.amount])).toEqual([[b, '120.50']]);
    expect(r.advance_remaining).toBe('0.00');
    expect(await pendingByBill(w, c)).toEqual({ [a]: '500.00', [b]: '179.50' });
  });

  it('a customer with nothing pending: the whole payment is an advance, no allocation is made, and the answer says how much is kept (Y5)', async () => {
    const c = await addCustomer(w);
    const r = await paid(await pay(w, 'biller', c, money('250.00')));
    expect(r.allocations).toEqual([]);
    expect(r.advance_remaining).toBe('250.00');
    expect(r.receipt).toMatchObject({ amount: '250.00', kind: 'money' });
    expect(await allocationsOf(w, c)).toEqual([]);
    expect(await figures(w, c)).toEqual({ outstanding: '0.00', advance: '250.00', fine_outstanding: '0.000', fine_advance: '0.000' });
    await i10Holds(w, c);
  });

  it('advance_remaining is what is left of THIS payment: 100 already held and 50 more makes an advance of 150 in the books, and the answer says 50', async () => {
    const c = await addCustomer(w);
    await addMoney(w, c, '100.00', '2026-10-10');
    const r = await paid(await pay(w, 'owner', c, money('50.00')));
    expect(r.advance_remaining).toBe('50.00');
    expect(r.allocations).toEqual([]);
    expect(await figures(w, c)).toMatchObject({ outstanding: '0.00', advance: '150.00' });
  });

  it('a payment of exactly what is pending pays the bill off and keeps no advance; a cancelled bill and a voided receipt take no part', async () => {
    const c = await addCustomer(w);
    const live = await addBill(w, c, '700.00', '2026-10-03');
    await addCancelledBill(w, c, '9999.00', '2026-10-01');
    await addMoney(w, c, '5000.00', '2026-10-02', { status: 'voided', void_reason: 'wrong', voided_at: stamp('2026-10-03'), voided_on: '2026-10-03', voided_by: w.world.fixtures.owner.userId });
    const r = await paid(await pay(w, 'owner', c, money('700.00')));
    expect(r.allocations.map((x) => [x.bill_id, x.amount])).toEqual([[live, '700.00']]);
    expect(r.advance_remaining).toBe('0.00');
    expect(await figures(w, c)).toMatchObject({ outstanding: '0.00', advance: '0.00' });
    await i10Holds(w, c);
  });

  it('a bill that has only SILVER pending takes no money: it is not "something pending" for a money payment (Y3)', async () => {
    const c = await addCustomer(w);
    const silver = await addBill(w, c, '100.00', '2026-10-01', { fine_weight_due: '12.000' });
    await addAllocation(w, await addMoney(w, c, '100.00', '2026-10-02'), silver, c, '100.00'); // the money is paid, 12 g of silver is still due
    const money1 = await addBill(w, c, '200.00', '2026-10-05');
    const r = await paid(await pay(w, 'owner', c, money('300.00')));
    expect(r.allocations.map((x) => [x.bill_id, x.amount])).toEqual([[money1, '200.00']]);
    expect(r.advance_remaining).toBe('100.00');
    await refused(c, money('10.00', { bill_id: silver }), { status: 422, code: 'JV_INVALID_INPUT', field: 'bill_id' });
    expect(await figures(w, c)).toMatchObject({ outstanding: '0.00', advance: '100.00', fine_outstanding: '12.000' });
  });

  it('the answer is the same shape for a biller and an owner, and the receipt carries the person and the one stamp of the call', async () => {
    const c = await addCustomer(w);
    const bill = await addBill(w, c, '100.00', '2026-10-10');
    const res = await pay(w, 'biller', c, money('100.00'));
    const r = await paid(res);
    expect(Object.keys(r).sort()).toEqual(['advance_remaining', 'allocations', 'receipt']);
    expect(r.receipt.created_by).toBe(w.world.fixtures.biller.userId);
    expect(r.receipt.updated_by).toBe(w.world.fixtures.biller.userId);
    expect(r.receipt.created_at).toBe(r.receipt.updated_at);
    expect(r.allocations[0].created_at).toBe(r.receipt.created_at); // one reading of the API clock stamps the whole call
    expect(r.allocations[0].bill_id).toBe(bill);
    expect(requestIdOf(res)).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.headers['cache-control']).toBe('no-store');
  });
});

describe('T-B05 "apply to oldest" really allocates; the sum of bill pending equals the customer\'s outstanding; an opening-balance bill is paid first (Y3, Y9, D15, V2)', () => {
  it('opening balance 700 (cut-over 1 Apr), bills 400 (1 Sep) and 600 (1 Oct): 900 with no bill named pays the opening bill, then 200 of the September bill', async () => {
    const c = await addCustomer(w);
    const ob = await addOpeningBill(w, c, '700.00');
    const sep = await addBill(w, c, '400.00', '2026-09-01');
    const oct = await addBill(w, c, '600.00', '2026-10-01');
    expect(await figures(w, c)).toMatchObject({ outstanding: '1700.00' });
    await pendingAgrees(w, c);
    const r = await paid(await pay(w, 'owner', c, money('900.00')));
    expect(r.allocations.map((x) => [x.bill_id, x.amount])).toEqual([
      [ob, '700.00'],
      [sep, '200.00'],
    ]);
    expect(r.advance_remaining).toBe('0.00');
    expect(await pendingByBill(w, c)).toEqual({ [ob]: '0.00', [sep]: '200.00', [oct]: '600.00' });
    expect(await figures(w, c)).toMatchObject({ outstanding: '800.00', advance: '0.00' });
    await pendingAgrees(w, c); // V1 summed is V2's outstanding: the allocation is real (the prototype applied it to nothing, LED-04)
    // a second payment of 1,000: the rest of September, all of October, 200 kept
    const r2 = await paid(await pay(w, 'owner', c, money('1000.00')));
    expect(r2.allocations.map((x) => [x.bill_id, x.amount])).toEqual([
      [sep, '200.00'],
      [oct, '600.00'],
    ]);
    expect(r2.advance_remaining).toBe('200.00');
    await pendingAgrees(w, c);
    expect(await figures(w, c)).toMatchObject({ outstanding: '0.00', advance: '200.00' });
    await i10Holds(w, c);
  });

  it('a named bill goes before an opening-balance bill; the opening bill is then still the oldest of the rest', async () => {
    const c = await addCustomer(w);
    const ob = await addOpeningBill(w, c, '300.00');
    const named = await addBill(w, c, '200.00', '2026-10-05');
    const r = await paid(await pay(w, 'owner', c, money('350.00', { bill_id: named })));
    expect(r.allocations.map((x) => [x.bill_id, x.amount])).toEqual([
      [named, '200.00'],
      [ob, '150.00'],
    ]);
    await pendingAgrees(w, c);
  });

  it('after each of 30 payments of odd sizes on five bills the pending of the bills is the outstanding of V2 and I10 holds', async () => {
    const c = await addCustomer(w);
    await addOpeningBill(w, c, '1234.56');
    for (const [amount, date] of [['333', '2026-08-01'], ['777', '2026-09-09'], ['1001', '2026-09-30'], ['58', '2026-10-05']] as const) await addBill(w, c, `${amount}.00`, date);
    let pending = 1234_56n + 333_00n + 777_00n + 1001_00n + 58_00n;
    let kept = 0n;
    for (let i = 1; i <= 30; i++) {
      const cents = BigInt(((i * 7919) % 90_000) + 1); // 0.01 to 900.00
      const text = `${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`;
      const r = await paid(await pay(w, i % 2 ? 'owner' : 'biller', c, money(text)));
      const applied = r.allocations.reduce((n, x) => n + BigInt(String(x.amount).replace('.', '')), 0n);
      expect(applied, `payment ${i}: the payment pays what is pending, up to its own size`).toBe(pending < cents ? pending : cents);
      pending -= applied;
      kept += cents - applied;
      expect(BigInt(r.advance_remaining.replace('.', ''))).toBe(cents - applied);
      await pendingAgrees(w, c);
    }
    expect((await figures(w, c)).advance).toBe(`${kept / 100n}.${String(kept % 100n).padStart(2, '0')}`);
    await i10Holds(w, c);
  });
});

describe('T-B06 a receipt of customer B cannot be allocated to customer A\'s bill, even by a direct insert; a named bill of another customer is refused (D14, Y4, X2)', () => {
  it('a direct insert of an allocation that joins B\'s receipt and A\'s bill is refused by the composite foreign keys, whichever customer id it carries (error 1452)', async () => {
    const [a, b] = [await addCustomer(w), await addCustomer(w)];
    const billA = await addBill(w, a, '100.00', '2026-10-10');
    const receiptB = await addMoney(w, b, '100.00', '2026-10-11');
    for (const owner of [a, b]) {
      await expect(insert(w.world.sql, 'receipt_allocations', V.allocation(receiptB, billA, owner, { amount: '50.00' })), `carrying the customer id of ${owner === a ? 'A' : 'B'}`).rejects.toMatchObject({ errno: 1452 });
    }
    expect(await allocationsOf(w, a)).toEqual([]);
    expect(await allocationsOf(w, b)).toEqual([]);
    // the same customer is fine: the keys refuse the join of two customers and nothing else
    await insert(w.world.sql, 'receipt_allocations', V.allocation(await addMoney(w, a, '100.00', '2026-10-11'), billA, a, { amount: '50.00' }));
  });

  it('record_payment for B naming A\'s bill is 422 on bill_id; nothing is saved for either customer', async () => {
    const [a, b] = [await addCustomer(w), await addCustomer(w)];
    const billA = await addBill(w, a, '100.00', '2026-10-10');
    await addBill(w, b, '100.00', '2026-10-10');
    await refused(b, money('100.00', { bill_id: billA }), { status: 422, code: 'JV_INVALID_INPUT', field: 'bill_id' });
    expect(await receiptsOf(w, a)).toEqual([]);
    expect(await receiptsOf(w, b)).toEqual([]);
    expect(await pendingByBill(w, a)).toEqual({ [billA]: '100.00' });
  });

  it('a payment for A never pays B\'s bills, however old they are', async () => {
    const [a, b] = [await addCustomer(w), await addCustomer(w)];
    const billB = await addBill(w, b, '100.00', '2026-01-01'); // far older than anything of A
    const billA = await addBill(w, a, '100.00', '2026-10-10');
    const r = await paid(await pay(w, 'owner', a, money('300.00')));
    expect(r.allocations.map((x) => x.bill_id)).toEqual([billA]);
    expect(r.advance_remaining).toBe('200.00');
    expect(await pendingByBill(w, b)).toEqual({ [billB]: '100.00' });
    expect(await allocationsOf(w, b)).toEqual([]);
  });
});

describe('T-B22 tie-breaks: allocation goes by bill date, then created time, then id; an advance is applied oldest receipt first; a named bill that is paid, cancelled or another customer\'s is JV_INVALID_INPUT (Y3, Y6)', () => {
  it('bill date first: a bill dated earlier is paid first although it was typed in later', async () => {
    const c = await addCustomer(w);
    const newer = await addBill(w, c, '100.00', '2026-10-05', { created_at: stamp('2026-10-01', 1), updated_at: stamp('2026-10-01', 1) });
    const older = await addBill(w, c, '100.00', '2026-10-01', { created_at: stamp('2026-10-06', 2), updated_at: stamp('2026-10-06', 2) });
    const r = await paid(await pay(w, 'owner', c, money('150.00')));
    expect(r.allocations.map((x) => [x.bill_id, x.amount])).toEqual([
      [older, '100.00'],
      [newer, '50.00'],
    ]);
  });

  it('created time second: two bills of one date, the one created earlier is paid first', async () => {
    const c = await addCustomer(w);
    const late = await addBill(w, c, '100.00', '2026-10-05', { created_at: stamp('2026-10-05', 9), updated_at: stamp('2026-10-05', 9) });
    const early = await addBill(w, c, '100.00', '2026-10-05', { created_at: stamp('2026-10-05', 3), updated_at: stamp('2026-10-05', 3) });
    const r = await paid(await pay(w, 'owner', c, money('150.00')));
    expect(r.allocations.map((x) => [x.bill_id, x.amount])).toEqual([
      [early, '100.00'],
      [late, '50.00'],
    ]);
  });

  it('id last: two bills with the same date and the same created time are paid in the order of the database\'s id, which is not the order of the ids as text', async () => {
    const SQL_FIRST = '00000001-0000-4000-8000-000000000000'; // before the other in MariaDB's UUID order, after it as text (X0 item 5)
    const TEXT_FIRST = '00000000-0000-4000-8000-000000000001';
    const c = await addCustomer(w);
    const same = { created_at: stamp('2026-10-05', 5), updated_at: stamp('2026-10-05', 5) };
    await addBill(w, c, '100.00', '2026-10-05', { id: TEXT_FIRST, ...same });
    await addBill(w, c, '100.00', '2026-10-05', { id: SQL_FIRST, ...same });
    const [first] = await rows(w, 'SELECT id FROM bills WHERE id IN (?, ?) ORDER BY id LIMIT 1', [TEXT_FIRST, SQL_FIRST]);
    expect(String(first.id), 'the two ids sort differently in SQL and as text, or this test proves nothing').toBe(SQL_FIRST);
    expect([TEXT_FIRST, SQL_FIRST].sort()[0]).toBe(TEXT_FIRST);
    const r = await paid(await pay(w, 'owner', c, money('150.00')));
    expect(r.allocations.map((x) => [x.bill_id, x.amount])).toEqual([
      [SQL_FIRST, '100.00'],
      [TEXT_FIRST, '50.00'],
    ]);
  });

  it('an advance the customer already holds is applied oldest receipt first by the rebalance of the same call (Y6), after the payment\'s own allocation', async () => {
    const c = await addCustomer(w);
    // a state the import can leave behind: 500 pending and 400 of unspent money (two receipts, typed newest first); a payment of 100 then has the rebalance spend the old money, oldest first
    const bill = await addBill(w, c, '500.00', '2026-10-01');
    const r5 = await addMoney(w, c, '200.00', '2026-10-05');
    const r2 = await addMoney(w, c, '200.00', '2026-10-02');
    const r = await paid(await pay(w, 'owner', c, money('100.00')));
    expect(r.allocations.map((x) => [x.receipt_id === r.receipt.id ? 'new' : x.receipt_id, x.bill_id, x.amount])).toEqual([
      ['new', bill, '100.00'], // the payment's own allocation comes first (X2: allocates, then rebalances)
      [r2, bill, '200.00'], // then the oldest receipt (2 Oct)
      [r5, bill, '200.00'], // then the next (5 Oct)
    ]);
    expect(r.advance_remaining).toBe('0.00');
    expect(await figures(w, c)).toEqual({ outstanding: '0.00', advance: '0.00', fine_outstanding: '0.000', fine_advance: '0.000' });
    await i10Holds(w, c);
  });

  it('a named bill that is paid, cancelled, another customer\'s, not a bill at all, or in the wrong form is 422 JV_INVALID_INPUT on bill_id and nothing is saved', async () => {
    const [c, other] = [await addCustomer(w), await addCustomer(w)];
    const open = await addBill(w, c, '100.00', '2026-10-10');
    const settled = await addBill(w, c, '100.00', '2026-10-02');
    await addAllocation(w, await addMoney(w, c, '100.00', '2026-10-03'), settled, c, '100.00');
    const cancelled = await addCancelledBill(w, c, '100.00', '2026-10-01');
    const foreign = await addBill(w, other, '100.00', '2026-10-01');
    for (const id of [settled, cancelled, foreign, randomUUID()]) await refused(c, money('10.00', { bill_id: id }), { status: 422, code: 'JV_INVALID_INPUT', field: 'bill_id' });
    for (const bad of ['not-a-uuid', '', 5, open.toUpperCase()]) await refused(c, money('10.00', { bill_id: bad }), { status: 422, code: 'JV_INVALID_INPUT', field: 'bill_id' });
    // the open bill and a null are fine
    expect((await pay(w, 'owner', c, money('10.00', { bill_id: open }))).statusCode).toBe(201);
    expect((await pay(w, 'owner', c, money('10.00', { bill_id: null }))).statusCode).toBe(201);
  });
});

describe('T-B17 (the clause of X2) the walk-in customer never holds an advance: a payment above the named bill\'s pending, or without a named bill, is JV_OVERPAYMENT (K5)', () => {
  it('without a named bill: 409 JV_OVERPAYMENT, nothing is saved, whatever the amount', async () => {
    await addBill(w, WALKIN, '1000.00', '2026-10-10');
    for (const amount of ['1.00', '500.00', '5000.00']) await refused(WALKIN, money(amount), { status: 409, code: 'JV_OVERPAYMENT' });
  });

  it('above the named bill\'s pending by one paisa: 409 JV_OVERPAYMENT; nothing is saved; the older bills of other strangers are not paid instead', async () => {
    const old = await addBill(w, WALKIN, '400.00', '2026-01-01');
    const bill = await addBill(w, WALKIN, '1000.00', '2026-10-10');
    await refused(WALKIN, money('1000.01', { bill_id: bill }), { status: 409, code: 'JV_OVERPAYMENT' });
    await refused(WALKIN, money('5000.00', { bill_id: bill }), { status: 409, code: 'JV_OVERPAYMENT' });
    expect((await pendingByBill(w, WALKIN))[old]).toBe('400.00');
    expect((await pendingByBill(w, WALKIN))[bill]).toBe('1000.00');
  });

  it('exactly the pending, and less, are saved: all of it goes to the named bill, never to an older one, and no advance is left', async () => {
    const old = await addBill(w, WALKIN, '400.00', '2026-01-02');
    const bill = await addBill(w, WALKIN, '1000.00', '2026-10-10');
    const part = await paid(await pay(w, 'biller', WALKIN, money('250.50', { bill_id: bill })));
    expect(part.allocations.map((x) => [x.bill_id, x.amount])).toEqual([[bill, '250.50']]);
    expect(part.advance_remaining).toBe('0.00');
    const rest = await paid(await pay(w, 'owner', WALKIN, money('749.50', { bill_id: bill })));
    expect(rest.allocations.map((x) => [x.bill_id, x.amount])).toEqual([[bill, '749.50']]);
    expect(rest.advance_remaining).toBe('0.00');
    const pending = await pendingByBill(w, WALKIN);
    expect(pending[bill]).toBe('0.00');
    expect(pending[old]).toBe('400.00');
    expect((await figures(w, WALKIN)).advance).toBe('0.00');
    // the bill is paid: naming it again is a mistake of the screen (422), not an overpayment
    await refused(WALKIN, money('1.00', { bill_id: bill }), { status: 422, code: 'JV_INVALID_INPUT', field: 'bill_id' });
  });

  it('a named bill that is not the walk-in\'s is still 422 (the named-bill rule comes first), and a named customer is not held to the walk-in rule', async () => {
    const c = await addCustomer(w);
    const foreign = await addBill(w, c, '100.00', '2026-10-10');
    await refused(WALKIN, money('10.00', { bill_id: foreign }), { status: 422, code: 'JV_INVALID_INPUT', field: 'bill_id' });
    const r = await paid(await pay(w, 'owner', c, money('150.00'))); // a named customer may overpay: the rest is an advance
    expect(r.advance_remaining).toBe('50.00');
  });

  it('the books of the walk-in satisfy I10 after all of it: no advance, no negative figure', async () => {
    await i10Holds(w, WALKIN);
  });
});

describe('T-A09 (the clause of X2) a negative, zero, over-cap or badly written payment amount reaches no row', () => {
  it('-5.00, 0, 0.00, 1000000000.01, 1.234, .5, 5., +5, 1e3, a number, null, a list and nothing are 422 on amount; the receipt, the claim and the audit log are untouched', async () => {
    const c = await addCustomer(w);
    await addBill(w, c, '100.00', '2026-10-10');
    for (const amount of ['-5.00', '0', '0.00', '1000000000.01', '1.234', '.5', '5.', '+5', '1e3', ' 7.50 ', '', 'abc', 5, 5.5, null, [5], { v: 5 }, true]) {
      await refused(c, { amount, mode: 'Cash' }, { status: 422, code: 'JV_INVALID_INPUT', field: 'amount' });
    }
    await refused(c, { mode: 'Cash' }, { status: 422, code: 'JV_INVALID_INPUT', field: 'amount' });
    expect(await receiptsOf(w, c)).toEqual([]);
  });

  it('the largest amount of the cap, 1,000,000,000.00, is a payment (the rest is an advance); 0.01 is the smallest', async () => {
    const [big, small] = [await addCustomer(w), await addCustomer(w)];
    expect((await paid(await pay(w, 'owner', big, money('1000000000.00')))).advance_remaining).toBe('1000000000.00');
    const bill = await addBill(w, small, '100.00', '2026-10-10');
    const r = await paid(await pay(w, 'owner', small, money('0.01')));
    expect(r.allocations.map((x) => [x.bill_id, x.amount])).toEqual([[bill, '0.01']]);
    expect(await pendingByBill(w, small)).toEqual({ [bill]: '99.99' });
  });

  it('a field this call does not take, a text in the notes that is too long and a reference over 120 characters are 422 on that field', async () => {
    const c = await addCustomer(w);
    await refused(c, money('10.00', { surprise: 1 }), { status: 422, code: 'JV_INVALID_INPUT', field: 'surprise' });
    await refused(c, money('10.00', { customer_id: c }), { status: 422, code: 'JV_INVALID_INPUT', field: 'customer_id' }); // the customer is the one in the path, never in the body
    await refused(c, money('10.00', { reference: 'x'.repeat(121) }), { status: 422, code: 'JV_INVALID_INPUT', field: 'reference' });
    await refused(c, money('10.00', { notes: 'x'.repeat(10_001) }), { status: 422, code: 'JV_INVALID_INPUT', field: 'notes' });
    await refused(c, money('10.00', { paid_on: '17/10/2026' }), { status: 422, code: 'JV_INVALID_INPUT', field: 'paid_on' });
    const ok = await paid(await pay(w, 'owner', c, money('10.00', { reference: ' R-1 ', notes: '', paid_on: null })));
    expect(ok.receipt).toMatchObject({ reference: 'R-1', notes: null, paid_on: TODAY });
  });
});

describe('Y8 the date of a payment: today by default; a biller only today; the owner any day up to today; never the future', () => {
  it('paid_on absent or null is today (Asia/Kolkata, from the API clock); today written out is fine', async () => {
    const c = await addCustomer(w);
    for (const extra of [{}, { paid_on: null }, { paid_on: TODAY }]) expect((await paid(await pay(w, 'biller', c, money('1.00', extra)))).receipt.paid_on).toBe(TODAY);
  });

  it('a past date from a biller is 422 on paid_on; from the owner it is saved with that date', async () => {
    const c = await addCustomer(w);
    await refused(c, money('1.00', { paid_on: '2026-10-15' }), { status: 422, code: 'JV_INVALID_INPUT', field: 'paid_on' }, 'biller');
    const r = await paid(await pay(w, 'owner', c, money('1.00', { paid_on: '2026-10-15' })));
    expect(r.receipt.paid_on).toBe('2026-10-15');
    expect((await receiptsOf(w, c))[0].paid_on).toBe('2026-10-15');
  });

  it('tomorrow is 422 for the owner and the biller alike', async () => {
    const c = await addCustomer(w);
    for (const caller of ['owner', 'biller'] as const) await refused(c, money('1.00', { paid_on: '2026-10-18' }), { status: 422, code: 'JV_INVALID_INPUT', field: 'paid_on' }, caller);
  });

  it('a payment dated before an advance the customer holds still allocates first: the call\'s own allocation comes before the rebalance, whatever the dates (X2)', async () => {
    const c = await addCustomer(w);
    const bill = await addBill(w, c, '300.00', '2026-10-01');
    const held = await addMoney(w, c, '100.00', '2026-10-10'); // an old unspent receipt, dated 10 Oct
    const r = await paid(await pay(w, 'owner', c, money('100.00', { paid_on: '2026-10-05' }), newKey())); // the new receipt is dated 5 Oct: older than the held one
    expect(r.allocations.map((x) => [x.receipt_id === r.receipt.id ? 'new' : x.receipt_id, x.amount])).toEqual([
      ['new', '100.00'],
      [held, '100.00'],
    ]);
    expect(await pendingByBill(w, c)).toEqual({ [bill]: '100.00' });
  });
});

describe('D23 touches: the bills that received money and the customer carry the stamp of the call, and no other bill does', () => {
  it('the paid bills and the customer have updated_at = the receipt\'s created_at; a bill that got nothing is not touched; a pure advance touches the customer', async () => {
    const c = await addCustomer(w);
    const [a, b, n] = [await addBill(w, c, '100.00', '2026-10-01'), await addBill(w, c, '100.00', '2026-10-05'), await addBill(w, c, '100.00', '2026-10-10')];
    const beforeN = (await billRow(w, n)).updated_at;
    const beforeCustomer = (await customerRow(w, c)).updated_at;
    const r = await paid(await pay(w, 'owner', c, money('150.00')));
    const stampOfCall = r.receipt.created_at; // wire form: 2026-10-17T10:00:00.000000Z
    const wire = (db: string) => timestampToWire(db);
    expect(wire((await billRow(w, a)).updated_at)).toBe(stampOfCall);
    expect(wire((await billRow(w, b)).updated_at)).toBe(stampOfCall);
    expect((await billRow(w, n)).updated_at, 'a bill that received nothing is not touched').toBe(beforeN);
    const customerStamp = (await customerRow(w, c)).updated_at;
    expect(customerStamp).not.toBe(beforeCustomer);
    expect(wire(customerStamp)).toBe(stampOfCall);
    // a payment that allocates nothing still moves the customer's figures (the advance), so it touches the customer
    const lone = await addCustomer(w);
    const before = (await customerRow(w, lone)).updated_at;
    const pure = await paid(await pay(w, 'owner', lone, money('40.00')));
    expect(wire((await customerRow(w, lone)).updated_at)).toBe(pure.receipt.created_at);
    expect((await customerRow(w, lone)).updated_at).not.toBe(before);
  });

  it('the touches change nothing else on the bill: its figures, its number and who edited it stay as they were', async () => {
    const c = await addCustomer(w);
    const a = await addBill(w, c, '100.00', '2026-10-01');
    const before = await billRow(w, a);
    await paid(await pay(w, 'owner', c, money('60.00')));
    const after = await billRow(w, a);
    const { updated_at: _u1, ...rest1 } = before;
    const { updated_at: _u2, ...rest2 } = after;
    expect(rest2).toEqual(rest1);
  });
});

describe('X2 the customer: a path id that is not a customer is 404, a malformed one 422, an archived customer 409 JV_CUSTOMER_ARCHIVED (T-C20: the payment is refused because the customer is archived)', () => {
  it('an id that is no customer is 404 JV_NOT_FOUND and the claim is rolled back', async () => {
    const before = await footprint(w);
    const res = await pay(w, 'owner', randomUUID(), money('10.00'));
    expect(refusal(res)).toMatchObject({ status: 404, code: 'JV_NOT_FOUND' });
    expect(await footprint(w)).toEqual(before);
  });

  it('a path id that is not a lower-case UUID is 422 on id', async () => {
    for (const id of ['not-a-uuid', '12345', randomUUID().toUpperCase()]) {
      const res = await pay(w, 'owner', id, money('10.00'));
      expect(refusal(res), id).toMatchObject({ status: 422, code: 'JV_INVALID_INPUT', field: 'id' });
    }
  });

  it('an archived customer cannot be paid: 409 JV_CUSTOMER_ARCHIVED, nothing is saved; brought back, the payment is saved', async () => {
    const c = await addCustomer(w);
    await w.world.sql.query('UPDATE customers SET archived_at = ? WHERE id = ?', [stamp('2026-10-10'), c]);
    await refused(c, money('10.00'), { status: 409, code: 'JV_CUSTOMER_ARCHIVED' });
    await w.world.sql.query('UPDATE customers SET archived_at = NULL WHERE id = ?', [c]);
    expect((await pay(w, 'owner', c, money('10.00'))).statusCode).toBe(201);
  });
});

describe('L5 repeat-safety of record_payment (the clause of T-C05): the same Idempotency-Key makes one receipt and answers the same', () => {
  it('the same key and body twice: one receipt, one set of allocations, the same answer with Idempotent-Replay: true and the same status', async () => {
    const c = await addCustomer(w);
    const bill = await addBill(w, c, '100.00', '2026-10-10');
    const key = newKey();
    const first = await pay(w, 'owner', c, money('60.00', { reference: 'R-9' }), key);
    expect(first.statusCode).toBe(201);
    expect(first.headers['idempotent-replay']).toBeUndefined();
    const again = await pay(w, 'owner', c, money('60.00', { reference: 'R-9' }), key);
    expect(again.statusCode).toBe(201);
    expect(again.headers['idempotent-replay']).toBe('true');
    expect(body(again)).toEqual(body(first));
    expect(await receiptsOf(w, c)).toHaveLength(1);
    expect(await allocationsOf(w, c)).toHaveLength(1);
    expect(await pendingByBill(w, c)).toEqual({ [bill]: '40.00' });
  });

  it('the same key with another amount, another customer, another mode or another caller is refused (422 on the header), and saves nothing', async () => {
    const [c, other] = [await addCustomer(w), await addCustomer(w)];
    await addBill(w, c, '100.00', '2026-10-10');
    const key = newKey();
    await paid(await pay(w, 'owner', c, money('60.00'), key));
    const before = await footprint(w);
    for (const [caller, customer, payload] of [['owner', c, money('61.00')], ['owner', other, money('60.00')], ['owner', c, { amount: '60.00', mode: 'Cash' }], ['biller', c, money('60.00')]] as const) {
      const res = await pay(w, caller, customer, payload, key);
      expect(refusal(res), `${caller} ${JSON.stringify(payload)}`).toMatchObject({ status: 422, code: 'JV_INVALID_INPUT', field: 'Idempotency-Key' });
    }
    expect(await footprint(w)).toEqual(before);
  });

  it('a missing or malformed Idempotency-Key is 422 on the header and claims nothing', async () => {
    const c = await addCustomer(w);
    const before = await footprint(w);
    for (const key of [null, 'abc', '12345']) {
      const res = await pay(w, 'owner', c, money('10.00'), key);
      expect(refusal(res), String(key)).toMatchObject({ status: 422, code: 'JV_INVALID_INPUT', field: 'Idempotency-Key' });
    }
    expect(await footprint(w)).toEqual(before);
  });
});

describe('X0 the order of work inside the transaction, as the statements say it', () => {
  it('claim first, then the customer FOR UPDATE, then the state read ONCE, then the receipt and the allocations, then the touches and the stored result; no lock is taken after a write', async () => {
    const c = await addCustomer(w);
    await addBill(w, c, '100.00', '2026-10-01');
    await addBill(w, c, '100.00', '2026-10-02');
    const from = w.world.spy.sent.length;
    const res = await pay(w, 'owner', c, money('150.00'));
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
    expect(sqls.some((s) => /sys_counters/.test(s)), 'a payment takes no number').toBe(false);
    expect(sqls.some((s) => /\bFROM skus\b|\bFROM sku_private\b/.test(s)), 'a payment reads no piece').toBe(false);
  });

  it('a payment that allocates nothing sends no allocation insert and one touch of the customer only', async () => {
    const c = await addCustomer(w);
    const from = w.world.spy.sent.length;
    await paid(await pay(w, 'owner', c, money('15.00')));
    const sqls = w.world.spy.sqls().slice(from).map((s) => s.trim());
    expect(sqls.filter((s) => /^INSERT INTO receipt_allocations/.test(s))).toEqual([]);
    expect(sqls.filter((s) => /^UPDATE bills\b/.test(s))).toEqual([]);
    expect(sqls.filter((s) => /^UPDATE customers SET updated_at/.test(s))).toHaveLength(1);
  });
});

describe('T-D09 the matrix row of X2 (POST /v1/customers/:id/payments: owner and biller) and its field rules', () => {
  it('the route is registered through route() with the action of the row', () => {
    expect(w.world.app.routeTable.find((r) => r.action === 'fn:record_payment')).toMatchObject({ method: 'POST', url: '/v1/customers/:id/payments', kind: 'matrix', roles: ['owner', 'biller'], mustChange: false });
  });

  it('no session is 401, staff is 403 JV_FORBIDDEN, a user who must change the password is 403 JV_PASSWORD_CHANGE_REQUIRED, and none of them reads or writes the books', async () => {
    for (const [caller, status, code] of [['anon', 401, 'JV_UNAUTHENTICATED'], ['ended', 401, 'JV_UNAUTHENTICATED'], ['expired', 401, 'JV_SESSION_EXPIRED'], ['idle', 401, 'JV_SESSION_EXPIRED'], ['inactive', 401, 'JV_UNAUTHENTICATED'], ['staff', 403, 'JV_FORBIDDEN'], ['must_change', 403, 'JV_PASSWORD_CHANGE_REQUIRED']] as const) {
      const c = await addCustomer(w);
      await addBill(w, c, '100.00', '2026-10-10');
      const from = w.world.spy.sent.length;
      const res = await pay(w, caller, c, money('10.00'));
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
      const r = await paid(await pay(w, caller, c, money('10.00')));
      expect(r.receipt.created_by, caller).toBe(w.world.fixtures[caller].userId);
    }
  });

  it('a biller\'s cash_override_reason is 403 JV_FORBIDDEN naming the field (the owner\'s right, Z1); nothing is saved, and the key stays unused for the owner', async () => {
    const c = await addCustomer(w);
    const key = newKey();
    const payload = money('10.00', { cash_override_reason: 'the customer paid ten people in cash' });
    await refused(c, payload, { status: 403, code: 'JV_FORBIDDEN', field: 'cash_override_reason' }, 'biller', key);
    const ok = await pay(w, 'owner', c, payload, key);
    expect(ok.statusCode, ok.body).toBe(201);
    // a reason under 10 or over 500 characters is refused for everybody (Z1)
    await refused(c, money('10.00', { cash_override_reason: 'too short' }), { status: 422, code: 'JV_INVALID_INPUT', field: 'cash_override_reason' });
    await refused(c, money('10.00', { cash_override_reason: 'x'.repeat(501) }), { status: 422, code: 'JV_INVALID_INPUT', field: 'cash_override_reason' });
  });
});

describe('X2 the answer is what the wire says (S3): money as text, the receipt and allocations in the sync form of the caller\'s role', () => {
  it('no JSON number in a money field of the answer or of the stored result; the keys are those of the sync read', async () => {
    const c = await addCustomer(w);
    await addBill(w, c, '100.00', '2026-10-10');
    const key = newKey();
    const res = await pay(w, 'biller', c, money('130.00'), key);
    const r = await paid(res);
    for (const v of [r.receipt.amount, r.receipt.fine_grams, r.advance_remaining, r.allocations[0].amount, r.allocations[0].fine_grams]) expect(typeof v).toBe('string');
    expect(r.receipt.is_opening).toBe(false);
    expect(Object.keys(r.receipt).sort()).toEqual(['amount', 'cash_override_reason', 'created_at', 'created_by', 'customer_id', 'fine_grams', 'id', 'is_opening', 'kind', 'mode', 'notes', 'paid_on', 'reference', 'silver_rate', 'status', 'updated_at', 'updated_by', 'void_reason', 'voided_at', 'voided_by', 'voided_on']);
    const [claim] = await rows(w, 'SELECT result FROM sys_idempotency WHERE request_id = ?', [key]);
    const stored = typeof claim.result === 'string' ? JSON.parse(claim.result) : claim.result;
    expect(stored).toEqual(r);
    expect(errorField(res)).toBeUndefined();
  });
});

// last in the file: the API clock never runs backwards (S5), so this moves it forward and leaves it there
describe('L5 + Y8 a retry after midnight in India with the same key is the first answer, not a refusal of the date (the repeat is answered before any date is checked)', () => {
  it('a biller pays at 15:30 on the 17th; at 00:30 on the 18th the same call with the same key is the stored answer with Idempotent-Replay: true, and a NEW key with paid_on of the 17th is refused', async () => {
    const c = await addCustomer(w);
    const key = newKey();
    const first = await pay(w, 'biller', c, money('10.00', { paid_on: TODAY }), key);
    expect(first.statusCode, first.body).toBe(201);
    w.time.time.micros = AFTER_MIDNIGHT_IN_INDIA;
    const again = await pay(w, 'biller', c, money('10.00', { paid_on: TODAY }), key);
    expect(again.statusCode, again.body).toBe(201);
    expect(again.headers['idempotent-replay']).toBe('true');
    expect(body(again).receipt.paid_on).toBe(TODAY);
    const fresh = await pay(w, 'biller', c, money('10.00', { paid_on: TODAY }));
    expect(refusal(fresh)).toMatchObject({ status: 422, code: 'JV_INVALID_INPUT', field: 'paid_on' }); // a biller may use only today, and today is the 18th now
    expect((await receiptsOf(w, c)).length).toBe(1);
  });
});
