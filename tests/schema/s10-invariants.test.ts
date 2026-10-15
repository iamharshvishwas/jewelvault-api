import type { Connection } from 'mysql2/promise';
import { afterAll, describe, expect, it } from 'vitest';
import { dropDb } from '../helpers';
import { listInvariantFiles, runInvariants, type InvariantRow } from '../../scripts/invariants.mjs';
import { V, cleanWorld, insert, migratedDb, uuid } from './support';

// Spec section 12: runInvariants() returns the rows that break each rule; nothing means the books are right.
// Mutation tests (T-B18): each test damages exactly one thing with direct SQL and expects the run to name that invariant and that row.
// A fresh database for every test: damage that needs a dropped CHECK or a changed view cannot be rolled back (MariaDB DDL commits at once).

const made: string[] = [];
afterAll(async () => {
  for (const d of made) await dropDb(d);
});
let n = 0;
async function world() {
  const { db, c } = await migratedDb(`s10_${++n}`);
  made.push(db);
  const w = await cleanWorld(c);
  return { c, w, db };
}
const has = (rows: InvariantRow[], invariant: string, ref?: string) => rows.some((r) => r.invariant === invariant && (ref === undefined || r.row_ref.includes(ref)));

describe('runInvariants on consistent data', () => {
  it('returns nothing, and names the nine checks it ran (I1 to I7, I10, I13; I6 is the SQL half, I8, I9, I11, I12 are not queries)', async () => {
    const { c } = await world();
    const r = await runInvariants(c);
    expect(r.rows).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.ran).toEqual(['I1', 'I2', 'I3', 'I4', 'I5', 'I6', 'I7', 'I10', 'I13']);
    expect(Object.values(r.counts).every((x) => x === 0)).toBe(true);
    expect(listInvariantFiles().map((f) => f.id)).toEqual(r.ran);
    await c.end();
  });

  it('works on an empty database (only the walk-in exists)', async () => {
    const { db, c } = await migratedDb(`s10_${++n}`);
    made.push(db);
    expect((await runInvariants(c)).rows).toEqual([]);
    await c.end();
  });

  it('runs inside ONE consistent snapshot: a change committed by someone else while the run is going is not seen (REPEATABLE READ)', async () => {
    const { c, w, db } = await world();
    const other = await migratedDbConn(db);
    const r1 = await runInvariants(c, {
      between: async (id) => {
        if (id !== 'I1') return;
        // commit a second active bill that holds piece s1 (an I2 violation) after I1 ran and before I2 runs
        const b = (await insert(other, 'bills', V.bill(w.a.id, { bill_no: 'JV-2026-0777', import_batch_id: null, request_id: uuid() }))) as { id: string };
        await insert(other, 'bill_items', V.billItem(b.id, w.skus.s1.id, { line_no: 1 }));
      },
    });
    expect(has(r1.rows, 'I2')).toBe(false); // the snapshot was taken before the damage
    const r2 = await runInvariants(c);
    expect(has(r2.rows, 'I2', w.skus.s1.id)).toBe(true); // the next run sees it
    await other.end();
    await c.end();
  });
});

async function migratedDbConn(db: string) {
  const { appConn } = await import('../helpers');
  return appConn(db);
}

