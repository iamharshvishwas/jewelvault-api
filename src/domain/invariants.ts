// Spec section 12: runInvariants() and the Node half of I6, for the nightly check (API32, src/jobs/nightly.ts).
//
// runInvariants is the TYPESCRIPT TWIN of runInvariants in scripts/invariants.mjs (MB02): the build compiles src/ alone (tsconfig.build.json, rootDir src) and cannot import a scripts/*.mjs file.
// It does what the original does, statement for statement: each file of db/invariants (embedded in invariantSql.ts) is one SELECT that returns the rows that break one rule as (invariant, row_ref,
// detail), the whole run reads ONE snapshot (REPEATABLE READ for the next transaction only, then START TRANSACTION WITH CONSISTENT SNAPSHOT: at READ COMMITTED every statement would read its own
// moment), the optimizer's split_materialized plan is switched off for the run and put back, and nothing is written. One thing is added, and is added to the original too: `inSnapshot(conn)`, called once
// inside the transaction after the last file, so that the Node half of I6 and the review line (I11) read the SAME moment as the files. tests/api/nightly-invariants.test.ts runs both functions on the
// same database and compares the answers.
//
// THE NODE HALF OF I6 (checkLinePricing). I6 says each stored line amount (metal_amount, labour_amount, fine_weight_due, item_total) equals a fresh run of priceLine of pricing.ts for the bill's
// pricing_version over the stored snapshot (R13); SQL cannot run that code. The SQL half (db/invariants/I06_bill_totals.sql) checks the rest: subtotal and fine_weight_due are the sums of the stored lines,
// grand_total is round(subtotal - discount + additional_charges, 0) and round_off is 0 or the difference. Together they are I6: when every line equals its fresh run, those header sums ARE the sums of the
// fresh lines, so nothing is repeated here.
// Each line is priced by itself, with the function of the version table that its bill's pricing_version names (a bill priced under version 1 stays version 1 after a later rule becomes version 2); a
// version the table does not know, and a line the rule refuses to price, are named as I6 problems and not thrown: a check that stops at the first odd row would hide every other one.
import type { RowDataPacket } from 'mysql2/promise';
import type { DbConnection } from '../db/pool.js';
import { PRICING_VERSIONS, type VersionTable, priceWithVersion } from '../money/x07QuoteBill.js';
import { formatMoneyFromPaise, formatWeightFromMilligrams } from '../wire/format.js';
import { DERIVED_READS, INVARIANT_FILES } from './invariantSql.js';
import { type Material, type PriceLineInput, PricingError, type SaleType, type SellingMethod, parseGrams, parseRupees } from './pricing.js';

/** What the runner needs of a connection: a checked-out pool connection fits, so does the connection of a script. */
export type Queryable = Pick<DbConnection, 'query'>;

export interface InvariantRow {
  invariant: string;
  row_ref: string;
  detail: string;
}

export interface RunOptions {
  /** Rows kept per invariant in `rows` (the counts always cover everything). Default INVARIANT_SAMPLE_ROWS. */
  sample?: number;
  /** Replaces one of the derived reads by other SQL text (a test injects an old or wrong V3 or V4, T-B18, I13). */
  queries?: Partial<Record<'V1' | 'V2' | 'V3' | 'V4', string>>;
  /** Test seam: called after each invariant query, so a test can commit a change while the run is in progress. */
  between?: (invariant: string) => Promise<void>;
  /** Called once, inside the snapshot, after the last file and before COMMIT. A failure rolls the snapshot back. */
  inSnapshot?: (conn: Queryable) => Promise<void>;
}

export interface RunResult {
  ok: boolean;
  counts: Record<string, number>;
  rows: InvariantRow[];
  ran: string[];
}

/** I8: the check_runs row holds at most this many sample rows of each invariant. */
export const INVARIANT_SAMPLE_ROWS = 20;

/** The file's single SELECT, ready to sit inside a derived table: no trailing semicolon. */
const asSubquery = (sql: string): string => sql.trim().replace(/;+\s*$/, '');

