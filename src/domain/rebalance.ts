// Y3, Y6, Y9, K5, I10, IM4: the rebalance. After any function that changes a customer's bills or receipts, the customer's ADVANCE is applied to their oldest pending bills, oldest receipt first, and
// unallocated silver grams the same way. It never changes an existing allocation (it only adds rows), it applies in total at most the customer's advance of V2 (money received - live allocations -
// refunds, so money that was handed back is never spent a second time; silver: received - live allocations), and afterwards a customer has an advance only if no bill is pending (I10). Bills of every
// kind take part, opening bills included: they are the oldest by construction (Y9, D15). The walk-in customer is never rebalanced (K5): one row stands for strangers whose money must not pay each
// other's bills.
//
// THIS IS THE TYPESCRIPT COPY of scripts/rebalance.mjs `rebalanceCustomer` (MB04), the one function the import and X12's database half call. src/ cannot import scripts/*.mjs (tsconfig.build.json
// compiles src alone), so the rule is written twice, with one difference of kind and no difference of result: the script reads S1, S2 and V2_one itself on a bare connection; this copy allocates
// from the STATE the money function read once (X0 item 8, src/db/state.ts `readCustomerState`) and reads nothing again, because a re-read after the test hook would hide a missing customer lock.
// tests/api/rebalance-lib.test.ts runs both on 300 random customers and compares the allocations; a change to the rule is made in both files or that test fails.
//
// What the caller hands over, besides the state: what the call itself made AFTER it read the state. X1 inserts its bill after the hook, so the bill is not in the state's open bills: pass it as
// `newBills` (the bill, with what is pending on it after the call's own explicit payments) and it is placed in the order of Y3 by (bill_date, created_at); X10 passes the new bill and names it `first`,
// so that the money and silver the cancelled bill had received go to it before any other bill (Y3 with a named bill). A receipt the call made (X2, X3) is passed as `newReceipts` with what is left
// on it after the call's own allocation; its remainder is money the customer now holds, so it adds to what may be applied. Nothing is read from the database here.
//
// Under the customer lock, in a transaction (X0): the rows are written after every lock and every number has been taken (the writes come last), stamped from the call's one clock reading `at`
// (C4), audited in mechanism (b) of L1 (a no-op in mode triggers), and the bills that received money and the customer are touched (D23), so that a polling screen sees the new figures.
import { auditChange } from '../db/audit.js';
import { newId } from '../db/ids.js';
import { LockOrderViolation, lockedCustomerId } from '../db/locks.js';
import type { CustomerState } from '../db/state.js';
import type { Param } from '../db/stmt.js';
import { touchForReceiptWrite } from '../db/touch.js';
import type { Tx } from '../db/tx.js';
import { JvError } from '../errors.js';
import { UUID_TEXT } from '../wire/format.js';

const MONEY = 2;
const FINE = 3;

// ------------------------------------------------------------------ exact units (the script's twins)

/** '123.45' -> 12345n (scale 2). A value with more decimals than the scale is an error: MariaDB would round it silently. */
export function toUnits(text: string, scale: number): bigint {
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(String(text).trim());
  if (!m) throw new Error(`not a decimal number: ${JSON.stringify(text)}`);
  const frac = m[3] ?? '';
  if (frac.length > scale) throw new Error(`${JSON.stringify(text)} has more than ${scale} decimals`);
  const n = BigInt(m[2] + frac.padEnd(scale, '0'));
  return m[1] === '-' ? -n : n;
}

/** 12345n at scale 2 -> '123.45'. */
export function fromUnits(units: bigint, scale: number): string {
  const neg = units < 0n;
  const s = (neg ? -units : units).toString().padStart(scale + 1, '0');
  return `${neg ? '-' : ''}${s.slice(0, s.length - scale)}.${s.slice(s.length - scale)}`;
}

const min = (...xs: bigint[]): bigint => xs.reduce((a, b) => (a < b ? a : b));

// ------------------------------------------------------------------ the plan: pure, no database

/** A bill with something pending, in the order of Y3. `pending` is money (2 decimals), `fine_pending` silver grams (3 decimals), both as the database prints them. */
export interface PlanBill {
  id: string;
  pending: string;
  fine_pending: string;
}

/** An active receipt with something left, in the order of Y6. A money receipt has `remaining`; a silver one (`fine_silver`, `fine_cash`) has `fine_remaining`. */
export interface PlanReceipt {
  id: string;
  kind: string;
  remaining: string;
  fine_remaining: string;
}

