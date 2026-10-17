// L3, L4, S2: human numbers (bill, opening-balance bill, design, piece, barcode) from the sys_counters row of the series, and their formats.
//
//  - The series is worked out ONCE (the year from the API clock, S5, in the Asia/Kolkata zone) into a NumberSeries and that one value is used in both steps: ensureSeries (before the transaction)
//    and nextBillNo / nextNumber (inside it). A call that read the clock twice could straddle midnight on 31 December.
//  - The row exists before the transaction that needs it (ensureSeries): a read first (`SELECT 1 FROM sys_counters WHERE series = ?`, no lock at READ COMMITTED), INSERT IGNORE only when it is
//    missing, on a checked-out connection in autocommit and inside the error map of S8, so a lock wait there is JV_BUSY and not a raw 1205. INSERT ... ON DUPLICATE KEY UPDATE took the row lock and
//    waited behind the bill before it; and a series made inside the transaction deadlocks (1213) when its first user rolls back while two others wait (spike F3).
//  - Inside the transaction the number is `UPDATE sys_counters SET last_value = LAST_INSERT_ID(last_value + 1) WHERE series = ?` read from the OK packet of that UPDATE (insertId). No statement runs
//    between, and a SELECT of LAST_INSERT_ID is never used: any INSERT into an AUTO_INCREMENT table after the update (the audit log is one) changes what it would return. An UPDATE that changes no row
//    means the series row is missing: a bug, JV_INTERNAL. The UPDATE takes a row lock (callers are serialised) and a rollback gives the number back: no gaps, no repeats in a running system.
//  - A number that already exists (an imported code, IM3) is skipped by looking ahead with `SELECT 1 FROM bills WHERE bill_no = ?` (a plain read: no error, no lock at READ COMMITTED), at most 100
//    times, then JV_INVALID_INPUT. A duplicate-key error on a bill's number is NEVER caught: catching it would keep the failed insert's next-key locks until the commit, and S12 (1) forbids carrying
//    on after a database error.
import { BusyError, JvError, classifyError, isConnectionLost } from '../errors.js';
import { noteStep } from './locks.js';
import type { DbConnection } from './pool.js';
import { checkStatement } from './stmt.js';
import type { Tx, TxContext } from './tx.js';

// ------------------------------------------------------------------ the series and their formats (L4)

/** A counter series: its key in sys_counters and how a counter value is written as a human number. */
export interface NumberSeries {
  readonly key: string;
  format(n: number): string;
}

/** What a number step hands back: the counter value and the human number made from it. */
export interface IssuedNumber {
  readonly n: number;
  readonly no: string;
}

/** A bill number also says how many existing (imported) numbers were skipped to reach it. */
export interface IssuedBillNumber extends IssuedNumber {
  readonly skipped: number;
}

/** settings.estimate.prefix (default JV): 1 to 12 letters or digits, a hyphen allowed between them. No colon (the series key is bill:<PREFIX>:<YYYY>) and none at either end. The settings screen must use the same rule. */
export const BILL_PREFIX_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,10}[A-Za-z0-9])?$/;
/** categories.prefix, as the CHECK of db/migrations/0003 says (a test compares the two). */
export const CATEGORY_PREFIX_PATTERN = /^[A-Z0-9]{2,6}$/;
/** settings.numbering.designPadding and skuPadding as seeded (db/seeds/0101_settings.sql); the caller passes the setting's value. */
export const DEFAULT_DESIGN_PADDING = 5;
export const DEFAULT_PIECE_PADDING = 3;
/** L3: an existing number is skipped at most this many times, then JV_INVALID_INPUT. */
export const MAX_SKIPPED_NUMBERS = 100;

const BILL_DIGITS = 4;
const OPENING_DIGITS = 4;
/** sys_counters.series is VARCHAR(100). INSERT IGNORE would cut a longer key without a word, so it is refused before any statement. */
const MAX_SERIES_KEY = 100;
/** designs.design_no is at most 64 characters (D6). */
const MAX_DESIGN_NO = 64;

function pad(n: number, width: number): string {
  if (!Number.isSafeInteger(n) || n < 1) throw new TypeError('a number from the counter is a whole number from 1');
  return String(n).padStart(width, '0');
}
function checkPadding(padding: number): number {
  if (!Number.isInteger(padding) || padding < 1 || padding > 10) throw new TypeError('a padding is a whole number of digits from 1 to 10');
  return padding;
}

