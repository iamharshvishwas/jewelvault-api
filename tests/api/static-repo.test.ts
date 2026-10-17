import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CONFIG_VARIABLES } from '../../src/config';
import {
  FORBIDDEN_WORDS,
  type LockFile,
  NEEDLES,
  type SecretException,
  blocks,
  envExampleProblems,
  envFileProblems,
  installScriptPackages,
  parseAudit,
  pauseHookHits,
  runAudit,
  runtimeDependencyCount,
  scanForSecrets,
  scanRepository,
} from './static-lib';
import { REPO, buildDist, canConnect, freePort, secret } from './support';

// T-D11, part 3 (A7): the dependencies. T-D29 (A3, U10, H3, X0): the repository and the bundle. Every check is a function of text or of a folder (tests/api/static-lib.ts) and is run on the real
// repository and on a planted violation, which it must find, and again once the violation is gone.

const scratchDirs: string[] = [];
const scratchDir = () => {
  const d = mkdtempSync(join(tmpdir(), 'jv-repo-'));
  scratchDirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of scratchDirs) rmSync(d, { recursive: true, force: true });
});
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'ignore' });
/** A scratch git repository (no remote, nothing shared with this one). */
const scratchRepo = (gitignore = '.env\nnode_modules/\n') => {
  const dir = scratchDir();
  git(dir, 'init', '-q');
  writeFileSync(join(dir, '.gitignore'), gitignore);
  return dir;
};

const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')) as { dependencies: Record<string, string> };
const lock = JSON.parse(readFileSync(join(REPO, 'package-lock.json'), 'utf8')) as LockFile;

// ------------------------------------------------------------------ T-D11: dependencies

describe('T-D11 the dependencies (A7)', () => {
  it('no runtime dependency has an install script', () => {
    expect(installScriptPackages(lock)).toEqual([]);
  });

  it('control: a runtime package with an install script is found; the same package as a development dependency is not (it never runs on the server)', () => {
    const planted: LockFile = { packages: { '': {}, 'node_modules/ok': { version: '1.0.0' }, 'node_modules/@scope/bad': { version: '1.0.0', hasInstallScript: true }, 'node_modules/a/node_modules/worse': { version: '2.0.0', hasInstallScript: true } } };
    expect(installScriptPackages(planted)).toEqual(['@scope/bad', 'worse']);
    planted.packages['node_modules/@scope/bad'].dev = true;
    delete planted.packages['node_modules/a/node_modules/worse'];
    expect(installScriptPackages(planted)).toEqual([]);
  });

  it('the runtime dependency count is recorded: what package.json asks for and everything it pulls in', () => {
    const count = runtimeDependencyCount(lock, pkg);
    expect(count.direct).toBe(Object.keys(pkg.dependencies).length);
    expect(count.total).toBeGreaterThanOrEqual(count.direct);
    console.log(`[T-D11] runtime dependencies: ${count.direct} direct (${Object.keys(pkg.dependencies).join(', ')}), ${count.total} in all (the lock file's entries that are not development-only)`);
  });

  it('npm audit finds no High or Critical finding in the runtime dependencies (the development tools are listed, and judged by the report)', () => {
    const runtime = runAudit(REPO, true);
    if (!runtime.asked) {
      // an audit that could not ask is not a clean audit: say so and stop, unless the person running the test knows there is no network
      expect(process.env.JV_AUDIT_OFFLINE, `npm audit could not ask the registry (${runtime.problem}); set JV_AUDIT_OFFLINE=1 to skip it knowingly`).toBe('1');
      return;
    }
    expect(runtime.findings.filter(blocks), 'runtime dependencies with a High or Critical finding').toEqual([]);
    const all = runAudit(REPO, false);
    if (all.asked) console.log(`[T-D11] npm audit, runtime: ${JSON.stringify(runtime.counts)}; with the development tools: ${JSON.stringify(all.counts)}${all.findings.length ? ` (${all.findings.map((f) => `${f.name} ${f.severity}`).join(', ')})` : ''}`);
  }, 120_000);

  it('control: an audit that answers with a High or a Critical finding blocks, one with a moderate finding does not, and one that could not ask is not "clean"', () => {
    const answer = (...severities: string[]) => JSON.stringify({ vulnerabilities: Object.fromEntries(severities.map((s, i) => [`pkg${i}`, { name: `pkg${i}`, severity: s, via: [{ title: 'planted' }] }])), metadata: { vulnerabilities: {} } });
    expect(parseAudit(answer('moderate', 'low')).findings.filter(blocks)).toEqual([]);
    expect(parseAudit(answer('moderate', 'high')).findings.filter(blocks).map((f) => f.name)).toEqual(['pkg1']);
    expect(parseAudit(answer('critical')).findings.filter(blocks)).toHaveLength(1);
    expect(parseAudit(JSON.stringify({ error: { code: 'ENOTFOUND', summary: 'request failed' } })).asked).toBe(false);
    expect(parseAudit('not json').asked).toBe(false);
  });
});

