import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { POOL_LIMITS } from '../../src/db/pool';
import { connectionLost } from './tx-support';
import { Gates } from './x0-support';
import { type EditWorld, addBill, addCustomer, allocationsOf, body, editWorld, figures, footprint, i10Holds, pay, paid, pendingByBill, receiptsOf } from './x02-support';
import { type Hold, busyLines, expectBusyAnswer, holdRow, holdTable, logMark, sleep, tally } from './x30-support';

// API30. T-C15 (S8, X0, S11, S12): a lock held for more than 5 seconds by another connection, and a statement that runs past max_statement_time (error 1969), each on the REAL record_payment (X2) through
// the real route: JV_BUSY (503, Retry-After 1, the S8 body), nothing changed, and the retry with the same Idempotency-Key succeeds. And the clauses of T-C19 on the real X2 that the toy function of
// API03 could only imitate: the customer row held for 28 seconds with 40 payments at once on the pool of 8, a call past its deadline at COMMIT, and a connection killed during COMMIT.
// The describe titles carry both numbers, so `npm test -- -t T-C15` and `npm test -- -t T-C19` find them.
//
// How "another connection" is made: a second connection of the same database user holds a row (`SELECT ... FOR UPDATE` in an open transaction) or a whole table (`LOCK TABLES ... WRITE`, by root). The
// application's own connection has innodb_lock_wait_timeout = 5 and max_statement_time = 8 (S11), set by the pool at every checkout; nothing of that is changed here, so the times below are the real ones.
// Where a COMMIT has to fail or a statement has to be slow, the test world's spy (tests/api/tx-support.ts, in front of the real pool) sits between the function and the real connection.

let w: EditWorld;
const money = (amount: string) => ({ amount, mode: 'UPI' });
const holds: Hold[] = [];
const keep = <T extends Hold>(h: T): T => (holds.push(h), h);

beforeAll(async () => {
  w = await editWorld('x30busy', { triggers: true });
  // WARM-UP. Under `npm run verify` the statement log (tests/api/statement-log.ts) asks `EXPLAIN` of each statement of src/ the first time the process sends it, on the same connection and right
  // behind it. For a locking SELECT on a row another connection holds, EXPLAIN reads the row too and waits for the same lock: the first payment under a hold would take 2 x 5 s. So every statement of
  // record_payment has been sent once, with nothing held, before the first test (a payment that names its bill, and one that does not, which leaves an advance).
  const customer = await addCustomer(w);
  const bill = await addBill(w, customer, '1000.00', '2026-10-10');
  await paid(await pay(w, 'biller', customer, { ...money('100.00'), bill_id: bill }));
  await paid(await pay(w, 'owner', customer, money('1000.00')));
}, 120_000);
afterEach(async () => {
  w.world.spy.intercept = null;
  for (const h of holds.splice(0)) await h.release();
});
afterAll(async () => {
  await w?.world.close();
}, 60_000);

/** A customer with one unpaid bill of 1,000: the books a payment of 400 acts on. */
async function start() {
  const customer = await addCustomer(w);
  const bill = await addBill(w, customer, '1000.00', '2026-10-10');
  return { customer, bill };
}
const key = (): string => randomUUID();

/** The payment of 400 is in the books exactly once, applied to the bill, and the books agree (V1 summed = V2, I10). */
async function expectPaidOnce(s: Awaited<ReturnType<typeof start>>, receiptId?: string) {
  const receipts = await receiptsOf(w, s.customer);
  expect(receipts).toHaveLength(1);
  if (receiptId) expect(receipts[0].id).toBe(receiptId);
  expect((await allocationsOf(w, s.customer)).map((a) => a.amount)).toEqual(['400.00']);
  expect(await pendingByBill(w, s.customer)).toEqual({ [s.bill]: '600.00' });
  expect(await figures(w, s.customer)).toMatchObject({ outstanding: '600.00', advance: '0.00' });
  await i10Holds(w, s.customer);
}

