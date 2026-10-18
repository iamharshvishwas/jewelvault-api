import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { previousDay, runNightlyCheck } from '../../src/jobs/nightly';
import { limits } from '../../src/limits';
import { V, insert } from '../schema/support';
import { postRate } from './edit-13b-support';
import { type NightlyWorld, nightlyWorld } from './nightly-support';
import { cancelBill, voidReceipt } from './x04-support';
import { type EditWorld, addBill, addCancelledBill, addMoney, newKey, pay, paid } from './x02-support';
import { cashFine, settle, settled } from './x03-support';
import { type Designs, addCustomer, addDesigns, addRate, billBody, billRow, editWorld, item, itemRows, piece, postBill, saved } from './x01-support';

// T-B24 (API32, spec I11, R14, D12, O26, Z1, Z2): the review line. For the previous business day the nightly check lists, and counts in check_runs.details, the lines sold below the server's list
// prices, the bills with a discount above 10 percent of the subtotal, the bills and receipts saved with a cash override reason, the cancellations, re-issues, voids and refunds, the walk-in's cash
// total and number of bills, the fine_cash settlements more than 5 percent from every Silver rate of the day, the daily rates a biller entered that moved more than 5 percent, and the bills whose sale
// type differs from the customer's. It is a report: nothing here turns the check red.
//
// The world is the scratch database of the other money tests (real routes, seeds, a clock fixed at 17 Oct 2026 10:00 UTC = 15:30 in Kolkata, so every bill and payment made through the routes is
// dated 2026-10-17). The nightly run is told it is 2026-10-18, so the day under review is 2026-10-17. Rates for the day are typed in; bills, payments, settlements, cancels, voids and the biller's
// rates go through the routes (the list prices are the server's own), refunds and re-issues (their functions come later) are typed in.

const TODAY = '2026-10-17';
const RUN_DATE = '2026-10-18';

let nw: NightlyWorld;
let w: EditWorld;
let d: Designs;

/** What the routes saved: the bill numbers the lists must name. */
const no: Record<string, string> = {};
const ids: Record<string, string> = {};

async function sell(name: string, caller: 'owner' | 'biller', customer: string, saleType: string, items: ReturnType<typeof item>[], extra: Record<string, unknown> = {}) {
  const res = await postBill(w, caller, billBody(customer, saleType, items, extra), newKey());
  const out = await saved(res);
  no[name] = out.bill.bill_no;
  ids[name] = out.bill.id;
  return out;
}

