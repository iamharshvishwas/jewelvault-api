import { type ChildProcess, execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import mysql, { type Connection } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app';
import { createClock } from '../../src/clock';
import { TEN_BOXES, laneDown, laneInfo, laneUp } from '../../scripts/lane.mjs';
import { auditTriggersInstalled } from '../../scripts/audit-triggers.mjs';
import { migrate } from '../../scripts/migrate.mjs';
import { buildDist, canConnect, freePort, logSink, secret, testConfig } from './support';

// PT-H1, the plan test of API01: a lane database starts, migrates as the ten-box user (A3) and is removed;
// the injected clock never repeats an instant (S5); the server refuses to start without DB_PASSWORD (U10, S1); GET /healthz answers through inject().
// The harness is tried in a sandbox namespace (containers jv-mariadb-h1t-<lane>, ports 33351 and 33352), so it never touches a real lane.

const SANDBOX = { namespace: 'h1t', portBase: 33350 } as const;
const docker = (...args: string[]) => execFileSync('docker', args, { encoding: 'utf8' }).trim();
const containers = () => docker('ps', '-a', '--no-trunc', '--format', '{{.ID}} {{.Names}}').split('\n').filter(Boolean);

async function asLaneUser(lane: 'a' | 'b'): Promise<Connection> {
  const info = (await laneInfo(lane, SANDBOX))!;
  return mysql.createConnection({
    host: info.host, port: info.port, user: info.appUser, password: info.appPassword, database: info.database,
    multipleStatements: true, decimalNumbers: false, supportBigNumbers: true, bigNumberStrings: true, dateStrings: true,
  });
}
async function asRoot(lane: 'a' | 'b'): Promise<Connection> {
  const info = (await laneInfo(lane, SANDBOX))!;
  return mysql.createConnection({ host: info.host, port: info.port, user: 'root', password: info.rootPassword });
}
const snapshot = async (c: Connection) => {
  const [cols] = await c.query<any[]>('SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME, ORDINAL_POSITION');
  const [trig] = await c.query<any[]>('SELECT TRIGGER_NAME, EVENT_OBJECT_TABLE, ACTION_STATEMENT FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = DATABASE() ORDER BY TRIGGER_NAME');
  const [mig] = await c.query<any[]>('SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version');
  const [seeds] = await c.query<any[]>('SELECT (SELECT COUNT(*) FROM categories) AS categories, (SELECT COUNT(*) FROM settings) AS settings, (SELECT COUNT(*) FROM customers) AS customers');
  return { cols, trig, mig, seeds };
};

describe('PT-H1 harness smoke', () => {
  describe('lane harness: two lanes at once, migrated as the ten-box user, removed', () => {
    beforeAll(async () => {
      await laneDown('a', SANDBOX); // leftovers of an earlier crashed run, our own names only
      await laneDown('b', SANDBOX);
    }, 60_000);
    afterAll(async () => {
      await laneDown('a', SANDBOX);
      await laneDown('b', SANDBOX);
    }, 60_000);

    it('lane a and lane b start together on two different ports, each its own container, with no Docker volume', async () => {
      const [a, b] = await Promise.all([laneUp('a', SANDBOX), laneUp('b', SANDBOX)]);
      expect([a.name, b.name]).toEqual(['jv-mariadb-h1t-a', 'jv-mariadb-h1t-b']);
      expect([a.port, b.port]).toEqual([33351, 33352]);
      expect(await canConnect(33351)).toBe(true);
      expect(await canConnect(33352)).toBe(true);
      const ra = await asRoot('a');
      const rb = await asRoot('b');
      const [[ha]] = await ra.query<any[]>('SELECT @@hostname AS h');
      const [[hb]] = await rb.query<any[]>('SELECT @@hostname AS h');
      expect(ha.h).not.toBe(hb.h); // two servers, not one
      await ra.end();
      await rb.end();
      for (const name of [a.name, b.name]) {
        const mounts = JSON.parse(docker('inspect', '-f', '{{json .Mounts}}', name)) as { Type: string }[];
        expect(mounts.filter((m) => m.Type === 'volume')).toEqual([]); // the data lives in tmpfs
        expect(JSON.parse(docker('inspect', '-f', '{{json .HostConfig.Tmpfs}}', name))).toHaveProperty('/var/lib/mysql');
      }
    }, 120_000);

    it('the lane database is migrated as the ten-box user and a second and third run change nothing', async () => {
      const u = await asLaneUser('a');
      const before = await snapshot(u);
      expect(before.mig.length).toBeGreaterThanOrEqual(10);
      const second = await migrate(u, { seeds: true, optional: true });
      const third = await migrate(u, { seeds: true, optional: true });
      expect(second.applied).toEqual([]);
      expect(third.applied).toEqual([]);
      expect(second.skipped.length).toBe(before.mig.length);
      expect(await snapshot(u)).toEqual(before); // schema, triggers, schema_migrations (applied_at included) and seed row counts are identical
      expect((await auditTriggersInstalled(u)).length).toBe(26); // the audit triggers of db/optional are in: the lane is production-like
      await u.end();
    }, 120_000);

    it('that user holds exactly the ten ticked boxes of A3 on its own database and nothing else', async () => {
      const u = await asLaneUser('a');
      const [grants] = await u.query<any[]>('SHOW GRANTS FOR CURRENT_USER()');
      const lines = grants.map((g) => String(Object.values(g)[0]));
      const on = lines.filter((l) => !/^GRANT USAGE ON \*\.\*/.test(l));
      expect(on.length).toBe(1);
      const m = /^GRANT (.+) ON `jv_lane`\.\* TO /.exec(on[0])!;
      expect(m, on[0]).not.toBeNull();
      expect(m[1].split(',').map((s) => s.trim()).sort()).toEqual([...TEN_BOXES].sort());
      expect(TEN_BOXES).toHaveLength(10);
      for (const sql of ['DROP TABLE IF EXISTS customers', 'DELETE FROM sys_error_log', 'TRUNCATE TABLE sys_error_log', 'CREATE VIEW v_try AS SELECT 1 AS x', 'CREATE DATABASE jv_not_allowed', 'CREATE USER x_try IDENTIFIED BY \'y\'']) {
        const e = await u.query(sql).then(() => null, (err: any) => err);
        expect(e?.errno, sql).toBeGreaterThan(1000); // 1142 / 1044 / 1227: refused
      }
      await u.end();
    }, 60_000);

    it('the server carries Hostinger\'s non-strict sql_mode, so the strict mode of a connection is what the tests prove', async () => {
      const root = await asRoot('a');
      const [[g]] = await root.query<any[]>('SELECT @@global.sql_mode AS m, @@global.transaction_isolation AS iso, @@global.event_scheduler AS ev');
      expect(String(g.m).split(',').sort()).toEqual(['NO_AUTO_CREATE_USER', 'NO_ENGINE_SUBSTITUTION']);
      expect(g.iso).toBe('READ-COMMITTED');
      expect(String(g.ev).toUpperCase()).not.toBe('ON');
      await root.end();
      const u = await asLaneUser('a');
      await u.query('CREATE TABLE IF NOT EXISTS pt_h1_probe (n INT NOT NULL, s VARCHAR(3) NOT NULL)');
      await u.query("INSERT INTO pt_h1_probe VALUES ('abc', 'toolong')"); // an unprepared session: the server's own mode, no error
      const [[row]] = await u.query<any[]>('SELECT n, s FROM pt_h1_probe');
      expect(row).toEqual({ n: 0, s: 'too' });
      await u.query("SET SESSION sql_mode = 'STRICT_TRANS_TABLES,ERROR_FOR_DIVISION_BY_ZERO,NO_AUTO_CREATE_USER,NO_ENGINE_SUBSTITUTION'");
      const e = await u.query("INSERT INTO pt_h1_probe VALUES ('abc', 'x')").then(() => null, (err: any) => err);
      expect(e?.errno).toBe(1366); // and with the per-connection strict mode the same input is refused
      await u.query('SET SESSION sql_mode = DEFAULT');
      await u.end();
    }, 60_000);

    it('down removes only its own two containers: every other container is still there', async () => {
      const others = containers().filter((l) => !/ jv-mariadb-h1t-[ab]$/.test(l));
      expect(containers().filter((l) => / jv-mariadb-h1t-[ab]$/.test(l))).toHaveLength(2);
      await Promise.all([laneDown('a', SANDBOX), laneDown('b', SANDBOX)]);
      const after = containers();
      expect(after.filter((l) => / jv-mariadb-h1t-/.test(l))).toEqual([]);
      for (const l of others) expect(after, l).toContain(l); // same ids, same names
      expect(await canConnect(33351)).toBe(false);
      expect(await canConnect(33352)).toBe(false);
      expect(await laneInfo('a', SANDBOX)).toBeNull();
    }, 60_000);

    it('a lane name outside main, a, b, c is refused before Docker is asked anything', async () => {
      await expect(laneUp('spike' as never, SANDBOX)).rejects.toThrow(/lane/i);
      await expect(laneDown('keep-tourstack-and-unknown-volumes' as never, SANDBOX)).rejects.toThrow(/lane/i);
    });
  });

  describe('the injected clock never repeats an instant (S5)', () => {
    it('a thousand readings inside one microsecond are strictly increasing, also from a clock fixed at one instant', () => {
      const fixed = createClock(() => 1_800_000_000_000_000n);
      const seen: bigint[] = [];
      for (let i = 0; i < 1000; i++) seen.push(fixed.read().micros);
      for (let i = 1; i < seen.length; i++) expect(seen[i] > seen[i - 1], `reading ${i}`).toBe(true);
      expect(new Set(seen).size).toBe(1000);
      const real = createClock();
      const t: string[] = [];
      for (let i = 0; i < 1000; i++) t.push(real.read().timestamp);
      for (let i = 1; i < t.length; i++) expect(t[i] > t[i - 1], `real reading ${i}`).toBe(true);
    });
  });

  describe('the server refuses to start when a credential is missing (U10, S1)', () => {
    let dist: string;
    beforeAll(() => {
      dist = buildDist();
    }, 120_000);
    const env = (port: number, drop: string[] = []) => {
      const e: Record<string, string> = { DB_HOST: '127.0.0.1', DB_PORT: '3306', DB_NAME: 'jv_test', DB_USER: 'jv_test', DB_PASSWORD: secret('db'), PORT: String(port) };
      for (const k of drop) delete e[k];
      return e;
    };

    it('exits with code 1 and listens on no port when DB_PASSWORD is unset; the message names the variable and holds no value', async () => {
      const port = await freePort();
      const e = env(port, ['DB_PASSWORD']);
      const r = spawnSync(process.execPath, [join(dist, 'server.js')], { env: e, encoding: 'utf8', timeout: 30_000 });
      expect(r.status).toBe(1);
      expect(r.stderr + r.stdout).toContain('DB_PASSWORD');
      for (const v of [e.DB_USER, e.DB_NAME]) expect(r.stderr + r.stdout).not.toContain(v); // names of variables, never their values
      expect(await canConnect(port)).toBe(false);
    }, 60_000);

    it('control: the same environment with DB_PASSWORD set starts, listens on PORT and answers /healthz over HTTP', async () => {
      const port = await freePort();
      const child: ChildProcess = spawn(process.execPath, [join(dist, 'server.js')], { env: env(port), stdio: 'ignore' });
      try {
        let up = false;
        for (let i = 0; i < 100 && !up; i++) {
          up = await canConnect(port);
          if (!up) await new Promise((r) => setTimeout(r, 100));
        }
        expect(up).toBe(true);
        const res = await fetch(`http://127.0.0.1:${port}/healthz`);
        expect(res.status).toBe(200);
        expect(await res.text()).toBe('{"ok":true}');
      } finally {
        child.kill('SIGTERM');
      }
    }, 60_000);

    it('the build writes the entry dist/server.js', () => {
      expect(existsSync(join(dist, 'server.js'))).toBe(true);
      expect(existsSync(join(dist, 'app.js'))).toBe(true);
    });
  });

  describe('GET /healthz through inject()', () => {
    it('answers {"ok":true}; anything else on that path is a 404', async () => {
      const sink = logSink();
      const app = buildApp({ config: testConfig(), logStream: sink.stream });
      const res = await app.inject({ method: 'GET', url: '/healthz' });
      expect(res.statusCode).toBe(200);
      expect(res.body).toBe('{"ok":true}');
      expect(res.headers['content-type']).toMatch(/^application\/json/);
      expect((await app.inject({ method: 'POST', url: '/healthz' })).statusCode).toBe(404);
      expect((await app.inject({ method: 'GET', url: '/nothing-here' })).statusCode).toBe(404);
      await app.close();
    });
  });
});
