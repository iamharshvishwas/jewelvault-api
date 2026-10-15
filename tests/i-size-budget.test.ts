import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Connection } from 'mysql2/promise';
import { appConn, dropDb, freshDb, rng } from './helpers';
import { auditTriggerSql } from './audit-gen';

// Measurement, not a pass/fail spike: how much of the 3 GB database limit do photos and the business data use?
// Photos: JV_PHOTO_DIR=<folder with full/ and thumb/ JPEGs> (Siddhi's product shots, resized like the screen does: 1200 px q82, 320 px).
//   JV_PHOTO_DIR=/path npx vitest run tests/i-size-budget.test.ts
// Business data: spec volumes of C2 (5,000 pieces, 1,500 designs, 2,000 customers, 3,000 bills), with the audit triggers on.

let db: string;
let c: Connection;
beforeAll(async () => {
  db = await freshDb('i_size');
  c = await appConn(db);
});
afterAll(async () => {
  await c.end();
  await dropDb(db);
});

const sizeOf = async (table: string) => {
  await c.query(`ANALYZE TABLE \`${table}\``);
  const [r] = await c.query<any[]>(
    'SELECT DATA_LENGTH AS d, INDEX_LENGTH AS i, TABLE_ROWS AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?',
    [table]
  );
  return { data: Number(r[0].d), index: Number(r[0].i), rows: Number(r[0].n) };
};

describe.skipIf(!process.env.JV_PHOTO_DIR)('photos in MEDIUMBLOB', () => {
  it('InnoDB bytes per stored photo, measured with real photos', async () => {
    const dir = process.env.JV_PHOTO_DIR as string;
    const load = (sub: string) => readdirSync(join(dir, sub)).filter((f) => f.endsWith('.jpg')).map((f) => readFileSync(join(dir, sub, f)));
    const fulls = load('full');
    const thumbs = load('thumb');
    await c.query(`CREATE TABLE design_photos (
      id UUID NOT NULL PRIMARY KEY, design_id UUID NOT NULL, kind VARCHAR(5) NOT NULL, mime VARCHAR(20) NOT NULL,
      byte_size INT NOT NULL, sha256 CHAR(64) NOT NULL, bytes MEDIUMBLOB NOT NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), KEY ix_photo_design (design_id)
    ) ENGINE=InnoDB`);
    const copies = 60;
    let payload = 0;
    let n = 0;
    for (const set of [fulls, thumbs]) {
      for (let k = 0; k < copies; k++) {
        for (const buf of set) {
          // a different last byte per copy so rows are not byte-identical (InnoDB does not de-duplicate, this is only honest bookkeeping)
          const b = Buffer.from(buf);
          b[b.length - 1] = (k + 1) & 0xff;
          await c.query('INSERT INTO design_photos (id, design_id, kind, mime, byte_size, sha256, bytes) VALUES (?, ?, ?, ?, ?, ?, ?)', [
            randomUUID(), randomUUID(), set === fulls ? 'full' : 'thumb', 'image/jpeg', b.length, 'x'.repeat(64), b,
          ]);
          payload += b.length;
          n++;
        }
      }
    }
    const s = await sizeOf('design_photos');
    const stored = s.data + s.index;
    const avgFull = fulls.reduce((a, b) => a + b.length, 0) / fulls.length;
    const avgThumb = thumbs.reduce((a, b) => a + b.length, 0) / thumbs.length;
    console.log(
      `[i] photos: ${n} rows, payload ${(payload / 1e6).toFixed(1)} MB, InnoDB data+index ${(stored / 1e6).toFixed(1)} MB, overhead ${(((stored - payload) / payload) * 100).toFixed(1)} %, ` +
        `avg full ${(avgFull / 1024).toFixed(0)} KB, avg thumb ${(avgThumb / 1024).toFixed(0)} KB, stored per photo pair ${((stored / n) * 2 / 1024).toFixed(0)} KB`
    );
    expect(stored).toBeGreaterThan(payload); // sanity
    expect(stored / payload).toBeLessThan(1.35);
  }, 120000);
});

