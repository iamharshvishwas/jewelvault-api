-- I4 (spec 12): for every customer, V2 balance and fine_balance equal an independent recomputation from the base tables,
-- and equal the LAST running balances of V3 (a customer with no events has balance 0).
-- The recomputation reads bills and receipts directly; it does not use any view.
SELECT 'I4' AS invariant,
       CONCAT('customers:', t.id) AS row_ref,
       CONCAT_WS('; ',
         IF(t.v2_balance <> t.calc_balance, CONCAT('rupee balance: view ', t.v2_balance, ' but base tables give ', t.calc_balance), NULL),
         IF(t.v2_fine <> t.calc_fine, CONCAT('silver balance: view ', t.v2_fine, ' g but base tables give ', t.calc_fine, ' g'), NULL),
         IF(t.v2_balance <> t.ledger_balance, CONCAT('rupee balance: V2 ', t.v2_balance, ' but the last ledger row says ', t.ledger_balance), NULL),
         IF(t.v2_fine <> t.ledger_fine, CONCAT('silver balance: V2 ', t.v2_fine, ' g but the last ledger row says ', t.ledger_fine, ' g'), NULL)
       ) AS detail
FROM (
  SELECT cu.id AS id,
         cb.balance AS v2_balance,
         cb.fine_balance AS v2_fine,
         (SELECT COALESCE(SUM(b.grand_total), 0) FROM bills b WHERE b.customer_id = cu.id AND b.status = 'active')
           - (SELECT COALESCE(SUM(r.amount), 0) FROM receipts r WHERE r.customer_id = cu.id AND r.status = 'active' AND r.kind = 'money')
           + (SELECT COALESCE(SUM(r.amount), 0) FROM receipts r WHERE r.customer_id = cu.id AND r.status = 'active' AND r.kind = 'refund') AS calc_balance,
         (SELECT COALESCE(SUM(b.fine_weight_due), 0) FROM bills b WHERE b.customer_id = cu.id AND b.status = 'active')
           - (SELECT COALESCE(SUM(r.fine_grams), 0) FROM receipts r WHERE r.customer_id = cu.id AND r.status = 'active' AND r.kind IN ('fine_silver', 'fine_cash')) AS calc_fine,
         COALESCE(l.balance, 0) AS ledger_balance,
         COALESCE(l.fine_balance, 0) AS ledger_fine
  FROM customers cu
  JOIN {{V2}} cb ON cb.id = cu.id
  LEFT JOIN (
    SELECT x.customer_id AS customer_id, x.balance AS balance, x.fine_balance AS fine_balance
    FROM (SELECT cl.customer_id, cl.balance, cl.fine_balance,
                 ROW_NUMBER() OVER (PARTITION BY cl.customer_id ORDER BY cl.entry_date DESC, cl.entry_at DESC, cl.kind_rank DESC, cl.id DESC) AS rn
          FROM {{V3}} cl) x
    WHERE x.rn = 1
  ) l ON l.customer_id = cu.id
) t
WHERE t.v2_balance <> t.calc_balance OR t.v2_fine <> t.calc_fine OR t.v2_balance <> t.ledger_balance OR t.v2_fine <> t.ledger_fine
