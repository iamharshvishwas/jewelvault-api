import { randomUUID } from 'node:crypto';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadQueries } from '../../scripts/queries.mjs';
import { createClock } from '../../src/clock';
import { limits } from '../../src/limits';
import { BILLER_DAILY_TOTALS_DAYS, READ_COLUMNS, type ReadResource } from '../../src/permissions/matrix';
import { auditStatement } from '../../src/reads/auditLog';
import { dailyTotalsStatement } from '../../src/reads/dailyTotals';
import { backupRunsStatement, checkRunsStatement } from '../../src/reads/health';
import { ledgerParams, ledgerStatement } from '../../src/reads/ledger';
import { V3_TEXT, V4_TEXT } from '../../src/reads/queries';
import { V, insert } from '../schema/support';
import { CALLERS, type CallerName, T0, type World } from './cells';
import { type Fixture, bodyOf, pageAll, query, syncWorld } from './sync-support';

// API12 (A9; V1 to V4, I12): the derived reads that are not sync resources (the customer ledger, the daily totals), the audit log and the health lists of the owner, on the application's real
// routes and a scratch database with the migrations, the seeds and the ledger fixture of tests/schema/support.ts (one customer with every kind of event, the figures worked out by hand in
// tests/schema/s9-views.test.ts). The dashboard line is tests/api/health-route.test.ts, the twin of readHealth tests/api/health-twin.test.ts.
//
// The fixture clock is 17 Oct 2026 10:00 UTC = 15:30 in India: today is 2026-10-17 and yesterday 2026-10-16.

const Q = loadQueries();
const time = { micros: T0 };
const HOUR = 3_600_000_000n;
let world: World;
let data: Fixture;
let tie: { id: string };
let big: { id: string };
let tied: { id: string };

const get = (caller: CallerName, url: string) => world.call(caller, 'GET', url);
const errorOf = (res: { body: string }) => (JSON.parse(res.body) as { error?: { code: string; details?: Record<string, unknown> } }).error;
const ledgerUrl = (customer: string, q: Record<string, string | number | undefined> = {}) => `/v1/customers/${customer}/ledger${query(q)}`;
const totalsUrl = (from?: string, to?: string, extra: Record<string, string> = {}) => `/v1/daily-totals${query({ from, to, ...extra })}`;

interface LedgerRow {
  customer_id: string;
  entry_date: string;
  entry_at: string;
  kind_rank: number;
  id: string;
  kind: string;
  description: string;
  debit: string;
  credit: string;
  fine_debit: string;
  fine_credit: string;
  balance: string;
  fine_balance: string;
}
interface LedgerPage {
  rows: LedgerRow[];
  next: { after: string } | null;
}

/** What the screen does: ask, and call again with `next.after` until it is null. */
async function ledgerAll(caller: CallerName, customer: string, limit?: number): Promise<{ rows: LedgerRow[]; pages: LedgerPage[] }> {
  const pages: LedgerPage[] = [];
  const rows: LedgerRow[] = [];
  let after: string | undefined;
  for (let guard = 0; guard < 1000; guard++) {
    const res = await get(caller, ledgerUrl(customer, { limit, after }));
    if (res.statusCode !== 200) throw new Error(`GET ledger: ${res.statusCode} ${res.body.slice(0, 200)}`);
    const page = bodyOf<LedgerPage>(res);
    pages.push(page);
    rows.push(...page.rows);
    if (page.next === null) return { rows, pages };
    after = page.next.after;
  }
  throw new Error('paging did not end');
}

/** The day `n - 1` days before `date` (so that [result, date] is n days). */
function daysBefore(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d) - (n - 1) * 86_400_000).toISOString().slice(0, 10);
}

beforeAll(async () => {
  ({ world, data } = await syncWorld('derived', { clock: createClock(() => time.micros) }));
  const c2 = data.c2.id;
  // the cash book of today and yesterday (the ledger fixture ends on 13 Oct): money in, money in by UPI, a refund out
  await insert(world.sql, 'receipts', V.receipt(c2, { amount: '500.00', mode: 'Cash', paid_on: '2026-10-17' }));
  await insert(world.sql, 'receipts', V.receipt(c2, { amount: '200.00', mode: 'UPI', paid_on: '2026-10-16' }));
  await insert(world.sql, 'receipts', V.receipt(c2, { kind: 'refund', amount: '20.00', mode: 'Cash', paid_on: '2026-10-17' }));
  // a customer whose events tie on the date, the instant and the rank: only the id tells them apart (the last tie-break of the order key, V3)
  tie = (await insert(world.sql, 'customers', V.customer({ name: 'Tie Customer', mobile: '9000000011' }))) as { id: string };
  const at = '2026-10-14 06:00:00.000000';
  for (const no of ['JV-2026-0101', 'JV-2026-0102']) await insert(world.sql, 'bills', V.bill(tie.id, { bill_no: no, bill_date: '2026-10-14', subtotal: '900.00', grand_total: '900.00', created_at: at }));
  for (let i = 0; i < 6; i++) await insert(world.sql, 'receipts', V.receipt(tie.id, { amount: '10.00', mode: 'Cash', paid_on: '2026-10-14', created_at: at }));
  await insert(world.sql, 'receipts', V.receipt(tie.id, { kind: 'refund', amount: '5.00', mode: 'Cash', paid_on: '2026-10-14', created_at: at }));
  // a customer with 300 events that tie on everything but the id (silver received, which the cash book leaves out): random version-4 ids, so a tie-break that compares them as text fails
  tied = (await insert(world.sql, 'customers', V.customer({ name: 'Tied Customer', mobile: '9000000013' }))) as { id: string };
  await world.sql.query(
    `INSERT INTO receipts (id, customer_id, kind, mode, amount, fine_grams, paid_on, created_at, updated_at)
     SELECT UUID_v4(), ?, 'fine_silver', NULL, 0, 1.000, '2026-10-14', '2026-10-14 06:00:00.000000', '2026-10-14 06:00:00.000000' FROM seq_1_to_300`,
    [tied.id],
  );
  // a customer with 1,200 bills and 1,200 receipts, for the plan of the statements at some size
  big = (await insert(world.sql, 'customers', V.customer({ name: 'Big Customer', mobile: '9000000012' }))) as { id: string };
  await world.sql.query('CREATE TEMPORARY TABLE big_b (n INT PRIMARY KEY, id UUID NOT NULL) ENGINE=InnoDB');
  await world.sql.query('INSERT INTO big_b SELECT seq, UUID_v4() FROM seq_1_to_1200');
  await world.sql.query(
    `INSERT INTO bills (id, bill_no, customer_id, bill_date, doc_type, sale_type, status, pricing_version, subtotal, grand_total, round_off, fine_weight_due, created_at, updated_at)
     SELECT b.id, CONCAT('BG-', LPAD(b.n, 5, '0')), ?, DATE_ADD('2025-01-01', INTERVAL (b.n MOD 300) DAY), 'estimate', 'Retail', 'active', 1, 1000 + b.n, 1000 + b.n, 0, 0,
            TIMESTAMPADD(SECOND, b.n, '2025-01-01 05:00:00'), TIMESTAMPADD(SECOND, b.n, '2025-01-01 05:00:00') FROM big_b b`,
    [big.id],
  );
  await world.sql.query(
    `INSERT INTO receipts (id, customer_id, kind, mode, amount, paid_on, created_at, updated_at)
     SELECT UUID_v4(), ?, 'money', 'UPI', 900 + b.n, DATE_ADD('2025-01-01', INTERVAL (b.n MOD 300) DAY), TIMESTAMPADD(SECOND, b.n, '2025-01-01 05:00:01'), TIMESTAMPADD(SECOND, b.n, '2025-01-01 05:00:01') FROM big_b b`,
    [big.id],
  );
  await world.sql.query('DROP TEMPORARY TABLE big_b');
  await world.sql.query('ANALYZE TABLE bills, receipts, receipt_allocations, customers, audit_log, check_runs, backup_runs');
}, 180_000);
afterAll(async () => {
  await world?.close();
});

