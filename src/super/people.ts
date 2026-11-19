// Task 14 of the access plan (DESIGN.md 6.1, 6.3 and 6.6; R9, R11, R12; Review Focus 3 and 4): THE PEOPLE WRITES OF THE SUPER ADMIN, the five calls behind the rows `super:people.add`, `.edit`, `.role`, `.active` and
// `.reset` of the matrix. Each takes the person's Auth and the parsed body of its route (src/super/routes.ts) and answers `{ person }` exactly as GET /v1/super/people lists that person (readPerson,
// src/super/queries.ts: the same statement and mapping), so an answer can never drift from the list.
//
//   addPerson          POST   /v1/super/people                    a new login with a role (an ACTIVE one), switched on, a temporary password made here, shown ONCE in the answer (`temporary_password`) and never kept
//                                                                  in the clear, and must_change_password: the person is told to change it at the first sign-in. 201.
//   editPerson         PATCH  /v1/super/people/:id                the name and/or the e-mail. A changed e-mail ends the person's sessions (R11).
//   setPersonRole      POST   /v1/super/people/:id/role           another ACTIVE role. Nothing else changes: the session reads the role on every request (G4), so the next call of the person's open sessions has the new ticks.
//   setPersonActive    POST   /v1/super/people/:id/active         switch off (every session ends) or on (refused while the person's role is switched off: Review Focus 3).
//   resetPassword      POST   /v1/super/people/:id/reset-password a new temporary password (`temporary_password`, shown once), must_change_password, every session ended (`sessions_ended`).
//
// THE ORDER OF EVERY CALL (as the role writes of src/super/roles.ts). (1) the wrapper: session, matrix row (the Super Admin only), the strict body (an unknown field, `is_super_admin` included, and a body without
// `password` are 422; the words of the body are judged there, by the rules of the terminal door: a name, an e-mail, a role key); (2) this file asks the matrix again (X0 item 2); (3) the address's id is judged (a bad
// one is 422 on `id`): so a bad input costs no password check and no strike; (4) the Super Admin's password (confirmPassword, src/super/password.ts: 422 on `password` when wrong, 429 while paused) BEFORE any
// transaction, in the ONE run of wrong passwords that the role writes share (the key `super-wrong:<user id>`); (5) add and reset make the temporary password (newTemporaryPassword) and HASH it, still before the
// transaction (a hash is never made while a transaction holds locks), and only after the password was confirmed, so that a wrong password or a pause costs no hash: the hashing places are shared with the login;
// (6) ONE transaction: the lock, the refusals, the write, the audit row of the users table, one `event` row, the read of the person for the answer. A refused, invalid or no-change call writes NOTHING: no login, no
// session, no audit row, no event.
//
// LOCKS. The order of the whole program is the login row first, then at most one role row that is not the Owner's, then the Owner's row last (the terminal door's own order). Every call that names a person locks that
// person's row FOR UPDATE FIRST (lockUser, the door's: 404 when there is none), and a call that gives the person a role locks the role row after it (assertActiveRole, getRole FOR UPDATE: held until the commit). `add`
// has no row to lock yet: it follows the door's add-user (a plain read of the e-mail, then the role row, then the INSERT). No locking read of `users` is ever made after a role row. Everything that makes a login hold a
// role locks that role's row, and a role's switch-off (src/super/roles.ts) locks it too and then counts the people with a plain read, so the two are serialised: a switch-off that runs first makes the add, the
// re-role or the switch-on find the role off (422 on `role`, 409 with the sentence below) and one that runs later counts the person it gave the role to (tests/api/super-people.test.ts runs both orders).
//
// THE SUPER ADMIN LOGIN (guardrail 2, R12). A login with `is_super_admin = 1` is managed in the terminal: every call on one is 409 JV_NOT_ALLOWED "A Super Admin login is managed in the terminal.", except the EDIT
// (name, e-mail) of the caller's OWN row. The refusal is the first thing asked after the lock, before any no-change check, so it is never hidden by a call that would have changed nothing. No body can set, change or
// clear the flag: no call takes it, no statement of this file writes it, and an add always leaves it 0 (the terminal alone makes a Super Admin).
//
// SESSIONS. A changed e-mail ends every session of the person (R11); when the person is the caller herself (the Super Admin editing her own e-mail) her CURRENT session survives and only her other sessions end, and she
// signs in with the new e-mail (Review Focus 4). A switch-off and a reset end every session. A new session of the same person is made only by a login, with the e-mail and password as they are then. A role change
// needs no session change at all. The statements are the terminal door's (src/auth/session.ts).
//
// NO CHANGE, NO WRITE (the convention of the role writes). An edit that changes nothing, a switch to the state the person is in and a change to the role the person has write nothing (no row, no audit row, no event, no
// session ended) and answer 200 with the person as listed. A reset always writes: a new password is always new.
//
// A LOGIN WHOSE ROLE IS SWITCHED OFF is refused with a 401 on every call (the session), so it must never be made: an add or a role change onto a role that is not active is 422 on `role` (assertActiveRole), and a
// switch-on of a person whose role is switched off is 409 "Its role is switched off. Change the role first." (the person's role row is locked until the commit, so it cannot be switched off between the check and the
// write). The people that exist on a role that is switched off are the switched-off ones (a role is never switched off while an ACTIVE person holds it, DESIGN 6.6 rule 4): to bring one back the Super Admin gives
// the person an active role first. The login itself is not changed by this task.
//
// A TAKEN E-MAIL is 422 on `email` ("is already used by another user", the terminal door's words). It is checked first with a plain read in the table's own collation (utf8mb4_unicode_ci: letter case and accents do not
// make an e-mail another one); under a race the unique key `uq_users_email` is the last wall: its error (1062) is answered with the same words, outside the transaction that it rolled back.
//
// AUDIT. The generated triggers (db/optional/0910, mechanism (a)) write the audit row of the users table (never the hash: audit-exclude.json); with JV_AUDIT_MODE=node `auditChange` writes the same row here (mechanism
// (b), never both). The events (D16, src/db/events.ts), table `users`, row id the person's id, every one with `person` (the id) and `name` (the person's name now): person_added {role}, person_edited {fields: the
// names of the fields that changed}, person_role_changed {from, to (role keys), to_name (the new role's name)}, person_switched_off, person_switched_on, person_password_reset {sessions_ended}. No password, hash,
// ticket or token is ever in a fact, a row, a log line or an error: the temporary password is in the answer of the one call that made it and nowhere else.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { newTemporaryPassword } from '../admin/password.js';
import { assertEmailFree, emailField, emailTaken, fullNameField, idOf, lockUser, type UserRow } from '../admin/routes.js';
import { passwords } from '../auth/password.js';
import { endAllSessions, endOtherSessions } from '../auth/session.js';
import { type AuditedRow, auditChange } from '../db/audit.js';
import { writeEvent } from '../db/events.js';
import { newId } from '../db/ids.js';
import { type Tx, txContextFor, withTx } from '../db/tx.js';
import { JvError, unavailableError } from '../errors.js';
import type { Grants } from '../permissions/grants.js';
import { assertActiveRole, getRole, roleKeyField } from '../permissions/roleStore.js';
import { type Auth, assertMayCall } from '../permissions/route.js';
import * as wire from '../wire/zod.js';
import { confirmPassword } from './password.js';
import { type WirePerson, readPerson } from './queries.js';
import { activeField, duplicateOf, passwordField } from './roles.js';

