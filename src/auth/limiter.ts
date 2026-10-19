// A13: the one in-memory limiter. Every throttle row of A13 that is not kept in the database is counted here: the admin door (API09), the change of password and every call that has no row of its own
// (API08), the photo upload and the photo read (API17), the job tick (API33). The login rows are the ones that live in the database (sys_login_attempts, D24) and so survive a restart; everything
// here starts from zero when the process starts, and nothing is written anywhere ("that is accepted", A13).
//
// A FIXED WINDOW for each key, the way @fastify/rate-limit counts (NODE-DESIGN 2.5): the window begins at the first call and ends `windowMs` later; `limit` calls fit in it, the next is refused
// with the seconds left, and the call after the window starts a new one. A refused call is not counted and does not move the end of the window, so a flood cannot keep a key blocked longer
// than the window it filled. Two more things are kept for a key, because the admin door needs them: a PAUSE (refuse everything from a key until a time) and a count of wrong answers IN A ROW.
//
// At most `maxKeys` keys are held (5,000, the size of the local store of @fastify/rate-limit that the design counted on): when a new key arrives and the map is full, the key that was used longest ago
// is dropped, so a flood of invented addresses cannot grow the memory, at the price that the dropped key counts from zero again (the same price as a restart).
//
// The clock is a function of the caller: the application's own clock (S5) through limiterOf(), so a test moves time by moving the clock it gave the application, and a clock that stands still
// for a moment does no harm. A new application is a new limiter: that is what "a restart" is in the tests.
import type { FastifyInstance } from 'fastify';
import { JvError } from '../errors.js';

export interface Rate {
  /** how many calls fit in the window */
  limit: number;
  windowMs: number;
}

export type Verdict = { ok: true } | { ok: false; retryAfterS: number };

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** The rows of A13 that are counted in memory. API09 uses the admin rows; API08, API17 and API33 read theirs from here, so that every figure of A13 stands in one place and T-D24 tests it. */
export const THROTTLES = Object.freeze({
  /** Admin door: 10 calls a minute for each address (API09). */
  adminCalls: Object.freeze({ limit: 10, windowMs: MINUTE }),
  /** Admin door: after this many wrong tokens in a row ... */
  adminWrongInARow: 2,
  /** ... the address is paused this long (API09). */
  adminPauseMs: 15 * MINUTE,
  /** Admin door, an address that cannot be trusted: no pause, but at most 5 wrong tokens an hour for the whole API (API09). */
  adminWrongUntrusted: Object.freeze({ limit: 5, windowMs: HOUR }),
  /** Job tick: 6 wrong tokens a minute for each address ... (API33; RV1-10: a right token is counted nowhere) */
  jobPerAddress: Object.freeze({ limit: 6, windowMs: MINUTE }),
  /** ... and 20 wrong tokens a minute in all, so that a wrong token does not get a fresh bucket each time (API33, RV1-10). */
  jobTotal: Object.freeze({ limit: 20, windowMs: MINUTE }),
  /** Change of password: 5 in 15 minutes for each user (API08). */
  changePassword: Object.freeze({ limit: 5, windowMs: 15 * MINUTE }),
  /** Photo upload: 30 a minute for each user (API17). */
  photoUpload: Object.freeze({ limit: 30, windowMs: MINUTE }),
  /** Photo read, the one call with no session: 600 a minute for each address (API17) ... */
  photoReadPerAddress: Object.freeze({ limit: 600, windowMs: MINUTE }),
  /** ... and, when the address cannot be trusted, 120 a second for the whole API (API17). */
  photoReadUntrusted: Object.freeze({ limit: 120, windowMs: 1000 }),
  /** Everything else: 300 a minute for each user (API08). */
  everything: Object.freeze({ limit: 300, windowMs: MINUTE }),
});

/** The refusal of every throttle: 429 JV_RATE_LIMITED, and the whole seconds to wait in Retry-After (at least 1). */
export function rateLimited(retryAfterS: number): JvError {
  return new JvError('JV_RATE_LIMITED', 'Too many requests. Try again later.', { retryAfter: Math.max(1, Math.ceil(retryAfterS)) });
}

interface Entry {
  /** calls counted in the window; for a pause, 1; for a run of wrong answers, how many */
  n: number;
  start: number;
  /** when the window, or the pause, is over */
  end: number;
}

const DEFAULT_MAX_KEYS = 5000;

