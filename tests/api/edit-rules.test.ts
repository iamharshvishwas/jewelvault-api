import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { weightProblem } from '../../src/edit/skus';
import { V, insert } from '../schema/support';
import { type EditWorld, STAMP_WIRE, addDesign, addPhoto, addPiece, body, codeOf, dbRow, detailsOf, editWorld, patch, snapshot, stampOf } from './edit-support';

// API13, the rules of an ordinary edit that are code and not columns:
//   T-F05  A design's `selling_method` (through PATCH) cannot change while it has a non-archived piece; a design with non-archived pieces cannot be archived.   (D6, A5)
//   and the rest of A5 and D7 that have no test of their own: the photo checks of P2 (a)-(e) on `photo_ids` and `primary_photo_id`, the weight rules of D7 (O37), the categories a design points at.
// The rules are the API's (D6: "a trigger version is possible if triggers work"): the database half of T-F05 shows that the same change typed in SQL is NOT refused by the database.

let w: EditWorld;
beforeAll(async () => {
  w = await editWorld('editrules');
}, 120_000);
afterAll(async () => {
  await w?.world.close();
});

const ARCHIVED = { status: 'Archived', archived_at: '2026-10-05 00:00:00.000000' };

describe('T-F05 a design\'s selling_method cannot change while it has a non-archived piece (D6, A5)', () => {
  it('with a piece in stock the owner\'s change is 409 JV_NOT_ALLOWED and the design is untouched', async () => {
    const d = await addDesign(w);
    await addPiece(w, d);
    const before = await snapshot(w, 'designs', d);
    const res = await patch(w, 'owner', 'designs', d, STAMP_WIRE, { selling_method: 'Per Piece' });
    expect(res.statusCode).toBe(409);
    expect(codeOf(res)).toBe('JV_NOT_ALLOWED');
    expect(detailsOf(res)).toEqual({ field: 'changes.selling_method' });
    expect(await snapshot(w, 'designs', d)).toBe(before);
  });

  it.each(['In Stock', 'Reserved', 'On Approval', 'Sold', 'Returned', 'Repair', 'Transferred', 'Missing', 'Damaged'])('a piece that is %s is a non-archived piece: it locks the method', async (status) => {
    const d = await addDesign(w);
    const bill = randomUUID();
    if (status === 'Sold') {
      await insert(w.world.sql, 'bills', V.bill('00000000-0000-4000-8000-000000000001', { id: bill }));
      await addPiece(w, d, { status, sold_bill_id: bill });
    } else await addPiece(w, d, { status });
    const res = await patch(w, 'owner', 'designs', d, STAMP_WIRE, { selling_method: 'Per Piece' });
    expect(res.statusCode).toBe(409);
    expect(codeOf(res)).toBe('JV_NOT_ALLOWED');
    expect((await dbRow(w, 'designs', d)).selling_method).toBe('By Weight');
  });

  it('a design with no piece, or with every piece archived, can change its method; one piece that is not archived is enough to refuse', async () => {
    const none = await addDesign(w);
    expect((await patch(w, 'owner', 'designs', none, STAMP_WIRE, { selling_method: 'Per Piece' })).statusCode).toBe(200);
    expect((await dbRow(w, 'designs', none)).selling_method).toBe('Per Piece');

    const archivedOnly = await addDesign(w);
    await addPiece(w, archivedOnly, ARCHIVED);
    await addPiece(w, archivedOnly, ARCHIVED);
    expect((await patch(w, 'owner', 'designs', archivedOnly, STAMP_WIRE, { selling_method: 'Per Piece' })).statusCode).toBe(200);

    const mixed = await addDesign(w);
    await addPiece(w, mixed, ARCHIVED);
    await addPiece(w, mixed);
    const res = await patch(w, 'owner', 'designs', mixed, STAMP_WIRE, { selling_method: 'Per Piece' });
    expect(res.statusCode).toBe(409);
    expect((await dbRow(w, 'designs', mixed)).selling_method).toBe('By Weight');
  });

  it('sending the method it already has is no change, so it is not refused (the screen may send the whole form)', async () => {
    const d = await addDesign(w);
    await addPiece(w, d);
    const before = await snapshot(w, 'designs', d);
    const res = await patch(w, 'owner', 'designs', d, STAMP_WIRE, { selling_method: 'By Weight' });
    expect(res.statusCode, res.body).toBe(200);
    expect(await snapshot(w, 'designs', d)).toBe(before);
  });

  it('staff cannot change it at all, whatever the pieces are (the column is not on their list): 403', async () => {
    const d = await addDesign(w);
    const res = await patch(w, 'staff', 'designs', d, STAMP_WIRE, { selling_method: 'Per Piece' });
    expect(res.statusCode).toBe(403);
    expect(codeOf(res)).toBe('JV_FORBIDDEN');
  });

  it('material, purity and category may change while pieces exist: the pieces show the new ones, because they live only in the design (D6)', async () => {
    const d = await addDesign(w);
    const p = await addPiece(w, d);
    const res = await patch(w, 'owner', 'designs', d, STAMP_WIRE, { material: 'Silver', purity: '925', category_id: w.other_category });
    expect(res.statusCode, res.body).toBe(200);
    const row = await dbRow(w, 'designs', d);
    expect([row.material, row.purity, row.category_id]).toEqual(['Silver', '925', w.other_category]);
    expect(await dbRow(w, 'skus', p)).toBeDefined();
  });

  describe('the DB half: the database itself accepts the change (the rule is the API\'s, D6), so the 409 above is the only wall', () => {
    it('typed in SQL, the same change goes through', async () => {
      const d = await addDesign(w);
      await addPiece(w, d);
      await w.world.sql.query("UPDATE designs SET selling_method = 'Per Piece' WHERE id = ?", [d]);
      expect((await dbRow(w, 'designs', d)).selling_method).toBe('Per Piece');
    });
  });
});

