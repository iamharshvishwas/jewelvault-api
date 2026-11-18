import { randomUUID } from 'node:crypto';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TickKey, closeOverNeeds } from '../../src/permissions/ticks';
import { csrfHeaders } from './support';
import { type Designs, type EditWorld, TODAY, addCustomer, addDesigns, billBody, billRow, body, codeOf, countOf, editWorld, errorField, footprint, item, piece, rows } from './x01-support';
import { cash, line, reissueBody, sell, upi } from './x10-support';

// Task 7 of the access plan (DESIGN.md 6.3 P3, the reach tests; rulings C, M and O): the field-level rights reach further than their names, and P2 (call-level) cannot see it.
//   - a payment line of amount above 0 on create_bill (X1) or reissue_bill (X10) is money received, so the caller must also be allowed fn:record_payment (payment_receive, DESIGN M8);
//   - re-issue keeps the old bill's date, so without back_date only a bill dated today can be re-issued (DESIGN M13, ruling C);
//   - X10 takes the body of X1, so a cash_override_reason from a caller without cash_over_limit is refused there as in X1 to X3 (ruling O);
//   - bill_make needs bill_view (R18, ruling M): the smallest role the API saves with bill_make makes a bill.
// The back-dating of X1, X2, X3, X7, X10, X11 and X12 (a past date refused without back_date, saved with it) is in access-money.test.ts and is not repeated here.
//
// The roles are CUSTOM roles holding exactly the ticks given, closed over their needs as the API would save them. The world is the money tests' scratch database, clock fixed at 17 Oct 2026.

let w: EditWorld;
let d: Designs;

beforeAll(async () => {
  w = await editWorld('accreach', { triggers: true });
  d = await addDesigns(w);
}, 120_000);
afterAll(async () => {
  await w?.world.close();
}, 60_000);

const PAST = '2026-10-10';

/** A person in a custom role holding exactly closeOverNeeds(ticks), with a live session. */
async function person(ticks: readonly TickKey[]) {
  const role = await w.world.addRole({ ticks: closeOverNeeds(ticks) });
  return w.world.addUser({ role: role.key });
}

const post = (who: { cookie: string }, url: string, payload: unknown, key: string = randomUUID()): Promise<LightMyRequestResponse> =>
  w.world.app.inject({ method: 'POST', url, headers: { ...csrfHeaders(), cookie: who.cookie, 'idempotency-key': key }, payload: payload as object });

/** What a refused call must leave as it found it: the books, the claims, the audit rows, the counters, the customers. */
const trace = async (): Promise<Record<string, number | string>> => ({ ...(await footprint(w)), customer_rows: await countOf(w, 'customers') });

/** A refusal with nothing written: the status, the code, the field when one is named, and the footprint unchanged. */
async function refusedClean(res: LightMyRequestResponse, before: Record<string, number | string>, status: number, code: string, field?: string): Promise<void> {
  expect(res.statusCode, res.body).toBe(status);
  expect(codeOf(res)).toBe(code);
  if (field !== undefined) expect(errorField(res)).toBe(field);
  expect(await trace(), 'the refused call left something behind').toEqual(before);
}

/** A new bill of one Per Piece line priced `total`, for a new customer, as X1's body (extra merged in). */
async function newBill(total: string, extra: Record<string, unknown> = {}) {
  const c = await addCustomer(w);
  const p = await piece(w, d.gold24pp, { retail: total });
  return { customer: c, payload: billBody(c, 'Retail', [item(p, { metal_rate: total })], extra) };
}

/** A bill sold by the owner (dated `date`, today unless given) and the body of its re-issue at the same price (extra merged in). */
async function oldBill(total: string, extra: Record<string, unknown> = {}, date?: string) {
  const c = await addCustomer(w);
  const old = await sell(w, d, c, total, date ? { bill_date: date } : {});
  return { customer: c, old, url: `/v1/bills/${old.id}/reissue`, payload: reissueBody('Retail', [line(old.piece, total)], extra) };
}

const receiptsOf = async (customer: string): Promise<string[][]> =>
  (await rows(w, 'SELECT mode, amount FROM receipts WHERE customer_id = ? ORDER BY created_at, id', [customer])).map((r) => [String(r.mode), String(r.amount)]);

// ------------------------------------------------------------------ X1: payment lines need payment_receive

