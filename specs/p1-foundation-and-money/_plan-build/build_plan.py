#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Generate plan.md and tasks.md for specs/p1-foundation-and-money (new stack) from the plan_*.py data and check them
against spec draft 5.2 (commit 7920e6c) and the two repositories.

    python3 _plan-build/build_plan.py            checks, then writes plan.md and tasks.md (exit 1 on a problem)
    python3 _plan-build/build_plan.py --check    checks only
    python3 _plan-build/build_plan.py --build    same as no flag: checks, then writes
    python3 _plan-build/build_plan.py --show-ignores   (read-only) list the test/requirement ignores that were actually needed

The checks (the same idea as the Supabase plan's generator, plus the new rule 'exactly one task per spec line'):
  1. every requirement ID and every open item of the spec is on the spec lines of EXACTLY ONE task (exempt IDs are listed
     with their reason); every test ID is introduced by EXACTLY ONE task; nothing is cited that the spec does not define;
  2. a test can pass where it is introduced: the owners of the requirements in its Req column are the task itself or an
     ancestor (a documented ignore list carries the exceptions, and each clause that a later task completes is checked);
  3. dependencies exist and have no cycle; every agent task sits in exactly one agent lane and the lanes do not deadlock;
  4. no implementer task is over 1.5 plan-days (a warning above 1.2); every existing file path exists in its repository.
"""
import datetime as dt
import glob
import math
import os
import re
import subprocess
import sys
from collections import OrderedDict, defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
SPEC_DIR = os.path.abspath(os.path.join(HERE, ".."))
API_REPO = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
APP_REPO = os.path.abspath(os.path.join(API_REPO, "..", "jewelvault-app"))
SPEC_COMMIT = "7920e6c"

import plan_core as core
import plan_api, plan_web, plan_ops  # noqa: F401  (they register their tasks in core.TASKS)
import plan_checks as chk
if os.environ.get('NOIGN'):
    chk.TEST_IGNORE = {}

TASKS = core.TASKS
BY_ID = OrderedDict((t["id"], t) for t in TASKS)
_lane_of = {x: a for a, order in chk.AGENT_ORDER.items() for x in order}
for _t in TASKS:                      # the lane lists in plan_checks.py are the authority for who does a task
    _t["agent"] = _lane_of.get(_t["id"])
    if _t["status"] == "TODO":
        if _t["lane"] == "RV":
            _t["grp"] = "review"
        elif _t["id"] in chk.ORCH_LANE:
            _t["grp"] = "ops"
        elif _t["who"] and not _t["agent"]:
            _t["grp"] = "people"

# ------------------------------------------------------------------------------------------------ the spec
def read_spec():
    try:
        out = subprocess.run(["git", "show", f"{SPEC_COMMIT}:specs/p1-foundation-and-money/spec.md"], cwd=API_REPO,
                             capture_output=True, text=True, check=True).stdout
    except Exception:  # pragma: no cover
        out = open(os.path.join(SPEC_DIR, "spec.md"), encoding="utf-8").read()
    return out.split("\n")

lines = read_spec()
PREFIX = r"(?:SF|IM|[SDAUPLCBHRKYXVIZ])"
def_re = re.compile(r"^\s*(?:[-*]\s*)?\*\*(" + PREFIX + r"\d+[a-z]?)[\.\s:*]")
spec_ids = OrderedDict()
for i, ln in enumerate(lines, 1):
    m = def_re.match(ln)
    if m:
        spec_ids.setdefault(m.group(1), i)
for i, ln in enumerate(lines, 1):
    m = re.match(r"^\| (O\d+b?) \|", ln)
    if m:
        spec_ids.setdefault(m.group(1), i)
spec_tests = OrderedDict()
for ln in lines:
    m = re.match(r"^\| (T-[A-FR]\d\d) \| ([^|]*) \| (.*) \| ([^|]*) \|$", ln)
    if m:
        spec_tests[m.group(1)] = dict(type=m.group(2).strip(), what=m.group(3).strip(), req=m.group(4).strip())

def expand(col):
    ids = set(re.findall(PREFIX + r"\d+[a-z]?", col))
    for a, na, b, nb in re.findall(r"(" + PREFIX + r")(\d+) to (" + PREFIX + r")?(\d+)", col):
        for n in range(int(na), int(nb) + 1):
            ids.add(f"{a}{n}")
    return ids

# ------------------------------------------------------------------------------------------------ checks
problems, warnings = [], []
ids = [t["id"] for t in TASKS]
if len(ids) != len(set(ids)):
    problems.append("duplicate task ids")
for t in TASKS:
    for d in t["deps"]:
        if d not in BY_ID:
            problems.append(f"{t['id']} depends on unknown {d}")

anc_cache = {}
def ancestors(tid, stack=()):
    if tid in anc_cache:
        return anc_cache[tid]
    if tid in stack:
        problems.append(f"dependency cycle through {tid}")
        return set()
    out = set()
    for d in BY_ID[tid]["deps"]:
        if d in BY_ID:
            out.add(d)
            out |= ancestors(d, stack + (tid,))
    anc_cache[tid] = out
    return out
for t in TASKS:
    ancestors(t["id"])

# 1. exactly one owner per requirement / open item
owner = defaultdict(list)
for t in TASKS:
    for r in t["reqs"]:
        owner[r].append(t["id"])
unknown = sorted(r for r in owner if r not in spec_ids)
if unknown:
    problems.append(f"tasks own IDs the spec does not define: {unknown}")
missing = [r for r in spec_ids if r not in owner and r not in chk.EXEMPT]
if missing:
    problems.append(f"spec IDs on no task: {missing}")
multi = {r: v for r, v in owner.items() if len(v) > 1}
if multi:
    problems.append(f"spec IDs on more than one task: {multi}")
for r in chk.EXEMPT:
    if r in owner:
        problems.append(f"{r} is exempt but a task owns it")
    if r not in spec_ids:
        problems.append(f"exempt ID {r} is not in the spec")
unknown_uses = sorted({u for t in TASKS for u in t["uses"] if u not in spec_ids})
if unknown_uses:
    problems.append(f"tasks cite (uses) IDs the spec does not define: {unknown_uses}")

# tests
test_owner = defaultdict(list)
test_ext = defaultdict(list)
for t in TASKS:
    for x in t["tests"]:
        test_owner[x].append(t["id"])
    for x in t["extends"]:
        test_ext[x].append(t["id"])
extra = sorted(x for x in list(test_owner) + list(test_ext) if x not in spec_tests)
if extra:
    problems.append(f"tasks mention tests the spec does not define: {extra}")
no_owner = [x for x in spec_tests if x not in test_owner]
if no_owner:
    problems.append(f"tests introduced by no task: {no_owner}")
multi_t = {x: v for x, v in test_owner.items() if len(v) > 1}
if multi_t:
    problems.append(f"tests introduced by more than one task: {multi_t}")
for x, v in test_ext.items():
    if x in test_owner and test_owner[x] and test_owner[x][0] in v:
        problems.append(f"{x} is extended in the task that introduces it ({test_owner[x][0]})")

# 2. a test can pass where it is introduced
used_ignores = defaultdict(set)
SHOW_IGN = "--show-ignores" in sys.argv
for x, owners in test_owner.items():
    if x not in spec_tests or not owners:
        continue
    ow = owners[0]
    if BY_ID[ow]["status"] == "DONE":
        continue
    need = expand(spec_tests[x]["req"])
    ign = chk.TEST_IGNORE.get(x, {})
    ok_tasks = ancestors(ow) | {ow}
    for r in sorted(need):
        impl = owner.get(r, [])
        if not impl:
            continue
        if any(i in ok_tasks or BY_ID[i]["status"] == "DONE" for i in impl):
            continue
        if r in ign:
            used_ignores[x].add(r)
            continue
        problems.append(f"{x} (introduced in {ow}) names {r}, which only {impl} own, and none is an earlier task")
unused = {x: sorted(set(v) - used_ignores.get(x, set())) for x, v in chk.TEST_IGNORE.items()}
unused = {x: v for x, v in unused.items() if v}
if SHOW_IGN:
    print("ignores used:", {k: sorted(v) for k, v in used_ignores.items()})
    print("ignores NOT needed:", unused)
if unused:
    problems.append(f"dead ignores in plan_checks.TEST_IGNORE (remove them): {unused}")

# clauses
for (xt, clause, tid) in chk.TEST_CLAUSES:
    if tid not in BY_ID:
        problems.append(f"clause owner {tid} is not a task")
    elif xt not in BY_ID[tid]["tests"] and xt not in BY_ID[tid]["extends"]:
        problems.append(f"{xt}: the clause \"{clause}\" is owned by {tid}, which does not list {xt}")
clause_owner = defaultdict(set)
for (xt, clause, tid) in chk.TEST_CLAUSES:
    clause_owner[xt].add(tid)
# an ignore reason that hands a part of a test to a later task must name a task that really owns a clause of that test
for xt, ign in chk.TEST_IGNORE.items():
    for r, reason in ign.items():
        for tid in re.findall(r"\b(?:API|WEB|OPS|IMP|QA)\d+[ab]?\b", reason):
            if tid in BY_ID and tid not in clause_owner.get(xt, set()) and tid not in test_owner.get(xt, []):
                problems.append(f"the ignore of {xt}/{r} names {tid}, which owns no clause of {xt} in TEST_CLAUSES")
for t in TASKS:
    for x in t["extends"]:
        if t["id"] not in clause_owner.get(x, set()):
            problems.append(f"{t['id']} extends {x} but no clause (TEST_CLAUSES) names it")

# sizes
for t in TASKS:
    if t["status"] == "TODO" and t["pd"] > 1.5:
        problems.append(f"{t['id']} is {t['pd']} plan-days (over 1.5)")
    elif t["status"] == "TODO" and t["pd"] > 1.2:
        warnings.append(f"{t['id']} is {t['pd']} plan-days (over 1.2)")
    if t["status"] == "DONE" and t["deps"]:
        problems.append(f"{t['id']} is DONE and has dependencies")

# 3. lanes
placed = [x for v in chk.AGENT_ORDER.values() for x in v]
for t in TASKS:
    if t["agent"] and t["id"] in chk.ORCH_LANE:
        problems.append(f"{t['id']} sits in an agent lane and in the orchestrator lane")
    if t["status"] == "TODO" and t["agent"] is None and not t["who"] and t["id"] not in chk.ORCH_LANE:
        problems.append(f"{t['id']} is in no lane and has no person")
    if t["status"] == "TODO" and t["id"] in _lane_of and placed.count(t["id"]) != 1:
        problems.append(f"{t['id']} is in {placed.count(t['id'])} agent lanes (must be exactly one)")
for x in placed:
    if x not in BY_ID:
        problems.append(f"agent lane lists unknown task {x}")
for x in chk.ORCH_LANE + chk.ORCH_ORDER:
    if x not in BY_ID:
        problems.append(f"orchestrator lane lists unknown task {x}")
for x in chk.ORCH_ORDER:
    if x not in chk.ORCH_LANE:
        problems.append(f"{x} is in the orchestrator queue but not in ORCH_LANE")
# file paths
def repo_root(t):
    return APP_REPO if t["repo"] == "app" else API_REPO
for t in TASKS:
    for p in t["files"]:
        if p.startswith("+") or p == "-":
            continue
        if not glob.glob(os.path.join(repo_root(t), p)):
            problems.append(f"{t['id']} lists {p}, which does not exist in {os.path.basename(repo_root(t))}")

# ------------------------------------------------------------------------------------------------ durations and the scheduler
FACT = core.FACTORS

def duration(t, case):
    """Elapsed working days of one task in the 'low' or 'high' case."""
    k = 0 if case == "low" else 1
    if t["status"] == "DONE":
        return 0.0
    if t["who"] in ("WITH-HARSH", "WITH-SIDDHI", "WITH-CA") and t["lead"] and not t["agent"] and t["id"] not in chk.ORCH_LANE:
        return float(t["lead"][k])
    if t["lo"] is not None:
        return float(t["lo"] if k == 0 else t["hi"])
    return t["pd"] * FACT[t["grp"]][k]

def schedule(case, durs=None, cal=None):
    """List scheduling: three agent lanes in their stated order, the orchestrator-with-Harsh queue (one task at a time), everything else
    as soon as its dependencies are done. With a calendar, Siddhi's tasks avoid her absence in Dhanteras week (3 to 11 Nov)."""
    durs = durs or {t["id"]: duration(t, case) for t in TASKS}
    lanes = dict(chk.AGENT_ORDER)
    lanes["O"] = [x for x in chk.ORCH_ORDER]
    start, fin, why = {}, {}, {}
    free = {a: 0.0 for a in lanes}
    last_in_lane = {a: None for a in lanes}
    ptr = {a: 0 for a in lanes}
    lane_of = {x: a for a, order in lanes.items() for x in order}
    pending = {t["id"] for t in TASKS if t["id"] not in lane_of}
    left = sum(len(v) for v in lanes.values()) + len(pending)
    b0 = b1 = None
    if cal is not None:
        b0 = next(i for i, d in enumerate(cal) if d >= core.SIDDHI_AWAY_FROM)
        b1 = max(i for i, d in enumerate(cal) if d <= core.SIDDHI_AWAY_TO) + 1

    def place(tid, s):
        tk = BY_ID[tid]
        d = durs[tid]
        if cal is not None and tk["who"] == "WITH-SIDDHI":
            is_wait = bool(tk["lead"]) and not tk["agent"] and tid not in chk.ORCH_LANE
            if is_wait:
                f = s + d
                if b0 < f <= b1:
                    s = (b1 + 0.5) - d       # her answer arrives half a day into Thu 12 Nov
            elif s < b1 and s + d > b0:
                s = float(b1)                # she starts again on Thu 12 Nov
        return s, s + d

    guard = 0
    while left and guard < 100000:
        guard += 1
        moved = False
        for tid in sorted(pending):
            tk = BY_ID[tid]
            if all(d in fin for d in tk["deps"]):
                s0 = max([fin[d] for d in tk["deps"]] or [0.0])
                start[tid], fin[tid] = place(tid, s0)
                why[tid] = max(tk["deps"], key=lambda d: fin[d]) if tk["deps"] else None
                pending.discard(tid)
                left -= 1
                moved = True
        for a, order in lanes.items():
            if ptr[a] >= len(order):
                continue
            tid = order[ptr[a]]
            tk = BY_ID[tid]
            if all(d in fin for d in tk["deps"]):
                dep_ready = max([fin[d] for d in tk["deps"]] or [0.0])
                s0 = max(free[a], dep_ready)
                start[tid], fin[tid] = place(tid, s0)
                if tk["deps"] and dep_ready >= free[a]:
                    why[tid] = max(tk["deps"], key=lambda d: fin[d])
                else:
                    why[tid] = last_in_lane[a]
                free[a] = fin[tid]
                last_in_lane[a] = tid
                ptr[a] += 1
                left -= 1
                moved = True
        if not moved:
            for a, order in lanes.items():
                if ptr[a] < len(order):
                    head = order[ptr[a]]
                    wait = [d for d in BY_ID[head]["deps"] if d not in fin]
                    print(f"  deadlock: lane {a} waits at {head} for {wait}")
            return None, None, None, durs
    return start, fin, why, durs

def critical_path(fin, why, end):
    cp = [end]
    while why.get(cp[-1]):
        cp.append(why[cp[-1]])
    cp.reverse()
    return cp

def date_of(t, cal):
    n = max(int(math.ceil(t - 1e-9)), 1)
    return cal[n - 1]

def fmt(d):
    return d.strftime("%a %d %b")

CASES = [("low", "off"), ("low", "on"), ("high", "off"), ("high", "on")]
CAL = {"off": core.CAL_OFF, "on": core.CAL_ON}
RUNS = {}       # Sundays off
RUNS_ON = {}    # Sundays worked
for case in ("low", "high"):
    s_, f_, w_, d_ = schedule(case, cal=core.CAL_OFF)
    if s_ is None:
        problems.append(f"the lanes deadlock in the {case} case: some lane waits for a task behind another waiting task")
        break
    RUNS[case] = dict(start=s_, fin=f_, why=w_, durs=d_)
    s2, f2, w2, d2 = schedule(case, cal=core.CAL_ON)
    RUNS_ON[case] = dict(start=s2, fin=f2, why=w2, durs=d2)

# latest finish (float on dependencies only; agent lanes ignored, so slightly optimistic)
def latest_finish(case):
    r = RUNS[case]
    end = max(r["fin"].values())
    succ = defaultdict(list)
    for t in TASKS:
        for d in t["deps"]:
            succ[d].append(t["id"])
    for t in TASKS:
        for s_ in t["soft_before"]:
            succ[t["id"]].append(s_)
    LF = {}
    def lf(tid):
        if tid in LF:
            return LF[tid]
        if not succ[tid]:
            LF[tid] = end
        else:
            LF[tid] = min(lf(s) - r["durs"][s] for s in succ[tid])
        return LF[tid]
    for t in TASKS:
        lf(t["id"])
    return LF

# ------------------------------------------------------------------------------------------------ report
ok = not problems
print(f"spec: {len(spec_ids)} requirement and open-item IDs, {len(spec_tests)} tests (draft 5.2, commit {SPEC_COMMIT}, {len(lines) - (1 if lines and lines[-1] == '' else 0)} lines)")
print(f"tasks: {len(TASKS)} ({sum(1 for t in TASKS if t['status']=='DONE')} done, {sum(1 for t in TASKS if t['status']=='TODO')} to do)")
print(f"exempt IDs: {', '.join(chk.EXEMPT)}")
for w in warnings:
    print("warning:", w)
for p in problems:
    print("PROBLEM:", p)
if ok:
    print("coverage OK: every spec ID is on exactly one task, every test is introduced by exactly one task and can pass there")
if not ok:
    sys.exit(1)
if "--float" in sys.argv:
    for c in ("low", "high"):
        LF_ = latest_finish(c)
        print("--- float of people tasks,", c)
        for t in TASKS:
            if t["who"] and not t["agent"] and t["id"] not in chk.ORCH_LANE:
                arr = RUNS[c]["fin"][t["id"]]
                print(f"  {t['id']:5} arrives {arr:5.2f} latest {LF_[t['id']]:5.2f} float {LF_[t['id']] - arr:5.2f}")
if "--sched" in sys.argv:
    for case in ("low", "high"):
        r = RUNS[case]
        end = max(r["fin"], key=lambda x: r["fin"][x])
        print(f"--- {case}: last task {end} at working day {r['fin'][end]:.2f}")
        busy = {a: sum(r["durs"][x] for x in order) for a, order in chk.AGENT_ORDER.items()}
        print("lane busy (working days):", {a: round(v, 1) for a, v in busy.items()})
        for tid in ("API03", "API22", "API26", "API31", "RV2", "WEB12", "OPS04", "OPS05", "OPS07", "QA02", "QA04", "IMP03", "QA05"):
            for cal in ("off", "on"):
                pass
            print(f"  {tid:6} start {r['start'][tid]:5.2f} finish {r['fin'][tid]:5.2f}  off {fmt(date_of(r['fin'][tid], core.CAL_OFF))}  on {fmt(date_of(r['fin'][tid], core.CAL_ON))}")
        cp = critical_path(r["fin"], r["why"], end)
        print("critical path:", " > ".join(cp))
# only a run with no flag (or with --build) writes plan.md and tasks.md; every other flag is read-only
if any(a.startswith("--") and a != "--build" for a in sys.argv[1:]):
    sys.exit(0)

exec(open(os.path.join(HERE, "render.py"), encoding="utf-8").read())