beforeAll(async () => {
  nw = await nightlyWorld('nightrev');
  w = nw.w;
  d = await addDesigns(w);
  const batch = randomUUID();
  await insert(w.world.sql, 'sys_import_batches', { id: batch, name: `rev-${batch}` }); // typed-in bills are imported ones: the number series (I5) leaves them alone

  // the day's rates (R2), typed in: they are the list prices of the day
  await addRate(w, 'Gold', '22K', '6000.00', TODAY);
  await addRate(w, 'Silver', '999', '75.00', TODAY);
  await addRate(w, 'Silver', '925', '70.00', TODAY);
  // rates for the biller's moves: the previous rate of a material and purity is the latest one BEFORE the day, not the oldest
  await addRate(w, 'Gold', '18K', '1.00', '2026-10-10');
  await addRate(w, 'Gold', '18K', '4000.00', '2026-10-16');
  await addRate(w, 'Gold', '20K', '5000.00', '2026-10-16');
  await addRate(w, 'Gold', '24K', '6500.00', '2026-10-16');
  await addRate(w, 'Gold', '12K', '1000.00', '2026-10-16');

  const retail1 = await addCustomer(w);
  const retail2 = await addCustomer(w);
  const wholesale1 = await addCustomer(w, { customer_type: 'Wholesale' });
  const big = await addCustomer(w);
  const big2 = await addCustomer(w);
  const payer = await addCustomer(w);
  const refunded = await addCustomer(w);
  const reissuer = await addCustomer(w);

  const g22 = () => piece(w, d.gold22, { nw: '10.000', retail: '100.00', semi: '100.00', wholesale: '100.00' });
  const pp = (price: string) => piece(w, d.gold24pp, { retail: price, semi: price, wholesale: price });

  // R14: the list price is the server's. A client that sends one is refused (the item has no such key), so the line below is judged against the daily rate and the piece, not against anything it sent
  const refused = await postBill(w, 'biller', billBody(retail1, 'Retail', [item(await g22(), { metal_rate: '5000.00', labour_rate: '100.00', list_metal_rate: '1.00' })]), newKey());
  expect(refused.statusCode, refused.body).toBe(422);

  // lines sold below list: the metal rate, then the labour rate; a line at list or above is not
  await sell('below_metal', 'biller', retail1, 'Retail', [item(await g22(), { metal_rate: '5900.00', labour_rate: '100.00' })]);
  await sell('below_labour', 'biller', retail1, 'Retail', [item(await g22(), { metal_rate: '6000.00', labour_rate: '90.00' })]);
  await sell('at_list', 'biller', retail1, 'Retail', [item(await g22(), { metal_rate: '6000.00', labour_rate: '100.00' })]);
  await sell('above_list', 'biller', retail1, 'Retail', [item(await g22(), { metal_rate: '6100.00', labour_rate: '120.00' })]);
  // a Per Piece line is compared on its price only: its labour rate is not used (R3), so a labour rate sent with it, however high or low, changes nothing
  await sell('piece_below', 'biller', retail1, 'Retail', [item(await pp('1000.00'), { metal_rate: '900.00' })]);
  await sell('piece_at_list', 'biller', retail1, 'Retail', [item(await pp('1000.00'), { metal_rate: '1000.00', labour_rate: '500.00' })]);

  // a discount above 10 percent of the subtotal: exactly 10 percent is not above
  await sell('discount_10', 'biller', retail2, 'Retail', [item(await pp('60000.00'), { metal_rate: '60000.00' })], { discount: '6000.00' });
  await sell('discount_over', 'biller', retail2, 'Retail', [item(await pp('60000.00'), { metal_rate: '60000.00' })], { discount: '6000.01' });

  // the walk-in: two sales and their cash, each far below the single-payment limit, so nothing stops either (Z2 does not add them up: this is where a split sale shows)
  await sell('walkin_1', 'biller', '00000000-0000-4000-8000-000000000001', 'Retail', [item(await pp('90000.00'), { metal_rate: '90000.00' })], { payments: [{ mode: 'Cash', amount: '90000.00' }] });
  await sell('walkin_2', 'biller', '00000000-0000-4000-8000-000000000001', 'Retail', [item(await pp('90000.00'), { metal_rate: '90000.00' })], { payments: [{ mode: 'Cash', amount: '90000.00' }] });

  // a sale type that is not the customer's (R9): a Retail customer billed as Wholesale
  await sell('type_differs', 'biller', retail1, 'Wholesale', [item(await pp('1000.00'), { metal_rate: '1000.00' })]);

  // cash over the limit with the owner's reason (Z1): on a bill, and on a payment
  await sell('override_bill', 'owner', big, 'Retail', [item(await pp('250000.00'), { metal_rate: '250000.00' })], {
    payments: [{ mode: 'Cash', amount: '200000.00' }],
    cash_override_reason: 'Customer paid in cash, ID checked at the counter',
  });
  const override = await paid(await pay(w, 'owner', big2, { amount: '200000.00', mode: 'Cash', cash_override_reason: 'Advance for the wedding order, ID checked' }));
  ids.override_receipt = override.receipt.id;
  // a cash payment that needed no override stores no reason and is not listed
  await paid(await pay(w, 'owner', payer, { amount: '50000.00', mode: 'Cash' }));

  // cancellation, and void (X5, X4)
  const toCancel = await sell('cancelled', 'biller', retail2, 'Retail', [item(await pp('1000.00'), { metal_rate: '1000.00' })]);
  expect((await cancelBill(w, 'owner', toCancel.bill.id)).statusCode).toBe(200);
  await sell('payer_bill', 'biller', payer, 'Retail', [item(await pp('5000.00'), { metal_rate: '5000.00' })]);
  const toVoid = await paid(await pay(w, 'biller', payer, { amount: '1000.00', mode: 'UPI' }));
  ids.voided_receipt = toVoid.receipt.id;
  expect((await voidReceipt(w, 'owner', toVoid.receipt.id)).statusCode).toBe(200);

  // fine_cash: the day's Silver rates are 75.00 (999) and 70.00 (925); a settlement is away when it is more than 5 percent from EVERY one
  await sell('silver_bill', 'biller', wholesale1, 'Wholesale', [item(await piece(w, d.silver999, { nw: '20.000', retail: '5.00', semi: '5.00', wholesale: '5.00' }), { metal_rate: '75.00', labour_rate: '5.00' })]);
  const fine: [string, string][] = [
    ['fine_80', '80.00'], // 6.67 % from 75.00 and 14.29 % from 70.00: away
    ['fine_71', '71.00'], // 1.43 % from 70.00: near one of the rates, so not away although 5.33 % from 75.00
    ['fine_78_75', '78.75'], // exactly 5 % above 75.00: not MORE than 5 percent
    ['fine_78_76', '78.76'], // 5.01 % above 75.00 and 12.5 % above 70.00: away
  ];
  for (const [name, rate] of fine) ids[name] = (await settled(await settle(w, 'biller', wholesale1, cashFine('5.000', rate)))).receipt.id;

  // typed in: a refund (the customer holds the money), and a re-issue (a bill cancelled the day before, issued again today)
  await addMoney(w, refunded, '100.00', '2026-10-16', { mode: 'Cash' });
  ids.refund = randomUUID();
  await insert(w.world.sql, 'receipts', V.receipt(refunded, { id: ids.refund, kind: 'refund', mode: 'Cash', amount: '50.00', paid_on: TODAY }));
  const original = await addCancelledBill(w, reissuer, '500.00', '2026-10-16');
  await w.world.sql.query('UPDATE bills SET import_batch_id = ? WHERE id = ?', [batch, original]);
  ids.reissue = await addBill(w, reissuer, '500.00', TODAY, { reissue_of: original, import_batch_id: batch });
  no.reissue = (await billRow(w, ids.reissue)).bill_no;
  no.reissue_original = (await billRow(w, original)).bill_no;

  // the rates a biller entered: more than 5 percent from the previous rate of the material and purity, up or down; exactly 5 percent, the owner's, and a first rate are not
  const post = async (caller: 'owner' | 'biller', purity: string, rate: string, material = 'Gold') => {
    const res = await postRate(w, caller, { material, purity, rate_per_gram: rate, rate_date: TODAY });
    expect(res.statusCode, res.body).toBe(201);
    ids[`rate_${caller}_${purity}`] = JSON.parse(res.body).row.id;
  };
  await post('biller', '18K', '4300.00'); // +7.5 % on 4,000.00 (not on the 1.00 of the 10th)
  await post('biller', '12K', '900.00'); // -10 %
  await post('biller', '20K', '5250.00'); // exactly +5 %
  await post('owner', '24K', '7000.00'); // +7.7 %, but the owner's
  await post('biller', '14K', '9999.00'); // the first rate of its purity
}, 300_000);
afterAll(async () => {
  await nw?.close();
}, 60_000);

