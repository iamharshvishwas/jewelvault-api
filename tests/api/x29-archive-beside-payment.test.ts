import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { timestampToWire } from '../../src/wire/format';
import { detailsOf, stampOf } from './edit-support';
import { addCustomer } from './x01-support';
import { withoutCustomerLock } from './x0-support';
import { type Call, invariantsFor, pair } from './x04-pair';
import { type EditWorld, body, codeOf, customerRow, editWorld, figures, receiptsOf } from './x02-support';
import { moneyBooks, payCall } from './x29-support';

// API29, T-C20 (A5, X0 items 3 and 8, K4): an archive beside a payment, through the real routes, with the test hook `archive_customer.after_check` (the return of the check of the archive, held by the
// test build's wrapper `Gates`; nothing of it is in src/) and `x02.after_read` of the payment. START STATE of every test: a customer whose balance, fine and advance are all zero (nothing at all
// is booked for them). A customer is never archived while holding money. With the customer-lock helper replaced by a no-op the same tests FAIL.
//   (1) the archive is held after its check, the payment starts: it waits for the customer lock, the archive commits, the payment is refused because the customer is archived (JV_CUSTOMER_ARCHIVED).
//   (2) the payment is held after its state read, the archive starts with the stamp its screen holds: the payment commits first (it leaves an advance) and the archive is refused. That stamp is
//       the one from before the payment, which moved the customer's `updated_at` (D23), so the refusal is JV_STALE (the screen reloads) and nothing is archived.
//   (3) the same, with the stamp the payment leaves: the stale check passes and the archive meets the books themselves, K4: 409 JV_NOT_ALLOWED naming `advance`.

let w: EditWorld;

beforeAll(async () => {
  w = await editWorld('x29archive');
}, 120_000);
afterAll(async () => {
  await w?.world.close();
}, 60_000);

const releases = ['S1first', 'S2first'] as const;
const ARCHIVE_TIME = '2026-10-17T10:00:00.000000Z';

/** The start state: a customer with nothing booked. */
const startSquare = () => addCustomer(w);

/** PATCH /v1/customers/:id by the owner with `archived_at`; `stamp` is read when the call is started (a pair starts it after the other session is held). */
const archiveCall = (customer: string, stamp: () => string | Promise<string>): Call => ({
  hook: 'archive_customer.after_check',
  start: async () => w.world.call('owner', 'PATCH', `/v1/customers/${customer}`, { payload: { expected_updated_at: await stamp(), changes: { archived_at: ARCHIVE_TIME } } }),
});

const archivedAt = async (customer: string): Promise<string | null> => (await customerRow(w, customer)).archived_at as string | null;

