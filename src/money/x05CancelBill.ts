// X5 cancel_bill (POST /v1/bills/:id/cancel, 200 {bill, skus, released_allocations, allocations}), X5, K3, K5, IM5, I1, I3, D11, D23, L1, L5, X0, T-B10, T-B16, T-B17, T-C13.
//
// A bill is CANCELLED, never deleted (S7): the bill keeps its row and its lines, becomes `cancelled` with the reason, the time, the business day (`cancelled_on`, D11) and the person, and leaves every
// total (V1 shows pending 0, V2 does not add it). K3: each piece whose `sold_bill_id` is this bill returns to `In Stock`; every open allocation of the bill gets `released_at` (also those of VOIDED
// receipts: they never counted, but I3 says no allocation that is not released points to a cancelled bill); the RECEIPTS STAY ACTIVE, because the money was received, so the customer holds an
// advance, which the rebalance of Y6 applies to their other pending bills or leaves as credit. Handing the money back is X11. An opening-balance bill may be cancelled (IM5): it has no pieces.
//
//   path     the bill (`p_bill_id`): a lower-case UUID, else 422 on `id`; no such bill is 404 JV_NOT_FOUND.
//   body     reason (3 to 500 characters once trimmed). Nothing else.
//   header   Idempotency-Key.
//   answer   200 {bill, skus, released_allocations, allocations}: `bill` as it is now, `skus` the pieces that returned to stock, `released_allocations` the allocations that were released (every
//            open one) and, besides the three of NODE-DESIGN 4.3, `allocations`: the rows the REBALANCE made with the money the cancel freed (Y6), so the screen can say where it went.
//
// THE RULES. The bill must be active, else JV_BILL_CANCELLED (409). For the WALK-IN a bill with live allocations (money or silver received that still counts) is refused with JV_NOT_ALLOWED (K5: void its
// receipts first, so that the money going back shows on its own day): one row stands for strangers, so the walk-in never holds an advance. A customer who is archived (K4) is refused with
// JV_CUSTOMER_ARCHIVED, as every money function is.
//
// ORDER OF WORK (X0). The route wrapper has already refused everything it can without a database. Then ONE transaction:
//   1. the claim of the key (L5, the first statement), the role check again (X0 item 2), the stored answer if the key is a repeat;
//   2. the customer is found from the bill WITHOUT a lock, locked, and the bill is read again FOR UPDATE and must be the SAME customer's (X0 item 3): a second cancel of one bill is JV_BILL_CANCELLED,
//      never a false JV_BUSY. Then ONE reading of the API clock: `cancelled_at` and `cancelled_on` are that one instant (S5, D11), and so is every stamp of the call;
//   3. the bill's open allocations and its lines (plain reads under the customer lock), then the state of the customer, read ONCE (X0 item 8: `x05.after_read` of the test build; V1 of the bill and
//      the receipts with live allocations to it, S4, are in it). Nothing below reads the books again: the state AFTER the cancel is worked out in memory (src/domain/reopen.ts);
//   4. the pieces, locked by ONE statement in MariaDB's id order (X0 item 5), after the customer and before any write; the checks;
//   5. the writes, all stamped by the one reading: the bill, the allocations, the pieces BY THE IDS ALREADY LOCKED (never `WHERE sold_bill_id = ?`), the audit rows (L1 b), the touch of the customer
//      (D23), then the rebalance (its allocations, audit rows and touches);
//   6. the answer is stored in the claim row, in the same transaction.
// No number is taken. A failure anywhere rolls everything back, the claim included.
//
// FOR X10 (reissue_bill): it cancels the old bill the same way inside its own transaction, with ONE lock statement over the old bill's pieces and the new lines' pieces. So the reads
// (`readBillToCancel`) and the writes (`writeCancel`, which is handed the pieces that are already locked) are functions of their own, and the pure part is `stateAfterCancel`.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { type AuditedRow, auditChange } from '../db/audit.js';
import { claim, idempotencyKey, markReplay, storeResult } from '../db/idempotency.js';
import { type LockedRow, type PieceLockRow, lockCustomerOf, lockPieces } from '../db/locks.js';
import { readCustomerState } from '../db/state.js';
import { touchForBillWrite } from '../db/touch.js';
import { type Tx, txContextFor, withTx } from '../db/tx.js';
import { rebalance, toUnits } from '../domain/rebalance.js';
import { stateAfterCancel } from '../domain/reopen.js';
import { type Row, notFound, readRow, wireRow } from '../edit/engine.js';
import { JvError, unavailableError } from '../errors.js';
import { columnsOfTable } from '../permissions/matrix.js';
import { type Auth, assertMayCall, route } from '../permissions/route.js';
import * as wire from '../wire/zod.js';
import { reasonText } from './reason.js';

