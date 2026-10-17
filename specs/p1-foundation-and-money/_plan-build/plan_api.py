# -*- coding: utf-8 -*-
"""Database half (done and aligned) and the Node API tasks."""
from plan_core import T, ROLLBACK_LOCAL_API as RB

# =============================================================================================== DATABASE HALF
T("MB01", "MB", "DONE: schema (26 tables), create-only migration runner, seeds, limits file",
  status="DONE", grp="pure", commit="ce5c75a, a316651, 4c00b4b, e45135d (jewelvault-api); 334 schema tests shared with MB02, plus 85 spike and Hostinger-fact tests",
  reqs=["D1", "D3", "D5", "D6", "D7", "D8", "D9", "D10", "D11", "D12", "D13", "D14", "D15", "D16", "D17", "D18", "D19",
        "D20", "D21", "D26", "S9", "P4"],
  tests=["T-F02", "T-F04"],
  do="Already in the repository: `db/migrations/0001` to `0010` (26 tables, 81 CHECKs, 19 foreign keys, 83 indexes, native UUID, "
     "`DECIMAL` money, `utf8mb4_unicode_ci` named in every table), `db/seeds/*` (settings keys, categories, the walk-in customer, "
     "no sample data), `db/limits.json`, `db/schema.sql`/`db/seed.sql` (built by `npm run db:schema`), the optional append-only "
     "trigger file `db/optional/0900_audit_log_append_only.sql`, and `scripts/migrate.mjs`, the create-only runner that enforces "
     "S9 (it reads every file first, refuses a statement outside the allowed list and one without its `IF [NOT] EXISTS` form, "
     "and a test runs every file as the ten-box user of A3). Counters: `sys_counters` (with `seed_value`) is in the schema; the "
     "numbering code is API14.",
  files=["db/migrations/0001_system.sql", "db/migrations/0010_audit_checks.sql", "db/limits.json", "db/seeds/0100_walkin_customer.sql",
         "scripts/migrate.mjs", "tests/schema/s1-migrate.test.ts", "tests/schema/s2-catalogue.test.ts",
         "tests/schema/s3-constraints.test.ts", "tests/schema/s4-seeds.test.ts", "tests/schema/s16-migration-rules.test.ts"],
  done="Evidence, not re-done: the whole repository ran 521 tests green on 15 Oct 2026 (`npm run db:up` then `npx vitest run`, "
       "about 1 to 2 minutes; 436 of them in `tests/schema`). T-F02 and T-F04 are the spec tests this work proves (constraints and "
       "caps; migrations twice, half-applied, restricted user, refused forms). The clause of T-F02 that compares the API's "
       "constants file with every CHECK literal belongs to API06. MB07 checks whether the database session has changed anything since.",
  rollback="Already committed. A later change to a migration is a new migration (the runner refuses edits once applied).")

T("MB02", "MB", "DONE: the four derived reads as query files, invariant SQL I1 to I7, I10, I13, one-customer reads",
  status="DONE", grp="pure", commit="4c00b4b, e45135d (jewelvault-api); counted with MB01 (334 schema tests together); V1 correlated form in MB05",
  reqs=["V1", "V2", "V3", "V4", "R11", "I1", "I2", "I3", "I4", "I5", "I7", "I10", "I13"],
  tests=["T-B02"],
  do="Already in the repository: `db/queries/V1_bill_summary.sql`, `V2_customer_balances.sql`, `V2_customer_balance_one.sql`, "
     "`V3_customer_ledger.sql`, `V4_daily_totals.sql` (queries, not views: spec section 11), loaded by `scripts/queries.mjs`; "
     "`db/invariants/I01` to `I13` (SQL halves; I6 and I11 are finished in Node by API32) and `scripts/invariants.mjs` "
     "(`runInvariants(conn, ...)`: one REPEATABLE READ snapshot, with the optimizer switch that keeps I10 fast), with mutation "
     "tests (one damaged row per invariant). The state-read queries `S1` to `S4` and the correlated V1 form "
     "were committed on 16 Oct (MB05).",
  files=["db/queries/V2_customer_balances.sql", "db/queries/V3_customer_ledger.sql", "db/queries/V4_daily_totals.sql",
         "db/invariants/I10_rebalance.sql", "scripts/invariants.mjs", "scripts/queries.mjs", "tests/schema/s9-views.test.ts",
         "tests/schema/s10-invariants.test.ts", "tests/schema/s11-invariants-scale.test.ts"],
  done="Evidence, not re-done: `tests/schema/s9`, `s10`, `s11` green on 15 Oct 2026 (hand-computed V1 to V4 figures; each of I1 to "
       "I7, I10 and I13 named by one damaged row; 30,000 bills checked in 1.8 s). T-B02 (Paid, Partial, Pending, Cancelled as R11) "
       "is the spec test this work proves.",
  rollback="Already committed.")

T("MB03", "MB", "DONE: health query, export, once-only photo copy, restore library",
  status="DONE", grp="pure", commit="5c71968, 6ec5636, 067c080 (jewelvault-api); 50 tests (s12 19, s13 31); 5.2 parts in MB05",
  reqs=["P5"],
  tests=[],
  do="Already in the repository: `scripts/health.mjs` (`readHealth`: ages of the last good export and photo copy, the database size "
     "worked out as P5 says, the Delete/Drop rights, red/amber/green), `scripts/backup.mjs` (`exportDatabase(conn, sink)` in one "
     "read-only snapshot, no table definitions, `copyPhotosOnce(conn, store)`, a directory store whose `put` links a temporary file "
     "into place), `scripts/restore.mjs` (`restoreDatabase`: B4 steps 0 to 6, foreign-key order from the keys, live photo rows "
     "inserted with their bytes, missing photos as tombstones, hash comparison with the manifest). What this commit did not "
     "have, and MB05 added on 16 Oct: the encrypted single-stream export writer, the backup-folder rules and the pacer. What is "
     "still built later: the cron script and the due logic (API34), SFTP and the restore command on the Mac (API36).",
  files=["scripts/health.mjs", "scripts/backup.mjs", "scripts/restore.mjs", "BACKUP-RESTORE.md", "tests/schema/s12-health.test.ts",
         "tests/schema/s13-backup-restore.test.ts"],
  done="Evidence, not re-done: `tests/schema/s12` and `s13` green on 15 Oct 2026 (63,000 rows exported in about 1 s and restored "
       "plus verified in about 5 s; the naive restore shown failing with error 4025). The size test T-F10 clause 'right against a "
       "real bulk insert' is part of s12 and is re-run by API17.",
  rollback="Already committed.")

T("MB04", "MB", "DONE: import library and command, rebalance library (Y6), counter seeding",
  status="DONE", grp="pure", commit="5c71968, e45135d (jewelvault-api); 52 tests (s14 13, s15 39)",
  reqs=["IM1", "IM2", "IM3", "IM4", "IM6"],
  tests=["T-C16"],
  do="Already in the repository: `scripts/import.mjs` (a pack in, one transaction per batch, explicit numbers kept, "
     "`seedCounters()`, opening rows, rebalance, reconciliation report, `--dry-run`, `--strict`), `scripts/import-cli.mjs`, "
     "`scripts/rebalance.mjs` (`rebalanceCustomer(conn, customerId)`: the one copy of Y6 that the import and X12 share) and "
     "`IMPORT-GUIDE.md` (the pack format). Not here: the converter from Siddhi's sheet to a pack (IMP01), which nobody can write "
     "before the sheet exists.",
  files=["scripts/import.mjs", "scripts/import-cli.mjs", "scripts/rebalance.mjs", "IMPORT-GUIDE.md",
         "tests/schema/s14-rebalance.test.ts", "tests/schema/s15-import.test.ts"],
  done="Evidence, not re-done: `tests/schema/s14` and `s15` green on 15 Oct 2026 (1,000 customers, 2,000 designs and 6,000 pieces in "
       "about 4 s). T-C16 is introduced here for its import half; the clauses 'numbering skips an imported number without a "
       "next-key lock' (API14) and 'after the import an X12 call and a create_bill keep I5 green' (API27) are finished later.",
  rollback="Already committed.")

T("MB05", "MB", "DONE: the database half aligned to spec 5.2 (correlated reads, health figures, backup folder and encrypted export writer, pacing, admin SQL, caps)",
  status="DONE", grp="pure", commit="379ef68 (16 Oct 14:53) and a2a720b (16 Oct 15:15) (jewelvault-api); new tests in s17 (5), s18 (13), s19 (30) and added cases in s9, s12, s16",
  reqs=["I12"], tests=["T-F11"],
  do="Committed by the database session while this plan was being written. Part 1 (379ef68): `db/queries/V1_bill_summary.sql` and the "
     "one-customer state reads `S1` to `S4` as correlated sub-selects with named indexes (the join form kept only as the negative control: "
     "error 1969 after 8 s for 10,000 bills), `P2_insert_photo.sql`, `P2_unattached.sql`, the IF [NOT] EXISTS rule of S9 in the runner, "
     "`scripts/housekeeping.mjs` (`logError` with the cap of 20 rows a minute for each code, `insertPhotoGuarded` and `unattachedPhotos` "
     "for the caps of P2, `clearLoginCounters`, `recordPull`). Part 2 (a2a720b): `scripts/export-file.mjs` (`loadPublicKey`, "
     "`createExportWriter`: gzip then AES-256-GCM with a fresh key wrapped by the RSA public key, one stream; `unpackExport` to decrypt), "
     "`scripts/backup-folder.mjs` (`resolveBackupDir` for `JV_BACKUP_DIR`, `writeDailyExport` with `.partial`, `fsync`, `link()`, the "
     "recorded-sha256 retry rule and the run-specific name, `linkMonthly`, `sweepPartials`, `folderStats`, `planPrune`/`prune` with "
     "the guard rails, `recordBackupRun`), `scripts/pacing.mjs` (`createPacer`: at most 10 new connections in 1.2 s), and "
     "`readHealth` with the days since the last Download everything, `last_pulled` and the folder's file count. **Still not there at 15:17 "
     "on 16 Oct** (checked by MB07): a function that closes finished login-failure hours (built in API33), and the text of "
     "`BACKUP-RESTORE.md`, which still says the encryption is not done and the tick runs the export (corrected in API34).",
  files=["scripts/backup-folder.mjs", "scripts/export-file.mjs", "scripts/pacing.mjs", "scripts/housekeeping.mjs", "scripts/health.mjs",
         "db/queries/V1_bill_summary.sql", "db/queries/S1_open_bills_of_customer.sql", "tests/schema/s17-big-customer.test.ts",
         "tests/schema/s18-housekeeping.test.ts", "tests/schema/s19-backup-folder.test.ts"],
  done="Evidence, not re-done: `tests/schema/s17` (T-F11: V1, V3 and the state read for a customer with 10,000 bills inside 500 ms on a "
       "pooled prepared connection after a small customer, with the join form shown failing), `s18` (error-log cap, photo caps, counter clear, "
       "pull record), `s19` (writes the daily export, the retry rule, create-once, pruning guard rails) and the extended `s12` "
       "(health: day 27 green, 28 and 35 amber, 36 red; pull amber after 10 days; the file count falling without a prune is red) were committed green "
       "on 16 Oct 2026. T-F11 and I12 are the spec lines this work proves.",
  rollback="Already committed.")

T("MB07", "MB", "ALIGN check: close the 18.13 E checklist against the repository before the API relies on it",
  agent="A", grp="pure", pd=0.2, deps=[],
  reqs=[], tests=[],
  do="A fresh `git log` and `git status` of `jewelvault-api` read against 18.13 E item by item and against the names this plan relies on. At "
     "12:30 on 17 Oct items (1) V1 and the state reads, (2) the health figures, (3) the export sink and folder rules, (4) the docs, (5) the admin statements and "
     "(7) the audit triggers are committed (MB05 `379ef68`, `a2a720b`, MB06 `a5790d8`); (6) a function that closes finished login-failure hours does not "
     "exist in the database half and is built in API33. If the database session has committed more by the time the API work starts, this task ticks it; if "
     "it has changed a function signature that this plan names (`writeDailyExport`, `createExportWriter`, `unpackExport`, `prune`, `recordBackupRun`, "
     "`readRecordedExport`, `withJobLock`, `readHealth`, `clearLoginCounters`, `recordPull`, `logError`, `insertPhotoGuarded`, `rebalanceCustomer`, "
     "`runInvariants`, `generateAuditTriggersSql`), it edits the names in the tasks that use them. It edits no file in `db/`.",
  files=[],
  done="`git log --oneline` of `jewelvault-api` is attached to the task report with each checklist item marked committed or assigned; "
       "`npm run db:up && npx vitest run tests/schema` is green on the commit the API work starts from.",
  rollback="Nothing to roll back (a check).")

