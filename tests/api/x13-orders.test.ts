import { randomUUID } from 'node:crypto';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { installUserRates } from '../../src/auth/throttle';
import { V, insert } from '../schema/support';
import type { CallerName } from './cells';
import { type EditWorld, STAMP_DB, STAMP_WIRE, addDesign, auditRows, body, codeOf, detailsOf, editWorld, patch, stampOf } from './edit-support';
import { jpeg, read, upload as uploadForDesign } from './photo-support';
import { getPage, poll } from './sync-support';

// FB-E1 (FB-D8, Siddhi #13): the Order Book on the API, through the application's real routes on a scratch database with the migrations, the seeds and the generated audit triggers (L1 (a)).
//
//   POST  /v1/orders                                         X13 create_order, Idempotency-Key, the owner and a biller          201 { order }
//   PATCH /v1/orders/:id                                     the edit with expected_updated_at, the owner and a biller          200 { row }   409 JV_STALE   422   409 JV_NOT_ALLOWED
//   GET   /v1/sync/orders (and the poll)                     the owner, a biller and staff                                      200 { rows, next, server_time }
//   PUT   /v1/orders/:order_id/photos/:photo_id?kind=        the owner and a biller; P1 and P2 as for a design, 3 live photos an order
//
// The values the plan fixes are written here as the plan gives them: ORD-<YYYY>-<4 digits> from the counter series order:<YYYY> (the fixture clock is 17 Oct 2026, so 2026), the five statuses,
// delivered -> cancelled for the owner alone, staff read only, and no money anywhere in an order.

let w: EditWorld; // audit mechanism (a): the generated triggers are in the database
let wn: EditWorld; // audit mechanism (b): the Node writer, no triggers
beforeAll(async () => {
  w = await editWorld('x13', { triggers: true });
  wn = await editWorld('x13n', { config: { auditMode: 'node' } });
  // the photo rate of 30 a minute is T-D24's subject; with the world's clock standing still these tests would use it up
  for (const x of [w, wn]) installUserRates(x.world.app, { photoUpload: { limit: 1_000_000, windowMs: 60_000 }, everything: { limit: 1_000_000, windowMs: 60_000 } });
}, 180_000);
afterAll(async () => {
  await w?.world.close();
  await wn?.world.close();
}, 60_000);

let mobiles = 0;
async function addCustomer(world: EditWorld = w, o: Record<string, unknown> = {}): Promise<string> {
  return ((await insert(world.world.sql, 'customers', V.customer({ mobile: `93${String(10_000_000 + ++mobiles)}`, ...o }))) as { id: string }).id;
}

/** An order typed in by SQL with the fixture's stamp, as an earlier create would have left it. */
async function addOrder(world: EditWorld = w, o: Record<string, unknown> = {}): Promise<string> {
  const id = randomUUID();
  await insert(world.world.sql, 'orders', { id, order_no: `ORD-1999-${String(++mobiles).padStart(4, '0')}`, customer_id: await addCustomer(world), description: 'Silver anklets, pair', created_at: STAMP_DB, updated_at: STAMP_DB, ...o });
  return id;
}

const create = (caller: CallerName, payload: unknown, key: string | null = randomUUID(), world: EditWorld = w): Promise<LightMyRequestResponse> =>
  world.world.call(caller, 'POST', '/v1/orders', { payload, headers: key === null ? {} : { 'idempotency-key': key } });
const edit = (caller: CallerName, id: string, expected: string, changes: Record<string, unknown>, world: EditWorld = w): Promise<LightMyRequestResponse> =>
  world.world.call(caller, 'PATCH', `/v1/orders/${id}`, { payload: { expected_updated_at: expected, changes } });
const uploadUrl = (orderId: string, photoId: string, kind = 'full') => `/v1/orders/${orderId}/photos/${photoId}?kind=${kind}`;
const upload = (caller: CallerName, orderId: string, photoId: string, kind: string, bytes: Buffer, world: EditWorld = w) =>
  world.world.call(caller, 'PUT', uploadUrl(orderId, photoId, kind), { payload: bytes as unknown as string, headers: { 'content-type': 'image/jpeg' } });
