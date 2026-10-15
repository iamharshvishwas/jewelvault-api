import type { Connection } from 'mysql2/promise';
export interface NewAllocation { id: string; receipt_id: string; bill_id: string; amount: string; fine_grams: string }
export interface RebalanceResult {
  allocations: NewAllocation[];
  /** Total rupees and grams of silver applied by this call. */
  applied: string;
  fine_applied: string;
}
export interface RebalanceOptions {
  /** Id generator for the new allocation rows; default crypto.randomUUID. */
  newId?: () => string;
}
/**
 * Y6 of the spec: apply a customer's advance (money received - live allocations - refunds; the same for silver) to their oldest pending bills, oldest receipt first,
 * and never change an existing allocation. The caller holds the customer lock and a transaction. The walk-in customer is never rebalanced (K5).
 * Amounts are exact (integers of paise and milligrams inside, text outside).
 */
export function rebalanceCustomer(conn: Connection, customerId: string, opts?: RebalanceOptions): Promise<RebalanceResult>;
/** '123.45' -> 12345n (scale 2) or '1.250' -> 1250n (scale 3); throws on a value with more decimals than the scale. */
export function toUnits(text: string, scale: number): bigint;
export function fromUnits(units: bigint, scale: number): string;
