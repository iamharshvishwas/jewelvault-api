import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { claim } from '../../src/db/idempotency';
import { LockOrderViolation, lockCustomer, lockCustomerOf, lockPieces } from '../../src/db/locks';
import { takeNumber } from '../../src/db/numbers';
import { type TxContext, txContext, withTx } from '../../src/db/tx';
import { BusyError, JvError, classifyError } from '../../src/errors';
import { sleep } from '../helpers';
import { pauseHookHits } from './static-lib';
import { buildDist } from './support';
import { dbError, innodbDeadlocks, spyOn } from './tx-support';
import { readsByName } from './x0-named-import';
import {
  Gate,
  Gates,
  P_SQL_FIRST,
  P_TEXT_FIRST,
  type X0World,
  addBill,
  addCustomer,
  addPiece,
  addReceipt,
  books,
  deferred,
  lockPiecesWrong,
  rowOf,
  toyPay,
  waitForLockWaits,
  withoutCustomerLock,
  x0World,
} from './x0-support';

// PT-X0 (X0 items 1 to 8, NODE-DESIGN 5.4): the lock helpers on a toy writing function. The customer lock first; X4, X5 and X10 find the customer without a lock, lock it and re-read the SAME row;
// the pieces by ONE `ORDER BY id FOR UPDATE` statement and never sorted in code; the counter last; the hook of item 8 (test build only) with both release orders and the negative control; the trail
// that throws LockOrderViolation. T-C21 here is the control of the piece order (API29 runs it in full on X10 and X1). The T-D29 clause (no hook in the production bundle) is the last describe.

let w: X0World;
const ACTOR = { id: '11111111-1111-4111-8111-111111111111', role: 'biller' };
const ctxOf = (requestId: string = randomUUID(), extra: Partial<Parameters<typeof txContext>[1]> = {}, pool: Parameters<typeof txContext>[0] = w.pool): TxContext => txContext(pool, { requestId, actor: ACTOR, ...extra });
const tx$ = <T>(fn: Parameters<typeof withTx<T>>[1], requestId?: string) => withTx(ctxOf(requestId), fn);

beforeAll(async () => {
  w = await x0World('x0lock');
  await addPiece(w, P_TEXT_FIRST, { sku_no: 'X0-1', barcode: 'BC-X0-1' });
  await addPiece(w, P_SQL_FIRST, { sku_no: 'X0-2', barcode: 'BC-X0-2' });
  await w.u.query("INSERT INTO sys_counters (series) VALUES ('toy:2026')");
}, 120_000);
afterAll(async () => {
  await w?.close();
}, 60_000);

const settle = <T>(p: Promise<T>) => p.then((ok) => ({ ok }), (err: unknown) => ({ err }));

