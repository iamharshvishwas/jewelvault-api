// Task 13 of the access plan (DESIGN.md 6.1, 6.3 and 6.6; R2, R9): THE ROLE WRITES OF THE SUPER ADMIN, the four calls behind the rows `super:roles.create`, `.edit`, `.ticks` and `.active` of the matrix. Each takes
// the person's Auth and the parsed body of its route (src/super/routes.ts) and answers `{ role }` exactly as GET /v1/super/roles lists that role (readRole, src/super/queries.ts: the same statement and mapping).
//
//   createRole       POST  /v1/super/roles               a new role as a COPY of any role (a switched-off one too): the source's known ticks closed over their needs (the Owner as source gives all 32), a key made
//                                                        from the name (src/super/roleKey.ts), switched on, no people. 201.
//   editRole         PATCH /v1/super/roles/:key          the name and/or the description. The key never changes, so nobody who holds the role notices: their next call works as before.
//   setRoleTicks     PUT   /v1/super/roles/:key/ticks    the ticks, as a whole set. A key this version does not know, and a set that breaks a need (DESIGN 6.2) are refused 422 on `ticks`; the set is stored in catalogue order.
//   setRoleActive    POST  /v1/super/roles/:key/active   switch it off (refused while ACTIVE people hold it: DESIGN 6.6 rule 4) or on.
//
// THE ORDER OF EVERY CALL. (1) the wrapper: session, matrix row (the Super Admin only), the strict body (an unknown field, `is_super_admin` included, and a body without `password` are 422); (2) this file asks the matrix
// again (X0 item 2); (3) the words are judged (a name, a description, a list of ticks: pure functions, nothing is asked of the database, so a bad input costs no password check); (4) the Super Admin's password
// (confirmPassword, src/super/password.ts: 422 when wrong, 429 while paused) BEFORE any transaction; (5) ONE transaction that locks the role row, refuses the Owner, compares `expected_updated_at`, writes, leaves the
// audit row of the roles table and one `event` row per change, and reads the role again for the answer. A refused, stale or invalid call writes nothing at all: no role, no audit row, no event.
//
// THE OWNER ROW refuses every write but being copied (409 JV_NOT_ALLOWED, "The Owner role is fixed and cannot be changed."), whatever the stamp says (DESIGN 6.6 rule 1). The password is checked first, as for every
// write; the refusal is the first thing the transaction says after it has found the row.
//
// THE STAMP (R9, A5). `expected_updated_at` is the `updated_at` text the screen holds. It is compared with the row under the lock of this transaction; a different one is 409 JV_STALE with `details.current`, the role
// as listed, and nothing is written. Every write stamps `updated_at` (and `created_at` for a new role) from the API's clock and `updated_by` (`created_by`) from the session user, as every API write does (S6, D22).
// A write that would change nothing (the same name, the same ticks, a switch to the state it is in) writes nothing and leaves the stamp: the answer is the role as it is.
//
// LOCKS. The target role row is locked FOR UPDATE first and no login row is locked after it (getRole, src/permissions/roleStore.ts): the Owner row is last when it is the one (a copy of the Owner locks only that
// row). A switch-off COUNTS the active logins that hold the role with a plain read AFTER that lock. That is race-safe because everything that makes a login hold a role locks the role row first (the admin door's
// add-user, role and activate, the people calls of Task 14: assertActiveRole and getRole FOR UPDATE): a give-this-role call that is running waits for this one and then finds the role off, and one that has finished
// has committed its login, which the count sees. tests/api/super-roles.test.ts runs both orders against the door.
//
// A NAME THAT IS TAKEN is 422 on `name` ("is already used by another role"). It is checked first, with a plain read in the table's own collation (utf8mb4_unicode_ci: case, accents, spaces at the end and a zero-width space
// do not make a name another one). Under a race the unique key `uq_roles_name` is the last wall: its error (1062) is answered with the same words. A new key can also meet the PRIMARY key under a race (two names that
// fold to one key, made at the same moment): the loser's transaction is rolled back and run again, so that it reads the keys that exist now.
//
// AUDIT. The generated triggers (db/optional/0910, mechanism (a)) write the audit row of the roles table; with JV_AUDIT_MODE=node `auditChange` writes the same row here (mechanism (b), never both). The events
// (D16, src/db/events.ts), table `roles`, row id the role key: role_created {role, name, copied_from}, role_renamed {role, name (now), from, to}, role_described {role, name}, role_ticks_changed {role, name,
// turned_on, turned_off}, role_switched_off and role_switched_on {role, name}. A call that changes the name and the description writes role_renamed and then role_described. No password, hash or token is ever in a fact.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { type AuditedRow, auditChange } from '../db/audit.js';
import { writeEvent } from '../db/events.js';
import { type Tx, txContextFor, withTx } from '../db/tx.js';
import { JvError, duplicateKeyName, unavailableError } from '../errors.js';
import { type Grants, grantsOf, sortedTicks } from '../permissions/grants.js';
import { type RoleRow, getRole, roleKeyField } from '../permissions/roleStore.js';
import { type Auth, assertMayCall } from '../permissions/route.js';
import { OWNER_KEY, TICKS, TICK_KEYS, type TickKey, brokenNeeds, closeOverNeeds, isTickKey } from '../permissions/ticks.js';
import { timestampFromWire, timestampToWire } from '../wire/format.js';
import * as wire from '../wire/zod.js';
import { confirmPassword } from './password.js';
import { type WireRole, readRole } from './queries.js';
import { cleanRoleDescription, cleanRoleName, makeRoleKey } from './roleKey.js';

