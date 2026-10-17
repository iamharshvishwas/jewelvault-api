// X0 (spec lines 373 ff.), NODE-DESIGN 5.4: the lock order of every function that writes, as helpers, so that it does not rest on memory.
//
//   1. the idempotency claim (claim() in idempotency.ts)           first statement of the transaction
//   2. lockCustomer / lockCustomerOf                                the customer row FOR UPDATE, before anything about the customer's money is read   (item 3)
//   3. lockPieces                                                   the pieces, ONE statement `... WHERE id IN (...) ORDER BY id FOR UPDATE`          (item 5)
//   4. the checks (plain reads), then takeNumber() in numbers.ts    the number counter row LAST                                                        (item 6)
//   5. the writes, the touches (touch.ts), the audit rows (audit.ts), the stored result
// The contended locks all come before any row of the books is written ("stamped"): a lock that is waited for while a row lock is held is how a cycle starts.
//
// Every helper writes its step into `tx.trail` BEFORE it sends anything, and refuses a step that is out of order: LockOrderViolation. It is a bug in the code that called, never in the request: in a
// test it fails the test, in production it is answered JV_INTERNAL with nothing about the order in the answer (the detail is in the log). A deadlock re-run of the function starts with an empty trail.
//
// The pieces are locked by one statement and their ids are NEVER sorted in code: the native UUID type does not sort like its text (`00000001-0000-4000-8000-000000000000` comes BEFORE
// `00000000-0000-4000-8000-000000000001` in SQL, after it as text), so a helper that sorts in code and locks one piece at a time takes its locks in another order than a session that uses the
// one statement, and two such sessions deadlock. The trail cannot see that (it only sees steps), so T-C21 covers it.
//
// The test hook of X0 item 8 is NOT in this file or anywhere in src/: tests/api/x0-support.ts wraps readCustomerState (state.ts) in the test build, and the production bundle has no hook at all.
import { BusyError, JvError } from '../errors.js';
import { UUID_TEXT } from '../wire/format.js';
import type { Tx } from './tx.js';

/** The steps of NODE-DESIGN 5.3. `write` is any insert or update of a row of the books (not the claim, the counter or the audit log). */
export type LockStep = 'claim' | 'customer' | 'pieces' | 'counter' | 'write';

/** A step taken out of the order of X0. A bug in the code, answered JV_INTERNAL; the client is told nothing about it. */
export class LockOrderViolation extends JvError {
  /** What was wrong, for the log and the tests (never sent to the client). */
  readonly detail: string;
  /** The steps taken before the offending one. */
  readonly trail: readonly LockStep[];
  constructor(detail: string, trail: readonly LockStep[]) {
    super('JV_INTERNAL', 'Something unexpected went wrong.', { cause: new Error(`lock order of X0: ${detail} (steps so far: ${trail.join(', ') || 'none'})`) });
    this.name = 'LockOrderViolation';
    this.detail = detail;
    this.trail = [...trail];
  }
}

interface Held {
  customerId: string | null;
  piecesLocked: boolean;
}
const held = new WeakMap<Tx, Held>();
const heldOf = (tx: Tx): Held => {
  let h = held.get(tx);
  if (!h) held.set(tx, (h = { customerId: null, piecesLocked: false }));
  return h;
};

/** The customer this call has locked, or null. */
export function lockedCustomerId(tx: Tx): string | null {
  return heldOf(tx).customerId;
}

/**
 * Writes `step` into the trail after checking that it may come now. Throws LockOrderViolation (and writes nothing) when it may not. `customerId` goes with the customer step: a function locks one
 * customer. The same customer again is fine (X4, X5 and X10 find it first and lock it, and a helper may be called twice for it); so is the counter again (the look-ahead over imported numbers).
 */
