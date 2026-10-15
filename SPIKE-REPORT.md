# JewelVault on MariaDB: step 1 spike report

Date: Thursday 15 October 2026. Written by Claude (database half). Nothing was built on Hostinger; everything ran in a throw-away local container.

## In short (Hinglish)

- **Chal gaya:** row lock (`FOR UPDATE`), exact paise ka DECIMAL hisaab, repeat-safe request id, CHECK / UUID / JSON / generated columns, ek hi lock order, aur gap-rahit bill number. 59 tests pass, 1 opt-in test skip.
- **Do cheezein jo pehle fail huin aur ab design rule bani:** (1) `UPDATE ... WHERE <bina index wali column>` deadlock karta hai, 8 clients par 12 se 32 deadlock har 1,200 operations mein; (2) "ek piece ek hi live line" ko UNIQUE index se rokna kabhi kabhi counter ke saath deadlock banata hai.
- **Do jaal (trap) jo Node code ko sambhalne hain:** (1) lock-wait timeout (error 1205) sirf us ek statement ko rollback karta hai, poori transaction nahi, aur Hostinger par hum yeh setting badal nahi sakte; isliye har error par ROLLBACK zaroori; (2) zyada decimals wali value (1.239) chup chaap round ho jaati hai, error nahi aata; Node ko validate karna hoga.
- **Abhi nahi pata (Hostinger par check baaki):** sql_mode, trigger banane ki permission, connection limit, `max_statement_time`. Neeche exact read-only SQL di hai.
- **Saaf baat:** yeh ek local MariaDB 11.8.9 par chala model hai, asli Hostinger par nahi, aur asli spec functions nahi, unka chhota model hai. Yeh lock aur number ka vyavhaar sabit karta hai, business rules ki sahi hone ko nahi.

## 1. Setup (what was actually run)

```bash
cd "/Users/harshvishwas/Desktop/Harsh Vishwas/Client/jewelvault-api"
npm run db:up          # docker run mariadb:11.8, data dir on tmpfs, port 127.0.0.1:33307
npx vitest run         # whole suite, about 40 seconds
npx vitest run --reporter=verbose > SPIKE-RUN-LOG.txt
npm run db:down        # docker rm -fv jv-mariadb-spike
```

