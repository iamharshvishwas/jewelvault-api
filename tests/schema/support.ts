import { randomBytes, randomUUID } from 'node:crypto';
import mysql, { type Connection } from 'mysql2/promise';
import { APP_USER, HOST, PORT, appConn, freshDb } from '../helpers';
import { migrate } from '../../scripts/migrate.mjs';

export const uuid = () => randomUUID();
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
