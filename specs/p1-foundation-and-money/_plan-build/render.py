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

_s, _f, _w, _d = schedule("mid", mid_durs(), cal=core.CAL_OFF)
RUNS["mid"] = dict(start=_s, fin=_f, why=_w, durs=_d)
_s, _f, _w, _d = schedule("mid", mid_durs(), cal=core.CAL_ON)
RUNS_ON["mid"] = dict(start=_s, fin=_f, why=_w, durs=_d)
CASE_NAME = {"low": "Best", "mid": "Likely", "high": "Worst"}
LAST_SAFE_BEFORE = core.NO_SWITCH_FROM - core.dt.timedelta(days=1)   # Wed 28 Oct: Harsh's own rule, PLAN.md 3.1 rule 4
AFTER_FESTIVAL = core.BHAI_DOOJ + core.dt.timedelta(days=1)          # Thu 12 Nov

def golive(d0, cal):
    """The first live day the rule allows, given the day the cut-over could happen."""
    if d0 <= LAST_SAFE_BEFORE:
        return d0, "before the freeze of 29 Oct"
    if d0 <= core.BHAI_DOOJ:
        for d in cal:
            if d >= AFTER_FESTIVAL:
                return d, "moved out of the freeze, 29 Oct to 11 Nov"
    return d0, "after Bhai Dooj"

def runs_of(calname):
    return RUNS if calname == "off" else RUNS_ON

def end_of(case, tid, calname="off"):
    return runs_of(calname)[case]["fin"][tid]

def date_str(case, tid, calname):
    return fmt(date_of(end_of(case, tid, calname), CAL[calname]))

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
        d0 = date_of(end_of(case, LAST_ID, cal), CAL[cal])
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
    s, f, w, d = schedule(case, durs, cal=core.CAL_OFF)
    return f

