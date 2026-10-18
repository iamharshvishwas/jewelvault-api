// X1 create_bill (POST /v1/bills, 201 {bill, items, receipts, allocations, warnings, advance_applied}), K2, R1 to R8, R10, R13, R14, Y2, Y5, Y6, Y8, Z1 to Z3, K5, L3, L4, L5, X0, T-A03, T-A06, T-A10, T-A12, T-A15, T-A17, T-B01, T-B03, T-B07, T-B17, T-B23, T-C04 to T-C06, T-C08.
//
//   body     customer_id, sale_type, bill_date (absent or null: today), items [sku_id, metal_rate, labour_rate, piroi, other_charges, quantity], discount, additional_charges, notes, payments
//            [mode, amount, reference] (a row of amount 0 is ignored), confirm_held [piece ids], cash_override_reason. The items, the sale type, the date and the two charges are the body of quote_bill (X7): ONE definition, so a quote and
//            a bill are asked in the same words. A weight is never an input: the net weight, the material, the purity and the method of a line are the PIECE's, read under the lock.
//   header   Idempotency-Key (a UUID the screen makes once for each save and reuses for a retry).
//   answer   201 {bill, items, receipts, allocations, warnings, advance_applied}: `bill` and `items` are the rows in the wire format of the sync read of the caller's role (so the cache applies them as
//            it applies a polled row), `warnings` holds PAN_MISSING, RATE_MISSING and RATE_STALE (unique, sorted). A repeat of the key answers the same body and status with `Idempotent-Replay: true`.
//
// THE PAYMENT ROWS (X1 (e) and (i), API23). `payments` are the money received with the bill: each row of an amount above 0 is one `money` receipt and one allocation to THIS bill, dated the bill date;
// a row of amount 0 is ignored. Together they may not exceed the grand total (JV_OVERPAYMENT, Y5). The Credit mode does not exist (D13, Y2): it is refused with the other words that are not one of the
// five modes. The cash rules of section 13 (src/domain/cashRules.ts) judge the Cash rows before the number is taken: a named customer's cash of the bill date reaching the limit is JV_CASH_LIMIT
// unless the owner gives `cash_override_reason`, which is then stored on the bill (Z1); for the walk-in a bill of the PAN threshold or more is refused (JV_NOT_ALLOWED) and so is a single cash
// payment at the limit (Z2); a named customer without a PAN gets the warning PAN_MISSING at the threshold (Z3). The rebalance of Y6 (j) comes AFTER the payment rows (API21,
// src/domain/rebalance.ts): an advance the customer holds is applied to what the rows leave pending, the new bill among the oldest, and `advance_applied` says how much of it went to THIS bill.
// `planPayments` and `writePayments` are exported for X10, which makes the new payments of a re-issue by the rules of X1.
//
// ORDER OF WORK (X1 and X0). Before the transaction: one reading of the API clock (`day`: the business date for Y8 and for a bill_date left out, and the year of the number series, S5), the prefix of the bill
// numbers (settings.estimate, NODE-DESIGN 5.5), and the counter row of the series (ensureSeries: a series made inside a transaction can deadlock, spike F3). Then, in one withTx:
//   1. the claim of the key (L5) and the role check (X0 items 1 and 2: a refusal rolls the claim back, so the key stays unused), then the stored answer if the key is a repeat;
//   2. the customer row FOR UPDATE (X0 item 3), then the validation of what needs no more reading (Y8, each piece once, the confirm list, the payments), then "the customer exists and is not archived";
//   3. the state of the customer, read once (X0 item 8, `create_bill.after_read` of the test build: the hook is a wrapper of the test build, not a line of this file); the rebalance (j) allocates
//      from it and reads nothing again;
//   4. the pieces by ONE statement, `... WHERE id IN (...) ORDER BY id FOR UPDATE` (X0 item 5), R10 (JV_PIECE_UNAVAILABLE naming the pieces), the plain reads of the designs, the daily rates and the settings,
//      the bill priced from the LOCKED rows and the rates sent (R1 to R8, R14) by buildQuote, the one function quote_bill also uses, with the bill's pricing version (R13); then the walk-in's bill
//      (Z2), the overpayment (Y5) and the cash rules with their plain read of the day's cash (Z1, Z2);
//   5. the number counter, LAST (X0 item 6), after every check;
//   6. the writes, all stamped from one reading of the API clock taken after the locks (C4: no row is stamped long before its commit): the bill, its lines with the snapshot and the list prices, the
//      conditional UPDATE of the pieces to Sold checked against the number of lines (K2, X1 (h): defence in depth), the touch of the customer (D23), the audit rows of mechanism (b) (L1), the
//      receipts of the payment rows and their allocations (i), and last the rebalance (j: Y6, the advance goes to the oldest pending bills; its allocations and touches carry the same stamp), so that
//      the audit log reads in the order of the writes in both mechanisms;
//   7. the result is stored in the claim row, in the same transaction.
// A failure anywhere rolls everything back, the claim and the counter included: no piece is Sold and no number is used.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { type AuditedRow, auditChange } from '../db/audit.js';
import { claim, idempotencyKey, markReplay, storeResult } from '../db/idempotency.js';
import { newId } from '../db/ids.js';
import { type CustomerLockRow, type PieceLockRow, lockCustomer, lockPieces } from '../db/locks.js';
import { billNumbers, ensureSeries, nextBillNo } from '../db/numbers.js';
import { readCustomerState } from '../db/state.js';
import type { Param } from '../db/stmt.js';
import { touchForBillWrite } from '../db/touch.js';
import { type Tx, txContextFor, withRead, withTx } from '../db/tx.js';
import { applyCashRules, needsPanPrompt, refuseWalkinBill } from '../domain/cashRules.js';
import { CURRENT_PRICING_VERSION } from '../domain/pricing.js';
import { type AllocationRow, fromUnits, insertAllocations, rebalance, toUnits } from '../domain/rebalance.js';
import { type Row, invalid, readRow, wireRow } from '../edit/engine.js';
import * as f from '../edit/fields.js';
import { BusyError, JvError, unavailableError } from '../errors.js';
import { limits } from '../limits.js';
import { columnsOfTable, mayUseField } from '../permissions/matrix.js';
import { type Auth, assertMayCall, route } from '../permissions/route.js';
import * as wire from '../wire/zod.js';
import { insertReceipt } from './receiptWrite.js';
import { type PieceRow, PRICING_VERSIONS, type Quote, type VersionTable, assertEachPieceOnce, buildQuote, checkBillDate, quoteBody, readEstimate, readRates } from './x07QuoteBill.js';

