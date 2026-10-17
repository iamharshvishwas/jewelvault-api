// U3: the temporary password the admin door makes for a new user or after a reset. It is random, shown once, and replaced by the user's own at the first sign-in (U11), so it is written to be
// copied from a terminal onto a phone: 16 characters in four groups of four, from an alphabet without the look-alikes (no 0 O 1 l I), 57 symbols, about 93 bits.
import { randomInt } from 'node:crypto';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
const GROUPS = 4;
const GROUP_LENGTH = 4;

/** A new temporary password such as `Hk7p-Qm3x-Za9d-Tr4v`. randomInt draws without modulo bias from the system's random source. */
export function newTemporaryPassword(): string {
  const groups: string[] = [];
  for (let g = 0; g < GROUPS; g++) {
    let group = '';
    for (let i = 0; i < GROUP_LENGTH; i++) group += ALPHABET[randomInt(ALPHABET.length)];
    groups.push(group);
  }
  return groups.join('-');
}
