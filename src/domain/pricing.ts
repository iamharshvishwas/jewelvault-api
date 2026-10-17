/**
 * The integer copy of the database's pricing (spec C12, rules R1 to R8, R12 and R13).
 *
 * The live total on the billing screen comes from here. The saved bill always shows the database's figures
 * (`create_bill`, X1); `quote_bill` (X7) runs the database pricing without saving so a test can compare the
 * two on random input (T-A14: the parity test is task DB08, not this file).
 *
 * UNITS. Money is a whole number of paise, weight a whole number of milligrams. A rate per gram is paise per
 * gram. No floating-point number is used for money or weight: decimal text and JSON numbers are turned into
 * integers digit by digit (`parseRupees`, `parseGrams`), products are made with BigInt so that, for example,
 * 100,000 g (10^8 mg) times a rate of Rs 100,000,000 (10^10 paise) = 10^18 cannot lose precision, and every
 * result is a plain number again once it has passed its cap (so it can be serialised as JSON).
 *
 * NAMES. A database column `x_y` is `xYPaise` (money) or `xYMg` (weight) here: `metal_amount` is
 * `metalAmountPaise`, `item_total` is `itemTotalPaise`, `fine_weight_due` is `fineWeightDueMg`,
 * `customer_net_weight` is `customerNetWeightMg`, `grand_total` is `grandTotalPaise`, and so on. The parity
 * test can therefore map columns mechanically: `parseRupees(row.metal_amount) === priced.metalAmountPaise`.
 *
 * ROUNDING. "Round" is half up, to the stated number of decimals (R3 to R8). All amounts are not negative
 * (S4), where half up and PostgreSQL's `round(numeric, n)` (ties away from zero) are the same rule.
 *
 * ERRORS. Anything the database would refuse with JV_INVALID_INPUT (S4: negative values, values above a cap,
 * more decimals than the column has, a missing required rate, a By Weight piece with a quantity above 1, a
 * discount that makes the total negative) throws a `PricingError` with `code` 'JV_INVALID_INPUT' and the
 * `field` that was wrong (`lines[2].metalRatePaise` for the third line of a bill). Nothing here can overflow.
 *
 * VERSION. Only pricing version 1 (the rules of spec section 8) is implemented. A later change of a rule is
 * version 2 with its own code (R13); asking this copy for another version throws.
 *
 * The functions that start with `default` and `saleTypeFor` are the screen-side defaults of R1, R2 and R9:
 * the database prices the rates it is sent, the screen decides which rates to send.
 */

/** The version of the pricing rules this copy implements (R13). */
export const CURRENT_PRICING_VERSION = 1;

export type SaleType = 'Retail' | 'Semi-Wholesale' | 'Wholesale';
export type Material = 'Gold' | 'Silver';
export type SellingMethod = 'By Weight' | 'Per Piece';

/** A decimal as the screen or the API holds it: JSON number or text. Converted exactly, never by arithmetic. */
export type DecimalInput = number | string;

const SALE_TYPES: readonly SaleType[] = ['Retail', 'Semi-Wholesale', 'Wholesale'];
const MATERIALS: readonly Material[] = ['Gold', 'Silver'];
const SELLING_METHODS: readonly SellingMethod[] = ['By Weight', 'Per Piece'];

/**
 * The size caps of spec S4 (open item O21), in integer units. The database keeps the same numbers as
 * literals in its CHECK constraints and in `private.limits`.
 */
export const LIMITS = Object.freeze({
  /** A weight is at most 100,000 g. */
  maxWeightMg: 100000000,
  /** A rate or a piece price is at most Rs 100,000,000. */
  maxRatePaise: 10000000000,
  /** Every amount (line amount, line total, subtotal, grand total, discount, additional charges, piroi, other charges) is at most Rs 1,000,000,000. */
  maxAmountPaise: 100000000000,
  /** A quantity is 1 to 1,000. */
  minQuantity: 1,
  maxQuantity: 1000,
  /** A bill has 1 to 200 lines. */
  minLines: 1,
  maxLines: 200,
});