// ------------------------------------------------------------------ the figures of the ledger fixture, worked out by hand (tests/schema/s9-views.test.ts)

// kind, entry_date, debit, credit, fine_debit, fine_credit, running balance, running fine balance. The order key is (entry_date, entry_at, kind_rank, id).
type Expected = [string, string, string, string, string, string, string, string];
const LEDGER_C1: Expected[] = [
  ['Opening', '2026-09-30', '300.50', '0.00', '2.000', '0.000', '300.50', '2.000'],
  ['Opening advance', '2026-09-30', '0.00', '100.00', '0.000', '0.000', '200.50', '2.000'],
  ['Invoice', '2026-10-01', '1000.00', '0.00', '0.000', '0.000', '1200.50', '2.000'],
  ['Payment', '2026-10-02', '0.00', '400.00', '0.000', '0.000', '800.50', '2.000'],
  ['Invoice', '2026-10-03', '500.00', '0.00', '0.000', '0.000', '1300.50', '2.000'], // the bill that was cancelled next day: still an Invoice
  ['Payment', '2026-10-03', '0.00', '100.00', '0.000', '0.000', '1200.50', '2.000'],
  ['Cancellation', '2026-10-04', '0.00', '500.00', '0.000', '0.000', '700.50', '2.000'],
  ['Invoice', '2026-10-05', '2000.00', '0.00', '10.000', '0.000', '2700.50', '12.000'],
  ['Payment', '2026-10-06', '0.00', '600.00', '0.000', '0.000', '2100.50', '12.000'],
  ['Fine', '2026-10-07', '0.00', '0.00', '0.000', '4.000', '2100.50', '8.000'],
  ['Fine', '2026-10-08', '0.00', '0.00', '0.000', '3.000', '2100.50', '5.000'],
  ['Payment', '2026-10-09', '0.00', '150.00', '0.000', '0.000', '1950.50', '5.000'],
  ['Void', '2026-10-10', '150.00', '0.00', '0.000', '0.000', '2100.50', '5.000'],
  ['Refund', '2026-10-11', '50.00', '0.00', '0.000', '0.000', '2150.50', '5.000'],
  ['Refund', '2026-10-12', '25.00', '0.00', '0.000', '0.000', '2175.50', '5.000'],
  ['Void', '2026-10-13', '0.00', '25.00', '0.000', '0.000', '2150.50', '5.000'],
];
const asTuple = (r: LedgerRow): Expected => [r.kind, r.entry_date, r.debit, r.credit, r.fine_debit, r.fine_credit, r.balance, r.fine_balance];

/** Cash book of the whole fixture, by day and mode: [business_date, mode, money_in, money_out, net]. The first nine rows are the figures of tests/schema/s9-views.test.ts. */
const BOOK: [string, string, string, string, string][] = [
  ['2026-10-02', 'Cash', '400.00', '0.00', '400.00'],
  ['2026-10-03', 'Cash', '100.00', '0.00', '100.00'],
  ['2026-10-06', 'UPI', '600.00', '0.00', '600.00'],
  ['2026-10-08', 'Cash', '270.00', '0.00', '270.00'], // silver settled in cash is money in
  ['2026-10-09', 'Cash', '150.00', '0.00', '150.00'],
  ['2026-10-10', 'Cash', '0.00', '150.00', '-150.00'], // the void of it
  ['2026-10-11', 'Cash', '0.00', '50.00', '-50.00'],
  ['2026-10-12', 'UPI', '0.00', '25.00', '-25.00'],
  ['2026-10-13', 'UPI', '25.00', '0.00', '25.00'],
  ['2026-10-14', 'Cash', '60.00', '5.00', '55.00'], // the tie customer: six payments of 10.00, one refund of 5.00
  ['2026-10-16', 'UPI', '200.00', '0.00', '200.00'], // yesterday
  ['2026-10-17', 'Cash', '500.00', '20.00', '480.00'], // today
];
const tupleOf = (r: Record<string, unknown>) => [r.business_date, r.mode, r.money_in, r.money_out, r.net];

// ------------------------------------------------------------------ T-D18

