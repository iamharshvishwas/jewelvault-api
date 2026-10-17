import { randomUUID } from 'node:crypto';
import type { Connection } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runInvariants } from '../../scripts/invariants.mjs';
import { rebalanceCustomer } from '../../scripts/rebalance.mjs';
import { LockOrderViolation, lockCustomer } from '../../src/db/locks';
import { readCustomerState } from '../../src/db/state';
import type { DbPool } from '../../src/db/pool';
import { type Tx, txContext, withTx } from '../../src/db/tx';
import { type NewBill, type NewReceipt, type RebalanceResult, fromUnits, planRebalance, rebalance, toUnits } from '../../src/domain/rebalance';
import { JvError } from '../../src/errors';
import { rng } from '../helpers';
import { spyOn } from './tx-support';
import { V, insert } from '../schema/support';
import { type X0World, addAllocation, addBill, addCustomer, addReceipt, x0World } from './x0-support';

// API21, the library of the rebalance (Y3, Y6, Y9, K5, I10, IM4): src/domain/rebalance.ts is the TypeScript copy, on the API's transaction, of the database half's scripts/rebalance.mjs
// (`rebalanceCustomer`, MB04: the import and X12 call that one). The API copy allocates from the state it was given (X0 item 8), so it reads nothing again after the hook; the two must give the same
// allocations, which the last block proves on 300 random customers (T-B26, the equality clause of API21). The tests of tests/schema/s14-rebalance.test.ts are the script's own and stay as they are.

// ------------------------------------------------------------------ exact units

describe('exact units: paise and milligrams are BigInt inside, text outside; a digit past the scale is refused, never rounded', () => {
  it('toUnits and fromUnits agree with the script\'s', () => {
    expect(toUnits('123.45', 2)).toBe(12345n);
    expect(toUnits('0.50', 2)).toBe(50n);
    expect(toUnits('7', 2)).toBe(700n);
    expect(toUnits('1.250', 3)).toBe(1250n);
    expect(toUnits('-3.5', 2)).toBe(-350n);
    expect(() => toUnits('1.239', 2)).toThrow();
    expect(() => toUnits('1,5', 2)).toThrow();
    expect(fromUnits(12345n, 2)).toBe('123.45');
    expect(fromUnits(5n, 2)).toBe('0.05');
    expect(fromUnits(1250n, 3)).toBe('1.250');
    expect(fromUnits(0n, 3)).toBe('0.000');
    expect(fromUnits(-350n, 2)).toBe('-3.50');
    expect(fromUnits(10_000_000_000_000_000n, 2)).toBe('100000000000000.00'); // beyond a safe JS integer: BigInt keeps every digit
  });
});

// ------------------------------------------------------------------ the plan, with no database

const bill = (id: string, pending: string, fine = '0.000') => ({ id, pending, fine_pending: fine });
const rec = (id: string, remaining: string, fineRemaining = '0.000', kind = 'money') => ({ id, kind, remaining, fine_remaining: fineRemaining });
const flat = (p: { allocations: { receipt_id: string; bill_id: string; amount: string; fine_grams: string }[] }) => p.allocations.map((a) => [a.receipt_id, a.bill_id, a.amount, a.fine_grams]);
let ids = 0;
const counter = () => `id-${++ids}`;