export function noteStep(tx: Tx, step: LockStep, customerId?: string): void {
  const trail = tx.trail;
  const h = heldOf(tx);
  const fail = (detail: string): never => {
    throw new LockOrderViolation(detail, trail);
  };
  const has = (s: LockStep) => trail.includes(s);
  switch (step) {
    case 'claim':
      if (trail.length > 0) fail('the claim must be the first statement of the transaction (X0 item 1); it came after other steps');
      break;
    case 'customer':
      if (has('counter')) fail('the customer lock was taken after the number counter (the counter is last, X0 item 6)');
      if (has('pieces')) fail('the customer lock was taken after the pieces (the customer comes first, X0 item 3)');
      if (has('write')) fail('the customer lock was taken after a write: a row had already been stamped (the locks come before the writes)');
      if (h.customerId !== null && h.customerId !== customerId) fail('a second customer was locked: a function locks one customer');
      break;
    case 'pieces':
      if (has('counter')) fail('the pieces were locked after the number counter (the counter is last, X0 item 6)');
      if (has('write')) fail('the pieces were locked after a write: a row had already been stamped (the locks come before the writes)');
      if (h.piecesLocked) fail('the pieces are locked by one statement (X0 item 5); they were locked twice');
      break;
    case 'counter':
    case 'write':
      break;
  }
  if (step === 'customer') h.customerId = customerId ?? h.customerId;
  if (step === 'pieces') h.piecesLocked = true;
  if (trail[trail.length - 1] !== step) trail.push(step);
}

/** The tables of the books: an insert or update of any other table than these three is a "write" for the order of the locks. */
const BOOKKEEPING = new Set(['sys_idempotency', 'sys_counters', 'audit_log']);
const WRITE = /^\s*(?:INSERT\s+(?:IGNORE\s+)?INTO|UPDATE)\s+`?([A-Za-z0-9_]+)`?/i;

/** Called by Tx.run after every change statement: a row of the books has been written, and no contended lock may follow. */
export function noteWrite(tx: Tx, sql: string): void {
  const m = WRITE.exec(sql);
  if (m && !BOOKKEEPING.has(m[1].toLowerCase())) noteStep(tx, 'write');
}

const notUuid = (what: string) => new TypeError(`${what} must be a lower-case uuid`);

// ------------------------------------------------------------------ item 3: the customer

/** What the functions need to know about the customer they have locked: archived, walk-in, the PAN of the cash and PAN rules. */
export interface CustomerLockRow {
  id: string;
  name: string;
  mobile: string | null;
  customer_type: string;
  gst_number: string | null;
  pan: string | null;
  /** 0 or 1 */
  is_walkin: number;
  archived_at: string | null;
}

const CUSTOMER_LOCK_SQL = 'SELECT id, name, mobile, customer_type, gst_number, pan, is_walkin, archived_at FROM customers WHERE id = ? FOR UPDATE';

/**
 * The customer row FOR UPDATE: the first thing every function that reads or changes a customer's bills, receipts or allocations does after the claim (X1, X2, X3, X11, X12; X4, X5 and X10 use
 * lockCustomerOf). Returns null when there is no such customer; the caller answers as its own rules say (a body id that does not exist is its 422, a path id its 404).
 */
export async function lockCustomer(tx: Tx, customerId: string): Promise<CustomerLockRow | null> {
  if (!UUID_TEXT.test(customerId)) throw notUuid('the customer id');
  noteStep(tx, 'customer', customerId);
  const rows = await tx.rows<CustomerLockRow>(CUSTOMER_LOCK_SQL, [customerId]);
  return rows[0] ?? null;
}

/** A receipt or a bill as the database has it: the head is typed, every other column is there too. */
export interface LockedRow {
  id: string;
  customer_id: string;
  status: string;
  [column: string]: unknown;
}

const FIND_CUSTOMER_SQL = {
  receipts: 'SELECT customer_id FROM receipts WHERE id = ?',
  bills: 'SELECT customer_id FROM bills WHERE id = ?',
} as const;
const REREAD_SQL = {
  receipts: 'SELECT * FROM receipts WHERE id = ? FOR UPDATE',
  bills: 'SELECT * FROM bills WHERE id = ? FOR UPDATE',
} as const;

