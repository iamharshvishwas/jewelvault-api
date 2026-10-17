// B2 / B4 / O54: the backup folder as Harsh's Mac sees it. The folder lives on the Hostinger plan (daily/, monthly/, photos/, backup-folder.mjs); the Mac reads it
//   - from a local folder (a copy already pulled, a USB stick, a folder downloaded by hand), or
//   - over SFTP with Harsh's OWN login (port 65002), by the `ssh` and `sftp` programs that ship with macOS. No secret of the app is used, and this file holds and prints no password:
//     the login is asked for by ssh itself on the terminal (or comes from the key file Harsh names), ONCE, because one master connection (ControlMaster) is opened and every listing
//     and download is a batch over it.
// SFTP from the Mac to this folder was never tried (O48 item 12): the tests drive these functions against stand-ins of ssh and sftp; the real plan is OPS05's first try.
import { spawn } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SUBS = ['daily', 'monthly', 'photos'];
const TARGET_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]*@[A-Za-z0-9][A-Za-z0-9.-]*$/;
const NAME_RE = /^(daily|monthly|photos)\/[A-Za-z0-9_][A-Za-z0-9._-]*$/;

const checkSub = (sub) => {
  if (!SUBS.includes(sub)) throw new Error(`unknown sub-folder ${JSON.stringify(sub)}: the folder has ${SUBS.join(', ')}`);
  return sub;
};
const checkName = (name) => {
  if (!NAME_RE.test(name)) throw new Error(`not a name in the backup folder: ${JSON.stringify(name)}`);
  return name;
};

/** A path as one word of an sftp batch line: in double quotes, with `"` and `\` escaped. A line break cannot be quoted, so it is refused. */
export function batchQuote(text) {
  const s = String(text);
  if (/[\n\r\0]/.test(s)) throw new Error('a path with a line break cannot be used in an sftp batch');
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** The names in the output of a batched `ls -1`: the echoed `sftp>` lines and blank lines are dropped, and only the last part of a path is kept. */
export function parseListing(stdout) {
  return String(stdout)
    .split('\n')
    .map((l) => l.replace(/\r$/, '').trim())
    .filter((l) => l !== '' && !l.startsWith('sftp>'))
    .map((l) => path.posix.basename(l))
    .filter((n) => n !== '.' && n !== '..');
}

export function folderRemote(dir) {
  const root = path.resolve(dir);
  return {
    describe: `folder ${root}`,
    localRoot: root,
    async list(sub) {
      checkSub(sub);
      let entries;
      try {
        entries = await readdir(path.join(root, sub), { withFileTypes: true });
      } catch (e) {
        if (e.code === 'ENOENT') return [];
        throw e;
      }
      return entries.filter((e) => e.isFile() && !e.name.endsWith('.partial')).map((e) => e.name).sort();
    },
    async fetch(items) {
      for (const item of items) {
        checkName(item.name);
        await mkdir(path.dirname(item.to), { recursive: true });
        try {
          await copyFile(path.join(root, item.name), item.to, constants.COPYFILE_EXCL);
        } catch (e) {
          if (e.code === 'ENOENT') throw new Error(`cannot read ${item.name} in ${root}: it is not there`);
          throw e;
        }
      }
    },
    async close() {},
  };
}

/** Runs a program to the end. stdio 'inherit' lets a password prompt reach the terminal; otherwise stdout and stderr are collected and `input` is written to stdin. */
function run(command, args, { stdio = 'pipe', input, env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: stdio === 'inherit' ? 'inherit' : ['pipe', 'pipe', 'pipe'], env });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d) => void (stdout += d));
    child.stderr?.on('data', (d) => void (stderr += d));
    child.on('error', (e) => reject(new Error(`cannot start ${command}: ${e.code === 'ENOENT' ? 'the program is not there' : e.message}`)));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    if (stdio !== 'inherit') child.stdin.end(input ?? '');
  });
}

