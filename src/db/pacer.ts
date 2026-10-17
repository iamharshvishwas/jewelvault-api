// S11: tools and tests that open many connections pace themselves to at most 10 NEW connections in any 1.2 seconds, because Hostinger refuses the 21st new connection inside
// about a second (connect EPERM). The database half's pacer is scripts/pacing.mjs (used by the import, the restore tool and the test harness); the build compiles src/ alone and
// so cannot import a scripts/*.mjs file. This is its TypeScript twin, for the pool wrapper's reconnect path, and tests/api/f08-pacing.test.ts keeps the two identical.

export const PACE_MAX = 10;
export const PACE_WINDOW_MS = 1200;

export interface Pacer {
  readonly max: number;
  readonly windowMs: number;
  /** Resolves when one more NEW connection may be opened, and records it: never more than `max` in any `windowMs`. Waiters are served in order. */
  wait(): Promise<void>;
}

export interface PacerOptions {
  max?: number;
  windowMs?: number;
  /** Test seams: the clock (milliseconds) and the pause. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export function createPacer({ max = PACE_MAX, windowMs = PACE_WINDOW_MS, now = () => Date.now(), sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }: PacerOptions = {}): Pacer {
  if (!Number.isInteger(max) || max < 1) throw new Error('max must be a positive integer');
  const starts: number[] = [];
  let queue: Promise<unknown> = Promise.resolve();
  const admit = async (): Promise<void> => {
    for (;;) {
      const t = now();
      while (starts.length > 0 && t - starts[0] >= windowMs) starts.shift();
      if (starts.length < max) {
        starts.push(t);
        return;
      }
      await sleep(Math.max(1, starts[0] + windowMs - t));
    }
  };
  return {
    max,
    windowMs,
    wait() {
      const turn = queue.then(admit);
      queue = turn.catch(() => undefined);
      return turn;
    },
  };
}
