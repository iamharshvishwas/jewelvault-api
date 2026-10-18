import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Designs, addDesigns, billBody, item, piece, pieceRow, postBill } from './x01-support';
import { withoutCustomerLock } from './x0-support';
import { type Call, invariantsFor, overAllocated, pair } from './x04-pair';
import { billStates, cancelBill, receiptRow } from './x04-support';
import { type EditWorld, addCustomer, billRow, body, codeOf, editWorld, figures, newKey, pay, pendingByBill, receiptsOf, rows } from './x02-support';
import { line, liveOn, reissueBill, reissueBody, sell, upi } from './x10-support';

// API26, T-C13 (c) for X10 reissue_bill (X0 items 3, 5 and 8): a re-issue beside another call, through the real routes, with the test hook `x10.after_read` (the return of the state read of the
// function, held by the test build's wrapper `Gates`, one gate for each session; nothing of it is in src/). (c) a bill of 1,000 with a receipt of 600, `reissue_bill` beside `record_payment` of 400:
// both release orders, no deadlock, the invariants hold, and with the customer lock replaced by a no-op the same assertions FAIL. Then the pieces (X0 item 5): a re-issue beside a sale of a piece
// of its NEW list by another customer (the loser is refused whole: a lost re-issue leaves the old bill active), two re-issues of one bill at once and a re-issue beside a cancel of it
// (JV_BILL_CANCELLED, never JV_BUSY). The ordering of the ids of the two lists (T-C21) is API29's.

let w: EditWorld;
let d: Designs;

beforeAll(async () => {
  w = await editWorld('x10two');
  d = await addDesigns(w);
}, 120_000);
afterAll(async () => {
  await w?.world.close();
}, 60_000);

/** The start state of (c): a bill A of 1,000 with its piece and a receipt R1 of 600 (400 pending). */
async function startC() {
  const c = await addCustomer(w);
  const a = await sell(w, d, c, '1000.00', { payments: [upi('600.00')] });
  return { c, a: a.id, p: a.piece, r1: String(a.made.receipts[0].id) };
}

const reissueCall = (bill: string, pieceId: string, total = '1000.00', extra: Record<string, unknown> = {}): Call => ({
  hook: 'x10.after_read',
  start: () => reissueBill(w, 'owner', bill, reissueBody('Retail', [line(pieceId, total)], extra, 'the first bill was wrong')),
});
const payCall = (customer: string, amount: string): Call => ({ hook: 'x02.after_read', start: () => pay(w, 'biller', customer, { amount, mode: 'UPI' }) });
const cancelCall = (bill: string): Call => ({ hook: 'x05.after_read', start: () => cancelBill(w, 'owner', bill, { reason: 'the customer returned the goods' }) });

/** I3, K3: no live allocation points to a cancelled bill (released or voided only). */
async function openOnCancelled(customer: string): Promise<number> {
  return Number((await rows(w, "SELECT COUNT(*) AS n FROM receipt_allocations a JOIN bills b ON b.id = a.bill_id WHERE a.customer_id = ? AND b.status = 'cancelled' AND a.released_at IS NULL", [customer]))[0].n);
}

