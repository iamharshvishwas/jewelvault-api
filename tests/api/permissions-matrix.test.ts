import type { Connection } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadQueries } from '../../scripts/queries.mjs';
import { TEN_BOXES, parseGrants } from '../../src/preflight';
import {
  FIELD_RIGHTS,
  HIDDEN_COLUMNS,
  INTERNAL_TABLES,
  MATRIX,
  PUBLIC_ROUTES,
  READ_COLUMNS,
  READ_RESOURCES,
  STAFF_SETTING_KEYS,
  TOKEN_DOORS,
  WRITE_COLUMNS,
  mayCall,
  mayUseField,
  readColumnsFor,
  readableSettingKeys,
  writeColumnsFor,
  type Action,
  type EditAction,
} from '../../src/permissions/matrix';
import { NO_GRANTS } from '../../src/permissions/grants';
import { type Scratch, laneDbSettings, laneRoot, scratchDatabase } from '../helpers';
import { BUILTIN_ROLES, type BuiltinRole, builtinGrants } from './builtin-roles';

// T-D01 (the catalogue clause) and T-D02 (the data half): the matrix file against the spec's own tables, typed in below from A4, section 10 and P3 as an independent oracle, so that a cell
// edited by mistake fails here before any route exists; the field allow-lists against the migrated schema; and the rights of the database user. The rows list ticks now, not roles: the oracle
// stays the spec's roles, and each built-in role is asked through its built-in tick set (P1), so this file still says what A4 says about the three roles of today.

const O: BuiltinRole[] = ['owner'];
const OB: BuiltinRole[] = ['owner', 'biller'];
const OS: BuiltinRole[] = ['owner', 'staff'];
const OBS: BuiltinRole[] = ['owner', 'biller', 'staff'];

/** The built-in roles that may call a row, in the order of the catalogue (BUILTIN_ROLES). */
const rolesOf = (action: Action): BuiltinRole[] => BUILTIN_ROLES.filter((role) => mayCall(builtinGrants(role), action));