/** A whole photo of an order: the full image and its thumbnail under one new id. */
async function photoFor(orderId: string, caller: CallerName = 'biller'): Promise<string> {
  const id = randomUUID();
  expect((await upload(caller, orderId, id, 'full', jpeg(400))).statusCode).toBe(201);
  expect((await upload(caller, orderId, id, 'thumb', jpeg(100))).statusCode).toBe(201);
  return id;
}

const rows = async (sql: string, params: unknown[] = [], world: EditWorld = w): Promise<any[]> => (await world.world.sql.query<any[]>(sql, params))[0] as any[];
const counter = async (world: EditWorld = w): Promise<number> => Number((await rows("SELECT COALESCE(MAX(last_value), 0) AS n FROM sys_counters WHERE series = 'order:2026'", [], world))[0].n);
const countOrders = async (world: EditWorld = w): Promise<number> => Number((await rows('SELECT COUNT(*) AS n FROM orders', [], world))[0].n);
const valid = async (o: Record<string, unknown> = {}) => ({ order_id: randomUUID(), customer_id: await addCustomer(), description: 'Gold ring, size 14, name engraved inside', ...o });
const ORDER_NO = /^ORD-2026-\d{4}$/;
const ORDER_COLUMNS = ['id', 'order_no', 'customer_id', 'description', 'delivery_date', 'status', 'photo_ids', 'notes', 'created_at', 'updated_at', 'created_by', 'updated_by'];

// ------------------------------------------------------------------ X13 create_order

