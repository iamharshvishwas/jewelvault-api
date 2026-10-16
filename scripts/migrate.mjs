#!/usr/bin/env node
// Migration runner for JewelVault on MariaDB. Plain SQL files, applied once each, in order.
//   db/migrations/NNNN_name.sql   schema, recorded in schema_migrations with a checksum (an applied file must never change)
//   db/seeds/NNNN_name.sql        D20 seeds, safe to run again, never recorded, never overwrite what the owner changed
//   db/optional/NNNN_name.sql     triggers that need the TRIGGER privilege; only with { optional: true }
// DDL is not transactional in MariaDB (a failed file can be half applied), so every migration file is written to be re-runnable.
// A file is run statement by statement (splitStatements), so an ordinary connection is enough: the restore tool and the API's start-up check use the same runner.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'db');
const FILE = /^(\d{4})_([a-z0-9_]+)\.sql$/;
const STRICT = "SET SESSION sql_mode = 'STRICT_TRANS_TABLES,ERROR_FOR_DIVISION_BY_ZERO,NO_AUTO_CREATE_USER,NO_ENGINE_SUBSTITUTION'";

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

// ------------------------------------------------------------------ what a migration may hold (spec S9, T-F04)
// The one database user has Delete and Drop unticked (S7) and, because nothing uses them, Create view, Show view, Execute, Create routine, Alter routine and Event too (A3).
// So a migration is CREATE-ONLY: no DROP, no RENAME, no OR REPLACE, no view, no routine, no event. MariaDB refuses most of these with error 1142 anyway; the runner refuses them
// first, and also two that the database would allow but that destroy or hide data (DROP COLUMN, RENAME COLUMN). Every file is read before anything runs.

/** The statements of a file, comments removed, white space folded, split on ; outside quotes. */
export function splitStatements(sql) {
  const out = [];
  let cur = '';
  const n = sql.length;
  const push = () => {
    const t = cur.trim();
    if (t) out.push(t);
    cur = '';
  };
  for (let i = 0; i < n; ) {
    const ch = sql[i];
    const nx = sql[i + 1];
    if ((ch === '-' && nx === '-' && /\s|^$/.test(sql[i + 2] ?? ' ')) || ch === '#') {
      while (i < n && sql[i] !== '\n') i++;
      cur += ' ';
      continue;
    }
    if (ch === '/' && nx === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end < 0 ? n : end + 2;
      cur += ' ';
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === '\\' && ch !== '`') j += 2;
        else if (sql[j] === ch && sql[j + 1] === ch) j += 2;
        else if (sql[j] === ch) break;
        else j++;
      }
      cur += sql.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (ch === ';') {
      push();
      i++;
      continue;
    }
    if (/\s/.test(ch)) {
      if (!cur.endsWith(' ')) cur += ' ';
      i++;
      continue;
    }
    cur += ch;
    i++;
  }
  push();
  return out;
}