describe('PT-X0 the customer lock first, and either release order gives the right books (X0 item 3 and 8; T-C09 shape)', () => {
  /** Two payments of 600 on a bill of 1000, session 1 held at the hook `toy_pay.after_read` while session 2 is started. */
  async function twoPayments(order: 'S1first' | 'S2first') {
    const customer = await addCustomer(w);
    await addBill(w, customer, '1000.00');
    const gates = Gates.install();
    const r1 = randomUUID();
    const r2 = randomUUID();
    const g1 = gates.forRequest(r1);
    const g2 = gates.forRequest(r2);
    try {
      const p1 = settle(tx$((tx) => toyPay(tx, { customerId: customer, amount: '600.00' }), r1));
      expect(await g1.reached).toBe('toy_pay.after_read');
      const p2 = settle(tx$((tx) => toyPay(tx, { customerId: customer, amount: '600.00' }), r2));
      await sleep(400);
      const s2AtHookWhileS1Held = g2.isAtHook;
      if (order === 'S2first') {
        g2.release();
        await sleep(300);
        g1.release();
      } else {
        g1.release();
        await sleep(300);
        g2.release();
      }
      const [a, b] = await Promise.all([p1, p2]);
      return { a, b, s2AtHookWhileS1Held, books: await books(w, customer), gates: [g1, g2] };
    } finally {
      gates.restore();
    }
  }

  for (const order of ['S1first', 'S2first'] as const) {
    it(`with the lock in place session 2 waits at the customer lock, not at the hook, and the books are right (${order})`, async () => {
      const r = await twoPayments(order);
      expect(r.s2AtHookWhileS1Held, 'session 2 must still be waiting for the customer lock').toBe(false);
      expect(r.a).toMatchObject({ ok: { allocated: '600.00', advance: '0.00' } });
      expect(r.b).toMatchObject({ ok: { allocated: '400.00', advance: '200.00' } }); // it read AFTER session 1 had committed
      expect(r.books).toMatchObject({ received: '1200.00', allocated: '1000.00', advance: '200.00', outstanding: '0.00', overAllocated: false });
      expect(r.gates.every((g) => !g.autoReleased)).toBe(true);
    });

    it(`NEGATIVE CONTROL: with the customer-lock helper replaced by a no-op in the test build the same test fails (${order})`, async () => {
      const undo = withoutCustomerLock();
      try {
        const r = await twoPayments(order);
        expect(r.s2AtHookWhileS1Held, 'without the lock session 2 gets to the hook beside session 1').toBe(true);
        expect(r.books.overAllocated, `the bill is paid twice: ${JSON.stringify(r.books)}`).toBe(true);
        expect(r.books.allocated).toBe('1200.00');
      } finally {
        undo();
      }
    });
  }

  it('the hook is found through a named import too (a money function in src/ imports the state read by name)', async () => {
    const customer = await addCustomer(w);
    await addBill(w, customer, '300.00');
    const gates = Gates.install();
    try {
      const r = randomUUID();
      const g = gates.forRequest(r);
      const p = settle(tx$((tx) => readsByName(tx, customer), r));
      expect(await Promise.race([g.reached, sleep(1500).then(() => 'never')])).toBe('named_import.after_read');
      g.release();
      expect(await p).toEqual({ ok: 1 });
    } finally {
      gates.restore();
    }
  });

  it('a gate lets go by itself after 3 s, whoever forgot it (and says so)', async () => {
    const g = new Gate(150);
    const t0 = Date.now();
    await g.pass('x.after_read');
    expect(g.autoReleased).toBe(true);
    expect(Date.now() - t0).toBeLessThan(1000);
    const early = new Gate(150);
    early.release();
    await early.pass('x.after_read'); // released before it was reached: passes at once
    expect(early.autoReleased).toBe(false);
    expect(new Gate().maxHoldMs).toBe(3000);
  });

  it('a gate held 2.5 s never causes a lock timeout; held 5.6 s the second session is cut by the lock wait of 5 s (which is why the limit is 3 s)', async () => {
    const run = async (holdMs: number, maxHoldMs: number) => {
      const customer = await addCustomer(w);
      await addBill(w, customer, '1000.00');
      const gates = Gates.install();
      const r1 = randomUUID();
      const g1 = gates.forRequest(r1, maxHoldMs);
      try {
        const p1 = settle(tx$((tx) => toyPay(tx, { customerId: customer, amount: '600.00' }), r1));
        await g1.reached;
        const t0 = Date.now();
        const p2 = settle(tx$((tx) => toyPay(tx, { customerId: customer, amount: '600.00' })));
        await sleep(holdMs);
        g1.release();
        const [a, b] = await Promise.all([p1, p2]);
        return { a, b, ms: Date.now() - t0, autoReleased: g1.autoReleased };
      } finally {
        gates.restore();
      }
    };
    const short = await run(2500, 3000);
    expect(short.autoReleased).toBe(false);
    expect(short.a).toHaveProperty('ok');
    expect(short.b, 'session 2 waited 2.5 s for the lock and was not cut').toHaveProperty('ok');
    const long = await run(5600, 8000);
    expect((long.b as { err: unknown }).err).toBeInstanceOf(BusyError);
    expect((long.b as { err: BusyError }).err.reason).toBe('lock_wait');
    expect(long.a).toHaveProperty('ok');
  }, 30_000);
});

