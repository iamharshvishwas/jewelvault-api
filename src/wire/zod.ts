// S3, S4: what the API accepts from the wire. The building blocks of every input schema (the tasks that build the functions compose them), and the one place that turns a
// refusal into JV_INVALID_INPUT (S8).
//
// WHY BEFORE pricing.ts: the shared pricing file's parseRupees and parseGrams accept JSON numbers and loose text (".5", "5.", " 7.50 ") on purpose, because the screen passes
// them, and that file must stay byte-identical (C12, T-A14). So the API refuses numbers and loose text here, and hands pricing.ts text that already has the plain shape.
//
// Money, rates and weights are decimal TEXT: digits, an optional point with digits after it, nothing else. No sign, no spaces, no ".5", no "5.". A trailing zero counts
// as a decimal, as it was sent ("1.230" has three), so the screen's copy and the database refuse the same inputs (S4, BN-3). The caps are checked on the exact text,
// with no number made on the way, and are the same numbers as the named CHECKs (src/limits.ts, compared with them by T-F02). A value over a cap is answered here with
// JV_INVALID_INPUT and never reaches the database, where it would be error 4025 and a bug.
// A schema returns the text it was given, unchanged. Converting it to paise or milligrams is the job of pricing.ts (parseRupees, parseGrams).

import { z } from 'zod';
import { JvError } from '../errors.js';
import { limits } from '../limits.js';
import { UUID_TEXT, isBusinessDate, isWireTimestamp } from './format.js';

/** The caller sent something the API refuses: S8's JV_INVALID_INPUT, HTTP 422. `field` names the input (`items[2].metal_rate`); the message never repeats the value. */
export class InvalidInputError extends JvError {
  declare readonly code: 'JV_INVALID_INPUT';
  declare readonly status: 422;
  readonly field: string;
  declare readonly details: { readonly field: string };
  constructor(field: string, reason: string) {
    super('JV_INVALID_INPUT', `${field} ${reason}`, { details: Object.freeze({ field }) });
    this.name = 'InvalidInputError';
    this.field = field;
  }
}

const thousands = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

const PLAIN_DECIMAL = /^(\d+)(?:\.(\d+))?$/;

/**
 * Checks decimal text against the pattern, the number of decimals and the cap. Returns the problem in words, or null when the text is fine.
 * The cap is a whole number (a rate of at most 100,000,000, a weight of at most 100,000 g); the comparison is made digit by digit.
 */
export function checkDecimalText(text: string, decimals: number, cap: number): string | null {
  const match = PLAIN_DECIMAL.exec(text);
  if (!match) return 'must be plain decimal text such as "12.50": digits, with a point only between digits, and no sign, no spaces and no ".5" or "5."';
  const fraction = match[2] ?? '';
  if (fraction.length > decimals) return `must have at most ${decimals} decimals (a trailing zero counts)`;
  const whole = match[1].replace(/^0+(?=\d)/, '');
  const capText = String(cap);
  const over = whole.length !== capText.length ? whole.length > capText.length : whole !== capText ? whole > capText : /[1-9]/.test(fraction);
  return over ? `must be at most ${thousands(cap)}` : null;
}

type TypeIssue = { input?: unknown };

const textTypeError = (issue: TypeIssue): string => {
  if (issue.input === undefined) return 'is required';
  if (typeof issue.input === 'number') return 'must be written as text such as "12.50"; a JSON number is not accepted';
  return 'must be text such as "12.50"';
};

function decimalText(decimals: number, cap: number) {
  return z.string({ error: textTypeError }).check((ctx) => {
    const problem = checkDecimalText(ctx.value, decimals, cap);
    if (problem !== null) ctx.issues.push({ code: 'custom', message: problem, input: ctx.value });
  });
}

/** An amount of money in rupees: at most 2 decimals, at most 1,000,000,000 (a line amount, a total, a payment, a discount, a charge, piroi, an opening balance, fine_cash). */
export const amount = decimalText(2, limits.maxAmount);
/** A rate per gram or a piece price in rupees: at most 2 decimals, at most 100,000,000. */
export const rate = decimalText(2, limits.maxRate);
/** A weight in grams: at most 3 decimals ("1.230" is fine, "1.2300" is not), at most 100,000. */
export const weight = decimalText(3, limits.maxWeightGrams);

