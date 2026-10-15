-- I7 (spec 12): no negative amount, weight or quantity in any table (round_off is the one column that may be negative, D11); no receipt has the mode Credit; no photo value starts with data:;
-- and every kind, mode and status combination is one the checks of D13 allow. These are guards in case a constraint is lost in a later migration.
-- The list of columns in (a) is kept complete by a test (s10): every DECIMAL column of a business table, except bills.round_off, must appear here as table.column.
-- (a) negative numbers
SELECT 'I7' AS invariant,
       CONCAT('bills:', bills.id) AS row_ref,
       CONCAT('negative value in ', CONCAT_WS(', ',
         IF(bills.subtotal < 0, 'subtotal', NULL),
         IF(bills.discount < 0, 'discount', NULL),
         IF(bills.additional_charges < 0, 'additional_charges', NULL),
         IF(bills.gst_percent < 0, 'gst_percent', NULL),
         IF(bills.gst_amount < 0, 'gst_amount', NULL),
         IF(bills.grand_total < 0, 'grand_total', NULL),
         IF(bills.fine_weight_due < 0, 'fine_weight_due', NULL))) AS detail
FROM bills
WHERE bills.subtotal < 0
    OR bills.discount < 0
    OR bills.additional_charges < 0
    OR bills.gst_percent < 0
    OR bills.gst_amount < 0
    OR bills.grand_total < 0
    OR bills.fine_weight_due < 0
UNION ALL
SELECT 'I7' AS invariant,
       CONCAT('bill_items:', bill_items.id) AS row_ref,
       CONCAT('negative value in ', CONCAT_WS(', ',
         IF(bill_items.gross_weight < 0, 'gross_weight', NULL),
         IF(bill_items.customer_net_weight < 0, 'customer_net_weight', NULL),
         IF(bill_items.quantity < 0, 'quantity', NULL),
         IF(bill_items.metal_rate < 0, 'metal_rate', NULL),
         IF(bill_items.labour_rate < 0, 'labour_rate', NULL),
         IF(bill_items.labour_amount < 0, 'labour_amount', NULL),
         IF(bill_items.piroi < 0, 'piroi', NULL),
         IF(bill_items.other_charges < 0, 'other_charges', NULL),
         IF(bill_items.metal_amount < 0, 'metal_amount', NULL),
         IF(bill_items.fine_weight_due < 0, 'fine_weight_due', NULL),
         IF(bill_items.item_total < 0, 'item_total', NULL),
         IF(bill_items.tax_rate < 0, 'tax_rate', NULL),
         IF(bill_items.tax_amount < 0, 'tax_amount', NULL),
         IF(bill_items.list_metal_rate < 0, 'list_metal_rate', NULL),
         IF(bill_items.list_labour_rate < 0, 'list_labour_rate', NULL))) AS detail
FROM bill_items
WHERE bill_items.gross_weight < 0
    OR bill_items.customer_net_weight < 0
    OR bill_items.quantity < 0
    OR bill_items.metal_rate < 0
    OR bill_items.labour_rate < 0
    OR bill_items.labour_amount < 0
    OR bill_items.piroi < 0
    OR bill_items.other_charges < 0
    OR bill_items.metal_amount < 0
    OR bill_items.fine_weight_due < 0
    OR bill_items.item_total < 0
    OR bill_items.tax_rate < 0
    OR bill_items.tax_amount < 0
    OR bill_items.list_metal_rate < 0
    OR bill_items.list_labour_rate < 0
UNION ALL
SELECT 'I7' AS invariant,
       CONCAT('receipts:', receipts.id) AS row_ref,
       CONCAT('negative value in ', CONCAT_WS(', ',
         IF(receipts.amount < 0, 'amount', NULL),
         IF(receipts.fine_grams < 0, 'fine_grams', NULL),
         IF(receipts.silver_rate < 0, 'silver_rate', NULL))) AS detail
FROM receipts
WHERE receipts.amount < 0
    OR receipts.fine_grams < 0
    OR receipts.silver_rate < 0
UNION ALL
SELECT 'I7' AS invariant,
       CONCAT('receipt_allocations:', receipt_allocations.id) AS row_ref,
       CONCAT('negative value in ', CONCAT_WS(', ',
         IF(receipt_allocations.amount < 0, 'amount', NULL),
         IF(receipt_allocations.fine_grams < 0, 'fine_grams', NULL))) AS detail
FROM receipt_allocations
WHERE receipt_allocations.amount < 0
    OR receipt_allocations.fine_grams < 0
UNION ALL
SELECT 'I7' AS invariant,
       CONCAT('skus:', skus.id) AS row_ref,
       CONCAT('negative value in ', CONCAT_WS(', ',
         IF(skus.gross_weight < 0, 'gross_weight', NULL),
         IF(skus.customer_net_weight < 0, 'customer_net_weight', NULL),
         IF(skus.stones < 0, 'stones', NULL),
         IF(skus.stone_weight < 0, 'stone_weight', NULL),
         IF(skus.kundan < 0, 'kundan', NULL),
         IF(skus.kundan_weight < 0, 'kundan_weight', NULL),
         IF(skus.piroi < 0, 'piroi', NULL),
         IF(skus.labour_retail < 0, 'labour_retail', NULL),
         IF(skus.labour_semi < 0, 'labour_semi', NULL),
         IF(skus.labour_wholesale < 0, 'labour_wholesale', NULL))) AS detail
FROM skus
WHERE skus.gross_weight < 0
    OR skus.customer_net_weight < 0
    OR skus.stones < 0
    OR skus.stone_weight < 0
    OR skus.kundan < 0
    OR skus.kundan_weight < 0
    OR skus.piroi < 0
    OR skus.labour_retail < 0
    OR skus.labour_semi < 0
    OR skus.labour_wholesale < 0
