import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CURRENT_PRICING_VERSION } from '../../src/domain/pricing';
import { PRICING_VERSIONS, priceWithVersion } from '../../src/money/x07QuoteBill';
import { V, insert, uuid } from '../schema/support';
import { type Designs, type Quote, addCustomer, addDesigns, billBody, billRow, item, itemRows, piece, postBill, postQuote, saved } from './x01-support';
import { settle, settled, silver } from './x03-support';
import { type NightlyWorld, nightlyWorld } from './nightly-support';

// FB-C3 (Siddhi's feedback of 6 Nov 2026, #5; decision FB-D2): pricing version 2. Semi-Wholesale silver By Weight lines owe fine exactly like Wholesale (R4: fine due = NW x q, R5: metal amount 0); every
// other rule is version 1's. New bills store pricing_version 2; a bill saved before stays version 1 and the nightly I6 check still re-prices it as version 1 (Review Focus 2). The hash the API returns
// in `me` is the one PRICING-SOURCE.txt names and, when the app's checkout is given (JV_APP_DIR), the one the app's build carries (Review Focus 1).
//
// Figures, worked by hand: one Silver 999 By Weight piece of NW 120.000 g, metal rate 85.00, labour 40.00, no piroi. Version 2, Semi-Wholesale: metal 0.00, labour 120 x 40 = 4,800.00, fine 120.000,
// total 4,800.00. Version 1, Semi-Wholesale (the old rule): metal 120 x 85 = 10,200.00, labour 4,800.00, fine 0.000, total 15,000.00.

const REPO = fileURLToPath(new URL('../../', import.meta.url));
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

let nw: NightlyWorld;
let d: Designs;

beforeAll(async () => {
  nw = await nightlyWorld('fbc3v2');
  d = await addDesigns(nw.w);
}, 180_000);
afterAll(async () => {
  await nw?.close();
}, 60_000);

const silverLine = (sku: string) => item(sku, { metal_rate: '85.00', labour_rate: '40.00' });

/** A Semi-Wholesale silver bill saved BEFORE FB-D2: version 1, its figures the old rule's, typed in as the books hold it (an imported batch, so the bill-number counters need no care, as in T-B18). */
async function addVersion1Bill(): Promise<{ bill: string; line: string; customer: string }> {
  const batch = uuid();
  await insert(nw.sql, 'sys_import_batches', { id: batch, name: `fbc3-${batch}` });
  const customer = await addCustomer(nw.w, { customer_type: 'Semi-Wholesale' });
  const bill = (await insert(
    nw.sql,
    'bills',
    V.bill(customer, { bill_no: `IMP-FBC3-${batch.slice(0, 8)}`, sale_type: 'Semi-Wholesale', pricing_version: 1, bill_date: '2026-10-08', subtotal: '15000.00', grand_total: '15000.00', round_off: '0.00', fine_weight_due: '0.000', import_batch_id: batch, request_id: null }),
  )) as { id: string };
  const sku = (await insert(nw.sql, 'skus', V.sku(d.silver999, { status: 'Sold', sold_bill_id: bill.id, customer_net_weight: '120.000', gross_weight: '120.000' }))) as { id: string };
  const line = (await insert(
    nw.sql,
    'bill_items',
    V.billItem(bill.id, sku.id, {
      material: 'Silver', purity: '999', customer_net_weight: '120.000', gross_weight: '120.000', metal_rate: '85.00', labour_rate: '40.00', labour_amount: '4800.00', piroi: '0.00',
      metal_amount: '10200.00', fine_weight_due: '0.000', item_total: '15000.00', list_metal_rate: '85.00', list_labour_rate: '40.00',
    }),
  )) as { id: string };
  return { bill: bill.id, line: line.id, customer };
}