// ------------------------------------------------------------------ the bodies

/**
 * `changes` of an edit: the name and/or the e-mail, at least one, each by the rules of the terminal door (emailField trims and lower-cases; fullNameField trims; 1 to 120 characters). Another key (`is_super_admin`,
 * `role`, `active` ...) is refused by its path, `changes.<key>`.
 */
const changesField = z
  .strictObject(
    { full_name: fullNameField.optional(), email: emailField.optional() },
    { error: (issue) => (issue.code === 'invalid_type' ? (issue.input === undefined ? 'is required' : 'must be an object holding the fields to change') : undefined) },
  )
  .refine((changes) => changes.full_name !== undefined || changes.email !== undefined, { error: 'must name at least one field to change' });

/** POST /v1/super/people: the new person's name, e-mail and role, and the Super Admin's own password. */
export const addPersonBody = wire.strictObject({ full_name: fullNameField, email: emailField, role: roleKeyField, password: passwordField });
/** PATCH /v1/super/people/:id */
export const editPersonBody = wire.strictObject({ changes: changesField, password: passwordField });
/** POST /v1/super/people/:id/role */
export const personRoleBody = wire.strictObject({ role: roleKeyField, password: passwordField });
/** POST /v1/super/people/:id/active */
export const personActiveBody = wire.strictObject({ active: activeField, password: passwordField });
/** POST /v1/super/people/:id/reset-password */
export const resetPersonBody = wire.strictObject({ password: passwordField });

