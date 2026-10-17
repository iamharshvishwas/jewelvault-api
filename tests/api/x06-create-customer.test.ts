import { randomUUID } from 'node:crypto';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MATRIX, READ_COLUMNS } from '../../src/permissions/matrix';
import { ER, errorOf, scratchDatabase } from '../helpers';
import { V, insert } from '../schema/support';
import type { CallerName } from './cells';
import { type EditWorld, auditCount, body, codeOf, dbRow, detailsOf, editWorld } from './edit-support';
import { bodyOf, getPage } from './sync-support';
import { dbError } from './tx-support';

// API19, X6 `create_customer` (POST /v1/customers, owner and biller): T-F06 (D5, D7, D10, D20, X6), the clause of T-D09 for the row of X6, the clause of T-D14 for X6 in both mechanisms of L1, and
// the last case of PT-N1 (a request the route wrapper refuses never uses up its Idempotency-Key: this is the first creating route). The expected figures are written in the test, from the spec.
//
// The world is a scratch database with the real schema and the seeds, the application's real routes and a clock the test can read back (the stamps of a row must be readings of it, S6).

const WALKIN = '00000000-0000-4000-8000-000000000001';

let w: EditWorld; // audit mechanism (a): the generated triggers are in the database
let wn: EditWorld; // audit mechanism (b): the Node writer, NO triggers
beforeAll(async () => {
  w = await editWorld('x06', { triggers: true });
  wn = await editWorld('x06n', { config: { auditMode: 'node' } });
}, 180_000);
afterAll(async () => {
  await w?.world.close();
  await wn?.world.close();
}, 60_000);

let counter = 0;
/** A body that X6 accepts; every call gets its own mobile number so that nothing depends on a number being new. `o` overrides or adds. */
const valid = (o: Record<string, unknown> = {}): Record<string, unknown> => ({ name: 'Meera Soni', mobile: `98${String(10_000_000 + ++counter).padStart(8, '0')}`, ...o });

/** POST /v1/customers; the key is made fresh unless the test names one. */
const post = (world: EditWorld, caller: CallerName, payload: unknown, key: string | null = randomUUID(), headers: Record<string, string> = {}): Promise<LightMyRequestResponse> =>
  world.world.call(caller, 'POST', '/v1/customers', { payload, headers: { ...(key === null ? {} : { 'idempotency-key': key }), ...headers } });

const count = async (world: EditWorld, sql: string, params: unknown[] = []): Promise<number> => Number((((await world.world.sql.query<any[]>(sql, params))[0] as any[])[0] as { n: number | string }).n);
const customers = (world: EditWorld) => count(world, 'SELECT COUNT(*) AS n FROM customers');
const claims = (world: EditWorld) => count(world, 'SELECT COUNT(*) AS n FROM sys_idempotency');
const claimed = (world: EditWorld, key: string) => count(world, 'SELECT COUNT(*) AS n FROM sys_idempotency WHERE request_id = ?', [key]);
const asJson = (v: unknown): any => (typeof v === 'string' ? JSON.parse(v) : v);

/** The call is refused with 422 on `field`, and nothing is stored: no customer, no claim, no audit row. */
async function refused(payload: unknown, field: string, caller: CallerName = 'biller') {
  const before = [await customers(w), await claims(w), await auditCount(w)];
  const sent = w.world.spy.sent.length;
  const res = await post(w, caller, payload);
  const what = JSON.stringify(payload).slice(0, 80);
  expect([what, res.statusCode, codeOf(res), detailsOf(res)]).toEqual([what, 422, 'JV_INVALID_INPUT', { field }]);
  expect(w.world.spy.sqls().slice(sent).filter((s) => /\bINSERT\b/i.test(s)), `${what}: a statement that writes was sent for a refused body`).toEqual([]);
  expect([await customers(w), await claims(w), await auditCount(w)]).toEqual(before);
  return res;
}

// ------------------------------------------------------------------ T-F06

