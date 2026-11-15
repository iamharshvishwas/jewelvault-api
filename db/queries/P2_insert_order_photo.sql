-- FB-E1, P2 (RF5-9, O56): store one photo object (full or thumb) of an ORDER, ONLY IF the order may still take it and the unattached caps hold: the count and the insert are ONE statement, as for a design
-- (P2_insert_photo.sql). The row is a design_photos row with order_id set; design_id holds the same order id (the column is NOT NULL, and it is what the three-photo count reads through its index).
-- Insert-only: a (id, kind) pair that exists is a duplicate-key error (1062) and nothing is overwritten. The race of two uploads at the very same moment is the design's: a fourth photo may be stored
-- and is never attached (X13 and the order PATCH accept at most 3).
-- Positional parameters, in order:
--   id, kind, order_id (as design_id), order_id, mime, byte_size, sha256 (hex), bytes, created_by,   the row
--   order_id, id, per_order (3),                                                                       fewer than 3 DISTINCT live ids already stored for this order (rows with order_id set: a design's photo is not the order's)
--   order_id,                                                                                          a real order: the unattached caps do not apply
--   id, unattached_photos (60), byte_size, unattached_bytes (100 MiB)                                  else: the unattached caps of P2, shared with the designs' photos
-- Zero rows affected means refused; the caller reads P2_unattached.sql and the order's count to say why. One statement, no trailing semicolon.
INSERT INTO design_photos (id, kind, design_id, order_id, mime, byte_size, sha256, bytes, created_by)
SELECT ?, ?, ?, ?, ?, ?, UNHEX(?), ?, ?
FROM DUAL
WHERE (SELECT COUNT(DISTINCT p.id) FROM design_photos p WHERE p.design_id = ? AND p.order_id IS NOT NULL AND p.removed_at IS NULL AND p.id <> ?) < ?
  AND (
    EXISTS (SELECT 1 FROM orders o WHERE o.id = ?)
    OR (
      (SELECT COUNT(DISTINCT p.id) FROM design_photos p LEFT JOIN designs d ON d.id = p.design_id AND p.order_id IS NULL LEFT JOIN orders o ON o.id = p.order_id WHERE p.removed_at IS NULL AND d.id IS NULL AND o.id IS NULL AND p.id <> ?) < ?
      AND (SELECT COALESCE(SUM(p.byte_size), 0) FROM design_photos p LEFT JOIN designs d ON d.id = p.design_id AND p.order_id IS NULL LEFT JOIN orders o ON o.id = p.order_id WHERE p.removed_at IS NULL AND d.id IS NULL AND o.id IS NULL) + ? <= ?
    )
  )