describe('T-D18 the four derived reads are readable by the owner and a biller and refused to staff and to a caller with no session', () => {
  const four = (): { name: string; url: string }[] => [
    { name: 'bill_summary', url: '/v1/sync/bill-summary' },
    { name: 'customer_balances', url: '/v1/sync/customer-balances' },
    { name: 'customer_ledger', url: ledgerUrl(data.c1.id) },
    { name: 'daily_totals', url: totalsUrl('2026-10-16', '2026-10-17') },
  ];

  it('the owner and a biller read each of the four (200 with rows), staff get 403 JV_FORBIDDEN, no session gets 401 JV_UNAUTHENTICATED', async () => {
    for (const { name, url } of four()) {
      for (const caller of ['owner', 'biller'] as const) {
        const res = await get(caller, url);
        expect(res.statusCode, `${caller} reads ${name}`).toBe(200);
        expect(bodyOf<{ rows: unknown[] }>(res).rows.length, `${caller} reads ${name}: rows`).toBeGreaterThan(0);
      }
      const staff = await get('staff', url);
      expect([staff.statusCode, errorOf(staff)?.code], `staff read ${name}`).toEqual([403, 'JV_FORBIDDEN']);
      const anon = await get('anon', url);
      expect([anon.statusCode, errorOf(anon)?.code], `no session reads ${name}`).toEqual([401, 'JV_UNAUTHENTICATED']);
    }
  });

  it('A9: reading is wide. A biller reads every customer\'s mobile, GST and PAN and the whole ledger, the same rows as the owner; staff read none of it', async () => {
    await world.sql.query("UPDATE customers SET gst_number = '27ABCDE1234F1Z5', pan = 'ABCDE1234F' WHERE id = ?", [data.c1.id]);
    const owner = (await pageAll(world, 'owner', 'customers')).rows.find((r) => r.id === data.c1.id)!;
    const biller = (await pageAll(world, 'biller', 'customers')).rows.find((r) => r.id === data.c1.id)!;
    expect([biller.mobile, biller.gst_number, biller.pan]).toEqual(['9876543210', '27ABCDE1234F1Z5', 'ABCDE1234F']);
    expect(biller).toEqual(owner);
    expect((await get('biller', ledgerUrl(data.c1.id))).statusCode).toBe(200);
    for (const url of ['/v1/sync/customers', ledgerUrl(data.c1.id)]) expect((await get('staff', url)).statusCode, `staff read ${url}`).toBe(403);
  });

  it('every other caller of A4 is refused too: an ended, an expired and an idle session and a deactivated user are 401, a user who must change the password is 403', async () => {
    for (const { name, url } of four()) {
      for (const caller of CALLERS) {
        if (caller === 'owner' || caller === 'biller' || caller === 'staff' || caller === 'anon') continue;
        const res = await get(caller, url);
        await world.restore(caller);
        expect(res.statusCode, `${caller} reads ${name}`).toBe(caller === 'must_change' ? 403 : 401);
      }
    }
  });

  it('a biller reads the whole ledger of any customer, as the prototype did (A9, O25): the same rows as the owner', async () => {
    for (const customer of [data.c1.id, tie.id]) {
      const owner = bodyOf<LedgerPage>(await get('owner', ledgerUrl(customer)));
      const biller = bodyOf<LedgerPage>(await get('biller', ledgerUrl(customer)));
      expect(biller.rows.length).toBeGreaterThan(0);
      expect(biller).toEqual(owner);
    }
  });

  it('the four go through the query files and never a view: the ledger and the totals are db/queries V3 and V4 as a derived table, with an explicit column list, and no statement names a view', async () => {
    const before = world.spy.sent.length;
    expect((await get('biller', ledgerUrl(data.c1.id))).statusCode).toBe(200);
    expect((await get('biller', totalsUrl('2026-10-16', '2026-10-17'))).statusCode).toBe(200);
    const sqls = world.spy.sqls().slice(before);
    const ledger = sqls.find((s) => s.includes('kind_rank') && s.includes('PARTITION BY'));
    const totals = sqls.find((s) => s.includes('money_in') && s.includes('GROUP BY'));
    expect(ledger).toBeDefined();
    expect(totals).toBeDefined();
    expect(ledger).toContain(`(${Q.V3}) v`);
    expect(totals).toContain(`(${Q.V4}) v`);
    for (const s of [ledger!, totals!]) {
      expect(s).not.toMatch(/SELECT\s+\*/i);
      expect(s).not.toMatch(/\bFROM\s+(customer_ledger|daily_totals|bill_summary|customer_balances)\b/i);
    }
    expect(sqls.some((s) => /CREATE\s+(OR\s+REPLACE\s+)?VIEW/i.test(s))).toBe(false);
  });
});

