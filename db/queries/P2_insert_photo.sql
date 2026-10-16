-- P2 (draft 5.2, RF5-9, O56): store one photo object (full or thumb) ONLY IF the design may still take it and the unattached caps hold: the count and the insert are ONE statement.
-- Insert-only: a (id, kind) pair that exists is a duplicate-key error (1062) and nothing is overwritten (a replacement is a new id). Two uploads at the very same moment may both pass: a fourth photo
-- is then stored but never attached (X8 and the PATCH accept at most 3), which wastes space and nothing more.
-- Positional parameters, in order:
--   id, kind, design_id, mime, byte_size, sha256 (hex), bytes, created_by,                       the row
--   design_id, id, per_design (3),                                                                  fewer than 3 DISTINCT live ids already stored for this design (the thumbnail of a stored id is not a new photo)
--   design_id,                                                                                      a real design: the unattached caps do not apply
--   id, unattached_photos (60), byte_size, unattached_bytes (100 MiB)                               else: fewer than 60 distinct unattached photo ids, and the unattached bytes plus this one within the cap
-- Zero rows affected means refused; the caller reads P2_unattached.sql and the design's count to say why. One statement, no trailing semicolon.
INSERT INTO design_photos (id, kind, design_id, mime, byte_size, sha256, bytes, created_by)
SELECT ?, ?, ?, ?, ?, UNHEX(?), ?, ?
FROM DUAL
WHERE (SELECT COUNT(DISTINCT p.id) FROM design_photos p WHERE p.design_id = ? AND p.removed_at IS NULL AND p.id <> ?) < ?
  AND (
    EXISTS (SELECT 1 FROM designs d WHERE d.id = ?)
    OR (
      (SELECT COUNT(DISTINCT p.id) FROM design_photos p LEFT JOIN designs d ON d.id = p.design_id WHERE p.removed_at IS NULL AND d.id IS NULL AND p.id <> ?) < ?
      AND (SELECT COALESCE(SUM(p.byte_size), 0) FROM design_photos p LEFT JOIN designs d ON d.id = p.design_id WHERE p.removed_at IS NULL AND d.id IS NULL) + ? <= ?
    )
  )