describe('T-C13 (c) a bill of 1,000 with a receipt of 600: reissue_bill beside record_payment of 400 (X0 items 3 and 8, X10, X2)', () => {
  const orders = [
    { name: 'the re-issue is held first', first: (s: Awaited<ReturnType<typeof startC>>) => reissueCall(s.a, s.p), second: (s: Awaited<ReturnType<typeof startC>>) => payCall(s.c, '400.00'), reissueFirst: true },
    { name: 'the payment is held first', first: (s: Awaited<ReturnType<typeof startC>>) => payCall(s.c, '400.00'), second: (s: Awaited<ReturnType<typeof startC>>) => reissueCall(s.a, s.p), reissueFirst: false },
  ];

  /** Either way the old bill is cancelled and the new one holds all 1,000 (600 carried over, 400 paid), nothing is owed, nothing is spare, and no allocation of the old bill is left open. */
  async function expectLocked(s: Awaited<ReturnType<typeof startC>>, p: Awaited<ReturnType<typeof pair>>, reissueFirst: boolean) {
    expect(p.secondAtHookWhileFirstHeld, 'session 2 must still be waiting for the customer lock, not at the hook').toBe(false);
    const reissueRes = reissueFirst ? p.first : p.second;
    const payRes = reissueFirst ? p.second : p.first;
    expect({ reissue: reissueRes.statusCode, pay: payRes.statusCode }, `${reissueRes.body} ${payRes.body}`).toEqual({ reissue: 201, pay: 201 });
    const newBill = String(body(reissueRes).new_bill.id);
    expect((await billStates(w, s.c))[s.a]).toMatchObject({ status: 'cancelled', pending: '0.00' });
    expect(await pendingByBill(w, s.c)).toMatchObject({ [s.a]: '0.00', [newBill]: '0.00' });
    expect((await billStates(w, s.c))[newBill]).toMatchObject({ status: 'active', received: '1000.00', payment_status: 'Paid' });
    expect(await figures(w, s.c)).toMatchObject({ outstanding: '0.00', advance: '0.00' });
    expect(await openOnCancelled(s.c), 'every allocation of the cancelled bill is released, also the one the payment made').toBe(0);
    expect(await liveOn(w, newBill)).toEqual({ money: '1000.00', fine: '0.000' });
    expect((await receiptRow(w, s.r1)).status).toBe('active');
    expect((await receiptsOf(w, s.c)).length, 'two receipts, 600 and 400, and no third').toBe(2);
    expect((await billRow(w, newBill)).reissue_of).toBe(s.a);
    expect(await pieceRow(w, s.p)).toMatchObject({ status: 'Sold', sold_bill_id: newBill });
    expect(await overAllocated(w, s.c)).toEqual([]);
    expect(await invariantsFor(w, s.c)).toEqual([]);
    expect(p.autoReleased, 'a gate that let go by itself after 3 s proves nothing').toBe(false);
  }

  for (const o of orders) {
    for (const release of ['S1first', 'S2first'] as const) {
      it(`with the customer lock in place the money of the old bill and the new payment pay the new bill once: ${o.name}, released ${release}`, async () => {
        const s = await startC();
        const p = await pair(o.first(s), o.second(s), release);
        await expectLocked(s, p, o.reissueFirst);
        expect(p.points.filter((x) => x === 'x10.after_read'), 'the re-issue reads the state of the customer once').toHaveLength(1);
        expect(p.points.filter((x) => x === 'x02.after_read'), 'the payment reads the state of the customer once').toHaveLength(1);
      });

      it(`NEGATIVE CONTROL: with the customer-lock helpers replaced by a no-op the same test FAILS: ${o.name}, released ${release}`, async () => {
        const undo = withoutCustomerLock();
        try {
          const s = await startC();
          const p = await pair(o.first(s), o.second(s), release);
          expect(p.secondAtHookWhileFirstHeld, 'without the lock session 2 gets to the hook beside session 1').toBe(true);
          // the payment allocated to a bill that was being cancelled (a live allocation on a cancelled bill), or the re-issue released fewer rows than there were (a bug, answered 500)
          const broken = [
            ...(await invariantsFor(w, s.c)),
            ...((await openOnCancelled(s.c)) > 0 ? ['a live allocation points to a cancelled bill'] : []),
            ...(p.first.statusCode === 500 || p.second.statusCode === 500 ? ['a call was answered 500'] : []),
          ];
          expect(broken.length, `the pair left a trace: ${broken.join('; ')}`).toBeGreaterThan(0);
          await expect(expectLocked(s, p, o.reissueFirst)).rejects.toThrow();
        } finally {
          undo();
        }
      });
    }
  }
});

