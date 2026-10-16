# -*- coding: utf-8 -*-
# Executed by build_plan.py after the checks pass (it shares that file's names). Writes plan.md and tasks.md.

def esc(x):
    return str(x).replace("|", "\\|").replace("\n", " ")

def md_table(rows, head):
    out = ["| " + " | ".join(head) + " |", "|" + "|".join(["---"] * len(head)) + "|"]
    for r in rows:
        out.append("| " + " | ".join(esc(c) for c in r) + " |")
    return "\n".join(out)

def clip(s, n):
    s = str(s)
    if len(s) <= n:
        return s
    return s[:n].rsplit(" ", 1)[0] + " ..."

def ids_text(xs):
    return ", ".join(xs) if xs else "-"

def span(a, b, d=1):
    return f"{a:.{d}f} to {b:.{d}f}"

# ---------------------------------------------------------------------------------------------- the three cases
def mid_durs():
    return {t["id"]: (duration(t, "low") + duration(t, "high")) / 2.0 for t in TASKS}

_s, _f, _w, _d = schedule("mid", mid_durs())
RUNS["mid"] = dict(start=_s, fin=_f, why=_w, durs=_d)
CASE_NAME = {"low": "Best", "mid": "Likely", "high": "Worst"}
LAST_SAFE_BEFORE = core.dt.date(2026, 11, 2)    # last day to switch before Dhanteras week (Mon 2 Nov)
AFTER_FESTIVAL = core.BHAI_DOOJ + core.dt.timedelta(days=1)   # Thu 12 Nov

def golive(d0, cal):
    """The first live day the rule allows, given the day the cut-over could happen."""
    if d0 <= LAST_SAFE_BEFORE:
        return d0, "before Dhanteras week"
    if d0 <= core.BHAI_DOOJ:
        for d in cal:
            if d >= AFTER_FESTIVAL:
                return d, "moved out of Dhanteras week"
    return d0, "after Bhai Dooj"

def end_of(case, tid):
    return RUNS[case]["fin"][tid]

def date_str(case, tid, calname):
    return fmt(date_of(end_of(case, tid), CAL[calname]))

LAST_ID = "QA05"

# ---------------------------------------------------------------------------------------------- group totals
GROUPS = [("pure", "Pure SQL or TypeScript with a written oracle"), ("money", "Money functions, locks, two-session tests, jobs"),
          ("web", "Front end and browser tests"), ("ops", "Hostinger, import, acceptance, drills (with Harsh or Siddhi)"),
          ("review", "Fresh-agent reviews")]
group_rows = []
for g, label in GROUPS:
    ts = [t for t in TASKS if t["grp"] == g and t["status"] == "TODO"]
    pd_sum = sum(t["pd"] for t in ts)
    lo = sum(duration(t, "low") for t in ts)
    hi = sum(duration(t, "high") for t in ts)
    if g == "pure" or g == "money" or g == "web":
        f = FACT[g]
        group_rows.append([label, len(ts), f"{pd_sum:.1f}", f"{f[0]:.2f} to {f[1]:.2f}", span(lo, hi)])
    else:
        group_rows.append([label, len(ts), f"{pd_sum:.1f}" if pd_sum else "-", "explicit per task", span(lo, hi)])
people = [t for t in TASKS if t["who"] and not t["agent"] and t["id"] not in chk.ORCH_LANE]
ppl_lo = sum(duration(t, "low") for t in people)
ppl_hi = sum(duration(t, "high") for t in people)
group_rows.append(["Waiting for people (Harsh, Siddhi, her CA): lead times, mostly in parallel", len(people), "-", "lead times per task", span(ppl_lo, ppl_hi) + " (not additive)"])

total_pd = sum(t["pd"] for t in TASKS if t["status"] == "TODO")
n_todo = sum(1 for t in TASKS if t["status"] == "TODO")
n_done = sum(1 for t in TASKS if t["status"] == "DONE")
n_agent = sum(1 for t in TASKS if t["status"] == "TODO" and t["agent"])
n_people = len(people)
n_orch = sum(1 for t in TASKS if t["id"] in chk.ORCH_LANE)

# ---------------------------------------------------------------------------------------------- latest arrival of people tasks
LFS = {c: latest_finish(c) for c in ("low", "high")}
def latest_date(case, tid, calname):
    return fmt(date_of(LFS[case][tid], CAL[calname]))

people_rows = []
for t in TASKS:
    if not (t["who"] and not t["agent"] and t["id"] not in chk.ORCH_LANE):
        continue
    s_lo = RUNS["low"]["start"][t["id"]]
    s_hi = RUNS["high"]["start"][t["id"]]
    f_lo = RUNS["low"]["fin"][t["id"]]
    f_hi = RUNS["high"]["fin"][t["id"]]
    soft = " (soft: the default ships)" if t["soft_before"] and t["id"] in ("PH07", "PS04", "PS05") else ""
    people_rows.append([t["id"], t["who"], clip(t["title"].split(": ", 1)[-1], 110), f"{t['lead'][0]} to {t['lead'][1]}",
                        f"{fmt(date_of(f_lo, core.CAL_OFF))} to {fmt(date_of(f_hi, core.CAL_OFF))}",
                        latest_date("low", t["id"], "off") + soft, latest_date("high", t["id"], "off") + soft])

# ---------------------------------------------------------------------------------------------- scenario table
rows_dates = []
GO = {}
for case in ("low", "mid", "high"):
    for cal in ("off", "on"):
        d0 = date_of(end_of(case, LAST_ID), CAL[cal])
        eff, why = golive(d0, CAL[cal])
        GO[(case, cal)] = (d0, eff, why)
        rows_dates.append([CASE_NAME[case], "Sundays off" if cal == "off" else "Sundays worked",
                           date_str(case, "RV2", cal), date_str(case, "OPS07", cal), date_str(case, "QA02", cal),
                           date_str(case, "QA04", cal), fmt(d0), fmt(eff) + f" ({why})"])

def cp_text(case):
    r = RUNS[case]
    cp = critical_path(r["fin"], r["why"], max(r["fin"], key=lambda x: r["fin"][x]))
    return " > ".join(cp)

# ---------------------------------------------------------------------------------------------- cut line, priced
def cut_run(case, adj):
    durs = dict(RUNS[case]["durs"])
    for k, v in adj.items():
        durs[k] = max(durs[k] * v, 0.0) if isinstance(v, float) and v <= 1 else durs[k]
    s, f, w, d = schedule(case, durs)
    return f

