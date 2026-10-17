// C3, C4: ONE PAGE of a sync resource. Hydrate and poll are the same function: the rows after a cursor, in the order of (updated_at, key), at most `limit` of them.
//
//   - ordered by (updated_at, key) and paged by `updated_at > ? OR (updated_at = ? AND key > ?)`, written long because whether MariaDB turns the row form `(a, b) > (x, y)` into an index range is
//     unknown [U]; the statement is the one the EXPLAIN test judges (A7): the base table alone, the (updated_at, key) index of D19.
//   - a cursor with a stamp and no key reads from that stamp INCLUDED (`updated_at >= ?`): what the screen sends after it subtracts the 30-second overlap, so a row at exactly that stamp is
//     never skipped.
//   - the key is compared as its own type: a UUID as a UUID, never as text. Every column in the statement is written `src.<column>` and ORDER BY names the table's column, never a name that
//     the select list gives to something else: the export of the database half skipped rows with random (version 4) ids when a column cast to text was given the key's own name
//     (BACKUP-RESTORE.md). Nothing here casts a key.
//   - an explicit column list for the caller's role (READ_COLUMNS of the matrix), never `SELECT *`. Every name that reaches the statement comes from the matrix or from src/sync/resources.ts;
//     nothing the client sends is ever a table or a column name (A11). Values go as parameters.
//   - `next` is present when the page was FULL, and holds the stamp and key of its last row; the client calls again with them. A page that holds fewer rows than `limit` ends the load.
import type { Reader } from '../db/tx.js';
import type { Param } from '../db/stmt.js';
import { JvError } from '../errors.js';
import { READ_COLUMNS, readableSettingKeys } from '../permissions/matrix.js';
import { formatRow, timestampToWire } from '../wire/format.js';
import { billSummaryFigures, customerBalanceFigures } from './derived.js';
import type { SyncResource } from './resources.js';

/** Where a page starts: after this stamp (and, when there is a key, after this key at that stamp). `updatedAt` is the database's text, 'YYYY-MM-DD HH:MM:SS.ffffff'. */
export interface After {
  updatedAt: string;
  key: string | null;
}

export interface PageRequest {
  after?: After;
  /** 1 to the page cap; the caller has already clamped it. */
  limit: number;
}

export interface Next {
  updated_at: string;
  key: string;
}

export interface WirePage {
  rows: Record<string, unknown>[];
  next: Next | null;
}

const IDENT = /^[a-z][a-z0-9_]*$/;
function ident(name: string): string {
  if (!IDENT.test(name)) throw new Error(`not a column or table name of the allow-lists: ${name.slice(0, 40)}`);
  return name;
}

const marks = (n: number): string => Array.from({ length: n }, () => '?').join(', ');

interface Raw {
  jv_at: string;
  jv_key: string;
  [column: string]: unknown;
}

/** The page statement. `columns` may be empty (a derived read cuts the page from the base table by its keys alone). Exported for the EXPLAIN test (T-F03, A7), which asks the optimizer about it on the volumes of C2. */
export function pageStatement(r: SyncResource, columns: readonly string[], after: After | undefined, keyCount: number): string {
  const key = ident(r.key);
  const select = [...columns.map((c) => `src.\`${ident(c)}\``), `src.updated_at AS jv_at`, `src.${key} AS jv_key`].join(', ');
  const cursor = after === undefined ? null : after.key === null ? 'src.updated_at >= ?' : `(src.updated_at > ? OR (src.updated_at = ? AND src.${key} > ?))`;
  const only = keyCount > 0 ? `src.${key} IN (${marks(keyCount)})` : null;
  const where = [cursor, only].filter((x): x is string => x !== null);
  return `SELECT ${select} FROM \`${ident(r.from)}\` AS src${where.length > 0 ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY src.updated_at, src.${key} LIMIT ?`;
}

/** The columns a role reads of a resource (READ_COLUMNS), or a refusal: a role that is not on the resource's row reads nothing, whatever asked. */
function columnsFor(r: SyncResource, role: string): readonly string[] {
  const byRole = READ_COLUMNS[r.table] as Partial<Record<string, readonly string[]>>;
  const columns = Object.hasOwn(byRole, role) ? byRole[role] : undefined;
  if (!columns) throw new JvError('JV_FORBIDDEN', 'You are not allowed to do this.');
  return columns;
}

/** A row of the database to the row the wire carries, cut to `columns`. Also how the edit routes (src/edit) answer, so that a row they return is the row the sync read would give. */
export function toWire(r: SyncResource, columns: readonly string[], raw: Record<string, unknown>): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  for (const c of columns) row[c] = raw[c] === undefined ? null : raw[c];
  for (const c of r.json) if (typeof row[c] === 'string') row[c] = JSON.parse(row[c] as string);
  const out = formatRow(row, r.kinds);
  for (const c of r.flags) if (out[c] !== null) out[c] = Number(out[c]) === 1;
  for (const c of r.counts) if (out[c] !== null) out[c] = Number(out[c]);
  return out;
}

/**
 * One page of `r` for `role`. Reads only (a Reader). Inside a snapshot (withRead, snapshot) the statements of a derived read see one moment, and so do the pages of a poll.
 * Throws JV_FORBIDDEN for a role that does not read the resource.
 */
export async function readPage(db: Reader, r: SyncResource, role: string, req: PageRequest): Promise<WirePage> {
  const columns = columnsFor(r, role);
  const keys = r.keyList ? readableSettingKeys(role) : null;
  if (keys !== null && keys.length === 0) return { rows: [], next: null };
  const params: Param[] = [];
  if (req.after !== undefined) {
    params.push(req.after.updatedAt);
    if (req.after.key !== null) params.push(req.after.updatedAt, req.after.key);
  }
  if (keys !== null) params.push(...keys);
  params.push(req.limit);
  // a derived read cuts the page from the base table by its keys, then asks for the figures of those rows
  const cut = await db.rows<Raw>(pageStatement(r, r.derived === null ? columns : [], req.after, keys?.length ?? 0), params);
  if (cut.length === 0) return { rows: [], next: null };
  let rows: Record<string, unknown>[];
  if (r.derived === null) {
    rows = cut.map((raw) => toWire(r, columns, raw));
  } else {
    const ids = cut.map((c) => String(c.jv_key));
    const figures = await db.rows<Record<string, unknown>>(r.derived === 'bill_summary' ? billSummaryFigures(ids.length) : customerBalanceFigures(ids.length), ids);
    const byId = new Map(figures.map((f) => [String(f.id), f]));
    rows = ids.map((id) => {
      const f = byId.get(id);
      if (!f) throw new Error(`${r.name}: the figures of a row of the page are missing`); // a row of the base table always has them: a bug, not the caller's fault
      return toWire(r, columns, f);
    });
  }
  const last = cut[cut.length - 1];
  return { rows, next: cut.length === req.limit ? { updated_at: timestampToWire(last.jv_at), key: String(last.jv_key) } : null };
}
