// Spec I8 (the phase `nightly_check` of the hourly tick), I6, I11, D17: THE NIGHTLY CHECK. One call runs everything the owner's "Books: OK at 02:00" line stands on, in ONE REPEATABLE READ snapshot inside
// ONE request (never sliced: a second request would be another moment, and a payment saved between the two would be a false alarm):
//
//   1. the SQL halves of I1 to I7, I10 and I13 (src/domain/invariants.ts, the twin of scripts/invariants.mjs, whose files are embedded in invariantSql.ts),
//   2. the Node half of I6: every stored line equals a fresh priceLine of the pinned pricing_version over the stored snapshot (checkLinePricing),
//   3. the review line I11 for the previous business day (src/domain/review.ts): a report, it never turns the check red,
//
// and then writes ONE check_runs row: `ok` (1 when no invariant has a broken row, whatever the review says) and `details`:
//
//   { date,                       the business date the run is for (the tick's run_date)
//     counts: { I1: 0, ... },     the number of broken rows of each invariant that ran (I6 counts the SQL rows and the lines of the Node half)
//     samples: { I6: [{ row_ref, detail }] },   at most `sample` (20) rows of each invariant that has any
//     ran: ['I1', ...],
//     review: { date, counts, walkin, lists } }   I11: the previous business day, each list at most 50 rows (the owner opens them from GET /v1/health/checks)
//
// THE CALLER. The tick (API33) takes one pool connection, holds the job lock on it (withJobLock) and calls this on it; a test checks one out of the pool. The connection must be in autocommit, not inside a
// transaction (START TRANSACTION commits one that is open). The statement limit is the tick's, 20 seconds, set for the run and put back (a pooled connection lives on); the 12 s deadline of S12 belongs to
// the requests of the screens and does not apply here, the handler timer of the tick (50 s) does. The run fails visibly: a database error, a statement past 20 s or a bug in a pricing function is thrown, no
// row is written (a row would claim a verdict nobody reached), and the tick marks the phase failed; the dashboard line turns red on its own when no check has been written for 26 hours.
// The tick writes the phase's `event` row and `sys_job_runs` itself; this function touches no other table than check_runs.
import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import type { Clock } from '../clock.js';
import type { DbConnection } from '../db/pool.js';
import { INVARIANT_SAMPLE_ROWS, type InvariantRow, type PricingCheck, type RunOptions, checkLinePricing, runInvariants } from '../domain/invariants.js';
import { type Review, buildReview } from '../domain/review.js';
import { PRICING_VERSIONS, type VersionTable } from '../money/x07QuoteBill.js';
import { isBusinessDate } from '../wire/format.js';

/** The tick's statement limit (I8, S11): the check has 20 seconds for any one statement. */
export const NIGHTLY_STATEMENT_SECONDS = 20;

export interface NightlyOptions {
  /** The API's clock (S5): the run's business date and the time written on the row come from it. */
  clock: Clock;
  /** The business date the run is for (the tick's run_date). Default: today of the clock. The review is for the day before it. */
  date?: string;
  /** The pricing functions by version (R13). Default: the application's table. */
  versions?: VersionTable;
  /** Sample rows kept of each invariant in the row and in the result. Default 20. */
  sample?: number;
  /** Rows kept in each list of the review line. Default 50. */
  reviewRows?: number;
  /** Test seams of runInvariants: an injected old query (T-B18, I13) and a hook that runs between the invariant queries. The application passes neither. */
  queries?: RunOptions['queries'];
  between?: RunOptions['between'];
}

export interface NightlyResult {
  /** no invariant has a broken row; the review line has no say */
  ok: boolean;
  /** the business date of the run */
  date: string;
  /** the day the review line is about: the day before `date` */
  reviewDate: string;
  counts: Record<string, number>;
  /** at most `sample` rows of each invariant, in the order of the invariants */
  rows: InvariantRow[];
  ran: string[];
  review: Review;
  /** the id of the check_runs row that was written */
  checkRunId: number;
}

/** The calendar day before a business date ('2026-03-01' gives '2026-02-28'). */
export function previousDay(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
}

export async function runNightlyCheck(conn: DbConnection, options: NightlyOptions): Promise<NightlyResult> {
  const date = options.date ?? options.clock.read().date;
  if (!isBusinessDate(date)) throw new TypeError('the date of the nightly check is a business date, YYYY-MM-DD');
  const reviewDate = previousDay(date);
  const sample = Number.isInteger(options.sample) && (options.sample as number) > 0 ? (options.sample as number) : INVARIANT_SAMPLE_ROWS;

  const parts: { pricing?: PricingCheck; review?: Review } = {};
  const limitBefore = Number(((await conn.query<RowDataPacket[]>('SELECT @@session.max_statement_time AS m'))[0])[0].m);
  await conn.query('SET SESSION max_statement_time = ?', [NIGHTLY_STATEMENT_SECONDS]);
  let run: Awaited<ReturnType<typeof runInvariants>>;
  try {
    run = await runInvariants(conn, {
      sample,
      queries: options.queries,
      between: options.between,
      // the Node half of I6 and the review line read the snapshot of the files: same moment, same transaction
      inSnapshot: async (c) => {
        parts.pricing = await checkLinePricing(c, { versions: options.versions ?? PRICING_VERSIONS, sample });
        parts.review = await buildReview(c, reviewDate, { rows: options.reviewRows });
      },
    });
  } finally {
    await conn.query('SET SESSION max_statement_time = ?', [limitBefore]).catch(() => undefined);
  }
  if (!parts.pricing || !parts.review) throw new Error('the snapshot of the nightly check ended before the Node half ran');

  // I6 is one invariant in two halves: one count, one sample of at most `sample` rows
  const counts = { ...run.counts, I6: (run.counts.I6 ?? 0) + parts.pricing.count };
  const rows = [...run.rows];
  for (const r of parts.pricing.rows) if (rows.filter((x) => x.invariant === 'I6').length < sample) rows.push(r);
  rows.sort((a, b) => run.ran.indexOf(a.invariant) - run.ran.indexOf(b.invariant)); // stable: the order of the invariants, each in its own order
  const ok = Object.values(counts).every((n) => n === 0);

  const samples: Record<string, { row_ref: string; detail: string }[]> = {};
  for (const r of rows) (samples[r.invariant] ??= []).push({ row_ref: r.row_ref, detail: r.detail });
  const details = { date, counts, samples, ran: run.ran, review: parts.review };
  const [written] = await conn.query<ResultSetHeader>('INSERT INTO check_runs (ran_at, ok, details) VALUES (?, ?, ?)', [options.clock.read().timestamp, ok ? 1 : 0, JSON.stringify(details)]);
  return { ok, date, reviewDate, counts, rows, ran: run.ran, review: parts.review, checkRunId: Number(written.insertId) };
}
