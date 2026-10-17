import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app';
import { createDbPool, type DbPool } from '../../src/db/pool';
import { StatementRefusedError } from '../../src/db/stmt';
import { TX_LIMITS, txContext, txContextFor, withRead, withTx, type Tx, type TxContext } from '../../src/db/tx';
import { BUSINESS_KEYS, BusyError, INTERNAL_KEYS, JvError } from '../../src/errors';
import { errorOf, sleep } from '../helpers';
import { logSink, testConfig } from './support';
import { NOTHING, RIGHT, WRONG, connectionLost, dbError, innodbDeadlocks, leftovers, spyOn, toyIdempotent, toyWrite, txWorld, type Step, type TxWorld } from './tx-support';

// T-C19 (S12, S8, X0): transactions. Every test runs a toy service function (tests/api/tx-support.ts) with the shape of a writing function on a scratch database that has the real schema and
// the generated audit triggers, as the ten-box user, through the real pool of 8. "Nothing left behind" means: no claim row, no number used, no row, no audit row.

let world: TxWorld;
const pools: DbPool[] = [];
const apps: ReturnType<typeof buildApp>[] = [];
const open = () => {
  const p = createDbPool(world.scratch.db);
  pools.push(p);
  return p;
};
const ACTOR = '11111111-1111-4111-8111-111111111111';
const biller = { id: ACTOR, role: 'biller' };
const ctxFor = (pool: Parameters<typeof txContext>[0], extra: Partial<Parameters<typeof txContext>[1]> = {}): TxContext => txContext(pool, { requestId: randomUUID(), actor: biller, ...extra });
const args = (customerId = world.customers[0], extra: Record<string, unknown> = {}) => ({ requestId: randomUUID(), customerId, name: `t${Math.random().toString(36).slice(2, 8)}`, ...extra });

beforeAll(async () => {
  world = await txWorld('c19');
}, 120_000);
afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close().catch(() => undefined)));
  await Promise.all(pools.splice(0).map((p) => p.end().catch(() => undefined)));
  // each test starts from an empty world: root may delete (the ten-box user cannot, and does not need to)
  await world.root.query(`DELETE FROM \`${world.scratch.database}\`.categories`);
  await world.root.query(`DELETE FROM \`${world.scratch.database}\`.sys_idempotency`);
  await world.root.query(`UPDATE \`${world.scratch.database}\`.sys_counters SET last_value = 0`);
  await world.root.query(`DELETE FROM \`${world.scratch.database}\`.audit_log WHERE table_name = 'categories'`).catch(() => undefined); // append-only trigger: ignore
});
afterAll(async () => {
  await world?.drop();
}, 60_000);

describe('T-C19 the numbers of S12', () => {
  it('are the spec\'s, in one place: a deadline of 12 s, 2 re-runs after 20 to 80 ms', () => {
    expect(TX_LIMITS).toEqual({ deadlineMs: 12_000, deadlockReruns: 2, jitterMinMs: 20, jitterMaxMs: 80 });
  });
  it('the default jitter is between 20 and 80 ms and is not one fixed number', () => {
    const ctx = ctxFor(open());
    const samples = Array.from({ length: 300 }, () => ctx.jitter());
    expect(Math.min(...samples)).toBeGreaterThanOrEqual(20);
    expect(Math.max(...samples)).toBeLessThanOrEqual(80);
    expect(new Set(samples.map(Math.round)).size).toBeGreaterThan(20);
  });
  it('a request id that is not a UUID is refused when the context is made (the audit log column is a UUID)', () => {
    expect(() => txContext(open(), { requestId: 'req-1', actor: biller })).toThrow(/UUID/);
    expect(() => txContext(open(), { requestId: randomUUID(), actor: { id: 'not-a-uuid', role: 'owner' } })).toThrow(/UUID/);
  });
});

