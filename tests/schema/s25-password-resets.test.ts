import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Connection } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkSql, migrate, splitStatements } from '../../scripts/migrate.mjs';
import { ER, type Scratch, errorOf, scratchDatabase } from '../helpers';
import { V, insert } from './support';

// Forgot password by e-mail (password-help-2026-11-26, part 2): the table `sys_password_resets` of db/migrations/0013, on a scratch database migrated by the ten-box user of A3 (no DELETE, no DROP),
// as on Hostinger. It holds hashes only: what the database itself refuses is a second row with the same token hash and a link for a login that does not exist. The `sys_` prefix keeps it out of the
// generated audit triggers, as for sys_login_attempts.

const FILE = new URL('../../db/migrations/0013_password_resets.sql', import.meta.url);
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

const scratches: Scratch[] = [];
const conns: Connection[] = [];
async function open(label: string) {
  const s = await scratchDatabase(label, { schema: true });
  scratches.push(s);
  const c = await s.connect();
  conns.push(c);
  return c;
}

let c: Connection;
beforeAll(async () => {
  c = await open('s25reset');
  await c.query("SET SESSION sql_mode = 'STRICT_TRANS_TABLES,ERROR_FOR_DIVISION_BY_ZERO,NO_AUTO_CREATE_USER,NO_ENGINE_SUBSTITUTION'");
}, 120_000);
afterAll(async () => {
  for (const x of conns) await x.end().catch(() => undefined);
  for (const s of scratches) await s.drop();
}, 60_000);

const reset = (user_id: string, o: Record<string, unknown> = {}) => ({
  id: randomUUID(),
  user_id,
  token_hash: sha(randomUUID()),
  email_at_request: 'owner@example.test',
  password_mark: sha('password hash of the login'),
  expires_at: '2030-01-01 00:00:00.000000',
  ...o,
});
const refusal = async (row: Record<string, unknown>) => (await errorOf(() => insert(c, 'sys_password_resets', row)))?.errno ?? null;
const newUser = async () => (await insert(c, 'users', V.user({ role: 'owner', active: 1 }))).id as string;
const columnsOf = async (table: string) => {
  const [rows] = await c.query<any[]>(
    'SELECT COLUMN_NAME AS n, COLUMN_TYPE AS t, IS_NULLABLE AS nullable, COLUMN_DEFAULT AS d, CHARACTER_SET_NAME AS cs, COLLATION_NAME AS co FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION',
    [table],
  );
  return new Map(rows.map((r) => [r.n as string, r]));
};

describe('s25 password resets: the migration', () => {
  it('applies on top of 0012 and again without error; its checksum is recorded; it passes the migration rules', async () => {
    const text = readFileSync(FILE, 'utf8');
    const [rows] = await c.query<any[]>("SELECT version, name, checksum FROM schema_migrations WHERE version = '0013'");
    expect(rows).toEqual([{ version: '0013', name: 'password_resets', checksum: createHash('sha256').update(text).digest('hex') }]);
    for (const sql of splitStatements(text)) expect(await errorOf(() => c.query(sql)), sql.slice(0, 60)).toBeNull();
    expect(checkSql(text, 'migration')).toEqual([]);
  });

  it('has the columns of the design: the ids as UUID like sessions.id, two 64-character hashes, the e-mail and the times typed like users.email and sessions; only used_at may be NULL', async () => {
    const mine = await columnsOf('sys_password_resets');
    const users = await columnsOf('users');
    const sessions = await columnsOf('sessions');
    expect([...mine.keys()]).toEqual(['id', 'user_id', 'token_hash', 'email_at_request', 'password_mark', 'created_at', 'expires_at', 'used_at']);
    const type = (n: string) => mine.get(n)?.t;
    expect(type('id')).toBe(sessions.get('id')?.t);
    expect(type('user_id')).toBe(users.get('id')?.t);
    expect(type('token_hash')).toBe('char(64)');
    expect(type('password_mark')).toBe('char(64)');
    expect(type('email_at_request')).toBe(users.get('email')?.t);
    expect(type('created_at')).toBe(sessions.get('created_at')?.t);
    expect(type('expires_at')).toBe(sessions.get('expires_at')?.t);
    expect(type('used_at')).toBe(sessions.get('expires_at')?.t);
    expect([...mine.values()].filter((x) => x.nullable === 'YES').map((x) => x.n)).toEqual(['used_at']);
    for (const x of mine.values()) if (x.cs) expect([x.n, x.cs, x.co]).toEqual([x.n, 'utf8mb4', 'utf8mb4_unicode_ci']);
  });

  it('keys the table by id, makes token_hash unique, and indexes (user_id, used_at); the user_id foreign key restricts', async () => {
    const [idx] = await c.query<any[]>(
      "SELECT INDEX_NAME AS i, NON_UNIQUE AS nu, GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS cols FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sys_password_resets' GROUP BY INDEX_NAME, NON_UNIQUE",
    );
    expect(idx.map((x) => [x.i, Number(x.nu), x.cols]).sort()).toEqual([
      ['PRIMARY', 0, 'id'],
      ['ix_password_resets_user', 1, 'user_id,used_at'],
      ['uq_password_resets_token', 0, 'token_hash'],
    ]);
    const [fk] = await c.query<any[]>(
      "SELECT CONSTRAINT_NAME AS n, REFERENCED_TABLE_NAME AS t, DELETE_RULE AS d, UPDATE_RULE AS u FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'sys_password_resets'",
    );
    expect(fk).toEqual([{ n: 'fk_password_resets_user', t: 'users', d: 'RESTRICT', u: 'RESTRICT' }]);
  });
});

