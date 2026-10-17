import { type ChildProcess, spawn } from 'node:child_process';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app';
import { type DbPool, createDbPool } from '../../src/db/pool';
import { REQUIRED_TABLES } from '../../src/db/tables';
import { TEN_BOXES, parseGrants, runPreflight } from '../../src/preflight';
import { readHealth } from '../../scripts/health.mjs';
import { TEN_BOXES as HARNESS_TEN_BOXES } from '../../scripts/lane.mjs';
import { listMigrations, splitStatements } from '../../scripts/migrate.mjs';
import { type Scratch, laneDbSettings, laneRoot, scratchDatabase } from '../helpers';
import { buildDist, canConnect, freePort, logSink, testConfig } from './support';

// T-F08, the start-up half (S11): the check that runs before the API accepts a request. Failure keeps the API up and answers 503 JV_UNAVAILABLE to everything but /healthz;
// the reason goes to the log only. A Delete or Drop right that is on is reported (the dashboard line turns amber, I12), not fatal.

let scratch: Scratch;
const pools: DbPool[] = [];
const apps: FastifyInstance[] = [];
const poolOn = (db: Parameters<typeof createDbPool>[0]) => {
  const p = createDbPool(db);
  pools.push(p);
  return p;
};
async function start(pool: DbPool) {
  const sink = logSink();
  const app = buildApp({ config: testConfig(), db: pool, logStream: sink.stream });
  apps.push(app);
  await app.ready();
  return { app, sink };
}
const logText = (sink: ReturnType<typeof logSink>) => sink.text();
const body = (res: { body: string }) => JSON.parse(res.body) as { error: { code: string; message: string; details: unknown }; request_id: string };

beforeEach(async () => {
  scratch = await scratchDatabase('f08s', { schema: true });
}, 120_000);
afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close().catch(() => undefined)));
  await Promise.all(pools.splice(0).map((p) => p.end().catch(() => undefined)));
  await scratch?.drop();
}, 60_000);

