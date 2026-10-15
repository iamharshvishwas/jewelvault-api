-- I3 (spec 12). A LIVE allocation has released_at NULL and an active receipt.
-- Read literally: ANY allocation that is not released and points to a cancelled bill is wrong, also one of a voided receipt (cancel_bill must release every open allocation of the bill).
-- (a) an active bill is not paid more than its grand total, nor settled in silver more than its fine weight
SELECT 'I3' AS invariant,
       CONCAT('bills:', b.id) AS row_ref,
       CONCAT('bill ', b.bill_no, ': live money allocations ', a.money, ' against grand total ', b.grand_total, ', live silver allocations ', a.fine, ' g against fine weight due ', b.fine_weight_due, ' g') AS detail
FROM bills b
JOIN (SELECT al.bill_id AS bill_id, SUM(al.amount) AS money, SUM(al.fine_grams) AS fine
      FROM receipt_allocations al JOIN receipts r ON r.id = al.receipt_id
      WHERE al.released_at IS NULL AND r.status = 'active'
      GROUP BY al.bill_id) a ON a.bill_id = b.id
WHERE b.status = 'active' AND (a.money > b.grand_total OR a.fine > b.fine_weight_due)
UNION ALL
-- (b) an active receipt does not give out more than it holds; a refund has no allocations; money receipts allocate money only, silver receipts silver only
SELECT 'I3',
       CONCAT('receipts:', r.id),
       CONCAT(r.kind, ' receipt of ', r.amount, ' / ', r.fine_grams, ' g: live allocations ', a.money, ' / ', a.fine, ' g')
FROM receipts r
JOIN (SELECT al.receipt_id AS receipt_id, SUM(al.amount) AS money, SUM(al.fine_grams) AS fine
      FROM receipt_allocations al
      WHERE al.released_at IS NULL
      GROUP BY al.receipt_id) a ON a.receipt_id = r.id
WHERE r.status = 'active'
  AND ((r.kind = 'money' AND (a.money > r.amount OR a.fine <> 0))
    OR (r.kind IN ('fine_silver', 'fine_cash') AND (a.fine > r.fine_grams OR a.money <> 0))
    OR r.kind = 'refund')
UNION ALL
-- (c) nothing that is still open points to a cancelled bill
SELECT 'I3',
       CONCAT('bills:', b.id),
       CONCAT('cancelled bill ', b.bill_no, ' still has ', COUNT(*), ' allocation(s) that were not released (money ', SUM(al.amount), ', silver ', SUM(al.fine_grams), ' g)')
FROM receipt_allocations al
JOIN bills b ON b.id = al.bill_id
WHERE al.released_at IS NULL AND b.status = 'cancelled'
GROUP BY b.id, b.bill_no
UNION ALL
-- (d) an allocation is money or silver, never both and never neither (guard: the same CHECK exists on the table)
SELECT 'I3',
       CONCAT('receipt_allocations:', al.id),
       CONCAT('allocation has amount ', al.amount, ' and silver ', al.fine_grams, ' g')
FROM receipt_allocations al
WHERE NOT ((al.amount > 0 AND al.fine_grams = 0) OR (al.amount = 0 AND al.fine_grams > 0))