export interface PlanInput {
  bills: readonly PlanBill[];
  receipts: readonly PlanReceipt[];
  /** the most money that may be applied in all: V2 `advance` (plus what a receipt made by the call adds) */
  advance: string;
  /** the most silver grams that may be applied in all: V2 `fine_advance` */
  fine_advance: string;
  /** Y3: the bill the caller names goes first. A name that is not among the pending bills changes nothing (the caller has checked it, API22). */
  first?: string | null;
}

export interface PlannedAllocation {
  id: string;
  receipt_id: string;
  bill_id: string;
  /** money, '0.00' for a silver allocation */
  amount: string;
  /** silver grams, '0.000' for a money allocation (chk_allocations_one_kind: never both) */
  fine_grams: string;
}

export interface Plan {
  allocations: PlannedAllocation[];
  /** total money applied */
  applied: string;
  /** total silver applied, grams */
  fine_applied: string;
}

/**
 * The rule of Y6 over lists already in order: each receipt in turn (oldest first) pays the bills in order, each bill taking the smaller of what the receipt has left, what is pending on it and what is
 * left of the advance. Money and silver are two passes, money first. The same arithmetic, in the same order, as `rebalanceCustomer` of scripts/rebalance.mjs.
 */
export function planRebalance(input: PlanInput, makeId: () => string = newId): Plan {
  let bills = input.bills.map((b) => ({ id: b.id, money: toUnits(b.pending, MONEY), fine: toUnits(b.fine_pending, FINE) }));
  if (input.first) {
    const at = bills.findIndex((b) => b.id === input.first);
    if (at > 0) bills = [bills[at], ...bills.slice(0, at), ...bills.slice(at + 1)];
  }
  const moneyReceipts: { id: string; rem: bigint }[] = [];
  const fineReceipts: { id: string; rem: bigint }[] = [];
  for (const r of input.receipts) {
    if (r.kind === 'money') {
      const rem = toUnits(r.remaining, MONEY);
      if (rem > 0n) moneyReceipts.push({ id: r.id, rem });
    } else {
      const rem = toUnits(r.fine_remaining, FINE);
      if (rem > 0n) fineReceipts.push({ id: r.id, rem });
    }
  }

  const allocations: PlannedAllocation[] = [];
  const apply = (list: { id: string; rem: bigint }[], key: 'money' | 'fine', cap: bigint): bigint => {
    let capacity = cap;
    let total = 0n;
    for (const r of list) {
      for (const b of bills) {
        if (capacity <= 0n) return total;
        if (r.rem <= 0n) break;
        if (b[key] <= 0n) continue;
        const take = min(r.rem, b[key], capacity);
        r.rem -= take;
        b[key] -= take;
        capacity -= take;
        total += take;
        allocations.push({
          id: makeId(),
          receipt_id: r.id,
          bill_id: b.id,
          amount: fromUnits(key === 'money' ? take : 0n, MONEY),
          fine_grams: fromUnits(key === 'fine' ? take : 0n, FINE),
        });
      }
    }
    return total;
  };
  const applied = apply(moneyReceipts, 'money', toUnits(input.advance, MONEY));
  const fineApplied = apply(fineReceipts, 'fine', toUnits(input.fine_advance, FINE));
  return { allocations, applied: fromUnits(applied, MONEY), fine_applied: fromUnits(fineApplied, FINE) };
}

// ------------------------------------------------------------------ what the call made after it read the state

/** A bill the call inserted after the state read. Its place in the order of Y3 is (bill_date, then created_at); a bill with nothing pending takes no part. */
export interface NewBill {
  id: string;
  bill_date: string;
  created_at: string;
  /** what is pending on it after the call's own explicit payments (money, 2 decimals) */
  pending: string;
  /** silver grams pending on it (3 decimals) */
  fine_pending: string;
}

/** A receipt the call inserted after the state read; `remaining` or `fine_remaining` is what is left of it after the call's own allocation. Its place is (paid_on, then created_at). */
export interface NewReceipt {
  id: string;
  kind: string;
  paid_on: string;
  created_at: string;
  remaining: string;
  fine_remaining: string;
}

// ------------------------------------------------------------------ the rebalance on the transaction

export interface RebalanceOptions {
  customerId: string;
  /** K5: `is_walkin` of the customer row the caller locked */
  walkin: boolean;
  /** the state read ONCE by this call (X0 item 8) */
  state: CustomerState;
  /** the call's one clock reading, `app.clock.read().timestamp`: 'YYYY-MM-DD HH:MM:SS.ffffff' */
  at: string;
  first?: string | null;
  newBills?: readonly NewBill[];
  newReceipts?: readonly NewReceipt[];
}

