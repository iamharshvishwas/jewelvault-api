// The one statement wrapper (S7, S12 (4), A7): every statement the API sends passes checkStatement first.
//
// - It refuses DELETE, TRUNCATE, DROP and ALTER (nobody deletes, S7; the user has no Delete or Drop box either, so MariaDB answers 1142 as well) and REPLACE (it deletes and inserts silently).
//   The words are looked for in the statement's code, not in its strings or comments, and anywhere in it, so that a WITH ... DELETE or a second statement after a ; does not pass.
//   The string function REPLACE(...) and the numeric function TRUNCATE(...) are not the statements and are allowed.
// - Parameters are text, numbers, booleans, null or Buffers, one for each ? : mysql2's query() expands an object into `col = val` pairs, so an object, an array, a Date, undefined, NaN, a bigint
//   are refused. An IN list gets one ? for each element; a JSON column is sent as JSON.stringify text.
// - A reader (withRead) may send SELECT and WITH only.
// Words inside a refusal's message never start the message: a test greps the code for statements that start with a refused word, and this file must not be a hit.

export type Param = string | number | boolean | null | Buffer;

export type StatementRule = 'parameter' | 'verb' | 'replace' | 'multiple' | 'read_only';

/** A bug in the code that built the statement, never the caller's fault: answered JV_INTERNAL with this as the cause. The message never holds a value. */
export class StatementRefusedError extends Error {
  readonly rule: StatementRule;
  constructor(rule: StatementRule, message: string) {
    super(message);
    this.name = 'StatementRefusedError';
    this.rule = rule;
  }
}

interface Scan {
  /** the words of the statement's code, upper case, with whether a ( follows each */
  words: { text: string; paren: boolean }[];
  placeholders: number;
  /** a second statement follows a ; */
  multiple: boolean;
}

/** Reads the statement's code: skips strings, `quoted` names and comments (a /*! ... *\/ comment is code to MariaDB and is read as code), counts the ? and the words. */
function scan(sql: string): Scan {
  const out: Scan = { words: [], placeholders: 0, multiple: false };
  const n = sql.length;
  let semicolon = false;
  let conditional = 0; // inside /*! ... */ (executed by the server)
  for (let i = 0; i < n; ) {
    const ch = sql[i];
    const next = sql[i + 1];
    if (/\s/.test(ch)) {
      i++;
    } else if (ch === '#' || (ch === '-' && next === '-' && /\s|^$/.test(sql[i + 2] ?? ' '))) {
      while (i < n && sql[i] !== '\n') i++;
    } else if (ch === '/' && next === '*') {
      const executable = sql[i + 2] === '!' || (sql[i + 2] === 'M' && sql[i + 3] === '!');
      if (executable) {
        conditional++;
        i += sql[i + 2] === '!' ? 3 : 4;
        while (/\d/.test(sql[i] ?? '')) i++; // the version number
      } else {
        const end = sql.indexOf('*/', i + 2);
        i = end < 0 ? n : end + 2;
      }
    } else if (ch === '*' && next === '/' && conditional > 0) {
      conditional--;
      i += 2;
    } else if (ch === "'" || ch === '"' || ch === '`') {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === '\\' && ch !== '`') j += 2;
        else if (sql[j] === ch && sql[j + 1] === ch) j += 2;
        else if (sql[j] === ch) break;
        else j++;
      }
      if (semicolon) out.multiple = true;
      i = j + 1;
    } else if (ch === ';') {
      semicolon = true;
      i++;
    } else if (/[A-Za-z_]/.test(ch)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_$]/.test(sql[j])) j++;
      let k = j;
      while (k < n && /\s/.test(sql[k])) k++;
      if (semicolon) out.multiple = true;
      out.words.push({ text: sql.slice(i, j).toUpperCase(), paren: sql[k] === '(' });
      i = j;
    } else {
      if (ch === '?') out.placeholders++;
      if (semicolon) out.multiple = true;
      i++;
    }
  }
  return out;
}

const REFUSED_VERBS = new Set(['DELETE', 'TRUNCATE', 'DROP', 'ALTER']);

const typeName = (p: unknown) => (p === null ? 'null' : Array.isArray(p) ? 'array' : p instanceof Date ? 'date' : typeof p === 'object' ? 'object' : typeof p);

function isParam(p: unknown): p is Param {
  return typeof p === 'string' || typeof p === 'boolean' || p === null || Buffer.isBuffer(p) || (typeof p === 'number' && Number.isFinite(p));
}

/** Throws StatementRefusedError for a statement or a parameter list the API must not send. Sends nothing. */
export function checkStatement(sql: string, params: readonly unknown[] = [], options: { readOnly?: boolean } = {}): void {
  const s = scan(sql);
  if (s.multiple) throw new StatementRefusedError('multiple', 'statement refused: it holds more than one statement');
  for (const w of s.words) {
    if (REFUSED_VERBS.has(w.text) && !(w.text === 'TRUNCATE' && w.paren)) throw new StatementRefusedError('verb', `statement refused: ${w.text.toLowerCase()} is never issued by the API (S7)`);
    if (w.text === 'REPLACE' && !w.paren) throw new StatementRefusedError('replace', 'statement refused: replace deletes and inserts silently, use insert or update (S12)');
  }
  if (options.readOnly && !(s.words[0] && (s.words[0].text === 'SELECT' || s.words[0].text === 'WITH'))) throw new StatementRefusedError('read_only', 'statement refused: a read sends select only');
  if (s.placeholders !== params.length) throw new StatementRefusedError('parameter', `statement refused: ${s.placeholders} placeholders and ${params.length} values`);
  params.forEach((p, i) => {
    if (!isParam(p)) throw new StatementRefusedError('parameter', `statement refused: value ${i + 1} is ${typeName(p)}; only text, numbers, booleans, null and Buffers are sent, one ? for each value (S12)`);
  });
}
