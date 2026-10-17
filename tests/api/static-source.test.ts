import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Scratch, scratchDatabase } from '../helpers';
import { checkSql } from '../../scripts/migrate.mjs';
import { readCatalogue } from './static-catalogue-lib';
import { connectionOpeners, isStatement, moneyParamHits, moneyParamProblems, sourceFiles, statementsIn, stringLiterals } from './static-lib';
import { REPO } from './support';

// T-D11, part 2 (A7, S3, S7, S9, S11): the checks that read the source. Each one is a function of text or of a folder (tests/api/static-lib.ts), so it is run here three ways: on a made-up
// statement or file that breaks the rule (it must find it), on a scratch folder where a violation is planted and then taken away (found, then clean), and on the real src/ (clean).

const scratchDirs: string[] = [];
const scratchDir = () => {
  const d = mkdtempSync(join(tmpdir(), 'jv-static-'));
  scratchDirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of scratchDirs) rmSync(d, { recursive: true, force: true });
});

// ------------------------------------------------------------------ S3: money and weight parameters

describe('T-D11 no bound money or weight parameter in SQL arithmetic, ROUND or a comparison without CAST (S3)', () => {
  let scratch: Scratch;
  let money: ReadonlySet<string>;
  beforeAll(async () => {
    scratch = await scratchDatabase('money', { schema: true });
    const u = await scratch.connect();
    try {
      money = new Set((await readCatalogue(u)).columns.filter((c) => c.dataType === 'decimal').map((c) => c.name));
    } finally {
      await u.end();
    }
  }, 120_000);
  afterAll(async () => {
    await scratch?.drop();
  });

  const found = (sql: string) => moneyParamProblems(sql, money).map((p) => p.reason);

  it('the money set is the DECIMAL columns of the schema (37 columns, 31 names)', () => {
    expect(money.has('amount') && money.has('grand_total') && money.has('gross_weight') && money.has('rate_per_gram')).toBe(true);
    expect(money.has('id')).toBe(false);
    expect(money.has('updated_at')).toBe(false);
  });

  it.each([
    ['ROUND(?, 0) of a bound value', 'SELECT ROUND(?, 0) AS r'],
    ['ROUND of an expression that holds a bound value', 'SELECT ROUND(? * 1.18, 2) AS r'],
    ['a bound value deeper in ROUND, after a number', 'SELECT ROUND(1.18 * ?, 2) AS r'],
    ['a bound value as the divisor inside ROUND', 'SELECT ROUND(100 / ?, 2) AS r'],
    ['a bound value in FLOOR', 'SELECT FLOOR(?) AS r'],
    ['a column plus a bound value', 'UPDATE receipt_allocations SET amount = amount + ? WHERE id = ?'],
    ['a column times a bound value', 'SELECT subtotal * ? AS x FROM bills WHERE id = ?'],
    ['a bound value minus a column', 'SELECT ? - discount AS x FROM bills'],
    ['a money column compared with a bound value', 'SELECT id FROM receipts WHERE amount = ?'],
    ['a bound value compared with a money column', 'SELECT id FROM receipts WHERE ? <= amount'],
    ['a weight compared with a bound value', 'SELECT id FROM skus WHERE gross_weight > ? ORDER BY id'],
    ['a qualified column', 'SELECT s.id FROM skus s WHERE s.customer_net_weight >= ?'],
    ['BETWEEN with bound values', 'SELECT id FROM bills WHERE grand_total BETWEEN ? AND ?'],
    ['IN with bound values', 'SELECT id FROM receipts WHERE amount IN (?, ?)'],
    ['NOT IN with bound values', 'SELECT id FROM receipts WHERE amount NOT IN (?, ?)'],
    ['a sum compared with a bound value', 'SELECT customer_id FROM receipts GROUP BY customer_id HAVING SUM(amount) > ?'],
    ['a rounded column compared with a bound value', 'SELECT id FROM bills WHERE ROUND(grand_total, 0) = ?'],
    ['inside an ON DUPLICATE KEY UPDATE', 'INSERT INTO receipt_allocations (id, amount) VALUES (?, ?) ON DUPLICATE KEY UPDATE amount = amount + ?'],
    ['a template literal with a substituted table', 'SELECT id FROM __expr__ WHERE amount < ?'],
  ])('found: %s', (_label, sql) => {
    expect(found(sql).length, sql).toBeGreaterThan(0);
  });

  it.each([
    ['the same ROUND with CAST', 'SELECT ROUND(CAST(? AS DECIMAL(14,2)), 0) AS r'],
    ['an expression with CAST inside ROUND', 'SELECT ROUND(CAST(? AS DECIMAL(14,2)) * 1.18, 2) AS r'],
    ['a comparison with CAST', 'SELECT id FROM receipts WHERE amount = CAST(? AS DECIMAL(14,2))'],
    ['BETWEEN with CAST', 'SELECT id FROM bills WHERE grand_total BETWEEN CAST(? AS DECIMAL(14,2)) AND CAST(? AS DECIMAL(14,2))'],
    ['arithmetic with CAST', 'UPDATE receipt_allocations SET amount = amount + CAST(? AS DECIMAL(14,2)) WHERE id = ?'],
    ['CONVERT instead of CAST', 'SELECT id FROM receipts WHERE amount > CONVERT(?, DECIMAL(14,2))'],
    ['an assignment (the column converts the text exactly)', 'UPDATE receipts SET amount = ?, notes = ? WHERE id = ?'],
    ['an assignment after ON DUPLICATE KEY UPDATE', 'INSERT INTO receipts (id, amount) VALUES (?, ?) ON DUPLICATE KEY UPDATE amount = ?'],
    ['an insert', 'INSERT INTO receipts (id, customer_id, amount) VALUES (?, ?, ?)'],
    ['an id, a date, a status and a counter compared with a bound value', "SELECT id FROM bills WHERE customer_id = ? AND bill_date >= ? AND status = ? AND updated_at > ? OR (updated_at = ? AND id > ?)"],
    ['a count compared with a bound value', 'SELECT 1 WHERE (SELECT COUNT(*) FROM design_photos p WHERE p.design_id = ?) < ?'],
    ['a byte sum plus a bound size (integers, not money)', 'SELECT 1 WHERE (SELECT COALESCE(SUM(p.byte_size), 0) FROM design_photos p) + ? <= ?'],
    ['an interval', 'SELECT id FROM sessions WHERE last_seen_at > NOW() - INTERVAL ? SECOND'],
    ['a LIMIT', 'SELECT id FROM receipts WHERE customer_id = ? LIMIT ?'],
    ['text in a string literal', "SELECT 'amount = ?' AS note FROM bills WHERE id = ?"],
    ['no bound value at all', 'SELECT ROUND(amount, 0) FROM receipts WHERE amount > 0'],
  ])('allowed: %s', (_label, sql) => {
    expect(found(sql), sql).toEqual([]);
  });

  it('the real code: no statement in src/ and no query file in db/queries breaks the rule', () => {
    const statements = statementsIn(join(REPO, 'src'), REPO);
    const queryFiles = readdirSync(join(REPO, 'db', 'queries'))
      .filter((f) => f.endsWith('.sql'))
      .map((f) => ({ file: join('db', 'queries', f), line: 1, text: readFileSync(join(REPO, 'db', 'queries', f), 'utf8') }));
    expect(queryFiles.length).toBeGreaterThanOrEqual(11);
    expect(moneyParamHits([...statements, ...queryFiles], money)).toEqual([]);
  });

  it('a bound money parameter in ROUND planted in a scratch source file is found, and the folder is clean when it is taken away', () => {
    const dir = scratchDir();
    mkdirSync(join(dir, 'src'));
    const file = join(dir, 'src', 'planted.ts');
    writeFileSync(file, "export const q = 'SELECT ROUND(?, 0) AS r';\nexport const ok = 'SELECT ROUND(CAST(? AS DECIMAL(14,2)), 0) AS r';\n");
    const hits = moneyParamHits(statementsIn(join(dir, 'src'), dir), money);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ file: join('src', 'planted.ts'), line: 1 });
    rmSync(file);
    writeFileSync(file, "export const ok = 'SELECT ROUND(CAST(? AS DECIMAL(14,2)), 0) AS r';\n");
    expect(moneyParamHits(statementsIn(join(dir, 'src'), dir), money)).toEqual([]);
  });
});