// ------------------------------------------------------------------ the body

export const cancelBillBody = wire.strictObject({ reason: reasonText });
export type CancelBillBody = z.output<typeof cancelBillBody>;

// ------------------------------------------------------------------ the answer

export interface CancelBillResult {
  bill: Row;
  /** the pieces that returned to stock (K3), as the sync read gives them */
  skus: Row[];
  /** every allocation that was released: all the bill's open ones, also those of voided receipts */
  released_allocations: Row[];
  /** the rows the rebalance made with the money the cancel freed (Y6): not in NODE-DESIGN 4.3, added so that the screen can say where it went */
  allocations: Row[];
}

const ACTION = 'fn:cancel_bill';
const ROUTE_NAME = 'POST /v1/bills/:id/cancel';

function contextOf(app: FastifyInstance, request: FastifyRequest, auth: Auth) {
  if (!app.db) throw unavailableError();
  return txContextFor(app.db, request, { id: auth.user.id, role: auth.user.role });
}

const columnList = (table: string): string => columnsOfTable(table).map((c) => `\`${c}\``).join(', ');
const marks = (n: number): string => Array.from({ length: n }, () => '?').join(', ');
const internal = (what: string): JvError => new JvError('JV_INTERNAL', 'Something unexpected went wrong.', { cause: new Error(what) });

// ------------------------------------------------------------------ the reads and the writes of a cancel (X10 reuses them)

export interface BillToCancel {
  /** every open allocation of the bill (released_at is NULL), whatever the status of its receipt, as the table holds it */
  open: Row[];
  /** the piece of each line, in the order of the lines */
  skuIds: string[];
}

/** The plain reads of a cancel, under the customer lock and before the state read (and so before the test hook). The lines of a bill never change, so they need no lock of their own. */
export async function readBillToCancel(tx: Tx, bill: { id: string; customer_id: string }): Promise<BillToCancel> {
  const open = await tx.rows<Row>(`SELECT ${columnList('receipt_allocations')} FROM receipt_allocations WHERE bill_id = ? AND customer_id = ? AND released_at IS NULL ORDER BY created_at, id`, [bill.id, bill.customer_id]);
  const lines = await tx.rows<{ sku_id: string }>('SELECT sku_id FROM bill_items WHERE bill_id = ? ORDER BY line_no', [bill.id]);
  return { open, skuIds: lines.map((l) => l.sku_id) };
}

export interface CancelWritten {
  /** the bill as the table holds it now */
  bill: Row;
  /** the pieces that went back to stock, as the table holds them now, in MariaDB's id order (the order of the lock statement) */
  skus: Row[];
  /** the allocations that were released, as the table holds them now */
  released: Row[];
}

/**
 * The writes of K3, stamped by the call's one clock reading (`at`, and `day` its business date): the bill becomes cancelled, every open allocation of the bill is released, the pieces locked for this
 * call whose `sold_bill_id` is this bill return to In Stock BY THE IDS ALREADY LOCKED (never by `WHERE sold_bill_id = ?`, which would take locks the order of X0 did not plan), the audit rows of L1 (b)
 * and the touch of the customer (D23). The caller has locked the customer and `pieces` (after the state read, before this), and has checked that the bill is active.
 */
