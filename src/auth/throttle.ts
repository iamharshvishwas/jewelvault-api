// A13, D24, U1, S11 (API08): the throttles. Two parts.
//
// 1. THE LOGIN. There is no account lock and no cap that one stranger can fill alone. An attempt, right or wrong, is counted ONCE, when the request arrives, in the database (loginCounters.ts, the twin of
//    the database half's counter library), so the count survives a restart; then
//      (1) per e-mail (a 15-minute window): after 5 attempts each further attempt waits 1, 2, 4 and then at most 8 seconds before the password is checked. No limit on how many attempts wait for one e-mail;
//      (2) per address across all e-mails: 20 a minute from `x-real-ip` (an IPv6 address by its first 64 bits); if the address is missing or cannot be trusted, 60 a minute for all such attempts (scope any);
//      (3) in flight: only the password check is busy, at most 2 at a time; the attempts that wait for their delay or for a free place are limited together, for the whole API, to 30, and the 31st is
//          refused at once, 429 JV_RATE_LIMITED. An unknown e-mail is counted and checked exactly like a known one.
//    A login takes a short checkout of the pool for its counter statements and gives it back before it waits or hashes, so waiting logins never stop a bill (S11). The wait listens to the call's
//    signal (callSignal): when the client has gone or the handler timer has answered, the wait ends, the place is given back and the password is not checked.
//    The first failed attempt after the hour has changed claims the summary of the hour (recordFailure): at most 24 `login_failures` events a day and none for an attempt.
//
//    LoginThrottle holds the rules and the in-memory counts of what waits and what runs; it knows nothing of Fastify or MariaDB: the counters and the sleep come in (LoginThrottleDeps), so the
//    production counters (dbLoginCounters) and the virtual time of tests/api/login-throttle-model.test.ts are two sets of the same two things.
//
// 2. THE REST OF THE LIMITER (limiter.ts, API09): change-password, 5 per 15 minutes per user, and every other call of a session 300 a minute per user (throttleSessionCall, called by the route wrapper
//    after the session is found). The rows that belong to a route of their own are applied where that route is built (the admin door, the tick, the photo read); the photo upload row is applied here
//    already, because the matrix names the route, so that it is not also counted in the 300.
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as timer } from 'node:timers/promises';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { systemClock } from '../clock.js';
import type { Config } from '../config.js';
import { withAutocommit } from '../db/autocommit.js';
import { txContext } from '../db/tx.js';
import { BusyError, unavailableError } from '../errors.js';
import { type Rate, THROTTLES, limiterOf, rateLimited, visitorAddress } from './limiter.js';
import { type Scope, WINDOW_SECONDS, countAttempt, loginSlot, recordFailure } from './loginCounters.js';
import { MAX_CONCURRENT_HASHES } from './password.js';

/** The figures of A13 (1) to (3). */
export const LOGIN_THROTTLE = Object.freeze({
  /** attempts for one e-mail in its window that wait nothing */
  freeAttempts: 5,
  /** the waits of the 6th, 7th, 8th and every later attempt */
  delaysMs: Object.freeze([1000, 2000, 4000, 8000]),
  /** per address, in its window of a minute */
  addressPerMinute: 20,
  /** for all attempts without a usable address, in a minute */
  anyPerMinute: 60,
  /** attempts that wait for a delay or a free place, all e-mails together */
  maxWaiting: 30,
  /** password checks at a time (U1) */
  maxChecking: MAX_CONCURRENT_HASHES,
  /** counter statements at a time: a flood must not take the pool from a bill (S11) */
  counterCheckouts: 2,
  /** Retry-After of the refusal for a full queue: the longest wait plus the queue ahead is a few seconds */
  retryAfterWaitingS: 8,
});

/** How long attempt number `attempts` for one e-mail waits (A13 (1)). */
export function loginDelayMs(attempts: number): number {
  const { freeAttempts, delaysMs } = LOGIN_THROTTLE;
  if (attempts <= freeAttempts) return 0;
  return delaysMs[Math.min(attempts - freeAttempts, delaysMs.length) - 1];
}