/** {{V1}} to {{V4}} become the text of the derived reads of section 11 (queries, not views), in parentheses. One pass: the text put in is not read again. */
function expand(sql: string, queries: Readonly<Record<string, string | undefined>>): string {
  return sql.replace(/\{\{(V\d)\}\}/g, (_, name: string) => {
    const text = queries[name];
    if (!text) throw new Error(`invariant file refers to {{${name}}}, which is not a query`);
    return `(\n${text}\n)`;
  });
}

const first = async (conn: Queryable, sql: string): Promise<RowDataPacket> => (await conn.query<RowDataPacket[]>(sql))[0][0];

/**
 * Runs every invariant file inside ONE consistent snapshot and returns the rows that break a rule. The connection must not be inside a transaction: START TRANSACTION commits one that is open.
 * The session's isolation level is left alone (SET TRANSACTION is for the next transaction only), and so is its optimizer switch.
 */
export async function runInvariants(conn: Queryable, opts: RunOptions = {}): Promise<RunResult> {
  const queries = { ...DERIVED_READS, ...(opts.queries ?? {}) };
  const sample = Number.isInteger(opts.sample) && (opts.sample as number) > 0 ? (opts.sample as number) : INVARIANT_SAMPLE_ROWS;
  const counts: Record<string, number> = {};
  const rows: InvariantRow[] = [];
  const ran: string[] = [];
  // MariaDB may answer "customers joined to a grouped derived table" by re-building that derived table once per customer (split_materialized, shown as LATERAL DERIVED in EXPLAIN). With bad
  // statistics (right after a bulk load or a restore) that took more than 500 seconds for I10 on 30,000 bills, against 0.1 second with it off. The switch is put back afterwards.
  const splitWasOn = /split_materialized=on/.test(String((await first(conn, 'SELECT @@session.optimizer_switch AS s')).s));
  if (splitWasOn) await conn.query("SET SESSION optimizer_switch = 'split_materialized=off'");
  await conn.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
  await conn.query('START TRANSACTION WITH CONSISTENT SNAPSHOT');
  try {
    for (const f of INVARIANT_FILES) {
      const body = expand(asSubquery(f.sql), queries);
      const counted = await first(conn, `SELECT COUNT(*) AS n FROM (\n${body}\n) q`);
      counts[f.id] = Number(counted.n);
      if (counts[f.id] > 0) {
        const [found] = await conn.query<RowDataPacket[]>(`SELECT q.invariant, q.row_ref, q.detail FROM (\n${body}\n) q ORDER BY q.row_ref, q.detail LIMIT ${sample}`);
        for (const r of found) rows.push({ invariant: String(r.invariant), row_ref: String(r.row_ref), detail: String(r.detail) });
      }
      ran.push(f.id);
      if (opts.between) await opts.between(f.id);
    }
    if (opts.inSnapshot) await opts.inSnapshot(conn);
    await conn.query('COMMIT');
  } catch (e) {
    await conn.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    if (splitWasOn) await conn.query("SET SESSION optimizer_switch = 'split_materialized=on'").catch(() => undefined);
  }
  return { ok: Object.values(counts).every((n) => n === 0), counts, rows, ran };
}

// ------------------------------------------------------------------ I6, the Node half

export interface PricingCheck {
  /** every line (and every bill whose version is unknown) that did not equal its fresh run */
  count: number;
  /** the first `sample` of them, as I6 rows: row_ref `bill_items:<id>`, or `bills:<id>` for a bill that cannot be priced at all */
  rows: InvariantRow[];
}

export interface PricingCheckOptions {
  /** The pricing functions by version (R13). Default: the application's table. A test registers a version 2 of its own here. */
  versions?: VersionTable;
  sample?: number;
  /** Lines read at a time (keyset on the line id, inside the one snapshot). */
  page?: number;
}

