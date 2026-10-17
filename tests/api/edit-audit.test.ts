import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MATRIX } from '../../src/permissions/matrix';
import { buildApp } from '../../src/app';
import { type EditWorld, STAMP_WIRE, addDesign, addPiece, auditCount, auditRows, body, dbRow, editWorld, patch } from './edit-support';
import { testConfig } from './support';
import { dbError } from './tx-support';

// API13, the clauses of two tests that other tasks introduce:
//   T-D14  `audit_log` has a row, written in the same transaction, for each insert and update on the audited tables and for each service function and edit (rows counted and compared, on both mechanisms of
//          L1, (a) and (b)), none for an update of `updated_at` alone. This file: ordinary edits of designs, pieces, categories and subcategories; one insert and one update of each give ONE row.
//   T-D02  the rows of the ordinary edits of designs, pieces and categories are routes, and the generated test (tests/matrix.generated.test.ts) walks them for every caller.
//
// MECHANISMS. (a) is the generated triggers of db/optional/0910: they read the actor from the variables that withTx sets and clears (@jv_actor, @jv_role, @jv_request), so a row inserted or updated
// by the edit routes is audited with no line of code in the route. (b) is the Node writer of API15 (src/db/audit.ts, JV_AUDIT_MODE=node): it does not exist yet, and it may not run together with (a).
// The edit engine (src/edit/engine.ts) has ONE place where it writes the row's change, marked "L1 (b)", and the (b) column of this file is the todo below until API15 fills that place.

let w: EditWorld;
beforeAll(async () => {
  w = await editWorld('editaudit', { triggers: true });
}, 120_000);
afterAll(async () => {
  await w?.world.close();
});

/** A JSON column comes back from the driver parsed or as text. */
const asJson = (v: unknown): any => (typeof v === 'string' ? JSON.parse(v) : v);
const requestId = (res: LightMyRequestResponse) => String(res.headers['x-request-id']);

/** The rows of a table as JSON by id: the "changed rows" of T-D14 are counted by comparing two of these. */
async function rowsOf(table: string): Promise<Map<string, string>> {
  const [rows] = await w.world.sql.query<any[]>(`SELECT * FROM \`${table}\``);
  return new Map(rows.map((r) => [String(r.id), JSON.stringify(r)]));
}
function changedIds(before: Map<string, string>, after: Map<string, string>): string[] {
  return [...after].filter(([id, row]) => before.get(id) !== row).map(([id]) => id);
}
/** What an edit does to one table, counted both ways: the rows that differ afterwards, and the audit rows the request wrote (found by its request id, so nothing else can be counted). */
async function countFor(table: string, run: () => Promise<LightMyRequestResponse>) {
  const before = await rowsOf(table);
  const res = await run();
  const after = await rowsOf(table);
  const [audit] = await w.world.sql.query<any[]>('SELECT * FROM audit_log WHERE request_id = ? ORDER BY id', [requestId(res)]);
  return { res, changed: changedIds(before, after), audit: audit as any[] };
}

