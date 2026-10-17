import { randomUUID } from 'node:crypto';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MATRIX } from '../../src/permissions/matrix';
import type { CallerName } from './cells';
import { TODAY, addRate, allRows, patchRate, postRate, putSetting, rateBody } from './edit-13b-support';
import { type EditWorld, STAMP_WIRE, addDesign, addPiece, codeOf, dbRow, editWorld, patch, snapshot } from './edit-support';
import { getPage, poll } from './sync-support';

// API13b, the walls between the roles (A4, A5, A8, U3):
//   T-D04  a biller cannot read `sku_private` or `audit_log` and cannot change stock, settings or users; staff cannot change a design's material, purity or selling method. (A biller's `daily_totals`
//          range, today and yesterday only, is the clause of API12: tests/api/derived-reads.test.ts.)
//   T-D05  only the owner writes settings and users.
// The generated test of T-D02 walks every row of the matrix for every caller; these are the sentences of the two tests as they are written in the spec, with real rows, so that a wall that
// holds in the matrix and fails in the handler (a row changed anyway) is seen.

let w: EditWorld;
let design: string;
let piece: string;
beforeAll(async () => {
  w = await editWorld('editroles');
  design = await addDesign(w);
  piece = await addPiece(w, design);
}, 120_000);
afterAll(async () => {
  await w?.world.close();
});

const user = (caller: CallerName) => w.world.fixtures[caller as 'owner'].userId;

describe('T-D04 a biller cannot read sku_private or audit_log, and neither can staff (A4, D9)', () => {
  it.each(['biller', 'staff'] as const)('%s: the sync read of sku-private, the audit log and the nightly check are 403 JV_FORBIDDEN', async (caller) => {
    for (const url of ['/v1/sync/sku-private', '/v1/audit-log', '/v1/health/checks', '/v1/dashboard/health']) {
      const res = await w.world.call(caller, 'GET', url);
      expect([url, res.statusCode, codeOf(res)]).toEqual([url, 403, 'JV_FORBIDDEN']);
    }
  });

  it.each(['biller', 'staff'] as const)('%s: a poll that names sku-private is refused as a whole, before any page is read', async (caller) => {
    const res = await poll(w.world, caller, { cursors: { designs: null, 'sku-private': null } });
    expect(res.statusCode).toBe(403);
    expect(codeOf(res)).toBe('JV_FORBIDDEN');
  });

  it('the owner reads them (the control: the walls above are not a broken route)', async () => {
    expect((await getPage(w.world, 'owner', 'sku-private')).statusCode).toBe(200);
    expect((await w.world.call('owner', 'GET', '/v1/audit-log?limit=5')).statusCode).toBe(200);
  });
});

describe('T-D04 a biller cannot change stock, settings or users: every edit row a biller is not on is 403, and the row it names stays as it was', () => {
  it('stock: a design, a piece, a category, a subcategory (PATCH and POST)', async () => {
    const designBefore = await snapshot(w, 'designs', design);
    const pieceBefore = await snapshot(w, 'skus', piece);
    const checks: [string, Promise<LightMyRequestResponse>][] = [
      ['PATCH designs', patch(w, 'biller', 'designs', design, STAMP_WIRE, { name: 'Changed by a biller' })],
      ['PATCH skus', patch(w, 'biller', 'skus', piece, STAMP_WIRE, { location: 'Changed by a biller' })],
      ['PATCH categories', patch(w, 'biller', 'categories', w.category, STAMP_WIRE, { name: 'Changed by a biller' })],
      ['PATCH subcategories', patch(w, 'biller', 'subcategories', w.subcategory, STAMP_WIRE, { name: 'Changed by a biller' })],
      ['POST categories', w.world.call('biller', 'POST', '/v1/categories', { payload: { name: 'Biller Category', prefix: 'BIL' } })],
      ['POST subcategories', w.world.call('biller', 'POST', '/v1/subcategories', { payload: { category_id: w.category, name: 'Biller Sub' } })],
    ];
    for (const [what, call] of checks) {
      const res = await call;
      expect([what, res.statusCode, codeOf(res)]).toEqual([what, 403, 'JV_FORBIDDEN']);
    }
    expect(await snapshot(w, 'designs', design)).toBe(designBefore);
    expect(await snapshot(w, 'skus', piece)).toBe(pieceBefore);
    const [cats] = await w.world.sql.query<any[]>("SELECT COUNT(*) AS n FROM categories WHERE name = 'Biller Category'");
    expect(Number(cats[0].n)).toBe(0);
  });

  it('every row of the matrix that is an edit of a table other than customers and daily rates, and that has a route, refuses a biller: none is open to one by mistake', async () => {
    const routed = new Set(w.world.app.routeTable.map((r) => r.action));
    const stockOrSettings = Object.entries(MATRIX).filter(([action, row]) => row.kind === 'edit' && /^edit:(settings|categories|subcategories|designs|skus|sku_private)\./.test(action));
    expect(stockOrSettings.length).toBe(8); // settings (1), categories (2), subcategories (2), designs, skus, sku_private
    for (const [action, row] of stockOrSettings) {
      expect(row.roles as readonly string[], action).not.toContain('biller');
      if (!routed.has(action as never)) continue;
      const url = row.path.replace(/:([a-z_]+)/g, (_m, name: string) => (name === 'key' ? 'numbering' : randomUUID()));
      const res = await w.world.call('biller', row.method, url, { payload: row.method === 'PATCH' ? { expected_updated_at: STAMP_WIRE, changes: { name: 'x' } } : {} });
      expect([action, res.statusCode]).toEqual([action, 403]);
    }
  });

  it('settings: a biller\'s PUT is 403 and the value stays', async () => {
    const before = await allRows(w, 'settings');
    const res = await putSetting(w, 'biller', 'estimate', { value: { prefix: 'ZZ', roundOff: false } });
    expect([res.statusCode, codeOf(res)]).toEqual([403, 'JV_FORBIDDEN']);
    expect(await allRows(w, 'settings')).toBe(before);
  });
});

