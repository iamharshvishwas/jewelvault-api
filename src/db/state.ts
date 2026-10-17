// X0 item 8: the state read of every money function (X1 to X5, X10 to X12) and of the customer archive. Taken ONCE, right after the customer lock and before anything is allocated; the function
// allocates from what it read here and does not read again (a re-read after the test hook would hide a missing lock).
//
//   - the bills with something pending, oldest first as Y3 asks (S1), and the active receipts with something left, oldest first as Y6 asks (S2): by correlated sub-selects, never a join to a
//     grouped derived table (V1, RM5-1; the walk-in customer collects every anonymous sale for ever, and one payment took 120 to 230 ms with the lock held at 10,000 bills);
//   - the customer's totals of the same moment (V2 for one customer);
//   - PLUS what the change itself re-opens, which "only what is open" misses (it gave wrong books at the first void, cancel or re-issue in 6 of 6 review sequences):
//       X4  `reopen: { receiptId }`  the bills that the receipt's live allocations point to (S3), whether or not they are open now;
//       X5 and X10  `reopen: { billId }`  the bill itself (V1) and the receipts that have live allocations to it (S4), though those receipts are spent.
//
// THE TEST HOOK of X0 item 8 is the return of readCustomerState: in the test build tests/api/x0-support.ts wraps this export and holds the session at `<fn>.after_read` until the test releases its
// gate; `readCustomerTotals` is the same for the customer archive (`archive_customer.after_check`). Nothing in this file or anywhere in src/ knows about the hook, so the production bundle has
// none (T-D29). `fn` names the service function (create_bill, record_payment, void_receipt, ...) so that the point has a name.
//
// Money, weights and dates come back as the database prints them (DECIMAL as text, DATE and DATETIME as text); the caller parses them with parseRupees / parseGrams. A DATETIME(6) with a zero
// fraction comes back without its fraction over the prepared protocol: format it with timestampToWire before it leaves the API.
import { JvError } from '../errors.js';
import { billSummaryFigures } from '../sync/derived.js';
import { UUID_TEXT } from '../wire/format.js';
import { S1_TEXT, S2_TEXT, S3_TEXT, S4_TEXT, V2_ONE_TEXT } from './stateQueries.js';
import type { Reader } from './tx.js';

export { S1_TEXT, S2_TEXT, S3_TEXT, S4_TEXT, V2_ONE_TEXT };

/** A row of S1 or S3: a bill with its figures. received/pending are money, fine_* are silver in grams. */
export interface OpenBill {
  id: string;
  bill_no: string;
  customer_id: string;
  bill_date: string;
  created_at: string;
  grand_total: string;
  fine_weight_due: string;
  received: string;
  pending: string;
  fine_settled: string;
  fine_pending: string;
}

/** A row of S2 or S4: a receipt with what has been applied and what is left (money for a money receipt, grams for a silver one). */
export interface OpenReceipt {
  id: string;
  customer_id: string;
  kind: string;
  paid_on: string;
  created_at: string;
  amount: string;
  fine_grams: string;
  used: string;
  fine_used: string;
  remaining: string;
  fine_remaining: string;
}

/** V2 for one customer. */
export interface CustomerTotals {
  id: string;
  billed: string;
  total_purchases: string;
  received: string;
  refunded: string;
  allocated: string;
  outstanding: string;
  advance: string;
  balance: string;
  fine_billed: string;
  fine_received: string;
  fine_allocated: string;
  fine_outstanding: string;
  fine_advance: string;
  fine_balance: string;
  last_purchase: string | null;
  updated_at: string;
}

/** V1 for one bill (the bill X5 and X10 are about). */
export interface BillFigures {
  id: string;
  bill_no: string;
  customer_id: string;
  bill_date: string;
  doc_type: string;
  sale_type: string;
  status: string;
  reissue_of: string | null;
  grand_total: string;
  received: string;
  pending: string;
  fine_due: string;
  fine_settled: string;
  fine_pending: string;
  payment_status: string;
  item_count: number;
  created_at: string;
  updated_at: string;
}

