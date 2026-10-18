import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CallerName } from './cells';
import { type Body, type Designs, type EditWorld, billBody, billRow, codeOf, countOf, footprint, item, newKey, piece, pieceRow, postBill, saved } from './x01-support';
import { TODAY, WALKIN, addCustomer, addMoney, body, editWorld, figures, i10Holds, pay, paid, pendingAgrees, pendingByBill, receiptsOf, allocationsOf, rows } from './x02-support';
import { addDesigns } from './x01-support';

// API23, X1 create_bill with its payment rows (X1 steps (e), (i), (j)) and the rules of section 13 that sit on them: the DB halves of T-B03 (payments above the grand total, cash and UPI in two rows, a
// row of 0), T-B07 (the advance applied to the next bill and `advance_applied`), T-A12 (the cash limit, the owner's reason, PAN_MISSING, the walk-in's bill), and the clauses of T-B01 (Credit in a
// bill's payment rows), T-B17 (the walk-in's payment rows and cash rules) and T-B23 (the cash rules in the payment rows of the bill). The cash rules of record_payment and the per-day total across
// functions are in x02-cash-rules.test.ts; the pure rule is in cash-rules.test.ts.
//
// The world is the scratch database of the other money tests (real routes, seeds, a clock fixed at 17 Oct 2026 10:00 UTC = 15:30 in Kolkata, "today" is 2026-10-17). Every bill is ONE Per Piece line
// whose price is the grand total, so the figures are the ones written in the test. A customer's history is typed in by SQL. Every test makes its own customer, because the day's cash is per customer.

let w: EditWorld;
let d: Designs;

beforeAll(async () => {
  w = await editWorld('x01pay');
  d = await addDesigns(w);
}, 120_000);
afterAll(async () => {
  await w?.world.close();
}, 60_000);

/** POST a bill of ONE Per Piece line priced `total` (a whole number of rupees, text) for `customer`, with `extra` merged into the body. */
async function sell(customer: string, total: string, extra: Body = {}, caller: CallerName = 'biller', key: string | null = newKey()) {
  const p = await piece(w, d.gold24pp, { retail: total });
  return postBill(w, caller, billBody(customer, 'Retail', [item(p, { metal_rate: total })], extra), key);
}

/** The call is refused with exactly this status and code and leaves no trace (no bill, no receipt, no allocation, no claim, no audit row, no number, no Sold piece, no stamp). */
async function refusedWith(res: Promise<Awaited<ReturnType<typeof postBill>>>, status: number, code: string, snapshot: Record<string, number | string>) {
  const out = await res;
  expect({ status: out.statusCode, code: codeOf(out) }, out.body).toEqual({ status, code });
  expect(await footprint(w), 'the refused call left something behind').toEqual(snapshot);
  return body(out).error as { message: string; details: Record<string, any> };
}

const cashOf = (amount: string) => ({ mode: 'Cash', amount });

// ------------------------------------------------------------------ T-B01

describe('T-B01 (the clause of X1) a payment with mode Credit is rejected in a bill\'s explicit payment rows (D13, Y2)', () => {
  it('Credit, credit, a blank or a missing mode in any row is 422 on payments[i].mode, also on a row of amount 0; nothing is saved and the key is not used up', async () => {
    const c = await addCustomer(w);
    const p = await piece(w, d.gold24pp, { retail: '1000.00' });
    const cart = (payments: unknown) => billBody(c, 'Retail', [item(p, { metal_rate: '1000.00' })], { payments });
    const key = newKey();
    const before = await footprint(w);
    const bad: [unknown, string][] = [
      [[{ mode: 'Credit', amount: '100.00' }], 'payments[0].mode'],
      [[{ mode: 'credit', amount: '100.00' }], 'payments[0].mode'],
      [[{ mode: 'Cash', amount: '100.00' }, { mode: 'Credit', amount: '100.00' }], 'payments[1].mode'],
      [[{ mode: 'Credit', amount: '0.00' }], 'payments[0].mode'],
      [[{ mode: '', amount: '100.00' }], 'payments[0].mode'],
      [[{ amount: '100.00' }], 'payments[0].mode'],
    ];
    for (const [payments, field] of bad) {
      const res = await postBill(w, 'owner', cart(payments), key);
      expect(res.statusCode, res.body).toBe(422);
      expect(codeOf(res)).toBe('JV_INVALID_INPUT');
      expect(body(res).error.details.field).toBe(field);
      expect(await footprint(w)).toEqual(before);
    }
    const ok = await postBill(w, 'owner', cart([cashOf('100.00')]), key);
    expect(ok.statusCode, ok.body).toBe(201);
    expect(ok.headers['idempotent-replay']).toBeUndefined();
  });
});

