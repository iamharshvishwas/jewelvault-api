// runInvariants(): spec section 12, the SQL half. It only reads.
// Each file in db/invariants/ is one SELECT that returns the rows breaking one rule as (invariant, row_ref, detail); no rows means the rule holds.
// The whole run uses ONE snapshot: REPEATABLE READ for the next transaction only (so the caller's session setting is left alone),
// then START TRANSACTION WITH CONSISTENT SNAPSHOT, so a payment saved while the run is going cannot cause a false alarm.
// At READ COMMITTED (the server's setting) every statement would read its own snapshot.
// V1 to V4 are queries (db/queries), put into the invariant files where they say {{V1}} to {{V4}}.
// Not here: I6's re-pricing of each line and I11 (Node, they need pricing.ts), I8 and I9 (the job and the tests), I12 (database size and backup ages, a separate small query).
// The Node halves of API32 (src/domain/invariants.ts, src/domain/review.ts) must read the SAME snapshot as the files: `opts.inSnapshot(conn)` is called once, inside the transaction, after the last file
// and before COMMIT (a failure there rolls the snapshot back like a failure of a file). src/ cannot import this file (it is compiled alone), so src/domain/invariants.ts is the TypeScript twin of this
// function; tests/api/nightly-invariants.test.ts runs both on the same database and compares the answers.
//
// The connection must not be inside a transaction: START TRANSACTION commits one that is open.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadQueries } from './queries.mjs';

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'db', 'invariants');

export function listInvariantFiles(dir = DIR) {
  return readdirSync(dir)
    .filter((f) => /^I\d+_.+\.sql$/.test(f))
    .sort()
    .map((f) => ({ id: `I${Number(/^I(\d+)_/.exec(f)[1])}`, name: f, sql: readFileSync(path.join(dir, f), 'utf8') }));
}

/** The file's single SELECT, ready to sit inside a derived table: no trailing semicolon. */
function asSubquery(sql) {
  return sql.trim().replace(/;+\s*$/, '');
}

/** {{V1}} to {{V4}} become the text of the derived reads of section 11 (queries, not views), in parentheses. One pass: the text put in is not read again. */
function expand(sql, queries) {
  return sql.replace(/\{\{(V\d)\}\}/g, (_, name) => {
    if (!queries[name]) throw new Error(`invariant file refers to {{${name}}}, which is not a query`);
    return `(\n${queries[name]}\n)`;
  });
}

export async function runInvariants(conn, opts = {}) {
  const dir = opts.dir ?? DIR; // the Hostinger proof app keeps its own copy of the files
  const queries = { ...loadQueries(opts.queriesDir), ...(opts.queries ?? {}) }; // a test may inject an old or wrong query (T-B18, I13)
  const sample = Number.isInteger(opts.sample) && opts.sample > 0 ? opts.sample : 20;
  const counts = {};
  const rows = [];
  const ran = [];
  // MariaDB may answer "customers joined to a grouped derived table" by re-building that derived table once per customer (split_materialized, shown as LATERAL DERIVED in EXPLAIN).
  // With bad statistics (right after a bulk load or a restore) that took more than 500 seconds for I10 on 30,000 bills, against 0.1 second with it off. The switch is
  // put back afterwards; the API's own one-customer reads keep it on, where it helps.
  const switchBefore = String((await conn.query('SELECT @@session.optimizer_switch AS s'))[0][0].s);
  const splitWasOn = /split_materialized=on/.test(switchBefore);
  if (splitWasOn) await conn.query("SET SESSION optimizer_switch = 'split_materialized=off'");
  await conn.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
  await conn.query('START TRANSACTION WITH CONSISTENT SNAPSHOT');
  try {
    for (const f of listInvariantFiles(dir)) {
      const body = expand(asSubquery(f.sql), queries);
      const [[counted]] = await conn.query(`SELECT COUNT(*) AS n FROM (\n${body}\n) q`);
      counts[f.id] = Number(counted.n);
      if (counts[f.id] > 0) {
        const [found] = await conn.query(`SELECT q.invariant, q.row_ref, q.detail FROM (\n${body}\n) q ORDER BY q.row_ref, q.detail LIMIT ${sample}`);
        for (const r of found) rows.push({ invariant: String(r.invariant), row_ref: String(r.row_ref), detail: String(r.detail) });
      }
      ran.push(f.id);
      if (opts.between) await opts.between(f.id);
    }
    if (opts.inSnapshot) await opts.inSnapshot(conn);
    await conn.query('COMMIT');
  } catch (e) {
    await conn.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    if (splitWasOn) await conn.query("SET SESSION optimizer_switch = 'split_materialized=on'").catch(() => undefined);
  }
  return { ok: Object.values(counts).every((n) => n === 0), counts, rows, ran };
}
