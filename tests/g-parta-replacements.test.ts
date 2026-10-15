import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Connection } from 'mysql2/promise';
import mysql from 'mysql2/promise';
import { HOST, PORT, appConn, dropDb, errorOf, freshDb, rootConn, sleep } from './helpers';
import { auditTriggerSql } from './audit-gen';

// Step 2: the Part A rules of the spec that were written for Postgres/Supabase, and what MariaDB can do instead.

let db: string;
let c: Connection;
const open: Connection[] = [];

beforeAll(async () => {
  db = await freshDb('g_parta');
  c = await appConn(db);
});
afterAll(async () => {
  await Promise.all(open.map((x) => x.end().catch(() => undefined)));
  await c.end();
  const root = await rootConn();
  await root.query("DROP USER IF EXISTS 'jv_limited'@'%'");
  await root.end();
  await dropDb(db);
});

describe('A3/A4/S7 (grants, no DELETE, column grants)', () => {
  it('MariaDB can do table and column grants, if the hosting user may GRANT: SELECT/INSERT/UPDATE without DELETE or DROP', async () => {
    const root = await rootConn(db);
    await root.query('CREATE TABLE t_grant (id INT PRIMARY KEY, name VARCHAR(20), status VARCHAR(20))');
    await root.query("INSERT INTO t_grant VALUES (1, 'a', 'x')");
    await root.query("CREATE USER IF NOT EXISTS 'jv_limited'@'%' IDENTIFIED BY 'limited_only'");
    await root.query(`GRANT SELECT, INSERT ON \`${db}\`.t_grant TO 'jv_limited'@'%'`);
    await root.query(`GRANT UPDATE (name) ON \`${db}\`.t_grant TO 'jv_limited'@'%'`);
    await root.end();
    const lim = await mysql.createConnection({ host: HOST, port: PORT, user: 'jv_limited', password: 'limited_only', database: db });
    open.push(lim);
    await lim.query("UPDATE t_grant SET name = 'b' WHERE id = 1");
    const e1 = await errorOf(() => lim.query("UPDATE t_grant SET status = 'y' WHERE id = 1"));
    const e2 = await errorOf(() => lim.query('DELETE FROM t_grant WHERE id = 1'));
    const e3 = await errorOf(() => lim.query('DROP TABLE t_grant'));
    expect([e1?.errno, e2?.errno, e3?.errno]).toEqual([1143, 1142, 1142]);
  });

  it('the hosting-style app user (ALL on its own database, no GRANT OPTION) cannot narrow its own rights or create other users', async () => {
    const e1 = await errorOf(() => c.query("CREATE USER 'x'@'%' IDENTIFIED BY 'y'"));
    const e2 = await errorOf(() => c.query("REVOKE DELETE ON `" + db + "`.* FROM 'jv_app'@'%'"));
    console.log('[g] CREATE USER by app user ->', e1?.errno, '| REVOKE own right ->', e2?.errno);
    expect(e1).not.toBeNull();
    expect(e2).not.toBeNull();
    // so "no DELETE for the API role" (S7) needs a second DB user made in hPanel, or it is held by Node code + a BEFORE DELETE trigger
  });

  it('a BEFORE DELETE / BEFORE UPDATE trigger can make a table append-only for every user, the owner of the database included (L2, S7)', async () => {
    await c.query(`CREATE TABLE audit_log (
      id BIGINT AUTO_INCREMENT PRIMARY KEY, at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      actor UUID NULL, actor_role VARCHAR(20) NULL, table_name VARCHAR(64) NOT NULL, row_id VARCHAR(64) NOT NULL,
      action ENUM('insert','update') NOT NULL, old_row JSON NULL, new_row JSON NULL, KEY ix_audit_row (table_name, row_id)
    ) ENGINE=InnoDB`);
    await c.query(`CREATE TRIGGER trg_audit_no_update BEFORE UPDATE ON audit_log FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'JV_FORBIDDEN: audit_log is append-only'`);
    await c.query(`CREATE TRIGGER trg_audit_no_delete BEFORE DELETE ON audit_log FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'JV_FORBIDDEN: audit_log is append-only'`);
    await c.query("INSERT INTO audit_log (table_name, row_id, action) VALUES ('x', '1', 'insert')");
    const e1 = await errorOf(() => c.query("UPDATE audit_log SET row_id = '2'"));
    const e2 = await errorOf(() => c.query('DELETE FROM audit_log'));
    expect(e1?.errno).toBe(1644);
    expect(e2?.errno).toBe(1644);
    // TRUNCATE and DROP bypass row triggers: only a privilege (second DB user) stops those
    const [bin] = await c.query<any[]>('SELECT @@log_bin AS b');
    console.log('[g] local log_bin', bin[0].b);
    await c.query('TRUNCATE TABLE audit_log'); // documents the gap
    await c.query('DROP TRIGGER trg_audit_no_update');
    await c.query('DROP TRIGGER trg_audit_no_delete');
  });
});

