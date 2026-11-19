import { randomUUID } from 'node:crypto';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { READ_COLUMNS } from '../../src/permissions/matrix';
import { TICK_KEYS, type TickKey, closeOverNeeds } from '../../src/permissions/ticks';
import { insert } from '../schema/support';
import { dbCounts } from './download-support';
import { TODAY, TOMORROW, YESTERDAY, addCustomer, addRate, allRows, rateBody } from './edit-13b-support';
import { type EditWorld, STAMP_DB, STAMP_WIRE, addDesign, addPhoto, addPiece, body, codeOf, dbRow, detailsOf, editWorld, snapshot } from './edit-support';
import { jpeg } from './photo-support';
import { designPayload, privateOf, requestIdOf, rows } from './stock-support';
import { csrfHeaders } from './support';

// Task 8 of the access plan (R4, R7, R8; DESIGN.md 6.2, 6.3, P2, P3): the generic edit engine and the orders, photos, stock and download-record code ask the PERSON'S ticks (`auth.user.grants`, read from the
// database on every request), not the role's name. Until this task the engine handed the session's role KEY (a string) to the matrix, which resolved it through the three built-in sets, so a custom role that
// passed the route gate on its ticks was refused again by the engine itself (its field rights, its rules, its second check) and again when its answer rows were shaped.
//
// The roles here are CUSTOM: a key that is none of owner, biller and staff, made with World.addRole, holding exactly the ticks the test gives and, in person(), what the API would force with them
// (closeOverNeeds: a role is saved with the ticks it needs). bare() makes the odd role a hand edit could leave: the ticks as given, not closed. The three built-in roles are covered by the edit-*, x08, x09,
// x13 and photos tests, which stay as they were.
//
// The world is the scratch database of the other edit tests (the real routes, the seeds, the generated audit triggers, a clock fixed at 17 Oct 2026 10:00 UTC = 15:30 in Kolkata, "today" is 2026-10-17).

let w: EditWorld;

beforeAll(async () => {
  w = await editWorld('accedit', { triggers: true });
}, 120_000);
afterAll(async () => {
  await w?.world.close();
}, 60_000);

// ------------------------------------------------------------------ people and calls

interface Person {
  userId: string;
  cookie: string;
  roleKey: string;
}

/** A person in a custom role holding exactly closeOverNeeds(ticks): the role as the API would save it. */
async function person(ticks: readonly TickKey[]): Promise<Person> {
  const role = await w.world.addRole({ ticks: closeOverNeeds(ticks) });
  const user = await w.world.addUser({ role: role.key });
  return { userId: user.userId, cookie: user.cookie, roleKey: role.key };
}

/** A person in a custom role holding exactly `ticks`, NOT closed over their needs: what a hand edit of the roles table can leave. */
async function bare(ticks: readonly TickKey[]): Promise<Person> {
  const role = await w.world.addRole({ ticks });
  const user = await w.world.addUser({ role: role.key });
  return { userId: user.userId, cookie: user.cookie, roleKey: role.key };
}

/** Every tick but these (a role the API saves as it is when none of the ticks it holds needs one of the left-out ones). */
const everythingBut = (...left: TickKey[]): Promise<Person> => person(TICK_KEYS.filter((t) => !left.includes(t)));

type Method = 'POST' | 'PUT' | 'PATCH';

const send = (who: { cookie: string }, method: Method, url: string, payload?: unknown, headers: Record<string, string> = {}): Promise<LightMyRequestResponse> =>
  w.world.app.inject({ method, url, headers: { ...csrfHeaders(), cookie: who.cookie, ...headers }, payload: payload as object });

/** PATCH /v1/<collection>/<id> with the body of A5 (the stamp exactly as it was read, only the changed fields). */
const patchAs = (who: { cookie: string }, collection: string, id: string, expected: string, changes: Record<string, unknown>) =>
  send(who, 'PATCH', `/v1/${collection}/${id}`, { expected_updated_at: expected, changes });

/** A call that carries an Idempotency-Key (a new one unless given). */
const postKeyed = (who: { cookie: string }, url: string, payload: unknown, key: string = randomUUID()) => send(who, 'POST', url, payload, { 'idempotency-key': key });

/** The raw bytes of one object of a photo, as the website sends it. */
const putBytes = (who: { cookie: string }, url: string, bytes: Buffer) => send(who, 'PUT', url, bytes as unknown as string, { 'content-type': 'image/jpeg' });

const TABLES = ['designs', 'skus', 'sku_private', 'categories', 'subcategories', 'daily_rates', 'customers', 'orders', 'design_photos', 'settings', 'sys_idempotency', 'audit_log'] as const;

/**
 * What a call that is refused must leave as it found it: the rows of every table an edit can reach, the claims, the audit rows and the counters. The audit triggers are installed, so a row that is
 * changed (and not only one that is added) leaves an audit row: the count shows it.
 */
async function trace(): Promise<Record<string, number | string>> {
  const out: Record<string, number | string> = {};
  for (const t of TABLES) out[t] = Number((await w.world.sql.query<any[]>(`SELECT COUNT(*) AS n FROM \`${t}\``))[0][0].n);
  out.counters = String((await w.world.sql.query<any[]>('SELECT COALESCE(SUM(last_value), 0) AS n FROM sys_counters'))[0][0].n);
  return out;
}

/** A refusal with nothing written: the status, the code, the field when one is named, and the trace unchanged. */
async function refusedClean(res: LightMyRequestResponse, before: Record<string, number | string>, status: number, code: string, field?: string): Promise<void> {
  expect(res.statusCode, res.body).toBe(status);
  expect(codeOf(res)).toBe(code);
  if (field !== undefined) expect(detailsOf(res)?.field).toBe(field);
  expect(await trace(), 'the refused call left something behind').toEqual(before);
}

// ------------------------------------------------------------------ rows typed in by SQL

let orders = 0;
/** An order typed in by SQL with the fixture's stamp, as an earlier create would have left it. */
async function addOrder(o: Record<string, unknown> = {}): Promise<string> {
  const id = randomUUID();
  await insert(w.world.sql, 'orders', { id, order_no: `ORD-1999-${String(++orders).padStart(4, '0')}`, customer_id: await addCustomer(w), description: 'Silver anklets, pair', created_at: STAMP_DB, updated_at: STAMP_DB, ...o });
  return id;
}

