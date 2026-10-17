import type { Connection, RowDataPacket } from 'mysql2/promise';

// The catalogue test of A7 (T-D11): the shape of the whole schema, read from information_schema of the database the connection is in. It replaces the Supabase advisor (MariaDB has none).
//
// The expected lists below are written out from the spec, NOT read from the database: a list taken from the schema it checks could never disagree with it.

/** D8, D13 and S4 (and the bills, lines, pieces, allocations and rates they cap): the CHECKs that must exist by name. A missing one lets a bad row in. More are welcome (T-F02 reads every cap); fewer are not. */
export const NAMED_CHECKS: readonly string[] = [
  // D8: piece status is one of the ten, Sold means a bill, Archived means a date
  'skus.chk_skus_status',
  'skus.chk_skus_sold',
  'skus.chk_skus_archived',
  // D13: the receipt's kind decides the other columns; status and void columns agree; the opening flag; the caps
  'receipts.chk_receipts_kind',
  'receipts.chk_receipts_status',
  'receipts.chk_receipts_void',
  'receipts.chk_receipts_opening',
  'receipts.chk_receipts_caps',
  // S4: weights, rates, amounts, quantities, lines and counts have caps and signs
  'skus.chk_skus_weights',
  'skus.chk_skus_rates',
  'skus.chk_skus_piroi',
  'skus.chk_skus_counts',
  'sku_private.chk_sku_private_weight',
  'daily_rates.chk_daily_rates_rate',
  'bills.chk_bills_amounts',
  'bills.chk_bills_round_off',
  'bills.chk_bills_fine',
  'bills.chk_bills_gst',
  'bill_items.chk_bill_items_line',
  'bill_items.chk_bill_items_quantity',
  'bill_items.chk_bill_items_weights',
  'bill_items.chk_bill_items_rates',
  'bill_items.chk_bill_items_amounts',
  'bill_items.chk_bill_items_total',
  'bill_items.chk_bill_items_tax_rate',
  'receipt_allocations.chk_allocations_caps',
  'receipt_allocations.chk_allocations_one_kind',
  'design_photos.chk_design_photos_size',
  'sys_photo_copies.chk_photo_copies_size',
];

/** Money (DECIMAL(14,2)), rates (DECIMAL(12,2)), weights (DECIMAL(12,3)) and percentages (DECIMAL(5,2)): S3, D3 to D13. Every column that carries one of them, with its exact type. */
export const DECIMAL_COLUMNS: Readonly<Record<string, string>> = Object.fromEntries([
  ...['subtotal', 'discount', 'additional_charges', 'gst_amount', 'grand_total', 'round_off'].map((c) => [`bills.${c}`, 'decimal(14,2)']),
  ['bills.gst_percent', 'decimal(5,2)'],
  ['bills.fine_weight_due', 'decimal(12,3)'],
  ...['labour_amount', 'metal_amount', 'other_charges', 'item_total', 'tax_amount'].map((c) => [`bill_items.${c}`, 'decimal(14,2)']),
  ...['metal_rate', 'labour_rate', 'list_metal_rate', 'list_labour_rate', 'piroi'].map((c) => [`bill_items.${c}`, 'decimal(12,2)']),
  ['bill_items.tax_rate', 'decimal(5,2)'],
  ...['gross_weight', 'customer_net_weight', 'fine_weight_due'].map((c) => [`bill_items.${c}`, 'decimal(12,3)']),
  ['daily_rates.rate_per_gram', 'decimal(12,2)'],
  ['receipts.amount', 'decimal(14,2)'],
  ['receipts.silver_rate', 'decimal(12,2)'],
  ['receipts.fine_grams', 'decimal(12,3)'],
  ['receipt_allocations.amount', 'decimal(14,2)'],
  ['receipt_allocations.fine_grams', 'decimal(12,3)'],
  ...['gross_weight', 'customer_net_weight', 'stone_weight', 'kundan_weight'].map((c) => [`skus.${c}`, 'decimal(12,3)']),
  ...['labour_retail', 'labour_semi', 'labour_wholesale', 'piroi'].map((c) => [`skus.${c}`, 'decimal(12,2)']),
  ['sku_private.original_net_weight', 'decimal(12,3)'],
]);

/**
 * A number column whose name says money or weight must be DECIMAL, whatever else it is: a new `amount_paid INT` or `net_weight DOUBLE` is caught by its name. Text columns named after money (a
 * reason, a GST number) and dates (rate_date, paid_on) are not amounts. The exceptions are named with the reason.
 */
