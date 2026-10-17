// A5, D6, D7, D5: what each editable column accepts, how a value is bound to a statement, and when a value is the one already stored (so that an edit that changes nothing writes nothing).
//
// A FieldSpec is for ONE column of ONE table. Which columns a role may send is the matrix's (WRITE_COLUMNS, matrix.ts); what a column takes is here. The wire formats are the building blocks of
// src/wire/zod.ts: money, rate and weight are text with their decimals and caps (S3, S4), a count is a JSON integer, an id is a lower-case UUID. A refusal names the field and never repeats
// the value (S8), and no message says "not a field": that sentence is the unknown-field refusal of parseInput and the generated test of the matrix relies on it.
//
// WIDTHS. The widths of the text columns are the columns' own (VARCHAR(120) for a design's name, 60 for a piece's location, 80 for a category's name, 20 for a purity): a longer text would be a
// database error (1406) and so a JV_INTERNAL, and it is refused here instead. Two limits are this task's own choice and are not in the spec: a TEXT column (description, notes) takes at most
// 10,000 characters (the column holds 65,535 bytes, 16,383 characters at four bytes each, so the choice leaves room), and a design has at most 20 tags of 1 to 40 characters.
import { z } from 'zod';
import type { Param } from '../db/stmt.js';
import { limits } from '../limits.js';
import * as wire from '../wire/zod.js';

export interface FieldSpec {
  /** The wire value to the value the statement uses (trimmed text, a list of ids). */
  readonly schema: z.ZodType;
  /** Whether the value the database returned for the column is the value asked for. */
  readonly same: (stored: unknown, value: unknown) => boolean;
  /** The value as a statement parameter. `now` is the database text of the reading of the API clock that stamps this write. */
  readonly param: (value: unknown, now: string) => Param;
}

const required = (what: string) => (issue: { input?: unknown }) => (issue.input === undefined ? 'is required' : what);

// ------------------------------------------------------------------ text

export const TEXT_MAX = 10_000;
export const TAGS_MAX = 20;
export const TAG_MAX = 40;

const plain: Pick<FieldSpec, 'same' | 'param'> = {
  same: (stored, value) => stored === value,
  param: (value) => value as Param,
};

/** Text that must be there: trimmed, 1 to `max` characters. */
export function requiredText(max: number): FieldSpec {
  const schema = z
    .string({ error: required('must be text') })
    .trim()
    .min(1, 'must not be empty')
    .max(max, `must be at most ${max} characters`);
  return { schema, ...plain };
}

/** Text or nothing: trimmed, blank means none (null), at most `max` characters. */
export function optionalText(max: number): FieldSpec {
  const schema = z
    .string({ error: required('must be text, or null for none') })
    .trim()
    .max(max, `must be at most ${max} characters`)
    .transform((s) => (s === '' ? null : s))
    .nullable();
  return { schema, ...plain };
}

/** One of a fixed list of words, as the column's CHECK has them. */
export function oneOf(words: readonly string[]): FieldSpec {
  const schema = z.string({ error: required(`must be one of ${words.join(', ')}`) }).check((ctx) => {
    if (!words.includes(ctx.value)) ctx.issues.push({ code: 'custom', message: `must be one of ${words.join(', ')}`, input: ctx.value });
  });
  return { schema, ...plain };
}

/** A pattern the column's CHECK has too (a category's prefix: 2 to 6 capital letters or digits). The text is NOT trimmed or changed: a prefix in lower case is refused, not corrected. */
export function patterned(pattern: RegExp, rule: string): FieldSpec {
  const schema = z.string({ error: required(rule) }).check((ctx) => {
    if (!pattern.test(ctx.value)) ctx.issues.push({ code: 'custom', message: rule, input: ctx.value });
  });
  return { schema, ...plain };
}

// ------------------------------------------------------------------ numbers

/** DECIMAL text to whole units (milligrams, paise) with `scale` decimals, by string work: no float anywhere. */
export function decimalUnits(text: string, scale: number): bigint {
  const [whole, fraction = ''] = text.split('.');
  return BigInt(whole + fraction.padEnd(scale, '0').slice(0, scale));
}

