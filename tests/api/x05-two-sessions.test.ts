import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as locks from '../../src/db/locks';
import { type Designs, addDesigns, billBody, item, piece, pieceRow, postBill } from './x01-support';
import { withoutCustomerLock } from './x0-support';
import { type Call, invariantsFor, overAllocated, pair } from './x04-pair';
import { addSoldPiece, billStates, cancelBill, receiptRow, voidReceipt } from './x04-support';
import { type EditWorld, addAllocation, addBill, addCustomer, addMoney, billRow, body, codeOf, editWorld, figures, newKey, pay, pendingByBill, rows } from './x02-support';

// API25, T-C13 for X5 cancel_bill (X0 items 3, 5 and 8): a cancel beside another call, through the real routes, with the test hook `x05.after_read` (the return of the state read of the function, held
// by the test build's wrapper `Gates`, one gate for each session; nothing of it is in src/). Each test NAMES ITS START STATE. (a) a bill of 1,000 paid fully, `cancel_bill` beside `create_bill` of 400;
// (b) a bill of 1,000 with a receipt of 600, `cancel_bill` beside `record_payment` of 400. With the customer lock in place session 2 waits at the lock and the books are right in both orders; with the
// customer-lock helper replaced by a no-op the same assertions FAIL. Then the pieces (X0 item 5): a cancel beside a sale of the SAME piece by another customer, and two cancels of one bill at once
// (JV_BILL_CANCELLED, never JV_BUSY). The re-issue beside a payment (T-C13 (c)) is X10's and API29's.

let w: EditWorld;
let d: Designs;

beforeAll(async () => {
  w = await editWorld('x05two');
  d = await addDesigns(w);
}, 120_000);
afterAll(async () => {
  await w?.world.close();
}, 60_000);

const cancelCall = (bill: string): Call => ({ hook: 'x05.after_read', start: () => cancelBill(w, 'owner', bill, { reason: 'the customer returned the goods' }) });
const payCall = (customer: string, amount: string): Call => ({ hook: 'x02.after_read', start: () => pay(w, 'biller', customer, { amount, mode: 'UPI' }) });
const billCall = (customer: string, total: string): Call => ({
  hook: 'create_bill.after_read',
  start: async () => postBill(w, 'biller', billBody(customer, 'Retail', [item(await piece(w, d.gold24pp, { retail: total }), { metal_rate: total })])),
});
const saleOf = (customer: string, pieceId: string, total: string): Call => ({
  hook: 'create_bill.after_read',
  start: () => postBill(w, 'biller', billBody(customer, 'Retail', [item(pieceId, { metal_rate: total })])),
});

/** The start state of (a): a bill A of 1,000 with its piece, paid fully by R1. */
async function startA() {
  const c = await addCustomer(w);
  const a = await addBill(w, c, '1000.00', '2026-10-01');
  const p = await addSoldPiece(w, d.gold24pp, a, 1);
  const r1 = await addMoney(w, c, '1000.00', '2026-10-02');
  await addAllocation(w, r1, a, c, '1000.00');
  return { c, a, p, r1 };
}
/** The start state of (b): a bill A of 1,000 with a receipt of 600 (400 pending). */
async function startB() {
  const c = await addCustomer(w);
  const a = await addBill(w, c, '1000.00', '2026-10-01');
  const p = await addSoldPiece(w, d.gold24pp, a, 1);
  const r1 = await addMoney(w, c, '600.00', '2026-10-02');
  await addAllocation(w, r1, a, c, '600.00');
  return { c, a, p, r1 };
}

/** I3, K3: no live allocation points to a cancelled bill (released or voided only). */
async function openOnCancelled(customer: string): Promise<number> {
  return Number((await rows(w, "SELECT COUNT(*) AS n FROM receipt_allocations a JOIN bills b ON b.id = a.bill_id WHERE a.customer_id = ? AND b.status = 'cancelled' AND a.released_at IS NULL", [customer]))[0].n);
}

