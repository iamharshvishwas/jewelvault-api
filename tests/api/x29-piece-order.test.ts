import { join } from 'node:path';
import type { Connection } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { runInvariants } from '../../scripts/invariants.mjs';
import * as locks from '../../src/db/locks';
import { sleep } from '../helpers';
import { innodbDeadlocks } from './tx-support';
import { type Designs, addDesigns, billBody, item, piece, pieceRow, postBill } from './x01-support';
import { Gates, deferred } from './x0-support';
import { type EditWorld, addBill, addCustomer, billRow, codeOf, editWorld, rows } from './x02-support';
import { line, reissueBill, reissueBody } from './x10-support';
import { addSoldPieceWithId, lockPiecesWrongRows, pieceLockProblems, pieceLockProblemsOf, requestIdOfTx } from './x29-support';

// API29, T-C21 (X0 item 5, X10, X1): piece locks follow MariaDB's order of ids. Two pieces whose ids sort one way in code and the other in the database (the native UUID type compares its groups from
// the right): `00000001-0000-4000-8000-000000000000` comes first in SQL and last as text, `00000000-0000-4000-8000-000000000001` the other way round. START STATE of a round: customer A holds a bill
// B1 with the text-first piece P1 (Sold); the SQL-first piece P2 is in stock; customer B has nothing. `reissue_bill` of B1 (the old bill's P1 and the new line's P2, one statement over both lists)
// runs beside `create_bill` of B over the same two pieces, two different customers, so only the pieces can make them meet. The helper is replaced in ONE PATH ONLY, the re-issue's, by a version
// that sorts in code and locks one piece at a time with a pause of 60 ms between its two locks (the test build's `lock_pieces.between`), and `create_bill`, which has the real helper, is started
// 10 ms after the re-issue has taken its first lock: the control must show at least one deadlock (1213) in 40 rounds. With the real helper in both paths there is none, and no JV_BUSY.

let w: EditWorld;
let d: Designs;
let root: Connection;

beforeAll(async () => {
  w = await editWorld('x29pieces');
  d = await addDesigns(w);
  root = await w.world.scratch.root();
}, 120_000);
afterAll(async () => {
  await root?.end().catch(() => undefined);
  await w?.world.close();
}, 60_000);

let nextPair = 1;
/** A pair of ids that sort differently as text and in MariaDB: the first is text-first (and SQL-last), the second SQL-first (and text-last). Every pair is new, so no round meets another round's rows. */
function idPair() {
  const n = nextPair++;
  return { textFirst: `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`, sqlFirst: `${n.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000` };
}

/** One round's start state. */
async function startRound() {
  const ids = idPair();
  const a = await addCustomer(w);
  const b = await addCustomer(w);
  const b1 = await addBill(w, a, '500.00', '2026-10-01');
  await addSoldPieceWithId(w, d.gold24pp, b1, 1, ids.textFirst, { labour_retail: '500.00' });
  await piece(w, d.gold24pp, { retail: '300.00', extra: { id: ids.sqlFirst } });
  return { ...ids, a, b, b1 };
}
type Round = Awaited<ReturnType<typeof startRound>>;

const reissueOf = (r: Round) => reissueBill(w, 'owner', r.b1, reissueBody('Retail', [line(r.sqlFirst, '300.00')], {}, 'the first bill was wrong'));
const createOf = (r: Round) => postBill(w, 'biller', billBody(r.b, 'Retail', [item(r.textFirst, { metal_rate: '500.00' }), item(r.sqlFirst, { metal_rate: '300.00' })]));

const deadlockLogs = () => w.world.logs.lines().filter((l) => String(l.msg).includes('deadlock (1213)')).length;

/**
 * Replaces `lockPieces` for the re-issue's path only (a session that has passed `x10.after_read`): 'wrong' = sorted in code, one piece at a time, 60 ms between the two locks; 'real' = the real
 * helper (one statement), then the same 60 ms before the function goes on, so that the other path comes in while this one holds its locks. `firstLock` says when the first lock is taken.
 */
function replaceForReissue(gates: Gates, mode: 'wrong' | 'real', firstLock: { resolve(): void }) {
  const real = locks.lockPieces;
  return vi.spyOn(locks, 'lockPieces').mockImplementation(async (tx, ids) => {
    const reissue = gates.points.some((p) => p.requestId === requestIdOfTx(tx) && p.point === 'x10.after_read');
    if (!reissue) return real(tx, ids);
    if (mode === 'wrong') {
      return lockPiecesWrongRows(tx, ids, async (lockedSoFar) => {
        if (lockedSoFar === 1) {
          firstLock.resolve();
          await sleep(60);
        }
      });
    }
    const got = await real(tx, ids);
    firstLock.resolve();
    await sleep(60);
    return got;
  });
}

