import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runImport } from '../../scripts/import.mjs';
import { formatTimestamp } from '../../src/clock';
import { timestampToWire } from '../../src/wire/format';
import { type EditWorld, STAMP_DB, STAMP_WIRE, addDesign, addPiece, body, codeOf, dbRow, detailsOf, editWorld, patch, snapshot } from './edit-support';

// API13, the stamps and the person columns of every write (S6, D22):
//   T-D22  `created_by`, `updated_by`, `set_by` and `confirmed_by` come from the session user; a client-sent value is refused as an unknown field; they are null for an import; `created_at` and
//          `updated_at` come from the injected clock and move on every update, and a hand edit of a row moves `updated_at` through the column default when the statement does not name it (once
//          through phpMyAdmin's own row editor, which may send the old value: the test shows what happens and the runbook rule of B5 applies).
// (`set_by` and `confirmed_by` are the person columns of the daily rates, API13b; the tables of this task carry `created_by` and `updated_by`, and the other two are refused here as unknown fields.)

let w: EditWorld;
beforeAll(async () => {
  w = await editWorld('editstamps');
}, 120_000);
afterAll(async () => {
  await w?.world.close();
});

const user = (caller: 'owner' | 'staff' | 'biller') => w.world.fixtures[caller].userId;
const PERSON = ['created_by', 'updated_by', 'set_by', 'confirmed_by'];
const STAMPS = ['created_at', 'updated_at'];

describe('T-D22 the person columns come from the session user', () => {
  it('an edit sets updated_by to the caller and leaves created_by alone; the next caller replaces updated_by', async () => {
    const creator = randomUUID();
    const d = await addDesign(w, { created_by: creator, updated_by: creator });
    const byStaff = await patch(w, 'staff', 'designs', d, STAMP_WIRE, { notes: 'staff' });
    expect(byStaff.statusCode, byStaff.body).toBe(200);
    expect(body(byStaff).row).toMatchObject({ created_by: creator, updated_by: user('staff') });
    expect(await dbRow(w, 'designs', d)).toMatchObject({ created_by: creator, updated_by: user('staff') });
    const byOwner = await patch(w, 'owner', 'designs', d, body(byStaff).row.updated_at, { notes: 'owner' });
    expect(byOwner.statusCode, byOwner.body).toBe(200);
    expect(await dbRow(w, 'designs', d)).toMatchObject({ created_by: creator, updated_by: user('owner') });
  });

  it('the same for a piece, and a no-change edit changes no person column (nothing is written)', async () => {
    const d = await addDesign(w);
    const p = await addPiece(w, d);
    const res = await patch(w, 'staff', 'skus', p, STAMP_WIRE, { location: 'Vault' });
    expect(res.statusCode, res.body).toBe(200);
    expect(await dbRow(w, 'skus', p)).toMatchObject({ created_by: null, updated_by: user('staff') });
    const before = await snapshot(w, 'skus', p);
    const same = await patch(w, 'owner', 'skus', p, body(res).row.updated_at, { location: 'Vault' });
    expect(same.statusCode, same.body).toBe(200);
    expect(await snapshot(w, 'skus', p)).toBe(before);
  });

  it('an insert by staff sets created_by and updated_by to staff, from the same reading of the clock as created_at and updated_at; a subcategory the same', async () => {
    const add = await w.world.call('staff', 'POST', '/v1/categories', { payload: { name: 'Anklet Charm', prefix: 'ACH' } });
    expect(add.statusCode, add.body).toBe(201);
    const row = await dbRow(w, 'categories', body(add).row.id);
    expect([row.created_by, row.updated_by]).toEqual([user('staff'), user('staff')]);
    expect(row.created_at).toBe(row.updated_at);
    expect(w.time.readings.map((r) => r.timestamp)).toContain(row.created_at);
    const sub = await w.world.call('owner', 'POST', '/v1/subcategories', { payload: { category_id: row.id, name: 'Antique' } });
    expect(sub.statusCode, sub.body).toBe(201);
    const subRow = await dbRow(w, 'subcategories', body(sub).row.id);
    expect([subRow.created_by, subRow.updated_by]).toEqual([user('owner'), user('owner')]);
    expect(subRow.created_at).toBe(subRow.updated_at);
  });

  it('the answer names the same people (the row that replaces the screen\'s copy)', async () => {
    const add = await w.world.call('owner', 'POST', '/v1/categories', { payload: { name: 'Chain Charm', prefix: 'CCH' } });
    expect(body(add).row).toMatchObject({ created_by: user('owner'), updated_by: user('owner') });
  });
});