describe('T-D18 GET /v1/customers/{id}/ledger: the events of one customer, in the order key of V3, with the running balance, keyset-paged', () => {
  it('the ledger of the fixture customer is the hand-computed list of 16 events, kind by kind and balance by balance', async () => {
    const res = await get('biller', ledgerUrl(data.c1.id));
    expect(res.statusCode).toBe(200);
    const page = bodyOf<LedgerPage>(res);
    expect(page.rows.map(asTuple)).toEqual(LEDGER_C1);
    expect(page.next).toBeNull(); // 16 rows, far below the page
    for (const r of page.rows) expect(r.customer_id).toBe(data.c1.id);
  });

  it('the wire format is S3: money and weight as text, ids and dates as text, the instant with six decimals and a Z, the rank a number', async () => {
    const [opening] = bodyOf<LedgerPage>(await get('owner', ledgerUrl(data.c1.id))).rows;
    expect(opening).toEqual({
      customer_id: data.c1.id,
      entry_date: '2026-09-30',
      entry_at: '2026-09-30T05:00:00.000000Z',
      kind_rank: 1,
      id: data.ob.id,
      kind: 'Opening',
      description: 'Opening balance OB-0001',
      debit: '300.50',
      credit: '0.00',
      fine_debit: '2.000',
      fine_credit: '0.000',
      balance: '300.50',
      fine_balance: '2.000',
    });
    const rows = bodyOf<LedgerPage>(await get('owner', ledgerUrl(data.c1.id))).rows;
    const cash = rows.find((r) => r.kind === 'Fine' && r.description.includes('settled in cash'));
    expect(cash?.description).toBe('Silver 3.000 g settled in cash at rate 90.00 = 270.00');
    expect(rows.find((r) => r.kind === 'Payment')?.description).toBe('Payment (Cash)');
  });

  it('the last running balance equals V2\'s balance and fine_balance for the customer, as the biller reads them (I4)', async () => {
    const rows = bodyOf<LedgerPage>(await get('biller', ledgerUrl(data.c1.id))).rows;
    const balances = bodyOf<{ rows: Record<string, unknown>[] }>(await get('biller', '/v1/sync/customer-balances')).rows;
    const mine = balances.find((b) => b.id === data.c1.id)!;
    expect([rows[rows.length - 1].balance, rows[rows.length - 1].fine_balance]).toEqual([mine.balance, mine.fine_balance]);
    expect([mine.balance, mine.fine_balance]).toEqual(['2150.50', '5.000']);
    // and the same two figures from the query file of the database half, asked directly
    const [[v2]] = await world.sql.query<any[]>(Q.V2_one, [data.c1.id]);
    expect([v2.balance, v2.fine_balance]).toEqual(['2150.50', '5.000']);
  });

  it('the rows are the rows of db/queries V3 for the customer, column for column (the query file is the oracle)', async () => {
    const [direct] = await world.sql.query<any[]>(`SELECT * FROM (${Q.V3}) v WHERE v.customer_id = ? ORDER BY v.entry_date, v.entry_at, v.kind_rank, v.id`, [data.c1.id]);
    const rows = bodyOf<LedgerPage>(await get('owner', ledgerUrl(data.c1.id))).rows;
    expect(rows.map((r) => [r.id, r.kind_rank, r.kind, r.debit, r.credit, r.balance, r.fine_balance])).toEqual(
      direct.map((r: any) => [r.id, Number(r.kind_rank), r.kind, r.debit, r.credit, r.balance, r.fine_balance]),
    );
  });

  it('five rows at a time: four pages that put together are the whole list, the last page ends the load', async () => {
    const { rows, pages } = await ledgerAll('biller', data.c1.id, 5);
    expect(pages.map((p) => p.rows.length)).toEqual([5, 5, 5, 1]);
    expect(pages.map((p) => p.next !== null)).toEqual([true, true, true, false]);
    expect(rows.map(asTuple)).toEqual(LEDGER_C1);
  });

  it('a page that is exactly full costs one more (empty) call, as in the sync reads', async () => {
    const { rows, pages } = await ledgerAll('owner', data.c1.id, 4);
    expect(pages.map((p) => p.rows.length)).toEqual([4, 4, 4, 4, 0]);
    expect(rows.map(asTuple)).toEqual(LEDGER_C1);
  });

  it('the running balance is of the whole history, not of the page: the second page starts from the balance of the first', async () => {
    const first = bodyOf<LedgerPage>(await get('owner', ledgerUrl(data.c1.id, { limit: 3 })));
    const second = bodyOf<LedgerPage>(await get('owner', ledgerUrl(data.c1.id, { limit: 3, after: first.next!.after })));
    expect(first.rows.map((r) => r.balance)).toEqual(['300.50', '200.50', '1200.50']);
    expect(second.rows.map((r) => r.balance)).toEqual(['800.50', '1300.50', '1200.50']);
  });

  it('events that tie on the date, the instant and the rank come back once each, in the order of V3, at every page size (the id is the last tie-break)', async () => {
    const [direct] = await world.sql.query<any[]>(`SELECT * FROM (${Q.V3}) v WHERE v.customer_id = ? ORDER BY v.entry_date, v.entry_at, v.kind_rank, v.id`, [tie.id]);
    expect(direct).toHaveLength(9);
    // the data bites: eight events share the date, the instant and the rank 1 or 3 (two invoices, six payments), so only the id separates them
    const groups = new Map<string, number>();
    for (const r of direct) groups.set(`${r.entry_date}|${r.entry_at}|${r.kind_rank}`, (groups.get(`${r.entry_date}|${r.entry_at}|${r.kind_rank}`) ?? 0) + 1);
    expect([...groups.values()].sort()).toEqual([1, 2, 6]);
    // the oracle: the balance by integer paise in that order
    let paise = 0;
    const expected = direct.map((r: any) => {
      paise += Math.round(Number(r.debit) * 100) - Math.round(Number(r.credit) * 100);
      return [r.id, Number(r.kind_rank), (paise / 100).toFixed(2)];
    });
    for (const limit of [1, 2, 3, 4, 8, 9, 1000]) {
      const { rows } = await ledgerAll('owner', tie.id, limit);
      expect(rows.map((r) => [r.id, r.kind_rank, r.balance]), `page size ${limit}`).toEqual(expected);
    }
    // the negative control: a cursor that kept only the date and the instant (no rank, no id) would start after ALL the tied rows and lose the six that follow the third
    const third = direct[2];
    const naive = direct.filter((r: any) => `${r.entry_date}${r.entry_at}` > `${third.entry_date}${third.entry_at}`);
    expect(direct.length - 3 - naive.length).toBe(6);
  });

  it('300 events that tie on the date, the instant and the rank, with random version-4 ids, in pages of 7 and of 1,000: every event once, in the order of V3 (the id as a UUID, never as text)', async () => {
    const [direct] = await world.sql.query<any[]>(`SELECT v.id, v.fine_balance FROM (${Q.V3}) v WHERE v.customer_id = ? ORDER BY v.entry_date, v.entry_at, v.kind_rank, v.id`, [tied.id]);
    expect(direct).toHaveLength(300);
    for (const limit of [7, 1000]) {
      const { rows } = await ledgerAll('owner', tied.id, limit);
      expect(rows.map((r) => [r.id, r.fine_balance]), `page size ${limit}`).toEqual(direct.map((r: any) => [r.id, r.fine_balance]));
    }
    expect(direct[299].fine_balance).toBe('-300.000'); // 300 times 1.000 of silver received
  });

  it('a customer with 1,200 bills and 1,200 receipts: pages of 1,000, 1,000 and 400, every event once and in the order of V3, the last balance is V2\'s', async () => {
    const { rows, pages } = await ledgerAll('biller', big.id);
    expect(pages.map((p) => p.rows.length)).toEqual([1000, 1000, 400]);
    const [direct] = await world.sql.query<any[]>(`SELECT v.kind_rank, v.id FROM (${Q.V3}) v WHERE v.customer_id = ? ORDER BY v.entry_date, v.entry_at, v.kind_rank, v.id`, [big.id]);
    expect(rows.map((r) => `${r.kind_rank}|${r.id}`)).toEqual(direct.map((r: any) => `${Number(r.kind_rank)}|${r.id}`));
    const [[v2]] = await world.sql.query<any[]>(Q.V2_one, [big.id]);
    expect([rows[rows.length - 1].balance, rows[rows.length - 1].fine_balance]).toEqual([v2.balance, v2.fine_balance]);
  });

  it('a customer with no events, and an id that is no customer, have an empty ledger (200, no rows, no next)', async () => {
    const [empty] = await world.sql.query<any[]>("SELECT id FROM customers WHERE name = 'Walk-in Customer' OR is_walkin = 1 LIMIT 1");
    for (const id of [empty[0].id as string, randomUUID()]) {
      const res = await get('owner', ledgerUrl(id));
      expect(res.statusCode).toBe(200);
      expect(bodyOf<LedgerPage>(res)).toEqual({ rows: [], next: null });
    }
  });

  it('the input is checked before the database: the id must be a UUID, the limit 1 to 1,000 (more is refused, not cut), nothing else is a key, a made-up or damaged token is refused', async () => {
    const bad = async (url: string, field: string) => {
      const res = await get('owner', url);
      expect([res.statusCode, errorOf(res)?.code, errorOf(res)?.details?.field], url).toEqual([422, 'JV_INVALID_INPUT', field]);
    };
    await bad('/v1/customers/12345/ledger', 'id');
    await bad(`/v1/customers/${data.c1.id.toUpperCase()}/ledger`, 'id');
    await bad(ledgerUrl(data.c1.id, { limit: 0 }), 'limit');
    await bad(ledgerUrl(data.c1.id, { limit: limits.syncPageRows + 1 }), 'limit');
    await bad(ledgerUrl(data.c1.id, { limit: 'ten' }), 'limit');
    await bad(ledgerUrl(data.c1.id, { limit: '1e3' }), 'limit');
    await bad(ledgerUrl(data.c1.id, { order: 'id' }), 'order');
    await bad(ledgerUrl(data.c1.id, { table: 'sessions' }), 'table');
    await bad(`${ledgerUrl(data.c1.id)}?limit=1&limit=2`, 'limit');
    const token = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
    for (const after of [
      'x',
      'not base64 !',
      token('text'),
      token(['2026-10-01', '2026-10-01 05:00:00.000000', 1]),
      token(['2026-10-01', '2026-10-01 05:00:00.000000', 1, "x' OR 1=1 -- "]),
      token(['2026-13-45', '2026-10-01 05:00:00.000000', 1, randomUUID()]),
      token(['2026-10-01', 'yesterday', 1, randomUUID()]),
      token(['2026-10-01', '2026-10-01 05:00:00.000000', 9, randomUUID()]),
      token(['2026-10-01', '2026-10-01 05:00:00.000000', '1', randomUUID()]),
      'A'.repeat(500),
    ]) {
      await bad(ledgerUrl(data.c1.id, { after }), 'after');
    }
  });

  it('a limit of exactly 1,000 and a token from an earlier page are accepted', async () => {
    const first = bodyOf<LedgerPage>(await get('owner', ledgerUrl(data.c1.id, { limit: 2 })));
    const res = await get('owner', ledgerUrl(data.c1.id, { limit: limits.syncPageRows, after: first.next!.after }));
    expect(res.statusCode).toBe(200);
    expect(bodyOf<LedgerPage>(res).rows.map(asTuple)).toEqual(LEDGER_C1.slice(2));
  });
});

// ------------------------------------------------------------------ daily totals

