# -*- coding: utf-8 -*-
"""Shared definitions for the plan generator: the task constructor, the speed groups, the calendar and the people lead times.

Everything that is a judgement (a speed factor, a lead time) is written here once, with its reason, so the plan and the
schedule cannot disagree.
"""

TASKS = []

# --------------------------------------------------------------------------------------------- speed groups
# Elapsed working days of the chain per plan-day (low, high). A plan-day is the work one implementer is expected to finish
# in one focused day, tests and commit included; it is an untested unit.
#
# Measured on the Supabase build (jewelvault-app/_build/p1-plan/unit-samples.csv): 11 tasks, 417 agent minutes for 10.9
# plan-days = 38 minutes a plan-day, all of them pure database or pure TypeScript tasks, plus 20 to 25 minutes of the
# orchestrator's own check on some; the first five database tasks (5.3 plan-days) took 4.1 hours. No money function, no
# two-session concurrency test, no browser test and no Hostinger deploy was ever measured.
FACTORS = {
    # pure SQL or TypeScript with a written oracle: measured 0.08 of a working day per plan-day (38 min of 8 h) before the
    # orchestrator's check and merge; the low case allows for that check, the high case is three times the low case
    "pure": (0.12, 0.40),
    # money write functions, lock order, two-session tests, random sequences, job locks: nothing like it was measured, and
    # these are the tasks where one flaky interleaving costs a day; the low case is 3 to 4 times the measured pure speed
    "money": (0.30, 0.90),
    # browser work (Playwright is slow and flaky, the screens are big files the stores touch in 15 places)
    "web": (0.25, 0.70),
    # one-off work in Harsh's hPanel, with Harsh at the screen: not scaled by agent speed, 1 plan-day = 1 working day at best
    "ops": (0.80, 1.50),
}

# --------------------------------------------------------------------------------------------- calendar
import datetime as dt

TODAY = dt.date(2026, 10, 16)          # the day this plan is written (Friday)
START = dt.date(2026, 10, 17)          # day 1: the plan review (RV0) starts; implementers start when it passes
DUSSEHRA = dt.date(2026, 10, 20)       # Tuesday: nobody works (same rule as the Supabase plan)
DHANTERAS = dt.date(2026, 11, 6)       # Friday
DIWALI = dt.date(2026, 11, 8)          # Sunday: nobody works, in both scenarios
BHAI_DOOJ = dt.date(2026, 11, 11)      # Wednesday
PLAN_EXPIRES = dt.date(2027, 3, 22)    # Hostinger plan expiry read in hPanel
HOSTING_PROMISED_TO = dt.date(2027, 4, 30)

# The shop does not switch billing in Dhanteras week: Tue 3 Nov (three days before Dhanteras) to Wed 11 Nov (Bhai Dooj).
NO_SWITCH_FROM = dt.date(2026, 11, 3)
NO_SWITCH_TO = BHAI_DOOJ


def calendar(sundays_worked, n=140):
    """Working days from START. Dussehra and Diwali are off in both scenarios; Sundays are off unless worked."""
    out, d = [], START
    while len(out) < n:
        off = d in (DUSSEHRA, DIWALI) or (d.weekday() == 6 and not sundays_worked)
        if not off:
            out.append(d)
        d += dt.timedelta(days=1)
    return out


CAL_OFF = calendar(False)
CAL_ON = calendar(True)


def T(id, lane, title, *, agent=None, repo="api", deps=(), pd=0.0, grp="pure", reqs=(), tests=(), extends=(), uses=(),
      ptests=(), do="", files=(), done="", rollback=None, status="TODO", commit="", lo=None, hi=None, who=None,
      lead=None, tripwire=None, gate=None, plan_ref="", note="", soft_before=()):
    """One task. `reqs` and `tests` are the spec lines this task OWNS (each ID on exactly one task); `uses` lists IDs that
    other tasks own but this task also touches; `extends` lists tests this task completes a part of.

    lane: DB API WEB OPS IMP QA RV PH PS.  agent: A B C for work done by a Claude agent, None for work by people.
    pd: plan-days (the nominal unit).  lo/hi: explicit elapsed working days (reviews, ops, people).
    lead: for people tasks, (low, high) working days from the day they are asked until the answer is in hand.
    soft_before: tasks that SHOULD NOT start before this one has arrived but do not wait for it (the default ships); used only
    to compute the latest day an answer can arrive.
    """
    t = dict(id=id, lane=lane, title=title, agent=agent, repo=repo, deps=list(deps), pd=pd, grp=grp, reqs=list(reqs),
             tests=list(tests), extends=list(extends), uses=list(uses), ptests=list(ptests), do=do, files=list(files),
             done=done, rollback=rollback, status=status, commit=commit, lo=lo, hi=hi, who=who, lead=lead,
             tripwire=tripwire, gate=gate, plan_ref=plan_ref, note=note, soft_before=list(soft_before))
    TASKS.append(t)
    return t


ROLLBACK_LOCAL_API = ("Local: `git revert` the task's commit; the test database is rebuilt from the migration files by "
                      "`npm run db:lane reset`. Nothing outside the repository is touched by this task. Migrations are "
                      "forward-only, so a migration that already reached staging is fixed by a new migration or, in the "
                      "worst case, by restoring into a new empty database (spec B5).")
ROLLBACK_LOCAL_WEB = ("Local: `git revert` the task's commit in `jewelvault-app`; the static site has no data of its own. "
                      "A deployment that already went out is rolled back by promoting the previous deployment in Vercel.")
ROLLBACK_NONE = "Nothing to roll back (people or reading only)."
ROLLBACK_REVIEW = "Nothing to roll back (a review only reads; fixes are separate commits)."
