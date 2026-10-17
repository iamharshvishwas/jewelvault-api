import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadQueries } from '../../scripts/queries.mjs';
import { timestampToWire } from '../../src/wire/format';
import { txContext, withRead } from '../../src/db/tx';
import { readPage } from '../../src/sync/page';
import { SYNC_RESOURCES, resourceByName } from '../../src/sync/resources';
import { INTERNAL_TABLES, READ_COLUMNS, STAFF_SETTING_KEYS, type ReadResource, type Role } from '../../src/permissions/matrix';
import { V, insert } from '../schema/support';
import { CALLERS, type CallerName, type World, T0 } from './cells';
import { createClock } from '../../src/clock';
import { type Catalogue, judgeLog, loadCatalogue } from './static-explain-lib';
import { installStatementLog, readStatementLog } from './statement-log';
import { ORIGINAL_WEIGHT, SYNC_ROWS, type Fixture, type PageBody, bodyOf, getPage, minusSeconds, pageAll, poll, syncWorld } from './sync-support';

// API11, the read side (C3, C4): GET /v1/sync/<resource> and POST /v1/sync/poll on the application's real routes, a scratch database with the migrations, the seeds and the ledger fixture of
// tests/schema/support.ts. The big paging cases (2,500 pieces, 30,000 random ids) are in sync-paging.test.ts, the snapshot of the poll in sync-snapshot.test.ts, the session clause in sync-session.test.ts.

let world: World;
let data: Fixture;
let catalogue: Catalogue;
/** The API's clock in this file: a test moves it by changing `micros`. It starts at the instant the fixtures are made relative to (17 Oct 2026, 10:00 UTC). */
const time = { micros: T0 };

beforeAll(async () => {
  ({ world, data } = await syncWorld('syncr', { clock: createClock(() => time.micros) }));
  catalogue = await loadCatalogue(world.sql);
}, 120_000);
afterAll(async () => {
  await world?.close();
});

const ROLE_CALLERS = ['owner', 'biller', 'staff'] as const satisfies readonly CallerName[];
const NAMES = SYNC_ROWS.map((r) => r.name);
const errorCode = (res: { body: string }) => (JSON.parse(res.body) as { error?: { code: string } }).error?.code;

/** Every row a caller can read of every resource it may read, by GET and by one poll: the text of all answers, for the searches of T-D16 and T-D03. */
async function everythingReadBy(caller: Exclude<CallerName, 'anon'>): Promise<{ get: Map<string, string>; poll: string }> {
  const role = caller as string;
  const mine = SYNC_ROWS.filter((r) => r.roles.includes(role));
  const get = new Map<string, string>();
  for (const r of mine) get.set(r.name, JSON.stringify((await pageAll(world, caller, r.name)).rows));
  const res = await poll(world, caller, { cursors: Object.fromEntries(mine.map((r) => [r.name, null])) });
  expect(res.statusCode, `${caller} polls everything it may read`).toBe(200);
  return { get, poll: res.body };
}

// ------------------------------------------------------------------ T-D17

describe('T-D17 there is no GraphQL and no generic table route: /graphql, /v1/sync/<unknown> and a table or column name sent by a client are refused (S1, A11)', () => {
  it('/graphql answers 404 to every caller on every method, and reads nothing', async () => {
    for (const caller of CALLERS) {
      for (const method of ['GET', 'POST', 'PUT', 'PATCH'] as const) {
        const before = world.spy.sent.length;
        const res = await world.call(caller, method, '/graphql', method === 'GET' ? {} : { payload: { query: '{ users { password_hash } }' } });
        expect(res.statusCode, `${caller} ${method} /graphql`).toBe(404);
        expect(errorCode(res)).toBe('JV_NOT_FOUND');
        expect(world.spy.sent.length, `${caller} ${method} /graphql reads nothing`).toBe(before);
      }
    }
  });

  it('/v1/sync/<unknown> answers 404 to every caller, in any spelling: a table, a view, a made-up name, a path trick', async () => {
    const unknown = ['sessions', 'sys_counters', 'users;drop', 'Users', 'USERS', 'customers/', 'customers/anything', 'customers%00', '..', 'daily_rates', 'sku_private', 'bill_items', 'audit-log', 'audit_log', 'check-runs', 'backup-runs', 'customer-ledger', 'daily-totals', 'poll/x', 'information_schema', 'nothing'];
    for (const caller of CALLERS) {
      for (const name of unknown) {
        const res = await getPage(world, caller, name);
        expect(res.statusCode, `${caller} GET /v1/sync/${name}`).toBe(404);
        expect(errorCode(res)).toBe('JV_NOT_FOUND');
      }
    }
    // the poll is a POST: a GET of it is no route either
    expect((await getPage(world, 'owner', 'poll')).statusCode).toBe(404);
  });

  it('a table or column name sent by a client is refused with 422 and changes nothing: an unknown query key on a read', async () => {
    for (const q of [{ table: 'sessions' }, { columns: 'password_hash' }, { select: '*' }, { order: 'id' }, { where: '1=1' }, { fields: 'email' }, { resource: 'users' }, { key: 'id' }, { sort: 'updated_at' }]) {
      const res = await getPage(world, 'owner', 'customers', q);
      expect(res.statusCode, JSON.stringify(q)).toBe(422);
      expect(errorCode(res)).toBe('JV_INVALID_INPUT');
    }
  });

  it('a table or column name sent in a poll is refused with 422: a resource the poll does not know, a table spelled with an underscore, an extra key anywhere', async () => {
    const bodies: unknown[] = [
      { cursors: { sessions: null } },
      { cursors: { sys_counters: null } },
      { cursors: { daily_rates: null } },
      { cursors: { users: null, password_hash: null } },
      { cursors: { customers: null }, columns: ['password_hash'] },
      { cursors: { customers: null }, table: 'sessions' },
      { cursors: { customers: { updated_at: '2026-10-17T10:00:00.000000Z', key: null, columns: 'x' } } },
      { cursors: { constructor: null } },
      { cursors: { __proto__x: null } },
    ];
    for (const body of bodies) {
      const res = await poll(world, 'owner', body);
      expect(res.statusCode, JSON.stringify(body)).toBe(422);
      expect(errorCode(res)).toBe('JV_INVALID_INPUT');
    }
  });
});

// ------------------------------------------------------------------ T-D16

