import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Connection } from 'mysql2/promise';
import { sleep } from '../helpers';
import { type Designs, addDesigns, billBody, countOf, item, piece, postBill } from './x01-support';
import { Gates, waitForLockWaits } from './x0-support';
import { type EditWorld, addBill, addCustomer, body, codeOf, editWorld, figures, newKey, pay, receiptsOf, rows } from './x02-support';
import { invariantsFor } from './x04-pair';

// API29, T-C14 (L5, X0 items 1 and 8): two IDENTICAL requests in flight at the same moment, through the real routes, with the test hook (`x02.after_read`, `create_bill.after_read`: the return of the
// state read, held by the test build's wrapper `Gates`; nothing of it is in src/). The first is held at its hook, which is after its claim: it owns the claim row and has not committed. The
// second, same key and same body, meets that row: its claim INSERT waits for the first to commit (or for the lock wait of 5 seconds).
//   - the first is held for LESS than 3 seconds: exactly one executes, the second returns the stored result (the same status and body, `Idempotent-Replay: true`), not an error;
//   - the first is held for 6.5 seconds: the second answers JV_BUSY after the 5-second lock wait (503, Retry-After), and its retry with the same key, once the first has committed, returns the
//     stored result. Nothing is saved twice either way.
// START STATE: a customer with one bill of 1,000 nobody has paid (record_payment); a customer and a piece in stock (create_bill).

let w: EditWorld;
let d: Designs;
let root: Connection;

beforeAll(async () => {
  w = await editWorld('x29repeat');
  d = await addDesigns(w);
  root = await w.world.scratch.root();
}, 120_000);
afterAll(async () => {
  await root?.end().catch(() => undefined);
  await w?.world.close();
}, 60_000);

/** Did the promise settle within `ms`? (a short look, never a wait for the result) */
const settledWithin = async (p: Promise<unknown>, ms: number): Promise<boolean> => Promise.race([p.then(() => true, () => true), sleep(ms).then(() => false)]);

const replay = (res: LightMyRequestResponse): string | undefined => res.headers['idempotent-replay'] as string | undefined;
const claimRows = (key: string) => rows(w, 'SELECT fn, actor, claim_token, result IS NOT NULL AS stored FROM sys_idempotency WHERE request_id = ?', [key]);

/** The start state of the payment tests: a bill A of 1,000, unpaid. */
async function startPayment() {
  const customer = await addCustomer(w);
  const bill = await addBill(w, customer, '1000.00', '2026-10-01');
  return { customer, bill, key: newKey(), payload: { amount: '600.00', mode: 'UPI' } };
}

describe('T-C14 two identical record_payment requests in flight, the first held at its hook for less than 3 seconds (L5, X0 item 8)', () => {
  it('exactly one executes and the second returns the stored result, not an error: one receipt, one claim, the same answer, Idempotent-Replay on the second only', async () => {
    const s = await startPayment();
    const gates = Gates.install();
    try {
      const g1 = gates.forNextSession(); // under 3 seconds: the lock wait of 5 seconds must still cut a session that waits longer
      const first = pay(w, 'biller', s.customer, s.payload, s.key);
      expect(await Promise.race([g1.reached, first.then((r) => `ended with ${r.statusCode} ${r.body}`)])).toBe('x02.after_read');
      const second = pay(w, 'biller', s.customer, s.payload, s.key);
      await waitForLockWaits(root, 1); // the second's claim INSERT is waiting for the first's row: the lock timeout, not a sleep, is what bounds this
      expect(await settledWithin(second, 150), 'the twin waits while the first is held').toBe(false);
      expect(g1.isAtHook).toBe(true);
      expect(gates.points.filter((p) => p.point === 'x02.after_read'), 'the twin never reached the state read').toHaveLength(1);
      g1.release();
      const [a, b] = await Promise.all([first, second]);
      expect(g1.autoReleased, 'a gate that let go by itself proves nothing').toBe(false);
      expect(g1.heldMs).toBeLessThan(3000);
      expect({ first: a.statusCode, second: b.statusCode }, `${a.body} ${b.body}`).toEqual({ first: 201, second: 201 });
      expect(replay(a), 'the first executed').toBeUndefined();
      expect(replay(b), 'the second returned the stored result').toBe('true');
      expect(b.body, 'the same body, byte for byte').toBe(a.body);
      expect(codeOf(b)).toBeUndefined();
      // saved once
      const receipts = await receiptsOf(w, s.customer);
      expect(receipts).toHaveLength(1);
      expect(String(receipts[0].id)).toBe(String(body(a).receipt.id));
      expect(await countOf(w, 'receipt_allocations', 'customer_id = ?', [s.customer])).toBe(1);
      expect(await figures(w, s.customer)).toMatchObject({ outstanding: '400.00', advance: '0.00' });
      expect(await claimRows(s.key)).toHaveLength(1);
      expect((await claimRows(s.key))[0]).toMatchObject({ fn: 'record_payment', stored: 1 });
      expect(await invariantsFor(w, s.customer)).toEqual([]);
    } finally {
      gates.restore();
    }
  });

  it('create_bill as well: one bill, one number, one piece sold; the second returns the stored bill', async () => {
    const customer = await addCustomer(w);
    const p = await piece(w, d.gold24pp, { retail: '700.00' });
    const key = newKey();
    const payload = billBody(customer, 'Retail', [item(p, { metal_rate: '700.00' })]);
    const numbersBefore = Number((await rows(w, 'SELECT COALESCE(SUM(last_value), 0) AS n FROM sys_counters'))[0].n);
    const gates = Gates.install();
    try {
      const g1 = gates.forNextSession();
      const first = postBill(w, 'biller', payload, key);
      expect(await Promise.race([g1.reached, first.then((r) => `ended with ${r.statusCode} ${r.body}`)])).toBe('create_bill.after_read');
      const second = postBill(w, 'biller', payload, key);
      await waitForLockWaits(root, 1);
      expect(await settledWithin(second, 150)).toBe(false);
      g1.release();
      const [a, b] = await Promise.all([first, second]);
      expect(g1.autoReleased).toBe(false);
      expect({ first: a.statusCode, second: b.statusCode }, `${a.body} ${b.body}`).toEqual({ first: 201, second: 201 });
      expect([replay(a), replay(b)]).toEqual([undefined, 'true']);
      expect(b.body).toBe(a.body);
      expect(await countOf(w, 'bills', 'customer_id = ?', [customer])).toBe(1);
      expect(await countOf(w, 'bill_items', 'sku_id = ?', [p])).toBe(1);
      expect(Number((await rows(w, 'SELECT COALESCE(SUM(last_value), 0) AS n FROM sys_counters'))[0].n), 'one number was used').toBe(numbersBefore + 1);
      expect(await invariantsFor(w, customer)).toEqual([]);
    } finally {
      gates.restore();
    }
  });
});