/** A row of receipt_allocations as the table holds it after the insert (and as the audit row of mechanism (b) shows it). */
export interface AllocationRow {
  id: string;
  receipt_id: string;
  bill_id: string;
  customer_id: string;
  amount: string;
  fine_grams: string;
  released_at: null;
  created_at: string;
  updated_at: string;
}

export interface RebalanceResult {
  allocations: AllocationRow[];
  applied: string;
  fine_applied: string;
}

const STAMP = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}$/;
const ROWS_PER_STATEMENT = 100;
const none = (): RebalanceResult => ({ allocations: [], applied: fromUnits(0n, MONEY), fine_applied: fromUnits(0n, FINE) });

/** A stamp as text with six decimals, whether or not the prepared protocol left the zero fraction out ('2026-10-01 05:00:00' is '2026-10-01 05:00:00.000000'). */
function stampKey(s: string): string {
  const [whole, fraction = ''] = s.split('.');
  return `${whole}.${fraction.padEnd(6, '0')}`;
}

/** Puts `item` into `list` (already in order) after every element whose key is not later than its own: a tie goes after the old rows, because the call's own row is the newest. */
function placeInOrder<T>(list: T[], item: T, key: (x: T) => readonly [string, string]): void {
  const [d, s] = key(item);
  let at = list.length;
  while (at > 0) {
    const [pd, ps] = key(list[at - 1]);
    if (pd < d || (pd === d && ps <= s)) break;
    at--;
  }
  list.splice(at, 0, item);
}

/**
 * The one place that writes allocation rows: 100 rows to a statement, then the audit row of each (L1 (b); a no-op in mode triggers, whose triggers write their own). The rebalance uses it, and so
 * do the money functions that allocate a receipt of their own before the rebalance (X2 record_payment; X3, and the payment rows of X1, later). The caller holds the customer lock, has checked that
 * each receipt and bill is the customer's (the composite keys of D14 refuse anything else), and touches the bills and the customer itself (D23: touchForReceiptWrite).
 */
export async function insertAllocations(tx: Tx, rows: readonly AllocationRow[]): Promise<void> {
  for (let from = 0; from < rows.length; from += ROWS_PER_STATEMENT) {
    const part = rows.slice(from, from + ROWS_PER_STATEMENT);
    const params: Param[] = part.flatMap((a) => [a.id, a.receipt_id, a.bill_id, a.customer_id, a.amount, a.fine_grams, a.created_at, a.updated_at]);
    await tx.run(`INSERT INTO receipt_allocations (id, receipt_id, bill_id, customer_id, amount, fine_grams, created_at, updated_at) VALUES ${part.map(() => '(?, ?, ?, ?, ?, ?, ?, ?)').join(', ')}`, params);
  }
  for (const row of rows) await auditChange(tx, { table: 'receipt_allocations', action: 'insert', before: null, after: { ...row } });
}

/** The plan of a rebalance, made before anything is written: what `rebalance` would insert, and the ids of the bills the call itself inserted (they are not touched again, D23). */
export interface PlannedRebalance {
  plan: Plan;
  fresh: ReadonlySet<string>;
}

const noPlan = (): PlannedRebalance => ({ plan: { allocations: [], applied: fromUnits(0n, MONEY), fine_applied: fromUnits(0n, FINE) }, fresh: new Set() });

/**
 * The pure half of `rebalance`: the allocations of Y6 worked out from the state the call read and the rows it made, with no write and no clock. A call that has to judge the result BEFORE its
 * first write (X10 counts what is carried over to the new bill against the explicit payments and refuses a surplus for the walk-in, and takes its number only after those checks) plans first and
 * applies with `applyRebalance` later; the allocation ids are made here, so the rows that were judged are the rows that are written. The walk-in gets an empty plan (K5).
 */
