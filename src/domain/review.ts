// Spec section 12, I11: THE REVIEW LINE. A report for the owner, not an invariant: it never turns the check red and nothing is blocked (O26). For one business day it counts, and lists, what the shop
// did that is worth a second look:
//
//   below_list_lines     the lines of the day's bills sold below the server's list prices (R14): the metal rate below `list_metal_rate`, or, for a By Weight line, the labour rate below
//                        `list_labour_rate`. A Per Piece line is compared on its price only (its labour rate is not used, R3, and it has no list labour price).
//   discount_over        the bills with a discount above `discount_flag_percent` (10) percent of the subtotal (exactly 10 percent is not above)
//   cash_overrides       the bills and the receipts saved with a cash override reason (Z1): the reason is stored only when the override was needed (src/domain/cashRules.ts)
//   cancellations        the bills cancelled on the day (K3)
//   reissues             the bills of the day that replace a cancelled one (reissue_of, X10)
//   voids                the receipts voided on the day (K1)
//   refunds              the refunds of the day (X11)
//   walkin_bills         the walk-in's bills of the day, and `walkin.cash_total`: the walk-in's cash of the day (Z2 does not add it up, so this is where a split sale shows)
//   fine_cash_rate_away  the fine_cash settlements whose rate is more than `rate_flag_percent` (5) percent away from EVERY Silver rate of the day, which is the latest rate dated not after the
//                        day, for each purity; with no Silver rate at all the settlement counts as away
//   biller_rate_moves    the daily rates dated the day that a biller entered (RATE_REVIEW_ROLES) and that moved more than `rate_flag_percent` percent, up or down, from the previous rate of the same
//                        material and purity (the latest one dated before it; the first rate of a purity has nothing to move from)
//   sale_type_differs    the bills whose sale type is not the customer's type (R9)
//
// WHICH DAY A ROW BELONGS TO. A bill by its `bill_date`, a receipt by its `paid_on`, a cancellation by `cancelled_on`, a void by `voided_on` (the business dates of D13, taken from the API clock in
// Asia/Kolkata). A back-dated bill (the owner may) therefore belongs to the day it is dated, not to the day it was typed in. The lines, discounts, walk-in sales and sale types are those of ACTIVE bills (a
// cancelled bill is no sale; it is on the list of cancellations); a fine_cash settlement is judged while it is active (a void is on the list of voids); the overrides, voids, cancellations, re-issues and
// refunds are listed whatever has become of them since.
//
// THE FIGURES. Every comparison is DECIMAL arithmetic in the database, never a float: the percent limits are bound as CAST(? AS DECIMAL(5,2)) (S3). A count is exact; a list holds at most
// REVIEW_LIST_ROWS rows (the owner can open 50 of them, I11). The statements only read, and they run inside the snapshot of the invariants (nightly.ts).
import type { RowDataPacket } from 'mysql2/promise';
import { limits } from '../limits.js';
import { RATE_REVIEW_ROLES } from '../permissions/matrix.js';
import type { Queryable } from './invariants.js';

/** I11: the owner can open up to 50 rows of each list. */
export const REVIEW_LIST_ROWS = 50;

export const REVIEW_LISTS = [
  'below_list_lines',
  'discount_over',
  'cash_overrides',
  'cancellations',
  'reissues',
  'voids',
  'refunds',
  'walkin_bills',
  'fine_cash_rate_away',
  'biller_rate_moves',
  'sale_type_differs',
] as const;
export type ReviewList = (typeof REVIEW_LISTS)[number];

export type ReviewRow = Record<string, string | number | null>;

export interface Review {
  /** the business day under review */
  date: string;
  /** how many rows each list would have without the cut at REVIEW_LIST_ROWS */
  counts: Record<ReviewList, number>;
  /** Z2: the walk-in's cash of the day (active `money` receipts of mode Cash and `fine_cash` receipts, opening rows left out, refunds neither added nor taken off, as Z1 counts) and its bills */
  walkin: { cash_total: string; bills: number };
  lists: Record<ReviewList, ReviewRow[]>;
}

export interface ReviewOptions {
  /** rows kept in each list; default REVIEW_LIST_ROWS */
  rows?: number;
}

interface Spec {
  sql: string;
  params: (string | number)[];
}

