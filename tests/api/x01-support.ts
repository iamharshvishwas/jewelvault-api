import { randomUUID } from 'node:crypto';
import type { LightMyRequestResponse } from 'fastify';
import { V, insert } from '../schema/support';
import type { CallerName } from './cells';
import { type EditWorld, addDesign, addPiece, body, codeOf, editWorld } from './edit-support';
import { counterOf, errorField, newKey, requestIdOf, rows } from './stock-support';

// Shared by the tests of API20 (X1 create_bill: POST /v1/bills): a world with the application's real routes, the seeds (the settings of D3, among them `estimate`, the walk-in customer, the categories)
// and a clock fixed at 17 Oct 2026 10:00 UTC (15:30 in Kolkata, so "today" is 2026-10-17); small builders for designs, pieces, customers and rates typed by SQL (not through the API under test);
// the call itself; and readers that look at the tables directly.

export const TODAY = '2026-10-17';
export { body, codeOf, editWorld, errorField, newKey, requestIdOf, rows, counterOf };
export type { EditWorld };

let mobiles = 0;
export async function addCustomer(w: EditWorld, o: Record<string, unknown> = {}): Promise<string> {
  mobiles++;
  return (await insert(w.world.sql, 'customers', V.customer({ mobile: `98${String(10_000_000 + mobiles)}`, ...o }))).id as string;
}
export const WALKIN = '00000000-0000-4000-8000-000000000001';

/** The four designs the tests bill from: a gold and a silver By Weight design with a daily rate, a silver one that never has a rate, and a gold Per Piece one. */
export interface Designs {
  gold22: string;
  silver999: string;
  silver925: string;
  gold24pp: string;
  gold18: string;
}
export async function addDesigns(w: EditWorld): Promise<Designs> {
  return {
    gold22: await addDesign(w, { name: 'Gold 22', material: 'Gold', purity: '22K', selling_method: 'By Weight' }),
    gold18: await addDesign(w, { name: 'Gold 18', material: 'Gold', purity: '18K', selling_method: 'By Weight' }),
    silver999: await addDesign(w, { name: 'Silver 999', material: 'Silver', purity: '999', selling_method: 'By Weight' }),
    silver925: await addDesign(w, { name: 'Silver 925', material: 'Silver', purity: '925', selling_method: 'By Weight' }),
    gold24pp: await addDesign(w, { name: 'Gold 24 piece', material: 'Gold', purity: '24K', selling_method: 'Per Piece' }),
  };
}

export interface PieceSpec {
  nw?: string;
  gross?: string;
  retail?: string;
  semi?: string;
  wholesale?: string;
  status?: string;
  extra?: Record<string, unknown>;
}
/** A piece of a design. Its labour rates are the piece's three rates (the piece price for a Per Piece design, R1, R2). */
export async function piece(w: EditWorld, design: string, o: PieceSpec = {}): Promise<string> {
  const retail = o.retail ?? '0.00';
  return addPiece(w, design, {
    customer_net_weight: o.nw ?? '10.000',
    gross_weight: o.gross ?? o.nw ?? '10.000',
    labour_retail: retail,
    labour_semi: o.semi ?? retail,
    labour_wholesale: o.wholesale ?? retail,
    ...(o.status === undefined ? {} : { status: o.status }),
    ...(o.status === 'Archived' ? { archived_at: '2026-09-01 12:00:00.000000' } : {}),
    ...o.extra,
  });
}

export async function addRate(w: EditWorld, material: string, purity: string, rate: string, date: string): Promise<void> {
  await insert(w.world.sql, 'daily_rates', V.dailyRate({ material, purity, rate_per_gram: rate, rate_date: date }));
}

/** `settings.estimate`: the prefix of the bill numbers (L4) and the round-off flag (R8). Series are keyed by the prefix, so a test that asserts a number gives itself a prefix of its own. */
export async function setEstimate(w: EditWorld, o: { prefix?: string; roundOff?: boolean } = {}): Promise<void> {
  const [found] = await w.world.sql.query<any[]>("SELECT value FROM settings WHERE setting_key = 'estimate'");
  const current = (typeof found[0].value === 'string' ? JSON.parse(found[0].value) : found[0].value) as Record<string, unknown>;
  await w.world.sql.query("UPDATE settings SET value = ? WHERE setting_key = 'estimate'", [JSON.stringify({ ...current, ...o })]);
}

