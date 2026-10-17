// P5 (API17): the database size line, as the upload reads it. Same formula as readHealth (src/reads/health.ts, the dashboard line): DATA_LENGTH + INDEX_LENGTH of the tables other than design_photos, plus
// SUM(byte_size) of the live photos, plus 12 percent for InnoDB overhead. information_schema alone lags badly for a table of few large rows (it said 0.0 MB after 65 MB of photos), which is why the photos
// are summed from the rows. No ANALYZE TABLE here: an upload must not run 25 of them, and the other tables are small next to the photos; the dashboard line does run them. tests/api/photo-store.test.ts
// keeps this function equal to readHealth(analyze: false) and checks the line against the real size after 400 bulk-inserted photo rows (T-F10).
import type { Reader } from '../db/tx.js';
import { DB_RED_LINE_BYTES } from '../reads/health.js';

export async function readDbSizeBytes(db: Reader): Promise<number> {
  const [tables] = await db.rows<{ d: string | number; i: string | number }>(
    "SELECT COALESCE(SUM(DATA_LENGTH), 0) AS d, COALESCE(SUM(INDEX_LENGTH), 0) AS i FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE' AND TABLE_NAME <> 'design_photos'",
  );
  const [photos] = await db.rows<{ b: string | number }>('SELECT COALESCE(SUM(byte_size), 0) AS b FROM design_photos WHERE removed_at IS NULL');
  return Math.round((Number(tables.d) + Number(tables.i) + Number(photos.b)) * 1.12);
}

/** O46: red above 2 GB of the plan's 3 GB; exactly 2 GB is not red. */
export const sizeLineIsRed = (bytes: number): boolean => bytes > DB_RED_LINE_BYTES;
