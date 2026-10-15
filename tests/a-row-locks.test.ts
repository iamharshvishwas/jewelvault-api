import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Connection } from 'mysql2/promise';
import { appConn, dropDb, errorOf, ER, freshDb, rootConn, sleep } from './helpers';

// Spike (a): two connections lock the same customer row with SELECT ... FOR UPDATE under READ-COMMITTED.
// Docs used: innodb_lock_wait_timeout, innodb_rollback_on_timeout, "WAIT and NOWAIT" (MariaDB docs, read 15 Oct 2026).

let db: string;
const open: Connection[] = [];
const c = async () => {
  const x = await appConn(db);
  open.push(x);
  return x;
};
const CUSTOMER = '11111111-1111-4111-8111-111111111111';

beforeAll(async () => {
  db = await freshDb('a_locks');
  const setup = await c();
  await setup.query(`CREATE TABLE customers (
      id CHAR(36) NOT NULL PRIMARY KEY, name VARCHAR(120) NOT NULL, advance DECIMAL(14,2) NOT NULL DEFAULT 0
    ) ENGINE=InnoDB`);
  await setup.query(`CREATE TABLE allocations (
      id INT AUTO_INCREMENT PRIMARY KEY, customer_id CHAR(36) NOT NULL, amount DECIMAL(14,2) NOT NULL
    ) ENGINE=InnoDB`);
  await setup.query(`INSERT INTO customers (id, name, advance) VALUES (?, 'Test Customer', 100.00)`, [CUSTOMER]);
});

afterAll(async () => {
  await Promise.all(open.map((x) => x.end().catch(() => undefined)));
  await dropDb(db);
});

