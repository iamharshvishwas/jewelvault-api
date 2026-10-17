import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runAdmin } from '../../scripts/admin.mjs';
import { createExportWriter, loadPublicKey, unpackExport } from '../../scripts/export-file.mjs';
import { migrate } from '../../scripts/migrate.mjs';
import { createClock } from '../../src/clock';
import { T0, type World, makeWorld } from './cells';
import { REPO, buildDist, csrfHeaders } from './support';

// API09: the three commands on Harsh's Mac. T-E09 (HTTP side): `npm run admin -- add-user|reset|role|deactivate|activate|clear-counters|record-pull|list` asks and prints, against the real door of a
// real listening application; `npm run make-token` and `npm run keygen` (the files scripts/make-token.mjs and scripts/keygen.mjs). The DRILL half of T-E09 (Harsh follows the runbook once) is OPS06.

const TOKEN = randomBytes(32).toString('base64url');
const HASH = createHash('sha256').update(TOKEN).digest('hex');
const clock = createClock(() => T0);

const tmps: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'jv-api09-'));
  tmps.push(d);
  return d;
};
afterAll(() => {
  for (const d of tmps) rmSync(d, { recursive: true, force: true });
});

const SCRIPT = (name: string) => join(REPO, 'scripts', name);
const PASSWORD_SHAPE = /\b[A-HJ-NP-Za-km-z2-9]{4}(?:-[A-HJ-NP-Za-km-z2-9]{4}){3}\b/g;

// ------------------------------------------------------------------------------------------------ make-token

describe('T-E09 `npm run make-token` prints one random token ONCE and its hash for hPanel, and writes neither to a file', () => {
  const run = (args: string[] = [], cwd = tmp()) => {
    const before = readdirSync(cwd);
    const r = spawnSync(process.execPath, [SCRIPT('make-token.mjs'), ...args], { cwd, encoding: 'utf8' });
    return { ...r, cwd, before, after: readdirSync(cwd) };
  };

  it('prints a token and the SHA-256 of it in hex, the hash is the one the door compares with, the token appears once, and nothing is written in the folder it was run from', () => {
    const r = run();
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
    const lines = r.stdout.split('\n').map((l) => l.trim());
    const tokens = lines.filter((l) => /^[A-Za-z0-9_-]{43}$/.test(l));
    const hashes = lines.filter((l) => /^[0-9a-f]{64}$/.test(l));
    expect(tokens).toHaveLength(1);
    expect(hashes).toHaveLength(1);
    expect(createHash('sha256').update(tokens[0]).digest('hex')).toBe(hashes[0]);
    expect(r.stdout.split(tokens[0])).toHaveLength(2); // once
    expect(r.stdout).toContain('JV_ADMIN_TOKEN_HASH');
    expect(r.stdout).not.toContain('JV_JOB_TOKEN_HASH');
    expect(r.after).toEqual(r.before);
  });

  it('two runs make two different tokens; `job` names the job token\'s variable instead', () => {
    const a = run();
    const b = run(['job']);
    const token = (out: string) => out.split('\n').map((l) => l.trim()).find((l) => /^[A-Za-z0-9_-]{43}$/.test(l));
    expect(token(a.stdout)).not.toBe(token(b.stdout));
    expect(b.stdout).toContain('JV_JOB_TOKEN_HASH');
    expect(b.stdout).not.toContain('JV_ADMIN_TOKEN_HASH');
  });

  it('refuses a word it does not know, says how to use it, and prints no token', () => {
    const r = run(['nonsense']);
    expect(r.status).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr).toMatch(/admin|job/);
    expect(r.stderr).not.toMatch(/[A-Za-z0-9_-]{43}/);
  });

  it('the file can write nothing: it does not import the file system, and it reads no variable of the environment', () => {
    const source = readFileSync(SCRIPT('make-token.mjs'), 'utf8');
    expect(source).not.toMatch(/node:fs|from 'fs'|writeFile|appendFile|createWriteStream|process\.env|execSync|spawn/);
  });

  it('is wired as `npm run make-token`, `npm run keygen` and `npm run admin`', () => {
    const scripts = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).scripts as Record<string, string>;
    expect(scripts['make-token']).toBe('node scripts/make-token.mjs');
    expect(scripts.keygen).toBe('node scripts/keygen.mjs');
    expect(scripts.admin).toBe('node scripts/admin.mjs');
  });
});

// ------------------------------------------------------------------------------------------------ keygen

