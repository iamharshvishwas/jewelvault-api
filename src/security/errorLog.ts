// D25, A14: the unexpected errors are kept in sys_error_log beyond Hostinger's log window, with no customer data, AT MOST 20 ROWS A MINUTE FOR EACH CODE (src/db/errorLog.ts, the twin of MB05's logError).
//
// Writing a row must never slow down or break an answer, and a flood of one error must not turn into a flood of database work at the moment the database is struggling:
//   - the error handler hands the entry over (record) and goes on; nothing here throws;
//   - the entries are written one after the other on ONE connection, taken from the pool for the time of the pass and given back (never two at once, so the log cannot hold more than a place of the 8);
//   - of one code in one minute only the first 20 are kept as entries; the rest are only counted, and written at the end of the pass by the same function, one call each, which adds them to the
//     last row's detail.suppressed (so the stored count is exact, and memory stays small however long the flood lasts);
//   - if no connection can be had (the pool is full, the database is down) the pass is dropped and said once in the log, and for the next 5 seconds nothing more is tried (what arrives meanwhile is
//     counted and dropped): an error log that waits or keeps knocking would add to the load it reports.
import { basename, relative } from 'node:path';
import type { FastifyRequest } from 'fastify';
import { ERROR_LOG_PER_MINUTE, type ErrorEntry, errorLogMinute, logError } from '../db/errorLog.js';
import type { DbPool } from '../db/pool.js';
import { BusyError, type BusyReason, type JvError, describeCause, scrubShapes } from '../errors.js';
import type { PreflightResult } from '../preflight.js';

interface Item {
  entry: ErrorEntry;
  at: Date;
}

export interface ErrorLog {
  /** Hands over one entry, dated `at`. Returns at once. */
  record(entry: ErrorEntry, at: Date): void;
  /** Resolves when everything handed over so far has been written or dropped. Shutdown waits for it; so do the tests. */
  idle(): Promise<void>;
}

interface Warner {
  warn(obj: object, msg: string): void;
}

const SEEN_KEEP_MS = 5 * 60_000;
/** After a pass found no connection, no other is tried for this long. */
const COOL_DOWN_MS = 5000;

export interface ErrorLogOptions {
  /** Seams for tests: the clock (milliseconds) and the cool-down. */
  now?: () => number;
  coolDownMs?: number;
}

/** The log of a pool; without a pool (an application built for a test that never touches a database) every entry is dropped. */
export function createErrorLog(pool: Pick<DbPool, 'checkout'> | null, log: Warner, options: ErrorLogOptions = {}): ErrorLog {
  const now = options.now ?? Date.now;
  const coolDownMs = options.coolDownMs ?? COOL_DOWN_MS;
  let coolUntil = 0;
  let dropped = 0;
  const queue: Item[] = [];
  /** For each code and minute: how many entries were handed over (the first 20 are kept as entries, the others are counted). */
  const seen = new Map<string, { n: number; minuteMs: number }>();
  const overflow = new Map<string, { item: Item; count: number }>();
  let pump: Promise<void> | null = null;

  const note = (msg: string, e: unknown, extra: Record<string, unknown> = {}) => {
    try {
      log.warn({ ...extra, cause: describeCause(e) }, msg);
    } catch {
      // the log itself failed: nothing more can be done
    }
  };

  async function pass(): Promise<void> {
    while (queue.length > 0 || overflow.size > 0) {
      let conn: Awaited<ReturnType<NonNullable<typeof pool>['checkout']>>;
      try {
        conn = await pool!.checkout();
      } catch (e) {
        dropped += queue.length + [...overflow.values()].reduce((n, o) => n + o.count, 0);
        queue.length = 0;
        overflow.clear();
        coolUntil = now() + coolDownMs;
        note('error log: no database connection, the queued entries were dropped', e, { dropped });
        dropped = 0;
        return;
      }
      let broken = false;
      try {
        for (let item = queue.shift(); item !== undefined; item = queue.shift()) await logError(conn, item.entry, { now: item.at });
        for (const [key, o] of [...overflow]) {
          overflow.delete(key);
          for (let i = 0; i < o.count; i++) await logError(conn, o.item.entry, { now: o.item.at });
        }
      } catch (e) {
        broken = true;
        queue.length = 0;
        overflow.clear();
        note('error log: a row could not be written, the queued entries were dropped', e);
      } finally {
        if (broken) conn.destroy();
        else conn.release();
      }
    }
    const newest = Math.max(0, ...[...seen.values()].map((s) => s.minuteMs));
    for (const [key, s] of seen) if (s.minuteMs < newest - SEEN_KEEP_MS) seen.delete(key);
  }

  return {
    record(entry, at) {
      if (pool === null) return;
      if (now() < coolUntil) {
        dropped++;
        return;
      }
      try {
        const key = `${entry.code}|${errorLogMinute(at)}`;
        const s = seen.get(key) ?? { n: 0, minuteMs: Math.floor(at.getTime() / 60_000) * 60_000 };
        s.n++;
        seen.set(key, s);
        if (s.n <= ERROR_LOG_PER_MINUTE) queue.push({ entry, at });
        else {
          const o = overflow.get(key);
          if (o) o.count++;
          else overflow.set(key, { item: { entry, at }, count: 1 });
        }
        if (pump === null) {
          pump = pass()
            .catch((e) => note('error log: the pass failed', e))
            .finally(() => {
              pump = null;
            });
        }
      } catch (e) {
        note('error log: an entry could not be queued', e);
      }
    },
    async idle() {
      while (pump !== null) await pump;
    },
  };
}

