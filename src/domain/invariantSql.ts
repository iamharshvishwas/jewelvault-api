// The nine invariant files of spec section 12 (db/invariants/I01 to I13, the SQL halves of I1 to I7, I10 and I13) and the text of V1 and V2 that they reach through {{V1}} and {{V2}}, as TypeScript
// constants: the same text as the files, character for character, because src/ is compiled alone (tsconfig.build.json, rootDir src) and cannot import scripts/invariants.mjs or scripts/queries.mjs,
// which read those files. V3 and V4 are in src/reads/queries.ts. tests/api/nightly-invariants.test.ts compares every constant here with listInvariantFiles() and loadQueries() and runs both
// runners on the same damaged database, so a change to an invariant file that is not made here fails the test.
//
// This file is generated from the files once and then kept in step by that test; edit the file in db/ first (the database half owns db/), then copy the text here.
import { V3_TEXT, V4_TEXT } from '../reads/queries.js';

export interface InvariantFile {
  /** 'I1' to 'I13': the number of the file's name without its leading zero */
  readonly id: string;
  readonly name: string;
  /** the file's text as it is on disk: a comment header, then one SELECT with no trailing semicolon */
  readonly sql: string;
}

export const INVARIANT_FILES: readonly InvariantFile[] = [
  { id: 'I1', name: 'I01_sold_pieces.sql', sql: `-- I1 (spec 12): every Sold piece belongs to an ACTIVE bill that has a line for it, and every line of an active bill points to a Sold piece with that bill id.
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
` },
  { id: 'I2', name: 'I02_one_active_bill_per_piece.sql', sql: `-- I2 (spec 12): no piece is on the lines of two active bills.
SELECT 'I2' AS invariant,
       CONCAT('skus:', bi.sku_id) AS row_ref,
       CONCAT('piece is on ', COUNT(*), ' lines of active bills: ', GROUP_CONCAT(b.bill_no ORDER BY b.bill_no SEPARATOR ', ')) AS detail
FROM bill_items bi
JOIN bills b ON b.id = bi.bill_id AND b.status = 'active'
GROUP BY bi.sku_id
HAVING COUNT(*) > 1
` },
  { id: 'I3', name: 'I03_allocations.sql', sql: `-- I3 (spec 12). A LIVE allocation has released_at NULL and an active receipt.
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
` },
  { id: 'I4', name: 'I04_balances_agree.sql', sql: `-- I4 (spec 12): for every customer, V2 balance and fine_balance equal an independent recomputation from the base tables,
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
` },
  { id: 'I5', name: 'I05_numbers.sql', sql: `-- I5 (spec 12): bill numbers are unique (the UNIQUE key uq_bills_no guarantees that) and, within each series, the numbers issued by a function
-- (no import_batch_id) are contiguous from the series' seed_value + 1; numbers at or below the seed are ignored (an import; seedCounters() raises the seed).
-- The series of a number: <prefix>-<YYYY>-<digits> belongs to 'bill:<prefix>:<YYYY>', OB-<digits> to 'opening'. The counter's last_value must be the highest issued number.
-- (a) a number issued by a function that does not look like either format
SELECT 'I5' AS invariant,
       CONCAT('bills:', b.id) AS row_ref,
       CONCAT('bill number ', b.bill_no, ' is neither <prefix>-<year>-<digits> nor OB-<digits>') AS detail
FROM bills b
WHERE b.import_batch_id IS NULL
  AND NOT (BINARY b.bill_no REGEXP '^OB-[0-9]+$' OR BINARY b.bill_no REGEXP '^.+-[0-9]{4}-[0-9]+$')
UNION ALL
-- (b) a series with a gap, a wrong first number, a missing counter row, or a counter that is not the highest number
SELECT 'I5',
       CONCAT('sys_counters:', g.series),
       CONCAT_WS('; ',
         IF(g.counter_series IS NULL, 'there is no counter row for this series', NULL),
         IF(g.first_n <> g.seed + 1, CONCAT('the first issued number is ', g.first_n, ', expected ', g.seed + 1), NULL),
         IF(g.last_n - g.seed <> g.cnt, CONCAT('gap or repeat: highest number ', g.last_n, ' but only ', g.cnt, ' numbers above the seed ', g.seed), NULL),
         IF(g.counter_series IS NOT NULL AND g.last_value <> g.last_n, CONCAT('the counter says ', g.last_value, ' but the highest issued number is ', g.last_n), NULL))
FROM (
  SELECT t.series AS series, c.series AS counter_series, COALESCE(c.seed_value, 0) AS seed, c.last_value AS last_value,
         MIN(t.n) AS first_n, MAX(t.n) AS last_n, COUNT(DISTINCT t.n) AS cnt
  FROM (
    SELECT IF(BINARY b.bill_no REGEXP '^OB-[0-9]+$', 'opening',
              CONCAT('bill:',
                     SUBSTRING(b.bill_no, 1, CHAR_LENGTH(b.bill_no) - CHAR_LENGTH(SUBSTRING_INDEX(b.bill_no, '-', -2)) - 1),
                     ':', SUBSTRING_INDEX(SUBSTRING_INDEX(b.bill_no, '-', -2), '-', 1))) AS series,
           CAST(SUBSTRING_INDEX(b.bill_no, '-', -1) AS UNSIGNED) AS n
    FROM bills b
    WHERE b.import_batch_id IS NULL
      AND (BINARY b.bill_no REGEXP '^OB-[0-9]+$' OR BINARY b.bill_no REGEXP '^.+-[0-9]{4}-[0-9]+$')
  ) t
  LEFT JOIN sys_counters c ON c.series = t.series
  WHERE t.n > COALESCE(c.seed_value, 0)
  GROUP BY t.series, c.series, c.seed_value, c.last_value
) g
WHERE g.counter_series IS NULL
   OR g.first_n <> g.seed + 1
   OR g.last_n - g.seed <> g.cnt
   OR g.last_value <> g.last_n
UNION ALL
-- (c) a bill-number counter that moved although no number above its seed was issued
SELECT 'I5',
       CONCAT('sys_counters:', c.series),
       CONCAT('the counter is ', c.last_value, ' but no number above the seed ', c.seed_value, ' was issued')
FROM sys_counters c
WHERE (c.series = 'opening' OR c.series LIKE 'bill:%')
  AND c.last_value <> c.seed_value
  AND NOT EXISTS (
    SELECT 1 FROM bills b
    WHERE b.import_batch_id IS NULL
      AND CAST(SUBSTRING_INDEX(b.bill_no, '-', -1) AS UNSIGNED) > c.seed_value
      AND c.series = IF(BINARY b.bill_no REGEXP '^OB-[0-9]+$', 'opening',
            CONCAT('bill:',
                   SUBSTRING(b.bill_no, 1, CHAR_LENGTH(b.bill_no) - CHAR_LENGTH(SUBSTRING_INDEX(b.bill_no, '-', -2)) - 1),
                   ':', SUBSTRING_INDEX(SUBSTRING_INDEX(b.bill_no, '-', -2), '-', 1)))
  )
` },
  { id: 'I6', name: 'I06_bill_totals.sql', sql: `-- I6 (spec 12), the SQL half. For every bill that has lines (opening bills have none): subtotal is the sum of the lines' item_total, fine_weight_due is the sum of the lines' fine weight,
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
` },
  { id: 'I7', name: 'I07_no_bad_values.sql', sql: `-- I7 (spec 12): no negative amount, weight or quantity in any table (round_off is the one column that may be negative, D11); no receipt has the mode Credit; no photo value starts with data:;
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
      AND ((r.status = 'voided') = (r.void_reason IS NOT NULL)) AND ((r.status = 'voided') = (r.voided_at IS NOT NULL)) AND ((r.status = 'voided') = (r.voided_on IS NOT NULL)), 0)
UNION ALL
SELECT 'I7', CONCAT('bills:', b.id), CONCAT('bill doc_type ', b.doc_type, ', sale_type ', b.sale_type, ', status ', b.status, ' is not an allowed combination')
FROM bills b
WHERE NOT COALESCE(
        b.doc_type IN ('estimate', 'tax_invoice', 'bill_of_supply', 'opening_balance')
        AND b.sale_type IN ('Retail', 'Semi-Wholesale', 'Wholesale')
        AND b.status IN ('active', 'cancelled')
        AND ((b.status = 'cancelled') = (b.cancel_reason IS NOT NULL)) AND ((b.status = 'cancelled') = (b.cancelled_at IS NOT NULL)) AND ((b.status = 'cancelled') = (b.cancelled_on IS NOT NULL)), 0)
UNION ALL
SELECT 'I7', CONCAT('skus:', s.id), CONCAT('piece status ', s.status, ' with sold_bill_id ', COALESCE(CAST(s.sold_bill_id AS CHAR), '(none)'), ' is not an allowed combination')
FROM skus s
WHERE NOT COALESCE(
        s.status IN ('In Stock', 'Reserved', 'On Approval', 'Sold', 'Returned', 'Repair', 'Transferred', 'Missing', 'Damaged', 'Archived')
        AND ((s.status = 'Sold') = (s.sold_bill_id IS NOT NULL)), 0)
` },
  { id: 'I10', name: 'I10_rebalance.sql', sql: `-- I10 (spec 12) the rebalance post-condition (Y6): per customer, the sum of V1 pending over their active bills equals V2 outstanding (and fine_pending equals fine_outstanding);
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
` },
  { id: 'I13', name: 'I13_cash_book.sql', sql: `-- I13 (spec 12) cash book tie-out: per mode, the sum of V4 net over all dates equals the active money and fine_cash receipts of that mode that are not is_opening, minus the active refunds of that mode.
-- It guards the void-day logic of V4: a void reverses what the original receipt added, so over all dates the voided ones cancel out.
SELECT 'I13' AS invariant,
       CONCAT('mode:', m.mode) AS row_ref,
       CONCAT('cash book for ', m.mode, ' adds up to ', COALESCE(v4.net, 0), ' but the receipts give ', COALESCE(r.net, 0)) AS detail
FROM (SELECT dt.mode AS mode FROM {{V4}} dt
      UNION
      SELECT rr.mode FROM receipts rr WHERE rr.mode IS NOT NULL) m
LEFT JOIN (SELECT dt.mode AS mode, SUM(dt.net) AS net FROM {{V4}} dt GROUP BY dt.mode) v4 ON v4.mode = m.mode
LEFT JOIN (SELECT rc.mode AS mode,
                  SUM(IF(rc.kind IN ('money', 'fine_cash'), rc.amount, 0)) - SUM(IF(rc.kind = 'refund', rc.amount, 0)) AS net
           FROM receipts rc
           WHERE rc.status = 'active' AND rc.is_opening = 0 AND rc.mode IS NOT NULL
           GROUP BY rc.mode) r ON r.mode = m.mode
WHERE COALESCE(v4.net, 0) <> COALESCE(r.net, 0)
` },
];

