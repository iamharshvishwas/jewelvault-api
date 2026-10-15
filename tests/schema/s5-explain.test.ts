import type { Connection } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dropDb } from '../helpers';
import { V, insert, migratedDb, uuid, world } from './support';

// Spike finding F1: an UPDATE, DELETE or SELECT ... FOR UPDATE with no usable index scans and locks rows, and deadlocked 12 to 32 times
// per 1,200 operations. Every statement the API will run in a transaction must have an index it can use (possible_keys is not NULL).

let db: string;
let c: Connection;
let w: Awaited<ReturnType<typeof world>>;
let userEmail: string;
let tokenHash: Buffer;
let requestId: string;
let photoId: string;
beforeAll(async () => {
  ({ db, c } = await migratedDb('s5_explain'));
  w = await world(c);
  // EXPLAIN on a primary-key lookup of a row that does not exist says "no matching row in const table" and lists no index; use rows that exist
  const user = V.user();
  await insert(c, 'users', user);
  userEmail = user.email;
  const session = V.session(user.id);
  await insert(c, 'sessions', session);
  tokenHash = session.token_hash;
  requestId = uuid();
  await insert(c, 'sys_idempotency', { request_id: requestId, fn: 'create_bill', actor: user.id, args_hash: 'a'.repeat(64) });
  await insert(c, 'sys_counters', { series: 'bill:JV:2026', last_value: 1 });
  await insert(c, 'sys_login_attempts', { scope: 'email', slot: 17, window_start: '2026-10-15 10:00:00.000000', n: 1 });
  await insert(c, 'receipts', V.receipt(w.customer.id, { amount: '10.00' }));
  photoId = uuid();
  await insert(c, 'design_photos', { id: photoId, kind: 'full', design_id: w.design.id, mime: 'image/jpeg', byte_size: 3, sha256: Buffer.alloc(32), bytes: Buffer.from([1, 2, 3]) });
});
afterAll(async () => {
  await c.end();
  await dropDb(db);
});

const statements = (): [string, string, unknown[]][] => {
  const a = w.customer.id;
  const b = w.sku.id;
  return [
  ['lock the customer (X0 item 3)', 'SELECT id FROM customers WHERE id = ? FOR UPDATE', [w.customer.id]],
  ['lock the pieces by id ascending (X0 item 5)', 'SELECT id, status FROM skus WHERE id IN (?, ?) ORDER BY id FOR UPDATE', [a, b]],
  ['mark pieces Sold (K2)', "UPDATE skus SET status = 'Sold', sold_bill_id = ? WHERE id IN (?, ?) AND status = 'In Stock' AND sold_bill_id IS NULL", [w.bill.id, w.sku.id, b]],
  ['free the pieces of a cancelled bill by their ids', "UPDATE skus SET status = 'In Stock', sold_bill_id = NULL WHERE id IN (?, ?) AND sold_bill_id = ?", [w.sku.id, b, w.bill.id]],
  ['find the pieces of a bill through the bill (sold_bill_id is indexed by its foreign key)', 'SELECT id FROM skus WHERE sold_bill_id = ? FOR UPDATE', [w.bill.id]],
  ['claim a request id', 'SELECT claim_token, result FROM sys_idempotency WHERE request_id = ? FOR UPDATE', [requestId]],
  ['take a number', 'SELECT last_value FROM sys_counters WHERE series = ? FOR UPDATE', ['bill:JV:2026']],
  ['lock a bill', 'SELECT id, status, customer_id FROM bills WHERE id = ? FOR UPDATE', [w.bill.id]],
  ['oldest pending bills first (Y3)', "SELECT id FROM bills WHERE customer_id = ? AND status = 'active' ORDER BY bill_date, created_at, id", [a]],
  ['lines of a bill', 'SELECT id FROM bill_items WHERE bill_id = ?', [w.bill.id]],
  ['release the allocations of a cancelled bill', 'UPDATE receipt_allocations SET released_at = ? WHERE bill_id = ?', ['2026-10-15 10:00:00.000000', w.bill.id]],
  ['allocations of a receipt', 'SELECT id FROM receipt_allocations WHERE receipt_id = ?', [w.receipt.id]],
  ['receipts of a customer', "SELECT id FROM receipts WHERE customer_id = ? AND status = 'active' ORDER BY paid_on, created_at, id", [a]],
  ['void a receipt', "UPDATE receipts SET status = 'voided' WHERE id = ?", [w.receipt.id]],
  ['look up a piece by barcode or number (billing screen)', 'SELECT id FROM skus WHERE barcode = ? OR sku_no = ?', ['x', 'y']],
  ['look up a user by e-mail (login)', 'SELECT id FROM users WHERE email = ?', [userEmail]],
  ['look up a session by token hash', 'SELECT id FROM sessions WHERE token_hash = ?', [tokenHash]],
  ['purge old idempotency rows', 'DELETE FROM sys_idempotency WHERE created_at < ?', ['2026-07-01 00:00:00.000000']],
  ['purge expired sessions', 'DELETE FROM sessions WHERE expires_at < ?', ['2026-07-01 00:00:00.000000']],
  ['read one login counter after counting the attempt (D24: scope and slot, its primary key)', 'SELECT n FROM sys_login_attempts WHERE scope = ? AND slot = ?', ['email', 17]],
  ['one customer\'s balance reads receipt_allocations by customer_id (D19, RM4-14)', "SELECT SUM(al.amount) FROM receipt_allocations al WHERE al.customer_id = ? AND al.released_at IS NULL", [uuid()]],
  ['audit trail of one row', 'SELECT id FROM audit_log WHERE table_name = ? AND row_id = ?', ['bills', w.bill.id]],
  ['photos of a design', 'SELECT id, kind FROM design_photos WHERE design_id = ?', [w.design.id]],
  ['one photo by id and kind', 'SELECT bytes FROM design_photos WHERE id = ? AND kind = ?', [photoId, 'full']],
  ];
};