describe('T-C13 (a) a bill of 1,000 paid fully: cancel_bill beside create_bill of 400 (X0 items 3 and 8, X5, X1)', () => {
  const orders = [
    { name: 'the cancel is held first', first: (s: Awaited<ReturnType<typeof startA>>) => cancelCall(s.a), second: (s: Awaited<ReturnType<typeof startA>>) => billCall(s.c, '400.00'), cancelFirst: true },
    { name: 'the bill is held first', first: (s: Awaited<ReturnType<typeof startA>>) => billCall(s.c, '400.00'), second: (s: Awaited<ReturnType<typeof startA>>) => cancelCall(s.a), cancelFirst: false },
  ];

  /** Either way the 1,000 of R1 ends up paying the new bill 400 once and leaving 600 as an advance. */
  async function expectLocked(s: Awaited<ReturnType<typeof startA>>, p: Awaited<ReturnType<typeof pair>>, cancelFirst: boolean) {
    expect(p.secondAtHookWhileFirstHeld, 'session 2 must still be waiting for the customer lock, not at the hook').toBe(false);
    const cancelRes = cancelFirst ? p.first : p.second;
    const billRes = cancelFirst ? p.second : p.first;
    expect({ cancel: cancelRes.statusCode, bill: billRes.statusCode }, `${cancelRes.body} ${billRes.body}`).toEqual({ cancel: 200, bill: 201 });
    const newBill = String(body(billRes).bill.id);
    expect(await pendingByBill(w, s.c)).toMatchObject({ [s.a]: '0.00', [newBill]: '0.00' });
    expect((await billStates(w, s.c))[s.a]).toMatchObject({ status: 'cancelled' });
    expect(await figures(w, s.c)).toMatchObject({ outstanding: '0.00', advance: '600.00' });
    expect(await openOnCancelled(s.c), 'every allocation of the cancelled bill is released').toBe(0);
    expect((await pieceRow(w, s.p)).status).toBe('In Stock');
    expect(await overAllocated(w, s.c)).toEqual([]);
    expect(await invariantsFor(w, s.c)).toEqual([]);
    expect(p.autoReleased, 'a gate that let go by itself after 3 s proves nothing').toBe(false);
  }

  for (const o of orders) {
    for (const release of ['S1first', 'S2first'] as const) {
      it(`with the customer lock in place the freed money pays the new bill once: ${o.name}, released ${release}`, async () => {
        const s = await startA();
        const p = await pair(o.first(s), o.second(s), release);
        await expectLocked(s, p, o.cancelFirst);
        expect(p.points.filter((x) => x === 'x05.after_read'), 'each session reads the state of the customer once').toHaveLength(1);
      });

      it(`NEGATIVE CONTROL: with the customer-lock helper replaced by a no-op the same test FAILS: ${o.name}, released ${release}: an advance of 1,000 is left beside a pending bill`, async () => {
        const undo = withoutCustomerLock();
        try {
          const s = await startA();
          const p = await pair(o.first(s), o.second(s), release);
          expect(p.secondAtHookWhileFirstHeld, 'without the lock session 2 gets to the hook beside session 1').toBe(true);
          const newBill = [...Object.keys(await pendingByBill(w, s.c))].find((id) => id !== s.a) as string;
          expect((await pendingByBill(w, s.c))[newBill]).toBe('400.00');
          expect(await figures(w, s.c)).toMatchObject({ outstanding: '400.00', advance: '1000.00' });
          expect((await invariantsFor(w, s.c)).length, 'I10 is broken: an advance beside a pending bill').toBeGreaterThan(0);
          await expect(expectLocked(s, p, o.cancelFirst)).rejects.toThrow();
        } finally {
          undo();
        }
      });
    }
  }
});

