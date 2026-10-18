import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listInvariantFiles, runInvariants as scriptRun } from '../../scripts/invariants.mjs';
import { loadQueries } from '../../scripts/queries.mjs';
import { priceBill } from '../../src/domain/pricing';
import { INVARIANT_FILES, V1_TEXT, V2_TEXT } from '../../src/domain/invariantSql';
import { checkLinePricing, runInvariants as twinRun } from '../../src/domain/invariants';
import { runNightlyCheck } from '../../src/jobs/nightly';
import { PRICING_VERSIONS, type PricingFunction } from '../../src/money/x07QuoteBill';
import { V, insert, uuid } from '../schema/support';
import { type NightlyWorld, nightlyWorld } from './nightly-support';

// T-B18 (API32, spec 12 I1 to I7, I10, I13, I8, I9, D17): the safety net itself, run through the job of the API. For each of I1 to I7 and I10 one damaged row makes the nightly check name that invariant and
// that row, for I13 an injected old version of the V4 query does, and with no damage the result is empty; the job writes a check_runs row with ok = 0 and the details. The mutation tests of MB02
// (tests/schema/s10-invariants.test.ts) ask the database half's runInvariants(); these ask src/jobs/nightly.ts, which runs the TypeScript twin of it and the Node half of I6 in the same snapshot.
// The books are the consistent set of MB02 (cleanWorld), whose lines price to the amounts typed in (priceTheLines), plus one bill of the kinds that need the Node half most: a Wholesale Silver line with
// fine due and a Per Piece line of three pieces.

let nw: NightlyWorld;
let zoo: { bill: string; silverLine: string; pieceLine: string; customer: string };

/** A bill of two lines for a Wholesale customer, typed in as MB02 does: a Silver By Weight line (fine due, no metal amount) and a Per Piece Gold line (3 pieces; its labour rate is not used). */
async function addZoo(w: NightlyWorld) {
  const batch = uuid();
  await insert(w.sql, 'sys_import_batches', { id: batch, name: `zoo-${batch}` }); // an imported bill is left out of I5, so the counters need no care
  const customer = (await insert(w.sql, 'customers', V.customer({ name: 'Wholesale Customer', mobile: '9000000001', customer_type: 'Wholesale' }))) as { id: string };
  const bill = (await insert(
    w.sql,
    'bills',
    V.bill(customer.id, {
      bill_no: 'IMP-ZOO-1',
      sale_type: 'Wholesale',
      bill_date: '2026-10-08',
      subtotal: '3139.65',
      grand_total: '3140.00',
      round_off: '0.35',
      fine_weight_due: '25.500',
      import_batch_id: batch,
      request_id: null,
    }),
  )) as { id: string };
  const s1 = (await insert(w.sql, 'skus', V.sku(w.books.design.id, { status: 'Sold', sold_bill_id: bill.id }))) as { id: string };
  const s2 = (await insert(w.sql, 'skus', V.sku(w.books.design.id, { status: 'Sold', sold_bill_id: bill.id }))) as { id: string };
  const silver = (await insert(
    w.sql,
    'bill_items',
    V.billItem(bill.id, s1.id, {
      line_no: 1,
      material: 'Silver',
      purity: '999',
      customer_net_weight: '25.500',
      gross_weight: '26.000',
      metal_rate: '90.00',
      labour_rate: '5.00',
      labour_amount: '127.50',
      piroi: '2.15',
      metal_amount: '0.00',
      fine_weight_due: '25.500',
      item_total: '129.65',
      list_metal_rate: '90.00',
      list_labour_rate: '5.00',
    }),
  )) as { id: string };
  const piece = (await insert(
    w.sql,
    'bill_items',
    V.billItem(bill.id, s2.id, {
      line_no: 2,
      material: 'Gold',
      purity: '24K',
      selling_method: 'Per Piece',
      customer_net_weight: '2.000',
      gross_weight: '2.100',
      quantity: 3,
      metal_rate: '1000.00',
      labour_rate: '0.00',
      labour_amount: '0.00',
      other_charges: '10.00',
      metal_amount: '3000.00',
      fine_weight_due: '0.000',
      item_total: '3010.00',
      list_metal_rate: '1000.00',
      list_labour_rate: null,
    }),
  )) as { id: string };
  return { bill: bill.id, silverLine: silver.id, pieceLine: piece.id, customer: customer.id };
}

beforeAll(async () => {
  nw = await nightlyWorld('nightinv');
  zoo = await addZoo(nw);
}, 180_000);
afterAll(async () => {
  await nw?.close();
}, 60_000);

type Run = Awaited<ReturnType<NightlyWorld['run']>>;
const has = (r: Run, invariant: string, ref?: string) => r.rows.some((x) => x.invariant === invariant && (ref === undefined || x.row_ref.includes(ref)));