describe('T-D18 GET /v1/daily-totals?from=&to=: the cash book of V4 for a range of days', () => {
  it('the owner reads a month: every (date, mode) with its money in, money out and net, in date and mode order, equal to the hand-worked book and to db/queries V4', async () => {
    const res = await get('owner', totalsUrl('2026-10-01', '2026-10-31'));
    expect(res.statusCode).toBe(200);
    const rows = bodyOf<{ rows: Record<string, unknown>[] }>(res).rows;
    expect(rows.map(tupleOf)).toEqual(BOOK);
    const [direct] = await world.sql.query<any[]>(`SELECT * FROM (${Q.V4}) v WHERE v.business_date BETWEEN ? AND ? ORDER BY v.business_date, v.mode`, ['2026-10-01', '2026-10-31']);
    expect(rows.map(tupleOf)).toEqual(direct.map(tupleOf));
    // the opening advance (is_opening) is not money received today and is not in the book (D15)
    expect(rows.some((r) => r.mode === 'Other')).toBe(false);
  });

  it('a range is cut at both ends, the days are inclusive, and a day with nothing has no row', async () => {
    const one = bodyOf<{ rows: Record<string, unknown>[] }>(await get('owner', totalsUrl('2026-10-10', '2026-10-10'))).rows;
    expect(one.map(tupleOf)).toEqual([['2026-10-10', 'Cash', '0.00', '150.00', '-150.00']]);
    const none = bodyOf<{ rows: unknown[] }>(await get('owner', totalsUrl('2026-10-04', '2026-10-05'))).rows;
    expect(none).toEqual([]);
    const two = bodyOf<{ rows: Record<string, unknown>[] }>(await get('owner', totalsUrl('2026-10-12', '2026-10-13'))).rows;
    expect(two.map(tupleOf)).toEqual([BOOK[7], BOOK[8]]);
  });

  it('the sums over all days tie out with the receipts (I13)', async () => {
    const rows = bodyOf<{ rows: Record<string, unknown>[] }>(await get('owner', totalsUrl(daysBefore('2026-10-31', limits.dailyTotalsMaxDays), '2026-10-31'))).rows;
    const net = (mode: string) => rows.filter((r) => r.mode === mode).reduce((s, r) => s + Math.round(Number(r.net) * 100), 0);
    const [[cash]] = await world.sql.query<any[]>("SELECT CAST(SUM(IF(kind = 'refund', -amount, amount)) AS CHAR) AS n FROM receipts WHERE status = 'active' AND is_opening = 0 AND mode = 'Cash' AND kind IN ('money', 'fine_cash', 'refund')");
    expect(net('Cash')).toBe(Math.round(Number(cash.n) * 100));
  });

  it('the owner reads up to 400 days and no more: 400 is 200, 401 is 422 JV_INVALID_INPUT on `to`', async () => {
    const to = '2026-10-17';
    expect((await get('owner', totalsUrl(daysBefore(to, limits.dailyTotalsMaxDays), to))).statusCode).toBe(200);
    const long = await get('owner', totalsUrl(daysBefore(to, limits.dailyTotalsMaxDays + 1), to));
    expect([long.statusCode, errorOf(long)?.code, errorOf(long)?.details?.field]).toEqual([422, 'JV_INVALID_INPUT', 'to']);
    expect(limits.dailyTotalsMaxDays).toBe(400);
  });

  it('a range the wrong way round, a missing end, a date that does not exist and a key that is no part of the call are 422 and read nothing', async () => {
    const before = world.spy.sent.length;
    const cases: [string, string][] = [
      [totalsUrl('2026-10-17', '2026-10-16'), 'to'],
      [totalsUrl(undefined, '2026-10-16'), 'from'],
      [totalsUrl('2026-10-16', undefined), 'to'],
      [totalsUrl('2026-02-30', '2026-10-16'), 'from'],
      [totalsUrl('2026-10-16', '16-10-2026'), 'to'],
      [totalsUrl('2026-10-16', '2026-10-17T00:00:00Z'), 'to'],
      [totalsUrl('2026-10-16', '2026-10-17', { limit: '5' }), 'limit'],
      [totalsUrl('2026-10-16', '2026-10-17', { mode: 'Cash' }), 'mode'],
      ['/v1/daily-totals', 'from'],
    ];
    for (const [url, field] of cases) {
      const res = await get('owner', url);
      expect([res.statusCode, errorOf(res)?.code, errorOf(res)?.details?.field], url).toEqual([422, 'JV_INVALID_INPUT', field]);
    }
    expect(world.spy.sqls().slice(before).filter((s) => /business_date/.test(s))).toEqual([]);
  });
});

describe('T-D04 (API12 clause) a biller reads daily_totals for today and yesterday only; a longer range is 403 JV_FORBIDDEN (A4, A9, O25)', () => {
  const rowsOf = async (url: string) => bodyOf<{ rows: Record<string, unknown>[] }>(await get('biller', url)).rows.map(tupleOf);

  it('today and yesterday: 200, the rows of those two days only; today alone and yesterday alone too', async () => {
    expect(BILLER_DAILY_TOTALS_DAYS).toBe(2);
    expect(await rowsOf(totalsUrl('2026-10-16', '2026-10-17'))).toEqual([BOOK[10], BOOK[11]]);
    expect(await rowsOf(totalsUrl('2026-10-17', '2026-10-17'))).toEqual([BOOK[11]]);
    expect(await rowsOf(totalsUrl('2026-10-16', '2026-10-16'))).toEqual([BOOK[10]]);
  });

  it('anything longer is 403 JV_FORBIDDEN and reads nothing: three days, a month, a two-day range in the past, the day before yesterday, tomorrow, a range that reaches into the future', async () => {
    for (const [from, to] of [
      ['2026-10-15', '2026-10-17'],
      ['2026-10-01', '2026-10-31'],
      ['2026-10-09', '2026-10-10'], // two days, but not today and yesterday
      ['2026-10-15', '2026-10-15'],
      ['2026-10-10', '2026-10-10'],
      ['2026-10-18', '2026-10-18'],
      ['2026-10-17', '2026-10-18'],
      ['2026-10-16', '2026-10-18'],
      [daysBefore('2026-10-17', limits.dailyTotalsMaxDays), '2026-10-17'],
    ]) {
      const res = await get('biller', totalsUrl(from, to));
      expect([res.statusCode, errorOf(res)?.code], `${from}..${to}`).toEqual([403, 'JV_FORBIDDEN']);
      // the owner reads the same range
      expect((await get('owner', totalsUrl(from, to))).statusCode, `owner ${from}..${to}`).toBe(200);
    }
  });

  it('the refusal happens before the cash book is read: a refused biller causes no statement on receipts', async () => {
    const before = world.spy.sent.length;
    const res = await get('biller', totalsUrl('2026-10-01', '2026-10-31'));
    expect(res.statusCode).toBe(403);
    expect(world.spy.sqls().slice(before).filter((s) => /\breceipts\b/i.test(s))).toEqual([]);
  });

  it('the refusal says what is open (the two days), for the screen', async () => {
    const res = await get('biller', totalsUrl('2026-10-01', '2026-10-31'));
    expect(errorOf(res)?.details).toEqual({ earliest: '2026-10-16', latest: '2026-10-17' });
  });

  it('negative control: a rule that only counted the days (at most two) would let a biller read any two days of the past', async () => {
    const countedOnly = (from: string, to: string) => (Date.parse(to) - Date.parse(from)) / 86_400_000 + 1 <= BILLER_DAILY_TOTALS_DAYS;
    expect(countedOnly('2026-10-09', '2026-10-10')).toBe(true); // what the naive rule says
    const res = await get('biller', totalsUrl('2026-10-09', '2026-10-10'));
    expect(res.statusCode).toBe(403); // what the API says
  });
});

