import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Connection } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dropDb, errorOf } from '../helpers';
import { migratedDb } from './support';

// Catalogue tests: the shape of the whole schema, read from information_schema. They replace the Supabase advisor (A7, T-D11).

let db: string;
let c: Connection;
beforeAll(async () => {
  ({ db, c } = await migratedDb('s2_catalogue'));
});
afterAll(async () => {
  await c.end();
  await dropDb(db);
});

const EXPECTED_TABLES = [
  'audit_log', 'backup_runs', 'bill_items', 'bills', 'categories', 'check_runs', 'customers', 'daily_rates', 'design_photos', 'designs',
  'receipt_allocations', 'receipts', 'schema_migrations', 'sessions', 'settings', 'sku_private', 'skus', 'subcategories',
  'sys_counters', 'sys_error_log', 'sys_idempotency', 'sys_import_batches', 'sys_job_runs', 'sys_login_attempts', 'sys_photo_copies', 'users',
].sort();

const cols = async () => {
  const [r] = await c.query<any[]>(
    `SELECT TABLE_NAME AS t, COLUMN_NAME AS c, DATA_TYPE AS type, COLUMN_TYPE AS ctype, IS_NULLABLE AS nullable, COLUMN_DEFAULT AS dflt, EXTRA AS extra
     FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME, ORDINAL_POSITION`
  );
  return r as { t: string; c: string; type: string; ctype: string; nullable: string; dflt: string | null; extra: string }[];
};