/** The books are clean, one thing is damaged and the check is run, the damage is undone and the books are clean again (the same world serves the next test). */
async function damaged(damage: string[], undo: string[], check: (r: Run) => void | Promise<void>) {
  const before = await nw.run();
  expect(before.rows, 'the books were not clean before the damage').toEqual([]);
  for (const s of damage) await nw.sql.query(s);
  try {
    await check(await nw.run());
  } finally {
    for (const s of undo) await nw.sql.query(s);
  }
  const after = await nw.run();
  expect(after.rows, 'the books were not clean after the damage was undone').toEqual([]);
}

/** Adds (or, with a minus, takes away) paise on a line's metal amount and its total, and on its bill's subtotal; the grand total stays the rounded sum and the round-off keeps agreeing with it. */
const bump = (line: string, bill: string, sign: '+' | '-') => [
  `UPDATE bill_items SET metal_amount = metal_amount ${sign} 0.01, item_total = item_total ${sign} 0.01 WHERE id = '${line}'`,
  `UPDATE bills SET subtotal = subtotal ${sign} 0.01, round_off = grand_total - (subtotal - discount + additional_charges) WHERE id = '${bill}'`,
];

// ------------------------------------------------------------------ the check itself

describe('T-B18 the nightly check on consistent books: nothing is named, the nine checks ran, a check_runs row says ok', () => {
  it('returns no rows, ran I1 to I7, I10 and I13, and writes one check_runs row with ok = 1 and the counts', async () => {
    const before = (await nw.checkRuns()).length;
    const r = await nw.run();
    expect(r.rows).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.ran).toEqual(['I1', 'I2', 'I3', 'I4', 'I5', 'I6', 'I7', 'I10', 'I13']);
    expect(Object.values(r.counts).every((n) => n === 0)).toBe(true);
    const runs = await nw.checkRuns();
    expect(runs).toHaveLength(before + 1);
    const last = runs[runs.length - 1];
    expect(last.id).toBe(r.checkRunId);
    expect(last.ok).toBe(1);
    expect(last.details.counts).toEqual(r.counts);
    expect(last.details.samples).toEqual({});
    expect(last.details.ran).toEqual(r.ran);
    expect(last.details.date).toBe(r.date);
  });

  it('runs on an empty database (only the walk-in exists) and writes ok = 1', async () => {
    const empty = await nightlyWorld('nightempty');
    try {
      await empty.root('DELETE FROM bill_items');
      await empty.root("UPDATE skus SET status = 'In Stock', sold_bill_id = NULL");
      await empty.root('DELETE FROM receipt_allocations');
      await empty.root('DELETE FROM receipts');
      await empty.root('DELETE FROM bills');
      await empty.root('DELETE FROM skus');
      await empty.root('DELETE FROM sys_counters');
      await empty.root("DELETE FROM customers WHERE is_walkin = 0");
      const r = await empty.run();
      expect(r.rows).toEqual([]);
      expect(r.ok).toBe(true);
    } finally {
      await empty.close();
    }
  }, 120_000);
});

// ------------------------------------------------------------------ the mutation tests: one damaged row, the right invariant and row

