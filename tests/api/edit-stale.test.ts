import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { timestampToWire } from '../../src/wire/format';
import { V, insert } from '../schema/support';
import { type EditWorld, STAMP_DB, STAMP_WIRE, addDesign, addPiece, body, codeOf, dbRow, detailsOf, editWorld, patch, snapshot } from './edit-support';
import { pageAll } from './sync-support';

// API13, the stale check of A5 and what a piece edit may not touch:
//   T-C07  A stock edit (through PATCH) cannot change `status` or `archived_at` of a piece; an edit with a stale `updated_at` changes nothing.   (A5, X9)
//   T-F09  (clause) the exact `updated_at` text round-trips through the stale check.                                                             (S3, S5, A5)
// The calls are the application's real routes on a scratch database; the fixture rows carry a stamp with microseconds that are not zero (STAMP_DB).

let w: EditWorld;
let design: string;
beforeAll(async () => {
  w = await editWorld('editstale');
  design = await addDesign(w);
}, 120_000);
afterAll(async () => {
  await w?.world.close();
});

const WALKIN = '00000000-0000-4000-8000-000000000001';

/** The row as the owner's screen reads it from the sync endpoint: what `details.current` must equal. */
async function readAs(caller: 'owner' | 'staff', resource: 'skus' | 'designs', id: string) {
  const row = (await pageAll(w.world, caller, resource)).rows.find((r) => r.id === id);
  if (!row) throw new Error(`${resource} ${id} is not in the sync read`);
  return row;
}

describe('T-C07 a stock edit through PATCH cannot change status or archived_at of a piece (A5, X9)', () => {
  const forbidden: [string, unknown][] = [
    ['status', 'Archived'],
    ['status', 'Sold'],
    ['status', 'In Stock'],
    ['archived_at', '2026-10-17T10:00:00.000000Z'],
    ['archived_at', null],
    ['sold_bill_id', null],
  ];

  for (const caller of ['owner', 'staff'] as const) {
    for (const [field, value] of forbidden) {
      it(`${caller} sending ${field} = ${JSON.stringify(value)} is refused with 403 JV_FORBIDDEN naming the field, and the piece is untouched`, async () => {
        const piece = await addPiece(w, design);
        const before = await snapshot(w, 'skus', piece);
        const res = await patch(w, caller, 'skus', piece, STAMP_WIRE, { [field]: value });
        expect(res.statusCode).toBe(403);
        expect(codeOf(res)).toBe('JV_FORBIDDEN');
        expect(detailsOf(res)).toEqual({ field: `changes.${field}` });
        expect(await snapshot(w, 'skus', piece)).toBe(before);
      });
    }
  }

  it('a call that holds a content column AND status is refused as a whole: the content column is not applied (nothing is silently ignored)', async () => {
    const piece = await addPiece(w, design, { location: 'Main Showroom' });
    const before = await snapshot(w, 'skus', piece);
    const res = await patch(w, 'staff', 'skus', piece, STAMP_WIRE, { location: 'Workshop', status: 'Missing' });
    expect(res.statusCode).toBe(403);
    expect(codeOf(res)).toBe('JV_FORBIDDEN');
    expect(await snapshot(w, 'skus', piece)).toBe(before);
  });

  it('an edit of a Sold piece changes its content and leaves it Sold: "saving a whole design can undo a sale" is closed (hazard 2)', async () => {
    const bill = randomUUID();
    await insert(w.world.sql, 'bills', V.bill(WALKIN, { id: bill }));
    const sold = await addPiece(w, design, { status: 'Sold', sold_bill_id: bill });
    const untouched = await patch(w, 'staff', 'skus', sold, STAMP_WIRE, { status: 'In Stock' });
    expect(untouched.statusCode).toBe(403);
    const res = await patch(w, 'staff', 'skus', sold, STAMP_WIRE, { location: 'Counter 2' });
    expect(res.statusCode, res.body).toBe(200);
    const row = await dbRow(w, 'skus', sold);
    expect([row.status, row.sold_bill_id, row.location]).toEqual(['Sold', bill, 'Counter 2']);
  });
});

