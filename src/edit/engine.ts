// A5, D22, S6: the ordinary edits. One mechanism for every table an edit can write; the tables (designs, pieces, categories, subcategories here, the rates, settings and customers of API13b
// next) only say which fields they take (FieldSpec, fields.ts) and which rules of their own apply (a RuleCheck).
//
// AN UPDATE (PATCH, shape `changes`): { expected_updated_at, changes: { only the changed fields } }.
//   1. before the database is touched: every field is classified by the matrix (writeFieldVerdict). A field on another role's list, or a column of the table that is on nobody's list, is refused
//      JV_FORBIDDEN; a name that is no column, and a stamp or person column (S6, D22), is refused JV_INVALID_INPUT; nothing is dropped silently, and one bad field refuses the whole call. Then
//      each value is checked against its column (422).
//   2. one transaction (withTx): the row is read FOR UPDATE (404 when there is none), its `updated_at` is compared with the text the screen sent (409 JV_STALE with the row the sync read would give
//      in details.current: the screen reloads it), the fields that really differ are found (a value equal to the stored one is no change), the table's rules run on the current row and the
//      differences (409 JV_NOT_ALLOWED, 422), and a call that changes nothing ends here with the row as it is: no write, no new stamp.
//   3. `UPDATE t SET <changed fields>, updated_at = ?, updated_by = ? WHERE id = ? AND updated_at = ?`: both stamps from ONE reading of the API clock, the person from the session (S6, D22). The
//      row is locked, so the guard cannot fail here; if it does, the call is answered JV_STALE all the same and nothing is written.
//   4. the row is read again and answered in the wire format of the sync read for the caller's role (C5 (a): "on success the returned row replaces it").
// AN INSERT (POST, shape `fields`): the fields themselves; the id, both stamps and both person columns are the API's. 201 with the new row.
//
// AUDIT (L1). Mechanism (a), the generated triggers, writes the audit row of every statement below by itself, from the actor variables that withTx sets. Mechanism (b), the Node writer, is
// API15's (src/db/audit.ts, JV_AUDIT_MODE=node): auditChange is called from the two places marked "L1 (b)" below, which know the table, the id, the row before and the row after.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { auditChange } from '../db/audit.js';
import { newId } from '../db/ids.js';
import type { Param } from '../db/stmt.js';
import { type Tx, txContextFor, withTx } from '../db/tx.js';
import { JvError, unavailableError } from '../errors.js';
import { type EditAction, READ_COLUMNS, type ReadResource, type Role, WRITE_COLUMNS, columnsOfTable, writeFieldVerdict } from '../permissions/matrix.js';
import { type Auth, assertMayCall } from '../permissions/route.js';
import { toWire } from '../sync/page.js';
import { resourceByName } from '../sync/resources.js';
import { UUID_TEXT, timestampFromWire, timestampToWire } from '../wire/format.js';
import * as wire from '../wire/zod.js';
import type { FieldSpec } from './fields.js';

export type Row = Record<string, unknown>;

/** One table an edit can write. */
export interface EditTable {
  readonly table: string;
  /** The row of the matrix for an update of this table, if the table has one. */
  readonly update?: EditAction;
  /** The row of the matrix for an insert, if the table has one. */
  readonly insert?: EditAction;
  /** Every column an edit can write, with what it takes. A column on a WRITE_COLUMNS list that is not here is a bug the tests name. */
  readonly fields: Readonly<Record<string, FieldSpec>>;
}

/** What a rule of a table is given: the open transaction, the caller, the row as it is, and the fields that really change. */
export interface RuleInput {
  readonly tx: Tx;
  readonly role: Role;
  readonly id: string;
  readonly current: Row;
  /** only the fields whose new value differs from the stored one, with the new values as the statement will bind them */
  readonly diff: Readonly<Record<string, unknown>>;
}
export type UpdateRule = (input: RuleInput) => Promise<void>;
/** A check before an insert: the values after validation. */
export type InsertRule = (tx: Tx, values: Readonly<Record<string, unknown>>) => Promise<void>;

// ------------------------------------------------------------------ names that reach a statement

const IDENT = /^[a-z][a-z0-9_]*$/;
/** Every name that reaches a statement comes from a table definition or the matrix and is checked once more here; nothing the client sends is ever a table or column name (A11). */
function ident(name: string): string {
  if (!IDENT.test(name)) throw new Error(`not a table or column name of the allow-lists: ${name.slice(0, 40)}`);
  return name;
}

// ------------------------------------------------------------------ errors

export const notFound = () => new JvError('JV_NOT_FOUND', 'That record does not exist.');

/** JV_NOT_ALLOWED (409): the input is fine and the rule of the business says no. */
export const notAllowed = (field: string, message: string) => new JvError('JV_NOT_ALLOWED', message, { details: { field } });

/** JV_INVALID_INPUT (422) on a field of the body, named as the body spells it. */
export const invalid = (field: string, reason: string) => new wire.InvalidInputError(field, reason);

// ------------------------------------------------------------------ rows

