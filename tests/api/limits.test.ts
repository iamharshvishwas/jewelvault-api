import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Connection } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { limits } from '../../src/limits';
import { dropDb } from '../helpers';
import { migratedDb } from '../schema/support';

// T-F02, the clause of API06 (S3, S4, D18): the caps are literals in the CHECK constraints and also in the API's constants file (src/limits.ts, the only place the
// code reads them from). The database half's own test (tests/schema/s2-catalogue.test.ts) compares db/limits.json with the CHECKs; this one compares the constants
// file with db/limits.json and with every CHECK that has a cap in it, in both directions, so the two cannot drift.

type CapKey = 'maxAmount' | 'maxRate' | 'maxWeightGrams' | 'maxQuantity' | 'maxLines' | 'maxPhotoBytes' | 'maxPhotosPerDesign';
/** A bill's fine weight is the sum of at most maxLines lines of at most maxWeightGrams each (migration 0006 writes the product as one literal). */
type CapSpec = CapKey | 'maxLines*maxWeightGrams';

const columns = (table: string, names: string[], cap: CapSpec) => names.map((n) => [`${table}.${n}`, cap] as const);

/** Every column that has an upper bound taken from the constants file. A new CHECK with a cap in it is a conscious change of this list. */
const CAP_COLUMNS: Record<string, CapSpec> = Object.fromEntries([
  // amounts (S4: every line amount, line total, subtotal, grand total, payment, refund, discount, additional charge, opening balance and fine_cash amount)
  ...columns('bills', ['subtotal', 'discount', 'additional_charges', 'gst_amount', 'grand_total'], 'maxAmount'),
  ...columns('bill_items', ['labour_amount', 'piroi', 'other_charges', 'metal_amount', 'item_total', 'tax_amount'], 'maxAmount'),
  ...columns('skus', ['piroi'], 'maxAmount'),
  ...columns('receipts', ['amount'], 'maxAmount'),
  ...columns('receipt_allocations', ['amount'], 'maxAmount'),
  // rates and piece prices
  ...columns('bill_items', ['metal_rate', 'labour_rate', 'list_metal_rate', 'list_labour_rate'], 'maxRate'),
  ...columns('skus', ['labour_retail', 'labour_semi', 'labour_wholesale'], 'maxRate'),
  ...columns('daily_rates', ['rate_per_gram'], 'maxRate'),
  ...columns('receipts', ['silver_rate'], 'maxRate'),
  // weights
  ...columns('bill_items', ['gross_weight', 'customer_net_weight', 'fine_weight_due'], 'maxWeightGrams'),
  ...columns('skus', ['gross_weight', 'customer_net_weight', 'stone_weight', 'kundan_weight'], 'maxWeightGrams'),
  ...columns('sku_private', ['original_net_weight'], 'maxWeightGrams'),
  ...columns('receipts', ['fine_grams'], 'maxWeightGrams'),
  ...columns('receipt_allocations', ['fine_grams'], 'maxWeightGrams'),
  ...columns('bills', ['fine_weight_due'], 'maxLines*maxWeightGrams'),
  // counts, sizes
  ...columns('bill_items', ['quantity'], 'maxQuantity'),
  ...columns('bill_items', ['line_no'], 'maxLines'),
  ...columns('design_photos', ['byte_size'], 'maxPhotoBytes'),
  ...columns('sys_photo_copies', ['size'], 'maxPhotoBytes'),
  ...columns('designs', ['photo_ids'], 'maxPhotosPerDesign'), // json_length(`photo_ids`) <= 3
]);

/** The lower bounds of S4: a quantity is 1 to 1,000 and a bill has 1 to 200 lines. */
const LOWER_BOUNDS: Record<string, number> = { 'bill_items.quantity': limits.minQuantity, 'bill_items.line_no': limits.minLines };

const valueOf = (spec: CapSpec): number => (spec === 'maxLines*maxWeightGrams' ? limits.maxLines * limits.maxWeightGrams : limits[spec]);

/** Values of 1,000 and more can only be a cap; a small bound such as 3 or 20 could mean anything, so a column outside the list is not judged by it. */
const UNLISTED_WATCH_FROM = 1000;

interface Check {
  table: string;
  clause: string;
}

