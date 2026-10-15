import mysql, { type Connection, type ConnectionOptions } from 'mysql2/promise';

export const HOST = '127.0.0.1';
export const PORT = Number(process.env.JV_DB_PORT ?? 33307);
const ROOT_PASSWORD = 'spike_root_only'; // throwaway container, tmpfs, bound to 127.0.0.1 only
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

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