// ------------------------------------------------------------------ the body

/** D13: the five modes of a money receipt. There is no Credit: a bill that is not paid in full has no receipt for the rest (Y2). */
export const PAYMENT_MODES = ['Cash', 'UPI', 'Card', 'Bank Transfer', 'Other'] as const;
/** The most payment rows one bill takes: the spec gives no number, and a body of a megabyte must not make thousands of receipts. */
export const MAX_PAYMENTS = 10;
/** receipts.reference is VARCHAR(120); cash_override_reason is VARCHAR(500) and at least 10 characters (Z1). */
export const REFERENCE_MAX = 120;
const REASON_MIN = 10;
const REASON_MAX = 500;
const MONEY = 2;

const modeMessage = `must be one of ${PAYMENT_MODES.join(', ')}; there is no Credit: a bill that is not paid in full simply has no receipt for the rest`;
const reasonMessage = `must be ${REASON_MIN} to ${REASON_MAX} characters`;
const paymentsMessage = `must be a list of at most ${MAX_PAYMENTS} payments`;
const confirmMessage = `must be a list of at most ${limits.maxLines} piece ids`;

/** The mode of a money receipt and its amount (greater than 0): ONE definition for the payment rows of X1 and for X2 record_payment (D13, Y2, S4). */
export const paymentMode = z.enum(PAYMENT_MODES, { error: (issue) => (issue.input === undefined ? 'is required' : modeMessage) });
export const paymentAmount = wire.amount.check((ctx) => {
  if (!/[1-9]/.test(ctx.value)) ctx.issues.push({ code: 'custom', message: 'must be above 0', input: ctx.value });
});

/** A payment row of a bill: a row of amount 0 is well-formed and ignored (T-B03), so the amount is plain money text, not `paymentAmount`. */
const paymentRow = wire.strictObject({
  mode: paymentMode,
  amount: wire.amount,
  reference: (f.optionalText(REFERENCE_MAX).schema as z.ZodType<string | null>).optional(),
});