/** A whole photo of an order: the full image and its thumbnail under one new id, uploaded by the route as `who`. */
async function orderPhoto(who: { cookie: string }, orderId: string): Promise<string> {
  const id = randomUUID();
  for (const [kind, size] of [['full', 400], ['thumb', 100]] as const) {
    const res = await putBytes(who, `/v1/orders/${orderId}/photos/${id}?kind=${kind}`, jpeg(size));
    expect(res.statusCode, res.body).toBe(201);
  }
  return id;
}

const ARCHIVE_AT = '2026-10-17T10:00:00.000000Z';
const columnsOf = (row: Record<string, unknown>): string[] => Object.keys(row).sort();

// ------------------------------------------------------------------ 1. photo_rewrite

describe('photo_rewrite is needed to remove, reorder or replace photo ids of a design AND of an order; adding at the end needs only stock_edit / order_edit', () => {
  it('a design: stock_edit alone adds ids at the end; reorder, remove and replace need photo_rewrite too; photo_rewrite without stock_edit is refused at the gate', async () => {
    const adder = await person(['stock_edit']);
    const rewriter = await person(['stock_edit', 'photo_rewrite']);
    const rewriteOnly = await person(['photo_rewrite']);
    const design = await addDesign(w);
    const [p1, p2, p3] = [await addPhoto(w, design), await addPhoto(w, design), await addPhoto(w, design)];

    const first = await patchAs(adder, 'designs', design, STAMP_WIRE, { photo_ids: [p1] });
    expect(first.statusCode, first.body).toBe(200);
    const second = await patchAs(adder, 'designs', design, body(first).row.updated_at, { photo_ids: [p1, p2] });
    expect(second.statusCode, second.body).toBe(200);
    expect(body(second).row.photo_ids).toEqual([p1, p2]);
    let stamp: string = body(second).row.updated_at;

    // reorder, remove, replace: stock_edit is not enough, and nothing is written
    for (const [what, ids] of [['reorder', [p2, p1]], ['remove', [p1]], ['replace', [p1, p3]]] as const) {
      const before = await trace();
      const snap = await snapshot(w, 'designs', design);
      const res = await patchAs(adder, 'designs', design, stamp, { photo_ids: [...ids] });
      await refusedClean(res, before, 422, 'JV_INVALID_INPUT', 'changes.photo_ids');
      expect(await snapshot(w, 'designs', design), what).toBe(snap);
    }

    // photo_rewrite without stock_edit does not even pass the gate
    const before = await trace();
    await refusedClean(await patchAs(rewriteOnly, 'designs', design, stamp, { photo_ids: [p2, p1] }), before, 403, 'JV_FORBIDDEN');

    // with both ticks the same three changes are made
    for (const [what, ids] of [['reorder', [p2, p1]], ['remove', [p2]], ['replace', [p3]]] as const) {
      const res = await patchAs(rewriter, 'designs', design, stamp, { photo_ids: [...ids] });
      expect(res.statusCode, `${what}: ${res.body}`).toBe(200);
      expect(body(res).row.photo_ids).toEqual(ids);
      stamp = body(res).row.updated_at;
    }
  });

  it('an order: order_edit alone adds ids at the end; reorder, remove and replace need photo_rewrite too', async () => {
    const adder = await person(['order_edit']);
    const rewriter = await person(['order_edit', 'photo_rewrite']);
    const rewriteOnly = await person(['photo_rewrite']);
    const order = await addOrder();
    const [p1, p2, p3] = [await orderPhoto(adder, order), await orderPhoto(adder, order), await orderPhoto(adder, order)];

    const first = await patchAs(adder, 'orders', order, STAMP_WIRE, { photo_ids: [p1] });
    expect(first.statusCode, first.body).toBe(200);
    const second = await patchAs(adder, 'orders', order, body(first).row.updated_at, { photo_ids: [p1, p2] });
    expect(second.statusCode, second.body).toBe(200);
    expect(body(second).row.photo_ids).toEqual([p1, p2]);
    let stamp: string = body(second).row.updated_at;

    for (const [what, ids] of [['reorder', [p2, p1]], ['remove', [p1]], ['replace', [p1, p3]]] as const) {
      const before = await trace();
      const snap = await snapshot(w, 'orders', order);
      const res = await patchAs(adder, 'orders', order, stamp, { photo_ids: [...ids] });
      await refusedClean(res, before, 422, 'JV_INVALID_INPUT', 'changes.photo_ids');
      expect(await snapshot(w, 'orders', order), what).toBe(snap);
    }

    const before = await trace();
    await refusedClean(await patchAs(rewriteOnly, 'orders', order, stamp, { photo_ids: [p2, p1] }), before, 403, 'JV_FORBIDDEN');

    for (const [what, ids] of [['reorder', [p2, p1]], ['remove', [p2]], ['replace', [p3]]] as const) {
      const res = await patchAs(rewriter, 'orders', order, stamp, { photo_ids: [...ids] });
      expect(res.statusCode, `${what}: ${res.body}`).toBe(200);
      expect(body(res).row.photo_ids).toEqual(ids);
      stamp = body(res).row.updated_at;
    }
  });
});

// ------------------------------------------------------------------ 2. rates

