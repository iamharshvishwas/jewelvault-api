import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { StatementRefusedError, checkStatement } from '../../src/db/stmt';
import { type Scratch, errorOf, scratchDatabase } from '../helpers';
import { REPO } from './support';

// T-D07 (S7, A3, A7): nobody deletes. The API never issues DELETE, TRUNCATE or DROP (the one statement wrapper refuses them, and this test lists every hit in the code),
// and the one database user has Delete and Drop unticked, so MariaDB itself answers error 1142.

describe('T-D07 the statement wrapper refuses DELETE, TRUNCATE, DROP and ALTER (and REPLACE), however they are written', () => {
  const refused = (sql: string, params: unknown[] = []) => {
    try {
      checkStatement(sql, params as never);
      return null;
    } catch (e) {
      return e as StatementRefusedError;
    }
  };

  it.each([
    ['DELETE FROM categories', 'verb'],
    ['delete from categories where id = ?', 'verb'],
    ['  \n\t DELETE FROM categories', 'verb'],
    ['/* a comment first */ DELETE FROM categories', 'verb'],
    ['-- a comment\nDELETE FROM categories', 'verb'],
    ['# a comment\nDELETE FROM categories', 'verb'],
    ['(DELETE FROM categories)', 'verb'],
    ['DELETE LOW_PRIORITY QUICK IGNORE FROM categories', 'verb'],
    ['TRUNCATE TABLE audit_log', 'verb'],
    ['truncate audit_log', 'verb'],
    ['DROP TABLE categories', 'verb'],
    ['DROP TABLE IF EXISTS categories', 'verb'],
    ['DROP TRIGGER trg_audit_log_no_update', 'verb'],
    ['DROP DATABASE jv', 'verb'],
    ['ALTER TABLE categories ADD COLUMN x INT', 'verb'],
    ['alter table categories drop column prefix', 'verb'],
    ['WITH gone AS (SELECT id FROM categories) DELETE FROM categories WHERE id IN (SELECT id FROM gone)', 'verb'],
    ['SELECT 1; DELETE FROM categories', 'multiple'],
    ['SELECT 1;SELECT 2', 'multiple'],
    ['REPLACE INTO categories (id, name, prefix) VALUES (?, ?, ?)', 'replace'],
    ['replace into categories set name = ?', 'replace'],
    ['/* x */ REPLACE categories SET name = ?', 'replace'],
  ])('%s is refused (%s)', (sql, rule) => {
    const e = refused(sql, sql.includes('?') ? Array(sql.split('?').length - 1).fill('x') : []);
    expect(e).toBeInstanceOf(StatementRefusedError);
    expect(e!.rule).toBe(rule);
    expect(e!.message).not.toMatch(/^(DELETE|TRUNCATE|DROP|ALTER)\b/i); // the refusal itself is not a statement that starts with a refused word (the grep below)
  });

  it.each([
    'SELECT id FROM customers WHERE id = ? FOR UPDATE',
    'INSERT INTO categories (id, name, prefix) VALUES (?, ?, ?)',
    'INSERT INTO sys_idempotency (request_id, fn, actor, args_hash, claim_token) VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE request_id = request_id',
    'UPDATE sys_counters SET last_value = LAST_INSERT_ID(last_value + 1) WHERE series = ?',
    'UPDATE designs SET archived_at = ? WHERE id = ?',
    "UPDATE customers SET name = REPLACE(name, 'a', 'b') WHERE id = ?", // the string function REPLACE is not REPLACE INTO
    'SELECT TRUNCATE(amount, 0) AS whole FROM receipts', // nor is the function TRUNCATE the statement
    'SELECT deleted_at, dropped, altered_by FROM t', // words that only contain the refused ones
    "SELECT 'DELETE FROM x; DROP TABLE y' AS text",
    'SELECT `delete`, `drop` FROM t',
    "UPDATE sys_login_attempts SET failures = 0 /* reset in place, never deleted */ WHERE scope = 'email'",
    'WITH x AS (SELECT 1 AS one) SELECT one FROM x',
    'SET @jv_actor = ?, @jv_role = ?, @jv_request = ?',
  ])('%s is allowed', (sql) => {
    const n = sql.split('?').length - 1;
    expect(refused(sql, Array(n).fill('x'))).toBeNull();
  });

  it('the refusal happens before a statement is sent: the error is a StatementRefusedError carrying its rule and the first word, not the statement text with its values', () => {
    const e = refused('DELETE FROM customers WHERE pan = ?', ['ABCDE1234F'])!;
    expect(e.name).toBe('StatementRefusedError');
    expect(e.message).not.toContain('ABCDE1234F');
  });

  it('parameters: only text, numbers, booleans, null and Buffers (one ? for each value)', () => {
    for (const ok of ['a', 1, 1.5, true, false, null, Buffer.from('x')]) expect(refused('SELECT ?', [ok])).toBeNull();
    for (const bad of [{}, [], new Date(), undefined, Number.NaN, Number.POSITIVE_INFINITY, 1n, new Map(), () => 1]) expect(refused('SELECT ?', [bad])?.rule, String(bad)).toBe('parameter');
    expect(refused('SELECT ?, ?', ['a'])?.rule).toBe('parameter'); // fewer values than ?
    expect(refused('SELECT ?', ['a', 'b'])?.rule).toBe('parameter'); // more values than ?
    expect(refused("SELECT '?' AS q, ?", ['a'])).toBeNull(); // a ? inside a string is not a placeholder
  });

  it('read-only mode (withRead) allows SELECT and WITH only', () => {
    const readOnly = (sql: string) => {
      try {
        checkStatement(sql, [], { readOnly: true });
        return null;
      } catch (e) {
        return (e as StatementRefusedError).rule;
      }
    };
    expect(readOnly('SELECT 1')).toBeNull();
    expect(readOnly('  /* c */ select 1')).toBeNull();
    expect(readOnly('WITH x AS (SELECT 1 AS a) SELECT a FROM x')).toBeNull();
    expect(readOnly('UPDATE t SET a = 1')).toBe('read_only');
    expect(readOnly('INSERT INTO t VALUES (1)')).toBe('read_only');
    expect(readOnly('SET @a = 1')).toBe('read_only');
    expect(readOnly('DELETE FROM t')).toBe('verb');
  });
});

