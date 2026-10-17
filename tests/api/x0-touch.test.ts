import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LockOrderViolation, lockCustomer } from '../../src/db/locks';
import { touchBills, touchCustomer, touchForBillWrite, touchForReceiptWrite } from '../../src/db/touch';
import { type TxContext, txContext, withTx } from '../../src/db/tx';
import { JvError } from '../../src/errors';
import { spyOn } from './tx-support';
import { type X0World, addAllocation, addBill, addCustomer, addReceipt, x0World } from './x0-support';

// D23 (touches, for polling): the function that writes receipts or allocations also sets updated_at on the affected bills and on the customer, in the same transaction and under the customer lock it
// holds; a bill insert, and a change of a bill's status, does the same for the customer. The audit step skips an update that changes nothing but updated_at, so the touches add no audit noise (T-D14,
// T-E07 clause). The scratch database has the generated audit triggers, so "no audit row" means something.

let w: X0World;
const ACTOR = { id: '11111111-1111-4111-8111-111111111111', role: 'biller' };
const ctx = (): TxContext => txContext(w.pool, { requestId: randomUUID(), actor: ACTOR });
const OLD = '2026-10-01 08:30:15.123457';
const AT = '2026-10-17 10:00:00.250000';

beforeAll(async () => {
  w = await x0World('x0touch', { optional: true });
}, 120_000);
afterAll(async () => {
  await w?.close();
}, 60_000);

const stamp = async (table: 'bills' | 'customers', id: string): Promise<string> => {
  const [rows] = await w.root.query<any[]>(`SELECT DATE_FORMAT(updated_at, '%Y-%m-%d %H:%i:%s.%f') AS s FROM ${w.db()}.${table} WHERE id = ?`, [id]);
  return rows[0].s as string;
};
const auditCount = async (): Promise<number> => Number(((await w.root.query<any[]>(`SELECT COUNT(*) AS n FROM ${w.db()}.audit_log`))[0] as any[])[0].n);

async function world() {
  const c = await addCustomer(w, { updated_at: OLD });
  const other = await addCustomer(w, { updated_at: OLD });
  const b1 = await addBill(w, c, '100.00', { updated_at: OLD });
  const b2 = await addBill(w, c, '200.00', { updated_at: OLD });
  const b3 = await addBill(w, c, '300.00', { updated_at: OLD });
  const ob = await addBill(w, other, '400.00', { updated_at: OLD });
  return { c, other, b1, b2, b3, ob };
}