describe('T-C14 two identical record_payment requests in flight, the first held for 6.5 seconds: the second is JV_BUSY after the 5-second lock wait and its retry returns the stored result (L5, X0 item 7)', () => {
  it('the twin answers 503 JV_BUSY with Retry-After after about 5 seconds, changes nothing, and the retry with the same key, once the first has committed, returns the stored result', async () => {
    const s = await startPayment();
    const gates = Gates.install();
    try {
      const g1 = gates.forNextSession(6500);
      const first = pay(w, 'biller', s.customer, s.payload, s.key);
      expect(await Promise.race([g1.reached, first.then((r) => `ended with ${r.statusCode} ${r.body}`)])).toBe('x02.after_read');
      const startedAt = Date.now();
      const second = await pay(w, 'biller', s.customer, s.payload, s.key); // waits at the claim: ended by the lock wait timeout (innodb_lock_wait_timeout = 5), nothing else
      const waitedMs = Date.now() - startedAt;
      expect({ status: second.statusCode, code: codeOf(second) }, second.body).toEqual({ status: 503, code: 'JV_BUSY' });
      expect(second.headers['retry-after']).toBe('1');
      expect(replay(second)).toBeUndefined();
      // the twin got JV_BUSY, so the first still held its claim row for the whole lock wait: it is the lock timeout that ended the twin, not the deadline of 12 s or the handler timer of 25 s
      expect(waitedMs, 'the lock wait of 5 seconds').toBeGreaterThanOrEqual(4800);
      expect(waitedMs, 'before the deadline of 12 seconds').toBeLessThan(11_000);
      expect(await receiptsOf(w, s.customer), 'nothing is committed while the first is held').toEqual([]);
      const a = await first; // the gate lets go by itself at 6.5 seconds: that is the hold of this test, the longest a session is held anywhere
      expect(g1.autoReleased, 'the 6.5-second hold ran its course').toBe(true);
      expect(g1.heldMs).toBeGreaterThanOrEqual(6400);
      expect(a.statusCode, a.body).toBe(201);
      expect(replay(a)).toBeUndefined();
      // the retry of the screen: the same key, the same body
      const retry = await pay(w, 'biller', s.customer, s.payload, s.key);
      expect(retry.statusCode, retry.body).toBe(201);
      expect(replay(retry)).toBe('true');
      expect(retry.body).toBe(a.body);
      expect(await receiptsOf(w, s.customer)).toHaveLength(1);
      expect(await countOf(w, 'receipt_allocations', 'customer_id = ?', [s.customer])).toBe(1);
      expect(await figures(w, s.customer)).toMatchObject({ outstanding: '400.00', advance: '0.00' });
      expect(await claimRows(s.key)).toHaveLength(1);
      expect(await invariantsFor(w, s.customer)).toEqual([]);
    } finally {
      gates.restore();
    }
  }, 60_000);
});
