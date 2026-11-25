// DESIGN.md 6.3, 6.5 and the access plan's Task 12: THE READS OF THE SUPER ADMIN'S OWN API. What the People & Roles screen asks to draw itself: the catalogue of the 32 ticks, every login, every role.
// Three functions, one for each read row of the matrix (`super:ticks`, `super:people.list`, `super:roles.list`); each answers the body of its call as it goes on the wire, and each is plain reading:
// no statement here locks, writes, or leaves an audit row or an event. The writes of the screen (roles: src/super/roles.ts, Task 13; people: src/super/people.ts, Task 14) are other files' business; the two things they
// take from this file are readRole and readPerson, the read of ONE role and of ONE person over the very SELECT and mapping of readRoles and readPeople, so that the answer of a write (and the `current` of a stale
// role) can never differ from what the list shows.
//
//   tickCatalogue  { groups, ticks }  the six groups in the order of the screen and the 32 ticks in catalogue order, each with its words, its help text, whether it is sensitive and its DIRECT needs (the
//                  screen closes them over their own needs). The words are written once, in src/permissions/ticks.ts; this copies them out.
//   readPeople     { people }         every login, switched off or not, ordered by when it was made (created_at, then id): its role's key and NAME now, whether it is active and whether it is the
//                  Super Admin, its last sign-in and the stamp of its row. Never a password hash, a ticket, a session or the must-change flag: the columns are named one by one.
//   readRoles      { roles }          every role, the Owner first and then by when it was made (created_at, then key): name, description, whether it is active, whether it is FIXED (the Owner only), its
//                  ticks in catalogue order and how many ACTIVE logins hold it. A role's ticks are what its column holds as far as this version knows the keys (an unknown key, a repeat or a bad value is
//                  ignored, never a crash: R4, Review Focus 2); the Owner's are all 32 whatever its column says (R3). `updated_at` is the text a write names as `expected_updated_at` (R9).
//   readRole       one role, as readRoles lists it, or undefined: the answer of every role write (and `details.current` of a stale one), read in the write's own transaction so that it holds what was just written.
//   readPerson     one person, as readPeople lists that person, or undefined: the answer of every people write, read in the write's own transaction the same way.
//
// EVERY READ CHECKS THE CALLER AGAIN at its start (X0 item 2, defence in depth): it takes the person's Grants and refuses, before it asks the database anything, grants that are not the Super Admin's.
// The wrapper of route.ts has refused such a caller already; this is the second wall, the same sentence. The statements are literal and carry no value of the client's: the tables are small (a shop's
// people and roles) and are read whole, so there is no page and no query string (the route refuses a key it does not know).
import type { Reader } from '../db/tx.js';
import { type Grants, grantsOf, sortedTicks } from '../permissions/grants.js';
import { assertMayCall } from '../permissions/route.js';
import { OWNER_KEY, TICKS, TICK_GROUPS, type TickGroup, type TickKey } from '../permissions/ticks.js';
import { formatUuid, timestampToWire } from '../wire/format.js';

// ------------------------------------------------------------------ the answers

/** One tick as the roles screen draws it (the same six things as the catalogue: `needs` are the DIRECT needs). */
export interface WireTick {
  key: TickKey;
  group: TickGroup;
  label: string;
  help: string | null;
  sensitive: boolean;
  needs: TickKey[];
}

/** `GET /v1/super/ticks`. */
export interface TickCatalogue {
  groups: TickGroup[];
  ticks: WireTick[];
}

/** One login as the People list shows it. */
export interface WirePerson {
  id: string;
  full_name: string;
  email: string;
  /** the key of the login's role (`users.role`) */
  role: string;
  /** that role's name now; the key itself for a login whose role has no row (the foreign key forbids it, so only a hand edit can make one: the list still shows the person) */
  role_name: string;
  active: boolean;
  is_super_admin: boolean;
  /** UTC text with six decimals and a Z, or null for a login that never signed in */
  last_login_at: string | null;
  updated_at: string;
}

/** `GET /v1/super/people`. */
export interface PeopleList {
  people: WirePerson[];
}

/** One role as the Roles list shows it. */
export interface WireRole {
  /** the key never changes (a rename changes `name` only) */
  key: string;
  name: string;
  description: string;
  active: boolean;
  /** true for the Owner only: that role cannot be changed */
  fixed: boolean;
  /** catalogue order; the Owner's are all 32 */
  ticks: TickKey[];
  /** how many ACTIVE logins hold the role */
  people: number;
  /** the stamp a write names as `expected_updated_at` */
  updated_at: string;
}

/** `GET /v1/super/roles`. */
export interface RolesList {
  roles: WireRole[];
}

// ------------------------------------------------------------------ the statements

// The columns are named one by one (A4: never SELECT *), so a column added to `users` later (a hash is one already) is never sent by chance. LEFT JOIN: a login whose role row is missing is still a row of the list.
const PEOPLE_SELECT =
  'SELECT u.id, u.full_name, u.email, u.role, r.name AS role_name, u.active, u.is_super_admin, u.last_login_at, u.updated_at FROM users u LEFT JOIN roles r ON r.role_key = u.role';