describe('T-C19 one request, one connection, one transaction', () => {
  it('a call uses one connection, START TRANSACTION once, COMMIT once, no ROLLBACK, and prepared statements for everything that carries a value', async () => {
    const spy = spyOn(open());
    const out = await withTx(ctxFor(spy.pool), (tx) => toyWrite(tx, args()));
    expect(out.number).toBe(1);
    expect(new Set(spy.sent.map((s) => s.thread)).size).toBe(1);
    const sqls = spy.sqls();
    expect(sqls.filter((s) => /^START TRANSACTION/i.test(s))).toHaveLength(1);
    expect(sqls.filter((s) => s === 'COMMIT')).toHaveLength(1);
    expect(sqls.some((s) => /ROLLBACK/i.test(s))).toBe(false);
    // the four statements of the toy, and the three that set the actor variables, are prepared (execute); only the fixed control statements go as text
    for (const s of spy.sent) {
      if (/^(START TRANSACTION|COMMIT|ROLLBACK)/i.test(s.sql) || /SET @jv_actor = NULL/.test(s.sql)) expect(s.kind, s.sql).toBe('query');
      else expect(s.kind, s.sql).toBe('execute');
    }
    expect(await leftovers(world)).toEqual({ categories: 1, audit: 1, claims: 1, counter: 1 });
  });

  it('the connection goes back to the pool and the place is free again', async () => {
    const pool = open();
    await withTx(ctxFor(pool), (tx) => toyWrite(tx, args()));
    expect(pool.stats()).toMatchObject({ inUse: 0, waiting: 0 });
    await errorOf(() => withTx(ctxFor(pool), () => Promise.reject(new Error('x'))));
    expect(pool.stats()).toMatchObject({ inUse: 0, waiting: 0 });
  });

  it('the actor variables (MB06) are set inside the transaction, are what the audit trigger writes, and are cleared at the end', async () => {
    const pool = open();
    const requestId = randomUUID();
    let seen: unknown;
    await withTx(txContext(pool, { requestId, actor: biller }), async (tx) => {
      [seen] = await tx.rows('SELECT @jv_actor AS a, @jv_role AS r, @jv_request AS q');
      await toyWrite(tx, { ...args(), steps: ['row'] });
    });
    expect(seen).toEqual({ a: ACTOR, r: 'biller', q: requestId });
    const [[audit]] = await world.root.query<any[]>(`SELECT actor, actor_role, request_id FROM \`${world.scratch.database}\`.audit_log WHERE table_name = 'categories'`);
    expect(audit).toEqual({ actor: ACTOR, actor_role: 'biller', request_id: requestId });
    // the variables live on the pooled connection: the next user of it must find them empty
    const next = await pool.checkout();
    const [[vars]] = await next.query<any[]>('SELECT @jv_actor AS a, @jv_role AS r, @jv_request AS q');
    expect(vars).toEqual({ a: null, r: null, q: null });
    next.release();
  });

  it('also cleared when the call fails; a call with no actor writes role "sql"; a job writes no actor and its role', async () => {
    const pool = open();
    const spy = spyOn(pool);
    await errorOf(() => withTx(ctxFor(spy.pool), async (tx) => {
      await toyWrite(tx, { ...args(), steps: ['row'] });
      throw new Error('boom');
    }));
    expect(spy.sqls().filter((s) => /SET @jv_actor = NULL/.test(s))).toHaveLength(1);
    await withTx(txContext(pool, { requestId: randomUUID(), actor: null }), (tx) => toyWrite(tx, { ...args(), steps: ['row'] }));
    await withTx(txContext(pool, { requestId: randomUUID(), actor: { id: null, role: 'job' } }), (tx) => toyWrite(tx, { ...args(), steps: ['row'] }));
    const [rows] = await world.root.query<any[]>(`SELECT actor, actor_role FROM \`${world.scratch.database}\`.audit_log WHERE table_name = 'categories' ORDER BY id`);
    expect(rows).toEqual([{ actor: null, actor_role: 'sql' }, { actor: null, actor_role: 'job' }]);
  });
});

