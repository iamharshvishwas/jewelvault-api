import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type CustomerState, readCustomerState } from '../../src/db/state';
import { type TxContext, txContext, withTx } from '../../src/db/tx';
import { stateAfterCancel, stateAfterVoid, uuidOrder } from '../../src/domain/reopen';
import { rng } from '../helpers';
import { type X0World, addAllocation, addBill, addCustomer, addReceipt, x0World } from './x0-support';

// API25, the pure half of X4 and X5 (src/domain/reopen.ts): the state of a customer AS A VOID OR A CANCEL LEAVES IT, worked out in memory from the state the function read before the test hook (X0 item
// 8: a re-read after the hook would hide a missing customer lock). The rebalance that follows allocates from that copy, so it must be what the database says after the change. Each case builds a
// customer by SQL, reads the state the way X4 / X5 do (with the receipt or the bill to re-open), works the new state out, makes the change by SQL and reads the state again: the two must agree on
// every open bill, every open receipt (in the same ORDER, ties on date and stamp included) and every total that V2 holds and the rebalance may read.

let w: X0World;
const ctx = (): TxContext => txContext(w.pool, { requestId: randomUUID(), actor: { id: '11111111-1111-4111-8111-111111111111', role: 'owner' } });

beforeAll(async () => {
  w = await x0World('reopen');
}, 120_000);
afterAll(async () => {
  await w?.close();
}, 60_000);

const stamp = (day: string, n = 0) => `2026-10-${day} 05:00:00.${String(n).padStart(6, '0')}`;
let seq = 0;
const bill = (c: string, total: string, day: string, o: Record<string, unknown> = {}) =>
  addBill(w, c, total, { bill_no: `RO-${++seq}-${randomUUID().slice(0, 6)}`, bill_date: `2026-10-${day}`, created_at: stamp(day, 1), ...o });
const money = (c: string, amount: string, day: string, o: Record<string, unknown> = {}) => addReceipt(w, c, amount, { paid_on: `2026-10-${day}`, created_at: stamp(day, 2), ...o });
const silver = (c: string, grams: string, day: string, o: Record<string, unknown> = {}) => addReceipt(w, c, '0.00', { kind: 'fine_silver', mode: null, fine_grams: grams, paid_on: `2026-10-${day}`, created_at: stamp(day, 3), ...o });
const cashFine = (c: string, grams: string, amount: string, day: string) => addReceipt(w, c, amount, { kind: 'fine_cash', mode: 'Cash', fine_grams: grams, silver_rate: '90.00', paid_on: `2026-10-${day}`, created_at: stamp(day, 4) });
const refund = (c: string, amount: string, day: string) => addReceipt(w, c, amount, { kind: 'refund', paid_on: `2026-10-${day}`, created_at: stamp(day, 5) });
const give = (r: string, b: string, c: string, amount: string, grams = '0.000') => addAllocation(w, r, b, c, amount, { fine_grams: grams });

const read = (customerId: string, reopen?: { receiptId: string } | { billId: string }): Promise<CustomerState> => withTx(ctx(), (tx) => readCustomerState(tx, { fn: 'reopen_test', customerId, ...(reopen ? { reopen } : {}) }));

/** The parts of a state that the rebalance reads and V2 holds, as plain text for a comparison (last_purchase and updated_at are not maintained in memory). */
function essence(s: CustomerState) {
  const t = s.totals;
  return {
    bills: s.openBills.map((b) => [b.id, b.received, b.pending, b.fine_settled, b.fine_pending]),
    receipts: s.openReceipts.map((r) => [r.id, r.used, r.remaining, r.fine_used, r.fine_remaining]),
    totals: [t.billed, t.total_purchases, t.received, t.refunded, t.allocated, t.outstanding, t.advance, t.balance, t.fine_billed, t.fine_received, t.fine_allocated, t.fine_outstanding, t.fine_advance, t.fine_balance],
  };
}

async function voidBySql(receipt: string): Promise<void> {
  await w.u.query("UPDATE receipts SET status = 'voided', void_reason = 'test', voided_at = ?, voided_on = ?, voided_by = ? WHERE id = ?", ['2026-10-20 05:00:00.000000', '2026-10-20', randomUUID(), receipt]);
}
async function cancelBySql(billId: string): Promise<void> {
  await w.u.query("UPDATE bills SET status = 'cancelled', cancel_reason = 'test', cancelled_at = ?, cancelled_on = ?, cancelled_by = ? WHERE id = ?", ['2026-10-20 05:00:00.000000', '2026-10-20', randomUUID(), billId]);
  await w.u.query('UPDATE receipt_allocations SET released_at = ? WHERE bill_id = ? AND released_at IS NULL', ['2026-10-20 05:00:00.000000', billId]);
}