/** The year of the Asia/Kolkata calendar date of a clock reading (S5): the year of the day the bill is SAVED, whatever date is on the bill. */
export function businessYear(at: { readonly date: string }): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(at.date)) throw new TypeError('a clock reading carries its business date as YYYY-MM-DD');
  return at.date.slice(0, 4);
}

/** bill:<PREFIX>:<YYYY>; a bill is <prefix>-<YYYY>-<4 digits>, and after 9,999 the digits simply grow. `at` is ONE reading of the API clock, taken once for the whole call. */
export function billNumbers(at: { readonly date: string }, prefix: string): NumberSeries {
  if (typeof prefix !== 'string' || !BILL_PREFIX_PATTERN.test(prefix)) throw new TypeError('a bill prefix is 1 to 12 letters or digits (a hyphen between them is allowed)');
  const year = businessYear(at);
  return Object.freeze({ key: `bill:${prefix}:${year}`, format: (n: number) => `${prefix}-${year}-${pad(n, BILL_DIGITS)}` });
}

/** opening: opening-balance bills are OB-<4 digits>. */
export const openingNumbers: NumberSeries = Object.freeze({ key: 'opening', format: (n: number) => `OB-${pad(n, OPENING_DIGITS)}` });

/** design:<CATEGORY PREFIX>; a design is <category prefix>-<5 digits> (settings.numbering.designPadding). */
export function designNumbers(categoryPrefix: string, padding: number = DEFAULT_DESIGN_PADDING): NumberSeries {
  if (typeof categoryPrefix !== 'string' || !CATEGORY_PREFIX_PATTERN.test(categoryPrefix)) throw new TypeError('a category prefix is 2 to 6 capital letters or digits');
  const width = checkPadding(padding);
  return Object.freeze({ key: `design:${categoryPrefix}`, format: (n: number) => `${categoryPrefix}-${pad(n, width)}` });
}

/** sku:<design_no>; a piece is <design_no>-<3 digits> (settings.numbering.skuPadding). */
export function pieceNumbers(designNo: string, padding: number = DEFAULT_PIECE_PADDING): NumberSeries {
  if (typeof designNo !== 'string' || designNo.length === 0 || designNo.length > MAX_DESIGN_NO) throw new TypeError('a design number is 1 to 64 characters');
  const width = checkPadding(padding);
  return Object.freeze({ key: `sku:${designNo}`, format: (n: number) => `${designNo}-${pad(n, width)}` });
}

/** A barcode is <barcodePrefix>-<sku_no> (settings.numbering.barcodePrefix, default BC). */
export function barcodeFor(barcodePrefix: string, skuNo: string): string {
  if (typeof barcodePrefix !== 'string' || barcodePrefix.length === 0 || typeof skuNo !== 'string' || skuNo.length === 0) throw new TypeError('a barcode needs a prefix and a piece number');
  return `${barcodePrefix}-${skuNo}`;
}

function checkSeriesKey(key: unknown): asserts key is string {
  if (typeof key !== 'string' || key.length === 0 || key.length > MAX_SERIES_KEY) throw new TypeError('a counter series is 1 to 100 characters of text');
}

// ------------------------------------------------------------------ step 1: the row exists before the transaction

const SERIES_EXISTS_SQL = 'SELECT 1 FROM sys_counters WHERE series = ?';
const SERIES_CREATE_SQL = 'INSERT IGNORE INTO sys_counters (series, last_value) VALUES (?, 0)';

/**
 * Makes sure the series row exists, BEFORE the transaction that needs it (L3). A read first; INSERT IGNORE only when the row is missing. Runs on a connection of its own in autocommit, inside the
 * error map: a lock wait on a row someone else is still creating is JV_BUSY (reason lock_wait) after the 5 s of S11, a lost connection is JV_BUSY and the connection is destroyed. Under the
 * deadline of the call. Safe to repeat, and safe to run at the same moment as itself (the loser's INSERT IGNORE changes nothing).
 */