describe('T-F06 (D5) category and subcategory names are unique ignoring case', () => {
  it('the database refuses a second category in another case, and a subcategory name twice in one category but not in two', async () => {
    const dup = await errorOf(() => w.world.sql.query("INSERT INTO categories (id, name, prefix) VALUES (?, 'RING', 'RNG2')", [randomUUID()]));
    expect(dup?.errno).toBe(ER.DUP_ENTRY);
    const [[ring]] = (await w.world.sql.query<any[]>("SELECT id FROM categories WHERE name = 'Ring'")) as unknown as [{ id: string }[]];
    const dupSub = await errorOf(() => w.world.sql.query("INSERT INTO subcategories (id, category_id, name) VALUES (?, ?, 'kUNDAN')", [randomUUID(), ring.id]));
    expect(dupSub?.errno).toBe(ER.DUP_ENTRY);
    const other = (await insert(w.world.sql, 'categories', V.category({ name: 'Brand New', prefix: 'BNEW' }))).id as string;
    expect(await errorOf(() => w.world.sql.query("INSERT INTO subcategories (id, category_id, name) VALUES (?, ?, 'KUNDAN')", [randomUUID(), other]))).toBeNull();
  });

  it('and so does the API: the same name in other case is a refused insert (422), also for a subcategory', async () => {
    const cat = await w.world.call('owner', 'POST', '/v1/categories', { payload: { name: 'rInG', prefix: 'RNGX' } });
    expect([cat.statusCode, codeOf(cat)]).toEqual([422, 'JV_INVALID_INPUT']);
    const [[ring]] = (await w.world.sql.query<any[]>("SELECT id FROM categories WHERE name = 'Ring'")) as unknown as [{ id: string }[]];
    const sub = await w.world.call('owner', 'POST', '/v1/subcategories', { payload: { category_id: ring.id, name: 'handMADE' } });
    expect([sub.statusCode, codeOf(sub)]).toEqual([422, 'JV_INVALID_INPUT']);
  });
});

describe('T-F06 (D10, K5) exactly one walk-in customer exists, and X6 can never make another', () => {
  it('one row has is_walkin, with the fixed id; a second one is refused by the unique key', async () => {
    const [rows] = await w.world.sql.query<any[]>('SELECT id FROM customers WHERE is_walkin = 1');
    expect((rows as any[]).map((r) => r.id)).toEqual([WALKIN]);
    const second = await errorOf(() => insert(w.world.sql, 'customers', V.customer({ is_walkin: 1, mobile: null })));
    expect(second?.errno).toBe(ER.DUP_ENTRY);
  });

  it('create_customer takes no is_walkin (422, an unknown field), and after any number of customers there is still exactly one walk-in', async () => {
    await refused(valid({ is_walkin: true }), 'is_walkin');
    await refused(valid({ is_walkin: false }), 'is_walkin');
    for (let i = 0; i < 3; i++) expect((await post(w, 'biller', valid())).statusCode).toBe(201);
    expect(await count(w, 'SELECT COUNT(*) AS n FROM customers WHERE is_walkin = 1')).toBe(1);
    expect((await dbRow(w, 'customers', WALKIN)).name).toBe('Walk-in Customer');
  });
});

