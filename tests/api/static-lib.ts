import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

// The checkers behind T-D11 (A7) and T-D29 (U10, H3): pure functions that take text, a folder or a catalogue and return the problems they find, so that a test can run each one on the real
// repository AND on a planted violation (a scratch folder, a made-up statement) and see it fail, then pass once the violation is gone.
//
// Nothing here holds a secret-shaped string: the words the scan looks for are put together from pieces, so that this file is not a hit of its own scan.

// ------------------------------------------------------------------ SQL inside source code

/** The marker a template literal's ${...} leaves in the text: it reads as one identifier. */
export const SUBSTITUTION = '__expr__';

export interface SqlLiteral {
  file: string;
  line: number;
  text: string;
}

/** Every string and template literal of a source file, as the TypeScript parser sees them (not the words of comments, regular expressions or prose). */
export function stringLiterals(file: string, source: string): SqlLiteral[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.ES2022, true, /\.(ts|mts)$/.test(file) ? ts.ScriptKind.TS : ts.ScriptKind.JS);
  const out: SqlLiteral[] = [];
  const line = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const visit = (n: ts.Node) => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) out.push({ file, line: line(n), text: n.text });
    else if (ts.isTemplateExpression(n)) {
      out.push({ file, line: line(n), text: n.head.text + n.templateSpans.map((s) => ` ${SUBSTITUTION} ${s.literal.text}`).join('') });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

const COMMENT_OR_BRACKET = /^(?:\s|\(|\/\*[\s\S]*?\*\/|--[^\n]*\n|#[^\n]*\n)+/;
export const stripLeading = (sql: string) => sql.replace(COMMENT_OR_BRACKET, '');

/** A literal that is a statement: it starts (after white space, comments and brackets) with a statement word and a space. Prose that merely begins with "select" is told apart by needing more than the word. */
export function isStatement(text: string): boolean {
  const t = stripLeading(text);
  if (/^(SELECT|WITH)\s/i.test(t)) return /\b(FROM|SELECT|AS)\b/i.test(t) && t.length > 12;
  if (/^UPDATE\s/i.test(t)) return /\bSET\b/i.test(t);
  if (/^INSERT\s/i.test(t)) return /\b(INTO|VALUES|SELECT)\b/i.test(t);
  if (/^(DELETE|REPLACE)\s/i.test(t)) return /\b(FROM|INTO|SET)\b/i.test(t);
  return false;
}

export function sourceFiles(dir: string, pattern = /\.(ts|mts|mjs|js)$/): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return name === 'node_modules' ? [] : sourceFiles(p, pattern);
    return pattern.test(name) && !/\.d\.mts$/.test(name) ? [p] : [];
  });
}

/** The statements in the source files of a folder: file (relative to root), line and text. */
export function statementsIn(dir: string, root: string): SqlLiteral[] {
  return sourceFiles(dir).flatMap((f) =>
    stringLiterals(f, readFileSync(f, 'utf8'))
      .filter((l) => isStatement(l.text))
      .map((l) => ({ ...l, file: relative(root, f) })),
  );
}

// ------------------------------------------------------------------ a small SQL tokenizer

type TokenKind = 'id' | 'num' | 'str' | 'ph' | 'op' | 'punct';
export interface Token {
  kind: TokenKind;
  /** upper-case text for an identifier or word, as written for the rest */
  text: string;
  /** the last part of a dotted name: s.amount -> amount (as written, lower-cased) */
  name: string;
}

