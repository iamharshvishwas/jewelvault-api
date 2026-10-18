import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addFineBill, fineAgrees, finePendingByBill, settle, silver } from './x03-support';
import { Gates, withoutCustomerLock } from './x0-support';
import { type EditWorld, addCustomer, allocationsOf, body, editWorld, figures, i10Holds, receiptsOf, rows } from './x02-support';

// API24, T-C09 for X3 (X0 items 3 and 8, SF2): two settlements for one customer at once, through the real route, with the test hook `x03.after_read` (the return of the state read of the call, held by
// the test build's wrapper `Gates`, one gate for each session; nothing of it is in src/). Start state: one bill that owes 10 g of silver. Two concurrent settlements of 6 g: with the customer lock in
// place session 2 waits at the lock, not at the hook, reads the state AFTER session 1 committed, finds 4 g outstanding and is refused with JV_FINE_EXCEEDS and the maximum 4.000 (SF2); the result is the
// same in both release orders. With the customer-lock helper replaced by a no-op the same test fails: both sessions read 10 g outstanding, both pass SF2, both allocate 6 g, and the bill has
// -2.000 g pending (12 g settled against 10 g owed).

let w: EditWorld;

beforeAll(async () => {
  w = await editWorld('x03two');
}, 120_000);
afterAll(async () => {
  await w?.world.close();
}, 60_000);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const milli = (text: string): bigint => BigInt(text.replace('.', ''));

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

