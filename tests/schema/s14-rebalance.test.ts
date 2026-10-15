import type { Connection } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dropDb, rng } from '../helpers';
import { runInvariants } from '../../scripts/invariants.mjs';
import { fromUnits, rebalanceCustomer, toUnits } from '../../scripts/rebalance.mjs';
import { V, insert, migratedDb, uuid } from './support';

// Spec Y3, Y6, Y9, K5 and I10 (T-B07, T-B14, T-B21, T-B22 database half): the advance is applied to the oldest pending bills, oldest receipt first, never changing an existing allocation.

let db: string;
let c: Connection;
let n = 0;
beforeAll(async () => {
  ({ db, c } = await migratedDb('s14_rebalance'));
});
afterAll(async () => {
  await c.end();
  await dropDb(db);
});

const customer = async (o: Record<string, unknown> = {}) => (await insert(c, 'customers', V.customer({ mobile: `9${String(++n).padStart(9, '0')}`, ...o }))) as { id: string };
const bill = async (cu: string, date: string, total: string, o: Record<string, unknown> = {}) =>
  (await insert(c, 'bills', V.bill(cu, { bill_no: `JV-2026-${String(++n).padStart(5, '0')}`, bill_date: date, subtotal: total, grand_total: total, created_at: `${date} 05:00:00.${String(n).padStart(6, '0')}`, ...o }))) as { id: string };
const money = async (cu: string, date: string, amount: string, o: Record<string, unknown> = {}) =>
  (await insert(c, 'receipts', V.receipt(cu, { amount, mode: 'Cash', paid_on: date, created_at: `${date} 06:00:00.${String(n++).padStart(6, '0')}`, ...o }))) as { id: string };
const silver = async (cu: string, date: string, grams: string, o: Record<string, unknown> = {}) =>
  (await insert(c, 'receipts', V.receipt(cu, { kind: 'fine_silver', mode: null, amount: '0.00', fine_grams: grams, paid_on: date, created_at: `${date} 06:00:00.${String(n++).padStart(6, '0')}`, ...o }))) as { id: string };
const live = async (cu: string) =>
  ((await c.query<any[]>(
    `SELECT al.receipt_id, al.bill_id, al.amount, al.fine_grams FROM receipt_allocations al JOIN receipts r ON r.id = al.receipt_id
      WHERE al.customer_id = ? AND al.released_at IS NULL AND r.status = 'active' ORDER BY al.created_at, al.id`, [cu]))[0]) as any[];
const v2 = async (cu: string) => ((await c.query<any[]>('SELECT outstanding, advance, fine_outstanding, fine_advance, balance FROM customer_balances WHERE id = ?', [cu]))[0] as any[])[0];

describe('exact units', () => {
  it('paise and milligrams are integers inside, text outside; more decimals than the scale are refused', () => {
    expect(toUnits('123.45', 2)).toBe(12345n);
    expect(toUnits('0.50', 2)).toBe(50n);
    expect(toUnits('7', 2)).toBe(700n);
    expect(toUnits('1.250', 3)).toBe(1250n);
    expect(() => toUnits('1.239', 2)).toThrow();
    expect(fromUnits(12345n, 2)).toBe('123.45');
    expect(fromUnits(5n, 2)).toBe('0.05');
    expect(fromUnits(1250n, 3)).toBe('1.250');
    expect(fromUnits(0n, 3)).toBe('0.000');
  });
});