// ------------------------------------------------------------------ T-D29: the repository

/** Places that name a forbidden word because they are about the rule: the plan and the spec quote it, one document says what was replaced, one tool recognises a PEM header. Never for URLs or keys. */
const EXCEPTIONS: SecretException[] = [
  ...Object.values(NEEDLES).map((word) => ({ path: 'specs/', word, why: 'the spec, the plan and the task list quote the rule they implement (U10, H3, T-D29)' })),
  ...[NEEDLES.supabaseSecret, NEEDLES.adminPassword, NEEDLES.staffPassword].map((word) => ({ path: 'PART-A-MARIADB-MAPPING.md', word, why: 'row H3 says which strings the build check replaces and which it keeps' })),
  { path: 'scripts/export-file.mjs', word: NEEDLES.pemHeader, why: 'tests whether a PUBLIC key file is PEM text (it never holds a key)' },
];

describe('T-D29 no tracked file holds a URL with a password, a private-key header, a key-shaped string or an old password (U10, H3)', () => {
  it('the repository (tracked files and new files git does not ignore) is clean; the exceptions are named, one file and one word each', () => {
    const { scanned, hits } = scanRepository(REPO, EXCEPTIONS);
    expect(scanned).toBeGreaterThan(150);
    expect(hits).toEqual([]);
    for (const e of EXCEPTIONS) expect(e.why.length).toBeGreaterThan(10);
  });

  // the planted lines are put together here: this file must not be a hit of its own scan
  const planted: [string, string][] = [
    ['a private-key header', `${NEEDLES.pemHeader} PRIVATE KEY-----`],
    ['a URL with a password', `const url = 'mysql${':'}//jv_user${':'}hunter2@127.0.0.1/jv';`],
    ['the old Supabase secret', `const k = '${NEEDLES.supabaseSecret}abc';`],
    ['the old admin password', `login('owner', '${NEEDLES.adminPassword}')`],
    ['the old staff password', `login('staff', '${NEEDLES.staffPassword}')`],
    ['an AWS key id', `key = "${'AKIA'}${'ABCDEFGHIJKLMNOP'}"`],
    ['a GitHub token', `token = "${'ghp_'}${'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'}"`],
    ['a secret assigned a long literal', `const apiKey = '${'x7Gq2LmZp9RvT4sYw8Nc3KdB'}';`],
  ];

  it.each(planted)('found: %s', (kind, line) => {
    const hits = scanForSecrets('src/planted.ts', `const fine = 1;\n${line}\nconst alsoFine = 2;\n`);
    expect(hits.length, kind).toBeGreaterThan(0);
    expect(hits[0].line).toBe(2);
    expect(JSON.stringify(hits)).not.toContain('hunter2'); // a hit names the kind and the line, never the text
  });

  it.each([
    ['a URL without a password', "const u = 'https://example.test/path?x=1';"],
    ['a user without a password', "const u = 'ssh://git@github.com/org/repo.git';"],
    ['a secret read at run time', 'const password = secret("pw"); const token = process.env.TOKEN;'],
    ['a short value', "const token = 'abc';"],
    ['the lock file hash lines', '      "integrity": "sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==",'],
  ])('allowed: %s', (_label, line) => {
    expect(scanForSecrets('src/ok.ts', line)).toEqual([]);
  });

  it('an exception covers its own file and its own word only', () => {
    const only: SecretException[] = [{ path: 'docs/', word: NEEDLES.adminPassword, why: 'a document that quotes the rule' }];
    const line = `old password ${NEEDLES.adminPassword} and ${NEEDLES.staffPassword}`;
    expect(scanForSecrets('docs/a.md', line, only).map((h) => h.kind)).toEqual(['the old staff password']);
    expect(scanForSecrets('src/a.ts', line, only)).toHaveLength(2);
    expect(scanForSecrets('docs/a.md', `${'postgres'}://u:p@h/db`, only)).toHaveLength(1); // a URL with a password is never excepted
  });

  it('a private-key line planted in a file of a scratch repository is found by the repository scan, and the repository is clean when it is taken away', () => {
    const dir = scratchRepo();
    writeFileSync(join(dir, 'README.md'), 'nothing here\n');
    expect(scanRepository(dir).hits).toEqual([]);
    const file = join(dir, 'config.txt');
    writeFileSync(file, `a = 1\n${NEEDLES.pemHeader} RSA PRIVATE KEY-----\n`);
    expect(scanRepository(dir).hits).toEqual([{ file: 'config.txt', line: 2, kind: 'a private-key header' }]);
    rmSync(file);
    expect(scanRepository(dir).hits).toEqual([]);
  });

  it('the words of the scan are all there: four named words and the key and URL patterns', () => {
    expect(FORBIDDEN_WORDS.map((w) => w.word)).toEqual(Object.values(NEEDLES));
  });
});