describe('T-C20 (1) start state: nothing booked: the archive is held after its check, record_payment of 500 starts (X0 items 3 and 8, K4)', () => {
  /** The archive commits; the payment, which waited for the customer lock, finds the customer archived and is refused. Nothing is booked. */
  async function expectLocked(customer: string, p: Awaited<ReturnType<typeof pair>>) {
    expect(p.secondAtHookWhileFirstHeld, 'the payment must still be waiting for the customer lock, not at its hook').toBe(false);
    expect(p.first.statusCode, p.first.body).toBe(200);
    expect(body(p.first).row.archived_at, 'the archive is committed').not.toBeNull();
    expect({ status: p.second.statusCode, code: codeOf(p.second) }, p.second.body).toEqual({ status: 409, code: 'JV_CUSTOMER_ARCHIVED' });
    expect(await archivedAt(customer)).not.toBeNull();
    expect(await receiptsOf(w, customer), 'the refused payment left no receipt').toEqual([]);
    expect(await moneyBooks(w, customer)).toMatchObject({ received: 0n, allocated: 0n, billed: 0n, advance: 0n });
    expect(await figures(w, customer)).toEqual({ outstanding: '0.00', advance: '0.00', fine_outstanding: '0.000', fine_advance: '0.000' });
    expect(p.autoReleased, 'a gate that let go by itself after 3 s proves nothing').toBe(false);
  }

  for (const release of releases) {
    it(`with the customer lock in place the payment waits, the archive commits and the payment is refused because the customer is archived (${release})`, async () => {
      const c = await startSquare();
      const stamp = await stampOf(w, 'customers', c);
      const p = await pair(archiveCall(c, () => stamp), payCall(w, c, '500.00'), release);
      await expectLocked(c, p);
      expect(p.points, 'the payment never got as far as reading the books').toEqual(['archive_customer.after_check']);
    });

    it(`NEGATIVE CONTROL: with the customer-lock helper replaced by a no-op the same test FAILS (${release}): the payment reads the customer not yet archived, and an advance of 500 is committed on an archived customer`, async () => {
      const undo = withoutCustomerLock();
      try {
        const c = await startSquare();
        const stamp = await stampOf(w, 'customers', c);
        const p = await pair(archiveCall(c, () => stamp), payCall(w, c, '500.00'), release);
        expect(p.secondAtHookWhileFirstHeld, 'without the lock the payment gets to its hook beside the held archive').toBe(true);
        expect([p.first.statusCode, p.second.statusCode], `${p.first.body} ${p.second.body}`).toEqual([200, 201]);
        expect(await archivedAt(c), 'the customer is archived').not.toBeNull();
        expect((await figures(w, c)).advance, 'and holds money').toBe('500.00');
        await expect(expectLocked(c, p)).rejects.toThrow();
      } finally {
        undo();
      }
    });
  }
});

describe('T-C20 (2) start state: nothing booked: record_payment of 500 is held after its state read, the archive starts with the stamp its screen holds (X0 items 3 and 8, K4, D23)', () => {
  /** The payment commits first and leaves an advance of 500; the archive, which waited, is refused (JV_STALE: the payment moved the stamp) with the fresh row, and nothing is archived. */
  async function expectLocked(customer: string, p: Awaited<ReturnType<typeof pair>>) {
    expect(p.secondAtHookWhileFirstHeld, 'the archive must still be waiting for the customer lock, not at its hook').toBe(false);
    expect(p.first.statusCode, p.first.body).toBe(201);
    expect(body(p.first).advance_remaining).toBe('500.00');
    expect({ status: p.second.statusCode, code: codeOf(p.second) }, p.second.body).toEqual({ status: 409, code: 'JV_STALE' });
    expect(await archivedAt(customer), 'a customer holding money is not archived').toBeNull();
    expect(detailsOf(p.second).current, 'the refusal carries the fresh row').toMatchObject({ id: customer, archived_at: null, updated_at: timestampToWire((await customerRow(w, customer)).updated_at) });
    expect(await figures(w, customer)).toMatchObject({ outstanding: '0.00', advance: '500.00' });
    expect(await invariantsFor(w, customer)).toEqual([]);
    expect(p.autoReleased, 'a gate that let go by itself after 3 s proves nothing').toBe(false);
  }

  for (const release of releases) {
    it(`with the customer lock in place the payment commits first and the archive is refused (${release}); the owner, shown the fresh row, is refused by the books as well`, async () => {
      const c = await startSquare();
      const stamp = await stampOf(w, 'customers', c);
      const p = await pair(payCall(w, c, '500.00'), archiveCall(c, () => stamp), release);
      await expectLocked(c, p);
      expect(p.points.filter((x) => x === 'x02.after_read')).toHaveLength(1);
      // the screen reloads with the row in the refusal and the owner tries again: now the books themselves say no (K4)
      const fresh = detailsOf(p.second).current.updated_at as string;
      const again = await w.world.call('owner', 'PATCH', `/v1/customers/${c}`, { payload: { expected_updated_at: fresh, changes: { archived_at: ARCHIVE_TIME } } });
      expect({ status: again.statusCode, code: codeOf(again) }, again.body).toEqual({ status: 409, code: 'JV_NOT_ALLOWED' });
      expect(detailsOf(again)).toMatchObject({ field: 'changes.archived_at', not_zero: ['advance'] });
      expect(await archivedAt(c)).toBeNull();
    });

    it(`NEGATIVE CONTROL: with the customer-lock helper replaced by a no-op the same test FAILS (${release}): the archive does not wait for the payment, reads a customer with nothing booked and archives it; the payment then commits 500 on it`, async () => {
      const undo = withoutCustomerLock();
      try {
        const c = await startSquare();
        const stamp = await stampOf(w, 'customers', c);
        const p = await pair(payCall(w, c, '500.00'), archiveCall(c, () => stamp), release);
        expect(p.secondAtHookWhileFirstHeld, 'without the lock the archive gets to its hook beside the held payment').toBe(true);
        expect([p.first.statusCode, p.second.statusCode], `${p.first.body} ${p.second.body}`).toEqual([201, 200]);
        expect(await archivedAt(c), 'the customer is archived').not.toBeNull();
        expect((await figures(w, c)).advance, 'and holds money').toBe('500.00');
        await expect(expectLocked(c, p)).rejects.toThrow();
      } finally {
        undo();
      }
    });
  }
});

