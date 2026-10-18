// I8: the routes of the job door (/internal/jobs/*, TOKEN_DOORS.job). API33 builds the hourly tick; API33b adds `GET /internal/jobs/health` here, behind the same `jobDoor` check.
//
//   POST /internal/jobs/tick    the hourly tick (src/jobs/tick.ts): `curl -fsS -X POST -H "Authorization: Bearer <token>" https://<api name>/internal/jobs/tick`, from an hPanel cron job (Custom type)
//                               and from a scheduled GitHub Actions workflow. Answers 200 { status: 'ok' | 'already_running', run_date, phases: [{ job, outcome }] }; a phase that failed is an
//                               error answer (so `curl -f` and the workflow fail visibly) after every phase was tried.
//
// The routes exist only while JV_JOB_TOKEN_HASH is set (like the admin door's): without it these addresses are 404s and nothing can start a job. The handler timer of the tick (50 s) is the route's
// by its address (src/security/requestLimits.ts TICK_PATH), the statement limit (20 s) is set on the tick's connection (src/jobs/tick.ts).
import type { FastifyInstance } from 'fastify';
import { callSignal } from '../auth/throttle.js';
import { route } from '../permissions/route.js';
import { TICK_PATH } from '../security/requestLimits.js';
import { jobDoor } from './door.js';
import { checkPhases, defaultPhases } from './phases.js';
import { runTick } from './tick.js';
import type { Phase } from './types.js';

export interface JobRoutesOptions {
  /** The phases of the tick. Default: the application's own (defaultPhases). A test seam; server.ts passes none. */
  phases?: readonly Phase[];
}

export function registerJobRoutes(app: FastifyInstance, options: JobRoutesOptions = {}): void {
  const tokenHash = app.config.jobTokenHash;
  if (!tokenHash) return; // no hash, no door
  const verify = jobDoor(app, tokenHash);
  const phases = options.phases ?? defaultPhases();
  checkPhases(phases);

  route(app, {
    token: 'job',
    method: 'POST',
    url: TICK_PATH,
    verify,
    handler: async ({ app: a, request, reply }) => runTick(a, { phases, requestId: request.id, signal: callSignal(reply), log: request.log }),
  });
}
