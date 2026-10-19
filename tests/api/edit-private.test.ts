import { randomUUID } from 'node:crypto';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { installUserRates } from '../../src/auth/throttle';
import { READ_COLUMNS } from '../../src/permissions/matrix';
import { timestampToWire } from '../../src/wire/format';
import { V, insert } from '../schema/support';
import type { CallerName } from './cells';
import { type EditWorld, STAMP_DB, STAMP_WIRE, addDesign, addPiece, body, codeOf, detailsOf, editWorld, patch, stampOf } from './edit-support';
import { addPieceIn, addSoldPiece, createDesign, designPayload, setStatus } from './stock-support';
import { SYNC_ROWS, pageAll, poll } from './sync-support';

// API13c, the ordinary edit of the owner-only original weight: PUT /v1/sku-private/:sku_id (matrix row `edit:sku_private.update`, D9, A4, A5). The tests are named for the spec tests they extend:
//   T-D02  the row of the owner-only edit is a route and the generated test walks it for nine callers (this file: what the route does for the one caller who may use it, the weight rules of D7,
//          the stale check of A5, the body; the walk itself is tests/matrix.generated.test.ts)
//   T-D03  nobody but the owner ever receives the original weight: not on a read route, not in a function result, not in a refusal
//   T-D14  one audit row per changed row in both mechanisms of L1: tests/api/edit-private-audit.test.ts
// The body is the fields themselves, as for every PUT of the matrix (shape `fields`), plus the stamp of the row the screen holds when it holds one: `expected_updated_at` (A5). No stamp means "the
// screen holds no row": the first write of a piece. The fixture rows carry the stamp STAMP_DB (microseconds that are not zero); the clock of the world never gives one reading twice.

let w: EditWorld;
let design: string;
beforeAll(async () => {
  w = await editWorld('editprivate');
  installUserRates(w.world.app, { everything: { limit: 1_000_000, windowMs: 60_000 } }); // many calls with one user and a clock that stands still: A13 allows 300 a minute
  design = await addDesign(w);
}, 120_000);
afterAll(async () => {
  await w?.world.close();
});

const owner = () => w.world.fixtures.owner.userId;
const put = (caller: CallerName, sku: string, payload: unknown): Promise<LightMyRequestResponse> => w.world.call(caller, 'PUT', `/v1/sku-private/${sku}`, { payload });
const privateRow = async (sku: string): Promise<Record<string, any> | undefined> => (await w.world.sql.query<any[]>('SELECT * FROM sku_private WHERE sku_id = ?', [sku]))[0][0];
const privateCount = async (): Promise<number> => Number((await w.world.sql.query<any[]>('SELECT COUNT(*) AS n FROM sku_private'))[0][0].n);
const snapshotOf = async (sku: string): Promise<string> => JSON.stringify(await privateRow(sku));
/** A weight row typed in by hand, with the stamp of the fixture (as X8 or the import would have made it). */
async function addWeight(sku: string, weight = '10.500'): Promise<void> {
  await insert(w.world.sql, 'sku_private', V.skuPrivate(sku, { original_net_weight: weight, created_at: STAMP_DB, updated_at: STAMP_DB }));
}
/** The row as the owner's screen reads it from the sync endpoint: what `details.current` and the answer must equal. */
async function syncRow(sku: string): Promise<Record<string, unknown>> {
  const row = (await pageAll(w.world, 'owner', 'sku-private')).rows.find((r) => r.sku_id === sku);
  if (!row) throw new Error(`sku-private ${sku} is not in the sync read`);
  return row;
}

