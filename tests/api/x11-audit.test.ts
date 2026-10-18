import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type EditWorld, addBill, addCustomer, addMoney, editWorld, newKey, paid, pay, receiptsOf, requestIdOf, rows } from './x02-support';
import { voidReceipt, voided } from './x04-support';
import { refund, refunded, upi } from './x11-support';

// API28, X11 issue_refund: the clause of T-D14 for X11. Exactly one audit row for each row the call changes, written in the same transaction, in BOTH mechanisms of L1: (a) the generated triggers,
// and (b) the Node writer of src/db/audit.ts (JV_AUDIT_MODE=node, on a database WITHOUT the triggers). A refund changes one audited row: the receipt (insert). It has no allocations; the touch of the
// customer (D23: nothing but updated_at) writes no row and the claim row is not an audited table. Where the rebalance of the call does apply something (an old state with an advance beside a pending
// bill) the allocation rows follow the receipt. The last test compares the shapes of the two mechanisms.

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
  { name: 'triggers (L1 a)', label: 'x11audt', options: { triggers: true } },
  { name: 'node writer (L1 b)', label: 'x11audn', options: { config: { auditMode: 'node' as const } } },
];

const shapes: Record<string, Record<string, string[]>> = {};

for (const mode of MODES) {
  describe(`T-D14 X11 issue_refund writes one audit row for each changed row: ${mode.name}`, () => {
    let w: EditWorld;
    beforeAll(async () => {
      w = await editWorld(mode.label, mode.options);
      shapes[mode.name] = {};
    }, 120_000);
    afterAll(async () => {
      await w?.world.close();
    }, 60_000);

    async function withAdvance(amount: string): Promise<string> {
      const c = await addCustomer(w);
      await paid(await pay(w, 'owner', c, { amount, mode: 'UPI' }));
      return c;
    }

    it('500 refunded out of 2,000: ONE receipt inserted, nothing for the touch or the claim, with the caller, the role and the request id', async () => {
      const c = await withAdvance('2000.00');
      const res = await refund(w, 'owner', c, upi('500.00', { reference: 'R-1', paid_on: '2026-10-12' }));
      const r = await refunded(res);
      const log = await auditOf(w, requestIdOf(res));
      expect(log.map((x) => [x.table_name, x.action, x.row_id]), JSON.stringify(log.map((x) => [x.table_name, x.action]))).toEqual([['receipts', 'insert', r.receipt.id]]);
      expect(log[0].actor).toBe(w.world.fixtures.owner.userId);
      expect(log[0].actor_role).toBe('owner');
      expect(log[0].old_row).toBeNull();
      expect(log[0].new_row).toMatchObject({ id: r.receipt.id, customer_id: c, kind: 'refund', mode: 'UPI', amount: '500.00', fine_grams: '0.000', silver_rate: null, paid_on: '2026-10-12', reference: 'R-1', is_opening: 0, status: 'active', cash_override_reason: null, created_by: w.world.fixtures.owner.userId });
      expect(log.filter((x) => ['customers', 'bills', 'receipt_allocations', 'sys_idempotency', 'sys_counters'].includes(x.table_name)), 'the touch and the bookkeeping are not audited, a refund has no allocations').toEqual([]);
      shapes[mode.name].receipts = Object.keys(log[0].new_row);
    });

    it('an old state with an advance beside a pending bill: the receipt first, then the allocation the rebalance of the call makes, in the order of the writes', async () => {
      const c = await addCustomer(w);
      const bill = await addBill(w, c, '450.00', '2026-10-01');
      const held = await addMoney(w, c, '500.00', '2026-10-02');
      const res = await refund(w, 'owner', c, upi('100.00'));
      const r = await refunded(res);
      const log = await auditOf(w, requestIdOf(res));
      expect(log.map((x) => [x.table_name, x.action])).toEqual([
        ['receipts', 'insert'],
        ['receipt_allocations', 'insert'],
      ]);
      expect(log[0].row_id).toBe(r.receipt.id);
      expect(log[1].new_row).toMatchObject({ receipt_id: held, bill_id: bill, customer_id: c, amount: '400.00', fine_grams: '0.000', released_at: null });
      expect(log.map((x) => x.actor_role)).toEqual(['owner', 'owner']);
      shapes[mode.name].receipt_allocations = Object.keys(log[1].new_row);
    });

    it('a void of the refund is one UPDATE of the receipt (the audit of X4, here to show the pair: a refund and its void are two rows of one receipt)', async () => {
      const c = await withAdvance('300.00');
      const r = await refunded(await refund(w, 'owner', c, upi('100.00')));
      const res = await voidReceipt(w, 'owner', r.receipt.id, { reason: 'refunded by mistake' });
      await voided(res);
      const log = await auditOf(w, requestIdOf(res));
      expect(log.map((x) => [x.table_name, x.action, x.row_id])).toEqual([['receipts', 'update', r.receipt.id]]);
      expect(log[0].old_row).toMatchObject({ kind: 'refund', status: 'active' });
      expect(log[0].new_row).toMatchObject({ kind: 'refund', status: 'voided', void_reason: 'refunded by mistake' });
      const all = await rows(w, "SELECT action FROM audit_log WHERE table_name = 'receipts' AND row_id = ? ORDER BY id", [r.receipt.id]);
      expect(all.map((x) => x.action)).toEqual(['insert', 'update']);
    });

    it('a replay, a refused call and a failed call write no audit row at all', async () => {
      const c = await withAdvance('100.00');
      const key = newKey();
      const payload = upi('60.00');
      await refunded(await refund(w, 'owner', c, payload, key));
      const total = async () => Number((await rows(w, 'SELECT COUNT(*) AS n FROM audit_log'))[0].n);
      const before = await total();
      expect((await refund(w, 'owner', c, payload, key)).headers['idempotent-replay']).toBe('true'); // a replay
      expect((await refund(w, 'owner', c, upi('50.00'))).statusCode).toBe(409); // more than the 40 that is left
      expect((await refund(w, 'owner', c, { ...payload, mode: 'Credit' })).statusCode).toBe(422);
      expect((await refund(w, 'biller', c, payload)).statusCode).toBe(403);
      expect(await total()).toBe(before);
    });

    it('the audited row is the one the table holds: the stored refund equals the new_row of its audit row', async () => {
      const c = await withAdvance('100.00');
      const res = await refund(w, 'owner', c, { amount: '33.30', mode: 'Bank Transfer', notes: 'cheque no. 12' });
      const r = await refunded(res);
      const [stored] = (await receiptsOf(w, c)).filter((x) => x.id === r.receipt.id);
      const audited = (await auditOf(w, requestIdOf(res)))[0].new_row;
      for (const col of ['id', 'customer_id', 'kind', 'mode', 'amount', 'fine_grams', 'silver_rate', 'paid_on', 'reference', 'notes', 'is_opening', 'cash_override_reason', 'status', 'created_by', 'updated_by']) {
        expect(String(audited[col] ?? null), col).toBe(String(stored[col] ?? null));
      }
    });
  });
}

describe('T-D14 the two mechanisms write rows of the same shape for X11', () => {
  it('the audited columns of a receipt and of an allocation are the same list in both', () => {
    for (const table of ['receipts', 'receipt_allocations']) {
      expect(shapes['node writer (L1 b)']?.[table], table).toBeDefined();
      expect(shapes['node writer (L1 b)'][table]).toEqual(shapes['triggers (L1 a)'][table]);
    }
  });
});