export function planRebalanceOf(o: Omit<RebalanceOptions, 'at'>): PlannedRebalance {
  if (o.state.customerId !== o.customerId) {
    throw new JvError('JV_INTERNAL', 'Something unexpected went wrong.', { cause: new Error('the state handed to the rebalance is another customer\'s') });
  }
  if (o.walkin) return noPlan(); // K5

  // the bills in the order of Y3: the state's (S1: bill_date, created_at, id) with the call's own bills placed in it
  const bills = o.state.openBills.map((b) => ({ id: b.id, bill_date: b.bill_date, created_at: b.created_at, pending: b.pending, fine_pending: b.fine_pending }));
  const fresh = new Set<string>();
  const bug = (what: string): never => {
    throw new JvError('JV_INTERNAL', 'Something unexpected went wrong.', { cause: new Error(what) });
  };
  for (const b of o.newBills ?? []) {
    if (bills.some((x) => x.id === b.id)) bug(`bill ${b.id} is handed over as new but the state already holds it: it would be counted twice (pass an adjusted copy of the state for a bill the call re-opened)`);
    fresh.add(b.id);
    if (toUnits(b.pending, MONEY) <= 0n && toUnits(b.fine_pending, FINE) <= 0n) continue;
    placeInOrder(bills, { id: b.id, bill_date: b.bill_date, created_at: b.created_at, pending: b.pending, fine_pending: b.fine_pending }, (x) => [x.bill_date, stampKey(x.created_at)]);
  }
  // the receipts in the order of Y6 (S2: paid_on, created_at, id), and what the call's own receipts add to what may be applied
  const receipts = o.state.openReceipts.map((r) => ({ id: r.id, kind: r.kind, paid_on: r.paid_on, created_at: r.created_at, remaining: r.remaining, fine_remaining: r.fine_remaining }));
  let advance = toUnits(o.state.totals.advance, MONEY);
  let fineAdvance = toUnits(o.state.totals.fine_advance, FINE);
  for (const r of o.newReceipts ?? []) {
    if (receipts.some((x) => x.id === r.id)) bug(`receipt ${r.id} is handed over as new but the state already holds it: it would be counted twice (pass an adjusted copy of the state for a receipt the call changed)`);
    const money = r.kind === 'money';
    const left = money ? toUnits(r.remaining, MONEY) : toUnits(r.fine_remaining, FINE);
    if (left <= 0n) continue;
    if (money) advance += left;
    else fineAdvance += left;
    placeInOrder(receipts, { id: r.id, kind: r.kind, paid_on: r.paid_on, created_at: r.created_at, remaining: r.remaining, fine_remaining: r.fine_remaining }, (x) => [x.paid_on, stampKey(x.created_at)]);
  }

  return { plan: planRebalance({ bills, receipts, advance: fromUnits(advance, MONEY), fine_advance: fromUnits(fineAdvance, FINE), first: o.first }, newId), fresh };
}

/** The write half of `rebalance`: inserts, audits and touches the allocations of a plan made by `planRebalanceOf`, all stamped `at`. A plan with no allocation sends nothing. */
export async function applyRebalance(tx: Tx, o: { customerId: string; at: string }, planned: PlannedRebalance): Promise<RebalanceResult> {
  if (!UUID_TEXT.test(o.customerId)) throw new TypeError('the customer id must be a lower-case uuid');
  if (!STAMP.test(o.at)) throw new TypeError("the stamp of a rebalance is the API clock's reading: 'YYYY-MM-DD HH:MM:SS.ffffff'");
  if (lockedCustomerId(tx) !== o.customerId) {
    throw new LockOrderViolation('the rebalance runs under the customer lock of the same customer (X0 item 3); this call has not locked that customer', tx.trail);
  }
  const { plan, fresh } = planned;
  if (plan.allocations.length === 0) return none();

  const rows: AllocationRow[] = plan.allocations.map((a) => ({ ...a, customer_id: o.customerId, released_at: null, created_at: o.at, updated_at: o.at }));
  await insertAllocations(tx, rows);
  // D23: the bills that received money or silver and the customer carry the call's stamp; a bill the call inserted already does
  await touchForReceiptWrite(tx, { customerId: o.customerId, billIds: rows.map((a) => a.bill_id).filter((id) => !fresh.has(id)), at: o.at });
  return { allocations: rows, applied: plan.applied, fine_applied: plan.fine_applied };
}

/**
 * Y6 inside a money function, after its own writes: allocates the customer's advance from `state` (and from what the call made, `newBills`, `newReceipts`), inserts the allocations, audits them and
 * touches what they changed. Returns the rows as the table holds them and the totals applied. A call that applies nothing sends nothing.
 */
export async function rebalance(tx: Tx, o: RebalanceOptions): Promise<RebalanceResult> {
  if (!UUID_TEXT.test(o.customerId)) throw new TypeError('the customer id must be a lower-case uuid');
  if (!STAMP.test(o.at)) throw new TypeError("the stamp of a rebalance is the API clock's reading: 'YYYY-MM-DD HH:MM:SS.ffffff'");
  if (lockedCustomerId(tx) !== o.customerId) {
    throw new LockOrderViolation('the rebalance runs under the customer lock of the same customer (X0 item 3); this call has not locked that customer', tx.trail);
  }
  return applyRebalance(tx, o, planRebalanceOf(o));
}