describe('T-B18 mutation tests through the job: one damaged row makes the check name that invariant and row (I1 to I7, I10, I13)', () => {
  it('I1: a Sold piece whose bill no longer holds it', async () => {
    const { s1 } = nw.books.skus;
    await damaged(
      [`UPDATE skus SET status = 'In Stock', sold_bill_id = NULL WHERE id = '${s1.id}'`],
      [`UPDATE skus SET status = 'Sold', sold_bill_id = '${nw.books.bills.aB1.id}' WHERE id = '${s1.id}'`],
      (r) => {
        expect(r.ok).toBe(false);
        expect(has(r, 'I1', s1.id)).toBe(true);
      },
    );
  });

  it('I1: a piece marked Sold on a cancelled bill', async () => {
    const { s3 } = nw.books.skus;
    await damaged(
      [`UPDATE skus SET status = 'Sold', sold_bill_id = '${nw.books.bills.aB2.id}' WHERE id = '${s3.id}'`],
      [`UPDATE skus SET status = 'In Stock', sold_bill_id = NULL WHERE id = '${s3.id}'`],
      (r) => expect(has(r, 'I1', s3.id)).toBe(true),
    );
  });

  it('I2: one piece on the lines of two active bills', async () => {
    const batch = uuid();
    await insert(nw.sql, 'sys_import_batches', { id: batch, name: `i2-${batch}` });
    const b = (await insert(nw.sql, 'bills', V.bill(nw.books.d.id, { bill_no: 'IMP-I2', subtotal: '1210.00', grand_total: '1210.00', import_batch_id: batch, request_id: null }))) as { id: string };
    const line = (await insert(nw.sql, 'bill_items', V.billItem(b.id, nw.books.skus.s1.id, { line_no: 1 }))) as { id: string };
    try {
      const r = await nw.run();
      expect(has(r, 'I2', nw.books.skus.s1.id)).toBe(true);
    } finally {
      await nw.root(`DELETE FROM bill_items WHERE id = '${line.id}'`);
      await nw.root(`DELETE FROM bills WHERE id = '${b.id}'`);
      await nw.root(`DELETE FROM sys_import_batches WHERE id = '${batch}'`);
    }
    expect((await nw.run()).rows).toEqual([]);
  });

  it('I3: an allocation larger than its bill and its receipt', async () => {
    const { a3 } = nw.books.allocations;
    await damaged([`UPDATE receipt_allocations SET amount = '2000.00' WHERE id = '${a3.id}'`], [`UPDATE receipt_allocations SET amount = '200.00' WHERE id = '${a3.id}'`], (r) => {
      expect(has(r, 'I3', nw.books.bills.aB1.id)).toBe(true); // the bill is over-allocated
      expect(has(r, 'I3', nw.books.receipts.ra2.id)).toBe(true); // and the receipt over-spent
    });
  });

  it('I3: an allocation that is not released but points to a cancelled bill', async () => {
    const extra = (await insert(nw.sql, 'receipt_allocations', V.allocation(nw.books.receipts.ra6.id, nw.books.bills.aB2.id, nw.books.a.id, { amount: '10.00' }))) as { id: string };
    try {
      expect(has(await nw.run(), 'I3', nw.books.bills.aB2.id)).toBe(true);
    } finally {
      await nw.root(`DELETE FROM receipt_allocations WHERE id = '${extra.id}'`);
    }
    expect((await nw.run()).rows).toEqual([]);
  });

  it('I4: V3 disagrees with V2 and the base tables (an old ledger query that forgot the receipts), injected as the query; the database is not changed', async () => {
    const wrongV3 = `SELECT customer_id, bill_date AS entry_date, created_at AS entry_at, 1 AS kind_rank, id,
             SUM(grand_total) OVER (PARTITION BY customer_id ORDER BY bill_date, created_at, id) AS balance,
             SUM(fine_weight_due) OVER (PARTITION BY customer_id ORDER BY bill_date, created_at, id) AS fine_balance
      FROM bills`;
    const r = await nw.run({ queries: { V3: wrongV3 } });
    expect(has(r, 'I4', nw.books.a.id)).toBe(true);
    expect(r.ok).toBe(false);
    expect((await nw.run()).rows).toEqual([]);
  });

  it('I4: V2 itself is wrong (an old query that forgot refunds)', async () => {
    const wrongV2 = `SELECT cu.id, cu.updated_at, COALESCE(b.billed, 0) - COALESCE(r.received, 0) AS balance, 0.000 AS fine_balance,
             0.00 AS outstanding, 0.00 AS advance, 0.000 AS fine_outstanding, 0.000 AS fine_advance
      FROM customers cu
      LEFT JOIN (SELECT customer_id, SUM(grand_total) billed FROM bills WHERE status = 'active' GROUP BY customer_id) b ON b.customer_id = cu.id
      LEFT JOIN (SELECT customer_id, SUM(amount) received FROM receipts WHERE status = 'active' AND kind = 'money' GROUP BY customer_id) r ON r.customer_id = cu.id`;
    expect(has(await nw.run({ queries: { V2: wrongV2 } }), 'I4', nw.books.d.id)).toBe(true); // customer D has a refund
  });

  it('I5: a gap in a bill-number series, and a counter that does not match', async () => {
    await damaged(
      ["UPDATE bills SET bill_no = 'JV-2026-0099' WHERE bill_no = 'JV-2026-0002'"],
      ["UPDATE bills SET bill_no = 'JV-2026-0002' WHERE bill_no = 'JV-2026-0099'"],
      (r) => expect(has(r, 'I5', 'bill:JV:2026')).toBe(true),
    );
    await damaged(
      ["UPDATE sys_counters SET last_value = 9 WHERE series = 'opening'"],
      ["UPDATE sys_counters SET last_value = 1 WHERE series = 'opening'"],
      (r) => expect(has(r, 'I5', 'opening')).toBe(true),
    );
  });

  it('I6 (the SQL half): a subtotal that is not the sum of the lines, a grand total that is not the rounded sum, a fine weight that is not the lines\'', async () => {
    const { aB1 } = nw.books.bills;
    await damaged(
      [`UPDATE bills SET subtotal = '999.00', grand_total = '999.00' WHERE id = '${aB1.id}'`],
      [`UPDATE bills SET subtotal = '1000.00', grand_total = '1000.00' WHERE id = '${aB1.id}'`],
      (r) => expect(has(r, 'I6', aB1.id)).toBe(true),
    );
    await damaged([`UPDATE bills SET grand_total = '1001.00' WHERE id = '${aB1.id}'`], [`UPDATE bills SET grand_total = '1000.00' WHERE id = '${aB1.id}'`], (r) => expect(has(r, 'I6', aB1.id)).toBe(true));
    await damaged([`UPDATE bills SET fine_weight_due = '1.000' WHERE id = '${aB1.id}'`], [`UPDATE bills SET fine_weight_due = '0.000' WHERE id = '${aB1.id}'`], (r) => expect(has(r, 'I6', aB1.id)).toBe(true));
  });

  it('I6 (the Node half): a line changed by ONE paisa, with its bill\'s subtotal changed to match, is named by the line; the SQL half alone sees nothing', async () => {
    const { aB1 } = nw.books.bills;
    const [lines] = await nw.sql.query<any[]>('SELECT id FROM bill_items WHERE bill_id = ? ORDER BY line_no', [aB1.id]);
    const line = lines[0].id as string;
    await damaged(bump(line, aB1.id, '+'), bump(line, aB1.id, '-'), async (r) => {
      expect(r.ok).toBe(false);
      expect(has(r, 'I6', line)).toBe(true);
      const row = r.rows.find((x) => x.invariant === 'I6' && x.row_ref.includes(line))!;
      expect(row.row_ref).toBe(`bill_items:${line}`);
      expect(row.detail).toMatch(/metal_amount 500\.01 but a fresh run of version 1 gives 500\.00/);
      expect(row.detail).toMatch(/item_total 600\.01 but a fresh run of version 1 gives 600\.00/);
      // the SQL half of MB02 does not see it: the subtotal is the sum of the (damaged) lines and the grand total is still the rounded sum
      const conn = await nw.w.world.app.db!.checkout();
      try {
        expect((await scriptRun(conn)).rows.filter((x) => x.invariant === 'I6')).toEqual([]);
      } finally {
        conn.release();
      }
    });
  });

  it('I6 (the Node half) on the line kinds that need it: a fine weight due, a Per Piece total of three pieces, a labour amount on a Per Piece line', async () => {
    const batch = [
      // the Silver line: its fine due (and its bill's, so that the SQL half agrees) is a gram short
      {
        damage: [`UPDATE bill_items SET fine_weight_due = '25.000' WHERE id = '${zoo.silverLine}'`, `UPDATE bills SET fine_weight_due = '25.000' WHERE id = '${zoo.bill}'`],
        undo: [`UPDATE bill_items SET fine_weight_due = '25.500' WHERE id = '${zoo.silverLine}'`, `UPDATE bills SET fine_weight_due = '25.500' WHERE id = '${zoo.bill}'`],
        line: zoo.silverLine,
        text: /fine_weight_due 25\.000/,
      },
      // the Per Piece line: 3 x 1000.00 is 3000.00
      { damage: bump(zoo.pieceLine, zoo.bill, '+'), undo: bump(zoo.pieceLine, zoo.bill, '-'), line: zoo.pieceLine, text: /metal_amount 3000\.01/ },
      // the Per Piece line: a labour amount where the pricing rule says 0.00 (R3)
      {
        damage: [`UPDATE bill_items SET labour_amount = '0.01', item_total = '3010.01' WHERE id = '${zoo.pieceLine}'`, `UPDATE bills SET subtotal = '3139.66', round_off = '0.34' WHERE id = '${zoo.bill}'`],
        undo: [`UPDATE bill_items SET labour_amount = '0.00', item_total = '3010.00' WHERE id = '${zoo.pieceLine}'`, `UPDATE bills SET subtotal = '3139.65', round_off = '0.35' WHERE id = '${zoo.bill}'`],
        line: zoo.pieceLine,
        text: /labour_amount 0\.01/,
      },
    ];
    for (const c of batch) {
      await damaged(c.damage, c.undo, (r) => {
        const row = r.rows.find((x) => x.invariant === 'I6' && x.row_ref === `bill_items:${c.line}`);
        expect(row, JSON.stringify(r.rows)).toBeDefined();
        expect(row!.detail).toMatch(c.text);
      });
    }
  });

  it('I6 (the Node half) reads the lines in pages of the line id: lines on the first, a middle and the last page are all named, none twice, whatever the page size', async () => {
    const [all] = await nw.sql.query<any[]>('SELECT id FROM bill_items ORDER BY id');
    expect(all.length).toBeGreaterThanOrEqual(7);
    const picked = [0, 3, all.length - 1].map((i) => all[i].id as string); // with a page of 2 these are on three different pages
    const touch = (sign: '+' | '-') => picked.map((id) => `UPDATE bill_items SET metal_amount = metal_amount ${sign} 0.01, item_total = item_total ${sign} 0.01 WHERE id = '${id}'`);
    for (const s of touch('+')) await nw.sql.query(s);
    const conn = await nw.w.world.app.db!.checkout();
    try {
      for (const page of [1, 2, 3, 2000]) {
        const r = await checkLinePricing(conn, { page });
        expect(r.count, `page ${page}`).toBe(3);
        expect(r.rows.map((x) => x.row_ref).sort(), `page ${page}`).toEqual(picked.map((id) => `bill_items:${id}`).sort());
      }
      const capped = await checkLinePricing(conn, { sample: 2 });
      expect(capped.count).toBe(3); // the count is of everything, the rows are the sample
      expect(capped.rows).toHaveLength(2);
    } finally {
      conn.release();
      for (const s of touch('-')) await nw.sql.query(s);
    }
    expect((await nw.run()).rows).toEqual([]);
  });

  it('I6: a line the pricing rule cannot price (a By Weight line of 2 pieces) is named, not thrown; so is a total that is not the sum of its parts (both CHECKs dropped on a world of its own)', async () => {
    const own = await nightlyWorld('nightpr');
    try {
      await own.root('ALTER TABLE bill_items DROP CONSTRAINT chk_bill_items_by_weight');
      await own.root('ALTER TABLE bill_items DROP CONSTRAINT chk_bill_items_total');
      const [lines] = await own.sql.query<any[]>('SELECT id FROM bill_items WHERE bill_id = ? ORDER BY line_no', [own.books.bills.aB1.id]);
      await own.sql.query('UPDATE bill_items SET quantity = 2 WHERE id = ?', [lines[0].id]);
      const r = await own.run();
      const refused = r.rows.find((x) => x.invariant === 'I6' && x.row_ref === `bill_items:${lines[0].id}`);
      expect(refused, JSON.stringify(r.rows)).toBeDefined();
      expect(refused!.detail).toMatch(/refuses the stored snapshot/);
      // the total alone is a paisa off (the bill's subtotal follows it, so the SQL half is silent)
      await own.sql.query('UPDATE bill_items SET quantity = 1 WHERE id = ?', [lines[0].id]);
      await own.sql.query("UPDATE bill_items SET item_total = '400.01' WHERE id = ?", [lines[1].id]);
      await own.sql.query("UPDATE bills SET subtotal = '1000.01', round_off = '-0.01' WHERE id = ?", [own.books.bills.aB1.id]);
      const t = await own.run();
      const row = t.rows.find((x) => x.invariant === 'I6' && x.row_ref === `bill_items:${lines[1].id}`);
      expect(row, JSON.stringify(t.rows)).toBeDefined();
      expect(row!.detail).toMatch(/^line 2 of bill JV-2026-0001: item_total 400\.01 but a fresh run of version 1 gives 400\.00$/);
      expect(t.rows.filter((x) => x.invariant === 'I6')).toHaveLength(1);
    } finally {
      await own.close();
    }
  }, 120_000);

  it('I7: a receipt in mode Credit and a negative discount (the CHECKs dropped on a world of its own: MariaDB DDL cannot be rolled back)', async () => {
    const own = await nightlyWorld('nighti7');
    try {
      await own.root('ALTER TABLE receipts DROP CONSTRAINT chk_receipts_kind');
      const credit = (await insert(own.sql, 'receipts', V.receipt(own.books.a.id, { mode: 'Credit', amount: '5.00' }))) as { id: string };
      expect(has(await own.run(), 'I7', credit.id)).toBe(true);
      await own.root('ALTER TABLE bills DROP CONSTRAINT chk_bills_amounts');
      await own.sql.query("UPDATE bills SET discount = '-5.00' WHERE id = ?", [own.books.bills.dB1.id]);
      const r = await own.run();
      expect(has(r, 'I7', own.books.bills.dB1.id)).toBe(true);
      expect(r.ok).toBe(false);
    } finally {
      await own.close();
    }
  }, 120_000);

  it('I10: money that no bill has taken while a bill is pending; a walk-in advance', async () => {
    const stray = (await insert(nw.sql, 'receipts', V.receipt(nw.books.a.id, { amount: '50.00' }))) as { id: string };
    try {
      expect(has(await nw.run(), 'I10', nw.books.a.id)).toBe(true);
    } finally {
      await nw.root(`DELETE FROM receipts WHERE id = '${stray.id}'`);
    }
    const walkin = (await insert(nw.sql, 'receipts', V.receipt(nw.books.walkin, { amount: '10.00' }))) as { id: string };
    try {
      expect(has(await nw.run(), 'I10', nw.books.walkin)).toBe(true);
    } finally {
      await nw.root(`DELETE FROM receipts WHERE id = '${walkin.id}'`);
    }
    expect((await nw.run()).rows).toEqual([]);
  });

  it('I13: V4 is an old query that counts opening advances and ignores voids, injected as the query; the cash book no longer ties to the receipts', async () => {
    const wrongV4 = `SELECT paid_on AS business_date, mode,
             SUM(CASE WHEN kind IN ('money', 'fine_cash') THEN amount ELSE 0 END) AS money_in,
             SUM(CASE WHEN kind = 'refund' THEN amount ELSE 0 END) AS money_out,
             SUM(CASE WHEN kind IN ('money', 'fine_cash') THEN amount ELSE -amount END) AS net
      FROM receipts WHERE status = 'active' GROUP BY paid_on, mode`;
    const r = await nw.run({ queries: { V4: wrongV4 } });
    expect(has(r, 'I13', 'Other')).toBe(true); // the opening advance of 100 is counted
    expect(r.ok).toBe(false);
    expect((await nw.run()).rows).toEqual([]);
  });
});

