// C3, V3: GET /v1/customers/{id}/ledger. The events of ONE customer in the order key of V3 (entry_date, entry_at, kind_rank, id), each with the running balance and fine balance, keyset-paged.
//
//   - the statement is db/queries V3 as a derived table (src/reads/queries.ts) with the filter on the customer outside it: MariaDB pushes `customer_id = ?` into every branch of the union and
//     the sums are partitioned by customer_id, so a filter on one customer is applied BEFORE the sums, and each branch reads the customer's rows by (customer_id, ...) (tests/api/derived-reads.test.ts
//     asks EXPLAIN). The running balance is of the whole history: a later page starts from the balance of the page before it.
//   - the page is cut by the order key, written long (the same reason as the sync comparison, C3: whether the row form (a, b, c, d) > (...) becomes an index range is unknown [U]):
//       entry_date > ? OR (entry_date = ? AND (entry_at > ? OR (entry_at = ? AND (kind_rank > ? OR (kind_rank = ? AND id > ?)))))
//     The id is compared as its own type (a UUID as a UUID), the last tie-break of the key, so events that tie on the date, the instant and the rank come back once each.
//   - the cursor is an opaque token of those four values (NODE-DESIGN 4.2); a token the server did not send is 422.
//   - an explicit column list (READ_COLUMNS customer_ledger), never SELECT *; `limit` is 1 to limits.syncPageRows; `next` is set when the page was full, as in the sync reads.
import type { Param } from '../db/stmt.js';
import type { Reader } from '../db/tx.js';
import { limits } from '../limits.js';
import { UUID_TEXT, formatRow, isBusinessDate, timestampFromWire, timestampToWire } from '../wire/format.js';
import * as wire from '../wire/zod.js';
import { readColumns, selectList } from './columns.js';
import { V3_TEXT } from './queries.js';

/** The order key of V3 of one event. `entryAt` is the database's text 'YYYY-MM-DD HH:MM:SS.ffffff'. */
export interface LedgerCursor {
  entryDate: string;
  entryAt: string;
  kindRank: number;
  id: string;
}

export interface LedgerPage {
  rows: Record<string, unknown>[];
  next: { after: string } | null;
}

const KEYSET = '(v.entry_date > ? OR (v.entry_date = ? AND (v.entry_at > ? OR (v.entry_at = ? AND (v.kind_rank > ? OR (v.kind_rank = ? AND v.id > ?))))))';

/** The statement of one page. Parameters: ledgerParams(). Exported for the EXPLAIN test (A7). */
export function ledgerStatement(columns: readonly string[], keyset: boolean): string {
  return `SELECT ${selectList('v', columns)} FROM (${V3_TEXT}) v WHERE v.customer_id = ?${keyset ? ` AND ${KEYSET}` : ''} ORDER BY v.entry_date, v.entry_at, v.kind_rank, v.id LIMIT ?`;
}

export function ledgerParams(customerId: string, after: LedgerCursor | null, limit: number): Param[] {
  return after === null ? [customerId, limit] : [customerId, after.entryDate, after.entryDate, after.entryAt, after.entryAt, after.kindRank, after.kindRank, after.id, limit];
}

// ------------------------------------------------------------------ the cursor token

const TOKEN = /^[A-Za-z0-9_-]{1,200}$/;
const DATABASE_TIMESTAMP = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}$/;
const refused = () => new wire.InvalidInputError('after', 'must be the token the server sent');

/** The token of a cursor. A prepared statement hands a DATETIME(6) back without its zero fraction ('2026-09-30 05:00:00'), so the instant is written with six decimals here, as the token is read. */
export const encodeCursor = (c: LedgerCursor): string => Buffer.from(JSON.stringify([c.entryDate, timestampFromWire(timestampToWire(c.entryAt)), c.kindRank, c.id])).toString('base64url');

/** The cursor of a token, or JV_INVALID_INPUT on `after`. Every part is checked for its shape: a token is a client's input like any other. */
export function decodeCursor(token: string): LedgerCursor {
  if (!TOKEN.test(token)) throw refused();
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
  } catch {
    throw refused();
  }
  if (!Array.isArray(parsed) || parsed.length !== 4) throw refused();
  const [entryDate, entryAt, kindRank, id] = parsed as unknown[];
  if (!isBusinessDate(entryDate) || typeof entryAt !== 'string' || !DATABASE_TIMESTAMP.test(entryAt)) throw refused();
  if (typeof kindRank !== 'number' || !Number.isInteger(kindRank) || kindRank < 1 || kindRank > 5) throw refused();
  if (typeof id !== 'string' || !UUID_TEXT.test(id)) throw refused();
  try {
    timestampToWire(entryAt); // a real calendar date and time
  } catch {
    throw refused();
  }
  return { entryDate, entryAt, kindRank, id };
}

// ------------------------------------------------------------------ the page

const KINDS = {
  customer_id: 'uuid',
  entry_date: 'date',
  entry_at: 'timestamp',
  id: 'uuid',
  debit: 'money',
  credit: 'money',
  fine_debit: 'weight',
  fine_credit: 'weight',
  balance: 'money',
  fine_balance: 'weight',
} as const;

/** One page of the ledger of `customerId` for `role`. A customer with no events (or no such customer) has an empty ledger. */
export async function readLedger(db: Reader, role: string, customerId: string, req: { after: LedgerCursor | null; limit: number }): Promise<LedgerPage> {
  const columns = readColumns('customer_ledger', role);
  for (const key of ['entry_date', 'entry_at', 'kind_rank', 'id']) if (!columns.includes(key)) throw new Error(`the ledger columns of the role lack ${key}, which the cursor needs`);
  if (!Number.isInteger(req.limit) || req.limit < 1 || req.limit > limits.syncPageRows) throw new RangeError('the ledger page is 1 to the sync page size');
  const raw = await db.rows<Record<string, unknown>>(ledgerStatement(columns, req.after !== null), ledgerParams(customerId, req.after, req.limit));
  const rows = raw.map((r) => {
    const out = formatRow(r, KINDS);
    out.kind_rank = Number(r.kind_rank);
    return out;
  });
  const last = raw[raw.length - 1];
  const next = raw.length === req.limit ? { after: encodeCursor({ entryDate: String(last.entry_date), entryAt: String(last.entry_at), kindRank: Number(last.kind_rank), id: String(last.id) }) } : null;
  return { rows, next };
}