let first: Awaited<ReturnType<NightlyWorld['run']>>;
const review = async () => (first ??= await nw.run({ date: RUN_DATE })).review;

const refs = (rows: Record<string, any>[], key: string) => rows.map((r) => String(r[key])).sort();

describe('T-B24 the review line: the previous business day, in check_runs.details, for the owner to open', () => {
  it('the review is for the day before the run\'s date, the counts are in the row the job wrote, and the lists hold the rows (at most 50 each) the owner can open', async () => {
    const r = await review();
    expect(first.date).toBe(RUN_DATE);
    expect(first.reviewDate).toBe(TODAY);
    expect(r.date).toBe(TODAY);
    const runs = await nw.checkRuns();
    const last = runs[runs.length - 1];
    expect(last.id).toBe(first.checkRunId);
    expect(last.details.review.date).toBe(TODAY);
    expect(last.details.review.counts).toEqual(r.counts);
    expect(last.details.review.walkin).toEqual(r.walkin);
    expect(Object.keys(last.details.review.lists).sort()).toEqual(Object.keys(r.counts).sort());
    for (const [name, n] of Object.entries(r.counts)) expect(last.details.review.lists[name].length, name).toBe(Math.min(n as number, 50));
  });

  it('the owner opens the lists from GET /v1/health/checks (the row the job wrote, details and all); a biller and staff are refused', async () => {
    await review();
    const res = await w.world.call('owner', 'GET', '/v1/health/checks?limit=200');
    expect(res.statusCode, res.body).toBe(200);
    const mine = (JSON.parse(res.body).check_runs as { id: number | string; ok: number | boolean; details: any }[]).find((r) => Number(r.id) === first.checkRunId)!;
    expect(mine.details.review.date).toBe(TODAY);
    expect(mine.details.review.lists.below_list_lines).toHaveLength(3);
    expect(mine.details.review.lists.below_list_lines[0]).toHaveProperty('bill_no');
    expect(mine.details.review.walkin).toEqual({ cash_total: '180000.00', bills: 2 });
    for (const caller of ['biller', 'staff'] as const) expect((await w.world.call(caller, 'GET', '/v1/health/checks')).statusCode, caller).toBe(403);
  });

  it('the day before a business date crosses months, years and a leap day', () => {
    expect(previousDay('2026-10-18')).toBe('2026-10-17');
    expect(previousDay('2026-03-01')).toBe('2026-02-28');
    expect(previousDay('2028-03-01')).toBe('2028-02-29');
    expect(previousDay('2027-01-01')).toBe('2026-12-31');
  });

  it('the day under review follows the clock when no date is given: the day before today of the API clock', async () => {
    const run = await nw.run();
    expect(run.date).toBe(TODAY);
    expect(run.reviewDate).toBe('2026-10-16');
    expect(run.review.date).toBe('2026-10-16');
    expect(run.review.counts.cancellations).toBe(1); // the bill the re-issue replaces was cancelled on the 16th, and only that
    expect(run.review.counts.below_list_lines).toBe(0);
  });

  it('a day with nothing in it has every count 0 and an empty walk-in total', async () => {
    const run = await nw.run({ date: '2026-10-19' });
    expect(Object.values(run.review.counts).every((n) => n === 0)).toBe(true);
    expect(run.review.walkin).toEqual({ cash_total: '0.00', bills: 0 });
    for (const rows of Object.values(run.review.lists)) expect(rows).toEqual([]);
  });
});