/** Splits the SQL into words, numbers, strings, ?, operators and brackets. Comments are dropped. A quoted name `x` is an identifier. */
export function tokenize(sql: string): Token[] {
  const out: Token[] = [];
  const n = sql.length;
  for (let i = 0; i < n; ) {
    const ch = sql[i];
    const next = sql[i + 1];
    if (/\s/.test(ch)) {
      i++;
    } else if (ch === '#' || (ch === '-' && next === '-' && /\s|^$/.test(sql[i + 2] ?? ' '))) {
      while (i < n && sql[i] !== '\n') i++;
    } else if (ch === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end < 0 ? n : end + 2;
    } else if (ch === "'" || ch === '"') {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === '\\') j += 2;
        else if (sql[j] === ch && sql[j + 1] === ch) j += 2;
        else if (sql[j] === ch) break;
        else j++;
      }
      out.push({ kind: 'str', text: sql.slice(i, j + 1), name: '' });
      i = j + 1;
    } else if (ch === '`' || /[A-Za-z_]/.test(ch)) {
      // a possibly dotted name: a.b, `a`.`b`
      let j = i;
      const parts: string[] = [];
      for (;;) {
        if (sql[j] === '`') {
          let k = j + 1;
          while (k < n && !(sql[k] === '`' && sql[k + 1] !== '`')) k += sql[k] === '`' ? 2 : 1;
          parts.push(sql.slice(j + 1, k));
          j = k + 1;
        } else {
          let k = j;
          while (k < n && /[A-Za-z0-9_$]/.test(sql[k])) k++;
          if (k === j) break;
          parts.push(sql.slice(j, k));
          j = k;
        }
        if (sql[j] === '.' && /[A-Za-z_`]/.test(sql[j + 1] ?? '')) j++;
        else break;
      }
      const text = sql.slice(i, j);
      out.push({ kind: 'id', text: parts.length === 1 ? text.replace(/`/g, '').toUpperCase() : text, name: parts[parts.length - 1].toLowerCase() });
      i = j;
    } else if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(next ?? ''))) {
      let j = i + 1;
      while (j < n && /[0-9.eE]/.test(sql[j])) j++;
      out.push({ kind: 'num', text: sql.slice(i, j), name: '' });
      i = j;
    } else if (ch === '?') {
      out.push({ kind: 'ph', text: '?', name: '' });
      i++;
    } else if (ch === '(' || ch === ')' || ch === ',') {
      out.push({ kind: 'punct', text: ch, name: '' });
      i++;
    } else {
      const three = sql.slice(i, i + 3);
      const two = sql.slice(i, i + 2);
      const op = three === '<=>' ? three : ['<=', '>=', '<>', '!=', ':=', '||', '&&', '<<', '>>'].includes(two) ? two : ch;
      out.push({ kind: 'op', text: op, name: '' });
      i += op.length;
    }
  }
  return out;
}

const word = (t: Token | undefined, ...words: string[]) => t?.kind === 'id' && words.includes(t.text);

// ------------------------------------------------------------------ S3: no bound money or weight in arithmetic, ROUND or a comparison without CAST

const COMPARISON = new Set(['=', '<=>', '<>', '!=', '<', '>', '<=', '>=']);
const ARITHMETIC = new Set(['+', '-', '*', '/', '%']);
/** Functions whose argument is a number: a text parameter handed to one becomes a DOUBLE. */
const NUMERIC_FUNCTIONS = new Set(['ROUND', 'TRUNCATE', 'FLOOR', 'CEIL', 'CEILING', 'ABS', 'SIGN', 'MOD', 'POW', 'POWER', 'SQRT', 'SUM', 'AVG']);
/** Functions that round: anything bound inside them, however deep in the expression, is rounded as a DOUBLE. */
const ROUNDING_FUNCTIONS = new Set(['ROUND', 'TRUNCATE', 'FLOOR', 'CEIL', 'CEILING']);

export interface MoneyParamProblem {
  /** which ? of the statement, from 1 */
  placeholder: number;
  reason: string;
  sql: string;
}

/** Index of the "(" that matches the ")" at position i, or -1. */
function openerOf(tokens: Token[], i: number): number {
  let depth = 0;
  for (let k = i; k >= 0; k--) {
    if (tokens[k].text === ')' && tokens[k].kind === 'punct') depth++;
    else if (tokens[k].text === '(' && tokens[k].kind === 'punct' && --depth === 0) return k;
  }
  return -1;
}
function closerOf(tokens: Token[], i: number): number {
  let depth = 0;
  for (let k = i; k < tokens.length; k++) {
    if (tokens[k].text === '(' && tokens[k].kind === 'punct') depth++;
    else if (tokens[k].text === ')' && tokens[k].kind === 'punct' && --depth === 0) return k;
  }
  return -1;
}

