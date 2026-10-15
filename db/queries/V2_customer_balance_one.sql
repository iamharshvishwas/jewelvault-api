-- V2 for ONE customer (the customer card, the state read of X0 item 8), spec RM4-14: correlated sub-selects over bills, receipts and receipt_allocations filtered by that
-- customer's id and backed by receipt_allocations (customer_id) (D19). The derived-table form of V2_customer_balances.sql reads three whole tables for one customer
-- (22 to 24 ms at 5,000 bills against 0.9 ms by sub-selects, in the reviewer's run). Same columns, same order, same figures: a test compares them for every customer.
-- One parameter: the customer id (?). One SELECT, no trailing semicolon.
SELECT
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
    (SELECT SUM(al.amount) FROM receipt_allocations al JOIN receipts rr ON rr.id = al.receipt_id WHERE al.customer_id = cu.id AND al.released_at IS NULL AND rr.status = 'active') AS allocated,
    (SELECT SUM(al.fine_grams) FROM receipt_allocations al JOIN receipts rr ON rr.id = al.receipt_id WHERE al.customer_id = cu.id AND al.released_at IS NULL AND rr.status = 'active') AS fine_allocated
  FROM customers cu
  WHERE cu.id = ?
) t
