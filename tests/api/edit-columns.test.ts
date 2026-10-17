import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CATEGORIES, SUBCATEGORIES } from '../../src/edit/catalogue';
import { DESIGNS } from '../../src/edit/designs';
import { SKUS } from '../../src/edit/skus';
import { MATRIX, READ_COLUMNS, WRITE_COLUMNS, writeFieldVerdict } from '../../src/permissions/matrix';
import { timestampToWire } from '../../src/wire/format';
import { type EditWorld, STAMP_WIRE, addDesign, addPiece, body, codeOf, dbRow, detailsOf, editWorld, patch, snapshot } from './edit-support';
import { getPage } from './sync-support';

// API13, which fields an edit may carry (A5, A4):
//   T-D19  A field outside the content columns cannot be updated (403) and an unknown field gives 422; every read role can read archived rows; an update by staff of `archived_at` on a design succeeds.
//   T-D02  (clause) WRITE_COLUMNS of categories and subcategories: A5 lists designs, skus and customers only, so D5 and the table of A4 are the source, and the lists are confirmed here.
// "A field outside the list" is a real column of the table that is not on the caller's list (a state that only a function changes, a number that never changes, a column of another role's list): 403
// JV_FORBIDDEN. "An unknown field" is a name that is no column, and the stamps and person columns, which no request may name (S6, D22): 422 JV_INVALID_INPUT. Nothing is silently ignored.

let w: EditWorld;
let design: string;
let piece: string;
beforeAll(async () => {
  w = await editWorld('editcols');
  design = await addDesign(w);
  piece = await addPiece(w, design);
}, 120_000);
afterAll(async () => {
  await w?.world.close();
});

describe('T-D19 a field outside the content columns is refused with 403 JV_FORBIDDEN, and the row is untouched', () => {
  const designFields = ['material', 'purity', 'selling_method', 'design_no', 'id', 'import_batch_id'];
  it.each(designFields)('staff sending the design column %s is 403', async (field) => {
    const before = await snapshot(w, 'designs', design);
    const res = await patch(w, 'staff', 'designs', design, STAMP_WIRE, { [field]: 'x' });
    expect(res.statusCode).toBe(403);
    expect(codeOf(res)).toBe('JV_FORBIDDEN');
    expect(detailsOf(res)).toEqual({ field: `changes.${field}` });
    expect(await snapshot(w, 'designs', design)).toBe(before);
  });

  it.each(['design_no', 'id', 'import_batch_id'])('the owner sending the design column %s is 403 too: a number that never changes, an id, the import\'s bookkeeping', async (field) => {
    const before = await snapshot(w, 'designs', design);
    const res = await patch(w, 'owner', 'designs', design, STAMP_WIRE, { [field]: 'x' });
    expect(res.statusCode).toBe(403);
    expect(codeOf(res)).toBe('JV_FORBIDDEN');
    expect(await snapshot(w, 'designs', design)).toBe(before);
  });

  const skuFields = ['status', 'archived_at', 'sold_bill_id', 'sku_no', 'barcode', 'design_id', 'id', 'import_batch_id'];
  for (const caller of ['owner', 'staff'] as const) {
    it.each(skuFields)(`${caller} sending the piece column %s is 403`, async (field) => {
      const before = await snapshot(w, 'skus', piece);
      const res = await patch(w, caller, 'skus', piece, STAMP_WIRE, { [field]: null });
      expect(res.statusCode).toBe(403);
      expect(codeOf(res)).toBe('JV_FORBIDDEN');
      expect(await snapshot(w, 'skus', piece)).toBe(before);
    });
  }

  it('a field that is allowed and a field that is not, in one call: the call is refused and the allowed field is not applied', async () => {
    const before = await snapshot(w, 'designs', design);
    const res = await patch(w, 'staff', 'designs', design, STAMP_WIRE, { notes: 'applied?', material: 'Silver' });
    expect(res.statusCode).toBe(403);
    expect(await snapshot(w, 'designs', design)).toBe(before);
  });

  it('a caller whose role is not on the row at all (a biller on a stock edit) gets 403 before the body is looked at: even a nonsense body learns nothing', async () => {
    for (const payload of [{ nonsense: true }, {}, { expected_updated_at: 'x', changes: { colour: 1 } }]) {
      const res = await w.world.call('biller', 'PATCH', `/v1/designs/${design}`, { payload });
      expect(res.statusCode).toBe(403);
      expect(codeOf(res)).toBe('JV_FORBIDDEN');
    }
  });
});

