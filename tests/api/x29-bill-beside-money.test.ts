import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Designs, addDesigns, piece } from './x01-support';
import { withoutCustomerLock } from './x0-support';
import { invariantsFor, overAllocated, pair } from './x04-pair';
import { type EditWorld, addCustomer, body, editWorld, figures, paid, pay, pendingAgrees, pendingByBill, refusal } from './x02-support';
import { billCall, moneyBooks, payCall, refundCall, rupeesOf } from './x29-support';
import { upi } from './x11-support';

// API29, T-C10 and T-C11 (X0 items 3 and 8, I3, I10, Y6, Y10): `create_bill` beside another money function for ONE customer who holds an advance, through the real routes, with the test hook
// (`create_bill.after_read`, `x02.after_read`, `x11.after_read`: the return of the state read of each function, held by the test build's wrapper `Gates`, one gate for each session; nothing of it is
// in src/). Each test NAMES ITS START STATE. Session 1 is held for less than 3 seconds, session 2 is started, the gates are released in both orders; the held call is the bill in one half and the other
// function in the other half. With the customer lock in place session 2 waits at the lock, not at the hook, so the order of release changes nothing; with the customer-lock helper replaced by a no-op
// the same assertions FAIL (both calls read the same advance of 300).

let w: EditWorld;
let d: Designs;

beforeAll(async () => {
  w = await editWorld('x29bill');
  d = await addDesigns(w);
}, 120_000);
afterAll(async () => {
  await w?.world.close();
}, 60_000);

/** The start state of both tests: the customer paid 300 in and holds all of it as an advance; no bill is open. A piece of 400 is ready for the bill. */
async function startAdvance() {
  const customer = await addCustomer(w);
  const r0 = await paid(await pay(w, 'owner', customer, upi('300.00')));
  const p = await piece(w, d.gold24pp, { retail: '400.00' });
  return { customer, r0: String(r0.receipt.id), piece: p };
}
type Start = Awaited<ReturnType<typeof startAdvance>>;

const releases = ['S1first', 'S2first'] as const;