// ------------------------------------------------------------------ the bodies

const typeError = (issue: { input?: unknown }) => (issue.input === undefined ? 'is required' : 'must be text');

/** The Super Admin's own password. Its length as a password is judged by confirmPassword (one over 128 characters is wrong, not invalid); the cap here is only against a huge input, as at the login. Exported: the people writes (src/super/people.ts) carry it too. */
export const passwordField = z.string({ error: typeError }).min(1, 'is required').max(1024, 'must be at most 1024 characters');
/** The words are judged by cleanRoleName and cleanRoleDescription, which know the rules. */
const nameField = z.string({ error: typeError });
const descriptionField = z.string({ error: typeError });
const ticksField = z
  .array(z.string({ error: typeError }), { error: (issue) => (issue.input === undefined ? 'is required' : 'must be a list of tick keys') })
  .max(TICK_KEYS.length, `must list at most ${TICK_KEYS.length} ticks`);
/** `active` of a switch, role or person (src/super/people.ts takes it from here). */
export const activeField = z.boolean({ error: (issue) => (issue.input === undefined ? 'is required' : 'must be true or false') });

/** `changes` of an edit: the name and/or the description, at least one. Another key (`is_super_admin`, `key` ...) is refused by its path, `changes.<key>`. */
const changesField = z
  .strictObject(
    { name: nameField.optional(), description: descriptionField.optional() },
    { error: (issue) => (issue.code === 'invalid_type' ? (issue.input === undefined ? 'is required' : 'must be an object holding the fields to change') : undefined) },
  )
  .refine((changes) => changes.name !== undefined || changes.description !== undefined, { error: 'must name at least one field to change' });

/** POST /v1/super/roles: the role to copy, the new name, an optional description, the Super Admin's password. */
export const createRoleBody = wire.strictObject({ copy_of: roleKeyField, name: nameField, description: descriptionField.optional(), password: passwordField });
/** PATCH /v1/super/roles/:key */
export const editRoleBody = wire.strictObject({ expected_updated_at: wire.timestamp, changes: changesField, password: passwordField });
/** PUT /v1/super/roles/:key/ticks */
export const ticksBody = wire.strictObject({ expected_updated_at: wire.timestamp, ticks: ticksField, password: passwordField });
/** POST /v1/super/roles/:key/active */
export const roleActiveBody = wire.strictObject({ expected_updated_at: wire.timestamp, active: activeField, password: passwordField });