describe('T-F06 (D10, O33) a mobile number that is not ten digits or + and 7 to 15 digits is refused; a blank one is accepted only with an import_batch_id', () => {
  const BAD = ['12345', '98765432101', 'abcdefghij', '+12345', '+1234567890123456', '++441234567890', '98765 4321 0 1', ' 987654321'];
  const GOOD = ['9876543210', '+442079460958', '+1234567', '+123456789012345'];

  it('the database CHECK: the bad ones are refused (error 4025), the good ones stored; a NULL only with an import_batch_id', async () => {
    for (const mobile of BAD) expect((await errorOf(() => insert(w.world.sql, 'customers', V.customer({ mobile }))))?.errno, mobile).toBe(ER.CHECK_FAILED);
    for (const mobile of GOOD) expect(await errorOf(() => insert(w.world.sql, 'customers', V.customer({ mobile }))), mobile).toBeNull();
    expect((await errorOf(() => insert(w.world.sql, 'customers', V.customer({ mobile: null }))))?.errno).toBe(ER.CHECK_FAILED);
    const batch = randomUUID();
    await w.world.sql.query('INSERT INTO sys_import_batches (id, name) VALUES (?, ?)', [batch, `batch ${batch}`]);
    expect(await errorOf(() => insert(w.world.sql, 'customers', V.customer({ mobile: null, import_batch_id: batch })))).toBeNull();
  });

  it('create_customer: the same bad numbers are 422 on `mobile` and store nothing; a blank, a null and a missing number are refused too (a named customer has a number)', async () => {
    for (const mobile of [...BAD, 9876543210, '', ' - ', null]) await refused(valid({ mobile }), 'mobile');
    await refused({ name: 'No Number' }, 'mobile');
  });

  it('create_customer: spaces and dashes are taken out on entry, a + number keeps its +', async () => {
    for (const [sent, stored] of [
      ['98765 43210', '9876543210'],
      ['98765-43210', '9876543210'],
      [' 9876543211 ', '9876543211'],
      ['+44 20-7946 0958', '+442079460958'],
      ['+1234567', '+1234567'],
      ['+123456789012345', '+123456789012345'],
    ] as const) {
      const res = await post(w, 'biller', valid({ mobile: sent }));
      expect(res.statusCode, `${sent}: ${res.body}`).toBe(201);
      expect(body(res).customer.mobile, sent).toBe(stored);
      expect((await dbRow(w, 'customers', body(res).customer.id)).mobile, sent).toBe(stored);
    }
  });
});

describe('T-F06 (D10, Z3) a PAN that is not five capital letters, four digits and a capital letter is refused', () => {
  // the column is VARCHAR(10): a longer text never reaches the CHECK (error 1406), so those two are for the API's own pattern only
  const BAD = ['abcde1234f', 'ABCDE12345', 'ABCD1234EF', 'ABCDE1234', 'ABCDe1234F'];
  const TOO_LONG = ['ABCDE1234FG', ' ABCDE1234F'];

  it('the database CHECK refuses them (error 4025) and keeps ABCDE1234F', async () => {
    for (const pan of BAD) expect((await errorOf(() => insert(w.world.sql, 'customers', V.customer({ pan }))))?.errno, pan).toBe(ER.CHECK_FAILED);
    expect(await errorOf(() => insert(w.world.sql, 'customers', V.customer({ pan: 'ABCDE1234F' })))).toBeNull();
  });

  it('create_customer refuses them with 422 on `pan` BEFORE the database is asked (no statement that writes is sent, so the CHECK is never what answers), and takes a blank PAN as none', async () => {
    for (const pan of [...BAD, ...TOO_LONG, 5]) await refused(valid({ pan }), 'pan');
    for (const pan of ['', null]) {
      const res = await post(w, 'biller', valid({ pan }));
      expect(res.statusCode, res.body).toBe(201);
      expect(body(res).customer.pan).toBeNull();
    }
    const ok = await post(w, 'owner', valid({ pan: 'ABCDE1234F' }));
    expect(ok.statusCode, ok.body).toBe(201);
    expect(body(ok).customer.pan).toBe('ABCDE1234F');
    expect(w.world.logs.lines().some((l) => /4025/.test(JSON.stringify(l)))).toBe(false); // the database's CHECK never answered
  });
});