describe('mutation tests: one damaged thing, the right invariant names it', () => {
  it('I1: a Sold piece whose bill no longer holds it', async () => {
    const { c, w } = await world();
    await c.query("UPDATE skus SET status = 'In Stock', sold_bill_id = NULL WHERE id = ?", [w.skus.s1.id]);
    const r = await runInvariants(c);
    expect(has(r.rows, 'I1', w.skus.s1.id)).toBe(true);
    await c.end();
  });
  it('I1: a piece marked Sold on a CANCELLED bill', async () => {
    const { c, w } = await world();
    await c.query("UPDATE skus SET status = 'Sold', sold_bill_id = ? WHERE id = ?", [w.bills.aB2.id, w.skus.s3.id]);
    expect(has((await runInvariants(c)).rows, 'I1', w.skus.s3.id)).toBe(true);
    await c.end();
  });
  it('I2: one piece on the lines of two active bills', async () => {
    const { c, w } = await world();
    const batch = uuid();
    await insert(c, 'sys_import_batches', { id: batch, name: `b-${batch}` });
    const b = (await insert(c, 'bills', V.bill(w.d.id, { bill_no: 'IMP-1', import_batch_id: batch, request_id: null }))) as { id: string };
    await insert(c, 'bill_items', V.billItem(b.id, w.skus.s1.id, { line_no: 1 }));
    const r = await runInvariants(c);
    expect(has(r.rows, 'I2', w.skus.s1.id)).toBe(true);
    await c.end();
  });
  it('I3: an allocation larger than the bill and than its receipt; an unreleased allocation on a cancelled bill', async () => {
    const { c, w } = await world();
    await c.query("UPDATE receipt_allocations SET amount = '2000.00' WHERE id = ?", [w.allocations.a3.id]);
    const r = await runInvariants(c);
    expect(has(r.rows, 'I3', w.bills.aB1.id)).toBe(true); // the bill is over-allocated
    expect(has(r.rows, 'I3', w.receipts.ra2.id)).toBe(true); // and the receipt over-spent
    const w2 = await world();
    await insert(w2.c, 'receipt_allocations', V.allocation(w2.w.receipts.ra6.id, w2.w.bills.aB2.id, w2.w.a.id, { amount: '10.00' }));
    expect(has((await runInvariants(w2.c)).rows, 'I3', w2.w.bills.aB2.id)).toBe(true);
    await c.end();
    await w2.c.end();
  });
  it('I4: when V2 and V3 disagree with the base tables (a view that forgot the receipts)', async () => {
    const { c, w } = await world();
    await c.query(`CREATE OR REPLACE VIEW customer_ledger AS
      SELECT customer_id, bill_date AS entry_date, created_at AS entry_at, 1 AS kind_rank, id,
             SUM(grand_total) OVER (PARTITION BY customer_id ORDER BY bill_date, created_at, id) AS balance,
             SUM(fine_weight_due) OVER (PARTITION BY customer_id ORDER BY bill_date, created_at, id) AS fine_balance
      FROM bills`);
    const r = await runInvariants(c);
    expect(has(r.rows, 'I4', w.a.id)).toBe(true);
    await c.end();
  });
  it('I4: when V2 itself is wrong (a view that forgot refunds)', async () => {
    const { c, w } = await world();
    await c.query(`CREATE OR REPLACE VIEW customer_balances AS
      SELECT cu.id, cu.updated_at, COALESCE(b.billed, 0) - COALESCE(r.received, 0) AS balance, 0.000 AS fine_balance,
             0.00 AS outstanding, 0.00 AS advance, 0.000 AS fine_outstanding, 0.000 AS fine_advance
      FROM customers cu
      LEFT JOIN (SELECT customer_id, SUM(grand_total) billed FROM bills WHERE status = 'active' GROUP BY customer_id) b ON b.customer_id = cu.id
      LEFT JOIN (SELECT customer_id, SUM(amount) received FROM receipts WHERE status = 'active' AND kind = 'money' GROUP BY customer_id) r ON r.customer_id = cu.id`);
    expect(has((await runInvariants(c)).rows, 'I4', w.d.id)).toBe(true); // customer D has a refund
    await c.end();
  });
  it('I5: a gap in a bill-number series, and a counter that does not match', async () => {
    const { c, w } = await world();
    await c.query("UPDATE bills SET bill_no = 'JV-2026-0099' WHERE bill_no = 'JV-2026-0002'");
    expect(has((await runInvariants(c)).rows, 'I5', 'bill:JV:2026')).toBe(true);
    const w2 = await world();
    await w2.c.query("UPDATE sys_counters SET last_value = 9 WHERE series = 'opening'");
    expect(has((await runInvariants(w2.c)).rows, 'I5', 'opening')).toBe(true);
    void w;
    await c.end();
    await w2.c.end();
  });
  it('I5: an imported number is ignored (and the same number issued by a function is a gap); numbers at or below the seed are ignored too', async () => {
    const { c, w } = await world();
    const batch = uuid();
    await insert(c, 'sys_import_batches', { id: batch, name: `b-${batch}` });
    const imp = (await insert(c, 'bills', V.bill(w.d.id, { bill_no: 'JV-2026-0500', subtotal: '0.00', grand_total: '0.00', import_batch_id: batch, request_id: null }))) as { id: string };
    expect((await runInvariants(c)).rows).toEqual([]); // imported: left out
    await c.query('UPDATE bills SET import_batch_id = NULL WHERE id = ?', [imp.id]);
    expect(has((await runInvariants(c)).rows, 'I5', 'bill:JV:2026')).toBe(true); // same number, but a function issued it: now it is a gap
    await c.query("UPDATE sys_counters SET seed_value = 3, last_value = 500 WHERE series = 'bill:JV:2026'");
    expect(has((await runInvariants(c)).rows, 'I5', 'bill:JV:2026')).toBe(true); // above the seed 3 there are 4 and 500: a gap
    await c.query('UPDATE bills SET import_batch_id = ? WHERE id = ?', [batch, imp.id]);
    await c.query("UPDATE sys_counters SET seed_value = 3, last_value = 4 WHERE series = 'bill:JV:2026'");
    expect((await runInvariants(c)).rows).toEqual([]); // seedCounters(): 1 to 3 are at or below the seed and not checked; 4 follows the seed
    await c.end();
  });
  it('I5: a function-issued number that is not in either format is named', async () => {
    const { c, w } = await world();
    await c.query("UPDATE bills SET bill_no = 'ABC' WHERE id = ?", [w.bills.wB1.id]);
    expect(has((await runInvariants(c)).rows, 'I5', w.bills.wB1.id)).toBe(true);
    await c.end();
  });
  it('I6 (SQL half): a subtotal that is not the sum of the lines, a grand total that is not the rounded sum, a fine weight that is not the lines\'', async () => {
    const a = await world();
    await a.c.query("UPDATE bills SET subtotal = '999.00', grand_total = '999.00' WHERE id = ?", [a.w.bills.aB1.id]);
    expect(has((await runInvariants(a.c)).rows, 'I6', a.w.bills.aB1.id)).toBe(true);
    const b = await world();
    await b.c.query("UPDATE bills SET grand_total = '1001.00' WHERE id = ?", [b.w.bills.aB1.id]);
    expect(has((await runInvariants(b.c)).rows, 'I6', b.w.bills.aB1.id)).toBe(true);
    const d = await world();
    await d.c.query("UPDATE bills SET fine_weight_due = '1.000' WHERE id = ?", [d.w.bills.aB1.id]);
    expect(has((await runInvariants(d.c)).rows, 'I6', d.w.bills.aB1.id)).toBe(true);
    for (const x of [a, b, d]) await x.c.end();
  });
  it('I6: an opening bill has no lines and is left alone', async () => {
    const { c } = await world();
    expect((await runInvariants(c)).rows.filter((r) => r.invariant === 'I6')).toEqual([]);
    await c.end();
  });
  it('I7: a receipt in mode Credit (needs the CHECK dropped first, on this throw-away database)', async () => {
    const { c, w } = await world();
    await c.query('ALTER TABLE receipts DROP CONSTRAINT chk_receipts_kind');
    const r0 = (await insert(c, 'receipts', V.receipt(w.a.id, { mode: 'Credit', amount: '5.00' }))) as { id: string };
    expect(has((await runInvariants(c)).rows, 'I7', r0.id)).toBe(true);
    await c.end();
  });
  it('I7: a negative amount, and photo "text" inside a design row', async () => {
    const { c, w } = await world();
    await c.query('ALTER TABLE bills DROP CONSTRAINT chk_bills_amounts');
    await c.query("UPDATE bills SET discount = '-5.00' WHERE id = ?", [w.bills.dB1.id]);
    expect(has((await runInvariants(c)).rows, 'I7', w.bills.dB1.id)).toBe(true);
    const w2 = await world();
    await w2.c.query('ALTER TABLE designs DROP CONSTRAINT chk_designs_photos');
    await w2.c.query("UPDATE designs SET photo_ids = JSON_ARRAY('data:image/png;base64,AAAA') WHERE id = ?", [w2.w.design.id]);
    expect(has((await runInvariants(w2.c)).rows, 'I7', w2.w.design.id)).toBe(true);
    await c.end();
    await w2.c.end();
  });
  it('I10: advance beside pending dues; a walk-in advance; a refund bigger than the advance', async () => {
    const a = await world();
    await insert(a.c, 'receipts', V.receipt(a.w.a.id, { amount: '50.00' })); // unallocated money while a bill is pending
    expect(has((await runInvariants(a.c)).rows, 'I10', a.w.a.id)).toBe(true);
    const b = await world();
    await insert(b.c, 'receipts', V.receipt(b.w.walkin, { amount: '10.00' })); // the walk-in never holds an advance
    expect(has((await runInvariants(b.c)).rows, 'I10', b.w.walkin)).toBe(true);
    const d = await world();
    await insert(d.c, 'receipts', V.receipt(d.w.d.id, { kind: 'refund', amount: '500.00' })); // advance would be negative
    expect(has((await runInvariants(d.c)).rows, 'I10', d.w.d.id)).toBe(true);
    for (const x of [a, b, d]) await x.c.end();
  });
  it('I13: when V4 is wrong (a view that counts opening advances and ignores voids), the cash book no longer ties to the receipts', async () => {
    const { c } = await world();
    await c.query(`CREATE OR REPLACE VIEW daily_totals AS
      SELECT paid_on AS business_date, mode,
             SUM(CASE WHEN kind IN ('money', 'fine_cash') THEN amount ELSE 0 END) AS money_in,
             SUM(CASE WHEN kind = 'refund' THEN amount ELSE 0 END) AS money_out,
             SUM(CASE WHEN kind IN ('money', 'fine_cash') THEN amount ELSE -amount END) AS net
      FROM receipts WHERE status = 'active' GROUP BY paid_on, mode`);
    const r = await runInvariants(c);
    expect(has(r.rows, 'I13', 'Other')).toBe(true); // the opening advance of 100 is counted
    await c.end();
  });
  it('counts are per invariant and rows are limited to the sample size', async () => {
    const { c, w } = await world();
    for (let i = 0; i < 5; i++) await insert(c, 'receipts', V.receipt(w.a.id, { amount: '1.00' }));
    const r = await runInvariants(c, { sample: 2 });
    expect(r.counts.I10).toBeGreaterThanOrEqual(1);
    expect(r.rows.filter((x) => x.invariant === 'I10').length).toBeLessThanOrEqual(2);
    await c.end();
  });
});

