// D16, L1: an `event` row of audit_log. The audit triggers (db/optional) write the rows of the audited tables' inserts and updates; what is not a change of a row (a login, a logout, a password
// change, an admin-door call, a job run) is written here, by the code that did it, in the same transaction, with the actor, the role and the request id of that transaction and its facts in `new_row`.
// A login, a logout and a change-password (API05), every admin-door call (API09) and each tick phase (API33) write through this one helper. The failed-login summary of the hour is written by
// scripts/login-counters.mjs (it has its own connection and no request).
//
// The facts never hold a password, a ticket, a token, a cookie, a hash or a secret: such a KEY, at any depth, is a bug in the caller and stops the call (TypeError, nothing is written), because the
// owner reads this table and it goes into the backups. A value cannot be checked, so the callers pass identifiers and counts, not the things the request carried.
import type { Tx } from './tx.js';

export interface AuditEvent {
  /** The table (or the kind of thing) the event is about, 1 to 64 characters: `users` for a login. */
  table: string;
  /** The id of the row or thing, 1 to 64 characters. */
  rowId: string;
  /** What happened: `event` names it (`login`, `logout`, `change_password`), the rest are identifiers and counts. */
  facts: { event: string; [key: string]: unknown };
}

const EVENT_NAME = /^[a-z][a-z0-9_]{0,39}$/;
/** A key that names something secret. */
const SECRET_KEY = /pass(word|wd)|ticket|token|hash|secret|cookie|authoriz/i;

function checkFacts(value: unknown, path: string): void {
  if (Array.isArray(value)) {
    value.forEach((item, i) => checkFacts(item, `${path}[${i}]`));
  } else if (typeof value === 'object' && value !== null) {
    for (const [key, inner] of Object.entries(value)) {
      if (SECRET_KEY.test(key)) throw new TypeError(`an audit event must hold no password, ticket, token, cookie, hash or secret: the key "${path}${key}" names one`);
      checkFacts(inner, `${path}${key}.`);
    }
  }
}

const INSERT = "INSERT INTO audit_log (actor, actor_role, request_id, table_name, row_id, action, old_row, new_row) VALUES (?, ?, ?, ?, ?, 'event', NULL, ?)";

/** Writes one `event` row in the caller's transaction. The transaction must have an actor (a user, or `{ id: null, role: 'admin-cli' | 'job' }`). */
export async function writeEvent(tx: Tx, event: AuditEvent): Promise<void> {
  if (!tx.actor) throw new TypeError('writeEvent needs the actor of the transaction: a user, or a role such as admin-cli or job');
  if (typeof event.table !== 'string' || event.table.length < 1 || event.table.length > 64) throw new TypeError('the table of an audit event is 1 to 64 characters');
  if (typeof event.rowId !== 'string' || event.rowId.length < 1 || event.rowId.length > 64) throw new TypeError('the row id of an audit event is 1 to 64 characters');
  if (typeof event.facts?.event !== 'string' || !EVENT_NAME.test(event.facts.event)) throw new TypeError('an audit event needs a name in its facts: lower-case letters, digits and underscores, starting with a letter');
  checkFacts(event.facts, '');
  await tx.run(INSERT, [tx.actor.id, tx.actor.role, tx.requestId, event.table, event.rowId, JSON.stringify(event.facts)]);
}