describe('T-D22 a person column or a stamp sent by a client is an unknown field: 422, never stored', () => {
  const fieldsOf = [...PERSON, ...STAMPS];
  const value = (f: string) => (f.endsWith('_by') ? randomUUID() : '2020-01-01T00:00:00.000000Z');

  it.each([
    ['designs', 'owner'],
    ['designs', 'staff'],
    ['skus', 'owner'],
    ['skus', 'staff'],
  ] as const)('PATCH of %s by %s with %s', async (collection, caller) => {
    const d = collection === 'designs' ? await addDesign(w) : await addPiece(w, await addDesign(w));
    const before = await snapshot(w, collection, d);
    for (const f of fieldsOf) {
      const res = await patch(w, caller, collection, d, STAMP_WIRE, { [f]: value(f) });
      expect(res.statusCode, `${collection}.${f}`).toBe(422);
      expect(codeOf(res)).toBe('JV_INVALID_INPUT');
      expect(detailsOf(res)).toEqual({ field: `changes.${f}` });
    }
    // a legitimate field with a forged person column beside it: refused as a whole
    const mixed = await patch(w, caller, collection, d, STAMP_WIRE, { notes: 'forged', updated_by: randomUUID() });
    expect(mixed.statusCode).toBe(422);
    expect(await snapshot(w, collection, d)).toBe(before);
  });

  it('POST of a category or a subcategory with one of them: 422 and no row is made', async () => {
    for (const f of fieldsOf) {
      const cat = await w.world.call('owner', 'POST', '/v1/categories', { payload: { name: `Forged ${f}`, prefix: 'FRG', [f]: value(f) } });
      expect(cat.statusCode, f).toBe(422);
      expect(detailsOf(cat)).toEqual({ field: f });
      const sub = await w.world.call('owner', 'POST', '/v1/subcategories', { payload: { category_id: w.category, name: `Forged ${f}`, [f]: value(f) } });
      expect(sub.statusCode, f).toBe(422);
    }
    const [c] = await w.world.sql.query<any[]>("SELECT COUNT(*) AS n FROM categories WHERE name LIKE 'Forged%'");
    const [s] = await w.world.sql.query<any[]>("SELECT COUNT(*) AS n FROM subcategories WHERE name LIKE 'Forged%'");
    expect([Number(c[0].n), Number(s[0].n)]).toEqual([0, 0]);
  });

  it('PATCH of a category or a subcategory with one of them: 422 too', async () => {
    const cat = body(await w.world.call('owner', 'POST', '/v1/categories', { payload: { name: 'Genuine', prefix: 'GEN' } })).row;
    for (const f of fieldsOf) {
      const res = await patch(w, 'owner', 'categories', cat.id, cat.updated_at, { [f]: value(f) });
      expect(res.statusCode, f).toBe(422);
    }
    expect((await dbRow(w, 'categories', cat.id)).updated_by).toBe(user('owner'));
  });
});

describe('T-D22 the person columns are null for an import (IM2)', () => {
  it('the import library writes designs, pieces and customers with no created_by and no updated_by, and the stamps it gives are its own', async () => {
    const result = await runImport(w.world.sql, {
      batch: `api13-${randomUUID()}`,
      source_file: 'stock.xlsx',
      cut_over: '2026-11-01',
      customers: [{ ref: 'row 2', name: 'Anita Sharma', mobile: '9876543210', customer_type: 'Retail' }],
      designs: [
        {
          design_no: 'IMP-1',
          name: 'Imported ring',
          category: 'ring',
          material: 'gold',
          purity: '22K',
          selling_method: 'by weight',
          pieces: [{ gross_weight: '5.500', customer_net_weight: '5.000', labour_retail: '120.00', labour_wholesale: '100.00' }],
        },
      ],
    } as any);
    expect(result.ok, JSON.stringify(result.rejected)).toBe(true);
    for (const table of ['designs', 'skus', 'customers']) {
      const [rows] = await w.world.sql.query<any[]>(`SELECT created_by, updated_by FROM \`${table}\` WHERE import_batch_id IS NOT NULL`);
      expect(rows.length, table).toBeGreaterThan(0);
      for (const r of rows) expect([r.created_by, r.updated_by], table).toEqual([null, null]);
    }
  });
});

