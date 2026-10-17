// U1, U4, U9, U11, U12, A10: the login and the four session calls.
//
//   POST /v1/auth/login            the public route (no session is looked up): e-mail and password; sets the cookie. A wrong e-mail and a wrong password give the same JV_BAD_LOGIN, after one
//                                  password verification each (an unknown e-mail verifies against the dummy hash), so the answer and the time do not say which. A correct password for a user who is
//                                  not active is 403 JV_FORBIDDEN with details.reason "inactive". A new ticket every time; the session the browser carried is ended.
//   GET  /v1/auth/me               who the caller is, as the database says now (the role is read on every call, A2), the limits of the session and pricing_sha256 (API18 fills it).
//   POST /v1/auth/logout           ends the session, clears the cookie.
//   POST /v1/auth/activity         the screen's "a click or key press" (at most once a minute). The wrapper moves last_seen_at for it, as for every call except polling and `me` (U4).
//   POST /v1/auth/change-password  verifies the current password, applies the rules of U9, stores the new hash, ends the user's OTHER sessions, clears must_change_password (U11).
//
// A password is hashed and checked with NO database connection held (the checkout for the read is given back first, a new one is taken for the writes): a login that waits for one of the two hashing
// places never holds a place of the pool, so waiting logins cannot stop a bill (NODE-DESIGN 2.5, 5.2). Because of that gap, the writes begin by locking the user's row and checking that the password
// that was verified is still the current one and the user still active (a change of password or a deactivation may have happened meanwhile), and the lock also orders a login against a change of password
// of the same user: a session made by a login that lost the race is ended by the change, and one made after it is refused.
//
// A login, a logout and a change-password each write one `event` audit row through writeEvent, in the same transaction as the change. The facts hold identifiers and counts, never a password, a ticket or a hash.
//
// The counters and delays of failed logins (A13, D24) are API08's: they wrap this handler.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { writeEvent } from '../db/events.js';
import type { DbPool } from '../db/pool.js';
import { txContextFor, withRead, withTx } from '../db/tx.js';
import { JvError, unavailableError } from '../errors.js';
import { limits } from '../limits.js';
import { type Auth, route } from '../permissions/route.js';
import { readTicket } from '../permissions/session.js';
import { timestampToWire } from '../wire/format.js';
import * as wire from '../wire/zod.js';
import { PASSWORD_MAX_LENGTH, checkNewPassword, passwords } from './password.js';
import { clearedSessionCookie, endOtherSessions, endSession, sessionCookie, startSession } from './session.js';

// ------------------------------------------------------------------ shapes

const text = (max: number) =>
  z
    .string({ error: (issue) => (issue.input === undefined ? 'is required' : 'must be text') })
    .min(1, 'is required')
    .max(max, `must be at most ${max} characters`);

// The body takes these keys and no others: a `role`, an `active` or anything else is an unknown key (A2, A8). The limits are generous caps against huge inputs; the length of a password is judged by U9.
const loginBody = wire.strictObject({ email: text(254), password: text(1024) });
const changePasswordBody = wire.strictObject({ current_password: text(1024), new_password: text(1024) });

const BAD_LOGIN = () => new JvError('JV_BAD_LOGIN', 'Wrong email or password.');
const NOT_ACTIVE = () => new JvError('JV_FORBIDDEN', 'Your account is not active.', { details: { reason: 'inactive' } });

/** pricing_sha256 of `me`: the SHA-256 of the API's src/domain/pricing.ts, the app's pricing file byte for byte (API18, C12). `npm run check:pricing` fails when it is not the hash of the file and the one PRICING-SOURCE.txt names. */
const PRICING_SHA256: string | null = '202482b7bfa9aff7f5cf004a92311253b05aed98f9f86a00d6dc89c29a95fc09';

const userBody = (u: { id: string; email: string; fullName: string; role: string; mustChangePassword: boolean }) => ({
  id: u.id,
  email: u.email,
  full_name: u.fullName,
  role: u.role,
  must_change_password: u.mustChangePassword,
});

/** What the screen needs to know about the life of the session: the idle limit, and when the absolute one ends. */
const lifeBody = (expiresAt: string) => ({ idle_timeout_s: limits.sessionIdleMs / 1000, absolute_expires_at: timestampToWire(expiresAt) });

function databaseOf(app: FastifyInstance): DbPool {
  if (!app.db) throw unavailableError();
  return app.db;
}

/** The actor of the audit trail and of the actor variables of the triggers: the user, with the role as the database has it. */
const actorOf = (auth: Auth) => ({ id: auth.user.id, role: auth.user.role });

/** The characters of a password as U9 counts them (not bytes, not UTF-16 units). */
const lengthOf = (password: string): number => [...password].length;

interface LoginRow {
  id: string;
  email: string;
  full_name: string;
  role: string;
  active: number | string;
  password_hash: string;
  must_change_password: number | string;
}
const LOGIN_SQL = 'SELECT id, email, full_name, role, active, password_hash, must_change_password FROM users WHERE email = ?';
const LOCK_USER_SQL = 'SELECT password_hash, active FROM users WHERE id = ? FOR UPDATE';
const SET_PASSWORD_SQL = 'UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?';

// ------------------------------------------------------------------ the routes

