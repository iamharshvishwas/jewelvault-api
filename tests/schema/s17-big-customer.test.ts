import type { Connection } from 'mysql2/promise';
import mysql from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HOST, PORT, dropDb } from '../helpers';
import { rebalanceCustomer } from '../../scripts/rebalance.mjs';
import { Q, T, V, insert, migratedDb } from './support';

// Spec RM5-1, T-F11, V1, X0 item 8 (draft 5.2): reading a BIG customer (the walk-in collects every anonymous sale, 10,000 bills) on a pooled PREPARED connection that has just served a small
// customer. The join-and-group form of V1 took 4.2 s at 2,000 bills and failed with 1969 after 8 s at 10,000 in the review run; the correlated form answers a page in tens of milliseconds.

const WALKIN = '00000000-0000-4000-8000-000000000001';
const LIMIT_MS = 500;
let db: string;
let c: Connection;
let small: string;

/** The first V1 query of the database session (draft 5): bills left-joined to a grouped derived table of allocations. Kept only as the NEGATIVE CONTROL. */
const JOIN_FORM_V1 = `SELECT
  b.id AS id,
  b.bill_no AS bill_no,
  b.customer_id AS customer_id,
  b.bill_date AS bill_date,
  b.doc_type AS doc_type,
  b.sale_type AS sale_type,
  b.status AS status,
  b.reissue_of AS reissue_of,
  b.grand_total AS grand_total,
  CAST(IF(b.status = 'active', COALESCE(a.received, 0), 0) AS DECIMAL(18,2)) AS received,
  CAST(IF(b.status = 'active', b.grand_total - COALESCE(a.received, 0), 0) AS DECIMAL(18,2)) AS pending,
  b.fine_weight_due AS fine_due,
  CAST(IF(b.status = 'active', COALESCE(a.fine_settled, 0), 0) AS DECIMAL(16,3)) AS fine_settled,
  CAST(IF(b.status = 'active', b.fine_weight_due - COALESCE(a.fine_settled, 0), 0) AS DECIMAL(16,3)) AS fine_pending,
  CASE
    WHEN b.status <> 'active' THEN 'Cancelled'
    WHEN b.grand_total - COALESCE(a.received, 0) = 0 AND b.fine_weight_due - COALESCE(a.fine_settled, 0) = 0 THEN 'Paid'
    WHEN COALESCE(a.received, 0) > 0 OR COALESCE(a.fine_settled, 0) > 0 THEN 'Partial'
    ELSE 'Pending'
  END AS payment_status,
  COALESCE(i.item_count, 0) AS item_count,
  b.created_at AS created_at,
  b.updated_at AS updated_at
FROM bills b
LEFT JOIN (
  SELECT al.bill_id AS bill_id, SUM(al.amount) AS received, SUM(al.fine_grams) AS fine_settled
  FROM receipt_allocations al
  JOIN receipts r ON r.id = al.receipt_id
  WHERE al.released_at IS NULL AND r.status = 'active'
  GROUP BY al.bill_id
) a ON a.bill_id = b.id
LEFT JOIN (
  SELECT bill_id, COUNT(*) AS item_count FROM bill_items GROUP BY bill_id
) i ON i.bill_id = b.id`;

/** A pooled connection as the API has it: prepared statements, the statement limit of S11 (8 s), the wait_timeout of 300. */
async function pooled() {
  const x = await mysql.createConnection({ host: HOST, port: PORT, user: 'jv_app', password: 'spike_app_only', database: db, decimalNumbers: false, supportBigNumbers: true, bigNumberStrings: true, dateStrings: true });
  await x.query("SET SESSION transaction_isolation = 'READ-COMMITTED'");
  await x.query('SET SESSION max_statement_time = 8');
  return x;
}
type Timed = { rows: any[]; ms: number; error?: number };
async function timed(x: Connection, sql: string, params: unknown[]): Promise<Timed> {
  const t = Date.now();
  try {
    const [rows] = await x.execute(sql, params as any[]);
    return { rows: rows as any[], ms: Date.now() - t };
  } catch (e) {
    return { rows: [], ms: Date.now() - t, error: (e as { errno?: number }).errno };
  }
}