const MONEYLIKE = /(amount|total|price|rate|charge|discount|balance|piroi|round_off|weight|grams|labou?r|cash|payment|paid|subtotal|gst|tax)/i;
const NUMERIC = /^(tinyint|smallint|mediumint|int|bigint|float|double|real)$/;
export const MONEYLIKE_EXCEPTIONS: Readonly<Record<string, string>> = {};

/** D19 and the unique keys the other D sections name: table.index (columns). The test fails when the schema has another UNIQUE key or lacks one of these. */
export const UNIQUE_KEYS: readonly string[] = [
  'bills.uq_bills_id_customer(id,customer_id)',
  'bills.uq_bills_no(bill_no)',
  'bills.uq_bills_reissue(reissue_of)',
  'bills.uq_bills_request(request_id)',
  'bill_items.uq_bill_items_line(bill_id,line_no)',
  'bill_items.uq_bill_items_sku(bill_id,sku_id)',
  'categories.uq_categories_name(name)',
  'customers.uq_customers_walkin(walkin_key)',
  'daily_rates.uq_daily_rates_day(rate_date,material,purity)',
  'designs.uq_designs_no(design_no)',
  'receipts.uq_receipts_id_customer(id,customer_id)',
  'sessions.uq_sessions_token(token_hash)',
  'skus.uq_skus_barcode(barcode)',
  'skus.uq_skus_no(sku_no)',
  'subcategories.uq_subcategories_name(category_id,name)',
  'sys_error_log.uq_error_log_slot(code,minute_at,seq)',
  'sys_import_batches.uq_import_batches_name(name)',
  'sys_job_runs.uq_job_runs_day(job,run_date)',
  'users.uq_users_email(email)',
];

/** The tables the screens poll: each has an index on (updated_at, primary key) (C4, D19). */
export const POLLED_TABLES: readonly string[] = ['users', 'settings', 'daily_rates', 'categories', 'subcategories', 'designs', 'skus', 'sku_private', 'customers', 'bills', 'bill_items', 'receipts', 'receipt_allocations'];

/** D19: an index must exist that starts with these columns (a foreign key's own index counts, MariaDB makes one). */
export const INDEXED: readonly (readonly [string, readonly string[]])[] = [
  ['bills', ['customer_id', 'bill_date']],
  ['bill_items', ['bill_id']],
  ['skus', ['design_id']],
  ['skus', ['status']],
  ['receipts', ['customer_id']],
  ['receipt_allocations', ['bill_id']],
  ['receipt_allocations', ['receipt_id']],
  ['receipt_allocations', ['customer_id']],
  ['design_photos', ['design_id']],
  ['audit_log', ['table_name', 'row_id']],
  ['sys_idempotency', ['created_at']],
  ['sessions', ['token_hash']],
  ['sessions', ['user_id']],
  ['sessions', ['expires_at']],
  ['sys_job_runs', ['job', 'run_date']],
  ['sys_photo_copies', ['photo_id', 'kind']],
  ['sys_login_attempts', ['scope', 'slot']],
];

export interface CatalogueFacts {
  tables: { name: string; engine: string | null; collation: string | null }[];
  primaryKeys: Map<string, string[]>;
  columns: { table: string; name: string; dataType: string; columnType: string }[];
  foreignKeys: { table: string; name: string; update: string; delete: string }[];
  checks: Set<string>;
  indexes: { table: string; name: string; unique: boolean; columns: string[] }[];
}

export async function readCatalogue(c: Connection): Promise<CatalogueFacts> {
  const q = async (sql: string) => (await c.query<RowDataPacket[]>(sql))[0];
  const tables = (await q("SELECT TABLE_NAME AS n, ENGINE AS e, TABLE_COLLATION AS c FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME")).map((r) => ({ name: String(r.n), engine: r.e as string | null, collation: r.c as string | null }));
  const stats = await q('SELECT TABLE_NAME AS t, INDEX_NAME AS i, NON_UNIQUE AS nu, COLUMN_NAME AS c FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX');
  const indexes: CatalogueFacts['indexes'] = [];
  const primaryKeys = new Map<string, string[]>();
  for (const r of stats) {
    let idx = indexes.find((x) => x.table === r.t && x.name === r.i);
    if (!idx) indexes.push((idx = { table: String(r.t), name: String(r.i), unique: Number(r.nu) === 0, columns: [] }));
    idx.columns.push(String(r.c));
    if (r.i === 'PRIMARY') primaryKeys.set(String(r.t), idx.columns);
  }
  const columns = (await q('SELECT TABLE_NAME AS t, COLUMN_NAME AS c, DATA_TYPE AS d, COLUMN_TYPE AS ct FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME, ORDINAL_POSITION')).map((r) => ({
    table: String(r.t),
    name: String(r.c),
    dataType: String(r.d).toLowerCase(),
    columnType: String(r.ct).toLowerCase(),
  }));
  const foreignKeys = (await q('SELECT TABLE_NAME AS t, CONSTRAINT_NAME AS n, UPDATE_RULE AS u, DELETE_RULE AS d FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() ORDER BY TABLE_NAME, CONSTRAINT_NAME')).map((r) => ({
    table: String(r.t),
    name: String(r.n),
    update: String(r.u),
    delete: String(r.d),
  }));
  const checks = new Set((await q('SELECT TABLE_NAME AS t, CONSTRAINT_NAME AS n FROM information_schema.CHECK_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE()')).map((r) => `${r.t}.${r.n}`));
  return { tables, primaryKeys, columns, foreignKeys, checks, indexes };
}

