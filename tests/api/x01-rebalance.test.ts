import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runInvariants } from '../../scripts/invariants.mjs';
import { rng } from '../helpers';
import { V, insert } from '../schema/support';
import { V2_ONE_TEXT } from '../../src/db/state';
import { timestampToWire } from '../../src/wire/format';
import {
  type Designs,
  type EditWorld,
  TODAY,
  WALKIN,
  addCustomer,
  addDesigns,
  addRate,
  billBody,
  billRow,
  codeOf,
  countOf,
  editWorld,
  footprint,
  item,
  newKey,
  piece,
  postBill,
  requestIdOf,
  rows,
  saved,
} from './x01-support';

// API21, the rebalance of Y6 wired into X1 create_bill at point (j) (T-B26, T-B07 and T-C10's DB half; Y3, Y6, Y9, I10, IM4): after the bill is written, the customer's advance is applied to their oldest
// pending bills, oldest receipt first, silver grams the same way, from the state read ONCE at create_bill.after_read; at most the advance of V2 in all; an existing allocation is never changed; and
// the answer says what was applied (`allocations`, `advance_applied`).
//
// The world is the scratch database of the other X1 tests: the real routes, the seeds, a clock fixed at 17 Oct 2026 10:00 UTC. The customers' history is typed in by SQL (the way the import writes
// it), with stamps that are earlier than the API clock's. Expected figures are written in the test, never read back from the code under test; the books are checked with V2 and the invariants
// of the database half (db/invariants), which are another opinion.

let w: EditWorld;
let d: Designs;
let seq = 0;

beforeAll(async () => {
  w = await editWorld('x01reb');
  d = await addDesigns(w);
  await addRate(w, 'Gold', '22K', '6920.00', TODAY);
  await addRate(w, 'Silver', '999', '85.00', TODAY);
}, 120_000);
afterAll(async () => {
  await w?.world.close();
}, 60_000);

// ------------------------------------------------------------------ fixtures typed by SQL

const stamp = (day: string, n = 0) => `${day} 05:00:00.${String(n).padStart(6, '0')}`;
/** A money receipt (an advance is money received and not yet applied). Opening advances are `Other` receipts with is_opening. */
async function money(c: string, amount: string, paidOn: string, o: Record<string, unknown> = {}): Promise<string> {
  const id = randomUUID();
  await insert(w.world.sql, 'receipts', V.receipt(c, { id, amount, mode: 'Other', paid_on: paidOn, created_at: stamp(paidOn, ++seq), updated_at: stamp(paidOn, seq), ...o }));
  return id;
}
async function silverReceipt(c: string, grams: string, paidOn: string, o: Record<string, unknown> = {}): Promise<string> {
  return money(c, '0.00', paidOn, { kind: 'fine_silver', mode: null, fine_grams: grams, ...o });
}
/** A bill nobody has paid, dated `date`. */
async function oldBill(c: string, total: string, date: string, o: Record<string, unknown> = {}): Promise<string> {
  const id = randomUUID();
  await insert(w.world.sql, 'bills', V.bill(c, { id, bill_no: `OLD-${++seq}`, bill_date: date, subtotal: total, grand_total: total, created_at: stamp(date, seq), updated_at: stamp(date, seq), ...o }));
  return id;
}
async function allocate(receipt: string, bill: string, c: string, o: Record<string, unknown> = {}): Promise<string> {
  const id = randomUUID();
  await insert(w.world.sql, 'receipt_allocations', V.allocation(receipt, bill, c, { id, created_at: stamp('2026-10-02', ++seq), updated_at: stamp('2026-10-02', seq), ...o }));
  return id;
}
const allocations = (c: string): Promise<any[]> => rows(w, 'SELECT * FROM receipt_allocations WHERE customer_id = ? ORDER BY created_at, id', [c]);
async function figures(c: string) {
  const [found] = await w.world.sql.query<any[]>(V2_ONE_TEXT.replace('?', w.world.sql.escape(c)));
  const r = (found as any[])[0];
  return { outstanding: r.outstanding, advance: r.advance, fine_outstanding: r.fine_outstanding, fine_advance: r.fine_advance };
}
/** I10 of the database half, over every customer of the world. */
async function i10Holds(): Promise<void> {
  const out = await runInvariants(w.world.sql);
  expect(out.counts.I10, JSON.stringify(out.rows.filter((r) => r.invariant === 'I10'))).toBe(0);
}

