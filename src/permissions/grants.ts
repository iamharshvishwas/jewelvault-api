// R4, R5 of the plan: GRANTS, what a person may do, as one value that every check of the permission matrix receives. A person's grants are the ticks of their role and whether they are the Super
// Admin. The Owner key or the Super Admin flag gives every tick (the Owner's ticks always come from code, never from the `roles.ticks` column, R3). A tick key this code does not know (a later
// release dropped it, or a hand edit) is ignored: grantsOf never throws on a bad column, and the other ticks still work.
//
// The access fingerprint (R5) is how the website learns that what a person may do has changed: only the API computes it, the website compares the text.
import { createHash } from 'node:crypto';
import { BUILTIN_TICKS, OWNER_KEY, TICK_KEYS, type TickKey, isTickKey } from './ticks.js';

export interface Grants {
  readonly ticks: ReadonlySet<TickKey>;
  readonly isSuperAdmin: boolean;
}

/** No tick and no flag: the open rows of the matrix and nothing else. */
export const NO_GRANTS: Grants = Object.freeze({ ticks: new Set<TickKey>(), isSuperAdmin: false });

/** The `roles.ticks` column as the driver gives it (parsed, or the JSON text), as a list; anything else is an empty list. */
function listOf(column: unknown): unknown[] {
  if (Array.isArray(column)) return column;
  if (typeof column !== 'string') return [];
  try {
    const parsed: unknown = JSON.parse(column);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** R4: the grants of a role key, its stored ticks and the Super Admin flag. Unknown keys and a column that is not a list are ignored; this never throws. */
export function grantsOf(i: { roleKey: string; roleTicks: unknown; isSuperAdmin: boolean }): Grants {
  const isSuperAdmin = i.isSuperAdmin === true;
  if (isSuperAdmin || i.roleKey === OWNER_KEY) return { ticks: new Set(TICK_KEYS), isSuperAdmin };
  return { ticks: new Set(listOf(i.roleTicks).filter(isTickKey)), isSuperAdmin };
}

const BUILTIN_GRANTS: ReadonlyMap<string, Grants> = new Map(
  Object.entries(BUILTIN_TICKS).map(([roleKey, ticks]) => [roleKey, grantsOf({ roleKey, roleTicks: ticks, isSuperAdmin: false })]),
);

/**
 * TEMPORARY (remove in Task 11): the grants of one of the three built-in role keys, from BUILTIN_TICKS; any other text has NO_GRANTS. It lets the callers that still pass the session's role key
 * (a string) keep working until Tasks 5 to 11 hand them the Grants the session reads.
 */
export function grantsOfBuiltin(roleKey: string): Grants {
  return BUILTIN_GRANTS.get(roleKey) ?? NO_GRANTS;
}

export const hasTick = (g: Grants, t: TickKey): boolean => g.ticks.has(t);

export const hasAnyTick = (g: Grants, ts: readonly TickKey[]): boolean => ts.some((t) => g.ticks.has(t));

/** The ticks held, in catalogue order. */
export const sortedTicks = (g: Grants): TickKey[] => TICK_KEYS.filter((t) => g.ticks.has(t));

/** R5: the first 16 hex characters of the SHA-256 of [role key, ticks in catalogue order, flag]. It changes when any of the three does, and with nothing else. */
export function accessFingerprint(roleKey: string, g: Grants): string {
  return createHash('sha256')
    .update(JSON.stringify([roleKey, sortedTicks(g), g.isSuperAdmin]))
    .digest('hex')
    .slice(0, 16);
}
