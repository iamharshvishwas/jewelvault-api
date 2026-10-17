import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ExactPricingError as OraclePricingError, type PriceBillInput, formatGrams, formatRupees, priceBill as oraclePrice } from '../../oracle/exact-decimal';
import { buildApp } from '../../src/app';
import { createClock } from '../../src/clock';
import { createDbPool } from '../../src/db/pool';
import { type PriceBillInput as RealInput, type PricedBill, priceBill } from '../../src/domain/pricing';
import { PRICING_VERSIONS, registerQuoteBill } from '../../src/money/x07QuoteBill';
import { rng } from '../helpers';
import { T0, type CallerName, type World, makeWorld } from './cells';
import { REPO, csrfHeaders, testConfig } from './support';

// API18, X7 `quote_bill` (POST /v1/bills/quote): the lines, totals, list prices and warnings create_bill will produce, through the same priceBill of pricing.ts (R12). The tests below are the
// DB half of T-A01, T-A04, T-A05, T-A07, T-A08, T-A11, T-A13, T-A16, T-A18, T-A19, the version dispatch of T-A15, the bill and line clauses of T-A09, the matrix row of X7 (T-D09) and the
// hash of `me` (T-A14). The expected figures are written in the test (the spec's own figures, or worked out with exact fractions), never taken from the code under test; the random bills of
// T-A14 are priced by oracle/exact-decimal.ts, which was written again from the spec and shares no code with pricing.ts.
//
// The world is a scratch database with the real schema, the application's own routes, one design for each case below and a fixed clock (17 October 2026, 15:30 in Kolkata: "today").

const TODAY = '2026-10-17';
const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');

let world: World;
const designs: Record<string, string> = {};
let counter = 0;

async function addDesign(key: string, material: 'Gold' | 'Silver', purity: string, method: 'By Weight' | 'Per Piece') {
  const id = randomUUID();
  await world.sql.query('INSERT INTO designs (id, design_no, name, category_id, material, purity, selling_method) VALUES (?, ?, ?, (SELECT id FROM categories LIMIT 1), ?, ?, ?)', [id, `D-${key}`, key, material, purity, method]);
  designs[key] = id;
}

interface PieceSpec {
  nw: string;
  retail?: string;
  semi?: string;
  wholesale?: string;
}
async function addPiece(design: string, o: PieceSpec): Promise<string> {
  const id = randomUUID();
  counter++;
  await world.sql.query('INSERT INTO skus (id, design_id, sku_no, barcode, gross_weight, customer_net_weight, labour_retail, labour_semi, labour_wholesale) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [
    id,
    designs[design],
    `Q-${counter}`,
    `QB${counter}`,
    o.nw,
    o.nw,
    o.retail ?? '0.00',
    o.semi ?? o.retail ?? '0.00',
    o.wholesale ?? o.retail ?? '0.00',
  ]);
  return id;
}

async function addRate(material: string, purity: string, rate: string, date: string) {
  await world.sql.query('INSERT INTO daily_rates (id, material, purity, rate_per_gram, rate_date) VALUES (?, ?, ?, ?, ?)', [randomUUID(), material, purity, rate, date]);
}

beforeAll(async () => {
  world = await makeWorld({ label: 'quote', routes: true });
  await world.sql.query("INSERT INTO categories (id, name, prefix) VALUES (?, 'Quote', 'QT')", [randomUUID()]);
  await world.sql.query('INSERT INTO settings (setting_key, value) VALUES (?, ?)', ['estimate', JSON.stringify({ prefix: 'JV', roundOff: true, footerNote: 'estimate' })]);
  await addDesign('gold22', 'Gold', '22K', 'By Weight');
  await addDesign('gold18', 'Gold', '18K', 'By Weight');
  await addDesign('gold20', 'Gold', '20K', 'By Weight');
  await addDesign('goldCustom', 'Gold', 'Custom', 'By Weight');
  await addDesign('silver925', 'Silver', '925', 'By Weight');
  await addDesign('silver999', 'Silver', '999', 'By Weight');
  await addDesign('silver800pp', 'Silver', '800', 'Per Piece');
  await addDesign('gold24pp', 'Gold', '24K', 'Per Piece');
  await addRate('Gold', '22K', '6920.00', TODAY);
  await addRate('Gold', '22K', '6800.00', '2026-10-10');
  await addRate('Gold', '18K', '5700.00', TODAY);
  await addRate('Gold', '20K', '6300.00', '2026-10-15');
  await addRate('Silver', '999', '85.00', TODAY);
}, 180_000);

afterAll(async () => {
  await world?.close();
});

// ------------------------------------------------------------------ helpers

interface Item {
  sku_id: string;
  metal_rate?: unknown;
  labour_rate?: unknown;
  piroi?: unknown;
  other_charges?: unknown;
  quantity?: unknown;
  [extra: string]: unknown;
}
const item = (sku_id: string, o: Omit<Item, 'sku_id'> = {}): Item => ({ sku_id, ...o });
type Body = Record<string, unknown>;
type OracleLine = NonNullable<PriceBillInput['lines']>[number];
const bodyOf = (sale_type: string, items: Item[], extra: Body = {}): Body => ({ sale_type, items, ...extra });

const post = (body: unknown, caller: CallerName = 'owner') => world.call(caller, 'POST', '/v1/bills/quote', { payload: body });

interface Line {
  line_no: number;
  sku_id: string;
  sku_no: string;
  material: string;
  purity: string;
  selling_method: string;
  customer_net_weight: string;
  quantity: number;
  metal_rate: string;
  labour_rate: string;
  piroi: string;
  other_charges: string;
  labour_amount: string;
  metal_amount: string;
  fine_weight_due: string;
  item_total: string;
}
interface Quote {
  pricing_version: number;
  bill_date: string;
  sale_type: string;
  lines: Line[];
  totals: { subtotal: string; discount: string; additional_charges: string; grand_total: string; round_off: string; fine_weight_due: string };
  list_prices: { line_no: number; sku_id: string; list_metal_rate: string; list_labour_rate: string | null; metal_rate_date: string | null }[];
  warnings: string[];
}

async function quote(body: unknown, caller: CallerName = 'owner'): Promise<Quote> {
  const res = await post(body, caller);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as Quote;
}

const errorOf = (res: LightMyRequestResponse) => (res.json() as { error: { code: string; message: string; details: { field?: string } }; request_id: string }).error;

/** The call is refused with 422 JV_INVALID_INPUT naming `field`; the message never repeats a value that was sent. */
async function refused(body: unknown, field: string, caller: CallerName = 'owner') {
  const res = await post(body, caller);
  expect(res.statusCode, `${field}: ${res.body}`).toBe(422);
  const e = errorOf(res);
  expect(e.code).toBe('JV_INVALID_INPUT');
  expect(e.details.field).toBe(field);
  return e;
}

/** Money text to paise, the way a person reads it (used to add figures in the tests). */
const paise = (text: string) => BigInt(text.replace('.', ''));

// ------------------------------------------------------------------ T-A01