describe('FB-C3 pricing version 2: Semi-Wholesale silver owes fine like Wholesale (FB-D2, R4, R5, R13)', () => {
  it('the API prices versions 1 and 2, and 2 is the current one', () => {
    expect(CURRENT_PRICING_VERSION).toBe(2);
    expect(Object.keys(PRICING_VERSIONS).map(Number).sort()).toEqual([1, 2]);
  });

  it('a version 1 Semi-Wholesale silver line re-prices with fine 0 and metal > 0 (round(NW x r)), as version 2 with fine NW x q and metal 0 (Review Focus 2)', () => {
    const line = { material: 'Silver', sellingMethod: 'By Weight', customerNetWeightMg: 120000, quantity: 1, metalRatePaise: 8500, labourRatePaise: 4000, piroiPaise: 0, otherChargesPaise: 0 } as const;
    const input = { saleType: 'Semi-Wholesale', lines: [line], roundOffSetting: false } as const;
    expect(priceWithVersion(PRICING_VERSIONS, 1, input).lines[0]).toMatchObject({ fineWeightDueMg: 0, metalAmountPaise: 1020000, labourAmountPaise: 480000, itemTotalPaise: 1500000 });
    expect(priceWithVersion(PRICING_VERSIONS, 2, input).lines[0]).toMatchObject({ fineWeightDueMg: 120000, metalAmountPaise: 0, labourAmountPaise: 480000, itemTotalPaise: 480000 });
    // the input naming another version changes nothing: the table's entry decides
    expect(priceWithVersion(PRICING_VERSIONS, 1, { ...input, pricingVersion: 2 }).pricingVersion).toBe(1);
  });

  it('quote_bill: no pricing_version and 2 give fine 120.000 and metal 0.00; pricing_version 1 gives fine 0.000 and metal 10,200.00; a Gold or a Retail line has no fine in version 2', async () => {
    const sku = await piece(nw.w, d.silver999, { nw: '120.000' });
    const quote = async (extra: Record<string, unknown>, sale = 'Semi-Wholesale', sku2 = sku) => {
      const res = await postQuote(nw.w, 'owner', { sale_type: sale, items: [silverLine(sku2)], ...extra });
      expect(res.statusCode, res.body).toBe(200);
      return res.json() as Quote;
    };
    for (const q of [await quote({}), await quote({ pricing_version: 2 })]) {
      expect(q.pricing_version).toBe(2);
      expect(q.lines[0]).toMatchObject({ metal_amount: '0.00', labour_amount: '4800.00', fine_weight_due: '120.000', item_total: '4800.00' });
      expect(q.totals).toMatchObject({ subtotal: '4800.00', grand_total: '4800.00', fine_weight_due: '120.000' });
    }
    const old = await quote({ pricing_version: 1 });
    expect(old.pricing_version).toBe(1);
    expect(old.lines[0]).toMatchObject({ metal_amount: '10200.00', labour_amount: '4800.00', fine_weight_due: '0.000', item_total: '15000.00' });
    const gold = await piece(nw.w, d.gold22, { nw: '120.000' });
    expect((await quote({}, 'Semi-Wholesale', gold)).lines[0]).toMatchObject({ fine_weight_due: '0.000', metal_amount: '10200.00' });
    expect((await quote({}, 'Retail')).lines[0]).toMatchObject({ fine_weight_due: '0.000', metal_amount: '10200.00' });
    expect((await quote({}, 'Wholesale')).lines[0]).toMatchObject({ fine_weight_due: '120.000', metal_amount: '0.00' });
  });

  it('POST /v1/bills stores pricing_version 2 and the fine; the nightly check (I6) passes with a version 1 and a version 2 Semi-Wholesale silver bill side by side; settle fine clears the new bill', async () => {
    const customer = await addCustomer(nw.w, { customer_type: 'Semi-Wholesale' });
    const sku = await piece(nw.w, d.silver999, { nw: '120.000' });
    const made = await saved(await postBill(nw.w, 'owner', billBody(customer, 'Semi-Wholesale', [silverLine(sku)])));
    expect(made.bill).toMatchObject({ pricing_version: 2, sale_type: 'Semi-Wholesale', subtotal: '4800.00', grand_total: '4800.00', fine_weight_due: '120.000' });
    const stored = await billRow(nw.w, String(made.bill.id));
    expect({ pricing_version: stored.pricing_version, fine_weight_due: stored.fine_weight_due, grand_total: stored.grand_total }).toEqual({ pricing_version: 2, fine_weight_due: '120.000', grand_total: '4800.00' });
    const [line] = await itemRows(nw.w, String(made.bill.id));
    expect({ metal_amount: line.metal_amount, labour_amount: line.labour_amount, fine_weight_due: line.fine_weight_due, item_total: line.item_total }).toEqual({
      metal_amount: '0.00',
      labour_amount: '4800.00',
      fine_weight_due: '120.000',
      item_total: '4800.00',
    });

    const old = await addVersion1Bill();
    const run = await nw.run();
    expect(run.rows, JSON.stringify(run.rows)).toEqual([]);
    expect(run.ok).toBe(true);

    // control: the old bill's stored figures are the version 1 figures, so calling it version 2 makes I6 name its line (the version of the bill decides)
    await nw.sql.query('UPDATE bills SET pricing_version = 2 WHERE id = ?', [old.bill]);
    try {
      const wrong = await nw.run();
      expect(wrong.rows.filter((r) => r.invariant === 'I6').map((r) => r.row_ref)).toEqual([`bill_items:${old.line}`]);
      expect(wrong.rows.find((r) => r.invariant === 'I6')!.detail).toMatch(/fine_weight_due 0\.000 but a fresh run of version 2 gives 120\.000/);
    } finally {
      await nw.sql.query('UPDATE bills SET pricing_version = 1 WHERE id = ?', [old.bill]);
    }

    // SF1: the silver owed on the new bill is settled like a Wholesale bill's
    const done = await settled(await settle(nw.w, 'owner', customer, silver('120.000')));
    expect(done.fine_remaining).toBe('0.000');
    expect(done.allocations.map((a) => [a.bill_id, a.fine_grams])).toEqual([[made.bill.id, '120.000']]);
    expect((await nw.run()).rows).toEqual([]);
  });
});

