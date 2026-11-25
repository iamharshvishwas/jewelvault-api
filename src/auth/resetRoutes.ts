// Forgot password by e-mail (Completion-Plan/password-help-2026-11-26, DESIGN.md part 2): the two public routes of a person who cannot sign in.
//
//   POST /v1/auth/forgot-password  { email }: 202 {"ok":true} at once, for every e-mail (a login, none, a switched-off login, a call over a limit): the screen never tells whether an e-mail has a login,
//                                  by the words or by the time. Before the answer only the two limits are counted (THROTTLES.resetPerAddress first, then resetPerEmail on the e-mail as the login
//                                  reads it, trimmed and in lower case; a call over the address's limit is not counted for its e-mail); over either, nothing else happens. Everything else happens
//                                  AFTER the answer: the login is found with the login's own statement (FIND_LOGIN_SQL, so the e-mail that signs in is the one that gets a link), and for an active
//                                  login a link is made (a row of sys_password_resets and a `password_reset_requested` event, one transaction whose actor is that login) and mailed to the login's
//                                  stored e-mail. Earlier links stay as they are: a stranger who asks in someone's name cannot cancel the link that person was sent. Without mail settings
//                                  (app.mailer, config.mail) the answer is 503 JV_UNAVAILABLE with details.reason `mail_not_set_up`, before any limit is counted.
//   POST /v1/auth/reset-password   { token, new_password }: the token of a link and the new password. The link must be unused, within its 30 minutes, of an active login whose e-mail is still
//                                  email_at_request and whose stored hash still gives password_mark, so a change of the password by any other road (People & Roles, the admin door, change-password)
//                                  or of the e-mail since the link was made kills it without touching that code. Anything else is 422 on `token` ("has expired or was already used"), the same for
//                                  every reason. The new password follows U9 (checkNewPassword, 422 on `new_password`; the link is not spent). It is hashed with NO database connection held (as
//                                  change-password, src/auth/loginRoutes.ts); then one transaction locks the login's row and then the link's row, checks everything again (the link may have been
//                                  used, or the login changed, meanwhile), stores the hash with must_change_password 0, closes this link and every other open link of the login, ends every
//                                  session of the login and writes one `password_reset_by_email` event { link_id, sessions_ended }. 200 {"ok":true}.
//
// THE TOKEN is 32 random bytes in base64url (43 characters). It exists in the mail and nowhere else: the database keeps its SHA-256 (hex), and the link carries it after a `#`
// (`<JV_RESET_LINK_BASE>#t=<token>`), so no server receives it in a path, a query or a Referer. No log line, event or error row holds the token, a hash, an e-mail address or a password.
// The marks are taken from the read that found the login, outside the transaction: a change of the password or the e-mail in between gives a link that is refused when it is used, never one that works.
//
// THE WORK AFTER THE ANSWER runs on its own, each piece with a context of its own (its deadline counted from where it starts), and nothing of it can reach the client or stop the process: a send that
// fails is one JV_MAIL_FAILED row of sys_error_log with the SMTP code and nothing else (that row is how the deploy check finds a blocked port); any other failure goes the way of every unexpected
// error, to the log and, through errorLogEntry, to sys_error_log. resetWork.idle() waits for it: the tests do, and so does the app's close, before the pool is ended.
//
// Rows of sys_password_resets are never deleted (the API's user has no DELETE right, S7): a link is closed by setting used_at, and an old row stays.
import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { formatTimestamp } from '../clock.js';
import { writeEvent } from '../db/events.js';
import { newId } from '../db/ids.js';
import type { DbPool } from '../db/pool.js';
import { type Actor, txContext, txContextFor, withRead, withTx } from '../db/tx.js';
import { BusyError, JvError, classifyError, describeCause, unavailableError } from '../errors.js';
import type { Mailer } from '../mail/mailer.js';
import { route } from '../permissions/route.js';
import { microsOfDbTimestamp } from '../permissions/session.js';
import { errorLogEntry } from '../security/errorLog.js';
import * as wire from '../wire/zod.js';
import { THROTTLES, limiterOf, visitorAddress } from './limiter.js';
import { FIND_LOGIN_SQL, type LoginRow } from './loginRoutes.js';
import { checkNewPassword, passwords } from './password.js';
import { resetMail } from './resetMail.js';
import { endAllSessions } from './session.js';

// ------------------------------------------------------------------ shapes

const text = (max: number) =>
  z
    .string({ error: (issue) => (issue.input === undefined ? 'is required' : 'must be text') })
    .min(1, 'is required')
    .max(max, `must be at most ${max} characters`);

const forgotBody = wire.strictObject({ email: text(254) });
const resetBody = wire.strictObject({ token: text(100), new_password: text(1024) });

