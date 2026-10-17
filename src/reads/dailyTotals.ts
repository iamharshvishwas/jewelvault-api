// C3, V4, A4, A9, O25: GET /v1/daily-totals?from=&to=. The cash book, one row per (business_date, mode) with money in, money out and net, for a range of days.
//
//   - the statement is db/queries V4 as a derived table (src/reads/queries.ts) with the range outside it: MariaDB pushes the range into both branches of V4. receipts has no index on paid_on or
//     voided_on (D19), so each branch reads the table (tests/api/derived-reads.test.ts shows the plan); a cash book of a few thousand receipts a year makes that a few milliseconds.
//   - the owner reads up to limits.dailyTotalsMaxDays (400) days in one call; a role with a window (the biller: today and yesterday, BILLER_DAILY_TOTALS_DAYS of the matrix) reads that window and
//     nothing else, and anything outside it is 403 JV_FORBIDDEN BEFORE the cash book is read. "Today" is the day of the API's clock in India (S5), not the UTC day. The matrix says which role has
//     which window (dailyTotalsWindowDays), so no role name stands here (S10).
//   - both ends are required: a range is a choice the screen makes, and a call with none would have to guess.
import type { Param } from '../db/stmt.js';
import type { Reader } from '../db/tx.js';
import { JvError } from '../errors.js';
import { limits } from '../limits.js';
import { dailyTotalsWindowDays } from '../permissions/matrix.js';
import { formatRow } from '../wire/format.js';
import * as wire from '../wire/zod.js';
import { readColumns, selectList } from './columns.js';
import { V4_TEXT } from './queries.js';

/** The statement. Parameters: from, to. Exported for the EXPLAIN test (A7). */
export function dailyTotalsStatement(columns: readonly string[]): string {
  return `SELECT ${selectList('v', columns)} FROM (${V4_TEXT}) v WHERE v.business_date BETWEEN ? AND ? ORDER BY v.business_date, v.mode`;
}

const DAY = 86_400_000;
/** The number of a calendar day (days since 1970-01-01) of a date written YYYY-MM-DD, by UTC arithmetic: no time zone plays a part. */
const dayNumber = (date: string): number => Math.round(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10))) / DAY);
const dayText = (n: number): string => new Date(n * DAY).toISOString().slice(0, 10);

const windowText = (days: number): string => (days === 1 ? 'today' : days === 2 ? 'today and yesterday' : `the last ${days} days`);

/**
 * Whether `role` may read [from, to] on `today` (the API's business date), or the refusal: 422 for a range the wrong way round or over the owner's limit, 403 JV_FORBIDDEN (with the days that
 * are open) for a role with a window when the range goes outside it. The 403 comes before the length check, so a window of two days never answers "too long".
 */
export function checkRange(role: string, from: string, to: string, today: string): void {
  const a = dayNumber(from);
  const b = dayNumber(to);
  if (b < a) throw new wire.InvalidInputError('to', 'must not be before from');
  const days = dailyTotalsWindowDays(role);
  if (days !== null) {
    const latest = dayNumber(today);
    const earliest = latest - days + 1;
    if (days < 1 || a < earliest || b > latest) {
      throw new JvError('JV_FORBIDDEN', days < 1 ? 'You are not allowed to do this.' : `You can read the cash book for ${windowText(days)} only.`, days < 1 ? {} : { details: { earliest: dayText(earliest), latest: today } });
    }
    return;
  }
  if (b - a + 1 > limits.dailyTotalsMaxDays) throw new wire.InvalidInputError('to', `must be within ${limits.dailyTotalsMaxDays} days of from`);
}

const KINDS = { business_date: 'date', money_in: 'money', money_out: 'money', net: 'money' } as const;

export async function readDailyTotals(db: Reader, role: string, from: string, to: string): Promise<{ rows: Record<string, unknown>[] }> {
  const columns = readColumns('daily_totals', role);
  const params: Param[] = [from, to];
  const raw = await db.rows<Record<string, unknown>>(dailyTotalsStatement(columns), params);
  return { rows: raw.map((r) => formatRow(r, KINDS)) };
}
