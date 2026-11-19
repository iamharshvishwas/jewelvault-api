// Task 13 of the access plan (R9; DESIGN.md 6.3 and 6.6 rule 6): THE SUPER ADMIN'S PASSWORD, ASKED AGAIN ON EVERY WRITE of People & Roles. The five writes of people (Task 14) and the four of roles (Task 13) carry the
// Super Admin's own current password in the body field `password`; confirmPassword is the one place that checks it. It knows nothing of roles or people: it takes the application, the request, the caller and the text.
//
//   - it runs BEFORE the transaction of the write, and holds no connection while the password is hashed (the same rule as the login and change-password, NODE-DESIGN 5.2): a plain read of the caller's own
//     `users.password_hash` on a short checkout that is given back, then `passwords.verify`. It takes no lock, so the order of locks of the write that follows (a login row, then at most one non-Owner role row,
//     then the Owner row last) is not touched by it.
//   - a password longer than PASSWORD_MAX_LENGTH can never be right and is not hashed (it counts as wrong), as at the login.
//   - a WRONG password is 422 JV_INVALID_INPUT on the field `password` ("is not correct"), never 401: a 401 makes the screen drop the session of a person who only mistyped (the same as change-password).
//   - THE THROTTLE (THROTTLES.superWrongInARow, superPauseMs) is kept in the application's limiter (src/auth/limiter.ts) under the key `super-wrong:<user id>`, so it is for each Super Admin and touches nobody else,
//     the login throttle (sys_login_attempts) included. Five wrong passwords in a row pause that Super Admin for 15 minutes: every write is then 429 JV_RATE_LIMITED with the whole seconds left in Retry-After, even
//     with the right password, and the stored hash is not even read. A right password ends the run of wrong ones. The 429 is answered BEFORE the password is looked at, and again AFTER it when the pause began while
//     this password was being checked (calls started together all pass the first look): an answer about a password is never given once the pause has begun, so a burst cannot get more than five of them.
//
// Nothing here is logged and nothing is written: the password is not in a message, a log line, an audit row or an event, and a refusal leaves the database as it was.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { THROTTLES, limiterOf, rateLimited } from '../auth/limiter.js';
import { PASSWORD_MAX_LENGTH, passwords } from '../auth/password.js';
import { txContextFor, withRead } from '../db/tx.js';
import { JvError, unavailableError } from '../errors.js';
import type { Auth } from '../permissions/session.js';
import * as wire from '../wire/zod.js';

/** The characters of a password as U9 counts them (not bytes, not UTF-16 units). */
const lengthOf = (password: string): number => [...password].length;

/**
 * Checks `password` against the caller's own stored hash, or throws: 422 on `password` when it is wrong, 429 with Retry-After while the caller is paused. Returns when it is right (and the run of wrong
 * answers is over). Call it before the transaction of the write, after the input has been judged.
 */
export async function confirmPassword(app: FastifyInstance, request: FastifyRequest, auth: Auth, password: string): Promise<void> {
  const db = app.db;
  if (!db) throw unavailableError();
  const limiter = limiterOf(app);
  const key = `super-wrong:${auth.user.id}`;

  const paused = limiter.pausedFor(key);
  if (paused > 0) throw rateLimited(paused / 1000);

  const rows = await withRead(txContextFor(db, request, null), (r) => r.rows<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = ?', [auth.user.id]));
  const stored = rows[0]?.password_hash;
  if (stored === undefined) throw new JvError('JV_UNAUTHENTICATED', 'Sign in to continue.');
  const right = lengthOf(password) <= PASSWORD_MAX_LENGTH && (await passwords.verify(password, stored));

  // the pause may have begun while this password was being checked (the checks of calls started together overlap): no answer about the password is given then
  const left = limiter.pausedFor(key);
  if (left > 0) throw rateLimited(left / 1000);

  if (!right) {
    if (limiter.strike(key) >= THROTTLES.superWrongInARow) {
      limiter.pause(key, THROTTLES.superPauseMs);
      limiter.clearStrikes(key); // the pause is the consequence; when it is over the run starts from zero
    }
    throw new wire.InvalidInputError('password', 'is not correct');
  }
  limiter.clearStrikes(key);
}