export type CreateRoleBody = z.output<typeof createRoleBody>;
export type EditRoleBody = z.output<typeof editRoleBody>;
export type TicksBody = z.output<typeof ticksBody>;
export type RoleActiveBody = z.output<typeof roleActiveBody>;

const keyParams = wire.strictObject({ key: roleKeyField });

// ------------------------------------------------------------------ the statements

const NAME_SQL = 'SELECT role_key FROM roles WHERE name = ?';
const KEYS_SQL = 'SELECT role_key FROM roles';
const COUNT_SQL = 'SELECT COUNT(*) AS n FROM users WHERE role = ? AND active = 1';
const INSERT_SQL = 'INSERT INTO roles (role_key, name, description, active, ticks, created_at, updated_at, created_by, updated_by) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)';
const RENAME_SQL = 'UPDATE roles SET name = ?, description = ?, updated_at = ?, updated_by = ? WHERE role_key = ?';
const TICKS_SQL = 'UPDATE roles SET ticks = ?, updated_at = ?, updated_by = ? WHERE role_key = ?';
const ACTIVE_SQL = 'UPDATE roles SET active = ?, updated_at = ?, updated_by = ? WHERE role_key = ?';
/** Every column of the roles table, as the Node audit writer needs the row (src/db/auditShapes.ts); read only when it is the writer. */
const AUDIT_ROW_SQL = 'SELECT role_key, name, description, active, ticks, created_at, updated_at, created_by, updated_by FROM roles WHERE role_key = ?';

// ------------------------------------------------------------------ the refusals

const ownerFixed = () => new JvError('JV_NOT_ALLOWED', 'The Owner role is fixed and cannot be changed.');
const nameTaken = () => new wire.InvalidInputError('name', 'is already used by another role');

/** The stamp of a stored row as the exact 'YYYY-MM-DD HH:MM:SS.ffffff' text of the wire: the binary protocol leaves a zero fraction out, and the screen sends six decimals back. */
const stampText = (stored: unknown): string => timestampFromWire(timestampToWire(String(stored)));

const labelOf = (key: TickKey): string => TICKS.find((t) => t.key === key)?.label ?? key;

/** The refusal of a set that breaks a need: one sentence for each tick and each need it lacks, and the breaks as data for a screen that wants them. */
function needsBroken(broken: readonly { tick: TickKey; missing: readonly TickKey[] }[]): JvError {
  const quoted = (key: TickKey) => `\u201c${labelOf(key)}\u201d`;
  const words = broken.flatMap((b) => b.missing.map((need) => `${quoted(b.tick)} also needs ${quoted(need)}.`)).join(' ');
  return new JvError('JV_INVALID_INPUT', words, { details: { field: 'ticks', broken: broken.map((b) => ({ tick: b.tick, missing: [...b.missing] })) } });
}

/**
 * The set to store, from the list the caller sent: every key must be a tick of the catalogue (422 on `ticks` naming the first that is not, cut to 64 characters) and the set must hold what each of its ticks needs
 * (422 on `ticks` with the breaks). A repeat is accepted once. The result is in catalogue order, as it is stored.
 */
function checkedTicks(listed: readonly string[]): TickKey[] {
  const unknown = listed.find((key) => !isTickKey(key));
  if (unknown !== undefined) throw new wire.InvalidInputError('ticks', `contains a tick this version does not know: ${unknown.slice(0, 64)}`);
  const held = new Set(listed as readonly TickKey[]);
  const broken = brokenNeeds(held);
  if (broken.length > 0) throw needsBroken(broken);
  return TICK_KEYS.filter((key) => held.has(key));
}

