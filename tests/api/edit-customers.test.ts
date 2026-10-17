import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as lockModule from '../../src/db/locks';
import * as state from '../../src/db/state';
import { V2_ONE_TEXT } from '../../src/db/state';
import { timestampToWire } from '../../src/wire/format';
import { ER, errorOf, sleep } from '../helpers';
import { V, insert } from '../schema/support';
import { addCustomer, patchCustomer } from './edit-13b-support';
import { type EditWorld, STAMP_DB, STAMP_WIRE, body, codeOf, dbRow, detailsOf, editWorld, snapshot } from './edit-support';
import { bodyOf, getPage } from './sync-support';
import { Gates } from './x0-support';

// API13b, the content columns of a customer (A4, A5, D10, Z3, D22, S6):
//   T-D04  (clause of A5) a biller edits a customer's content columns, and only the owner archives: here the owner's right to send `archived_at` and the biller's lack of it are proved.
//   T-C02  (K4, S7; API19) no role can delete a customer, and archiving is refused while outstanding, fine outstanding, advance or fine advance is not zero, under the customer lock (X0 item 3).
//          The interleaving of an archive beside a payment (T-C20) is API29's: it needs the payment function. What is proved here is the part that is the archive's own: the check is made under
//          the lock, and the session is held at `archive_customer.after_check` (the test side of the hook, tests/api/x0-support.ts) with the customer's row locked.
// PATCH /v1/customers/:id { expected_updated_at, changes } (the owner and a biller). A5: `name`, `mobile`, `customer_type`, `email`, `address`, `gst_number`, `pan`, `notes`; the owner also
// `archived_at`. A customer is made only by X6 (API19): these rows are typed in by hand, as the import will write them.

let w: EditWorld;
beforeAll(async () => {
  w = await editWorld('editcusts');
}, 120_000);
afterAll(async () => {
  await w?.world.close();
});

const user = (caller: 'owner' | 'staff' | 'biller') => w.world.fixtures[caller].userId;
const WALKIN = '00000000-0000-4000-8000-000000000001';

describe('T-D04 (A5 clause) a biller edits a customer\'s content columns: the stale check, the person columns and the stamps are those of every ordinary edit', () => {
  it('a biller changes every content column in one call: 200, the row a biller\'s sync read gives (mobile, GST and PAN included, A9), updated_by is the biller, the stamp is a reading of the API clock', async () => {
    const id = await addCustomer(w, { created_by: user('owner'), updated_by: user('owner') });
    const changes = {
      name: 'Meera Soni',
      mobile: '9812345678',
      customer_type: 'Wholesale',
      email: 'meera@example.test',
      address: '12 Sarafa Bazaar, Indore',
      gst_number: '23ABCDE1234F1Z5',
      pan: 'ABCDE1234F',
      notes: 'Prefers 22K.',
    };
    const res = await patchCustomer(w, 'biller', id, STAMP_WIRE, changes);
    expect(res.statusCode, res.body).toBe(200);
    const row = body(res).row;
    expect(row).toMatchObject({ id, ...changes, is_walkin: false, archived_at: null, created_by: user('owner'), updated_by: user('biller') });
    expect(row.updated_at > STAMP_WIRE).toBe(true);
    const stored = await dbRow(w, 'customers', id);
    expect(stored).toMatchObject({ name: 'Meera Soni', mobile: '9812345678', customer_type: 'Wholesale', pan: 'ABCDE1234F', created_by: user('owner'), updated_by: user('biller'), created_at: STAMP_DB });
    expect(w.time.readings.map((r) => r.timestamp)).toContain(stored.updated_at);
    expect(timestampToWire(stored.updated_at)).toBe(row.updated_at);
    const page = bodyOf(await getPage(w.world, 'biller', 'customers'));
    expect(page.rows.find((r) => r.id === id)).toEqual(row);
  });

  it('only the changed fields are sent and only they change; the owner may edit too', async () => {
    const id = await addCustomer(w, { mobile: '9000000001', notes: 'old' });
    const before = await dbRow(w, 'customers', id);
    const res = await patchCustomer(w, 'owner', id, STAMP_WIRE, { notes: 'new' });
    expect(res.statusCode, res.body).toBe(200);
    const after = await dbRow(w, 'customers', id);
    expect(after).toMatchObject({ notes: 'new', mobile: before.mobile, name: before.name, updated_by: user('owner') });
  });

  it('a stale edit changes nothing and answers 409 JV_STALE with the current row, cut to the caller\'s columns (T-C07 for a customer)', async () => {
    const id = await addCustomer(w);
    const first = await patchCustomer(w, 'biller', id, STAMP_WIRE, { name: 'First' });
    expect(first.statusCode, first.body).toBe(200);
    const before = await snapshot(w, 'customers', id);
    const late = await patchCustomer(w, 'owner', id, STAMP_WIRE, { name: 'Second' });
    expect(late.statusCode).toBe(409);
    expect(codeOf(late)).toBe('JV_STALE');
    expect(detailsOf(late).current).toEqual(body(first).row);
    expect(await snapshot(w, 'customers', id)).toBe(before);
  });

  it('a change to the value already stored writes nothing (no stamp, no person column)', async () => {
    const id = await addCustomer(w, { notes: 'same' });
    const before = await snapshot(w, 'customers', id);
    const res = await patchCustomer(w, 'biller', id, STAMP_WIRE, { notes: 'same', name: 'Fixture Customer' });
    expect(res.statusCode, res.body).toBe(200);
    expect(await snapshot(w, 'customers', id)).toBe(before);
  });

  it('a customer that does not exist is 404; staff and a user who must change the password are refused by the matrix (403)', async () => {
    const missing = await patchCustomer(w, 'biller', randomUUID(), STAMP_WIRE, { name: 'X' });
    expect([missing.statusCode, codeOf(missing)]).toEqual([404, 'JV_NOT_FOUND']);
    const id = await addCustomer(w);
    const before = await snapshot(w, 'customers', id);
    const staff = await patchCustomer(w, 'staff', id, STAMP_WIRE, { name: 'X' });
    expect([staff.statusCode, codeOf(staff)]).toEqual([403, 'JV_FORBIDDEN']);
    const mustChange = await patchCustomer(w, 'must_change', id, STAMP_WIRE, { name: 'X' });
    expect(mustChange.statusCode).toBe(403);
    expect(await snapshot(w, 'customers', id)).toBe(before);
  });
});