/** Does the operand next to a placeholder (a name, or a bracketed expression ending or starting there) involve a money or weight column? */
function operandIsMoney(tokens: Token[], at: number, direction: -1 | 1, money: ReadonlySet<string>): boolean {
  const t = tokens[at];
  if (!t) return false;
  if (t.kind === 'id') {
    if (direction === -1 && tokens[at + 1]?.text === '(' && tokens[at + 1].kind === 'punct') return false; // a function name: handled by its bracket
    return money.has(t.name);
  }
  if (t.kind === 'punct' && ((direction === -1 && t.text === ')') || (direction === 1 && t.text === '('))) {
    const open = direction === -1 ? openerOf(tokens, at) : at;
    const close = direction === -1 ? at : closerOf(tokens, at);
    if (open < 0 || close < 0) return false;
    // a bracket that is a CAST or CONVERT is a typed value, not a column
    if (word(tokens[open - 1], 'CAST', 'CONVERT')) return false;
    return tokens.slice(open + 1, close).some((x) => x.kind === 'id' && money.has(x.name));
  }
  return false;
}

/**
 * S3: "a money or weight value bound as a text parameter is never used in SQL arithmetic, ROUND or a comparison" (MariaDB turns the text into a DOUBLE there). A parameter that is
 *  - an argument of ROUND, TRUNCATE, FLOOR, CEIL, ABS and the like,
 *  - an operand of + - * / % next to a money or weight column (or a bracket that holds one),
 *  - compared (= <> < > <= >= <=>, BETWEEN, IN) with a money or weight column,
 * without CAST(? AS DECIMAL(..)) around it, is a problem. An assignment (SET amount = ?, INSERT ... VALUES (?)) is not: the column converts the text exactly.
 * `money` is the set of DECIMAL column names of the schema.
 */
