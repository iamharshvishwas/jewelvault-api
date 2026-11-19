import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { JvError } from '../../src/errors';
import { type Access, MATRIX, READ_COLUMNS, WRITE_COLUMNS, writeColumnsFor } from '../../src/permissions/matrix';
import { route } from '../../src/permissions/route';
import { InvalidInputError, strictObject, timestamp } from '../../src/wire/zod';
import { type BuiltinRole, builtinGrants } from './builtin-roles';
import { CALLERS, type CellRoute, type World, checkCell, checkPublicCell, checkReadColumns, checkWriteColumns, expectedFor, makeWorld, registerStubs } from './cells';

// T-D02, the negative control: the generated test is only worth something if it FAILS on a cell that differs from the matrix. These tests give the same checks a wrong expectation (a mutated copy of
// a row), a route that behaves wrongly, and a read or an edit that gets its columns wrong, and show that each is reported. The right ones are checked beside them.

const rowOf = (action: keyof typeof MATRIX, patch: Partial<Pick<CellRoute, 'access' | 'mustChange'>> = {}): CellRoute => ({ action, method: MATRIX[action].method, path: MATRIX[action].path, access: MATRIX[action].access, mustChange: MATRIX[action].mustChange, ...patch });

let world: World;
/** Every field some tick lets a caller send on the customer edit. */
const CUSTOMER_FIELDS = new Set(Object.values(WRITE_COLUMNS['edit:customers.update']).flatMap((l) => l ?? []));
/** The body of a PATCH with the stale check (A5, NODE-DESIGN 4.4). */
const patchBody = strictObject({ expected_updated_at: timestamp, changes: z.record(z.string(), z.unknown()) });

beforeAll(async () => {
  world = await makeWorld({
    label: 'cellsctl',
    build: (app, w) => {
      // a read that answers only the listed columns, and one that lets a hidden column through
      route(app, { action: 'read:customers', handler: async () => ({ rows: [Object.fromEntries(READ_COLUMNS.customers.map((c) => [c, null]))] }) });
      route(app, { action: 'read:bills', handler: async () => ({ rows: [{ ...Object.fromEntries(READ_COLUMNS.bills.map((c) => [c, null])), request_id: 'leaked', original_net_weight: '1.000' }] }) });
      // an edit that does what A5 says: a column on one of the caller's lists works, one on a list of a tick the caller lacks is JV_FORBIDDEN, an unknown one is JV_INVALID_INPUT
      route(app, {
        action: 'edit:customers.update',
        body: patchBody,
        handler: async ({ body, auth }) => {
          const changes = body.changes;
          const own = writeColumnsFor('edit:customers.update', auth.user.grants);
          for (const key of Object.keys(changes)) {
            if (own.includes(key)) continue;
            if (CUSTOMER_FIELDS.has(key)) throw new JvError('JV_FORBIDDEN', 'That field cannot be changed by this role.');
            throw new InvalidInputError(key, 'is not a field this call accepts');
          }
          return { ok: true };
        },
      });
      // an edit that silently ignores whatever it does not know or may not change
      route(app, { action: 'edit:designs.update', body: patchBody, handler: async () => ({ ok: true }) });
      registerStubs(app, w.handled);
    },
  });
}, 120_000);
afterAll(async () => {
  await world?.close();
});

describe('T-D02 the expectation of a cell', () => {
  it('follows the order of work: no session and a dead session are 401 (the code says which), the must-change gate precedes the matrix, then the matrix row decides', () => {
    // a tick only the owner holds of the three built-in roles
    const ownerOnly = { access: { anyOf: ['payment_void'] } as Access, mustChange: false };
    expect(expectedFor(ownerOnly, 'anon')).toEqual({ kind: 'unauthorized', code: 'JV_UNAUTHENTICATED' });
    expect(expectedFor(ownerOnly, 'ended')).toEqual({ kind: 'unauthorized', code: 'JV_UNAUTHENTICATED' });
    expect(expectedFor(ownerOnly, 'inactive')).toEqual({ kind: 'unauthorized', code: 'JV_UNAUTHENTICATED' });
    expect(expectedFor(ownerOnly, 'expired')).toEqual({ kind: 'unauthorized', code: 'JV_SESSION_EXPIRED' });
    expect(expectedFor(ownerOnly, 'idle')).toEqual({ kind: 'unauthorized', code: 'JV_SESSION_EXPIRED' });
    expect(expectedFor(ownerOnly, 'must_change')).toEqual({ kind: 'password_change' });
    expect(expectedFor(ownerOnly, 'owner')).toEqual({ kind: 'allowed' });
    expect(expectedFor(ownerOnly, 'biller')).toEqual({ kind: 'forbidden' });
    expect(expectedFor({ access: { open: true }, mustChange: true }, 'must_change')).toEqual({ kind: 'allowed' });
    expect(expectedFor({ access: { anyOf: ['payment_void'] }, mustChange: true }, 'must_change')).toEqual({ kind: 'forbidden' });
    // a Super Admin row is no built-in role's, the owner's included
    expect(expectedFor({ access: { superAdmin: true }, mustChange: false }, 'owner')).toEqual({ kind: 'forbidden' });
  });
});

