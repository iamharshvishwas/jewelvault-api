// The three built-in roles as the tests meet them. Their keys come from the catalogue (BUILTIN_TICKS, src/permissions/ticks.ts), so there is one list of them and no second one to keep in step with it; the
// grants of a role are built the way the session builds them (grantsOf over the role's ticks and no Super Admin flag), so a test asks the permission code about a role exactly as a request does. The code under
// src/ takes Grants only: a role key is never an argument of a permission check (T-D10b in tests/api/permissions-route.test.ts).
import { type Grants, grantsOf } from '../../src/permissions/grants';
import { BUILTIN_TICKS } from '../../src/permissions/ticks';

/** 'owner' | 'biller' | 'staff': the keys of BUILTIN_TICKS. */
export type BuiltinRole = keyof typeof BUILTIN_TICKS;

/** The built-in role keys, in the order of the catalogue. */
export const BUILTIN_ROLES = Object.keys(BUILTIN_TICKS) as BuiltinRole[];

/** The grants of a built-in role: its ticks from the catalogue (the Owner's come from its key) and no Super Admin flag. A new value on every call. */
export const builtinGrants = (role: BuiltinRole): Grants => grantsOf({ roleKey: role, roleTicks: BUILTIN_TICKS[role], isSuperAdmin: false });