describe('T-C19 any error means ROLLBACK of everything, and domain code cannot carry on', () => {
  const holdCustomer = async (id: string) => {
    const holder = await world.scratch.connect();
    await holder.query('START TRANSACTION');
    await holder.query('SELECT id FROM customers WHERE id = ? FOR UPDATE', [id]);
    return { release: async () => { await holder.query('ROLLBACK'); await holder.end(); } };
  };

  it('a function whose later statement waits for a held row and hits 1205 leaves no claim, no number, no row and no audit row; the answer is JV_BUSY (5 s)', async () => {
    const holder = await holdCustomer(world.customers[0]);
    const pool = open();
    const spy = spyOn(pool);
    const t0 = Date.now();
    const e = await errorOf(() => withTx(ctxFor(spy.pool), (tx) => toyWrite(tx, { ...args(), steps: ['claim', 'row', 'number', 'lock'] })));
    const took = Date.now() - t0;
    expect(e).toBeInstanceOf(BusyError);
    expect(e).toMatchObject({ code: 'JV_BUSY', status: 503, reason: 'lock_wait', retryAfter: 1 });
    expect(took).toBeGreaterThanOrEqual(4900); // innodb_lock_wait_timeout is 5 s on the API's connection
    expect(took).toBeLessThan(8000);
    expect(spy.sqls().filter((s) => s === 'ROLLBACK')).toHaveLength(1);
    expect(spy.sqls().some((s) => s === 'COMMIT')).toBe(false);
    expect(await leftovers(world)).toEqual(NOTHING);
    await holder.release();
    // the connection is still good, and the same call now works
    expect(await withTx(ctxFor(pool), (tx) => toyWrite(tx, args()))).toMatchObject({ number: 1 });
    expect(await leftovers(world)).toEqual({ categories: 1, audit: 1, claims: 1, counter: 1 });
  }, 30_000);

  it('code that catches the database error and goes on is not allowed to commit: the later statements are not even sent, the answer is the first error, and nothing is left', async () => {
    const spy = spyOn(open());
    spy.intercept = (e) => {
      if (/FOR UPDATE/.test(e.sql)) throw dbError(1205, 'ER_LOCK_WAIT_TIMEOUT', 'Lock wait timeout exceeded; try restarting transaction');
    };
    const e = await errorOf(() =>
      withTx(ctxFor(spy.pool), async (tx) => {
        try {
          await toyWrite(tx, { ...args(), steps: ['claim', 'lock'] });
        } catch {
          /* the wrong thing to do: swallow it and carry on */
        }
        await toyWrite(tx, { ...args(), steps: ['number', 'row'] });
        return 'carried on';
      }),
    );
    expect(e).toMatchObject({ code: 'JV_BUSY', reason: 'lock_wait' });
    expect(spy.sqls().some((s) => /UPDATE sys_counters|INSERT INTO categories/.test(s))).toBe(false);
    expect(spy.sqls().some((s) => s === 'COMMIT')).toBe(false);
    expect(await leftovers(world)).toEqual(NOTHING);
  });

  it('a domain error thrown by the function (JV_OVERPAYMENT) rolls back and goes out as it is, not rewritten', async () => {
    const spy = spyOn(open());
    const domain = new JvError('JV_OVERPAYMENT', 'The payment is more than is pending.');
    const e = await errorOf(() =>
      withTx(ctxFor(spy.pool), async (tx) => {
        await toyWrite(tx, args());
        throw domain;
      }),
    );
    expect(e).toBe(domain);
    expect(spy.sqls().filter((s) => s === 'ROLLBACK')).toHaveLength(1);
    expect(await leftovers(world)).toEqual(NOTHING);
  });

  it('a bug in the function (a TypeError) rolls back and is JV_INTERNAL with the bug as its cause', async () => {
    const bug = new TypeError('x.y is not a function');
    const e = (await errorOf(() =>
      withTx(ctxFor(open()), async (tx) => {
        await toyWrite(tx, args());
        throw bug;
      }),
    )) as JvError;
    expect(e).toMatchObject({ code: 'JV_INTERNAL', status: 500 });
    expect(e.cause).toBe(bug);
    expect(await leftovers(world)).toEqual(NOTHING);
  });

  it('a duplicate key on an ordinary business key (a category name) is JV_INVALID_INPUT, rolled back; on the idempotency claim it is JV_INTERNAL (a bug)', async () => {
    await withTx(ctxFor(open()), (tx) => tx.run("INSERT INTO categories (id, name, prefix) VALUES (?, 'Rings', 'RG')", [randomUUID()]));
    const e = await errorOf(() => withTx(ctxFor(open()), (tx) => tx.run("INSERT INTO categories (id, name, prefix) VALUES (?, 'Rings', 'RG')", [randomUUID()])));
    expect(e).toMatchObject({ code: 'JV_INVALID_INPUT', status: 422 });
    const key = randomUUID();
    await withTx(ctxFor(open()), (tx) => toyWrite(tx, { ...args(), requestId: key, steps: ['claim'] }));
    const again = await errorOf(() => withTx(ctxFor(open()), (tx) => toyWrite(tx, { ...args(), requestId: key, steps: ['claim'] })));
    expect(again).toMatchObject({ code: 'JV_INTERNAL', status: 500 });
  });

  it('an out-of-range value (1264) and a failed CHECK (4025) from the real server are JV_INVALID_INPUT, rolled back', async () => {
    const big = await errorOf(() => withTx(ctxFor(open()), (tx) => tx.run('INSERT INTO sys_counters (series, last_value) VALUES (?, ?)', ['x', '99999999999999999999'])));
    expect(big).toMatchObject({ code: 'JV_INVALID_INPUT', bug: true });
    const check = await errorOf(() => withTx(ctxFor(open()), (tx) => tx.run('INSERT INTO sys_counters (series, last_value, seed_value) VALUES (?, 1, 5)', ['y'])));
    expect(check).toMatchObject({ code: 'JV_INVALID_INPUT', bug: true });
  });

  it('a transaction object kept after the call is over refuses everything: it must not reach a connection that another request now holds', async () => {
    let kept!: Tx;
    await withTx(ctxFor(open()), async (tx) => {
      kept = tx;
    });
    await expect(kept.rows('SELECT 1 AS one')).rejects.toThrow(/over/);
    await expect(kept.run('UPDATE sys_counters SET last_value = 99')).rejects.toThrow(/over/);
  });

  it('a connection that drops during a statement: JV_BUSY (connection lost), the connection is destroyed and not handed on, nothing is left', async () => {
    const pool = open();
    const spy = spyOn(pool);
    let thread = 0;
    spy.intercept = (e) => {
      if (/FOR UPDATE/.test(e.sql)) {
        thread = e.thread;
        throw connectionLost();
      }
    };
    const e = await errorOf(() => withTx(ctxFor(spy.pool), (tx) => toyWrite(tx, args())));
    expect(e).toMatchObject({ code: 'JV_BUSY', reason: 'connection_lost', outcomeUnknown: false });
    expect(spy.sqls().some((s) => s === 'ROLLBACK')).toBe(false); // it would only fail
    expect(pool.stats().inUse).toBe(0);
    expect(await leftovers(world)).toEqual(NOTHING);
    // the intercept only pretended the connection broke; the pool destroyed the real one instead of handing it on
    let alive = true;
    for (let i = 0; i < 60 && alive; i++) {
      const [[row]] = await world.root.query<any[]>('SELECT COUNT(*) AS n FROM information_schema.PROCESSLIST WHERE ID = ?', [thread]);
      alive = Number(row.n) > 0;
      if (alive) await sleep(50);
    }
    expect(alive).toBe(false);
  });
});