/** The upper bounds in a CHECK clause: `col` <= 12 and json_length(`col`) <= 3. Literals only; a bound that is another column is not a cap. */
function upperBounds(clause: string): { column: string; value: number }[] {
  const out: { column: string; value: number }[] = [];
  for (const m of clause.matchAll(/`(\w+)`\s*<=\s*(-?\d+(?:\.\d+)?)(?![\d.])/g)) out.push({ column: m[1], value: Number(m[2]) });
  for (const m of clause.matchAll(/json_length\(`(\w+)`\)\s*<=\s*(\d+)(?![\d.])/gi)) out.push({ column: m[1], value: Number(m[2]) });
  return out;
}
function lowerBounds(clause: string): { column: string; value: number }[] {
  const out: { column: string; value: number }[] = [];
  for (const m of clause.matchAll(/`(\w+)`\s*>=\s*(-?\d+(?:\.\d+)?)(?![\d.])/g)) out.push({ column: m[1], value: Number(m[2]) });
  return out;
}

/** Compares the CHECKs with the constants file. Returns one line for every difference; an empty list means they agree. */
function capDrift(checks: Check[]): string[] {
  const problems: string[] = [];
  const found = new Map<string, number[]>();
  const lower = new Map<string, number[]>();
  for (const { table, clause } of checks) {
    for (const b of upperBounds(clause)) found.set(`${table}.${b.column}`, [...(found.get(`${table}.${b.column}`) ?? []), b.value]);
    for (const b of lowerBounds(clause)) lower.set(`${table}.${b.column}`, [...(lower.get(`${table}.${b.column}`) ?? []), b.value]);
  }
  const knownValues = new Set(Object.values(CAP_COLUMNS).map(valueOf));
  for (const [column, spec] of Object.entries(CAP_COLUMNS)) {
    const values = found.get(column);
    if (!values) problems.push(`${column}: no upper bound in any CHECK (expected ${spec} = ${valueOf(spec)})`);
    else if (!values.includes(valueOf(spec))) problems.push(`${column}: CHECK says ${values.join(', ')}, the constants file says ${spec} = ${valueOf(spec)}`);
  }
  for (const [column, values] of found) {
    if (column in CAP_COLUMNS) continue;
    for (const v of values) if (v >= UNLISTED_WATCH_FROM && knownValues.has(v)) problems.push(`${column}: a cap literal (${v}) that this test does not list`);
  }
  for (const [column, value] of Object.entries(LOWER_BOUNDS)) {
    if (!lower.get(column)?.includes(value)) problems.push(`${column}: no lower bound of ${value} in any CHECK`);
  }
  return problems;
}

describe('T-F02 (API06 clause) the constants file src/limits.ts', () => {
  it('holds the caps of S4 and the thresholds of section 13 and I11 as the spec writes them', () => {
    expect({ ...limits }).toEqual({
      maxWeightGrams: 100000, // a weight is at most 100,000 g
      maxRate: 100000000, // a rate or a piece price is at most 100,000,000
      maxAmount: 1000000000, // every amount is at most 1,000,000,000
      minQuantity: 1,
      maxQuantity: 1000, // a quantity is 1 to 1,000
      minLines: 1,
      maxLines: 200, // a bill has 1 to 200 lines
      maxPhotoBytes: 2097152, // 2 MiB (Harsh's photo rule of 15 Oct 2026)
      maxPhotosPerDesign: 3,
      cashLimit: 200000, // cash_limit (Z1, Z2)
      panThreshold: 200000, // pan_threshold (Z3)
      discountFlagPercent: 10, // discount_flag_percent (I11)
      rateFlagPercent: 5, // rate_flag_percent (I11)
      sessionIdleMs: 12 * 60 * 60 * 1000, // U4: idle for more than 12 hours ends a session (O42)
      sessionAbsoluteMs: 14 * 24 * 60 * 60 * 1000, // U4: at most 14 days from the login (O42)
    });
  });

  it('cannot be changed while the program runs', () => {
    expect(Object.isFrozen(limits)).toBe(true);
    expect(() => {
      (limits as { maxAmount: number }).maxAmount = 1;
    }).toThrow();
    expect(limits.maxAmount).toBe(1000000000);
  });

  it('agrees with db/limits.json, the file the database half and its CHECK test read: every key there is here with the same value', () => {
    const json = JSON.parse(readFileSync(join(__dirname, '..', '..', 'db', 'limits.json'), 'utf8')) as Record<string, unknown>;
    const keys = Object.keys(json).filter((k) => !k.startsWith('_'));
    expect(keys.length).toBeGreaterThanOrEqual(7);
    for (const key of keys) expect(limits[key as keyof typeof limits], key).toBe(json[key]);
  });
});