describe('L1/D22/D23/S6 (audit, forced person columns, touch, updated_at) without row_to_json or auth.uid()', () => {
  const cols = [
    { name: 'id', type: 'uuid' },
    { name: 'name', type: 'varchar' },
    { name: 'amount', type: 'decimal' },
    { name: 'tags', type: 'longtext', isJson: true },
    { name: 'created_by', type: 'uuid' },
    { name: 'updated_by', type: 'uuid' },
    { name: 'updated_at', type: 'datetime' },
  ];

  it('generated audit triggers: insert, update, no row for a touch of updated_at only, actor from @jv_actor, role "import" when there is none', async () => {
    await c.query(`CREATE TABLE things (
      id UUID PRIMARY KEY, name VARCHAR(40) NOT NULL, amount DECIMAL(14,2) NOT NULL, tags JSON NULL,
      created_by UUID NULL, updated_by UUID NULL,
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6)
    ) ENGINE=InnoDB`);
    // D22: forced person columns
    await c.query(`CREATE TRIGGER trg_things_person_i BEFORE INSERT ON things FOR EACH ROW
      BEGIN SET NEW.created_by = @jv_actor; SET NEW.updated_by = @jv_actor; END`);
    await c.query(`CREATE TRIGGER trg_things_person_u BEFORE UPDATE ON things FOR EACH ROW
      BEGIN SET NEW.created_by = OLD.created_by; SET NEW.updated_by = @jv_actor; END`);
    for (const sql of auditTriggerSql('things', 'id', cols)) await c.query(sql);

    const actor = randomUUID();
    const liar = randomUUID();
    const id = randomUUID();
    await c.query('SET @jv_actor = ?, @jv_role = ?', [actor, 'owner']);
    await c.query('INSERT INTO things (id, name, amount, tags, created_by) VALUES (?, ?, ?, ?, ?)', [id, 'ring', '257611.81', JSON.stringify(['kundan']), liar]);
    await c.query("UPDATE things SET name = 'ring 2', created_by = ? WHERE id = ?", [liar, id]);
    await c.query('UPDATE things SET updated_at = NOW(6) WHERE id = ?', [id]); // a touch: no audit row (D23)
    await c.query('SET @jv_actor = NULL, @jv_role = NULL'); // an import run by the database owner
    await c.query("UPDATE things SET amount = '300000.10' WHERE id = ?", [id]);

    const [rows] = await c.query<any[]>('SELECT created_by, updated_by FROM things');
    expect(rows[0].created_by).toBe(actor); // the client-sent value (liar) was ignored on insert and on update
    expect(rows[0].updated_by).toBe(null); // the last write was the import: no actor

    const [audit] = await c.query<any[]>("SELECT actor, actor_role, action, old_row, new_row FROM audit_log WHERE table_name = 'things' ORDER BY id");
    expect(audit.map((a) => a.action)).toEqual(['insert', 'update', 'update']); // the touch of updated_at wrote nothing
    expect(audit.map((a) => a.actor_role)).toEqual(['owner', 'owner', 'import']);
    expect(audit.map((a) => a.actor)).toEqual([actor, actor, null]);
    const first = typeof audit[0].new_row === 'string' ? JSON.parse(audit[0].new_row) : audit[0].new_row;
    expect(first.amount).toBe('257611.81'); // DECIMAL kept as exact text
    expect(first.tags).toEqual(['kundan']); // a JSON column is nested, not escaped
    const upd = typeof audit[1].old_row === 'string' ? JSON.parse(audit[1].old_row) : audit[1].old_row;
    expect(upd.name).toBe('ring');
  });

  it('the generator cannot forget a column: its list is compared with information_schema (replaces "to_jsonb(NEW)" which has no MariaDB equivalent)', async () => {
    const [info] = await c.query<any[]>(
      "SELECT COLUMN_NAME AS n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'things' ORDER BY ORDINAL_POSITION"
    );
    expect(info.map((r) => r.n)).toEqual(cols.map((x) => x.name));
  });

  it('TRAP: session variables live on the pooled connection; they must be set at the start of EVERY transaction and cleared at its end', async () => {
    const a = await appConn(db);
    open.push(a);
    await a.query("SET @jv_actor = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'");
    await a.query('START TRANSACTION');
    await a.query('COMMIT');
    const [r] = await a.query<any[]>('SELECT @jv_actor AS v');
    expect(r[0].v).toBe('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'); // survives the commit: the next request on this connection would inherit it
  });

  it('D23 touch: a trigger on receipts can stamp updated_at on bills and customers (another table); firing table itself cannot be updated (1442)', async () => {
    await c.query('CREATE TABLE tcust (id INT PRIMARY KEY, updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6))');
    await c.query('CREATE TABLE trec (id INT AUTO_INCREMENT PRIMARY KEY, cust_id INT NOT NULL, touched INT NOT NULL DEFAULT 0)');
    await c.query('INSERT INTO tcust (id, updated_at) VALUES (1, "2020-01-01 00:00:00.000000")');
    await c.query('CREATE TRIGGER trg_trec_touch AFTER INSERT ON trec FOR EACH ROW UPDATE tcust SET updated_at = CURRENT_TIMESTAMP(6) WHERE id = NEW.cust_id');
    await c.query('INSERT INTO trec (cust_id) VALUES (1)');
    const [r] = await c.query<any[]>('SELECT updated_at FROM tcust WHERE id = 1');
    expect(r[0].updated_at > '2021-01-01').toBe(true);
    const e = await errorOf(() => c.query('CREATE TRIGGER trg_trec_self AFTER UPDATE ON trec FOR EACH ROW UPDATE trec SET touched = 1 WHERE id = NEW.id').then(() => c.query('UPDATE trec SET cust_id = 1 WHERE id = 1')));
    expect(e?.errno).toBe(1442);
    await c.query('DROP TRIGGER IF EXISTS trg_trec_self');
    // in Node the same touch is one explicit UPDATE inside the transaction, under the customer lock the function already holds
  });
});