/** Z1: the reason the OWNER gives for cash over the limit, 10 to 500 characters (X1 and X2 take the same field). */
export const cashOverrideReason = z
  .string({ error: (issue) => (issue.input === undefined ? 'is required' : reasonMessage) })
  .trim()
  .min(REASON_MIN, reasonMessage)
  .max(REASON_MAX, reasonMessage)
  .nullish();

export const createBillBody = wire.strictObject({
  customer_id: wire.uuid,
  sale_type: quoteBody.shape.sale_type,
  bill_date: quoteBody.shape.bill_date,
  items: quoteBody.shape.items,
  discount: quoteBody.shape.discount,
  additional_charges: quoteBody.shape.additional_charges,
  notes: (f.optionalText(f.TEXT_MAX).schema as z.ZodType<string | null>).optional(),
  payments: z
    .array(paymentRow, { error: (issue) => (issue.input === undefined ? 'is required' : paymentsMessage) })
    .max(MAX_PAYMENTS, paymentsMessage)
    .optional(),
  confirm_held: z
    .array(wire.uuid, { error: (issue) => (issue.input === undefined ? 'is required' : confirmMessage) })
    .max(limits.maxLines, confirmMessage)
    .optional(),
  /** Z1: the owner's right (FIELD_RIGHTS), stored on the bill when the cash rule needed it; a biller who sends it is refused after the claim. */
  cash_override_reason: cashOverrideReason,
});
export type CreateBillBody = z.output<typeof createBillBody>;

// ------------------------------------------------------------------ the answer

export interface CreateBillResult {
  bill: Row;
  items: Row[];
  /** the money receipts of the payment rows, in the order sent (rows of amount 0 are left out) */
  receipts: Row[];
  /** the allocations the call made: those of the payment rows (in order) and those of the rebalance (the advance applied to the oldest pending bills, this bill among them) */
  allocations: Row[];
  warnings: string[];
  /** money from an advance the customer held that the rebalance applied to THIS bill ("Advance adjusted", O23), money text; "0.00" when there was none */
  advance_applied: string;
}

export interface CreateBillOptions {
  /** A seam for tests (T-A15): the version table. The application passes none and prices with PRICING_VERSIONS. */
  versions?: VersionTable;
  /** A seam for tests (T-A15): the version a new bill is priced with ("the current one", R13). The application passes none: version 1. */
  pricingVersion?: number;
}

// ------------------------------------------------------------------ rules that need no database rows

/** The pieces named in `confirm_held` must be pieces of this bill, each once. Returns them as a set. X10 takes the same list. */
export function confirmedPieces(input: Pick<CreateBillBody, 'items' | 'confirm_held'>): ReadonlySet<string> {
  const onBill = new Set(input.items.map((i) => i.sku_id));
  const seen = new Set<string>();
  (input.confirm_held ?? []).forEach((id, i) => {
    if (!onBill.has(id)) throw invalid(`confirm_held[${i}]`, 'is not a piece on this bill');
    if (seen.has(id)) throw invalid(`confirm_held[${i}]`, 'is listed twice');
    seen.add(id);
  });
  return seen;
}

/**
 * R10: an In Stock piece that is on no bill; a Reserved or On Approval piece only when the screen passed its id in the confirm list. Anything else never. `freed` is for X10: the pieces of the bill
 * being re-issued, which the cancel of K3 returns to In Stock in the same transaction (they are Sold on the old bill in the locked rows, which are read before that), so they are billable again.
 */
function isBillable(p: PieceLockRow, confirmed: ReadonlySet<string>, freed?: ReadonlySet<string>): boolean {
  if (freed?.has(p.id)) return true;
  if (p.sold_bill_id !== null) return false;
  if (p.status === 'In Stock') return true;
  return (p.status === 'Reserved' || p.status === 'On Approval') && confirmed.has(p.id);
}