CUTS = [
    ("1", "X11 refund: API28 and the refund form of WEB11. A mistaken receipt is voided instead.", {"API28": 0.0, "WEB11": 0.8}),
    ("2", "The review line I11 and the list-price report (R14 reporting): the columns stay, the report goes (a third of API32).", {"API32": 0.65}),
    ("3", "Rewiring the Reports screen to the shared selectors: hide Reports instead (O32) (a third of WEB12).", {"WEB12": 0.65}),
    ("4", "The rate card by purity and the stale-rate guard (WEB16): billing stays correct because the rate is editable on every line (P3-T2 of PLAN.md).", {"WEB16": 0.0}),
]
cut_rows = []
for num, label, adj in CUTS:
    parts = []
    for case in ("low", "high"):
        base = RUNS[case]["fin"]
        f2 = cut_run(case, adj)
        parts.append(f"{base['RV4'] - f2['RV4']:.2f}")
    cut_rows.append([num, label, parts[0], parts[1]])
all_adj = {}
for _, _, adj in CUTS:
    all_adj.update(adj)
all_save = []
for case in ("low", "high"):
    f2 = cut_run(case, all_adj)
    all_save.append(f"{RUNS[case]['fin']['RV4'] - f2['RV4']:.2f}")

# ---------------------------------------------------------------------------------------------- tripwires
tw1_pd = BY_ID["API21"]["pd"] + BY_ID["API22"]["pd"]
tw1_lo, tw1_hi = tw1_pd * FACT["money"][0], tw1_pd * FACT["money"][1]

# ---------------------------------------------------------------------------------------------- plan.md
today = core.TODAY.strftime("%A %d %B %Y")
O = []
w = O.append

w("# Plan: P1 foundation and money (JewelVault on Node.js + MariaDB 11.8 at Hostinger, front end on Vercel)")
w("")
w(f"Status: **DRAFT 1**, written on {today} against `spec.md` draft 5.2 (commit `7920e6c`, {len(lines)} lines, "
  f"{len(spec_ids)} requirement and open-item IDs, {len(spec_tests)} tests; reviewed three times, no Critical). It replaces "
  "the plan for the Supabase stack (`jewelvault-app/specs/p1-foundation-and-money/plan.md`, 52 tasks, 10 done and now frozen; "
  "only `FE01`, the integer pricing code, survives). Not yet reviewed: task `RV0` is that review, by two fresh agents; the "
  "writer does not review this plan. `plan.md` and `tasks.md` are generated by `_plan-build/build_plan.py` from the "
  "`plan_*.py` files beside it, which also check them against the spec and the two repositories (appendix); change the data, "
  "never the generated files.")
w("")
w("Maps to: `PLAN.md` phases P1 (foundation) and P2 (money), the data side of P3-T4, and, because they stand on the go-live path, "
  "P3-T1 (printed estimate), P3-T2 (rate card by purity), P3-T5 to P3-T8 (regression, acceptance, training, drills) and P4 "
  "(go-live and the first two weeks). Not in this plan: M2 (bill edit, Order Book, public catalogue, stock search, tags scanning, "
  "tax invoices, the staff screen), the monthly sweep of unattached photos (spec P6), and any edit of `NODE-DESIGN.md` (the design "
  "session's file; where it disagrees with the spec, the spec governs, spec 18.13 D).")
w("")
w("## 0. In one page")
w("")
w(f"- **{len(TASKS)} tasks** ({n_done} done, {n_todo} to do): {n_agent} for the three agents ({total_pd:.1f} plan-days), {n_orch} run by the orchestrator with Harsh or Siddhi (Hostinger, import, acceptance, go-live), "
  f"{n_people} are people's tasks (Harsh, Siddhi, her CA). Every one of the {len(spec_ids)} spec requirement and open-item IDs is on exactly one task (4 exempt, with reasons) and every one of the {len(spec_tests)} tests is introduced by exactly one task (appendix).")
w(f"- **No date is promised.** First live day under the festival rule: **{fmt(GO[('low','on')][1])}** at the very best (Sundays worked) or **{fmt(GO[('low','off')][1])}** (Sundays off, the cut-over day would fall in Dhanteras week and moves); "
  f"most likely **{fmt(min(GO[('mid','off')][1], GO[('mid','on')][1]))}** to **{fmt(max(GO[('mid','off')][1], GO[('mid','on')][1]))}**; worst **{fmt(GO[('high','on')][1])}** to **{fmt(GO[('high','off')][1])}** (section 7).")
w("- **What the dates depend on:** the speed of the money, browser and Hostinger tasks (never measured: tripwire TW1 at `API21` + `API22`), Hostinger passing the proof with the real domain and the narrowed rights (`OPS01`, `OPS02`), and four inputs from people that sit close to the critical path: "
  "Harsh's go, Siddhi's own domain, her full stock list and balances, and her business answers (section 8, with the latest day for each).")
w("- **The longest chain** runs through the money core (agent A) and the rest of the API (agent C), then staging, the backup drills, the three reviews, the regression, the acceptance by her two testers, the training, the go or no-go and the cut-over (section 6).")
w("- **Never switched in Dhanteras week** (Tue 3 to Wed 11 Nov); the paper bill book stays for ten days after go-live; the cut line and the never-cut list are in section 10.")
w("")
w("## 1. Design: the simplest approach that meets the spec")
w("")
w("- **Backend first, and most of its database half exists.** The order Harsh asked for (\"pehle Backend\") stays. What is built "
  "and green in `jewelvault-api` (521 tests on 15 Oct 2026): the schema, the create-only migration runner, the four derived "
  "reads as query files, the invariant SQL, the health query, export, photo copy, restore, the import and the rebalance "
  "library (section 2). The Node API (`src/`) does not exist yet: it is tasks `API01` to `API36`.")
w("- **Money rules run in Node, on the same `pricing.ts` file the screen uses** (a byte-identical copy with a hash check, spec C12), "
  "inside one transaction per service function, with one lock order (customer, then pieces by one `ORDER BY id FOR UPDATE` "
  "statement, then the number counter last), repeat-safety by the `Idempotency-Key` claim, and no `DELETE` anywhere (spec S7).")
w("- **Two repositories.** `jewelvault-api` (private on GitHub once Harsh pushes it; deployed to Hostinger by its GitHub app) holds the "
  "database half and the API. `jewelvault-app` (Vercel) holds the static site; its Supabase pieces (`authStore.ts`, "
  "`supabase/client.ts`, the Supabase lane scripts and migrations) are replaced by an API client and removed in `WEB15`, together "
  "with preview mode. The stores keep their exported names, so about 15 files that write data change, not all 37 (spec section 5).")
