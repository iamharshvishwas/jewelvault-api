import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Reader } from '../../src/db/tx';
import { buildReview } from '../../src/domain/review';
import { JvError } from '../../src/errors';
import { runNightlyCheck } from '../../src/jobs/nightly';
import { limits } from '../../src/limits';
import { NO_GRANTS, grantsOf } from '../../src/permissions/grants';
import { RATE_REVIEW, READ_COLUMNS, STAFF_SETTING_KEYS } from '../../src/permissions/matrix';
import { BUILTIN_TICKS, TICK_KEYS, type TickKey, closeOverNeeds } from '../../src/permissions/ticks';
import { readAuditLog } from '../../src/reads/auditLog';
import { readColumns } from '../../src/reads/columns';
import { checkRange, readDailyTotals } from '../../src/reads/dailyTotals';
import { readHealthLists } from '../../src/reads/health';
import { readLedger } from '../../src/reads/ledger';
import { readPage } from '../../src/sync/page';
import { resourceByName } from '../../src/sync/resources';
import { V, insert } from '../schema/support';
import type { World } from './cells';
import { type EditWorld, editWorld } from './edit-support';
import { csrfHeaders } from './support';
import { type Fixture, syncWorld } from './sync-support';
import { TODAY, addRate } from './x01-support';

// Task 9 of the access plan (R4, R7, R8; DESIGN.md 6.2, 6.3, P2): the read side asks the PERSON'S ticks (`auth.user.grants`, read from the database on every request), not the role's name: the cash book (the window of
// days), the settings keys, the audit log, the health lines, the derived reads, the columns of every sync page, the poll (each resource it is asked for) and the nightly review of rates. Until this task these readers were
// handed the session's role KEY, which the matrix resolved through the three built-in sets: a custom role passed the gate on its ticks and was refused again by the reader, and a built-in role whose row had been
// narrowed in SQL still read what its built-in set allows.
//
// The roles here are CUSTOM: a key that is none of owner, biller and staff, made with World.addRole, holding exactly closeOverNeeds(ticks) (the role as the API would save it). The three built-in roles are covered by
// the sync-*, derived-reads, health-route and nightly-review tests, which stay as they were. The reads world is the scratch database of the sync tests (real routes, seeds, the ledger fixture, a clock fixed at
// 17 Oct 2026 10:00 UTC = 15:30 in Kolkata, so today is 2026-10-17 and yesterday 2026-10-16); the review has a world of its own. The second check each reader makes of the grants it is handed (X0 item 2), which
// the routes cannot show because the gate answers first, is asked directly with Grants and no database, in the first block.

const YESTERDAY = '2026-10-16';

/** The 16 sync resources as the poll names them, in the order of the matrix: the READ_COLUMNS table each serves and the tick that opens it (null: open to everyone signed in). Typed from the plan's table "Which tick opens which matrix row". */
const RESOURCES: readonly { name: string; table: string; tick: TickKey | null }[] = [
  { name: 'users', table: 'users', tick: null },
  { name: 'settings', table: 'settings', tick: null },
  { name: 'daily-rates', table: 'daily_rates', tick: null },
  { name: 'categories', table: 'categories', tick: null },
  { name: 'subcategories', table: 'subcategories', tick: null },
  { name: 'designs', table: 'designs', tick: null },
  { name: 'skus', table: 'skus', tick: null },
  { name: 'sku-private', table: 'sku_private', tick: 'secret_weight' },
  { name: 'customers', table: 'customers', tick: 'customer_view' },
  { name: 'bills', table: 'bills', tick: 'bill_view' },
  { name: 'bill-items', table: 'bill_items', tick: 'bill_view' },
  { name: 'receipts', table: 'receipts', tick: 'bill_view' },
  { name: 'receipt-allocations', table: 'receipt_allocations', tick: 'bill_view' },
  { name: 'bill-summary', table: 'bill_summary', tick: 'bill_view' },
  { name: 'customer-balances', table: 'customer_balances', tick: 'bill_view' },
  { name: 'orders', table: 'orders', tick: 'order_view' },
];
/** The names of the resources a person holding exactly `ticks` reads: the open ones and the ones those ticks open. */
const readableBy = (ticks: readonly TickKey[]): string[] => RESOURCES.filter((r) => r.tick === null || ticks.includes(r.tick)).map((r) => r.name);
const BILL_FAMILY = RESOURCES.filter((r) => r.tick === 'bill_view').map((r) => r.name);

interface Person {
  userId: string;
  cookie: string;
  roleKey: string;
}

const json = <T = any>(res: LightMyRequestResponse): T => JSON.parse(res.body) as T;
const codeOf = (res: LightMyRequestResponse): string | undefined => json(res).error?.code;

// ------------------------------------------------------------------ the readers themselves (X0 item 2)

