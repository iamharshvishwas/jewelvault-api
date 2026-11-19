// U3, U2, A8, O41, O54: the admin door. Accounts are made only here, by Harsh, and nothing else in the program creates a user, changes a role or sets `active` (A8).
//
//   POST /admin/v1/users                        {email, full_name, role}   make a user with a random temporary password, shown once, and must_change_password (the first owner too); `role` is the key of any ACTIVE role
//   GET  /admin/v1/users                                                    the users, with what Harsh needs (the Super Admin flag included) and never a hash
//   POST /admin/v1/users/:id/reset-password                                a new temporary password, must_change_password, and EVERY session of that user ended
//   POST /admin/v1/users/:id/role               {role}                      change the role to the key of any ACTIVE role (the only way a role changes)
//   POST /admin/v1/users/:id/deactivate                                     not active: reads nothing; every session ended
//   POST /admin/v1/users/:id/activate                                       (refused for a login whose role is switched off, and for one with the Super Admin flag while another Super Admin is active, R13)
//   POST /admin/v1/super-admin                  {email, full_name}          make THE Super Admin (R14): a new login (role owner, the flag, a temporary password shown once), or the login that has the e-mail, promoted
//   POST /admin/v1/login-counters/clear                                     n = 0 and the window to now on every counter except the summary row (A13, D24)
//   POST /admin/v1/backup-pulls                 {file, sha256}              settings.last_pulled: Harsh pulled that backup file (O54)
//
// The routes exist only while JV_ADMIN_TOKEN_HASH is set (O41: after the first owner exists the variable is removed and the door is shut); with it unset these addresses are not routes and
// answer 404 like any other. Every route is a route of the `admin` token door (route(app, { token: 'admin' })): the check of src/admin/door.ts runs first and alone, no session is read.
//
// Every call that gets through is ONE transaction with the actor `admin-cli` (no user id; the role is what says who) that makes the change and writes one `event` audit row (writeEvent, D16): the
// audit triggers of db/optional add their own rows for the changed user or setting with the same actor. The facts hold identifiers and counts, never a password, a token or a hash. A call that is
// refused (a wrong token, an Origin, a throttle) or fails (no such user, a bad body) writes nothing at all.
//
// A temporary password is hashed BEFORE the transaction, so no connection of the pool is held while the hash runs (the same rule as the login, NODE-DESIGN 5.2); the password is in the answer to
// the one call that made it and nowhere else: not in the database (only its hash), not in the audit rows, not in the log.
//
// A ROLE is the key of a row of `roles` (src/permissions/roleStore.ts): add-user and role accept any ACTIVE one, the Super Admin's own roles included, and refuse any other key with 422 on `role`. What is written
// is the key as the table STORES it: the foreign key ignores letter case, so the text that was sent is never written. The flag `is_super_admin` is set here and nowhere else (DESIGN 6.1, guardrail 3), only by
// make-super-admin; every user answer carries it. THE SINGLE SUPER ADMIN (DESIGN 6.3, 6.6) is kept inside the transaction of the two calls that can make a second active one, make-super-admin and activate
// (assertNoOtherSuperAdmin), and by no database constraint. The terminal is the one place that manages a Super Admin login (R12): reset, deactivate, activate and role all work on it here. A login with the flag holds
// every tick whatever its role is (R4), so a role change here moves its name in the Activity Log and nothing it may do.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { passwords } from '../auth/password.js';
import { endAllSessions } from '../auth/session.js';
import { BACKUP_FILE_PATTERN, SHA256_PATTERN, clearLoginCounters, recordPull } from '../db/adminStatements.js';
import { writeEvent } from '../db/events.js';
import { newId } from '../db/ids.js';
import type { DbPool } from '../db/pool.js';
import { type Tx, txContextFor, withTx } from '../db/tx.js';
import { JvError, unavailableError } from '../errors.js';
import { route } from '../permissions/route.js';
import { assertActiveRole, getRole, roleKeyField } from '../permissions/roleStore.js';
import { OWNER_KEY } from '../permissions/ticks.js';
import { UUID_TEXT, timestampToWire } from '../wire/format.js';
import * as wire from '../wire/zod.js';
import { adminDoor } from './door.js';
import { newTemporaryPassword } from './password.js';

// ------------------------------------------------------------------ shapes

const typeError = (issue: { input?: unknown }) => (issue.input === undefined ? 'is required' : 'must be text');
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const emailField = z.string({ error: typeError }).trim().toLowerCase().min(1, 'is required').max(254, 'must be at most 254 characters').regex(EMAIL_SHAPE, 'must be an e-mail address such as name@example.com');
const fullNameField = z.string({ error: typeError }).trim().min(1, 'is required').max(120, 'must be at most 120 characters');

