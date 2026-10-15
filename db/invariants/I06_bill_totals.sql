-- I6 (spec 12), the SQL half. For every bill that has lines (opening bills have none): subtotal is the sum of the lines' item_total, fine_weight_due is the sum of the lines' fine weight,
-- grand_total is round(subtotal - discount + additional_charges, 0) and round_off is 0 or grand_total - (subtotal - discount + additional_charges).
-- NOT checked here (Node re-prices each line with priceLine of pricing.ts over the stored snapshot; SQL cannot run that code): metal_amount, labour_amount, fine_weight_due and item_total of each line.
SELECT 'I6' AS invariant,
       CONCAT('bills:', b.id) AS row_ref,
       CONCAT('bill ', b.bill_no, ': ',
         CONCAT_WS('; ',
           IF(b.subtotal <> l.lines_total, CONCAT('subtotal ', b.subtotal, ' but the lines add up to ', l.lines_total), NULL),
           IF(b.fine_weight_due <> l.lines_fine, CONCAT('fine weight due ', b.fine_weight_due, ' g but the lines add up to ', l.lines_fine, ' g'), NULL),
           IF(b.grand_total <> ROUND(b.subtotal - b.discount + b.additional_charges, 0), CONCAT('grand total ', b.grand_total, ' but round(subtotal - discount + charges) is ', ROUND(b.subtotal - b.discount + b.additional_charges, 0)), NULL),
           IF(b.round_off <> 0 AND b.round_off <> b.grand_total - (b.subtotal - b.discount + b.additional_charges), CONCAT('round-off ', b.round_off, ' is neither 0 nor ', b.grand_total - (b.subtotal - b.discount + b.additional_charges)), NULL))) AS detail
FROM bills b
JOIN (SELECT bi.bill_id AS bill_id, SUM(bi.item_total) AS lines_total, SUM(bi.fine_weight_due) AS lines_fine
      FROM bill_items bi
      GROUP BY bi.bill_id) l ON l.bill_id = b.id
WHERE b.subtotal <> l.lines_total
   OR b.fine_weight_due <> l.lines_fine
   OR b.grand_total <> ROUND(b.subtotal - b.discount + b.additional_charges, 0)
   OR (b.round_off <> 0 AND b.round_off <> b.grand_total - (b.subtotal - b.discount + b.additional_charges))