describe('rates: rate_enter inserts today\'s rate; another date also needs back_date; rate_correct updates; neither tick, 403', () => {
  it('the ticks of the person decide, field by field and date by date', async () => {
    const enterer = await person(['rate_enter']);
    const backdater = await person(['rate_enter', 'back_date']);
    const corrector = await person(['rate_correct']); // the API saves it with rate_enter
    const neither = await everythingBut('rate_enter', 'rate_correct');

    // today's rate: rate_enter is enough; the answer is the row of the daily_rates read and the person is the one who confirmed it
    const made = await send(enterer, 'POST', '/v1/daily-rates', rateBody({ purity: 'AE1' }));
    expect(made.statusCode, made.body).toBe(201);
    expect(body(made).row).toMatchObject({ material: 'Gold', purity: 'AE1', rate_per_gram: '7050.00', rate_date: TODAY, confirmed_by: enterer.userId, created_by: enterer.userId });
    expect(columnsOf(body(made).row)).toEqual([...READ_COLUMNS.daily_rates].sort());

    // another date: refused without back_date (nothing written), saved with it; tomorrow is refused for everybody
    const before = await trace();
    await refusedClean(await send(enterer, 'POST', '/v1/daily-rates', rateBody({ purity: 'AE2', rate_date: YESTERDAY })), before, 422, 'JV_INVALID_INPUT', 'rate_date');
    const past = await send(backdater, 'POST', '/v1/daily-rates', rateBody({ purity: 'AE2', rate_date: YESTERDAY }));
    expect(past.statusCode, past.body).toBe(201);
    expect(body(past).row.rate_date).toBe(YESTERDAY);
    const future = await trace();
    await refusedClean(await send(backdater, 'POST', '/v1/daily-rates', rateBody({ purity: 'AE3', rate_date: TOMORROW })), future, 422, 'JV_INVALID_INPUT', 'rate_date');

    // the correction of a rate dated today: rate_correct only
    const id = await addRate(w, { purity: 'AC1', rate_date: TODAY });
    const kept = await trace();
    const keptRow = await snapshot(w, 'daily_rates', id);
    await refusedClean(await patchAs(enterer, 'daily-rates', id, STAMP_WIRE, { rate_per_gram: '7100.00' }), kept, 403, 'JV_FORBIDDEN');
    expect(await snapshot(w, 'daily_rates', id)).toBe(keptRow);
    const corrected = await patchAs(corrector, 'daily-rates', id, STAMP_WIRE, { rate_per_gram: '7100.00' });
    expect(corrected.statusCode, corrected.body).toBe(200);
    expect(body(corrected).row).toMatchObject({ id, rate_per_gram: '7100.00', confirmed_by: corrector.userId, updated_by: corrector.userId });
    expect((await dbRow(w, 'daily_rates', id)).rate_per_gram).toBe('7100.00');

    // neither tick: both calls are refused at the gate and nothing is written
    const none = await trace();
    await refusedClean(await send(neither, 'POST', '/v1/daily-rates', rateBody({ purity: 'AE4' })), none, 403, 'JV_FORBIDDEN');
    await refusedClean(await patchAs(neither, 'daily-rates', id, body(corrected).row.updated_at, { rate_per_gram: '7200.00' }), none, 403, 'JV_FORBIDDEN');
    expect((await dbRow(w, 'daily_rates', id)).rate_per_gram).toBe('7100.00');
  });
});

// ------------------------------------------------------------------ 3. customers

describe('customers: customer_edit sends content fields; archived_at needs customer_archive; customer_archive alone is refused without customer_view only because the tick set is closed by needs', () => {
  it('customer_edit sends the content fields and not archived_at, alone or beside a field that is allowed; customer_archive sends archived_at and nothing else', async () => {
    const editor = await person(['customer_edit']);
    const archiver = await person(['customer_archive']);
    const id = await addCustomer(w);

    const edited = await patchAs(editor, 'customers', id, STAMP_WIRE, { name: 'Edited By A Custom Role', notes: 'a note' });
    expect(edited.statusCode, edited.body).toBe(200);
    expect(body(edited).row).toMatchObject({ id, name: 'Edited By A Custom Role', notes: 'a note', archived_at: null, updated_by: editor.userId });
    expect(columnsOf(body(edited).row)).toEqual([...READ_COLUMNS.customers].sort());
    let stamp: string = body(edited).row.updated_at;

    for (const changes of [{ archived_at: ARCHIVE_AT }, { notes: 'applied?', archived_at: ARCHIVE_AT }]) {
      const before = await trace();
      const snap = await snapshot(w, 'customers', id);
      await refusedClean(await patchAs(editor, 'customers', id, stamp, changes), before, 403, 'JV_FORBIDDEN', 'changes.archived_at');
      expect(await snapshot(w, 'customers', id)).toBe(snap);
    }

    // the archiver sends archived_at and nothing else
    const before = await trace();
    await refusedClean(await patchAs(archiver, 'customers', id, stamp, { name: 'Not Allowed' }), before, 403, 'JV_FORBIDDEN', 'changes.name');
    await refusedClean(await patchAs(archiver, 'customers', id, stamp, { notes: 'x', archived_at: ARCHIVE_AT }), before, 403, 'JV_FORBIDDEN', 'changes.notes');
    const archived = await patchAs(archiver, 'customers', id, stamp, { archived_at: ARCHIVE_AT });
    expect(archived.statusCode, archived.body).toBe(200);
    expect(body(archived).row.archived_at).not.toBeNull();
    expect((await dbRow(w, 'customers', id)).archived_at).not.toBeNull();
    stamp = body(archived).row.updated_at;
    const back = await patchAs(archiver, 'customers', id, stamp, { archived_at: null });
    expect(back.statusCode, back.body).toBe(200);
    expect(body(back).row.archived_at).toBeNull();
  });

  it('customer_archive alone, without the customer_view the API would save it with, passes the gate and the field right but is refused when the customer is to be shown to it: nothing is written', async () => {
    expect(closeOverNeeds(['customer_archive'])).toEqual(['customer_view', 'customer_archive']);
    const odd = await bare(['customer_archive']);
    const id = await addCustomer(w);
    const before = await trace();
    const snap = await snapshot(w, 'customers', id);
    await refusedClean(await patchAs(odd, 'customers', id, STAMP_WIRE, { archived_at: ARCHIVE_AT }), before, 403, 'JV_FORBIDDEN');
    expect(await snapshot(w, 'customers', id)).toBe(snap);
  });
});

// ------------------------------------------------------------------ 4. designs

