import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Connection } from 'mysql2/promise';
import { appConn, dropDb, errorOf, ER, freshDb, rootConn } from './helpers';

// Spike (d): CHECK constraints, UUID vs CHAR(36), JSON columns, generated columns (+ reserved words, triggers, timestamps).

let db: string;
let c: Connection;

beforeAll(async () => {
  db = await freshDb('d_types');
  c = await appConn(db);
});
afterAll(async () => {
  await c.end();
  await dropDb(db);
});

describe('(d1) CHECK constraints', () => {
  it('are enforced, named, error 4025, and can tie several columns together (spec D8, D13 shapes)', async () => {
    await c.query(`CREATE TABLE skus (
      id UUID NOT NULL PRIMARY KEY,
      status VARCHAR(20) NOT NULL,
      sold_bill_id UUID NULL,
      archived_at DATETIME(6) NULL,
      gross_weight DECIMAL(12,3) NOT NULL DEFAULT 0,
      customer_net_weight DECIMAL(12,3) NOT NULL DEFAULT 0,
      CONSTRAINT chk_sku_status CHECK (status IN ('In Stock','Reserved','On Approval','Sold','Returned','Repair','Transferred','Missing','Damaged','Archived')),
      CONSTRAINT chk_sku_sold CHECK ((status = 'Sold') = (sold_bill_id IS NOT NULL)),
      CONSTRAINT chk_sku_archived CHECK ((status = 'Archived') = (archived_at IS NOT NULL)),
      CONSTRAINT chk_sku_weights CHECK (gross_weight >= 0 AND customer_net_weight >= 0 AND gross_weight <= 100000 AND customer_net_weight <= 100000)
    ) ENGINE=InnoDB`);
    const ok = randomUUID();
    await c.query("INSERT INTO skus (id, status) VALUES (?, 'In Stock')", [ok]);
    await c.query("INSERT INTO skus (id, status, sold_bill_id) VALUES (?, 'Sold', ?)", [randomUUID(), randomUUID()]);
    const cases: [string, string, any[]][] = [
      ['chk_sku_status', "INSERT INTO skus (id, status) VALUES (?, 'Lost')", [randomUUID()]],
      ['chk_sku_sold', "INSERT INTO skus (id, status) VALUES (?, 'Sold')", [randomUUID()]],
      ['chk_sku_sold', "INSERT INTO skus (id, status, sold_bill_id) VALUES (?, 'In Stock', ?)", [randomUUID(), randomUUID()]],
      ['chk_sku_archived', "INSERT INTO skus (id, status) VALUES (?, 'Archived')", [randomUUID()]],
      ['chk_sku_weights', "INSERT INTO skus (id, status, gross_weight) VALUES (?, 'In Stock', 100000.001)", [randomUUID()]],
    ];
    for (const [name, sql, params] of cases) {
      const err = await errorOf(() => c.query(sql, params));
      expect(err?.errno, sql).toBe(ER.CHECK_FAILED);
      expect(err?.message).toContain(name);
    }
    const upd = await errorOf(() => c.query("UPDATE skus SET status = 'Sold' WHERE id = ?", [ok])); // an UPDATE is checked too
    expect(upd?.errno).toBe(ER.CHECK_FAILED);
  });

  it('a CHECK passes when the expression is NULL (so every CHECK column must also be NOT NULL where it matters)', async () => {
    await c.query('CREATE TABLE null_probe (a INT NULL, CONSTRAINT chk_a CHECK (a > 0)) ENGINE=InnoDB');
    await c.query('INSERT INTO null_probe VALUES (NULL)'); // accepted
    const [rows] = await c.query<any[]>('SELECT COUNT(*) AS n FROM null_probe');
    expect(Number(rows[0].n)).toBe(1);
  });

  it('what a CHECK cannot do: read another table, or call a non-deterministic function such as today (spec S4 already says built-ins only)', async () => {
    await c.query('CREATE TABLE ref_t (id INT PRIMARY KEY)');
    const e1 = await errorOf(() => c.query('CREATE TABLE bad1 (a INT, CONSTRAINT x CHECK (a IN (SELECT id FROM ref_t)))'));
    expect(e1).not.toBeNull();
    const e2 = await errorOf(() => c.query('CREATE TABLE bad2 (d DATE, CONSTRAINT y CHECK (d <= CURDATE()))'));
    console.log('[d] CHECK with subquery ->', e1?.errno, e1?.message?.slice(0, 80), '| CHECK with CURDATE() ->', e2?.errno, e2?.message?.slice(0, 80));
    // "paid_on is not in the future" therefore lives in Node (and in the nightly check), not in a CHECK.
  });

  it('a constraint can be dropped and re-added in a transaction-free ALTER (mutation tests in the nightly-check suite need this)', async () => {
    await c.query('ALTER TABLE skus DROP CONSTRAINT chk_sku_sold');
    await c.query("INSERT INTO skus (id, status) VALUES (?, 'Sold')", [randomUUID()]); // now the damage is possible
    await c.query("DELETE FROM skus WHERE status = 'Sold' AND sold_bill_id IS NULL");
    await c.query('ALTER TABLE skus ADD CONSTRAINT chk_sku_sold CHECK ((status = \'Sold\') = (sold_bill_id IS NOT NULL))');
    const [rows] = await c.query<any[]>(
      "SELECT CONSTRAINT_NAME FROM information_schema.CHECK_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'skus' ORDER BY 1"
    );
    expect(rows.map((r) => r.CONSTRAINT_NAME)).toEqual(['chk_sku_archived', 'chk_sku_sold', 'chk_sku_status', 'chk_sku_weights']);
  });
});