// ------------------------------------------------------------------ T-B03

describe('T-B03 payments with a bill (X1 (e) and (i), Y5): above the grand total nothing is saved; cash and UPI in two rows save two receipts; a row of amount 0 is ignored', () => {
  it('payments above the grand total are 409 JV_OVERPAYMENT and nothing is saved: no bill, no receipt, no number, the piece stays In Stock, and the key is not used up', async () => {
    const c = await addCustomer(w);
    const p = await piece(w, d.gold24pp, { retail: '1000.00' });
    const cart = (payments: Body[]) => billBody(c, 'Retail', [item(p, { metal_rate: '1000.00' })], { payments });
    const key = newKey();
    const before = await footprint(w);
    for (const payments of [
      [{ mode: 'UPI', amount: '1000.01' }],
      [cashOf('400.00'), { mode: 'UPI', amount: '600.01' }],
      [cashOf('333.33'), { mode: 'UPI', amount: '333.33' }, { mode: 'Card', amount: '333.35' }],
      [{ mode: 'Other', amount: '1000000000.00' }],
    ]) {
      const error = await refusedWith(postBill(w, 'owner', cart(payments), key), 409, 'JV_OVERPAYMENT', before);
      expect(error.details).toMatchObject({ field: 'payments', grand_total: '1000.00' });
    }
    expect((await pieceRow(w, p)).status).toBe('In Stock');
    // the key was not used up: the same bill with payments that fit (333.33 + 333.33 + 333.34 = 1,000.00 exactly) is the first call with it
    const ok = await postBill(w, 'owner', cart([cashOf('333.33'), { mode: 'UPI', amount: '333.33' }, { mode: 'Card', amount: '333.34' }]), key);
    expect(ok.statusCode, ok.body).toBe(201);
    expect(ok.headers['idempotent-replay']).toBeUndefined();
    expect(body(ok).receipts).toHaveLength(3);
  });

  it('a bill paid by cash and UPI in two rows saves two money receipts and one allocation each, dated the bill date, and the answer lists them in the order sent', async () => {
    const c = await addCustomer(w);
    const r = await saved(await sell(c, '1000.00', { payments: [cashOf('400.00'), { mode: 'UPI', amount: '300.00', reference: 'UPI-77' }] }));
    expect(r.receipts.map((x) => [x.mode, x.amount, x.reference])).toEqual([['Cash', '400.00', null], ['UPI', '300.00', 'UPI-77']]);
    for (const x of r.receipts) {
      expect(x).toMatchObject({ customer_id: c, kind: 'money', fine_grams: '0.000', silver_rate: null, paid_on: TODAY, is_opening: false, status: 'active', cash_override_reason: null, void_reason: null, created_by: w.world.fixtures.biller.userId });
    }
    const stored = await receiptsOf(w, c);
    expect(stored.map((x) => [x.kind, x.mode, x.amount, x.paid_on, x.is_opening, x.status]).sort()).toEqual([
      ['money', 'Cash', '400.00', TODAY, 0, 'active'],
      ['money', 'UPI', '300.00', TODAY, 0, 'active'],
    ]);
    expect(r.allocations.map((a) => [a.receipt_id, a.bill_id, a.amount, a.fine_grams])).toEqual([
      [r.receipts[0].id, r.bill.id, '400.00', '0.000'],
      [r.receipts[1].id, r.bill.id, '300.00', '0.000'],
    ]);
    expect((await allocationsOf(w, c)).map((a) => [a.receipt_id, a.bill_id, a.amount, a.released_at]).sort()).toEqual(
      [[r.receipts[0].id, r.bill.id, '400.00', null], [r.receipts[1].id, r.bill.id, '300.00', null]].sort(),
    );
    expect(r.advance_applied).toBe('0.00');
    // the books agree with the answer: V1 and V2 of the database half are another opinion than the code under test
    expect(await pendingByBill(w, c)).toEqual({ [r.bill.id]: '300.00' });
    expect(await figures(w, c)).toEqual({ outstanding: '300.00', advance: '0.00', fine_outstanding: '0.000', fine_advance: '0.000' });
    await pendingAgrees(w, c);
    await i10Holds(w, c);
  });

  it('payments equal to the grand total pay the bill in full; the receipts of a back-dated bill (the owner\'s right) are dated the bill date and not today', async () => {
    const c = await addCustomer(w);
    const r = await saved(await sell(c, '2500.00', { bill_date: '2026-10-10', payments: [{ mode: 'Bank Transfer', amount: '2500.00', reference: 'NEFT 12' }] }, 'owner'));
    expect(r.bill.bill_date).toBe('2026-10-10');
    expect(r.receipts).toHaveLength(1);
    expect(r.receipts[0]).toMatchObject({ paid_on: '2026-10-10', mode: 'Bank Transfer', amount: '2500.00', reference: 'NEFT 12', created_by: w.world.fixtures.owner.userId });
    expect(await pendingByBill(w, c)).toEqual({ [r.bill.id]: '0.00' });
    expect((await figures(w, c)).outstanding).toBe('0.00');
    await i10Holds(w, c);
  });

  it('a payment row of amount 0 is ignored: no receipt and no allocation for it, the other rows are saved, and a row of 0 alone saves a bill with no receipt', async () => {
    const c = await addCustomer(w);
    const only = await saved(await sell(c, '500.00', { payments: [cashOf('0.00')] }));
    expect(only.receipts).toEqual([]);
    expect(only.allocations).toEqual([]);
    expect(await receiptsOf(w, c)).toEqual([]);
    expect(await pendingByBill(w, c)).toEqual({ [only.bill.id]: '500.00' });
    const mixed = await saved(await sell(c, '500.00', { payments: [cashOf('0'), { mode: 'UPI', amount: '250.00' }, { mode: 'Other', amount: '0.00' }] }));
    expect(mixed.receipts.map((x) => [x.mode, x.amount])).toEqual([['UPI', '250.00']]);
    expect(mixed.allocations.map((a) => a.amount)).toEqual(['250.00']);
    expect((await receiptsOf(w, c)).length).toBe(1);
    // a row of 0 is still a well-formed row: an unknown mode on it is refused, and a row of 0 does not make an overpayment
    const refused = await sell(c, '500.00', { payments: [{ mode: 'Cheque', amount: '0.00' }] });
    expect(refused.statusCode, refused.body).toBe(422);
    const fits = await saved(await sell(c, '500.00', { payments: [cashOf('0.00'), { mode: 'UPI', amount: '500.00' }, cashOf('0.00')] }));
    expect(fits.receipts).toHaveLength(1);
  });

  it('a repeat of the key is the stored answer (the same receipts and allocations) and makes no second set; a bill with payments saved twice with two keys is two sets', async () => {
    const c = await addCustomer(w);
    const p = await piece(w, d.gold24pp, { retail: '900.00' });
    const cart = billBody(c, 'Retail', [item(p, { metal_rate: '900.00' })], { payments: [cashOf('100.00'), { mode: 'Card', amount: '200.00' }] });
    const key = newKey();
    const first = await saved(await postBill(w, 'biller', cart, key));
    const again = await postBill(w, 'biller', cart, key);
    expect(again.statusCode, again.body).toBe(201);
    expect(again.headers['idempotent-replay']).toBe('true');
    expect(body(again)).toEqual(first);
    expect(await receiptsOf(w, c)).toHaveLength(2);
    expect(await allocationsOf(w, c)).toHaveLength(2);
    const [claim] = await rows(w, 'SELECT result FROM sys_idempotency WHERE request_id = ?', [key]);
    expect(typeof claim.result === 'string' ? JSON.parse(claim.result) : claim.result).toEqual(first);
  });

  it('a failure while the allocations are written rolls everything back: no bill, no receipt, no claim, no number; the same key then works', async () => {
    const c = await addCustomer(w);
    const p = await piece(w, d.gold24pp, { retail: '700.00' });
    const cart = billBody(c, 'Retail', [item(p, { metal_rate: '700.00' })], { payments: [cashOf('300.00'), { mode: 'UPI', amount: '400.00' }] });
    const key = newKey();
    const before = await footprint(w);
    w.world.spy.intercept = async (e) => {
      if (/^INSERT INTO receipt_allocations\b/.test(e.sql.trim())) throw new Error('injected failure at the allocations');
    };
    try {
      const res = await postBill(w, 'owner', cart, key);
      expect(res.statusCode, res.body).toBe(500);
      expect(codeOf(res)).toBe('JV_INTERNAL');
      expect(res.body).not.toContain('injected');
    } finally {
      w.world.spy.intercept = null;
    }
    expect(await footprint(w)).toEqual(before);
    expect((await pieceRow(w, p)).status).toBe('In Stock');
    const retry = await postBill(w, 'owner', cart, key);
    expect(retry.statusCode, retry.body).toBe(201);
    expect(await receiptsOf(w, c)).toHaveLength(2);
  });

  it('the statements of a bill with payments come in the order of X0: the day\'s cash is read with the other plain reads before the counter, the receipts and allocations are written last, nothing locks after the counter', async () => {
    const c = await addCustomer(w);
    const from = w.world.spy.sent.length;
    const res = await sell(c, '1000.00', { payments: [cashOf('100.00'), { mode: 'UPI', amount: '100.00' }] });
    expect(res.statusCode, res.body).toBe(201);
    const noise = (s: string) => /^(SET|COMMIT|ROLLBACK|START)\b/i.test(s.trim()) || /\bFROM\s+(sessions|users)\b/i.test(s) || /^UPDATE\s+sessions\b/i.test(s.trim());
    const sqls = w.world.spy.sqls().slice(from).filter((s) => !noise(s)).map((s) => s.replace(/\s+/g, ' ').trim());
    const at = (re: RegExp) => {
      const i = sqls.findIndex((s) => re.test(s));
      if (i < 0) throw new Error(`no statement ${re} in ${sqls.join(' | ')}`);
      return i;
    };
    const customerLock = at(/FROM customers WHERE id = \? FOR UPDATE/);
    const cash = at(/FROM receipts WHERE customer_id = \?/);
    const counter = at(/^UPDATE sys_counters SET last_value = LAST_INSERT_ID/);
    const insertBill = at(/^INSERT INTO bills\b/);
    const sold = at(/^UPDATE skus SET status = \?/);
    const receipts = sqls.map((s, i) => [s, i] as const).filter(([s]) => /^INSERT INTO receipts\b/.test(s)).map(([, i]) => i);
    const allocations = sqls.map((s, i) => [s, i] as const).filter(([s]) => /^INSERT INTO receipt_allocations\b/.test(s)).map(([, i]) => i);
    expect(cash, 'the day\'s cash is read under the customer lock').toBeGreaterThan(customerLock);
    expect(cash, 'and before the number is taken').toBeLessThan(counter);
    expect(receipts, 'one INSERT for each receipt').toHaveLength(2);
    expect(allocations.length, 'the allocations of the rows are written in one statement').toBe(1);
    expect(Math.min(...receipts)).toBeGreaterThan(sold);
    expect(Math.min(...receipts)).toBeGreaterThan(insertBill);
    expect(allocations[0]).toBeGreaterThan(Math.max(...receipts));
    expect(sqls.slice(counter + 1).filter((s) => /FOR UPDATE/.test(s)), 'no lock is taken after the counter').toEqual([]);
    expect(sqls.filter((s) => /FROM receipts WHERE customer_id = \?/.test(s)), 'the day\'s cash is read once').toHaveLength(1);
  });
});