describe('T-D16 the internal tables and the password hash are returned by no route (D18, D24, D25, S1)', () => {
  const INTERNAL = ['sys_counters', 'sys_idempotency', 'sys_import_batches', 'sys_login_attempts', 'sys_job_runs', 'sys_photo_copies', 'sys_error_log', 'sessions'];

  it('a sync resource named like an internal table answers 404 to every caller, and the poll refuses the name', async () => {
    expect(INTERNAL_TABLES).toEqual(expect.arrayContaining(INTERNAL));
    for (const table of [...INTERNAL_TABLES, ...INTERNAL_TABLES.map((t) => t.replaceAll('_', '-'))]) {
      for (const caller of CALLERS) {
        const res = await getPage(world, caller, table);
        expect(res.statusCode, `${caller} GET /v1/sync/${table}`).toBe(404);
        expect(errorCode(res)).toBe('JV_NOT_FOUND');
      }
      const res = await poll(world, 'owner', { cursors: { [table]: null } });
      expect(res.statusCode, `poll ${table}`).toBe(422);
    }
  });

  it('no response of any sync route to any role contains password_hash, a stored hash or a login e-mail', async () => {
    const [users] = await world.sql.query<any[]>('SELECT email, password_hash FROM users');
    expect(users.length).toBeGreaterThanOrEqual(8);
    for (const caller of ROLE_CALLERS) {
      const all = await everythingReadBy(caller);
      const text = [...all.get.values(), all.poll].join('\n');
      expect(text, caller).not.toContain('password_hash');
      for (const u of users) {
        expect(text, `${caller} must not hold a stored hash`).not.toContain(u.password_hash);
        expect(text, `${caller} must not hold a login e-mail`).not.toContain(u.email);
      }
    }
  });

  it('the users rows hold id, full_name, role, active and the stamp that C3 and C4 need, and nothing else', async () => {
    const page = bodyOf(await getPage(world, 'staff', 'users'));
    expect(page.rows.length).toBeGreaterThanOrEqual(8);
    for (const row of page.rows) expect(Object.keys(row).sort()).toEqual(['active', 'full_name', 'id', 'role', 'updated_at']);
  });
});

// ------------------------------------------------------------------ T-D03

describe('T-D03 staff cannot read sku_private, audit_log, bills, customers or receipts and read only the seven settings keys; nobody but the owner reads the original weight (D9, D12, A4, A14)', () => {
  const FORBIDDEN_FOR_STAFF = ['sku-private', 'customers', 'bills', 'bill-items', 'receipts', 'receipt-allocations', 'bill-summary', 'customer-balances'];

  it('staff get 403 JV_FORBIDDEN on each of them, and a poll that names one of them is refused as a whole', async () => {
    for (const name of FORBIDDEN_FOR_STAFF) {
      const res = await getPage(world, 'staff', name);
      expect(res.statusCode, name).toBe(403);
      expect(errorCode(res)).toBe('JV_FORBIDDEN');
      const p = await poll(world, 'staff', { cursors: { skus: null, [name]: null } });
      expect(p.statusCode, `poll with ${name}`).toBe(403);
      expect(errorCode(p)).toBe('JV_FORBIDDEN');
      expect(Object.keys(JSON.parse(p.body)).sort(), 'no partial answer').toEqual(['error', 'request_id']);
    }
  });

  it('audit_log, check_runs and backup_runs are not sync resources at all: 404 for every role, the owner included (C3: they are read on demand)', async () => {
    for (const name of ['audit-log', 'audit_log', 'check-runs', 'check_runs', 'backup-runs', 'backup_runs']) {
      for (const caller of ROLE_CALLERS) expect((await getPage(world, caller, name)).statusCode, `${caller} ${name}`).toBe(404);
    }
  });

  it('a forbidden poll reads no table: the refusal comes before the first page', async () => {
    const before = world.spy.sent.length;
    const res = await poll(world, 'biller', { cursors: { customers: null, 'sku-private': null } });
    expect(res.statusCode).toBe(403);
    const pages = world.spy.sqls().slice(before).filter((s) => /\bupdated_at\b/.test(s) && /\bORDER BY\b/i.test(s));
    expect(pages).toEqual([]);
  });

  it('staff read the seven settings keys of A4 and no others; a biller and the owner read all ten; the paging keeps the rule', async () => {
    const keys = async (caller: CallerName) => (await pageAll(world, caller, 'settings')).rows.map((r) => r.setting_key as string).sort();
    expect(await keys('staff')).toEqual([...STAFF_SETTING_KEYS].sort());
    const all = ['business', 'custom_fields', 'data_epoch', 'estimate', 'locations', 'materials', 'numbering', 'photos', 'tag_template', 'taxes'];
    expect(await keys('biller')).toEqual(all);
    expect(await keys('owner')).toEqual(all);
    // in pages of two, the keys that are not staff's are filtered inside the statement, so a page is full of the staff's keys and `next` is right
    const staffPaged = await pageAll(world, 'staff', 'settings', { limit: 2 });
    expect(staffPaged.rows.map((r) => r.setting_key as string).sort()).toEqual([...STAFF_SETTING_KEYS].sort());
    expect(staffPaged.pages.length).toBe(4);
    for (const p of staffPaged.pages.slice(0, -1)) expect(p.rows).toHaveLength(2);
    // the same through the poll
    const res = await poll(world, 'staff', { cursors: { settings: null } });
    const rows = (JSON.parse(res.body) as { results: { settings: PageBody } }).results.settings.rows;
    expect(rows.map((r) => r.setting_key as string).sort()).toEqual([...STAFF_SETTING_KEYS].sort());
    for (const name of ['business', 'estimate', 'taxes']) expect(JSON.stringify(rows)).not.toContain(`"${name}"`);
  });

  it('no response to a biller or staff contains the original weight, on any read route, by GET or by poll; the owner reads it from sku-private only', async () => {
    for (const caller of ['biller', 'staff'] as const) {
      const all = await everythingReadBy(caller);
      for (const text of [...all.get.values(), all.poll]) {
        expect(text, caller).not.toContain('original_net_weight');
        expect(text, caller).not.toContain(ORIGINAL_WEIGHT);
      }
    }
    const owner = await everythingReadBy('owner');
    for (const [name, text] of owner.get) {
      if (name === 'sku-private') {
        expect(text).toContain('original_net_weight');
        expect(text).toContain(ORIGINAL_WEIGHT);
      } else {
        expect(text, `owner ${name}`).not.toContain('original_net_weight');
        expect(text, `owner ${name}`).not.toContain(ORIGINAL_WEIGHT);
      }
    }
  });

  it('the owner-only weight is also kept out of the bill snapshot: the lines carry the customer net weight only', async () => {
    const lines = (await pageAll(world, 'biller', 'bill-items')).rows;
    expect(lines.length).toBeGreaterThanOrEqual(4);
    for (const line of lines) expect(Object.keys(line)).not.toContain('original_net_weight');
  });
});