describe('(d2) UUID: native type vs CHAR(36)', () => {
  it('UUID type exists in 11.8, validates the text, stores 16 bytes and comes back as lower-case hyphenated text', async () => {
    await c.query('CREATE TABLE u_native (id UUID NOT NULL PRIMARY KEY, n INT) ENGINE=InnoDB');
    const id = randomUUID();
    await c.query('INSERT INTO u_native VALUES (?, 1)', [id.toUpperCase()]);
    const [rows] = await c.query<any[]>('SELECT id, LENGTH(id) AS l_text, OCTET_LENGTH(CAST(id AS BINARY)) AS bytes FROM u_native');
    expect(rows[0].id).toBe(id); // normalised to lower case
    expect(typeof rows[0].id).toBe('string');
    const bad = await errorOf(() => c.query("INSERT INTO u_native VALUES ('not-a-uuid', 2)"));
    expect(bad).not.toBeNull();
    console.log('[d] invalid uuid ->', bad?.errno, bad?.message);
    // the fixed walk-in id of the spec (K5) is accepted
    await c.query("INSERT INTO u_native VALUES ('00000000-0000-4000-8000-000000000001', 3)");
    // the server can make them too: UUID() (v1), UUID_v4(), UUID_v7() exist in 11.8
    const [gen] = await c.query<any[]>('SELECT UUID_v4() AS v4, UUID_v7() AS v7');
    expect(gen[0].v4).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(gen[0].v7).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('a UUID column can be a primary key, a foreign key target, and can join to a CHAR(36)? (it cannot be an FK to one)', async () => {
    await c.query('CREATE TABLE u_parent (id UUID NOT NULL PRIMARY KEY) ENGINE=InnoDB');
    await c.query('CREATE TABLE u_child (id INT AUTO_INCREMENT PRIMARY KEY, parent_id UUID NOT NULL, FOREIGN KEY (parent_id) REFERENCES u_parent (id) ON DELETE RESTRICT) ENGINE=InnoDB');
    const p = randomUUID();
    await c.query('INSERT INTO u_parent VALUES (?)', [p]);
    await c.query('INSERT INTO u_child (parent_id) VALUES (?)', [p]);
    const e1 = await errorOf(() => c.query('INSERT INTO u_child (parent_id) VALUES (?)', [randomUUID()]));
    expect(e1?.errno).toBe(ER.NO_REFERENCED_ROW);
    const e2 = await errorOf(() => c.query('DELETE FROM u_parent WHERE id = ?', [p]));
    expect(e2?.errno).toBe(ER.ROW_IS_REFERENCED);
    await c.query('CREATE TABLE c36_parent (id CHAR(36) NOT NULL PRIMARY KEY) ENGINE=InnoDB');
    const e3 = await errorOf(() => c.query('CREATE TABLE mixed_child (parent_id UUID NOT NULL, FOREIGN KEY (parent_id) REFERENCES c36_parent (id)) ENGINE=InnoDB'));
    expect(e3).not.toBeNull(); // mixing the two types in one relationship is refused: pick one type for the whole schema
    console.log('[d] FK UUID -> CHAR(36) ->', e3?.errno, e3?.message?.slice(0, 90));
  });

  it('size and speed of 50,000 random (v4) ids: UUID vs CHAR(36) (random inserts, primary key)', async () => {
    await c.query('CREATE TABLE u_bench_native (id UUID NOT NULL PRIMARY KEY, p VARCHAR(10) NOT NULL DEFAULT \'x\') ENGINE=InnoDB');
    await c.query('CREATE TABLE u_bench_char (id CHAR(36) CHARACTER SET ascii COLLATE ascii_general_ci NOT NULL PRIMARY KEY, p VARCHAR(10) NOT NULL DEFAULT \'x\') ENGINE=InnoDB');
    const ids = Array.from({ length: 50000 }, () => [randomUUID()]);
    const time = async (table: string) => {
      const t0 = Date.now();
      for (let i = 0; i < ids.length; i += 5000) await c.query(`INSERT INTO ${table} (id) VALUES ?`, [ids.slice(i, i + 5000)]);
      return Date.now() - t0;
    };
    const msNative = await time('u_bench_native');
    const msChar = await time('u_bench_char');
    await c.query('ANALYZE TABLE u_bench_native, u_bench_char');
    const [sizes] = await c.query<any[]>(
      "SELECT TABLE_NAME AS t, DATA_LENGTH AS data_bytes FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('u_bench_native','u_bench_char') ORDER BY 1"
    );
    console.log('[d] 50k rows -> insert ms: native', msNative, 'char36', msChar, '| clustered size bytes:', JSON.stringify(sizes));
    const [look] = await c.query<any[]>('SELECT COUNT(*) AS n FROM u_bench_native WHERE id = ?', [ids[777][0]]);
    expect(Number(look[0].n)).toBe(1);
  });

  it('"unique ignoring case" for text codes (design_no, sku_no, barcode) works with the default utf8mb4_unicode_ci collation', async () => {
    await c.query('CREATE TABLE codes (code VARCHAR(64) NOT NULL, UNIQUE KEY uq_code (code)) ENGINE=InnoDB');
    await c.query("INSERT INTO codes VALUES ('JW-00001-001')");
    const err = await errorOf(() => c.query("INSERT INTO codes VALUES ('jw-00001-001')"));
    expect(err?.errno).toBe(ER.DUP_ENTRY);
    // trailing spaces: PAD SPACE collations treat 'abc' and 'abc ' as equal, so Node trims first
    const err2 = await errorOf(() => c.query("INSERT INTO codes VALUES ('JW-00001-001 ')"));
    console.log('[d] trailing space duplicate ->', err2?.errno ?? 'accepted');
  });
});

describe('(d3) JSON columns', () => {
  it('JSON is an alias for LONGTEXT + JSON_VALID: invalid text is refused by a CHECK, and the type is not a real json type', async () => {
    await c.query('CREATE TABLE j_probe (id INT PRIMARY KEY, doc JSON NOT NULL) ENGINE=InnoDB');
    const [def] = await c.query<any[]>('SHOW CREATE TABLE j_probe');
    expect(JSON.stringify(def[0])).toContain('longtext');
    expect(JSON.stringify(def[0]).toLowerCase()).toContain('json_valid');
    const err = await errorOf(() => c.query("INSERT INTO j_probe VALUES (1, '{broken')"));
    expect(err?.errno).toBe(ER.CHECK_FAILED);
  });

  it('what mysql2 does with it: returns a parsed object on this server pair; always send JSON.stringify(...) in; money inside JSON must be a string', async () => {
    const doc = { b: 1, a: '257611.81', tags: ['kundan', 'set'], big: '12345678901234567.89' };
    await c.query('INSERT INTO j_probe VALUES (2, ?)', [JSON.stringify(doc)]);
    const [rows] = await c.query<any[]>('SELECT doc FROM j_probe WHERE id = 2');
    console.log('[d] JSON column comes back as', typeof rows[0].doc);
    const back = typeof rows[0].doc === 'string' ? JSON.parse(rows[0].doc) : rows[0].doc;
    expect(back).toEqual(doc);
    expect(Object.keys(back)).toEqual(['b', 'a', 'tags', 'big']); // text is stored as written: key order is kept (unlike MySQL's binary JSON)
    // numbers inside JSON become JS doubles on the way out, strings do not
    await c.query('INSERT INTO j_probe VALUES (3, ?)', ['{"amount": 12345678901234567.89}']);
    const [r3] = await c.query<any[]>('SELECT doc, JSON_VALUE(doc, \'$.amount\') AS exact_text FROM j_probe WHERE id = 3');
    const parsed = typeof r3[0].doc === 'string' ? JSON.parse(r3[0].doc) : r3[0].doc;
    expect(String(parsed.amount)).not.toBe('12345678901234567.89'); // precision lost in JS
    expect(r3[0].exact_text).toBe('12345678901234567.89'); // the database still has it exactly
  });

  it('a JS object passed as a parameter is NOT turned into JSON by mysql2 (query() expands it into col = val pairs): a classic trap', async () => {
    const err = await errorOf(() => c.query('INSERT INTO j_probe VALUES (4, ?)', [{ a: 1 }]));
    expect(err).not.toBeNull(); // syntax error / invalid JSON rather than a stored object
  });

  it('JSON functions needed by the spec exist: JSON_VALUE, JSON_EXTRACT, JSON_TYPE, JSON_ARRAYAGG, JSON_TABLE (unpack p_items), and an array CHECK for tags', async () => {
    await c.query("CREATE TABLE designs_probe (id INT PRIMARY KEY, tags JSON NOT NULL, CONSTRAINT chk_tags CHECK (JSON_TYPE(tags) = 'ARRAY')) ENGINE=InnoDB");
    await c.query("INSERT INTO designs_probe VALUES (1, '[\"a\",\"b\"]')");
    const e = await errorOf(() => c.query("INSERT INTO designs_probe VALUES (2, '{\"a\":1}')"));
    expect(e?.errno).toBe(ER.CHECK_FAILED);
    const [t] = await c.query<any[]>(
      `SELECT jt.sku_id, jt.rate FROM JSON_TABLE('[{"sku_id":"s1","rate":"6920.00"},{"sku_id":"s2","rate":"70.5"}]', '$[*]' COLUMNS (sku_id VARCHAR(10) PATH '$.sku_id', rate DECIMAL(12,2) PATH '$.rate')) jt`
    );
    expect(t.map((r) => [r.sku_id, r.rate])).toEqual([['s1', '6920.00'], ['s2', '70.50']]);
    const [agg] = await c.query<any[]>("SELECT JSON_ARRAYAGG(id) AS ids FROM designs_probe");
    expect(JSON.stringify(agg[0].ids)).toContain('1');
  });
});

describe('(d4) generated columns', () => {
  it('PERSISTENT generated column + UNIQUE = a partial unique index: exactly one walk-in customer (spec D10)', async () => {
    await c.query(`CREATE TABLE customers (
      id UUID NOT NULL PRIMARY KEY, name VARCHAR(120) NOT NULL, is_walkin TINYINT(1) NOT NULL DEFAULT 0,
      walkin_key TINYINT AS (IF(is_walkin = 1, 1, NULL)) PERSISTENT,
      UNIQUE KEY uq_one_walkin (walkin_key)
    ) ENGINE=InnoDB`);
    await c.query("INSERT INTO customers (id, name, is_walkin) VALUES ('00000000-0000-4000-8000-000000000001', 'Walk-in Customer', 1)");
    for (let i = 0; i < 5; i++) await c.query("INSERT INTO customers (id, name) VALUES (?, 'Regular')", [randomUUID()]); // many NULL keys are fine
    const err = await errorOf(() => c.query("INSERT INTO customers (id, name, is_walkin) VALUES (?, 'Second', 1)", [randomUUID()]));
    expect(err?.errno).toBe(ER.DUP_ENTRY);
    expect(err?.message).toContain('uq_one_walkin');
  });

  it('a unique key that only counts ACTIVE rows (one live line per piece), freed when the bill is cancelled (spec I2 as a constraint)', async () => {
    await c.query(`CREATE TABLE bill_items (
      id BIGINT AUTO_INCREMENT PRIMARY KEY, bill_id INT NOT NULL, sku_id UUID NOT NULL, is_live TINYINT(1) NOT NULL DEFAULT 1,
      live_sku UUID AS (IF(is_live = 1, sku_id, NULL)) PERSISTENT,
      UNIQUE KEY uq_one_live_line_per_sku (live_sku)
    ) ENGINE=InnoDB`);
    const sku = randomUUID();
    await c.query('INSERT INTO bill_items (bill_id, sku_id) VALUES (1, ?)', [sku]);
    const err = await errorOf(() => c.query('INSERT INTO bill_items (bill_id, sku_id) VALUES (2, ?)', [sku]));
    expect(err?.errno).toBe(ER.DUP_ENTRY);
    await c.query('UPDATE bill_items SET is_live = 0 WHERE bill_id = 1'); // the bill was cancelled
    await c.query('INSERT INTO bill_items (bill_id, sku_id) VALUES (2, ?)', [sku]); // the piece can be sold again
  });

  it('a generated column can be indexed, used in a CHECK, and a VIRTUAL one costs no storage', async () => {
    await c.query(`CREATE TABLE gen_probe (
      id INT PRIMARY KEY, metal DECIMAL(14,2) NOT NULL, labour DECIMAL(14,2) NOT NULL,
      line_total DECIMAL(14,2) AS (metal + labour) VIRTUAL,
      KEY ix_total (line_total),
      CONSTRAINT chk_total CHECK (metal + labour <= 1000000000.00)
    ) ENGINE=InnoDB`);
    await c.query("INSERT INTO gen_probe (id, metal, labour) VALUES (1, 245106.40, 12503.26)");
    const [r] = await c.query<any[]>('SELECT line_total FROM gen_probe WHERE line_total = 257609.66');
    expect(r[0].line_total).toBe('257609.66');
    const err = await errorOf(() => c.query('INSERT INTO gen_probe (id, metal, labour, line_total) VALUES (2, 1, 1, 5)'));
    expect(err).not.toBeNull(); // cannot be written directly
  });
});

describe('(d5) things the schema will meet that are easy to miss', () => {
  it('RESERVED WORDS: which spec column/table names need back-ticks or a rename', async () => {
    const candidates = [
      'key', 'value', 'status', 'role', 'active', 'kind', 'mode', 'amount', 'reference', 'notes', 'reason', 'tags', 'level',
      'at', 'action', 'actor', 'series', 'material', 'purity', 'location', 'barcode', 'stones', 'kundan', 'piroi', 'discount',
      'version', 'window', 'interval', 'rows', 'row', 'lines', 'groups', 'system', 'data', 'result', 'fn', 'text', 'name',
      'type', 'date', 'condition', 'order', 'rank', 'release', 'usage', 'generated', 'range', 'read', 'write', 'schema',
    ];
    const reserved: string[] = [];
    for (const w of candidates) {
      const err = await errorOf(() => c.query(`CREATE TABLE rw_probe (${w} INT)`));
      if (err) reserved.push(w);
      else await c.query('DROP TABLE rw_probe');
    }
    console.log('[d] reserved (unquoted use fails):', reserved.join(', '));
    expect(reserved).toContain('lines');
    expect(reserved).toContain('key');
  });

  it('timestamps: DATETIME(6) with ON UPDATE CURRENT_TIMESTAMP(6); NOW() is fixed per statement, SYSDATE() is the real clock; keyset order (updated_at, id)', async () => {
    await c.query(`CREATE TABLE ts_probe (
      id INT AUTO_INCREMENT PRIMARY KEY, v INT NOT NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      KEY ix_poll (updated_at, id)
    ) ENGINE=InnoDB`);
    await c.query('INSERT INTO ts_probe (v) VALUES (1)');
    const [before] = await c.query<any[]>('SELECT updated_at FROM ts_probe WHERE id = 1');
    expect(before[0].updated_at).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{6}$/);
    await c.query('UPDATE ts_probe SET v = 2 WHERE id = 1');
    const [after] = await c.query<any[]>('SELECT updated_at FROM ts_probe WHERE id = 1');
    expect(after[0].updated_at > before[0].updated_at).toBe(true);
    await c.query('START TRANSACTION');
    const [[n1]] = await c.query<any[][]>('SELECT NOW(6) AS t');
    await new Promise((r) => setTimeout(r, 30));
    const [[n2]] = await c.query<any[][]>('SELECT NOW(6) AS t, SYSDATE(6) AS s');
    await c.query('ROLLBACK');
    expect((n2 as any).t > (n1 as any).t).toBe(true); // NOW() is per STATEMENT here (Postgres now() was per transaction)
    expect((n2 as any).s >= (n2 as any).t).toBe(true);
  });

  it('triggers: the app user can create them here (log_bin is off locally); a BEFORE UPDATE trigger can refuse with SIGNAL (spec A8: nobody changes their own role)', async () => {
    const [bin] = await c.query<any[]>('SELECT @@log_bin AS log_bin, @@log_bin_trust_function_creators AS trust');
    console.log('[d] local log_bin =', bin[0].log_bin, ', log_bin_trust_function_creators =', bin[0].trust, '(Hostinger values NOT yet known)');
    await c.query("CREATE TABLE profiles (id INT PRIMARY KEY, role VARCHAR(10) NOT NULL, active TINYINT(1) NOT NULL) ENGINE=InnoDB");
    await c.query(`CREATE TRIGGER trg_profiles_role BEFORE UPDATE ON profiles FOR EACH ROW
      BEGIN
        IF NEW.role <> OLD.role AND @jv_actor = OLD.id THEN
          SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'JV_FORBIDDEN: nobody changes their own role';
        END IF;
      END`);
    await c.query("INSERT INTO profiles VALUES (1, 'owner', 1)");
    await c.query('SET @jv_actor = 1');
    const err = await errorOf(() => c.query("UPDATE profiles SET role = 'staff' WHERE id = 1"));
    expect(err?.errno).toBe(1644);
    expect(err?.message).toContain('JV_FORBIDDEN');
    await c.query('SET @jv_actor = 2');
    await c.query("UPDATE profiles SET role = 'biller' WHERE id = 1");
  });

  it('the app user is not SUPER: it cannot change global settings (so only SESSION settings are available on Hostinger)', async () => {
    const err = await errorOf(() => c.query('SET GLOBAL innodb_lock_wait_timeout = 5'));
    expect(err).not.toBeNull();
    const err2 = await errorOf(() => c.query('SET GLOBAL transaction_isolation = "SERIALIZABLE"'));
    expect(err2).not.toBeNull();
    const root = await rootConn();
    const [v] = await root.query<any[]>('SELECT VERSION() AS v');
    await root.end();
    expect(v[0].v).toMatch(/^11\.8\./);
  });
});
