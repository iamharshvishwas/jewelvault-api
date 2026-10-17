import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { laneRoot } from '../helpers';
import { SKU_STATUSES } from '../../src/stock/x09SetSkuStatus';
import { insert, V } from '../schema/support';
import { type EditWorld, STAMP_DB, addDesign, addPiece, body, editWorld } from './edit-support';
import { addPieceIn, addSoldPiece, errorCode, errorField, footprint, newKey, rows, setStatus } from './stock-support';
import { innodbDeadlocks } from './tx-support';

// API16, X9 `set_sku_status` (POST /v1/skus/status, 200 {skus}). The DB halves of T-C17 (a Sold piece cannot be changed, Archived sets archived_at together with the status) and the T-C08 clause
// (leaving Archived clears archived_at), plus the clauses of T-D03 (no result holds the original weight), T-D09 (the matrix row of X9 for the callers) and the lock order of X0 item 5 (the pieces
// by ONE statement in MariaDB's id order). The audit rows of both mechanisms (T-D14) are counted in tests/api/stock-audit.test.ts.
//
// The fixture pieces carry the stamp STAMP_DB; the API clock is fixed at 17 Oct 2026 10:00 UTC, so a stamp that moved can be told from one that did not.

const STAMP_WIRE_DB = '2026-10-01T08:30:15.123457Z';
const NOW = /^2026-10-17T10:00:00\.\d{6}Z$/;
/** Two ids that sort one way as text and the other way in the database (the native UUID type): the pair of the T-C21 control. */
const P_TEXT_FIRST = '00000000-0000-4000-8000-000000000001';
const P_SQL_FIRST = '00000001-0000-4000-8000-000000000000';
const STATUSES = ['In Stock', 'Reserved', 'On Approval', 'Sold', 'Returned', 'Repair', 'Transferred', 'Missing', 'Damaged', 'Archived'];

