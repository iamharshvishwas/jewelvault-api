import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { type Action, MATRIX, PUBLIC_ROUTES, type PublicName, READ_COLUMNS, ROLES, WRITE_COLUMNS } from '../src/permissions/matrix';
import { CALLERS, type World, checkCell, checkPublicCell, checkReadColumns, checkWriteColumns, makeWorld, registerStubs } from './api/cells';
import { testConfig } from './api/support';

// T-D02 (A1, A4): THE GENERATED TEST. It walks every row of the permission matrix for every caller of A4 (no session, an ended session, an expired one, an idle one, a user who is not active,
// a user who must still change the password, staff, biller, owner) and fails on any cell that differs from the matrix. The rows are read from src/permissions/matrix.ts, so a row that a
// later task adds is walked at once, and a route that a later task registers is covered the moment it exists: nothing here names a route. Two walks:
//
//   1. the REAL application: every row that has a route registered through route() is walked against that route (the columns too: a read names only the columns of READ_COLUMNS, an edit
//      refuses a column outside WRITE_COLUMNS with 403 JV_FORBIDDEN and an unknown one with 422). A row without a route yet is a `todo` below, with its address, until its task builds it.
//   2. the WRAPPER against EVERY row: a stub handler is registered through the same route() for each row and each public route, and the whole matrix is walked, so the wrapper is proved for
//      all of the rows before their handlers exist (and stays proved when they do: the stubs run on an app of their own).
//
// tests/api/cells.test.ts shows that a wrong cell makes the same checks fail (the negative control).

const rows = Object.entries(MATRIX) as [Action, (typeof MATRIX)[Action]][];

// which rows already have a route: a catalogue app without a database is enough, the routes are registered when the app is built
const catalog = buildApp({ config: testConfig({ logLevel: 'silent' }) });
await catalog.ready();
const routedActions = new Set(catalog.routeTable.map((r) => r.action).filter(Boolean));
const routedPublic = new Set(catalog.routeTable.filter((r) => r.kind === 'public').map((r) => r.name));
await catalog.close();

const cellRoute = (action: Action) => ({ action, method: MATRIX[action].method, path: MATRIX[action].path, roles: MATRIX[action].roles, mustChange: MATRIX[action].mustChange });

describe('T-D02 the real routes: every registered route, every caller', () => {
  let world: World;
  beforeAll(async () => {
    world = await makeWorld({ label: 'cellsreal', routes: true });
  }, 120_000);
  afterAll(async () => {
    await world?.close();
  });

  for (const [action, row] of rows) {
    if (!routedActions.has(action)) {
      it.todo(`${action}: ${row.method} ${row.path} has no route yet`);
      continue;
    }
    describe(`${action} ${row.method} ${row.path} [${row.roles.join(',')}]`, () => {
      for (const caller of CALLERS) {
        it(`${caller}`, async () => {
          expect(await checkCell(world, cellRoute(action), caller)).toBeNull();
        });
      }
      if ('reads' in row && row.reads) {
        for (const resource of row.reads) {
          for (const role of ROLES) {
            const allowed = READ_COLUMNS[resource][role];
            if (!row.roles.includes(role) || !allowed) continue;
            it(`READ_COLUMNS ${resource} for ${role}: the rows hold no other column`, async () => {
              expect(await checkReadColumns(world, cellRoute(action), role, allowed)).toBeNull();
            });
          }
        }
      }
      if ('edit' in row && row.edit) {
        const edit = row.edit;
        for (const role of ROLES) {
          if (!row.roles.includes(role)) continue;
          it(`WRITE_COLUMNS for ${role}: an allowed column works, a forbidden one is 403 JV_FORBIDDEN, an unknown one 422`, async () => {
            const allowed = WRITE_COLUMNS[action as keyof typeof WRITE_COLUMNS][role] ?? [];
            const everyone = new Set(ROLES.flatMap((r) => WRITE_COLUMNS[action as keyof typeof WRITE_COLUMNS][r] ?? []));
            const forbidden = [...everyone].filter((c) => !allowed.includes(c));
            expect(await checkWriteColumns(world, { ...cellRoute(action), shape: edit.shape }, role, { allowed, forbidden })).toEqual([]);
          });
        }
      }
    });
  }

  for (const [name, p] of Object.entries(PUBLIC_ROUTES) as [PublicName, (typeof PUBLIC_ROUTES)[PublicName]][]) {
    if (!routedPublic.has(name)) {
      it.todo(`public ${name}: ${p.method} ${p.path} has no route yet`);
      continue;
    }
    describe(`public ${name} ${p.method} ${p.path}`, () => {
      for (const caller of CALLERS) {
        it(`${caller} is let in`, async () => {
          expect(await checkPublicCell(world, p, caller)).toBeNull();
        });
      }
    });
  }
});

describe('T-D02 the wrapper against every row of the matrix (an app of its own, with a stub handler behind each row, whatever the application has built)', () => {
  let world: World;
  beforeAll(async () => {
    world = await makeWorld({ label: 'cellsstub', build: (app, w) => registerStubs(app, w.handled) });
  }, 120_000);
  afterAll(async () => {
    await world?.close();
  });

  it('has a stub for every row and every public route', () => {
    const actions = new Set(world.app.routeTable.map((r) => r.action));
    for (const [action] of rows) expect(actions.has(action), action).toBe(true);
    for (const name of Object.keys(PUBLIC_ROUTES)) expect(world.app.routeTable.some((r) => r.kind === 'public' && r.name === name), name).toBe(true);
  });

  for (const [action, row] of rows) {
    describe(`${action} ${row.method} ${row.path} [${row.roles.join(',')}]`, () => {
      for (const caller of CALLERS) {
        it(`${caller}`, async () => {
          expect(await checkCell(world, cellRoute(action), caller)).toBeNull();
        });
      }
    });
  }

  for (const [name, p] of Object.entries(PUBLIC_ROUTES) as [PublicName, (typeof PUBLIC_ROUTES)[PublicName]][]) {
    describe(`public ${name} ${p.method} ${p.path}`, () => {
      for (const caller of CALLERS) {
        it(`${caller} is let in`, async () => {
          expect(await checkPublicCell(world, p, caller)).toBeNull();
        });
      }
    });
  }
});
