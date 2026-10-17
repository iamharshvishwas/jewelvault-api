// L1 mechanism (b): the Node writer of the audit rows, used when JV_AUDIT_MODE=node (a database whose user cannot create triggers, O50). Mechanism (a), the generated triggers of db/optional/0910,
// is the default and writes the rows by itself; the two are NEVER both on one database (a row would be written twice), so in mode 'triggers' this file writes nothing and auditChange says false.
//
// A function that changes a row of an audited table calls auditChange(tx, { table, action, before, after }) right after the statement, with the row as the database holds it (every column, the hidden
// ones too: SELECT * of the row) before and after. In node mode that writes exactly the row the trigger would write, in the same transaction:
//   actor       the signed-in user's id (NULL for a job or the import), as @jv_actor is set by withTx
//   actor_role  the role, or `sql` when the transaction has no actor (the trigger's COALESCE(@jv_role, 'sql'))
//   request_id  the request
//   table_name, row_id (the primary key as text), action (`insert` or `update`)
//   old_row, new_row  JSON of the columns in table order, minus the exclude list, with the trigger's value forms: integers up to 32 bits as numbers, BIGINT and DECIMAL as text (money is text, S3), JSON
//                     columns as JSON, everything else as the server prints it (a DATETIME(6) always with six fraction digits, though the prepared protocol leaves a zero fraction out).
// An UPDATE that changes nothing but updated_at writes no row (D23: the touches of src/db/touch.ts add no audit noise), and neither does one that changes only an excluded column, nor one that changes
// nothing at all. A column that is on the exclude list (password_hash) is never copied. Events (a login, an admin-door call, a job run) are not row changes: src/db/events.ts writes those in both modes.
//
// The 13 tables' shapes are static (auditShapes.ts, compared with the migrated database by a test). A function that audits a table that is not among them passes its own `shape` (a test does).
import type { AuditMode } from '../config.js';
import { AUDIT_SHAPES } from './auditShapes.js';
import type { Reader, Tx } from './tx.js';

export type { AuditMode };
export { AUDIT_SHAPES };

/** One column of an audited table, as the triggers' generator sees it. `type` is information_schema's DATA_TYPE. */
export interface AuditColumn {
  name: string;
  type: string;
  /** a JSON column (a longtext with a json_valid check): it goes into the row as JSON, not as text */
  json?: boolean;
  /** DATETIME: the digits after the second, as the server prints them */
  precision?: number;
}

export interface AuditShape {
  /** every column that is not generated, in table order */
  columns: readonly AuditColumn[];
  primaryKey: readonly string[];
  /** columns that are never copied */
  exclude: readonly string[];
}

export type AuditedRow = Readonly<Record<string, unknown>>;

export interface AuditChange {
  table: string;
  /** the primary key as text; optional, it is worked out from the row, and a value that disagrees with the row is a bug */
  rowId?: string;
  action: 'insert' | 'update';
  /** the row before an update (every column); null for an insert */
  before: AuditedRow | null;
  /** the row after the change (every column) */
  after: AuditedRow;
  /** for a table that is not one of the 13 */
  shape?: AuditShape;
}

const INT_TYPES = new Set(['tinyint', 'smallint', 'mediumint', 'int']);
const TEXT_TYPES = new Set(['bigint', 'decimal']);
const NATIVE_TYPES = new Set(['uuid', 'char', 'varchar', 'text', 'tinytext', 'mediumtext', 'longtext', 'enum', 'date', 'datetime', 'timestamp', 'time', 'year']);

/** One value in the form the trigger's JSON_OBJECT gives it. */
function jsonValue(table: string, col: AuditColumn, v: unknown): unknown {
  if (v === null || v === undefined) return null;
  const bug = (what: string) => new TypeError(`audit row of ${table}: ${col.name} ${what}`);
  if (col.json) return typeof v === 'string' ? (JSON.parse(v) as unknown) : v; // the driver hands a JSON column over parsed or as text
  if (INT_TYPES.has(col.type)) {
    if (typeof v === 'number') return v;
    if (typeof v === 'string' && /^-?\d+$/.test(v)) return Number(v);
    throw bug('is not a whole number');
  }
  if (TEXT_TYPES.has(col.type)) {
    if (typeof v === 'string') return v; // money and big numbers arrive as text and stay text (S3)
    throw bug(`must arrive as text (a ${typeof v} would lose digits)`);
  }
  if (NATIVE_TYPES.has(col.type)) {
    if (typeof v !== 'string') throw bug(`must arrive as text (dateStrings), not ${typeof v}`);
    if (col.type === 'datetime' && col.precision !== undefined && col.precision > 0) {
      const [whole, fraction = ''] = v.split('.');
      return `${whole}.${fraction.padEnd(col.precision, '0')}`; // the prepared protocol drops an all-zero fraction; the server prints it
    }
    return v;
  }
  throw bug(`has the type ${col.type}, which the audit writer does not know how to put into JSON`);
}