describe('designs: stock_edit sends content fields; material, purity and selling_method need design_material; both together may send all', () => {
  it('stock_edit sends the content fields only; design_material sends the three only; both together send all of them in one call', async () => {
    const content = await person(['stock_edit']);
    const material = await person(['design_material']);
    const both = await person(['stock_edit', 'design_material']);
    const neither = await everythingBut('stock_edit', 'design_material');
    const design = await addDesign(w, { material: 'Gold', purity: '22K', selling_method: 'By Weight' });

    const named = await patchAs(content, 'designs', design, STAMP_WIRE, { name: 'Named By Content', description: 'text', tags: ['a'] });
    expect(named.statusCode, named.body).toBe(200);
    expect(body(named).row).toMatchObject({ id: design, name: 'Named By Content', updated_by: content.userId });
    expect(columnsOf(body(named).row)).toEqual([...READ_COLUMNS.designs].sort());
    let stamp: string = body(named).row.updated_at;

    // the three fields of design_material are not stock_edit's, alone or beside an allowed field
    for (const changes of [{ material: 'Silver' }, { purity: '18K' }, { selling_method: 'Per Piece' }, { name: 'x', purity: '18K' }]) {
      const before = await trace();
      const snap = await snapshot(w, 'designs', design);
      const [field] = Object.keys(changes).filter((k) => k !== 'name');
      await refusedClean(await patchAs(content, 'designs', design, stamp, changes), before, 403, 'JV_FORBIDDEN', `changes.${field}`);
      expect(await snapshot(w, 'designs', design)).toBe(snap);
    }

    // design_material sends the three and not the content fields
    const before = await trace();
    await refusedClean(await patchAs(material, 'designs', design, stamp, { name: 'Not Allowed' }), before, 403, 'JV_FORBIDDEN', 'changes.name');
    const changed = await patchAs(material, 'designs', design, stamp, { material: 'Silver', purity: '999', selling_method: 'Per Piece' });
    expect(changed.statusCode, changed.body).toBe(200);
    expect(body(changed).row).toMatchObject({ material: 'Silver', purity: '999', selling_method: 'Per Piece', name: 'Named By Content', updated_by: material.userId });
    stamp = body(changed).row.updated_at;

    // both ticks: all of it in one call
    const all = await patchAs(both, 'designs', design, stamp, { name: 'All In One', notes: 'n', material: 'Gold', purity: '24K', selling_method: 'By Weight' });
    expect(all.statusCode, all.body).toBe(200);
    expect(body(all).row).toMatchObject({ name: 'All In One', notes: 'n', material: 'Gold', purity: '24K', selling_method: 'By Weight', updated_by: both.userId });

    // neither tick: the gate
    const none = await trace();
    await refusedClean(await patchAs(neither, 'designs', design, body(all).row.updated_at, { name: 'Nope' }), none, 403, 'JV_FORBIDDEN');
  });
});

// ------------------------------------------------------------------ 5. original_net_weight

describe('original_net_weight: create_design and edit:sku_private need secret_weight; a role without it sending the field gets 403 JV_FORBIDDEN', () => {
  const group = (original?: string) => ({ pieces: 2, gross_weight: '12.500', customer_net_weight: '11.000', labour_retail: '350.00', ...(original === undefined ? {} : { original_net_weight: original }) });

  it('create_design: a role without secret_weight that sends the field is refused naming it and writes nothing (the key stays free); with it the weight is stored and answered; without the field no weight is answered', async () => {
    const adder = await person(['stock_add']);
    const withSecret = await person(['stock_add', 'secret_weight']);
    const payload = designPayload(w, { pieces: [group('10.500')] });
    const key = randomUUID();

    const before = await trace();
    await refusedClean(await postKeyed(adder, '/v1/designs', payload, key), before, 403, 'JV_FORBIDDEN', 'pieces[0].original_net_weight');

    const made = await postKeyed(withSecret, '/v1/designs', payload, key); // the same key: the claim of the refused call was rolled back
    expect(made.statusCode, made.body).toBe(201);
    expect(made.headers['idempotent-replay']).toBeUndefined();
    expect(body(made).sku_private.map((r: any) => r.original_net_weight)).toEqual(['10.500', '10.500']);
    expect(columnsOf(body(made).sku_private[0])).toEqual([...READ_COLUMNS.sku_private].sort());
    expect((await privateOf(w, payload.design_id)).map((r) => r.original_net_weight)).toEqual(['10.500', '10.500']);

    // the same role without the field: the design is made and the answer never holds a weight
    const plain = await postKeyed(adder, '/v1/designs', designPayload(w, { pieces: [group()] }));
    expect(plain.statusCode, plain.body).toBe(201);
    expect(Object.keys(body(plain)).sort()).toEqual(['design', 'skus']);
    expect(plain.body).not.toContain('original_net_weight');
  });

  it('edit:sku_private: secret_weight writes and reads the weight (201, then 200 with the stamp); a role without it is refused at the gate and nothing is written', async () => {
    const secret = await person(['secret_weight']);
    const noSecret = await everythingBut('secret_weight', 'activity_log'); // activity_log needs secret_weight
    const piece = await addPiece(w, await addDesign(w));

    const before = await trace();
    await refusedClean(await send(noSecret, 'PUT', `/v1/sku-private/${piece}`, { original_net_weight: '8.500' }), before, 403, 'JV_FORBIDDEN');

    const first = await send(secret, 'PUT', `/v1/sku-private/${piece}`, { original_net_weight: '8.500' });
    expect(first.statusCode, first.body).toBe(201);
    expect(body(first).row).toMatchObject({ sku_id: piece, original_net_weight: '8.500', created_by: secret.userId });
    expect(columnsOf(body(first).row)).toEqual([...READ_COLUMNS.sku_private].sort());
    const second = await send(secret, 'PUT', `/v1/sku-private/${piece}`, { original_net_weight: '9.000', expected_updated_at: body(first).row.updated_at });
    expect(second.statusCode, second.body).toBe(200);
    expect(body(second).row.original_net_weight).toBe('9.000');

    const kept = await trace();
    await refusedClean(await send(noSecret, 'PUT', `/v1/sku-private/${piece}`, { original_net_weight: '1.000', expected_updated_at: body(second).row.updated_at }), kept, 403, 'JV_FORBIDDEN');
    expect((await rows(w, 'SELECT original_net_weight FROM sku_private WHERE sku_id = ?', [piece])).map((r) => r.original_net_weight)).toEqual(['9.000']);
  });
});

// ------------------------------------------------------------------ 6. closed orders