describe('T-B24 list prices come from the server, not the client; a line sold below list is in the review, a Per Piece line is compared on its price only', () => {
  it('the list prices stored on the lines are the daily rate and the piece\'s rate, whatever rate the line was sold at; a Per Piece line stores the piece price and no labour list price', async () => {
    const below = (await itemRows(w, ids.below_metal))[0];
    expect({ metal_rate: below.metal_rate, labour_rate: below.labour_rate, list_metal_rate: below.list_metal_rate, list_labour_rate: below.list_labour_rate }).toEqual({
      metal_rate: '5900.00',
      labour_rate: '100.00',
      list_metal_rate: '6000.00',
      list_labour_rate: '100.00',
    });
    const piece = (await itemRows(w, ids.piece_at_list))[0];
    expect({ metal_rate: piece.metal_rate, labour_rate: piece.labour_rate, list_metal_rate: piece.list_metal_rate, list_labour_rate: piece.list_labour_rate }).toEqual({
      metal_rate: '1000.00',
      labour_rate: '0.00',
      list_metal_rate: '1000.00',
      list_labour_rate: null,
    });
  });

  it('exactly the three lines sold below the metal or the labour list price are listed, with both prices; at list, above list and a Per Piece line at its price are not', async () => {
    const r = await review();
    expect(r.counts.below_list_lines).toBe(3);
    expect(refs(r.lists.below_list_lines, 'bill_no')).toEqual([no.below_metal, no.below_labour, no.piece_below].sort());
    const metal = r.lists.below_list_lines.find((x: any) => x.bill_no === no.below_metal);
    expect(metal).toMatchObject({ line_no: 1, selling_method: 'By Weight', metal_rate: '5900.00', list_metal_rate: '6000.00', labour_rate: '100.00', list_labour_rate: '100.00' });
    const labour = r.lists.below_list_lines.find((x: any) => x.bill_no === no.below_labour);
    expect(labour).toMatchObject({ metal_rate: '6000.00', list_metal_rate: '6000.00', labour_rate: '90.00', list_labour_rate: '100.00' });
    const piece = r.lists.below_list_lines.find((x: any) => x.bill_no === no.piece_below);
    expect(piece).toMatchObject({ selling_method: 'Per Piece', metal_rate: '900.00', list_metal_rate: '1000.00', list_labour_rate: null });
  });

  it('a Per Piece line is judged on its price even if an older row carries a list labour price: the By Weight rule is the only one that compares labour', async () => {
    const line = (await itemRows(w, ids.piece_at_list))[0];
    await w.world.sql.query("UPDATE bill_items SET list_labour_rate = '50.00' WHERE id = ?", [line.id]); // labour_rate is 0.00 on it: below 50.00 if it were compared
    try {
      const run = await nw.run({ date: RUN_DATE });
      expect(run.review.counts.below_list_lines).toBe(3);
      expect(refs(run.review.lists.below_list_lines, 'bill_no')).not.toContain(no.piece_at_list);
    } finally {
      await w.world.sql.query('UPDATE bill_items SET list_labour_rate = NULL WHERE id = ?', [line.id]);
    }
  });

  it('a cancelled bill\'s lines are not sold lines: a below-list bill that was cancelled leaves the line list', async () => {
    const own = await editWorld('nightrevc');
    try {
      const dd = await addDesigns(own);
      await addRate(own, 'Gold', '22K', '6000.00', TODAY);
      const c = await addCustomer(own);
      const p = await piece(own, dd.gold22, { nw: '10.000', retail: '100.00' });
      const sold = await saved(await postBill(own, 'biller', billBody(c, 'Retail', [item(p, { metal_rate: '5000.00', labour_rate: '100.00' })]), newKey()));
      const view = async () => {
        const conn = await own.world.app.db!.checkout();
        try {
          return (await runNightlyCheck(conn, { clock: own.world.app.clock, date: RUN_DATE })).review;
        } finally {
          conn.release();
        }
      };
      expect((await view()).counts.below_list_lines).toBe(1);
      expect((await cancelBill(own, 'owner', sold.bill.id)).statusCode).toBe(200);
      const after = await view();
      expect(after.counts.below_list_lines).toBe(0);
      expect(after.counts.cancellations).toBe(1);
    } finally {
      await own.world.close();
    }
  }, 120_000);
});

