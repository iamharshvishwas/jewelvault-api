import { chmodSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app';
import { loadConfig } from '../../src/config';
import { type DbPool, createDbPool } from '../../src/db/pool';
import { type Scratch, scratchDatabase } from '../helpers';
import { asJson, cleanUp, tempDir } from './dump-support';
import { logSink, secret, testConfig } from './support';

// T-R03, the start-up half of spec 5.2.2 (B2, I12, S11): "every hourly run and the start-up check test that the folder exists and is writable". The shop works without its backup folder, so a folder
// that is missing or read-only does NOT stop the API (unlike the checks of S11 that do): it is logged with logError (sys_error_log, code JV_BACKUP_FOLDER) and recorded in backup_runs (ok = 0,
// detail.folder_probe) for the dashboard line. The hourly dump (tests/api/dump-job.test.ts) writes the same rows.

const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
let scratch: Scratch;
const pools: DbPool[] = [];
const apps: FastifyInstance[] = [];

beforeEach(async () => {
  scratch = await scratchDatabase('bkstart', { schema: true });
}, 120_000);
afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close().catch(() => undefined)));
  await Promise.all(pools.splice(0).map((p) => p.end().catch(() => undefined)));
  await scratch?.drop();
  await cleanUp();
}, 60_000);

async function start(backupDir: string | undefined) {
  const pool = createDbPool(scratch.db);
  pools.push(pool);
  const sink = logSink();
  const app = buildApp({ config: testConfig({ db: scratch.db, ...(backupDir === undefined ? {} : { backupDir }) }), db: pool, logStream: sink.stream });
  apps.push(app);
  await app.ready();
  return { app, sink };
}
const marks = async () => {
  const c = await scratch.connect();
  try {
    const [r] = await c.query<any[]>("SELECT kind, ok, detail FROM backup_runs WHERE JSON_CONTAINS_PATH(detail, 'one', '$.folder_probe') ORDER BY id");
    const [e] = await c.query<any[]>("SELECT level, code, message, detail FROM sys_error_log WHERE code = 'JV_BACKUP_FOLDER' ORDER BY id");
    return { runs: r.map((x) => ({ ...x, detail: asJson(x.detail) })), errors: e.map((x) => ({ ...x, detail: asJson(x.detail) })) };
  } finally {
    await c.end();
  }
};

describe('T-R03 JV_BACKUP_DIR is a setting of the API like the others (read once, in config)', () => {
  it('is optional, kept as written (the folder is judged by the check, not by the config), and absent when unset', () => {
    const env = { DB_HOST: '127.0.0.1', DB_PORT: '3306', DB_NAME: 'x', DB_USER: 'u', DB_PASSWORD: secret('db'), ALLOWED_ORIGINS: 'https://app.example.test' };
    expect(loadConfig(env).backupDir).toBeUndefined();
    expect(loadConfig({ ...env, JV_BACKUP_DIR: '/home/u123/jv-backup' }).backupDir).toBe('/home/u123/jv-backup');
    expect(loadConfig({ ...env, JV_BACKUP_DIR: 'relative/looks/wrong' }).backupDir).toBe('relative/looks/wrong');
  });
});

describe('T-R03 the start-up check tests the backup folder (S11, spec 5.2.2)', () => {
  it('a missing folder: the API starts and answers (the shop works), and the failure is recorded for the dashboard and logged with logError', async () => {
    const dir = path.join(tempDir(), 'gone', 'jv-backup');
    const { app } = await start(dir);
    expect(app.startup?.ok).toBe(true);
    expect((await app.inject({ method: 'GET', url: '/readyz' })).statusCode).toBe(200);
    expect(existsSync(path.dirname(dir))).toBe(false); // never made
    const { runs, errors } = await marks();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ kind: 'db_dump', ok: 0 });
    expect(runs[0].detail.folder_probe).toMatchObject({ ok: false, code: 'ENOENT', where: 'folder' });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ level: 'error', code: 'JV_BACKUP_FOLDER' });
    expect(JSON.stringify(errors[0])).not.toContain(dir); // the path is not written down
  }, 120_000);

  it.skipIf(isRoot)('a read-only folder (EACCES) is recorded the same way', async () => {
    const dir = tempDir();
    chmodSync(dir, 0o555);
    try {
      const { app } = await start(dir);
      expect(app.startup?.ok).toBe(true);
      const { runs } = await marks();
      expect(runs[0].detail.folder_probe).toMatchObject({ ok: false, code: 'EACCES' });
    } finally {
      chmodSync(dir, 0o755);
    }
  }, 120_000);

  it('a good folder writes nothing; a relative or "~" value is a recorded CONFIG problem, not a crash; unset is not probed at all', async () => {
    const dir = tempDir();
    await start(dir);
    expect((await marks()).runs).toEqual([]);
    await start('~/jv-backup');
    const bad = await marks();
    expect(bad.runs).toHaveLength(1);
    expect(bad.runs[0].detail.folder_probe).toMatchObject({ ok: false, code: 'CONFIG', where: 'JV_BACKUP_DIR' });
    await start(undefined);
    expect((await marks()).runs).toHaveLength(1);
  }, 180_000);

  it('every deploy starts the app twice: two starts with the folder still missing record ONE failure; the start after the fix records the heal; a third start adds nothing', async () => {
    const parent = tempDir();
    const dir = path.join(parent, 'jv-backup');
    await start(dir);
    await start(dir);
    expect((await marks()).runs).toHaveLength(1);
    expect((await marks()).errors).toHaveLength(1);
    mkdirSync(dir);
    await start(dir);
    expect((await marks()).runs.map((r) => r.detail.folder_probe.ok)).toEqual([false, true]);
    await start(dir);
    expect((await marks()).runs).toHaveLength(2);
    rmSync(dir, { recursive: true });
  }, 240_000);
});
