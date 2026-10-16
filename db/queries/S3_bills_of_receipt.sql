-- S3: the bills a receipt has live allocations to, with their pending figures (X4 reads them before the hook: a void re-opens what the receipt had paid, RM5-2)
-- Part of the state read of X0 item 8 (draft 5.2): what the money functions read about ONE customer before the hook and allocate from. Correlated sub-selects over receipt_allocations, never a join to a
-- grouped derived table (RM5-1: that form fails for a customer with thousands of bills on a pooled prepared connection). One parameter (the receipt id). One SELECT, no trailing semicolon.
-- A LIVE allocation is a receipt_allocations row whose released_at is NULL AND whose receipt is 'active'.
SELECT
  t.id AS id, t.bill_no AS bill_no, t.customer_id AS customer_id, t.bill_date AS bill_date, t.created_at AS created_at, t.grand_total AS grand_total, t.fine_weight_due AS fine_weight_due,
  CAST(t.m AS DECIMAL(18,2)) AS received, CAST(t.grand_total - t.m AS DECIMAL(18,2)) AS pending,
  CAST(t.f AS DECIMAL(16,3)) AS fine_settled, CAST(t.fine_weight_due - t.f AS DECIMAL(16,3)) AS fine_pending
FROM (
  SELECT b.id, b.bill_no, b.customer_id, b.bill_date, b.created_at, b.grand_total, b.fine_weight_due,
    COALESCE((SELECT SUM(al.amount) FROM receipt_allocations al FORCE INDEX (ix_allocations_bill) JOIN receipts r ON r.id = al.receipt_id
               WHERE al.bill_id = b.id AND al.customer_id = b.customer_id AND al.released_at IS NULL AND r.status = 'active'), 0) AS m,
    COALESCE((SELECT SUM(al.fine_grams) FROM receipt_allocations al FORCE INDEX (ix_allocations_bill) JOIN receipts r ON r.id = al.receipt_id
               WHERE al.bill_id = b.id AND al.customer_id = b.customer_id AND al.released_at IS NULL AND r.status = 'active'), 0) AS f
  FROM bills b
  WHERE b.id IN (SELECT al.bill_id FROM receipt_allocations al FORCE INDEX (ix_allocations_receipt) WHERE al.receipt_id = ? AND al.released_at IS NULL)
) t
ORDER BY t.bill_date, t.created_at, t.id
