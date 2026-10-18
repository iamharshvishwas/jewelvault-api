import type { LightMyRequestResponse } from 'fastify';
import { T } from '../schema/support';
import type { CallerName } from './cells';
import { type EditWorld, body, newKey, rows } from './x02-support';

// Shared by the tests of API27 (X12 add_opening_balance: POST /v1/customers/:id/opening-balance): the call itself, its answer, and readers of the opening rows that look at the tables and at V1 to V4
// of the database half directly (another opinion than the code under test).

export type Payload = Record<string, unknown>;

/** POST /v1/customers/<id>/opening-balance with an Idempotency-Key (a new one unless given; null sends none). */
export function addOpening(w: EditWorld, caller: CallerName, customerId: string, payload: unknown, key: string | null = newKey(), headers: Record<string, string> = {}): Promise<LightMyRequestResponse> {
  return w.world.call(caller, 'POST', `/v1/customers/${customerId}/opening-balance`, { payload, headers: { ...(key === null ? {} : { 'idempotency-key': key }), ...headers } });
}

export interface OpeningResult {
  /** the opening_balance bill, or null when the call had no dues and no fine due */
  bill: Record<string, any> | null;
  /** the is_opening receipts, money first, then silver */
  receipts: Record<string, any>[];
  /** the rows of the rebalance: an advance netting off against dues */
  allocations: Record<string, any>[];
}

/** The opening rows are saved (201); returns the answer. */
export async function opened(res: LightMyRequestResponse): Promise<OpeningResult> {
  if (res.statusCode !== 201) throw new Error(`expected 201, got ${res.statusCode}: ${res.body}`);
  return body<OpeningResult>(res);
}

/** The cut-over day the tests use: long before the fixture clock's 2026-10-17. */
export const CUT_OVER = '2026-04-01';

/** A body for X12: the figures given, as_of the cut-over day unless given. */
export const opening = (figures: { dues?: unknown; fine_due?: unknown; advance?: unknown; fine_advance?: unknown }, extra: Payload = {}): Payload => ({ as_of: CUT_OVER, ...figures, ...extra });

// ------------------------------------------------------------------ what the tables and the derived reads say

/** Every bill of a customer, oldest first, with the facts X12 sets. */
export const billsOf = (w: EditWorld, customer: string): Promise<any[]> => rows(w, 'SELECT * FROM bills WHERE customer_id = ? ORDER BY bill_date, created_at, id', [customer]);
export const openingBillsOf = (w: EditWorld, customer: string): Promise<any[]> => rows(w, "SELECT * FROM bills WHERE customer_id = ? AND doc_type = 'opening_balance' ORDER BY created_at, id", [customer]);
export const openingReceiptsOf = (w: EditWorld, customer: string): Promise<any[]> => rows(w, 'SELECT * FROM receipts WHERE customer_id = ? AND is_opening = 1 ORDER BY created_at, kind DESC, id', [customer]);
export const lineCount = async (w: EditWorld, billId: string): Promise<number> => Number((await rows(w, 'SELECT COUNT(*) AS n FROM bill_items WHERE bill_id = ?', [billId]))[0].n);

/** V2 for one customer: the columns the sales rules are about besides the four balances. */
export async function totalsOf(w: EditWorld, customer: string): Promise<Record<string, string>> {
  const [r] = await rows(w, `SELECT billed, total_purchases, received, refunded, allocated, outstanding, advance, fine_billed, fine_received, fine_allocated, fine_outstanding, fine_advance FROM ${T.customer_balances} WHERE id = ?`, [customer]);
  return Object.fromEntries(Object.entries(r).map(([k, v]) => [k, String(v)]));
}

/** V1 for the bills of a customer that are NOT opening bills (what the sales figures of V5 add up): an opening bill must never be here. */
export async function salesBillsOf(w: EditWorld, customer: string): Promise<any[]> {
  return rows(w, `SELECT id, bill_no, grand_total FROM ${T.bill_summary} WHERE customer_id = ? AND status = 'active' AND doc_type <> 'opening_balance'`, [customer]);
}

/** Everything a call that is refused or fails must leave as it found it: bills, receipts, allocations, claims, audit rows, the opening counter, the stamps of the customers and bills. */
export async function footprint(w: EditWorld): Promise<Record<string, number | string>> {
  const out: Record<string, number | string> = {};
  for (const t of ['bills', 'receipts', 'receipt_allocations', 'sys_idempotency', 'audit_log']) out[t] = Number((await rows(w, `SELECT COUNT(*) AS n FROM \`${t}\``))[0].n);
  out.opening_counter = String((await rows(w, "SELECT COALESCE(MAX(last_value), 0) AS n FROM sys_counters WHERE series = 'opening'"))[0].n);
  for (const t of ['customers', 'bills', 'receipts', 'receipt_allocations']) out[`${t}_stamps`] = String((await rows(w, `SELECT COALESCE(MAX(updated_at), '') AS m FROM \`${t}\``))[0].m);
  return out;
}

/** The current value of the `opening` counter, or null when its row does not exist yet. */
export async function openingCounter(w: EditWorld): Promise<number | null> {
  const found = await rows(w, "SELECT last_value FROM sys_counters WHERE series = 'opening'");
  return found.length === 0 ? null : Number(found[0].last_value);
}

export const numberOf = (billNo: string): number => Number(billNo.replace(/^OB-/, ''));