describe('T-C19 a deadlock is re-run up to 2 more times after 20 to 80 ms of jitter, then JV_BUSY', () => {
  const deadlock = () => dbError(1213, 'ER_LOCK_DEADLOCK', 'Deadlock found when trying to get lock; try restarting transaction');

  it('a call that always deadlocks runs 3 times in all (one try and two re-runs), waits twice, then answers JV_BUSY; nothing is left', async () => {
    const spy = spyOn(open());
    spy.intercept = (e) => {
      if (/FOR UPDATE/.test(e.sql)) throw deadlock();
    };
    const waits: number[] = [];
    let runs = 0;
    const e = await errorOf(() =>
      withTx(ctxFor(spy.pool, { sleep: async (ms: number) => void waits.push(ms) }), async (tx) => {
        runs++;
        return toyWrite(tx, args());
      }),
    );
    expect(runs).toBe(3);
    expect(e).toMatchObject({ code: 'JV_BUSY', reason: 'deadlock', status: 503 });
    expect(waits).toHaveLength(2);
    for (const w of waits) {
      expect(w).toBeGreaterThanOrEqual(20);
      expect(w).toBeLessThanOrEqual(80);
    }
    expect(spy.sqls().filter((s) => /^START TRANSACTION/i.test(s))).toHaveLength(3);
    expect(spy.sqls().filter((s) => s === 'ROLLBACK')).toHaveLength(3);
    expect(spy.sqls().filter((s) => s === 'COMMIT')).toHaveLength(0);
    expect(await leftovers(world)).toEqual(NOTHING);
  });

  it('a call that deadlocks once is re-run and saves once: one claim, one number, one row, one audit row', async () => {
    const spy = spyOn(open());
    let first = true;
    spy.intercept = (e) => {
      if (/FOR UPDATE/.test(e.sql) && first) {
        first = false;
        throw deadlock();
      }
    };
    const waits: number[] = [];
    const out = await withTx(ctxFor(spy.pool, { sleep: async (ms: number) => void waits.push(ms) }), (tx) => toyWrite(tx, args()));
    expect(out.number).toBe(1);
    expect(waits).toHaveLength(1);
    expect(await leftovers(world)).toEqual({ categories: 1, audit: 1, claims: 1, counter: 1 });
  });

  it('the connection is given back between the runs: the jitter is not spent holding a place', async () => {
    const pool = open();
    const spy = spyOn(pool);
    let first = true;
    spy.intercept = (e) => {
      if (/FOR UPDATE/.test(e.sql) && first) {
        first = false;
        throw deadlock();
      }
    };
    let inUseDuringWait = -1;
    await withTx(ctxFor(spy.pool, { sleep: async () => void (inUseDuringWait = pool.stats().inUse) }), (tx) => toyWrite(tx, args()));
    expect(inUseDuringWait).toBe(0);
  });

  it('a REAL deadlock (two calls take the same two customer rows in opposite order): the server picks one, it is re-run, both calls finish and both rows are written', async () => {
    const pool = open();
    const [c1, c2] = world.customers;
    let ready = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const call = (first: string, second: string, name: string) => {
      let runs = 0;
      return withTx(ctxFor(pool), async (tx) => {
        runs++;
        await tx.rows('SELECT id FROM customers WHERE id = ? FOR UPDATE', [first]);
        if (runs === 1 && ++ready === 2) release();
        if (runs === 1) await gate; // both hold their first row before either asks for the second
        await tx.rows('SELECT id FROM customers WHERE id = ? FOR UPDATE', [second]);
        await tx.run('INSERT INTO categories (id, name, prefix) VALUES (?, ?, ?)', [randomUUID(), name, 'TY']);
        return runs;
      });
    };
    const before = await innodbDeadlocks(world.root);
    const runs = await Promise.all([call(c1, c2, 'one'), call(c2, c1, 'two')]);
    expect([...runs].sort()).toEqual([1, 2]); // exactly one of them was re-run
    expect((await innodbDeadlocks(world.root)) - before).toBe(1);
    expect((await leftovers(world)).categories).toBe(2);
  });
});

describe('T-C19 the lock order: the negative control', () => {
  /** 8 workers, each with a few statements and a short think-time after its first lock, so that the calls overlap the way busy ones do. */
  async function workload(order: (worker: number, op: number) => Step[], opts: { workers?: number; ops?: number } = {}) {
    const { workers = 8, ops = 40 } = opts;
    const pool = open();
    const stats = { ok: 0, busy: 0, other: [] as string[] };
    const before = await innodbDeadlocks(world.root);
    await Promise.all(
      Array.from({ length: workers }, async (_, w) => {
        for (let i = 0; i < ops; i++) {
          const steps = order(w, i);
          try {
            await withTx(ctxFor(pool), (tx) => toyWrite(tx, { ...args(world.customers[i % 2], { name: `w${w}o${i}` }), steps, after: async (s) => void (s === steps[1] && (await sleep(3))) }));
            stats.ok++;
          } catch (e) {
            if (e instanceof BusyError && e.reason === 'deadlock') stats.busy++;
            else stats.other.push(String((e as Error).message));
          }
        }
      }),
    );
    return { ...stats, deadlocks: (await innodbDeadlocks(world.root)) - before };
  }

  it('the right order (claim, customer, number LAST) under 8 parallel workers: 0 deadlocks, every call saved, numbers 1..N with no gap and no repeat, one audit row each', async () => {
    const s = await workload(() => RIGHT);
    expect(s).toMatchObject({ ok: 320, busy: 0, other: [], deadlocks: 0 });
    const left = await leftovers(world);
    expect(left).toEqual({ categories: 320, audit: 320, claims: 320, counter: 320 });
    const [rows] = await world.root.query<any[]>(`SELECT CAST(SUBSTRING_INDEX(name, '#', -1) AS UNSIGNED) AS n FROM \`${world.scratch.database}\`.categories ORDER BY n`);
    expect(rows.map((r) => Number(r.n))).toEqual(Array.from({ length: 320 }, (_, i) => i + 1));
  }, 120_000);

  it('NEGATIVE CONTROL: half of the calls take the counter BEFORE the customer lock -> the harness sees deadlocks (so it is able to), and the re-runs keep the books straight', async () => {
    let seen = 0;
    let total = { ok: 0, busy: 0 };
    for (let round = 0; round < 3 && seen === 0; round++) {
      const s = await workload((w, i) => ((w + Math.floor(i / 2)) % 2 === 0 ? WRONG : RIGHT), { ops: 30 });
      expect(s.other).toEqual([]);
      seen += s.deadlocks;
      total = { ok: total.ok + s.ok, busy: total.busy + s.busy };
    }
    expect(seen).toBeGreaterThan(0);
    // whatever the deadlocks did, a number used is a call saved: counter == rows == audit rows == calls that answered ok
    const left = await leftovers(world);
    expect(left.categories).toBe(total.ok);
    expect(left.audit).toBe(total.ok);
    expect(left.counter).toBe(total.ok);
    expect(left.claims).toBe(total.ok);
  }, 180_000);
});

