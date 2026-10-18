import type { LightMyRequestResponse } from 'fastify';
import { runInvariants } from '../../scripts/invariants.mjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Gates, withoutCustomerLock } from './x0-support';
import { addOpening, numberOf, opened, opening, totalsOf } from './x12-support';
import { type EditWorld, addCustomer, allocationsOf, body, editWorld, i10Holds, pay, pendingAgrees, receiptsOf, rows } from './x02-support';

// API27, the two-session test for X12 (X0 items 3 and 8, Y6, I10, X12): two writers for one customer at once, through the real route, with the test hook `x12.after_read` (the return of the state read of
// the call, held by the test build's wrapper `Gates`, one gate for each session; nothing of it is in src/). Start state: a customer with nothing. Session 1 adds opening DUES of 1,000 and is held at the
// hook; session 2 is an opening ADVANCE of 400 (second case: a payment of 300 by X2). With the customer lock in place session 2 waits at the lock, not at the hook, reads the state AFTER session 1
// committed (an opening bill pending 1,000) and nets off against it: pending 600 and no advance (or pending 700 for the payment), and the result is the same in both release orders. With the customer-lock helper
// replaced by a no-op the same test fails: session 2 reads an empty customer beside session 1, its advance is saved with nothing to pay, session 1 then saves its bill from the same empty state, and
// the customer holds an advance of 400 WHILE 1,000 is outstanding, which I10 forbids.

let w: EditWorld;

beforeAll(async () => {
  w = await editWorld('x12two');
}, 120_000);
afterAll(async () => {
  await w?.world.close();
}, 60_000);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Second = 'x12 advance' | 'x2 payment';

interface Outcome {
  customer: string;
  first: LightMyRequestResponse;
  second: LightMyRequestResponse;
  /** was session 2 at the hook while session 1 was still held there? (it must not be: it waits for the customer lock) */
  secondAtHookWhileFirstHeld: boolean;
  gatesAutoReleased: boolean;
  points: string[];
}

/** Session 1 (opening dues of 1,000) is held at `x12.after_read`; session 2 is started; then both are released in the order asked. */
async function twoSessions(second: Second, order: 'S1first' | 'S2first'): Promise<Outcome> {
  const customer = await addCustomer(w);
  const gates = Gates.install();
  try {
    const g1 = gates.forNextSession();
    const call1 = addOpening(w, 'owner', customer, opening({ dues: '1000.00' }));
    const reached = await Promise.race([g1.reached, call1.then((r) => `session 1 ended with ${r.statusCode} before it reached the hook`)]);
    expect(reached).toBe('x12.after_read');
    const g2 = gates.forNextSession();
    const call2 = second === 'x12 advance' ? addOpening(w, 'owner', customer, opening({ advance: '400.00' })) : pay(w, 'biller', customer, { amount: '300.00', mode: 'UPI' });
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
    const [r1, r2] = await Promise.all([call1, call2]);
    return { customer, first: r1, second: r2, secondAtHookWhileFirstHeld, gatesAutoReleased: g1.autoReleased || g2.autoReleased, points: gates.points.map((p) => p.point) };
  } finally {
    gates.restore();
  }
}

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
  const paise = (t: string) => BigInt(t.replace('.', ''));
  return { received: String(r.received), allocated: String(r.allocated), billed: String(r.billed), overAllocated: paise(String(r.allocated)) > paise(String(r.billed)) };
}

const EXPECTED: Record<Second, { received: string; allocated: string; outstanding: string; advance: string }> = {
  'x12 advance': { received: '400.00', allocated: '400.00', outstanding: '600.00', advance: '0.00' },
  'x2 payment': { received: '300.00', allocated: '300.00', outstanding: '700.00', advance: '0.00' },
};

/** The expectations with the lock in place. */
async function expectLockedOutcome(second: Second, o: Outcome): Promise<void> {
  expect(o.secondAtHookWhileFirstHeld, 'session 2 must still be waiting for the customer lock, not at the hook').toBe(false);
  expect(o.first.statusCode, o.first.body).toBe(201);
  expect(o.second.statusCode, o.second.body).toBe(201);
  // session 2 read the state AFTER session 1 had committed: the opening bill was there to be paid
  const made = body(o.second).allocations;
  expect(made.map((a: any) => a.amount)).toEqual([EXPECTED[second].allocated]);
  expect(made[0].bill_id).toBe(body(o.first).bill.id);
  const e = EXPECTED[second];
  expect(await books(o.customer)).toEqual({ received: e.received, allocated: e.allocated, billed: '1000.00', overAllocated: false });
  expect(await totalsOf(w, o.customer)).toMatchObject({ outstanding: e.outstanding, advance: e.advance });
  expect(await allocationsOf(w, o.customer)).toHaveLength(1);
  expect(await receiptsOf(w, o.customer)).toHaveLength(1);
  await pendingAgrees(w, o.customer);
  await i10Holds(w, o.customer);
  expect(o.gatesAutoReleased, 'a gate that let go by itself after 3 s proves nothing').toBe(false);
}