describe('T-C15 a lock held for more than 5 seconds raises JV_BUSY and changes nothing; the retry with the same key succeeds (real record_payment, X0, S8)', () => {
  const variants = [
    {
      name: 'the customer row (the first lock of every money function, X0 item 3)',
      hold: (s: Awaited<ReturnType<typeof start>>) => holdRow(w, 'customers', s.customer),
    },
    {
      name: 'the bill the payment pays (the wait comes AFTER the claim, the customer lock, the receipt and the audit row were written: all of it must be rolled back)',
      hold: (s: Awaited<ReturnType<typeof start>>) => holdRow(w, 'bills', s.bill),
    },
  ];

  for (const v of variants) {
    it(`${v.name}: 503 JV_BUSY after about 5 s, nothing changed, the same key then saves it once and a third call is the stored answer`, async () => {
      const s = await start();
      const k = key();
      const before = await footprint(w);
      const held = keep(await v.hold(s));
      const mark = logMark(w);
      const t0 = performance.now();
      const res = await pay(w, 'biller', s.customer, { ...money('400.00'), bill_id: s.bill }, k);
      const took = performance.now() - t0;
      expect(held.heldMs(), 'the lock was held the whole time the call waited').toBeGreaterThan(took);
      await held.release();
      expectBusyAnswer(res);
      expect(took, 'innodb_lock_wait_timeout is 5 s on the API\'s connection').toBeGreaterThanOrEqual(4900);
      expect(took).toBeLessThan(8000);
      expect(tally(busyLines(w, mark))).toEqual({ lock_wait: 1 });
      expect(await footprint(w), 'a rolled-back call leaves no claim, no receipt, no allocation, no audit row, no new stamp').toEqual(before);
      expect(await receiptsOf(w, s.customer)).toEqual([]);

      // the screen retries once with the same key: the claim was rolled back with the rest, so this is the first time the key is used
      const retry = await pay(w, 'biller', s.customer, { ...money('400.00'), bill_id: s.bill }, k);
      const saved = await paid(retry);
      expect(retry.headers['idempotent-replay']).toBeUndefined();
      expect(saved.allocations.map((a) => a.amount)).toEqual(['400.00']);
      await expectPaidOnce(s, String(saved.receipt.id));
      const after = await footprint(w);
      expect(after.receipts).toBe((before.receipts as number) + 1);
      expect(after.sys_idempotency).toBe((before.sys_idempotency as number) + 1);

      // and a third call with the key is the stored answer, byte for byte, and writes nothing
      const again = await pay(w, 'biller', s.customer, { ...money('400.00'), bill_id: s.bill }, k);
      expect(again.statusCode).toBe(201);
      expect(again.headers['idempotent-replay']).toBe('true');
      expect(body(again)).toEqual(body(retry));
      expect(await footprint(w)).toEqual(after);
    }, 60_000);
  }

  it('the key of a twin call that is still at work longer than 5 s (a real record_payment held after its claim): the twin answers JV_BUSY, and after the first call finished the same key returns ITS stored result', async () => {
    const s = await start();
    const k = key();
    const gates = Gates.install();
    try {
      const g = gates.forNextSession(12_000); // longer than the 5 s lock wait, shorter than the 12 s deadline
      const first = pay(w, 'biller', s.customer, money('400.00'), k);
      expect(await Promise.race([g.reached, first.then((r) => `ended with ${r.statusCode} before it reached the hook`)])).toBe('x02.after_read');
      const mark = logMark(w);
      const t0 = performance.now();
      const twin = await pay(w, 'biller', s.customer, money('400.00'), k); // the same key, the same body, the same caller: a screen that retried too early
      const took = performance.now() - t0;
      expectBusyAnswer(twin);
      expect(took).toBeGreaterThanOrEqual(4900);
      expect(took).toBeLessThan(8000);
      expect(tally(busyLines(w, mark)), 'the twin waited at its claim (the first statement) for the row the first call has not committed').toEqual({ lock_wait: 1 });
      expect(g.autoReleased, 'the first call was held all the time').toBe(false);
      g.release();
      const done = await paid(await first);
      const replay = await pay(w, 'biller', s.customer, money('400.00'), k);
      expect(replay.statusCode).toBe(201);
      expect(replay.headers['idempotent-replay']).toBe('true');
      expect(body<{ receipt: { id: string } }>(replay).receipt.id).toBe(done.receipt.id);
      await expectPaidOnce(s, String(done.receipt.id));
    } finally {
      gates.restore();
    }
  }, 60_000);
});

