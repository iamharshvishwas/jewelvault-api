import { appendFileSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// The statement log of T-D11 (A7, D19): "the statements are collected by running the suite with a statement log".
//
// While a test runs, every SELECT, WITH, UPDATE and INSERT ... SELECT that CODE IN src/ sends is noticed, and `EXPLAIN` of it is asked on the SAME connection, queued right behind the statement itself,
// so the plan is the one the optimizer made with the real rows and the real parameters in place (a primary-key lookup of a row that does not exist says "no matching row in const table" and names no
// index, so a replay later on an empty database would prove nothing). What is kept is the statement text (with its ?) and the plan: no parameter value is written anywhere.
//
// It is a test tool: it patches mysql2's Connection for the test process only, does nothing unless a log folder is given (JV_STATEMENT_LOG, set by `npm run verify`, or a call of
// installStatementLog by a test), and statements sent from tests/ or scripts/ are not logged. The check that reads the log is tests/api/static-explain.test.ts.
//
// Known cost: the plan is asked once per distinct statement (a few times if the first run found no row), and the EXPLAIN is a statement of its own on the connection, so ROW_COUNT() and FOUND_ROWS()
// after a statement would read -1 and 0; the API reads the OK packet instead (S12), and a source check would be the place to forbid them if that ever changed.

const require = createRequire(import.meta.url);

export const REPO = resolve(fileURLToPath(new URL('../../', import.meta.url)));
const SRC_MARK = `${join(REPO, 'src')}/`;
/** Where `npm run verify` collects the log of the suite and where `npm run check:static` reads it. */
export const DEFAULT_LOG_DIR = join(REPO, 'node_modules', '.cache', 'jv-statement-log');

export interface PlanRow {
  select_type: string | null;
  table: string | null;
  type: string | null;
  possible_keys: string | null;
  key: string | null;
  rows: string | number | null;
  Extra: string | null;
}

export interface LoggedStatement {
  sql: string;
  plan: PlanRow[];
  /** how many times the plan was asked before this answer (1 when the first run already had a row to look at) */
  attempt: number;
}

type Kind = 'select' | 'update' | 'insert_select' | 'delete';

const strip = (sql: string) => sql.replace(/^(?:\s|\(|\/\*[\s\S]*?\*\/|--[^\n]*\n|#[^\n]*\n)+/, '');

/** Which statements get a plan: reads, updates and the select inside an insert. Everything else (SET, START TRANSACTION, COMMIT, plain INSERT, SHOW) has no access path to judge. */
export function explainable(sql: string): Kind | null {
  const t = strip(sql);
  if (/^(SELECT|WITH)\s/i.test(t)) return /\bFROM\b/i.test(t) ? 'select' : null;
  if (/^UPDATE\s/i.test(t)) return 'update';
  if (/^DELETE\s/i.test(t)) return 'delete';
  if (/^INSERT\s/i.test(t) && /\bSELECT\b/i.test(t)) return 'insert_select';
  return null;
}

/** A plan that says nothing about the access path, because the optimizer found at once that no row can match. */
export const isVacuous = (plan: readonly PlanRow[]) =>
  plan.length > 0 && plan.every((r) => !r.table) && plan.some((r) => /Impossible WHERE|no matching row in const table|Impossible HAVING/i.test(r.Extra ?? ''));

const MAX_ATTEMPTS = 6;
const MAX_NON_SRC = 3;
const MAX_TRACKED = 4000;

interface Seen {
  attempts: number;
  decided: boolean;
  nonSrc: number;
}

export interface StatementLog {
  readonly dir: string;
  /** resolves when every plan asked so far has been answered */
  idle(timeoutMs?: number): Promise<void>;
  /** stops noticing statements (the patch stays; it does nothing without a sink) */
  stop(): void;
}

interface Sink {
  dir: string;
  file: string;
  seen: Map<string, Seen>;
  pending: number;
  waiters: (() => void)[];
}

const STATE_KEY = Symbol.for('jewelvault.statementLog');
interface PatchState {
  sinks: Set<Sink>;
  query: (...args: unknown[]) => unknown;
}

function fromSrc(): boolean {
  const prev = Error.stackTraceLimit;
  Error.stackTraceLimit = 60;
  const stack = new Error().stack ?? '';
  Error.stackTraceLimit = prev;
  return stack.includes(SRC_MARK);
}

function observe(sink: Sink, state: PatchState, conn: object, sql: string, values: unknown[] | undefined) {
  const kind = explainable(sql);
  if (!kind) return;
  let seen = sink.seen.get(sql);
  if (!seen) {
    if (sink.seen.size >= MAX_TRACKED || sql.length > 4000) return;
    seen = { attempts: 0, decided: false, nonSrc: 0 };
    sink.seen.set(sql, seen);
  }
  if (seen.decided || seen.attempts >= MAX_ATTEMPTS || seen.nonSrc >= MAX_NON_SRC) return;
  if (!fromSrc()) {
    seen.nonSrc++;
    return;
  }
  const attempt = ++seen.attempts;
  sink.pending++;
  const done = () => {
    if (--sink.pending === 0) for (const w of sink.waiters.splice(0)) w();
  };
  try {
    // queued behind the statement that was just sent, before anything the caller sends next
    state.query.call(conn, `EXPLAIN ${sql}`, values ?? [], (err: unknown, rows: unknown) => {
      try {
        if (!err && Array.isArray(rows)) {
          const plan = (rows as Record<string, unknown>[]).map((r) => ({
            select_type: (r.select_type as string) ?? null,
            table: (r.table as string) ?? null,
            type: (r.type as string) ?? null,
            possible_keys: (r.possible_keys as string) ?? null,
            key: (r.key as string) ?? null,
            rows: (r.rows as string | number) ?? null,
            Extra: (r.Extra as string) ?? null,
          }));
          const vacuous = isVacuous(plan);
          if (!vacuous) seen!.decided = true;
          if (!vacuous || attempt >= MAX_ATTEMPTS) {
            mkdirSync(sink.dir, { recursive: true });
            appendFileSync(sink.file, `${JSON.stringify({ sql, plan, attempt } satisfies LoggedStatement)}\n`);
          }
        }
      } catch {
        /* a log that cannot be written must never break the test that is running */
      } finally {
        done();
      }
    });
  } catch {
    done();
  }
}

/**
 * Starts noticing statements of src/ in this process and writing them, with their plans, to `<dir>/<pid>.jsonl`. Safe to call twice (each call is its own log); call stop() when done.
 */
export function installStatementLog(options: { dir: string }): StatementLog {
  const { Connection } = require('mysql2') as { Connection: { prototype: Record<string | symbol, unknown> } };
  const proto = Connection.prototype as Record<string | symbol, any>;
  // the state lives on the prototype itself: wherever this file is loaded from, mysql2's class is patched once
  let state = proto[STATE_KEY] as PatchState | undefined;
  if (!state) {
    const original = { query: proto.query, execute: proto.execute };
    state = { sinks: new Set<Sink>(), query: original.query };
    const patch = state;
    for (const name of ['query', 'execute'] as const) {
      const real = original[name];
      proto[name] = function (this: object, ...args: unknown[]) {
        const returned = real.apply(this, args); // the statement goes first; a synchronous refusal reaches the caller untouched
        if (patch.sinks.size > 0 && typeof args[0] === 'string') {
          try {
            const values = Array.isArray(args[1]) ? (args[1] as unknown[]) : undefined;
            for (const sink of patch.sinks) observe(sink, patch, this, args[0], values);
          } catch {
            /* never break the caller */
          }
        }
        return returned;
      };
    }
    proto[STATE_KEY] = state;
  }
  const dir = resolve(options.dir);
  const sink: Sink = { dir, file: join(dir, `${process.pid}-${Math.random().toString(36).slice(2, 8)}.jsonl`), seen: new Map(), pending: 0, waiters: [] };
  state.sinks.add(sink);
  const owner = state;
  return {
    dir,
    idle(timeoutMs = 10_000) {
      if (sink.pending === 0) return Promise.resolve();
      return new Promise<void>((resolveIdle) => {
        const timer = setTimeout(resolveIdle, timeoutMs);
        sink.waiters.push(() => {
          clearTimeout(timer);
          resolveIdle();
        });
      });
    },
    stop() {
      owner.sinks.delete(sink);
    },
  };
}

/** Reads every log file of a folder. Several lines for one statement (the process ran in several test files) are merged: a plan that looked at a row beats one that did not, the later beats the earlier. */
export function readStatementLog(dir: string): LoggedStatement[] {
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  } catch {
    return [];
  }
  const best = new Map<string, LoggedStatement>();
  for (const f of files) {
    for (const line of readFileSync(join(dir, f), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let entry: LoggedStatement;
      try {
        entry = JSON.parse(line) as LoggedStatement;
      } catch {
        continue;
      }
      const old = best.get(entry.sql);
      if (!old || isVacuous(old.plan) || !isVacuous(entry.plan)) best.set(entry.sql, entry);
    }
  }
  return [...best.values()].sort((a, b) => a.sql.localeCompare(b.sql));
}