export async function writeCancel(tx: Tx, o: { bill: LockedRow; open: readonly Row[]; pieces: readonly PieceLockRow[]; reason: string; at: string; day: string; by: string }): Promise<CancelWritten> {
  const billId = o.bill.id;
  const customerId = o.bill.customer_id;
  const back = o.pieces.filter((p) => p.sold_bill_id === billId).map((p) => p.id);
  const skusBefore = back.length > 0 ? await tx.rows<Row>(`SELECT ${columnList('skus')} FROM skus WHERE id IN (${marks(back.length)}) ORDER BY id`, back) : [];

  const cancelled = await tx.run('UPDATE bills SET status = ?, cancel_reason = ?, cancelled_at = ?, cancelled_on = ?, cancelled_by = ?, updated_at = ?, updated_by = ? WHERE id = ? AND status = ?', [
    'cancelled', o.reason, o.at, o.day, o.by, o.at, o.by, billId, 'active',
  ]);
  if (cancelled.affectedRows !== 1) throw internal(`the cancel of bill ${billId} changed ${cancelled.affectedRows} rows`);

  if (o.open.length > 0) {
    const released = await tx.run('UPDATE receipt_allocations SET released_at = ?, updated_at = ? WHERE bill_id = ? AND customer_id = ? AND released_at IS NULL', [o.at, o.at, billId, customerId]);
    if (released.affectedRows !== o.open.length) throw internal(`the cancel of bill ${billId} released ${released.affectedRows} of ${o.open.length} allocations`);
  }
  if (back.length > 0) {
    const returned = await tx.run(`UPDATE skus SET status = ?, sold_bill_id = NULL, updated_at = ?, updated_by = ? WHERE id IN (${marks(back.length)}) AND sold_bill_id = ? AND status = ?`, [
      'In Stock', o.at, o.by, ...back, billId, 'Sold',
    ]);
    if (returned.affectedRows !== back.length) throw internal(`the cancel of bill ${billId} returned ${returned.affectedRows} of ${back.length} locked pieces`);
  }
  await touchForBillWrite(tx, { customerId, at: o.at }); // D23: the customer's figures changed (the bill itself carries the stamp already)

  // the rows as the tables hold them now. Only the columns the statements above set can differ from what was read, so the rows after are the rows before with those set.
  const bill = await readRow(tx, 'bills', billId, false);
  if (!bill) throw new Error('the bill is gone after its own update');
  const released = o.open.map((r) => ({ ...r, released_at: o.at, updated_at: o.at }));
  const skus = skusBefore.map((r) => ({ ...r, status: 'In Stock', sold_bill_id: null, updated_at: o.at, updated_by: o.by }));

  // L1 (b): the audit rows in the order of the writes, bill, allocations, pieces (a no-op in mode triggers, whose triggers wrote theirs)
  await auditChange(tx, { table: 'bills', action: 'update', before: o.bill as AuditedRow, after: bill as AuditedRow });
  for (let i = 0; i < o.open.length; i += 1) await auditChange(tx, { table: 'receipt_allocations', action: 'update', before: o.open[i] as AuditedRow, after: released[i] as AuditedRow });
  for (let i = 0; i < skusBefore.length; i += 1) await auditChange(tx, { table: 'skus', action: 'update', before: skusBefore[i] as AuditedRow, after: skus[i] as AuditedRow });

  return { bill, skus, released };
}

// ------------------------------------------------------------------ the function

