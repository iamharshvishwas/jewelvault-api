import type net from 'node:net';
import type { Connection } from 'mysql2/promise';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { DbBusyError } from '../../src/db/errors';
import { POOL_LIMITS, createDbPool, readSessionSettings, type DbConnection, type DbPool } from '../../src/db/pool';
import { createLogger } from '../../src/logging';
import { type Scratch, errorOf, sleep, scratchDatabase } from '../helpers';
import { logSink } from './support';

// T-F08, the connection half: one pool of 8 (S11, S8). The lane server keeps Hostinger's NON-strict sql_mode, lock wait 50 s and no statement limit,
// so everything read back below was set by the pool at checkout, not inherited.

const EXPECTED = {
  isolation: 'READ-COMMITTED',
  sqlMode: 'STRICT_ALL_TABLES,ERROR_FOR_DIVISION_BY_ZERO',
  timeZone: '+00:00',
  lockWaitTimeout: 5,
  maxStatementTime: 8,
  waitTimeout: 300,
  charsetClient: 'utf8mb4',
  charsetConnection: 'utf8mb4',
  charsetResults: 'utf8mb4',
  collationConnection: 'utf8mb4_unicode_ci',
};

let scratch: Scratch;
let root: Connection;
const pools: DbPool[] = [];
const open = (opts: Parameters<typeof createDbPool>[1] = {}): DbPool => {
  const p = createDbPool(scratch.db, opts);
  pools.push(p);
  return p;
};

/** The session as the server reports it, asked in plain SQL (not through the pool's own reader). */
async function rawSession(c: Connection) {
  const [[r]] = await c.query<any[]>(
    'SELECT @@session.transaction_isolation AS iso, @@session.sql_mode AS sql_mode, @@session.time_zone AS tz, @@session.innodb_lock_wait_timeout AS lock_wait, @@session.max_statement_time AS stmt, @@session.wait_timeout AS wait_timeout, @@session.character_set_client AS cs_client, @@session.character_set_connection AS cs_conn, @@session.character_set_results AS cs_results, @@session.collation_connection AS coll',
  );
  return { iso: r.iso, sql_mode: r.sql_mode, tz: r.tz, lock_wait: Number(r.lock_wait), stmt: Number(r.stmt), wait_timeout: Number(r.wait_timeout), cs_client: r.cs_client, cs_conn: r.cs_conn, cs_results: r.cs_results, coll: r.coll };
}

/** Server-side count of this scratch user's open connections (what the pool really holds). */
async function openConnections(): Promise<number> {
  const [[r]] = await root.query<any[]>('SELECT COUNT(*) AS c FROM information_schema.PROCESSLIST WHERE USER = ?', [scratch.user]);
  return Number(r.c);
}
async function connectionsEver(): Promise<number> {
  const [[r]] = await root.query<any[]>("SHOW GLOBAL STATUS LIKE 'Connections'");
  return Number(r.Value);
}
async function threadExists(id: number): Promise<boolean> {
  const [[r]] = await root.query<any[]>('SELECT COUNT(*) AS c FROM information_schema.PROCESSLIST WHERE ID = ?', [id]);
  return Number(r.c) > 0;
}
async function eventually<T>(read: () => Promise<T>, ok: (v: T) => boolean, ms = 4000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const v = await read();
    if (ok(v) || Date.now() > until) return v;
    await sleep(50);
  }
}

/** Makes a pooled connection fail its next `times` statements the way a connection the server closed does (fatal, PROTOCOL_CONNECTION_LOST), while the pool still believes it is alive. */
function poison(conn: DbConnection, times = 1) {
  const core = (conn as any).connection;
  const real = core.query;
  let left = times;
  core.query = function (...args: any[]) {
    if (left > 0) {
      left--;
      const cb = args[args.length - 1];
      const e = Object.assign(new Error('Connection lost: The server closed the connection.'), { code: 'PROTOCOL_CONNECTION_LOST', fatal: true });
      process.nextTick(() => cb(e));
      return undefined;
    }
    return real.apply(this, args);
  };
}