w("- **Test tools.** Vitest on a throw-away MariaDB 11.8 in Docker with its data in tmpfs (no volume, removed with `docker rm -fv` "
  "of its own name; the guard container `keep-tourstack-and-unknown-volumes` is never touched), Fastify `inject()` for HTTP tests, "
  "Playwright for the browser, small scripts for BUILD checks, written logs for DRILLs. **Every test is written first and seen "
  "failing for the right reason** (Playbook 3.3); each spec test is a `describe('T-xxx ...')` block, so `npm test -- -t T-C09` "
  "finds it. The database server is set to Hostinger's non-strict `sql_mode` and READ-COMMITTED so the tests prove the API's own "
  "per-connection settings, and the application user is the ten-box user of spec A3.")
w("- **Next.js 16 is not the Next.js the agents know.** `jewelvault-app/AGENTS.md` says its APIs and file structure may differ from training data: every "
  "front-end agent reads the relevant guide in `node_modules/next/dist/docs/` before writing code, and heeds the deprecation notices (the site is a static "
  "export: no server code, no rewrites or headers in `next.config`; headers go in `vercel.json`, spec H1).")
w("- **One lane, one database.** Each agent has its own MariaDB container (`jv-mariadb-<lane>`, port 33310 plus the lane number: main, a, "
  "b, c) from `npm run db:lane`, because two agents on one database would reset each other's data. The application opens one pool of "
  "8; tests and tools pace themselves to 10 new connections in 1.2 seconds (Hostinger refuses the 21st new connection inside about "
  "a second).")
w("- **Three agents at most at once** (Playbook 1): **A** the money core, **B** the front end, **C** the rest of the API, side tasks and "
  "the reviews. The **orchestrator** (the main session) is not an agent: it merges locally, runs the tasks that need Harsh at "
  "hPanel (lane O), keeps the ledger and tells Harsh in short Hinglish. Each agent works in its own `git worktree` on its own "
  "branch (`api-a`, `api-c` of `jewelvault-api`; `api-web` of `jewelvault-app`); the old Supabase worktrees "
  "(`jewelvault-wt/a`, `b`, `c`) are not used. One local commit per task: what changed, the spec IDs it covers. **Nothing is "
  "pushed or pulled by any agent; Harsh pushes** (his GitHub account `iamharshvishwas`), and after each commit the orchestrator "
  "says which branch and commit are ready.")
w("- **One owner per function.** A service function X1 to X12 is edited only by the task that first creates it, with its final "
  "signature from its first commit; what a later task adds, it adds in a helper that the function already calls "
  "(`rebalance`, `cashRules`, `state`, `touch`), so two agents never edit one function. A bug found in another task's function goes to the "
  "orchestrator.")
w("- **Migrations** stay forward-only and create-only (spec S9). Until the first one is applied to a real Hostinger database "
  "(`OPS03`), a migration file may still be edited by the database session's alignment work (`MB05`, `MB07`); after that, every change is "
  "a new file and the runner refuses edits. `db/` is changed only through `MB06` and the tasks that name a migration.")
w("- **Hostinger rules the code follows** (measured on Harsh's plan on 15 and 16 Oct 2026, `HOSTINGER-SPIKE.md`): no request over "
  "about 50 seconds (a 60-second cut gives a 504); one pool of 8 and at most 20 new database connections a second; every "
  "connection sets `wait_timeout` 300; only Custom-type cron jobs (the Node.js type cannot be listed or deleted); nothing durable in the build "
  "folder; every deploy starts the app twice about 10 seconds apart; `x-real-ip` is the visitor's address; the app reaches the "
  "database at `127.0.0.1`.")
w("")
w("## 2. What already exists, and what is aligned first")
w("")
done_rows = []
for t in TASKS:
    if t["status"] == "DONE":
        done_rows.append([t["id"], t["title"].replace("DONE: ", ""), t["commit"], ids_text(t["reqs"][:12]) + (" ..." if len(t["reqs"]) > 12 else ""), ids_text(t["tests"])])
w(md_table(done_rows, ["Task", "What", "Commit", "Spec lines it owns", "Spec tests it proves"]))
w("")
w("The ids `MB01` to `MB07` are new on purpose: the old plan's `DB01` to `DB05`, `DB07`, `DB08`, `DB01b` and `FE02` (nine finished tasks on Supabase and Postgres, merged "
  "into `jewelvault-app` main) are frozen, are not reused and are removed from the repository by `WEB15`; only the old `FE01` carries over under its own id.")
w("")
w("The whole repository ran **521 tests green on 15 Oct 2026** (`npm run db:up`, `npx vitest run`, about 1 to 2 minutes). The "
  "database session aligned `db/` to spec 5.2 in two commits on 16 Oct (`MB05`: `379ef68` at 14:53, `a2a720b` at 15:15: correlated "
  "reads, health figures, the encrypted export writer, the backup-folder rules, pacing, admin SQL, caps), `MB07` closes the checklist "
  "(two items are still open: the text of `BACKUP-RESTORE.md` and a function that closes finished login-failure hours, assigned to "
  "`API34` and `API33`), and the audit trigger set is the one database piece still to finish (`MB06`: the database session had started it in the working tree at about 15:30 on 16 Oct, `db/optional/0910_audit_triggers.sql`, `scripts/audit-triggers.mjs`, `s20-audit-triggers`, not yet committed). Nothing has been applied to Hostinger. The converter from Siddhi's sheet does not exist because the "
  "sheet has not been seen (`IMP01`). `FE01` (`pricing.ts` 533 lines, `selectors.ts` 465 lines, 323 unit tests) is unchanged and "
  "is the file the API copies.")
w("")
w("## 3. Tests")
w("")
w(f"The spec defines {len(spec_tests)} tests (section 15). A test is **introduced** in the one task where everything it exercises exists "
  "(the generator checks this against the dependency graph, with a printed list of every name in a test's Req column that is "
  "deliberately finished by a later task: appendix); a task that **extends** a test writes a part of it (a clause of the test, "
  "named in the appendix with its owner). Catalogue-based tests (T-D01, T-D02, T-D09, T-D10, T-D11) are written once and cover every "
  "route or function added after them. The plan adds named plan tests (`PT-...`) where the spec has none. **Suites:** `npm test` "
  "(everything in `jewelvault-api`, about 1 to 2 minutes now, more later), `npm run test:http` style subsets by `-t`, `npm run "
  "check:static` and `check:pricing`, `npm run verify` (typecheck, build, checks, all tests); in `jewelvault-app` `npm test` "
  "(unit), `E2E=1 npm run verify` (Playwright against a lane); DRILL logs in `docs/drills/`. A task is done only when every suite "
  "that existed before it is still green.")