describe('T-C15 a statement running past max_statement_time (error 1969) raises JV_BUSY and changes nothing; the retry with the same key succeeds (real record_payment, S11)', () => {
  it('the receipts table is locked by another connection: the first statement on it waits for the metadata lock and is cut at 8 s: 503 JV_BUSY (statement_timeout), nothing changed, the same key then saves the payment once', async () => {
    const s = await start();
    const k = key();
    const before = await footprint(w);
    const held = keep(await holdTable(w, 'receipts'));
    const mark = logMark(w);
    const t0 = performance.now();
    const res = await pay(w, 'biller', s.customer, money('400.00'), k);
    const took = performance.now() - t0;
    expect(held.heldMs()).toBeGreaterThan(took);
    await held.release();
    expectBusyAnswer(res);
    expect(took, 'max_statement_time is 8 s on the API\'s connection (a table lock has no lock-wait limit of its own)').toBeGreaterThanOrEqual(7900);
    expect(took, 'and the 12 s deadline never had to step in').toBeLessThan(11_000);
    expect(tally(busyLines(w, mark))).toEqual({ statement_timeout: 1 });
    expect(await footprint(w)).toEqual(before);
    const saved = await paid(await pay(w, 'biller', s.customer, money('400.00'), k));
    await expectPaidOnce(s, String(saved.receipt.id));
  }, 60_000);
});

describe('T-C19 (T-C15 clause) the pool under load on the real X2: the customer row is held for 28 seconds and 40 payments arrive at once on the pool of 8', () => {
  it('every call is answered JV_BUSY (503, Retry-After 1, the S8 body) within 15 s, none by the 25-second handler timer, nothing is written, and once the row is free the same endpoint works', async () => {
    const s = await start();
    const before = await footprint(w);
    const held = keep(await holdRow(w, 'customers', s.customer));
    const mark = logMark(w);
    const t0 = performance.now();
    const answers = await Promise.all(
      Array.from({ length: 40 }, async (_, i) => {
        const res = await pay(w, i % 2 === 0 ? 'biller' : 'owner', s.customer, money('10.00'), key());
        return { res, ms: performance.now() - t0 };
      }),
    );
    const allAnsweredAt = performance.now() - t0;
    expect(held.heldMs(), 'the row was held while every one of them was answered').toBeGreaterThan(allAnsweredAt);
    for (const a of answers) {
      expectBusyAnswer(a.res);
      expect(a.ms, 'the spec: within 15 seconds').toBeLessThan(15_000);
    }
    const slowest = Math.max(...answers.map((a) => a.ms));
    expect(slowest, 'the calls that got a connection really waited for the lock').toBeGreaterThanOrEqual(4500);
    const reasons = tally(busyLines(w, mark));
    console.log('[T-C19 28 s hold, 40 payments]', JSON.stringify({ slowest_ms: Math.round(slowest), reasons }));
    expect(reasons.handler_timeout, 'none was answered by the handler timer').toBeUndefined();
    expect(Object.keys(reasons).sort().every((r) => ['lock_wait', 'wait_timeout', 'queue_full'].includes(r)), JSON.stringify(reasons)).toBe(true);
    expect(Object.values(reasons).reduce((n, c) => n + c, 0), 'one busy answer in the log for each call').toBe(40);
    expect(reasons.lock_wait, 'at most 8 of them were at the customer lock at once; each of those waited the full 5 s').toBeGreaterThanOrEqual(1);
    expect(reasons.lock_wait).toBeLessThanOrEqual(POOL_LIMITS.size * 2);
    // "held for 28 seconds": the row stays held to the end of that time, with the pool back at rest and the books untouched
    await sleep(Math.max(0, 28_000 - held.heldMs()) + 100); // a timer can fire a fraction of a millisecond early: 27999.82 once
    expect(held.heldMs()).toBeGreaterThanOrEqual(28_000);
    await held.release();
    expect(await footprint(w)).toEqual(before);
    const stats = w.world.app.db?.stats();
    expect(stats).toMatchObject({ inUse: 0, waiting: 0 });
    const ok = await paid(await pay(w, 'biller', s.customer, money('400.00')));
    expect(ok.allocations.map((a) => a.amount)).toEqual(['400.00']);
    await expectPaidOnce(s, String(ok.receipt.id));
  }, 90_000);

  it('all 8 connections are busy: one payment is answered JV_BUSY in under 3 seconds (the wait for a connection is cut at 2 s) and nothing is written', async () => {
    const s = await start();
    const before = await footprint(w);
    const pool = w.world.app.db!;
    const taken = await Promise.all(Array.from({ length: POOL_LIMITS.size }, () => pool.checkout()));
    const mark = logMark(w);
    const t0 = performance.now();
    const res = await pay(w, 'biller', s.customer, money('400.00'));
    const took = performance.now() - t0;
    for (const c of taken) c.release();
    expectBusyAnswer(res);
    expect(took).toBeGreaterThanOrEqual(1900);
    expect(took).toBeLessThan(3000);
    expect(tally(busyLines(w, mark))).toEqual({ wait_timeout: 1 });
    expect(await footprint(w)).toEqual(before);
    expect(pool.stats()).toMatchObject({ inUse: 0, waiting: 0 });
  });
});

