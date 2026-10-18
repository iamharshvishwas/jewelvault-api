import { readFileSync } from 'node:fs';
import { relative } from 'node:path';
import ts from 'typescript';
import * as locks from '../../src/db/locks';
import type { Tx } from '../../src/db/tx';
import { sourceFiles } from './static-lib';
import { type Call } from './x04-pair';
import { V, insert } from '../schema/support';
import { billBody, item, postBill } from './x01-support';
import { type EditWorld, pay, rows } from './x02-support';
import { refund, upi } from './x11-support';

// Shared by the tests of API29 (T-C10 to T-C14, T-C20, T-C21): the calls of the pairs (the hook point each function was built with), the books of one customer in whole paise worked out from the base
// tables with plain SQL (another opinion than the code under test), and the source check of T-C21.

// ------------------------------------------------------------------ the calls of a pair

/** record_payment (X2) for `customer`, by a biller; held at `x02.after_read`. */
export const payCall = (w: EditWorld, customer: string, amount: string): Call => ({ hook: 'x02.after_read', start: () => pay(w, 'biller', customer, { amount, mode: 'UPI' }) });

/** issue_refund (X11), by the owner (the only role that may call it); held at `x11.after_read`. */
export const refundCall = (w: EditWorld, customer: string, amount: string): Call => ({ hook: 'x11.after_read', start: () => refund(w, 'owner', customer, upi(amount)) });

/** create_bill (X1) of ONE Per Piece line priced `total`, by a biller; held at `create_bill.after_read`. The piece is made before the pair starts. */
export const billCall = (w: EditWorld, customer: string, pieceId: string, total: string): Call => ({
  hook: 'create_bill.after_read',
  start: () => postBill(w, 'biller', billBody(customer, 'Retail', [item(pieceId, { metal_rate: total })])),
});

// ------------------------------------------------------------------ the books of one customer, in whole paise

export interface MoneyBooks {
  /** money received (active `money` receipts) */
  received: bigint;
  /** money handed back (active `refund` receipts) */
  refunded: bigint;
  /** live allocations of active receipts */
  allocated: bigint;
  /** active bills */
  billed: bigint;
  /** billed - allocated */
  outstanding: bigint;
  /** received - allocated - refunded */
  advance: bigint;
  refunds: number;
}

const paiseOf = (text: unknown): bigint => {
  const [i, f = ''] = String(text).split('.');
  return BigInt(i) * 100n + (i.startsWith('-') ? -1n : 1n) * BigInt(`${f}00`.slice(0, 2));
};
export const rupeesOf = (p: bigint): string => `${p < 0n ? '-' : ''}${(p < 0n ? -p : p) / 100n}.${String((p < 0n ? -p : p) % 100n).padStart(2, '0')}`;

/** What the base tables say about one customer's money (not through the helpers of the code under test). */
export async function moneyBooks(w: EditWorld, customer: string): Promise<MoneyBooks> {
  const [r] = await rows(
    w,
    `SELECT
       (SELECT COALESCE(SUM(amount), 0) FROM receipts WHERE customer_id = ? AND status = 'active' AND kind = 'money') AS received,
       (SELECT COALESCE(SUM(amount), 0) FROM receipts WHERE customer_id = ? AND status = 'active' AND kind = 'refund') AS refunded,
       (SELECT COUNT(*) FROM receipts WHERE customer_id = ? AND status = 'active' AND kind = 'refund') AS refunds,
       (SELECT COALESCE(SUM(a.amount), 0) FROM receipt_allocations a JOIN receipts r ON r.id = a.receipt_id WHERE a.customer_id = ? AND a.released_at IS NULL AND r.status = 'active') AS allocated,
       (SELECT COALESCE(SUM(grand_total), 0) FROM bills WHERE customer_id = ? AND status = 'active') AS billed`,
    [customer, customer, customer, customer, customer],
  );
  const received = paiseOf(r.received);
  const refunded = paiseOf(r.refunded);
  const allocated = paiseOf(r.allocated);
  const billed = paiseOf(r.billed);
  return { received, refunded, allocated, billed, outstanding: billed - allocated, advance: received - allocated - refunded, refunds: Number(r.refunds) };
}

// ------------------------------------------------------------------ T-C21: the wrong piece helper, with the rows the money functions need

/**
 * The mistake the spec warns about (X0 item 5), as a stand-in for `lockPieces`: the ids sorted in code and locked ONE AT A TIME, each with its own `FOR UPDATE`. `between` is the pause point
 * `lock_pieces.between` of the test build, called after every lock with the number of pieces locked so far. It writes its step like the real helper, so the trail check cannot tell the two apart
 * (it cannot: X0 item 5). The rows are whole `skus` rows, which hold every column the real helper returns.
 */
export async function lockPiecesWrongRows(tx: Tx, ids: readonly string[], between: (lockedSoFar: number) => Promise<void> = async () => undefined): Promise<locks.PieceLockRow[]> {
  locks.noteStep(tx, 'pieces');
  const out: locks.PieceLockRow[] = [];
  for (const id of [...new Set(ids)].sort()) {
    out.push(...(await tx.rows<locks.PieceLockRow>('SELECT * FROM skus WHERE id = ? FOR UPDATE', [id])));
    await between(out.length);
  }
  return out;
}

