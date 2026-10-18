import { randomUUID } from 'node:crypto';
import type { LightMyRequestResponse } from 'fastify';
import { T, V, insert } from '../schema/support';
import type { CallerName } from './cells';
import { type EditWorld, body, newKey, rows } from './x02-support';

// Shared by the tests of API25 (X4 void_receipt: POST /v1/receipts/:id/void, X5 cancel_bill: POST /v1/bills/:id/cancel): the two calls, their answers, and readers of the books that look at the tables and at
// V1 to V4 of the database half directly (another opinion than the code under test).

export type Payload = Record<string, unknown>;

/** Send no body at all (an `undefined` payload would take the default). */
export const NO_BODY = Symbol('no body');
const bodyOf = (payload: unknown): unknown => (payload === NO_BODY ? undefined : payload);

/** POST /v1/receipts/<id>/void with an Idempotency-Key (a new one unless given; null sends none). */
export function voidReceipt(w: EditWorld, caller: CallerName, receiptId: string, payload: unknown = { reason: 'entered twice by mistake' }, key: string | null = newKey(), headers: Record<string, string> = {}): Promise<LightMyRequestResponse> {
  return w.world.call(caller, 'POST', `/v1/receipts/${receiptId}/void`, { payload: bodyOf(payload), headers: { ...(key === null ? {} : { 'idempotency-key': key }), ...headers } });
}

/** POST /v1/bills/<id>/cancel with an Idempotency-Key (a new one unless given; null sends none). */
export function cancelBill(w: EditWorld, caller: CallerName, billId: string, payload: unknown = { reason: 'the customer returned the goods' }, key: string | null = newKey(), headers: Record<string, string> = {}): Promise<LightMyRequestResponse> {
  return w.world.call(caller, 'POST', `/v1/bills/${billId}/cancel`, { payload: bodyOf(payload), headers: { ...(key === null ? {} : { 'idempotency-key': key }), ...headers } });
}

export interface VoidResult {
  receipt: Record<string, any>;
  allocations: Record<string, any>[];
  bills: Record<string, any>[];
}
export interface CancelResult {
  bill: Record<string, any>;
  skus: Record<string, any>[];
  released_allocations: Record<string, any>[];
  allocations: Record<string, any>[];
}

/** The void is done (200); returns the answer. */
export async function voided(res: LightMyRequestResponse): Promise<VoidResult> {
  if (res.statusCode !== 200) throw new Error(`expected 200, got ${res.statusCode}: ${res.body}`);
  return body<VoidResult>(res);
}
/** The cancel is done (200); returns the answer. */
export async function cancelled(res: LightMyRequestResponse): Promise<CancelResult> {
  if (res.statusCode !== 200) throw new Error(`expected 200, got ${res.statusCode}: ${res.body}`);
  return body<CancelResult>(res);
}

// ------------------------------------------------------------------ what the tables and the derived reads say

/** V3, the ledger of one customer, in its order key. */
export const ledgerOf = (w: EditWorld, customer: string): Promise<any[]> =>
  rows(w, `SELECT kind, entry_date, debit, credit, fine_debit, fine_credit, balance, fine_balance, description FROM ${T.customer_ledger} WHERE customer_id = ? ORDER BY entry_date, entry_at, kind_rank, id`, [customer]);

/** V4: one row of the cash book, `money_in`, `money_out` and `net`, or zeros when the day has none. */
export async function dayRow(w: EditWorld, date: string, mode: string): Promise<{ money_in: string; money_out: string; net: string }> {
  const [r] = await rows(w, `SELECT money_in, money_out, net FROM ${T.daily_totals} WHERE business_date = ? AND mode = ?`, [date, mode]);
  return r ? { money_in: String(r.money_in), money_out: String(r.money_out), net: String(r.net) } : { money_in: '0.00', money_out: '0.00', net: '0.00' };
}

/** V1 of the database half for the bills of a customer, by bill id: pending money, pending silver, payment status. */
export async function billStates(w: EditWorld, customer: string): Promise<Record<string, { status: string; received: string; pending: string; fine_settled: string; fine_pending: string; payment_status: string }>> {
  const found = await rows(w, `SELECT id, status, received, pending, fine_settled, fine_pending, payment_status FROM ${T.bill_summary} WHERE customer_id = ?`, [customer]);
  return Object.fromEntries(found.map((r) => [r.id as string, { status: String(r.status), received: String(r.received), pending: String(r.pending), fine_settled: String(r.fine_settled), fine_pending: String(r.fine_pending), payment_status: String(r.payment_status) }]));
}

export const receiptRow = async (w: EditWorld, id: string): Promise<any> => (await rows(w, 'SELECT * FROM receipts WHERE id = ?', [id]))[0];
export const allocationRows = (w: EditWorld, where: string, params: unknown[]): Promise<any[]> => rows(w, `SELECT * FROM receipt_allocations WHERE ${where} ORDER BY created_at, id`, params);

/** Everything a call that is refused or fails must leave as it found it: receipts, allocations, claims, audit rows, pieces that are Sold, the stamps of customers, bills and receipts. */
export async function trace(w: EditWorld): Promise<Record<string, number | string>> {
  const out: Record<string, number | string> = {};
  for (const t of ['bills', 'receipts', 'receipt_allocations', 'sys_idempotency', 'audit_log']) out[t] = Number((await rows(w, `SELECT COUNT(*) AS n FROM \`${t}\``))[0].n);
  out.sold = Number((await rows(w, "SELECT COUNT(*) AS n FROM skus WHERE status = 'Sold'"))[0].n);
  out.cancelled = Number((await rows(w, "SELECT COUNT(*) AS n FROM bills WHERE status = 'cancelled'"))[0].n);
  out.voided = Number((await rows(w, "SELECT COUNT(*) AS n FROM receipts WHERE status = 'voided'"))[0].n);
  out.released = Number((await rows(w, 'SELECT COUNT(*) AS n FROM receipt_allocations WHERE released_at IS NOT NULL'))[0].n);
  for (const t of ['customers', 'bills', 'receipts', 'receipt_allocations', 'skus']) out[`${t}_stamps`] = String((await rows(w, `SELECT COALESCE(MAX(updated_at), '') AS m FROM \`${t}\``))[0].m);
  return out;
}

/** A piece that is Sold on `bill`, with a line on the bill (what X1 leaves): typed by SQL for the bills of the tests that need no pricing. */
export async function addSoldPiece(w: EditWorld, design: string, bill: string, lineNo: number, o: Record<string, unknown> = {}): Promise<string> {
  const id = randomUUID();
  await insert(w.world.sql, 'skus', V.sku(design, { id, status: 'Sold', sold_bill_id: bill, ...o }));
  await insert(w.world.sql, 'bill_items', V.billItem(bill, id, { line_no: lineNo, sku_no: `S-${id.slice(0, 6)}` }));
  return id;
}

export { newKey };