w("")
test_rows = []
for t in TASKS:
    if t["tests"] or t["extends"] or t["ptests"]:
        test_rows.append([t["id"], clip(t["title"].replace("DONE: ", ""), 64), ids_text(t["tests"]), ids_text(t["extends"]),
                          "; ".join(p.split(" ")[0] for p in t["ptests"]) or "-"])
w(md_table(test_rows, ["Task", "Title", "Tests introduced", "Extends", "Plan tests"]))
w("")
w("## 4. Tasks")
w("")
w(f"The full text of each task is in `tasks.md`; this is the list. **The unit.** A *plan-day* is the planning unit of `PLAN.md`: the work "
  "an implementer is expected to finish in one focused day, tests and commit included. It is not elapsed time and it is "
  "untested for everything in this plan except pure database and pure TypeScript work (section 5). Days are estimated from the "
  "spec lines a task owns, plus or minus 30 percent; no implementer task is over 1.5 and the generator fails above that. "
  f"**{len(TASKS)} tasks**: {n_done} done, {n_todo} to do ({n_agent} for agents, {n_orch} run by the orchestrator with Harsh or Siddhi, "
  f"{n_people} are people's tasks), **{total_pd:.1f} plan-days** of work for agents ({sum(1 for t in TASKS if t['status']=='TODO' and t['pd']>1.0)} tasks are over 1.0, the largest is {max(t['pd'] for t in TASKS if t['status']=='TODO'):.1f}), of which the Node API {sum(t['pd'] for t in TASKS if t['lane']=='API'):.1f}, "
  f"the front end {sum(t['pd'] for t in TASKS if t['lane']=='WEB' and t['status']=='TODO'):.1f}, the database alignment and the audit triggers {sum(t['pd'] for t in TASKS if t['lane']=='MB'):.1f}, "
  f"the import converter {BY_ID['IMP01']['pd']:.1f} and the regression {BY_ID['QA01']['pd']:.1f}; reviews, Hostinger work, acceptance and training are given as explicit elapsed time, not plan-days.")
w("")
task_rows = []
for t in TASKS:
    if t["status"] == "DONE":
        task_rows.append([t["id"], "done", "DONE: " + clip(t["title"].replace("DONE: ", ""), 96), "-", "-", "-"])
        continue
    who = t["agent"] or ("O" if t["id"] in chk.ORCH_LANE else (t["who"] or "-"))
    if t["agent"]:
        who = t["agent"]
    pd = f"{t['pd']:.1f}" if t["pd"] else "-"
    el = span(duration(t, "low"), duration(t, "high"), 2)
    task_rows.append([t["id"], who, clip(t["title"], 110), ", ".join(t["deps"]) or "-", pd, el])
w(md_table(task_rows, ["Task", "Who", "Title", "Depends on", "Plan-days", "Elapsed working days (best to worst)"]))
w("")
w("**Who:** A, B, C = Claude agents; O = the orchestrator with Harsh or Siddhi; WITH-HARSH, WITH-SIDDHI, WITH-CA = a person's task "
  "(elapsed time is the lead time before the answer is in hand). Rollback and the tests of each task are in `tasks.md`.")
w("")
w("## 5. Honest estimates")
w("")
w("**What was measured.** On the Supabase build (`Completion-Plan/_build/p1-plan/unit-samples.csv`) 11 tasks took 417 agent minutes for 10.9 "
  "plan-days: about **38 minutes a plan-day** (a working day of 8 hours is 480 minutes, so 0.08 of a day), all of them pure database or "
  "pure TypeScript tasks with a written oracle, plus 20 to 25 minutes of the orchestrator's own check on some; the first five "
  "database tasks (5.3 plan-days) took 4.1 hours. The new database half ran faster still (steps 1 to 3 and the three "
  "remaining jobs in about one working day each). **What was never measured:** a money write function, a two-session "
  "concurrency test, a Playwright test, a Hostinger deploy, an import, anything that waits for a person.")
w("")
w("**So each task has a speed group with a low and a high factor** (elapsed working days of the chain per plan-day, "
  "`_plan-build/plan_core.py`), and the plan reports every date as *best*, *likely* (the average) and *worst*:")
w("")
w(md_table([["pure", "0.12", "0.40", "the measured 0.08 plus the orchestrator's check and merge; the worst case is three times the best"],
            ["money", "0.30", "0.90", "none measured; the best case is 3 to 4 times the measured pure speed because one flaky interleaving costs a day"],
            ["web", "0.25", "0.70", "browser tests are slow and flaky; the stores touch about 15 files"],
            ["ops, reviews, acceptance, people", "explicit", "explicit", "Hostinger clicks with Harsh at the screen, a fresh reviewer and its fix round, two testers for two days, Siddhi's sheets: set per task, never scaled by agent speed"]],
           ["Group", "Best", "Worst", "Why"]))
w("")
w(md_table(group_rows, ["Group", "Tasks", "Plan-days", "Factor (elapsed days per plan-day)", "Sum of elapsed working days, best to worst"]))
w("")
w("The sums are not the schedule: three agents work side by side, and most waiting on people happens in parallel. The schedule is in section 7.")
w("")
w("## 6. Order, agents and the critical path")
w("")
for a, order in chk.AGENT_ORDER.items():
    names = {"A": "Agent A (money core)", "B": "Agent B (front end)", "C": "Agent C (rest of the API, side tasks, reviews)"}[a]
    busy_lo = sum(RUNS["low"]["durs"][x] for x in order)
    busy_hi = sum(RUNS["high"]["durs"][x] for x in order)
    w(f"- **{names}** (busy {busy_lo:.1f} to {busy_hi:.1f} working days): " + " > ".join(order))
w(f"- **Orchestrator with Harsh or Siddhi (lane O):** " + " > ".join(chk.ORCH_LANE) + " (ordered by their dependencies, not by a queue)")
w("- **People:** " + ", ".join(t["id"] for t in people))
w("")
w("The longest chain of work, in the best case, runs through the agent lanes and ends in the shop: `" + cp_text("low") + "`.")
w("")
w("In the worst case: `" + cp_text("high") + "`.")
w("")
tight = []
for t in people:
    fl = LFS["low"][t["id"]] - RUNS["low"]["fin"][t["id"]]
    if fl < 3.0:
        tight.append(f"{t['id']} ({fl:.1f})")
