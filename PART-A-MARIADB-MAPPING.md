# Spec Part A on MariaDB: what cannot be done as written, and what replaces it

Step 2 of the database task. Date: Thursday 15 October 2026. Spec read: `jewelvault-app/specs/p1-foundation-and-money/spec.md` sections 1 to 7 (S1 to S10, D1 to D23, A1 to A11, U1 to U10, P1 to P6, L1 to L6, C1 to C18, B1 to B6, H1 to H6, IM1 to IM8), plus the Part A tests (D, E, F, R) and the Part B items that touch Part A (X0, I8, I12). Part B money rules X1 to X12, V1 to V4, I1 to I13, Z1 to Z3 are database-neutral and not discussed here, except where their *mechanism* is Postgres (security definer, pg_cron).

Evidence: 15 tests in `tests/g-parta-replacements.test.ts` and 5 in `tests/h-hostinger-facts.test.ts` (MariaDB 11.8.9, local), the step-1 spike (`SPIKE-REPORT.md`), the MariaDB docs, Hostinger's public docs (links in section 6) and, since 15 Oct, Hostinger's own values read from Harsh's account (`HOSTINGER-FACTS.md`). Every verdict below says which.

## 0. The one change that explains most of it

The spec assumes **the browser talks to the database directly** (Supabase: the browser calls PostgREST and Auth; row-level security, grants and security-definer functions are the wall). On Hostinger there is a **Node.js API between the browser and MariaDB**, and the database is reachable only from that API (credentials live in Hostinger's environment variables). So:

- Every rule whose job was "stop a hostile browser from reaching a table" (RLS, `anon`/`authenticated` grants, exposed schemas, GraphQL, advisor lints) moves into **the Node API**: a route is the only door, and each route lists the roles that may use it and the fields it returns or accepts.
- The database keeps what a database does well: types, `CHECK`, foreign keys, unique keys, locks, the counter, and (if Hostinger allows triggers) a few safety nets.
- Authentication, sessions and photo storage were Supabase services. They become Node code plus one storage choice (section 3).

Weakness to say plainly: with one MariaDB user, **the database itself can no longer tell a biller from an owner**; the wall is the API code and its tests. Harsh's phpMyAdmin access is a second door that bypasses the API (it already was, for the database owner, in the old design).

## 1. Verdict table

Legend: **OK** = works as written; **CHANGE** = same idea, different mechanism; **GONE** = the rule has nothing to protect any more; **NODE** = moves to the API code; **UNKNOWN** = depends on a Hostinger setting not yet read (list in section 5).

### Conventions (S1 to S10)

| Rule | Verdict | What replaces it | Evidence |
|---|---|---|---|
| S1 `public`/`private` schemas, `api.schemas` | GONE | No exposed schema exists. One database; the API's route list is the surface. Internal tables get a `sys_` prefix (`sys_counters`, `sys_idempotency`, `sys_import_batches`) so they are never confused with business tables. `private.limits` becomes a constant file in Node | design |
| S2 uuid, `gen_random_uuid()` | CHANGE | Native `UUID` column type; ids made by `crypto.randomUUID()` (v4) in Node; the screen still makes a design id (P2). Use **one** id type everywhere (a FK from `UUID` to `CHAR(36)` is refused) | tests d2 |
| S3 `numeric(14,2)` etc. | OK | `DECIMAL(14,2)`, `(12,3)`, `(12,2)`; money crosses the wire as text | b (2,546 bills vs oracle) |
| S4 caps in `CHECK`, "more decimals than the column is refused", `private.limits` | CHANGE | Caps and signs stay as named `CHECK`s (error 4025). **"More decimals than the column" must be refused by Node**: MariaDB rounds `1.239` to `1.24` without any error and a CHECK sees the rounded value. A non-strict session clamps over-range amounts silently, so every connection sets a strict `sql_mode`. A CHECK cannot contain a subquery or `CURDATE()` (stricter than Postgres). T-F02's comparison becomes: Node reads the CHECK literals from `information_schema.CHECK_CONSTRAINTS` and compares them with its constant file | b, d1 |
| S5 time zone, `private.now_ts()` clock seam | CHANGE | Store `DATETIME(6)` in UTC (session `time_zone = '+00:00'`); compute the business date `Asia/Kolkata` in Node; Node has an injectable clock (the test seam). MariaDB `NOW()` is fixed per *statement*, `SYSDATE(6)` is the real clock | d5 |
| S6 `created_at`/`updated_at`, triggers | CHANGE | `DEFAULT CURRENT_TIMESTAMP(6)` and `ON UPDATE CURRENT_TIMESTAMP(6)` do it natively. Where a test must fake the clock, Node sends the timestamp explicitly. Columns naming a person are set by Node from the session user (a client value is never read) | d5, g |
| S7 no `DELETE` for the API role | CHANGE (**solved in hPanel**) | hPanel's *Change Permissions* for the database user has 18 tick boxes including **Delete**, **Drop** and **Trigger** (read 15 Oct). Untick **Delete and Drop** on the JewelVault user: DELETE, DROP TABLE and TRUNCATE are then refused (tested locally with exactly that grant list, error 1142). Schema changes keep Alter/Create/Index/References ticked. The app user cannot narrow itself in SQL (REVOKE gives 1044, CREATE USER 1227), so it is done in hPanel once. Extra net: Node never emits `DELETE` (a test greps the code) and foreign keys stay `RESTRICT` | g, h, HOSTINGER-FACTS.md |
| S8 `RAISE EXCEPTION 'JV_...'`, 55P03, 40P01, 23505 | CHANGE | Node throws `JV_*` errors that become HTTP 4xx JSON. Database errors: 1205 (lock timeout), 1213 (deadlock), 1062 (duplicate key). **Rollback first, then retry once with the same request id** (1205 rolls back only the statement) | a, e |
| S9 forward-only migrations, "re-runnable" | CHANGE | Plain `.sql` files plus a small Node runner and a `schema_migrations` table. **MariaDB DDL is not transactional** (implicit commit; a rolled-back `CREATE TABLE` stays), so each file must be re-runnable: `CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS` (all tested) | g |
| S10 `private.app_role()` | NODE | A `requireRole([...])` middleware reading the role from the `users` table on every request | design |

### Data model (D1 to D23)

| Rule | Verdict | What replaces it | Evidence |
|---|---|---|---|
| D1 `profiles` FK to `auth.users`, trigger on sign-up | CHANGE | One `users` table: `id`, `email` (unique), `password_hash`, `full_name`, `role`, `active`, created/updated stamps. No trigger on a login table. A new user is inactive until activated (U3) | design |
| D2 `private.app_role()` security definer | NODE | see S10 | |
| D3 `settings(key, value jsonb)` | CHANGE | `settings(setting_key, value JSON)`: **`key` is a reserved word** and fails unquoted (same for `lines`, `rows`, `order`, `range`, `read`, `write`, `release`, `usage`, `condition`, `interval`). JSON is `LONGTEXT` + `JSON_VALID`; written with `JSON.stringify`, read back as an object | d5, g |
| D4 `daily_rates` (policy `WITH CHECK rate_date = today`) | CHANGE | The "biller: today only, once per material+purity" rule is a Node check; unique key on (`rate_date`, `material`, `purity`) stays | d1 |
| D5 categories (unique ignoring case) | OK | `utf8mb4_unicode_ci` unique is case-insensitive; trailing spaces also collide (trim in Node) | d2 |
| D6 `designs` (`text[]`, material CHECK, trigger on `selling_method`) | CHANGE | `tags`, `image_paths` become `JSON` with `CHECK (JSON_TYPE(col) = 'ARRAY')`; the `selling_method` lock while pieces exist is a Node rule (a trigger is optional) | d3 |
| D7 `skus` weight rules (trigger) | CHANGE | "NW not above gross when gross > 0" and non-negative caps can be a row `CHECK`. But O37 says the rule runs **only on insert and on a weight change, never on a status change**; a `CHECK` runs on every update and would block a status change on an imported row that already breaks it. So it is a Node rule (or a trigger with `UPDATE OF`-style logic comparing OLD and NEW) | d1 |
| D8 status list and the two ties | OK | Named `CHECK`s, tested: `(status='Sold') = (sold_bill_id IS NOT NULL)`, `(status='Archived') = (archived_at IS NOT NULL)` | d1 |
| D9 `sku_private` | CHANGE | Still a separate table, but "only the owner can read it" is now an API rule: no route returns it except the owner-only one | design |
| D10 `customers`: partial unique index (one walk-in), PAN/mobile CHECKs | CHANGE | No partial indexes. **A generated column + UNIQUE** gives the same result: `walkin_key TINYINT AS (IF(is_walkin=1,1,NULL)) PERSISTENT` + `UNIQUE` (tested; safe because `is_walkin` never changes). **TRAP:** a `REGEXP` CHECK is case-insensitive on the default collation, so `abcde1234f` passes a PAN rule written with `[A-Z]`; write `BINARY pan REGEXP '^[A-Z]{5}[0-9]{4}[A-Z]$'` (tested) | d4, g |
| D11 to D15 bills, items, receipts, allocations, opening rows | OK | Plain tables with FKs (`ON DELETE RESTRICT`), composite FKs (receipt_id, customer_id), CHECKs, `UUID` ids. "No API role can insert a bill directly" is automatic: only service functions exist | d1 |
| D16 `audit_log` with `to_jsonb(old/new)`, written by a trigger | CHANGE | MariaDB has no `row_to_json`. Two options: **(1) generated triggers** (one INSERT and one UPDATE trigger per audited table, generated from the column list, in `tests/audit-gen.ts`; tested: actor from `@jv_actor`, role `import` when none, no row for an `updated_at`-only change, DECIMAL kept as exact text, JSON columns nested; a test compares the generated column list with `information_schema`). The privilege exists (the *Trigger* tick box) and `log_bin` is OFF on Hostinger, so it should work without SUPER; **proved only when the first trigger is created in the new database** (HOSTINGER-FACTS.md section 4). **(2)** Node writes the audit row in the same transaction through one helper (works anywhere; misses edits made by hand in phpMyAdmin). Recommendation: (1), with (2) as the fallback if the trigger test fails | g |
| D17 `check_runs`, `backup_runs` | OK | Plain tables, owner-only route | |
| D18 `private.counters`, `idempotency`, `limits`, `import_batches` | CHANGE | `sys_counters`, `sys_idempotency`, `sys_import_batches`; `limits` becomes Node config (CHECK literals must equal it, tested by reading the catalogue) | e, f |
| D19 indexes | OK | MariaDB creates an index for every foreign key by itself (tested), so "unindexed foreign key" cannot happen. Keyset index `(updated_at, id)` works. **New rule from the spike:** every `UPDATE`/`DELETE`/`SELECT ... FOR UPDATE` must use an index (a scan on `sold_bill_id` gave 12 to 32 deadlocks per 1,200 operations); an `EXPLAIN` test enforces it | e |
| D20 seeds, no sample data | OK | | |
| D21 `import_batch_id` | OK | | |
| D22 forced person columns (trigger from `auth.uid()`) | NODE (+ optional trigger) | Node sets `created_by`/`updated_by`/`set_by`/`confirmed_by` from the session user and never reads them from the request. A `BEFORE INSERT/UPDATE` trigger using `@jv_actor` also works (tested, including "a client-sent `created_by` is ignored") if triggers are allowed. **Trap:** `@jv_actor` lives on the pooled connection and survives COMMIT, so set it at the start of each transaction and clear it at the end | g |
| D23 touch triggers (receipt changes stamp the bill and customer) | CHANGE | One explicit `UPDATE ... SET updated_at = ?` inside the same transaction, under the customer lock the function already holds (a trigger version works too: tested, but it hides a lock; a trigger cannot update its own table, error 1442). The audit rule "skip an `updated_at`-only change" is in the generated trigger (tested) | g |

### Access rules (A1 to A11)

| Rule | Verdict | What replaces it | Evidence |
|---|---|---|---|
| A1 RLS on every table, plus an event trigger for new tables | GONE | No direct access exists. Replacement test: the route table is enumerated and **every route must declare its roles** (a route without a declaration fails the build) | design |
| A2 roles from `profiles`, never from JWT metadata | OK | Role read from `users` on every request; the session token carries only an opaque session id | |
| A3 default privileges, `anon`, `authenticated`, `private` usage | GONE | Hostinger makes **one user per database** (the create form asks name, user and password together; a second user for the same database is not offered), so there is one runtime user with Delete and Drop unticked (S7). Table and column `GRANT`s work in MariaDB (tested) but cannot be applied here, and would not separate roles anyway, because every role goes through the same user | g, h |
| A4 the table/view matrix by role | NODE | Becomes a **route x role matrix** plus a **field allow-list per role** (a biller gets customers with mobile, GST and PAN as in A9 but never `sku_private`; staff get no customers, bills or receipts; only the owner gets `sku_private`). T-D02 to T-D09, T-D18, T-D19 become HTTP tests with one login per role | design |
| A5 content columns, `GRANT UPDATE (cols)`, triggers that reject staff changes | NODE | A per-route input schema lists the editable fields; everything else is rejected; the stale-edit check `WHERE updated_at = <exact text>` works unchanged (`DATETIME(6)` text, tested in d5) | d5 |
| A6 security-definer functions, revoke/grant execute | CHANGE | X1 to X12 are **Node service functions**, each one transaction through the same `runTx` wrapper, with the role check first. Not stored procedures: creating routines/triggers may need SUPER on Hostinger, they are harder to test, and the lock order is easier to keep in one module. `quote_bill` (X7) is the pure function in `pricing.ts`; it needs no database call | a, e, b |
| A7 Supabase advisor, no ERROR, lints 0006/0011/0025/0028/0029 | GONE | Replaced by the suite: route-matrix test, `EXPLAIN` test, catalogue tests (every table has a primary key, every money column is DECIMAL, CHECKs present, FK `RESTRICT`), `npm audit`. There is no MariaDB equivalent product | g |
| A8 nobody changes their own role/`active` (trigger) | NODE | Route rule; a `BEFORE UPDATE` trigger with `SIGNAL` works too (tested in d5) if triggers are allowed | d5 |
| A9 reading is wide | OK | As written, enforced in the API | |
| A10 inactive user reads nothing | NODE | The middleware checks `users.active` on **every request**, so a user deactivated mid-shift is cut at once (this replaces the poll-based C18) | |
| A11 GraphQL off | GONE | There is no GraphQL | |

### Login, sessions, photos, audit, numbers (U, P, L)

| Rule | Verdict | What replaces it | Evidence |
|---|---|---|---|
| U1 email+password through Supabase Auth | NODE | Own `POST /login`; password hash with a memory-hard algorithm (the `node-api-design` session decides: argon2id needs a native module that may not build on Hostinger, Node's built-in `scrypt` needs none); rate limit and lockout; nothing shown on the login screen | |
| U2 sign-up off | GONE | No sign-up route exists | |
| U3 `private.activate_user` runbook SQL | CHANGE | `scripts/create-user.mjs` prints an `INSERT` with the password hash for phpMyAdmin (the password is typed into the script on Harsh's Mac, never into chat) | |
| U4 session time-box and inactivity (Pro-only in Supabase) | CHANGE, **better** | Server-side `sessions` table (hash of an opaque token, `created_at`, `last_seen_at`, `expires_at`): absolute 14 days and idle 12 hours enforced on every request, revocation at once, with no paid plan needed. The 12-hour screen logout stays | |
| U5 to U8 role from profile, gate, `onAuthStateChange` | OK / GONE | Front end unchanged except the auth client; U6 (the Supabase deadlock rule) disappears | |
| U9 password rules | CHANGE | Ours: at least 10 characters, set at creation. O29 (Supabase password settings) closes | |
| U10 build holds URL + publishable key only | CHANGE | `NEXT_PUBLIC_API_URL` only. Database credentials exist only in Hostinger's environment variables | Hostinger docs: variables persist across deployments |
| P1 to P6 Storage bucket, 2 MB, public read, policies | CHANGE (**decided: photos in MariaDB**, Harsh 15 Oct) | `design_photos` table with `MEDIUMBLOB`, uploads through the API (owner and staff, 2 MB, type from the first bytes), public `GET /photos/<id>` with an immutable cache header; P3 becomes route roles; P5 (photo mirror) disappears because the dump holds the photos. Design rules and the 3 GB budget are in HOSTINGER-FACTS.md section 3 | |
| L1 audit trigger | CHANGE | see D16 | g |
| L2 audit append-only | CHANGE | `BEFORE UPDATE/DELETE` triggers with `SIGNAL` (tested) or a DB user without UPDATE/DELETE on that table; `TRUNCATE` is only stopped by a privilege | g |
| L3 numbers `INSERT ... ON CONFLICT ... RETURNING` | CHANGE | `INSERT ... ON DUPLICATE KEY UPDATE last_value = LAST_INSERT_ID(last_value + 1)` then `SELECT LAST_INSERT_ID()` (tested: no gap under rollback, kill and timeout; 650 to 750 numbers a second) | f |
| L4 formats | OK | In Node, with the `Asia/Kolkata` year | |
| L5 idempotency (`ON CONFLICT DO NOTHING`, wait for in-flight twin) | CHANGE | `INSERT ... ON DUPLICATE KEY UPDATE request_id = request_id` + claim-token read-back (affectedRows cannot tell first from repeat under mysql2's default flag). Tested with two overlapping identical requests | c |
| L6 delete old idempotency rows | CHANGE | In the nightly job (section 4) | |

### Cache contract (C1 to C18)

| Rule | Verdict | What replaces it |
|---|---|---|
| C1, C2, C5 to C9, C11 to C17 | OK | Front-end rules; only the client library changes |
| C3 pages of 1,000 with `.range()`, `api.max_rows` | CHANGE | Our own keyset-paged list endpoints (`after` cursor, page size capped by the server), so there is no silent server cut; T-F03 "max_rows lowered to 500" becomes "the server's page cap is lowered" |
| C4 polling by (`updated_at`, `id`), 30 s overlap, `lock_timeout`, `statement_timeout` | OK with new settings | Same logic. Per connection: `innodb_lock_wait_timeout` (about 5 s) and **`max_statement_time`** (seconds, error 1969, also cuts a lock wait; tested) replace `lock_timeout` and `statement_timeout`. `ON UPDATE CURRENT_TIMESTAMP(6)` stamps at statement start, so the rule "take the contended locks before stamping rows" still decides how late a commit can be |
| C10 static export | OK | |
| C12 one pricing function, two copies | CHANGE | One copy: `pricing.ts` runs in the browser and in the API. The SQL version tested in step 1 equals it, so a database copy is optional (only if the nightly re-price I6 is wanted in SQL) |
| C18 poll own profile to log out a deactivated user | CHANGE | Done by the API on every request (A10); the poll just handles the 401 |

### Backups, hosting, build, import (B, H, IM)

| Rule | Verdict | What replaces it | Evidence |
|---|---|---|---|
| B1 Supabase Pro | GONE | Hostinger Business has daily automatic backups of files and databases (Hostinger's docs: Business and higher have daily backups; retention not stated; a manual backup once per 24 hours). The Hostinger backup is a bonus, **not** the plan: its database-only restore path and retention are not documented, so our own nightly dump stays | Hostinger docs |
| B2 nightly full dump to R2 (`supabase db dump`), pooler/IPv4 text | CHANGE / UNKNOWN | `mariadb-dump --single-transaction` (a consistent InnoDB snapshot; includes triggers; add `--routines --events`) **where?** (a) a Hostinger **Node.js cron job** running a script of the app (the cron type exists, every minute at the shortest; `mariadb-dump` must exist on the server, ask once over SSH, active on port 65002), (b) from Harsh's Mac through *Remote MySQL* (host `srv2210.hstgr.io`, his IP allowlisted), (c) a GitHub scheduled workflow is **ruled out** (no fixed IP to allowlist), (d) a Node-only export (per table, `START TRANSACTION WITH CONSISTENT SNAPSHOT` under REPEATABLE READ, blobs streamed in chunks, gzip, encrypt, upload to R2). Recommendation: (d) run by the Node cron job, plus (a) if the binary exists. The photo mirror is gone (photos are in the dump, which is about 1.33 times bigger with base64 or hex blobs). Hostinger's own daily backup is a bonus (retention unknown) | Hostinger hPanel; a |
| B3 download zip | OK | | |
| B4 restore drill into a scratch Supabase project | CHANGE, **easier** | Restore into a throw-away local MariaDB 11.8 in Docker (what `npm run db:up` already does): free, same version as Hostinger, no cloud project to drop afterwards. Row-count equality, 20 photos, the nightly check as before | |
| B5, B6 | OK | B6 becomes: Hostinger's own backups disappear with the plan, so the R2 copy is the survivor | |
| H1 `_headers` on Cloudflare | CHANGE | The site is on Vercel (already live): headers go in `vercel.json` (Next.js 16's own static-export guide lists `headers` in `next.config` as an unsupported feature, `jewelvault-app/node_modules/next/dist/docs/01-app/02-guides/static-exports.md`). CSP `connect-src` allows the API origin; the API sets CORS to the one Vercel origin. The `vercel.json` syntax is not yet checked against Vercel's docs | |
| H3 forbidden strings in `out/` | CHANGE | Replace `sb_secret_`, `service_role`, `postgres://` with `mysql://`, `mariadb://`, `DB_PASSWORD`, `DATABASE_URL`, and keep `admin123`, `staff123`, `.map` | |
| H4 build env | CHANGE | `NEXT_PUBLIC_API_URL` | |
| H5 dev and prod Supabase projects in two organisations | CHANGE, **simpler** | Dev and tests: local Docker MariaDB (tmpfs). Production: the Hostinger database. A second Hostinger database for staging only if the plan allows (unverified) | |
| H2, H6 | OK | | |
| IM1 import over the owner's connection | CHANGE | From Harsh's Mac through *Remote MySQL* with his current IP allowlisted for the duration of the import, then removed; or a protected Node CLI on the server | Hostinger docs |
| IM2 to IM8 | OK | Counters, batches, audit role `import` (NULL actor, tested), `data_epoch` re-stamp are database-neutral | g |

## 2. Section 7 of the spec: the nightly job and the heartbeat (I8, I12)

- `pg_cron` at 02:00 is **not possible**: `event_scheduler` is OFF on Hostinger, a normal user cannot switch it on (`SET GLOBAL` is refused, tested), and an event created while it is off is accepted but **never runs** (tested: 0 rows after 3 seconds with an every-second event).
- Replacement: an **hPanel cron job of the *Node.js* type** (read in Harsh's hPanel on 15 Oct: the form runs `/opt/alt/alt-nodejs20/root/bin/node <app path>/<script>` and offers **every minute** as the shortest interval; there is also a Custom type for `curl`). Unknown and to be tested at the first deploy: whether the cron process sees the app's environment variables (the database password) and the exact path prefix; if it does not, the Custom type calls a protected HTTPS endpoint instead. The time zone of cron is not shown, so the design stays: schedule it **every hour** and let the job decide "has the check for today's business date (after 02:00 IST) already run?" by looking at `check_runs`. A late or missed hour then costs nothing, and no time-zone assumption is made. Cron uses Node 20, so the script must run on Node 20.
- The nightly check runs `START TRANSACTION WITH CONSISTENT SNAPSHOT` under REPEATABLE READ (a plain READ-COMMITTED transaction re-reads per statement; tested in step 1).
- The 26-hour red-line on the dashboard (I12) already covers "the cron stopped".

## 3. Photos (P1 to P6): decided by Harsh on 15 Oct 2026, photos live in MariaDB

Supabase Storage is gone, and Hostinger's Node folders are overwritten on every deployment, so local disk was never an option. Harsh chose **photos inside MariaDB** over Cloudflare R2. The design rules and the size budget are in `HOSTINGER-FACTS.md` section 3. The one risk to watch: the plan's database limit is **3 GB** (from Hostinger's limits table for this plan; hPanel does not show it) and photos share it with the whole business data. The code sits behind one `PhotoStore` interface so R2 can replace it later if Siddhi's catalogue turns out larger than the budget.

## 4. Tests that change (Part A section 15)

| Tests | Fate |
|---|---|
| T-D01, T-D02, T-D10, T-D11, T-D15, T-D16, T-D17 (RLS on, grants, definer search_path, advisor, JWT metadata, private schema, GraphQL) | **Removed**; replaced by the route-declaration test, `EXPLAIN` test and catalogue tests of A7 |
| T-D03 to T-D09, T-D18, T-D19, T-D20, T-D21 (what each role can read/write/upload) | **Rewritten as HTTP tests**, one login per role, same expectations |
| T-D12, T-D13 | Kept (build strings change; "sign-up" becomes "no sign-up route") |
| T-D14, T-D22 (audit, forced person columns) | Kept as database tests (trigger version) or HTTP+DB tests (Node version) |
| T-E01 to T-E09 | Kept; T-E09 (`activate_user`) becomes the create-user script |
| T-F01, T-F02, T-F05, T-F06, T-F07 | Kept as DB tests (CHECK/unique/format); T-F02's "limits equal CHECK literals" reads `information_schema` |
| T-F03 | `max_rows` wording becomes "server page cap" |
| T-F04 | "Migrations twice give the same schema" now also proves re-runnability (DDL is not transactional) |
| T-R01 to T-R03 | Kept; the drill target is local Docker |

## 5. What the Hostinger check (15 Oct) settled, and what is still unknown

Settled, with the evidence in `HOSTINGER-FACTS.md`: a second user cannot be made but **Delete and Drop can be unticked** on the one user (S7); the **Trigger** privilege exists and `log_bin` is OFF; hPanel has a **Node.js cron type**, every minute at the shortest; the server runs **non-strict `sql_mode`**, **20-second idle timeout**, `max_statement_time` 120 s, **75 connections per user**, `max_allowed_packet` 1 GB; time zone UTC; SSH is active; Remote MySQL exists (host `srv2210.hstgr.io`); Hostinger makes a daily backup.

Still unknown (all need the new JewelVault database, or Harsh's SSH login):
1. Does `CREATE TRIGGER` really work for the user (first migration step: a throw-away trigger).
2. Does a Node Web App reach the database as `127.0.0.1` or only as `srv2210.hstgr.io`.
3. Does the cron process see the app's environment variables, and what is the full script path prefix.
4. Is `mariadb-dump` on the server (SSH).
5. Backup retention and database-only restore of Hostinger's own backup.
6. The plan's real database size limit (3 GB is from the support table, not from this account).

## 6. Sources

- MariaDB docs (via Context7, `mariadb-corporation/mariadb-docs`): `log_bin_trust_function_creators` and binary logging of routines; INSERT ... ON DUPLICATE KEY UPDATE; `LAST_INSERT_ID(expr)`; CHECK constraints; JSON data type (LONGTEXT alias); UUID data type; "Gap locking at READ COMMITTED" (unique-index duplicate checks still take next-key locks); WAIT/NOWAIT.
- Hostinger: [Node.js apps: creating an app](https://docs.hostinger.com/node.js/creating-an-app) (Node 18/20/22/24, entry file, server builds in `hbuilds/current/nodejs`); [file structure](https://docs.hostinger.com/node.js/file-structure) (managed folders overwritten on every deployment; direct edits unsupported); [environment variables](https://docs.hostinger.com/node.js/environment-variables) (injected into build and runtime, persist across deployments); [cron jobs](https://docs.hostinger.com/websites/cron-jobs) (command jobs, output discarded by default; interval, time zone and plan limits not stated); [backups](https://docs.hostinger.com/websites/backups) and [backup articles](https://www.hostinger.com/support/1665153-how-to-activate-daily-backups/) (weekly by default, daily on Business and higher, retention for Business not stated); [Remote MySQL](https://www.hostinger.com/ng/tutorials/how-to-grant-remote-access-mysql/) (IP allowlist or "Any Host").
- Next.js 16 static-export guide (in the app repo's `node_modules`): `headers` is an unsupported feature of `output: 'export'`.
- Not checked: Cloudflare R2 feature details, the exact `vercel.json` header syntax (both belong to the step that builds those parts).
