// The one place that inserts a row of `receipts` (D13): X1 for the payment rows of a bill, X2 for a payment, X3 for a fine settled (API24), X10 for the new payments of a re-issue. It inserts the row,
// reads it back as the table holds it and writes the audit row of mechanism (b) of L1 (a no-op in mode triggers, whose triggers write their own), and returns the row for the answer.
//
// The caller holds the customer lock, has taken its ONE clock reading (`at`: every stamp of the call, C4) and has decided everything else; the CHECK of D13 (`chk_receipts_kind`) stands behind the
// columns. A money receipt: kind 'money', a mode of the five, amount above 0, no grams, no silver rate. `cashOverrideReason` is the owner's reason for cash over the limit (Z1), stored only when the
// override was needed.
import { type AuditedRow, auditChange } from '../db/audit.js';
import { newId } from '../db/ids.js';
import type { Tx } from '../db/tx.js';
import { type Row, readRow } from '../edit/engine.js';

const RECEIPT_INSERT =
  'INSERT INTO receipts (id, customer_id, kind, mode, amount, fine_grams, silver_rate, paid_on, reference, notes, is_opening, cash_override_reason, status, created_at, updated_at, created_by, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';

export interface ReceiptToInsert {
  /** a fresh id; made here when absent */
  id?: string;
  customerId: string;
  kind: 'money' | 'fine_cash' | 'fine_silver' | 'refund';
  mode: string | null;
  /** money text with 2 decimals */
  amount: string;
  /** grams text with 3 decimals */
  fineGrams: string;
  silverRate: string | null;
  /** the business date (YYYY-MM-DD) */
  paidOn: string;
  reference: string | null;
  notes: string | null;
  cashOverrideReason: string | null;
  /** the call's clock reading, 'YYYY-MM-DD HH:MM:SS.ffffff' */
  at: string;
  /** the user who makes it */
  by: string;
}

/** Inserts one active, non-opening receipt and audits it. Returns the row as the table holds it (every column). */
export async function insertReceipt(tx: Tx, r: ReceiptToInsert): Promise<Row> {
  const id = r.id ?? newId();
  await tx.run(RECEIPT_INSERT, [
    id, r.customerId, r.kind, r.mode, r.amount, r.fineGrams, r.silverRate, r.paidOn, r.reference, r.notes, 0, r.cashOverrideReason, 'active', r.at, r.at, r.by, r.by,
  ]);
  const row = await readRow(tx, 'receipts', id, false);
  if (!row) throw new Error('the receipt is gone after its own insert');
  await auditChange(tx, { table: 'receipts', action: 'insert', before: null, after: row as AuditedRow });
  return row;
}
