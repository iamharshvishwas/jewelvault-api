import { randomBytes } from 'node:crypto';
import mysql, { type Connection, type ConnectionOptions } from 'mysql2/promise';
import { createTenBoxUser } from '../scripts/lane.mjs';
import { migrate } from '../scripts/migrate.mjs';
import { createPacer, pacedConnect } from '../scripts/pacing.mjs';

export const HOST = '127.0.0.1';
export const PORT = Number(process.env.JV_DB_PORT ?? 33307);
// The spike container's throwaway password (tmpfs, bound to 127.0.0.1 only). A lane container has its own, made up when it starts and handed in by vitest.config.ts.
const ROOT_PASSWORD = process.env.JV_DB_ROOT_PASSWORD ?? 'spike_root_only';
export const APP_USER = 'jv_app';
const APP_PASSWORD = 'spike_app_only';

/** What every application connection does first. Hostinger's global values must not be relied on. */
const SESSION_SETUP = [
  "SET SESSION transaction_isolation = 'READ-COMMITTED'",
  "SET SESSION sql_mode = 'STRICT_TRANS_TABLES,ERROR_FOR_DIVISION_BY_ZERO,NO_AUTO_CREATE_USER,NO_ENGINE_SUBSTITUTION'",
  "SET SESSION time_zone = '+05:30'",
];

const baseOptions: ConnectionOptions = {
  host: HOST,
  port: PORT,
  // Money must never become a JS float: DECIMAL and BIGINT come back as text.
  decimalNumbers: false,
  supportBigNumbers: true,
  bigNumberStrings: true,
  dateStrings: true,
  multipleStatements: false,
};

export async function rootConn(database?: string): Promise<Connection> {
  return mysql.createConnection({ ...baseOptions, user: 'root', password: ROOT_PASSWORD, database });
}

/** A fresh empty database per test file, plus the least-privilege app user (no SUPER, no global settings). */
export async function freshDb(name: string): Promise<string> {
  const db = `jv_${name}`;
  const root = await rootConn();
  await root.query(`DROP DATABASE IF EXISTS \`${db}\``);
  await root.query(`CREATE DATABASE \`${db}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  await root.query(`CREATE USER IF NOT EXISTS '${APP_USER}'@'%' IDENTIFIED BY '${APP_PASSWORD}'`);
  await root.query(`GRANT ALL PRIVILEGES ON \`${db}\`.* TO '${APP_USER}'@'%'`);
  await root.end();
  return db;
}

export async function dropDb(db: string): Promise<void> {
  const root = await rootConn();
  await root.query(`DROP DATABASE IF EXISTS \`${db}\``);
  await root.end();
}

/** An application connection (the kind the Node API will use), with the session settings applied. */
export async function appConn(database: string, extra: ConnectionOptions = {}): Promise<Connection> {
  const c = await mysql.createConnection({ ...baseOptions, ...extra, user: APP_USER, password: APP_PASSWORD, database });
  for (const sql of SESSION_SETUP) await c.query(sql);
  return c;
}

