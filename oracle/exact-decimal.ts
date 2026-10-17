// THE INDEPENDENT EXACT-DECIMAL ORACLE of the pricing rules (spec R3 to R8, S4, R12, T-A14).
//
// oracle/pricing.ts is a verbatim snapshot of the app's pricing.ts (the spike's "BigInt oracle"; `diff` finds no line of difference), so it can only agree with the file it is a copy of. This file is the
// second engine: it prices a bill a second time, written again from the spec and sharing nothing with src/domain/pricing.ts: it imports nothing, and it does not work in the integer units of that file (paise and
// milligrams with one division) but in exact decimals, value = n / 10^s with n a BigInt, which are multiplied digit-exactly (the scales add) and rounded half up by looking at the remainder of the
// division by a power of ten. The same 200 random bills are priced by pricing.ts, by this file and by the SQL DECIMAL version of tests/b-decimal-money.test.ts, and the three must agree (T-A14); a
// bill is also refused by all three or by none.
//
// The input and the answer have the SHAPE of pricing.ts (money in paise, weight in milligrams, as whole numbers) so that one object can be given to both; nothing else is shared. The caps are typed from
// S4 in rupees and grams, as decimal text, not copied from the other file.

export class ExactPricingError extends Error {
  readonly code: 'JV_INVALID_INPUT' = 'JV_INVALID_INPUT';
  constructor(message: string) {
    super(`refused: ${message}`);
    this.name = 'ExactPricingError';
  }
}

export interface OracleLine {
  material: string;
  sellingMethod: string;
  customerNetWeightMg: number;
  quantity?: number | null;
  metalRatePaise: number;
  labourRatePaise?: number | null;
  piroiPaise?: number | null;
  otherChargesPaise?: number | null;
}

export interface PriceBillInput {
  saleType: string;
  lines: readonly OracleLine[];
  discountPaise?: number | null;
  additionalChargesPaise?: number | null;
  roundOffSetting: boolean;
  pricingVersion?: number;
}

export interface PricedLine {
  quantity: number;
  piroiPaise: number;
  otherChargesPaise: number;
  labourAmountPaise: number;
  metalAmountPaise: number;
  fineWeightDueMg: number;
  itemTotalPaise: number;
}

export interface PricedBill {
  pricingVersion: number;
  lines: PricedLine[];
  subtotalPaise: number;
  discountPaise: number;
  additionalChargesPaise: number;
  beforeRoundPaise: number;
  grandTotalPaise: number;
  roundOffPaise: number;
  fineWeightDueMg: number;
}

// ------------------------------------------------------------------ exact decimals

/** value = n / 10^s */
interface Dec {
  readonly n: bigint;
  readonly s: number;
}

const TEN = 10n;
const pow10 = (k: number): bigint => TEN ** BigInt(k);

/** A decimal written as text: digits with an optional point. */
function fromText(text: string): Dec {
  const [whole, fraction = ''] = text.split('.');
  return { n: BigInt(whole + fraction), s: fraction.length };
}

/** A whole number of units of 10^-s. */
const units = (count: number, s: number): Dec => ({ n: BigInt(count), s });

function bringTogether(a: Dec, b: Dec): [bigint, bigint, number] {
  const s = Math.max(a.s, b.s);
  return [a.n * pow10(s - a.s), b.n * pow10(s - b.s), s];
}
const plus = (a: Dec, b: Dec): Dec => {
  const [x, y, s] = bringTogether(a, b);
  return { n: x + y, s };
};
const minus = (a: Dec, b: Dec): Dec => {
  const [x, y, s] = bringTogether(a, b);
  return { n: x - y, s };
};
const times = (a: Dec, b: Dec): Dec => ({ n: a.n * b.n, s: a.s + b.s });
const compare = (a: Dec, b: Dec): number => {
  const [x, y] = bringTogether(a, b);
  return x < y ? -1 : x > y ? 1 : 0;
};
const ZERO: Dec = { n: 0n, s: 0 };

/** Round to `s` decimals, half up: a tie goes to the larger value. Only called with values that are not negative (S4). */
function round(d: Dec, s: number): Dec {
  if (d.n < 0n) throw new Error('the oracle rounds only values that are not negative');
  if (d.s <= s) return { n: d.n * pow10(s - d.s), s };
  const divisor = pow10(d.s - s);
  const quotient = d.n / divisor;
  const remainder = d.n % divisor;
  return { n: remainder * 2n >= divisor ? quotient + 1n : quotient, s };
}

/** The value as a whole number of units of 10^-s (it must have no more decimals than that). */
function asUnits(d: Dec, s: number): number {
  if (d.s > s) throw new Error('the oracle has a value with more decimals than its unit');
  return Number(d.n * pow10(s - d.s));
}

// ------------------------------------------------------------------ the caps of S4 and the inputs

const CAP_WEIGHT = fromText('100000'); // grams
const CAP_RATE = fromText('100000000'); // rupees per gram, or a piece price
const CAP_AMOUNT = fromText('1000000000'); // rupees: every line amount, line total, subtotal, grand total, discount, additional charge, piroi, other charges
const QUANTITY_MIN = 1;
const QUANTITY_MAX = 1000;
const LINES_MIN = 1;
const LINES_MAX = 200;

const refuse = (what: string): never => {
  throw new ExactPricingError(what);
};

