// S5: the API's one clock. Every function that needs "now" reads it from here, so a test can fix it by passing a different source to createClock().
// Nothing in a route, a header, a query or an environment variable can change the source: the production entry (server.ts) uses systemClock and nothing else.

/** The business time zone. India has no daylight saving, so the offset below is fixed (the tests compare it with the IANA zone for a whole year). */
export const BUSINESS_TIME_ZONE = 'Asia/Kolkata';
const BUSINESS_OFFSET_MICROS = 19_800_000_000n; // +05:30

/** One reading. The three fields describe the same instant: a void's voided_at and voided_on come from one reading (D13). */
export interface Reading {
  /** Microseconds since 1970-01-01T00:00:00Z. */
  readonly micros: bigint;
  /** The instant as MariaDB DATETIME(6) text in UTC: 'YYYY-MM-DD HH:MM:SS.ffffff'. */
  readonly timestamp: string;
  /** The business day: the Asia/Kolkata calendar date of the instant, 'YYYY-MM-DD'. */
  readonly date: string;
}

export interface Clock {
  /** Each reading is later than every earlier reading of this clock, by at least one microsecond. */
  read(): Reading;
}

/** Where a clock gets its time: microseconds since the epoch. */
export type MicrosSource = () => bigint;

const pad = (n: number | bigint, width: number) => String(n).padStart(width, '0');

function utcParts(micros: bigint) {
  const ms = micros / 1000n;
  const d = new Date(Number(ms));
  const fraction = pad(ms % 1000n, 3) + pad(micros % 1000n, 3);
  return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1, 2)}-${pad(d.getUTCDate(), 2)} ${pad(d.getUTCHours(), 2)}:${pad(d.getUTCMinutes(), 2)}:${pad(d.getUTCSeconds(), 2)}.${fraction}`;
}

/** DATETIME(6) text in UTC. Uses only UTC getters, so the process time zone plays no part. */
export function formatTimestamp(micros: bigint): string {
  return utcParts(micros);
}

/** The Asia/Kolkata calendar date of an instant. */
export function businessDate(micros: bigint): string {
  return utcParts(micros + BUSINESS_OFFSET_MICROS).slice(0, 10);
}

/** The system's wall clock, to the millisecond. The strictly increasing step below does the rest. */
export function systemMicros(): bigint {
  return BigInt(Date.now()) * 1000n;
}

/**
 * A clock over a source. It never returns the same instant twice: a reading that is not later than the one before gets one microsecond more
 * (so two rows made in one transaction never tie, and a source that steps backwards cannot make time run backwards).
 */
export function createClock(source: MicrosSource = systemMicros): Clock {
  let last: bigint | undefined;
  return {
    read(): Reading {
      const now = source();
      last = last === undefined || now > last ? now : last + 1n;
      return Object.freeze({ micros: last, timestamp: formatTimestamp(last), date: businessDate(last) });
    },
  };
}

/** The API's one clock. */
export const systemClock: Clock = createClock();
