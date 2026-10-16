import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import mysql from 'mysql2/promise';
import { readdirSync, readFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { HOST, PORT, appConn, dropDb, errorOf, freshDb, rootConn } from '../helpers';
import { checkSql, listMigrations, migrate, splitStatements } from '../../scripts/migrate.mjs';
import { migrationConn } from './support';

// Spec S9, S7, A3, A7 and T-F04: migrations are create-only. With Delete and Drop unticked (and Create view, Show view, Execute, Create routine, Alter routine and Event too),
// a view can be created once and never changed, so there are none; the runner reads every file BEFORE it runs anything and refuses a statement outside the allowed list.

const dirs: string[] = [];
const dbs: string[] = [];
afterAll(async () => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  for (const d of dbs) await dropDb(d);
});
const refused = (sql: string, kind: 'migration' | 'seed' | 'trigger' = 'migration') => checkSql(sql, kind);

describe('splitStatements', () => {
  it('splits on ; outside quotes and comments, and drops the comments', () => {
    expect(splitStatements("-- a ; comment\nCREATE TABLE a (x INT); /* b ; c */ INSERT IGNORE INTO t VALUES ('a;b', \"c;d\", `e;f`);\n# note;\nANALYZE TABLE a")).toEqual([
      'CREATE TABLE a (x INT)',
      "INSERT IGNORE INTO t VALUES ('a;b', \"c;d\", `e;f`)",
      'ANALYZE TABLE a',
    ]);
  });
  it('knows a doubled quote and a backslash inside a string', () => {
    expect(splitStatements("INSERT IGNORE INTO t VALUES ('it''s; ok', 'back\\'; slash'); ANALYZE TABLE t")).toHaveLength(2);
  });
});

describe('what a migration may hold (S9, allowed list), each in its re-runnable IF [NOT] EXISTS form', () => {
  it.each([
    'CREATE TABLE IF NOT EXISTS a (id INT PRIMARY KEY)',
    'CREATE INDEX IF NOT EXISTS ix_a ON a (id)',
    'CREATE UNIQUE INDEX IF NOT EXISTS ix_a ON a (id)',
    'ALTER TABLE a ADD COLUMN IF NOT EXISTS b INT NULL',
    'ALTER TABLE a ADD COLUMN IF NOT EXISTS b INT NULL, ADD INDEX IF NOT EXISTS ix_b (b)',
    'ALTER TABLE a ADD UNIQUE IF NOT EXISTS uq_b (b)',
    'ALTER TABLE a ADD UNIQUE KEY IF NOT EXISTS uq_b (b)',
    'ALTER TABLE a ADD CONSTRAINT IF NOT EXISTS chk_b CHECK (b > 0)',
    'ALTER TABLE a ADD FOREIGN KEY IF NOT EXISTS fk_b (b) REFERENCES c (id) ON DELETE RESTRICT ON UPDATE RESTRICT',
    'ALTER TABLE a MODIFY COLUMN b BIGINT NULL',
    'ALTER TABLE a DROP CONSTRAINT IF EXISTS chk_b, ADD CONSTRAINT IF NOT EXISTS chk_b CHECK (b > 1)',
    'ALTER TABLE a DROP FOREIGN KEY IF EXISTS fk_b',
    'ALTER TABLE a DROP INDEX IF EXISTS ix_b',
    "INSERT IGNORE INTO t (a) VALUES (1)",
    "INSERT INTO t (a) VALUES (1) ON DUPLICATE KEY UPDATE a = a",
    "INSERT INTO t (a) SELECT x FROM y ON DUPLICATE KEY UPDATE t.a = t.a",
    'ANALYZE TABLE a',
  ])('allowed: %s', (sql) => {
    expect(refused(sql)).toEqual([]);
  });

  it('a trigger file may hold DROP TRIGGER IF EXISTS and CREATE TRIGGER IF NOT EXISTS, and a migration file may not', () => {
    const t = "DROP TRIGGER IF EXISTS trg_x;\nCREATE TRIGGER IF NOT EXISTS trg_x BEFORE UPDATE ON a FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'no'";
    expect(refused(t, 'trigger')).toEqual([]);
    expect(refused(t, 'migration').map((v) => v.reason).join(' ')).toMatch(/trigger files/);
  });

  it('seed files hold INSERT IGNORE and INSERT ... ON DUPLICATE KEY UPDATE; a plain INSERT is refused (it would fail the second time)', () => {
    expect(refused("INSERT IGNORE INTO t VALUES (1)", 'seed')).toEqual([]);
    expect(refused("INSERT INTO t VALUES (1)", 'seed')).toHaveLength(1);
  });
});

