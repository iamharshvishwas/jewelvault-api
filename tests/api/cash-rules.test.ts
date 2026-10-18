import { describe, expect, it } from 'vitest';
import { CASH_LIMIT_PAISE, PAN_THRESHOLD_PAISE, WALKIN_MESSAGE, judgeCash, needsPanPrompt, refuseWalkinBill } from '../../src/domain/cashRules';
import { JvError } from '../../src/errors';

// API23, section 13 as a pure rule (src/domain/cashRules.ts): the decision of Z1 and Z2 on figures already read, no database. The functions that read the day's cash and apply the rule to a
// transaction are proved through X1 and X2 in x01-payments.test.ts and x02-cash-rules.test.ts; the boundary cases are written here in paise so that no float and no rounding can hide behind them.
// The limit is a parameter of the rule, so a branch that cannot be reached with the real constants (for the walk-in, a cash payment at the limit inside a bill that the PAN rule has refused already,
// because the two thresholds are both 2,00,000) is proved with a smaller one.

const DAY = '2026-10-17';
const LAKH2 = 20_000_000n; // 2,00,000.00 in paise

function refusal(run: () => unknown): JvError {
  try {
    run();
  } catch (error) {
    if (error instanceof JvError) return error;
    throw error;
  }
  throw new Error('the rule did not refuse');
}

describe('T-A12 / T-B23 the constants of section 13 are the plan\'s: 2,00,000 for the cash limit and for the PAN threshold', () => {
  it('in paise', () => {
    expect(CASH_LIMIT_PAISE).toBe(LAKH2);
    expect(PAN_THRESHOLD_PAISE).toBe(LAKH2);
  });
});

describe('T-A12 / T-B23 Z1: a named customer\'s cash reaching the limit or more raises JV_CASH_LIMIT unless the owner gives a reason', () => {
  const named = { walkin: false, day: DAY, mayOverride: false, reason: null as string | null | undefined };

  it('1,99,999.99 passes and 2,00,000.00 raises, for cash taken in this call alone', () => {
    expect(judgeCash({ ...named, cash: 19_999_999n, before: 0n })).toEqual({ reason: null });
    const error = refusal(() => judgeCash({ ...named, cash: LAKH2, before: 0n }));
    expect(error.code).toBe('JV_CASH_LIMIT');
    expect(error.details).toMatchObject({ limit: '200000.00', cash_today: '0.00', this_call: '200000.00', date: DAY });
  });

  it('the day\'s total counts what was taken before: 1,50,000 + 49,999.99 passes, 1,50,000 + 50,000.00 raises, 1,99,999.99 + 0.01 raises', () => {
    expect(judgeCash({ ...named, before: 15_000_000n, cash: 4_999_999n })).toEqual({ reason: null });
    expect(refusal(() => judgeCash({ ...named, before: 15_000_000n, cash: 5_000_000n })).code).toBe('JV_CASH_LIMIT');
    expect(refusal(() => judgeCash({ ...named, before: 19_999_999n, cash: 1n })).code).toBe('JV_CASH_LIMIT');
    expect(judgeCash({ ...named, before: 19_999_998n, cash: 1n })).toEqual({ reason: null });
  });

  it('a call with no cash is never stopped, whatever the day already holds', () => {
    expect(judgeCash({ ...named, before: 90_000_000n, cash: 0n })).toEqual({ reason: null });
  });

  it('the owner (mayOverride) with a reason is let through and the reason is returned to be stored; without one he is stopped, and so is a caller who may not override even with a reason', () => {
    expect(judgeCash({ ...named, mayOverride: true, reason: 'ten people paid', before: 15_000_000n, cash: 5_000_000n })).toEqual({ reason: 'ten people paid' });
    const none = refusal(() => judgeCash({ ...named, mayOverride: true, reason: undefined, cash: LAKH2, before: 0n }));
    expect(none.code).toBe('JV_CASH_LIMIT');
    expect(none.message).toMatch(/reason/i);
    expect(refusal(() => judgeCash({ ...named, mayOverride: true, reason: null, cash: LAKH2, before: 0n })).code).toBe('JV_CASH_LIMIT');
    const biller = refusal(() => judgeCash({ ...named, mayOverride: false, reason: 'ten people paid', cash: LAKH2, before: 0n }));
    expect(biller.code).toBe('JV_CASH_LIMIT');
    expect(biller.message).toMatch(/owner/i);
  });

  it('a reason is returned only when it was needed: below the limit nothing is stored, though the owner sent one', () => {
    expect(judgeCash({ ...named, mayOverride: true, reason: 'ten people paid', before: 0n, cash: 19_999_999n })).toEqual({ reason: null });
    expect(judgeCash({ ...named, mayOverride: true, reason: 'ten people paid', before: 0n, cash: 0n })).toEqual({ reason: null });
  });

  it('a smaller limit moves the boundary and nothing else', () => {
    expect(judgeCash({ ...named, before: 0n, cash: 9_999n }, 10_000n)).toEqual({ reason: null });
    expect(refusal(() => judgeCash({ ...named, before: 0n, cash: 10_000n }, 10_000n)).code).toBe('JV_CASH_LIMIT');
  });
});