describe('every transaction statement can use an index', () => {
  it('has a list of statements that is not empty', () => {
    expect(statements().length).toBeGreaterThan(20);
  });
  it('uses an index for each one (EXPLAIN possible_keys)', async () => {
    for (const [_t, sql, params] of statements()) {
    const [plan] = await c.query<any[]>(`EXPLAIN ${sql}`, params as any[]);
    const rows = Array.isArray(plan) ? plan : [plan];
    const target = rows.find((r) => r.table && !String(r.table).startsWith('<')) ?? rows[0];
    expect(target.possible_keys, `no index can serve: ${sql}`).not.toBeNull();
    }
  });
});

describe('polling by (updated_at, key) is served by an index on every polled table (C4, D19)', () => {
  const polled: [string, string][] = [
    ['users', 'id'], ['settings', 'setting_key'], ['daily_rates', 'id'], ['categories', 'id'], ['subcategories', 'id'], ['designs', 'id'],
    ['skus', 'id'], ['sku_private', 'sku_id'], ['customers', 'id'], ['bills', 'id'], ['bill_items', 'id'], ['receipts', 'id'], ['receipt_allocations', 'id'],
  ];
  it.each(polled)('%s', async (table, key) => {
    const sql = `SELECT * FROM \`${table}\` WHERE updated_at > ? OR (updated_at = ? AND \`${key}\` > ?) ORDER BY updated_at, \`${key}\` LIMIT 1000`;
    const [plan] = await c.query<any[]>(`EXPLAIN ${sql}`, ['2026-10-15 00:00:00.000000', '2026-10-15 00:00:00.000000', key === 'setting_key' ? '' : uuid()]);
    expect(plan[0].possible_keys, sql).not.toBeNull();
    const [idx] = await c.query<any[]>(
      'SELECT GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS cols FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? GROUP BY INDEX_NAME',
      [table]
    );
    expect(idx.map((x) => x.cols), `${table} has an index starting with updated_at`).toContainEqual(expect.stringMatching(/^updated_at(,|$)/));
  });
  it('the world fixture is still consistent after the plans ran', () => {
    expect(w.bill.id).toBeTruthy();
  });
});