export function moneyParamProblems(sql: string, money: ReadonlySet<string>): MoneyParamProblem[] {
  const tokens = tokenize(sql);
  const problems: MoneyParamProblem[] = [];
  // the brackets that are open at each position, to know the function around a placeholder
  const stack: { fn: string | null; open: number }[] = [];
  let placeholder = 0;
  let inSetList = false; // between SET (or ON DUPLICATE KEY UPDATE) and WHERE: an = after a column name there is an assignment
  const flag = (reason: string) => problems.push({ placeholder, reason, sql: sql.length > 160 ? `${sql.slice(0, 157)}...` : sql });
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.kind === 'punct' && t.text === '(') {
      const before = tokens[i - 1];
      stack.push({ fn: before?.kind === 'id' ? before.text : null, open: i });
      continue;
    }
    if (t.kind === 'punct' && t.text === ')') {
      stack.pop();
      continue;
    }
    if (stack.length === 0 && t.kind === 'id') {
      if (t.text === 'SET') inSetList = true;
      else if (t.text === 'UPDATE' && word(tokens[i - 1], 'KEY')) inSetList = true;
      else if (['WHERE', 'ORDER', 'LIMIT', 'HAVING', 'GROUP', 'FROM', 'RETURNING'].includes(t.text)) inSetList = false;
    }
    if (t.kind !== 'ph') continue;
    placeholder++;
    const prev = tokens[i - 1];
    const next = tokens[i + 1];
    const wrapped = prev?.text === '(' && word(tokens[i - 2], 'CAST', 'CONVERT');
    if (wrapped) continue;
    const top = stack[stack.length - 1];
    // inside a rounding function, or a direct argument of a numeric one: ROUND(?, 0), ROUND(? / 3, 2), ABS(?)
    if (top?.fn && (ROUNDING_FUNCTIONS.has(top.fn) || (NUMERIC_FUNCTIONS.has(top.fn) && (prev?.text === '(' || prev?.text === ',')))) {
      flag(`a bound parameter is used inside ${top.fn}() without CAST(? AS DECIMAL(..)) (S3)`);
      continue;
    }
    // arithmetic next to a money column
    const arithBefore = prev?.kind === 'op' && ARITHMETIC.has(prev.text);
    const arithAfter = next?.kind === 'op' && ARITHMETIC.has(next.text);
    if (arithBefore && operandIsMoney(tokens, i - 2, -1, money)) {
      flag(`a bound parameter is used in arithmetic with a money or weight column without CAST (S3)`);
      continue;
    }
    if (arithAfter && !word(tokens[i + 2], 'INTERVAL') && operandIsMoney(tokens, i + 2, 1, money)) {
      flag(`a bound parameter is used in arithmetic with a money or weight column without CAST (S3)`);
      continue;
    }
    // comparison with a money column: col = ?, ? < col, col BETWEEN ? AND ?, col IN (?, ?)
    let peer = -1;
    let peerDirection: -1 | 1 = -1;
    if (prev?.kind === 'op' && COMPARISON.has(prev.text)) {
      const isAssignment = prev.text === '=' && inSetList && stack.length === 0 && tokens[i - 2]?.kind === 'id' && (word(tokens[i - 3], 'SET') || tokens[i - 3]?.text === ',' || word(tokens[i - 3], 'UPDATE'));
      if (!isAssignment) peer = i - 2;
    } else if (next?.kind === 'op' && COMPARISON.has(next.text)) {
      peer = i + 2;
      peerDirection = 1;
    } else if (word(prev, 'BETWEEN')) {
      peer = i - 2;
    } else if (word(prev, 'AND') && tokens[i - 2]?.kind === 'ph' && word(tokens[i - 3], 'BETWEEN')) {
      peer = i - 4;
    } else if (word(prev, 'AND') && tokens[i - 2]?.kind === 'punct' && tokens[i - 2].text === ')' && word(tokens[openerOf(tokens, i - 2) - 1], 'CAST', 'CONVERT')) {
      const between = (() => {
        for (let k = openerOf(tokens, i - 2) - 2; k >= 0; k--) if (word(tokens[k], 'BETWEEN')) return k;
        return -1;
      })();
      if (between > 0) peer = between - 1;
    } else if ((prev?.text === '(' || prev?.text === ',') && top && word(tokens[top.open - 1], 'IN')) {
      peer = word(tokens[top.open - 2], 'NOT') ? top.open - 3 : top.open - 2;
    }
    if (peer >= 0 && operandIsMoney(tokens, peer, peerDirection, money)) flag('a bound parameter is compared with a money or weight column without CAST (S3)');
  }
  return problems;
}

/** The statements of a source folder and the .sql query files, checked with moneyParamProblems. */
export function moneyParamHits(statements: readonly SqlLiteral[], money: ReadonlySet<string>): { file: string; line: number; reason: string; sql: string }[] {
  return statements.flatMap((s) => moneyParamProblems(s.text, money).map((p) => ({ file: s.file, line: s.line, reason: `parameter ${p.placeholder}: ${p.reason}`, sql: p.sql })));
}

// ------------------------------------------------------------------ S11: no connection outside the pool

const DRIVER_MODULES = new Set(['mysql2', 'mysql2/promise', 'mysql', 'mariadb', 'mariadb/callback', 'pg', 'knex', 'sequelize', 'typeorm', 'prisma', '@prisma/client', 'drizzle-orm']);
const SOCKET_MODULES = new Set(['net', 'node:net', 'tls', 'node:tls', 'dgram', 'node:dgram', 'http2', 'node:http2']);
const OPENERS = new Set(['createConnection', 'createPool', 'createPoolCluster', 'createConnectionPromise', 'createPoolPromise', 'createPoolClusterPromise']);

export interface OpenerHit {
  file: string;
  line: number;
  what: string;
}

/**
 * Code that could open a database connection: a value import of a database driver, a call of createConnection, createPool or createPoolCluster, require('mysql2'), import('mysql2'),
 * and a socket made with net or tls (the pool opens its own socket through net.Socket). A type-only import costs nothing at run time and is fine.
 * Only the file that IS the pool is allowed to do these things: the caller leaves it out.
 */
