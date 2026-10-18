import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Gates, withoutCustomerLock } from './x0-support';
import { type Call, invariantsFor, pair } from './x04-pair';
import { receiptRow, voidReceipt } from './x04-support';
import { type EditWorld, addCustomer, body, editWorld, figures, i10Holds, paid, pay, receiptsOf, refusal } from './x02-support';
import { refund, upi } from './x11-support';

// API28, the two-session test for X11 (X0 items 3 and 8, Y10, Y7, X11): a refund beside another call for the same customer, through the real routes, with the test hook `x11.after_read` (the return of
// the state read of the call, held by the test build's wrapper `Gates`, one gate for each session; nothing of it is in src/). Each test NAMES ITS START STATE.
//   (1) an advance of 500 (a payment of 500 and nothing to spend it on): `issue_refund` of 300 beside `issue_refund` of 300. The advance is handed back once: one refund is saved and the other is
//       refused (it finds 200); with the customer lock removed both read 500, both are saved and 600 has gone out of 500.
//   (2) the same advance: `issue_refund` of 300 beside `void_receipt` of the 500 payment, in both orders of who is held first. Whichever commits first, the second reads the books AFTER it: a void
//       after a refund is "void the refund first", a refund after a void finds no advance. With the lock removed the payment is voided while 300 of it has been handed back (the advance is -300).
// The call held first waits for less than 3 seconds, the other is started, and the gates are released in both orders; with the lock in place session 2 waits at the customer lock, not at the hook, so
// the order of release changes nothing. The hook name of the other function is the one it was built with (`x04.after_read`). T-C11 (create_bill beside issue_refund) is API29's.

let w: EditWorld;

beforeAll(async () => {
  w = await editWorld('x11two');
}, 120_000);
afterAll(async () => {
  await w?.world.close();
}, 60_000);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const refundCall = (customer: string, amount: string): Call => ({ hook: 'x11.after_read', start: () => refund(w, 'owner', customer, upi(amount)) });
const voidCall = (receipt: string): Call => ({ hook: 'x04.after_read', start: () => voidReceipt(w, 'owner', receipt, { reason: 'wrong customer' }) });

/** The start state: the customer paid 500 in and holds all of it as an advance. */
async function startAdvance() {
  const customer = await addCustomer(w);
  const r = await paid(await pay(w, 'owner', customer, upi('500.00')));
  return { customer, payment: r.receipt.id as string };
}

/** What the books hold for the customer, from the base tables with plain SQL (not through the code under test): money received, handed back, and the receipts' state. */
async function books(customer: string) {
  const all = await receiptsOf(w, customer);
  const sum = (kind: string, status: string) => all.filter((r) => r.kind === kind && r.status === status).reduce((n, r) => n + BigInt(String(r.amount).replace('.', '')), 0n);
  const received = sum('money', 'active');
  const refunded = sum('refund', 'active');
  return { received, refunded, advance: received - refunded, refunds: all.filter((r) => r.kind === 'refund' && r.status === 'active').length };
}

const orders = ['S1first', 'S2first'] as const;