describe('T-D04 (A5 clause) only the owner archives: a biller sending archived_at is 403 JV_FORBIDDEN and the whole call is refused', () => {
  it('a biller\'s archived_at, alone or beside a field that is allowed, is 403 naming the field; nothing is applied', async () => {
    const id = await addCustomer(w);
    const before = await snapshot(w, 'customers', id);
    for (const value of ['2026-10-17T10:00:00.000000Z', null]) {
      for (const changes of [{ archived_at: value }, { notes: 'applied?', archived_at: value }]) {
        const res = await patchCustomer(w, 'biller', id, STAMP_WIRE, changes);
        expect(res.statusCode, JSON.stringify(changes)).toBe(403);
        expect(codeOf(res)).toBe('JV_FORBIDDEN');
        expect(detailsOf(res)).toEqual({ field: 'changes.archived_at' });
      }
    }
    expect(await snapshot(w, 'customers', id)).toBe(before);
  });

  it('the owner archives: 200, archived_at is a reading of the API clock (the time sent is only "now", S6), updated_by is the owner; the row stays and every read role reads it (A4)', async () => {
    const id = await addCustomer(w);
    const res = await patchCustomer(w, 'owner', id, STAMP_WIRE, { archived_at: '2020-01-01T00:00:00.000000Z' });
    expect(res.statusCode, res.body).toBe(200);
    const stored = await dbRow(w, 'customers', id);
    expect(stored.archived_at).not.toBeNull();
    expect(w.time.readings.map((r) => r.timestamp)).toContain(stored.archived_at);
    expect(stored.archived_at).toBe(stored.updated_at);
    expect(body(res).row.archived_at).toBe(timestampToWire(stored.archived_at));
    expect(stored.updated_by).toBe(user('owner'));
    const page = bodyOf(await getPage(w.world, 'biller', 'customers'));
    expect(page.rows.find((r) => r.id === id)?.archived_at).toBe(body(res).row.archived_at);
  });

  it('the owner brings a customer back (archived_at null), and archiving an archived customer again keeps the first archive time', async () => {
    const id = await addCustomer(w);
    const first = body(await patchCustomer(w, 'owner', id, STAMP_WIRE, { archived_at: '2026-10-17T10:00:00.000000Z' })).row;
    w.time.time.micros += 3_600_000_000n;
    const again = await patchCustomer(w, 'owner', id, first.updated_at, { archived_at: '2026-10-17T11:00:00.000000Z' });
    expect(again.statusCode, again.body).toBe(200);
    expect(body(again).row.archived_at).toBe(first.archived_at);
    expect(body(again).row.updated_at).toBe(first.updated_at); // no change, no write
    const back = await patchCustomer(w, 'owner', id, first.updated_at, { archived_at: null });
    expect(back.statusCode, back.body).toBe(200);
    expect(body(back).row.archived_at).toBeNull();
    expect((await dbRow(w, 'customers', id)).archived_at).toBeNull();
  });

  it('the walk-in is never archived and never holds a PAN (D10): 409 JV_NOT_ALLOWED from the owner and a biller, before the database\'s CHECK is asked', async () => {
    const stamp = timestampToWire((await dbRow(w, 'customers', WALKIN)).updated_at);
    const before = await snapshot(w, 'customers', WALKIN);
    const archive = await patchCustomer(w, 'owner', WALKIN, stamp, { archived_at: '2026-10-17T10:00:00.000000Z' });
    expect([archive.statusCode, codeOf(archive), detailsOf(archive)]).toEqual([409, 'JV_NOT_ALLOWED', { field: 'changes.archived_at' }]);
    const pan = await patchCustomer(w, 'biller', WALKIN, stamp, { pan: 'ABCDE1234F' });
    expect([pan.statusCode, codeOf(pan), detailsOf(pan)]).toEqual([409, 'JV_NOT_ALLOWED', { field: 'changes.pan' }]);
    expect(await snapshot(w, 'customers', WALKIN)).toBe(before);
  });

});

