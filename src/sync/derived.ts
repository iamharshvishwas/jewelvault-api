// V1 bill_summary and V2 customer_balances for the rows of ONE PAGE (C3, C4, NODE-DESIGN 4.2).
//
// The page itself is cut from the base table by (updated_at, id) with the index of that table (page.ts); these statements only work out the figures of the rows the page holds. They are the
// text of db/queries/V1_bill_summary.sql and db/queries/V2_customer_balance_one.sql with the filter `WHERE <alias>.id IN (...)` where those files filter by nothing or by one customer: the same
// correlated sub-selects, never a join to a grouped derived table (RM5-1), the same figures in the same columns. tests/api/sync-reads.test.ts compares every row with the query files, so a
// change in one place and not in the other fails. The statement is not a sync comparison (no `updated_at > ?`): the one that is has the base table alone in its plan.
//
// Why two statements and not one: with the cut and the figures in one statement MariaDB would have to be trusted to cut first, which is unknown [U]; this way the cut is the plain keyset
// statement that A7 and the EXPLAIN test judge, and the figures are asked for at most 1,000 ids. Both run inside the snapshot of the call (withRead, snapshot), so they see one moment.

/** One `?` for each id. */
const marks = (n: number): string => Array.from({ length: n }, () => '?').join(', ');

/** V1 for the bills with these ids (one `?` each). Columns: id, bill_no, customer_id, bill_date, doc_type, sale_type, status, reissue_of, grand_total, received, pending, fine_due, fine_settled, fine_pending, payment_status, item_count, created_at, updated_at. */
export function billSummaryFigures(n: number): string {
  return `SELECT
  t.id AS id,
  t.bill_no AS bill_no,
  t.customer_id AS customer_id,
  t.bill_date AS bill_date,
  t.doc_type AS doc_type,
  t.sale_type AS sale_type,
  t.status AS status,
  t.reissue_of AS reissue_of,
  t.grand_total AS grand_total,
  CAST(IF(t.status = 'active', t.m, 0) AS DECIMAL(18,2)) AS received,
  CAST(IF(t.status = 'active', t.grand_total - t.m, 0) AS DECIMAL(18,2)) AS pending,
  t.fine_weight_due AS fine_due,
  CAST(IF(t.status = 'active', t.f, 0) AS DECIMAL(16,3)) AS fine_settled,
  CAST(IF(t.status = 'active', t.fine_weight_due - t.f, 0) AS DECIMAL(16,3)) AS fine_pending,
  CASE
    WHEN t.status <> 'active' THEN 'Cancelled'
    WHEN t.grand_total - t.m = 0 AND t.fine_weight_due - t.f = 0 THEN 'Paid'
    WHEN t.m > 0 OR t.f > 0 THEN 'Partial'
    ELSE 'Pending'
  END AS payment_status,
  t.item_count AS item_count,
  t.created_at AS created_at,
  t.updated_at AS updated_at
FROM (
  SELECT
    b.id, b.bill_no, b.customer_id, b.bill_date, b.doc_type, b.sale_type, b.status, b.reissue_of, b.grand_total, b.fine_weight_due, b.created_at, b.updated_at,
    COALESCE((SELECT SUM(al.amount) FROM receipt_allocations al FORCE INDEX (ix_allocations_bill) JOIN receipts r ON r.id = al.receipt_id
               WHERE al.bill_id = b.id AND al.customer_id = b.customer_id AND al.released_at IS NULL AND r.status = 'active'), 0) AS m,
    COALESCE((SELECT SUM(al.fine_grams) FROM receipt_allocations al FORCE INDEX (ix_allocations_bill) JOIN receipts r ON r.id = al.receipt_id
               WHERE al.bill_id = b.id AND al.customer_id = b.customer_id AND al.released_at IS NULL AND r.status = 'active'), 0) AS f,
    (SELECT COUNT(*) FROM bill_items i WHERE i.bill_id = b.id) AS item_count
  FROM bills b
  WHERE b.id IN (${marks(n)})
) t`;
}