/** What the database calls JV_INVALID_INPUT (S8). `field` names the input that was wrong. */
export class PricingError extends Error {
  readonly code = 'JV_INVALID_INPUT' as const;
  readonly field: string;

  constructor(field: string, reason: string) {
    super(`JV_INVALID_INPUT: ${field} ${reason}`);
    this.name = 'PricingError';
    this.field = field;
  }
}

const invalid = (field: string, reason: string) => new PricingError(field, reason);

// ---------------------------------------------------------------------------------------------------------
// exact decimal text <-> integers
// ---------------------------------------------------------------------------------------------------------

export interface ParseOptions {
  /** Name of the input, used in the error. Default 'value'. */
  field?: string;
  /** Allow a leading minus (balances, round-off). Default false: S4 refuses negative values. */
  signed?: boolean;
}

const MAX_SAFE_TEXT = String(Number.MAX_SAFE_INTEGER);
const DECIMAL_TEXT = /^(-?)(\d*)(?:\.(\d*))?$/;

/** Decimal text or a JSON number to a whole number of 10^-scale units, digit by digit, without arithmetic. */
function parseDecimalUnits(input: unknown, scale: number, options?: ParseOptions): number {
  const field = options?.field ?? 'value';
  let text: string;
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) throw invalid(field, 'is not a finite number');
    // The shortest text that reads back as the same double. A value the database could have sent
    // (at most 15 significant digits) comes back digit for digit; float noise (0.1 + 0.2) shows up as
    // too many decimals and is refused rather than rounded.
    text = String(input);
  } else if (typeof input === 'string') {
    text = input.trim();
  } else {
    throw invalid(field, 'must be a number or a text');
  }
  const match = DECIMAL_TEXT.exec(text);
  if (!match) throw invalid(field, `is not a plain decimal number: ${JSON.stringify(text)}`);
  const [, sign, whole, fractionPart] = match;
  const fraction = fractionPart ?? '';
  if (whole.length + fraction.length === 0) throw invalid(field, 'has no digits');
  if (sign === '-' && options?.signed !== true) throw invalid(field, 'must not be negative');
  if (fraction.length > scale) throw invalid(field, `has more than ${scale} decimals`);

  const digits = (whole + fraction.padEnd(scale, '0')).replace(/^0+/, '') || '0';
  // The largest safe integer has 16 digits; with fewer the text converts exactly.
  const tooLarge =
    digits.length > MAX_SAFE_TEXT.length ||
    (digits.length === MAX_SAFE_TEXT.length && digits > MAX_SAFE_TEXT);
  if (tooLarge) throw invalid(field, 'is too large');
  const value = Number(digits);
  return sign === '-' && value !== 0 ? -value : value;
}

/** Rupees (text or number, at most 2 decimals) to a whole number of paise. */
export function parseRupees(input: DecimalInput, options?: ParseOptions): number {
  return parseDecimalUnits(input, 2, options);
}

/** Grams (text or number, at most 3 decimals) to a whole number of milligrams. */
export function parseGrams(input: DecimalInput, options?: ParseOptions): number {
  return parseDecimalUnits(input, 3, options);
}

function formatUnits(value: unknown, scale: number): string {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw invalid('value', 'must be a whole number of units');
  }
  const negative = value < 0;
  const digits = String(negative ? -value : value).padStart(scale + 1, '0');
  const point = digits.length - scale;
  return `${negative ? '-' : ''}${digits.slice(0, point)}.${digits.slice(point)}`;
}

/** Paise to exact rupee text with two decimals: 25761181 gives '257611.81', -40 gives '-0.40'. */
export function formatRupees(paise: number): string {
  return formatUnits(paise, 2);
}

/** Milligrams to exact gram text with three decimals: 13900 gives '13.900'. */
export function formatGrams(mg: number): string {
  return formatUnits(mg, 3);
}

// ---------------------------------------------------------------------------------------------------------
// business dates as text (shared with selectors.ts)
// ---------------------------------------------------------------------------------------------------------

const BUSINESS_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Checks that `value` is a real calendar date written YYYY-MM-DD (year 1 to 9999, no 30 February) and
 * returns it. Such texts sort in date order, so dates can be compared as text.
 */
