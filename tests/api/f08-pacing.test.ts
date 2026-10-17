import { describe, expect, it } from 'vitest';
import { createPacer as createTsPacer } from '../../src/db/pacer';
import { createPacer as createMjsPacer } from '../../scripts/pacing.mjs';
import { testPacer } from '../helpers';

// T-F08, the pacing half of S11: scripts and tools that open many connections pace themselves to at most 10 NEW connections in any 1.2 seconds.
// The database half's pacer (scripts/pacing.mjs) is what tools and tests use; src cannot import a scripts/*.mjs file (the build compiles src alone),
// so the pool wrapper's reconnect path uses a TypeScript twin, and this file keeps the two identical.

type Make = (o: { max?: number; windowMs?: number; now: () => number; sleep: (ms: number) => Promise<void> }) => { wait(): Promise<void> };

/** Runs `count` waits at once on a virtual clock (sleep only moves the clock) and returns the virtual time at which each was admitted. */
async function admissions(make: Make, count: number, opts: { max?: number; windowMs?: number } = {}): Promise<number[]> {
  let t = 0;
  const pacer = make({ ...opts, now: () => t, sleep: async (ms) => void (t += ms) });
  const times: number[] = [];
  await Promise.all(Array.from({ length: count }, () => pacer.wait().then(() => times.push(t))));
  return times;
}

/** The most admissions that fall into any one window of `windowMs`. */
const busiestWindow = (times: number[], windowMs = 1200) => Math.max(...times.map((t0) => times.filter((t) => t >= t0 && t < t0 + windowMs).length));

describe('T-F08 pacing: at most 10 new connections in any 1.2 seconds (S11)', () => {
  it('the harness pacer admits 10 at once and the rest only as the window slides: no 1.2 seconds ever hold more than 10', async () => {
    const times = await admissions(createMjsPacer as Make, 35);
    expect(times.slice(0, 10)).toEqual(Array(10).fill(0));
    expect(times[10]).toBeGreaterThanOrEqual(1200);
    expect(busiestWindow(times)).toBe(10);
  });

  it('negative control: the same check fails on a pacer that lets 100 through, so the check can tell', async () => {
    const times = await admissions(createMjsPacer as Make, 35, { max: 100 });
    expect(busiestWindow(times)).toBe(35);
  });

  it('the TypeScript twin of the pool wrapper admits at exactly the same moments as the harness pacer', async () => {
    for (const opts of [{}, { max: 3, windowMs: 500 }, { max: 1, windowMs: 100 }]) {
      const a = await admissions(createMjsPacer as Make, 41, opts);
      const b = await admissions(createTsPacer as Make, 41, opts);
      expect(b, JSON.stringify(opts)).toEqual(a);
    }
  });

  it('the twin refuses a nonsense limit, and its waiters are served in order', async () => {
    expect(() => createTsPacer({ max: 0 })).toThrow(/positive integer/);
    expect(() => createTsPacer({ max: 1.5 })).toThrow(/positive integer/);
    let t = 0;
    const pacer = createTsPacer({ max: 1, windowMs: 100, now: () => t, sleep: async (ms) => void (t += ms) });
    const order: number[] = [];
    await Promise.all([1, 2, 3, 4].map((n) => pacer.wait().then(() => order.push(n))));
    expect(order).toEqual([1, 2, 3, 4]);
  });

  it('with real time too: eleven waits of the default pacer take over a second, ten take almost none', async () => {
    const pacer = createTsPacer();
    expect([pacer.max, pacer.windowMs]).toEqual([10, 1200]);
    const t0 = Date.now();
    for (let i = 0; i < 10; i++) await pacer.wait();
    expect(Date.now() - t0).toBeLessThan(300);
    await pacer.wait();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1150);
  });

  it('the test helpers open every connection through the harness pacer: 10 in 1.2 seconds', () => {
    expect([testPacer.max, testPacer.windowMs]).toEqual([10, 1200]);
  });
});