describe('T-D22 created_at and updated_at come from the injected clock and move on every update (S6)', () => {
  it('an update stamps updated_at with a reading of the API clock, leaves created_at alone, and the stamp is not the database\'s own now', async () => {
    const d = await addDesign(w);
    w.time.time.micros += 3_600_000_000n; // an hour later than the fixtures
    const first = w.time.readings.length;
    const res = await patch(w, 'staff', 'designs', d, STAMP_WIRE, { notes: 'one' });
    expect(res.statusCode, res.body).toBe(200);
    const row = await dbRow(w, 'designs', d);
    const taken = w.time.readings.slice(first).map((r) => r.timestamp);
    expect(taken).toContain(row.updated_at);
    expect(row.updated_at >= formatTimestamp(w.time.time.micros)).toBe(true);
    expect(row.created_at).toBe(STAMP_DB);
    expect(body(res).row.updated_at).toBe(timestampToWire(row.updated_at));
  });

  it('two updates one after the other get two different, rising stamps, even when the clock\'s source stands still (a thousand readings in one microsecond never tie)', async () => {
    const d = await addDesign(w);
    const stamps: string[] = [STAMP_WIRE];
    for (let i = 0; i < 4; i++) {
      const res = await patch(w, i % 2 === 0 ? 'staff' : 'owner', 'designs', d, stamps[stamps.length - 1], { notes: `edit ${i}` });
      expect(res.statusCode, res.body).toBe(200);
      stamps.push(body(res).row.updated_at as string);
    }
    expect(new Set(stamps).size).toBe(stamps.length);
    expect([...stamps].sort()).toEqual(stamps);
  });

  it('an update that changes nothing writes nothing: the stamp does not move (it moves on every UPDATE, and a no-op is no update)', async () => {
    const d = await addDesign(w, { notes: 'same' });
    const res = await patch(w, 'staff', 'designs', d, STAMP_WIRE, { notes: 'same' });
    expect(res.statusCode, res.body).toBe(200);
    expect(body(res).row.updated_at).toBe(STAMP_WIRE);
    expect((await dbRow(w, 'designs', d)).updated_at).toBe(STAMP_DB);
  });

  it('an insert gives created_at and updated_at the one reading, and a later update moves only updated_at', async () => {
    const add = await w.world.call('owner', 'POST', '/v1/categories', { payload: { name: 'Stamped', prefix: 'STP' } });
    const made = body(add).row;
    expect(made.created_at).toBe(made.updated_at);
    w.time.time.micros += 60_000_000n;
    const res = await patch(w, 'owner', 'categories', made.id, made.updated_at, { name: 'Stamped again' });
    expect(res.statusCode, res.body).toBe(200);
    const row = body(res).row;
    expect(row.created_at).toBe(made.created_at);
    expect(row.updated_at > made.updated_at).toBe(true);
  });

  it('a client cannot move the clock: no header, query or body field names a time', async () => {
    const d = await addDesign(w);
    const res = await w.world.call('owner', 'PATCH', `/v1/designs/${d}?now=2001-01-01T00:00:00Z`, {
      headers: { date: 'Mon, 01 Jan 2001 00:00:00 GMT', 'x-jv-now': '2001-01-01T00:00:00Z' },
      payload: { expected_updated_at: STAMP_WIRE, changes: { notes: 'clock' } },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(body(res).row.updated_at).toMatch(/^2026-10-17T1\d:/);
  });
});

describe('T-D22 a hand edit of a row (S6, B5): the column default moves updated_at when the statement does not name it', () => {
  it('an UPDATE typed in the SQL tab that leaves updated_at out moves it (the polling sees the change)', async () => {
    const d = await addDesign(w);
    await w.world.sql.query("UPDATE designs SET notes = 'typed by hand' WHERE id = ?", [d]);
    const row = await dbRow(w, 'designs', d);
    expect(row.notes).toBe('typed by hand');
    expect(row.updated_at > STAMP_DB).toBe(true);
  });

  it('phpMyAdmin\'s own row editor sends every column back, updated_at with the value it had: the change is made and the stamp stays, so the polling never sees it (the runbook rule of B5)', async () => {
    const d = await addDesign(w);
    const before = await dbRow(w, 'designs', d);
    await w.world.sql.query('UPDATE designs SET design_no = ?, name = ?, notes = ?, created_at = ?, updated_at = ? WHERE id = ?', [before.design_no, before.name, 'row editor', before.created_at, before.updated_at, d]);
    const after = await dbRow(w, 'designs', d);
    expect(after.notes).toBe('row editor');
    expect(after.updated_at).toBe(before.updated_at); // the change is invisible to the polling
    // the rule of B5: fix a row in the SQL tab without naming updated_at, or end the fix with UPDATE ... SET updated_at = NOW(6)
    await w.world.sql.query('UPDATE designs SET updated_at = NOW(6) WHERE id = ?', [d]);
    expect((await dbRow(w, 'designs', d)).updated_at > before.updated_at).toBe(true);
  });

  it('an UPDATE that changes nothing keeps the stamp', async () => {
    const d = await addDesign(w, { notes: 'unchanged' });
    await w.world.sql.query("UPDATE designs SET notes = 'unchanged' WHERE id = ?", [d]);
    expect((await dbRow(w, 'designs', d)).updated_at).toBe(STAMP_DB);
  });

  it('an edit through the API after a hand edit is judged against the stamp the hand edit left (the stale check sees it)', async () => {
    const d = await addDesign(w);
    await w.world.sql.query("UPDATE designs SET notes = 'typed by hand' WHERE id = ?", [d]);
    const stale = await patch(w, 'staff', 'designs', d, STAMP_WIRE, { notes: 'screen' });
    expect(stale.statusCode).toBe(409);
    expect(detailsOf(stale).current.notes).toBe('typed by hand');
  });
});