// ------------------------------------------------------------------ T-D02 clause

describe('T-D02 clause (API11): the rows of the sync resources hold exactly the READ_COLUMNS of the caller, in the wire formats of S3', () => {
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  const MONEY = /^-?\d+\.\d{2}$/;
  const WEIGHT = /^-?\d+\.\d{3}$/;
  const STAMP = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/;
  const DAY = /^\d{4}-\d\d-\d\d$/;
  type Kind = 'money' | 'weight' | 'uuid' | 'timestamp' | 'date' | 'json' | 'flag' | 'count' | 'plain';
  const JSON_COLUMNS = new Set(['settings.value', 'designs.tags', 'designs.photo_ids']);
  /** The two derived reads have no table to ask information_schema about: the kinds are written from V1 and V2. */
  const DERIVED: Record<string, Record<string, Kind>> = {
    bill_summary: { id: 'uuid', customer_id: 'uuid', reissue_of: 'uuid', bill_date: 'date', grand_total: 'money', received: 'money', pending: 'money', fine_due: 'weight', fine_settled: 'weight', fine_pending: 'weight', item_count: 'count', created_at: 'timestamp', updated_at: 'timestamp' },
    customer_balances: { id: 'uuid', billed: 'money', total_purchases: 'money', received: 'money', refunded: 'money', allocated: 'money', outstanding: 'money', advance: 'money', balance: 'money', fine_billed: 'weight', fine_received: 'weight', fine_allocated: 'weight', fine_outstanding: 'weight', fine_advance: 'weight', fine_balance: 'weight', last_purchase: 'date', updated_at: 'timestamp' },
  };
  const kinds = new Map<string, Kind>();
  beforeAll(async () => {
    const [cols] = await world.sql.query<any[]>('SELECT TABLE_NAME AS t, COLUMN_NAME AS c, COLUMN_TYPE AS ty FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE()');
    for (const { t, c, ty } of cols) {
      const type = String(ty).toLowerCase();
      const kind: Kind = JSON_COLUMNS.has(`${t}.${c}`) ? 'json' : /^decimal\(\d+,2\)/.test(type) ? 'money' : /^decimal\(\d+,3\)/.test(type) ? 'weight' : type === 'uuid' ? 'uuid' : /^datetime/.test(type) ? 'timestamp' : type === 'date' ? 'date' : type === 'tinyint(1)' ? 'flag' : 'plain';
      kinds.set(`${t}.${c}`, kind);
    }
    for (const [t, m] of Object.entries(DERIVED)) for (const [c, k] of Object.entries(m)) kinds.set(`${t}.${c}`, k);
  });

  function cellProblem(kind: Kind, value: unknown): string | null {
    if (value === null) return null;
    const ok: Record<Kind, boolean> = {
      money: typeof value === 'string' && MONEY.test(value),
      weight: typeof value === 'string' && WEIGHT.test(value),
      uuid: typeof value === 'string' && UUID.test(value),
      timestamp: typeof value === 'string' && STAMP.test(value),
      date: typeof value === 'string' && DAY.test(value),
      json: typeof value === 'object',
      flag: typeof value === 'boolean',
      count: typeof value === 'number' && Number.isInteger(value),
      plain: typeof value !== 'object' || value === null,
    };
    return ok[kind] ? null : `${kind} expected, got ${typeof value} ${JSON.stringify(value)}`;
  }

  for (const r of SYNC_ROWS) {
    for (const role of ROLE_CALLERS) {
      const allowed = r.roles.includes(role);
      it(`${r.name} for ${role}: ${allowed ? 'every row has exactly the READ_COLUMNS of the role, each value in its wire format' : '403 JV_FORBIDDEN'}`, async () => {
        const res = await getPage(world, role, r.name, { limit: 1000 });
        if (!allowed) {
          expect(res.statusCode).toBe(403);
          expect(errorCode(res)).toBe('JV_FORBIDDEN');
          return;
        }
        expect(res.statusCode).toBe(200);
        const page = bodyOf(res);
        expect(page.rows.length, `the fixture holds rows of ${r.name}`).toBeGreaterThan(0);
        const expected = [...(READ_COLUMNS[r.table as ReadResource][role as Role] ?? [])].sort();
        const problems: string[] = [];
        for (const row of page.rows) {
          expect(Object.keys(row).sort()).toEqual(expected);
          for (const [column, value] of Object.entries(row)) {
            const kind = kinds.get(`${r.table}.${column}`) ?? 'plain';
            const p = cellProblem(kind, value);
            if (p) problems.push(`${column}: ${p}`);
          }
        }
        expect(problems.slice(0, 5)).toEqual([]);
      });
    }
  }

  it('every column the code formats is declared with the kind the schema gives it, and no money, weight, id, stamp or date column is left to chance (src/sync/resources.ts against the migrated schema)', () => {
    const problems: string[] = [];
    for (const r of SYNC_RESOURCES) {
      const widest = new Set(Object.values(READ_COLUMNS[r.table]).flatMap((c) => c ?? []));
      for (const column of widest) {
        const expected = kinds.get(`${r.table}.${column}`) ?? 'plain';
        const declared = r.kinds[column] as Kind | undefined;
        if (expected === 'money' || expected === 'weight' || expected === 'uuid' || expected === 'timestamp' || expected === 'date') {
          if (declared !== expected) problems.push(`${r.table}.${column}: the schema says ${expected}, resources.ts says ${declared ?? 'nothing'}`);
        } else if (declared !== undefined) problems.push(`${r.table}.${column}: resources.ts formats it as ${declared}, the schema says ${expected}`);
        if ((expected === 'json') !== r.json.includes(column)) problems.push(`${r.table}.${column}: json list`);
        if ((expected === 'flag') !== r.flags.includes(column)) problems.push(`${r.table}.${column}: flag list`);
        if ((expected === 'count') !== r.counts.includes(column)) problems.push(`${r.table}.${column}: count list`);
      }
      for (const column of Object.keys(r.kinds)) if (!widest.has(column)) problems.push(`${r.table}.${column}: formatted but listed for no role`);
    }
    expect(problems).toEqual([]);
  });

  it('a stamp is the database text turned into the wire text digit for digit, microseconds included', async () => {
    const [db] = await world.sql.query<any[]>('SELECT id, updated_at FROM categories ORDER BY updated_at, id');
    const rows = (await pageAll(world, 'owner', 'categories')).rows;
    expect(rows.map((r) => r.id)).toEqual(db.map((r: any) => r.id));
    expect(rows.map((r) => r.updated_at)).toEqual(db.map((r: any) => timestampToWire(r.updated_at)));
  });

  it('every answer carries Cache-Control: no-store, an X-Request-Id and the API clock as server_time (A14, C3)', async () => {
    const res = await getPage(world, 'owner', 'categories');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    const page = bodyOf(res);
    expect(page.server_time).toMatch(/^2026-10-17T10:00:00\.\d{6}Z$/);
    expect(Object.keys(page).sort()).toEqual(['next', 'rows', 'server_time']);
  });
});