// ------------------------------------------------------------------ the audit log

describe('T-D18 GET /v1/audit-log: the owner reads the audit log, newest first, at most 200 a page, filtered by table and row', () => {
  const ids: number[] = [];
  const R = { bill1: randomUUID(), bill2: randomUUID(), receipt: randomUUID() };
  interface AuditRow {
    id: number;
    at: string;
    actor: string | null;
    actor_role: string | null;
    request_id: string | null;
    table_name: string;
    row_id: string;
    action: string;
    old_row: unknown;
    new_row: unknown;
  }
  interface AuditPage {
    rows: AuditRow[];
    next: { before_id: number } | null;
  }
  const audit = (q: Record<string, string | number | undefined> = {}) => `/v1/audit-log${query(q)}`;
  const page = async (q: Record<string, string | number | undefined> = {}) => bodyOf<AuditPage>(await get('owner', audit(q)));
  const actor = randomUUID();
  const request = randomUUID();

  beforeAll(async () => {
    const add = async (at: string, table: string, rowId: string, action: string, oldRow: unknown, newRow: unknown) => {
      await world.sql.query('INSERT INTO audit_log (at, actor, actor_role, request_id, table_name, row_id, action, old_row, new_row) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [
        at, action === 'event' ? null : actor, action === 'event' ? 'job' : 'owner', action === 'event' ? null : request, table, rowId, action, oldRow === null ? null : JSON.stringify(oldRow), newRow === null ? null : JSON.stringify(newRow),
      ]);
    };
    await add('2026-10-17 05:00:01.000001', 'bills', R.bill1, 'insert', null, { grand_total: '1000.00', status: 'active' });
    await add('2026-10-17 05:00:02.000002', 'bills', R.bill1, 'update', { status: 'active' }, { status: 'cancelled' });
    await add('2026-10-17 05:00:03.000003', 'customers', data.c1.id, 'update', { name: 'Ledger Customer' }, { name: 'Ledger Customer Ltd' });
    await add('2026-10-17 05:00:04.000004', 'settings', 'numbering', 'update', { value: { a: 1 } }, { value: { a: 2 } });
    await add('2026-10-17 05:00:05.000005', 'users', actor, 'event', null, { event: 'login' });
    await add('2026-10-17 05:00:06.000006', 'bills', R.bill2, 'insert', null, { grand_total: '250.00' });
    await add('2026-10-17 05:00:07.000007', 'receipts', R.receipt, 'insert', null, { amount: '250.00' });
    const [rows] = await world.sql.query<any[]>('SELECT id FROM audit_log ORDER BY id');
    ids.push(...rows.map((r: any) => Number(r.id)));
  });

  it('newest first (by id): seven rows, the last one written first, every column of A4 and nothing else, the JSON columns as JSON', async () => {
    const p = await page();
    expect(p.rows.map((r) => r.id)).toEqual([...ids].reverse());
    expect(p.next).toBeNull();
    const newest = p.rows[0];
    expect(newest).toEqual({ id: ids[ids.length - 1], at: '2026-10-17T05:00:07.000007Z', actor, actor_role: 'owner', request_id: request, table_name: 'receipts', row_id: R.receipt, action: 'insert', old_row: null, new_row: { amount: '250.00' } });
    const event = p.rows.find((r) => r.action === 'event')!;
    expect([event.actor, event.actor_role, event.request_id, event.new_row]).toEqual([null, 'job', null, { event: 'login' }]);
    const settings = p.rows.find((r) => r.table_name === 'settings')!;
    expect([settings.old_row, settings.new_row]).toEqual([{ value: { a: 1 } }, { value: { a: 2 } }]);
    for (const r of p.rows) expect(Object.keys(r).sort()).toEqual([...READ_COLUMNS.audit_log.owner!].sort());
  });

  it('pages of three: the next page starts before the last id, and the pages put together are the whole log once', async () => {
    const seen: number[] = [];
    let before: number | undefined;
    const sizes: number[] = [];
    for (let guard = 0; guard < 10; guard++) {
      const p = await page({ limit: 3, before_id: before });
      sizes.push(p.rows.length);
      seen.push(...p.rows.map((r) => r.id));
      if (p.next === null) break;
      expect(p.next.before_id).toBe(p.rows[p.rows.length - 1].id);
      before = p.next.before_id;
    }
    expect(sizes).toEqual([3, 3, 1]);
    expect(seen).toEqual([...ids].reverse());
  });

  it('filtered by table, and by table and row: still newest first, and the pages keep the filter', async () => {
    expect((await page({ table: 'bills' })).rows.map((r) => r.id)).toEqual([ids[5], ids[1], ids[0]]);
    expect((await page({ table: 'bills', row_id: R.bill1 })).rows.map((r) => r.id)).toEqual([ids[1], ids[0]]);
    const small = await page({ table: 'bills', limit: 2 });
    expect(small.rows.map((r) => r.id)).toEqual([ids[5], ids[1]]);
    expect((await page({ table: 'bills', limit: 2, before_id: small.next!.before_id })).rows.map((r) => r.id)).toEqual([ids[0]]);
    expect((await page({ table: 'nothing_here' })).rows).toEqual([]);
    expect((await page({ before_id: ids[0] })).rows).toEqual([]);
  });

  it('at most 200 a page: 200 is accepted, 201 is refused (not cut), 0 and text are refused; a row id needs its table; unknown keys and odd values are 422', async () => {
    expect(limits.ownerPageRows).toBe(200);
    expect((await get('owner', audit({ limit: 200 }))).statusCode).toBe(200);
    for (const [q, field] of [
      [{ limit: 201 }, 'limit'],
      [{ limit: 1000 }, 'limit'],
      [{ limit: 0 }, 'limit'],
      [{ limit: 'all' }, 'limit'],
      [{ row_id: R.bill1 }, 'row_id'],
      [{ before_id: 'abc' }, 'before_id'],
      [{ before_id: '-1' }, 'before_id'],
      [{ before_id: '1'.repeat(30) }, 'before_id'],
      [{ table: 'bills; select 1' }, 'table'],
      [{ table: 'a'.repeat(80) }, 'table'],
      [{ table: 'bills', row_id: 'x'.repeat(80) }, 'row_id'],
      [{ order: 'asc' }, 'order'],
      [{ columns: 'old_row' }, 'columns'],
    ] as [Record<string, string | number>, string][]) {
      const res = await get('owner', audit(q));
      expect([res.statusCode, errorOf(res)?.code, errorOf(res)?.details?.field], JSON.stringify(q)).toEqual([422, 'JV_INVALID_INPUT', field]);
    }
  });

  it('the owner alone: a biller and staff are 403 JV_FORBIDDEN and read nothing, no session is 401 (T-D04: a biller cannot read audit_log)', async () => {
    const before = world.spy.sent.length;
    for (const caller of ['biller', 'staff'] as const) {
      const res = await get(caller, audit());
      expect([res.statusCode, errorOf(res)?.code], caller).toEqual([403, 'JV_FORBIDDEN']);
    }
    expect((await get('anon', audit())).statusCode).toBe(401);
    expect(world.spy.sqls().slice(before).filter((s) => /\baudit_log\b/i.test(s))).toEqual([]);
  });
});