describe('T-E09 `npm run keygen` makes the backup key pair: the private key to a path Harsh names (outside the repository, 0600, never overwritten), the public key as ONE line with its fingerprint', () => {
  let dir: string;
  let privatePath: string;
  let first: ReturnType<typeof spawnSync>;
  let publicLine: string;
  let fingerprint: string;
  const keygen = (args: string[]) => spawnSync(process.execPath, [SCRIPT('keygen.mjs'), ...args], { encoding: 'utf8' });
  const BEGIN = ['-----', 'BEGIN PRIVATE KEY', '-----'].join(''); // put together here so that the scan for key material (T-D29) does not read this file as holding one

  beforeAll(() => {
    dir = tmp();
    privatePath = join(dir, 'backup-private.pem');
    first = keygen([privatePath]);
    const out = String(first.stdout);
    publicLine = out.split('\n').map((l) => l.trim()).find((l) => l.length > 300 && /^[A-Za-z0-9+/=]+$/.test(l)) ?? '';
    fingerprint = out.split('\n').map((l) => l.trim()).find((l) => /^[0-9a-f]{64}$/.test(l)) ?? '';
  }, 120_000);

  it('succeeds, writes the private key to the named path with mode 0600, and prints the public key as one line and a SHA-256 fingerprint', () => {
    expect(first.status, String(first.stderr)).toBe(0);
    expect(existsSync(privatePath)).toBe(true);
    expect(statSync(privatePath).mode & 0o777).toBe(0o600);
    expect(readFileSync(privatePath, 'utf8').startsWith(BEGIN)).toBe(true);
    expect(publicLine.length).toBeGreaterThan(300);
    expect(publicLine).not.toMatch(/\s/);
    expect(String(first.stdout)).toContain('BACKUP_PUBLIC_KEY');
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it('never prints the private key, in the output or in the error stream', () => {
    const privateBody = readFileSync(privatePath, 'utf8').replace(/-----[A-Z ]+-----|\s/g, '');
    for (const text of [String(first.stdout), String(first.stderr)]) {
      expect(text).not.toContain(BEGIN);
      expect(text).not.toContain(privateBody.slice(40, 120));
    }
  });

  it('the public line loads with loadPublicKey (BACKUP_PUBLIC_KEY), is an RSA key of 4096 bits, and the fingerprint is the SHA-256 of its encoding', () => {
    const key = loadPublicKey(publicLine);
    expect(key.type).toBe('public');
    expect(key.asymmetricKeyType).toBe('rsa');
    expect(key.asymmetricKeyDetails?.modulusLength).toBe(4096);
    const der = key.export({ type: 'spki', format: 'der' });
    expect(createHash('sha256').update(der).digest('hex')).toBe(fingerprint);
  });

  it('an export encrypted with the public line decrypts with the private file, and a different key cannot', async () => {
    const d = tmp();
    const file = join(d, 'export.enc');
    const writer = await createExportWriter(file, loadPublicKey(publicLine));
    const marker = `marker-${randomUUID()}`;
    const f = writer.sink.file('manifest.json');
    await f.write(JSON.stringify({ marker }));
    await f.close();
    await writer.finish();
    expect(readFileSync(file).includes(Buffer.from(marker))).toBe(false); // encrypted
    const out = join(d, 'out');
    await unpackExport(file, readFileSync(privatePath, 'utf8'), out);
    expect(JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8')).marker).toBe(marker);
    const otherPath = join(d, 'other.pem');
    const other = keygen([otherPath]);
    expect(other.status).toBe(0);
    await expect(unpackExport(file, readFileSync(otherPath, 'utf8'), join(d, 'out2'))).rejects.toThrow();
  }, 120_000);

  it('a second run to the same path refuses to overwrite it: the key stays byte for byte, and no key is printed', () => {
    const before = readFileSync(privatePath);
    const second = keygen([privatePath]);
    expect(second.status).toBe(1);
    expect(String(second.stderr)).toMatch(/already exists|never overwrites/i);
    expect(String(second.stdout)).toBe('');
    expect(readFileSync(privatePath).equals(before)).toBe(true);
    expect(statSync(privatePath).mode & 0o777).toBe(0o600);
  });

  it('refuses a path inside the repository (the key must never be committable), a folder that does not exist, and no path at all', () => {
    for (const bad of [join(REPO, 'backup-private.pem'), join(REPO, 'scripts', 'k.pem'), join(REPO, 'node_modules', 'k.pem')]) {
      const r = keygen([bad]);
      expect(r.status, bad).toBe(1);
      expect(String(r.stderr), bad).toMatch(/repository/i);
      expect(existsSync(bad), bad).toBe(false);
    }
    const missing = keygen([join(tmp(), 'no-such-folder', 'k.pem')]);
    expect(missing.status).toBe(1);
    expect(String(missing.stderr)).toMatch(/folder/i);
    const none = spawnSync(process.execPath, [SCRIPT('keygen.mjs')], { encoding: 'utf8', input: '' });
    expect(none.status).toBe(1);
    expect(String(none.stdout)).not.toMatch(/[A-Za-z0-9+/]{300}/);
  });

  it('a path that is a symbolic link to somewhere is not followed: the key is not written through it, and the target is not touched', () => {
    const d = tmp();
    const target = join(d, 'precious.txt');
    writeFileSync(target, 'keep me');
    const link = join(d, 'link.pem');
    execFileSync('ln', ['-s', target, link]);
    const r = keygen([link]);
    expect(r.status).toBe(1);
    expect(readFileSync(target, 'utf8')).toBe('keep me');
  });
});

// ------------------------------------------------------------------------------------------------ admin

describe('T-E09 (HTTP side) `npm run admin -- add-user|reset|role|deactivate|activate|clear-counters|record-pull|list` asks for what it needs, calls the door and prints the temporary password', () => {
  let world: World;
  let base: string;
  let seq = 0;
  const ipFor = () => `198.19.${Math.floor(++seq / 250)}.${(seq % 250) + 1}`;

  beforeAll(async () => {
    world = await makeWorld({ label: 'admcli', routes: true, clock, config: { adminTokenHash: HASH, logLevel: 'silent' } });
    await migrate(world.sql, { seeds: false, optional: true });
    await world.app.listen({ port: 0, host: '127.0.0.1' });
    const address = world.app.server.address();
    if (!address || typeof address === 'string') throw new Error('the application is not listening');
    base = `http://127.0.0.1:${address.port}`;
  }, 120_000);
  afterAll(async () => {
    await world?.close();
  });

  interface Script {
    answers?: Record<string, string>;
    token?: string;
    env?: Record<string, string>;
    fetch?: typeof fetch;
  }
  /** Runs the command with scripted answers; every address the command prompts for is a key of `answers`. */
  async function run(argv: string[], s: Script = {}) {
    const out: string[] = [];
    const err: string[] = [];
    const asked: string[] = [];
    const answers = s.answers ?? {};
    const io = {
      env: { JV_API_URL: base, ...s.env },
      ask: async (key: string) => {
        asked.push(key);
        if (!(key in answers)) throw new Error(`the command asked for "${key}", which this test did not expect`);
        return answers[key];
      },
      askSecret: async (key: string) => {
        asked.push(key);
        if (key !== 'token') throw new Error(`the command asked for "${key}" as a secret`);
        return s.token ?? TOKEN;
      },
      out: (t: string) => void out.push(t),
      err: (t: string) => void err.push(t),
      // the front end of Hostinger would add the visitor's address; the test adds one of its own so that each command is a new visitor of the throttle
      fetch: s.fetch ?? ((url: string | URL | Request, init?: RequestInit) => fetch(url, { ...init, headers: { ...(init?.headers as Record<string, string>), 'x-real-ip': ipFor() } })),
    };
    const code = await runAdmin(argv, io);
    return { code, out: out.join(''), err: err.join(''), asked };
  }

  const userRow = async (email: string) => (await world.sql.query<any[]>('SELECT * FROM users WHERE email = ?', [email]))[0][0] as Record<string, any> | undefined;
  const passwordIn = (out: string): string => {
    const found: string[] = out.match(PASSWORD_SHAPE) ?? [];
    expect(found, 'exactly one temporary password is printed').toHaveLength(1);
    return String(found[0]);
  };
  const login = (email: string, password: string) => world.app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email, password }, headers: csrfHeaders() });
  const email = (label: string) => `${label}-${randomUUID().slice(0, 8)}@example.test`;

  it('add-user asks for the token (as a secret), the e-mail, the name and the role, and prints the temporary password once; the user can sign in with it and must change it', async () => {
    const e = email('cli-biller');
    const r = await run(['add-user'], { answers: { email: e, name: 'Sunita Verma', role: 'biller' } });
    expect(r.code, r.err).toBe(0);
    expect(r.asked).toEqual(['token', 'email', 'name', 'role']);
    const temporary = passwordIn(r.out);
    expect(r.out).toContain(e);
    expect(r.out).not.toContain(TOKEN);
    expect(r.err).toBe('');
    expect(await userRow(e)).toMatchObject({ role: 'biller', active: 1, must_change_password: 1, full_name: 'Sunita Verma' });
    const res = await login(e, temporary);
    expect(res.statusCode).toBe(200);
    expect(res.json().user.must_change_password).toBe(true);
  });

  it('the first owner is made the same way (role owner)', async () => {
    const e = email('cli-owner');
    const r = await run(['add-user'], { answers: { email: e, name: 'First Owner', role: 'owner' } });
    expect(r.code, r.err).toBe(0);
    expect((await userRow(e))?.role).toBe('owner');
  });

  it('reset asks for the e-mail, prints a NEW temporary password once and says how many sessions it ended; the old password and the old session are gone', async () => {
    const e = email('cli-reset');
    const made = await run(['add-user'], { answers: { email: e, name: 'Reset Me', role: 'staff' } });
    const first = passwordIn(made.out);
    const signedIn = await login(e, first);
    const cookie = String(signedIn.headers['set-cookie']).split(';')[0];
    expect((await world.app.inject({ method: 'GET', url: '/v1/auth/me', headers: { cookie } })).statusCode).toBe(200);

    const r = await run(['reset'], { answers: { email: e.toUpperCase() } });
    expect(r.code, r.err).toBe(0);
    const second = passwordIn(r.out);
    expect(second).not.toBe(first);
    expect(r.out).toMatch(/1 session/);
    expect((await world.app.inject({ method: 'GET', url: '/v1/auth/me', headers: { cookie } })).statusCode).toBe(401);
    expect((await login(e, first)).statusCode).toBe(401);
    expect((await login(e, second)).statusCode).toBe(200);
  });

  it('role asks for the e-mail and the new role and prints both the old and the new role', async () => {
    const e = email('cli-role');
    await run(['add-user'], { answers: { email: e, name: 'Role Change', role: 'staff' } });
    const r = await run(['role'], { answers: { email: e, role: 'biller' } });
    expect(r.code, r.err).toBe(0);
    expect(r.out).toMatch(/staff/);
    expect(r.out).toMatch(/biller/);
    expect((await userRow(e))?.role).toBe('biller');
  });

  it('deactivate and activate: a user who is not active reads nothing, and signs in again after the activation', async () => {
    const e = email('cli-active');
    const made = await run(['add-user'], { answers: { email: e, name: 'On Off', role: 'biller' } });
    const temporary = passwordIn(made.out);
    const cookie = String((await login(e, temporary)).headers['set-cookie']).split(';')[0];

    const off = await run(['deactivate'], { answers: { email: e } });
    expect(off.code, off.err).toBe(0);
    expect((await userRow(e))?.active).toBe(0);
    expect((await world.app.inject({ method: 'GET', url: '/v1/auth/me', headers: { cookie } })).statusCode, 'the session reads nothing').toBe(401);
    expect((await login(e, temporary)).statusCode, 'and no new one is made').toBe(403);

    const on = await run(['activate'], { answers: { email: e } });
    expect(on.code, on.err).toBe(0);
    expect((await userRow(e))?.active).toBe(1);
    expect((await login(e, temporary)).statusCode).toBe(200);
  });

  it('list prints every user with role and state, and never a hash or a password', async () => {
    const r = await run(['list']);
    expect(r.code, r.err).toBe(0);
    expect(r.asked).toEqual(['token']);
    expect(r.out).toMatch(/owner/);
    expect(r.out).not.toMatch(/\$argon2|\$scrypt/);
    for (const u of (await world.sql.query<any[]>('SELECT email FROM users'))[0] as { email: string }[]) expect(r.out).toContain(u.email);
  });

  it('clear-counters prints how many rows it cleared; record-pull asks for the file and the sha256 and prints that it was recorded', async () => {
    await world.sql.query("INSERT INTO sys_login_attempts (scope, slot, window_start, n) VALUES ('email', 11, UTC_TIMESTAMP(6), 7) ON DUPLICATE KEY UPDATE n = 7");
    const cleared = await run(['clear-counters']);
    expect(cleared.code, cleared.err).toBe(0);
    expect(cleared.out).toMatch(/1\b/);
    expect(Number((await world.sql.query<any[]>("SELECT n FROM sys_login_attempts WHERE scope = 'email' AND slot = 11"))[0][0].n)).toBe(0);

    const sha = randomBytes(32).toString('hex');
    const pulled = await run(['record-pull'], { answers: { file: 'daily/2026-10-16.enc', sha256: sha } });
    expect(pulled.code, pulled.err).toBe(0);
    expect(pulled.out).toMatch(/recorded/i);
    const stored = (await world.sql.query<any[]>("SELECT value FROM settings WHERE setting_key = 'last_pulled'"))[0][0].value;
    expect(JSON.parse(typeof stored === 'string' ? stored : JSON.stringify(stored))).toMatchObject({ file: 'daily/2026-10-16.enc', sha256: sha });
  });

  it('a wrong token: prints that the token was refused (never the door\'s detail), exits 1, and changes nothing', async () => {
    const e = email('cli-nobody');
    const r = await run(['add-user'], { token: randomBytes(32).toString('base64url'), answers: { email: e, name: 'Nobody', role: 'staff' } });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/token/i);
    expect(await userRow(e)).toBeUndefined();
  });

  it('an e-mail that is not a user: says so and exits 1; a role that does not exist: says so before any call', async () => {
    const r = await run(['reset'], { answers: { email: email('cli-ghost') } });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/no user/i);
    const calls: string[] = [];
    const spyFetch = ((url: string | URL | Request, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${String(url)}`);
      return fetch(url, init);
    }) as typeof fetch;
    const bad = await run(['add-user'], { answers: { email: email('cli-bad'), name: 'Bad Role', role: 'admin' }, fetch: spyFetch });
    expect(bad.code).toBe(1);
    expect(bad.err).toMatch(/role/i);
    expect(calls).toEqual([]);
  });

  it('never sends the token over plain http to another computer: the call is not made and the token is not sent', async () => {
    const calls: string[] = [];
    const never = (async (url: string | URL | Request) => {
      calls.push(String(url));
      throw new Error('should not be called');
    }) as typeof fetch;
    for (const url of ['http://billing-api.example.test', 'http://203.0.113.9:3000', 'ftp://billing-api.example.test']) {
      const r = await run(['list'], { env: { JV_API_URL: url }, fetch: never });
      expect(r.code, url).toBe(1);
      expect(r.err, url).toMatch(/https/i);
    }
    expect(calls).toEqual([]);
    // https anywhere, and http to this computer, are fine
    const ok = await run(['list'], { env: { JV_API_URL: `${base}/` } });
    expect(ok.code, ok.err).toBe(0);
  });

  it('asks for the address of the API when JV_API_URL is not set', async () => {
    const r = await run(['list'], { env: { JV_API_URL: '' }, answers: { api: base } });
    expect(r.code, r.err).toBe(0);
    expect(r.asked).toEqual(['token', 'api']);
  });

  it('an unknown command, or none, prints the list of commands and exits 1 without asking for the token', async () => {
    for (const argv of [[], ['frobnicate'], ['add-user', 'extra']]) {
      const r = await run(argv);
      expect(r.code, argv.join(' ')).toBe(1);
      expect(r.asked).toEqual([]);
      for (const word of ['add-user', 'reset', 'role', 'deactivate', 'activate', 'clear-counters', 'record-pull', 'list']) expect(r.err).toContain(word);
    }
  });

  it('as a real process with the answers on its input: prints the temporary password and exits 0 (the way Harsh runs it, without the typing)', async () => {
    const e = email('cli-process');
    const child = spawn(process.execPath, [SCRIPT('admin.mjs'), 'add-user'], { env: { PATH: process.env.PATH ?? '', JV_API_URL: base }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.stdin.write(`${TOKEN}\n${e}\nProcess User\nstaff\n`);
    child.stdin.end();
    const code: number = await new Promise((resolve) => child.on('close', resolve));
    expect(code, stderr).toBe(0);
    const temporary = passwordIn(stdout);
    expect(stdout).not.toContain(TOKEN);
    expect(stderr).not.toContain(TOKEN);
    expect((await login(e, temporary)).statusCode).toBe(200);
  }, 60_000);

  it('`npm run check:routes` lists the eight routes of the admin door as token routes (A1: every route the built app can have is on the page)', () => {
    const out = execFileSync(process.execPath, [join(REPO, 'scripts', 'check-routes.mjs'), buildDist()], { cwd: REPO, encoding: 'utf8' });
    const door = out.split('\n').filter((l) => /\/admin\/v1\//.test(l));
    expect(door).toHaveLength(8);
    for (const l of door) expect(l).toMatch(/token\s+admin/);
  }, 120_000);

  it('the command stores nothing: it does not import the file system and does not read a token from the environment', () => {
    const source = readFileSync(SCRIPT('admin.mjs'), 'utf8');
    expect(source).not.toMatch(/node:fs|from 'fs'|writeFile|appendFile|createWriteStream/);
    expect(source).not.toMatch(/process\.env\.[A-Z_]*TOKEN/);
    expect(source).not.toMatch(/mysql|createConnection|createPool/); // no SQL and no database password on Harsh's Mac (U3)
  });
});