/** A piece of the gold Per Piece design that sells for exactly `price`; the bill is `price` rupees. */
async function bill(c: string, price: string, o: { caller?: 'owner' | 'biller'; date?: string; key?: string } = {}) {
  const p = await piece(w, d.gold24pp, { retail: price });
  const res = await postBill(w, o.caller ?? 'owner', billBody(c, 'Retail', [item(p, { metal_rate: price })], o.date ? { bill_date: o.date } : {}), o.key ?? newKey());
  return { res, r: await saved(res), piece: p };
}

describe('T-B26 a rebalance never changes an existing allocation and leaves I10 true (the part X1 wires: the advance goes to the new bill)', () => {
  it('an advance of 300 and a new bill of 400: 300 is applied, advance_applied says so, 100 is outstanding, the advance is gone, I10 holds (T-B07)', async () => {
    const c = await addCustomer(w);
    const r1 = await money(c, '300.00', '2026-10-10');
    const { r } = await bill(c, '400.00');
    expect(r.advance_applied).toBe('300.00');
    expect(r.receipts).toEqual([]); // no receipt is made: the receipt of the advance is an old one
    expect(r.allocations).toHaveLength(1);
    expect(r.allocations[0]).toMatchObject({ receipt_id: r1, bill_id: r.bill.id, customer_id: c, amount: '300.00', fine_grams: '0.000', released_at: null });
    expect(r.allocations[0].created_at).toBe(r.bill.created_at); // one reading of the API clock stamps the whole call
    expect(r.allocations[0].updated_at).toBe(r.bill.created_at);
    const stored = await allocations(c);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ id: r.allocations[0].id, receipt_id: r1, bill_id: r.bill.id, amount: '300.00', fine_grams: '0.000', released_at: null });
    expect(await figures(c)).toEqual({ outstanding: '100.00', advance: '0.00', fine_outstanding: '0.000', fine_advance: '0.000' });
    await i10Holds();
  });

  it('an advance larger than the bill: the bill is paid in full, the rest stays as the advance, nothing is outstanding (I10: an advance with nothing outstanding)', async () => {
    const c = await addCustomer(w);
    await money(c, '1000.00', '2026-10-10');
    const { r } = await bill(c, '400.00');
    expect(r.advance_applied).toBe('400.00');
    expect(r.allocations.map((a: any) => [a.bill_id, a.amount])).toEqual([[r.bill.id, '400.00']]);
    expect(await figures(c)).toEqual({ outstanding: '0.00', advance: '600.00', fine_outstanding: '0.000', fine_advance: '0.000' });
    await i10Holds();
  });

  it('no advance, no allocation: advance_applied is 0.00 and the call writes no allocation row', async () => {
    const c = await addCustomer(w);
    const { r } = await bill(c, '250.00');
    expect(r.advance_applied).toBe('0.00');
    expect(r.allocations).toEqual([]);
    expect(await allocations(c)).toEqual([]);
    expect(await figures(c)).toEqual({ outstanding: '250.00', advance: '0.00', fine_outstanding: '0.000', fine_advance: '0.000' });
  });

  it('an existing allocation is never changed: ids and amounts (every column) are identical before and after, and only new rows appear', async () => {
    const c = await addCustomer(w);
    const b0 = await oldBill(c, '1000.00', '2026-10-01');
    const r1 = await money(c, '600.00', '2026-10-02');
    const r2 = await money(c, '900.00', '2026-10-03');
    await allocate(r1, b0, c, { amount: '600.00' });
    await allocate(r2, b0, c, { amount: '400.00' }); // b0 is paid in full; r2 has 500 left: the advance
    const before = await allocations(c);
    expect(await figures(c)).toEqual({ outstanding: '0.00', advance: '500.00', fine_outstanding: '0.000', fine_advance: '0.000' });
    const { r } = await bill(c, '700.00');
    const after = await allocations(c);
    expect(after).toHaveLength(before.length + 1);
    expect(after.filter((a) => before.some((b) => b.id === a.id)), 'the old rows, column for column').toEqual(before);
    const added = after.filter((a) => !before.some((b) => b.id === a.id));
    expect(added.map((a) => [a.receipt_id, a.bill_id, a.amount])).toEqual([[r2, r.bill.id, '500.00']]); // only what was left of r2
    expect(r.advance_applied).toBe('500.00');
    expect(await figures(c)).toEqual({ outstanding: '200.00', advance: '0.00', fine_outstanding: '0.000', fine_advance: '0.000' });
    await i10Holds();
  });

  it('the oldest receipt is spent first (paid_on, then created_at, then id), whatever order they were typed in', async () => {
    const c = await addCustomer(w);
    const rNew = await money(c, '100.00', '2026-10-16');
    const rOld = await money(c, '100.00', '2026-10-02');
    const { r } = await bill(c, '150.00');
    expect(r.allocations.map((a: any) => [a.receipt_id, a.amount])).toEqual([
      [rOld, '100.00'],
      [rNew, '50.00'],
    ]);
    expect(r.advance_applied).toBe('150.00');
    await i10Holds();
  });

  it('a handed-back advance is never spent twice: 1,000 received, 300 handed back, a bill of 1,000: only the 700 left is applied (Y6)', async () => {
    const c = await addCustomer(w);
    await money(c, '1000.00', '2026-10-05');
    await insert(w.world.sql, 'receipts', V.receipt(c, { kind: 'refund', amount: '300.00', mode: 'Cash', paid_on: '2026-10-06', created_at: stamp('2026-10-06', ++seq) }));
    expect((await figures(c)).advance).toBe('700.00');
    const { r } = await bill(c, '1000.00');
    expect(r.advance_applied).toBe('700.00');
    expect(await figures(c)).toEqual({ outstanding: '300.00', advance: '0.00', fine_outstanding: '0.000', fine_advance: '0.000' });
    await i10Holds();
  });

  it('a voided receipt and a cancelled bill are ignored: only live money is applied (V2)', async () => {
    const c = await addCustomer(w);
    await money(c, '500.00', '2026-10-05', { status: 'voided', void_reason: 'wrong', voided_at: stamp('2026-10-06'), voided_on: '2026-10-06', voided_by: w.world.fixtures.owner.userId });
    const live = await money(c, '120.00', '2026-10-07');
    await oldBill(c, '999.00', '2026-10-01', { status: 'cancelled', cancel_reason: 'x', cancelled_at: stamp('2026-10-02'), cancelled_on: '2026-10-02', cancelled_by: w.world.fixtures.owner.userId });
    const { r } = await bill(c, '200.00');
    expect(r.allocations.map((a: any) => [a.receipt_id, a.bill_id, a.amount])).toEqual([[live, r.bill.id, '120.00']]);
    await i10Holds();
  });
});

