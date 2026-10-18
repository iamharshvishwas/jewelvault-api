import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Designs, addDesigns, billBody, item, piece, postBill, saved } from './x01-support';
import { type EditWorld, addBill, addCustomer, editWorld, newKey, requestIdOf, rows } from './x02-support';
import { reissueBill, reissueBody, reissued, upi } from './x10-support';

// API26, X10 reissue_bill: the clause of T-D14. Exactly one audit row for each row the call changes, written in the same transaction, in BOTH mechanisms of L1: (a) the generated triggers, and (b) the
// Node writer of src/db/audit.ts (JV_AUDIT_MODE=node, on a database WITHOUT the triggers). A re-issue changes the old bill (update), releases each open allocation of it (update), returns each of its
// pieces to stock (update), inserts the new bill and its lines, marks the pieces of the new bill Sold (update), inserts the allocations of the carried-over money, and then the receipts and the
// allocations of the explicit payments. The touches of D23 (the bills that got money, the customer: nothing but updated_at) write no row, and the claim row is not an audited table. The last test
// runs the same two scenarios in both worlds and compares the rows with the ids and stamps masked: the two mechanisms must write the same rows.

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
  { name: 'triggers (L1 a)', label: 'x10audt', options: { triggers: true } },
  { name: 'node writer (L1 b)', label: 'x10audn', options: { config: { auditMode: 'node' as const } } },
];

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const STAMP = /\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?Z?/g;
const FIXTURE_NAMES = /"(bill_no|sku_no|barcode|design_no)":"[^"]*"/g; // random names the fixtures give their rows
const masked = (a: Audit): string => JSON.stringify([a.table_name, a.action, a.actor_role, a.old_row, a.new_row]).replace(UUID, '<id>').replace(STAMP, '<time>').replace(FIXTURE_NAMES, '"$1":"<name>"');

const normalized: Record<string, { payment: Audit[]; spread: Audit[]; shapes: Record<string, string[]> }> = {};

