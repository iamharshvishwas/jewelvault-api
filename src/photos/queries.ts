// P2 (API17): the SQL text of the photo insert with its caps (one statement: the count and the insert cannot be separated) and of the unattached figure, as db/queries/P2_insert_photo.sql and
// db/queries/P2_unattached.sql write them (spec P2, RF5-9, O56). src/ is compiled alone (tsconfig.build.json, rootDir src) and cannot import scripts/queries.mjs, which reads those files, so the text is
// copied here; tests/api/photo-store.test.ts compares each constant with loadQueries() character for character, so a change to a query file that is not made here fails the test.
// Edit the query file first (the database half owns db/), then copy the text here. The parameters, in order, are listed in the query file's header.

export const P2_INSERT_TEXT = `INSERT INTO design_photos (id, kind, design_id, mime, byte_size, sha256, bytes, created_by)
SELECT ?, ?, ?, ?, ?, UNHEX(?), ?, ?
FROM DUAL
WHERE (SELECT COUNT(DISTINCT p.id) FROM design_photos p WHERE p.design_id = ? AND p.removed_at IS NULL AND p.id <> ?) < ?
  AND (
    EXISTS (SELECT 1 FROM designs d WHERE d.id = ?)
    OR (
      (SELECT COUNT(DISTINCT p.id) FROM design_photos p LEFT JOIN designs d ON d.id = p.design_id WHERE p.removed_at IS NULL AND d.id IS NULL AND p.id <> ?) < ?
      AND (SELECT COALESCE(SUM(p.byte_size), 0) FROM design_photos p LEFT JOIN designs d ON d.id = p.design_id WHERE p.removed_at IS NULL AND d.id IS NULL) + ? <= ?
    )
  )`;

export const P2_UNATTACHED_TEXT = `SELECT COUNT(DISTINCT p.id) AS photos, CAST(COALESCE(SUM(p.byte_size), 0) AS CHAR) AS bytes
FROM design_photos p LEFT JOIN designs d ON d.id = p.design_id
WHERE p.removed_at IS NULL AND d.id IS NULL`;
