-- 0011 the four derived views of spec section 11 (V1 bill_summary, V2 customer_balances, V3 customer_ledger, V4 daily_totals). Nothing in them is stored (S3).
-- All are SQL SECURITY INVOKER: the caller's own rights apply and no definer account is involved (an application user can create them).
-- CREATE OR REPLACE makes this file safe to run again (MariaDB DDL is not transactional, so a half-applied migration must be repeatable).
--
-- A LIVE allocation is a receipt_allocations row whose released_at is NULL AND whose receipt is 'active'. A voided receipt's allocation never counts, released or not.
-- Business dates are Indian: a cancel or a void is dated the day it happened in Asia/Kolkata (+05:30, no time-zone tables on the plan, so CONVERT_TZ gets the offset).
-- Money sums are DECIMAL(18,2) and silver sums DECIMAL(16,3): wider than the columns so a sum can never overflow.

-- V1. One row per bill. A cancelled bill shows 0 received, 0 pending, 0 fine settled and 0 fine pending (K3 released its allocations).
CREATE OR REPLACE SQL SECURITY INVOKER VIEW bill_summary AS
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
) i ON i.bill_id = b.id;

-- V2. One row per customer (the walk-in too), keyed by the customer's id.
-- balance comes from totals (billed - received + refunded); outstanding and advance come from allocations. The two routes must agree (I4, I10).
CREATE OR REPLACE SQL SECURITY INVOKER VIEW customer_balances AS
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
) a ON a.customer_id = cu.id;

-- V3. One row per event of a customer with a running balance (debit minus credit) in the order key (entry_date, entry_at, kind_rank, id).
-- The sums are partitioned by customer_id, so a filter on one customer is applied before the sums.
-- kind_rank: Invoice and Opening 1, Cancellation 2, Payment, Opening advance and Fine 3, Refund 4, Void 5.
CREATE OR REPLACE SQL SECURITY INVOKER VIEW customer_ledger AS
SELECT
  e.customer_id AS customer_id,
  e.entry_date AS entry_date,
  e.entry_at AS entry_at,
  e.kind_rank AS kind_rank,
  e.id AS id,
  e.kind AS kind,
  e.description AS description,
  e.debit AS debit,
  e.credit AS credit,
  e.fine_debit AS fine_debit,
  e.fine_credit AS fine_credit,
  CAST(SUM(e.debit - e.credit) OVER (PARTITION BY e.customer_id ORDER BY e.entry_date, e.entry_at, e.kind_rank, e.id ROWS UNBOUNDED PRECEDING) AS DECIMAL(18,2)) AS balance,
  CAST(SUM(e.fine_debit - e.fine_credit) OVER (PARTITION BY e.customer_id ORDER BY e.entry_date, e.entry_at, e.kind_rank, e.id ROWS UNBOUNDED PRECEDING) AS DECIMAL(16,3)) AS fine_balance
FROM (
  SELECT customer_id, bill_date AS entry_date, created_at AS entry_at, 1 AS kind_rank, id,
         IF(doc_type = 'opening_balance', 'Opening', 'Invoice') AS kind,
         CONCAT(IF(doc_type = 'opening_balance', 'Opening balance ', 'Invoice '), bill_no) AS description,
         CAST(grand_total AS DECIMAL(18,2)) AS debit, CAST(0 AS DECIMAL(18,2)) AS credit,
         CAST(fine_weight_due AS DECIMAL(16,3)) AS fine_debit, CAST(0 AS DECIMAL(16,3)) AS fine_credit
  FROM bills
  UNION ALL
  SELECT customer_id, DATE(CONVERT_TZ(cancelled_at, '+00:00', '+05:30')), cancelled_at, 2, id,
         'Cancellation', CONCAT('Cancelled ', bill_no),
         CAST(0 AS DECIMAL(18,2)), CAST(grand_total AS DECIMAL(18,2)),
         CAST(0 AS DECIMAL(16,3)), CAST(fine_weight_due AS DECIMAL(16,3))
  FROM bills
  WHERE status = 'cancelled'
  UNION ALL
  SELECT customer_id, paid_on, created_at, IF(kind = 'refund', 4, 3), id,
         CASE kind WHEN 'money' THEN IF(is_opening = 1, 'Opening advance', 'Payment') WHEN 'refund' THEN 'Refund' ELSE 'Fine' END,
         CASE kind
           WHEN 'money' THEN CONCAT(IF(is_opening = 1, 'Opening advance', 'Payment'), ' (', mode, ')')
           WHEN 'refund' THEN CONCAT('Refund (', mode, ')')
           WHEN 'fine_cash' THEN CONCAT('Silver ', fine_grams, ' g settled in cash at rate ', silver_rate, ' = ', amount)
           ELSE CONCAT('Silver received ', fine_grams, ' g')
         END,
         CAST(IF(kind = 'refund', amount, 0) AS DECIMAL(18,2)),
         CAST(IF(kind = 'money', amount, 0) AS DECIMAL(18,2)),
         CAST(0 AS DECIMAL(16,3)),
         CAST(IF(kind IN ('fine_silver', 'fine_cash'), fine_grams, 0) AS DECIMAL(16,3))
  FROM receipts
  UNION ALL
  SELECT customer_id, DATE(CONVERT_TZ(voided_at, '+00:00', '+05:30')), voided_at, 5, id,
         'Void',
         CONCAT('Void of ', CASE kind WHEN 'money' THEN IF(is_opening = 1, 'opening advance', 'payment') WHEN 'refund' THEN 'refund' WHEN 'fine_cash' THEN 'silver settled in cash' ELSE 'silver received' END),
         CAST(IF(kind = 'money', amount, 0) AS DECIMAL(18,2)),
         CAST(IF(kind = 'refund', amount, 0) AS DECIMAL(18,2)),
         CAST(IF(kind IN ('fine_silver', 'fine_cash'), fine_grams, 0) AS DECIMAL(16,3)),
         CAST(0 AS DECIMAL(16,3))
  FROM receipts
  WHERE status = 'voided'
) e;

-- V4. The cash book: one row per (business_date, mode). Money and silver settled in cash come in on paid_on, a refund goes out on paid_on,
-- a void reverses on the Indian day of the void. Opening advances (is_opening) were never counted, so their void adds nothing either.
CREATE OR REPLACE SQL SECURITY INVOKER VIEW daily_totals AS
SELECT
  t.business_date AS business_date,
  t.mode AS mode,
  CAST(SUM(t.money_in) AS DECIMAL(18,2)) AS money_in,
  CAST(SUM(t.money_out) AS DECIMAL(18,2)) AS money_out,
  CAST(SUM(t.money_in) - SUM(t.money_out) AS DECIMAL(18,2)) AS net
FROM (
  SELECT paid_on AS business_date, mode,
         CAST(IF(kind IN ('money', 'fine_cash'), amount, 0) AS DECIMAL(18,2)) AS money_in,
         CAST(IF(kind = 'refund', amount, 0) AS DECIMAL(18,2)) AS money_out
  FROM receipts
  WHERE is_opening = 0 AND kind IN ('money', 'fine_cash', 'refund')
  UNION ALL
  SELECT DATE(CONVERT_TZ(voided_at, '+00:00', '+05:30')), mode,
         CAST(IF(kind = 'refund', amount, 0) AS DECIMAL(18,2)),
         CAST(IF(kind IN ('money', 'fine_cash'), amount, 0) AS DECIMAL(18,2))
  FROM receipts
  WHERE status = 'voided' AND is_opening = 0 AND kind IN ('money', 'fine_cash', 'refund')
) t
GROUP BY t.business_date, t.mode;