/** Spec A4 (the table), section 10 (X1 to X12 with their routes), P2 and P3 (the photo calls), B3 (the download record), C3 and C4 (the named reads) and NODE-DESIGN 3.3 / 4.2 / 4.4 (the paths of the rest). */
const ORACLE: Record<string, readonly [BuiltinRole[], string]> = {
  'read:users': [OBS, 'GET /v1/sync/users'],
  'read:settings': [OBS, 'GET /v1/sync/settings'],
  'read:daily_rates': [OBS, 'GET /v1/sync/daily-rates'],
  'read:categories': [OBS, 'GET /v1/sync/categories'],
  'read:subcategories': [OBS, 'GET /v1/sync/subcategories'],
  'read:designs': [OBS, 'GET /v1/sync/designs'],
  'read:skus': [OBS, 'GET /v1/sync/skus'],
  'read:sku_private': [O, 'GET /v1/sync/sku-private'],
  'read:customers': [OB, 'GET /v1/sync/customers'],
  'read:bills': [OB, 'GET /v1/sync/bills'],
  'read:bill_items': [OB, 'GET /v1/sync/bill-items'],
  'read:receipts': [OB, 'GET /v1/sync/receipts'],
  'read:receipt_allocations': [OB, 'GET /v1/sync/receipt-allocations'],
  'read:bill_summary': [OB, 'GET /v1/sync/bill-summary'],
  'read:customer_balances': [OB, 'GET /v1/sync/customer-balances'],
  'read:customer_ledger': [OB, 'GET /v1/customers/:id/ledger'],
  'read:daily_totals': [OB, 'GET /v1/daily-totals'],
  'read:audit_log': [O, 'GET /v1/audit-log'],
  'read:health_checks': [O, 'GET /v1/health/checks'],
  'read:dashboard_health': [O, 'GET /v1/dashboard/health'],
  'read:poll': [OBS, 'POST /v1/sync/poll'],
  'edit:settings.update': [O, 'PUT /v1/settings/:key'],
  'edit:daily_rates.insert': [OB, 'POST /v1/daily-rates'],
  'edit:daily_rates.update': [O, 'PATCH /v1/daily-rates/:id'],
  'edit:categories.insert': [OS, 'POST /v1/categories'],
  'edit:categories.update': [O, 'PATCH /v1/categories/:id'],
  'edit:subcategories.insert': [OS, 'POST /v1/subcategories'],
  'edit:subcategories.update': [O, 'PATCH /v1/subcategories/:id'],
  'edit:designs.update': [OS, 'PATCH /v1/designs/:id'],
  'edit:skus.update': [OS, 'PATCH /v1/skus/:id'],
  'edit:sku_private.update': [O, 'PUT /v1/sku-private/:sku_id'],
  'edit:customers.update': [OB, 'PATCH /v1/customers/:id'],
  'fn:create_bill': [OB, 'POST /v1/bills'],
  'fn:record_payment': [OB, 'POST /v1/customers/:id/payments'],
  'fn:settle_fine': [OB, 'POST /v1/customers/:id/fine-settlements'],
  'fn:void_receipt': [O, 'POST /v1/receipts/:id/void'],
  'fn:cancel_bill': [O, 'POST /v1/bills/:id/cancel'],
  'fn:create_customer': [OB, 'POST /v1/customers'],
  'fn:quote_bill': [OB, 'POST /v1/bills/quote'],
  'fn:create_design': [OS, 'POST /v1/designs'],
  'fn:set_sku_status': [OS, 'POST /v1/skus/status'],
  'fn:reissue_bill': [O, 'POST /v1/bills/:id/reissue'],
  'fn:issue_refund': [O, 'POST /v1/customers/:id/refunds'],
  'fn:add_opening_balance': [O, 'POST /v1/customers/:id/opening-balance'],
  'photo:upload': [OS, 'PUT /v1/designs/:design_id/photos/:photo_id'],
  'photo:remove': [O, 'POST /v1/photos/:photo_id/remove'],
  'owner:download_record': [O, 'POST /v1/owner/download-record'],
  'session:me': [OBS, 'GET /v1/auth/me'],
  'session:logout': [OBS, 'POST /v1/auth/logout'],
  'session:change-password': [OBS, 'POST /v1/auth/change-password'],
  'session:activity': [OBS, 'POST /v1/auth/activity'],
  // FB-E1 (FB-D8, the feedback plan's Lane E): the Order Book. The owner and a biller create and edit, staff read; photos as for a design, by those who edit
  'read:orders': [OBS, 'GET /v1/sync/orders'],
  'edit:orders.update': [OB, 'PATCH /v1/orders/:id'],
  'fn:create_order': [OB, 'POST /v1/orders'],
  'photo:upload_order': [OB, 'PUT /v1/orders/:order_id/photos/:photo_id'],
  // The access plan, Task 12 (DESIGN.md 6.3): the Super Admin's own API, People & Roles. NONE of the three built-in roles may call one of the twelve: the Owner holds every tick and is refused too, because the rows
  // ask the Super Admin flag alone (R8). Who passes, and who is refused with what, is walked in tests/api/super-escalation.test.ts (P5).
  'super:ticks': [[], 'GET /v1/super/ticks'],
  'super:people.list': [[], 'GET /v1/super/people'],
  'super:people.add': [[], 'POST /v1/super/people'],
  'super:people.edit': [[], 'PATCH /v1/super/people/:id'],
  'super:people.role': [[], 'POST /v1/super/people/:id/role'],
  'super:people.active': [[], 'POST /v1/super/people/:id/active'],
  'super:people.reset': [[], 'POST /v1/super/people/:id/reset-password'],
  'super:roles.list': [[], 'GET /v1/super/roles'],
  'super:roles.create': [[], 'POST /v1/super/roles'],
  'super:roles.edit': [[], 'PATCH /v1/super/roles/:key'],
  'super:roles.ticks': [[], 'PUT /v1/super/roles/:key/ticks'],
  'super:roles.active': [[], 'POST /v1/super/roles/:key/active'],
};