describe('T-C10 start state: an advance of 300 (one payment of 300, no bill): create_bill of 400 beside record_payment of 500 for the same customer (X0 items 3 and 8, I3, I10, Y6)', () => {
  const sides = [
    { name: 'the bill is held first', first: (s: Start) => billCall(w, s.customer, s.piece, '400.00'), second: (s: Start) => payCall(w, s.customer, '500.00'), billFirst: true },
    { name: 'the payment is held first', first: (s: Start) => payCall(w, s.customer, '500.00'), second: (s: Start) => billCall(w, s.customer, s.piece, '400.00'), billFirst: false },
  ];

  /**
   * With the lock the second call reads the books AFTER the first: either the bill takes the 300 and the payment pays the 100 that is left (400 stays as an advance), or the payment makes the
   * advance 800 and the bill takes 400 of it. Either way the bill is paid, nothing is owed, 400 is the advance and I10 holds.
   */
  async function expectLocked(s: Start, p: Awaited<ReturnType<typeof pair>>, billFirst: boolean) {
    expect(p.secondAtHookWhileFirstHeld, 'session 2 must still be waiting for the customer lock, not at the hook').toBe(false);
    const billRes = billFirst ? p.first : p.second;
    const payRes = billFirst ? p.second : p.first;
    expect({ bill: billRes.statusCode, pay: payRes.statusCode }, `${billRes.body} ${payRes.body}`).toEqual({ bill: 201, pay: 201 });
    const made = body(billRes);
    const paidNow = body(payRes);
    // the second call read the books after the first: what it saw is the advance the first left
    expect(made.advance_applied, 'the bill took 300 when it came first, 400 of the 800 when the payment came first').toBe(billFirst ? '300.00' : '400.00');
    expect(paidNow.advance_remaining, 'what is left of the 500: 400 after it paid the 100 the bill still owed, all 500 when no bill was open').toBe(billFirst ? '400.00' : '500.00');
    expect(paidNow.allocations.map((a: { amount: string }) => a.amount)).toEqual(billFirst ? ['100.00'] : []);
    const bill = String(made.bill.id);
    expect(await pendingByBill(w, s.customer)).toEqual({ [bill]: '0.00' });
    expect(await figures(w, s.customer)).toMatchObject({ outstanding: '0.00', advance: '400.00' });
    expect(await moneyBooks(w, s.customer)).toMatchObject({ received: 80_000n, refunded: 0n, allocated: 40_000n, billed: 40_000n, outstanding: 0n, advance: 40_000n });
    await pendingAgrees(w, s.customer); // V1 summed = V2 outstanding
    expect(await overAllocated(w, s.customer), 'I3: no receipt has more allocated than it holds, no bill more than it costs').toEqual([]);
    expect(await invariantsFor(w, s.customer), 'I1 to I4 and I10').toEqual([]);
    expect(p.autoReleased, 'a gate that let go by itself after 3 s proves nothing').toBe(false);
  }

  for (const side of sides) {
    for (const release of releases) {
      it(`with the customer lock in place session 2 waits at the lock and reads the books after session 1: ${side.name}, released ${release}`, async () => {
        const s = await startAdvance();
        const p = await pair(side.first(s), side.second(s), release);
        await expectLocked(s, p, side.billFirst);
        expect(p.points.filter((x) => x === 'create_bill.after_read'), 'the bill reads the state of the customer once').toHaveLength(1);
        expect(p.points.filter((x) => x === 'x02.after_read'), 'the payment reads the state of the customer once').toHaveLength(1);
      });

      it(`NEGATIVE CONTROL: with the customer-lock helper replaced by a no-op the same test FAILS: ${side.name}, released ${release}: both read the advance of 300 and the books end with 100 owed beside an advance of 500`, async () => {
        const undo = withoutCustomerLock();
        try {
          const s = await startAdvance();
          const p = await pair(side.first(s), side.second(s), release);
          expect(p.secondAtHookWhileFirstHeld, 'without the lock session 2 gets to the hook beside session 1').toBe(true);
          expect([p.first.statusCode, p.second.statusCode], `${p.first.body} ${p.second.body}`).toEqual([201, 201]);
          // the bill applied the 300 it saw; the payment saw the same 300 and no open bill, so its 500 went nowhere: 100 is owed AND 500 is held (I10 broken)
          expect(await figures(w, s.customer)).toMatchObject({ outstanding: '100.00', advance: '500.00' });
          expect((await invariantsFor(w, s.customer)).length, 'I10 is broken: an advance beside a pending bill').toBeGreaterThan(0);
          await expect(expectLocked(s, p, side.billFirst)).rejects.toThrow();
        } finally {
          undo();
        }
      });
    }
  }
});

