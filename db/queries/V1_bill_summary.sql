-- V1 bill_summary: one row per bill (A cancelled bill shows 0 received, 0 pending, 0 fine settled and 0 fine pending: K3 released its allocations) (spec section 11). A QUERY, not a database view: with Delete and Drop unticked (S7) a view can be created once and never replaced, altered or dropped,
-- and Create view is unticked as well (A3), so the four derived reads are SQL text that the API's read layer runs and the nightly check (I4, I10, I13) runs the same text.
-- One SELECT, no parameters, no trailing semicolon; the API wraps it (SELECT * FROM ( <query> ) v WHERE ... ORDER BY ... LIMIT ...) and the invariant files put it in as {{V1}}.
-- A LIVE allocation is a receipt_allocations row whose released_at is NULL AND whose receipt is 'active'. A voided receipt's allocation never counts, released or not.
-- Money sums are DECIMAL(18,2) and silver sums DECIMAL(16,3): wider than the columns so a sum can never overflow.
SELECT
  b.id AS id,
  b.bill_no AS bill_no,
  b.customer_id AS customer_id,
  b.bill_date AS bill_date,
  b.doc_type AS doc_type,
  b.sale_type AS sale_type,
  b.status AS status,
  b.reissue_of AS reissue_of,
  b.grand_total AS grand_total,
  CAST(IF(b.status = 'active', COALESCE(a.received, 0), 0) AS DECIMAL(18,2)) AS received,
  CAST(IF(b.status = 'active', b.grand_total - COALESCE(a.received, 0), 0) AS DECIMAL(18,2)) AS pending,
  b.fine_weight_due AS fine_due,
  CAST(IF(b.status = 'active', COALESCE(a.fine_settled, 0), 0) AS DECIMAL(16,3)) AS fine_settled,
  CAST(IF(b.status = 'active', b.fine_weight_due - COALESCE(a.fine_settled, 0), 0) AS DECIMAL(16,3)) AS fine_pending,
  CASE
    WHEN b.status <> 'active' THEN 'Cancelled'
    WHEN b.grand_total - COALESCE(a.received, 0) = 0 AND b.fine_weight_due - COALESCE(a.fine_settled, 0) = 0 THEN 'Paid'
    WHEN COALESCE(a.received, 0) > 0 OR COALESCE(a.fine_settled, 0) > 0 THEN 'Partial'
    ELSE 'Pending'
  END AS payment_status,
  COALESCE(i.item_count, 0) AS item_count,
  b.created_at AS created_at,
  b.updated_at AS updated_at
FROM bills b
LEFT JOIN (
  SELECT al.bill_id AS bill_id, SUM(al.amount) AS received, SUM(al.fine_grams) AS fine_settled
  FROM receipt_allocations al
  JOIN receipts r ON r.id = al.receipt_id
  WHERE al.released_at IS NULL AND r.status = 'active'
  GROUP BY al.bill_id
) a ON a.bill_id = b.id
LEFT JOIN (
  SELECT bill_id, COUNT(*) AS item_count FROM bill_items GROUP BY bill_id
) i ON i.bill_id = b.id