// ------------------------------------------------------------------ one transaction

/** Where the unique key of a database error was met (1062), or null. A JvError keeps the driver's error as its `cause` (classifyError, src/errors.ts). Exported: the people writes map the e-mail's key the same way. */
export function duplicateOf(e: unknown): string | null {
  const cause: unknown = e instanceof JvError ? e.cause : e;
  return typeof cause === 'object' && cause !== null && Number((cause as { errno?: unknown }).errno) === 1062 ? duplicateKeyName(cause) : null;
}

/**
 * The one transaction of a write, as the Super Admin (the audit actor: the person and the role KEY). The database's own refusal of a duplicate name is the last wall of the check for a clash that is made first,
 * and is answered with the same words: the 1062 comes out of withTx as the error it classified (a business key, JV_INVALID_INPUT without a field), so it is recognised here, outside the transaction.
 */
async function transaction<T>(app: FastifyInstance, request: FastifyRequest, auth: Auth, work: (tx: Tx) => Promise<T>): Promise<T> {
  if (!app.db) throw unavailableError();
  try {
    return await withTx(txContextFor(app.db, request, { id: auth.user.id, role: auth.user.role }), work);
  } catch (e) {
    if (duplicateOf(e) === 'uq_roles_name') throw nameTaken();
    throw e;
  }
}

/** A name that another role holds is refused. `own` is the key of the role being renamed: its own name in another spelling is not a clash. */
async function assertNameFree(tx: Tx, name: string, own: string | null): Promise<void> {
  const [holder] = await tx.rows<{ role_key: string }>(NAME_SQL, [name]);
  if (holder && holder.role_key !== own) throw nameTaken();
}

/** The role as listed, or JV_STALE carrying it (the role is there: it is locked). */
async function stale(tx: Tx, grants: Grants, key: string): Promise<JvError> {
  const current = await readRole(tx, grants, key);
  return new JvError('JV_STALE', 'This role was changed by someone else. Reload it and try again.', { details: { current } });
}

/**
 * The first thing every write of an existing role does in its transaction: the row locked FOR UPDATE. No such role is 404; the Owner is refused (nothing of it is ever written); a stamp that is not the row's
 * is JV_STALE with the role as listed. The Owner comes before the stamp: the Owner is fixed whatever copy the screen holds.
 */
async function lockRole(tx: Tx, grants: Grants, key: string, expected: string): Promise<RoleRow> {
  const role = await getRole(tx, key, { forUpdate: true });
  if (!role) throw new JvError('JV_NOT_FOUND', 'There is no such role.');
  if (role.role_key === OWNER_KEY) throw ownerFixed();
  if (stampText(role.updated_at) !== timestampFromWire(expected)) throw await stale(tx, grants, role.role_key);
  return role;
}

/** The answer of a write: the role as the list shows it, read in the same transaction so that it holds what was just written. */
async function answer(tx: Tx, grants: Grants, key: string): Promise<{ role: WireRole }> {
  const role = await readRole(tx, grants, key);
  if (!role) throw new Error(`the role ${key} is gone after its own write`);
  return { role };
}

/** The row as the Node audit writer needs it, and only then: with the triggers (L1 (a)) nothing is written here, so nothing is read for it. */
async function auditedRow(tx: Tx, key: string): Promise<AuditedRow | null> {
  if (tx.auditMode !== 'node') return null;
  const [row] = await tx.rows<AuditedRow>(AUDIT_ROW_SQL, [key]);
  return row ?? null;
}

/** The audit row of a change of the roles table, right after the statement (mechanism (b) of L1; `before` is null for an insert). */
async function auditRole(tx: Tx, key: string, before: AuditedRow | null): Promise<void> {
  if (tx.auditMode !== 'node') return;
  const after = await auditedRow(tx, key);
  if (!after) throw new Error(`the role ${key} is gone after its own write`);
  await auditChange(tx, { table: 'roles', rowId: key, action: before === null ? 'insert' : 'update', before, after });
}