T("MB06", "MB", "DONE: generated audit triggers (L1 a), exclude list, import audit mode, job locks per database",
  status="DONE", grp="pure", commit="a5790d8 (16 Oct 15:35) (jewelvault-api); 549 schema tests in all (whole suite 630 passed, 2 skipped), s20 has 16",
  reqs=["L1", "L2", "O50"], tests=["T-D14"], uses=["D16", "D22", "D23"],
  do="Committed by the database session on 16 Oct, after this plan's first draft. `db/optional/0910_audit_triggers.sql` is GENERATED from the catalogue by "
     "`scripts/build-audit-triggers.mjs` and `scripts/audit-triggers.mjs` (`generateAuditTriggersSql`, `loadExcludeList`, `auditTriggersInstalled`, "
     "`AUDITED_TABLES`) and `db/optional/audit-exclude.json`: 13 audited tables, one AFTER INSERT and one AFTER UPDATE trigger each, exactly one `audit_log` "
     "row per change, actor, role and request id from the session variables `@jv_actor`, `@jv_role` and `@jv_request` (role `sql` when none is set; a malformed "
     "actor stops the change with error 1292), nothing for an UPDATE of `updated_at` alone, no `password_hash`; `runImport` with `audit: 'auto'` uses the "
     "triggers when they exist (role `import`) and refuses the other modes there (never both). Also `jobLockName` and `withJobLock` in `scripts/housekeeping.mjs` "
     "(`GET_LOCK('jv_tick:<database>', 0)` and `jv_dump:<database>`, `RELEASE_LOCK` in a `finally`, a thrown error marks `destroyConnection`), the docs "
     "`BACKUP-RESTORE.md`, `SCHEMA.md`, `IMPORT-GUIDE.md` rewritten for 5.2, and the proof kit step S07b that tests the triggers on the plan. "
     "What is left for the API: setting and clearing the three variables in `withTx` (API03), the Node writer of mechanism (b) and `JV_AUDIT_MODE` (API15), "
     "and counting audit rows in every function's test (the clauses of T-D14).",
  files=["db/optional/0900_audit_log_append_only.sql", "scripts/migrate.mjs", "scripts/audit-triggers.mjs", "scripts/build-audit-triggers.mjs",
         "db/optional/0910_audit_triggers.sql", "db/optional/audit-exclude.json", "tests/schema/s20-audit-triggers.test.ts"],
  done="Evidence, not re-done: `tests/schema/s20-audit-triggers.test.ts` green on 16 Oct 2026 as the ten-box user (one insert and one update on each of the 13 "
       "tables give exactly one audit row; role `sql` with no actor; `updated_at` alone writes nothing; no hash in any audit row; `UPDATE`/`DELETE` on "
       "`audit_log` refused; the file applies twice with no change). T-D14's database half is proved here; the other halves are the clauses of the API tasks.",
  rollback="Already committed.")

T("API01", "API", "Repo skeleton, lane harness, config, logging, clock",
  agent="A", grp="pure", pd=1.0, deps=["RV0", "PH01"],
  reqs=["A3", "S5"], tests=[], ptests=["PT-H1 harness smoke: a lane database starts, migrates as the ten-box user and is removed; the injected clock never repeats an instant"],
  uses=["U10", "S1"],
  do="In `jewelvault-api`: `package.json` (engines node >=24.7, TypeScript 5.9 (not 7), Fastify 5, mysql2, Zod 4, Vitest; "
     "`typescript` stays in devDependencies, Hostinger installs them before `build`), `tsconfig` build to `dist/` with entry "
     "`dist/server.js`, `src/server.ts` (listen on `process.env.PORT ?? 3000`, `0.0.0.0`), `src/app.ts` (`buildApp()` for "
     "`inject()` tests), `src/config.ts` (env read once, validated, refuses to start when a variable is missing; names in "
     "`.env.example`, `.env` ignored), pino logging with redaction of cookies, authorization and password fields, `src/clock.ts` "
     "(S5: Asia/Kolkata business date, never the same instant twice, a test seam that the production build cannot reach). "
     "Lane harness `scripts/lane.mjs` (`npm run db:lane -- up|down|reset|url <lane>`): lanes main, a, b, c; container "
     "`jv-mariadb-<lane>`, port 33310 plus the lane number, MariaDB 11.8 with `--transaction-isolation=READ-COMMITTED`, data in "
     "tmpfs (no volume), removed with `docker rm -fv` of its own name only (never the guard container "
     "`keep-tourstack-and-unknown-volumes`), the schema migrated as the ten-box restricted user of A3 (a helper builds that "
     "user), `sql_mode` set to Hostinger's non-strict value on the server so tests prove the per-connection strict mode. Test "
     "files name each spec test in a `describe('T-xxx ...')` so that `npm test -- -t T-C09` finds it. `npm run verify` = "
     "typecheck, build, `check:pricing` (once API18 exists), `check:routes`, all tests. The reviewer's reference driver "
     "(`jewelvault-api-design/spec-draft5-review/rm5-experiments/lib.mjs`, 749 lines, X0 to X12 in Node on MariaDB) is a "
     "read-only head start and oracle for API14 to API31, not code to paste.",
  files=["package.json", "tsconfig.json", "vitest.config.ts", "scripts/db-up.sh", "scripts/db-down.sh", "tests/helpers.ts"],
  done="`npm run db:lane -- up a && npm run db:lane -- up b` start two lanes at once on two ports (and `down` removes only "
       "them); `npm test -- -t PT-H1` passes: the lane database is migrated twice with no change, as the restricted user; a "
       "thousand clock readings inside one microsecond are strictly increasing, also from a clock fixed at one instant; the "
       "server refuses to start (exit code 1, no listening port) when `DB_PASSWORD` is unset; `GET /healthz` answers "
       "`{\"ok\":true}` through `inject()`; `npm run verify` is green. T-D12/T-D29 parts follow in API10.",
  rollback=RB)

T("API02", "API", "Connection layer: one pool of 8, per-checkout session settings, paced connect, start-up check",
  agent="A", grp="pure", pd=0.9, deps=["API01"],
  reqs=["S11"], tests=["T-F08"],
  do="`src/db/pool.ts`: one mysql2 pool of at most 8, no other code opens a connection (a source check in API10); every checkout "
     "runs `SET SESSION` for isolation READ-COMMITTED, strict `sql_mode` (`STRICT_ALL_TABLES,ERROR_FOR_DIVISION_BY_ZERO`), "
     "`time_zone '+00:00'`, `innodb_lock_wait_timeout` 5, `max_statement_time` 8, `utf8mb4`, `wait_timeout` 300; a dead idle "
     "connection found by the checkout is destroyed and another is taken (twice); idle connections go back after 60 s and at "
     "most 4 stay idle; a request waits at most 2 s for a connection (the wrapper's own timer; mysql2 has none) and at most "
     "16 wait, the rest `JV_BUSY` with nothing started; a refused new connection (`connect EPERM`) is retried once after "
     "1.1 s and then `JV_BUSY`; tools and tests pace themselves to 10 new connections in 1.2 s (the database half's `scripts/pacing.mjs`, `createPacer`, used by the "
     "harness too). `src/preflight.ts`: MariaDB 11.x, READ-COMMITTED, session settings settable, `utf8mb4`, every table the "
     "code needs exists, `SHOW GRANTS` read and reported (a Delete or Drop right that is on turns the dashboard amber, any "
     "right outside the ten boxes of A3 is noted in the log); failure keeps the API up and answers `503 JV_UNAVAILABLE` to "
     "everything but `/healthz`, and the reason goes to the log only. Errors are plain classes here; their HTTP mapping is API03.",
  files=["tests/helpers.ts"],
  done="`npm test -- -t T-F08` passes on a lane database whose server `sql_mode` is non-strict: every checkout reads back the "
       "seven settings; an over-range amount is clamped without error on a plain connection and refused (1264) on the API's; "
       "start-up answers `503 JV_UNAVAILABLE` when the isolation level is changed, a table is dropped in a scratch schema or the "
       "server is not MariaDB 11 (simulated); a Delete right that is on is reported amber, not fatal; the pool replaces a "
       "closed connection; a burst of 30 calls after a quiet spell opens at most 8; a simulated EPERM is retried once after "
       "1.1 s then `JV_BUSY`; 17th waiting request is `JV_BUSY` at once; the third second of waiting for a connection gives "
       "`JV_BUSY` in under 3 s with nothing written.",
  rollback=RB)

T("API03", "API", "Transactions: withTx, deadline, deadlock re-run, error map, statement wrapper, SIGTERM",
  agent="A", grp="money", pd=1.1, deps=["API02"],
  reqs=["S12", "S8", "S7", "H7"], tests=["T-C19", "T-C18", "T-D07"], uses=["S10"],
  do="`src/db/tx.ts` `withTx(ctx, fn)`: one request, one connection, one transaction; any database error means ROLLBACK of "
     "everything (domain code never catches a database error and goes on); the deadline of 12 s starts when the request arrives "
     "(it includes the pool wait) and is checked before every statement and again just before COMMIT, where a late call is rolled "
     "back; a deadlock (1213) re-runs the whole function up to 2 more times after 20 to 80 ms of jitter, then `JV_BUSY`; the "
     "actor variables of MB06 are set at the start of the transaction and cleared at the end; statements are prepared "
     "(`execute`, one `?` per value), an object parameter is refused, `REPLACE INTO` never; `src/db/stmt.ts` is the one statement "
     "wrapper and refuses `DELETE`, `TRUNCATE` and `DROP` (a grep test lists every hit in the code). `src/errors.ts`: every "
     "`JV_*` code with its HTTP status (S8), the map from database errors (1205, 1969, 1213 after retries, full pool, refused "
     "connection, lost connection mean `JV_BUSY`; 1062 on a business key is `JV_INVALID_INPUT`, anywhere else `JV_INTERNAL`; "
     "4025 and 1264 are `JV_INVALID_INPUT` and logged as a bug; 1451/1452 `JV_INTERNAL`), the JSON body "
     "`{error:{code,message,details},request_id}` and a connection dropped during COMMIT is `JV_BUSY` that never promises "
     "'nothing was changed'. `src/server.ts` on SIGTERM stops accepting calls, lets transactions finish (at most 10 s) and closes "
     "the pool. Tests use a toy service function with the shape of a writing function.",
  files=[],
  done="`npm test -- -t \"T-C19|T-C18|T-D07\"` passes: a toy function whose second statement hits a 1205 leaves no row, number "
       "or audit row; a deadlock is re-run twice then `JV_BUSY`, and a deliberately wrong lock order (counter first) makes the "
       "harness see deadlocks (the negative control) where the right order sees none; an object parameter is refused; with the "
       "customer row held by another connection for 28 s and 40 calls at once on a pool of 8 every call is `JV_BUSY` within 15 s "
       "and none is answered by the 25-second handler timer; with all 8 connections busy for 30 s one call is `JV_BUSY` in "
       "under 3 s; a call past its deadline at COMMIT is rolled back; a connection killed during COMMIT answers `JV_BUSY` and the "
       "retry (same key, once API14 exists) returns the stored result if it had committed; SIGTERM mid-transaction finishes or "
       "rolls back; a process killed mid-transaction leaves nothing committed and its locks are released; the grep test finds "
       "no `DELETE`, `TRUNCATE` or `DROP` outside the migration runner; on the local ten-box user DELETE, DROP TABLE and "
       "TRUNCATE are refused with error 1142.",
  tripwire=None, rollback=RB)

