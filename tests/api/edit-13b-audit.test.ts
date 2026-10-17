import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app';
import { MATRIX, READ_COLUMNS, WRITE_COLUMNS } from '../../src/permissions/matrix';
import { TODAY, YESTERDAY, addCustomer, addRate, patchCustomer, patchRate, postRate, putSetting, rateBody } from './edit-13b-support';
import { type EditWorld, STAMP_WIRE, auditCount, auditRows, body, editWorld } from './edit-support';
import { testConfig } from './support';

// API13b, the clauses of two tests that other tasks introduce:
//   T-D14  `audit_log` has a row, written in the same transaction, for each insert and update on the audited tables, none for an update of `updated_at` alone (rows counted and compared, on both
//          mechanisms of L1). This file: one insert and one update of a daily rate, of a setting and of a customer give ONE audit row each.
//   T-D02  the rows of the edits of rates, settings and customers are routes, and the generated test (tests/matrix.generated.test.ts) walks them for every caller.
// MECHANISMS. (a) is the generated triggers (db/optional/0910): they read the actor from the variables that withTx sets, so the routes need no line of code for it. (b) is the Node writer of
// API15 (src/db/audit.ts, JV_AUDIT_MODE=node), called from the two places marked "L1 (b)" in src/edit/engine.ts. API13b left its column as a todo; API19 made it real (as API15 did for
// tests/api/edit-audit.test.ts): the same checks run against both mechanisms, the second on a world WITHOUT the triggers. A fixture row that the test types by SQL is audited by the triggers
// (role sql) and, of course, not by the Node writer, which is only called by the API's own code.

const asJson = (v: unknown): any => (typeof v === 'string' ? JSON.parse(v) : v);
const requestId = (res: LightMyRequestResponse) => String(res.headers['x-request-id']);
const changedKeys = (before: Map<string, string>, after: Map<string, string>): string[] => [...after].filter(([k, row]) => before.get(k) !== row).map(([k]) => k);

