// S11: the start-up check. It runs before the API accepts a request and on every start after an idle stop (H7), so it is a handful of statements on one connection from the pool:
//   - the server is MariaDB 11.x;
//   - the isolation level is READ-COMMITTED (the server's own default, which a fresh connection gets, and the session after the checkout set it);
//   - the session settings of S11 can be set (the checkout's SET SESSION is read back), and the character set is utf8mb4 (the connection, and every table the code needs);
//   - every table the code needs exists;
//   - the user's grants are read with SHOW GRANTS and reported: a Delete or Drop right that is on does not stop the API but turns the owner's dashboard line amber (I12),
//     and any right outside the ten boxes of A3 is noted in the log.
// Any other failure keeps the API up and it answers 503 JV_UNAVAILABLE to everything except /healthz (src/app.ts); the reasons are in the result and go to the log only.
// The check does not run migrations: they reach the database by the runner from Harsh's Mac or by a paste into phpMyAdmin (O49), never from the running app.
import type { RowDataPacket } from 'mysql2/promise';
import { type DbConnection, type DbPool, SESSION_SETTINGS, readSessionSettings } from './db/pool.js';
import { REQUIRED_TABLES } from './db/tables.js';

/** The ten ticked boxes of hPanel's Change Permissions (A3). */
export const TEN_BOXES: readonly string[] = ['SELECT', 'INSERT', 'UPDATE', 'CREATE', 'ALTER', 'INDEX', 'REFERENCES', 'TRIGGER', 'CREATE TEMPORARY TABLES', 'LOCK TABLES'];
/** The 18 boxes of hPanel (A3): what ALL PRIVILEGES on a database stands for. */
const ALL_BOXES: readonly string[] = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'CREATE', 'DROP', 'REFERENCES', 'INDEX', 'ALTER', 'CREATE TEMPORARY TABLES', 'LOCK TABLES', 'EXECUTE', 'CREATE VIEW', 'SHOW VIEW', 'CREATE ROUTINE', 'ALTER ROUTINE', 'EVENT', 'TRIGGER'];

export type CheckName = 'connect' | 'version' | 'isolation' | 'session' | 'charset' | 'tables' | 'grants';
/** The checks in the order of S11 (problems are listed in this order). */
const CHECK_ORDER: readonly CheckName[] = ['connect', 'version', 'isolation', 'session', 'charset', 'tables', 'grants'];

export interface Problem {
  check: CheckName;
  /** Why, for the log. Never sent to a client. */
  detail: string;
}

export interface Rights {
  delete: boolean;
  drop: boolean;
  /** Rights outside the ten boxes besides Delete and Drop (sorted), 'GRANT OPTION' included. */
  extra: string[];
  /** Every right held on this database, global ones included (sorted, USAGE left out). */
  held: string[];
  grantOption: boolean;
}

export interface PreflightResult {
  /** false: the API answers 503 JV_UNAVAILABLE to everything except /healthz. */
  ok: boolean;
  problems: Problem[];
  version: string | null;
  /** null when the grants could not be read. */
  rights: Rights | null;
  /** A Delete or Drop right is on: the owner's dashboard line is amber (I12). */
  amber: boolean;
  /** Every right held outside the ten boxes, Delete and Drop included (sorted), for the log. */
  outsideTenBoxes: string[];
}

const describe = (e: unknown): string => {
  const err = e as { code?: string; message?: string } | null;
  return [err?.code, err?.message ?? String(e)].filter(Boolean).join(' ');
};

// ------------------------------------------------------------------ SHOW GRANTS

const escapeRegExp = (c: string) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The database part of a GRANT, as MariaDB writes it: `db`.* (an unescaped _ is any one character, % any run, a backslash makes either literal). */
function scopeMatches(pattern: string, database: string): boolean {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '\\' && i + 1 < pattern.length) re += escapeRegExp(pattern[++i]);
    else if (ch === '_') re += '.';
    else if (ch === '%') re += '.*';
    else re += escapeRegExp(ch);
  }
  return new RegExp(`^${re}$`, 'i').test(database);
}

/**
 * What the user may do on `database`, from the lines of SHOW GRANTS FOR CURRENT_USER(). A grant on another database does not count; a global one, a name pattern that covers this database and
 * a table or column grant on it do. The lines are not kept or logged (a line can hold the password hash after IDENTIFIED BY).
 */
export function parseGrants(lines: readonly string[], database: string): Rights {
  const held = new Set<string>();
  let grantOption = false;
  for (const line of lines) {
    const m = /^GRANT (.+?) ON (.+?) TO /.exec(line);
    if (!m) continue; // a role grant or a proxy grant: no privileges listed
    const [, privs, scope] = m;
    const dbPart = scope.split(/\.(?=[^.]*$)/)[0]; // everything before the table part
    const name = dbPart.replace(/^`|`$/g, '').replace(/``/g, '`');
    if (name !== '*' && !scopeMatches(name, database)) continue;
    for (const raw of privs.replace(/\([^)]*\)/g, '').split(',')) {
      const p = raw.trim().toUpperCase();
      if (!p || p === 'USAGE') continue;
      if (p === 'ALL PRIVILEGES' || p === 'ALL') for (const b of ALL_BOXES) held.add(b);
      else held.add(p);
    }
    if (/\bWITH GRANT OPTION\s*$/i.test(line)) grantOption = true;
  }
  if (grantOption) held.add('GRANT OPTION');
  const sorted = [...held].sort();
  return {
    delete: held.has('DELETE'),
    drop: held.has('DROP'),
    extra: sorted.filter((p) => !TEN_BOXES.includes(p) && p !== 'DELETE' && p !== 'DROP'),
    held: sorted,
    grantOption,
  };
}

