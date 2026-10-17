// U3, U2, A8, O41, O54: the admin door. Accounts are made only here, by Harsh, and nothing else in the program creates a user, changes a role or sets `active` (A8).
//
//   POST /admin/v1/users                        {email, full_name, role}   make a user with a random temporary password, shown once, and must_change_password (the first owner too)
//   GET  /admin/v1/users                                                    the users, with what Harsh needs and never a hash
//   POST /admin/v1/users/:id/reset-password                                a new temporary password, must_change_password, and EVERY session of that user ended
//   POST /admin/v1/users/:id/role               {role}                      change the role (the only way a role changes)
//   POST /admin/v1/users/:id/deactivate                                     not active: reads nothing; every session ended
//   POST /admin/v1/users/:id/activate
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
import { ROLES } from '../permissions/matrix.js';
import { route } from '../permissions/route.js';
import { UUID_TEXT, timestampToWire } from '../wire/format.js';
import * as wire from '../wire/zod.js';
import { adminDoor } from './door.js';
import { newTemporaryPassword } from './password.js';

// ------------------------------------------------------------------ shapes

const typeError = (issue: { input?: unknown }) => (issue.input === undefined ? 'is required' : 'must be text');
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const createBody = wire.strictObject({
  email: z.string({ error: typeError }).trim().toLowerCase().min(1, 'is required').max(254, 'must be at most 254 characters').regex(EMAIL_SHAPE, 'must be an e-mail address such as name@example.com'),
  full_name: z.string({ error: typeError }).trim().min(1, 'is required').max(120, 'must be at most 120 characters'),
  role: z.enum(ROLES, { error: `must be one of ${ROLES.join(', ')}` }),
});
const roleBody = wire.strictObject({ role: z.enum(ROLES, { error: `must be one of ${ROLES.join(', ')}` }) });
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
}
const USER_COLUMNS = 'id, email, full_name, role, active, must_change_password';

const userBody = (u: UserRow) => ({
  id: u.id,
  email: u.email,
  full_name: u.full_name,
  role: u.role,
  active: Number(u.active) === 1,
  must_change_password: Number(u.must_change_password) === 1,
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
      await withTx(txContextFor(db, request, ACTOR), async (tx) => {
        const taken = await tx.rows<{ id: string }>('SELECT id FROM users WHERE email = ?', [body.email]);
        if (taken.length > 0) throw new wire.InvalidInputError('email', 'is already used by another user');
        await tx.run('INSERT INTO users (id, email, full_name, role, active, password_hash, must_change_password) VALUES (?, ?, ?, ?, 1, ?, 1)', [id, body.email, body.full_name, body.role, hash]);
        await writeEvent(tx, { table: 'users', rowId: id, facts: { event: 'admin_add_user', role: body.role } });
      });
      reply.code(201);
      return { user: userBody({ id, email: body.email, full_name: body.full_name, role: body.role, active: 1, must_change_password: 1 }), temporary_password: temporary };
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
      const user = await withTx(txContextFor(databaseOf(a), request, ACTOR), async (tx) => {
        const found = await lockUser(tx, id);
        await tx.run('UPDATE users SET role = ? WHERE id = ?', [body.role, id]);
        await writeEvent(tx, { table: 'users', rowId: id, facts: { event: 'admin_change_role', from: found.role, to: body.role } });
        return found;
      });
      return { user: userBody({ ...user, role: body.role }), previous_role: user.role };
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