// The route has already checked the row of the matrix when a reader runs; each reader asks the grants it is handed once more, so a person who reaches it by another way reads nothing. The routes cannot show
// this second check (the gate answers first), so it is asked here directly, with Grants made from tick sets and no database: a reader that is handed grants without the tick refuses before it asks for a row.
describe('each reader asks the grants it is handed, a second time after the route (X0 item 2, R4)', () => {
  /** The grants of a person holding exactly these ticks, in a role that is none of the three (its key is not the Owner's). */
  const holding = (...ticks: readonly TickKey[]) => grantsOf({ roleKey: 'custom', roleTicks: ticks, isSuperAdmin: false });
  const everythingBut = (...left: readonly TickKey[]) => holding(...TICK_KEYS.filter((t) => !left.includes(t)));
  /** What a call throws as [status, code], or what it did instead. */
  const refusal = (call: () => unknown): unknown => {
    try {
      call();
    } catch (e) {
      return e instanceof JvError ? [e.status, e.code] : String(e);
    }
    return 'not refused';
  };

  it('readColumns gives the columns of a resource to grants that open its read row, and refuses every other grants (and none) with 403 JV_FORBIDDEN', () => {
    const OPENED_BY = { audit_log: ['activity_log'], check_runs: ['activity_log'], backup_runs: ['activity_log'], customer_ledger: ['bill_view'], daily_totals: ['cashbook_recent', 'cashbook_all'] } as const;
    for (const [resource, ticks] of Object.entries(OPENED_BY) as [keyof typeof OPENED_BY, readonly TickKey[]][]) {
      for (const tick of ticks) expect(readColumns(resource, holding(tick)), `${resource} for ${tick}`).toEqual(READ_COLUMNS[resource]);
      expect(refusal(() => readColumns(resource, everythingBut(...ticks))), `${resource} without ${ticks.join(' and ')}`).toEqual([403, 'JV_FORBIDDEN']);
      expect(refusal(() => readColumns(resource, NO_GRANTS)), `${resource} for no grants`).toEqual([403, 'JV_FORBIDDEN']);
      expect(readColumns(resource, grantsOf({ roleKey: 'staff', roleTicks: [], isSuperAdmin: true })), `${resource} for the flag`).toEqual(READ_COLUMNS[resource]);
    }
  });

  it('checkRange gives each window to the grants that hold it: cashbook_recent two days, cashbook_all the wide range, nothing to the rest', () => {
    const today = '2026-10-17';
    const recent = holding('cashbook_recent');
    expect(refusal(() => checkRange(recent, '2026-10-16', '2026-10-17', today))).toBe('not refused');
    expect(refusal(() => checkRange(recent, '2026-10-15', '2026-10-17', today))).toEqual([403, 'JV_FORBIDDEN']);
    expect(refusal(() => checkRange(recent, '2026-10-01', '2026-10-31', today))).toEqual([403, 'JV_FORBIDDEN']);
    const all = holding('cashbook_all');
    expect(refusal(() => checkRange(all, '2026-10-01', '2026-10-31', today))).toBe('not refused');
    expect(refusal(() => checkRange(all, '2025-09-01', '2026-10-17', today))).toEqual([422, 'JV_INVALID_INPUT']); // over the 400 days, not a refusal of the person
    for (const none of [NO_GRANTS, everythingBut('cashbook_recent', 'cashbook_all')]) {
      expect(refusal(() => checkRange(none, today, today, today))).toEqual([403, 'JV_FORBIDDEN']);
    }
  });

  it('the cash book, the audit log, the health lists and the ledger refuse grants that do not open them before they ask the database, and read for grants that do', async () => {
    const asked: string[] = [];
    const db = {
      rows: async (sql: string) => {
        asked.push(sql);
        return [];
      },
    } as unknown as Reader;
    const CUSTOMER = '00000000-0000-4000-8000-0000000000aa';
    const READERS: [string, TickKey[], (g: ReturnType<typeof holding>) => Promise<unknown>][] = [
      ['readDailyTotals', ['cashbook_recent', 'cashbook_all'], (g) => readDailyTotals(db, g, '2026-10-17', '2026-10-17')],
      ['readAuditLog', ['activity_log'], (g) => readAuditLog(db, g, {})],
      ['readHealthLists', ['activity_log'], (g) => readHealthLists(db, g, {})],
      ['readLedger', ['bill_view'], (g) => readLedger(db, g, CUSTOMER, { after: null, limit: 10 })],
    ];
    for (const [name, ticks, read] of READERS) {
      for (const none of [NO_GRANTS, everythingBut(...ticks)]) await expect(read(none), name).rejects.toMatchObject({ code: 'JV_FORBIDDEN', status: 403 });
      expect(asked, `${name} asked the database for something it must not read`).toEqual([]);
      for (const tick of ticks) {
        await read(holding(tick));
        expect(asked.length, `${name} for ${tick} reads`).toBeGreaterThan(0);
        asked.length = 0;
      }
    }
  });

  it('readPage refuses grants that do not open the resource before it asks the database for a row, and cuts the settings keys by the grants it is handed', async () => {
    const asked: { sql: string; params: readonly unknown[] }[] = [];
    const db = {
      rows: async (sql: string, params: readonly unknown[] = []) => {
        asked.push({ sql, params });
        return [];
      },
    } as unknown as Reader;
    const page = (resource: string, grants: ReturnType<typeof holding>) => readPage(db, resourceByName(resource)!, grants, { limit: 5 });
    await expect(page('customers', NO_GRANTS)).rejects.toMatchObject({ code: 'JV_FORBIDDEN', status: 403 });
    await expect(page('customers', everythingBut('customer_view'))).rejects.toMatchObject({ code: 'JV_FORBIDDEN', status: 403 });
    await expect(page('sku-private', holding('customer_view', 'bill_view'))).rejects.toMatchObject({ code: 'JV_FORBIDDEN', status: 403 });
    expect(asked, 'a refused reader asked the database for something').toEqual([]);

    await page('customers', holding('customer_view'));
    expect(asked).toHaveLength(1);

    // settings: the seven staff keys go to the statement for grants without bill_view, bill_make and settings_change, and no key list at all for the rest
    asked.length = 0;
    await page('settings', NO_GRANTS);
    await page('settings', holding('order_view', 'customer_view'));
    for (const a of asked) expect(a.params.slice(0, -1), 'the staff keys').toEqual([...STAFF_SETTING_KEYS]);
    asked.length = 0;
    for (const tick of ['bill_view', 'bill_make', 'settings_change'] as const) await page('settings', holding(tick));
    expect(asked).toHaveLength(3);
    for (const a of asked) expect(a.params, 'no key list, only the limit').toEqual([5]);
  });
});

