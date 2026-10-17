import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app';
import { createClock } from '../../src/clock';
import { createDbPool } from '../../src/db/pool';
import { type PriceBillInput, type PricedBill, priceBill } from '../../src/domain/pricing';
import { PRICING_VERSIONS, registerQuoteBill } from '../../src/money/x07QuoteBill';
import { registerCreateBill } from '../../src/money/x01CreateBill';
import { insert, V } from '../schema/support';
import { T0 } from './cells';
import { csrfHeaders, testConfig } from './support';
import { Gates } from './x0-support';
import {
  type Body,
  type Designs,
  type EditWorld,
  type Quote,
  TODAY,
  WALKIN,
  addCustomer,
  addDesigns,
  addRate,
  billBody,
  billRow,
  body,
  codeOf,
  counterOf,
  countOf,
  editWorld,
  errorField,
  footprint,
  item,
  itemRows,
  newKey,
  piece,
  pieceRow,
  postBill,
  postQuote,
  requestIdOf,
  rows,
  saved,
  setEstimate,
} from './x01-support';

// API20, X1 `create_bill` (POST /v1/bills, 201 {bill, items, receipts, allocations, warnings, advance_applied}) without payments: the DB halves of T-A03 (the sale type and the labour rate it was sent), T-A06
// (Per Piece quantity), T-A10 (round-off), T-A15 (a quote is what the bill then stores, for version 1 and a test-only version 2), T-A17 (metal_rate required, RATE_MISSING, RATE_STALE), T-C08 and R10 (the
// pieces that may be billed), the bill and line clauses of T-A09, the clauses of T-D03 (no result holds the original weight), T-D09 (the matrix row of X1 and its field rules), the lock order of X0 and
// Y8, Z3. The concurrency and repeat-safety tests (T-C04, T-C05, T-C06) are in x01-repeat-safety.test.ts, the audit rows (T-D14) in x01-audit.test.ts.
//
// The world is a scratch database with the real routes, the seeds (settings.estimate: prefix JV, round-off on) and a clock fixed at 17 Oct 2026 10:00 UTC, which is 15:30 in Kolkata: "today" is 2026-10-17.
// Expected figures are written in the test (the spec's own, or worked out by hand), never read back from the code under test. Every test makes the pieces it bills.

let w: EditWorld;
let d: Designs;

beforeAll(async () => {
  w = await editWorld('x01main');
  d = await addDesigns(w);
  await addRate(w, 'Gold', '22K', '6920.00', TODAY);
  await addRate(w, 'Gold', '22K', '6800.00', '2026-10-10');
  await addRate(w, 'Gold', '18K', '5700.00', '2026-10-15'); // dated before today: stale
  await addRate(w, 'Silver', '999', '85.00', TODAY);
  // Silver 925 has no daily rate at all
}, 120_000);
afterAll(async () => {
  await w?.world.close();
}, 60_000);

/** The call is refused with 422 JV_INVALID_INPUT naming `field`, and nothing is left behind (no bill, no line, no claim, no number, no Sold piece, no touch). */
async function refused(payload: unknown, field: string, caller: 'owner' | 'biller' = 'owner') {
  const before = await footprint(w);
  const res = await postBill(w, caller, payload);
  expect(res.statusCode, `${field}: ${res.body}`).toBe(422);
  expect(codeOf(res)).toBe('JV_INVALID_INPUT');
  expect(errorField(res)).toBe(field);
  expect(await footprint(w), `${field}: the refused call left something behind`).toEqual(before);
  return body(res).error as { message: string };
}

// ------------------------------------------------------------------ the bill as saved

