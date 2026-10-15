-- I5 (spec 12): bill numbers are unique (the UNIQUE key uq_bills_no guarantees that) and, within each series, the numbers issued by a function
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