export type AddPersonBody = z.output<typeof addPersonBody>;
export type EditPersonBody = z.output<typeof editPersonBody>;
export type PersonRoleBody = z.output<typeof personRoleBody>;
export type PersonActiveBody = z.output<typeof personActiveBody>;
export type ResetPersonBody = z.output<typeof resetPersonBody>;

// ------------------------------------------------------------------ the statements

// The flag `is_super_admin` is in none of them: nothing here can set, change or clear it (an insert leaves the column's default, 0).
const INSERT_SQL = 'INSERT INTO users (id, email, full_name, role, active, password_hash, must_change_password, created_at, updated_at, created_by, updated_by) VALUES (?, ?, ?, ?, 1, ?, 1, ?, ?, ?, ?)';
const EDIT_SQL = 'UPDATE users SET full_name = ?, email = ?, updated_at = ?, updated_by = ? WHERE id = ?';
const ROLE_SQL = 'UPDATE users SET role = ?, updated_at = ?, updated_by = ? WHERE id = ?';
const ACTIVE_SQL = 'UPDATE users SET active = ?, updated_at = ?, updated_by = ? WHERE id = ?';
const RESET_SQL = 'UPDATE users SET password_hash = ?, must_change_password = 1, updated_at = ?, updated_by = ? WHERE id = ?';
/** Every column of the users table the audit rows hold (src/db/auditShapes.ts: all but the hash, which is never copied), as the Node audit writer needs the row; read only when it is the writer. */
const AUDIT_ROW_SQL =
  'SELECT id, email, full_name, role, active, must_change_password, last_login_at, created_at, updated_at, created_by, updated_by, is_super_admin FROM users WHERE id = ?';

// ------------------------------------------------------------------ the refusals

const superLogin = () => new JvError('JV_NOT_ALLOWED', 'A Super Admin login is managed in the terminal.');
const roleSwitchedOff = () => new JvError('JV_NOT_ALLOWED', 'Its role is switched off. Change the role first.');

/**
 * DESIGN 6.6 rule 2, R12: the first thing asked after the person's row is locked, before any no-change check. A login with the flag is managed in the terminal; `ownEditAllowed` is the edit, the one call that works on
 * the caller's own row.
 */
function assertManageable(person: UserRow, auth: Auth, ownEditAllowed: boolean): void {
  if (Number(person.is_super_admin) === 1 && !(ownEditAllowed && person.id === auth.user.id)) throw superLogin();
}

// ------------------------------------------------------------------ one transaction

/**
 * The one transaction of a write, as the Super Admin (the audit actor: the person and the role KEY). The database's own refusal of a duplicate e-mail is the last wall of the check that is made first and is answered with
 * the same words: the 1062 comes out of withTx as the error it classified (a business key, JV_INVALID_INPUT without a field), so it is recognised here, outside the transaction.
 */
async function transaction<T>(app: FastifyInstance, request: FastifyRequest, auth: Auth, work: (tx: Tx) => Promise<T>): Promise<T> {
  if (!app.db) throw unavailableError();
  try {
    return await withTx(txContextFor(app.db, request, { id: auth.user.id, role: auth.user.role }), work);
  } catch (e) {
    if (duplicateOf(e) === 'uq_users_email') throw emailTaken();
    throw e;
  }
}

/** The answer of a write: the person as the list shows that person, read in the same transaction so that it holds what was just written. */
async function answer(tx: Tx, grants: Grants, id: string): Promise<{ person: WirePerson }> {
  const person = await readPerson(tx, grants, id);
  if (!person) throw new Error(`the login ${id} is gone after its own write`);
  return { person };
}

/** The row as the Node audit writer needs it, and only then: with the triggers (L1 (a)) nothing is written here, so nothing is read for it. */
async function auditedRow(tx: Tx, id: string): Promise<AuditedRow | null> {
  if (tx.auditMode !== 'node') return null;
  const [row] = await tx.rows<AuditedRow>(AUDIT_ROW_SQL, [id]);
  return row ?? null;
}

