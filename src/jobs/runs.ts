// I8, D25: the rows of `sys_job_runs`, one for each phase and business date (unique on `job` and `run_date`, so a retry is an UPDATE and never a new row).
//
//   claimRun    takes the row for a run: no row yet = INSERT as `running`; `failed` goes back to `running`; a `running` row older than 10 minutes is abandoned and is taken over; a `running` row
//               whose slice has ended (it has an end time: the phase stopped early and said where in `detail`) is continued at once, by the next tick; `ok` ends the phase for the date ("already
//               done") except for a phase that is due at every tick; any other `running` row (no end time, younger than 10 minutes) is somebody else's. A takeover is a conditional UPDATE on the
//               status AND the start time it read, so two callers cannot both win. `detail` is kept: a phase that works in slices finds where the last slice stopped.
//   finishRun   ends a run inside the transaction that also writes its `event` row: `ok` or `failed` with the end time, or (a slice that stopped early) the new `detail` and the end time of the
//               slice, the row staying `running` (never `ok` for a partial slice, D17).
//
// All times are the API's clock (S5), written as DATETIME(6) text in UTC; the age of a row is compared with a time worked out in BigInt microseconds here, not with the database's own clock, so a
// test moves time by moving the clock it gave the application.
import { type Reading, formatTimestamp } from '../clock.js';
import { withAutocommit } from '../db/autocommit.js';
import type { Tx, TxContext } from '../db/tx.js';
import { JOB_LIMITS } from './schedule.js';

export interface Previous {
  status: string;
  detail: unknown;
}

export type ClaimResult = { claimed: true; id: number; previous: Previous | null } | { claimed: false; reason: 'already_done' | 'running_elsewhere' };

export interface ClaimInput {
  job: string;
  runDate: string;
  reading: Reading;
  /** a phase due at every tick: a row that is `ok` for the date is taken again */
  everyTick: boolean;
}

interface RunRow {
  id: number | string;
  status: string;
  stale: number | string;
  paused: number | string;
  started_text: string;
  detail: unknown;
}

const READ = "SELECT id, status, started_at < CAST(? AS DATETIME(6)) AS stale, finished_at IS NOT NULL AS paused, DATE_FORMAT(started_at, '%Y-%m-%d %H:%i:%s.%f') AS started_text, detail FROM sys_job_runs WHERE job = ? AND run_date = ?";
const INSERT = "INSERT INTO sys_job_runs (job, run_date, status, started_at) VALUES (?, ?, 'running', ?)";
const TAKE = "UPDATE sys_job_runs SET status = 'running', started_at = ?, finished_at = NULL WHERE id = ? AND status = ? AND started_at = CAST(? AS DATETIME(6))";

const parseDetail = (detail: unknown): unknown => (typeof detail === 'string' ? (JSON.parse(detail) as unknown) : detail);

export async function claimRun(ctx: TxContext, input: ClaimInput): Promise<ClaimResult> {
  const abandonedBefore = formatTimestamp(input.reading.micros - BigInt(JOB_LIMITS.abandonedAfterMs) * 1000n);
  return withAutocommit(ctx, async (db): Promise<ClaimResult> => {
    const [row] = await db.rows<RunRow>(READ, [abandonedBefore, input.job, input.runDate]);
    if (!row) {
      try {
        const made = await db.run(INSERT, [input.job, input.runDate, input.reading.timestamp]);
        return { claimed: true, id: Number(made.insertId), previous: null };
      } catch (e) {
        if ((e as { errno?: number } | null)?.errno === 1062) return { claimed: false, reason: 'running_elsewhere' }; // somebody inserted the row a moment ago
        throw e;
      }
    }
    const abandoned = row.status === 'running' && Number(row.stale) === 1;
    const paused = row.status === 'running' && Number(row.paused) === 1; // a slice that stopped early: nobody is working on it
    const again = row.status === 'failed' || abandoned || paused || (row.status === 'ok' && input.everyTick);
    if (row.status === 'ok' && !input.everyTick) return { claimed: false, reason: 'already_done' };
    if (!again) return { claimed: false, reason: 'running_elsewhere' };
    const taken = await db.run(TAKE, [input.reading.timestamp, Number(row.id), row.status, row.started_text]);
    if (taken.affectedRows !== 1) return { claimed: false, reason: 'running_elsewhere' };
    return { claimed: true, id: Number(row.id), previous: { status: row.status, detail: parseDetail(row.detail) } };
  });
}

export interface FinishInput {
  id: number;
  /** `running`: a slice that stopped early (the row stays `running`, with the new `detail` and the end time of the slice) */
  status: 'ok' | 'failed' | 'running';
  /** DATETIME(6) text: the end time of the run, or of the slice */
  at: string;
  detail: Record<string, unknown> | null;
}

export async function finishRun(tx: Tx, input: FinishInput): Promise<void> {
  const detail = input.detail === null ? null : JSON.stringify(input.detail);
  if (input.status === 'running') {
    await tx.run('UPDATE sys_job_runs SET finished_at = ?, detail = ? WHERE id = ?', [input.at, detail, input.id]);
    return;
  }
  await tx.run('UPDATE sys_job_runs SET status = ?, finished_at = ?, detail = ? WHERE id = ?', [input.status, input.at, detail, input.id]);
}