/** X4 on a receipt: the shares are what the function reads (one sum per bill of the receipt's live allocations). */
async function sharesOf(receipt: string) {
  const [found] = await w.u.query<any[]>('SELECT bill_id, SUM(amount) AS amount, SUM(fine_grams) AS fine_grams FROM receipt_allocations WHERE receipt_id = ? AND released_at IS NULL GROUP BY bill_id', [receipt]);
  return (found as any[]).map((r) => ({ bill_id: String(r.bill_id), amount: String(r.amount), fine_grams: String(r.fine_grams) }));
}
async function receiptOf(id: string) {
  const [found] = await w.u.query<any[]>('SELECT id, kind, amount, fine_grams FROM receipts WHERE id = ?', [id]);
  return (found as any[])[0] as { id: string; kind: string; amount: string; fine_grams: string };
}
/** X5 on a bill: every open allocation of the bill, also those of voided receipts. */
async function releasesOf(billId: string) {
  const [found] = await w.u.query<any[]>('SELECT receipt_id, amount, fine_grams FROM receipt_allocations WHERE bill_id = ? AND released_at IS NULL', [billId]);
  return (found as any[]).map((r) => ({ receipt_id: String(r.receipt_id), amount: String(r.amount), fine_grams: String(r.fine_grams) }));
}

async function checkVoid(customer: string, receipt: string): Promise<void> {
  const before = await read(customer, { receiptId: receipt });
  const adjusted = stateAfterVoid(before, await receiptOf(receipt), await sharesOf(receipt));
  await voidBySql(receipt);
  const after = await read(customer);
  expect(essence(adjusted)).toEqual(essence(after));
}
async function checkCancel(customer: string, billId: string): Promise<void> {
  const before = await read(customer, { billId });
  expect(before.bill).not.toBeNull();
  const adjusted = stateAfterCancel(before, before.bill as NonNullable<typeof before.bill>, await releasesOf(billId));
  await cancelBySql(billId);
  const after = await read(customer);
  expect(essence(adjusted)).toEqual(essence(after));
}

describe('the order of the UUID type (S1 and S2 end their ORDER BY with the id)', () => {
  it('uuidOrder is the order MariaDB gives the UUID type: the groups are compared from the right, not from the left like the text', async () => {
    await w.u.query('CREATE TEMPORARY TABLE uuid_probe (id UUID NOT NULL PRIMARY KEY)');
    const random = rng(2510);
    const hex = (n: number) => Array.from({ length: n }, () => '0123456789abcdef'[Math.floor(random() * 16)]).join('');
    const make = () => `${hex(8)}-${hex(4)}-4${hex(3)}-8${hex(3)}-${hex(12)}`;
    const ids = new Set<string>(['00000000-0000-4000-8000-000000000001', '00000001-0000-4000-8000-000000000000']);
    while (ids.size < 300) ids.add(make());
    // ids that share four groups and differ in one, for each group
    for (let k = 0; k < 40; k++) {
      const a = make().split('-');
      const b = make().split('-');
      for (const i of [0, 1, 2, 3, 4]) ids.add(a.map((g, j) => (j === i ? b[j] : g)).join('-'));
    }
    const list = [...ids];
    await w.u.query(`INSERT INTO uuid_probe VALUES ${list.map(() => '(?)').join(', ')}`, list);
    const [found] = await w.u.query<any[]>('SELECT id FROM uuid_probe ORDER BY id');
    expect([...ids].sort(uuidOrder)).toEqual((found as any[]).map((r) => String(r.id)));
    expect([...ids].sort(), 'the plain text order is another one: this is why the ties of S1 are not sorted as text').not.toEqual((found as any[]).map((r) => String(r.id)));
    await w.u.query('DROP TEMPORARY TABLE uuid_probe');
  });
});

