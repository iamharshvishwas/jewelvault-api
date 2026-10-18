import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as locks from '../../src/db/locks';
import { type Designs, addDesigns, billBody, item, piece, postBill } from './x01-support';
import { Gates, withoutCustomerLock } from './x0-support';
import { type Call, invariantsFor, overAllocated, pair } from './x04-pair';
import { billStates, receiptRow, voidReceipt } from './x04-support';
import { type EditWorld, addAllocation, addBill, addCustomer, addMoney, allocationsOf, body, codeOf, editWorld, figures, newKey, pay, pendingByBill, rows } from './x02-support';

// API25, T-C12 for X4 void_receipt (X0 items 3 and 8): a void beside another call for the same customer, through the real routes, with the test hook `x04.after_read` (the return of the state read of
// the function, held by the test build's wrapper `Gates`, one gate for each session; nothing of it is in src/). Each test NAMES ITS START STATE, because a pair can pass without the lock when the
// final books are the same either way. (a) a bill of 1,000 paid fully by receipt R1, `void_receipt` of R1 beside `record_payment` of 500; (b) the same plus a spare advance of 300, `void_receipt` of R1
// beside `create_bill` of 400; (c) two `void_receipt` calls of one receipt at once, with different keys: one success, one JV_ALREADY_VOID, never JV_BUSY. In (a) and (b) the call that starts first is held
// for less than 3 seconds, the other is started, and the gates are released in both orders; with the lock in place session 2 waits at the customer lock and the books are right whichever way round.
// With the customer-lock helper replaced by a no-op the same assertions FAIL (the negative controls). (c) does not need the customer lock: the receipt row's own FOR UPDATE already makes the second
// call wait, which the last control shows.

let w: EditWorld;
let d: Designs;

beforeAll(async () => {
  w = await editWorld('x04two');
  d = await addDesigns(w);
}, 120_000);
afterAll(async () => {
  await w?.world.close();
}, 60_000);

const upi = (amount: string) => ({ amount, mode: 'UPI' });
const voidCall = (receipt: string, caller: 'owner' = 'owner'): Call => ({ hook: 'x04.after_read', start: () => voidReceipt(w, caller, receipt, { reason: 'entered twice by mistake' }) });
const payCall = (customer: string, amount: string): Call => ({ hook: 'x02.after_read', start: () => pay(w, 'biller', customer, upi(amount)) });
const billCall = (customer: string, total: string): Call => ({
  hook: 'create_bill.after_read',
  start: async () => postBill(w, 'biller', billBody(customer, 'Retail', [item(await piece(w, d.gold24pp, { retail: total }), { metal_rate: total })])),
});

/** The books of the start state of (a): A of 1,000 fully paid by R1. */
async function startA() {
  const c = await addCustomer(w);
  const a = await addBill(w, c, '1000.00', '2026-10-01');
  const r1 = await addMoney(w, c, '1000.00', '2026-10-02');
  await addAllocation(w, r1, a, c, '1000.00');
  return { c, a, r1 };
}
/** The start state of (b): the same plus a spare advance of 300 in R2. */
async function startB() {
  const s = await startA();
  const r2 = await addMoney(w, s.c, '300.00', '2026-10-03');
  return { ...s, r2 };
}

/** The allocations that count: not released, and of a receipt that is active (a voided receipt's allocation is never released but never counted). */
const live = async (customer: string): Promise<number> =>
  Number((await rows(w, "SELECT COUNT(*) AS n FROM receipt_allocations a JOIN receipts r ON r.id = a.receipt_id WHERE a.customer_id = ? AND a.released_at IS NULL AND r.status = 'active'", [customer]))[0].n);

