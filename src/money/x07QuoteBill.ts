// X7 quote_bill (POST /v1/bills/quote), R2, R12, R13, R14, C12: what create_bill would price, without saving anything.
//
// It is read-only and takes no Idempotency-Key: the piece rows, the daily rates and the round-off setting are read with plain SELECTs (no lock, no transaction, no write), and the bill is priced by the
// same priceBill of src/domain/pricing.ts that create_bill (X1) calls, so a quote and a saved bill cannot differ (R12). It answers the lines, the totals, the list prices and the warnings:
//
//   { pricing_version, bill_date, sale_type,
//     lines:       [{ line_no, sku_id, sku_no, material, purity, selling_method, customer_net_weight, quantity, metal_rate, labour_rate, piroi, other_charges,
//                     labour_amount, metal_amount, fine_weight_due, item_total }],
//     totals:      { subtotal, discount, additional_charges, grand_total, round_off, fine_weight_due },
//     list_prices: [{ line_no, sku_id, list_metal_rate, list_labour_rate, metal_rate_date }],
//     warnings:    ['RATE_MISSING' | 'RATE_STALE', ...] }
//
// Money and weight are texts with 2 and 3 decimals (S3). The material, purity, selling method and net weight of a line are the PIECE's (never the client's: a weight is not an input, and a field that is not
// listed below is refused); the client sends the rates and charges. Inputs (X7, NODE-DESIGN 4.3): sale_type; items [sku_id, metal_rate (required), labour_rate (required for a By Weight line, ignored for a
// Per Piece line), piroi, other_charges, quantity]; bill_date (default and null: today); discount; additional_charges; pricing_version (default: the current one). An absent piroi, other_charges, discount
// and additional_charges are 0.00 and an absent quantity is 1.
//
// LIST PRICES (R14) are the server's, never the client's. For a By Weight line, list_metal_rate is the daily rate (R2) of the piece's material and purity with the latest rate_date not after the bill date,
// and list_labour_rate is the piece's labour rate for the sale type (R1, the chain of defaultLabourRate); a rate dated before the bill date adds the warning RATE_STALE, and none at all (Custom, a purity with
// no row) adds RATE_MISSING and a list_metal_rate of 0.00 (the column is NOT NULL, and a price of 0 can never be "sold below"). For a Per Piece line list_metal_rate is the piece price for the sale type and
// list_labour_rate is null (the line is compared on the price only), and no daily rate is looked at. metal_rate_date is the date of the daily rate used (null for a Per Piece line and for none).
//
// VERSIONS (R13): pricing_version selects the pricing function from a version table. The application's table (PRICING_VERSIONS) holds the version of the shared file, 1; a bill stores the version it was priced
// with (API20), and a rule change becomes version 2 with its own function, so the check on old bills (I6) keeps pricing them as version 1. A test registers a version 2 for itself by passing its own table to
// registerQuoteBill (T-A15); nothing in a request can add one.
//
// The date follows Y8 as create_bill does: a future date is refused for everybody, and a past date for a caller who may not back-date (mayUseField). Unlike create_bill this does not look at whether a piece
// can be billed (R10: a Sold or Reserved piece is priced like any other): that is the job of the lock in X1.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { BILL_PREFIX_PATTERN } from '../db/numbers.js';
import type { DbPool } from '../db/pool.js';
import { type Reader, txContextFor, withRead } from '../db/tx.js';
import {
  CURRENT_PRICING_VERSION,
  type Material,
  type PriceBillInput,
  type PriceLineInput,
  type PricedBill,
  PricingError,
  type SaleType,
  type SellingMethod,
  defaultLabourRate,
  defaultMetalRate,
  parseGrams,
  parseRupees,
  priceBill,
} from '../domain/pricing.js';
import { unavailableError } from '../errors.js';
import { mayUseField } from '../permissions/matrix.js';
import { assertMayCall, route } from '../permissions/route.js';
import { formatMoneyFromPaise, formatWeightFromMilligrams } from '../wire/format.js';
import * as wire from '../wire/zod.js';

// ------------------------------------------------------------------ versions (R13)

/** A pricing function of one version: the bill in, the priced bill out (its pricingVersion is the version it is for). */
export type PricingFunction = (input: PriceBillInput) => PricedBill;
export type VersionTable = Readonly<Record<number, PricingFunction>>;