describe('a delivered or cancelled order changes only with order_closed_change', () => {
  it('a status change on a closed order needs order_closed_change; the other fields of a closed order, and any status change of an open one, need order_edit only', async () => {
    const orderer = await person(['order_edit']);
    const closer = await person(['order_edit', 'order_closed_change']);

    for (const closed of ['delivered', 'cancelled'] as const) {
      const id = await addOrder({ status: closed });
      const before = await trace();
      const snap = await snapshot(w, 'orders', id);
      await refusedClean(await patchAs(orderer, 'orders', id, STAMP_WIRE, { status: 'open' }), before, 409, 'JV_NOT_ALLOWED', 'changes.status');
      expect(await snapshot(w, 'orders', id), closed).toBe(snap);

      // the rest of a closed order is order_edit's
      const noted = await patchAs(orderer, 'orders', id, STAMP_WIRE, { notes: 'called the customer', description: 'Silver anklets, pair (engraved)' });
      expect(noted.statusCode, noted.body).toBe(200);
      expect(body(noted).row).toMatchObject({ status: closed, notes: 'called the customer' });

      const reopened = await patchAs(closer, 'orders', id, body(noted).row.updated_at, { status: 'open' });
      expect(reopened.statusCode, reopened.body).toBe(200);
      expect(body(reopened).row).toMatchObject({ status: 'open', updated_by: closer.userId });
    }

    // an open order walks to delivered with order_edit alone, and then it is closed for that role
    const open = await addOrder({ status: 'ready' });
    const delivered = await patchAs(orderer, 'orders', open, STAMP_WIRE, { status: 'delivered' });
    expect(delivered.statusCode, delivered.body).toBe(200);
    const before = await trace();
    await refusedClean(await patchAs(orderer, 'orders', open, body(delivered).row.updated_at, { status: 'cancelled' }), before, 409, 'JV_NOT_ALLOWED', 'changes.status');
    const cancelled = await patchAs(closer, 'orders', open, body(delivered).row.updated_at, { status: 'cancelled' });
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    expect(body(cancelled).row.status).toBe('cancelled');
  });
});

// ------------------------------------------------------------------ 7. categories and settings

describe('categories: category_add inserts; category_edit updates and switches off; settings: settings_change writes value', () => {
  it('categories and sub-categories: add and edit are separate ticks', async () => {
    const adder = await person(['category_add']);
    const editor = await person(['category_edit']);

    const made = await send(adder, 'POST', '/v1/categories', { name: 'Custom Role Category', prefix: 'CRC' });
    expect(made.statusCode, made.body).toBe(201);
    expect(columnsOf(body(made).row)).toEqual([...READ_COLUMNS.categories].sort());
    const category: string = body(made).row.id;
    const before = await trace();
    await refusedClean(await send(editor, 'POST', '/v1/categories', { name: 'Editor Category', prefix: 'EDC' }), before, 403, 'JV_FORBIDDEN');
    await refusedClean(await patchAs(adder, 'categories', category, body(made).row.updated_at, { active: false }), before, 403, 'JV_FORBIDDEN');
    const off = await patchAs(editor, 'categories', category, body(made).row.updated_at, { name: 'Custom Role Category Off', active: false });
    expect(off.statusCode, off.body).toBe(200);
    expect(body(off).row).toMatchObject({ name: 'Custom Role Category Off', active: false, updated_by: editor.userId });

    const sub = await send(adder, 'POST', '/v1/subcategories', { category_id: w.category, name: 'Custom Role Sub' });
    expect(sub.statusCode, sub.body).toBe(201);
    expect(columnsOf(body(sub).row)).toEqual([...READ_COLUMNS.subcategories].sort());
    const kept = await trace();
    await refusedClean(await send(editor, 'POST', '/v1/subcategories', { category_id: w.category, name: 'Editor Sub' }), kept, 403, 'JV_FORBIDDEN');
    await refusedClean(await patchAs(adder, 'subcategories', body(sub).row.id, body(sub).row.updated_at, { active: false }), kept, 403, 'JV_FORBIDDEN');
    const subOff = await patchAs(editor, 'subcategories', body(sub).row.id, body(sub).row.updated_at, { active: false });
    expect(subOff.statusCode, subOff.body).toBe(200);
    expect(body(subOff).row).toMatchObject({ active: false, updated_by: editor.userId });
  });

  it('settings: settings_change writes a value (made or changed); a role with every other tick is refused and the values stay', async () => {
    const shop = await person(['settings_change']);
    const others = await everythingBut('settings_change');

    const before = await allRows(w, 'settings');
    const refused = await send(others, 'PUT', '/v1/settings/locations', { value: ['Hacked'] });
    expect([refused.statusCode, codeOf(refused)]).toEqual([403, 'JV_FORBIDDEN']);
    expect(await allRows(w, 'settings')).toBe(before);

    const changed = await send(shop, 'PUT', '/v1/settings/locations', { value: ['Main Showroom', 'Vault'] });
    expect(changed.statusCode, changed.body).toBe(200);
    expect(body(changed).row).toMatchObject({ setting_key: 'locations', value: ['Main Showroom', 'Vault'], updated_by: shop.userId });
    expect(columnsOf(body(changed).row)).toEqual([...READ_COLUMNS.settings].sort());

    const made = await send(shop, 'PUT', '/v1/settings/custom_role_key', { value: { a: 1 } });
    expect(made.statusCode, made.body).toBe(201);
    expect(body(made).row).toMatchObject({ setting_key: 'custom_role_key', value: { a: 1 } });

    // the two keys the generic edit never writes stay refused for the person who may write the others
    const never = await send(shop, 'PUT', '/v1/settings/last_download', { value: { at: 'x' } });
    expect([never.statusCode, codeOf(never)]).toEqual([403, 'JV_FORBIDDEN']);
  });
});

// ------------------------------------------------------------------ the other callers of this task