describe('T-D02 the matrix file says what A4 and section 10 say', () => {
  it('has exactly the rows of the spec, with their roles and their routes (a row added or taken away is a conscious change of this list)', () => {
    expect(Object.keys(MATRIX).sort()).toEqual(Object.keys(ORACLE).sort());
    for (const [action, [roles, address]] of Object.entries(ORACLE)) {
      const row = MATRIX[action as Action];
      expect(rolesOf(action as Action).sort(), `${action} roles`).toEqual([...roles].sort());
      expect(`${row.method} ${row.path}`, `${action} route`).toBe(address);
    }
  });

  it('no two rows share an address, and no address is a table or column name taken from the client (A11): every path is a fixed word or a named :parameter', () => {
    const seen = new Set<string>();
    for (const row of Object.values(MATRIX)) {
      const address = `${row.method} ${row.path}`;
      expect(seen.has(address), address).toBe(false);
      seen.add(address);
      expect(row.path).toMatch(/^\/v1\/[a-z0-9\-/:_]+$/);
      expect(row.path).not.toMatch(/:(table|column|resource|name|field)\b/);
    }
  });

  it('a user who must still change the password may call change-password, logout and me and nothing else (U11 names these three; A4 also lists activity, which U11, the narrower text, keeps out)', () => {
    const open = Object.entries(MATRIX).filter(([, r]) => r.mustChange).map(([a]) => a).sort();
    expect(open).toEqual(['session:change-password', 'session:logout', 'session:me']);
    // the session calls are open to every signed-in user (A4)
    for (const a of ['session:me', 'session:logout', 'session:change-password', 'session:activity'] as const) expect(MATRIX[a].access, a).toEqual({ open: true });
  });

  it('nobody has a direct write to bills, bill_items, receipts, receipt_allocations or users, and nobody a direct insert into designs, skus or customers (A4, A8, D11, D13)', () => {
    const edits = Object.entries(MATRIX).filter(([, r]) => r.edit);
    const tables = new Set(edits.map(([, r]) => r.edit!.table));
    for (const t of ['bills', 'bill_items', 'receipts', 'receipt_allocations', 'users', 'sessions']) expect(tables.has(t), t).toBe(false);
    for (const [a, r] of edits) {
      if (r.edit!.op === 'insert') expect(['designs', 'skus', 'customers'].includes(r.edit!.table), a).toBe(false);
      expect(r.method === 'PATCH' || r.method === 'PUT' || r.method === 'POST', a).toBe(true);
      expect(r.path, a).not.toMatch(/\/(bills|bill[-_]items|receipts|receipt[-_]allocations|users)\b/);
    }
    // the rows that touch these tables are the service functions of section 10, all POST
    for (const [a, r] of Object.entries(MATRIX)) if (/\/(bills|receipts)\b/.test(r.path)) expect(r.method === 'GET' || r.method === 'POST', a).toBe(true);
  });

  it('the public routes are /healthz, /readyz, the login and the photo read (A1); the token doors are /admin/v1/ and /internal/jobs/', () => {
    expect(Object.values(PUBLIC_ROUTES).map((p) => `${p.method} ${p.path}`).sort()).toEqual(
      ['GET /healthz', 'GET /readyz', 'POST /v1/auth/login', 'GET /v1/photos/:photo_id/full', 'GET /v1/photos/:photo_id/thumb'].sort(),
    );
    expect(Object.values(TOKEN_DOORS).map((d) => d.prefix).sort()).toEqual(['/admin/v1/', '/internal/jobs/']);
  });

  // mayCall takes the person's Grants and nothing else (the role shim is gone, T-D10b): the answers for the three built-in roles are asked through their tick sets, as a request asks them. A text that is
  // not a role can no longer be handed to it, so the check that such a name holds no tick has nothing left to ask; a person with no tick at all is NO_GRANTS, in tests/api/access-matrix.test.ts.
  it('mayCall answers from the matrix', () => {
    expect(mayCall(builtinGrants('owner'), 'fn:void_receipt')).toBe(true);
    expect(mayCall(builtinGrants('biller'), 'fn:void_receipt')).toBe(false);
    expect(mayCall(builtinGrants('staff'), 'fn:create_design')).toBe(true);
    expect(mayCall(builtinGrants('staff'), 'fn:create_bill')).toBe(false);
    expect(mayCall(builtinGrants('owner'), 'fn:no_such_function' as Action)).toBe(false);
  });

  it('the field rules of section 10 and A5 are owner-only: cash_override_reason (Z1), original_net_weight (X8), a date other than today (Y8), removing, reordering or replacing the photo ids of a design or an order (A5, P3), and the status of a delivered or cancelled order (FB-D8)', () => {
    expect(Object.keys(FIELD_RIGHTS).sort()).toEqual(['back_dates', 'cash_override_reason', 'change_closed_order', 'original_net_weight', 'rewrite_photo_ids']);
    for (const field of Object.keys(FIELD_RIGHTS) as (keyof typeof FIELD_RIGHTS)[]) {
      expect(mayUseField(builtinGrants('owner'), field), field).toBe(true);
      expect(mayUseField(builtinGrants('biller'), field), field).toBe(false);
      expect(mayUseField(builtinGrants('staff'), field), field).toBe(false);
      expect(mayUseField(NO_GRANTS, field), field).toBe(false);
    }
  });

  it('staff read the seven settings keys of A4 and no others', () => {
    expect([...STAFF_SETTING_KEYS].sort()).toEqual(['custom_fields', 'data_epoch', 'locations', 'materials', 'numbering', 'photos', 'tag_template']);
  });
});