// ------------------------------------------------------------------ the role sets of C3 and A9

describe('T-D03 / A9 the role sets of the read side: C3 names them, A4 draws them, and the code serves exactly those', () => {
  // C3: "Owner: all resources except audit_log, check_runs and backup_runs. Biller: stock (without sku_private), customers, bills, bill_summary, bill_items, receipts, receipt_allocations,
  // customer_balances, rates, settings, categories, users. Staff: stock, categories, the seven settings keys of A4, users." A4's table gives staff `daily_rates` and `subcategories` too (read),
  // which C3's short list leaves out of the word "stock" and "categories"; the matrix follows A4 (the table is the oracle of T-D02), and the screens of staff need both (the rate card, the
  // sub-category pickers of the stock forms).
  const ALL = ['users', 'settings', 'daily-rates', 'categories', 'subcategories', 'designs', 'skus', 'sku-private', 'customers', 'bills', 'bill-items', 'receipts', 'receipt-allocations', 'bill-summary', 'customer-balances'];
  const BY_ROLE: Record<'owner' | 'biller' | 'staff', string[]> = {
    owner: ALL,
    biller: ALL.filter((n) => n !== 'sku-private'),
    staff: ['users', 'settings', 'daily-rates', 'categories', 'subcategories', 'designs', 'skus'],
  };

  it('each role gets 200 on exactly its resources and 403 on the others, by GET and by poll', async () => {
    for (const role of ROLE_CALLERS) {
      for (const name of ALL) {
        const res = await getPage(world, role, name, { limit: 1 });
        expect(res.statusCode, `${role} ${name}`).toBe(BY_ROLE[role].includes(name) ? 200 : 403);
      }
      const wanted = await poll(world, role, { cursors: Object.fromEntries(BY_ROLE[role].map((n) => [n, null])) });
      expect(wanted.statusCode, `${role} polls its own set`).toBe(200);
    }
    expect(SYNC_ROWS.map((r) => r.name).sort()).toEqual([...ALL].sort());
  });

  it('the bytes of a photo are in no list and no resource: design_photos is read by the photo calls only', () => {
    for (const r of SYNC_ROWS) for (const role of ROLE_CALLERS) expect(READ_COLUMNS[r.table as ReadResource][role as Role] ?? [], `${r.name}/${role}`).not.toContain('bytes');
    expect(NAMES).not.toContain('design-photos');
  });

  it('A9: reading is wide: a biller reads every customer\'s mobile, GST and PAN, and every role reads archived rows (the screens hide them, the polling needs them)', async () => {
    const [[cat]] = await world.sql.query<any[][]>('SELECT id FROM categories LIMIT 1');
    const archived = '2026-10-01 00:00:00.000000';
    const customer = (await insert(world.sql, 'customers', V.customer({ name: 'Archived Customer', mobile: '9000000001', gst_number: '27ABCDE1234F1Z5', pan: 'ABCDE1234F', archived_at: archived }))) as { id: string };
    const design = (await insert(world.sql, 'designs', V.design((cat as any).id, { archived_at: archived }))) as { id: string };
    const sku = (await insert(world.sql, 'skus', V.sku(design.id, { status: 'Archived', archived_at: archived }))) as { id: string };
    const rows = (await pageAll(world, 'biller', 'customers')).rows;
    const mine = rows.find((r) => r.id === customer.id)!;
    expect(mine).toMatchObject({ mobile: '9000000001', gst_number: '27ABCDE1234F1Z5', pan: 'ABCDE1234F', archived_at: '2026-10-01T00:00:00.000000Z' });
    for (const role of ROLE_CALLERS) {
      expect((await pageAll(world, role, 'designs')).rows.find((r) => r.id === design.id)?.archived_at, `${role} designs`).toBe('2026-10-01T00:00:00.000000Z');
      const piece = (await pageAll(world, role, 'skus')).rows.find((r) => r.id === sku.id);
      expect(piece?.status, `${role} skus`).toBe('Archived');
    }
  });
});

// ------------------------------------------------------------------ the derived reads

