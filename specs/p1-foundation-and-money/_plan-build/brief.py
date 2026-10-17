#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Print the brief for one task: python3 _plan-build/brief.py API01   (read-only; the orchestrator pastes it to an implementer).

The brief = the task text of tasks.md + the spec lines the task owns + the rules of the plan + the handoff notes of finished tasks
(jewelvault-api/docs/handoffs.md, if it exists)."""
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
SPEC_DIR = os.path.abspath(os.path.join(HERE, ".."))
API_REPO = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
WT_API = os.path.abspath(os.path.join(API_REPO, "..", "jewelvault-api-wt"))
WT_APP = os.path.abspath(os.path.join(API_REPO, "..", "jewelvault-app-wt"))
SPEC_COMMIT = "fcf2ba6"

import plan_core as core
import plan_api, plan_web, plan_ops  # noqa: F401
import plan_checks as chk

BY_ID = {t["id"]: t for t in core.TASKS}
lane_of = {x: a for a, order in chk.AGENT_ORDER.items() for x in order}

RULES = """RULES OF THE PLAN (they apply to every task; read them):
1. TESTS FIRST. Write each test named in "Tests first written here" / "Done when", run it, SEE IT FAIL FOR THE RIGHT REASON, then write the code. Name each spec test in a describe('T-xxx ...') block so that `npm test -- -t T-xxx` finds it. Add a negative control where the spec asks for one.
2. ONE LOCAL COMMIT PER TASK (more only if the task says so). Message: what changed, the spec IDs it covers, the task id; end the message with the line `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`. NEVER git push, pull, fetch or open a pull request. Commit only the files you changed (git add <paths>, never git add -A). Work only in your own worktree/branch; do not touch the main working tree of any repository, other worktrees, or other sessions' files. If the git index is locked, wait and retry.
3. DOCKER/MariaDB: use only your own lane container (`npm run db:lane -- up <lane>` once API01 exists; before that, a container named jv-mariadb-<lane> on port 33310 + lane number, MariaDB 11.8, --transaction-isolation=READ-COMMITTED, data in tmpfs, no volume). Remove only your own container with `docker rm -fv <its name>`. NEVER touch the container `keep-tourstack-and-unknown-volumes` or `jv-mariadb-spike` (another session's). No Docker volumes.
4. NEVER touch Hostinger, GitHub, Vercel, Cloudflare, Supabase or the old jewelvault-app worktrees (jewelvault-wt/a,b,c). Never put a password, key or token in a file, a log or a message; test secrets are generated at run time. The application database user in tests is the ten-box user of spec A3 (no Delete, Drop, Create view, Show view, Execute, Create routine, Alter routine, Event).
5. Do not edit the spec, the plan, tasks.md, NODE-DESIGN.md, or files in db/ unless the task says so. Do not "fix" things outside the task: write them in your report as follow-ups.
6. Match the surrounding code's style. TypeScript 5.9 (not 7), Node >= 24.7, ESM. Read the spec lines named below in full, and the related files named in the task, before writing code.
7. Money is integers (paise, milligrams) in Node and DECIMAL text in SQL; no float in any money path; money and weight cross the wire as strings.
8. REPORT (your final message, under 300 words): what you built, the commit hash, the exact commands you ran and their result (tests passed/failed counts), anything the next tasks must know (also append 3 to 8 lines to docs/handoffs.md in your worktree under a heading with the task id and include that file in your commit), and what you could not do or are unsure of. If a spec line or the plan seems wrong, say so in the report instead of working around it silently.
"""


def spec_lines(ids):
    text = subprocess.run(["git", "show", f"{SPEC_COMMIT}:specs/p1-foundation-and-money/spec.md"], cwd=API_REPO,
                          capture_output=True, text=True, check=True).stdout.split("\n")
    out = []
    import re
    for i in ids:
        pat = re.compile(r"^\s*(?:[-*]\s*)?\*\*" + re.escape(i) + r"[\.\s:*]|^\| " + re.escape(i) + r" \|")
        for n, ln in enumerate(text, 1):
            if pat.match(ln):
                out.append(f"[{i}] (spec line {n}) {ln.strip()}")
                break
    return out


def main(tid):
    t = BY_ID[tid]
    lane = lane_of.get(tid)
    wt = branch = None
    if lane:
        if t["repo"] == "app":
            wt = os.path.abspath(os.path.join(API_REPO, "..", "jewelvault-app-wt-web")) if lane == "B" else os.path.join(WT_APP, lane.lower())
            branch = "api-web" if lane == "B" else "api-web-" + lane.lower()
        else:
            wt = os.path.join(WT_API, lane.lower())
            branch = "api-" + lane.lower()
    print(f"You are agent {lane or '-'} implementing task {tid}: {t['title']}")
    print(f"Plan: {SPEC_DIR}/plan.md and tasks.md (read the section of {tid} in tasks.md first). Spec: git show {SPEC_COMMIT}:specs/p1-foundation-and-money/spec.md in {API_REPO}.")
    if wt:
        print(f"Your worktree: {wt} (branch {branch}); repository: {'jewelvault-app' if t['repo']=='app' else 'jewelvault-api'}.")
    print(f"Depends on (already merged): {', '.join(t['deps']) or '-'}")
    print()
    print(RULES)
    print(f"TASK {tid} ({t['grp']}, {t['pd']} plan-days)")
    print("Spec lines this task owns:", ", ".join(t["reqs"]) or "-", "| also touches:", ", ".join(t["uses"]) or "-")
    print("Tests first written here:", ", ".join(t["tests"]) or "-", "| extends:", ", ".join(t["extends"]) or "-")
    for p in t["ptests"]:
        print("Plan test:", p)
    print()
    print("DO:", t["do"])
    if t["files"]:
        print("FILES:", ", ".join(t["files"]))
    if t["note"]:
        print("NOTE:", t["note"])
    print()
    print("DONE WHEN:", t["done"])
    cl = [(x, c) for (x, c, tid) in chk.TEST_CLAUSES if tid == t["id"]]
    if cl:
        print("ALSO PROVES (clauses of tests introduced in other tasks; each is one check here):", "; ".join(f"{x}: {c}" for x, c in cl))
    print("ROLLBACK:", t["rollback"])
    print()
    print("THE SPEC LINES (verbatim):")
    for ln in spec_lines(t["reqs"] + t["uses"][:0]):
        print(ln)
        print()
    hp = os.path.join(API_REPO, "docs", "handoffs.md")
    if os.path.exists(hp):
        print("HANDOFF NOTES OF FINISHED TASKS (docs/handoffs.md):")
        print(open(hp, encoding="utf-8").read())


if __name__ == "__main__":
    if len(sys.argv) != 2 or sys.argv[1] not in BY_ID:
        print("usage: brief.py <task id>; ids:", " ".join(BY_ID))
        sys.exit(2)
    main(sys.argv[1])