CUTS = [
    ("1", "X11 refund: API28 and the refund form of WEB11. A mistaken receipt is voided instead.", {"API28": 0.0, "WEB11": 0.8}),
    ("2", "The review line I11 and the list-price report (R14 reporting): the columns stay, the report goes (a third of API32).", {"API32": 0.65}),
    ("3", "Rewiring the Reports screen to the shared selectors: hide Reports instead (O32) (a third of WEB12).", {"WEB12": 0.65}),
    ("4", "The rate card by purity (WEB17): billing stays correct because the rate is editable on every line; the stale-rate guard (WEB16) STAYS, as PLAN.md 7.1 says (P3-T2).", {"WEB17": 0.0}),
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
def tw_rows(ids, grp):
    pd_ = sum(BY_ID[i]["pd"] for i in ids)
    lo, hi = FACT[grp]
    return pd_, lo * 480, hi * 480, lo * pd_, hi * pd_

tw1_pd, tw1_min_lo, tw1_min_hi, tw1_lo, tw1_hi = tw_rows(["API21", "API22"], "money")
tw1a_pd, tw1a_min_lo, tw1a_min_hi, tw1a_lo, tw1a_hi = tw_rows(["API03", "API14"], "money")
twweb_pd, twweb_min_lo, twweb_min_hi, twweb_lo, twweb_hi = tw_rows(["WEB03", "WEB04"], "web")

# ---------------------------------------------------------------------------------------------- plan.md
today = core.TODAY.strftime("%A %d %B %Y")
O = []
w = O.append

w("# Plan: P1 foundation and money (JewelVault on Node.js + MariaDB 11.8 at Hostinger, front end on Vercel)")
w("")
w(f"Status: **DRAFT 1, revision C (17 Oct 2026)**, written on {today}, revised on Sat 17 Oct for what arrived after it (the database session's commits `379ef68`, `a2a720b`, `a5790d8`, `694b435`, the API-00c results of 16 and 17 Oct, the purchase of the domain) and again for the three plan reviews of 17 Oct (section 15); against `spec.md` draft 5.2 (commit `7920e6c`, {len(lines) - (1 if lines and lines[-1] == '' else 0)} lines, "
  f"{len(spec_ids)} requirement and open-item IDs, {len(spec_tests)} tests; reviewed three times, no Critical). It replaces "
  "the plan for the Supabase stack (`jewelvault-app/specs/p1-foundation-and-money/plan.md`, 52 tasks, 10 done and now frozen; "
  "only `FE01`, the integer pricing code, survives). Reviewed three times by fresh agents (`RV0` and a re-read of the changed lines, section 15); the "
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
w(f"- **No date is promised.** First live day (never between Thu 29 Oct and Wed 11 Nov: Harsh's own freeze, PLAN.md 3.1 rule 4): best **{fmt(min(GO[('low','on')][1], GO[('low','off')][1]))}** to **{fmt(max(GO[('low','on')][1], GO[('low','off')][1]))}**; "
  f"most likely **{fmt(min(GO[('mid','off')][1], GO[('mid','on')][1]))}** to **{fmt(max(GO[('mid','off')][1], GO[('mid','on')][1]))}**; worst **{fmt(min(GO[('high','on')][1], GO[('high','off')][1]))}** to **{fmt(max(GO[('high','on')][1], GO[('high','off')][1]))}** (section 7). "
  "The old 'before Dhanteras' dates (31 Oct, 2 Nov) are not offered: they need every best factor and break the freeze.")
w("- **What the dates depend on:** the speed of the money, browser and Hostinger tasks (never measured: tripwires TW1 to TW-ops, section 9), Hostinger passing the rest of the proof (`OPS01` Safari and Firefox on the real names, `OPS02a`, `OPS02w`, `OPS02`), "
  "the first GitHub deploy (`OPS03a`), Harsh's hands at hPanel and GitHub Desktop (one queue, section 6), and the inputs of people that sit close to the path: Harsh's go, "
  "Siddhi's full stock list and balances, her business answers, and her presence for the rehearsal, the acceptance and the training, which cannot happen between 3 and 11 Nov (section 8). The domain is no longer waited for: Harsh bought it on 17 Oct.")
w("- **The longest chain** runs through the money core (agent A) and the rest of the API (agent C), then staging, the backup drills, the three reviews, the regression, the acceptance by her two testers, the training, the go or no-go and the cut-over (section 6).")
w("- **No change between Thu 29 Oct and Wed 11 Nov**; Siddhi is away from her tests and training 3 to 11 Nov; the paper bill book stays for ten days after go-live; the cut line and the never-cut list are in section 10.")
w("")
w("## 1. Design: the simplest approach that meets the spec")
w("")
w("- **Backend first, and most of its database half exists.** The order Harsh asked for (\"pehle Backend\") stays. What is built "
  "and green in `jewelvault-api` (521 tests on 15 Oct 2026, 630 on 16 Oct, and 567 in `tests/schema` alone since commit `694b435` on 17 Oct): the schema, the create-only migration runner, the four derived "
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
  "branch (`api-a`, `api-b` and `api-c` of `jewelvault-api` in `jewelvault-api-wt/a`, `b`, `c`; `api-web` of `jewelvault-app` in `jewelvault-app-wt/b` for agent B and `api-web-c` in `jewelvault-app-wt/c` for the one front-end task of agent C, `WEB14`); the front-end tests start the API from the orchestrator's checkout of `main` of `jewelvault-api` (`JV_API_DIR`), into which the orchestrator merges each finished API task before the web task that needs it starts; the old Supabase worktrees "
  "(`jewelvault-wt/a`, `b`, `c`) are not used. One local commit per task: what changed, the spec IDs it covers. **Nothing is "
  "pushed or pulled by any agent; Harsh pushes** (his GitHub account `iamharshvishwas`), and after each commit the orchestrator "
  "says which branch and commit are ready.")
w("- **One owner per function.** A service function X1 to X12 is edited only by the task that first creates it, with its final "
  "signature from its first commit; what a later task adds, it adds in a helper that the function already calls "
  "(`rebalance`, `cashRules`, `state`, `touch`), so two agents never edit one function. A bug found in another task's function goes to the "
  "orchestrator.")
w("- **Migrations** stay forward-only and create-only (spec S9). Until the first one is applied to a real Hostinger database "
  "(`OPS03`), a migration file may still be edited by the database session's alignment work (`MB07`); after that, every change is "
  "a new file and the runner refuses edits. `db/` is changed only through the tasks that name a migration.")
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
  "into `jewelvault-app` main) are frozen, are not reused and are removed from the repository by `WEB15`; only the old `FE01` carries over under its own id. `WEB15` also removes the two later commits on `jewelvault-app` main that belong to the Supabase build: `DB09a` (`6b68285`, migration `0016_write_prologue_customer.sql`) and the preview-mode commit `45a444e`.")
w("")
w("The whole repository ran **521 tests green on 15 Oct 2026** and **630 passed, 2 skipped on 16 Oct** (549 of them in `tests/schema`, 567 since `694b435` on 17 Oct; run by the database session with `npm run db:up`, "
  "`npx vitest run`, about 1 to 2 minutes). The database session aligned `db/` to spec 5.2 in three commits on 16 Oct (`MB05`: `379ef68` at 14:53 and `a2a720b` at "
  "15:15: correlated reads, health figures, the encrypted export writer, the backup-folder rules, pacing, admin SQL, caps; `MB06`: `a5790d8` at 15:35: the generated audit "
  "triggers, the job locks, the docs rewritten). `MB07` closes the checklist: at 12:30 on 17 Oct all seven items are committed, the last (the login counters and the function that closes finished login-failure hours) "
  "in `694b435`, which the API wraps and calls (`API08`, `API33b`). Nothing has been applied to Hostinger yet; the API-00c miniature kit of 16 Oct answered several Hostinger questions (section 9, `OPS02`). The converter from Siddhi's "
  "sheet does not exist because the sheet has not been seen (`IMP01`). `FE01` (`pricing.ts` 533 lines, `selectors.ts` 465 lines, 323 unit tests) is unchanged and "
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
  "concurrency test, a Hostinger deploy through GitHub, an import, anything that waits for a person. A browser task was measured once (`FE02` of the old build: login, session "
  "gate, roles and browser tests, 1.4 plan-days in 30 agent minutes), but with the back end mocked.")
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
w(f"- **Orchestrator with Harsh or Siddhi (lane O), one queue in this order:** " + " > ".join(chk.ORCH_ORDER) + "; `OPS02w`, `OPS08` and `QA06` are time passing and take no queue time (acceptance and training run on staging, so they come before the production setup)")
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
  "worked, *Sundays worked* means they all are. **Two rules shape the dates.** (1) Harsh's own rule in `PLAN.md` 3.1 (rule 4): the billing system is never changed between "
  "**Thu 29 Oct and Wed 11 Nov** (Dhanteras is Fri 6 Nov, Diwali Sun 8 Nov, Bhai Dooj Wed 11 Nov 2026); a cut-over day that falls inside moves to Thu 12 Nov. The first live "
  "day before it would have to be Wed 28 Oct or earlier, which no case reaches. (2) Siddhi and her staff cannot test, train or read a reconciliation from **Tue 3 to Wed 11 Nov** "
  "(`QA02` and `PS07` say so): the scheduler moves her tasks and her answers to Thu 12 Nov. In the *Sundays worked* column the plan also assumes that Harsh and Siddhi answer on Sundays.")