describe('T-F03 the derived reads are paged by the base row: bill-summary by bills.updated_at, customer-balances by customers.updated_at, with the figures of V1 and V2 (C3, C4, D23)', () => {
  const Q = loadQueries();
  const toWire = (row: Record<string, unknown>) =>
    Object.fromEntries(Object.entries(row).map(([k, v]) => [k, typeof v === 'string' && /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{6}$/.test(v) ? timestampToWire(v) : k === 'item_count' ? Number(v) : v]));

  it('bill-summary returns for every bill the very figures of V1 (received, pending, fine, payment status, item count), cancelled bills included', async () => {
    const [v1] = await world.sql.query<any[]>(`SELECT * FROM (${Q.V1}) v ORDER BY v.id`);
    expect(v1.length).toBeGreaterThanOrEqual(4);
    const got = (await pageAll(world, 'biller', 'bill-summary')).rows;
    expect(got).toHaveLength(v1.length);
    const byId = new Map(got.map((r) => [r.id, r]));
    for (const row of v1) expect(byId.get(row.id), `bill ${row.bill_no}`).toEqual(toWire(row));
    expect(got.some((r) => r.status === 'cancelled' && r.payment_status === 'Cancelled')).toBe(true);
    expect(got.some((r) => r.payment_status === 'Paid')).toBe(true);
    expect(got.some((r) => r.payment_status === 'Partial')).toBe(true);
  });

  it('customer-balances returns for every customer the very figures of V2, the walk-in and a customer with no event included', async () => {
    const [v2] = await world.sql.query<any[]>(`SELECT * FROM (${Q.V2}) v ORDER BY v.id`);
    expect(v2.length).toBeGreaterThanOrEqual(3);
    const got = (await pageAll(world, 'owner', 'customer-balances')).rows;
    expect(got).toHaveLength(v2.length);
    const byId = new Map(got.map((r) => [r.id, r]));
    for (const row of v2) expect(byId.get(row.id), `customer ${row.id}`).toEqual(toWire(row));
  });

  it('both derived reads page and filter by the BASE row\'s stamp: a touch of the bill or the customer brings the figures back, a row nobody touched stays out', async () => {
    const stamp = '2026-10-17 12:00:00.000000';
    await world.sql.query("UPDATE bills SET updated_at = '2026-10-01 00:00:00.000000'");
    await world.sql.query("UPDATE customers SET updated_at = '2026-10-01 00:00:00.000000'");
    await world.sql.query('UPDATE bills SET updated_at = ? WHERE id = ?', [stamp, data.b1.id]);
    await world.sql.query('UPDATE customers SET updated_at = ? WHERE id = ?', [stamp, data.c1.id]);
    const since = '2026-10-17T11:59:59.000000Z';
    const bills = bodyOf(await getPage(world, 'biller', 'bill-summary', { updated_after: since }));
    expect(bills.rows.map((r) => r.id)).toEqual([data.b1.id]);
    expect(bills.rows[0].updated_at).toBe('2026-10-17T12:00:00.000000Z');
    expect(bills.next).toBeNull();
    const customers = bodyOf(await getPage(world, 'biller', 'customer-balances', { updated_after: since }));
    expect(customers.rows.map((r) => r.id)).toEqual([data.c1.id]);
    expect(customers.rows[0].updated_at).toBe('2026-10-17T12:00:00.000000Z');
    // the order is the base row's (updated_at, id): in pages of one, the touched row comes last and nothing repeats
    const all = (await pageAll(world, 'biller', 'bill-summary', { limit: 1 })).rows;
    expect(all.at(-1)?.id).toBe(data.b1.id);
    expect(new Set(all.map((r) => r.id)).size).toBe(all.length);
  });
});

// ------------------------------------------------------------------ the poll