// ------------------------------------------------------------------ check_runs

describe('T-B18 the job writes a check_runs row with ok = 0 and the details: the count per invariant and at most 20 sample rows each', () => {
  it('a damaged world: ok = 0, the counts, the named rows, and no more than 20 sample rows of an invariant although more are broken', async () => {
    // 23 customers each get a refund of money they never paid: the advance would be negative (I10)
    const made: string[] = [];
    for (let i = 0; i < 23; i++) {
      const c = (await insert(nw.sql, 'customers', V.customer({ name: `Stray ${i}`, mobile: `95000${String(10000 + i)}` }))) as { id: string };
      made.push(((await insert(nw.sql, 'receipts', V.receipt(c.id, { kind: 'refund', amount: '2.00' }))) as { id: string }).id);
    }
    try {
      const before = (await nw.checkRuns()).length;
      const r = await nw.run();
      expect(r.ok).toBe(false);
      expect(r.counts.I10).toBe(23);
      expect(r.rows.filter((x) => x.invariant === 'I10')).toHaveLength(20);
      const runs = await nw.checkRuns();
      expect(runs).toHaveLength(before + 1);
      const last = runs[runs.length - 1];
      expect(last.ok).toBe(0);
      expect(last.details.counts.I10).toBe(23);
      expect(last.details.samples.I10).toHaveLength(20);
      expect(Object.keys(last.details.samples)).toEqual(['I10']);
      expect(last.details.samples.I10[0]).toEqual({ row_ref: expect.stringMatching(/^customers:/), detail: expect.any(String) });
      expect(last.details.review.date).toBe(r.reviewDate);
    } finally {
      await nw.root(`DELETE FROM receipts WHERE id IN (${made.map((i) => `'${i}'`).join(', ')})`);
      await nw.root("DELETE FROM customers WHERE name LIKE 'Stray %'");
    }
    expect((await nw.run()).rows).toEqual([]);
  }, 120_000);

  it('the sample size is a parameter, and the I6 rows of the SQL half and of the Node half share it', async () => {
    const { aB1 } = nw.books.bills;
    const [lines] = await nw.sql.query<any[]>('SELECT id FROM bill_items WHERE bill_id = ? ORDER BY line_no', [aB1.id]);
    // two lines change by a paisa each (Node half), and the subtotal is also wrong (SQL half): three I6 rows, sample size 2
    for (const l of lines) for (const s of bump(l.id, aB1.id, '+')) await nw.sql.query(s);
    await nw.sql.query(`UPDATE bills SET subtotal = '1500.00' WHERE id = '${aB1.id}'`);
    try {
      const r = await nw.run({ sample: 2 });
      expect(r.counts.I6).toBe(3);
      expect(r.rows.filter((x) => x.invariant === 'I6')).toHaveLength(2);
    } finally {
      await nw.sql.query(`UPDATE bills SET subtotal = '1000.02' WHERE id = '${aB1.id}'`);
      for (const l of lines) for (const s of bump(l.id, aB1.id, '-')) await nw.sql.query(s);
      await nw.sql.query(`UPDATE bills SET subtotal = '1000.00', round_off = '0.00' WHERE id = '${aB1.id}'`);
    }
    expect((await nw.run()).rows).toEqual([]);
  });
});

