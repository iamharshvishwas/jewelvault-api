// S11, NODE-DESIGN 5.2: the one pool of the running app. "The running app opens connections only through this pool" (a source check in API10 looks for any other).
//
// - at most 8 connections (Hostinger refuses a burst of NEW connections: the 21st inside about a second fails with connect EPERM; the pool of 8 opens at most 8 after a quiet spell,
//   and two processes alive together during a deploy open at most 16);
// - every checkout starts with one SET SESSION (isolation, strict sql_mode, UTC, lock wait 5 s, statement limit 8 s, wait_timeout 300, utf8mb4): the server's own values are not strict,
//   wait 50 s and cut statements at 120 s, and a user of the connection may have changed any of them since the last checkout;
// - a request waits at most 2 s for a free connection and at most 16 requests wait: mysql2's own queue has no wait limit, and a request that gave up would stay in it and later take a
//   connection for nothing, so the waiting is done here, in front of a pool that never has to queue (it is never asked for more than 8);
// - a dead idle connection is found by the checkout statement, destroyed, and another one taken (twice at most; nothing had run yet);
// - a refused new connection (connect EPERM) is tried once more after 1.1 s, then JV_BUSY. New connections go through a pacer of 10 per 1.2 s (src/db/pacer.ts), so a reconnect storm
//   after a database restart cannot spend more of the budget than a tool would;
// - idle connections go back after 60 s and at most 4 stay idle (mysql2's own reaper, once a second).
import net from 'node:net';
import mysql, { type PoolConnection, type RowDataPacket } from 'mysql2/promise';
import type { Config } from '../config.js';
import { DbBusyError } from './errors.js';
import { type Pacer, createPacer } from './pacer.js';

/** The numbers of S11 and NODE-DESIGN 5.2, in one place. */
export const POOL_LIMITS = Object.freeze({
  /** connections open at once */
  size: 8,
  /** requests that may wait for a connection */
  maxWaiting: 16,
  /** how long one may wait */
  waitMs: 2000,
  /** an idle connection is handed back after this long */
  idleTimeoutMs: 60_000,
  /** idle connections kept */
  maxIdle: 4,
  /** pause before the one retry of a refused new connection */
  refusedRetryMs: 1100,
  connectTimeoutMs: 10_000,
});

/** A dead idle connection found at checkout is replaced this many times; the next failure is JV_BUSY. */
const REPLACEMENTS = 2;

/** What every checkout sets (S11). */
export const SESSION_SETTINGS = Object.freeze({
  isolation: 'READ-COMMITTED',
  sqlMode: 'STRICT_ALL_TABLES,ERROR_FOR_DIVISION_BY_ZERO',
  timeZone: '+00:00',
  lockWaitTimeout: 5,
  maxStatementTime: 8,
  waitTimeout: 300,
  charset: 'utf8mb4',
  collation: 'utf8mb4_unicode_ci',
});

// Constants only, no user input: one statement, one round trip.
const CHECKOUT_SQL = `SET SESSION transaction_isolation = '${SESSION_SETTINGS.isolation}', sql_mode = '${SESSION_SETTINGS.sqlMode}', time_zone = '${SESSION_SETTINGS.timeZone}', innodb_lock_wait_timeout = ${SESSION_SETTINGS.lockWaitTimeout}, max_statement_time = ${SESSION_SETTINGS.maxStatementTime}, wait_timeout = ${SESSION_SETTINGS.waitTimeout}, character_set_client = '${SESSION_SETTINGS.charset}', character_set_connection = '${SESSION_SETTINGS.charset}', character_set_results = '${SESSION_SETTINGS.charset}', collation_connection = '${SESSION_SETTINGS.collation}'`;

/** A connection from the pool. release() and destroy() give the pool's place back (once, however often they are called); a connection must be released or destroyed on every path. */
export type DbConnection = PoolConnection;

export interface SessionSettings {
  isolation: string;
  sqlMode: string;
  timeZone: string;
  lockWaitTimeout: number;
  maxStatementTime: number;
  waitTimeout: number;
  charsetClient: string;
  charsetConnection: string;
  charsetResults: string;
  collationConnection: string;
}