describe('X1 create_bill saves what R1 to R8 price (D11, D12)', () => {
  it('saves the worked example of section 8 and numbers it <prefix>-<year>-<4 digits>', async () => {
    const c = await addCustomer(w);
    const p = await piece(w, d.gold22, { nw: '35.420', gross: '38.100', retail: '353.00' });
    const res = await postBill(w, 'biller', billBody(c, 'Retail', [item(p, { metal_rate: '6920.00', labour_rate: '353.00', piroi: '2.15' })], { notes: '  gift wrap  ' }));
    expect(res.statusCode, res.body).toBe(201);
    const r = body(res);
    expect(Object.keys(r)).toEqual(['bill', 'items', 'receipts', 'allocations', 'warnings', 'advance_applied']);
    expect(r.bill.bill_no).toMatch(/^JV-2026-\d{4}$/);
    expect(r.bill).toMatchObject({
      customer_id: c,
      bill_date: TODAY,
      doc_type: 'estimate',
      sale_type: 'Retail',
      status: 'active',
      cancel_reason: null,
      cancelled_at: null,
      cancelled_on: null,
      cancelled_by: null,
      reissue_of: null,
      pricing_version: 1,
      subtotal: '257611.81',
      discount: '0.00',
      additional_charges: '0.00',
      gst_percent: '0.00',
      gst_amount: '0.00',
      grand_total: '257612.00',
      round_off: '0.19',
      fine_weight_due: '0.000',
      notes: 'gift wrap',
      cash_override_reason: null,
      created_by: w.world.fixtures.biller.userId,
      updated_by: w.world.fixtures.biller.userId,
    });
    expect(r.items).toHaveLength(1);
    const [snap] = await rows(w, 'SELECT d.design_no, s.sku_no, c.name AS category FROM skus s JOIN designs d ON d.id = s.design_id JOIN categories c ON c.id = d.category_id WHERE s.id = ?', [p]);
    expect(r.items[0]).toMatchObject({
      bill_id: r.bill.id,
      line_no: 1,
      sku_id: p,
      design_no: snap.design_no,
      sku_no: snap.sku_no,
      category: snap.category,
      material: 'Gold',
      purity: '22K',
      selling_method: 'By Weight',
      gross_weight: '38.100',
      customer_net_weight: '35.420',
      quantity: 1,
      metal_rate: '6920.00',
      labour_rate: '353.00',
      labour_amount: '12503.26',
      piroi: '2.15',
      other_charges: '0.00',
      metal_amount: '245106.40',
      fine_weight_due: '0.000',
      item_total: '257611.81',
      tax_rate: '0.00',
      tax_amount: '0.00',
      list_metal_rate: '6920.00',
      list_labour_rate: '353.00',
    });
    expect(r.receipts).toEqual([]);
    expect(r.allocations).toEqual([]);
    expect(r.advance_applied).toBe('0.00');
    // the tables hold what the answer says
    const stored = await billRow(w, r.bill.id);
    expect(stored).toMatchObject({ bill_no: r.bill.bill_no, subtotal: '257611.81', grand_total: '257612.00', round_off: '0.19', cancelled_on: null, notes: 'gift wrap', request_id: expect.stringMatching(/^[0-9a-f-]{36}$/) });
    expect((await itemRows(w, r.bill.id)).map((i) => i.id)).toEqual(r.items.map((i: any) => i.id));
  });

  it('marks every piece Sold with its bill in the same transaction, stamps everything from one reading, and touches the customer (K2, D23, S6)', async () => {
    const c = await addCustomer(w);
    const [a, b] = [await piece(w, d.gold22, { nw: '5.000', retail: '100.00' }), await piece(w, d.gold24pp, { nw: '2.000', retail: '500.00' })];
    const customerBefore = (await rows(w, 'SELECT updated_at FROM customers WHERE id = ?', [c]))[0].updated_at;
    const r = await saved(await postBill(w, 'owner', billBody(c, 'Retail', [item(a, { metal_rate: '6920.00', labour_rate: '100.00' }), item(b, { metal_rate: '500.00' })])));
    for (const [i, id] of [a, b].entries()) {
      const row = await pieceRow(w, id);
      expect(row, `piece ${i + 1}`).toMatchObject({ status: 'Sold', sold_bill_id: r.bill.id, updated_by: w.world.fixtures.owner.userId });
    }
    expect(r.items.map((i) => i.line_no)).toEqual([1, 2]);
    // one reading of the API clock stamps the bill, the lines, the pieces and the customer's touch
    const bill = await billRow(w, r.bill.id);
    const stamps = new Set([String(bill.created_at), String(bill.updated_at), ...(await itemRows(w, r.bill.id)).flatMap((i) => [String(i.created_at), String(i.updated_at)])]);
    for (const id of [a, b]) stamps.add(String((await pieceRow(w, id)).updated_at));
    stamps.add(String((await rows(w, 'SELECT updated_at FROM customers WHERE id = ?', [c]))[0].updated_at));
    expect([...stamps], 'the bill, its lines, its pieces and the customer carry the stamp of one reading').toHaveLength(1);
    expect([...stamps][0], 'the customer was touched (D23)').not.toBe(String(customerBefore));
    expect(r.bill.created_at).toMatch(/^2026-10-17T10:00:00\.\d{6}Z$/);
    expect(r.bill.updated_at).toBe(r.bill.created_at);
    expect(r.items.every((i) => i.created_at === r.bill.created_at)).toBe(true);
  });

  it('numbers bills one after the other from the series of the prefix and the year of the day it is saved (L3, L4)', async () => {
    await setEstimate(w, { prefix: 'NO', roundOff: true });
    const c = await addCustomer(w);
    const numbers: string[] = [];
    for (let i = 0; i < 3; i++) {
      const p = await piece(w, d.gold24pp, { retail: '10.00' });
      numbers.push((await saved(await postBill(w, 'biller', billBody(c, 'Retail', [item(p, { metal_rate: '10.00' })])))).bill.bill_no);
    }
    expect(numbers).toEqual(['NO-2026-0001', 'NO-2026-0002', 'NO-2026-0003']);
    expect(await counterOf(w, 'bill:NO:2026')).toBe(3);
    // a back-dated bill still takes the number of the year it is SAVED in
    const p = await piece(w, d.gold24pp, { retail: '10.00' });
    const back = await saved(await postBill(w, 'owner', billBody(c, 'Retail', [item(p, { metal_rate: '10.00' })], { bill_date: '2025-12-31' })));
    expect(back.bill).toMatchObject({ bill_no: 'NO-2026-0004', bill_date: '2025-12-31' });
    await setEstimate(w, { prefix: 'JV', roundOff: true });
  });

  it('an imported bill number is skipped (L3): the look-ahead takes the next free number', async () => {
    await setEstimate(w, { prefix: 'IM', roundOff: true });
    const c = await addCustomer(w);
    await insert(w.world.sql, 'bills', V.bill(c, { bill_no: 'IM-2026-0001' }));
    await insert(w.world.sql, 'bills', V.bill(c, { bill_no: 'IM-2026-0002' }));
    const p = await piece(w, d.gold24pp, { retail: '10.00' });
    const r = await saved(await postBill(w, 'biller', billBody(c, 'Retail', [item(p, { metal_rate: '10.00' })])));
    expect(r.bill.bill_no).toBe('IM-2026-0003');
    await setEstimate(w, { prefix: 'JV', roundOff: true });
  });

  it('notes: trimmed, a blank note is none', async () => {
    const c = await addCustomer(w);
    const a = await saved(await postBill(w, 'owner', billBody(c, 'Retail', [item(await piece(w, d.gold24pp, { retail: '10.00' }), { metal_rate: '10.00' })], { notes: '   ' })));
    expect(a.bill.notes).toBeNull();
    const b = await saved(await postBill(w, 'owner', billBody(c, 'Retail', [item(await piece(w, d.gold24pp, { retail: '10.00' }), { metal_rate: '10.00' })], { notes: 'x'.repeat(10_000) })));
    expect(b.bill.notes).toHaveLength(10_000);
    await refused(billBody(c, 'Retail', [item(await piece(w, d.gold24pp, { retail: '10.00' }), { metal_rate: '10.00' })], { notes: 'x'.repeat(10_001) }), 'notes');
  });

  it('a bill with 200 lines is saved in one call (S4) and a bill over it is refused', async () => {
    const c = await addCustomer(w);
    const ids: string[] = [];
    for (let i = 0; i < 200; i++) ids.push(await piece(w, d.gold24pp, { retail: '1.00' }));
    const r = await saved(await postBill(w, 'owner', billBody(c, 'Retail', ids.map((id) => item(id, { metal_rate: '1.00' })))));
    expect(r.items).toHaveLength(200);
    expect(r.items.map((i) => i.line_no)).toEqual(Array.from({ length: 200 }, (_, i) => i + 1));
    expect(r.bill).toMatchObject({ subtotal: '200.00', grand_total: '200.00' });
    expect(await countOf(w, 'skus', "status = 'Sold' AND sold_bill_id = ?", [r.bill.id])).toBe(200);
    await refused(billBody(c, 'Retail', [...ids, ids[0]].map((id) => item(id, { metal_rate: '1.00' }))), 'items');
  });

  it('Wholesale silver By Weight carries the fine due, bills the labour and not the metal (R4, R5), and the bill stores the fine weight', async () => {
    const c = await addCustomer(w);
    const p = await piece(w, d.silver999, { nw: '100.000', retail: '10.00', wholesale: '8.00' });
    const r = await saved(await postBill(w, 'owner', billBody(c, 'Wholesale', [item(p, { metal_rate: '85.00', labour_rate: '8.00' })])));
    expect(r.items[0]).toMatchObject({ metal_amount: '0.00', labour_amount: '800.00', fine_weight_due: '100.000', item_total: '800.00', list_metal_rate: '85.00', list_labour_rate: '8.00' });
    expect(r.bill).toMatchObject({ subtotal: '800.00', grand_total: '800.00', fine_weight_due: '100.000' });
  });

  it('discount and additional charges are saved and priced (R8); a discount above the total is refused and nothing is saved', async () => {
    const c = await addCustomer(w);
    const p = await piece(w, d.gold24pp, { retail: '1000.00' });
    const r = await saved(await postBill(w, 'owner', billBody(c, 'Retail', [item(p, { metal_rate: '1000.00' })], { discount: '100.00', additional_charges: '25.50' })));
    expect(r.bill).toMatchObject({ subtotal: '1000.00', discount: '100.00', additional_charges: '25.50', grand_total: '926.00', round_off: '0.50' }); // 925.50 rounds half up
    const q = await piece(w, d.gold24pp, { retail: '1000.00' });
    const before = await footprint(w);
    const res = await postBill(w, 'owner', billBody(c, 'Retail', [item(q, { metal_rate: '1000.00' })], { discount: '1000.01' }));
    expect(res.statusCode, res.body).toBe(422);
    expect(errorField(res)).toBe('discount');
    expect(await footprint(w)).toEqual(before);
    expect((await pieceRow(w, q)).status).toBe('In Stock');
  });
});

// ------------------------------------------------------------------ T-A03

describe('T-A03 the bill stores the sale type it was sent and prices each line with the labour rate it was sent (R1, R9)', () => {
  it('Wholesale sent for a Retail customer: the sale type is stored, the labour is the rate sent and not the piece\'s retail rate, the list labour rate is the piece\'s wholesale rate', async () => {
    const c = await addCustomer(w, { customer_type: 'Retail' });
    const p = await piece(w, d.gold22, { nw: '10.000', retail: '353.00', semi: '300.00', wholesale: '250.00' });
    const r = await saved(await postBill(w, 'biller', billBody(c, 'Wholesale', [item(p, { metal_rate: '6920.00', labour_rate: '260.00' })])));
    expect(r.bill.sale_type).toBe('Wholesale');
    expect((await billRow(w, r.bill.id)).sale_type).toBe('Wholesale');
    expect(r.items[0]).toMatchObject({ labour_rate: '260.00', labour_amount: '2600.00', metal_amount: '69200.00', item_total: '71800.00', list_labour_rate: '250.00', fine_weight_due: '0.000' });
    expect(r.bill).toMatchObject({ subtotal: '71800.00', grand_total: '71800.00' });
  });

  it('Semi-Wholesale sent for a Wholesale customer: the rate sent is priced, the list labour rate is the piece\'s semi-wholesale rate', async () => {
    const c = await addCustomer(w, { customer_type: 'Wholesale' });
    const p = await piece(w, d.gold22, { nw: '10.000', retail: '353.00', semi: '300.00', wholesale: '250.00' });
    const r = await saved(await postBill(w, 'owner', billBody(c, 'Semi-Wholesale', [item(p, { metal_rate: '6920.00', labour_rate: '275.50' })])));
    expect(r.bill.sale_type).toBe('Semi-Wholesale');
    expect(r.items[0]).toMatchObject({ labour_rate: '275.50', labour_amount: '2755.00', item_total: '71955.00', list_labour_rate: '300.00' });
  });

  it('Retail sent for a Wholesale customer is a Retail bill; the customer\'s own type is not consulted', async () => {
    const c = await addCustomer(w, { customer_type: 'Wholesale' });
    const p = await piece(w, d.gold22, { nw: '10.000', retail: '353.00', semi: '300.00', wholesale: '250.00' });
    const r = await saved(await postBill(w, 'owner', billBody(c, 'Retail', [item(p, { metal_rate: '6920.00', labour_rate: '353.00' })])));
    expect(r.bill.sale_type).toBe('Retail');
    expect(r.items[0]).toMatchObject({ labour_amount: '3530.00', list_labour_rate: '353.00' });
  });

  it('a sale type that is not one of the three, or none, is refused', async () => {
    const c = await addCustomer(w);
    const p = await piece(w, d.gold22, { retail: '1.00' });
    for (const s of ['retail', 'Credit', '', 5, null]) await refused(billBody(c, s as string, [item(p, { metal_rate: '1.00', labour_rate: '1.00' })]), 'sale_type');
    await refused({ customer_id: c, items: [item(p, { metal_rate: '1.00', labour_rate: '1.00' })] }, 'sale_type');
  });
});

// ------------------------------------------------------------------ T-A06