const NAMED_PIECES = 5;
function piecesUnavailable(bad: readonly PieceLockRow[]): JvError {
  const shown = bad.slice(0, NAMED_PIECES).map((p) => `${p.sku_no} (${p.status})`);
  const more = bad.length > NAMED_PIECES ? ` and ${bad.length - NAMED_PIECES} more` : '';
  return new JvError('JV_PIECE_UNAVAILABLE', `These pieces cannot be billed: ${shown.join(', ')}${more}. Nothing was saved.`, {
    details: { sku_ids: bad.map((p) => p.id), pieces: bad.map((p) => ({ sku_id: p.id, sku_no: p.sku_no, status: p.status })) },
  });
}

// ------------------------------------------------------------------ reads and writes

const marks = (n: number): string => `(${Array.from({ length: n }, () => '?').join(', ')})`;
const columnList = (table: string): string => columnsOfTable(table).map((c) => `\`${c}\``).join(', ');

interface DesignRow {
  id: string;
  design_no: string;
  material: string;
  purity: string;
  selling_method: string;
  category: string;
}
const designsSql = (n: number) =>
  `SELECT d.id, d.design_no, d.material, d.purity, d.selling_method, c.name AS category FROM designs d JOIN categories c ON c.id = d.category_id WHERE d.id IN ${marks(n)}`;

const BILL_COLUMNS =
  'id, bill_no, customer_id, bill_date, doc_type, sale_type, status, pricing_version, subtotal, discount, additional_charges, gst_percent, gst_amount, grand_total, round_off, fine_weight_due, notes, cash_override_reason, request_id, created_at, updated_at, created_by, updated_by, reissue_of';
const LINE_COLUMNS =
  'id, bill_id, line_no, sku_id, design_no, sku_no, category, material, purity, selling_method, gross_weight, customer_net_weight, quantity, metal_rate, labour_rate, labour_amount, piroi, other_charges, metal_amount, fine_weight_due, item_total, tax_rate, tax_amount, list_metal_rate, list_labour_rate, created_at, updated_at';
const LINES_PER_STATEMENT = 100;

const readSkus = (tx: Tx, ids: readonly string[]): Promise<Row[]> => tx.rows<Row>(`SELECT ${columnList('skus')} FROM skus WHERE id IN ${marks(ids.length)}`, ids);

// ------------------------------------------------------------------ the payment rows (X1 (e) and (i))

/** One payment row that will be written: a mode, an amount above 0 in paise, a reference. */
export interface PaymentRowPlan {
  mode: string;
  amount: bigint;
  reference: string | null;
}

/** The rows that count, and what they add up to: all rows and the Cash rows alone (the cash rules judge the latter), in paise. */
export interface PaymentPlan {
  rows: PaymentRowPlan[];
  total: bigint;
  cash: bigint;
}

/**
 * X1 (e), Y5: the payment rows as they will be written. A row of amount 0 is ignored; the rest may not add up to more than the bill's grand total (`alreadyPaid` is what the bill has received
 * before these rows: X10 passes the money carried over from the cancelled bill), else JV_OVERPAYMENT and nothing has been written. Amounts are exact: text to paise, no float.
 */
export function planPayments(payments: readonly { mode: string; amount: string; reference?: string | null }[], grand: bigint, alreadyPaid: bigint = 0n): PaymentPlan {
  const rows: PaymentRowPlan[] = [];
  let total = 0n;
  let cash = 0n;
  for (const p of payments) {
    const amount = toUnits(p.amount, MONEY);
    if (amount <= 0n) continue;
    rows.push({ mode: p.mode, amount, reference: p.reference ?? null });
    total += amount;
    if (p.mode === 'Cash') cash += amount;
  }
  if (alreadyPaid + total > grand) {
    throw new JvError('JV_OVERPAYMENT', 'The payments are more than the total of the bill. Nothing was saved.', {
      details: { field: 'payments', grand_total: fromUnits(grand, MONEY), payments_total: fromUnits(total, MONEY) },
    });
  }
  return { rows, total, cash };
}

export interface WrittenPayments {
  /** the receipts as the table holds them, in the order of the rows */
  receipts: Row[];
  /** one allocation to the bill for each receipt, in the same order */
  allocations: AllocationRow[];
}

/**
 * X1 (i): one `money` receipt and one allocation to the new bill for each row of the plan, dated the bill date (the customer's lock is held and the bill exists). The receipts are inserted and audited
 * first, then the allocations in one statement, so that the audit log reads the same in both mechanisms of L1. The cash override reason of Z1 is on the bill, not on these receipts. The touch of
 * the customer was made with the bill (D23) and the bill is new, so nothing else needs a stamp.
 */
