import { readFileSync } from 'node:fs';
import mysql, { type Connection } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HOST, PORT, dropDb, errorOf, freshDb, rootConn } from '../helpers';
import { AUDITED_TABLES, SECRET_NAME, TRIGGER_FILE, auditTriggersInstalled, buildAuditTriggersSql, generateAuditTriggersSql, loadExcludeList, readAuditShape } from '../../scripts/audit-triggers.mjs';
import { migrate } from '../../scripts/migrate.mjs';
import { V, insert, migratedDb, uuid, world } from './support';

// Spec L1 (a), D16, D23 and T-D14 (database half): the generated audit triggers. Every insert and update on the 13 audited tables writes exactly one audit_log row in the same
// transaction, with the actor, role and request from session variables (role sql when none), the old and new row as JSON; an update of nothing but updated_at writes none; the
// columns of the exclude list are never copied. The API half of T-D14 (the same rows written by Node, "never both") is the API session's.

const dbs: string[] = [];
let db: string;
let c: Connection;
beforeAll(async () => {
  ({ db, c } = await migratedDb('s20_audit', { optional: true }));
  dbs.push(db);
});
afterAll(async () => {
  await c.end();
  for (const d of dbs) await dropDb(d);
});

const auditOf = async (table: string, rowId: string) =>
  (await c.query<any[]>('SELECT id, actor, actor_role, request_id, action, old_row, new_row FROM audit_log WHERE table_name = ? AND row_id = ? ORDER BY id', [table, rowId]))[0];
const obj = (v: unknown) => (typeof v === 'string' ? JSON.parse(v) : v) as Record<string, any>;
const setSession = (actor: string | null, role: string | null, request: string | null) => c.query('SET @jv_actor = ?, @jv_role = ?, @jv_request = ?', [actor, role, request]);
const clearSession = () => setSession(null, null, null);

/** One valid row for each audited table, how to read its key, and an update of a real (non-updated_at, non-excluded) column. */
async function fixtures() {
  const w = await world(c);
  const cat = (await insert(c, 'categories', V.category())) as { id: string };
  const sub = (await insert(c, 'subcategories', V.subcategory(cat.id))) as { id: string };
  const rate = (await insert(c, 'daily_rates', V.dailyRate({ rate_date: '2026-01-02' }))) as { id: string };
  const user = (await insert(c, 'users', V.user())) as { id: string };
  const sp = (await insert(c, 'sku_private', V.skuPrivate(w.sku.id))) as { sku_id?: string };
  await insert(c, 'settings', { setting_key: 'audit_test_key', value: { a: [1, 2], money: '12.50' } });
  return [
    { table: 'users', row: user.id, change: ['UPDATE users SET full_name = ? WHERE id = ?', ['Renamed', user.id]] },
    { table: 'settings', row: 'audit_test_key', change: ["UPDATE settings SET value = ? WHERE setting_key = 'audit_test_key'", [JSON.stringify({ a: [3] })]] },
    { table: 'daily_rates', row: rate.id, change: ['UPDATE daily_rates SET rate_per_gram = ? WHERE id = ?', ['7000.00', rate.id]] },
    { table: 'categories', row: cat.id, change: ['UPDATE categories SET name = ? WHERE id = ?', ['Renamed cat', cat.id]] },
    { table: 'subcategories', row: sub.id, change: ['UPDATE subcategories SET name = ? WHERE id = ?', ['Renamed sub', sub.id]] },
    { table: 'designs', row: w.design.id, change: ['UPDATE designs SET name = ? WHERE id = ?', ['Renamed design', w.design.id]] },
    { table: 'skus', row: w.sku.id, change: ["UPDATE skus SET customer_net_weight = '11.500' WHERE id = ?", [w.sku.id]] },
    { table: 'sku_private', row: w.sku.id, change: ["UPDATE sku_private SET original_net_weight = '10.750' WHERE sku_id = ?", [w.sku.id]] },
    { table: 'customers', row: w.customer.id, change: ['UPDATE customers SET name = ? WHERE id = ?', ['Renamed customer', w.customer.id]] },
    { table: 'bills', row: w.bill.id, change: ['UPDATE bills SET notes = ? WHERE id = ?', ['a note', w.bill.id]] },
    { table: 'bill_items', row: w.item.id, change: ['UPDATE bill_items SET design_no = ? WHERE id = ?', ['D-9', w.item.id]] },
    { table: 'receipts', row: w.receipt.id, change: ['UPDATE receipts SET notes = ? WHERE id = ?', ['a receipt note', w.receipt.id]] },
    { table: 'receipt_allocations', row: w.allocation.id, change: ["UPDATE receipt_allocations SET amount = '90.00' WHERE id = ?", [w.allocation.id]] },
  ].map((f) => ({ ...f, sp }));
}