/** The clauses of an ALTER TABLE, split on commas outside brackets and quotes. */
function alterClauses(rest) {
  const clauses = [];
  let depth = 0;
  let cur = '';
  for (let i = 0; i < rest.length; i++) {
    const ch = rest[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      let j = i + 1;
      while (j < rest.length && !(rest[j] === ch && rest[j + 1] !== ch)) j += rest[j] === ch ? 2 : 1;
      cur += rest.slice(i, j + 1);
      i = j;
    } else if (ch === '(') {
      depth++;
      cur += ch;
    } else if (ch === ')') {
      depth--;
      cur += ch;
    } else if (ch === ',' && depth === 0) {
      clauses.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) clauses.push(cur.trim());
  return clauses;
}

function classify(statement, kind) {
  const u = statement.toUpperCase();
  const allowed = 'the allowed list of S9';
  if (kind === 'trigger') {
    if (/^DROP TRIGGER IF EXISTS \S+$/.test(u)) return null;
    if (/^DROP TRIGGER\b/.test(u)) return 'DROP TRIGGER without IF EXISTS is refused: every file must be re-runnable (S9, RF5-13)';
    if (/^CREATE OR REPLACE\b/.test(u)) return 'OR REPLACE is refused: use DROP TRIGGER IF EXISTS and then CREATE TRIGGER IF NOT EXISTS';
    if (/^CREATE TRIGGER IF NOT EXISTS \S+ (BEFORE|AFTER) /.test(u)) return null;
    if (/^CREATE TRIGGER\b/.test(u)) return 'CREATE TRIGGER without IF NOT EXISTS is refused: every file must be re-runnable (S9, RF5-13)';
    return `not in ${allowed}: a trigger file holds DROP TRIGGER IF EXISTS and CREATE TRIGGER IF NOT EXISTS only`;
  }
  if (/^DROP TRIGGER\b/.test(u) || /^CREATE (OR REPLACE )?(DEFINER\s*=\s*\S+ )?TRIGGER\b/.test(u)) return 'triggers belong in trigger files (db/optional) only (O50)';
  if (/^DROP\b/.test(u)) return 'DROP is refused: the database user has no Drop right (S7), and a migration only creates';
  if (/^RENAME\b/.test(u)) return 'RENAME is refused: needs the Drop right (S7), and a rename hides data from older code';
  if (/^TRUNCATE\b/.test(u)) return 'TRUNCATE is refused: needs the Drop right (S7)';
  if (/^DELETE\b/.test(u)) return 'DELETE is refused: nothing is ever deleted (S7)';
  if (/^REPLACE\b/.test(u)) return 'REPLACE is refused: it deletes the old row (S7)';
  if (/^UPDATE\b/.test(u)) return `UPDATE is not in ${allowed}: a migration changes the schema; data is written by the API`;
  if (/^CREATE OR REPLACE\b/.test(u)) return 'OR REPLACE is refused: it drops the old object, and the user has no Drop right (S7)';
  if (/^(CREATE|ALTER)\b.*\bVIEW\b/.test(u.split(' AS ')[0])) return 'a VIEW is refused: it can be created once and never changed or dropped without the Drop right, and Create view is unticked (section 11, A3)';
  if (/^CREATE TABLE IF NOT EXISTS\b/.test(u)) return null;
  if (/^CREATE TABLE\b/.test(u)) return 'CREATE TABLE without IF NOT EXISTS is refused: every file must be re-runnable on a half-applied database (S9, RF5-13)';
  if (/^CREATE (UNIQUE |FULLTEXT |SPATIAL )?INDEX IF NOT EXISTS\b/.test(u)) return null;
  if (/^CREATE (UNIQUE |FULLTEXT |SPATIAL )?INDEX\b/.test(u)) return 'CREATE INDEX without IF NOT EXISTS is refused: every file must be re-runnable on a half-applied database (S9, RF5-13)';
  if (/^ANALYZE TABLE\b/.test(u)) return null;
  if (/^INSERT IGNORE\b/.test(u)) return null;
  if (/^INSERT\b/.test(u) && /\bON DUPLICATE KEY UPDATE\b/.test(u)) return null;
  if (/^INSERT\b/.test(u)) return `INSERT is not in ${allowed} unless it is INSERT IGNORE or has ON DUPLICATE KEY UPDATE (a file must be safe to run again)`;
  const alter = /^ALTER TABLE (`(?:[^`]|``)*`|\S+) (.*)$/s.exec(statement.replace(/^alter table/i, 'ALTER TABLE'));
  if (alter) {
    for (const clause of alterClauses(alter[2])) {
      const c = clause.toUpperCase();
      if (/^RENAME\b/.test(c)) return 'RENAME is refused (RENAME TO, RENAME COLUMN): it hides data from older code and needs the Drop right (S7)';
      if (/^DROP COLUMN\b/.test(c)) return 'DROP COLUMN is refused: it destroys data; a column that is no longer wanted stays, unused, with a comment in the file';
      if (/^DROP PRIMARY KEY\b/.test(c)) return 'DROP PRIMARY KEY is refused';
      if (/^CHANGE\b/.test(c)) return 'CHANGE COLUMN is refused: it renames; use MODIFY COLUMN to widen or relax';
      if (/^ADD PRIMARY KEY\b/.test(c)) return 'ADD PRIMARY KEY is refused';
      if (/^MODIFY\b/.test(c)) continue; // only to widen or relax, never to narrow (a rule of the review, not of this check)
      // ADD ...: the re-runnable form of each allowed clause (S9, RF5-13)
      if (/^ADD CONSTRAINT IF NOT EXISTS \S+ FOREIGN KEY\b/.test(c)) return 'ADD CONSTRAINT IF NOT EXISTS ... FOREIGN KEY is a syntax error in MariaDB (1064): write ADD FOREIGN KEY IF NOT EXISTS name (...) REFERENCES ...';
      if (/^ADD CONSTRAINT \S+ FOREIGN KEY\b/.test(c)) return 'ADD CONSTRAINT ... FOREIGN KEY without IF NOT EXISTS is refused: write ADD FOREIGN KEY IF NOT EXISTS name (...) REFERENCES ... (S9, RF5-13)';
      if (/^ADD FOREIGN KEY IF NOT EXISTS\b/.test(c)) continue;
      if (/^ADD FOREIGN KEY\b/.test(c)) return 'ADD FOREIGN KEY without IF NOT EXISTS is refused: every file must be re-runnable (S9, RF5-13)';
      if (/^ADD CONSTRAINT IF NOT EXISTS \S+ CHECK\b/.test(c)) continue;
      if (/^ADD (CONSTRAINT \S+ )?CHECK\b/.test(c)) return 'a CHECK must be added as ADD CONSTRAINT IF NOT EXISTS name CHECK (...): every file must be re-runnable (S9, RF5-13)';
      if (/^ADD (UNIQUE( KEY| INDEX)?|INDEX|KEY) IF NOT EXISTS\b/.test(c)) continue;
      if (/^ADD (UNIQUE|INDEX|KEY)\b/.test(c)) return 'ADD INDEX / ADD UNIQUE without IF NOT EXISTS is refused: every file must be re-runnable (S9, RF5-13)';
      if (/^ADD COLUMN IF NOT EXISTS\b/.test(c)) continue;
      if (/^ADD\b/.test(c)) return 'ADD COLUMN without IF NOT EXISTS is refused: every file must be re-runnable (S9, RF5-13)';
      if (/^DROP (CONSTRAINT|FOREIGN KEY|INDEX|KEY) IF EXISTS\b/.test(c)) continue;
      if (/^DROP (CONSTRAINT|FOREIGN KEY|INDEX|KEY)\b/.test(c)) return 'DROP CONSTRAINT / FOREIGN KEY / INDEX without IF EXISTS is refused: every file must be re-runnable (S9, RF5-13)';
      if (/^DROP\b/.test(c)) return 'DROP COLUMN is refused: it destroys data (a bare DROP in ALTER TABLE drops a column)';
      return `ALTER TABLE clause ${JSON.stringify(clause.slice(0, 40))} is not in ${allowed}`;
    }
    return null;
  }
  return `not in ${allowed}`;
}

/** What is wrong with a file, as [{ statement, reason }]; empty means it is fine. kind: 'migration', 'seed' or 'trigger' (db/optional). */
export function checkSql(sql, kind) {
  const found = [];
  if (/\/\*[!M]/.test(sql)) found.push({ statement: '/*! ... */', reason: 'executable comments (/*! and /*M!) are refused: the server runs what is inside' });
  for (const statement of splitStatements(sql)) {
    const reason = classify(statement, kind);
    if (reason) found.push({ statement: statement.slice(0, 200), reason });
  }
  return found;
}

async function runFile(conn, sql) {
  for (const statement of splitStatements(sql)) await conn.query(statement);
}

function assertAllowed(files, kind, label) {
  for (const f of files) {
    const v = checkSql(f.sql, kind);
    if (v.length) throw new Error(`${label}/${f.version}_${f.name}.sql: statement refused by S9: ${v[0].reason}: ${v[0].statement}`);
  }
}

function listDir(dir) {
  return readdirSync(dir)
    .filter((f) => FILE.test(f))
    .sort()
    .map((f) => {
      const [, version, name] = FILE.exec(f);
      const sql = readFileSync(join(dir, f), 'utf8');
      return { version, name, sql, checksum: sha256(sql) };
    });
}

export const listMigrations = (dir = join(ROOT, 'migrations')) => listDir(dir);

export async function migrate(conn, { dir, seeds = true, optional = false } = {}) {
  // read and check every file before anything runs: a bad second file must not leave the first one applied
  const migrations = listMigrations(dir);
  assertAllowed(migrations, 'migration', 'migrations');
  const seedFiles = seeds ? listDir(join(ROOT, 'seeds')) : [];
  assertAllowed(seedFiles, 'seed', 'seeds');
  const optionalFiles = optional ? listDir(join(ROOT, 'optional')) : [];
  assertAllowed(optionalFiles, 'trigger', 'optional');
  await conn.query(STRICT);
  await conn.query("SET SESSION time_zone = '+00:00'");
  await conn.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version VARCHAR(10) NOT NULL,
    name VARCHAR(100) NOT NULL,
    checksum CHAR(64) NOT NULL,
    applied_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    PRIMARY KEY (version)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  const [done] = await conn.query('SELECT version, checksum FROM schema_migrations');
  const known = new Map(done.map((r) => [r.version, r.checksum]));
  const applied = [];
  const skipped = [];
  for (const m of migrations) {
    if (known.has(m.version)) {
      if (known.get(m.version) !== m.checksum) {
        throw new Error(`Migration ${m.version}_${m.name}: checksum differs from the one applied. An applied migration must not be edited; add a new one.`);
      }
      skipped.push(m.version);
      continue;
    }
    await runFile(conn, m.sql);
    await conn.query('INSERT INTO schema_migrations (version, name, checksum) VALUES (?, ?, ?)', [m.version, m.name, m.checksum]);
    applied.push(m.version);
  }
  for (const s of seedFiles) await runFile(conn, s.sql);
  for (const s of optionalFiles) await runFile(conn, s.sql);
  return { applied, skipped };
}

const HEADER = `-- JewelVault schema for MariaDB 11.8. GENERATED by scripts/build-schema.mjs from db/migrations; do not edit by hand.
-- Paste into phpMyAdmin (SQL tab) of an EMPTY database. Re-running it is safe. The migration runner (npm run db:migrate) is the normal way.
SET SESSION sql_mode = 'STRICT_TRANS_TABLES,ERROR_FOR_DIVISION_BY_ZERO,NO_AUTO_CREATE_USER,NO_ENGINE_SUBSTITUTION';
SET SESSION time_zone = '+00:00';
`;

function joined(files, title) {
  return HEADER.replace('schema for', title + ' for') + files.map((f) => `\n-- ==== ${f.version}_${f.name} ====\n${f.sql.trimEnd()}\n`).join('');
}

export const buildSchemaSql = () => joined(listMigrations(), 'schema');
export const buildSeedSql = () => joined(listDir(join(ROOT, 'seeds')), 'seed data').replace('GENERATED by scripts/build-schema.mjs from db/migrations', 'GENERATED by scripts/build-schema.mjs from db/seeds');

// command line: DB_HOST DB_PORT DB_NAME DB_USER and DB_PASSWORD come from the environment (a password is never an argument)
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { default: mysql } = await import('mysql2/promise');
  const flag = (n) => process.argv.includes(n);
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST ?? '127.0.0.1',
    port: Number(process.env.DB_PORT ?? 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    multipleStatements: true,
  });
  try {
    const r = await migrate(conn, { seeds: !flag('--no-seeds'), optional: flag('--optional') });
    console.log(`applied: ${r.applied.join(', ') || 'none'}; already applied: ${r.skipped.length}`);
  } finally {
    await conn.end();
  }
}