T("API04", "API", "route() wrapper, permission matrix file, session lookup, generated cell tests",
  agent="A", grp="pure", pd=1.2, deps=["API03"],
  reqs=["A1", "A2", "A4", "A6", "A11", "D2", "S1", "S10"], tests=["T-D01", "T-D02", "T-D08", "T-D10"],
  uses=["A3"],
  do="`src/permissions/matrix.ts` (the one file, one row per read resource, direct edit, service function X1 to X12 and photo call, "
     "with `READ_COLUMNS` and `WRITE_COLUMNS` per role and the public and token lists), `src/permissions/route.ts` (`route()` is "
     "the only way to register an endpoint: session lookup in `sessions` then `users` (D2: the role and the `active` flag only "
     "from that read), then the must-change-password gate, then the matrix row, then body validation, then the handler; a route "
     "without an action fails the build; no handler holds a role string), the public list (`/healthz`, `/readyz`, login, photo "
     "read) and the token routes (`/admin/v1/*`, `/internal/jobs/*`), a 404 for every path not in the matrix (no GraphQL, no "
     "generic table route, no sign-up). `tests/matrix.generated.test.ts` walks every row of A4 (the session calls included) and "
     "every column of `READ_COLUMNS`/`WRITE_COLUMNS` for the five callers (no session, ended session, inactive user, staff, "
     "biller, owner) and fails on any cell that differs from the matrix; rows are added by the task that builds each route "
     "(the generator reads the matrix, so a new row is covered at once). `npm run check:routes` prints every route with its roles.",
  files=[],
  done="`npm test -- -t \"T-D01|T-D02|T-D08|T-D10\"` passes: registering a route without an action fails the build; the route list "
       "is printed; every table has a primary key and InnoDB; a `PATCH`/`PUT` to `/v1/bills`, `/v1/bill_items`, `/v1/receipts` and "
       "`/v1/receipt_allocations` answers 404; a grep finds no role string outside `src/permissions/`; a caller with no session, "
       "an ended or expired session, or a deactivated user gets 401 on every route except the public list (against a fixture "
       "of one user per role); the rights of the local ten-box user contain no Delete, Drop, SUPER or FILE.",
  rollback=RB)

T("API05", "API", "Login, sessions, cookie, me, logout, activity, change-password, password rules",
  agent="A", grp="pure", pd=1.2, deps=["API04", "API06"],
  reqs=["U1", "U4", "U9", "U11", "U12", "A10"], tests=["T-D06", "T-D13", "T-D15", "T-D25", "T-D26"], extends=["T-D02"],
  uses=["D2", "A2"],
  do="`src/auth/password.ts` (Argon2id with `crypto.argon2`: 64 MiB, 3 passes, parallelism 1, at most 2 hashes at once; scrypt "
     "fallback N=2^17, r=8, p=1 with `maxmem` 256 MiB; self-describing hash string; a dummy hash for an unknown e-mail), "
     "`src/auth/session.ts` (32-byte random ticket, only its SHA-256 stored in `sessions`; absolute lifetime 14 days and idle 12 "
     "hours enforced on every call; polling never moves `last_seen_at`, `POST /v1/auth/activity` does; the write of "
     "`last_seen_at` is its own autocommit statement before any money claim; revoked sessions stay as rows; a new ticket at "
     "every login ends the old session), `src/auth/loginRoutes.ts` (`POST /v1/auth/login`, `logout`, `GET /v1/auth/me` with "
     "role and `pricing_sha256`, `activity`, `change-password` which verifies the old one, ends the user's other sessions and "
     "clears `must_change_password`), the cookie `__Host-jv_session` (HttpOnly, Secure, SameSite=Strict, Path=/, Max-Age 14 "
     "days), U9 password rules (10 to 128 characters, a short common-password list, not containing the e-mail local part), "
     "`403 JV_FORBIDDEN` with `details.reason='inactive'` for a correct password on an inactive user. The login-attempt "
     "counters and delays are API08.",
  files=[],
  done="`npm test -- -t \"T-D06|T-D13|T-D15|T-D25|T-D26\"` passes (T-D06 HTTP half: a user cannot change their own role or `active`, no route could): sign-up-looking paths are 404 and a wrong e-mail and a wrong password "
       "give the same `JV_BAD_LOGIN` in about the same time; the cookie has the four attributes and `Max-Age` of 14 days; a new "
       "ticket per login and the old session ended; passwords of 9 and 129 characters, a very common password and one "
       "containing the local part are refused; the stored hash is a self-describing Argon2id string; at most 2 hashes at once; "
       "the scrypt fallback with `maxmem` 256 MiB works and exactly 128 MiB fails; with an injected clock a session ends after 12 h "
       "idle and after 14 days absolute with `401 JV_SESSION_EXPIRED`, polling does not extend it, `activity` does; a "
       "deactivation, a password change and a logout end the session at once; a changed role takes effect at the next call and "
       "a role named in a cookie, header or body has no effect.",
  rollback=RB)

T("API06", "API", "Wire formats: Zod parsers for money and weight strings, limits constants, response formats",
  agent="C", grp="pure", pd=0.9, deps=["API01"],
  reqs=["S3", "S4"], tests=["T-F09", "T-A09"], extends=["T-F02"],
  do="`src/limits.ts` (the one constants file: caps of S4, `cash_limit` 200000, `pan_threshold` 200000, `discount_flag_percent` 10, "
     "`rate_flag_percent` 5; it is generated from `db/limits.json` or compared with it by a test), `src/wire/zod.ts` "
     "(money `^\\d+(\\.\\d{1,2})?$`, weight up to three decimals, no sign, no spaces, no `.5`, no `5.`; a JSON number in a money "
     "or weight field is `JV_INVALID_INPUT`; a trailing zero counts as a decimal; unknown keys refused; caps checked here "
     "and again by the CHECKs; all done BEFORE `pricing.ts` sees a value because its own parsers accept numbers and loose text on "
     "purpose and the file must stay byte-identical), response formatting (money with 2 decimals, weight with 3, ids lower-case "
     "UUID, `created_at`/`updated_at` as UTC text with microseconds that the screen sends back unchanged, business dates "
     "`YYYY-MM-DD` Asia/Kolkata), and the Node-side clause of T-F02: read every CHECK from `information_schema.CHECK_CONSTRAINTS` "
     "and compare each cap literal with `src/limits.ts`. The per-function input schemas are written by the tasks that build "
     "the functions; this task provides the building blocks and the generic rejection tests.",
  files=["db/limits.json"],
  done="`npm test -- -t \"T-F09|T-A09\"` passes for the generic part: JSON numbers and the texts `.5`, `5.`, ` 7.50 `, `+5` are "
       "refused by the Zod layer; `1.230` is refused as a rate or an amount and accepted as a weight while `1.2300` is refused; "
       "an over-cap value (1,000,000,000.01) is `JV_INVALID_INPUT`, never a database error; responses give 2 and 3 decimals; "
       "the T-F02 clause passes (every CHECK cap literal equals the constants file). The T-A09 clauses for bills, payments, "
       "refunds, opening balances, `fine_cash` and the same piece twice are finished by API20, API22, API24, API27, API28 "
       "(each owns its clause).",
  rollback=RB)

T("API07", "API", "CORS, CSRF layers, security headers, nothing leaks, error log with a cap",
  agent="C", grp="pure", pd=0.9, deps=["API04"],
  reqs=["A12", "A14", "D25"], tests=["T-D23", "T-D28"],
  do="`@fastify/cors` with an exact list of origins from `ALLOWED_ORIGINS` (never `*`, no patterns), credentials, methods GET POST "
     "PUT PATCH OPTIONS, request headers `Content-Type`, `Idempotency-Key`, `X-JV-Client`, exposed `Retry-After`, `X-Request-Id`, "
     "`Idempotent-Replay`; three CSRF layers (SameSite=Strict cookie; every state-changing call needs `X-JV-Client: web`; the "
     "`Origin` must equal an allowed origin, a missing or `null` one is refused; failure is `403 JV_CSRF`); helmet headers; "
     "`Cache-Control: no-store` and `X-Request-Id` on data responses (photos excepted); `JV_INTERNAL` carries no SQL, stack or "
     "table name; body limits (1 MiB, photos 2 MiB, 16 KiB elsewhere), unknown JSON keys refused, 30 s to receive a request, "
     "handler timer 25 s (30 s login, 50 s tick) answering `503 JV_BUSY`; `/healthz` and `/readyz` answer only `{ok:true|false}`; "
     "`sys_error_log` writes through `logError` of `scripts/housekeeping.mjs` (MB05: at most 20 rows a minute for each error code, the rest counted inside the last row's `detail`); "
     "log redaction proved with marker strings.",
  files=[],
  done="`npm test -- -t \"T-D23|T-D28\"` passes: a preflight from another origin gets no allow-origin header; a state change without "
       "`X-JV-Client: web` or with a wrong or missing `Origin` is `403 JV_CSRF`; no GET changes state; a preflight from the allowed "
       "origin for PATCH/PUT/POST with the two custom headers is accepted; `JV_INTERNAL` shows no SQL; a body full of marker "
       "strings (a password, a PAN, a mobile number) is absent from the captured log; 1,000 identical errors in a minute write at "
       "most 20 `sys_error_log` rows; `/healthz` answers only `{\"ok\":true}` or `{\"ok\":false}` even when the start-up check fails "
       "for a named reason; the handler timers answer after the work has stopped, never before.",
  rollback=RB)

T("API08", "API", "Login throttles: per-e-mail waits, per-address cap, waiting cap of 30, bounded counters, failure summaries",
  agent="C", grp="money", pd=1.0, deps=["API05", "API07"],
  reqs=["A13", "D24"], tests=["T-D24", "T-D30"],
  do="`src/auth/throttle.ts` over `sys_login_attempts` (counters updated in place, never one row per attempt): the slot is the first "
     "two bytes of SHA-256 of a secret salt, a bar and the lower-cased e-mail or the address (an IPv6 address shortened to its "
     "first 64 bits), modulo 1,024, so the table can never hold more than 2,050 rows; an attempt is counted when the request "
     "arrives by the one atomic `INSERT ... ON DUPLICATE KEY UPDATE` of D24 followed by a plain `SELECT n`; after 5 attempts for "
     "one e-mail in 15 minutes each further attempt waits 1, 2, 4, then 8 seconds before the password is checked, with no "
     "limit on how many wait for one e-mail; 20 attempts a minute per address from `x-real-ip` only (`trustProxy` off; a global "
     "cap of 60 a minute if the address is missing); only the password check counts as busy, at most 2 at once; all waiting "
     "attempts together at most 30, the 31st gets `429 JV_RATE_LIMITED`; a login takes a short checkout for its counter "
     "statements and gives the connection back before it waits or hashes; the failure summary: one `audit_log` event "
     "`login_failures` per hour that had failures (the first failed attempt after the hour changes claims it with a "
     "conditional UPDATE; the housekeeping phase of API33 closes finished hours); the other throttles of A13 (change-password 5 "
     "per 15 min per user, admin door and tick limits, photo upload 30 a minute per user, photo read 600 a minute per address "
     "or a global 120 a second with the ETag map of 5,000 entries and `304` without a database read, everything else 300 a minute "
     "per user) as in-memory counters that restart from zero after a process restart.",
  files=[],
  done="`npm test -- -t \"T-D24|T-D30\"` passes: after 5 attempts the waits are 1, 2, 4, 8 s and survive a restart; 50 parallel "
       "wrong passwords for one e-mail run at most 2 checks at once and none is refused for that e-mail alone; a flood of 500 "
       "unknown e-mails holds a valid login back by no more than its own wait and a few seconds, and attempts beyond 30 waiting "
       "get 429 at once; 21 attempts a minute from one address give 429; two addresses of one /64 count as one; a steady "
       "attack (20 a minute from each of 3 addresses on the owner's e-mail for 10 minutes) still lets a valid login from a "
       "fourth address in within about 12 s; 8 logins in their delay and one payment at the same moment: the payment answers in "
       "under 1 s; 20,000 failed logins for 20,000 invented e-mails plus 2,000 for one e-mail over 50 addresses leave at most "
       "2,050 rows and a second run leaves the same number; 24 hours of attack with an injected clock write at most 24 "
       "`login_failures` events and none for a single attempt; an attack of one hour followed by five quiet hours has its "
       "summary after the next tick; the negative control (the draft-4 per-attempt writer) fails the test; photo reads "
       "above the global cap with an untrusted address are 429, a repeated read with `If-None-Match` of a photo already read "
       "is 304 without a database read, a removed photo is 404 and never 304.",
  rollback=RB)

