import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WALKIN } from './x01-support';
import { addOpening, opened, opening } from './x12-support';
import { type EditWorld, addBill, addCustomer, editWorld, newKey, requestIdOf, rows } from './x02-support';

// API27, X12 add_opening_balance: the clause of T-D14. Exactly one audit row for each row the call changes, written in the same transaction, in BOTH mechanisms of L1: (a) the generated triggers, and
// (b) the Node writer of src/db/audit.ts (JV_AUDIT_MODE=node, on a database WITHOUT the triggers). X12 inserts the opening bill, each opening receipt and each allocation of the rebalance; the touches
// of D23 (the customer and the bills that received money: nothing but updated_at) write no row, and the claim row and the counter are not audited tables. The last test runs ONE scenario in both worlds and
// compares the rows with the ids and stamps masked: the two mechanisms must write the same rows.

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
  { name: 'triggers (L1 a)', label: 'x12audt', options: { triggers: true } },
  { name: 'node writer (L1 b)', label: 'x12audn', options: { config: { auditMode: 'node' as const } } },
];

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const STAMP = /\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?Z?/g;
const FIXTURE_NAMES = /"(bill_no|sku_no|barcode)":"[^"]*"/g; // random names the fixtures give their rows
/** An audit row with every id and every stamp replaced by a token, to be compared across two databases. */
const masked = (a: Audit): string => JSON.stringify([a.table_name, a.action, a.actor_role, a.old_row, a.new_row]).replace(UUID, '<id>').replace(STAMP, '<time>').replace(FIXTURE_NAMES, '"$1":"<name>"').replace(/"OB-\d+"/g, '"OB-<n>"');

const normalized: Record<string, { everything: string[]; shapes: Record<string, string[]> }> = {};

