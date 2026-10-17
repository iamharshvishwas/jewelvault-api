#!/usr/bin/env node
// U3, NODE-DESIGN 2.8: `npm run admin -- <command>` is how Harsh makes accounts. It asks for what it needs, calls the admin door of the API over HTTPS with the token he types, and prints what the door
// answers. There is no SQL here and no database password on his Mac: the door is the only thing this file talks to.
//
//   add-user        asks for the e-mail, the name and the role; prints the temporary password ONCE. The first owner is made with this command.
//   reset           asks for the e-mail; a new temporary password, and every session of that user ends.
//   role            asks for the e-mail and the new role.
//   deactivate      asks for the e-mail; the user reads nothing from then on.
//   activate        asks for the e-mail.
//   list            prints the users.
//   clear-counters  clears the login counters, so that a shop a stranger has locked out can sign in at once (A13).
//   record-pull     asks for the backup file and its SHA-256 and records that Harsh pulled it (O54).
//
// THE TOKEN is typed, without echo, and kept in memory for the length of the command: it is read from no file and no variable of the environment, and written to none. (Make one with `npm run make-token`.)
// THE ADDRESS of the API is the variable JV_API_URL (not a secret; for example the production address), or it is asked for. The token is never sent over plain http, except to this computer.
//
// Everything that talks to the outside is passed in (`io`), so a test runs the whole command against the real door with scripted answers; the file runs by itself only when it is started as a program.
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { pathToFileURL } from 'node:url';

const ROLES = ['owner', 'biller', 'staff'];
export const COMMANDS = ['add-user', 'reset', 'role', 'deactivate', 'activate', 'list', 'clear-counters', 'record-pull'];

class CliError extends Error {}

const USAGE = `Usage: npm run admin -- <command>
  add-user        make a user (also the first owner); prints the temporary password once
  reset           give a user a new temporary password and end all their sessions
  role            change a user's role
  deactivate      stop a user from reading anything
  activate        let a user in again
  list            show the users
  clear-counters  clear the login counters
  record-pull     record that you pulled a backup
`;

// ------------------------------------------------------------------ talking to the door

/** The address of the API, checked: https, or http to this computer only (the token is in every call). */
function baseOf(text) {
  let url;
  try {
    url = new URL(text.trim());
  } catch {
    throw new CliError('That is not an address. Write it like https://billing-api.example.com');
  }
  const here = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (!(url.protocol === 'https:' || (url.protocol === 'http:' && here))) throw new CliError('The address must start with https:// (plain http is allowed only for this computer): the token is sent with every call.');
  return url;
}

const waitText = (seconds) => {
  const s = Number(seconds);
  if (!Number.isFinite(s) || s < 1) return 'a little while';
  return s >= 90 ? `about ${Math.ceil(s / 60)} minutes` : `${Math.ceil(s)} seconds`;
};

/** What a refusal of the door means to a person. The token is never repeated. */
function explain(res, body) {
  const message = body?.error?.message;
  switch (res.status) {
    case 401:
      return 'The token was not accepted. Check that you pasted all of it. Two wrong tokens in a row pause this address for 15 minutes.';
    case 403:
      return 'The door refused the call (a web page or proxy added an Origin header?).';
    case 404:
      return 'The admin door is not there: it is shut (the variable JV_ADMIN_TOKEN_HASH is not set on the server) or the address is wrong.';
    case 429:
      return `Too many calls, or the address is paused after wrong tokens. Try again in ${waitText(res.headers.get('retry-after'))}.`;
    case 422:
      return `The server did not accept it: ${message ?? 'a value was refused'}`;
    default:
      return `The server answered ${res.status}${message ? `: ${message}` : ''}.`;
  }
}

function makeApi(base, token, fetchFn) {
  return async function call(method, path, payload) {
    const url = new URL(path, base);
    let res;
    try {
      res = await fetchFn(url.href, {
        method,
        headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...(payload === undefined ? {} : { 'content-type': 'application/json' }) },
        body: payload === undefined ? undefined : JSON.stringify(payload),
      });
    } catch (e) {
      throw new CliError(`Could not reach ${base.origin}: ${e?.cause?.code ?? e?.message ?? 'no answer'}`);
    }
    let body = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    if (!res.ok) throw new CliError(explain(res, body));
    return body;
  };
}

// ------------------------------------------------------------------ what each command asks and prints

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const askEmail = async (io) => (await io.ask('email')).trim().toLowerCase();

function askRole(text) {
  const role = text.trim().toLowerCase();
  if (!ROLES.includes(role)) throw new CliError(`The role must be one of: ${ROLES.join(', ')}.`);
  return role;
}

/** The user with this e-mail, from the list the door gives. */
async function findUser(call, email) {
  const { users } = await call('GET', '/admin/v1/users');
  const user = users.find((u) => u.email.toLowerCase() === email);
  if (!user) throw new CliError(`No user has the e-mail ${email}. (npm run admin -- list shows the users.)`);
  return user;
}

const temporaryLines = (password) => [`Temporary password (shown only now, write it down): ${password}`, 'They must change it when they sign in for the first time.'];