/** V1 bill_summary without its comment header: db/queries/V1_bill_summary.sql. */
export const V1_TEXT = `SELECT
  t.id AS id,
  t.bill_no AS bill_no,
  t.customer_id AS customer_id,
  t.bill_date AS bill_date,
  t.doc_type AS doc_type,
  t.sale_type AS sale_type,
  t.status AS status,
  t.reissue_of AS reissue_of,
  t.grand_total AS grand_total,
  CAST(IF(t.status = 'active', t.m, 0) AS DECIMAL(18,2)) AS received,
  CAST(IF(t.status = 'active', t.grand_total - t.m, 0) AS DECIMAL(18,2)) AS pending,
  t.fine_weight_due AS fine_due,
  CAST(IF(t.status = 'active', t.f, 0) AS DECIMAL(16,3)) AS fine_settled,
  CAST(IF(t.status = 'active', t.fine_weight_due - t.f, 0) AS DECIMAL(16,3)) AS fine_pending,
  CASE
    WHEN t.status <> 'active' THEN 'Cancelled'
    WHEN t.grand_total - t.m = 0 AND t.fine_weight_due - t.f = 0 THEN 'Paid'
    WHEN t.m > 0 OR t.f > 0 THEN 'Partial'
    ELSE 'Pending'
  END AS payment_status,
  t.item_count AS item_count,
  t.created_at AS created_at,
  t.updated_at AS updated_at
FROM (
  SELECT
    b.id, b.bill_no, b.customer_id, b.bill_date, b.doc_type, b.sale_type, b.status, b.reissue_of, b.grand_total, b.fine_weight_due, b.created_at, b.updated_at,
    COALESCE((SELECT SUM(al.amount) FROM receipt_allocations al FORCE INDEX (ix_allocations_bill) JOIN receipts r ON r.id = al.receipt_id
               WHERE al.bill_id = b.id AND al.customer_id = b.customer_id AND al.released_at IS NULL AND r.status = 'active'), 0) AS m,
    COALESCE((SELECT SUM(al.fine_grams) FROM receipt_allocations al FORCE INDEX (ix_allocations_bill) JOIN receipts r ON r.id = al.receipt_id
               WHERE al.bill_id = b.id AND al.customer_id = b.customer_id AND al.released_at IS NULL AND r.status = 'active'), 0) AS f,
    (SELECT COUNT(*) FROM bill_items i WHERE i.bill_id = b.id) AS item_count
  FROM bills b
) t`;