describe('T-C07 an edit with a stale updated_at changes nothing and returns the current row (A5)', () => {
  it('a stale stamp is 409 JV_STALE, the row is exactly as it was, and details.current is the row the sync read gives', async () => {
    const piece = await addPiece(w, design, { location: 'Main Showroom' });
    const before = await snapshot(w, 'skus', piece);
    const res = await patch(w, 'owner', 'skus', piece, '2026-09-30T00:00:00.000000Z', { location: 'Workshop', notes: 'moved' });
    expect(res.statusCode).toBe(409);
    expect(codeOf(res)).toBe('JV_STALE');
    expect(await snapshot(w, 'skus', piece)).toBe(before);
    expect(detailsOf(res).current).toEqual(await readAs('owner', 'skus', piece));
    expect(detailsOf(res).current.location).toBe('Main Showroom');
    expect(detailsOf(res).current.updated_at).toBe(STAMP_WIRE);
  });

  it('the same holds for a design, and details.current is cut to the columns of the caller\'s role', async () => {
    const d = await addDesign(w);
    const before = await snapshot(w, 'designs', d);
    const res = await patch(w, 'staff', 'designs', d, '2026-09-30T00:00:00.000000Z', { name: 'Changed' });
    expect(res.statusCode).toBe(409);
    expect(codeOf(res)).toBe('JV_STALE');
    expect(await snapshot(w, 'designs', d)).toBe(before);
    expect(detailsOf(res).current).toEqual(await readAs('staff', 'designs', d));
  });

  it('two people: the second edit, made on the copy read before the first, is refused and shows the first one\'s row; with the new stamp it goes through', async () => {
    const piece = await addPiece(w, design);
    const first = await patch(w, 'owner', 'skus', piece, STAMP_WIRE, { location: 'Vault' });
    expect(first.statusCode, first.body).toBe(200);
    const stamp1 = body(first).row.updated_at as string;
    expect(stamp1).not.toBe(STAMP_WIRE);

    const second = await patch(w, 'staff', 'skus', piece, STAMP_WIRE, { notes: 'late' });
    expect(second.statusCode).toBe(409);
    expect(codeOf(second)).toBe('JV_STALE');
    expect(detailsOf(second).current.updated_at).toBe(stamp1);
    expect(detailsOf(second).current.location).toBe('Vault');
    expect((await dbRow(w, 'skus', piece)).notes).toBeNull();

    const retry = await patch(w, 'staff', 'skus', piece, stamp1, { notes: 'late' });
    expect(retry.statusCode, retry.body).toBe(200);
    expect((await dbRow(w, 'skus', piece)).notes).toBe('late');
  });

  it('the same edit sent twice is refused the second time by the stale check (A5: no Idempotency-Key is needed)', async () => {
    const piece = await addPiece(w, design);
    const edit = { location: 'Exhibition', notes: 'twice' };
    const once = await patch(w, 'owner', 'skus', piece, STAMP_WIRE, edit);
    expect(once.statusCode, once.body).toBe(200);
    const stamp = (await dbRow(w, 'skus', piece)).updated_at;
    const twice = await patch(w, 'owner', 'skus', piece, STAMP_WIRE, edit);
    expect(twice.statusCode).toBe(409);
    expect(codeOf(twice)).toBe('JV_STALE');
    expect((await dbRow(w, 'skus', piece)).updated_at).toBe(stamp);
  });

  it('two edits sent at the very same moment on the same copy: one goes through, the other is stale (the row lock makes the second wait and then see the first one\'s stamp)', async () => {
    for (let round = 0; round < 5; round++) {
      const piece = await addPiece(w, design);
      const [a, b] = await Promise.all([
        patch(w, 'owner', 'skus', piece, STAMP_WIRE, { notes: 'from the first screen' }),
        patch(w, 'staff', 'skus', piece, STAMP_WIRE, { notes: 'from the second screen' }),
      ]);
      expect([a.statusCode, b.statusCode].sort(), `round ${round}`).toEqual([200, 409]);
      const winner = a.statusCode === 200 ? a : b;
      const loser = a.statusCode === 200 ? b : a;
      expect(codeOf(loser)).toBe('JV_STALE');
      expect((await dbRow(w, 'skus', piece)).notes).toBe(a.statusCode === 200 ? 'from the first screen' : 'from the second screen');
      expect(detailsOf(loser).current.updated_at).toBe(body(winner).row.updated_at);
    }
  });

  it('a row that does not exist is 404 JV_NOT_FOUND, not a stale answer', async () => {
    const res = await patch(w, 'owner', 'skus', randomUUID(), STAMP_WIRE, { location: 'Vault' });
    expect(res.statusCode).toBe(404);
    expect(codeOf(res)).toBe('JV_NOT_FOUND');
    expect(JSON.parse(res.body).error.message).not.toMatch(/address/); // the answer of a missing ROW, not of a path that is no route (A11)
  });

  it('the statement is the one of A5: UPDATE ... SET <only the changed fields>, updated_at, updated_by WHERE id = ? AND updated_at = ? (no other field is written)', async () => {
    const piece = await addPiece(w, design);
    const from = w.world.spy.sent.length;
    const res = await patch(w, 'staff', 'skus', piece, STAMP_WIRE, { location: 'Vault' });
    expect(res.statusCode, res.body).toBe(200);
    const updates = w.world.spy.sqls().slice(from).filter((q) => /^UPDATE\s+`?skus`?\b/i.test(q));
    expect(updates).toEqual(['UPDATE `skus` SET `location` = ?, updated_at = ?, updated_by = ? WHERE id = ? AND updated_at = ?']);
  });

  it('if the guard finds no row to change although the row was read just before (it cannot under the lock, but the answer must still be right), the call is JV_STALE with the current row and nothing is written', async () => {
    const piece = await addPiece(w, design, { notes: 'before' });
    const before = await snapshot(w, 'skus', piece);
    w.world.spy.intercept = async (e) => {
      if (/^UPDATE\s+`?skus`?\b/i.test(e.sql)) return { result: [{ affectedRows: 0, insertId: 0 }, undefined] }; // the server says: no row matched
    };
    let res;
    try {
      res = await patch(w, 'owner', 'skus', piece, STAMP_WIRE, { notes: 'after' });
    } finally {
      w.world.spy.intercept = null;
    }
    expect(res.statusCode).toBe(409);
    expect(codeOf(res)).toBe('JV_STALE');
    expect(detailsOf(res).current.notes).toBe('before');
    expect(await snapshot(w, 'skus', piece)).toBe(before);
  });

  describe('the DB half: the guard of A5 is the clause `AND updated_at = ?`, and without it the stale write lands (negative control)', () => {
    it('UPDATE ... WHERE id = ? AND updated_at = ? with an old stamp changes no row; the same UPDATE without the clause overwrites', async () => {
      const piece = await addPiece(w, design, { notes: 'mine' });
      const [guarded] = await w.world.sql.query<any>('UPDATE skus SET notes = ? WHERE id = ? AND updated_at = ?', ['theirs', piece, '2026-09-30 00:00:00.000000']);
      expect(guarded.affectedRows).toBe(0);
      expect((await dbRow(w, 'skus', piece)).notes).toBe('mine');
      const [naive] = await w.world.sql.query<any>('UPDATE skus SET notes = ? WHERE id = ?', ['theirs', piece]);
      expect(naive.affectedRows).toBe(1);
      expect((await dbRow(w, 'skus', piece)).notes).toBe('theirs');
    });
  });
});