/** A piece with the id the test chooses, Sold on `bill` with a line on it (x04-support's addSoldPiece makes its own id for the line). */
export async function addSoldPieceWithId(w: EditWorld, design: string, bill: string, lineNo: number, id: string, o: Record<string, unknown> = {}): Promise<void> {
  await insert(w.world.sql, 'skus', V.sku(design, { id, status: 'Sold', sold_bill_id: bill, ...o }));
  await insert(w.world.sql, 'bill_items', V.billItem(bill, id, { line_no: lineNo, sku_no: `S-${id.slice(0, 6)}-${id.slice(-6)}` }));
}

/** The request id of the session a Tx belongs to (the key `Gates.points` and `Gates.forRequest` use). */
export const requestIdOfTx = (tx: unknown): string => String((tx as { requestId?: string }).requestId ?? '');

// ------------------------------------------------------------------ T-C21: the build check

export interface PieceLockHit {
  file: string;
  line: number;
  what: string;
}

const LOCKS_PIECES = /\bFROM\s+skus\b[\s\S]*\bFOR\s+UPDATE\b/i;
const SORTS = new Set(['sort', 'toSorted']);

/**
 * The build check of T-C21 on the TypeScript files of a folder (spec X0 item 5): (1) a function that locks pieces (it calls `lockPieces`, or holds a statement `... FROM skus ... FOR UPDATE`) does not
 * sort anything with `.sort()` or `.toSorted()` BEFORE that point, because MariaDB's `ORDER BY id` is the order of the locks, never the text order of the ids; (2) a locking statement on `skus`
 * is not inside a loop (for, for-of, for-in, while, do) or inside the callback of `.map`, `.forEach`, `.reduce`, `.filter` or `.flatMap`: one statement for the whole list, never one for each piece.
 * Comments do not count.
 */
export function pieceLockProblems(dir: string): PieceLockHit[] {
  const hits: PieceLockHit[] = [];
  for (const file of sourceFiles(dir, /\.(ts|mts)$/)) {
    const text = readFileSync(file, 'utf8');
    hits.push(...pieceLockProblemsOf(relative(dir, file), text));
  }
  return hits;
}

export function pieceLockProblemsOf(name: string, text: string): PieceLockHit[] {
  const sf = ts.createSourceFile(name, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const hits: PieceLockHit[] = [];
  const line = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const isFunction = (n: ts.Node): n is ts.FunctionLikeDeclaration => ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n) || ts.isMethodDeclaration(n);
  const literalText = (n: ts.Node): string | null => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return n.text;
    if (ts.isTemplateExpression(n)) return n.head.text + n.templateSpans.map((s) => ` __expr__ ${s.literal.text}`).join('');
    return null;
  };
  const isLockingLiteral = (n: ts.Node): boolean => {
    const t = literalText(n);
    return t !== null && LOCKS_PIECES.test(t);
  };
  const isLockCall = (n: ts.Node): boolean => ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'lockPieces';
  const loopCallbacks = new Set(['map', 'forEach', 'reduce', 'filter', 'flatMap', 'some', 'every']);
  const insideLoop = (n: ts.Node): boolean => {
    for (let p = n.parent; p; p = p.parent) {
      if (isFunction(p) && !(ts.isArrowFunction(p) || ts.isFunctionExpression(p))) return false; // a declared function or method starts its own scope
      if (ts.isForStatement(p) || ts.isForOfStatement(p) || ts.isForInStatement(p) || ts.isWhileStatement(p) || ts.isDoStatement(p)) return true;
      if ((ts.isArrowFunction(p) || ts.isFunctionExpression(p)) && p.parent && ts.isCallExpression(p.parent) && ts.isPropertyAccessExpression(p.parent.expression) && loopCallbacks.has(p.parent.expression.name.text)) return true;
    }
    return false;
  };
  const visitFunction = (fn: ts.Node) => {
    const locks: ts.Node[] = [];
    const sorts: ts.Node[] = [];
    const walk = (n: ts.Node) => {
      if (n !== fn && isFunction(n)) return; // nested functions are visited on their own
      if (isLockingLiteral(n) || isLockCall(n)) locks.push(n);
      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && SORTS.has(n.expression.name.text)) sorts.push(n);
      ts.forEachChild(n, walk);
    };
    ts.forEachChild(fn, walk);
    if (locks.length === 0) return;
    const firstLock = Math.min(...locks.map((n) => n.getStart(sf)));
    for (const s of sorts) if (s.getStart(sf) < firstLock) hits.push({ file: name, line: line(s), what: `${s.getText(sf).slice(0, 60)} sorts before the pieces are locked` });
  };
  const visit = (n: ts.Node) => {
    if (isFunction(n)) visitFunction(n);
    if (isLockingLiteral(n) && insideLoop(n)) hits.push({ file: name, line: line(n), what: 'a locking statement for the pieces inside a loop' });
    if (isLockCall(n) && insideLoop(n)) hits.push({ file: name, line: line(n), what: 'lockPieces called inside a loop' });
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return hits;
}
