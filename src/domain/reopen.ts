// What a void (X4) or a cancel (X5, and X10 which cancels the old bill) leaves behind, in memory: the state of the customer AS THE CHANGE LEAVES IT, worked out from the state the function read ONCE
// before the test hook (X0 item 8, src/db/state.ts). The rebalance of Y6 that follows allocates from this copy and reads nothing again: a re-read after the hook would hide a missing customer lock.
//
//   X4  the receipt leaves the active receipts. The bills its live allocations paid get that money (and silver) back as PENDING, so they are open bills again (S3 gave their figures with the
//       receipt still counted). The customer's money advance falls by what the receipt had left (`amount` minus its live allocations), a refund that is voided GIVES its amount back to the advance
//       (Y10), and silver kinds move the fine figures the same way.
//   X5  the bill leaves the active bills and every allocation to it is released. The ACTIVE receipts that had spent money (or silver) on it get it back (S4 gave their figures with the
//       allocation still counted), so they are open receipts again; the advance grows by that money. Allocations of voided receipts are released too (I3, K3) but never counted, so they move nothing.
//
// The result is exact, not approximate: tests/api/reopen.test.ts makes the change by SQL on 60 random customers and compares this copy with a fresh state read, field by field and in the SAME ORDER
// (S1 and S2 sort by date, stamp and then the id in MariaDB's UUID order, which is why `uuidOrder` is here). Fields that cannot be worked out without reading again (`last_purchase`, the
// customer's `updated_at`) are left as they were; the rebalance reads only `advance` and `fine_advance` of the totals, and the rest is kept right so that a reader of the copy is not misled.
import type { BillFigures, CustomerState, CustomerTotals, OpenBill, OpenReceipt } from '../db/state.js';
import { JvError } from '../errors.js';
import { fromUnits, toUnits } from './rebalance.js';

const MONEY = 2;
const FINE = 3;
const bug = (what: string): never => {
  throw new JvError('JV_INTERNAL', 'Something unexpected went wrong.', { cause: new Error(what) });
};

// ------------------------------------------------------------------ the order of S1 and S2

/**
 * The order MariaDB gives the UUID type, which is NOT the order of the text: the five groups are compared from the right, the last one first (`00000001-0000-4000-8000-000000000000` comes before
 * `00000000-0000-4000-8000-000000000001`). Measured against the server on 4,500 ids in tests/api/reopen.test.ts. S1 and S2 end their ORDER BY with `id`, so two rows that tie on date and stamp
 * (an import writes many rows at one instant) are in this order, and a row put into the list in memory must land where the database would have put it.
 */
export function uuidOrder(a: string, b: string): number {
  const x = a.split('-').reverse();
  const y = b.split('-').reverse();
  for (let i = 0; i < x.length && i < y.length; i += 1) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}

/** A stamp as text with six decimals, whether or not the prepared protocol left the zero fraction out. */
function stampKey(s: string): string {
  const [whole, fraction = ''] = s.split('.');
  return `${whole}.${fraction.padEnd(6, '0')}`;
}

function byKey(a: readonly [string, string, string], b: readonly [string, string, string]): number {
  if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1;
  if (a[1] !== b[1]) return a[1] < b[1] ? -1 : 1;
  return uuidOrder(a[2], b[2]);
}

/** S1: (bill_date, created_at, id). */
export const billBefore = (a: OpenBill, b: OpenBill): number => byKey([a.bill_date, stampKey(a.created_at), a.id], [b.bill_date, stampKey(b.created_at), b.id]);
/** S2: (paid_on, created_at, id). */
export const receiptBefore = (a: OpenReceipt, b: OpenReceipt): number => byKey([a.paid_on, stampKey(a.created_at), a.id], [b.paid_on, stampKey(b.created_at), b.id]);

/** The list with `changed` put in: a row with the same id is replaced, a row that `open` says is no longer open is dropped, the rest keep the order of the database. */
function mergeOrdered<T extends { id: string }>(list: readonly T[], changed: readonly T[], isOpen: (x: T) => boolean, before: (a: T, b: T) => number): T[] {
  if (changed.length === 0) return [...list];
  const ids = new Set(changed.map((c) => c.id));
  const out = list.filter((x) => !ids.has(x.id));
  for (const c of changed) if (isOpen(c)) out.push(c);
  return out.sort(before); // a total order (the id ends it), so a plain sort gives the database's order
}

const billIsOpen = (b: OpenBill): boolean => toUnits(b.pending, MONEY) > 0n || toUnits(b.fine_pending, FINE) > 0n;
const receiptIsOpen = (r: OpenReceipt): boolean => (r.kind === 'money' && toUnits(r.remaining, MONEY) > 0n) || (r.kind !== 'money' && r.kind !== 'refund' && toUnits(r.fine_remaining, FINE) > 0n);

const plus = (text: string, delta: bigint, scale: number): string => fromUnits(toUnits(text, scale) + delta, scale);

// ------------------------------------------------------------------ X4: a receipt is voided

/** The receipt being voided, as the table holds it. */
export interface VoidedReceipt {
  id: string;
  kind: string;
  amount: string;
  fine_grams: string;
}

/** What the receipt's live allocations gave one bill (their sum for that bill). */
export interface Share {
  bill_id: string;
  amount: string;
  fine_grams: string;
}