describe('T-D19 an unknown field gives 422 JV_INVALID_INPUT naming it, and nothing is stored', () => {
  for (const [collection, id] of [
    ['designs', () => design],
    ['skus', () => piece],
  ] as const) {
    for (const caller of ['owner', 'staff'] as const) {
      it(`${caller} on ${collection}: a name that is no column, and the stamps and person columns that no request may name`, async () => {
        for (const field of ['colour', 'no_such_column_x', 'created_at', 'updated_at', 'created_by', 'updated_by', 'set_by', 'confirmed_by', 'voided_by']) {
          const before = await snapshot(w, collection, id());
          const res = await patch(w, caller, collection, id(), STAMP_WIRE, { [field]: field.endsWith('_by') ? randomUUID() : '2026-10-17T10:00:00.000000Z' });
          expect(res.statusCode, field).toBe(422);
          expect(codeOf(res), field).toBe('JV_INVALID_INPUT');
          expect(detailsOf(res), field).toEqual({ field: `changes.${field}` });
          expect(await snapshot(w, collection, id()), field).toBe(before);
        }
      });
    }
  }

  it('an unknown key beside the changes (outside them) is refused too, and a key called __proto__ is just an unknown name', async () => {
    const res = await w.world.call('owner', 'PATCH', `/v1/designs/${design}`, { payload: { expected_updated_at: STAMP_WIRE, changes: { notes: 'x' }, force: true } });
    expect(res.statusCode).toBe(422);
    expect(detailsOf(res)).toEqual({ field: 'force' });
    const proto = await w.world.call('owner', 'PATCH', `/v1/designs/${design}`, { headers: { 'content-type': 'application/json' }, payload: `{"expected_updated_at":"${STAMP_WIRE}","changes":{"__proto__":{"material":"Silver"}}}` });
    expect(proto.statusCode).toBe(422);
    expect(codeOf(proto)).toBe('JV_INVALID_INPUT');
    expect((await dbRow(w, 'designs', design)).material).toBe('Gold');
  });

  it('a body that is not {expected_updated_at, changes: {at least one field}} is 422', async () => {
    const send = (payload: unknown) => w.world.call('owner', 'PATCH', `/v1/designs/${design}`, { payload: payload as object });
    expect((await send({ changes: { notes: 'x' } })).statusCode).toBe(422);
    expect((await send({ expected_updated_at: STAMP_WIRE })).statusCode).toBe(422);
    const empty = await send({ expected_updated_at: STAMP_WIRE, changes: {} });
    expect(empty.statusCode).toBe(422);
    expect(detailsOf(empty)).toEqual({ field: 'changes' });
    expect((await send({ expected_updated_at: STAMP_WIRE, changes: [] })).statusCode).toBe(422);
    expect((await send({ expected_updated_at: STAMP_WIRE, changes: null })).statusCode).toBe(422);
    expect((await send({ expected_updated_at: 5, changes: { notes: 'x' } })).statusCode).toBe(422);
    expect((await w.world.call('owner', 'PATCH', `/v1/designs/${design}`, {})).statusCode).toBe(422);
  });

  it('the id in the address must be a UUID: anything else is 404 (there is no such row), never a database error', async () => {
    const res = await w.world.call('owner', 'PATCH', '/v1/designs/not-a-uuid', { payload: { expected_updated_at: STAMP_WIRE, changes: { notes: 'x' } } });
    expect(res.statusCode).toBe(404);
    expect(codeOf(res)).toBe('JV_NOT_FOUND');
    expect(JSON.parse(res.body).error.message).not.toMatch(/address/); // a missing row, not a path that is no route
  });
});

