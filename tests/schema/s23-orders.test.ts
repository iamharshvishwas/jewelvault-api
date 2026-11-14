import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Connection } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkSql, splitStatements } from '../../scripts/migrate.mjs';
import { ER, type Scratch, errorOf, scratchDatabase } from '../helpers';
import { V, insert } from './support';

// FB-E1 (FB-D8, Siddhi #13): the table `orders` of db/migrations/0011 and the column it adds to design_photos, on a scratch database migrated by the ten-box user of A3 (no DELETE, no DROP), as on
// Hostinger. What the database itself refuses: a status outside the five words, more than three photo ids, a customer that does not exist, a customer that is still named by an order, a second order
// with one number. Nothing here needs a DELETE grant: an order is never deleted (cancelled is a status), and the user that runs the migration and the API cannot delete one.

let scratch: Scratch;
let c: Connection;
let customer: string;
beforeAll(async () => {
  scratch = await scratchDatabase('s23orders', { schema: true });
  c = await scratch.connect();
  customer = ((await insert(c, 'customers', V.customer())) as { id: string }).id;
}, 120_000);
afterAll(async () => {
  await c?.end();
  await scratch?.drop();
}, 60_000);

let n = 0;
const order = (o: Record<string, unknown> = {}) => ({ id: randomUUID(), order_no: `ORD-2026-${String(++n).padStart(4, '0')}`, customer_id: customer, description: 'Gold ring, size 14, with her name', ...o });
const refusal = async (row: Record<string, unknown>) => (await errorOf(() => insert(c, 'orders', row)))?.errno ?? null;

describe('s23 orders (FB-E1): the table', () => {
  it('has the columns of the plan, in order, with their types, and the keys for the sync read and the dashboard alert', async () => {
    const [cols] = await c.query<any[]>(
      "SELECT COLUMN_NAME AS name, COLUMN_TYPE AS type, IS_NULLABLE AS nullable, COLUMN_DEFAULT AS dflt FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'orders' ORDER BY ORDINAL_POSITION",
    );
    expect(cols.map((r) => [r.name, r.type, r.nullable])).toEqual([
      ['id', 'uuid', 'NO'],
      ['order_no', 'varchar(20)', 'NO'],
      ['customer_id', 'uuid', 'NO'],
      ['description', 'varchar(2000)', 'NO'],
      ['delivery_date', 'date', 'YES'],
      ['status', 'varchar(12)', 'NO'],
      ['photo_ids', 'longtext', 'NO'],
      ['notes', 'varchar(2000)', 'YES'],
      ['created_at', 'datetime(6)', 'NO'],
      ['updated_at', 'datetime(6)', 'NO'],
      ['created_by', 'uuid', 'YES'],
      ['updated_by', 'uuid', 'YES'],
    ]);
    expect(cols.find((r) => r.name === 'status').dflt).toBe("'open'");
    expect(cols.find((r) => r.name === 'photo_ids').dflt).toBe("'[]'");
    const [keys] = await c.query<any[]>(
      "SELECT INDEX_NAME AS name, NON_UNIQUE AS non_unique, GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS cols FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'orders' GROUP BY INDEX_NAME, NON_UNIQUE ORDER BY INDEX_NAME",
    );
    expect(keys.map((k) => [k.name, Number(k.non_unique), k.cols])).toEqual([
      ['ix_orders_customer', 1, 'customer_id'],
      ['ix_orders_status_delivery', 1, 'status,delivery_date'],
      ['ix_orders_updated', 1, 'updated_at,id'],
      ['PRIMARY', 0, 'id'],
      ['uq_orders_no', 0, 'order_no'],
    ]);
  });

  it('a valid order is stored with status open and no photos by default', async () => {
    const row = order();
    await insert(c, 'orders', row);
    const [[stored]] = (await c.query<any[]>('SELECT status, photo_ids, delivery_date, notes FROM orders WHERE id = ?', [row.id])) as unknown as [any[]];
    const asJson = (v: unknown) => (typeof v === 'string' ? JSON.parse(v) : v); // the driver may hand a JSON column back parsed or as text
    expect([stored.status, asJson(stored.photo_ids), stored.delivery_date, stored.notes]).toEqual(['open', [], null, null]);
  });

  it('the status CHECK takes the five words and nothing else (case counts)', async () => {
    for (const status of ['open', 'in_progress', 'ready', 'delivered', 'cancelled']) expect(await refusal(order({ status })), status).toBeNull();
    for (const status of ['Open', 'pending', 'done', 'in progress', '']) expect(await refusal(order({ status })), status).toBe(ER.CHECK_FAILED);
  });

  it('the photo cap: at most three ids in a JSON list; four, a non-list and a picture written into the row are refused', async () => {
    const ids = (k: number) => Array.from({ length: k }, () => randomUUID());
    expect(await refusal(order({ photo_ids: ids(3) }))).toBeNull();
    expect(await refusal(order({ photo_ids: ids(4) }))).toBe(ER.CHECK_FAILED);
    expect(await refusal(order({ photo_ids: { a: 1 } }))).toBe(ER.CHECK_FAILED);
    expect(await refusal(order({ photo_ids: ['data:image/png;base64,AAAA'] }))).toBe(ER.CHECK_FAILED);
  });

  it('a blank description is refused; the order number is unique', async () => {
    expect(await refusal(order({ description: '   ' }))).toBe(ER.CHECK_FAILED);
    const first = order();
    await insert(c, 'orders', first);
    expect(await refusal(order({ order_no: first.order_no }))).toBe(ER.DUP_ENTRY);
  });

  it('the customer foreign key is RESTRICT: an unknown customer is refused, and a customer named by an order cannot lose its id', async () => {
    expect(await refusal(order({ customer_id: randomUUID() }))).toBe(ER.NO_REFERENCED_ROW);
    const [fk] = await c.query<any[]>(
      "SELECT DELETE_RULE AS d, UPDATE_RULE AS u, REFERENCED_TABLE_NAME AS t FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'orders'",
    );
    expect(fk.map((r) => [r.t, r.d, r.u])).toEqual([['customers', 'RESTRICT', 'RESTRICT']]);
    const mine = ((await insert(c, 'customers', V.customer({ mobile: '9000000001' }))) as { id: string }).id;
    await insert(c, 'orders', order({ customer_id: mine }));
    expect((await errorOf(() => c.query('UPDATE customers SET id = ? WHERE id = ?', [randomUUID(), mine])))?.errno).toBe(ER.ROW_IS_REFERENCED);
  });

  it('no DELETE grant is needed or held: the ten-box user that migrated the table and runs the API cannot delete an order (a cancelled order is a status, S7)', async () => {
    const row = order();
    await insert(c, 'orders', row);
    await c.query("UPDATE orders SET status = 'cancelled' WHERE id = ?", [row.id]);
    const refused = await errorOf(() => c.query('DELETE FROM orders WHERE id = ?', [row.id]));
    expect(refused?.errno).toBe(1142); // ER_TABLEACCESS_DENIED_ERROR
    const [[kept]] = (await c.query<any[]>('SELECT status FROM orders WHERE id = ?', [row.id])) as unknown as [any[]];
    expect(kept.status).toBe('cancelled');
  });
});