describe('T-D02 (API13c) PUT /v1/sku-private/:sku_id: the owner sets the original weight of a piece that has none and corrects it later', () => {
  it('the first write makes the row: 201 {row}, the sync row of the owner (exactly the columns of READ_COLUMNS), stamped by one reading of the API clock, the person columns the owner', async () => {
    const piece = await addPiece(w, design);
    expect(await privateRow(piece)).toBeUndefined();
    const res = await put('owner', piece, { original_net_weight: '8.500' });
    expect(res.statusCode, res.body).toBe(201);
    const answer = body(res);
    expect(Object.keys(answer)).toEqual(['row']);
    expect(Object.keys(answer.row).sort()).toEqual([...READ_COLUMNS.sku_private.owner!].sort());
    expect(answer.row).toMatchObject({ sku_id: piece, original_net_weight: '8.500', created_by: owner(), updated_by: owner() });
    expect(answer.row.created_at).toBe(answer.row.updated_at);
    const stored = await privateRow(piece);
    expect(stored).toMatchObject({ sku_id: piece, original_net_weight: '8.500', created_by: owner(), updated_by: owner() });
    expect(timestampToWire(stored!.updated_at)).toBe(answer.row.updated_at);
    expect(stored!.created_at).toBe(stored!.updated_at); // both stamps from one reading (S6)
    expect(w.time.readings.map((r) => r.timestamp)).toContain(stored!.created_at); // and that reading is the API clock's, not the database's
    expect(await syncRow(piece)).toEqual(answer.row);
  });

  it('then the owner corrects it with the stamp she holds: 200 {row}, the value and updated_at move, created_at and created_by stay, updated_by is the owner', async () => {
    const piece = await addPiece(w, design);
    const first = body(await put('owner', piece, { original_net_weight: '8.500' })).row;
    const res = await put('owner', piece, { original_net_weight: '9.250', expected_updated_at: first.updated_at });
    expect(res.statusCode, res.body).toBe(200);
    const row = body(res).row;
    expect(row).toMatchObject({ sku_id: piece, original_net_weight: '9.250', created_at: first.created_at, created_by: owner(), updated_by: owner() });
    expect(row.updated_at > first.updated_at).toBe(true);
    expect(await privateRow(piece)).toMatchObject({ original_net_weight: '9.250' });
    expect(await syncRow(piece)).toEqual(row);
    // and again, from the new row
    const third = await put('owner', piece, { original_net_weight: '9.000', expected_updated_at: row.updated_at });
    expect(third.statusCode, third.body).toBe(200);
    expect(body(third).row.original_net_weight).toBe('9.000');
  });

  it('a weight typed with fewer decimals is stored with three ("8.5" is 8.500); the same value again, with the stamp, is 200 and writes nothing: no new stamp, the row as it was', async () => {
    const piece = await addPiece(w, design);
    await addWeight(piece, '8.500');
    const before = await snapshotOf(piece);
    const same = await put('owner', piece, { original_net_weight: '8.5', expected_updated_at: STAMP_WIRE });
    expect(same.statusCode, same.body).toBe(200);
    expect(body(same).row).toMatchObject({ original_net_weight: '8.500', updated_at: STAMP_WIRE });
    expect(await snapshotOf(piece)).toBe(before);
    const other = await put('owner', piece, { original_net_weight: '8.6', expected_updated_at: STAMP_WIRE });
    expect(other.statusCode, other.body).toBe(200);
    expect(body(other).row.original_net_weight).toBe('8.600');
  });

  it('a piece that X8 made WITH the weight: the owner corrects it with the stamp X8 returned; the next sync read of the owner shows the new value', async () => {
    const made = await createDesign(w, 'owner', designPayload(w, { pieces: [{ pieces: 1, gross_weight: '10.000', customer_net_weight: '9.000', original_net_weight: '8.500' }] }));
    expect(made.statusCode, made.body).toBe(201);
    const [weight] = body(made).sku_private;
    const res = await put('owner', weight.sku_id, { original_net_weight: '8.750', expected_updated_at: weight.updated_at });
    expect(res.statusCode, res.body).toBe(200);
    expect((await syncRow(weight.sku_id)).original_net_weight).toBe('8.750');
  });

  it('a piece that staff made, which has no weight row (X8 stores one only when the owner sent a weight): the owner enters it later, 201', async () => {
    const made = await createDesign(w, 'staff', designPayload(w, { pieces: [{ pieces: 2, gross_weight: '10.000', customer_net_weight: '9.000' }] }));
    expect(made.statusCode, made.body).toBe(201);
    expect(body(made).sku_private).toBeUndefined();
    const [a, b] = body(made).skus;
    expect(await privateRow(a.id)).toBeUndefined();
    const res = await put('owner', a.id, { original_net_weight: '8.100' });
    expect(res.statusCode, res.body).toBe(201);
    expect(await privateRow(a.id)).toMatchObject({ original_net_weight: '8.100', created_by: owner() });
    expect(await privateRow(b.id)).toBeUndefined(); // the other piece of the group is not touched
  });

  it('a Sold or an archived piece can have its weight corrected too: the row belongs to the piece, whatever the piece\'s state', async () => {
    const { piece: sold } = await addSoldPiece(w, design);
    expect((await put('owner', sold, { original_net_weight: '5.000' })).statusCode).toBe(201);
    const archived = await addPieceIn(w, design, 'Archived');
    expect((await put('owner', archived, { original_net_weight: '5.000' })).statusCode).toBe(201);
  });
});

