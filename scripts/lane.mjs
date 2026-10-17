#!/usr/bin/env node
// The lane harness (plan rule "one lane, one database"): every agent has its own throw-away MariaDB 11.8 in Docker, so two agents never reset each other's data.
//   npm run db:lane -- up <lane>      start the lane's container if needed, create its database and the ten-box user, migrate as that user
//   npm run db:lane -- down <lane>    docker rm -fv of that one container (there is no volume to leave behind)
//   npm run db:lane -- reset <lane>   drop every jv_* database and user in the container and build the lane database again from the migration files
//   npm run db:lane -- url <lane>     the connection URL, without the password
// Lanes: main, a, b, c. Container jv-mariadb-<lane>, published on 127.0.0.1 only, port 33310 + the lane number (main 0, a 1, b 2, c 3).
// The server copies Hostinger: READ-COMMITTED and the NON-strict sql_mode (HOSTINGER-FACTS), so a test that needs strict mode has to ask for it per connection (S11).
// Passwords are made up when the container starts, reach Docker through the environment (never the command line) and are read back with docker inspect.
// Nothing prints or stores them; vitest.config.ts hands them to the test workers in memory.
// JV_LANE_NAMESPACE=<letters> (and JV_LANE_PORT_BASE=<port>) on the command line gives a sandbox that cannot collide with a real lane: jv-mariadb-<namespace>-<lane>.
import { execFile, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import mysql from 'mysql2/promise';
import { migrate } from './migrate.mjs';

const run = promisify(execFile);

export const LANES = ['main', 'a', 'b', 'c'];
const LANE_NUMBER = { main: 0, a: 1, b: 2, c: 3 };
const DEFAULT_PORT_BASE = 33310;
const HOST = '127.0.0.1';
const IMAGE = 'mariadb:11.8';
export const LANE_DATABASE = 'jv_lane';
export const LANE_USER = 'jv_lane';
/** What Hostinger's server reports (HOSTINGER-FACTS): not strict. */
export const HOSTINGER_SQL_MODE = 'NO_AUTO_CREATE_USER,NO_ENGINE_SUBSTITUTION';
/** The ten ticked boxes of hPanel's Change Permissions (spec A3). Delete and Drop and the other six are unticked. */
export const TEN_BOXES = ['SELECT', 'INSERT', 'UPDATE', 'CREATE', 'ALTER', 'INDEX', 'REFERENCES', 'TRIGGER', 'CREATE TEMPORARY TABLES', 'LOCK TABLES'];

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The container name and port of a lane. A namespace (letters and digits) is for the harness's own tests: jv-mariadb-<namespace>-<lane>, so they never touch a real lane. */
function resolve(lane, { namespace = '', portBase = DEFAULT_PORT_BASE } = {}) {
  if (!LANES.includes(lane)) throw new Error(`unknown lane ${JSON.stringify(String(lane))}: the lanes are ${LANES.join(', ')}`);
  if (namespace !== '' && !/^[a-z][a-z0-9]{0,11}$/.test(namespace)) throw new Error('namespace: lower-case letters and digits only');
  if (!Number.isInteger(portBase) || portBase < 1024 || portBase + 3 > 65535) throw new Error('portBase out of range');
  const name = namespace ? `jv-mariadb-${namespace}-${lane}` : `jv-mariadb-${lane}`;
  // the only names this file ever hands to docker rm: never the guard container, never the spike
  if (!/^jv-mariadb-(?:[a-z][a-z0-9]{0,11}-)?(?:main|a|b|c)$/.test(name)) throw new Error(`refusing container name ${name}`);
  return { lane, namespace, name, port: portBase + LANE_NUMBER[lane] };
}

async function inspect(name) {
  try {
    const { stdout } = await run('docker', ['inspect', name]);
    return JSON.parse(stdout)[0];
  } catch (e) {
    if (/No such (object|container)/i.test(String(e.stderr ?? e.message))) return null;
    throw e;
  }
}

function describe(r, c) {
  const env = Object.fromEntries((c.Config.Env ?? []).map((kv) => [kv.slice(0, kv.indexOf('=')), kv.slice(kv.indexOf('=') + 1)]));
  const labels = c.Config.Labels ?? {};
  if (labels['jv.lane'] !== r.lane || (labels['jv.namespace'] ?? '') !== r.namespace || !env.MARIADB_ROOT_PASSWORD || !env.JV_LANE_APP_PASSWORD) {
    throw new Error(`container ${r.name} exists but was not started by scripts/lane.mjs: remove it yourself with docker rm -fv ${r.name}, then run up again`);
  }
  return { lane: r.lane, name: r.name, host: HOST, port: r.port, database: LANE_DATABASE, appUser: LANE_USER, appPassword: env.JV_LANE_APP_PASSWORD, rootPassword: env.MARIADB_ROOT_PASSWORD, running: c.State.Running === true };
}

const publicInfo = ({ appPassword, rootPassword, ...rest }) => rest;

/** The lane's container, with its generated passwords, or null when there is none. Never print what this returns. */
export async function laneInfo(lane, opts) {
  const r = resolve(lane, opts);
  const c = await inspect(r.name);
  return c ? describe(r, c) : null;
}

/** Hands the selected lane to the test workers (vitest.config.ts). Throws when the lane is not up: tests must never fall back to somebody else's database. */
export function laneEnv(lane, opts) {
  const r = resolve(lane, opts);
  let c;
  try {
    c = JSON.parse(execFileSync('docker', ['inspect', r.name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }))[0];
  } catch {
    throw new Error(`lane ${lane} is not up (no container ${r.name}): run  npm run db:lane -- up ${lane}`);
  }
  const i = describe(r, c);
  if (!i.running) throw new Error(`lane ${lane} is stopped: run  npm run db:lane -- up ${lane}`);
  return { JV_LANE: lane, JV_DB_PORT: String(i.port), JV_DB_ROOT_PASSWORD: i.rootPassword, JV_LANE_DATABASE: i.database, JV_LANE_USER: i.appUser, JV_LANE_PASSWORD: i.appPassword };
}

/** The lane this checkout works in: JV_LANE, else the first word of the untracked file .lane, else none (the old spike container on 33307 stays the default). */
export function selectedLane() {
  const fromEnv = process.env.JV_LANE?.trim();
  const fromFile = existsSync(join(ROOT, '.lane')) ? readFileSync(join(ROOT, '.lane'), 'utf8').trim().split(/\s+/)[0] : '';
  const lane = fromEnv || fromFile || null;
  if (lane !== null && !LANES.includes(lane)) throw new Error(`JV_LANE / .lane says ${JSON.stringify(lane)}: the lanes are ${LANES.join(', ')}`);
  return lane;
}

/** A: the user of A3 on one database: exactly the ten ticked boxes, nothing else. Dropped and made again, so the result is the same whatever was there. */
export async function createTenBoxUser(root, { database, user, password }) {
  await root.query("DROP USER IF EXISTS ?@'%'", [user]);
  await root.query("CREATE USER ?@'%' IDENTIFIED BY ?", [user, password]);
  await root.query(`GRANT ${TEN_BOXES.join(', ')} ON ${mysql.escapeId(database)}.* TO ?@'%'`, [user]);
}

const connect = (info, user, password, extra = {}) =>
  mysql.createConnection({ host: info.host, port: info.port, user, password, decimalNumbers: false, supportBigNumbers: true, bigNumberStrings: true, dateStrings: true, ...extra });

async function waitReady(info, name) {
  let last;
  for (let i = 0; i < 90; i++) {
    try {
      const c = await connect(info, 'root', info.rootPassword);
      await c.query('SELECT 1');
      await c.end();
      return;
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw new Error(`${name} did not become ready in 90 s: ${last?.message}`);
}

/** The lane database and its ten-box user, migrated as that user (migrations, seeds and the triggers of db/optional: the same files Hostinger gets). */
async function ensureDatabase(info) {
  const root = await connect(info, 'root', info.rootPassword);
  try {
    await root.query(`CREATE DATABASE IF NOT EXISTS ${mysql.escapeId(info.database)} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    await createTenBoxUser(root, { database: info.database, user: info.appUser, password: info.appPassword });
  } finally {
    await root.end();
  }
  const u = await connect(info, info.appUser, info.appPassword, { database: info.database, multipleStatements: true });
  try {
    await migrate(u, { seeds: true, optional: true });
  } finally {
    await u.end();
  }
}

export async function laneUp(lane, opts) {
  const r = resolve(lane, opts);
  let c = await inspect(r.name);
  if (c) describe(r, c); // refuses a container this script did not start
  if (c && !c.State.Running) {
    await run('docker', ['rm', '-fv', r.name]); // a stopped tmpfs container has lost its data anyway
    c = null;
  }
  if (!c) {
    const rootPassword = randomBytes(18).toString('base64url');
    const appPassword = randomBytes(18).toString('base64url');
    await run(
      'docker',
      [
        'run', '-d', '--name', r.name,
        '--label', `jv.lane=${r.lane}`, '--label', `jv.namespace=${r.namespace}`,
        '-p', `${HOST}:${r.port}:3306`,
        '--tmpfs', '/var/lib/mysql:rw,size=1g',
        '-e', 'MARIADB_ROOT_PASSWORD', '-e', 'JV_LANE_APP_PASSWORD', // names only: the values travel in the environment of the docker command
        IMAGE,
        '--transaction-isolation=READ-COMMITTED', '--character-set-server=utf8mb4', '--collation-server=utf8mb4_unicode_ci', `--sql-mode=${HOSTINGER_SQL_MODE}`,
      ],
      { env: { ...process.env, MARIADB_ROOT_PASSWORD: rootPassword, JV_LANE_APP_PASSWORD: appPassword } },
    );
  }
  const info = describe(r, await inspect(r.name));
  try {
    await waitReady(info, r.name);
    await ensureDatabase(info);
  } catch (e) {
    if (!c) await run('docker', ['rm', '-fv', r.name]).catch(() => {}); // a container that never came up is not left behind
    throw e;
  }
  return publicInfo(info);
}

/** docker rm -fv of this lane's container, and of nothing else. Returns whether there was one. */
export async function laneDown(lane, opts) {
  const r = resolve(lane, opts);
  if (!(await inspect(r.name))) return false;
  await run('docker', ['rm', '-fv', r.name]);
  return true;
}

export async function laneReset(lane, opts) {
  const r = resolve(lane, opts);
  const c = await inspect(r.name);
  if (!c || !c.State.Running) return laneUp(lane, opts);
  const info = describe(r, c);
  const root = await connect(info, 'root', info.rootPassword);
  try {
    const [dbs] = await root.query('SHOW DATABASES');
    for (const row of dbs) {
      const name = String(Object.values(row)[0]);
      if (/^jv_/.test(name)) await root.query(`DROP DATABASE ${mysql.escapeId(name)}`);
    }
    const [users] = await root.query("SELECT User AS u, Host AS h FROM mysql.global_priv WHERE User LIKE 'jv\\_%'");
    for (const row of users) await root.query('DROP USER IF EXISTS ?@?', [row.u, row.h]);
  } finally {
    await root.end();
  }
  await ensureDatabase(info);
  return publicInfo(info);
}

/** The connection URL of the lane database as the ten-box user, without the password. */
export async function laneUrl(lane, opts) {
  const r = resolve(lane, opts);
  return `mysql://${LANE_USER}@${HOST}:${r.port}/${LANE_DATABASE}`;
}

// command line
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [cmd, lane] = process.argv.slice(2);
  const usage = 'usage: npm run db:lane -- up|down|reset|url <main|a|b|c>';
  try {
    if (!['up', 'down', 'reset', 'url'].includes(cmd) || !lane) throw new Error(usage);
    const opts = { namespace: process.env.JV_LANE_NAMESPACE ?? '', portBase: Number(process.env.JV_LANE_PORT_BASE ?? DEFAULT_PORT_BASE) };
    if (cmd === 'up' || cmd === 'reset') {
      const i = await (cmd === 'up' ? laneUp : laneReset)(lane, opts);
      console.log(`lane ${lane} is ready: container ${i.name}, ${await laneUrl(lane, opts)} (the password is made up per container and is not printed)`);
    } else if (cmd === 'down') {
      console.log((await laneDown(lane, opts)) ? `lane ${lane}: container removed` : `lane ${lane}: no container`);
    } else {
      console.log(await laneUrl(lane, opts));
    }
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