describe('T-A06 Per Piece quantity: the price is kept and the quantity is saved (R5, R6)', () => {
  it('quantity 3 at 1,200: metal 3,600.00, labour 0, the quantity on the line', async () => {
    const c = await addCustomer(w);
    const p = await piece(w, d.gold24pp, { nw: '5.000', retail: '1200.00' });
    const r = await saved(await postBill(w, 'biller', billBody(c, 'Retail', [item(p, { metal_rate: '1200.00', quantity: 3 })])));
    expect(r.items[0]).toMatchObject({ quantity: 3, metal_rate: '1200.00', metal_amount: '3600.00', labour_rate: '0.00', labour_amount: '0.00', item_total: '3600.00', list_metal_rate: '1200.00', list_labour_rate: null, selling_method: 'Per Piece' });
    expect(r.bill).toMatchObject({ subtotal: '3600.00', grand_total: '3600.00' });
    expect((await itemRows(w, r.bill.id))[0].quantity).toBe(3);
  });

  it('a labour_rate sent with a Per Piece line is ignored: 0.00 is stored', async () => {
    const c = await addCustomer(w);
    const p = await piece(w, d.gold24pp, { retail: '1200.00' });
    const r = await saved(await postBill(w, 'owner', billBody(c, 'Retail', [item(p, { metal_rate: '1200.00', labour_rate: '999.00', quantity: 2 })])));
    expect(r.items[0]).toMatchObject({ labour_rate: '0.00', labour_amount: '0.00', metal_amount: '2400.00', item_total: '2400.00' });
  });

  it('piroi and other charges are added once per line, not per piece (R7); an absent quantity is 1', async () => {
    const c = await addCustomer(w);
    const p = await piece(w, d.gold24pp, { retail: '100.00' });
    const q = await piece(w, d.gold24pp, { retail: '100.00' });
    const r = await saved(await postBill(w, 'owner', billBody(c, 'Retail', [item(p, { metal_rate: '100.00', quantity: 4, piroi: '5.00', other_charges: '7.25' }), item(q, { metal_rate: '100.00' })])));
    expect(r.items[0]).toMatchObject({ quantity: 4, metal_amount: '400.00', piroi: '5.00', other_charges: '7.25', item_total: '412.25' });
    expect(r.items[1]).toMatchObject({ quantity: 1, piroi: '0.00', other_charges: '0.00', item_total: '100.00' });
  });

  it('a By Weight piece with quantity 2 is rejected (R6), and nothing is saved', async () => {
    const c = await addCustomer(w);
    const p = await piece(w, d.gold22, { nw: '10.000', retail: '353.00' });
    await refused(billBody(c, 'Retail', [item(p, { metal_rate: '6920.00', labour_rate: '353.00', quantity: 2 })]), 'items[0].quantity');
    expect((await pieceRow(w, p)).status).toBe('In Stock');
  });
});

// ------------------------------------------------------------------ T-A10

describe('T-A10 round-off on and off both give a whole-rupee grand total (R8, D11)', () => {
  // [before_round, grand_total, round_off with the setting on]
  const CASES: [string, string, string][] = [
    ['1000.50', '1001.00', '0.50'],
    ['1000.49', '1000.00', '-0.49'],
    ['1000.40', '1000.00', '-0.40'],
    ['1000.00', '1000.00', '0.00'],
    ['999.99', '1000.00', '0.01'],
  ];
  for (const [on, label] of [[true, 'on'], [false, 'off']] as const) {
    it(`with the setting ${label}: ${CASES.map(([b, g]) => `${b} gives ${g}`).join(', ')}`, async () => {
      await setEstimate(w, { roundOff: on });
      try {
        const c = await addCustomer(w);
        for (const [before, grand, roundOff] of CASES) {
          const p = await piece(w, d.gold24pp, { retail: before });
          const r = await saved(await postBill(w, 'biller', billBody(c, 'Retail', [item(p, { metal_rate: before })])));
          expect(r.bill, `before_round ${before}`).toMatchObject({ subtotal: before, grand_total: grand, round_off: on ? roundOff : '0.00' });
          const stored = await billRow(w, r.bill.id);
          expect(stored.grand_total, 'a whole rupee in the table').toMatch(/^\d+\.00$/);
          expect(stored.round_off).toBe(on ? roundOff : '0.00');
        }
      } finally {
        await setEstimate(w, { roundOff: true });
      }
    });
  }

  it('round_off is stored negative for 1,000.40 (-0.40) and a negative round_off reads back signed', async () => {
    const c = await addCustomer(w);
    const p = await piece(w, d.gold24pp, { retail: '1000.40' });
    const r = await saved(await postBill(w, 'owner', billBody(c, 'Retail', [item(p, { metal_rate: '1000.40' })])));
    expect(r.bill.round_off).toBe('-0.40');
    expect((await rows(w, 'SELECT round_off FROM bills WHERE id = ?', [r.bill.id]))[0].round_off).toBe('-0.40');
  });

  it('a settings.estimate without a true or false roundOff is a fault of the data (JV_INTERNAL), and nothing is saved', async () => {
    await w.world.sql.query("UPDATE settings SET value = '{\"prefix\":\"JV\",\"roundOff\":\"yes\"}' WHERE setting_key = 'estimate'");
    try {
      const c = await addCustomer(w);
      const p = await piece(w, d.gold24pp, { retail: '10.00' });
      const before = await footprint(w);
      const res = await postBill(w, 'owner', billBody(c, 'Retail', [item(p, { metal_rate: '10.00' })]));
      expect(res.statusCode).toBe(500);
      expect(codeOf(res)).toBe('JV_INTERNAL');
      expect(await footprint(w)).toEqual(before);
    } finally {
      await setEstimate(w, { roundOff: true });
    }
  });
});

// ------------------------------------------------------------------ T-A17

describe('T-A17 metal_rate is required; a missing rate is RATE_MISSING, a stale one RATE_STALE, both still save (R2, D4)', () => {
  it('metal_rate is required on every line, By Weight or Per Piece', async () => {
    const c = await addCustomer(w);
    const byWeight = await piece(w, d.gold22, { retail: '353.00' });
    const perPiece = await piece(w, d.gold24pp, { retail: '100.00' });
    await refused(billBody(c, 'Retail', [item(byWeight, { labour_rate: '353.00' })]), 'items[0].metal_rate');
    await refused(billBody(c, 'Retail', [item(perPiece, {})]), 'items[0].metal_rate');
    await refused(billBody(c, 'Retail', [item(perPiece, { metal_rate: null })]), 'items[0].metal_rate');
  });

  it('a By Weight line with no daily rate for its material and purity saves with RATE_MISSING and a list metal rate of 0.00', async () => {
    const c = await addCustomer(w);
    const p = await piece(w, d.silver925, { nw: '20.000', retail: '5.00' });
    const r = await saved(await postBill(w, 'biller', billBody(c, 'Retail', [item(p, { metal_rate: '80.00', labour_rate: '5.00' })])));
    expect(r.warnings).toEqual(['RATE_MISSING']);
    expect(r.items[0]).toMatchObject({ metal_rate: '80.00', metal_amount: '1600.00', list_metal_rate: '0.00', list_labour_rate: '5.00' });
    expect((await itemRows(w, r.bill.id))[0].list_metal_rate).toBe('0.00');
  });

  it('a rate dated before the bill date saves with RATE_STALE and the stale rate as the list price', async () => {
    const c = await addCustomer(w);
    const p = await piece(w, d.gold18, { nw: '10.000', retail: '100.00' });
    const r = await saved(await postBill(w, 'owner', billBody(c, 'Retail', [item(p, { metal_rate: '5800.00', labour_rate: '100.00' })])));
    expect(r.warnings).toEqual(['RATE_STALE']);
    expect(r.items[0]).toMatchObject({ list_metal_rate: '5700.00', metal_rate: '5800.00', metal_amount: '58000.00' });
  });

  it('a rate dated today gives no warning; both warnings together come out unique and sorted', async () => {
    const c = await addCustomer(w);
    const fresh = await piece(w, d.gold22, { retail: '100.00' });
    const r1 = await saved(await postBill(w, 'owner', billBody(c, 'Retail', [item(fresh, { metal_rate: '6920.00', labour_rate: '100.00' })])));
    expect(r1.warnings).toEqual([]);
    const lines = [await piece(w, d.silver925, { retail: '1.00' }), await piece(w, d.gold18, { retail: '1.00' }), await piece(w, d.silver925, { retail: '1.00' }), await piece(w, d.gold18, { retail: '1.00' })];
    const r2 = await saved(await postBill(w, 'owner', billBody(c, 'Retail', lines.map((id) => item(id, { metal_rate: '10.00', labour_rate: '1.00' })))));
    expect(r2.warnings).toEqual(['RATE_MISSING', 'RATE_STALE']);
  });

  it('the daily rate used is the latest one NOT AFTER the bill date: a back-dated bill ignores today\'s rate', async () => {
    const c = await addCustomer(w);
    const p = await piece(w, d.gold22, { nw: '1.000', retail: '1.00' });
    const r = await saved(await postBill(w, 'owner', billBody(c, 'Retail', [item(p, { metal_rate: '6800.00', labour_rate: '1.00' })], { bill_date: '2026-10-12' })));
    expect(r.bill.bill_date).toBe('2026-10-12');
    expect(r.warnings).toEqual(['RATE_STALE']); // 6,800.00 is dated 10 Oct; 6,920.00 is dated 17 Oct, after the bill date
    expect(r.items[0].list_metal_rate).toBe('6800.00');
    const on = await piece(w, d.gold22, { nw: '1.000', retail: '1.00' });
    const same = await saved(await postBill(w, 'owner', billBody(c, 'Retail', [item(on, { metal_rate: '6800.00', labour_rate: '1.00' })], { bill_date: '2026-10-10' })));
    expect(same.warnings).toEqual([]); // dated on the bill date: fresh
  });
});

