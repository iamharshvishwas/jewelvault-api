// I8, B3, O44: `GET /internal/jobs/health`, the read-only call the GitHub Actions workflow makes with the job token (src/jobs/routes.ts): the OUTSIDE alarm for a missed run. The owner's dashboard line
// turns red after 26 hours, but only when she opens it, which is not an alarm; this answers `503` when
//
//   - the last GOOD export (backup_runs, kind db_dump, ok) is older than 26 hours, or there never was one (dump_stale, dump_never), or
//   - the owner's last Download everything is more than 35 days old (download_red: whole Asia/Kolkata days, B3, counted from settings.last_download or, with none, from the first night the system
//     ran), and the workflow then fails: GitHub e-mails the owner of the repository about a failed run at no cost.
//
// Those two figures are the ones readHealth (src/reads/health.ts, the line of I12) works out, and the thresholds are its: this route repeats them and decides nothing of its own. Only these two
// reasons decide: the owner's other red lights (a stale check, no photo copy, a fallen file count, a full database) are for the dashboard, and a stale NIGHTLY CHECK or a stuck photo copy would show
// there; spec I8 names the export and the download. "Never ran" is red here as it is on the line: a new shop is not backed up until the first dump has run, and the outside check should say so.
//
// READ ONLY: no statement that writes, no ANALYZE TABLE (readHealth is asked not to), no event row. The answer holds the reasons and two figures, no name of a customer, a user or a path.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { classifyError, isConnectionLost, unavailableError } from '../errors.js';
import { readHealth } from '../reads/health.js';
import { timestampToWire } from '../wire/format.js';

/** The reasons of readHealth that make the outside check fail, in the order readHealth lists them. */
export const JOB_HEALTH_REASONS: readonly string[] = ['dump_never', 'dump_stale', 'download_red'];

export interface JobHealthAnswer {
  status: 200 | 503;
  body: {
    ok: boolean;
    failing: string[];
    dump: { last_at: string | null; age_hours: number | null };
    download: { state: string; age_days: number | null; from: string | null };
  };
}

export async function jobHealth(app: FastifyInstance, _request: FastifyRequest): Promise<JobHealthAnswer> {
  const db = app.db;
  if (!db) throw unavailableError();
  const conn = await db.checkout();
  let broken = false;
  try {
    // "now" is the API's clock (S5), as it is for the owner's line
    const health = await readHealth(conn, { now: app.clock.read().timestamp, analyze: false });
    const failing = health.reasons.filter((r) => JOB_HEALTH_REASONS.includes(r));
    return {
      status: failing.length === 0 ? 200 : 503,
      body: {
        ok: failing.length === 0,
        failing,
        dump: { last_at: health.db_dump.last_at === null ? null : timestampToWire(health.db_dump.last_at), age_hours: health.db_dump.age_hours },
        download: { state: health.download.state, age_days: health.download.age_days, from: health.download.from },
      },
    };
  } catch (e) {
    broken = isConnectionLost(e);
    throw classifyError(e);
  } finally {
    if (broken) conn.destroy();
    else conn.release();
  }
}