export class Limiter {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly now: () => number,
    private readonly maxKeys: number = DEFAULT_MAX_KEYS,
  ) {
    if (!Number.isInteger(maxKeys) || maxKeys < 1) throw new TypeError('maxKeys is a whole number of at least 1');
  }

  /** How many keys are held. */
  get size(): number {
    return this.entries.size;
  }

  /** Counts one call under `key`. Over the limit it is refused until the window ends, and is not counted. */
  take(key: string, rate: Rate): Verdict {
    if (!Number.isInteger(rate.limit) || rate.limit < 1) throw new TypeError('a rate allows a whole number of calls, at least 1');
    if (!Number.isFinite(rate.windowMs) || rate.windowMs < 1) throw new TypeError('a window lasts at least a millisecond');
    const t = this.now();
    let e = this.entries.get(`w:${key}`);
    if (!e || t >= e.end || t < e.start) e = { n: 0, start: t, end: t + rate.windowMs };
    if (e.n >= rate.limit) {
      this.touch(`w:${key}`, e);
      return { ok: false, retryAfterS: Math.max(1, Math.ceil((e.end - t) / 1000)) };
    }
    e.n++;
    this.touch(`w:${key}`, e);
    return { ok: true };
  }

  /** take(), and the refusal thrown as JV_RATE_LIMITED (429 with Retry-After). */
  require(key: string, rate: Rate): void {
    const verdict = this.take(key, rate);
    if (!verdict.ok) throw rateLimited(verdict.retryAfterS);
  }

  /** Refuses everything from `key` for `ms`: pausedFor() says how long is left. */
  pause(key: string, ms: number): void {
    const t = this.now();
    this.touch(`p:${key}`, { n: 1, start: t, end: t + ms });
  }

  /** Milliseconds of the pause left, 0 when `key` is not paused. */
  pausedFor(key: string): number {
    const e = this.entries.get(`p:${key}`);
    if (!e) return 0;
    const left = e.end - this.now();
    if (left <= 0) {
      this.entries.delete(`p:${key}`);
      return 0;
    }
    return left;
  }

  /** One more wrong answer in a row for `key`; returns how many there are. */
  strike(key: string): number {
    const e = this.entries.get(`s:${key}`) ?? { n: 0, start: this.now(), end: Number.POSITIVE_INFINITY };
    e.n++;
    this.touch(`s:${key}`, e);
    return e.n;
  }

  /** A right answer: the run of wrong ones is over. */
  clearStrikes(key: string): void {
    this.entries.delete(`s:${key}`);
  }

  /** Puts the entry last in the map (so the first one is the one used longest ago) and keeps the map within its size. */
  private touch(key: string, entry: Entry): void {
    this.entries.delete(key);
    while (this.entries.size >= this.maxKeys) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
    this.entries.set(key, entry);
  }
}

const limiters = new WeakMap<FastifyInstance, Limiter>();

/** The application's one limiter, on the application's clock. A new application (a restart, in a test) has a new one. */
export function limiterOf(app: FastifyInstance): Limiter {
  let limiter = limiters.get(app);
  if (!limiter) {
    limiter = new Limiter(() => Number(app.clock.read().micros / 1000n));
    limiters.set(app, limiter);
  }
  return limiter;
}

// ------------------------------------------------------------------ the visitor's address

// No `node:net` here: src/ makes no socket and imports no socket module outside the pool (T-D11), and an address is only text to be judged.
const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;
const isIPv4 = (text: string): boolean => IPV4.test(text);
/** An IPv6 literal, judged by the URL parser (as strict as a browser: one `::` at most, groups of up to 4 hex digits, an IPv4 tail allowed). Only address characters get to the parser. */
function isIPv6(text: string): boolean {
  if (!/^[0-9a-fA-F:.]+$/.test(text) || !text.includes(':')) return false;
  try {
    return new URL(`http://[${text}]/`).hostname.startsWith('[');
  } catch {
    return false;
  }
}

/** The address a throttle counts, and whether it can be trusted. An address that cannot is one shared key, `unknown`, and the rows of A13 say what replaces the per-address rule then. */
export interface Visitor {
  key: string;
  trusted: boolean;
}

const UNTRUSTED: Visitor = Object.freeze({ key: 'unknown', trusted: false });

/**
 * An address as it is counted: IPv4 as it is, an IPv4-mapped IPv6 address as the IPv4, any other IPv6 address shortened to its first 64 bits (`2001:db8:1:2::`), so that a whole /64 network counts
 * as one address (A13). The twin of addressKey in scripts/login-counters.mjs (tests/api/limiter.test.ts keeps the two equal). Call it with a valid address.
 */
export function addressKey(address: string): string {
  let a = address.trim().toLowerCase();
  const zone = a.indexOf('%');
  if (zone >= 0) a = a.slice(0, zone);
  if (isIPv4(a)) return a;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a);
  if (mapped && isIPv4(mapped[1])) return mapped[1];
  if (!isIPv6(a)) return a;
  const [head, tail] = a.split('::');
  const groups = (part: string | undefined) => (part ? part.split(':') : []);
  const expand = (list: string[]) =>
    list.flatMap((g) => {
      if (!g.includes('.')) return [g];
      const o = g.split('.').map(Number); // an embedded IPv4 tail takes two groups
      return [((o[0] << 8) | o[1]).toString(16), ((o[2] << 8) | o[3]).toString(16)];
    });
  const h = expand(groups(head));
  const t = a.includes('::') ? expand(groups(tail)) : [];
  const full = a.includes('::') ? [...h, ...Array<string>(8 - h.length - t.length).fill('0'), ...t] : h;
  return `${full.slice(0, 4).map((g) => Number.parseInt(g, 16).toString(16)).join(':')}::`;
}

/**
 * The visitor of a request, from the header `x-real-ip` and from nothing else: Hostinger's front end sets it to the visitor's address and overwrites a value the client sends, while
 * `x-forwarded-for` keeps a client's own, so it is never read (A13, 7.5). A header that is missing, repeated, or not exactly one address (a list, a port, text) cannot be trusted.
 */
export function visitorAddress(headers: Record<string, unknown>): Visitor {
  const raw = headers['x-real-ip'];
  if (typeof raw !== 'string') return UNTRUSTED;
  const text = raw.trim();
  const zone = text.indexOf('%');
  const bare = zone >= 0 ? text.slice(0, zone) : text;
  if (!isIPv4(bare) && !isIPv6(bare)) return UNTRUSTED;
  return { key: addressKey(text), trusted: true };
}
