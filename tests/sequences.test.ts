import { describe, expect, it } from 'vitest';
import { SEED_PLANS, type SeedPlan, type SequenceReport, runSequence } from './api/x31-sequence';

// API31, T-B14 (I9, Y6, V3, I1 to I7, I10, I13) and the T-B26 clause (Y6, I10): random sequences of 200 operations through the REAL routes for three seeds (and, when JV_SEQUENCE_SEED names one, a
// fourth, run once: `JV_SEQUENCE_SEED=4 npm test -- -t T-B14`). The generator, the oracle and the checks after every operation are in tests/api/x31-sequence.ts (read its header first).
//
// One run of a seed is shared by the two describes below, so `-t T-B14` and `-t T-B26` each find their own tests and either one runs the sequence.

const SEEDS = [1, 2, 3];
const extra = Number(process.env.JV_SEQUENCE_SEED ?? '0');

/** The plan of a seed that has none of its own (an extra seed named in the environment): a start near the New Year and a round-off flag drawn from the seed. */
function planOf(seed: number): SeedPlan {
  return SEED_PLANS[seed] ?? { seed, start: ['2026-12-28T05:00:00Z', '2026-12-30T17:55:00Z', '2026-12-31T15:30:00Z'][seed % 3], roundOff: seed % 2 === 1 };
}

const runs = new Map<number, Promise<SequenceReport>>();
function runOnce(seed: number): Promise<SequenceReport> {
  let run = runs.get(seed);
  if (!run) {
    run = runSequence(planOf(seed), { ops: 200 });
    runs.set(seed, run);
  }
  return run;
}

/** The sentence that goes to the log (the seed, the mix, the refusals, how many allocations were compared). */
function summary(r: SequenceReport): string {
  return JSON.stringify({
    seed: r.seed, ops: r.ops, seconds: Math.round(r.seconds * 10) / 10, days: `${r.firstDay} .. ${r.lastDay}`, saved: r.ok, refused: r.refused, voided: r.voided,
    repeats: r.replays, midnights: r.midnights, newYears: r.newYears, backDated: r.backdated, walkin: r.walkin, invariantRuns: r.invariantRuns, allocationsCompared: r.allocationsCompared, ledgersChecked: r.ledgersChecked,
    nightly: r.nightly ? { runs: r.nightly.runs, ok: r.nightly.ok } : null,
    ...(r.problems.length > 0 ? { firstProblem: r.problems[0] } : {}),
  });
}

/** What a sequence must have covered, or it proves nothing about the thing it is named for (the mix of T-B14). */
function expectCovered(r: SequenceReport): void {
  expect(r.ops).toBe(200);
  for (const op of ['create_bill', 'record_payment', 'settle_fine', 'void_receipt', 'cancel_bill', 'reissue_bill', 'issue_refund', 'add_opening_balance']) {
    expect(r.ok[op], `no ${op} was saved in 200 operations`).toBeGreaterThan(0);
  }
  for (const kind of ['money', 'fine_silver', 'fine_cash', 'refund']) expect(r.voided[kind], `no receipt of kind ${kind} was voided`).toBeGreaterThan(0);
  expect(Object.keys(r.refused).length, 'no refusal was provoked').toBeGreaterThan(0);
  expect(r.replays, 'no repeat of a saved request').toBeGreaterThan(0);
  expect(r.midnights, 'the clock never crossed an Indian midnight').toBeGreaterThan(0);
  expect(r.newYears, 'the clock never crossed the New Year').toBeGreaterThan(0);
  expect(r.backdated, 'the owner never back-dated an entry').toBeGreaterThan(0);
  expect(r.walkin, 'the walk-in never took part').toBeGreaterThan(0);
  expect(r.invariantRuns, 'the invariants ran after every saved operation').toBeGreaterThanOrEqual(Object.values(r.ok).reduce((n, c) => n + c, 0));
  expect(r.ran).toEqual(['I1', 'I2', 'I3', 'I4', 'I5', 'I6', 'I7', 'I10', 'I13']);
}

describe('T-B14 random sequences of 200 operations (bills, payments, fine, voids, cancels, re-issues, refunds, opening balances, back-dated entries, the walk-in, clock jumps over midnight and New Year): I1 to I7, I10, I13 and the ledger after every operation', () => {
  for (const seed of [...SEEDS, ...(extra > 0 && !SEEDS.includes(extra) ? [extra] : [])]) {
    it(`seed ${seed}${SEEDS.includes(seed) ? '' : ' (run once)'}: the invariants, the oracle from the base tables and the ledger hold after every operation, every refusal leaves the books as they were, the nightly check is green`, async () => {
      const r = await runOnce(seed);
      console.log(`[T-B14 seed ${seed}] ${summary(r)}`);
      expect(r.problems).toEqual([]);
      expectCovered(r);
      expect(r.nightly?.ok).toBe(true);
      expect(r.ledgersChecked).toBeGreaterThanOrEqual(3 * r.ops * 0.5); // three ledgers after every saved operation
    }, 900_000);
  }
});

describe('T-B26 (API31 clause) after each operation of the random sequences no earlier allocation changes id or amount, except by a cancel or a void, and I10 holds', () => {
  for (const seed of SEEDS) {
    it(`seed ${seed}: earlier allocations are identical column for column (only a cancel sets released_at, only on its own bill's rows; a void changes none); the rebalance only adds rows`, async () => {
      const r = await runOnce(seed);
      expect(r.problems.filter((p) => /T-B26|I10/.test(p))).toEqual([]);
      expect(r.allocationsCompared, `only ${r.allocationsCompared} allocations were compared in ${r.ops} operations${r.problems.length > 0 ? ` (the sequence stopped: ${r.problems[0]})` : ''}`).toBeGreaterThan(1000);
      expect(r.ok.cancel_bill + r.ok.reissue_bill + r.ok.void_receipt, 'no cancel, re-issue or void to be the exception').toBeGreaterThan(0);
    }, 900_000);
  }
});
