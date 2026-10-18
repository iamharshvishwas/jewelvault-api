import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { formatTimestamp } from '../../src/clock';
import { type Designs, addDesigns, billBody, item, piece, postBill, saved } from './x01-support';
import { cancelBill, cancelled, dayRow, ledgerOf, receiptRow, voidReceipt, voided } from './x04-support';
import { type EditWorld, addBill, addCustomer, billRow, body, editWorld, pay, paid, refusal, rows } from './x02-support';

// API25, T-B16 (S5, Y8, D11, D13, V3, V4): the business day is the Asia/Kolkata calendar day of the API's one clock, not the UTC day. A bill saved at 23:30 and one at 00:30 on the 1st land in the right
// month; a future date is rejected; a biller cannot back-date and the owner can; a payment made at 23:50 on 31 December and voided at 00:10 on 1 January (18:40 UTC on the 31st) is reversed on 1 January
// and 31 December stays closed (`voided_on`, D13); a bill cancelled at 00:10 on 1 January is cancelled on that day (`cancelled_on`, D11). The clock of the world is moved by the test; the API clock never
// runs backwards (S5), so the moments below are in time order, all after the fixture's own 17 October, one after the other, and this file has a world of its own. The sessions of the fixture are renewed whenever time jumps.

let w: EditWorld;
let d: Designs;

beforeAll(async () => {
  w = await editWorld('x04dates');
  d = await addDesigns(w);
}, 120_000);
afterAll(async () => {
  await w?.world.close();
}, 60_000);

/** UTC milliseconds for a moment given in Asia/Kolkata (+05:30): `at(2026, 10, 31, 23, 30)` is 30 Sep 2026 23:30 in India. */
const at = (y: number, month: number, day: number, h: number, m: number): bigint => BigInt(Date.UTC(y, month - 1, day, h, m, 0) - 19_800_000) * 1000n;

/** Moves the API clock and renews the sessions of the fixture (a jump of weeks would end them: idle 12 hours, absolute 14 days). */
async function moveTo(micros: bigint): Promise<void> {
  w.time.time.micros = micros;
  await w.world.sql.query('UPDATE sessions SET last_seen_at = ?, expires_at = ?, revoked_at = NULL', [formatTimestamp(micros - 60_000_000n), formatTimestamp(micros + 14n * 24n * 3600n * 1_000_000n)]);
}

const sale = async (customer: string, total: string, extra: Record<string, unknown> = {}, caller: 'owner' | 'biller' = 'owner') => {
  const p = await piece(w, d.gold24pp, { retail: total });
  return postBill(w, caller, billBody(customer, 'Retail', [item(p, { metal_rate: total })], extra));
};
const upi = (amount: string, extra: Record<string, unknown> = {}) => ({ amount, mode: 'UPI', ...extra });
const months = async (customer: string): Promise<Record<string, number>> => {
  const found = await rows(w, "SELECT DATE_FORMAT(bill_date, '%Y-%m') AS m, COUNT(*) AS n FROM bills WHERE customer_id = ? GROUP BY m", [customer]);
  return Object.fromEntries(found.map((r) => [String(r.m), Number(r.n)]));
};

