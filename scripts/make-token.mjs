#!/usr/bin/env node
// U3, NODE-DESIGN 2.8 and 7: `npm run make-token` (or `npm run make-token -- job`) makes ONE random token and prints it ONCE, with its hash for hPanel.
//
//   the token  32 random bytes from the system's random source, written as 43 characters (base64url). The admin command asks for it when you run it; the job schedulers send it as a bearer token.
//   the hash   the SHA-256 of the token in hex, 64 characters. It is what the API holds (JV_ADMIN_TOKEN_HASH for the admin door, JV_JOB_TOKEN_HASH for the job door) and compares with the token in
//              constant time; it is not the token and cannot be turned back into it.
//
// This file writes to the terminal and to nothing else: it does not touch the disk, the environment or the network, so the token exists only on the screen and in whatever the person copies it to.
import { createHash, randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';

/** The variable that holds the hash, by the door the token is for. */
export const VARIABLES = Object.freeze({ admin: 'JV_ADMIN_TOKEN_HASH', job: 'JV_JOB_TOKEN_HASH' });

/** The hash the API holds for a token: the SHA-256 of its text, in hex. */
export const hashToken = (token) => createHash('sha256').update(token, 'utf8').digest('hex');

/** A new random token and its hash. */
export function makeToken() {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashToken(token) };
}

const USAGE = 'Usage: npm run make-token [-- admin|job]\n  admin (the default) makes the token for the admin door, job the one for the job schedulers.\n';

/** Runs the command. `out` and `err` take text; returns the exit code. */
export function main(argv, out, err) {
  const kind = argv.length === 0 ? 'admin' : argv[0];
  if (argv.length > 1 || !Object.hasOwn(VARIABLES, kind)) {
    err(USAGE);
    return 1;
  }
  const { token, hash } = makeToken();
  const variable = VARIABLES[kind];
  out(
    [
      `New ${kind} token. It is shown once and is saved nowhere: copy it now and keep it where only you can read it.`,
      '',
      token,
      '',
      `Its hash. Put this in hPanel (the Node.js app, environment variables) as ${variable}. It is not secret, and it is useless without the token:`,
      '',
      hash,
      '',
    ].join('\n'),
  );
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2), (t) => process.stdout.write(t), (t) => process.stderr.write(t));
}