describe('FB-E1 POST /v1/orders (X13 create_order)', () => {
  it('the owner and a biller make an order: 201 { order } in the sync wire format, status open, ORD-2026-<4 digits>, stamped from the API clock by the caller', async () => {
    for (const caller of ['owner', 'biller'] as const) {
      const payload = await valid({ delivery_date: '2026-10-19', notes: 'Customer will bring old gold' });
      const res = await create(caller, payload);
      expect(res.statusCode, res.body).toBe(201);
      const order = body(res).order;
      expect(Object.keys(order).sort()).toEqual([...ORDER_COLUMNS].sort());
      expect(order).toMatchObject({ id: payload.order_id, customer_id: payload.customer_id, description: payload.description, delivery_date: '2026-10-19', status: 'open', photo_ids: [], notes: 'Customer will bring old gold' });
      expect(order.order_no).toMatch(ORDER_NO);
      expect(order.created_by).toBe(w.world.fixtures[caller].userId);
      expect(order.created_at).toBe(order.updated_at);
      expect(JSON.stringify(order)).not.toMatch(/amount|advance|total|price/); // no money in an order (FB-D8)
    }
  });

  it('staff may not make one (403 JV_FORBIDDEN): nothing is stored, no number is used', async () => {
    const before = [await countOrders(), await counter()];
    const res = await create('staff', await valid());
    expect([res.statusCode, codeOf(res)]).toEqual([403, 'JV_FORBIDDEN']);
    expect([await countOrders(), await counter()]).toEqual(before);
  });

  it('the numbers follow each other and the counter row is order:2026', async () => {
    const a = body(await create('biller', await valid())).order.order_no as string;
    const b = body(await create('owner', await valid())).order.order_no as string;
    expect(Number(b.slice(-4))).toBe(Number(a.slice(-4)) + 1);
    expect(await counter()).toBe(Number(b.slice(-4)));
  });

  it('a repeat of the Idempotency-Key answers the stored order with Idempotent-Replay and makes no second one; a missing key is 422 and stores nothing', async () => {
    const payload = await valid();
    const key = randomUUID();
    const first = await create('biller', payload, key);
    const again = await create('biller', payload, key);
    expect([first.statusCode, again.statusCode]).toEqual([201, 201]);
    expect(again.headers['idempotent-replay']).toBe('true');
    expect(body(again)).toEqual(body(first));
    expect(Number((await rows('SELECT COUNT(*) AS n FROM orders WHERE id = ?', [payload.order_id]))[0].n)).toBe(1);
    const before = await countOrders();
    const keyless = await create('biller', await valid(), null);
    expect([keyless.statusCode, codeOf(keyless)]).toEqual([422, 'JV_INVALID_INPUT']);
    expect(await countOrders()).toBe(before);
  });

  it('refusals: a bad field (422 naming it), a status or a money field sent (unknown field), an unknown customer, an order id that is taken; an archived customer is 409 JV_CUSTOMER_ARCHIVED', async () => {
    const taken = body(await create('biller', await valid())).order.id as string;
    const archived = await addCustomer(w, { archived_at: '2026-10-01 00:00:00.000000' });
    const cases: [Record<string, unknown>, number, string, string][] = [
      [await valid({ description: '   ' }), 422, 'JV_INVALID_INPUT', 'description'],
      [await valid({ description: 'x'.repeat(2001) }), 422, 'JV_INVALID_INPUT', 'description'],
      [await valid({ notes: 'x'.repeat(2001) }), 422, 'JV_INVALID_INPUT', 'notes'],
      [await valid({ delivery_date: '2026-02-30' }), 422, 'JV_INVALID_INPUT', 'delivery_date'],
      [await valid({ status: 'ready' }), 422, 'JV_INVALID_INPUT', 'status'],
      [await valid({ advance_amount: '500.00' }), 422, 'JV_INVALID_INPUT', 'advance_amount'],
      [await valid({ customer_id: randomUUID() }), 422, 'JV_INVALID_INPUT', 'customer_id'],
      [await valid({ order_id: taken }), 422, 'JV_INVALID_INPUT', 'order_id'],
      [await valid({ photo_ids: [randomUUID(), randomUUID(), randomUUID(), randomUUID()] }), 422, 'JV_INVALID_INPUT', 'photo_ids'],
    ];
    for (const [payload, status, code, field] of cases) {
      const before = [await countOrders(), await counter()];
      const res = await create('owner', payload);
      expect([field, res.statusCode, codeOf(res), detailsOf(res)?.field]).toEqual([field, status, code, field]);
      expect([await countOrders(), await counter()], field).toEqual(before);
    }
    const res = await create('biller', await valid({ customer_id: archived }));
    expect([res.statusCode, codeOf(res)]).toEqual([409, 'JV_CUSTOMER_ARCHIVED']);
  });

  it('the number is gapless across a rolled-back create: a create that fails after it took its number gives the number back, and the next order gets it', async () => {
    const before = body(await create('biller', await valid())).order.order_no as string;
    const used = await counter();
    const ordersBefore = await countOrders();
    w.world.spy.intercept = (e) => {
      if (/^INSERT INTO orders\b/i.test(e.sql.trim())) throw new Error('the disk is full'); // after the counter UPDATE, inside the same transaction
    };
    let failed: LightMyRequestResponse;
    try {
      failed = await create('biller', await valid());
    } finally {
      w.world.spy.intercept = null;
    }
    expect(failed.statusCode).toBe(500);
    expect(await counter()).toBe(used); // the rollback gave the number back
    expect(await countOrders()).toBe(ordersBefore);
    const after = body(await create('owner', await valid())).order.order_no as string;
    expect(Number(after.slice(-4))).toBe(Number(before.slice(-4)) + 1);
  });

  it('the audit row: one insert row for the order in each mechanism of L1 (the triggers, and the Node writer)', async () => {
    for (const world of [w, wn]) {
      const payload = { order_id: randomUUID(), customer_id: await addCustomer(world), description: 'Kundan set' };
      expect((await create('biller', payload, randomUUID(), world)).statusCode).toBe(201);
      const audit = await auditRows(world, 'orders', payload.order_id);
      expect(audit.map((r) => [r.action, r.actor, r.actor_role])).toEqual([['insert', world.world.fixtures.biller.userId, 'biller']]);
    }
  });
});

// ------------------------------------------------------------------ the edit

