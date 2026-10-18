// I8: THE HOURLY TICK. One call runs the phases that are due, one at a time, inside the request (a background task would die silently if the process were stopped):
//
//   1. ONE RUN AT A TIME. The tick takes one connection from the pool and `GET_LOCK('jv_tick:<database>', 0)` on it (src/jobs/lock.ts withJobLock); if the lock is taken it answers
//      "already running" at once and does nothing. A lock belongs to the connection and a pooled connection lives on, so RELEASE_LOCK runs in a `finally`, and if ANYTHING throws the connection
//      is destroyed and never goes back to the pool: a lock left on a pooled connection would answer "already running" to every later tick until the connection died.
//   2. THE STATEMENT LIMIT is 20 seconds for the tick's session (SET SESSION after the checkout; the next checkout of this connection resets it). The handler timer of 50 seconds is the route's
//      (src/security/requestLimits.ts). When the timer fires or the client goes, the call's signal aborts and NO NEW PHASE is started; what is running finishes on its own statement limit.
//   3. THE PHASES (src/jobs/phases.ts) run in order. For each: is it due (a nightly phase not before 02:00 in Asia/Kolkata), claim its row of the business date (src/jobs/runs.ts: a retry is an
//      update, a `running` row older than 10 minutes is abandoned, `ok` ends the phase for the date), run it on THIS connection, and record how it ended with the `event` audit row (role job) in the
//      same transaction. A phase is independent of the others: one that throws is marked `failed` (and the next tick runs it again) and the others still run; the first failure is thrown at the end,
//      so the tick answers an error, the connection is destroyed and the lock is released, as above. A lost connection ends the tick: nothing more is started on it.
//
// The transactions of the tick (the claim, the end of a run with its event) go through withAutocommit and withTx over a pool of this one connection, so they use the statement wrapper and the
// error map like every other statement of the API without taking a second place in the pool.
import type { FastifyInstance } from 'fastify';
import type { Reading } from '../clock.js';
import { writeEvent } from '../db/events.js';
import type { DbConnection, DbPool } from '../db/pool.js';
import { type TxContext, txContext, withTx } from '../db/tx.js';
import { describeCause, unavailableError } from '../errors.js';
import { withJobLock } from './lock.js';
import { checkPhases } from './phases.js';
import { claimRun, finishRun } from './runs.js';
import { JOB_LIMITS, afterNightlyGate } from './schedule.js';
import type { Phase, PhaseContext, PhaseReport, PhaseResult, TickResult } from './types.js';

/** The actor of the tick's audit rows: no user, and the role says who (audit_log.actor_role, D16). */
const JOB_ACTOR = Object.freeze({ id: null, role: 'job' });

export interface TickLog {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
}

export interface TickOptions {
  phases: readonly Phase[];
  /** The id of the tick's request (a UUID): the `request_id` of the audit rows. */
  requestId: string;
  /** Aborts when the call is over (the handler timer fired or the client went): no new phase is started. */
  signal?: AbortSignal;
  log?: TickLog;
}

