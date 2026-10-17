import type { Connection, RowDataPacket } from 'mysql2/promise';
import { type LoggedStatement, type PlanRow, explainable, isVacuous } from './statement-log';
import { type Token, tokenize } from './static-lib';

// The judge of the EXPLAIN test (T-D11, A7, D19): given a statement, the plan the optimizer made for it and the catalogue of the schema, what is wrong with it?
//
//  Rule 1 (D19 rule 1, spike finding F1): every locking or writing statement (UPDATE, SELECT ... FOR UPDATE / LOCK IN SHARE MODE, the select inside an INSERT ... SELECT, DELETE) reaches each of
//          its tables through an index. A table the optimizer can only read whole (type ALL or index) with NO index that could serve the statement scans, and locks what it scans.
//          "Could serve" is possible_keys, not key: on a test database with a handful of rows the optimizer may prefer a full read over an index it could use, and that says nothing about 2,500 rows.
//  Rule 2 (C4, D19): the sync comparison (updated_at > ? OR (updated_at = ? AND key > ?)) is served by the index on (updated_at, primary key) of its table.

export interface Catalogue {
  tables: ReadonlySet<string>;
  /** table -> indexes with their columns, in order */
  indexes: ReadonlyMap<string, readonly { name: string; columns: readonly string[] }[]>;
  /** table -> primary key columns */
  primaryKeys: ReadonlyMap<string, readonly string[]>;
}

export async function loadCatalogue(c: Connection): Promise<Catalogue> {
  const [tables] = await c.query<RowDataPacket[]>("SELECT TABLE_NAME AS t FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE'");
  const [stats] = await c.query<RowDataPacket[]>(
    'SELECT TABLE_NAME AS t, INDEX_NAME AS i, COLUMN_NAME AS c FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX',
  );
  const indexes = new Map<string, { name: string; columns: string[] }[]>();
  const primaryKeys = new Map<string, string[]>();
  for (const r of stats) {
    const list = indexes.get(r.t) ?? [];
    let idx = list.find((x) => x.name === r.i);
    if (!idx) list.push((idx = { name: r.i, columns: [] }));
    idx.columns.push(r.c);
    indexes.set(r.t, list);
    if (r.i === 'PRIMARY') primaryKeys.set(r.t, idx.columns);
  }
  return { tables: new Set(tables.map((r) => String(r.t))), indexes, primaryKeys };
}

// ------------------------------------------------------------------ what a statement reads and writes

const NOT_ALIAS = new Set(['WHERE', 'SET', 'JOIN', 'INNER', 'LEFT', 'RIGHT', 'CROSS', 'NATURAL', 'STRAIGHT_JOIN', 'ON', 'USING', 'ORDER', 'GROUP', 'HAVING', 'LIMIT', 'FOR', 'LOCK', 'UNION', 'VALUES', 'SELECT', 'FORCE', 'USE', 'IGNORE', 'PARTITION']);

/** The tables a statement names after FROM, JOIN, UPDATE and INSERT INTO, with their alias (the alias is the table name when none is given). Subqueries are walked into; a derived table has no name. */
export function tablesOf(sql: string): { table: string; alias: string }[] {
  const t: Token[] = tokenize(sql);
  const out: { table: string; alias: string }[] = [];
  const take = (from: number) => {
    // from points at the token after FROM / JOIN / UPDATE / INTO
    let i = from;
    for (;;) {
      const tok = t[i];
      if (!tok || tok.kind !== 'id' || NOT_ALIAS.has(tok.text)) return;
      const table = tok.name;
      let alias = table;
      i++;
      if (t[i]?.kind === 'id' && t[i].text === 'AS' && t[i + 1]?.kind === 'id') {
        alias = t[i + 1].name;
        i += 2;
      } else if (t[i]?.kind === 'id' && !NOT_ALIAS.has(t[i].text)) {
        alias = t[i].name;
        i++;
      }
      out.push({ table, alias });
      // FROM a x, b y
      if (t[i]?.kind === 'punct' && t[i].text === ',' && t[i + 1]?.kind === 'id' && !NOT_ALIAS.has(t[i + 1].text) && !(t[i + 2]?.kind === 'op')) {
        i++;
        continue;
      }
      return;
    }
  };
  for (let i = 0; i < t.length; i++) {
    const w = t[i];
    if (w.kind !== 'id') continue;
    if (w.text === 'FROM' || w.text === 'JOIN') take(i + 1);
    else if (w.text === 'UPDATE' && t[i - 1]?.text !== 'KEY') take(i + 1);
    else if (w.text === 'INTO') take(i + 1);
  }
  return out;
}

const code = (sql: string) =>
  sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|\s)(--|#)[^\n]*/g, ' ')
    .replace(/'(?:[^'\\]|\\.|'')*'/g, "''");