w("Two things follow. First, **in all three cases the chain is carried by the agents' lanes and the Hostinger work, not by one person**: the money chain "
  "(A) and the lane that carries login, reads, edits and the jobs (C) decide how soon the code is ready, and the front end (B) follows them closely. "
  "Second, **the people are never far behind**: in the best case the inputs with less than 3 working days of float are " + ", ".join(tight) +
  " (float in brackets, section 8); a week's delay in any of them moves the date by about a week. In the worst case the agents are far "
  "later than the people and the people tasks have room, so the date is the agents' date.")
w("")
w("## 7. Dates")
w("")
w("In the *Sundays worked* column the plan also assumes that Harsh and Siddhi answer on Sundays; if they do not, read their tasks from the *Sundays off* column.")
w("")
w("**No go-live date is promised.** The plan gives a range from the critical path, and says what each date depends on. Day 1 is Sat 17 Oct 2026 "
  "(the plan review `RV0`); Dussehra (Tue 20 Oct) and Diwali (Sun 8 Nov) are off in every scenario; *Sundays off* means no other Sunday is "
  "worked, *Sundays worked* means they all are. **Dhanteras is Fri 6 Nov, Diwali Sun 8 Nov, Bhai Dooj Wed 11 Nov 2026, and the shop should "
  "not switch billing in that week:** the plan allows a cut-over on or before **Mon 2 Nov** (only if the go or no-go was signed with a "
  "clear working day to spare) or from **Thu 12 Nov**; a cut-over day that falls on 3 to 11 Nov moves to Thu 12 Nov.")
w("")
w(md_table(rows_dates, ["Case", "Calendar", "Money core reviewed (RV2)", "Production ready (OPS07)", "Acceptance done (QA02)", "Go or no-go (QA04)", "Cut-over day could be", "First live day under the festival rule"]))
w("")
best_off = rows_dates[0]; best_on = rows_dates[1]; likely_off = rows_dates[2]; likely_on = rows_dates[3]; worst_off = rows_dates[4]; worst_on = rows_dates[5]
w("**The honest reading.**")
w("")
w(f"- *Earliest sensible go-live:* **{fmt(GO[('low','on')][1])}** if everything goes at the best factor and Sundays are worked, **{fmt(GO[('low','off')][1])}** with Sundays off "
  f"(the cut-over day itself would be {fmt(GO[('low','off')][0])}, which is in Dhanteras week). It holds only if "
  "every agent task runs at the best factor, no review finds a High, Hostinger passes API-00c at the first attempt, Siddhi's domain "
  "is connected and her full stock list and balances are in hand about a week from the day Harsh asks, her two testers are free for "
  "two days, and nothing is asked of Harsh that he cannot answer the same day. Nothing measured says the money, browser and "
  "Hostinger tasks will run at that speed; the first real measurement is tripwire TW1 (section 9).")
_lk = sorted([GO[("mid", "off")][1], GO[("mid", "on")][1]])
w(f"- *Most likely:* **{fmt(_lk[0])}** to **{fmt(_lk[1])}** (the average of the best and worst factors).")
w(f"- *Worst case:* **{fmt(GO[('high','off')][1])}** (Sundays off) or **{fmt(GO[('high','on')][1])}** (Sundays worked), which is also the date if the tripwire shows the high factors.")
w("- *Fallback:* if the cut-over cannot happen by Mon 2 Nov, the date is **Thu 12 Nov or the first working day after the worst-case gates**, never a day in 3 to 11 Nov; "
  "the paper bill book stays the system of record until the go or no-go is signed and for ten days after.")
w("- The dates move one-for-one with: Harsh's go (`PH01`), the domain (`PH04`), Siddhi's full data (`PS03`) and testers (`PS07`), and every "
  "fresh review that finds a High (RV1, RV2, RV3, RV4 each assume one fix round inside their elapsed time).")
w("")
w("**Critical-path detail** for the best and worst case is the list in section 6. The latest day each person's input can arrive, without moving "
  "the best-case date (and the worst-case date), is in section 8; the tripwires that tell Harsh which case he is in are in section 9.")
w("")
w("## 8. What the build waits for from people, and the latest day it can arrive")
w("")
w("Nothing in this plan is assumed done that Harsh has not done. The ask is made on the day Harsh gives the go (`PH01`, best case Sat 17 Oct). "
  "\"Lead\" is the guess of working days between the ask and the answer in hand (judgement, no source: nobody has measured how fast "
  "Siddhi answers). \"Latest arrival\" is the latest day the input can arrive without moving the date of the case, counting only "
  "dependencies (the agent lanes are ignored, so it is slightly generous).")
w("")
w(md_table(people_rows, ["Task", "Who", "What is needed", "Lead (working days)", "Arrives (best to worst, Sundays off)", "Latest to hold the best-case date", "Latest to hold the worst-case date"]))
w("")
w("Hostinger work that needs Harsh at hPanel is lane O: `OPS01` (real domain and cookie), `OPS02` (the rest of the proof with exactly "
  "the ten boxes, Hostinger's restore points), `OPS03` (staging deploy, cron, rollback tried), `OPS08` (three nights), `OPS04` "
  "(real-network checks), `OPS05` (backup drills), `OPS06` (runbook), `OPS07` (production, the real pair, drill 2), `IMP02`/`IMP03` "
  "(import rehearsal and production import) and `QA02` to `QA06`. Each says in `tasks.md` what Harsh does with his hands.")
w("")
w("## 9. Tripwires")
w("")
w(f"- **TW1, the one to trust (first money write function with its two-session tests): `API21` + `API22`**, {tw1_pd:.1f} plan-days. Best case "
  f"{tw1_lo:.2f} working days, worst {tw1_hi:.2f}; planned finish {date_str('low','API22','off')} (best) to {date_str('high','API22','off')} (worst), Sundays off. "
  f"If both take **under 0.8 working day**, the best case stands; if they take **over 1.4**, the worst case applies and the orchestrator tells Harsh "
  "that the go-live moves, with the new range recomputed by this script. In between, the likely case. The first five tasks (`API01` to `API05`) are pure "
  "work and prove little, as the old plan's `DB01` to `DB05` (Supabase) proved little.")
w("- **How the measurement is kept:** every finished task adds one row to `jewelvault-api/docs/unit-samples.csv` (task, plan-days, agent minutes, "
  "orchestrator-check minutes, kind), as the Supabase build did in `unit-samples.csv`; the orchestrator recomputes the range with this script "
  "after TW1 and after TW2 and tells Harsh in Hinglish.")