describe('T-B26 over a random sequence (the only money function built so far is create_bill; receipts and refunds are typed by SQL between the calls)', () => {
  it('120 operations on 5 customers: after every create_bill the rows that existed are identical (every column) and the billed customer satisfies I10; at the end I10 holds for everybody', async () => {
    const rand = rng(20261017);
    const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
    const customers = [await addCustomer(w), await addCustomer(w), await addCustomer(w), await addCustomer(w), await addCustomer(w)];
    const dates = ['2026-10-01', '2026-10-05', '2026-10-09', '2026-10-13', '2026-10-16'];
    let billed = 0;
    let applied = 0;
    let refunded = 0;
    for (let i = 0; i < 120; i++) {
      const c = customers[int(0, customers.length - 1)];
      const roll = rand();
      if (roll < 0.45) {
        await money(c, `${int(1, 3000)}.${String(int(0, 99)).padStart(2, '0')}`, dates[int(0, dates.length - 1)]);
      } else if (roll < 0.52) {
        const adv = (await figures(c)).advance;
        const cents = Number(adv.replace('.', ''));
        if (cents > 0) {
          const part = Math.max(1, Math.floor((cents * int(1, 100)) / 100));
          await insert(w.world.sql, 'receipts', V.receipt(c, { kind: 'refund', amount: `${Math.floor(part / 100)}.${String(part % 100).padStart(2, '0')}`, mode: 'Cash', paid_on: '2026-10-16', created_at: stamp('2026-10-16', ++seq), updated_at: stamp('2026-10-16', seq) }));
          refunded++;
        }
      } else if (roll < 0.57) {
        await silverReceipt(c, `${int(1, 40)}.${String(int(0, 999)).padStart(3, '0')}`, dates[int(0, dates.length - 1)]);
      } else {
        const before = await allocations(c);
        const advanceBefore = (await figures(c)).advance;
        const price = String(int(1, 8) * 100);
        const owner = rand() < 0.4;
        const { r } = await bill(c, price, owner ? { date: dates[int(0, dates.length - 1)] } : { caller: 'biller' });
        billed++;
        const after = await allocations(c);
        expect(after.filter((a) => before.some((b) => b.id === a.id)), `operation ${i}: an existing allocation changed`).toEqual(before);
        const now = await figures(c);
        expect(Number(now.outstanding) >= 0 && Number(now.advance) >= 0 && Number(now.fine_outstanding) >= 0 && Number(now.fine_advance) >= 0, `operation ${i}: a figure is negative ${JSON.stringify(now)}`).toBe(true);
        if (Number(now.advance) > 0) expect(now.outstanding, `operation ${i}: an advance beside dues`).toBe('0.00');
        if (Number(now.fine_advance) > 0) expect(now.fine_outstanding, `operation ${i}: silver advance beside silver dues`).toBe('0.000');
        // never more than the advance the customer held before the call
        expect(Number(r.advance_applied) * 100 <= Number(advanceBefore.replace('.', '')), `operation ${i}: applied ${r.advance_applied} of an advance of ${advanceBefore}`).toBe(true);
        if (r.advance_applied !== '0.00') applied++;
      }
    }
    for (const c of customers) await bill(c, '100', { caller: 'biller' }); // the last operation of everybody is a bill: the post-condition of Y6 holds for all
    await i10Holds();
    expect(billed, 'the sequence billed').toBeGreaterThan(50);
    expect(applied, 'an advance was applied several times').toBeGreaterThan(10);
    expect(refunded, 'money was handed back several times').toBeGreaterThan(3);
  }, 120_000);
});