/** The versions this API prices: the one of the shared file (pricing_version 1 for the rules of section 8). Version 2 gets its own function here when a rule changes (R13). */
export const PRICING_VERSIONS: VersionTable = Object.freeze({ [CURRENT_PRICING_VERSION]: priceBill });

/** Prices the bill with the function of `version`. The version is checked after the pricing too, so a table that puts a function under the wrong number is a bug and never a quote. */
export function priceWithVersion(table: VersionTable, version: number, input: PriceBillInput): PricedBill {
  const price = Object.hasOwn(table, version) ? table[version] : undefined;
  if (!price) throw new wire.InvalidInputError('pricing_version', 'is not a version this API prices');
  const { pricingVersion: _ignored, ...withoutVersion } = input;
  const priced = price(withoutVersion);
  if (priced.pricingVersion !== version) throw new Error(`the pricing function registered for version ${version} priced version ${priced.pricingVersion}`);
  return priced;
}

// ------------------------------------------------------------------ the call

const SALE_TYPES = ['Retail', 'Semi-Wholesale', 'Wholesale'] as const;
const saleTypeMessage = `must be one of ${SALE_TYPES.join(', ')}`;
const versionMessage = 'must be a whole number from 1 to 32,767';

const quoteItem = wire.strictObject({
  sku_id: wire.uuid,
  metal_rate: wire.rate,
  labour_rate: wire.rate.optional(),
  piroi: wire.amount.optional(),
  other_charges: wire.amount.optional(),
  quantity: wire.quantity.optional(),
});

export const quoteBody = wire.strictObject({
  sale_type: z.enum(SALE_TYPES, { error: (issue) => (issue.input === undefined ? 'is required' : saleTypeMessage) }),
  items: wire.billLines(quoteItem),
  bill_date: wire.businessDate.nullish(),
  discount: wire.amount.optional(),
  additional_charges: wire.amount.optional(),
  pricing_version: z
    .number({ error: (issue) => (issue.input === undefined ? 'is required' : versionMessage) })
    .int(versionMessage)
    .min(1, versionMessage)
    .max(32767, versionMessage)
    .optional(),
});

export type QuoteItem = z.output<typeof quoteItem>;

/** The columns of a piece that pricing needs: the piece's own figures and the labour rates it carries for the three sale types (D7, R1). */
export interface PieceRow {
  id: string;
  sku_no: string;
  customer_net_weight: string;
  labour_retail: string;
  labour_semi: string;
  labour_wholesale: string;
  material: string;
  purity: string;
  selling_method: string;
}

/** The latest daily rate of a material and purity dated not after the bill date, as the table has it. */
export interface RateRow {
  rate_per_gram: string;
  rate_date: string;
}

const PIECES_SQL = (count: number) =>
  `SELECT s.id, s.sku_no, s.customer_net_weight, s.labour_retail, s.labour_semi, s.labour_wholesale, d.material, d.purity, d.selling_method FROM skus s JOIN designs d ON d.id = s.design_id WHERE s.id IN (${Array.from({ length: count }, () => '?').join(', ')})`;
const RATE_SQL = 'SELECT rate_per_gram, rate_date FROM daily_rates WHERE material = ? AND purity = ? AND rate_date <= ? ORDER BY rate_date DESC LIMIT 1';
const SETTING_SQL = "SELECT value FROM settings WHERE setting_key = 'estimate'";

/** The key of a rate in the map of buildQuote. */
export const rateKey = (material: string, purity: string) => `${material}\u0000${purity}`;