// ------------------------------------------------------------------ T-C02, K4

/** 17 Oct 2026, 10:00 UTC: what the owner sends as `archived_at` (the server stores its own reading, S6). */
const NOW = '2026-10-17T10:00:00.000000Z';
const ARCHIVE = { archived_at: NOW };

/** A bill typed in by hand for a customer (X1 is API20's). `o` overrides any column. */
const addBill = async (customer: string, o: Record<string, unknown> = {}): Promise<string> => (await insert(w.world.sql, 'bills', V.bill(customer, { created_at: STAMP_DB, updated_at: STAMP_DB, ...o }))).id as string;
const addReceipt = async (customer: string, o: Record<string, unknown> = {}): Promise<string> => (await insert(w.world.sql, 'receipts', V.receipt(customer, { created_at: STAMP_DB, updated_at: STAMP_DB, ...o }))).id as string;
const allocate = async (receipt: string, bill: string, customer: string, o: Record<string, unknown> = {}): Promise<string> =>
  (await insert(w.world.sql, 'receipt_allocations', V.allocation(receipt, bill, customer, { created_at: STAMP_DB, updated_at: STAMP_DB, ...o }))).id as string;
const silver = (o: Record<string, unknown> = {}) => ({ kind: 'fine_silver', mode: null, amount: '0.00', ...o });
/** The four figures of K4 for one customer, worked out by the code under test's own V2 text on the ten-box user's connection (a second opinion on the fixture, not on the rule). */
async function figures(customer: string) {
  const [rows] = await w.world.sql.query<any[]>(V2_ONE_TEXT.replace('?', w.world.sql.escape(customer)));
  const r = (rows as any[])[0];
  return { outstanding: r.outstanding, fine_outstanding: r.fine_outstanding, advance: r.advance, fine_advance: r.fine_advance };
}