// ------------------------------------------------------------------ one snapshot, session settings

describe('T-B18 the whole check (the SQL half, the Node half of I6 and the review line) reads ONE snapshot, and the connection is left as it was found', () => {
  it('a change committed by another connection after the last invariant query is not seen by the Node half; the next run sees it', async () => {
    const { aB1 } = nw.books.bills;
    const [lines] = await nw.sql.query<any[]>('SELECT id FROM bill_items WHERE bill_id = ? ORDER BY line_no', [aB1.id]);
    const line = lines[0].id as string;
    const other = await nw.w.world.scratch.connect();
    const refund = uuid();
    try {
      const during = await nw.run({
        between: async (id) => {
          if (id !== 'I13') return;
          for (const s of bump(line, aB1.id, '+')) await other.query(s); // committed (autocommit) while the snapshot is open
          // and a refund on the day under review (the 16th, the clock says the 17th): the review line reads the same snapshot, so it does not see it either
          await insert(other, 'receipts', V.receipt(nw.books.d.id, { id: refund, kind: 'refund', mode: 'Cash', amount: '1.00', paid_on: '2026-10-16' }));
        },
      });
      expect(during.rows, 'a change committed during the run was seen').toEqual([]);
      expect(during.review.counts.refunds, 'the review line read a later moment than the invariants').toBe(0);
      const next = await nw.run();
      expect(has(next, 'I6', line)).toBe(true);
      expect(next.review.counts.refunds).toBe(1);
    } finally {
      for (const s of bump(line, aB1.id, '-')) await other.query(s);
      await nw.root(`DELETE FROM receipts WHERE id = '${refund}'`);
      await other.end();
    }
    expect((await nw.run()).rows).toEqual([]);
  });

  it('the statement limit is 20 seconds during the run (the tick\'s), and the session\'s isolation level, statement limit, optimizer switch and autocommit are as they were afterwards, also after a failure', async () => {
    const conn = await nw.w.world.app.db!.checkout();
    await conn.query("SET SESSION optimizer_switch = 'split_materialized=on'"); // a pooled connection that an earlier run left switched off would make this test blind
    const settings = async () =>
      ((await conn.query<any[]>('SELECT @@session.tx_isolation AS iso, @@session.max_statement_time AS mst, @@session.optimizer_switch AS sw, @@session.autocommit AS ac'))[0] as any[])[0];
    try {
      const before = await settings();
      expect(String(before.iso)).toBe('READ-COMMITTED');
      const seen: string[] = [];
      const switches: string[] = [];
      await runNightlyCheck(conn, {
        clock: nw.w.world.app.clock,
        between: async () => {
          seen.push(String(((await conn.query<any[]>('SELECT @@session.max_statement_time AS m'))[0] as any[])[0].m));
          switches.push(String(((await conn.query<any[]>('SELECT @@session.optimizer_switch AS s'))[0] as any[])[0].s));
        },
      });
      expect(seen.length).toBeGreaterThan(5);
      for (const m of seen) expect(Number(m)).toBe(20);
      // MB02: split_materialized is off while the files run (it made I10 take minutes after a bulk load) and is back afterwards
      for (const s of switches) expect(s).toContain('split_materialized=off');
      expect(String(((await conn.query<any[]>('SELECT @@session.optimizer_switch AS s'))[0] as any[])[0].s)).toContain('split_materialized=on');
      expect(await settings()).toEqual(before);
      await expect(
        runNightlyCheck(conn, {
          clock: nw.w.world.app.clock,
          between: async () => {
            throw new Error('boom');
          },
        }),
      ).rejects.toThrow('boom');
      expect(await settings()).toEqual(before);
      expect((await conn.query<any[]>('SELECT 1 AS x'))[0]).toEqual([{ x: 1 }]); // the connection is usable, no transaction is left open
    } finally {
      conn.release();
    }
  });

  it('a run that fails writes no check_runs row (the tick marks the phase failed; a row would claim a verdict nobody reached)', async () => {
    const before = (await nw.checkRuns()).length;
    await expect(
      nw.run({
        between: async () => {
          throw new Error('boom');
        },
      }),
    ).rejects.toThrow('boom');
    expect(await nw.checkRuns()).toHaveLength(before);
  });
});

