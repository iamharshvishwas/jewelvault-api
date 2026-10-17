// S3, S5, A5: how values leave the API, and the text checks both directions share.
//   money: decimal text with 2 decimals ("257612.00");  weight: decimal text with 3 ("35.420");  never a JSON number
//   ids: lower-case UUID text
//   created_at, updated_at: UTC text with six decimals and a Z ("2026-10-15T09:41:12.123456Z"), made from the database text by string work only. A JavaScript Date
//     would cut the microseconds, and the screen sends the text back unchanged for the stale check (A5), so the text must survive the trip digit for digit.
//   business dates: "YYYY-MM-DD", the Asia/Kolkata day (S5). The clock gives it (clock.ts); the database's DATE columns come back as the same text (dateStrings).
// Everything here works on text or on whole numbers of units: no function makes a JavaScript number out of an amount.

/** A response value that cannot be written in the wire format. It is a bug in the API or the data, never the caller's fault (answered JV_INTERNAL, S8). */
export class WireFormatError extends Error {
  readonly what: string;
  readonly reason: string;
  constructor(what: string, reason: string) {
    super(`${what} ${reason}`);
    this.name = 'WireFormatError';
    this.what = what;
    this.reason = reason;
  }
}

const fail = (what: string, reason: string): never => {
  throw new WireFormatError(what, reason);
};

// ---------------------------------------------------------------------------------------------------------
// money and weight
// ---------------------------------------------------------------------------------------------------------

const DECIMAL_TEXT = /^(-?)(\d+)(?:\.(\d+))?$/;
const NONZERO = /[1-9]/;

/** Decimal text to exactly `scale` decimals. More digits are accepted only when they are zeros (a computed DECIMAL such as 12.5000); a digit that would need rounding is a bug. */
function toScale(value: unknown, scale: number, what: string): string {
  if (typeof value !== 'string') return fail(what, 'must be decimal text, not a number');
  const match = DECIMAL_TEXT.exec(value);
  if (!match) return fail(what, 'is not plain decimal text');
  const [, sign, whole, fraction = ''] = match;
  if (NONZERO.test(fraction.slice(scale))) return fail(what, `has more than ${scale} decimals`);
  const text = `${whole.replace(/^0+(?=\d)/, '')}.${fraction.slice(0, scale).padEnd(scale, '0')}`;
  return sign === '-' && NONZERO.test(text) ? `-${text}` : text; // -0.00 is 0.00
}