describe('T-C02 (K4, S7) archiving is refused while outstanding, fine outstanding, advance or fine advance is not zero', () => {
  /** The owner's archive is refused 409 JV_NOT_ALLOWED naming the field and the figures that are not zero; nothing is written (no new stamp). */
  async function refusedFor(id: string, notZero: string[]) {
    const before = await snapshot(w, 'customers', id);
    const sent = w.world.spy.sent.length;
    const res = await patchCustomer(w, 'owner', id, STAMP_WIRE, ARCHIVE);
    expect([res.statusCode, codeOf(res), detailsOf(res)], res.body).toEqual([409, 'JV_NOT_ALLOWED', { field: 'changes.archived_at', not_zero: notZero }]);
    expect(await snapshot(w, 'customers', id)).toBe(before);
    expect(w.world.spy.sqls().slice(sent).some((q) => /^UPDATE `?customers`?\b/i.test(q)), 'a refused archive wrote').toBe(false);
  }

  it('outstanding: a bill nobody has paid', async () => {
    const id = await addCustomer(w);
    await addBill(id, { grand_total: '1000.00', subtotal: '1000.00' });
    expect(await figures(id)).toEqual({ outstanding: '1000.00', fine_outstanding: '0.000', advance: '0.00', fine_advance: '0.000' });
    await refusedFor(id, ['outstanding']);
  });

  it('outstanding: a bill part paid (300 of 1,000) still owes 700', async () => {
    const id = await addCustomer(w);
    const bill = await addBill(id, { grand_total: '1000.00', subtotal: '1000.00' });
    await allocate(await addReceipt(id, { amount: '300.00' }), bill, id, { amount: '300.00' });
    expect((await figures(id)).outstanding).toBe('700.00');
    await refusedFor(id, ['outstanding']);
  });

  it('fine outstanding: silver grams due on a bill that is paid in money', async () => {
    const id = await addCustomer(w);
    await addBill(id, { grand_total: '0.00', subtotal: '0.00', fine_weight_due: '5.000' });
    expect(await figures(id)).toEqual({ outstanding: '0.00', fine_outstanding: '5.000', advance: '0.00', fine_advance: '0.000' });
    await refusedFor(id, ['fine_outstanding']);
  });

  it('advance: money received and not applied to a bill', async () => {
    const id = await addCustomer(w);
    await addReceipt(id, { amount: '500.00' });
    expect(await figures(id)).toEqual({ outstanding: '0.00', fine_outstanding: '0.000', advance: '500.00', fine_advance: '0.000' });
    await refusedFor(id, ['advance']);
  });

  it('fine advance: silver grams received and not applied to a bill', async () => {
    const id = await addCustomer(w);
    await addReceipt(id, silver({ fine_grams: '3.000' }));
    expect(await figures(id)).toEqual({ outstanding: '0.00', fine_outstanding: '0.000', advance: '0.00', fine_advance: '3.000' });
    await refusedFor(id, ['fine_advance']);
  });

  it('any one of the four is enough, and all four are named when all four are not zero', async () => {
    const id = await addCustomer(w);
    await addBill(id, { grand_total: '800.00', subtotal: '800.00', fine_weight_due: '2.000' });
    await addReceipt(id, { amount: '50.00' });
    await addReceipt(id, silver({ fine_grams: '1.000' }));
    expect(await figures(id)).toEqual({ outstanding: '800.00', fine_outstanding: '2.000', advance: '50.00', fine_advance: '1.000' });
    await refusedFor(id, ['outstanding', 'fine_outstanding', 'advance', 'fine_advance']);
  });

  it('one paisa and one milligram are enough (the figures are compared as exact decimals, not as floats)', async () => {
    const cheap = await addCustomer(w);
    await addReceipt(cheap, { amount: '0.01' }); // a bill is a whole number of rupees (D13), a receipt is not
    await refusedFor(cheap, ['advance']);
    const grain = await addCustomer(w);
    await addReceipt(grain, silver({ fine_grams: '0.001' }));
    await refusedFor(grain, ['fine_advance']);
  });

  it('a customer who owes nothing is archived: paid in full, silver settled, a cancelled bill, a voided receipt, a refunded advance; the bills and receipts stay (K4)', async () => {
    const paid = await addCustomer(w);
    const b = await addBill(paid, { grand_total: '1000.00', subtotal: '1000.00', fine_weight_due: '5.000' });
    await allocate(await addReceipt(paid, { amount: '1000.00' }), b, paid, { amount: '1000.00' });
    await allocate(await addReceipt(paid, silver({ fine_grams: '5.000' })), b, paid, { amount: '0.00', fine_grams: '5.000' });
    const cancelled = await addCustomer(w);
    await addBill(cancelled, { grand_total: '500.00', subtotal: '500.00', status: 'cancelled', cancel_reason: 'wrong customer', cancelled_at: '2026-10-04 09:00:00.000000', cancelled_on: '2026-10-04', cancelled_by: user('owner') });
    const voided = await addCustomer(w);
    await addReceipt(voided, { amount: '250.00', status: 'voided', void_reason: 'entered twice', voided_at: '2026-10-10 10:00:00.000000', voided_on: '2026-10-10', voided_by: user('owner') });
    const refunded = await addCustomer(w);
    await addReceipt(refunded, { amount: '400.00' });
    await addReceipt(refunded, { kind: 'refund', amount: '400.00', mode: 'Cash' });
    const empty = await addCustomer(w);

    for (const id of [paid, cancelled, voided, refunded, empty]) {
      expect(await figures(id), id).toEqual({ outstanding: expect.stringMatching(/^0\.00$/), fine_outstanding: '0.000', advance: expect.stringMatching(/^0\.00$/), fine_advance: '0.000' });
      const bills = Number((((await w.world.sql.query<any[]>('SELECT COUNT(*) AS n FROM bills WHERE customer_id = ?', [id]))[0] as any[])[0] as { n: number }).n);
      const receipts = Number((((await w.world.sql.query<any[]>('SELECT COUNT(*) AS n FROM receipts WHERE customer_id = ?', [id]))[0] as any[])[0] as { n: number }).n);
      const res = await patchCustomer(w, 'owner', id, STAMP_WIRE, ARCHIVE);
      expect(res.statusCode, `${id}: ${res.body}`).toBe(200);
      expect(body(res).row.archived_at).not.toBeNull();
      expect((await dbRow(w, 'customers', id)).archived_at).not.toBeNull();
      expect(Number((((await w.world.sql.query<any[]>('SELECT COUNT(*) AS n FROM bills WHERE customer_id = ?', [id]))[0] as any[])[0] as { n: number }).n), 'bills stay').toBe(bills);
      expect(Number((((await w.world.sql.query<any[]>('SELECT COUNT(*) AS n FROM receipts WHERE customer_id = ?', [id]))[0] as any[])[0] as { n: number }).n), 'receipts stay').toBe(receipts);
    }
  });

  it('the same customer is archived once the books are square: refused with a bill owing, 200 after the receipt pays it', async () => {
    const id = await addCustomer(w);
    const bill = await addBill(id, { grand_total: '1000.00', subtotal: '1000.00' });
    await refusedFor(id, ['outstanding']);
    await allocate(await addReceipt(id, { amount: '1000.00' }), bill, id, { amount: '1000.00' });
    const res = await patchCustomer(w, 'owner', id, STAMP_WIRE, ARCHIVE);
    expect(res.statusCode, res.body).toBe(200);
  });

  it('the rule is for the archive only: a customer who owes can be edited, and an archived customer can be brought back, whatever the books say', async () => {
    const id = await addCustomer(w);
    await addBill(id, { grand_total: '1000.00', subtotal: '1000.00' });
    const edit = await patchCustomer(w, 'biller', id, STAMP_WIRE, { notes: 'still owes' });
    expect(edit.statusCode, edit.body).toBe(200);
    const back = await addCustomer(w, { archived_at: '2026-10-05 08:00:00.000000' });
    await addReceipt(back, { amount: '10.00' }); // money arrived on an archived customer by hand: bringing them back is not refused
    const res = await patchCustomer(w, 'owner', back, STAMP_WIRE, { archived_at: null });
    expect(res.statusCode, res.body).toBe(200);
    expect(body(res).row.archived_at).toBeNull();
  });

  it('the walk-in is refused first and for its own reason, with or without dues (D10, K5): 409 on archived_at, no figure named', async () => {
    const bill = await addBill(WALKIN, { grand_total: '250.00', subtotal: '250.00' });
    const stamp = timestampToWire((await dbRow(w, 'customers', WALKIN)).updated_at);
    const res = await patchCustomer(w, 'owner', WALKIN, stamp, ARCHIVE);
    expect([res.statusCode, codeOf(res), detailsOf(res)]).toEqual([409, 'JV_NOT_ALLOWED', { field: 'changes.archived_at' }]);
    expect((await dbRow(w, 'customers', WALKIN)).archived_at).toBeNull();
    expect(bill).toBeTruthy();
  });

  it('a biller cannot archive, owing or not (403, as before: the role is checked before the books are read)', async () => {
    const owes = await addCustomer(w);
    await addBill(owes, { grand_total: '10.00', subtotal: '10.00' });
    const square = await addCustomer(w);
    for (const id of [owes, square]) {
      const sent = w.world.spy.sent.length;
      const res = await patchCustomer(w, 'biller', id, STAMP_WIRE, ARCHIVE);
      expect([res.statusCode, codeOf(res)]).toEqual([403, 'JV_FORBIDDEN']);
      expect(w.world.spy.sqls().slice(sent).some((q) => q === V2_ONE_TEXT), 'the books were read for a biller').toBe(false);
    }
  });
});