describe('T-C19 (T-C15 clause) a call that is over its 12-second deadline at COMMIT is rolled back (real record_payment)', () => {
  it('the last statement of the call takes 12.1 s in all: the deadline is checked once more just before COMMIT, ROLLBACK is sent and COMMIT is not, the answer is JV_BUSY, nothing is left, and the same key then saves the payment', async () => {
    const s = await start();
    const k = key();
    const before = await footprint(w);
    const spy = w.world.spy;
    spy.sent.splice(0);
    // the statement that stores the result is the last one before COMMIT; it runs for real, and the call is then late
    spy.intercept = async (e) => {
      if (/^UPDATE sys_idempotency SET result/.test(e.sql)) {
        const r = await e.real();
        await sleep(12_100);
        return { result: r };
      }
    };
    const mark = logMark(w);
    const t0 = performance.now();
    const res = await pay(w, 'biller', s.customer, money('400.00'), k);
    const took = performance.now() - t0;
    spy.intercept = null;
    expectBusyAnswer(res);
    expect(took).toBeGreaterThanOrEqual(12_000);
    expect(took, 'the handler timer (25 s) is still far away').toBeLessThan(20_000);
    expect(tally(busyLines(w, mark))).toEqual({ deadline: 1 });
    const sqls = spy.sqls();
    expect(sqls.some((q) => /^UPDATE sys_idempotency SET result/.test(q)), 'every statement was sent: the call was late only at the end').toBe(true);
    expect(sqls.filter((q) => q === 'ROLLBACK')).toHaveLength(1);
    expect(sqls.filter((q) => q === 'COMMIT'), 'COMMIT is never sent').toHaveLength(0);
    expect(await footprint(w), 'the receipt, the allocation, the audit rows and the claim, all written and all rolled back').toEqual(before);
    const saved = await paid(await pay(w, 'biller', s.customer, money('400.00'), k));
    await expectPaidOnce(s, String(saved.receipt.id));
  }, 60_000);
});