const HANDLERS = {
  async 'add-user'(call, io) {
    const email = await askEmail(io);
    const fullName = (await io.ask('name')).trim();
    const role = askRole(await io.ask('role'));
    const { user, temporary_password: password } = await call('POST', '/admin/v1/users', { email, full_name: fullName, role });
    return [`Made the user ${user.email} (${user.role}).`, ...temporaryLines(password)];
  },

  async reset(call, io) {
    const user = await findUser(call, await askEmail(io));
    const done = await call('POST', `/admin/v1/users/${user.id}/reset-password`);
    return [`Reset the password of ${user.email}. ${plural(done.sessions_ended, 'session')} ended.`, ...temporaryLines(done.temporary_password)];
  },

  async role(call, io) {
    const user = await findUser(call, await askEmail(io));
    const role = askRole(await io.ask('role'));
    const done = await call('POST', `/admin/v1/users/${user.id}/role`, { role });
    return [`Changed the role of ${user.email} from ${done.previous_role} to ${done.user.role}. It applies from their next call.`];
  },

  async deactivate(call, io) {
    const user = await findUser(call, await askEmail(io));
    const done = await call('POST', `/admin/v1/users/${user.id}/deactivate`);
    return [`${user.email} is not active now (${plural(done.sessions_ended, 'session')} ended). They can read nothing until you activate them.`];
  },

  async activate(call, io) {
    const user = await findUser(call, await askEmail(io));
    await call('POST', `/admin/v1/users/${user.id}/activate`);
    return [`${user.email} is active again. They sign in with their own password (or the last temporary one).`];
  },

  async list(call) {
    const { users } = await call('GET', '/admin/v1/users');
    if (users.length === 0) return ['There are no users yet. Make the first owner with: npm run admin -- add-user'];
    return users.map((u) => `${u.email}  ${u.role}  ${u.active ? 'active' : 'NOT ACTIVE'}${u.must_change_password ? '  (must change the password)' : ''}  ${u.full_name}`);
  },

  async 'clear-counters'(call) {
    const { cleared } = await call('POST', '/admin/v1/login-counters/clear');
    return [`Cleared ${plural(cleared, 'login counter')}. A login that was refused can try again now.`];
  },

  async 'record-pull'(call, io) {
    const file = (await io.ask('file')).trim();
    const sha256 = (await io.ask('sha256')).trim().toLowerCase();
    const done = await call('POST', '/admin/v1/backup-pulls', { file, sha256 });
    return [`Recorded: you pulled ${file} at ${done.at}.`];
  },
};

// ------------------------------------------------------------------ the command

/**
 * Runs one command. `io` is { env, ask(key), askSecret(key), out(text), err(text), fetch }: the keys of the questions are token, api, email, name, role, file and sha256.
 * Returns the exit code (0 when it worked). Nothing is thrown for a refusal: it is printed in words, without the token.
 */
export async function runAdmin(argv, io) {
  const [command, ...rest] = argv;
  if (!command || rest.length > 0 || !Object.hasOwn(HANDLERS, command)) {
    io.err(USAGE);
    return 1;
  }
  try {
    const token = (await io.askSecret('token')).trim();
    if (token === '') throw new CliError('No token was typed.');
    const configured = (io.env.JV_API_URL ?? '').trim();
    const base = baseOf(configured !== '' ? configured : await io.ask('api'));
    const lines = await HANDLERS[command](makeApi(base, token, io.fetch), io);
    io.out(`${lines.join('\n')}\n`);
    return 0;
  } catch (e) {
    io.err(`${e instanceof CliError ? e.message : `Something went wrong: ${e?.message ?? e}`}\n`);
    return 1;
  }
}

// ------------------------------------------------------------------ the terminal

const QUESTIONS = {
  token: 'Admin token (typed, never saved): ',
  api: 'Address of the API (for example https://billing-api.example.com): ',
  email: 'E-mail of the user: ',
  name: 'Full name: ',
  role: `Role (${ROLES.join(', ')}): `,
  file: 'Backup file you pulled (for example daily/2026-10-16.enc): ',
  sha256: 'SHA-256 of that file (64 characters): ',
};

/** Questions go to the error stream (the screen), answers to the program's output only once they are results; the token is typed without echo. */
function terminal() {
  let muted = false;
  const quiet = new Writable({
    write(chunk, _encoding, done) {
      if (!muted) process.stderr.write(chunk);
      done();
    },
  });
  const rl = createInterface({ input: process.stdin, output: quiet, terminal: Boolean(process.stdin.isTTY) });
  rl.on('SIGINT', () => {
    process.stderr.write('\n');
    process.exit(130);
  });
  const lines = rl[Symbol.asyncIterator]();
  const line = async (key) => {
    process.stderr.write(QUESTIONS[key]);
    const next = await lines.next();
    if (next.done) throw new CliError('There was no answer to that question.');
    return next.value;
  };
  return {
    env: process.env,
    ask: (key) => line(key),
    async askSecret(key) {
      muted = true;
      try {
        return await line(key);
      } finally {
        muted = false;
        if (process.stdin.isTTY) process.stderr.write('\n');
      }
    },
    out: (text) => process.stdout.write(text),
    err: (text) => process.stderr.write(text),
    fetch: globalThis.fetch,
    close: () => rl.close(),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const io = terminal();
  try {
    process.exitCode = await runAdmin(process.argv.slice(2), io);
  } finally {
    io.close();
  }
}