describe('T-A12 / T-B23 / T-B17 Z2: the walk-in\'s cash is never added up; a single cash payment at the limit or more raises with "Select or create the customer", for everybody', () => {
  const walkin = { walkin: true, day: DAY };

  it('1,99,999.99 passes and 2,00,000.00 raises, whatever the day already holds', () => {
    expect(judgeCash({ ...walkin, mayOverride: false, reason: null, cash: 19_999_999n, before: 90_000_000n })).toEqual({ reason: null });
    const error = refusal(() => judgeCash({ ...walkin, mayOverride: false, reason: null, cash: LAKH2, before: 0n }));
    expect(error.code).toBe('JV_CASH_LIMIT');
    expect(error.message).toBe(WALKIN_MESSAGE);
    expect(WALKIN_MESSAGE).toBe('Select or create the customer');
  });

  it('there is no override for the walk-in: the owner with a reason is refused too, and no reason is returned for a payment that passes', () => {
    expect(refusal(() => judgeCash({ ...walkin, mayOverride: true, reason: 'ten people paid', cash: LAKH2, before: 0n })).message).toBe(WALKIN_MESSAGE);
    expect(judgeCash({ ...walkin, mayOverride: true, reason: 'ten people paid', cash: 100n, before: 0n })).toEqual({ reason: null });
  });

  it('the cash rows of ONE bill are one payment: the rule is the same with a smaller limit (the branch the real constants cannot reach through X1, because the PAN rule refuses that bill first)', () => {
    expect(judgeCash({ ...walkin, mayOverride: false, reason: null, cash: 9_999n, before: 0n }, 10_000n)).toEqual({ reason: null });
    expect(refusal(() => judgeCash({ ...walkin, mayOverride: false, reason: null, cash: 10_000n, before: 0n }, 10_000n)).message).toBe(WALKIN_MESSAGE);
  });
});

describe('T-A12 Z3: the PAN prompt is for a named customer without a PAN at the threshold or more', () => {
  it('the threshold itself asks, one paisa under does not, a PAN or the walk-in is never asked (D10)', () => {
    expect(needsPanPrompt({ walkin: false, pan: null, grand: LAKH2 })).toBe(true);
    expect(needsPanPrompt({ walkin: false, pan: null, grand: LAKH2 - 1n })).toBe(false);
    expect(needsPanPrompt({ walkin: false, pan: 'ABCDE1234F', grand: LAKH2 * 5n })).toBe(false);
    expect(needsPanPrompt({ walkin: true, pan: null, grand: LAKH2 * 5n })).toBe(false);
  });
});

describe('T-A12 Z2: X1 refuses a walk-in bill of the PAN threshold or more with JV_NOT_ALLOWED', () => {
  it('2,00,000.00 is refused with the message, 1,99,999.00 and a named customer\'s bill of any size are not', () => {
    const error = refusal(() => refuseWalkinBill({ walkin: true, grand: LAKH2 }));
    expect(error.code).toBe('JV_NOT_ALLOWED');
    expect(error.message).toBe(WALKIN_MESSAGE);
    expect(error.details).toMatchObject({ field: 'customer_id' });
    expect(() => refuseWalkinBill({ walkin: true, grand: 19_999_900n })).not.toThrow();
    expect(() => refuseWalkinBill({ walkin: false, grand: LAKH2 * 50n })).not.toThrow();
  });
});