describe('T-B21 / Y9 the rebalance covers bills of every kind: an opening bill is the oldest and nets off against an advance first', () => {
  it('opening dues 300.50 and a 1,000 advance that were never netted (typed by SQL): the advance pays the opening bill first, then the new bill; 299.50 is left as the advance', async () => {
    const c = await addCustomer(w);
    const ob = await oldBill(c, '300.50', '2026-09-30', { doc_type: 'opening_balance', subtotal: '0.00', bill_no: `OB-${++seq}`, request_id: null });
    const adv = await money(c, '1000.00', '2026-09-30', { is_opening: 1 });
    const { r } = await bill(c, '400.00');
    expect(r.allocations.map((a: any) => [a.receipt_id, a.bill_id, a.amount])).toEqual([
      [adv, ob, '300.50'],
      [adv, r.bill.id, '400.00'],
    ]);
    expect(r.advance_applied, 'what went to THIS bill').toBe('400.00');
    expect(await figures(c)).toEqual({ outstanding: '0.00', advance: '299.50', fine_outstanding: '0.000', fine_advance: '0.000' });
    await i10Holds();
  });

  it('bills are taken oldest first by bill_date: a back-dated new bill (owner) goes before an older-typed pending bill, a bill of the same day goes after it (Y3 tie: created_at)', async () => {
    const c = await addCustomer(w);
    const pending = await oldBill(c, '200.00', '2026-10-10');
    const adv = await money(c, '150.00', '2026-10-11'); // typed by SQL: a customer with dues AND an advance, which I10 forbids after a rebalance, so this is the state before it
    const early = await bill(c, '100.00', { date: '2026-10-05' });
    expect(early.r.allocations.map((a: any) => [a.receipt_id, a.bill_id, a.amount])).toEqual([
      [adv, early.r.bill.id, '100.00'],
      [adv, pending, '50.00'],
    ]);
    const c2 = await addCustomer(w);
    const pending2 = await oldBill(c2, '200.00', '2026-10-10');
    const adv2 = await money(c2, '150.00', '2026-10-11');
    const same = await bill(c2, '100.00', { date: '2026-10-10' });
    expect(same.r.allocations.map((a: any) => [a.receipt_id, a.bill_id, a.amount]), 'same day: the older bill (created earlier) first').toEqual([[adv2, pending2, '150.00']]);
    expect(same.r.advance_applied, 'nothing went to the new bill').toBe('0.00');
    await i10Holds();
  });
});

