-- I1 (spec 12): every Sold piece belongs to an ACTIVE bill that has a line for it, and every line of an active bill points to a Sold piece with that bill id.
SELECT 'I1' AS invariant,
       CONCAT('skus:', s.id) AS row_ref,
       CONCAT('piece is Sold on bill ', COALESCE(CAST(s.sold_bill_id AS CHAR), '(none)'),
              IF(b.id IS NULL, ', which does not exist', IF(b.status <> 'active', ', which is cancelled', ', which has no line for it'))) AS detail
FROM skus s
LEFT JOIN bills b ON b.id = s.sold_bill_id
WHERE s.status = 'Sold'
  AND (b.id IS NULL
       OR b.status <> 'active'
       OR NOT EXISTS (SELECT 1 FROM bill_items bi WHERE bi.bill_id = s.sold_bill_id AND bi.sku_id = s.id))
UNION ALL
SELECT 'I1',
       CONCAT('skus:', bi.sku_id),
       CONCAT('line ', bi.line_no, ' of active bill ', b.bill_no, IF(s.id IS NULL, ' points to a piece that does not exist', CONCAT(' points to a piece that is ', s.status, ' with bill ', COALESCE(CAST(s.sold_bill_id AS CHAR), '(none)'))))
FROM bill_items bi
JOIN bills b ON b.id = bi.bill_id AND b.status = 'active'
LEFT JOIN skus s ON s.id = bi.sku_id
WHERE s.id IS NULL OR s.status <> 'Sold' OR NOT (s.sold_bill_id <=> bi.bill_id)