const PEOPLE_SQL = `${PEOPLE_SELECT} ORDER BY u.created_at, u.id`;
const PERSON_SQL = `${PEOPLE_SELECT} WHERE u.id = ?`;
// `people` is the number of ACTIVE logins that hold the role, counted by the foreign key's own index on users.role.
const ROLE_SELECT =
  'SELECT r.role_key, r.name, r.description, r.active, r.ticks, r.updated_at, (SELECT COUNT(*) FROM users u WHERE u.role = r.role_key AND u.active = 1) AS people FROM roles r';
const ROLES_SQL = `${ROLE_SELECT} ORDER BY r.created_at, r.role_key`;
const ROLE_SQL = `${ROLE_SELECT} WHERE r.role_key = ?`;

interface PersonRow {
  id: string;
  full_name: string;
  email: string;
  role: string;
  role_name: string | null;
  active: number | string;
  is_super_admin: number | string;
  last_login_at: string | null;
  updated_at: string;
}

interface RoleRow {
  role_key: string;
  name: string;
  description: string;
  active: number | string;
  /** the JSON column, parsed or as text, as the driver gives it */
  ticks: unknown;
  updated_at: string;
  /** COUNT(*) comes back as BIGINT text */
  people: number | string;
}

// ------------------------------------------------------------------ the three reads

/** `GET /v1/super/ticks`: the catalogue, copied out so that nothing of the module's own lists is shared with a caller. */
export function tickCatalogue(grants: Grants): TickCatalogue {
  assertMayCall(grants, 'super:ticks');
  return {
    groups: [...TICK_GROUPS],
    ticks: TICKS.map((t) => ({ key: t.key, group: t.group, label: t.label, help: t.help, sensitive: t.sensitive, needs: [...t.needs] })),
  };
}

/** One row of the statements above as the wire has it: the one mapping of the list and of the answers of the people writes. */
function wirePerson(r: PersonRow): WirePerson {
  return {
    id: formatUuid(r.id),
    full_name: r.full_name,
    email: r.email,
    role: r.role,
    role_name: r.role_name ?? r.role,
    active: Number(r.active) === 1,
    is_super_admin: Number(r.is_super_admin) === 1,
    last_login_at: r.last_login_at === null ? null : timestampToWire(r.last_login_at),
    updated_at: timestampToWire(r.updated_at),
  };
}

/** `GET /v1/super/people`: every login, oldest first. */
export async function readPeople(db: Reader, grants: Grants): Promise<PeopleList> {
  assertMayCall(grants, 'super:people.list');
  const rows = await db.rows<PersonRow>(PEOPLE_SQL);
  return { people: rows.map(wirePerson) };
}

/**
 * One person as the list shows that person (the same statement and the same mapping), or undefined when there is no such login. The people writes read it inside their own transaction, after the write, for their
 * answer. It is the same wall as the list: grants that are not the Super Admin's are refused before the database is asked.
 */
export async function readPerson(db: Reader, grants: Grants, id: string): Promise<WirePerson | undefined> {
  assertMayCall(grants, 'super:people.list');
  const [row] = await db.rows<PersonRow>(PERSON_SQL, [id]);
  return row === undefined ? undefined : wirePerson(row);
}

/** One row of the statements above as the wire has it: the one mapping of the list and of the answers of the role writes. */
function wireRole(r: RoleRow): WireRole {
  return {
    key: r.role_key,
    name: r.name,
    description: r.description,
    active: Number(r.active) === 1,
    fixed: r.role_key === OWNER_KEY,
    // the ticks as a person holding this role would hold them: the Owner key is every tick, any other key is its column cut to the keys this version knows, once each, in catalogue order (R3, R4)
    ticks: sortedTicks(grantsOf({ roleKey: r.role_key, roleTicks: r.ticks, isSuperAdmin: false })),
    people: Number(r.people),
    updated_at: timestampToWire(r.updated_at),
  };
}

/** `GET /v1/super/roles`: the Owner first, then the made roles in the order they were made (the two built-in roles of the seed share one instant, so their keys tell them apart). */
export async function readRoles(db: Reader, grants: Grants): Promise<RolesList> {
  assertMayCall(grants, 'super:roles.list');
  const rows = await db.rows<RoleRow>(ROLES_SQL);
  const wired = rows.map(wireRole);
  return { roles: [...wired.filter((r) => r.fixed), ...wired.filter((r) => !r.fixed)] };
}

/**
 * One role as the list shows it (the same statement and the same mapping), or undefined when there is no such role. The role writes read it inside their own transaction, after the write, for their answer, and
 * before it for `details.current` of a stale one. It is the same wall as the list: grants that are not the Super Admin's are refused before the database is asked.
 */
export async function readRole(db: Reader, grants: Grants, key: string): Promise<WireRole | undefined> {
  assertMayCall(grants, 'super:roles.list');
  const [row] = await db.rows<RoleRow>(ROLE_SQL, [key]);
  return row === undefined ? undefined : wireRole(row);
}