describe('s25 password resets: what the database refuses and what it fills in', () => {
  it('a link for a login that does not exist fails with 1452; for a real login it is stored, unused, and stamped with the time it was made', async () => {
    expect(await refusal(reset(randomUUID()))).toBe(ER.NO_REFERENCED_ROW);
    const user_id = await newUser();
    const row = reset(user_id);
    expect(await refusal(row)).toBeNull();
    const [[stored]] = await c.query<any[]>('SELECT used_at, created_at, token_hash, password_mark, email_at_request FROM sys_password_resets WHERE id = ?', [row.id]);
    expect(stored.used_at).toBeNull();
    expect(stored.created_at).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{6}$/);
    expect([stored.token_hash, stored.password_mark, stored.email_at_request]).toEqual([row.token_hash, row.password_mark, row.email_at_request]);
  });

  it('two rows with the same token hash fail with 1062; the same login may hold many links with different hashes', async () => {
    const user_id = await newUser();
    const first = reset(user_id);
    expect(await refusal(first)).toBeNull();
    expect(await refusal(reset(user_id, { token_hash: first.token_hash }))).toBe(ER.DUP_ENTRY);
    expect(await refusal(reset(await newUser(), { token_hash: first.token_hash }))).toBe(ER.DUP_ENTRY);
    expect(await refusal(reset(user_id))).toBeNull();
    expect(await refusal(reset(user_id))).toBeNull();
  });

  it('a hash longer than 64 characters fails with 1406, and a missing hash, mark, e-mail or expiry fails with 1048', async () => {
    const user_id = await newUser();
    expect(await refusal(reset(user_id, { token_hash: 'a'.repeat(65) }))).toBe(ER.DATA_TOO_LONG);
    expect(await refusal(reset(user_id, { password_mark: 'a'.repeat(65) }))).toBe(ER.DATA_TOO_LONG);
    for (const col of ['token_hash', 'password_mark', 'email_at_request', 'expires_at']) expect(await refusal(reset(user_id, { [col]: null })), col).toBe(1048); // ER_BAD_NULL_ERROR
  });

  it('closing a link is an UPDATE of used_at (the ten boxes have no Delete): the row stays', async () => {
    const user_id = await newUser();
    const row = reset(user_id);
    await insert(c, 'sys_password_resets', row);
    await c.query('UPDATE sys_password_resets SET used_at = UTC_TIMESTAMP(6) WHERE id = ? AND used_at IS NULL', [row.id]);
    const [[{ n }]] = await c.query<any[]>('SELECT COUNT(*) AS n FROM sys_password_resets WHERE user_id = ? AND used_at IS NOT NULL', [user_id]);
    expect(Number(n)).toBe(1);
  });
});

describe('s25 password resets: no audit trigger', () => {
  it('with the audit triggers installed the table has none, and a link written and closed leaves audit_log empty of it', async () => {
    const t = await open('s25trg');
    await migrate(t, { seeds: false, optional: true });
    const [triggers] = await t.query<any[]>("SELECT TRIGGER_NAME AS n FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = DATABASE() AND EVENT_OBJECT_TABLE = 'sys_password_resets'");
    expect(triggers).toEqual([]);
    const [[{ n: audited }]] = await t.query<any[]>("SELECT COUNT(*) AS n FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = DATABASE() AND EVENT_OBJECT_TABLE = 'users'");
    expect(Number(audited), 'control: the audited users table does have its triggers here').toBeGreaterThan(0);
    const user = await insert(t, 'users', V.user({ role: 'owner', active: 1 }));
    const row = reset(user.id as string);
    await insert(t, 'sys_password_resets', row);
    await t.query('UPDATE sys_password_resets SET used_at = UTC_TIMESTAMP(6) WHERE id = ?', [row.id]);
    const [[{ n }]] = await t.query<any[]>("SELECT COUNT(*) AS n FROM audit_log WHERE table_name = 'sys_password_resets'");
    expect(Number(n)).toBe(0);
  });
});
