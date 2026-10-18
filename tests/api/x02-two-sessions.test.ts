import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Gates, withoutCustomerLock } from './x0-support';
import { type EditWorld, addBill, addCustomer, allocationsOf, body, editWorld, figures, i10Holds, pay, pendingByBill, receiptsOf, rows } from './x02-support';

// API22, T-C09 (X0 item 8, X2): two payments for one customer at once, through the real route, with the test hook `x02.after_read` (the return of the state read of the call, held by the test build's
// wrapper `Gates`, one gate for each session; nothing of it is in src/). Start state: one unpaid bill of 1,000. Two concurrent payments of 600 allocate without applying the same pending amount
// twice: with the customer lock in place session 2 waits at the lock, not at the hook, reads the state AFTER session 1 committed, takes the 400 that is still pending and keeps 200 as an advance;
// the result is the same in both release orders. With the customer-lock helper replaced by a no-op the same test fails: both sessions read a pending of 1,000, both allocate 600, and the bill
// is paid 1,200 on 1,000.

let w: EditWorld;

beforeAll(async () => {
  w = await editWorld('x02two');
}, 120_000);
afterAll(async () => {
  await w?.world.close();
}, 60_000);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const money = (amount: string) => ({ amount, mode: 'UPI' });

interface Outcome {
  customer: string;
  bill: string;
  first: LightMyRequestResponse;
  second: LightMyRequestResponse;
  /** was session 2 at the hook while session 1 was still held there? (it must not be: it waits for the customer lock) */
  secondAtHookWhileFirstHeld: boolean;
  gatesAutoReleased: boolean;
  points: string[];
}

/** Session 1 is held at `x02.after_read`; session 2 is started; then both are released in the order asked. */
async function twoPayments(order: 'S1first' | 'S2first'): Promise<Outcome> {
  const customer = await addCustomer(w);
  const bill = await addBill(w, customer, '1000.00', '2026-10-10');
  const gates = Gates.install();
  try {
    const g1 = gates.forNextSession();
    const call1 = pay(w, 'owner', customer, money('600.00'));
    const reached = await Promise.race([g1.reached, call1.then((r) => `session 1 ended with ${r.statusCode} before it reached the hook`)]);
    expect(reached).toBe('x02.after_read');
    const g2 = gates.forNextSession();
    const call2 = pay(w, 'biller', customer, money('600.00'));
    await sleep(400); // session 2 has had time to reach the hook, if nothing stops it
    const secondAtHookWhileFirstHeld = g2.isAtHook;
    if (order === 'S2first') {
      g2.release();
      await sleep(300);
      g1.release();
    } else {
      g1.release();
      await sleep(300);
      g2.release();
    }
    const [first, second] = await Promise.all([call1, call2]);
    return { customer, bill, first, second, secondAtHookWhileFirstHeld, gatesAutoReleased: g1.autoReleased || g2.autoReleased, points: gates.points.map((p) => p.point) };
  } finally {
    gates.restore();
  }
}

const cents = (text: string): bigint => BigInt(text.replace('.', ''));

/** What the books hold for the customer, from the base tables with plain SQL (not through the code under test). */
async function books(customer: string) {
  const [r] = await rows(
    w,
    `SELECT
       (SELECT COALESCE(SUM(amount), 0) FROM receipts WHERE customer_id = ? AND status = 'active' AND kind = 'money') AS received,
       (SELECT COALESCE(SUM(a.amount), 0) FROM receipt_allocations a JOIN receipts r ON r.id = a.receipt_id WHERE a.customer_id = ? AND a.released_at IS NULL AND r.status = 'active') AS allocated,
       (SELECT COALESCE(SUM(grand_total), 0) FROM bills WHERE customer_id = ? AND status = 'active') AS billed`,
    [customer, customer, customer],
  );
  return { received: String(r.received), allocated: String(r.allocated), billed: String(r.billed), overAllocated: cents(String(r.allocated)) > cents(String(r.billed)) };
}

