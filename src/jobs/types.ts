// I8, D25: what a phase of the hourly tick is. A phase is one unit of scheduled work with its own row in `sys_job_runs` for each business date (unique on `job` and `run_date`, so a retry is an UPDATE
// and not a new row). The tick (src/jobs/tick.ts) decides whether a phase is due, claims its row, runs it on the tick's own connection (the job lock is held on it), and records how it ended.
// API33 builds `nightly_check` and the heartbeat; API33b adds `housekeeping` and `photo_copy` to the list in src/jobs/phases.ts, API34's dump is a script of its own and not a phase of the tick.
import type { FastifyInstance } from 'fastify';
import type { DbConnection } from '../db/pool.js';
import type { TxContext } from '../db/tx.js';

/**
 * When a phase is due (I8: "a phase is due when it is not `ok` for today's date and, for the nightly work, it is after 02:00 in Asia/Kolkata"):
 *   nightly      not `ok` for today's business date, and the time is 02:00 in Asia/Kolkata or later (the nightly check, the photo copy)
 *   daily        not `ok` for today's business date, at any hour
 *   every_tick   at every tick (the heartbeat; the closing of finished login-failure hours, D24, which must not wait for the next day)
 */
export type Due = 'nightly' | 'daily' | 'every_tick';

export interface PhaseContext {
  readonly app: FastifyInstance;
  /**
   * The tick's connection. The job lock `jv_tick:<database>` is held on it, it is in autocommit (no transaction is open: START TRANSACTION would commit one that is), and its statement limit is
   * 20 seconds (S11, I8).
   */
  readonly conn: DbConnection;
  /**
   * A new TxContext for withTx, withRead and withAutocommit over a pool of this one connection, with the actor `{ id: null, role: 'job' }` and the tick's request id: a phase that writes in a
   * transaction (an `event` row, `closeFinishedHour`) uses this, so its work stays on the connection that holds the lock and takes no second place in the pool. Call it for each transaction: the
   * 12 seconds of S12 count from the moment the context is made.
   */
  readonly txContext: () => TxContext;
  /** The business date (Asia/Kolkata) the run is for: `sys_job_runs.run_date`. */
  readonly runDate: string;
  /** The row as the run took it over: a phase that works in slices finds where the last slice stopped in `detail` (null on the first run of the date). */
  readonly previous: { readonly status: string; readonly detail: unknown } | null;
  /** The call is over (the handler timer fired or the client went): start no new work. */
  readonly signal: AbortSignal;
  /** The id of the tick's request: the `request_id` of the audit rows written for this run. */
  readonly requestId: string;
}

export interface PhaseResult {
  /** true: the phase is complete for the date and its row becomes `ok`. false: a slice that stopped early (the row stays `running` with the end time of the slice, `detail` says where, and the next tick goes on at once). */
  complete: boolean;
  /** Stored in `sys_job_runs.detail`: counts and where the phase stopped. No customer data. */
  detail?: Record<string, unknown>;
  /** Added to the facts of the phase's `event` audit row: identifiers and counts only (writeEvent refuses a key that names a secret). */
  facts?: Record<string, unknown>;
  /**
   * true: the run had nothing to do and writes its row in `sys_job_runs` but NO `event` row. For a phase that is due at every tick (the housekeeping, API33b), whose idle runs would be 24
   * rows a day of nothing in an audit log that nothing can purge (S7); a run that did something says nothing here and has its event.
   */
  quiet?: boolean;
}

export interface Phase {
  /** The `job` of the phase's rows: 1 to 40 characters, lower case, digits and underscores. */
  readonly job: string;
  readonly due: Due;
  /** Whether each run writes the `event` row (D16, T-D14). Default true. Only the heartbeat, which is not work, says false. */
  readonly audited?: boolean;
  run(ctx: PhaseContext): Promise<PhaseResult>;
}

/** What the tick says about one phase. */
export type Outcome =
  /** it ran and is complete for the date */
  | 'ran'
  /** it ran a slice and stopped early; the next tick goes on */
  | 'partial'
  /** the phase is `ok` for the date already ("already done") */
  | 'already_done'
  /** a nightly phase before 02:00 Asia/Kolkata */
  | 'not_due'
  /** the row says `running`, with no end time, and is younger than 10 minutes: somebody has it */
  | 'running_elsewhere'
  /** not started: the handler timer fired or the client went, or the connection was lost */
  | 'skipped'
  | 'failed';

export interface PhaseReport {
  job: string;
  outcome: Outcome;
}

export interface TickResult {
  /** `already_running`: the lock is taken, nothing was done. */
  status: 'ok' | 'already_running';
  /** The business date of the tick. */
  run_date: string | null;
  phases: PhaseReport[];
}
