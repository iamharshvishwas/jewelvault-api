// S11 / IM1 / B4: scripts and tools that open many connections (the import, the restore tool, tests against staging) pace themselves to at most 10 NEW connections in any
// 1.2 seconds. Hostinger refuses the 21st new connection inside about one second (error EPERM, API-00); an open connection costs nothing, only opening one does.
// One pacer per process; every connect goes through wait() (or pacedConnect).

export const PACE_MAX = 10;
export const PACE_WINDOW_MS = 1200;

/**
 * A sliding window: wait() resolves when one more new connection may be opened and records it, so no 1.2 seconds ever hold more than `max` openings. Waiters are served in order.
 * `now` and `sleep` are test seams.
 */
export function createPacer({ max = PACE_MAX, windowMs = PACE_WINDOW_MS, now = () => Date.now(), sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  if (!Number.isInteger(max) || max < 1) throw new Error('max must be a positive integer');
  const starts = [];
  let queue = Promise.resolve();
  const admit = async () => {
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

/** Waits for the pacer, then runs `connect` (for example `() => mysql.createConnection(config)`). */
export async function pacedConnect(pacer, connect) {
  await pacer.wait();
  return connect();
}