describe('T-C09 style: opening dues beside an opening advance or a payment for one customer do not both read the empty customer (X0 items 3 and 8, Y6, I10, X12)', () => {
  for (const second of ['x12 advance', 'x2 payment'] as const) {
    for (const order of ['S1first', 'S2first'] as const) {
      it(`${second}: with the customer lock in place session 2 waits at the lock, not at the hook, and pays the opening bill session 1 saved; the books net off once (${order})`, async () => {
        const o = await twoSessions(second, order);
        await expectLockedOutcome(second, o);
        expect(o.points.filter((p) => p === 'x12.after_read'), 'each X12 session that gets to read the state of the customer reads it once').toHaveLength(second === 'x12 advance' ? 2 : 1);
      });

      it(`${second}: NEGATIVE CONTROL: with the customer-lock helper replaced by a no-op in the test build the same test FAILS (${order}): session 2 reaches the hook beside session 1 and the customer holds an advance beside open dues`, async () => {
        const undo = withoutCustomerLock();
        try {
          const o = await twoSessions(second, order);
          // the observation that makes it fail: session 2 is at the hook (or past the state read) while session 1 is held there, because nothing made it wait
          expect(o.secondAtHookWhileFirstHeld, 'without the lock session 2 gets to the hook beside session 1').toBe(true);
          // and the books say what the lock prevents: an advance is held while 1,000 is outstanding (I10)
          const t = await totalsOf(w, o.customer);
          expect(Number(t.advance) > 0 && Number(t.outstanding) > 0, `an advance beside open dues: ${JSON.stringify(t)}`).toBe(true);
          expect(await allocationsOf(w, o.customer), 'nothing was netted off').toHaveLength(0);
          const out = await runInvariants(w.world.sql, { sample: 10_000 });
          expect(out.rows.filter((r: { invariant: string; row_ref: string }) => r.invariant === 'I10' && r.row_ref === `customers:${o.customer}`).length, 'I10 names the customer').toBeGreaterThan(0);
          // so the assertions of the real test do not hold
          await expect(expectLockedOutcome(second, o)).rejects.toThrow();
        } finally {
          undo();
        }
      });
    }
  }

  it('without a gate: eight calls at once on one customer (six opening dues, two opening advances), no deadlock and no JV_BUSY: six consecutive OB numbers, the books net off exactly, I5 and I10 hold', async () => {
    const customer = await addCustomer(w);
    const calls = [
      ...[1, 2, 3, 4, 5, 6].map((n) => addOpening(w, 'owner', customer, opening({ dues: `${n * 100}.00` }))),
      addOpening(w, 'owner', customer, opening({ advance: '250.00' })),
      addOpening(w, 'owner', customer, opening({ advance: '75.50' })),
    ];
    const answers = await Promise.all(calls);
    expect(answers.map((a) => a.statusCode), answers.map((a) => a.body).join(' ')).toEqual([201, 201, 201, 201, 201, 201, 201, 201]);
    const numbers = answers.slice(0, 6).map((a) => numberOf(body(a).bill.bill_no)).sort((x, y) => x - y);
    expect(numbers.slice(1).map((n, i) => n - numbers[i]), 'six consecutive numbers').toEqual([1, 1, 1, 1, 1]);
    // dues 2,100 less advances 325.50, however they were ordered
    expect(await totalsOf(w, customer)).toMatchObject({ billed: '2100.00', received: '325.50', allocated: '325.50', outstanding: '1774.50', advance: '0.00' });
    await pendingAgrees(w, customer);
    await i10Holds(w, customer);
    const out = await runInvariants(w.world.sql, { sample: 10_000 });
    expect(out.rows.filter((r: { invariant: string }) => r.invariant === 'I5'), 'the OB numbers are contiguous').toEqual([]);
  });

  it('two customers do not wait for each other: an X12 call for B goes through while a call for A is held at the hook', async () => {
    const [a, b] = [await addCustomer(w), await addCustomer(w)];
    const gates = Gates.install();
    try {
      const g = gates.forNextSession();
      const held = addOpening(w, 'owner', a, opening({ dues: '100.00' }));
      expect(await Promise.race([g.reached, held.then((r) => `ended with ${r.statusCode}`)])).toBe('x12.after_read');
      const other = await addOpening(w, 'owner', b, opening({ dues: '50.00', advance: '20.00' }));
      expect(other.statusCode, other.body).toBe(201);
      expect(g.isAtHook, 'A\'s call is still held').toBe(true);
      g.release();
      expect((await held).statusCode).toBe(201);
    } finally {
      gates.restore();
    }
    expect((await opened(await addOpening(w, 'owner', a, opening({ advance: '10.00' })))).allocations).toHaveLength(1);
  });
});
