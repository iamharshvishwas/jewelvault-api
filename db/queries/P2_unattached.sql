-- P2 (RF5-9, O56): the unattached photos: live photo rows whose design_id is not (yet) a design. photos counts DISTINCT ids (a photo is a full image and its thumbnail), bytes is SUM(byte_size).
-- The upload is refused beyond 60 photos or 100 MB, and whenever the size line of P5 is red. No parameters. One SELECT, no trailing semicolon.
SELECT COUNT(DISTINCT p.id) AS photos, CAST(COALESCE(SUM(p.byte_size), 0) AS CHAR) AS bytes
FROM design_photos p LEFT JOIN designs d ON d.id = p.design_id
WHERE p.removed_at IS NULL AND d.id IS NULL