export async function writePayments(tx: Tx, o: { plan: PaymentPlan; customerId: string; billId: string; billDate: string; at: string; by: string }): Promise<WrittenPayments> {
  const receipts: Row[] = [];
  const allocations: AllocationRow[] = [];
  for (const p of o.plan.rows) {
    const receipt = await insertReceipt(tx, {
      customerId: o.customerId,
      kind: 'money',
      mode: p.mode,
      amount: fromUnits(p.amount, MONEY),
      fineGrams: '0.000',
      silverRate: null,
      paidOn: o.billDate,
      reference: p.reference,
      notes: null,
      cashOverrideReason: null,
      at: o.at,
      by: o.by,
    });
    receipts.push(receipt);
    allocations.push({
      id: newId(),
      receipt_id: String(receipt.id),
      bill_id: o.billId,
      customer_id: o.customerId,
      amount: fromUnits(p.amount, MONEY),
      fine_grams: '0.000',
      released_at: null,
      created_at: o.at,
      updated_at: o.at,
    });
  }
  await insertAllocations(tx, allocations);
  return { receipts, allocations };
}

// ------------------------------------------------------------------ pricing and writing a new bill (X1 and X10 share them)

/** The part of the body of X1 that prices a bill. X10 has the same keys (its body is X1's without `customer_id`, plus the reason). */
export type NewBillInput = Pick<CreateBillBody, 'sale_type' | 'items' | 'discount' | 'additional_charges'>;

export interface PricedNewBill {
  quote: Quote;
  /** the grand total in paise */
  grand: bigint;
  /** PAN_MISSING, RATE_MISSING, RATE_STALE */
  warnings: Set<string>;
  /** K5: the customer is the walk-in */
  walkin: boolean;
  /** the locked rows of the pieces on the new bill, by id */
  byId: Map<string, PieceLockRow>;
  designOf: (p: PieceLockRow) => DesignRow;
}

/**
 * X1 step 4 and the checks of step 5 that need no payment: with the customer and the pieces locked, R10 (JV_PIECE_UNAVAILABLE naming the pieces), the plain reads of the designs, the daily rates and
 * the settings, the bill priced from the LOCKED rows and the rates sent (R1 to R8, R14) by buildQuote, the walk-in's bill (Z2) and the PAN prompt (Z3). `locked` may hold more pieces than the bill's
 * (X10 locks the old bill's pieces and the new lines' together); only the pieces named by the items are judged and priced. Nothing is written and no number is taken.
 */