describe('the invariant files themselves', () => {
  it('I7 lists every DECIMAL column of every business table (except bills.round_off) as table.column < 0', async () => {
    const { c } = await world();
    const [cols] = await c.query<any[]>(
      `SELECT TABLE_NAME t, COLUMN_NAME n FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND DATA_TYPE = 'decimal'
         AND TABLE_NAME IN (SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE')`
    );
    const sql = listInvariantFiles().find((f) => f.id === 'I7')!.sql;
    const missing = cols.filter((x) => !(x.t === 'bills' && x.n === 'round_off')).filter((x) => !sql.includes(`${x.t}.${x.n} < 0`));
    expect(missing.map((x) => `${x.t}.${x.n}`)).toEqual([]);
    expect(sql).not.toMatch(/round_off\s*</);
    await c.end();
  });
  it('every file is one SELECT that returns (invariant, row_ref, detail), starts with a comment naming its rule, and writes nothing', () => {
    for (const f of listInvariantFiles()) {
      expect(f.sql, f.name).toMatch(new RegExp(`^-- ${f.id} \\(spec 12\\)`));
      expect(f.sql, f.name).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|REPLACE)\b\s+(INTO|TABLE|FROM|VIEW|\w+\s+SET)/i);
      expect(f.sql.trim().endsWith(';'), f.name).toBe(false);
    }
  });
  it('leaves the caller\'s isolation level alone (the REPEATABLE READ is for the one snapshot transaction only)', async () => {
    const { c } = await world();
    const level = async () => String((((await c.query<any[]>('SELECT @@session.tx_isolation AS l'))[0]) as any[])[0].l);
    const before = await level();
    await runInvariants(c);
    expect(await level()).toBe(before);
    expect(before).toBe('READ-COMMITTED');
    await c.end();
  });
  it('a failing query rolls the snapshot back and rethrows (the connection is usable afterwards)', async () => {
    const { c } = await world();
    await expect(runInvariants(c, { between: async () => { throw new Error('boom'); } })).rejects.toThrow('boom');
    const [r] = await c.query<any[]>('SELECT 1 AS x');
    expect(r[0].x).toBe(1);
    expect((await runInvariants(c)).ok).toBe(true);
    await c.end();
  });
});

describe('type of the helper', () => {
  it('Connection type is used', () => {
    const f = (x: Connection | null) => x;
    expect(f(null)).toBeNull();
  });
});