UNION ALL
SELECT 'I7' AS invariant,
       CONCAT('sku_private:', sku_private.sku_id) AS row_ref,
       CONCAT('negative value in ', CONCAT_WS(', ',
         IF(sku_private.original_net_weight < 0, 'original_net_weight', NULL))) AS detail
FROM sku_private
WHERE sku_private.original_net_weight < 0
UNION ALL
SELECT 'I7' AS invariant,
       CONCAT('daily_rates:', daily_rates.id) AS row_ref,
       CONCAT('negative value in ', CONCAT_WS(', ',
         IF(daily_rates.rate_per_gram < 0, 'rate_per_gram', NULL))) AS detail
FROM daily_rates
WHERE daily_rates.rate_per_gram < 0
UNION ALL
SELECT 'I7' AS invariant,
       CONCAT('design_photos:', CONCAT(design_photos.id, '/', design_photos.kind)) AS row_ref,
       CONCAT('negative value in ', CONCAT_WS(', ',
         IF(design_photos.byte_size < 0, 'byte_size', NULL))) AS detail
FROM design_photos
WHERE design_photos.byte_size < 0
UNION ALL
SELECT 'I7' AS invariant,
       CONCAT('sys_counters:', sys_counters.series) AS row_ref,
       CONCAT('negative value in ', CONCAT_WS(', ',
         IF(sys_counters.last_value < 0, 'last_value', NULL),
         IF(sys_counters.seed_value < 0, 'seed_value', NULL))) AS detail
FROM sys_counters
WHERE sys_counters.last_value < 0
    OR sys_counters.seed_value < 0
UNION ALL
SELECT 'I7' AS invariant,
       CONCAT('backup_runs:', backup_runs.id) AS row_ref,
       CONCAT('negative value in ', CONCAT_WS(', ',
         IF(backup_runs.bytes < 0, 'bytes', NULL))) AS detail
FROM backup_runs
WHERE backup_runs.bytes < 0
UNION ALL
-- (b) there is no Credit mode: an unpaid bill is the absence of a receipt (Y2)
SELECT 'I7', CONCAT('receipts:', r.id), 'receipt has the mode Credit'
FROM receipts r
WHERE r.mode = 'Credit'
UNION ALL
-- (c) photos are rows in design_photos; an image written into a design row is wrong (P4)
SELECT 'I7', CONCAT('designs:', d.id), 'a photo value in photo_ids starts with data:'
FROM designs d
WHERE JSON_SEARCH(d.photo_ids, 'one', 'data:%') IS NOT NULL
UNION ALL
-- (d) kind, mode and status combinations (the CHECKs of D13, repeated)
SELECT 'I7', CONCAT('receipts:', r.id), CONCAT('receipt kind ', r.kind, ', mode ', COALESCE(r.mode, '(none)'), ', status ', r.status, ' is not an allowed combination')
FROM receipts r
WHERE NOT COALESCE(
        ((r.kind = 'money' AND r.mode IS NOT NULL AND r.mode IN ('Cash', 'UPI', 'Card', 'Bank Transfer', 'Other') AND r.amount > 0 AND r.fine_grams = 0 AND r.silver_rate IS NULL)
      OR (r.kind = 'refund' AND r.mode IS NOT NULL AND r.mode IN ('Cash', 'UPI', 'Card', 'Bank Transfer', 'Other') AND r.amount > 0 AND r.fine_grams = 0 AND r.silver_rate IS NULL AND r.is_opening = 0)
      OR (r.kind = 'fine_cash' AND r.mode = 'Cash' AND r.amount > 0 AND r.fine_grams > 0 AND r.silver_rate IS NOT NULL AND r.silver_rate > 0 AND r.is_opening = 0)
      OR (r.kind = 'fine_silver' AND r.mode IS NULL AND r.amount = 0 AND r.fine_grams > 0 AND r.silver_rate IS NULL))
      AND r.status IN ('active', 'voided')
      AND (r.is_opening = 0 OR (r.kind = 'money' AND r.mode = 'Other') OR r.kind = 'fine_silver')
      AND ((r.status = 'voided') = (r.void_reason IS NOT NULL)) AND ((r.status = 'voided') = (r.voided_at IS NOT NULL)), 0)
UNION ALL
SELECT 'I7', CONCAT('bills:', b.id), CONCAT('bill doc_type ', b.doc_type, ', sale_type ', b.sale_type, ', status ', b.status, ' is not an allowed combination')
FROM bills b
WHERE NOT COALESCE(
        b.doc_type IN ('estimate', 'tax_invoice', 'bill_of_supply', 'opening_balance')
        AND b.sale_type IN ('Retail', 'Semi-Wholesale', 'Wholesale')
        AND b.status IN ('active', 'cancelled')
        AND ((b.status = 'cancelled') = (b.cancel_reason IS NOT NULL)) AND ((b.status = 'cancelled') = (b.cancelled_at IS NOT NULL)), 0)
UNION ALL
SELECT 'I7', CONCAT('skus:', s.id), CONCAT('piece status ', s.status, ' with sold_bill_id ', COALESCE(CAST(s.sold_bill_id AS CHAR), '(none)'), ' is not an allowed combination')
FROM skus s
WHERE NOT COALESCE(
        s.status IN ('In Stock', 'Reserved', 'On Approval', 'Sold', 'Returned', 'Repair', 'Transferred', 'Missing', 'Damaged', 'Archived')
        AND ((s.status = 'Sold') = (s.sold_bill_id IS NOT NULL)), 0)