/** A link works for 30 minutes from when it was made (in microseconds, the unit of the API's clock). */
const LINK_LIFETIME_MICROS = 30n * 60n * 1_000_000n;

const MAIL_NOT_SET_UP = () => new JvError('JV_UNAVAILABLE', 'E-mail is not set up here. Ask the Super Admin to reset your password.', { details: { reason: 'mail_not_set_up' } });
/** The one answer for a link that cannot be used, whatever the reason (unknown, used, expired, a login switched off, a password or an e-mail changed since). */
const BAD_LINK = () => new wire.InvalidInputError('token', 'has expired or was already used');

const MAIL_FAILED_MESSAGE = 'a password reset mail could not be sent';

const INSERT_LINK_SQL = 'INSERT INTO sys_password_resets (id, user_id, token_hash, email_at_request, password_mark, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)';
const FIND_LINK_SQL =
  'SELECT r.id, r.user_id, r.email_at_request, r.password_mark, r.expires_at, r.used_at, u.email, u.role, u.active, u.password_hash FROM sys_password_resets r JOIN users u ON u.id = r.user_id WHERE r.token_hash = ?';
const LOCK_USER_SQL = 'SELECT email, active, password_hash FROM users WHERE id = ? FOR UPDATE';
const LOCK_LINK_SQL = 'SELECT email_at_request, password_mark, expires_at, used_at FROM sys_password_resets WHERE id = ? FOR UPDATE';
const SET_PASSWORD_SQL = 'UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?';
const CLOSE_LINKS_SQL = 'UPDATE sys_password_resets SET used_at = ? WHERE user_id = ? AND used_at IS NULL';

interface LinkState {
  email_at_request: string;
  password_mark: string;
  expires_at: string;
  used_at: string | null;
}
interface UserState {
  email: string;
  active: number | string;
  password_hash: string;
}
interface FoundLink extends LinkState, UserState {
  id: string;
  user_id: string;
  role: string;
}

/** SHA-256 in hex: the stored form of a token (token_hash) and of a stored password hash (password_mark). */
const sha256 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');

/** A link may be used while it is unused, before its end, and its login is active with the e-mail and the password it had when the link was made. */
const linkIsGood = (link: LinkState, user: UserState, nowMicros: bigint): boolean =>
  link.used_at === null &&
  microsOfDbTimestamp(link.expires_at) > nowMicros &&
  Number(user.active) === 1 &&
  user.email === link.email_at_request &&
  sha256(user.password_hash) === link.password_mark;

function databaseOf(app: FastifyInstance): DbPool {
  if (!app.db) throw unavailableError();
  return app.db;
}

const instantOf = (app: FastifyInstance): Date => new Date(Number(app.clock.read().micros / 1000n));

// ------------------------------------------------------------------ the work after the answer

const running = new Set<Promise<void>>();

/** The work of the forgot-password calls already answered. */
export const resetWork = {
  /** Resolves when all the work handed over so far is over. It never rejects. */
  async idle(): Promise<void> {
    while (running.size > 0) await Promise.all([...running]);
  },
};

/** Runs `work` once the answer has gone (on the next turn of the event loop), on its own. It counts as running from now on, so idle() sees it at once. */
function detach(app: FastifyInstance, work: () => Promise<void>): void {
  const done: Promise<void> = new Promise<void>((resolve) => setImmediate(resolve))
    .then(work)
    .catch((e: unknown) => {
      try {
        app.log.error({ cause: describeCause(e) }, 'forgot-password: the work after the answer failed'); // work() catches everything itself: this is the last guard
      } catch {
        // the log itself failed: nothing more can be done
      }
    })
    .finally(() => running.delete(done));
  running.add(done);
}

/** The code of a failed send (nodemailer's EAUTH, ECONNECTION, ETIMEDOUT, EENVELOPE ...), or null. Only a code-shaped value: the error's message names the address and is never kept. */
function smtpCodeOf(e: unknown): string | null {
  const code = typeof e === 'object' && e !== null ? (e as { code?: unknown }).code : undefined;
  if (typeof code !== 'string' && typeof code !== 'number') return null;
  return /^[A-Za-z0-9_.-]{1,40}$/.test(String(code)) ? String(code) : null;
}

interface LinkJob {
  db: DbPool;
  /** as the login reads it: trimmed, in lower case */
  email: string;
  mailer: Mailer;
  linkBase: string;
}