describe('T-F03 the poll (C4): one cursor per resource, one answer with server_time and the caller\'s current role, 403 as a whole when one resource is not the role\'s', () => {
  it('answers {results, server_time, role} with one {rows, next} for each resource named, and nothing for the others', async () => {
    const res = await poll(world, 'owner', { cursors: { customers: null, 'sku-private': null, 'bill-items': null } });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { results: Record<string, PageBody>; server_time: string; role: string };
    expect(Object.keys(body).sort()).toEqual(['results', 'role', 'server_time']);
    expect(body.role).toBe('owner');
    expect(body.server_time).toMatch(/^2026-10-17T10:00:00\.\d{6}Z$/);
    expect(Object.keys(body.results).sort()).toEqual(['bill-items', 'customers', 'sku-private']);
    for (const r of Object.values(body.results)) expect(Object.keys(r).sort()).toEqual(['next', 'rows']);
    expect(body.results['sku-private'].rows).toHaveLength(1);
    expect(body.results.customers.rows.length).toBeGreaterThanOrEqual(3);
  });

  it('a poll of everything a role may read: owner 15 resources, biller 14, staff 7 (A4)', async () => {
    for (const [caller, count] of [['owner', 15], ['biller', 14], ['staff', 7]] as const) {
      const mine = SYNC_ROWS.filter((r) => r.roles.includes(caller));
      expect(mine).toHaveLength(count);
      const res = await poll(world, caller, { cursors: Object.fromEntries(mine.map((r) => [r.name, null])) });
      expect(res.statusCode, caller).toBe(200);
      const body = JSON.parse(res.body) as { results: Record<string, PageBody>; role: string };
      expect(body.role).toBe(caller);
      expect(Object.keys(body.results).sort()).toEqual(mine.map((r) => r.name).sort());
    }
  });

  it('an empty list of cursors is a valid poll (nothing is read); a cursor of null starts from the beginning, a cursor with a key continues after it', async () => {
    const empty = await poll(world, 'staff', { cursors: {} });
    expect(empty.statusCode).toBe(200);
    expect(JSON.parse(empty.body).results).toEqual({});
    const first = bodyOf(await getPage(world, 'owner', 'categories', { limit: 5 }));
    expect(first.rows).toHaveLength(5);
    const fromNull = JSON.parse((await poll(world, 'owner', { limit: 5, cursors: { categories: null } })).body).results.categories as PageBody;
    expect(fromNull.rows).toEqual(first.rows);
    expect(fromNull.next).toEqual(first.next);
    const after = JSON.parse((await poll(world, 'owner', { limit: 5, cursors: { categories: first.next } })).body).results.categories as PageBody;
    const rest = bodyOf(await getPage(world, 'owner', 'categories', { limit: 5, updated_after: first.next!.updated_at, after_key: first.next!.key }));
    expect(after.rows).toEqual(rest.rows);
    expect(after.rows.map((r) => r.id)).not.toContain(first.rows.at(-1)!.id);
  });

  it('is 403 JV_FORBIDDEN as a whole when one resource is not the role\'s: no partial answer, and the call reads no page', async () => {
    const before = world.spy.sent.length;
    const res = await poll(world, 'biller', { cursors: { customers: null, 'sku-private': null, skus: null } });
    expect(res.statusCode).toBe(403);
    expect(errorCode(res)).toBe('JV_FORBIDDEN');
    expect(Object.keys(JSON.parse(res.body)).sort()).toEqual(['error', 'request_id']);
    expect(world.spy.sqls().slice(before).some((s) => /ORDER BY src\.updated_at/.test(s))).toBe(false);
  });

  it('the role in the answer is the caller\'s CURRENT role: a demotion between two polls takes sku-private away at once (T-E01 clause)', async () => {
    const id = world.fixtures.owner.userId;
    try {
      expect(JSON.parse((await poll(world, 'owner', { cursors: { 'sku-private': null } })).body).role).toBe('owner');
      await world.sql.query("UPDATE users SET role = 'biller' WHERE id = ?", [id]);
      const demoted = await poll(world, 'owner', { cursors: { 'sku-private': null } });
      expect(demoted.statusCode).toBe(403);
      const still = await poll(world, 'owner', { cursors: { customers: null } });
      expect(JSON.parse(still.body).role).toBe('biller');
    } finally {
      await world.sql.query("UPDATE users SET role = 'owner' WHERE id = ?", [id]);
    }
  });

  it('refuses a malformed body with 422 and names the field: a bad stamp, a key of the wrong kind, a limit outside 1 to 1,000, text for a number', async () => {
    const good = '2026-10-17T10:00:00.000000Z';
    const bad: [unknown, string][] = [
      [{}, 'cursors'],
      [{ cursors: [] }, 'cursors'],
      [{ cursors: { customers: { updated_at: 'yesterday', key: null } } }, 'cursors.customers.updated_at'],
      [{ cursors: { customers: { updated_at: '2026-10-17T10:00:00.000Z', key: null } } }, 'cursors.customers.updated_at'],
      [{ cursors: { customers: { updated_at: good, key: 'not-a-uuid' } } }, 'cursors.customers.key'],
      [{ cursors: { customers: { updated_at: good, key: randomUUID().toUpperCase() } } }, 'cursors.customers.key'],
      [{ cursors: { customers: { updated_at: good, key: 12 } } }, 'cursors.customers.key'],
      [{ cursors: { customers: { key: randomUUID() } } }, 'cursors.customers.updated_at'],
      [{ cursors: { settings: { updated_at: good, key: 'has space' } } }, 'cursors.settings.key'],
      [{ limit: 0, cursors: {} }, 'limit'],
      [{ limit: 1001, cursors: {} }, 'limit'],
      [{ limit: '5', cursors: {} }, 'limit'],
      [{ limit: 1.5, cursors: {} }, 'limit'],
    ];
    for (const [body, field] of bad) {
      const res = await poll(world, 'owner', body);
      expect(res.statusCode, JSON.stringify(body)).toBe(422);
      expect(JSON.parse(res.body).error.details.field, JSON.stringify(body)).toBe(field);
    }
    expect((await poll(world, 'owner', { limit: 1000, cursors: { customers: { updated_at: good, key: randomUUID() } } })).statusCode).toBe(200);
    expect((await poll(world, 'owner', { cursors: { customers: { updated_at: good } } })).statusCode).toBe(200);
  });

  it('refuses a malformed read with 422: a limit outside 1 to 1,000 (the constant is the contract), a stamp that is not the exact text, a key without a stamp, a key of the wrong kind', async () => {
    const good = '2026-10-17T10:00:00.000000Z';
    const cases: [Record<string, string | number>, string][] = [
      [{ limit: 0 }, 'limit'],
      [{ limit: 1001 }, 'limit'],
      [{ limit: 'ten' }, 'limit'],
      [{ limit: '1.5' }, 'limit'],
      [{ limit: '' }, 'limit'],
      [{ updated_after: '' }, 'updated_after'],
      [{ updated_after: '2026-10-17' }, 'updated_after'],
      [{ updated_after: '2026-10-17T10:00:00Z' }, 'updated_after'],
      [{ updated_after: '2026-10-17 10:00:00.000000' }, 'updated_after'],
      [{ after_key: randomUUID() }, 'after_key'],
      [{ updated_after: good, after_key: 'nope' }, 'after_key'],
      [{ updated_after: good, after_key: randomUUID().toUpperCase() }, 'after_key'],
    ];
    for (const [q, field] of cases) {
      const res = await getPage(world, 'owner', 'customers', q);
      expect(res.statusCode, JSON.stringify(q)).toBe(422);
      expect(JSON.parse(res.body).error.details.field, JSON.stringify(q)).toBe(field);
    }
    expect((await getPage(world, 'owner', 'customers', { limit: 1000, updated_after: good, after_key: randomUUID() })).statusCode).toBe(200);
    expect((await getPage(world, 'owner', 'settings', { updated_after: good, after_key: 'numbering' })).statusCode).toBe(200);
    // a repeated key is an array, not a stamp
    const dup = await world.call('owner', 'GET', '/v1/sync/customers?limit=1&limit=2');
    expect(dup.statusCode).toBe(422);
  });
});

// ------------------------------------------------------------------ C3: the edges of a page and the first poll