T("API09", "API", "Admin door and the admin command",
  agent="C", grp="pure", pd=0.9, deps=["API05"],
  reqs=["U3", "U2", "A8"], tests=["T-D27", "T-D20", "T-E09"], uses=["O41"],
  do="`/admin/v1/*` routes that exist only while `JV_ADMIN_TOKEN_HASH` is set (constant-time comparison of the bearer token with "
     "the hash; no CORS headers; any request carrying an `Origin` header refused; throttled: 10 a minute per address, a "
     "15-minute pause after two wrong tokens in a row, a global limit of 5 wrong tokens an hour if the address cannot be "
     "trusted): create user (random temporary password shown once, `must_change_password`), reset password (sets a temporary "
     "password, sets the flag and ends all that user's sessions), change role, deactivate, activate, list, clear the login "
     "counters, record a pull of the backup (`settings.last_pulled`, written by nothing else); every call audited with the "
     "actor `admin-cli`. `npm run admin -- add-user|reset|role|deactivate|activate|clear-counters|record-pull` asks for the "
     "token, e-mail, name and role and prints the temporary password; no SQL and no database password on Harsh's Mac. "
     "The counter clear and the pull record use `clearLoginCounters` and `recordPull` of `scripts/housekeeping.mjs` (MB05). The first owner is made this way; the door is the only way to make an owner or change a role; no route updates `users` "
     "in M1 (PATCH, PUT, POST on `/v1/users` answer 404 for every role).",
  files=["scripts/housekeeping.mjs"],
  done="`npm test -- -t \"T-D27|T-D20|T-E09\"` (HTTP half) passes: the admin routes are 404 while the hash is unset, refuse a "
       "wrong token and any request with an `Origin` header and send no CORS headers; a created user gets a random temporary "
       "password once and can then call only change-password, logout and `me` (`403 JV_PASSWORD_CHANGE_REQUIRED`); an admin "
       "reset ends all sessions at once; the clear call lets a refused login in at once; the pull record is audited; PATCH, "
       "PUT and POST on `/v1/users` and `/v1/users/{id}` answer 404 for all four roles. The DRILL half of T-E09 (Harsh follows "
       "the runbook once for each command) is OPS06.",
  rollback=RB)

T("API10", "API", "Static checks: catalogue, EXPLAIN, dependencies, secrets scan, source checks",
  agent="C", grp="pure", pd=0.8, deps=["API04", "API06"],
  reqs=["A7"], tests=["T-D11", "T-D29"], uses=["U10", "H3", "D19"],
  do="`npm run check:static`: the catalogue test (a primary key, InnoDB and the collation `utf8mb4_unicode_ci` on every table; money "
     "columns `DECIMAL`; no FLOAT/DOUBLE; foreign keys RESTRICT; the named CHECKs of D8, D13 and S4; the list of UNIQUE keys "
     "equals the expected list of D19); the EXPLAIN test (every locking or writing statement and the sync comparison use an "
     "index; the statements are collected by running the suite with a statement log); `npm audit` with no High or Critical "
     "finding; no install script in a runtime dependency; no bound money or weight parameter used in SQL arithmetic, ROUND or "
     "a comparison without `CAST`; every migration file holds only statements of the S9 list; no code opens a connection "
     "outside the pool; `ctx.pause` appears in no production bundle; a scan of every tracked file for URLs with passwords, "
     "`-----BEGIN`, key-shaped strings, `sb_secret_`, `admin123`, `staff123`; `.env` ignored and `.env.example` names only; the "
     "start refuses when a variable is missing; the runtime dependency count is recorded in the report. Run by `npm run verify`.",
  files=[],
  done="`npm test -- -t \"T-D11|T-D29\"` passes; each source check is shown failing on a planted violation (a `DELETE` string, a "
       "bound money parameter in `ROUND`, a table without a primary key in a scratch schema, a planted `-----BEGIN` line) and "
       "passing when removed. The clauses for hook absence in the production bundle (X0 item 8) are finished by API15.",
  rollback=RB)

# =============================================================================================== API: reads and edits
T("API11", "API", "Read side: sync endpoints, combined poll in one snapshot, keyset paging as UUID",
  agent="C", grp="pure", pd=1.3, deps=["API04", "API06", "API07", "MB07"],
  reqs=["C3", "C4"], tests=["T-F03", "T-D16", "T-D17", "T-D03"], extends=["T-D02"], uses=["A9"],
  do="`GET /v1/sync/{resource}?updated_after=&after_key=&limit=` (limit at most 1,000, a constant) and `POST /v1/sync/poll` "
     "(one cursor per readable resource, all resources read inside one `REPEATABLE READ` read-only snapshot, answers carry "
     "`server_time` and the caller's current `role`; a role that may not read a resource gets `403 JV_FORBIDDEN` for the whole "
     "call), ordered by (`updated_at`, key) and paged by `updated_at > ? OR (updated_at = ? AND key > ?)` with the key compared "
     "as its own type (a UUID as a UUID; never `CAST(id AS CHAR) AS id` with `ORDER BY id`), an explicit column list per role "
     "(`READ_COLUMNS`, never `SELECT *`; `bytes` never; `original_net_weight` only for the owner through `sku_private`), the "
     "role sets of C3 (owner: everything except audit_log, check_runs, backup_runs; biller; staff with the seven settings keys), "
     "the key names (`setting_key`, `sku_id`, customer id for balances), `/graphql` and any unknown or internal resource "
     "answering 404, and the first-poll rule (the cursor after a hydrate starts at the first page's `server_time` minus the "
     "30-second overlap). The derived reads that are not sync resources are API12.",
  files=[],
  done="`npm test -- -t \"T-F03|T-D16|T-D17|T-D03\"` passes: 2,500 pieces all arrive through paging, also with the page cap lowered "
       "to 500; 30,000 rows with random version-4 ids paged in 2-row pages come back once each in key order; two rows with the "
       "same `updated_at` at a page edge are both received; a row stamped before and committed after the first page is read still "
       "arrives (a 20-second transaction run directly); one poll never shows a bill without its lines; a sync resource named "
       "`sys_counters`, `sessions`, `sys_idempotency` and the like answers 404 and no response contains `password_hash`; "
       "`/graphql` and `/v1/sync/<unknown>` are refused; staff cannot read `sku_private`, `audit_log`, bills, customers or receipts "
       "and read only the seven settings keys; no response to a biller or staff contains the original weight (read routes; the "
       "function results and the CSV are finished by API16 and WEB12). `EXPLAIN` (API10) shows the (`updated_at`, key) index "
       "in use for every resource.",
  rollback=RB)

T("API12", "API", "Derived reads, customer ledger, daily totals, audit-log, dashboard health route",
  agent="C", grp="pure", pd=1.0, deps=["API11", "MB07"],
  reqs=["A9"], tests=["T-D18"], extends=["T-D04", "T-D02"], uses=["V1", "V2", "V3", "V4", "I12"],
  do="`GET /v1/customers/{id}/ledger` (keyset-paged by the V3 order key, loaded per customer), `GET /v1/daily-totals?from=&to=` "
     "(owner up to 400 days; a biller today and yesterday only, anything longer is `403 JV_FORBIDDEN`), `bill_summary` and "
     "`customer_balances` as sync resources whose `updated_at` is the base row's, `GET /v1/audit-log` (owner, newest first, at "
     "most 200 a page), `GET /v1/health/checks` and `GET /v1/dashboard/health` (owner: `readHealth` of MB03/MB05 in one call). "
     "All through the query files of MB02, never a view. One-customer reads use the correlated form (V1, V2), which the "
     "state read of X0 item 8 also uses (API15). Reading is wide and writing narrow (A9): a biller reads every customer's mobile, "
     "GST and PAN and the whole ledger, as the prototype did, and this is listed for Siddhi (O25).",
  files=["db/queries/V3_customer_ledger.sql"],
  done="`npm test -- -t T-D18` passes: the four derived reads are readable by the owner and a biller and refused to staff and "
       "to no session; a biller's `daily-totals` for more than today and yesterday is 403; the ledger of a fixture customer "
       "equals the hand-computed figures of MB02 (last running balance equals V2's balance); the owner's dashboard line is "
       "returned and a biller's call is 403; `EXPLAIN` shows the indexes used.",
  rollback=RB)

T("API13", "API", "Ordinary edits with the stale check, stamps, person columns, rates and settings rules",
  agent="C", grp="pure", pd=1.3, deps=["API11", "API06", "MB06"],
  reqs=["A5", "D4", "D22", "S6"], tests=["T-C07", "T-D04", "T-D05", "T-D19", "T-D22", "T-F05"], uses=["K4"],
  extends=["T-D14", "T-D02", "T-F09"],
  do="Edits through `PATCH`/`PUT`/`POST` of content columns with only the changed fields and `expected_updated_at` (the exact "
     "text): `UPDATE ... WHERE id = ? AND updated_at = ?`, no row changed means `409 JV_STALE` with the current row in "
     "`details.current`; `WRITE_COLUMNS` per role (a field outside the list `JV_FORBIDDEN`, an unknown field `JV_INVALID_INPUT`, "
     "nothing silently ignored); `skus.status` and `archived_at` change only through X9 (API16); staff cannot change a design's "
     "material, purity or selling method, cannot remove, reorder or replace `photo_ids` (they may add at the end) and "
     "`primary_photo_id` must stay one of them; `selling_method` is locked while the design has a non-archived piece; a "
     "design with non-archived pieces cannot be archived; the weight rules of D7 (O37) on insert and weight change; the "
     "rate rules of D4 (owner any date up to today and a correction of today's row; biller today only, once per material and "
     "purity); settings (owner writes; the generic edit never writes `last_download` or `last_pulled`); categories and "
     "subcategories; customer content columns (biller may edit, only the owner archives; archive needs a zero balance and takes "
     "the customer lock, API15, so T-C20 lives there). Every write stamps `created_at`/`updated_at` from the API clock and "
     "`created_by`/`updated_by`/`set_by`/`confirmed_by` from the session user; a client-sent value is an unknown field. "
     "Every edit counts changed rows and audit rows (T-D14, both modes).",
  files=[],
  done="`npm test -- -t \"T-C07|T-D04|T-D05|T-D19|T-D22|T-F05\"` passes: a stale `updated_at` changes nothing and returns the "
       "current row; `status` and `archived_at` of a piece cannot be edited; staff cannot change material/purity/selling "
       "method; a biller cannot read `sku_private` or `audit_log` and cannot change stock, settings or users; only the owner "
       "writes settings; a biller adds a rate dated today only (yesterday's and tomorrow's are refused); the owner corrects "
       "today's; a `confirmed_by` sent by a client is refused; every read role reads archived rows; staff may set `archived_at` "
       "on a design with no pieces; `created_by` etc. come from the session and are null for the import; `created_at` and "
       "`updated_at` come from the injected clock and move on every update, and a hand edit through phpMyAdmin's own row "
       "editor shows what happens (the runbook rule of B5 applies); for each table written here one insert and one update give "
       "exactly one audit row in both audit modes.",
  rollback=RB)

