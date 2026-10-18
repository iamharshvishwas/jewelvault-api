import type { LightMyRequestResponse } from 'fastify';
import type { CallerName } from './cells';
import { type EditWorld, body, newKey } from './x02-support';

// Shared by the tests of API28 (X11 issue_refund: POST /v1/customers/:id/refunds): the call itself and its answer. The fixtures (customers, bills, receipts, allocations typed by SQL, the reads of the
// books) are those of x02-support.ts and x04-support.ts; the advance a refund is paid out of is made with the real X2 record_payment, so these tests use two routes of the application together.

export type Payload = Record<string, unknown>;

/** POST /v1/customers/<id>/refunds with an Idempotency-Key (a new one unless given; null sends none). */
export function refund(w: EditWorld, caller: CallerName, customerId: string, payload: unknown, key: string | null = newKey(), headers: Record<string, string> = {}): Promise<LightMyRequestResponse> {
  return w.world.call(caller, 'POST', `/v1/customers/${customerId}/refunds`, { payload, headers: { ...(key === null ? {} : { 'idempotency-key': key }), ...headers } });
}

export interface RefundResult {
  receipt: Record<string, any>;
  /** money text: the customer's advance after the call (V2) */
  advance: string;
}

/** The refund is saved (201); returns the answer. */
export async function refunded(res: LightMyRequestResponse): Promise<RefundResult> {
  if (res.statusCode !== 201) throw new Error(`expected 201, got ${res.statusCode}: ${res.body}`);
  return body<RefundResult>(res);
}

/** A body for X11 that is valid; `extra` is merged over it. */
export const upi = (amount: string, extra: Payload = {}): Payload => ({ amount, mode: 'UPI', ...extra });
