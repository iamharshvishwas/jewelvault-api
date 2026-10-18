import type { LightMyRequestResponse } from 'fastify';
import { T } from '../schema/support';
import type { CallerName } from './cells';
import { type Body, type Designs, type Item, billBody, item, piece, postBill, saved } from './x01-support';
import { ledgerOf, trace } from './x04-support';
import { type EditWorld, body, newKey, rows } from './x02-support';

// Shared by the tests of API26 (X10 reissue_bill: POST /v1/bills/:id/reissue): the call itself, its answer, bills made through the real create_bill route (so that they have lines, pieces and receipts that
// are the way the application writes them), and readers of the books that look at the tables and at V1 to V3 of the database half directly (another opinion than the code under test).

export type { Body, Item };

/** POST /v1/bills/<id>/reissue with an Idempotency-Key (a new one unless given; null sends none). The body is `reason` + the body of create_bill without `customer_id`. */
export function reissueBill(w: EditWorld, caller: CallerName, billId: string, payload: unknown, key: string | null = newKey(), headers: Record<string, string> = {}): Promise<LightMyRequestResponse> {
  return w.world.call(caller, 'POST', `/v1/bills/${billId}/reissue`, { payload, headers: { ...(key === null ? {} : { 'idempotency-key': key }), ...headers } });
}

export interface ReissueResult {
  old_bill: Record<string, any>;
  new_bill: Record<string, any>;
  items: Record<string, any>[];
  receipts: Record<string, any>[];
  allocations: Record<string, any>[];
  released_allocations: Record<string, any>[];
  warnings: string[];
  advance_applied: string;
}

/** The re-issue is saved (201); returns the answer. */
export async function reissued(res: LightMyRequestResponse): Promise<ReissueResult> {
  if (res.statusCode !== 201) throw new Error(`expected 201, got ${res.statusCode}: ${res.body}`);
  return body<ReissueResult>(res);
}

/** A body for X10 that is valid: the reason, the sale type and the items; `extra` is merged over it. */
export const reissueBody = (sale_type: string, items: Item[], extra: Body = {}, reason = 'the rate on the first bill was wrong'): Body => ({ reason, sale_type, items, ...extra });

export const upi = (amount: string) => ({ mode: 'UPI', amount });
export const cash = (amount: string) => ({ mode: 'Cash', amount });

/** A bill of ONE Per Piece line priced `total` (a whole number of rupees), made by create_bill with `extra` merged into the body. Returns the bill, its piece and what create_bill made. */
export async function sell(w: EditWorld, d: Designs, customer: string, total: string, extra: Body = {}) {
  const p = await piece(w, d.gold24pp, { retail: total });
  const made = await saved(await postBill(w, 'owner', billBody(customer, 'Retail', [item(p, { metal_rate: total })], extra)));
  return { id: String(made.bill.id), piece: p, made };
}

/** The ONE line of a Per Piece re-issue: the same piece, a new price. */
export const line = (pieceId: string, total: string): Item => item(pieceId, { metal_rate: total });

/** The ledger of a customer, V3, as [kind, debit, credit] in its order key. */
export async function ledgerKinds(w: EditWorld, customer: string): Promise<[string, string, string][]> {
  return (await ledgerOf(w, customer)).map((x) => [String(x.kind), String(x.debit), String(x.credit)]);
}

/** Does every row of the ledger carry the running balance of the rows before it? Returns the first row that does not, else null (T-B25: the balance never goes ahead of its events). */
export async function firstBadBalance(w: EditWorld, customer: string): Promise<string | null> {
  let money = 0n;
  let fine = 0n;
  let index = 0;
  for (const r of await ledgerOf(w, customer)) {
    money += BigInt(String(r.debit).replace('.', '')) - BigInt(String(r.credit).replace('.', ''));
    fine += BigInt(String(r.fine_debit).replace('.', '')) - BigInt(String(r.fine_credit).replace('.', ''));
    index++;
    if (BigInt(String(r.balance).replace('.', '')) !== money) return `row ${index} (${r.kind}): balance ${r.balance} is not the running sum ${money}`;
    if (BigInt(String(r.fine_balance).replace('.', '')) !== fine) return `row ${index} (${r.kind}): fine_balance ${r.fine_balance} is not the running sum ${fine}`;
  }
  return null;
}

/** V2 for one customer: the received, allocated, outstanding and advance figures (money), straight from the database half. */
export async function v2(w: EditWorld, customer: string): Promise<{ received: string; allocated: string; outstanding: string; advance: string; billed: string; fine_outstanding: string; fine_advance: string }> {
  const [r] = await rows(w, `SELECT received, allocated, outstanding, advance, billed, fine_outstanding, fine_advance FROM ${T.customer_balances} WHERE customer_balances.id = ?`, [customer]);
  return Object.fromEntries(Object.entries(r).map(([k, v]) => [k, String(v)])) as never;
}

/** The live (unreleased) allocations that point to an active receipt, summed for one bill. */
export async function liveOn(w: EditWorld, bill: string): Promise<{ money: string; fine: string }> {
  const [r] = await rows(
    w,
    `SELECT COALESCE(SUM(a.amount), 0) AS money, COALESCE(SUM(a.fine_grams), 0) AS fine FROM receipt_allocations a JOIN receipts r ON r.id = a.receipt_id WHERE a.bill_id = ? AND a.released_at IS NULL AND r.status = 'active'`,
    [bill],
  );
  return { money: String(r.money), fine: String(r.fine) };
}

export { trace };