T("API14", "API", "Numbers and repeat-safety: counters, formats, Idempotency-Key claim, ids",
  agent="A", grp="money", pd=1.0, deps=["API03"],
  reqs=["L3", "L4", "L5", "S2"],
  tests=["T-C01", "T-F07"], ptests=["PT-N1 the claim machinery with a toy function: first request executes, an identical twin in flight returns the stored result with Idempotent-Replay, another actor or another body under the same key is refused, a request that fails the route wrapper never uses up its key"],
  extends=["T-C16", "T-C18", "T-C19"],
  do="`src/db/numbers.ts`: the series is worked out once from the API clock (S5) and used in both steps; the series row is read "
     "first (`SELECT 1 FROM sys_counters WHERE series = ?`, no lock) and `INSERT IGNORE` only when missing, on a checked-out "
     "connection inside the error map (a lock wait there is `JV_BUSY`, not a raw 1205); inside the transaction the number is "
     "`UPDATE sys_counters SET last_value = LAST_INSERT_ID(last_value + 1) WHERE series = ?` read from the OK packet "
     "(`insertId`); `SELECT LAST_INSERT_ID()` is never used; an UPDATE that changes no row is `JV_INTERNAL`; an existing "
     "(imported) number is skipped by `SELECT 1 FROM bills WHERE bill_no = ?` look-ahead, at most 100 times; a duplicate-key "
     "error on a bill number is never caught. Series `bill:<PREFIX>:<YYYY>`, `opening`, `design:<CATEGORY PREFIX>`, "
     "`sku:<design_no>`; formats of L4 (`<prefix>-<YYYY>-<4 digits>` growing after 9,999, `OB-nnnn`, design, piece, barcode; "
     "the year is the Asia/Kolkata year of the save). `src/db/idempotency.ts`: the first statement of every creating function "
     "is the claim INSERT with `args_hash` (SHA-256 of canonical JSON of route, path ids, body and actor id) and a fresh "
     "`claim_token`, read back FOR UPDATE; the token tells who is first; a twin returns the stored result and "
     "`Idempotent-Replay: true` when function, actor and hash match and `JV_INVALID_INPUT` otherwise; the result is stored in the "
     "same transaction; a creating call without `Idempotency-Key` is `JV_INVALID_INPUT`; ids are `crypto.randomUUID()` "
     "(S2). The 90-day emptying of old results is API33.",
  files=[],
  done="`npm test -- -t \"T-C01|T-F07|PT-N1\"` passes: 50 sequential and 10 concurrent numbers are unique and contiguous; a failed "
       "save uses no number; a brand-new series whose first user rolls back while two others wait gives no deadlock; with the "
       "counter row held for 6.5 s the second call answers `JV_BUSY` after 5 s through the error map; the number is the `insertId` "
       "and stays right after an audit row (an AUTO_INCREMENT table) was inserted; an UPDATE that changes no row answers "
       "`JV_INTERNAL`; formats and the Asia/Kolkata year at 23:59:59 on 31 December and 00:00:01 on 1 January are right; "
       "a bill number that already exists is skipped with no duplicate-key error and no next-key lock left (a second connection "
       "inserting into the gap does not wait), and an imported `JV-2026-0007` continues to `0008` (extends T-C16).",
  rollback=RB)

T("API15", "API", "X0 helpers: customer lock, piece locks in MariaDB's id order, counter last, touches, test hook, audit writer",
  agent="A", grp="money", pd=1.1, deps=["API14", "MB06", "API13"],
  reqs=["X0", "D23"], tests=[],
  ptests=["PT-X0 the lock helpers on a toy function: customer lock first; X4/X5/X10 re-read the same customer; pieces taken by ONE `ORDER BY id FOR UPDATE` statement (never sorted in code); counter last; the hook `ctx.pause` exists only in the test build"],
  extends=["T-D14", "T-F11", "T-D29"],
  do="`src/db/locks.ts`: `lockCustomer`, the 'find the customer first without a lock, lock it, re-read and check the SAME customer' "
     "rule of X0 item 3 (a mismatch rolls back with `JV_BUSY`), `lockPieces(ids)` as one statement "
     "`SELECT ... WHERE id IN (...) ORDER BY id FOR UPDATE` (ids are never sorted in code and never locked one at a time; the "
     "native UUID does not sort like its text, which `00000001-...-000000000000` versus `00000000-...-000000000001` shows), "
     "the rule that the number counter is taken last and the contended locks before any row is stamped; `src/db/touch.ts` "
     "(D23: a function that writes `receipts` or `receipt_allocations` also sets `updated_at` on the affected bills and the "
     "customer in the same transaction; a bill insert or status change touches the customer); `src/db/state.ts` (the state read "
     "of X0 item 8 by correlated sub-selects, plus what the change itself re-opens: X4 the bills the voided receipt paid, X5 "
     "and X10 the bill and the receipts allocated to it); the test hook `ctx.pause('<function>.after_read')`, `lock_pieces."
     "between` and `archive_customer.after_check` (one gate per session, test build only, a gate held less than 3 s; the "
     "production bundle contains none); `src/db/audit.ts`, the Node writer of mechanism (b) of L1 used when "
     "`JV_AUDIT_MODE=node`. The reviewer's `rm5-experiments/hook.mjs` and `lib.mjs` show the intended shape.",
  files=[],
  done="`npm test -- -t PT-X0` passes on a toy writing function: with the customer lock in place a second session waits and either "
       "release order gives the right books; with the lock helper replaced by a no-op in the test build the same test fails; "
       "two pieces whose ids sort one way in code and the other in the database are locked by the real helper without a "
       "deadlock in 40 rounds and a helper that sorts in code and locks one at a time deadlocks at least once (the T-C21 control, "
       "run in full by API29); a gate held less than 3 s never causes a lock timeout; the production build contains no `ctx.pause` "
       "(API10's check); the audit writer in node mode produces the same audit rows as the triggers for a toy table (T-D14 "
       "extended: both modes).",
  rollback=RB)

# =============================================================================================== API: stock functions, photos, pricing
T("API16", "API", "Stock functions X8 create_design and X9 set_sku_status",
  agent="A", grp="money", pd=1.2, deps=["API15", "API13"],
  reqs=["X8", "X9", "R1"], tests=["T-C03", "T-C17", "T-F01", "T-A02"], extends=["T-C08", "T-D03", "T-D14", "T-D09"],
  do="`src/stock/x08CreateDesign.ts` (the design id made by the screen, refused if it exists; at most 3 distinct live photo ids, "
     "each with BOTH kinds stored, whose `design_id` is this design's for both kinds, not removed; number `design:<prefix>`; "
     "pieces `sku:<design_no>`, barcode `<prefix>-<sku_no>`, status In Stock, location the first entry of `settings.locations`; "
     "blank semi-wholesale rate takes wholesale then retail and a blank wholesale rate takes retail (R1 (1)); `original_net_"
     "weight` only for the owner (staff sending it gets `JV_FORBIDDEN`); at most 500 pieces per call; skips numbers that "
     "exist) and `x09SetSkuStatus.ts` (any status except Sold; a Sold piece cannot be changed; Archived sets `archived_at` and "
     "leaving it clears it; pieces locked by one statement). Both take no customer lock. Each is a service function "
     "(Idempotency-Key, role check after the claim, audit rows counted, result with every created row). Result bodies never "
     "contain the original weight for staff or billers.",
  files=[],
  done="`npm test -- -t \"T-C03|T-C17|T-F01|T-A02\"` passes: design and piece numbers are never reused after archiving and a "
       "design id from the screen that exists is refused; 500 pieces accepted and 501 refused; the original weight from staff "
       "is `JV_FORBIDDEN`; a Sold piece cannot change; changing a design's material, purity or category changes what every "
       "piece shows; the labour-rate blank chain is as R1 (1) (the screen's chain is the UNIT half and already passes in the "
       "app's `pricing.test.ts`); leaving Archived clears `archived_at` (T-C08 clause); no function result for staff holds "
       "`original_net_weight` (T-D03 clause); one audit row per changed row in both modes; the Idempotency-Key replay works.",
  rollback=RB)

T("API17", "API", "Photos in MariaDB behind PhotoStore: upload, read, owner removal, caps",
  agent="C", grp="pure", pd=1.2, deps=["API16", "API08"],
  reqs=["P1", "P2", "P3", "P7"], tests=["T-D21", "T-F10"], extends=["T-D02"], uses=["P5", "D26", "A5"],
  do="`src/photos/photoStore.ts` (put, get, remove, sizes; one implementation on `design_photos`; the interface a fake second "
     "store also passes), `src/photos/routes.ts`: `PUT /v1/designs/{design_id}/photos/{photo_id}?kind=full|thumb` (owner and staff; "
     "raw body; type from the first bytes: JPEG `FF D8 FF`, PNG `89 50 4E 47`, WebP `RIFF`...`WEBP`; 2 MiB else `413 "
     "JV_PAYLOAD_TOO_LARGE`, non-image `415 JV_UNSUPPORTED_MEDIA_TYPE`; both ids well-formed UUIDs; count of DISTINCT live "
     "photo ids for the design id below 3 in the same statement as the insert; insert-only: a repeated (photo id, kind) pair is "
     "`JV_NOT_ALLOWED` while the thumbnail after the full image is accepted; at most 60 unattached photos or 100 MB, and none "
     "while the size line is red, else `JV_NOT_ALLOWED`; no foreign key to designs), `GET /v1/photos/{photo_id}/full|thumb` "
     "(no session; `Cache-Control: public, max-age=31536000, immutable`, `ETag` = sha256, `nosniff`, "
     "`Cross-Origin-Resource-Policy: cross-origin`; removed means 404) and `POST /v1/photos/{photo_id}/remove` (owner only: "
     "`removed_at` set and `bytes` emptied by UPDATE, audited). No list query selects `bytes`. The caps use `unattachedPhotos` and `insertPhotoGuarded` of `scripts/housekeeping.mjs` (MB05). The attach checks live in X8 "
     "and the design PATCH (API16, API13).",
  files=["scripts/health.mjs"],
  done="`npm test -- -t \"T-D21|T-F10\"` passes: a non-image sent as an image and a 5 MB file are refused; JPEG, PNG, WebP are "
       "recognised by their first bytes; the owner and staff can add, a biller and no session cannot; only the owner removes, a "
       "removal keeps the row, empties the bytes and makes the photo answer 404; an upload for a design id that does not yet "
       "exist is accepted; the 4th photo for one design id is refused; the 61st unattached photo, the 101st megabyte and any "
       "upload while the size line is red are `JV_NOT_ALLOWED`; staff removing, reordering or replacing an id in `photo_ids` is "
       "refused while adding one is accepted; a design with an unknown id, another design's id, an id with one kind, or a removed "
       "id is `JV_INVALID_INPUT` (the X8 clause, API16); `DELETE` has no route; the PhotoStore contract test passes for the "
       "in-database store and a fake; the size line is within 15 percent of the real size after 400 bulk-inserted photo rows.",
  rollback=RB)

T("API18", "API", "pricing.ts copy, quote_bill X7, list prices, rate defaults, versions",
  agent="C", grp="pure", pd=1.3, deps=["API05", "API06", "API10"],
  reqs=["X7", "R2", "R12", "R13", "R14", "C12", "SF3"],
  tests=["T-A01", "T-A04", "T-A05", "T-A07", "T-A08", "T-A11", "T-A13", "T-A14", "T-A16", "T-A18", "T-A19"],
  extends=["T-D09"], uses=["R3", "R4", "R5", "R6", "R7", "R8", "R9"],
  do="Copy `jewelvault-app/src/lib/pricing.ts` BYTE for byte to `src/domain/pricing.ts` with `PRICING-SOURCE.txt` (source commit "
     "9724728 and the SHA-256), `npm run check:pricing -- <path to the app's pricing.ts>`, and the app's `pricing.test.ts` "
     "copied to `tests/pricing.test.ts` so the same unit tests run on the API's copy; `GET /v1/auth/me` returns "
     "`pricing_sha256` (API05 left the field; this task fills it). `src/money/x07QuoteBill.ts` (`POST /v1/bills/quote`, read-only, no "
     "Idempotency-Key, plain SELECTs, no locks): the lines, totals, list prices and warnings `create_bill` will produce, "
     "through the same `priceBill`; the server computes `list_metal_rate` (the daily rate by R2: latest `rate_date` not after "
     "the bill date for the material and purity, else the piece price; `RATE_MISSING`/`RATE_STALE`) and `list_labour_rate` "
     "(never taken from the client; a Per Piece line is compared on price only); a version dispatch table so "
     "`p_pricing_version` selects version 1 and a test-only version 2 is injected for T-A15; versions are stored on the bill "
     "by API20. The independent exact-decimal oracle (`oracle/pricing.ts`, BigInt, and the SQL DECIMAL version of the "
     "spike) checks 200 random inputs.",
  files=["oracle/pricing.ts", "tests/b-decimal-money.test.ts"],
  done="`npm test -- -t \"T-A01|T-A04|T-A05|T-A07|T-A08|T-A11|T-A13|T-A14|T-A16|T-A18|T-A19\"` passes through `quote_bill`: the worked "
       "example gives metal 245,106.40, labour 12,503.26, line 257,611.81, grand total 257,612; wholesale silver By Weight 13.9 g, "
       "labour 40/g gives metal 0, fine 13.900, grand total 556 (also for 925); Per Piece keeps the price; piroi and charges are "
       "added once per line; a discount equal to subtotal plus additional gives 0 and one more is rejected; 4.6 g x 92.50 = "
       "425.50 and grand total 426; an 18K and a 22K piece get their own rates and a backdated bill the rate of that date; "
       "200 lines accepted, 201 rejected; 100,000 g at 100,000,000 is `JV_INVALID_INPUT`, 1,000,000,000.00 accepted and one paisa "
       "more rejected, grand total 1,000,000,000.00 with 0.49 additional accepted and 0.50 refused; twenty hand-calculated "
       "per-line roundings; `check:pricing` fails when one byte of either copy changes; the app's pricing tests pass on the "
       "API's copy; `me` returns the hash; 200 random inputs equal the oracle.",
  rollback=RB)

