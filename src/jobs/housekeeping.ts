// I8, L6, D24: THE HOUSEKEEPING, the third phase of the tick. Two jobs of different rhythm in one phase, because the spec lists them as one ("`housekeeping` (L6, and the closing of finished
// login-failure hours, D24)"):
//
//   1. THE LOGIN-FAILURE HOURS (D24), at EVERY tick. A failed login adds one to the counter of the current hour and the first failure after the hour has changed writes the hour's one
//      `login_failures` event; so the last hour of an attack would stay unwritten until somebody else fails a login. Each tick therefore calls `closeFinishedHour` (src/auth/loginCounters.ts,
//      the twin of the library of the database half, MB07), which claims a finished hour that has failures with the conditional UPDATE of D24 (exactly one caller wins, no failure counted
//      meanwhile is lost) and writes the event. It writes nothing for an hour with no failures and nothing for an hour that has not ended.
//
//   2. L6, NIGHTLY: "For rows of `sys_idempotency` older than 90 days the nightly job (I8) empties `result`; the row itself stays (about 150 bytes; S7 allows no delete). A repeat of a key older
//      than 90 days is refused with JV_INVALID_INPUT ("this request is too old to repeat"); it is never run again." The refusal is src/db/idempotency.ts: a row whose result is empty refuses a
//      repeat of its key. This phase makes the result empty: once for the business date, not before 02:00 Asia/Kolkata, in batches (a batch is one UPDATE that finds its rows by the index of
//      `created_at`). The date of the last complete emptying is kept in `detail`, because a phase that is due at every tick finds its previous row (ctx.previous) and so knows.
//
// The run writes its `event` row (the tick does) only when it DID something: an hour closed, or results emptied. A tick with nothing to do would add 24 rows a day of nothing to an audit log that
// nothing can purge (S7), the reason the heartbeat is not audited either. The closed hour has its own `login_failures` row (D24); this event says that the phase was the one that closed it.
import { closeFinishedHour } from '../auth/loginCounters.js';
import { formatTimestamp, systemClock } from '../clock.js';
import { withAutocommit } from '../db/autocommit.js';
import { JOB_LIMITS, afterNightlyGate } from './schedule.js';
import type { Phase, PhaseContext } from './types.js';

/** L6. `created_at` is the index (ix_idempotency_created); a row whose result is already empty is not touched again. */
const EMPTY_SQL = 'UPDATE sys_idempotency SET result = NULL WHERE created_at < CAST(? AS DATETIME(6)) AND result IS NOT NULL ORDER BY created_at LIMIT ?';

const DAY_MICROS = 86_400_000_000n;
/** Rows one UPDATE empties. */
const BATCH_ROWS = 500;

export interface HousekeepingOptions {
  /** Rows emptied by one statement (default 500). A test seam: a small number shows the loop. */
  batch?: number;
}

interface Emptied {
  date: string;
  emptied: number;
}

/** The last complete emptying, as the row of the phase kept it: { date, emptied }, or null. */
function lastEmptying(previous: PhaseContext['previous']): Emptied | null {
  const detail = previous?.detail;
  if (!detail || typeof detail !== 'object') return null;
  const e = (detail as { idempotency?: Partial<Emptied> }).idempotency;
  return e && typeof e.date === 'string' && typeof e.emptied === 'number' ? { date: e.date, emptied: e.emptied } : null;
}

/**
 * Empties the stored result of every request row created before `cutoff` (DATETIME(6) text), `batch` rows at a time, and answers how many. Stops between two batches when the call is over (the
 * signal); `done` says whether the last batch found nothing more to do.
 */
export async function emptyOldResults(ctx: PhaseContext, cutoff: string, batch: number): Promise<{ emptied: number; done: boolean }> {
  let emptied = 0;
  for (;;) {
    if (ctx.signal.aborted) return { emptied, done: false };
    const res = await withAutocommit(ctx.txContext(), (db) => db.run(EMPTY_SQL, [cutoff, batch]));
    emptied += res.affectedRows;
    if (res.affectedRows < batch) return { emptied, done: true };
  }
}

export function createHousekeepingPhase(options: HousekeepingOptions = {}): Phase {
  const batch = options.batch ?? BATCH_ROWS;
  return {
    job: 'housekeeping',
    due: 'every_tick',
    async run(ctx) {
      const reading = ctx.app.clock.read();
      const facts: Record<string, unknown> = {};

      // 1. D24: the hour that ended. With the database's own clock, as the counters are written (D24) - or on the clock of the application when it was given one (a test).
      const now = ctx.app.clock === systemClock ? undefined : new Date(Number(reading.micros / 1000n));
      const closed = await closeFinishedHour(ctx.txContext(), { now });
      if (closed) {
        facts.login_failures_hour = closed.hour;
        facts.login_failures = closed.failures;
      }

      // 2. L6: once for the business date, from 02:00 in Asia/Kolkata
      let idempotency = lastEmptying(ctx.previous);
      let complete = true;
      if (idempotency?.date !== ctx.runDate && afterNightlyGate(reading)) {
        const cutoff = formatTimestamp(reading.micros - BigInt(JOB_LIMITS.idempotencyKeepDays) * DAY_MICROS);
        const result = await emptyOldResults(ctx, cutoff, batch);
        if (result.emptied > 0) facts.idempotency_emptied = result.emptied;
        if (result.done) idempotency = { date: ctx.runDate, emptied: result.emptied };
        else complete = false; // the call is over: the next tick goes on
      }

      return {
        complete,
        quiet: Object.keys(facts).length === 0,
        detail: { ...(idempotency ? { idempotency } : {}), ...(closed ? { closed_hour: { hour: closed.hour, failures: closed.failures } } : {}) },
        facts,
      };
    },
  };
}

/** The application's housekeeping. */
export const housekeepingPhase: Phase = createHousekeepingPhase();