/** V2 for the customers with these ids (one `?` each). Columns: id, billed, total_purchases, received, refunded, allocated, outstanding, advance, balance, fine_billed, fine_received, fine_allocated, fine_outstanding, fine_advance, fine_balance, last_purchase, updated_at. */
export function customerBalanceFigures(n: number): string {
  return `SELECT
  t.id AS id,
  CAST(COALESCE(t.billed, 0) AS DECIMAL(18,2)) AS billed,
  CAST(COALESCE(t.total_purchases, 0) AS DECIMAL(18,2)) AS total_purchases,
  CAST(COALESCE(t.received, 0) AS DECIMAL(18,2)) AS received,
  CAST(COALESCE(t.refunded, 0) AS DECIMAL(18,2)) AS refunded,
  CAST(COALESCE(t.allocated, 0) AS DECIMAL(18,2)) AS allocated,
  CAST(COALESCE(t.billed, 0) - COALESCE(t.allocated, 0) AS DECIMAL(18,2)) AS outstanding,
  CAST(COALESCE(t.received, 0) - COALESCE(t.allocated, 0) - COALESCE(t.refunded, 0) AS DECIMAL(18,2)) AS advance,
  CAST(COALESCE(t.billed, 0) - COALESCE(t.received, 0) + COALESCE(t.refunded, 0) AS DECIMAL(18,2)) AS balance,
  CAST(COALESCE(t.fine_billed, 0) AS DECIMAL(16,3)) AS fine_billed,
  CAST(COALESCE(t.fine_received, 0) AS DECIMAL(16,3)) AS fine_received,
  CAST(COALESCE(t.fine_allocated, 0) AS DECIMAL(16,3)) AS fine_allocated,
  CAST(COALESCE(t.fine_billed, 0) - COALESCE(t.fine_allocated, 0) AS DECIMAL(16,3)) AS fine_outstanding,
  CAST(COALESCE(t.fine_received, 0) - COALESCE(t.fine_allocated, 0) AS DECIMAL(16,3)) AS fine_advance,
  CAST(COALESCE(t.fine_billed, 0) - COALESCE(t.fine_received, 0) AS DECIMAL(16,3)) AS fine_balance,
  t.last_purchase AS last_purchase,
  t.updated_at AS updated_at
FROM (
  SELECT
    cu.id AS id,
    cu.updated_at AS updated_at,
    (SELECT SUM(b.grand_total) FROM bills b WHERE b.customer_id = cu.id AND b.status = 'active') AS billed,
    (SELECT SUM(b.grand_total) FROM bills b WHERE b.customer_id = cu.id AND b.status = 'active' AND b.doc_type <> 'opening_balance') AS total_purchases,
    (SELECT SUM(b.fine_weight_due) FROM bills b WHERE b.customer_id = cu.id AND b.status = 'active') AS fine_billed,
    (SELECT MAX(b.bill_date) FROM bills b WHERE b.customer_id = cu.id AND b.status = 'active' AND b.doc_type <> 'opening_balance') AS last_purchase,
    (SELECT SUM(r.amount) FROM receipts r WHERE r.customer_id = cu.id AND r.status = 'active' AND r.kind = 'money') AS received,
    (SELECT SUM(r.amount) FROM receipts r WHERE r.customer_id = cu.id AND r.status = 'active' AND r.kind = 'refund') AS refunded,
    (SELECT SUM(r.fine_grams) FROM receipts r WHERE r.customer_id = cu.id AND r.status = 'active' AND r.kind IN ('fine_silver', 'fine_cash')) AS fine_received,
    (SELECT SUM(al.amount) FROM receipt_allocations al FORCE INDEX (ix_allocations_customer) JOIN receipts rr ON rr.id = al.receipt_id WHERE al.customer_id = cu.id AND al.released_at IS NULL AND rr.status = 'active') AS allocated,
    (SELECT SUM(al.fine_grams) FROM receipt_allocations al FORCE INDEX (ix_allocations_customer) JOIN receipts rr ON rr.id = al.receipt_id WHERE al.customer_id = cu.id AND al.released_at IS NULL AND rr.status = 'active') AS fine_allocated
  FROM customers cu
  WHERE cu.id IN (${marks(n)})
) t`;
}