# =============================================================================================== API: money core
T("API19", "API", "X6 create_customer and the customer archive rule",
  agent="A", grp="money", pd=0.7, deps=["API15", "API13"],
  reqs=["X6", "K4"], tests=["T-C02", "T-F06"], extends=["T-D14", "T-D09"], uses=["D10"],
  do="`src/money/x06CreateCustomer.ts` (owner, biller; never the walk-in; name 1 to 120 characters; mobile required (ten digits, or "
     "`+` and 7 to 15 digits, spaces and dashes removed); customer type default Retail; PAN pattern checked before the "
     "CHECK; Idempotency-Key), the archive path of A5 (owner only: refused while `outstanding`, `fine_outstanding`, `advance` "
     "or `fine_advance` is not zero, taking the customer lock so a payment cannot arrive between the check and the "
     "archive; the walk-in can never be archived; pause point `archive_customer.after_check` in the test build). The "
     "interleaving test T-C20 is API29.",
  files=[],
  done="`npm test -- -t \"T-C02|T-F06\"` passes: no role can delete a customer; archiving is refused while any of the four balance "
       "figures is not zero; category and subcategory names are unique ignoring case; exactly one walk-in exists; a mobile "
       "that is not ten digits or `+` and 7 to 15 digits is refused and a blank one is accepted only with an `import_batch_id`; a "
       "PAN that is not five capital letters, four digits and a capital letter is refused; `create_customer` returns the "
       "customer; the seeds hold no sample data.",
  rollback=RB)

T("API20", "API", "X1 create_bill core without payments",
  agent="A", grp="money", pd=1.4, deps=["API15", "API16", "API18", "API19"],
  reqs=["X1", "K2", "R10", "Y2", "Y8"], tests=["T-A03", "T-A06", "T-A10", "T-A15", "T-A17", "T-C04", "T-C05", "T-C06", "T-C08"],
  extends=["T-A09", "T-D14", "T-D09"], uses=["R6"],
  do="`src/money/x01CreateBill.ts` in the order of X1: claim, role check, customer lock, validation (S4, Y8: a biller uses today "
     "only, the owner any date up to today, a future date refused; R6; modes without `Credit`; each piece once, else "
     "`JV_INVALID_INPUT`), customer exists and not archived, `lockPieces` and R10 (In Stock; Reserved and On Approval only with "
     "the confirm list; anything else `JV_PIECE_UNAVAILABLE` naming the pieces), pricing with R1 to R8 and R14 from the locked "
     "rows and the sent rates through `priceBill` and the bill's `pricing_version`, number counter LAST (after every check), "
     "insert bill (with `cancelled_on` null, `round_off` signed) and lines with the snapshot and list prices, conditional UPDATE "
     "of the pieces to Sold checked against the line count, result `{bill, items, receipts, allocations, warnings, "
     "advance_applied}`. The payment rows, the rebalance and the cash rules are API22/API23/API21, which call into this "
     "function at the points marked (i) and (j); until then the function accepts an empty payment list. Round-off, "
     "`PAN_MISSING`, `RATE_MISSING`, `RATE_STALE` warnings; the walk-in's PAN threshold refusal is API23.",
  files=[],
  done="`npm test -- -t \"T-A03|T-A06|T-A10|T-A15|T-A17|T-C04|T-C05|T-C06|T-C08\"` passes: the bill stores the sale type "
       "it was sent and prices each line with the labour rate it was sent; Per Piece quantity 3 at 1,200 saves metal 3,600.00 with "
       "the quantity on the line and By Weight quantity 2 is rejected; round-off on and off both give a whole-rupee grand "
       "total, 1,000.50 gives 1,001, 1,000.49 gives 1,000 and `round_off` is stored as -0.40 for 1,000.40; `quote_bill` returns "
       "exactly what `create_bill` then stores for version 1 and for the test-only version 2, writes nothing and takes no row "
       "lock (statement log); a missing rate returns `RATE_MISSING`, a stale one `RATE_STALE`, both still save; two concurrent `create_bill` on one piece give one "
       "success, one `JV_PIECE_UNAVAILABLE` and no number used; the same Idempotency-Key twice makes one bill and returns the "
       "same result with `Idempotent-Replay: true`, another caller or another cart under the key is refused; a failed call "
       "leaves no piece Sold and no number used; Repair, Missing, Damaged, Archived, Transferred, Returned and Sold pieces cannot be "
       "billed, Reserved and On Approval only with the confirm list.",
  rollback=RB)

T("API21", "API", "Rebalance (Y3, Y6, Y9) wired into the transaction",
  agent="A", grp="money", pd=0.9, deps=["API20", "MB04"],
  reqs=["Y3", "Y6", "Y9"], tests=["T-B26"], uses=["I10", "IM4"],
  do="`src/domain/rebalance.ts` adopts the database half's `scripts/rebalance.mjs` (`rebalanceCustomer`, MB04: the one copy that "
     "the import and X12 share) as TypeScript on the API's connection, inside the customer lock: oldest first by `bill_date`, "
     "`created_at`, `id`; the caller's named bill first; a rebalance applies at most the customer's `advance` of V2 in total, "
     "oldest receipt first (`paid_on`, `created_at`, `id`), silver grams the same way; opening bills are the oldest by "
     "construction; it never changes an existing allocation. It reads what X0 item 8 says through `state.ts`. The tests of "
     "`tests/schema/s14-rebalance.test.ts` still pass unchanged against the shared library (an API test imports both and compares "
     "on random data). Y3's error cases are API22.",
  files=["scripts/rebalance.mjs", "tests/schema/s14-rebalance.test.ts"],
  done="`npm test -- -t T-B26` passes: after every money function built so far a rebalance never changes an existing allocation "
       "(ids and amounts identical before and after) and leaves I10 true; the API's rebalance and `scripts/rebalance.mjs` give "
       "the same allocations on 300 random customers; a customer with dues and an advance nets off; a handed-back advance is "
       "never spent twice (a refund-then-bill case is finished by API28).",
  rollback=RB)

T("API22", "API", "X2 record_payment (the first money write with two-session tests)",
  agent="A", grp="money", pd=1.0, deps=["API21", "API15"],
  reqs=["X2", "Y1", "Y4", "Y5"], tests=["T-B01", "T-B04", "T-B05", "T-B06", "T-B17", "T-B22", "T-C09"],
  extends=["T-A09", "T-D14", "T-D09"],
  tripwire="TW1: the first money write function with its two-session tests. Measure the elapsed time of API21 + API22 against the plan-days and decide the speed group (see the plan).",
  do="`src/money/x02RecordPayment.ts`: claim, role, customer lock, validation (amount > 0, modes Cash UPI Card Bank Transfer "
     "Other, `paid_on` by Y8, an optional named bill that must belong to the customer, be active and have money pending, else "
     "`JV_INVALID_INPUT`), the receipt, allocation by Y3 (named bill first, then oldest), the remainder kept as an advance and "
     "reported (never lost; for the walk-in a payment above the named bill's pending, or without a named bill, is "
     "`JV_OVERPAYMENT`), touches (D23), rebalance, result `{receipt, allocations, advance_remaining}`. The cash rules are API23. "
     "Pause point `x02.after_read`. T-B17 is introduced here for the walk-in clause of X2 and extended by API24 to API28.",
  files=[],
  done="`npm test -- -t \"T-B01|T-B04|T-B05|T-B06|T-B17|T-B22|T-C09\"` passes: a payment with mode `Credit` is rejected in `record_payment` and by a direct SQL insert (the CHECK of D13); a named bill fills first, then the oldest, then an "
       "advance, and the result reports each part; 'apply to oldest' really allocates and the sum of bill pending equals "
       "the customer's outstanding, an opening-balance bill paid first; a receipt of customer B cannot reach customer A's bill, "
       "even by a direct insert (composite keys), and a named bill of another customer is refused; allocation goes by bill "
       "date, then created time, then id, an advance is applied oldest receipt first, a paid, cancelled or foreign named "
       "bill is `JV_INVALID_INPUT`; the walk-in cannot pay above the named bill's pending or without a named bill; "
       "T-C09 in both release orders (one gate per session): start state one unpaid bill of 1,000, two concurrent payments "
       "of 600 do not apply the same pending twice, and with the customer lock replaced by a no-op the same test FAILS.",
  rollback=RB)

T("API23", "API", "Payment rows inside X1, cash limit, PAN prompt, walk-in rules (section 13)",
  agent="A", grp="money", pd=0.8, deps=["API22"],
  reqs=["Z1", "Z2", "Z3", "Z4", "K5"], tests=["T-A12", "T-B03", "T-B07"], extends=["T-B01", "T-B17", "T-B23"],
  do="X1 steps (e), (i), (j): explicit payments may not exceed `grand_total` (`JV_OVERPAYMENT`), one `money` receipt and one "
     "allocation per payment row dated the bill date (a row of amount 0 is ignored), the rebalance applies any advance and "
     "reports `advance_applied`, X10 later reuses all of it; `src/domain/cashRules.ts`: for a named customer `cash_today` of "
     "one business date (active `money` Cash and `fine_cash` receipts, not opening rows, not reduced by refunds) reaching "
     "`cash_limit` or more raises `JV_CASH_LIMIT` unless the OWNER sends `cash_override_reason` of at least 10 characters "
     "(a biller who sends one gets `JV_FORBIDDEN`), stored on the bill or receipt and audited; for the walk-in a single cash "
     "payment (one record_payment, one `fine_cash`, the cash rows of one bill) of `cash_limit` or more is `JV_CASH_LIMIT` "
     "with the message 'Select or create the customer', and X1 refuses a bill whose `grand_total` is `pan_threshold` or more with "
     "`JV_NOT_ALLOWED` and the same message; `PAN_MISSING` warning at the threshold for a named customer with no PAN; "
     "the walk-in never holds a PAN. Z4: no new printable document.",
  files=[],
  done="`npm test -- -t \"T-A12|T-B03|T-B07|T-B23\"` passes: cash of 1,99,999.99 on a day passes and 2,00,000 raises "
       "`JV_CASH_LIMIT` for a biller; the owner with a 10-character reason saves it and the reason is stored; a bill of 2,00,000 or "
       "more for a customer with no PAN returns `PAN_MISSING`; a walk-in bill of 2,00,000 or more is refused; payments above "
       "the grand total are rejected and nothing is saved, a bill paid by cash and UPI saves two receipts; an advance is applied "
       "automatically to the next bill and the result reports `advance_applied`; the per-day total counts bills, payments and "
       "cash fine together and leaves out voided, refunded and opening amounts; a walk-in single payment at the limit is refused.",
  rollback=RB)

T("API24", "API", "X3 settle_fine (silver and cash)",
  agent="C", grp="money", pd=0.8, deps=["API23"],
  reqs=["X3", "SF1", "SF2"], tests=["T-B11", "T-B12", "T-B13", "T-B23"], extends=["T-A09", "T-D14", "T-D09", "T-B17"],
  do="`src/money/x03SettleFine.ts`: grams > 0 and not more than the customer's fine outstanding else `JV_FINE_EXCEEDS` with the "
     "maximum; mode Silver (`fine_silver` receipt with no mode) or Cash (`fine_cash` with `amount = round(grams x rate, 2)`, "
     "mode Cash, rate required and above 0; an amount of 0.00 is `JV_INVALID_INPUT`); allocation by Y3 (named bill first); the "
     "cash rules apply to `fine_cash`; for the walk-in `bill_id` is required and no more grams than that bill's fine pending "
     "(O52 default); rebalance of silver grams; result the receipt, allocations and the remaining fine. The `fine_cash` amount "
     "is money received (it reaches V4's Cash row) and does not reduce rupees owed.",
  files=[],
  done="`npm test -- -t \"T-B11|T-B12|T-B13|T-B23\"` passes: the cash rules in `record_payment` and `settle_fine` agree (a biller is stopped at the limit and the owner with a reason is not); grams go oldest first and the named bill first, more than the outstanding is "
       "rejected with the maximum; a fine settled in cash is in the Cash total and does not reduce rupees owed; a cash settlement "
       "without a silver rate above 0 is rejected, and so is one whose amount rounds to 0.00; the walk-in without a named bill "
       "or for more grams than that bill's fine pending is refused (T-B17 clause).",
  rollback=RB)