describe('PT-X0 X4, X5 and X10 find the customer without a lock, lock it, and re-read the SAME row (X0 item 3)', () => {
  it('three statements in this order: the customer id by a plain read, the customer FOR UPDATE, the receipt (or bill) FOR UPDATE; the answer holds both rows', async () => {
    const customer = await addCustomer(w);
    const bill = await addBill(w, customer, '500.00');
    const receipt = await addReceipt(w, customer, '500.00');
    for (const [table, id] of [['receipts', receipt], ['bills', bill]] as const) {
      const spy = spyOn(w.pool);
      const out = await withTx(ctxOf(undefined, {}, spy.pool), async (tx) => ({ found: await lockCustomerOf(tx, table, id), trail: [...tx.trail] }));
      const sqls = spy.sqls().filter((s) => /\b(customers|receipts|bills)\b/.test(s) && !/^SET /.test(s));
      expect(sqls).toHaveLength(3);
      expect(sqls[0]).toBe(`SELECT customer_id FROM ${table} WHERE id = ?`);
      expect(sqls[1]).toMatch(/FROM customers WHERE id = \? FOR UPDATE$/);
      expect(sqls[2]).toMatch(new RegExp(`FROM ${table} WHERE id = \\? FOR UPDATE$`));
      expect(out.trail).toEqual(['customer']);
      expect(out.found?.customer.id).toBe(customer);
      expect(out.found?.row).toMatchObject({ id, customer_id: customer, status: 'active' });
    }
    expect(await tx$((tx) => lockCustomerOf(tx, 'receipts', randomUUID()))).toBeNull(); // no such receipt: the caller answers 404
  });

  it('a row that now belongs to another customer rolls the call back with JV_BUSY (reason customer_changed), and nothing it wrote stays', async () => {
    const customer = await addCustomer(w);
    const receipt = await addReceipt(w, customer, '500.00');
    const other = await addCustomer(w);
    const spy = spyOn(w.pool);
    spy.intercept = async (e) => {
      if (/FROM receipts WHERE id = \? FOR UPDATE$/.test(e.sql)) {
        const [rows, fields] = (await e.real()) as [Record<string, unknown>[], unknown];
        return { result: [rows.map((r) => ({ ...r, customer_id: other })), fields] };
      }
    };
    const e = (await settle(withTx(ctxOf(undefined, {}, spy.pool), async (tx) => {
      await lockCustomerOf(tx, 'receipts', receipt);
      await tx.run("UPDATE receipts SET notes = 'written' WHERE id = ?", [receipt]); // never reached
    }))) as { err: BusyError };
    expect(e.err).toBeInstanceOf(BusyError);
    expect(e.err).toMatchObject({ code: 'JV_BUSY', reason: 'customer_changed', status: 503 });
    expect((await rowOf(w.root, `SELECT notes FROM ${w.db()}.receipts WHERE id = ?`, [receipt])).notes).toBeNull();
  });

  it('two voids of one receipt side by side: one wins, the other answers JV_ALREADY_VOID, never a false JV_BUSY (12 rounds)', async () => {
    const voidOnce = (id: string) =>
      settle(
        tx$(async (tx) => {
          const found = await lockCustomerOf(tx, 'receipts', id);
          if (!found) throw new JvError('JV_NOT_FOUND', 'no such receipt');
          if (found.row.status !== 'active') throw new JvError('JV_ALREADY_VOID', 'already void');
          await tx.run("UPDATE receipts SET status = 'voided', void_reason = 'twice', voided_at = '2026-10-17 10:00:00.000000', voided_on = '2026-10-17', voided_by = ? WHERE id = ?", [ACTOR.id, id]);
          return 'voided';
        }),
      );
    const codes: string[] = [];
    for (let i = 0; i < 12; i++) {
      const customer = await addCustomer(w);
      const receipt = await addReceipt(w, customer, '100.00');
      const [a, b] = await Promise.all([voidOnce(receipt), voidOnce(receipt)]);
      for (const r of [a, b]) codes.push('ok' in r ? 'ok' : (r.err as JvError).code);
    }
    expect(codes.filter((c) => c === 'ok')).toHaveLength(12);
    expect(codes.filter((c) => c === 'JV_ALREADY_VOID')).toHaveLength(12);
    expect(codes.filter((c) => c === 'JV_BUSY')).toHaveLength(0);
  });
});

