// D2, A2, A10, U4, U12: how a request becomes a user and a role. The cookie carries only an opaque ticket; the API turns it into a `sessions` row (looked up by the SHA-256 of the ticket) and
// then into the `users` row, and the role and the `active` flag come from that read and from nothing else: not from the cookie, a header, the query or the body. This is the only place in the
// program that turns a session into a role (S10). A missing, ended or expired session, or a user who is not active, is a 401 and nothing else is read or written.
//
// What this file does NOT do (API05 builds it with the login): it does not move `last_seen_at` (U4: polling does not count, every other call does, in its own autocommit statement) and it does
// not mark an expired session as ended. It reads, and answers.
import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { JvError } from '../errors.js';
import { limits } from '../limits.js';
import { txContextFor, withRead } from '../db/tx.js';
import { ROLES, type Role } from './matrix.js';

/** U12: the name of the session cookie. */
export const SESSION_COOKIE = '__Host-jv_session';

/** A ticket is 32 bytes from the system's random source, written as 43 base64url characters (NODE-DESIGN 2.3). */
const TICKET_SHAPE = /^[A-Za-z0-9_-]{43}$/;

/** A new ticket for the cookie. Only its SHA-256 is stored (hashTicket); the ticket itself is never kept. */
export function newTicket(): string {
  return randomBytes(32).toString('base64url');
}

/** What `sessions.token_hash` holds: the SHA-256 of the ticket's text (VARBINARY(32)). */
export function hashTicket(ticket: string): Buffer {
  return createHash('sha256').update(ticket, 'utf8').digest();
}

/** The ticket in a Cookie header, or null when there is no such cookie or its value cannot be a ticket (then nothing is looked up). The first cookie of that name counts. */
export function readTicket(cookieHeader: string | undefined): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== SESSION_COOKIE) continue;
    const value = part.slice(eq + 1).trim();
    return TICKET_SHAPE.test(value) ? value : null;
  }
  return null;
}

/** Who is calling, as the read of D2 found them. The role is a value, never a string a handler compares with. */
export interface Auth {
  readonly user: {
    readonly id: string;
    readonly fullName: string;
    readonly role: Role;
    readonly mustChangePassword: boolean;
  };
  readonly session: {
    readonly id: string;
    /** DATETIME(6) text, UTC, exactly as the database gave it */
    readonly createdAt: string;
    readonly lastSeenAt: string;
    readonly expiresAt: string;
  };
}

interface SessionRow {
  id: string;
  user_id: string;
  created_at: string;
  last_seen_at: string;
  expires_at: string;
  revoked_at: string | null;
}
interface UserRow {
  id: string;
  full_name: string;
  role: string;
  active: number | string;
  must_change_password: number | string;
}

const UNAUTHENTICATED = () => new JvError('JV_UNAUTHENTICATED', 'Sign in to continue.');
const EXPIRED = () => new JvError('JV_SESSION_EXPIRED', 'Your session has ended. Sign in again.');

/** 'YYYY-MM-DD HH:MM:SS.ffffff' (UTC, as the database writes DATETIME(6)) as microseconds since the epoch. */
export function microsOfDbTimestamp(text: string): bigint {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?$/.exec(text);
  if (!m) throw new Error('not a DATETIME(6) text');
  const ms = BigInt(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])));
  return ms * 1000n + BigInt((m[7] ?? '').padEnd(6, '0') || '0');
}

const SESSION_SQL = 'SELECT id, user_id, created_at, last_seen_at, expires_at, revoked_at FROM sessions WHERE token_hash = ?';
const USER_SQL = 'SELECT id, full_name, role, active, must_change_password FROM users WHERE id = ?';

/**
 * D2: the cookie's ticket to a `sessions` row, and the row to its `users` row. Throws the 401 for every way of not being signed in:
 *   no cookie, a value that cannot be a ticket (nothing is read), a ticket nobody holds, an ended session (revoked_at), a user who is not active or has no row: JV_UNAUTHENTICATED;
 *   a session past its absolute lifetime (expires_at) or idle for more than 12 hours (last_seen_at): JV_SESSION_EXPIRED.
 * It stops at the first reason: an ended or expired session never reads the user ("nothing else is read or written", D2). It reads on a short checkout of its own that is given back before the
 * handler runs, so a slow call never holds a pool place for its session.
 */
export async function lookupSession(app: FastifyInstance, request: FastifyRequest): Promise<Auth> {
  const ticket = readTicket(request.headers.cookie);
  if (ticket === null) throw UNAUTHENTICATED();
  const db = app.db;
  if (!db) throw new JvError('JV_UNAVAILABLE', 'The service is not available. Try again in a moment.');
  const hash = hashTicket(ticket);
  return withRead(txContextFor(db, request, null), async (reader) => {
    const [s] = await reader.rows<SessionRow>(SESSION_SQL, [hash]);
    if (!s || s.revoked_at !== null) throw UNAUTHENTICATED();
    const now = app.clock.read().micros;
    if (microsOfDbTimestamp(s.expires_at) <= now) throw EXPIRED();
    if (microsOfDbTimestamp(s.last_seen_at) + BigInt(limits.sessionIdleMs) * 1000n <= now) throw EXPIRED();
    const [u] = await reader.rows<UserRow>(USER_SQL, [s.user_id]);
    if (!u || Number(u.active) !== 1) throw UNAUTHENTICATED();
    // a role the matrix does not know (the table's CHECK forbids it) is no role at all: fail closed
    if (!(ROLES as readonly string[]).includes(u.role)) throw UNAUTHENTICATED();
    return {
      user: { id: u.id, fullName: u.full_name, role: u.role as Role, mustChangePassword: Number(u.must_change_password) === 1 },
      session: { id: s.id, createdAt: s.created_at, lastSeenAt: s.last_seen_at, expiresAt: s.expires_at },
    };
  });
}