describe('an allowed statement WITHOUT its IF [NOT] EXISTS form is refused too: every file must be re-runnable on a half-applied database (RF5-13)', () => {
  it.each([
    'CREATE TABLE a (id INT PRIMARY KEY)',
    'CREATE INDEX ix_a ON a (id)',
    'CREATE UNIQUE INDEX ix_a ON a (id)',
    'ALTER TABLE a ADD COLUMN b INT NULL',
    'ALTER TABLE a ADD b INT NULL',
    'ALTER TABLE a ADD INDEX ix_b (b)',
    'ALTER TABLE a ADD KEY ix_b (b)',
    'ALTER TABLE a ADD UNIQUE KEY uq_b (b)',
    'ALTER TABLE a ADD UNIQUE uq_b (b)',
    'ALTER TABLE a ADD CONSTRAINT chk_b CHECK (b > 0)',
    'ALTER TABLE a ADD CHECK (b > 0)',
    'ALTER TABLE a ADD FOREIGN KEY fk_b (b) REFERENCES c (id)',
    'ALTER TABLE a ADD CONSTRAINT fk_b FOREIGN KEY (b) REFERENCES c (id)',
    'ALTER TABLE a DROP CONSTRAINT chk_b',
    'ALTER TABLE a DROP FOREIGN KEY fk_b',
    'ALTER TABLE a DROP INDEX ix_b',
    'ALTER TABLE a DROP KEY ix_b',
    'ALTER TABLE a ADD COLUMN IF NOT EXISTS b INT NULL, ADD INDEX ix_b (b)', // one clause in the right form does not excuse the next
  ])('refused: %s', (sql) => {
    const v = refused(sql);
    expect(v, sql).toHaveLength(1);
    expect(v[0].reason).toMatch(/IF (NOT )?EXISTS/);
  });
  it('ADD CONSTRAINT IF NOT EXISTS ... FOREIGN KEY is a syntax error in MariaDB (1064): the runner says to write ADD FOREIGN KEY IF NOT EXISTS', () => {
    const v = refused('ALTER TABLE a ADD CONSTRAINT IF NOT EXISTS fk_b FOREIGN KEY (b) REFERENCES c (id)');
    expect(v).toHaveLength(1);
    expect(v[0].reason).toMatch(/ADD FOREIGN KEY IF NOT EXISTS/);
  });
  it('trigger files: CREATE TRIGGER and DROP TRIGGER without their IF forms are refused', () => {
    expect(refused("CREATE TRIGGER trg_x BEFORE UPDATE ON a FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'no'", 'trigger')[0].reason).toMatch(/IF NOT EXISTS/);
    expect(refused('DROP TRIGGER trg_x', 'trigger')[0].reason).toMatch(/IF EXISTS/);
  });
  it('the allowed forms really are re-runnable: each runs twice on MariaDB as the ten-box user without an error', async () => {
    const db = await freshDb('s16_twice');
    dbs.push(db);
    const root = await rootConn();
    await root.query("CREATE USER IF NOT EXISTS 'jv_a3t'@'%' IDENTIFIED BY 'spike_a3t_only'");
    await root.query(`GRANT SELECT, INSERT, UPDATE, CREATE, ALTER, INDEX, REFERENCES, TRIGGER ON \`${db}\`.* TO 'jv_a3t'@'%'`);
    const u = await mysql.createConnection({ host: HOST, port: PORT, user: 'jv_a3t', password: 'spike_a3t_only', database: db, multipleStatements: true });
    const sql = [
      'CREATE TABLE IF NOT EXISTS p (id INT PRIMARY KEY) ENGINE=InnoDB',
      'CREATE TABLE IF NOT EXISTS t (id INT PRIMARY KEY, b INT NULL) ENGINE=InnoDB',
      'CREATE INDEX IF NOT EXISTS ix_t_b ON t (b)',
      'CREATE UNIQUE INDEX IF NOT EXISTS uq_t_b ON t (b)',
      'ALTER TABLE t ADD COLUMN IF NOT EXISTS c INT NULL, ADD INDEX IF NOT EXISTS ix_t_c (c)',
      'ALTER TABLE t ADD UNIQUE IF NOT EXISTS uq_t_c (c)',
      'ALTER TABLE t ADD CONSTRAINT IF NOT EXISTS chk_t_c CHECK (c IS NULL OR c > 0)',
      'ALTER TABLE t ADD FOREIGN KEY IF NOT EXISTS fk_t_b (b) REFERENCES p (id) ON DELETE RESTRICT ON UPDATE RESTRICT',
      'ALTER TABLE t MODIFY COLUMN c BIGINT NULL',
      'ALTER TABLE t DROP CONSTRAINT IF EXISTS chk_t_c',
      'ALTER TABLE t DROP INDEX IF EXISTS ix_t_c',
      'ALTER TABLE t DROP FOREIGN KEY IF EXISTS fk_t_b',
      'ANALYZE TABLE t',
    ];
    for (const st of sql) expect(checkSql(st, 'migration'), st).toEqual([]);
    for (let round = 0; round < 2; round++) for (const st of sql) await u.query(st);
    await u.end();
    await root.query("DROP USER IF EXISTS 'jv_a3t'@'%'");
    await root.end();
  });
});