// ------------------------------------------------------------------ R13: the version of the bill

describe('T-B18 (T-A15 clause, R13) a bill is re-priced with the pricing function of ITS pricing_version, the version table is a parameter', () => {
  /** a test-only version 2: the same rules plus one paisa of labour on every By Weight line */
  const v2: PricingFunction = (input) => {
    const b = priceBill(input);
    return { ...b, pricingVersion: 2, lines: b.lines.map((l) => ({ ...l, labourAmountPaise: l.labourAmountPaise + 1, itemTotalPaise: l.itemTotalPaise + 1 })) };
  };

  it('a version 2 bill passes with a table that has version 2, version 1 bills still pass beside it, and the same bill is named when the table does not know version 2', async () => {
    const { aB1 } = nw.books.bills;
    const [lines] = await nw.sql.query<any[]>('SELECT id FROM bill_items WHERE bill_id = ? ORDER BY line_no', [aB1.id]);
    // the lines of the bill as MB02 typed them (labour 100.00, totals 600.00 and 400.00), and as a version 2 that adds a paisa of labour to every line prices them
    const lineSql = (labour: string, totals: [string, string]) => lines.map((l: { id: string }, i: number) => `UPDATE bill_items SET labour_amount = '${labour}', item_total = '${totals[i]}' WHERE id = '${l.id}'`);
    const version2 = [`UPDATE bills SET pricing_version = 2, subtotal = '1000.02', round_off = '-0.02' WHERE id = '${aB1.id}'`, ...lineSql('100.01', ['600.01', '400.01'])];
    const version1 = [`UPDATE bills SET pricing_version = 1, subtotal = '1000.00', round_off = '0.00' WHERE id = '${aB1.id}'`, ...lineSql('100.00', ['600.00', '400.00'])];
    for (const s of version2) await nw.sql.query(s);
    try {
      const known = await nw.run({ versions: { ...PRICING_VERSIONS, 2: v2 } });
      expect(known.rows, JSON.stringify(known.rows)).toEqual([]);
      const unknown = await nw.run();
      expect(unknown.ok).toBe(false);
      const row = unknown.rows.find((x) => x.invariant === 'I6' && x.row_ref === `bills:${aB1.id}`);
      expect(row, JSON.stringify(unknown.rows)).toBeDefined();
      expect(row!.detail).toMatch(/pricing version 2/);
      expect(unknown.counts.I6, 'one problem for the bill, not one for each of its lines').toBe(1);
      // the version of the bill decides, not the newest: the same stored amounts, on a bill that says version 2 but was priced as version 1, are wrong under the version 2 function
      for (const s of version1) await nw.sql.query(s);
      await nw.sql.query(`UPDATE bills SET pricing_version = 2 WHERE id = '${aB1.id}'`);
      const mislabelled = await nw.run({ versions: { ...PRICING_VERSIONS, 2: v2 } });
      expect(mislabelled.rows.filter((x) => x.invariant === 'I6').map((x) => x.row_ref).sort()).toEqual(lines.map((l: { id: string }) => `bill_items:${l.id}`).sort());
    } finally {
      for (const s of version1) await nw.sql.query(s);
    }
    expect((await nw.run()).rows).toEqual([]);
  });
});

