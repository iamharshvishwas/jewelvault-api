-- V2 customer_balances: one row per customer (the walk-in too), the form that totals EVERYONE at once (the full hydrate, the nightly check).
-- balance comes from totals (billed - received + refunded); outstanding and advance come from allocations. The two routes must agree (I4, I10).
-- A read of ONE customer uses V2_customer_balance_one.sql: the same columns by correlated sub-selects (RM4-14) (spec section 11). A QUERY, not a database view: with Delete and Drop unticked (S7) a view can be created once and never replaced, altered or dropped,
-- and Create view is unticked as well (A3), so the four derived reads are SQL text that the API's read layer runs and the nightly check (I4, I10, I13) runs the same text.
-- One SELECT, no parameters, no trailing semicolon; the API wraps it (SELECT * FROM ( <query> ) v WHERE ... ORDER BY ... LIMIT ...) and the invariant files put it in as {{V2}}.
-- A LIVE allocation is a receipt_allocations row whose released_at is NULL AND whose receipt is 'active'. A voided receipt's allocation never counts, released or not.
-- Money sums are DECIMAL(18,2) and silver sums DECIMAL(16,3): wider than the columns so a sum can never overflow.
SELECT
  cu.id AS id,
  CAST(COALESCE(b.billed, 0) AS DECIMAL(18,2)) AS billed,
  CAST(COALESCE(b.total_purchases, 0) AS DECIMAL(18,2)) AS total_purchases,
  CAST(COALESCE(r.received, 0) AS DECIMAL(18,2)) AS received,
  CAST(COALESCE(r.refunded, 0) AS DECIMAL(18,2)) AS refunded,
  CAST(COALESCE(a.allocated, 0) AS DECIMAL(18,2)) AS allocated,
  CAST(COALESCE(b.billed, 0) - COALESCE(a.allocated, 0) AS DECIMAL(18,2)) AS outstanding,
  CAST(COALESCE(r.received, 0) - COALESCE(a.allocated, 0) - COALESCE(r.refunded, 0) AS DECIMAL(18,2)) AS advance,
  CAST(COALESCE(b.billed, 0) - COALESCE(r.received, 0) + COALESCE(r.refunded, 0) AS DECIMAL(18,2)) AS balance,
  CAST(COALESCE(b.fine_billed, 0) AS DECIMAL(16,3)) AS fine_billed,
  CAST(COALESCE(r.fine_received, 0) AS DECIMAL(16,3)) AS fine_received,
  CAST(COALESCE(a.fine_allocated, 0) AS DECIMAL(16,3)) AS fine_allocated,
  CAST(COALESCE(b.fine_billed, 0) - COALESCE(a.fine_allocated, 0) AS DECIMAL(16,3)) AS fine_outstanding,
  CAST(COALESCE(r.fine_received, 0) - COALESCE(a.fine_allocated, 0) AS DECIMAL(16,3)) AS fine_advance,
  CAST(COALESCE(b.fine_billed, 0) - COALESCE(r.fine_received, 0) AS DECIMAL(16,3)) AS fine_balance,
  b.last_purchase AS last_purchase,
  cu.updated_at AS updated_at
FROM customers cu
LEFT JOIN (
  SELECT customer_id,
         SUM(grand_total) AS billed,
         SUM(IF(doc_type <> 'opening_balance', grand_total, 0)) AS total_purchases,
         SUM(fine_weight_due) AS fine_billed,
         MAX(IF(doc_type <> 'opening_balance', bill_date, NULL)) AS last_purchase
  FROM bills
  WHERE status = 'active'
  GROUP BY customer_id
) b ON b.customer_id = cu.id
LEFT JOIN (
  SELECT customer_id,
         SUM(IF(kind = 'money', amount, 0)) AS received,
         SUM(IF(kind = 'refund', amount, 0)) AS refunded,
         SUM(IF(kind IN ('fine_silver', 'fine_cash'), fine_grams, 0)) AS fine_received
  FROM receipts
  WHERE status = 'active'
  GROUP BY customer_id
) r ON r.customer_id = cu.id
LEFT JOIN (
  SELECT al.customer_id AS customer_id, SUM(al.amount) AS allocated, SUM(al.fine_grams) AS fine_allocated
  FROM receipt_allocations al
  JOIN receipts rr ON rr.id = al.receipt_id
  WHERE al.released_at IS NULL AND rr.status = 'active'
  GROUP BY al.customer_id
) a ON a.customer_id = cu.id
