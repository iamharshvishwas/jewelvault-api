import { describe, expect, it } from 'vitest';
import { BUSINESS_TIME_ZONE, businessDate, createClock, formatTimestamp, systemClock } from '../../src/clock';

const at = (iso: string) => BigInt(Date.parse(iso)) * 1000n;

describe('S5 the API clock', () => {
  it('names the business zone Asia/Kolkata', () => {
    expect(BUSINESS_TIME_ZONE).toBe('Asia/Kolkata');
  });

  it('one reading carries the instant, its DATETIME(6) text in UTC and its Asia/Kolkata calendar date, all of the same instant', () => {
    const r = createClock(() => at('2026-12-31T18:40:00.000Z') + 7n).read();
    expect(r.micros).toBe(at('2026-12-31T18:40:00.000Z') + 7n);
    expect(r.timestamp).toBe('2026-12-31 18:40:00.000007');
    expect(r.date).toBe('2027-01-01'); // T-B16: a void at 00:10 Kolkata time on 1 January is 18:40 UTC on 31 December
  });

  it('the day changes exactly at 18:30:00.000000 UTC (00:00 in Kolkata)', () => {
    expect(businessDate(at('2026-06-10T18:29:59.999Z') + 999n)).toBe('2026-06-10');
    expect(businessDate(at('2026-06-10T18:30:00.000Z'))).toBe('2026-06-11');
    expect(businessDate(at('2026-06-10T00:00:00.000Z'))).toBe('2026-06-10');
    expect(businessDate(at('2026-02-28T20:00:00.000Z'))).toBe('2026-03-01');
  });

  it('agrees with the IANA zone Asia/Kolkata over a sweep of a whole year, and does not follow the process time zone', () => {
    const f = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' });
    const original = process.env.TZ;
    try {
      for (const tz of ['UTC', 'America/Los_Angeles', 'Pacific/Kiritimati', 'Asia/Kolkata']) {
        process.env.TZ = tz;
        for (let ms = Date.parse('2026-01-01T00:00:00Z'); ms < Date.parse('2027-01-01T00:00:00Z'); ms += 13 * 60_000 + 17) {
          expect(businessDate(BigInt(ms) * 1000n), `${tz} ${new Date(ms).toISOString()}`).toBe(f.format(new Date(ms)));
        }
      }
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
  });

  it('formats DATETIME(6) text with six digits and no zone, whatever the process time zone', () => {
    const original = process.env.TZ;
    try {
      process.env.TZ = 'America/Los_Angeles';
      expect(formatTimestamp(at('2026-01-01T00:00:00.000Z') + 1n)).toBe('2026-01-01 00:00:00.000001');
      expect(formatTimestamp(at('2026-10-17T09:05:03.120Z') + 450n)).toBe('2026-10-17 09:05:03.120450');
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
  });

  it('two readings in the same microsecond are one microsecond apart; a later source value is taken as it is', () => {
    let now = 5_000_000n;
    const c = createClock(() => now);
    expect(c.read().micros).toBe(5_000_000n);
    expect(c.read().micros).toBe(5_000_001n);
    expect(c.read().micros).toBe(5_000_002n);
    now = 9_000_000n;
    expect(c.read().micros).toBe(9_000_000n);
  });

  it('keeps increasing when the source steps backwards (a corrected system clock)', () => {
    const values = [10_000n, 10_001n, 9_000n, 9_001n, 8_000n, 10_010n];
    let i = 0;
    const c = createClock(() => values[i++]);
    const out = values.map(() => c.read().micros);
    expect(out).toEqual([10_000n, 10_001n, 10_002n, 10_003n, 10_004n, 10_010n]);
  });

  it('every reading of the shared system clock is later than the one before, and two clocks do not share a counter', () => {
    let prev = systemClock.read().micros;
    for (let i = 0; i < 2000; i++) {
      const n = systemClock.read().micros;
      expect(n > prev).toBe(true);
      prev = n;
    }
    const x = createClock(() => 1n);
    const y = createClock(() => 1n);
    x.read();
    x.read();
    expect(y.read().micros).toBe(1n);
  });

  it('a clock fixed at one instant also keeps the date of that instant for a thousand readings', () => {
    const c = createClock(() => at('2026-10-17T10:00:00.000Z'));
    const dates = new Set<string>();
    for (let i = 0; i < 1000; i++) dates.add(c.read().date);
    expect([...dates]).toEqual(['2026-10-17']);
  });
});