describe('rebalanceCustomer: money', () => {
  it('applies an advance to the oldest bill first, then the next, and stops when the advance is used', async () => {
    const cu = await customer();
    const b1 = await bill(cu.id, '2026-10-01', '1000.00');
    const b2 = await bill(cu.id, '2026-10-03', '500.00');
    const r1 = await money(cu.id, '2026-10-02', '1200.00');
    expect((await v2(cu.id)).advance).toBe('1200.00');
    const out = await rebalanceCustomer(c, cu.id);
    expect(out.allocations.map((a) => [a.bill_id, a.amount, a.receipt_id])).toEqual([[b1.id, '1000.00', r1.id], [b2.id, '200.00', r1.id]]);
    expect(out.applied).toBe('1200.00');
    const after = await v2(cu.id);
    expect([after.outstanding, after.advance]).toEqual(['300.00', '0.00']);
  });

  it('is exactly what the database holds afterwards, and a second call adds nothing', async () => {
    const cu = await customer();
    await bill(cu.id, '2026-10-01', '300.00');
    await money(cu.id, '2026-10-01', '100.00');
    const first = await rebalanceCustomer(c, cu.id);
    expect(first.allocations).toHaveLength(1);
    expect(await live(cu.id)).toHaveLength(1);
    const second = await rebalanceCustomer(c, cu.id);
    expect(second).toEqual({ allocations: [], applied: '0.00', fine_applied: '0.000' });
    expect(await live(cu.id)).toHaveLength(1);
  });

  it('never changes an existing allocation: it only spends what is left of the receipt on what is left of the bills', async () => {
    const cu = await customer();
    const b1 = await bill(cu.id, '2026-10-01', '1000.00');
    const b2 = await bill(cu.id, '2026-10-02', '400.00');
    const r1 = await money(cu.id, '2026-10-01', '600.00');
    await insert(c, 'receipt_allocations', V.allocation(r1.id, b1.id, cu.id, { amount: '300.00' })); // an earlier payment put 300 on the first bill
    const before = await live(cu.id);
    const out = await rebalanceCustomer(c, cu.id);
    expect(out.allocations.map((a) => [a.bill_id, a.amount])).toEqual([[b1.id, '300.00']]); // the other 300 of R1 went to the oldest bill with a pending amount
    expect(out.applied).toBe('300.00');
    expect((await live(cu.id)).slice(0, before.length)).toEqual(before);
    void b2;
  });

  it('applies in total at most the advance: money handed back is not spent again', async () => {
    const cu = await customer();
    await bill(cu.id, '2026-10-01', '1000.00');
    await money(cu.id, '2026-10-01', '1000.00', { created_at: '2026-10-01 06:00:00.000001' });
    // the bill is not paid yet; hand 300 back first (the receipt exists, then a refund of 300): advance is 700
    await insert(c, 'receipts', V.receipt(cu.id, { kind: 'refund', amount: '300.00', mode: 'Cash', paid_on: '2026-10-02' }));
    expect((await v2(cu.id)).advance).toBe('700.00');
    const out = await rebalanceCustomer(c, cu.id);
    expect(out.applied).toBe('700.00');
    const after = await v2(cu.id);
    expect([after.outstanding, after.advance]).toEqual(['300.00', '0.00']);
  });

  it('takes the oldest receipt first (paid_on, then created_at, then id)', async () => {
    const cu = await customer();
    const b = await bill(cu.id, '2026-10-01', '150.00');
    const rNew = await money(cu.id, '2026-10-05', '100.00');
    const rOld = await money(cu.id, '2026-10-02', '100.00');
    const out = await rebalanceCustomer(c, cu.id);
    expect(out.allocations.map((a) => [a.receipt_id, a.amount, a.bill_id])).toEqual([[rOld.id, '100.00', b.id], [rNew.id, '50.00', b.id]]);
  });

  it('ignores a cancelled bill, a voided receipt and an allocation that was released', async () => {
    const cu = await customer();
    const cancelled = { status: 'cancelled', cancel_reason: 'x', cancelled_at: '2026-10-04 09:00:00.000000', cancelled_by: uuid() };
    await bill(cu.id, '2026-10-01', '800.00', cancelled);
    const open = await bill(cu.id, '2026-10-02', '200.00');
    await money(cu.id, '2026-10-01', '500.00', { status: 'voided', void_reason: 'x', voided_at: '2026-10-03 09:00:00.000000', voided_by: uuid() });
    const good = await money(cu.id, '2026-10-03', '120.00');
    const old = await bill(cu.id, '2026-09-20', '999.00', cancelled);
    await insert(c, 'receipt_allocations', V.allocation(good.id, old.id, cu.id, { amount: '120.00', released_at: '2026-10-04 09:00:00.000000' })); // released when the bill was cancelled
    const out = await rebalanceCustomer(c, cu.id);
    expect(out.allocations.map((a) => [a.receipt_id, a.bill_id, a.amount])).toEqual([[good.id, open.id, '120.00']]);
  });

  it('a customer with no pending bill keeps the advance; one with no advance gets nothing', async () => {
    const a = await customer();
    await money(a.id, '2026-10-01', '50.00');
    expect((await rebalanceCustomer(c, a.id)).allocations).toEqual([]);
    expect((await v2(a.id)).advance).toBe('50.00');
    const b = await customer();
    await bill(b.id, '2026-10-01', '50.00');
    expect((await rebalanceCustomer(c, b.id)).allocations).toEqual([]);
  });

  it('the walk-in customer is never rebalanced (K5): one row stands for strangers whose money must not pay each other\'s bills', async () => {
    const walkin = '00000000-0000-4000-8000-000000000001';
    await bill(walkin, '2026-10-01', '70.00');
    await money(walkin, '2026-10-01', '70.00');
    expect((await rebalanceCustomer(c, walkin)).allocations).toEqual([]);
  });

  it('an opening bill and an opening advance net off (T-B21): dues 300.50, advance 100 gives 200.50 outstanding and no advance', async () => {
    const cu = await customer();
    const ob = await bill(cu.id, '2026-09-30', '300.50', { doc_type: 'opening_balance', subtotal: '0.00', bill_no: `OB-${String(++n).padStart(4, '0')}`, request_id: null });
    const adv = await money(cu.id, '2026-09-30', '100.00', { mode: 'Other', is_opening: 1 });
    const out = await rebalanceCustomer(c, cu.id);
    expect(out.allocations.map((a) => [a.receipt_id, a.bill_id, a.amount])).toEqual([[adv.id, ob.id, '100.00']]);
    const after = await v2(cu.id);
    expect([after.outstanding, after.advance]).toEqual(['200.50', '0.00']);
  });
});

