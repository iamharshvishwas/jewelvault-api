// D23: touches, for polling. The screens poll by `updated_at` (C4), but a customer's balance changes when a row other than the customer's own changes. So the service function that inserts or updates
// `receipts` or `receipt_allocations` also sets `updated_at` (from the API clock) on the affected `bills` and on the customer, in the same transaction and under the customer lock it holds; a bill
// insert, and a change of a bill's status (a cancel, including a cancel with nothing allocated), does the same for the customer.
//
// A function reads the clock ONCE (`const now = app.clock.read()`) and passes `now.timestamp` as `at`: every stamp of the call is that one reading. A touch changes nothing but `updated_at` (not
// `updated_by`: nobody edited the row), and the audit step skips an update that changes nothing but `updated_at` (the triggers do, and so does src/db/audit.ts), so the touches add no audit noise.
// A trigger would also work but hides a lock, and a trigger cannot update its own table (error 1442), so the touch is code.
//
// A touch is made under the customer lock: without it, or for another customer than the locked one, it is a LockOrderViolation (a bug in the function). The bills are touched by primary key and
// must all be this customer's (a bill that is not is a bug: JV_INTERNAL, and the call is rolled back).
import { JvError } from '../errors.js';
import { UUID_TEXT } from '../wire/format.js';
import { LockOrderViolation, lockedCustomerId } from './locks.js';
import type { Tx } from './tx.js';

const STAMP = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}$/;

function check(tx: Tx, customerId: string, at: string): void {
  if (!UUID_TEXT.test(customerId)) throw new TypeError('the customer id must be a lower-case uuid');
  if (!STAMP.test(at)) throw new TypeError("a touch stamp is the API clock's reading: 'YYYY-MM-DD HH:MM:SS.ffffff'");
  if (lockedCustomerId(tx) !== customerId) throw new LockOrderViolation('a touch is made under the customer lock of the same customer (D23); this call has not locked that customer', tx.trail);
}

/** Sets `updated_at` on these bills of the customer (each once), by primary key. */
export async function touchBills(tx: Tx, customerId: string, billIds: readonly string[], at: string): Promise<void> {
  check(tx, customerId, at);
  const ids = [...new Set(billIds)];
  for (const id of ids) if (typeof id !== 'string' || !UUID_TEXT.test(id)) throw new TypeError('a bill id must be a lower-case uuid');
  if (ids.length === 0) return;
  const ok = await tx.run(`UPDATE bills SET updated_at = ? WHERE customer_id = ? AND id IN (${ids.map(() => '?').join(', ')})`, [at, customerId, ...ids]);
  if (ok.affectedRows !== ids.length) {
    throw new JvError('JV_INTERNAL', 'Something unexpected went wrong.', { cause: new Error(`a touch matched ${ok.affectedRows} of ${ids.length} bills: a bill named is not this customer's`) });
  }
}

/** Sets `updated_at` on the customer. */
export async function touchCustomer(tx: Tx, customerId: string, at: string): Promise<void> {
  check(tx, customerId, at);
  const ok = await tx.run('UPDATE customers SET updated_at = ? WHERE id = ?', [at, customerId]);
  if (ok.affectedRows !== 1) throw new JvError('JV_INTERNAL', 'Something unexpected went wrong.', { cause: new Error('the customer to touch is not there') });
}

/** A function that wrote receipts or allocations: the bills they apply to (or applied to, when released) and the customer. */
export async function touchForReceiptWrite(tx: Tx, o: { customerId: string; billIds: readonly string[]; at: string }): Promise<void> {
  await touchBills(tx, o.customerId, o.billIds, o.at);
  await touchCustomer(tx, o.customerId, o.at);
}

/** A function that inserted a bill or changed a bill's status (a cancel, with or without allocations): the customer. */
export async function touchForBillWrite(tx: Tx, o: { customerId: string; at: string }): Promise<void> {
  await touchCustomer(tx, o.customerId, o.at);
}
