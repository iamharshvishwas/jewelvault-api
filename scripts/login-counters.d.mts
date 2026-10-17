import type { Connection } from 'mysql2/promise';

export const WINDOW_SECONDS: { email: 900; addr: 60; any: 60 };
export const SLOTS: number;
/** The address as it is counted: IPv4 as it is, IPv4-mapped IPv6 as the IPv4, other IPv6 shortened to its first 64 bits (`2001:db8:1:2::`). */
export function addressKey(address: string): string;
/** The counter slot (0 to 1023): first two bytes of SHA-256(salt | lower-cased e-mail or shortened address) modulo 1,024 (D24). */
export function loginSlot(salt: string, kind: 'email' | 'addr', value: string): number;
/** Counts an attempt when the request arrives (one atomic statement, then a plain SELECT of n). `now` is a test seam; the database clock is used without it. */
export function countAttempt(conn: Connection, scope: 'email' | 'addr' | 'any', slot: number, opts?: { now?: Date }): Promise<number>;
export interface ClosedHour { hour: string; failures: number }
/** A failed login: closes the summary of an hour that has ended (one `login_failures` audit event, exactly one caller wins) and adds one to the current hour. Not inside a transaction. */
export function recordFailure(conn: Connection, opts?: { now?: Date }): Promise<{ closed: ClosedHour | null }>;
/** The tick's housekeeping (I8): closes a finished hour that has failures not yet written. */
export function closeFinishedHour(conn: Connection, opts?: { now?: Date }): Promise<ClosedHour | null>;