describe('what a migration may not hold (S9, refused by MariaDB itself with 1142, or by the runner)', () => {
  it.each([
    ['DROP TABLE a', /DROP/],
    ['DROP TABLE IF EXISTS a', /DROP/],
    ['DROP VIEW v', /DROP/],
    ['DROP DATABASE d', /DROP/],
    ['RENAME TABLE a TO b', /RENAME/],
    ['ALTER TABLE a RENAME TO b', /RENAME/],
    ['ALTER TABLE a RENAME COLUMN b TO c', /RENAME/],
    ['ALTER TABLE a DROP COLUMN b', /DROP COLUMN/],
    ['ALTER TABLE a CHANGE COLUMN b c INT', /CHANGE/],
    ['ALTER TABLE a DROP PRIMARY KEY', /PRIMARY KEY/],
    ['CREATE OR REPLACE TABLE a (id INT)', /OR REPLACE/],
    ['CREATE OR REPLACE VIEW v AS SELECT 1', /OR REPLACE|VIEW/],
    ['CREATE VIEW v AS SELECT 1', /VIEW/],
    ['ALTER VIEW v AS SELECT 1', /VIEW/],
    ['REPLACE INTO a VALUES (1)', /REPLACE/],
    ['TRUNCATE TABLE a', /TRUNCATE/],
    ['DELETE FROM a', /DELETE/],
    ['UPDATE a SET b = 1', /UPDATE/],
    ['CREATE PROCEDURE p() SELECT 1', /not in the allowed list/],
    ['CREATE EVENT e ON SCHEDULE EVERY 1 DAY DO SELECT 1', /not in the allowed list/],
    ['SET GLOBAL event_scheduler = ON', /not in the allowed list/],
  ])('refused: %s', (sql, why) => {
    const v = refused(sql);
    expect(v, sql).toHaveLength(1);
    expect(v[0].reason).toMatch(why);
    expect(v[0].statement).toContain(sql.split(' ')[0]);
  });

  it('a refused statement hidden after an allowed one, or after a comment, is still found', () => {
    expect(refused('-- harmless\nCREATE TABLE IF NOT EXISTS a (id INT);\n/* x */ drop table a;')).toHaveLength(1);
    expect(refused('create table if not exists a (id int); delete from a')).toHaveLength(1);
  });

  it('a refused word inside a string, a comment or a column name is not a statement', () => {
    expect(refused("CREATE TABLE IF NOT EXISTS a (note VARCHAR(20) DEFAULT 'DROP TABLE x', delete_flag INT) -- DELETE FROM a")).toEqual([]);
  });
});

describe('the repository\'s own SQL files obey it', () => {
  const root = path.join(__dirname, '..', '..', 'db');
  const files = (sub: string) => readdirSync(path.join(root, sub)).filter((f) => f.endsWith('.sql')).map((f) => ({ f: `${sub}/${f}`, sql: readFileSync(path.join(root, sub, f), 'utf8') }));
  it.each([['migrations', 'migration'], ['seeds', 'seed'], ['optional', 'trigger']] as const)('every file in db/%s passes as a %s file', (sub, kind) => {
    for (const { f, sql } of files(sub)) expect(checkSql(sql, kind), f).toEqual([]);
  });
  it('there is no view and no OR REPLACE anywhere in db/migrations (section 11: the four reads are queries)', () => {
    for (const { f, sql } of files('migrations')) expect(sql, f).not.toMatch(/\bVIEW\b|OR\s+REPLACE/i);
  });
});