describe('T-F05 a design with non-archived pieces cannot be archived (A5)', () => {
  it('a piece in stock, or sold, refuses the archive: 409 JV_NOT_ALLOWED, for staff and for the owner, and the design stays as it was', async () => {
    for (const caller of ['staff', 'owner'] as const) {
      const d = await addDesign(w);
      await addPiece(w, d);
      const before = await snapshot(w, 'designs', d);
      const res = await patch(w, caller, 'designs', d, STAMP_WIRE, { archived_at: '2026-10-17T10:00:00.000000Z' });
      expect(res.statusCode, caller).toBe(409);
      expect(codeOf(res)).toBe('JV_NOT_ALLOWED');
      expect(detailsOf(res)).toEqual({ field: 'changes.archived_at' });
      expect(await snapshot(w, 'designs', d)).toBe(before);
    }
  });

  it('with every piece archived (or none) the archive goes through; one piece that is not archived refuses it again', async () => {
    const d = await addDesign(w);
    const p = await addPiece(w, d, ARCHIVED);
    const q = await addPiece(w, d);
    expect((await patch(w, 'staff', 'designs', d, STAMP_WIRE, { archived_at: '2026-10-17T10:00:00.000000Z' })).statusCode).toBe(409);
    await w.world.sql.query("UPDATE skus SET status = 'Archived', archived_at = '2026-10-06 00:00:00.000000' WHERE id = ?", [q]);
    const res = await patch(w, 'staff', 'designs', d, STAMP_WIRE, { archived_at: '2026-10-17T10:00:00.000000Z' });
    expect(res.statusCode, res.body).toBe(200);
    expect((await dbRow(w, 'designs', d)).archived_at).not.toBeNull();
    expect(p).toBeDefined();
  });

  it('bringing an archived design back needs no check, and archiving an archived design again changes nothing (the first archive time stays)', async () => {
    const d = await addDesign(w, { archived_at: '2026-10-05 00:00:00.000000' });
    await addPiece(w, d); // a piece in stock under an archived design (an import can leave one): archiving again is no change, so it is not refused
    const again = await patch(w, 'staff', 'designs', d, STAMP_WIRE, { archived_at: '2026-10-17T10:00:00.000000Z' });
    expect(again.statusCode, again.body).toBe(200);
    expect((await dbRow(w, 'designs', d)).archived_at).toBe('2026-10-05 00:00:00.000000');
    const back = await patch(w, 'staff', 'designs', d, STAMP_WIRE, { archived_at: null });
    expect(back.statusCode, back.body).toBe(200);
    expect((await dbRow(w, 'designs', d)).archived_at).toBeNull();
  });
});