describe('T-F02 (API06 clause) every cap literal in a CHECK equals the constants file', () => {
  let db: string;
  let c: Connection;
  let checks: Check[];
  beforeAll(async () => {
    ({ db, c } = await migratedDb('api06_limits'));
    const [r] = await c.query<any[]>('SELECT TABLE_NAME AS t, CHECK_CLAUSE AS cl FROM information_schema.CHECK_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE()');
    checks = r.map((x) => ({ table: String(x.t), clause: String(x.cl) }));
  });
  afterAll(async () => {
    await c.end();
    await dropDb(db);
  });

  it('reads the CHECKs from information_schema.CHECK_CONSTRAINTS (there are dozens, with caps in them)', () => {
    expect(checks.length).toBeGreaterThan(60);
    expect(checks.filter((x) => upperBounds(x.clause).length > 0).length).toBeGreaterThan(15);
  });

  it('every listed column has the cap of the constants file, no listed column lost its cap, and no cap-sized literal sits on a column the list does not know', () => {
    expect(capDrift(checks)).toEqual([]);
  });

  it('S4 as numbers: weight 100,000, rate 100,000,000, amount 1,000,000,000, quantity 1 to 1,000, lines 1 to 200 are what the CHECKs say', () => {
    const clause = (table: string, column: string) => checks.filter((x) => x.table === table && x.clause.includes(`\`${column}\``)).map((x) => x.clause).join(' ');
    expect(clause('skus', 'gross_weight')).toMatch(/<= 100000(?![\d.])/);
    expect(clause('bill_items', 'metal_rate')).toMatch(/<= 100000000(?![\d.])/);
    expect(clause('bills', 'grand_total')).toMatch(/<= 1000000000(?![\d.])/);
    expect(clause('bill_items', 'quantity')).toMatch(/>= 1 and `quantity` <= 1000(?![\d.])/);
    expect(clause('bill_items', 'line_no')).toMatch(/>= 1 and `line_no` <= 200(?![\d.])/);
  });

  describe('NEGATIVE CONTROLS: the comparison can fail', () => {
    const real = () => checks.map((x) => ({ ...x }));
    it('a CHECK whose literal drifted from the constants file is reported', () => {
      const drifted = real().map((x) => (x.table === 'bills' && x.clause.includes('`grand_total`') ? { ...x, clause: x.clause.replace('`grand_total` <= 1000000000', '`grand_total` <= 999999999') } : x));
      const problems = capDrift(drifted);
      expect(problems).toHaveLength(1);
      expect(problems[0]).toMatch(/bills\.grand_total: CHECK says 999999999/);
    });
    it('a column that lost its cap is reported', () => {
      const lost = real().map((x) => (x.table === 'receipts' && x.clause.includes('`fine_grams`') ? { ...x, clause: x.clause.replace('`fine_grams` <= 100000', '`fine_grams` >= 0') } : x));
      expect(capDrift(lost).join('\n')).toMatch(/receipts\.fine_grams: no upper bound/);
    });
    it('a cap-sized literal on a column the list does not know is reported', () => {
      const extra = [...real(), { table: 'bills', clause: '`cash_paid` <= 1000000000' }];
      expect(capDrift(extra)).toEqual(['bills.cash_paid: a cap literal (1000000000) that this test does not list']);
    });
    it('a lost lower bound of a quantity is reported', () => {
      const lost = real().map((x) => (x.table === 'bill_items' && x.clause.includes('`quantity` >= 1') ? { ...x, clause: x.clause.replace('`quantity` >= 1', '`quantity` >= 0') } : x));
      expect(capDrift(lost).join('\n')).toMatch(/bill_items\.quantity: no lower bound of 1/);
    });
    it('a rate cap that moved while the CHECKs did not is reported for every rate column', () => {
      const otherRate = real().map((x) => ({ ...x, clause: x.clause.replace(/(?<![\d.])100000000(?![\d.])/g, '90000000') }));
      const problems = capDrift(otherRate);
      expect(problems).toHaveLength(9);
      expect(problems.every((p) => /rate|labour|silver/.test(p))).toBe(true);
    });
  });
});