export const isLocking = (sql: string) => /\bFOR\s+UPDATE\b|\bLOCK\s+IN\s+SHARE\s+MODE\b/i.test(code(sql));
export const isWriting = (sql: string) => {
  const kind = explainable(sql);
  return kind === 'update' || kind === 'delete' || kind === 'insert_select';
};
/** A poll: updated_at compared with a parameter and ordered by it. */
export const isSyncComparison = (sql: string) => /\bupdated_at\s*>=?\s*\?/i.test(code(sql)) && /\bORDER\s+BY\s+[\w.`]*updated_at\b/i.test(code(sql));

// ------------------------------------------------------------------ the judge

export type Verdict =
  | { status: 'ok'; checked: string[] }
  | { status: 'fail'; problems: string[] }
  | { status: 'vacuous' }
  | { status: 'skipped'; why: string };

const SCANS = new Set(['ALL', 'index']);

export function judge(entry: Pick<LoggedStatement, 'sql' | 'plan'>, cat: Catalogue): Verdict {
  const { sql, plan } = entry;
  const named = tablesOf(sql);
  const unknown = named.filter((n) => !cat.tables.has(n.table));
  if (unknown.length > 0) return { status: 'skipped', why: `a table of another schema: ${unknown.map((u) => u.table).join(', ')}` };
  if (isVacuous(plan)) return { status: 'vacuous' };
  const rows = plan.filter((r): r is PlanRow & { table: string } => !!r.table && !r.table.startsWith('<'));
  const problems: string[] = [];
  const strict = isLocking(sql) || isWriting(sql);
  const checked: string[] = [];
  if (strict) {
    checked.push('index for a locking or writing statement');
    for (const r of rows) {
      if (r.type && SCANS.has(r.type) && !r.possible_keys) problems.push(`${r.table}: read by a ${r.type === 'ALL' ? 'full table scan' : 'full index scan'} with no index that could serve it (type ${r.type}, possible_keys NULL)`);
    }
  }
  if (isSyncComparison(sql)) {
    checked.push('(updated_at, key) index for the sync comparison');
    for (const r of rows) {
      const table = named.find((n) => n.alias === r.table)?.table ?? (cat.tables.has(r.table) ? r.table : undefined);
      if (!table) continue;
      const pk = cat.primaryKeys.get(table) ?? [];
      const sync = (cat.indexes.get(table) ?? []).filter((i) => i.columns[0] === 'updated_at' && pk.every((k, n) => i.columns[n + 1] === k));
      if (sync.length === 0) {
        problems.push(`${table}: no index on (updated_at, ${pk.join(', ')}) for the sync comparison`);
        continue;
      }
      const names = new Set(sync.map((i) => i.name));
      const possible = (r.possible_keys ?? '').split(',').filter(Boolean);
      // the index it chose, or one it could have chosen: a handful of rows may make a full read the cheaper plan, which says nothing about 2,500
      const usable = (r.key !== null && names.has(r.key)) || possible.some((k) => names.has(k));
      if (!usable) problems.push(`${table}: the sync comparison uses ${r.key ? `index ${r.key}` : 'no index'} (${r.type}); the (updated_at, ${pk.join(', ')}) index is ${sync.map((i) => i.name).join('/')}`);
    }
  }
  return problems.length > 0 ? { status: 'fail', problems } : { status: 'ok', checked };
}

export interface LogReport {
  total: number;
  ok: number;
  vacuous: number;
  skipped: number;
  failures: { sql: string; problems: string[] }[];
}

export function judgeLog(entries: readonly LoggedStatement[], cat: Catalogue): LogReport {
  const report: LogReport = { total: entries.length, ok: 0, vacuous: 0, skipped: 0, failures: [] };
  for (const e of entries) {
    const v = judge(e, cat);
    if (v.status === 'ok') report.ok++;
    else if (v.status === 'vacuous') report.vacuous++;
    else if (v.status === 'skipped') report.skipped++;
    else report.failures.push({ sql: e.sql.replace(/\s+/g, ' ').slice(0, 200), problems: v.problems });
  }
  return report;
}

/** Asks the optimizer for the plan of a statement with values in place, as the log does. */
export async function planOf(c: Connection, sql: string, values: unknown[] = []): Promise<PlanRow[]> {
  const [rows] = await c.query<RowDataPacket[]>(`EXPLAIN ${sql}`, values);
  return rows.map((r) => ({ select_type: r.select_type ?? null, table: r.table ?? null, type: r.type ?? null, possible_keys: r.possible_keys ?? null, key: r.key ?? null, rows: r.rows ?? null, Extra: r.Extra ?? null }));
}
