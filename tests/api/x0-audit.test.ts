import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AUDITED_TABLES, buildAuditTriggersSql, loadExcludeList, readAuditShape } from '../../scripts/audit-triggers.mjs';
import { AUDIT_SHAPES, type AuditShape, auditChange, auditMechanismProblem, auditRowJson } from '../../src/db/audit';
import type { AuditMode } from '../../src/config';
import type { Param } from '../../src/db/stmt';
import { type Tx, txContext, withRead, withTx } from '../../src/db/tx';
import { V } from '../schema/support';
import { type X0World, rowOf, x0World } from './x0-support';

// T-D14 (API15 clause), L1 mechanism (b): the Node writer of src/db/audit.ts produces the same audit rows as the generated triggers (mechanism (a)), for a toy table that has every column type of the
// audited tables and for the 13 audited tables themselves; none for an update that changes nothing but updated_at or only an excluded column (D23, D16); never a hash. "Never both": a database with
// the triggers must not be run in node mode (auditMechanismProblem says so). The edit routes in node mode are in tests/api/edit-audit.test.ts.

const ACTOR = { id: '11111111-1111-4111-8111-111111111111', role: 'biller' };
const STAMP = '2026-10-01 08:30:15.123457';
const STAMP2 = '2026-10-02 09:00:00.000000';

let withTriggers: X0World;
let plain: X0World;
beforeAll(async () => {
  withTriggers = await x0World('x0auda', { optional: true });
  plain = await x0World('x0audb');
}, 180_000);
afterAll(async () => {
  await withTriggers?.close();
  await plain?.close();
}, 60_000);

const asJson = (v: unknown): any => (typeof v === 'string' ? JSON.parse(v) : v);

/** The rows audit_log holds for a table, in order, as plain data (JSON parsed). */
async function auditOf(w: X0World, table: string, rowId?: string) {
  const [rows] = await w.root.query<any[]>(`SELECT action, actor, actor_role, request_id, row_id, old_row, new_row FROM ${w.db()}.audit_log WHERE table_name = ? AND (? IS NULL OR row_id = ?) ORDER BY id`, [table, rowId ?? null, rowId ?? null]);
  return (rows as any[]).map((r) => ({ action: r.action, actor: r.actor, actor_role: r.actor_role, request_id: r.request_id, row_id: r.row_id, old_row: asJson(r.old_row), new_row: asJson(r.new_row) }));
}

/** A shape for the Node writer from the live catalogue, in the form of src/db/audit (the toy tables are not in AUDIT_SHAPES). */
async function shapeOf(w: X0World, table: string, exclude: string[] = []): Promise<AuditShape> {
  const live = (await readAuditShape(w.u, [table]))[table];
  const [prec] = await w.root.query<any[]>("SELECT COLUMN_NAME AS c, DATETIME_PRECISION AS p FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND DATA_TYPE = 'datetime'", [w.scratch.database, table]);
  const p = new Map((prec as any[]).map((r) => [r.c as string, Number(r.p)]));
  return {
    primaryKey: live.primary_key,
    exclude,
    columns: live.columns.map((c: { name: string; type: string; json: boolean }) => ({ name: c.name, type: c.type, ...(c.json ? { json: true } : {}), ...(c.type === 'datetime' ? { precision: p.get(c.name) } : {}) })),
  };
}