/** The selected lane's own database and its ten-box user (set by vitest.config.ts from scripts/lane.mjs when JV_LANE or the file .lane picks a lane). */
export function laneConfig() {
  const e = process.env;
  if (!e.JV_LANE || !e.JV_LANE_DATABASE || !e.JV_LANE_USER || !e.JV_LANE_PASSWORD) throw new Error('no lane is selected: set JV_LANE or write the lane name into the file .lane, then npm run db:lane -- up <lane>');
  return { lane: e.JV_LANE, host: HOST, port: PORT, database: e.JV_LANE_DATABASE, user: e.JV_LANE_USER, password: e.JV_LANE_PASSWORD };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// S11: tools and tests that open many connections pace themselves to at most 10 NEW connections in any 1.2 seconds, with the database half's own pacer (scripts/pacing.mjs).
// One pacer for the whole test process; the helpers below (the lane's root, a scratch database and its user) open their connections through it.
export const testPacer = createPacer();
export const paced = <T>(connect: () => Promise<T>): Promise<T> => pacedConnect(testPacer, connect);

/** The lane server's root connection, paced. Close it yourself. */
export const laneRoot = (): Promise<Connection> => paced(() => rootConn());

/** The connection settings of a database as the API's pool takes them (Config['db']). */
export interface DbSettings {
  host: string;
  port: number;
  name: string;
  user: string;
  password: string;
}

/** The lane's own database and its ten-box user, as the API's pool takes them. */
export function laneDbSettings(): DbSettings {
  const l = laneConfig();
  return { host: l.host, port: l.port, name: l.database, user: l.user, password: l.password };
}

/** A throw-away database on the lane server with its own ten-box user of A3 (and its own made-up password): a test may drop a table in it or grant that user more without touching the lane database. */
export interface Scratch {
  readonly database: string;
  readonly user: string;
  /** Config['db'] for createDbPool and the server. */
  readonly db: DbSettings;
  /** A paced plain connection as the scratch user (the server's own session settings, nothing of the API's). */
  connect(extra?: ConnectionOptions): Promise<Connection>;
  /** A paced root connection to the lane server. */
  root(): Promise<Connection>;
  /** Drops the database and the user (as root). Safe to call twice. */
  drop(): Promise<void>;
}

/** schema: apply db/migrations (no seeds, no triggers) as the scratch user, so the database holds every table. `lane reset` drops every jv_* database and user too, should a test die before drop(). */
export async function scratchDatabase(label: string, opts: { schema?: boolean } = {}): Promise<Scratch> {
  if (!/^[a-z0-9]{1,12}$/.test(label)) throw new Error('scratchDatabase: the label is 1 to 12 lower-case letters or digits');
  const lane = laneConfig();
  const id = `jv_${label}_${randomBytes(4).toString('hex')}`;
  const password = randomBytes(18).toString('base64url');
  const root = await laneRoot();
  try {
    await root.query(`CREATE DATABASE \`${id}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    await createTenBoxUser(root, { database: id, user: id, password });
  } finally {
    await root.end();
  }
  const scratch: Scratch = {
    database: id,
    user: id,
    db: { host: lane.host, port: lane.port, name: id, user: id, password },
    connect: (extra = {}) => paced(() => mysql.createConnection({ ...baseOptions, ...extra, host: lane.host, port: lane.port, user: id, password, database: id })),
    root: laneRoot,
    async drop() {
      const r = await laneRoot();
      try {
        await r.query(`DROP DATABASE IF EXISTS \`${id}\``);
        await r.query("DROP USER IF EXISTS ?@'%'", [id]);
      } finally {
        await r.end();
      }
    },
  };
  if (opts.schema) {
    const u = await scratch.connect();
    try {
      await migrate(u, { seeds: false, optional: false });
    } finally {
      await u.end();
    }
  }
  return scratch;
}

export interface DbError extends Error {
  code?: string;
  errno?: number;
  sqlState?: string;
}

/** Runs fn and returns the thrown database error (or null if nothing was thrown). */
export async function errorOf(fn: () => Promise<unknown>): Promise<DbError | null> {
  try {
    await fn();
    return null;
  } catch (e) {
    return e as DbError;
  }
}

export const ER = {
  LOCK_WAIT_TIMEOUT: 1205,
  DEADLOCK: 1213,
  DUP_ENTRY: 1062,
  CHECK_FAILED: 4025,
  OUT_OF_RANGE: 1264,
  DATA_TOO_LONG: 1406,
  NO_REFERENCED_ROW: 1452,
  ROW_IS_REFERENCED: 1451,
} as const;

/**
 * The transaction wrapper the API will use. Any error rolls the whole transaction back explicitly
 * (a lock-wait timeout 1205 rolls back only the failing STATEMENT in InnoDB, so the transaction is still open).
 * 1213 (deadlock) and 1205 are retried up to `retries` times with a short random pause.
 */
export async function runTx<T>(
  conn: Connection,
  body: () => Promise<T>,
  opts: { retries?: number; onRetry?: (code: number) => void } = {}
): Promise<T> {
  const retries = opts.retries ?? 0;
  for (let attempt = 0; ; attempt++) {
    await conn.query('START TRANSACTION');
    try {
      const out = await body();
      await conn.query('COMMIT');
      return out;
    } catch (e) {
      try {
        await conn.query('ROLLBACK');
      } catch {
        /* connection already gone */
      }
      const code = (e as DbError).errno ?? 0;
      if ((code === ER.DEADLOCK || code === ER.LOCK_WAIT_TIMEOUT) && attempt < retries) {
        opts.onRetry?.(code);
        await sleep(5 + Math.random() * 20);
        continue;
      }
      throw e;
    }
  }
}

/** Seeded pseudo-random numbers so a failing case can be replayed. */
export function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

/** The "LATEST DETECTED DEADLOCK" block of SHOW ENGINE INNODB STATUS (root only: needs the PROCESS privilege). */
export async function latestDeadlock(): Promise<string> {
  const root = await rootConn();
  const [rows] = await root.query<any[]>('SHOW ENGINE INNODB STATUS');
  await root.end();
  const text: string = rows[0].Status;
  const start = text.indexOf('LATEST DETECTED DEADLOCK');
  if (start < 0) return '(none)';
  const end = text.indexOf('\n----------------', start + 40);
  return text.slice(start, end > 0 ? end : start + 4000);
}
