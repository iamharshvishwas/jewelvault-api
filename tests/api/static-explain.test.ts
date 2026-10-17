import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Connection } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDbPool, type DbPool } from '../../src/db/pool';
import { idempotent } from '../../src/db/idempotency';
import { billNumbers, ensureSeries, nextBillNo } from '../../src/db/numbers';
import { txContext, withRead, withTx } from '../../src/db/tx';
import { type Scratch, scratchDatabase } from '../helpers';
import { V, insert, uuid } from '../schema/support';
import { type Catalogue, isLocking, isSyncComparison, isWriting, judge, judgeLog, loadCatalogue, planOf, tablesOf } from './static-explain-lib';
import { POLLED_TABLES } from './static-catalogue-lib';
import { DEFAULT_LOG_DIR, installStatementLog, readStatementLog } from './statement-log';

// T-D11, part 4 (A7, D19 rule 1, C4): the EXPLAIN test. Every locking or writing statement the code sends reaches its tables through an index, and the sync comparison uses the (updated_at, key)
// index: a statement that cannot use one scans, locks what it scans, and deadlocked 12 to 32 times in 1,200 operations in the spike even with the right lock order (F1).
//
// "The statements are collected by running the suite with a statement log" (tests/api/statement-log.ts): while the suite runs, the plan of every statement that code in src/ sends is asked on the
// connection that sent it, with the real rows in place, and written to a log folder (npm run verify sets JV_STATEMENT_LOG for the suite and then judges the whole log with `npm run check:static`).
// This file (1) runs real code of src/ with the log on and judges what it logged, (2) judges a fixed list of the statements Part B will send and the sync comparison of all 13 polled tables,
// (3) shows the judge failing on a statement that scans and passing on the same statement with an index, and (4) judges the log of the whole suite when there is one.

let scratch: Scratch;
let u: Connection;
let cat: Catalogue;
const pools: DbPool[] = [];
const dirs: string[] = [];

interface Fixture {
  customer: string;
  design: string;
  sku: string;
  bill: string;
  receipt: string;
  allocation: string;
  user: string;
  session: Buffer;
  email: string;
  photo: string;
  claim: string;
}
let fx: Fixture;

beforeAll(async () => {
  scratch = await scratchDatabase('explain', { schema: true });
  u = await scratch.connect();
  cat = await loadCatalogue(u);
  // one valid chain of rows, so that a primary-key lookup finds a row and the plan names the index (a missing row says "no matching row in const table")
  const category = (await insert(u, 'categories', V.category())) as { id: string };
  const customer = (await insert(u, 'customers', V.customer())) as { id: string };
  const design = (await insert(u, 'designs', V.design(category.id))) as { id: string };
  const bill = (await insert(u, 'bills', V.bill(customer.id))) as { id: string };
  const sku = (await insert(u, 'skus', V.sku(design.id))) as { id: string };
  await insert(u, 'bill_items', V.billItem(bill.id, sku.id));
  const receipt = (await insert(u, 'receipts', V.receipt(customer.id))) as { id: string };
  const allocation = (await insert(u, 'receipt_allocations', V.allocation(receipt.id, bill.id, customer.id))) as { id: string };
  const user = V.user();
  await insert(u, 'users', user);
  const session = V.session(user.id);
  await insert(u, 'sessions', session);
  const photo = uuid();
  await insert(u, 'design_photos', { id: photo, kind: 'full', design_id: design.id, mime: 'image/jpeg', byte_size: 3, sha256: Buffer.alloc(32), bytes: Buffer.from([1, 2, 3]) });
  const claim = uuid();
  await insert(u, 'sys_idempotency', { request_id: claim, fn: 'create_bill', actor: user.id, args_hash: 'a'.repeat(64) });
  await insert(u, 'sys_counters', { series: 'bill:JV:2026', last_value: 1 });
  await insert(u, 'sys_login_attempts', { scope: 'email', slot: 17, window_start: '2026-10-15 10:00:00.000000', n: 1 });
  fx = { customer: customer.id, design: design.id, sku: sku.id, bill: bill.id, receipt: receipt.id, allocation: allocation.id, user: user.id, session: session.token_hash, email: user.email, photo, claim };
}, 120_000);