describe('T-C13 (b) a bill of 1,000 with a receipt of 600: cancel_bill beside record_payment of 400', () => {
  const orders = [
    { name: 'the cancel is held first', first: (s: Awaited<ReturnType<typeof startB>>) => cancelCall(s.a), second: (s: Awaited<ReturnType<typeof startB>>) => payCall(s.c, '400.00'), cancelFirst: true },
    { name: 'the payment is held first', first: (s: Awaited<ReturnType<typeof startB>>) => payCall(s.c, '400.00'), second: (s: Awaited<ReturnType<typeof startB>>) => cancelCall(s.a), cancelFirst: false },
  ];

  /** Either way the bill is cancelled, both receipts (600 and 400) stay and the customer holds an advance of 1,000 with nothing owed; no allocation of the cancelled bill is left open. */
  async function expectLocked(s: Awaited<ReturnType<typeof startB>>, p: Awaited<ReturnType<typeof pair>>, cancelFirst: boolean) {
    expect(p.secondAtHookWhileFirstHeld, 'session 2 must still be waiting for the customer lock, not at the hook').toBe(false);
    const cancelRes = cancelFirst ? p.first : p.second;
    const payRes = cancelFirst ? p.second : p.first;
    expect({ cancel: cancelRes.statusCode, pay: payRes.statusCode }, `${cancelRes.body} ${payRes.body}`).toEqual({ cancel: 200, pay: 201 });
    expect((await billStates(w, s.c))[s.a]).toMatchObject({ status: 'cancelled', pending: '0.00' });
    expect(await figures(w, s.c)).toMatchObject({ outstanding: '0.00', advance: '1000.00' });
    expect(await openOnCancelled(s.c), 'every allocation of the cancelled bill is released, also the one the payment made').toBe(0);
    expect((await receiptRow(w, s.r1)).status).toBe('active');
    expect(await overAllocated(w, s.c)).toEqual([]);
    expect(await invariantsFor(w, s.c)).toEqual([]);
    expect(p.autoReleased).toBe(false);
  }

  for (const o of orders) {
    for (const release of ['S1first', 'S2first'] as const) {
      it(`with the customer lock in place no allocation of the cancelled bill is left open: ${o.name}, released ${release}`, async () => {
        const s = await startB();
        const p = await pair(o.first(s), o.second(s), release);
        await expectLocked(s, p, o.cancelFirst);
      });

      it(`NEGATIVE CONTROL: with the customer-lock helper replaced by a no-op the same test FAILS: ${o.name}, released ${release}`, async () => {
        const undo = withoutCustomerLock();
        try {
          const s = await startB();
          const p = await pair(o.first(s), o.second(s), release);
          expect(p.secondAtHookWhileFirstHeld, 'without the lock session 2 gets to the hook beside session 1').toBe(true);
          // the cancel decided from a state that did not hold the payment (it is refused as a bug: it released fewer rows than it should), or the payment paid a bill that was being cancelled
          const broken = [
            ...(await invariantsFor(w, s.c)),
            ...(await openOnCancelled(s.c) > 0 ? ['a live allocation points to a cancelled bill'] : []),
            ...(p.first.statusCode === 500 || p.second.statusCode === 500 ? ['a call was answered 500'] : []),
          ];
          expect(broken.length, `the pair left a trace: ${broken.join('; ')}`).toBeGreaterThan(0);
          await expect(expectLocked(s, p, o.cancelFirst)).rejects.toThrow();
        } finally {
          undo();
        }
      });
    }
  }
});