describe('T-B26 planRebalance: oldest bill first, oldest receipt first, at most the advance, silver the same way', () => {
  it('spends the oldest receipt on the oldest bill, then the next, and stops when the advance is used', () => {
    const p = planRebalance({ bills: [bill('b1', '1000.00'), bill('b2', '500.00')], receipts: [rec('r1', '1200.00')], advance: '1200.00', fine_advance: '0.000' }, counter);
    expect(flat(p)).toEqual([
      ['r1', 'b1', '1000.00', '0.000'],
      ['r1', 'b2', '200.00', '0.000'],
    ]);
    expect([p.applied, p.fine_applied]).toEqual(['1200.00', '0.000']);
    expect(p.allocations.map((a) => a.id)).toEqual(['id-1', 'id-2']);
  });

  it('several receipts: the first is used up before the second is touched', () => {
    const p = planRebalance({ bills: [bill('b1', '150.00')], receipts: [rec('rOld', '100.00'), rec('rNew', '100.00')], advance: '200.00', fine_advance: '0.000' });
    expect(flat(p)).toEqual([
      ['rOld', 'b1', '100.00', '0.000'],
      ['rNew', 'b1', '50.00', '0.000'],
    ]);
  });

  it('applies in total at most the advance of V2: 700 of 1,000 received (300 handed back) pays 700 and no more (money handed back is not spent twice)', () => {
    const p = planRebalance({ bills: [bill('b1', '1000.00')], receipts: [rec('r1', '1000.00')], advance: '700.00', fine_advance: '0.000' });
    expect(flat(p)).toEqual([['r1', 'b1', '700.00', '0.000']]);
    expect(p.applied).toBe('700.00');
  });

  it('a zero advance applies nothing, however much is left on the receipts; no pending bill applies nothing', () => {
    expect(planRebalance({ bills: [bill('b1', '10.00')], receipts: [rec('r1', '10.00')], advance: '0.00', fine_advance: '0.000' }).allocations).toEqual([]);
    expect(planRebalance({ bills: [], receipts: [rec('r1', '10.00')], advance: '10.00', fine_advance: '0.000' }).allocations).toEqual([]);
    expect(planRebalance({ bills: [bill('b1', '0.00')], receipts: [rec('r1', '10.00')], advance: '10.00', fine_advance: '0.000' }).allocations).toEqual([]);
  });

  it('the caller\'s named bill goes first (Y3); a name that is not among the pending bills changes nothing', () => {
    const input = { bills: [bill('b1', '100.00'), bill('b2', '100.00'), bill('b3', '100.00')], receipts: [rec('r1', '150.00')], advance: '150.00', fine_advance: '0.000' };
    expect(flat(planRebalance({ ...input, first: 'b3' }))).toEqual([
      ['r1', 'b3', '100.00', '0.000'],
      ['r1', 'b1', '50.00', '0.000'],
    ]);
    expect(flat(planRebalance({ ...input, first: 'nobody' }))).toEqual(flat(planRebalance(input)));
    expect(flat(planRebalance({ ...input, first: null }))).toEqual(flat(planRebalance(input)));
  });

  it('silver is applied the same way and independently of the money: a bill that owes both gets one money row and one silver row (never both kinds in one row)', () => {
    const p = planRebalance({
      bills: [bill('b1', '800.00', '100.000')],
      receipts: [rec('m1', '500.00'), rec('s1', '0.00', '40.000', 'fine_silver'), rec('s2', '0.00', '30.000', 'fine_cash')],
      advance: '500.00',
      fine_advance: '70.000',
    });
    expect(flat(p)).toEqual([
      ['m1', 'b1', '500.00', '0.000'],
      ['s1', 'b1', '0.00', '40.000'],
      ['s2', 'b1', '0.00', '30.000'],
    ]);
    expect([p.applied, p.fine_applied]).toEqual(['500.00', '70.000']);
    for (const a of p.allocations) expect(a.amount === '0.00' || a.fine_grams === '0.000', 'chk_allocations_one_kind').toBe(true);
  });

  it('the silver advance caps the silver, as the money advance caps the money', () => {
    const p = planRebalance({ bills: [bill('b1', '0.00', '100.000')], receipts: [rec('s1', '0.00', '40.000', 'fine_silver')], advance: '0.00', fine_advance: '25.000' });
    expect(flat(p)).toEqual([['s1', 'b1', '0.00', '25.000']]);
  });

  it('never makes an amount of 0 (chk_allocations_one_kind: amount > 0 or fine_grams > 0)', () => {
    const p = planRebalance({ bills: [bill('b1', '10.00'), bill('b2', '10.00')], receipts: [rec('r1', '10.00'), rec('r2', '0.00')], advance: '10.00', fine_advance: '0.000' });
    expect(flat(p)).toEqual([['r1', 'b1', '10.00', '0.000']]);
  });

  it('refuses an amount with a digit past the scale (MariaDB would round it silently)', () => {
    expect(() => planRebalance({ bills: [bill('b1', '10.005')], receipts: [rec('r1', '10.00')], advance: '10.00', fine_advance: '0.000' })).toThrow();
  });
});

// ------------------------------------------------------------------ on the database

const AT = '2026-10-17 10:00:00.250000';
const OLD = '2026-10-01 08:30:15.123457';
const ACTOR = { id: null, role: 'job' } as const;

interface Extras {
  first?: string;
  newBills?: NewBill[];
  newReceipts?: NewReceipt[];
}
interface RunOptions {
  walkin?: boolean;
  auditMode?: 'node' | 'triggers';
  /** what a function does between the state read and the rebalance: insert its own rows; answers what it made */
  prepare?: (tx: Tx) => Promise<Extras>;
  pool?: Pick<DbPool, 'checkout'>;
}
async function run(w: X0World, customerId: string, o: RunOptions = {}): Promise<RebalanceResult> {
  const ctx = txContext(o.pool ?? w.pool, { requestId: randomUUID(), actor: ACTOR, ...(o.auditMode ? { auditMode: o.auditMode } : {}) });
  return withTx(ctx, async (tx) => {
    const customer = await lockCustomer(tx, customerId);
    if (!customer) throw new Error('no such customer');
    const state = await readCustomerState(tx, { fn: 'toy_rebalance', customerId });
    const extras = (await o.prepare?.(tx)) ?? {};
    return rebalance(tx, { customerId, walkin: o.walkin ?? Number(customer.is_walkin) === 1, state, at: AT, ...extras });
  });
}