/** The expectations of T-C09 with the lock in place. */
async function expectLockedOutcome(o: Outcome): Promise<void> {
  expect(o.secondAtHookWhileFirstHeld, 'session 2 must still be waiting for the customer lock, not at the hook').toBe(false);
  expect(o.first.statusCode, o.first.body).toBe(201);
  expect(o.second.statusCode, o.second.body).toBe(201);
  const [a, b] = [body(o.first), body(o.second)];
  expect(a.allocations.map((x: any) => x.amount)).toEqual(['600.00']);
  expect(a.advance_remaining).toBe('0.00');
  expect(b.allocations.map((x: any) => x.amount), 'session 2 read the state AFTER session 1 had committed: only 400 was still pending').toEqual(['400.00']);
  expect(b.advance_remaining).toBe('200.00');
  expect(await books(o.customer)).toEqual({ received: '1200.00', allocated: '1000.00', billed: '1000.00', overAllocated: false });
  expect(await figures(w, o.customer)).toMatchObject({ outstanding: '0.00', advance: '200.00' });
  expect(await pendingByBill(w, o.customer)).toEqual({ [o.bill]: '0.00' });
  expect(await allocationsOf(w, o.customer)).toHaveLength(2);
  expect(await receiptsOf(w, o.customer)).toHaveLength(2);
  await i10Holds(w, o.customer);
  expect(o.gatesAutoReleased, 'a gate that let go by itself after 3 s proves nothing').toBe(false);
}

describe('T-C09 two concurrent payments of 600 on one unpaid bill of 1,000 do not apply the same pending amount twice (X0 items 3 and 8, X2)', () => {
  for (const order of ['S1first', 'S2first'] as const) {
    it(`with the customer lock in place session 2 waits at the lock, not at the hook, and the books are right: 600 and 400 allocated, 200 kept as an advance (${order})`, async () => {
      const o = await twoPayments(order);
      await expectLockedOutcome(o);
      expect(o.points.filter((p) => p === 'x02.after_read'), 'each session reads the state of the customer once').toHaveLength(2);
    });

    it(`NEGATIVE CONTROL: with the customer-lock helper replaced by a no-op in the test build the same test FAILS (${order}): session 2 reaches the hook beside session 1 and the bill is paid twice`, async () => {
      const undo = withoutCustomerLock();
      try {
        const o = await twoPayments(order);
        // the observation that makes it fail: session 2 is at the hook while session 1 is held there, because nothing made it wait
        expect(o.secondAtHookWhileFirstHeld, 'without the lock session 2 gets to the hook beside session 1').toBe(true);
        // and the books say what the lock prevents: both read a pending of 1,000, both allocated 600
        const b = await books(o.customer);
        expect(b.overAllocated, `the bill is paid twice: ${JSON.stringify(b)}`).toBe(true);
        expect(b.allocated).toBe('1200.00');
        expect(await pendingByBill(w, o.customer)).toEqual({ [o.bill]: '-200.00' });
        // so the assertions of the real test do not hold
        await expect(expectLockedOutcome(o)).rejects.toThrow();
      } finally {
        undo();
      }
    });
  }

  it('without a gate: eight payments at once on one customer, no deadlock and no JV_BUSY; the bill of 1,000 is paid exactly once and the rest is the advance', async () => {
    const customer = await addCustomer(w);
    const bill = await addBill(w, customer, '1000.00', '2026-10-10');
    const callers = ['owner', 'biller', 'owner', 'biller', 'owner', 'biller', 'owner', 'biller'] as const;
    const answers = await Promise.all(callers.map((c) => pay(w, c, customer, money('300.00'))));
    expect(answers.map((a) => a.statusCode), answers.map((a) => a.body).join(' ')).toEqual(callers.map(() => 201));
    const applied = answers.reduce((n, a) => n + body(a).allocations.reduce((m: bigint, x: any) => m + cents(x.amount), 0n), 0n);
    expect(applied).toBe(100_000n);
    const kept = answers.reduce((n, a) => n + cents(body(a).advance_remaining), 0n);
    expect(kept).toBe(8n * 30_000n - 100_000n);
    expect(await pendingByBill(w, customer)).toEqual({ [bill]: '0.00' });
    expect(await figures(w, customer)).toMatchObject({ outstanding: '0.00', advance: '1400.00' });
    await i10Holds(w, customer);
  });

  it('two customers do not wait for each other: a payment for B goes through while a payment for A is held at the hook', async () => {
    const [a, b] = [await addCustomer(w), await addCustomer(w)];
    await addBill(w, a, '100.00', '2026-10-10');
    const gates = Gates.install();
    try {
      const g = gates.forNextSession();
      const held = pay(w, 'owner', a, money('50.00'));
      expect(await Promise.race([g.reached, held.then((r) => `ended with ${r.statusCode}`)])).toBe('x02.after_read');
      const other = await pay(w, 'biller', b, money('70.00'));
      expect(other.statusCode, other.body).toBe(201);
      expect(g.isAtHook, 'A\'s payment is still held').toBe(true);
      g.release();
      expect((await held).statusCode).toBe(201);
    } finally {
      gates.restore();
    }
  });
});