describe('T-F06 (X6) create_customer returns the customer', () => {
  it('201 with { customer }: the row a sync read of the same role gives (the columns of READ_COLUMNS), made by the session user, stamped with one reading of the API clock', async () => {
    const readings = w.time.readings.length;
    const res = await post(w, 'biller', valid({ name: '  Meera Soni  ', mobile: '98765 12345', email: 'meera@example.test', address: '12 Mirza Road, Jaipur', gst_number: '08AAAAA0000A1Z5', pan: 'ABCDE1234F', notes: 'prefers WhatsApp' }));
    expect(res.statusCode, res.body).toBe(201);
    expect(res.headers['idempotent-replay']).toBeUndefined();
    expect(Object.keys(body(res))).toEqual(['customer']);
    const customer = body(res).customer;
    expect(Object.keys(customer).sort()).toEqual([...(READ_COLUMNS.customers.biller ?? [])].sort());
    expect(customer).toMatchObject({
      name: 'Meera Soni',
      mobile: '9876512345',
      customer_type: 'Retail', // the default
      email: 'meera@example.test',
      address: '12 Mirza Road, Jaipur',
      gst_number: '08AAAAA0000A1Z5',
      pan: 'ABCDE1234F',
      notes: 'prefers WhatsApp',
      is_walkin: false,
      archived_at: null,
      created_by: w.world.fixtures.biller.userId,
      updated_by: w.world.fixtures.biller.userId,
    });
    expect(customer.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(customer.created_at).toBe(customer.updated_at);

    const stored = await dbRow(w, 'customers', customer.id);
    expect(stored).toMatchObject({ is_walkin: 0, import_batch_id: null, archived_at: null, created_by: w.world.fixtures.biller.userId });
    expect(w.time.readings.slice(readings).map((r) => r.timestamp)).toContain(stored.created_at); // S6: the stamps are the API clock's
    expect(stored.created_at).toBe(stored.updated_at);

    for (const caller of ['owner', 'biller'] as const) {
      const row = bodyOf<{ rows: any[] }>(await getPage(w.world, caller, 'customers')).rows.find((r) => r.id === customer.id);
      expect(row, `the ${caller}'s sync read`).toEqual(customer);
    }
  });

  it('only the name and the mobile are needed: the type is Retail, the other texts are none; a blank text is none; the owner may make a customer too; types Semi-Wholesale and Wholesale are kept', async () => {
    const bare = await post(w, 'owner', { name: 'Only Name', mobile: '9811111111' });
    expect(bare.statusCode, bare.body).toBe(201);
    expect(body(bare).customer).toMatchObject({ customer_type: 'Retail', email: null, address: null, gst_number: null, pan: null, notes: null, created_by: w.world.fixtures.owner.userId });
    const blanks = await post(w, 'biller', valid({ email: '  ', address: '', gst_number: ' ', notes: '', pan: '' }));
    expect(body(blanks).customer).toMatchObject({ email: null, address: null, gst_number: null, notes: null, pan: null });
    for (const customer_type of ['Semi-Wholesale', 'Wholesale', 'Retail']) {
      const res = await post(w, 'biller', valid({ customer_type }));
      expect(res.statusCode, res.body).toBe(201);
      expect(body(res).customer.customer_type).toBe(customer_type);
    }
  });
});

describe('T-F06 (X6, D10) the other inputs: name 1 to 120 characters, a customer type of the three, the widths of the columns, nothing unknown', () => {
  it('name: 1 to 120 characters after trimming; a blank, a number, null or no name is refused', async () => {
    for (const name of ['', '   ', 'x'.repeat(121), 5, null]) await refused(valid({ name }), 'name');
    await refused({ mobile: '9811111111' }, 'name');
    const res = await post(w, 'biller', valid({ name: `  ${'x'.repeat(120)}  ` }));
    expect(res.statusCode, res.body).toBe(201);
    expect(body(res).customer.name).toBe('x'.repeat(120));
  });

  it('customer_type: Retail, Semi-Wholesale or Wholesale; anything else (also null and a number) is refused', async () => {
    for (const customer_type of ['VIP', 'retail', '', null, 3]) await refused(valid({ customer_type }), 'customer_type');
  });

  it('email 254, address 500, gst_number 20, notes 10,000 characters: one more is refused on its field, the limit itself is kept', async () => {
    for (const [field, max] of [['email', 254], ['address', 500], ['gst_number', 20], ['notes', 10_000]] as const) {
      await refused(valid({ [field]: 'x'.repeat(max + 1) }), field);
      const res = await post(w, 'biller', valid({ [field]: 'x'.repeat(max) }));
      expect(res.statusCode, `${field} at ${max}: ${res.body.slice(0, 100)}`).toBe(201);
      expect(body(res).customer[field]).toBe('x'.repeat(max));
    }
  });

  it('a field the call does not take is 422 and names it: the id, the stamps, the person columns, the archive time, the import batch, an opening balance (that is X12)', async () => {
    for (const field of ['id', 'created_at', 'updated_at', 'created_by', 'updated_by', 'archived_at', 'import_batch_id', 'is_walkin', 'walkin_key', 'outstanding', 'opening_balance', 'balance', 'colour']) {
      await refused(valid({ [field]: field === 'archived_at' ? null : 'x' }), field);
    }
  });

  it('a body that is not an object is 422 on `body`', async () => {
    await refused([], 'body');
    const text = await post(w, 'biller', '"Meera"', randomUUID(), { 'content-type': 'application/json' }); // a JSON string, not an object
    expect([text.statusCode, codeOf(text), detailsOf(text)]).toEqual([422, 'JV_INVALID_INPUT', { field: 'body' }]);
  });
});

// ------------------------------------------------------------------ T-D09

describe('T-D09 (API19 clause) the matrix row of X6 (POST /v1/customers: owner and biller) for the callers', () => {
  it('the route is registered through route() with the action of the row', () => {
    expect(MATRIX['fn:create_customer']).toMatchObject({ method: 'POST', path: '/v1/customers', roles: ['owner', 'biller'] });
    expect(w.world.app.routeTable.find((r) => r.action === 'fn:create_customer')).toMatchObject({ method: 'POST', url: '/v1/customers', kind: 'matrix', roles: ['owner', 'biller'], mustChange: false });
  });

  it('no session, an ended, expired or idle session and a user who is not active are 401, staff is 403 JV_FORBIDDEN, a user who must change the password is 403: nothing is written and no key is claimed', async () => {
    const expected = [
      ['anon', 401, 'JV_UNAUTHENTICATED'],
      ['ended', 401, 'JV_UNAUTHENTICATED'],
      ['expired', 401, 'JV_SESSION_EXPIRED'],
      ['idle', 401, 'JV_SESSION_EXPIRED'],
      ['inactive', 401, 'JV_UNAUTHENTICATED'],
      ['staff', 403, 'JV_FORBIDDEN'],
      ['must_change', 403, 'JV_PASSWORD_CHANGE_REQUIRED'],
    ] as const;
    for (const [caller, status, code] of expected) {
      const key = randomUUID();
      const before = [await customers(w), await claims(w), await auditCount(w)];
      const sent = w.world.spy.sent.length;
      const res = await post(w, caller, valid(), key);
      expect([caller, res.statusCode, codeOf(res)], caller).toEqual([caller, status, code]);
      await w.world.restore(caller);
      expect(w.world.spy.sqls().slice(sent).some((s) => /\bINSERT\b/i.test(s) || /\bFROM\s+customers\b/i.test(s)), `${caller} caused a read or write of customers`).toBe(false);
      expect([await customers(w), await claims(w), await auditCount(w)], caller).toEqual(before);
      expect(await claimed(w, key), caller).toBe(0);
    }
  });

  it('the owner and the biller each make a customer (201) and get the same shape', async () => {
    const owner = await post(w, 'owner', valid());
    const biller = await post(w, 'biller', valid());
    expect([owner.statusCode, biller.statusCode]).toEqual([201, 201]);
    expect(Object.keys(body(biller).customer)).toEqual(Object.keys(body(owner).customer));
    expect([body(owner).customer.created_by, body(biller).customer.created_by]).toEqual([w.world.fixtures.owner.userId, w.world.fixtures.biller.userId]);
  });
});

// ------------------------------------------------------------------ PT-N1, the last case

describe('PT-N1 (the last case) a request the route wrapper refuses never uses up its Idempotency-Key', () => {
  it('no session, a wrong role, a user who must change the password and an invalid body each leave the key unclaimed, and the same key then makes the customer', async () => {
    const key = randomUUID();
    const payload = valid();
    for (const caller of ['anon', 'ended', 'expired', 'inactive', 'staff', 'must_change'] as const) {
      const res = await post(w, caller, payload, key);
      expect(res.statusCode, caller).toBeGreaterThanOrEqual(401);
      expect(res.statusCode, caller).toBeLessThanOrEqual(403);
      await w.world.restore(caller);
      expect(await claimed(w, key), `${caller} used up the key`).toBe(0);
    }
    for (const bad of [{ ...payload, mobile: '123' }, { ...payload, surprise: 1 }, { mobile: payload.mobile }, []]) {
      const res = await post(w, 'biller', bad, key);
      expect(res.statusCode, JSON.stringify(bad)).toBe(422);
      expect(await claimed(w, key), `an invalid body used up the key: ${JSON.stringify(bad)}`).toBe(0);
    }
    const before = await customers(w);
    const made = await post(w, 'biller', payload, key);
    expect(made.statusCode, made.body).toBe(201);
    expect(made.headers['idempotent-replay']).toBeUndefined(); // the first use of the key, not a replay
    expect(await claimed(w, key)).toBe(1);
    expect(await customers(w)).toBe(before + 1);
  });

  it('a missing key, a key that is not a UUID and a key sent twice are 422 on the header, claim nothing and make no customer; a key in capitals is the same key as in lower case', async () => {
    const before = [await customers(w), await claims(w)];
    for (const [what, res] of [
      ['no header', await post(w, 'biller', valid(), null)],
      ['not a UUID', await post(w, 'biller', valid(), 'not-a-uuid')],
      ['empty', await post(w, 'biller', valid(), '')],
      ['twice', await post(w, 'biller', valid(), `${randomUUID()}, ${randomUUID()}`)],
    ] as const) {
      expect([what, res.statusCode, codeOf(res), detailsOf(res)]).toEqual([what, 422, 'JV_INVALID_INPUT', { field: 'Idempotency-Key' }]);
    }
    expect([await customers(w), await claims(w)]).toEqual(before);

    const key = randomUUID();
    const upper = await post(w, 'biller', valid({ name: 'Capital Key' }), key.toUpperCase());
    expect(upper.statusCode, upper.body).toBe(201);
    expect(await claimed(w, key)).toBe(1); // stored in lower case
  });
});

// ------------------------------------------------------------------ L5, repeat-safety

describe('X6 repeat-safety (L5): one key, one customer', () => {
  it('the same key and the same body again is the same answer with Idempotent-Replay: true, and no second customer or audit row', async () => {
    const key = randomUUID();
    const payload = valid({ name: 'Repeat Me' });
    const auditBefore = await auditCount(w);
    const first = await post(w, 'biller', payload, key);
    const again = await post(w, 'biller', payload, key);
    expect([first.statusCode, again.statusCode]).toEqual([201, 201]);
    expect(again.headers['idempotent-replay']).toBe('true');
    expect(body(again)).toEqual(body(first));
    expect(await count(w, "SELECT COUNT(*) AS n FROM customers WHERE name = 'Repeat Me'")).toBe(1);
    expect(await auditCount(w) - auditBefore).toBe(1); // the one insert
  });

  it('the same key with another body, or from another caller, is refused (422 on the header) and makes nothing', async () => {
    const key = randomUUID();
    const payload = valid({ name: 'First Body' });
    expect((await post(w, 'biller', payload, key)).statusCode).toBe(201);
    const before = await customers(w);
    const other = await post(w, 'biller', { ...payload, name: 'Second Body' }, key);
    expect([other.statusCode, codeOf(other), detailsOf(other)]).toEqual([422, 'JV_INVALID_INPUT', { field: 'Idempotency-Key' }]);
    const stranger = await post(w, 'owner', payload, key);
    expect([stranger.statusCode, codeOf(stranger), detailsOf(stranger)]).toEqual([422, 'JV_INVALID_INPUT', { field: 'Idempotency-Key' }]);
    expect(await customers(w)).toBe(before);
  });

  it('two identical calls at once make one customer: one answers 201, the other 201 with Idempotent-Replay: true', async () => {
    const key = randomUUID();
    const payload = valid({ name: 'At Once' });
    const [a, b] = await Promise.all([post(w, 'biller', payload, key), post(w, 'biller', payload, key)]);
    expect([a.statusCode, b.statusCode]).toEqual([201, 201]);
    expect([a.headers['idempotent-replay'], b.headers['idempotent-replay']].filter((h) => h === 'true')).toHaveLength(1);
    expect(body(a)).toEqual(body(b));
    expect(await count(w, "SELECT COUNT(*) AS n FROM customers WHERE name = 'At Once'")).toBe(1);
  });

  it('a save that fails leaves nothing: the claim, the customer and the audit row are rolled back together, and the same key can be used again', async () => {
    const key = randomUUID();
    const payload = valid({ name: 'Never Saved' });
    const before = [await customers(w), await claims(w), await auditCount(w)];
    w.world.spy.intercept = async (e) => {
      if (/^INSERT INTO `?customers`?/i.test(e.sql)) throw dbError(1205, 'ER_LOCK_WAIT_TIMEOUT', 'Lock wait timeout exceeded; try restarting transaction');
    };
    let failed: LightMyRequestResponse;
    try {
      failed = await post(w, 'biller', payload, key);
    } finally {
      w.world.spy.intercept = null;
    }
    expect(failed.statusCode).toBe(503);
    expect([await customers(w), await claims(w), await auditCount(w)]).toEqual(before);
    expect(await claimed(w, key)).toBe(0);
    const retry = await post(w, 'biller', payload, key);
    expect(retry.statusCode, retry.body).toBe(201);
    expect(retry.headers['idempotent-replay']).toBeUndefined();
  });

  it('the statements of a call: the claim first, then the insert; no lock on a customer row (the customer is new) and no number counter', async () => {
    const sent = w.world.spy.sent.length;
    const res = await post(w, 'biller', valid());
    expect(res.statusCode, res.body).toBe(201);
    const mine = w.world.spy.sqls().slice(sent).map((s) => s.trim()).filter((s) => !/^SET SESSION\b/i.test(s) && !/\bFROM\s+(sessions|users)\b/i.test(s) && !/^UPDATE\s+sessions\s+SET\s+last_seen_at\b/i.test(s));
    const claimAt = mine.findIndex((s) => /^INSERT INTO sys_idempotency\b/i.test(s));
    const insertAt = mine.findIndex((s) => /^INSERT INTO `?customers`?\b/i.test(s));
    expect(claimAt).toBeGreaterThanOrEqual(0);
    expect(insertAt).toBeGreaterThan(claimAt);
    expect(mine.some((s) => /sys_counters/i.test(s))).toBe(false);
    expect(mine.some((s) => /\bFROM\s+customers\b[^]*\bFOR UPDATE\b/i.test(s) && !/WHERE id = \?/i.test(s))).toBe(false);
  });
});

// ------------------------------------------------------------------ T-D14

for (const mode of ['triggers', 'node'] as const) {
  const world = () => (mode === 'triggers' ? w : wn);

  describe(`T-D14 (API19 clause) X6 on audit mechanism ${mode === 'triggers' ? '(a), the generated triggers' : '(b), the Node writer of API15'}: one audit row for each changed row`, () => {
    /** The rows of customers as JSON by id: the "changed rows" of T-D14 are counted by comparing two of these. */
    async function rowsOf(): Promise<Map<string, string>> {
      const [rows] = await world().world.sql.query<any[]>('SELECT * FROM customers');
      return new Map((rows as any[]).map((r) => [String(r.id), JSON.stringify(r)]));
    }
    async function countFor(run: () => Promise<LightMyRequestResponse>) {
      const before = await rowsOf();
      const res = await run();
      const after = await rowsOf();
      const [audit] = await world().world.sql.query<any[]>('SELECT * FROM audit_log WHERE request_id = ? ORDER BY id', [String(res.headers['x-request-id'])]);
      return { res, changed: [...after].filter(([k, row]) => before.get(k) !== row).map(([k]) => k), audit: audit as any[] };
    }

    it('a created customer is one changed row and exactly one audit row (insert), with the session user, the role and the new row; nothing in the old row', async () => {
      const total = await auditCount(world());
      const made = await countFor(() => post(world(), 'biller', valid({ name: 'Audited', pan: 'ABCDE1234F' })));
      expect(made.res.statusCode, made.res.body).toBe(201);
      const customer = body(made.res).customer;
      expect(made.changed).toEqual([customer.id]);
      expect(made.audit).toHaveLength(1);
      expect(made.audit[0]).toMatchObject({ table_name: 'customers', row_id: customer.id, action: 'insert', actor: world().world.fixtures.biller.userId, actor_role: 'biller', old_row: null });
      expect(asJson(made.audit[0].new_row)).toMatchObject({ id: customer.id, name: 'Audited', mobile: customer.mobile, pan: 'ABCDE1234F', customer_type: 'Retail', is_walkin: 0, created_by: world().world.fixtures.biller.userId });
      expect(await auditCount(world())).toBe(total + 1); // the claim row (sys_idempotency) is not an audited table
      expect(`${made.audit[0].new_row}`).not.toMatch(/hash|token|password/i);
    });

    it('a replay, a refusal of the wrapper, a refusal of the body and a wrong role change no row and write no audit row', async () => {
      const key = randomUUID();
      const payload = valid({ name: 'Replayed' });
      expect((await post(world(), 'owner', payload, key)).statusCode).toBe(201);
      const calls: [string, number, () => Promise<LightMyRequestResponse>][] = [
        ['a replay', 201, () => post(world(), 'owner', payload, key)],
        ['a bad mobile', 422, () => post(world(), 'owner', valid({ mobile: '12' }))],
        ['a bad pan', 422, () => post(world(), 'biller', valid({ pan: 'abcde1234f' }))],
        ['no key', 422, () => post(world(), 'biller', valid(), null)],
        ['staff', 403, () => post(world(), 'staff', valid())],
        ['no session', 401, () => post(world(), 'anon', valid())],
        ['another body under the key', 422, () => post(world(), 'owner', { ...payload, name: 'Changed' }, key)],
      ];
      for (const [what, status, run] of calls) {
        const { res, changed, audit } = await countFor(run);
        expect(res.statusCode, `${what}: ${res.body.slice(0, 100)}`).toBe(status);
        expect([what, changed.length, audit.length]).toEqual([what, 0, 0]);
      }
    });

    it('the audit row and the customer are one transaction: when the COMMIT fails the insert and its audit row were sent, and both are gone', async () => {
      const total = await auditCount(world());
      const people = await customers(world());
      const sent = world().world.spy.sent.length;
      world().world.spy.intercept = async (e) => {
        if (e.sql === 'COMMIT') throw dbError(1205, 'ER_LOCK_WAIT_TIMEOUT', 'Lock wait timeout exceeded; try restarting transaction');
      };
      let res: LightMyRequestResponse;
      try {
        res = await post(world(), 'biller', valid({ name: 'Never Committed' }));
      } finally {
        world().world.spy.intercept = null;
      }
      expect(res.statusCode).toBe(503);
      expect(world().world.spy.sqls().slice(sent).some((q) => /^INSERT INTO `?customers`?\b/i.test(q))).toBe(true);
      if (mode === 'node') expect(world().world.spy.sqls().slice(sent).some((q) => /^INSERT INTO audit_log\b/.test(q)), 'the Node writer\'s row was written in that transaction too').toBe(true);
      expect(await customers(world())).toBe(people);
      expect(await auditCount(world())).toBe(total);
    });
  });
}

// ------------------------------------------------------------------ T-F06, the seeds

describe('T-F06 (D20) the seeds hold no sample data', () => {
  it('on a database with the migrations and the seeds, the walk-in customer is the only customer and no business table has a row; the catalogue is the 15 categories with 4 subcategories each', async () => {
    const scratch = await scratchDatabase('x06seed', { schema: true });
    const c = await scratch.connect();
    try {
      const { migrate } = await import('../../scripts/migrate.mjs');
      await migrate(c, { seeds: true });
      const n = async (t: string) => Number((((await c.query<any[]>(`SELECT COUNT(*) AS n FROM \`${t}\``))[0] as any[])[0] as { n: number }).n);
      for (const t of ['daily_rates', 'designs', 'design_photos', 'skus', 'sku_private', 'bills', 'bill_items', 'receipts', 'receipt_allocations', 'users', 'sessions', 'sys_counters', 'sys_idempotency', 'audit_log']) expect(await n(t), t).toBe(0);
      expect(await n('customers')).toBe(1);
      expect(await n('categories')).toBe(15);
      expect(await n('subcategories')).toBe(60);
      const [rows] = await c.query<any[]>('SELECT id, name, is_walkin FROM customers');
      expect(rows).toEqual([{ id: WALKIN, name: 'Walk-in Customer', is_walkin: 1 }]);
    } finally {
      await c.end().catch(() => undefined);
      await scratch.drop();
    }
  });
});