describe('T-D19 every read role can read archived rows; an update by staff of archived_at on a design succeeds (A4)', () => {
  it('the owner, a biller and staff read an archived design and an archived piece through the sync endpoints', async () => {
    const d = await addDesign(w, { archived_at: '2026-10-05 00:00:00.000000' });
    const p = await addPiece(w, d, { status: 'Archived', archived_at: '2026-10-05 00:00:00.000000' });
    for (const caller of ['owner', 'biller', 'staff'] as const) {
      const designs = body(await getPage(w.world, caller, 'designs')).rows as any[];
      const found = designs.find((r) => r.id === d);
      expect(found, `${caller} reads the archived design`).toBeDefined();
      expect(found.archived_at).toBe('2026-10-05T00:00:00.000000Z');
      const skus = body(await getPage(w.world, caller, 'skus')).rows as any[];
      const foundPiece = skus.find((r) => r.id === p);
      expect(foundPiece, `${caller} reads the archived piece`).toBeDefined();
      expect(foundPiece.status).toBe('Archived');
    }
  });

  it('staff archive a design that has no pieces, and bring it back with null: both go through, and the answer carries the new row', async () => {
    const d = await addDesign(w);
    const archive = await patch(w, 'staff', 'designs', d, STAMP_WIRE, { archived_at: '2026-10-17T10:00:00.000000Z' });
    expect(archive.statusCode, archive.body).toBe(200);
    const archived = body(archive).row;
    expect(archived.id).toBe(d);
    expect(archived.archived_at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/);
    expect((await dbRow(w, 'designs', d)).archived_at).not.toBeNull();
    const restore = await patch(w, 'staff', 'designs', d, archived.updated_at, { archived_at: null });
    expect(restore.statusCode, restore.body).toBe(200);
    expect(body(restore).row.archived_at).toBeNull();
    expect((await dbRow(w, 'designs', d)).archived_at).toBeNull();
  });

  it('the archive time is the API clock\'s reading, not what the client wrote (S6: stamps come from the API clock)', async () => {
    const d = await addDesign(w);
    const res = await patch(w, 'owner', 'designs', d, STAMP_WIRE, { archived_at: '2001-01-01T00:00:00.000000Z' });
    expect(res.statusCode, res.body).toBe(200);
    const stored = timestampToWire((await dbRow(w, 'designs', d)).archived_at as string);
    expect(stored).not.toBe('2001-01-01T00:00:00.000000Z');
    expect(w.time.readings.map((r) => timestampToWire(r.timestamp))).toContain(stored);
  });

  it('archived_at must be null or a timestamp as the server writes it', async () => {
    const d = await addDesign(w);
    for (const bad of [true, 0, 'yesterday', '2026-10-17', '2026-10-17T10:00:00Z']) {
      const res = await patch(w, 'staff', 'designs', d, STAMP_WIRE, { archived_at: bad });
      expect(res.statusCode, String(bad)).toBe(422);
    }
    expect((await dbRow(w, 'designs', d)).archived_at).toBeNull();
  });
});