/** The columns the answer carries for a role: the ones its sync read gives (READ_COLUMNS). */
function columnsFor(table: string, role: string): readonly string[] {
  const byRole = READ_COLUMNS[table as ReadResource] as Partial<Record<string, readonly string[]>>;
  const list = Object.hasOwn(byRole, role) ? byRole[role] : undefined;
  if (!list) throw new JvError('JV_FORBIDDEN', 'You are not allowed to do this.');
  return list;
}

/** A row in the wire format of the sync read of this table for this role, so that a row an edit returns, and the `current` of a stale answer, are the rows the screen's cache already holds. */
export function wireRow(table: string, role: string, row: Row): Row {
  const resource = resourceByName(table.replaceAll('_', '-'));
  if (!resource) throw new Error(`${table} is not a sync resource`);
  return toWire(resource, columnsFor(table, role), row);
}

/**
 * SELECT with an explicit column list (never `*`), by id. `lock` takes the row lock the edit needs for the rest of the transaction. Every column the matrix knows is read, the ones no role reads
 * as well (the import's bookkeeping), so that the row before and the row after are complete for the audit row of mechanism (b); the answer to the caller is cut to the columns of its role.
 */
export async function readRow(tx: Tx, table: string, id: string, lock: boolean): Promise<Row | undefined> {
  const columns = columnsOfTable(table).map((c) => `\`${ident(c)}\``).join(', ');
  const [row] = await tx.rows<Row>(`SELECT ${columns} FROM \`${ident(table)}\` WHERE id = ?${lock ? ' FOR UPDATE' : ''}`, [id]);
  return row;
}

/** A row that must be there for the edit to make sense (the category a design points at). A made-up id is a refusal of the field, never the foreign key's error (that would be a 500). */
export async function mustExist(tx: Tx, table: string, id: string, field: string, reason: string): Promise<void> {
  const rows = await tx.rows(`SELECT id FROM \`${ident(table)}\` WHERE id = ?`, [id]);
  if (rows.length === 0) throw invalid(field, reason);
}

// ------------------------------------------------------------------ the body

/** A JSON object whose own keys are all kept: z.record would drop a key called __proto__ without a word, and nothing is silently ignored (A5). */
export const objectBody = (what: string) =>
  z.custom<Record<string, unknown>>((v) => typeof v === 'object' && v !== null && !Array.isArray(v), { error: () => what });

/** The body of an update (shape `changes`, matrix.ts): the stamp the screen holds, as the exact text, and the fields to change. */
export const updateBody = wire.strictObject({
  expected_updated_at: wire.timestamp,
  changes: objectBody('must be an object holding the fields to change'),
});
export type UpdateBody = z.output<typeof updateBody>;

/** The body of an insert (shape `fields`): the fields themselves. */
export const insertBody = objectBody('must be a JSON object');

/**
 * Classifies and checks the fields of a body. Refuses, in this order: a field the caller may not send (403 JV_FORBIDDEN, naming it), a name that is no field (422, naming it), a value the column
 * does not take (422, naming the field). `path` puts a prefix on the names in the answer (`changes.`); `all` makes every field of the caller's list required (an insert).
 */
export function checkFields(table: EditTable, action: EditAction, role: string, input: Record<string, unknown>, path: string, all: readonly string[] | null): Record<string, unknown> {
  const keys = Object.keys(input);
  const verdicts = keys.map((k) => [k, writeFieldVerdict(action, role, k)] as const);
  const forbidden = verdicts.find(([, v]) => v === 'forbidden');
  if (forbidden) throw new JvError('JV_FORBIDDEN', 'You are not allowed to change this field.', { details: { field: `${path}${forbidden[0]}` } });
  const unknown = verdicts.find(([, v]) => v === 'unknown');
  if (unknown) throw invalid(`${path}${unknown[0].slice(0, 64)}`, 'is not a field this call accepts');

  const names = all === null ? keys : [...all];
  const shape: Record<string, z.ZodType> = {};
  for (const name of names) {
    if (!Object.hasOwn(table.fields, name)) throw new Error(`${action}: the matrix lets a role send ${name} and src/edit has no field for it`);
    shape[name] = table.fields[name].schema;
  }
  const schema = path === '' ? wire.strictObject(shape) : wire.strictObject({ [path.slice(0, -1)]: wire.strictObject(shape) });
  const parsed = wire.parseInput(schema, path === '' ? input : { [path.slice(0, -1)]: input }) as Record<string, unknown>;
  return path === '' ? parsed : (parsed[path.slice(0, -1)] as Record<string, unknown>);
}

// ------------------------------------------------------------------ the transaction

/** The fields an insert by this role must carry: its whole list (a category needs its name and its prefix). */
function insertFields(action: EditAction, role: string): readonly string[] {
  const lists = WRITE_COLUMNS[action] as Partial<Record<string, readonly string[]>>;
  return (Object.hasOwn(lists, role) ? lists[role] : undefined) ?? [];
}

function contextOf(app: FastifyInstance, request: FastifyRequest, auth: Auth) {
  if (!app.db) throw unavailableError();
  return txContextFor(app.db, request, { id: auth.user.id, role: auth.user.role });
}

