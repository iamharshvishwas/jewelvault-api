import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Designs, type EditWorld, addCustomer, addDesigns, addRate, billBody, editWorld, item, newKey, piece, postBill, requestIdOf, rows, saved } from './x01-support';

// API20, X1 create_bill: the clause of T-D14 for X1. Exactly one audit row for each row the call changes, written in the same transaction, in BOTH mechanisms of L1: (a) the generated triggers, and
// (b) the Node writer of src/db/audit.ts (JV_AUDIT_MODE=node, on a database WITHOUT the triggers). A bill with three lines changes seven audited rows: the bill (insert), its three lines (insert) and
// its three pieces (update, In Stock to Sold). The customer's touch (D23) changes nothing but updated_at and so writes no row; the claim row is not an audited table.

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
  { name: 'triggers (L1 a)', label: 'x01audt', options: { triggers: true } },
  { name: 'node writer (L1 b)', label: 'x01audn', options: { config: { auditMode: 'node' as const } } },
];

const shapes: Record<string, Record<string, string[]>> = {};

for (const mode of MODES) {
  describe(`T-D14 X1 create_bill writes one audit row for each changed row: ${mode.name}`, () => {
    let w: EditWorld;
    let d: Designs;
    beforeAll(async () => {
      w = await editWorld(mode.label, mode.options);
      d = await addDesigns(w);
      await addRate(w, 'Gold', '22K', '6920.00', '2026-10-17');
    }, 120_000);
    afterAll(async () => {
      await w?.world.close();
    }, 60_000);

    it('a bill of three lines: 1 bill + 3 lines inserted, 3 pieces updated to Sold, nothing for the customer\'s touch or the claim, all with the caller, the role and the request id', async () => {
      const c = await addCustomer(w);
      const [a, b, held] = [await piece(w, d.gold22, { nw: '5.000', retail: '100.00' }), await piece(w, d.gold24pp, { retail: '500.00' }), await piece(w, d.gold24pp, { retail: '700.00', status: 'Reserved' })];
      const res = await postBill(w, 'owner', billBody(c, 'Retail', [item(a, { metal_rate: '6920.00', labour_rate: '100.00' }), item(b, { metal_rate: '500.00' }), item(held, { metal_rate: '700.00' })], { confirm_held: [held] }));
      const r = await saved(res);
      const log = await auditOf(w, requestIdOf(res));
      const count = (table: string, action: string) => log.filter((x) => x.table_name === table && x.action === action).length;
      expect(count('bills', 'insert')).toBe(1);
      expect(count('bill_items', 'insert')).toBe(3);
      expect(count('skus', 'update')).toBe(3);
      expect(log, JSON.stringify(log.map((x) => [x.table_name, x.action]))).toHaveLength(7);
      for (const x of log) {
        expect(x.actor).toBe(w.world.fixtures.owner.userId);
        expect(x.actor_role).toBe('owner');
      }
      // the rows say what changed
      const bill = log.find((x) => x.table_name === 'bills')!;
      expect(bill.row_id).toBe(r.bill.id);
      expect(bill.old_row).toBeNull();
      expect(bill.new_row).toMatchObject({ id: r.bill.id, bill_no: r.bill.bill_no, customer_id: c, status: 'active', grand_total: r.bill.grand_total, round_off: r.bill.round_off, pricing_version: 1, cancelled_on: null });
      expect(new Set(log.filter((x) => x.table_name === 'bill_items').map((x) => x.row_id))).toEqual(new Set(r.items.map((i) => i.id)));
      for (const x of log.filter((y) => y.table_name === 'skus')) {
        expect(x.old_row).toMatchObject({ sold_bill_id: null });
        expect(['In Stock', 'Reserved']).toContain(x.old_row.status);
        expect(x.new_row).toMatchObject({ status: 'Sold', sold_bill_id: r.bill.id });
      }
      expect(log.filter((x) => ['customers', 'sys_idempotency', 'sys_counters'].includes(x.table_name)), 'the touch and the bookkeeping are not audited').toEqual([]);
      // the columns of each audited row, for the comparison of the two mechanisms below
      shapes[mode.name] = {};
      for (const table of ['bills', 'bill_items', 'skus']) shapes[mode.name][table] = Object.keys(log.find((x) => x.table_name === table)!.new_row);
    });

    it('a replay, a refused call and a failed call write no audit row at all', async () => {
      const c = await addCustomer(w);
      const [p, q] = [await piece(w, d.gold24pp, { retail: '10.00' }), await piece(w, d.gold24pp, { retail: '10.00', status: 'Repair' })];
      const key = newKey();
      const cart = billBody(c, 'Retail', [item(p, { metal_rate: '10.00' })]);
      await saved(await postBill(w, 'biller', cart, key));
      const total = async () => Number((await rows(w, 'SELECT COUNT(*) AS n FROM audit_log'))[0].n);
      const before = await total();
      const replay = await postBill(w, 'biller', cart, key);
      expect(replay.headers['idempotent-replay']).toBe('true');
      expect((await postBill(w, 'biller', billBody(c, 'Retail', [item(q, { metal_rate: '10.00' })]))).statusCode).toBe(409);
      expect((await postBill(w, 'biller', { ...cart, surprise: 1 })).statusCode).toBe(422);
      expect(await total()).toBe(before);
    });

    it('the audited rows are the ones the tables hold: the stored bill, its lines and its pieces equal the new_row of their audit rows', async () => {
      const c = await addCustomer(w);
      const p = await piece(w, d.gold22, { nw: '35.420', retail: '353.00' });
      const res = await postBill(w, 'biller', billBody(c, 'Retail', [item(p, { metal_rate: '6920.00', labour_rate: '353.00', piroi: '2.15' })]));
      const r = await saved(res);
      const log = await auditOf(w, requestIdOf(res));
      const [bill] = await rows(w, 'SELECT * FROM bills WHERE id = ?', [r.bill.id]);
      const audited = log.find((x) => x.table_name === 'bills')!.new_row;
      for (const col of ['bill_no', 'customer_id', 'bill_date', 'doc_type', 'sale_type', 'status', 'pricing_version', 'subtotal', 'discount', 'additional_charges', 'gst_percent', 'gst_amount', 'grand_total', 'round_off', 'fine_weight_due', 'request_id']) {
        expect(String(audited[col]), col).toBe(String(bill[col]));
      }
      const line = log.find((x) => x.table_name === 'bill_items')!.new_row;
      expect(line).toMatchObject({ metal_amount: '245106.40', labour_amount: '12503.26', item_total: '257611.81', quantity: 1, list_metal_rate: '6920.00' });
    });
  });
}

describe('T-D14 the two mechanisms write rows of the same shape', () => {
  it('the audited columns of the bill, of a line and of a piece are the same list in both', () => {
    for (const table of ['bills', 'bill_items', 'skus']) {
      expect(shapes['node writer (L1 b)']?.[table], table).toBeDefined();
      expect(shapes['node writer (L1 b)'][table]).toEqual(shapes['triggers (L1 a)'][table]);
    }
  });
});