/** A pool of the one connection the tick holds: withTx and withAutocommit check it out and give it back as if it were a pool; release() leaves it with the tick, destroy() really destroys it. */
function onePool(conn: DbConnection, state: { lost: boolean }): Pick<DbPool, 'checkout'> {
  const view = new Proxy(conn, {
    get(target, prop) {
      if (prop === 'release') return () => undefined;
      if (prop === 'destroy') {
        return () => {
          state.lost = true;
          target.destroy();
        };
      }
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { checkout: async () => view };
}

/** What a failed run says about itself in `sys_job_runs.detail` and in its event: the class and the code of the root cause, and the database's own words with the shapes of personal data cut out. */
function rootOf(e: unknown): unknown {
  let cause = e;
  for (let i = 0; i < 5 && cause instanceof Error && cause.cause !== undefined; i++) cause = cause.cause;
  return cause;
}
function failureDetail(e: unknown): Record<string, unknown> {
  const c = describeCause(rootOf(e));
  return { error: { name: c.name, code: c.code, errno: c.errno, message: String(c.message ?? '').slice(0, 300) } };
}
function failureFacts(e: unknown): Record<string, unknown> {
  const c = describeCause(rootOf(e));
  return { error_name: c.name, error_code: c.code };
}

interface Outcome {
  phase: Phase;
  id: number;
  runDate: string;
  status: 'ok' | 'failed' | 'running';
  event: 'ok' | 'partial' | 'failed';
  detail: Record<string, unknown> | null;
  facts?: Record<string, unknown> | undefined;
  /** the run did nothing: no event row (PhaseResult.quiet) */
  quiet?: boolean;
}

/** Ends a run: the row of sys_job_runs and, for a phase of work, its `event` row, in ONE transaction. */
async function recordOutcome(app: FastifyInstance, ctx: TxContext, o: Outcome): Promise<void> {
  const at = app.clock.read().timestamp;
  await withTx(ctx, async (tx) => {
    await finishRun(tx, { id: o.id, status: o.status, at, detail: o.detail });
    if (o.phase.audited === false || o.quiet === true) return;
    await writeEvent(tx, { table: 'sys_job_runs', rowId: String(o.id), facts: { ...o.facts, event: 'job_phase', job: o.phase.job, run_date: o.runDate, outcome: o.event } });
  });
}

async function runPhases(app: FastifyInstance, conn: DbConnection, options: TickOptions, signal: AbortSignal): Promise<TickResult> {
  const state = { lost: false };
  const pool = onePool(conn, state);
  const newContext = () => txContext(pool, { requestId: options.requestId, actor: JOB_ACTOR, log: options.log, auditMode: app.config.auditMode });
  const reports: PhaseReport[] = [];
  let runDate: string | null = null;
  let firstFailure: { error: unknown } | null = null;
  const note = (job: string, outcome: PhaseReport['outcome'], date: string | null) => {
    reports.push({ job, outcome });
    options.log?.info({ job, outcome, run_date: date }, 'tick: phase');
  };

  for (const phase of options.phases) {
    if (signal.aborted || state.lost) {
      note(phase.job, 'skipped', runDate);
      continue;
    }
    const reading: Reading = app.clock.read();
    runDate ??= reading.date;
    if (phase.due === 'nightly' && !afterNightlyGate(reading)) {
      note(phase.job, 'not_due', reading.date);
      continue;
    }

    let claim;
    try {
      claim = await claimRun(newContext(), { job: phase.job, runDate: reading.date, reading, everyTick: phase.due === 'every_tick' });
    } catch (e) {
      firstFailure ??= { error: e }; // no row to mark: the database could not be asked
      note(phase.job, 'failed', reading.date);
      continue;
    }
    if (!claim.claimed) {
      note(phase.job, claim.reason, reading.date);
      continue;
    }

    const context: PhaseContext = { app, conn, txContext: newContext, runDate: reading.date, previous: claim.previous, signal, requestId: options.requestId };
    try {
      const result: PhaseResult = await phase.run(context);
      if (typeof result?.complete !== 'boolean') throw new TypeError(`the phase ${phase.job} did not say whether it is complete`);
      await recordOutcome(app, newContext(), {
        phase,
        id: claim.id,
        runDate: reading.date,
        status: result.complete ? 'ok' : 'running',
        event: result.complete ? 'ok' : 'partial',
        detail: result.detail ?? null,
        facts: result.facts,
        quiet: result.quiet === true,
      });
      note(phase.job, result.complete ? 'ran' : 'partial', reading.date);
    } catch (e) {
      firstFailure ??= { error: e };
      note(phase.job, 'failed', reading.date);
      try {
        await recordOutcome(app, newContext(), { phase, id: claim.id, runDate: reading.date, status: 'failed', event: 'failed', detail: failureDetail(e), facts: failureFacts(e) });
      } catch (second) {
        options.log?.warn({ job: phase.job, cause: describeCause(second) }, 'tick: a failed run could not be marked failed'); // the row stays `running` and is taken over after 10 minutes
      }
    }
  }

  if (firstFailure) throw firstFailure.error;
  return { status: 'ok', run_date: runDate, phases: reports };
}

/**
 * One tick. Answers { status: 'already_running' } when the lock is taken; else runs the phases that are due and answers what each did. Throws the first failure of a phase after all of them
 * were tried (the connection is destroyed, the lock released).
 */
export async function runTick(app: FastifyInstance, options: TickOptions): Promise<TickResult> {
  checkPhases(options.phases);
  const db = app.db;
  if (!db) throw unavailableError();
  const signal = options.signal ?? new AbortController().signal;
  const conn = await db.checkout();
  let discard = false;
  try {
    await conn.query('SET SESSION max_statement_time = ?', [JOB_LIMITS.statementSeconds]);
    const locked = await withJobLock(conn, 'tick', () => runPhases(app, conn, options, signal));
    if (!locked.ran) return { status: 'already_running', run_date: null, phases: [] };
    return locked.value;
  } catch (e) {
    discard = true; // anything that throws: this connection never goes back to the pool (the lock was released above or went with the connection)
    throw e;
  } finally {
    if (discard) conn.destroy();
    else conn.release();
  }
}