// ------------------------------------------------------------------ the columns

/** A5, typed in from the spec: the content columns that can be edited directly. */
const A5 = {
  designs: ['name', 'description', 'notes', 'tags', 'primary_photo_id', 'photo_ids', 'category_id', 'subcategory_id', 'archived_at'],
  skus: ['gross_weight', 'customer_net_weight', 'stones', 'stone_weight', 'kundan', 'kundan_weight', 'piroi', 'labour_retail', 'labour_semi', 'labour_wholesale', 'location', 'notes'],
  customers: ['name', 'mobile', 'customer_type', 'email', 'address', 'gst_number', 'pan', 'notes'],
};

let scratch: Scratch;
let conn: Connection;
let schema: Map<string, string[]>;
let derived: Map<string, string[]>;

beforeAll(async () => {
  scratch = await scratchDatabase('mtx', { schema: true });
  conn = await scratch.connect();
  const [cols] = await conn.query<any[]>('SELECT TABLE_NAME AS t, COLUMN_NAME AS c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME, ORDINAL_POSITION', [scratch.database]);
  schema = new Map();
  for (const r of cols) schema.set(r.t, [...(schema.get(r.t) ?? []), r.c]);
  const q = loadQueries();
  derived = new Map();
  for (const [name, key] of [['bill_summary', 'V1'], ['customer_balances', 'V2'], ['customer_ledger', 'V3'], ['daily_totals', 'V4']] as const) {
    const [, fields] = await conn.query(`SELECT * FROM (${q[key]}) v LIMIT 0`);
    derived.set(name, (fields as { name: string }[]).map((f) => f.name));
  }
}, 120_000);
afterAll(async () => {
  await conn?.end();
  await scratch?.drop();
});

/** The columns a built-in role reads of a resource; undefined when it reads none. */
const listFor = (resource: string, role: BuiltinRole) => readColumnsFor(builtinGrants(role), resource) ?? undefined;