/** A new connection the OS refuses, the way Hostinger refuses the 21st inside a second. */
function refuse(socket: net.Socket, port: number, host: string) {
  socket.destroy(Object.assign(new Error(`connect EPERM ${host}:${port} - Local (0.0.0.0:0)`), { code: 'EPERM', errno: -1, syscall: 'connect', address: host, port }));
}

beforeAll(async () => {
  scratch = await scratchDatabase('f08p', { schema: true });
  root = await scratch.root();
  await root.query(`CREATE TABLE \`${scratch.database}\`.f08_written (id INT AUTO_INCREMENT PRIMARY KEY, note VARCHAR(20) NOT NULL)`);
}, 120_000);
afterEach(async () => {
  await Promise.all(pools.splice(0).map((p) => p.end().catch(() => undefined)));
  await eventually(openConnections, (n) => n === 0); // the next test counts connections: the server must have forgotten this one's
});
afterAll(async () => {
  await root?.end();
  await scratch?.drop();
}, 60_000);

describe('T-F08 the numbers of S11 (one pool of 8, 16 may wait, 2 s, 60 s, 4 idle, 1.1 s)', () => {
  it('are the spec\'s, in one place', () => {
    expect(POOL_LIMITS).toEqual({ size: 8, maxWaiting: 16, waitMs: 2000, idleTimeoutMs: 60_000, maxIdle: 4, refusedRetryMs: 1100, connectTimeoutMs: 10_000 });
  });
});

describe('T-F08 every checkout sets the seven settings of S11 and reads them back', () => {
  it('the lane server is not strict, locks for 50 s and has no statement limit: a plain connection shows what the API must not rely on', async () => {
    const plain = await scratch.connect();
    const s = await rawSession(plain);
    expect(s.sql_mode.split(',')).not.toContain('STRICT_ALL_TABLES');
    expect(s.sql_mode.split(',')).not.toContain('STRICT_TRANS_TABLES');
    expect([s.lock_wait, s.stmt]).toEqual([50, 0]);
    expect(s.wait_timeout).not.toBe(300);
    await plain.end();
  });

  it('a checked-out connection has isolation, sql_mode, time zone, lock wait, statement limit, wait_timeout and character set of S11', async () => {
    const db = open();
    const c = await db.checkout();
    expect(await rawSession(c)).toEqual({ iso: 'READ-COMMITTED', sql_mode: EXPECTED.sqlMode, tz: '+00:00', lock_wait: 5, stmt: 8, wait_timeout: 300, cs_client: 'utf8mb4', cs_conn: 'utf8mb4', cs_results: 'utf8mb4', coll: 'utf8mb4_unicode_ci' });
    expect(await readSessionSettings(c)).toEqual(EXPECTED);
    expect(EXPECTED.sqlMode).not.toContain('NO_BACKSLASH_ESCAPES');
    c.release();
  });

  it('every checkout again, on the same connection that a user of it had spoiled: nothing carries over', async () => {
    const db = open();
    const first = await db.checkout();
    const id = first.threadId;
    await first.query("SET SESSION sql_mode = '', innodb_lock_wait_timeout = 50, max_statement_time = 0, wait_timeout = 10, time_zone = '+05:30', transaction_isolation = 'REPEATABLE-READ'");
    await first.query('SET NAMES latin1');
    expect((await rawSession(first)).sql_mode).toBe('');
    first.release();
    const second = await db.checkout();
    expect(second.threadId).toBe(id); // the same connection came back, so this is the per-checkout statement and not a fresh one
    expect(await rawSession(second)).toEqual({ iso: 'READ-COMMITTED', sql_mode: EXPECTED.sqlMode, tz: '+00:00', lock_wait: 5, stmt: 8, wait_timeout: 300, cs_client: 'utf8mb4', cs_conn: 'utf8mb4', cs_results: 'utf8mb4', coll: 'utf8mb4_unicode_ci' });
    second.release();
  });

  it('a text with a multi-byte character goes in and comes out unchanged (utf8mb4 end to end)', async () => {
    const db = open();
    const c = await db.checkout();
    const text = 'सोना चाँदी \u{1F48E}';
    const [[row]] = await c.query<any[]>('SELECT ? AS t, CHAR_LENGTH(?) AS n', [text, text]);
    expect(row.t).toBe(text);
    expect(Number(row.n)).toBe([...text].length);
    c.release();
  });
});