// ------------------------------------------------------------------ what a row says

/** The JV_BUSY reasons that are the pool's own: the pool is full or the database is gone, so a row would need the very thing that is missing, and the answer already says it. */
const POOL_REASONS: ReadonlySet<BusyReason> = new Set(['queue_full', 'wait_timeout', 'connect_refused', 'connection_lost', 'closing']);

/** Where in our code an error was thrown: the file and line of the first stack frame that is ours (not node_modules, not Node itself), relative to the folder the program runs in. */
function whereOf(e: unknown): string | undefined {
  const stack = e instanceof Error ? e.stack : undefined;
  if (!stack) return undefined;
  for (const line of stack.split('\n').slice(1)) {
    if (line.includes('node_modules') || line.includes('node:')) continue;
    const m = /^\s*at (?:.*? \()?(?:file:\/\/)?(.+?):(\d+):\d+\)?\s*$/.exec(line);
    if (!m) continue;
    const file = relative(process.cwd(), m[1]);
    return `${file.startsWith('..') ? basename(m[1]) : file}:${m[2]}`;
  }
  return undefined;
}

/**
 * What goes into the row's detail about the error itself. A database error says its number, state and message (with the quoted value cut out, describeCause) because the message names the key
 * or the column, which is what the person reading it needs; any other error says only its name, code and where in our code it was thrown, never its message: a message is free text that a
 * bug could fill with a name or a number from the request.
 */
function causeDetail(original: unknown): Record<string, unknown> {
  const c = describeCause(original);
  const out: Record<string, unknown> = { name: c.name };
  for (const key of ['code', 'errno', 'sqlState'] as const) if (c[key] !== undefined) out[key] = c[key];
  if (c.errno !== undefined && typeof c.message === 'string') out.sql_message = c.message.slice(0, 300);
  const where = whereOf(original);
  if (where) out.where = where;
  return out;
}

/** The row for an answered error, or null when the answer is not an unexpected error (a refused input, a business rule, a refused session: the caller's, not ours). */
export function errorLogEntry(request: FastifyRequest, answer: JvError, original: unknown): ErrorEntry | null {
  const busy = answer instanceof BusyError ? answer : null;
  let code: string;
  let level: ErrorEntry['level'];
  if (answer.bug) {
    code = 'JV_BUG';
    level = 'error';
  } else if (answer.code === 'JV_INTERNAL') {
    code = 'JV_INTERNAL';
    level = 'error';
  } else if (answer.code === 'JV_UNAVAILABLE') {
    code = 'JV_UNAVAILABLE';
    level = 'error';
  } else if (busy !== null && !POOL_REASONS.has(busy.reason)) {
    code = 'JV_BUSY';
    level = 'warn';
  } else return null;
  const detail: Record<string, unknown> = { method: request.method, route: request.routeOptions?.url ?? null, status: answer.status };
  if (busy) detail.reason = busy.reason;
  detail.cause = causeDetail(answer.cause ?? original);
  return {
    level,
    code,
    message: busy ? `Answered JV_BUSY (${busy.reason}).` : answer.bug ? 'The database refused what the API\'s own checks should have caught.' : `Answered ${answer.code}.`,
    request_id: request.id,
    user_id: request.auth?.user.id ?? null,
    detail,
  };
}

/** The rows of a start-up check: one for a check that failed (the reason is for the owner's dashboard line, never for a stranger: /healthz and /readyz say only whether), one for a Delete or Drop right that is on. */
export function startupEntries(result: PreflightResult): ErrorEntry[] {
  const entries: ErrorEntry[] = [];
  if (!result.ok) {
    const checks = [...new Set(result.problems.map((p) => p.check))];
    entries.push({
      level: 'error',
      code: 'JV_STARTUP',
      message: `The start-up check failed (${checks.join(', ')}). The API answers JV_UNAVAILABLE until it passes.`,
      detail: { version: result.version, problems: result.problems.map((p) => ({ check: p.check, detail: scrubShapes(p.detail).slice(0, 500) })) },
    });
  }
  if (result.amber) {
    entries.push({ level: 'warn', code: 'JV_RIGHTS', message: 'The database user holds a Delete or Drop right (S7): the dashboard line is amber.', detail: { rights: result.outsideTenBoxes } });
  }
  return entries;
}