/** The known ticks of a stored role as the list shows them: the Owner's are all 32, any other's are its column cut to the keys this version knows, in catalogue order (R3, R4). */
const ticksOf = (role: RoleRow): TickKey[] => sortedTicks(grantsOf({ roleKey: role.role_key, roleTicks: role.ticks, isSuperAdmin: false }));

/** How many times a create is run again when the key it chose was taken at that very moment by another create. */
const KEY_ATTEMPTS = 3;

// ------------------------------------------------------------------ create

/** POST /v1/super/roles: a copy of any role under a new name. */
export async function createRole(app: FastifyInstance, request: FastifyRequest, auth: Auth, body: CreateRoleBody): Promise<{ role: WireRole }> {
  const grants = auth.user.grants;
  assertMayCall(grants, 'super:roles.create'); // X0 item 2: the wrapper has checked; a service function checks again
  const name = cleanRoleName(body.name);
  const description = cleanRoleDescription(body.description ?? '');
  await confirmPassword(app, request, auth, body.password);

  for (let attempt = 1; ; attempt++) {
    try {
      return await transaction(app, request, auth, async (tx) => {
        const source = await getRole(tx, body.copy_of, { forUpdate: true });
        if (!source) throw new wire.InvalidInputError('copy_of', 'is not a role');
        await assertNameFree(tx, name, null);
        const taken = new Set((await tx.rows<{ role_key: string }>(KEYS_SQL)).map((r) => r.role_key));
        const key = makeRoleKey(name, taken);
        const ticks = closeOverNeeds(ticksOf(source)); // what the source holds that this version knows, and what those need; the Owner gives all 32
        const at = app.clock.read().timestamp; // created_at and updated_at from one reading of the API's clock (S6)
        await tx.run(INSERT_SQL, [key, name, description, JSON.stringify(ticks), at, at, auth.user.id, auth.user.id]);
        await auditRole(tx, key, null);
        await writeEvent(tx, { table: 'roles', rowId: key, facts: { event: 'role_created', role: key, name, copied_from: source.role_key } });
        return answer(tx, grants, key);
      });
    } catch (e) {
      if (duplicateOf(e) === 'PRIMARY' && attempt < KEY_ATTEMPTS) continue; // another create took the key a moment ago; the transaction was rolled back: choose again among the keys that exist now
      throw e;
    }
  }
}

// ------------------------------------------------------------------ rename and describe

/** PATCH /v1/super/roles/:key: the name and/or the description of a role. `params` is the route's `request.params`. */
export async function editRole(app: FastifyInstance, request: FastifyRequest, auth: Auth, params: unknown, body: EditRoleBody): Promise<{ role: WireRole }> {
  const grants = auth.user.grants;
  assertMayCall(grants, 'super:roles.edit');
  const key = wire.parseInput(keyParams, params).key;
  const name = body.changes.name === undefined ? undefined : cleanRoleName(body.changes.name);
  const description = body.changes.description === undefined ? undefined : cleanRoleDescription(body.changes.description);
  await confirmPassword(app, request, auth, body.password);

  return transaction(app, request, auth, async (tx) => {
    const role = await lockRole(tx, grants, key, body.expected_updated_at);
    const newName = name !== undefined && name !== role.name ? name : undefined;
    const newDescription = description !== undefined && description !== role.description ? description : undefined;
    if (newName === undefined && newDescription === undefined) return answer(tx, grants, role.role_key); // the same words: nothing is written, the stamp stays
    if (newName !== undefined) await assertNameFree(tx, newName, role.role_key);

    const before = await auditedRow(tx, role.role_key);
    await tx.run(RENAME_SQL, [newName ?? role.name, newDescription ?? role.description, app.clock.read().timestamp, auth.user.id, role.role_key]);
    await auditRole(tx, role.role_key, before);
    if (newName !== undefined) await writeEvent(tx, { table: 'roles', rowId: role.role_key, facts: { event: 'role_renamed', role: role.role_key, name: newName, from: role.name, to: newName } });
    if (newDescription !== undefined) await writeEvent(tx, { table: 'roles', rowId: role.role_key, facts: { event: 'role_described', role: role.role_key, name: newName ?? role.name } });
    return answer(tx, grants, role.role_key);
  });
}