T("API25", "API", "X4 void_receipt and X5 cancel_bill",
  agent="A", grp="money", pd=1.0, deps=["API23"],
  reqs=["X4", "X5", "K3", "Y7"], tests=["T-B08", "T-B09", "T-B10", "T-B16"],
  extends=["T-D14", "T-D09", "T-B17"], uses=["Y8"],
  do="`x04VoidReceipt.ts` (owner; reason at least 3 characters; the receipt must be active else `JV_ALREADY_VOID`; voided with "
     "`voided_at`, `voided_on` (the Asia/Kolkata day from the SAME single clock reading) and the person; its allocations stop "
     "counting; refused with `JV_NOT_ALLOWED` ('void the refund first') when the customer's advance after the void would be "
     "below 0; then rebalance so money waiting as an advance pays a bill the void re-opened) and `x05CancelBill.ts` (owner; "
     "active bill else `JV_BILL_CANCELLED`; an opening bill may be cancelled; for the walk-in a bill with live allocations is "
     "`JV_NOT_ALLOWED`; `cancelled_on` from the same reading as `cancelled_at`; EVERY open allocation of the bill is released "
     "(also those of voided receipts: I3 reads K3 literally); the pieces whose `sold_bill_id` is this bill return to In Stock "
     "by the ids already locked, never by `WHERE sold_bill_id = ?`; receipts stay active; rebalance). Both find the customer "
     "from the receipt or bill without a lock, lock it, re-read and check it is the SAME customer; a second void answers "
     "`JV_ALREADY_VOID` and a void beside a cancel `JV_BILL_CANCELLED`, never a false `JV_BUSY`. Pause points `x04.after_read`, "
     "`x05.after_read`.",
  files=[],
  done="`npm test -- -t \"T-B08|T-B09|T-B10|T-B16\"` passes: voiding a payment restores bill pending and customer outstanding "
       "exactly and the ledger shows a Void row on the day of the void; voiding a silver and a cash fine settlement restores fine "
       "pending exactly; cancelling returns the pieces to In Stock, leaves the bill out of totals, releases its allocations and "
       "keeps its receipts as an advance applied to the other pending bills; a bill saved at 23:30 and one at 00:30 "
       "Asia/Kolkata on the 1st land in the right month; a future date is rejected; a biller cannot back-date and the owner "
       "can; a payment made at 23:50 on 31 December and voided at 00:10 on 1 January (18:40 UTC) is reversed on 1 January and 31 "
       "December stays closed; a bill cancelled at 00:10 on 1 January is cancelled on that day; a walk-in bill with money "
       "received cannot be cancelled until its receipts are voided.",
  rollback=RB)

T("API26", "API", "X10 reissue_bill",
  agent="A", grp="money", pd=1.0, deps=["API25"],
  reqs=["X10", "K1", "K6"], tests=["T-B19", "T-B25"], extends=["T-D14", "T-D09", "T-B17"],
  do="`x10ReissueBill.ts` (owner; the old bill must be active and an `estimate`, else `JV_BILL_CANCELLED`; the customer cannot "
     "change): lock the customer, then the pieces of the old bill and of the new lines in ONE statement over both lists; cancel "
     "the old bill (K3, no rebalance of its own); create the new bill with `reissue_of = p_old_bill_id` by the rules of X1; "
     "rebalance with the NEW bill first so the unallocated money and silver, including what the cancelled bill had received, "
     "go to the new bill before any other bill (oldest receipt first); then record the explicit new payments; the "
     "overpayment check counts what was carried over; for the walk-in a surplus of money over the new bill's total, or of silver "
     "grams over its fine due, is refused (K5: void the receipts first). It reuses API20, API21, API23 and API25 code; the "
     "state read includes the old bill and the receipts allocated to it.",
  files=[],
  done="`npm test -- -t \"T-B19|T-B25\"` passes: the old bill is cancelled and the new one saved in one step; the money received "
       "moves to the new bill with and without older pending bills and is not counted twice; the new bill points back; a second "
       "re-issue of the same bill and a change of customer are refused; in one `create_bill` the Invoice comes before its Payment "
       "rows and a re-issue lists Cancellation, Invoice, Payment in that order, the running balance never going ahead of its "
       "events; the walk-in cases (re-issue Wholesale to Retail, or with fewer grams, leaving a surplus) are refused (T-B17 "
       "clause).",
  rollback=RB)

T("API27", "API", "X12 add_opening_balance",
  agent="C", grp="money", pd=0.6, deps=["API25", "MB04"],
  reqs=["X12", "IM5"], tests=["T-B21"], extends=["T-D14", "T-D09", "T-B17", "T-C16", "T-A09"],
  do="`x12AddOpeningBalance.ts` (owner; dues, fine due, advance and fine advance all at least 0 and not all 0; refused advance "
     "for the walk-in): under the customer lock creates the `opening_balance` bill when dues or fine due are above 0 (number "
     "`OB-nnnn`, no lines, dated `p_as_of`) and an `is_opening` receipt for each advance (money with mode Other, or "
     "`fine_silver`), then the shared rebalance (an advance and dues of one customer net off). Opening rows are not sales, not "
     "money received today and not counted by the cash limit; a wrong figure is fixed by cancelling the opening bill (X5) and "
     "adding a new one, a wrong opening advance by voiding it (X4).",
  files=[],
  done="`npm test -- -t T-B21` passes: dues and fine become an `OB-` bill, an advance an `is_opening` receipt; they are paid first, "
       "net off, and are left out of sales, daily cash and the cash limit; a wrong figure is fixed by cancelling and adding a "
       "new one; one X12 call with a money advance and a silver advance saves two receipts; voiding an opening advance leaves "
       "V4 unchanged; after an import, an X12 call and a `create_bill` keep I5 green and I10 holds for a customer given both "
       "dues and an advance (the T-C16 clause).",
  rollback=RB)

T("API28", "API", "X11 issue_refund (first to leave if the calendar slips)",
  agent="C", grp="money", pd=0.4, deps=["API25"],
  reqs=["X11", "Y10"], tests=["T-B20"], extends=["T-D14", "T-D09", "T-A09"],
  do="`x11IssueRefund.ts` (owner; amount above 0 and not more than the customer's current advance, a mode, a date by Y8): under "
     "the customer lock inserts the `refund` receipt (no allocations), rebalance with nothing to apply, result the receipt and "
     "the new advance. It appears in the ledger as a debit and in V4 as money out on its own date. Voiding a refund (X4) "
     "restores the advance. Pause point `x11.after_read`. Cutting this task removes only this file, its route row and its form "
     "(WEB11).",
  files=[],
  done="`npm test -- -t T-B20` passes: a refund above the advance is refused; it shows as money out on its own date in V4 and as "
       "a debit in V3 and reduces the advance; voiding it restores the advance; after a cancel the advance can be refunded; "
       "advance 2,000, refund 500, then a bill of 1,800 left unpaid gives pending 300 and advance 0 (the money handed back is "
       "not spent twice); voiding the 2,000 payment after the refund is refused until the refund is voided.",
  rollback=RB)

T("API29", "API", "Two-session interleavings with the test hook (T-C10 to T-C14, T-C20, T-C21)",
  agent="A", grp="money", pd=1.0, deps=["API26", "API27", "API28", "API24", "API19"],
  reqs=[], tests=["T-C10", "T-C11", "T-C12", "T-C13", "T-C14", "T-C20", "T-C21"],
  do="One DB2 test per spec test with the hook machinery of API15: one gate per session, held less than 3 s, both release "
     "orders, each test naming its START STATE and each with a variant where the customer-lock helper is a no-op in the "
     "test build and the same test must fail (T-C10 an advance of 300 with `create_bill` 400 beside `record_payment` 500; "
     "T-C11 an advance of 300 with `create_bill` 400 beside `issue_refund` 300; T-C12 (a) a paid bill, void beside payment, (b) "
     "the same plus a spare advance, void beside `create_bill`, (c) two voids of one receipt at once: one success and one "
     "`JV_ALREADY_VOID`, never `JV_BUSY`; T-C13 (a) cancel beside create, (b) cancel beside payment, (c) re-issue beside payment; "
     "T-C14 two identical requests in flight, the first held under 3 s: one executes, the second returns the stored result; "
     "held for 6.5 s the second is `JV_BUSY` after 5 s and its retry returns the stored result; T-C20 archive beside a "
     "payment; T-C21 `reissue_bill` with a helper that sorts in code and locks one piece at a time, a pause of 60 ms between "
     "its two locks and `create_bill` started 10 ms after: at least one 1213 in 40 rounds, none with the real helper). "
     "Every suite runs three times in a row before it counts; waits use the lock timeout, never sleeps. The reviewer's "
     "`rm5-experiments/conc.mjs`, `hook.mjs` and `e_c21.mjs` are the reference.",
  files=[],
  done="`for i in 1 2 3; do npm test -- -t \"T-C10|T-C11|T-C12|T-C13|T-C14|T-C20|T-C21\"; done` is green three times in a row; "
       "with the customer-lock helper replaced by a no-op in the test build T-C09 to T-C13 and T-C20 each FAIL (the negative "
       "controls, run once and logged); T-C21's control shows a 1213 and the real helper none.",
  rollback=RB)

T("API30", "API", "Lock timeout, statement timeout and the stress run (T-C15)",
  agent="A", grp="money", pd=0.7, deps=["API29"],
  reqs=[], tests=["T-C15"],
  do="A lock held more than 5 s by another connection raises `JV_BUSY` (503 with `Retry-After`) and changes nothing; a statement "
     "past `max_statement_time` (1969) does the same; the retry with the same Idempotency-Key then succeeds; a stress run of 8 "
     "connections and 200 mixed calls (bills, payments, fine, voids, cancels, re-issues, refunds) over 3 customers (the walk-in "
     "among them) and 12 pieces. Uses the pool of 8 and the paced connect.",
  files=[],
  done="`npm test -- -t T-C15` passes three times in a row with 0 deadlocks (1213) and I1 to I10 true after each run.",
  rollback=RB)

T("API31", "API", "Random sequences (three seeds), function-by-role matrix, mutation check of the net",
  agent="C", grp="money", pd=1.2, deps=["API26", "API27", "API28", "API24", "API33"],
  reqs=["I9"], tests=["T-B14", "T-D09"],
  do="`tests/sequences.test.ts`: random sequences of 200 operations for three seeds (bills paid, part paid and unpaid; "
     "named-bill and oldest-first payments; fine in silver and in cash; voids of every receipt kind; cancels; re-issues; "
     "refunds; opening balances; owner back-dated entries; the walk-in; clock jumps over midnight and New Year), after every "
     "operation `runInvariants()` (I1 to I7, I10, I13) and the ledger's last balance equal to the customer's balance; a "
     "generated function matrix for X1 to X12 and the five callers (no session none; staff only X8 and X9; a biller X1, X2, X3, "
     "X6, X7 but not X4, X5, X10, X11, X12; the owner all) with the field rules (a biller's cash override `JV_FORBIDDEN`, a past "
     "date from a biller `JV_INVALID_INPUT`, `original_net_weight` from staff `JV_FORBIDDEN`). The reviewer's `seq.mjs` and "
     "`inv.mjs` in `rm5-experiments` are the starting point; the oracle recomputes balances from the base tables.",
  files=[],
  done="`npm test -- -t \"T-B14|T-D09\"` passes for seeds 1, 2 and 3 (and a fourth seed run once and logged); with one money rule "
       "broken on purpose (the mutations of the review task RV2: a rebalance that changes an old allocation, a cancel that "
       "forgets a voided receipt's allocation, a void that uses `paid_on` for the day) at least one invariant or test fails each "
       "time.",
  rollback=RB)