describe('stateAfterVoid: the state as the void of a receipt leaves it equals what the database says afterwards', () => {
  it('a payment that paid two bills, beside a spare payment: both bills come back, the voided receipt leaves the open receipts, the advance falls by what it had left', async () => {
    const c = await addCustomer(w);
    const [b1, b2, b3] = [await bill(c, '1000.00', '01'), await bill(c, '800.00', '02'), await bill(c, '500.00', '03')];
    const r1 = await money(c, '1200.00', '04');
    await give(r1, b1, c, '1000.00');
    await give(r1, b2, c, '200.00');
    await money(c, '300.00', '05'); // spare money beside the open bills
    await checkVoid(c, r1);
    expect(b3).toBeTruthy();
  });

  it('a bill that was only part paid by the receipt, and one that it paid in full: the part-paid bill stays among the open bills with more pending, the other joins them in the order of its date', async () => {
    const c = await addCustomer(w);
    const b1 = await bill(c, '1000.00', '01');
    const b2 = await bill(c, '600.00', '02');
    const b3 = await bill(c, '400.00', '03');
    const r1 = await money(c, '1000.00', '04');
    const r2 = await money(c, '600.00', '05');
    await give(r1, b1, c, '400.00');
    await give(r1, b3, c, '400.00'); // b3 paid in full, b1 part paid
    await give(r2, b1, c, '600.00');
    await give(r2, b2, c, '0.01'); // a part payment of the middle bill
    await checkVoid(c, r1);
  });

  it('a voided money receipt with no allocation at all (an advance): only the advance falls', async () => {
    const c = await addCustomer(w);
    const r1 = await money(c, '700.00', '04');
    await money(c, '50.00', '05');
    await checkVoid(c, r1);
  });

  it('a voided refund gives the advance back; a bill paid after the refund is not touched by it', async () => {
    const c = await addCustomer(w);
    const b1 = await bill(c, '1800.00', '06');
    const r1 = await money(c, '2000.00', '01');
    await give(r1, b1, c, '1500.00');
    const f = await refund(c, '500.00', '05');
    await checkVoid(c, f);
  });

  it('silver received and silver settled in cash: the grams come back to the bills and the fine advance falls; the rupees of a fine_cash receipt never reach V2 received', async () => {
    const c = await addCustomer(w);
    const b1 = await bill(c, '100.00', '01', { fine_weight_due: '10.000', sale_type: 'Wholesale' });
    const b2 = await bill(c, '100.00', '02', { fine_weight_due: '6.000', sale_type: 'Wholesale' });
    const s1 = await silver(c, '12.000', '03');
    const s2 = await cashFine(c, '3.000', '270.00', '04');
    await give(s1, b1, c, '0.00', '10.000');
    await give(s1, b2, c, '0.00', '2.000');
    await give(s2, b2, c, '0.00', '3.000');
    await silver(c, '1.500', '05');
    await checkVoid(c, s1);
    await checkVoid(c, s2);
  });

  it('a receipt already spent on a bill that a rebalance later paid from another receipt, with a voided receipt among the rows (it never counts)', async () => {
    const c = await addCustomer(w);
    const b1 = await bill(c, '500.00', '01');
    const r0 = await money(c, '100.00', '02', { status: 'voided', void_reason: 'twice', voided_at: stamp('03', 9), voided_on: '2026-10-03', voided_by: randomUUID() });
    await give(r0, b1, c, '100.00'); // never released, never counted
    const r1 = await money(c, '500.00', '04');
    await give(r1, b1, c, '500.00');
    await checkVoid(c, r1);
  });
});

describe('stateAfterCancel: the state as the cancel of a bill leaves it equals what the database says afterwards', () => {
  it('a paid bill: the bill leaves the totals, its receipt comes back with the money it had spent on it, the advance grows by that money', async () => {
    const c = await addCustomer(w);
    const b1 = await bill(c, '1000.00', '01');
    const b2 = await bill(c, '600.00', '03');
    const r1 = await money(c, '1000.00', '02');
    await give(r1, b1, c, '1000.00');
    await checkCancel(c, b1);
    expect(b2).toBeTruthy();
  });

  it('a bill paid by two receipts, one of them also paying another bill and one voided: only the active receipts get their money back; the voided one is released and ignored', async () => {
    const c = await addCustomer(w);
    const b1 = await bill(c, '1000.00', '01');
    const b2 = await bill(c, '300.00', '02');
    const b3 = await bill(c, '200.00', '05');
    const r1 = await money(c, '700.00', '03');
    const r2 = await money(c, '400.00', '04');
    const r3 = await money(c, '100.00', '04', { status: 'voided', void_reason: 'twice', voided_at: stamp('05', 9), voided_on: '2026-10-05', voided_by: randomUUID() });
    await give(r1, b1, c, '600.00');
    await give(r1, b2, c, '100.00');
    await give(r2, b1, c, '300.00');
    await give(r2, b2, c, '100.00');
    await give(r3, b1, c, '100.00'); // the voided receipt: its allocation is open but does not count
    await checkCancel(c, b1);
    expect(b3).toBeTruthy();
  });

  it('a bill that owes silver: the grams of silver receipts come back, the bill leaves fine_billed', async () => {
    const c = await addCustomer(w);
    const b1 = await bill(c, '100.00', '01', { fine_weight_due: '10.000', sale_type: 'Wholesale' });
    const b2 = await bill(c, '100.00', '02', { fine_weight_due: '5.000', sale_type: 'Wholesale' });
    const s1 = await silver(c, '8.000', '03');
    const s2 = await cashFine(c, '2.000', '180.00', '04');
    await give(s1, b1, c, '0.00', '8.000');
    await give(s2, b1, c, '0.00', '2.000');
    await checkCancel(c, b1);
    expect(b2).toBeTruthy();
  });

  it('an opening bill (doc_type opening_balance) leaves billed but not total_purchases', async () => {
    const c = await addCustomer(w);
    const ob = await bill(c, '700.00', '01', { doc_type: 'opening_balance', sale_type: 'Retail', bill_no: `OB-${900000 + ++seq}` });
    await bill(c, '300.00', '02');
    const r1 = await money(c, '200.00', '03');
    await give(r1, ob, c, '200.00');
    await checkCancel(c, ob);
  });

  it('a bill nobody has paid: only the totals change', async () => {
    const c = await addCustomer(w);
    const b1 = await bill(c, '250.00', '01');
    await bill(c, '300.00', '02');
    await money(c, '40.00', '03');
    await checkCancel(c, b1);
  });
});