const q = (name: string) => `\`${name}\``;
async function insertRow(tx: Tx, table: string, shape: AuditShape, row: Record<string, unknown>) {
  const cols = Object.keys(row);
  const params = cols.map((c) => (row[c] !== null && typeof row[c] === 'object' && !Buffer.isBuffer(row[c]) ? JSON.stringify(row[c]) : row[c])) as Param[];
  await tx.run(`INSERT INTO ${q(table)} (${cols.map(q).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, params);
  const pk = shape.primaryKey[0];
  const after = (await tx.rows(`SELECT * FROM ${q(table)} WHERE ${q(pk)} = ?`, [row[pk] as Param]))[0];
  return auditChange(tx, { table, action: 'insert', before: null, after, shape });
}
async function updateRow(tx: Tx, table: string, shape: AuditShape, id: string, set: Record<string, unknown>) {
  const pk = shape.primaryKey[0];
  const before = (await tx.rows(`SELECT * FROM ${q(table)} WHERE ${q(pk)} = ?`, [id]))[0];
  const cols = Object.keys(set);
  const params = cols.map((c) => (set[c] !== null && typeof set[c] === 'object' && !Buffer.isBuffer(set[c]) ? JSON.stringify(set[c]) : set[c])) as Param[];
  await tx.run(`UPDATE ${q(table)} SET ${cols.map((c) => `${q(c)} = ?`).join(', ')} WHERE ${q(pk)} = ?`, [...params, id]);
  const after = (await tx.rows(`SELECT * FROM ${q(table)} WHERE ${q(pk)} = ?`, [id]))[0];
  return auditChange(tx, { table, action: 'update', before, after, shape });
}

describe('T-D14 (API15 clause) the shapes in src/db/auditShapes are the catalogue and the exclude list', () => {
  it('the 13 audited tables, their columns in order, types, JSON columns, DATETIME precision, primary keys and the exclude list equal the migrated database and db/optional/audit-exclude.json', async () => {
    const live = await readAuditShape(plain.u, AUDITED_TABLES);
    const exclude = loadExcludeList();
    expect(Object.keys(AUDIT_SHAPES)).toEqual(AUDITED_TABLES);
    for (const t of AUDITED_TABLES) {
      const mine = await shapeOf(plain, t, exclude[t] ?? []);
      expect(AUDIT_SHAPES[t], t).toEqual(mine);
      expect(AUDIT_SHAPES[t].columns.map((c) => c.name), t).toEqual(live[t].columns.map((c: { name: string }) => c.name));
      expect(AUDIT_SHAPES[t].primaryKey, t).toEqual(live[t].primary_key);
    }
    expect(AUDIT_SHAPES.users.exclude).toEqual(['password_hash']);
  });
});

describe('T-D14 (API15 clause) mechanism (b) equals mechanism (a) on a toy table with every kind of column', () => {
  const DDL = (name: string) => `CREATE TABLE ${name} (
    id UUID NOT NULL, label VARCHAR(60) NOT NULL, note TEXT NULL, qty INT NOT NULL DEFAULT 0, flag TINYINT(1) NOT NULL DEFAULT 0, big BIGINT NOT NULL DEFAULT 0,
    amount DECIMAL(14,2) NOT NULL DEFAULT 0.00, weight DECIMAL(12,3) NOT NULL DEFAULT 0.000, day DATE NULL, seen_at DATETIME(6) NULL, meta JSON NULL, secret_hash VARCHAR(64) NULL,
    twice INT AS (qty * 2) PERSISTENT, updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6), PRIMARY KEY (id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`;

  /** The same eight steps against one table, in one transaction, in the mode given. Returns how many audit rows the Node writer reports for each step. */
  async function steps(w: X0World, table: string, mode: AuditMode, requestId: string, shape: AuditShape): Promise<boolean[]> {
    const ids = [IDS.a, IDS.b];
    return withTx(txContext(w.pool, { requestId, actor: ACTOR, auditMode: mode }), async (tx) => {
      const wrote: boolean[] = [];
      wrote.push(
        await insertRow(tx, table, shape, {
          id: ids[0], label: 'Ring ₹ "quoted" \\ é 😀', note: 'first', qty: 3, flag: 1, big: '9007199254740993', amount: '0.10', weight: '12.500', day: '2026-10-01', seen_at: '2026-10-01 08:30:15',
          meta: { b: [1, 2, 3], a: { x: null, y: 'é' }, n: 1.5 }, secret_hash: 'abc', updated_at: STAMP,
        }),
      );
      wrote.push(await insertRow(tx, table, shape, { id: ids[1], label: 'Minimal', updated_at: STAMP }));
      wrote.push(await updateRow(tx, table, shape, ids[0], { label: 'Renamed', updated_at: STAMP2 }));
      wrote.push(await updateRow(tx, table, shape, ids[0], { updated_at: '2026-10-03 00:00:00.000001' })); // nothing but updated_at: no row (D23)
      wrote.push(await updateRow(tx, table, shape, ids[0], { secret_hash: 'changed', updated_at: '2026-10-03 00:00:00.000001' })); // only an excluded column: no row (D16)
      wrote.push(await updateRow(tx, table, shape, ids[0], { label: 'Renamed' })); // the same value: no change, no row
      wrote.push(await updateRow(tx, table, shape, ids[0], { amount: '1.50', weight: '0.001', meta: { b: [], c: 'text' }, flag: 0, day: null, note: null, big: '-5', seen_at: '2026-10-05 00:00:00.500000', updated_at: '2026-10-05 00:00:01.000000' }));
      wrote.push(await updateRow(tx, table, shape, ids[1], { meta: { only: true }, seen_at: '2026-10-06 10:00:00.000100', qty: 7, updated_at: STAMP2 }));
      return wrote;
    });
  }
  const IDS = { a: randomUUID(), b: randomUUID() };

  it('the same eight changes give the same audit rows in both mechanisms: six rows, none for the three no-op updates, no hash column', async () => {
    const w = withTriggers;
    const requestId = randomUUID();
    for (const t of ['toy_a', 'toy_b']) await w.u.query(DDL(t));
    // mechanism (a): the generated triggers on toy_a (the generator's own function, as the migration tool uses it)
    const sql = buildAuditTriggersSql(await readAuditShape(w.u, ['toy_a']), { toy_a: ['secret_hash'] }, ['toy_a']) as string;
    for (const stmt of sql.split('\n').filter((l) => /^(DROP|CREATE) TRIGGER/.test(l))) await w.u.query(stmt.replace(/;$/, ''));
    const shapeA = await shapeOf(w, 'toy_a', ['secret_hash']);
    const shapeB = await shapeOf(w, 'toy_b', ['secret_hash']);

    const wroteA = await steps(w, 'toy_a', 'triggers', requestId, shapeA);
    const wroteB = await steps(w, 'toy_b', 'node', requestId, shapeB);
    expect(wroteA, 'in mode triggers the writer writes nothing: the triggers do').toEqual([false, false, false, false, false, false, false, false]);
    expect(wroteB).toEqual([true, true, true, false, false, false, true, true]);

    const a = await auditOf(w, 'toy_a');
    const b = await auditOf(w, 'toy_b');
    expect(a.map((r) => r.action)).toEqual(['insert', 'insert', 'update', 'update', 'update']);
    expect(a).toHaveLength(5);
    expect(b).toEqual(a);
    for (const r of a) {
      expect(r).toMatchObject({ actor: ACTOR.id, actor_role: 'biller', request_id: requestId });
      expect(JSON.stringify([r.old_row, r.new_row])).not.toMatch(/secret_hash|twice/);
    }
    // spot checks of the values, so that "equal" is not two equal mistakes
    expect(b[0].new_row).toEqual({
      id: IDS.a, label: 'Ring ₹ "quoted" \\ é 😀', note: 'first', qty: 3, flag: 1, big: '9007199254740993', amount: '0.10', weight: '12.500', day: '2026-10-01', seen_at: '2026-10-01 08:30:15.000000',
      meta: { b: [1, 2, 3], a: { x: null, y: 'é' }, n: 1.5 }, updated_at: STAMP,
    });
    expect(b[1].new_row).toMatchObject({ note: null, day: null, seen_at: null, meta: null, qty: 0, amount: '0.00', weight: '0.000' });
    expect(b[3]).toMatchObject({ old_row: { amount: '0.10', big: '9007199254740993', flag: 1 }, new_row: { amount: '1.50', big: '-5', flag: 0, day: null, seen_at: '2026-10-05 00:00:00.500000' } });
  });

  it('mode triggers writes nothing and says false; a node-mode writer needs a shape, the right action and a complete row', async () => {
    const shape = await shapeOf(plain, 'categories', []);
    const row = { id: randomUUID(), name: 'N', prefix: 'NN', active: 1, created_at: STAMP, updated_at: STAMP, created_by: null, updated_by: null };
    const before = await rowOf(plain.root, `SELECT COUNT(*) AS n FROM ${plain.db()}.audit_log`);
    expect(await withTx(txContext(plain.pool, { requestId: randomUUID(), actor: ACTOR }), (tx) => auditChange(tx, { table: 'categories', action: 'insert', before: null, after: row }))).toBe(false);
    expect(Number((await rowOf(plain.root, `SELECT COUNT(*) AS n FROM ${plain.db()}.audit_log`)).n)).toBe(Number(before.n));
    const node = (change: Parameters<typeof auditChange>[1]) => withTx(txContext(plain.pool, { requestId: randomUUID(), actor: ACTOR, auditMode: 'node' }), (tx) => auditChange(tx, change));
    const cause = { code: 'JV_INTERNAL', cause: { name: 'TypeError' } };
    await expect(node({ table: 'no_such_table', action: 'insert', before: null, after: row })).rejects.toMatchObject(cause);
    await expect(node({ table: 'categories', action: 'update', before: null, after: row })).rejects.toMatchObject(cause);
    await expect(node({ table: 'categories', action: 'insert', before: row, after: row })).rejects.toMatchObject(cause);
    await expect(node({ table: 'categories', action: 'insert', before: null, after: { id: row.id } })).rejects.toMatchObject(cause); // a column is missing
    await expect(node({ table: 'categories', action: 'insert', before: null, after: row, rowId: randomUUID() })).rejects.toMatchObject(cause); // the id given is not the row's
    await expect(node({ table: 'daily_rates', action: 'insert', before: null, after: { ...V.dailyRate(), rate_per_gram: 6920, created_at: STAMP, updated_at: STAMP, created_by: null, updated_by: null, confirmed_by: null } })).rejects.toMatchObject(cause); // money as a JS number
    void shape;
  });

  it('a hash never reaches the JSON: the users row has no password_hash, whatever the caller passes', () => {
    const user = { ...V.user(), password_hash: 'h'.repeat(60), created_at: STAMP, updated_at: STAMP, last_login_at: null, must_change_password: 0, created_by: null, updated_by: null };
    const json = auditRowJson(AUDIT_SHAPES.users, user);
    expect(Object.keys(json)).not.toContain('password_hash');
    expect(JSON.stringify(json)).not.toContain('h'.repeat(10));
    expect(Object.keys(json)).toEqual(AUDIT_SHAPES.users.columns.filter((c) => c.name !== 'password_hash').map((c) => c.name));
  });
});

describe('T-D14 (API15 clause) the 13 audited tables: one insert and one update of each give the same rows in both mechanisms', () => {
  it('the same sequence on a database with the triggers and on one without, run in node mode', async () => {
    const cat = V.category({ name: 'Rings', prefix: 'RNG' });
    const sub = V.subcategory(cat.id, { name: 'Plain' });
    const design = V.design(cat.id, { design_no: 'D-AUD-1', tags: ['a'], photo_ids: [] });
    const sku = V.sku(design.id, { sku_no: 'S-AUD-1', barcode: 'BC-AUD-1' });
    const customer = V.customer({ name: 'Audit Customer', mobile: '9811111111' });
    const bill = V.bill(customer.id, { bill_no: 'JV-AUD-1', request_id: randomUUID() });
    const receipt = V.receipt(customer.id, {});
    const rows: [string, Record<string, unknown>, Record<string, unknown>][] = [
      ['users', V.user({ email: 'audit@example.test' }), { full_name: 'Renamed' }],
      ['settings', { setting_key: 'audit.test', value: { a: 1 } }, { value: { a: 2, b: [1] } }],
      ['daily_rates', V.dailyRate(), { rate_per_gram: '7000.00' }],
      ['categories', cat, { name: 'Rings 2' }],
      ['subcategories', sub, { name: 'Plain 2' }],
      ['designs', design, { name: 'Design 2', tags: ['b', 'c'] }],
      ['skus', sku, { location: 'Vault' }],
      ['sku_private', V.skuPrivate(sku.id), { original_net_weight: '9.250' }],
      ['customers', customer, { name: 'Audit Customer 2' }],
      ['bills', bill, { notes: 'a note' }],
      ['bill_items', V.billItem(bill.id, sku.id, {}), { category: 'Ring 2' }],
      ['receipts', receipt, { notes: 'paid' }],
      ['receipt_allocations', V.allocation(receipt.id, bill.id, customer.id, {}), { released_at: '2026-10-05 00:00:00.000000' }],
    ];
    expect(rows.map((r) => r[0])).toEqual(AUDITED_TABLES);
    const requestId = randomUUID();
    const run = (w: X0World, mode: AuditMode) =>
      withTx(txContext(w.pool, { requestId, actor: ACTOR, auditMode: mode }), async (tx) => {
        for (const [table, row, set] of rows) {
          const shape = AUDIT_SHAPES[table];
          const hasStamps = shape.columns.some((c) => c.name === 'created_at');
          await insertRow(tx, table, shape, { ...row, ...(hasStamps ? { created_at: STAMP, updated_at: STAMP } : { updated_at: STAMP }) });
          await updateRow(tx, table, shape, String(row[shape.primaryKey[0]]), { ...set, updated_at: STAMP2 });
        }
      });
    await run(withTriggers, 'triggers');
    await run(plain, 'node');
    for (const [table, row] of rows) {
      const id = String(row[AUDIT_SHAPES[table].primaryKey[0]]);
      const a = await auditOf(withTriggers, table, id); // (the fixture rows of x0World are audited too in the world with the triggers: only this row's)
      const b = await auditOf(plain, table, id);
      expect(a.map((r) => r.action), table).toEqual(['insert', 'update']);
      expect(b, table).toEqual(a);
    }
    expect(JSON.stringify(await auditOf(plain, 'users'))).not.toMatch(/password_hash/);
  });
});

describe('T-D14 (API15 clause) never both: the mode and the triggers must agree', () => {
  it('node mode on a database with the triggers, and triggers mode on one without, are named; the other two pairs are fine', async () => {
    const check = (w: X0World, mode: AuditMode) => withRead(txContext(w.pool, { requestId: randomUUID(), actor: ACTOR }), (r) => auditMechanismProblem(r, mode));
    expect(await check(withTriggers, 'triggers')).toBeNull();
    expect(await check(plain, 'node')).toBeNull();
    expect(await check(withTriggers, 'node')).toMatch(/both|twice|two rows/i);
    expect(await check(plain, 'triggers')).toMatch(/no audit|not installed|nothing/i);
  });
});