/** A whole number of 10^-scale units (paise, milligrams) to decimal text with `scale` decimals. */
function fromUnits(value: unknown, scale: number, what: string): string {
  let units: bigint;
  if (typeof value === 'bigint') units = value;
  else if (typeof value === 'number' && Number.isSafeInteger(value)) units = BigInt(value);
  else return fail(what, 'must be a whole number of units');
  const negative = units < 0n;
  const digits = String(negative ? -units : units).padStart(scale + 1, '0');
  const text = `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
  return negative ? `-${text}` : text;
}

/** Money as the database holds it (DECIMAL text) to text with 2 decimals. Negative values are allowed: round_off and balances. */
export const formatMoney = (value: string): string => toScale(value, 2, 'money');
/** Weight (DECIMAL text) to text with 3 decimals. */
export const formatWeight = (value: string): string => toScale(value, 3, 'weight');
/** A whole number of paise to rupee text with 2 decimals: 25761200 gives '257612.00'. */
export const formatMoneyFromPaise = (paise: number | bigint): string => fromUnits(paise, 2, 'paise');
/** A whole number of milligrams to gram text with 3 decimals: 35420 gives '35.420'. */
export const formatWeightFromMilligrams = (milligrams: number | bigint): string => fromUnits(milligrams, 3, 'milligrams');

// ---------------------------------------------------------------------------------------------------------
// ids
// ---------------------------------------------------------------------------------------------------------

/** A UUID as the wire writes it: 8-4-4-4-12 hexadecimal digits, lower case, any version (the seeded walk-in customer is version 4 but a test may use another). */
export const UUID_TEXT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function formatUuid(value: string): string {
  if (typeof value !== 'string') return fail('id', 'must be UUID text');
  const lower = value.toLowerCase();
  return UUID_TEXT.test(lower) ? lower : fail('id', 'is not a UUID');
}

// ---------------------------------------------------------------------------------------------------------
// dates and timestamps
// ---------------------------------------------------------------------------------------------------------

// MariaDB's DATE and DATETIME range; a year before 1000 is never a business day.
const MIN_YEAR = 1000;
const MAX_YEAR = 9999;

const isLeap = (year: number) => (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
const DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function isRealDate(year: number, month: number, day: number): boolean {
  if (year < MIN_YEAR || year > MAX_YEAR || month < 1 || month > 12 || day < 1) return false;
  return day <= (month === 2 && isLeap(year) ? 29 : DAYS[month - 1]);
}

const BUSINESS_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATABASE_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?$/;
const WIRE_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{6})Z$/;

/** True for a real calendar date written YYYY-MM-DD (no time, no zone). Such texts sort in date order. */
export function isBusinessDate(value: unknown): value is string {
  const m = typeof value === 'string' ? BUSINESS_DATE.exec(value) : null;
  return m !== null && isRealDate(Number(m[1]), Number(m[2]), Number(m[3]));
}

const isRealTime = (h: string, mi: string, s: string) => Number(h) < 24 && Number(mi) < 60 && Number(s) < 60;

export function formatBusinessDate(value: string): string {
  return isBusinessDate(value) ? value : fail('date', 'is not a date written YYYY-MM-DD');
}

/** The database's DATETIME(6) text in UTC, 'YYYY-MM-DD HH:MM:SS.ffffff', to the wire text 'YYYY-MM-DDTHH:MM:SS.ffffffZ'. A shorter fraction is padded with zeros on the right. */
export function timestampToWire(value: string): string {
  const m = typeof value === 'string' ? DATABASE_TIMESTAMP.exec(value) : null;
  if (!m || !isRealDate(Number(m[1]), Number(m[2]), Number(m[3])) || !isRealTime(m[4], m[5], m[6])) return fail('timestamp', 'is not database DATETIME text');
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.${(m[7] ?? '').padEnd(6, '0')}Z`;
}

/** The wire text back to the database's text, for the stale check and for comparisons: the exact form only (six decimals, a Z). */
export function timestampFromWire(value: string): string {
  const m = typeof value === 'string' ? WIRE_TIMESTAMP.exec(value) : null;
  if (!m || !isRealDate(Number(m[1]), Number(m[2]), Number(m[3])) || !isRealTime(m[4], m[5], m[6])) return fail('timestamp', 'is not wire timestamp text');
  return `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}.${m[7]}`;
}

/** True for the wire text exactly as the server sends it. */
export function isWireTimestamp(value: unknown): value is string {
  try {
    timestampFromWire(value as string);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------------------------------------
// a row
// ---------------------------------------------------------------------------------------------------------

export type ColumnKind = 'money' | 'weight' | 'uuid' | 'timestamp' | 'date';

const FORMATTERS: Record<ColumnKind, (value: string) => string> = {
  money: formatMoney,
  weight: formatWeight,
  uuid: formatUuid,
  timestamp: timestampToWire,
  date: formatBusinessDate,
};

/**
 * A database row (mysql2 with DECIMAL, BIGINT and dates as text) to the row the wire carries. `kinds` names the columns that need a format; every other column is copied
 * as it is (counts stay numbers, null stays null). A money or weight value that is a JavaScript number, or a value that does not fit its format, throws a WireFormatError
 * that names the column. The row passed in is not changed.
 */
export function formatRow(row: Readonly<Record<string, unknown>>, kinds: Readonly<Record<string, ColumnKind>>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...row };
  for (const [column, kind] of Object.entries(kinds)) {
    const value = row[column];
    if (value === null || value === undefined) continue;
    try {
      out[column] = FORMATTERS[kind](value as string);
    } catch (e) {
      if (e instanceof WireFormatError) throw new WireFormatError(column, e.reason);
      throw e;
    }
  }
  return out;
}