/** The session settings as the server reports them for this connection. */
export async function readSessionSettings(conn: Pick<DbConnection, 'query'>): Promise<SessionSettings> {
  const [rows] = await conn.query<RowDataPacket[]>(
    'SELECT @@session.transaction_isolation AS isolation, @@session.sql_mode AS sql_mode, @@session.time_zone AS time_zone, @@session.innodb_lock_wait_timeout AS lock_wait, @@session.max_statement_time AS statement_time, @@session.wait_timeout AS wait_timeout, @@session.character_set_client AS charset_client, @@session.character_set_connection AS charset_connection, @@session.character_set_results AS charset_results, @@session.collation_connection AS collation_connection',
  );
  const r = rows[0];
  return {
    isolation: String(r.isolation),
    sqlMode: String(r.sql_mode),
    timeZone: String(r.time_zone),
    lockWaitTimeout: Number(r.lock_wait),
    maxStatementTime: Number(r.statement_time),
    waitTimeout: Number(r.wait_timeout),
    charsetClient: String(r.charset_client),
    charsetConnection: String(r.charset_connection),
    charsetResults: String(r.charset_results),
    collationConnection: String(r.collation_connection),
  };
}

/** Where the pool says what it did that an operator should see (the app's logger). */
export interface PoolLogger {
  warn(obj: object, msg: string): void;
}

export interface DbPoolOptions {
  /** Seams for tests; server.ts passes none of them. */
  idleTimeoutMs?: number;
  pacer?: Pacer;
  sleep?: (ms: number) => Promise<void>;
  /** Opens the TCP connection of one new database connection (default: socket.connect(port, host)). A test makes it fail with EPERM. */
  connectSocket?: (socket: net.Socket, port: number, host: string) => void;
}

export interface PoolStats {
  size: number;
  /** places taken (connections checked out, or being prepared for a request) */
  inUse: number;
  /** requests waiting for a place */
  waiting: number;
  /** connections this pool has opened since it was made */
  opened: number;
}

