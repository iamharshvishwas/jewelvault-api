-- S2: the active receipts of a customer with something left to apply (money: amount - live allocations; silver: grams - live allocations), oldest first as Y6 asks: paid_on, created_at, id
-- Part of the state read of X0 item 8 (draft 5.2): what the money functions read about ONE customer before the hook and allocate from. Correlated sub-selects over receipt_allocations, never a join to a
-- grouped derived table (RM5-1: that form fails for a customer with thousands of bills on a pooled prepared connection). One parameter (the customer id). One SELECT, no trailing semicolon.
-- A LIVE allocation is a receipt_allocations row whose released_at is NULL AND whose receipt is 'active'.
SELECT
  t.id AS id, t.customer_id AS customer_id, t.kind AS kind, t.paid_on AS paid_on, t.created_at AS created_at, t.amount AS amount, t.fine_grams AS fine_grams,
  CAST(t.m AS DECIMAL(18,2)) AS used, CAST(t.f AS DECIMAL(16,3)) AS fine_used,
  CAST(IF(t.kind = 'money', t.amount - t.m, 0) AS DECIMAL(18,2)) AS remaining,
  CAST(IF(t.kind IN ('fine_silver', 'fine_cash'), t.fine_grams - t.f, 0) AS DECIMAL(16,3)) AS fine_remaining
FROM (
  SELECT r.id, r.customer_id, r.kind, r.paid_on, r.created_at, r.amount, r.fine_grams,
    COALESCE((SELECT SUM(al.amount) FROM receipt_allocations al FORCE INDEX (ix_allocations_receipt) WHERE al.receipt_id = r.id AND al.customer_id = r.customer_id AND al.released_at IS NULL), 0) AS m,
    COALESCE((SELECT SUM(al.fine_grams) FROM receipt_allocations al FORCE INDEX (ix_allocations_receipt) WHERE al.receipt_id = r.id AND al.customer_id = r.customer_id AND al.released_at IS NULL), 0) AS f
  FROM receipts r
  WHERE r.customer_id = ? AND r.status = 'active' AND r.kind IN ('money', 'fine_silver', 'fine_cash')
) t
WHERE (t.kind = 'money' AND t.amount - t.m > 0) OR (t.kind IN ('fine_silver', 'fine_cash') AND t.fine_grams - t.f > 0)
ORDER BY t.paid_on, t.created_at, t.id