/** A whole number of paise (or milligrams) that is not negative and not above the cap, as an exact decimal. */
function input(value: unknown, s: number, cap: Dec, what: string): Dec {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) return refuse(`${what} is not a whole number`);
  if (value < 0) return refuse(`${what} is negative`);
  const d = units(value, s);
  if (compare(d, cap) > 0) return refuse(`${what} is above its cap`);
  return d;
}
const optional = (value: unknown, s: number, cap: Dec, what: string): Dec => (value === undefined || value === null ? ZERO : input(value, s, cap, what));
const withinCap = (d: Dec, what: string): Dec => (compare(d, CAP_AMOUNT) > 0 ? refuse(`${what} is above the cap`) : d);

// ------------------------------------------------------------------ the rules

export function priceBill(bill: PriceBillInput): PricedBill {
  if (bill.pricingVersion !== undefined && bill.pricingVersion !== 1) refuse('only version 1 is priced');
  if (!['Retail', 'Semi-Wholesale', 'Wholesale'].includes(bill.saleType)) refuse('the sale type is unknown');
  if (typeof bill.roundOffSetting !== 'boolean') refuse('the round-off setting is not true or false');
  if (!Array.isArray(bill.lines) || bill.lines.length < LINES_MIN || bill.lines.length > LINES_MAX) refuse('a bill has 1 to 200 lines');

  let subtotal = ZERO;
  let fineTotal = ZERO;
  const lines: PricedLine[] = bill.lines.map((line, i) => {
    const at = `line ${i + 1}`;
    if (!['Gold', 'Silver'].includes(line.material)) refuse(`${at}: the material is unknown`);
    if (!['By Weight', 'Per Piece'].includes(line.sellingMethod)) refuse(`${at}: the selling method is unknown`);
    const byWeight = line.sellingMethod === 'By Weight';

    const nw = input(line.customerNetWeightMg, 3, CAP_WEIGHT, `${at}: the weight`); // grams, 3 decimals
    const quantity = line.quantity === undefined || line.quantity === null ? 1 : line.quantity;
    if (!Number.isSafeInteger(quantity) || quantity < QUANTITY_MIN || quantity > QUANTITY_MAX) refuse(`${at}: the quantity is not 1 to 1,000`);
    if (byWeight && quantity !== 1) refuse(`${at}: a By Weight piece has quantity 1`);
    const r = input(line.metalRatePaise, 2, CAP_RATE, `${at}: the metal rate`);
    // R3: the labour rate is needed for a By Weight line and is not looked at for a Per Piece line
    const l = byWeight ? input(line.labourRatePaise, 2, CAP_RATE, `${at}: the labour rate`) : ZERO;
    const p = optional(line.piroiPaise, 2, CAP_AMOUNT, `${at}: the piroi`);
    const o = optional(line.otherChargesPaise, 2, CAP_AMOUNT, `${at}: the other charges`);
    const q = units(quantity, 0);

    // R4: fine due is NW x q for Wholesale + Silver + By Weight
    const fine = bill.saleType === 'Wholesale' && line.material === 'Silver' && byWeight ? times(nw, q) : ZERO;
    // R3: By Weight round(NW x l, 2), Per Piece 0
    const labour = byWeight ? round(times(nw, l), 2) : ZERO;
    // R5: 0 when there is fine due; else By Weight round(NW x r, 2), Per Piece round(r x q, 2)
    const metal = compare(fine, ZERO) > 0 ? ZERO : byWeight ? round(times(nw, r), 2) : round(times(r, q), 2);
    withinCap(metal, `${at}: the metal amount`);
    withinCap(labour, `${at}: the labour amount`);
    // R7: piroi and other charges once per line, not times the quantity
    const total = withinCap(plus(plus(plus(metal, labour), p), o), `${at}: the line total`);

    subtotal = plus(subtotal, total);
    fineTotal = plus(fineTotal, fine);
    return {
      quantity,
      piroiPaise: asUnits(p, 2),
      otherChargesPaise: asUnits(o, 2),
      labourAmountPaise: asUnits(labour, 2),
      metalAmountPaise: asUnits(metal, 2),
      fineWeightDueMg: asUnits(fine, 3),
      itemTotalPaise: asUnits(total, 2),
    };
  });

  // R8
  withinCap(subtotal, 'the subtotal');
  const discount = optional(bill.discountPaise, 2, CAP_AMOUNT, 'the discount');
  const additional = optional(bill.additionalChargesPaise, 2, CAP_AMOUNT, 'the additional charges');
  const beforeRound = plus(minus(subtotal, discount), additional);
  if (beforeRound.n < 0n) refuse('the discount is more than the subtotal plus the additional charges');
  const grandTotal = withinCap(round(beforeRound, 0), 'the grand total');
  const roundOff = bill.roundOffSetting ? minus(grandTotal, beforeRound) : ZERO;

  return {
    pricingVersion: 1,
    lines,
    subtotalPaise: asUnits(subtotal, 2),
    discountPaise: asUnits(discount, 2),
    additionalChargesPaise: asUnits(additional, 2),
    beforeRoundPaise: asUnits(beforeRound, 2),
    grandTotalPaise: asUnits(grandTotal, 2),
    roundOffPaise: asUnits(roundOff, 2),
    fineWeightDueMg: asUnits(fineTotal, 3),
  };
}

// ------------------------------------------------------------------ text

function text(count: number, s: number): string {
  const n = BigInt(count);
  const abs = n < 0n ? -n : n;
  const digits = abs.toString().padStart(s + 1, '0');
  return `${n < 0n ? '-' : ''}${digits.slice(0, digits.length - s)}.${digits.slice(digits.length - s)}`;
}

/** Paise as rupee text with 2 decimals ('257611.81', '-0.40'). */
export const formatRupees = (paise: number): string => text(paise, 2);
/** Milligrams as gram text with 3 decimals ('13.900'). */
export const formatGrams = (mg: number): string => text(mg, 3);
