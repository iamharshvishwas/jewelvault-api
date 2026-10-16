// L1 (a): the generated audit triggers. Every insert and update on the audited tables writes EXACTLY ONE audit_log row in the same transaction as the change, with
//   actor       @jv_actor    the session user's id (a UUID), set by the transaction wrapper at the start of each transaction and cleared at the end (the variable lives on
//                            the pooled connection and survives a commit); NULL for the import, a job or a hand edit
//   actor_role  @jv_role     the role, or `import`, `admin-cli`, `job`; with no variable set (a change typed by hand in phpMyAdmin) the role is `sql`
//   request_id  @jv_request  the request that made the change
// and the old and the new row as JSON. An update that changes nothing but updated_at writes nothing (D23), and neither does one that changes only an excluded column (a password
// change is an `event` row written by the API, D16, not a second row here). Columns on the exclude list (db/optional/audit-exclude.json, one file, per table) are never copied.
// "Never both" (L1): a database with these triggers must not also have the API or the import write the same rows.
//
// The triggers are generated from the database's own catalogue (columns, types, primary keys) so that they cannot drift from the migrations: scripts/build-audit-triggers.mjs
// writes db/optional/0910_audit_triggers.sql and a test fails when the file is out of date.
//
// Values in old_row/new_row: integers up to 32 bits as numbers, BIGINT and DECIMAL as text (money is text, S3), JSON columns as JSON, everything else as the server prints it.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const AUDITED_TABLES = ['users', 'settings', 'daily_rates', 'categories', 'subcategories', 'designs', 'skus', 'sku_private', 'customers', 'bills', 'bill_items', 'receipts', 'receipt_allocations'];
export const EXCLUDE_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'db', 'optional', 'audit-exclude.json');
export const TRIGGER_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'db', 'optional', '0910_audit_triggers.sql');
/** A column with a name like this on an audited table must be on the exclude list or the generator refuses: nobody decides by accident that a secret goes into the log. */
export const SECRET_NAME = /hash|secret|token|salt|digest|passwd|^password$|^otp|^pin$/i; // must_change_password is a flag, not a secret