// ------------------------------------------------------------------ S7: nothing deletes

describe('T-D11 no statement in the code starts with DELETE, TRUNCATE, DROP or ALTER (S7; T-D07 reads the same code with its own scanner)', () => {
  const verbs = /^(DELETE|TRUNCATE|DROP|ALTER)\s/i;
  const forbidden = (text: string) => verbs.test(text.replace(/^(?:\s|\(|\/\*[\s\S]*?\*\/|--[^\n]*\n|#[^\n]*\n)+/, '')) && !/^ALTER\s+ROUTINE\b/i.test(text.trim());
  const hits = (dir: string) => sourceFiles(dir).flatMap((f) => stringLiterals(f, readFileSync(f, 'utf8')).filter((l) => forbidden(l.text)).map((l) => `${f}:${l.line}`));

  it('src/ has none', () => {
    expect(hits(join(REPO, 'src'))).toEqual([]);
  });

  it('a DELETE string planted in a scratch source file is found, and the folder is clean when it is taken away', () => {
    const dir = scratchDir();
    const file = join(dir, 'planted.ts');
    writeFileSync(file, "export const gone = 'DELETE FROM customers WHERE id = ?';\n");
    expect(hits(dir)).toEqual([`${file}:1`]);
    writeFileSync(file, "export const kept = 'SELECT id FROM customers WHERE id = ?';\n");
    expect(hits(dir)).toEqual([]);
    expect(isStatement("export const kept = 'SELECT id FROM customers'")).toBe(false); // a literal is judged by its own text, not by the line around it
  });
});

// ------------------------------------------------------------------ S11: the pool

describe('T-D11 no code opens a database connection outside the pool (S11, T-F08)', () => {
  const POOL = join('src', 'db', 'pool.ts');
  const hitsIn = (dir: string, root: string) => sourceFiles(dir).flatMap((f) => connectionOpeners(f, readFileSync(f, 'utf8')).map((h) => ({ ...h, file: relative(root, f) })));

  it('src/ opens a connection (or a socket) in src/db/pool.ts only', () => {
    const all = hitsIn(join(REPO, 'src'), REPO);
    expect(all.filter((h) => h.file !== POOL)).toEqual([]);
    expect(all.some((h) => h.file === POOL)).toBe(true); // the scanner sees the pool itself: it is the one place
  });

  it.each([
    ['a value import of the driver', "import mysql from 'mysql2/promise';\nexport const x = mysql;"],
    ['the callback API of the driver', "import { createConnection } from 'mysql2';\ncreateConnection({});"],
    ['createConnection on any object', 'declare const m: any; m.createConnection({ host: "127.0.0.1" });'],
    ['createPool', 'declare const m: any; m.createPool({});'],
    ['require', "const m = require('mysql2');"],
    ['a dynamic import', "const m = await import('mysql2/promise');"],
    ['a mariadb driver', "import mariadb from 'mariadb';\nexport default mariadb;"],
    ['a socket made by hand', "import net from 'node:net';\nconst s = new net.Socket();"],
    ['net.connect', "import * as net from 'net';\nnet.connect(3306, '127.0.0.1');"],
  ])('found: %s', (_label, source) => {
    expect(connectionOpeners('planted.ts', source).length, source).toBeGreaterThan(0);
  });

  it.each([
    ['a type-only import', "import type { PoolConnection } from 'mysql2/promise';\nexport type C = PoolConnection;"],
    ['an import of types only, inline', "import { type ResultSetHeader } from 'mysql2/promise';\nexport type R = ResultSetHeader;"],
    ['using the pool', "import { createDbPool } from './pool.js';\nexport const p = createDbPool;"],
    ['a word in a string or a comment', "// createConnection is only in the pool\nexport const s = 'mysql2 createPool';"],
  ])('allowed: %s', (_label, source) => {
    expect(connectionOpeners('ok.ts', source)).toEqual([]);
  });

  it('a connection planted in a scratch handler is found, and the folder is clean when it is taken away', () => {
    const dir = scratchDir();
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src', 'pool.ts'), "import mysql from 'mysql2/promise';\nexport const pool = mysql.createPool({});\n");
    const handler = join(dir, 'src', 'handler.ts');
    writeFileSync(handler, "import mysql from 'mysql2/promise';\nexport const open = () => mysql.createConnection({ host: '127.0.0.1' });\n");
    const outside = hitsIn(join(dir, 'src'), dir).filter((h) => h.file !== join('src', 'pool.ts'));
    expect(outside.map((h) => h.what)).toEqual(['imports the database driver mysql2/promise', 'calls createConnection()']);
    rmSync(handler);
    expect(hitsIn(join(dir, 'src'), dir).filter((h) => h.file !== join('src', 'pool.ts'))).toEqual([]);
  });
});

// ------------------------------------------------------------------ S9: migration files

describe('T-D11 a migration file holds only statements of the list of S9 (the runner and this check use one function)', () => {
  it('a planted DELETE, DROP, REPLACE or view in a scratch migrations folder is found, and the folder is clean when it is taken away', () => {
    const dir = scratchDir();
    const file = join(dir, '0099_planted.sql');
    const problems = () => readdirSync(dir).filter((f) => f.endsWith('.sql')).flatMap((f) => checkSql(readFileSync(join(dir, f), 'utf8'), 'migration').map((v) => `${f}: ${v.reason}`));
    writeFileSync(file, 'CREATE TABLE IF NOT EXISTS zz (id INT NOT NULL PRIMARY KEY);\nDELETE FROM zz;\n');
    expect(problems()).toEqual(['0099_planted.sql: DELETE is refused: nothing is ever deleted (S7)']);
    writeFileSync(file, 'CREATE TABLE IF NOT EXISTS zz (id INT NOT NULL PRIMARY KEY);\n');
    expect(problems()).toEqual([]);
  });
});