/**
 * X0 item 3 for X4 (a receipt), X5 and X10 (a bill): the customer is found by reading the row WITHOUT a lock, then locked, then the row is read again FOR UPDATE and must belong to the SAME customer.
 * The customer of a receipt or a bill never changes, so that is the only comparison; the status and `updated_at` are read again after the lock and decided on then (a second void of one receipt
 * is JV_ALREADY_VOID, a void beside a cancel JV_BILL_CANCELLED, never a false JV_BUSY: a review run saw 7 false JV_BUSY in 4,800 attempts when `updated_at` was the comparison). A different
 * customer rolls the call back with JV_BUSY (reason customer_changed). Returns null when there is no such row (the caller answers 404).
 */
export async function lockCustomerOf(tx: Tx, table: 'receipts' | 'bills', id: string): Promise<{ customer: CustomerLockRow; row: LockedRow } | null> {
  if (!UUID_TEXT.test(id)) throw notUuid(`the ${table === 'receipts' ? 'receipt' : 'bill'} id`);
  const found = await tx.rows<{ customer_id: string }>(FIND_CUSTOMER_SQL[table], [id]);
  if (found.length === 0) return null;
  const customerId = found[0].customer_id;
  const customer = await lockCustomer(tx, customerId);
  if (!customer) throw new JvError('JV_INTERNAL', 'Something unexpected went wrong.', { cause: new Error(`${table} ${id} names a customer that is not there (the foreign key should make that impossible)`) });
  const again = await tx.rows<LockedRow>(REREAD_SQL[table], [id]);
  if (again.length === 0 || again[0].customer_id !== customerId) {
    throw new BusyError('customer_changed', { cause: new Error(`${table} ${id} belongs to another customer after the lock than before it`) });
  }
  return { customer, row: again[0] };
}

// ------------------------------------------------------------------ item 5: the pieces

/** The columns of a piece that the money functions and the stock functions decide on, as the database has them (money and weight as text). */
export interface PieceLockRow {
  id: string;
  design_id: string;
  sku_no: string;
  barcode: string;
  status: string;
  sold_bill_id: string | null;
  gross_weight: string;
  customer_net_weight: string;
  stones: number;
  stone_weight: string;
  kundan: number;
  kundan_weight: string;
  piroi: string;
  labour_retail: string;
  labour_semi: string;
  labour_wholesale: string;
  location: string | null;
  archived_at: string | null;
  updated_at: string;
}

const PIECE_COLUMNS =
  'id, design_id, sku_no, barcode, status, sold_bill_id, gross_weight, customer_net_weight, stones, stone_weight, kundan, kundan_weight, piroi, labour_retail, labour_semi, labour_wholesale, location, archived_at, updated_at';
const MAX_PIECES = 5000;

/**
 * Locks the pieces by ONE statement, `SELECT ... FROM skus WHERE id IN (...) ORDER BY id FOR UPDATE`, so that InnoDB takes the locks in primary-key order (X0 item 5). The rows come back in the
 * database's order. The ids are never sorted here and never locked one at a time. X10 passes the old bill's pieces and the new lines' pieces together; a piece named twice is locked once. A piece
 * that does not exist is simply not in the answer (the caller refuses it). An empty list sends nothing and takes no step.
 */
export async function lockPieces(tx: Tx, ids: readonly string[]): Promise<PieceLockRow[]> {
  const unique = [...new Set(ids)]; // the order of the input is kept; MariaDB's ORDER BY decides the order of the locks
  for (const id of unique) if (typeof id !== 'string' || !UUID_TEXT.test(id)) throw notUuid('a piece id');
  if (unique.length === 0) return [];
  if (unique.length > MAX_PIECES) throw new TypeError(`at most ${MAX_PIECES} pieces are locked in one call`);
  noteStep(tx, 'pieces');
  return tx.rows<PieceLockRow>(`SELECT ${PIECE_COLUMNS} FROM skus WHERE id IN (${unique.map(() => '?').join(', ')}) ORDER BY id FOR UPDATE`, unique);
}