describe('T-F09 (API13 clause) the exact updated_at text round-trips through the stale check (S3, S5, A5)', () => {
  it('the stamp the sync read gives (six decimals and a Z) is accepted unchanged, and the answer carries the new one', async () => {
    const piece = await addPiece(w, design);
    const read = await readAs('owner', 'skus', piece);
    expect(read.updated_at).toBe(STAMP_WIRE);
    expect(STAMP_WIRE).toBe('2026-10-01T08:30:15.123457Z');
    const res = await patch(w, 'owner', 'skus', piece, read.updated_at as string, { notes: 'round trip' });
    expect(res.statusCode, res.body).toBe(200);
    const stamp = body(res).row.updated_at as string;
    expect(stamp).toBe(timestampToWire((await dbRow(w, 'skus', piece)).updated_at as string));
    expect(stamp).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/);
    // and what the screen holds now goes through again
    const again = await patch(w, 'owner', 'skus', piece, stamp, { notes: 'and again' });
    expect(again.statusCode, again.body).toBe(200);
  });

  it('a stamp that differs in the last microsecond is a different stamp: 409', async () => {
    for (const off of ['2026-10-01T08:30:15.123456Z', '2026-10-01T08:30:15.123458Z', '2026-10-01T08:30:15.123450Z', '2026-10-01T08:30:16.123457Z']) {
      const piece = await addPiece(w, design);
      const res = await patch(w, 'owner', 'skus', piece, off, { notes: 'x' });
      expect(res.statusCode, off).toBe(409);
      expect(codeOf(res)).toBe('JV_STALE');
      expect((await dbRow(w, 'skus', piece)).notes).toBeNull();
    }
  });

  it('a stamp that went through a JavaScript Date lost its microseconds (the control) and is refused as input, never matched to the nearest millisecond', async () => {
    const viaDate = new Date(STAMP_WIRE).toISOString();
    expect(viaDate).toBe('2026-10-01T08:30:15.123Z');
    expect(viaDate).not.toBe(STAMP_WIRE);
    const piece = await addPiece(w, design);
    const res = await patch(w, 'owner', 'skus', piece, viaDate, { notes: 'x' });
    expect(res.statusCode).toBe(422);
    expect(codeOf(res)).toBe('JV_INVALID_INPUT');
    expect(detailsOf(res)).toEqual({ field: 'expected_updated_at' });
    for (const bad of ['2026-10-01 08:30:15.123457', '2026-10-01T08:30:15.123457', '2026-10-01', 'yesterday', '']) {
      const r = await patch(w, 'owner', 'skus', piece, bad, { notes: 'x' });
      expect(r.statusCode, bad).toBe(422);
    }
    expect((await dbRow(w, 'skus', piece)).notes).toBeNull();
  });

  it('a stamp whose microseconds are all zero (a trailing-zero text) round-trips too', async () => {
    const piece = await addPiece(w, design, { updated_at: '2026-10-01 08:30:15.000000' });
    const read = await readAs('owner', 'skus', piece);
    expect(read.updated_at).toBe('2026-10-01T08:30:15.000000Z');
    const res = await patch(w, 'owner', 'skus', piece, read.updated_at as string, { notes: 'zeros' });
    expect(res.statusCode, res.body).toBe(200);
    expect(STAMP_DB).toBe('2026-10-01 08:30:15.123457');
  });
});