/** 40 rounds: the re-issue is started, `create_bill` 10 ms after its first lock. Answers what happened. */
async function rounds(n: number, mode: 'wrong' | 'real') {
  const gates = Gates.install(); // records the point each session passes; no gate holds anyone here
  const out = { deadlocks: 0, logged: 0, statuses: [] as { reissue: number; create: number; createCode?: string }[], busy: 0, internal: 0 };
  const before = await innodbDeadlocks(root);
  const loggedBefore = deadlockLogs();
  try {
    for (let i = 0; i < n; i++) {
      const r = await startRound();
      const firstLock = deferred();
      const spy = replaceForReissue(gates, mode, firstLock);
      try {
        const re = reissueOf(r);
        await Promise.race([firstLock.promise, re.then(() => undefined)]);
        await sleep(10);
        const create = createOf(r);
        const [x, y] = await Promise.all([re, create]);
        out.statuses.push({ reissue: x.statusCode, create: y.statusCode, createCode: y.statusCode === 201 ? undefined : codeOf(y) });
        out.busy += [x, y].filter((z) => z.statusCode === 503).length;
        out.internal += [x, y].filter((z) => z.statusCode === 500).length;
      } finally {
        spy.mockRestore();
      }
    }
  } finally {
    gates.restore();
  }
  out.deadlocks = (await innodbDeadlocks(root)) - before;
  out.logged = deadlockLogs() - loggedBefore;
  return out;
}

/** The rules of the books for everything the rounds made (I1 to I4 and I10). */
async function booksProblems(): Promise<string[]> {
  const out = await runInvariants(w.world.sql, { sample: 10_000 });
  return out.rows.filter((r: { invariant: string }) => ['I1', 'I2', 'I3', 'I4', 'I10'].includes(r.invariant)).map((r: { invariant: string; row_ref: string; detail: string }) => `${r.invariant} ${r.row_ref}: ${r.detail}`);
}

describe('T-C21 the two ids really sort one way in code and the other in the database (the pair would prove nothing otherwise)', () => {
  it('as text the first is first, in MariaDB the second is first; the real helper takes them in the database\'s order, in one statement, whatever order it is given', async () => {
    const ids = idPair();
    const sold = await addCustomer(w);
    const bill = await addBill(w, sold, '500.00', '2026-10-01');
    await addSoldPieceWithId(w, d.gold24pp, bill, 1, ids.textFirst);
    await piece(w, d.gold24pp, { extra: { id: ids.sqlFirst } });
    expect([ids.textFirst, ids.sqlFirst].sort()).toEqual([ids.textFirst, ids.sqlFirst]);
    const inSql = await rows(w, 'SELECT id FROM skus WHERE id IN (?, ?) ORDER BY id', [ids.textFirst, ids.sqlFirst]);
    expect(inSql.map((r) => r.id)).toEqual([ids.sqlFirst, ids.textFirst]);
    // the real helper: whatever order the ids are given in, the rows come back in the database's order
    const { withTx, txContext } = await import('../../src/db/tx');
    const { randomUUID } = await import('node:crypto');
    for (const given of [[ids.textFirst, ids.sqlFirst], [ids.sqlFirst, ids.textFirst]]) {
      const got = await withTx(txContext(w.world.app.db as never, { requestId: randomUUID(), actor: { id: w.world.fixtures.owner.userId, role: 'owner' } }), (tx) => locks.lockPieces(tx, given));
      expect(got.map((p) => p.id)).toEqual([ids.sqlFirst, ids.textFirst]);
    }
  });
});