// ------------------------------------------------------------------ T-B07

describe('T-B07 an advance is applied automatically to the customer\'s next bill and the result reports advance_applied (Y6, X1 (j))', () => {
  it('a customer holding 700 gets a bill of 500: 500 is applied from the advance, 200 is left, and the answer says so', async () => {
    const c = await addCustomer(w);
    const adv = await addMoney(w, c, '700.00', '2026-10-05');
    const r = await saved(await sell(c, '500.00'));
    expect(r.advance_applied).toBe('500.00');
    expect(r.allocations.map((a) => [a.receipt_id, a.bill_id, a.amount])).toEqual([[adv, r.bill.id, '500.00']]);
    expect(r.receipts).toEqual([]);
    expect(await pendingByBill(w, c)).toEqual({ [r.bill.id]: '0.00' });
    expect(await figures(w, c)).toEqual({ outstanding: '0.00', advance: '200.00', fine_outstanding: '0.000', fine_advance: '0.000' });
    await i10Holds(w, c);
  });

  it('an advance smaller than the bill is applied in full and the rest stays pending; no advance means advance_applied 0.00', async () => {
    const c = await addCustomer(w);
    await addMoney(w, c, '300.00', '2026-10-05');
    const r = await saved(await sell(c, '1000.00'));
    expect(r.advance_applied).toBe('300.00');
    expect(await pendingByBill(w, c)).toEqual({ [r.bill.id]: '700.00' });
    expect((await figures(w, c)).advance).toBe('0.00');
    const none = await saved(await sell(await addCustomer(w), '1000.00'));
    expect(none.advance_applied).toBe('0.00');
    expect(none.allocations).toEqual([]);
  });

  it('the payment rows come BEFORE the rebalance: a bill of 1,000 with 500 paid now and an advance of 900 takes only 500 from the advance, which keeps 400', async () => {
    const c = await addCustomer(w);
    await addMoney(w, c, '900.00', '2026-10-05');
    const r = await saved(await sell(c, '1000.00', { payments: [{ mode: 'UPI', amount: '500.00' }] }));
    expect(r.receipts).toHaveLength(1);
    expect(r.advance_applied).toBe('500.00');
    expect(r.allocations.map((a) => a.amount), 'the payment\'s own allocation first, then the rebalance\'s').toEqual(['500.00', '500.00']);
    expect(r.allocations[0].receipt_id).toBe(r.receipts[0].id);
    expect(await pendingByBill(w, c)).toEqual({ [r.bill.id]: '0.00' });
    expect(await figures(w, c)).toEqual({ outstanding: '0.00', advance: '400.00', fine_outstanding: '0.000', fine_advance: '0.000' });
    // a bill paid in full by its own rows takes nothing from the advance
    const paidInFull = await saved(await sell(c, '300.00', { payments: [cashOf('300.00')] }));
    expect(paidInFull.advance_applied).toBe('0.00');
    expect((await figures(w, c)).advance).toBe('400.00');
    await i10Holds(w, c);
  });

  it('an advance made by record_payment (a payment above what the bills need) is applied to the next bill', async () => {
    const c = await addCustomer(w);
    const first = await paid(await pay(w, 'owner', c, { amount: '800.00', mode: 'UPI' }));
    expect(first.advance_remaining).toBe('800.00');
    const r = await saved(await sell(c, '600.00', {}, 'owner'));
    expect(r.advance_applied).toBe('600.00');
    expect(r.allocations.map((a) => [a.receipt_id, a.amount])).toEqual([[first.receipt.id, '600.00']]);
    expect(await figures(w, c)).toEqual({ outstanding: '0.00', advance: '200.00', fine_outstanding: '0.000', fine_advance: '0.000' });
    await pendingAgrees(w, c);
  });
});

