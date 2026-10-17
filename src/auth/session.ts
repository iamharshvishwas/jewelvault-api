// U4, U12, D24: the life of a session, the write side. The read side (cookie to session to user, D2) and the touch of `last_seen_at` are src/permissions/session.ts, because that is where the wrapper
// asks who is calling.
//
//   startSession   a login: a NEW ticket (32 random bytes from the system's random source), its SHA-256 stored in `sessions`, the ticket itself never kept; created now, last seen now, over in 14 days
//                  (the absolute lifetime, in the API clock). The session the browser was carrying (the cookie of the login request, if it names one) is ended in the same transaction, whoever's it is
//                  (against session fixation, U12).
//   endSession     a logout. endOtherSessions: a password change ends the user's other sessions (U11).
//
// Nothing is deleted (S7): a session that ends gets `revoked_at` and stays as a row. All of these run inside the caller's transaction, with the others of that call, and take "now" from one clock reading.
import { type Reading, formatTimestamp } from '../clock.js';
import { newId } from '../db/ids.js';
import type { Tx } from '../db/tx.js';
import { limits } from '../limits.js';
import { SESSION_COOKIE, hashTicket, newTicket } from '../permissions/session.js';

/** U12: the cookie lasts as long as the session can: `Max-Age` equals the absolute lifetime (14 days), in seconds. */
export const SESSION_MAX_AGE_S = limits.sessionAbsoluteMs / 1000;

const COOKIE_FLAGS = 'Path=/; HttpOnly; Secure; SameSite=Strict';

/** U12: the Set-Cookie value of a new session: `__Host-jv_session`, HttpOnly, Secure, SameSite=Strict, Path=/, no Domain (so it belongs to the API's host only), Max-Age 14 days. */
export const sessionCookie = (ticket: string): string => `${SESSION_COOKIE}=${ticket}; Max-Age=${SESSION_MAX_AGE_S}; ${COOKIE_FLAGS}`;

/** The Set-Cookie value that removes it (the same name and attributes, an empty value, a Max-Age of 0). */
export const clearedSessionCookie = (): string => `${SESSION_COOKIE}=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; ${COOKIE_FLAGS}`;

export interface StartedSession {
  id: string;
  /** The value for the cookie. It exists here and in the browser, nowhere else. */
  ticket: string;
  /** DATETIME(6) text, UTC */
  expiresAt: string;
  /** 1 when the login carried the cookie of a session that was live and is now ended, else 0 */
  previousEnded: number;
}

const USER_AGENT_COLUMN = 200;
const END_BY_TICKET = 'UPDATE sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL';
const INSERT_SESSION = 'INSERT INTO sessions (id, user_id, token_hash, created_at, last_seen_at, expires_at, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?)';
const END_BY_ID = 'UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL';
const END_OTHERS = 'UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND id <> ? AND revoked_at IS NULL';

export interface StartSessionInput {
  userId: string;
  /** The User-Agent header, if any; kept to the column's 200 characters. */
  userAgent: string | undefined;
  now: Reading;
  /** The ticket the login request carried in its cookie, if it carried a well-formed one: that session is ended. */
  replacingTicket: string | null;
}

export async function startSession(tx: Tx, input: StartSessionInput): Promise<StartedSession> {
  let previousEnded = 0;
  if (input.replacingTicket !== null) previousEnded = (await tx.run(END_BY_TICKET, [input.now.timestamp, hashTicket(input.replacingTicket)])).affectedRows;
  const id = newId();
  const ticket = newTicket();
  const expiresAt = formatTimestamp(input.now.micros + BigInt(limits.sessionAbsoluteMs) * 1000n);
  const userAgent = input.userAgent === undefined ? null : Array.from(input.userAgent).slice(0, USER_AGENT_COLUMN).join('');
  await tx.run(INSERT_SESSION, [id, input.userId, hashTicket(ticket), input.now.timestamp, input.now.timestamp, expiresAt, userAgent]);
  return { id, ticket, expiresAt, previousEnded };
}

/** Ends one session (a logout). Returns whether it was live. */
export async function endSession(tx: Tx, sessionId: string, now: Reading): Promise<boolean> {
  return (await tx.run(END_BY_ID, [now.timestamp, sessionId])).affectedRows === 1;
}

/** Ends every live session of the user except one (U11: a password change ends the others and keeps the one it was made from). Returns how many it ended. */
export async function endOtherSessions(tx: Tx, userId: string, keepSessionId: string, now: Reading): Promise<number> {
  return (await tx.run(END_OTHERS, [now.timestamp, userId, keepSessionId])).affectedRows;
}