w("- **TW2, second measurement: `API31`** (random sequences, three seeds, the matrix) and `RV2`'s mutation findings. A High finding that needs a redesign "
  "of a lock or of the rebalance moves the worst case by about 2 working days each time and is reported at once.")
w("- **TW3, `OPS01`** (real domain and cookie): Hostinger refuses the domain, or the `__Host-` SameSite=Strict cookie fails in Safari or Firefox on the "
  "real names. STOP and re-plan the name pair or put the API behind the website's own origin by a Vercel rewrite (spec A12); a no-go on the host "
  "goes to Harsh (O44: a priced VPS comparison before any money is spent). Latest day for the domain to be ready: section 8.")
w("- **TW4, Siddhi's data:** if the sample sheet (`PS02`) is not in hand by its latest day in section 8, `IMP01` slips; if the full list "
  "(`PS03`) is not usable by its latest day, go-live slides day by day and Harsh tells her.")
w("- **TW5, `OPS02`:** a FAIL for the dump script as a Custom cron job (killed by a CPU or process limit) or for `GET_LOCK` on the ten-box user "
  "reopens the design of the nightly dump (spec I8 (B)); the manual fallback is the same export run from Harsh's Mac through Remote MySQL, "
  "which is itself untried.")
w("")
w("## 10. Budget and cut line")
w("")
w("Budget: the days of section 7, nothing is bought by this plan except what Harsh decides (the domain in Siddhi's name, about Rs 800 to 1,500 "
  "a year, her cost and the writer's estimate with no source; a Hostinger renewal; a VPS only if the proof fails). If a gate is late, "
  "cut in this order, one item at a time, and tell Harsh each time. Prices are days saved on the finish of the last code gate (`RV4`):")
w("")
w(md_table(cut_rows, ["#", "Cut", "Best case (working days saved)", "Worst case (working days saved)"]))
w("")
w(f"All four together save {all_save[0]} (best) to {all_save[1]} (worst) working days. The cut line is a last resort, not a plan, because the chain runs through "
  "the money core, the jobs and the people, not through these items. **Never cut:** the lock order and idempotency (`API14`, `API15`, `API20`, "
  "`API22`, `API29`), the role matrix and the owner-only weight (`API04`, `API11`), the cash and PAN rules (`API23`), the invariants and the nightly "
  "check (`API32`, `API33`), the backup job and restore drills 1 and 2 (`API34`, `API36`, `OPS05`, `OPS07`), her data and the reconciliation "
  "(`IMP01` to `IMP03`), the Hostinger go-live conditions (restore points, a pulled copy, renewal, Siddhi told: `OPS02`, `OPS05`, `PH06`, `PS06`), the reviews "
  "`RV1` to `RV3`, hiding the unfinished screens (spec C15), T-B14 with three seeds and T-C15's stress run. If the cuts are not enough, the answer is a "
  "later go-live, not a thinner safety net.")
w("")
w("## 11. Deploy, rollback, nightly checks, backups and drills")
w("")
w("- **Deploy (staging, then production):** Harsh pushes the `staging` (later `main`) branch of the private repository from GitHub Desktop; Hostinger's "
  "GitHub app builds it (`tsc` on its side, entry `dist/server.js`). Environment variables are typed by Harsh in hPanel, never in chat; changing one "
  "redeploys. **Every deploy starts the app twice about 10 seconds apart, so nothing is tested for 30 seconds afterwards; production deploys "
  "and variable changes happen only when the shop is closed.** `OPS03` writes `DEPLOY.md` with the exact clicks and times.")
w("- **Rollback:** the API by a revert commit pushed and redeployed (`OPS03` tries it once on purpose); the website by promoting the previous "
  "Vercel deployment; a bad migration is fixed forward with a new file (the runner refuses edits), and a damaged database is restored "
  "into a NEW empty database (the application user has no Drop), keeping the old one until the owner agrees (spec B5, `RUNBOOK.md`).")
w("- **Nightly checks:** the hourly tick (`curl` from a Custom cron job, plus a scheduled GitHub Actions call as the second caller) runs the "
  "nightly check after 02:00 Asia/Kolkata once a day, writes `check_runs`, closes login-failure hours, empties old idempotency results and copies photos; "
  "the dump is a separate Node script from a second Custom cron job (one snapshot, never sliced). The owner's dashboard line turns red after 26 hours; the "
  "failing workflow e-mails the repository owner; Harsh reads the check each morning for the first two weeks (`QA06`), and for three nights on staging before "
  "go-live (`OPS08`).")
w("- **Backups:** nightly encrypted export and once-only photo copies in the backup folder on the plan (`JV_BACKUP_DIR`), Hostinger's own daily backup, "
  "Harsh's weekly pull to his Mac (O54) and the owner's monthly Download everything: the only copies outside the account. Siddhi is told in plain "
  "words that up to 35 days of entries and all photos could be lost with the account (`PS06`).")
w("- **Drills:** drill 1 into Docker on the Mac (`OPS05`), drill 2 into a second Hostinger database through Remote MySQL (`OPS07`), drill 3 seven days "
  "after go-live (`QA06`); the balance rebuild from the zip, the weekly pull and the three admin commands once each (`OPS05`); the runbook is accepted "
  "when someone who did not write it restores the throw-away copy (`OPS06`).")