/** The audit row of a change of the users table, right after the statement (mechanism (b) of L1; `before` is null for an insert). */
async function auditPerson(tx: Tx, id: string, before: AuditedRow | null): Promise<void> {
  if (tx.auditMode !== 'node') return;
  const after = await auditedRow(tx, id);
  if (!after) throw new Error(`the login ${id} is gone after its own write`);
  await auditChange(tx, { table: 'users', rowId: id, action: before === null ? 'insert' : 'update', before, after });
}

// ------------------------------------------------------------------ add

/** POST /v1/super/people: a new login with an active role and a temporary password, shown once. */
export async function addPerson(app: FastifyInstance, request: FastifyRequest, auth: Auth, body: AddPersonBody): Promise<{ person: WirePerson; temporary_password: string }> {
  const grants = auth.user.grants;
  assertMayCall(grants, 'super:people.add'); // X0 item 2: the wrapper has checked; a service function checks again
  await confirmPassword(app, request, auth, body.password);
  const temporary = newTemporaryPassword();
  const hash = await passwords.hash(temporary); // before the transaction: no connection is held while the hash runs
  const id = newId();

  const added = await transaction(app, request, auth, async (tx) => {
    await assertEmailFree(tx, body.email, null); // the door's order: the e-mail, then the role row, then the INSERT
    const role = await assertActiveRole(tx, body.role); // the key as the roles table stores it; locked until the commit
    const at = app.clock.read().timestamp; // created_at and updated_at from one reading of the API's clock (S6)
    await tx.run(INSERT_SQL, [id, body.email, body.full_name, role.role_key, hash, at, at, auth.user.id, auth.user.id]);
    await auditPerson(tx, id, null);
    await writeEvent(tx, { table: 'users', rowId: id, facts: { event: 'person_added', person: id, name: body.full_name, role: role.role_key } });
    return answer(tx, grants, id);
  });
  return { ...added, temporary_password: temporary };
}

// ------------------------------------------------------------------ edit

/** PATCH /v1/super/people/:id: the name and/or the e-mail. `params` is the route's `request.params`. */
export async function editPerson(app: FastifyInstance, request: FastifyRequest, auth: Auth, params: unknown, body: EditPersonBody): Promise<{ person: WirePerson }> {
  const grants = auth.user.grants;
  assertMayCall(grants, 'super:people.edit');
  const id = idOf(params);
  await confirmPassword(app, request, auth, body.password);

  return transaction(app, request, auth, async (tx) => {
    const person = await lockUser(tx, id);
    assertManageable(person, auth, true); // the one write the CRM does on a Super Admin login: her own name and e-mail
    const full_name = body.changes.full_name !== undefined && body.changes.full_name !== person.full_name ? body.changes.full_name : undefined;
    const email = body.changes.email !== undefined && body.changes.email !== person.email ? body.changes.email : undefined; // the stored text: another spelling of the same e-mail is a change
    if (full_name === undefined && email === undefined) return answer(tx, grants, id); // the same words: nothing is written
    if (email !== undefined) await assertEmailFree(tx, email, id); // her own e-mail in another spelling is no clash

    const now = app.clock.read();
    const before = await auditedRow(tx, id);
    await tx.run(EDIT_SQL, [full_name ?? person.full_name, email ?? person.email, now.timestamp, auth.user.id, id]);
    await auditPerson(tx, id, before);
    // R11: a changed e-mail ends the person's sessions; the caller's own CURRENT session is the one that survives, and she signs in with the new e-mail from now on (Review Focus 4)
    if (email !== undefined) await (person.id === auth.user.id ? endOtherSessions(tx, id, auth.session.id, now) : endAllSessions(tx, id, now));
    const fields = [...(full_name === undefined ? [] : ['full_name']), ...(email === undefined ? [] : ['email'])];
    await writeEvent(tx, { table: 'users', rowId: id, facts: { event: 'person_edited', person: id, name: full_name ?? person.full_name, fields } });
    return answer(tx, grants, id);
  });
}

// ------------------------------------------------------------------ role