beforeAll(async () => {
  ({ db, c } = await migratedDb('s17_big'));
  small = ((await insert(c, 'customers', V.customer({ name: 'Small customer', mobile: '9000000042' }))) as { id: string }).id;
  for (let i = 1; i <= 3; i++) {
    const b = (await insert(c, 'bills', V.bill(small, { bill_no: `JV-2026-S${i}`, request_id: null, grand_total: `${1000 * i}.00`, subtotal: `${1000 * i}.00`, import_batch_id: null }))) as { id: string };
    void b;
  }
  // the walk-in at its size: 10,000 bills, each paid by its own receipt and allocation, every 50th short by 1,000 (200 pending bills), 10 cancelled bills with a released allocation
  await c.query(`CREATE TABLE big_b (n INT PRIMARY KEY, id UUID NOT NULL) ENGINE=InnoDB`);
  await c.query(`INSERT INTO big_b SELECT seq, UUID_v4() FROM seq_1_to_10000`);
  await c.query(`INSERT INTO bills (id, bill_no, customer_id, bill_date, doc_type, sale_type, status, cancel_reason, cancelled_at, cancelled_on, cancelled_by, pricing_version, subtotal, grand_total, round_off, fine_weight_due, created_at, updated_at)
                 SELECT b.id, CONCAT('BG-', LPAD(b.n, 5, '0')), '${WALKIN}', DATE_ADD('2025-01-01', INTERVAL (b.n MOD 400) DAY), 'estimate', 'Retail',
                        IF(b.n MOD 1000 = 0, 'cancelled', 'active'), IF(b.n MOD 1000 = 0, 'x', NULL), IF(b.n MOD 1000 = 0, '2026-01-01 05:00:00', NULL), IF(b.n MOD 1000 = 0, '2026-01-01', NULL), IF(b.n MOD 1000 = 0, UUID_v4(), NULL),
                        1, 20000 + b.n, 20000 + b.n, 0, IF(b.n MOD 7 = 0, 1.5, 0), TIMESTAMPADD(SECOND, b.n, '2025-01-01 05:00:00'), TIMESTAMPADD(SECOND, b.n, '2025-01-01 05:00:00')
                 FROM big_b b`);
  await c.query(`INSERT INTO receipts (id, customer_id, kind, mode, amount, paid_on, created_at, updated_at)
                 SELECT b.id, '${WALKIN}', 'money', 'UPI', 20000 + b.n - IF(b.n MOD 50 = 0, 1000, 0), DATE_ADD('2025-01-01', INTERVAL (b.n MOD 400) DAY), TIMESTAMPADD(SECOND, b.n, '2025-01-01 05:00:01'), TIMESTAMPADD(SECOND, b.n, '2025-01-01 05:00:01') FROM big_b b`);
  await c.query(`INSERT INTO receipt_allocations (id, receipt_id, bill_id, customer_id, amount, released_at)
                 SELECT UUID_v4(), b.id, b.id, '${WALKIN}', 20000 + b.n - IF(b.n MOD 50 = 0, 1000, 0), IF(b.n MOD 1000 = 0, '2026-01-01 05:00:00', NULL) FROM big_b b`);
  await c.query('DROP TABLE big_b');
  await c.query('ANALYZE TABLE bills, receipts, receipt_allocations, customers');
}, 180000);
afterAll(async () => {
  await c.end();
  await dropDb(db);
});

const reads = {
  v1: (q: string) => `SELECT * FROM (${q}) v WHERE v.customer_id = ? ORDER BY v.bill_date, v.id LIMIT 1000`,
  v1pending: (q: string) => `SELECT * FROM (${q}) v WHERE v.customer_id = ? AND v.status = 'active' AND (v.pending > 0 OR v.fine_pending > 0)`,
  v3: `SELECT * FROM (${Q.V3}) v WHERE v.customer_id = ? ORDER BY v.entry_date, v.entry_at, v.kind_rank, v.id LIMIT 1000`,
};