export interface CatalogueExpectations {
  /** the base tables the schema must have; null skips the check of the table list (a scratch schema in a control) */
  checks?: readonly string[];
  decimalColumns?: Readonly<Record<string, string>>;
  uniqueKeys?: readonly string[] | null;
  polled?: readonly string[];
  indexed?: readonly (readonly [string, readonly string[]])[];
}

/** Every problem the catalogue has against A7. An empty list means the schema passes. */
export function catalogueProblems(f: CatalogueFacts, expect: CatalogueExpectations = {}): string[] {
  const problems: string[] = [];
  for (const t of f.tables) {
    if (!f.primaryKeys.has(t.name)) problems.push(`${t.name}: no primary key`);
    if (t.engine !== 'InnoDB') problems.push(`${t.name}: engine is ${t.engine}, not InnoDB`);
    if (t.collation !== 'utf8mb4_unicode_ci') problems.push(`${t.name}: collation is ${t.collation}, not utf8mb4_unicode_ci`);
  }
  for (const col of f.columns) {
    if (['float', 'double', 'real'].includes(col.dataType)) problems.push(`${col.table}.${col.name}: ${col.columnType} (no FLOAT, DOUBLE or REAL column may exist, S3)`);
  }
  const typeOf = new Map(f.columns.map((c) => [`${c.table}.${c.name}`, c.columnType]));
  for (const [column, type] of Object.entries(expect.decimalColumns ?? DECIMAL_COLUMNS)) {
    const actual = typeOf.get(column);
    if (!actual) problems.push(`${column}: the column is missing (expected ${type})`);
    else if (actual !== type) problems.push(`${column}: ${actual}, expected ${type} (money, rates and weights are DECIMAL, S3)`);
  }
  for (const col of f.columns) {
    const key = `${col.table}.${col.name}`;
    if (MONEYLIKE.test(col.name) && NUMERIC.test(col.dataType) && !(key in MONEYLIKE_EXCEPTIONS)) {
      problems.push(`${key}: ${col.columnType} has a money-like name and is not DECIMAL (if it is not money, add it to MONEYLIKE_EXCEPTIONS with the reason)`);
    }
  }
  for (const fk of f.foreignKeys) {
    if (fk.update !== 'RESTRICT' || fk.delete !== 'RESTRICT') problems.push(`${fk.table}.${fk.name}: ON UPDATE ${fk.update} ON DELETE ${fk.delete}; every foreign key is RESTRICT (D19, S7)`);
  }
  for (const name of expect.checks ?? NAMED_CHECKS) if (!f.checks.has(name)) problems.push(`${name}: the named CHECK is missing (D8, D13, S4)`);
  if (expect.uniqueKeys !== null) {
    const actual = f.indexes.filter((i) => i.unique && i.name !== 'PRIMARY').map((i) => `${i.table}.${i.name}(${i.columns.join(',')})`).sort();
    const want = [...(expect.uniqueKeys ?? UNIQUE_KEYS)].sort();
    for (const k of actual) if (!want.includes(k)) problems.push(`${k}: a UNIQUE key that is not on the expected list (D19)`);
    for (const k of want) if (!actual.includes(k)) problems.push(`${k}: a UNIQUE key of the expected list is missing (D19)`);
  }
  for (const table of expect.polled ?? POLLED_TABLES) {
    const pk = f.primaryKeys.get(table) ?? [];
    const want = ['updated_at', ...pk];
    if (!f.indexes.some((i) => i.table === table && i.columns.join(',') === want.join(','))) problems.push(`${table}: no index on (${want.join(', ')}) for the poll (C4, D19)`);
  }
  for (const [table, cols] of expect.indexed ?? INDEXED) {
    const has = f.indexes.some((i) => i.table === table && cols.every((c, n) => i.columns[n] === c));
    if (!has) problems.push(`${table}: no index starting with (${cols.join(', ')}) (D19)`);
  }
  return problems;
}