describe('X0 item 5, K3: a cancel beside a sale of the SAME piece by another customer (the pieces are locked after the customers, in one statement, and read after the lock)', () => {
  /** A bill A of customer C1 holds the piece P (Sold); customer C2 wants to sell P. */
  async function startPiece() {
    const c1 = await addCustomer(w);
    const c2 = await addCustomer(w);
    const a = await addBill(w, c1, '500.00', '2026-10-01');
    const p = await addSoldPiece(w, d.gold24pp, a, 1);
    await w.world.sql.query('UPDATE skus SET labour_retail = ? WHERE id = ?', ['500.00', p]);
    return { c1, c2, a, p };
  }

  const cases = [
    { name: 'the cancel is held, the sale is started, the sale is released first: the sale reads P still Sold and is refused', cancelHeld: true, release: 'S2first' as const, saleWins: false },
    { name: 'the cancel is held, the sale is started, the cancel is released first: P is back In Stock and the sale takes it', cancelHeld: true, release: 'S1first' as const, saleWins: true },
    { name: 'the sale is held, the cancel is started, the sale is released first: the sale reads P still Sold and is refused', cancelHeld: false, release: 'S1first' as const, saleWins: false },
    { name: 'the sale is held, the cancel is started, the cancel is released first: P is back In Stock and the sale takes it', cancelHeld: false, release: 'S2first' as const, saleWins: true },
  ];

  for (const k of cases) {
    it(k.name, async () => {
      const s = await startPiece();
      const cancel = cancelCall(s.a);
      const sale = saleOf(s.c2, s.p, '500.00');
      const p = await pair(k.cancelHeld ? cancel : sale, k.cancelHeld ? sale : cancel, k.release);
      const cancelRes = k.cancelHeld ? p.first : p.second;
      const saleRes = k.cancelHeld ? p.second : p.first;
      expect(cancelRes.statusCode, cancelRes.body).toBe(200);
      expect((await billRow(w, s.a)).status).toBe('cancelled');
      if (k.saleWins) {
        expect(saleRes.statusCode, saleRes.body).toBe(201);
        expect(await pieceRow(w, s.p)).toMatchObject({ status: 'Sold', sold_bill_id: String(body(saleRes).bill.id) });
      } else {
        expect({ status: saleRes.statusCode, code: codeOf(saleRes) }, saleRes.body).toEqual({ status: 409, code: 'JV_PIECE_UNAVAILABLE' });
        expect(await pieceRow(w, s.p)).toMatchObject({ status: 'In Stock', sold_bill_id: null });
      }
      // never sold twice, never Sold on a cancelled bill, never in stock with a bill: I1 and I2 for both customers
      expect(await invariantsFor(w, s.c1)).toEqual([]);
      expect(await invariantsFor(w, s.c2)).toEqual([]);
      const holders = await rows(w, "SELECT i.bill_id FROM bill_items i JOIN bills b ON b.id = i.bill_id WHERE i.sku_id = ? AND b.status = 'active'", [s.p]);
      expect(holders.length, 'the piece is on at most one active bill').toBe(k.saleWins ? 1 : 0);
      expect(p.autoReleased).toBe(false);
    });
  }

  it('without a gate, 12 rounds of the cancel and the sale at the same moment: the sale is refused (409) or takes the piece (201), the cancel is 200, never a 500 or a 503, and the piece is never on two bills', async () => {
    const seen = new Set<string>();
    for (let round = 0; round < 12; round++) {
      const s = await startPiece();
      const [x, y] = await Promise.all([cancelBill(w, 'owner', s.a, { reason: `round ${round} returned` }), postBill(w, 'biller', billBody(s.c2, 'Retail', [item(s.p, { metal_rate: '500.00' })]))]);
      expect(x.statusCode, x.body).toBe(200);
      expect([201, 409], y.body).toContain(y.statusCode);
      seen.add(String(y.statusCode));
      const holders = await rows(w, "SELECT i.bill_id FROM bill_items i JOIN bills b ON b.id = i.bill_id WHERE i.sku_id = ? AND b.status = 'active'", [s.p]);
      expect(holders.length).toBe(y.statusCode === 201 ? 1 : 0);
      expect(await invariantsFor(w, s.c1)).toEqual([]);
      expect(await invariantsFor(w, s.c2)).toEqual([]);
    }
    expect(seen.size, 'at least one outcome was seen').toBeGreaterThan(0);
  });
});