// ------------------------------------------------------------------ T-A12

describe('T-A12 (create_bill) the cash limit, the owner\'s reason, the PAN prompt and the walk-in\'s bill (Z1, Z2, Z3)', () => {
  const REASON = 'abcdefghij'; // exactly 10 characters

  it('cash of 1,99,999.99 passes and 2,00,000 raises JV_CASH_LIMIT for a biller; the refused call saves nothing', async () => {
    const c = await addCustomer(w);
    const before = await footprint(w);
    const error = await refusedWith(sell(c, '300000.00', { payments: [cashOf('200000.00')] }, 'biller'), 409, 'JV_CASH_LIMIT', before);
    expect(error.details).toMatchObject({ limit: '200000.00', cash_today: '0.00' });
    const passes = await saved(await sell(c, '300000.00', { payments: [cashOf('199999.99')] }, 'biller'));
    expect(passes.receipts.map((x) => x.amount)).toEqual(['199999.99']);
    expect(passes.bill.cash_override_reason).toBeNull();
  });

  it('only Cash counts, and the Cash rows of one bill are added: 100,000 + 99,999.99 passes, 100,000 + 100,000 raises, 3,00,000 by UPI, Card, Bank Transfer or Other passes', async () => {
    const owed = '400000.00';
    const [first, second] = [await addCustomer(w), await addCustomer(w)];
    const before = await footprint(w);
    await refusedWith(sell(first, owed, { payments: [cashOf('100000.00'), cashOf('100000.00')] }, 'biller'), 409, 'JV_CASH_LIMIT', before);
    await refusedWith(sell(second, owed, { payments: [cashOf('100000.00'), { mode: 'UPI', amount: '50000.00' }, cashOf('100000.00')] }, 'biller'), 409, 'JV_CASH_LIMIT', before);
    const ok = await saved(await sell(await addCustomer(w), owed, { payments: [cashOf('100000.00'), cashOf('99999.99')] }, 'biller'));
    expect(ok.receipts).toHaveLength(2);
    for (const mode of ['UPI', 'Card', 'Bank Transfer', 'Other']) {
      const r = await saved(await sell(await addCustomer(w), owed, { payments: [{ mode, amount: '300000.00' }] }, 'biller'));
      expect(r.receipts[0]).toMatchObject({ mode, amount: '300000.00' });
    }
  });

  it('the owner with a reason of 10 characters saves cash of 2,00,000; the reason is stored on the bill (trimmed), the receipts carry none, and the owner without one is stopped', async () => {
    const c = await addCustomer(w);
    const before = await footprint(w);
    const stopped = await refusedWith(sell(c, '300000.00', { payments: [cashOf('200000.00')] }, 'owner'), 409, 'JV_CASH_LIMIT', before);
    expect(stopped.message).toMatch(/reason/i);
    const r = await saved(await sell(c, '300000.00', { payments: [cashOf('200000.00')], cash_override_reason: `  ${REASON}  ` }, 'owner'));
    expect(r.bill.cash_override_reason).toBe(REASON);
    expect((await billRow(w, r.bill.id)).cash_override_reason).toBe(REASON);
    expect(r.receipts[0].cash_override_reason).toBeNull();
    expect((await receiptsOf(w, c)).map((x) => x.cash_override_reason)).toEqual([null]);
    // nine characters is not enough, for anybody
    const short = await sell(c, '300000.00', { payments: [cashOf('200000.00')], cash_override_reason: 'abcdefghi' }, 'owner');
    expect(short.statusCode, short.body).toBe(422);
    expect(body(short).error.details.field).toBe('cash_override_reason');
  });

  it('a reason that is not needed is not stored (the review line of I11 counts bills saved with a reason): cash below the limit, or no cash at all', async () => {
    const c = await addCustomer(w);
    const below = await saved(await sell(c, '300000.00', { payments: [cashOf('1000.00')], cash_override_reason: REASON }, 'owner'));
    expect(below.bill.cash_override_reason).toBeNull();
    const noCash = await saved(await sell(c, '300000.00', { payments: [{ mode: 'UPI', amount: '250000.00' }], cash_override_reason: REASON }, 'owner'));
    expect(noCash.bill.cash_override_reason).toBeNull();
    const noPayment = await saved(await sell(c, '1000.00', { cash_override_reason: REASON }, 'owner'));
    expect(noPayment.bill.cash_override_reason).toBeNull();
    expect(await countOf(w, 'bills', 'customer_id = ? AND cash_override_reason IS NOT NULL', [c])).toBe(0);
  });

  it('a biller who sends a reason is 403 JV_FORBIDDEN whether or not the cash is over the limit, and nothing is saved', async () => {
    const c = await addCustomer(w);
    const before = await footprint(w);
    for (const cash of ['200000.00', '1000.00']) {
      const error = await refusedWith(sell(c, '300000.00', { payments: [cashOf(cash)], cash_override_reason: REASON }, 'biller'), 403, 'JV_FORBIDDEN', before);
      expect(error.details).toMatchObject({ field: 'cash_override_reason' });
    }
  });

  it('the day\'s total counts the cash the customer already gave today: 1,50,000 earlier + 50,000 now raises, + 49,999.99 passes and then even 0.01 more raises; the owner with a reason is let through', async () => {
    const stop = await addCustomer(w);
    await addMoney(w, stop, '150000.00', TODAY, { mode: 'Cash' });
    const before = await footprint(w);
    const error = await refusedWith(sell(stop, '300000.00', { payments: [cashOf('50000.00')] }, 'biller'), 409, 'JV_CASH_LIMIT', before);
    expect(error.details).toMatchObject({ limit: '200000.00', cash_today: '150000.00' });
    const owner = await saved(await sell(stop, '300000.00', { payments: [cashOf('50000.00')], cash_override_reason: 'regular wedding customer' }, 'owner'));
    expect(owner.bill.cash_override_reason).toBe('regular wedding customer');

    const edge = await addCustomer(w);
    await addMoney(w, edge, '150000.00', TODAY, { mode: 'Cash' });
    await saved(await sell(edge, '300000.00', { payments: [cashOf('49999.99')] }, 'biller'));
    const snapshot = await footprint(w);
    await refusedWith(sell(edge, '300000.00', { payments: [cashOf('0.01')] }, 'biller'), 409, 'JV_CASH_LIMIT', snapshot);
    // no cash in the call: a UPI bill is not stopped by the cash already taken
    await saved(await sell(edge, '1000.00', { payments: [{ mode: 'UPI', amount: '1000.00' }] }, 'biller'));
  });

  it('the day is the date of the receipts: cash of another day or of another customer does not count, and a back-dated bill counts the cash of ITS day', async () => {
    const c = await addCustomer(w);
    const other = await addCustomer(w);
    await addMoney(w, c, '150000.00', '2026-10-16', { mode: 'Cash' });
    await addMoney(w, other, '150000.00', TODAY, { mode: 'Cash' });
    await saved(await sell(c, '300000.00', { payments: [cashOf('199999.99')] }, 'biller')); // yesterday's and the other customer's cash do not count
    const d2 = await addCustomer(w);
    await addMoney(w, d2, '150000.00', '2026-10-16', { mode: 'Cash' });
    const before = await footprint(w);
    await refusedWith(sell(d2, '300000.00', { bill_date: '2026-10-16', payments: [cashOf('50000.00')] }, 'owner'), 409, 'JV_CASH_LIMIT', before);
    const ok = await saved(await sell(d2, '300000.00', { bill_date: '2026-10-16', payments: [cashOf('49999.99')] }, 'owner'));
    expect(ok.receipts[0].paid_on).toBe('2026-10-16');
  });

  it('a bill of 2,00,000 or more for a customer with no PAN is saved with its payments and returns PAN_MISSING; 1,99,999 does not, and a customer with a PAN is never asked', async () => {
    const c = await addCustomer(w);
    const at = await saved(await sell(c, '200000.00', { payments: [{ mode: 'UPI', amount: '200000.00' }] }));
    expect(at.warnings).toEqual(['PAN_MISSING']);
    expect(at.receipts).toHaveLength(1);
    expect((await sell(c, '199999.00', {}, 'biller').then(saved)).warnings).toEqual([]);
    const withPan = await addCustomer(w, { pan: 'ABCDE1234F' });
    expect((await saved(await sell(withPan, '300000.00', { payments: [{ mode: 'UPI', amount: '300000.00' }] }))).warnings).toEqual([]);
  });

  it('a walk-in bill of 2,00,000 or more is refused with JV_NOT_ALLOWED and the message "Select or create the customer" (a biller, the owner, with a reason, with payments); 1,99,999 is saved', async () => {
    const before = await footprint(w);
    for (const [caller, extra] of [
      ['biller', {}],
      ['owner', {}],
      ['owner', { cash_override_reason: REASON, payments: [cashOf('1000.00')] }],
      ['biller', { payments: [{ mode: 'UPI', amount: '250000.00' }] }],
    ] as [CallerName, Body][]) {
      const error = await refusedWith(sell(WALKIN, '250000.00', extra, caller), 409, 'JV_NOT_ALLOWED', before);
      expect(error.message).toBe('Select or create the customer');
      expect(error.details).toMatchObject({ field: 'customer_id' });
    }
    await refusedWith(sell(WALKIN, '200000.00', {}, 'owner'), 409, 'JV_NOT_ALLOWED', before);
    const ok = await saved(await sell(WALKIN, '199999.00', {}, 'biller'));
    expect(ok.bill.customer_id).toBe(WALKIN);
    expect(ok.warnings, 'the walk-in is never asked for a PAN (D10)').toEqual([]);
  });
});

