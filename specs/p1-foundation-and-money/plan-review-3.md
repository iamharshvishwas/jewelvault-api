# Plan review 3 (only what changed in revision B): P1 foundation and money on Node.js + MariaDB
Reviewer: fresh agent (did not write the plan; edited nothing but this file)   Date: 17 October 2026   Version: `61cbb9b` (revision B); the previous revision is `4b05d5d`.
Note: while I read, `main` moved to `f4921ce` (API01 merged from `api-a`); `git diff 61cbb9b HEAD -- specs` is empty, so everything below is about the committed plan.

**Read:** `git diff 4b05d5d 61cbb9b` of `plan_api.py`, `plan_ops.py`, `plan_web.py`, `plan_checks.py`, `build_plan.py` (1,665 lines, all of it); the generated `plan.md` (all) and the tasks of `tasks.md` that those lines touch (MB07, API02, API08, API09, API12, API13/13b, API33/33b, WEB03, RV1, PH01 to PH08, OPS01 to OPS08, IMP02/03, QA02 to QA05); `plan-review.md`, `plan-review-2.md`; `scripts/login-counters.mjs` and its `.d.mts`; spec lines I8, L6, A13, D24, B1, B4 and tests T-C15, T-C19, T-D04, T-D05, T-D24, T-E01, T-E04, T-R01, T-R04 (spec at `7920e6c`); `API-00C-RESULTS.md` l.22 and l.65; `SCHEMA.md` l.11.
**Ran (read-only):** `build_plan.py --check`, `--sched`, `--float`, `--show-ignores` (coverage OK, 242 IDs, 123 tests, 107 tasks; "ignores NOT needed: {}"; `git status` clean afterwards, no `__pycache__`). In a scratch clone under the session scratchpad (outside the repository) I ran the generator with no flag: `plan.md` and `tasks.md` came out byte-identical to the committed ones (they are fresh); I also ran a what-if there (PR3-9). My own scripts: dependency graph plus lane chains plus the lane-O queue (no cycle, no deadlock), "task text names a task that is not its ancestor" scan, counts. Verified: `loginSlot`, `addressKey`, `countAttempt`, `recordFailure`, `closeFinishedHour` are exported by `scripts/login-counters.mjs` (and typed in the `.d.mts`) as MB07 and API08 say; commits `694b435`, `379ef68`, `a2a720b`, `a5790d8` exist; 57.4 plan-days, 65/18/17 task split, 23 tasks over 1.0, largest 1.4, lane totals 5.8/4.5/5.6 and 16.2/12.6/16.2 all recompute. The 227 and 243 cron lengths match `API-00C-RESULTS.md` (161 + 2 x 33 and 2 x 41; review 2's 231 and 247 added the mode word, which the formula already holds).
**Not checked:** no Docker, tests, Hostinger, GitHub or Vercel; I did not re-derive the cut-line prices or the Likely row (the regenerated files match, the arithmetic was not redone); spec coverage beyond the generator's check; `brief.py`; the 80 percent of `tasks.md` that revision B did not touch.

## (a) The 35 earlier findings, one by one
| Finding | Status | Where it is proved (or what is still wrong) |
|---|---|---|
| PR1 domain stale | fixed | PH04 (domain bought, names fixed), PH03 (only `skyblue-...` removed, `flybytheway.com` warning), PH05 early, PH05b, OPS01 shrunk, OPS02w timed wait, OPS03/OPS07/PH05b "domain first, then `JV_BACKUP_DIR`", OPS06 capitals warning, API36 hand-downloaded file. The spec's O38 stays unamended (plan decision 9, Harsh). Stale cross-references: PR3-11, PR3-12 |
| PR2 T-D24/T-D30 in API08 | partly | API08 "writes no new SQL", wraps `login-counters.mjs`; clauses API09/API33/API17/API33b; MB07 records `694b435`. But API09 now needs API08's limiter and cannot have it: PR3-1 |
| PR3 missing edges | fixed | OPS07 and RV4 depend on RV1; OPS01 on API05, API09; API25 on API24; API11, API15 on API10; IMP02 on OPS04; WEB01 Done no longer creates a customer (WEB07 does); the API14 to API04 edge is replaced by the last PT-N1 case in API19's Done |
| PR4 six tests | fixed | T-E01 poll halves WEB04, T-D26 API11, T-C19 real X2 API30, T-C15 I6/I11 API31, T-B26 API31, T-A14 WEB08 (all in `TEST_CLAUSES`). API30's text names the wrong owner for T-C15: PR3-11 |
| PR5 T-A09 bill lines | fixed | API18 and API20 Done-when ("bill and line inputs through `quote_bill`") and clauses |
| PR6 clauses not in Done-when | fixed | `build_plan.py` l.205 now fails when a task extends a test no clause names; every clause is printed as "Also proves" in its owner (by construction, not by key-word check) |
| PR7 `event` rows | fixed | `writeEvent` in API05; clauses API05, API09, API33 for T-D14 |
| PR8 T-D03 | fixed | API20 Done ("no result of `create_bill` or `quote_bill` for a biller"), API31 matrix scan |
| PR9 seeder, keygen, tokens | partly | `seed-volume` in API12, `make-token`/`keygen` in API09, PH06a depends on API09, OPS03 and OPS05 on PH06a. The seeder's user WEB03 has no edge to API12: PR3-7 |
| PR10 IMP03 rollback | fixed | IMP03 Rollback (fresh drill-tested export, new empty database, B5 after the first live bill) |
| PR11 task sizes | partly | API13/13b, WEB12/12b, API33/33b split; API29 and API36 1.2. 23 tasks are still over 1.0, and new work went into tasks without days: PR3-10 |
| PR12 worktrees | fixed | `plan_checks.py` header, plan §1, WEB00 (`JV_API_DIR` = orchestrator's merged `main`) |
| PR13 preview mode and push branch | partly | WEB02/WEB03 text and decision 8 fixed; the step that finally puts the web code on `main` has no owner: PR3-3 |
| PR14 | fixed | WEB14 checks `vercel.json` text; "UNKNOWN keeps G-H shut" in OPS02a/OPS02w/OPS02 and §12; MB07 uses a lane database and says never `db:up` |
| PR15 | fixed | 567 / 25 tables / 87 CHECKs / 18 FKs match `SCHEMA.md`; 1,205 lines; s21 in MB06; `DB09a` and `45a444e` in WEB15; `ALTER` in API03's grep; `withRead` (API03); `tx.trail` (API15) |
| PR16 | fixed | read-only flags (`build_plan.py` ~l.411), dead ignores fail (l.186), ignore reasons must name a clause owner (l.198 to 205); one new Low in the same file: PR3-13 |
| PR17 | fixed | IMP01 Do "ONLY IF PS01 says" (PS01 is not a dependency: PR3-15) |
| PR2-1 to PR2-5 (High) | fixed except as said | PR2-1 = PR1. PR2-2: `schedule(cal=...)` and `place()` apply 3 to 11 Nov to Siddhi's tasks and answers; Likely is now Sat 21 to Mon 23 Nov. PR2-3: §0, §7, §14 drop 31 Oct and 2 Nov, but PH01 still offers them (PR3-2). PR2-4: TW1a, TW1, TW-web, TW-ops in minutes per plan-day (144/432, 120/336); TW-web has no "if it trips" action. PR2-5: OPS02a, OPS02w, OPS03a exist; OPS02's code half is hollow (PR3-4) |
| PR2-6 to PR2-15 (Medium) | fixed except as said | PR2-6 edges (PH06a to OPS03/OPS05, WEB15/WEB16 to OPS04/QA01/RV4/QA02, QA03 to PS06) all present. PR2-7 ruled, not changed (Harsh), but API35/API36 moved to lane A: PR3-14. PR2-8 queue done (`ORCH_ORDER`), Harsh's minutes in §8, no cap on concurrent sessions; the queue order causes PR3-9. PR2-9 to PR2-12, PR2-14, PR2-15 fixed. PR2-13 fixed; OPS07 now depends on IMP02, so production setup waits for Siddhi's final list (stated, accepted) |

## (b) New findings (only in changed lines)
Kind: *small* = defect to fix at once; *Harsh* = a choice.

**PR3-1 | High | small | API09 (and API33) | The admin-door throttle rows are built on a limiter that a later task builds.**
API09 Do: "its throttle rows of A13 use the limiter of API08"; Done-when has three T-D24 admin rows. API08 Do: "`src/auth/limiter.ts` is the one in-memory limiter". API09 depends on API05 only; in lane C API09 is 4th, API08 is 11th (my scan lists API09 to API08 as "unrelated"). The T-D24 admin clause cannot pass in API09, and API09 is the early task that OPS01, PH06a and WEB00 wait for. API33's tick row uses the same limiter with no edge to API08 (only lane order saves it, and §7 says the orchestrator may reassign lanes). Fix: build `limiter.ts` in API09 (or API05); API08, API17, API33 import it; or add API08 before API09 (costs the critical path).

**PR3-2 | Medium | small | PH01 | The go task still offers the early date that §0 says is not offered.**
PH01 Needed: "switch billing before Dhanteras week (only if every gate is green by Thu 29 Oct) or after Bhai Dooj". §0, §7, §14.1 say 31 Oct and 2 Nov are not offered and anything inside 29 Oct to 11 Nov overrules PLAN.md 3.1 rule 4. This is the text Harsh reads when he answers; PR2-3 is only half closed. Fix: one date plan in PH01 (not before Thu 12 Nov, likely the week of 17 Nov).

**PR3-3 | Medium | small | PH02, PH08, QA05, OPS07 | Nothing moves the new web code to the live site.**
PH02 and decision 8: Harsh pushes only `api-web`, "never `main`", until PH08. PH08 only sets `NEXT_PUBLIC_API_URL`, removes `NEXT_PUBLIC_PREVIEW_MODE` and "redeploy[s]"; a redeploy of `main` ships the old demo. No task merges `api-web` into `main` (grep "main" finds none). Fix: PH08 gets "merge `api-web` into `main` in GitHub Desktop and push; Vercel builds production; promote the previous deployment to roll back"; QA05's first sign-in then tests the real site.

**PR3-4 | Medium | small | OPS02 (gate G-H) | Items that need code are in a task that does not depend on the code.**
OPS02 depends on OPS01, OPS02a, OPS02w, OPS03a, API02. Its Do runs "a scheduled GitHub Actions run that calls the tick", "the REAL command of the dump cron job", "a running dump script (pool of one)" and "the dump at about 400 MB". The tick (API33/33b), dump script (API34), workflow and Actions secret (PH06a) are dependencies of OPS03, its successor. Plan §13 says OPS02 uses a stub; the task does not. Fix: say "with the kit as a stub" in OPS02, or move those items to OPS03 and keep G-H on what needs no code.

**PR3-5 | Medium | small | OPS01 | The test page that runs the Safari and Firefox check lost its owner.**
Revision A: "from a static test page served under the website's name on Vercel". Revision B: "login from the website's origin sets `__Host-jv_session`", with only PH04 (DNS), API05/07/09; WEB02 is not a dependency, the Chrome test page was served from a Hostinger proof app, and PH04 repoints the website name to Vercel. Fix: name the page and who builds it (a file on `api-web`, agent C, inside OPS01) or make OPS01 wait for WEB02.

**PR3-6 | Medium | small | PH02, PH05b, OPS03a | The staging app is created from a branch that does not exist yet.**
PH05b: "add a Node.js web app ... (branch `staging`)"; PH02 pushes `main` only; OPS03a is the first push of `staging` and depends on PH05b. Fix: PH02 also pushes a `staging` branch (same commit), or PH05b uses `main` and OPS03a switches the branch.

**PR3-7 | Medium | small | WEB03, API12 | The 2,500-piece hydrate test has no data and no edge to the seeder.**
API12 Do: "the hydrate tests (WEB03) and OPS04 use it"; WEB03 depends on WEB02 and API11 only; best case WEB03 runs day 2.25 to 2.55, API12 ends 2.99. Fix: add API12 to WEB03 (about 0.7 day on lane B in the best case), move the seeder into API11, or let WEB03 build its own fixture.

**PR3-8 | Medium | small (+ Harsh note) | OPS05 Done-when, QA03, spec T-R01 | OPS05 must tick what a later task proves.**
OPS05 Do defers the owner's key proof to QA03 (clause T-R01 to QA03), but its Done-when still says "every check of T-R01 ... is ticked", and RV3 (gate G-B) waits for OPS05. Spec T-R01 says each holder proves it "at drill 1". Fix: "except the owner's copy (QA03)" in OPS05, and tell Harsh the spec test is moved (ledger).

**PR3-9 | Medium | Harsh | `plan_checks.py` ORCH_ORDER, `build_plan.py` place() | The Mon 16 Nov end of the Best range is an artefact of the queue.**
QA02 follows OPS07 in the queue but does not depend on it. Best case: OPS07 ends day 11.59, QA02 (1.5) would end 13.09, the window starts at day 13 (Tue 3 Nov), so `place()` pushes QA02 to day 21 (Thu 12 Nov): nine working days for a 0.09-day overlap. In a scratch re-run with QA02 and QA03 ahead of OPS07 in the queue, Best (Sundays off) is QA05 Thu 12 Nov, not Mon 16 Nov; Worst is unchanged (Fri 4 Dec). Fix: reorder the queue (acceptance needs staging, not production) or print Best as "Thu 12 Nov" and say why.

**PR3-10 | Medium | Harsh | API03, API05, API09, API15, API17, API30, API31 | The fixes moved work into tasks without moving their days.**
The agent total rose 55.9 to 57.4 only through splits and API12, API29, API36 (+0.2 each). Added without days: API09 (two tools, event rows, three throttle rows), API05 (`writeEvent`), API17 (two throttle rows and the ETag map), API03 (`withRead`, S8 body, `ALTER`), API15 (`tx.trail`), API30 (the 28-second T-C19 run), API31 (three clauses). Review 1's PR11 was about under-sized tasks; this half is not answered. Fix: re-price those seven (a guess: +0.2 to +0.4 each) or say they absorb it.

**PR3-11 | Low | small | Wrong pointers and stale names |**
API30 Done: "I6 and I11 are the T-C15 clause of API32" (the registered owner is API31). API13b: "T-C20 lives there" in API19 (T-C20 is API29's). API33b: "the secret is Harsh's, OPS02" (PH06a). OPS01 Rollback and OPS02 Do: "(PH03)" for the removal of the proof apps (PH05b). plan §13 row: "(PH06)" (PH06b). PH07 O19: "creating the Hostinger staging app needs his OK, PH05" (PH05b).

**PR3-12 | Low | small | OPS04, OPS07 and the T-D12/T-E10 clauses, `tasks.md` header |** OPS04: "Siddhi's domain once PH04 is in, else two `hostingersite.com` addresses" (the domain is Harsh's and those addresses answer 403); OPS07 and the clauses: "Siddhi's domain". The tasks.md header says "Generated on 2026-10-16" (core.TODAY).

**PR3-13 | Low | small | `render.py` l.335, `build_plan.py` --sched |** Plan §6's lane-O line prints `ORCH_LANE` and says "ordered by their dependencies, not by a queue"; §8 and the scheduler use `ORCH_ORDER` as a queue (different order: IMP02 before OPS07, IMP03 after QA04). `--sched` prints its "on" column from the Sundays-off run (`RUNS`, not `RUNS_ON`): QA02 shows "on Tue 10 Nov" there, Sat 31 Oct in plan §7.

**PR3-14 | Low | Harsh | `AGENT_ORDER` lane A |** API35 and API36 sit before RV2, and API36 waits for API34 in lane C, so the money-core review (gate G-M) starts 0.45 day (best) to 1.4 days (worst) after API31 ends (RV2 starts 6.24 against 5.79; 21.10 against 19.72). Put RV2 ahead of them.

**PR3-15 | Low | small | Edges that are only in the text |** RV1 depends on API13 but not API13b (settings, rates, customer edits: T-D04/T-D05 are access rules); OPS01 says "API01 to API09" but API08 is not its ancestor; IMP01's conditional half waits for PS01, which is not a dependency; PH03 "latest day: before PH05b" has no edge.

## (c) Verdict: **pass with fixes**
Totals: **0 Critical, 1 High, 9 Medium, 5 Low** (kinds: 12 small, 3 Harsh). Revision B answers all 35 earlier findings in the task text (checked line by line): 27 fully, 7 in part (PR2, PR9, PR11, PR13, PR2-3, PR2-5, PR2-8), and PR2-7 ruled and left on purpose. The skeleton holds: no cycle, no lane deadlock, `--check` passes, plan files are fresh. Fix PR3-1 before lane C reaches API09 (it is the 4th task in that lane) and PR3-2 and PR3-3 before Harsh reads the plan or plans go-live; the rest can be one pass over `plan_*.py` and `render.py`, then `build_plan.py`. PR3-9 and PR3-10 change the dates a little and are Harsh's call. No finding needs the spec to change (O38 still needs its amendment, decision 9).