describe('T-D02 READ_COLUMNS: a read names its columns (A4), and they are the columns of the schema', () => {
  it('every resource of READ_COLUMNS is read by a row of the matrix, and every row that reads says which resources', () => {
    const named = new Set(Object.values(MATRIX).flatMap((r) => r.reads ?? []));
    expect([...named].sort()).toEqual([...READ_RESOURCES].sort());
    expect(Object.keys(READ_COLUMNS).sort()).toEqual([...READ_RESOURCES].sort());
  });

  it('a role that may not read the row has no columns for it, and a role that may has a list with no duplicate (nobody not signed in has a list at all)', () => {
    for (const [action, row] of Object.entries(MATRIX)) {
      for (const resource of row.reads ?? []) {
        // a call that serves several resources (the poll) is allowed to a role when it may read at least some of them; the resource's own row decides which
        const own = ORACLE[`read:${resource}`];
        const roles = own ? own[0] : ORACLE[action][0];
        for (const role of BUILTIN_ROLES) {
          const list = listFor(resource, role);
          if (!roles.includes(role)) expect(list, `${action}/${resource}/${role}`).toBeUndefined();
          else {
            expect(list?.length ?? 0, `${action}/${resource}/${role}`).toBeGreaterThan(0);
            expect(new Set(list).size, `${action}/${resource}/${role} duplicates`).toBe(list!.length);
          }
        }
      }
    }
  });

  it('every column listed exists in the migrated table, or in the query of the derived read (db/queries), and the derived reads list every column of their query', () => {
    for (const resource of READ_RESOURCES) {
      const real = derived.get(resource) ?? schema.get(resource);
      expect(real, `${resource} is neither a table nor a derived read`).toBeDefined();
      for (const role of BUILTIN_ROLES) for (const c of listFor(resource, role) ?? []) expect(real, `${resource}.${c} (${role})`).toContain(c);
      if (derived.has(resource)) for (const role of BUILTIN_ROLES) if (listFor(resource, role)) expect([...listFor(resource, role)!].sort(), `${resource} for ${role}`).toEqual([...real!].sort());
    }
  });

  it('every column of a table is either listed for the widest role or named in HIDDEN_COLUMNS with a reason: a column added by a migration is decided, not exposed or hidden by chance', () => {
    for (const resource of READ_RESOURCES) {
      if (derived.has(resource)) continue;
      const all = schema.get(resource)!;
      const widest = new Set(BUILTIN_ROLES.flatMap((r) => listFor(resource, r) ?? []));
      const hidden = Object.keys((HIDDEN_COLUMNS as Record<string, Record<string, string>>)[resource] ?? {});
      for (const c of all) expect(widest.has(c) !== hidden.includes(c), `${resource}.${c} must be listed or hidden, not both and not neither`).toBe(true);
      for (const c of hidden) expect(all, `${resource}.${c} is hidden but is not a column`).toContain(c);
      for (const reason of Object.values((HIDDEN_COLUMNS as Record<string, Record<string, string>>)[resource] ?? {})) expect(reason.length).toBeGreaterThan(10);
    }
  });

  it('no role sees more than a wider role: what staff lists is within the biller\'s and the biller\'s is within the owner\'s, where they list the resource', () => {
    for (const resource of READ_RESOURCES) {
      const o = listFor(resource, 'owner');
      const b = listFor(resource, 'biller');
      const s = listFor(resource, 'staff');
      if (b && o) for (const c of b) expect(o, `${resource}.${c} biller beyond owner`).toContain(c);
      if (s && b) for (const c of s) expect(b, `${resource}.${c} staff beyond biller`).toContain(c);
      if (s && !b && o) for (const c of s) expect(o, `${resource}.${c} staff beyond owner`).toContain(c);
    }
  });

  it('users: id, full_name, role and active, plus the stamp updated_at that C3 and C4 need, and never the hash or the e-mail (A4, D1)', () => {
    // A4 gives the content of a users row as id, full_name, role and active (never the hash). C3 orders EVERY sync resource by (updated_at, key) and C4 takes the cursor "from the data" and
    // merges "keeping the row with the greater updated_at": a row without its stamp cannot be placed in the order or merged, so users carry updated_at too (API11 confirmed this against C3/C4).
    for (const role of BUILTIN_ROLES) expect([...listFor('users', role)!].sort()).toEqual(['active', 'full_name', 'id', 'role', 'updated_at']);
    for (const role of BUILTIN_ROLES) for (const secret of ['email', 'password_hash', 'must_change_password', 'last_login_at', 'created_at', 'created_by', 'updated_by']) expect(listFor('users', role), `${role} ${secret}`).not.toContain(secret);
  });

  it('every sync resource lists the stamp and the key its cursor needs (C3, C4): updated_at for all, and the key named in C3 (id, setting_key, sku_id)', () => {
    const KEY: Record<string, string> = { settings: 'setting_key', sku_private: 'sku_id' };
    const synced = ['users', 'settings', 'daily_rates', 'categories', 'subcategories', 'designs', 'skus', 'sku_private', 'customers', 'bills', 'bill_items', 'receipts', 'receipt_allocations', 'bill_summary', 'customer_balances'] as const;
    for (const resource of synced) {
      for (const role of BUILTIN_ROLES) {
        const list = listFor(resource, role);
        if (!list) continue;
        expect(list, `${resource}/${role} needs the stamp`).toContain('updated_at');
        expect(list, `${resource}/${role} needs the key`).toContain(KEY[resource] ?? 'id');
      }
    }
  });

  // The seven keys staff read are open to everyone signed in (DESIGN.md 6.2 "Always on"), so a person with no tick reads those seven too (NO_GRANTS: tests/api/access-matrix.test.ts); the text of a role that is
  // not one can no longer be handed to the function, so the loop over such names is gone with the shim.
  it('readableSettingKeys: the owner and the biller read every key (null), staff the seven keys of A4 (A4, C3)', () => {
    expect(readableSettingKeys(builtinGrants('owner'))).toBeNull();
    expect(readableSettingKeys(builtinGrants('biller'))).toBeNull();
    expect(readableSettingKeys(builtinGrants('staff'))).toEqual(STAFF_SETTING_KEYS);
    expect(readableSettingKeys(builtinGrants('staff'))).toHaveLength(7);
  });

  it('the owner-only weight (D9): original_net_weight is listed for the owner of sku_private and nowhere else; no list holds a hash, a token hash or photo bytes', () => {
    for (const resource of READ_RESOURCES) {
      for (const role of BUILTIN_ROLES) {
        const list = listFor(resource, role) ?? [];
        for (const c of list) {
          expect(c, `${resource}/${role}`).not.toMatch(/^(password_hash|token_hash|claim_token|args_hash)$/);
          if (c === 'bytes') expect(resource, 'the only bytes column a list may hold is the size of a backup run, never the bytes of a photo').toBe('backup_runs');
          if (c === 'original_net_weight') expect([resource, role], 'original_net_weight').toEqual(['sku_private', 'owner']);
        }
      }
    }
    expect(listFor('sku_private', 'owner')).toContain('original_net_weight');
    expect(listFor('sku_private', 'biller')).toBeUndefined();
    expect(listFor('sku_private', 'staff')).toBeUndefined();
  });

  it('a table that no screen reads (the internal tables, S1, D18, D24, D25) is a read resource of nobody, and every table of the schema is either a read resource, an internal table, or design_photos (read through the photo calls)', () => {
    const readable = new Set<string>(READ_RESOURCES);
    for (const t of INTERNAL_TABLES) expect(readable.has(t), t).toBe(false);
    const classified = new Set<string>([...readable, ...INTERNAL_TABLES]);
    const unclassified = [...schema.keys()].filter((t) => !classified.has(t));
    expect(unclassified, 'a table added by a migration must be put in READ_RESOURCES or INTERNAL_TABLES by the task that adds it').toEqual([]);
    for (const t of INTERNAL_TABLES) expect(schema.has(t) || t === 'schema_migrations', t).toBe(true);
  });

  it('control: a column added to a table and not decided is found by the same check', async () => {
    await conn.query('ALTER TABLE customers ADD COLUMN IF NOT EXISTS secret_marker VARCHAR(10) NULL');
    const [cols] = await conn.query<any[]>("SELECT COLUMN_NAME AS c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'customers'", [scratch.database]);
    const widest = new Set(BUILTIN_ROLES.flatMap((r) => listFor('customers', r) ?? []));
    const hidden = Object.keys(HIDDEN_COLUMNS.customers);
    const undecided = cols.map((r) => r.c as string).filter((c) => !widest.has(c) && !hidden.includes(c));
    expect(undecided).toEqual(['secret_marker']);
  });
});