describe('the generated file and the exclude list (L1)', () => {
  it('there is one AFTER INSERT and one AFTER UPDATE trigger for each of the 13 audited tables, and nothing else is audited', async () => {
    expect(AUDITED_TABLES).toEqual(['users', 'settings', 'daily_rates', 'categories', 'subcategories', 'designs', 'skus', 'sku_private', 'customers', 'bills', 'bill_items', 'receipts', 'receipt_allocations']);
    const names = await auditTriggersInstalled(c);
    expect([...names].sort()).toEqual(AUDITED_TABLES.flatMap((t) => [`trg_audit_${t}_ai`, `trg_audit_${t}_au`]).sort());
    const [rows] = await c.query<any[]>("SELECT TRIGGER_NAME n, EVENT_OBJECT_TABLE t, EVENT_MANIPULATION e, ACTION_TIMING w FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = DATABASE() AND TRIGGER_NAME LIKE 'trg\\_audit\\_%\\_a_'");
    expect(rows).toHaveLength(26);
    for (const r of rows) {
      expect(r.w).toBe('AFTER');
      expect(r.e).toBe(r.n.endsWith('_ai') ? 'INSERT' : 'UPDATE');
      expect(r.n).toBe(`trg_audit_${r.t}_${r.n.endsWith('_ai') ? 'ai' : 'au'}`);
    }
  });

  it('db/optional/0910_audit_triggers.sql is exactly what the generator writes for the current migrations and exclude list (a changed column without a regenerated file fails here)', async () => {
    const plain = await migratedDb('s20_plain');
    dbs.push(plain.db);
    const sql = await generateAuditTriggersSql(plain.c);
    expect(readFileSync(TRIGGER_FILE, 'utf8')).toBe(sql);
    await plain.c.end();
  });

  it('the exclude list: users.password_hash; every column of an audited table that looks like a secret is on it, and every entry names a real column', async () => {
    const exclude = loadExcludeList();
    expect(exclude).toEqual({ users: ['password_hash'] });
    const shape = await readAuditShape(c);
    for (const t of AUDITED_TABLES) {
      for (const col of shape[t].columns) if (SECRET_NAME.test(col.name)) expect(exclude[t] ?? [], `${t}.${col.name} looks like a secret`).toContain(col.name);
    }
    for (const [t, cols] of Object.entries(exclude)) for (const col of cols) expect(shape[t].columns.map((x) => x.name)).toContain(col);
  });

  it('the generator refuses a secret-looking column that is not excluded, an exclude entry for a column that does not exist, a type it cannot put into JSON, and a table without a key', () => {
    const shape = {
      t: { columns: [{ name: 'id', type: 'uuid', json: false }, { name: 'api_token', type: 'varchar', json: false }], primary_key: ['id'] },
    } as any;
    expect(() => buildAuditTriggersSql(shape, {}, ['t'])).toThrow(/looks like a secret/);
    expect(() => buildAuditTriggersSql(shape, { t: ['api_token', 'nope'] }, ['t'])).toThrow(/no column nope/);
    const blob = { t: { columns: [{ name: 'id', type: 'uuid', json: false }, { name: 'data', type: 'blob', json: false }], primary_key: ['id'] } } as any;
    expect(() => buildAuditTriggersSql(blob, {}, ['t'])).toThrow(/does not know how/);
    expect(() => buildAuditTriggersSql(blob, { t: ['data'] }, ['t'])).not.toThrow();
    expect(() => buildAuditTriggersSql({ t: { columns: [{ name: 'a', type: 'int', json: false }], primary_key: [] } } as any, {}, ['t'])).toThrow(/no primary key/);
    const composite = buildAuditTriggersSql({ t: { columns: [{ name: 'a', type: 'int', json: false }, { name: 'b', type: 'uuid', json: false }], primary_key: ['a', 'b'] } } as any, {}, ['t']);
    expect(composite).toContain("CONCAT_WS(':', NEW.`a`, NEW.`b`)");
  });
});