describe('T-F08 the same over-range amount, side by side', () => {
  const insert = (c: Connection | DbConnection) => c.query("INSERT INTO f08_amount (amount) VALUES ('1000000000000000.00')");
  const setup = (c: Connection | DbConnection) => c.query('CREATE TEMPORARY TABLE f08_amount (amount DECIMAL(14,2) NOT NULL)');

  it('on a plain connection (Hostinger\'s non-strict mode) it is clamped to the column maximum without any error', async () => {
    const plain = await scratch.connect();
    await setup(plain);
    expect(await errorOf(() => insert(plain))).toBeNull();
    const [[row]] = await plain.query<any[]>('SELECT amount FROM f08_amount');
    expect(String(row.amount)).toBe('999999999999.99');
    await plain.end();
  });

  it('on the API\'s connection it is refused with error 1264 and nothing is stored', async () => {
    const db = open();
    const c = await db.checkout();
    await setup(c);
    const e = await errorOf(() => insert(c));
    expect(e?.errno).toBe(1264);
    const [[row]] = await c.query<any[]>('SELECT COUNT(*) AS n FROM f08_amount');
    expect(Number(row.n)).toBe(0);
    c.release();
  });
});

describe('T-F08 the pool replaces a closed connection', () => {
  it('a connection the server killed is replaced without an error, whether or not the pool had noticed it yet', async () => {
    const db = open();
    const a = await db.checkout();
    const dead = a.threadId;
    a.release();
    await root.query(`KILL CONNECTION ${Number(dead)}`);
    const b = await db.checkout(); // no pause: the pool may or may not have seen the close
    expect(b.threadId).not.toBe(dead);
    expect(await readSessionSettings(b)).toEqual(EXPECTED);
    b.release();
  });

  it('a dead idle connection found by the checkout statement is destroyed and another one is checked out', async () => {
    const db = open();
    const first = await db.checkout();
    const deadId = first.threadId;
    first.release();
    poison(first); // it sits idle in the pool and looks alive; its next statement finds it dead
    const c = await db.checkout();
    expect(c.threadId).not.toBe(deadId);
    expect(await readSessionSettings(c)).toEqual(EXPECTED);
    expect(await eventually(() => threadExists(deadId), (alive) => !alive)).toBe(false); // destroyed, not left open
    expect(db.stats()).toMatchObject({ opened: 2, inUse: 1, waiting: 0 });
    c.release();
    expect(db.stats()).toMatchObject({ inUse: 0, waiting: 0 });
  });

  async function idleConnections(db: DbPool, n: number): Promise<DbConnection[]> {
    const held = await Promise.all(Array.from({ length: n }, () => db.checkout()));
    const copy = [...held];
    for (const c of held) c.release();
    return copy;
  }

  it('twice in a row: two dead idle connections are destroyed and the third, still alive, is the one handed out', async () => {
    const db = open();
    const idle = await idleConnections(db, 3);
    // the pool hands out the connection given back last first: idle[2], then idle[1], then idle[0]
    poison(idle[2]);
    poison(idle[1]);
    const c = await db.checkout();
    expect(c.threadId).toBe(idle[0].threadId);
    expect(await readSessionSettings(c)).toEqual(EXPECTED);
    expect(db.stats().opened).toBe(3); // no new connection was needed
    for (const dead of [idle[2], idle[1]]) expect(await eventually(() => threadExists(dead.threadId), (alive) => !alive)).toBe(false);
    c.release();
  });

  it('a third dead connection in a row is JV_BUSY (connection lost): the checkout gave up, nothing had run, no place is left taken', async () => {
    const db = open();
    const idle = await idleConnections(db, 3);
    for (const c of idle) poison(c);
    const ids = idle.map((c) => c.threadId);
    const e = await errorOf(() => db.checkout());
    expect(e).toBeInstanceOf(DbBusyError);
    expect(e).toMatchObject({ code: 'JV_BUSY', reason: 'connection_lost', nothingStarted: true });
    expect(db.stats()).toMatchObject({ opened: 3, inUse: 0, waiting: 0 });
    for (const id of ids) expect(await eventually(() => threadExists(id), (alive) => !alive)).toBe(false);
    const after = await db.checkout(); // and the pool is fine afterwards
    expect(await readSessionSettings(after)).toEqual(EXPECTED);
    expect(db.stats().opened).toBe(4);
    after.release();
  });

  it('an error that is not a lost connection is not hidden: it is thrown as it is, and the half-set connection is not kept', async () => {
    const db = open();
    const first = await db.checkout();
    const id = first.threadId;
    first.release();
    const core = (first as any).connection;
    const real = core.query;
    core.query = (...args: any[]) => {
      core.query = real;
      const e = Object.assign(new Error('Access denied for variable'), { code: 'ER_SPECIFIC_ACCESS_DENIED_ERROR', errno: 1227 });
      process.nextTick(() => args[args.length - 1](e));
    };
    const e = await errorOf(() => db.checkout());
    expect(e).not.toBeInstanceOf(DbBusyError);
    expect(e?.errno).toBe(1227);
    expect(db.stats().inUse).toBe(0);
    expect(await eventually(() => threadExists(id), (alive) => !alive)).toBe(false);
  });
});

