-- V1 bill_summary: one row per bill (spec section 11, draft 5.2). A QUERY, not a database view: with Delete and Drop unticked (S7) a view can be created once and never replaced, altered or dropped,
-- and Create view is unticked as well (A3), so the derived reads are SQL text that the API's read layer runs and the nightly check (I10) runs the same text.
-- CORRELATED SUB-SELECTS, never a join to a grouped derived table (RM5-1): on a pooled PREPARED connection that had served a small customer, the join form took 4.2 s at 2,000 bills and failed with 1969
-- after 8 s at 10,000 bills (the walk-in collects every anonymous sale), holding the customer lock all that time; this form answers a page of 1,000 rows in tens of milliseconds. The API wraps it:
--   SELECT * FROM ( <query> ) v WHERE v.customer_id = ? ORDER BY v.bill_date, v.id LIMIT 1000
-- A cancelled bill shows 0 received, 0 pending, 0 fine settled and 0 fine pending (K3 released its allocations).
-- A LIVE allocation is a receipt_allocations row whose released_at is NULL AND whose receipt is 'active'. Money sums are DECIMAL(18,2) and silver sums DECIMAL(16,3).
-- Each sub-select names its index (FORCE INDEX ix_allocations_bill): the plan then does not depend on the table statistics, which are stale right after a bulk load (an import or a restore) and made the
-- nightly check read the whole allocation table once for every bill (more than 60 seconds on 30,000 bills in a test). A test runs every query without ANALYZE TABLE.
-- One SELECT, no parameters, no trailing semicolon. The same rule holds for every statement that totals a customer's history.
SELECT
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
) t