/** POST /v1/super/people/:id/role: another active role for the person. */
export async function setPersonRole(app: FastifyInstance, request: FastifyRequest, auth: Auth, params: unknown, body: PersonRoleBody): Promise<{ person: WirePerson }> {
  const grants = auth.user.grants;
  assertMayCall(grants, 'super:people.role');
  const id = idOf(params);
  await confirmPassword(app, request, auth, body.password);

  return transaction(app, request, auth, async (tx) => {
    const person = await lockUser(tx, id); // the login's row first, then the role row
    assertManageable(person, auth, false);
    const role = await assertActiveRole(tx, body.role); // 422 on `role` for a key that is not an active role; the row is locked until the commit
    if (role.role_key === person.role) return answer(tx, grants, id); // the person has it already: nothing is written

    const now = app.clock.read();
    const before = await auditedRow(tx, id);
    await tx.run(ROLE_SQL, [role.role_key, now.timestamp, auth.user.id, id]);
    await auditPerson(tx, id, before);
    // no session is touched: the next call of every open session of the person reads the new role (G4)
    await writeEvent(tx, { table: 'users', rowId: id, facts: { event: 'person_role_changed', person: id, name: person.full_name, from: person.role, to: role.role_key, to_name: role.name } });
    return answer(tx, grants, id);
  });
}

// ------------------------------------------------------------------ switch off and on

/** POST /v1/super/people/:id/active: switch a person off (every session ends) or on (their role must be switched on). */
export async function setPersonActive(app: FastifyInstance, request: FastifyRequest, auth: Auth, params: unknown, body: PersonActiveBody): Promise<{ person: WirePerson }> {
  const grants = auth.user.grants;
  assertMayCall(grants, 'super:people.active');
  const id = idOf(params);
  await confirmPassword(app, request, auth, body.password);

  return transaction(app, request, auth, async (tx) => {
    const person = await lockUser(tx, id);
    assertManageable(person, auth, false);
    if ((Number(person.active) === 1) === body.active) return answer(tx, grants, id); // it is so already: nothing is written
    if (body.active) {
      // Review Focus 3: a login whose role is switched off is refused with a 401 on every call, so it is never switched on. The role row is held until the commit: the role cannot be switched off between this check and the write.
      const role = await getRole(tx, person.role, { forUpdate: true });
      if (!role || Number(role.active) !== 1) throw roleSwitchedOff();
    }

    const now = app.clock.read();
    const before = await auditedRow(tx, id);
    await tx.run(ACTIVE_SQL, [body.active ? 1 : 0, now.timestamp, auth.user.id, id]);
    await auditPerson(tx, id, before);
    if (!body.active) await endAllSessions(tx, id, now); // a person who is switched off is signed out everywhere, and a switch-on later must not bring an old session back
    await writeEvent(tx, { table: 'users', rowId: id, facts: { event: body.active ? 'person_switched_on' : 'person_switched_off', person: id, name: person.full_name } });
    return answer(tx, grants, id);
  });
}

// ------------------------------------------------------------------ reset

/** POST /v1/super/people/:id/reset-password: a new temporary password, shown once; every session of the person ends. */
export async function resetPassword(
  app: FastifyInstance,
  request: FastifyRequest,
  auth: Auth,
  params: unknown,
  body: ResetPersonBody,
): Promise<{ person: WirePerson; temporary_password: string; sessions_ended: number }> {
  const grants = auth.user.grants;
  assertMayCall(grants, 'super:people.reset');
  const id = idOf(params);
  await confirmPassword(app, request, auth, body.password);
  const temporary = newTemporaryPassword();
  const hash = await passwords.hash(temporary); // before the transaction, as in add

  const done = await transaction(app, request, auth, async (tx) => {
    const person = await lockUser(tx, id);
    assertManageable(person, auth, false);
    const now = app.clock.read();
    const before = await auditedRow(tx, id);
    await tx.run(RESET_SQL, [hash, now.timestamp, auth.user.id, id]);
    const sessionsEnded = await endAllSessions(tx, id, now);
    await auditPerson(tx, id, before);
    await writeEvent(tx, { table: 'users', rowId: id, facts: { event: 'person_password_reset', person: id, name: person.full_name, sessions_ended: sessionsEnded } });
    return { ...(await answer(tx, grants, id)), sessions_ended: sessionsEnded };
  });
  return { person: done.person, temporary_password: temporary, sessions_ended: done.sessions_ended };
}
