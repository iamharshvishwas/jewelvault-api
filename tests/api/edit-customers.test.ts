import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { timestampToWire } from '../../src/wire/format';
import { addCustomer, patchCustomer } from './edit-13b-support';
import { type EditWorld, STAMP_DB, STAMP_WIRE, body, codeOf, dbRow, detailsOf, editWorld, snapshot } from './edit-support';
import { bodyOf, getPage } from './sync-support';

// API13b, the content columns of a customer (A4, A5, D10, Z3, D22, S6):
//   T-D04  (clause of A5) a biller edits a customer's content columns, and only the owner archives. The archive RULE itself (the four balance figures at zero, under the customer lock; the
//          walk-in never) is X-level work of API19, and the interleaving of T-C20 is API29's: here the owner's right to send `archived_at` and the biller's lack of it are proved.
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

  it.todo('API19 (K4): archiving is refused 409 while outstanding, fine outstanding, advance or fine advance is not zero, under the customer lock (X0 item 3), and the interleaving with a payment is T-C20 (API29): this task leaves the owner\'s `archived_at` open on purpose');
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