describe('s23 design_photos.order_id (FB-E1): the photos of an order live in the same table', () => {
  it('0011 adds one nullable UUID column at the end, with no foreign key (the screen uploads before the order exists, as for a design, D26)', async () => {
    const [cols] = await c.query<any[]>("SELECT COLUMN_NAME AS name, COLUMN_TYPE AS type, IS_NULLABLE AS nullable FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'design_photos' ORDER BY ORDINAL_POSITION");
    expect(cols[cols.length - 1]).toEqual({ name: 'order_id', type: 'uuid', nullable: 'YES' });
    const [fks] = await c.query<any[]>("SELECT CONSTRAINT_NAME FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'design_photos'");
    expect(fks).toEqual([]);
  });

  it('a design photo row written as before (no order_id) is still accepted, and an order photo row carries the order id in both columns', async () => {
    const bytes = Buffer.from('not-an-image');
    const designPhoto = randomUUID();
    await c.query('INSERT INTO design_photos (id, kind, design_id, mime, byte_size, sha256, bytes) VALUES (?, ?, ?, ?, ?, ?, ?)', [designPhoto, 'full', randomUUID(), 'image/jpeg', bytes.length, Buffer.alloc(32, 1), bytes]);
    const orderId = randomUUID();
    await c.query('INSERT INTO design_photos (id, kind, design_id, order_id, mime, byte_size, sha256, bytes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [randomUUID(), 'full', orderId, orderId, 'image/jpeg', bytes.length, Buffer.alloc(32, 1), bytes]);
    const [[d]] = (await c.query<any[]>('SELECT order_id FROM design_photos WHERE id = ?', [designPhoto])) as unknown as [any[]];
    expect(d.order_id).toBeNull();
  });

  it('the file is create-only and re-runnable (S9, RF5-13): every statement passes the runner\'s list, and sending them all again to the migrated database raises nothing', async () => {
    const text = readFileSync(new URL('../../db/migrations/0011_orders.sql', import.meta.url), 'utf8');
    expect(checkSql(text, 'migration')).toEqual([]);
    const statements = splitStatements(text);
    expect(statements.map((s: string) => s.split('(')[0].trim().replace(/\s+/g, ' '))).toEqual(['CREATE TABLE IF NOT EXISTS orders', 'ALTER TABLE design_photos ADD COLUMN IF NOT EXISTS order_id UUID NULL']);
    for (const sql of statements) expect(await errorOf(() => c.query(sql)), sql.slice(0, 60)).toBeNull();
  });
});
