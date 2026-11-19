// R1, R2, R3 of the plan: A ROLE ROW READ BY ITS KEY, for the code that puts a role on a login: the admin door (Task 10) and the People & Roles calls of the Super Admin (Tasks 13 and 14). Three things live here and
// nothing else: the shape of a role key in a request (roleKeyField), the read of one row of `roles` (getRole), and the check that a role may be given to a login (assertActiveRole). The ticks of a role are read
// by the session (src/permissions/session.ts) and turned into Grants (grants.ts); this file never looks at them.
//
// THE STORED KEY. `fk_users_role` and the lookup `WHERE role_key = ?` compare the key under the collation of the table, which ignores case: the text `Biller` finds the row of `biller`, and the foreign key lets it
// in as well. A caller that wrote the text it was SENT would store `Biller` in `users.role`, which is a key that is not the Owner's on the day it names the Owner, and one more spelling in the Activity Log and in
// the access fingerprint. So a caller writes the `role_key` of the row these functions return, never the text it was given. roleKeyField refuses a capital in a request already; this is the second guard, at the write.
import { z } from 'zod';
import type { Tx } from '../db/tx.js';
import * as wire from '../wire/zod.js';
import { ROLE_KEY_PATTERN } from './ticks.js';

/** One row of `roles` as the driver gives it: `active` is 0 or 1 (a number or its text) and `ticks` is the JSON column as stored (grantsOf reads it, and ignores what it cannot read). */
export interface RoleRow {
  role_key: string;
  name: string;
  description: string;
  active: number | string;
  ticks: unknown;
  updated_at: string;
}

/**
 * R2: the field of a request that holds a role key: a lower-case letter, then up to eleven lower-case letters or hyphens (ROLE_KEY_PATTERN). It is a check of SHAPE only: it does not trim or lower-case what it
 * is given, so a key with a capital or a space is refused (422 on the field) instead of being quietly mended. Whether the role exists and is switched on is assertActiveRole's question, asked inside the transaction.
 */
export const roleKeyField = z.string({ error: (issue) => (issue.input === undefined ? 'is required' : 'must be text') }).regex(ROLE_KEY_PATTERN, 'must be a role key');

const COLUMNS = 'role_key, name, description, active, ticks, updated_at';
const BY_KEY = `SELECT ${COLUMNS} FROM roles WHERE role_key = ?`;
const BY_KEY_LOCKED = `${BY_KEY} FOR UPDATE`;

/**
 * The row of the role with this key, or undefined when there is none. A switched-off role is returned as it is (`active` says). The key is found whatever its letter case (see THE STORED KEY above): write
 * `role_key` of the row. `forUpdate` locks the row until the transaction ends, for a write that changes the role itself or must not see it changed meanwhile (a stale-edit check, a switch-off).
 */
export async function getRole(tx: Tx, key: string, opts: { forUpdate?: boolean } = {}): Promise<RoleRow | undefined> {
  const [row] = await tx.rows<RoleRow>(opts.forUpdate ? BY_KEY_LOCKED : BY_KEY, [key]);
  return row;
}

/**
 * The row of an ACTIVE role, or the refusal: 422 on `field` ("role" unless the caller names another field, `copy_of` for example) with "is not an active role", for a key that has no row and for a role that is
 * switched off alike. It is the check made before a login is given a role: a login whose role is switched off is refused with a 401 on every call (the session), so it must never be made.
 * The row is locked FOR UPDATE until the transaction ends: a role cannot be switched off between this check and the write that depends on it (the switch-off takes the same lock, then counts the people who hold the role).
 * Callers write the returned `role_key`, never the text they were given (THE STORED KEY).
 */
export async function assertActiveRole(tx: Tx, key: string, field = 'role'): Promise<RoleRow> {
  const role = await getRole(tx, key, { forUpdate: true });
  if (!role || Number(role.active) !== 1) throw new wire.InvalidInputError(field, 'is not an active role');
  return role;
}
