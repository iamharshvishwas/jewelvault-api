import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Designs, addDesigns } from './x01-support';
import { addSoldPiece, cancelBill, cancelled, voidReceipt, voided } from './x04-support';
import { type EditWorld, addAllocation, addBill, addCustomer, addMoney, editWorld, newKey, requestIdOf, rows } from './x02-support';

// API25, X4 void_receipt and X5 cancel_bill: the clause of T-D14. Exactly one audit row for each row the call changes, written in the same transaction, in BOTH mechanisms of L1: (a) the generated
// triggers, and (b) the Node writer of src/db/audit.ts (JV_AUDIT_MODE=node, on a database WITHOUT the triggers). A void changes the receipt (update) and inserts the allocations of the rebalance; a
// cancel changes the bill (update), releases each open allocation (update), returns each piece to stock (update) and inserts the allocations of the rebalance. The touches of D23 (the bills and the
// customer: nothing but updated_at) write no row, and the claim row is not an audited table. The last test runs ONE scenario in both worlds and compares the rows with the ids and stamps masked: the
// two mechanisms must write the same rows.

interface Audit {
  table_name: string;
  row_id: string;
  action: string;
  actor: string | null;
  actor_role: string;
  request_id: string;
  old_row: any;
  new_row: any;
}

const parse = (v: unknown) => (typeof v === 'string' ? JSON.parse(v) : v);
async function auditOf(w: EditWorld, requestId: string): Promise<Audit[]> {
  const found = await rows(w, 'SELECT table_name, row_id, action, actor, actor_role, request_id, old_row, new_row FROM audit_log WHERE request_id = ? ORDER BY id', [requestId]);
  return found.map((r) => ({ ...r, old_row: parse(r.old_row), new_row: parse(r.new_row) }));
}

const MODES = [
  { name: 'triggers (L1 a)', label: 'x45audt', options: { triggers: true } },
  { name: 'node writer (L1 b)', label: 'x45audn', options: { config: { auditMode: 'node' as const } } },
];

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const STAMP = /\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?Z?/g;
/** An audit row with every id and every stamp replaced by a token, to be compared across two databases. */
const FIXTURE_NAMES = /"(bill_no|sku_no|barcode)":"[^"]*"/g; // random names the fixtures give their rows
const masked = (a: Audit): string => JSON.stringify([a.table_name, a.action, a.actor_role, a.old_row, a.new_row]).replace(UUID, '<id>').replace(STAMP, '<time>').replace(FIXTURE_NAMES, '"$1":"<name>"');

const normalized: Record<string, { void: string[]; cancel: string[]; shapes: Record<string, string[]> }> = {};