| Item | Value |
|---|---|
| Server | `mariadb:11.8` image, `SELECT VERSION()` = **11.8.9-MariaDB-ubu2404** (same as Hostinger's 11.8.9 seen in Harsh's phpMyAdmin) |
| Isolation | `--transaction-isolation=READ-COMMITTED` (Hostinger's value); every test connection also sets it for its own session |
| event_scheduler | OFF (the default, as on Hostinger) |
| Storage | `--tmpfs /var/lib/mysql`, so `docker inspect` shows `Mounts: []`: no Docker volume can leak. The container is removed with `docker rm -fv`. The guard container `keep-tourstack-and-unknown-volumes` was not touched |
| App user | `jv_app`, rights only on the test database, **not SUPER**: this is the nearest we can get to a Hostinger hosting user |
| Client | Node v22.22.3, `mysql2` 3.24.6, Vitest 3.2.7 (Vitest 4 crashes npm 10.9.8, as noted in memory) |
| Oracle | `oracle/pricing.ts` = a copy of `jewelvault-app/src/lib/pricing.ts` at commit `416d17a` (read only; the app repo was not touched) |
| Repo | `jewelvault-api`, `git init`, branch `main`, no remote, nothing pushed |

Docs read for each claim are listed in section 5.

## 2. Results by question

### (a) Two connections, `SELECT ... FOR UPDATE` on the same customer row: PASS (11 tests)

| Question | Result |
|---|---|
| Does the second locker wait? | Yes. It returned only after the first committed (0.8 s hold) and then saw the **committed** value (`250.00`), not an old snapshot |
| Is a plain `SELECT` blocked? | No. Same as in Postgres, so X0 must lock **before** it reads (spec X0 item 3) |
| Timeout | `innodb_lock_wait_timeout` default **50 s** (session-settable by a normal user). Error **1205**, `ER_LOCK_WAIT_TIMEOUT`, SQLSTATE `HY000`, message "Lock wait timeout exceeded; try restarting transaction". Measured wait with a 2 s setting: 2.03 s |
| **TRAP 1** | A 1205 rolls back **only the failing statement**. The transaction stays open; an earlier insert in it survived a `COMMIT` (proved). `innodb_rollback_on_timeout` is global and not dynamic (default OFF) so Hostinger will not let us change it. **Rule: the API issues `ROLLBACK` on every error** (`runTx` in `tests/helpers.ts`) |
| Per-statement timeout | `SELECT ... FOR UPDATE WAIT 1` waits 1 s then fails with 1205; `NOWAIT` fails at once with 1205. This replaces the Postgres `SET lock_timeout` clause of X0 item 7 |
| Whole-call bound (spec C4 `statement_timeout`) | `SET SESSION max_statement_time = 1` (seconds) cuts any statement, including a lock wait, with error **1969** after 1.0 s |
| Dead connection | `KILL` of the holder's connection (what a crashed Node process looks like) released the lock at once |
| READ-COMMITTED gap locks | A `FOR UPDATE` on a row that does not exist does **not** block inserting it (contrast: under REPEATABLE READ it does) |
| Why the customer lock is needed | Without it two writers both applied the same ₹100 advance (₹200 allocated, advance −₹100); with it, ₹100 and ₹0 |
| Nightly check snapshot | Under READ-COMMITTED even `START TRANSACTION WITH CONSISTENT SNAPSHOT` re-reads per statement (value changed inside one "transaction"); the check must run `SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ` first, then it is stable |

### (b) DECIMAL money against the `pricing.ts` oracle: PASS (8 tests)

- Rules R3 to R8 written once in SQL (`ROUND(nw * rate, 2)` on `DECIMAL(12,3)` x `DECIMAL(12,2)`, fine due, line total, `ROUND(...,0)` grand total, round-off).
- **2,546 random bills, 7,260 lines** (some with weights and rates near the S4 caps; 454 bills were over the caps and the oracle refused them): every metal amount, labour amount, subtotal, grand total and round-off equals the BigInt oracle. 0 mismatches.
- **20,000 deliberate exact-half cases** (`mg x rate mod 1000 = 500`): DECIMAL rounds half up and agrees with the oracle on all; the same sum in `DOUBLE` gives a different rupee figure on **9,987 of them**. So: money is DECIMAL, never float.
- Spec worked example: metal 245,106.40, labour 12,503.26, subtotal 257,611.81, grand total **257,612**. Negative round-off −0.40 is exact.
- mysql2 returns DECIMAL as text (`'257611.81'`) with `decimalNumbers:false`; money must be sent as text too.
- **TRAP 2:** `'1.239'` into `DECIMAL(12,2)` is **silently rounded to 1.24** in strict mode, no error. A CHECK cannot catch it (already rounded). So the S4 rule "more decimals than the column = JV_INVALID_INPUT" must be enforced in Node (as `pricing.ts` `parseRupees` already does).
- **TRAP 3:** an over-range value is refused (error 1264) only in strict mode. With `sql_mode=''` it is **clamped to 999999999999.99** (invented money). Hostinger's default `sql_mode` for a new connection is not known, so the API sets `sql_mode` on every connection.
- CHECK for caps and "not negative" works (error 4025, named).

### (c) Idempotency with a UNIQUE `request_id`: PASS (9 tests)

- Pattern (`tests/idem.ts`): first statement `INSERT ... ON DUPLICATE KEY UPDATE request_id = request_id` with a fresh `claim_token`, then `SELECT ... FOR UPDATE` of that row; if the token is ours we are first, else we return the stored result.
- Two overlapping identical requests: the second **waited** at the insert (about 0.9 s), then returned the same bill number as the first. One bill, one counter step, one idempotency row.
- If the first fails and rolls back, the waiting identical request becomes the first and succeeds (one bill).
- Same id with different arguments, other actor or other function: refused (`JV_INVALID_INPUT`).
- 8 identical requests at once: exactly 1 bill, 7 replays. A later retry replays and burns no number.
- **FACT:** with mysql2's default `FOUND_ROWS` flag a duplicate reports `affectedRows = 1`, same as a fresh insert, so `affectedRows` cannot tell first from repeat. That is why the claim token is used. (Without the flag: 1 = inserted, 0 = duplicate; the docs say 1 inserted / 2 updated normally.)
- Under REPEATABLE READ an old snapshot makes the duplicate insert fail with error **1020** "Record has changed since last read": a false error. READ-COMMITTED (Hostinger's) avoids it, and the API sets it anyway.
- 240 held claims with random request ids by 8 workers took 1.45 s against 9.6 s if serial: different ids do not block each other.

### (d) CHECK, UUID, JSON, generated columns: PASS (19 tests)

| Topic | Result |
|---|---|
| CHECK | Enforced; error **4025**, constraint named. Multi-column forms from the spec work: `(status='Sold') = (sold_bill_id IS NOT NULL)`, status lists, weight caps; UPDATEs are checked too. **Not possible:** a subquery (error 1970) and `CURDATE()` (error 1901), so "date not in the future" lives in Node. A CHECK that evaluates to NULL passes, so the columns it uses must be NOT NULL. `ALTER TABLE ... DROP CONSTRAINT` / `ADD CONSTRAINT` work (needed by the mutation tests of T-B18) |
| UUID | **Native `UUID` type works** (since 10.7): validates the text (error 1292 for garbage), lower-cases, returns text, accepts the fixed walk-in id `00000000-0000-4000-8000-000000000001`; `UUID_v4()` and `UUID_v7()` exist in 11.8. 50,000 random v4 keys: clustered size **3.7 MB against 5.8 MB** for `CHAR(36) ascii`, same insert speed (170 ms against 176 ms). A foreign key from `UUID` to `CHAR(36)` is refused (error 1005/150): use **one** type everywhere. Recommendation: native `UUID`. Drawback: not portable to MySQL (no such type there) |
| Text codes | `UNIQUE` on `utf8mb4_unicode_ci` is case-insensitive (`jw-00001-001` collides with `JW-00001-001`). Trailing spaces also collide (PAD SPACE): trim in Node |
| JSON | MariaDB's `JSON` is `LONGTEXT` plus a `JSON_VALID` CHECK (invalid text refused, 4025). Text is stored as written, key order kept. **mysql2 returns it already parsed as an object on this server pair**, so store with `JSON.stringify(...)`; a JS object passed as a parameter is not turned into JSON. **Money inside JSON must be a string**: a number like `12345678901234567.89` loses digits in JS (the database still holds it exactly). `JSON_VALUE`, `JSON_TYPE`, `JSON_ARRAYAGG` and `JSON_TABLE` (unpack `p_items`) all exist; `CHECK (JSON_TYPE(tags)='ARRAY')` works |
| Generated columns | `PERSISTENT` + `UNIQUE` = partial unique index: exactly one walk-in customer works (many NULLs allowed). Generated columns can be indexed and used in CHECKs; cannot be written directly. **But see finding F2 before using a flipping flag as a unique key** |
| Reserved words | Unquoted names that **fail**: `key`, `interval`, `rows`, `lines`, `condition`, `order`, `release`, `usage`, `range`, `read`, `write`. The spec's `settings.key` must become `setting_key`; a table named `lines` fails (the first run of the spike hit this). `window`, `row`, `rank`, `role`, `kind`, `mode`, `status`, `value`, `at`, `text`, `date`, `type` are fine |
| Timestamps | `DATETIME(6)` with `DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6)` works (microseconds, keyset index `(updated_at, id)`). `NOW(6)` is fixed per **statement** (not per transaction as in Postgres); `SYSDATE(6)` is the real clock |
| Triggers | A `BEFORE UPDATE` trigger with `SIGNAL SQLSTATE '45000'` (error 1644, message kept) works for the "nobody changes their own role" rule (A8). **Locally `log_bin` is OFF.** MariaDB docs: with the binary log ON and `log_bin_trust_function_creators` OFF, `CREATE TRIGGER` needs the `SUPER` privilege. Hostinger's values are unknown, see section 4 |
| Privileges | The app user cannot `SET GLOBAL` anything: only session settings are available on Hostinger |

### (e) One lock order under 8 parallel clients: PASS after two design fixes (5 tests)

Model (`tests/sim.ts`, a small version of X1, X2, X5, X10, X12): idempotency claim, **customer row `FOR UPDATE`**, **pieces by id ascending** (`SELECT ... WHERE id IN (...) ORDER BY id FOR UPDATE`), bill rows, allocations/rebalance, **number counter last**. 5 customers and 14 pieces, so almost every operation collides. 8 connections, 150 random operations each, **no retry**, every error counted.

| Run (latest full run, numbers vary a little between runs) | Committed | Business refusals (expected: piece already sold, bill already cancelled) | Deadlocks (1213) | Lock timeouts (1205) | Other errors |
|---|---|---|---|---|---|
| Spec order, seeds 1 to 4 (4 x 1,200 operations) | 652, 646, 686, 688 | 538, 554, 514, 512 | **0, 0, 0, 0** | 0 | 0 |
| Same, but the pieces to free are located with a non-indexed column (`WHERE sold_bill_id = ?`), 1,200 operations | 619 | 554 | **27** (12 to 32 in 7 runs) | 0 | 0 |
| NEGATIVE CONTROL: half of the calls take the counter before the customer lock and the pieces in caller order, 800 operations | 454 | 267 | **65** (61 to 69 in 4 runs) | 0 | 0 |
| Same wrong order with the retry wrapper (rollback + retry on 1213/1205), 800 operations | 454 | 346 | 61, all 61 retried and then succeeded | 0 | 0 |

- After every spec-order run the nightly-style invariants hold: Sold pieces = pieces on live lines of active bills; no allocation over a bill or receipt; no advance beside a pending bill; bill numbers contiguous with the counter.
- The negative control shows the harness **can** see deadlocks, so "0" means something. The retry wrapper repairs them but the rule is to avoid them.
- **F1 (real finding, fixed in the model).** The first spec-order runs had 12 and 20 deadlocks. `SHOW ENGINE INNODB STATUS` showed two `UPDATE skus ... WHERE sold_bill_id = ?` statements waiting on each other's rows: that column had **no index**, so InnoDB scanned the table and locked what it scanned. Fix: find rows by the ids the transaction has just locked (primary key). Rule for the schema: **every `UPDATE`, `DELETE` and `SELECT ... FOR UPDATE` must be backed by an index; add an `EXPLAIN` test.** (Postgres does not lock non-matching rows, so this has no equal in the old design.)
- **F2 (real finding, avoided).** After F1 was fixed, 1 to 3 deadlocks still showed up in 2 of about 6 runs of the same workload. The log showed a **`UNIQUE` index on a generated column** (`live_sku`, NULL when a bill is cancelled, intended as "one live line per piece") in a cycle with the number counter: an insert waited for a delete-marked entry of that unique index held by a transaction that was itself waiting for the counter. The MariaDB docs say a unique-index duplicate check "takes a next-key (gap plus index-record) lock regardless of the isolation level". Removing the unique key (keeping a normal index; "no piece on two active bills" stays the invariant I2 with the piece-row lock of K2) gave **0 deadlocks in 4 x 1,200 operations**. My two-connection minimal reproduction did not show it, so the exact trigger is **not isolated**; the opt-in test `tests/e2-unique-flag-deadlock.test.ts` (`JV_LIVE_UNIQUE=1`) repeats the full workload with the unique key and reports the count. **Rule: no `UNIQUE` index on a column that changes after insert.** Immutable unique columns (`design_no`, `sku_no`, `barcode`, `bill_no`, `request_id`, `reissue_of`) are fine.

### (f) Counter table, bill numbers without gaps: PASS (7 tests)

- Counter SQL: `INSERT INTO counters (series, last_value) VALUES (?, LAST_INSERT_ID(1)) ON DUPLICATE KEY UPDATE last_value = LAST_INSERT_ID(last_value + 1)`, then `SELECT LAST_INSERT_ID()` (per connection, so no second lock). Works for the first number of a new series too.
- Rolled-back transaction gives the number back (1, 2, rollback, then 3 again). **AUTO_INCREMENT does not** (proved: gap after rollback), so it is not used for bill numbers.
- 8 brand-new connections racing to create the same series: numbers 1 to 8, no duplicate-key error.
- 8 workers x 120 attempts with **244 injected failures after the number was taken** and **54 killed connections**: the 662 committed bills carry exactly 1 to 662, counter = 662, no gap, no repeat.
- A 1205 on the counter row issues nothing and burns no number; the next attempt continues the series.
- Numbers already used by an import are skipped inside the same transaction (L3): counter at 4, bills 5 to 7 exist, next issued 8.
- Speed: 1,000 numbered inserts through the one hot counter row by 8 workers: 1.3 to 1.6 s (about 650 to 750 a second on loopback). Shop volume is a few hundred a day. Not tested: network latency between Hostinger's Node and its database.

## 3. Design rules this spike gives the schema and the Node layer

1. **Every connection starts with** `SET SESSION transaction_isolation='READ-COMMITTED'`, a strict `sql_mode`, `time_zone`, `innodb_lock_wait_timeout` (about 5 s) and `max_statement_time` (about 15 s). Never rely on Hostinger's globals.
2. **Every error gets `ROLLBACK`** (statement-only rollback on 1205). One wrapper, `runTx`, retries 1213 and 1205 once (spec S8) and rolls back first.
3. **Lock order as X0**: idempotency claim, customer, pieces by id ascending, counter last. Hold the order in one module so no function can reorder it.
4. **Index every locking statement**; an `EXPLAIN` test fails the build on a full scan in an `UPDATE`/`DELETE`/`FOR UPDATE`.
5. **No unique index on a mutable column**; "one live line per piece" stays invariant I2 plus the piece lock.
6. **Money**: `DECIMAL` columns, text on the wire, validation of decimals and caps in Node, CHECKs for caps and signs, nothing as JSON numbers.
7. **Pricing stays in Node** (`pricing.ts`, already BigInt and proven) and the database stores the result; the SQL version tested here equals it and can serve the nightly re-pricing check I6 if wanted in SQL.
8. **Numbers** from the counter row, taken last; **never AUTO_INCREMENT** for a human number.
9. **Names**: rename `settings.key` to `setting_key`, never name a table `lines`/`rows`/`order`; always back-tick generated SQL.
10. **Text codes** trimmed in Node; **JSON** written with `JSON.stringify`, read as an object, money inside it as strings.

## 4. Hostinger values (read on 15 Oct 2026, after this report's first version)

Read from Harsh's account, read only: see `HOSTINGER-FACTS.md`. Headlines: `sql_mode` is **not strict**, idle connections die after **20 s**, `max_statement_time` 120 s, 75 connections per user, `log_bin` OFF, `event_scheduler` OFF, READ-COMMITTED, UTC, a Node.js cron type exists (every minute at the shortest), Delete/Drop can be unticked per user in hPanel. Still untested on Hostinger itself: creating a trigger, the database host name a Node app must use, whether cron sees the app's environment variables. Network latency between Hostinger's Node and its database is also still untested (the model ran on loopback); the server is in India.

## 5. Official documentation used

All read on 15 Oct 2026 through the MariaDB docs repository (`mariadb-corporation/mariadb-docs`, Context7), each then confirmed by a test above: `innodb_lock_wait_timeout` and `innodb_rollback_on_timeout` (statement rolled back, not the transaction); WAIT and NOWAIT (`SELECT ... FOR UPDATE WAIT n`); "Gap locking at READ COMMITTED" (no gap locks, but unique-index duplicate checks take next-key locks); `INSERT ... ON DUPLICATE KEY UPDATE` (rows affected 1/2, `CLIENT_FOUND_ROWS`); `LAST_INSERT_ID(expr)`; `ROUND` (fixed-point "round half up"); JSON data type (alias of `LONGTEXT` with `JSON_VALID`); UUID data type (from 10.7; `UUID_v4`, `UUID_v7` from 11.7); `log_bin_trust_function_creators` and binary logging of stored routines (trigger creation needs SUPER when the binlog is on); CHECK constraints (error 4025/4022, no subqueries or stored functions).

## 6. Files

| File | Purpose |
|---|---|
| `tests/a-row-locks.test.ts` ... `f-counter-gapless.test.ts` | the six questions |
| `tests/e2-unique-flag-deadlock.test.ts` | opt-in repeat of F2 (`JV_LIVE_UNIQUE=1`, about 2 minutes) |
| `tests/helpers.ts`, `idem.ts`, `sim.ts` | connections, `runTx`, idempotency, the money-function model and invariant checks |
| `oracle/pricing.ts` | read-only copy of the app's integer pricing |
| `scripts/db-up.sh`, `db-down.sh` | start and remove the throw-away MariaDB |
| `SPIKE-RUN-LOG.txt` | verbose output of the final run: 9 files passed, 80 tests passed (59 from step 1, 15 from step 2, 5 Hostinger-fact tests, 1 size-budget test), 2 opt-in tests skipped (the repeat of F2 and the real-photo measurement) |

## 7. Step 2

The Part A mapping (which spec rules cannot be done in MariaDB as written, what replaces each, what is still unknown on Hostinger) is in `PART-A-MARIADB-MAPPING.md`, backed by 15 more tests in `tests/g-parta-replacements.test.ts`. The Hostinger values and the photo decision (photos in MariaDB) are in `HOSTINGER-FACTS.md`, with 5 tests in `tests/h-hostinger-facts.test.ts`.