describe('T-D04 staff cannot change a design\'s material, purity or selling method (A5)', () => {
  it.each([
    ['material', 'Silver'],
    ['purity', '18K'],
    ['selling_method', 'Per Piece'],
  ])('staff sending %s is 403 JV_FORBIDDEN and the design is untouched; the owner may', async (field, value) => {
    const d = await addDesign(w);
    const before = await snapshot(w, 'designs', d);
    const res = await patch(w, 'staff', 'designs', d, STAMP_WIRE, { [field]: value });
    expect([res.statusCode, codeOf(res)]).toEqual([403, 'JV_FORBIDDEN']);
    expect(await snapshot(w, 'designs', d)).toBe(before);
    const owner = await patch(w, 'owner', 'designs', d, STAMP_WIRE, { [field]: value });
    expect(owner.statusCode, owner.body).toBe(200);
    expect((await dbRow(w, 'designs', d))[field]).toBe(value);
  });
});

describe('T-D05 only the owner writes settings and users (A4, A8, U3)', () => {
  it('settings: the owner\'s PUT works, a biller\'s and staff\'s are 403, an anonymous call is 401', async () => {
    const before = await allRows(w, 'settings');
    const ok = await putSetting(w, 'owner', 'locations', { value: ['Main Showroom', 'Vault'] });
    expect(ok.statusCode, ok.body).toBe(200);
    const after = await allRows(w, 'settings');
    for (const caller of ['biller', 'staff'] as const) {
      const res = await putSetting(w, caller, 'locations', { value: ['Hacked'] });
      expect([caller, res.statusCode, codeOf(res)]).toEqual([caller, 403, 'JV_FORBIDDEN']);
    }
    const anon = await putSetting(w, 'anon', 'locations', { value: ['Hacked'] });
    expect(anon.statusCode).toBe(401);
    expect(await allRows(w, 'settings')).toBe(after);
    expect(after).not.toBe(before);
  });

  it('users: there is no route that writes one for anybody, the owner included (404), and the rows stay as they were: roles and the active flag change only through the admin door (D1, A8, U3)', async () => {
    const before = await allRows(w, 'users');
    const id = w.world.fixtures.biller.userId;
    const attempts: [string, string, unknown][] = [
      ['PATCH', `/v1/users/${id}`, { expected_updated_at: STAMP_WIRE, changes: { role: 'owner' } }],
      ['PUT', `/v1/users/${id}`, { role: 'owner' }],
      ['POST', '/v1/users', { email: 'new@example.test', full_name: 'New', role: 'owner' }],
      ['POST', `/v1/users/${id}/role`, { role: 'owner' }],
      ['POST', `/v1/users/${id}/deactivate`, {}],
      ['POST', `/v1/users/${id}/reset-password`, {}],
      ['DELETE', `/v1/users/${id}`, undefined],
    ];
    for (const caller of ['owner', 'biller', 'staff'] as const) {
      for (const [method, url, payload] of attempts) {
        const res = await w.world.call(caller, method, url, { payload });
        expect([caller, method, url, res.statusCode, codeOf(res)]).toEqual([caller, method, url, 404, 'JV_NOT_FOUND']);
      }
    }
    expect(await allRows(w, 'users')).toBe(before);
    expect(user('biller')).toBe(id);
  });

  it('daily rates: the owner and a biller add (a biller for today), staff cannot add or correct, a biller cannot correct (the control for the rate rules, tests/api/edit-rates.test.ts)', async () => {
    expect((await postRate(w, 'owner', rateBody({ purity: 'R1' }))).statusCode).toBe(201);
    expect((await postRate(w, 'biller', rateBody({ purity: 'R2' }))).statusCode).toBe(201);
    expect((await postRate(w, 'staff', rateBody({ purity: 'R3' }))).statusCode).toBe(403);
    const id = await addRate(w, { purity: 'R4', rate_date: TODAY });
    expect((await patchRate(w, 'biller', id, STAMP_WIRE, { rate_per_gram: '1.00' })).statusCode).toBe(403);
    expect((await patchRate(w, 'staff', id, STAMP_WIRE, { rate_per_gram: '1.00' })).statusCode).toBe(403);
    expect((await patchRate(w, 'owner', id, STAMP_WIRE, { rate_per_gram: '1.00' })).statusCode).toBe(200);
  });
});
