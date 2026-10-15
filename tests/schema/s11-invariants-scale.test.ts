import type { Connection } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dropDb } from '../helpers';
import { runInvariants } from '../../scripts/invariants.mjs';
import { migratedDb } from './support';

// The nightly check runs inside the tick's own 130-second limit on a shared host. This builds a shop several years deep with bulk SQL
// (3,000 customers, 30,000 bills, 15,000 receipts with their allocations) that is fully consistent, and times each rule.

let db: string;
let c: Connection;
beforeAll(async () => {
  ({ db, c } = await migratedDb('s11_scale'));
  await c.query(`INSERT INTO customers (id, name, mobile, customer_type)
                 SELECT UUID(), CONCAT('Scale ', seq), CONCAT('9', LPAD(seq, 9, '0')), 'Retail' FROM seq_1_to_3000`);
  await c.query(`INSERT INTO bills (id, bill_no, customer_id, bill_date, doc_type, sale_type, subtotal, grand_total, created_at)
                 SELECT UUID(), CONCAT('JV-2026-', LPAD(s.seq, 5, '0')), cu.id, DATE_ADD('2024-01-01', INTERVAL (s.seq DIV 40) DAY), 'estimate', 'Retail', 1000, 1000,
                        TIMESTAMPADD(SECOND, s.seq, '2024-01-01 05:00:00')
                 FROM seq_1_to_30000 s
                 JOIN (SELECT id, ROW_NUMBER() OVER (ORDER BY mobile) AS rn FROM customers WHERE name LIKE 'Scale %') cu ON cu.rn = ((s.seq - 1) MOD 3000) + 1`);
  await c.query("INSERT INTO sys_counters (series, last_value, seed_value) VALUES ('bill:JV:2026', 30000, 0)");
  // every second bill is paid in full: receipt id = bill id (different tables), one allocation each
  await c.query(`INSERT INTO receipts (id, customer_id, kind, mode, amount, paid_on, created_at)
                 SELECT b.id, b.customer_id, 'money', 'Cash', 1000, b.bill_date, b.created_at FROM bills b WHERE CAST(SUBSTRING_INDEX(b.bill_no, '-', -1) AS UNSIGNED) MOD 2 = 1`);
  await c.query(`INSERT INTO receipt_allocations (id, receipt_id, bill_id, customer_id, amount)
                 SELECT UUID(), b.id, b.id, b.customer_id, 1000 FROM bills b WHERE CAST(SUBSTRING_INDEX(b.bill_no, '-', -1) AS UNSIGNED) MOD 2 = 1`);
}, 120000);
afterAll(async () => {
  await c.end();
  await dropDb(db);
});

describe('runInvariants on a deep shop (30,000 bills)', () => {
  it('finds nothing wrong in consistent data, and each rule is fast enough for the nightly tick', async () => {
    const timings: Record<string, number> = {};
    let t = Date.now();
    const total = Date.now();
    const r = await runInvariants(c, { between: async (id) => { timings[id] = Date.now() - t; t = Date.now(); } });
    const ms = Date.now() - total;
    console.log(`[s11] ${ms} ms in all; per rule: ${Object.entries(timings).map(([k, v]) => `${k} ${v} ms`).join(', ')}`);
    expect(r.rows).toEqual([]);
    expect(r.ok).toBe(true);
    expect(ms).toBeLessThan(30000); // the tick has 130 seconds; this leaves a wide margin for a shared host that is slower than this machine
  }, 120000);

  it('the views answer a one-customer question without reading the whole ledger (a filter on customer_id is pushed down)', async () => {
    const [[one]] = await c.query<any[][]>("SELECT id FROM customers WHERE name = 'Scale 77'");
    const t0 = Date.now();
    const [rows] = await c.query<any[]>('SELECT * FROM customer_ledger WHERE customer_id = ? ORDER BY entry_date, entry_at, kind_rank, id', [(one as any).id]);
    const ms = Date.now() - t0;
    console.log(`[s11] customer_ledger for one customer of 3,000: ${rows.length} rows in ${ms} ms`);
    expect(rows.length).toBeGreaterThan(10);
    expect(ms).toBeLessThan(2000);
    const t1 = Date.now();
    await c.query('SELECT * FROM bill_summary WHERE customer_id = ?', [(one as any).id]);
    await c.query('SELECT * FROM customer_balances WHERE id = ?', [(one as any).id]);
    console.log(`[s11] bill_summary + customer_balances for one customer: ${Date.now() - t1} ms`);
  });
});