for (const mode of MODES) {
  describe(`T-D14 X10 reissue_bill writes one audit row for each changed row: ${mode.name}`, () => {
    let w: EditWorld;
    let d: Designs;
    beforeAll(async () => {
      w = await editWorld(mode.label, mode.options);
      d = await addDesigns(w);
      normalized[mode.name] = { payment: [], spread: [], shapes: {} };
    }, 120_000);
    afterAll(async () => {
      await w?.world.close();
    }, 60_000);

    /** A bill A of two Per Piece lines (400 and 600), 300 received by UPI. */
    async function startA(customer: string) {
      const [p1, p2] = [await piece(w, d.gold24pp, { retail: '400.00' }), await piece(w, d.gold24pp, { retail: '600.00' })];
      const made = await saved(await postBill(w, 'owner', billBody(customer, 'Retail', [item(p1, { metal_rate: '400.00' }), item(p2, { metal_rate: '600.00' })], { payments: [upi('300.00')] })));
      return { a: String(made.bill.id), p1, p2, r1: String(made.receipts[0].id), al: String(made.allocations[0].id) };
    }

    it('a re-issue that drops a piece, keeps one, adds one and takes a new payment: 1 bill updated, 1 allocation released, 2 pieces back, then the new bill, its 2 lines, 2 pieces Sold, the carried allocation, the receipt and its allocation, all in the order of the writes', async () => {
      const c = await addCustomer(w);
      const s = await startA(c);
      const p3 = await piece(w, d.gold24pp, { retail: '100.00' });
      const res = await reissueBill(w, 'owner', s.a, reissueBody('Retail', [item(s.p2, { metal_rate: '600.00' }), item(p3, { metal_rate: '100.00' })], { payments: [upi('100.00')] }, 'wrong piece on the bill'));
      const r = await reissued(res);
      const log = await auditOf(w, requestIdOf(res));
      const kinds = log.map((x) => `${x.table_name}:${x.action}`);
      expect(kinds, JSON.stringify(kinds)).toEqual([
        'bills:update',
        'receipt_allocations:update',
        'skus:update',
        'skus:update',
        'bills:insert',
        'bill_items:insert',
        'bill_items:insert',
        'skus:update',
        'skus:update',
        'receipt_allocations:insert',
        'receipts:insert',
        'receipt_allocations:insert',
      ]);
      for (const x of log) {
        expect(x.actor).toBe(w.world.fixtures.owner.userId);
        expect(x.actor_role).toBe('owner');
      }
      const newId = String(r.new_bill.id);
      // the old bill, the released allocation and the two pieces that went back
      expect(log[0].row_id).toBe(s.a);
      expect(log[0].old_row).toMatchObject({ status: 'active', cancel_reason: null, cancelled_at: null, cancelled_on: null, cancelled_by: null, reissue_of: null });
      expect(log[0].new_row).toMatchObject({ status: 'cancelled', cancel_reason: 'wrong piece on the bill', cancelled_on: '2026-10-17', cancelled_by: w.world.fixtures.owner.userId });
      expect(log[0].new_row.cancelled_at).toBe(log[0].new_row.updated_at);
      expect(log[1].row_id).toBe(s.al);
      expect(log[1].old_row.released_at).toBeNull();
      expect(log[1].new_row).toMatchObject({ bill_id: s.a, receipt_id: s.r1 });
      expect(log[1].new_row.released_at).toBe(log[1].new_row.updated_at);
      expect(new Set(log.slice(2, 4).map((x) => x.row_id))).toEqual(new Set([s.p1, s.p2]));
      for (const x of log.slice(2, 4)) {
        expect(x.old_row).toMatchObject({ status: 'Sold', sold_bill_id: s.a });
        expect(x.new_row).toMatchObject({ status: 'In Stock', sold_bill_id: null });
      }
      // the new bill points back, its two lines, and the two pieces that are Sold on it
      expect(log[4].row_id).toBe(newId);
      expect(log[4].old_row).toBeNull();
      expect(log[4].new_row).toMatchObject({ status: 'active', reissue_of: s.a, customer_id: c, grand_total: '700.00', created_by: w.world.fixtures.owner.userId });
      expect(log.slice(5, 7).map((x) => [x.old_row, x.new_row.bill_id])).toEqual([[null, newId], [null, newId]]);
      expect(new Set(log.slice(7, 9).map((x) => x.row_id))).toEqual(new Set([s.p2, p3]));
      for (const x of log.slice(7, 9)) {
        expect(x.old_row).toMatchObject({ status: 'In Stock', sold_bill_id: null });
        expect(x.new_row).toMatchObject({ status: 'Sold', sold_bill_id: newId });
      }
      // the money: the carried allocation first (rebalance), then the receipt of the payment and its allocation
      expect(log[9].old_row).toBeNull();
      expect(log[9].row_id).toBe(r.allocations[0].id);
      expect(log[9].new_row).toMatchObject({ receipt_id: s.r1, bill_id: newId, amount: '300.00', released_at: null });
      expect(log[10].row_id).toBe(r.receipts[0].id);
      expect(log[10].new_row).toMatchObject({ kind: 'money', mode: 'UPI', amount: '100.00', status: 'active' });
      expect(log[11].row_id).toBe(r.allocations[1].id);
      expect(log[11].new_row).toMatchObject({ receipt_id: r.receipts[0].id, bill_id: newId, amount: '100.00' });
      expect(log.filter((x) => ['customers', 'sys_idempotency', 'sys_counters'].includes(x.table_name)), 'the touches and the bookkeeping are not audited').toEqual([]);
      normalized[mode.name].payment = log;
      normalized[mode.name].shapes.bills = Object.keys(log[0].new_row);
      normalized[mode.name].shapes.skus = Object.keys(log[2].new_row);
      normalized[mode.name].shapes.receipt_allocations = Object.keys(log[1].new_row);
      normalized[mode.name].shapes.receipts = Object.keys(log[10].new_row);
    });

    it('a re-issue whose carried-over money also pays an older bill: the two allocations of the rebalance are inserted, the older bill is touched and writes no row of its own', async () => {
      const c = await addCustomer(w);
      const older = await addBill(w, c, '50.00', '2026-10-01');
      const s = await startA(c);
      const before = Number((await rows(w, 'SELECT COUNT(*) AS n FROM audit_log'))[0].n);
      // A is 1,000 with 300 received; the new bill is 250: it takes 250 of the 300 and the older bill takes the remaining 50
      const res = await reissueBill(w, 'owner', s.a, reissueBody('Retail', [item(s.p2, { metal_rate: '250.00' })]));
      const r = await reissued(res);
      const log = await auditOf(w, requestIdOf(res));
      expect(log.map((x) => `${x.table_name}:${x.action}`), JSON.stringify(log.map((x) => x.table_name))).toEqual([
        'bills:update',
        'receipt_allocations:update',
        'skus:update',
        'skus:update',
        'bills:insert',
        'bill_items:insert',
        'skus:update',
        'receipt_allocations:insert',
        'receipt_allocations:insert',
      ]);
      expect(log.slice(7).map((x) => [x.new_row.bill_id, x.new_row.amount])).toEqual([[String(r.new_bill.id), '250.00'], [older, '50.00']]);
      expect(log.filter((x) => x.table_name === 'bills' && x.row_id === older), 'a touch changes nothing but updated_at: no audit row').toEqual([]);
      expect(Number((await rows(w, 'SELECT COUNT(*) AS n FROM audit_log'))[0].n) - before).toBe(log.length);
      normalized[mode.name].spread = log;
    });

    it('a replay, a refused call and a failed call write no audit row at all', async () => {
      const c = await addCustomer(w);
      const s = await startA(c);
      const total = async () => Number((await rows(w, 'SELECT COUNT(*) AS n FROM audit_log'))[0].n);
      const key = newKey();
      const body = reissueBody('Retail', [item(s.p2, { metal_rate: '600.00' })]);
      await reissued(await reissueBill(w, 'owner', s.a, body, key));
      const before = await total();
      expect((await reissueBill(w, 'owner', s.a, body, key)).headers['idempotent-replay']).toBe('true');
      expect((await reissueBill(w, 'owner', s.a, body)).statusCode, 'already cancelled').toBe(409);
      expect((await reissueBill(w, 'owner', s.a, reissueBody('Retail', [item(s.p2, { metal_rate: '1.00' })], { payments: [upi('5.00')] }))).statusCode, 'already cancelled wins over everything').toBe(409);
      expect((await reissueBill(w, 'biller', s.a, body)).statusCode).toBe(403);
      expect((await reissueBill(w, 'owner', s.a, { ...body, reason: 'x' })).statusCode, 'reason too short').toBe(422);
      expect(await total()).toBe(before);
    });
  });
}

describe('T-D14 the two mechanisms write the same rows for X10', () => {
  it('the audited columns of a bill, a piece, an allocation and a receipt are the same list in both', () => {
    for (const table of ['bills', 'skus', 'receipt_allocations', 'receipts']) {
      expect(normalized['node writer (L1 b)']?.shapes[table], table).toBeDefined();
      expect(normalized['node writer (L1 b)'].shapes[table], table).toEqual(normalized['triggers (L1 a)'].shapes[table]);
    }
  });

  it('the same scenarios give the same rows, ids and stamps masked, as a set within the statements that touch several rows', () => {
    for (const scenario of ['payment', 'spread'] as const) {
      const node = normalized['node writer (L1 b)'][scenario].map(masked);
      const triggers = normalized['triggers (L1 a)'][scenario].map(masked);
      expect(node.length, scenario).toBeGreaterThan(0);
      expect([...node].sort(), scenario).toEqual([...triggers].sort());
    }
    expect(normalized['node writer (L1 b)'].payment).toHaveLength(12);
    expect(normalized['node writer (L1 b)'].spread).toHaveLength(9);
  });
});