describe('T-C12 (a) a bill of 1,000 paid fully by R1: void_receipt of R1 beside record_payment of 500 (X0 items 3 and 8, X4, X2)', () => {
  const orders = [
    { name: 'the void is held first', first: (s: Awaited<ReturnType<typeof startA>>) => voidCall(s.r1), second: (s: Awaited<ReturnType<typeof startA>>) => payCall(s.c, '500.00') },
    { name: 'the payment is held first', first: (s: Awaited<ReturnType<typeof startA>>) => payCall(s.c, '500.00'), second: (s: Awaited<ReturnType<typeof startA>>) => voidCall(s.r1) },
  ];

  /** With the lock: whichever call goes first, the bill ends 500 pending, R1 is voided, the 500 is applied once, and no advance is left. */
  async function expectLocked(s: Awaited<ReturnType<typeof startA>>, p: Awaited<ReturnType<typeof pair>>, voidStatus: number) {
    expect(p.secondAtHookWhileFirstHeld, 'session 2 must still be waiting for the customer lock, not at the hook').toBe(false);
    expect([p.first.statusCode, p.second.statusCode].sort(), `${p.first.body} ${p.second.body}`).toEqual([voidStatus, 201].sort());
    expect((await receiptRow(w, s.r1)).status).toBe('voided');
    expect(await pendingByBill(w, s.c)).toEqual({ [s.a]: '500.00' });
    expect(await figures(w, s.c)).toMatchObject({ outstanding: '500.00', advance: '0.00' });
    expect(await live(s.c), 'R1 is voided (its allocation does not count) and the new payment pays 500: one allocation counts').toBe(1);
    expect(await overAllocated(w, s.c)).toEqual([]);
    expect(await invariantsFor(w, s.c)).toEqual([]);
    expect(p.autoReleased, 'a gate that let go by itself after 3 s proves nothing').toBe(false);
  }

  for (const o of orders) {
    for (const release of ['S1first', 'S2first'] as const) {
      it(`with the customer lock in place session 2 waits at the lock and the books are right: ${o.name}, released ${release}`, async () => {
        const s = await startA();
        const p = await pair(o.first(s), o.second(s), release);
        await expectLocked(s, p, 200);
        expect(p.points.filter((x) => x === 'x04.after_read'), 'each session reads the state of the customer once').toHaveLength(1);
      });

      it(`NEGATIVE CONTROL: with the customer-lock helper replaced by a no-op the same test FAILS: ${o.name}, released ${release}: session 2 gets to the hook beside session 1 and an advance is left beside a pending bill`, async () => {
        const undo = withoutCustomerLock();
        try {
          const s = await startA();
          const p = await pair(o.first(s), o.second(s), release);
          expect(p.secondAtHookWhileFirstHeld, 'without the lock session 2 gets to the hook beside session 1').toBe(true);
          // what the lock prevents: both calls decided from the same state, so the money received beside the void is not applied to the bill the void re-opened
          expect(await pendingByBill(w, s.c)).toEqual({ [s.a]: '1000.00' });
          expect(await figures(w, s.c)).toMatchObject({ outstanding: '1000.00', advance: '500.00' });
          expect((await invariantsFor(w, s.c)).length, 'I10 is broken: an advance beside a pending bill').toBeGreaterThan(0);
          await expect(expectLocked(s, p, 200)).rejects.toThrow();
        } finally {
          undo();
        }
      });
    }
  }
});