/** V2 customer_balances (everyone at once) without its comment header: db/queries/V2_customer_balances.sql. */
export const V2_TEXT = `SELECT
  cu.id AS id,
  CAST(COALESCE(b.billed, 0) AS DECIMAL(18,2)) AS billed,
  CAST(COALESCE(b.total_purchases, 0) AS DECIMAL(18,2)) AS total_purchases,
  CAST(COALESCE(r.received, 0) AS DECIMAL(18,2)) AS received,
  CAST(COALESCE(r.refunded, 0) AS DECIMAL(18,2)) AS refunded,
  CAST(COALESCE(a.allocated, 0) AS DECIMAL(18,2)) AS allocated,
  CAST(COALESCE(b.billed, 0) - COALESCE(a.allocated, 0) AS DECIMAL(18,2)) AS outstanding,
  CAST(COALESCE(r.received, 0) - COALESCE(a.allocated, 0) - COALESCE(r.refunded, 0) AS DECIMAL(18,2)) AS advance,
  CAST(COALESCE(b.billed, 0) - COALESCE(r.received, 0) + COALESCE(r.refunded, 0) AS DECIMAL(18,2)) AS balance,
  CAST(COALESCE(b.fine_billed, 0) AS DECIMAL(16,3)) AS fine_billed,
  CAST(COALESCE(r.fine_received, 0) AS DECIMAL(16,3)) AS fine_received,
  CAST(COALESCE(a.fine_allocated, 0) AS DECIMAL(16,3)) AS fine_allocated,
  CAST(COALESCE(b.fine_billed, 0) - COALESCE(a.fine_allocated, 0) AS DECIMAL(16,3)) AS fine_outstanding,
  CAST(COALESCE(r.fine_received, 0) - COALESCE(a.fine_allocated, 0) AS DECIMAL(16,3)) AS fine_advance,
  CAST(COALESCE(b.fine_billed, 0) - COALESCE(r.fine_received, 0) AS DECIMAL(16,3)) AS fine_balance,
  b.last_purchase AS last_purchase,
  cu.updated_at AS updated_at
FROM customers cu
LEFT JOIN (
  SELECT customer_id,
         SUM(grand_total) AS billed,
         SUM(IF(doc_type <> 'opening_balance', grand_total, 0)) AS total_purchases,
         SUM(fine_weight_due) AS fine_billed,
         MAX(IF(doc_type <> 'opening_balance', bill_date, NULL)) AS last_purchase
  FROM bills
  WHERE status = 'active'
  GROUP BY customer_id
) b ON b.customer_id = cu.id
LEFT JOIN (
  SELECT customer_id,
         SUM(IF(kind = 'money', amount, 0)) AS received,
         SUM(IF(kind = 'refund', amount, 0)) AS refunded,
         SUM(IF(kind IN ('fine_silver', 'fine_cash'), fine_grams, 0)) AS fine_received
  FROM receipts
  WHERE status = 'active'
  GROUP BY customer_id
) r ON r.customer_id = cu.id
LEFT JOIN (
  SELECT al.customer_id AS customer_id, SUM(al.amount) AS allocated, SUM(al.fine_grams) AS fine_allocated
  FROM receipt_allocations al
  JOIN receipts rr ON rr.id = al.receipt_id
  WHERE al.released_at IS NULL AND rr.status = 'active'
  GROUP BY al.customer_id
) a ON a.customer_id = cu.id`;

/** The four derived reads of section 11 by the name the invariant files use for them: {{V1}} to {{V4}}. */
export const DERIVED_READS: Readonly<Record<'V1' | 'V2' | 'V3' | 'V4', string>> = { V1: V1_TEXT, V2: V2_TEXT, V3: V3_TEXT, V4: V4_TEXT };