/**
 * A stamp as the exact 'YYYY-MM-DD HH:MM:SS.ffffff' text of the wire (timestampFromWire). The driver's binary protocol leaves the fraction out when the microseconds are all zero ('... 08:30:15'),
 * and the text the screen sends back always has six decimals, so the two are brought to one form before they are compared. Nothing goes through a Date.
 */
const stampText = (stored: unknown): string => timestampFromWire(timestampToWire(String(stored)));

function stale(table: string, role: string, current: Row): JvError {
  return new JvError('JV_STALE', 'This record was changed by someone else. Reload it and try again.', { details: { current: wireRow(table, role, current) } });
}

/** The fields whose new value is not the stored one. */
function changed(table: EditTable, current: Row, values: Record<string, unknown>): Record<string, unknown> {
  const diff: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(values)) if (!table.fields[name].same(current[name], value)) diff[name] = value;
  return diff;
}

/**
 * An update of one row by id with the stale check (A5). Returns the row the screen's copy is replaced with. `rules` are the table's own (selling method locked, photo ids, weights ...); they run on
 * the row as it is now, under its lock, after the stale check and before anything is written.
 */
export async function updateRecord(app: FastifyInstance, request: FastifyRequest, auth: Auth, table: EditTable, id: string, body: UpdateBody, rules?: UpdateRule): Promise<{ row: Row }> {
  const action = table.update;
  if (!action) throw new Error(`${table.table} has no update row in the matrix`);
  const role = auth.user.role;
  assertMayCall(role, action); // X0 item 2: the wrapper has checked; a service function checks again
  if (Object.keys(body.changes).length === 0) throw invalid('changes', 'must name at least one field');
  const values = checkFields(table, action, role, body.changes, 'changes.', null);
  const expected = timestampFromWire(body.expected_updated_at);
  if (!UUID_TEXT.test(id)) throw notFound(); // not an id: there is no such row, and the database is not asked

  return withTx(contextOf(app, request, auth), async (tx) => {
    const current = await readRow(tx, table.table, id, true);
    if (!current) throw notFound();
    if (stampText(current.updated_at) !== expected) throw stale(table.table, role, current); // A5: nothing is changed, the screen reloads
    const diff = changed(table, current, values);
    await rules?.({ tx, role, id, current, diff });
    if (Object.keys(diff).length === 0) return { row: wireRow(table.table, role, current) }; // nothing to change: nothing is written, the stamp stays

    const now = app.clock.read(); // both stamps from one reading (S6)
    const columns = Object.keys(diff).map(ident);
    const params: Param[] = columns.map((c) => table.fields[c].param(diff[c], now.timestamp));
    const result = await tx.run(
      `UPDATE \`${ident(table.table)}\` SET ${columns.map((c) => `\`${c}\` = ?`).join(', ')}, updated_at = ?, updated_by = ? WHERE id = ? AND updated_at = ?`,
      [...params, now.timestamp, auth.user.id, id, expected],
    );
    if (result.affectedRows !== 1) throw stale(table.table, role, (await readRow(tx, table.table, id, false)) ?? current); // cannot happen under the lock; if it does, nothing was written
    const after = await readRow(tx, table.table, id, false);
    if (!after) throw new Error(`${table.table} ${id}: the row is gone after its own update`);
    await auditChange(tx, { table: table.table, rowId: id, action: 'update', before: current, after }); // L1 (b): the Node writer, only when JV_AUDIT_MODE=node; with the triggers (a) nothing is written here
    return { row: wireRow(table.table, role, after) };
  });
}

/** An insert of one row with a new id (categories, subcategories). `rules` check the values (a name that is taken, a parent that must exist) inside the transaction. */
export async function insertRecord(app: FastifyInstance, request: FastifyRequest, auth: Auth, table: EditTable, input: Record<string, unknown>, rules?: InsertRule): Promise<{ row: Row }> {
  const action = table.insert;
  if (!action) throw new Error(`${table.table} has no insert row in the matrix`);
  const role = auth.user.role;
  assertMayCall(role, action);
  const values = checkFields(table, action, role, input, '', insertFields(action, role));

  return withTx(contextOf(app, request, auth), async (tx) => {
    await rules?.(tx, values);
    const now = app.clock.read();
    const id = newId();
    const columns = Object.keys(values).map(ident);
    const params: Param[] = columns.map((c) => table.fields[c].param(values[c], now.timestamp));
    await tx.run(
      `INSERT INTO \`${ident(table.table)}\` (id, ${columns.map((c) => `\`${c}\``).join(', ')}, created_at, updated_at, created_by, updated_by) VALUES (?, ${columns.map(() => '?').join(', ')}, ?, ?, ?, ?)`,
      [id, ...params, now.timestamp, now.timestamp, auth.user.id, auth.user.id],
    );
    const after = await readRow(tx, table.table, id, false);
    if (!after) throw new Error(`${table.table} ${id}: the row is gone after its own insert`);
    await auditChange(tx, { table: table.table, rowId: id, action: 'insert', before: null, after }); // L1 (b): the Node writer, only when JV_AUDIT_MODE=node
    return { row: wireRow(table.table, role, after) };
  });
}