export function connectionOpeners(file: string, source: string): OpenerHit[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.ES2022, true, /\.(ts|mts)$/.test(file) ? ts.ScriptKind.TS : ts.ScriptKind.JS);
  const hits: OpenerHit[] = [];
  const at = (n: ts.Node, what: string) => hits.push({ file, line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1, what });
  const bare = (spec: string) => spec.replace(/^node:/, '');
  const visit = (n: ts.Node) => {
    if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)) {
      const spec = n.moduleSpecifier.text;
      const clause = n.importClause;
      const typeOnly = !!clause && (clause.isTypeOnly || (!clause.name && !!clause.namedBindings && ts.isNamedImports(clause.namedBindings) && clause.namedBindings.elements.length > 0 && clause.namedBindings.elements.every((e) => e.isTypeOnly)));
      if (!typeOnly && (DRIVER_MODULES.has(spec) || spec.startsWith('mysql2/'))) at(n, `imports the database driver ${spec}`);
      if (!typeOnly && SOCKET_MODULES.has(spec)) at(n, `imports ${bare(spec)} (a socket)`);
    } else if (ts.isCallExpression(n)) {
      const callee = n.expression;
      const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : '';
      if (OPENERS.has(name)) at(n, `calls ${name}()`);
      const arg = n.arguments[0];
      if ((ts.isIdentifier(callee) && callee.text === 'require') || callee.kind === ts.SyntaxKind.ImportKeyword) {
        if (arg && ts.isStringLiteralLike(arg) && (DRIVER_MODULES.has(arg.text) || arg.text.startsWith('mysql2/') || SOCKET_MODULES.has(arg.text))) at(n, `loads ${arg.text} at run time`);
      }
      if (ts.isPropertyAccessExpression(callee) && ['connect'].includes(callee.name.text) && /^(net|tls|socket)$/i.test(callee.expression.getText(sf))) at(n, `calls ${callee.getText(sf)}()`);
    } else if (ts.isNewExpression(n)) {
      const t = n.expression.getText(sf);
      if (/^(net\.)?Socket$/.test(t) || /^(tls\.)?TLSSocket$/.test(t)) at(n, `makes a ${t}`);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return hits;
}

// ------------------------------------------------------------------ X0 (8): the pause hook exists only in the test build

const HOOK_POINT = /\bafter_(read|check)\b/;

/** `ctx.pause(...)`, any `.pause` taken from a name containing ctx, a call of a bare pause(), and the hook's point names (`bill.after_read`) in the compiled JavaScript of a folder. Comments do not count. */
export function pauseHookHits(dir: string): OpenerHit[] {
  return sourceFiles(dir, /\.(js|mjs|cjs)$/).flatMap((f) => {
    const source = readFileSync(f, 'utf8');
    const sf = ts.createSourceFile(f, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
    const hits: OpenerHit[] = [];
    const at = (n: ts.Node, what: string) => hits.push({ file: relative(dir, f), line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1, what });
    const visit = (n: ts.Node) => {
      if (ts.isPropertyAccessExpression(n) && n.name.text === 'pause' && /ctx$/i.test(n.expression.getText(sf))) at(n, `${n.getText(sf)} (the test hook)`);
      else if (ts.isElementAccessExpression(n) && ts.isStringLiteralLike(n.argumentExpression) && n.argumentExpression.text === 'pause' && /ctx/i.test(n.expression.getText(sf))) at(n, 'ctx["pause"] (the test hook)');
      else if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'pause') at(n, 'a call of pause()');
      else if (ts.isStringLiteralLike(n) && HOOK_POINT.test(n.text)) at(n, `the hook point name ${JSON.stringify(n.text)}`);
      ts.forEachChild(n, visit);
    };
    visit(sf);
    return hits;
  });
}

// ------------------------------------------------------------------ T-D29: what no tracked file may hold

const cat = (...parts: string[]) => parts.join('');