/** The JSON object of a row, as the triggers build it: the columns of the shape in order, minus the excluded ones. Throws TypeError (a bug in the caller) for a missing column or a wrong form. */
export function auditRowJson(shape: AuditShape, row: AuditedRow, table = 'row'): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const col of shape.columns) {
    if (shape.exclude.includes(col.name)) continue;
    if (!Object.hasOwn(row, col.name)) throw new TypeError(`audit row of ${table}: the row has no column ${col.name} (pass every column, SELECT * of the row)`);
    out[col.name] = jsonValue(table, col, row[col.name]);
  }
  return out;
}

function rowIdOf(shape: AuditShape, row: AuditedRow, table: string): string {
  const parts = shape.primaryKey.map((k) => {
    const v = row[k];
    if (v === null || v === undefined) throw new TypeError(`audit row of ${table}: the primary key column ${k} is empty`);
    return String(v);
  });
  return parts.join(':');
}

const INSERT = 'INSERT INTO audit_log (actor, actor_role, request_id, table_name, row_id, action, old_row, new_row) VALUES (?, ?, ?, ?, ?, ?, ?, ?)';

/**
 * Writes the audit row of one change in the caller's transaction, when the mode is 'node'. Returns whether a row was written (false in mode 'triggers', and for an update that changes nothing but
 * updated_at or an excluded column, or nothing at all).
 */
export async function auditChange(tx: Tx, change: AuditChange): Promise<boolean> {
  if (tx.auditMode !== 'node') return false;
  const shape = change.shape ?? (Object.hasOwn(AUDIT_SHAPES, change.table) ? AUDIT_SHAPES[change.table] : undefined);
  if (!shape) throw new TypeError(`audit: ${change.table} is not an audited table (pass its shape)`);
  if (change.action === 'insert' && change.before !== null) throw new TypeError('audit: an insert has no row before it');
  if (change.action === 'update' && change.before === null) throw new TypeError('audit: an update needs the row before it');
  const rowId = rowIdOf(shape, change.after, change.table);
  if (change.rowId !== undefined && change.rowId !== rowId) throw new TypeError(`audit row of ${change.table}: the row id given is not the id of the row`);
  const newRow = auditRowJson(shape, change.after, change.table);
  let oldRow: Record<string, unknown> | null = null;
  if (change.before !== null) {
    oldRow = auditRowJson(shape, change.before, change.table);
    // D23, D16: nothing but updated_at (or an excluded column) changed: no row
    const same = Object.keys(newRow).every((k) => k === 'updated_at' || JSON.stringify(oldRow?.[k]) === JSON.stringify(newRow[k]));
    if (same) return false;
  }
  await tx.run(INSERT, [tx.actor?.id ?? null, tx.actor?.role ?? 'sql', tx.requestId, change.table, rowId, change.action, oldRow === null ? null : JSON.stringify(oldRow), JSON.stringify(newRow)]);
  return true;
}

/**
 * "Never both" (L1): the mode and the database must agree. Node mode on a database that has the audit triggers would write every row twice; triggers mode on one without them would write none. Returns
 * what is wrong, or null. For the start-up check and the nightly check to ask (it reads the catalogue as the ten-box user, who can see the triggers of its own database).
 */
export async function auditMechanismProblem(r: Reader, mode: AuditMode): Promise<string | null> {
  const [row] = await r.rows<{ n: string | number }>("SELECT COUNT(*) AS n FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = DATABASE() AND TRIGGER_NAME REGEXP '^trg_audit_.+_a[iu]$'");
  const installed = Number(row?.n ?? 0);
  const expected = Object.keys(AUDIT_SHAPES).length * 2;
  if (mode === 'node' && installed > 0) return `JV_AUDIT_MODE is node but the database has ${installed} audit triggers: every audited change would be written twice (both mechanisms at once)`;
  if (mode === 'triggers' && installed < expected) return `JV_AUDIT_MODE is triggers but the database has ${installed} of ${expected} audit triggers: audited changes would be missing from audit_log (no audit rows)`;
  return null;
}