describe('rebalanceCustomer: silver', () => {
  it('applies silver received and silver settled in cash to the oldest fine due, in receipt order, with amount 0 on the allocation', async () => {
    const cu = await customer();
    const b1 = await bill(cu.id, '2026-10-01', '0.00', { fine_weight_due: '3.000' });
    const b2 = await bill(cu.id, '2026-10-02', '0.00', { fine_weight_due: '10.000' });
    const r1 = await silver(cu.id, '2026-10-03', '4.000');
    const r2 = await money(cu.id, '2026-10-04', '270.00', { kind: 'fine_cash', fine_grams: '3.000', silver_rate: '90.00' });
    const out = await rebalanceCustomer(c, cu.id);
    expect(out.allocations.map((a) => [a.receipt_id, a.bill_id, a.amount, a.fine_grams])).toEqual([
      [r1.id, b1.id, '0.00', '3.000'],
      [r1.id, b2.id, '0.00', '1.000'],
      [r2.id, b2.id, '0.00', '3.000'],
    ]);
    expect(out.fine_applied).toBe('7.000');
    const after = await v2(cu.id);
    expect([after.fine_outstanding, after.fine_advance]).toEqual(['6.000', '0.000']);
  });

  it('money and silver are separate: a rupee advance never pays fine, silver never pays rupees', async () => {
    const cu = await customer();
    const b = await bill(cu.id, '2026-10-01', '100.00', { fine_weight_due: '2.000' });
    await silver(cu.id, '2026-10-02', '5.000');
    const out = await rebalanceCustomer(c, cu.id);
    expect(out.allocations.map((a) => [a.bill_id, a.amount, a.fine_grams])).toEqual([[b.id, '0.00', '2.000']]);
    const after = await v2(cu.id);
    expect([after.outstanding, after.fine_outstanding, after.fine_advance]).toEqual(['100.00', '0.000', '3.000']);
  });
});

