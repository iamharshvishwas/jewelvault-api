import { execFile } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// PT-RV2b (RV2-4): vitest.config.ts handed the test workers the REAL lane's container even when JV_LANE_NAMESPACE and JV_LANE_PORT_BASE were set, because it called laneEnv(lane) without them
// (the lane tool, `npm run db:lane`, and seed-volume.mjs did read them). A run meant for a sandbox container then dropped and made databases in the container of whoever owns the real lane.
//
// The test loads vitest.config.ts the way vitest does, in a child process, with a stand-in for `docker` first on the PATH: the stand-in answers `docker inspect <name>` for any name the harness may ask
// for, and writes the name down. So the test sees exactly which container the config asks for and which port it hands to the workers, touches no real container (it only reads a file), and needs no
// sandbox container to exist. What is printed is the lane and the port only, never a password.

const run = promisify(execFile);
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const LANE_NUMBER: Record<string, number> = { main: 0, a: 1, b: 2, c: 3 };
const REAL_PORTS = [33311, 33312, 33313]; // the lanes a, b and c of every checkout

/** A node script named `docker`: `docker inspect <name>` answers a container the lane tool started (its labels, a running state, two made-up values) and notes the name. Nothing else is understood. */
const FAKE_DOCKER = `#!/usr/bin/env node
const fs = require('node:fs');
const [cmd, name] = process.argv.slice(2);
if (cmd !== 'inspect') { console.error('stand-in docker: only inspect'); process.exit(2); }
fs.appendFileSync(process.env.STAND_IN_LOG, name + '\\n');
const m = /^jv-mariadb-(?:([a-z][a-z0-9]{0,11})-)?(main|a|b|c)$/.exec(name);
if (!m) { console.error('Error: No such object: ' + name); process.exit(1); }
console.log(JSON.stringify([{ Name: '/' + name, State: { Running: true }, Config: { Labels: { 'jv.lane': m[2], 'jv.namespace': m[1] ?? '' }, Env: ['MARIADB_ROOT_PASSWORD=r', 'JV_LANE_APP_PASSWORD=p'] } }]));
`;

const PROBE = `const m = await import('./vitest.config.ts'); const e = m.default.test.env; process.stdout.write(JSON.stringify({ lane: e.JV_LANE ?? null, port: e.JV_DB_PORT ?? null }));`;

let dir: string;
let log: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'jv-rv2b-'));
  log = join(dir, 'asked.txt');
  writeFileSync(join(dir, 'docker'), FAKE_DOCKER);
  chmodSync(join(dir, 'docker'), 0o755);
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** What vitest.config.ts resolves for these variables: the containers it asked docker about, and the lane and port it hands to the workers. */
async function configFor(vars: Record<string, string>): Promise<{ asked: string[]; lane: string | null; port: string | null }> {
  writeFileSync(log, '');
  const env: Record<string, string | undefined> = { ...process.env, PATH: `${dir}${delimiter}${process.env.PATH ?? ''}`, STAND_IN_LOG: log };
  for (const k of ['JV_LANE', 'JV_LANE_NAMESPACE', 'JV_LANE_PORT_BASE']) delete env[k]; // the variables of this run must not leak into the probe
  const r = await run(process.execPath, ['--input-type=module', '-e', PROBE], { cwd: REPO, env: { ...env, ...vars } });
  const found = JSON.parse(r.stdout) as { lane: string | null; port: string | null };
  return { asked: readFileSync(log, 'utf8').split('\n').filter(Boolean), ...found };
}

describe('PT-RV2b (RV2-4) the namespace variables reach the test config, and a set namespace never resolves to a real lane', () => {
  it('JV_LANE_NAMESPACE and JV_LANE_PORT_BASE set: for lane a, b and c the config asks for the sandbox container jv-mariadb-<namespace>-<lane> and hands the workers the port of the sandbox, never 33311 to 33313', async () => {
    for (const lane of ['a', 'b', 'c']) {
      const r = await configFor({ JV_LANE: lane, JV_LANE_NAMESPACE: 'rvtwob', JV_LANE_PORT_BASE: '33990' });
      expect(r.asked, `lane ${lane}: the container asked for`).toEqual([`jv-mariadb-rvtwob-${lane}`]);
      expect(r.lane).toBe(lane);
      expect(r.port, `lane ${lane}: the port of the sandbox`).toBe(String(33990 + LANE_NUMBER[lane]));
      expect(REAL_PORTS, `lane ${lane}: a real lane's port`).not.toContain(Number(r.port));
    }
  });

  it('no namespace (not set, or set to nothing) still resolves to the real lanes: jv-mariadb-<lane>, ports 33311 to 33313 for a, b and c', async () => {
    for (const [lane, port] of [['a', '33311'], ['b', '33312'], ['c', '33313']]) {
      const variants: Record<string, string>[] = [{ JV_LANE: lane }, { JV_LANE: lane, JV_LANE_NAMESPACE: '', JV_LANE_PORT_BASE: '33310' }];
      for (const vars of variants) {
        const r = await configFor(vars);
        expect(r.asked, `lane ${lane} ${JSON.stringify(vars)}: the container asked for`).toEqual([`jv-mariadb-${lane}`]);
        expect(r.port, `lane ${lane} ${JSON.stringify(vars)}`).toBe(port);
      }
    }
  });

  it('the stand-in is honest: a name that is not a lane container is "no such object" (so a namespace the config dropped could not pass by luck)', async () => {
    const r = await run(join(dir, 'docker'), ['inspect', 'jv-mariadb-spike'], { env: { ...process.env, STAND_IN_LOG: log } }).then(
      () => ({ code: 0 }),
      (e) => ({ code: e.code as number }),
    );
    expect(r.code).toBe(1);
  });
});
