// S4, D18: the API's one constants file. The code reads the caps and the thresholds from here and nowhere else; none of them is a table.
// The caps are also written as literals in the named CHECK constraints of db/migrations. tests/api/limits.test.ts (T-F02) compares this file with db/limits.json
// and with every CHECK read from information_schema.CHECK_CONSTRAINTS, so a number that changes in one place and not in the other fails the test run.
// Money caps are in rupees and weight caps in grams, as the wire carries them (S3); the money path itself works in integer paise and milligrams.

export const limits = Object.freeze({
  /** A weight is at most 100,000 g. */
  maxWeightGrams: 100000,
  /** A rate or a piece price is at most 100,000,000. */
  maxRate: 100000000,
  /** Every line amount, line total, subtotal, grand total, payment, refund, discount, additional charge, opening balance and fine_cash amount is at most 1,000,000,000. */
  maxAmount: 1000000000,
  /** A quantity is 1 to 1,000. */
  minQuantity: 1,
  maxQuantity: 1000,
  /** A bill has 1 to 200 lines. */
  minLines: 1,
  maxLines: 200,
  /** A design photo is at most 2 MiB, and a design has at most 3 photos (Harsh's rule of 15 Oct 2026, O21). */
  maxPhotoBytes: 2097152,
  maxPhotosPerDesign: 3,
  /** P2, O56: photos that no design owns yet (the screen uploads before it creates the design) are at most 60 photos or 100 MB at once; beyond that the upload is JV_NOT_ALLOWED. */
  maxUnattachedPhotos: 60,
  maxUnattachedPhotoBytes: 100 * 1024 * 1024,
  /** X8: a group of identical pieces has 1 to 100 pieces, and one create_design call makes at most 500 pieces in all (it is also the most pieces X9 changes in one call). */
  maxPiecesPerGroup: 100,
  maxPiecesPerCall: 500,
  /** Section 13, Z1 and Z2: cash of this amount or more (`cash_limit`). For the CA to confirm (O14). */
  cashLimit: 200000,
  /** Z3: a bill of this amount or more asks for the customer's PAN (`pan_threshold`). */
  panThreshold: 200000,
  /** I11: the review line lists bills with a discount above this percent of the subtotal (`discount_flag_percent`). */
  discountFlagPercent: 10,
  /** I11: the review line lists a fine_cash rate more than this percent away from the day's Silver rates, and a daily rate that moved more than this percent (`rate_flag_percent`). */
  rateFlagPercent: 5,
  /** C3: a page of the read side (GET /v1/sync/<resource>, and each resource of POST /v1/sync/poll) has at most this many rows. A constant of the API, so no layer below it cuts a page silently. */
  syncPageRows: 1000,
  /** C3: the owner's on-demand reads (GET /v1/audit-log, GET /v1/health/checks) have at most this many rows a page. Asking for more is refused, not cut. */
  ownerPageRows: 200,
  /** C3, A4: the owner reads the cash book (GET /v1/daily-totals) for at most this many days in one call. (A biller's two days are BILLER_DAILY_TOTALS_DAYS of the permission matrix.) */
  dailyTotalsMaxDays: 400,
  /** B3: the record of a Download everything accepts a file's row count that is off by at most the rows made in this many milliseconds before the call (the cache is up to one poll behind). */
  downloadAllowanceMs: 2 * 60 * 1000,
  /** B3: no file of the zip has more rows than this; a larger count in a record is refused as nonsense before the database is asked. */
  downloadFileRows: 100000000,
  /** U4: a session idle for more than 12 hours (no call but polling) is over: JV_SESSION_EXPIRED. Siddhi's choice (O42). */
  sessionIdleMs: 12 * 60 * 60 * 1000,
  /** U4: a session lasts at most 14 days from the login (`sessions.expires_at` is set to this at login; the lookup reads the column). Siddhi's choice (O42). */
  sessionAbsoluteMs: 14 * 24 * 60 * 60 * 1000,
});

export type Limits = typeof limits;