export interface QuoteLine {
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

export interface ListPrice {
  line_no: number;
  sku_id: string;
  list_metal_rate: string;
  list_labour_rate: string | null;
  metal_rate_date: string | null;
}

export interface Quote {
  pricing_version: number;
  bill_date: string;
  sale_type: SaleType;
  lines: QuoteLine[];
  totals: { subtotal: string; discount: string; additional_charges: string; grand_total: string; round_off: string; fine_weight_due: string };
  list_prices: ListPrice[];
  warnings: ('RATE_MISSING' | 'RATE_STALE')[];
}

export interface QuoteInput {
  saleType: SaleType;
  billDate: string;
  version: number;
  versions: VersionTable;
  items: readonly QuoteItem[];
  discount?: string;
  additionalCharges?: string;
  /** `settings.estimate.roundOff` (R8). */
  roundOff: boolean;
  /** The rows of the pieces named by the items, by id. */
  pieces: ReadonlyMap<string, PieceRow>;
  /** The latest daily rate of each material and purity (rateKey) dated not after billDate; absent or null when there is none. */
  rates: ReadonlyMap<string, RateRow | null>;
}

const thousands = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/** The name of an input of pricing.ts as the caller knows it: `lines[2].metalAmountPaise` is `items[2].metal_amount`, `subtotalPaise` is `subtotal`. */
function wireField(field: string): string {
  const dot = field.lastIndexOf('.');
  const head = dot < 0 ? '' : field.slice(0, dot + 1).replace(/^lines/, 'items');
  const leaf = dot < 0 ? field : field.slice(dot + 1);
  const name = leaf === 'lines' ? 'items' : leaf.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`).replace(/_(paise|mg)$/, '');
  return head + name;
}

/** A refusal of pricing.ts as the S8 refusal of this call: the field by its wire name, the reason without the units of the integers (a cap of paise is told in rupees). */
function invalidFrom(e: PricingError): wire.InvalidInputError {
  const reason = e.message.slice(`JV_INVALID_INPUT: ${e.field} `.length).replace(/cap of (\d+)/, (_m, n: string) => `cap of ${thousands(Number(n) / 100)}`);
  return new wire.InvalidInputError(wireField(e.field), reason);
}

/** A weight from the database (DECIMAL text with 3 decimals) as the wire has it. */
const wireWeight = (text: string) => formatWeightFromMilligrams(parseGrams(text));

/**
 * The quote from the rows that were read: the one place the list prices, the warnings and the response are made. create_bill (X1) calls it with the rows it has locked, so its answer and a quote are made by
 * the same code. Throws InvalidInputError for anything pricing.ts refuses (a cap, a By Weight line without labour_rate, a quantity above 1 on a By Weight piece, a discount above the total) and for a piece
 * that is not in `pieces`.
 */
export function buildQuote(input: QuoteInput): Quote {
  const { saleType, billDate } = input;
  const warnings = new Set<'RATE_MISSING' | 'RATE_STALE'>();
  const listPrices: ListPrice[] = [];
  const pieces: PieceRow[] = [];
  const echo: { metalRatePaise: number; labourRatePaise: number }[] = [];

  const lines = input.items.map((item, i): PriceLineInput => {
    const at = `items[${i}]`;
    const piece = input.pieces.get(item.sku_id);
    if (!piece) throw new wire.InvalidInputError(`${at}.sku_id`, 'is not a piece');
    pieces.push(piece);
    const byWeight = piece.selling_method === 'By Weight';
    // R1: the piece's rate for the sale type. For a By Weight piece it is the labour rate per gram, for a Per Piece piece the piece price (D7, R2).
    const ownText = defaultLabourRate({ retailLabour: piece.labour_retail, semiWholesaleLabour: piece.labour_semi, wholesaleLabour: piece.labour_wholesale }, saleType);
    if (ownText === null) throw new Error(`the piece ${piece.id} has no labour rate for ${saleType}`);
    const ownPaise = parseRupees(ownText, { field: 'labour' });
    if (byWeight) {
      // R2: the rate dated not after the bill date; the same defaultMetalRate the screen uses on its cache
      const row = input.rates.get(rateKey(piece.material, piece.purity));
      const rate = defaultMetalRate(row ? [{ material: piece.material, purity: piece.purity, ratePerGram: row.rate_per_gram, rateDate: row.rate_date }] : [], piece.material, piece.purity, billDate);
      if (rate.status === 'missing') warnings.add('RATE_MISSING');
      if (rate.status === 'stale') warnings.add('RATE_STALE');
      listPrices.push({ line_no: i + 1, sku_id: piece.id, list_metal_rate: formatMoneyFromPaise(rate.ratePaise ?? 0), list_labour_rate: formatMoneyFromPaise(ownPaise), metal_rate_date: rate.rateDate });
    } else {
      listPrices.push({ line_no: i + 1, sku_id: piece.id, list_metal_rate: formatMoneyFromPaise(ownPaise), list_labour_rate: null, metal_rate_date: null });
    }
    const metalRatePaise = parseRupees(item.metal_rate, { field: `${at}.metal_rate` });
    const labourRatePaise = item.labour_rate === undefined ? undefined : parseRupees(item.labour_rate, { field: `${at}.labour_rate` });
    echo.push({ metalRatePaise, labourRatePaise: byWeight ? (labourRatePaise ?? 0) : 0 });
    return {
      material: piece.material as Material,
      sellingMethod: piece.selling_method as SellingMethod,
      customerNetWeightMg: parseGrams(piece.customer_net_weight, { field: `${at}.customer_net_weight` }),
      quantity: item.quantity,
      metalRatePaise,
      labourRatePaise,
      piroiPaise: item.piroi === undefined ? undefined : parseRupees(item.piroi, { field: `${at}.piroi` }),
      otherChargesPaise: item.other_charges === undefined ? undefined : parseRupees(item.other_charges, { field: `${at}.other_charges` }),
    };
  });

  let priced: PricedBill;
  try {
    priced = priceWithVersion(input.versions, input.version, {
      saleType,
      lines,
      discountPaise: input.discount === undefined ? undefined : parseRupees(input.discount, { field: 'discount' }),
      additionalChargesPaise: input.additionalCharges === undefined ? undefined : parseRupees(input.additionalCharges, { field: 'additional_charges' }),
      roundOffSetting: input.roundOff,
    });
  } catch (e) {
    throw e instanceof PricingError ? invalidFrom(e) : e;
  }

  return {
    pricing_version: priced.pricingVersion,
    bill_date: billDate,
    sale_type: saleType,
    lines: priced.lines.map((l, i) => ({
      line_no: i + 1,
      sku_id: pieces[i].id,
      sku_no: pieces[i].sku_no,
      material: pieces[i].material,
      purity: pieces[i].purity,
      selling_method: pieces[i].selling_method,
      customer_net_weight: wireWeight(pieces[i].customer_net_weight),
      quantity: l.quantity,
      metal_rate: formatMoneyFromPaise(echo[i].metalRatePaise),
      labour_rate: formatMoneyFromPaise(echo[i].labourRatePaise),
      piroi: formatMoneyFromPaise(l.piroiPaise),
      other_charges: formatMoneyFromPaise(l.otherChargesPaise),
      labour_amount: formatMoneyFromPaise(l.labourAmountPaise),
      metal_amount: formatMoneyFromPaise(l.metalAmountPaise),
      fine_weight_due: formatWeightFromMilligrams(l.fineWeightDueMg),
      item_total: formatMoneyFromPaise(l.itemTotalPaise),
    })),
    totals: {
      subtotal: formatMoneyFromPaise(priced.subtotalPaise),
      discount: formatMoneyFromPaise(priced.discountPaise),
      additional_charges: formatMoneyFromPaise(priced.additionalChargesPaise),
      grand_total: formatMoneyFromPaise(priced.grandTotalPaise),
      round_off: formatMoneyFromPaise(priced.roundOffPaise),
      fine_weight_due: formatWeightFromMilligrams(priced.fineWeightDueMg),
    },
    list_prices: listPrices,
    warnings: [...warnings].sort(),
  };
}

/** X1 (a): each piece appears once in the list (a piece twice is JV_INVALID_INPUT and not a raw duplicate-key error). */
export function assertEachPieceOnce(items: readonly { sku_id: string }[]): void {
  const seen = new Set<string>();
  items.forEach((item, i) => {
    if (seen.has(item.sku_id)) throw new wire.InvalidInputError(`items[${i}].sku_id`, 'is on the bill twice: a piece is billed once');
    seen.add(item.sku_id);
  });
}

/** Y8: a future date is refused; a past date only for a caller who may back-date. Returns the date (today when none was sent). `field` names the input in the refusal: `bill_date` (X1, X7) or `paid_on` (X2, X3). */
export function checkBillDate(sent: string | null | undefined, today: string, role: string, field = 'bill_date'): string {
  const date = sent ?? today;
  if (date > today) throw new wire.InvalidInputError(field, 'must not be in the future');
  if (date < today && !mayUseField(role, 'back_dates')) throw new wire.InvalidInputError(field, 'must be today');
  return date;
}

/** The value of the `estimate` setting as an object, whether the driver parsed the JSON or not; anything else is a fault of the data, never of the caller. */
function estimateObject(row: { value: unknown } | undefined): { roundOff?: unknown; prefix?: unknown } {
  let value: unknown = row?.value;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      value = undefined;
    }
  }
  return value !== null && typeof value === 'object' ? (value as { roundOff?: unknown; prefix?: unknown }) : {};
}

/** R8: `settings.estimate.roundOff`. A value that is not true or false is a fault of the data, never of the caller. */
function roundOffOf(row: { value: unknown } | undefined): boolean {
  const flag = estimateObject(row).roundOff;
  if (typeof flag !== 'boolean') throw new Error('settings.estimate.roundOff is missing or is not true or false');
  return flag;
}

/**
 * `settings.estimate` for create_bill (X1): the round-off flag (R8) and the prefix of the bill numbers (L4). X1 reads it twice, once before its transaction (the bill series is worked out from the
 * prefix, and its counter row must exist before the transaction, L3) and once inside it, and answers JV_BUSY if the prefix changed in between. Both are faults of the data when they are not as the
 * settings screen promises (the prefix of BILL_PREFIX_PATTERN, a true or false roundOff).
 */
export async function readEstimate(r: Reader): Promise<{ roundOff: boolean; prefix: string }> {
  const [setting] = await r.rows<{ value: unknown }>(SETTING_SQL);
  const prefix = estimateObject(setting).prefix;
  if (typeof prefix !== 'string' || !BILL_PREFIX_PATTERN.test(prefix)) throw new Error('settings.estimate.prefix is missing or is not a bill prefix');
  return { roundOff: roundOffOf(setting), prefix };
}

/** The latest daily rate dated not after the bill date of each material and purity of a By Weight piece (R2), by plain SELECTs. */
export async function readRates(r: Reader, pieces: Iterable<Pick<PieceRow, 'material' | 'purity' | 'selling_method'>>, billDate: string): Promise<Map<string, RateRow | null>> {
  const rates = new Map<string, RateRow | null>();
  for (const p of pieces) {
    if (p.selling_method !== 'By Weight') continue;
    const key = rateKey(p.material, p.purity);
    if (rates.has(key)) continue;
    const [row] = await r.rows<RateRow>(RATE_SQL, [p.material, p.purity, billDate]);
    rates.set(key, row ?? null);
  }
  return rates;
}

/** The plain SELECTs of X7: the pieces, the setting and the latest daily rate of each material and purity of a By Weight piece. */
export async function readQuoteRows(r: Reader, items: readonly QuoteItem[], billDate: string): Promise<{ pieces: Map<string, PieceRow>; rates: Map<string, RateRow | null>; roundOff: boolean }> {
  const found = await r.rows<PieceRow>(PIECES_SQL(items.length), items.map((i) => i.sku_id));
  const pieces = new Map(found.map((p) => [p.id, p]));
  const rates = await readRates(r, pieces.values(), billDate);
  const [setting] = await r.rows<{ value: unknown }>(SETTING_SQL);
  return { pieces, rates, roundOff: roundOffOf(setting) };
}

export interface QuoteRouteOptions {
  /** A seam for tests (T-A15): the version table. The application never passes it, so a request can only ask for the versions of PRICING_VERSIONS. */
  versions?: VersionTable;
}

function databaseOf(app: FastifyInstance): DbPool {
  if (!app.db) throw unavailableError();
  return app.db;
}

/** Registers `fn:quote_bill`. */
export function registerQuoteBill(app: FastifyInstance, options: QuoteRouteOptions = {}): void {
  const versions = options.versions ?? PRICING_VERSIONS;
  route(app, {
    action: 'fn:quote_bill',
    body: quoteBody,
    handler: async ({ app: a, request, auth, body }) => {
      assertMayCall(auth.user.role, 'fn:quote_bill'); // X0 item 2: the service function checks again
      // everything that can be refused without a database is refused first
      const billDate = checkBillDate(body.bill_date, a.clock.read().date, auth.user.role);
      assertEachPieceOnce(body.items);
      const version = body.pricing_version ?? CURRENT_PRICING_VERSION;
      if (!Object.hasOwn(versions, version)) throw new wire.InvalidInputError('pricing_version', 'is not a version this API prices');
      const rows = await withRead(txContextFor(databaseOf(a), request, null), (r) => readQuoteRows(r, body.items, billDate));
      return buildQuote({ saleType: body.sale_type, billDate, version, versions, items: body.items, discount: body.discount, additionalCharges: body.additional_charges, ...rows });
    },
  });
}