describe('T-D02 WRITE_COLUMNS: the editable fields per tick and so per role (A5), and a field outside the list is refused, not ignored', () => {
  const editRows = Object.entries(MATRIX).filter(([, r]) => r.edit) as [EditAction, (typeof MATRIX)[Action]][];
  const listsOf = (action: EditAction) => Object.entries(WRITE_COLUMNS[action]) as [string, readonly string[]][];

  it('has one entry for each edit row, with a list for each tick of that row and for no other tick; a built-in role has fields exactly on the rows the spec gives it', () => {
    expect(Object.keys(WRITE_COLUMNS).sort()).toEqual(editRows.map(([a]) => a).sort());
    for (const [action, row] of editRows) {
      const ticks = 'anyOf' in row.access ? [...row.access.anyOf] : [];
      expect(listsOf(action).map(([t]) => t).sort(), action).toEqual(ticks.sort());
      for (const [tick, list] of listsOf(action)) {
        expect(list.length, `${action}/${tick}`).toBeGreaterThan(0);
        expect(new Set(list).size, `${action}/${tick} duplicates`).toBe(list.length);
      }
      for (const role of BUILTIN_ROLES) {
        const fields = writeColumnsFor(action, builtinGrants(role));
        if (!ORACLE[action][0].includes(role)) expect(fields, `${action}/${role}`).toEqual([]);
        else expect(fields.length, `${action}/${role}`).toBeGreaterThan(0);
      }
    }
  });

  it('every column exists in the table, and none is a stamp, a person column or a state that only a function changes (S6, A5: skus.status and skus.archived_at change only through X9)', () => {
    for (const [action, row] of editRows) {
      for (const [tick, list] of listsOf(action)) {
        for (const c of list) {
          expect(schema.get(row.edit!.table), `${action}.${c}`).toContain(c);
          expect(c, `${action}/${tick}`).not.toMatch(/^(id|created_at|updated_at|created_by|updated_by|confirmed_by|set_by|import_batch_id|request_id|password_hash)$/);
          if (row.edit!.table === 'skus') expect(['status', 'archived_at', 'sold_bill_id']).not.toContain(c);
        }
      }
    }
  });

  it('A5: the content columns of designs, skus and customers are exactly the spec\'s, with the owner-only exceptions', () => {
    const w = (action: EditAction, role: BuiltinRole) => [...writeColumnsFor(action, builtinGrants(role))].sort();
    // designs: staff may edit the content columns and archived_at; only the owner changes material, purity and selling_method (A4)
    expect(w('edit:designs.update', 'staff')).toEqual([...A5.designs].sort());
    expect(w('edit:designs.update', 'owner')).toEqual([...A5.designs, 'material', 'purity', 'selling_method'].sort());
    expect(w('edit:designs.update', 'staff')).not.toContain('material');
    expect(w('edit:designs.update', 'staff')).not.toContain('purity');
    expect(w('edit:designs.update', 'staff')).not.toContain('selling_method');
    // skus: the content columns for the owner and staff
    expect(w('edit:skus.update', 'owner')).toEqual([...A5.skus].sort());
    expect(w('edit:skus.update', 'staff')).toEqual([...A5.skus].sort());
    // customers: the content columns for the owner and a biller; archived_at only for the owner
    expect(w('edit:customers.update', 'biller')).toEqual([...A5.customers].sort());
    expect(w('edit:customers.update', 'owner')).toEqual([...A5.customers, 'archived_at'].sort());
    expect(w('edit:customers.update', 'biller')).not.toContain('archived_at');
  });

  it('a user is never edited (A8) and neither is a bill, a bill line, a receipt or an allocation: no entry names them', () => {
    for (const [, row] of editRows) expect(['users', 'bills', 'bill_items', 'receipts', 'receipt_allocations', 'sessions']).not.toContain(row.edit!.table);
    expect(Object.keys(WRITE_COLUMNS).some((a) => /users|bills|receipts|allocations/.test(a))).toBe(false);
  });
});

