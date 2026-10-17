// A14: how large a request may be and how long a call may take. The numbers are the spec's and Hostinger's: its front end cuts a request at about 60 seconds whatever the app does [P], so the app
// must have answered before that, and the handler timer must be LONGER than the work it guards: the transaction deadline of 12 seconds (S12) plus the statement limit of 8 (S11) is 20 seconds,
// so by the time the 25-second timer fires the work has already stopped and the answer is only the news of it (a call whose work never stops is cut by the timer and its signal is aborted).
import { limits } from '../limits.js';
import { MATRIX, PUBLIC_ROUTES, TOKEN_DOORS } from '../permissions/matrix.js';

export const requestLimits = Object.freeze({
  /** A request body is at most 1 MiB ... */
  bodyBytes: 1024 * 1024,
  /** ... a photo upload 2 MiB and 16 KiB: the file (P1) and a little room for the envelope. */
  photoBodyBytes: limits.maxPhotoBytes + 16 * 1024,
  /** Receiving a request may take 30 seconds (Fastify's requestTimeout). */
  requestMs: 30_000,
  /** An ordinary call may take 25 seconds to be answered ... */
  handlerMs: 25_000,
  /** ... the login 30 (it hashes a password, U1) ... */
  loginMs: 30_000,
  /** ... the job tick 50 (its phases are cut to about 25 seconds each, I8). */
  tickMs: 50_000,
});

/** The timers of one application. server.ts never passes any; a test passes shorter ones so that it need not wait 25 seconds. */
export interface RequestTimers {
  requestMs: number;
  handlerMs: number;
  loginMs: number;
  tickMs: number;
}

export const defaultTimers = (): RequestTimers => ({ requestMs: requestLimits.requestMs, handlerMs: requestLimits.handlerMs, loginMs: requestLimits.loginMs, tickMs: requestLimits.tickMs });

/** The address of the job tick: the job door's prefix and `tick`. */
export const TICK_PATH = `${TOKEN_DOORS.job.prefix}tick`;

/** The handler timer of a route, by its method and its address as registered: 30 s for the login, 50 s for the job tick, 25 s for everything else. */
export function handlerTimeoutFor(timers: RequestTimers, method: string, url: string): number {
  if (method === PUBLIC_ROUTES.login.method && url === PUBLIC_ROUTES.login.path) return timers.loginMs;
  if (url === TICK_PATH) return timers.tickMs;
  return timers.handlerMs;
}

/** The body limit of a route when it is not the 1 MiB of the application: only the photo upload (a row of the matrix) has its own. */
export function bodyLimitFor(method: string, url: string): number | undefined {
  const photo = MATRIX['photo:upload'];
  return method === photo.method && url === photo.path ? requestLimits.photoBodyBytes : undefined;
}