// ------------------------------------------------------------------ the reads world

describe('the reads ask the grants of the person who calls', () => {
  let world: World;
  let data: Fixture;

  beforeAll(async () => {
    ({ world, data } = await syncWorld('accreads'));
    // the cash book of today and yesterday (the ledger fixture ends on 13 Oct): money in by Cash today, by UPI yesterday
    await insert(world.sql, 'receipts', V.receipt(data.c2.id, { amount: '500.00', mode: 'Cash', paid_on: TODAY }));
    await insert(world.sql, 'receipts', V.receipt(data.c2.id, { amount: '200.00', mode: 'UPI', paid_on: YESTERDAY }));
    // the lists of the health checks and two rows of the Activity Log
    await world.sql.query('INSERT INTO check_runs (ran_at, ok, details) VALUES (?, 1, ?)', ['2026-10-17 08:30:00.000000', JSON.stringify({ invariants: [] })]);
    await world.sql.query('INSERT INTO backup_runs (ran_at, kind, ok, bytes, detail) VALUES (?, ?, 1, 1000, ?)', ['2026-10-17 07:00:00.000000', 'db_dump', JSON.stringify({ folder: { files: 6 } })]);
    for (const [at, rowId] of [['2026-10-17 05:00:00.000001', 'r-1'], ['2026-10-17 05:00:00.000002', 'r-2']]) {
      await world.sql.query('INSERT INTO audit_log (at, actor, actor_role, request_id, table_name, row_id, action, old_row, new_row) VALUES (?, NULL, ?, NULL, ?, ?, ?, NULL, ?)', [at, 'owner', 'receipts', rowId, 'insert', JSON.stringify({ amount: '250.00' })]);
    }
  }, 180_000);
  afterAll(async () => {
    await world?.close();
  }, 60_000);

  // ---------------------------------------------------------------- people and calls

  /** A person in a custom role holding exactly closeOverNeeds(ticks): the role as the API would save it. */
  async function person(ticks: readonly TickKey[]): Promise<Person> {
    const role = await world.addRole({ ticks: closeOverNeeds(ticks) });
    const user = await world.addUser({ role: role.key });
    return { userId: user.userId, cookie: user.cookie, roleKey: role.key };
  }
  /** Every tick but these: a role the API saves as it is when none of the ticks it holds needs one of the left-out ones. */
  const everythingBut = (...left: TickKey[]): Promise<Person> => person(TICK_KEYS.filter((t) => !left.includes(t)));

  const call = (who: { cookie: string }, method: 'GET' | 'POST', url: string, payload?: unknown): Promise<LightMyRequestResponse> =>
    world.app.inject({ method, url, headers: { ...(method === 'POST' ? csrfHeaders() : {}), cookie: who.cookie }, payload: payload as object });
  const get = (who: { cookie: string }, url: string) => call(who, 'GET', url);
  const poll = (who: { cookie: string }, names: readonly string[]) => call(who, 'POST', '/v1/sync/poll', { cursors: Object.fromEntries(names.map((n) => [n, null])) });
  const readsOf = async (who: { cookie: string }): Promise<string[]> => {
    const res = await get(who, '/v1/auth/me');
    expect(res.statusCode, res.body).toBe(200);
    return json(res).user.reads as string[];
  };
  /** The statements a call sent after `from` that read a page of a sync resource: none when a refused poll read nothing. */
  const pageStatements = (from: number): string[] => world.spy.sqls().slice(from).filter((s) => / AS src\b/.test(s));
  const columnsOf = (rows: Record<string, unknown>[]): string[] => [...new Set(rows.flatMap((r) => Object.keys(r)))].sort();

  // ---------------------------------------------------------------- the sync reads, one resource at a time

  describe('GET /v1/sync/<resource>, the poll and me.reads: a custom role reads exactly the resources its ticks open, each with exactly the columns of READ_COLUMNS', () => {
    it.each([['secret_weight'], ['customer_view'], ['bill_view'], ['order_view']] as const)('%s alone: its resources are 200 with every column and nothing else, the others 403; the poll takes the same set and me.reads names it', async (tick) => {
      const who = await person([tick]);
      const mine = readableBy([tick]);
      expect(await readsOf(who)).toEqual(mine);

      for (const r of RESOURCES) {
        const res = await get(who, `/v1/sync/${r.name}?limit=1000`);
        if (mine.includes(r.name)) {
          expect(res.statusCode, `${tick} ${r.name}: ${res.body.slice(0, 200)}`).toBe(200);
          const rows = json(res).rows as Record<string, unknown>[];
          expect(rows.length, `${r.name} has rows in the fixture`).toBeGreaterThan(0);
          expect(columnsOf(rows), `${tick} ${r.name}`).toEqual([...READ_COLUMNS[r.table as keyof typeof READ_COLUMNS]].sort());
        } else {
          expect([res.statusCode, codeOf(res)], `${tick} ${r.name}`).toEqual([403, 'JV_FORBIDDEN']);
        }
      }

      // the poll takes exactly what me.reads names, and gives a page for each
      const beforeOk = world.spy.sent.length;
      const all = await poll(who, mine);
      expect(all.statusCode, all.body.slice(0, 300)).toBe(200);
      expect(Object.keys(json(all).results).sort()).toEqual([...mine].sort());
      expect(pageStatements(beforeOk).length, 'control: a poll that is answered reads one page statement for each resource').toBe(mine.length);

      // one more resource, whichever it is, refuses the whole call and reads nothing
      const before = world.spy.sent.length;
      for (const r of RESOURCES.filter((x) => !mine.includes(x.name))) {
        const res = await poll(who, [...mine, r.name]);
        expect([res.statusCode, codeOf(res), json(res).results], `${tick} polls ${r.name}`).toEqual([403, 'JV_FORBIDDEN', undefined]);
      }
      expect(pageStatements(before)).toEqual([]);
    });

    it('bill_view is wider than customer_view and the other way round: a role with bill_view reads the six bills resources and not the customers, and reads the ledger of a customer; customer_view alone reads no ledger', async () => {
      const bills = await person(['bill_view']);
      expect(await readsOf(bills)).toEqual(expect.arrayContaining(BILL_FAMILY));
      expect(await readsOf(bills)).not.toContain('customers');
      const ledger = await get(bills, `/v1/customers/${data.c1.id}/ledger`);
      expect(ledger.statusCode, ledger.body).toBe(200);
      const rows = json(ledger).rows as Record<string, unknown>[];
      expect(rows.length).toBeGreaterThan(0);
      expect(columnsOf(rows)).toEqual([...READ_COLUMNS.customer_ledger].sort());
      expect([(await get(bills, '/v1/sync/customers')).statusCode, codeOf(await poll(bills, ['bills', 'customers']))]).toEqual([403, 'JV_FORBIDDEN']);

      const customers = await person(['customer_view']);
      expect((await get(customers, '/v1/sync/customers')).statusCode).toBe(200);
      for (const name of BILL_FAMILY) expect((await get(customers, `/v1/sync/${name}`)).statusCode, name).toBe(403);
      const refused = await get(customers, `/v1/customers/${data.c1.id}/ledger`);
      expect([refused.statusCode, codeOf(refused)]).toEqual([403, 'JV_FORBIDDEN']);
    });
  });

  // ---------------------------------------------------------------- 1. the cash book

  describe('the cash book (daily_totals): the window of days follows the ticks', () => {
    const totals = (who: { cookie: string }, from: string, to: string) => get(who, `/v1/daily-totals?from=${from}&to=${to}`);
    const tuples = (res: LightMyRequestResponse) => (json(res).rows as Record<string, unknown>[]).map((r) => [r.business_date, r.mode, r.money_in, r.money_out, r.net]);
    const daysBefore = (date: string, n: number): string => new Date(Date.parse(date) - (n - 1) * 86_400_000).toISOString().slice(0, 10);

    it('cashbook_recent reads today and yesterday and nothing earlier: any range that goes outside the two days is 403, naming the days that are open, before the cash book is read', async () => {
      const who = await person(['cashbook_recent']);
      const beforeOk = world.spy.sent.length;
      const both = await totals(who, YESTERDAY, TODAY);
      expect(both.statusCode, both.body).toBe(200);
      expect(world.spy.sqls().slice(beforeOk).some((s) => /\breceipts\b/i.test(s)), 'control: an answered read of the cash book names receipts').toBe(true);
      expect(tuples(both)).toEqual([
        [YESTERDAY, 'UPI', '200.00', '0.00', '200.00'],
        [TODAY, 'Cash', '500.00', '0.00', '500.00'],
      ]);
      expect(tuples(await totals(who, TODAY, TODAY))).toEqual([[TODAY, 'Cash', '500.00', '0.00', '500.00']]);
      expect(tuples(await totals(who, YESTERDAY, YESTERDAY))).toEqual([[YESTERDAY, 'UPI', '200.00', '0.00', '200.00']]);

      const before = world.spy.sent.length;
      for (const [from, to] of [
        ['2026-10-15', TODAY], // three days
        ['2026-10-01', '2026-10-31'], // a month
        ['2026-10-09', '2026-10-10'], // two days, but not today and yesterday
        ['2026-10-15', '2026-10-15'], // the day before yesterday
        [TODAY, '2026-10-18'], // reaches into the future
        [daysBefore(TODAY, limits.dailyTotalsMaxDays), TODAY], // the widest range
      ]) {
        const res = await totals(who, from, to);
        expect([res.statusCode, codeOf(res), json(res).error?.details], `${from}..${to}`).toEqual([403, 'JV_FORBIDDEN', { earliest: YESTERDAY, latest: TODAY }]);
      }
      expect(world.spy.sqls().slice(before).filter((s) => /\breceipts\b/i.test(s)), 'a refused range read the cash book').toEqual([]);
    });

    it('cashbook_all reads the wide window: a month and 400 days are 200, 401 days is 422 on `to`', async () => {
      const who = await person(['cashbook_all']); // closed over its need, cashbook_recent
      const month = await totals(who, '2026-10-01', '2026-10-31');
      expect(month.statusCode, month.body).toBe(200);
      const days = tuples(month).map((t) => t[0]);
      expect(days).toContain('2026-10-02'); // far outside the two days of cashbook_recent
      expect(days).toContain(TODAY);
      expect((await totals(who, daysBefore(TODAY, limits.dailyTotalsMaxDays), TODAY)).statusCode).toBe(200);
      const long = await totals(who, daysBefore(TODAY, limits.dailyTotalsMaxDays + 1), TODAY);
      expect([long.statusCode, codeOf(long), json(long).error?.details?.field]).toEqual([422, 'JV_INVALID_INPUT', 'to']);
    });

    it('neither tick is 403 at the gate, whatever the other ticks are, and the cash book is not read', async () => {
      const before = world.spy.sent.length;
      for (const who of [await person([]), await person(['bill_view', 'customer_view']), await everythingBut('cashbook_recent', 'cashbook_all')]) {
        for (const [from, to] of [[TODAY, TODAY], [YESTERDAY, TODAY], ['2026-10-01', '2026-10-31']]) {
          const res = await totals(who, from, to);
          expect([res.statusCode, codeOf(res)], `${who.roleKey} ${from}..${to}`).toEqual([403, 'JV_FORBIDDEN']);
        }
      }
      expect(world.spy.sqls().slice(before).filter((s) => /\breceipts\b/i.test(s))).toEqual([]);
    });
  });

  // ---------------------------------------------------------------- 2. the settings keys

  describe('settings: the keys a person reads follow bill_view, bill_make and settings_change', () => {
    const keysOf = async (who: { cookie: string }): Promise<string[]> => {
      const res = await get(who, '/v1/sync/settings?limit=1000');
      expect(res.statusCode, res.body).toBe(200);
      return (json(res).rows as { setting_key: string }[]).map((r) => r.setting_key).sort();
    };

    it('a role with any of bill_view, bill_make, settings_change reads every key; a role with none reads only the seven staff keys, by GET and by poll', async () => {
      const [stored] = await world.sql.query<any[]>('SELECT setting_key FROM settings ORDER BY setting_key');
      const every = stored.map((r) => r.setting_key as string);
      expect(every.length).toBeGreaterThan(STAFF_SETTING_KEYS.length); // the seeds hold more keys than the seven
      for (const tick of ['bill_view', 'bill_make', 'settings_change'] as const) {
        const who = await person([tick]);
        expect(await keysOf(who), tick).toEqual(every);
        const polled = json(await poll(who, ['settings'])).results.settings.rows as { setting_key: string }[];
        expect(polled.map((r) => r.setting_key).sort(), `${tick} by poll`).toEqual(every);
      }
      for (const ticks of [[], ['order_view'], ['customer_view'], ['stock_add', 'stock_edit'], ['cashbook_all'], ['rate_enter', 'rate_correct'], ['secret_weight']] as TickKey[][]) {
        const who = await person(ticks);
        expect(await keysOf(who), JSON.stringify(ticks)).toEqual([...STAFF_SETTING_KEYS].sort());
        const polled = json(await poll(who, ['settings'])).results.settings.rows as { setting_key: string }[];
        expect(polled.map((r) => r.setting_key).sort(), `${JSON.stringify(ticks)} by poll`).toEqual([...STAFF_SETTING_KEYS].sort());
      }
    });
  });

  // ---------------------------------------------------------------- 3. the audit log, the health checks, the dashboard line

  describe('the audit log, the health checks and the dashboard health line need activity_log', () => {
    const URLS = ['/v1/audit-log', '/v1/health/checks', '/v1/dashboard/health'] as const;

    it('a role holding activity_log (with the four ticks it needs) reads all three, with exactly the columns of READ_COLUMNS', async () => {
      expect(closeOverNeeds(['activity_log'])).toEqual(['secret_weight', 'customer_view', 'bill_view', 'order_view', 'activity_log']);
      const who = await person(['activity_log']);
      const beforeOk = world.spy.sent.length;
      const audit = await get(who, '/v1/audit-log');
      expect(audit.statusCode, audit.body).toBe(200);
      expect((json(audit).rows as { row_id: string }[]).map((r) => r.row_id)).toEqual(expect.arrayContaining(['r-1', 'r-2']));
      for (const row of json(audit).rows) expect(Object.keys(row).sort()).toEqual([...READ_COLUMNS.audit_log].sort());
      const checks = await get(who, '/v1/health/checks');
      expect(checks.statusCode, checks.body).toBe(200);
      for (const row of json(checks).check_runs) expect(Object.keys(row).sort()).toEqual([...READ_COLUMNS.check_runs].sort());
      for (const row of json(checks).backup_runs) expect(Object.keys(row).sort()).toEqual([...READ_COLUMNS.backup_runs].sort());
      expect(json(checks).check_runs.length).toBeGreaterThanOrEqual(1);
      expect(json(checks).backup_runs.length).toBeGreaterThanOrEqual(1);
      const line = await get(who, '/v1/dashboard/health');
      expect(line.statusCode, line.body.slice(0, 300)).toBe(200);
      expect(['red', 'amber', 'green']).toContain(json(line).level);
      // control for the "nothing is read" test below: the same pattern finds every one of these when the calls are answered
      const sent = world.spy.sqls().slice(beforeOk);
      for (const re of [/\baudit_log\b/i, /\bcheck_runs\b/i, /\bbackup_runs\b/i, /SHOW GRANTS/i, /ANALYZE/i]) expect(sent.some((s) => re.test(s)), String(re)).toBe(true);
    });

    it('a role with every other tick, the four activity_log needs included, is 403 on all three and nothing is read', async () => {
      const without = await everythingBut('activity_log');
      const needsOnly = await person(['secret_weight', 'customer_view', 'bill_view', 'order_view']);
      const before = world.spy.sent.length;
      for (const who of [without, needsOnly]) {
        for (const url of URLS) {
          const res = await get(who, url);
          expect([res.statusCode, codeOf(res)], `${who.roleKey} ${url}`).toEqual([403, 'JV_FORBIDDEN']);
        }
      }
      expect(world.spy.sqls().slice(before).filter((s) => /\b(audit_log|check_runs|backup_runs)\b|SHOW GRANTS|ANALYZE/i.test(s))).toEqual([]);
    });
  });

  // ---------------------------------------------------------------- 4. the poll

  describe('the poll asks the REAL grants of the person for each resource it is asked for (C4)', () => {
    it('the poll refuses the whole call, with nothing read, when one resource is not the person\'s: the open ones named beside it are not answered either', async () => {
      const who = await person(['customer_view']);
      const before = world.spy.sent.length;
      for (const names of [['users', 'customers', 'bills'], ['bills'], ['skus', 'sku-private'], ['orders', 'users'], ['users', 'settings', 'customers', 'daily-rates', 'orders']]) {
        const res = await poll(who, names);
        expect([res.statusCode, codeOf(res), json(res).results], names.join(',')).toEqual([403, 'JV_FORBIDDEN', undefined]);
      }
      expect(pageStatements(before)).toEqual([]);
      // the same person, asking only for what it may read, is answered, and that poll does read pages (control for the matcher above)
      const beforeOk = world.spy.sent.length;
      expect((await poll(who, ['users', 'customers', 'daily-rates'])).statusCode).toBe(200);
      expect(pageStatements(beforeOk)).toHaveLength(3);
    });

    it('what the poll reads follows the role row as it is NOW: narrowing a role takes resources away on the next call, widening gives them', async () => {
      const role = await world.addRole({ ticks: BUILTIN_TICKS.biller }); // a copy of the Biller
      const who = await world.addUser({ role: role.key });
      const setTicks = (ticks: readonly string[]) => world.sql.query('UPDATE roles SET ticks = ? WHERE role_key = ?', [JSON.stringify(ticks), role.key]);
      const billerReads = RESOURCES.map((r) => r.name).filter((n) => n !== 'sku-private');
      expect(await readsOf(who)).toEqual(billerReads);
      expect((await poll(who, billerReads)).statusCode).toBe(200);

      // bill_view taken away in SQL: the bills resources are refused on the very next poll, the rest still read
      await setTicks(BUILTIN_TICKS.biller.filter((t) => t !== 'bill_view'));
      const narrower = billerReads.filter((n) => !BILL_FAMILY.includes(n));
      expect(await readsOf(who)).toEqual(narrower);
      for (const name of BILL_FAMILY) {
        const res = await poll(who, [name]);
        expect([res.statusCode, codeOf(res)], name).toEqual([403, 'JV_FORBIDDEN']);
      }
      expect((await poll(who, narrower)).statusCode).toBe(200);

      // secret_weight given: sku-private is read on the next poll
      await setTicks([...BUILTIN_TICKS.biller.filter((t) => t !== 'bill_view'), 'secret_weight']);
      expect((await poll(who, ['sku-private'])).statusCode).toBe(200);
      expect(await readsOf(who)).toContain('sku-private');

      // a tick key this code does not know (a later release dropped it, or a hand edit) is ignored: nothing crashes and the other ticks still read
      await setTicks(['bill_view', 'a_tick_of_a_later_release', 'customer_view']);
      const known = readableBy(['bill_view', 'customer_view']);
      expect(await readsOf(who)).toEqual(known);
      expect((await poll(who, known)).statusCode).toBe(200);
    });

    it('a built-in role whose row was narrowed in SQL gets what the row says, not what its built-in set says: the poll of bills is refused for a Biller that no longer holds bill_view', async () => {
      const [[original]] = await world.sql.query<any[]>("SELECT ticks FROM roles WHERE role_key = 'biller'");
      const text = typeof original.ticks === 'string' ? original.ticks : JSON.stringify(original.ticks);
      const biller = { cookie: world.cookieOf('biller')! };
      try {
        expect((await poll(biller, ['bills', 'orders'])).statusCode).toBe(200); // as day one
        await world.sql.query("UPDATE roles SET ticks = ? WHERE role_key = 'biller'", [JSON.stringify(['order_view'])]);
        for (const name of ['bills', 'customers', 'receipts']) {
          const res = await poll(biller, [name]);
          expect([res.statusCode, codeOf(res)], name).toEqual([403, 'JV_FORBIDDEN']);
        }
        expect((await poll(biller, ['orders', 'users'])).statusCode).toBe(200);
        expect(await readsOf(biller)).toEqual(readableBy(['order_view']));
      } finally {
        await world.sql.query("UPDATE roles SET ticks = ? WHERE role_key = 'biller'", [text]);
      }
      expect((await poll(biller, ['bills'])).statusCode).toBe(200);
    });
  });

  // ---------------------------------------------------------------- the Super Admin

  describe('the Super Admin holds every tick (R3, R4): the flag opens every read whatever the role is', () => {
    it('the Super Admin as the system makes her (role owner) and a flagged login on the Staff role read every resource, the whole cash book, every setting, the audit log and the health lines', async () => {
      const flaggedStaff = await world.addUser({ role: 'staff', superAdmin: true });
      for (const who of [{ cookie: world.cookieOf('super')! }, { cookie: flaggedStaff.cookie }]) {
        const names = RESOURCES.map((r) => r.name);
        expect(await readsOf(who)).toEqual(names);
        const all = await poll(who, names);
        expect(all.statusCode, all.body.slice(0, 300)).toBe(200);
        expect(Object.keys(json(all).results).sort()).toEqual([...names].sort());
        for (const url of ['/v1/daily-totals?from=2026-10-01&to=2026-10-31', '/v1/audit-log', '/v1/health/checks', `/v1/customers/${data.c1.id}/ledger`]) {
          const res = await get(who, url);
          expect(res.statusCode, `${url}: ${res.body.slice(0, 200)}`).toBe(200);
        }
        const [stored] = await world.sql.query<any[]>('SELECT COUNT(*) AS n FROM settings');
        expect((json(await get(who, '/v1/sync/settings?limit=1000')).rows as unknown[]).length).toBe(Number(stored[0].n));
      }
    });
  });
});