// ------------------------------------------------------------------ T-B17 and T-B23, the clauses of X1

describe('T-B17 (the clause of X1) the walk-in: payments in a bill\'s rows and the cash rules', () => {
  it('a walk-in bill takes payment rows up to its total (two receipts, two allocations, nothing left to rebalance); above its total is JV_OVERPAYMENT', async () => {
    const before = await footprint(w);
    await refusedWith(sell(WALKIN, '1000.00', { payments: [cashOf('400.00'), { mode: 'UPI', amount: '600.01' }] }), 409, 'JV_OVERPAYMENT', before);
    const r = await saved(await sell(WALKIN, '1000.00', { payments: [cashOf('400.00'), { mode: 'UPI', amount: '300.00' }] }));
    expect(r.receipts.map((x) => [x.customer_id, x.mode, x.amount])).toEqual([[WALKIN, 'Cash', '400.00'], [WALKIN, 'UPI', '300.00']]);
    expect(r.allocations.map((a) => [a.bill_id, a.amount])).toEqual([[r.bill.id, '400.00'], [r.bill.id, '300.00']]);
    expect(r.advance_applied).toBe('0.00');
    expect((await pendingByBill(w, WALKIN))[r.bill.id]).toBe('300.00');
  });

  it('the walk-in\'s cash is never added up over a day (many strangers): two bills of 1,50,000 paid in cash on one day are both saved, while the same two for a named customer stop at the second', async () => {
    await saved(await sell(WALKIN, '150000.00', { payments: [cashOf('150000.00')] }, 'biller'));
    await saved(await sell(WALKIN, '150000.00', { payments: [cashOf('150000.00')] }, 'biller'));
    const named = await addCustomer(w);
    await saved(await sell(named, '150000.00', { payments: [cashOf('150000.00')] }, 'biller'));
    const before = await footprint(w);
    await refusedWith(sell(named, '150000.00', { payments: [cashOf('150000.00')] }, 'biller'), 409, 'JV_CASH_LIMIT', before);
  });

  it('the rebalance never applies money to the walk-in (K5): money typed in for it is left alone and advance_applied is 0.00', async () => {
    await addMoney(w, WALKIN, '5000.00', '2026-10-05');
    const r = await saved(await sell(WALKIN, '1000.00'));
    expect(r.advance_applied).toBe('0.00');
    expect(r.allocations).toEqual([]);
  });
});

describe('T-B23 (the clause of X1) the cash rules apply to the payment rows of the bill, the same ones as in record_payment', () => {
  it('a Cash row of a bill and a Cash payment of record_payment on the same day are added: 1,00,000 paid by X2, then 99,999.99 by a bill passes, and 0.01 more by either is stopped for a biller', async () => {
    const c = await addCustomer(w);
    await paid(await pay(w, 'biller', c, { amount: '100000.00', mode: 'Cash' }));
    const ok = await saved(await sell(c, '300000.00', { payments: [cashOf('99999.99')] }, 'biller'));
    expect(ok.receipts).toHaveLength(1);
    const before = await footprint(w);
    await refusedWith(sell(c, '300000.00', { payments: [cashOf('0.01')] }, 'biller'), 409, 'JV_CASH_LIMIT', before);
    const res = await pay(w, 'biller', c, { amount: '0.01', mode: 'Cash' });
    expect(res.statusCode, res.body).toBe(409);
    expect(codeOf(res)).toBe('JV_CASH_LIMIT');
    expect(await footprint(w)).toEqual(before);
  });
});