describe('FB-E1 PATCH /v1/orders/:id (the edit, A5)', () => {
  it('the owner and a biller change description, delivery date, status and notes: 200 { row }, a new stamp, the caller as updated_by', async () => {
    for (const caller of ['owner', 'biller'] as const) {
      const id = await addOrder();
      const res = await edit(caller, id, STAMP_WIRE, { description: 'Gold ring, size 15', delivery_date: '2026-10-25', status: 'in_progress', notes: 'resized' });
      expect(res.statusCode, res.body).toBe(200);
      expect(body(res).row).toMatchObject({ id, description: 'Gold ring, size 15', delivery_date: '2026-10-25', status: 'in_progress', notes: 'resized', updated_by: w.world.fixtures[caller].userId });
      expect(body(res).row.updated_at).not.toBe(STAMP_WIRE);
      const cleared = await edit(caller, id, body(res).row.updated_at, { delivery_date: null, notes: '' });
      expect([cleared.statusCode, body(cleared).row.delivery_date, body(cleared).row.notes]).toEqual([200, null, null]);
    }
  });

  it('staff may not edit (403 JV_FORBIDDEN) and nothing changes', async () => {
    const id = await addOrder();
    const res = await edit('staff', id, STAMP_WIRE, { status: 'ready' });
    expect([res.statusCode, codeOf(res)]).toEqual([403, 'JV_FORBIDDEN']);
    expect(await stampOf(w, 'orders', id)).toBe(STAMP_WIRE);
  });

  it('a stale stamp is 409 JV_STALE with the row as it is now in details.current, and nothing is written', async () => {
    const id = await addOrder();
    const first = await edit('biller', id, STAMP_WIRE, { status: 'ready' });
    expect(first.statusCode).toBe(200);
    const stale = await edit('owner', id, STAMP_WIRE, { description: 'changed on another phone' });
    expect([stale.statusCode, codeOf(stale)]).toEqual([409, 'JV_STALE']);
    expect(detailsOf(stale).current).toEqual(body(first).row);
    expect((await rows('SELECT description FROM orders WHERE id = ?', [id]))[0].description).toBe('Silver anklets, pair');
  });

  it('an unknown status is 422 JV_INVALID_INPUT on changes.status; the number, the customer and the stamps cannot be sent', async () => {
    const id = await addOrder();
    for (const status of ['done', 'Ready', 'pending', '', 5]) {
      const res = await edit('owner', id, STAMP_WIRE, { status });
      expect([String(status), res.statusCode, codeOf(res), detailsOf(res)?.field]).toEqual([String(status), 422, 'JV_INVALID_INPUT', 'changes.status']);
    }
    for (const field of ['order_no', 'customer_id']) {
      const res = await edit('owner', id, STAMP_WIRE, { [field]: field === 'order_no' ? 'ORD-2026-9999' : await addCustomer() });
      expect([field, res.statusCode, codeOf(res)]).toEqual([field, 403, 'JV_FORBIDDEN']);
    }
    const stamp = await edit('owner', id, STAMP_WIRE, { updated_at: STAMP_WIRE });
    expect([stamp.statusCode, codeOf(stamp)]).toEqual([422, 'JV_INVALID_INPUT']);
    expect(await stampOf(w, 'orders', id)).toBe(STAMP_WIRE);
  });

  it('a biller walks an order open -> in_progress -> ready -> delivered, and may cancel an order that is not delivered', async () => {
    const id = await addOrder();
    let stamp = STAMP_WIRE;
    for (const status of ['in_progress', 'ready', 'delivered']) {
      const res = await edit('biller', id, stamp, { status });
      expect([status, res.statusCode]).toEqual([status, 200]);
      stamp = body(res).row.updated_at;
    }
    const open = await addOrder();
    expect((await edit('biller', open, STAMP_WIRE, { status: 'cancelled' })).statusCode).toBe(200);
  });

  it('delivered -> cancelled is allowed only for the owner: a biller is 409 JV_NOT_ALLOWED on changes.status and nothing changes', async () => {
    const id = await addOrder(w, { status: 'delivered' });
    const biller = await edit('biller', id, STAMP_WIRE, { status: 'cancelled' });
    expect([biller.statusCode, codeOf(biller), detailsOf(biller)?.field]).toEqual([409, 'JV_NOT_ALLOWED', 'changes.status']);
    expect(await stampOf(w, 'orders', id)).toBe(STAMP_WIRE);
    const owner = await edit('owner', id, STAMP_WIRE, { status: 'cancelled' });
    expect([owner.statusCode, body(owner).row.status]).toEqual([200, 'cancelled']);
  });

  it('a biller may still change the description and notes of a delivered order; its status is the owner\'s', async () => {
    const id = await addOrder(w, { status: 'delivered' });
    const res = await edit('biller', id, STAMP_WIRE, { notes: 'collected by her son' });
    expect(res.statusCode).toBe(200);
    const back = await edit('biller', id, body(res).row.updated_at, { status: 'ready' });
    expect([back.statusCode, codeOf(back)]).toEqual([409, 'JV_NOT_ALLOWED']);
  });

  it('the audit row: one update row in each mechanism of L1', async () => {
    for (const world of [w, wn]) {
      const id = await addOrder(world);
      expect((await edit('biller', id, STAMP_WIRE, { status: 'ready' }, world)).statusCode).toBe(200);
      const audit = (await auditRows(world, 'orders', id)).filter((r) => r.action === 'update');
      expect(audit).toHaveLength(1);
      const asJson = (v: unknown) => (typeof v === 'string' ? JSON.parse(v) : v);
      expect([asJson(audit[0].old_row).status, asJson(audit[0].new_row).status]).toEqual(['open', 'ready']);
    }
  });
});