const quantityMessage = `must be a whole number from ${limits.minQuantity} to ${thousands(limits.maxQuantity)}`;
/** A quantity is a JSON integer from 1 to 1,000 (a count crosses the wire as a number, S3). */
export const quantity = z
  .number({ error: (issue) => (issue.input === undefined ? 'is required' : quantityMessage) })
  .int(quantityMessage)
  .min(limits.minQuantity, quantityMessage)
  .max(limits.maxQuantity, quantityMessage);

const linesMessage = `must be a list of ${limits.minLines} to ${limits.maxLines} lines`;
/** The lines of a bill: 1 to 200. */
export function billLines<T extends z.ZodType>(item: T) {
  return z
    .array(item, { error: (issue) => (issue.input === undefined ? 'is required' : linesMessage) })
    .min(limits.minLines, linesMessage)
    .max(limits.maxLines, linesMessage);
}

const idTypeError = (what: string) => (issue: TypeIssue) => (issue.input === undefined ? 'is required' : what);

/** An id: UUID text in lower case, as the screens make it and as the responses give it. */
export const uuid = z.string({ error: idTypeError('must be a lower-case UUID') }).check((ctx) => {
  if (!UUID_TEXT.test(ctx.value)) ctx.issues.push({ code: 'custom', message: 'must be a lower-case UUID', input: ctx.value });
});

/** A business date: a real calendar date written YYYY-MM-DD. Whether it may be in the future or the past is decided by the function, not here (a CHECK cannot do it, S4). */
export const businessDate = z.string({ error: idTypeError('must be a date written YYYY-MM-DD') }).check((ctx) => {
  if (!isBusinessDate(ctx.value)) ctx.issues.push({ code: 'custom', message: 'must be a calendar date written YYYY-MM-DD', input: ctx.value });
});

/** created_at or updated_at exactly as the server sent it ("2026-10-15T09:41:12.123456Z"), sent back unchanged for the stale check (A5). Convert with timestampFromWire. */
export const timestamp = z.string({ error: idTypeError('must be the timestamp text the server sent') }).check((ctx) => {
  if (!isWireTimestamp(ctx.value)) ctx.issues.push({ code: 'custom', message: 'must be the timestamp text the server sent, such as "2026-10-15T09:41:12.123456Z"', input: ctx.value });
});

/** An object that refuses unknown keys (NODE-DESIGN 2: unknown JSON keys are refused). Use it for every object of a body, nested ones included. */
export function strictObject<T extends z.ZodRawShape>(shape: T) {
  return z.strictObject(shape);
}

// ---------------------------------------------------------------------------------------------------------
// the refusal
// ---------------------------------------------------------------------------------------------------------

const MAX_KEY_SHOWN = 64;

function fieldPath(path: readonly PropertyKey[]): string {
  let out = '';
  for (const part of path) {
    if (typeof part === 'number') out += `[${part}]`;
    else out += out === '' ? String(part) : `.${String(part)}`;
  }
  return out;
}

/**
 * Parses a request body (or any input) with a schema and returns the typed result, or throws InvalidInputError for the first problem. The message names the input and says
 * what is wrong; it never contains the value, which could be a PAN or a password. Run this before anything else touches the input: no database, no pricing.ts.
 */
export function parseInput<T extends z.ZodType>(schema: T, input: unknown): z.output<T> {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  if (issue.code === 'unrecognized_keys') {
    const key = String(issue.keys[0]).slice(0, MAX_KEY_SHOWN);
    throw new InvalidInputError(fieldPath([...issue.path, key]), 'is not a field this call accepts');
  }
  const field = fieldPath(issue.path);
  if (field === '') throw new InvalidInputError('body', issue.code === 'invalid_type' ? 'must be a JSON object' : issue.message);
  throw new InvalidInputError(field, issue.message);
}