describe('PT-X0 the pieces by ONE statement in MariaDB\'s id order, never sorted in code (X0 item 5)', () => {
  it('the premise: the two ids sort one way as text and the other in the database', async () => {
    const [rows] = await w.root.query<any[]>(`SELECT id FROM ${w.db()}.skus WHERE id IN (?, ?) ORDER BY id`, [P_TEXT_FIRST, P_SQL_FIRST]);
    expect(rows.map((r) => r.id)).toEqual([P_SQL_FIRST, P_TEXT_FIRST]);
    expect([P_SQL_FIRST, P_TEXT_FIRST].sort()).toEqual([P_TEXT_FIRST, P_SQL_FIRST]);
  });

  it('one SELECT ... WHERE id IN (...) ORDER BY id FOR UPDATE, the rows in the database\'s order whatever order the ids came in, the input untouched', async () => {
    const input = Object.freeze([P_TEXT_FIRST, P_SQL_FIRST]);
    const spy = spyOn(w.pool);
    const out = await withTx(ctxOf(undefined, {}, spy.pool), async (tx) => ({ rows: await lockPieces(tx, input), trail: [...tx.trail] }));
    const skuSql = spy.sqls().filter((s) => /\bFROM skus\b/.test(s));
    expect(skuSql).toHaveLength(1);
    expect(skuSql[0]).toMatch(/^SELECT .+ FROM skus WHERE id IN \(\?, \?\) ORDER BY id FOR UPDATE$/);
    expect(out.rows.map((r) => r.id)).toEqual([P_SQL_FIRST, P_TEXT_FIRST]);
    expect(out.rows[0]).toMatchObject({ status: 'In Stock', sold_bill_id: null, sku_no: 'X0-2' });
    expect(out.trail).toEqual(['pieces']);
    expect(input).toEqual([P_TEXT_FIRST, P_SQL_FIRST]);
  });

  it('X10: the old bill\'s pieces and the new lines\' pieces are one statement over the union (a piece named twice once); an empty list sends nothing and leaves no step; a bad id is a bug', async () => {
    const spy = spyOn(w.pool);
    const out = await withTx(ctxOf(undefined, {}, spy.pool), async (tx) => ({ rows: await lockPieces(tx, [P_TEXT_FIRST, P_SQL_FIRST, P_TEXT_FIRST]), trail: [...tx.trail] }));
    expect(out.rows).toHaveLength(2);
    expect(spy.sqls().filter((s) => /\bFROM skus\b/.test(s))).toHaveLength(1);
    expect(spy.sqls().find((s) => /\bFROM skus\b/.test(s))).toContain('IN (?, ?)');
    const spy2 = spyOn(w.pool);
    const none = await withTx(ctxOf(undefined, {}, spy2.pool), async (tx) => ({ rows: await lockPieces(tx, []), trail: [...tx.trail] }));
    expect(none).toEqual({ rows: [], trail: [] });
    expect(spy2.sqls().filter((s) => /\bskus\b/.test(s))).toHaveLength(0);
    await expect(tx$((tx) => lockPieces(tx, ['not-an-id']))).rejects.toMatchObject({ code: 'JV_INTERNAL', cause: { message: expect.stringMatching(/uuid/i) } });
  });
});

