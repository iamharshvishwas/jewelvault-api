// V3 customer_ledger and V4 daily_totals as SQL text: the same text as db/queries/V3_customer_ledger.sql and V4_daily_totals.sql (spec section 11), because src/ is compiled alone (tsconfig.build.json,
// rootDir src) and cannot import scripts/queries.mjs, which reads those files. They are QUERIES, not database views: with Delete and Drop unticked (S7) and Create view unticked (A3) a view could
// be made once and never changed. tests/api/derived-reads.test.ts compares each constant with loadQueries() character for character, so a change to a query file that is not made here fails the test.
// The text is a derived table: the API wraps it (SELECT <columns> FROM ( <text> ) v WHERE ... ORDER BY ... LIMIT ...), as the invariant files and the schema tests do.
//
// This file is generated from the query files once and then kept in step by that test; edit the query file first (the database half owns db/), then copy the text here.

export const V3_TEXT = `SELECT
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
) e`;

export const V4_TEXT = `SELECT
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
  SELECT voided_on, mode,
         CAST(IF(kind = 'refund', amount, 0) AS DECIMAL(18,2)),
         CAST(IF(kind IN ('money', 'fine_cash'), amount, 0) AS DECIMAL(18,2))
  FROM receipts
  WHERE status = 'voided' AND is_opening = 0 AND kind IN ('money', 'fine_cash', 'refund')
) t
GROUP BY t.business_date, t.mode`;