describe('T-C20 (3) start state: nothing booked: record_payment of 500 is held, the archive starts with the stamp the payment leaves, so only the books can refuse it (K4 under the customer lock)', () => {
  /**
   * The stamp the held payment will write on the customer (D23): its one clock reading, taken right after the lock and before the hook. The archive is started while the payment is held, so
   * that reading is the latest one the clock gave. `sent` remembers it, so that the check afterwards can say what the archive was compared with.
   */
  let sent = '';
  const stampThePaymentLeaves = (): string => {
    sent = timestampToWire(w.time.readings[w.time.readings.length - 1].timestamp);
    return sent;
  };

  async function expectK4(customer: string, p: Awaited<ReturnType<typeof pair>>) {
    expect(p.secondAtHookWhileFirstHeld, 'the archive must still be waiting for the customer lock, not at its hook').toBe(false);
    expect(p.first.statusCode, p.first.body).toBe(201);
    expect(timestampToWire((await customerRow(w, customer)).updated_at), 'the payment left exactly the stamp the archive was sent with').toBe(sent);
    expect({ status: p.second.statusCode, code: codeOf(p.second) }, p.second.body).toEqual({ status: 409, code: 'JV_NOT_ALLOWED' });
    expect(detailsOf(p.second)).toMatchObject({ field: 'changes.archived_at', not_zero: ['advance'] });
    expect(await archivedAt(customer)).toBeNull();
    expect(await figures(w, customer)).toMatchObject({ outstanding: '0.00', advance: '500.00' });
    expect(p.points, 'the archive was held after its check even though it was refused').toContain('archive_customer.after_check');
    expect(p.autoReleased).toBe(false);
  }

  for (const release of releases) {
    it(`with the customer lock in place the archive waits for the payment, passes the stale check and is refused by the books: advance (${release})`, async () => {
      const c = await startSquare();
      const p = await pair(payCall(w, c, '500.00'), archiveCall(c, stampThePaymentLeaves), release);
      await expectK4(c, p);
    });

    it(`NEGATIVE CONTROL: with the customer-lock helper replaced by a no-op the same test FAILS (${release}): the archive does not wait for the payment, so the stamp it carries is not yet the row's and it is answered JV_STALE, never reaching the books`, async () => {
      const undo = withoutCustomerLock();
      try {
        const c = await startSquare();
        const p = await pair(payCall(w, c, '500.00'), archiveCall(c, stampThePaymentLeaves), release);
        expect({ status: p.second.statusCode, code: codeOf(p.second) }, p.second.body).toEqual({ status: 409, code: 'JV_STALE' });
        await expect(expectK4(c, p)).rejects.toThrow();
      } finally {
        undo();
      }
    });
  }
});
