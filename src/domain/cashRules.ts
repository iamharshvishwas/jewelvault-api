// Section 13: Z1 (cash from a named customer), Z2 (the walk-in), Z3 (the PAN prompt), K5. Used by X1 for the payment rows of a new bill, by X2 for a `Cash` payment, by X3 for `fine_cash` (API24) and by
// X10 through the rules of X1. No new printable document is made by either rule (Z4).
//
// THE PER-DAY TOTAL (Z1). For a customer that is not the walk-in, `cash_today` is the sum of `amount` of their ACTIVE receipts with `paid_on` on one business date that are `money` receipts of mode Cash
// or `fine_cash` receipts, leaving out `is_opening` rows and NOT reduced by refunds (a refund is a receipt of kind `refund`: it is neither counted nor subtracted). A call that would make `cash_today`
// REACH the limit or more raises JV_CASH_LIMIT, unless the caller may use the owner's field right and gives a reason (the route has already refused a reason from anybody else with 403, Z1; this
// module asks the matrix by name and never compares a role). The reason is returned to be stored on the bill or the receipt, and ONLY when the override was needed: the review line of I11 counts the
// bills and receipts saved with a reason, so a reason that changed nothing must not appear there.
//
// THE WALK-IN (Z2). One row stands for many different people, so its cash is never added up over a day: a SINGLE cash payment (one record_payment, one fine_cash settlement, the Cash rows of one bill)
// of the limit or more raises JV_CASH_LIMIT with the message "Select or create the customer"; there is no override. A bill whose grand total is the PAN threshold or more is refused for the walk-in
// with JV_NOT_ALLOWED and the same message (the PAN rule says "exceeding"; the stricter reading is deliberate, O14).
//
// The day's cash is read under the customer lock the caller holds (X0 item 3): two payments of one customer cannot both read the same total. The figures are paise (BigInt); the limits are the
// constants of src/limits.ts (D18), never a table.
import type { Reader } from '../db/tx.js';
import { JvError } from '../errors.js';
import { limits } from '../limits.js';
import { mayUseField } from '../permissions/matrix.js';
import { fromUnits, toUnits } from './rebalance.js';

const MONEY = 2;
const rupees = (n: number): bigint => BigInt(n) * 100n;

/** `cash_limit` in paise: cash that reaches it is stopped. */
export const CASH_LIMIT_PAISE: bigint = rupees(limits.cashLimit);
/** `pan_threshold` in paise: a bill of this amount or more asks for a PAN (named customer) or needs a named customer (walk-in). */
export const PAN_THRESHOLD_PAISE: bigint = rupees(limits.panThreshold);

/** Z2: the words the screen shows when the walk-in reaches a limit. */
export const WALKIN_MESSAGE = 'Select or create the customer';

const inRupees = (paise: bigint): string => Number(paise / 100n).toLocaleString('en-IN'); // display only: the limits are whole rupees

// ------------------------------------------------------------------ the decision: pure

export interface JudgeInput {
  /** K5: the customer is the walk-in */
  walkin: boolean;
  /** the business date the cash is dated, for the message */
  day: string;
  /** the Cash this call would add, paise (0 when the call has none) */
  cash: bigint;
  /** the customer's `cash_today` before this call, paise (not used for the walk-in) */
  before: bigint;
  /** the caller may give a reason for cash over the limit (the owner's field right) */
  mayOverride: boolean;
  /** `cash_override_reason` as sent (already 10 to 500 characters and trimmed by the body schema) */
  reason: string | null | undefined;
}

export interface CashVerdict {
  /** the reason to store on the bill or the receipt: only when the override was needed, else null */
  reason: string | null;
}

