import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Connection } from 'mysql2/promise';
import { appConn, dropDb, freshDb, sleep } from './helpers';
import { IDEMPOTENCY_DDL, InvalidInput, idempotent } from './idem';

// Spike (c): repeat-safety with a UNIQUE request_id insert ... ON DUPLICATE KEY (spec L5).

let db: string;
const open: Connection[] = [];
const c = async (extra = {}) => {
  const x = await appConn(db, extra);
  open.push(x);
  return x;
};
const ACTOR = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

beforeAll(async () => {
  db = await freshDb('c_idem');
  const s = await c();
  await s.query(IDEMPOTENCY_DDL);
  await s.query(`CREATE TABLE counters (series VARCHAR(40) PRIMARY KEY, last_value BIGINT NOT NULL) ENGINE=InnoDB`);
  await s.query(`CREATE TABLE bills (
      id BIGINT AUTO_INCREMENT PRIMARY KEY, bill_no VARCHAR(30) NOT NULL UNIQUE, total DECIMAL(14,2) NOT NULL
    ) ENGINE=InnoDB`);
});
afterAll(async () => {
  await Promise.all(open.map((x) => x.end().catch(() => undefined)));
  await dropDb(db);
});
beforeEach(async () => {
  const s = await c();
  await s.query('DELETE FROM bills');
  await s.query('DELETE FROM idempotency');
  await s.query("DELETE FROM counters");
});

/** The business work of "create a bill": take the next number (counter row last) and insert. */
const makeBill = (conn: Connection, total: string, delayMs = 0) => async () => {
  if (delayMs) await sleep(delayMs);
  await conn.query(
    "INSERT INTO counters (series, last_value) VALUES ('bill', LAST_INSERT_ID(1)) ON DUPLICATE KEY UPDATE last_value = LAST_INSERT_ID(last_value + 1)"
  );
  const [[n]] = await conn.query<any[][]>('SELECT LAST_INSERT_ID() AS n');
  const billNo = `JV-2026-${String((n as any).n).padStart(4, '0')}`;
  await conn.query('INSERT INTO bills (bill_no, total) VALUES (?, ?)', [billNo, total]);
  return { bill_no: billNo, total };
};

const count = async (table: string) => {
  const x = await c();
  const [r] = await x.query<any[]>(`SELECT COUNT(*) AS n FROM ${table}`);
  return Number(r[0].n);
};