describe('T-C19 (S8) a duplicate key (1062) is a business key or a bug: every unique key of the database is said to be one or the other', () => {
  it('src/errors.ts names each unique key of the migrated schema exactly once, so a migration that adds one has to decide (and no name is left over from a key that is gone)', async () => {
    const [rows] = await world.root.query<any[]>('SELECT DISTINCT INDEX_NAME AS name FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? AND NON_UNIQUE = 0', [world.scratch.database]);
    const inDatabase = rows.map((r) => String(r.name)).sort();
    const named = [...BUSINESS_KEYS, ...INTERNAL_KEYS].sort();
    expect(new Set(named).size).toBe(named.length);
    expect(named).toEqual(inDatabase);
  });
  it('the real server\'s message names the key the way the map reads it (11.8: just the key\'s name)', async () => {
    await withTx(ctxFor(open()), (tx) => tx.run("INSERT INTO categories (id, name, prefix) VALUES (?, 'Chains', 'CH')", [randomUUID()]));
    const e = (await errorOf(() => withTx(ctxFor(open()), (tx) => tx.run("INSERT INTO categories (id, name, prefix) VALUES (?, 'Chains', 'CH')", [randomUUID()])))) as JvError;
    expect(e).toMatchObject({ code: 'JV_INVALID_INPUT' });
    expect(String((e.cause as Error).message)).toMatch(/for key '(categories\.)?uq_categories_name'/);
  });
});

describe('T-C19 an object passed as a statement parameter is refused', () => {
  const run = (spy: ReturnType<typeof spyOn>, param: unknown) => errorOf(() => withTx(ctxFor(spy.pool), (tx) => tx.rows('SELECT id FROM customers WHERE id = ?', [param as string])));

  it('CONTROL: the driver\'s own query() would expand an object into column = value pairs where it stands for a SET list (the classic trap), and an array into a list: which is why the wrapper refuses both', async () => {
    const c = await open().checkout();
    expect(c.format('UPDATE customers SET ? WHERE id = ?', [{ name: 'y', pan: 'ABCDE1234F' }, 'x'])).toBe("UPDATE customers SET `name` = 'y', `pan` = 'ABCDE1234F' WHERE id = 'x'");
    expect(c.format('SELECT 1 FROM customers WHERE id IN (?)', [['a', 'b']])).toBe("SELECT 1 FROM customers WHERE id IN ('a', 'b')");
    c.release();
  });

  it.each([
    ['an object', { id: 'x' }],
    ['an array', ['a', 'b']],
    ['a Date', new Date()],
    ['undefined', undefined],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['a bigint', 10n],
    ['a Map', new Map()],
    ['a function', () => 1],
  ])('%s is refused before the statement is sent, and the call is rolled back', async (_label, param) => {
    const spy = spyOn(open());
    const e = (await run(spy, param)) as JvError;
    expect(e).toMatchObject({ code: 'JV_INTERNAL', status: 500 }); // a bug in the code, never the caller's fault
    expect(e.cause).toBeInstanceOf(StatementRefusedError);
    expect((e.cause as StatementRefusedError).rule).toBe('parameter');
    expect(spy.sqls().some((s) => /FROM customers/.test(s))).toBe(false);
    expect(spy.sqls().filter((s) => s === 'ROLLBACK')).toHaveLength(1);
  });

  it('text, numbers, booleans, null and Buffers go through, one ? for each value (an IN list gets one ? for each element)', async () => {
    const [row] = await withTx(ctxFor(open()), (tx) => tx.rows<Record<string, unknown>>('SELECT ? AS s, ? AS n, ? AS t, ? AS f, ? AS z, ? AS b', ['text', 7, true, false, null, Buffer.from('ab')]));
    expect(row).toMatchObject({ s: 'text', n: 7, z: null });
    expect(Buffer.from(row.b as Buffer).toString()).toBe('ab');
    const two = await withTx(ctxFor(open()), (tx) => tx.rows('SELECT id FROM customers WHERE id IN (?, ?)', world.customers));
    expect(two).toHaveLength(2);
  });

  it('a JSON column is sent as JSON.stringify text, and money inside it is a string', async () => {
    const key = randomUUID();
    await withTx(ctxFor(open()), async (tx) => {
      await toyWrite(tx, { ...args(), requestId: key, steps: ['claim'] });
      await tx.run('UPDATE sys_idempotency SET result = ? WHERE request_id = ?', [JSON.stringify({ total: '12.50' }), key]);
    });
    const [[row]] = await world.root.query<any[]>(`SELECT JSON_UNQUOTE(JSON_EXTRACT(result, '$.total')) AS total FROM \`${world.scratch.database}\`.sys_idempotency WHERE request_id = ?`, [key]);
    expect(row.total).toBe('12.50');
  });
});