describe('T-D02 (API13c) the stale check of A5 applies when the row exists (T-C07 and T-F09 clauses)', () => {
  it('a stamp that is not the row\'s: 409 JV_STALE, nothing changes, details.current is the row the sync read gives (the screen reloads it)', async () => {
    const piece = await addPiece(w, design);
    await addWeight(piece, '10.500');
    const before = await snapshotOf(piece);
    const res = await put('owner', piece, { original_net_weight: '9.000', expected_updated_at: '2026-09-30T00:00:00.000000Z' });
    expect(res.statusCode, res.body).toBe(409);
    expect(codeOf(res)).toBe('JV_STALE');
    expect(detailsOf(res).current).toEqual(await syncRow(piece));
    expect(detailsOf(res).current).toMatchObject({ original_net_weight: '10.500', updated_at: STAMP_WIRE });
    expect(await snapshotOf(piece)).toBe(before);
  });

  it('two screens hold the same row: the first save wins, the second is stale and gets the first one\'s row; with that stamp the second save goes through', async () => {
    const piece = await addPiece(w, design);
    await addWeight(piece, '10.500');
    const a = await put('owner', piece, { original_net_weight: '9.100', expected_updated_at: STAMP_WIRE });
    expect(a.statusCode, a.body).toBe(200);
    const b = await put('owner', piece, { original_net_weight: '9.200', expected_updated_at: STAMP_WIRE });
    expect([b.statusCode, codeOf(b)]).toEqual([409, 'JV_STALE']);
    expect(detailsOf(b).current).toEqual(body(a).row);
    expect((await privateRow(piece))!.original_net_weight).toBe('9.100');
    const retry = await put('owner', piece, { original_net_weight: '9.200', expected_updated_at: detailsOf(b).current.updated_at });
    expect(retry.statusCode, retry.body).toBe(200);
    expect((await privateRow(piece))!.original_net_weight).toBe('9.200');
  });

  it('no stamp, or a null one, while the row exists means "the screen holds no row": 409 JV_STALE with the row (another tab made it first); the value is not written', async () => {
    const piece = await addPiece(w, design);
    await addWeight(piece, '10.500');
    const before = await snapshotOf(piece);
    for (const payload of [{ original_net_weight: '9.000' }, { original_net_weight: '9.000', expected_updated_at: null }]) {
      const res = await put('owner', piece, payload);
      expect([res.statusCode, codeOf(res)], JSON.stringify(payload)).toEqual([409, 'JV_STALE']);
      expect(detailsOf(res).current).toMatchObject({ sku_id: piece, original_net_weight: '10.500' });
    }
    expect(await snapshotOf(piece)).toBe(before);
  });

  it('a null stamp is the same as none for a piece without a row: the first write works', async () => {
    const piece = await addPiece(w, design);
    const res = await put('owner', piece, { original_net_weight: '4.000', expected_updated_at: null });
    expect(res.statusCode, res.body).toBe(201);
  });

  it('a stamp for a piece that has no row is a mistake of the screen: 422 on expected_updated_at, and no row is made', async () => {
    const piece = await addPiece(w, design);
    const res = await put('owner', piece, { original_net_weight: '4.000', expected_updated_at: STAMP_WIRE });
    expect([res.statusCode, codeOf(res)]).toEqual([422, 'JV_INVALID_INPUT']);
    expect(detailsOf(res)).toEqual({ field: 'expected_updated_at' });
    expect(await privateRow(piece)).toBeUndefined();
  });

  it.each([
    ['database text', '2026-10-01 08:30:15.123457'],
    ['three decimals', '2026-10-01T08:30:15.123Z'],
    ['no Z', '2026-10-01T08:30:15.123457'],
    ['a number', 1_790_000_000],
    ['not a date', 'yesterday'],
  ])('a stamp that is not the exact text the server sent (%s) is 422 on expected_updated_at before the database is asked', async (_what, stamp) => {
    const piece = await addPiece(w, design);
    await addWeight(piece, '10.500');
    const before = await snapshotOf(piece);
    const res = await put('owner', piece, { original_net_weight: '9.000', expected_updated_at: stamp });
    expect([res.statusCode, codeOf(res)]).toEqual([422, 'JV_INVALID_INPUT']);
    expect(detailsOf(res)).toEqual({ field: 'expected_updated_at' });
    expect(await snapshotOf(piece)).toBe(before);
  });

  it('the order of the answers is the one of every edit: the stale check comes before the rules of the value (a stale save of a weight above the gross weight is answered stale)', async () => {
    const piece = await addPiece(w, design, { gross_weight: '12.500' });
    await addWeight(piece, '10.500');
    const res = await put('owner', piece, { original_net_weight: '99.000', expected_updated_at: '2026-09-30T00:00:00.000000Z' });
    expect([res.statusCode, codeOf(res)]).toEqual([409, 'JV_STALE']);
    const fresh = await put('owner', piece, { original_net_weight: '99.000', expected_updated_at: STAMP_WIRE });
    expect([fresh.statusCode, codeOf(fresh)]).toEqual([422, 'JV_INVALID_INPUT']);
  });

  it('a stale save with the value already stored is stale too (the screen\'s copy is old); with the right stamp it is a quiet 200', async () => {
    const piece = await addPiece(w, design);
    await addWeight(piece, '10.500');
    expect((await put('owner', piece, { original_net_weight: '10.500', expected_updated_at: '2026-09-30T00:00:00.000000Z' })).statusCode).toBe(409);
    expect((await put('owner', piece, { original_net_weight: '10.500', expected_updated_at: STAMP_WIRE })).statusCode).toBe(200);
  });

  it('two first writes at the same moment for one piece: one makes the row (201), the other is stale (409 with the row) and never a 500; one row, 12 rounds', async () => {
    for (let round = 0; round < 12; round++) {
      const piece = await addPiece(w, design);
      const [a, b] = await Promise.all([put('owner', piece, { original_net_weight: '3.100' }), put('owner', piece, { original_net_weight: '3.200' })]);
      expect([a.statusCode, b.statusCode].sort(), `round ${round}: ${a.body} / ${b.body}`).toEqual([201, 409]);
      const loser = a.statusCode === 409 ? a : b;
      expect(codeOf(loser)).toBe('JV_STALE');
      expect(detailsOf(loser).current.sku_id).toBe(piece);
      expect(Number((await w.world.sql.query<any[]>('SELECT COUNT(*) AS n FROM sku_private WHERE sku_id = ?', [piece]))[0][0].n)).toBe(1);
    }
  });
});