/**
 * The signal of one call: aborted when its response is over before the handler has returned, that is, the client has gone (the socket closed) or the handler timer has answered 503. It is NOT
 * request.signal: Fastify aborts that one when Node says the REQUEST has been completed, which is as soon as it has been read (measured on Node 22 with Fastify 5.12.7, for a POST that stays and for a
 * client that goes alike), so it can neither tell a client that has gone nor, once aborted, carry the timer.
 */
export function callSignal(reply: FastifyReply): AbortSignal {
  const ac = new AbortController();
  if (reply.raw.destroyed) ac.abort(); // the client went before the handler began
  else reply.raw.once('close', () => ac.abort());
  return ac.signal;
}

/** The client has gone or the handler timer has fired: the call is over. The answer, if any, is the timer's JV_BUSY. */
const callIsOver = () => new BusyError('handler_timeout');

// ------------------------------------------------------------------ at most N at a time

/** A first-come-first-served set of places: `acquire` waits for one, a signal that aborts takes the waiter out of the queue. */
class Gate {
  inFlight = 0;
  peak = 0;
  private readonly queue: { start: () => void }[] = [];
  constructor(readonly max: number) {}

  acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(callIsOver());
    if (this.inFlight < this.max) return Promise.resolve(this.grant());
    return new Promise<() => void>((resolve, reject) => {
      const waiter = {
        start: () => {
          signal?.removeEventListener('abort', onAbort);
          resolve(this.grant());
        },
      };
      const onAbort = () => {
        const i = this.queue.indexOf(waiter);
        if (i >= 0) this.queue.splice(i, 1);
        reject(callIsOver());
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.queue.push(waiter);
    });
  }

  private grant(): () => void {
    this.inFlight += 1;
    this.peak = Math.max(this.peak, this.inFlight);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.inFlight -= 1;
      this.queue.shift()?.start();
    };
  }
}

// ------------------------------------------------------------------ the login

/** One counter statement on a short checkout. */
export interface CounterSession {
  /** Counts one attempt under (scope, slot) and says how many there are in its window, this one included. */
  count(scope: Scope, slot: number): Promise<number>;
}

/** What the throttle needs of the database: the counters, and the failure summary. */
export interface LoginCounters {
  /** Runs `fn` on one short checkout that is given back when it is over. */
  within<T>(fn: (session: CounterSession) => Promise<T>): Promise<T>;
  /** A failed attempt (D24): adds one to the hour, closing the hour before if it ended. */
  failure(): Promise<void>;
}

export interface LoginThrottleDeps {
  /** The secret salt of the counter slots (U10). */
  salt: string;
  counters: LoginCounters;
  /** Waits `ms`; rejects when the signal aborts. */
  sleep(ms: number, signal: AbortSignal): Promise<void>;
}

export interface BeginInput {
  email: string;
  /** the request's headers: only `x-real-ip` is read */
  headers: Record<string, unknown>;
  /** aborted when the client has gone or the handler timer has fired */
  signal: AbortSignal;
  log?: { warn(obj: object, msg: string): void } | undefined;
}

/** One login attempt that has been counted and admitted. Call end() on every path. */
export interface LoginAttempt {
  /** how many attempts for this e-mail there are in its window, this one included */
  readonly emailAttempts: number;
  /** how long this attempt waits before its password is checked */
  readonly delayMs: number;
  /** Waits the delay (nothing if there is none). Rejects when the client has gone. */
  delay(): Promise<void>;
  /** Takes one of the places for a password check and runs `fn`. Rejects, without running `fn`, when the client has gone. */
  check<T>(fn: () => Promise<T>): Promise<T>;
  /** The password was wrong (or the e-mail unknown): D24's failure summary. A failure of the bookkeeping is logged and does not change the answer. */
  failed(): Promise<void>;
  /** Gives back what the attempt still holds. Safe to call twice. */
  end(): void;
}