/** X5. `key` is the Idempotency-Key as idempotencyKey() read it, `billId` the id in the path. Returns the answer and whether it is the stored answer of an earlier call with the same key. */
export async function cancelBill(
  app: FastifyInstance,
  request: FastifyRequest,
  auth: Auth,
  key: string,
  billId: string,
  input: CancelBillBody,
): Promise<{ value: CancelBillResult; replayed: boolean }> {
  const role = auth.user.role;
  const by = auth.user.id;
  const ctx = contextOf(app, request, auth);

  return withTx(ctx, async (tx) => {
    // 1. the claim, the role check, a repeat of the key
    const c = await claim(tx, { key, fn: 'cancel_bill', route: ROUTE_NAME, pathIds: { id: billId }, body: input });
    assertMayCall(role, ACTION); // X0 item 2: after the claim, whose row the rollback removes when this refuses
    if (!c.first) return { value: c.result as CancelBillResult, replayed: true };

    // 2. the customer from the bill, locked, the bill read again FOR UPDATE (the same customer, or JV_BUSY); everything else is decided now, after the lock
    const found = await lockCustomerOf(tx, 'bills', billId);
    if (!found) throw notFound();
    const { customer, row: bill } = found;
    if (bill.status !== 'active') throw new JvError('JV_BILL_CANCELLED', 'This bill has already been cancelled.', { details: { bill_id: billId } });
    if (customer.archived_at !== null) throw new JvError('JV_CUSTOMER_ARCHIVED', 'This customer is archived. Bring the customer back before cancelling a bill.', { details: { customer_id: customer.id } });
    const now = app.clock.read(); // ONE reading: cancelled_at, cancelled_on and every stamp of the call
    const at = now.timestamp;
    const walkin = Number(customer.is_walkin) === 1;

    // 3. the plain reads, then the state of the customer, read ONCE (X0 item 8; the hook of the test build is the return of the state read)
    const toCancel = await readBillToCancel(tx, { id: billId, customer_id: customer.id });
    const state = await readCustomerState(tx, { fn: 'x05', customerId: customer.id, reopen: { billId } });
    const figures = state.bill;
    if (!figures) throw internal(`the state read of X5 did not return bill ${billId}`);

    // K5: the walk-in never holds an advance, so a bill of the walk-in that still has money or silver received on it is not cancelled until those receipts are voided
    if (walkin && (toUnits(figures.received, 2) > 0n || toUnits(figures.fine_settled, 3) > 0n)) {
      throw new JvError('JV_NOT_ALLOWED', 'This bill of the walk-in customer has money or silver received on it. Void those receipts first, with the reason, then cancel the bill.', {
        details: { reason: 'void_its_receipts_first', received: figures.received, fine_settled: figures.fine_settled },
      });
    }

    // 4. the pieces, ONE statement (X0 item 5), after the customer lock and before the first write
    const pieces = await lockPieces(tx, toCancel.skuIds);

    // the state as the cancel leaves it, in memory
    const adjusted = stateAfterCancel(state, figures, toCancel.open.map((r) => ({ receipt_id: String(r.receipt_id), amount: String(r.amount), fine_grams: String(r.fine_grams) })));

    // 5. the writes, then Y6: the money the cancel freed pays the other pending bills (the walk-in is never rebalanced, K5)
    const written = await writeCancel(tx, { bill, open: toCancel.open, pieces, reason: input.reason, at, day: now.date, by });
    const rebalanced = await rebalance(tx, { customerId: customer.id, walkin, state: adjusted, at });

    const value: CancelBillResult = {
      bill: wireRow('bills', role, written.bill),
      skus: written.skus.map((r) => wireRow('skus', role, r)),
      released_allocations: written.released.map((r) => wireRow('receipt_allocations', role, r)),
      allocations: rebalanced.allocations.map((a) => wireRow('receipt_allocations', role, { ...a })),
    };
    await storeResult(tx, c.key, value);
    return { value, replayed: false };
  });
}

/** Registers `fn:cancel_bill`. */
export function registerCancelBill(app: FastifyInstance): void {
  route(app, {
    action: ACTION,
    body: cancelBillBody,
    handler: async ({ app: a, request, reply, auth, body }) => {
      const { id } = wire.parseInput(wire.strictObject({ id: wire.uuid }), request.params); // the bill: a lower-case UUID in the path
      const key = idempotencyKey(request.headers); // before the transaction: a missing or malformed key claims nothing
      const { value, replayed } = await cancelBill(a, request, auth, key, id, body);
      markReplay(reply, replayed);
      return reply.code(200).send(value);
    },
  });
}