afterAll(async () => {
  await Promise.all(pools.splice(0).map((p) => p.end().catch(() => undefined)));
  await u?.end().catch(() => undefined);
  await scratch?.drop();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const logDir = () => {
  const d = mkdtempSync(join(tmpdir(), 'jv-stmtlog-'));
  dirs.push(d);
  return d;
};

describe('T-D11 the statement log: statements of src/ are caught with their plans, nothing else', () => {
  it('real code of src/ runs with the log on: the counter, the repeat-safety claim and a read of every polled table are logged, judged and fine', async () => {
    const dir = logDir();
    const log = installStatementLog({ dir });
    const pool = createDbPool(scratch.db);
    pools.push(pool);
    const ctx = (requestId = randomUUID()) => txContext(pool, { requestId, actor: { id: fx.user, role: 'biller' } });
    try {
      const series = billNumbers({ date: '2026-10-17' }, 'JV');
      await ensureSeries(ctx(), series.key);
      await withTx(ctx(), (tx) => nextBillNo(tx, series));
      const key = randomUUID();
      const claimed = await withTx(ctx(), (tx) => idempotent(tx, { key, fn: 'create_bill', route: 'create-bill', body: { total: '100.00' } }, async () => ({ ok: true })));
      expect(claimed.value).toEqual({ ok: true });
      for (const table of POLLED_TABLES) {
        const keyColumn = cat.primaryKeys.get(table)![0];
        const after = keyColumn === 'setting_key' ? '' : uuid();
        await withRead(ctx(), (db) =>
          db.rows(`SELECT \`${keyColumn}\` FROM \`${table}\` WHERE updated_at > ? OR (updated_at = ? AND \`${keyColumn}\` > ?) ORDER BY updated_at, \`${keyColumn}\` LIMIT 1000`, ['2026-10-01 00:00:00.000000', '2026-10-01 00:00:00.000000', after]),
        );
      }
      // a statement sent by the test itself, outside src/, is not logged
      await u.query('SELECT id FROM skus WHERE id = ? FOR UPDATE', [fx.sku]);
      await log.idle();
    } finally {
      log.stop();
    }
    const logged = readStatementLog(dir);
    const texts = logged.map((l) => l.sql);
    expect(texts).toContain('UPDATE sys_counters SET last_value = LAST_INSERT_ID(last_value + 1) WHERE series = ?');
    expect(texts).toContain('SELECT fn, actor, args_hash, claim_token, result FROM sys_idempotency WHERE request_id = ? FOR UPDATE');
    expect(texts).toContain('SELECT 1 FROM sys_counters WHERE series = ?');
    expect(texts.filter(isSyncComparison)).toHaveLength(POLLED_TABLES.length);
    expect(texts).not.toContain('SELECT id FROM skus WHERE id = ? FOR UPDATE'); // sent from the test, not from src/
    const report = judgeLog(logged, cat);
    expect(report.failures).toEqual([]);
    expect(report.ok).toBeGreaterThanOrEqual(POLLED_TABLES.length + 3);
  }, 60_000);

  it('the log holds statement text with ? and plans, never a parameter value', async () => {
    const dir = logDir();
    const log = installStatementLog({ dir });
    const pool = createDbPool(scratch.db);
    pools.push(pool);
    const marker = `marker-${randomUUID()}`;
    try {
      await withTx(txContext(pool, { requestId: randomUUID(), actor: { id: fx.user, role: 'biller' } }), (tx) => tx.rows('SELECT id FROM customers WHERE name = ?', [marker]));
      await log.idle();
    } finally {
      log.stop();
    }
    const text = readdirSync(dir).map((f) => readFileSync(join(dir, f), 'utf8')).join('');
    expect(text).toContain('SELECT id FROM customers WHERE name = ?');
    expect(text).not.toContain(marker);
    expect(text).not.toContain(fx.user);
  }, 60_000);

  it('the log does not change what the statements do: results, insertId and affectedRows are the same with it on', async () => {
    const dir = logDir();
    const log = installStatementLog({ dir });
    const pool = createDbPool(scratch.db);
    pools.push(pool);
    try {
      const out = await withTx(txContext(pool, { requestId: randomUUID(), actor: { id: fx.user, role: 'biller' } }), async (tx) => {
        const ok = await tx.run('UPDATE sys_counters SET last_value = LAST_INSERT_ID(last_value + 1) WHERE series = ?', ['bill:JV:2026']);
        const rows = await tx.rows<{ one: number }>('SELECT 1 AS one FROM sys_counters WHERE series = ?', ['bill:JV:2026']);
        return { affected: ok.affectedRows, insertId: Number(ok.insertId), rows: rows.length };
      });
      await log.idle();
      expect(out.affected).toBe(1);
      expect(out.insertId).toBeGreaterThan(1);
      expect(out.rows).toBe(1);
    } finally {
      log.stop();
    }
  }, 60_000);
});

describe('T-D11 every locking or writing statement uses an index, and the sync comparison uses the (updated_at, key) index (D19, C4)', () => {
  const statements = (): [string, string, unknown[]][] => {
    const a = fx.customer;
    const b = fx.sku;
    return [
      ['lock the customer (X0 item 3)', 'SELECT id FROM customers WHERE id = ? FOR UPDATE', [fx.customer]],
      ['lock the pieces by id ascending (X0 item 5)', 'SELECT id, status FROM skus WHERE id IN (?, ?) ORDER BY id FOR UPDATE', [a, b]],
      ['mark pieces Sold (K2)', "UPDATE skus SET status = 'Sold', sold_bill_id = ? WHERE id IN (?, ?) AND status = 'In Stock' AND sold_bill_id IS NULL", [fx.bill, fx.sku, b]],
      ['free the pieces of a cancelled bill by their ids', "UPDATE skus SET status = 'In Stock', sold_bill_id = NULL WHERE id IN (?, ?) AND sold_bill_id = ?", [fx.sku, b, fx.bill]],
      ['find the pieces of a bill through the bill', 'SELECT id FROM skus WHERE sold_bill_id = ? FOR UPDATE', [fx.bill]],
      ['claim a request id', 'SELECT claim_token, result FROM sys_idempotency WHERE request_id = ? FOR UPDATE', [fx.claim]],
      ['take a number', 'UPDATE sys_counters SET last_value = LAST_INSERT_ID(last_value + 1) WHERE series = ?', ['bill:JV:2026']],
      ['lock a bill', 'SELECT id, status, customer_id FROM bills WHERE id = ? FOR UPDATE', [fx.bill]],
      ['oldest pending bills first (Y3)', "SELECT id FROM bills WHERE customer_id = ? AND status = 'active' ORDER BY bill_date, created_at, id FOR UPDATE", [a]],
      ['lines of a bill, locked', 'SELECT id FROM bill_items WHERE bill_id = ? FOR UPDATE', [fx.bill]],
      ['release the allocations of a cancelled bill', 'UPDATE receipt_allocations SET released_at = ? WHERE bill_id = ?', ['2026-10-15 10:00:00.000000', fx.bill]],
      ['allocations of a receipt, locked', 'SELECT id FROM receipt_allocations WHERE receipt_id = ? FOR UPDATE', [fx.receipt]],
      ['receipts of a customer, locked', "SELECT id FROM receipts WHERE customer_id = ? AND status = 'active' ORDER BY paid_on, created_at, id FOR UPDATE", [a]],
      ['void a receipt', "UPDATE receipts SET status = 'voided' WHERE id = ?", [fx.receipt]],
      ['look up a piece by barcode or number', 'SELECT id FROM skus WHERE barcode = ? OR sku_no = ? FOR UPDATE', ['x', 'y']],
      ['look up a user by e-mail (login)', 'SELECT id FROM users WHERE email = ? FOR UPDATE', [fx.email]],
      ['look up a session by token hash', 'SELECT id FROM sessions WHERE token_hash = ?', [fx.session]],
      ['revoke a session', 'UPDATE sessions SET revoked_at = ? WHERE token_hash = ?', ['2026-10-15 10:00:00.000000', fx.session]],
      ['count one login attempt', 'UPDATE sys_login_attempts SET n = n + 1 WHERE scope = ? AND slot = ?', ['email', 17]],
      ['one customer\'s balance reads receipt_allocations by customer_id (D19)', 'SELECT SUM(al.amount) FROM receipt_allocations al WHERE al.customer_id = ? AND al.released_at IS NULL FOR UPDATE', [a]],
      ['audit trail of one row', 'SELECT id FROM audit_log WHERE table_name = ? AND row_id = ?', ['bills', fx.bill]],
      ['photos of a design, locked', 'SELECT id, kind FROM design_photos WHERE design_id = ? FOR UPDATE', [fx.design]],
      ['one photo by id and kind', 'SELECT bytes FROM design_photos WHERE id = ? AND kind = ?', [fx.photo, 'full']],
    ];
  };

  it('has a list of statements that is not empty, and most of them lock or write', () => {
    const s = statements();
    expect(s.length).toBeGreaterThanOrEqual(20);
    expect(s.filter(([, sql]) => isLocking(sql) || isWriting(sql)).length).toBeGreaterThanOrEqual(18);
  });

  it('uses an index for each one: no scan without an index that could serve the statement', async () => {
    for (const [what, sql, params] of statements()) {
      const plan = await planOf(u, sql, params);
      const v = judge({ sql, plan }, cat);
      expect(v, `${what}: ${sql}`).toMatchObject({ status: 'ok' });
    }
  });

  it.each(POLLED_TABLES)('the sync comparison of %s uses the (updated_at, key) index', async (table) => {
    const k = cat.primaryKeys.get(table)![0];
    const sql = `SELECT \`${k}\` FROM \`${table}\` WHERE updated_at > ? OR (updated_at = ? AND \`${k}\` > ?) ORDER BY updated_at, \`${k}\` LIMIT 1000`;
    expect(isSyncComparison(sql)).toBe(true);
    const plan = await planOf(u, sql, ['2026-10-01 00:00:00.000000', '2026-10-01 00:00:00.000000', k === 'setting_key' ? '' : uuid()]);
    const v = judge({ sql, plan }, cat);
    expect(v).toMatchObject({ status: 'ok' });
    expect(plan[0].key === null || plan[0].key.startsWith('ix_'), `${table} uses ${plan[0].key}`).toBe(true);
  });

  describe('control: the judge finds what it is for', () => {
    it('an UPDATE whose WHERE column has no index scans the table: found; the same UPDATE by primary key passes', async () => {
      const scans = 'UPDATE bills SET notes = ? WHERE notes = ?';
      const v = judge({ sql: scans, plan: await planOf(u, scans, ['a', 'b']) }, cat);
      expect(v.status).toBe('fail');
      if (v.status === 'fail') expect(v.problems[0]).toMatch(/^bills: read by a full (index|table) scan with no index that could serve it/);
      const keyed = 'UPDATE bills SET notes = ? WHERE id = ?';
      expect(judge({ sql: keyed, plan: await planOf(u, keyed, ['a', fx.bill]) }, cat).status).toBe('ok');
    });

    it('a SELECT ... FOR UPDATE on an unindexed column is found; a plain read of it is not judged (only locking and writing statements are)', async () => {
      const locks = 'SELECT id FROM customers WHERE notes = ? FOR UPDATE';
      expect(judge({ sql: locks, plan: await planOf(u, locks, ['a']) }, cat).status).toBe('fail');
      const reads = 'SELECT id FROM customers WHERE notes = ?';
      expect(judge({ sql: reads, plan: await planOf(u, reads, ['a']) }, cat)).toEqual({ status: 'ok', checked: [] });
    });

    it('a write that joins an unindexed column through INSERT ... SELECT is found', async () => {
      const sql = 'INSERT INTO sys_idempotency (request_id, fn, actor, args_hash, claim_token) SELECT ?, ?, ?, ?, id FROM customers WHERE notes = ?';
      const plan = await planOf(u, sql, [uuid(), 'f', fx.user, 'a'.repeat(64), 'n']);
      expect(isWriting(sql)).toBe(true);
      expect(judge({ sql, plan }, cat).status).toBe('fail');
    });

    it('the sync comparison is found when the table has no (updated_at, key) index, and when the comparison is on a column that has none', async () => {
      const sql = 'SELECT id FROM skus WHERE updated_at > ? OR (updated_at = ? AND id > ?) ORDER BY updated_at, id LIMIT 1000';
      const plan = await planOf(u, sql, ['2026-10-01 00:00:00.000000', '2026-10-01 00:00:00.000000', uuid()]);
      expect(judge({ sql, plan }, cat).status).toBe('ok');
      const without: Catalogue = { ...cat, indexes: new Map([...cat.indexes].map(([t, list]) => [t, t === 'skus' ? list.filter((i) => i.name !== 'ix_skus_updated') : list])) };
      const v = judge({ sql, plan }, without);
      expect(v).toEqual({ status: 'fail', problems: ['skus: no index on (updated_at, id) for the sync comparison'] });
      const other = 'SELECT id FROM bills WHERE notes > ? OR (notes = ? AND id > ?) ORDER BY updated_at, id LIMIT 1000';
      expect(isSyncComparison(other)).toBe(false);
    });

    it('a row that does not exist makes a vacuous plan ("no matching row"): it is counted, never taken for a pass or a failure; a table of another schema is skipped', async () => {
      const sql = 'SELECT s.id FROM skus s JOIN designs d ON d.id = s.design_id WHERE s.id = ? FOR UPDATE';
      const plan = await planOf(u, sql, [uuid()]);
      expect(judge({ sql, plan }, cat).status).toBe('vacuous');
      expect(judge({ sql: 'UPDATE toy_table SET a = ? WHERE a = ?', plan: [] }, cat)).toEqual({ status: 'skipped', why: 'a table of another schema: toy_table' });
    });

    it('tablesOf reads the tables and aliases a statement names', () => {
      expect(tablesOf('SELECT s.id FROM skus s JOIN designs AS d ON d.id = s.design_id WHERE s.id = ? FOR UPDATE')).toEqual([{ table: 'skus', alias: 's' }, { table: 'designs', alias: 'd' }]);
      expect(tablesOf('UPDATE sys_counters SET last_value = 1 WHERE series = ?')).toEqual([{ table: 'sys_counters', alias: 'sys_counters' }]);
      expect(tablesOf('INSERT INTO a (x) SELECT y FROM b WHERE z = (SELECT MAX(z) FROM c)').map((t) => t.table)).toEqual(['a', 'b', 'c']);
      expect(tablesOf('INSERT INTO t (a) VALUES (?) ON DUPLICATE KEY UPDATE a = ?').map((t) => t.table)).toEqual(['t']);
    });
  });
});

describe('T-D11 the statement log of the whole suite', () => {
  const dir = process.env.JV_STATEMENT_LOG ?? DEFAULT_LOG_DIR;
  const required = process.env.JV_REQUIRE_STATEMENT_LOG === '1';

  it.skipIf(!required && !process.env.JV_STATEMENT_LOG)('every statement of src/ that the suite ran uses an index where it must (npm run verify writes the log, npm run check:static judges it)', () => {
    const logged = readStatementLog(dir);
    if (required) expect(logged.length, `no statement log in ${dir}: run npm run verify (the suite writes the log, this judges it)`).toBeGreaterThan(20);
    const report = judgeLog(logged, cat);
    console.log(`[T-D11] statement log: ${report.total} statements of src/ from the suite; ${report.ok} use an index as required, ${report.vacuous} found no row when they ran, ${report.skipped} belong to a test's own tables, ${report.failures.length} fail`);
    expect(report.failures).toEqual([]);
  });
});