export async function priceNewBill(
  tx: Tx,
  o: { customer: CustomerLockRow; input: NewBillInput; billDate: string; locked: readonly PieceLockRow[]; confirmed: ReadonlySet<string>; freed?: ReadonlySet<string>; estimate: { prefix: string }; versions: VersionTable; version: number },
): Promise<PricedNewBill> {
  const locked = new Map(o.locked.map((p) => [p.id, p]));
  o.input.items.forEach((it, i) => {
    if (!locked.has(it.sku_id)) throw invalid(`items[${i}].sku_id`, 'is not a piece');
  });
  const billed = o.input.items.map((it) => locked.get(it.sku_id) as PieceLockRow);
  const byId = new Map(billed.map((p) => [p.id, p]));
  const bad = billed.filter((p) => !isBillable(p, o.confirmed, o.freed));
  if (bad.length > 0) throw piecesUnavailable(bad); // K2, R10, X1 (c)

  const designIds = [...new Set(billed.map((p) => p.design_id))];
  const designs = new Map((await tx.rows<DesignRow>(designsSql(designIds.length), designIds)).map((r) => [r.id, r]));
  const designOf = (p: PieceLockRow): DesignRow => {
    const found = designs.get(p.design_id);
    if (!found) throw new JvError('JV_INTERNAL', 'Something unexpected went wrong.', { cause: new Error(`the design of the locked piece ${p.id} is not there`) });
    return found;
  };
  const pieces = new Map<string, PieceRow>(
    billed.map((p) => {
      const dsg = designOf(p);
      return [p.id, { id: p.id, sku_no: p.sku_no, customer_net_weight: p.customer_net_weight, labour_retail: p.labour_retail, labour_semi: p.labour_semi, labour_wholesale: p.labour_wholesale, material: dsg.material, purity: dsg.purity, selling_method: dsg.selling_method }];
    }),
  );
  const rates = await readRates(tx, pieces.values(), o.billDate);
  const inside = await readEstimate(tx);
  if (inside.prefix !== o.estimate.prefix) throw new BusyError('series_changed', { cause: new Error('the bill prefix of settings.estimate changed after the counter row of its series was made') });
  // R1 to R8, R14: the one function quote_bill uses, on the locked rows and the rates sent; it refuses what pricing.ts refuses (a cap, a By Weight line without labour_rate, quantity 2 on a By Weight piece, a discount above the total)
  const quote = buildQuote({
    saleType: o.input.sale_type,
    billDate: o.billDate,
    version: o.version,
    versions: o.versions,
    items: o.input.items,
    discount: o.input.discount,
    additionalCharges: o.input.additional_charges,
    roundOff: inside.roundOff,
    pieces,
    rates,
  });

  const warnings = new Set<string>(quote.warnings);
  const grand = toUnits(quote.totals.grand_total, 2);
  const walkin = Number(o.customer.is_walkin) === 1;
  // Z2: the walk-in's bill of the PAN threshold or more is refused (JV_NOT_ALLOWED); Z3: a named customer without a PAN is only asked for it (a prompt, never a block)
  refuseWalkinBill({ walkin, grand });
  if (needsPanPrompt({ walkin, pan: o.customer.pan, grand })) warnings.add('PAN_MISSING');
  return { quote, grand, warnings, walkin, byId, designOf };
}

/**
 * X1 step 6 up to the audit rows: the bill and its lines (with the snapshot and the list prices), the conditional UPDATE of the pieces to Sold checked against the number of lines (K2, X1 (h):
 * defence in depth), the touch of the customer (D23) and the audit rows of mechanism (b). Everything is stamped `at`. `reissueOf` is the cancelled bill this one replaces (X10, K6), else null; `billId` is for X10, which names the bill before it writes it (the rebalance is planned with that name). The
 * caller holds the customer lock and the locks of the pieces, has taken the number and checked everything; X10 has cancelled the old bill just before, so its pieces are In Stock here.
 */