describe('(c) idempotency with a UNIQUE request_id', () => {
  it('FACT: with mysql2 default flags a duplicate still reports affectedRows 1, so affectedRows cannot tell first from repeat', async () => {
    const dflt = await c();
    const noFound = await c({ flags: ['-FOUND_ROWS'] });
    const id = randomUUID();
    const sql = `INSERT INTO idempotency (request_id, fn, actor, args_hash, claim_token) VALUES (?, 'f', ?, 'h', 'tok')
                 ON DUPLICATE KEY UPDATE request_id = request_id`;
    const [first]: any = await dflt.query(sql, [id, ACTOR]);
    const [second]: any = await dflt.query(sql, [id, ACTOR]);
    expect([first.affectedRows, second.affectedRows]).toEqual([1, 1]); // default FOUND_ROWS flag
    const id2 = randomUUID();
    const [f2]: any = await noFound.query(sql, [id2, ACTOR]);
    const [s2]: any = await noFound.query(sql, [id2, ACTOR]);
    expect([f2.affectedRows, s2.affectedRows]).toEqual([1, 0]); // without FOUND_ROWS: 1 = inserted, 0 = duplicate
    // so the code uses a claim_token read-back (works whatever flags the pool has)
  });

  it('two overlapping identical requests: one bill, both callers get the same answer, the second waited for the first', async () => {
    const a = await c();
    const b = await c();
    const reqId = randomUUID();
    const args = { customer: 'C1', total: '1500.00' };
    const t0 = Date.now();
    let bDone = 0;
    const pa = idempotent(a, { requestId: reqId, fn: 'create_bill', actor: ACTOR, args }, makeBill(a, '1500.00', 900));
    await sleep(150); // B starts while A is still inside its transaction
    const pb = idempotent(b, { requestId: reqId, fn: 'create_bill', actor: ACTOR, args }, makeBill(b, '1500.00', 900)).then((r) => {
      bDone = Date.now() - t0;
      return r;
    });
    const [ra, rb] = await Promise.all([pa, pb]);
    expect(ra.replayed).toBe(false);
    expect(rb.replayed).toBe(true);
    expect(rb.value).toEqual(ra.value);
    expect(bDone).toBeGreaterThanOrEqual(850); // B was held at the insert until A committed (no false error, no second bill)
    expect(await count('bills')).toBe(1);
    expect(await count('idempotency')).toBe(1);
    expect((await (async () => { const x = await c(); const [r] = await x.query<any[]>('SELECT last_value FROM counters'); return r[0].last_value; })())).toBe('1');
  });

  it('if the first request fails and rolls back, the waiting identical request becomes the first and succeeds', async () => {
    const a = await c();
    const b = await c();
    const reqId = randomUUID();
    const args = { customer: 'C1', total: '99.00' };
    const pa = idempotent(a, { requestId: reqId, fn: 'create_bill', actor: ACTOR, args }, async () => {
      await sleep(600);
      throw new Error('JV_PIECE_UNAVAILABLE'); // a business failure after the claim
    }).catch((e) => e as Error);
    await sleep(100);
    const pb = idempotent(b, { requestId: reqId, fn: 'create_bill', actor: ACTOR, args }, makeBill(b, '99.00'));
    const [ea, rb] = await Promise.all([pa, pb]);
    expect((ea as Error).message).toBe('JV_PIECE_UNAVAILABLE');
    expect(rb.replayed).toBe(false);
    expect(await count('bills')).toBe(1);
    expect(await count('idempotency')).toBe(1);
  });

  it('the same request id with different arguments, or from another actor, is refused (JV_INVALID_INPUT), never answered with the first result', async () => {
    const a = await c();
    const reqId = randomUUID();
    await idempotent(a, { requestId: reqId, fn: 'create_bill', actor: ACTOR, args: { total: '10.00' } }, makeBill(a, '10.00'));
    const e1 = await idempotent(a, { requestId: reqId, fn: 'create_bill', actor: ACTOR, args: { total: '20.00' } }, makeBill(a, '20.00')).catch((e) => e);
    expect(e1).toBeInstanceOf(InvalidInput);
    const e2 = await idempotent(a, { requestId: reqId, fn: 'create_bill', actor: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', args: { total: '10.00' } }, makeBill(a, '10.00')).catch((e) => e);
    expect(e2).toBeInstanceOf(InvalidInput);
    const e3 = await idempotent(a, { requestId: reqId, fn: 'record_payment', actor: ACTOR, args: { total: '10.00' } }, makeBill(a, '10.00')).catch((e) => e);
    expect(e3).toBeInstanceOf(InvalidInput);
    expect(await count('bills')).toBe(1);
  });

  it('8 identical requests fired at once: exactly one bill and one counter step, 7 replays', async () => {
    const conns = await Promise.all(Array.from({ length: 8 }, () => c()));
    const reqId = randomUUID();
    const args = { customer: 'C9', total: '777.00' };
    const results = await Promise.all(
      conns.map((x) => idempotent(x, { requestId: reqId, fn: 'create_bill', actor: ACTOR, args }, makeBill(x, '777.00', 200)))
    );
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect(new Set(results.map((r) => r.value.bill_no)).size).toBe(1);
    expect(await count('bills')).toBe(1);
  });

  it('a later retry (after the first finished) replays the stored result and uses no number', async () => {
    const a = await c();
    const reqId = randomUUID();
    const first = await idempotent(a, { requestId: reqId, fn: 'create_bill', actor: ACTOR, args: 1 }, makeBill(a, '5.00'));
    const again = await idempotent(a, { requestId: reqId, fn: 'create_bill', actor: ACTOR, args: 1 }, makeBill(a, '5.00'));
    expect(again.replayed).toBe(true);
    expect(again.value).toEqual(first.value);
    const next = await idempotent(a, { requestId: randomUUID(), fn: 'create_bill', actor: ACTOR, args: 2 }, makeBill(a, '6.00'));
    expect(next.value.bill_no).toBe('JV-2026-0002'); // the replay did not burn a number
  });

  it('different request ids do NOT wait for each other: 8 workers x 30 transactions holding an uncommitted claim for 40 ms finish in about 1/8 of the serial time', async () => {
    // MariaDB docs: a unique-index duplicate check takes a next-key lock whatever the isolation level; this checks it does not serialise random-uuid claims
    const conns = await Promise.all(Array.from({ length: 8 }, () => c()));
    const t0 = Date.now();
    await Promise.all(
      conns.map(async (x) => {
        for (let i = 0; i < 30; i++) {
          await x.query('START TRANSACTION');
          await x.query("INSERT INTO idempotency (request_id, fn, actor, args_hash, claim_token) VALUES (?, 'f', ?, 'h', 't') ON DUPLICATE KEY UPDATE request_id = request_id", [randomUUID(), ACTOR]);
          await sleep(40);
          await x.query('COMMIT');
        }
      })
    );
    const ms = Date.now() - t0;
    console.log(`[c] 240 held claims by 8 workers took ${ms} ms (fully serial would be about ${240 * 40} ms)`);
    expect(ms).toBeLessThan(240 * 40 * 0.4);
  });

  it('a plain INSERT that fails with 1062 also works as the claim, but the transaction keeps running (the statement alone is rolled back)', async () => {
    const a = await c();
    const id = randomUUID();
    await a.query("INSERT INTO idempotency (request_id, fn, actor, args_hash, claim_token) VALUES (?, 'f', ?, 'h', 't')", [id, ACTOR]);
    await a.query('START TRANSACTION');
    await a.query("INSERT INTO bills (bill_no, total) VALUES ('X-1', 1)");
    const err: any = await a.query("INSERT INTO idempotency (request_id, fn, actor, args_hash, claim_token) VALUES (?, 'f', ?, 'h', 't2')", [id, ACTOR]).catch((e) => e);
    expect(err.errno).toBe(1062);
    await a.query('ROLLBACK');
    expect(await count('bills')).toBe(0);
  });

  it('TRAP: under REPEATABLE READ an old snapshot makes the duplicate-key insert fail with 1020 "Record has changed" (a false error); READ-COMMITTED is required', async () => {
    const a = await c();
    const b = await c();
    const reqId = randomUUID();
    await b.query("SET SESSION transaction_isolation = 'REPEATABLE-READ'");
    await b.query('START TRANSACTION WITH CONSISTENT SNAPSHOT'); // snapshot taken BEFORE a commits
    await a.query('START TRANSACTION');
    await a.query("INSERT INTO idempotency (request_id, fn, actor, args_hash, claim_token, result) VALUES (?, 'f', ?, 'h', 'ta', '{}')", [reqId, ACTOR]);
    const pb = b
      .query(`INSERT INTO idempotency (request_id, fn, actor, args_hash, claim_token) VALUES (?, 'f', ?, 'h', 'tb') ON DUPLICATE KEY UPDATE request_id = request_id`, [reqId, ACTOR])
      .catch((e) => e);
    await sleep(200);
    await a.query('COMMIT');
    const err: any = await pb;
    await b.query('ROLLBACK');
    expect(err.errno).toBe(1020); // ER_CHECKREAD; the repeat request would show an error to the user
    // Hostinger runs READ-COMMITTED (verified in Harsh's phpMyAdmin) and every connection of the API sets it again.
  });
});