describe('T-C13 two cancels of one bill at once, with different keys: one success and one JV_BILL_CANCELLED, never JV_BUSY (X0 item 3)', () => {
  function expectOneWinner(a: LightMyRequestResponse, b: LightMyRequestResponse) {
    const results = [a, b].map((r) => ({ status: r.statusCode, code: r.statusCode === 200 ? undefined : codeOf(r) }));
    expect(results.sort((x, y) => x.status - y.status), `${a.body} ${b.body}`).toEqual([{ status: 200, code: undefined }, { status: 409, code: 'JV_BILL_CANCELLED' }]);
  }

  for (const release of ['S1first', 'S2first'] as const) {
    it(`held at the hook: session 2 waits at the customer lock, then answers JV_BILL_CANCELLED (${release})`, async () => {
      const s = await startA();
      const p = await pair(cancelCall(s.a), cancelCall(s.a), release);
      expect(p.secondAtHookWhileFirstHeld).toBe(false);
      expectOneWinner(p.first, p.second);
      expect(p.first.statusCode, 'the held call is the one that wins').toBe(200);
      expect(await figures(w, s.c)).toMatchObject({ advance: '1000.00', outstanding: '0.00' });
      expect(await invariantsFor(w, s.c)).toEqual([]);
      expect(p.autoReleased).toBe(false);
    });
  }

  it('without a gate, 12 rounds of two cancels of one bill at the same moment: every round is one 200 and one 409 JV_BILL_CANCELLED, never a 503; the pieces return once', async () => {
    for (let round = 0; round < 12; round++) {
      const s = await startA();
      const [x, y] = await Promise.all([cancelBill(w, 'owner', s.a, { reason: 'first of two' }, newKey()), cancelBill(w, 'owner', s.a, { reason: 'second of two' }, newKey())]);
      expectOneWinner(x, y);
      expect((await pieceRow(w, s.p)).status).toBe('In Stock');
      expect(await figures(w, s.c)).toMatchObject({ advance: '1000.00' });
    }
  });

  it('it does not need the customer lock: with it replaced by the bill row\'s own FOR UPDATE alone the answer is the same and there is no false JV_BUSY', async () => {
    const spy = vi.spyOn(locks, 'lockCustomerOf').mockImplementation(async (tx, table, id) => {
      const found = await tx.rows<{ customer_id: string }>(`SELECT customer_id FROM ${table} WHERE id = ?`, [id]);
      if (found.length === 0) return null;
      locks.noteStep(tx, 'customer', found[0].customer_id);
      const customer = (await tx.rows<locks.CustomerLockRow>('SELECT id, name, mobile, customer_type, gst_number, pan, is_walkin, archived_at FROM customers WHERE id = ?', [found[0].customer_id]))[0];
      const row = (await tx.rows<locks.LockedRow>(`SELECT * FROM ${table} WHERE id = ? FOR UPDATE`, [id]))[0];
      return { customer, row };
    });
    try {
      const s = await startA();
      const p = await pair(cancelCall(s.a), cancelCall(s.a), 'S1first');
      expectOneWinner(p.first, p.second);
      expect(p.secondAtHookWhileFirstHeld, 'session 2 waits on the bill row, not at the hook').toBe(false);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('X4 beside X5: a void of the receipt that paid a bill beside the cancel of that bill', () => {
  // The final books are the same whichever goes first, so this pair proves consistency, not the lock (spec X0 item 8: such pairs "pass with the lock removed and are not used" as lock proofs).
  for (const voidFirst of [true, false]) {
    for (const release of ['S1first', 'S2first'] as const) {
      it(`the ${voidFirst ? 'void' : 'cancel'} is held first, released ${release}: the bill is cancelled, the receipt is voided, no advance is left and no allocation of the bill is open`, async () => {
        const s = await startA();
        const voidCall: Call = { hook: 'x04.after_read', start: () => voidReceipt(w, 'owner', s.r1, { reason: 'wrong customer' }) };
        const p = await pair(voidFirst ? voidCall : cancelCall(s.a), voidFirst ? cancelCall(s.a) : voidCall, release);
        expect([p.first.statusCode, p.second.statusCode], `${p.first.body} ${p.second.body}`).toEqual([200, 200]);
        expect(p.secondAtHookWhileFirstHeld).toBe(false);
        expect((await billStates(w, s.c))[s.a]).toMatchObject({ status: 'cancelled' });
        expect((await receiptRow(w, s.r1)).status).toBe('voided');
        expect(await figures(w, s.c)).toMatchObject({ outstanding: '0.00', advance: '0.00' });
        expect(await openOnCancelled(s.c)).toBe(0);
        expect(await invariantsFor(w, s.c)).toEqual([]);
      });
    }
  }
});