// ------------------------------------------------------------------ T-A15

describe('T-A15 quote_bill returns exactly what create_bill then stores, for version 1 and a test-only version 2', () => {
  // The same cart through the quote and through the bill; every figure the bill stores is the quote's.
  async function expectBillIsQuote(r: Awaited<ReturnType<typeof saved>>, q: Quote) {
    const stored = await billRow(w, r.bill.id);
    expect(stored).toMatchObject({
      pricing_version: q.pricing_version,
      bill_date: q.bill_date,
      sale_type: q.sale_type,
      subtotal: q.totals.subtotal,
      discount: q.totals.discount,
      additional_charges: q.totals.additional_charges,
      grand_total: q.totals.grand_total,
      round_off: q.totals.round_off,
      fine_weight_due: q.totals.fine_weight_due,
    });
    const lines = await itemRows(w, r.bill.id);
    expect(lines).toHaveLength(q.lines.length);
    q.lines.forEach((l, i) => {
      expect(lines[i], `line ${i + 1}`).toMatchObject({
        line_no: l.line_no,
        sku_id: l.sku_id,
        sku_no: l.sku_no,
        material: l.material,
        purity: l.purity,
        selling_method: l.selling_method,
        customer_net_weight: l.customer_net_weight,
        quantity: l.quantity,
        metal_rate: l.metal_rate,
        labour_rate: l.labour_rate,
        piroi: l.piroi,
        other_charges: l.other_charges,
        labour_amount: l.labour_amount,
        metal_amount: l.metal_amount,
        fine_weight_due: l.fine_weight_due,
        item_total: l.item_total,
        list_metal_rate: q.list_prices[i].list_metal_rate,
        list_labour_rate: q.list_prices[i].list_labour_rate,
      });
    });
    for (const code of q.warnings) expect(r.warnings, 'the warnings of the quote').toContain(code);
  }

  async function mixedCart() {
    const c = await addCustomer(w);
    const ids = {
      gold: await piece(w, d.gold22, { nw: '35.420', gross: '40.000', retail: '353.00', semi: '300.00', wholesale: '250.00' }),
      pp: await piece(w, d.gold24pp, { nw: '5.000', retail: '1000.40' }),
      silver: await piece(w, d.silver999, { nw: '12.345', retail: '9.00', wholesale: '7.00' }),
      missing: await piece(w, d.silver925, { nw: '3.000', retail: '2.00' }),
      stale: await piece(w, d.gold18, { nw: '4.000', retail: '50.00' }),
    };
    const items = [
      item(ids.gold, { metal_rate: '6920.00', labour_rate: '353.00', piroi: '2.15' }),
      item(ids.pp, { metal_rate: '1000.40', quantity: 3, other_charges: '1.10' }),
      item(ids.silver, { metal_rate: '85.00', labour_rate: '7.50' }),
      item(ids.missing, { metal_rate: '80.00', labour_rate: '2.00' }),
      item(ids.stale, { metal_rate: '5800.00', labour_rate: '50.00' }),
    ];
    return { c, items };
  }

  it('version 1: the bill stores every figure of the quote, line by line, list prices and warnings included', async () => {
    for (const sale of ['Retail', 'Wholesale'] as const) {
      const { c, items } = await mixedCart();
      const cart = billBody(c, sale, items, { discount: '12.34', additional_charges: '5.00' });
      const { customer_id: _c, ...quoteCart } = cart;
      const q = body<Quote>(await postQuote(w, 'biller', quoteCart));
      expect(q.pricing_version).toBe(1);
      expect(q.warnings).toEqual(['RATE_MISSING', 'RATE_STALE']);
      const r = await saved(await postBill(w, 'biller', cart));
      await expectBillIsQuote(r, q);
    }
  });

  it('quote_bill sends only plain SELECTs without a lock and leaves every table as it was (the statement log)', async () => {
    const { c, items } = await mixedCart();
    const { customer_id: _c, ...quoteCart } = billBody(c, 'Retail', items);
    const before = await footprint(w);
    const from = w.world.spy.sent.length;
    const res = await postQuote(w, 'owner', quoteCart);
    expect(res.statusCode, res.body).toBe(200);
    const mine = w.world.spy
      .sqls()
      .slice(from)
      .map((s) => s.trim())
      .filter((s) => !/^SET SESSION\b/i.test(s) && !/\bFROM\s+(sessions|users)\b/i.test(s) && !/^UPDATE\s+sessions\b/i.test(s));
    expect(mine.length).toBeGreaterThan(0);
    for (const s of mine) {
      expect(s).toMatch(/^SELECT\b/i);
      expect(s).not.toMatch(/\bFOR\s+UPDATE\b|\bLOCK\s+IN\s+SHARE\s+MODE\b|\bFOR\s+SHARE\b/i);
    }
    expect(await footprint(w)).toEqual(before);
  });

  describe('a test-only version 2, registered through an injected version table', () => {
    // Version 2 rounds a half rupee DOWN instead of up (1,000.50 gives 1,000, not 1,001). It must stay within the +-0.50 the table allows for round_off (chk_bills_round_off), so a rule that rounded
    // further (up to the next rupee) could not be stored by any bill: a real version 2 needs a migration of that CHECK first.
    const priceBillV2 = (input: PriceBillInput): PricedBill => {
      const v1 = priceBill(input);
      const down = Math.floor((v1.beforeRoundPaise + 49) / 100) * 100;
      return { ...v1, pricingVersion: 2, grandTotalPaise: down, roundOffPaise: input.roundOffSetting ? down - v1.beforeRoundPaise : 0 };
    };
    const apps: ReturnType<typeof buildApp>[] = [];
    async function appWith(pricingVersion: number, v2: (input: PriceBillInput) => PricedBill) {
      const app = buildApp({ config: testConfig({ logLevel: 'silent' }), db: createDbPool(w.world.scratch.db), clock: createClock(() => T0), routes: false });
      const versions = { ...PRICING_VERSIONS, 2: v2 };
      registerQuoteBill(app, { versions });
      registerCreateBill(app, { versions, pricingVersion });
      await app.ready();
      apps.push(app);
      return app;
    }
    afterAll(async () => {
      for (const a of apps) await a.close().catch(() => undefined);
    });
    const call = (app: ReturnType<typeof buildApp>, url: string, payload: object, extra: Record<string, string> = {}) =>
      app.inject({ method: 'POST', url, payload, headers: { ...csrfHeaders(), cookie: w.world.cookieOf('owner')!, ...extra } });

    it('the bill made while version 2 is current stores version 2 and the figures quote_bill gives for pricing_version 2; version 1 stays version 1', async () => {
      const app2 = await appWith(2, priceBillV2);
      const app1 = await appWith(1, priceBillV2);
      const c = await addCustomer(w);
      const mine = await piece(w, d.gold24pp, { retail: '1000.50' });
      const cart = billBody(c, 'Retail', [item(mine, { metal_rate: '1000.50' })]); // before_round 1,000.50: version 1 rounds up to 1,001, version 2 down to 1,000
      const { customer_id: _c, ...quoteCart } = cart;
      const q2 = (await call(app2, '/v1/bills/quote', { ...quoteCart, pricing_version: 2 })).json() as Quote;
      expect(q2.pricing_version).toBe(2);
      expect(q2.totals).toMatchObject({ subtotal: '1000.50', grand_total: '1000.00', round_off: '-0.50' });
      const second = await call(app2, '/v1/bills', cart, { 'idempotency-key': newKey() });
      expect(second.statusCode, second.body).toBe(201);
      const r2 = second.json() as Awaited<ReturnType<typeof saved>>;
      expect(r2.bill).toMatchObject({ pricing_version: 2, grand_total: '1000.00', round_off: '-0.50' });
      await expectBillIsQuote(r2, q2);
      // the same cart where version 1 is current: a half rupee goes up
      const one = await piece(w, d.gold24pp, { retail: '1000.50' });
      const first = await call(app1, '/v1/bills', billBody(c, 'Retail', [item(one, { metal_rate: '1000.50' })]), { 'idempotency-key': newKey() });
      expect(first.statusCode, first.body).toBe(201);
      expect((first.json() as Awaited<ReturnType<typeof saved>>).bill).toMatchObject({ pricing_version: 1, grand_total: '1001.00', round_off: '0.50' });
      expect((await billRow(w, r2.bill.id)).pricing_version).toBe(2);
    });

    it('control: a table whose version 2 prices like version 1 is caught by the same comparison (the dispatch can fail)', async () => {
      const same = await appWith(2, (input) => ({ ...priceBill(input), pricingVersion: 2 }));
      const c = await addCustomer(w);
      const p = await piece(w, d.gold24pp, { retail: '1000.50' });
      const res = await call(same, '/v1/bills', billBody(c, 'Retail', [item(p, { metal_rate: '1000.50' })]), { 'idempotency-key': newKey() });
      const r = res.json() as Awaited<ReturnType<typeof saved>>;
      expect(r.bill.pricing_version).toBe(2);
      expect(r.bill.grand_total, 'a dispatch that ignored the rule of version 2 gives the grand total of version 1').toBe('1001.00');
      expect(r.bill.grand_total).not.toBe('1000.00');
    });

    it('a version function that answers another version than the one asked for is a bug (JV_INTERNAL): no bill, no number', async () => {
      const wrong = await appWith(2, priceBill);
      const c = await addCustomer(w);
      const p = await piece(w, d.gold24pp, { retail: '10.00' });
      const before = await footprint(w);
      const res = await call(wrong, '/v1/bills', billBody(c, 'Retail', [item(p, { metal_rate: '10.00' })]), { 'idempotency-key': newKey() });
      expect(res.statusCode).toBe(500);
      expect((res.json() as { error: { code: string } }).error.code).toBe('JV_INTERNAL');
      expect(await footprint(w)).toEqual(before);
    });

    it('the application\'s own route cannot be told to price another version: the body has no pricing_version, and the table holds version 1 alone', async () => {
      expect(Object.keys(PRICING_VERSIONS)).toEqual(['1']);
      const c = await addCustomer(w);
      const p = await piece(w, d.gold24pp, { retail: '10.00' });
      await refused(billBody(c, 'Retail', [item(p, { metal_rate: '10.00' })], { pricing_version: 2 }), 'pricing_version');
    });
  });
});