export async function ensureSeries(ctx: TxContext, key: string): Promise<void> {
  checkSeriesKey(key);
  let conn: DbConnection | undefined;
  let broken = false;
  try {
    guardDeadline(ctx);
    conn = await ctx.pool.checkout(); // the wait for a place is part of the deadline (arrivedAt is older than this call)
    const send = async (sql: string, params: string[]): Promise<unknown> => {
      guardDeadline(ctx);
      checkStatement(sql, params);
      const [result] = await conn!.execute(sql, params);
      return result;
    };
    const found = await send(SERIES_EXISTS_SQL, [key]);
    if (Array.isArray(found) && found.length > 0) return;
    await send(SERIES_CREATE_SQL, [key]);
  } catch (e) {
    broken = isConnectionLost(e);
    throw classifyError(e);
  } finally {
    if (conn) {
      if (broken) conn.destroy();
      else conn.release();
    }
  }
}

/** The deadline of S12 (3), as tx.ts counts it: from the request's arrival, pool wait included. */
function guardDeadline(ctx: TxContext): void {
  if (ctx.now() - ctx.arrivedAt > ctx.deadlineMs) throw new BusyError('deadline');
}

/**
 * For a series that is made inside the transaction because nobody else can know it yet: sku:<design_no> inside X8 (the design number is new). The same read first and INSERT IGNORE, through `tx`, so it
 * is rolled back with the design. Every other series is made by ensureSeries before the transaction (a series made inside one can deadlock, spike F3).
 */
export async function ensureSeriesInTx(tx: Tx, key: string): Promise<void> {
  checkSeriesKey(key);
  const found = await tx.rows(SERIES_EXISTS_SQL, [key]);
  if (found.length === 0) await tx.run(SERIES_CREATE_SQL, [key]);
}

// ------------------------------------------------------------------ step 2: the number, inside the transaction

const TAKE_SQL = 'UPDATE sys_counters SET last_value = LAST_INSERT_ID(last_value + 1) WHERE series = ?';

/**
 * The next counter value of a series, from the OK packet of the UPDATE (insertId). Takes the row lock: callers of one series are serialised until this transaction ends, which is why it is the LAST
 * lock of an X function (X0). A rollback gives the number back. An UPDATE that changes no row means the row is missing (ensureSeries was not called): JV_INTERNAL.
 */
export async function takeNumber(tx: Tx, key: string): Promise<number> {
  checkSeriesKey(key);
  noteStep(tx, 'counter'); // X0 item 6: the counter is the last lock; the trail refuses a customer or piece lock after this
  const ok = await tx.run(TAKE_SQL, [key]);
  const n = Number(ok.insertId);
  if (ok.affectedRows !== 1 || !Number.isSafeInteger(n) || n < 1) {
    throw new JvError('JV_INTERNAL', 'Something unexpected went wrong.', { cause: new Error(`the counter update for series "${key}" changed ${ok.affectedRows} rows and gave ${String(ok.insertId)}: the series row is missing (ensureSeries runs before the transaction)`) });
  }
  return n;
}

/** The next number of a series that is not looked ahead (designs, pieces): the counter value and its format. */
export async function nextNumber(tx: Tx, series: NumberSeries): Promise<IssuedNumber> {
  const n = await takeNumber(tx, series.key);
  return { n, no: series.format(n) };
}

/**
 * The next free bill number of a bill series (bill:<PREFIX>:<YYYY> or opening). A number that already exists (an imported code, IM3) is skipped by looking ahead with a plain read, at most
 * MAX_SKIPPED_NUMBERS times, then JV_INVALID_INPUT (rolled back with the call, so no number is used). The caller inserts the bill with the returned number; if that insert still raises a duplicate-key
 * error it is a bug and is never caught (JV_INTERNAL).
 */
export async function nextBillNo(tx: Tx, series: NumberSeries): Promise<IssuedBillNumber> {
  for (let skipped = 0; skipped <= MAX_SKIPPED_NUMBERS; skipped++) {
    const { n, no } = await nextNumber(tx, series);
    const taken = await tx.rows('SELECT 1 FROM bills WHERE bill_no = ?', [no]);
    if (taken.length === 0) return { n, no, skipped };
  }
  throw new JvError('JV_INVALID_INPUT', 'The next bill numbers are already in use, so no number could be given. Nothing was saved.');
}