describe('X0 items 3 and 8 (X11 beside X11) two refunds of 300 out of an advance of 500 at once hand the advance back once (X0 items 3 and 8, Y10)', () => {
  /** With the lock: one refund is saved (the one that got the customer first) and the other finds 200 and is refused; the advance is 200 and never below 0. */
  async function expectLocked(s: Awaited<ReturnType<typeof startAdvance>>, p: Awaited<ReturnType<typeof pair>>) {
    expect(p.secondAtHookWhileFirstHeld, 'session 2 must still be waiting for the customer lock, not at the hook').toBe(false);
    expect(p.first.statusCode, p.first.body).toBe(201);
    expect(body(p.first).advance).toBe('200.00');
    expect(refusal(p.second), p.second.body).toMatchObject({ status: 409, code: 'JV_NOT_ALLOWED', field: 'amount' });
    expect(body(p.second).error.details).toMatchObject({ reason: 'more_than_advance', advance: '200.00', short_by: '100.00' });
    expect(await books(s.customer)).toEqual({ received: 50_000n, refunded: 30_000n, advance: 20_000n, refunds: 1 });
    expect(await figures(w, s.customer)).toMatchObject({ advance: '200.00', outstanding: '0.00' });
    expect(await invariantsFor(w, s.customer)).toEqual([]);
    expect(p.autoReleased, 'a gate that let go by itself after 3 s proves nothing').toBe(false);
  }

  for (const release of orders) {
    it(`with the customer lock in place session 2 waits at the lock, not at the hook, and the advance is handed back once: 300 out, 200 left (${release})`, async () => {
      const s = await startAdvance();
      const p = await pair(refundCall(s.customer, '300.00'), refundCall(s.customer, '300.00'), release);
      await expectLocked(s, p);
      expect(p.points.filter((x) => x === 'x11.after_read'), 'each session reads the state of the customer once').toHaveLength(2);
    });

    it(`NEGATIVE CONTROL: with the customer-lock helper replaced by a no-op the same test FAILS (${release}): session 2 reaches the hook beside session 1, both read 500, and 600 goes out of 500`, async () => {
      const undo = withoutCustomerLock();
      try {
        const s = await startAdvance();
        const p = await pair(refundCall(s.customer, '300.00'), refundCall(s.customer, '300.00'), release);
        expect(p.secondAtHookWhileFirstHeld, 'without the lock session 2 gets to the hook beside session 1').toBe(true);
        expect([p.first.statusCode, p.second.statusCode], `${p.first.body} ${p.second.body}`).toEqual([201, 201]);
        expect(await books(s.customer)).toEqual({ received: 50_000n, refunded: 60_000n, advance: -10_000n, refunds: 2 });
        expect(await figures(w, s.customer)).toMatchObject({ advance: '-100.00' });
        await expect(expectLocked(s, p)).rejects.toThrow();
      } finally {
        undo();
      }
    });
  }
});

describe('Y7 + Y10 (X11 beside X4) a refund of 300 beside the void of the 500 payment it comes out of: the second call reads the books after the first, so the advance is never below 0 (X0 items 3 and 8)', () => {
  const sides = [
    { name: 'the refund is held first', first: (s: Awaited<ReturnType<typeof startAdvance>>) => refundCall(s.customer, '300.00'), second: (s: Awaited<ReturnType<typeof startAdvance>>) => voidCall(s.payment), refundFirst: true },
    { name: 'the void is held first', first: (s: Awaited<ReturnType<typeof startAdvance>>) => voidCall(s.payment), second: (s: Awaited<ReturnType<typeof startAdvance>>) => refundCall(s.customer, '300.00'), refundFirst: false },
  ];

  async function expectLocked(s: Awaited<ReturnType<typeof startAdvance>>, p: Awaited<ReturnType<typeof pair>>, refundFirst: boolean) {
    expect(p.secondAtHookWhileFirstHeld, 'session 2 must still be waiting for the customer lock, not at the hook').toBe(false);
    expect(p.first.statusCode, p.first.body).toBe(refundFirst ? 201 : 200);
    if (refundFirst) {
      // the refund committed first: 300 of the payment is gone, so the payment cannot be voided any more ("void the refund first")
      expect(refusal(p.second), p.second.body).toMatchObject({ status: 409, code: 'JV_NOT_ALLOWED' });
      expect(body(p.second).error.details).toMatchObject({ reason: 'void_the_refund_first', short_by: '300.00' });
      expect((await receiptRow(w, s.payment)).status).toBe('active');
      expect(await books(s.customer)).toEqual({ received: 50_000n, refunded: 30_000n, advance: 20_000n, refunds: 1 });
    } else {
      // the void committed first: there is no advance left to hand back
      expect(refusal(p.second), p.second.body).toMatchObject({ status: 409, code: 'JV_NOT_ALLOWED', field: 'amount' });
      expect(body(p.second).error.details).toMatchObject({ reason: 'more_than_advance', advance: '0.00' });
      expect((await receiptRow(w, s.payment)).status).toBe('voided');
      expect(await books(s.customer)).toEqual({ received: 0n, refunded: 0n, advance: 0n, refunds: 0 });
    }
    expect((await figures(w, s.customer)).advance.startsWith('-'), 'the advance is never below 0').toBe(false);
    expect(await invariantsFor(w, s.customer)).toEqual([]);
    expect(p.autoReleased).toBe(false);
  }

  for (const side of sides) {
    for (const release of orders) {
      it(`with the customer lock in place the second call reads the books after the first: ${side.name}, released ${release}`, async () => {
        const s = await startAdvance();
        const p = await pair(side.first(s), side.second(s), release);
        await expectLocked(s, p, side.refundFirst);
      });

      it(`NEGATIVE CONTROL: with the customer-lock helper replaced by a no-op the same test FAILS: ${side.name}, released ${release}: the payment is voided and 300 of it has gone out (advance -300)`, async () => {
        const undo = withoutCustomerLock();
        try {
          const s = await startAdvance();
          const p = await pair(side.first(s), side.second(s), release);
          expect(p.secondAtHookWhileFirstHeld, 'without the lock session 2 gets to the hook beside session 1').toBe(true);
          expect(await books(s.customer), 'both decided from the same 500').toEqual({ received: 0n, refunded: 30_000n, advance: -30_000n, refunds: 1 });
          expect(await figures(w, s.customer)).toMatchObject({ advance: '-300.00' });
          await expect(expectLocked(s, p, side.refundFirst)).rejects.toThrow();
        } finally {
          undo();
        }
      });
    }
  }
});