describe('T-C19 the deadline of 12 seconds: checked before every statement and again just before COMMIT', () => {
  it('a call over its deadline stops BEFORE its next statement: the statement is not sent, the answer is JV_BUSY (deadline), nothing is left', async () => {
    const spy = spyOn(open());
    let t = 0;
    const e = await errorOf(() =>
      withTx(ctxFor(spy.pool, { now: () => t, arrivedAt: 0 }), async (tx) => {
        await toyWrite(tx, { ...args(), steps: ['claim'] });
        t = 12_001; // 12 s and a millisecond after the request arrived
        await toyWrite(tx, { ...args(), steps: ['number'] });
        return 'unreachable';
      }),
    );
    expect(e).toMatchObject({ code: 'JV_BUSY', reason: 'deadline', status: 503 });
    expect(spy.sqls().some((s) => /UPDATE sys_counters/.test(s))).toBe(false);
    expect(await leftovers(world)).toEqual(NOTHING);
  });

  it('exactly 12 s is not yet over; a millisecond more is (the boundary)', async () => {
    let t = 0;
    const out = await withTx(ctxFor(open(), { now: () => t, arrivedAt: 0 }), async (tx) => {
      t = 12_000;
      return toyWrite(tx, { ...args(), steps: ['number'] });
    });
    expect(out.number).toBe(1);
  });

  it('a call that is over its deadline at COMMIT is rolled back instead of committed (JV_BUSY, deadline); COMMIT is never sent', async () => {
    const spy = spyOn(open());
    let t = 0;
    const e = await errorOf(() =>
      withTx(ctxFor(spy.pool, { now: () => t, arrivedAt: 0 }), async (tx) => {
        const out = await toyWrite(tx, args()); // every statement was inside the deadline
        t = 12_500; // ...and the function took its time after the last one
        return out;
      }),
    );
    expect(e).toMatchObject({ code: 'JV_BUSY', reason: 'deadline' });
    expect(spy.sqls().filter((s) => s === 'ROLLBACK')).toHaveLength(1);
    expect(spy.sqls().some((s) => s === 'COMMIT')).toBe(false);
    expect(await leftovers(world)).toEqual(NOTHING);
  });

  it('the deadline starts when the request ARRIVES, so the wait for a connection counts: 1.5 s of waiting turns a call that arrived 10.8 s ago into a late one, and nothing is started', async () => {
    const pool = open();
    const spy = spyOn(pool);
    const held = await Promise.all(Array.from({ length: 8 }, () => pool.checkout()));
    setTimeout(() => held[0].release(), 1500);
    const t0 = Date.now();
    const e = await errorOf(() => withTx(ctxFor(spy.pool, { arrivedAt: performance.now() - 10_800 }), (tx) => toyWrite(tx, args())));
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1400);
    expect(e).toMatchObject({ code: 'JV_BUSY', reason: 'deadline' });
    expect(spy.sqls().some((s) => /START TRANSACTION|categories|sys_counters/.test(s))).toBe(false);
    for (const c of held.slice(1)) c.release();
    expect(await leftovers(world)).toEqual(NOTHING);
  });
});