/** Needles are put together here so that this file is not a hit of the scan it implements. */
export const NEEDLES = { pemHeader: cat('-----', 'BEGIN'), supabaseSecret: cat('sb_', 'secret_'), adminPassword: cat('admin', '123'), staffPassword: cat('staff', '123') } as const;
export const FORBIDDEN_WORDS: readonly { kind: string; word: string }[] = [
  { kind: 'a private-key header', word: NEEDLES.pemHeader },
  { kind: 'the old Supabase secret prefix', word: NEEDLES.supabaseSecret },
  { kind: 'the old admin password', word: NEEDLES.adminPassword },
  { kind: 'the old staff password', word: NEEDLES.staffPassword },
];

/** Key-shaped strings (known formats) and URLs that carry a password. */
export const SECRET_PATTERNS: readonly { kind: string; pattern: RegExp }[] = [
  { kind: 'a URL with a password in it', pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/?#@:'"`<>()\\]+:[^\s/?#@'"`<>()\\]+@/i },
  { kind: 'an AWS access key id', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { kind: 'a GitHub token', pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{20,})/ },
  { kind: 'a Slack token', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  { kind: 'a Stripe key', pattern: /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}/ },
  { kind: 'a Google API key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { kind: 'a JSON web token', pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  // the name ENDS with the word (DB_PASSWORD, apiKey, authToken): password_hash and password_change are not secrets, and a test's fake hash is not a leak
  { kind: 'a long literal assigned to a secret-looking name', pattern: /(?:password|passwd|secret|secret[_-]?key|token|api[_-]?key|private[_-]?key|access[_-]?key|auth[_-]?key)["']?\s*[:=]\s*["'`][A-Za-z0-9+/=_.!@#$%^&*-]{20,}["'`]/i },
];

export interface SecretHit {
  file: string;
  line: number;
  kind: string;
}

/** Where a named word may appear: prose and code that quote the rule. Each exception is for one file (or a folder of documents) and one needle, never for the URL or key patterns. */
export interface SecretException {
  /** a path, or a folder ending in / */
  path: string;
  word: string;
  why: string;
}

const excepted = (file: string, word: string, exceptions: readonly SecretException[]) =>
  exceptions.some((e) => e.word === word && (e.path.endsWith('/') ? file.startsWith(e.path) : file === e.path));

/** The hits in one text. Never returns the matched text itself (a hit that is a real secret must not be copied into a report). */
export function scanForSecrets(file: string, text: string, exceptions: readonly SecretException[] = []): SecretHit[] {
  const hits: SecretHit[] = [];
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    if (/^\s*"(?:integrity|resolved)":/.test(line)) return; // the lock file's hashes and registry addresses
    for (const f of FORBIDDEN_WORDS) if (line.includes(f.word) && !excepted(file, f.word, exceptions)) hits.push({ file, line: i + 1, kind: f.kind });
    for (const p of SECRET_PATTERNS) if (p.pattern.test(line)) hits.push({ file, line: i + 1, kind: p.kind });
  });
  return hits;
}

/** The files git tracks, plus the new files it would track (not ignored): a secret must be found before the commit, not after. */
export function trackedFiles(root: string): string[] {
  const out = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return [...new Set(out.split('\0').filter(Boolean))].filter((f) => existsSync(join(root, f)));
}

const BINARY = /\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|woff2?|ttf|otf|sqlite|db)$/i;

export function scanRepository(root: string, exceptions: readonly SecretException[] = []): { scanned: number; hits: SecretHit[] } {
  const files = trackedFiles(root).filter((f) => !BINARY.test(f));
  const hits: SecretHit[] = [];
  let scanned = 0;
  for (const f of files) {
    const buf = readFileSync(join(root, f));
    if (buf.includes(0)) continue;
    scanned++;
    hits.push(...scanForSecrets(f, buf.toString('utf8'), exceptions));
  }
  return { scanned, hits };
}

/** Is `.env` ignored by git, and is any file named .env (or .env.something, except .env.example) among those git tracks or would track? */
export function envFileProblems(root: string): string[] {
  const problems: string[] = [];
  try {
    execFileSync('git', ['check-ignore', '-q', '.env'], { cwd: root, stdio: 'ignore' });
  } catch {
    problems.push('.env is not ignored by git (.gitignore)');
  }
  for (const f of trackedFiles(root)) if (/(^|\/)\.env(\..+)?$/.test(f) && !f.endsWith('.env.example')) problems.push(`${f} is tracked (or would be): only .env.example may be`);
  return problems;
}

/** `.env.example` holds names only: an assignment that is not commented out has no value; a commented one may show a default for the two settings that are not secret. */
export function envExampleProblems(text: string, defaultsAllowedFor: readonly string[] = ['PORT', 'LOG_LEVEL']): string[] {
  const problems: string[] = [];
  text.split('\n').forEach((raw, i) => {
    const line = raw.trim();
    if (!line) return;
    const live = /^([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
    const commented = /^#\s*([A-Z][A-Z0-9_]*)\s*=(.*)$/.exec(line);
    if (live && live[2].trim() !== '') problems.push(`line ${i + 1}: ${live[1]} has a value; .env.example holds names only`);
    if (commented && commented[2].trim() !== '' && !defaultsAllowedFor.includes(commented[1])) problems.push(`line ${i + 1}: ${commented[1]} (commented out) has a value; only ${defaultsAllowedFor.join(' and ')} may show a default`);
  });
  return problems;
}

// ------------------------------------------------------------------ the dependencies

export interface LockFile {
  packages: Record<string, { dev?: boolean; hasInstallScript?: boolean; version?: string; dependencies?: Record<string, string> }>;
}

/** Runtime packages (every entry of the lock file that is not dev-only) with an install script. */
export function installScriptPackages(lock: LockFile): string[] {
  return Object.entries(lock.packages)
    .filter(([path, p]) => path !== '' && !p.dev && p.hasInstallScript)
    .map(([path]) => path.replace(/^.*node_modules\//, ''));
}

/** The runtime dependency count: those the package asks for, and everything they pull in (the lock file's entries that are not dev-only). */
export function runtimeDependencyCount(lock: LockFile, pkg: { dependencies?: Record<string, string> }): { direct: number; total: number } {
  const total = Object.entries(lock.packages).filter(([path, p]) => path !== '' && !p.dev).length;
  return { direct: Object.keys(pkg.dependencies ?? {}).length, total };
}

/** The findings of `npm audit` at or above a level. Needs the network; a failure to ask is reported as such, never as "clean". */
export interface AuditResult {
  asked: boolean;
  problem?: string;
  counts?: Record<string, number>;
  findings: { name: string; severity: string; title: string }[];
}
export function parseAudit(json: string): AuditResult {
  let data: any;
  try {
    data = JSON.parse(json);
  } catch {
    return { asked: false, problem: 'npm audit did not answer with JSON', findings: [] };
  }
  if (data.error) return { asked: false, problem: `${data.error.code ?? 'error'}: ${String(data.error.summary ?? '').slice(0, 120)}`, findings: [] };
  const findings = Object.values<any>(data.vulnerabilities ?? {}).map((v) => ({
    name: String(v.name),
    severity: String(v.severity),
    title: (v.via ?? []).map((x: any) => (typeof x === 'object' ? String(x.title) : '')).find(Boolean) ?? '',
  }));
  return { asked: true, counts: data.metadata?.vulnerabilities, findings };
}
export const blocks = (f: { severity: string }) => f.severity === 'high' || f.severity === 'critical';

/** Runs npm audit (only the runtime tree with omitDev). Resolves with what it found; never throws for a finding. */
export function runAudit(root: string, omitDev: boolean): AuditResult {
  try {
    const out = execFileSync('npm', ['audit', '--json', ...(omitDev ? ['--omit=dev'] : [])], { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], timeout: 90_000 });
    return parseAudit(out);
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; status?: number };
    // npm audit exits 1 when it found something: the JSON is still on stdout
    if (err.stdout) return parseAudit(err.stdout);
    return { asked: false, problem: String(err.stderr ?? e).slice(0, 160), findings: [] };
  }
}