describe('D23 the touches of a function that writes receipts or allocations', () => {
  it('the affected bills and the customer get the API clock\'s stamp, nobody else does, and the audit log gets nothing', async () => {
    const x = await world();
    const before = await auditCount();
    await withTx(ctx(), async (tx) => {
      await lockCustomer(tx, x.c);
      await touchForReceiptWrite(tx, { customerId: x.c, billIds: [x.b1, x.b2, x.b1], at: AT }); // a bill named twice is touched once
    });
    expect(await stamp('bills', x.b1)).toBe(AT);
    expect(await stamp('bills', x.b2)).toBe(AT);
    expect(await stamp('customers', x.c)).toBe(AT);
    expect(await stamp('bills', x.b3)).toBe(OLD); // not affected
    expect(await stamp('customers', x.other)).toBe(OLD);
    expect(await stamp('bills', x.ob)).toBe(OLD);
    expect(await auditCount(), 'an update that changes nothing but updated_at writes no audit row').toBe(before);
  });

  it('a real change beside the touches is audited once, and the touches add nothing to it', async () => {
    const x = await world();
    const before = await auditCount();
    await withTx(ctx(), async (tx) => {
      await lockCustomer(tx, x.c);
      await tx.run('INSERT INTO receipts (id, customer_id, kind, mode, amount, paid_on) VALUES (?, ?, ?, ?, ?, ?)', [randomUUID(), x.c, 'money', 'UPI', '50.00', '2026-10-17']);
      await touchForReceiptWrite(tx, { customerId: x.c, billIds: [x.b1], at: AT });
    });
    expect(await auditCount()).toBe(before + 1); // the receipt insert only
  });

  it('a bill insert or a change of status touches the customer only; with nothing allocated the bills list may be empty', async () => {
    const x = await world();
    await withTx(ctx(), async (tx) => {
      await lockCustomer(tx, x.c);
      await touchForBillWrite(tx, { customerId: x.c, at: AT });
    });
    expect(await stamp('customers', x.c)).toBe(AT);
    expect(await stamp('bills', x.b1)).toBe(OLD);
    const y = await world();
    await withTx(ctx(), async (tx) => {
      await lockCustomer(tx, y.c);
      await touchForReceiptWrite(tx, { customerId: y.c, billIds: [], at: AT });
    });
    expect(await stamp('customers', y.c)).toBe(AT);
    expect(await stamp('bills', y.b1)).toBe(OLD);
  });

  it('touchBills and touchCustomer are the two statements underneath, one each, by primary key', async () => {
    const x = await world();
    const spy = spyOn(w.pool);
    await withTx(txContext(spy.pool, { requestId: randomUUID(), actor: ACTOR }), async (tx) => {
      await lockCustomer(tx, x.c);
      await touchBills(tx, x.c, [x.b1, x.b2, x.b3], AT);
      await touchCustomer(tx, x.c, AT);
    });
    const updates = spy.sqls().filter((s) => /^UPDATE /.test(s));
    expect(updates).toEqual(['UPDATE bills SET updated_at = ? WHERE customer_id = ? AND id IN (?, ?, ?)', 'UPDATE customers SET updated_at = ? WHERE id = ?']);
  });

  it('a touch without the customer lock, or for another customer than the locked one, is a LockOrderViolation (the touch is made under the lock the function holds)', async () => {
    const x = await world();
    await expect(withTx(ctx(), (tx) => touchForBillWrite(tx, { customerId: x.c, at: AT }))).rejects.toBeInstanceOf(LockOrderViolation);
    await expect(
      withTx(ctx(), async (tx) => {
        await lockCustomer(tx, x.c);
        await touchForBillWrite(tx, { customerId: x.other, at: AT });
      }),
    ).rejects.toBeInstanceOf(LockOrderViolation);
    expect(await stamp('customers', x.c)).toBe(OLD);
    expect(await stamp('customers', x.other)).toBe(OLD);
  });

  it('a bill of another customer in the list is a bug: JV_INTERNAL, and the whole call rolls back (nothing is touched)', async () => {
    const x = await world();
    const e = await withTx(ctx(), async (tx) => {
      await lockCustomer(tx, x.c);
      await touchForReceiptWrite(tx, { customerId: x.c, billIds: [x.b1, x.ob], at: AT });
    }).catch((err: unknown) => err);
    expect(e).toBeInstanceOf(JvError);
    expect((e as JvError).code).toBe('JV_INTERNAL');
    expect(await stamp('bills', x.b1)).toBe(OLD);
    expect(await stamp('bills', x.ob)).toBe(OLD);
  });

  it('what the screens poll by moves: the figures of a customer change when only a receipt and an allocation are written, and the stamp of the bill and the customer is later than before', async () => {
    const x = await world();
    const r = await addReceipt(w, x.c, '100.00');
    await withTx(ctx(), async (tx) => {
      await lockCustomer(tx, x.c);
      await tx.run('INSERT INTO receipt_allocations (id, receipt_id, bill_id, customer_id, amount) VALUES (?, ?, ?, ?, ?)', [randomUUID(), r, x.b1, x.c, '100.00']);
      await touchForReceiptWrite(tx, { customerId: x.c, billIds: [x.b1], at: AT });
    });
    expect(await stamp('bills', x.b1) > OLD).toBe(true);
    expect(await stamp('customers', x.c) > OLD).toBe(true);
    void addAllocation;
  });
});
