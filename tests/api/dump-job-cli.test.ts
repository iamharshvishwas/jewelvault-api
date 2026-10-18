import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { unpackExport } from '../../scripts/export-file.mjs';
import { type DumpWorld, backupRuns, cleanUp, dumpWorld, jobRuns, names, tempDir } from './dump-support';
import { REPO } from './support';

// T-R03, the command half: `node scripts/job.js dump` as hPanel's Custom cron job runs it (a child process, the environment as the only source, no arguments but the mode word). The clock of the
// child is set by a preload module of the tests (fixtures/fake-clock.mjs) so that the test does not depend on the hour it is run at. The key pair is made by `npm run keygen` (keygen.mjs).

afterAll(cleanUp);

const SCRIPT = path.join(REPO, 'scripts/job.js');
const CLOCK = path.join(REPO, 'tests/api/fixtures/fake-clock.mjs');

interface Out {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Runs `node [--import fake-clock] scripts/job.js <args>`; the child gets only the environment it is given (and PATH). */
function job(args: string[], env: Record<string, string | undefined>, now?: string): Promise<Out> {
  const childEnv: Record<string, string> = { PATH: process.env.PATH ?? '' };
  for (const [k, v] of Object.entries(env)) if (v !== undefined) childEnv[k] = v;
  if (now) childEnv.JV_TEST_NOW = now;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...(now ? ['--import', CLOCK] : []), SCRIPT, ...args], { env: childEnv, cwd: tempDir('jv dump cwd ') });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

const NIGHT = '2026-11-02T21:30:00Z'; // 03:00 on 3 November in Asia/Kolkata
const DATE = '2026-11-03';
const secretsIn = (world: DumpWorld) => [world.env.DB_PASSWORD, world.keys.publicLine, world.keys.privatePem.split('\n')[1]];

describe('T-R03 scripts/job.js dump (the command of the Custom cron job)', () => {
  it('needs the mode word: no word or another word prints the usage and exits 2; nothing is opened', async () => {
    const none = await job([], {});
    expect(none.code).toBe(2);
    expect(none.stderr).toMatch(/usage: .*job\.js dump/);
    const other = await job(['tick'], {});
    expect(other.code).toBe(2);
  }, 30_000);

  it('a missing database setting exits 2 and names the variable, not any value', async () => {
    const out = await job(['dump'], { DB_HOST: '203.0.113.9', DB_PORT: '3306', DB_NAME: 'shop_db_name', DB_USER: 'shop_user' });
    expect(out.code).toBe(2);
    expect(out.stderr).toMatch(/DB_PASSWORD/);
    for (const v of ['203.0.113.9', 'shop_db_name', 'shop_user']) expect(out.stderr + out.stdout).not.toContain(v);
  }, 30_000);

  it('before 02:00 Asia/Kolkata it ends at once with exit 0 and writes nothing; at 03:00 it dumps: one encrypted file, one ok row, and neither a password nor a key on the screen', async () => {
    const world = await dumpWorld();
    const early = await job(['dump'], world.env, '2026-11-02T20:00:00Z'); // 01:30 on the 3rd
    expect(early.code).toBe(0);
    expect(early.stdout).toMatch(/not due/);
    expect(names(world.folder, 'daily')).toEqual([]);
    expect(await jobRuns(world)).toHaveLength(0);

    const res = await job(['dump'], world.env, NIGHT);
    expect(res.code).toBe(0);
    expect(res.stdout).toMatch(new RegExp(`dump: done ${DATE} daily/${DATE}\\.enc`));
    expect(names(world.folder, 'daily')).toEqual([`${DATE}.enc`]);
    const ok = (await backupRuns(world, 'db_dump')).filter((r) => r.ok === 1);
    expect(ok).toHaveLength(1);
    await unpackExport(path.join(world.folder, `daily/${DATE}.enc`), world.keys.privatePem, tempDir('jv dump out '));
    for (const s of secretsIn(world)) {
      expect(res.stdout).not.toContain(s);
      expect(res.stderr).not.toContain(s);
    }
    // the same day again: today's db_dump is ok, the command ends at once
    const again = await job(['dump'], world.env, '2026-11-03T05:00:00Z');
    expect(again.code).toBe(0);
    expect(again.stdout).toMatch(/already done/);
    expect(names(world.folder, 'daily')).toEqual([`${DATE}.enc`]);
  }, 240_000);

  it('--load-env=<path> reads the settings from a file (when the command line is too long for the Custom field, 255 characters); a variable already in the environment wins', async () => {
    const world = await dumpWorld();
    const file = path.join(tempDir('jv dump env '), 'config.env');
    writeFileSync(file, Object.entries({ ...world.env, JV_BACKUP_DIR: '/this/is/not/used' }).map(([k, v]) => `${k}=${v}`).join('\n') + '\n', { mode: 0o600 });
    const out = await job(['dump', `--load-env=${file}`], { JV_BACKUP_DIR: world.folder }, NIGHT);
    expect(out.code).toBe(0);
    expect(names(world.folder, 'daily')).toEqual([`${DATE}.enc`]);
    const missing = await job(['dump', `--load-env=${file}.nope`], {}, NIGHT);
    expect(missing.code).toBe(2);
    expect(missing.stderr).toMatch(/env file/);
  }, 240_000);

  it('a dump that finds the lock taken exits 0 at once ("another dump is running") and writes nothing', async () => {
    const world = await dumpWorld();
    const holder = await world.scratch.connect();
    try {
      expect((await holder.query<any[]>('SELECT GET_LOCK(?, 0) AS got', [`jv_dump:${world.scratch.db.name}`]))[0][0].got).toBe(1);
      const out = await job(['dump'], world.env, NIGHT);
      expect(out.code).toBe(0);
      expect(out.stdout).toMatch(/another dump is running/);
      expect(names(world.folder, 'daily')).toEqual([]);
    } finally {
      await holder.end();
    }
  }, 120_000);

  it('two `job.js dump` started together run once: one file, one ok row, one sys_job_runs row, and both exit 0', async () => {
    const world = await dumpWorld();
    const [a, b] = await Promise.all([job(['dump'], world.env, NIGHT), job(['dump'], world.env, NIGHT)]);
    expect([a.code, b.code]).toEqual([0, 0]);
    expect(names(world.folder, 'daily')).toEqual([`${DATE}.enc`]);
    expect((await backupRuns(world, 'db_dump')).filter((r) => r.ok === 1)).toHaveLength(1);
    expect(await jobRuns(world)).toHaveLength(1);
    const said = [a.stdout, b.stdout].map((s) => (/dump: done/.test(s) ? 'done' : /another dump is running/.test(s) ? 'locked' : /already done/.test(s) ? 'already' : s));
    expect(said.filter((x) => x === 'done')).toHaveLength(1);
    expect(said.filter((x) => x !== 'done').every((x) => x === 'locked' || x === 'already')).toBe(true);
  }, 240_000);

  it('a missing backup folder exits 1 and says so on the error output (cron shows it); the folder is not made', async () => {
    const world = await dumpWorld({ folderExists: false });
    const out = await job(['dump'], world.env, NIGHT);
    expect(out.code).toBe(1);
    expect(out.stderr).toMatch(/ENOENT/);
    expect(existsSync(world.env.JV_BACKUP_DIR)).toBe(false);
    expect((await backupRuns(world, 'db_dump')).filter((r) => r.ok === 0)).toHaveLength(1);
  }, 120_000);
});