for (const mode of MODES) {
  describe(`T-D14 X4 void_receipt and X5 cancel_bill write one audit row for each changed row: ${mode.name}`, () => {
    let w: EditWorld;
    let d: Designs;
    beforeAll(async () => {
      w = await editWorld(mode.label, mode.options);
      d = await addDesigns(w);
      normalized[mode.name] = { void: [], cancel: [], shapes: {} };
    }, 120_000);
    afterAll(async () => {
      await w?.world.close();
    }, 60_000);

    it('X4: a void whose rebalance pays a re-opened bill from a spare payment: 1 receipt updated, 1 allocation inserted, in the order of the writes, nothing for the touches or the claim, all with the caller, the role and the request id', async () => {
      const c = await addCustomer(w);
      const a = await addBill(w, c, '1000.00', '2026-10-01');
      const r1 = await addMoney(w, c, '1000.00', '2026-10-02', { mode: 'UPI' });
      await addAllocation(w, r1, a, c, '1000.00');
      const r2 = await addMoney(w, c, '300.00', '2026-10-03');
      const res = await voidReceipt(w, 'owner', r1, { reason: 'wrong customer' });
      const v = await voided(res);
      const log = await auditOf(w, requestIdOf(res));
      expect(log.map((x) => [x.table_name, x.action]), JSON.stringify(log.map((x) => [x.table_name, x.action]))).toEqual([
        ['receipts', 'update'],
        ['receipt_allocations', 'insert'],
      ]);
      for (const x of log) {
        expect(x.actor).toBe(w.world.fixtures.owner.userId);
        expect(x.actor_role).toBe('owner');
      }
      const [receipt, alloc] = log;
      expect(receipt.row_id).toBe(r1);
      expect(receipt.old_row).toMatchObject({ id: r1, status: 'active', void_reason: null, voided_at: null, voided_on: null, voided_by: null });
      expect(receipt.new_row).toMatchObject({ id: r1, status: 'voided', void_reason: 'wrong customer', voided_on: '2026-10-17', voided_by: w.world.fixtures.owner.userId, amount: '1000.00', updated_by: w.world.fixtures.owner.userId });
      expect(receipt.new_row.voided_at).toBe(receipt.new_row.updated_at);
      expect(alloc.old_row).toBeNull();
      expect(alloc.row_id).toBe(v.allocations[0].id);
      expect(alloc.new_row).toMatchObject({ receipt_id: r2, bill_id: a, customer_id: c, amount: '300.00', released_at: null });
      expect(log.filter((x) => ['customers', 'bills', 'sys_idempotency', 'sys_counters'].includes(x.table_name)), 'the touches and the bookkeeping are not audited').toEqual([]);
      normalized[mode.name].void = log.map(masked);
      normalized[mode.name].shapes.receipts = Object.keys(receipt.new_row);
      normalized[mode.name].shapes.receipt_allocations = Object.keys(alloc.new_row);
    });

    it('X4: a void with nothing to rebalance writes exactly one row, the receipt; a voided refund and a voided silver receipt the same', async () => {
      const c = await addCustomer(w);
      const money = await addMoney(w, c, '100.00', '2026-10-02');
      const refund = await addMoney(w, c, '10.00', '2026-10-03', { kind: 'refund' });
      for (const id of [refund, money]) {
        const res = await voidReceipt(w, 'owner', id);
        await voided(res);
        const log = await auditOf(w, requestIdOf(res));
        expect(log.map((x) => [x.table_name, x.action, x.row_id])).toEqual([['receipts', 'update', id]]);
        expect(log[0].new_row.status).toBe('voided');
      }
    });

    it('X5: a cancel of a bill of two pieces paid by an active receipt and a voided one, beside another pending bill: 1 bill, 2 allocations (released), 2 pieces updated, then the allocation of the rebalance inserted', async () => {
      const c = await addCustomer(w);
      const a = await addBill(w, c, '500.00', '2026-10-01');
      const p1 = await addSoldPiece(w, d.gold24pp, a, 1);
      const p2 = await addSoldPiece(w, d.gold24pp, a, 2);
      const b = await addBill(w, c, '400.00', '2026-10-05');
      const r1 = await addMoney(w, c, '300.00', '2026-10-02');
      const r2 = await addMoney(w, c, '200.00', '2026-10-03', { mode: 'UPI' });
      const al1 = await addAllocation(w, r1, a, c, '300.00');
      const al2 = await addAllocation(w, r2, a, c, '200.00');
      await voided(await voidReceipt(w, 'owner', r2));
      const res = await cancelBill(w, 'owner', a, { reason: 'the customer returned the goods' });
      const r = await cancelled(res);
      const log = await auditOf(w, requestIdOf(res));
      const kinds = log.map((x) => `${x.table_name}:${x.action}`);
      expect(kinds, JSON.stringify(kinds)).toEqual(['bills:update', 'receipt_allocations:update', 'receipt_allocations:update', 'skus:update', 'skus:update', 'receipt_allocations:insert']);
      for (const x of log) {
        expect(x.actor).toBe(w.world.fixtures.owner.userId);
        expect(x.actor_role).toBe('owner');
      }
      const at = r.bill.cancelled_at as string;
      const bill = log[0];
      expect(bill.row_id).toBe(a);
      expect(bill.old_row).toMatchObject({ status: 'active', cancel_reason: null, cancelled_at: null, cancelled_on: null, cancelled_by: null });
      expect(bill.new_row).toMatchObject({ status: 'cancelled', cancel_reason: 'the customer returned the goods', cancelled_on: '2026-10-17', cancelled_by: w.world.fixtures.owner.userId });
      expect(bill.new_row.cancelled_at).toBe(bill.new_row.updated_at);
      expect(new Set(log.slice(1, 3).map((x) => x.row_id))).toEqual(new Set([al1, al2]));
      for (const x of log.slice(1, 3)) {
        expect(x.old_row.released_at).toBeNull();
        expect(x.new_row.released_at).toBe(x.new_row.updated_at);
        expect(x.new_row).toMatchObject({ bill_id: a, customer_id: c });
      }
      expect(new Set(log.slice(3, 5).map((x) => x.row_id))).toEqual(new Set([p1, p2]));
      for (const x of log.slice(3, 5)) {
        expect(x.old_row).toMatchObject({ status: 'Sold', sold_bill_id: a });
        expect(x.new_row).toMatchObject({ status: 'In Stock', sold_bill_id: null, updated_by: w.world.fixtures.owner.userId });
      }
      expect(log[5].old_row).toBeNull();
      expect(log[5].row_id).toBe(r.allocations[0].id);
      expect(log[5].new_row).toMatchObject({ receipt_id: r1, bill_id: b, amount: '300.00', released_at: null });
      expect(at).toBeTruthy();
      expect(log.filter((x) => ['customers', 'sys_idempotency', 'sys_counters'].includes(x.table_name)), 'the touches and the bookkeeping are not audited').toEqual([]);
      normalized[mode.name].cancel = log.map(masked).sort();
      normalized[mode.name].shapes.bills = Object.keys(bill.new_row);
      normalized[mode.name].shapes.skus = Object.keys(log[3].new_row);
      normalized[mode.name].shapes.allocation_update = Object.keys(log[1].new_row);
    });

    it('X5: an opening bill and a bill nobody paid write one row, the bill', async () => {
      const c = await addCustomer(w);
      const a = await addBill(w, c, '100.00', '2026-10-01');
      const res = await cancelBill(w, 'owner', a);
      await cancelled(res);
      expect((await auditOf(w, requestIdOf(res))).map((x) => [x.table_name, x.action, x.row_id])).toEqual([['bills', 'update', a]]);
    });

    it('a replay, a refused call and a failed call write no audit row at all', async () => {
      const c = await addCustomer(w);
      const a = await addBill(w, c, '100.00', '2026-10-01');
      const r = await addMoney(w, c, '100.00', '2026-10-02');
      await addAllocation(w, r, a, c, '100.00');
      const spare = await addMoney(w, c, '50.00', '2026-10-03');
      const refund = await addMoney(w, c, '50.00', '2026-10-04', { kind: 'refund' });
      const total = async () => Number((await rows(w, 'SELECT COUNT(*) AS n FROM audit_log'))[0].n);
      const key = newKey();
      await voided(await voidReceipt(w, 'owner', r, { reason: 'wrong customer' }, key));
      const before = await total();
      expect((await voidReceipt(w, 'owner', r, { reason: 'wrong customer' }, key)).headers['idempotent-replay']).toBe('true');
      expect((await voidReceipt(w, 'owner', r, { reason: 'again' })).statusCode, 'already void').toBe(409);
      expect((await voidReceipt(w, 'owner', spare, { reason: 'no' })).statusCode, 'reason too short').toBe(422);
      expect((await voidReceipt(w, 'owner', spare, { reason: 'refunded already' })).statusCode, 'the money was handed back').toBe(409);
      expect((await voidReceipt(w, 'biller', refund, { reason: 'not mine to void' })).statusCode).toBe(403);
      const x = await cancelBill(w, 'owner', a, { reason: 'wrong customer' }, key);
      expect(x.statusCode, 'the key of the void does not fit this call').toBe(422);
      expect((await cancelBill(w, 'staff', a, { reason: 'not mine to cancel' })).statusCode).toBe(403);
      expect(await total()).toBe(before);
      await cancelled(await cancelBill(w, 'owner', a, { reason: 'wrong customer' }));
      expect((await cancelBill(w, 'owner', a, { reason: 'again' })).statusCode, 'already cancelled').toBe(409);
    });
  });
}

describe('T-D14 the two mechanisms write the same rows for X4 and X5', () => {
  it('the audited columns of a receipt, a bill, a piece and an allocation are the same list in both', () => {
    for (const table of ['receipts', 'receipt_allocations', 'bills', 'skus', 'allocation_update']) {
      expect(normalized['node writer (L1 b)']?.shapes[table], table).toBeDefined();
      expect(normalized['node writer (L1 b)'].shapes[table], table).toEqual(normalized['triggers (L1 a)'].shapes[table]);
    }
  });

  it('the same scenario gives the same rows, ids and stamps masked: the void (in order) and the cancel (as a set within the statements that touch several rows)', () => {
    expect(normalized['node writer (L1 b)'].void).toEqual(normalized['triggers (L1 a)'].void);
    expect(normalized['node writer (L1 b)'].void).toHaveLength(2);
    expect(normalized['node writer (L1 b)'].cancel).toEqual(normalized['triggers (L1 a)'].cancel);
    expect(normalized['node writer (L1 b)'].cancel).toHaveLength(6);
  });
});
