# Hostinger facts for JewelVault (read 15 Oct 2026, read only) and the decisions taken

How they were read: in Harsh's Chrome ("Browser 1", the account with the Business plan), with Harsh's OK for read-only checks. Only `SHOW VARIABLES` ran in phpMyAdmin (opened by hPanel's own single-sign-on button; no password typed by anyone). In hPanel only pages were viewed; the "Create database" form was not submitted (the browser had pre-filled it), the "Change Permissions" dialog was opened and **Cancelled**, a cron dropdown was opened and closed. Nothing was created, changed or deleted. The old WordPress database `u992795260_SQXsy` was not queried beyond server variables.

## 1. Facts

| Fact | Value | Where read |
|---|---|---|
| Plan | **Business Web Hosting**, server `server2210`, **Asia (India)**, backups kept in Singapore | hPanel plan details |
| Limits | disk 50 GB (1.39 GB used), inodes 600,000, RAM 3,072 MB, 2 CPU cores, 120 processes, I/O 20 MB/s, 512 IOPS, 5 Web Apps (1 used: the failed test app `skyblue-rat-675449`, which still shows "Build failed" from the `jewelvault-app` repo) | plan details, usage |
| Database server | **MariaDB 11.8.9** (version string `11.8.9-MariaDB-log`), InnoDB default, `utf8mb4` / `utf8mb4_unicode_ci`, `lower_case_table_names = 0` (table names are case-sensitive) | phpMyAdmin |
| Isolation | **READ-COMMITTED**; `innodb_deadlock_detect` ON; `innodb_lock_wait_timeout` 50; `innodb_rollback_on_timeout` OFF | phpMyAdmin |
| **sql_mode** | `NO_AUTO_CREATE_USER,NO_ENGINE_SUBSTITUTION`: **not strict** | phpMyAdmin |
| **wait_timeout / interactive_timeout** | **20 seconds** (an idle connection is closed after 20 s) | phpMyAdmin |
| max_statement_time | **120 s** server default (a statement is cut after 2 minutes) | phpMyAdmin |
| max_user_connections / max_connections | **75** per user / 2,000 | phpMyAdmin |
| max_allowed_packet | 1 GB | phpMyAdmin |
| Binary log | `log_bin` OFF, `log_bin_trust_function_creators` OFF, `binlog_format` MIXED (so creating triggers should need no SUPER; **not proved until one is created**, see section 4) | phpMyAdmin |
| event_scheduler | OFF (also confirmed: no SUPER, cannot be switched on) | phpMyAdmin |
| Time zone | `time_zone = SYSTEM`, `system_time_zone = UTC` | phpMyAdmin |
| Database users | creating a database creates **one user for it** (the form asks name, user, password together). There is one database now, 3 MB, WordPress | hPanel Databases |
| **Change Permissions** | per database user, 18 tick boxes, all ticked by default: Alter, Create view, Index, Select, Create, Delete, Insert, Show view, Alter routine, Create routine, Drop, Lock tables, Trigger, Create temporary tables, Execute, References, Update, Event | hPanel (dialog opened, cancelled) |
| **Cron Jobs** | two types: **Node.js** (command is `/opt/alt/alt-nodejs20/root/bin/node /home/u992795260/domai...` plus a script path field, placeholder `scripts/cron.js`) and Custom; the minute list starts at **every minute** | hPanel Cron Jobs |
| SSH | **Active**, host `92.249.46.146`, port `65002`, user `u992795260` (password not looked at) | hPanel SSH |
| Remote MySQL | exists: allowlist an IPv4/IPv6 or "Any Host"; remote hostname `srv2210.hstgr.io` (`82.25.121.210`). phpMyAdmin itself reaches the server as `127.0.0.1:3306` | hPanel Remote MySQL |
| Hostinger backups | automated **Daily**, latest 13:56 today, manual one allowed every 24 h; "database export files are excluded"; retention and a database-only restore not shown | hPanel Backups |
| Database size limit | **3 GB** per Hostinger's limits table for the plan that matches this one (RAM 3 GB, 2 CPU, 600K inodes = the "Unlimited", formerly Business, column); max MySQL backup 5,120 MB. hPanel does not show the database limit itself | Hostinger support page |
| Node app disk | `hbuilds/` and `public_html` are overwritten on every deployment; no persistent upload folder is named | Hostinger docs |

## 2. What changes because of them

1. **Every connection sets its own `sql_mode`** (strict) and `transaction_isolation`, `time_zone '+00:00'`, `innodb_lock_wait_timeout` 5, `max_statement_time` 15. Proved locally (`h-hostinger-facts` test): with Hostinger's own sql_mode an over-range amount is clamped to `999999999999.99`, `'abc'` becomes `0` and a long text is cut, all without any error.
2. **20-second idle timeout:** the pool must never trust an idle connection. The mysql2 pool replaced a connection the server had closed without any error (tested with a 2 s timeout); a connection killed *inside* a transaction fails its next statement and its `ROLLBACK`, and nothing is committed (tested; `runTx` already ignores a failing ROLLBACK). The API sets `wait_timeout` for its own sessions (allowed for a normal user, tested) and keeps `connectionLimit` at 10 or less (limit 75).
3. **Triggers:** the privilege exists (the "Trigger" box) and the binary log is off, so the trigger versions of D16, D22, A8 and L2 look possible. First migration step on the new database: create and drop a throw-away table with a trigger; if it fails the Node-only versions apply.
4. **No DELETE for the runtime user (S7):** possible in hPanel by unticking **Delete** and **Drop** on the JewelVault database's user (Drop is also what `TRUNCATE` needs, so `audit_log` cannot be truncated; tested). Schema changes (Alter, Create, Index, References, Trigger) stay ticked. No second user is needed, and none can be made for the same database.
5. **Nightly job:** hPanel has a real **Node.js cron type** that runs a script of the app, every minute at the shortest. So no public HTTP endpoint with a secret is needed. Still unknown: whether the cron process sees the app's environment variables (database password), and whether the path prefix points at the current build (the prefix is cut off in the form). The hourly, idempotent design of the mapping (section 2) stands: the Node 20 binary is what cron uses, so the script must run on Node 20 whatever Node the app uses.
6. **Backups:** Hostinger keeps a daily backup (a safety net; retention unknown). The nightly dump to R2 stays the plan. SSH is active, so `which mariadb-dump` can be asked once with Harsh's SSH password (not done; not mine to enter).

## 3. Decision: photos live in MariaDB (Harsh, 15 Oct 2026)

Chosen by Harsh over R2. Design rules, so the 3 GB database limit does not become a surprise:

- Table `design_photos` (`id UUID`, `design_id`, `kind` full/thumb, `mime`, `bytes MEDIUMBLOB`, `byte_size`, `sha256`, timestamps). `designs` keeps only the photo ids (P4: no image text in a design row). **No list query ever selects `bytes`**; the screens get ids and fetch `GET /photos/<id>` with `Cache-Control: public, max-age=31536000, immutable` and an ETag (ids never change content).
- Upload through the API only: owner and staff, one image per request, 2 MB cap, type decided from the first bytes (JPEG, PNG, WebP), browser resizes to at most 1200 px as in P2.
- The nightly dump now contains the photos, so the separate photo-mirror job (B2, P5, `backup_runs.kind = photo_copy`, I12's second heartbeat) is **dropped**. The dump must stream blobs (hex or base64), about 1.33 times the data size.
- **Budget:** photo size is an assumption, not measured: about 250 KB a full photo and 20 KB a thumbnail. 2,000 designs with 3 photos each is about 1.6 GB of the 3 GB. The owner dashboard shows the database size (`information_schema`) and goes red at **2 GB**; a limit of 5 photos per design is proposed. Siddhi's real design count is unknown and decides whether this holds; the table keeps a `storage_key` column and the code sits behind one `PhotoStore` interface so R2 can replace it later without touching the screens.

## 4. Still unknown (needs the new JewelVault database, or Harsh's SSH)

1. Is `CREATE TRIGGER` allowed in the new database (section 2.3)? One throw-away test at the start of the first migration.
2. Does a Node Web App reach the database as `127.0.0.1`, or must it use `srv2210.hstgr.io` (with Remote MySQL allowing the app)? First deploy of a script that only does `SELECT 1`, with the host as an environment variable.
3. Do cron jobs see the app's environment variables, and what is the full script path prefix? A `scripts/cron.js` that prints whether `DB_HOST` is set.
4. `mariadb-dump` present over SSH? (needs Harsh's SSH login).
5. Hostinger backup retention, and whether a database-only restore works (read the "Restore and download" list over time).
6. The real database size limit of this plan (hPanel does not show it).
