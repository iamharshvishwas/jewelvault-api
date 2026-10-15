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
- **Changed on 15 Oct (D-Q11, Harsh):** the nightly export leaves `design_photos.bytes` out, and each photo is copied once to the off-site bucket (`sys_photo_copies` remembers which; `backup_runs.kind` has `photo_copy` again, I12's second heartbeat is back). Reason: 30 daily + 12 monthly exports with photos would be about 47 GB at 1,500 designs and about 16 GB even at 500, against R2's free 10 GB. Photos never change, so one copy is enough. (An earlier line here said the dump holds the photos and the photo copy is dropped; that is reversed.) `design_photos.design_id` has no foreign key (the screen uploads before the design exists) and a removed photo is a tombstone (`removed_at`, bytes NULL).

### The 3 GB budget, measured (15 Oct 2026, `tests/i-size-budget.test.ts`)

**Photos.** Siddhi's four product photos (`Client/design/`, WhatsApp shots of 960 x 1280, 91 to 178 KB each) were resized as the screen does (P2: longest side 1200 px, JPEG quality 82; thumbnail 320 px) with macOS `sips`, then stored 480 times in a `MEDIUMBLOB` table on MariaDB 11.8 (InnoDB):

| | Average payload | Stored in InnoDB |
|---|---|---|
| full photo, 1200 px q82 | 206 KB (156 to 275 KB) | about 230 KB with InnoDB overhead |
| thumbnail 320 px | 19 KB (17 to 22 KB) | about 21 KB |
| **one photo (full + thumbnail)** | 225 KB | **about 250 KB** (overhead measured 9 to 13 percent in two runs) |
| lean setting, 1000 px q72 | full 141 KB | pair about 180 KB (30 percent less) |

**Business data** at the volumes of spec C2 (1,500 designs, 5,000 pieces, 2,000 customers, 3,000 bills with 7,500 lines, 4,500 receipts and allocations, every piece edited twice, 5 percent of bills cancelled), with the audit triggers on: **73 MB**, of which the audit log is **52 MB** (35,000 rows of about 1.5 KB). Every other table together is about 20 MB. If a year looks like that, year 5 is about 375 MB. These rows are generated (random values with the real column types and lengths), so treat the figure as a good estimate, not a measurement of Siddhi's data.

**Total database size = photos + business data.** Limit 3,000 MB, owner dashboard red line 2,000 MB. Numbers in MB, business data counted at 75 (year 1) / 375 (year 5):

| Designs | 1 photo each | 3 photos each | 5 photos each |
|---|---|---|---|
| 1,000 | 325 / 625 | 825 / 1,125 | 1,325 / 1,625 |
| 1,500 | 450 / 750 | 1,200 / 1,500 | 1,950 / 2,250 |
| 2,000 | 575 / 875 | 1,575 / 1,875 | 2,575 / 2,875 |
| 3,000 | 825 / 1,125 | 2,325 / 2,625 | 3,825 / 4,125 |
| 5,000 | 1,325 / 1,625 | 3,825 / 4,125 | 6,325 / 6,625 |

How many designs fit (business data counted at year 3, 225 MB):

| Photo size | 1 photo each | 3 photos each | 5 photos each |
|---|---|---|---|
| standard 250 KB (measured) | 7,100 to red line, 11,100 to limit | **2,370 / 3,700** | 1,420 / 2,220 |
| lean 180 KB (1000 px q72) | 9,900 / 15,500 | 3,300 / 5,170 | 1,980 / 3,100 |
| heavy 420 KB (assumed, detail-rich camera shots) | 4,200 / 6,600 | 1,410 / 2,200 | 850 / 1,320 |

**Reading it:** with the standard setting and at most 3 photos a design, the database stays under the red line up to about **2,400 designs**. The spec's own ceiling is 5,000 pieces, and a design groups several pieces, so the number of designs is probably well below 5,000, but nobody knows it yet. 5,000 designs with 3 photos (3.8 GB) would not fit, and neither would 5 photos on more than about 2,200 designs.

**Weak points of these numbers:** only four photos were measured (all already WhatsApp-compressed; fresh phone shots of detailed jewellery may be larger, hence the "heavy" row); the 3 GB limit comes from Hostinger's support table, not from this account, and it is not known whether Hostinger counts index space or only data; the design count and photos per design are Siddhi's to answer.

**Decisions this suggests (not taken):** (1) ask Siddhi for the number of designs and photos per design; (2) cap photos at 3 per design in M1; (3) keep 1200 px q82 until the answer is in, and switch the two constants to 1000 px q72 if the count is above about 2,000 designs; (4) if the count is above about 3,500 designs, move photos to R2 behind `PhotoStore` (the design already allows it); (5) the audit log is the main business-data growth, so keep an eye on it (a yearly archive is possible later).

## 4. Still unknown (needs the new JewelVault database, or Harsh's SSH)

1. Is `CREATE TRIGGER` allowed in the new database (section 2.3)? One throw-away test at the start of the first migration.
2. Does a Node Web App reach the database as `127.0.0.1`, or must it use `srv2210.hstgr.io` (with Remote MySQL allowing the app)? First deploy of a script that only does `SELECT 1`, with the host as an environment variable.
3. Do cron jobs see the app's environment variables, and what is the full script path prefix? A `scripts/cron.js` that prints whether `DB_HOST` is set.
4. `mariadb-dump` present over SSH? (needs Harsh's SSH login).
5. Hostinger backup retention, and whether a database-only restore works (read the "Restore and download" list over time).
6. The real database size limit of this plan (hPanel does not show it).
