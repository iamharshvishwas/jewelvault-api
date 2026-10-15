# Backup, photo copy and restore: the database half (spec B2, B4, I12)

Date: 15 October 2026. Draft, not run on Hostinger. Code: `scripts/backup.mjs` (export, photo copy, stores), `scripts/restore.mjs`, `scripts/health.mjs` (I12 and the dashboard line). 23 tests in `tests/schema/s13-backup-restore.test.ts`, 16 in `s12-health.test.ts`.

## Who does what

| Part | Where | Status |
|---|---|---|
| Read the database: a consistent export, the once-only photo copy, row counts and hashes | `scripts/backup.mjs` | done, tested |
| Rebuild an **empty** database from an export and the photo copy, and prove it equal | `scripts/restore.mjs` | done, tested |
| Age of the last good export and photo copy, last check, database size, Delete/Drop rights | `scripts/health.mjs` | done, tested |
| gzip, AES-256-GCM encryption with a per-file key wrapped by the RSA public key, upload to R2, bucket locks, pruning `daily/` | the API's backup job (hourly tick, I8) | **not done**: plugs in through `Sink` and `PhotoStore` |
| Download, decrypt, start a throw-away MariaDB 11.8 in Docker, call `restoreDatabase`, tick the runbook list | the restore tool on Harsh's Mac | **not done**: plugs in through `Source` and `PhotoStore` |
| Writing the `backup_runs` rows (`db_dump`, `photo_copy`, `restore_drill`) | the job / the tool | not done (the table and the checks exist) |

## The export (B2)

`exportDatabase(conn, sink, { pageSize })` runs inside one `REPEATABLE READ` snapshot (set for the next transaction only; the caller's isolation level is left alone) and reads every base table in **keyset pages** in primary-key order. Output, through the sink:

- `manifest.json`: format `jewelvault-export-1`, server version, per table the `SHOW CREATE TABLE` text, the columns, the primary key, the row count and the **sha256 of its data file**; the views and triggers with their create statements; `excluded: { design_photos: ["bytes"] }`; the number of live photos.
- `data/<table>.ndjson`: one JSON object per row. **Every value is text** (DECIMAL and dates exactly as the server prints them, binary columns as hex, NULL as null), so nothing depends on how the connection was configured. Generated columns are left out (the server computes them). The photo bytes are left out completely.

Rules learned while writing it:

- A UUID primary key sorts in the type's own order, **not as text**. In the SELECT list a column that is cast to text and given its own name hides the real column in `ORDER BY id`, so the pages overlapped and skipped rows with random (v4) UUIDs. The export qualifies every key as `src.<column>`. A test with 2-row pages and one with 30,000 random-UUID bills guard it. **Any keyset paging in the API (C4 polling, `(updated_at, id)`) must compare ids as the UUID type, never as text, and must not alias a column to its own name.**
- Photos travel through the photo copy: `copyPhotosOnce(conn, store)` writes each live photo that has no `sys_photo_copies` row to the store once (oldest first), checks its bytes against the recorded sha256 and size first, and records the copy. A failed upload records nothing and does not stop the others.

## The restore (B4)

`restoreDatabase(conn, source, photos, { allowMissingPhotos, skipInvariants })`:

1. refuses any database that has a table or view ("not empty"): it can never be pointed at live data by mistake;
2. checks the sha256 of **every data file against the manifest before creating anything** (a file changed after the export stops here);
3. creates the tables from the recorded statements, loads the rows in batches with foreign keys off (`bills.reissue_of` points at another bill), puts each live photo's bytes back from the photo copy (sha256 and size checked; a missing or wrong photo fails the restore and is named; `allowMissingPhotos` skips and lists it instead and marks the report not ok), then creates the views and the triggers (the `DEFINER` of the source account is dropped);
4. runs `ANALYZE TABLE` (fresh statistics), switches foreign keys on and looks for orphans, **exports the restored database again and compares every table's content hash with the manifest**, checks every photo against its sha256 inside the database, and runs the nightly check on the copy.

The report (`ok`, per table rows expected/restored/hash, photos, orphans, nightly check, problems) is what the drill (T-R02) reads. A failed restore leaves a partly filled database: drop it and start again.

Measured locally: 63,000 rows (30,000 bills) export in about 1 second and restore plus full verification in about 5 seconds; the drill's budget is 2 hours.

## The dashboard line (I12)

`readHealth(conn)` returns the level (`red`, `amber`, `green`), the reasons in dashboard order and the figures: the last check (any result) and whether it said Problem, the last `backup_runs` row with `ok = 1` for `db_dump` and for `photo_copy` (a `restore_drill` row is not a backup), the database size from `information_schema` against 2 GiB, and whether the user may Delete or Drop (read from `SHOW GRANTS`). Red: the last check says Problem, a check/export/photo copy older than 26 hours **or never run**, size above 2 GiB. Amber: nothing red but a Delete or Drop right is on (S11). "Never run" is red on purpose: a new shop is not backed up until the first tick has run.

## Left for the API session

The hourly tick (I8) decides what is due and calls these functions; it writes `backup_runs`, `check_runs` and `sys_job_runs` rows; it owns encryption, the bucket and the 130-second limit. If the tick cannot reach the bucket from Hostinger (O48), the same `exportDatabase` runs from the Mac through Remote MySQL (O49) with a directory sink.