describe('Y6 silver: unallocated silver grams are applied the same way, money and silver independently', () => {
  it('a Wholesale silver bill (100 g fine due, 800 labour) takes a money advance of 500 and a silver receipt of 40 g; 300 and 60 g stay pending', async () => {
    const c = await addCustomer(w);
    const m = await money(c, '500.00', '2026-10-08');
    const s = await silverReceipt(c, '40.000', '2026-10-09');
    const p = await piece(w, d.silver999, { nw: '100.000', retail: '10.00', wholesale: '8.00' });
    const r = await saved(await postBill(w, 'owner', billBody(c, 'Wholesale', [item(p, { metal_rate: '85.00', labour_rate: '8.00' })])));
    expect(r.bill).toMatchObject({ grand_total: '800.00', fine_weight_due: '100.000' });
    expect(r.allocations.map((a: any) => [a.receipt_id, a.amount, a.fine_grams])).toEqual([
      [m, '500.00', '0.000'],
      [s, '0.00', '40.000'],
    ]);
    expect(r.advance_applied, 'the money only').toBe('500.00');
    expect(await figures(c)).toEqual({ outstanding: '300.00', advance: '0.00', fine_outstanding: '60.000', fine_advance: '0.000' });
    await i10Holds();
  });
});

describe('K5 the walk-in customer is never rebalanced', () => {
  it('a stray receipt on the walk-in (typed by SQL, which I10 forbids) is not applied to the walk-in\'s new bill: no allocation, advance_applied 0.00', async () => {
    await money(WALKIN, '5000.00', '2026-10-05');
    const { r } = await bill(WALKIN, '300.00');
    expect(r.advance_applied).toBe('0.00');
    expect(r.allocations).toEqual([]);
    expect(await countOf(w, 'receipt_allocations', 'bill_id = ?', [r.bill.id])).toBe(0);
    await w.world.sql.query("UPDATE receipts SET status = 'voided', void_reason = 'cleanup', voided_at = ?, voided_on = ?, voided_by = ? WHERE customer_id = ? AND status = 'active'", [stamp('2026-10-06'), '2026-10-06', w.world.fixtures.owner.userId, WALKIN]);
  });
});