describe('T-F03 the edges (C3): two rows with one stamp at a page edge, a row stamped before and committed after the first page, the overlap', () => {
  const day = '2026-10-17';
  const at = (hms: string, micros = '000000') => `${day} ${hms}.${micros}`;
  let sentinel: string;

  beforeAll(async () => {
    // the seeded rows get an old stamp, so that the rows of these tests are the only ones after 09:00
    await world.sql.query("UPDATE categories SET updated_at = '2026-10-17 08:00:00.000000'");
    sentinel = '2026-10-17T08:59:00.000000Z';
  });

  async function makeCategory(name: string, stamp: string): Promise<string> {
    const id = randomUUID();
    await insert(world.sql, 'categories', V.category({ id, name, prefix: 'EDG', updated_at: stamp }));
    return id;
  }

  it('two rows with the same stamp at a page edge are both received: the page cut falls between them and the key carries on', async () => {
    const a = await makeCategory('Edge A', at('09:00:00', '100000'));
    const b1 = await makeCategory('Edge B1', at('09:00:01', '250000'));
    const b2 = await makeCategory('Edge B2', at('09:00:01', '250000'));
    const c = await makeCategory('Edge C', at('09:00:02', '000001'));
    const [order] = await world.sql.query<any[]>("SELECT id FROM categories WHERE name LIKE 'Edge %' ORDER BY updated_at, id");
    expect(order).toHaveLength(4);
    const first = bodyOf(await getPage(world, 'owner', 'categories', { limit: 2, updated_after: sentinel }));
    expect(first.rows.map((r) => r.id)).toEqual([order[0].id, order[1].id]);
    expect(first.next).toEqual({ updated_at: '2026-10-17T09:00:01.250000Z', key: order[1].id });
    const second = bodyOf(await getPage(world, 'owner', 'categories', { limit: 2, updated_after: first.next!.updated_at, after_key: first.next!.key }));
    expect(second.rows.map((r) => r.id)).toEqual([order[2].id, order[3].id]);
    expect(new Set([...first.rows, ...second.rows].map((r) => r.id))).toEqual(new Set([a, b1, b2, c]));
    // the microseconds are kept: 09:00:02.000001 is after 09:00:01.250000 and before 09:00:03
    expect(second.rows.at(-1)!.updated_at).toBe('2026-10-17T09:00:02.000001Z');
    // negative control: the cut by stamp alone ("after 09:00:01.25") would never show B2 when B1 ended the page
    const [naive] = await world.sql.query<any[]>("SELECT id FROM categories WHERE updated_at > '2026-10-17 09:00:01.250000' AND name LIKE 'Edge %'");
    expect(naive.map((r: any) => r.id)).toEqual([c]);
    expect([b1, b2]).toContain(order[2].id);
  });

  it('a cursor with a stamp and no key reads from that stamp INCLUDED, so a row at exactly the stamp is never skipped (the screen sends this after it subtracts the overlap)', async () => {
    const page = bodyOf(await getPage(world, 'owner', 'categories', { updated_after: '2026-10-17T09:00:01.250000Z' }));
    expect(page.rows.map((r) => r.name)).toEqual(expect.arrayContaining(['Edge B1', 'Edge B2', 'Edge C']));
    expect(page.rows.map((r) => r.name)).not.toContain('Edge A');
  });

  it('a row stamped before and committed after the first page is read still arrives, when the next poll starts at the first page\'s server_time minus 30 seconds (a transaction of up to 20 seconds)', async () => {
    // the latest row a hydrate would see was stamped one second before the first page; the late row was stamped 19 seconds before it, inside a transaction that was still open
    await makeCategory('Hydrate Last', at('09:59:59'));
    const other = await world.scratch.connect();
    const lateId = randomUUID();
    try {
      await other.query('START TRANSACTION');
      await other.query("INSERT INTO categories (id, name, prefix, updated_at) VALUES (?, 'Late Row', 'LAT', '2026-10-17 09:59:41.000000')", [lateId]);
      await other.query("INSERT INTO categories (id, name, prefix, updated_at) VALUES (?, 'Too Old Row', 'OLD', '2026-10-17 09:59:25.000000')", [randomUUID()]);
      const firstPage = bodyOf(await getPage(world, 'owner', 'categories', { updated_after: '2026-10-17T09:30:00.000000Z' }));
      expect(firstPage.rows.map((r) => r.name)).toEqual(['Hydrate Last']);
      expect(firstPage.next).toBeNull();
      await other.query('COMMIT'); // after the page was read
      // the rule of C3: the cursor of the first poll is the server_time of the FIRST PAGE minus 30 seconds
      const cursor = minusSeconds(firstPage.server_time, 30);
      const res = await poll(world, 'owner', { cursors: { categories: { updated_at: cursor, key: null } } });
      const names = (JSON.parse(res.body).results.categories as PageBody).rows.map((r) => r.name);
      expect(names).toContain('Late Row');
      expect(names).toContain('Hydrate Last'); // the overlap re-delivers what was already there: the cache merges by id
      // negative control 1: the cursor taken from the stamp of the last row received (what C3 forbids) loses the late row for good
      const last = firstPage.rows.at(-1)!;
      const naive = bodyOf(await getPage(world, 'owner', 'categories', { updated_after: last.updated_at as string, after_key: last.id as string }));
      expect(naive.rows.map((r) => r.name)).not.toContain('Late Row');
      // negative control 2: the overlap is what saves it; a row stamped more than 30 seconds before the first page is out of reach, which is why a transaction is bounded to 20 seconds (S12)
      // and bulk work ends with a re-stamp of its rows (IM1)
      expect(names).not.toContain('Too Old Row');
    } finally {
      await other.end();
    }
  });

  it('server_time is the API clock read BEFORE the page is read, so a row that commits while the page is being read is covered by the 30 seconds', async () => {
    const before = time.micros;
    let moved = false;
    world.spy.intercept = async (e) => {
      if (!moved && /ORDER BY src\.updated_at/.test(e.sql)) {
        moved = true;
        time.micros += 10_000_000n; // ten seconds go by while the page is being read
      }
    };
    try {
      const page = bodyOf(await getPage(world, 'owner', 'categories', { limit: 1 }));
      expect(moved).toBe(true);
      expect(page.server_time).toMatch(/^2026-10-17T10:00:00\.\d{6}Z$/);
      const later = bodyOf(await getPage(world, 'owner', 'categories', { limit: 1 }));
      expect(later.server_time).toMatch(/^2026-10-17T10:00:10\.\d{6}Z$/);
    } finally {
      world.spy.intercept = null;
      time.micros = before;
    }
  });
});

// ------------------------------------------------------------------ the snapshot of the poll

