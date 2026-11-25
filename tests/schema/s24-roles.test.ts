import { createHash, randomUUID } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Connection } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkSql, migrate, splitStatements } from '../../scripts/migrate.mjs';
import { BUILTIN_TICKS } from '../../src/permissions/ticks';
import { ER, type Scratch, errorOf, scratchDatabase } from '../helpers';
import { V, insert } from './support';

// R1, R3, R17 of the access plan: the table `roles` of db/migrations/0012, its three seed rows, users.is_super_admin and the foreign key fk_users_role that replaces chk_users_role, on a scratch
// database migrated by the ten-box user of A3 (no DELETE, no DROP), as on Hostinger. What the database itself refuses: a login whose role names no role, a role key of the wrong shape, two names that
// look the same, ticks that are not a JSON list, a Super Admin flag other than 0 or 1.

const FILE = new URL('../../db/migrations/0012_roles_super_admin.sql', import.meta.url);
const MIGRATIONS = new URL('../../db/migrations/', import.meta.url);
const asJson = (v: unknown) => (typeof v === 'string' ? JSON.parse(v) : v); // the driver may hand a JSON column back parsed or as text

const scratches: Scratch[] = [];
const conns: Connection[] = [];
async function open(label: string, schema: boolean) {
  const s = await scratchDatabase(label, { schema });
  scratches.push(s);
  const c = await s.connect();
  conns.push(c);
  return { s, c };
}

let c: Connection;
beforeAll(async () => {
  ({ c } = await open('s24roles', true));
  // the API's own sql_mode (src/db/pool.ts): the lane server, like Hostinger, is not strict by default, and a non-strict server cuts a key that is too long instead of refusing it
  await c.query("SET SESSION sql_mode = 'STRICT_TRANS_TABLES,ERROR_FOR_DIVISION_BY_ZERO,NO_AUTO_CREATE_USER,NO_ENGINE_SUBSTITUTION'");
}, 120_000);
afterAll(async () => {
  for (const x of conns) await x.end().catch(() => undefined);
  for (const s of scratches) await s.drop();
}, 60_000);

const role = (o: Record<string, unknown> = {}) => ({ role_key: `r${randomUUID().replace(/[^a-f]/g, '').slice(0, 8)}`, name: `Role ${randomUUID().slice(0, 8)}`, ticks: [], ...o });
const refusal = async (table: string, row: Record<string, unknown>) => (await errorOf(() => insert(c, table, row)))?.errno ?? null;