for (const mode of ['triggers', 'node'] as const) {
  let w: EditWorld;
  beforeAll(async () => {
    w = await editWorld(mode === 'triggers' ? 'e13baudit' : 'e13bauditn', mode === 'triggers' ? { triggers: true } : { config: { auditMode: 'node' } });
  }, 120_000);
  afterAll(async () => {
    await w?.world.close();
  }, 60_000);

  const user = (caller: 'owner' | 'biller' | 'staff') => w.world.fixtures[caller].userId;

  /** The rows of a table as JSON by key: the "changed rows" of T-D14 are counted by comparing two of these. */
  async function rowsOf(table: string, key: string): Promise<Map<string, string>> {
    const [rows] = await w.world.sql.query<any[]>(`SELECT * FROM \`${table}\``);
    return new Map(rows.map((r) => [String(r[key]), JSON.stringify(r)]));
  }

  /** What a call does to one table, counted both ways: the rows that differ afterwards, and the audit rows the request wrote (found by its request id, so nothing else can be counted). */
  async function countFor(table: string, key: string, run: () => Promise<LightMyRequestResponse>) {
    const before = await rowsOf(table, key);
    const res = await run();
    const after = await rowsOf(table, key);
    const [audit] = await w.world.sql.query<any[]>('SELECT * FROM audit_log WHERE request_id = ? ORDER BY id', [requestId(res)]);
    return { res, changed: changedKeys(before, after), audit: audit as any[] };
  }

  describe(`T-D14 (API13b and API15 clause) mechanism ${mode === 'triggers' ? '(a), the generated triggers' : '(b), the Node writer of API15'}: one audit row for each changed row, in the same transaction`, () => {
    it('a daily rate: a biller\'s insert and the owner\'s correction give exactly one audit row each, with the session user, the role and the old and new row (confirmed_by included)', async () => {
      const insert = await countFor('daily_rates', 'id', () => postRate(w, 'biller', rateBody({ purity: 'A1', rate_per_gram: '7000.00' })));
      expect(insert.res.statusCode, insert.res.body).toBe(201);
      expect(insert.changed).toHaveLength(1);
      expect(insert.audit).toHaveLength(1);
      const made = body(insert.res).row;
      expect(insert.audit[0]).toMatchObject({ table_name: 'daily_rates', row_id: made.id, action: 'insert', actor: user('biller'), actor_role: 'biller', old_row: null });
      expect(asJson(insert.audit[0].new_row)).toMatchObject({ id: made.id, purity: 'A1', rate_per_gram: '7000.00', rate_date: TODAY, confirmed_by: user('biller'), created_by: user('biller') });

      const update = await countFor('daily_rates', 'id', () => patchRate(w, 'owner', made.id, made.updated_at, { rate_per_gram: '7100.00' }));
      expect(update.res.statusCode, update.res.body).toBe(200);
      expect(update.changed).toEqual([made.id]);
      expect(update.audit).toHaveLength(1);
      expect(update.audit[0]).toMatchObject({ table_name: 'daily_rates', row_id: made.id, action: 'update', actor: user('owner'), actor_role: 'owner' });
      expect(asJson(update.audit[0].old_row)).toMatchObject({ rate_per_gram: '7000.00', confirmed_by: user('biller') });
      expect(asJson(update.audit[0].new_row)).toMatchObject({ rate_per_gram: '7100.00', confirmed_by: user('owner'), updated_by: user('owner') });
    });

    it('a setting: the insert of a new key and the update of an existing one give exactly one audit row each, the row id is the key; the same value again gives none', async () => {
      const insert = await countFor('settings', 'setting_key', () => putSetting(w, 'owner', 'audit_demo', { value: { a: 1 } }));
      expect(insert.res.statusCode, insert.res.body).toBe(201);
      expect(insert.changed).toEqual(['audit_demo']);
      expect(insert.audit).toHaveLength(1);
      expect(insert.audit[0]).toMatchObject({ table_name: 'settings', row_id: 'audit_demo', action: 'insert', actor: user('owner'), actor_role: 'owner', old_row: null });
      expect(asJson(asJson(insert.audit[0].new_row).value)).toEqual({ a: 1 });

      const update = await countFor('settings', 'setting_key', () => putSetting(w, 'owner', 'audit_demo', { value: { a: 2, b: [1] } }));
      expect(update.res.statusCode, update.res.body).toBe(200);
      expect(update.changed).toEqual(['audit_demo']);
      expect(update.audit).toHaveLength(1);
      expect(update.audit[0]).toMatchObject({ table_name: 'settings', row_id: 'audit_demo', action: 'update', actor_role: 'owner' });
      expect(asJson(asJson(update.audit[0].old_row).value)).toEqual({ a: 1 });
      expect(asJson(asJson(update.audit[0].new_row).value)).toEqual({ a: 2, b: [1] });

      const same = await countFor('settings', 'setting_key', () => putSetting(w, 'owner', 'audit_demo', { value: { b: [1], a: 2 } }));
      expect(same.res.statusCode).toBe(200);
      expect([same.changed.length, same.audit.length]).toEqual([0, 0]);
    });

    it('a seeded setting is updated with one audit row too', async () => {
      const update = await countFor('settings', 'setting_key', () => putSetting(w, 'owner', 'numbering', { value: { designPadding: 6, skuPadding: 3, barcodePrefix: 'BC' } }));
      expect(update.res.statusCode, update.res.body).toBe(200);
      expect(update.changed).toEqual(['numbering']);
      expect(update.audit).toHaveLength(1);
      expect(update.audit[0]).toMatchObject({ table_name: 'settings', row_id: 'numbering', action: 'update' });
    });

    it('a customer: its insert (made here by SQL, as the import does; X6 is in x06-create-customer.test.ts) is one row with the role sql in mode (a) and none in mode (b), an edit by a biller is one more, and the owner\'s archive is one more', async () => {
      const before = await auditCount(w);
      const id = await addCustomer(w);
      expect(await auditCount(w)).toBe(before + (mode === 'triggers' ? 1 : 0)); // typed by hand, role sql: only the triggers see that
      expect((await auditRows(w, 'customers', id)).map((r) => [r.action, r.actor_role])).toEqual(mode === 'triggers' ? [['insert', 'sql']] : []);

      const update = await countFor('customers', 'id', () => patchCustomer(w, 'biller', id, STAMP_WIRE, { name: 'Audited', mobile: '9811111111', notes: 'three columns' }));
      expect(update.res.statusCode, update.res.body).toBe(200);
      expect(update.changed).toEqual([id]);
      expect(update.audit).toHaveLength(1); // three columns changed: still one row
      expect(update.audit[0]).toMatchObject({ table_name: 'customers', row_id: id, action: 'update', actor: user('biller'), actor_role: 'biller' });
      expect(asJson(update.audit[0].old_row)).toMatchObject({ name: 'Fixture Customer', mobile: '9876543210' });
      expect(asJson(update.audit[0].new_row)).toMatchObject({ name: 'Audited', mobile: '9811111111', notes: 'three columns', updated_by: user('biller') });

      const archive = await countFor('customers', 'id', () => patchCustomer(w, 'owner', id, body(update.res).row.updated_at, { archived_at: '2026-10-17T10:00:00.000000Z' }));
      expect(archive.res.statusCode, archive.res.body).toBe(200);
      expect(archive.changed).toEqual([id]);
      expect(archive.audit).toHaveLength(1);
      expect(archive.audit[0]).toMatchObject({ table_name: 'customers', row_id: id, action: 'update', actor_role: 'owner' });
      expect(asJson(archive.audit[0].old_row).archived_at).toBeNull();
      expect(asJson(archive.audit[0].new_row).archived_at).not.toBeNull();
    });

    it('a refused, stale, unknown, forbidden or no-change call changes no row and writes no audit row (changed rows 0, audit rows 0)', async () => {
      const rate = await addRate(w, { purity: 'A9', rate_date: TODAY });
      const old = await addRate(w, { purity: 'A9', rate_date: YESTERDAY });
      const customer = await addCustomer(w, { notes: 'same' });
      const calls: [string, string, string, number, () => Promise<LightMyRequestResponse>][] = [
        ['rate: a biller yesterday', 'daily_rates', 'id', 422, () => postRate(w, 'biller', rateBody({ purity: 'A8', rate_date: YESTERDAY }))],
        ['rate: a duplicate', 'daily_rates', 'id', 422, () => postRate(w, 'owner', rateBody({ purity: 'A9', rate_date: TODAY }))],
        ['rate: staff', 'daily_rates', 'id', 403, () => postRate(w, 'staff', rateBody({ purity: 'A7' }))],
        ['rate: confirmed_by sent', 'daily_rates', 'id', 422, () => postRate(w, 'owner', { ...rateBody({ purity: 'A6' }), confirmed_by: user('staff') })],
        ['rate: stale', 'daily_rates', 'id', 409, () => patchRate(w, 'owner', rate, '2026-09-30T00:00:00.000000Z', { rate_per_gram: '1.00' })],
        ['rate: an older row', 'daily_rates', 'id', 409, () => patchRate(w, 'owner', old, STAMP_WIRE, { rate_per_gram: '1.00' })],
        ['rate: a biller corrects', 'daily_rates', 'id', 403, () => patchRate(w, 'biller', rate, STAMP_WIRE, { rate_per_gram: '1.00' })],
        ['rate: nothing changes', 'daily_rates', 'id', 200, () => patchRate(w, 'owner', rate, STAMP_WIRE, { rate_per_gram: '6920.00' })],
        ['setting: a biller', 'settings', 'setting_key', 403, () => putSetting(w, 'biller', 'numbering', { value: { designPadding: 1, skuPadding: 1, barcodePrefix: 'X' } })],
        ['setting: last_pulled', 'settings', 'setting_key', 403, () => putSetting(w, 'owner', 'last_pulled', { value: { at: 'x' } })],
        ['setting: a bad prefix', 'settings', 'setting_key', 422, () => putSetting(w, 'owner', 'estimate', { value: { prefix: 'A:B', roundOff: true } })],
        ['customer: a biller archives', 'customers', 'id', 403, () => patchCustomer(w, 'biller', customer, STAMP_WIRE, { archived_at: '2026-10-17T10:00:00.000000Z' })],
        ['customer: a bad pan', 'customers', 'id', 422, () => patchCustomer(w, 'biller', customer, STAMP_WIRE, { pan: 'abcde1234f' })],
        ['customer: stale', 'customers', 'id', 409, () => patchCustomer(w, 'biller', customer, '2026-09-30T00:00:00.000000Z', { name: 'Late' })],
        ['customer: nothing changes', 'customers', 'id', 200, () => patchCustomer(w, 'biller', customer, STAMP_WIRE, { notes: 'same' })],
      ];
      for (const [what, table, key, status, run] of calls) {
        const { res, changed, audit } = await countFor(table, key, run);
        expect(res.statusCode, `${what}: ${res.body.slice(0, 120)}`).toBe(status);
        expect([what, changed.length, audit.length]).toEqual([what, 0, 0]);
      }
    });

    it('a failed insert (the day\'s rate is taken) leaves no audit row either, and no audit row of these tables holds a hash, a token or a password (L1 exclude list)', async () => {
      expect((await postRate(w, 'owner', rateBody({ purity: 'B1' }))).statusCode).toBe(201);
      const before = await auditCount(w);
      expect((await postRate(w, 'owner', rateBody({ purity: 'B1' }))).statusCode).toBe(422);
      expect(await auditCount(w)).toBe(before);
      const [rows] = await w.world.sql.query<any[]>("SELECT old_row, new_row FROM audit_log WHERE table_name IN ('daily_rates', 'settings', 'customers')");
      expect(rows.length).toBeGreaterThan(5);
      for (const r of rows) expect(`${r.old_row ?? ''}${r.new_row ?? ''}`).not.toMatch(/hash|token|password/i);
    });
  });

  if (mode === 'node') {
    describe('T-D14 (API13b and API15 clause) mechanism (b): the world has no audit triggers, and the rows come from the Node writer alone, one per changed row and never two', () => {
      it('no trigger is installed, the API says the mode and the database agree, and a rate, a setting and a customer each give exactly one row from the writer (the row id of a setting is its key)', async () => {
        const [t] = await w.world.sql.query<any[]>("SELECT COUNT(*) AS n FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = DATABASE() AND TRIGGER_NAME LIKE 'trg_audit%'");
        expect(Number((t as any[])[0].n)).toBe(0);
        const rate = await countFor('daily_rates', 'id', () => postRate(w, 'owner', rateBody({ purity: 'N1' })));
        const setting = await countFor('settings', 'setting_key', () => putSetting(w, 'owner', 'node_demo', { value: { a: 1 } }));
        const customerId = await addCustomer(w);
        const customer = await countFor('customers', 'id', () => patchCustomer(w, 'biller', customerId, STAMP_WIRE, { notes: 'node writer' }));
        for (const [what, made, table, rowId] of [
          ['rate', rate, 'daily_rates', body(rate.res).row.id],
          ['setting', setting, 'settings', 'node_demo'],
          ['customer', customer, 'customers', customerId],
        ] as const) {
          expect(made.res.statusCode, `${what}: ${made.res.body.slice(0, 100)}`).toBeLessThan(300);
          expect(made.changed, what).toHaveLength(1);
          expect(made.audit, what).toHaveLength(1);
          expect(made.audit[0], what).toMatchObject({ table_name: table, row_id: rowId, request_id: requestId(made.res) });
        }
      });
    });
  }
}

