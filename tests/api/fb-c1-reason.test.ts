import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Designs, addDesigns } from './x01-support';
import { cancelBill, receiptRow, voidReceipt } from './x04-support';
import { type EditWorld, addBill, addCustomer, addMoney, billRow, editWorld, refusal } from './x02-support';
import { type Body, line, reissueBill, sell } from './x10-support';

// FB-C1 (Siddhi's feedback of 6 Nov 2026, #3; decision FB-D1): the reason of a void (X4), a cancel (X5) and a re-issue (X10) is OPTIONAL. A missing, empty or blank reason is stored as the text
// `No reason given`; a reason that is typed keeps the old rule (trimmed, 3 to 500 characters), so "ab" and 501 characters are still refused on `reason`, and "wrong rate" is stored as typed.
// One rule for the three, in src/money/reason.ts. The calls go through the real routes; the stored row is read back with SQL.

let w: EditWorld;
let d: Designs;

beforeAll(async () => {
  w = await editWorld('fbc1reason');
  d = await addDesigns(w);
}, 120_000);
afterAll(async () => {
  await w?.world.close();
}, 60_000);

const NO_REASON = 'No reason given';
const BLANK_BODIES: { name: string; reason?: string }[] = [{ name: 'no reason' }, { name: 'an empty reason', reason: '' }, { name: 'a blank reason', reason: '   ' }];
const withReason = (reason: string | undefined): Body => (reason === undefined ? {} : { reason });

describe('FB-C1 X4 void_receipt: the reason is optional', () => {
  for (const { name, reason } of BLANK_BODIES) {
    it(`${name}: the receipt is voided and the stored void_reason is "${NO_REASON}"`, async () => {
      const c = await addCustomer(w);
      const r = await addMoney(w, c, '40.00', '2026-10-01');
      const res = await voidReceipt(w, 'owner', r, withReason(reason));
      expect(res.statusCode, res.body).toBe(200);
      expect((await receiptRow(w, r)).void_reason).toBe(NO_REASON);
    });
  }

  it('a typed reason keeps the old rule: "ab" and 501 characters are refused on reason; "wrong rate" is stored as typed', async () => {
    const c = await addCustomer(w);
    const r = await addMoney(w, c, '40.00', '2026-10-01');
    for (const reason of ['ab', '  ab  ', 'x'.repeat(501)]) expect(refusal(await voidReceipt(w, 'owner', r, { reason }))).toMatchObject({ status: 422, code: 'JV_INVALID_INPUT', field: 'reason' });
    expect((await receiptRow(w, r)).status).toBe('active');
    const res = await voidReceipt(w, 'owner', r, { reason: 'wrong rate' });
    expect(res.statusCode, res.body).toBe(200);
    expect((await receiptRow(w, r)).void_reason).toBe('wrong rate');
  });
});

describe('FB-C1 X5 cancel_bill: the reason is optional', () => {
  for (const { name, reason } of BLANK_BODIES) {
    it(`${name}: the bill is cancelled and the stored cancel_reason is "${NO_REASON}"`, async () => {
      const c = await addCustomer(w);
      const b = await addBill(w, c, '100.00', '2026-10-01');
      const res = await cancelBill(w, 'owner', b, withReason(reason));
      expect(res.statusCode, res.body).toBe(200);
      expect(await billRow(w, b)).toMatchObject({ status: 'cancelled', cancel_reason: NO_REASON });
    });
  }

  it('a typed reason keeps the old rule: "ab" and 501 characters are refused on reason; "wrong rate" is stored as typed', async () => {
    const c = await addCustomer(w);
    const b = await addBill(w, c, '100.00', '2026-10-01');
    for (const reason of ['ab', '  ab  ', 'x'.repeat(501)]) expect(refusal(await cancelBill(w, 'owner', b, { reason }))).toMatchObject({ status: 422, code: 'JV_INVALID_INPUT', field: 'reason' });
    expect((await billRow(w, b)).status).toBe('active');
    const res = await cancelBill(w, 'owner', b, { reason: 'wrong rate' });
    expect(res.statusCode, res.body).toBe(200);
    expect((await billRow(w, b)).cancel_reason).toBe('wrong rate');
  });
});

describe('FB-C1 X10 reissue_bill: the reason is optional', () => {
  for (const { name, reason } of BLANK_BODIES) {
    it(`${name}: the bill is re-issued and the old bill's stored cancel_reason is "${NO_REASON}"`, async () => {
      const c = await addCustomer(w);
      const a = await sell(w, d, c, '100.00');
      const res = await reissueBill(w, 'owner', a.id, { sale_type: 'Retail', items: [line(a.piece, '90.00')], ...withReason(reason) });
      expect(res.statusCode, res.body).toBe(201);
      expect(await billRow(w, a.id)).toMatchObject({ status: 'cancelled', cancel_reason: NO_REASON });
    });
  }

  it('a typed reason keeps the old rule: "ab" and 501 characters are refused on reason; "wrong rate" is stored as typed', async () => {
    const c = await addCustomer(w);
    const a = await sell(w, d, c, '100.00');
    const items = [line(a.piece, '90.00')];
    for (const reason of ['ab', '  ab  ', 'x'.repeat(501)]) {
      expect(refusal(await reissueBill(w, 'owner', a.id, { sale_type: 'Retail', items, reason }))).toMatchObject({ status: 422, code: 'JV_INVALID_INPUT', field: 'reason' });
    }
    expect((await billRow(w, a.id)).status).toBe('active');
    const res = await reissueBill(w, 'owner', a.id, { sale_type: 'Retail', items, reason: 'wrong rate' });
    expect(res.statusCode, res.body).toBe(201);
    expect((await billRow(w, a.id)).cancel_reason).toBe('wrong rate');
  });
});