describe('D7, O37 the weight rules run on a change of a weight column', () => {
  let d: string;
  let perPiece: string;
  beforeAll(async () => {
    d = await addDesign(w);
    perPiece = await addDesign(w, { selling_method: 'Per Piece' });
  });

  it('a customer net weight above a gross weight that is above 0 is 422, naming the net weight; equal is fine', async () => {
    const p = await addPiece(w, d, { gross_weight: '10.000', customer_net_weight: '9.000' });
    const res = await patch(w, 'staff', 'skus', p, STAMP_WIRE, { customer_net_weight: '10.001' });
    expect(res.statusCode).toBe(422);
    expect(codeOf(res)).toBe('JV_INVALID_INPUT');
    expect(detailsOf(res)).toEqual({ field: 'changes.customer_net_weight' });
    expect((await dbRow(w, 'skus', p)).customer_net_weight).toBe('9.000');
    expect((await patch(w, 'staff', 'skus', p, STAMP_WIRE, { customer_net_weight: '10.000' })).statusCode).toBe(200);
  });

  it('lowering only the gross weight below the net weight breaks the rule too (the rule is about the pair after the change)', async () => {
    const p = await addPiece(w, d, { gross_weight: '10.000', customer_net_weight: '9.000' });
    const res = await patch(w, 'owner', 'skus', p, STAMP_WIRE, { gross_weight: '8.500' });
    expect(res.statusCode).toBe(422);
    expect(detailsOf(res)).toEqual({ field: 'changes.gross_weight' });
    expect((await dbRow(w, 'skus', p)).gross_weight).toBe('10.000');
    const both = await patch(w, 'owner', 'skus', p, STAMP_WIRE, { gross_weight: '8.500', customer_net_weight: '8.000' });
    expect(both.statusCode, both.body).toBe(200);
  });

  it('a blank gross weight (0, the prototype\'s default) allows any net weight', async () => {
    const p = await addPiece(w, d, { gross_weight: '0.000', customer_net_weight: '1.000' });
    const res = await patch(w, 'staff', 'skus', p, STAMP_WIRE, { customer_net_weight: '5.250' });
    expect(res.statusCode, res.body).toBe(200);
    expect((await dbRow(w, 'skus', p)).customer_net_weight).toBe('5.250');
  });

  it('a By Weight piece cannot get a net weight of 0 ("staff could save weight 0"); a Per Piece piece can', async () => {
    const p = await addPiece(w, d, { gross_weight: '10.000', customer_net_weight: '9.000' });
    const res = await patch(w, 'staff', 'skus', p, STAMP_WIRE, { customer_net_weight: '0.000' });
    expect(res.statusCode).toBe(422);
    expect(detailsOf(res)).toEqual({ field: 'changes.customer_net_weight' });
    expect((await dbRow(w, 'skus', p)).customer_net_weight).toBe('9.000');
    const pp = await addPiece(w, perPiece, { gross_weight: '10.000', customer_net_weight: '9.000' });
    expect((await patch(w, 'staff', 'skus', pp, STAMP_WIRE, { customer_net_weight: '0.000' })).statusCode).toBe(200);
  });

  it('the rule does not run on an update that leaves the weights alone: an imported piece that already breaks it can still be moved (O37: not a CHECK, never blocks a status or a location)', async () => {
    const broken = await addPiece(w, d, { gross_weight: '5.000', customer_net_weight: '9.000' });
    const res = await patch(w, 'staff', 'skus', broken, STAMP_WIRE, { location: 'Workshop' });
    expect(res.statusCode, res.body).toBe(200);
    expect((await dbRow(w, 'skus', broken)).location).toBe('Workshop');
    // and a weight edit that leaves it broken is refused, one that mends it is not
    const stamp = await stampOf(w, 'skus', broken);
    expect((await patch(w, 'staff', 'skus', broken, stamp, { gross_weight: '6.000' })).statusCode).toBe(422);
    expect((await patch(w, 'staff', 'skus', broken, stamp, { gross_weight: '9.000' })).statusCode).toBe(200);
  });

  it('weights, money and counts cross the wire as the formats of S3 say: text with the right decimals and caps, integers for counts', async () => {
    const p = await addPiece(w, d, { gross_weight: '10.000', customer_net_weight: '9.000' });
    const ok = await patch(w, 'owner', 'skus', p, STAMP_WIRE, { gross_weight: '12.5', stone_weight: '0.250', stones: 3, kundan: 2, kundan_weight: '1', piroi: '100.5', labour_retail: '120', labour_semi: '110.00', labour_wholesale: '100.00' });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(body(ok).row).toMatchObject({ gross_weight: '12.500', stone_weight: '0.250', stones: 3, kundan: 2, kundan_weight: '1.000', piroi: '100.50', labour_retail: '120.00' });
    const stamp = body(ok).row.updated_at as string;
    for (const bad of [{ gross_weight: 12.5 }, { gross_weight: '12.5000' }, { gross_weight: '-1' }, { gross_weight: '100000.001' }, { piroi: '1.234' }, { labour_retail: '100000001' }, { stones: '3' }, { stones: 1.5 }, { stones: -1 }, { kundan: null }, { location: 5 }]) {
      const res = await patch(w, 'owner', 'skus', p, stamp, bad);
      expect(res.statusCode, JSON.stringify(bad)).toBe(422);
      expect(codeOf(res)).toBe('JV_INVALID_INPUT');
    }
  });
});

