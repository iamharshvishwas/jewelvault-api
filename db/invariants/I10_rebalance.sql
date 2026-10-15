-- I10 (spec 12) the rebalance post-condition (Y6): per customer, the sum of V1 pending over their active bills equals V2 outstanding (and fine_pending equals fine_outstanding);
-- outstanding, advance, fine_outstanding and fine_advance are not negative; an advance above zero means nothing is outstanding (same for silver);
-- and the walk-in customer holds no advance (K5).
SELECT 'I10' AS invariant,
       CONCAT('customers:', cu.id) AS row_ref,
       CONCAT_WS('; ',
         IF(COALESCE(v1.pending, 0) <> cb.outstanding, CONCAT('the bills say ', COALESCE(v1.pending, 0), ' is pending but outstanding is ', cb.outstanding), NULL),
         IF(COALESCE(v1.fine_pending, 0) <> cb.fine_outstanding, CONCAT('the bills say ', COALESCE(v1.fine_pending, 0), ' g is pending but fine_outstanding is ', cb.fine_outstanding, ' g'), NULL),
         IF(cb.outstanding < 0 OR cb.advance < 0, CONCAT('negative: outstanding ', cb.outstanding, ', advance ', cb.advance), NULL),
         IF(cb.fine_outstanding < 0 OR cb.fine_advance < 0, CONCAT('negative silver: outstanding ', cb.fine_outstanding, ' g, advance ', cb.fine_advance, ' g'), NULL),
         IF(cb.advance > 0 AND cb.outstanding <> 0, CONCAT('advance ', cb.advance, ' is held while ', cb.outstanding, ' is outstanding'), NULL),
         IF(cb.fine_advance > 0 AND cb.fine_outstanding <> 0, CONCAT('silver advance ', cb.fine_advance, ' g is held while ', cb.fine_outstanding, ' g is outstanding'), NULL),
         IF(cu.is_walkin = 1 AND (cb.advance <> 0 OR cb.fine_advance <> 0), CONCAT('the walk-in customer holds an advance of ', cb.advance, ' / ', cb.fine_advance, ' g'), NULL)) AS detail
FROM customers cu
JOIN {{V2}} cb ON cb.id = cu.id
LEFT JOIN (SELECT bs.customer_id AS customer_id, SUM(bs.pending) AS pending, SUM(bs.fine_pending) AS fine_pending
           FROM {{V1}} bs
           WHERE bs.status = 'active'
           GROUP BY bs.customer_id) v1 ON v1.customer_id = cu.id
WHERE COALESCE(v1.pending, 0) <> cb.outstanding
   OR COALESCE(v1.fine_pending, 0) <> cb.fine_outstanding
   OR cb.outstanding < 0 OR cb.advance < 0 OR cb.fine_outstanding < 0 OR cb.fine_advance < 0
   OR (cb.advance > 0 AND cb.outstanding <> 0)
   OR (cb.fine_advance > 0 AND cb.fine_outstanding <> 0)
   OR (cu.is_walkin = 1 AND (cb.advance <> 0 OR cb.fine_advance <> 0))