// ssh reads an -o value up to the first space unless it is in double quotes: a folder like "Harsh Vishwas" must not break the control socket
const controlPath = (sock) => `ControlPath="${sock}"`;

const firstLines = (text, n = 3) => String(text).trim().split('\n').slice(0, n).join(' / ');

export function sftpRemote({ target, port = 65002, dir, identityFile, sshOptions = [], bin = {}, env = process.env, tmpRoot = os.tmpdir(), masterStdio = 'inherit' }) {
  // the login is `user@host` and may not start with a dash (it would be read as an option)
  if (typeof target !== 'string' || !TARGET_RE.test(target)) throw new Error('the SFTP login must look like user@host (Harsh\'s own Hostinger SSH login)');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('the SFTP port must be a whole number from 1 to 65535');
  if (typeof dir !== 'string' || dir.trim() === '' || /[\n\r\0]/.test(dir)) throw new Error('the folder on the server (JV_BACKUP_DIR) is missing');
  const ssh = bin.ssh ?? 'ssh';
  const sftp = bin.sftp ?? 'sftp';
  const remoteDir = dir.replace(/\/+$/, '');
  // -i and extra -o options go to the master, the batches and the closing call alike (ssh and sftp take the same ones)
  const identity = [...(identityFile ? ['-i', identityFile] : []), ...sshOptions];
  let control = null;

  async function open() {
    if (control) return control;
    if (/["\n\r\0]/.test(tmpRoot)) throw new Error('the folder for the control socket may not contain a double quote or a line break');
    const folder = await mkdtemp(path.join(tmpRoot, 'jvs-')); // short: a socket path is limited to about 100 characters
    const sock = path.join(folder, 'c');
    // -f: go to the background once the login (and its password prompt) is done; -M: be the master the batches below use
    const r = await run(ssh, ['-f', '-N', '-M', '-p', String(port), '-o', controlPath(sock), '-o', 'ControlPersist=15m', '-o', 'ServerAliveInterval=20', ...identity, target], { stdio: masterStdio, env });
    if (r.code !== 0) {
      await rm(folder, { recursive: true, force: true });
      throw new Error(`cannot log in to ${target} on port ${port}: ssh ended with code ${r.code}${r.stderr ? ` (${firstLines(r.stderr)})` : ''}. Check the login in hPanel > SSH Access and that SSH is on.`);
    }
    control = { folder, sock };
    return control;
  }

  async function batch(lines, what) {
    const { sock } = await open();
    const r = await run(sftp, ['-q', '-b', '-', '-P', String(port), '-o', controlPath(sock), ...identity, target], { input: lines.join('\n') + '\n', env });
    if (r.code !== 0) throw new Error(`${what} failed on ${target}: ${firstLines(r.stderr || r.stdout) || `sftp ended with code ${r.code}`}`);
    return r.stdout;
  }

  return {
    describe: `sftp ${target}:${port} ${remoteDir}`,
    localRoot: null,
    async list(sub) {
      checkSub(sub);
      const where = `${remoteDir}/${sub}`;
      const out = await batch([`ls -1 ${batchQuote(where)}`], `listing ${where}`);
      return parseListing(out).filter((n) => !n.endsWith('.partial')).sort();
    },
    async fetch(items) {
      if (items.length === 0) return;
      const lines = items.map((i) => `get ${batchQuote(`${remoteDir}/${checkName(i.name)}`)} ${batchQuote(i.to)}`);
      for (const i of items) await mkdir(path.dirname(i.to), { recursive: true });
      await batch(lines, `downloading ${items.length === 1 ? items[0].name : `${items.length} files (the first is ${items[0].name})`}`);
    },
    async close() {
      if (!control) return;
      const { folder, sock } = control;
      control = null;
      await run(ssh, ['-O', 'exit', '-p', String(port), '-o', controlPath(sock), target], { env }).catch(() => undefined);
      await rm(folder, { recursive: true, force: true });
    },
  };
}