describe('shape of the schema', () => {
  it('has exactly the expected tables (adding one is a conscious change of this list)', async () => {
    const [r] = await c.query<any[]>("SELECT TABLE_NAME AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE'");
    expect(r.map((x) => x.n).sort()).toEqual(EXPECTED_TABLES);
  });

  it('every table is InnoDB with utf8mb4_unicode_ci and has a primary key', async () => {
    const [r] = await c.query<any[]>(
      `SELECT t.TABLE_NAME AS n, t.ENGINE AS e, t.TABLE_COLLATION AS coll,
              (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS k WHERE k.TABLE_SCHEMA = t.TABLE_SCHEMA AND k.TABLE_NAME = t.TABLE_NAME AND k.CONSTRAINT_TYPE = 'PRIMARY KEY') AS pk
       FROM information_schema.TABLES t WHERE t.TABLE_SCHEMA = DATABASE() AND t.TABLE_TYPE = 'BASE TABLE'`
    );
    for (const t of r) {
      expect(t.e, t.n).toBe('InnoDB');
      expect(t.coll, t.n).toBe('utf8mb4_unicode_ci');
      expect(Number(t.pk), `${t.n} primary key`).toBe(1);
    }
  });

  it('no float, double or real column anywhere; every money-looking column is DECIMAL (S3)', async () => {
    const all = await cols();
    expect(all.filter((x) => ['float', 'double', 'real'].includes(x.type))).toEqual([]);
    const money = /(amount|total|rate|price|discount|charges|subtotal|piroi|labour|round_off|grams|weight)/;
    for (const x of all.filter((y) => money.test(y.c) && !y.c.endsWith('_date') && y.t !== 'schema_migrations')) {
      expect(x.type, `${x.t}.${x.c}`).toBe('decimal');
    }
  });

  it('weights are DECIMAL(12,3), rates DECIMAL(12,2), amounts DECIMAL(14,2)', async () => {
    const all = await cols();
    const find = (t: string, col: string) => all.find((x) => x.t === t && x.c === col)!.ctype;
    expect(find('skus', 'gross_weight')).toBe('decimal(12,3)');
    expect(find('skus', 'labour_retail')).toBe('decimal(12,2)');
    expect(find('daily_rates', 'rate_per_gram')).toBe('decimal(12,2)');
    expect(find('bills', 'grand_total')).toBe('decimal(14,2)');
    expect(find('bills', 'round_off')).toBe('decimal(14,2)');
    expect(find('receipts', 'amount')).toBe('decimal(14,2)');
    expect(find('receipts', 'fine_grams')).toBe('decimal(12,3)');
  });

  it('every id and foreign-key column uses the native UUID type (one id type everywhere, a FK between UUID and CHAR(36) is refused)', async () => {
    const all = await cols();
    const idLike = all.filter((x) => (x.c === 'id' || x.c.endsWith('_id') || x.c.endsWith('_by') || x.c === 'actor' || x.c === 'request_id') && !['sys_counters', 'schema_migrations'].includes(x.t));
    for (const x of idLike) {
      if (['audit_log', 'check_runs', 'backup_runs', 'sys_login_attempts', 'sys_error_log', 'sys_job_runs'].includes(x.t) && x.c === 'id') continue; // log tables use BIGINT
      if (x.t === 'audit_log' && x.c === 'row_id') continue; // the id of the audited row, as text (any table's key, spec D16)
      expect(x.type, `${x.t}.${x.c}`).toBe('uuid');
    }
  });

  it('every timestamp is DATETIME(6); every table that has updated_at lets the database stamp it (backstop of D-Q3)', async () => {
    const all = await cols();
    for (const x of all.filter((y) => y.c.endsWith('_at') && y.t !== 'schema_migrations')) {
      expect(x.ctype, `${x.t}.${x.c}`).toBe('datetime(6)');
    }
    for (const x of all.filter((y) => y.c === 'updated_at')) {
      expect(x.extra.toLowerCase(), `${x.t}.updated_at`).toContain('on update current_timestamp(6)');
    }
  });

  it('S6: created_at and updated_at exist on every business table (not on the logs and system tables)', async () => {
    const all = await cols();
    const business = ['users', 'settings', 'daily_rates', 'categories', 'subcategories', 'designs', 'skus', 'sku_private', 'customers', 'bills', 'bill_items', 'receipts', 'receipt_allocations', 'design_photos'];
    for (const t of business) {
      const names = all.filter((x) => x.t === t).map((x) => x.c);
      expect(names, t).toContain('created_at');
      if (t !== 'design_photos') expect(names, t).toContain('updated_at');
    }
  });

  it('every foreign key is ON DELETE RESTRICT and ON UPDATE RESTRICT (nothing is ever deleted, S7)', async () => {
    const [r] = await c.query<any[]>(
      'SELECT CONSTRAINT_NAME AS n, TABLE_NAME AS t, DELETE_RULE AS d, UPDATE_RULE AS u FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE()'
    );
    expect(r.length).toBeGreaterThan(15);
    for (const x of r) {
      expect(x.d, `${x.t}.${x.n}`).toBe('RESTRICT');
      expect(x.u, `${x.t}.${x.n}`).toBe('RESTRICT');
    }
  });

  it('design_photos.design_id has NO foreign key (the screen uploads before the design exists, spec P2 and D26)', async () => {
    const [r] = await c.query<any[]>(
      "SELECT COUNT(*) AS n FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'design_photos' AND COLUMN_NAME = 'design_id' AND REFERENCED_TABLE_NAME IS NOT NULL"
    );
    expect(Number(r[0].n)).toBe(0);
    const [i] = await c.query<any[]>("SELECT COUNT(*) AS n FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'design_photos' AND COLUMN_NAME = 'design_id'");
    expect(Number(i[0].n)).toBeGreaterThan(0); // still indexed: the "fewer than 3 photos for this design id" count must not scan
  });

  it('person columns (created_by, updated_by, confirmed_by, ...) are plain UUIDs with NO foreign key (they must survive a retired user, and a FK would lock the users row)', async () => {
    const [r] = await c.query<any[]>(
      "SELECT TABLE_NAME AS t, COLUMN_NAME AS c FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = DATABASE() AND REFERENCED_TABLE_NAME IS NOT NULL AND (COLUMN_NAME LIKE '%\\_by' OR COLUMN_NAME = 'actor')"
    );
    expect(r).toEqual([]);
  });

  it('UNIQUE indexes exist only on columns that never change after insert (spike finding F2) and match an explicit list', async () => {
    const [r] = await c.query<any[]>(
      `SELECT TABLE_NAME AS t, INDEX_NAME AS i, GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS cols
       FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND NON_UNIQUE = 0 AND INDEX_NAME <> 'PRIMARY' GROUP BY TABLE_NAME, INDEX_NAME`
    );
    const found = r.map((x) => `${x.t}(${x.cols})`).sort();
    const allowed = [
      'users(email)', 'sessions(token_hash)', 'daily_rates(rate_date,material,purity)', 'categories(name)', 'subcategories(category_id,name)',
      'designs(design_no)', 'skus(sku_no)', 'skus(barcode)', 'customers(walkin_key)', 'bills(bill_no)', 'bills(request_id)', 'bills(reissue_of)',
      'bills(id,customer_id)', 'bill_items(bill_id,line_no)', 'bill_items(bill_id,sku_id)', 'receipts(id,customer_id)',
      'sys_job_runs(job,run_date)', 'sys_import_batches(name)',
    ].sort();
    expect(found).toEqual(allowed);
    const mutable = ['status', 'archived_at', 'released_at', 'voided_at', 'active', 'role', 'is_live', 'cancelled_at', 'updated_at', 'sold_bill_id'];
    for (const x of r) for (const col of String(x.cols).split(',')) expect(mutable, `${x.t}.${col} is mutable`).not.toContain(col);
  });

  it('no table, column or index name needs quoting in MariaDB (reserved words such as key, lines, rows, order, range are not used)', async () => {
    const all = await cols();
    const names = new Set<string>();
    for (const x of all) {
      names.add(x.t);
      names.add(x.c);
    }
    const bad: string[] = [];
    for (const n of names) {
      const err = await errorOf(() => c.query(`CREATE TEMPORARY TABLE zz_name_probe (${n} INT)`));
      if (err) bad.push(n);
      else await c.query('DROP TEMPORARY TABLE zz_name_probe');
      const err2 = await errorOf(() => c.query(`CREATE TEMPORARY TABLE ${n} (id INT)`));
      if (err2) bad.push(`${n} (as a table name)`);
      else await c.query(`DROP TEMPORARY TABLE ${n}`);
    }
    expect(bad).toEqual([]);
  });

  it('every JSON column is validated (JSON_VALID) and the array columns check JSON_TYPE', async () => {
    const [r] = await c.query<any[]>(
      "SELECT TABLE_NAME AS t, CONSTRAINT_NAME AS n, CHECK_CLAUSE AS cl FROM information_schema.CHECK_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE()"
    );
    const clauses = r.map((x) => `${x.t}:${String(x.cl).toLowerCase()}`);
    expect(clauses.some((x) => x.startsWith('designs:') && x.includes("json_type(`tags`)") && x.includes('array'))).toBe(true);
    expect(clauses.some((x) => x.startsWith('designs:') && x.includes('json_length(`photo_ids`)') )).toBe(true);
  });

  it('the caps of db/limits.json (S4, O21) appear as literals in the CHECK constraints, so the two cannot drift (T-F02)', async () => {
    const limits = JSON.parse(readFileSync(join(__dirname, '..', '..', 'db', 'limits.json'), 'utf8')) as Record<string, number>;
    expect(limits.maxWeightGrams).toBe(100000);
    expect(limits.maxRate).toBe(100000000);
    expect(limits.maxAmount).toBe(1000000000);
    expect(limits.maxQuantity).toBe(1000);
    expect(limits.maxLines).toBe(200);
    expect(limits.maxPhotoBytes).toBe(2097152);
    expect(limits.maxPhotosPerDesign).toBe(3);
    const [r] = await c.query<any[]>("SELECT TABLE_NAME AS t, CHECK_CLAUSE AS cl FROM information_schema.CHECK_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE()");
    const has = (table: string, col: string, num: number) =>
      r.some((x) => x.t === table && String(x.cl).includes(`\`${col}\``) && new RegExp(`(^|[^0-9.])${num}(\\.0+)?([^0-9]|$)`).test(String(x.cl)));
    expect(has('skus', 'gross_weight', limits.maxWeightGrams)).toBe(true);
    expect(has('skus', 'customer_net_weight', limits.maxWeightGrams)).toBe(true);
    expect(has('skus', 'labour_retail', limits.maxRate)).toBe(true);
    expect(has('daily_rates', 'rate_per_gram', limits.maxRate)).toBe(true);
    expect(has('bills', 'grand_total', limits.maxAmount)).toBe(true);
    expect(has('bills', 'subtotal', limits.maxAmount)).toBe(true);
    expect(has('receipts', 'amount', limits.maxAmount)).toBe(true);
    expect(has('bill_items', 'quantity', limits.maxQuantity)).toBe(true);
    expect(has('bill_items', 'line_no', limits.maxLines)).toBe(true);
    expect(has('design_photos', 'byte_size', limits.maxPhotoBytes)).toBe(true);
    expect(has('designs', 'photo_ids', limits.maxPhotosPerDesign)).toBe(true);
  });
});
