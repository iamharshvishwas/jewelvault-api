import { randomBytes, randomUUID } from 'node:crypto';
import type { Connection } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as script from '../../scripts/login-counters.mjs';
import * as twin from '../../src/auth/loginCounters';
import { withAutocommit } from '../../src/db/autocommit';
import { type DbPool, createDbPool } from '../../src/db/pool';
import { type TxContext, txContext } from '../../src/db/tx';
import { type Scratch, scratchDatabase } from '../helpers';

// T-D24, T-D30 (A13, D24): the login counters of the database half live in scripts/login-counters.mjs (MB07, tests/schema/s22-login-counters.test.ts). The build compiles src/ alone, so src cannot import
// it; src/auth/loginCounters.ts is its TypeScript twin, the way src/db/adminStatements.ts is the twin of the admin statements. This file keeps the two equal: the same slots, the same statements
// character for character, and the same rows for the same calls on a real database.

const norm = (sql: string) => sql.replace(/\s+/g, ' ').trim();
const at = (iso: string) => new Date(iso);

describe('T-D24 the twin of the counter library: the same counter slots', () => {
  it('loginSlot gives the same slot as the script for e-mails and addresses of every shape, for many salts, and refuses the same things', () => {
    const addresses = ['203.0.113.9', '2001:db8:1:2:aaaa:bbbb:cccc:dddd', '2001:DB8:1:2::1', '2001:db8::1', '::1', '::ffff:203.0.113.9', 'fe80::1%eth0', '2001:db8:1:2::', 'not an address'];
    for (let s = 0; s < 20; s++) {
      const salt = randomBytes(8).toString('hex');
      for (const a of addresses) expect(twin.loginSlot(salt, 'addr', a), `${salt} ${a}`).toBe(script.loginSlot(salt, 'addr', a));
      for (let i = 0; i < 40; i++) {
        const email = `${i % 2 ? 'Mixed.Case' : 'lower'}${randomBytes(3).toString('hex')}@Example.${i % 3 ? 'test' : 'COM'} `;
        expect(twin.loginSlot(salt, 'email', email)).toBe(script.loginSlot(salt, 'email', email));
      }
    }
    expect(() => twin.loginSlot('', 'email', 'a@b.c')).toThrow(/salt/);
    expect(() => twin.loginSlot('s', 'phone' as never, 'x')).toThrow(/kind/);
    expect(twin.SLOTS).toBe(script.SLOTS);
    expect(twin.WINDOW_SECONDS).toEqual(script.WINDOW_SECONDS);
  });

  it('an address already shortened to its first 64 bits has the same slot as the address it came from (the throttle hands over the shortened one)', () => {
    expect(twin.loginSlot('s', 'addr', '2001:db8:1:2::')).toBe(twin.loginSlot('s', 'addr', '2001:db8:1:2:aaaa:bbbb:cccc:dddd'));
    expect(twin.loginSlot('s', 'addr', '203.0.113.9')).toBe(script.loginSlot('s', 'addr', '203.0.113.9'));
  });
});

describe('T-D24 the twin of the counter library: the same statements', () => {
  /** A connection that answers what the statements expect and writes down what it was asked, as the script sees it and as the prepared protocol sees it. */
  function recorder() {
    const seen: { sql: string; params: unknown[] }[] = [];
    const answer = (sql: string) => (/^\s*SELECT/i.test(sql) ? [{ n: 7 }] : { affectedRows: 1 });
    return {
      seen,
      scriptConn: {
        async query(sql: string, params: unknown[] = []) {
          seen.push({ sql: norm(sql), params });
          return [answer(sql), []];
        },
      },
      /** The handle a short checkout gives (what countAttempt takes), for the checks that must fail before any statement. */
      db: {
        async rows() {
          seen.push({ sql: 'rows', params: [] });
          return [{ n: 1 }];
        },
        async run() {
          seen.push({ sql: 'run', params: [] });
          return { affectedRows: 1 };
        },
      } as never,
      ctx(): TxContext {
        const conn = {
          async execute(sql: string, params: unknown[] = []) {
            seen.push({ sql: norm(sql), params });
            return [answer(sql), []];
          },
          release() {},
          destroy() {},
        };
        const pool = { checkout: async () => conn } as unknown as TxContext['pool'];
        return txContext(pool, { requestId: randomUUID(), actor: { id: null, role: 'job' } });
      },
    };
  }

  it.each([
    ['email', 17],
    ['addr', 1023],
    ['any', 0],
  ] as const)('countAttempt(%s) sends the atomic statement of D24 and the plain SELECT, with the database clock or with an injected time', async (scope, slot) => {
    for (const now of [undefined, at('2026-10-17T09:15:30.123Z')]) {
      const a = recorder();
      expect(await script.countAttempt(a.scriptConn as unknown as Connection, scope, slot, now ? { now } : {})).toBe(7);
      const b = recorder();
      expect(await withAutocommit(b.ctx(), (db) => twin.countAttempt(db, scope, slot, now ? { now } : {}))).toBe(7);
      expect(b.seen).toEqual(a.seen);
      expect(b.seen).toHaveLength(2);
      expect(b.seen[0].sql).toContain('INSERT INTO sys_login_attempts');
      expect(b.seen[0].sql).toContain('ON DUPLICATE KEY UPDATE');
    }
  });

  it('refuses a wrong scope or slot in the same words, before any statement is sent', async () => {
    const a = recorder();
    await expect(twin.countAttempt(a.db, 'audit' as never, 0)).rejects.toThrow(/scope/);
    await expect(twin.countAttempt(a.db, 'email', 1024)).rejects.toThrow(/slot/);
    await expect(twin.countAttempt(a.db, 'email', -1)).rejects.toThrow(/slot/);
    await expect(twin.countAttempt(a.db, 'email', 1.5)).rejects.toThrow(/slot/);
    expect(a.seen).toHaveLength(0);
  });
});