const stampOf = async (w: X0World, table: 'bills' | 'customers', id: string): Promise<string> =>
  String(((await w.root.query<any[]>(`SELECT DATE_FORMAT(updated_at, '%Y-%m-%d %H:%i:%s.%f') AS s FROM ${w.db()}.${table} WHERE id = ?`, [id]))[0] as any[])[0].s);
const allocRows = async (w: X0World, customerId: string): Promise<any[]> => ((await w.root.query<any[]>(`SELECT * FROM ${w.db()}.receipt_allocations WHERE customer_id = ? ORDER BY created_at, id`, [customerId]))[0] as any[]);
const auditRows = async (w: X0World, table: string): Promise<any[]> =>
  ((await w.root.query<any[]>(`SELECT table_name, row_id, action, actor, actor_role, request_id, old_row, new_row FROM ${w.db()}.audit_log WHERE table_name = ? ORDER BY id`, [table]))[0] as any[]).map((r) => ({
    ...r,
    old_row: typeof r.old_row === 'string' ? JSON.parse(r.old_row) : r.old_row,
    new_row: typeof r.new_row === 'string' ? JSON.parse(r.new_row) : r.new_row,
  }));

let w: X0World;
let wn: X0World;
beforeAll(async () => {
  w = await x0World('rebal', { optional: true }); // the generated audit triggers (L1 a)
  wn = await x0World('rebaln'); // no triggers: the Node writer (L1 b)
}, 120_000);
afterAll(async () => {
  await w?.close();
  await wn?.close();
}, 60_000);