/** The eleven statements of the day. `date` is the day under review; none has a LIMIT (the runner adds it and counts with the statement itself). */
export function reviewStatements(date: string): Record<ReviewList, Spec> {
  const roles = RATE_REVIEW_ROLES;
  return {
    below_list_lines: {
      sql: `SELECT bi.id AS line_id, b.id AS bill_id, b.bill_no AS bill_no, bi.line_no AS line_no, bi.sku_no AS sku_no, bi.selling_method AS selling_method,
       bi.metal_rate AS metal_rate, bi.list_metal_rate AS list_metal_rate, bi.labour_rate AS labour_rate, bi.list_labour_rate AS list_labour_rate
FROM bill_items bi
JOIN bills b ON b.id = bi.bill_id
WHERE b.bill_date = ? AND b.status = 'active'
  AND (bi.metal_rate < bi.list_metal_rate
       OR (bi.selling_method = 'By Weight' AND bi.list_labour_rate IS NOT NULL AND bi.labour_rate < bi.list_labour_rate))
ORDER BY b.bill_no, bi.line_no`,
      params: [date],
    },
    discount_over: {
      sql: `SELECT b.id AS bill_id, b.bill_no AS bill_no, b.subtotal AS subtotal, b.discount AS discount
FROM bills b
WHERE b.bill_date = ? AND b.status = 'active' AND b.discount * 100 > b.subtotal * CAST(? AS DECIMAL(5,2))
ORDER BY b.bill_no`,
      params: [date, limits.discountFlagPercent],
    },
    cash_overrides: {
      sql: `SELECT u.source AS source, u.id AS id, u.ref AS ref, u.amount AS amount, u.status AS status, u.reason AS reason
FROM (SELECT 'bill' AS source, b.id AS id, b.bill_no AS ref, b.grand_total AS amount, b.status AS status, b.cash_override_reason AS reason
      FROM bills b
      WHERE b.bill_date = ? AND b.cash_override_reason IS NOT NULL
      UNION ALL
      SELECT 'receipt', r.id, CONCAT(r.kind, ' ', COALESCE(r.mode, '')), r.amount, r.status, r.cash_override_reason
      FROM receipts r
      WHERE r.paid_on = ? AND r.cash_override_reason IS NOT NULL) u
ORDER BY u.source, u.ref, u.id`,
      params: [date, date],
    },
    cancellations: {
      sql: `SELECT b.id AS bill_id, b.bill_no AS bill_no, b.grand_total AS grand_total, b.cancel_reason AS cancel_reason, b.cancelled_by AS cancelled_by
FROM bills b
WHERE b.status = 'cancelled' AND b.cancelled_on = ?
ORDER BY b.cancelled_at, b.bill_no`,
      params: [date],
    },
    reissues: {
      sql: `SELECT b.id AS bill_id, b.bill_no AS bill_no, b.reissue_of AS reissue_of, o.bill_no AS original_bill_no, b.grand_total AS grand_total
FROM bills b
JOIN bills o ON o.id = b.reissue_of
WHERE b.bill_date = ?
ORDER BY b.bill_no`,
      params: [date],
    },
    voids: {
      sql: `SELECT r.id AS receipt_id, r.customer_id AS customer_id, r.kind AS kind, r.mode AS mode, r.amount AS amount, r.fine_grams AS fine_grams, r.void_reason AS void_reason, r.voided_by AS voided_by
FROM receipts r
WHERE r.status = 'voided' AND r.voided_on = ?
ORDER BY r.voided_at, r.id`,
      params: [date],
    },
    refunds: {
      sql: `SELECT r.id AS receipt_id, r.customer_id AS customer_id, r.mode AS mode, r.amount AS amount, r.status AS status
FROM receipts r
WHERE r.kind = 'refund' AND r.paid_on = ?
ORDER BY r.created_at, r.id`,
      params: [date],
    },
    walkin_bills: {
      sql: `SELECT b.id AS bill_id, b.bill_no AS bill_no, b.grand_total AS grand_total
FROM bills b
JOIN customers c ON c.id = b.customer_id
WHERE c.is_walkin = 1 AND b.bill_date = ? AND b.status = 'active'
ORDER BY b.bill_no`,
      params: [date],
    },
    fine_cash_rate_away: {
      sql: `SELECT r.id AS receipt_id, r.customer_id AS customer_id, r.fine_grams AS fine_grams, r.silver_rate AS silver_rate, r.amount AS amount
FROM receipts r
WHERE r.kind = 'fine_cash' AND r.status = 'active' AND r.paid_on = ?
  AND NOT EXISTS (
    SELECT 1
    FROM daily_rates d
    WHERE d.material = 'Silver'
      AND d.rate_date = (SELECT MAX(d2.rate_date) FROM daily_rates d2 WHERE d2.material = 'Silver' AND d2.purity = d.purity AND d2.rate_date <= r.paid_on)
      AND ABS(r.silver_rate - d.rate_per_gram) * 100 <= CAST(? AS DECIMAL(5,2)) * d.rate_per_gram)
ORDER BY r.created_at, r.id`,
      params: [date, limits.rateFlagPercent],
    },
    biller_rate_moves: {
      sql: `SELECT d.id AS rate_id, d.material AS material, d.purity AS purity, d.rate_per_gram AS rate_per_gram, p.rate_per_gram AS previous_rate, p.rate_date AS previous_date, d.created_by AS entered_by
FROM daily_rates d
JOIN users u ON u.id = d.created_by AND u.role IN (${roles.map(() => '?').join(', ')})
JOIN daily_rates p ON p.material = d.material AND p.purity = d.purity
 AND p.rate_date = (SELECT MAX(q.rate_date) FROM daily_rates q WHERE q.material = d.material AND q.purity = d.purity AND q.rate_date < d.rate_date)
WHERE d.rate_date = ? AND ABS(d.rate_per_gram - p.rate_per_gram) * 100 > CAST(? AS DECIMAL(5,2)) * p.rate_per_gram
ORDER BY d.material, d.purity, d.id`,
      params: [...roles, date, limits.rateFlagPercent],
    },
    sale_type_differs: {
      sql: `SELECT b.id AS bill_id, b.bill_no AS bill_no, b.customer_id AS customer_id, b.sale_type AS sale_type, c.customer_type AS customer_type
FROM bills b
JOIN customers c ON c.id = b.customer_id
WHERE b.bill_date = ? AND b.status = 'active' AND b.doc_type <> 'opening_balance' AND b.sale_type <> c.customer_type
ORDER BY b.bill_no`,
      params: [date],
    },
  };
}