// ------------------------------------------------------------------ T-D01: every table has a primary key and InnoDB; T-D02: the rights of the database user

/** The catalogue clause of T-D01 (S1, D18): every table has a primary key and the InnoDB engine. Returns one line for every table that does not. */
async function catalogueProblems(c: Connection, database: string): Promise<string[]> {
  const [tables] = await c.query<any[]>("SELECT TABLE_NAME AS t, ENGINE AS e FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'", [database]);
  const [keys] = await c.query<any[]>("SELECT TABLE_NAME AS t FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = ? AND CONSTRAINT_TYPE = 'PRIMARY KEY'", [database]);
  const withKey = new Set(keys.map((k) => k.t as string));
  const problems: string[] = [];
  for (const t of tables) {
    if (!withKey.has(t.t)) problems.push(`${t.t} has no primary key`);
    if (String(t.e).toLowerCase() !== 'innodb') problems.push(`${t.t} is ${t.e}, not InnoDB`);
  }
  return problems;
}

describe('T-D01 every table has a primary key and InnoDB', () => {
  it('the migrated schema: all 29 tables (the 28 of the code, with the orders of FB-E1, the roles of 0012, the reset links of 0013, and schema_migrations)', async () => {
    const [tables] = await conn.query<any[]>("SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'", [scratch.database]);
    expect(Number(tables[0].n)).toBe(29);
    expect(await catalogueProblems(conn, scratch.database)).toEqual([]);
  });

  it('control: a table without a primary key and one on MyISAM are found by the same check', async () => {
    await conn.query('CREATE TABLE IF NOT EXISTS zz_no_key (a INT) ENGINE=InnoDB');
    await conn.query('CREATE TABLE IF NOT EXISTS zz_myisam (a INT PRIMARY KEY) ENGINE=MyISAM');
    const problems = await catalogueProblems(conn, scratch.database);
    expect(problems).toContain('zz_no_key has no primary key');
    expect(problems).toContain('zz_myisam is MyISAM, not InnoDB');
    expect(problems.length).toBe(2);
  });
});