/** Session 1 is held at `x03.after_read`; session 2 is started; then both are released in the order asked. */
async function twoSettlements(order: 'S1first' | 'S2first'): Promise<Outcome> {
  const customer = await addCustomer(w);
  const bill = await addFineBill(w, customer, '1000.00', '10.000', '2026-10-10');
  const gates = Gates.install();
  try {
    const g1 = gates.forNextSession();
    const call1 = settle(w, 'owner', customer, silver('6.000'));
    const reached = await Promise.race([g1.reached, call1.then((r) => `session 1 ended with ${r.statusCode} before it reached the hook`)]);
    expect(reached).toBe('x03.after_read');
    const g2 = gates.forNextSession();
    const call2 = settle(w, 'biller', customer, silver('6.000'));
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

/** What the books hold for the customer, from the base tables with plain SQL (not through the code under test). */
async function books(customer: string) {
  const [r] = await rows(
    w,
    `SELECT
       (SELECT COALESCE(SUM(fine_grams), 0) FROM receipts WHERE customer_id = ? AND status = 'active' AND kind IN ('fine_silver', 'fine_cash')) AS received,
       (SELECT COALESCE(SUM(a.fine_grams), 0) FROM receipt_allocations a JOIN receipts r ON r.id = a.receipt_id WHERE a.customer_id = ? AND a.released_at IS NULL AND r.status = 'active') AS allocated,
       (SELECT COALESCE(SUM(fine_weight_due), 0) FROM bills WHERE customer_id = ? AND status = 'active') AS due`,
    [customer, customer, customer],
  );
  return { received: String(r.received), allocated: String(r.allocated), due: String(r.due), overAllocated: milli(String(r.allocated)) > milli(String(r.due)) };
}

/** The expectations of T-C09 with the lock in place. */
async function expectLockedOutcome(o: Outcome): Promise<void> {
  expect(o.secondAtHookWhileFirstHeld, 'session 2 must still be waiting for the customer lock, not at the hook').toBe(false);
  expect(o.first.statusCode, o.first.body).toBe(201);
  expect(body(o.first).allocations.map((x: any) => x.fine_grams)).toEqual(['6.000']);
  expect(body(o.first).fine_remaining).toBe('4.000');
  expect(o.second.statusCode, `session 2 read the state AFTER session 1 had committed: only 4 g were outstanding (${o.second.body})`).toBe(409);
  expect(body(o.second).error.code).toBe('JV_FINE_EXCEEDS');
  expect(body(o.second).error.details).toMatchObject({ max_grams: '4.000' });
  expect(await books(o.customer)).toEqual({ received: '6.000', allocated: '6.000', due: '10.000', overAllocated: false });
  expect(await figures(w, o.customer)).toMatchObject({ fine_outstanding: '4.000', fine_advance: '0.000' });
  expect(await finePendingByBill(w, o.customer)).toEqual({ [o.bill]: '4.000' });
  expect(await allocationsOf(w, o.customer)).toHaveLength(1);
  expect(await receiptsOf(w, o.customer)).toHaveLength(1);
  await i10Holds(w, o.customer);
  expect(o.gatesAutoReleased, 'a gate that let go by itself after 3 s proves nothing').toBe(false);
}

describe('T-C09 two concurrent settlements of 6 g on one bill that owes 10 g do not apply the same pending silver twice (X0 items 3 and 8, SF2, X3)', () => {
  for (const order of ['S1first', 'S2first'] as const) {
    it(`with the customer lock in place session 2 waits at the lock, not at the hook, and is refused with the maximum 4.000; the books hold 6 g once (${order})`, async () => {
      const o = await twoSettlements(order);
      await expectLockedOutcome(o);
      expect(o.points.filter((p) => p === 'x03.after_read'), 'each session that gets to read the state of the customer reads it once').toHaveLength(2);
    });

    it(`NEGATIVE CONTROL: with the customer-lock helper replaced by a no-op in the test build the same test FAILS (${order}): session 2 reaches the hook beside session 1 and the bill is settled twice`, async () => {
      const undo = withoutCustomerLock();
      try {
        const o = await twoSettlements(order);
        // the observation that makes it fail: session 2 is at the hook while session 1 is held there, because nothing made it wait
        expect(o.secondAtHookWhileFirstHeld, 'without the lock session 2 gets to the hook beside session 1').toBe(true);
        // and the books say what the lock prevents: both read 10 g outstanding, both passed SF2, both allocated 6 g
        const b = await books(o.customer);
        expect(b.overAllocated, `the bill is settled twice: ${JSON.stringify(b)}`).toBe(true);
        expect(b.allocated).toBe('12.000');
        expect(await finePendingByBill(w, o.customer)).toEqual({ [o.bill]: '-2.000' });
        // so the assertions of the real test do not hold
        await expect(expectLockedOutcome(o)).rejects.toThrow();
      } finally {
        undo();
      }
    });
  }

  it('without a gate: eight settlements of 3 g at once on one customer, no deadlock and no JV_BUSY; the bill of 10 g is settled exactly 9 g by three of them and the other five are refused with the maximum 1.000', async () => {
    const customer = await addCustomer(w);
    const bill = await addFineBill(w, customer, '1000.00', '10.000', '2026-10-10');
    const callers = ['owner', 'biller', 'owner', 'biller', 'owner', 'biller', 'owner', 'biller'] as const;
    const answers = await Promise.all(callers.map((c) => settle(w, c, customer, silver('3.000'))));
    const codes = answers.map((a) => a.statusCode);
    expect(codes.filter((c) => c === 201), answers.map((a) => a.body).join(' ')).toHaveLength(3);
    expect(codes.filter((c) => c === 409), answers.map((a) => a.body).join(' ')).toHaveLength(5);
    for (const a of answers.filter((x) => x.statusCode === 409)) {
      expect(body(a).error.code).toBe('JV_FINE_EXCEEDS');
      expect(body(a).error.details).toMatchObject({ max_grams: '1.000' });
    }
    expect(await finePendingByBill(w, customer)).toEqual({ [bill]: '1.000' });
    expect(await fineAgrees(w, customer)).toEqual({ bills: 1000n, outstanding: 1000n });
    await i10Holds(w, customer);
  });

  it('two customers do not wait for each other: a settlement for B goes through while a settlement for A is held at the hook', async () => {
    const [a, b] = [await addCustomer(w), await addCustomer(w)];
    await addFineBill(w, a, '100.00', '10.000', '2026-10-10');
    await addFineBill(w, b, '100.00', '10.000', '2026-10-10');
    const gates = Gates.install();
    try {
      const g = gates.forNextSession();
      const held = settle(w, 'owner', a, silver('5.000'));
      expect(await Promise.race([g.reached, held.then((r) => `ended with ${r.statusCode}`)])).toBe('x03.after_read');
      const other = await settle(w, 'biller', b, silver('7.000'));
      expect(other.statusCode, other.body).toBe(201);
      expect(g.isAtHook, 'A\'s settlement is still held').toBe(true);
      g.release();
      expect((await held).statusCode).toBe(201);
    } finally {
      gates.restore();
    }
  });
});