describe('P4, A1/A7 (checks that replace advisor lints), views, events', () => {
  it('P4 "no data: value in a photo column" works as a CHECK on text and on a JSON array (JSON_SEARCH)', async () => {
    await c.query(`CREATE TABLE photos (
      id INT PRIMARY KEY, primary_image_path VARCHAR(300) NULL, image_paths JSON NOT NULL,
      CONSTRAINT chk_no_data_primary CHECK (primary_image_path IS NULL OR primary_image_path NOT LIKE 'data:%'),
      CONSTRAINT chk_no_data_paths CHECK (JSON_SEARCH(image_paths, 'one', 'data:%') IS NULL)
    ) ENGINE=InnoDB`);
    await c.query("INSERT INTO photos VALUES (1, 'designs/a/b.jpg', '[\"designs/a/b.jpg\",\"designs/a/t_b.jpg\"]')");
    const e1 = await errorOf(() => c.query("INSERT INTO photos VALUES (2, 'data:image/png;base64,AAAA', '[]')"));
    const e2 = await errorOf(() => c.query("INSERT INTO photos VALUES (3, NULL, '[\"ok.jpg\",\"data:image/png;base64,AAAA\"]')"));
    expect([e1?.errno, e2?.errno]).toEqual([4025, 4025]);
  });

  it('T-D11 replacement: MariaDB creates an index for every foreign key by itself, so "unindexed foreign key" cannot happen; a catalogue query still lists tables without a primary key', async () => {
    await c.query('CREATE TABLE fk_parent (id INT PRIMARY KEY) ENGINE=InnoDB');
    await c.query('CREATE TABLE fk_child (id INT PRIMARY KEY, parent_id INT NOT NULL, CONSTRAINT fk_c FOREIGN KEY (parent_id) REFERENCES fk_parent (id)) ENGINE=InnoDB');
    const [idx] = await c.query<any[]>("SELECT INDEX_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'fk_child' AND COLUMN_NAME = 'parent_id'");
    expect(idx.length).toBeGreaterThan(0);
    const [noPk] = await c.query<any[]>(`
      SELECT t.TABLE_NAME AS n FROM information_schema.TABLES t
      LEFT JOIN information_schema.TABLE_CONSTRAINTS k ON k.TABLE_SCHEMA = t.TABLE_SCHEMA AND k.TABLE_NAME = t.TABLE_NAME AND k.CONSTRAINT_TYPE = 'PRIMARY KEY'
      WHERE t.TABLE_SCHEMA = DATABASE() AND t.TABLE_TYPE = 'BASE TABLE' AND k.CONSTRAINT_NAME IS NULL`);
    expect(noPk).toEqual([]);
  });

  it('A4 views: SQL SECURITY INVOKER views and window functions (the V3 running balance) can be created by the app user', async () => {
    await c.query('CREATE TABLE ledger_probe (id INT PRIMARY KEY, customer_id INT, entry_date DATE, debit DECIMAL(14,2), credit DECIMAL(14,2))');
    await c.query("INSERT INTO ledger_probe VALUES (1,1,'2026-10-01',1000,0),(2,1,'2026-10-02',0,400),(3,2,'2026-10-02',500,0),(4,1,'2026-10-03',250.50,0)");
    await c.query(`CREATE SQL SECURITY INVOKER VIEW v_ledger AS
      SELECT id, customer_id, entry_date, debit, credit,
             SUM(debit - credit) OVER (PARTITION BY customer_id ORDER BY entry_date, id ROWS UNBOUNDED PRECEDING) AS balance
      FROM ledger_probe`);
    const [r] = await c.query<any[]>('SELECT balance FROM v_ledger WHERE customer_id = 1 ORDER BY entry_date, id');
    expect(r.map((x) => x.balance)).toEqual(['1000.00', '600.00', '850.50']);
  });

  it('I8: an EVENT can be created by the app user but NEVER RUNS while event_scheduler is OFF, and the user cannot switch it on', async () => {
    await c.query('CREATE TABLE ev_probe (n INT AUTO_INCREMENT PRIMARY KEY, at DATETIME(6) DEFAULT CURRENT_TIMESTAMP(6))');
    await c.query('CREATE EVENT ev_every_second ON SCHEDULE EVERY 1 SECOND DO INSERT INTO ev_probe () VALUES ()');
    await sleep(3000);
    const [r] = await c.query<any[]>('SELECT COUNT(*) AS n FROM ev_probe');
    expect(Number(r[0].n)).toBe(0);
    const e = await errorOf(() => c.query('SET GLOBAL event_scheduler = ON'));
    expect(e).not.toBeNull();
    await c.query('DROP EVENT ev_every_second');
  });

  it('settings.key must be renamed: `key` is reserved (works only with back-ticks), setting_key works unquoted', async () => {
    const e = await errorOf(() => c.query('CREATE TABLE settings_bad (key VARCHAR(40) PRIMARY KEY, value JSON NOT NULL)'));
    expect(e).not.toBeNull();
    await c.query('CREATE TABLE settings (setting_key VARCHAR(40) PRIMARY KEY, value JSON NOT NULL, updated_by UUID NULL) ENGINE=InnoDB');
    await c.query("INSERT INTO settings (setting_key, value) VALUES ('estimate', ?)", [JSON.stringify({ prefix: 'JV', roundOff: true })]);
    const [r] = await c.query<any[]>("SELECT JSON_VALUE(value, '$.prefix') AS p FROM settings WHERE setting_key = 'estimate'");
    expect(r[0].p).toBe('JV');
  });
});