describe('T-C02 (K4, X0 item 3) the check is made under the customer lock, and the archive path has its pause point', () => {
  it('the customer row is locked FOR UPDATE before the books are read, the books are read once, and an edit that is not an archive reads no books at all', async () => {
    const id = await addCustomer(w);
    const sent = w.world.spy.sent.length;
    const lockSpy = vi.spyOn(lockModule, 'lockCustomer'); // not replaced: the real helper runs, the spy only notes the call
    const totalsSpy = vi.spyOn(state, 'readCustomerTotals');
    let res;
    let seen: { locked: unknown[]; read: unknown[]; lockFirst: boolean };
    try {
      res = await patchCustomer(w, 'owner', id, STAMP_WIRE, ARCHIVE);
    } finally {
      seen = {
        locked: lockSpy.mock.calls.map((c) => c[1]),
        read: totalsSpy.mock.calls.map((c) => [c[1].fn, c[1].customerId]),
        lockFirst: lockSpy.mock.invocationCallOrder[0] < totalsSpy.mock.invocationCallOrder[0],
      };
      lockSpy.mockRestore();
      totalsSpy.mockRestore();
    }
    expect(res.statusCode, res.body).toBe(200);
    // the written order of X0 item 3: the customer lock helper, once, for this customer, and only then the books of the archive
    expect(seen.locked).toEqual([id]);
    expect(seen.read).toEqual([['archive_customer', id]]);
    expect(seen.lockFirst).toBe(true);
    const mine = w.world.spy.sqls().slice(sent);
    const totals = mine.map((q, i) => (q === V2_ONE_TEXT ? i : -1)).filter((i) => i >= 0);
    expect(totals).toHaveLength(1);
    const locks = mine.map((q, i) => (/\bFROM customers WHERE id = \? FOR UPDATE$/.test(q.trim()) ? i : -1)).filter((i) => i >= 0);
    expect(locks.length).toBeGreaterThanOrEqual(1);
    expect(locks[0]).toBeLessThan(totals[0]);
    const update = mine.findIndex((q) => /^UPDATE `?customers`?\b/i.test(q));
    expect(update).toBeGreaterThan(totals[0]); // the write comes after the check
    expect(mine.findIndex((q) => q.trim() === 'COMMIT')).toBeGreaterThan(update);

    const other = await addCustomer(w);
    const sent2 = w.world.spy.sent.length;
    expect((await patchCustomer(w, 'owner', other, STAMP_WIRE, { notes: 'not an archive' })).statusCode).toBe(200);
    expect(w.world.spy.sqls().slice(sent2).includes(V2_ONE_TEXT)).toBe(false);
  });

  it('archive_customer.after_check: a session archiving a square customer is held after its check with the customer row locked; another session cannot take the lock until it is released, and the archive then commits', async () => {
    const id = await addCustomer(w);
    const gates = Gates.install();
    const other = await w.world.scratch.connect();
    try {
      await other.query('SET SESSION innodb_lock_wait_timeout = 1');
      const held = gates.forNextSession();
      const archive = patchCustomer(w, 'owner', id, STAMP_WIRE, ARCHIVE);
      expect(await Promise.race([held.reached, sleep(2000).then(() => 'never reached')])).toBe('archive_customer.after_check');
      expect(held.isAtHook).toBe(true);
      // what a payment does first: ask for the customer's row FOR UPDATE. It must wait, and with a 1 s limit it times out; a plain read does not wait and sees the customer not yet archived
      const waited = await errorOf(() => other.query('SELECT id FROM customers WHERE id = ? FOR UPDATE', [id]));
      expect(waited?.errno).toBe(ER.LOCK_WAIT_TIMEOUT);
      const [seen] = await other.query<any[]>('SELECT archived_at FROM customers WHERE id = ?', [id]);
      expect((seen as any[])[0].archived_at).toBeNull();
      expect(held.autoReleased, 'the gate was open for less than 3 seconds').toBe(false);
      held.release();
      const res = await archive;
      expect(res.statusCode, res.body).toBe(200);
      const [after] = await other.query<any[]>('SELECT archived_at FROM customers WHERE id = ?', [id]);
      expect((after as any[])[0].archived_at).not.toBeNull();
      expect(gates.points.filter((p) => p.point === 'archive_customer.after_check')).toHaveLength(1);
    } finally {
      gates.restore();
      await other.end().catch(() => undefined);
    }
  });

  it('a refused archive is held at the same point (the check is the hook, not its outcome) and ends in the refusal; an edit that is not an archive never reaches the point', async () => {
    const owes = await addCustomer(w);
    await addBill(owes, { grand_total: '1000.00', subtotal: '1000.00' });
    const gates = Gates.install();
    try {
      const held = gates.forNextSession();
      const archive = patchCustomer(w, 'owner', owes, STAMP_WIRE, ARCHIVE);
      expect(await Promise.race([held.reached, sleep(2000).then(() => 'never reached')])).toBe('archive_customer.after_check');
      held.release();
      const res = await archive;
      expect([res.statusCode, codeOf(res)]).toEqual([409, 'JV_NOT_ALLOWED']);
      const before = gates.points.length;
      const plain = await addCustomer(w);
      expect((await patchCustomer(w, 'biller', plain, STAMP_WIRE, { notes: 'plain' })).statusCode).toBe(200);
      expect(gates.points.length).toBe(before);
    } finally {
      gates.restore();
    }
  });
});