// ------------------------------------------------------------------ T-C08, R10

describe('T-C08 the pieces that may be billed (R10, K2)', () => {
  const NEVER = ['Repair', 'Missing', 'Damaged', 'Archived', 'Transferred', 'Returned'] as const;

  for (const status of NEVER) {
    it(`a ${status} piece cannot be billed: 409 JV_PIECE_UNAVAILABLE naming it, and nothing changes`, async () => {
      const c = await addCustomer(w);
      const p = await piece(w, d.gold24pp, { retail: '10.00', status });
      const good = await piece(w, d.gold24pp, { retail: '10.00' });
      const before = await footprint(w);
      const res = await postBill(w, 'biller', billBody(c, 'Retail', [item(good, { metal_rate: '10.00' }), item(p, { metal_rate: '10.00' })]));
      expect(res.statusCode, res.body).toBe(409);
      expect(codeOf(res)).toBe('JV_PIECE_UNAVAILABLE');
      const e = body(res).error;
      expect(e.details.sku_ids).toEqual([p]);
      const [{ sku_no }] = await rows(w, 'SELECT sku_no FROM skus WHERE id = ?', [p]);
      expect(e.message).toContain(sku_no);
      expect(e.message).toContain(status);
      expect(await footprint(w)).toEqual(before);
      expect((await pieceRow(w, p)).status).toBe(status);
      expect((await pieceRow(w, good)).status, 'the good piece of the same bill is not sold either').toBe('In Stock');
    });

    it(`a ${status} piece in the confirm list is still not billable`, async () => {
      const c = await addCustomer(w);
      const p = await piece(w, d.gold24pp, { retail: '10.00', status });
      const res = await postBill(w, 'owner', billBody(c, 'Retail', [item(p, { metal_rate: '10.00' })], { confirm_held: [p] }));
      expect(res.statusCode).toBe(409);
      expect(codeOf(res)).toBe('JV_PIECE_UNAVAILABLE');
    });
  }

  it('a Sold piece (on an active bill) cannot be billed again, and the first bill is untouched', async () => {
    const c1 = await addCustomer(w);
    const c2 = await addCustomer(w);
    const p = await piece(w, d.gold24pp, { retail: '10.00' });
    const first = await saved(await postBill(w, 'owner', billBody(c1, 'Retail', [item(p, { metal_rate: '10.00' })])));
    const before = await footprint(w);
    const res = await postBill(w, 'biller', billBody(c2, 'Retail', [item(p, { metal_rate: '10.00' })]));
    expect(res.statusCode, res.body).toBe(409);
    expect(codeOf(res)).toBe('JV_PIECE_UNAVAILABLE');
    expect(body(res).error.details.sku_ids).toEqual([p]);
    expect(await footprint(w)).toEqual(before);
    expect(await pieceRow(w, p)).toMatchObject({ status: 'Sold', sold_bill_id: first.bill.id });
    // the same customer, the same piece: the same answer
    const again = await postBill(w, 'owner', billBody(c1, 'Retail', [item(p, { metal_rate: '10.00' })]));
    expect(again.statusCode).toBe(409);
  });

  for (const status of ['Reserved', 'On Approval'] as const) {
    it(`a ${status} piece is billed only when its id is in the confirm list, and then it is Sold`, async () => {
      const c = await addCustomer(w);
      const p = await piece(w, d.gold24pp, { retail: '10.00', status });
      const cart = (extra: Body = {}) => billBody(c, 'Retail', [item(p, { metal_rate: '10.00' })], extra);
      const before = await footprint(w);
      const no = await postBill(w, 'biller', cart());
      expect(no.statusCode, no.body).toBe(409);
      expect(codeOf(no)).toBe('JV_PIECE_UNAVAILABLE');
      expect(body(no).error.details.sku_ids).toEqual([p]);
      const other = await postBill(w, 'biller', cart({ confirm_held: [] }));
      expect(other.statusCode).toBe(409);
      expect(await footprint(w)).toEqual(before);
      const yes = await saved(await postBill(w, 'biller', cart({ confirm_held: [p] })));
      expect(await pieceRow(w, p)).toMatchObject({ status: 'Sold', sold_bill_id: yes.bill.id });
    });
  }

  it('every unavailable piece of a bill is named, in the order of the lines, and a good piece beside them stays In Stock', async () => {
    const c = await addCustomer(w);
    const good = await piece(w, d.gold24pp, { retail: '10.00' });
    const repair = await piece(w, d.gold24pp, { retail: '10.00', status: 'Repair' });
    const held = await piece(w, d.gold24pp, { retail: '10.00', status: 'Reserved' });
    const missing = await piece(w, d.gold24pp, { retail: '10.00', status: 'Missing' });
    const res = await postBill(w, 'owner', billBody(c, 'Retail', [missing, good, held, repair].map((id) => item(id, { metal_rate: '10.00' }))));
    expect(res.statusCode).toBe(409);
    expect(body(res).error.details.sku_ids).toEqual([missing, held, repair]);
    expect((await pieceRow(w, good)).status).toBe('In Stock');
  });

  it('a held piece and an available one in one bill: the confirm list lets the held one through, the other needs no confirmation', async () => {
    const c = await addCustomer(w);
    const held = await piece(w, d.gold24pp, { retail: '10.00', status: 'On Approval' });
    const stock = await piece(w, d.gold24pp, { retail: '10.00' });
    const r = await saved(await postBill(w, 'owner', billBody(c, 'Retail', [stock, held].map((id) => item(id, { metal_rate: '10.00' })), { confirm_held: [held, stock] })));
    expect(r.items).toHaveLength(2);
    expect((await pieceRow(w, held)).status).toBe('Sold');
    expect((await pieceRow(w, stock)).status).toBe('Sold');
  });

  it('the confirm list may only name pieces of the bill, and each once', async () => {
    const c = await addCustomer(w);
    const p = await piece(w, d.gold24pp, { retail: '10.00', status: 'Reserved' });
    const stranger = await piece(w, d.gold24pp, { retail: '10.00', status: 'Reserved' });
    await refused(billBody(c, 'Retail', [item(p, { metal_rate: '10.00' })], { confirm_held: [p, stranger] }), 'confirm_held[1]');
    await refused(billBody(c, 'Retail', [item(p, { metal_rate: '10.00' })], { confirm_held: [p, p] }), 'confirm_held[1]');
    await refused(billBody(c, 'Retail', [item(p, { metal_rate: '10.00' })], { confirm_held: ['not-a-uuid'] }), 'confirm_held[0]');
    expect((await pieceRow(w, stranger)).status).toBe('Reserved');
  });

  it('a piece that does not exist is a refusal of that line (422), not a 409 and not a foreign-key error', async () => {
    const c = await addCustomer(w);
    const good = await piece(w, d.gold24pp, { retail: '10.00' });
    await refused(billBody(c, 'Retail', [item(good, { metal_rate: '10.00' }), item(newKey(), { metal_rate: '10.00' })]), 'items[1].sku_id');
    expect((await pieceRow(w, good)).status).toBe('In Stock');
  });
});

