import { randomUUID } from 'node:crypto';
import type { LightMyRequestResponse } from 'fastify';
import { expect } from 'vitest';
import { runInvariants } from '../../scripts/invariants.mjs';
import { V2_ONE_TEXT } from '../../src/db/state';
import { T, V, insert } from '../schema/support';
import type { CallerName } from './cells';
import { type EditWorld, TODAY, WALKIN, addCustomer, body, codeOf, editWorld, errorField, newKey, requestIdOf, rows } from './x01-support';

// Shared by the tests of API22 (X2 record_payment: POST /v1/customers/:id/payments): the call itself, the books of a customer typed in by SQL (the way the import writes them, with stamps that are
// earlier than the API clock's), and readers that look at the tables directly and at V1 and V2 of the database half, which are another opinion than the code under test.

export { TODAY, WALKIN, addCustomer, body, codeOf, editWorld, errorField, newKey, requestIdOf, rows };
export type { EditWorld };

export type Payload = Record<string, unknown>;

/** POST /v1/customers/<id>/payments with an Idempotency-Key (a new one unless given; null sends none). */
export function pay(w: EditWorld, caller: CallerName, customerId: string, payload: unknown, key: string | null = newKey(), headers: Record<string, string> = {}): Promise<LightMyRequestResponse> {
  return w.world.call(caller, 'POST', `/v1/customers/${customerId}/payments`, { payload, headers: { ...(key === null ? {} : { 'idempotency-key': key }), ...headers } });
}

export interface PaymentResult {
  receipt: Record<string, any>;
  allocations: Record<string, any>[];
  advance_remaining: string;
}

/** The payment is saved (201); returns the answer. */
export async function paid(res: LightMyRequestResponse): Promise<PaymentResult> {
  if (res.statusCode !== 201) throw new Error(`expected 201, got ${res.statusCode}: ${res.body}`);
  return body<PaymentResult>(res);
}

/** A refusal: the status, the code and the field it names. */
export function refusal(res: LightMyRequestResponse): { status: number; code: string | undefined; field: string | undefined } {
  return { status: res.statusCode, code: codeOf(res), field: errorField(res) };
}

// ------------------------------------------------------------------ fixtures typed by SQL

let seq = 0;
export const stamp = (day: string, n = 0): string => `${day} 05:00:00.${String(n).padStart(6, '0')}`;

/** A bill nobody has paid, dated `date` (a whole number of rupees: chk_bills_whole_rupee). `o` overrides any column. */
export async function addBill(w: EditWorld, customer: string, total: string, date: string, o: Record<string, unknown> = {}): Promise<string> {
  const id = (o.id as string | undefined) ?? randomUUID();
  seq++;
  await insert(w.world.sql, 'bills', V.bill(customer, { id, bill_no: `PAY-${seq}-${id.slice(0, 6)}`, bill_date: date, subtotal: total, grand_total: total, created_at: stamp(date, seq), updated_at: stamp(date, seq), ...o }));
  return id;
}

/** An opening-balance bill of the import (doc_type opening_balance, dated the cut-over day, D15, Y9). */
export const addOpeningBill = (w: EditWorld, customer: string, total: string, date = '2026-04-01'): Promise<string> =>
  addBill(w, customer, total, date, { doc_type: 'opening_balance', sale_type: 'Retail', bill_no: `OB-${900000 + ++seq}` });

/** A cancelled bill (K3): it has a reason, a time, a day and a person. */
export const addCancelledBill = (w: EditWorld, customer: string, total: string, date: string): Promise<string> =>
  addBill(w, customer, total, date, { status: 'cancelled', cancel_reason: 'test', cancelled_at: stamp(date, 99), cancelled_on: date, cancelled_by: w.world.fixtures.owner.userId });

/** A money receipt typed by SQL (an advance is money received and not yet applied). */
export async function addMoney(w: EditWorld, customer: string, amount: string, paidOn: string, o: Record<string, unknown> = {}): Promise<string> {
  const id = randomUUID();
  seq++;
  await insert(w.world.sql, 'receipts', V.receipt(customer, { id, amount, mode: 'Other', paid_on: paidOn, created_at: stamp(paidOn, seq), updated_at: stamp(paidOn, seq), ...o }));
  return id;
}

