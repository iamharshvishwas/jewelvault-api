import { randomBytes, randomUUID } from 'node:crypto';
import mysql, { type Connection } from 'mysql2/promise';
import { APP_USER, HOST, PORT, appConn, freshDb } from '../helpers';
import { migrate } from '../../scripts/migrate.mjs';
import { loadQueries } from '../../scripts/queries.mjs';

export const uuid = () => randomUUID();

/** The derived reads V1 to V4 as SQL text (db/queries), and as tables to put after FROM: `SELECT * FROM ${T.customer_balances} WHERE id = ?`. They are queries, not views (section 11). */
export const Q = loadQueries();
export const T = {
  bill_summary: `(${Q.V1}) bill_summary`,
  customer_balances: `(${Q.V2}) customer_balances`,
  customer_ledger: `(${Q.V3}) customer_ledger`,
  daily_totals: `(${Q.V4}) daily_totals`,
};
export const u = () => Math.random().toString(36).slice(2, 10);

/** A connection with multipleStatements, which the migration runner needs (one file = one query). The API never uses this. */
export async function migrationConn(db: string): Promise<Connection> {
  return mysql.createConnection({
    host: HOST, port: PORT, user: APP_USER, password: 'spike_app_only', database: db,
    multipleStatements: true, decimalNumbers: false, supportBigNumbers: true, bigNumberStrings: true, dateStrings: true,
  });
}

/** A fresh database with every migration and every seed applied; returns an ordinary application connection. */
export async function migratedDb(name: string, opts: { seeds?: boolean; optional?: boolean } = {}) {
  const db = await freshDb(name);
  const m = await migrationConn(db);
  await migrate(m, { seeds: opts.seeds ?? true, optional: opts.optional ?? false });
  await m.end();
  const c = await appConn(db);
  return { db, c };
}