// ------------------------------------------------------------------ the health lists

describe('T-D18 GET /v1/health/checks: the latest check_runs and backup_runs rows, newest first, for the owner', () => {
  interface Lists {
    check_runs: Record<string, unknown>[];
    backup_runs: Record<string, unknown>[];
  }
  beforeAll(async () => {
    const check = (at: string, ok: number, details: unknown) => world.sql.query('INSERT INTO check_runs (ran_at, ok, details) VALUES (?, ?, ?)', [at, ok, JSON.stringify(details)]);
    await check('2026-10-15 20:30:00.000000', 1, { invariants: [] });
    await check('2026-10-16 20:30:00.000000', 0, { invariants: [{ invariant: 'I4', row_ref: 'x' }] });
    await check('2026-10-17 20:30:00.000000', 1, { invariants: [] });
    const backup = (at: string, kind: string, ok: number, bytes: number, detail: unknown) =>
      world.sql.query('INSERT INTO backup_runs (ran_at, kind, ok, bytes, detail) VALUES (?, ?, ?, ?, ?)', [at, kind, ok, bytes, JSON.stringify(detail)]);
    await backup('2026-10-15 21:00:00.000000', 'db_dump', 1, 1234567, { folder: { files: 3 } });
    await backup('2026-10-16 21:00:00.000000', 'photo_copy', 1, 99, { copied: 4 });
    await backup('2026-10-17 21:00:00.000000', 'db_dump', 0, 0, { error: 'no space' });
  });
  const lists = async (q: Record<string, string | number> = {}) => bodyOf<Lists>(await get('owner', `/v1/health/checks${query(q)}`));

  it('both lists, newest first, with the JSON columns as JSON, the instants on the wire format, and the columns of A4 only', async () => {
    const l = await lists();
    expect(l.check_runs.map((r) => r.ran_at)).toEqual(['2026-10-17T20:30:00.000000Z', '2026-10-16T20:30:00.000000Z', '2026-10-15T20:30:00.000000Z']);
    expect(l.check_runs.map((r) => r.ok)).toEqual([true, false, true]);
    expect(l.check_runs[1].details).toEqual({ invariants: [{ invariant: 'I4', row_ref: 'x' }] });
    expect(l.backup_runs.map((r) => [r.kind, r.ok, r.bytes])).toEqual([['db_dump', false, 0], ['photo_copy', true, 99], ['db_dump', true, 1234567]]);
    expect(l.backup_runs[0].detail).toEqual({ error: 'no space' });
    for (const r of l.check_runs) expect(Object.keys(r).sort()).toEqual([...READ_COLUMNS.check_runs.owner!].sort());
    for (const r of l.backup_runs) expect(Object.keys(r).sort()).toEqual([...READ_COLUMNS.backup_runs.owner!].sort());
  });

  it('`limit` cuts each list (default 30, at most 200); more is refused, not cut; an unknown key is 422', async () => {
    const l = await lists({ limit: 2 });
    expect([l.check_runs.length, l.backup_runs.length]).toEqual([2, 2]);
    expect((await lists({ limit: 200 })).check_runs.length).toBe(3);
    for (const q of [{ limit: 201 }, { limit: 0 }, { limit: 'many' }, { kind: 'db_dump' }]) {
      const res = await get('owner', `/v1/health/checks${query(q)}`);
      expect([res.statusCode, errorOf(res)?.code], JSON.stringify(q)).toEqual([422, 'JV_INVALID_INPUT']);
    }
  });

  it('the owner alone: a biller and staff are 403, no session is 401', async () => {
    for (const caller of ['biller', 'staff'] as const) expect((await get(caller, '/v1/health/checks')).statusCode, caller).toBe(403);
    expect((await get('anon', '/v1/health/checks')).statusCode).toBe(401);
  });
});

// ------------------------------------------------------------------ T-D02

describe('T-D02 (API12 clause) the rows of the derived reads, the audit log and the health lists hold the columns of READ_COLUMNS and no others, for every role that reads them', () => {
  const keysOf = (rows: Record<string, unknown>[]) => new Set(rows.flatMap((r) => Object.keys(r)));
  const check = (resource: ReadResource, caller: 'owner' | 'biller', rows: Record<string, unknown>[]) => {
    const allowed = READ_COLUMNS[resource][caller]!;
    expect(rows.length, `${caller} ${resource}: there are rows to check`).toBeGreaterThan(0);
    expect([...keysOf(rows)].filter((k) => !allowed.includes(k)), `${caller} ${resource}`).toEqual([]);
    expect(allowed.filter((c) => !keysOf(rows).has(c)), `${caller} ${resource}: every column of the list is sent`).toEqual([]);
  };

  it('bill_summary, customer_balances, customer_ledger and daily_totals, for the owner and a biller', async () => {
    for (const caller of ['owner', 'biller'] as const) {
      check('bill_summary', caller, bodyOf<{ rows: Record<string, unknown>[] }>(await get(caller, '/v1/sync/bill-summary')).rows);
      check('customer_balances', caller, bodyOf<{ rows: Record<string, unknown>[] }>(await get(caller, '/v1/sync/customer-balances')).rows);
      check('customer_ledger', caller, bodyOf<LedgerPage>(await get(caller, ledgerUrl(data.c1.id))).rows as unknown as Record<string, unknown>[]);
      check('daily_totals', caller, bodyOf<{ rows: Record<string, unknown>[] }>(await get(caller, totalsUrl('2026-10-16', '2026-10-17'))).rows);
    }
  });

  it('audit_log, check_runs and backup_runs for the owner', async () => {
    check('audit_log', 'owner', bodyOf<{ rows: Record<string, unknown>[] }>(await get('owner', '/v1/audit-log')).rows);
    const l = bodyOf<{ check_runs: Record<string, unknown>[]; backup_runs: Record<string, unknown>[] }>(await get('owner', '/v1/health/checks'));
    check('check_runs', 'owner', l.check_runs);
    check('backup_runs', 'owner', l.backup_runs);
  });

  it('the base row\'s updated_at is what bill_summary and customer_balances expose, so the cache refreshes a figure when a payment moves it (C4, D23)', async () => {
    const [[bill]] = await world.sql.query<any[]>("SELECT DATE_FORMAT(updated_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS u FROM bills WHERE id = ?", [data.b1.id]);
    const summary = (await pageAll(world, 'biller', 'bill-summary')).rows.find((r) => r.id === data.b1.id)!;
    expect(summary.updated_at).toBe(bill.u);
    const [[cu]] = await world.sql.query<any[]>("SELECT DATE_FORMAT(updated_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS u FROM customers WHERE id = ?", [data.c1.id]);
    const balance = bodyOf<{ rows: Record<string, unknown>[] }>(await get('biller', '/v1/sync/customer-balances')).rows.find((r) => r.id === data.c1.id)!;
    expect(balance.updated_at).toBe(cu.u);
  });
});