describe('T-D02 (API13b clause) the rows of the edits of rates, settings and customers are routes, and the matrix and the engine agree on their columns', () => {
  const ACTIONS = ['edit:daily_rates.insert', 'edit:daily_rates.update', 'edit:settings.update', 'edit:customers.update'] as const;

  it('each of the four edit rows of this task has a route registered through route(), and the generated test walks it', async () => {
    const app = buildApp({ config: testConfig({ logLevel: 'silent' }) });
    await app.ready();
    const routed = new Set(app.routeTable.map((r) => r.action));
    await app.close();
    for (const action of ACTIONS) {
      expect(routed.has(action), action).toBe(true);
      expect(MATRIX[action].kind).toBe('edit');
    }
  });

  it('each column a role may send has a FieldSpec (otherwise a call would end in a 500) and each FieldSpec is on some role\'s list (otherwise it is dead code); every column is a column of the table', async () => {
    const { DAILY_RATES } = await import('../../src/edit/rates');
    const { SETTINGS } = await import('../../src/edit/settings');
    const { CUSTOMERS } = await import('../../src/edit/customers');
    for (const t of [DAILY_RATES, SETTINGS, CUSTOMERS]) {
      const actions = new Set([t.update, t.insert].filter((a): a is NonNullable<typeof a> => a !== undefined));
      const listed = new Set<string>();
      for (const action of actions) {
        for (const c of Object.values(WRITE_COLUMNS[action] as Record<string, readonly string[]>).flat()) {
          expect(Object.hasOwn(t.fields, c), `${action}.${c}`).toBe(true);
          expect(READ_COLUMNS[t.table as 'customers'].owner, `${t.table}.${c} is a column`).toContain(c);
          listed.add(c);
        }
      }
      for (const c of Object.keys(t.fields)) expect(listed.has(c), `${t.table}.${c}`).toBe(true);
    }
  });
});