describe('business data at the spec volumes (C2) with audit triggers', () => {
  it('bytes per table and the audit log share', async () => {
    const rand = rng(5);
    const words = ['kundan', 'pearl', 'silver', 'gold', 'necklace', 'set', 'bridal', 'antique', 'temple', 'polki', 'ruby', 'emerald'];
    const text = (len: number) => {
      let s = '';
      while (s.length < len) s += words[Math.floor(rand() * words.length)] + ' ';
      return s.slice(0, len).trim();
    };
    const tables: Record<string, { ddl: string; jsonCols?: string[] }> = {
      designs: {
        ddl: `CREATE TABLE designs (id UUID PRIMARY KEY, design_no VARCHAR(64) NOT NULL, name VARCHAR(120), category_id UUID NOT NULL, subcategory_id UUID NULL,
          material VARCHAR(10) NOT NULL, purity VARCHAR(10) NOT NULL, selling_method VARCHAR(12) NOT NULL, description TEXT, notes TEXT NULL, tags JSON NOT NULL,
          primary_image_id UUID NULL, image_ids JSON NOT NULL, archived_at DATETIME(6) NULL, import_batch_id UUID NULL,
          created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
          created_by UUID NULL, updated_by UUID NULL, UNIQUE KEY uq_design_no (design_no), KEY ix_cat (category_id), KEY ix_upd (updated_at, id)) ENGINE=InnoDB`,
        jsonCols: ['tags', 'image_ids'],
      },
      skus: {
        ddl: `CREATE TABLE skus (id UUID PRIMARY KEY, design_id UUID NOT NULL, sku_no VARCHAR(64) NOT NULL, barcode VARCHAR(64) NOT NULL,
          gross_weight DECIMAL(12,3) NOT NULL, customer_net_weight DECIMAL(12,3) NOT NULL, stones INT NOT NULL, stone_weight DECIMAL(12,3) NOT NULL,
          kundan INT NOT NULL, kundan_weight DECIMAL(12,3) NOT NULL, piroi DECIMAL(12,2) NOT NULL, labour_retail DECIMAL(12,2) NOT NULL,
          labour_semi DECIMAL(12,2) NOT NULL, labour_wholesale DECIMAL(12,2) NOT NULL, status VARCHAR(12) NOT NULL, location VARCHAR(40), notes TEXT NULL,
          sold_bill_id UUID NULL, archived_at DATETIME(6) NULL, import_batch_id UUID NULL,
          created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
          created_by UUID NULL, updated_by UUID NULL, UNIQUE KEY uq_sku (sku_no), UNIQUE KEY uq_bc (barcode), KEY ix_design (design_id), KEY ix_status (status), KEY ix_upd (updated_at, id)) ENGINE=InnoDB`,
      },
      customers: {
        ddl: `CREATE TABLE customers (id UUID PRIMARY KEY, name VARCHAR(120) NOT NULL, mobile VARCHAR(20), customer_type VARCHAR(16) NOT NULL, email VARCHAR(120), address VARCHAR(200),
          gst_number VARCHAR(20), pan VARCHAR(10), notes TEXT NULL, is_walkin TINYINT(1) NOT NULL, archived_at DATETIME(6) NULL, import_batch_id UUID NULL,
          created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
          created_by UUID NULL, updated_by UUID NULL, KEY ix_mobile (mobile), KEY ix_upd (updated_at, id)) ENGINE=InnoDB`,
      },
      bills: {
        ddl: `CREATE TABLE bills (id UUID PRIMARY KEY, bill_no VARCHAR(30) NOT NULL, customer_id UUID NOT NULL, bill_date DATE NOT NULL, doc_type VARCHAR(16) NOT NULL,
          sale_type VARCHAR(16) NOT NULL, status VARCHAR(10) NOT NULL, cancel_reason VARCHAR(200) NULL, cancelled_at DATETIME(6) NULL, cancelled_by UUID NULL, reissue_of UUID NULL,
          pricing_version SMALLINT NOT NULL, subtotal DECIMAL(14,2) NOT NULL, discount DECIMAL(14,2) NOT NULL, additional_charges DECIMAL(14,2) NOT NULL,
          gst_percent DECIMAL(5,2) NOT NULL, gst_amount DECIMAL(14,2) NOT NULL, grand_total DECIMAL(14,2) NOT NULL, round_off DECIMAL(14,2) NOT NULL,
          fine_weight_due DECIMAL(12,3) NOT NULL, notes TEXT NULL, cash_override_reason VARCHAR(200) NULL, import_batch_id UUID NULL, request_id UUID NOT NULL,
          created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
          created_by UUID NULL, updated_by UUID NULL, UNIQUE KEY uq_bill_no (bill_no), UNIQUE KEY uq_req (request_id), KEY ix_cust (customer_id, bill_date), KEY ix_upd (updated_at, id)) ENGINE=InnoDB`,
      },
      bill_items: {
        ddl: `CREATE TABLE bill_items (id UUID PRIMARY KEY, bill_id UUID NOT NULL, line_no INT NOT NULL, sku_id UUID NOT NULL, design_no VARCHAR(64), sku_no VARCHAR(64),
          category VARCHAR(60), material VARCHAR(10), purity VARCHAR(10), selling_method VARCHAR(12), gross_weight DECIMAL(12,3), customer_net_weight DECIMAL(12,3),
          quantity INT, metal_rate DECIMAL(12,2), labour_rate DECIMAL(12,2), labour_amount DECIMAL(14,2), piroi DECIMAL(12,2), other_charges DECIMAL(14,2),
          metal_amount DECIMAL(14,2), fine_weight_due DECIMAL(12,3), item_total DECIMAL(14,2), tax_rate DECIMAL(5,2), tax_amount DECIMAL(14,2),
          list_metal_rate DECIMAL(12,2), list_labour_rate DECIMAL(12,2),
          created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
          UNIQUE KEY uq_line (bill_id, line_no), UNIQUE KEY uq_bill_sku (bill_id, sku_id), KEY ix_sku (sku_id), KEY ix_upd (updated_at, id)) ENGINE=InnoDB`,
      },
      receipts: {
        ddl: `CREATE TABLE receipts (id UUID PRIMARY KEY, customer_id UUID NOT NULL, kind VARCHAR(12) NOT NULL, mode VARCHAR(16), amount DECIMAL(14,2) NOT NULL, fine_grams DECIMAL(12,3) NOT NULL,
          silver_rate DECIMAL(12,2) NULL, paid_on DATE NOT NULL, reference VARCHAR(80), notes TEXT NULL, is_opening TINYINT(1) NOT NULL, cash_override_reason VARCHAR(200) NULL,
          status VARCHAR(8) NOT NULL, void_reason VARCHAR(200) NULL, voided_at DATETIME(6) NULL, voided_by UUID NULL,
          created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
          created_by UUID NULL, updated_by UUID NULL, KEY ix_cust (customer_id), KEY ix_upd (updated_at, id)) ENGINE=InnoDB`,
      },
      receipt_allocations: {
        ddl: `CREATE TABLE receipt_allocations (id UUID PRIMARY KEY, receipt_id UUID NOT NULL, bill_id UUID NOT NULL, customer_id UUID NOT NULL, amount DECIMAL(14,2) NOT NULL,
          fine_grams DECIMAL(12,3) NOT NULL, released_at DATETIME(6) NULL,
          created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
          KEY ix_receipt (receipt_id), KEY ix_bill (bill_id), KEY ix_upd (updated_at, id)) ENGINE=InnoDB`,
      },
    };
    await c.query(`CREATE TABLE audit_log (id BIGINT AUTO_INCREMENT PRIMARY KEY, at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), actor UUID NULL, actor_role VARCHAR(20) NULL,
      table_name VARCHAR(64) NOT NULL, row_id VARCHAR(64) NOT NULL, action ENUM('insert','update') NOT NULL, old_row JSON NULL, new_row JSON NULL, KEY ix_audit_row (table_name, row_id)) ENGINE=InnoDB`);
    const colsOf: Record<string, { name: string; type: string; isJson?: boolean }[]> = {};
    for (const [name, t] of Object.entries(tables)) {
      await c.query(t.ddl);
      const [info] = await c.query<any[]>(
        "SELECT COLUMN_NAME AS n, DATA_TYPE AS t FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION",
        [name]
      );
      colsOf[name] = info.map((r) => ({ name: r.n, type: r.t, isJson: t.jsonCols?.includes(r.n) }));
      for (const sql of auditTriggerSql(name, 'id', colsOf[name])) await c.query(sql);
    }
    await c.query("SET @jv_actor = ?, @jv_role = 'owner'", [randomUUID()]);

    const value = (col: { name: string; type: string; isJson?: boolean }): any => {
      if (['id', 'design_id', 'sku_id', 'bill_id', 'customer_id', 'receipt_id', 'request_id'].includes(col.name) || col.name.endsWith('_by') || col.name.endsWith('_id')) return randomUUID();
      if (['created_at', 'updated_at', 'archived_at', 'cancelled_at', 'voided_at', 'released_at'].includes(col.name)) return undefined; // default or NULL
      if (col.isJson) return col.name === 'image_ids' ? JSON.stringify([randomUUID(), randomUUID(), randomUUID()]) : JSON.stringify(['kundan', 'bridal']);
      switch (col.type) {
        case 'decimal': if (col.name === 'gst_percent' || col.name === 'tax_rate') return '0.00'; return (Math.floor(rand() * 900000) / 100).toFixed(2).slice(0, 8);
        case 'int': case 'smallint': return Math.floor(rand() * 5);
        case 'tinyint': return 0;
        case 'date': return '2026-10-15';
        case 'varchar': return text(col.name === 'address' ? 80 : col.name.includes('reason') || col.name === 'notes' ? 0 : col.name.endsWith('_no') || col.name === 'bill_no' ? 14 : 12) || null;
        case 'text': case 'longtext': return col.name === 'description' ? text(140) : null;
        default: return null;
      }
    };
    const insertRows = async (table: string, n: number, mutate?: (row: Record<string, any>, i: number) => void) => {
      const cols = colsOf[table].filter((x) => value(x) !== undefined);
      const names = cols.map((x) => x.name);
      for (let i = 0; i < n; i += 250) {
        const batch = [];
        for (let j = i; j < Math.min(n, i + 250); j++) {
          const row: Record<string, any> = {};
          for (const col of cols) row[col.name] = value(col);
          row['status'] = row['status'] ?? undefined;
          mutate?.(row, j);
          batch.push(names.map((nm) => (row[nm] === undefined ? null : row[nm])));
        }
        await c.query(`INSERT INTO ${table} (${names.map((x) => `\`${x}\``).join(',')}) VALUES ?`, [batch]);
      }
    };
    const volumes = { designs: 1500, skus: 5000, customers: 2000, bills: 3000, bill_items: 7500, receipts: 4500, receipt_allocations: 4500 };
    await insertRows('designs', volumes.designs, (r, i) => { r.design_no = `D-${i}-${text(8)}`; r.material = 'Gold'; r.purity = '22K'; r.selling_method = 'By Weight'; });
    await insertRows('skus', volumes.skus, (r, i) => { r.sku_no = `S-${i}-${text(8)}`; r.barcode = `BC-${i}-${text(8)}`; r.status = 'In Stock'; });
    await insertRows('customers', volumes.customers, (r) => { r.customer_type = 'Retail'; r.mobile = String(9000000000 + Math.floor(rand() * 999999999)); r.pan = 'ABCDE1234F'; r.gst_number = '27ABCDE1234F1Z5'; });
    await insertRows('bills', volumes.bills, (r, i) => { r.bill_no = `JV-2026-${String(i + 1).padStart(4, '0')}`; r.doc_type = 'estimate'; r.sale_type = 'Retail'; r.status = 'active'; });
    await insertRows('bill_items', volumes.bill_items, (r, i) => { r.line_no = (i % 3) + 1; r.material = 'Gold'; r.purity = '22K'; r.selling_method = 'By Weight'; });
    await insertRows('receipts', volumes.receipts, (r) => { r.kind = 'money'; r.mode = 'UPI'; r.status = 'active'; });
    await insertRows('receipt_allocations', volumes.receipt_allocations);
    // later life: every piece is edited twice (price, then sold), 5 % of bills cancelled, a tenth of customers edited
    await c.query("UPDATE skus SET notes = 'edited once', location = 'Main Showroom'");
    await c.query("UPDATE skus SET status = 'Sold', notes = 'edited twice'");
    await c.query("UPDATE bills SET status = 'cancelled', cancel_reason = 'customer returned the goods' WHERE MOD(CONV(SUBSTR(bill_no, -4), 10, 10), 20) = 0");
    await c.query("UPDATE customers SET notes = 'phone changed' WHERE MOD(CONV(HEX(SUBSTR(name,1,1)), 16, 10), 10) = 0");

    let total = 0;
    const per: Record<string, number> = {};
    for (const t of [...Object.keys(tables), 'audit_log']) {
      const s = await sizeOf(t);
      per[t] = s.data + s.index;
      total += per[t];
    }
    const auditRows = (await sizeOf('audit_log')).rows;
    console.log(
      `[i] business data at M1 volumes: total ${(total / 1e6).toFixed(0)} MB; ` +
        Object.entries(per).map(([k, v]) => `${k} ${(v / 1e6).toFixed(1)} MB`).join(', ') +
        `; audit rows ${auditRows}, ${(per.audit_log / auditRows).toFixed(0)} bytes per audit row`
    );
    expect(total).toBeGreaterThan(10e6);
    expect(total).toBeLessThan(1e9);
  }, 300000);
});