// ------------------------------------------------------------------ the plans, and the twins of the query files

describe('T-D18 EXPLAIN shows the indexes used by the statements of the derived reads, the audit log and the health lists (A7, D19)', () => {
  interface Plan {
    table: string | null;
    type: string | null;
    possible_keys: string | null;
    key: string | null;
    Extra: string | null;
  }
  const plan = async (sql: string, params: unknown[]): Promise<Plan[]> => {
    const [rows] = await world.sql.query<any[]>(`EXPLAIN ${sql}`, params as any[]);
    return rows as Plan[];
  };
  const L = READ_COLUMNS.customer_ledger.owner!;

  it('the ledger of one customer: the customer\'s bills and receipts are read by (customer_id, ...) in all four branches of V3, the first page and every later one', async () => {
    const first = ledgerStatement(L, false);
    const later = ledgerStatement(L, true);
    const cursor = { entryDate: '2026-10-01', entryAt: '2026-10-01 05:00:00.000000', kindRank: 1, id: data.b1.id };
    for (const [name, sql, params] of [
      ['first page', first, ledgerParams(data.c1.id, null, 1000)],
      ['later page', later, ledgerParams(data.c1.id, cursor, 1000)],
    ] as const) {
      const p = await plan(sql, [...params]);
      const bills = p.filter((r) => r.table === 'bills');
      const receipts = p.filter((r) => r.table === 'receipts');
      expect(bills.map((r) => r.key), `${name}: bills`).toEqual(['ix_bills_customer_date', 'ix_bills_customer_date']);
      expect(receipts.map((r) => r.key), `${name}: receipts`).toEqual(['ix_receipts_customer', 'ix_receipts_customer']);
      expect(p.filter((r) => r.table !== null && !r.table.startsWith('<') && r.type === 'ALL'), `${name}: no table is read whole`).toEqual([]);
    }
  });

  it('a page of the audit log: the primary key (newest first, a range before the last id), and (table_name, row_id) for a table or a row', async () => {
    const A = READ_COLUMNS.audit_log.owner!;
    const keyOf = async (f: { beforeId: boolean; table: boolean; rowId: boolean }, params: unknown[]) => (await plan(auditStatement(A, f), params))[0];
    const everything = await keyOf({ beforeId: false, table: false, rowId: false }, [200]);
    expect([everything.type, everything.key]).toEqual(['index', 'PRIMARY']); // the key read backwards, stopping at the limit
    const before = await keyOf({ beforeId: true, table: false, rowId: false }, [5, 200]);
    expect([before.type, before.key]).toEqual(['range', 'PRIMARY']);
    const byRow = await keyOf({ beforeId: true, table: true, rowId: true }, [5, 'bills', randomUUID(), 200]);
    expect(byRow.possible_keys).toContain('ix_audit_row'); // on a handful of rows the optimizer may still prefer the primary key's range
    const byTable = await keyOf({ beforeId: false, table: true, rowId: false }, ['bills', 200]);
    expect(byTable.possible_keys).toContain('ix_audit_row');
    expect(byTable.type).not.toBe('ALL');
  });

  it('the health lists read the newest runs by (ran_at) backwards, 30 rows at a time by default', async () => {
    const c = (await plan(checkRunsStatement(READ_COLUMNS.check_runs.owner!), [30]))[0];
    const b = (await plan(backupRunsStatement(READ_COLUMNS.backup_runs.owner!), [30]))[0];
    expect([c.table, c.key]).toEqual(['c', 'ix_check_runs_at']); // the plan names the table by its alias
    expect([b.table, b.key]).toEqual(['b', 'ix_backup_runs_at']);
  });

  it('the cash book reads receipts and nothing else, with the range pushed down into both branches of V4; receipts has no index on paid_on or voided_on (D19), so each branch reads the table', async () => {
    const p = await plan(dailyTotalsStatement(READ_COLUMNS.daily_totals.owner!), ['2026-10-01', '2026-10-31']);
    const tables = p.filter((r) => r.table !== null && !r.table.startsWith('<'));
    expect(tables.map((r) => r.table)).toEqual(['receipts', 'receipts']);
    for (const r of tables) expect(r.Extra, 'the range is applied inside the branch').toMatch(/Using where/);
    const [indexed] = await world.sql.query<any[]>("SELECT index_name AS i FROM information_schema.STATISTICS WHERE table_schema = DATABASE() AND table_name = 'receipts' AND column_name IN ('paid_on', 'voided_on') AND seq_in_index = 1");
    expect(indexed, 'no index starts with paid_on or voided_on: a migration would have to add one').toEqual([]);
  });
});

describe('T-D18 the query texts of the API are the files of db/queries, character for character, and the statements around them hold no value (S3, S12)', () => {
  it('V3 and V4 in src/reads/queries.ts are db/queries V3 and V4', () => {
    expect(V3_TEXT).toBe(Q.V3);
    expect(V4_TEXT).toBe(Q.V4);
  });

  it('the statements name their columns and take every value as a ?', () => {
    const sql = ledgerStatement(READ_COLUMNS.customer_ledger.biller!, true);
    expect(sql).not.toMatch(/SELECT\s+\*/i);
    expect(sql.match(/\?/g)).toHaveLength(1 + 7 + 1); // the customer, the seven values of the order key, the limit
    expect(dailyTotalsStatement(READ_COLUMNS.daily_totals.biller!).match(/\?/g)).toHaveLength(2);
    expect(ledgerStatement(READ_COLUMNS.customer_ledger.biller!, false).match(/\?/g)).toHaveLength(2);
  });
});

// ------------------------------------------------------------------ the day flips (LAST in the file: the API's clock never runs backwards, S5, so the fixture clock stays where this leaves it)

describe('T-D04 (API12 clause) the biller\'s window follows the day of the API\'s clock in India, not the UTC day', () => {
  it('at 00:30 on the 18th in India (19:00 UTC on the 17th) the window is the 17th and the 18th; the 16th is out, and the owner is not affected', async () => {
    time.micros = T0 + 9n * HOUR; // 2026-10-17T19:00Z = 2026-10-18 00:30 IST
    const ok = await get('biller', totalsUrl('2026-10-17', '2026-10-18'));
    expect(ok.statusCode).toBe(200);
    expect(bodyOf<{ rows: Record<string, unknown>[] }>(ok).rows.map(tupleOf)).toEqual([BOOK[11]]);
    const late = await get('biller', totalsUrl('2026-10-16', '2026-10-17'));
    expect([late.statusCode, errorOf(late)?.code, errorOf(late)?.details]).toEqual([403, 'JV_FORBIDDEN', { earliest: '2026-10-17', latest: '2026-10-18' }]);
    expect((await get('owner', totalsUrl('2026-10-16', '2026-10-17'))).statusCode).toBe(200);
  });
});
