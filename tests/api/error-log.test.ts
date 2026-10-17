import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Connection } from 'mysql2/promise';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app';
import { createClock } from '../../src/clock';
import { ERROR_LOG_PER_MINUTE, INSERT_SQL, SUPPRESS_SQL, logError as twinLogError } from '../../src/db/errorLog';
import { type DbPool, createDbPool } from '../../src/db/pool';
import { BusyError, JvError, classifyError } from '../../src/errors';
import { route } from '../../src/permissions/route';
import { createErrorLog, errorLogEntry } from '../../src/security/errorLog';
import { ERROR_LOG_PER_MINUTE as SCRIPT_CAP, logError as scriptLogError } from '../../scripts/housekeeping.mjs';
import { type Scratch, scratchDatabase } from '../helpers';
import { REPO, csrfHeaders, logSink, secret, testConfig, toyRoutes } from './support';
import { dbError } from './tx-support';
import { SESSION_COOKIE } from '../../src/permissions/session';
import { type World, makeWorld } from './cells';

// T-D28 / D25 (API07): sys_error_log keeps the unexpected errors, with no customer data, at most 20 rows a minute for each code, the rest counted inside the last row of the code and minute.
// The database half's function (scripts/housekeeping.mjs logError, MB05) is what the cap is; src cannot import it, so src/db/errorLog.ts is its twin and this file keeps the two identical.

const NOW = new Date('2026-10-16T08:30:15.250Z');
const parse = (v: unknown) => (typeof v === 'string' ? JSON.parse(v) : v) as Record<string, any> | null;

let scratch: Scratch;
let sql: Connection;
beforeAll(async () => {
  scratch = await scratchDatabase('errlog', { schema: true });
  sql = await scratch.connect();
}, 120_000);
afterAll(async () => {
  await sql?.end();
  await scratch?.drop();
});
const rows = async (where = '1=1', params: unknown[] = []) => ((await sql.query<any[]>(`SELECT id, at, minute_at, seq, level, code, message, request_id, user_id, detail FROM sys_error_log WHERE ${where} ORDER BY code, seq, id`, params))[0] as any[]);
const count = async (code: string) => Number((((await sql.query<any[]>('SELECT COUNT(*) AS n FROM sys_error_log WHERE code = ?', [code]))[0]) as any[])[0].n);

// ------------------------------------------------------------------ the twin