// ------------------------------------------------------------------ the sync read

describe('FB-E1 GET /v1/sync/orders (the owner, a biller and staff read)', () => {
  it('every role reads the orders, with exactly the order columns, in the order of updated_at; the poll names the resource orders', async () => {
    const id = await addOrder(w, { delivery_date: '2026-10-18', photo_ids: [] });
    for (const caller of ['owner', 'biller', 'staff'] as const) {
      const res = await getPage(w.world, caller, 'orders', { limit: 1000 });
      expect(res.statusCode, res.body).toBe(200);
      const page = body(res);
      const mine = page.rows.find((r: any) => r.id === id);
      expect(Object.keys(mine).sort()).toEqual([...ORDER_COLUMNS].sort());
      expect(mine).toMatchObject({ delivery_date: '2026-10-18', status: 'open', photo_ids: [], updated_at: STAMP_WIRE });
      const stamps = page.rows.map((r: any) => r.updated_at as string); // ordered by (updated_at, id); the id is compared as a UUID by the server, not as text, so only the stamps are checked here
      expect(stamps).toEqual([...stamps].sort());
    }
    const polled = await poll(w.world, 'staff', { cursors: { orders: null } });
    expect(polled.statusCode).toBe(200);
    expect(body(polled).results.orders.rows.some((r: any) => r.id === id)).toBe(true);
  });

  it('no session reads nothing (401)', async () => {
    expect((await getPage(w.world, 'anon', 'orders')).statusCode).toBe(401);
  });
});

// ------------------------------------------------------------------ photos