describe('D7, O37 weightProblem: the one rule an insert (X8) and an edit both ask', () => {
  it.each([
    ['10.000', '9.000', 'By Weight', null],
    ['10.000', '10.000', 'By Weight', null],
    ['10.000', '10.001', 'By Weight', 'net_above_gross'],
    ['10.000', '10.001', 'Per Piece', 'net_above_gross'],
    ['0.000', '25.000', 'By Weight', null],
    ['0.000', '0.000', 'By Weight', 'net_zero'],
    ['10.000', '0.000', 'By Weight', 'net_zero'],
    ['10.000', '0.000', 'Per Piece', null],
    ['0.000', '0.000', 'Per Piece', null],
    ['100000.000', '99999.999', 'By Weight', null],
  ])('gross %s, net %s, %s: %s', (gross, net, method, want) => {
    expect(weightProblem(gross, net, method)).toBe(want);
  });
});

describe('P2 (a) to (e) the photo ids of a design PATCH', () => {
  const ids = async (d: string) => {
    const r = await dbRow(w, 'designs', d);
    return (typeof r.photo_ids === 'string' ? JSON.parse(r.photo_ids) : r.photo_ids) as string[];
  };
  const fresh = async (current: string[] = [], o: Record<string, unknown> = {}) => {
    const d = await addDesign(w, { photo_ids: current, primary_photo_id: current[0] ?? null, ...o });
    return d;
  };

  it('staff add a photo at the end (both kinds stored, this design\'s, not removed): 200, and the order is kept', async () => {
    const d = await fresh();
    const a = await addPhoto(w, d);
    const b = await addPhoto(w, d);
    const first = await patch(w, 'staff', 'designs', d, STAMP_WIRE, { photo_ids: [a], primary_photo_id: a });
    expect(first.statusCode, first.body).toBe(200);
    expect(body(first).row.photo_ids).toEqual([a]);
    const second = await patch(w, 'staff', 'designs', d, body(first).row.updated_at, { photo_ids: [a, b] });
    expect(second.statusCode, second.body).toBe(200);
    expect(await ids(d)).toEqual([a, b]);
    expect((await dbRow(w, 'designs', d)).primary_photo_id).toBe(a);
  });

  it('staff cannot remove, reorder or replace: each is 422 and the list is as it was; the owner may do all of them (A5, P3)', async () => {
    const d = await fresh();
    const [a, b, c, e] = [await addPhoto(w, d), await addPhoto(w, d), await addPhoto(w, d), await addPhoto(w, d)];
    await w.world.sql.query('UPDATE designs SET photo_ids = ?, primary_photo_id = ? WHERE id = ?', [JSON.stringify([a, b]), a, d]);
    const stamp = await stampOf(w, 'designs', d);
    const attempts: [string, string[]][] = [
      ['remove', [a]],
      ['remove the first', [b]],
      ['reorder', [b, a]],
      ['replace', [a, c]],
      ['replace and add', [c, a, b]],
      ['empty the list', []],
    ];
    for (const [what, list] of attempts) {
      const res = await patch(w, 'staff', 'designs', d, stamp, { photo_ids: list });
      expect(res.statusCode, `staff: ${what}`).toBe(422);
      expect(codeOf(res)).toBe('JV_INVALID_INPUT');
      expect(detailsOf(res)).toEqual({ field: 'changes.photo_ids' });
      expect(await ids(d), what).toEqual([a, b]);
    }
    // the owner may do all four
    const reorder = await patch(w, 'owner', 'designs', d, stamp, { photo_ids: [b, a], primary_photo_id: b });
    expect(reorder.statusCode, reorder.body).toBe(200);
    expect(await ids(d)).toEqual([b, a]);
    let s = body(reorder).row.updated_at as string;
    const replace = await patch(w, 'owner', 'designs', d, s, { photo_ids: [b, c] });
    expect(replace.statusCode, replace.body).toBe(200);
    s = body(replace).row.updated_at;
    const remove = await patch(w, 'owner', 'designs', d, s, { photo_ids: [b] });
    expect(remove.statusCode, remove.body).toBe(200);
    s = body(remove).row.updated_at;
    const add = await patch(w, 'owner', 'designs', d, s, { photo_ids: [b, e] });
    expect(add.statusCode, add.body).toBe(200);
    expect(await ids(d)).toEqual([b, e]);
  });

  it('(a) at most 3 ids, each once', async () => {
    const d = await fresh();
    const four = [await addPhoto(w, d), await addPhoto(w, d), await addPhoto(w, d), await addPhoto(w, d)];
    expect((await patch(w, 'owner', 'designs', d, STAMP_WIRE, { photo_ids: four })).statusCode).toBe(422);
    expect((await patch(w, 'owner', 'designs', d, STAMP_WIRE, { photo_ids: [four[0], four[0]] })).statusCode).toBe(422);
    expect((await patch(w, 'owner', 'designs', d, STAMP_WIRE, { photo_ids: four.slice(0, 3) })).statusCode).toBe(200);
  });

  it('(b) an id that was never uploaded, or has only one kind stored, is refused; (c) so is a photo uploaded for another design; (d) and a removed one', async () => {
    const d = await fresh();
    const other = await fresh();
    const cases: [string, string][] = [
      ['never uploaded', randomUUID()],
      ['only the full image', await addPhoto(w, d, { kinds: ['full'] })],
      ['only the thumbnail', await addPhoto(w, d, { kinds: ['thumb'] })],
      ['another design\'s photo', await addPhoto(w, other)],
      ['a removed photo', await addPhoto(w, d, { removed: true })],
    ];
    for (const [what, id] of cases) {
      const res = await patch(w, 'owner', 'designs', d, STAMP_WIRE, { photo_ids: [id] });
      expect(res.statusCode, what).toBe(422);
      expect(codeOf(res)).toBe('JV_INVALID_INPUT');
      expect(detailsOf(res)).toEqual({ field: 'changes.photo_ids' });
      expect(await ids(d), what).toEqual([]);
    }
    // (c) for both kinds: the thumbnail stored for another design spoils an otherwise good photo
    const mixed = randomUUID();
    await addPhoto(w, d, { id: mixed, kinds: ['full'] });
    await addPhoto(w, other, { id: mixed, kinds: ['thumb'] });
    expect((await patch(w, 'owner', 'designs', d, STAMP_WIRE, { photo_ids: [mixed] })).statusCode).toBe(422);
  });

  it('an id that is not a UUID (a data: image, a path) is refused before the database is asked (P4)', async () => {
    const d = await fresh();
    for (const bad of ['data:image/png;base64,AAAA', '../etc/passwd', 'ABCDEF', '']) {
      const res = await patch(w, 'owner', 'designs', d, STAMP_WIRE, { photo_ids: [bad] });
      expect(res.statusCode, bad).toBe(422);
    }
    expect((await patch(w, 'owner', 'designs', d, STAMP_WIRE, { photo_ids: 'x' })).statusCode).toBe(422);
    expect((await patch(w, 'owner', 'designs', d, STAMP_WIRE, { photo_ids: null })).statusCode).toBe(422);
  });

  it('a photo already on the design that was removed since stays in the list when staff add another one (only the new ids are checked)', async () => {
    const d = await fresh();
    const old = await addPhoto(w, d);
    await w.world.sql.query('UPDATE designs SET photo_ids = ?, primary_photo_id = ? WHERE id = ?', [JSON.stringify([old]), old, d]);
    await w.world.sql.query("UPDATE design_photos SET removed_at = '2026-10-02 00:00:00.000000', bytes = NULL WHERE id = ?", [old]);
    const added = await addPhoto(w, d);
    const res = await patch(w, 'staff', 'designs', d, await stampOf(w, 'designs', d), { photo_ids: [old, added] });
    expect(res.statusCode, res.body).toBe(200);
  });

  it('primary_photo_id must stay one of the ids, for the owner and for staff', async () => {
    const d = await fresh();
    const a = await addPhoto(w, d);
    const b = await addPhoto(w, d);
    const stranger = await addPhoto(w, d);
    await w.world.sql.query('UPDATE designs SET photo_ids = ?, primary_photo_id = ? WHERE id = ?', [JSON.stringify([a, b]), a, d]);
    for (const caller of ['owner', 'staff'] as const) {
      const stamp = await stampOf(w, 'designs', d);
      const primaryBefore = (await dbRow(w, 'designs', d)).primary_photo_id;
      const outside = await patch(w, caller, 'designs', d, stamp, { primary_photo_id: stranger });
      expect(outside.statusCode, caller).toBe(422);
      expect(detailsOf(outside)).toEqual({ field: 'changes.primary_photo_id' });
      expect((await dbRow(w, 'designs', d)).primary_photo_id).toBe(primaryBefore);
      const inside = await patch(w, caller, 'designs', d, stamp, { primary_photo_id: caller === 'owner' ? b : a });
      expect(inside.statusCode, `${caller} ${inside.body}`).toBe(200);
    }
    // the owner removes the photo that is the primary one without naming another primary: refused; with null, or another, it goes through
    const stamp = await stampOf(w, 'designs', d);
    const [current] = [(await dbRow(w, 'designs', d)).primary_photo_id as string];
    const keep = [a, b].find((x) => x !== current)!;
    const noNewPrimary = await patch(w, 'owner', 'designs', d, stamp, { photo_ids: [keep] });
    expect(noNewPrimary.statusCode).toBe(422);
    expect(detailsOf(noNewPrimary)).toEqual({ field: 'changes.primary_photo_id' });
    const withNull = await patch(w, 'owner', 'designs', d, stamp, { photo_ids: [keep], primary_photo_id: null });
    expect(withNull.statusCode, withNull.body).toBe(200);
  });

  it('a primary photo of a design with no ids is refused, and null is always fine', async () => {
    const d = await fresh();
    const a = await addPhoto(w, d);
    expect((await patch(w, 'staff', 'designs', d, STAMP_WIRE, { primary_photo_id: a })).statusCode).toBe(422);
    expect((await patch(w, 'staff', 'designs', d, STAMP_WIRE, { primary_photo_id: null })).statusCode).toBe(200);
  });
});