describe('one audit row for each insert and each update (L1, D23, T-D14)', () => {
  it('on every audited table an insert writes exactly one row (no actor, the role sql) with no old row and the new row as JSON; an update of a real column writes exactly one with both', async () => {
    await clearSession();
    const fx = await fixtures();
    expect(fx.map((f) => f.table).sort()).toEqual([...AUDITED_TABLES].sort());
    for (const f of fx) {
      const rows = await auditOf(f.table, f.row);
      expect(rows.map((r: any) => r.action), `${f.table} insert`).toEqual(['insert']);
      expect(rows[0]).toMatchObject({ actor: null, actor_role: 'sql', request_id: null, old_row: null });
      expect(obj(rows[0].new_row), f.table).toBeTypeOf('object');
    }
    for (const f of fx) {
      await c.query(f.change[0] as string, f.change[1] as any[]);
      const rows = await auditOf(f.table, f.row);
      expect(rows.map((r: any) => r.action), `${f.table} update`).toEqual(['insert', 'update']);
      const upd = rows[1];
      expect(obj(upd.old_row)).not.toEqual(obj(upd.new_row));
    }
  });

  it('an update that changes only updated_at writes nothing; neither does an update that changes nothing at all; a touch (D23) adds no audit noise', async () => {
    const w = await world(c);
    const before = (await auditOf('bills', w.bill.id)).length;
    expect(before).toBe(1);
    await c.query("UPDATE bills SET updated_at = '2030-01-01 00:00:00.000000' WHERE id = ?", [w.bill.id]);
    await c.query("UPDATE customers SET updated_at = UTC_TIMESTAMP(6) WHERE id = ?", [w.customer.id]);
    await c.query('UPDATE bills SET notes = notes WHERE id = ?', [w.bill.id]); // a statement that matches and changes nothing
    await c.query('UPDATE receipts SET status = status WHERE id = ?', [w.receipt.id]);
    expect((await auditOf('bills', w.bill.id)).length).toBe(1);
    expect((await auditOf('customers', w.customer.id)).length).toBe(1);
    expect((await auditOf('receipts', w.receipt.id)).length).toBe(1);
    await c.query("UPDATE bills SET notes = 'x', updated_at = '2031-01-01 00:00:00.000000' WHERE id = ?", [w.bill.id]); // a real change that also touches updated_at: one row
    expect((await auditOf('bills', w.bill.id)).map((r: any) => r.action)).toEqual(['insert', 'update']);
  });

  it('a multi-row insert writes one row for each row, a multi-row update one for each changed row; INSERT IGNORE of a duplicate and a failed statement write none; INSERT ... ON DUPLICATE KEY UPDATE is one update, never two rows', async () => {
    const cats = [V.category(), V.category(), V.category()];
    await c.query(`INSERT INTO categories (id, name, prefix, active) VALUES ${cats.map(() => '(?, ?, ?, ?)').join(', ')}`, cats.flatMap((x) => [x.id, x.name, x.prefix, x.active]));
    for (const x of cats) expect((await auditOf('categories', x.id)).map((r: any) => r.action)).toEqual(['insert']);
    await c.query('UPDATE categories SET active = 0 WHERE id IN (?, ?)', [cats[0].id, cats[1].id]);
    expect((await auditOf('categories', cats[0].id)).map((r: any) => r.action)).toEqual(['insert', 'update']);
    expect((await auditOf('categories', cats[1].id)).map((r: any) => r.action)).toEqual(['insert', 'update']);
    expect((await auditOf('categories', cats[2].id)).map((r: any) => r.action)).toEqual(['insert']);
    await c.query('INSERT IGNORE INTO categories (id, name, prefix, active) VALUES (?, ?, ?, 1)', [cats[2].id, 'dup', 'DUP']);
    expect((await auditOf('categories', cats[2].id)).map((r: any) => r.action)).toEqual(['insert']);
    const bad = V.category({ prefix: 'X' }); // fails the CHECK of the prefix
    expect(await errorOf(() => insert(c, 'categories', bad))).not.toBeNull();
    expect(await auditOf('categories', bad.id)).toEqual([]);
    await c.query("INSERT INTO settings (setting_key, value) VALUES ('odku_key', '{\"v\": 1}') ON DUPLICATE KEY UPDATE value = VALUES(value)");
    await c.query("INSERT INTO settings (setting_key, value) VALUES ('odku_key', '{\"v\": 2}') ON DUPLICATE KEY UPDATE value = VALUES(value)");
    expect((await auditOf('settings', 'odku_key')).map((r: any) => r.action)).toEqual(['insert', 'update']);
  });

  it('the audit row is in the same transaction: a rollback takes it away with the change, a commit keeps both', async () => {
    const cat = V.category();
    await c.query('START TRANSACTION');
    await insert(c, 'categories', cat);
    expect((await auditOf('categories', cat.id)).length).toBe(1);
    await c.query('ROLLBACK');
    expect((await auditOf('categories', cat.id)).length).toBe(0);
    const kept = V.category();
    await c.query('START TRANSACTION');
    await insert(c, 'categories', kept);
    await c.query('COMMIT');
    expect((await auditOf('categories', kept.id)).length).toBe(1);
  });

  it('a failing audit insert fails the change (nothing is changed unaudited): a malformed actor variable stops the write', async () => {
    await setSession('not-a-uuid', 'staff', null);
    const cat = V.category();
    const e = await errorOf(() => insert(c, 'categories', cat));
    await clearSession();
    expect(e).not.toBeNull();
    expect(Number((await c.query<any[]>('SELECT COUNT(*) n FROM categories WHERE id = ?', [cat.id]))[0][0].n)).toBe(0);
  });
});