function decimal(schema: z.ZodType, scale: number): FieldSpec {
  return {
    schema,
    same: (stored, value) => typeof stored === 'string' && decimalUnits(stored, scale) === decimalUnits(value as string, scale),
    param: (value) => value as Param,
  };
}

/** A weight in grams, 3 decimals, at most 100,000 (S4). */
export const weight: FieldSpec = decimal(wire.weight, 3);
/** An amount of money, 2 decimals, at most 1,000,000,000 (S4): a piroi. */
export const amount: FieldSpec = decimal(wire.amount, 2);
/** A rate or a piece price, 2 decimals, at most 100,000,000 (S4). */
export const rate: FieldSpec = decimal(wire.rate, 2);

const COUNT_MAX = 100_000;
const countMessage = `must be a whole number from 0 to ${COUNT_MAX.toLocaleString('en-US')}`;
/** A count (stones, kundan): a JSON integer from 0 up (the columns are INT with a CHECK of 0 or more; the upper bound is this task's own choice). */
export const count: FieldSpec = {
  schema: z.number({ error: required(countMessage) }).int(countMessage).min(0, countMessage).max(COUNT_MAX, countMessage),
  same: (stored, value) => Number(stored) === value,
  param: (value) => value as Param,
};

/** A flag (`active`): a JSON boolean; the column is TINYINT(1). */
export const flag: FieldSpec = {
  schema: z.boolean({ error: required('must be true or false') }),
  same: (stored, value) => Number(stored) === (value ? 1 : 0),
  param: (value) => (value ? 1 : 0),
};

// ------------------------------------------------------------------ ids, lists, the archive time

/** An id that must be there (a design's category). */
export const idRequired: FieldSpec = { schema: wire.uuid, ...plain };
/** An id or nothing (a design's subcategory, its primary photo). */
export const idOrNull: FieldSpec = { schema: wire.uuid.nullable(), ...plain };

const sameList = (stored: unknown, value: unknown): boolean => JSON.stringify(parseList(stored)) === JSON.stringify(value);

/** A JSON column as the driver hands it back: parsed, or as text. */
export function parseList(stored: unknown): unknown[] {
  const parsed = typeof stored === 'string' ? (JSON.parse(stored) as unknown) : stored;
  return Array.isArray(parsed) ? parsed : [];
}

/** The tags of a design: a list of 1 to 40 character words, at most 20 of them. */
export const tags: FieldSpec = {
  schema: z
    .array(z.string({ error: 'must be text' }).trim().min(1, 'must not be empty').max(TAG_MAX, `must be at most ${TAG_MAX} characters`), { error: required('must be a list of words') })
    .max(TAGS_MAX, `must have at most ${TAGS_MAX} tags`),
  same: sameList,
  param: (value) => JSON.stringify(value),
};

/** The photo ids of a design: a list of at most 3 distinct lower-case UUIDs (A5, P2 (a), P4). Whether each one is attachable is the design edit's rule, which asks the database. */
export const photoIds: FieldSpec = {
  schema: z
    .array(wire.uuid, { error: required('must be a list of photo ids') })
    .max(limits.maxPhotosPerDesign, `must have at most ${limits.maxPhotosPerDesign} photos`)
    .refine((ids) => new Set(ids).size === ids.length, 'must not name a photo twice'),
  same: sameList,
  param: (value) => JSON.stringify(value),
};

/**
 * `archived_at` of a design: null brings it back, a timestamp as the server writes it archives it. The time that is stored is the API clock's reading and not the one sent (S6: the stamps of a write come
 * from the API clock); the one sent only has to be a timestamp, and means "now". Archiving an archived design again changes nothing, so the first archive time stays.
 */
export const archiveTime: FieldSpec = {
  schema: wire.timestamp.nullable(),
  same: (stored, value) => (stored === null) === (value === null),
  param: (value, now) => (value === null ? null : now),
};