describe('T-D19 the categories and subcategories rows (A4: owner S I U, staff S I, biller S)', () => {
  it('staff add a category, a biller cannot, and staff cannot rename one', async () => {
    const add = await w.world.call('staff', 'POST', '/v1/categories', { payload: { name: 'Toe Ring', prefix: 'TOE' } });
    expect(add.statusCode, add.body).toBe(201);
    expect(body(add).row).toMatchObject({ name: 'Toe Ring', prefix: 'TOE', active: true });
    const biller = await w.world.call('biller', 'POST', '/v1/categories', { payload: { name: 'Hair Pin', prefix: 'HAIR' } });
    expect(biller.statusCode).toBe(403);
    const rename = await patch(w, 'staff', 'categories', body(add).row.id, body(add).row.updated_at, { name: 'Toe Rings' });
    expect(rename.statusCode).toBe(403);
    expect(codeOf(rename)).toBe('JV_FORBIDDEN');
  });

  it('on a category the prefix is written once; a stamp or person column is an unknown field; `active` is not part of an insert', async () => {
    const add = await w.world.call('owner', 'POST', '/v1/categories', { payload: { name: 'Hair Pin', prefix: 'HAIR' } });
    expect(add.statusCode, add.body).toBe(201);
    const row = body(add).row;
    const prefix = await patch(w, 'owner', 'categories', row.id, row.updated_at, { prefix: 'HP' });
    expect(prefix.statusCode).toBe(403);
    const unknown = await patch(w, 'owner', 'categories', row.id, row.updated_at, { created_by: randomUUID() });
    expect(unknown.statusCode).toBe(422);
    const active = await w.world.call('owner', 'POST', '/v1/categories', { payload: { name: 'Brooch Pin', prefix: 'BPIN', active: false } });
    expect(active.statusCode).toBe(403);
    const stamp = await w.world.call('owner', 'POST', '/v1/categories', { payload: { name: 'Brooch Pin', prefix: 'BPIN', created_at: '2020-01-01T00:00:00.000000Z' } });
    expect(stamp.statusCode).toBe(422);
    expect(detailsOf(stamp)).toEqual({ field: 'created_at' });
    expect((await dbRow(w, 'categories', row.id)).prefix).toBe('HAIR');
  });
});