describe('S9 migrations and D10 text checks', () => {
  it('DDL is NOT transactional in MariaDB: CREATE TABLE inside a rolled-back transaction stays (a failed migration half-applies)', async () => {
    await c.query('START TRANSACTION');
    await c.query('CREATE TABLE ddl_probe (id INT PRIMARY KEY)');
    await c.query('ROLLBACK');
    const [r] = await c.query<any[]>("SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ddl_probe'");
    expect(Number(r[0].n)).toBe(1);
  });

  it('re-runnable migrations are possible with IF NOT EXISTS on tables, columns and indexes (so a half-applied file can be run again)', async () => {
    await c.query('CREATE TABLE IF NOT EXISTS ddl_probe (id INT PRIMARY KEY)');
    await c.query('ALTER TABLE ddl_probe ADD COLUMN IF NOT EXISTS note VARCHAR(20) NULL');
    await c.query('ALTER TABLE ddl_probe ADD COLUMN IF NOT EXISTS note VARCHAR(20) NULL');
    await c.query('CREATE INDEX IF NOT EXISTS ix_ddl_note ON ddl_probe (note)');
    await c.query('CREATE INDEX IF NOT EXISTS ix_ddl_note ON ddl_probe (note)');
  });

  it('TRAP: a regular-expression CHECK is case-INSENSITIVE on the default collation; the PAN rule needs a binary comparison', async () => {
    await c.query(`CREATE TABLE pan_probe (
      id INT PRIMARY KEY, pan VARCHAR(10) NULL,
      CONSTRAINT chk_pan_ci CHECK (pan IS NULL OR pan REGEXP '^[A-Z]{5}[0-9]{4}[A-Z]$')
    ) ENGINE=InnoDB`);
    await c.query("INSERT INTO pan_probe VALUES (1, 'abcde1234f')"); // lower case slips through
    await c.query(`CREATE TABLE pan_ok (
      id INT PRIMARY KEY, pan VARCHAR(10) NULL,
      CONSTRAINT chk_pan CHECK (pan IS NULL OR BINARY pan REGEXP '^[A-Z]{5}[0-9]{4}[A-Z]$')
    ) ENGINE=InnoDB`);
    await c.query("INSERT INTO pan_ok VALUES (1, 'ABCDE1234F')");
    const e = await errorOf(() => c.query("INSERT INTO pan_ok VALUES (2, 'abcde1234f')"));
    const e2 = await errorOf(() => c.query("INSERT INTO pan_ok VALUES (3, 'ABCDE12345')"));
    expect([e?.errno, e2?.errno]).toEqual([4025, 4025]);
  });
});