describe('T-C12 (b) the same plus a spare advance of 300 in R2: void_receipt of R1 beside create_bill of 400', () => {
  const orders = [
    { name: 'the void is held first', first: (s: Awaited<ReturnType<typeof startB>>) => voidCall(s.r1), second: (s: Awaited<ReturnType<typeof startB>>) => billCall(s.c, '400.00'), voidFirst: true },
    { name: 'the bill is held first', first: (s: Awaited<ReturnType<typeof startB>>) => billCall(s.c, '400.00'), second: (s: Awaited<ReturnType<typeof startB>>) => voidCall(s.r1), voidFirst: false },
  ];

  /** The 300 of R2 is spent ONCE: by the void on A when the void goes first (A 700, B 400), by the new bill when the bill goes first (B 100, A 1000). Outstanding is 1,100 either way, the advance 0. */
  async function expectLocked(s: Awaited<ReturnType<typeof startB>>, p: Awaited<ReturnType<typeof pair>>, voidFirst: boolean) {
    expect(p.secondAtHookWhileFirstHeld, 'session 2 must still be waiting for the customer lock, not at the hook').toBe(false);
    const voidRes = voidFirst ? p.first : p.second;
    const billRes = voidFirst ? p.second : p.first;
    expect({ void: voidRes.statusCode, bill: billRes.statusCode }, `${voidRes.body} ${billRes.body}`).toEqual({ void: 200, bill: 201 });
    const newBill = String(body(billRes).bill.id);
    expect(await pendingByBill(w, s.c)).toEqual(voidFirst ? { [s.a]: '700.00', [newBill]: '400.00' } : { [s.a]: '1000.00', [newBill]: '100.00' });
    expect(await figures(w, s.c)).toMatchObject({ outstanding: '1100.00', advance: '0.00' });
    expect(await overAllocated(w, s.c)).toEqual([]);
    expect(await invariantsFor(w, s.c)).toEqual([]);
    const spent = (await allocationsOf(w, s.c)).filter((x) => x.receipt_id === s.r2).reduce((n, x) => n + BigInt(String(x.amount).replace('.', '')), 0n);
    expect(spent, 'R2 holds 300 and is spent once').toBe(30_000n);
    expect(p.autoReleased).toBe(false);
  }

  for (const o of orders) {
    for (const release of ['S1first', 'S2first'] as const) {
      it(`with the customer lock in place the 300 is spent once and the books are right: ${o.name}, released ${release}`, async () => {
        const s = await startB();
        const p = await pair(o.first(s), o.second(s), release);
        await expectLocked(s, p, o.voidFirst);
      });

      it(`NEGATIVE CONTROL: with the customer-lock helper replaced by a no-op the same test FAILS: ${o.name}, released ${release}: both sessions spend the same 300`, async () => {
        const undo = withoutCustomerLock();
        try {
          const s = await startB();
          const p = await pair(o.first(s), o.second(s), release);
          expect(p.secondAtHookWhileFirstHeld, 'without the lock session 2 gets to the hook beside session 1').toBe(true);
          const broken = [...(await overAllocated(w, s.c)), ...(await invariantsFor(w, s.c))];
          expect(broken.length, `the 300 of R2 was applied twice: ${broken.join('; ')}`).toBeGreaterThan(0);
          await expect(expectLocked(s, p, o.voidFirst)).rejects.toThrow();
        } finally {
          undo();
        }
      });
    }
  }
});