// ------------------------------------------------------------------ the TypeScript twin of the database half

describe('T-B18 the TypeScript twin of runInvariants (src/domain/invariants.ts) is the database half\'s function (scripts/invariants.mjs)', () => {
  it('every embedded invariant file and every derived read is the text of the file on disk', () => {
    expect(INVARIANT_FILES.map((f) => ({ id: f.id, name: f.name, sql: f.sql }))).toEqual(listInvariantFiles());
    const q = loadQueries();
    expect(V1_TEXT).toBe(q.V1);
    expect(V2_TEXT).toBe(q.V2);
  });

  it('both runners give the same answer on clean books, on a damaged piece and on an injected query', async () => {
    const conn = await nw.w.world.app.db!.checkout();
    try {
      const same = async (opts: any = {}) => {
        const a = await scriptRun(conn, opts);
        const b = await twinRun(conn, opts);
        expect(b).toEqual(a);
        return b;
      };
      expect((await same()).ok).toBe(true);
      const { s1 } = nw.books.skus;
      await nw.sql.query(`UPDATE skus SET status = 'In Stock', sold_bill_id = NULL WHERE id = '${s1.id}'`);
      try {
        const damagedRun = await same();
        expect(damagedRun.ok).toBe(false);
        expect(damagedRun.rows.some((x) => x.invariant === 'I1')).toBe(true);
        await same({ sample: 1 });
      } finally {
        await nw.sql.query(`UPDATE skus SET status = 'Sold', sold_bill_id = '${nw.books.bills.aB1.id}' WHERE id = '${s1.id}'`);
      }
      await same({ queries: { V4: 'SELECT paid_on AS business_date, mode, 0 AS money_in, 0 AS money_out, 0 AS net FROM receipts' } });
    } finally {
      conn.release();
    }
  });

  it('both runners have the same hook for the work that must share the snapshot: inSnapshot is called once, inside the transaction, after the last file, and its failure rolls back', async () => {
    const conn = await nw.w.world.app.db!.checkout();
    try {
      const runners: ((conn: any, opts: any) => Promise<any>)[] = [scriptRun, twinRun];
      for (const run of runners) {
        let calls = 0;
        let inTx = '';
        const r = await run(conn, {
          inSnapshot: async (c: any) => {
            calls++;
            inTx = String(((await c.query('SELECT @@session.in_transaction AS t'))[0] as any[])[0].t);
          },
        });
        expect(calls).toBe(1);
        expect(inTx).toBe('1');
        expect(r.ran).toHaveLength(9);
        await expect(
          run(conn, {
            inSnapshot: async () => {
              throw new Error('boom');
            },
          }),
        ).rejects.toThrow('boom');
        expect(String(((await conn.query<any[]>('SELECT @@session.in_transaction AS t'))[0] as any[])[0].t)).toBe('0');
      }
    } finally {
      conn.release();
    }
  });
});