describe('s24 roles (R1, R3, R17): the migration', () => {
  it('applies on top of 0011 and again without error; its checksum is recorded', async () => {
    const text = readFileSync(FILE, 'utf8');
    const [rows] = await c.query<any[]>("SELECT version, name, checksum FROM schema_migrations WHERE version = '0012'");
    expect(rows).toEqual([{ version: '0012', name: 'roles_super_admin', checksum: createHash('sha256').update(text).digest('hex') }]);
    for (const sql of splitStatements(text)) expect(await errorOf(() => c.query(sql)), sql.slice(0, 60)).toBeNull();
    const [again] = await c.query<any[]>('SELECT COUNT(*) AS n FROM roles');
    expect(Number(again[0].n)).toBe(3);
  });

  it('seeds owner, biller and staff named Owner, Biller, Staff; biller and staff hold BUILTIN_TICKS; owner holds []', async () => {
    const [rows] = await c.query<any[]>('SELECT role_key, name, active, ticks FROM roles ORDER BY role_key');
    expect(rows.map((r) => [r.role_key, r.name, Number(r.active), asJson(r.ticks)])).toEqual([
      ['biller', 'Biller', 1, [...BUILTIN_TICKS.biller]],
      ['owner', 'Owner', 1, []],
      ['staff', 'Staff', 1, [...BUILTIN_TICKS.staff]],
    ]);
  });

  it('keeps existing users: apply files 0001-0011, add a user for each built-in role, apply the rest; roles and logins are unchanged, is_super_admin is 0', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jv-s24-'));
    try {
      for (const f of readdirSync(MIGRATIONS).filter((f) => /^\d{4}_.*\.sql$/.test(f) && f < '0012')) cpSync(new URL(f, MIGRATIONS), join(dir, f));
      const { c: old } = await open('s24old', false);
      await migrate(old, { dir, seeds: false });
      const users = ['owner', 'biller', 'staff'].map((r) => V.user({ role: r, active: 1 }));
      for (const u of users) await insert(old, 'users', u);
      const before = (await old.query<any[]>('SELECT id, email, role, active, password_hash, updated_at FROM users ORDER BY id'))[0];
      const result = await migrate(old, { seeds: false });
      expect(result.applied).toEqual(['0012']);
      const after = (await old.query<any[]>('SELECT id, email, role, active, password_hash, updated_at, is_super_admin FROM users ORDER BY id'))[0];
      expect(after.map(({ is_super_admin, ...rest }) => rest)).toEqual(before);
      expect(after.map((u) => Number(u.is_super_admin))).toEqual([0, 0, 0]);
      expect(Number(((await old.query<any[]>('SELECT COUNT(*) AS n FROM roles'))[0] as any[])[0].n)).toBe(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the file passes the migration rules: checkSql(file, "migration") is []', () => {
    expect(checkSql(readFileSync(FILE, 'utf8'), 'migration')).toEqual([]);
  });
});

describe('s24 roles (R1, R3): what the database refuses', () => {
  it('users.role must name a role: an unknown key fails with 1452', async () => {
    expect(await refusal('users', V.user({ role: 'cashier' }))).toBe(ER.NO_REFERENCED_ROW);
    const mine = role();
    await insert(c, 'roles', mine);
    expect(await refusal('users', V.user({ role: mine.role_key }))).toBeNull();
    const [chk] = await c.query<any[]>("SELECT CONSTRAINT_NAME AS n FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND CONSTRAINT_NAME = 'chk_users_role'");
    expect(chk).toEqual([]);
    const [fk] = await c.query<any[]>(
      "SELECT CONSTRAINT_NAME AS n, REFERENCED_TABLE_NAME AS t, DELETE_RULE AS d, UPDATE_RULE AS u FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'users'",
    );
    expect(fk).toEqual([{ n: 'fk_users_role', t: 'roles', d: 'RESTRICT', u: 'RESTRICT' }]);
  });

  it('role_key accepts only ^[a-z][a-z-]{0,11}$ compared as binary: Owner, role_1, a-very-long-key and the empty text fail', async () => {
    for (const role_key of ['cashier', 'c', 'cash-desk-ab', 'abcdefghijkl']) expect(await refusal('roles', role({ role_key })), role_key).toBeNull();
    for (const role_key of ['Owner', 'role_1', 'a-very-long-key', '', '-cash', '1abc']) expect(await refusal('roles', role({ role_key })), role_key).not.toBeNull();
    for (const role_key of ['Owner', 'role_1', '', '-cash', '1abc']) expect(await refusal('roles', role({ role_key })), role_key).toBe(ER.CHECK_FAILED);
    expect(await refusal('roles', role({ role_key: 'a-very-long-key' }))).toBe(ER.DATA_TOO_LONG); // 15 characters do not fit VARCHAR(12)
  });

  it('names are unique ignoring case, accents, a trailing space and a zero-width space: Cashier / cashier / "cashier " / "Cashier\\u200b" clash', async () => {
    await insert(c, 'roles', role({ name: 'Cashier' }));
    for (const name of ['cashier', 'cashier ', 'Cashier\u200b', 'Cashi\u00e9r', 'CASHIER']) expect(await refusal('roles', role({ name })), JSON.stringify(name)).toBe(ER.DUP_ENTRY);
    expect(await refusal('roles', role({ name: 'Cashier two' }))).toBeNull();
    expect(await refusal('roles', role({ name: '   ' }))).toBe(ER.CHECK_FAILED);
  });

  it('ticks must be a JSON array: {}, "x" and null fail', async () => {
    expect(await refusal('roles', role({ ticks: ['bill_view'] }))).toBeNull();
    expect(await refusal('roles', role({ ticks: {} }))).toBe(ER.CHECK_FAILED);
    expect(await refusal('roles', role({ ticks: '"x"' }))).toBe(ER.CHECK_FAILED);
    expect(await refusal('roles', role({ ticks: 'x' }))).toBe(ER.CHECK_FAILED);
    expect(await refusal('roles', role({ ticks: null }))).toBe(1048); // ER_BAD_NULL_ERROR
  });

  it('is_super_admin is 0 or 1', async () => {
    expect(await refusal('users', V.user({ is_super_admin: 1 }))).toBeNull();
    expect(await refusal('users', V.user({ is_super_admin: 0 }))).toBeNull();
    expect(await refusal('users', V.user({ is_super_admin: 2 }))).toBe(ER.CHECK_FAILED);
    expect(await refusal('users', V.user({ is_super_admin: -1 }))).toBe(ER.CHECK_FAILED);
  });
});

describe('s24 roles: the audit trigger', () => {
  it('with the audit triggers installed an update of roles.ticks writes one audit row with the old and the new set', async () => {
    const { c: t } = await open('s24trg', true);
    await migrate(t, { seeds: false, optional: true });
    await t.query("SET @jv_actor = NULL, @jv_role = 'owner', @jv_request = NULL");
    const next = [...BUILTIN_TICKS.staff, 'category_edit'];
    await t.query('UPDATE roles SET ticks = ? WHERE role_key = ?', [JSON.stringify(next), 'staff']);
    const [rows] = await t.query<any[]>("SELECT action, actor_role, old_row, new_row FROM audit_log WHERE table_name = 'roles' AND row_id = 'staff'");
    expect(rows).toHaveLength(1);
    expect([rows[0].action, rows[0].actor_role]).toEqual(['update', 'owner']);
    expect(asJson(rows[0].old_row).ticks).toEqual([...BUILTIN_TICKS.staff]);
    expect(asJson(rows[0].new_row).ticks).toEqual(next);
  });
});
