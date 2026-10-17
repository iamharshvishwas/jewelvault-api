#!/usr/bin/env node
// B2, O40, U10: `npm run keygen -- <path>` makes the key pair that encrypts the backups (export-file.mjs).
//
//   the PRIVATE key  goes to the path you name, and only there: outside the repository (a key inside it could be committed), created with mode 0600 (only you can read it), and never over a file that
//                    exists (it is created with O_EXCL and without following a link, so a second run, or a path that is already a file or a link, is refused and the old key is left as it is). It is never
//                    printed. It stays with Harsh, and a second copy goes to Siddhi, a person's step (PH06a). It never goes on the server: only the public key does.
//   the PUBLIC key   is printed as ONE line, the base64 of its DER encoding (SubjectPublicKeyInfo), which is what the variable BACKUP_PUBLIC_KEY holds and what loadPublicKey reads. It is not secret.
//   the fingerprint  the SHA-256 of that encoding in hex: read it out to the other holder, who sees the same 64 characters from the key they hold, and a key that was swapped on the way is found.
//
// RSA 4096, as RSA-OAEP with SHA-256 wraps the one-time key of each file (export-file.mjs). Making the pair takes a few seconds.
import { createHash, generateKeyPairSync } from 'node:crypto';
import { closeSync, constants, fchmodSync, fsyncSync, lstatSync, openSync, realpathSync, statSync, unlinkSync, writeSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const MODULUS_BITS = 4096;
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export class KeygenError extends Error {}

/** True when `candidate` is `root` or inside it (both real paths). */
const inside = (root, candidate) => candidate === root || candidate.startsWith(root.endsWith(path.sep) ? root : root + path.sep);

/** The real path the key will be created at, or a KeygenError that says why not. Nothing is created here. */
export function checkTarget(given, repo = REPO) {
  if (typeof given !== 'string' || given.trim() === '') throw new KeygenError('No path was given. Usage: npm run keygen -- /path/outside/the/repository/backup-private.pem');
  const wanted = path.resolve(given.trim());
  let folder;
  try {
    folder = realpathSync(path.dirname(wanted));
    if (!statSync(folder).isDirectory()) throw new Error('not a folder');
  } catch {
    throw new KeygenError(`The folder ${path.dirname(wanted)} does not exist. Make it first, outside the repository, and run keygen again.`);
  }
  const target = path.join(folder, path.basename(wanted));
  if (inside(realpathSync(repo), target)) throw new KeygenError('That path is inside the repository: a private key there could be committed. Choose a folder outside it.');
  try {
    lstatSync(target); // lstat: a link counts as existing, even one that points nowhere
    throw new KeygenError(`${target} already exists. keygen never overwrites a key: choose another path (or move the old key away yourself).`);
  } catch (e) {
    if (e instanceof KeygenError) throw e;
    if (e.code !== 'ENOENT') throw new KeygenError(`Cannot look at ${target}: ${e.code ?? e.message}`);
  }
  return target;
}

/** Makes the pair, writes the private key (0600, exclusive) and returns what is to be shown. */
export function generate(target) {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: MODULUS_BITS,
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  let fd;
  try {
    fd = openSync(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  } catch (e) {
    if (e.code === 'EEXIST') throw new KeygenError(`${target} already exists. keygen never overwrites a key.`);
    throw new KeygenError(`Cannot create ${target}: ${e.code ?? e.message}`);
  }
  try {
    fchmodSync(fd, 0o600); // the process umask may have taken bits away, never added: this makes it exactly 0600
    writeSync(fd, privateKey);
    fsyncSync(fd);
  } catch (e) {
    closeSync(fd);
    fd = undefined;
    try {
      unlinkSync(target); // our own half-written file, created a moment ago
    } catch {}
    throw new KeygenError(`Could not write ${target}: ${e.code ?? e.message}`);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  return { publicLine: publicKey.toString('base64'), fingerprint: createHash('sha256').update(publicKey).digest('hex') };
}

/** Asks for the path on one line of input (used when none was given on the command line). */
async function askPath() {
  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: false });
  try {
    process.stderr.write('Where should the private key be saved (a path outside the repository)? ');
    for await (const line of rl) return line;
    return '';
  } finally {
    rl.close();
  }
}

export async function main(argv, out, err) {
  if (argv.length > 1) {
    err('Usage: npm run keygen -- <path for the private key>\n');
    return 1;
  }
  try {
    const target = checkTarget(argv.length === 1 ? argv[0] : await askPath());
    const { publicLine, fingerprint } = generate(target);
    out(
      [
        `The private key is saved in ${target}, readable only by you. It decrypts every backup: keep it off the server and out of the repository, and make a second copy for Siddhi (that part is done by a person).`,
        '',
        'The public key, one line. Put it in hPanel (the Node.js app, environment variables) as BACKUP_PUBLIC_KEY:',
        '',
        publicLine,
        '',
        'Its SHA-256 fingerprint. Read it out to the other holder of the private key: their copy must give the same 64 characters.',
        '',
        fingerprint,
        '',
      ].join('\n'),
    );
    return 0;
  } catch (e) {
    err(`${e instanceof KeygenError ? e.message : `keygen failed: ${e.message}`}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2), (t) => process.stdout.write(t), (t) => process.stderr.write(t));
}