describe('T-C12 (c) two void_receipt calls of one receipt at once, with different keys: one success and one JV_ALREADY_VOID, never JV_BUSY (X0 item 3)', () => {
  function expectOneWinner(a: LightMyRequestResponse, b: LightMyRequestResponse) {
    const results = [a, b].map((r) => ({ status: r.statusCode, code: r.statusCode === 200 ? undefined : codeOf(r) }));
    expect(results.sort((x, y) => x.status - y.status), `${a.body} ${b.body}`).toEqual([{ status: 200, code: undefined }, { status: 409, code: 'JV_ALREADY_VOID' }]);
  }

  for (const release of ['S1first', 'S2first'] as const) {
    it(`held at the hook: session 2 waits at the customer lock, then answers JV_ALREADY_VOID (${release})`, async () => {
      const s = await startA();
      const p = await pair(voidCall(s.r1), voidCall(s.r1), release);
      expect(p.secondAtHookWhileFirstHeld).toBe(false);
      expectOneWinner(p.first, p.second);
      expect(p.first.statusCode, 'the held call is the one that wins').toBe(200);
      expect(await pendingByBill(w, s.c)).toEqual({ [s.a]: '1000.00' });
      expect(await invariantsFor(w, s.c)).toEqual([]);
      expect(p.autoReleased).toBe(false);
    });
  }

  it('without a gate, 12 rounds of two voids of one receipt at the same moment: every round is one 200 and one 409 JV_ALREADY_VOID, never a 503', async () => {
    for (let round = 0; round < 12; round++) {
      const s = await startA();
      const [x, y] = await Promise.all([voidReceipt(w, 'owner', s.r1, { reason: 'first of two' }, newKey()), voidReceipt(w, 'owner', s.r1, { reason: 'second of two' }, newKey())]);
      expectOneWinner(x, y);
      expect(await pendingByBill(w, s.c)).toEqual({ [s.a]: '1000.00' });
    }
  });

  it('(c) does not need the customer lock: with it replaced by the receipt row\'s own FOR UPDATE alone the answer is the same and there is no false JV_BUSY', async () => {
    const spy = vi.spyOn(locks, 'lockCustomerOf').mockImplementation(async (tx, table, id) => {
      const found = await tx.rows<{ customer_id: string }>('SELECT customer_id FROM receipts WHERE id = ?', [id]);
      if (found.length === 0) return null;
      locks.noteStep(tx, 'customer', found[0].customer_id);
      const customer = (await tx.rows<locks.CustomerLockRow>('SELECT id, name, mobile, customer_type, gst_number, pan, is_walkin, archived_at FROM customers WHERE id = ?', [found[0].customer_id]))[0];
      const row = (await tx.rows<locks.LockedRow>(`SELECT * FROM ${table} WHERE id = ? FOR UPDATE`, [id]))[0]; // the receipt row's own lock, and no customer lock
      return { customer, row };
    });
    try {
      const s = await startA();
      const p = await pair(voidCall(s.r1), voidCall(s.r1), 'S1first');
      expectOneWinner(p.first, p.second);
      expect(p.secondAtHookWhileFirstHeld, 'session 2 waits on the receipt row, not at the hook').toBe(false);
      expect(await pendingByBill(w, s.c)).toEqual({ [s.a]: '1000.00' });
    } finally {
      spy.mockRestore();
    }
  });
});

describe('X4 beside X4: two voids of two receipts of one customer are serialised, and two customers do not wait for each other', () => {
  it('R1 and R2 paid the same bill; both are voided at once (one held at the hook): both succeed, the bill is pending in full, nothing is left over', async () => {
    const c = await addCustomer(w);
    const a = await addBill(w, c, '1000.00', '2026-10-01');
    const r1 = await addMoney(w, c, '600.00', '2026-10-02');
    const r2 = await addMoney(w, c, '400.00', '2026-10-03');
    await addAllocation(w, r1, a, c, '600.00');
    await addAllocation(w, r2, a, c, '400.00');
    const p = await pair(voidCall(r1), voidCall(r2), 'S1first');
    expect([p.first.statusCode, p.second.statusCode], `${p.first.body} ${p.second.body}`).toEqual([200, 200]);
    expect(p.secondAtHookWhileFirstHeld).toBe(false);
    expect(body(p.second).bills.map((x: any) => [x.id, x.pending]), 'the second void read the state after the first had committed').toEqual([[a, '1000.00']]);
    expect(await pendingByBill(w, c)).toEqual({ [a]: '1000.00' });
    expect(await figures(w, c)).toMatchObject({ outstanding: '1000.00', advance: '0.00' });
    expect(await invariantsFor(w, c)).toEqual([]);
    expect((await billStates(w, c))[a]).toMatchObject({ received: '0.00', payment_status: 'Pending' });
  });

  it('a void for customer B goes through while a void for customer A is held at the hook', async () => {
    const [a, b] = [await startA(), await startA()];
    const gates = Gates.install();
    try {
      const g = gates.forNextSession();
      const held = voidReceipt(w, 'owner', a.r1);
      expect(await Promise.race([g.reached, held.then((r) => `ended with ${r.statusCode}`)])).toBe('x04.after_read');
      const other = await voidReceipt(w, 'owner', b.r1);
      expect(other.statusCode, other.body).toBe(200);
      expect(g.isAtHook, 'A\'s void is still held').toBe(true);
      g.release();
      expect((await held).statusCode).toBe(200);
    } finally {
      gates.restore();
    }
  });
});