// ------------------------------------------------------------------ the customer

describe('X1 (b) the customer must exist and not be archived (JV_CUSTOMER_ARCHIVED)', () => {
  it('an archived customer is 409 JV_CUSTOMER_ARCHIVED, and no number is used and no piece is sold', async () => {
    const c = await addCustomer(w, { archived_at: '2026-09-01 12:00:00.000000' });
    const p = await piece(w, d.gold24pp, { retail: '10.00' });
    const before = await footprint(w);
    const res = await postBill(w, 'owner', billBody(c, 'Retail', [item(p, { metal_rate: '10.00' })]));
    expect(res.statusCode, res.body).toBe(409);
    expect(codeOf(res)).toBe('JV_CUSTOMER_ARCHIVED');
    expect(await footprint(w)).toEqual(before);
    expect((await pieceRow(w, p)).status).toBe('In Stock');
  });

  it('a customer id that is no customer is a refusal of customer_id (422), and the walk-in customer can be billed', async () => {
    const p = await piece(w, d.gold24pp, { retail: '10.00' });
    await refused(billBody(newKey(), 'Retail', [item(p, { metal_rate: '10.00' })]), 'customer_id');
    await refused(billBody('not-a-uuid', 'Retail', [item(p, { metal_rate: '10.00' })]), 'customer_id');
    const r = await saved(await postBill(w, 'biller', billBody(WALKIN, 'Retail', [item(p, { metal_rate: '10.00' })])));
    expect(r.bill.customer_id).toBe(WALKIN);
    expect(r.warnings).toEqual([]); // the walk-in is never asked for a PAN (D10)
  });
});

describe('Z3 a bill of the PAN threshold or more for a named customer without a PAN saves with PAN_MISSING', () => {
  const pp = (price: string) => piece(w, d.gold24pp, { retail: price });
  it('199,999.00 gives no warning, 200,000.00 gives PAN_MISSING, and a customer with a PAN is never asked', async () => {
    const c = await addCustomer(w);
    const below = await saved(await postBill(w, 'biller', billBody(c, 'Retail', [item(await pp('199999.00'), { metal_rate: '199999.00' })])));
    expect(below.warnings).toEqual([]);
    const at = await saved(await postBill(w, 'biller', billBody(c, 'Retail', [item(await pp('200000.00'), { metal_rate: '200000.00' })])));
    expect(at.warnings).toEqual(['PAN_MISSING']);
    expect(at.bill.grand_total).toBe('200000.00');
    const withPan = await addCustomer(w, { pan: 'ABCDE1234F' });
    const ok = await saved(await postBill(w, 'biller', billBody(withPan, 'Retail', [item(await pp('300000.00'), { metal_rate: '300000.00' })])));
    expect(ok.warnings).toEqual([]);
  });

  it('PAN_MISSING comes with the rate warnings, sorted', async () => {
    const c = await addCustomer(w);
    const big = await piece(w, d.silver925, { nw: '1.000', retail: '1.00' });
    const r = await saved(await postBill(w, 'owner', billBody(c, 'Retail', [item(big, { metal_rate: '300000.00', labour_rate: '1.00' })])));
    expect(r.warnings).toEqual(['PAN_MISSING', 'RATE_MISSING']);
  });
});

// ------------------------------------------------------------------ Y8

describe('Y8 dates: a biller uses today only, the owner any date up to today, a future date is refused', () => {
  it('bill_date null or absent is today; the owner may back-date; the biller may not; nobody may post-date', async () => {
    const c = await addCustomer(w);
    const fresh = async () => item(await piece(w, d.gold24pp, { retail: '10.00' }), { metal_rate: '10.00' });
    const mk = async (extra: Body) => billBody(c, 'Retail', [await fresh()], extra);
    expect((await saved(await postBill(w, 'biller', await mk({})))).bill.bill_date).toBe(TODAY);
    expect((await saved(await postBill(w, 'biller', await mk({ bill_date: null })))).bill.bill_date).toBe(TODAY);
    expect((await saved(await postBill(w, 'biller', await mk({ bill_date: TODAY })))).bill.bill_date).toBe(TODAY);
    expect((await saved(await postBill(w, 'owner', await mk({ bill_date: '2026-10-16' })))).bill.bill_date).toBe('2026-10-16');
    expect((await saved(await postBill(w, 'owner', await mk({ bill_date: '2020-01-01' })))).bill.bill_date).toBe('2020-01-01');
    await refused(await mk({ bill_date: '2026-10-16' }), 'bill_date', 'biller');
    await refused(await mk({ bill_date: '2026-10-18' }), 'bill_date', 'biller');
    await refused(await mk({ bill_date: '2026-10-18' }), 'bill_date', 'owner');
    await refused(await mk({ bill_date: '2026-02-30' }), 'bill_date', 'owner');
    await refused(await mk({ bill_date: '17-10-2026' }), 'bill_date', 'owner');
  });
});

// ------------------------------------------------------------------ T-A09