w("")
w(md_table(rows_dates, ["Case", "Calendar", "Money core reviewed (RV2)", "Production ready (OPS07)", "Acceptance done (QA02)", "Go or no-go (QA04)", "Cut-over day could be", "First live day under the festival rule"]))
w("")
best_off = rows_dates[0]; best_on = rows_dates[1]; likely_off = rows_dates[2]; likely_on = rows_dates[3]; worst_off = rows_dates[4]; worst_on = rows_dates[5]
w("**The honest reading.**")
w("")
w(f"- *Earliest sensible go-live:* **{fmt(min(GO[('low','on')][1], GO[('low','off')][1]))}** to **{fmt(max(GO[('low','on')][1], GO[('low','off')][1]))}**, and only if every agent task runs at the best factor, no review finds a High, "
  "Hostinger passes the rest of the proof and the first GitHub deploy at the first attempt, Siddhi's full stock list and balances are in hand about a week after Harsh asks, and nothing is asked of Harsh that he cannot do the same day. "
  "Nothing measured says the money, browser and Hostinger tasks will run at that speed; the first real measurements are tripwires TW1 to TW-ops (section 9).")
_lk = sorted([GO[("mid", "off")][1], GO[("mid", "on")][1]])
w(f"- *Most likely:* **{fmt(_lk[0])}** to **{fmt(_lk[1])}**. 'Likely' is the plain average of the best and worst factors; it carries no probability.")
_wk = sorted([GO[("high", "off")][1], GO[("high", "on")][1]])
w(f"- *Worst case:* **{fmt(_wk[0])}** to **{fmt(_wk[1])}**, which is also the date if the tripwires show the high factors. The static lanes make the worst case about two to four working days pessimistic (an idle lane waits for another); the orchestrator may hand the next task to whichever lane is free.")
w("- *Fallback:* the first working day after the gates, never a day between 29 Oct and 11 Nov; the paper bill book stays the system of record until the go or no-go is signed and for ten days after. A first live day right after Bhai Dooj puts the final import straight after the busiest paper week, which is a reason to prefer a day after 16 Nov (`IMP03`).")
w("- The dates move one-for-one with: Harsh's go (`PH01`), his hands at hPanel and GitHub Desktop, Siddhi's full data (`PS03`) and testers (`PS07`), and every "
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
w("Work that needs Harsh at hPanel, at GitHub Desktop or in the shop is **lane O: one queue, one task at a time** (Harsh and the orchestrator are one resource, and every staging fix needs "
  "a push from him and 30 seconds for the double start): `OPS01` (Safari, Firefox and the real pair), `OPS02a` (the Hostinger-only proofs, half a day, can start as soon as the staging "
  "and scratch databases exist; `OPS02w`, the wait for Hostinger's own restore point, runs beside it as calendar time and takes no queue time; `PH05b` removes the proof apps and creates the staging app between `OPS02a` and `OPS03a`), `OPS03a` (the first GitHub deploy of the walking skeleton), `OPS02` (the proofs that need the code), `OPS03` (staging deploy, cron, rollback tried), "
  "`OPS04` (real-network checks), `OPS05` (backup drills), `OPS06` (runbook), `IMP02` (import rehearsal), `OPS07` (production, the real pair, drill 2 with real data), `QA02` to `QA05`; "
  "`OPS08` (three nights) and `QA06` are time passing. Harsh's minutes at the screen are about half a day for each of OPS02a and OPS03a, a day each for the others (agree two push "
  "windows a day for staging, serialised with the agents' merges). Each task says in `tasks.md` what Harsh does with his hands.")
w("")
w("## 9. Tripwires")
w("")
w("**What is measured.** For a task: the wall-clock minutes from the moment its agent starts to the moment it is merged and checked, minus any time it waited for another lane, "
  "divided by its plan-days (so it is *minutes per plan-day*, comparable with the 38 measured on the Supabase build). The best factor is the minutes shown below, the worst "
  "factor the larger one; the best case holds if the measured value is at most 1.3 times the best, the worst case applies if it is at least 0.8 times the worst, and in between "
  "the likely case applies. Every finished task adds a row to `jewelvault-api/docs/unit-samples.csv` (task, plan-days, agent minutes, orchestrator minutes, kind), as the Supabase build did, "
  "the orchestrator recomputes the range with this script after each tripwire and tells Harsh in Hinglish.")
w("")
w(md_table([
    ["TW1a", "`API03` + `API14` (transactions, deadline, deadlock re-run; numbers and the Idempotency-Key claim)", f"{tw1a_pd:.1f} money", f"{tw1a_min_lo:.0f}", f"{tw1a_min_hi:.0f}", f"{date_str('low','API14','off')} / {date_str('high','API14','off')}", "the first money-group read, early"],
    ["TW1", "`API21` + `API22` (rebalance; record_payment with the two-session tests T-C09)", f"{tw1_pd:.1f} money", f"{tw1_min_lo:.0f}", f"{tw1_min_hi:.0f}", f"{date_str('low','API22','off')} / {date_str('high','API22','off')}", "the one to trust: the first money write with two-session tests"],
    ["TW-web", "`WEB03` + `WEB04` (hydrate, poll, the first two-browser Playwright test)", f"{twweb_pd:.1f} web", f"{twweb_min_lo:.0f}", f"{twweb_min_hi:.0f}", f"{date_str('low','WEB04','off')} / {date_str('high','WEB04','off')}", "browser work was measured once only (FE02, with the back end mocked)"],
    ["TW-ops", "`OPS03a` (the first GitHub deploy, rollback, cron path)", "explicit", "-", "-", f"{date_str('low','OPS03a','off')} / {date_str('high','OPS03a','off')}", "best 0.5, worst 1.5 working days; over 1.5 means every OPS task after it is read at its worst"],
], ["Tripwire", "Tasks", "Size", "Best (min per plan-day)", "Worst (min per plan-day)", "Planned finish, best / worst, Sundays off", "Why here"]))
w("")
w("The first five tasks (`API01` to `API05`) are mostly pure work and prove little, as the old plan's `DB01` to `DB05` (Supabase) proved little. If TW-web trips, the orchestrator moves one front-end task (for example `WEB13`) to lane C's app worktree and recomputes. If TW1a or TW1 trips, the orchestrator also moves "
  "tasks between lanes (the static lanes are a guess) before telling Harsh the new range.")
w("- **TW2, second measurement: `API31`** (random sequences, three seeds, the matrix) and `RV2`'s mutation findings. A High finding that needs a redesign "
  "of a lock or of the rebalance moves the worst case by about 2 working days each time and is reported at once.")
w("- **TW3, `OPS01`** (Safari and Firefox on the real names, and the real pair): the domain is bought and two staging names work in Chrome (17 Oct). What can still trip is the `__Host-` "
  "SameSite=Strict cookie in Safari or Firefox, Safari's 7-day cap, or the website name pointing at Vercel breaking the same-site rule. STOP and re-plan the name pair or put the API behind the "
  "website's own origin by a Vercel rewrite (spec A12); a no-go on the host goes to Harsh (O44: a priced VPS comparison before any money is spent).")
w("- **TW4, Siddhi's data:** if the sample sheet (`PS02`) is not in hand by its latest day in section 8, `IMP01` slips; if the full list "
  "(`PS03`) is not usable by its latest day, go-live slides day by day and Harsh tells her.")
w("- **TW5, `OPS02` and `OPS03a`:** the dump script as a Custom cron job and `GET_LOCK` were answered on 16 Oct for a miniature dump (275 ms, 72 MB resident); what is open is "
  "the dump at real size (year 5 is about 400 MB) being killed by a CPU or process limit, the 255-character command field (227 characters for `billing-api.jaishrigoldpalace.com`, 243 for "
  "`billing-api-staging.`; the 161-character base came from a zip-uploaded app and the Git-built layout is measured in `OPS03a`), and the new-connection "
  "budget shared by the app, the dump and the plan's other apps. A FAIL reopens the nightly dump (spec I8 (B)); the manual fallback is the same export run from Harsh's "
  "Mac through Remote MySQL, which is itself untried.")
w("")
w("## 10. Budget and cut line")
w("")
w("Budget: the days of section 7, nothing is bought by this plan except what Harsh decides (Harsh bought "
  "`jaishrigoldpalace.com` himself on 17 Oct, its yearly price is his to write into the go or no-go list; a Hostinger renewal, price and term to be stated by him; a VPS only if the proof fails). If a gate is late, "
  "cut in this order, one item at a time, and tell Harsh each time. Prices are days saved on the finish of the last code gate (`RV4`):")
w("")
w(md_table(cut_rows, ["#", "Cut", "Best case (working days saved)", "Worst case (working days saved)"]))
w("")
w(f"All four together save {all_save[0]} (best) to {all_save[1]} (worst) working days. The cut line is a last resort, not a plan, because the chain runs through "
  "the money core, the jobs and the people, not through these items. **Never cut:** the lock order and idempotency (`API14`, `API15`, `API20`, "
  "`API22`, `API29`), the role matrix and the owner-only weight (`API04`, `API11`), the cash and PAN rules (`API23`), the invariants and the nightly "
  "check (`API32`, `API33`, `API33b`), the backup job and restore drills 1 and 2 (`API34`, `API36`, `OPS05`, `OPS07`), her data and the reconciliation "
  "(`IMP01` to `IMP03`), the Hostinger go-live conditions (restore points, a pulled copy, renewal, Siddhi told: `OPS02`, `OPS02w`, `OPS05`, `PH06a`, `PH06b`, `PS06`), the reviews "
  "`RV1` to `RV4`, the printed estimate (`WEB13`), the regression, the acceptance and the training with the paper break-glass sheet (`QA01` to `QA03`), hiding the unfinished screens (spec C15), T-B14 with three seeds and T-C15's stress run. If the cuts are not enough, the answer is a "
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
    ["G-H Hostinger gate (final)", "after OPS01, OPS02a, OPS02w and OPS02", "the addenda to HOSTINGER-SPIKE.md", "Safari and Firefox on the real names and the real pair, the ten-box suite, Remote MySQL, the pull, Hostinger's restore points and the dump at size all PASS and none is UNKNOWN (the domain, Chrome, GET_LOCK and the miniature cron dump were answered on 16 and 17 Oct); a FAIL is a finding for Harsh (TW3, TW5)"],
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
    ["The `__Host-` cookie fails in Safari or Firefox on the real names, or the narrowed ten-box user breaks something the all-boxes proof did not (the domain itself is bought and works in Chrome)", "OPS01 and OPS02 are early and a gate; fallbacks: another name pair, a Vercel rewrite of the API, a priced VPS (O44)."],
    ["The first GitHub deploy has never been tried (only zip uploads), and it sits late in the chain", "`OPS03a` is a walking-skeleton deploy as soon as the repository and the staging app exist, so a surprise appears in the first week; tripwire TW-ops."],
    ["The new-connection budget (about 20 a second) is shared by every process of the plan's database user: the app, the dump script and the other apps (API-00c, 16 Oct)", "One pool of 8, the dump's own pool of one, every tool paced to 10 in 1.2 s; the proof apps are removed (PH05b); OPS02 and OPS03 measure the budget with the app and the dump running together; a refused connection is retried once then `JV_BUSY`."],
    ["The dump cannot run as a Custom cron Node script (CPU or process kill), or `GET_LOCK` is not allowed", "OPS02 tests it with a stub first; fallback: the same export run from Harsh's Mac through Remote MySQL; if both fail, a smaller dump or another place to run it (spec I8 (B))."],
    ["One account holds the database, every export and Hostinger's own backup; the plan ends on 22 March 2027", "Weekly pull and monthly download are duties with a dashboard card and a health flag; Siddhi is told in plain words; renewal with auto-renew and a reminder is a go-live condition (PH06b)."],
    ["Dhanteras week and Harsh's own freeze", "No change between 29 Oct and 11 Nov (PLAN.md 3.1 rule 4) except critical fixes; Siddhi's tests and training do not happen 3 to 11 Nov; the paper bill book runs alongside for ten days."],
    ["Certificates, the domain's yearly renewal and its hand-over to Siddhi", "Hostinger issues 90-day certificates whose renewal is unproven (the staging ones expire 15 Jan 2027): a reminder and a look in `QA06`; domain and hosting stay in one account until both move together (`PH04`); renewal prices are written in the go or no-go list (`PH06b`)."],
    ["The import has no correction loop, and the final list arrives right after the busiest week", "`IMP02` carries 1 to 3 days for corrections; `IMP03` names who produces the final list, when, and the fallback."],
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
w("1. The go on this plan (given on 17 Oct) and the date plan: the earliest first live day is Thu 12 Nov and the likely one a week or two later; anything inside 29 Oct to 11 Nov overrules his own PLAN.md 3.1 rule 4, in his words. Recommended: tell Siddhi 'not before 12 Nov, most likely the week of 17 to 23 Nov'.")
w("2. The domain: bought by him on 17 Oct (`jaishrigoldpalace.com`). What is left is who owns what at hand-over (the registrant and the hosting stay in one account until both move together), the yearly price, and Vercel's DNS record for the website name.")
w("3. Sending Siddhi the eight-item data request in one message today, and the dates of her two testers and of the training (not 3 to 11 Nov).")
w("4. Whether the printed estimate and the stale-rate guard (`WEB13`, `WEB16`; PLAN.md P3-T1 and P3-T2, outside the spec) stay on the go-live path (recommended: yes) and the rate card by purity (`WEB17`) is the first cut.")
w("5. The weekly pull (O54, a duty of his), the key custody (O40), telling Siddhi that backups sit in one account (O45), the Hostinger renewal with auto-renew and its price (O46), the domain's yearly renewal.")
w("6. The vetoable defaults of `PH07` (per-line rounding O22, Reports in M1 O32, the walk-in silver settlement O52, the login throttle O55, the photo caps O56 and others).")
w("7. How many hours a day he can give on the days that need his hands (hPanel, GitHub Desktop pushes), who supports the system after day 30 and at what price (PLAN.md decision 8), and whether to pay for a small VPS comparison if the proof fails (O44).")
w("8. Which branch of `jewelvault-app` he pushes before go-live: only the work branch `api-web` (default), never `main`, so that the live demo on Vercel does not change until `PH08`; and whether the preview-mode screens (sample data, no API) may stay visible on that branch until `WEB15` (default: yes).")
w("9. A new fact against a spec line: the domain is bought (O38 still says the default is a domain in Siddhi's name; NODE-DESIGN DEC-1 and `API-00C-RESULTS.md` section 5 record it). The plan does not edit the spec; the next spec revision should amend O38.")
w("10. A ruling on the spec: T-R01 says each key holder proves that her copy decrypts at drill 1. Siddhi is away 3 to 11 Nov and drill 1 comes before her training, so Harsh's own copy is proved at drill 1 (`OPS05`) and hers at the training (`QA03`), still before go-live. Default: yes.")
w("")
w("**The lines the writer is least sure of:** (1) the speed factors of the money, web and ops groups (judgement from one measurement of pure work); (2) the lead "
  "times of people (nobody has measured Siddhi's speed, and the data request is not known to have been sent); (3) the Custom cron job that runs the dump script "
  "and the hourly job that usually ends at once (untried); (4) `MB05`/`MB07`: the database session was still committing while this plan was written (`a2a720b` at 15:15 on 16 Oct); the plan names the functions it relies on and `MB07` re-checks them; (5) the 3-night wait, the 0.8 and 1.4 thresholds of TW1, and the cut prices, which are arithmetic over guesses; (6) that "
  "Vercel holds a `NEXT_PUBLIC_PREVIEW_MODE` variable (the memory says the live site shows 'not connected'; Harsh removes it at go-live in any case); (7) "
  "the serial queue of Harsh's hands and the Siddhi-away rule of 3 to 11 Nov, which move the dates a week or more and are the plan's newest rules; (8) Hostinger's own backup, which skipped a day without a message.")
w("")
w("## 15. How this draft answers the plan review")
w("")
agent_pd = sum(t["pd"] for t in TASKS if t["status"] == "TODO" and t["agent"])
w("Two fresh agents read the plan on 17 Oct 2026 (`plan-review.md`: traceability and task correctness, 17 findings, 0 Critical, 4 High; `plan-review-2.md`: schedule, risk, people and "
  "Hostinger, 18 findings, 0 Critical, 5 High). Both said **pass with fixes**. The first two are answered in revision B (`61cbb9b`), the third (a re-read of only the changed lines, `plan-review-3.md`: 15 findings, 1 High, 9 Medium, 5 Low) in this revision C. "
  "The writer did not review its own plan (Playbook 4).")
w("")
ans = [
    ["PR1 (High)", "Done. PH04 now means the Vercel DNS record and the hand-over decision; OPS01 is Safari, Firefox and the real pair only; PH03 removes only the failed app; the two proof apps stay until OPS01 and OPS02a are done, then `PH05b` removes them and creates the staging app; the databases are asked for early (`PH05`) and the wait for a Hostinger restore point is its own calendar task (`OPS02w`); `OPS03` and `OPS07` connect the domain before `JV_BACKUP_DIR` and the cron commands are typed; the runbook warns that hPanel's 'Restore database' overwrites in place; the pull works from a file downloaded by hand (`API36`, proved first in `OPS05`). The amendment of O38 belongs to the spec (decision 9): the plan edits no spec."],
    ["PR2 (High)", "Done. `API08` wraps the database half's `scripts/login-counters.mjs` (`694b435`) and writes no SQL; the admin-door, tick and photo rows of T-D24 are clauses with owners (`API09`, `API33`, `API17`); the five-quiet-hours case is the T-D30 clause of `API33b`, which calls `closeFinishedHour`; `MB07` records the commit."],
    ["PR3 (High)", "Done. Edges added: `RV1` to `OPS07` and `RV4`; `OPS01` to `API05` and `API09`; `API25` to `API24`; `API11` and `API15` to `API10`; `IMP02` to `OPS04`. `WEB01`'s contract test no longer creates a customer (that is `WEB07`'s). `API14` to `API04` is not added: the one case that needed the route wrapper moved to `API19`, the first creating route, so lane A does not wait for lane C."],
    ["PR4 (High)", "Done. Clauses with owners: T-E01 poll halves to `WEB04`; T-D26 polling to `API11`; T-C19 on the real X2 to `API30`; T-C15's I6 and I11 to `API31` (not to `API32`, which would have made the jobs wait for the stress run: it cost a week in the worst case); T-B26 over every money function to `API31`; T-A14's screen half to `WEB08`."],
    ["PR5 (Medium)", "Done. The bill and line half of T-A09 is a clause of `API18` (`quote_bill`) and `API20` (`create_bill`)."],
    ["PR6 (Medium)", "Done. Every clause is now a standalone check printed into its owner's Done-when in `tasks.md` ('Also proves') and by `brief.py`; the generator fails when a task extends a test that no clause names."],
    ["PR7 (Medium)", "Done. `writeEvent` is built in `API05` and used by login, logout, change-password, the admin door (`API09`) and each tick phase (`API33`); T-D14 has a clause for each."],
    ["PR8 (Medium)", "Done. T-D03 clauses: results of X1 and X7 for a biller (`API20`) and the generated function matrix over every role (`API31`)."],
    ["PR9 (Medium)", "Done. `scripts/seed-volume.mjs` is in `API12`; `npm run make-token` and `npm run keygen` are in `API09`; `PH06a` waits for `API09`; `OPS05` waits for `PH06a`."],
    ["PR10 (Medium)", "Done. IMP03's rollback is a fresh drill-tested export, then a NEW empty production database and a corrected run until the first live bill, then the B5 restore."],
    ["PR11 (Medium)", f"Done by splitting: `API13` into `API13` and `API13b`, `WEB12` into `WEB12` and `WEB12b`, `API33` into `API33` and `API33b`; `API08` lost the rows that belong to other routes; `API29` and `API36` went from 1.0 to 1.2. The agent tasks now add up to {agent_pd:.1f} plan-days; no task is over 1.5. The dates in section 7 are recomputed with the splits in; the effect is about one working day in the worst case. Harsh decides whether to accept it (decision 1)."],
    ["PR12 (Low)", "Done. Worktrees `jewelvault-api-wt/b` (`api-b`) and `jewelvault-app-wt/c` (`api-web-c`, for `WEB14`); `JV_API_DIR` is the orchestrator's checkout of `main` of `jewelvault-api`, which the orchestrator keeps merged."],
    ["PR13 (Low)", "Done. Preview mode shows sample data inside `PREVIEW_MODE` builds only until `WEB15` (`WEB02`, `WEB03`); Harsh pushes only the branch `api-web`, never `main`, until `PH08` (`PH02`, decision 8)."],
    ["PR14 (Low)", "Done. `WEB14` checks the text of `vercel.json` (the `curl -I` on a host is `OPS04`'s clause); an UNKNOWN keeps gate G-H shut (`OPS02a`, `OPS02`, `OPS02w`, section 12); `MB07` runs after `API01` on a lane database and never uses `npm run db:up`."],
    ["PR15 (Low)", "Done. 567 schema tests, 25 tables, 87 CHECKs, 18 foreign keys, 1,205 lines, `s21` in `MB06`'s files, `DB09a` and `45a444e` in `WEB15`; `ALTER` is in the grep of `API03` (A7); `withRead` is in `API03` and `tx.trail` with `LockOrderViolation` in `API15`."],
    ["PR16 (Low)", "Done. Only a run with no flag (or `--build`) writes; dead ignores were removed and now fail the run; an ignore reason may name only a task that owns a clause of that test (this found and fixed 12 loose reasons, and T-C01, T-C03, T-F08 got their clauses)."],
    ["PR17 (Low)", "Done. The old-browser-export reader in `IMP01` is built only if `PS01` says data was entered there."],
    ["PR3-1 (High)", "Done. `src/auth/limiter.ts` is built in `API09` (the admin door is the first route that needs it) and imported by `API08`, `API17` and `API33`; `API08` now depends on `API09`."],
    ["PR3-2, PR3-3", "Done. `PH01` offers one date plan (not before Thu 12 Nov; the early date would overrule Harsh's own rule and is not offered); `PH08` merges `api-web` into `main` of `jewelvault-app` and pushes before the Vercel variables are changed, and says how to roll back."],
    ["PR3-4, PR3-5, PR3-6", "Done. `OPS02` uses the proof kit's stub script, stub endpoint and stub workflow, and the real tick, dump cron job and workflow are `OPS03`; `OPS01` names its test page (one HTML file on `api-web`, shown by a Vercel preview); `PH02` also pushes a `staging` branch."],
    ["PR3-7", "Done. `scripts/seed-volume.mjs` moved from `API12` to `API11`, which `WEB03` already waits for (the paging tests there need the same volume)."],
    ["PR3-8", "Done. `OPS05` ticks T-R01 except the owner's own copy of the key, which Siddhi proves at the training (`QA03`); the spec says each holder proves it at drill 1, so this is a ruling for Harsh (decision 10)."],
    ["PR3-9", "Done. `QA02` and `QA03` come before `OPS07` in the queue (acceptance and training run on staging, not on production), and the scheduler no longer holds lane O in a strict order: it takes the ready task that can start first, so `OPS07` uses the days Siddhi is away. The end of the best range (Mon 16 Nov, Sundays off) is real: `QA02` does not fit in the half day before her absence, so it starts Thu 12 Nov."],
    ["PR3-10", "Done. Re-priced: `API03` +0.2, `API05` +0.1, `API09` +0.3, `API11` +0.2 (the seeder, taken from `API12` which is back to 1.0), `API15` +0.2, `API17` +0.2, `API30` +0.2, `API31` +0.2. Plan-days and dates are recomputed in sections 0, 4 and 7."],
    ["PR3-11 to PR3-15", "Done. Wrong pointers and stale names fixed (`API30`, `API13b`, `API33b`, `OPS01`, `OPS02`, `OPS04`, `OPS07`, `PH07`, section 13); the header date is fixed (`core.GENERATED`); section 6 prints the queue; `--sched` prints the Sundays-worked column from the Sundays-worked run; `RV2` comes before `API35` and `API36` in lane A; `RV1` waits for `API13b`; `IMP01` waits for `PS01`; `PH05b` waits for `PH03`; `TW-web` has an action when it trips."],
    ["PR2-1 to PR2-18", "Answered (domain bought; Siddhi's absence 3 to 11 Nov in the scheduler; 31 Oct and 2 Nov not offered; TW1a, TW1, TW-web and TW-ops in minutes per plan-day; `OPS02a` and `OPS03a` earlier; `PH06a`/`PH06b`; lane O as one queue; the 255-character numbers; certificate, hand-over and renewal risks; the import correction loop; the legal line in `QA04`; drill 2 with real data and Harsh performing the first restore steps; `WEB16`/`WEB17`; the credential path; `PH03`; the additive-only release-week rule and `OPS08` high of 5.0; section 14). **Ruled, not changed:** PR2-7, the static lanes: they stay a stated guess; the orchestrator re-assigns after TW1a or TW1."],
]
w(md_table(ans, ["Finding", "Answer"]))
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
p(f"Generated on {core.GENERATED.isoformat()} from `_plan-build/plan_*.py` by `build_plan.py`, which also checks every requirement, open item and test of "
  f"`spec.md` draft 5.2 (commit `7920e6c`, {len(lines) - (1 if lines and lines[-1] == '' else 0)} lines) against these tasks, that each test can pass in the task that introduces it, and that every existing "
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
    cl = [(x, c) for (x, c, tid) in chk.TEST_CLAUSES if tid == t["id"]]
    if cl:
        p("- **Also proves (clauses of tests introduced in other tasks; each is one check here):** " + "; ".join(f"{x}: {c}" for x, c in cl))
    p(f"- **Rollback:** {t['rollback']}")
    p("")

open(os.path.join(SPEC_DIR, "tasks.md"), "w", encoding="utf-8").write("\n".join(P) + "\n")
print(f"wrote plan.md ({len(O)} lines) and tasks.md ({len(P)} lines)")