describe('T-B24 a discount above 10 percent of the subtotal', () => {
  it('6,000.01 on 60,000.00 is listed with the subtotal and the discount; exactly 6,000.00 (10 percent) is not', async () => {
    const r = await review();
    expect(r.counts.discount_over).toBe(1);
    expect(r.lists.discount_over).toEqual([expect.objectContaining({ bill_id: ids.discount_over, bill_no: no.discount_over, subtotal: '60000.00', discount: '6000.01' })]);
    expect(limits.discountFlagPercent).toBe(10);
  });
});

describe('T-B24 the walk-in\'s cash total and number of bills of the day (Z2 does not add them up)', () => {
  it('two bills of 90,000.00 paid in cash: 2 bills and 180,000.00 of cash, though no single payment reached the limit; the named customers\' cash is not in it', async () => {
    const r = await review();
    expect(r.walkin).toEqual({ cash_total: '180000.00', bills: 2 });
    expect(r.counts.walkin_bills).toBe(2);
    expect(refs(r.lists.walkin_bills, 'bill_no')).toEqual([no.walkin_1, no.walkin_2].sort());
    expect(r.lists.walkin_bills[0]).toHaveProperty('grand_total', '90000.00');
  });
});

describe('T-B24 the walk-in\'s cash total counts what Z1 counts: active Cash payments and fine_cash, on the day', () => {
  it('Cash 100.00 and fine_cash 30.00 count; UPI, a voided Cash payment, a refund and the next day\'s Cash do not', async () => {
    const day = '2026-10-12';
    const walkin = '00000000-0000-4000-8000-000000000001';
    const made: string[] = [];
    const add = async (o: Record<string, unknown>) => {
      const row = (await insert(w.world.sql, 'receipts', V.receipt(walkin, { paid_on: day, ...o }))) as { id: string };
      made.push(row.id);
    };
    await add({ amount: '100.00', mode: 'Cash' });
    await add({ kind: 'fine_cash', mode: 'Cash', amount: '30.00', fine_grams: '0.400', silver_rate: '75.00' });
    await add({ amount: '50.00', mode: 'UPI' });
    await add({ amount: '25.00', mode: 'Cash', status: 'voided', void_reason: 'entered twice', voided_at: '2026-10-12 08:00:00.000000', voided_on: day, voided_by: w.world.fixtures.owner.userId });
    await add({ kind: 'refund', amount: '5.00', mode: 'Cash' });
    await add({ amount: '999.00', mode: 'Cash', paid_on: '2026-10-13' });
    try {
      const run = await nw.run({ date: '2026-10-13' });
      expect(run.review.date).toBe(day);
      expect(run.review.walkin.cash_total).toBe('130.00');
    } finally {
      await nw.root(`DELETE FROM receipts WHERE id IN (${made.map((i) => `'${i}'`).join(', ')})`);
    }
  });
});