describe('T-C19 a connection lost during COMMIT: JV_BUSY that does not promise "nothing was changed"; the retry with the same key tells the truth', () => {
  const key = () => randomUUID();

  it('the server committed but the answer was lost: JV_BUSY (outcome unknown); the retry with the same key returns the stored result and saves nothing twice', async () => {
    const pool = open();
    const spy = spyOn(pool);
    spy.intercept = async (e) => {
      if (e.sql === 'COMMIT') {
        await e.real(); // it reached the server and was saved...
        throw connectionLost(); // ...and the connection dropped before the answer came back
      }
    };
    const k = key();
    const a = args(world.customers[0], { requestId: k });
    const e = await errorOf(() => withTx(ctxFor(spy.pool), (tx) => toyIdempotent(tx, a)));
    expect(e).toMatchObject({ code: 'JV_BUSY', reason: 'commit_lost', outcomeUnknown: true, status: 503 });
    expect(pool.stats().inUse).toBe(0);
    expect(await leftovers(world)).toEqual({ categories: 1, audit: 1, claims: 1, counter: 1 }); // it HAD committed
    spy.intercept = null;
    const retry = await withTx(ctxFor(pool), (tx) => toyIdempotent(tx, a));
    expect(retry).toMatchObject({ replayed: true, number: 1 });
    expect(await leftovers(world)).toEqual({ categories: 1, audit: 1, claims: 1, counter: 1 });
  });

  it('the connection was killed before the COMMIT reached the server: JV_BUSY (outcome unknown); nothing was saved; the retry with the same key runs the call once', async () => {
    const pool = open();
    const spy = spyOn(pool);
    spy.intercept = async (e) => {
      if (e.sql === 'COMMIT') {
        await world.root.query(`KILL CONNECTION ${Number(e.thread)}`);
        await sleep(150); // the server has closed it
      }
    };
    const k = key();
    const a = args(world.customers[0], { requestId: k });
    const e = await errorOf(() => withTx(ctxFor(spy.pool), (tx) => toyIdempotent(tx, a)));
    expect(e).toMatchObject({ code: 'JV_BUSY', reason: 'commit_lost', outcomeUnknown: true });
    expect(await leftovers(world)).toEqual(NOTHING); // the server rolled it back when the connection died
    spy.intercept = null;
    const retry = await withTx(ctxFor(pool), (tx) => toyIdempotent(tx, a));
    expect(retry).toMatchObject({ replayed: false, number: 1 });
    expect(await leftovers(world)).toEqual({ categories: 1, audit: 1, claims: 1, counter: 1 });
  });

  it('the answer to the screen says JV_BUSY and never "nothing was changed"', async () => {
    const e = new BusyError('commit_lost', { outcomeUnknown: true });
    expect(e.message).not.toMatch(/nothing was changed|not saved|no change/i);
    expect(e.outcomeUnknown).toBe(true);
  });
});

describe('T-C19 the pool under load: every wait ends in JV_BUSY, never in the handler timer', () => {
  it('the customer row is held by another connection (28 s by the spec) and 40 payments arrive at once on a pool of 8: every call is answered JV_BUSY (503, Retry-After 1, S8 body) within 15 s, none by the 25-second handler timer, nothing is written', async () => {
    const pool = open();
    const sink = logSink();
    const app = buildApp({ config: testConfig(), db: pool, logStream: sink.stream });
    apps.push(app);
    app.post('/toy/pay', async (request) => withTx(txContextFor(pool, request, biller), (tx) => toyWrite(tx, { ...args(), requestId: request.id })));
    await app.ready();

    const holder = await world.scratch.connect();
    await holder.query('START TRANSACTION');
    await holder.query('SELECT id FROM customers WHERE id = ? FOR UPDATE', [world.customers[0]]);
    const heldSince = performance.now();

    const t0 = performance.now();
    const answers = await Promise.all(
      Array.from({ length: 40 }, async () => {
        const res = await app.inject({ method: 'POST', url: '/toy/pay' });
        return { status: res.statusCode, retryAfter: res.headers['retry-after'], body: JSON.parse(res.body), ms: performance.now() - t0 };
      }),
    );
    const stillHeldFor = performance.now() - heldSince;
    await holder.query('ROLLBACK');
    await holder.end();

    expect(stillHeldFor).toBeLessThan(28_000); // the row was held the whole time they were being answered
    for (const a of answers) {
      expect(a.status).toBe(503);
      expect(a.retryAfter).toBe('1');
      expect(Object.keys(a.body)).toEqual(['error', 'request_id']);
      expect(a.body.error.code).toBe('JV_BUSY');
      expect(a.ms).toBeLessThan(15_000);
    }
    const slowest = Math.max(...answers.map((a) => a.ms));
    expect(slowest).toBeGreaterThanOrEqual(4500); // the ones that got a connection really waited for the lock
    expect(slowest).toBeLessThan(10_000);
    const reasons = sink.lines().filter((l) => l.level === 40 && typeof l.reason === 'string').map((l) => l.reason as string);
    expect(reasons).toHaveLength(40);
    expect(new Set(reasons)).toEqual(new Set(['lock_wait', 'wait_timeout', 'queue_full'])); // all from the work, none from a timer
    expect(reasons.filter((r) => r === 'lock_wait')).toHaveLength(8);
    expect(await leftovers(world)).toEqual(NOTHING);

    // and once the row is free again the same endpoint works
    const after = await app.inject({ method: 'POST', url: '/toy/pay' });
    expect(after.statusCode).toBe(200);
    expect(await leftovers(world)).toEqual({ categories: 1, audit: 1, claims: 1, counter: 1 });
  }, 60_000);

  it('all 8 connections are busy (30 s by the spec): one call is JV_BUSY in under 3 seconds and writes nothing', async () => {
    const pool = open();
    const held = await Promise.all(Array.from({ length: 8 }, () => pool.checkout()));
    const t0 = Date.now();
    const e = await errorOf(() => withTx(ctxFor(pool), (tx) => toyWrite(tx, args())));
    const took = Date.now() - t0;
    expect(e).toMatchObject({ code: 'JV_BUSY', reason: 'wait_timeout', nothingStarted: true, status: 503 });
    expect(took).toBeGreaterThanOrEqual(1900);
    expect(took).toBeLessThan(3000);
    expect(await leftovers(world)).toEqual(NOTHING);
    for (const c of held) c.release();
  });

  it('the request\'s arrival time is taken by the app when the request comes in, not when the handler gets to it', async () => {
    const pool = open();
    const app = buildApp({ config: testConfig(), db: pool, logStream: logSink().stream });
    apps.push(app);
    app.get('/toy/arrival', async (request) => {
      await sleep(60);
      const ctx = txContextFor(pool, request, biller);
      return { waitedMs: performance.now() - ctx.arrivedAt, requestId: ctx.requestId, same: ctx.requestId === request.id };
    });
    await app.ready();
    const res = await app.inject({ method: 'GET', url: '/toy/arrival' });
    const b = res.json();
    expect(b.waitedMs).toBeGreaterThanOrEqual(55);
    expect(b.waitedMs).toBeLessThan(1000);
    expect(b.same).toBe(true);
  });
});