describe('T-B26 rebalance on the transaction: it writes the allocations, touches, audits, and reads nothing again', () => {
  it('writes the rows the plan made, stamped from `at`, dated with no release; returns them as the table holds them', async () => {
    const c = await addCustomer(w);
    const b1 = await addBill(w, c, '1000.00', { bill_date: '2026-10-01', created_at: OLD, updated_at: OLD });
    const b2 = await addBill(w, c, '500.00', { bill_date: '2026-10-03', created_at: OLD, updated_at: OLD });
    const r1 = await addReceipt(w, c, '1200.00', { paid_on: '2026-10-02', created_at: OLD, updated_at: OLD });
    const out = await run(w, c);
    expect(out.allocations.map((a) => [a.receipt_id, a.bill_id, a.amount, a.fine_grams])).toEqual([
      [r1, b1, '1000.00', '0.000'],
      [r1, b2, '200.00', '0.000'],
    ]);
    expect([out.applied, out.fine_applied]).toEqual(['1200.00', '0.000']);
    const stored = await allocRows(w, c);
    expect(stored).toHaveLength(2);
    for (const a of out.allocations) {
      expect(a).toMatchObject({ customer_id: c, released_at: null, created_at: AT, updated_at: AT });
      expect(stored.find((s) => s.id === a.id)).toMatchObject({ receipt_id: a.receipt_id, bill_id: a.bill_id, customer_id: c, amount: a.amount, fine_grams: a.fine_grams, released_at: null });
    }
    expect(stored.map((s) => String(s.created_at)), "the stamp is the call's reading, not the database clock").toEqual([AT, AT]);
  });

  it('a second call adds nothing and sends no write (the books already hold the post-condition)', async () => {
    const c = await addCustomer(w);
    await addBill(w, c, '300.00');
    await addReceipt(w, c, '100.00');
    expect((await run(w, c)).allocations).toHaveLength(1);
    const again = await run(w, c);
    expect(again).toEqual({ allocations: [], applied: '0.00', fine_applied: '0.000' });
    expect(await allocRows(w, c)).toHaveLength(1);
  });

  it('never changes an existing allocation: every column of the old rows is the same afterwards', async () => {
    const c = await addCustomer(w);
    const b1 = await addBill(w, c, '1000.00', { bill_date: '2026-10-01' });
    await addBill(w, c, '400.00', { bill_date: '2026-10-02' });
    const r1 = await addReceipt(w, c, '600.00');
    await addAllocation(w, r1, b1, c, '300.00', { created_at: OLD, updated_at: OLD });
    const before = await allocRows(w, c);
    const out = await run(w, c);
    expect(out.allocations.map((a) => [a.bill_id, a.amount])).toEqual([[b1, '300.00']]);
    const after = await allocRows(w, c);
    expect(after.filter((a) => before.some((b) => b.id === a.id))).toEqual(before);
    expect(after).toHaveLength(before.length + 1);
  });

  it('touches the bills that received money and the customer (D23) with `at`, and nobody else; a bill made in this call is not touched again', async () => {
    const c = await addCustomer(w, { updated_at: OLD });
    const other = await addCustomer(w, { updated_at: OLD });
    const paid = await addBill(w, c, '100.00', { bill_date: '2026-10-01', updated_at: OLD });
    const idle = await addBill(w, c, '900.00', { bill_date: '2026-10-09', updated_at: OLD });
    const otherBill = await addBill(w, other, '100.00', { updated_at: OLD });
    await addReceipt(w, c, '100.00');
    await run(w, c);
    expect(await stampOf(w, 'bills', paid)).toBe(AT);
    expect(await stampOf(w, 'customers', c)).toBe(AT);
    expect(await stampOf(w, 'bills', idle)).toBe(OLD);
    expect(await stampOf(w, 'bills', otherBill)).toBe(OLD);
    expect(await stampOf(w, 'customers', other)).toBe(OLD);
  });

  it('a call that applies nothing sends no write at all: no insert, no touch', async () => {
    const c = await addCustomer(w, { updated_at: OLD });
    await addBill(w, c, '100.00', { updated_at: OLD });
    const spy = spyOn(w.pool);
    expect((await run(w, c, { pool: spy.pool })).allocations).toEqual([]);
    expect(spy.sqls().filter((q) => /^\s*(INSERT|UPDATE)\b/i.test(q)), 'the writes of the call').toEqual([]);
    expect(await stampOf(w, 'customers', c)).toBe(OLD);
  });

  it('writes one audit row for each allocation, the same in both mechanisms of L1 (triggers and the Node writer), with the caller and the request', async () => {
    const shape = (a: any) => ({ table_name: a.table_name, action: a.action, actor_role: a.actor_role, old_row: a.old_row, new_row: { ...a.new_row, id: '*', receipt_id: '*', bill_id: '*', customer_id: '*' } });
    const results: Record<string, any[]> = {};
    for (const [name, world, auditMode] of [['triggers', w, undefined], ['node', wn, 'node' as const]] as const) {
      const c = await addCustomer(world);
      await addBill(world, c, '100.00', { bill_date: '2026-10-01' });
      await addBill(world, c, '100.00', { bill_date: '2026-10-02' });
      await addReceipt(world, c, '150.00');
      const before = (await auditRows(world, 'receipt_allocations')).length;
      const out = await run(world, c, { auditMode });
      const rows = (await auditRows(world, 'receipt_allocations')).slice(before);
      expect(rows, name).toHaveLength(2);
      expect(rows.map((r) => r.row_id).sort(), name).toEqual(out.allocations.map((a) => a.id).sort());
      expect(new Set(rows.map((r) => r.request_id)).size, name).toBe(1);
      expect(rows[0].new_row, name).toMatchObject({ amount: '100.00', fine_grams: '0.000', released_at: null, created_at: AT.replace(' ', 'T').replace('T', ' '), updated_at: AT });
      results[name] = rows.map(shape);
      const touches = (await auditRows(world, 'bills')).filter((r) => r.action === 'update');
      expect(touches, `${name}: a touch changes nothing but updated_at and writes no audit row`).toEqual([]);
    }
    expect(results.node).toEqual(results.triggers);
  });

  it('the walk-in is never rebalanced (K5): nothing is written, whatever the books say', async () => {
    const c = await addCustomer(w);
    await addBill(w, c, '70.00');
    await addReceipt(w, c, '70.00');
    const out = await run(w, c, { walkin: true });
    expect(out).toEqual({ allocations: [], applied: '0.00', fine_applied: '0.000' });
    expect(await allocRows(w, c)).toEqual([]);
  });

  it('refuses to run without the customer lock (X0 item 3): LockOrderViolation, a bug in the caller, JV_INTERNAL', async () => {
    const c = await addCustomer(w);
    const ctx = txContext(w.pool, { requestId: randomUUID(), actor: ACTOR });
    const err = await withTx(ctx, async (tx) => {
      const state = await readCustomerState(tx, { fn: 'toy_rebalance', customerId: c });
      return rebalance(tx, { customerId: c, walkin: false, state, at: AT });
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LockOrderViolation);
    expect((err as JvError).code).toBe('JV_INTERNAL');
  });

  it('a state read for another customer is a bug: JV_INTERNAL, nothing written', async () => {
    const c = await addCustomer(w);
    const d = await addCustomer(w);
    const ctx = txContext(w.pool, { requestId: randomUUID(), actor: ACTOR });
    const err = await withTx(ctx, async (tx) => {
      await lockCustomer(tx, c);
      const state = await readCustomerState(tx, { fn: 'toy_rebalance', customerId: d });
      return rebalance(tx, { customerId: c, walkin: false, state, at: AT });
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as JvError).code).toBe('JV_INTERNAL');
  });

  it('a stamp that is not the API clock\'s form is a TypeError (a bug in the caller)', async () => {
    const c = await addCustomer(w);
    const ctx = txContext(w.pool, { requestId: randomUUID(), actor: ACTOR });
    const err = await withTx(ctx, async (tx) => {
      await lockCustomer(tx, c);
      const state = await readCustomerState(tx, { fn: 'toy_rebalance', customerId: c });
      return rebalance(tx, { customerId: c, walkin: false, state, at: '2026-10-17T10:00:00Z' });
    }).catch((e: unknown) => e);
    expect((err as JvError).code).toBe('JV_INTERNAL');
    expect((err as JvError).cause).toBeInstanceOf(TypeError);
  });
});

describe('Y3 / X10 rebalance with what the call itself made after the state was read', () => {
  const insertRow = async (tx: Tx, table: string, row: Record<string, unknown>): Promise<void> => {
    const cols = Object.keys(row);
    await tx.run(`INSERT INTO ${table} (${cols.map((k) => `\`${k}\``).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, Object.values(row) as never[]);
  };
  /** the bill a function inserts after the hook: the row, and the same facts for the rebalance */
  async function newBill(tx: Tx, c: string, o: { date: string; total: string; fine?: string }): Promise<NewBill> {
    const id = randomUUID();
    await insertRow(tx, 'bills', V.bill(c, { id, bill_no: `N-${id.slice(0, 8)}`, bill_date: o.date, subtotal: o.total, grand_total: o.total, fine_weight_due: o.fine ?? '0.000', created_at: AT, updated_at: AT }));
    return { id, bill_date: o.date, created_at: AT, pending: o.total, fine_pending: o.fine ?? '0.000' };
  }

  it('a new bill is placed by bill_date, then created_at: before an older-typed pending bill if its date is earlier, after it if the date is the same', async () => {
    const c = await addCustomer(w);
    const p = await addBill(w, c, '200.00', { bill_date: '2026-10-10', created_at: OLD, updated_at: OLD });
    const adv = await addReceipt(w, c, '150.00', { paid_on: '2026-10-11' });
    let early = '';
    const out = await run(w, c, {
      prepare: async (tx) => {
        const n = await newBill(tx, c, { date: '2026-10-05', total: '100.00' });
        early = n.id;
        return { newBills: [n] };
      },
    });
    expect(out.allocations.map((a) => [a.receipt_id, a.bill_id, a.amount])).toEqual([
      [adv, early, '100.00'],
      [adv, p, '50.00'],
    ]);
    const c2 = await addCustomer(w);
    const p2 = await addBill(w, c2, '200.00', { bill_date: '2026-10-10', created_at: OLD, updated_at: OLD });
    const adv2 = await addReceipt(w, c2, '150.00', { paid_on: '2026-10-11' });
    const same = await run(w, c2, { prepare: async (tx) => ({ newBills: [await newBill(tx, c2, { date: '2026-10-10', total: '100.00' })] }) });
    expect(same.allocations.map((a) => [a.receipt_id, a.bill_id, a.amount]), 'same day: the bill made earlier is older').toEqual([[adv2, p2, '150.00']]);
  });

  it('the named bill goes first even though it is the newest (X10: the new bill takes the money the cancelled one had received)', async () => {
    const c = await addCustomer(w);
    const p = await addBill(w, c, '200.00', { bill_date: '2026-10-01', created_at: OLD, updated_at: OLD });
    const adv = await addReceipt(w, c, '250.00');
    let fresh = '';
    const out = await run(w, c, {
      prepare: async (tx) => {
        const n = await newBill(tx, c, { date: '2026-10-17', total: '100.00' });
        fresh = n.id;
        return { newBills: [n], first: n.id };
      },
    });
    expect(out.allocations.map((a) => [a.receipt_id, a.bill_id, a.amount])).toEqual([
      [adv, fresh, '100.00'],
      [adv, p, '150.00'],
    ]);
  });

  it('a new bill that is paid is not touched again (its stamp is the call\'s already), an older bill that receives money is', async () => {
    const c = await addCustomer(w, { updated_at: OLD });
    const p = await addBill(w, c, '50.00', { bill_date: '2026-10-01', created_at: OLD, updated_at: OLD });
    await addReceipt(w, c, '120.00');
    const spy = spyOn(w.pool);
    await run(w, c, { pool: spy.pool, prepare: async (tx) => ({ newBills: [await newBill(tx, c, { date: '2026-10-17', total: '100.00' })] }) });
    const touches = spy.sqls().filter((q) => /^UPDATE bills SET updated_at/.test(q));
    expect(touches).toHaveLength(1);
    expect(await stampOf(w, 'bills', p)).toBe(AT);
  });

  it('a bill or a receipt handed over as new that the state already holds is a bug in the caller (JV_INTERNAL): it would be counted twice, so nothing is written', async () => {
    const c = await addCustomer(w);
    const b = await addBill(w, c, '200.00', { bill_date: '2026-10-01', created_at: OLD, updated_at: OLD });
    const r = await addReceipt(w, c, '100.00', { paid_on: '2026-10-02' });
    const spy = spyOn(w.pool);
    const twice = await run(w, c, { pool: spy.pool, prepare: async () => ({ newBills: [{ id: b, bill_date: '2026-10-01', created_at: OLD, pending: '200.00', fine_pending: '0.000' }] }) }).catch((e: unknown) => e);
    expect((twice as JvError).code).toBe('JV_INTERNAL');
    const again = await run(w, c, { pool: spy.pool, prepare: async () => ({ newReceipts: [{ id: r, kind: 'money', paid_on: '2026-10-02', created_at: OLD, remaining: '100.00', fine_remaining: '0.000' }] }) }).catch((e: unknown) => e);
    expect((again as JvError).code).toBe('JV_INTERNAL');
    expect(spy.sqls().filter((q) => /^\s*(INSERT|UPDATE)\b/i.test(q))).toEqual([]);
    expect(await allocRows(w, c)).toEqual([]);
  });

  it('a receipt made in this call is spent oldest first among the old ones, and what is left of it may be applied (X2 after its own receipt)', async () => {
    const c = await addCustomer(w);
    const b = await addBill(w, c, '300.00', { bill_date: '2026-10-01', created_at: OLD, updated_at: OLD });
    const old = await addReceipt(w, c, '100.00', { paid_on: '2026-10-02' });
    const fresh = randomUUID();
    const out = await run(w, c, {
      prepare: async (tx) => {
        await insertRow(tx, 'receipts', V.receipt(c, { id: fresh, amount: '150.00', mode: 'Cash', paid_on: '2026-10-17', created_at: AT, updated_at: AT }));
        return { newReceipts: [{ id: fresh, kind: 'money', paid_on: '2026-10-17', created_at: AT, remaining: '150.00', fine_remaining: '0.000' }] };
      },
    });
    expect(out.allocations.map((a) => [a.receipt_id, a.bill_id, a.amount])).toEqual([
      [old, b, '100.00'],
      [fresh, b, '150.00'],
    ]);
    expect(out.applied).toBe('250.00');
  });
});