describe('T-D29 .env is ignored and .env.example holds names only (U10)', () => {
  it('this repository: .env is ignored, no .env file is tracked or about to be, and .env.example names every variable the config reads with no value', () => {
    expect(envFileProblems(REPO)).toEqual([]);
    const example = readFileSync(join(REPO, '.env.example'), 'utf8');
    expect(envExampleProblems(example)).toEqual([]);
    const names = new Set([...example.matchAll(/^#?\s*([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]));
    for (const v of CONFIG_VARIABLES) expect(names.has(v), `${v} named in .env.example`).toBe(true);
  });

  it('control: a value in .env.example, a commented secret with a value, and a default for a variable that is not on the short list are each found', () => {
    expect(envExampleProblems('DB_PASSWORD=\n# PORT=3000\n# LOG_LEVEL=info\n')).toEqual([]);
    expect(envExampleProblems(`DB_PASSWORD=${secret('pw')}\n`)).toEqual(['line 1: DB_PASSWORD has a value; .env.example holds names only']);
    expect(envExampleProblems('# DB_PASSWORD=hunter2\n')).toEqual(['line 1: DB_PASSWORD (commented out) has a value; only PORT and LOG_LEVEL may show a default']);
    expect(envExampleProblems('DB_HOST=localhost\nDB_PORT=\n')).toEqual(['line 1: DB_HOST has a value; .env.example holds names only']);
  });

  it('control: a scratch repository that does not ignore .env is found; with .env ignored it is clean; a tracked .env.local is found', () => {
    const open = scratchRepo('node_modules/\n');
    writeFileSync(join(open, '.env'), 'DB_HOST=x\n');
    expect(envFileProblems(open)).toEqual(['.env is not ignored by git (.gitignore)', '.env is tracked (or would be): only .env.example may be']);
    const closed = scratchRepo('.env\n');
    writeFileSync(join(closed, '.env'), 'DB_HOST=x\n');
    writeFileSync(join(closed, '.env.example'), 'DB_HOST=\n');
    expect(envFileProblems(closed)).toEqual([]);
    writeFileSync(join(closed, '.env.local'), 'DB_HOST=x\n');
    expect(envFileProblems(closed)).toEqual(['.env.local is tracked (or would be): only .env.example may be']);
  });
});

describe('T-D29 the API refuses to start when an environment variable is missing (U10)', () => {
  let dist: string;
  beforeAll(() => {
    dist = buildDist();
  }, 120_000);

  const REQUIRED = ['DB_HOST', 'DB_PORT', 'DB_NAME', 'DB_USER', 'DB_PASSWORD'] as const;
  const envOf = (values: Record<string, string>) => ({ PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...values });
  const good = () => ({ DB_HOST: '127.0.0.1', DB_PORT: '1', DB_NAME: 'jv_none', DB_USER: 'jv_none', DB_PASSWORD: secret('pw') });

  it.each(REQUIRED)('%s missing: exit code 1 before any port is opened, the message names the variable and holds no value', (name) => {
    const values: Record<string, string> = { ...good(), PORT: '0' };
    delete values[name];
    const r = spawnSync(process.execPath, [join(dist, 'server.js')], { env: envOf(values), encoding: 'utf8', timeout: 30_000 });
    expect(r.status, `${name} unset`).toBe(1);
    expect(r.stderr).toContain(`${name} is missing`);
    for (const v of Object.values(values).filter((x) => x.length >= 6)) expect(r.stderr + r.stdout).not.toContain(v);
    // an empty value is as missing as an unset one
    const blank = spawnSync(process.execPath, [join(dist, 'server.js')], { env: envOf({ ...values, [name]: '' }), encoding: 'utf8', timeout: 30_000 });
    expect(blank.status, `${name} empty`).toBe(1);
    expect(blank.stderr).toContain(`${name} is missing`);
  }, 90_000);

  it('control: with all five variables the same entry file starts and listens (it would be a test of nothing if the refusal came from somewhere else)', async () => {
    const port = await freePort();
    const child = spawn(process.execPath, [join(dist, 'server.js')], { env: envOf({ ...good(), PORT: String(port) }), stdio: 'ignore' });
    try {
      let up = false;
      for (let i = 0; i < 60 && !up; i++) {
        up = await canConnect(port);
        if (!up) await new Promise((r) => setTimeout(r, 250));
      }
      expect(up).toBe(true);
      expect(child.exitCode).toBeNull();
    } finally {
      child.kill('SIGKILL');
    }
  }, 60_000);
});

describe('T-D29 the production bundle contains no ctx.pause test hook (X0 item 8; finished by API15, which adds the hook)', () => {
  let dist: string;
  beforeAll(() => {
    dist = buildDist();
  }, 120_000);

  it('the compiled output of src/ (the build npm run build makes) has no ctx.pause, no call of pause() and no hook point name', () => {
    expect(pauseHookHits(dist)).toEqual([]);
  });

  it('control: a ctx.pause call planted in a scratch bundle is found, comments and other pause() methods are not, and the bundle is clean when it is taken away', () => {
    const bundle = scratchDir();
    mkdirSync(join(bundle, 'money'));
    const file = join(bundle, 'money', 'record-payment.js');
    writeFileSync(file, "export async function recordPayment(ctx, args) {\n  await ctx.pause('record_payment.after_read');\n  return args;\n}\n");
    const hits = pauseHookHits(bundle);
    expect(hits.map((h) => `${h.file}:${h.line}`)).toEqual([`${join('money', 'record-payment.js')}:2`, `${join('money', 'record-payment.js')}:2`]);
    expect(hits.map((h) => h.what)).toEqual(['ctx.pause (the test hook)', 'the hook point name "record_payment.after_read"']);
    writeFileSync(file, "// ctx.pause('record_payment.after_read') exists only in the test build\nexport async function recordPayment(ctx, args) {\n  ctx.stream.pause();\n  return args;\n}\n");
    expect(pauseHookHits(bundle)).toEqual([]);
  });

  it('control: the hook under other spellings is found too', () => {
    const bundle = scratchDir();
    writeFileSync(join(bundle, 'a.js'), "export const a = (ctx) => ctx['pause']('x');\nexport const b = (c) => { const { pause } = c; return pause('y'); };\nexport const d = (txCtx) => txCtx.pause('z');\n");
    expect(pauseHookHits(bundle).map((h) => h.line)).toEqual([1, 2, 3]);
  });
});