describe('T-A09 bill and line inputs through create_bill: refused with JV_INVALID_INPUT, and no row is made', () => {
  let c: string;
  let byWeight: string;
  let perPiece: string;
  beforeAll(async () => {
    c = await addCustomer(w);
    byWeight = await piece(w, d.gold22, { nw: '10.000', retail: '353.00' });
    perPiece = await piece(w, d.gold24pp, { nw: '5.000', retail: '1200.00' });
  });
  const base = (o: Body = {}) => item(byWeight, { metal_rate: '6920.00', labour_rate: '353.00', ...o });
  const cart = (items: Item[], extra: Body = {}) => billBody(c, 'Retail', items, extra);

  type Item = ReturnType<typeof item>;
  const badMoney = (cap: string): [string, unknown][] => [
    ['negative', '-1.00'],
    ['over the cap', cap],
    ['three decimals', '1.234'],
    ['a trailing zero counts: 1.230', '1.230'],
    ['a JSON number', 5],
    ['.5', '.5'],
    ['5.', '5.'],
    ['spaces around', ' 7.50 '],
    ['a plus sign', '+5'],
    ['empty', ''],
  ];

  for (const [field, cap] of [['metal_rate', '100000000.01'], ['labour_rate', '100000000.01'], ['piroi', '1000000000.01'], ['other_charges', '1000000000.01']] as const) {
    it(`items[].${field}: ${badMoney(cap).map(([n]) => n).join(', ')}`, async () => {
      for (const [name, value] of badMoney(cap)) {
        const e = await refused(cart([base({ [field]: value })]), `items[0].${field}`);
        if (typeof value === 'string' && value.trim() !== '' && value !== '.5' && value !== '5.') expect(e.message, `${field} ${name}: the message repeats the value`).not.toContain(value.trim());
      }
    });
  }

  it('items[].quantity: 0, -1, 1,001, 1.5, the text "2" and null are refused; 1,000 is the largest', async () => {
    for (const q of [0, -1, 1001, 1.5, '2', null]) await refused(cart([item(perPiece, { metal_rate: '1.00', quantity: q })]), 'items[0].quantity');
    const r = await saved(await postBill(w, 'owner', cart([item(await piece(w, d.gold24pp, { retail: '1.00' }), { metal_rate: '1.00', quantity: 1000 })])));
    expect(r.items[0]).toMatchObject({ quantity: 1000, item_total: '1000.00' });
  });

  for (const field of ['discount', 'additional_charges'] as const) {
    it(`${field}: negative, over the cap, three decimals, a trailing zero and a JSON number are refused`, async () => {
      for (const [, value] of badMoney('1000000000.01').slice(0, 5)) await refused(cart([base()], { [field]: value }), field);
    });
  }

  it('a weight cannot be sent: customer_net_weight, gross_weight and weight are unknown fields of a line', async () => {
    for (const f of ['customer_net_weight', 'gross_weight', 'weight']) await refused(cart([base({ [f]: '1.000' })]), `items[0].${f}`);
  });

  it('a By Weight line without labour_rate is refused; a Per Piece line does not need one', async () => {
    await refused(cart([item(byWeight, { metal_rate: '6920.00' })]), 'items[0].labour_rate');
    const r = await saved(await postBill(w, 'owner', cart([item(await piece(w, d.gold24pp, { retail: '1.00' }), { metal_rate: '1.00' })])));
    expect(r.items[0].labour_rate).toBe('0.00');
  });

  it('the same piece twice in one bill is JV_INVALID_INPUT (X1 (a)), not the raw duplicate-key error of the UNIQUE (bill_id, sku_id)', async () => {
    const p = await piece(w, d.gold24pp, { retail: '10.00' });
    const other = await piece(w, d.gold24pp, { retail: '10.00' });
    const key = newKey();
    const before = await footprint(w);
    const res = await postBill(w, 'owner', cart([item(p, { metal_rate: '10.00' }), item(other, { metal_rate: '10.00' }), item(p, { metal_rate: '10.00' })]), key);
    expect(res.statusCode, res.body).toBe(422);
    expect(codeOf(res)).toBe('JV_INVALID_INPUT');
    expect(errorField(res)).toBe('items[2].sku_id');
    expect(await footprint(w)).toEqual(before);
    expect((await pieceRow(w, p)).status).toBe('In Stock');
    // the key is not used up: the corrected bill goes through with it
    const fixed = await postBill(w, 'owner', cart([item(p, { metal_rate: '10.00' }), item(other, { metal_rate: '10.00' })]), key);
    expect(fixed.statusCode, fixed.body).toBe(201);
  });

  it('the lines: none, 201, not a list; an unknown field anywhere; a missing customer; not an object', async () => {
    await refused(cart([]), 'items');
    await refused({ customer_id: c, sale_type: 'Retail' }, 'items');
    await refused({ customer_id: c, sale_type: 'Retail', items: base() }, 'items');
    await refused(cart(Array.from({ length: 201 }, () => base())), 'items');
    await refused(cart([base({ extra: 1 })]), 'items[0].extra');
    await refused(cart([base()], { surprise: 1 }), 'surprise');
    await refused({ sale_type: 'Retail', items: [base()] }, 'customer_id');
    await refused(cart([base()], { amount: '1.00' }), 'amount'); // money fields of the books are never inputs (API06)
    await refused(cart([base()], { grand_total: '1.00' }), 'grand_total');
    await refused(cart([base()], { round_off: '0.00' }), 'round_off');
    const notAnObject = await w.world.call('owner', 'POST', '/v1/bills', { payload: JSON.stringify('not an object'), headers: { 'content-type': 'application/json', 'idempotency-key': newKey() } });
    expect(notAnObject.statusCode).toBe(422);
    expect(codeOf(notAnObject)).toBe('JV_INVALID_INPUT');
  });

  describe('the payment rows (Y2): the shape is checked here, the receipts are API22\'s', () => {
    const pay = (row: Body) => cart([base()], { payments: [row] });
    it('a well-formed payment is refused for now (JV_NOT_ALLOWED) and nothing is saved, rather than a bill saved without its money; an empty list is no payment', async () => {
      const before = await footprint(w);
      const res = await postBill(w, 'owner', cart([base()], { payments: [{ mode: 'UPI', amount: '10.00', reference: 'ref-1' }] }));
      expect(res.statusCode, res.body).toBe(409);
      expect(codeOf(res)).toBe('JV_NOT_ALLOWED');
      expect(body(res).error.details.field).toBe('payments');
      expect(await footprint(w)).toEqual(before);
      const ok = await postBill(w, 'owner', cart([item(await piece(w, d.gold24pp, { retail: '1.00' }), { metal_rate: '1.00' })], { payments: [] }));
      expect(ok.statusCode, ok.body).toBe(201);
      expect(body(ok).receipts).toEqual([]);
    });
    it('the mode Credit does not exist (D13), nor any other word', async () => {
      for (const mode of ['Credit', 'cash', 'Cheque', '', 5, null]) await refused(pay({ mode, amount: '10.00' }), 'payments[0].mode');
      await refused(pay({ amount: '10.00' }), 'payments[0].mode');
    });
    it('an amount is plain money text above 0 and within the cap; a reference is at most 120 characters', async () => {
      for (const amount of ['0', '0.00', '-1.00', '1.234', 10, '1000000000.01', '.5', ' 7.50 ']) await refused(pay({ mode: 'Cash', amount }), 'payments[0].amount');
      await refused(pay({ mode: 'Cash' }), 'payments[0].amount');
      await refused(pay({ mode: 'UPI', amount: '10.00', reference: 'r'.repeat(121) }), 'payments[0].reference');
      await refused(pay({ mode: 'UPI', amount: '10.00', extra: 1 }), 'payments[0].extra');
      await refused(cart([base()], { payments: 'Cash' }), 'payments');
      await refused(cart([base()], { payments: Array.from({ length: 11 }, () => ({ mode: 'Cash', amount: '1.00' })) }), 'payments');
    });
  });
});

// ------------------------------------------------------------------ T-D03, T-D09

describe('T-D03 no result of create_bill or quote_bill holds the original weight', () => {
  it('a piece with an owner-only weight: neither the answer, the stored result, the bill lines nor any statement of the call touch it (biller and owner)', async () => {
    for (const caller of ['biller', 'owner'] as const) {
      const c = await addCustomer(w);
      const p = await piece(w, d.gold22, { nw: '12.345', retail: '10.00' });
      await insert(w.world.sql, 'sku_private', V.skuPrivate(p, { original_net_weight: '98.765' }));
      const from = w.world.spy.sent.length;
      const key = newKey();
      const res = await postBill(w, caller, billBody(c, 'Retail', [item(p, { metal_rate: '6920.00', labour_rate: '10.00' })]), key);
      expect(res.statusCode, res.body).toBe(201);
      expect(res.body).not.toContain('98.765');
      expect(res.body).not.toContain('original_net_weight');
      const sqls = w.world.spy.sqls().slice(from);
      expect(sqls.some((s) => /sku_private|original_net_weight/i.test(s)), 'a statement of create_bill read the owner-only weight').toBe(false);
      const [claim] = await rows(w, 'SELECT result FROM sys_idempotency WHERE request_id = ?', [key]);
      expect(JSON.stringify(claim.result)).not.toContain('98.765');
      expect(JSON.stringify(await itemRows(w, body(res).bill.id))).not.toContain('98.765');
      const { customer_id: _c, ...quoteCart } = billBody(c, 'Retail', [item(p, { metal_rate: '6920.00', labour_rate: '10.00' })]);
      const quote = await postQuote(w, caller, quoteCart);
      expect(quote.body).not.toContain('98.765');
      expect(quote.body).not.toContain('original_net_weight');
    }
  });
});

describe('T-D09 the matrix row of X1 (POST /v1/bills: owner and biller) and its field rules', () => {
  it('the route is registered through route() with the action of the row', () => {
    expect(w.world.app.routeTable.find((r) => r.action === 'fn:create_bill')).toMatchObject({ method: 'POST', url: '/v1/bills', kind: 'matrix', roles: ['owner', 'biller'], mustChange: false });
  });

  it('no session is 401, staff is 403 JV_FORBIDDEN, a user who must change the password is 403 JV_PASSWORD_CHANGE_REQUIRED, and none of them reads a piece, a customer or a counter', async () => {
    for (const [caller, status, code] of [['anon', 401, 'JV_UNAUTHENTICATED'], ['ended', 401, 'JV_UNAUTHENTICATED'], ['expired', 401, 'JV_SESSION_EXPIRED'], ['idle', 401, 'JV_SESSION_EXPIRED'], ['inactive', 401, 'JV_UNAUTHENTICATED'], ['staff', 403, 'JV_FORBIDDEN'], ['must_change', 403, 'JV_PASSWORD_CHANGE_REQUIRED']] as const) {
      const c = await addCustomer(w);
      const p = await piece(w, d.gold24pp, { retail: '10.00' });
      const from = w.world.spy.sent.length;
      const res = await postBill(w, caller, billBody(c, 'Retail', [item(p, { metal_rate: '10.00' })]));
      expect(res.statusCode, caller).toBe(status);
      expect(codeOf(res), caller).toBe(code);
      await w.world.restore(caller);
      expect(w.world.spy.sqls().slice(from).some((s) => /\bFROM\s+(skus|customers|bills|sys_counters|sys_idempotency|settings)\b/i.test(s) || /^INSERT\b/i.test(s.trim())), `${caller} caused a read or write of the books`).toBe(false);
      expect((await pieceRow(w, p)).status).toBe('In Stock');
    }
  });

  it('the owner and the biller are let in', async () => {
    for (const caller of ['owner', 'biller'] as const) {
      const c = await addCustomer(w);
      const p = await piece(w, d.gold24pp, { retail: '10.00' });
      const res = await postBill(w, caller, billBody(c, 'Retail', [item(p, { metal_rate: '10.00' })]));
      expect(res.statusCode, `${caller}: ${res.body}`).toBe(201);
      expect(body(res).bill.created_by).toBe(w.world.fixtures[caller].userId);
    }
  });

  it('a biller\'s cash_override_reason is 403 JV_FORBIDDEN naming the field (the owner\'s right, Z1) and nothing is saved; the claim is rolled back so the key stays unused', async () => {
    const c = await addCustomer(w);
    const p = await piece(w, d.gold24pp, { retail: '10.00' });
    const key = newKey();
    const cart = billBody(c, 'Retail', [item(p, { metal_rate: '10.00' })], { cash_override_reason: 'customer paid in cash by ten people' });
    const before = await footprint(w);
    const res = await postBill(w, 'biller', cart, key);
    expect(res.statusCode, res.body).toBe(403);
    expect(codeOf(res)).toBe('JV_FORBIDDEN');
    expect(body(res).error.details.field).toBe('cash_override_reason');
    expect(await footprint(w)).toEqual(before);
    // the owner may send it (the cash rules that use it are API23's); a reason under 10 characters or over 500 is refused for everybody
    const ok = await postBill(w, 'owner', cart, key);
    expect(ok.statusCode, ok.body).toBe(201);
    await refused(billBody(c, 'Retail', [item(await piece(w, d.gold24pp, { retail: '10.00' }), { metal_rate: '10.00' })], { cash_override_reason: 'too short' }), 'cash_override_reason');
    await refused(billBody(c, 'Retail', [item(await piece(w, d.gold24pp, { retail: '10.00' }), { metal_rate: '10.00' })], { cash_override_reason: 'x'.repeat(501) }), 'cash_override_reason');
  });

  it('a past date from a biller is JV_INVALID_INPUT, from the owner it is saved', async () => {
    const c = await addCustomer(w);
    const mk = async () => billBody(c, 'Retail', [item(await piece(w, d.gold24pp, { retail: '10.00' }), { metal_rate: '10.00' })], { bill_date: '2026-10-15' });
    await refused(await mk(), 'bill_date', 'biller');
    expect((await saved(await postBill(w, 'owner', await mk()))).bill.bill_date).toBe('2026-10-15');
  });
});

