// R4, R5 of the plan: GRANTS, what a person may do, as one value that every check of the permission matrix receives. A person's grants are the ticks of their role and whether they are the Super
// Admin. The Owner key or the Super Admin flag gives every tick (the Owner's ticks always come from code, never from the `roles.ticks` column, R3). A tick key this code does not know (a later
// release dropped it, or a hand edit) is ignored: grantsOf never throws on a bad column, and the other ticks still work.
//
// The access fingerprint (R5) is how the website learns that what a person may do has changed: only the API computes it, the website compares the text.
import { createHash } from 'node:crypto';
import { OWNER_KEY, TICK_KEYS, type TickKey, isTickKey } from './ticks.js';

export interface Grants {
  readonly ticks: ReadonlySet<TickKey>;
  readonly isSuperAdmin: boolean;
}

/**
 * The ticks of one person, as a set that nobody can change. `Object.freeze` does not freeze a Set, and `ReadonlySet` stops `.add` at compile time only (a cast gets round it): one caller could widen what
 * every other holder of the same value may do. This has no add, delete or clear, and the Set it reads from is private to it.
 */
class TickSet implements ReadonlySet<TickKey> {
  readonly #held: ReadonlySet<TickKey>;

  constructor(keys: Iterable<TickKey>) {
    this.#held = new Set(keys);
    Object.freeze(this);
  }

  get size(): number {
    return this.#held.size;
  }

  has(key: TickKey): boolean {
    return this.#held.has(key);
  }

  forEach(callback: (value: TickKey, key: TickKey, set: ReadonlySet<TickKey>) => void, thisArg?: unknown): void {
    this.#held.forEach((key) => callback.call(thisArg, key, key, this));
  }

  entries(): SetIterator<[TickKey, TickKey]> {
    return this.#held.entries();
  }

  keys(): SetIterator<TickKey> {
    return this.#held.values();
  }

  values(): SetIterator<TickKey> {
    return this.#held.values();
  }

  [Symbol.iterator](): SetIterator<TickKey> {
    return this.#held.values();
  }
}

/** A new Grants value of its own: its set of ticks is made here and shared with nobody, and neither it nor the set can be changed afterwards. */
const grantsFrom = (ticks: Iterable<TickKey>, isSuperAdmin: boolean): Grants => Object.freeze({ ticks: new TickSet(ticks), isSuperAdmin });

/** No tick and no flag: the open rows of the matrix and nothing else. */
export const NO_GRANTS: Grants = grantsFrom([], false);

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

/**
 * R4: the grants of a role key, its stored ticks and the Super Admin flag. Unknown keys and a column that is not a list are ignored; this never throws. Every call returns a value of its own, so
 * what one caller does with its grants can never change what another is given.
 */
export function grantsOf(i: { roleKey: string; roleTicks: unknown; isSuperAdmin: boolean }): Grants {
  const isSuperAdmin = i.isSuperAdmin === true;
  if (isSuperAdmin || i.roleKey === OWNER_KEY) return grantsFrom(TICK_KEYS, isSuperAdmin);
  return grantsFrom(listOf(i.roleTicks).filter(isTickKey), isSuperAdmin);
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