describe('who did it: the session variables', () => {
  it('@jv_actor, @jv_role and @jv_request go into the row; the variables survive a commit until the wrapper clears them, and cleared means no actor and the role sql again', async () => {
    const me = uuid();
    const req = uuid();
    await setSession(me, 'owner', req);
    const a = V.category();
    await c.query('START TRANSACTION');
    await insert(c, 'categories', a);
    await c.query('COMMIT');
    const b = V.category();
    await insert(c, 'categories', b); // the variable is still on the connection after the commit
    expect((await auditOf('categories', a.id))[0]).toMatchObject({ actor: me, actor_role: 'owner', request_id: req });
    expect((await auditOf('categories', b.id))[0]).toMatchObject({ actor: me, actor_role: 'owner', request_id: req });
    await clearSession();
    const d = V.category();
    await insert(c, 'categories', d);
    expect((await auditOf('categories', d.id))[0]).toMatchObject({ actor: null, actor_role: 'sql', request_id: null });
    await setSession(null, 'import', null);
    const e = V.category();
    await insert(c, 'categories', e);
    await clearSession();
    expect((await auditOf('categories', e.id))[0]).toMatchObject({ actor: null, actor_role: 'import' });
  });

  it('a change made on another connection (phpMyAdmin) is recorded with no actor and the role sql, whatever the first connection has set', async () => {
    await setSession(uuid(), 'owner', uuid());
    const other = await mysql.createConnection({ host: HOST, port: PORT, user: 'jv_app', password: 'spike_app_only', database: db, decimalNumbers: false, dateStrings: true });
    const cat = V.category();
    await insert(other, 'categories', cat);
    await other.end();
    await clearSession();
    expect((await auditOf('categories', cat.id))[0]).toMatchObject({ actor: null, actor_role: 'sql' });
  });
});