describe('D23 the touches: the bills that received an allocation and the customer carry the stamp of the call\'s one reading', () => {
  it('older pending bills that the advance pays are touched with the stamp of the call, a pending bill that receives nothing keeps its own, and so does another customer', async () => {
    const c = await addCustomer(w);
    const other = await addCustomer(w);
    const p1 = await oldBill(c, '100.00', '2026-10-01');
    const p2 = await oldBill(c, '900.00', '2026-10-02');
    const p3 = await oldBill(c, '500.00', '2026-10-03');
    const otherBill = await oldBill(other, '300.00', '2026-10-02');
    await money(c, '150.00', '2026-10-04'); // typed by SQL: dues AND an advance, the state before a rebalance
    const stampOf = async (table: 'bills' | 'customers', id: string) => timestampToWire(String((await rows(w, `SELECT updated_at FROM ${table} WHERE id = ?`, [id]))[0].updated_at));
    const before = { p1: await stampOf('bills', p1), p2: await stampOf('bills', p2), p3: await stampOf('bills', p3), other: await stampOf('bills', otherBill), otherCustomer: await stampOf('customers', other) };
    const { r } = await bill(c, '100.00');
    expect(r.allocations.map((a: any) => [a.bill_id, a.amount])).toEqual([
      [p1, '100.00'],
      [p2, '50.00'],
    ]);
    expect(await stampOf('bills', p1), 'paid by the advance').toBe(r.bill.created_at);
    expect(await stampOf('bills', p2), 'part paid by the advance').toBe(r.bill.created_at);
    expect(await stampOf('customers', c)).toBe(r.bill.created_at);
    expect(await stampOf('bills', p3), 'nothing was applied to it').toBe(before.p3);
    expect(before.p1).not.toBe(r.bill.created_at);
    expect(await stampOf('bills', otherBill)).toBe(before.other);
    expect(await stampOf('customers', other)).toBe(before.otherCustomer);
  });
});