describe('T-F11: a customer with 10,000 bills, read on a prepared connection that has just served a small customer', () => {
  it('the fixture is what it says: the walk-in has 10,000 bills, 10 of them cancelled', async () => {
    const [[r]] = await c.query<any[][]>(`SELECT COUNT(*) AS n, SUM(status = 'cancelled') AS cx FROM bills WHERE customer_id = ?`, [WALKIN]);
    expect([Number((r as any).n), Number((r as any).cx)]).toEqual([10000, 10]);
  });

  it('V1 for the big customer: a page of 1,000 rows, the pending list, and V3, each inside 500 ms after the small customer, with the figures of the independent total', async () => {
    const x = await pooled();
    const prime = await timed(x, reads.v1(Q.V1), [small]);
    expect(prime.rows).toHaveLength(3);
    const page = await timed(x, reads.v1(Q.V1), [WALKIN]);
    const pending = await timed(x, reads.v1pending(Q.V1), [WALKIN]);
    const prime2 = await timed(x, reads.v1(Q.V1), [small]);
    const ledger = await timed(x, reads.v3, [WALKIN]);
    console.log(`[s17] V1 page ${page.ms} ms, pending list ${pending.ms} ms (${pending.rows.length} rows), V3 page ${ledger.ms} ms`);
    for (const [name, r] of Object.entries({ page, pending, prime2, ledger })) {
      expect(r.error, name).toBeUndefined();
      expect(r.ms, name).toBeLessThan(LIMIT_MS);
    }
    expect(page.rows).toHaveLength(1000);
    expect(prime2.rows).toHaveLength(3);
    // the figures: the pending list equals an independent count in plain SQL (190 bills short of money, about 1,400 more owing silver, none of the 10 cancelled ones: K3)
    const live = (col: string) => `COALESCE((SELECT SUM(a.${col}) FROM receipt_allocations a WHERE a.bill_id = b.id AND a.released_at IS NULL), 0)`;
    const [[indep]] = await c.query<any[][]>(
      `SELECT COUNT(*) AS n, CAST(SUM(b.grand_total - ${live('amount')}) AS CHAR) AS pending
         FROM bills b WHERE b.customer_id = ? AND b.status = 'active' AND (b.grand_total > ${live('amount')} OR b.fine_weight_due > ${live('fine_grams')})`, [WALKIN]);
    expect(pending.rows.length).toBe(Number((indep as any).n));
    expect(pending.rows.length).toBeGreaterThan(1000);
    const sum = pending.rows.reduce((n, r) => n + Math.round(Number(r.pending) * 100), 0);
    expect(sum).toBe(Math.round(Number((indep as any).pending) * 100));
    await x.end();
  });

  it('the state reads of X0 item 8 for the big customer are inside 500 ms too, in the same order as Y3 asks for, and give what the whole history gives', async () => {
    const x = await pooled();
    await timed(x, reads.v1(Q.V1), [small]);
    const bills = await timed(x, Q.S1, [WALKIN]);
    const receipts = await timed(x, Q.S2, [WALKIN]);
    const totals = await timed(x, Q.V2_one, [WALKIN]);
    console.log(`[s17] open bills ${bills.ms} ms (${bills.rows.length}), open receipts ${receipts.ms} ms (${receipts.rows.length}), totals ${totals.ms} ms`);
    for (const [name, r] of Object.entries({ bills, receipts, totals })) {
      expect(r.error, name).toBeUndefined();
      expect(r.ms, name).toBeLessThan(LIMIT_MS);
    }
    // Y3 order: bill_date, created_at, id
    const keys = bills.rows.map((r) => `${r.bill_date} ${r.created_at}`);
    expect([...keys].sort()).toEqual(keys);
    // the open bills are exactly the pending ones of V1, nothing else
    const [v1] = await c.query<any[]>(`SELECT id FROM (${Q.V1}) v WHERE v.customer_id = ? AND v.status = 'active' AND (v.pending > 0 OR v.fine_pending > 0) ORDER BY v.id`, [WALKIN]);
    expect(bills.rows.map((r) => r.id).sort()).toEqual(v1.map((r) => r.id).sort());
    // the receipts with something left: the short receipts of the 200 short bills have nothing left (each was spent in full), so the list is empty; the totals agree with V2 for everyone
    const [v2] = await c.query<any[]>(`SELECT * FROM (${Q.V2}) v WHERE v.id = ?`, [WALKIN]);
    expect(totals.rows[0]).toEqual(v2[0]);
    await x.end();
  });

  it('NEGATIVE CONTROL: the join-and-group form of V1 fails the same test on a connection that has just served a small customer (over 4 seconds, or error 1969)', async () => {
    const x = await pooled();
    const prime = await timed(x, reads.v1(JOIN_FORM_V1), [small]);
    expect(prime.rows).toHaveLength(3);
    const big = await timed(x, reads.v1(JOIN_FORM_V1), [WALKIN]);
    console.log(`[s17] join form for the big customer after a small one: ${big.error ? `error ${big.error}` : 'ok'} after ${big.ms} ms`);
    expect(big.error === 1969 || big.ms > 4000, `join form: ${big.error ?? 'no error'} in ${big.ms} ms`).toBe(true);
    await x.end();
  }, 60000);

  it('rebalance (Y6) of a customer with a big history stays inside the limit: it reads only what is open, by the same correlated form', async () => {
    const big = (await insert(c, 'customers', V.customer({ name: 'Big named customer', mobile: '9000000043' }))) as { id: string };
    await c.query(`INSERT INTO bills (id, bill_no, customer_id, bill_date, doc_type, sale_type, subtotal, grand_total, created_at)
                   SELECT UUID_v4(), CONCAT('BN-', LPAD(seq, 5, '0')), '${big.id}', DATE_ADD('2025-01-01', INTERVAL (seq MOD 300) DAY), 'estimate', 'Retail', 1000, 1000, TIMESTAMPADD(SECOND, seq, '2025-01-01 05:00:00') FROM seq_1_to_6000`);
    await insert(c, 'receipts', V.receipt(big.id, { amount: '2500.00', mode: 'UPI', paid_on: '2026-10-01' }));
    const x = await pooled();
    await timed(x, reads.v1(Q.V1), [small]);
    const t = Date.now();
    await x.query('START TRANSACTION');
    const r = await rebalanceCustomer(x, big.id);
    await x.query('COMMIT');
    const ms = Date.now() - t;
    console.log(`[s17] rebalance of a customer with 6,000 bills: ${ms} ms, ${r.allocations.length} allocations`);
    expect(r.applied).toBe('2500.00');
    expect(ms).toBeLessThan(2000);
    await x.end();
  }, 60000);
});

void T;
