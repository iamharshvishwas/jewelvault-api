# _plan-build: the generator and checker of plan.md and tasks.md

Run `python3 _plan-build/build_plan.py` (Python 3.9 or newer, standard library only, `git` on the path) from `jewelvault-api`.

- `plan_core.py`   the task constructor, the speed groups (best and worst factor per plan-day) and the calendar (Dussehra, Diwali, Sundays).
- `plan_api.py`    the MariaDB half (done, aligned, audit triggers) and the Node API tasks.
- `plan_web.py`    the front end (jewelvault-app) tasks.
- `plan_ops.py`    reviews, Harsh's and Siddhi's tasks, Hostinger operations, the import, acceptance and go-live.
- `plan_checks.py` the agent lanes, the exempt spec IDs, the clauses that several tasks complete, the documented ignores.
- `build_plan.py`  reads the spec from git (`git show eec220e:specs/p1-foundation-and-money/spec.md`), checks, schedules, writes the two files.
- `render.py`      the text of plan.md and tasks.md.

With no flag (or `--build`) the script checks and then WRITES plan.md and tasks.md. Every other flag is read-only: `--check` (checks only), `--sched` (print the schedule), `--float` (float of the people tasks), `--show-ignores`. With `NOIGN=1` the
documented ignore list is switched off to show every name a test's Req column carries that a later task owns.

The checks fail (exit 1) when: a spec ID is on no task or on two tasks; a test is introduced by no task or two; a test names a requirement that
only a LATER task owns and no documented ignore says why; a clause names a task that does not list the test; a dependency is missing or cyclic;
an agent task is in no lane or two lanes or the lanes deadlock; a task is over 1.5 plan-days; an existing file path in a task does not exist; a task extends a test that no clause (TEST_CLAUSES) names; an ignore is not needed any more (dead ignore); an ignore reason names a task that owns no clause of that test.
Every clause is printed into the Done-when of its owner in tasks.md ("Also proves") and by `brief.py`, so an implementer sees each clause as one check.
Never edit plan.md or tasks.md by hand; edit the data and run the script again.