describe('T-D28 (D25) the twin of MB05\'s logError: the same two statements and the same rows for the same calls', () => {
  const normalise = (text: string) => text.replace(/\s+/g, ' ').trim();

  it('the two statements are the script\'s, character for character (whitespace aside)', () => {
    const script = normalise(readFileSync(join(REPO, 'scripts', 'housekeeping.mjs'), 'utf8').replace(/\$\{ERROR_LOG_PER_MINUTE\}/g, String(SCRIPT_CAP)));
    expect(script).toContain(normalise(INSERT_SQL));
    expect(script).toContain(normalise(SUPPRESS_SQL));
    expect(ERROR_LOG_PER_MINUTE).toBe(SCRIPT_CAP);
    expect(ERROR_LOG_PER_MINUTE).toBe(20);
  });

  it('the same calls leave the same rows (code, minute, place, level, message, ids, detail), also past the cap, for several codes, minutes and cut messages', async () => {
    const run = async (code: string, log: typeof twinLogError | typeof scriptLogError) => {
      const rid = '6c1f1e0e-0f3b-4b4e-9a53-2f5f2d9c7a10';
      for (let i = 0; i < 45; i++) await log(sql as never, { level: 'error', code, message: `same bug ${i % 3}`, detail: { route: '/v1/sync/poll', n: i % 2 } }, { now: NOW });
      await log(sql as never, { level: 'warn', code: `${code}_B`, message: 'm'.repeat(900), request_id: rid, user_id: rid, detail: { a: 1 } }, { now: new Date(NOW.getTime() + 60_000) });
      await log(sql as never, { level: 'fatal', code: `${code}_C`, message: 'no detail' }, { now: NOW });
      for (let i = 0; i < 22; i++) await log(sql as never, { level: 'info', code: `${code}_D`, message: 'd', detail: null }, { now: new Date(NOW.getTime() + 120_000) });
    };
    await run('PAR_SCRIPT', scriptLogError as never);
    await run('PAR_TWIN', twinLogError);
    const norm = async (prefix: string) => (await rows('code LIKE ?', [`${prefix}%`])).map((r) => ({ ...r, id: undefined, code: String(r.code).replace(prefix, 'PAR'), detail: parse(r.detail) }));
    const a = await norm('PAR_SCRIPT');
    const b = await norm('PAR_TWIN');
    expect(a.length).toBeGreaterThan(40);
    expect(b).toEqual(a);
    expect(a.filter((r) => r.code === 'PAR').map((r) => r.seq)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    expect(a.find((r) => r.code === 'PAR' && r.seq === 20)!.detail).toMatchObject({ suppressed: 25 });
  });

  it('NEGATIVE CONTROL: the comparison can tell: a twin that writes another detail leaves other rows', async () => {
    const run = async (code: string, log: typeof twinLogError | typeof scriptLogError, detail: Record<string, unknown>) => {
      for (let i = 0; i < 3; i++) await log(sql as never, { level: 'error', code, message: 'same', detail }, { now: NOW });
    };
    await run('CTRL_SCRIPT', scriptLogError as never, { route: '/a' });
    await run('CTRL_TWIN', twinLogError, { route: '/b' });
    const norm = async (prefix: string) => (await rows('code LIKE ?', [`${prefix}%`])).map((r) => ({ ...r, id: undefined, code: 'CTRL', detail: parse(r.detail) }));
    expect(await norm('CTRL_TWIN')).not.toEqual(await norm('CTRL_SCRIPT'));
  });

  it('1,000 identical errors in a minute write 20 rows, the rest are counted inside the last one; eight connections racing lose none', async () => {
    for (let i = 0; i < 1000; i++) await twinLogError(sql, { level: 'error', code: 'JV_INTERNAL_X', message: 'same bug' }, { now: NOW });
    expect(await count('JV_INTERNAL_X')).toBe(20);
    expect(parse((await rows("code = 'JV_INTERNAL_X' AND seq = 20"))[0].detail)).toMatchObject({ suppressed: 980 });
    const racers = await Promise.all(Array.from({ length: 8 }, () => scratch.connect()));
    const when = new Date('2026-10-16T09:00:05.000Z');
    await Promise.all(racers.map(async (c) => { for (let i = 0; i < 50; i++) await twinLogError(c, { level: 'error', code: 'RACE_TWIN', message: 'x' }, { now: when }); }));
    await Promise.all(racers.map((c) => c.end()));
    const all = await rows("code = 'RACE_TWIN'");
    expect(all).toHaveLength(20);
    expect(20 + Number(parse(all[19].detail)!.suppressed)).toBe(400);
  });
});

// ------------------------------------------------------------------ what is handed over and how it is written

describe('T-D28 the application\'s queue: entries are written one pass at a time on one connection, the rest of a flood is only counted', () => {
  /** A pool over the scratch database that counts the connections held at once. */
  function countingPool() {
    const real = createDbPool(scratch.db);
    const stats = { checkouts: 0, held: 0, maxHeld: 0 };
    const pool = new Proxy(real, {
      get(target, prop) {
        if (prop === 'checkout') {
          return async () => {
            const conn = await target.checkout();
            stats.checkouts++;
            stats.held++;
            stats.maxHeld = Math.max(stats.maxHeld, stats.held);
            let over = false;
            const done = () => (over ? undefined : ((over = true), void stats.held--));
            const release = conn.release.bind(conn);
            const destroy = conn.destroy.bind(conn);
            conn.release = () => (done(), release());
            conn.destroy = () => (done(), destroy());
            return conn;
          };
        }
        const v = (target as any)[prop];
        return typeof v === 'function' ? v.bind(target) : v;
      },
    }) as DbPool;
    return { pool, stats, end: () => real.end() };
  }
  const entry = (code: string, extra = {}) => ({ level: 'error' as const, code, message: 'same bug', ...extra });

  it('1,000 entries of one code in one minute: 20 rows, 980 counted in the last, written on one connection at a time; idle() waits for all of it', async () => {
    const { pool, stats, end } = countingPool();
    const log = createErrorLog(pool, { warn: () => undefined });
    for (let i = 0; i < 1000; i++) log.record(entry('Q_ONE'), NOW);
    await log.idle();
    expect(await count('Q_ONE')).toBe(20);
    expect(parse((await rows("code = 'Q_ONE' AND seq = 20"))[0].detail)).toMatchObject({ suppressed: 980 });
    expect(stats.maxHeld).toBe(1);
    await end();
  });

  it('the first 20 are kept as entries (their own times, messages and ids) and the rest are counted: memory stays small however long the flood lasts', async () => {
    const { pool, end } = countingPool();
    const log = createErrorLog(pool, { warn: () => undefined });
    for (let i = 0; i < 60; i++) log.record(entry('Q_TWO', { message: `no ${i}`, detail: { i } }), new Date(NOW.getTime() + i));
    await log.idle();
    const r = await rows("code = 'Q_TWO'");
    expect(r.map((x) => x.message)).toEqual(Array.from({ length: 20 }, (_, i) => `no ${i}`));
    expect(parse(r[19].detail)).toMatchObject({ i: 19, suppressed: 40 });
    await end();
  });

  it('another code has its own 20, and the next minute starts afresh', async () => {
    const { pool, end } = countingPool();
    const log = createErrorLog(pool, { warn: () => undefined });
    for (let i = 0; i < 30; i++) log.record(entry('Q_A'), NOW);
    for (let i = 0; i < 30; i++) log.record(entry('Q_B'), NOW);
    for (let i = 0; i < 30; i++) log.record(entry('Q_A'), new Date(NOW.getTime() + 60_000));
    await log.idle();
    expect(await count('Q_A')).toBe(40);
    expect(await count('Q_B')).toBe(20);
    await end();
  });

  it('no connection to be had (the pool is full or the database is down): the entries are dropped, said once in the log, and nothing throws', async () => {
    const lines: string[] = [];
    const log = createErrorLog({ checkout: async () => Promise.reject(new BusyError('queue_full', { nothingStarted: true })) }, { warn: (_o, msg) => void lines.push(msg) });
    for (let i = 0; i < 100; i++) log.record(entry('Q_DOWN'), NOW);
    await log.idle();
    expect(lines.filter((m) => /no database connection/.test(m))).toHaveLength(1);
    expect(await count('Q_DOWN')).toBe(0);
  });

  it('after a pass found no connection nothing more is tried for a while: what arrives meanwhile is counted and dropped, and the next pass says how many', async () => {
    let t = 1000;
    let tried = 0;
    const lines: { msg: string; dropped?: number }[] = [];
    const log = createErrorLog(
      {
        checkout: async () => {
          tried++;
          throw new BusyError('queue_full', { nothingStarted: true });
        },
      },
      { warn: (o, msg) => void lines.push({ msg, dropped: (o as { dropped?: number }).dropped }) },
      { now: () => t, coolDownMs: 5000 },
    );
    log.record(entry('Q_COOL'), NOW);
    await log.idle();
    for (let i = 0; i < 50; i++) log.record(entry('Q_COOL'), NOW); // inside the cool-down
    await log.idle();
    expect(tried).toBe(1);
    t += 5001;
    log.record(entry('Q_COOL'), NOW);
    await log.idle();
    expect(tried).toBe(2);
    expect(lines.map((l) => l.msg).filter((m) => /no database connection/.test(m))).toHaveLength(2);
    expect(lines.at(-1)).toMatchObject({ dropped: 51 }); // the 50 turned away plus the one that was queued
  });

  it('a statement that fails (a table gone) destroys the connection, drops what was queued and the log carries on with the next entries', async () => {
    const { pool, stats, end } = countingPool();
    const lines: string[] = [];
    const log = createErrorLog(pool, { warn: (_o, msg) => void lines.push(msg) });
    const bad = { ...entry('Q_BAD'), level: 'loud' as never }; // the table's CHECK refuses the level
    log.record(bad, NOW);
    await log.idle();
    expect(lines.some((m) => /could not be written/.test(m))).toBe(true);
    log.record(entry('Q_GOOD'), NOW);
    await log.idle();
    expect(await count('Q_GOOD')).toBe(1);
    expect(stats.held).toBe(0);
    await end();
  });

  it('with no pool nothing is queued; a record never throws', async () => {
    const log = createErrorLog(null, { warn: () => undefined });
    expect(() => log.record(entry('Q_NONE'), NOW)).not.toThrow();
    await log.idle();
    const broken = createErrorLog({ checkout: async () => Promise.reject(new Error('x')) }, {
      warn: () => {
        throw new Error('the log itself is broken');
      },
    });
    expect(() => broken.record(entry('Q_NONE'), new Date('not a date'))).not.toThrow();
    await broken.idle();
  });
});

// ------------------------------------------------------------------ which answers are recorded, and what a row says

describe('T-D28 an unexpected error writes a row with no customer data; the caller\'s own mistakes write none', () => {
  const fakeRequest = (over: Partial<FastifyRequest> = {}) => ({ id: '6c1f1e0e-0f3b-4b4e-9a53-2f5f2d9c7a10', method: 'POST', routeOptions: { url: '/v1/customers' }, auth: null, ...over }) as unknown as FastifyRequest;
  const entryOf = (e: unknown, req = fakeRequest()) => errorLogEntry(req, classifyError(e), e);

  it('records JV_INTERNAL, a bug, JV_UNAVAILABLE and the JV_BUSY of lock waits, statement limits, deadlocks, deadlines, lost commits and handler timers', () => {
    expect(entryOf(new Error('x'))).toMatchObject({ level: 'error', code: 'JV_INTERNAL', request_id: '6c1f1e0e-0f3b-4b4e-9a53-2f5f2d9c7a10', user_id: null });
    expect(entryOf(dbError(4025, 'ER_CONSTRAINT_FAILED', 'CONSTRAINT `chk_x` failed for `jv`.`bills`'))).toMatchObject({ level: 'error', code: 'JV_BUG' });
    expect(entryOf(dbError(1045, 'ER_ACCESS_DENIED_ERROR', 'Access denied'))).toMatchObject({ level: 'error', code: 'JV_UNAVAILABLE' });
    for (const [e, reason] of [[dbError(1205, 'ER_LOCK_WAIT_TIMEOUT', 'x'), 'lock_wait'], [dbError(1969, 'ER_STATEMENT_TIMEOUT', 'x'), 'statement_timeout'], [dbError(1213, 'ER_LOCK_DEADLOCK', 'x'), 'deadlock'], [Object.assign(new Error('t'), { code: 'FST_ERR_HANDLER_TIMEOUT' }), 'handler_timeout']] as const) {
      expect(entryOf(e), reason).toMatchObject({ level: 'warn', code: 'JV_BUSY', detail: { reason } });
    }
    expect(entryOf(new BusyError('commit_lost', { outcomeUnknown: true }))).toMatchObject({ code: 'JV_BUSY', detail: { reason: 'commit_lost' } });
  });

  it('records nothing for the caller\'s own mistakes (a refused input, a business rule, a session, a CSRF refusal, a large body) and nothing for the pool\'s own busy answers', () => {
    for (const code of ['JV_INVALID_INPUT', 'JV_FORBIDDEN', 'JV_NOT_FOUND', 'JV_OVERPAYMENT', 'JV_STALE', 'JV_UNAUTHENTICATED', 'JV_SESSION_EXPIRED', 'JV_BAD_LOGIN', 'JV_CSRF', 'JV_PAYLOAD_TOO_LARGE', 'JV_UNSUPPORTED_MEDIA_TYPE', 'JV_PASSWORD_CHANGE_REQUIRED'] as const) {
      expect(entryOf(new JvError(code, 'm')), code).toBeNull();
    }
    expect(entryOf(new JvError('JV_RATE_LIMITED', 'm', { retryAfter: 5 }))).toBeNull();
    for (const reason of ['queue_full', 'wait_timeout', 'connect_refused', 'connection_lost', 'closing'] as const) expect(entryOf(new BusyError(reason)), reason).toBeNull();
  });

  it('a row says the method, the route as registered (never the address with ids), the status, what threw and where, and for a database error its number and its message with the value cut out', () => {
    const e = dbError(1366, 'ER_TRUNCATED_WRONG_VALUE_FOR_FIELD', "Incorrect decimal value: '9876543210' for column 'amount' at row 1");
    const row = entryOf(e, fakeRequest({ routeOptions: { url: '/v1/customers/:id/payments' } as never }))!;
    expect(row.detail).toMatchObject({ method: 'POST', route: '/v1/customers/:id/payments', status: 500 });
    const cause = (row.detail as any).cause;
    expect(cause).toMatchObject({ name: 'Error', code: 'ER_TRUNCATED_WRONG_VALUE_FOR_FIELD', errno: 1366 });
    expect(cause.sql_message).toContain("column 'amount'");
    expect(JSON.stringify(row)).not.toContain('9876543210');
    const plain = entryOf(new TypeError('failed for 9876543210 and ABCDE1234F'))!;
    expect(JSON.stringify(plain)).not.toMatch(/9876543210|ABCDE1234F|failed for/); // the message of an error that is not the database's is free text: not stored
    expect((plain.detail as any).cause).toMatchObject({ name: 'TypeError' });
    expect((plain.detail as any).cause.where).toMatch(/^tests\/api\/error-log\.test\.ts:\d+$/); // relative to the folder the program runs in
  });

  it('the shapes of a mobile number, a PAN, a GST number and an e-mail address in a database message are cut out as well', () => {
    const e = dbError(1292, 'ER_TRUNCATED_WRONG_VALUE', 'Truncated incorrect value for 9876543210 ABCDE1234F 27ABCDE1234F1Z5 siddhi@example.test column notes');
    const text = JSON.stringify(entryOf(e));
    for (const piece of ['9876543210', 'ABCDE1234F', '27ABCDE1234F1Z5', 'siddhi@example.test']) expect(text, piece).not.toContain(piece);
    expect(text).toContain('column notes');
  });
});

// ------------------------------------------------------------------ through the whole application

describe('T-D28 through the application: 1,000 identical errors in a minute write at most 20 rows (D25)', () => {
  let pool: DbPool;
  let app: FastifyInstance;
  let sink: ReturnType<typeof logSink>;
  let n = 0;
  let T = 0n;
  let minute = '';

  beforeEach(async () => {
    // thirty seconds into a minute of its own for each test: a thousand readings of one microsecond each stay inside it, and the tests do not share the cap
    n++;
    T = BigInt(Date.UTC(2026, 9, 17, 10, n, 30)) * 1000n;
    minute = `2026-10-17 10:${String(n).padStart(2, '0')}:00`;
    pool = createDbPool(scratch.db);
    sink = logSink();
    app = buildApp({ config: testConfig(), db: pool, clock: createClock(() => T), logStream: sink.stream });
  });
  afterEach(async () => {
    await app.close().catch(() => undefined);
  });

  it('1,000 calls that fail the same way are all answered JV_INTERNAL, 20 rows are written, 980 are counted in the last, and the rows hold no marker', async () => {
    const markers = { password: secret('password'), pan: secret('pan'), mobile: secret('mobile'), cookie: secret('cookie') };
    toyRoutes(app).post('/toy/boom', async () => {
      throw new Error('the same bug every time');
    });
    await app.ready();
    const answers = new Set<number>();
    const ids = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      const res = await app.inject({ method: 'POST', url: `/toy/boom?mobile=${markers.mobile}`, headers: { ...csrfHeaders(), cookie: `${SESSION_COOKIE}=${markers.cookie}` }, payload: { password: markers.password, pan: markers.pan } });
      answers.add(res.statusCode);
      ids.add(JSON.parse(res.body).request_id);
    }
    expect([...answers]).toEqual([500]);
    expect(ids.size).toBe(1000);
    await app.errorLog.idle();
    const r = await rows("code = 'JV_INTERNAL' AND minute_at = ?", [minute]);
    expect(r).toHaveLength(20);
    expect(r.map((x) => x.seq)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    expect(parse(r[19].detail)).toMatchObject({ suppressed: 980, method: 'POST', route: '/toy/boom', status: 500 });
    expect(r.every((x) => x.level === 'error' && ids.has(x.request_id) && x.user_id === null)).toBe(true);
    const text = JSON.stringify(r);
    for (const [name, value] of Object.entries(markers)) expect(text, name).not.toContain(value);
    expect(text).not.toContain('the same bug every time'); // an error that is not the database's is described by its name and place, not its words
  }, 120_000);

  it('the answer does not wait for the row: it is sent while the row is still being written', async () => {
    toyRoutes(app).post('/toy/boom', async () => {
      throw new Error('x');
    });
    await app.ready();
    const res = await app.inject({ method: 'POST', url: '/toy/boom', headers: csrfHeaders(), payload: {} });
    expect(res.statusCode).toBe(500);
    await app.errorLog.idle();
    expect(await count('JV_INTERNAL')).toBeGreaterThan(0);
  });

  it('closing the application writes what is queued before the pool is closed', async () => {
    toyRoutes(app).post('/toy/boom', async () => {
      throw new Error('x');
    });
    await app.ready();
    const before = await count('JV_INTERNAL');
    for (let i = 0; i < 3; i++) await app.inject({ method: 'POST', url: '/toy/boom', headers: csrfHeaders(), payload: {} });
    await app.close();
    expect(await count('JV_INTERNAL')).toBe(before + 3);
  });
});

describe('T-D28 a session route\'s row carries the user, and the route as registered', () => {
  let world: World;
  beforeAll(async () => {
    world = await makeWorld({
      label: 'errlog2',
      build: (app) => {
        route(app, {
          action: 'fn:create_customer',
          handler: async () => {
            throw dbError(1146, 'ER_NO_SUCH_TABLE', "Table 'jv.customers' doesn't exist");
          },
        });
      },
    });
  }, 120_000);
  afterAll(async () => {
    await world?.close();
  });

  it('the owner\'s failing call is a JV_INTERNAL row with the owner\'s id, the request id of the answer, and no customer data', async () => {
    const mobile = secret('mobile');
    const res = await world.call('owner', 'POST', `/v1/customers?mobile=${mobile}`);
    expect(res.statusCode).toBe(500);
    await world.app.errorLog.idle();
    const [r] = (await world.sql.query<any[]>("SELECT level, code, request_id, user_id, detail FROM sys_error_log WHERE code = 'JV_INTERNAL'"))[0] as any[];
    expect(r.request_id).toBe(JSON.parse(res.body).request_id);
    expect(r.user_id).toBe(world.fixtures.owner.userId);
    expect(parse(r.detail)).toMatchObject({ method: 'POST', route: '/v1/customers', status: 500 });
    expect(JSON.stringify(r)).not.toContain(mobile);
  });
});