describe('T-C21 control (API29 runs it in full on X1 and X10): two sessions, two pieces whose ids sort one way in code and the other in the database, 40 rounds', () => {
  /** Session A holds `first` and waits at a gate; B starts, takes its locks and is stuck behind A; then A goes on. */
  async function rounds(n: number, a: 'real' | 'wrong') {
    let aErrors = 0;
    let bErrors = 0;
    const before = await innodbDeadlocks(w.root);
    for (let i = 0; i < n; i++) {
      const aHolds = deferred();
      const goOn = deferred();
      const A = settle(
        tx$(async (tx) => {
          if (a === 'wrong') {
            // sorted in code, locked one at a time; the test build's pause point lock_pieces.between holds the session after the first lock
            await lockPiecesWrong(tx, [P_SQL_FIRST, P_TEXT_FIRST], async (lockedSoFar) => {
              if (lockedSoFar === 1) {
                aHolds.resolve();
                await goOn.promise;
              }
            });
          } else {
            await lockPieces(tx, [P_TEXT_FIRST, P_SQL_FIRST]);
            aHolds.resolve();
            await goOn.promise;
          }
        }),
      );
      await aHolds.promise;
      const B = settle(tx$((tx) => lockPieces(tx, [P_SQL_FIRST, P_TEXT_FIRST]))); // the real helper, the other way round
      await waitForLockWaits(w.root, 1);
      goOn.resolve();
      const [ra, rb] = await Promise.all([A, B]);
      if ('err' in ra) aErrors++;
      if ('err' in rb) bErrors++;
    }
    return { deadlocks: (await innodbDeadlocks(w.root)) - before, aErrors, bErrors };
  }

  it('the real helper on both sides: no deadlock in 40 rounds', async () => {
    const r = await rounds(40, 'real');
    expect(r).toEqual({ deadlocks: 0, aErrors: 0, bErrors: 0 });
  }, 120_000);

  it('NEGATIVE CONTROL: a helper that sorts in code and locks one at a time deadlocks against the real one (at least once in 40 rounds)', async () => {
    const r = await rounds(40, 'wrong');
    console.log(`[x0] T-C21 control: ${r.deadlocks} deadlocks in 40 rounds`);
    expect(r.deadlocks).toBeGreaterThanOrEqual(1);
    expect(r.aErrors + r.bErrors, 'withTx re-runs a deadlock victim, so both sessions still finish').toBe(0);
  }, 120_000);
});