export class LoginThrottle {
  private waiting = 0;
  private peakWaiting = 0;
  private readonly checks = new Gate(LOGIN_THROTTLE.maxChecking);

  constructor(private readonly deps: LoginThrottleDeps) {}

  /** What is waiting and what is checking now, and the most of each there has been. */
  stats(): { waiting: number; checking: number; peakWaiting: number; peakChecking: number } {
    return { waiting: this.waiting, checking: this.checks.inFlight, peakWaiting: this.peakWaiting, peakChecking: this.checks.peak };
  }

  /**
   * An attempt arrives. It takes a place among the 30 that may wait (the 31st is refused at once), is counted for its address and, if that is within the cap, for its e-mail, and is told how long it
   * waits. An attempt refused for its address is not counted for its e-mail: it never gets to a password.
   */
  async begin(input: BeginInput): Promise<LoginAttempt> {
    if (input.signal.aborted) throw callIsOver();
    if (this.waiting >= LOGIN_THROTTLE.maxWaiting) throw rateLimited(LOGIN_THROTTLE.retryAfterWaitingS);
    this.waiting += 1;
    this.peakWaiting = Math.max(this.peakWaiting, this.waiting);
    const { salt } = this.deps;
    try {
      const visitor = visitorAddress(input.headers);
      const scope: Scope = visitor.trusted ? 'addr' : 'any';
      const limit = visitor.trusted ? LOGIN_THROTTLE.addressPerMinute : LOGIN_THROTTLE.anyPerMinute;
      const counted = await this.deps.counters.within(async (session) => {
        const fromAddress = await session.count(scope, visitor.trusted ? loginSlot(salt, 'addr', visitor.key) : 0);
        if (fromAddress > limit) return { refused: true as const };
        return { refused: false as const, emailAttempts: await session.count('email', loginSlot(salt, 'email', input.email)) };
      });
      if (counted.refused) throw rateLimited(WINDOW_SECONDS[scope]);
      return new Attempt(this, this.deps, input, counted.emailAttempts);
    } catch (e) {
      this.waiting -= 1;
      throw e;
    }
  }

  /** @internal used by Attempt: the attempt no longer waits (it has a place for its check, or it is over) */
  leaveWaiting(): void {
    this.waiting -= 1;
  }

  /** @internal used by Attempt: one of the places for a password check, in order of arrival */
  acquireCheck(signal: AbortSignal): Promise<() => void> {
    return this.checks.acquire(signal);
  }
}

class Attempt implements LoginAttempt {
  readonly delayMs: number;
  private holdsPlace = true;

  constructor(
    private readonly throttle: LoginThrottle,
    private readonly deps: LoginThrottleDeps,
    private readonly input: BeginInput,
    readonly emailAttempts: number,
  ) {
    this.delayMs = loginDelayMs(emailAttempts);
  }

  async delay(): Promise<void> {
    if (this.delayMs <= 0) return;
    try {
      await this.deps.sleep(this.delayMs, this.input.signal);
    } catch (e) {
      if (this.input.signal.aborted) throw callIsOver();
      throw e;
    }
    if (this.input.signal.aborted) throw callIsOver();
  }

  async check<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.throttle.acquireCheck(this.input.signal);
    try {
      this.end(); // it has a place for the check now: it no longer counts among those that wait
      return await fn();
    } finally {
      release();
    }
  }

  async failed(): Promise<void> {
    try {
      await this.deps.counters.failure();
    } catch (e) {
      // the answer to a stranger does not change because the books could not be written; the warning is for the owner's log
      this.input.log?.warn({ cause: e instanceof Error ? e.message : String(e) }, 'the failed login could not be counted for the hourly summary');
    }
  }

  end(): void {
    if (!this.holdsPlace) return;
    this.holdsPlace = false;
    this.throttle.leaveWaiting();
  }
}