export async function writeNewBill(
  tx: Tx,
  o: { customerId: string; billDate: string; billNo: string; priced: PricedNewBill; notes: string | null | undefined; cashReason: string | null; requestId: string; reissueOf: string | null; at: string; by: string; billId?: string },
): Promise<{ billId: string; billRow: Row; lineRows: Row[] }> {
  const { quote, byId, designOf } = o.priced;
  const { at, by } = o;
  const ids = quote.lines.map((l) => l.sku_id);
  const billId = o.billId ?? newId();
  await tx.run(`INSERT INTO bills (${BILL_COLUMNS}) VALUES ${marks(24)}`, [
    billId, o.billNo, o.customerId, o.billDate, 'estimate', quote.sale_type, 'active', quote.pricing_version, quote.totals.subtotal, quote.totals.discount, quote.totals.additional_charges, '0.00', '0.00',
    quote.totals.grand_total, quote.totals.round_off, quote.totals.fine_weight_due, o.notes ?? null, o.cashReason, o.requestId, at, at, by, by, o.reissueOf,
  ]);
  for (let from = 0; from < quote.lines.length; from += LINES_PER_STATEMENT) {
    const chunk = quote.lines.slice(from, from + LINES_PER_STATEMENT);
    const params: Param[] = [];
    chunk.forEach((l, k) => {
      const list = quote.list_prices[from + k];
      const piece = byId.get(l.sku_id) as PieceLockRow;
      const dsg = designOf(piece);
      params.push(
        newId(), billId, l.line_no, l.sku_id, dsg.design_no, piece.sku_no, dsg.category, l.material, l.purity, l.selling_method, piece.gross_weight, l.customer_net_weight, l.quantity, l.metal_rate, l.labour_rate,
        l.labour_amount, l.piroi, l.other_charges, l.metal_amount, l.fine_weight_due, l.item_total, '0.00', '0.00', list.list_metal_rate, list.list_labour_rate, at, at,
      );
    });
    await tx.run(`INSERT INTO bill_items (${LINE_COLUMNS}) VALUES ${chunk.map(() => marks(27)).join(', ')}`, params);
  }
  // K2, X1 (h): the pieces become Sold, only if each is still billable and on no bill, and the row count must equal the number of lines
  const before = tx.auditMode === 'node' ? await readSkus(tx, ids) : [];
  const sold = await tx.run(`UPDATE skus SET status = ?, sold_bill_id = ?, updated_at = ?, updated_by = ? WHERE id IN ${marks(ids.length)} AND status IN (?, ?, ?) AND sold_bill_id IS NULL`, [
    'Sold', billId, at, by, ...ids, 'In Stock', 'Reserved', 'On Approval',
  ]);
  if (sold.affectedRows !== ids.length) {
    throw new JvError('JV_INTERNAL', 'Something unexpected went wrong.', { cause: new Error(`the conditional update to Sold changed ${sold.affectedRows} of ${ids.length} locked pieces`) });
  }
  await touchForBillWrite(tx, { customerId: o.customerId, at }); // D23: the customer's figures changed

  // the rows as the tables hold them: the audit rows of mechanism (b) (the triggers of (a) write their own) and the answer
  const billRow = await readRow(tx, 'bills', billId, false);
  if (!billRow) throw new Error('the bill is gone after its own insert');
  const lineRows = await tx.rows<Row>(`SELECT ${columnList('bill_items')} FROM bill_items WHERE bill_id = ? ORDER BY line_no`, [billId]);
  await auditChange(tx, { table: 'bills', action: 'insert', before: null, after: billRow as AuditedRow });
  for (const row of lineRows) await auditChange(tx, { table: 'bill_items', action: 'insert', before: null, after: row as AuditedRow });
  if (tx.auditMode === 'node') {
    const after = new Map((await readSkus(tx, ids)).map((r) => [String(r.id), r]));
    for (const old of before) await auditChange(tx, { table: 'skus', action: 'update', before: old as AuditedRow, after: after.get(String(old.id)) as AuditedRow });
  }
  return { billId, billRow, lineRows };
}

function contextOf(app: FastifyInstance, request: FastifyRequest, auth: Auth) {
  if (!app.db) throw unavailableError();
  return txContextFor(app.db, request, { id: auth.user.id, role: auth.user.role });
}

// ------------------------------------------------------------------ the function

