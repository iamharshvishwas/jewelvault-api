-- V3 customer_ledger: one row per event of a customer with a running balance (debit minus credit) in the order key (entry_date, entry_at, kind_rank, id).
-- The sums are partitioned by customer_id, so a filter on one customer is applied before the sums. A cancel is dated cancelled_on and a void voided_on (DATE columns from the API's Asia/Kolkata clock, D11, D13): no conversion of a UTC stamp here.
-- kind_rank: Invoice and Opening 1, Cancellation 2, Payment, Opening advance and Fine 3, Refund 4, Void 5 (spec section 11). A QUERY, not a database view: with Delete and Drop unticked (S7) a view can be created once and never replaced, altered or dropped,
-- and Create view is unticked as well (A3), so the four derived reads are SQL text that the API's read layer runs and the nightly check (I4, I10, I13) runs the same text.
-- One SELECT, no parameters, no trailing semicolon; the API wraps it (SELECT * FROM ( <query> ) v WHERE ... ORDER BY ... LIMIT ...) and the invariant files put it in as {{V3}}.
-- A LIVE allocation is a receipt_allocations row whose released_at is NULL AND whose receipt is 'active'. A voided receipt's allocation never counts, released or not.
-- Money sums are DECIMAL(18,2) and silver sums DECIMAL(16,3): wider than the columns so a sum can never overflow.
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
  SELECT customer_id, cancelled_on, cancelled_at, 2, id,
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
  SELECT customer_id, voided_on, voided_at, 5, id,
         'Void',
         CONCAT('Void of ', CASE kind WHEN 'money' THEN IF(is_opening = 1, 'opening advance', 'payment') WHEN 'refund' THEN 'refund' WHEN 'fine_cash' THEN 'silver settled in cash' ELSE 'silver received' END),
         CAST(IF(kind = 'money', amount, 0) AS DECIMAL(18,2)),
         CAST(IF(kind = 'refund', amount, 0) AS DECIMAL(18,2)),
         CAST(IF(kind IN ('fine_silver', 'fine_cash'), fine_grams, 0) AS DECIMAL(16,3)),
         CAST(0 AS DECIMAL(16,3))
  FROM receipts
  WHERE status = 'voided'
) e
