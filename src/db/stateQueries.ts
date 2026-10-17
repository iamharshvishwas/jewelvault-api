// S1 to S4 and V2 for ONE customer (spec section 11, X0 item 8) as SQL text: the same text as db/queries/S1_open_bills_of_customer.sql, S2_open_receipts_of_customer.sql, S3_bills_of_receipt.sql,
// S4_receipts_of_bill.sql and V2_customer_balance_one.sql (without their comment headers), because src/ is compiled alone (tsconfig.build.json, rootDir src) and cannot import scripts/queries.mjs,
// which reads those files. They are QUERIES, not database views (Create view is unticked, A3, and nothing can be replaced once made, S7). All of them are correlated sub-selects over
// receipt_allocations with a named index, never a join to a grouped derived table (RM5-1: that form took 4.2 s at 2,000 bills and failed with 1969 at 10,000 on a pooled prepared connection,
// holding the customer lock all that time). tests/api/x0-state.test.ts compares each constant with loadQueries() character for character, so a change to a query file that is not made here fails.
//
// This file is generated from the query files once and then kept in step by that test; edit the query file first (the database half owns db/), then copy the text here.

export const S1_TEXT = `SELECT
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
  WHERE b.customer_id = ? AND b.status = 'active'
) t
WHERE t.grand_total - t.m > 0 OR t.fine_weight_due - t.f > 0
ORDER BY t.bill_date, t.created_at, t.id`;

export const S2_TEXT = `SELECT
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
ORDER BY t.paid_on, t.created_at, t.id`;

export const S3_TEXT = `SELECT
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
ORDER BY t.bill_date, t.created_at, t.id`;

export const S4_TEXT = `SELECT
  t.id AS id, t.customer_id AS customer_id, t.kind AS kind, t.paid_on AS paid_on, t.created_at AS created_at, t.amount AS amount, t.fine_grams AS fine_grams,
  CAST(t.m AS DECIMAL(18,2)) AS used, CAST(t.f AS DECIMAL(16,3)) AS fine_used,
  CAST(IF(t.kind = 'money', t.amount - t.m, 0) AS DECIMAL(18,2)) AS remaining,
  CAST(IF(t.kind IN ('fine_silver', 'fine_cash'), t.fine_grams - t.f, 0) AS DECIMAL(16,3)) AS fine_remaining
FROM (
  SELECT r.id, r.customer_id, r.kind, r.paid_on, r.created_at, r.amount, r.fine_grams,
    COALESCE((SELECT SUM(al.amount) FROM receipt_allocations al FORCE INDEX (ix_allocations_receipt) WHERE al.receipt_id = r.id AND al.customer_id = r.customer_id AND al.released_at IS NULL), 0) AS m,
    COALESCE((SELECT SUM(al.fine_grams) FROM receipt_allocations al FORCE INDEX (ix_allocations_receipt) WHERE al.receipt_id = r.id AND al.customer_id = r.customer_id AND al.released_at IS NULL), 0) AS f
  FROM receipts r
  WHERE r.status = 'active' AND r.id IN (SELECT al.receipt_id FROM receipt_allocations al FORCE INDEX (ix_allocations_bill) WHERE al.bill_id = ? AND al.released_at IS NULL)
) t
ORDER BY t.paid_on, t.created_at, t.id`;

export const V2_ONE_TEXT = `SELECT
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
  WHERE cu.id = ?
) t`;