describe('FB-E1 PUT /v1/orders/:order_id/photos/:photo_id (the PhotoStore of P1 to P3)', () => {
  it('the screen uploads first, then creates the order with the photo ids: 201 for each kind, the photo is read without a session, and the order carries the ids', async () => {
    const orderId = randomUUID();
    const photo = randomUUID();
    const full = await upload('biller', orderId, photo, 'full', jpeg(500));
    expect(full.statusCode, full.body).toBe(201);
    expect(body(full)).toMatchObject({ photo_id: photo, order_id: orderId, kind: 'full', mime: 'image/jpeg', byte_size: 500 });
    expect((await upload('biller', orderId, photo, 'thumb', jpeg(120))).statusCode).toBe(201);
    const stored = await rows('SELECT kind, design_id, order_id FROM design_photos WHERE id = ? ORDER BY kind', [photo]);
    expect(stored).toEqual([{ kind: 'full', design_id: orderId, order_id: orderId }, { kind: 'thumb', design_id: orderId, order_id: orderId }]);
    expect((await read(w, photo, 'full')).statusCode).toBe(200);
    const res = await create('biller', await valid({ order_id: orderId, photo_ids: [photo] }));
    expect(res.statusCode, res.body).toBe(201);
    expect(body(res).order.photo_ids).toEqual([photo]);
  });

  it('staff may not upload an order photo (403); the rules of P1 hold: a non-image is 415, more than 2 MiB 413, a kind that is not full or thumb 422', async () => {
    const orderId = await addOrder();
    expect((await upload('staff', orderId, randomUUID(), 'full', jpeg(300))).statusCode).toBe(403);
    const text = await upload('owner', orderId, randomUUID(), 'full', Buffer.from('plain words, not a picture'.repeat(10)));
    expect([text.statusCode, codeOf(text)]).toEqual([415, 'JV_UNSUPPORTED_MEDIA_TYPE']);
    const big = await upload('owner', orderId, randomUUID(), 'full', jpeg(2 * 1024 * 1024 + 1));
    expect([big.statusCode, codeOf(big)]).toEqual([413, 'JV_PAYLOAD_TOO_LARGE']);
    const kind = await upload('owner', orderId, randomUUID(), 'big', jpeg(300));
    expect([kind.statusCode, codeOf(kind)]).toEqual([422, 'JV_INVALID_INPUT']);
  });

  it('at most 3 live photos an order: the 4th id is 409 JV_NOT_ALLOWED (reason order_full); the thumbnail of a stored id is not a 4th; a removed photo frees its place', async () => {
    const orderId = await addOrder();
    const ids = [await photoFor(orderId), await photoFor(orderId), await photoFor(orderId)];
    const fourth = await upload('biller', orderId, randomUUID(), 'full', jpeg(300));
    expect([fourth.statusCode, codeOf(fourth)]).toEqual([409, 'JV_NOT_ALLOWED']);
    expect(detailsOf(fourth)).toMatchObject({ field: 'order_id', reason: 'order_full' });
    expect((await w.world.call('owner', 'POST', `/v1/photos/${ids[0]}/remove`)).statusCode).toBe(200);
    expect((await upload('biller', orderId, randomUUID(), 'full', jpeg(300))).statusCode).toBe(201);
  });

  it('a pair that exists is never overwritten (409 JV_NOT_ALLOWED, reason duplicate)', async () => {
    const orderId = await addOrder();
    const id = await photoFor(orderId);
    const again = await upload('owner', orderId, id, 'full', jpeg(300));
    expect([again.statusCode, detailsOf(again)?.reason]).toEqual([409, 'duplicate']);
  });

  it('the edit attaches the order\'s own photos only: one of another order, of a design, with one kind or removed is 422 on changes.photo_ids; a biller only adds at the end, the owner reorders', async () => {
    const id = await addOrder();
    const other = await addOrder();
    const mine = await photoFor(id);
    const second = await photoFor(id);
    const foreign = await photoFor(other);
    const designPhoto = randomUUID();
    expect((await uploadForDesign(w, 'owner', id, designPhoto, 'full', jpeg(300))).statusCode).toBe(201); // a DESIGN photo under the order's id: not the order's
    expect((await uploadForDesign(w, 'owner', id, designPhoto, 'thumb', jpeg(80))).statusCode).toBe(201);
    const half = randomUUID();
    expect((await upload('biller', id, half, 'full', jpeg(300))).statusCode).toBe(201);
    for (const bad of [foreign, designPhoto, half, randomUUID()]) {
      const res = await edit('biller', id, STAMP_WIRE, { photo_ids: [bad] });
      expect([res.statusCode, codeOf(res), detailsOf(res)?.field]).toEqual([422, 'JV_INVALID_INPUT', 'changes.photo_ids']);
    }
    const added = await edit('biller', id, STAMP_WIRE, { photo_ids: [mine, second] });
    expect([added.statusCode, body(added).row.photo_ids]).toEqual([200, [mine, second]]);
    const reorder = await edit('biller', id, body(added).row.updated_at, { photo_ids: [second, mine] });
    expect([reorder.statusCode, codeOf(reorder)]).toEqual([422, 'JV_INVALID_INPUT']);
    const owner = await edit('owner', id, body(added).row.updated_at, { photo_ids: [second, mine] });
    expect([owner.statusCode, body(owner).row.photo_ids]).toEqual([200, [second, mine]]);
  });

  it('the create refuses a photo of another order, and an order photo cannot be attached to a design that happens to carry the same id', async () => {
    const otherOrder = await addOrder();
    const foreign = await photoFor(otherOrder);
    const res = await create('biller', await valid({ photo_ids: [foreign] }));
    expect([res.statusCode, codeOf(res), detailsOf(res)?.field]).toEqual([422, 'JV_INVALID_INPUT', 'photo_ids']);
    await addDesign(w, { id: otherOrder }); // a design whose id is the order's: the photo rows' design_id matches it
    const onDesign = await patch(w, 'owner', 'designs', otherOrder, STAMP_WIRE, { photo_ids: [foreign] });
    expect([onDesign.statusCode, codeOf(onDesign), detailsOf(onDesign)?.field]).toEqual([422, 'JV_INVALID_INPUT', 'changes.photo_ids']);
  });
});