// ------------------------------------------------------------------ the call

export interface Item {
  sku_id: string;
  metal_rate?: unknown;
  labour_rate?: unknown;
  piroi?: unknown;
  other_charges?: unknown;
  quantity?: unknown;
  [extra: string]: unknown;
}
export const item = (sku_id: string, o: Omit<Item, 'sku_id'> = {}): Item => ({ sku_id, ...o });
export type Body = Record<string, unknown>;

/** A body for X1 that is valid; `extra` is merged over it. */
export const billBody = (customer_id: string, sale_type: string, items: Item[], extra: Body = {}): Body => ({ customer_id, sale_type, items, ...extra });

/** POST /v1/bills with an Idempotency-Key (a new one unless given; null sends none). */
export function postBill(w: EditWorld, caller: CallerName, payload: unknown, key: string | null = newKey(), headers: Record<string, string> = {}): Promise<LightMyRequestResponse> {
  return w.world.call(caller, 'POST', '/v1/bills', { payload, headers: { ...(key === null ? {} : { 'idempotency-key': key }), ...headers } });
}

/** POST /v1/bills/quote. */
export const postQuote = (w: EditWorld, caller: CallerName, payload: unknown): Promise<LightMyRequestResponse> => w.world.call(caller, 'POST', '/v1/bills/quote', { payload });

export interface BillResult {
  bill: Record<string, any>;
  items: Record<string, any>[];
  receipts: Record<string, any>[];
  allocations: Record<string, any>[];
  warnings: string[];
  advance_applied: string;
}

/** The bill is saved (201); returns the answer. */
export async function saved(res: LightMyRequestResponse): Promise<BillResult> {
  if (res.statusCode !== 201) throw new Error(`expected 201, got ${res.statusCode}: ${res.body}`);
  return body<BillResult>(res);
}

export interface Quote {
  pricing_version: number;
  bill_date: string;
  sale_type: string;
  lines: Record<string, any>[];
  totals: Record<string, string>;
  list_prices: { line_no: number; sku_id: string; list_metal_rate: string; list_labour_rate: string | null; metal_rate_date: string | null }[];
  warnings: string[];
}

// ------------------------------------------------------------------ what the tables hold

export const billRow = async (w: EditWorld, id: string): Promise<any> => (await rows(w, 'SELECT * FROM bills WHERE id = ?', [id]))[0];
export const itemRows = (w: EditWorld, billId: string): Promise<any[]> => rows(w, 'SELECT * FROM bill_items WHERE bill_id = ? ORDER BY line_no', [billId]);
export const pieceRow = async (w: EditWorld, id: string): Promise<any> => (await rows(w, 'SELECT * FROM skus WHERE id = ?', [id]))[0];
export async function countOf(w: EditWorld, table: string, where = '1 = 1', params: unknown[] = []): Promise<number> {
  return Number((await rows(w, `SELECT COUNT(*) AS n FROM \`${table}\` WHERE ${where}`, params))[0].n);
}

/** Everything a call that fails must leave as it found it (K2, X0): bills, lines, receipts, allocations, claims, audit rows, pieces that are Sold, the sum of all counters, the customers' stamps. */
export async function footprint(w: EditWorld): Promise<Record<string, number | string>> {
  const out: Record<string, number | string> = {};
  for (const t of ['bills', 'bill_items', 'receipts', 'receipt_allocations', 'sys_idempotency', 'audit_log']) out[t] = await countOf(w, t);
  out.sold = await countOf(w, 'skus', "status = 'Sold'");
  out.counters = Number((await rows(w, 'SELECT COALESCE(SUM(last_value), 0) AS n FROM sys_counters'))[0].n);
  out.customers = String((await rows(w, "SELECT COALESCE(MAX(updated_at), '') AS m FROM customers"))[0].m);
  return out;
}

export { randomUUID };
