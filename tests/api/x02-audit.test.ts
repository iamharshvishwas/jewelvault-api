import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type EditWorld, addBill, addCustomer, addMoney, editWorld, newKey, paid, pay, receiptsOf, requestIdOf, rows } from './x02-support';

// API22, X2 record_payment: the clause of T-D14 for X2. Exactly one audit row for each row the call changes, written in the same transaction, in BOTH mechanisms of L1: (a) the generated triggers, and
// (b) the Node writer of src/db/audit.ts (JV_AUDIT_MODE=node, on a database WITHOUT the triggers). A payment of 700 on two bills changes three audited rows: the receipt (insert) and its two
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
  { name: 'triggers (L1 a)', label: 'x02audt', options: { triggers: true } },
  { name: 'node writer (L1 b)', label: 'x02audn', options: { config: { auditMode: 'node' as const } } },
];

const shapes: Record<string, Record<string, string[]>> = {};

for (const mode of MODES) {
  describe(`T-D14 X2 record_payment writes one audit row for each changed row: ${mode.name}`, () => {
    let w: EditWorld;
    beforeAll(async () => {
      w = await editWorld(mode.label, mode.options);
      shapes[mode.name] = {};
    }, 120_000);
    afterAll(async () => {
      await w?.world.close();
    }, 60_000);

    it('700 paid on bills of 500 and 300: 1 receipt and 2 allocations inserted, in the order of the writes, nothing for the touches or the claim, all with the caller, the role and the request id', async () => {
      const c = await addCustomer(w);
      const [a, b] = [await addBill(w, c, '500.00', '2026-10-01'), await addBill(w, c, '300.00', '2026-10-05')];
      const res = await pay(w, 'owner', c, { amount: '700.00', mode: 'UPI', reference: 'R-1' });
      const r = await paid(res);
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
      expect(receipt.new_row).toMatchObject({ id: r.receipt.id, customer_id: c, kind: 'money', mode: 'UPI', amount: '700.00', fine_grams: '0.000', silver_rate: null, paid_on: '2026-10-17', reference: 'R-1', is_opening: 0, status: 'active', created_by: w.world.fixtures.owner.userId });
      expect(new Set(log.slice(1).map((x) => x.row_id))).toEqual(new Set(r.allocations.map((x) => x.id)));
      expect(log.slice(1).map((x) => [x.new_row.bill_id, x.new_row.amount])).toEqual([
        [a, '500.00'],
        [b, '200.00'],
      ]);
      for (const x of log.slice(1)) expect(x.new_row).toMatchObject({ receipt_id: r.receipt.id, customer_id: c, fine_grams: '0.000', released_at: null });
      expect(log.filter((x) => ['customers', 'bills', 'sys_idempotency', 'sys_counters'].includes(x.table_name)), 'the touches and the bookkeeping are not audited').toEqual([]);
      shapes[mode.name].receipts = Object.keys(receipt.new_row);
      shapes[mode.name].receipt_allocations = Object.keys(log[1].new_row);
    });

    it('a payment that allocates nothing (an advance) writes one audit row: the receipt', async () => {
      const c = await addCustomer(w);
      const res = await pay(w, 'biller', c, { amount: '40.00', mode: 'Cash' });
      const r = await paid(res);
      const log = await auditOf(w, requestIdOf(res));
      expect(log.map((x) => [x.table_name, x.action, x.row_id])).toEqual([['receipts', 'insert', r.receipt.id]]);
      expect(log[0].actor_role).toBe('biller');
    });

    it('a payment whose rebalance spends an advance too writes one row for the receipt and one for each allocation, the payment\'s own first', async () => {
      const c = await addCustomer(w);
      await addBill(w, c, '500.00', '2026-10-01');
      await addMoney(w, c, '200.00', '2026-10-05');
      await addMoney(w, c, '200.00', '2026-10-02');
      const res = await pay(w, 'owner', c, { amount: '100.00', mode: 'Other' });
      const r = await paid(res);
      expect(r.allocations).toHaveLength(3);
      const log = await auditOf(w, requestIdOf(res));
      expect(log.map((x) => x.table_name)).toEqual(['receipts', 'receipt_allocations', 'receipt_allocations', 'receipt_allocations']);
      expect(log.slice(1).map((x) => x.row_id)).toEqual(r.allocations.map((x) => x.id));
    });

    it('the owner\'s reason for Cash over the limit is a column of the receipt, so the audit row of the receipt holds it (Z1, API23)', async () => {
      const c = await addCustomer(w);
      const reason = 'wedding party, six payers';
      const res = await pay(w, 'owner', c, { amount: '200000.00', mode: 'Cash', cash_override_reason: reason });
      const r = await paid(res);
      expect(r.receipt.cash_override_reason).toBe(reason);
      const log = await auditOf(w, requestIdOf(res));
      expect(log.map((x) => [x.table_name, x.action])).toEqual([['receipts', 'insert']]);
      expect(log[0].new_row).toMatchObject({ id: r.receipt.id, mode: 'Cash', amount: '200000.00', cash_override_reason: reason });
    });

    it('a replay, a refused call and a failed call write no audit row at all', async () => {
      const c = await addCustomer(w);
      const bill = await addBill(w, c, '100.00', '2026-10-10');
      const key = newKey();
      const payload = { amount: '60.00', mode: 'UPI' };
      await paid(await pay(w, 'biller', c, payload, key));
      const total = async () => Number((await rows(w, 'SELECT COUNT(*) AS n FROM audit_log'))[0].n);
      const before = await total();
      expect((await pay(w, 'biller', c, payload, key)).headers['idempotent-replay']).toBe('true');
      expect((await pay(w, 'biller', c, { ...payload, mode: 'Credit' })).statusCode).toBe(422);
      expect((await pay(w, 'biller', c, { ...payload, bill_id: '00000000-0000-4000-8000-0000000000aa' })).statusCode).toBe(422);
      expect((await pay(w, 'staff', c, payload)).statusCode).toBe(403);
      expect(await total()).toBe(before);
      expect(bill).toBeTruthy();
    });

    it('the audited rows are the ones the tables hold: the stored receipt equals the new_row of its audit row', async () => {
      const c = await addCustomer(w);
      await addBill(w, c, '100.00', '2026-10-10');
      const res = await pay(w, 'owner', c, { amount: '33.30', mode: 'Bank Transfer', notes: 'cheque no. 12' });
      const r = await paid(res);
      const [stored] = (await receiptsOf(w, c)).filter((x) => x.id === r.receipt.id);
      const audited = (await auditOf(w, requestIdOf(res)))[0].new_row;
      for (const col of ['id', 'customer_id', 'kind', 'mode', 'amount', 'fine_grams', 'silver_rate', 'paid_on', 'reference', 'notes', 'is_opening', 'cash_override_reason', 'status', 'created_by', 'updated_by']) {
        expect(String(audited[col] ?? null), col).toBe(String(stored[col] ?? null));
      }
    });
  });
}

describe('T-D14 the two mechanisms write rows of the same shape for X2', () => {
  it('the audited columns of a receipt and of an allocation are the same list in both', () => {
    for (const table of ['receipts', 'receipt_allocations']) {
      expect(shapes['node writer (L1 b)']?.[table], table).toBeDefined();
      expect(shapes['node writer (L1 b)'][table]).toEqual(shapes['triggers (L1 a)'][table]);
    }
  });
});