describe('T-C02 (S7) no role can delete a customer', () => {
  it('there is no route that deletes anything, and DELETE on the customer addresses is 404 for the owner, a biller, staff and a visitor with no session', async () => {
    expect(w.world.app.routeTable.filter((r) => (r.method as string) === 'DELETE')).toEqual([]);
    const id = await addCustomer(w);
    for (const caller of ['owner', 'biller', 'staff', 'anon'] as const) {
      for (const url of [`/v1/customers/${id}`, `/v1/customers/${WALKIN}`, '/v1/customers']) {
        const res = await w.world.call(caller, 'DELETE', url);
        expect([caller, url, res.statusCode, codeOf(res)]).toEqual([caller, url, 404, 'JV_NOT_FOUND']);
      }
    }
    expect((await dbRow(w, 'customers', id)).id).toBe(id);
    expect((await dbRow(w, 'customers', WALKIN)).id).toBe(WALKIN);
  });

  it('an edit has no way to remove a row either: no delete flag, and the archive keeps the row (the sync read still gives it, A4)', async () => {
    const id = await addCustomer(w);
    for (const field of ['deleted', 'deleted_at', 'removed', 'is_deleted']) {
      const res = await patchCustomer(w, 'owner', id, STAMP_WIRE, { [field]: true });
      expect([res.statusCode, codeOf(res)], field).toEqual([422, 'JV_INVALID_INPUT']);
    }
    expect((await patchCustomer(w, 'owner', id, STAMP_WIRE, ARCHIVE)).statusCode).toBe(200);
    const page = bodyOf(await getPage(w.world, 'biller', 'customers'));
    expect(page.rows.find((r) => r.id === id)?.archived_at).not.toBeNull();
  });

  it('and the database user the API uses cannot: DELETE and TRUNCATE on customers are refused by MariaDB (error 1142), for a customer and for the walk-in', async () => {
    const id = await addCustomer(w);
    for (const [sql, params] of [
      ['DELETE FROM customers WHERE id = ?', [id]],
      ['DELETE FROM customers WHERE id = ?', [WALKIN]],
      ['TRUNCATE TABLE customers', []],
    ] as const) {
      const e = await errorOf(() => w.world.sql.query(sql, [...params]));
      expect([sql, e?.errno]).toEqual([sql, 1142]);
    }
    expect((await dbRow(w, 'customers', id)).id).toBe(id);
  });
});