describe('create_design, set_sku_status, create_order and the photo routes ask the ticks of the person who calls', () => {
  it('X8 create_design: a custom role with stock_add makes a design; a role with every other tick is refused at the gate and nothing is written', async () => {
    const adder = await person(['stock_add']);
    const others = await everythingBut('stock_add');
    const payload = designPayload(w, { pieces: [{ pieces: 2, gross_weight: '5.000', customer_net_weight: '4.500' }] });

    const before = await trace();
    await refusedClean(await postKeyed(others, '/v1/designs', payload), before, 403, 'JV_FORBIDDEN');
    const made = await postKeyed(adder, '/v1/designs', payload);
    expect(made.statusCode, made.body).toBe(201);
    expect(columnsOf(body(made).design)).toEqual([...READ_COLUMNS.designs].sort());
    expect(body(made).skus).toHaveLength(2);
    expect(columnsOf(body(made).skus[0])).toEqual([...READ_COLUMNS.skus].sort());
    expect((await trace()).designs).toBe((before.designs as number) + 1);
  });

  it('X9 set_sku_status: a custom role with stock_status changes the status; a role with every other tick is refused and the piece stays', async () => {
    const statuser = await person(['stock_status']);
    const others = await everythingBut('stock_status');
    const piece = await addPiece(w, await addDesign(w));

    const before = await trace();
    await refusedClean(await postKeyed(others, '/v1/skus/status', { sku_ids: [piece], status: 'Repair' }), before, 403, 'JV_FORBIDDEN');
    expect((await dbRow(w, 'skus', piece)).status).toBe('In Stock');
    const done = await postKeyed(statuser, '/v1/skus/status', { sku_ids: [piece], status: 'Repair', note: 'polish' });
    expect(done.statusCode, done.body).toBe(200);
    expect(body(done).skus.map((r: any) => [r.id, r.status])).toEqual([[piece, 'Repair']]);
    expect(columnsOf(body(done).skus[0])).toEqual([...READ_COLUMNS.skus].sort());
    expect((await dbRow(w, 'skus', piece)).status).toBe('Repair');
  });

  it('X13 create_order: a custom role with order_edit makes an order; a role with every other tick is refused and no number is used', async () => {
    const orderer = await person(['order_edit']);
    const others = await everythingBut('order_edit');
    const customer = await addCustomer(w);
    const payload = () => ({ order_id: randomUUID(), customer_id: customer, description: 'Gold ring, size 14, name engraved inside' });

    const before = await trace();
    await refusedClean(await postKeyed(others, '/v1/orders', payload()), before, 403, 'JV_FORBIDDEN');
    const made = await postKeyed(orderer, '/v1/orders', payload());
    expect(made.statusCode, made.body).toBe(201);
    expect(columnsOf(body(made).order)).toEqual([...READ_COLUMNS.orders].sort());
    expect(body(made).order).toMatchObject({ status: 'open', created_by: orderer.userId });
    expect(body(made).order.order_no).toMatch(/^ORD-2026-\d{4}$/);
  });

  it('the photo routes: stock_add uploads a design photo, order_edit an order photo, photo_rewrite removes one; a role without the tick is refused and nothing is stored', async () => {
    const designer = await person(['stock_add']);
    const orderer = await person(['order_edit']);
    const remover = await person(['photo_rewrite']);
    const noAdd = await everythingBut('stock_add');
    const noOrder = await everythingBut('order_edit');
    const noRewrite = await everythingBut('photo_rewrite');
    const design = randomUUID();
    const order = await addOrder();
    const photo = randomUUID();
    const designUrl = (id: string, kind = 'full') => `/v1/designs/${design}/photos/${id}?kind=${kind}`;
    const orderUrl = (id: string, kind = 'full') => `/v1/orders/${order}/photos/${id}?kind=${kind}`;

    const before = await trace();
    await refusedClean(await putBytes(noAdd, designUrl(photo), jpeg(300)), before, 403, 'JV_FORBIDDEN');
    await refusedClean(await putBytes(noOrder, orderUrl(photo), jpeg(300)), before, 403, 'JV_FORBIDDEN');
    // a design photo is not an order photo and the other way round: the tick of the other row does not open this one
    await refusedClean(await putBytes(designer, orderUrl(photo), jpeg(300)), before, 403, 'JV_FORBIDDEN');
    await refusedClean(await putBytes(orderer, designUrl(photo), jpeg(300)), before, 403, 'JV_FORBIDDEN');

    for (const kind of ['full', 'thumb'] as const) {
      const up = await putBytes(designer, designUrl(photo, kind), jpeg(kind === 'full' ? 300 : 80));
      expect(up.statusCode, up.body).toBe(201);
      expect(body(up)).toMatchObject({ photo_id: photo, design_id: design, kind });
    }
    const orderPhotoId = await orderPhoto(orderer, order);
    expect((await rows(w, 'SELECT kind, order_id FROM design_photos WHERE id = ? ORDER BY kind', [orderPhotoId])).map((r) => [r.kind, r.order_id])).toEqual([['full', order], ['thumb', order]]);

    // removal: photo_rewrite alone; the others (even with every other tick) cannot
    const kept = await trace();
    await refusedClean(await send(noRewrite, 'POST', `/v1/photos/${photo}/remove`), kept, 403, 'JV_FORBIDDEN');
    await refusedClean(await send(designer, 'POST', `/v1/photos/${photo}/remove`), kept, 403, 'JV_FORBIDDEN');
    const removed = await send(remover, 'POST', `/v1/photos/${photo}/remove`);
    expect(removed.statusCode, removed.body).toBe(200);
    expect(body(removed)).toMatchObject({ photo_id: photo, removed: true });
    expect((await rows(w, 'SELECT removed_at FROM design_photos WHERE id = ?', [photo])).every((r) => r.removed_at !== null)).toBe(true);
    const gone = await send(remover, 'POST', `/v1/photos/${randomUUID()}/remove`);
    expect([gone.statusCode, codeOf(gone)]).toEqual([404, 'JV_NOT_FOUND']); // the tick opens the call; the photo has to exist
  });
});

// ------------------------------------------------------------------ the download record

