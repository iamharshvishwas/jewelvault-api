import type { LightMyRequestResponse } from 'fastify';
import { expect } from 'vitest';
import { runInvariants } from '../../scripts/invariants.mjs';
import { Gates } from './x0-support';
import { type EditWorld, rows } from './x02-support';

// Shared by the two-session tests of API25 (T-C12 clauses for X4, T-C13 clauses for X5): two real calls for one customer at once, through the real routes, with the test hook of X0 item 8 (the test
// build's wrapper `Gates`: one gate for each session, nothing of it in src/). Session 1 is held at the hook point of its function for less than 3 seconds; session 2 is started; then the gates are
// released in the order the test asks. With the customer lock in place session 2 waits at the lock, not at the hook, so the order of release does not change the result.

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface Call {
  /** the hook point the function holds at: `x04.after_read`, `x05.after_read`, `x02.after_read`, `create_bill.after_read` */
  hook: string;
  /** makes the call (through the real route); it is started when the pair needs it */
  start: () => Promise<LightMyRequestResponse>;
}

export interface Pair {
  first: LightMyRequestResponse;
  second: LightMyRequestResponse;
  /** was session 2 at its hook while session 1 was still held at its own? (it must not be: it waits for the customer lock) */
  secondAtHookWhileFirstHeld: boolean;
  /** did a gate let go by itself after 3 seconds? (then the test proves nothing) */
  autoReleased: boolean;
  points: string[];
}

/** Session 1 is held at its hook; session 2 is started; then both are released in the order asked. The gates are always taken out again. */
export async function pair(a: Call, b: Call, order: 'S1first' | 'S2first'): Promise<Pair> {
  const gates = Gates.install();
  try {
    const g1 = gates.forNextSession();
    const call1 = a.start();
    const reached = await Promise.race([g1.reached, call1.then((r) => `session 1 ended with ${r.statusCode} ${r.body.slice(0, 200)} before it reached the hook`)]);
    expect(reached).toBe(a.hook);
    const g2 = gates.forNextSession();
    const call2 = b.start();
    await sleep(400); // session 2 has had time to reach the hook, if nothing stops it
    const secondAtHookWhileFirstHeld = g2.isAtHook;
    if (order === 'S2first') {
      g2.release();
      await sleep(300);
      g1.release();
    } else {
      g1.release();
      await sleep(300);
      g2.release();
    }
    const [first, second] = await Promise.all([call1, call2]);
    return { first, second, secondAtHookWhileFirstHeld, autoReleased: g1.autoReleased || g2.autoReleased, points: gates.points.map((p) => p.point) };
  } finally {
    gates.restore();
  }
}

/** The rules of I1 to I4 and I10 that name this customer, their bills, receipts or pieces, from the invariant files of the database half (another opinion than the code under test). */
export async function invariantsFor(w: EditWorld, customer: string): Promise<string[]> {
  const ids = new Set<string>([customer]);
  for (const r of await rows(w, 'SELECT id FROM bills WHERE customer_id = ?', [customer])) ids.add(String(r.id));
  for (const r of await rows(w, 'SELECT id FROM receipts WHERE customer_id = ?', [customer])) ids.add(String(r.id));
  for (const r of await rows(w, 'SELECT i.sku_id AS id FROM bill_items i JOIN bills b ON b.id = i.bill_id WHERE b.customer_id = ?', [customer])) ids.add(String(r.id));
  const out = await runInvariants(w.world.sql, { sample: 10_000 });
  return out.rows
    .filter((r: { invariant: string; row_ref: string }) => ['I1', 'I2', 'I3', 'I4', 'I10'].includes(r.invariant) && [...ids].some((id) => r.row_ref.includes(id)))
    .map((r: { invariant: string; row_ref: string; detail: string }) => `${r.invariant} ${r.row_ref}: ${r.detail}`);
}

/** Receipts that have more live allocations than they hold, and bills that have more than they cost: what two sessions that both applied the same money would leave. */
export async function overAllocated(w: EditWorld, customer: string): Promise<string[]> {
  const receipts = await rows(
    w,
    `SELECT r.id, r.amount, SUM(a.amount) AS used FROM receipts r JOIN receipt_allocations a ON a.receipt_id = r.id
     WHERE r.customer_id = ? AND r.status = 'active' AND a.released_at IS NULL GROUP BY r.id, r.amount HAVING SUM(a.amount) > r.amount`,
    [customer],
  );
  const bills = await rows(
    w,
    `SELECT b.id, b.grand_total, SUM(a.amount) AS used FROM bills b JOIN receipt_allocations a ON a.bill_id = b.id JOIN receipts r ON r.id = a.receipt_id
     WHERE b.customer_id = ? AND b.status = 'active' AND r.status = 'active' AND a.released_at IS NULL GROUP BY b.id, b.grand_total HAVING SUM(a.amount) > b.grand_total`,
    [customer],
  );
  return [...receipts.map((r) => `receipt ${r.id} holds ${r.amount} and has ${r.used} allocated`), ...bills.map((b) => `bill ${b.id} costs ${b.grand_total} and has ${b.used} allocated`)];
}