describe('T-D14 (API13 clause) mechanism (a), the generated triggers: one audit row for each changed row, in the same transaction', () => {
  it('a category: one insert and one update give exactly one audit row each, with the session user, the role and the old and new row', async () => {
    const insert = await countFor('categories', () => w.world.call('staff', 'POST', '/v1/categories', { payload: { name: 'Audit Ring', prefix: 'AUD' } }));
    expect(insert.res.statusCode, insert.res.body).toBe(201);
    expect(insert.changed).toHaveLength(1);
    expect(insert.audit).toHaveLength(1);
    const made = body(insert.res).row;
    expect(insert.audit[0]).toMatchObject({ table_name: 'categories', row_id: made.id, action: 'insert', actor: w.world.fixtures.staff.userId, actor_role: 'staff', old_row: null });
    expect(asJson(insert.audit[0].new_row)).toMatchObject({ id: made.id, name: 'Audit Ring', prefix: 'AUD', created_by: w.world.fixtures.staff.userId });

    const update = await countFor('categories', () => patch(w, 'owner', 'categories', made.id, made.updated_at, { name: 'Audit Ring 2', active: false }));
    expect(update.res.statusCode, update.res.body).toBe(200);
    expect(update.changed).toEqual([made.id]);
    expect(update.audit).toHaveLength(1); // two columns changed: still one row
    expect(update.audit[0]).toMatchObject({ table_name: 'categories', row_id: made.id, action: 'update', actor: w.world.fixtures.owner.userId, actor_role: 'owner' });
    expect(asJson(update.audit[0].old_row)).toMatchObject({ name: 'Audit Ring', active: 1 });
    expect(asJson(update.audit[0].new_row)).toMatchObject({ name: 'Audit Ring 2', active: 0, updated_by: w.world.fixtures.owner.userId });
  });

  it('a subcategory: one insert and one update give exactly one audit row each', async () => {
    const insert = await countFor('subcategories', () => w.world.call('owner', 'POST', '/v1/subcategories', { payload: { category_id: w.category, name: 'Audit Sub' } }));
    expect(insert.res.statusCode, insert.res.body).toBe(201);
    expect(insert.changed).toHaveLength(1);
    expect(insert.audit).toHaveLength(1);
    expect(insert.audit[0]).toMatchObject({ table_name: 'subcategories', action: 'insert', actor_role: 'owner' });
    const made = body(insert.res).row;
    const update = await countFor('subcategories', () => patch(w, 'owner', 'subcategories', made.id, made.updated_at, { name: 'Audit Sub 2' }));
    expect(update.res.statusCode, update.res.body).toBe(200);
    expect(update.changed).toEqual([made.id]);
    expect(update.audit).toHaveLength(1);
    expect(update.audit[0]).toMatchObject({ table_name: 'subcategories', row_id: made.id, action: 'update' });
  });

  it('a design: its insert (made here by SQL, as the import or X8 will) is one row, an edit by staff is one more, with staff as the actor; the pieces under it get none', async () => {
    const before = await auditCount(w);
    const d = await addDesign(w);
    const p = await addPiece(w, d);
    expect(await auditCount(w)).toBe(before + 2); // the design and the piece, role sql: the fixtures are typed by hand
    expect((await auditRows(w, 'designs', d)).map((r) => [r.action, r.actor_role])).toEqual([['insert', 'sql']]);

    const update = await countFor('designs', () => patch(w, 'staff', 'designs', d, STAMP_WIRE, { name: 'Audited', notes: 'two columns', tags: ['a', 'b'] }));
    expect(update.res.statusCode, update.res.body).toBe(200);
    expect(update.changed).toEqual([d]);
    expect(update.audit).toHaveLength(1);
    expect(update.audit[0]).toMatchObject({ table_name: 'designs', row_id: d, action: 'update', actor: w.world.fixtures.staff.userId, actor_role: 'staff' });
    expect(asJson(update.audit[0].new_row)).toMatchObject({ name: 'Audited', notes: 'two columns', tags: ['a', 'b'] });
    expect(await auditRows(w, 'skus', p)).toHaveLength(1); // the piece's own insert only
  });

  it('a piece: its insert is one row, an edit by staff is one more, and nothing else is audited', async () => {
    const d = await addDesign(w);
    const p = await addPiece(w, d);
    expect(await auditRows(w, 'skus', p)).toHaveLength(1);
    const update = await countFor('skus', () => patch(w, 'staff', 'skus', p, STAMP_WIRE, { location: 'Vault', labour_retail: '125.00' }));
    expect(update.res.statusCode, update.res.body).toBe(200);
    expect(update.changed).toEqual([p]);
    expect(update.audit).toHaveLength(1);
    expect(update.audit[0]).toMatchObject({ table_name: 'skus', row_id: p, action: 'update', actor_role: 'staff' });
    expect(asJson(update.audit[0].old_row)).toMatchObject({ location: null, labour_retail: '0.00' });
    expect(asJson(update.audit[0].new_row)).toMatchObject({ location: 'Vault' });
  });

  it('a refused, stale, unknown or no-change edit changes no row and writes no audit row (changed rows 0, audit rows 0)', async () => {
    const d = await addDesign(w, { notes: 'same' });
    const calls: [string, number, () => Promise<any>][] = [
      ['forbidden column', 403, () => patch(w, 'staff', 'designs', d, STAMP_WIRE, { material: 'Silver' })],
      ['unknown column', 422, () => patch(w, 'staff', 'designs', d, STAMP_WIRE, { colour: 'red' })],
      ['person column', 422, () => patch(w, 'staff', 'designs', d, STAMP_WIRE, { updated_by: w.world.fixtures.owner.userId })],
      ['stale stamp', 409, () => patch(w, 'staff', 'designs', d, '2026-09-30T00:00:00.000000Z', { notes: 'late' })],
      ['a rule (selling method with a piece)', 409, async () => {
        await addPiece(w, d);
        return patch(w, 'owner', 'designs', d, STAMP_WIRE, { selling_method: 'Per Piece' });
      }],
      ['nothing changes', 200, () => patch(w, 'staff', 'designs', d, STAMP_WIRE, { notes: 'same' })],
      ['a biller', 403, () => patch(w, 'biller', 'designs', d, STAMP_WIRE, { notes: 'x' })],
    ];
    for (const [what, status, run] of calls) {
      const { res, changed, audit } = await countFor('designs', run);
      expect(res.statusCode, `${what}: ${res.body.slice(0, 120)}`).toBe(status);
      expect([changed.length, audit.length], what).toEqual([0, 0]);
    }
    expect((await dbRow(w, 'designs', d)).updated_at).toBe('2026-10-01 08:30:15.123457');
  });

  it('a failed insert (a duplicate name) leaves no audit row either: the row and its audit row are one transaction', async () => {
    await w.world.call('owner', 'POST', '/v1/categories', { payload: { name: 'Once Only', prefix: 'ONCE' } });
    const before = await auditCount(w);
    const dup = await w.world.call('owner', 'POST', '/v1/categories', { payload: { name: 'once only', prefix: 'ONCE2' } });
    expect(dup.statusCode).toBe(422);
    expect(await auditCount(w)).toBe(before);
  });

  it('no audit row of these tables holds a hash or a token column (L1 exclude list)', async () => {
    const [rows] = await w.world.sql.query<any[]>("SELECT old_row, new_row FROM audit_log WHERE table_name IN ('designs', 'skus', 'categories', 'subcategories')");
    expect(rows.length).toBeGreaterThan(5);
    for (const r of rows) expect(`${r.old_row ?? ''}${r.new_row ?? ''}`).not.toMatch(/hash|token|password/i);
  });

  it('the change and its audit row are one transaction: when the COMMIT fails, the UPDATE has run and its audit row was written, and both are gone', async () => {
    const d = await addDesign(w);
    const auditBefore = await auditCount(w);
    const rowBefore = JSON.stringify(await dbRow(w, 'designs', d));
    const sentBefore = w.world.spy.sent.length;
    w.world.spy.intercept = async (e) => {
      if (e.sql === 'COMMIT') throw dbError(1205, 'ER_LOCK_WAIT_TIMEOUT', 'Lock wait timeout exceeded; try restarting transaction');
    };
    let res;
    try {
      res = await patch(w, 'staff', 'designs', d, STAMP_WIRE, { notes: 'never committed' });
    } finally {
      w.world.spy.intercept = null;
    }
    expect(res.statusCode).toBe(503);
    expect(w.world.spy.sqls().slice(sentBefore).some((q) => /^UPDATE `?designs`?\b/i.test(q))).toBe(true); // the change was made, in the transaction that failed
    expect(JSON.stringify(await dbRow(w, 'designs', d))).toBe(rowBefore);
    expect(await auditCount(w)).toBe(auditBefore);
  });
});

describe('T-D14 (API13 clause) mechanism (b), the Node writer of API15', () => {
  it.todo('the same counts hold when JV_AUDIT_MODE=node: API15 writes the audit row from the place marked "L1 (b)" in src/edit/engine.ts (one row for each changed row of designs, skus, categories and subcategories) and the triggers are not installed');
});

describe('T-D02 (API13 clause) the rows of the ordinary edits of designs, pieces and categories have routes', () => {
  it('each of the six edit rows of this task has a route registered through route(), and the generated test walks it', async () => {
    const app = buildApp({ config: testConfig({ logLevel: 'silent' }) });
    await app.ready();
    const routed = new Set(app.routeTable.map((r) => r.action));
    await app.close();
    for (const action of ['edit:designs.update', 'edit:skus.update', 'edit:categories.insert', 'edit:categories.update', 'edit:subcategories.insert', 'edit:subcategories.update'] as const) {
      expect(routed.has(action), action).toBe(true);
      expect(MATRIX[action].kind).toBe('edit');
    }
  });
});