describe('X1 create_bill: a payment line above 0 needs payment_receive (DESIGN M8, P3)', () => {
  it('R18: the smallest role the API saves with bill_make is customer_view, bill_view and bill_make, and it saves a bill with no payment lines', async () => {
    expect(closeOverNeeds(['bill_make'])).toEqual(['customer_view', 'bill_view', 'bill_make']);
    const maker = await person(['bill_make']);
    const { customer, payload } = await newBill('1000.00');
    const res = await post(maker, '/v1/bills', payload);
    expect(res.statusCode, res.body).toBe(201);
    const bill = await billRow(w, String(body(res).bill.id));
    expect(bill).toMatchObject({ customer_id: customer, status: 'active', grand_total: '1000.00' });
    expect(await receiptsOf(customer)).toEqual([]);
  });

  it('bill_make without payment_receive is refused when a payment line has an amount above 0, and nothing is written (the key stays free)', async () => {
    const maker = await person(['bill_make']);
    const biller = await w.world.addUser({ role: 'biller' });
    const { customer, payload } = await newBill('1000.00', { payments: [upi('0.00'), upi('100.00')] });
    const key = randomUUID();
    const before = await trace();
    await refusedClean(await post(maker, '/v1/bills', payload, key), before, 403, 'JV_FORBIDDEN');
    // the same body and key by the Biller (both ticks): a first use, the bill and its receipt are saved
    const done = await post(biller, '/v1/bills', payload, key);
    expect(done.statusCode, done.body).toBe(201);
    expect(done.headers['idempotent-replay']).toBeUndefined();
    expect(await receiptsOf(customer)).toEqual([['UPI', '100.00']]);
  });

  it('the same role saves the bill when it has no payment lines, an empty list, or only lines of amount 0', async () => {
    const maker = await person(['bill_make']);
    for (const extra of [{}, { payments: [] }, { payments: [upi('0.00'), cash('0.00')] }]) {
      const { customer, payload } = await newBill('500.00', extra);
      const res = await post(maker, '/v1/bills', payload);
      expect(res.statusCode, `${JSON.stringify(extra)}: ${res.body}`).toBe(201);
      expect(body(res).receipts).toEqual([]);
      expect(await receiptsOf(customer)).toEqual([]);
    }
  });

  it('the Biller (both ticks, day one) and a custom role with bill_make and payment_receive still save a bill with payment lines', async () => {
    for (const who of [await w.world.addUser({ role: 'biller' }), await person(['bill_make', 'payment_receive'])]) {
      const { customer, payload } = await newBill('1000.00', { payments: [upi('400.00')] });
      const res = await post(who, '/v1/bills', payload);
      expect(res.statusCode, res.body).toBe(201);
      expect(await receiptsOf(customer)).toEqual([['UPI', '400.00']]);
    }
  });
});

// ------------------------------------------------------------------ X10: payment lines, the old bill's date, the cash reason

describe('X10 reissue_bill: payment lines, the date of the old bill and the cash reason reach as in X1 (DESIGN M8, M13; rulings C and O)', () => {
  it('bill_reissue without payment_receive is refused when the re-issue carries a payment line above 0, nothing is written; without payment lines it works', async () => {
    const reissuer = await person(['bill_reissue']);
    const { customer, old, url, payload } = await oldBill('1000.00', { payments: [upi('200.00')] });
    const before = await trace();
    await refusedClean(await post(reissuer, url, payload), before, 403, 'JV_FORBIDDEN');
    expect((await billRow(w, old.id)).status, 'the old bill is untouched').toBe('active');

    // no payment lines, or only a line of amount 0: re-issued, and no receipt is made
    for (const extra of [{}, { payments: [upi('0.00')] }]) {
      const again = await oldBill('1000.00', extra);
      const res = await post(reissuer, again.url, again.payload);
      expect(res.statusCode, `${JSON.stringify(extra)}: ${res.body}`).toBe(201);
      expect(body(res).receipts).toEqual([]);
    }
    // with payment_receive as well, the payment line is taken
    const both = await person(['bill_reissue', 'payment_receive']);
    const res = await post(both, url, payload);
    expect(res.statusCode, res.body).toBe(201);
    expect(await receiptsOf(customer)).toEqual([['UPI', '200.00']]);
  });

  it('re-issuing a bill not dated today without back_date is refused on bill_date and nothing is written; with back_date it is re-issued; a bill dated today is re-issued without it', async () => {
    const without = await person(['bill_reissue']);
    const withTick = await person(['bill_reissue', 'back_date']);
    const { old, url, payload } = await oldBill('1000.00', {}, PAST);
    expect((await billRow(w, old.id)).bill_date).toBe(PAST);
    const before = await trace();
    // left out (the new bill would be dated today), and sent as the old date: both refused
    await refusedClean(await post(without, url, payload), before, 422, 'JV_INVALID_INPUT', 'bill_date');
    await refusedClean(await post(without, url, { ...payload, bill_date: PAST }), before, 422, 'JV_INVALID_INPUT', 'bill_date');
    await refusedClean(await post(without, url, { ...payload, bill_date: TODAY }), before, 422, 'JV_INVALID_INPUT', 'bill_date');

    const done = await post(withTick, url, { ...payload, bill_date: PAST });
    expect(done.statusCode, done.body).toBe(201);
    expect(body(done).new_bill.bill_date, 'the new bill keeps the old date').toBe(PAST);

    const today = await oldBill('1000.00');
    const ok = await post(without, today.url, today.payload);
    expect(ok.statusCode, ok.body).toBe(201);
    expect(body(ok).new_bill.bill_date).toBe(TODAY);
  });

  it('a cash_override_reason from a role without cash_over_limit is 403 on that field, nothing written, the key left free; a role with cash_over_limit stores it on the new bill', async () => {
    const REASON = 'abcdefghij'; // exactly 10 characters
    const plain = await person(['bill_reissue', 'payment_receive']);
    const allowed = await person(['bill_reissue', 'cash_over_limit']);
    // a bill of 3,00,000.00 re-issued with a Cash line of 2,00,000.00: the day's cash reaches the limit, so the reason is needed and stored
    const { customer, old, url, payload } = await oldBill('300000.00', { payments: [cash('200000.00')], cash_override_reason: REASON });
    const key = randomUUID();
    const before = await trace();
    await refusedClean(await post(plain, url, payload, key), before, 403, 'JV_FORBIDDEN', 'cash_override_reason');
    expect((await billRow(w, old.id)).status).toBe('active');

    const done = await post(allowed, url, payload, key); // a first use of the key: the refused claim was rolled back
    expect(done.statusCode, done.body).toBe(201);
    expect(done.headers['idempotent-replay']).toBeUndefined();
    expect(body(done).new_bill.cash_override_reason).toBe(REASON);
    expect((await rows(w, "SELECT cash_override_reason FROM bills WHERE customer_id = ? AND status = 'active'", [customer])).map((r) => r.cash_override_reason)).toEqual([REASON]);
  });
});