export function assertBusinessDate(value: unknown, field: string): string {
  const match = typeof value === 'string' ? BUSINESS_DATE.exec(value) : null;
  if (!match) throw invalid(field, 'must be a date written YYYY-MM-DD');
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const probe = new Date(0);
  probe.setUTCFullYear(year, month - 1, day); // unlike Date.UTC, this keeps years 0 to 99 as written
  const real =
    year >= 1 &&
    probe.getUTCFullYear() === year &&
    probe.getUTCMonth() === month - 1 &&
    probe.getUTCDate() === day;
  if (!real) throw invalid(field, 'is not a real calendar date');
  return value as string;
}

// ---------------------------------------------------------------------------------------------------------
// R1, R9: screen-side defaults for the labour rate and the sale type
// ---------------------------------------------------------------------------------------------------------

/**
 * The labour rates of a piece as the screens hold them (the prototype's `Sku` fields). For a By Weight piece
 * they are rupees per gram of NW, for a Per Piece piece the piece price (D7). `null` or absent is blank.
 * `labour` is the old single rate of the prototype, kept as the last fallback.
 */
export interface LabourRates<T> {
  retailLabour?: T | null;
  semiWholesaleLabour?: T | null;
  wholesaleLabour?: T | null;
  labour?: T | null;
}

type LabourKey = keyof LabourRates<unknown>;

/** The chain of each sale type, as coded in `BillingPOSClient.tsx:28-32` (R1, chain 2). */
const LABOUR_CHAINS: Readonly<Record<SaleType, readonly LabourKey[]>> = {
  Retail: ['retailLabour', 'labour'],
  'Semi-Wholesale': ['semiWholesaleLabour', 'wholesaleLabour', 'retailLabour', 'labour'],
  Wholesale: ['wholesaleLabour', 'semiWholesaleLabour', 'retailLabour', 'labour'],
};

function assertOneOf<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw invalid(field, `must be one of ${allowed.join(', ')}`);
  }
  return value as T;
}

/**
 * The default labour rate of a piece for the bill's sale type (R1, chain 2): Retail takes the retail rate,
 * then the old single labour; Semi-Wholesale the semi rate, then wholesale, retail, labour; Wholesale the
 * wholesale rate, then semi, retail, labour. Only a blank (null or absent) is skipped, so a rate of 0 is a
 * rate. For a Per Piece piece this is also the default `r`, the piece price for the sale type (R2).
 * Returns null when every rate is blank (in the new schema they never are). The value is returned as given,
 * whatever its type, so the caller converts it (for example with `parseRupees`) when it prices the line.
 */
export function defaultLabourRate<T>(rates: LabourRates<T>, saleType: SaleType): T | null {
  assertOneOf(saleType, SALE_TYPES, 'saleType');
  for (const key of LABOUR_CHAINS[saleType]) {
    const rate = rates[key];
    if (rate !== null && rate !== undefined) return rate;
  }
  return null;
}

/**
 * Choosing a customer sets the bill's sale type to the customer's type (R9, as coded in
 * `BillingPOSClient.tsx:158-161`); with no customer, or a customer without a type, the sale type stays.
 * The biller may change it afterwards. The labour rate default then follows with `defaultLabourRate`.
 */
export function saleTypeForCustomer(
  customer: { customerType?: SaleType | null } | null | undefined,
  current: SaleType
): SaleType {
  const type = customer?.customerType;
  if (type === null || type === undefined) return current;
  return assertOneOf(type, SALE_TYPES, 'customerType');
}

// ---------------------------------------------------------------------------------------------------------
// R2: the default metal rate on the screen
// ---------------------------------------------------------------------------------------------------------

/** A row of `daily_rates` (D4) as the cache holds it. */
export interface DailyRateLike {
  material: string;
  purity: string;
  /** Rupees per gram. */
  ratePerGram: DecimalInput;
  /** Business date, YYYY-MM-DD. */
  rateDate: string;
}