export interface DbPool {
  /**
   * A connection with the seven settings of S11 set. Throws DbBusyError when the pool is full for 2 s, when 16 already wait, when a new connection is refused twice or a third dead connection
   * comes up in a row; nothing has run in any of these cases. Any other error (the database is not there, access denied) comes through as it is.
   */
  checkout(): Promise<DbConnection>;
  /** Closes the pool: waiting requests are refused, every connection is ended. Safe to call twice. */
  end(): Promise<void>;
  stats(): PoolStats;
  setLogger(log: PoolLogger): void;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const defaultConnect = (socket: net.Socket, port: number, host: string) => void socket.connect(port, host);

const LOST_CODES = new Set(['PROTOCOL_CONNECTION_LOST', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT']);
const LOST_ERRNOS = new Set([1927 /* connection killed */, 1053 /* server shutdown */, 2006 /* server has gone away */, 2013 /* lost connection during query */]);

/** The connection died under the statement (the server closed it, or it was killed): the statement did not run. */
function isConnectionLost(e: unknown): boolean {
  const err = e as { fatal?: boolean; code?: string; errno?: number } | null;
  return err?.fatal === true || LOST_CODES.has(String(err?.code)) || LOST_ERRNOS.has(Number(err?.errno));
}

/** Hostinger's refusal of a burst of new connections. */
const isRefused = (e: unknown) => (e as { code?: string } | null)?.code === 'EPERM';

/** The places: at most `size` taken, a queue of waiters, each with its own timer. A waiter that gives up leaves the queue. */
class Places {
  private taken = 0;
  private closed = false;
  private readonly queue: { grant: () => void; reject: (e: Error) => void; timer: NodeJS.Timeout }[] = [];
  constructor(
    private readonly size: number,
    private readonly maxWaiting: number,
    private readonly waitMs: number,
  ) {}

  get inUse() {
    return this.taken;
  }
  get waiting() {
    return this.queue.length;
  }

  take(): Promise<void> {
    if (this.closed) return Promise.reject(new DbBusyError('closing'));
    if (this.taken < this.size) {
      this.taken++;
      return Promise.resolve();
    }
    if (this.queue.length >= this.maxWaiting) return Promise.reject(new DbBusyError('queue_full'));
    return new Promise<void>((grant, reject) => {
      const waiter = {
        grant,
        reject,
        timer: setTimeout(() => {
          this.queue.splice(this.queue.indexOf(waiter), 1);
          reject(new DbBusyError('wait_timeout'));
        }, this.waitMs),
      };
      this.queue.push(waiter);
    });
  }

  /** The place goes to the longest waiter at once; with none waiting it is free again. */
  give(): void {
    const next = this.queue.shift();
    if (next) {
      clearTimeout(next.timer);
      next.grant();
    } else if (this.taken > 0) this.taken--;
  }

  close(): void {
    this.closed = true;
    for (const w of this.queue.splice(0)) {
      clearTimeout(w.timer);
      w.reject(new DbBusyError('closing'));
    }
  }
}

export function createDbPool(db: Config['db'], options: DbPoolOptions = {}): DbPool {
  const pacer = options.pacer ?? createPacer();
  const sleep = options.sleep ?? defaultSleep;
  const connectSocket = options.connectSocket ?? defaultConnect;
  let log: PoolLogger | undefined;
  let opened = 0;
  let ending: Promise<void> | undefined;

  // Every new connection waits for the pacer and then opens its socket; mysql2 attaches its handlers to the socket at once and speaks only when the server's greeting arrives.
  const stream = () => {
    const socket = new net.Socket();
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 0);
    void pacer.wait().then(() => {
      if (socket.destroyed) return;
      try {
        connectSocket(socket, db.port, db.host);
      } catch (e) {
        socket.destroy(e as Error);
      }
    });
    return socket;
  };

  const raw = mysql.createPool({
    host: db.host,
    port: db.port,
    user: db.user,
    password: db.password,
    database: db.name,
    stream,
    connectionLimit: POOL_LIMITS.size,
    // never asked for more than `size` at a time (the places are counted first), so mysql2's own queue stays empty
    waitForConnections: true,
    queueLimit: 0,
    maxIdle: POOL_LIMITS.maxIdle,
    idleTimeout: options.idleTimeoutMs ?? POOL_LIMITS.idleTimeoutMs,
    connectTimeout: POOL_LIMITS.connectTimeoutMs,
    charset: 'UTF8MB4_UNICODE_CI',
    timezone: '+00:00',
    // money and big numbers never become JS floats: DECIMAL and BIGINT come back as text
    decimalNumbers: false,
    supportBigNumbers: true,
    bigNumberStrings: true,
    dateStrings: true,
    multipleStatements: false,
  });
  raw.on('connection', () => {
    opened++;
  });

  const places = new Places(POOL_LIMITS.size, POOL_LIMITS.maxWaiting, POOL_LIMITS.waitMs);

  /** A raw connection from mysql2; a refused new connection is tried once more after 1.1 s. */
  async function open(): Promise<PoolConnection> {
    try {
      return await raw.getConnection();
    } catch (first) {
      if (ending) throw new DbBusyError('closing', { cause: first });
      if (!isRefused(first)) throw first;
      log?.warn({ err: { code: 'EPERM', message: (first as Error).message }, retryInMs: POOL_LIMITS.refusedRetryMs }, 'a new database connection was refused (connect EPERM): trying once more; something may be opening connections outside the pool');
      await sleep(POOL_LIMITS.refusedRetryMs);
      try {
        return await raw.getConnection();
      } catch (second) {
        if (ending) throw new DbBusyError('closing', { cause: second });
        if (!isRefused(second)) throw second;
        log?.warn({ err: { code: 'EPERM', message: (second as Error).message } }, 'a new database connection was refused again (connect EPERM): answering JV_BUSY');
        throw new DbBusyError('connect_refused', { cause: second });
      }
    }
  }

  /** A connection with the session set. The statement is also the test that the connection is alive. */
  async function prepare(): Promise<PoolConnection> {
    for (let dead = 0; ; ) {
      const conn = await open();
      try {
        await conn.query(CHECKOUT_SQL);
        return conn;
      } catch (e) {
        conn.destroy(); // dead, or not set as it must be: it never goes back to the pool
        if (!isConnectionLost(e)) throw e;
        if (ending) throw new DbBusyError('closing', { cause: e });
        if (++dead > REPLACEMENTS) throw new DbBusyError('connection_lost', { cause: e });
      }
    }
  }

  return {
    async checkout() {
      await places.take();
      let conn: PoolConnection;
      try {
        conn = await prepare();
      } catch (e) {
        places.give();
        throw e;
      }
      let done = false;
      const release = conn.release.bind(conn);
      const destroy = conn.destroy.bind(conn);
      conn.release = () => {
        if (done) return;
        done = true;
        release();
        places.give();
      };
      conn.destroy = () => {
        if (done) return;
        done = true;
        destroy();
        places.give();
      };
      return conn;
    },
    end() {
      ending ??= (async () => {
        places.close();
        await raw.end();
      })();
      return ending;
    },
    stats: () => ({ size: POOL_LIMITS.size, inUse: places.inUse, waiting: places.waiting, opened }),
    setLogger(l) {
      log = l;
    },
  };
}