describe('T-D02 (API13c) the weight rules of D7: a plain 3-decimal text within the cap, not above the gross weight', () => {
  const REFUSED: [string, unknown][] = [
    ['above the gross weight (12.500)', '12.501'],
    ['far above the gross weight', '99.000'],
    ['4 decimals', '8.5001'],
    ['4 decimals, the last one zero', '8.5000'],
    ['a negative weight', '-1.000'],
    ['letters', 'abc'],
    ['an empty text', ''],
    ['an exponent', '1e1'],
    ['a space', ' 8.500'],
    ['a comma', '8,500'],
    ['a JSON number (a weight crosses the wire as text)', 8.5],
    ['null', null],
  ];

  it.each(REFUSED)('%s is 422 JV_INVALID_INPUT on original_net_weight, the message does not repeat the value, nothing is made', async (_what, value) => {
    const piece = await addPiece(w, design, { gross_weight: '12.500' });
    const res = await put('owner', piece, { original_net_weight: value });
    expect([res.statusCode, codeOf(res)], res.body).toEqual([422, 'JV_INVALID_INPUT']);
    expect(detailsOf(res)).toEqual({ field: 'original_net_weight' });
    // the random request id in the body is left out: a UUID can contain 'abc' by chance
    if (typeof value === 'string' && value.length > 1) expect(res.body.replace(/"request_id":"[^"]*"/, '')).not.toContain(value);
    expect(await privateRow(piece)).toBeUndefined();
  });

  it.each(REFUSED)('%s is refused for a correction too: the stored weight stays', async (_what, value) => {
    const piece = await addPiece(w, design, { gross_weight: '12.500' });
    await addWeight(piece, '10.500');
    const before = await snapshotOf(piece);
    const res = await put('owner', piece, { original_net_weight: value, expected_updated_at: STAMP_WIRE });
    expect([res.statusCode, codeOf(res)], res.body).toEqual([422, 'JV_INVALID_INPUT']);
    expect(await snapshotOf(piece)).toBe(before);
  });

  it('the rule runs when the weight changes and not when it is saved again as it is (D7: a row that already breaks the rule is not blocked by it): a stored weight above the gross weight can be saved unchanged, not changed to another one above', async () => {
    const piece = await addPiece(w, design, { gross_weight: '12.500' });
    await addWeight(piece, '20.000'); // typed in by hand, as the import or an older edit of the gross weight could have left it
    const before = await snapshotOf(piece);
    const same = await put('owner', piece, { original_net_weight: '20.000', expected_updated_at: STAMP_WIRE });
    expect(same.statusCode, same.body).toBe(200);
    expect(await snapshotOf(piece)).toBe(before);
    const other = await put('owner', piece, { original_net_weight: '21.000', expected_updated_at: STAMP_WIRE });
    expect([other.statusCode, codeOf(other)]).toEqual([422, 'JV_INVALID_INPUT']);
    const fixed = await put('owner', piece, { original_net_weight: '12.000', expected_updated_at: STAMP_WIRE });
    expect(fixed.statusCode, fixed.body).toBe(200);
  });

  it('the weight equal to the gross weight is allowed (the rule is "not above"); one gram below is too', async () => {
    const piece = await addPiece(w, design, { gross_weight: '12.500' });
    expect((await put('owner', piece, { original_net_weight: '12.500' })).statusCode).toBe(201);
    expect((await put('owner', piece, { original_net_weight: '11.500', expected_updated_at: timestampToWire((await privateRow(piece))!.updated_at) })).statusCode).toBe(200);
  });

  it('a piece with a blank gross weight (stored as 0, D7) takes any weight within the cap: the comparison runs only when the gross weight is above 0', async () => {
    const piece = await addPiece(w, design, { gross_weight: '0.000' });
    const res = await put('owner', piece, { original_net_weight: '50.000' });
    expect(res.statusCode, res.body).toBe(201);
  });

  it('the cap is 100,000 g (S4, chk_sku_private_weight): 100000.000 is allowed on a piece with no gross weight, 100000.001 is a refusal of the field and never the database\'s CHECK', async () => {
    const piece = await addPiece(w, design, { gross_weight: '0.000' });
    const over = await put('owner', piece, { original_net_weight: '100000.001' });
    expect([over.statusCode, codeOf(over)]).toEqual([422, 'JV_INVALID_INPUT']);
    expect(detailsOf(over)).toEqual({ field: 'original_net_weight' });
    const edge = await put('owner', piece, { original_net_weight: '100000.000' });
    expect(edge.statusCode, edge.body).toBe(201);
  });

  it('zero is a weight the CHECK allows and D7 does not refuse for the original weight (the By Weight rule of O37 is about the customer net weight)', async () => {
    const piece = await addPiece(w, design, { gross_weight: '12.500' });
    expect((await put('owner', piece, { original_net_weight: '0.000' })).statusCode).toBe(201);
  });

  it('the gross weight is read under the lock of the piece: while another transaction holds the piece and lowers its gross weight, the save waits, then sees the new gross weight and refuses a weight above it', async () => {
    const piece = await addPiece(w, design, { gross_weight: '12.500', customer_net_weight: '5.000' });
    const other = await w.world.scratch.connect();
    try {
      await other.query('START TRANSACTION');
      await other.query('SELECT id FROM skus WHERE id = ? FOR UPDATE', [piece]);
      await other.query('UPDATE skus SET gross_weight = ? WHERE id = ?', ['6.000', piece]);
      const pending = put('owner', piece, { original_net_weight: '9.000' });
      const early = await Promise.race([pending.then(() => 'answered'), new Promise((resolve) => setTimeout(() => resolve('waiting'), 500))]);
      expect(early, 'the save must wait for the lock of the piece').toBe('waiting');
      await other.query('COMMIT');
      const res = await pending;
      expect([res.statusCode, codeOf(res)], res.body).toEqual([422, 'JV_INVALID_INPUT']);
      expect(detailsOf(res)).toEqual({ field: 'original_net_weight' });
      expect(await privateRow(piece)).toBeUndefined();
    } finally {
      await other.end();
    }
  });
});

describe('T-D02 (API13c) the body and the address', () => {
  it('an empty body names the missing field: 422 on original_net_weight', async () => {
    const piece = await addPiece(w, design);
    const res = await put('owner', piece, {});
    expect([res.statusCode, codeOf(res)]).toEqual([422, 'JV_INVALID_INPUT']);
    expect(detailsOf(res)).toEqual({ field: 'original_net_weight' });
  });

  it('a stamp alone is not a body either', async () => {
    const piece = await addPiece(w, design);
    await addWeight(piece);
    const res = await put('owner', piece, { expected_updated_at: STAMP_WIRE });
    expect([res.statusCode, codeOf(res)]).toEqual([422, 'JV_INVALID_INPUT']);
    expect(detailsOf(res)).toEqual({ field: 'original_net_weight' });
  });

  it('a name that is no field is 422 and names it; the whole call is refused and the other field is not applied', async () => {
    const piece = await addPiece(w, design);
    await addWeight(piece, '10.500');
    const before = await snapshotOf(piece);
    const res = await put('owner', piece, { original_net_weight: '9.000', expected_updated_at: STAMP_WIRE, colour: 'red' });
    expect([res.statusCode, codeOf(res)]).toEqual([422, 'JV_INVALID_INPUT']);
    expect(detailsOf(res)).toEqual({ field: 'colour' });
    expect(await snapshotOf(piece)).toBe(before);
  });

  it.each(['created_at', 'updated_at', 'created_by', 'updated_by', 'set_by', 'confirmed_by'])('the stamp or person column %s sent by a client is an unknown field: 422, never stored (S6, D22)', async (column) => {
    const piece = await addPiece(w, design);
    const res = await put('owner', piece, { original_net_weight: '4.000', [column]: column.endsWith('_by') ? randomUUID() : '2020-01-01T00:00:00.000000Z' });
    expect([res.statusCode, codeOf(res)]).toEqual([422, 'JV_INVALID_INPUT']);
    expect(detailsOf(res)).toEqual({ field: column });
    expect(await privateRow(piece)).toBeUndefined();
  });

  it('sku_id in the body is a column of the table that nobody may send: 403 JV_FORBIDDEN naming it (the address is the only way to name the piece)', async () => {
    const piece = await addPiece(w, design);
    const other = await addPiece(w, design);
    const res = await put('owner', piece, { original_net_weight: '4.000', sku_id: other });
    expect([res.statusCode, codeOf(res)]).toEqual([403, 'JV_FORBIDDEN']);
    expect(detailsOf(res)).toEqual({ field: 'sku_id' });
    expect([await privateRow(piece), await privateRow(other)]).toEqual([undefined, undefined]);
  });

  it('a piece that does not exist is 404 JV_NOT_FOUND and no row is made (the foreign key is never asked); so is an id that is not a UUID', async () => {
    const before = await privateCount();
    for (const id of [randomUUID(), 'not-a-uuid', '12345', randomUUID().toUpperCase()]) {
      const res = await put('owner', id, { original_net_weight: '4.000' });
      expect([id, res.statusCode, codeOf(res)]).toEqual([id, 404, 'JV_NOT_FOUND']);
      expect(body(res).error.message, `${id}: the 404 of a missing record, not of a missing address`).toBe('That record does not exist.');
    }
    expect(await privateCount()).toBe(before);
  });

  it('the answer is the same wherever the stamp is read: the row of a first write is what the poll of the owner returns next', async () => {
    const piece = await addPiece(w, design);
    const made = body(await put('owner', piece, { original_net_weight: '4.000' })).row;
    const polled = await poll(w.world, 'owner', { cursors: { 'sku-private': null } });
    expect(polled.statusCode).toBe(200);
    expect(JSON.parse(polled.body).results['sku-private'].rows).toContainEqual(made);
  });
});

describe('T-D03 (API13c) only the owner writes the original weight, and nobody else ever receives it', () => {
  it.each(['biller', 'staff'] as const)('%s: the PUT is 403 JV_FORBIDDEN, nothing is made or changed, and the refusal does not repeat the weight', async (caller) => {
    const fresh = await addPiece(w, design);
    const held = await addPiece(w, design);
    await addWeight(held, '10.500');
    const before = await snapshotOf(held);
    const count = await privateCount();
    for (const [piece, payload] of [
      [fresh, { original_net_weight: '4.321' }],
      [held, { original_net_weight: '4.321', expected_updated_at: STAMP_WIRE }],
    ] as const) {
      const res = await put(caller, piece, payload);
      expect([res.statusCode, codeOf(res)]).toEqual([403, 'JV_FORBIDDEN']);
      expect(res.body).not.toContain('4.321');
    }
    expect(await snapshotOf(held)).toBe(before);
    expect(await privateCount()).toBe(count);
  });

  it('a signed-out caller is 401 and the owner is let in (the control: the walls are not a broken route)', async () => {
    const piece = await addPiece(w, design);
    const anon = await put('anon', piece, { original_net_weight: '4.000' });
    expect([anon.statusCode, codeOf(anon)]).toEqual([401, 'JV_UNAUTHENTICATED']);
    expect((await put('owner', piece, { original_net_weight: '4.000' })).statusCode).toBe(201);
  });

  it('once the owner has set a weight, no read and no function result for a biller or staff holds it: every sync resource they may read, a poll of all of them, the answers of the piece edit, X9, X8 and the quote, and the refusals', async () => {
    const SECRET = '6.287';
    const piece = await addPiece(w, design, { location: 'Showroom', gross_weight: '12.500' });
    expect((await put('owner', piece, { original_net_weight: SECRET })).statusCode).toBe(201);
    const seen: [string, string][] = [];
    for (const caller of ['biller', 'staff'] as const) {
      const readable = SYNC_ROWS.filter((r) => r.roles.includes(caller));
      expect(readable.length).toBeGreaterThanOrEqual(7);
      expect(readable.map((r) => r.name)).not.toContain('sku-private');
      for (const r of readable) seen.push([`${caller} GET ${r.name}`, JSON.stringify((await pageAll(w.world, caller, r.name)).rows)]);
      const polled = await poll(w.world, caller, { cursors: Object.fromEntries(readable.map((r) => [r.name, null])) });
      expect(polled.statusCode, `${caller} poll: ${polled.body.slice(0, 120)}`).toBe(200);
      seen.push([`${caller} poll`, polled.body]);
      seen.push([`${caller} PUT sku-private`, (await put(caller, piece, { original_net_weight: '4.321' })).body]);
    }
    const edited = await patch(w, 'staff', 'skus', piece, STAMP_WIRE, { location: 'Vault' });
    expect(edited.statusCode, edited.body).toBe(200);
    seen.push(['staff PATCH skus', edited.body]);
    const status = await setStatus(w, 'staff', { sku_ids: [piece], status: 'Repair' });
    expect(status.statusCode, status.body).toBe(200);
    seen.push(['staff set_sku_status', status.body]);
    const staffDesign = await createDesign(w, 'staff', designPayload(w, { pieces: [{ pieces: 1, gross_weight: '5.000', customer_net_weight: '4.000' }] }));
    expect(staffDesign.statusCode, staffDesign.body).toBe(201);
    seen.push(['staff create_design', staffDesign.body]);
    const quote = await w.world.call('biller', 'POST', '/v1/bills/quote', { payload: { sale_type: 'Retail', items: [{ sku_id: piece, metal_rate: '6920.00', labour_rate: '350.00', piroi: '0.00', other_charges: '0.00', quantity: 1 }] } });
    expect(quote.statusCode, quote.body).toBe(200);
    seen.push(['biller quote_bill', quote.body]);
    for (const [what, text] of seen) {
      expect(text, what).not.toContain(SECRET);
      expect(text, what).not.toContain('original_net_weight');
    }
    // the owner's own answers for the piece and the design do not carry it either: it is in sku_private and nowhere else (D9)
    const ownerEdit = await patch(w, 'owner', 'skus', piece, await stampOf(w, 'skus', piece), { location: 'Counter' });
    expect(ownerEdit.statusCode, ownerEdit.body).toBe(200);
    expect(ownerEdit.body).not.toContain(SECRET);
    expect(JSON.stringify((await pageAll(w.world, 'owner', 'skus')).rows)).not.toContain(SECRET);
    expect(JSON.stringify((await pageAll(w.world, 'owner', 'sku-private')).rows)).toContain(SECRET);
  });
});

describe('T-D02 (API13c) the route is part of the matrix: registered through route(), the weight is the only field, and the walk of the generated test covers it', () => {
  it('the row edit:sku_private.update is routed as PUT /v1/sku-private/:sku_id for the owner only', async () => {
    const route = w.world.app.routeTable.find((r) => r.action === 'edit:sku_private.update');
    expect(route).toMatchObject({ method: 'PUT', url: '/v1/sku-private/:sku_id', kind: 'matrix', roles: ['owner'], mustChange: false });
  });

  it('the engine\'s table and the matrix agree on the column: the field the owner may send has a FieldSpec, and the answer\'s columns are the owner\'s READ_COLUMNS', async () => {
    const { SKU_PRIVATE } = await import('../../src/edit/skuPrivate');
    const { WRITE_COLUMNS } = await import('../../src/permissions/matrix');
    expect(Object.keys(SKU_PRIVATE.fields)).toEqual(['original_net_weight']);
    expect(WRITE_COLUMNS['edit:sku_private.update']).toEqual({ owner: ['original_net_weight'] });
    for (const c of Object.keys(SKU_PRIVATE.fields)) expect(READ_COLUMNS.sku_private.owner).toContain(c);
  });
});