export interface DefaultMetalRate {
  /** The pre-fill in paise per gram, or null when there is no rate dated on or before the bill date. */
  ratePaise: number | null;
  /** The date of the rate used. */
  rateDate: string | null;
  /**
   * 'ok': dated the bill date. 'stale': dated before the bill date (the database warns RATE_STALE).
   * 'missing': no rate for this material and purity dated on or before the bill date (RATE_MISSING),
   * so the screen asks for one.
   */
  status: 'ok' | 'stale' | 'missing';
}

/**
 * R2: for a By Weight piece the screen pre-fills `r` with the rate for the piece's material and purity that
 * has the latest `rate_date` not after the bill's date. (For a Per Piece piece `r` is the piece price for
 * the sale type: `defaultLabourRate`.) The database works out the same rule for its own list price (R14).
 */
export function defaultMetalRate(
  rates: readonly DailyRateLike[],
  material: string,
  purity: string,
  billDate: string
): DefaultMetalRate {
  assertBusinessDate(billDate, 'billDate');
  let best: DailyRateLike | undefined;
  for (const rate of rates) {
    if (rate.material !== material || rate.purity !== purity) continue;
    assertBusinessDate(rate.rateDate, 'rateDate');
    if (rate.rateDate > billDate) continue;
    if (best === undefined || rate.rateDate > best.rateDate) best = rate;
  }
  if (best === undefined) return { ratePaise: null, rateDate: null, status: 'missing' };
  return {
    ratePaise: parseRupees(best.ratePerGram, { field: 'ratePerGram' }),
    rateDate: best.rateDate,
    status: best.rateDate === billDate ? 'ok' : 'stale',
  };
}

// ---------------------------------------------------------------------------------------------------------
// R3 to R8: pricing a line and a bill
// ---------------------------------------------------------------------------------------------------------

/**
 * One line to price. The piece's own figures (material, selling method, net weight) are the snapshot the
 * database takes from the locked piece row; the rates and charges are what the screen sends (X1).
 */
export interface PriceLineInput {
  material: Material;
  sellingMethod: SellingMethod;
  /** NW, `customer_net_weight`, in milligrams. */
  customerNetWeightMg: number;
  /** 1 to 1,000; must be 1 for a By Weight piece (R6). Absent or null means 1. */
  quantity?: number | null;
  /** `r`: paise per gram of NW for a By Weight piece, the piece price in paise for a Per Piece piece. Required. */
  metalRatePaise: number;
  /** `l`: paise per gram of NW. Required for a By Weight line, ignored for a Per Piece line (R3). */
  labourRatePaise?: number | null;
  /** `p`, added once per line (R7). Absent or null means 0. */
  piroiPaise?: number | null;
  /** `o`, added once per line (R7). Absent or null means 0. */
  otherChargesPaise?: number | null;
}

/** The priced values of one line (D12). */
export interface PricedLine {
  quantity: number;
  piroiPaise: number;
  otherChargesPaise: number;
  /** `labour_amount` (R3). */
  labourAmountPaise: number;
  /** `metal_amount` (R5). */
  metalAmountPaise: number;
  /** `fine_weight_due` in milligrams (R4). */
  fineWeightDueMg: number;
  /** `item_total` (R7). */
  itemTotalPaise: number;
}

export interface PriceBillInput {
  /** The bill's sale type (R9). */
  saleType: SaleType;
  /** 1 to 200 lines. */
  lines: readonly PriceLineInput[];
  /** Absent or null means 0. */
  discountPaise?: number | null;
  /** Absent or null means 0. */
  additionalChargesPaise?: number | null;
  /** `settings.estimate.roundOff`: whether `round_off` is kept (R8). Required, so it cannot be forgotten. */
  roundOffSetting: boolean;
  /** Default: the current version. Only version 1 exists in this copy. */
  pricingVersion?: number;
}

/** The priced bill (D11). */
export interface PricedBill {
  pricingVersion: number;
  lines: PricedLine[];
  subtotalPaise: number;
  discountPaise: number;
  additionalChargesPaise: number;
  /** `subtotal - discount + additional_charges`, at least 0. */
  beforeRoundPaise: number;
  /** `round(before_round, 0)`, always a whole rupee. */
  grandTotalPaise: number;
  /** `grand_total - before_round` when the setting is on, else 0. May be negative. */
  roundOffPaise: number;
  /** `fine_weight_due`: the sum of the lines'. */
  fineWeightDueMg: number;
}