describe('FB-C3 the pricing hash agrees everywhere (Review Focus 1)', () => {
  const recorded = (name: string) => new RegExp(`^${name}:\\s*(\\S+)\\s*$`, 'm').exec(readFileSync(join(REPO, 'PRICING-SOURCE.txt'), 'utf8'))?.[1];
  const inMe = () => /PRICING_SHA256[^=\n]*=\s*'([0-9a-f]{64})'/.exec(readFileSync(join(REPO, 'src/auth/loginRoutes.ts'), 'utf8'))?.[1];

  it('PRICING-SOURCE.txt, PRICING_SHA256 (what `me` returns) and src/domain/pricing.ts have one hash', () => {
    const hash = sha256(readFileSync(join(REPO, 'src/domain/pricing.ts')));
    expect(recorded('sha256')).toBe(hash);
    expect(inMe()).toBe(hash);
  });

  const appDir = process.env.JV_APP_DIR;
  it.skipIf(!appDir || !existsSync(join(appDir, 'src/lib/api/pricingHash.ts')))('with JV_APP_DIR: the app\'s generated hash file and its pricing.ts carry that same hash', () => {
    const app = appDir as string;
    const generated = /BUILD_PRICING_SHA256\s*=\s*'([0-9a-f]{64})'/.exec(readFileSync(join(app, 'src/lib/api/pricingHash.ts'), 'utf8'))?.[1];
    expect(generated).toBe(sha256(readFileSync(join(app, 'src/lib/pricing.ts'))));
    expect(generated).toBe(recorded('sha256'));
    expect(generated).toBe(inMe());
  });
});