/** X1. `key` is the Idempotency-Key as idempotencyKey() read it. Returns the answer and whether it is the stored answer of an earlier call with the same key. */
export async function createBill(app: FastifyInstance, request: FastifyRequest, auth: Auth, key: string, input: CreateBillBody, options: CreateBillOptions = {}): Promise<{ value: CreateBillResult; replayed: boolean }> {
  const role = auth.user.role;
  const versions = options.versions ?? PRICING_VERSIONS;
  const version = options.pricingVersion ?? CURRENT_PRICING_VERSION;
  if (!Object.hasOwn(versions, version)) throw new Error(`the bill is to be priced with version ${version}, which the version table does not hold`);
  const ctx = contextOf(app, request, auth);

  // before the transaction (L3): ONE reading of the clock for the business date and the year of the series, the prefix, and the counter row of the series
  const day = app.clock.read();
  const estimate = await withRead(ctx, (r) => readEstimate(r));
  const series = billNumbers(day, estimate.prefix);
  await ensureSeries(ctx, series.key);

  return withTx(ctx, async (tx) => {
    // 1. the claim, the role check, a repeat of the key
    const c = await claim(tx, { key, fn: 'create_bill', route: 'POST /v1/bills', body: input });
    assertMayCall(role, 'fn:create_bill'); // X0 item 2: after the claim, whose row the rollback removes when this refuses
    if (input.cash_override_reason != null && !mayUseField(role, 'cash_override_reason')) {
      throw new JvError('JV_FORBIDDEN', 'Only the owner can give a reason for cash over the limit.', { details: { field: 'cash_override_reason' } });
    }
    if (!c.first) return { value: c.result as CreateBillResult, replayed: true };

    // 2. the customer row FOR UPDATE, then X1 (a) and (b)
    const customer = await lockCustomer(tx, input.customer_id);
    const billDate = checkBillDate(input.bill_date, day.date, role); // Y8
    assertEachPieceOnce(input.items); // X1 (a): a piece twice is JV_INVALID_INPUT, never the duplicate-key error of UNIQUE (bill_id, sku_id)
    const confirmed = confirmedPieces(input);
    if (!customer) throw invalid('customer_id', 'is not a customer');
    if (customer.archived_at !== null) throw new JvError('JV_CUSTOMER_ARCHIVED', 'This customer is archived. Bring the customer back before billing.', { details: { customer_id: customer.id } });

    // 3. the state of the customer, read ONCE (X0 item 8). Rebalance (j) allocates from `state` and does not read again.
    const state = await readCustomerState(tx, { fn: 'create_bill', customerId: customer.id });

    // 4. the pieces in one statement, R10, the plain reads, the pricing, the walk-in's bill and the PAN prompt
    const ids = input.items.map((i) => i.sku_id);
    const locked = await lockPieces(tx, ids);
    const priced = await priceNewBill(tx, { customer, input, billDate, locked, confirmed, estimate, versions, version });
    const { quote, grand, warnings, walkin } = priced;

    // (e) the payment rows may not exceed the grand total (JV_OVERPAYMENT, Y5) and the cash rules of section 13 must pass (JV_CASH_LIMIT, Z1, Z2); the Cash rows are dated the bill date, so that is the day
    const payments = planPayments(input.payments ?? [], grand);
    const cash = await applyCashRules(tx, { customerId: customer.id, walkin, day: billDate, cash: payments.cash, role, reason: input.cash_override_reason });

    // 5. the number, last (X0 item 6)
    const issued = await nextBillNo(tx, series);

    // 6. the writes, stamped from one reading taken after the locks (C4)
    const at = app.clock.read().timestamp;
    const by = auth.user.id;
    const { billId, billRow, lineRows } = await writeNewBill(tx, { customerId: customer.id, billDate, billNo: issued.no, priced, notes: input.notes, cashReason: cash.reason, requestId: c.key, reissueOf: null, at, by });

    // (i) one `money` receipt and one allocation per payment row, dated the bill date. The new bill is handed to the rebalance with what is STILL pending on it, or an advance would be applied to
    // money the bill already has. The rows come BEFORE the rebalance (spec order i, j).
    const written = await writePayments(tx, { plan: payments, customerId: customer.id, billId, billDate, at, by });
    // (j) Y6: rebalance the customer, which applies any advance the customer holds, from `state` (read before the bill existed, so the bill is handed over: it is placed among the pending bills by
    // its date and its stamp). The walk-in is never rebalanced (K5).
    const rebalanced = await rebalance(tx, {
      customerId: customer.id,
      walkin,
      state,
      at,
      newBills: [{ id: billId, bill_date: billDate, created_at: at, pending: fromUnits(grand - payments.total, 2), fine_pending: quote.totals.fine_weight_due }],
    });
    const adjusted = rebalanced.allocations.filter((a) => a.bill_id === billId).reduce((sum, a) => sum + toUnits(a.amount, 2), 0n);

    const value: CreateBillResult = {
      bill: wireRow('bills', role, billRow),
      items: lineRows.map((r) => wireRow('bill_items', role, r)),
      receipts: written.receipts.map((r) => wireRow('receipts', role, r)),
      allocations: [...written.allocations, ...rebalanced.allocations].map((a) => wireRow('receipt_allocations', role, { ...a })),
      warnings: [...warnings].sort(),
      advance_applied: fromUnits(adjusted, 2),
    };
    await storeResult(tx, c.key, value);
    return { value, replayed: false };
  });
}

/** Registers `fn:create_bill`. */
export function registerCreateBill(app: FastifyInstance, options: CreateBillOptions = {}): void {
  route(app, {
    action: 'fn:create_bill',
    body: createBillBody,
    handler: async ({ app: a, request, reply, auth, body }) => {
      const key = idempotencyKey(request.headers); // before the transaction: a missing or malformed key claims nothing
      const { value, replayed } = await createBill(a, request, auth, key, body, options);
      markReplay(reply, replayed);
      return reply.code(201).send(value);
    },
  });
}