describe('T-D02 (API13 clause) WRITE_COLUMNS of categories and subcategories: D5 and the A4 table are the source, A5 names designs, skus and customers only', () => {
  // D5 (spec line 121): categories hold `name` (unique ignoring case), `prefix` (2 to 6 capitals or digits) and `active`; subcategories hold `category_id`, `name` (unique per category) and `active`.
  // A4 (spec line 165, row `categories`, `subcategories`): owner S, I, U; biller S; staff S, I. The prototype's catalogStore.ts adds a category with its prefix, adds a subcategory under a category,
  // renames a subcategory and removes one (in this design a removal is `active` = false: nothing is deleted, S7); it never renames a category's prefix or moves a subcategory.
  const list = (action: keyof typeof WRITE_COLUMNS, role: 'owner' | 'staff') => [...((WRITE_COLUMNS[action] as Record<string, readonly string[]>)[role] ?? [])].sort();

  it('an insert carries the columns a person types: the name and prefix of a category, the category and name of a subcategory; the owner and staff may insert (A4 `I`)', () => {
    expect(list('edit:categories.insert', 'owner')).toEqual(['name', 'prefix']);
    expect(list('edit:categories.insert', 'staff')).toEqual(['name', 'prefix']);
    expect(list('edit:subcategories.insert', 'owner')).toEqual(['category_id', 'name']);
    expect(list('edit:subcategories.insert', 'staff')).toEqual(['category_id', 'name']);
    expect(MATRIX['edit:categories.insert'].roles).toEqual(['owner', 'staff']);
    expect(MATRIX['edit:subcategories.insert'].roles).toEqual(['owner', 'staff']);
  });

  it('an update (A4 `U`, the owner only) renames and switches `active`; the prefix (the series of the design numbers, L3) and the category of a subcategory (the designs refer to the pair) never change', () => {
    expect(list('edit:categories.update', 'owner')).toEqual(['active', 'name']);
    expect(list('edit:subcategories.update', 'owner')).toEqual(['active', 'name']);
    expect(MATRIX['edit:categories.update'].roles).toEqual(['owner']);
    expect(MATRIX['edit:subcategories.update'].roles).toEqual(['owner']);
  });

  it('every column named is a column of D5 (read from READ_COLUMNS, which lists the table), and the lists are what the classification of an edit uses', () => {
    for (const [action, table] of [
      ['edit:categories.insert', 'categories'],
      ['edit:categories.update', 'categories'],
      ['edit:subcategories.insert', 'subcategories'],
      ['edit:subcategories.update', 'subcategories'],
    ] as const) {
      for (const role of ['owner', 'staff'] as const) for (const c of list(action, role)) expect(READ_COLUMNS[table].owner, `${action}.${c}`).toContain(c);
    }
    expect(writeFieldVerdict('edit:categories.update', 'owner', 'name')).toBe('allowed');
    expect(writeFieldVerdict('edit:categories.update', 'owner', 'prefix')).toBe('forbidden');
    expect(writeFieldVerdict('edit:categories.update', 'staff', 'name')).toBe('forbidden');
    expect(writeFieldVerdict('edit:categories.update', 'owner', 'created_by')).toBe('unknown');
    expect(writeFieldVerdict('edit:categories.update', 'owner', 'whatever')).toBe('unknown');
  });

  it('writeFieldVerdict: a real column that is not on the role\'s list is forbidden, a stamp or person column and a name that is no column are unknown (A5, S6, D22)', () => {
    expect(writeFieldVerdict('edit:designs.update', 'staff', 'name')).toBe('allowed');
    expect(writeFieldVerdict('edit:designs.update', 'staff', 'material')).toBe('forbidden');
    expect(writeFieldVerdict('edit:designs.update', 'owner', 'material')).toBe('allowed');
    expect(writeFieldVerdict('edit:designs.update', 'owner', 'design_no')).toBe('forbidden');
    expect(writeFieldVerdict('edit:designs.update', 'owner', 'import_batch_id')).toBe('forbidden');
    expect(writeFieldVerdict('edit:skus.update', 'owner', 'status')).toBe('forbidden');
    expect(writeFieldVerdict('edit:skus.update', 'staff', 'archived_at')).toBe('forbidden');
    for (const stamp of ['created_at', 'updated_at', 'created_by', 'updated_by', 'set_by', 'confirmed_by']) expect(writeFieldVerdict('edit:skus.update', 'owner', stamp), stamp).toBe('unknown');
    expect(writeFieldVerdict('edit:skus.update', 'owner', 'colour')).toBe('unknown');
    expect(writeFieldVerdict('edit:skus.update', 'owner', '__proto__')).toBe('unknown');
    expect(writeFieldVerdict('edit:skus.update', 'owner', 'constructor')).toBe('unknown');
    expect(writeFieldVerdict('edit:skus.update', 'nobody', 'notes')).toBe('forbidden');
  });
});

describe('T-D02 (API13 clause) the matrix and the edit engine agree: every column on a WRITE_COLUMNS list of these rows has a field the engine can check, and the engine has no field the matrix does not list', () => {
  const tables = [DESIGNS, SKUS, CATEGORIES, SUBCATEGORIES];
  it('each column a role may send has a FieldSpec (otherwise a call would end in a 500), and each FieldSpec is on some role\'s list (otherwise it is dead code)', () => {
    for (const t of tables) {
      for (const action of [t.update, t.insert]) {
        if (!action) continue;
        const lists = Object.values(WRITE_COLUMNS[action] as Record<string, readonly string[]>).flat();
        for (const c of lists) expect(Object.hasOwn(t.fields, c), `${action}.${c}`).toBe(true);
      }
      const listed = new Set([t.update, t.insert].flatMap((a) => (a ? Object.values(WRITE_COLUMNS[a] as Record<string, readonly string[]>).flat() : [])));
      for (const c of Object.keys(t.fields)) expect(listed.has(c), `${t.table}.${c}`).toBe(true);
    }
  });
});