describe('T-B24 fine_cash settlements more than 5 percent from every Silver rate of the day', () => {
  it('80.00 and 78.76 against the rates 75.00 and 70.00 are listed; 71.00 (near the 925 rate) and 78.75 (exactly 5 percent) are not', async () => {
    const r = await review();
    expect(r.counts.fine_cash_rate_away).toBe(2);
    expect(refs(r.lists.fine_cash_rate_away, 'receipt_id')).toEqual([ids.fine_80, ids.fine_78_76].sort());
    const row = r.lists.fine_cash_rate_away.find((x: any) => x.receipt_id === ids.fine_80);
    expect(row).toMatchObject({ silver_rate: '80.00', fine_grams: '5.000', amount: '400.00' });
    expect(limits.rateFlagPercent).toBe(5);
  });

  it('with no Silver rate dated on or before the day, every fine_cash settlement of the day is away (the latest rate dated not after it)', async () => {
    // the same settlements, judged as of a day before the first Silver rate: move the receipts to the 9th and run for the 10th
    await w.world.sql.query("UPDATE receipts SET paid_on = '2026-10-09' WHERE kind = 'fine_cash'");
    try {
      const run = await nw.run({ date: '2026-10-10' });
      expect(run.review.date).toBe('2026-10-09');
      expect(run.review.counts.fine_cash_rate_away).toBe(4);
    } finally {
      await w.world.sql.query(`UPDATE receipts SET paid_on = '${TODAY}' WHERE kind = 'fine_cash'`);
    }
  });

  it('a voided settlement is not judged (the void is its own line)', async () => {
    const id = ids.fine_80;
    await nw.root(`UPDATE receipts SET status = 'voided', void_reason = 'wrong rate', voided_at = '2026-10-17 06:00:00.000000', voided_on = '${TODAY}', voided_by = '${w.world.fixtures.owner.userId}' WHERE id = '${id}'`);
    try {
      const run = await nw.run({ date: RUN_DATE });
      expect(run.review.counts.fine_cash_rate_away).toBe(1);
      expect(run.review.counts.voids).toBe(2);
    } finally {
      await nw.root(`UPDATE receipts SET status = 'active', void_reason = NULL, voided_at = NULL, voided_on = NULL, voided_by = NULL WHERE id = '${id}'`);
    }
  });
});

describe('T-B24 the daily rates a biller entered that moved more than 5 percent from the previous rate of the same material and purity', () => {
  it('+7.5 percent and -10 percent by a biller are listed with the previous rate and its date; exactly 5 percent, the owner\'s +7.7 percent and a first rate are not', async () => {
    const r = await review();
    expect(r.counts.biller_rate_moves).toBe(2);
    expect(refs(r.lists.biller_rate_moves, 'rate_id')).toEqual([ids.rate_biller_18K, ids.rate_biller_12K].sort());
    const up = r.lists.biller_rate_moves.find((x: any) => x.rate_id === ids.rate_biller_18K);
    expect(up).toMatchObject({ material: 'Gold', purity: '18K', rate_per_gram: '4300.00', previous_rate: '4000.00', previous_date: '2026-10-16', entered_by: w.world.fixtures.biller.userId });
  });
});