/** The state after the void of `receipt`; `state` was read with `reopen: { receiptId }` (S3 = `billsOfReceipt`), `shares` are the receipt's live allocations summed for each bill. */
export function stateAfterVoid(state: CustomerState, receipt: VoidedReceipt, shares: readonly Share[]): CustomerState {
  const named = new Map(state.billsOfReceipt.map((b) => [b.id, b]));
  const reopened: OpenBill[] = shares.map((s) => {
    const b = named.get(s.bill_id) ?? bug(`the receipt ${receipt.id} has a live allocation to bill ${s.bill_id}, which the state read of X4 did not return`);
    const m = toUnits(s.amount, MONEY);
    const f = toUnits(s.fine_grams, FINE);
    return { ...b, received: plus(b.received, -m, MONEY), pending: plus(b.pending, m, MONEY), fine_settled: plus(b.fine_settled, -f, FINE), fine_pending: plus(b.fine_pending, f, FINE) };
  });
  const spent = shares.reduce((n, s) => n + toUnits(s.amount, MONEY), 0n);
  const spentFine = shares.reduce((n, s) => n + toUnits(s.fine_grams, FINE), 0n);
  const amount = toUnits(receipt.amount, MONEY);
  const grams = toUnits(receipt.fine_grams, FINE);
  const t: CustomerTotals = { ...state.totals };
  if (receipt.kind === 'money') {
    // V2: received - allocated - refunded; the receipt's own `amount - spent` was the part of the advance it held
    t.received = plus(t.received, -amount, MONEY);
    t.allocated = plus(t.allocated, -spent, MONEY);
    t.outstanding = plus(t.outstanding, spent, MONEY);
    t.advance = plus(t.advance, spent - amount, MONEY);
    t.balance = plus(t.balance, amount, MONEY);
  } else if (receipt.kind === 'refund') {
    t.refunded = plus(t.refunded, -amount, MONEY);
    t.advance = plus(t.advance, amount, MONEY);
    t.balance = plus(t.balance, -amount, MONEY);
  } else {
    t.fine_received = plus(t.fine_received, -grams, FINE);
    t.fine_allocated = plus(t.fine_allocated, -spentFine, FINE);
    t.fine_outstanding = plus(t.fine_outstanding, spentFine, FINE);
    t.fine_advance = plus(t.fine_advance, spentFine - grams, FINE);
    t.fine_balance = plus(t.fine_balance, grams, FINE);
  }
  return {
    ...state,
    openBills: mergeOrdered(state.openBills, reopened, billIsOpen, billBefore),
    openReceipts: state.openReceipts.filter((r) => r.id !== receipt.id),
    totals: t,
  };
}

// ------------------------------------------------------------------ X5: a bill is cancelled

/** One open allocation of the bill being cancelled (any receipt, active or voided). */
export interface Release {
  receipt_id: string;
  amount: string;
  fine_grams: string;
}

/** The state after the cancel of `bill`; `state` was read with `reopen: { billId }` (V1 = `bill`, S4 = `receiptsOfBill`), `releases` are ALL the open allocations of the bill. */
export function stateAfterCancel(state: CustomerState, bill: BillFigures, releases: readonly Release[]): CustomerState {
  const active = new Map(state.receiptsOfBill.map((r) => [r.id, r]));
  const back = new Map<string, { m: bigint; f: bigint }>();
  for (const r of releases) {
    if (!active.has(r.receipt_id)) continue; // a voided receipt: its allocation is released but it never counted
    const got = back.get(r.receipt_id) ?? { m: 0n, f: 0n };
    got.m += toUnits(r.amount, MONEY);
    got.f += toUnits(r.fine_grams, FINE);
    back.set(r.receipt_id, got);
  }
  const reopened: OpenReceipt[] = [...back].map(([id, x]) => {
    const r = active.get(id) as OpenReceipt;
    return { ...r, used: plus(r.used, -x.m, MONEY), fine_used: plus(r.fine_used, -x.f, FINE), remaining: plus(r.remaining, x.m, MONEY), fine_remaining: plus(r.fine_remaining, x.f, FINE) };
  });
  let money = 0n;
  let fine = 0n;
  for (const x of back.values()) {
    money += x.m;
    fine += x.f;
  }
  const grand = toUnits(bill.grand_total, MONEY);
  const due = toUnits(bill.fine_due, FINE);
  const t: CustomerTotals = { ...state.totals };
  t.billed = plus(t.billed, -grand, MONEY);
  if (bill.doc_type !== 'opening_balance') t.total_purchases = plus(t.total_purchases, -grand, MONEY);
  t.allocated = plus(t.allocated, -money, MONEY);
  t.outstanding = plus(t.outstanding, money - grand, MONEY);
  t.advance = plus(t.advance, money, MONEY);
  t.balance = plus(t.balance, -grand, MONEY);
  t.fine_billed = plus(t.fine_billed, -due, FINE);
  t.fine_allocated = plus(t.fine_allocated, -fine, FINE);
  t.fine_outstanding = plus(t.fine_outstanding, fine - due, FINE);
  t.fine_advance = plus(t.fine_advance, fine, FINE);
  t.fine_balance = plus(t.fine_balance, -due, FINE);
  return {
    ...state,
    openBills: state.openBills.filter((b) => b.id !== bill.id),
    openReceipts: mergeOrdered(state.openReceipts, reopened, receiptIsOpen, receiptBefore),
    totals: t,
  };
}