w("")
w("## 12. Gates and reviews")
w("")
w(md_table([
    ["G-P plan gate", "after the plan is written", "RV0 (two fresh agents)", "every finding closed or ruled; the generator prints 'coverage OK'; Harsh says go (PH01)"],
    ["G-H Hostinger gate (final)", "after OPS01 and OPS02", "the two addenda to HOSTINGER-SPIKE.md", "the real domain, the cookie in three browsers, the ten-box suite, GET_LOCK, the Custom-cron dump, Remote MySQL, SFTP and Hostinger's restore points all PASS; a FAIL is a finding for Harsh (TW3, TW5)"],
    ["G-A access gate", "after the core API and WEB02", "RV1", "no open Critical or High; the generated cell tests green; every deliberate breakage failed a test"],
    ["G-M money gate", "after API29 to API31", "RV2", "all A, B and C tests green three times in a row; each mutation of the reviewer failed a test; no deadlock in the stress run"],
    ["G-B backup gate", "after API34 to API36 and OPS05", "RV3", "no open Critical or High; drill 1 under 2 hours; the pull and the balance rebuild proved"],
    ["G-E end-to-end gate", "after the screens, OPS04, RV2 and RV3", "RV4", "a hand billing day on staging works; the printed estimate is right for 1, 6 and 40 items; the 10-second hydrate is measured"],
    ["G-UAT", "after the rehearsal import", "QA02", "both testers pass the day-to-day script without help"],
    ["G-GO go or no-go", "the day before cut-over", "QA04 (Harsh signs)", "every line ticked (listed in QA04); an unticked line is a no-go"],
], ["Gate", "When", "Review", "Passes when"]))
w("")
w("## 13. Risks and what the plan does about them")
w("")
w(md_table([
    ["The unit is wrong for money, browser and Hostinger work (never measured)", "Three cases, not one date; TW1 and TW2 say which case it is; the worst case is in section 7."],
    ["Siddhi's data, the domain, her testers or her CA arrive late (the path is people-bound in the best case)", "Leads and latest days in section 8; one message asks for everything at once; the staging rehearsal runs on a first complete version; go-live slides day by day and Harsh tells her."],
    ["Hostinger refuses the domain, the cookie fails in Safari or Firefox, or the narrowed ten-box user breaks something the all-boxes proof did not", "OPS01 and OPS02 come early and are a gate; fallbacks: another name pair, a Vercel rewrite of the API, a priced VPS (O44)."],
    ["The dump cannot run as a Custom cron Node script (CPU or process kill), or `GET_LOCK` is not allowed", "OPS02 tests it with a stub first; fallback: the same export run from Harsh's Mac through Remote MySQL; if both fail, a smaller dump or another place to run it (spec I8 (B))."],
    ["One account holds the database, every export and Hostinger's own backup; the plan ends on 22 March 2027", "Weekly pull and monthly download are duties with a dashboard card and a health flag; Siddhi is told in plain words; renewal with auto-renew and a reminder is a go-live condition (PH06)."],
    ["Dhanteras week", "No cut-over in 3 to 11 Nov; a change freeze for anything but critical fixes through Bhai Dooj; the paper bill book runs alongside for ten days."],
    ["Three agents, an orchestrator and fresh reviewers hit the session usage limit (it hit the QA run: Playbook 8)", "Bounded prompts, results saved to files after every step, heavy suites run once per task and at merge (`npm run verify`), an agent resumes from its saved file."],
    ["Two-session tests are flaky", "One gate per session, a polling wait of under 3 seconds, both release orders, three runs in a row before a task counts, a negative control for every lock."],
    ["Pricing drifts between the app and the API", "`check:pricing` compares SHA-256 values in the verify of both repositories; `me` returns the API's hash and the screen disables Save on a mismatch."],
    ["The reviewer's reference driver (`rm5-experiments/lib.mjs`) is mistaken for code to paste", "It is a read-only head start and oracle: every task writes its own tests first; RV2 re-derives the rules from the spec."],
    ["The shared Hostinger server is slow (load average about 35 was seen) or stops the process", "The 10-second hydrate and the cold start are MEASURED in OPS04, not promised; 'Waking up' retry in the screen; a VPS comparison if the numbers fail (O44)."],
    ["A business answer changes code (O2, O14, O22, O31, O32)", "Each is isolated behind a constant, a setting or `pricing_version` 2; the defaults ship."],
    ["The old Supabase branches and worktrees (many, never cleaned) confuse new work", "They are not touched by this plan; new worktrees have new names; their clean-up is a separate task for Harsh's say-so, not part of go-live."],
], ["Risk", "What the plan does"]))
w("")
w("## 14. What Harsh decides, and what the writer is least sure of")
w("")
w("**Decisions only Harsh can make** (each with a default, so nothing blocks; the first four change the dates):")
w("")
w("1. The go on this plan and the date plan: a cut-over on or before Mon 2 Nov only if every gate is green early (best case), or after Bhai Dooj (Thu 12 Nov or later). Recommended: plan for after Bhai Dooj and treat the early date as a bonus.")
w("2. Siddhi's own domain for the API and the website (a new one in her name, her cost, or one she already has): the message is ready in `jewelvault-api-design/MESSAGE-FOR-SIDDHI-domain.md`. Nothing is bought without his yes.")
w("3. Sending Siddhi the eight-item data request in one message today, and the dates of her two testers (not in Dhanteras week).")
w("4. Whether the printed estimate and the rate card by purity (`WEB13`, `WEB16`, 1.8 plan-days; PLAN.md P3-T1 and P3-T2, outside the spec) stay on the go-live path. Recommended: yes; the second is the first cut if time presses.")
w("5. The weekly pull (O54, a duty of his), the key custody (O40), telling Siddhi that backups sit in one account (O45), the Hostinger renewal with auto-renew (O46).")
w("6. The vetoable defaults of `PH07` (per-line rounding O22, Reports in M1 O32, the walk-in silver settlement O52, the login throttle O55, the photo caps O56 and others).")
w("7. If `OPS01` or `OPS02` fails: whether to pay for the comparison of a small VPS (O44).")
w("")
w("**The lines the writer is least sure of:** (1) the speed factors of the money, web and ops groups (judgement from one measurement of pure work); (2) the lead "
  "times of people (nobody has measured Siddhi's speed, and the data request is not known to have been sent); (3) the Custom cron job that runs the dump script "
  "and the hourly job that usually ends at once (untried); (4) `MB05`/`MB07`: the database session was still committing while this plan was written (`a2a720b` at 15:15 on 16 Oct); the plan names the functions it relies on and `MB07` re-checks them; (5) the 3-night wait, the 0.8 and 1.4 thresholds of TW1, and the cut prices, which are arithmetic over guesses; (6) that "
  "Vercel holds a `NEXT_PUBLIC_PREVIEW_MODE` variable (the memory says the live site shows 'not connected'; Harsh removes it at go-live in any case); (7) "
  "the festival rule (a switch on Mon 2 Nov is legal here but is four days before Dhanteras).")
w("")
w("## 15. How this draft answers the plan review")
w("")
w("*(Filled in after `RV0`: one row per finding.)*")
w("")
w("## Appendix: coverage, generated")
w("")
w(f"Every one of the {len(spec_ids)} requirement and open-item IDs of the spec is on the spec lines of **exactly one** task, except the {len(chk.EXEMPT)} exempt IDs below; "
  f"every one of the {len(spec_tests)} tests is introduced by exactly one task and can pass there. The checks ran when this file was written and are repeated by "
  "`python3 _plan-build/build_plan.py` after any change.")
w("")
w(md_table([[k, v] for k, v in chk.EXEMPT.items()], ["Exempt ID", "Why"]))
w("")
w("**Names in a test's Req column that are finished by a later task on purpose** (each is a clause with an owner; the generator checks that the owner lists the test):")
w("")
ign_rows = []
for x, d in chk.TEST_IGNORE.items():
    for r, why in d.items():
        if r in used_ignores.get(x, set()):
            ign_rows.append([x, r, why])