describe('T-B24 a bill whose sale type differs from the customer\'s (R9)', () => {
  it('a Retail customer billed as Wholesale is listed with both types; bills of the customer\'s own type are not', async () => {
    const r = await review();
    expect(r.counts.sale_type_differs).toBe(1);
    expect(r.lists.sale_type_differs).toEqual([expect.objectContaining({ bill_id: ids.type_differs, bill_no: no.type_differs, sale_type: 'Wholesale', customer_type: 'Retail' })]);
  });
});

describe('T-B24 cash overrides, cancellations, re-issues, voids and refunds of the day', () => {
  it('a bill and a receipt saved with an override reason are listed with the reason; a cash payment that needed none is not', async () => {
    const r = await review();
    expect(r.counts.cash_overrides).toBe(2);
    const sources = r.lists.cash_overrides.map((x: any) => `${x.source}:${x.id}`).sort();
    expect(sources).toEqual([`bill:${ids.override_bill}`, `receipt:${ids.override_receipt}`].sort());
    expect(r.lists.cash_overrides.find((x: any) => x.source === 'bill')).toMatchObject({ ref: no.override_bill, amount: '250000.00', reason: 'Customer paid in cash, ID checked at the counter' });
    expect(r.lists.cash_overrides.find((x: any) => x.source === 'receipt')).toMatchObject({ amount: '200000.00', reason: 'Advance for the wedding order, ID checked' });
  });

  it('the cancelled bill, the voided receipt, the refund and the re-issued bill are each listed once', async () => {
    const r = await review();
    expect(r.counts).toMatchObject({ cancellations: 1, voids: 1, refunds: 1, reissues: 1 });
    expect(r.lists.cancellations).toEqual([expect.objectContaining({ bill_no: no.cancelled, cancel_reason: 'the customer returned the goods' })]);
    expect(r.lists.voids).toEqual([expect.objectContaining({ receipt_id: ids.voided_receipt, kind: 'money', mode: 'UPI', amount: '1000.00', void_reason: 'entered twice by mistake' })]);
    expect(r.lists.refunds).toEqual([expect.objectContaining({ receipt_id: ids.refund, mode: 'Cash', amount: '50.00' })]);
    expect(r.lists.reissues).toEqual([expect.objectContaining({ bill_id: ids.reissue, bill_no: no.reissue, original_bill_no: no.reissue_original })]);
  });
});

describe('T-B24 nothing is blocked and the check never turns red because of the review line (O26, I11)', () => {
  it('with eleven kinds of flags raised the invariants still hold: ok is true, every count is 0, and check_runs.ok is 1', async () => {
    const r = await review();
    expect(Object.values(r.counts).reduce((a: number, b) => a + (b as number), 0)).toBeGreaterThan(10);
    expect(first.rows, JSON.stringify(first.rows)).toEqual([]);
    expect(first.ok).toBe(true);
    expect(Object.values(first.counts).every((n) => n === 0)).toBe(true);
    const last = (await nw.checkRuns()).find((x) => x.id === first.checkRunId)!;
    expect(last.ok).toBe(1);
  });
});

describe('T-B24 the lists hold at most 50 rows each while the counts are exact', () => {
  it('52 bills with a discount above 10 percent: the count is 52, the list has 50', async () => {
    const own = await editWorld('nightrevl');
    try {
      const batch = randomUUID();
      await insert(own.world.sql, 'sys_import_batches', { id: batch, name: `lim-${batch}` });
      const c = await addCustomer(own);
      for (let i = 0; i < 52; i++) await addBill(own, c, '1100.00', TODAY, { subtotal: '1300.00', discount: '200.00', import_batch_id: batch });
      const conn = await own.world.app.db!.checkout();
      try {
        const run = await runNightlyCheck(conn, { clock: own.world.app.clock, date: RUN_DATE });
        expect(run.review.counts.discount_over).toBe(52);
        expect(run.review.lists.discount_over).toHaveLength(50);
        const small = await runNightlyCheck(conn, { clock: own.world.app.clock, date: RUN_DATE, reviewRows: 5 });
        expect(small.review.lists.discount_over).toHaveLength(5);
        expect(small.review.counts.discount_over).toBe(52);
      } finally {
        conn.release();
      }
    } finally {
      await own.world.close();
    }
  }, 180_000);
});