/** Z1 and Z2 on figures already read. Raises JV_CASH_LIMIT or returns what to store. `limit` is a parameter for the tests only. */
export function judgeCash(o: JudgeInput, limit: bigint = CASH_LIMIT_PAISE): CashVerdict {
  if (o.cash <= 0n) return { reason: null };
  if (o.walkin) {
    // Z2: a single cash payment of the limit or more; nothing is added over the day and nobody may override
    if (o.cash >= limit) {
      throw new JvError('JV_CASH_LIMIT', WALKIN_MESSAGE, { details: { limit: fromUnits(limit, MONEY), this_call: fromUnits(o.cash, MONEY), date: o.day } });
    }
    return { reason: null };
  }
  if (o.before + o.cash < limit) return { reason: null };
  const reason = o.reason == null ? '' : o.reason.trim();
  if (o.mayOverride && reason.length > 0) return { reason };
  const who = o.mayOverride
    ? 'Give the reason in cash_override_reason (at least 10 characters) to save it.'
    : 'Only the owner can enter this payment, with a reason.';
  throw new JvError('JV_CASH_LIMIT', `Cash from this customer on one day would reach the limit of ₹${inRupees(limit)}. ${who}`, {
    details: { limit: fromUnits(limit, MONEY), cash_today: fromUnits(o.before, MONEY), this_call: fromUnits(o.cash, MONEY), date: o.day },
  });
}

/** Z3: the bill asks for a PAN: a named customer with none and a grand total of the threshold or more. The walk-in never holds a PAN (D10) and is refused instead (refuseWalkinBill). */
export function needsPanPrompt(o: { walkin: boolean; pan: string | null; grand: bigint }, threshold: bigint = PAN_THRESHOLD_PAISE): boolean {
  return !o.walkin && o.pan === null && o.grand >= threshold;
}

/** Z2: X1 refuses a bill of the PAN threshold or more for the walk-in (JV_NOT_ALLOWED, "Select or create the customer"). */
export function refuseWalkinBill(o: { walkin: boolean; grand: bigint }, threshold: bigint = PAN_THRESHOLD_PAISE): void {
  if (o.walkin && o.grand >= threshold) {
    throw new JvError('JV_NOT_ALLOWED', WALKIN_MESSAGE, { details: { field: 'customer_id' } });
  }
}

// ------------------------------------------------------------------ the reading

/**
 * Z1: `cash_today` of a named customer for one business date, paise: the active `money` receipts of mode Cash and the active `fine_cash` receipts dated `day`, not opening rows, refunds neither
 * counted nor subtracted. One plain SELECT on (customer_id, paid_on); the caller holds the customer lock.
 */
export async function cashToday(db: Reader, customerId: string, day: string): Promise<bigint> {
  const [found] = await db.rows<{ total: string | null }>(
    "SELECT SUM(amount) AS total FROM receipts WHERE customer_id = ? AND paid_on = ? AND status = 'active' AND is_opening = 0 AND ((kind = 'money' AND mode = 'Cash') OR kind = 'fine_cash')",
    [customerId, day],
  );
  return found?.total == null ? 0n : toUnits(String(found.total), MONEY);
}

export interface CashRulesInput {
  customerId: string;
  walkin: boolean;
  /** the business date the receipts of this call are dated (`paid_on`, the bill date for the payment rows of a bill) */
  day: string;
  /** the Cash (X1, X2) or fine_cash (X3) this call adds, paise; 0 when there is none */
  cash: bigint;
  /** the caller's role, to ask the matrix for the owner's field right */
  role: string;
  reason: string | null | undefined;
}

/**
 * Z1 and Z2 for one call: reads the day's cash only when it matters (a named customer, some cash in the call), then decides. Call it after the customer is locked and BEFORE the first write; it
 * returns the reason to store on the bill or the receipt (null when none was needed).
 */
export async function applyCashRules(db: Reader, o: CashRulesInput, limit: bigint = CASH_LIMIT_PAISE): Promise<CashVerdict> {
  const before = o.walkin || o.cash <= 0n ? 0n : await cashToday(db, o.customerId, o.day);
  return judgeCash({ walkin: o.walkin, day: o.day, cash: o.cash, before, mayOverride: mayUseField(o.role, 'cash_override_reason'), reason: o.reason }, limit);
}