describe('what the row holds', () => {
  it('money and BIGINT as text, small integers as numbers, JSON columns as JSON, dates as the server prints them, NULL as null; the row id is the key', async () => {
    const w = await world(c);
    const [bill] = await auditOf('bills', w.bill.id);
    const n = obj(bill.new_row);
    expect(n).toMatchObject({ id: w.bill.id, grand_total: '1000.00', fine_weight_due: '0.000', pricing_version: 1, status: 'active', cancel_reason: null, bill_date: '2026-10-15' });
    expect(typeof n.created_at).toBe('string');
    const [design] = await auditOf('designs', w.design.id);
    expect(obj(design.new_row)).toMatchObject({ tags: ['bridal'], photo_ids: [] }); // JSON stays JSON, not an escaped string
    await insert(c, 'settings', { setting_key: 'json_probe', value: { a: [1, 2], money: '12.50' } });
    const [setting] = await auditOf('settings', 'json_probe');
    expect(obj(setting.new_row).value).toEqual({ a: [1, 2], money: '12.50' });
    const [item] = await auditOf('bill_items', w.item.id);
    expect(obj(item.new_row)).toMatchObject({ quantity: 1, metal_amount: '1100.00', line_no: 1 });
    await insert(c, 'sku_private', V.skuPrivate(w.sku.id));
    const [sp] = await auditOf('sku_private', w.sku.id);
    expect(obj(sp.new_row)).toMatchObject({ sku_id: w.sku.id, original_net_weight: '10.500' });
  });

  it('an update keeps both the old and the new value of the changed column, and the full row on both sides', async () => {
    const w = await world(c);
    await c.query('UPDATE customers SET name = ? WHERE id = ?', ['Before After', w.customer.id]);
    const rows = await auditOf('customers', w.customer.id);
    const upd = rows[1];
    expect(obj(upd.old_row).name).toBe('Test Customer');
    expect(obj(upd.new_row).name).toBe('Before After');
    expect(Object.keys(obj(upd.old_row))).toEqual(Object.keys(obj(upd.new_row)));
    expect(obj(upd.old_row).mobile).toBe(obj(upd.new_row).mobile);
  });

  it('no audit row holds a hash: users.password_hash is in no insert and no update, and no audit row has a key that looks like a secret (checked over the whole table)', async () => {
    await clearSession();
    const user = V.user({ password_hash: 'argon2id$SECRETSECRETSECRET' });
    await insert(c, 'users', user);
    await c.query("UPDATE users SET password_hash = 'argon2id$ANOTHERSECRETVALUE', full_name = 'Changed' WHERE id = ?", [user.id]);
    await c.query("UPDATE users SET password_hash = 'argon2id$THIRDSECRETVALUE' WHERE id = ?", [user.id]); // a password change alone: the API writes its `event` row, the trigger writes none
    const rows = await auditOf('users', user.id);
    expect(rows.map((r: any) => r.action)).toEqual(['insert', 'update']);
    for (const r of rows) {
      const text = JSON.stringify([r.old_row, r.new_row]);
      expect(text).not.toContain('SECRET');
      expect(text).not.toContain('password_hash');
    }
    const [all] = await c.query<any[]>('SELECT old_row, new_row FROM audit_log');
    const keys = new Set<string>();
    for (const r of all) for (const col of [r.old_row, r.new_row]) if (col) for (const k of Object.keys(obj(col))) keys.add(k);
    for (const k of keys) expect(SECRET_NAME.test(k), `audit_log holds a key ${k}`).toBe(false);
    expect(keys.has('must_change_password')).toBe(true);
  });

  it('the append-only triggers of audit_log still refuse UPDATE and DELETE, and the audit triggers do not trip them (they only insert)', async () => {
    const cat = V.category();
    await insert(c, 'categories', cat);
    const e1 = await errorOf(() => c.query("UPDATE audit_log SET row_id = 'x' WHERE table_name = 'categories' LIMIT 1"));
    const e2 = await errorOf(() => c.query("DELETE FROM audit_log WHERE table_name = 'categories' LIMIT 1"));
    expect(e1?.errno).toBe(1644);
    expect(e2?.errno).toBe(1644);
  });
});

describe('as the restricted user of A3 (the ten ticked boxes) and re-applying the file', () => {
  it('the ten-box user creates the triggers, they fire for the app user, and applying the file again replaces them without error', async () => {
    const tdb = await freshDb('s20_a3');
    dbs.push(tdb);
    const root = await rootConn();
    await root.query("CREATE USER IF NOT EXISTS 'jv_a3c'@'%' IDENTIFIED BY 'spike_a3_only'");
    await root.query(`GRANT SELECT, INSERT, UPDATE, CREATE, ALTER, INDEX, REFERENCES, TRIGGER, CREATE TEMPORARY TABLES, LOCK TABLES ON \`${tdb}\`.* TO 'jv_a3c'@'%'`);
    const u = await mysql.createConnection({ host: HOST, port: PORT, user: 'jv_a3c', password: 'spike_a3_only', database: tdb, multipleStatements: true, decimalNumbers: false, supportBigNumbers: true, bigNumberStrings: true, dateStrings: true });
    await migrate(u, { seeds: true, optional: true });
    await migrate(u, { seeds: true, optional: true }); // a second run: every statement is re-runnable
    expect((await auditTriggersInstalled(u)).length).toBe(26);
    await u.query("SET @jv_actor = NULL, @jv_role = 'staff', @jv_request = NULL");
    const cat = V.category();
    await insert(u, 'categories', cat);
    const [rows] = await u.query<any[]>('SELECT actor_role, action FROM audit_log WHERE table_name = ? AND row_id = ?', ['categories', cat.id]);
    expect(rows).toEqual([{ actor_role: 'staff', action: 'insert' }]);
    await u.end();
    await root.query("DROP USER IF EXISTS 'jv_a3c'@'%'");
    await root.end();
  });
});