// ------------------------------------------------------------------ 300 random customers: the API copy and the script give the same allocations

const DATES = ['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03'];
const paise = (text: string): bigint => toUnits(text, 2);
const rupees = (p: bigint): string => fromUnits(p, 2);

interface Made {
  bills: number;
  opening: number;
  money: number;
  silver: number;
  refunds: number;
  cancelled: number;
  voided: number;
  newBills: number;
}

describe('T-B26 the API\'s rebalance and scripts/rebalance.mjs give the same allocations on 300 random customers (ties on date and stamp, opening bills, silver, refunds, voids, cancels, a bill made after the state read)', () => {
  let rw: X0World;
  let u: Connection;
  beforeAll(async () => {
    rw = await x0World('rebalrand');
    u = rw.u;
  }, 120_000);
  afterAll(async () => {
    await rw?.close();
  }, 60_000);

  it('300 customers: same receipts, bills, amounts and order; the old allocations are unchanged; I10 holds for every customer afterwards', async () => {
    const rand = rng(20261017);
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)];
    const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
    const made: Made = { bills: 0, opening: 0, money: 0, silver: 0, refunds: 0, cancelled: 0, voided: 0, newBills: 0 };
    const stampOn = (date: string) => `${date} 0${pick([5, 6])}:00:00.00000${int(0, 2)}`; // ties on the stamp are likely
    let n = 0;
    const customers: { id: string; newBill: Record<string, unknown> | null }[] = [];
    const before = new Map<string, any[]>();

    for (let k = 0; k < 300; k++) {
      const cid = randomUUID();
      await insert(u, 'customers', V.customer({ id: cid, mobile: `9${String(++n).padStart(9, '0')}` }));
      const billList: { id: string; total: bigint; fine: bigint; active: boolean }[] = [];
      for (let i = 0, count = int(0, 6); i < count; i++) {
        const id = randomUUID();
        const date = pick(DATES);
        const opening = rand() < 0.2;
        const active = rand() >= 0.15;
        const total = opening ? BigInt(int(1, 300_000)) : BigInt(int(50, 3000) * 100);
        const fine = rand() < 0.25 ? BigInt(int(1000, 60_000)) : 0n;
        const cancelled = active ? {} : { status: 'cancelled', cancel_reason: 'x', cancelled_at: `${date} 09:00:00.000000`, cancelled_on: date, cancelled_by: randomUUID() };
        await insert(u, 'bills', V.bill(cid, {
          id,
          bill_no: opening ? `OB-${++n}` : `JV-2026-${++n}`,
          bill_date: date,
          doc_type: opening ? 'opening_balance' : 'estimate',
          subtotal: opening ? '0.00' : rupees(total),
          grand_total: rupees(total),
          fine_weight_due: fromUnits(fine, 3),
          created_at: stampOn(date),
          updated_at: stampOn(date),
          ...(opening ? { request_id: null } : {}),
          ...cancelled,
        }));
        billList.push({ id, total, fine, active });
        made.bills++;
        if (opening) made.opening++;
        if (!active) made.cancelled++;
      }
      const recList: { id: string; kind: string; amount: bigint; grams: bigint; live: boolean }[] = [];
      for (let i = 0, count = int(0, 6); i < count; i++) {
        const id = randomUUID();
        const date = pick(DATES);
        const live = rand() >= 0.1;
        const kind = pick(['money', 'money', 'money', 'fine_silver', 'fine_cash']);
        const opening = rand() < 0.15 && kind !== 'fine_cash';
        const amount = kind === 'money' ? BigInt(int(1000, 300_000)) : 0n;
        const grams = kind === 'money' ? 0n : BigInt(int(1000, 40_000));
        const cashAmount = kind === 'fine_cash' ? BigInt(int(1000, 300_000)) : amount;
        const voided = live ? {} : { status: 'voided', void_reason: 'x', voided_at: `${date} 09:00:00.000000`, voided_on: date, voided_by: randomUUID() };
        await insert(u, 'receipts', V.receipt(cid, {
          id,
          kind,
          mode: kind === 'fine_silver' ? null : opening ? 'Other' : 'Cash',
          amount: rupees(cashAmount),
          fine_grams: fromUnits(grams, 3),
          silver_rate: kind === 'fine_cash' ? '85.00' : null,
          paid_on: date,
          is_opening: opening ? 1 : 0,
          created_at: stampOn(date),
          updated_at: stampOn(date),
          ...voided,
        }));
        recList.push({ id, kind, amount: cashAmount, grams, live });
        if (kind === 'money') made.money++;
        else made.silver++;
        if (!live) made.voided++;
      }
      // existing allocations: within what the receipt has left and the bill still needs (and on cancelled bills only released ones, so that V1 and V2 agree)
      const left = new Map(recList.map((r) => [r.id, { m: r.kind === 'money' ? r.amount : 0n, f: r.kind === 'money' ? 0n : r.grams }]));
      const need = new Map(billList.map((b) => [b.id, { m: b.total, f: b.fine }]));
      for (const r of recList) {
        for (const b of billList) {
          if (rand() >= 0.35) continue;
          const lr = left.get(r.id)!;
          const nb = need.get(b.id)!;
          const money = r.kind === 'money';
          const room = money ? (lr.m < nb.m ? lr.m : nb.m) : lr.f < nb.f ? lr.f : nb.f;
          const take = (room * BigInt(int(1, 100))) / 100n;
          if (take <= 0n) continue;
          const released = !b.active;
          await insert(u, 'receipt_allocations', V.allocation(r.id, b.id, cid, {
            amount: money ? rupees(take) : '0.00',
            fine_grams: money ? '0.000' : fromUnits(take, 3),
            created_at: `2026-10-04 07:00:00.${String(++n).padStart(6, '0')}`,
            updated_at: `2026-10-04 07:00:00.${String(n).padStart(6, '0')}`,
            ...(released ? { released_at: '2026-10-05 07:00:00.000000' } : {}),
          }));
          if (r.live && b.active) {
            if (money) {
              lr.m -= take;
              nb.m -= take;
            } else {
              lr.f -= take;
              nb.f -= take;
            }
          } else if (r.live && !b.active) {
            // released: the receipt has its money back
          } else if (!r.live && b.active) {
            // a voided receipt's allocation does not count either
          }
        }
      }
      // money handed back: at most what is left of the live money receipts
      const advance = recList.filter((r) => r.live && r.kind === 'money').reduce((s, r) => s + left.get(r.id)!.m, 0n);
      if (advance > 0n && rand() < 0.3) {
        await insert(u, 'receipts', V.receipt(cid, { kind: 'refund', amount: rupees((advance * BigInt(int(1, 100))) / 100n || 1n), mode: 'Cash', paid_on: pick(DATES), created_at: `2026-10-06 05:00:00.${String(++n).padStart(6, '0')}` }));
        made.refunds++;
      }
      let newBill: Record<string, unknown> | null = null;
      if (rand() < 0.5) {
        const date = pick([...DATES, '2026-10-10']);
        const total = BigInt(int(50, 3000) * 100);
        newBill = V.bill(cid, { id: randomUUID(), bill_no: `NB-${++n}`, bill_date: date, subtotal: rupees(total), grand_total: rupees(total), fine_weight_due: rand() < 0.3 ? fromUnits(BigInt(int(1000, 30_000)), 3) : '0.000', created_at: `2026-10-17 10:00:00.${String(int(1, 999999)).padStart(6, '0')}` });
        newBill.updated_at = newBill.created_at;
        made.newBills++;
      }
      customers.push({ id: cid, newBill });
      before.set(cid, ((await u.query<any[]>('SELECT * FROM receipt_allocations WHERE customer_id = ? ORDER BY created_at, id', [cid]))[0] as any[]));
    }

    // the data really holds what the test claims to cover
    expect(made.opening).toBeGreaterThan(30);
    expect(made.silver).toBeGreaterThan(100);
    expect(made.refunds).toBeGreaterThan(10);
    expect(made.cancelled).toBeGreaterThan(30);
    expect(made.voided).toBeGreaterThan(30);
    expect(made.newBills).toBeGreaterThan(100);

    let withAllocations = 0;
    let withSilver = 0;
    let mismatches = 0;
    let naiveOrderDiffers = 0;
    let naiveCapDiffers = 0;
    for (const { id, newBill } of customers) {
      const cols = newBill ? Object.keys(newBill) : [];
      const insertNew = async (conn: { query: (sql: string, params: unknown[]) => Promise<unknown> }) => {
        if (newBill) await conn.query(`INSERT INTO bills (${cols.map((c) => `\`${c}\``).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, Object.values(newBill));
      };
      // the script (MB04): in a transaction that is rolled back, with the new bill already in the table
      await u.query('START TRANSACTION');
      let viaScript;
      try {
        await insertNew(u);
        viaScript = await rebalanceCustomer(u, id);
      } finally {
        await u.query('ROLLBACK');
      }
      // the API's copy: the state is read BEFORE the new bill, as X1 reads it, and the bill is handed over in memory
      const ctx = txContext(rw.pool, { requestId: randomUUID(), actor: ACTOR });
      let naiveAppended: string[][] = [];
      let naiveNoCap: string[][] = [];
      const viaApi = await withTx(ctx, async (tx) => {
        const customer = await lockCustomer(tx, id);
        const state = await readCustomerState(tx, { fn: 'toy_rebalance', customerId: id });
        const fresh: NewBill[] = [];
        if (newBill) {
          const cols2 = Object.keys(newBill);
          await tx.run(`INSERT INTO bills (${cols2.map((c) => `\`${c}\``).join(', ')}) VALUES (${cols2.map(() => '?').join(', ')})`, Object.values(newBill) as never[]);
          fresh.push({ id: String(newBill.id), bill_date: String(newBill.bill_date), created_at: String(newBill.created_at), pending: String(newBill.grand_total), fine_pending: String(newBill.fine_weight_due) });
        }
        // the negative controls: the same plan with the new bill put LAST instead of in its place, and with the cap of the advance left out; the random data must make both differ from the script's
        const flatten = (p: { allocations: { receipt_id: string; bill_id: string; amount: string; fine_grams: string }[] }) => p.allocations.map((x) => [x.receipt_id, x.bill_id, x.amount, x.fine_grams]);
        const listed = state.openBills.map((b) => ({ id: b.id, pending: b.pending, fine_pending: b.fine_pending }));
        const appended = [...listed, ...fresh.map((b) => ({ id: b.id, pending: b.pending, fine_pending: b.fine_pending }))];
        naiveAppended = flatten(planRebalance({ bills: appended, receipts: state.openReceipts, advance: state.totals.advance, fine_advance: state.totals.fine_advance }));
        naiveNoCap = flatten(planRebalance({ bills: listed, receipts: state.openReceipts, advance: '999999999.00', fine_advance: '999999.000' }));
        return rebalance(tx, { customerId: id, walkin: Number(customer?.is_walkin) === 1, state, at: '2026-10-17 10:00:01.000000', newBills: fresh });
      });
      const a = viaScript.allocations.map((x: any) => [x.receipt_id, x.bill_id, x.amount, x.fine_grams]);
      const b = viaApi.allocations.map((x) => [x.receipt_id, x.bill_id, x.amount, x.fine_grams]);
      if (JSON.stringify(a) !== JSON.stringify(b) || viaScript.applied !== viaApi.applied || viaScript.fine_applied !== viaApi.fine_applied) {
        mismatches++;
        if (mismatches <= 3) expect({ customer: id, api: b, script: a }).toEqual({ customer: id, api: a, script: a });
      }
      if (JSON.stringify(a.map((x: string[]) => x.slice(0, 1).concat(x.slice(2)))) !== JSON.stringify(naiveAppended.map((x) => x.slice(0, 1).concat(x.slice(2))))) naiveOrderDiffers++;
      if (JSON.stringify(a) !== JSON.stringify(naiveNoCap) && !newBill) naiveCapDiffers++;
      if (b.length > 0) withAllocations++;
      if (b.some((x) => x[3] !== '0.000')) withSilver++;
      // the old rows, column for column
      const after = (await u.query<any[]>('SELECT * FROM receipt_allocations WHERE customer_id = ? ORDER BY created_at, id', [id]))[0] as any[];
      const old = before.get(id)!;
      expect(after.filter((x) => old.some((o) => o.id === x.id)), `customer ${id}: an existing allocation changed`).toEqual(old);
      expect(after.length).toBe(old.length + viaApi.allocations.length);
    }
    expect(mismatches).toBe(0);
    expect(naiveOrderDiffers, 'negative control: a new bill put last instead of in its place gives other allocations on many customers').toBeGreaterThan(10);
    expect(naiveCapDiffers, 'negative control: leaving out the cap of the advance spends handed-back money on some customers').toBeGreaterThan(3);
    expect(withAllocations, 'the random data must make the rebalance work on many customers').toBeGreaterThan(100);
    expect(withSilver).toBeGreaterThan(20);
    const inv = await runInvariants(u);
    expect(inv.counts.I10, JSON.stringify(inv.rows.filter((r: any) => r.invariant === 'I10').slice(0, 5))).toBe(0);
  }, 300_000);
});