describe('owner:download_record: a custom role with download_all alone completes the call end to end', () => {
  const URL = '/v1/owner/download-record';

  it('download_all alone records the download: the answer is the record, the setting is stored and audited under the person and the role key; settings_change is not needed', async () => {
    const downloader = await person(['download_all']);
    expect(closeOverNeeds(['download_all'])).toEqual(['download_all']);
    const counts = await dbCounts(w.world.sql);
    const before = await trace();

    const res = await send(downloader, 'POST', URL, { date: TODAY, counts });
    expect(res.statusCode, res.body).toBe(200);
    expect(body(res)).toEqual({ last_download: { at: expect.stringMatching(/^2026-10-17T10:00:00\.\d{3}Z$/), by: downloader.userId, counts } });
    const [stored] = await rows(w, "SELECT value, updated_by FROM settings WHERE setting_key = 'last_download'");
    expect(typeof stored.value === 'string' ? JSON.parse(stored.value) : stored.value).toEqual(body(res).last_download);
    expect(stored.updated_by).toBe(downloader.userId);
    const log = await rows(w, 'SELECT actor, actor_role, table_name, row_id FROM audit_log WHERE request_id = ?', [requestIdOf(res)]);
    expect(log.map((r) => [r.table_name, r.row_id, r.actor, r.actor_role])).toEqual([['settings', 'last_download', downloader.userId, downloader.roleKey]]);
    expect((await trace()).settings).toBe((before.settings as number) + 1);

    // a second record by the same person: an update, still one audit row for the call
    const again = await send(downloader, 'POST', URL, { date: TODAY, counts: await dbCounts(w.world.sql) });
    expect(again.statusCode, again.body).toBe(200);
    expect((await rows(w, 'SELECT action FROM audit_log WHERE request_id = ?', [requestIdOf(again)])).map((r) => r.action)).toEqual(['update']);
  });

  it('a role with every other tick (settings_change included) is refused and nothing is written; the key of the setting is not a thing settings_change gives', async () => {
    const others = await everythingBut('download_all');
    const before = await trace();
    const settingBefore = await rows(w, "SELECT value, updated_by, updated_at FROM settings WHERE setting_key = 'last_download'");
    await refusedClean(await send(others, 'POST', URL, { date: TODAY, counts: await dbCounts(w.world.sql) }), before, 403, 'JV_FORBIDDEN');
    expect(await rows(w, "SELECT value, updated_by, updated_at FROM settings WHERE setting_key = 'last_download'")).toEqual(settingBefore);
  });

  it('counts that are not the books are still refused for the person who may record (the rules of the call stay): 422 naming the file, nothing written', async () => {
    const downloader = await person(['download_all']);
    const counts = await dbCounts(w.world.sql);
    const before = await trace();
    await refusedClean(await send(downloader, 'POST', URL, { date: TODAY, counts: { ...counts, customers: counts.customers + 50 } }), before, 422, 'JV_INVALID_INPUT', 'counts.customers');
  });
});

// ------------------------------------------------------------------ the answer follows what the person may read

describe('the answer rows and the stale answer follow what the person may read, resource by resource (R7)', () => {
  it('a stale edit answers 409 JV_STALE with the current row cut to the columns of the resource, for a custom role that may read it', async () => {
    const stockEditor = await person(['stock_edit']);
    const customerEditor = await person(['customer_edit']);
    const orderEditor = await person(['order_edit']);

    const design = await addDesign(w);
    const customer = await addCustomer(w);
    const order = await addOrder();
    for (const [who, collection, id, field, columns] of [
      [stockEditor, 'designs', design, 'name', READ_COLUMNS.designs],
      [customerEditor, 'customers', customer, 'name', READ_COLUMNS.customers],
      [orderEditor, 'orders', order, 'notes', READ_COLUMNS.orders],
    ] as const) {
      const table = collection.replaceAll('-', '_');
      const first = await patchAs(who, collection, id, STAMP_WIRE, { [field]: 'First' });
      expect(first.statusCode, first.body).toBe(200);
      const before = await snapshot(w, table, id);
      const late = await patchAs(who, collection, id, STAMP_WIRE, { [field]: 'Second' });
      expect([collection, late.statusCode, codeOf(late)]).toEqual([collection, 409, 'JV_STALE']);
      expect(detailsOf(late).current).toEqual(body(first).row);
      expect(columnsOf(detailsOf(late).current)).toEqual([...columns].sort());
      expect(await snapshot(w, table, id)).toBe(before);
    }
  });

  it('a stale PUT of the original weight by a custom role with secret_weight answers 409 JV_STALE with the row of the sku_private read; one with every other tick never gets that far (403)', async () => {
    const secret = await person(['secret_weight']);
    const noSecret = await everythingBut('secret_weight', 'activity_log');
    const piece = await addPiece(w, await addDesign(w));
    const first = await send(secret, 'PUT', `/v1/sku-private/${piece}`, { original_net_weight: '8.500' });
    expect(first.statusCode, first.body).toBe(201);
    const before = await trace();
    const late = await send(secret, 'PUT', `/v1/sku-private/${piece}`, { original_net_weight: '9.000', expected_updated_at: '2020-01-01T00:00:00.000000Z' });
    await refusedClean(late, before, 409, 'JV_STALE');
    expect(detailsOf(late).current).toEqual(body(first).row);
    expect(columnsOf(detailsOf(late).current)).toEqual([...READ_COLUMNS.sku_private].sort());
    const refused = await send(noSecret, 'PUT', `/v1/sku-private/${piece}`, { original_net_weight: '9.000', expected_updated_at: '2020-01-01T00:00:00.000000Z' });
    await refusedClean(refused, before, 403, 'JV_FORBIDDEN');
    expect(refused.body).not.toContain('8.500');
  });

  it('a stale edit by a role that may write a resource it may not read (a hand edit: customer_edit without customer_view, order_edit without order_view) is 403 and the row is not in the answer', async () => {
    const customerEditor = await bare(['customer_edit']);
    const orderEditor = await bare(['order_edit']);
    const customer = await addCustomer(w, { name: 'Secret Customer Name', mobile: '9811122233' });
    const order = await addOrder({ description: 'Secret order description' });

    for (const [who, collection, id, changes, secret] of [
      [customerEditor, 'customers', customer, { name: 'Late' }, '9811122233'],
      [orderEditor, 'orders', order, { notes: 'Late' }, 'Secret order description'],
    ] as const) {
      // a stamp that is not the stored one: the stale answer would carry the row
      const before = await trace();
      const res = await patchAs(who, collection, id, '2020-01-01T00:00:00.000000Z', changes);
      await refusedClean(res, before, 403, 'JV_FORBIDDEN');
      expect(res.body).not.toContain(secret);
      // and a call with the right stamp is refused too, when its own answer is to be shaped: nothing is written
      const answered = await patchAs(who, collection, id, STAMP_WIRE, changes);
      await refusedClean(answered, before, 403, 'JV_FORBIDDEN');
      expect(answered.body).not.toContain(secret);
    }
  });

  it('create_order by a role that may make orders but not read them (order_edit without order_view) is refused when its answer is shaped: nothing is written and no number is used', async () => {
    const odd = await bare(['order_edit']);
    const customer = await addCustomer(w);
    const before = await trace();
    await refusedClean(await postKeyed(odd, '/v1/orders', { order_id: randomUUID(), customer_id: customer, description: 'An order nobody may see' }), before, 403, 'JV_FORBIDDEN');
  });
});