describe('T-F03 one poll never shows a bill without its lines (C4): all the resources of a poll are read inside one read-only snapshot', () => {
  /** A bill with one line, written and committed in one transaction by another connection: what a bill sale is, as far as the readers are concerned. */
  async function commitBillWithLine(): Promise<{ billId: string; lineId: string }> {
    const writer = await world.scratch.connect();
    const billId = randomUUID();
    const lineId = randomUUID();
    try {
      const [[design]] = await writer.query<any[][]>('SELECT id FROM designs LIMIT 1');
      await writer.query('START TRANSACTION');
      const sku = (await insert(writer, 'skus', V.sku((design as any).id))) as { id: string };
      await insert(writer, 'bills', V.bill(data.c1.id, { id: billId, bill_no: `JV-2026-R${billId.slice(0, 6)}` }));
      await insert(writer, 'bill_items', V.billItem(billId, sku.id, { id: lineId }));
      await writer.query('COMMIT');
    } finally {
      await writer.end();
    }
    return { billId, lineId };
  }
  const readsBills = (sql: string) => /FROM `bills` AS src/.test(sql);

  it('a bill and its line committed between the page of the lines and the page of the bills appear in neither: no bill without its lines, no line without its bill', async () => {
    let written: { billId: string; lineId: string } | undefined;
    world.spy.intercept = async (e) => {
      if (!written && readsBills(e.sql)) written = await commitBillWithLine(); // the lines were read first; the bills are read next
    };
    let res;
    try {
      res = await poll(world, 'biller', { cursors: { 'bill-items': null, bills: null } });
    } finally {
      world.spy.intercept = null;
    }
    expect(written).toBeDefined();
    expect(res.statusCode).toBe(200);
    const { results } = JSON.parse(res.body) as { results: { 'bill-items': PageBody; bills: PageBody } };
    const bills = new Set(results.bills.rows.map((r) => r.id as string));
    const lines = results['bill-items'].rows;
    expect(bills.has(written!.billId)).toBe(false);
    expect(lines.map((l) => l.id)).not.toContain(written!.lineId);
    // the two pages agree: every line belongs to a bill of the answer, and every bill that has lines in the database (of those that were there) has all of them in the answer
    for (const line of lines) expect(bills.has(line.bill_id as string), 'a line without its bill').toBe(true);
    const [dbLines] = await world.sql.query<any[]>('SELECT id, bill_id FROM bill_items WHERE id <> ?', [written!.lineId]);
    for (const l of dbLines) if (bills.has(l.bill_id)) expect(lines.map((x) => x.id), 'a bill without its line').toContain(l.id);
    // and the next poll has both
    const next = JSON.parse((await poll(world, 'biller', { cursors: { 'bill-items': null, bills: null } })).body).results as { 'bill-items': PageBody; bills: PageBody };
    expect(next.bills.rows.map((r) => r.id)).toContain(written!.billId);
    expect(next['bill-items'].rows.map((r) => r.id)).toContain(written!.lineId);
  });

  it('the same race the other way round (the bills are read first, the lines next) shows neither either: no line without its bill', async () => {
    let written: { billId: string; lineId: string } | undefined;
    world.spy.intercept = async (e) => {
      if (!written && /FROM `bill_items` AS src/.test(e.sql)) written = await commitBillWithLine();
    };
    let res;
    try {
      res = await poll(world, 'biller', { cursors: { bills: null, 'bill-items': null } });
    } finally {
      world.spy.intercept = null;
    }
    expect(written).toBeDefined();
    const { results } = JSON.parse(res.body) as { results: { 'bill-items': PageBody; bills: PageBody } };
    expect(results['bill-items'].rows.map((l) => l.id)).not.toContain(written!.lineId);
    expect(results.bills.rows.map((b) => b.id)).not.toContain(written!.billId);
  });

  it('negative control: the same page function at READ COMMITTED, one statement after another with no snapshot, shows a bill without its lines', async () => {
    let written: { billId: string; lineId: string } | undefined;
    world.spy.intercept = async (e) => {
      if (!written && readsBills(e.sql)) written = await commitBillWithLine();
    };
    try {
      const ctx = txContext(world.spy.pool, { requestId: randomUUID() });
      const { lines, bills } = await withRead(ctx, async (db) => ({
        lines: await readPage(db, resourceByName('bill-items')!, 'biller', { limit: 1000 }),
        bills: await readPage(db, resourceByName('bills')!, 'biller', { limit: 1000 }),
      }));
      expect(written).toBeDefined();
      expect(bills.rows.map((b) => b.id)).toContain(written!.billId); // the bill is there ...
      expect(lines.rows.map((l) => l.id)).not.toContain(written!.lineId); // ... and its line is not: this is what the snapshot prevents
    } finally {
      world.spy.intercept = null;
    }
  });

  it('a poll is read in the snapshot: its statements run between SET TRANSACTION ISOLATION LEVEL REPEATABLE READ plus START TRANSACTION READ ONLY, WITH CONSISTENT SNAPSHOT and COMMIT, on one connection', async () => {
    const from = world.spy.sent.length;
    expect((await poll(world, 'owner', { cursors: { customers: null, bills: null, 'bill-summary': null } })).statusCode).toBe(200);
    const mine = world.spy.sent.slice(from);
    const begin = mine.findIndex((s) => s.sql === 'START TRANSACTION READ ONLY, WITH CONSISTENT SNAPSHOT');
    expect(begin).toBeGreaterThan(0);
    expect(mine[begin - 1].sql).toBe('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    const end = mine.findIndex((s, i) => i > begin && s.sql === 'COMMIT');
    expect(end).toBeGreaterThan(begin);
    const inside = mine.slice(begin + 1, end);
    expect(new Set(inside.map((s) => s.thread)).size).toBe(1);
    expect(inside.filter((s) => /ORDER BY src\.updated_at/.test(s.sql))).toHaveLength(3);
    expect(inside.some((s) => /FORCE INDEX \(ix_allocations_bill\)/.test(s.sql))).toBe(true); // the figures of bill-summary are in the same snapshot
  });
});

// ------------------------------------------------------------------ the statements

describe('T-F03 / T-D11 EXPLAIN: the (updated_at, key) index serves the sync comparison of every resource (A7, C4, D19)', () => {
  it('every resource\'s page statement, with a cursor and without, is judged by the EXPLAIN test of API10 and passes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jv-sync-log-'));
    const log = installStatementLog({ dir });
    try {
      for (const r of SYNC_ROWS) {
        const key = r.name === 'settings' ? 'numbering' : randomUUID();
        const caller = r.roles.includes('staff') ? 'staff' : r.roles.includes('biller') ? 'biller' : 'owner';
        for (const q of [{}, { updated_after: '2026-10-01T00:00:00.000000Z' }, { updated_after: '2026-10-01T00:00:00.000000Z', after_key: key }] as const) {
          const res = await getPage(world, caller, r.name, { limit: 1000, ...q });
          expect(res.statusCode, `${r.name} ${JSON.stringify(q)}`).toBe(200);
        }
      }
      await log.idle();
    } finally {
      log.stop();
    }
    try {
      const entries = readStatementLog(dir).filter((e) => /\bupdated_at\s*>=?\s*\?/i.test(e.sql));
      const report = judgeLog(entries, catalogue);
      expect(report.failures).toEqual([]);
      // the plain tables: one statement text with the key, one without (>=); the settings of staff add the key list; the derived reads page the base tables bills and customers
      const tables = new Set(entries.map((e) => /FROM `(\w+)` AS src/.exec(e.sql)?.[1]));
      for (const t of ['users', 'settings', 'daily_rates', 'categories', 'subcategories', 'designs', 'skus', 'sku_private', 'customers', 'bills', 'bill_items', 'receipts', 'receipt_allocations']) expect(tables.has(t), `a sync statement for ${t}`).toBe(true);
      expect(report.ok).toBeGreaterThanOrEqual(13 * 2);
      // never SELECT *, and a key is never cast to text
      for (const e of readStatementLog(dir)) {
        expect(e.sql).not.toMatch(/SELECT\s+\*/i);
        expect(e.sql).not.toMatch(/CAST\(\s*\S*\bid\b\S*\s+AS\s+CHAR/i);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