describe('PT-X0 the trail: customer first, then the pieces, the counter last, no lock after a row was written (NODE-DESIGN 5.3)', () => {
  const customerP = async () => addCustomer(w);

  it('the right order leaves the trail claim, customer, pieces, counter, write, and every step is sent', async () => {
    const customer = await customerP();
    const out = await tx$(async (tx) => {
      await claim(tx, { key: randomUUID(), fn: 'toy_order', route: 'POST /toy/order' });
      await lockCustomer(tx, customer);
      await lockPieces(tx, [P_TEXT_FIRST]);
      await takeNumber(tx, 'toy:2026');
      await tx.run('UPDATE bills SET notes = notes WHERE id = ?', [randomUUID()]);
      return [...tx.trail];
    });
    expect(out).toEqual(['claim', 'customer', 'pieces', 'counter', 'write']);
  });

  const violations: [string, (tx: Parameters<Parameters<typeof withTx>[1]>[0], customer: string) => Promise<unknown>, RegExp][] = [
    ['the customer lock after the counter', async (tx, c) => (await takeNumber(tx, 'toy:2026'), lockCustomer(tx, c)), /customer.*after.*counter/i],
    ['a piece lock before the customer lock', async (tx, c) => (await lockPieces(tx, [P_TEXT_FIRST]), lockCustomer(tx, c)), /customer.*after.*pieces/i],
    ['a piece lock after the counter', async (tx) => (await takeNumber(tx, 'toy:2026'), lockPieces(tx, [P_TEXT_FIRST])), /pieces.*after.*counter/i],
    ['the pieces locked in two statements', async (tx) => (await lockPieces(tx, [P_TEXT_FIRST]), lockPieces(tx, [P_SQL_FIRST])), /pieces.*(twice|one statement)/i],
    ['a customer lock after a row was written', async (tx, c) => (await tx.run('UPDATE bills SET notes = notes WHERE id = ?', [randomUUID()]), lockCustomer(tx, c)), /customer.*after.*(write|stamp)/i],
    ['a piece lock after a row was written', async (tx) => (await tx.run('UPDATE bills SET notes = notes WHERE id = ?', [randomUUID()]), lockPieces(tx, [P_TEXT_FIRST])), /pieces.*after.*(write|stamp)/i],
    ['the claim after another step', async (tx, c) => (await lockCustomer(tx, c), claim(tx, { key: randomUUID(), fn: 'toy_late', route: 'POST /toy/late' })), /claim.*first/i],
    ['a second customer in one call', async (tx, c) => (await lockCustomer(tx, c), lockCustomer(tx, await addCustomer(w))), /another customer|one customer|second customer/i],
  ];
  for (const [name, run, detail] of violations) {
    it(`${name} throws LockOrderViolation (JV_INTERNAL, nothing is sent for the offending step)`, async () => {
      const customer = await customerP();
      const spy = spyOn(w.pool);
      const got = await settle(withTx(ctxOf(undefined, {}, spy.pool), (tx) => run(tx, customer)));
      const err = (got as { err: unknown }).err;
      expect(err, name).toBeInstanceOf(LockOrderViolation);
      expect(err).toBeInstanceOf(JvError);
      expect((err as LockOrderViolation).detail).toMatch(detail);
      expect(classifyError(err)).toMatchObject({ code: 'JV_INTERNAL', status: 500, message: 'Something unexpected went wrong.' }); // the client is told nothing about the order
      expect((err as JvError).details).toEqual({});
    });
  }

  it('the offending lock is not even sent: after a counter the customer row is not asked for', async () => {
    const customer = await customerP();
    const spy = spyOn(w.pool);
    await settle(withTx(ctxOf(undefined, {}, spy.pool), async (tx) => (await takeNumber(tx, 'toy:2026'), lockCustomer(tx, customer))));
    expect(spy.sqls().filter((s) => /FROM customers .*FOR UPDATE/.test(s))).toHaveLength(0);
  });

  it('the same customer may be locked again (the re-read of X4 does it), the claim and the counter are not "writes", and the number counter may be taken again (the look-ahead of a bill number)', async () => {
    const customer = await customerP();
    const out = await tx$(async (tx) => {
      await claim(tx, { key: randomUUID(), fn: 'toy_again', route: 'POST /toy/again' });
      await lockCustomer(tx, customer);
      await lockCustomer(tx, customer);
      await takeNumber(tx, 'toy:2026');
      await takeNumber(tx, 'toy:2026');
      return [...tx.trail];
    });
    expect(out).toEqual(['claim', 'customer', 'counter']);
  });

  it('a deadlock re-run starts with an empty trail (a claim as the first step passes again)', async () => {
    const customer = await customerP();
    const spy = spyOn(w.pool);
    let failed = false;
    spy.intercept = async (e) => {
      if (!failed && /FROM customers WHERE id = \? FOR UPDATE$/.test(e.sql)) {
        failed = true;
        throw dbError(1213, 'ER_LOCK_DEADLOCK', 'Deadlock found when trying to get lock; try restarting transaction');
      }
    };
    const out = await withTx(ctxOf(undefined, { sleep: async () => undefined, jitter: () => 1 }, spy.pool), async (tx) => {
      await claim(tx, { key: randomUUID(), fn: 'toy_rerun', route: 'POST /toy/rerun' });
      await lockCustomer(tx, customer);
      return [...tx.trail];
    });
    expect(failed).toBe(true);
    expect(out).toEqual(['claim', 'customer']);
  });
});