describe('T-D07 a grep lists every hit in the code: no statement starts with DELETE, TRUNCATE, DROP or ALTER outside the migration runner', () => {
  // A hit is a string or template literal whose text STARTS (after space, comments and brackets) with one of the four words and a space. The source is read with the TypeScript parser,
  // so words in comments, in regular expressions or in prose are not statements and a quotation mark inside a comment cannot hide a literal. ALTER ROUTINE is the name of one of the
  // 18 boxes of A3 (a privilege), not a statement. The migration runner is the one exception named by A7 and S7.
  const STATEMENT = /^(DELETE|TRUNCATE|DROP|ALTER)\s/i;
  const PRIVILEGE_NAME = /^ALTER\s+ROUTINE\b/i;
  const strip = (t: string) => t.replace(/^(?:\s|\(|\/\*[\s\S]*?\*\/|--[^\n]*\n|#[^\n]*\n)+/, '');
  const isStatement = (text: string) => STATEMENT.test(strip(text)) && !PRIVILEGE_NAME.test(strip(text));

  function literals(file: string, source: string): { text: string; line: number }[] {
    const sf = ts.createSourceFile(file, source, ts.ScriptTarget.ES2022, true, file.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS);
    const out: { text: string; line: number }[] = [];
    const visit = (n: ts.Node) => {
      if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateHead(n)) out.push({ text: n.text, line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1 });
      ts.forEachChild(n, visit);
    };
    visit(sf);
    return out;
  }

  function files(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) return files(p);
      return /\.(ts|mts|mjs|js)$/.test(name) && !/\.d\.mts$/.test(name) ? [p] : [];
    });
  }
  function hits(dir: string): { file: string; line: number; text: string }[] {
    return files(dir).flatMap((f) =>
      literals(f, readFileSync(f, 'utf8'))
        .filter((l) => isStatement(l.text))
        .map((l) => ({ file: relative(REPO, f), line: l.line, text: l.text.slice(0, 60) })),
    );
  }

  it('the scanner can see a statement (control): it finds the words at the start of a literal and ignores them in prose, comments, regular expressions and privilege names', () => {
    const sample = [
      'const a = "DELETE FROM t";',
      "const b = `  drop table x`;",
      "const c = 'this is a note about DELETE FROM';",
      "// DELETE FROM t (a comment with an apostrophe: it's not a literal)",
      "const d = ['DELETE', 'ALTER ROUTINE'];",
      "const e = /[`]/g; const f = `TRUNCATE TABLE ${t}`;",
      'const g = /* x */ "ALTER TABLE t";',
    ].join('\n');
    expect(literals('sample.mjs', sample).filter((l) => isStatement(l.text)).map((l) => l.text)).toEqual(['DELETE FROM t', '  drop table x', 'TRUNCATE TABLE ', 'ALTER TABLE t']);
  });

  it('src/ (the running API) has no such statement at all', () => {
    expect(hits(join(REPO, 'src'))).toEqual([]);
  });

  it('scripts/ (the tools): the migration runner is excepted; the hits that remain are test-lane and trigger-file tooling that never runs inside the API, each named here', () => {
    const found = hits(join(REPO, 'scripts')).filter((h) => h.file !== join('scripts', 'migrate.mjs'));
    const byFile = found.reduce<Record<string, number>>((acc, h) => ({ ...acc, [h.file]: (acc[h.file] ?? 0) + 1 }), {});
    expect(byFile).toEqual({
      // the lane tool drops a lane's own databases and users as root, inside the local test container only
      [join('scripts', 'lane.mjs')]: 3,
      // the generator of db/optional/0910_audit_triggers.sql writes DROP TRIGGER IF EXISTS into that file; the migration runner applies it
      [join('scripts', 'audit-triggers.mjs')]: 2,
    });
  });
});