/** After the answer: find the login, make the link and mail it. Never throws. */
async function mailLink(app: FastifyInstance, request: FastifyRequest, job: LinkJob): Promise<void> {
  const context = (actor: Actor | null) => txContext(job.db, { requestId: request.id, actor, log: request.log, auditMode: app.config.auditMode });
  try {
    const [user] = await withRead(context(null), (r) => r.rows<LoginRow>(FIND_LOGIN_SQL, [job.email, job.email]));
    if (!user || Number(user.active) !== 1) return;
    const token = randomBytes(32).toString('base64url');
    const linkId = newId();
    const now = app.clock.read();
    await withTx(context({ id: user.id, role: user.role }), async (tx) => {
      await tx.run(INSERT_LINK_SQL, [linkId, user.id, sha256(token), user.email, sha256(user.password_hash), now.timestamp, formatTimestamp(now.micros + LINK_LIFETIME_MICROS)]);
      await writeEvent(tx, { table: 'users', rowId: user.id, facts: { event: 'password_reset_requested', link_id: linkId } });
    });
    try {
      await job.mailer.send(resetMail(user.email, `${job.linkBase}#t=${token}`));
    } catch (e) {
      const smtpCode = smtpCodeOf(e);
      request.log.error({ smtp_code: smtpCode }, MAIL_FAILED_MESSAGE);
      app.errorLog.record({ level: 'error', code: 'JV_MAIL_FAILED', message: MAIL_FAILED_MESSAGE, detail: { smtp_code: smtpCode } }, instantOf(app));
    }
  } catch (e) {
    // the way of every unexpected error (app.ts): the log, and sys_error_log for what errorLogEntry keeps. The answer went long ago.
    const answer = classifyError(e);
    const cause = describeCause(answer.cause ?? e);
    if (answer instanceof BusyError) request.log.warn({ code: answer.code, reason: answer.reason, cause }, 'forgot-password: the work after the answer failed');
    else request.log.error({ code: answer.code, cause }, 'forgot-password: the work after the answer failed');
    const entry = errorLogEntry(request, answer, e);
    if (entry) app.errorLog.record(entry, instantOf(app));
  }
}

/** The two limits of an ask, counted now: the address's first, and the e-mail's only for a call within it. */
function withinLimits(app: FastifyInstance, request: FastifyRequest, email: string): boolean {
  const limiter = limiterOf(app);
  if (!limiter.take(`reset-address:${visitorAddress(request.headers).key}`, THROTTLES.resetPerAddress).ok) return false;
  return limiter.take(`reset-email:${email}`, THROTTLES.resetPerEmail).ok;
}

// ------------------------------------------------------------------ the routes

export function registerResetRoutes(app: FastifyInstance): void {
  // the work after the answers is finished before the pool is ended (app.ts ends it in its own onClose, which was added earlier and so runs later)
  app.addHook('onClose', async () => {
    await resetWork.idle();
  });

  route(app, {
    public: 'forgot-password',
    body: forgotBody,
    handler: async ({ app: a, request, reply, body }) => {
      const mailer = a.mailer;
      const mail = a.config.mail;
      if (mailer === null || mail === null) throw MAIL_NOT_SET_UP();
      const db = databaseOf(a);
      const email = body.email.trim().toLowerCase(); // D1, RV1-5: as the login reads it
      if (withinLimits(a, request, email)) detach(a, () => mailLink(a, request, { db, email, mailer, linkBase: mail.resetLinkBase }));
      reply.code(202);
      return { ok: true };
    },
  });

  route(app, {
    public: 'reset-password',
    body: resetBody,
    handler: async ({ app: a, request, body }) => {
      const db = databaseOf(a);
      const [link] = await withRead(txContextFor(db, request, null), (r) => r.rows<FoundLink>(FIND_LINK_SQL, [sha256(body.token)]));
      if (!link || !linkIsGood(link, link, a.clock.read().micros)) throw BAD_LINK();
      const reason = checkNewPassword(body.new_password, link.email);
      if (reason !== null) throw new wire.InvalidInputError('new_password', reason);
      const newHash = await passwords.hash(body.new_password); // the read's connection was given back: none is held while this runs

      const now = a.clock.read();
      await withTx(txContextFor(db, request, { id: link.user_id, role: link.role }), async (tx) => {
        const [user] = await tx.rows<UserState>(LOCK_USER_SQL, [link.user_id]);
        const [current] = await tx.rows<LinkState>(LOCK_LINK_SQL, [link.id]);
        if (!user || !current || !linkIsGood(current, user, now.micros)) throw BAD_LINK(); // used, switched off or changed while the password was hashed
        await tx.run(SET_PASSWORD_SQL, [newHash, link.user_id]);
        await tx.run(CLOSE_LINKS_SQL, [now.timestamp, link.user_id]);
        const ended = await endAllSessions(tx, link.user_id, now);
        await writeEvent(tx, { table: 'users', rowId: link.user_id, facts: { event: 'password_reset_by_email', link_id: link.id, sessions_ended: ended } });
      });
      return { ok: true };
    },
  });
}