describe('(a) SELECT ... FOR UPDATE on a customer row', () => {
  it('the connections run READ-COMMITTED (Hostinger value)', async () => {
    const x = await c();
    const [rows] = await x.query<any[]>('SELECT @@transaction_isolation AS iso, @@innodb_lock_wait_timeout AS t');
    expect(rows[0].iso).toBe('READ-COMMITTED');
    expect(Number(rows[0].t)).toBe(50);
  });

  it('the second locker WAITS until the first commits, then sees the committed value', async () => {
    const one = await c();
    const two = await c();
    await one.query('START TRANSACTION');
    await one.query('SELECT id FROM customers WHERE id = ? FOR UPDATE', [CUSTOMER]);

    await two.query('START TRANSACTION');
    const started = Date.now();
    let secondReturnedAt = 0;
    const second = two
      .query<any[]>('SELECT advance FROM customers WHERE id = ? FOR UPDATE', [CUSTOMER])
      .then(([rows]) => {
        secondReturnedAt = Date.now();
        return rows;
      });

    await sleep(800);
    expect(secondReturnedAt).toBe(0); // still waiting after 0.8 s
    await one.query('UPDATE customers SET advance = 250.00 WHERE id = ?', [CUSTOMER]);
    await one.query('COMMIT');

    const rows = await second;
    expect(secondReturnedAt - started).toBeGreaterThanOrEqual(750);
    expect(rows[0].advance).toBe('250.00'); // a locking read reads the LATEST committed row, not an old snapshot
    await two.query('ROLLBACK');
    await c().then((x) => x.query('UPDATE customers SET advance = 100.00 WHERE id = ?', [CUSTOMER]));
  });

  it('a plain SELECT is not blocked by a FOR UPDATE (so X0 must lock BEFORE it reads)', async () => {
    const one = await c();
    const two = await c();
    await one.query('START TRANSACTION');
    await one.query('SELECT id FROM customers WHERE id = ? FOR UPDATE', [CUSTOMER]);
    const t0 = Date.now();
    const [rows] = await two.query<any[]>('SELECT advance FROM customers WHERE id = ?', [CUSTOMER]);
    expect(Date.now() - t0).toBeLessThan(500);
    expect(rows[0].advance).toBe('100.00');
    await one.query('ROLLBACK');
  });

  it('timeout: error 1205 / ER_LOCK_WAIT_TIMEOUT / HY000 after innodb_lock_wait_timeout (session value, no privilege needed)', async () => {
    const one = await c();
    const two = await c();
    await two.query('SET SESSION innodb_lock_wait_timeout = 2'); // the app user is not SUPER: session scope is allowed
    await one.query('START TRANSACTION');
    await one.query('SELECT id FROM customers WHERE id = ? FOR UPDATE', [CUSTOMER]);

    await two.query('START TRANSACTION');
    const t0 = Date.now();
    const err = await errorOf(() => two.query('SELECT id FROM customers WHERE id = ? FOR UPDATE', [CUSTOMER]));
    const waited = Date.now() - t0;
    expect(err?.errno).toBe(ER.LOCK_WAIT_TIMEOUT);
    expect(err?.code).toBe('ER_LOCK_WAIT_TIMEOUT');
    expect(err?.sqlState).toBe('HY000');
    expect(waited).toBeGreaterThanOrEqual(1900);
    expect(waited).toBeLessThan(3500);
    await two.query('ROLLBACK');
    await one.query('ROLLBACK');
  });

  it('TRAP: a 1205 rolls back only the failing STATEMENT; earlier statements of the transaction survive a COMMIT', async () => {
    // innodb_rollback_on_timeout is a global, non-dynamic setting (default OFF); Hostinger will not let us change it.
    const root = await rootConn();
    const [g] = await root.query<any[]>('SELECT @@GLOBAL.innodb_rollback_on_timeout AS v');
    await root.end();
    expect(Number(g[0].v)).toBe(0);

    const one = await c();
    const two = await c();
    await two.query('SET SESSION innodb_lock_wait_timeout = 1');
    await one.query('START TRANSACTION');
    await one.query('SELECT id FROM customers WHERE id = ? FOR UPDATE', [CUSTOMER]);

    await two.query('START TRANSACTION');
    await two.query('INSERT INTO allocations (customer_id, amount) VALUES (?, 11.11)', ['trap-row']); // an earlier statement
    const err = await errorOf(() => two.query('SELECT id FROM customers WHERE id = ? FOR UPDATE', [CUSTOMER]));
    expect(err?.errno).toBe(ER.LOCK_WAIT_TIMEOUT);
    // the transaction is still open and still holds the earlier insert:
    const [mid] = await two.query<any[]>("SELECT COUNT(*) AS n FROM allocations WHERE customer_id = 'trap-row'");
    expect(Number(mid[0].n)).toBe(1);
    // A careless caller that now commits keeps the half-done work:
    await two.query('COMMIT');
    const other = await c();
    const [after] = await other.query<any[]>("SELECT COUNT(*) AS n FROM allocations WHERE customer_id = 'trap-row'");
    expect(Number(after[0].n)).toBe(1); // <- the partial write is now permanent
    await other.query("DELETE FROM allocations WHERE customer_id = 'trap-row'");
    await one.query('ROLLBACK');
    // The API therefore ALWAYS issues ROLLBACK on any error (helpers.runTx does).
  });

  it('SELECT ... FOR UPDATE WAIT n sets the timeout per statement; NOWAIT fails at once (both error 1205)', async () => {
    const one = await c();
    const two = await c();
    await one.query('START TRANSACTION');
    await one.query('SELECT id FROM customers WHERE id = ? FOR UPDATE', [CUSTOMER]);

    await two.query('START TRANSACTION');
    let t0 = Date.now();
    const e1 = await errorOf(() => two.query('SELECT id FROM customers WHERE id = ? FOR UPDATE WAIT 1', [CUSTOMER]));
    const waited = Date.now() - t0;
    expect(e1?.errno).toBe(ER.LOCK_WAIT_TIMEOUT);
    expect(waited).toBeGreaterThanOrEqual(900);
    expect(waited).toBeLessThan(2500); // not the 50 s default

    t0 = Date.now();
    const e2 = await errorOf(() => two.query('SELECT id FROM customers WHERE id = ? FOR UPDATE NOWAIT', [CUSTOMER]));
    expect(Date.now() - t0).toBeLessThan(300);
    expect(e2?.errno).toBe(ER.LOCK_WAIT_TIMEOUT);
    await two.query('ROLLBACK');
    await one.query('ROLLBACK');
  });

  it('a connection that dies (KILL, or the Node process crashing) releases its locks at once', async () => {
    const one = await c();
    const two = await c();
    const [[idRow]] = await one.query<any[][]>('SELECT CONNECTION_ID() AS id');
    await one.query('START TRANSACTION');
    await one.query('SELECT id FROM customers WHERE id = ? FOR UPDATE', [CUSTOMER]);
    await two.query('START TRANSACTION');
    const pending = two.query('SELECT id FROM customers WHERE id = ? FOR UPDATE', [CUSTOMER]);
    await sleep(300);
    const root = await rootConn();
    await root.query(`KILL ${(idRow as any).id}`);
    await root.end();
    await pending; // resolves because the killed connection's transaction was rolled back
    await two.query('ROLLBACK');
  });

  it('READ-COMMITTED has no gap lock: FOR UPDATE on a row that does not exist does not block an insert of it', async () => {
    const one = await c();
    const two = await c();
    const newId = '22222222-2222-4222-8222-222222222222';
    await one.query('START TRANSACTION');
    await one.query('SELECT id FROM customers WHERE id = ? FOR UPDATE', [newId]); // no such row
    await two.query('SET SESSION innodb_lock_wait_timeout = 2');
    await two.query(`INSERT INTO customers (id, name) VALUES (?, 'Inserted at once')`, [newId]);
    await one.query('ROLLBACK');

    // contrast: under REPEATABLE READ the same pattern takes a gap lock and the insert waits (then times out)
    const three = await c();
    const four = await c();
    const newId2 = '33333333-3333-4333-8333-333333333333';
    await three.query("SET SESSION transaction_isolation = 'REPEATABLE-READ'");
    await three.query('START TRANSACTION');
    await three.query('SELECT id FROM customers WHERE id = ? FOR UPDATE', [newId2]);
    await four.query('SET SESSION innodb_lock_wait_timeout = 1');
    const err = await errorOf(() => four.query(`INSERT INTO customers (id, name) VALUES (?, 'Blocked')`, [newId2]));
    expect(err?.errno).toBe(ER.LOCK_WAIT_TIMEOUT);
    await three.query('ROLLBACK');
  });

  it('why X0 locks the customer first: without the lock two writers spend the same advance twice; with it they cannot', async () => {
    const rule = async (useLock: boolean) => {
      const one = await c();
      const two = await c();
      await one.query('DELETE FROM allocations');
      await one.query('UPDATE customers SET advance = 100.00 WHERE id = ?', [CUSTOMER]);
      // "apply the whole advance to a bill": read the advance, think for a while, record an allocation, zero the advance
      const applyAdvance = async (conn: Connection) => {
        await conn.query('START TRANSACTION');
        if (useLock) await conn.query('SELECT id FROM customers WHERE id = ? FOR UPDATE', [CUSTOMER]);
        const [rows] = await conn.query<any[]>('SELECT advance FROM customers WHERE id = ?', [CUSTOMER]);
        await sleep(300); // the window in which the other writer can read the same number
        const amount = rows[0].advance;
        await conn.query('INSERT INTO allocations (customer_id, amount) VALUES (?, ?)', [CUSTOMER, amount]);
        await conn.query('UPDATE customers SET advance = advance - ? WHERE id = ?', [amount, CUSTOMER]);
        await conn.query('COMMIT');
      };
      await Promise.all([applyAdvance(one), applyAdvance(two)]);
      const [sum] = await one.query<any[]>('SELECT COALESCE(SUM(amount),0) AS total FROM allocations');
      const [adv] = await one.query<any[]>('SELECT advance FROM customers WHERE id = ?', [CUSTOMER]);
      return { allocated: sum[0].total as string, advanceLeft: adv[0].advance as string };
    };
    const without = await rule(false);
    expect(without.allocated).toBe('200.00'); // 100 of advance, 200 allocated: money invented
    expect(without.advanceLeft).toBe('-100.00');
    const withLock = await rule(true);
    expect(withLock.allocated).toBe('100.00');
    expect(withLock.advanceLeft).toBe('0.00');
  });

  it('the whole-call bound (spec C4 "statement_timeout") exists as a SESSION variable max_statement_time, error 1969, and also cuts a lock wait short', async () => {
    const one = await c();
    const two = await c();
    await two.query('SET SESSION max_statement_time = 1'); // seconds; per statement, not per transaction
    const t0 = Date.now();
    const e1 = await errorOf(() => two.query('SELECT SLEEP(3)'));
    expect(Date.now() - t0).toBeLessThan(2500);
    console.log('[a] max_statement_time -> errno', e1?.errno, e1?.code, '|', e1?.message);
    expect(e1?.errno).toBe(1969);
    await one.query('START TRANSACTION');
    await one.query('SELECT id FROM customers WHERE id = ? FOR UPDATE', [CUSTOMER]);
    await two.query('START TRANSACTION');
    const t1 = Date.now();
    const e2 = await errorOf(() => two.query('SELECT id FROM customers WHERE id = ? FOR UPDATE', [CUSTOMER]));
    console.log('[a] lock wait under max_statement_time=1 ->', e2?.errno, e2?.code, 'after', Date.now() - t1, 'ms');
    expect(Date.now() - t1).toBeLessThan(2500);
    await two.query('ROLLBACK');
    await one.query('ROLLBACK');
  });

  it('invariant checks need ONE snapshot: READ-COMMITTED re-reads per statement, REPEATABLE READ + consistent snapshot does not', async () => {
    const checker = await c();
    const writer = await c();
    await writer.query('UPDATE customers SET advance = 5.00 WHERE id = ?', [CUSTOMER]);

    await checker.query('START TRANSACTION WITH CONSISTENT SNAPSHOT'); // under RC the snapshot is NOT kept
    const [a1] = await checker.query<any[]>('SELECT advance FROM customers WHERE id = ?', [CUSTOMER]);
    await writer.query('UPDATE customers SET advance = 6.00 WHERE id = ?', [CUSTOMER]);
    const [a2] = await checker.query<any[]>('SELECT advance FROM customers WHERE id = ?', [CUSTOMER]);
    await checker.query('ROLLBACK');
    expect(a1[0].advance).toBe('5.00');
    expect(a2[0].advance).toBe('6.00'); // changed inside one "transaction": a false alarm for a checker

    await checker.query("SET SESSION transaction_isolation = 'REPEATABLE-READ'");
    await checker.query('START TRANSACTION WITH CONSISTENT SNAPSHOT');
    const [b1] = await checker.query<any[]>('SELECT advance FROM customers WHERE id = ?', [CUSTOMER]);
    await writer.query('UPDATE customers SET advance = 7.00 WHERE id = ?', [CUSTOMER]);
    const [b2] = await checker.query<any[]>('SELECT advance FROM customers WHERE id = ?', [CUSTOMER]);
    await checker.query('ROLLBACK');
    expect(b1[0].advance).toBe('6.00');
    expect(b2[0].advance).toBe('6.00'); // stable: the nightly check must run like this
  });
});