/** INSERT from an object. Objects and arrays become JSON text; Buffers stay Buffers; undefined is skipped. */
export async function insert(c: Connection, table: string, row: Record<string, unknown>) {
  const entries = Object.entries(row).filter(([, v]) => v !== undefined);
  const values = entries.map(([, v]) => (v !== null && typeof v === 'object' && !Buffer.isBuffer(v) ? JSON.stringify(v) : v));
  const sql = `INSERT INTO \`${table}\` (${entries.map(([k]) => `\`${k}\``).join(', ')}) VALUES (${entries.map(() => '?').join(', ')})`;
  await c.query(sql, values as any[]);
  return row;
}

export const V = {
  user: (o: Record<string, unknown> = {}) => ({ id: uuid(), email: `${u()}@example.test`, full_name: 'Test User', role: 'staff', active: 0, password_hash: 'h'.repeat(60), ...o }),
  session: (user_id: string, o: Record<string, unknown> = {}) => ({ id: uuid(), user_id, token_hash: randomBytes(32), expires_at: '2030-01-01 00:00:00.000000', ...o }),
  dailyRate: (o: Record<string, unknown> = {}) => ({ id: uuid(), material: 'Gold', purity: '22K', rate_per_gram: '6920.00', rate_date: '2026-10-15', ...o }),
  category: (o: Record<string, unknown> = {}) => ({ id: uuid(), name: `Cat ${u()}`, prefix: 'CAT', active: 1, ...o }),
  subcategory: (category_id: string, o: Record<string, unknown> = {}) => ({ id: uuid(), category_id, name: `Sub ${u()}`, active: 1, ...o }),
  design: (category_id: string, o: Record<string, unknown> = {}) => ({
    id: uuid(), design_no: `D-${u()}`, name: 'Test design', category_id, material: 'Gold', purity: '22K', selling_method: 'By Weight', tags: ['bridal'], photo_ids: [], ...o,
  }),
  sku: (design_id: string, o: Record<string, unknown> = {}) => ({
    id: uuid(), design_id, sku_no: `S-${u()}`, barcode: `BC-${u()}`, gross_weight: '12.500', customer_net_weight: '11.000', status: 'In Stock', ...o,
  }),
  skuPrivate: (sku_id: string, o: Record<string, unknown> = {}) => ({ sku_id, original_net_weight: '10.500', ...o }),
  customer: (o: Record<string, unknown> = {}) => ({ id: uuid(), name: 'Test Customer', mobile: '9876543210', customer_type: 'Retail', is_walkin: 0, ...o }),
  bill: (customer_id: string, o: Record<string, unknown> = {}) => ({
    id: uuid(), bill_no: `JV-2026-${u()}`, customer_id, bill_date: '2026-10-15', doc_type: 'estimate', sale_type: 'Retail', status: 'active',
    pricing_version: 1, subtotal: '1000.00', discount: '0.00', additional_charges: '0.00', gst_percent: '0.00', gst_amount: '0.00', grand_total: '1000.00',
    round_off: '0.00', fine_weight_due: '0.000', request_id: uuid(), ...o,
  }),
  billItem: (bill_id: string, sku_id: string, o: Record<string, unknown> = {}) => ({
    id: uuid(), bill_id, line_no: 1, sku_id, design_no: 'D-1', sku_no: 'S-1', category: 'Ring', material: 'Gold', purity: '22K', selling_method: 'By Weight',
    gross_weight: '12.500', customer_net_weight: '11.000', quantity: 1, metal_rate: '100.00', labour_rate: '10.00', labour_amount: '110.00', piroi: '0.00',
    other_charges: '0.00', metal_amount: '1100.00', fine_weight_due: '0.000', item_total: '1210.00', tax_rate: '0.00', tax_amount: '0.00',
    list_metal_rate: '100.00', list_labour_rate: '10.00', ...o,
  }),
  receipt: (customer_id: string, o: Record<string, unknown> = {}) => ({
    id: uuid(), customer_id, kind: 'money', mode: 'Cash', amount: '100.00', fine_grams: '0.000', paid_on: '2026-10-15', is_opening: 0, status: 'active', ...o,
  }),
  allocation: (receipt_id: string, bill_id: string, customer_id: string, o: Record<string, unknown> = {}) => ({
    id: uuid(), receipt_id, bill_id, customer_id, amount: '100.00', fine_grams: '0.000', ...o,
  }),
};

/** One valid chain of rows: category, design, piece, customer, bill, line, receipt, allocation. */
export async function world(c: Connection) {
  const [cats] = await c.query<any[]>('SELECT id FROM categories ORDER BY name LIMIT 1');
  const categoryId: string = cats[0].id;
  const customer = await insert(c, 'customers', V.customer()) as { id: string };
  const design = await insert(c, 'designs', V.design(categoryId)) as { id: string };
  const bill = await insert(c, 'bills', V.bill(customer.id)) as { id: string };
  const sku = await insert(c, 'skus', V.sku(design.id)) as { id: string };
  const item = await insert(c, 'bill_items', V.billItem(bill.id, sku.id)) as { id: string };
  const receipt = await insert(c, 'receipts', V.receipt(customer.id)) as { id: string };
  const allocation = await insert(c, 'receipt_allocations', V.allocation(receipt.id, bill.id, customer.id)) as { id: string };
  return { categoryId, customer, design, bill, sku, item, receipt, allocation };
}

/**
 * The fixed data set of the views tests (spec T-B15): one customer with every kind of event, a second customer with none.
 * All timestamps are UTC; the figures in s9-views.test.ts were worked out by hand from this list.
 */
export async function ledgerWorld(c: Connection) {
  const [cats] = await c.query<any[]>('SELECT id FROM categories ORDER BY name LIMIT 1');
  const design = (await insert(c, 'designs', V.design(cats[0].id))) as { id: string };
  const c1 = (await insert(c, 'customers', V.customer({ name: 'Ledger Customer' }))) as { id: string };
  const c2 = (await insert(c, 'customers', V.customer({ name: 'Empty Customer', mobile: '9123456780' }))) as { id: string };
  const skus: string[] = [];
  for (let i = 0; i < 4; i++) skus.push(((await insert(c, 'skus', V.sku(design.id))) as { id: string }).id);
  const cancelled = { status: 'cancelled', cancel_reason: 'wrong customer', cancelled_at: '2026-10-04 09:00:00.000000', cancelled_on: '2026-10-04', cancelled_by: uuid() };
  const ob = (await insert(c, 'bills', V.bill(c1.id, { bill_no: 'OB-0001', doc_type: 'opening_balance', bill_date: '2026-09-30', subtotal: '0.00', grand_total: '300.50', fine_weight_due: '2.000', request_id: null, created_at: '2026-09-30 05:00:00.000000' }))) as { id: string };
  const b1 = (await insert(c, 'bills', V.bill(c1.id, { bill_no: 'JV-2026-0001', bill_date: '2026-10-01', subtotal: '1000.00', grand_total: '1000.00', created_at: '2026-10-01 05:00:00.000000' }))) as { id: string };
  const b3 = (await insert(c, 'bills', V.bill(c1.id, { bill_no: 'JV-2026-0002', bill_date: '2026-10-03', subtotal: '500.00', grand_total: '500.00', created_at: '2026-10-03 05:00:00.000000', ...cancelled }))) as { id: string };
  const b2 = (await insert(c, 'bills', V.bill(c1.id, { bill_no: 'JV-2026-0003', bill_date: '2026-10-05', sale_type: 'Wholesale', subtotal: '2000.00', grand_total: '2000.00', fine_weight_due: '10.000', created_at: '2026-10-05 05:00:00.000000' }))) as { id: string };
  await insert(c, 'bill_items', V.billItem(b1.id, skus[0], { line_no: 1 }));
  await insert(c, 'bill_items', V.billItem(b1.id, skus[1], { line_no: 2 }));
  await insert(c, 'bill_items', V.billItem(b2.id, skus[2], { line_no: 1 }));
  await insert(c, 'bill_items', V.billItem(b3.id, skus[3], { line_no: 1 }));
  const rc = async (o: Record<string, unknown>) => (await insert(c, 'receipts', V.receipt(c1.id, o))) as { id: string };
  /** `on` is the Indian business day of the void (D13): the API takes it from its Asia/Kolkata clock, so a void at 20:00 UTC is already the next day. */
  const voided = (at: string, on: string) => ({ status: 'voided', void_reason: 'entered twice', voided_at: at, voided_on: on, voided_by: uuid() });
  const r1 = await rc({ amount: '400.00', mode: 'Cash', paid_on: '2026-10-02', created_at: '2026-10-02 06:00:00.000000' });
  const r9 = await rc({ amount: '100.00', mode: 'Cash', paid_on: '2026-10-03', created_at: '2026-10-03 06:00:00.000000' });
  const r2 = await rc({ amount: '600.00', mode: 'UPI', paid_on: '2026-10-06', created_at: '2026-10-06 06:00:00.000000' });
  const r3 = await rc({ kind: 'fine_silver', mode: null, amount: '0.00', fine_grams: '4.000', paid_on: '2026-10-07', created_at: '2026-10-07 06:00:00.000000' });
  const r4 = await rc({ kind: 'fine_cash', mode: 'Cash', amount: '270.00', fine_grams: '3.000', silver_rate: '90.00', paid_on: '2026-10-08', created_at: '2026-10-08 06:00:00.000000' });
  const r5 = await rc({ amount: '150.00', mode: 'Cash', paid_on: '2026-10-09', created_at: '2026-10-09 06:00:00.000000', ...voided('2026-10-10 10:00:00.000000', '2026-10-10') });
  const r6 = await rc({ kind: 'refund', amount: '50.00', mode: 'Cash', paid_on: '2026-10-11', created_at: '2026-10-11 06:00:00.000000' });
  const r7 = await rc({ kind: 'refund', amount: '25.00', mode: 'UPI', paid_on: '2026-10-12', created_at: '2026-10-12 06:00:00.000000', ...voided('2026-10-12 20:00:00.000000', '2026-10-13') });
  const r8 = await rc({ amount: '100.00', mode: 'Other', is_opening: 1, paid_on: '2026-09-30', created_at: '2026-09-30 06:00:00.000000' });
  const al = async (receipt: { id: string }, bill: { id: string }, o: Record<string, unknown>) => insert(c, 'receipt_allocations', V.allocation(receipt.id, bill.id, c1.id, o));
  await al(r1, ob, { amount: '300.50' });
  await al(r1, b1, { amount: '99.50' });
  await al(r2, b1, { amount: '600.00' });
  await al(r3, ob, { amount: '0.00', fine_grams: '2.000' });
  await al(r3, b2, { amount: '0.00', fine_grams: '2.000' });
  await al(r4, b2, { amount: '0.00', fine_grams: '3.000' });
  await al(r9, b3, { amount: '100.00', released_at: '2026-10-04 09:00:00.000000' }); // the bill was cancelled: released, the money stays as an advance
  await al(r5, b2, { amount: '50.00' }); // R5 was voided: this allocation must NOT count although it was never released
  return { c1, c2, ob, b1, b2, b3, r: { r1, r2, r3, r4, r5, r6, r7, r8, r9 }, skus };
}

/**
 * A consistent data set for the invariants tests: every figure agrees, so runInvariants() must return nothing.
 * Customer A: a sold bill, a cancelled bill, opening dues with silver, money, silver, an opening advance, a voided receipt.
 * Customer D: fully paid with an advance, a refund and a voided refund. The walk-in: a paid bill.
 */
export async function cleanWorld(c: Connection) {
  const [cats] = await c.query<any[]>('SELECT id FROM categories ORDER BY name LIMIT 1');
  const design = (await insert(c, 'designs', V.design(cats[0].id))) as { id: string };
  const a = (await insert(c, 'customers', V.customer({ name: 'Customer A' }))) as { id: string };
  const d = (await insert(c, 'customers', V.customer({ name: 'Customer D', mobile: '9123456780' }))) as { id: string };
  const walkin = '00000000-0000-4000-8000-000000000001';
  const line = (billId: string, skuId: string, no: number, metal: string, labour: string, total: string) =>
    insert(c, 'bill_items', V.billItem(billId, skuId, { line_no: no, metal_amount: metal, labour_amount: labour, item_total: total }));
  const sku = async (o: Record<string, unknown> = {}) => (await insert(c, 'skus', V.sku(design.id, o))) as { id: string };
  const bill = async (customer: string, o: Record<string, unknown>) => (await insert(c, 'bills', V.bill(customer, o))) as { id: string };
  const cancelled = { status: 'cancelled', cancel_reason: 'wrong customer', cancelled_at: '2026-10-04 09:00:00.000000', cancelled_on: '2026-10-04', cancelled_by: uuid() };

  const aB1 = await bill(a.id, { bill_no: 'JV-2026-0001', bill_date: '2026-10-01', subtotal: '1000.00', grand_total: '1000.00', created_at: '2026-10-01 05:00:00.000000' });
  const aB2 = await bill(a.id, { bill_no: 'JV-2026-0002', bill_date: '2026-10-03', subtotal: '500.00', grand_total: '500.00', created_at: '2026-10-03 05:00:00.000000', ...cancelled });
  const aOb = await bill(a.id, { bill_no: 'OB-0001', doc_type: 'opening_balance', bill_date: '2026-09-30', subtotal: '0.00', grand_total: '300.50', fine_weight_due: '2.000', request_id: null, created_at: '2026-09-30 05:00:00.000000' });
  const dB1 = await bill(d.id, { bill_no: 'JV-2026-0003', bill_date: '2026-10-05', subtotal: '500.00', grand_total: '500.00', created_at: '2026-10-05 05:00:00.000000' });
  const wB1 = await bill(walkin, { bill_no: 'JV-2026-0004', bill_date: '2026-10-06', subtotal: '250.00', grand_total: '250.00', created_at: '2026-10-06 05:00:00.000000' });
  const s1 = await sku({ status: 'Sold', sold_bill_id: aB1.id });
  const s2 = await sku({ status: 'Sold', sold_bill_id: aB1.id });
  const s3 = await sku(); // was on the cancelled bill, back in stock
  const s4 = await sku({ status: 'Sold', sold_bill_id: dB1.id });
  const s5 = await sku({ status: 'Sold', sold_bill_id: wB1.id });
  await line(aB1.id, s1.id, 1, '500.00', '100.00', '600.00');
  await line(aB1.id, s2.id, 2, '300.00', '100.00', '400.00');
  await line(aB2.id, s3.id, 1, '400.00', '100.00', '500.00');
  await line(dB1.id, s4.id, 1, '400.00', '100.00', '500.00');
  await line(wB1.id, s5.id, 1, '150.00', '100.00', '250.00');

  const rc = async (customer: string, o: Record<string, unknown>) => (await insert(c, 'receipts', V.receipt(customer, o))) as { id: string };
  /** `on` is the Indian business day of the void (D13): the API takes it from its Asia/Kolkata clock, so a void at 20:00 UTC is already the next day. */
  const voided = (at: string, on: string) => ({ status: 'voided', void_reason: 'entered twice', voided_at: at, voided_on: on, voided_by: uuid() });
  const ra1 = await rc(a.id, { amount: '400.00', mode: 'Cash', paid_on: '2026-10-02', created_at: '2026-10-02 06:00:00.000000' });
  const ra2 = await rc(a.id, { amount: '200.00', mode: 'UPI', paid_on: '2026-10-06', created_at: '2026-10-06 06:00:00.000000' });
  const ra3 = await rc(a.id, { kind: 'fine_silver', mode: null, amount: '0.00', fine_grams: '2.000', paid_on: '2026-10-07', created_at: '2026-10-07 06:00:00.000000' });
  const ra4 = await rc(a.id, { amount: '100.00', mode: 'Other', is_opening: 1, paid_on: '2026-09-30', created_at: '2026-09-30 06:00:00.000000' });
  const ra5 = await rc(a.id, { amount: '75.00', mode: 'Cash', paid_on: '2026-10-09', created_at: '2026-10-09 06:00:00.000000', ...voided('2026-10-10 10:00:00.000000', '2026-10-10') });
  const ra6 = await rc(a.id, { amount: '100.00', mode: 'Cash', paid_on: '2026-10-03', created_at: '2026-10-03 06:00:00.000000' });
  const rd1 = await rc(d.id, { amount: '600.00', mode: 'Cash', paid_on: '2026-10-05', created_at: '2026-10-05 06:00:00.000000' });
  const rd2 = await rc(d.id, { kind: 'refund', amount: '50.00', mode: 'Cash', paid_on: '2026-10-11', created_at: '2026-10-11 06:00:00.000000' });
  const rd3 = await rc(d.id, { kind: 'refund', amount: '20.00', mode: 'UPI', paid_on: '2026-10-12', created_at: '2026-10-12 06:00:00.000000', ...voided('2026-10-12 20:00:00.000000', '2026-10-13') });
  const rw1 = await rc(walkin, { amount: '250.00', mode: 'Cash', paid_on: '2026-10-06', created_at: '2026-10-06 06:00:00.000000' });

  const al = async (customer: string, receipt: { id: string }, b: { id: string }, o: Record<string, unknown>) =>
    (await insert(c, 'receipt_allocations', V.allocation(receipt.id, b.id, customer, o))) as { id: string };
  const x = {
    a1: await al(a.id, ra1, aOb, { amount: '300.50' }),
    a2: await al(a.id, ra1, aB1, { amount: '99.50' }),
    a3: await al(a.id, ra2, aB1, { amount: '200.00' }),
    a4: await al(a.id, ra3, aOb, { amount: '0.00', fine_grams: '2.000' }),
    a5: await al(a.id, ra4, aB1, { amount: '100.00' }),
    a6: await al(a.id, ra6, aB2, { amount: '100.00', released_at: '2026-10-04 09:00:00.000000' }), // released when the bill was cancelled
    a7: await al(a.id, ra6, aB1, { amount: '100.00' }), // and the money went on to the next bill
    d1: await al(d.id, rd1, dB1, { amount: '500.00' }),
    w1: await al(walkin, rw1, wB1, { amount: '250.00' }),
  };
  await c.query("INSERT INTO sys_counters (series, last_value, seed_value) VALUES ('bill:JV:2026', 4, 0), ('opening', 1, 0) ON DUPLICATE KEY UPDATE last_value = VALUES(last_value)");
  return { a, d, walkin, design, bills: { aB1, aB2, aOb, dB1, wB1 }, skus: { s1, s2, s3, s4, s5 }, receipts: { ra1, ra2, ra3, ra4, ra5, ra6, rd1, rd2, rd3, rw1 }, allocations: x };
}