// ------------------------------------------------------------------ ticks

/** PUT /v1/super/roles/:key/ticks: the whole set of ticks of a role. */
export async function setRoleTicks(app: FastifyInstance, request: FastifyRequest, auth: Auth, params: unknown, body: TicksBody): Promise<{ role: WireRole }> {
  const grants = auth.user.grants;
  assertMayCall(grants, 'super:roles.ticks');
  const key = wire.parseInput(keyParams, params).key;
  const wanted = checkedTicks(body.ticks);
  await confirmPassword(app, request, auth, body.password);

  return transaction(app, request, auth, async (tx) => {
    const role = await lockRole(tx, grants, key, body.expected_updated_at);
    const held = ticksOf(role); // what the list shows: a key this version does not know is neither on nor off, and the save drops it from the column
    const turnedOn = wanted.filter((tick) => !held.includes(tick));
    const turnedOff = held.filter((tick) => !wanted.includes(tick));
    if (turnedOn.length === 0 && turnedOff.length === 0) return answer(tx, grants, role.role_key); // the same set: nothing is written, the stamp stays

    const before = await auditedRow(tx, role.role_key);
    await tx.run(TICKS_SQL, [JSON.stringify(wanted), app.clock.read().timestamp, auth.user.id, role.role_key]);
    await auditRole(tx, role.role_key, before);
    await writeEvent(tx, { table: 'roles', rowId: role.role_key, facts: { event: 'role_ticks_changed', role: role.role_key, name: role.name, turned_on: turnedOn, turned_off: turnedOff } });
    return answer(tx, grants, role.role_key);
  });
}

// ------------------------------------------------------------------ switch off and on

/** POST /v1/super/roles/:key/active: switch a role off (no active person may hold it) or on. */
export async function setRoleActive(app: FastifyInstance, request: FastifyRequest, auth: Auth, params: unknown, body: RoleActiveBody): Promise<{ role: WireRole }> {
  const grants = auth.user.grants;
  assertMayCall(grants, 'super:roles.active');
  const key = wire.parseInput(keyParams, params).key;
  await confirmPassword(app, request, auth, body.password);

  return transaction(app, request, auth, async (tx) => {
    const role = await lockRole(tx, grants, key, body.expected_updated_at);
    if ((Number(role.active) === 1) === body.active) return answer(tx, grants, role.role_key); // it is so already: nothing is written, the stamp stays
    if (!body.active) {
      // DESIGN 6.6 rule 4. A plain read, after the lock above: everything that gives a login this role locks this row first, so a call that is giving it waits for this one (and then finds the role off),
      // and a call that has finished has committed its login, which is counted here.
      const [held] = await tx.rows<{ n: number | string }>(COUNT_SQL, [role.role_key]);
      const people = Number(held?.n ?? 0);
      if (people > 0) throw new JvError('JV_NOT_ALLOWED', `${people} people still have this role. Move them to another role first.`);
    }
    const before = await auditedRow(tx, role.role_key);
    await tx.run(ACTIVE_SQL, [body.active ? 1 : 0, app.clock.read().timestamp, auth.user.id, role.role_key]);
    await auditRole(tx, role.role_key, before);
    await writeEvent(tx, { table: 'roles', rowId: role.role_key, facts: { event: body.active ? 'role_switched_on' : 'role_switched_off', role: role.role_key, name: role.name } });
    return answer(tx, grants, role.role_key);
  });
}