// ------------------------------------------------------------------ 5. the nightly review of rates

describe('the nightly review: the rates entered by a login whose role holds rate_enter and lacks rate_correct are checked; the Owner\'s and the Super Admin\'s are not', () => {
  let w: EditWorld;
  const entered: Record<string, string> = {};
  const people: Record<string, Person> = {};

  /** POST /v1/daily-rates for today as the cookie given; the rate and the login that entered it are noted under `name`. */
  async function enter(name: string, cookie: string, purity: string, rate: string, material = 'Gold'): Promise<void> {
    const res = await w.world.app.inject({ method: 'POST', url: '/v1/daily-rates', headers: { ...csrfHeaders(), cookie }, payload: { material, purity, rate_per_gram: rate, rate_date: TODAY } });
    expect(res.statusCode, `${name}: ${res.body}`).toBe(201);
    entered[name] = json(res).row.id as string;
  }
  const person = async (ticks: readonly TickKey[]): Promise<Person> => {
    const role = await w.world.addRole({ ticks: closeOverNeeds(ticks) });
    const user = await w.world.addUser({ role: role.key });
    return { userId: user.userId, cookie: user.cookie, roleKey: role.key };
  };

  beforeAll(async () => {
    w = await editWorld('accrevw');
    // yesterday's rates, typed in: every rate entered today moves by more than 5 percent from them
    for (const [material, purity, rate] of [['Gold', '18K', '4000.00'], ['Gold', '20K', '5000.00'], ['Gold', '12K', '1000.00'], ['Gold', '24K', '6500.00'], ['Gold', '22K', '6000.00'], ['Silver', '925', '70.00'], ['Gold', '14K', '3000.00']]) {
      await addRate(w, material, purity, rate, '2026-10-16');
    }
    people.enterOnly = await person(['rate_enter', 'order_view']);
    people.corrects = await person(['rate_correct']); // closed over its need: holds rate_enter too
    await enter('enterOnly', people.enterOnly.cookie, '18K', '4300.00'); // +7.5 %: a custom role that enters and cannot correct
    await enter('corrects', people.corrects.cookie, '20K', '6000.00'); // +20 %: it can correct, so it is not checked
    await enter('biller', w.world.cookieOf('biller')!, '12K', '900.00'); // -10 %: the Biller of day one
    await enter('owner', w.world.cookieOf('owner')!, '24K', '7000.00'); // +7.7 %
    await enter('super', w.world.cookieOf('super')!, '22K', '6600.00'); // +10 %: role owner and the flag
    const flaggedBiller = await w.world.addUser({ role: 'biller', superAdmin: true });
    await enter('flaggedBiller', flaggedBiller.cookie, '925', '80.00', 'Silver'); // +14 %: the flag holds every tick, whatever the role is
  }, 180_000);
  afterAll(async () => {
    await w?.world.close();
  }, 60_000);

  const flagged = async (date = TODAY): Promise<string[]> => {
    const conn = await w.world.app.db!.checkout();
    try {
      const review = await buildReview(conn, date);
      expect(review.counts.biller_rate_moves).toBe(review.lists.biller_rate_moves.length);
      return review.lists.biller_rate_moves.map((r) => String(r.rate_id)).sort();
    } finally {
      conn.release();
    }
  };
  const idsOf = (...names: string[]): string[] => names.map((n) => entered[n]).sort();

  it('the rule is one pair of ticks: the Owner row of roles holds no tick at all (its ticks come from code) and RATE_REVIEW names the pair', async () => {
    expect(RATE_REVIEW).toEqual({ holds: 'rate_enter', lacks: 'rate_correct' });
    const [[owner]] = await w.world.sql.query<any[]>("SELECT ticks FROM roles WHERE role_key = 'owner'");
    expect(typeof owner.ticks === 'string' ? JSON.parse(owner.ticks) : owner.ticks).toEqual([]);
  });

  it('rates entered by a role that holds rate_enter and lacks rate_correct are checked (a custom role and the Biller); the rates of the Owner, of the Super Admin, of a flagged login on the Biller role and of a role that can correct are not', async () => {
    expect(await flagged()).toEqual(idsOf('enterOnly', 'biller'));
  });

  it('the nightly check lists the same rates in the row it writes, with the rate and the previous rate, and the login that entered it', async () => {
    const conn = await w.world.app.db!.checkout();
    try {
      const run = await runNightlyCheck(conn, { clock: w.world.app.clock, date: '2026-10-18' });
      expect(run.review.date).toBe(TODAY);
      expect(run.review.counts.biller_rate_moves).toBe(2);
      const list = run.review.lists.biller_rate_moves;
      expect(list.map((r) => String(r.rate_id)).sort()).toEqual(idsOf('enterOnly', 'biller'));
      expect(list.find((r) => r.rate_id === entered.enterOnly)).toMatchObject({ material: 'Gold', purity: '18K', rate_per_gram: '4300.00', previous_rate: '4000.00', previous_date: '2026-10-16', entered_by: people.enterOnly.userId });
    } finally {
      conn.release();
    }
  }, 120_000);

  it('the review follows the ticks of the role as they are now: giving the custom role rate_correct, or taking rate_enter from the Biller row, takes their rates off the list', async () => {
    const [[biller]] = await w.world.sql.query<any[]>("SELECT ticks FROM roles WHERE role_key = 'biller'");
    const billerText = typeof biller.ticks === 'string' ? biller.ticks : JSON.stringify(biller.ticks);
    const setCustom = (ticks: readonly string[]) => w.world.sql.query('UPDATE roles SET ticks = ? WHERE role_key = ?', [JSON.stringify(ticks), people.enterOnly.roleKey]);
    try {
      await setCustom(['rate_enter', 'rate_correct', 'order_view']);
      expect(await flagged()).toEqual(idsOf('biller'));
      await w.world.sql.query("UPDATE roles SET ticks = ? WHERE role_key = 'biller'", [JSON.stringify(['order_view'])]);
      expect(await flagged()).toEqual([]);
    } finally {
      await setCustom(['rate_enter', 'order_view']);
      await w.world.sql.query("UPDATE roles SET ticks = ? WHERE role_key = 'biller'", [billerText]);
    }
    expect(await flagged()).toEqual(idsOf('enterOnly', 'biller'));
  });
});