# =============================================================================================== API: jobs, health, backups
T("API32", "API", "Invariants in Node (I6, I11), the nightly check, review line, check_runs",
  agent="C", grp="money", pd=1.2, deps=["API25", "API18"],
  reqs=["I6", "I11"], tests=["T-B18", "T-B24"], uses=["I8"],
  do="`src/jobs/nightly.ts` runs `runInvariants()` of MB02 in one REPEATABLE READ snapshot INSIDE one request (not sliced), "
     "completes I6 in Node (every stored line equals a fresh `priceLine` of the pinned `pricing_version` over the stored "
     "snapshot; `grand_total` and `round_off` as I6 says) and builds the I11 review line for the previous business day (lines "
     "sold below the server's list prices, discount above `discount_flag_percent`, cash overrides, cancellations, re-issues, "
     "voids, refunds, the walk-in's cash total and bill count, `fine_cash` settlements more than `rate_flag_percent` from every "
     "Silver rate of that day, biller rates that moved more than that percent, sale type different from the customer's), "
     "writes a `check_runs` row (`ok`, and `details` with the count per invariant and at most 20 sample rows each, the review "
     "counts); the owner can open each list (up to 50 rows). It never turns the check red because of I11.",
  files=["scripts/invariants.mjs"],
  done="`npm test -- -t \"T-B18|T-B24\"` passes: for each of I1 to I7, I10 one damaged row makes the nightly check name that "
       "invariant and row (the mutation tests of MB02 run through the API's job), I13 fires on an injected old V4 query, I6 on a "
       "line changed by 1 paisa, with no damage the result is empty; the job writes a `check_runs` row with `ok = false` and the "
       "details; list prices come from the server not the client, and a line sold below list, a discount above 10 percent, the "
       "walk-in's cash total and bill count, a `fine_cash` rate more than 5 percent from the day's Silver rates, a bill whose sale "
       "type differs from the customer's, and a biller's rate that moved more than 5 percent all appear in the review line; a "
       "Per Piece line is compared on its price only.",
  rollback=RB)

T("API33", "API", "The hourly tick: phases, one run at a time, housekeeping, photo-copy slices, job health",
  agent="A", grp="money", pd=1.2, deps=["API32", "API09"],
  reqs=["I8", "L6"], tests=["T-R04"], extends=["T-C05", "T-D30"],
  do="`POST /internal/jobs/tick` (bearer token, only its hash in the environment; throttled; no CORS headers; refuses an `Origin` "
     "header; handler timer 50 s; statement limit 20 s). It takes one pool connection and the lock with `withJobLock` of `scripts/housekeeping.mjs` (MB06: `GET_LOCK('jv_tick:<database>', 0)`, a lock name is "
     "server-wide in MariaDB so it carries the database name), answers 'already running' at once if taken, "
     "releases it in a `finally` and destroys the connection instead of returning it if anything throws (the helper marks `destroyConnection`). Phases "
     "(`sys_job_runs`, unique on `job` and `run_date` = the Asia/Kolkata business date, retry by UPDATE: `failed` goes back to "
     "`running`, a `running` row older than 10 minutes counts as abandoned): `nightly_check` (API32), the heartbeat, "
     "`housekeeping` (L6: empty `result` of `sys_idempotency` rows older than 90 days, after which a repeat of such a key is "
     "refused; close finished login-failure hours, a function that does not yet exist in the database half: D24's conditional UPDATE "
     "claims the summary and one `login_failures` audit event is written) and `photo_copy` in slices that stop starting new work after 25 s. A phase "
     "is due when it is not `ok` for today's date and, for the nightly work, it is after 02:00 Asia/Kolkata. "
     "`GET /internal/jobs/health` answers 503 when the last good export is older than 26 hours or the owner's last Download "
     "everything is more than 35 days old. `.github/workflows/jobs.yml` calls both endpoints on a schedule (the secret is "
     "Harsh's, OPS02).",
  files=[],
  done="`npm test -- -t T-R04` passes: the nightly check and photo copy run once for a business date and not before 02:00 "
       "Asia/Kolkata, a second call the same day answers 'already done', a `running` row older than 10 minutes is run again; a "
       "second tick while one runs answers 'already running', a second tick after the first has ended runs, two apps on two "
       "databases of one server both run, and a tick that throws destroys its connection and releases its lock; the endpoint "
       "refuses a missing or wrong token and any request with an `Origin` header; the photo-copy slices stop starting work "
       "after 25 s and a phase's `ok` is written only when it is complete; `jobs/health` answers 503 on a stale export and on a "
       "download older than 35 days; `GET_LOCK` runs on a pooled connection of the ten-box user; T-C05's clause (a result "
       "older than 90 days is emptied and its key refused) passes; the housekeeping closes the summary of a finished hour "
       "(T-D30 clause). The curl-from-cron half is OPS03.",
  rollback=RB)

T("API34", "API", "The nightly dump script: due logic, locks, run records, pruning call, photo copy writer, BACKUP-RESTORE.md",
  agent="C", grp="money", pd=1.0, deps=["API33", "MB07"],
  reqs=["B2"], tests=["T-R03"], uses=["I8", "D17", "D25"],
  do="`scripts/job.js dump`, started every hour by a Custom cron job whose command is the one hPanel generated (the app's Node 24 "
     "binary, `--env-file` of the deployment's environment, the script of the current build; **the Custom command field takes at most 255 characters** "
     "and this command is 161 plus twice the site folder name plus the mode word, so it does not fit for a site name of about 45 characters or more: then "
     "a wrapper script in the home folder, or `job.js` reading `hbuilds/config/.env` itself, and no `> /dev/null 2>&1`): it reads `JV_BACKUP_DIR` through "
     "`resolveBackupDir` and `BACKUP_PUBLIC_KEY` through `loadPublicKey` (both of the database half, MB05), decides what is due "
     "(it ends at once when today's `db_dump` is `ok` in `sys_job_runs`, or it is before 02:00 Asia/Kolkata), takes "
     "the lock with `withJobLock` of `scripts/housekeeping.mjs` (`jv_dump:<database>`, released in a `finally`), opens its OWN pool of ONE connection through "
     "the pacer with `wait_timeout` 300, runs `writeDailyExport` with `exportDatabase` as ONE snapshot (never sliced; the "
     "retry rule, the run-specific name, `.partial`/`fsync`/`link()`, the monthly link and the `.partial` sweep are inside the "
     "database half's function and are NOT rewritten), records the run with `recordBackupRun` (`ok` only for a complete phase, "
     "with the counts, `folderStats` and the sha256 recorded BEFORE the link, in `detail.export = {name, sha256, size}` and `detail.folder = {files, bytes, free_bytes}`; **`statfs` shows the whole server's volume (9.9 TB free), not the plan's 50 GB, so the free-disk figure is the folder size against a stated budget, not `statfs`**), calls `prune` (which refuses without a good write tonight "
     "or with fewer files than the last recorded count, and does a dry run first), and raises the alerts it returns into "
     "`sys_error_log` with `logError`. The once-only photo copy writer (`directoryPhotos` over `JV_BACKUP_DIR/photos`, compared "
     "by size and sha256 when the name exists, never overwritten, recorded in `sys_photo_copies` only after a `stat`) is called "
     "by the tick's slices (API33). The docs are already rewritten (MB06).",
  files=["scripts/backup-folder.mjs", "scripts/export-file.mjs", "scripts/pacing.mjs", "BACKUP-RESTORE.md"],
  done="`npm test -- -t T-R03` passes on a temporary folder with a test key pair: the dump decrypts with the private key (via `unpackExport`) "
       "and its row counts equal the manifest; a photo is copied once and a second run copies nothing and records an `ok` 'nothing new' run; "
       "a size mismatch on the `stat` check is not recorded; after 40 failed nights nothing is deleted and the newest 30 and 13 files "
       "stay whatever their age; after a good night the 31st daily file goes after a logged dry run; pruning refuses a folder with fewer "
       "files than the last recorded count; a crash between the linking and the `ok` row is repaired on the retry; `.partial` files "
       "older than an hour are swept; the dump cut halfway leaves no final file and no `ok`; the dashboard goes red after 26 hours without "
       "a good export or photo copy and when the file count falls without a prune; two `job.js dump` started together run once. The "
       "hPanel half (the folder survives a redeploy, is not reachable over HTTP, the cron command runs) is T-R01 in OPS05 and OPS02.",
  rollback=RB)

T("API35", "API", "Download-everything record route, last_download and last_pulled, the health card figures",
  agent="C", grp="pure", pd=0.9, deps=["API12", "API09", "MB07"],
  reqs=["B3"], tests=["T-R05", "T-R06"], uses=["I12", "O53", "O54"],
  do="`POST /v1/owner/download-record` (owner only; no Idempotency-Key): the screen sends the date and the row count of every "
     "file; the API accepts them only if every count equals the database's count of that table, give or take the rows made in "
     "the last two minutes, and stores `{at, by, counts}` in `settings.last_download` (one audit row); non-matching counts are "
     "`JV_INVALID_INPUT` and change nothing; the generic settings edit cannot write `last_download` or `last_pulled`; the "
     "dashboard card and the health line count whole Asia/Kolkata days from `settings.last_download` or the oldest "
     "`check_runs` row (amber at 28 or more, red above 35) and show 'last pulled' (amber after 10 days, from the admin "
     "door's record). The CSV zip itself is built in the browser (WEB12); this task owns the server side and the figures.",
  files=[],
  done="`npm test -- -t \"T-R05|T-R06\"` (db and HTTP halves) passes: the record route accepts matching counts and stores "
       "`last_download` (one audit row), refuses an empty zip or a missing file with `JV_INVALID_INPUT` and changes nothing, and is "
       "refused to every caller but the owner; the generic settings edit cannot write `last_download` or `last_pulled`; with an "
       "injected clock day 27 is green, 28 and 35 amber, 36 red, and with no download at all the same counts run from the "
       "first night the system ran; a new download clears both; `jobs/health` answers 503 at day 36; the admin door records a "
       "pull (audited) and no other caller can; the dashboard shows 'last pulled' and turns amber 10 days after it (and 10 days "
       "after the first export when there is no pull). The zip clause and the drills are WEB12 and OPS05.",
  rollback=RB)

T("API36", "API", "Restore and pull tool for Harsh's Mac (SFTP source, decrypt, drill harness)",
  agent="C", grp="pure", pd=1.0, deps=["API34", "MB03"],
  reqs=["B4"], tests=[],
  do="`scripts/restore-cli.mjs`: a `Source` over SFTP (port 65002, Harsh's own login, no secret of the app) or a local folder, a "
     "`PhotoStore` over `photos/`, decryption with the private key file by `unpackExport` of the database half (never on the server or in the repository), then "
     "`restoreDatabase` of MB03 against an EMPTY database (a database with tables is refused); pacing of at most 10 new "
     "connections in 1.2 s; it prints the report (row counts against the manifest, photo sha256 values, missing photos listed "
     "and tombstoned, the nightly check on the copy) and starts the throw-away Docker MariaDB 11.8 for drill 1 itself. A second "
     "command pulls the newest `daily/` file (monthly: `monthly/` and the new photos), checks the sha256 of each against "
     "`backup_runs.detail` and `sys_photo_copies`, and reports the pull through the admin door (`npm run admin -- record-pull`). "
     "The 'rebuild each customer's balance from the zip alone' script (`scripts/zip-balances.mjs`) belongs here too.",
  files=["scripts/restore.mjs"],
  done="`npm test -- -t PT-R1` (a plan test) passes locally: a full cycle on a lane database (export with API34's script, "
       "encrypt, restore through the CLI from a local folder into a second empty lane database) gives equal row counts and "
       "photo hashes, refuses a non-empty target, lists a deliberately removed photo as missing and inserts its row as a "
       "tombstone, and fails with a clear message with a wrong private key; the pull command verifies hashes. The SFTP path "
       "and the drills are run against the real plan by OPS05.",
  ptests=["PT-R1 restore CLI round trip on lane databases"],
  rollback=RB)