describe('T-D30 the twin of the counter library: the same rows for the same calls (D24 failure summary)', () => {
  let one: Scratch; // the script's database
  let two: Scratch; // the twin's database
  let conn: Connection; // the script's connection
  let twinConn: Connection; // to look at the twin's tables
  let pool: DbPool;
  let ctx: TxContext;

  beforeAll(async () => {
    one = await scratchDatabase('twinone', { schema: true });
    two = await scratchDatabase('twintwo', { schema: true });
    conn = await one.connect();
    twinConn = await two.connect();
    pool = createDbPool(two.db);
    ctx = txContext(pool, { requestId: randomUUID(), actor: { id: null, role: 'job' } });
  }, 120_000);

  afterAll(async () => {
    await conn?.end();
    await twinConn?.end();
    await pool?.end();
    await one?.drop();
    await two?.drop();
  });

  const dump = async (c: Connection) => ({
    counters: (await c.query<any[]>("SELECT scope, slot, DATE_FORMAT(window_start, '%Y-%m-%d %H:%i:%s.%f') AS w, n FROM sys_login_attempts ORDER BY scope, slot"))[0],
    events: (await c.query<any[]>('SELECT actor, actor_role, request_id, table_name, row_id, action, old_row, new_row FROM audit_log ORDER BY id'))[0].map((r) => ({
      ...r,
      new_row: typeof r.new_row === 'string' ? JSON.parse(r.new_row) : r.new_row,
    })),
  });

  it('a long run of counts, failures and closings gives the same answers and leaves the same tables', async () => {
    const h = (hour: number, minute = 0, second = 0) => new Date(Date.UTC(2026, 9, 17, hour, minute, second));
    const steps: { name: string; run: (api: 'script' | 'twin') => Promise<unknown> }[] = [];
    const count = (scope: 'email' | 'addr' | 'any', slot: number, now: Date) => ({
      name: `count ${scope} ${slot} ${now.toISOString()}`,
      run: (api: 'script' | 'twin') => (api === 'script' ? script.countAttempt(conn, scope, slot, { now }) : withAutocommit(ctx, (db) => twin.countAttempt(db, scope, slot, { now }))),
    });
    const fail = (now: Date) => ({ name: `fail ${now.toISOString()}`, run: (api: 'script' | 'twin') => (api === 'script' ? script.recordFailure(conn, { now }) : twin.recordFailure(ctx, { now })) });
    const close = (now: Date) => ({ name: `close ${now.toISOString()}`, run: (api: 'script' | 'twin') => (api === 'script' ? script.closeFinishedHour(conn, { now }) : twin.closeFinishedHour(ctx, { now })) });
    steps.push(count('email', 17, h(8)), count('email', 17, h(8, 0, 1)), count('email', 17, h(8, 14, 59)), count('email', 17, h(8, 15, 1)), count('addr', 17, h(8)), count('addr', 17, h(8, 0, 61)), count('any', 0, h(8)), count('any', 0, h(8, 0, 59)), count('any', 0, h(8, 1, 1)));
    for (let i = 0; i < 7; i++) steps.push(fail(h(5, i * 7)));
    steps.push(fail(h(6, 0, 1))); // closes 05:00 with 7
    for (let i = 0; i < 5; i++) steps.push(fail(h(7, i)));
    steps.push(fail(h(13, 30)), fail(h(13, 31)), close(h(13, 59, 59)), close(h(19, 5)), close(h(19, 6)), fail(h(19, 7)), close(h(23, 0)), close(h(23, 30)));
    for (const step of steps) {
      const a = await step.run('script');
      const b = await step.run('twin');
      expect(b, step.name).toEqual(a);
    }
    const [x, y] = [await dump(conn), await dump(twinConn)];
    expect(y.counters).toEqual(x.counters);
    expect(y.events).toEqual(x.events);
    expect(x.events.length).toBeGreaterThanOrEqual(3);
    expect(x.events.every((e) => e.actor === null && e.actor_role === 'job' && e.request_id === null && e.table_name === 'login_failures' && e.action === 'event' && e.old_row === null)).toBe(true);
  });

  it('exactly one of 12 failures arriving at once in the first second of a new hour closes the old one, and none of the 12 is lost from the new hour', async () => {
    const before = (await dump(twinConn)).events.length;
    for (let i = 0; i < 4; i++) await twin.recordFailure(ctx, { now: at(`2026-11-01T07:0${i}:00.000Z`) });
    const results = await Promise.all(Array.from({ length: 12 }, () => twin.recordFailure(txContext(pool, { requestId: randomUUID(), actor: { id: null, role: 'job' } }), { now: at('2026-11-01T08:00:00.500Z') })));
    expect(results.filter((r) => r.closed)).toHaveLength(1);
    expect(results.find((r) => r.closed)!.closed).toEqual({ hour: '2026-11-01 07:00:00.000000', failures: 4 });
    const after = await dump(twinConn);
    expect(after.events.length).toBe(before + 1);
    expect(Number(after.counters.find((r: any) => r.scope === 'audit').n)).toBe(12);
  });

  it('a failure counted between the read of the summary and its claim is not lost: the claim compares the count as well as the window', async () => {
    const other = await two.connect();
    try {
      for (let i = 0; i < 4; i++) await twin.recordFailure(ctx, { now: at(`2026-11-02T07:0${i}:00.000Z`) }); // four failures in the 07:00 hour
      const before = (await dump(twinConn)).events.length;
      await other.query('START TRANSACTION');
      await other.query("UPDATE sys_login_attempts SET n = n + 1 WHERE scope = 'audit' AND slot = 0"); // a fifth failure of the old hour, not yet committed
      const closing = twin.recordFailure(txContext(pool, { requestId: randomUUID(), actor: { id: null, role: 'job' } }), { now: at('2026-11-02T08:00:01.000Z') });
      await new Promise((resolve) => setTimeout(resolve, 400)); // it has read four and waits for the row to claim it
      await other.query('COMMIT');
      const result = await closing;
      expect(result.closed).toEqual({ hour: '2026-11-02 07:00:00.000000', failures: 5 });
      const after = await dump(twinConn);
      expect(after.events.length).toBe(before + 1);
      expect(after.events[after.events.length - 1].new_row.failures).toBe(5);
      expect(Number(after.counters.find((r: any) => r.scope === 'audit').n)).toBe(1); // the failure that closed the hour is the first of the new one
    } finally {
      await other.end();
    }
  });

  it('with the database clock (no injected time) a count goes 1, 2 and the first failure after an old hour closes it', async () => {
    const three = await scratchDatabase('twinthree', { schema: true });
    const pool3 = createDbPool(three.db);
    const ctx3 = txContext(pool3, { requestId: randomUUID(), actor: { id: null, role: 'job' } });
    const c = await three.connect();
    try {
      expect(await withAutocommit(ctx3, (db) => twin.countAttempt(db, 'email', 700))).toBe(1);
      expect(await withAutocommit(ctx3, (db) => twin.countAttempt(db, 'email', 700))).toBe(2);
      await twin.recordFailure(ctx3, { now: at('2020-01-01T01:10:00.000Z') });
      const live = await twin.recordFailure(ctx3); // the database clock is long after 2020
      expect(live.closed).toEqual({ hour: '2020-01-01 01:00:00.000000', failures: 1 });
      expect(Number((await c.query<any[]>("SELECT COUNT(*) AS n FROM audit_log WHERE table_name = 'login_failures'"))[0][0].n)).toBe(1);
    } finally {
      await c.end();
      await pool3.end();
      await three.drop();
    }
  });
});