const createBody = wire.strictObject({ email: emailField, full_name: fullNameField, role: roleKeyField });
const roleBody = wire.strictObject({ role: roleKeyField });
const superBody = wire.strictObject({ email: emailField, full_name: fullNameField });
const pullBody = wire.strictObject({
  file: z.string({ error: typeError }).regex(BACKUP_FILE_PATTERN, 'must be a backup name like daily/2026-10-10.enc'),
  sha256: z.string({ error: typeError }).regex(SHA256_PATTERN, 'must be 64 hex characters'),
});

/** The actor of the door: no user, and the role says what it is (audit_log.actor_role, D16). */
const ACTOR = { id: null, role: 'admin-cli' } as const;

interface UserRow {
  id: string;
  email: string;
  full_name: string;
  role: string;
  active: number | string;
  must_change_password: number | string;
  is_super_admin: number | string;
}
const USER_COLUMNS = 'id, email, full_name, role, active, must_change_password, is_super_admin';

const userBody = (u: UserRow) => ({
  id: u.id,
  email: u.email,
  full_name: u.full_name,
  role: u.role,
  active: Number(u.active) === 1,
  must_change_password: Number(u.must_change_password) === 1,
  is_super_admin: Number(u.is_super_admin) === 1,
});

function databaseOf(app: FastifyInstance): DbPool {
  if (!app.db) throw unavailableError();
  return app.db;
}

const NO_SUCH_USER = () => new JvError('JV_NOT_FOUND', 'There is no such user.');

function idOf(params: unknown): string {
  const id = (params as { id?: unknown } | undefined)?.id;
  if (typeof id !== 'string' || !UUID_TEXT.test(id)) throw new wire.InvalidInputError('id', 'must be a lower-case UUID');
  return id;
}

/** The user's row, locked: a login in flight for the same user waits for this call, and its own check of the password (API05) then sees the change. */
async function lockUser(tx: Tx, id: string): Promise<UserRow> {
  const [user] = await tx.rows<UserRow>(`SELECT ${USER_COLUMNS} FROM users WHERE id = ? FOR UPDATE`, [id]);
  if (!user) throw NO_SUCH_USER();
  return user;
}

/**
 * R13, DESIGN 6.3: AT MOST ONE ACTIVE SUPER ADMIN. Called inside the transaction of a call that could make a second one (make-super-admin, and activate of a login that has the flag); it refuses, 409 JV_NOT_ALLOWED,
 * when an active login with the flag is not `except` (the login the call is about: its id, or null when the login does not exist yet), naming that login's e-mail and the way out, in the words of the plan.
 * The flagged logins themselves are the wrong thing to lock, for two reasons. At READ COMMITTED a lock on rows that do not exist yet locks nothing, so two first calls at the same moment would both find none and both
 * make one. And no index serves `is_super_admin = 1 AND active = 1`, so a locking read of it would scan, and lock, the whole of `users` (D19 rule 1: no locking statement without an index).
 * So every such call takes the ONE lock that is always there: the Owner role's row, which exists from the migration and is never written (the Owner role cannot be changed, DESIGN 6.6 rule 1). The calls queue on it, and
 * each reads the flagged logins (a plain read) after the one before it has committed. THE ORDER OF LOCKS in the door is the login's own row first (lockUser, or the lookup of make-super-admin), then the role rows (add-user and role:
 * the role that is given; activate: the login's own role), then this one, the Owner's row, last: no call takes the Owner's row and then another role's row, so calls queue on a lock but never wait on each other in a circle.
 */
async function assertNoOtherSuperAdmin(tx: Tx, except: string | null): Promise<void> {
  await getRole(tx, OWNER_KEY, { forUpdate: true });
  const active = await tx.rows<{ id: string; email: string }>('SELECT id, email FROM users WHERE is_super_admin = 1 AND active = 1 ORDER BY created_at, id');
  const other = active.find((u) => u.id !== except);
  if (other) throw new JvError('JV_NOT_ALLOWED', `Another Super Admin is active (${other.email}). Switch that login off first with deactivate.`);
}

// ------------------------------------------------------------------ the routes

