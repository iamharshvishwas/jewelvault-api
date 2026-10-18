// I8: when the tick's phases are due. The numbers of the spec's "Phases and retry" paragraph, in one place (src/limits.ts holds the caps of the data; these belong to the jobs and API34's dump script
// reads the same file):
//   - a phase's row in `sys_job_runs` that says `running` and was started more than 10 MINUTES ago is abandoned and is taken over (the dump: 30, API34);
//   - the nightly work waits for 02:00 in ASIA/KOLKATA, computed here from the API's clock, so no time-zone assumption is made about cron;
//   - the tick's statement limit is 20 seconds, and the tick's own handler timer 50 (src/security/requestLimits.ts);
//   - the photo copy's slice stops starting new work after 25 seconds (I8: 25 plus one statement of up to 20 stays under the handler timer of 50);
//   - the result of a request row (`sys_idempotency`) older than 90 days is emptied by the nightly housekeeping (L6).
import type { Reading } from '../clock.js';

export const JOB_LIMITS = Object.freeze({
  /** A `running` row older than this is abandoned (I8). */
  abandonedAfterMs: 10 * 60 * 1000,
  /** The nightly work (the check, the photo copy) is due from this hour on, Asia/Kolkata (I8). */
  nightlyFromHour: 2,
  /** The statement limit of the tick's session, in seconds (S11, I8). */
  statementSeconds: 20,
  /** A slice of the photo copy stops starting new work after this many seconds (I8). */
  photoSliceSeconds: 25,
  /** The most photos one slice takes from the list of those still to copy; a slice cut by it is not complete (a bound on the list, not on the work: the time is the limit). */
  photoRowsPerSlice: 5000,
  /** L6: a request row older than this many days has its stored result emptied; the row stays (S7) and a repeat of its key is refused. */
  idempotencyKeepDays: 90,
});

const BUSINESS_OFFSET_MICROS = 19_800_000_000n; // +05:30, India has no daylight saving
const DAY_MICROS = 86_400_000_000n;
const HOUR_MICROS = 3_600_000_000n;

/** Whether the instant is 02:00:00 in Asia/Kolkata or later on its business date (the nightly work is due). */
export function afterNightlyGate(reading: Pick<Reading, 'micros'>): boolean {
  const sinceMidnight = (((reading.micros + BUSINESS_OFFSET_MICROS) % DAY_MICROS) + DAY_MICROS) % DAY_MICROS;
  return sinceMidnight >= BigInt(JOB_LIMITS.nightlyFromHour) * HOUR_MICROS;
}