describe('T-C11 start state: an advance of 300 (one payment of 300, no bill): create_bill of 400 beside issue_refund of 300 for the customer who holds that advance (a writer that takes no number: X0 items 3 and 8, X1, X11, Y10, I10)', () => {
  const sides = [
    { name: 'the bill is held first', first: (s: Start) => billCall(w, s.customer, s.piece, '400.00'), second: (s: Start) => refundCall(w, s.customer, '300.00'), billFirst: true },
    { name: 'the refund is held first', first: (s: Start) => refundCall(w, s.customer, '300.00'), second: (s: Start) => billCall(w, s.customer, s.piece, '400.00'), billFirst: false },
  ];

  /**
   * With the lock the advance is spent once: if the bill came first it took the 300 (100 is left to pay) and the refund finds nothing to hand back (409, more_than_advance); if the refund came
   * first the 300 went out and the bill, which read the books after it, is pending in full. Never both, so no refund exceeds the advance, the advance is never below 0 and I10 holds.
   */
  async function expectLocked(s: Start, p: Awaited<ReturnType<typeof pair>>, billFirst: boolean) {
    expect(p.secondAtHookWhileFirstHeld, 'session 2 must still be waiting for the customer lock, not at the hook').toBe(false);
    const billRes = billFirst ? p.first : p.second;
    const refundRes = billFirst ? p.second : p.first;
    expect(billRes.statusCode, billRes.body).toBe(201);
    const bill = String(body(billRes).bill.id);
    if (billFirst) {
      expect(body(billRes).advance_applied).toBe('300.00');
      expect(refusal(refundRes), refundRes.body).toMatchObject({ status: 409, code: 'JV_NOT_ALLOWED', field: 'amount' });
      expect(body(refundRes).error.details).toMatchObject({ reason: 'more_than_advance', advance: '0.00', short_by: '300.00' });
      expect(await moneyBooks(w, s.customer)).toMatchObject({ received: 30_000n, refunded: 0n, refunds: 0, allocated: 30_000n, billed: 40_000n, outstanding: 10_000n, advance: 0n });
      expect(await pendingByBill(w, s.customer)).toEqual({ [bill]: '100.00' });
    } else {
      expect(refundRes.statusCode, refundRes.body).toBe(201);
      expect(body(refundRes).advance, 'the refund came first and took the whole advance').toBe('0.00');
      expect(body(billRes).advance_applied, 'the bill read the books after the refund: there was nothing to apply').toBe('0.00');
      expect(await moneyBooks(w, s.customer)).toMatchObject({ received: 30_000n, refunded: 30_000n, refunds: 1, allocated: 0n, billed: 40_000n, outstanding: 40_000n, advance: 0n });
      expect(await pendingByBill(w, s.customer)).toEqual({ [bill]: '400.00' });
    }
    const books = await moneyBooks(w, s.customer);
    expect(books.allocated + books.refunded, 'the advance of 300 is either spent on the bill or refunded, never both').toBe(30_000n);
    expect(books.advance >= 0n, 'no refund exceeds the advance').toBe(true);
    await pendingAgrees(w, s.customer);
    expect(await overAllocated(w, s.customer)).toEqual([]);
    expect(await invariantsFor(w, s.customer), 'I1 to I4 and I10').toEqual([]);
    expect(p.autoReleased, 'a gate that let go by itself after 3 s proves nothing').toBe(false);
  }

  for (const side of sides) {
    for (const release of releases) {
      it(`with the customer lock in place the advance is spent once: ${side.name}, released ${release}`, async () => {
        const s = await startAdvance();
        const p = await pair(side.first(s), side.second(s), release);
        await expectLocked(s, p, side.billFirst);
        expect(p.points.filter((x) => x === 'create_bill.after_read'), 'the bill reads the state of the customer once').toHaveLength(1);
        expect(p.points.filter((x) => x === 'x11.after_read'), 'the refund reads the state of the customer once').toHaveLength(1);
      });

      it(`NEGATIVE CONTROL: with the customer-lock helper replaced by a no-op the same test FAILS: ${side.name}, released ${release}: the 300 is spent on the bill AND handed back (advance ${rupeesOf(-30_000n)})`, async () => {
        const undo = withoutCustomerLock();
        try {
          const s = await startAdvance();
          const p = await pair(side.first(s), side.second(s), release);
          expect(p.secondAtHookWhileFirstHeld, 'without the lock session 2 gets to the hook beside session 1').toBe(true);
          expect([p.first.statusCode, p.second.statusCode], `${p.first.body} ${p.second.body}`).toEqual([201, 201]);
          expect(await moneyBooks(w, s.customer), 'both read the advance of 300: it is allocated to the bill and refunded').toMatchObject({ received: 30_000n, refunded: 30_000n, allocated: 30_000n, advance: -30_000n });
          expect(await figures(w, s.customer)).toMatchObject({ advance: '-300.00' });
          expect((await invariantsFor(w, s.customer)).length, 'I10 is broken: a negative advance').toBeGreaterThan(0);
          await expect(expectLocked(s, p, side.billFirst)).rejects.toThrow();
        } finally {
          undo();
        }
      });
    }
  }
});