export interface StateOptions {
  /** The service function reading: create_bill, record_payment, void_receipt, cancel_bill, reissue_bill, ... (it names the hook point of the test build). */
  fn: string;
  customerId: string;
  /** X4: the receipt being voided. X5 and X10: the bill being cancelled (X10: the old bill). At most one. */
  reopen?: { receiptId: string } | { billId: string };
}

export interface CustomerState {
  customerId: string;
  /** S1: bills with money or silver pending, oldest first (bill_date, created_at, id). */
  openBills: OpenBill[];
  /** S2: active receipts with money or silver left, oldest first (paid_on, created_at, id). */
  openReceipts: OpenReceipt[];
  /** V2 for the customer, of the same moment. */
  totals: CustomerTotals;
  /** X4: S3, the bills the receipt's live allocations point to (open or not). Empty otherwise. */
  billsOfReceipt: OpenBill[];
  /** X5 and X10: V1 of the bill, or null when no bill was named. */
  bill: BillFigures | null;
  /** X5 and X10: S4, the receipts with live allocations to the bill (spent or not). Empty otherwise. */
  receiptsOfBill: OpenReceipt[];
}

const FN_NAME = /^[a-z][a-z0-9_]{0,39}$/;
function check(fn: unknown, ...ids: [string, unknown][]): void {
  if (typeof fn !== 'string' || !FN_NAME.test(fn)) throw new TypeError('the state read needs the name of the service function: lower-case letters, digits and underscores');
  for (const [what, id] of ids) if (typeof id !== 'string' || !UUID_TEXT.test(id)) throw new TypeError(`the ${what} must be a lower-case uuid`);
}

async function totalsOf(r: Reader, customerId: string): Promise<CustomerTotals> {
  const [row] = await r.rows<CustomerTotals>(V2_ONE_TEXT, [customerId]);
  if (!row) throw new JvError('JV_INTERNAL', 'Something unexpected went wrong.', { cause: new Error('the customer whose totals were asked for is not there: the caller has locked it') });
  return row;
}

/** The totals of one customer (V2): the check of the customer archive reads them after the lock and before the archive (`archive_customer.after_check` in the test build). */
export async function readCustomerTotals(r: Reader, o: { fn: string; customerId: string }): Promise<CustomerTotals> {
  check(o.fn, ['customer id', o.customerId]);
  return totalsOf(r, o.customerId);
}

/** The state read of X0 item 8, with what the change re-opens. See the header. */
export async function readCustomerState(r: Reader, o: StateOptions): Promise<CustomerState> {
  const receiptId = o.reopen !== undefined && 'receiptId' in o.reopen ? o.reopen.receiptId : undefined;
  const billId = o.reopen !== undefined && 'billId' in o.reopen ? o.reopen.billId : undefined;
  if (o.reopen !== undefined && receiptId !== undefined && billId !== undefined) throw new TypeError('re-open a receipt (X4) or a bill (X5, X10), not both');
  check(o.fn, ['customer id', o.customerId], ...(receiptId !== undefined ? ([['receipt id', receiptId]] as [string, unknown][]) : []), ...(billId !== undefined ? ([['bill id', billId]] as [string, unknown][]) : []));

  const openBills = await r.rows<OpenBill>(S1_TEXT, [o.customerId]);
  const openReceipts = await r.rows<OpenReceipt>(S2_TEXT, [o.customerId]);
  const totals = await totalsOf(r, o.customerId);
  const billsOfReceipt = receiptId !== undefined ? await r.rows<OpenBill>(S3_TEXT, [receiptId]) : [];
  const bill = billId !== undefined ? ((await r.rows<BillFigures>(billSummaryFigures(1), [billId]))[0] ?? null) : null;
  const receiptsOfBill = billId !== undefined ? await r.rows<OpenReceipt>(S4_TEXT, [billId]) : [];
  return { customerId: o.customerId, openBills, openReceipts, totals, billsOfReceipt, bill, receiptsOfBill };
}