describe('T-F08 a burst after a quiet spell opens at most 8 connections', () => {
  it('30 calls at once on a fresh pool: 8 run, 16 wait, 6 are JV_BUSY at once; 8 connections were opened', async () => {
    const db = open();
    const before = await connectionsEver();
    const results = await Promise.allSettled(
      Array.from({ length: 30 }, async () => {
        const c = await db.checkout();
        try {
          await c.query('SELECT SLEEP(0.1)');
        } finally {
          c.release();
        }
      }),
    );
    const opened = (await connectionsEver()) - before;
    const refused = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(24);
    expect(refused).toHaveLength(6);
    for (const r of refused) expect(r.reason).toMatchObject({ code: 'JV_BUSY', reason: 'queue_full', nothingStarted: true });
    expect(opened).toBeGreaterThanOrEqual(2); // the burst really was concurrent
    expect(opened).toBeLessThanOrEqual(8); // the server counted every new connection, ours only
    expect(db.stats()).toMatchObject({ opened, inUse: 0, waiting: 0 });
  });

  it('keeps at most 4 idle: after 8 were open at once and given back, the reaper closes the other 4 within seconds', async () => {
    const db = open();
    const held = await Promise.all(Array.from({ length: 8 }, () => db.checkout()));
    expect(await openConnections()).toBe(8);
    for (const c of held) c.release();
    expect(await eventually(openConnections, (n) => n === 4, 5000)).toBe(4);
    await sleep(1500);
    expect(await openConnections()).toBe(4); // and it stays at 4
  });

  it('hands idle connections back after the idle time (60 s by the spec; the test shortens it to 1 s)', async () => {
    const db = open({ idleTimeoutMs: 1000 });
    const held = await Promise.all(Array.from({ length: 3 }, () => db.checkout()));
    for (const c of held) c.release();
    expect(await openConnections()).toBe(3);
    expect(await eventually(openConnections, (n) => n === 0, 6000)).toBe(0);
  });
});