/** Z2: the walk-in's cash of the day, exact (DECIMAL text with 2 decimals). */
export const WALKIN_CASH_SQL = `SELECT CAST(COALESCE(SUM(r.amount), 0) AS DECIMAL(18,2)) AS total
FROM receipts r
JOIN customers c ON c.id = r.customer_id
WHERE c.is_walkin = 1 AND r.status = 'active' AND r.paid_on = ? AND r.is_opening = 0 AND ((r.kind = 'money' AND r.mode = 'Cash') OR r.kind = 'fine_cash')`;

const plain = (row: RowDataPacket): ReviewRow => ({ ...row }) as ReviewRow;

/** The review of one business day. Reads only; call it inside the snapshot of the invariants so that it sees the same moment. */
export async function buildReview(conn: Queryable, date: string, opts: ReviewOptions = {}): Promise<Review> {
  const cap = Number.isInteger(opts.rows) && (opts.rows as number) > 0 ? (opts.rows as number) : REVIEW_LIST_ROWS;
  const statements = reviewStatements(date);
  const counts = {} as Record<ReviewList, number>;
  const lists = {} as Record<ReviewList, ReviewRow[]>;
  for (const name of REVIEW_LISTS) {
    const { sql, params } = statements[name];
    const [found] = await conn.query<RowDataPacket[]>(`${sql}\nLIMIT ${cap}`, params);
    lists[name] = found.map(plain);
    // a list shorter than the cut is the whole list; only a full one needs the exact count
    counts[name] = found.length < cap ? found.length : Number((await conn.query<RowDataPacket[]>(`SELECT COUNT(*) AS n FROM (\n${sql}\n) q`, params))[0][0].n);
  }
  const cash = (await conn.query<RowDataPacket[]>(WALKIN_CASH_SQL, [date]))[0][0];
  return { date, counts, walkin: { cash_total: String(cash.total), bills: counts.walkin_bills }, lists };
}