// ------------------------------------------------------------------ the production parts

/**
 * The salt of the counter slots (U10): JV_LOGIN_SALT when it is set. When it is not, a salt made from the database password, which is a secret of the same kind (it exists only in the environment) and
 * does not change between restarts; changing it only moves the counters to other slots, which sets them to zero.
 */
export function loginSaltOf(config: Pick<Config, 'loginSalt' | 'db'>): string {
  return config.loginSalt ?? createHash('sha256').update(`jv-login-slot-salt|${config.db.password}`).digest('hex');
}

/** The counters of the running API: the database, a short checkout for each section, at most 2 of them at a time. */
export function dbLoginCounters(app: FastifyInstance): LoginCounters {
  const places = new Gate(LOGIN_THROTTLE.counterCheckouts);
  const ctx = () => {
    if (!app.db) throw unavailableError();
    return txContext(app.db, { requestId: randomUUID(), actor: { id: null, role: 'job' } });
  };
  // the database's own clock, as D24 writes it, unless the application was given a clock of its own (a test): then the counters count on that one
  const now = (): Date | undefined => (app.clock === systemClock ? undefined : new Date(Number(app.clock.read().micros / 1000n)));
  const place = async <T>(fn: () => Promise<T>): Promise<T> => {
    const release = await places.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  };
  return {
    within: (fn) => place(() => withAutocommit(ctx(), (db) => fn({ count: (scope, slot) => countAttempt(db, scope, slot, { now: now() }) }))),
    failure: () =>
      place(async () => {
        await recordFailure(ctx(), { now: now() });
      }),
  };
}

const throttles = new WeakMap<FastifyInstance, LoginThrottle>();

/**
 * Puts the login throttle of an application in place, over the production parts and with `overrides` for what a test wants to hold in its own hand (the sleep, the counters). The application
 * makes its own on the first login; a test that wants a seam calls this right after buildApp(). Returns the throttle.
 */
export function installLoginThrottle(app: FastifyInstance, overrides: Partial<LoginThrottleDeps> = {}): LoginThrottle {
  const throttle = new LoginThrottle({
    salt: loginSaltOf(app.config),
    counters: dbLoginCounters(app),
    sleep: async (ms, signal) => {
      await timer(ms, undefined, { signal });
    },
    ...overrides,
  });
  throttles.set(app, throttle);
  return throttle;
}

export function loginThrottleOf(app: FastifyInstance): LoginThrottle {
  return throttles.get(app) ?? installLoginThrottle(app);
}

// ------------------------------------------------------------------ change-password and everything else

/** The rows of the limiter that a session call can have. A call that has no row of its own is "everything else": 300 a minute for each user (A13). */
const OWN_ROW: Readonly<Record<string, 'changePassword' | 'photoUpload'>> = Object.freeze({
  'session:change-password': 'changePassword',
  'photo:upload': 'photoUpload',
});

type UserRow = 'changePassword' | 'photoUpload' | 'everything';

const userRates = new WeakMap<FastifyInstance, Partial<Record<UserRow, Rate>>>();

/** A seam for tests: other rates for an application, for a test that has to make more calls with one user (and a clock that stands still) than A13 allows in a minute. server.ts never calls it. */
export function installUserRates(app: FastifyInstance, rates: Partial<Record<UserRow, Rate>>): void {
  userRates.set(app, rates);
}

/**
 * A13: one call of a signed-in user is counted, under its own row if it has one (change-password 5 per 15 minutes, photo upload 30 a minute), else in the 300 a minute. Over the limit it throws
 * 429 JV_RATE_LIMITED with Retry-After. The route wrapper calls it once the session is found, before anything else is judged, because the user is the key.
 */
export function throttleSessionCall(app: FastifyInstance, action: string, userId: string): void {
  const row: UserRow = OWN_ROW[action] ?? 'everything';
  limiterOf(app).require(`${row}:${userId}`, userRates.get(app)?.[row] ?? THROTTLES[row]);
}