describe('X0 item 5, K2: a re-issue beside a sale of a piece of its NEW list by another customer (the pieces of both lists are locked after the customer, in one statement, and read after the lock)', () => {
  /** A bill A of customer C1 holds the piece P (Sold); the re-issue wants P and Q; customer C2 wants to sell Q. */
  async function startPiece() {
    const c1 = await addCustomer(w);
    const c2 = await addCustomer(w);
    const a = await sell(w, d, c1, '500.00', { payments: [upi('500.00')] });
    const q = await piece(w, d.gold24pp, { retail: '300.00' });
    return { c1, c2, a: a.id, p: a.piece, q };
  }
  const reissueBoth = (s: Awaited<ReturnType<typeof startPiece>>): Call => ({
    hook: 'x10.after_read',
    start: () => reissueBill(w, 'owner', s.a, reissueBody('Retail', [line(s.p, '500.00'), line(s.q, '300.00')])),
  });
  const saleOf = (s: Awaited<ReturnType<typeof startPiece>>): Call => ({
    hook: 'create_bill.after_read',
    start: () => postBill(w, 'biller', billBody(s.c2, 'Retail', [item(s.q, { metal_rate: '300.00' })])),
  });

  const cases = [
    { name: 'the re-issue is held, the sale is started, the re-issue is released first: the re-issue takes Q and the sale is refused', reissueHeld: true, release: 'S1first' as const, reissueWins: true },
    { name: 'the re-issue is held, the sale is started, the sale is released first: the sale takes Q and the re-issue is refused whole (the old bill stays active)', reissueHeld: true, release: 'S2first' as const, reissueWins: false },
    { name: 'the sale is held, the re-issue is started, the sale is released first: the sale takes Q and the re-issue is refused whole', reissueHeld: false, release: 'S1first' as const, reissueWins: false },
    { name: 'the sale is held, the re-issue is started, the re-issue is released first: the re-issue takes Q and the sale is refused', reissueHeld: false, release: 'S2first' as const, reissueWins: true },
  ];

  for (const k of cases) {
    it(k.name, async () => {
      const s = await startPiece();
      const re = reissueBoth(s);
      const sale = saleOf(s);
      const p = await pair(k.reissueHeld ? re : sale, k.reissueHeld ? sale : re, k.release);
      const reissueRes = k.reissueHeld ? p.first : p.second;
      const saleRes = k.reissueHeld ? p.second : p.first;
      if (k.reissueWins) {
        expect(reissueRes.statusCode, reissueRes.body).toBe(201);
        expect({ status: saleRes.statusCode, code: codeOf(saleRes) }, saleRes.body).toEqual({ status: 409, code: 'JV_PIECE_UNAVAILABLE' });
        const newBill = String(body(reissueRes).new_bill.id);
        expect((await billRow(w, s.a)).status).toBe('cancelled');
        expect(await pieceRow(w, s.p)).toMatchObject({ status: 'Sold', sold_bill_id: newBill });
        expect(await pieceRow(w, s.q)).toMatchObject({ status: 'Sold', sold_bill_id: newBill });
      } else {
        expect(saleRes.statusCode, saleRes.body).toBe(201);
        expect({ status: reissueRes.statusCode, code: codeOf(reissueRes) }, reissueRes.body).toEqual({ status: 409, code: 'JV_PIECE_UNAVAILABLE' });
        // the re-issue was refused WHOLE: the old bill is active, its piece is still Sold on it, its allocation is live, the customer owes nothing and holds nothing
        expect((await billRow(w, s.a)).status).toBe('active');
        expect(await pieceRow(w, s.p)).toMatchObject({ status: 'Sold', sold_bill_id: s.a });
        expect(await pieceRow(w, s.q)).toMatchObject({ status: 'Sold', sold_bill_id: String(body(saleRes).bill.id) });
        expect(await liveOn(w, s.a)).toEqual({ money: '500.00', fine: '0.000' });
        expect(await figures(w, s.c1)).toMatchObject({ outstanding: '0.00', advance: '0.00' });
        expect(await rows(w, "SELECT id FROM bills WHERE customer_id = ? AND status = 'active'", [s.c1])).toHaveLength(1);
      }
      expect(await invariantsFor(w, s.c1)).toEqual([]);
      expect(await invariantsFor(w, s.c2)).toEqual([]);
      const holders = await rows(w, "SELECT i.bill_id FROM bill_items i JOIN bills b ON b.id = i.bill_id WHERE i.sku_id = ? AND b.status = 'active'", [s.q]);
      expect(holders.length, 'the piece is on one active bill').toBe(1);
      expect(p.autoReleased).toBe(false);
    });
  }

  it('without a gate, 12 rounds of the re-issue and the sale at the same moment: the re-issue is 201 and the sale 409, or the other way round, never a 500 or a 503, and the piece is never on two bills', async () => {
    const seen = new Set<string>();
    for (let round = 0; round < 12; round++) {
      const s = await startPiece();
      const [x, y] = await Promise.all([
        reissueBill(w, 'owner', s.a, reissueBody('Retail', [line(s.p, '500.00'), line(s.q, '300.00')], {}, `round ${round} corrected`)),
        postBill(w, 'biller', billBody(s.c2, 'Retail', [item(s.q, { metal_rate: '300.00' })])),
      ]);
      const outcome = `${x.statusCode}/${y.statusCode}`;
      expect(['201/409', '409/201'], `${outcome} ${x.body} ${y.body}`).toContain(outcome);
      seen.add(outcome);
      expect((await billRow(w, s.a)).status).toBe(x.statusCode === 201 ? 'cancelled' : 'active');
      const holders = await rows(w, "SELECT i.bill_id FROM bill_items i JOIN bills b ON b.id = i.bill_id WHERE i.sku_id = ? AND b.status = 'active'", [s.q]);
      expect(holders.length).toBe(1);
      expect(await invariantsFor(w, s.c1)).toEqual([]);
      expect(await invariantsFor(w, s.c2)).toEqual([]);
    }
    expect(seen.size, 'at least one outcome was seen').toBeGreaterThan(0);
  });
});