const q = (id) => '`' + String(id).replace(/`/g, '``') + '`';
const NUMBER_TYPES = new Set(['tinyint', 'smallint', 'mediumint', 'int']);
const TEXT_AS_CHAR = new Set(['bigint', 'decimal']);
const NATIVE = new Set(['uuid', 'char', 'varchar', 'text', 'tinytext', 'mediumtext', 'longtext', 'enum', 'date', 'datetime', 'timestamp', 'time', 'year']);

export function loadExcludeList(file = EXCLUDE_FILE) {
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  const out = {};
  for (const [table, cols] of Object.entries(raw)) {
    if (table.startsWith('_')) continue; // _about and other notes
    if (!Array.isArray(cols) || cols.some((c) => typeof c !== 'string')) throw new Error(`audit-exclude.json: ${table} must be a list of column names`);
    out[table] = cols;
  }
  return out;
}

/** The catalogue facts the triggers are built from, for each audited table: columns in order (name, type, whether it holds JSON), and the primary key. */
export async function readAuditShape(conn, tables = AUDITED_TABLES) {
  const shape = {};
  for (const table of tables) {
    const [cols] = await conn.query(
      "SELECT COLUMN_NAME AS name, DATA_TYPE AS type, GENERATION_EXPRESSION AS generated FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION",
      [table]
    );
    if (cols.length === 0) throw new Error(`audit triggers: table ${table} does not exist in this database (run the migrations first)`);
    const [pk] = await conn.query(
      "SELECT COLUMN_NAME AS name FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND CONSTRAINT_NAME = 'PRIMARY' ORDER BY ORDINAL_POSITION",
      [table]
    );
    const [checks] = await conn.query('SELECT CHECK_CLAUSE AS clause FROM information_schema.CHECK_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = ?', [table]);
    const json = new Set();
    for (const { clause } of checks) for (const m of String(clause).matchAll(/json_valid\(`([^`]+)`\)/gi)) json.add(m[1]);
    shape[table] = {
      columns: cols.filter((c) => !c.generated).map((c) => ({ name: c.name, type: String(c.type).toLowerCase(), json: json.has(c.name) })),
      primary_key: pk.map((p) => p.name),
    };
  }
  return shape;
}

function valueExpr(side, col) {
  const ref = `${side}.${q(col.name)}`;
  if (col.json) return `JSON_EXTRACT(${ref}, '$')`;
  if (NUMBER_TYPES.has(col.type) || NATIVE.has(col.type)) return ref;
  if (TEXT_AS_CHAR.has(col.type)) return `CAST(${ref} AS CHAR)`;
  throw new Error(`audit triggers: column ${col.name} has the type ${col.type}, which the generator does not know how to put into JSON (put it on the exclude list or teach the generator)`);
}

const rowJson = (side, columns) => `JSON_OBJECT(${columns.map((c) => `'${c.name.replace(/'/g, "''")}', ${valueExpr(side, c)}`).join(', ')})`;
const ACTOR = "@jv_actor, COALESCE(@jv_role, 'sql'), @jv_request";
const INSERT_HEAD = 'INSERT INTO audit_log (actor, actor_role, request_id, table_name, row_id, action, old_row, new_row)';

/** The text of db/optional/0910_audit_triggers.sql for this shape and exclude list. */
export function buildAuditTriggersSql(shape, exclude, tables = AUDITED_TABLES) {
  const out = [
    '-- GENERATED by scripts/build-audit-triggers.mjs from the migrations and db/optional/audit-exclude.json. Do not edit by hand: run the script and commit the result.',
    '-- A test (tests/schema/s20-audit-triggers.test.ts) fails when this file is out of date with the migrations.',
    '-- OPTIONAL, L1 (a): needs the TRIGGER privilege (Hostinger: the "Trigger" tick box). A database with these triggers must NOT also have the API write the same audit rows (never both, L1).',
    '-- The transaction wrapper sets @jv_actor (UUID), @jv_role and @jv_request at the start of each transaction and clears them at the end; with none set the row has no actor and the role sql.',
    '-- One AFTER INSERT and one AFTER UPDATE trigger per table. An update that changes only updated_at, or only an excluded column, writes nothing (D23, D16).',
    '-- Re-applying this file replaces the triggers (DROP TRIGGER IF EXISTS, then CREATE TRIGGER IF NOT EXISTS); apply it when the shop is closed: for a moment there is no trigger.',
    '',
  ];
  for (const table of tables) {
    const t = shape[table];
    if (!t) throw new Error(`audit triggers: no shape for ${table}`);
    const excluded = new Set(exclude[table] ?? []);
    for (const name of excluded) if (!t.columns.some((c) => c.name === name)) throw new Error(`audit-exclude.json: ${table} has no column ${name}`);
    for (const c of t.columns) {
      if (SECRET_NAME.test(c.name) && !excluded.has(c.name)) throw new Error(`audit triggers: ${table}.${c.name} looks like a secret and is not on the exclude list (db/optional/audit-exclude.json)`);
    }
    if (t.primary_key.length === 0) throw new Error(`audit triggers: ${table} has no primary key`);
    const copied = t.columns.filter((c) => !excluded.has(c.name));
    const rowId = (side) => (t.primary_key.length === 1 ? `CAST(${side}.${q(t.primary_key[0])} AS CHAR)` : `CONCAT_WS(':', ${t.primary_key.map((k) => `${side}.${q(k)}`).join(', ')})`);
    const compared = copied.filter((c) => c.name !== 'updated_at');
    const same = compared.map((c) => `OLD.${q(c.name)} <=> NEW.${q(c.name)}`).join(' AND ');
    const ai = `trg_audit_${table}_ai`;
    const au = `trg_audit_${table}_au`;
    out.push(`DROP TRIGGER IF EXISTS ${ai};`);
    out.push(`CREATE TRIGGER IF NOT EXISTS ${ai} AFTER INSERT ON ${q(table)} FOR EACH ROW ${INSERT_HEAD} VALUES (${ACTOR}, '${table}', ${rowId('NEW')}, 'insert', NULL, ${rowJson('NEW', copied)});`);
    out.push(`DROP TRIGGER IF EXISTS ${au};`);
    out.push(
      `CREATE TRIGGER IF NOT EXISTS ${au} AFTER UPDATE ON ${q(table)} FOR EACH ROW ${INSERT_HEAD} SELECT ${ACTOR}, '${table}', ${rowId('NEW')}, 'update', ${rowJson('OLD', copied)}, ${rowJson('NEW', copied)} FROM DUAL WHERE NOT (${same});`
    );
    out.push('');
  }
  return out.join('\n');
}

/** Reads the shape from a migrated database and builds the file text. */
export async function generateAuditTriggersSql(conn, { exclude = loadExcludeList(), tables = AUDITED_TABLES } = {}) {
  return buildAuditTriggersSql(await readAuditShape(conn, tables), exclude, tables);
}

/** The names of the generated audit triggers that exist in the connected database (not the append-only ones of audit_log). */
export async function auditTriggersInstalled(conn) {
  const [rows] = await conn.query("SELECT TRIGGER_NAME AS name FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = DATABASE() ORDER BY TRIGGER_NAME");
  return rows.map((r) => r.name).filter((n) => /^trg_audit_.+_a[iu]$/.test(n));
}