describe('X9 set_sku_status', () => {
  let w: EditWorld;
  let design: string;
  beforeAll(async () => {
    w = await editWorld('x9main');
    design = await addDesign(w);
  }, 120_000);
  afterAll(async () => {
    await w?.world.close();
  }, 60_000);

  const pieces = (n: number, status = 'In Stock'): Promise<string[]> => Promise.all(Array.from({ length: n }, () => addPieceIn(w, design, status)));
  const piece = async (id: string): Promise<any> => (await rows(w, 'SELECT * FROM skus WHERE id = ?', [id]))[0];

  describe('any status except Sold, in one call, for many pieces', () => {
    it('sets the status of every piece named and answers the updated pieces', async () => {
      const ids = await pieces(3);
      const res = await setStatus(w, 'staff', { sku_ids: ids, status: 'Repair' });
      expect(res.statusCode, res.body).toBe(200);
      const b = body(res);
      expect(Object.keys(b)).toEqual(['skus']);
      expect(b.skus.map((s: any) => s.id)).toEqual(ids); // in the order asked
      for (const s of b.skus) expect(s).toMatchObject({ status: 'Repair', archived_at: null, sold_bill_id: null, updated_by: w.world.fixtures.staff.userId });
      for (const s of b.skus) expect(s.updated_at).toMatch(NOW);
      expect(new Set(b.skus.map((s: any) => s.updated_at)).size).toBe(1); // one reading of the clock for the whole call
      for (const id of ids) {
        const row = await piece(id);
        expect(row.status).toBe('Repair');
        expect(row.updated_by).toBe(w.world.fixtures.staff.userId);
        expect(row.archived_at).toBeNull();
      }
    });

    it('can set every status of D8 but Sold, from In Stock and back', async () => {
      const [id] = await pieces(1);
      for (const status of STATUSES.filter((s) => s !== 'Sold')) {
        const res = await setStatus(w, 'owner', { sku_ids: [id], status });
        expect([status, res.statusCode, res.statusCode === 200 ? body(res).skus[0].status : res.body]).toEqual([status, 200, status]);
        expect((await piece(id)).status).toBe(status);
      }
      expect(STATUSES).toHaveLength(10);
    });

    it('the list of statuses is the list of the CHECK of the table (a status added by a migration must be decided here)', async () => {
      const [check] = await rows(w, "SELECT CHECK_CLAUSE FROM information_schema.CHECK_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() AND CONSTRAINT_NAME = 'chk_skus_status'");
      const inTable = [...String(check.CHECK_CLAUSE).matchAll(/'([^']+)'/g)].map((m) => m[1]);
      expect([...inTable].sort()).toEqual([...STATUSES].sort());
      expect([...SKU_STATUSES].sort()).toEqual([...inTable].sort()); // the constant of the code is the list of the table
    });

    it('a piece that already has the status is left alone: no new stamp, and it is in the answer all the same', async () => {
      const [a, b] = await pieces(2);
      await w.world.sql.query("UPDATE skus SET status = 'Missing' WHERE id = ?", [b]);
      await w.world.sql.query('UPDATE skus SET updated_at = ? WHERE id IN (?, ?)', [STAMP_DB, a, b]);
      const res = await setStatus(w, 'owner', { sku_ids: [a, b], status: 'Missing' });
      expect(res.statusCode, res.body).toBe(200);
      const [sa, sb] = body(res).skus;
      expect([sa.status, sa.updated_at]).toEqual(['Missing', expect.stringMatching(NOW)]);
      expect([sb.status, sb.updated_at, sb.updated_by]).toEqual(['Missing', STAMP_WIRE_DB, null]); // unchanged: the old stamp, nobody edited it
      expect((await piece(b)).updated_at).toBe(STAMP_DB);
    });

    it('the note is added to the notes of the pieces whose status changes, on a line of its own', async () => {
      const [a, b, c] = await pieces(3);
      await w.world.sql.query("UPDATE skus SET notes = 'old note' WHERE id = ?", [b]);
      await w.world.sql.query("UPDATE skus SET status = 'Damaged' WHERE id = ?", [c]);
      const res = await setStatus(w, 'staff', { sku_ids: [a, b, c], status: 'Damaged', note: '  clasp broken  ' });
      expect(res.statusCode, res.body).toBe(200);
      expect((await piece(a)).notes).toBe('clasp broken');
      expect((await piece(b)).notes).toBe('old note\nclasp broken');
      expect((await piece(c)).notes).toBeNull(); // its status did not change, so the note did not belong to it
    });
  });

  describe('T-C17: a Sold piece cannot be changed (use X5 or X10)', () => {
    it('refuses the whole call with JV_NOT_ALLOWED naming the Sold pieces, and changes nothing, not even the other pieces', async () => {
      const sold = await addSoldPiece(w, design);
      const [other] = await pieces(1);
      const before = await footprint(w);
      const rowBefore = JSON.stringify(await piece(sold.piece));
      const otherBefore = JSON.stringify(await piece(other));
      for (const status of ['In Stock', 'Archived', 'Repair', 'Missing']) {
        const res = await setStatus(w, 'owner', { sku_ids: [other, sold.piece], status });
        expect([status, res.statusCode, errorCode(res)]).toEqual([status, 409, 'JV_NOT_ALLOWED']);
        expect(JSON.parse(res.body).error.details).toEqual({ field: 'sku_ids', sku_ids: [sold.piece] });
      }
      expect(JSON.stringify(await piece(sold.piece))).toBe(rowBefore);
      expect(JSON.stringify(await piece(other))).toBe(otherBefore);
      expect(await footprint(w)).toEqual(before); // no claim row, no audit row
      expect((await piece(sold.piece)).sold_bill_id).toBe(sold.bill);
    });

    it('Sold is not a status X9 can set: 422 on status, whoever the piece is', async () => {
      const [id] = await pieces(1);
      const res = await setStatus(w, 'owner', { sku_ids: [id], status: 'Sold' });
      expect([res.statusCode, errorCode(res), errorField(res)]).toEqual([422, 'JV_INVALID_INPUT', 'status']);
      expect((await piece(id)).status).toBe('In Stock');
    });
  });

  describe('T-C08 clause and D8: Archived and archived_at go together', () => {
    it('setting Archived sets archived_at to the API clock; leaving Archived clears it; a piece already Archived keeps the time it was archived', async () => {
      const [id] = await pieces(1);
      const archived = await setStatus(w, 'staff', { sku_ids: [id], status: 'Archived' });
      expect(archived.statusCode, archived.body).toBe(200);
      expect(body(archived).skus[0]).toMatchObject({ status: 'Archived', archived_at: expect.stringMatching(NOW) });
      const first = (await piece(id)).archived_at as string;
      expect(first).toMatch(/^2026-10-17 10:00:00\.\d{6}$/);
      expect(body(archived).skus[0].archived_at).toBe(body(archived).skus[0].updated_at); // one reading

      const again = await setStatus(w, 'staff', { sku_ids: [id], status: 'Archived' }); // nothing to change
      expect(again.statusCode).toBe(200);
      expect((await piece(id)).archived_at).toBe(first);

      for (const status of ['In Stock', 'Repair']) {
        const left = await setStatus(w, 'owner', { sku_ids: [id], status });
        expect(left.statusCode, left.body).toBe(200);
        expect(body(left).skus[0]).toMatchObject({ status, archived_at: null });
        expect((await piece(id)).archived_at).toBeNull();
        const back = await setStatus(w, 'owner', { sku_ids: [id], status: 'Archived' });
        expect(body(back).skus[0].archived_at).toMatch(NOW);
      }
    });

    it('a mixed call: some pieces archived, some already archived, some leaving it, never a status without its archived_at', async () => {
      const [a, b] = await pieces(2);
      const c = await addPieceIn(w, design, 'Archived');
      const res = await setStatus(w, 'owner', { sku_ids: [a, b, c], status: 'Archived' });
      expect(res.statusCode, res.body).toBe(200);
      const stored = await rows(w, "SELECT id, status, archived_at FROM skus WHERE id IN (?, ?, ?)", [a, b, c]);
      for (const r of stored) expect([r.status, r.archived_at === null]).toEqual(['Archived', false]);
      expect(stored.find((r) => r.id === c)!.archived_at).toBe('2026-09-01 12:00:00.000000'); // archived before: the first time stays
      const out = await setStatus(w, 'owner', { sku_ids: [a, c], status: 'Reserved' });
      expect(out.statusCode).toBe(200);
      for (const r of await rows(w, 'SELECT status, archived_at FROM skus WHERE id IN (?, ?)', [a, c])) expect([r.status, r.archived_at]).toEqual(['Reserved', null]);
    });
  });

  describe('the input', () => {
    it('refuses what is not a list of 1 to 500 different piece ids that exist, a status of D8 and a note of at most 500 characters, naming the field', async () => {
      const ids = await pieces(2);
      const before = await footprint(w);
      const ghost = randomUUID();
      const cases: [string, unknown, number, string, string][] = [
        ['no ids', { sku_ids: [], status: 'Repair' }, 422, 'JV_INVALID_INPUT', 'sku_ids'],
        ['missing ids', { status: 'Repair' }, 422, 'JV_INVALID_INPUT', 'sku_ids'],
        ['501 ids', { sku_ids: Array.from({ length: 501 }, () => randomUUID()), status: 'Repair' }, 422, 'JV_INVALID_INPUT', 'sku_ids'],
        ['an id that is not a UUID', { sku_ids: ['SKU-1'], status: 'Repair' }, 422, 'JV_INVALID_INPUT', 'sku_ids[0]'],
        ['the same piece twice', { sku_ids: [ids[0], ids[1], ids[0]], status: 'Repair' }, 422, 'JV_INVALID_INPUT', 'sku_ids[2]'],
        ['a piece that does not exist', { sku_ids: [ids[0], ghost], status: 'Repair' }, 422, 'JV_INVALID_INPUT', 'sku_ids[1]'],
        ['no status', { sku_ids: ids }, 422, 'JV_INVALID_INPUT', 'status'],
        ['a status that is not one of the ten', { sku_ids: ids, status: 'Lost' }, 422, 'JV_INVALID_INPUT', 'status'],
        ['a status in other letters', { sku_ids: ids, status: 'in stock' }, 422, 'JV_INVALID_INPUT', 'status'],
        ['a note over 500 characters', { sku_ids: ids, status: 'Repair', note: 'x'.repeat(501) }, 422, 'JV_INVALID_INPUT', 'note'],
        ['a note that is not text', { sku_ids: ids, status: 'Repair', note: 5 }, 422, 'JV_INVALID_INPUT', 'note'],
        ['a field the call does not have', { sku_ids: ids, status: 'Repair', archived_at: '2026-10-01T00:00:00.000000Z' }, 422, 'JV_INVALID_INPUT', 'archived_at'],
        ['a p_ name of the spec', { sku_ids: ids, status: 'Repair', p_note: 'x' }, 422, 'JV_INVALID_INPUT', 'p_note'],
      ];
      for (const [what, payload, status, code, field] of cases) {
        const res = await setStatus(w, 'owner', payload);
        expect([what, res.statusCode, errorCode(res), errorField(res)]).toEqual([what, status, code, field]);
      }
      expect(await footprint(w)).toEqual(before);
      for (const id of ids) expect((await piece(id)).status).toBe('In Stock');
    });

    it('takes 500 pieces in one call', async () => {
      const ids = await Promise.all(Array.from({ length: 500 }, () => addPiece(w, design)));
      const started = Date.now();
      const res = await setStatus(w, 'owner', { sku_ids: ids, status: 'Transferred', note: 'moved to the Pune shop' });
      expect(res.statusCode, res.body.slice(0, 200)).toBe(200);
      expect(body(res).skus).toHaveLength(500);
      expect(Date.now() - started).toBeLessThan(10_000);
      expect(Number((await rows(w, "SELECT COUNT(*) AS n FROM skus WHERE status = 'Transferred' AND notes = 'moved to the Pune shop'"))[0].n)).toBe(500);
    }, 60_000);

    it('a note that does not fit in the notes of a piece is refused, not cut', async () => {
      const [id] = await pieces(1);
      await w.world.sql.query('UPDATE skus SET notes = ? WHERE id = ?', ['n'.repeat(9_900), id]);
      const res = await setStatus(w, 'owner', { sku_ids: [id], status: 'Repair', note: 'y'.repeat(200) });
      expect([res.statusCode, errorCode(res), errorField(res)]).toEqual([422, 'JV_INVALID_INPUT', 'note']);
      expect((await piece(id)).status).toBe('In Stock');
    });
  });

  describe('T-D03 clause: no result of X9 holds the original weight', () => {
    it('not for staff, not for the owner, not on a replay, though the pieces have owner-only weights', async () => {
      const ids = await pieces(2);
      for (const id of ids) await insert(w.world.sql, 'sku_private', V.skuPrivate(id, { original_net_weight: '6.543' }));
      const key = newKey();
      const first = await setStatus(w, 'staff', { sku_ids: ids, status: 'Repair' }, key);
      const replay = await setStatus(w, 'staff', { sku_ids: ids, status: 'Repair' }, key);
      const owner = await setStatus(w, 'owner', { sku_ids: ids, status: 'Reserved' });
      for (const res of [first, replay, owner]) {
        expect(res.statusCode, res.body).toBe(200);
        expect(res.body).not.toMatch(/original_net_weight|6\.543/);
      }
      expect(replay.headers['idempotent-replay']).toBe('true');
    });
  });

  describe('Idempotency-Key (L5)', () => {
    it('a repeat answers the stored result with Idempotent-Replay: true and does not stamp the pieces again', async () => {
      const ids = await pieces(2);
      const key = newKey();
      const first = await setStatus(w, 'owner', { sku_ids: ids, status: 'Missing' }, key);
      expect(first.statusCode).toBe(200);
      expect(first.headers['idempotent-replay']).toBeUndefined();
      const stamps = (await rows(w, 'SELECT id, updated_at FROM skus WHERE id IN (?, ?) ORDER BY id', ids)).map((r) => r.updated_at);
      const again = await setStatus(w, 'owner', { sku_ids: ids, status: 'Missing' }, key);
      expect(again.statusCode).toBe(200);
      expect(again.headers['idempotent-replay']).toBe('true');
      expect(body(again)).toEqual(body(first));
      expect((await rows(w, 'SELECT id, updated_at FROM skus WHERE id IN (?, ?) ORDER BY id', ids)).map((r) => r.updated_at)).toEqual(stamps);
    });

    it('the replay of a call whose pieces changed since still answers what the first call answered', async () => {
      const ids = await pieces(1);
      const key = newKey();
      const first = await setStatus(w, 'owner', { sku_ids: ids, status: 'Repair' }, key);
      await setStatus(w, 'owner', { sku_ids: ids, status: 'Damaged' });
      const again = await setStatus(w, 'owner', { sku_ids: ids, status: 'Repair' }, key);
      expect(again.headers['idempotent-replay']).toBe('true');
      expect(body(again).skus[0].status).toBe('Repair');
      expect(body(again)).toEqual(body(first));
      expect((await piece(ids[0])).status).toBe('Damaged'); // a replay does nothing
    });

    it('a missing key, a malformed key and a key used for another call are refused', async () => {
      const ids = await pieces(1);
      const none = await setStatus(w, 'owner', { sku_ids: ids, status: 'Repair' }, null);
      expect([none.statusCode, errorCode(none), errorField(none)]).toEqual([422, 'JV_INVALID_INPUT', 'Idempotency-Key']);
      const junk = await setStatus(w, 'owner', { sku_ids: ids, status: 'Repair' }, 'nope');
      expect([junk.statusCode, errorCode(junk), errorField(junk)]).toEqual([422, 'JV_INVALID_INPUT', 'Idempotency-Key']);
      const key = newKey();
      expect((await setStatus(w, 'owner', { sku_ids: ids, status: 'Repair' }, key)).statusCode).toBe(200);
      const other = await setStatus(w, 'owner', { sku_ids: ids, status: 'Damaged' }, key);
      expect([other.statusCode, errorCode(other), errorField(other)]).toEqual([422, 'JV_INVALID_INPUT', 'Idempotency-Key']);
      expect((await piece(ids[0])).status).toBe('Repair');
    });

    it('a call that is refused leaves its key unused', async () => {
      const [id] = await pieces(1);
      const sold = await addSoldPiece(w, design);
      const key = newKey();
      expect((await setStatus(w, 'owner', { sku_ids: [id, sold.piece], status: 'Repair' }, key)).statusCode).toBe(409);
      const ok = await setStatus(w, 'owner', { sku_ids: [id, sold.piece], status: 'Repair' }, key);
      expect(ok.statusCode).toBe(409); // the same body is refused the same way: not a replay of an answer that was never stored
      expect(ok.headers['idempotent-replay']).toBeUndefined();
      expect((await setStatus(w, 'owner', { sku_ids: [id], status: 'Repair' }, key)).statusCode).toBe(200);
    });
  });

  describe('T-D09 clause: the matrix row of X9', () => {
    it('no session is 401, a biller is 403 even with a valid body, staff and the owner are let in', async () => {
      const ids = await pieces(1);
      const before = await footprint(w);
      const anon = await setStatus(w, 'anon', { sku_ids: ids, status: 'Repair' });
      expect([anon.statusCode, errorCode(anon)]).toEqual([401, 'JV_UNAUTHENTICATED']);
      const biller = await setStatus(w, 'biller', { sku_ids: ids, status: 'Repair' });
      expect([biller.statusCode, errorCode(biller)]).toEqual([403, 'JV_FORBIDDEN']);
      const mustChange = await setStatus(w, 'must_change', { sku_ids: ids, status: 'Repair' });
      expect([mustChange.statusCode, errorCode(mustChange)]).toEqual([403, 'JV_PASSWORD_CHANGE_REQUIRED']);
      expect(await footprint(w)).toEqual(before);
      expect((await piece(ids[0])).status).toBe('In Stock');
      expect((await setStatus(w, 'staff', { sku_ids: ids, status: 'Repair' })).statusCode).toBe(200);
      expect((await setStatus(w, 'owner', { sku_ids: ids, status: 'In Stock' })).statusCode).toBe(200);
    });
  });

  describe('X0 item 5: the pieces are locked by ONE statement, in MariaDB\'s id order, and nothing else is locked', () => {
    it('the transaction is: the claim, one `... WHERE id IN (...) ORDER BY id FOR UPDATE`, the reads, the updates', async () => {
      const ids = await pieces(3);
      const from = w.world.spy.sent.length;
      const res = await setStatus(w, 'staff', { sku_ids: [ids[2], ids[0], ids[1]], status: 'Repair' });
      expect(res.statusCode, res.body).toBe(200);
      const all = w.world.spy.sqls().slice(from).filter((s) => !/^(SET|COMMIT|ROLLBACK)\b/i.test(s) && !/FROM (sessions|users)\b/i.test(s) && !/^UPDATE sessions\b/i.test(s));
      const sqls = all.slice(all.findIndex((s) => /^START TRANSACTION\b/i.test(s)) + 1);
      expect(sqls[0]).toMatch(/^INSERT INTO sys_idempotency\b/);
      const locks = sqls.filter((s) => /\bFOR UPDATE\b/i.test(s) && !/sys_idempotency/.test(s));
      expect(locks).toHaveLength(1);
      expect(locks[0]).toMatch(/FROM skus WHERE id IN \(\?, \?, \?\) ORDER BY id FOR UPDATE$/);
      expect(sqls.some((s) => /FROM customers\b/i.test(s) || /sys_counters/.test(s))).toBe(false); // no customer lock, no number
      const firstUpdate = sqls.findIndex((s) => /^UPDATE skus\b/.test(s));
      expect(sqls.findIndex((s) => /\bFOR UPDATE\b/i.test(s) && /FROM skus/.test(s))).toBeLessThan(firstUpdate);
    });

    it('two calls that name the same two pieces in opposite orders, whose ids sort differently as text and in the database, never deadlock (T-C21 control, small)', async () => {
      const [a, b] = [P_TEXT_FIRST, P_SQL_FIRST];
      await addPiece(w, design, { id: a });
      await addPiece(w, design, { id: b });
      const root = await laneRoot();
      const deadlocksBefore = await innodbDeadlocks(root);
      for (let round = 0; round < 10; round++) {
        const statuses = round % 2 === 0 ? ['Repair', 'Damaged'] : ['In Stock', 'Missing'];
        const [x, y] = await Promise.all([setStatus(w, 'owner', { sku_ids: [a, b], status: statuses[0] }), setStatus(w, 'staff', { sku_ids: [b, a], status: statuses[1] })]);
        expect([x.statusCode, y.statusCode], `${x.body} ${y.body}`).toEqual([200, 200]);
      }
      expect(await innodbDeadlocks(root)).toBe(deadlocksBefore);
      await root.end();
    });
  });

  describe('a refused call leaves nothing behind', () => {
    it('a piece that does not exist rolls back the claim; nothing is stamped', async () => {
      const [id] = await pieces(1);
      const before = await footprint(w);
      const res = await setStatus(w, 'owner', { sku_ids: [id, randomUUID()], status: 'Missing' });
      expect(res.statusCode).toBe(422);
      expect(await footprint(w)).toEqual(before);
      expect((await piece(id)).status).toBe('In Stock');
    });
  });
});