/** The pool, but the server says it is another version (the version query's answer is rewritten; everything else is real). */
function pretendVersion(pool: DbPool, version: string, comment?: string): DbPool {
  return new Proxy(pool, {
    get(target, prop) {
      if (prop === 'checkout') {
        return async () => {
          const conn = await target.checkout();
          const query = conn.query.bind(conn) as (...a: unknown[]) => Promise<[any, unknown]>;
          (conn as any).query = async (...args: unknown[]) => {
            const out = await query(...args);
            if (Array.isArray(out[0]) && out[0][0] && 'version' in out[0][0]) out[0][0] = { ...out[0][0], version, version_comment: comment ?? out[0][0].version_comment };
            return out;
          };
          return conn;
        };
      }
      const v = (target as any)[prop];
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}

describe('T-F08 the tables the code needs are named in the code, and they are the catalogue', () => {
  it('REQUIRED_TABLES is what db/migrations creates, less the runner\'s own schema_migrations', () => {
    const created = new Set<string>();
    for (const m of listMigrations()) for (const st of splitStatements(m.sql)) {
      const hit = /^CREATE TABLE IF NOT EXISTS `?([a-z0-9_]+)`?/i.exec(st);
      if (hit) created.add(hit[1]);
    }
    expect([...REQUIRED_TABLES].sort()).toEqual([...created].sort());
    expect(new Set(REQUIRED_TABLES).size).toBe(REQUIRED_TABLES.length);
  });

  it('and they are what a migrated lane database really holds: 25 tables besides schema_migrations', async () => {
    const root = await laneRoot();
    const [rows] = await root.query<any[]>("SELECT TABLE_NAME AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'", [laneDbSettings().name]);
    await root.end();
    expect(rows.map((r) => r.n as string).filter((n) => n !== 'schema_migrations').sort()).toEqual([...REQUIRED_TABLES].sort());
    expect(REQUIRED_TABLES).toHaveLength(25);
  });
});

describe('T-F08 start-up check: a healthy database', () => {
  it('the ten boxes of A3 in src are the harness\'s: the user of the lane tests holds exactly these', () => {
    expect([...TEN_BOXES].sort()).toEqual([...HARNESS_TEN_BOXES].sort());
    expect(TEN_BOXES).toHaveLength(10);
  });

  it('the lane database passes: MariaDB 11, READ-COMMITTED, the seven settings, utf8mb4, every table, ten boxes only (green)', async () => {
    const pool = poolOn(laneDbSettings());
    const r = await runPreflight(pool);
    expect(r).toMatchObject({ ok: true, problems: [], amber: false, outsideTenBoxes: [], rights: { delete: false, drop: false, extra: [] } });
    expect(r.version).toMatch(/^11\.\d+\.\d+.*MariaDB/i);
  });

  it('and through the app: the first request is served (an unknown path is a 404, not a 503), /healthz answers, and the log says it passed', async () => {
    const { app, sink } = await start(poolOn(laneDbSettings()));
    expect(app.startup?.ok).toBe(true);
    expect((await app.inject({ method: 'GET', url: '/healthz' })).body).toBe('{"ok":true}');
    expect((await app.inject({ method: 'GET', url: '/nothing-here' })).statusCode).toBe(404);
    expect(sink.lines().some((l) => /start-up check passed/.test(l.msg) && l.level === 30)).toBe(true);
  });

  it('the check gives its connection back: the first real request finds one idle', async () => {
    const pool = poolOn(laneDbSettings());
    await runPreflight(pool);
    expect(pool.stats()).toMatchObject({ inUse: 0, waiting: 0, opened: 1 });
  });
});

describe('T-F08 start-up check: what stops the API answers 503 JV_UNAVAILABLE to everything but /healthz, and the reason goes to the log only', () => {
  const expectClosed = async (app: FastifyInstance, sink: ReturnType<typeof logSink>, secrets: RegExp) => {
    for (const [method, url] of [['GET', '/anything'], ['POST', '/anything'], ['GET', '/healthz/'], ['OPTIONS', '/anything'], ['GET', '/']] as const) {
      const res = await app.inject({ method, url, payload: method === 'POST' ? { a: 1 } : undefined });
      expect(res.statusCode, `${method} ${url}`).toBe(503);
      const b = body(res);
      expect(b.error.code).toBe('JV_UNAVAILABLE');
      expect(typeof b.error.message).toBe('string');
      expect(typeof b.request_id).toBe('string');
      expect(res.body, `${method} ${url}`).not.toMatch(secrets); // the reason is not for the client
    }
    const health = await app.inject({ method: 'GET', url: '/healthz' });
    expect([health.statusCode, health.body]).toEqual([200, '{"ok":true}']);
    expect((await app.inject({ method: 'HEAD', url: '/healthz' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/healthz?x=1' })).statusCode).toBe(200);
    expect(app.startup?.ok).toBe(false);
    const errors = sink.lines().filter((l) => l.level === 50 && /start-up check failed/.test(l.msg));
    expect(errors).toHaveLength(1);
    expect(JSON.stringify(errors[0])).toMatch(secrets); // ...it is in the log
  };

  it('the isolation level is changed on the server (REPEATABLE-READ): 503, although every checkout sets READ-COMMITTED for itself', async () => {
    const root = await laneRoot();
    try {
      await root.query("SET GLOBAL transaction_isolation = 'REPEATABLE-READ'");
      const { app, sink } = await start(poolOn(laneDbSettings()));
      await expectClosed(app, sink, /isolation|REPEATABLE/i);
      expect(app.startup?.problems.map((p) => p.check)).toEqual(['isolation']);
    } finally {
      await root.query("SET GLOBAL transaction_isolation = 'READ-COMMITTED'");
      await root.end();
    }
    const again = await runPreflight(poolOn(laneDbSettings())); // control: put back, the same database passes
    expect(again.ok).toBe(true);
  });

  it('a table is dropped in a scratch schema: 503, and the log names the table, the client does not see it', async () => {
    const root = await scratch.root();
    await root.query(`DROP TABLE \`${scratch.database}\`.sys_photo_copies`);
    await root.end();
    const { app, sink } = await start(poolOn(scratch.db));
    await expectClosed(app, sink, /sys_photo_copies/);
    expect(app.startup?.problems).toEqual([{ check: 'tables', detail: expect.stringContaining('sys_photo_copies') }]);
  });

  it('several tables missing are all named, once', async () => {
    const root = await scratch.root();
    for (const t of ['sys_photo_copies', 'sys_job_runs', 'sys_error_log']) await root.query(`DROP TABLE \`${scratch.database}\`.${t}`);
    await root.end();
    const r = await runPreflight(poolOn(scratch.db));
    expect(r.ok).toBe(false);
    expect(r.problems).toHaveLength(1);
    for (const t of ['sys_photo_copies', 'sys_job_runs', 'sys_error_log']) expect(r.problems[0].detail).toContain(t);
  });

  it('the server is not MariaDB 11 (simulated): 10.11, MySQL 8, MySQL called 11, and an empty answer all stop it; 11.8 passes', async () => {
    for (const [version, comment] of [['10.11.9-MariaDB', 'mariadb.org binary distribution'], ['8.0.36', 'MySQL Community Server - GPL'], ['11.0.0', 'MySQL Community Server - GPL'], ['12.0.1-MariaDB', 'mariadb.org binary distribution']] as const) {
      const pool = poolOn(scratch.db);
      const { app, sink } = await start(pretendVersion(pool, version, comment));
      await expectClosed(app, sink, new RegExp(version.replace(/\./g, '\\.')));
      expect(app.startup?.problems.map((p) => p.check)).toEqual(['version']);
      await app.close();
    }
    const ok = await runPreflight(pretendVersion(poolOn(scratch.db), '11.8.9-MariaDB-log', 'mariadb.org binary distribution'));
    expect(ok.ok).toBe(true);
  });

  it('the database cannot be reached at all: the API still starts, answers /healthz, and 503 to the rest', async () => {
    const port = await freePort();
    const { app, sink } = await start(poolOn({ ...scratch.db, port }));
    await expectClosed(app, sink, /ECONNREFUSED/);
    expect(app.startup?.problems.map((p) => p.check)).toEqual(['connect']);
  });

  it('the user is wrong (access denied): the same, and no password reaches the log', async () => {
    const { app, sink } = await start(poolOn({ ...scratch.db, password: 'not-the-password-' + scratch.db.password.slice(0, 4) }));
    expect(app.startup?.ok).toBe(false);
    expect((await app.inject({ method: 'GET', url: '/anything' })).statusCode).toBe(503);
    expect(logText(sink)).not.toContain(scratch.db.password);
  });

  it('a character set that is not utf8mb4 on a table stops it too', async () => {
    const root = await scratch.root();
    await root.query(`ALTER TABLE \`${scratch.database}\`.sys_counters CONVERT TO CHARACTER SET latin1`);
    await root.end();
    const r = await runPreflight(poolOn(scratch.db));
    expect(r.ok).toBe(false);
    expect(r.problems.map((p) => p.check)).toEqual(['charset']);
    expect(r.problems[0].detail).toContain('sys_counters');
  });

  it('an app built without a database has no gate and no check (the tests of the other tasks build it that way)', async () => {
    const plain = buildApp({ config: testConfig(), logStream: logSink().stream });
    expect((await plain.inject({ method: 'GET', url: '/nothing-here' })).statusCode).toBe(404);
    expect(plain.startup).toBeNull();
    await plain.close();
  });

  it('closing the app ends the pool', async () => {
    const pool = poolOn(laneDbSettings());
    const { app } = await start(pool);
    await app.close();
    await expect(pool.checkout()).rejects.toMatchObject({ code: 'JV_BUSY', reason: 'closing' });
  });
});

describe('T-F08 start-up check: the user\'s rights are read with SHOW GRANTS and reported', () => {
  const grant = async (rights: string) => {
    const root = await scratch.root();
    await root.query(`GRANT ${rights} ON \`${scratch.database}\`.* TO ?@'%'`, [scratch.user]);
    await root.end();
  };

  it('a Delete right that is on is reported amber, not fatal: the API serves, the log warns, and the dashboard (readHealth) lists it as a reason too', async () => {
    const asked = async () => {
      const u = await scratch.connect();
      try {
        return await readHealth(u, { analyze: false, sizeBytes: 0 });
      } finally {
        await u.end();
      }
    };
    expect((await asked()).reasons).not.toContain('delete_or_drop_right'); // control: before the grant the dashboard says nothing about rights
    await grant('DELETE');
    const { app, sink } = await start(poolOn(scratch.db));
    expect(app.startup).toMatchObject({ ok: true, problems: [], amber: true, outsideTenBoxes: ['DELETE'], rights: { delete: true, drop: false, extra: [] } });
    expect((await app.inject({ method: 'GET', url: '/nothing-here' })).statusCode).toBe(404); // served, not 503
    const warn = sink.lines().filter((l) => l.level === 40 && /Delete or Drop/.test(l.msg));
    expect(warn).toHaveLength(1);
    const health = await asked();
    expect(health.reasons).toContain('delete_or_drop_right'); // a fresh database has had no check and no backup, so its level is red for those reasons; the right is a reason of its own
    expect(health.rights).toMatchObject({ delete: true, drop: false });
  });

  it('a Drop right is the same', async () => {
    await grant('DROP');
    const r = await runPreflight(poolOn(scratch.db));
    expect(r).toMatchObject({ ok: true, amber: true, rights: { delete: false, drop: true } });
  });

  it('ALL PRIVILEGES is amber and lists every box outside the ten', async () => {
    await grant('ALL PRIVILEGES');
    const r = await runPreflight(poolOn(scratch.db));
    expect(r.ok).toBe(true);
    expect(r.amber).toBe(true);
    expect(r.outsideTenBoxes).toEqual(expect.arrayContaining(['ALTER ROUTINE', 'CREATE ROUTINE', 'CREATE VIEW', 'DELETE', 'DROP', 'EVENT', 'EXECUTE', 'SHOW VIEW']));
  });

  it('a right outside the ten boxes that is not Delete or Drop (Event, Execute) is noted in the log and does not turn it amber', async () => {
    await grant('EVENT, EXECUTE');
    const { app, sink } = await start(poolOn(scratch.db));
    expect(app.startup).toMatchObject({ ok: true, amber: false, rights: { delete: false, drop: false, extra: ['EVENT', 'EXECUTE'] }, outsideTenBoxes: ['EVENT', 'EXECUTE'] });
    const notes = sink.lines().filter((l) => /outside the ten boxes/.test(l.msg));
    expect(notes).toHaveLength(1);
    expect(JSON.stringify(notes[0])).toContain('EVENT');
    expect(JSON.stringify(notes[0])).toContain('EXECUTE');
  });

  it('control: the ten boxes of A3 and nothing else says nothing and is green', async () => {
    const { app, sink } = await start(poolOn(scratch.db));
    expect(app.startup).toMatchObject({ ok: true, amber: false, outsideTenBoxes: [] });
    expect(sink.lines().filter((l) => /outside the ten boxes|Delete or Drop/.test(l.msg))).toEqual([]);
  });

  it('the log never carries a grant line, so a password hash in IDENTIFIED BY stays out of it', async () => {
    await grant('DELETE');
    const { sink } = await start(poolOn(scratch.db));
    expect(logText(sink)).not.toMatch(/IDENTIFIED BY|PASSWORD '/i);
  });

  it('the parser agrees with the dashboard\'s own reader on delete, drop and the other boxes, for grants of every kind', async () => {
    const cases: string[][] = [[], ['DELETE'], ['DROP'], ['DELETE', 'DROP'], ['EVENT', 'EXECUTE', 'CREATE VIEW'], ['ALL PRIVILEGES']];
    const root = await scratch.root();
    const u = await scratch.connect();
    try {
      for (const rights of cases) {
        await root.query(`REVOKE ALL PRIVILEGES, GRANT OPTION FROM ?@'%'`, [scratch.user]);
        await root.query(`GRANT SELECT, INSERT, UPDATE, CREATE, ALTER, INDEX, REFERENCES, TRIGGER, CREATE TEMPORARY TABLES, LOCK TABLES ON \`${scratch.database}\`.* TO ?@'%'`, [scratch.user]);
        if (rights.length) await root.query(`GRANT ${rights.join(', ')} ON \`${scratch.database}\`.* TO ?@'%'`, [scratch.user]);
        const [grants] = await u.query<any[]>('SHOW GRANTS FOR CURRENT_USER()');
        const mine = parseGrants(grants.map((g) => String(Object.values(g)[0])), scratch.database);
        const theirs = (await readHealth(u, { analyze: false, sizeBytes: 0 })).rights;
        expect([mine.delete, mine.drop], rights.join()).toEqual([theirs.delete, theirs.drop]);
        expect(mine.extra, rights.join()).toEqual(theirs.extra.filter((b: string) => b !== 'DELETE' && b !== 'DROP'));
      }
    } finally {
      await u.end();
      await root.end();
    }
  });

  it('parseGrants on lines of every shape: other databases do not count, a name pattern does, a grant option and a global right are noted, column lists do not break it', () => {
    const lines = (...l: string[]) => l;
    const db = 'u123_shop';
    expect(parseGrants(lines("GRANT USAGE ON *.* TO `u`@`%` IDENTIFIED BY PASSWORD '*ABC'", 'GRANT SELECT, INSERT ON `u123_shop`.* TO `u`@`%`'), db)).toMatchObject({ delete: false, drop: false, extra: [], held: ['INSERT', 'SELECT'] });
    expect(parseGrants(lines('GRANT DELETE, DROP ON `other`.* TO `u`@`%`'), db)).toMatchObject({ delete: false, drop: false, extra: [] });
    expect(parseGrants(lines('GRANT DELETE ON `u123\\_shop`.* TO `u`@`%`'), db).delete).toBe(true); // an escaped underscore is the plain character
    expect(parseGrants(lines('GRANT DELETE ON `u123_%`.* TO `u`@`%`'), db).delete).toBe(true); // a pattern covering this database
    expect(parseGrants(lines('GRANT DROP ON *.* TO `u`@`%`'), db).drop).toBe(true); // a global right covers it
    expect(parseGrants(lines('GRANT SELECT (a, b), UPDATE (c) ON `u123_shop`.`t` TO `u`@`%`'), db).held).toEqual(['SELECT', 'UPDATE']);
    expect(parseGrants(lines('GRANT SELECT ON `u123_shop`.* TO `u`@`%` WITH GRANT OPTION'), db)).toMatchObject({ grantOption: true, extra: ['GRANT OPTION'] });
    expect(parseGrants(lines('GRANT PROCESS, SUPER ON *.* TO `u`@`%`'), db).extra).toEqual(['PROCESS', 'SUPER']);
    expect(parseGrants(lines('GRANT `somerole` TO `u`@`%`'), db)).toMatchObject({ delete: false, drop: false, extra: [] });
    expect(parseGrants([], db)).toMatchObject({ delete: false, drop: false, extra: [], held: [] });
  });
});

describe('T-F08 the entry point (dist/server.js) runs the start-up check before it listens', () => {
  let dist: string;
  const children: ChildProcess[] = [];
  beforeAll(() => {
    dist = buildDist();
  }, 120_000);
  afterEach(() => {
    for (const c of children.splice(0)) c.kill('SIGTERM');
  });

  async function run(db: Scratch['db']) {
    const port = await freePort();
    const out: string[] = [];
    const child = spawn(process.execPath, [join(dist, 'server.js')], {
      env: { PATH: process.env.PATH ?? '', DB_HOST: db.host, DB_PORT: String(db.port), DB_NAME: db.name, DB_USER: db.user, DB_PASSWORD: db.password, PORT: String(port), LOG_LEVEL: 'info' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(child);
    child.stdout?.on('data', (d) => out.push(String(d)));
    child.stderr?.on('data', (d) => out.push(String(d)));
    let up = false;
    for (let i = 0; i < 150 && !up; i++) {
      up = await canConnect(port);
      if (!up) await new Promise((r) => setTimeout(r, 100));
    }
    expect(up, out.join('')).toBe(true);
    return { base: `http://127.0.0.1:${port}`, log: () => out.join('') };
  }

  it('a database with a table missing: the process is up, /healthz answers, everything else is 503 JV_UNAVAILABLE from the very first request; the log has the table, the answer does not', async () => {
    const root = await scratch.root();
    await root.query(`DROP TABLE \`${scratch.database}\`.sys_photo_copies`);
    await root.end();
    const s = await run(scratch.db);
    const first = await fetch(`${s.base}/anything`);
    expect(first.status).toBe(503);
    const text = await first.text();
    expect(JSON.parse(text).error.code).toBe('JV_UNAVAILABLE');
    expect(text).not.toContain('sys_photo_copies');
    const health = await fetch(`${s.base}/healthz`);
    expect([health.status, await health.text()]).toEqual([200, '{"ok":true}']);
    expect(s.log()).toContain('sys_photo_copies');
    expect(s.log()).not.toContain(scratch.db.password);
  }, 60_000);

  it('control: the complete database is served: an unknown path is a 404, and the log says the check passed', async () => {
    const s = await run(scratch.db);
    expect((await fetch(`${s.base}/anything`)).status).toBe(404);
    expect(await (await fetch(`${s.base}/healthz`)).text()).toBe('{"ok":true}');
    expect(s.log()).toMatch(/start-up check passed/);
  }, 60_000);
});