describe('the content columns are checked like a new customer\'s (D10, Z3): a refusal names the field and stores nothing', () => {
  const refused = async (changes: Record<string, unknown>, field: string, extra: Record<string, unknown> = {}) => {
    const id = await addCustomer(w, extra);
    const before = await snapshot(w, 'customers', id);
    const res = await patchCustomer(w, 'biller', id, STAMP_WIRE, changes);
    expect([JSON.stringify(changes).slice(0, 60), res.statusCode, detailsOf(res)]).toEqual([JSON.stringify(changes).slice(0, 60), 422, { field: `changes.${field}` }]);
    expect(await snapshot(w, 'customers', id)).toBe(before);
  };

  it('name: 1 to 120 characters, trimmed, text', async () => {
    for (const name of ['', '   ', 'x'.repeat(121), 5, null]) await refused({ name }, 'name');
    const id = await addCustomer(w);
    const ok = await patchCustomer(w, 'biller', id, STAMP_WIRE, { name: `  ${'x'.repeat(120)}  ` });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(body(ok).row.name).toBe('x'.repeat(120));
  });

  it('mobile: ten digits, or + and 7 to 15 digits; spaces and dashes are taken out on entry (D10, O33)', async () => {
    for (const mobile of ['12345', '98765432101', 'abcdefghij', '+12345', '+1234567890123456', '++441234567890', '98765 4321', 9876543210]) await refused({ mobile }, 'mobile');
    const id = await addCustomer(w);
    let stamp = STAMP_WIRE;
    for (const [sent, stored] of [
      ['98765 43210', '9876543210'],
      ['98765-43210', '9876543210'],
      [' 9876543211 ', '9876543211'],
      ['+44 20-7946 0958', '+442079460958'],
      ['+1234567', '+1234567'],
      ['+123456789012345', '+123456789012345'],
    ] as const) {
      const res = await patchCustomer(w, 'biller', id, stamp, { mobile: sent });
      expect(res.statusCode, sent).toBe(200);
      expect(body(res).row.mobile, sent).toBe(stored);
      expect((await dbRow(w, 'customers', id)).mobile).toBe(stored);
      stamp = body(res).row.updated_at;
    }
  });

  it('mobile: a named customer must keep one (null or blank is 422); an imported customer may have none (the CHECK of D10), so the screen can ask when it is selected', async () => {
    await refused({ mobile: null }, 'mobile');
    await refused({ mobile: '' }, 'mobile');
    await refused({ mobile: ' - ' }, 'mobile');
    const batch = randomUUID();
    await w.world.sql.query('INSERT INTO sys_import_batches (id, name) VALUES (?, ?)', [batch, `batch ${batch}`]);
    const id = await addCustomer(w, { mobile: null, import_batch_id: batch });
    const noMobile = await patchCustomer(w, 'biller', id, STAMP_WIRE, { notes: 'asked for the number' });
    expect(noMobile.statusCode, noMobile.body).toBe(200);
    const typed = await patchCustomer(w, 'biller', id, body(noMobile).row.updated_at, { mobile: '9811111111' });
    expect(typed.statusCode, typed.body).toBe(200);
    const blank = await patchCustomer(w, 'biller', id, body(typed).row.updated_at, { mobile: null });
    expect(blank.statusCode, blank.body).toBe(200);
    expect((await dbRow(w, 'customers', id)).mobile).toBeNull();
  });

  it('customer_type: Retail, Semi-Wholesale or Wholesale', async () => {
    for (const customer_type of ['VIP', 'retail', '', null, 1]) await refused({ customer_type }, 'customer_type');
    const id = await addCustomer(w);
    const res = await patchCustomer(w, 'biller', id, STAMP_WIRE, { customer_type: 'Semi-Wholesale' });
    expect(res.statusCode, res.body).toBe(200);
  });

  it('pan: five capital letters, four digits, one capital letter, checked before the CHECK; blank or null clears it (Z3)', async () => {
    for (const pan of ['abcde1234f', 'ABCDE1234', 'ABCDE12345', 'ABCD1234EF', 'ABCDE1234FG', ' ABCDE1234F', 'ABCDE-1234F', 5]) await refused({ pan }, 'pan');
    const id = await addCustomer(w);
    const set = await patchCustomer(w, 'biller', id, STAMP_WIRE, { pan: 'ABCDE1234F' });
    expect(set.statusCode, set.body).toBe(200);
    expect(body(set).row.pan).toBe('ABCDE1234F');
    const blank = await patchCustomer(w, 'biller', id, body(set).row.updated_at, { pan: '' });
    expect(blank.statusCode, blank.body).toBe(200);
    expect(body(blank).row.pan).toBeNull();
    const again = await patchCustomer(w, 'biller', id, body(blank).row.updated_at, { pan: 'ABCDE1234F' });
    const cleared = await patchCustomer(w, 'biller', id, body(again).row.updated_at, { pan: null });
    expect(body(cleared).row.pan).toBeNull();
  });

  it('email, address, GST number and notes: text of the column\'s width, trimmed, blank means none', async () => {
    await refused({ email: 'x'.repeat(255) }, 'email');
    await refused({ address: 'x'.repeat(501) }, 'address');
    await refused({ gst_number: 'x'.repeat(21) }, 'gst_number');
    await refused({ notes: 'x'.repeat(10_001) }, 'notes');
    await refused({ address: 5 }, 'address');
    const id = await addCustomer(w, { email: 'a@example.test', address: 'somewhere', gst_number: '23ABCDE1234F1Z5', notes: 'n' });
    const res = await patchCustomer(w, 'biller', id, STAMP_WIRE, { email: '  ', address: '', gst_number: null, notes: ' ' });
    expect(res.statusCode, res.body).toBe(200);
    expect(body(res).row).toMatchObject({ email: null, address: null, gst_number: null, notes: null });
  });

  it('the columns that are no content column are real columns on nobody\'s list (403), and the stamps and person columns are unknown names (422)', async () => {
    const id = await addCustomer(w);
    const before = await snapshot(w, 'customers', id);
    for (const field of ['id', 'is_walkin', 'walkin_key', 'import_batch_id']) {
      const res = await patchCustomer(w, 'owner', id, STAMP_WIRE, { [field]: field === 'is_walkin' ? 1 : 'x' });
      expect([field, res.statusCode, codeOf(res)]).toEqual([field, 403, 'JV_FORBIDDEN']);
    }
    for (const field of ['created_by', 'updated_by', 'set_by', 'confirmed_by', 'created_at', 'updated_at', 'balance', 'outstanding']) {
      const res = await patchCustomer(w, 'owner', id, STAMP_WIRE, { [field]: field.endsWith('_by') ? randomUUID() : 'x' });
      expect([field, res.statusCode, codeOf(res)]).toEqual([field, 422, 'JV_INVALID_INPUT']);
    }
    expect(await snapshot(w, 'customers', id)).toBe(before);
  });
});