describe('T-C19 (T-C15 clause) a connection killed during COMMIT answers JV_BUSY and the retry with the same key tells the truth (real record_payment)', () => {
  it('the server committed and the answer was lost: JV_BUSY (the outcome is unknown, the log says so), the payment IS in the books, and the retry returns the stored result and saves nothing twice', async () => {
    const s = await start();
    const k = key();
    const spy = w.world.spy;
    spy.intercept = async (e) => {
      if (e.sql === 'COMMIT') {
        await e.real(); // it reached the server and was saved...
        throw connectionLost(); // ...and the connection dropped before the answer came back
      }
    };
    const mark = logMark(w);
    const res = await pay(w, 'biller', s.customer, money('400.00'), k);
    spy.intercept = null;
    expectBusyAnswer(res);
    expect(busyLines(w, mark)).toEqual([{ reason: 'commit_lost', outcome_unknown: true }]);
    await w.world.app.errorLog.idle(); // the row of the busy answer is written after the answer, on a connection of its own
    expect(w.world.app.db?.stats().inUse, 'the broken connection was given back (destroyed), the place is free').toBe(0);
    const stored = (await receiptsOf(w, s.customer)).map((r) => r.id);
    expect(stored, 'it HAD committed').toHaveLength(1);
    const after = await footprint(w);
    const retry = await pay(w, 'biller', s.customer, money('400.00'), k);
    expect(retry.statusCode).toBe(201);
    expect(retry.headers['idempotent-replay'], 'the stored result of the committed call').toBe('true');
    expect(body<{ receipt: { id: string } }>(retry).receipt.id).toBe(stored[0]);
    expect(await footprint(w)).toEqual(after);
    await expectPaidOnce(s, String(stored[0]));
  });

  it('the connection was killed before the COMMIT reached the server: JV_BUSY, nothing was saved (the server rolled it back when the connection died), and the retry with the same key runs the call once', async () => {
    const s = await start();
    const k = key();
    const before = await footprint(w);
    const root = await w.world.scratch.root();
    const spy = w.world.spy;
    spy.intercept = async (e) => {
      if (e.sql === 'COMMIT') {
        await root.query(`KILL CONNECTION ${Number(e.thread)}`);
        await sleep(150); // the server has closed it
      }
    };
    const mark = logMark(w);
    const res = await pay(w, 'biller', s.customer, money('400.00'), k);
    spy.intercept = null;
    await root.end();
    expectBusyAnswer(res);
    expect(busyLines(w, mark)).toEqual([{ reason: 'commit_lost', outcome_unknown: true }]);
    await w.world.app.errorLog.idle();
    expect(w.world.app.db?.stats().inUse).toBe(0);
    expect(await footprint(w), 'nothing was saved').toEqual(before);
    const retry = await pay(w, 'biller', s.customer, money('400.00'), k);
    const saved = await paid(retry);
    expect(retry.headers['idempotent-replay'], 'the key had stored nothing: this is the first run of the call').toBeUndefined();
    await expectPaidOnce(s, String(saved.receipt.id));
  });

  it('KILL CONNECTION racing the COMMIT, 24 rounds with the kill before it, beside it and after it: whether the transaction had committed or not, the answer is 201 or JV_BUSY, the retry with the same key ends with exactly one payment, and the books are right', async () => {
    const root = await w.world.scratch.root();
    const spy = w.world.spy;
    const outcomes = { committed_answered: 0, committed_lost: 0, rolled_back_lost: 0 };
    const PAUSES = [0, 0, 0.2, 0.5, 1, 1, 2, 3];
    try {
      for (let round = 0; round < 24; round++) {
        const s = await start();
        const k = key();
        const pause = PAUSES[round % PAUSES.length]; // milliseconds between the first of the two packets and the second
        const killFirst = Math.floor(round / PAUSES.length) % 2 === 1;
        spy.intercept = async (e) => {
          if (e.sql !== 'COMMIT') return;
          const kill = () => root.query(`KILL CONNECTION ${Number(e.thread)}`);
          if (killFirst) {
            const killing = kill();
            await sleep(pause);
            const result = await e.real(); // throws when the kill got there first
            await killing;
            return { result };
          }
          const committing = e.real();
          committing.catch(() => undefined);
          await sleep(pause);
          await kill();
          return { result: await committing };
        };
        const res = await pay(w, 'biller', s.customer, money('400.00'), k);
        spy.intercept = null;
        const inBooks = (await receiptsOf(w, s.customer)).length;
        expect([0, 1], 'at most one receipt, whatever the timing').toContain(inBooks);
        if (res.statusCode === 201) {
          expect(inBooks).toBe(1);
          outcomes.committed_answered++;
        } else {
          expectBusyAnswer(res);
          if (inBooks === 1) outcomes.committed_lost++;
          else outcomes.rolled_back_lost++;
        }
        const retry = await pay(w, 'biller', s.customer, money('400.00'), k);
        expect(retry.statusCode, retry.body).toBe(201);
        if (inBooks === 1) expect(retry.headers['idempotent-replay'], 'it had committed: the retry is the stored result').toBe('true');
        else expect(retry.headers['idempotent-replay'], 'it had not: the retry runs the call').toBeUndefined();
        await expectPaidOnce(s, String(body<{ receipt: { id: string } }>(retry).receipt.id));
      }
    } finally {
      spy.intercept = null;
      await root.end();
    }
    console.log('[T-C19 kill racing COMMIT, 24 rounds]', JSON.stringify(outcomes));
    expect(outcomes.committed_answered + outcomes.committed_lost + outcomes.rolled_back_lost).toBe(24);
  }, 120_000);
});