const ZERO = BigInt(0);
const HUNDRED = BigInt(100);
const THOUSAND = BigInt(1000);
const MAX_AMOUNT = BigInt(LIMITS.maxAmountPaise);

/** numerator / divisor rounded half up. The numerator is never negative here (S4). */
function divideHalfUp(numerator: bigint, divisor: bigint): bigint {
  return (numerator + divisor / BigInt(2)) / divisor;
}

const isAbsent = (value: unknown): value is null | undefined =>
  value === null || value === undefined;

/** A whole number of units within [min, max]; anything else is JV_INVALID_INPUT. */
function integerWithin(value: unknown, min: number, max: number, field: string): number {
  if (isAbsent(value)) throw invalid(field, 'is required');
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw invalid(field, 'must be a whole number of paise, milligrams or pieces');
  }
  if (value < min) {
    throw invalid(field, min === 0 ? 'must not be negative' : `must be at least ${min}`);
  }
  if (value > max) throw invalid(field, `is above the cap of ${max}`);
  return value;
}

/** An amount that may be absent (then 0): 0 to the amount cap. */
function optionalAmount(value: unknown, field: string): number {
  return isAbsent(value) ? 0 : integerWithin(value, 0, LIMITS.maxAmountPaise, field);
}

/** A computed amount must not pass the amount cap; it is a plain number again once it has. */
function amountWithinCap(value: bigint, field: string): number {
  if (value > MAX_AMOUNT) throw invalid(field, `is above the cap of ${LIMITS.maxAmountPaise}`);
  return Number(value);
}

function priceLineAt(line: PriceLineInput, saleType: SaleType, at: string): PricedLine {
  const material = assertOneOf(line.material, MATERIALS, `${at}material`);
  const sellingMethod = assertOneOf(line.sellingMethod, SELLING_METHODS, `${at}sellingMethod`);
  const byWeight = sellingMethod === 'By Weight';

  const weightMg = integerWithin(
    line.customerNetWeightMg,
    0,
    LIMITS.maxWeightMg,
    `${at}customerNetWeightMg`
  );
  const quantity = isAbsent(line.quantity)
    ? 1
    : integerWithin(line.quantity, LIMITS.minQuantity, LIMITS.maxQuantity, `${at}quantity`);
  if (byWeight && quantity !== 1) throw invalid(`${at}quantity`, 'must be 1 for a By Weight piece');
  const metalRate = integerWithin(
    line.metalRatePaise,
    0,
    LIMITS.maxRatePaise,
    `${at}metalRatePaise`
  );
  // required for a By Weight line, ignored for a Per Piece line (R3)
  const labourRate = byWeight
    ? integerWithin(line.labourRatePaise, 0, LIMITS.maxRatePaise, `${at}labourRatePaise`)
    : 0;
  const piroi = optionalAmount(line.piroiPaise, `${at}piroiPaise`);
  const otherCharges = optionalAmount(line.otherChargesPaise, `${at}otherChargesPaise`);

  const weight = BigInt(weightMg);
  // R3: By Weight round(NW x l, 2); Per Piece 0. NW (mg) x l (paise per g) / 1000 is the amount in paise.
  const labourAmount = byWeight ? divideHalfUp(weight * BigInt(labourRate), THOUSAND) : ZERO;
  // R4: NW x q for Wholesale + Silver + By Weight, else 0.
  const fineDue =
    saleType === 'Wholesale' && material === 'Silver' && byWeight
      ? weight * BigInt(quantity)
      : ZERO;
  // R5: fine due means the silver is settled later, so no metal amount; else By Weight round(NW x r, 2),
  // Per Piece round(r x q, 2) (exact: r has at most two decimals and q is whole).
  let metalAmount: bigint;
  if (fineDue > ZERO) metalAmount = ZERO;
  else if (byWeight) metalAmount = divideHalfUp(weight * BigInt(metalRate), THOUSAND);
  else metalAmount = BigInt(metalRate) * BigInt(quantity);

  const metalAmountPaise = amountWithinCap(metalAmount, `${at}metalAmountPaise`);
  const labourAmountPaise = amountWithinCap(labourAmount, `${at}labourAmountPaise`);
  // R7: piroi and other charges once per line, not times the quantity. All four terms are at most the cap,
  // so the sum is far inside the safe integers.
  const itemTotalPaise = metalAmountPaise + labourAmountPaise + piroi + otherCharges;
  if (itemTotalPaise > LIMITS.maxAmountPaise) {
    throw invalid(`${at}itemTotalPaise`, `is above the cap of ${LIMITS.maxAmountPaise}`);
  }

  return {
    quantity,
    piroiPaise: piroi,
    otherChargesPaise: otherCharges,
    labourAmountPaise,
    metalAmountPaise,
    fineWeightDueMg: Number(fineDue),
    itemTotalPaise,
  };
}

