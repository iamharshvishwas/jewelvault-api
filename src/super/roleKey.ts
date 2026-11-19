// Task 13 of the access plan (R2; DESIGN.md 6.1): THE WORDS AND THE KEY OF A ROLE. Three pure functions, no database and no request: the Super Admin's role writes (src/super/roles.ts) ask them before they ask
// the database anything.
//
//   cleanRoleName         the name as it is stored: trimmed, inner white space folded to one space, and refused with 422 on `name` when it is empty, over 40 characters, without a letter or a number, or holds a
//                         control character (U+0000 to U+001F and U+007F to U+009F: the terminal door prints a role name raw in a sentence, so a control character in it could rewrite the line). A zero-width space
//                         is NOT refused: whether two names are the same name is the roles table's question (its collation ignores case, accents, trailing spaces and such a space), asked of the database.
//   cleanRoleDescription  the description as it is stored: trimmed, at most 200 characters (the column), no control character; 422 on `description` otherwise. It may be empty.
//   makeRoleKey           the key of a new role (R2), made once from its first name and never changed: the lower-case letters of the name (an accent goes to its letter), every other run of characters one hyphen,
//                         the ends trimmed, cut to 10 characters, `role` when nothing is left; when that key is taken a hyphen and one random lower-case letter are added (so 12 characters at most) until one is
//                         free. The key always matches ROLE_KEY_PATTERN (`^[a-z][a-z-]{0,11}$`): it fits `users.role` and the actor role of the audit rows. The keys of the system actors of the Activity Log (RESERVED_KEYS)
//                         count as taken, so that no role is mistaken for them on the screen.
//
// Characters are counted as the database counts them (code points, not UTF-16 units): a name of 40 emoji is 40 characters.
import { randomInt } from 'node:crypto';
import * as wire from '../wire/zod.js';

/** The width of `roles.name` and `roles.description`, in characters. */
export const NAME_MAX = 40;
export const DESCRIPTION_MAX = 200;

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;
const LETTER_OR_NUMBER = /[\p{L}\p{N}]/u;
const characters = (text: string): number => [...text].length;

/** The name as stored, or 422 on `name`. */
export function cleanRoleName(name: string): string {
  const trimmed = name.trim();
  if (CONTROL.test(trimmed)) throw new wire.InvalidInputError('name', 'must not contain control characters');
  const folded = trimmed.replace(/\s+/gu, ' ');
  if (folded === '') throw new wire.InvalidInputError('name', 'is required');
  if (characters(folded) > NAME_MAX) throw new wire.InvalidInputError('name', `must be at most ${NAME_MAX} characters`);
  if (!LETTER_OR_NUMBER.test(folded)) throw new wire.InvalidInputError('name', 'must contain a letter or a number');
  return folded;
}

/** The description as stored (possibly the empty text), or 422 on `description`. */
export function cleanRoleDescription(description: string): string {
  const trimmed = description.trim();
  if (CONTROL.test(trimmed)) throw new wire.InvalidInputError('description', 'must not contain control characters');
  if (characters(trimmed) > DESCRIPTION_MAX) throw new wire.InvalidInputError('description', `must be at most ${DESCRIPTION_MAX} characters`);
  return trimmed;
}

const LETTERS = 'abcdefghijklmnopqrstuvwxyz';
const drawLetter = (): string => LETTERS[randomInt(LETTERS.length)];
/** How many times a random letter is tried before the letters are walked in order. */
const RANDOM_TRIES = 12;

/**
 * Keys that no role may have: the `actor_role` values of the system actors of the Activity Log (audit_log.actor_role): `sql` (a hand edit in phpMyAdmin, no actor: src/db/audit.ts), `job` (the hourly tick) and `admin-cli`
 * (the terminal door). A role with one of them would be shown beside those actors as if it were one. A name that folds to one is treated like a taken key and gets a letter.
 */
export const RESERVED_KEYS: ReadonlySet<string> = new Set(['sql', 'job', 'admin-cli']);

/** The key a name gives before any clash: its letters, the rest hyphens, trimmed, at most 10 characters, `role` when none is left. */
function baseKey(name: string): string {
  const folded = name
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '') // an accent goes: the key of "Cafe" and of "Caf" with its accent is the same
    .toLowerCase()
    .replace(/[^a-z]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const cut = folded.slice(0, 10).replace(/-+$/, ''); // a cut may end on a hyphen
  return cut === '' ? 'role' : cut;
}

/** The tails tried after the base when it is taken: every letter, then every pair of letters. */
function* tails(): Generator<string> {
  for (const a of LETTERS) yield a;
  for (const a of LETTERS) for (const b of LETTERS) yield a + b;
}

/**
 * The key of a new role named `name`, free among `taken` (the keys that exist, all lower case) and not one of RESERVED_KEYS. `randomLetter` is the source of the letter that follows a clash (a test passes its own).
 * It always ends: after a dozen random tries the letters are tried in order, then pairs of letters; a name whose keys are ALL taken (702 clashes) is an Error, which no shop reaches.
 */
export function makeRoleKey(name: string, taken: ReadonlySet<string>, randomLetter: () => string = drawLetter): string {
  const unavailable = (key: string): boolean => taken.has(key) || RESERVED_KEYS.has(key);
  const base = baseKey(name);
  if (!unavailable(base)) return base;
  for (let tries = 0; tries < RANDOM_TRIES; tries++) {
    const key = `${base}-${randomLetter()}`;
    if (!unavailable(key)) return key;
  }
  for (const tail of tails()) {
    const key = `${base.slice(0, 11 - tail.length).replace(/-+$/, '')}-${tail}`; // 12 characters at most whatever the length of the tail
    if (!unavailable(key)) return key;
  }
  throw new Error('every role key of this name is taken');
}