describe('T-D02 the cells agree with the matrix for a route that the wrapper guards, and fail when the expectation is wrong (control)', () => {
  it('every caller agrees with the owner-only row void_receipt, the biller-and-owner row create_bill and the open row me', async () => {
    for (const action of ['fn:void_receipt', 'fn:create_bill', 'session:me', 'fn:create_design'] as const) {
      for (const caller of CALLERS) expect(await checkCell(world, rowOf(action), caller), `${action} ${caller}`).toBeNull();
    }
  });

  it('a row that lets the biller in where the route lets only the owner: the biller cell fails (403 where the matrix said allowed)', async () => {
    const wrong = rowOf('fn:void_receipt', { access: { anyOf: ['payment_void', 'bill_make'] } });
    expect(await checkCell(world, wrong, 'biller')).toMatch(/403 JV_FORBIDDEN, the matrix lets biller in/);
    expect(await checkCell(world, wrong, 'owner')).toBeNull();
  });

  it('a row that leaves the owner out where the route lets her in: the owner cell fails (200 where the matrix said 403)', async () => {
    // the owner holds every tick, so only a Super Admin row leaves her out
    const wrong = rowOf('fn:create_bill', { access: { superAdmin: true } });
    expect(await checkCell(world, wrong, 'owner')).toMatch(/status 200, the matrix says 403/);
  });

  it('a row that says a user who must change the password may call it, where the gate stops them: the must_change cell fails', async () => {
    const wrong = rowOf('fn:create_design', { mustChange: true });
    expect(await checkCell(world, wrong, 'must_change')).toMatch(/403 JV_PASSWORD_CHANGE_REQUIRED, the matrix lets must_change in/);
    // and the other way round: a row open to that user that the matrix thinks is closed
    expect(await checkCell(world, rowOf('session:me', { mustChange: false }), 'must_change')).toMatch(/status 200, the matrix says 403/);
  });

  it('a route that answers a caller with no session (public where the matrix says session): the 401 cells fail, one for each way of having no session', async () => {
    const open: CellRoute = { action: 'fn:open_door', method: 'POST', path: '/v1/auth/login', access: { anyOf: ['payment_void'] }, mustChange: false };
    for (const caller of ['anon', 'ended', 'expired', 'idle', 'inactive'] as const) expect(await checkCell(world, open, caller), caller).toMatch(/the matrix says 401/);
  });

  it('a public cell fails when a dead cookie is refused on a route that is called public', async () => {
    expect(await checkPublicCell(world, { method: 'GET', path: '/healthz' }, 'ended')).toBeNull();
    expect(await checkPublicCell(world, { method: 'GET', path: '/v1/auth/me' }, 'anon')).toMatch(/a public route answers everyone/);
  });
});

describe('T-D02 the column cells: READ_COLUMNS', () => {
  it('a read that answers only the listed columns passes for each role that may read', async () => {
    for (const role of ['owner', 'biller'] as const) expect(await checkReadColumns(world, rowOf('read:customers'), role, READ_COLUMNS.customers)).toBeNull();
  });

  it('a read that lets a column through that is not on the list (a request id, the owner-only weight) is found, and the column is named', async () => {
    const found = await checkReadColumns(world, rowOf('read:bills'), 'biller', READ_COLUMNS.bills);
    expect(found).toMatch(/columns outside READ_COLUMNS: .*request_id/);
    expect(found).toMatch(/original_net_weight/);
  });
});

describe('T-D02 the column cells: WRITE_COLUMNS', () => {
  const columnsFor = (action: 'edit:customers.update', role: BuiltinRole) => ({ allowed: writeColumnsFor(action, builtinGrants(role)), forbidden: [...CUSTOMER_FIELDS].filter((c) => !writeColumnsFor(action, builtinGrants(role)).includes(c)) });

  it('an edit that does what A5 says passes: the allowed columns work, archived_at is 403 JV_FORBIDDEN for a biller, an unknown column is 422', async () => {
    const cols = columnsFor('edit:customers.update', 'biller');
    expect(cols.forbidden).toEqual(['archived_at']);
    expect(await checkWriteColumns(world, { ...rowOf('edit:customers.update'), shape: 'changes' }, 'biller', cols)).toEqual([]);
    expect(await checkWriteColumns(world, { ...rowOf('edit:customers.update'), shape: 'changes' }, 'owner', columnsFor('edit:customers.update', 'owner'))).toEqual([]);
  });

  it('an edit that silently ignores what it may not change is found: the forbidden column and the unknown column both get a 200', async () => {
    const found = await checkWriteColumns(world, { ...rowOf('edit:designs.update'), shape: 'changes' }, 'staff', { allowed: ['name'], forbidden: ['material'] });
    expect(found).toHaveLength(2);
    expect(found[0]).toMatch(/material is not on the list and the answer was 200/);
    expect(found[1]).toMatch(/unknown column was answered 200/);
  });

  it('a list that is too narrow for the route is found too: a column on the list that the route refuses', async () => {
    const found = await checkWriteColumns(world, { ...rowOf('edit:customers.update'), shape: 'changes' }, 'biller', { allowed: ['name', 'archived_at'], forbidden: [] });
    expect(found.some((f) => /the column archived_at is on the list and was refused/.test(f))).toBe(true);
  });
});