// ------------------------------------------------------------------ X0

describe('X0 the order of X1: claim, role check, customer lock, state read, the pieces in one statement, plain reads, the counter last, then the writes', () => {
  const noise = (s: string) => /^(SET|COMMIT|ROLLBACK|START)\b/i.test(s.trim()) || /\bFROM\s+(sessions|users)\b/i.test(s) || /^UPDATE\s+sessions\b/i.test(s.trim());

  it('the statements of one bill come in the order of X0 and nothing locks after the counter', async () => {
    await setEstimate(w, { prefix: 'XZ', roundOff: true });
    const c = await addCustomer(w);
    const ids = [await piece(w, d.gold22, { nw: '2.000', retail: '10.00' }), await piece(w, d.gold24pp, { retail: '10.00' })];
    const from = w.world.spy.sent.length;
    const res = await postBill(w, 'biller', billBody(c, 'Retail', ids.map((id) => item(id, { metal_rate: '10.00', labour_rate: '10.00' }))));
    expect(res.statusCode, res.body).toBe(201);
    const sqls = w.world.spy.sqls().slice(from).filter((s) => !noise(s)).map((s) => s.replace(/\s+/g, ' ').trim());
    const at = (re: RegExp, nth = 0) => {
      const found = sqls.map((s, i) => [s, i] as const).filter(([s]) => re.test(s));
      if (found.length <= nth) throw new Error(`no statement ${re} (${sqls.join(' | ')})`);
      return found[nth][1];
    };
    const claim = at(/^INSERT INTO sys_idempotency\b/);
    const readBack = at(/FROM sys_idempotency WHERE request_id = \? FOR UPDATE/);
    const customer = at(/FROM customers WHERE id = \? FOR UPDATE/);
    const pieces = at(/FROM skus WHERE id IN \([?, ]+\) ORDER BY id FOR UPDATE/);
    const counter = at(/^UPDATE sys_counters SET last_value = LAST_INSERT_ID\(last_value \+ 1\) WHERE series = \?/);
    const insertBill = at(/^INSERT INTO bills\b/);
    const insertLines = at(/^INSERT INTO bill_items\b/);
    const sold = at(/^UPDATE skus SET status = \?/);
    const store = at(/^UPDATE sys_idempotency SET result = \?/);
    expect(sqls.slice(0, 3).some((s) => /\bsettings\b/.test(s) || /sys_counters/.test(s)), 'the prefix and the series row are read BEFORE the transaction').toBe(true);
    expect(claim, 'the claim is the first statement of the transaction').toBe(Math.min(...sqls.map((s, i) => (/^INSERT INTO sys_idempotency\b/.test(s) ? i : 1e9))));
    expect(readBack).toBe(claim + 1);
    expect(customer, 'the customer row is locked right after the claim').toBe(readBack + 1);
    expect(pieces).toBeGreaterThan(customer);
    expect(counter, 'the counter is taken after every check and after the pieces').toBeGreaterThan(pieces);
    expect(insertBill).toBeGreaterThan(counter);
    expect(insertLines).toBeGreaterThan(insertBill);
    expect(sold).toBeGreaterThan(insertLines);
    expect(store).toBeGreaterThan(sold);
    // the plain reads of the checks are all before the counter; the counter is followed by the look-ahead read and the writes only
    expect(sqls.filter((s) => /FROM skus WHERE id IN .* FOR UPDATE/.test(s)), 'the pieces are locked by ONE statement').toHaveLength(1);
    expect(sqls.filter((s) => /^UPDATE sys_counters/.test(s)), 'one number was taken').toHaveLength(1);
    expect(sqls.slice(counter + 1).filter((s) => /FOR UPDATE/.test(s)), 'no lock is taken after the counter').toEqual([]);
    for (const re of [/FROM designs\b/, /FROM daily_rates\b/, /FROM settings\b/]) expect(at(re, re.source.includes('settings') ? 1 : 0), re.source).toBeLessThan(counter);
    // the writes come after the counter and the look-ahead
    const writes = sqls.map((s, i) => [s, i] as const).filter(([s]) => /^(INSERT INTO (bills|bill_items)|UPDATE (skus|customers))\b/.test(s));
    expect(writes.length).toBeGreaterThanOrEqual(4);
    expect(Math.min(...writes.map(([, i]) => i))).toBeGreaterThan(counter);
    await setEstimate(w, { prefix: 'JV', roundOff: true });
  });

  it('the state of the customer is read ONCE, through the module, at the point create_bill.after_read (the hook of X0 item 8 is the test build\'s)', async () => {
    const gates = Gates.install();
    try {
      const c = await addCustomer(w);
      const p = await piece(w, d.gold24pp, { retail: '10.00' });
      const gate = gates.forNextSession();
      const call = postBill(w, 'owner', billBody(c, 'Retail', [item(p, { metal_rate: '10.00' })]));
      expect(await Promise.race([gate.reached, call.then((r) => `the call ended with ${r.statusCode} before it read the state`)])).toBe('create_bill.after_read');
      gate.release();
      const res = await call;
      expect(res.statusCode, res.body).toBe(201);
      expect(gates.points.filter((x) => x.point === 'create_bill.after_read')).toHaveLength(1);
      expect(gates.points.filter((x) => x.point.startsWith('create_bill'))).toHaveLength(1);
    } finally {
      gates.restore();
    }
  });

  it('the bill prefix is read again inside the transaction: a prefix changed in between is JV_BUSY (series_changed), and nothing is saved', async () => {
    await setEstimate(w, { prefix: 'PA', roundOff: true });
    const c = await addCustomer(w);
    const p = await piece(w, d.gold24pp, { retail: '10.00' });
    const before = await footprint(w);
    let fired = false;
    w.world.spy.intercept = async (e) => {
      if (!fired && /^INSERT INTO sys_idempotency\b/.test(e.sql)) {
        fired = true;
        await setEstimate(w, { prefix: 'PB', roundOff: true }); // another session saves the settings between the read of the prefix and the transaction
      }
    };
    try {
      const res = await postBill(w, 'owner', billBody(c, 'Retail', [item(p, { metal_rate: '10.00' })]));
      expect(fired).toBe(true);
      expect(res.statusCode, res.body).toBe(503);
      expect(codeOf(res)).toBe('JV_BUSY');
      expect(res.headers['retry-after']).toBe('1');
    } finally {
      w.world.spy.intercept = null;
    }
    expect(await footprint(w)).toEqual(before);
    expect((await pieceRow(w, p)).status).toBe('In Stock');
    // the retry reads the new prefix and goes through
    const retry = await saved(await postBill(w, 'owner', billBody(c, 'Retail', [item(p, { metal_rate: '10.00' })])));
    expect(retry.bill.bill_no).toBe('PB-2026-0001');
    await setEstimate(w, { prefix: 'JV', roundOff: true });
  });

  it('the bill number, a piece id and a customer id are the only things in the answer that name rows; the request id of the call is the one in the audit trail and the response header', async () => {
    const c = await addCustomer(w);
    const p = await piece(w, d.gold24pp, { retail: '10.00' });
    const res = await postBill(w, 'owner', billBody(c, 'Retail', [item(p, { metal_rate: '10.00' })]));
    expect(requestIdOf(res)).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['idempotent-replay']).toBeUndefined();
  });
});