describe('T-D02 the rights of the database user contain no Delete, Drop, SUPER or FILE, and none of the other six unticked boxes of A3', () => {
  const UNTICKED = ['DELETE', 'DROP', 'EXECUTE', 'CREATE VIEW', 'SHOW VIEW', 'CREATE ROUTINE', 'ALTER ROUTINE', 'EVENT', 'SUPER', 'FILE', 'GRANT OPTION', 'CREATE USER', 'RELOAD', 'PROCESS', 'SHUTDOWN'];

  async function held(c: Connection, database: string) {
    const [rows] = await c.query<any[]>('SHOW GRANTS FOR CURRENT_USER()');
    return parseGrants(rows.map((r) => String(Object.values(r)[0])), database).held;
  }

  it('the scratch user built with the hPanel list holds exactly the ten ticked boxes', async () => {
    const h = await held(conn, scratch.database);
    expect(h.sort()).toEqual([...TEN_BOXES].sort());
    for (const r of UNTICKED) expect(h, r).not.toContain(r);
  });

  it('the lane user (the one every database test of the lane uses) too', async () => {
    const lane = laneDbSettings();
    const root = await laneRoot();
    try {
      const [rows] = await root.query<any[]>('SHOW GRANTS FOR ?@?', [lane.user, '%']);
      const h = parseGrants(rows.map((r) => String(Object.values(r)[0])), lane.name).held;
      expect(h.sort()).toEqual([...TEN_BOXES].sort());
      for (const r of UNTICKED) expect(h, r).not.toContain(r);
    } finally {
      await root.end();
    }
  });

  it('control: a user that was given Delete is found by the same reading', async () => {
    const root = await laneRoot();
    try {
      await root.query(`GRANT DELETE ON \`${scratch.database}\`.* TO ?@'%'`, [scratch.user]);
      const c2 = await scratch.connect();
      try {
        expect(await held(c2, scratch.database)).toContain('DELETE');
      } finally {
        await c2.end();
      }
    } finally {
      await root.end();
    }
  });
});