describe('T-C19 withRead: reads outside a transaction on a checked-out connection with the same session settings', () => {
  const EXPECTED = { iso: 'READ-COMMITTED', sql_mode: 'STRICT_ALL_TABLES,ERROR_FOR_DIVISION_BY_ZERO', tz: '+00:00', lock_wait: 5, stmt: 8, wait_timeout: 300, cs_client: 'utf8mb4', cs_conn: 'utf8mb4', cs_results: 'utf8mb4', coll: 'utf8mb4_unicode_ci' };

  it('answers a SELECT with the seven settings of S11 and no transaction, using a prepared statement', async () => {
    const pool = open();
    const spy = spyOn(pool);
    const [r] = await withRead(ctxFor(spy.pool), (db) =>
      db.rows<Record<string, unknown>>(
        'SELECT @@session.transaction_isolation AS iso, @@session.sql_mode AS sql_mode, @@session.time_zone AS tz, @@session.innodb_lock_wait_timeout AS lock_wait, @@session.max_statement_time AS stmt, @@session.wait_timeout AS wait_timeout, @@session.character_set_client AS cs_client, @@session.character_set_connection AS cs_conn, @@session.character_set_results AS cs_results, @@session.collation_connection AS coll, @@in_transaction AS in_tx',
      ),
    );
    expect({ ...r, lock_wait: Number(r.lock_wait), stmt: Number(r.stmt), wait_timeout: Number(r.wait_timeout), in_tx: Number(r.in_tx) }).toEqual({ ...EXPECTED, in_tx: 0 });
    expect(spy.sent).toHaveLength(1); // no START TRANSACTION, no COMMIT, no ROLLBACK, no variables
    expect(spy.sent[0].kind).toBe('execute');
    expect(pool.stats().inUse).toBe(0);
  });

  it('refuses anything that is not a read: a write, a delete, a lock for update is not what a reader is for', async () => {
    const spy = spyOn(open());
    for (const sql of ['UPDATE sys_counters SET last_value = 1', "INSERT INTO categories (id, name, prefix) VALUES (UUID(), 'x', 'XX')", 'DELETE FROM categories', 'SET @a = 1']) {
      const e = (await errorOf(() => withRead(ctxFor(spy.pool), (db) => db.rows(sql)))) as JvError;
      expect(e, sql).toMatchObject({ code: 'JV_INTERNAL' });
      expect(e.cause, sql).toBeInstanceOf(StatementRefusedError);
    }
    expect(spy.sent).toHaveLength(0);
    expect(await leftovers(world)).toEqual(NOTHING);
  });

  it('gives the connection back on every path, refuses a parameter that is an object, and checks the deadline before each statement', async () => {
    const pool = open();
    await withRead(ctxFor(pool), (db) => db.rows('SELECT 1 AS one'));
    expect(pool.stats().inUse).toBe(0);
    const bad = (await errorOf(() => withRead(ctxFor(pool), (db) => db.rows('SELECT 1 FROM customers WHERE id = ?', [{ id: 1 } as never])))) as JvError;
    expect(bad.cause).toBeInstanceOf(StatementRefusedError);
    expect(pool.stats().inUse).toBe(0);
    let t = 0;
    const late = await errorOf(() =>
      withRead(ctxFor(pool, { now: () => t, arrivedAt: 0 }), async (db) => {
        await db.rows('SELECT 1 AS one');
        t = 13_000;
        return db.rows('SELECT 2 AS two');
      }),
    );
    expect(late).toMatchObject({ code: 'JV_BUSY', reason: 'deadline' });
    expect(pool.stats().inUse).toBe(0);
  });

  it('a lost connection is JV_BUSY and the connection is destroyed, not handed on; a read sees what is committed and a held row does not block it', async () => {
    const pool = open();
    const spy = spyOn(pool);
    spy.intercept = (e) => {
      if (/FROM customers/.test(e.sql)) throw connectionLost();
    };
    const e = await errorOf(() => withRead(ctxFor(spy.pool), (db) => db.rows('SELECT id FROM customers')));
    expect(e).toMatchObject({ code: 'JV_BUSY', reason: 'connection_lost' });
    expect(pool.stats().inUse).toBe(0);
    spy.intercept = null;
    const holder = await world.scratch.connect();
    await holder.query('START TRANSACTION');
    await holder.query('SELECT id FROM customers WHERE id = ? FOR UPDATE', [world.customers[0]]);
    const t0 = Date.now();
    const rows = await withRead(ctxFor(pool), (db) => db.rows('SELECT id FROM customers WHERE id = ?', [world.customers[0]]));
    expect(rows).toHaveLength(1);
    expect(Date.now() - t0).toBeLessThan(1000);
    await holder.query('ROLLBACK');
    await holder.end();
  });
});