describe('rebalanceCustomer: property test against the nightly check (I3, I4, I10)', () => {
  it('after a rebalance of random customers (bills, receipts of every kind, refunds, voids, cancellations) the three invariants hold and nothing existing changed', async () => {
    const rand = rng(77);
    const pick = <T,>(xs: T[]) => xs[Math.floor(rand() * xs.length)];
    const cents = (hi: number) => (1 + Math.floor(rand() * hi)) * 25; // paise, in steps of 25
    const rupees = (hi: number) => (1 + Math.floor(rand() * hi)) * 100; // whole rupees: an estimate's grand total is whole (R8)
    const fmt = (x: number) => (x / 100).toFixed(2);
    const customers: string[] = [];
    for (let i = 0; i < 40; i++) {
      const cu = await customer();
      customers.push(cu.id);
      const bills: string[] = [];
      for (let j = 0, k = 1 + Math.floor(rand() * 4); j < k; j++) {
        const total = rupees(60);
        const cancelled = rand() < 0.15;
        bills.push((await bill(cu.id, `2026-0${1 + Math.floor(rand() * 9)}-1${Math.floor(rand() * 9)}`, fmt(total), {
          fine_weight_due: rand() < 0.4 ? (cents(40) / 100).toFixed(3) : '0.000',
          ...(cancelled ? { status: 'cancelled', cancel_reason: 'x', cancelled_at: '2026-10-04 09:00:00.000000', cancelled_by: uuid() } : {}),
        })).id);
      }
      let received = 0;
      for (let j = 0, k = Math.floor(rand() * 4); j < k; j++) {
        const amt = cents(60);
        received += amt;
        const voided = rand() < 0.15 ? { status: 'voided', void_reason: 'x', voided_at: '2026-10-05 09:00:00.000000', voided_by: uuid() } : {};
        if (Object.keys(voided).length) received -= amt;
        await money(cu.id, `2026-0${1 + Math.floor(rand() * 9)}-0${1 + Math.floor(rand() * 9)}`, fmt(amt), voided);
        if (rand() < 0.3) await silver(cu.id, `2026-0${1 + Math.floor(rand() * 9)}-2${Math.floor(rand() * 9)}`, (cents(30) / 100).toFixed(3));
      }
      if (rand() < 0.3 && received >= 50) await insert(c, 'receipts', V.receipt(cu.id, { kind: 'refund', amount: fmt(Math.min(received, cents(20))), mode: pick(['Cash', 'UPI']), paid_on: '2026-10-09' }));
    }
    const before = (await c.query<any[]>('SELECT id, receipt_id, bill_id, amount, fine_grams, released_at FROM receipt_allocations ORDER BY id'))[0];
    for (const id of customers) {
      await c.query('START TRANSACTION');
      await rebalanceCustomer(c, id);
      await c.query('COMMIT');
    }
    const after = (await c.query<any[]>('SELECT id, receipt_id, bill_id, amount, fine_grams, released_at FROM receipt_allocations ORDER BY id'))[0];
    const byId = new Map(after.map((r: any) => [r.id, r]));
    for (const r of before) expect(byId.get(r.id)).toEqual(r);
    const result = await runInvariants(c);
    // the walk-in row holds the deliberately wrong state of the walk-in test above (an advance beside a pending bill); it is not part of this property
    const mine = result.rows.filter((r) => ['I3', 'I4', 'I10'].includes(r.invariant) && !r.row_ref.includes('00000000-0000-4000-8000-000000000001'));
    expect(mine, JSON.stringify(mine.slice(0, 3))).toEqual([]);
    expect(after.length).toBeGreaterThan(before.length + 10);
  });
});
