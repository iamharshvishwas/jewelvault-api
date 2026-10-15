-- I13 (spec 12) cash book tie-out: per mode, the sum of V4 net over all dates equals the active money and fine_cash receipts of that mode that are not is_opening, minus the active refunds of that mode.
-- It guards the void-day logic of V4: a void reverses what the original receipt added, so over all dates the voided ones cancel out.
SELECT 'I13' AS invariant,
       CONCAT('mode:', m.mode) AS row_ref,
       CONCAT('cash book for ', m.mode, ' adds up to ', COALESCE(v4.net, 0), ' but the receipts give ', COALESCE(r.net, 0)) AS detail
FROM (SELECT dt.mode AS mode FROM daily_totals dt
      UNION
      SELECT rr.mode FROM receipts rr WHERE rr.mode IS NOT NULL) m
LEFT JOIN (SELECT dt.mode AS mode, SUM(dt.net) AS net FROM daily_totals dt GROUP BY dt.mode) v4 ON v4.mode = m.mode
LEFT JOIN (SELECT rc.mode AS mode,
                  SUM(IF(rc.kind IN ('money', 'fine_cash'), rc.amount, 0)) - SUM(IF(rc.kind = 'refund', rc.amount, 0)) AS net
           FROM receipts rc
           WHERE rc.status = 'active' AND rc.is_opening = 0 AND rc.mode IS NOT NULL
           GROUP BY rc.mode) r ON r.mode = m.mode
WHERE COALESCE(v4.net, 0) <> COALESCE(r.net, 0)