/** Prices one line for a bill of the given sale type (R3 to R7). Throws `PricingError` on bad input. */
export function priceLine(line: PriceLineInput, saleType: SaleType): PricedLine {
  assertOneOf(saleType, SALE_TYPES, 'saleType');
  return priceLineAt(line, saleType, '');
}

/** Prices a whole bill (R3 to R8), pricing version 1. Throws `PricingError` on bad input. */
export function priceBill(input: PriceBillInput): PricedBill {
  const version =
    input.pricingVersion === undefined ? CURRENT_PRICING_VERSION : input.pricingVersion;
  if (version !== CURRENT_PRICING_VERSION) {
    throw invalid(
      'pricingVersion',
      `${String(version)} is not available (this copy prices version ${CURRENT_PRICING_VERSION})`
    );
  }
  const saleType = assertOneOf(input.saleType, SALE_TYPES, 'saleType');
  if (typeof input.roundOffSetting !== 'boolean') {
    throw invalid('roundOffSetting', 'must be true or false');
  }
  const count = Array.isArray(input.lines) ? input.lines.length : 0;
  if (count < LIMITS.minLines || count > LIMITS.maxLines) {
    throw invalid('lines', `must hold ${LIMITS.minLines} to ${LIMITS.maxLines} lines`);
  }

  const lines = input.lines.map((line, index) => priceLineAt(line, saleType, `lines[${index}].`));
  // At most 200 lines of at most the amount cap each: both sums stay far inside the safe integers.
  const subtotalPaise = lines.reduce((sum, line) => sum + line.itemTotalPaise, 0);
  const fineWeightDueMg = lines.reduce((sum, line) => sum + line.fineWeightDueMg, 0);
  if (subtotalPaise > LIMITS.maxAmountPaise) {
    throw invalid('subtotalPaise', `is above the cap of ${LIMITS.maxAmountPaise}`);
  }

  const discountPaise = optionalAmount(input.discountPaise, 'discountPaise');
  const additionalChargesPaise = optionalAmount(
    input.additionalChargesPaise,
    'additionalChargesPaise'
  );
  // R8: the total before rounding must be at least 0; a discount equal to subtotal + additional is allowed.
  const beforeRoundPaise = subtotalPaise - discountPaise + additionalChargesPaise;
  if (beforeRoundPaise < 0) {
    throw invalid('discountPaise', 'is more than the subtotal plus the additional charges');
  }
  // grand_total = round(before_round, 0): to the nearest whole rupee, a tie goes up.
  const grandTotalPaise = Number(divideHalfUp(BigInt(beforeRoundPaise), HUNDRED) * HUNDRED);
  if (grandTotalPaise > LIMITS.maxAmountPaise) {
    throw invalid('grandTotalPaise', `is above the cap of ${LIMITS.maxAmountPaise}`);
  }
  const roundOffPaise = input.roundOffSetting ? grandTotalPaise - beforeRoundPaise : 0;

  return {
    pricingVersion: version,
    lines,
    subtotalPaise,
    discountPaise,
    additionalChargesPaise,
    beforeRoundPaise,
    grandTotalPaise,
    roundOffPaise,
    fineWeightDueMg,
  };
}
