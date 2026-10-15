import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Connection } from 'mysql2/promise';
import { afterAll, describe, expect, it } from 'vitest';
import { HOST, PORT, dropDb } from '../helpers';
import { formatReport, normaliseMobile, runImport, seedCounters, type ImportPack } from '../../scripts/import.mjs';
import { runInvariants } from '../../scripts/invariants.mjs';
import { T, V, insert, migratedDb, uuid } from './support';

// Spec section 6.3 (IM1 to IM8) and T-C16, T-B21 (database half): the import of designs, pieces, customers and opening balances.
// The Mac script reads a normalised pack (JSON) and writes it in ONE transaction; these tests run it against a throw-away database.

const dbs: string[] = [];
const dirs: string[] = [];
afterAll(async () => {
  for (const d of dbs) await dropDb(d);
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
let n = 0;
async function shop() {
  const { db, c } = await migratedDb(`s15_${++n}`);
  dbs.push(db);
  return { db, c };
}
const WALKIN = '00000000-0000-4000-8000-000000000001';
/** MariaDB's JSON columns come back as parsed objects from mysql2, text from other clients: accept both. */
const asJson = (v: unknown) => (typeof v === 'string' ? JSON.parse(v) : v);

/** A small realistic pack: five customers with every kind of opening figure, two designs, four pieces. */
function pack(over: Partial<ImportPack> = {}): ImportPack {
  return {
    batch: `siddhi-${uuid()}`,
    source_file: 'stock-and-dues.xlsx',
    cut_over: '2026-11-01',
    customers: [
      { ref: 'row 2', name: 'Anita Sharma', mobile: '+91 98765 43210', customer_type: 'Retail', dues: '1500.50', fine_due: '2.500' },
      { ref: 'row 3', name: 'Bharat Jewellers', mobile: '09123456780', customer_type: 'Wholesale', dues: '300.00', advance: '100.00' },
      { ref: 'row 4', name: 'Chitra Devi', mobile: '9000000003', advance: '50.00', fine_advance: '1.250' },
      { ref: 'row 5', name: 'Dilip (no mobile)', dues: '0.00' },
      { ref: 'row 6', name: 'walk-in', walkin: true, dues: '40.00' },
    ],
    designs: [
      {
        design_no: ' RING-00042 ', name: 'Floral ring', category: 'ring', material: 'gold', purity: '22K', selling_method: 'by weight', tags: ['bridal'],
        pieces: [
          { sku_no: 'RING-00042-001 ', barcode: 'BC-R42-1', gross_weight: '5.500', customer_net_weight: '5.000', original_net_weight: '4.800', stones: 3, labour_retail: '120.00', labour_semi: '110.00', labour_wholesale: '100.00', location: 'Main Showroom' },
          { gross_weight: '6.100', customer_net_weight: '5.600', labour_retail: '120.00', labour_wholesale: '100.00' },
        ],
      },
      {
        design_no: 'PAYAL-7', category: 'Payal', material: 'Silver', purity: '925', selling_method: 'Per Piece',
        pieces: [
          { sku_no: 'PAYAL-7-A', gross_weight: '40.000', customer_net_weight: '38.000', labour_retail: '900.00', labour_semi: '850.00', labour_wholesale: '800.00' },
          { sku_no: 'PAYAL-7-B', gross_weight: '41.000', customer_net_weight: '39.000', labour_retail: '900.00', labour_wholesale: '800.00', status: 'Damaged' },
        ],
      },
    ],
    ...over,
  };
}
const count = async (c: Connection, table: string, where = '1=1', params: unknown[] = []) =>
  Number((((await c.query<any[]>(`SELECT COUNT(*) AS n FROM \`${table}\` WHERE ${where}`, params))[0]) as any[])[0].n);
const v2 = async (c: Connection, id: string) => ((await c.query<any[]>(`SELECT * FROM ${T.customer_balances} WHERE id = ?`, [id]))[0] as any[])[0];
const byName = async (c: Connection, name: string) => ((await c.query<any[]>('SELECT * FROM customers WHERE name = ?', [name]))[0] as any[])[0];

describe('normaliseMobile (IM6)', () => {
  it.each([
    ['98765 43210', '9876543210'],
    ['098765-43210', '9876543210'],
    ['+91 98765 43210', '9876543210'],
    ['+91-98765-43210', '9876543210'],
    ['(98765) 43210', '9876543210'],
    ['919876543210', '9876543210'],
    ['+44 7911 123456', '+447911123456'],
    [9876543210, '9876543210'],
  ])('%j becomes %j', (raw, want) => {
    expect(normaliseMobile(raw)).toEqual({ mobile: want, problem: null });
  });
  it.each([['', 'blank'], [null, 'blank'], [undefined, 'blank'], ['12345', 'not'], ['abcdefghij', 'not'], ['98765 4321', 'not'], ['+1 23', 'not']])('%j is listed for Siddhi (%s)', (raw, word) => {
    const r = normaliseMobile(raw);
    expect(r.mobile).toBeNull();
    expect(r.problem).toContain(word);
  });
});

describe('runImport: the happy path (IM1, IM2, IM6, T-C16)', () => {
  it('writes designs, pieces, customers and opening rows; every imported design, piece, customer and bill carries the batch; her own numbers are stored as given', async () => {
    const { c } = await shop();
    const p = pack();
    const r = await runImport(c, p);
    expect(r.rejected).toEqual([]);
    expect(r.ok).toBe(true);
    const [[batch]] = await c.query<any[][]>('SELECT id, name, source_file, row_counts FROM sys_import_batches');
    expect((batch as any).name).toBe(p.batch);
    expect((batch as any).source_file).toBe('stock-and-dues.xlsx');
    expect(r.batch).toEqual({ id: (batch as any).id, name: p.batch });
    const id = (batch as any).id;
    expect(await count(c, 'customers', 'import_batch_id = ?', [id])).toBe(4); // the walk-in already exists and gets no new row
    expect(await count(c, 'designs', 'import_batch_id = ?', [id])).toBe(2);
    expect(await count(c, 'skus', 'import_batch_id = ?', [id])).toBe(4);
    expect(await count(c, 'bills', 'import_batch_id = ?', [id])).toBe(3); // Anita, Bharat and the walk-in have dues; Chitra has an advance only, Dilip nothing
    expect(await count(c, 'sku_private')).toBe(1);
    expect(await count(c, 'receipts')).toBe(3); // Bharat's money, Chitra's money and Chitra's silver
    expect(asJson((batch as any).row_counts)).toMatchObject({ customers: 5, designs: 2, pieces: 4 });
    const [designs] = await c.query<any[]>('SELECT design_no, material, selling_method, category_id FROM designs ORDER BY design_no');
    expect(designs.map((d) => [d.design_no, d.material, d.selling_method])).toEqual([['PAYAL-7', 'Silver', 'Per Piece'], ['RING-00042', 'Gold', 'By Weight']]);
    const [skus] = await c.query<any[]>('SELECT sku_no, barcode, status, location, labour_semi FROM skus ORDER BY sku_no');
    expect(skus.map((s) => [s.sku_no, s.barcode, s.status])).toEqual([
      ['PAYAL-7-A', 'BC-PAYAL-7-A', 'In Stock'],
      ['PAYAL-7-B', 'BC-PAYAL-7-B', 'Damaged'],
      ['RING-00042-001', 'BC-R42-1', 'In Stock'],
      ['RING-00042-002', 'BC-RING-00042-002', 'In Stock'], // no number given: <design_no>-<3 digits>, after the highest given
    ]);
    expect(skus[3].labour_semi).toBe('110.00'); // missing semi-wholesale: the average of 120.00 and 100.00
    expect(skus[1].labour_semi).toBe('850.00');
    const [[priv]] = await c.query<any[][]>('SELECT p.original_net_weight AS w FROM sku_private p JOIN skus s ON s.id = p.sku_id WHERE s.sku_no = ?', ['RING-00042-001']);
    expect((priv as any).w).toBe('4.800');
    await c.end();
  });

  it('the report reconciles to the source: counts, opening totals, and each customer\'s outstanding and advance from V2', async () => {
    const { c } = await shop();
    const r = await runImport(c, pack());
    expect(r.counts).toEqual({
      customers: { source: 5, imported: 5, rejected: 0 },
      designs: { source: 2, imported: 2, rejected: 0 },
      pieces: { source: 4, imported: 4, rejected: 0 },
      opening_bills: 3,
      opening_advances: 3,
      allocations: 1,
    });
    expect(r.totals).toEqual({
      dues_source: '1840.50', dues_imported: '1840.50', fine_source: '2.500', fine_imported: '2.500',
      advance_source: '150.00', advance_imported: '150.00', fine_advance_source: '1.250', fine_advance_imported: '1.250',
    });
    expect(r.mismatches).toEqual([]);
    const anita = await v2(c, (await byName(c, 'Anita Sharma')).id);
    expect([anita.outstanding, anita.advance, anita.fine_outstanding]).toEqual(['1500.50', '0.00', '2.500']);
    const bharat = await v2(c, (await byName(c, 'Bharat Jewellers')).id);
    expect([bharat.billed, bharat.outstanding, bharat.advance]).toEqual(['300.00', '200.00', '0.00']); // dues 300, advance 100 net off
    const chitra = await v2(c, (await byName(c, 'Chitra Devi')).id);
    expect([chitra.outstanding, chitra.advance, chitra.fine_advance]).toEqual(['0.00', '50.00', '1.250']);
    const walkin = await v2(c, WALKIN);
    expect([walkin.outstanding, walkin.advance]).toEqual(['40.00', '0.00']);
    expect(r.invalid_mobiles.map((m) => [m.ref, m.name])).toEqual([['row 5', 'Dilip (no mobile)']]);
    expect((await byName(c, 'Dilip (no mobile)')).mobile).toBeNull();
    expect((await byName(c, 'Anita Sharma')).mobile).toBe('9876543210');
    expect((await byName(c, 'Bharat Jewellers')).mobile).toBe('9123456780');
    await c.end();
  });

  it('opening rows are what D15 says: an OB- bill with no lines dated the cut-over day, an is_opening receipt for each advance', async () => {
    const { c } = await shop();
    await runImport(c, pack());
    const [bills] = await c.query<any[]>("SELECT bill_no, bill_date, doc_type, subtotal, grand_total, fine_weight_due, sale_type, request_id FROM bills ORDER BY bill_no");
    expect(bills.map((b) => [b.bill_no, b.bill_date, b.doc_type, b.subtotal, b.grand_total, b.fine_weight_due])).toEqual([
      ['OB-0001', '2026-11-01', 'opening_balance', '0.00', '1500.50', '2.500'],
      ['OB-0002', '2026-11-01', 'opening_balance', '0.00', '300.00', '0.000'],
      ['OB-0003', '2026-11-01', 'opening_balance', '0.00', '40.00', '0.000'],
    ]);
    expect(bills[1].sale_type).toBe('Wholesale'); // the customer's type
    expect(await count(c, 'bill_items')).toBe(0);
    const [rc] = await c.query<any[]>('SELECT kind, mode, amount, fine_grams, is_opening, paid_on, reference FROM receipts ORDER BY kind, amount');
    expect(rc.map((x) => [x.kind, x.mode, x.amount, x.fine_grams, Number(x.is_opening), x.paid_on])).toEqual([
      ['fine_silver', null, '0.00', '1.250', 1, '2026-11-01'],
      ['money', 'Other', '50.00', '0.000', 1, '2026-11-01'],
      ['money', 'Other', '100.00', '0.000', 1, '2026-11-01'],
    ]);
    expect(rc.every((x) => x.reference === 'Opening advance')).toBe(true);
    // not money received today, not a sale: the cash book and the sales figures leave them out
    expect(Number((((await c.query<any[]>(`SELECT COUNT(*) AS n FROM ${T.daily_totals}`))[0]) as any[])[0].n)).toBe(0);
    await c.end();
  });

  it('afterwards the nightly check passes (I3, I5, I10 included) and new numbers continue after the imported ones (IM3, L3)', async () => {
    const { c } = await shop();
    await runImport(c, pack());
    const r = await runInvariants(c);
    expect(r.rows, JSON.stringify(r.rows.slice(0, 3))).toEqual([]);
    const [ctr] = await c.query<any[]>("SELECT series, last_value, seed_value FROM sys_counters ORDER BY series");
    expect(ctr.map((x) => [x.series, Number(x.last_value), Number(x.seed_value)])).toEqual([
      ['design:RING', 42, 42], // RING-00042 is her own number; the next new ring is RING-00043
      ['opening', 3, 3],
      ['sku:RING-00042', 2, 2],
    ]);
    // an X12-style opening bill made after the import takes OB-0004 and the check stays green
    const cu = await byName(c, 'Dilip (no mobile)');
    await c.query("UPDATE sys_counters SET last_value = LAST_INSERT_ID(last_value + 1) WHERE series = 'opening'");
    const [[nx]] = await c.query<any[][]>('SELECT LAST_INSERT_ID() AS n');
    expect(Number((nx as any).n)).toBe(4);
    await insert(c, 'bills', V.bill(cu.id, { bill_no: 'OB-0004', doc_type: 'opening_balance', subtotal: '0.00', grand_total: '10.00', request_id: null }));
    // and a first ordinary bill takes number 1 of its series (the import issued none)
    await c.query("INSERT INTO sys_counters (series, last_value) VALUES ('bill:JV:2026', 1)");
    await insert(c, 'bills', V.bill(cu.id, { bill_no: 'JV-2026-0001', subtotal: '5.00', grand_total: '5.00' }));
    const after = await runInvariants(c);
    expect(after.rows.filter((x) => x.invariant === 'I5')).toEqual([]);
    await c.end();
  });
});

describe('runImport: batches, atomicity, audit, polling (IM1, IM2, C4, L1)', () => {
  it('the same batch name is refused the second time and adds nothing', async () => {
    const { c } = await shop();
    const p = pack();
    await runImport(c, p);
    const before = [await count(c, 'customers'), await count(c, 'skus'), await count(c, 'bills'), await count(c, 'audit_log')];
    await expect(runImport(c, p)).rejects.toThrow(/already/);
    expect([await count(c, 'customers'), await count(c, 'skus'), await count(c, 'bills'), await count(c, 'audit_log')]).toEqual(before);
    await c.end();
  });

  it('a failure at ANY step leaves nothing behind: no batch row, no customer, no piece, no bill, no receipt, no counter, no audit row', async () => {
    const { c } = await shop();
    for (const step of ['batch', 'customers', 'designs', 'skus', 'opening', 'rebalance', 'audit', 'counters', 'restamp']) {
      await expect(runImport(c, pack(), { after: (s) => { if (s === step) throw new Error(`boom at ${step}`); } }), step).rejects.toThrow(`boom at ${step}`);
      for (const [table, base] of [['sys_import_batches', 0], ['customers', 1], ['designs', 0], ['skus', 0], ['bills', 0], ['receipts', 0], ['receipt_allocations', 0], ['sys_counters', 0], ['audit_log', 0]] as const) {
        expect(await count(c, table), `${table} after a failure at ${step}`).toBe(base);
      }
    }
    // the connection is usable and a normal import still works
    expect((await runImport(c, pack())).ok).toBe(true);
    await c.end();
  });

  it('a dry run does everything, reports the same figures and leaves nothing', async () => {
    const { c } = await shop();
    const p = pack();
    const dry = await runImport(c, p, { dryRun: true });
    expect(dry.dry_run).toBe(true);
    expect(dry.invariants).toBeNull();
    expect(await count(c, 'customers')).toBe(1);
    expect(await count(c, 'sys_import_batches')).toBe(0);
    const real = await runImport(c, p);
    expect(real.counts).toEqual(dry.counts);
    expect(real.totals).toEqual(dry.totals);
    expect(real.dry_run).toBe(false);
    expect(real.invariants).toMatchObject({ ok: true });
    await c.end();
  });

  it('writes one audit row for every inserted row, with no actor and the role import (L1, IM2); audit: none writes none', async () => {
    const { c } = await shop();
    await runImport(c, pack());
    const [rows] = await c.query<any[]>('SELECT table_name, COUNT(*) AS n, MIN(action) a, MIN(actor_role) r, COUNT(actor) AS actors FROM audit_log GROUP BY table_name ORDER BY table_name');
    expect(rows.map((x) => [x.table_name, Number(x.n)])).toEqual([
      ['bills', 3], ['customers', 4], ['designs', 2], ['receipt_allocations', 1], ['receipts', 3], ['sku_private', 1], ['skus', 4],
    ]);
    for (const x of rows) expect([x.a, x.r, Number(x.actors)]).toEqual(['insert', 'import', 0]);
    const [[one]] = await c.query<any[][]>("SELECT row_id, new_row FROM audit_log WHERE table_name = 'customers' AND JSON_VALUE(new_row, '$.name') = 'Anita Sharma'");
    expect(asJson((one as any).new_row)).toMatchObject({ name: 'Anita Sharma', mobile: '9876543210' });
    expect((one as any).row_id).toBe((await byName(c, 'Anita Sharma')).id);
    const other = await shop();
    await runImport(other.c, pack(), { audit: 'none' });
    expect(await count(other.c, 'audit_log')).toBe(0);
    await c.end();
    await other.c.end();
  });

  it('re-stamps updated_at of every imported row after the work and moves data_epoch, so screens that poll receive them (C4)', async () => {
    const { c } = await shop();
    const [[before]] = await c.query<any[][]>("SELECT JSON_VALUE(value, '$.epoch') AS e FROM settings WHERE setting_key = 'data_epoch'");
    await runImport(c, pack());
    const [[after]] = await c.query<any[][]>("SELECT JSON_VALUE(value, '$.epoch') AS e FROM settings WHERE setting_key = 'data_epoch'");
    const epoch = (after as any).e as string;
    expect(epoch > (before as any).e).toBe(true);
    for (const t of ['designs', 'skus', 'bills', 'receipts', 'receipt_allocations', 'sku_private']) {
      const [[x]] = await c.query<any[][]>(`SELECT COUNT(*) AS n, SUM(updated_at = ?) AS same FROM \`${t}\``, [epoch]);
      expect([t, Number((x as any).same)], t).toEqual([t, Number((x as any).n)]);
    }
    const [[cu]] = await c.query<any[][]>('SELECT COUNT(*) AS n, SUM(updated_at = ?) AS same FROM customers WHERE import_batch_id IS NOT NULL', [epoch]);
    expect(Number((cu as any).same)).toBe(Number((cu as any).n));
    await c.end();
  });
});

describe('runImport: rows it must refuse or flag (IM6)', () => {
  it('an unknown category rejects the design and its pieces, with the reason; everything else is imported and ok is false', async () => {
    const { c } = await shop();
    const p = pack();
    p.designs![1].category = 'Gizmo';
    const r = await runImport(c, p);
    expect(r.ok).toBe(false);
    expect(r.counts.designs).toEqual({ source: 2, imported: 1, rejected: 1 });
    expect(r.counts.pieces).toEqual({ source: 4, imported: 2, rejected: 2 });
    expect(r.rejected.filter((x) => x.table === 'designs').map((x) => [x.ref, x.reason])).toEqual([['PAYAL-7', expect.stringContaining('Gizmo')]]);
    expect(r.rejected.filter((x) => x.table === 'skus').every((x) => /design/i.test(x.reason))).toBe(true);
    expect(await count(c, 'designs')).toBe(1);
    expect(await count(c, 'skus')).toBe(2);
    await c.end();
  });

  it('numbers are unique ignoring case: a repeat in the pack or a number already in the database is rejected; the first one stays', async () => {
    const { c } = await shop();
    const cat = ((await c.query<any[]>("SELECT id FROM categories WHERE name = 'Ring'"))[0] as any[])[0].id;
    await insert(c, 'designs', V.design(cat, { design_no: 'OLD-1' }));
    const p = pack();
    p.designs!.push({ design_no: 'ring-00042', category: 'Ring', material: 'Gold', purity: '22K', selling_method: 'By Weight', pieces: [{ sku_no: 'X-1', gross_weight: '1.000', customer_net_weight: '1.000' }] });
    p.designs!.push({ design_no: 'old-1', category: 'Ring', material: 'Gold', purity: '22K', selling_method: 'By Weight' });
    p.designs![0].pieces!.push({ sku_no: 'payal-7-a', barcode: 'BC-NEW', gross_weight: '1.000', customer_net_weight: '1.000' }); // sku_no repeats another piece, ignoring case
    p.designs![0].pieces!.push({ sku_no: 'FRESH-1', barcode: 'bc-r42-1', gross_weight: '1.000', customer_net_weight: '1.000' }); // barcode repeats another piece
    const r = await runImport(c, p);
    const why = (table: string) => r.rejected.filter((x) => x.table === table).map((x) => x.reason).join(' | ');
    expect(why('designs')).toMatch(/twice|appears more than once/);
    expect(why('designs')).toMatch(/already exists/);
    expect(why('skus')).toMatch(/sku_no/);
    expect(why('skus')).toMatch(/barcode/);
    expect((await c.query<any[]>("SELECT design_no FROM designs WHERE design_no = 'RING-00042'"))[0]).toHaveLength(1);
    await c.end();
  });

  it('a number longer than 64 characters or blank is rejected', async () => {
    const { c } = await shop();
    const p = pack();
    p.designs!.push({ design_no: 'D'.repeat(65), category: 'Ring', material: 'Gold', purity: '22K', selling_method: 'By Weight' });
    p.designs!.push({ design_no: '   ', category: 'Ring', material: 'Gold', purity: '22K', selling_method: 'By Weight' });
    const r = await runImport(c, p);
    expect(r.rejected.filter((x) => x.table === 'designs')).toHaveLength(2);
    await c.end();
  });

  it('a 64-character design number is accepted', async () => {
    const { c } = await shop();
    const long = 'L'.repeat(60) + '-001';
    expect(long).toHaveLength(64);
    const p = pack({ customers: [], designs: [{ design_no: long, category: 'Ring', material: 'Gold', purity: '22K', selling_method: 'By Weight', pieces: [{ sku_no: 'LONG-P1', barcode: 'LONG-B1', gross_weight: '1.000', customer_net_weight: '1.000' }] }] });
    const r = await runImport(c, p);
    expect(r.rejected).toEqual([]);
    expect(await count(c, 'designs', 'design_no = ?', [long])).toBe(1);
    await c.end();
  });

  it('a made-up piece number or barcode that would not fit in 64 characters is rejected with a clear reason, not cut short', async () => {
    const { c } = await shop();
    const long = 'L'.repeat(62);
    const p = pack({ customers: [], designs: [{ design_no: long, category: 'Ring', material: 'Gold', purity: '22K', selling_method: 'By Weight', pieces: [{ gross_weight: '1.000' }, { sku_no: 'FINE-1', gross_weight: '1.000' }] }] });
    const r = await runImport(c, p);
    expect(r.rejected.filter((x) => x.table === 'skus')).toHaveLength(1);
    expect(r.rejected[0].reason).toMatch(/longer than 64/);
    expect(await count(c, 'skus')).toBe(1);
    await c.end();
  });

  it('decimals beyond the column, negative numbers and numbers above the limits are rejected, not rounded', async () => {
    const { c } = await shop();
    const p = pack({ customers: [
      { ref: 'a', name: 'Three decimals', mobile: '9000000011', dues: '10.005' },
      { ref: 'b', name: 'Negative', mobile: '9000000012', dues: '-5.00' },
      { ref: 'c', name: 'Too much', mobile: '9000000013', dues: '1000000000.01' },
      { ref: 'd', name: 'Not a number', mobile: '9000000014', dues: 'ten' },
      { ref: 'e', name: 'Fine four decimals', mobile: '9000000015', fine_due: '1.2345' },
      { ref: 'f', name: '', mobile: '9000000016' },
    ], designs: [{ design_no: 'W-1', category: 'Ring', material: 'Gold', purity: '22K', selling_method: 'By Weight', pieces: [
      { sku_no: 'W-1-A', gross_weight: '1.2345', customer_net_weight: '1.000' },
      { sku_no: 'W-1-B', gross_weight: '100000.001', customer_net_weight: '1.000' },
      { sku_no: 'W-1-C', gross_weight: '1.000', customer_net_weight: '1.000', labour_retail: '100000000.01' },
      { sku_no: 'W-1-D', gross_weight: '1.000', customer_net_weight: '1.000', status: 'Sold' },
      { sku_no: 'W-1-E', gross_weight: '1.000', customer_net_weight: '1.000', status: 'Archived' },
      { sku_no: 'W-1-F', gross_weight: '1.000', customer_net_weight: '1.000', status: 'Nonsense' },
      { sku_no: 'W-1-G', gross_weight: '1.000', customer_net_weight: '1.000', stones: 1.5 },
      { sku_no: 'W-1-OK', gross_weight: 2.5, customer_net_weight: 2, labour_retail: 100, labour_wholesale: 90 },
    ] }] });
    const r = await runImport(c, p);
    expect(r.rejected.filter((x) => x.table === 'customers').map((x) => x.ref)).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
    expect(r.rejected.filter((x) => x.table === 'skus').map((x) => x.ref)).toEqual(['W-1-A', 'W-1-B', 'W-1-C', 'W-1-D', 'W-1-E', 'W-1-F', 'W-1-G']);
    expect(await count(c, 'customers')).toBe(1);
    expect(await count(c, 'skus')).toBe(1);
    const [[ok]] = await c.query<any[][]>("SELECT gross_weight, customer_net_weight, labour_semi FROM skus WHERE sku_no = 'W-1-OK'");
    expect([(ok as any).gross_weight, (ok as any).customer_net_weight, (ok as any).labour_semi]).toEqual(['2.500', '2.000', '95.00']); // numbers work too; semi = average of 100 and 90
    await c.end();
  });

  it('semi-wholesale left blank is the average of retail and wholesale, rounded half up to the paisa', async () => {
    const { c } = await shop();
    const p = pack({ customers: [], designs: [{ design_no: 'AVG-1', category: 'Ring', material: 'Gold', purity: '22K', selling_method: 'By Weight', pieces: [
      { sku_no: 'AVG-1-A', labour_retail: '100.01', labour_wholesale: '90.00' },
      { sku_no: 'AVG-1-B', labour_retail: '100.00', labour_wholesale: '90.00' },
      { sku_no: 'AVG-1-C', labour_retail: '100.00' },
      { sku_no: 'AVG-1-D', labour_wholesale: '80.00' },
      { sku_no: 'AVG-1-E' },
      { sku_no: 'AVG-1-F', labour_retail: '100.00', labour_semi: '0.00', labour_wholesale: '90.00' },
    ] }] });
    await runImport(c, p);
    const [rows] = await c.query<any[]>('SELECT sku_no, labour_semi FROM skus ORDER BY sku_no');
    expect(rows.map((x) => [x.sku_no, x.labour_semi])).toEqual([
      ['AVG-1-A', '95.01'], ['AVG-1-B', '95.00'], ['AVG-1-C', '100.00'], ['AVG-1-D', '80.00'], ['AVG-1-E', '0.00'], ['AVG-1-F', '0.00'],
    ]);
    await c.end();
  });

  it('what the API would refuse on a screen but an old row may already break is stored and flagged: net above gross, By Weight with net 0, a PAN that is not valid, a shared mobile number', async () => {
    const { c } = await shop();
    const p = pack({ customers: [
      { ref: 'x', name: 'Has PAN', mobile: '9000000021', pan: 'abcde1234f' },
      { ref: 'y', name: 'Bad PAN', mobile: '9000000022', pan: 'NOTAPAN' },
      { ref: 'z', name: 'Shares mobile', mobile: '9000000021' },
    ], designs: [{ design_no: 'FLAG-1', category: 'Ring', material: 'Gold', purity: '22K', selling_method: 'By Weight', pieces: [
      { sku_no: 'FLAG-1-A', gross_weight: '3.000', customer_net_weight: '4.000' },
      { sku_no: 'FLAG-1-B', gross_weight: '3.000', customer_net_weight: '0.000' },
    ] }] });
    const r = await runImport(c, p);
    expect(r.rejected).toEqual([]);
    expect(r.warnings.join('\n')).toMatch(/FLAG-1-A.*net weight.*gross/i);
    expect(r.warnings.join('\n')).toMatch(/FLAG-1-B.*By Weight.*net weight 0/i);
    expect(r.warnings.join('\n')).toMatch(/Bad PAN.*PAN/);
    expect(r.warnings.join('\n')).toMatch(/9000000021/);
    expect((await byName(c, 'Has PAN')).pan).toBe('ABCDE1234F'); // a valid PAN in lower case is made upper case
    expect((await byName(c, 'Bad PAN')).pan).toBeNull();
    expect(await count(c, 'skus')).toBe(2);
    await c.end();
  });

  it('the walk-in may carry dues (K5) but never an advance: such an entry is rejected as a whole', async () => {
    const { c } = await shop();
    const p = pack({ customers: [{ ref: 'w1', name: 'walk-in', walkin: true, dues: '25.00' }, { ref: 'w2', name: 'walk-in', walkin: true, advance: '10.00' }], designs: [] });
    const r = await runImport(c, p);
    expect(r.rejected.map((x) => [x.table, x.ref])).toEqual([['opening', 'w2']]);
    expect((await v2(c, WALKIN)).outstanding).toBe('25.00');
    expect(await count(c, 'receipts')).toBe(0);
    await c.end();
  });

  it('strict mode keeps nothing when anything is rejected', async () => {
    const { c } = await shop();
    const p = pack();
    p.designs![1].category = 'Gizmo';
    const r = await runImport(c, p, { strict: true });
    expect(r.ok).toBe(false);
    expect(r.batch.id).toBeNull();
    expect(r.rejected.length).toBeGreaterThan(0);
    expect(await count(c, 'sys_import_batches')).toBe(0);
    expect(await count(c, 'customers')).toBe(1);
    await c.end();
  });

  it('refuses a pack that is not a pack: no batch name, a bad cut-over date, a future-proof guard on types', async () => {
    const { c } = await shop();
    await expect(runImport(c, { ...pack(), batch: '  ' })).rejects.toThrow(/batch/);
    await expect(runImport(c, { ...pack(), cut_over: '01-11-2026' })).rejects.toThrow(/cut_over/);
    await expect(runImport(c, { ...pack(), cut_over: '2026-02-30' })).rejects.toThrow(/cut_over/);
    await expect(runImport(c, { ...pack(), batch: 'x'.repeat(121) })).rejects.toThrow(/batch/);
    expect(await count(c, 'sys_import_batches')).toBe(0);
    await c.end();
  });

  it('the report can be printed: it names the batch, the counts, the totals, every rejected row and every blank mobile', async () => {
    const { c } = await shop();
    const p = pack();
    p.designs![1].category = 'Gizmo';
    const text = formatReport(await runImport(c, p, { dryRun: true }));
    expect(text).toContain(p.batch);
    expect(text).toContain('DRY RUN');
    expect(text).toMatch(/customers\s+source 5\s+imported 5/);
    expect(text).toContain('1840.50');
    expect(text).toContain('PAYAL-7');
    expect(text).toContain('Gizmo');
    expect(text).toContain('Dilip (no mobile)');
    await c.end();
  });
});

describe('seedCounters (IM3)', () => {
  it('sets each series to the largest number found and never lowers one; running it twice changes nothing', async () => {
    const { c } = await shop();
    const cat = ((await c.query<any[]>("SELECT id FROM categories WHERE name = 'Chain'"))[0] as any[])[0].id; // prefix CHN
    const batch = uuid();
    await insert(c, 'sys_import_batches', { id: batch, name: 'earlier' });
    const d1 = (await insert(c, 'designs', V.design(cat, { design_no: 'CHN-00007', import_batch_id: batch }))) as { id: string };
    await insert(c, 'designs', V.design(cat, { design_no: 'CHN-00031', import_batch_id: batch }));
    await insert(c, 'designs', V.design(cat, { design_no: 'MYOWN-9' })); // not <prefix>-<digits>: ignored
    await insert(c, 'skus', V.sku(d1.id, { sku_no: 'CHN-00007-004', barcode: 'B1' }));
    await insert(c, 'skus', V.sku(d1.id, { sku_no: 'CHN-00007-012', barcode: 'B2' }));
    await insert(c, 'skus', V.sku(d1.id, { sku_no: 'ODD-CODE', barcode: 'B3' }));
    const cu = (await insert(c, 'customers', V.customer())) as { id: string };
    await insert(c, 'bills', V.bill(cu.id, { bill_no: 'JV-2026-0150', import_batch_id: batch, request_id: null }));
    await insert(c, 'bills', V.bill(cu.id, { bill_no: 'JV-2025-0300', import_batch_id: batch, request_id: null }));
    await insert(c, 'bills', V.bill(cu.id, { bill_no: 'OB-0009', doc_type: 'opening_balance', subtotal: '0.00', import_batch_id: batch, request_id: null }));
    await c.query("INSERT INTO sys_counters (series, last_value, seed_value) VALUES ('design:CHN', 50, 0)"); // already higher than the data: stays
    const first = await seedCounters(c);
    const [ctr] = await c.query<any[]>('SELECT series, last_value, seed_value FROM sys_counters ORDER BY series');
    expect(ctr.map((x) => [x.series, Number(x.last_value), Number(x.seed_value)])).toEqual([
      ['bill:JV:2025', 300, 300],
      ['bill:JV:2026', 150, 150],
      ['design:CHN', 50, 31],
      ['opening', 9, 9],
      ['sku:CHN-00007', 12, 12],
    ]);
    expect(first.length).toBeGreaterThan(0);
    const again = await seedCounters(c);
    expect((await c.query<any[]>('SELECT series, last_value, seed_value FROM sys_counters ORDER BY series'))[0]).toEqual(ctr);
    expect(again.length).toBe(first.length);
    const r = await runInvariants(c);
    expect(r.rows.filter((x) => x.invariant === 'I5')).toEqual([]);
    await c.end();
  });
});

describe('a deep import (IM1: each batch under 20 seconds)', () => {
  it('1,000 customers with opening figures and 2,000 designs with 3 pieces each go in one transaction in seconds, reconcile, and pass the nightly check', async () => {
    const { c } = await shop();
    const customers = Array.from({ length: 1000 }, (_, i) => ({
      ref: `r${i}`, name: `Customer ${i}`, mobile: `9${String(100000000 + i)}`, customer_type: 'Retail' as const,
      dues: i % 3 === 0 ? `${100 + i}.50` : undefined, fine_due: i % 7 === 0 ? '1.250' : undefined, advance: i % 5 === 0 ? '75.00' : undefined, fine_advance: i % 11 === 0 ? '0.500' : undefined,
    }));
    const designs = Array.from({ length: 2000 }, (_, i) => ({
      design_no: `RING-${String(i + 1).padStart(5, '0')}`, category: 'Ring', material: 'Gold', purity: '22K', selling_method: 'By Weight',
      pieces: [0, 1, 2].map((k) => ({ gross_weight: '5.000', customer_net_weight: '4.500', labour_retail: '100.00', labour_wholesale: '90.00', notes: `piece ${k}` })),
    }));
    const t0 = Date.now();
    const r = await runImport(c, pack({ customers, designs }));
    const ms = Date.now() - t0;
    console.log(`[s15] import of ${customers.length} customers, ${designs.length} designs, ${designs.length * 3} pieces: ${ms} ms (${r.counts.opening_bills} opening bills, ${r.counts.allocations} allocations)`);
    expect(r.rejected).toEqual([]);
    expect(r.mismatches).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.counts.pieces.imported).toBe(6000);
    expect(ms).toBeLessThan(20_000);
    expect(r.invariants?.ok).toBe(true);
    await c.end();
  }, 120000);
});

describe('import-cli (IM1: a script run on the Mac; the password only from the environment)', () => {
  const run = (args: string[], env: Record<string, string | undefined>) =>
    spawnSync(process.execPath, ['scripts/import-cli.mjs', ...args], { cwd: process.cwd(), env: { PATH: process.env.PATH, ...env } as any, encoding: 'utf8' });
  it('prints the report, never the password, and exits 0 for a clean dry run, 1 for a refused batch, 2 for a missing setting', async () => {
    const { db, c } = await shop();
    const dir = mkdtempSync(path.join(tmpdir(), 'jv-import-'));
    dirs.push(dir);
    const file = path.join(dir, 'pack.json');
    const p = pack();
    writeFileSync(file, JSON.stringify(p));
    const env = { DB_HOST: HOST, DB_PORT: String(PORT), DB_NAME: db, DB_USER: 'jv_app', DB_PASSWORD: 'spike_app_only' };
    const dry = run(['--pack', file, '--dry-run'], env);
    expect(dry.status, dry.stderr).toBe(0);
    expect(dry.stdout).toContain('DRY RUN');
    expect(dry.stdout).toContain(p.batch);
    expect(dry.stdout + dry.stderr).not.toContain('spike_app_only');
    expect(await count(c, 'customers')).toBe(1);
    const real = run(['--pack', file], env);
    expect(real.status, real.stderr).toBe(0);
    expect(real.stdout).not.toContain('DRY RUN');
    expect(await count(c, 'customers')).toBe(5);
    const again = run(['--pack', file], env);
    expect(again.status).toBe(1);
    expect(again.stderr).toMatch(/already/);
    const missing = run(['--pack', file], { ...env, DB_PASSWORD: undefined });
    expect(missing.status).toBe(2);
    expect(missing.stderr).toContain('DB_PASSWORD');
    const noPack = run([], env);
    expect(noPack.status).toBe(2);
    const seeded = run(['--seed-counters'], env);
    expect(seeded.status, seeded.stderr).toBe(0);
    await c.end();
  }, 60000);
});