const LINE_COLUMNS = `SELECT bi.id AS id, bi.bill_id AS bill_id, b.bill_no AS bill_no, bi.line_no AS line_no, b.pricing_version AS pricing_version, b.sale_type AS sale_type,
       bi.material AS material, bi.selling_method AS selling_method, bi.customer_net_weight AS customer_net_weight, bi.quantity AS quantity,
       bi.metal_rate AS metal_rate, bi.labour_rate AS labour_rate, bi.piroi AS piroi, bi.other_charges AS other_charges,
       bi.metal_amount AS metal_amount, bi.labour_amount AS labour_amount, bi.fine_weight_due AS fine_weight_due, bi.item_total AS item_total
FROM bill_items bi
JOIN bills b ON b.id = bi.bill_id`;
export const FIRST_LINES_SQL = `${LINE_COLUMNS}
ORDER BY bi.id
LIMIT ?`;
export const NEXT_LINES_SQL = `${LINE_COLUMNS}
WHERE bi.id > ?
ORDER BY bi.id
LIMIT ?`;

/** Every stored line of every bill that has lines, priced again from its own snapshot with the function of its bill's version. Reads only; call it inside the snapshot of the other invariants. */
export async function checkLinePricing(conn: Queryable, opts: PricingCheckOptions = {}): Promise<PricingCheck> {
  const versions = opts.versions ?? PRICING_VERSIONS;
  const sample = Number.isInteger(opts.sample) && (opts.sample as number) > 0 ? (opts.sample as number) : INVARIANT_SAMPLE_ROWS;
  const page = opts.page ?? 2000;
  const out: PricingCheck = { count: 0, rows: [] };
  const problem = (row_ref: string, detail: string) => {
    out.count++;
    if (out.rows.length < sample) out.rows.push({ invariant: 'I6', row_ref, detail });
  };
  const unknown = new Set<string>(); // a bill whose version is not in the table is one problem, not one for each of its lines
  let after: string | null = null;
  for (;;) {
    const lines: RowDataPacket[] = (await conn.query<RowDataPacket[]>(after === null ? FIRST_LINES_SQL : NEXT_LINES_SQL, after === null ? [page] : [after, page]))[0];
    for (const r of lines) {
      const version = Number(r.pricing_version);
      const at = `line ${String(r.line_no)} of bill ${String(r.bill_no)}`;
      if (!Object.hasOwn(versions, version)) {
        const bill = String(r.bill_id);
        if (!unknown.has(bill)) {
          unknown.add(bill);
          problem(`bills:${bill}`, `bill ${String(r.bill_no)}: priced with pricing version ${version}, which this build does not know, so its lines cannot be priced again`);
        }
        continue;
      }
      try {
        const line: PriceLineInput = {
          material: r.material as Material,
          sellingMethod: r.selling_method as SellingMethod,
          customerNetWeightMg: parseGrams(String(r.customer_net_weight)),
          quantity: Number(r.quantity),
          metalRatePaise: parseRupees(String(r.metal_rate)),
          labourRatePaise: parseRupees(String(r.labour_rate)),
          piroiPaise: parseRupees(String(r.piroi)),
          otherChargesPaise: parseRupees(String(r.other_charges)),
        };
        const fresh = priceWithVersion(versions, version, { saleType: r.sale_type as SaleType, lines: [line], roundOffSetting: false }).lines[0];
        const differences: string[] = [];
        const money = (column: 'metal_amount' | 'labour_amount' | 'item_total', paise: number) => {
          if (parseRupees(String(r[column])) !== paise) differences.push(`${column} ${String(r[column])} but a fresh run of version ${version} gives ${formatMoneyFromPaise(paise)}`);
        };
        money('metal_amount', fresh.metalAmountPaise);
        money('labour_amount', fresh.labourAmountPaise);
        if (parseGrams(String(r.fine_weight_due)) !== fresh.fineWeightDueMg) {
          differences.push(`fine_weight_due ${String(r.fine_weight_due)} but a fresh run of version ${version} gives ${formatWeightFromMilligrams(fresh.fineWeightDueMg)}`);
        }
        money('item_total', fresh.itemTotalPaise);
        if (differences.length > 0) problem(`bill_items:${String(r.id)}`, `${at}: ${differences.join('; ')}`);
      } catch (e) {
        if (!(e instanceof PricingError)) throw e;
        problem(`bill_items:${String(r.id)}`, `${at}: the pricing rule of version ${version} refuses the stored snapshot (${e.message})`);
      }
    }
    if (lines.length < page) break;
    after = String(lines[lines.length - 1].id);
  }
  return out;
}