describe('T-C13 two re-issues of one bill at once, or a re-issue beside a cancel of it, with different keys: one success and one JV_BILL_CANCELLED, never JV_BUSY (X0 item 3, K6)', () => {
  function expectOneWinner(a: LightMyRequestResponse, b: LightMyRequestResponse, winner: number) {
    const results = [a, b].map((r) => ({ status: r.statusCode, code: r.statusCode === winner ? undefined : codeOf(r) }));
    expect(results.sort((x, y) => x.status - y.status), `${a.body} ${b.body}`).toEqual([{ status: winner, code: undefined }, { status: 409, code: 'JV_BILL_CANCELLED' }].sort((x, y) => x.status - y.status));
  }

  for (const release of ['S1first', 'S2first'] as const) {
    it(`two re-issues, held at the hook: session 2 waits at the customer lock, then answers JV_BILL_CANCELLED (${release}); the old bill has exactly one replacement`, async () => {
      const s = await startC();
      const p = await pair(reissueCall(s.a, s.p, '1000.00'), reissueCall(s.a, s.p, '900.00'), release);
      expect(p.secondAtHookWhileFirstHeld).toBe(false);
      expectOneWinner(p.first, p.second, 201);
      expect(p.first.statusCode, 'the held call is the one that wins').toBe(201);
      expect(await rows(w, 'SELECT id FROM bills WHERE reissue_of = ?', [s.a])).toHaveLength(1);
      expect(await figures(w, s.c)).toMatchObject({ outstanding: '400.00', advance: '0.00' });
      expect(await invariantsFor(w, s.c)).toEqual([]);
      expect(p.autoReleased).toBe(false);
    });

    it(`a re-issue and a cancel of the same bill, held at the hook: the held call wins and the other answers JV_BILL_CANCELLED (${release})`, async () => {
      for (const reissueHeld of [true, false]) {
        const s = await startC();
        const p = await pair(reissueHeld ? reissueCall(s.a, s.p) : cancelCall(s.a), reissueHeld ? cancelCall(s.a) : reissueCall(s.a, s.p), release);
        expect(p.secondAtHookWhileFirstHeld).toBe(false);
        const reissueRes = reissueHeld ? p.first : p.second;
        const cancelRes = reissueHeld ? p.second : p.first;
        if (reissueHeld) {
          expect([reissueRes.statusCode, cancelRes.statusCode, codeOf(cancelRes)], `${reissueRes.body} ${cancelRes.body}`).toEqual([201, 409, 'JV_BILL_CANCELLED']);
          expect(await rows(w, 'SELECT id FROM bills WHERE reissue_of = ?', [s.a])).toHaveLength(1);
          expect(await figures(w, s.c)).toMatchObject({ outstanding: '400.00', advance: '0.00' });
        } else {
          expect([cancelRes.statusCode, reissueRes.statusCode, codeOf(reissueRes)], `${reissueRes.body} ${cancelRes.body}`).toEqual([200, 409, 'JV_BILL_CANCELLED']);
          expect(await rows(w, 'SELECT id FROM bills WHERE reissue_of = ?', [s.a])).toHaveLength(0);
          expect(await figures(w, s.c)).toMatchObject({ outstanding: '0.00', advance: '600.00' });
        }
        expect(await invariantsFor(w, s.c)).toEqual([]);
      }
    });
  }

  it('without a gate, 12 rounds of two re-issues of one bill at the same moment: every round is one 201 and one 409 JV_BILL_CANCELLED, never a 503; the bill has one replacement and the money is on it once', async () => {
    for (let round = 0; round < 12; round++) {
      const s = await startC();
      const [x, y] = await Promise.all([
        reissueBill(w, 'owner', s.a, reissueBody('Retail', [line(s.p, '1000.00')], {}, 'first of two'), newKey()),
        reissueBill(w, 'owner', s.a, reissueBody('Retail', [line(s.p, '900.00')], {}, 'second of two'), newKey()),
      ]);
      expectOneWinner(x, y, 201);
      expect(await rows(w, 'SELECT id FROM bills WHERE reissue_of = ?', [s.a])).toHaveLength(1);
      expect((await pieceRow(w, s.p)).status).toBe('Sold');
      const books = await figures(w, s.c); // 600 is carried: the new bill is 1,000 (400 pending) or 900 (300 pending), and the customer holds nothing
      expect(books.advance).toBe('0.00');
      expect(['400.00', '300.00']).toContain(books.outstanding);
      expect(await invariantsFor(w, s.c)).toEqual([]);
    }
  });
});
