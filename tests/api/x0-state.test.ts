import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { S1_TEXT, S2_TEXT, S3_TEXT, S4_TEXT, V2_ONE_TEXT, readCustomerState, readCustomerTotals } from '../../src/db/state';
import { type TxContext, txContext, withRead, withTx } from '../../src/db/tx';
import { loadQueries } from '../../scripts/queries.mjs';
import { V, insert } from '../schema/support';
import { type X0World, addAllocation, addBill, addCustomer, addReceipt, rowOf, x0World } from './x0-support';

// PT-X0 / T-F11 (X0 item 8): the state read of every money function. S1 to S4 and V2 for one customer are the correlated sub-selects of db/queries (never a join to a grouped derived table, RM5-1),
// kept in src/db/stateQueries as the same text and compared with the files here; the read also gives what the change itself re-opens: X4 the bills the voided receipt paid, X5 and X10 the bill and the
// receipts allocated to it. Reading only what is open gave wrong books at the first void, cancel or re-issue in 6 of 6 review sequences.

let w: X0World;
const ctx = (): TxContext => txContext(w.pool, { requestId: randomUUID(), actor: { id: '11111111-1111-4111-8111-111111111111', role: 'biller' } });
const Q = loadQueries();

beforeAll(async () => {
  w = await x0World('x0state');
}, 120_000);
afterAll(async () => {
  await w?.close();
}, 60_000);

describe('PT-X0 the query texts are the files of db/queries, character for character', () => {
  it('S1, S2, S3, S4 and V2 for one customer in src are the text of the query files (a change in one place and not the other fails)', () => {
    expect(S1_TEXT).toBe(Q.S1);
    expect(S2_TEXT).toBe(Q.S2);
    expect(S3_TEXT).toBe(Q.S3);
    expect(S4_TEXT).toBe(Q.S4);
    expect(V2_ONE_TEXT).toBe(Q.V2_one);
  });
});

/** One customer with every kind of event. Worked out by hand in the test below. */
async function fixture() {
  const c = await addCustomer(w);
  const at = (day: string, h = 5) => `2026-10-${day} 0${h}:00:00.000000`;
  const b1 = await addBill(w, c, '1000.00', { bill_no: `JV-X-${randomUUID().slice(0, 6)}`, bill_date: '2026-10-01', created_at: at('01') });
  const b2 = await addBill(w, c, '500.00', { bill_no: `JV-X-${randomUUID().slice(0, 6)}`, bill_date: '2026-10-02', created_at: at('02'), fine_weight_due: '2.000' });
  const b3 = await addBill(w, c, '300.00', { bill_no: `JV-X-${randomUUID().slice(0, 6)}`, bill_date: '2026-10-03', created_at: at('03'), status: 'cancelled', cancel_reason: 'x', cancelled_at: at('04'), cancelled_on: '2026-10-04', cancelled_by: randomUUID() });
  const b4 = await addBill(w, c, '200.00', { bill_no: `JV-X-${randomUUID().slice(0, 6)}`, bill_date: '2026-10-04', created_at: at('04') });
  const r1 = await addReceipt(w, c, '600.00', { paid_on: '2026-10-02', created_at: at('02', 6) });
  const r2 = await addReceipt(w, c, '200.00', { paid_on: '2026-10-04', created_at: at('04', 6) });
  const r3 = await addReceipt(w, c, '500.00', { paid_on: '2026-10-05', created_at: at('05', 6) });
  const r4 = await addReceipt(w, c, '0.00', { kind: 'fine_silver', mode: null, fine_grams: '1.500', paid_on: '2026-10-06', created_at: at('06', 6) });
  const r5 = await addReceipt(w, c, '100.00', { paid_on: '2026-10-07', created_at: at('07', 6), status: 'voided', void_reason: 'twice', voided_at: at('08'), voided_on: '2026-10-08', voided_by: randomUUID() });
  const r6 = await addReceipt(w, c, '50.00', { kind: 'refund', paid_on: '2026-10-09', created_at: at('09', 6) });
  await addAllocation(w, r1, b1, c, '600.00');
  await addAllocation(w, r2, b4, c, '200.00');
  await addAllocation(w, r3, b1, c, '100.00');
  await addAllocation(w, r4, b2, c, '0.00', { fine_grams: '1.000' });
  await addAllocation(w, r5, b2, c, '100.00'); // the receipt was voided: this allocation must not count although it was never released
  return { c, b: { b1, b2, b3, b4 }, r: { r1, r2, r3, r4, r5, r6 } };
}