export function registerAuthRoutes(app: FastifyInstance): void {
  // The dummy hash for an unknown e-mail is made when the app is ready, so the first unknown e-mail after a start is not slower than the next (the pool exists only in the running API and the
  // tests that use one: an app built without a database never hashes).
  app.addHook('onReady', async () => {
    if (app.db) passwords.dummyHash().catch((e: unknown) => app.log.warn({ cause: (e as Error).message }, 'the dummy password hash could not be made at start-up'));
  });

  route(app, {
    public: 'login',
    body: loginBody,
    handler: async ({ app: a, request, reply, body }) => {
      const db = databaseOf(a);
      const rows = await withRead(txContextFor(db, request, null), (r) => r.rows<LoginRow>(LOGIN_SQL, [body.email.trim()])); // the connection is given back here: the hash holds none
      const user = rows[0];
      // U1: one verification whether or not the e-mail exists. A password over 128 characters can never be right and is not hashed.
      const right = lengthOf(body.password) <= PASSWORD_MAX_LENGTH && (await passwords.verify(body.password, user ? user.password_hash : await passwords.dummyHash()));
      if (!user || !right) throw BAD_LOGIN();
      if (Number(user.active) !== 1) throw NOT_ACTIVE();

      const now = a.clock.read();
      const oldTicket = readTicket(request.headers.cookie);
      const userAgent = request.headers['user-agent'];
      const started = await withTx(txContextFor(db, request, { id: user.id, role: user.role }), async (tx) => {
        const [current] = await tx.rows<{ password_hash: string; active: number | string }>(LOCK_USER_SQL, [user.id]);
        if (!current || current.password_hash !== user.password_hash) throw BAD_LOGIN(); // the password was changed while this one was checked
        if (Number(current.active) !== 1) throw NOT_ACTIVE();
        const session = await startSession(tx, { userId: user.id, userAgent: typeof userAgent === 'string' ? userAgent : undefined, now, replacingTicket: oldTicket });
        await writeEvent(tx, { table: 'users', rowId: user.id, facts: { event: 'login', session_id: session.id, previous_session_ended: session.previousEnded } });
        return session;
      });

      reply.header('Set-Cookie', sessionCookie(started.ticket));
      return { user: userBody({ id: user.id, email: user.email, fullName: user.full_name, role: user.role, mustChangePassword: Number(user.must_change_password) === 1 }), ...lifeBody(started.expiresAt) };
    },
  });

  route(app, {
    action: 'session:me',
    handler: async ({ auth }) => ({ user: userBody(auth.user), pricing_sha256: PRICING_SHA256, ...lifeBody(auth.session.expiresAt) }),
  });

  route(app, {
    action: 'session:activity',
    handler: async () => ({ ok: true }), // the wrapper has moved last_seen_at: that is all this call is for
  });

  route(app, {
    action: 'session:logout',
    handler: async ({ app: a, request, reply, auth }) => {
      const now = a.clock.read();
      await withTx(txContextFor(databaseOf(a), request, actorOf(auth)), async (tx) => {
        await endSession(tx, auth.session.id, now);
        await writeEvent(tx, { table: 'users', rowId: auth.user.id, facts: { event: 'logout', session_id: auth.session.id } });
      });
      reply.header('Set-Cookie', clearedSessionCookie());
      return { ok: true };
    },
  });

  route(app, {
    action: 'session:change-password',
    body: changePasswordBody,
    handler: async ({ app: a, request, auth, body }) => {
      const db = databaseOf(a);
      const rows = await withRead(txContextFor(db, request, null), (r) => r.rows<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = ?', [auth.user.id]));
      const stored = rows[0]?.password_hash;
      if (stored === undefined) throw new JvError('JV_UNAUTHENTICATED', 'Sign in to continue.');
      // U9, and not the same as the one it replaces (a temporary password that stays would stay known to whoever made it)
      const reason = checkNewPassword(body.new_password, auth.user.email);
      if (reason !== null) throw new wire.InvalidInputError('new_password', reason);
      if (body.new_password === body.current_password) throw new wire.InvalidInputError('new_password', 'must be different from the current password');
      // a wrong current password is a refused input (422), never a 401: a 401 makes the screen drop the session of a person who only mistyped
      const right = lengthOf(body.current_password) <= PASSWORD_MAX_LENGTH && (await passwords.verify(body.current_password, stored));
      if (!right) throw new wire.InvalidInputError('current_password', 'is not correct');
      const newHash = await passwords.hash(body.new_password);

      const now = a.clock.read();
      await withTx(txContextFor(db, request, actorOf(auth)), async (tx) => {
        const [current] = await tx.rows<{ password_hash: string }>(LOCK_USER_SQL, [auth.user.id]);
        if (!current || current.password_hash !== stored) throw new wire.InvalidInputError('current_password', 'is not correct'); // changed meanwhile, from another browser
        await tx.run(SET_PASSWORD_SQL, [newHash, auth.user.id]);
        const ended = await endOtherSessions(tx, auth.user.id, auth.session.id, now);
        await writeEvent(tx, { table: 'users', rowId: auth.user.id, facts: { event: 'change_password', session_id: auth.session.id, other_sessions_ended: ended, was_temporary: auth.user.mustChangePassword } });
      });
      return { user: userBody({ ...auth.user, mustChangePassword: false }), ...lifeBody(auth.session.expiresAt) };
    },
  });
}