describe('the other columns of a design edit', () => {
  it('the category and the subcategory must exist: a made-up id is 422 on that field, never a 500 from the foreign key', async () => {
    const d = await addDesign(w);
    const noCategory = await patch(w, 'staff', 'designs', d, STAMP_WIRE, { category_id: randomUUID() });
    expect(noCategory.statusCode).toBe(422);
    expect(detailsOf(noCategory)).toEqual({ field: 'changes.category_id' });
    const noSub = await patch(w, 'staff', 'designs', d, STAMP_WIRE, { subcategory_id: randomUUID() });
    expect(noSub.statusCode).toBe(422);
    expect(detailsOf(noSub)).toEqual({ field: 'changes.subcategory_id' });
    const ok = await patch(w, 'staff', 'designs', d, STAMP_WIRE, { category_id: w.other_category, subcategory_id: w.subcategory });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(body(ok).row).toMatchObject({ category_id: w.other_category, subcategory_id: w.subcategory });
    const cleared = await patch(w, 'staff', 'designs', d, body(ok).row.updated_at, { subcategory_id: null });
    expect(cleared.statusCode, cleared.body).toBe(200);
    const nullCategory = await patch(w, 'staff', 'designs', d, body(cleared).row.updated_at, { category_id: null });
    expect(nullCategory.statusCode).toBe(422);
  });

  it('text and tags: trimmed, blank means none, and the lengths of the columns are kept (a refusal, not a 500)', async () => {
    const d = await addDesign(w);
    const ok = await patch(w, 'staff', 'designs', d, STAMP_WIRE, { name: '  Floral ring  ', description: '   ', notes: 'for the exhibition', tags: ['bridal', 'gold'] });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(body(ok).row).toMatchObject({ name: 'Floral ring', description: null, notes: 'for the exhibition', tags: ['bridal', 'gold'] });
    const stamp = body(ok).row.updated_at as string;
    for (const bad of [{ name: 'x'.repeat(121) }, { name: 5 }, { tags: 'bridal' }, { tags: [1] }, { tags: [''] }, { tags: ['x'.repeat(41)] }, { tags: Array.from({ length: 21 }, (_v, i) => `t${i}`) }, { notes: 'x'.repeat(10_001) }, { material: 'Platinum' }]) {
      const res = await patch(w, 'owner', 'designs', d, stamp, bad);
      expect(res.statusCode, JSON.stringify(bad).slice(0, 40)).toBe(422);
      expect(codeOf(res)).toBe('JV_INVALID_INPUT');
    }
    const longName = await patch(w, 'owner', 'designs', d, stamp, { name: 'x'.repeat(120) });
    expect(longName.statusCode, longName.body).toBe(200);
  });

  it('the owner changes material, purity and method on a design with no pieces; the values are checked (Gold or Silver, By Weight or Per Piece)', async () => {
    const d = await addDesign(w);
    const ok = await patch(w, 'owner', 'designs', d, STAMP_WIRE, { material: 'Silver', purity: '925', selling_method: 'Per Piece' });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(body(ok).row).toMatchObject({ material: 'Silver', purity: '925', selling_method: 'Per Piece' });
    const bad = await patch(w, 'owner', 'designs', d, body(ok).row.updated_at, { selling_method: 'By Length' });
    expect(bad.statusCode).toBe(422);
  });

  it('a piece\'s notes and location: trimmed, blank is none, 60 characters at most for the location', async () => {
    const d = await addDesign(w);
    const p = await addPiece(w, d, { location: 'Main Showroom' });
    const ok = await patch(w, 'staff', 'skus', p, STAMP_WIRE, { location: '  ', notes: ' fragile ' });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(body(ok).row).toMatchObject({ location: null, notes: 'fragile' });
    expect((await patch(w, 'staff', 'skus', p, body(ok).row.updated_at, { location: 'x'.repeat(61) })).statusCode).toBe(422);
  });
});