describe('T-B16 the business day is the Indian calendar day of the API clock (S5, Y8, D11, D13)', () => {
  let c: string;

  it('a bill saved at 23:30 on 31 October and one at 00:30 on 1 November (both 31 October in UTC) land in October and November; so do their payments in the cash book', async () => {
    c = await addCustomer(w);
    await moveTo(at(2026, 10, 31, 23, 30));
    const first = await saved(await sale(c, '100.00', { payments: [upi('100.00')] }));
    await moveTo(at(2026, 11, 1, 0, 30));
    const second = await saved(await sale(c, '200.00', { payments: [upi('200.00')] }));
    expect(first.bill.bill_date).toBe('2026-10-31');
    expect(second.bill.bill_date).toBe('2026-11-01');
    expect(first.receipts[0].paid_on).toBe('2026-10-31');
    expect(second.receipts[0].paid_on).toBe('2026-11-01');
    expect(await months(c)).toEqual({ '2026-10': 1, '2026-11': 1 });
    // the created_at stamps are UTC and both on the 30th: only the business date separates the two
    expect(String(first.bill.created_at).slice(0, 10)).toBe('2026-10-31');
    expect(String(second.bill.created_at).slice(0, 10)).toBe('2026-10-31');
    const ledger = await ledgerOf(w, c);
    expect(ledger.map((x) => [x.kind, x.entry_date])).toEqual([['Invoice', '2026-10-31'], ['Payment', '2026-10-31'], ['Invoice', '2026-11-01'], ['Payment', '2026-11-01']]);
    expect((await dayRow(w, '2026-10-31', 'UPI')).money_in).toBe('100.00');
    expect((await dayRow(w, '2026-11-01', 'UPI')).money_in).toBe('200.00');
  });

  it('a future date is rejected, for a bill and for a payment, for the owner too (it is 1 November in India, 31 October in UTC)', async () => {
    const tomorrow = '2026-11-02';
    for (const caller of ['owner', 'biller'] as const) {
      const bill = await sale(c, '50.00', { bill_date: tomorrow }, caller);
      expect(refusal(bill), `${caller} ${bill.body}`).toMatchObject({ status: 422, code: 'JV_INVALID_INPUT', field: 'bill_date' });
      const payment = await pay(w, caller, c, upi('10.00', { paid_on: tomorrow }));
      expect(refusal(payment), `${caller} ${payment.body}`).toMatchObject({ status: 422, code: 'JV_INVALID_INPUT', field: 'paid_on' });
    }
    // the date of the UTC calendar is the wrong day: 31 October is a past day in India now, not today
    const utcToday = await sale(c, '50.00', { bill_date: '2026-10-31' }, 'biller');
    expect(refusal(utcToday)).toMatchObject({ status: 422, code: 'JV_INVALID_INPUT', field: 'bill_date' });
  });

  it('a biller cannot back-date a bill or a payment, the owner can', async () => {
    const dated = '2026-10-25';
    const billerBill = await sale(c, '60.00', { bill_date: dated }, 'biller');
    expect(refusal(billerBill)).toMatchObject({ status: 422, code: 'JV_INVALID_INPUT', field: 'bill_date' });
    const billerPay = await pay(w, 'biller', c, upi('10.00', { paid_on: dated }));
    expect(refusal(billerPay)).toMatchObject({ status: 422, code: 'JV_INVALID_INPUT', field: 'paid_on' });
    const ownerBill = await saved(await sale(c, '60.00', { bill_date: dated }, 'owner'));
    expect(ownerBill.bill.bill_date).toBe(dated);
    const ownerPay = await paid(await pay(w, 'owner', c, upi('10.00', { paid_on: dated })));
    expect(ownerPay.receipt.paid_on).toBe(dated);
    // and today is today for both
    expect((await saved(await sale(c, '30.00', {}, 'biller'))).bill.bill_date).toBe('2026-11-01');
  });

  it('a payment made at 23:50 on 31 December and voided at 00:10 on 1 January (18:40 UTC on the 31st): the void is reversed on 1 January, 31 December stays closed, voided_at and voided_on are ONE reading', async () => {
    const cust = await addCustomer(w);
    await addBill(w, cust, '1000.00', '2026-12-01');
    await moveTo(at(2026, 12, 31, 23, 50));
    const r = await paid(await pay(w, 'owner', cust, upi('400.00')));
    expect(r.receipt).toMatchObject({ paid_on: '2026-12-31' });
    const december = await dayRow(w, '2026-12-31', 'UPI');
    const january = await dayRow(w, '2027-01-01', 'UPI');
    expect(december.money_in).toBe('400.00');

    await moveTo(at(2027, 1, 1, 0, 10));
    const v = await voided(await voidReceipt(w, 'owner', r.receipt.id, { reason: 'entered on the wrong customer' }));
    expect(v.receipt).toMatchObject({ paid_on: '2026-12-31', voided_on: '2027-01-01', status: 'voided' });
    const stored = await receiptRow(w, r.receipt.id);
    expect(String(stored.voided_at)).toMatch(/^2026-12-31 18:40:00/); // 00:10 on 1 January in India is 18:40 UTC on the 31st
    expect(stored.voided_on).toBe('2027-01-01');
    // one reading of the clock gave both: the reading with that exact stamp carries that business day
    const reading = w.time.readings.find((x) => x.timestamp === stored.voided_at);
    expect(reading?.date).toBe('2027-01-01');

    expect(await dayRow(w, '2026-12-31', 'UPI'), '31 December is closed: the void does not change it').toEqual(december);
    const after = await dayRow(w, '2027-01-01', 'UPI');
    expect(BigInt(after.money_out.replace('.', '')) - BigInt(january.money_out.replace('.', ''))).toBe(40_000n);
    const ledger = await ledgerOf(w, cust);
    expect(ledger.map((x) => [x.kind, x.entry_date])).toEqual([['Invoice', '2026-12-01'], ['Payment', '2026-12-31'], ['Void', '2027-01-01']]);
  });

  it('a bill cancelled at 00:10 on 1 January is cancelled on that day (cancelled_on), at 18:40 UTC on the 31st; the cancellation is on 1 January in the ledger', async () => {
    const cust = await addCustomer(w);
    const a = await addBill(w, cust, '500.00', '2026-12-20');
    await moveTo(at(2027, 1, 1, 0, 10));
    const r = await cancelled(await cancelBill(w, 'owner', a, { reason: 'the customer returned the goods' }));
    expect(r.bill).toMatchObject({ status: 'cancelled', cancelled_on: '2027-01-01' });
    const stored = await billRow(w, a);
    expect(String(stored.cancelled_at)).toMatch(/^2026-12-31 18:40:00/);
    expect(stored.cancelled_on).toBe('2027-01-01');
    const reading = w.time.readings.find((x) => x.timestamp === stored.cancelled_at);
    expect(reading?.date).toBe('2027-01-01');
    const ledger = await ledgerOf(w, cust);
    expect(ledger.map((x) => [x.kind, x.entry_date])).toEqual([['Invoice', '2026-12-20'], ['Cancellation', '2027-01-01']]);
  });

  it('the answer of a void and of a cancel shows the same day as the tables (the wire row is the stored row)', async () => {
    const cust = await addCustomer(w);
    const a = await addBill(w, cust, '500.00', '2026-12-20');
    const r = await paid(await pay(w, 'owner', cust, upi('100.00')));
    const v = await voided(await voidReceipt(w, 'owner', r.receipt.id));
    expect(v.receipt.voided_on).toBe('2027-01-01');
    const x = await cancelled(await cancelBill(w, 'owner', a));
    expect(x.bill.cancelled_on).toBe('2027-01-01');
    expect(body(await voidReceipt(w, 'owner', r.receipt.id)).error.code).toBe('JV_ALREADY_VOID');
  });
});