describe('PT-X0 the state read of X0 item 8, worked out by hand', () => {
  it('the open bills and open receipts in the order Y3 and Y6 ask for, and the totals of the same moment', async () => {
    const f = await fixture();
    const st = await withTx(ctx(), (tx) => readCustomerState(tx, { fn: 'toy_pay', customerId: f.c }));
    // B1 has 700 of 1000, B2 owes all 500 and 1.000 g of silver; B3 is cancelled and B4 is paid: neither is open
    expect(st.openBills.map((b) => [b.id, b.received, b.pending, b.fine_pending])).toEqual([
      [f.b.b1, '700.00', '300.00', '0.000'],
      [f.b.b2, '0.00', '500.00', '1.000'],
    ]);
    // R3 has 400 left, R4 has 0.500 g left; R1 and R2 are spent, R5 is voided, R6 is a refund
    expect(st.openReceipts.map((r) => [r.id, r.kind, r.remaining, r.fine_remaining])).toEqual([
      [f.r.r3, 'money', '400.00', '0.000'],
      [f.r.r4, 'fine_silver', '0.00', '0.500'],
    ]);
    expect(st.totals).toMatchObject({
      id: f.c,
      billed: '1700.00',
      received: '1300.00',
      refunded: '50.00',
      allocated: '900.00',
      outstanding: '800.00',
      advance: '350.00',
      balance: '450.00',
      fine_billed: '2.000',
      fine_received: '1.500',
      fine_allocated: '1.000',
      fine_outstanding: '1.000',
      fine_advance: '0.500',
    });
    expect([st.billsOfReceipt, st.bill, st.receiptsOfBill]).toEqual([[], null, []]);
  });

  it('X4 reads also the bills the receipt\'s live allocations point to, though they are not open: the void re-opens them', async () => {
    const f = await fixture();
    const st = await withTx(ctx(), (tx) => readCustomerState(tx, { fn: 'void_receipt', customerId: f.c, reopen: { receiptId: f.r.r2 } }));
    expect(st.openBills.map((b) => b.id)).not.toContain(f.b.b4);
    expect(st.billsOfReceipt.map((b) => [b.id, b.received, b.pending])).toEqual([[f.b.b4, '200.00', '0.00']]);
    const r1 = await withTx(ctx(), (tx) => readCustomerState(tx, { fn: 'void_receipt', customerId: f.c, reopen: { receiptId: f.r.r1 } }));
    expect(r1.billsOfReceipt.map((b) => [b.id, b.pending])).toEqual([[f.b.b1, '300.00']]);
    // S3 lists the bills a receipt has allocation rows to; the figures count only live allocations (the receipt must be active), so a voided receipt's 100 is in none of them
    const voided = await withTx(ctx(), (tx) => readCustomerState(tx, { fn: 'void_receipt', customerId: f.c, reopen: { receiptId: f.r.r5 } }));
    expect(voided.billsOfReceipt.map((b) => [b.id, b.received, b.pending])).toEqual([[f.b.b2, '0.00', '500.00']]);
  });

  it('X5 and X10 read also the bill and the receipts with live allocations to it, though those receipts are spent', async () => {
    const f = await fixture();
    const st = await withTx(ctx(), (tx) => readCustomerState(tx, { fn: 'cancel_bill', customerId: f.c, reopen: { billId: f.b.b1 } }));
    expect(st.bill).toMatchObject({ id: f.b.b1, status: 'active', grand_total: '1000.00', received: '700.00', pending: '300.00', payment_status: 'Partial' });
    expect(st.openReceipts.map((r) => r.id)).not.toContain(f.r.r1);
    expect(st.receiptsOfBill.map((r) => [r.id, r.used, r.remaining])).toEqual([
      [f.r.r1, '600.00', '0.00'],
      [f.r.r3, '100.00', '400.00'],
    ]);
    const cancelled = await withTx(ctx(), (tx) => readCustomerState(tx, { fn: 'cancel_bill', customerId: f.c, reopen: { billId: f.b.b3 } }));
    expect(cancelled.bill).toMatchObject({ id: f.b.b3, status: 'cancelled', received: '0.00', pending: '0.00', payment_status: 'Cancelled' });
    expect(cancelled.receiptsOfBill).toEqual([]);
  });

  it('every list and figure is exactly what the query file gives for the same customer, and reading needs no transaction (withRead)', async () => {
    const f = await fixture();
    const st = await withRead(ctx(), (r) => readCustomerState(r, { fn: 'toy_pay', customerId: f.c, reopen: { receiptId: f.r.r1 } }));
    // the same protocol as the API's (prepared statements), so a DATETIME(6) is written the same way on both sides
    const direct = async (sql: string, p: string) => (await w.u.execute<any[]>(sql, [p]))[0];
    const strip = (rows: unknown) => JSON.parse(JSON.stringify(rows));
    expect(strip(st.openBills)).toEqual(strip(await direct(Q.S1, f.c)));
    expect(strip(st.openReceipts)).toEqual(strip(await direct(Q.S2, f.c)));
    expect(strip(st.billsOfReceipt)).toEqual(strip(await direct(Q.S3, f.r.r1)));
    const [v2] = (await direct(Q.V2_one, f.c)) as unknown as Record<string, unknown>[];
    expect(strip(st.totals)).toEqual(strip(v2));
  });

  it('readCustomerTotals (the check of the customer archive) gives the same totals alone; a customer that is not there is a bug', async () => {
    const f = await fixture();
    const t = await withTx(ctx(), (tx) => readCustomerTotals(tx, { fn: 'archive_customer', customerId: f.c }));
    expect(t).toMatchObject({ outstanding: '800.00', advance: '350.00' });
    await expect(withTx(ctx(), (tx) => readCustomerTotals(tx, { fn: 'archive_customer', customerId: randomUUID() }))).rejects.toMatchObject({ code: 'JV_INTERNAL' });
  });

  it('a customer with nothing has empty lists and zero totals', async () => {
    const c = await addCustomer(w);
    const st = await withTx(ctx(), (tx) => readCustomerState(tx, { fn: 'toy_pay', customerId: c }));
    expect(st.openBills).toEqual([]);
    expect(st.openReceipts).toEqual([]);
    expect(st.totals).toMatchObject({ billed: '0.00', advance: '0.00', outstanding: '0.00', last_purchase: null });
  });

  it('refuses a call that names both a receipt and a bill to re-open, and a name that is not an id (a bug in the caller)', async () => {
    const c = await addCustomer(w);
    await expect(withTx(ctx(), (tx) => readCustomerState(tx, { fn: 'x', customerId: c, reopen: { receiptId: randomUUID(), billId: randomUUID() } as never }))).rejects.toThrow();
    await expect(withTx(ctx(), (tx) => readCustomerState(tx, { fn: 'x', customerId: 'nope' }))).rejects.toMatchObject({ code: 'JV_INTERNAL', cause: { message: expect.stringMatching(/uuid/i) } });
  });
});