describe('T-A01 the worked example through quote_bill (R1 to R8)', () => {
  it('NW 35.42 g, rate 6,920, labour 353 per gram, piroi 2.15, Retail, By Weight: metal 245,106.40, labour 12,503.26, line 257,611.81, grand total 257,612', async () => {
    const piece = await addPiece('gold22', { nw: '35.420', retail: '353.00' });
    const q = await quote(bodyOf('Retail', [item(piece, { metal_rate: '6920.00', labour_rate: '353.00', piroi: '2.15' })]));
    expect(q.pricing_version).toBe(1);
    expect(q.bill_date).toBe(TODAY);
    expect(q.sale_type).toBe('Retail');
    expect(q.lines).toHaveLength(1);
    const l = q.lines[0];
    expect(l).toMatchObject({
      line_no: 1,
      sku_id: piece,
      material: 'Gold',
      purity: '22K',
      selling_method: 'By Weight',
      customer_net_weight: '35.420',
      quantity: 1,
      metal_rate: '6920.00',
      labour_rate: '353.00',
      piroi: '2.15',
      other_charges: '0.00',
      metal_amount: '245106.40',
      labour_amount: '12503.26',
      fine_weight_due: '0.000',
      item_total: '257611.81',
    });
    expect(q.totals).toEqual({ subtotal: '257611.81', discount: '0.00', additional_charges: '0.00', grand_total: '257612.00', round_off: '0.19', fine_weight_due: '0.000' });
    expect(q.warnings).toEqual([]);
  });

  it('the answer holds money and weight as texts with 2 and 3 decimals and no number in a money or weight field', async () => {
    const piece = await addPiece('gold22', { nw: '1.500', retail: '10.00' });
    const q = await quote(bodyOf('Retail', [item(piece, { metal_rate: '6920.00', labour_rate: '10.00' })]));
    const walk = (v: unknown, path: string): void => {
      if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`));
      else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, `${path}.${k}`);
      else if (typeof v === 'number') expect(['pricing_version', 'line_no', 'quantity'], `${path} is a JSON number`).toContain(path.split('.').pop()!.replace(/\[\d+\]$/, ''));
    };
    walk(q, 'quote');
    expect(q.lines[0].metal_amount).toMatch(/^\d+\.\d{2}$/);
    expect(q.lines[0].customer_net_weight).toMatch(/^\d+\.\d{3}$/);
  });
});

// ------------------------------------------------------------------ T-A04, T-A05

describe('T-A04 Wholesale silver By Weight: the metal is settled later in fine, the labour is billed (R4, R5, SF3)', () => {
  it('13.9 g, labour 40 per gram: metal 0, labour 556.00, fine due 13.900, grand total 556 (piroi and other charges 0)', async () => {
    const piece = await addPiece('silver999', { nw: '13.900', retail: '40.00' });
    const q = await quote(bodyOf('Wholesale', [item(piece, { metal_rate: '85.00', labour_rate: '40.00' })]));
    expect(q.lines[0]).toMatchObject({ metal_amount: '0.00', labour_amount: '556.00', fine_weight_due: '13.900', item_total: '556.00' });
    expect(q.totals).toMatchObject({ subtotal: '556.00', grand_total: '556.00', round_off: '0.00', fine_weight_due: '13.900' });
  });

  it('the same for a 925 piece: purity changes nothing', async () => {
    const piece = await addPiece('silver925', { nw: '13.900', retail: '40.00' });
    const q = await quote(bodyOf('Wholesale', [item(piece, { metal_rate: '85.00', labour_rate: '40.00' })]));
    expect(q.lines[0]).toMatchObject({ purity: '925', metal_amount: '0.00', labour_amount: '556.00', fine_weight_due: '13.900', item_total: '556.00' });
    expect(q.totals.grand_total).toBe('556.00');
  });

  it('Semi-Wholesale silver and Wholesale gold have no fine: the metal is billed, 13.9 g x 85.00 = 1,181.50', async () => {
    const silver = await addPiece('silver999', { nw: '13.900', retail: '40.00' });
    const semi = await quote(bodyOf('Semi-Wholesale', [item(silver, { metal_rate: '85.00', labour_rate: '40.00' })]));
    expect(semi.lines[0]).toMatchObject({ metal_amount: '1181.50', labour_amount: '556.00', fine_weight_due: '0.000', item_total: '1737.50' });
    const gold = await addPiece('gold22', { nw: '13.900', retail: '40.00' });
    const wholesaleGold = await quote(bodyOf('Wholesale', [item(gold, { metal_rate: '85.00', labour_rate: '40.00' })]));
    expect(wholesaleGold.lines[0]).toMatchObject({ metal_amount: '1181.50', fine_weight_due: '0.000', item_total: '1737.50' });
    expect(wholesaleGold.totals.fine_weight_due).toBe('0.000');
  });

  it('a bill adds the fine of its lines: two Wholesale silver lines of 13.9 g and 2.1 g give 16.000', async () => {
    const a = await addPiece('silver999', { nw: '13.900', retail: '40.00' });
    const b = await addPiece('silver999', { nw: '2.100', retail: '40.00' });
    const q = await quote(bodyOf('Wholesale', [item(a, { metal_rate: '85.00', labour_rate: '40.00' }), item(b, { metal_rate: '85.00', labour_rate: '40.00' })]));
    expect(q.totals).toMatchObject({ fine_weight_due: '16.000', subtotal: '640.00', grand_total: '640.00' });
  });
});

describe('T-A05 Per Piece keeps the price (R4, R5, BIL-06)', () => {
  it('Wholesale silver Per Piece: 2 pieces at 1,200 give metal 2,400.00 and fine 0', async () => {
    const piece = await addPiece('silver800pp', { nw: '8.000', retail: '1200.00', wholesale: '1200.00' });
    const q = await quote(bodyOf('Wholesale', [item(piece, { metal_rate: '1200.00', quantity: 2 })]));
    expect(q.lines[0]).toMatchObject({ quantity: 2, metal_amount: '2400.00', labour_amount: '0.00', fine_weight_due: '0.000', item_total: '2400.00' });
    expect(q.totals).toMatchObject({ fine_weight_due: '0.000', grand_total: '2400.00' });
  });

  it('Per Piece, quantity 3 at 1,200: metal 3,600.00, labour 0, the quantity is on the line; a labour rate sent for a Per Piece line is ignored (R3)', async () => {
    const piece = await addPiece('gold24pp', { nw: '5.000', retail: '1200.00' });
    const q = await quote(bodyOf('Retail', [item(piece, { metal_rate: '1200.00', quantity: 3, labour_rate: '999.00' })]));
    expect(q.lines[0]).toMatchObject({ quantity: 3, metal_rate: '1200.00', labour_rate: '0.00', labour_amount: '0.00', metal_amount: '3600.00', item_total: '3600.00' });
  });
});

// ------------------------------------------------------------------ T-A07, T-A08, T-A11

describe('T-A07 piroi and other charges are added once per line, not per quantity (R7)', () => {
  it('3 pieces at 1,200 with piroi 10.00 and other charges 5.00: 3,600 + 10 + 5 = 3,615.00', async () => {
    const piece = await addPiece('gold24pp', { nw: '5.000', retail: '1200.00' });
    const q = await quote(bodyOf('Retail', [item(piece, { metal_rate: '1200.00', quantity: 3, piroi: '10.00', other_charges: '5.00' })]));
    expect(q.lines[0]).toMatchObject({ piroi: '10.00', other_charges: '5.00', metal_amount: '3600.00', item_total: '3615.00' });
    expect(q.totals.subtotal).toBe('3615.00');
  });

  it('a By Weight line adds them once as well: 2.000 g x 100.00 + labour 2.000 x 50.00 + 7.25 + 0.75 = 308.00', async () => {
    const piece = await addPiece('gold22', { nw: '2.000', retail: '50.00' });
    const q = await quote(bodyOf('Retail', [item(piece, { metal_rate: '100.00', labour_rate: '50.00', piroi: '7.25', other_charges: '0.75' })]));
    expect(q.lines[0].item_total).toBe('308.00');
  });
});

describe('T-A08 a discount cannot make the total negative (R8)', () => {
  it('a discount equal to subtotal plus additional charges gives grand total 0; one paisa more is rejected', async () => {
    const piece = await addPiece('gold24pp', { nw: '5.000', retail: '1000.00' });
    const items = [item(piece, { metal_rate: '1000.00', piroi: '10.50' })]; // subtotal 1,010.50
    const exact = await quote(bodyOf('Retail', items, { discount: '1012.50', additional_charges: '2.00' }));
    expect(exact.totals).toMatchObject({ subtotal: '1010.50', discount: '1012.50', additional_charges: '2.00', grand_total: '0.00', round_off: '0.00' });
    await refused(bodyOf('Retail', items, { discount: '1012.51', additional_charges: '2.00' }), 'discount');
  });

  it('a discount of the subtotal alone, with no additional charges, gives 0 too, and 0.01 more is rejected', async () => {
    const piece = await addPiece('gold24pp', { nw: '5.000', retail: '1000.00' });
    const items = [item(piece, { metal_rate: '1000.00' })];
    expect((await quote(bodyOf('Retail', items, { discount: '1000.00' }))).totals.grand_total).toBe('0.00');
    await refused(bodyOf('Retail', items, { discount: '1000.01' }), 'discount');
  });
});

describe('R8 the round-off setting (settings.estimate.roundOff) decides round_off, never the whole-rupee grand total', () => {
  it('with the setting off the grand total is still a whole rupee and round_off is 0.00; with it on round_off is the difference, negative below the half', async () => {
    const piece = await addPiece('gold24pp', { nw: '5.000', retail: '1000.40' });
    const items = [item(piece, { metal_rate: '1000.40' })];
    expect((await quote(bodyOf('Retail', items))).totals).toMatchObject({ subtotal: '1000.40', grand_total: '1000.00', round_off: '-0.40' });
    try {
      await world.sql.query("UPDATE settings SET value = JSON_SET(value, '$.roundOff', false) WHERE setting_key = 'estimate'");
      expect((await quote(bodyOf('Retail', items))).totals).toMatchObject({ subtotal: '1000.40', grand_total: '1000.00', round_off: '0.00' });
    } finally {
      await world.sql.query("UPDATE settings SET value = JSON_SET(value, '$.roundOff', true) WHERE setting_key = 'estimate'");
    }
    expect((await quote(bodyOf('Retail', items))).totals.round_off).toBe('-0.40');
  });
});

describe('T-A11 paise are exact (S3)', () => {
  it('4.6 g x 92.50 = 425.50, grand total 426', async () => {
    const piece = await addPiece('gold22', { nw: '4.600' });
    const q = await quote(bodyOf('Retail', [item(piece, { metal_rate: '92.50', labour_rate: '0.00' })]));
    expect(q.lines[0].metal_amount).toBe('425.50');
    expect(q.totals).toMatchObject({ subtotal: '425.50', grand_total: '426.00', round_off: '0.50' });
  });
});

// ------------------------------------------------------------------ T-A13

describe('T-A13 the server computes the list prices (R2, R14, D4)', () => {
  it('an 18K and a 22K piece get their own daily rates, and the piece\'s labour rate for the sale type', async () => {
    const g22 = await addPiece('gold22', { nw: '10.000', retail: '353.00', semi: '340.00', wholesale: '330.00' });
    const g18 = await addPiece('gold18', { nw: '10.000', retail: '300.00', semi: '290.00', wholesale: '280.00' });
    const q = await quote(bodyOf('Retail', [item(g22, { metal_rate: '6920.00', labour_rate: '353.00' }), item(g18, { metal_rate: '5700.00', labour_rate: '300.00' })]));
    expect(q.list_prices).toEqual([
      { line_no: 1, sku_id: g22, list_metal_rate: '6920.00', list_labour_rate: '353.00', metal_rate_date: TODAY },
      { line_no: 2, sku_id: g18, list_metal_rate: '5700.00', list_labour_rate: '300.00', metal_rate_date: TODAY },
    ]);
    expect(q.warnings).toEqual([]);
    for (const [sale, a, b] of [['Semi-Wholesale', '340.00', '290.00'], ['Wholesale', '330.00', '280.00']] as const) {
      const s = await quote(bodyOf(sale, [item(g22, { metal_rate: '1.00', labour_rate: '1.00' }), item(g18, { metal_rate: '1.00', labour_rate: '1.00' })]));
      expect(s.list_prices.map((p) => p.list_labour_rate), sale).toEqual([a, b]);
    }
  });

  it('the list price never comes from the client, and the sent rate does not move it', async () => {
    const piece = await addPiece('gold22', { nw: '10.000', retail: '353.00' });
    const cheap = await quote(bodyOf('Retail', [item(piece, { metal_rate: '1.00', labour_rate: '1.00' })]));
    expect(cheap.list_prices[0]).toMatchObject({ list_metal_rate: '6920.00', list_labour_rate: '353.00' });
    await refused(bodyOf('Retail', [item(piece, { metal_rate: '1.00', labour_rate: '1.00', list_metal_rate: '1.00' })]), 'items[0].list_metal_rate');
    await refused(bodyOf('Retail', [item(piece, { metal_rate: '1.00', labour_rate: '1.00', list_labour_rate: '1.00' })]), 'items[0].list_labour_rate');
  });

  it('a backdated bill (the owner) gets the rate of that date: the latest dated not after it; RATE_STALE when older than the bill, RATE_MISSING when none', async () => {
    const g22 = await addPiece('gold22', { nw: '10.000', retail: '353.00' });
    const g18 = await addPiece('gold18', { nw: '10.000', retail: '300.00' });
    const back = await quote(bodyOf('Retail', [item(g22, { metal_rate: '6800.00', labour_rate: '353.00' }), item(g18, { metal_rate: '5700.00', labour_rate: '300.00' })], { bill_date: '2026-10-12' }));
    expect(back.bill_date).toBe('2026-10-12');
    expect(back.list_prices[0]).toMatchObject({ list_metal_rate: '6800.00', metal_rate_date: '2026-10-10' }); // 6,920.00 is dated the 17th: after the bill
    expect(back.list_prices[1]).toMatchObject({ list_metal_rate: '0.00', metal_rate_date: null }); // no 18K rate on or before the 12th
    expect(back.warnings).toEqual(['RATE_MISSING', 'RATE_STALE']);
    const onDay = await quote(bodyOf('Retail', [item(g22, { metal_rate: '6800.00', labour_rate: '353.00' })], { bill_date: '2026-10-10' }));
    expect(onDay.list_prices[0]).toMatchObject({ list_metal_rate: '6800.00', metal_rate_date: '2026-10-10' });
    expect(onDay.warnings).toEqual([]); // dated the bill date: neither stale nor missing
  });

  it('a rate older than the bill date still pre-fills and warns RATE_STALE (20K is dated the 15th); no row at all (Custom, 925) is RATE_MISSING with list price 0.00', async () => {
    const g20 = await addPiece('gold20', { nw: '10.000', retail: '300.00' });
    const stale = await quote(bodyOf('Retail', [item(g20, { metal_rate: '6300.00', labour_rate: '300.00' })]));
    expect(stale.list_prices[0]).toMatchObject({ list_metal_rate: '6300.00', metal_rate_date: '2026-10-15' });
    expect(stale.warnings).toEqual(['RATE_STALE']);
    const custom = await addPiece('goldCustom', { nw: '10.000', retail: '300.00' });
    const s925 = await addPiece('silver925', { nw: '10.000', retail: '30.00' });
    const missing = await quote(bodyOf('Retail', [item(custom, { metal_rate: '1000.00', labour_rate: '300.00' }), item(s925, { metal_rate: '80.00', labour_rate: '30.00' })]));
    expect(missing.list_prices.map((p) => [p.list_metal_rate, p.metal_rate_date])).toEqual([['0.00', null], ['0.00', null]]);
    expect(missing.warnings).toEqual(['RATE_MISSING']);
    expect(missing.lines[0].metal_amount).toBe('10000.00'); // both warnings still price the line with the rate that was sent
  });

  it('a Per Piece line is compared on the price only: list_metal_rate is the piece price for the sale type, list_labour_rate is null, and no daily rate is looked at', async () => {
    const piece = await addPiece('silver800pp', { nw: '8.000', retail: '1200.00', semi: '1150.00', wholesale: '1100.00' });
    for (const [sale, price] of [['Retail', '1200.00'], ['Semi-Wholesale', '1150.00'], ['Wholesale', '1100.00']] as const) {
      const q = await quote(bodyOf(sale, [item(piece, { metal_rate: '1000.00' })]));
      expect(q.list_prices[0], sale).toEqual({ line_no: 1, sku_id: piece, list_metal_rate: price, list_labour_rate: null, metal_rate_date: null });
      expect(q.warnings, `${sale}: no daily rate exists for Silver 800 and none is needed`).toEqual([]);
    }
  });
});

// ------------------------------------------------------------------ T-A16, T-A18

describe('T-A16 many lines (S4)', () => {
  it('a 40-line bill totals the sum of its lines', async () => {
    const items: Item[] = [];
    const inputs: OracleLine[] = [];
    for (let i = 1; i <= 40; i++) {
      const nw = (i * 0.137).toFixed(3);
      const piece = await addPiece('gold22', { nw });
      items.push(item(piece, { metal_rate: `${6000 + i}.50`, labour_rate: `${300 + i}.25`, piroi: '1.10' }));
      inputs.push({ material: 'Gold', sellingMethod: 'By Weight', customerNetWeightMg: Math.round(i * 137), quantity: 1, metalRatePaise: (6000 + i) * 100 + 50, labourRatePaise: (300 + i) * 100 + 25, piroiPaise: 110 });
    }
    const q = await quote(bodyOf('Retail', items));
    expect(q.lines).toHaveLength(40);
    expect(q.lines.map((l) => l.line_no)).toEqual(Array.from({ length: 40 }, (_, i) => i + 1));
    expect(q.lines.reduce((sum, l) => sum + paise(l.item_total), 0n).toString()).toBe(paise(q.totals.subtotal).toString());
    const expected = oraclePrice({ saleType: 'Retail', lines: inputs, roundOffSetting: true });
    expect(q.totals.subtotal).toBe(formatRupees(expected.subtotalPaise));
    expect(q.totals.grand_total).toBe(formatRupees(expected.grandTotalPaise));
  });

  it('200 lines are accepted and 201 are rejected', async () => {
    const pieces: string[] = [];
    const rows: unknown[][] = [];
    for (let i = 0; i < 201; i++) {
      const id = randomUUID();
      counter++;
      pieces.push(id);
      rows.push([id, designs.gold22, `Q-${counter}`, `QB${counter}`, '1.000', '1.000', '10.00', '10.00', '10.00']);
    }
    await world.sql.query('INSERT INTO skus (id, design_id, sku_no, barcode, gross_weight, customer_net_weight, labour_retail, labour_semi, labour_wholesale) VALUES ?', [rows]);
    const lines = (n: number) => pieces.slice(0, n).map((p) => item(p, { metal_rate: '100.00', labour_rate: '10.00' }));
    const ok = await quote(bodyOf('Retail', lines(200)));
    expect(ok.lines).toHaveLength(200);
    expect(ok.totals.subtotal).toBe('22000.00'); // 200 x (1.000 x 100.00 + 1.000 x 10.00)
    await refused(bodyOf('Retail', lines(201)), 'items');
  });
});

describe('T-A18 computed amounts are capped (S4)', () => {
  it('100,000 g at a rate of 100,000,000 is JV_INVALID_INPUT, not an overflow', async () => {
    const piece = await addPiece('gold22', { nw: '100000.000' });
    const e = await refused(bodyOf('Retail', [item(piece, { metal_rate: '100000000.00', labour_rate: '0.00' })]), 'items[0].metal_amount');
    expect(e.message).toMatch(/cap/);
  });

  it('a line total of exactly 1,000,000,000.00 is accepted and one paisa more is rejected', async () => {
    const piece = await addPiece('gold22', { nw: '10000.000' });
    const exact = await quote(bodyOf('Retail', [item(piece, { metal_rate: '100000.00', labour_rate: '0.00' })]));
    expect(exact.lines[0]).toMatchObject({ metal_amount: '1000000000.00', item_total: '1000000000.00' });
    expect(exact.totals.grand_total).toBe('1000000000.00');
    await refused(bodyOf('Retail', [item(piece, { metal_rate: '100000.00', labour_rate: '0.00', piroi: '0.01' })]), 'items[0].item_total');
  });

  it('a subtotal of exactly 1,000,000,000.00 is accepted and one paisa more is rejected', async () => {
    const a = await addPiece('gold22', { nw: '5000.000' });
    const b = await addPiece('gold22', { nw: '5000.000' });
    const two = (extra: Body = {}) => [item(a, { metal_rate: '100000.00', labour_rate: '0.00' }), item(b, { metal_rate: '100000.00', labour_rate: '0.00', ...extra })];
    expect((await quote(bodyOf('Retail', two()))).totals.subtotal).toBe('1000000000.00');
    await refused(bodyOf('Retail', two({ other_charges: '0.01' })), 'subtotal');
  });

  it('the grand total: a subtotal of 1,000,000,000.00 plus additional charges of 0.49 is accepted (grand total 1,000,000,000.00, round-off -0.49) and 0.50 is refused', async () => {
    const piece = await addPiece('gold22', { nw: '10000.000' });
    const items = [item(piece, { metal_rate: '100000.00', labour_rate: '0.00' })];
    const ok = await quote(bodyOf('Retail', items, { additional_charges: '0.49' }));
    expect(ok.totals).toMatchObject({ subtotal: '1000000000.00', additional_charges: '0.49', grand_total: '1000000000.00', round_off: '-0.49' });
    await refused(bodyOf('Retail', items, { additional_charges: '0.50' }), 'grand_total');
  });
});

// ------------------------------------------------------------------ T-A19

describe('T-A19 per-line paise rounding, half up (R3, R5, R7)', () => {
  // Twenty lines worked out with exact fractions (NW in grams x rate per gram, rounded half up to the paisa), not with the code under test. Columns: NW, metal rate, labour rate, piroi, other
  // charges, then the exact products, then metal_amount, labour_amount, item_total.
  const LINES: [string, string, string, string, string, string, string, string][] = [
    // nw        r          l          p       o        metal(exact -> paid)              labour             total
    ['0.001', '99.50', '0.00', '0.00', '0.00', '0.10', '0.00', '0.10'], // 0.0995 -> 0.10
    ['0.001', '49.50', '0.00', '0.00', '0.00', '0.05', '0.00', '0.05'], // 0.0495 -> 0.05
    ['0.001', '49.40', '0.00', '0.00', '0.00', '0.05', '0.00', '0.05'], // 0.0494 -> 0.05
    ['0.500', '1.01', '0.00', '0.00', '0.00', '0.51', '0.00', '0.51'], // 0.505 a tie -> 0.51
    ['0.500', '1.03', '0.00', '0.00', '0.00', '0.52', '0.00', '0.52'], // 0.515 a tie -> 0.52
    ['0.500', '0.01', '0.00', '0.00', '0.00', '0.01', '0.00', '0.01'], // 0.005 a tie -> 0.01
    ['0.499', '0.01', '0.00', '0.00', '0.00', '0.00', '0.00', '0.00'], // 0.00499 -> 0.00
    ['2.505', '100.00', '0.00', '0.00', '0.00', '250.50', '0.00', '250.50'], // 250.50000 exact
    ['7.777', '123.45', '11.11', '0.00', '0.00', '960.07', '86.40', '1046.47'], // 960.07065 -> 960.07 ; 86.40247 -> 86.40
    ['35.420', '6920.00', '353.00', '2.15', '0.00', '245106.40', '12503.26', '257611.81'], // the worked example
    ['13.900', '85.00', '40.00', '0.00', '0.00', '1181.50', '556.00', '1737.50'], // 1181.5 ; 556
    ['0.333', '3.33', '3.33', '0.00', '0.00', '1.11', '1.11', '2.22'], // 1.10889 -> 1.11 twice
    ['99999.999', '99.99', '99.99', '0.00', '0.00', '9998999.90', '9998999.90', '19997999.80'], // 9998999.90001 -> .90 twice
    ['12.345', '67.89', '5.55', '1.00', '2.50', '838.10', '68.51', '910.11'], // 838.10205 ; 68.51475 -> 68.51 ; + 1.00 + 2.50
    ['4.600', '92.50', '0.00', '0.00', '0.00', '425.50', '0.00', '425.50'], // 425.5 exact
    ['1.005', '10.00', '10.00', '0.00', '0.00', '10.05', '10.05', '20.10'], // 10.05 exact twice
    ['8.125', '8.10', '8.10', '0.00', '0.00', '65.81', '65.81', '131.62'], // 65.8125 -> 65.81 twice
    ['2.675', '1.00', '1.00', '0.00', '0.00', '2.68', '2.68', '5.36'], // 2.675 a tie -> 2.68 twice
    ['1.115', '1.00', '1.00', '0.00', '0.00', '1.12', '1.12', '2.24'], // 1.115 a tie -> 1.12 twice
    ['0.250', '6919.99', '352.99', '0.01', '0.01', '1730.00', '88.25', '1818.27'], // 1729.9975 -> 1730.00 ; 88.2475 -> 88.25 ; + 0.01 + 0.01
  ];

  it('twenty single-line bills have the metal, labour and line total that were worked out', async () => {
    expect(LINES).toHaveLength(20);
    for (const [nw, r, l, p, o, metal, labour, total] of LINES) {
      const piece = await addPiece('gold22', { nw });
      const q = await quote(bodyOf('Retail', [item(piece, { metal_rate: r, labour_rate: l, piroi: p, other_charges: o })]));
      expect(q.lines[0], `${nw} g x ${r}, labour ${l}`).toMatchObject({ metal_amount: metal, labour_amount: labour, item_total: total });
      expect(q.lines[0].metal_amount).toMatch(/^\d+\.\d{2}$/);
      expect(q.lines[0].labour_amount).toMatch(/^\d+\.\d{2}$/);
    }
  });

  // Each line is rounded to the paisa BEFORE the bill is added up, so the grand total can differ by one rupee from the total of the unrounded figures.
  it('two lines of 500.245 each (0.500 g x 1,000.49): the lines are 500.25, the bill 1,000.50 is 1,001; the unrounded sum 1,000.490 would have been 1,000', async () => {
    const a = await addPiece('gold22', { nw: '0.500' });
    const b = await addPiece('gold22', { nw: '0.500' });
    const q = await quote(bodyOf('Retail', [item(a, { metal_rate: '1000.49', labour_rate: '0.00' }), item(b, { metal_rate: '1000.49', labour_rate: '0.00' })]));
    expect(q.lines.map((l) => l.item_total)).toEqual(['500.25', '500.25']);
    expect(q.totals).toMatchObject({ subtotal: '1000.50', grand_total: '1001.00', round_off: '0.50' });
  });

  it('one line of 1,000.495 (0.001 g x 1,000,495.00) is 1,000.50 and the bill 1,001; unrounded it would have been 1,000', async () => {
    const piece = await addPiece('gold22', { nw: '0.001' });
    const q = await quote(bodyOf('Retail', [item(piece, { metal_rate: '1000495.00', labour_rate: '0.00' })]));
    expect(q.lines[0].item_total).toBe('1000.50');
    expect(q.totals).toMatchObject({ grand_total: '1001.00', round_off: '0.50' });
  });

  it('the other way: lines of 6.534, 0.72319 and 10.24308 are 6.53, 0.72 and 10.24 (17.49, so 17); unrounded the sum 17.50027 would have been 18', async () => {
    const a = await addPiece('gold22', { nw: '0.099' });
    const b = await addPiece('gold22', { nw: '0.013' });
    const c = await addPiece('gold22', { nw: '0.333' });
    const q = await quote(bodyOf('Retail', [item(a, { metal_rate: '66.00', labour_rate: '0.00' }), item(b, { metal_rate: '55.63', labour_rate: '0.00' }), item(c, { metal_rate: '30.76', labour_rate: '0.00' })]));
    expect(q.lines.map((l) => l.item_total)).toEqual(['6.53', '0.72', '10.24']);
    expect(q.totals).toMatchObject({ subtotal: '17.49', grand_total: '17.00', round_off: '-0.49' });
  });
});

// ------------------------------------------------------------------ T-A09 (bill and line inputs)

describe('T-A09 bill and line inputs through quote_bill', () => {
  let piece: string;
  let perPiece: string;
  beforeAll(async () => {
    piece = await addPiece('gold22', { nw: '10.000', retail: '353.00' });
    perPiece = await addPiece('gold24pp', { nw: '5.000', retail: '1200.00' });
  });
  const base = (o: Body = {}) => item(piece, { metal_rate: '6920.00', labour_rate: '353.00', ...o });

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
    it(`items[].${field}: ${badMoney(cap).map(([n]) => n).join(', ')} are JV_INVALID_INPUT`, async () => {
      for (const [name, value] of badMoney(cap)) {
        const e = await refused(bodyOf('Retail', [base({ [field]: value })]), `items[0].${field}`);
        if (typeof value === 'string' && value.trim() !== '' && value !== '.5' && value !== '5.') expect(e.message, `${field} ${name}: the message repeats the value`).not.toContain(value.trim());
      }
    });
  }

  it('items[].quantity: 0, -1, 1,001, 1.5 and the text "2" are JV_INVALID_INPUT; By Weight with quantity 2 is rejected too (R6)', async () => {
    for (const q of [0, -1, 1001, 1.5, '2', null]) await refused(bodyOf('Retail', [item(perPiece, { metal_rate: '1200.00', quantity: q })]), 'items[0].quantity');
    await refused(bodyOf('Retail', [base({ quantity: 2 })]), 'items[0].quantity');
    expect((await quote(bodyOf('Retail', [item(perPiece, { metal_rate: '1200.00', quantity: 1000 })]))).lines[0].item_total).toBe('1200000.00'); // 1,000 is the largest quantity
  });

  for (const field of ['discount', 'additional_charges'] as const) {
    it(`${field}: negative, over the cap, three decimals, a trailing zero, a JSON number are JV_INVALID_INPUT`, async () => {
      for (const [, value] of badMoney('1000000000.01').slice(0, 5)) await refused(bodyOf('Retail', [base()], { [field]: value }), field);
    });
  }

  it('a weight cannot be sent (the net weight is the piece\'s, never the client\'s): customer_net_weight, gross_weight and weight are unknown fields, negative or over the cap or fine', async () => {
    for (const w of ['-1.000', '100000.001', '10.000']) {
      await refused(bodyOf('Retail', [base({ customer_net_weight: w })]), 'items[0].customer_net_weight');
      await refused(bodyOf('Retail', [base({ gross_weight: w })]), 'items[0].gross_weight');
      await refused(bodyOf('Retail', [base({ weight: w })]), 'items[0].weight');
    }
  });

  it('a By Weight line without labour_rate is refused; a Per Piece line does not need one', async () => {
    await refused(bodyOf('Retail', [item(piece, { metal_rate: '6920.00' })]), 'items[0].labour_rate');
    const q = await quote(bodyOf('Retail', [item(perPiece, { metal_rate: '1200.00' })]));
    expect(q.lines[0]).toMatchObject({ labour_rate: '0.00', metal_amount: '1200.00' });
  });

  it('metal_rate is required on every line', async () => {
    await refused(bodyOf('Retail', [item(piece, { labour_rate: '353.00' })]), 'items[0].metal_rate');
    await refused(bodyOf('Retail', [item(perPiece, {})]), 'items[0].metal_rate');
  });

  it('an absent piroi, other_charges and quantity mean 0.00, 0.00 and 1', async () => {
    const q = await quote(bodyOf('Retail', [item(perPiece, { metal_rate: '1200.00' })]));
    expect(q.lines[0]).toMatchObject({ piroi: '0.00', other_charges: '0.00', quantity: 1, item_total: '1200.00' });
    const w = await quote(bodyOf('Retail', [item(piece, { metal_rate: '6920.00', labour_rate: '353.00' })]));
    expect(w.lines[0]).toMatchObject({ piroi: '0.00', other_charges: '0.00', quantity: 1 });
    expect(w.totals).toMatchObject({ discount: '0.00', additional_charges: '0.00' });
  });

  it('the list of lines: none, 201, not a list, and a piece twice are JV_INVALID_INPUT', async () => {
    await refused(bodyOf('Retail', []), 'items');
    await refused({ sale_type: 'Retail' }, 'items');
    await refused({ sale_type: 'Retail', items: base() }, 'items');
    await refused(bodyOf('Retail', Array.from({ length: 201 }, () => base())), 'items');
    await refused(bodyOf('Retail', [base(), item(perPiece, { metal_rate: '1.00' }), base()]), 'items[2].sku_id');
  });

  it('a piece that does not exist, an id that is not a lower-case UUID, a missing sale_type, a wrong one and an unknown field anywhere are JV_INVALID_INPUT', async () => {
    await refused(bodyOf('Retail', [item(randomUUID(), { metal_rate: '1.00', labour_rate: '1.00' })]), 'items[0].sku_id');
    await refused(bodyOf('Retail', [item(piece.toUpperCase(), { metal_rate: '1.00', labour_rate: '1.00' })]), 'items[0].sku_id');
    await refused({ items: [base()] }, 'sale_type');
    for (const s of ['retail', 'Retail ', 'Credit', '', 5]) await refused(bodyOf(s as string, [base()]), 'sale_type');
    await refused(bodyOf('Retail', [base()], { customer_id: randomUUID() }), 'customer_id');
    await refused(bodyOf('Retail', [base()], { payments: [] }), 'payments');
    await refused(bodyOf('Retail', [base({ extra: 1 })]), 'items[0].extra');
    const notAnObject = await world.call('owner', 'POST', '/v1/bills/quote', { payload: JSON.stringify('not an object'), headers: { 'content-type': 'application/json' } });
    expect(notAnObject.statusCode).toBe(422);
    expect(errorOf(notAnObject)).toMatchObject({ code: 'JV_INVALID_INPUT', details: { field: 'body' } });
  });

  it('bill_date: an impossible date and a future date are refused; a biller can only use today (Y8) and the owner any date up to today', async () => {
    await refused(bodyOf('Retail', [base()], { bill_date: '2026-02-30' }), 'bill_date');
    await refused(bodyOf('Retail', [base()], { bill_date: '17-10-2026' }), 'bill_date');
    await refused(bodyOf('Retail', [base()], { bill_date: '2026-10-18' }), 'bill_date'); // tomorrow
    await refused(bodyOf('Retail', [base()], { bill_date: '2026-10-18' }), 'bill_date', 'biller');
    await refused(bodyOf('Retail', [base()], { bill_date: '2026-10-16' }), 'bill_date', 'biller'); // yesterday
    expect((await quote(bodyOf('Retail', [base()], { bill_date: '2026-10-16' }), 'owner')).bill_date).toBe('2026-10-16');
    expect((await quote(bodyOf('Retail', [base()], { bill_date: TODAY }), 'biller')).bill_date).toBe(TODAY);
    expect((await quote(bodyOf('Retail', [base()], { bill_date: null }), 'biller')).bill_date).toBe(TODAY); // null means today
  });

  it('a body that fails the parser never touches the piece rows or the rates', async () => {
    const before = world.spy.sent.length;
    await refused(bodyOf('Retail', [base({ metal_rate: '-1.00' })]), 'items[0].metal_rate');
    const sqls = world.spy.sqls().slice(before);
    expect(sqls.some((s) => /\bFROM\s+(skus|daily_rates|settings|designs)\b/i.test(s)), sqls.join(' | ')).toBe(false);
  });
});

// ------------------------------------------------------------------ T-A14 (`me`), T-A15 (versions)

describe('T-A14 GET /v1/auth/me returns the hash of pricing.ts', () => {
  it('pricing_sha256 is the SHA-256 of src/domain/pricing.ts and the one PRICING-SOURCE.txt names', async () => {
    const res = await world.call('biller', 'GET', '/v1/auth/me');
    expect(res.statusCode).toBe(200);
    const hash = sha256(readFileSync(`${REPO}src/domain/pricing.ts`));
    expect((res.json() as { pricing_sha256: string }).pricing_sha256).toBe(hash);
    expect(readFileSync(`${REPO}PRICING-SOURCE.txt`, 'utf8')).toContain(hash);
  });
});

describe('T-A15 quote_bill takes the pricing version as a parameter (R13)', () => {
  // A second application over the same database and the same users, with a test-only version 2 in its version table: grand total rounded UP to the next rupee instead of to the nearest. The
  // application's own table holds version 1 alone, so a version that is not in it is refused.
  const priceBillV2 = (input: RealInput): PricedBill => {
    const v1 = priceBill(input);
    const up = Math.ceil(v1.beforeRoundPaise / 100) * 100;
    return { ...v1, pricingVersion: 2, grandTotalPaise: up, roundOffPaise: input.roundOffSetting ? up - v1.beforeRoundPaise : 0 };
  };
  const apps: ReturnType<typeof buildApp>[] = [];
  async function appWith(versions: Parameters<typeof registerQuoteBill>[1]) {
    const app = buildApp({ config: testConfig({ logLevel: 'silent' }), db: createDbPool(world.scratch.db), clock: createClock(() => T0), routes: false });
    registerQuoteBill(app, versions);
    await app.ready();
    apps.push(app);
    return app;
  }
  afterAll(async () => {
    for (const a of apps) await a.close().catch(() => undefined);
  });
  const callOn = (app: ReturnType<typeof buildApp>, body: unknown) =>
    app.inject({ method: 'POST', url: '/v1/bills/quote', payload: body as object, headers: { ...csrfHeaders(), cookie: world.cookieOf('owner')! } });

  let bill: Body;
  beforeAll(async () => {
    const piece = await addPiece('gold24pp', { nw: '5.000', retail: '1000.40' });
    bill = bodyOf('Retail', [item(piece, { metal_rate: '1000.40' })]); // before_round 1,000.40
  });

  it('the application\'s version table holds version 1 alone: no pricing_version and 1 are the same quote, 2 and 0 are refused, and so are a text and a fraction', async () => {
    expect(Object.keys(PRICING_VERSIONS)).toEqual(['1']);
    const plain = await quote(bill);
    const one = await quote({ ...bill, pricing_version: 1 });
    expect(one).toEqual(plain);
    expect(plain.pricing_version).toBe(1);
    expect(plain.totals).toMatchObject({ subtotal: '1000.40', grand_total: '1000.00', round_off: '-0.40' });
    for (const v of [2, 0, -1, 1.5, '1', null, 32768]) await refused({ ...bill, pricing_version: v }, 'pricing_version');
  });

  it('with version 2 registered, pricing_version 2 selects it and 1 (or none) still selects version 1', async () => {
    const app = await appWith({ versions: { ...PRICING_VERSIONS, 2: priceBillV2 } });
    const two = (await callOn(app, { ...bill, pricing_version: 2 })).json() as Quote;
    expect(two.pricing_version).toBe(2);
    expect(two.totals).toMatchObject({ subtotal: '1000.40', grand_total: '1001.00', round_off: '0.60' });
    const none = (await callOn(app, bill)).json() as Quote;
    expect(none.pricing_version).toBe(1);
    expect(none.totals).toMatchObject({ grand_total: '1000.00', round_off: '-0.40' });
    const one = (await callOn(app, { ...bill, pricing_version: 1 })).json() as Quote;
    expect(one).toEqual(none);
  });

  it('control: a table whose version 2 prices like version 1 is caught by the same comparison (the dispatch can fail)', async () => {
    const same = await appWith({ versions: { ...PRICING_VERSIONS, 2: (input) => ({ ...priceBill(input), pricingVersion: 2 }) } });
    const two = (await callOn(same, { ...bill, pricing_version: 2 })).json() as Quote;
    expect(two.pricing_version).toBe(2);
    expect(two.totals.grand_total, 'a dispatch that ignored the rule of version 2 gives the grand total of version 1').toBe('1000.00');
    expect(two.totals.grand_total).not.toBe('1001.00');
  });

  it('a version function that answers another version than the one asked for is a bug (JV_INTERNAL), never a quote', async () => {
    const wrong = await appWith({ versions: { ...PRICING_VERSIONS, 2: priceBill } });
    const res = await callOn(wrong, { ...bill, pricing_version: 2 });
    expect(res.statusCode).toBe(500);
    expect(errorOf(res).code).toBe('JV_INTERNAL');
  });
});

// ------------------------------------------------------------------ T-D09, reads only

describe('T-D09 the matrix row of X7 (POST /v1/bills/quote: owner and biller)', () => {
  let piece: string;
  beforeAll(async () => {
    piece = await addPiece('gold22', { nw: '3.000', retail: '100.00' });
  });
  const valid = () => bodyOf('Retail', [item(piece, { metal_rate: '100.00', labour_rate: '100.00' })]);

  it('the route is registered through route() with the action of the row', () => {
    const r = world.app.routeTable.find((x) => x.action === 'fn:quote_bill');
    expect(r).toMatchObject({ method: 'POST', url: '/v1/bills/quote', kind: 'matrix', roles: ['owner', 'biller'], mustChange: false });
  });

  it('no session is 401 JV_UNAUTHENTICATED, staff is 403 JV_FORBIDDEN, a user who must change the password is 403 JV_PASSWORD_CHANGE_REQUIRED, and none of them reads a piece', async () => {
    for (const [caller, status, code] of [['anon', 401, 'JV_UNAUTHENTICATED'], ['ended', 401, 'JV_UNAUTHENTICATED'], ['expired', 401, 'JV_SESSION_EXPIRED'], ['inactive', 401, 'JV_UNAUTHENTICATED'], ['staff', 403, 'JV_FORBIDDEN'], ['must_change', 403, 'JV_PASSWORD_CHANGE_REQUIRED']] as const) {
      const before = world.spy.sent.length;
      const res = await post(valid(), caller);
      expect(res.statusCode, caller).toBe(status);
      expect(errorOf(res).code, caller).toBe(code);
      await world.restore(caller);
      expect(world.spy.sqls().slice(before).some((s) => /\bFROM\s+(skus|daily_rates|settings)\b/i.test(s)), `${caller} caused a read of the pieces`).toBe(false);
    }
  });

  it('the owner and the biller get the same quote', async () => {
    const owner = await quote(valid(), 'owner');
    const biller = await quote(valid(), 'biller');
    expect(biller).toEqual(owner);
    expect(owner.totals.grand_total).toBe('600.00');
  });
});

describe('X7 reads only: plain SELECTs, no lock, no write, no number used, and nothing of the owner-only weight (T-A15, T-D03 clauses)', () => {
  const TABLES = ['bills', 'bill_items', 'receipts', 'receipt_allocations', 'customers', 'skus', 'designs', 'daily_rates', 'settings', 'sys_counters', 'sys_idempotency', 'audit_log', 'sku_private'];
  const counts = async () => {
    const out: Record<string, number> = {};
    for (const t of TABLES) out[t] = Number(((await world.sql.query<any[]>(`SELECT COUNT(*) AS n FROM ${t}`))[0] as any[])[0].n);
    return out;
  };

  it('every statement the handler sends is a SELECT without a lock, none touches sku_private, and the tables are as they were', async () => {
    const piece = await addPiece('gold22', { nw: '12.345', retail: '10.00' });
    await world.sql.query('INSERT INTO sku_private (sku_id, original_net_weight) VALUES (?, ?)', [piece, '98.765']);
    const before = await counts();
    const sentBefore = world.spy.sent.length;
    const res = await post(bodyOf('Retail', [item(piece, { metal_rate: '6920.00', labour_rate: '10.00' })]), 'biller');
    expect(res.statusCode, res.body).toBe(200);
    const mine = world.spy.sqls().slice(sentBefore).map((s) => s.trim()).filter((s) => !/^SET SESSION\b/i.test(s) && !/^SELECT\b[\s\S]*\bFROM\s+(sessions|users)\b/i.test(s) && !/^UPDATE\s+sessions\s+SET\s+last_seen_at\b/i.test(s));
    expect(mine.length).toBeGreaterThan(0);
    for (const s of mine) {
      expect(s, 'a statement that is not a plain SELECT').toMatch(/^SELECT\b/i);
      expect(s, 'a statement that locks').not.toMatch(/\bFOR\s+UPDATE\b|\bLOCK\s+IN\s+SHARE\s+MODE\b|\bFOR\s+SHARE\b/i);
      expect(s, 'a statement that reads the owner-only weight').not.toMatch(/sku_private|original_net_weight/i);
    }
    expect(res.body).not.toContain('98.765');
    expect(res.body).not.toContain('original_net_weight');
    expect(await counts()).toEqual({ ...before });
  });
});

// ------------------------------------------------------------------ T-A14: 200 random inputs

describe('T-A14 200 random bills through quote_bill equal the independent oracle (R12)', () => {
  it('every line and total of 200 random bills (some at the caps, some over them) equals oracle/exact-decimal.ts, and a bill the oracle refuses is JV_INVALID_INPUT', async () => {
    const rand = rng(20261017);
    const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)];
    const KINDS = [
      { design: 'gold22', material: 'Gold', method: 'By Weight' },
      { design: 'gold18', material: 'Gold', method: 'By Weight' },
      { design: 'silver999', material: 'Silver', method: 'By Weight' },
      { design: 'silver925', material: 'Silver', method: 'By Weight' },
      { design: 'silver800pp', material: 'Silver', method: 'Per Piece' },
      { design: 'gold24pp', material: 'Gold', method: 'Per Piece' },
    ] as const;
    const paiseText = (n: number) => formatRupees(n);

    let compared = 0;
    let refusedBills = 0;
    let lines = 0;
    for (let bill = 0; bill < 200; bill++) {
      const sale = pick(['Retail', 'Semi-Wholesale', 'Wholesale'] as const);
      const count = 1 + Math.floor(rand() * 6);
      const items: Item[] = [];
      const inputs: OracleLine[] = [];
      for (let i = 0; i < count; i++) {
        const kind = pick(KINDS);
        const wide = rand() < 0.06;
        const nwMg = Math.floor(rand() * (wide ? 100_000_000 : 400_000));
        const labour = [Math.floor(rand() * 90_000), Math.floor(rand() * 90_000), Math.floor(rand() * 90_000)];
        const sku = await addPiece(kind.design, { nw: formatGrams(nwMg), retail: paiseText(labour[0]), semi: paiseText(labour[1]), wholesale: paiseText(labour[2]) });
        const byWeight = kind.method === 'By Weight';
        const rate = Math.floor(rand() * (wide ? 100_000_000 : 1_500_000));
        const labourRate = Math.floor(rand() * 90_000);
        const piroi = rand() < 0.6 ? Math.floor(rand() * 20_000) : undefined;
        const other = rand() < 0.3 ? Math.floor(rand() * 50_000) : undefined;
        const quantity = byWeight ? undefined : rand() < 0.7 ? 1 + Math.floor(rand() * 20) : undefined;
        items.push(item(sku, { metal_rate: paiseText(rate), ...(byWeight ? { labour_rate: paiseText(labourRate) } : {}), ...(piroi === undefined ? {} : { piroi: paiseText(piroi) }), ...(other === undefined ? {} : { other_charges: paiseText(other) }), ...(quantity === undefined ? {} : { quantity }) }));
        inputs.push({ material: kind.material, sellingMethod: kind.method, customerNetWeightMg: nwMg, quantity: quantity ?? 1, metalRatePaise: rate, labourRatePaise: byWeight ? labourRate : 0, piroiPaise: piroi ?? 0, otherChargesPaise: other ?? 0 });
      }
      const additional = rand() < 0.3 ? Math.floor(rand() * 100_000) : 0;
      let expected;
      try {
        expected = oraclePrice({ saleType: sale, lines: inputs, additionalChargesPaise: additional, roundOffSetting: true });
      } catch (e) {
        expect(e).toBeInstanceOf(OraclePricingError);
        const res = await post(bodyOf(sale, items, additional ? { additional_charges: paiseText(additional) } : {}));
        expect(res.statusCode, `bill ${bill}: the oracle refuses it, so must quote_bill: ${res.body}`).toBe(422);
        expect(errorOf(res).code).toBe('JV_INVALID_INPUT');
        refusedBills++;
        continue;
      }
      const discount = rand() < 0.4 ? Math.floor(rand() * (expected.subtotalPaise + additional)) : 0;
      expected = oraclePrice({ saleType: sale, lines: inputs, additionalChargesPaise: additional, discountPaise: discount, roundOffSetting: true });
      const q = await quote(bodyOf(sale, items, { ...(additional ? { additional_charges: paiseText(additional) } : {}), ...(discount ? { discount: paiseText(discount) } : {}) }));
      expect(q.lines, `bill ${bill}`).toHaveLength(expected.lines.length);
      expected.lines.forEach((e, i) => {
        expect(q.lines[i], `bill ${bill} line ${i + 1}`).toMatchObject({
          quantity: e.quantity,
          labour_amount: formatRupees(e.labourAmountPaise),
          metal_amount: formatRupees(e.metalAmountPaise),
          fine_weight_due: formatGrams(e.fineWeightDueMg),
          item_total: formatRupees(e.itemTotalPaise),
          piroi: formatRupees(e.piroiPaise),
          other_charges: formatRupees(e.otherChargesPaise),
        });
        lines++;
      });
      expect(q.totals, `bill ${bill}`).toEqual({
        subtotal: formatRupees(expected.subtotalPaise),
        discount: formatRupees(expected.discountPaise),
        additional_charges: formatRupees(expected.additionalChargesPaise),
        grand_total: formatRupees(expected.grandTotalPaise),
        round_off: formatRupees(expected.roundOffPaise),
        fine_weight_due: formatGrams(expected.fineWeightDueMg),
      });
      compared++;
    }
    console.log(`[T-A14] 200 random bills through quote_bill: ${compared} equal the oracle (${lines} lines), ${refusedBills} refused by both for a cap`);
    expect(compared + refusedBills).toBe(200);
    expect(compared).toBeGreaterThan(120);
  }, 300_000);
});