export function registerAdminRoutes(app: FastifyInstance): void {
  const tokenHash = app.config.adminTokenHash;
  if (!tokenHash) return; // O41: no hash, no door
  const verify = adminDoor(app, tokenHash);

  route(app, {
    token: 'admin',
    method: 'POST',
    url: '/admin/v1/users',
    verify,
    body: createBody,
    handler: async ({ app: a, request, reply, body }) => {
      const db = databaseOf(a);
      const temporary = newTemporaryPassword();
      const hash = await passwords.hash(temporary);
      const id = newId();
      const roleKey = await withTx(txContextFor(db, request, ACTOR), async (tx) => {
        const taken = await tx.rows<{ id: string }>('SELECT id FROM users WHERE email = ?', [body.email]);
        if (taken.length > 0) throw new wire.InvalidInputError('email', 'is already used by another user');
        const role = await assertActiveRole(tx, body.role); // the key as the roles table stores it: the foreign key ignores letter case, so the text that was sent is never written
        await tx.run('INSERT INTO users (id, email, full_name, role, active, password_hash, must_change_password) VALUES (?, ?, ?, ?, 1, ?, 1)', [id, body.email, body.full_name, role.role_key, hash]);
        await writeEvent(tx, { table: 'users', rowId: id, facts: { event: 'admin_add_user', role: role.role_key } });
        return role.role_key;
      });
      reply.code(201);
      return { user: userBody({ id, email: body.email, full_name: body.full_name, role: roleKey, active: 1, must_change_password: 1, is_super_admin: 0 }), temporary_password: temporary };
    },
  });

  route(app, {
    token: 'admin',
    method: 'GET',
    url: '/admin/v1/users',
    verify,
    handler: async ({ app: a, request }) => {
      const users = await withTx(txContextFor(databaseOf(a), request, ACTOR), async (tx) => {
        const rows = await tx.rows<UserRow & { last_login_at: string | null; created_at: string }>(`SELECT ${USER_COLUMNS}, last_login_at, created_at FROM users ORDER BY created_at, id`);
        await writeEvent(tx, { table: 'users', rowId: 'list', facts: { event: 'admin_list_users', count: rows.length } });
        return rows;
      });
      return { users: users.map((u) => ({ ...userBody(u), last_login_at: u.last_login_at === null ? null : timestampToWire(u.last_login_at), created_at: timestampToWire(u.created_at) })) };
    },
  });

  route(app, {
    token: 'admin',
    method: 'POST',
    url: '/admin/v1/users/:id/reset-password',
    verify,
    handler: async ({ app: a, request }) => {
      const id = idOf(request.params);
      const db = databaseOf(a);
      const temporary = newTemporaryPassword();
      const hash = await passwords.hash(temporary);
      const now = a.clock.read();
      const { user, ended } = await withTx(txContextFor(db, request, ACTOR), async (tx) => {
        const found = await lockUser(tx, id);
        await tx.run('UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?', [hash, id]);
        const count = await endAllSessions(tx, id, now);
        await writeEvent(tx, { table: 'users', rowId: id, facts: { event: 'admin_reset_password', sessions_ended: count } });
        return { user: found, ended: count };
      });
      return { user: userBody({ ...user, must_change_password: 1 }), temporary_password: temporary, sessions_ended: ended };
    },
  });

  route(app, {
    token: 'admin',
    method: 'POST',
    url: '/admin/v1/users/:id/role',
    verify,
    body: roleBody,
    handler: async ({ app: a, request, body }) => {
      const id = idOf(request.params);
      const { user, roleKey } = await withTx(txContextFor(databaseOf(a), request, ACTOR), async (tx) => {
        const found = await lockUser(tx, id);
        const role = await assertActiveRole(tx, body.role); // any ACTIVE role, written as stored (see add-user)
        await tx.run('UPDATE users SET role = ? WHERE id = ?', [role.role_key, id]);
        await writeEvent(tx, { table: 'users', rowId: id, facts: { event: 'admin_change_role', from: found.role, to: role.role_key } });
        return { user: found, roleKey: role.role_key };
      });
      return { user: userBody({ ...user, role: roleKey }), previous_role: user.role };
    },
  });

  route(app, {
    token: 'admin',
    method: 'POST',
    url: '/admin/v1/users/:id/deactivate',
    verify,
    handler: async ({ app: a, request }) => {
      const id = idOf(request.params);
      const now = a.clock.read();
      const { user, ended } = await withTx(txContextFor(databaseOf(a), request, ACTOR), async (tx) => {
        const found = await lockUser(tx, id);
        await tx.run('UPDATE users SET active = 0 WHERE id = ?', [id]);
        const count = await endAllSessions(tx, id, now); // an activation later must not bring an old session back
        await writeEvent(tx, { table: 'users', rowId: id, facts: { event: 'admin_deactivate_user', sessions_ended: count } });
        return { user: found, ended: count };
      });
      return { user: userBody({ ...user, active: 0 }), sessions_ended: ended };
    },
  });

  route(app, {
    token: 'admin',
    method: 'POST',
    url: '/admin/v1/users/:id/activate',
    verify,
    handler: async ({ app: a, request }) => {
      const id = idOf(request.params);
      const user = await withTx(txContextFor(databaseOf(a), request, ACTOR), async (tx) => {
        const found = await lockUser(tx, id);
        // a login whose role is switched off is refused with a 401 on every call (the session), so it must never be switched on. The role row is held until the commit: the role cannot be switched off between this check and the write.
        const role = await getRole(tx, found.role, { forUpdate: true });
        if (!role || Number(role.active) !== 1) throw new JvError('JV_NOT_ALLOWED', `The role ${role?.name ?? found.role} is switched off. Give this login an active role first.`);
        if (Number(found.is_super_admin) === 1) await assertNoOtherSuperAdmin(tx, found.id); // R13
        await tx.run('UPDATE users SET active = 1 WHERE id = ?', [id]);
        await writeEvent(tx, { table: 'users', rowId: id, facts: { event: 'admin_activate_user' } });
        return found;
      });
      return { user: userBody({ ...user, active: 1 }) };
    },
  });

  route(app, {
    token: 'admin',
    method: 'POST',
    url: '/admin/v1/super-admin',
    verify,
    body: superBody,
    handler: async ({ app: a, request, reply, body }) => {
      const db = databaseOf(a);
      const temporary = newTemporaryPassword();
      const hash = await passwords.hash(temporary); // before the transaction, as in add-user; it is used only when the login does not exist yet
      const id = newId();
      const made = await withTx(txContextFor(db, request, ACTOR), async (tx) => {
        const [existing] = await tx.rows<UserRow>(`SELECT ${USER_COLUMNS} FROM users WHERE email = ? FOR UPDATE`, [body.email]);
        await assertNoOtherSuperAdmin(tx, existing?.id ?? null);
        if (existing) {
          // PROMOTE: the login keeps its password, its name and its other flags (a login that is not active stays so); only the role and the flag change. The same e-mail again changes nothing and is accepted.
          await tx.run('UPDATE users SET role = ?, is_super_admin = 1 WHERE id = ?', [OWNER_KEY, existing.id]);
          await writeEvent(tx, { table: 'users', rowId: existing.id, facts: { event: 'admin_make_super_admin', created: false } });
          return { created: false, user: { ...existing, role: OWNER_KEY, is_super_admin: 1 } };
        }
        await tx.run('INSERT INTO users (id, email, full_name, role, active, password_hash, must_change_password, is_super_admin) VALUES (?, ?, ?, ?, 1, ?, 1, 1)', [id, body.email, body.full_name, OWNER_KEY, hash]);
        await writeEvent(tx, { table: 'users', rowId: id, facts: { event: 'admin_make_super_admin', created: true } });
        return { created: true, user: { id, email: body.email, full_name: body.full_name, role: OWNER_KEY, active: 1, must_change_password: 1, is_super_admin: 1 } };
      });
      if (!made.created) return { user: userBody(made.user), created: false };
      reply.code(201);
      return { user: userBody(made.user), created: true, temporary_password: temporary };
    },
  });

  route(app, {
    token: 'admin',
    method: 'POST',
    url: '/admin/v1/login-counters/clear',
    verify,
    handler: async ({ app: a, request }) =>
      withTx(txContextFor(databaseOf(a), request, ACTOR), async (tx) => {
        const { cleared } = await clearLoginCounters(tx);
        await writeEvent(tx, { table: 'sys_login_attempts', rowId: 'counters', facts: { event: 'admin_clear_login_counters', cleared } });
        return { cleared };
      }),
  });

  route(app, {
    token: 'admin',
    method: 'POST',
    url: '/admin/v1/backup-pulls',
    verify,
    body: pullBody,
    handler: async ({ app: a, request, body }) => {
      const at = new Date(Number(a.clock.read().micros / 1000n)).toISOString();
      await withTx(txContextFor(databaseOf(a), request, ACTOR), async (tx) => {
        await recordPull(tx, { at, by: ACTOR.role, file: body.file, sha256: body.sha256 });
        await writeEvent(tx, { table: 'settings', rowId: 'last_pulled', facts: { event: 'admin_record_pull', file: body.file } });
      });
      return { recorded: true, at };
    },
  });
}
