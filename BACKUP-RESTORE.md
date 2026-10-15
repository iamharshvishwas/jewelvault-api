# Backup, photo copy and restore: the database half (spec B2, B4, I12; spec draft 5)

Date: 15 October 2026. Draft, not run on Hostinger. Code: `scripts/backup.mjs` (export, photo copy, stores), `scripts/restore.mjs`, `scripts/health.mjs` (I12 and the dashboard line). 31 tests in `tests/schema/s13-backup-restore.test.ts`, 19 in `s12-health.test.ts`.

## Who does what

| Part | Where | Status |
|---|---|---|
| Read the database: a consistent read-only export, the once-only photo copy with the bucket's size check, row counts and hashes | `scripts/backup.mjs` | done, tested |
| Rebuild an **empty** database from the migration files, the export and the photo copy, and prove it equal | `scripts/restore.mjs` | done, tested |
| Age of the last good export and photo copy, last check, database size (P5), Delete/Drop rights | `scripts/health.mjs` | done, tested |
| Spool each file to disk inside the snapshot, close it, then gzip, AES-256-GCM encrypt (per-file key wrapped by the RSA public key), upload with `If-None-Match: *`, bucket locks, slices of about 40 seconds, pruning `daily/` | the API's backup job (hourly tick, I8) | **not done**: plugs in through `Sink` and `PhotoStore` |
| Download, decrypt, start a throw-away MariaDB 11.8 in Docker, call `restoreDatabase`, tick the runbook list, own read-only R2 token | the restore tool on Harsh's Mac | **not done**: plugs in through `Source` and `PhotoStore` |
| Writing the `backup_runs` rows (`db_dump`, `photo_copy`, `restore_drill`): `ok` only for a complete phase | the job / the tool | not done (the table and the checks exist) |

## The export (B2)

`exportDatabase(conn, sink, { pageSize })` runs inside one **read-only** snapshot (`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`, then `START TRANSACTION READ ONLY, WITH CONSISTENT SNAPSHOT`; the caller's isolation level is left alone, a write meanwhile is refused with 1792) and reads every exported table in **keyset pages** in primary-key order. Output, through the sink:

- `manifest.json`: format `jewelvault-export-1`, server version, **the migration files the database was built with** (version, name, checksum), per table the columns, the primary key, the row count and the **sha256 of its data file**; `excluded`, `omitted` and `filtered` say what was left out and why; the number of live photos; whether the source had triggers. **No table definitions, views or triggers**: `SHOW CREATE TABLE` leaves triggers out, so the migration files in the repository are the schema (B4).
- `data/<table>.ndjson`: one JSON object per row. **Every value is text** (DECIMAL and dates exactly as the server prints them, binary columns as hex, NULL as null), so nothing depends on how the connection was configured. Generated columns are left out (the server computes them).
- Left out: the photo `bytes` (they travel through the photo copy); the tables `sessions` (everyone signs in again) and `sys_login_attempts` (counters, rebuilt by use); `schema_migrations` (replaced by the list in the manifest); the `sys_idempotency` rows older than 90 days (expired, L6).

Rules learned while writing it:

- A UUID primary key sorts in the type's own order, **not as text**. In the SELECT list a column that is cast to text and given its own name hides the real column in `ORDER BY id`, so the pages overlapped and skipped rows with random (v4) UUIDs. The export qualifies every key as `src.<column>`. A test with 2-row pages and one with 30,000 random-UUID bills guard it. **Any keyset paging in the API (C4 polling, `(updated_at, id)`) must compare ids as the UUID type, never as text, and must not alias a column to its own name.**
- `copyPhotosOnce(conn, store)` uploads each live photo that has no `sys_photo_copies` row once (oldest first), after checking its bytes against the recorded sha256 and size; then asks the store for the object's size (`head`, a HEAD request) and **only when it equals the photo's size** records `(photo_id, kind, sha256, size)`. A failed upload, a missing object or a wrong size records nothing and does not stop the others; the next run retries. A removed photo keeps its copy row (no foreign key).

## The restore (B4)

`restoreDatabase(conn, source, photos, { migrationsDir, triggers, skipInvariants })`, in the order of B4:

0. refuses a database that has any table or view ("not empty"), an export of another format, a data file whose sha256 differs from the manifest, and migration files other than the ones the export was made with: **all before anything is created**;
1. applies the migration files (no seeds, no trigger files) through the same runner, so `schema_migrations` agrees with the repository;
2. loads the data in **foreign-key order** (derived from the keys the migrations made; the keys stay ON; `bills.reissue_of` is loaded in waves, the replaced bill first);
3. inserts each live `design_photos` row **together with its bytes** from the photo copy (size and sha256 checked first). A photo that is missing or does not match is **inserted as a tombstone** (`removed_at` = the restore time), listed in the report as `missing`, `size` or `sha256`, and makes the report not ok: the owner decides about each one;
4. restores tombstones as they are;
5. applies the trigger files last (when the source had them), so that loading writes no audit rows;
6. runs `ANALYZE TABLE`, checks the keys, **exports the restored database again and compares every table's content hash with the manifest** (so the row counts too), checks every restored photo against its sha256 inside the database, and runs the nightly check on the copy.

It works as the restricted user of A3 (the ten ticked boxes) and a test proves it. A failed restore leaves a partly filled database: drop it and start again.

Measured locally: 63,000 rows (30,000 bills) export in about 1 second and restore plus full verification in about 5 seconds; the drill's budget is 2 hours.

## The dashboard line (I12)

`readHealth(conn)` returns the level (`red`, `amber`, `green`), the reasons in dashboard order and the figures: the last check (any result) and whether it said Problem, the last `backup_runs` row with `ok = 1` for `db_dump` and for `photo_copy` (a `restore_drill` row is not a backup), the database size, and what the user may do (from `SHOW GRANTS`).

- Size (P5): `DATA_LENGTH + INDEX_LENGTH` of every table except `design_photos`, after an `ANALYZE TABLE` of each, plus `SUM(byte_size)` of the live photos, plus 12 percent. `information_schema` alone lags badly for a few large rows (65 MB of photos read as 0.0 MB). `analyze: false` skips the ANALYZE when the API caches the answer.
- Red: the last check says Problem; a check, export or photo copy older than 26 hours **or never run**; size above 2 GiB. Amber: nothing red but a Delete or Drop right is on (S11). `rights.extra` lists any other box of A3 that is on although it should be off (the start-up check notes it in the log, T-F08). "Never run" is red on purpose: a new shop is not backed up until the first tick has run.

## Left for the API session

The hourly tick (I8) decides what is due, runs the phases in slices, writes `backup_runs`, `check_runs` and `sys_job_runs` rows, and owns encryption, the bucket, the 130-second limit and `GET /internal/jobs/health`. If the tick cannot reach the bucket from Hostinger (O48), the same `exportDatabase` runs from the Mac through Remote MySQL (O49) with a directory sink.