// ------------------------------------------------------------------ the Super Admin flag

describe('the Super Admin flag holds every tick whatever the role is (R3, R4): the edits, the weight, the closed orders, the photos and the download record work for a flagged login on a role with no tick', () => {
  let flagRates = 0; // one purity for each rate: a rate is unique for its date, material and purity
  /** The calls of this task, each on its own fresh rows, made by whoever is given. Each answers the status a person who may do it gets. */
  const CALLS: [string, (who: { cookie: string }) => Promise<LightMyRequestResponse>, number][] = [
    ['photo_rewrite: reorder the photo ids of a design', async (who) => {
      const design = randomUUID();
      const [a, b] = [await addPhoto(w, design), await addPhoto(w, design)];
      await addDesign(w, { id: design, photo_ids: JSON.stringify([a, b]) });
      return patchAs(who, 'designs', design, STAMP_WIRE, { photo_ids: [b, a] });
    }, 200],
    ['design_material: change the material of a design', async (who) => patchAs(who, 'designs', await addDesign(w), STAMP_WIRE, { material: 'Silver' }), 200],
    ['rate_enter and back_date: a past rate', async (who) => send(who, 'POST', '/v1/daily-rates', rateBody({ purity: `F${++flagRates}`, rate_date: YESTERDAY })), 201],
    ['customer_archive: archive a customer', async (who) => patchAs(who, 'customers', await addCustomer(w), STAMP_WIRE, { archived_at: ARCHIVE_AT }), 200],
    ['order_closed_change: change a delivered order', async (who) => patchAs(who, 'orders', await addOrder({ status: 'delivered' }), STAMP_WIRE, { status: 'open' }), 200],
    ['secret_weight: write the original weight', async (who) => send(who, 'PUT', `/v1/sku-private/${await addPiece(w, await addDesign(w))}`, { original_net_weight: '7.250' }), 201],
    ['secret_weight and stock_add: create a design with the weight', async (who) => postKeyed(who, '/v1/designs', designPayload(w, { pieces: [{ pieces: 1, gross_weight: '5.000', customer_net_weight: '4.500', original_net_weight: '4.250' }] })), 201],
    ['settings_change: write a setting', async (who) => send(who, 'PUT', '/v1/settings/locations', { value: ['Main Showroom'] }), 200],
    ['download_all: record the download', async (who) => send(who, 'POST', '/v1/owner/download-record', { date: TODAY, counts: await dbCounts(w.world.sql) }), 200],
  ];

  it.each(CALLS)('%s', async (_name, call, ok) => {
    const flagged = await w.world.addUser({ role: (await w.world.addRole({ ticks: [] })).key, superAdmin: true }); // a role with no tick at all, and the flag
    const plain = await w.world.addUser({ role: (await w.world.addRole({ ticks: [] })).key }); // the same without the flag
    const refused = await call(plain);
    expect(refused.statusCode, refused.body).toBe(403);
    const done = await call(flagged);
    expect(done.statusCode, done.body).toBe(ok);
  });

  it('the Super Admin as the system makes her (role owner and the flag) works too, and her audit rows name the role key owner', async () => {
    const design = await addDesign(w);
    const res = await w.world.call('super', 'PATCH', `/v1/designs/${design}`, { payload: { expected_updated_at: STAMP_WIRE, changes: { material: 'Silver' } } });
    expect(res.statusCode, res.body).toBe(200);
    const [row] = await rows(w, 'SELECT actor, actor_role FROM audit_log WHERE request_id = ?', [requestIdOf(res)]);
    expect(row).toMatchObject({ actor: w.world.fixtures.super.userId, actor_role: 'owner' });
  });
});

// ------------------------------------------------------------------ the audit trail

describe('the audit trail names the role KEY, not the ticks (the Activity Log shows the key as the actor role)', () => {
  it('an edit by a custom role is logged with the person as the actor and the key of the role as the actor role', async () => {
    const editor = await person(['stock_edit']);
    const design = await addDesign(w);
    const res = await patchAs(editor, 'designs', design, STAMP_WIRE, { name: 'Logged' });
    expect(res.statusCode, res.body).toBe(200);
    const log = await rows(w, 'SELECT actor, actor_role, table_name, row_id, action FROM audit_log WHERE request_id = ?', [requestIdOf(res)]);
    expect(log).toEqual([{ actor: editor.userId, actor_role: editor.roleKey, table_name: 'designs', row_id: design, action: 'update' }]);
  });

  it('create_order, create_design and set_sku_status: every audit row of the call names the person and the role key', async () => {
    const orderer = await person(['order_edit']);
    const stocker = await person(['stock_add', 'stock_status']);
    const customer = await addCustomer(w);
    const made = await postKeyed(orderer, '/v1/orders', { order_id: randomUUID(), customer_id: customer, description: 'Logged order' });
    expect(made.statusCode, made.body).toBe(201);
    const design = await postKeyed(stocker, '/v1/designs', designPayload(w, { pieces: [{ pieces: 2, gross_weight: '5.000', customer_net_weight: '4.500' }] }));
    expect(design.statusCode, design.body).toBe(201);
    const status = await postKeyed(stocker, '/v1/skus/status', { sku_ids: [body(design).skus[0].id], status: 'Repair' });
    expect(status.statusCode, status.body).toBe(200);

    for (const [res, tables, who] of [
      [made, ['orders'], orderer],
      [design, ['designs', 'skus', 'skus'], stocker],
      [status, ['skus'], stocker],
    ] as const) {
      const log = await rows(w, 'SELECT actor, actor_role, table_name FROM audit_log WHERE request_id = ? ORDER BY id', [requestIdOf(res)]);
      expect(log.map((r) => r.table_name).sort()).toEqual([...tables].sort());
      for (const r of log) expect([r.actor, r.actor_role]).toEqual([who.userId, who.roleKey]);
    }
    expect(body(made).order.created_by).toBe(orderer.userId); // and the stamp on the row is the person
  });
});
