import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addFineAllocation, addFineBill, addSilver, cashFine, settle, settled, silver } from './x03-support';
import { type EditWorld, addCustomer, editWorld, newKey, receiptsOf, requestIdOf, rows } from './x02-support';

// API24, X3 settle_fine: the clause of T-D14 for X3. Exactly one audit row for each row the call changes, written in the same transaction, in BOTH mechanisms of L1: (a) the generated triggers, and
// (b) the Node writer of src/db/audit.ts (JV_AUDIT_MODE=node, on a database WITHOUT the triggers). A settlement of 12 g over two bills changes three audited rows: the receipt (insert) and its two
// allocations (insert). The touches of D23 (the bills and the customer: nothing but updated_at) write no row, and the claim row is not an audited table.

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
  { name: 'triggers (L1 a)', label: 'x03audt', options: { triggers: true } },
  { name: 'node writer (L1 b)', label: 'x03audn', options: { config: { auditMode: 'node' as const } } },
];

const shapes: Record<string, Record<string, string[]>> = {};

for (const mode of MODES) {
  describe(`T-D14 X3 settle_fine writes one audit row for each changed row: ${mode.name}`, () => {
    let w: EditWorld;
    beforeAll(async () => {
      w = await editWorld(mode.label, mode.options);
      shapes[mode.name] = {};
    }, 120_000);
    afterAll(async () => {
      await w?.world.close();
    }, 60_000);

    it('12 g in silver on bills owing 10 and 6: 1 receipt and 2 allocations inserted, in the order of the writes, nothing for the touches or the claim, all with the caller, the role and the request id', async () => {
      const c = await addCustomer(w);
      const [a, b] = [await addFineBill(w, c, '500.00', '10.000', '2026-10-01'), await addFineBill(w, c, '300.00', '6.000', '2026-10-05')];
      const res = await settle(w, 'owner', c, silver('12.000', { reference: 'S-1' }));
      const r = await settled(res);
      const log = await auditOf(w, requestIdOf(res));
      expect(log.map((x) => [x.table_name, x.action]), JSON.stringify(log.map((x) => [x.table_name, x.action]))).toEqual([
        ['receipts', 'insert'],
        ['receipt_allocations', 'insert'],
        ['receipt_allocations', 'insert'],
      ]);
      for (const x of log) {
        expect(x.actor).toBe(w.world.fixtures.owner.userId);
        expect(x.actor_role).toBe('owner');
        expect(x.old_row).toBeNull();
      }
      const receipt = log[0];
      expect(receipt.row_id).toBe(r.receipt.id);
      expect(receipt.new_row).toMatchObject({ id: r.receipt.id, customer_id: c, kind: 'fine_silver', mode: null, amount: '0.00', fine_grams: '12.000', silver_rate: null, paid_on: '2026-10-17', reference: 'S-1', is_opening: 0, status: 'active', created_by: w.world.fixtures.owner.userId });
      expect(new Set(log.slice(1).map((x) => x.row_id))).toEqual(new Set(r.allocations.map((x) => x.id)));
      expect(log.slice(1).map((x) => [x.new_row.bill_id, x.new_row.fine_grams, x.new_row.amount])).toEqual([
        [a, '10.000', '0.00'],
        [b, '2.000', '0.00'],
      ]);
      for (const x of log.slice(1)) expect(x.new_row).toMatchObject({ receipt_id: r.receipt.id, customer_id: c, released_at: null });
      expect(log.filter((x) => ['customers', 'bills', 'sys_idempotency', 'sys_counters'].includes(x.table_name)), 'the touches and the bookkeeping are not audited').toEqual([]);
      shapes[mode.name].receipts = Object.keys(receipt.new_row);
      shapes[mode.name].receipt_allocations = Object.keys(log[1].new_row);
    });

    it('a fine settled in cash writes the receipt with its amount, rate and (when the owner gave one) the reason, and the allocation; the audit row holds what the table holds', async () => {
      const c = await addCustomer(w);
      const a = await addFineBill(w, c, '500.00', '2500.000', '2026-10-01');
      const reason = 'a family sold their silver back';
      const res = await settle(w, 'owner', c, cashFine('2000.000', '100.00', { cash_override_reason: reason, notes: 'bar of 2 kg' }));
      const r = await settled(res);
      const log = await auditOf(w, requestIdOf(res));
      expect(log.map((x) => [x.table_name, x.action])).toEqual([
        ['receipts', 'insert'],
        ['receipt_allocations', 'insert'],
      ]);
      expect(log[0].new_row).toMatchObject({ id: r.receipt.id, kind: 'fine_cash', mode: 'Cash', amount: '200000.00', fine_grams: '2000.000', silver_rate: '100.00', cash_override_reason: reason, notes: 'bar of 2 kg' });
      expect(log[1].new_row).toMatchObject({ bill_id: a, fine_grams: '2000.000', amount: '0.00' });
      const [stored] = (await receiptsOf(w, c)).filter((x) => x.id === r.receipt.id);
      for (const col of ['id', 'customer_id', 'kind', 'mode', 'amount', 'fine_grams', 'silver_rate', 'paid_on', 'reference', 'notes', 'is_opening', 'cash_override_reason', 'status', 'created_by', 'updated_by']) {
        expect(String(log[0].new_row[col] ?? null), col).toBe(String(stored[col] ?? null));
      }
    });

    it('a settlement whose rebalance spends silver the customer already holds writes one row for the receipt and one for each allocation, the settlement\'s own first', async () => {
      const c = await addCustomer(w);
      const a = await addFineBill(w, c, '500.00', '5.000', '2026-10-01');
      const b = await addFineBill(w, c, '500.00', '5.000', '2026-10-02');
      // 2 g of silver received and applied to the newer bill, and 2 g more received and not applied: an import may leave books like this (an advance of silver beside a pending bill)
      const applied = await addSilver(w, c, '2.000', '2026-10-03');
      await addFineAllocation(w, applied, b, c, '2.000');
      await addSilver(w, c, '2.000', '2026-10-04');
      const res = await settle(w, 'biller', c, silver('1.000'));
      const r = await settled(res);
      const log = await auditOf(w, requestIdOf(res));
      expect(log.map((x) => x.table_name)).toEqual(['receipts', ...r.allocations.map(() => 'receipt_allocations')]);
      expect(log.slice(1).map((x) => x.row_id)).toEqual(r.allocations.map((x) => x.id));
      expect(r.allocations.length).toBeGreaterThanOrEqual(2);
      expect(a).toBeTruthy();
    });

    it('a replay, a refused call and a failed call write no audit row at all', async () => {
      const c = await addCustomer(w);
      await addFineBill(w, c, '100.00', '5.000', '2026-10-10');
      const key = newKey();
      const payload = silver('2.000');
      await settled(await settle(w, 'biller', c, payload, key));
      const total = async () => Number((await rows(w, 'SELECT COUNT(*) AS n FROM audit_log'))[0].n);
      const before = await total();
      expect((await settle(w, 'biller', c, payload, key)).headers['idempotent-replay']).toBe('true');
      expect((await settle(w, 'biller', c, { ...payload, mode: 'Credit' })).statusCode).toBe(422);
      expect((await settle(w, 'biller', c, { ...payload, bill_id: '00000000-0000-4000-8000-0000000000aa' })).statusCode).toBe(422);
      expect((await settle(w, 'biller', c, silver('3.001'))).statusCode).toBe(409);
      expect((await settle(w, 'staff', c, payload)).statusCode).toBe(403);
      expect(await total()).toBe(before);
    });
  });
}

describe('T-D14 the two mechanisms write rows of the same shape for X3', () => {
  it('the audited columns of a receipt and of an allocation are the same list in both', () => {
    for (const table of ['receipts', 'receipt_allocations']) {
      expect(shapes['node writer (L1 b)']?.[table], table).toBeDefined();
      expect(shapes['node writer (L1 b)'][table]).toEqual(shapes['triggers (L1 a)'][table]);
    }
  });
});