describe('L5 / X0 the rebalance is part of the call: it is repeat-safe, rolled back with the call, and reads nothing after the state read', () => {
  it('the same Idempotency-Key twice makes one set of allocations and returns the same answer (advance_applied included)', async () => {
    const c = await addCustomer(w);
    await money(c, '300.00', '2026-10-10');
    const p = await piece(w, d.gold24pp, { retail: '400.00' });
    const key = newKey();
    const payload = billBody(c, 'Retail', [item(p, { metal_rate: '400.00' })]);
    const first = await postBill(w, 'owner', payload, key);
    const again = await postBill(w, 'owner', payload, key);
    expect(first.statusCode).toBe(201);
    expect(again.statusCode).toBe(201);
    expect(again.headers['idempotent-replay']).toBe('true');
    expect(JSON.parse(again.body)).toEqual(JSON.parse(first.body));
    expect(JSON.parse(first.body).advance_applied).toBe('300.00');
    expect(await allocations(c)).toHaveLength(1);
    expect(await figures(c)).toEqual({ outstanding: '100.00', advance: '0.00', fine_outstanding: '0.000', fine_advance: '0.000' });
  });

  it('a failure after the rebalance (the result cannot be stored) rolls the allocation back with the bill, the pieces, the number and the touch', async () => {
    const c = await addCustomer(w);
    await money(c, '300.00', '2026-10-10');
    const p = await piece(w, d.gold24pp, { retail: '400.00' });
    const before = await footprint(w);
    const customerBefore = String((await rows(w, 'SELECT updated_at FROM customers WHERE id = ?', [c]))[0].updated_at);
    w.world.spy.intercept = async (e) => {
      if (/^UPDATE sys_idempotency\b/.test(e.sql)) throw new Error('the connection to the result row failed');
    };
    try {
      const res = await postBill(w, 'owner', billBody(c, 'Retail', [item(p, { metal_rate: '400.00' })]));
      expect(res.statusCode).toBe(500);
      expect(codeOf(res)).toBe('JV_INTERNAL');
    } finally {
      w.world.spy.intercept = null;
    }
    expect(await footprint(w)).toEqual(before);
    expect(await allocations(c)).toEqual([]);
    expect(String((await rows(w, 'SELECT updated_at FROM customers WHERE id = ?', [c]))[0].updated_at)).toBe(customerBefore);
  });

  it('the allocation is written after the state read and after the pieces and the number (locks before writes), and nothing is read from receipts or allocations after the state read', async () => {
    const c = await addCustomer(w);
    await money(c, '300.00', '2026-10-10');
    const p = await piece(w, d.gold24pp, { retail: '400.00' });
    const sent = w.world.spy.sent.length;
    const res = await postBill(w, 'owner', billBody(c, 'Retail', [item(p, { metal_rate: '400.00' })]));
    expect(res.statusCode, res.body).toBe(201);
    const sqls = w.world.spy.sqls().slice(sent);
    const at = (re: RegExp) => sqls.findIndex((s) => re.test(s));
    const stateRead = at(/AS fine_advance\b/); // V2 for one customer: the last statement of the state read
    const counter = at(/sys_counters/);
    const insert = at(/^INSERT INTO receipt_allocations\b/);
    expect(stateRead).toBeGreaterThan(-1);
    expect(insert).toBeGreaterThan(counter);
    expect(insert).toBeGreaterThan(at(/^INSERT INTO bills\b/));
    const afterState = sqls.slice(stateRead + 1);
    expect(afterState.filter((s) => /^\s*SELECT\b[\s\S]*\b(FROM|JOIN)\s+`?(receipts|receipt_allocations)\b/.test(s)), 'the rebalance allocates from the state it was given and reads nothing again').toEqual([]);
    expect(sqls.filter((s) => /^INSERT INTO receipt_allocations\b/.test(s))).toHaveLength(1);
  });

  it('a refused call (a held piece without the confirm list) makes no allocation and leaves the advance whole', async () => {
    const c = await addCustomer(w);
    await money(c, '300.00', '2026-10-10');
    const p = await piece(w, d.gold24pp, { retail: '400.00', status: 'Reserved' });
    const before = await footprint(w);
    const res = await postBill(w, 'owner', billBody(c, 'Retail', [item(p, { metal_rate: '400.00' })]));
    expect(res.statusCode).toBe(409);
    expect(codeOf(res)).toBe('JV_PIECE_UNAVAILABLE');
    expect(await footprint(w)).toEqual(before);
    expect((await figures(c)).advance).toBe('300.00');
  });
});

describe('the answer: allocations are rows in the wire format of the sync read of the caller\'s role', () => {
  it('a biller gets the same allocation row the sync read gives (booleans, stamps with six decimals, money as text), and the stored replay is identical', async () => {
    const c = await addCustomer(w);
    const r1 = await money(c, '300.00', '2026-10-10');
    const { r, res } = await (async () => {
      const x = await bill(c, '400.00', { caller: 'biller' });
      return { r: x.r, res: x.res };
    })();
    expect(r.allocations).toHaveLength(1);
    expect(Object.keys(r.allocations[0]).sort()).toEqual(['amount', 'bill_id', 'created_at', 'customer_id', 'fine_grams', 'id', 'receipt_id', 'released_at', 'updated_at']);
    expect(r.allocations[0]).toMatchObject({ receipt_id: r1, amount: '300.00' });
    expect(r.allocations[0].created_at).toMatch(/^2026-10-17T10:00:00\.\d{6}Z$/);
    const sync = await w.world.call('biller', 'GET', '/v1/sync/receipt-allocations?limit=1000');
    const mine = (JSON.parse(sync.body).rows as any[]).find((x) => x.id === r.allocations[0].id);
    expect(mine).toEqual(r.allocations[0]);
    expect(requestIdOf(res)).toBeTruthy();
    expect((await billRow(w, r.bill.id)).status).toBe('active');
  });
});
