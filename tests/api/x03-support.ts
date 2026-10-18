import { randomUUID } from 'node:crypto';
import type { LightMyRequestResponse } from 'fastify';
import { T, V, insert } from '../schema/support';
import type { CallerName } from './cells';
import { type EditWorld, addBill, body, newKey, rows, stamp } from './x02-support';

// Shared by the tests of API24 (X3 settle_fine: POST /v1/customers/:id/fine-settlements): the call itself, bills that owe silver and silver receipts typed by SQL (the way the import writes
// them, with stamps earlier than the API clock's), and readers of the fine side of V1, V2 and V4 of the database half, which are another opinion than the code under test.

export type Payload = Record<string, unknown>;

/** POST /v1/customers/<id>/fine-settlements with an Idempotency-Key (a new one unless given; null sends none). */
export function settle(w: EditWorld, caller: CallerName, customerId: string, payload: unknown, key: string | null = newKey(), headers: Record<string, string> = {}): Promise<LightMyRequestResponse> {
  return w.world.call(caller, 'POST', `/v1/customers/${customerId}/fine-settlements`, { payload, headers: { ...(key === null ? {} : { 'idempotency-key': key }), ...headers } });
}

export interface SettleResult {
  receipt: Record<string, any>;
  allocations: Record<string, any>[];
  fine_remaining: string;
}

/** The settlement is saved (201); returns the answer. */
export async function settled(res: LightMyRequestResponse): Promise<SettleResult> {
  if (res.statusCode !== 201) throw new Error(`expected 201, got ${res.statusCode}: ${res.body}`);
  return body<SettleResult>(res);
}

/** A body in silver / in cash. */
export const silver = (grams: string, extra: Payload = {}): Payload => ({ grams, mode: 'Silver', ...extra });
export const cashFine = (grams: string, rate: string, extra: Payload = {}): Payload => ({ grams, mode: 'Cash', silver_rate: rate, ...extra });

/** A bill that owes `fine` grams of silver (a wholesale silver By Weight bill, R4), worth `total` rupees, dated `date`. `o` overrides any column. */
export const addFineBill = (w: EditWorld, customer: string, total: string, fine: string, date: string, o: Record<string, unknown> = {}): Promise<string> =>
  addBill(w, customer, total, date, { sale_type: 'Wholesale', fine_weight_due: fine, ...o });

/** A silver receipt typed by SQL: fine received and not yet applied (an advance of silver), or applied by `addAllocation` with fine_grams. */
export async function addSilver(w: EditWorld, customer: string, grams: string, paidOn: string, o: Record<string, unknown> = {}): Promise<string> {
  const id = randomUUID();
  await insert(w.world.sql, 'receipts', V.receipt(customer, { id, kind: 'fine_silver', mode: null, amount: '0.00', fine_grams: grams, paid_on: paidOn, created_at: stamp(paidOn, 1), updated_at: stamp(paidOn, 1), ...o }));
  return id;
}

/** An allocation of silver grams. */
export async function addFineAllocation(w: EditWorld, receipt: string, bill: string, customer: string, grams: string): Promise<string> {
  const id = randomUUID();
  await insert(w.world.sql, 'receipt_allocations', V.allocation(receipt, bill, customer, { id, amount: '0.00', fine_grams: grams, created_at: stamp('2026-10-02', 7), updated_at: stamp('2026-10-02', 7) }));
  return id;
}

/** V1 of the database half for every bill of the customer: the silver still pending on each bill, by bill id (active bills only count). */
export async function finePendingByBill(w: EditWorld, customer: string): Promise<Record<string, string>> {
  const found = await rows(w, `SELECT id, fine_pending FROM ${T.bill_summary} WHERE customer_id = ?`, [customer]);
  return Object.fromEntries(found.map((r) => [r.id as string, r.fine_pending as string]));
}

/** V1 of the database half: the rupees pending on each bill. */
export async function moneyPendingByBill(w: EditWorld, customer: string): Promise<Record<string, string>> {
  const found = await rows(w, `SELECT id, pending FROM ${T.bill_summary} WHERE customer_id = ?`, [customer]);
  return Object.fromEntries(found.map((r) => [r.id as string, r.pending as string]));
}

/** V4: the Cash row of one business date, `money_in`, `money_out` and `net`, or zeros when the day has no Cash row. */
export async function cashRow(w: EditWorld, date: string): Promise<{ money_in: string; money_out: string; net: string }> {
  const [r] = await rows(w, `SELECT money_in, money_out, net FROM ${T.daily_totals} WHERE business_date = ? AND mode = 'Cash'`, [date]);
  return r ? { money_in: String(r.money_in), money_out: String(r.money_out), net: String(r.net) } : { money_in: '0.00', money_out: '0.00', net: '0.00' };
}

/** The sum of the pending silver of the active bills of the customer, in milligrams (V1 summed), and V2's fine_outstanding in milligrams: they must be equal (I10). */
export async function fineAgrees(w: EditWorld, customer: string): Promise<{ bills: bigint; outstanding: bigint }> {
  const byBill = await rows(w, `SELECT b.status, bill_summary.fine_pending FROM bills b JOIN ${T.bill_summary} ON bill_summary.id = b.id WHERE b.customer_id = ?`, [customer]);
  const bills = byBill.filter((r) => r.status === 'active').reduce((n, r) => n + BigInt(String(r.fine_pending).replace('.', '')), 0n);
  const [v2] = await rows(w, `SELECT customer_balances.fine_outstanding FROM ${T.customer_balances} WHERE customer_balances.id = ?`, [customer]);
  return { bills, outstanding: BigInt(String(v2.fine_outstanding).replace('.', '')) };
}
