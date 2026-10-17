import { randomUUID } from 'node:crypto';
import type { LightMyRequestResponse } from 'fastify';
import { insert, V } from '../schema/support';
import type { CallerName } from './cells';
import { type EditWorld, addDesign, addPiece, body } from './edit-support';

// Shared by the tests of API16 (X8 create_design and X9 set_sku_status): a world with the real routes (editWorld of API13: scratch database, migrations, seeds, a fixed clock at 17 Oct 2026 10:00 UTC),
// the two calls with their headers, and small readers that look at the tables directly (not through the API under test).

export type StockWorld = EditWorld;

export const newKey = (): string => randomUUID();

export interface PayloadOptions {
  design_id?: string;
  design?: Record<string, unknown>;
  pieces?: Record<string, unknown>[];
}

/** A body for X8 that is valid; `design` and `pieces` replace the defaults (the design is merged over the defaults, the pieces are taken as they are). */
export function designPayload(w: StockWorld, o: PayloadOptions = {}): { design_id: string; design: Record<string, unknown>; pieces: Record<string, unknown>[] } {
  return {
    design_id: o.design_id ?? randomUUID(),
    design: { category_id: w.category, material: 'Gold', purity: '22K', selling_method: 'By Weight', name: 'Temple Necklace', ...o.design },
    pieces: o.pieces ?? [{ pieces: 1, gross_weight: '12.500', customer_net_weight: '11.000', labour_retail: '350.00' }],
  };
}

/** POST /v1/designs with an Idempotency-Key (a new one unless given). */
export function createDesign(w: StockWorld, caller: CallerName, payload: unknown, key: string | null = newKey(), headers: Record<string, string> = {}): Promise<LightMyRequestResponse> {
  return w.world.call(caller, 'POST', '/v1/designs', { payload, headers: { ...(key === null ? {} : { 'idempotency-key': key }), ...headers } });
}

/** POST /v1/skus/status with an Idempotency-Key (a new one unless given). */
export function setStatus(w: StockWorld, caller: CallerName, payload: unknown, key: string | null = newKey(), headers: Record<string, string> = {}): Promise<LightMyRequestResponse> {
  return w.world.call(caller, 'POST', '/v1/skus/status', { payload, headers: { ...(key === null ? {} : { 'idempotency-key': key }), ...headers } });
}

export const errorCode = (res: LightMyRequestResponse): string | undefined => (JSON.parse(res.body) as { error?: { code: string } }).error?.code;
export const errorField = (res: LightMyRequestResponse): string | undefined => (JSON.parse(res.body) as { error?: { details?: { field?: string } } }).error?.details?.field;
export const requestIdOf = (res: LightMyRequestResponse): string => String(res.headers['x-request-id']);

// ------------------------------------------------------------------ what the tables hold

export async function rows(w: StockWorld, sql: string, params: unknown[] = []): Promise<any[]> {
  const [found] = await w.world.sql.query<any[]>(sql, params);
  return found;
}

export const designRow = async (w: StockWorld, id: string): Promise<any | undefined> => (await rows(w, 'SELECT * FROM designs WHERE id = ?', [id]))[0];
export const piecesOf = (w: StockWorld, designId: string): Promise<any[]> => rows(w, 'SELECT * FROM skus WHERE design_id = ? ORDER BY sku_no', [designId]);
export const privateOf = (w: StockWorld, designId: string): Promise<any[]> =>
  rows(w, 'SELECT p.* FROM sku_private p JOIN skus s ON s.id = p.sku_id WHERE s.design_id = ? ORDER BY s.sku_no', [designId]);
export async function counterOf(w: StockWorld, series: string): Promise<number | null> {
  const found = await rows(w, 'SELECT last_value FROM sys_counters WHERE series = ?', [series]);
  return found.length === 0 ? null : Number(found[0].last_value);
}
export async function countOf(w: StockWorld, table: string): Promise<number> {
  return Number((await rows(w, `SELECT COUNT(*) AS n FROM \`${table}\``))[0].n);
}

/** Every number a failed call must leave as it found it: designs, pieces, the owner-only weights, the claims, the audit rows. */
export async function footprint(w: StockWorld): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of ['designs', 'skus', 'sku_private', 'sys_idempotency', 'audit_log']) out[t] = await countOf(w, t);
  out.counters = Number((await rows(w, 'SELECT COALESCE(SUM(last_value), 0) AS n FROM sys_counters'))[0].n);
  return out;
}

// ------------------------------------------------------------------ fixtures

/** A piece that is Sold on a bill (the bill and its customer typed in by SQL: the status CHECKs tie `Sold` to a bill). */
export async function addSoldPiece(w: StockWorld, designId?: string): Promise<{ piece: string; bill: string; design: string }> {
  const design = designId ?? (await addDesign(w));
  const customer = (await insert(w.world.sql, 'customers', V.customer({ mobile: `9${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}` }))).id as string;
  const bill = (await insert(w.world.sql, 'bills', V.bill(customer))).id as string;
  const piece = await addPiece(w, design, { status: 'Sold', sold_bill_id: bill });
  return { piece, bill, design };
}

/** A piece in a given status; an Archived one carries the time it was archived (the CHECK ties the two). */
export async function addPieceIn(w: StockWorld, designId: string, status: string, o: Record<string, unknown> = {}): Promise<string> {
  return addPiece(w, designId, { status, ...(status === 'Archived' ? { archived_at: '2026-09-01 12:00:00.000000' } : {}), ...o });
}

export { body };
