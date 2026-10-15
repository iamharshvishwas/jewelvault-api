-- V4 daily_totals: the cash book, one row per (business_date, mode). Money and silver settled in cash come in on paid_on, a refund goes out on paid_on,
-- a void reverses on its voided_on (D13). Opening advances (is_opening) were never counted, so their void adds nothing either (spec section 11). A QUERY, not a database view: with Delete and Drop unticked (S7) a view can be created once and never replaced, altered or dropped,
-- and Create view is unticked as well (A3), so the four derived reads are SQL text that the API's read layer runs and the nightly check (I4, I10, I13) runs the same text.
-- One SELECT, no parameters, no trailing semicolon; the API wraps it (SELECT * FROM ( <query> ) v WHERE ... ORDER BY ... LIMIT ...) and the invariant files put it in as {{V4}}.
-- A LIVE allocation is a receipt_allocations row whose released_at is NULL AND whose receipt is 'active'. A voided receipt's allocation never counts, released or not.
-- Money sums are DECIMAL(18,2) and silver sums DECIMAL(16,3): wider than the columns so a sum can never overflow.
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
  SELECT voided_on, mode,
         CAST(IF(kind = 'refund', amount, 0) AS DECIMAL(18,2)),
         CAST(IF(kind IN ('money', 'fine_cash'), amount, 0) AS DECIMAL(18,2))
  FROM receipts
  WHERE status = 'voided' AND is_opening = 0 AND kind IN ('money', 'fine_cash', 'refund')
) t
GROUP BY t.business_date, t.mode