describe('T-F11 (API15 clause): the API\'s own state read answers inside 500 ms for the 10,000-bill customer, on a connection that has just served a small one', () => {
  let big: string;
  let small: string;
  beforeAll(async () => {
    small = await addCustomer(w);
    for (let i = 1; i <= 3; i++) await addBill(w, small, `${1000 * i}.00`);
    big = await addCustomer(w, { name: 'Walk-in sized' });
    const u = w.u; // the ten-box user, with the database selected (the sequence tables seq_1_to_N live in the selected database)
    const d = w.db();
    // each of 10,000 bills paid by its own receipt, every 50th short by 1,000, every 7th owes 1.5 g of silver, every 1000th cancelled with its allocation released (the shape of tests/schema/s17)
    await u.query(`CREATE TABLE ${d}.big_b (n INT PRIMARY KEY, id UUID NOT NULL) ENGINE=InnoDB`);
    await u.query(`INSERT INTO ${d}.big_b SELECT seq, UUID_v4() FROM seq_1_to_10000`);
    await u.query(`INSERT INTO ${d}.bills (id, bill_no, customer_id, bill_date, doc_type, sale_type, status, cancel_reason, cancelled_at, cancelled_on, cancelled_by, pricing_version, subtotal, grand_total, round_off, fine_weight_due, created_at, updated_at)
                   SELECT b.id, CONCAT('BG-', LPAD(b.n, 5, '0')), '${big}', DATE_ADD('2025-01-01', INTERVAL (b.n MOD 400) DAY), 'estimate', 'Retail',
                          IF(b.n MOD 1000 = 0, 'cancelled', 'active'), IF(b.n MOD 1000 = 0, 'x', NULL), IF(b.n MOD 1000 = 0, '2026-01-01 05:00:00', NULL), IF(b.n MOD 1000 = 0, '2026-01-01', NULL), IF(b.n MOD 1000 = 0, UUID_v4(), NULL),
                          1, 20000 + b.n, 20000 + b.n, 0, IF(b.n MOD 7 = 0, 1.5, 0), TIMESTAMPADD(SECOND, b.n, '2025-01-01 05:00:00'), TIMESTAMPADD(SECOND, b.n, '2025-01-01 05:00:00')
                   FROM ${d}.big_b b`);
    await u.query(`INSERT INTO ${d}.receipts (id, customer_id, kind, mode, amount, paid_on, created_at, updated_at)
                   SELECT b.id, '${big}', 'money', 'UPI', 20000 + b.n - IF(b.n MOD 50 = 0, 1000, 0), DATE_ADD('2025-01-01', INTERVAL (b.n MOD 400) DAY), TIMESTAMPADD(SECOND, b.n, '2025-01-01 05:00:01'), TIMESTAMPADD(SECOND, b.n, '2025-01-01 05:00:01') FROM ${d}.big_b b`);
    await u.query(`INSERT INTO ${d}.receipt_allocations (id, receipt_id, bill_id, customer_id, amount, released_at)
                   SELECT UUID_v4(), b.id, b.id, '${big}', 20000 + b.n - IF(b.n MOD 50 = 0, 1000, 0), IF(b.n MOD 1000 = 0, '2026-01-01 05:00:00', NULL) FROM ${d}.big_b b`);
    await w.root.query(`DROP TABLE ${d}.big_b`); // the ten-box user cannot drop
    await u.query(`ANALYZE TABLE ${d}.bills, ${d}.receipts, ${d}.receipt_allocations, ${d}.customers`);
  }, 180_000);

  it('the open bills, the open receipts and the totals together take less than 500 ms through the real pool, and agree with an independent count', async () => {
    await withTx(ctx(), (tx) => readCustomerState(tx, { fn: 'toy_pay', customerId: small })); // the small customer first, on the pool's connection
    const t0 = Date.now();
    const st = await withTx(ctx(), (tx) => readCustomerState(tx, { fn: 'toy_pay', customerId: big }));
    const ms = Date.now() - t0;
    console.log(`[x0] T-F11 state read of the 10,000-bill customer: ${ms} ms, ${st.openBills.length} open bills, ${st.openReceipts.length} open receipts`);
    expect(ms).toBeLessThan(500);
    const live = (col: string) => `COALESCE((SELECT SUM(a.${col}) FROM ${w.db()}.receipt_allocations a WHERE a.bill_id = b.id AND a.released_at IS NULL), 0)`;
    const indep = await rowOf(
      w.root,
      `SELECT COUNT(*) AS n FROM ${w.db()}.bills b WHERE b.customer_id = ? AND b.status = 'active' AND (b.grand_total > ${live('amount')} OR b.fine_weight_due > ${live('fine_grams')})`,
      [big],
    );
    expect(st.openBills.length).toBe(Number(indep.n));
    expect(st.openBills.length).toBeGreaterThan(1000);
    expect(st.totals.id).toBe(big);
    expect(st.openReceipts).toHaveLength(10); // every receipt was spent in full by its own bill, but the 10 bills that were cancelled released theirs: those 10 are waiting as advances
    expect(st.openReceipts.every((r) => r.remaining === r.amount)).toBe(true);
    const keys = st.openBills.map((b) => `${b.bill_date} ${b.created_at}`);
    expect([...keys].sort()).toEqual(keys);
  }, 60_000);
});

void V;
void insert;