describe('T-C21 reissue_bill beside create_bill over the same two pieces for another customer, 40 rounds (X0 item 5, X10, X1)', () => {
  it('CONTROL: with the re-issue\'s helper replaced by one that sorts in code and locks one piece at a time (60 ms between its two locks) and create_bill started 10 ms after its first lock, at least one deadlock (1213) in 40 rounds', async () => {
    const r = await rounds(40, 'wrong');
    console.log(`[x29] T-C21 control (wrong helper in the re-issue only): ${r.deadlocks} deadlocks in 40 rounds (${r.logged} re-runs logged, ${r.busy} JV_BUSY, ${r.internal} JV_INTERNAL)`);
    expect(r.deadlocks, 'the wrong helper deadlocks against the real one').toBeGreaterThanOrEqual(1);
    expect(r.logged, 'withTx re-ran the victims (S12), and logged each deadlock').toBeGreaterThanOrEqual(1);
    expect(r.internal, 'a deadlock is re-run by the API, never answered as a bug').toBe(0);
    expect(await booksProblems(), 'a deadlock is rolled back whole: the books hold').toEqual([]);
  }, 180_000);

  it('with the real helper in both paths: no deadlock in 40 rounds, no JV_BUSY, the re-issue is saved and create_bill is refused JV_PIECE_UNAVAILABLE every time, the books hold', async () => {
    const r = await rounds(40, 'real');
    console.log(`[x29] T-C21 real helper in both paths: ${r.deadlocks} deadlocks in 40 rounds (${r.logged} re-runs logged, ${r.busy} JV_BUSY)`);
    expect(r.deadlocks).toBe(0);
    expect(r.logged).toBe(0);
    expect(r.busy, 'no JV_BUSY').toBe(0);
    expect(r.internal).toBe(0);
    expect(r.statuses).toHaveLength(40);
    expect(r.statuses.every((s) => s.reissue === 201 && s.create === 409 && s.createCode === 'JV_PIECE_UNAVAILABLE'), JSON.stringify(r.statuses.find((s) => s.reissue !== 201 || s.create !== 409))).toBe(true);
    expect(await booksProblems()).toEqual([]);
  }, 180_000);

  it('one round of the real pair, looked at closely: the old bill is cancelled, P1 is back in stock, P2 is sold on the new bill, and the customer of create_bill has no bill', async () => {
    const gates = Gates.install();
    try {
      const r = await startRound();
      const firstLock = deferred();
      const spy = replaceForReissue(gates, 'real', firstLock);
      try {
        const re = reissueOf(r);
        await firstLock.promise;
        await sleep(10);
        const [x, y] = await Promise.all([re, createOf(r)]);
        expect([x.statusCode, y.statusCode], `${x.body} ${y.body}`).toEqual([201, 409]);
        expect(codeOf(y)).toBe('JV_PIECE_UNAVAILABLE');
        const newBill = String(JSON.parse(x.body).new_bill.id);
        expect((await billRow(w, r.b1)).status).toBe('cancelled');
        expect(await pieceRow(w, r.textFirst)).toMatchObject({ status: 'In Stock', sold_bill_id: null });
        expect(await pieceRow(w, r.sqlFirst)).toMatchObject({ status: 'Sold', sold_bill_id: newBill });
        expect(Number((await rows(w, 'SELECT COUNT(*) AS n FROM bills WHERE customer_id = ?', [r.b]))[0].n)).toBe(0);
      } finally {
        spy.mockRestore();
      }
    } finally {
      gates.restore();
    }
  });
});

describe('T-C21 the build check: no code sorts ids before a locking statement, no locking statement locks one piece inside a loop', () => {
  it('src/ is clean', () => {
    expect(pieceLockProblems(join(process.cwd(), 'src'))).toEqual([]);
  });

  it('the wrong helper itself (sorted in code, one piece at a time in a loop) is found, and so is a sort before the locking statement, in a planted file', () => {
    const planted = `
      export async function lockWrong(tx, ids) {
        const out = [];
        for (const id of [...ids].sort()) {
          out.push(...(await tx.rows('SELECT id FROM skus WHERE id = ? FOR UPDATE', [id])));
        }
        return out;
      }
      export async function sortedFirst(tx, ids) {
        const sorted = ids.toSorted();
        return tx.rows('SELECT id FROM skus WHERE id IN (?, ?) ORDER BY id FOR UPDATE', sorted);
      }
      export async function viaCallback(tx, ids) {
        return Promise.all(ids.map((id) => tx.rows('SELECT id FROM skus WHERE id = ? FOR UPDATE', [id])));
      }
      export async function viaHelper(tx, ids) {
        for (const id of ids) await lockPieces(tx, [id]);
      }`;
    const hits = pieceLockProblemsOf('planted.ts', planted);
    const kinds = hits.map((h) => h.what);
    expect(kinds.filter((k) => k.includes('inside a loop'))).toHaveLength(3); // the for-of, the .map callback and the helper called in a loop
    expect(kinds.filter((k) => k.includes('sorts before'))).toHaveLength(2); // the .sort() before the loop's statement and the .toSorted() before the one statement
    const clean = pieceLockProblemsOf('clean.ts', `export async function lockRight(tx, ids) { return tx.rows(\`SELECT id FROM skus WHERE id IN (\${ids.map(() => '?').join(', ')}) ORDER BY id FOR UPDATE\`, ids); }`);
    expect(clean).toEqual([]);
  });
});