describe('T-D07 on the local ten-box user, DELETE, DROP TABLE and TRUNCATE are refused by MariaDB itself with error 1142', () => {
  let scratch: Scratch;
  beforeAll(async () => {
    scratch = await scratchDatabase('d07', { schema: true });
  }, 120_000);
  afterAll(async () => {
    await scratch?.drop();
  }, 60_000);

  it('DELETE, DROP TABLE (also IF EXISTS), TRUNCATE and REPLACE INTO are 1142; INSERT, UPDATE, CREATE and ALTER are allowed (schema changes keep Alter, Create, Index, References, Trigger)', async () => {
    const u = await scratch.connect();
    await u.query("INSERT INTO categories (id, name, prefix) VALUES (UUID(), 'Rings', 'RG')");
    for (const sql of ['DELETE FROM categories', 'DELETE FROM categories WHERE 1 = 0', 'DROP TABLE categories', 'DROP TABLE IF EXISTS categories', 'DROP TABLE IF EXISTS nothing_here', 'TRUNCATE TABLE categories', 'TRUNCATE categories', "REPLACE INTO categories (id, name, prefix) VALUES (UUID(), 'Rings', 'RG')"]) {
      const e = await errorOf(() => u.query(sql));
      expect(e?.errno, sql).toBe(1142);
    }
    const [[row]] = await u.query<any[]>('SELECT COUNT(*) AS n FROM categories');
    expect(Number(row.n)).toBe(1); // nothing was removed
    expect(await errorOf(() => u.query("UPDATE categories SET name = 'Ring' WHERE name = 'Rings'"))).toBeNull();
    expect(await errorOf(() => u.query('ALTER TABLE categories ADD COLUMN d07_probe INT NULL'))).toBeNull();
    await u.end();
  });
});