// ------------------------------------------------------------------ the check

/** MariaDB 11.x: the version text starts with 11 and says MariaDB (VERSION() or the version comment). */
const isMariaDb11 = (version: string, comment: string) => /^11\.\d+\.\d+/.test(version) && /mariadb/i.test(`${version} ${comment}`);

/** Runs the check on one connection from the pool and gives it back. Never throws: whatever goes wrong is a problem in the result. */
export async function runPreflight(db: Pick<DbPool, 'checkout'>): Promise<PreflightResult> {
  const problems: Problem[] = [];
  const result: PreflightResult = { ok: false, problems, version: null, rights: null, amber: false, outsideTenBoxes: [] };
  const step = async (check: CheckName, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (e) {
      problems.push({ check, detail: `could not be checked: ${describe(e)}` });
    }
  };

  let conn: DbConnection;
  try {
    conn = await db.checkout();
  } catch (e) {
    problems.push({ check: 'connect', detail: describe(e) });
    return result;
  }
  try {
    let database: string | null = null;

    await step('version', async () => {
      const [rows] = await conn.query<RowDataPacket[]>('SELECT VERSION() AS version, @@version_comment AS version_comment, @@global.transaction_isolation AS global_isolation, DATABASE() AS db');
      const r = rows[0];
      result.version = String(r.version);
      database = r.db === null ? null : String(r.db);
      if (!isMariaDb11(String(r.version), String(r.version_comment))) problems.push({ check: 'version', detail: `the server is ${r.version} (${r.version_comment}), not MariaDB 11.x` });
      if (String(r.global_isolation) !== SESSION_SETTINGS.isolation) problems.push({ check: 'isolation', detail: `the server's own isolation level is ${r.global_isolation}, not ${SESSION_SETTINGS.isolation}` });
    });

    await step('session', async () => {
      const s = await readSessionSettings(conn);
      const wrong: string[] = [];
      const want = (name: string, got: string | number, wanted: string | number) => {
        if (got !== wanted) wrong.push(`${name} reads ${got}, wanted ${wanted}`);
      };
      want('transaction_isolation', s.isolation, SESSION_SETTINGS.isolation);
      want('sql_mode', s.sqlMode, SESSION_SETTINGS.sqlMode);
      want('time_zone', s.timeZone, SESSION_SETTINGS.timeZone);
      want('innodb_lock_wait_timeout', s.lockWaitTimeout, SESSION_SETTINGS.lockWaitTimeout);
      want('max_statement_time', s.maxStatementTime, SESSION_SETTINGS.maxStatementTime);
      want('wait_timeout', s.waitTimeout, SESSION_SETTINGS.waitTimeout);
      if (wrong.length) problems.push({ check: 'session', detail: `a session setting cannot be set: ${wrong.join('; ')}` });
      const sets = [s.charsetClient, s.charsetConnection, s.charsetResults];
      if (sets.some((c) => c !== SESSION_SETTINGS.charset) || !s.collationConnection.startsWith(`${SESSION_SETTINGS.charset}_`)) {
        problems.push({ check: 'charset', detail: `the connection's character set is ${sets.join('/')} (${s.collationConnection}), not ${SESSION_SETTINGS.charset}` });
      }
    });

    await step('tables', async () => {
      if (database === null) {
        problems.push({ check: 'tables', detail: 'no database is selected' });
        return;
      }
      const [rows] = await conn.query<RowDataPacket[]>("SELECT TABLE_NAME AS name, TABLE_COLLATION AS collation FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE'");
      const found = new Map(rows.map((r) => [String(r.name), String(r.collation ?? '')]));
      const missing = REQUIRED_TABLES.filter((t) => !found.has(t));
      if (missing.length) problems.push({ check: 'tables', detail: `missing: ${missing.join(', ')}` });
      const wrongSet = REQUIRED_TABLES.filter((t) => found.has(t) && !found.get(t)!.startsWith(`${SESSION_SETTINGS.charset}_`));
      if (wrongSet.length) problems.push({ check: 'charset', detail: `not utf8mb4: ${wrongSet.map((t) => `${t} (${found.get(t) || 'no collation'})`).join(', ')}` });
    });

    await step('grants', async () => {
      const [rows] = await conn.query<RowDataPacket[]>('SHOW GRANTS FOR CURRENT_USER()');
      if (database === null) throw new Error('no database is selected');
      const rights = parseGrants(rows.map((r) => String(Object.values(r)[0])), database);
      result.rights = rights;
      result.amber = rights.delete || rights.drop;
      result.outsideTenBoxes = [...(rights.delete ? ['DELETE'] : []), ...(rights.drop ? ['DROP'] : []), ...rights.extra].sort();
    });
  } finally {
    conn.release();
  }
  problems.sort((a, b) => CHECK_ORDER.indexOf(a.check) - CHECK_ORDER.indexOf(b.check));
  result.ok = problems.length === 0;
  return result;
}
