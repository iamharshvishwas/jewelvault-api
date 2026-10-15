import mysql from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP_USER, HOST, PORT, appConn, dropDb, errorOf, freshDb, rootConn, sleep } from './helpers';

// Facts read from Harsh's Hostinger (phpMyAdmin + hPanel, 15 Oct 2026, read only) turned into tests against the local MariaDB:
//   wait_timeout = interactive_timeout = 20 s, sql_mode = NO_AUTO_CREATE_USER,NO_ENGINE_SUBSTITUTION (NOT strict),
//   max_statement_time = 120 s, max_user_connections = 75, log_bin = OFF, event_scheduler = OFF, isolation READ-COMMITTED.

let db: string;
beforeAll(async () => {
  db = await freshDb('h_hostinger');
});
afterAll(async () => {
  await dropDb(db);
});

describe('Hostinger server values reproduced locally', () => {
  it('a server that kills idle connections after a few seconds: the mysql2 pool replaces a dead idle connection without an error', async () => {
    const root = await rootConn();
    await root.query('SET GLOBAL wait_timeout = 2'); // Hostinger: 20; shortened so the test is quick. New connections only.
    const pool = mysql.createPool({ host: HOST, port: PORT, user: APP_USER, password: 'spike_app_only', database: db, connectionLimit: 3 });
    try {
      const [a] = await pool.query<any[]>('SELECT CONNECTION_ID() AS id');
      await sleep(3500); // longer than wait_timeout: the server has closed that connection
      const [b] = await pool.query<any[]>('SELECT CONNECTION_ID() AS id');
      console.log('[h] connection ids before/after the idle kill:', a[0].id, b[0].id);
      expect(b[0].id).not.toBe(a[0].id);
    } finally {
      await pool.end();
      await root.query('SET GLOBAL wait_timeout = 28800');
      await root.end();
    }
  });

  it('a held transaction connection that the server kills: the statement fails, the wrapper cannot roll back, nothing is committed', async () => {
    const root = await rootConn();
    await root.query('SET GLOBAL wait_timeout = 2');
    const c = await appConn(db);
    await c.query('CREATE TABLE idle_probe (id INT PRIMARY KEY)');
    await c.query('START TRANSACTION');
    await c.query('INSERT INTO idle_probe VALUES (1)');
    await root.query('SET GLOBAL wait_timeout = 28800');
    // the session keeps the 2 s value it got at connect time; ask for it explicitly to be deterministic
    await c.query('SET SESSION wait_timeout = 1');
    await sleep(2500);
    const e1 = await errorOf(() => c.query('INSERT INTO idle_probe VALUES (2)'));
    expect(e1).not.toBeNull();
    const e2 = await errorOf(() => c.query('ROLLBACK'));
    expect(e2).not.toBeNull(); // so runTx must swallow a failing ROLLBACK (it does)
    const check = await appConn(db);
    const [r] = await check.query<any[]>('SELECT COUNT(*) AS n FROM idle_probe');
    expect(Number(r[0].n)).toBe(0);
    await check.end();
    await root.end();
  });

  it('a normal user can raise wait_timeout and set max_statement_time for its own session (no SUPER needed)', async () => {
    const c = await appConn(db);
    await c.query('SET SESSION wait_timeout = 300');
    await c.query('SET SESSION max_statement_time = 15');
    await c.query('SET SESSION innodb_lock_wait_timeout = 5');
    const [r] = await c.query<any[]>('SELECT @@wait_timeout AS w, @@max_statement_time AS m, @@innodb_lock_wait_timeout AS l');
    expect([Number(r[0].w), Number(r[0].m), Number(r[0].l)]).toEqual([300, 15, 5]);
    await c.end();
  });

  it('with Hostinger\'s non-strict sql_mode the damage is silent: over-range is clamped, a bad number becomes 0 (so every connection sets a strict mode)', async () => {
    const c = await appConn(db);
    await c.query("SET SESSION sql_mode = 'NO_AUTO_CREATE_USER,NO_ENGINE_SUBSTITUTION'"); // Hostinger's global value
    await c.query('CREATE TABLE lax_probe (amount DECIMAL(14,2) NOT NULL, qty INT NOT NULL, name VARCHAR(5) NOT NULL)');
    await c.query("INSERT INTO lax_probe VALUES ('99999999999999', 'abc', 'toolongvalue')");
    const [r] = await c.query<any[]>('SELECT amount, qty, name FROM lax_probe');
    expect(r[0]).toEqual({ amount: '999999999999.99', qty: 0, name: 'toolo' }); // clamped, zeroed, cut
    await c.query("SET SESSION sql_mode = 'STRICT_TRANS_TABLES,ERROR_FOR_DIVISION_BY_ZERO,NO_AUTO_CREATE_USER,NO_ENGINE_SUBSTITUTION'");
    const e = await errorOf(() => c.query("INSERT INTO lax_probe VALUES ('1', 'abc', 'x')"));
    expect(e).not.toBeNull(); // strict mode refuses the bad integer
    await c.end();
  });

  it('privileges that hPanel can untick: with DELETE and DROP removed, DELETE, DROP TABLE and TRUNCATE are refused, everything else works', async () => {
    const root = await rootConn(db);
    await root.query('CREATE TABLE audit_probe (id INT AUTO_INCREMENT PRIMARY KEY, v INT)');
    await root.query("CREATE USER IF NOT EXISTS 'jv_runtime'@'%' IDENTIFIED BY 'runtime_only'");
    await root.query(
      `GRANT ALTER, CREATE VIEW, INDEX, SELECT, CREATE, INSERT, SHOW VIEW, ALTER ROUTINE, CREATE ROUTINE, LOCK TABLES, TRIGGER, CREATE TEMPORARY TABLES, EXECUTE, REFERENCES, UPDATE, EVENT ON \`${db}\`.* TO 'jv_runtime'@'%'`
    );
    await root.end();
    const rt = await mysql.createConnection({ host: HOST, port: PORT, user: 'jv_runtime', password: 'runtime_only', database: db });
    await rt.query('INSERT INTO audit_probe (v) VALUES (1)');
    await rt.query('UPDATE audit_probe SET v = 2');
    await rt.query('CREATE TABLE made_by_runtime (id INT)');
    const e1 = await errorOf(() => rt.query('DELETE FROM audit_probe'));
    const e2 = await errorOf(() => rt.query('DROP TABLE made_by_runtime'));
    const e3 = await errorOf(() => rt.query('TRUNCATE TABLE audit_probe'));
    expect([e1?.errno, e2?.errno, e3?.errno]).toEqual([1142, 1142, 1142]);
    await rt.end();
    const r2 = await rootConn();
    await r2.query("DROP USER IF EXISTS 'jv_runtime'@'%'");
    await r2.end();
  });
});