describe('X11 without a gate: eight refunds at once and two customers that do not wait for each other', () => {
  it('eight refunds of 300 at once out of 1,000: exactly three are saved and five are refused (409), no deadlock and no JV_BUSY; 100 is left and the books hold', async () => {
    const customer = await addCustomer(w);
    await paid(await pay(w, 'owner', customer, upi('1000.00')));
    const answers = await Promise.all(Array.from({ length: 8 }, () => refund(w, 'owner', customer, upi('300.00'))));
    const codes = answers.map((a) => a.statusCode);
    expect(codes.filter((c) => c === 201), answers.map((a) => a.body).join(' ')).toHaveLength(3);
    expect(codes.filter((c) => c === 409)).toHaveLength(5);
    expect(answers.filter((a) => a.statusCode === 409).every((a) => body(a).error.code === 'JV_NOT_ALLOWED')).toBe(true);
    expect(await books(customer)).toEqual({ received: 100_000n, refunded: 90_000n, advance: 10_000n, refunds: 3 });
    expect(await figures(w, customer)).toMatchObject({ advance: '100.00', outstanding: '0.00' });
    expect(answers.filter((a) => a.statusCode === 201).map((a) => body(a).advance).sort()).toEqual(['100.00', '400.00', '700.00']);
    await i10Holds(w, customer);
  });

  it('two customers do not wait for each other: a refund for B goes through while a refund for A is held at the hook', async () => {
    const [a, b] = [await startAdvance(), await startAdvance()];
    const gates = Gates.install();
    try {
      const g = gates.forNextSession();
      const held = refund(w, 'owner', a.customer, upi('100.00'));
      expect(await Promise.race([g.reached, held.then((r) => `ended with ${r.statusCode}`)])).toBe('x11.after_read');
      const other = await refund(w, 'owner', b.customer, upi('70.00'));
      expect(other.statusCode, other.body).toBe(201);
      expect(g.isAtHook, "A's refund is still held").toBe(true);
      await sleep(50);
      g.release();
      expect((await held).statusCode).toBe(201);
    } finally {
      gates.restore();
    }
  });
});