describe('categories and subcategories (D5, A4)', () => {
  it('a name is unique ignoring case: a second "RING" is 422 on the name, for an insert and for a rename; renaming a category to its own name in other case is fine', async () => {
    const first = await w.world.call('owner', 'POST', '/v1/categories', { payload: { name: 'Hairband', prefix: 'HB' } });
    expect(first.statusCode, first.body).toBe(201);
    const dup = await w.world.call('staff', 'POST', '/v1/categories', { payload: { name: 'HAIRBAND', prefix: 'HBA' } });
    expect(dup.statusCode).toBe(422);
    expect(detailsOf(dup)).toEqual({ field: 'name' });
    const other = await w.world.call('owner', 'POST', '/v1/categories', { payload: { name: 'Hairclip', prefix: 'HC' } });
    const clash = await patch(w, 'owner', 'categories', body(other).row.id, body(other).row.updated_at, { name: 'hairband' });
    expect(clash.statusCode).toBe(422);
    expect(detailsOf(clash)).toEqual({ field: 'changes.name' });
    const recase = await patch(w, 'owner', 'categories', body(first).row.id, body(first).row.updated_at, { name: 'HAIRBAND' });
    expect(recase.statusCode, recase.body).toBe(200);
    expect(body(recase).row.name).toBe('HAIRBAND');
  });

  it('the prefix is 2 to 6 capitals or digits, the name 1 to 80 characters after trimming; active is a boolean', async () => {
    for (const payload of [{ name: 'Okay', prefix: 'a' }, { name: 'Okay', prefix: 'abc' }, { name: 'Okay', prefix: 'ABCDEFG' }, { name: 'Okay', prefix: 'AB-C' }, { name: '  ', prefix: 'OK' }, { name: 'x'.repeat(81), prefix: 'OK' }, { name: 5, prefix: 'OK' }, { prefix: 'OK' }, { name: 'Okay' }]) {
      const res = await w.world.call('owner', 'POST', '/v1/categories', { payload });
      expect(res.statusCode, JSON.stringify(payload).slice(0, 50)).toBe(422);
      expect(codeOf(res)).toBe('JV_INVALID_INPUT');
    }
    const ok = await w.world.call('owner', 'POST', '/v1/categories', { payload: { name: '  Ear Cuff  ', prefix: 'EC9' } });
    expect(ok.statusCode, ok.body).toBe(201);
    expect(body(ok).row).toMatchObject({ name: 'Ear Cuff', prefix: 'EC9', active: true });
    const off = await patch(w, 'owner', 'categories', body(ok).row.id, body(ok).row.updated_at, { active: false });
    expect(off.statusCode, off.body).toBe(200);
    expect(body(off).row.active).toBe(false);
    expect((await patch(w, 'owner', 'categories', body(ok).row.id, body(off).row.updated_at, { active: 'no' })).statusCode).toBe(422);
  });

  it('a subcategory belongs to an existing category and its name is unique inside it; the same name under another category is fine', async () => {
    const add = (caller: 'owner' | 'staff', category_id: string, name: string) => w.world.call(caller, 'POST', '/v1/subcategories', { payload: { category_id, name } });
    const first = await add('staff', w.category, 'Temple');
    expect(first.statusCode, first.body).toBe(201);
    expect(body(first).row).toMatchObject({ category_id: w.category, name: 'Temple', active: true });
    const dup = await add('owner', w.category, 'TEMPLE');
    expect(dup.statusCode).toBe(422);
    expect(detailsOf(dup)).toEqual({ field: 'name' });
    expect((await add('owner', w.other_category, 'Temple')).statusCode).toBe(201);
    const orphan = await add('owner', randomUUID(), 'Anything');
    expect(orphan.statusCode).toBe(422);
    expect(detailsOf(orphan)).toEqual({ field: 'category_id' });
    const rename = await patch(w, 'owner', 'subcategories', body(first).row.id, body(first).row.updated_at, { name: 'Handmade 2', active: false });
    expect(rename.statusCode, rename.body).toBe(200);
    expect(body(rename).row).toMatchObject({ name: 'Handmade 2', active: false });
    const move = await patch(w, 'owner', 'subcategories', body(first).row.id, body(rename).row.updated_at, { category_id: w.other_category });
    expect(move.statusCode).toBe(403);
  });
});