describe('PT-X0 the hook point of the customer archive: archive_customer.after_check (X0 item 8)', () => {
  /** The shape of the archive of A5 (K4): the customer lock, the check of the balance (the hook), then the archive. */
  const toyArchive = (customerId: string, requestId: string) =>
    settle(
      tx$(async (tx) => {
        const c = await lockCustomer(tx, customerId);
        if (!c) throw new JvError('JV_NOT_FOUND', 'no such customer');
        const { readCustomerTotals } = await import('../../src/db/state');
        const totals = await readCustomerTotals(tx, { fn: 'archive_customer', customerId });
        if (totals.outstanding !== '0.00' || totals.advance !== '0.00') throw new JvError('JV_NOT_ALLOWED', 'the balance is not zero');
        await tx.run("UPDATE customers SET archived_at = '2026-10-17 10:00:00.000000' WHERE id = ?", [customerId]);
        return 'archived';
      }, requestId),
    );
  /** The shape of X1's start: the customer lock, then "not archived", then a bill. */
  const toyBill = (customerId: string) =>
    settle(
      tx$(async (tx) => {
        const c = await lockCustomer(tx, customerId);
        if (!c) throw new JvError('JV_NOT_FOUND', 'no such customer');
        if (c.archived_at !== null) throw new JvError('JV_CUSTOMER_ARCHIVED', 'archived');
        await tx.run("INSERT INTO bills (id, bill_no, customer_id, bill_date, sale_type, subtotal, grand_total) VALUES (?, ?, ?, '2026-10-17', 'Retail', 100, 100)", [randomUUID(), `TA-${randomUUID().slice(0, 8)}`, customerId]);
        return 'billed';
      }),
    );
  async function race() {
    const customer = await addCustomer(w);
    const gates = Gates.install();
    const r1 = randomUUID();
    const g1 = gates.forRequest(r1);
    try {
      const archive = toyArchive(customer, r1);
      expect(await g1.reached).toBe('archive_customer.after_check');
      const bill = toyBill(customer);
      await sleep(400);
      g1.release();
      const [a, b] = await Promise.all([archive, bill]);
      const n = await rowOf(w.root, `SELECT COUNT(*) AS n FROM ${w.db()}.bills WHERE customer_id = ?`, [customer]);
      const c = await rowOf(w.root, `SELECT archived_at FROM ${w.db()}.customers WHERE id = ?`, [customer]);
      return { a, b, bills: Number(n.n), archived: c.archived_at !== null };
    } finally {
      gates.restore();
    }
  }

  it('with the lock a bill that arrives while the archive is held at the check is refused JV_CUSTOMER_ARCHIVED: an archived customer has no new dues', async () => {
    const r = await race();
    expect(r.a).toEqual({ ok: 'archived' });
    expect((r.b as { err: JvError }).err.code).toBe('JV_CUSTOMER_ARCHIVED');
    expect(r).toMatchObject({ bills: 0, archived: true });
  });

  it('NEGATIVE CONTROL: with the lock helper replaced by a no-op the customer is archived with a new bill on the books', async () => {
    const undo = withoutCustomerLock();
    try {
      const r = await race();
      expect(r.b).toEqual({ ok: 'billed' });
      expect(r).toMatchObject({ bills: 1, archived: true });
    } finally {
      undo();
    }
  });
});

describe('T-D29 clause (API15): the production bundle contains no ctx.pause test hook', () => {
  let dist: string;
  beforeAll(() => {
    dist = buildDist();
  }, 120_000);
  afterEach(() => undefined);

  it('the compiled output of src/, which now holds the lock helpers, the state read, the touches and the audit writer, has no ctx.pause, no pause() call and no hook point name', async () => {
    const { existsSync } = await import('node:fs');
    const { join } = await import('node:path');
    for (const f of ['db/locks.js', 'db/state.js', 'db/touch.js', 'db/audit.js']) expect(existsSync(join(dist, f)), `${f} is in the build (so this scan is not empty)`).toBe(true);
    expect(pauseHookHits(dist)).toEqual([]);
  });
});
