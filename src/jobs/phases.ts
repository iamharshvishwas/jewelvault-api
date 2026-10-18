// I8: the phases of the hourly tick, in the order the spec lists them: `nightly_check`, the heartbeat, then `housekeeping` and `photo_copy`.
//
//   nightly_check   API32's runNightlyCheck on the tick's connection with the job lock held, for the business date of the run: one snapshot, one `check_runs` row (the verdict of the books). The
//                   phase is `ok` when the check COMPLETED, whatever it found: a broken invariant is `check_runs.ok = 0`, not a failed phase.
//   heartbeat       the tick's own mark that it ran: its row in `sys_job_runs` (job `heartbeat`, one for each business date) is updated at every tick, `finished_at` and `detail.last_tick_at`. It is not
//                   work, so it writes no `event` row (24 rows a day of nothing would only bury the real ones).
//   housekeeping    API33b (src/jobs/housekeeping.ts): the closing of finished login-failure hours (D24) at every tick, and L6 (the stored result of a request row older than 90 days is emptied)
//                   once for the business date, from 02:00. It writes its event row only when it did something.
//   photo_copy      API33b (src/jobs/photoCopy.ts): each photo not yet copied is written once into JV_BACKUP_DIR/photos, in slices that stop starting work after 25 s; `ok` and the heartbeat row of
//                   backup_runs only when the whole list is done, nightly work like the check.
//
// The dump (`db_dump`) is not a phase of the tick: it is the script of API34 with its own lock and its own `sys_job_runs` rows.
import { housekeepingPhase } from './housekeeping.js';
import { runNightlyCheck } from './nightly.js';
import { photoCopyPhase } from './photoCopy.js';
import type { Phase } from './types.js';

export const nightlyCheckPhase: Phase = {
  job: 'nightly_check',
  due: 'nightly',
  async run(ctx) {
    const result = await runNightlyCheck(ctx.conn, { clock: ctx.app.clock, date: ctx.runDate });
    return {
      complete: true,
      detail: { date: result.date, check_run_id: result.checkRunId, books_ok: result.ok },
      facts: { check_run_id: result.checkRunId, books_ok: result.ok },
    };
  },
};

export const heartbeatPhase: Phase = {
  job: 'heartbeat',
  due: 'every_tick',
  audited: false,
  async run(ctx) {
    return { complete: true, detail: { last_tick_at: ctx.app.clock.read().timestamp } };
  },
};

/** The phases of the application's tick, in the order of I8. */
export function defaultPhases(): Phase[] {
  return [nightlyCheckPhase, heartbeatPhase, housekeepingPhase, photoCopyPhase];
}

const JOB_NAME = /^[a-z][a-z0-9_]{0,39}$/;

/** A list of phases the tick can run: names that fit `sys_job_runs.job`, each once. */
export function checkPhases(phases: readonly Phase[]): void {
  const seen = new Set<string>();
  for (const phase of phases) {
    if (!JOB_NAME.test(phase.job)) throw new TypeError(`the name of a phase is 1 to 40 lower-case letters, digits and underscores: ${JSON.stringify(phase.job)}`);
    if (seen.has(phase.job)) throw new TypeError(`the phase ${phase.job} is listed twice`);
    seen.add(phase.job);
    if (!['nightly', 'daily', 'every_tick'].includes(phase.due)) throw new TypeError(`the phase ${phase.job} is due ${JSON.stringify(phase.due)}: nightly, daily or every_tick`);
  }
}