describe('T-F08 a refused new connection (connect EPERM) is retried once after 1.1 s, then JV_BUSY', () => {
  it('the first attempt refused, the retry works: the call succeeds, 1.1 s later, and the warning is logged', async () => {
    const sink = logSink();
    let attempts = 0;
    const db = open({ connectSocket: (socket, port, host) => (++attempts === 1 ? refuse(socket, port, host) : socket.connect(port, host)) });
    db.setLogger(createLogger('info', sink.stream));
    const t0 = Date.now();
    const c = await db.checkout();
    const took = Date.now() - t0;
    expect(attempts).toBe(2);
    expect(took).toBeGreaterThanOrEqual(1095);
    expect(took).toBeLessThan(2500);
    expect(await readSessionSettings(c)).toEqual(EXPECTED);
    c.release();
    const warned = sink.lines().filter((l) => l.level === 40);
    expect(warned).toHaveLength(1);
    expect(JSON.stringify(warned[0])).toMatch(/EPERM/);
  });

  it('refused again: JV_BUSY (connect refused) after exactly one retry, nothing had run, and the pool works once the refusals stop', async () => {
    let attempts = 0;
    let refusing = true;
    const db = open({
      connectSocket: (socket, port, host) => {
        if (!refusing) return socket.connect(port, host);
        attempts++;
        refuse(socket, port, host);
      },
    });
    const t0 = Date.now();
    const e = await errorOf(() => db.checkout());
    const took = Date.now() - t0;
    expect(e).toBeInstanceOf(DbBusyError);
    expect(e).toMatchObject({ code: 'JV_BUSY', reason: 'connect_refused', nothingStarted: true });
    expect(attempts).toBe(2); // the first try and one retry, no more
    expect(took).toBeGreaterThanOrEqual(1095);
    expect(took).toBeLessThan(2500);
    expect(db.stats()).toMatchObject({ inUse: 0, waiting: 0, opened: 0 });
    refusing = false;
    const c = await db.checkout();
    expect(await readSessionSettings(c)).toEqual(EXPECTED);
    c.release();
  });

  it('control: a database that is not there at all (connection refused by the network) is not an EPERM: no retry, the error comes through as it is', async () => {
    const db = createDbPool({ ...scratch.db, port: 1 }, {});
    pools.push(db);
    const t0 = Date.now();
    const e = await errorOf(() => db.checkout());
    expect(e).not.toBeInstanceOf(DbBusyError);
    expect(e?.code).toBe('ECONNREFUSED');
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});

describe('T-F08 a request waits at most 2 seconds for a connection and at most 16 wait', () => {
  async function holdAll(db: DbPool): Promise<DbConnection[]> {
    return Promise.all(Array.from({ length: 8 }, () => db.checkout()));
  }

  it('the 17th waiting request is JV_BUSY at once, with nothing started; the 16 waiting are served first come, first served as connections come back', async () => {
    const db = open();
    const held = await holdAll(db);
    const order: number[] = [];
    const got: DbConnection[] = [];
    const waiters = Array.from({ length: 16 }, (_, i) =>
      db.checkout().then((c) => {
        order.push(i);
        got.push(c);
      }),
    );
    expect(db.stats()).toMatchObject({ inUse: 8, waiting: 16 });
    const t0 = Date.now();
    const e = await errorOf(() => db.checkout());
    expect(Date.now() - t0).toBeLessThan(100);
    expect(e).toBeInstanceOf(DbBusyError);
    expect(e).toMatchObject({ code: 'JV_BUSY', reason: 'queue_full', nothingStarted: true });
    expect(db.stats()).toMatchObject({ inUse: 8, waiting: 16 }); // the refused one is not counted as waiting
    // give one connection back at a time and see who gets it: the one that has waited longest
    const spare = [...held];
    for (let k = 0; k < 16; k++) {
      spare.shift()!.release();
      await eventually(async () => order.length, (n) => n === k + 1);
      expect(order, `after ${k + 1} given back`).toEqual(Array.from({ length: k + 1 }, (_, i) => i));
      spare.push(got[k]);
    }
    await Promise.all(waiters);
    for (const c of spare) c.release();
    expect(db.stats()).toMatchObject({ inUse: 0, waiting: 0 });
  });

  it('the third second of waiting gives JV_BUSY in under 3 seconds and the call wrote nothing', async () => {
    const db = open();
    const held = await holdAll(db);
    const t0 = Date.now();
    const call = async () => {
      const c = await db.checkout();
      try {
        await c.execute("INSERT INTO f08_written (note) VALUES ('should not exist')");
      } finally {
        c.release();
      }
    };
    const e = await errorOf(call);
    const took = Date.now() - t0;
    expect(e).toBeInstanceOf(DbBusyError);
    expect(e).toMatchObject({ code: 'JV_BUSY', reason: 'wait_timeout', nothingStarted: true });
    expect(took).toBeGreaterThanOrEqual(1950);
    expect(took).toBeLessThan(3000);
    const [[row]] = await root.query<any[]>(`SELECT COUNT(*) AS n FROM \`${scratch.database}\`.f08_written`);
    expect(Number(row.n)).toBe(0);
    expect(db.stats()).toMatchObject({ inUse: 8, waiting: 0 }); // the timed-out request left the queue
    for (const c of held) c.release();
  });

  it('control: a request that waits less than 2 seconds gets its connection and writes', async () => {
    const db = open();
    const held = await holdAll(db);
    const call = (async () => {
      const c = await db.checkout();
      try {
        await c.execute("INSERT INTO f08_written (note) VALUES ('waited')");
      } finally {
        c.release();
      }
    })();
    await sleep(500);
    held[0].release();
    await call;
    const [[row]] = await root.query<any[]>(`SELECT COUNT(*) AS n FROM \`${scratch.database}\`.f08_written WHERE note = 'waited'`);
    expect(Number(row.n)).toBe(1);
    for (const c of held.slice(1)) c.release();
  });

  it('a request that timed out cannot take a connection later: when one comes back it goes to the next live waiter', async () => {
    const db = open();
    const held = await holdAll(db);
    const stale = errorOf(() => db.checkout());
    await sleep(1000);
    const live = db.checkout();
    expect(await stale).toBeInstanceOf(DbBusyError);
    held[0].release(); // the first connection back is for `live`, not for the request that gave up
    const c = await live;
    expect(db.stats()).toMatchObject({ inUse: 8, waiting: 0 });
    c.release();
    for (const h of held.slice(1)) h.release();
  });

  it('release is safe to call twice, and a destroyed connection frees its place too', async () => {
    const db = open();
    const held = await holdAll(db);
    held[0].release();
    held[0].release();
    expect(db.stats().inUse).toBe(7);
    const id = held[1].threadId;
    held[1].destroy();
    held[1].destroy();
    expect(db.stats().inUse).toBe(6);
    expect(await eventually(() => threadExists(id), (alive) => !alive)).toBe(false);
    const more = await Promise.all([db.checkout(), db.checkout()]);
    expect(db.stats().inUse).toBe(8);
    for (const c of [...held.slice(2), ...more]) c.release();
  });

  it('after end() nothing is handed out, and the requests that were waiting are answered JV_BUSY', async () => {
    const db = open();
    const held = await holdAll(db);
    const waiting = errorOf(() => db.checkout());
    await db.end();
    expect(await waiting).toMatchObject({ code: 'JV_BUSY', reason: 'closing' });
    expect(await errorOf(() => db.checkout())).toMatchObject({ code: 'JV_BUSY', reason: 'closing' });
    await db.end(); // twice is fine
    expect(held).toHaveLength(8);
  });
});