for (const mode of MODES) {
  describe(`T-D14 X12 add_opening_balance writes one audit row for each changed row: ${mode.name}`, () => {
    let w: EditWorld;
    beforeAll(async () => {
      w = await editWorld(mode.label, mode.options);
      normalized[mode.name] = { everything: [], shapes: {} };
    }, 120_000);
    afterAll(async () => {
      await w?.world.close();
    }, 60_000);

    it('dues, fine, an advance and a silver advance beside an older pending bill: 1 bill and 2 receipts inserted, then the 3 allocations of the rebalance, in the order of the writes, nothing for the touches or the claim, all with the caller, the role and the request id', async () => {
      const c = await addCustomer(w);
      const a = await addBill(w, c, '1000.00', '2026-10-01');
      const res = await addOpening(w, 'owner', c, opening({ dues: '300.00', fine_due: '2.000', advance: '500.00', fine_advance: '2.000' }));
      const r = await opened(res);
      const log = await auditOf(w, requestIdOf(res));
      const kinds = log.map((x) => `${x.table_name}:${x.action}`);
      expect(kinds, JSON.stringify(kinds)).toEqual(['bills:insert', 'receipts:insert', 'receipts:insert', 'receipt_allocations:insert', 'receipt_allocations:insert', 'receipt_allocations:insert']);
      for (const x of log) {
        expect(x.actor).toBe(w.world.fixtures.owner.userId);
        expect(x.actor_role).toBe('owner');
        expect(x.old_row).toBeNull();
      }
      const [bill, money, silver, ...allocs] = log;
      expect(bill.row_id).toBe(r.bill?.id);
      expect(bill.new_row).toMatchObject({ id: r.bill?.id, doc_type: 'opening_balance', customer_id: c, grand_total: '300.00', fine_weight_due: '2.000', bill_date: '2026-04-01', status: 'active', created_by: w.world.fixtures.owner.userId });
      expect(money.row_id).toBe(r.receipts[0].id);
      expect(money.new_row).toMatchObject({ kind: 'money', mode: 'Other', amount: '500.00', is_opening: 1, reference: 'Opening advance', status: 'active', created_by: w.world.fixtures.owner.userId });
      expect(silver.row_id).toBe(r.receipts[1].id);
      expect(silver.new_row).toMatchObject({ kind: 'fine_silver', mode: null, amount: '0.00', fine_grams: '2.000', is_opening: 1, reference: 'Opening advance' });
      expect(allocs.map((x) => x.row_id)).toEqual(r.allocations.map((x) => x.id));
      expect(allocs.map((x) => [x.new_row.receipt_id, x.new_row.bill_id, x.new_row.amount, x.new_row.fine_grams])).toEqual([
        [r.receipts[0].id, r.bill?.id, '300.00', '0.000'],
        [r.receipts[0].id, a, '200.00', '0.000'],
        [r.receipts[1].id, r.bill?.id, '0.00', '2.000'],
      ]);
      expect(log.filter((x) => ['customers', 'sys_idempotency', 'sys_counters'].includes(x.table_name)), 'the touches and the bookkeeping are not audited').toEqual([]);
      normalized[mode.name].everything = log.map(masked);
      normalized[mode.name].shapes.bills = Object.keys(bill.new_row);
      normalized[mode.name].shapes.receipts = Object.keys(money.new_row);
      normalized[mode.name].shapes.receipt_allocations = Object.keys(allocs[0].new_row);
    });

    it('dues alone write exactly one row, the bill; an advance alone exactly one row, the receipt; a silver advance alone one row; nothing is written for the customer', async () => {
      const [a, b, d] = [await addCustomer(w), await addCustomer(w), await addCustomer(w)];
      const dues = await addOpening(w, 'owner', a, opening({ dues: '10.00' }));
      await opened(dues);
      expect((await auditOf(w, requestIdOf(dues))).map((x) => [x.table_name, x.action])).toEqual([['bills', 'insert']]);
      const advance = await addOpening(w, 'owner', b, opening({ advance: '10.00' }));
      await opened(advance);
      expect((await auditOf(w, requestIdOf(advance))).map((x) => [x.table_name, x.action])).toEqual([['receipts', 'insert']]);
      const fine = await addOpening(w, 'owner', d, opening({ fine_advance: '1.000' }));
      await opened(fine);
      expect((await auditOf(w, requestIdOf(fine))).map((x) => [x.table_name, x.action])).toEqual([['receipts', 'insert']]);
    });

    it('the walk-in\'s opening dues write one row, the bill (the walk-in is never rebalanced)', async () => {
      const res = await addOpening(w, 'owner', WALKIN, opening({ dues: '10.00' }));
      await opened(res);
      expect((await auditOf(w, requestIdOf(res))).map((x) => [x.table_name, x.action])).toEqual([['bills', 'insert']]);
    });

    it('a replay, a refused call and a failed call write no audit row at all', async () => {
      const c = await addCustomer(w);
      const total = async () => Number((await rows(w, 'SELECT COUNT(*) AS n FROM audit_log'))[0].n);
      const key = newKey();
      await opened(await addOpening(w, 'owner', c, opening({ dues: '100.00', advance: '30.00' }), key));
      const before = await total();
      expect((await addOpening(w, 'owner', c, opening({ dues: '100.00', advance: '30.00' }), key)).headers['idempotent-replay']).toBe('true');
      expect((await addOpening(w, 'owner', WALKIN, opening({ advance: '5.00' }))).statusCode, 'the walk-in takes no advance').toBe(409);
      expect((await addOpening(w, 'owner', c, opening({ dues: '-1.00' }))).statusCode, 'a negative figure').toBe(422);
      expect((await addOpening(w, 'owner', c, opening({}))).statusCode, 'nothing above 0').toBe(422);
      expect((await addOpening(w, 'owner', c, opening({ dues: '1.00' }, { as_of: '2099-01-01' }))).statusCode, 'a future day').toBe(422);
      expect((await addOpening(w, 'biller', c, opening({ dues: '1.00' }))).statusCode, 'a biller').toBe(403);
      expect((await addOpening(w, 'staff', c, opening({ dues: '1.00' }))).statusCode, 'staff').toBe(403);
      expect((await addOpening(w, 'owner', '00000000-0000-4000-8000-0000000000bb', opening({ dues: '1.00' }))).statusCode, 'no such customer').toBe(404);
      expect(await total()).toBe(before);
    });
  });
}

describe('T-D14 the two mechanisms write the same rows for X12', () => {
  it('the audited columns of a bill, a receipt and an allocation are the same list in both', () => {
    for (const table of ['bills', 'receipts', 'receipt_allocations']) {
      expect(normalized['node writer (L1 b)']?.shapes[table], table).toBeDefined();
      expect(normalized['node writer (L1 b)'].shapes[table], table).toEqual(normalized['triggers (L1 a)'].shapes[table]);
    }
  });

  it('the same scenario gives the same rows in the same order, ids and stamps masked', () => {
    expect(normalized['node writer (L1 b)'].everything).toEqual(normalized['triggers (L1 a)'].everything);
    expect(normalized['node writer (L1 b)'].everything).toHaveLength(6);
  });
});