describe('the runner reads every file before it runs anything', () => {
  it('a bad statement in the second file stops the run with the file named, and the first file was NOT applied', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'jv-mig-'));
    dirs.push(dir);
    writeFileSync(path.join(dir, '0001_a.sql'), 'CREATE TABLE IF NOT EXISTS ok_a (id INT PRIMARY KEY) ENGINE=InnoDB;');
    writeFileSync(path.join(dir, '0002_b.sql'), 'CREATE TABLE IF NOT EXISTS ok_b (id INT PRIMARY KEY) ENGINE=InnoDB;\nDROP TABLE ok_a;');
    const db = await freshDb('s16_runner');
    dbs.push(db);
    const m = await migrationConn(db);
    await expect(migrate(m, { dir, seeds: false })).rejects.toThrow(/0002_b\.sql.*DROP/s);
    const [t] = await m.query<any[]>("SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME LIKE 'ok\\_%'");
    expect(Number(t[0].n)).toBe(0);
    await m.end();
  });

  it('runs on an ordinary connection (no multipleStatements): every file is run statement by statement, so the restore tool and the start-up check can use it', async () => {
    const db = await freshDb('s16_plain');
    dbs.push(db);
    const plain = await appConn(db);
    const r = await migrate(plain, { seeds: true });
    expect(r.applied.length).toBeGreaterThanOrEqual(10);
    expect(Number((((await plain.query<any[]>('SELECT COUNT(*) AS n FROM categories'))[0]) as any[])[0].n)).toBe(15);
    await plain.end();
  });

  it('a file with an allowed re-run form runs twice without change (re-runnable, S9)', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'jv-mig-'));
    dirs.push(dir);
    writeFileSync(path.join(dir, '0001_a.sql'), 'CREATE TABLE IF NOT EXISTS t1 (id INT PRIMARY KEY) ENGINE=InnoDB;\nALTER TABLE t1 ADD COLUMN IF NOT EXISTS b INT NULL;\nCREATE INDEX IF NOT EXISTS ix_b ON t1 (b);');
    const db = await freshDb('s16_rerun');
    dbs.push(db);
    const m = await migrationConn(db);
    await migrate(m, { dir, seeds: false });
    await m.query(listMigrations(dir)[0].sql); // by hand, as after a half-applied run
    expect((await m.query<any[]>('SHOW CREATE TABLE t1'))[0]).toBeTruthy();
    await m.end();
  });
});

describe('as the restricted user of A3 (T-F04)', () => {
  it('every migration, seed and trigger file runs with only the ten ticked boxes: no Delete, Drop, Create view, Show view, Execute, Create routine, Alter routine or Event', async () => {
    const db = await freshDb('s16_user');
    dbs.push(db);
    const root = await rootConn();
    await root.query("CREATE USER IF NOT EXISTS 'jv_a3'@'%' IDENTIFIED BY 'spike_a3_only'");
    await root.query(`GRANT SELECT, INSERT, UPDATE, CREATE, ALTER, INDEX, REFERENCES, TRIGGER, CREATE TEMPORARY TABLES, LOCK TABLES ON \`${db}\`.* TO 'jv_a3'@'%'`);
    const u = await mysql.createConnection({ host: HOST, port: PORT, user: 'jv_a3', password: 'spike_a3_only', database: db, multipleStatements: true, decimalNumbers: false, supportBigNumbers: true, bigNumberStrings: true, dateStrings: true });
    const r = await migrate(u, { seeds: true, optional: true });
    expect(r.applied.length).toBeGreaterThanOrEqual(10);
    // the refused forms, sent directly: MariaDB itself refuses them (1142)
    for (const sql of ['DROP TABLE IF EXISTS customers', 'RENAME TABLE customers TO customers_old', 'TRUNCATE TABLE sys_error_log', 'DELETE FROM sys_error_log', 'REPLACE INTO settings (setting_key, value) VALUES (\'x\', \'1\')']) {
      expect((await errorOf(() => u.query(sql)))?.errno, sql).toBe(1142);
    }
    // a view can be created only with the Create view box, which is unticked: there is none
    expect((await errorOf(() => u.query('CREATE VIEW v_try AS SELECT 1 AS x')))?.errno).toBe(1142);
    // and what the application does needs only select, insert and update
    await u.query("INSERT INTO sys_error_log (level, code, message) VALUES ('error', 'X', 'y')");
    await u.query("UPDATE sys_error_log SET message = 'z' LIMIT 1");
    await u.end();
    await root.query("DROP USER IF EXISTS 'jv_a3'@'%'");
    await root.end();
  });
});