w(md_table(ign_rows, ["Test", "Req named", "Why it does not block the introducing task"]))
w("")
w("**Clauses of tests that several tasks complete** (test, clause, task that proves it):")
w("")
w(md_table([[a, b, c] for a, b, c in chk.TEST_CLAUSES], ["Test", "Clause", "Task"]))
w("")
w("**Requirement and open-item IDs to task:**")
w("")
by_prefix = defaultdict(list)
for r in spec_ids:
    by_prefix[re.match(r"[A-Z]+", r).group(0)].append(r)
cov_rows = []
for pre, rs in by_prefix.items():
    for r in rs:
        cov_rows.append([r, (owner[r][0] if r in owner else "exempt")])
# compact: group lines of ten IDs
compact = []
line = []
for r, tsk in cov_rows:
    line.append(f"{r}:{tsk}")
    if len(line) == 8:
        compact.append(" ".join(line)); line = []
if line:
    compact.append(" ".join(line))
w("```")
for c in compact:
    w(c)
w("```")
w("")
w("**Tests to task (introduced; then extended by):**")
w("")
tl = []
for x in spec_tests:
    ex = ",".join(test_ext.get(x, []))
    tl.append(f"{x}:{test_owner[x][0]}" + (f" (+{ex})" if ex else ""))
w("```")
for i in range(0, len(tl), 5):
    w("   ".join(tl[i:i + 5]))
w("```")
w("")

open(os.path.join(SPEC_DIR, "plan.md"), "w", encoding="utf-8").write("\n".join(O) + "\n")

# ---------------------------------------------------------------------------------------------- tasks.md
P = []
p = P.append
p("# Tasks: P1 foundation and money (JewelVault on Node.js + MariaDB 11.8, Hostinger; front end on Vercel)")
p("")
p(f"Generated on {core.TODAY.isoformat()} from `_plan-build/plan_*.py` by `build_plan.py`, which also checks every requirement, open item and test of "
  f"`spec.md` draft 5.2 (commit `7920e6c`, {len(lines)} lines) against these tasks, that each test can pass in the task that introduces it, and that every existing "
  "file path exists in its repository. Plan-days are the planning unit of `plan.md` section 4 (plus or minus 30 percent); \"elapsed\" is working days "
  "from `plan.md` section 5 (best to worst). \"Spec lines\" are the IDs this task OWNS (each ID is on exactly one task); \"also touches\" lists IDs owned "
  "elsewhere that this task uses. \"Tests first written here\" are spec tests introduced (and seen failing) in this task; \"extends\" are spec tests this task "
  "completes a part of; \"plan tests\" are checks the plan adds because the spec has no test ID for them. `[WITH-HARSH]`, `[WITH-SIDDHI]`, `[WITH-CA]` mark a "
  "person's task: the elapsed time is the lead time, and \"Needed\" says what, from whom, and the latest day (computed in `plan.md` section 8).")
p("")
SECTIONS = [("MariaDB half (done, aligned, and the audit triggers)", ("MB",)), ("Node API", ("API",)), ("Front end (jewelvault-app)", ("WEB",)),
            ("Hostinger and operations (lane O)", ("OPS",)), ("Import of Siddhi's data", ("IMP",)), ("Acceptance, training, go-live (lane O)", ("QA",)),
            ("Reviews (fresh agents)", ("RV",)), ("Harsh", ("PH",)), ("Siddhi and her CA", ("PS",))]
for title, lanes in SECTIONS:
    p(f"## {title}")
    p("")
    for t in TASKS:
        if t["lane"] in lanes:
            bits = [t["id"]]
            if t["status"] == "DONE":
                p(f"- {t['id']} {t['title']} | done: {t['commit']}")
            else:
                who = t["agent"] or ("O" if t["id"] in chk.ORCH_LANE else t["who"])
                pd = f"{t['pd']:.1f} plan-days, " if t["pd"] else ""
                p(f"- {t['id']} [{who}] {t['title']} | depends on: {', '.join(t['deps']) or '-'} | {pd}elapsed {span(duration(t, 'low'), duration(t, 'high'), 2)} | tests: {ids_text(t['tests'])} | extends: {ids_text(t['extends'])}")
    p("")
p("## What each task does")
p("")
for t in TASKS:
    p(f"### {t['id']} {t['title']}")
    p("")
    if t["status"] == "DONE":
        p(f"- **Status:** DONE   **Commits:** {t['commit']}   **Repository:** {'jewelvault-app' if t['repo']=='app' else 'jewelvault-api'}")
    else:
        who = t["agent"] or ("O (orchestrator with Harsh or Siddhi)" if t["id"] in chk.ORCH_LANE else t["who"])
        el = span(duration(t, "low"), duration(t, "high"), 2)
        pdt = f"{t['pd']:.1f} plan-days ({t['grp']}), " if t["pd"] else ""
        bracket = f"   **[{t['who']}]**" if t["who"] and (t["id"] in chk.ORCH_LANE or t["agent"]) else ""
        p(f"- **Who:** {who}{bracket}   **Repository:** {'jewelvault-app' if t['repo']=='app' else 'jewelvault-api'}   **Size:** {pdt}elapsed {el} working days   **Depends on:** {', '.join(t['deps']) or '-'}")
        if t["gate"]:
            p(f"- **Gate:** {t['gate']}")
    p(f"- **Spec lines:** {ids_text(t['reqs'])}   **Also touches:** {ids_text(t['uses'])}")
    p(f"- **Tests first written here:** {ids_text(t['tests'])}   **Extends:** {ids_text(t['extends'])}   **Plan tests:** {('; '.join(t['ptests'])) or '-'}")
    p(f"- **{'Needed' if (t['who'] and not t['agent'] and t['id'] not in chk.ORCH_LANE) else 'Do'}:** {t['do']}")
    if t["files"]:
        p(f"- **Files:** {', '.join(t['files'])}")
    if t["note"]:
        p(f"- **Note:** {t['note']}")
    if t["tripwire"]:
        p(f"- **Tripwire:** {t['tripwire']}")
    p(f"- **Done when:** {t['done']}")
    p(f"- **Rollback:** {t['rollback']}")
    p("")

open(os.path.join(SPEC_DIR, "tasks.md"), "w", encoding="utf-8").write("\n".join(P) + "\n")
print(f"wrote plan.md ({len(O)} lines) and tasks.md ({len(P)} lines)")