export async function addAllocation(w: EditWorld, receipt: string, bill: string, customer: string, amount: string, o: Record<string, unknown> = {}): Promise<string> {
  const id = randomUUID();
  seq++;
  await insert(w.world.sql, 'receipt_allocations', V.allocation(receipt, bill, customer, { id, amount, created_at: stamp('2026-10-02', seq), updated_at: stamp('2026-10-02', seq), ...o }));
  return id;
}

// ------------------------------------------------------------------ what the tables say

export const receiptsOf = (w: EditWorld, customer: string): Promise<any[]> => rows(w, 'SELECT * FROM receipts WHERE customer_id = ? ORDER BY created_at, id', [customer]);
export const allocationsOf = (w: EditWorld, customer: string): Promise<any[]> => rows(w, 'SELECT * FROM receipt_allocations WHERE customer_id = ? ORDER BY created_at, id', [customer]);
export const billRow = async (w: EditWorld, id: string): Promise<any> => (await rows(w, 'SELECT * FROM bills WHERE id = ?', [id]))[0];
export const customerRow = async (w: EditWorld, id: string): Promise<any> => (await rows(w, 'SELECT * FROM customers WHERE id = ?', [id]))[0];

/** V2 for one customer: the four figures the rules are about. */
export async function figures(w: EditWorld, customer: string) {
  const [found] = await w.world.sql.query<any[]>(V2_ONE_TEXT.replace('?', w.world.sql.escape(customer)));
  const r = (found as any[])[0];
  return { outstanding: r.outstanding as string, advance: r.advance as string, fine_outstanding: r.fine_outstanding as string, fine_advance: r.fine_advance as string };
}

/** V1 of the database half for every bill of the customer: what is pending on each bill, by bill id. */
export async function pendingByBill(w: EditWorld, customer: string): Promise<Record<string, string>> {
  const found = await rows(w, `SELECT id, pending FROM ${T.bill_summary} WHERE customer_id = ?`, [customer]);
  return Object.fromEntries(found.map((r) => [r.id as string, r.pending as string]));
}

/** The sum of what is pending on the active bills, in paise (V1 summed), against the customer's outstanding (V2): the two views of the database half must agree (T-B05). */
export async function pendingAgrees(w: EditWorld, customer: string): Promise<void> {
  const byBill = await rows(w, `SELECT b.id, b.status, bill_summary.pending FROM bills b JOIN ${T.bill_summary} ON bill_summary.id = b.id WHERE b.customer_id = ?`, [customer]);
  const sum = byBill.filter((r) => r.status === 'active').reduce((n, r) => n + BigInt(String(r.pending).replace('.', '')), 0n);
  const outstanding = BigInt((await figures(w, customer)).outstanding.replace('.', ''));
  expect(sum, `the pending of the bills (${sum}) is not the customer's outstanding (${outstanding}), in paise`).toBe(outstanding);
}

/** I10 of the database half (the rebalance post-condition) for one customer: what is pending on the bills is the outstanding figure, and an advance is held only when nothing is pending. */
export async function i10Holds(w: EditWorld, customer: string): Promise<void> {
  const out = await runInvariants(w.world.sql, { sample: 10_000 });
  const mine = out.rows.filter((r: { invariant: string; row_ref: string; detail: string }) => r.invariant === 'I10' && r.row_ref === `customers:${customer}`);
  expect(mine, JSON.stringify(mine)).toEqual([]);
}

/** Everything a call that fails must leave as it found it (K2, X0): receipts, allocations, claims, audit rows, the stamps of the customers and bills. */
export async function footprint(w: EditWorld): Promise<Record<string, number | string>> {
  const out: Record<string, number | string> = {};
  for (const t of ['bills', 'receipts', 'receipt_allocations', 'sys_idempotency', 'audit_log']) out[t] = Number((await rows(w, `SELECT COUNT(*) AS n FROM \`${t}\``))[0].n);
  out.customers = String((await rows(w, "SELECT COALESCE(MAX(updated_at), '') AS m FROM customers"))[0].m);
  out.bill_stamps = String((await rows(w, "SELECT COALESCE(MAX(updated_at), '') AS m FROM bills"))[0].m);
  return out;
}
