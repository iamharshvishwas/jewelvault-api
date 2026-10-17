// C3, A4: GET /v1/audit-log?before_id=&table=&row_id=&limit=. The audit log, newest first, at most limits.ownerPageRows (200) a page; the owner alone reads it.
//
//   - newest first is `ORDER BY id DESC`: the id is the insertion order and the cursor (`before_id`: the rows with a smaller id), so a page never repeats or skips a row. The primary key serves the
//     plain page and the range; (table_name, row_id) serves a filter by table and row (D19). `table` and `row_id` are values, bound as parameters; a row id needs its table.
//   - an explicit column list (READ_COLUMNS audit_log); `old_row` and `new_row` are JSON on the wire; `limit` over the cap is refused, not cut; `next` is set when the page was full.
//   - the log is append-only (L1); nothing here changes it.
import type { Param } from '../db/stmt.js';
import type { Reader } from '../db/tx.js';
import { limits } from '../limits.js';
import { formatRow } from '../wire/format.js';
import * as wire from '../wire/zod.js';
import { z } from 'zod';
import { readColumns, selectList } from './columns.js';

export interface AuditFilter {
  beforeId: boolean;
  table: boolean;
  rowId: boolean;
}

/** The statement of one page. Parameters, in this order: the id (when beforeId), the table (when table), the row id (when rowId), the limit. Exported for the EXPLAIN test (A7). */
export function auditStatement(columns: readonly string[], f: AuditFilter): string {
  const where = [f.beforeId ? 'a.id < ?' : null, f.table ? 'a.table_name = ?' : null, f.rowId ? 'a.row_id = ?' : null].filter((x): x is string => x !== null);
  return `SELECT ${selectList('a', columns)} FROM audit_log a${where.length > 0 ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY a.id DESC LIMIT ?`;
}

const limitMessage = `must be a whole number from 1 to ${limits.ownerPageRows}`;

/** The query of the call. Strict: a key that is not here is 422. An id is at most 15 digits, so it is exact as a JavaScript number. */
export const auditQuery = wire.strictObject({
  before_id: z.string({ error: 'must be the id the server sent' }).regex(/^[1-9][0-9]{0,14}$/, 'must be the id the server sent').optional(),
  table: z.string({ error: 'must be a table name' }).regex(/^[a-z][a-z0-9_]{0,63}$/, 'must be a table name').optional(),
  row_id: z.string({ error: 'must be a row id' }).regex(/^[A-Za-z0-9_.:-]{1,64}$/, 'must be a row id').optional(),
  limit: z.string({ error: limitMessage }).regex(/^[1-9][0-9]{0,3}$/, limitMessage).optional(),
});

export interface AuditPage {
  rows: Record<string, unknown>[];
  next: { before_id: number } | null;
}

const parseJson = (value: unknown): unknown => (typeof value === 'string' ? JSON.parse(value) : (value ?? null));

export async function readAuditLog(db: Reader, role: string, q: z.output<typeof auditQuery>): Promise<AuditPage> {
  if (q.row_id !== undefined && q.table === undefined) throw new wire.InvalidInputError('row_id', 'needs table');
  const asked = q.limit === undefined ? limits.ownerPageRows : Number(q.limit);
  if (asked > limits.ownerPageRows) throw new wire.InvalidInputError('limit', limitMessage); // the cap is the contract: asking for more is refused, not cut
  const columns = readColumns('audit_log', role);
  const params: Param[] = [];
  if (q.before_id !== undefined) params.push(Number(q.before_id));
  if (q.table !== undefined) params.push(q.table);
  if (q.row_id !== undefined) params.push(q.row_id);
  params.push(asked);
  const raw = await db.rows<Record<string, unknown>>(auditStatement(columns, { beforeId: q.before_id !== undefined, table: q.table !== undefined, rowId: q.row_id !== undefined }), params);
  const rows = raw.map((r) => {
    const out = formatRow(r, { at: 'timestamp', actor: 'uuid', request_id: 'uuid' });
    out.id = Number(r.id);
    if (!Number.isSafeInteger(out.id)) throw new Error('an audit id is not a safe integer');
    for (const json of ['old_row', 'new_row']) if (columns.includes(json)) out[json] = parseJson(r[json]);
    return out;
  });
  return { rows, next: raw.length === asked ? { before_id: Number(raw[raw.length - 1].id) } : null };
}
