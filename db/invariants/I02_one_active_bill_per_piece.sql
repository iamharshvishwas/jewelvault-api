-- I2 (spec 12): no piece is on the lines of two active bills.
SELECT 'I2' AS invariant,
       CONCAT('skus:', bi.sku_id) AS row_ref,
       CONCAT('piece is on ', COUNT(*), ' lines of active bills: ', GROUP_CONCAT(b.bill_no ORDER BY b.bill_no SEPARATOR ', ')) AS detail
FROM bill_items bi
JOIN bills b ON b.id = bi.bill_id AND b.status = 'active'
GROUP BY bi.sku_id
HAVING COUNT(*) > 1