describe('both, on random customers: the in-memory state is what the database says (ties on date and stamp included)', () => {
  it('60 customers of 3 to 6 bills and 2 to 6 receipts, money, silver and refunds, allocated at random; then a random void or a random cancel', async () => {
    const random = rng(25);
    const pick = <T>(list: T[]): T => list[Math.floor(random() * list.length)];
    const whole = (max: number) => 1 + Math.floor(random() * max);
    for (let round = 0; round < 60; round++) {
      const c = await addCustomer(w);
      const day = () => String(1 + Math.floor(random() * 3)).padStart(2, '0');
      const tie = random() < 0.5; // bills of the same date and the same stamp: the id decides, in the database's UUID order
      const bills: { id: string; total: bigint; fine: bigint; left: bigint; fineLeft: bigint }[] = [];
      for (let i = 0; i < 3 + Math.floor(random() * 4); i++) {
        const total = BigInt(whole(20) * 100);
        const fine = random() < 0.4 ? BigInt(whole(9000)) : 0n;
        const d = tie ? '02' : day();
        const id = await bill(c, `${total}.00`, d, { fine_weight_due: `${fine / 1000n}.${String(fine % 1000n).padStart(3, '0')}`, sale_type: fine > 0n ? 'Wholesale' : 'Retail', ...(tie ? { created_at: stamp('02', 1) } : {}) });
        bills.push({ id, total, fine, left: total * 100n, fineLeft: fine });
      }
      const receipts: { id: string; kind: string; amount: bigint; grams: bigint }[] = [];
      for (let i = 0; i < 2 + Math.floor(random() * 5); i++) {
        const kind = pick(['money', 'money', 'money', 'fine_silver', 'fine_cash', 'refund']);
        const d = tie ? '05' : String(4 + Math.floor(random() * 3)).padStart(2, '0');
        if (kind === 'money') {
          const amount = BigInt(whole(2000)) * 100n;
          const id = await money(c, `${amount / 100n}.00`, d, tie ? { created_at: stamp('05', 2) } : {});
          receipts.push({ id, kind, amount, grams: 0n });
        } else if (kind === 'refund') {
          await refund(c, `${whole(5)}0.00`, d);
        } else {
          const grams = BigInt(whole(6000));
          const text = `${grams / 1000n}.${String(grams % 1000n).padStart(3, '0')}`;
          const id = kind === 'fine_silver' ? await silver(c, text, d, tie ? { created_at: stamp('05', 3) } : {}) : await cashFine(c, text, '90.00', d);
          receipts.push({ id, kind, amount: 0n, grams });
        }
      }
      // allocate at random, never past what a receipt has or a bill owes
      const spent = new Map<string, bigint>();
      for (const r of receipts) {
        for (const b of bills) {
          if (random() < 0.5) continue;
          const have = (r.kind === 'money' ? r.amount : r.grams) - (spent.get(r.id) ?? 0n);
          const need = r.kind === 'money' ? b.left : b.fineLeft;
          const take = have < need ? have : need;
          if (take <= 0n) continue;
          const part = take === 1n ? take : (take * BigInt(1 + Math.floor(random() * 3))) / 3n || take;
          const amount = part > take ? take : part;
          spent.set(r.id, (spent.get(r.id) ?? 0n) + amount);
          if (r.kind === 'money') {
            b.left -= amount;
            await give(r.id, b.id, c, `${amount / 100n}.${String(amount % 100n).padStart(2, '0')}`);
          } else {
            b.fineLeft -= amount;
            await give(r.id, b.id, c, '0.00', `${amount / 1000n}.${String(amount % 1000n).padStart(3, '0')}`);
          }
        }
      }
      if (random() < 0.5 && receipts.length > 0) await checkVoid(c, pick(receipts).id);
      else await checkCancel(c, pick(bills).id);
    }
  }, 240_000);
});
