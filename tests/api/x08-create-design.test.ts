import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { insert, V } from '../schema/support';
import { type EditWorld, addPhoto, body, editWorld } from './edit-support';
import { counterOf, createDesign, designPayload, designRow, errorCode, errorField, footprint, newKey, piecesOf, privateOf, requestIdOf, rows, setStatus } from './stock-support';

// API16, X8 `create_design` (POST /v1/designs, 201 {design, skus} and, for the owner, sku_private). These are the DB halves of T-C03 (numbers never reused, a design id that exists is refused),
// T-C17 (500 pieces yes, 501 no, the original weight from staff is JV_FORBIDDEN), T-A02 (the labour-rate blank chain of R1 (1)) and T-F01 (a design edit changes what every piece shows), plus the
// clauses of T-D03 (no result for staff holds the original weight), T-D09 (the matrix row of X8 for the callers) and the lock order of X0 (claim, checks, counters, writes). The audit rows of
// both mechanisms (T-D14) are counted in tests/api/stock-audit.test.ts.
//
// The world is a scratch database with the real routes, the seeds (15 categories with their prefixes, the settings of D3) and a clock fixed at 17 Oct 2026 10:00 UTC. Every test that depends on
// a number uses a category of its own, so that the counters of one test never move the expectations of another.

const categoryOf = async (w: EditWorld, prefix: string): Promise<string> => (await rows(w, 'SELECT id FROM categories WHERE prefix = ?', [prefix]))[0].id;
const group = (o: Record<string, unknown> = {}) => ({ pieces: 1, gross_weight: '12.500', customer_net_weight: '11.000', labour_retail: '350.00', ...o });

describe('X8 create_design', () => {
  let w: EditWorld;
  let ring: string;
  beforeAll(async () => {
    w = await editWorld('x8main');
    ring = await categoryOf(w, 'RING');
    // a series of its own for each test that asserts a number, so that the tests do not depend on the order they run in (npm test -- -t "T-C03" runs some of them alone)
    for (const prefix of ['NA', 'NB', 'NC', 'ND']) await insert(w.world.sql, 'categories', V.category({ name: `Numbers ${prefix}`, prefix }));
  }, 120_000);
  afterAll(async () => {
    await w?.world.close();
  }, 60_000);

  describe('numbers, barcodes, status, location (L3, L4, X8)', () => {
    it('makes the design number, the piece numbers, the barcodes, the status In Stock and the first location of the settings', async () => {
      const cat = await categoryOf(w, 'NA');
      const payload = designPayload(w, {
        design: { category_id: cat, name: 'Kundan Set', description: 'Bridal', notes: 'Back order', tags: ['bridal', 'kundan'] },
        pieces: [
          group({ pieces: 2, gross_weight: '20.000', customer_net_weight: '18.500', stones: 3, stone_weight: '1.250', kundan: 4, kundan_weight: '0.500', piroi: '2.15', labour_retail: '350.00', labour_semi: '300.00', labour_wholesale: '250.00', notes: 'first group' }),
          { pieces: 1, gross_weight: '5.000', customer_net_weight: '4.500' },
        ],
      });
      const res = await createDesign(w, 'staff', payload);
      expect(res.statusCode, res.body).toBe(201);
      const b = body(res);
      expect(Object.keys(b)).toEqual(['design', 'skus']); // staff: no owner-only rows
      expect(b.design).toMatchObject({ id: payload.design_id, design_no: 'NA-00001', name: 'Kundan Set', category_id: cat, subcategory_id: null, material: 'Gold', purity: '22K', selling_method: 'By Weight', description: 'Bridal', notes: 'Back order', tags: ['bridal', 'kundan'], photo_ids: [], primary_photo_id: null, archived_at: null, created_by: w.world.fixtures.staff.userId, updated_by: w.world.fixtures.staff.userId });
      expect(b.design.created_at).toMatch(/^2026-10-17T10:00:00\.\d{6}Z$/); // the API clock, fixed at 17 Oct 2026 10:00 UTC and moving one microsecond for each reading
      expect(b.design.updated_at).toBe(b.design.created_at);
      for (const s of b.skus) expect([s.created_at, s.updated_at]).toEqual([b.design.created_at, b.design.created_at]); // one reading for the whole call (S6)
      expect(b.skus.map((s: any) => s.sku_no)).toEqual(['NA-00001-001', 'NA-00001-002', 'NA-00001-003']);
      expect(b.skus.map((s: any) => s.barcode)).toEqual(['BC-NA-00001-001', 'BC-NA-00001-002', 'BC-NA-00001-003']);
      for (const s of b.skus) expect(s).toMatchObject({ design_id: payload.design_id, status: 'In Stock', location: 'Main Showroom', sold_bill_id: null, archived_at: null, created_by: w.world.fixtures.staff.userId });
      expect(b.skus[0]).toMatchObject({ gross_weight: '20.000', customer_net_weight: '18.500', stones: 3, stone_weight: '1.250', kundan: 4, kundan_weight: '0.500', piroi: '2.15', labour_retail: '350.00', labour_semi: '300.00', labour_wholesale: '250.00', notes: 'first group' });
      expect(b.skus[1]).toMatchObject({ gross_weight: '20.000', notes: 'first group' }); // a group of 2 gives two pieces with the group's values
      expect(b.skus[2]).toMatchObject({ gross_weight: '5.000', customer_net_weight: '4.500', stones: 0, stone_weight: '0.000', piroi: '0.00', notes: null });
      // the tables hold what the answer says
      const d = await designRow(w, payload.design_id);
      expect(d.design_no).toBe('NA-00001');
      const stored = await piecesOf(w, payload.design_id);
      expect(stored.map((s) => s.id)).toEqual(b.skus.map((s: any) => s.id));
      expect(await counterOf(w, 'design:NA')).toBe(1);
      expect(await counterOf(w, 'sku:NA-00001')).toBe(3);
    });

    it('T-C03: design and piece numbers are never reused after archiving', async () => {
      const cat = await categoryOf(w, 'NB');
      const first = await createDesign(w, 'owner', designPayload(w, { design: { category_id: cat }, pieces: [group({ pieces: 2 })] }));
      expect(first.statusCode, first.body).toBe(201);
      const a = body(first);
      expect(a.design.design_no).toBe('NB-00001');
      // archive the design and its pieces (rows typed by SQL, as the import or X9 would leave them) ...
      await w.world.sql.query("UPDATE skus SET status = 'Archived', archived_at = '2026-10-17 11:00:00.000000' WHERE design_id = ?", [a.design.id]);
      await w.world.sql.query("UPDATE designs SET archived_at = '2026-10-17 11:00:00.000000' WHERE id = ?", [a.design.id]);
      // ... and make another: its number is the next one, never the archived design's
      const second = await createDesign(w, 'owner', designPayload(w, { design: { category_id: cat }, pieces: [group({ pieces: 2 })] }));
      const b = body(second);
      expect(b.design.design_no).toBe('NB-00002');
      expect(b.skus.map((s: any) => s.sku_no)).toEqual(['NB-00002-001', 'NB-00002-002']);
      // the counters keep the archived numbers used; nobody gives them out again
      expect(await counterOf(w, 'design:NB')).toBe(2);
      expect(await counterOf(w, 'sku:NB-00001')).toBe(2);
      // the archived design's number is still the archived design's
      expect((await designRow(w, a.design.id)).design_no).toBe('NB-00001');
      // and a category of its own has a series of its own
      const other = await createDesign(w, 'owner', designPayload(w, { design: { category_id: await categoryOf(w, 'NC') } }));
      expect(body(other).design.design_no).toBe('NC-00001');
    });

    it('T-C03: a design id from the screen that already exists is refused, and nothing is used up', async () => {
      const cat = await categoryOf(w, 'ND');
      const payload = designPayload(w, { design: { category_id: cat } });
      const first = await createDesign(w, 'owner', payload);
      expect(first.statusCode, first.body).toBe(201);
      const counters = [await counterOf(w, 'design:ND'), await counterOf(w, `sku:${body(first).design.design_no}`)];
      const before = await footprint(w);

      const key = newKey();
      const again = await createDesign(w, 'owner', { ...payload, design: { ...payload.design, name: 'Same id, other key' } }, key);
      expect(again.statusCode, again.body).toBe(422);
      expect(errorCode(again)).toBe('JV_INVALID_INPUT');
      expect(errorField(again)).toBe('design_id');
      expect(await footprint(w)).toEqual(before); // no design, no piece, no number, no claim, no audit row
      expect([await counterOf(w, 'design:ND'), await counterOf(w, `sku:${body(first).design.design_no}`)]).toEqual(counters);

      // the refused key was not used up: the same key with a fresh design id works
      const retry = await createDesign(w, 'owner', designPayload(w, { design: { category_id: cat } }), key);
      expect(retry.statusCode, retry.body).toBe(201);
      expect(body(retry).design.design_no).toBe('ND-00002');
    });
  });

  describe('T-C17: at most 500 pieces in a call, at most 100 in a group', () => {
    it('accepts 500 pieces (5 groups of 100) in well under the 12-second deadline, numbered 001 to 500', async () => {
      const cat = await categoryOf(w, 'CHN');
      const started = Date.now();
      const res = await createDesign(w, 'owner', designPayload(w, { design: { category_id: cat }, pieces: Array.from({ length: 5 }, (_, i) => group({ pieces: 100, gross_weight: `${10 + i}.000`, customer_net_weight: `${9 + i}.000` })) }));
      const elapsed = Date.now() - started;
      expect(res.statusCode, res.body.slice(0, 300)).toBe(201);
      const b = body(res);
      expect(b.skus).toHaveLength(500);
      expect(b.skus[0].sku_no).toBe('CHN-00001-001');
      expect(b.skus[499].sku_no).toBe('CHN-00001-500');
      expect(new Set(b.skus.map((s: any) => s.sku_no)).size).toBe(500);
      expect(new Set(b.skus.map((s: any) => s.barcode)).size).toBe(500);
      expect(b.skus[100].gross_weight).toBe('11.000'); // the second group starts at the 101st piece
      expect((await piecesOf(w, b.design.id)).length).toBe(500);
      expect(elapsed, `500 pieces took ${elapsed} ms`).toBeLessThan(10_000);
    }, 60_000);

    it('refuses 501 pieces with JV_INVALID_INPUT and writes nothing', async () => {
      const cat = await categoryOf(w, 'KADA');
      const before = await footprint(w);
      const res = await createDesign(w, 'owner', designPayload(w, { design: { category_id: cat }, pieces: [...Array.from({ length: 5 }, () => group({ pieces: 100 })), group({ pieces: 1 })] }));
      expect(res.statusCode, res.body).toBe(422);
      expect(errorCode(res)).toBe('JV_INVALID_INPUT');
      expect(errorField(res)).toBe('pieces');
      expect(await footprint(w)).toEqual(before);
      expect(await counterOf(w, 'design:KADA')).toBeNull(); // not even the series row was made: the input was refused before the database was asked
    });

    it('refuses a group of 101 or of 0 pieces, a non-integer count and an empty list of groups', async () => {
      const cat = await categoryOf(w, 'KADA');
      const before = await footprint(w);
      const send = (pieces: unknown[]) => createDesign(w, 'owner', designPayload(w, { design: { category_id: cat }, pieces: pieces as any }));
      for (const [pieces, field] of [
        [[group({ pieces: 101 })], 'pieces[0].pieces'],
        [[group(), group({ pieces: 0 })], 'pieces[1].pieces'],
        [[group({ pieces: 1.5 })], 'pieces[0].pieces'],
        [[group({ pieces: '2' })], 'pieces[0].pieces'],
        [[], 'pieces'],
      ] as [unknown[], string][]) {
        const res = await send(pieces);
        expect([res.statusCode, errorCode(res), errorField(res)], JSON.stringify(pieces).slice(0, 60)).toEqual([422, 'JV_INVALID_INPUT', field]);
      }
      expect(await footprint(w)).toEqual(before);
    });
  });

  describe('the original weight is the owner\'s (D9, X8, T-C17, T-D03, T-D09)', () => {
    it('from staff it is JV_FORBIDDEN, writes nothing, leaves the Idempotency-Key unused and never echoes the weight', async () => {
      const cat = await categoryOf(w, 'PAY');
      const payload = designPayload(w, { design: { category_id: cat }, pieces: [group({ pieces: 2, original_net_weight: '9.876' })] });
      const before = await footprint(w);
      const key = newKey();
      const res = await createDesign(w, 'staff', payload, key);
      expect(res.statusCode, res.body).toBe(403);
      expect(errorCode(res)).toBe('JV_FORBIDDEN');
      expect(errorField(res)).toBe('pieces[0].original_net_weight');
      expect(res.body).not.toContain('9.876');
      expect(await footprint(w)).toEqual(before); // the claim was rolled back with everything else (X0 item 2)
      expect(await counterOf(w, 'design:PAY')).toBe(0); // the series row is made before the transaction (L3); the number taken inside it was rolled back

      // the same key, the same screen, the field taken out: works (the key was not used up)
      const fixed = { ...payload, pieces: [group({ pieces: 2 })] };
      const ok = await createDesign(w, 'staff', fixed, key);
      expect(ok.statusCode, ok.body).toBe(201);
      expect(JSON.stringify(body(ok))).not.toContain('original_net_weight');
      expect(await privateOf(w, payload.design_id)).toEqual([]);
    });

    it('from the owner it is stored for the pieces of its group, and the owner\'s answer carries those rows', async () => {
      const cat = await categoryOf(w, 'ANK');
      const payload = designPayload(w, { design: { category_id: cat }, pieces: [group({ pieces: 2, original_net_weight: '10.250' }), group({ pieces: 1 }), group({ pieces: 1, original_net_weight: '0.000' })] });
      const res = await createDesign(w, 'owner', payload);
      expect(res.statusCode, res.body).toBe(201);
      const b = body(res);
      expect(b.skus).toHaveLength(4);
      const stored = await privateOf(w, payload.design_id);
      expect(stored.map((r) => [r.sku_id, r.original_net_weight])).toEqual([
        [b.skus[0].id, '10.250'],
        [b.skus[1].id, '10.250'],
        [b.skus[3].id, '0.000'], // an explicit zero is a value; the group that sent nothing has no row (nothing is invented)
      ]);
      expect(stored.every((r) => r.created_by === w.world.fixtures.owner.userId && r.updated_by === w.world.fixtures.owner.userId)).toBe(true);
      expect(b.sku_private.map((r: any) => [r.sku_id, r.original_net_weight])).toEqual([
        [b.skus[0].id, '10.250'],
        [b.skus[1].id, '10.250'],
        [b.skus[3].id, '0.000'],
      ]);
      // the piece rows themselves never carry it (D9: it is a separate table)
      expect(JSON.stringify(b.skus)).not.toContain('original_net_weight');
      expect(JSON.stringify(b.design)).not.toContain('original_net_weight');
    });

    it('T-D03 clause: no result of X8 for staff holds the original weight, not even for a design whose pieces have one, and not on a replay', async () => {
      const cat = await categoryOf(w, 'BRC');
      const made = await createDesign(w, 'owner', designPayload(w, { design: { category_id: cat }, pieces: [group({ pieces: 3, original_net_weight: '7.777' })] }));
      expect(made.statusCode).toBe(201);
      expect(made.body).toMatch(/original_net_weight[\s\S]*7\.777/); // control: the check below can see the weight where it is (the owner's own answer)
      const staffPayload = designPayload(w, { design: { category_id: cat }, pieces: [group({ pieces: 3 })] });
      const key = newKey();
      const first = await createDesign(w, 'staff', staffPayload, key);
      const replay = await createDesign(w, 'staff', staffPayload, key);
      for (const res of [first, replay]) {
        expect(res.statusCode, res.body).toBe(201);
        expect(res.body).not.toMatch(/original_net_weight|7\.777/);
      }
      expect(replay.headers['idempotent-replay']).toBe('true');
    });
  });

  describe('T-A02 (DB half): the blank labour-rate chain of R1 (1)', () => {
    const chain = async (g: Record<string, unknown>, design: Record<string, unknown> = {}): Promise<[string, string, string]> => {
      const res = await createDesign(w, 'owner', designPayload(w, { design: { category_id: ring, ...design }, pieces: [{ pieces: 1, gross_weight: '10.000', customer_net_weight: '9.000', ...g }] }));
      expect(res.statusCode, res.body).toBe(201);
      const s = body(res).skus[0];
      return [s.labour_retail, s.labour_semi, s.labour_wholesale];
    };

    it('a blank semi-wholesale rate takes the wholesale rate', async () => {
      expect(await chain({ labour_retail: '100.00', labour_wholesale: '80.00' })).toEqual(['100.00', '80.00', '80.00']);
    });
    it('a blank semi-wholesale rate takes the retail rate when the wholesale rate is blank too, and a blank wholesale rate takes the retail rate', async () => {
      expect(await chain({ labour_retail: '100.00' })).toEqual(['100.00', '100.00', '100.00']);
    });
    it('a wholesale rate that is blank takes the retail rate, and a semi-wholesale rate that was typed stays', async () => {
      expect(await chain({ labour_retail: '100.00', labour_semi: '90.00' })).toEqual(['100.00', '90.00', '100.00']);
    });
    it('null is blank too', async () => {
      expect(await chain({ labour_retail: '100.00', labour_semi: null, labour_wholesale: null })).toEqual(['100.00', '100.00', '100.00']);
      expect(await chain({ labour_retail: '100.00', labour_semi: null, labour_wholesale: '70.50' })).toEqual(['100.00', '70.50', '70.50']);
    });
    it('a rate typed as zero is a rate (only a blank falls back), and a retail rate that is blank is 0.00: in the schema the three are never blank', async () => {
      expect(await chain({ labour_retail: '100.00', labour_semi: '0.00', labour_wholesale: '0.00' })).toEqual(['100.00', '0.00', '0.00']);
      expect(await chain({ labour_semi: '70.00' })).toEqual(['0.00', '70.00', '0.00']);
      expect(await chain({})).toEqual(['0.00', '0.00', '0.00']);
    });
    it('the chain runs for every group, and the same way for a Per Piece design (the rates are piece prices there)', async () => {
      const res = await createDesign(w, 'owner', designPayload(w, { design: { category_id: ring, selling_method: 'Per Piece' }, pieces: [{ pieces: 2, labour_retail: '5000.00' }, { pieces: 1, labour_retail: '4000.00', labour_wholesale: '3500.00' }] }));
      expect(res.statusCode, res.body).toBe(201);
      expect(body(res).skus.map((s: any) => [s.labour_retail, s.labour_semi, s.labour_wholesale])).toEqual([
        ['5000.00', '5000.00', '5000.00'],
        ['5000.00', '5000.00', '5000.00'],
        ['4000.00', '3500.00', '3500.00'],
      ]);
    });
  });

  describe('T-F01: changing a design\'s material, purity or category changes what every piece shows', () => {
    it('a piece has no material, purity, category or selling method of its own: all of them are read through the design', async () => {
      const cat = await categoryOf(w, 'ER');
      const made = await createDesign(w, 'owner', designPayload(w, { design: { category_id: cat, material: 'Gold', purity: '22K' }, pieces: [group({ pieces: 3 }), group({ pieces: 2, customer_net_weight: '9.000' })] }));
      expect(made.statusCode, made.body).toBe(201);
      const { design, skus } = body(made);
      expect(skus).toHaveLength(5);
      for (const s of skus) for (const own of ['material', 'purity', 'category_id', 'selling_method']) expect(s, own).not.toHaveProperty(own);

      const shown = async () => rows(w, 'SELECT s.sku_no, d.material, d.purity, c.name AS category FROM skus s JOIN designs d ON d.id = s.design_id JOIN categories c ON c.id = d.category_id WHERE d.id = ? ORDER BY s.sku_no', [design.id]);
      expect((await shown()).map((r) => [r.material, r.purity, r.category])).toEqual(Array(5).fill(['Gold', '22K', 'Earrings']));

      const edit = await w.world.call('owner', 'PATCH', `/v1/designs/${design.id}`, { payload: { expected_updated_at: design.updated_at, changes: { material: 'Silver', purity: '925', category_id: w.other_category } } });
      expect(edit.statusCode, edit.body).toBe(200);
      const [newCategory] = await rows(w, 'SELECT name FROM categories WHERE id = ?', [w.other_category]);
      expect((await shown()).map((r) => [r.material, r.purity, r.category])).toEqual(Array(5).fill(['Silver', '925', newCategory.name]));

      // what the screens read for a bill shows it for every piece (X7 reads the piece through its design)
      const quote = await w.world.call('owner', 'POST', '/v1/bills/quote', {
        payload: { sale_type: 'Retail', items: skus.map((s: any) => ({ sku_id: s.id, metal_rate: '100.00', labour_rate: '10.00' })) },
      });
      expect(quote.statusCode, quote.body).toBe(200);
      expect(body(quote).lines.map((l: any) => [l.material, l.purity, l.selling_method])).toEqual(Array(5).fill(['Silver', '925', 'By Weight']));
      // and the pieces themselves were not touched by the edit of the design
      expect((await piecesOf(w, design.id)).every((p) => p.updated_at.startsWith('2026-10-17 10:00:00'))).toBe(true);
    });
  });

  describe('the design and the photos (P2 (a) to (d), A5, D6)', () => {
    it('attaches photo ids that have both kinds stored for this design id and are not removed; the first is the primary photo unless one is named', async () => {
      const designId = randomUUID();
      const p1 = await addPhoto(w, designId);
      const p2 = await addPhoto(w, designId);
      const p3 = await addPhoto(w, designId);
      const res = await createDesign(w, 'staff', designPayload(w, { design_id: designId, design: { category_id: ring, photo_ids: [p1, p2, p3] } }));
      expect(res.statusCode, res.body).toBe(201);
      expect(body(res).design).toMatchObject({ photo_ids: [p1, p2, p3], primary_photo_id: p1 });

      const named = randomUUID();
      const q1 = await addPhoto(w, named);
      const q2 = await addPhoto(w, named);
      const res2 = await createDesign(w, 'owner', designPayload(w, { design_id: named, design: { category_id: ring, photo_ids: [q1, q2], primary_photo_id: q2 } }));
      expect(res2.statusCode, res2.body).toBe(201);
      expect(body(res2).design).toMatchObject({ photo_ids: [q1, q2], primary_photo_id: q2 });
    });

    it('refuses an unknown id, another design\'s photo, a photo with one kind, a removed photo, a fourth photo, a repeated id and a primary photo that is not attached', async () => {
      const designId = randomUUID();
      const good = await addPhoto(w, designId);
      const foreign = await addPhoto(w, randomUUID());
      const fullOnly = await addPhoto(w, designId, { kinds: ['full'] });
      const thumbOnly = await addPhoto(w, designId, { kinds: ['thumb'] });
      const gone = await addPhoto(w, designId, { removed: true });
      const halfForeign = randomUUID();
      await addPhoto(w, designId, { id: halfForeign, kinds: ['full'] });
      await addPhoto(w, randomUUID(), { id: halfForeign, kinds: ['thumb'] }); // the thumbnail of this id belongs to another design
      const extra = await addPhoto(w, designId);
      const cases: [string, Record<string, unknown>, string][] = [
        ['an id nobody uploaded', { photo_ids: [randomUUID()] }, 'design.photo_ids'],
        ["another design's photo", { photo_ids: [foreign] }, 'design.photo_ids'],
        ['a photo with the full image only', { photo_ids: [fullOnly] }, 'design.photo_ids'],
        ['a photo with the thumbnail only', { photo_ids: [thumbOnly] }, 'design.photo_ids'],
        ['a removed photo', { photo_ids: [gone] }, 'design.photo_ids'],
        ['an id whose second kind belongs to another design', { photo_ids: [halfForeign] }, 'design.photo_ids'],
        ['one good and one bad id', { photo_ids: [good, foreign] }, 'design.photo_ids'],
        ['four photos', { photo_ids: [good, await addPhoto(w, designId), await addPhoto(w, designId), extra] }, 'design.photo_ids'],
        ['the same id twice', { photo_ids: [good, good] }, 'design.photo_ids'],
        ['an id that is not a UUID', { photo_ids: ['data:image/png;base64,AAAA'] }, 'design.photo_ids[0]'],
        ['a primary photo that is not among the ids', { photo_ids: [good], primary_photo_id: extra }, 'design.primary_photo_id'],
        ['a primary photo and no ids', { photo_ids: [], primary_photo_id: good }, 'design.primary_photo_id'],
      ];
      const before = await footprint(w);
      for (const [what, design, field] of cases) {
        const res = await createDesign(w, 'owner', designPayload(w, { design_id: designId, design: { category_id: ring, ...design } }));
        expect([res.statusCode, errorCode(res), errorField(res)], what).toEqual([422, 'JV_INVALID_INPUT', field]);
      }
      expect(await footprint(w)).toEqual(before);
    });
  });

  describe('the input (S3, S4, D6, D7, O37)', () => {
    it('refuses what the columns refuse, naming the field, and writes nothing', async () => {
      const before = await footprint(w);
      const base = () => designPayload(w, { design: { category_id: ring } });
      const bad = (mutate: (p: any) => void) => {
        const p = base();
        mutate(p);
        return createDesign(w, 'owner', p);
      };
      const cases: [string, () => Promise<any>, string][] = [
        ['unknown category', () => bad((p) => (p.design.category_id = randomUUID())), 'design.category_id'],
        ['unknown subcategory', () => bad((p) => (p.design.subcategory_id = randomUUID())), 'design.subcategory_id'],
        ['a material that is neither Gold nor Silver', () => bad((p) => (p.design.material = 'Bronze')), 'design.material'],
        ['a selling method that does not exist', () => bad((p) => (p.design.selling_method = 'By Hand')), 'design.selling_method'],
        ['no purity', () => bad((p) => delete p.design.purity), 'design.purity'],
        ['a name over 120 characters', () => bad((p) => (p.design.name = 'x'.repeat(121))), 'design.name'],
        ['21 tags', () => bad((p) => (p.design.tags = Array.from({ length: 21 }, (_, i) => `t${i}`))), 'design.tags'],
        ['a field the design does not have', () => bad((p) => (p.design.design_no = 'ANK-99999')), 'design.design_no'],
        ['a field of the body that is not there', () => bad((p) => (p.p_design = {})), 'p_design'],
        ['a piece field the API sets itself (status)', () => bad((p) => (p.pieces[0].status = 'Sold')), 'pieces[0].status'],
        ['a piece field the API sets itself (location)', () => bad((p) => (p.pieces[0].location = 'Vault')), 'pieces[0].location'],
        ['a weight as a JSON number', () => bad((p) => (p.pieces[0].gross_weight = 12.5)), 'pieces[0].gross_weight'],
        ['a weight with four decimals', () => bad((p) => (p.pieces[0].gross_weight = '12.5000')), 'pieces[0].gross_weight'],
        ['a rate over the cap', () => bad((p) => (p.pieces[0].labour_retail = '100000000.01')), 'pieces[0].labour_retail'],
        ['a count below 0', () => bad((p) => (p.pieces[0].stones = -1)), 'pieces[0].stones'],
        ['a design id that is not a UUID', () => bad((p) => (p.design_id = 'design-1700000000')), 'design_id'],
        ['no design id', () => bad((p) => delete p.design_id), 'design_id'],
        ['the net weight above the gross weight (D7)', () => bad((p) => (p.pieces[0] = group({ gross_weight: '5.000', customer_net_weight: '6.000' }))), 'pieces[0].customer_net_weight'],
        ['a By Weight design with no net weight (O37)', () => bad((p) => (p.pieces[0] = { pieces: 1, gross_weight: '5.000' })), 'pieces[0].customer_net_weight'],
      ];
      for (const [what, run, field] of cases) {
        const res = await run();
        expect([res.statusCode, errorCode(res), errorField(res)], what).toEqual([422, 'JV_INVALID_INPUT', field]);
      }
      expect(await footprint(w)).toEqual(before);
    });

    it('accepts a blank gross weight with a net weight (stored as 0, D7) and a Per Piece design with no weights at all', async () => {
      const a = await createDesign(w, 'owner', designPayload(w, { design: { category_id: ring }, pieces: [{ pieces: 1, customer_net_weight: '4.000' }] }));
      expect(a.statusCode, a.body).toBe(201);
      expect(body(a).skus[0]).toMatchObject({ gross_weight: '0.000', customer_net_weight: '4.000' });
      const b = await createDesign(w, 'owner', designPayload(w, { design: { category_id: ring, selling_method: 'Per Piece' }, pieces: [{ pieces: 1, labour_retail: '9000.00' }] }));
      expect(b.statusCode, b.body).toBe(201);
      expect(body(b).skus[0]).toMatchObject({ gross_weight: '0.000', customer_net_weight: '0.000', labour_retail: '9000.00' });
    });

    it('trims the text, takes a blank name or note as none, and keeps the subcategory', async () => {
      const res = await createDesign(w, 'owner', designPayload(w, { design: { category_id: w.category, subcategory_id: w.subcategory, name: '   ', description: '  Bridal  ', tags: [' a ', 'b'] }, pieces: [group({ notes: '  ' })] }));
      expect(res.statusCode, res.body).toBe(201);
      const b = body(res);
      expect(b.design).toMatchObject({ name: null, description: 'Bridal', tags: ['a', 'b'], subcategory_id: w.subcategory });
      expect(b.skus[0].notes).toBeNull();
    });
  });

  describe('Idempotency-Key (L5)', () => {
    it('a repeat of the same call answers the stored result with Idempotent-Replay: true and makes nothing twice', async () => {
      const cat = await categoryOf(w, 'MNG');
      const payload = designPayload(w, { design: { category_id: cat }, pieces: [group({ pieces: 3 })] });
      const key = newKey();
      const first = await createDesign(w, 'owner', payload, key);
      expect(first.statusCode, first.body).toBe(201);
      expect(first.headers['idempotent-replay']).toBeUndefined();
      const before = await footprint(w);
      const again = await createDesign(w, 'owner', payload, key.toUpperCase());
      expect(again.statusCode).toBe(201);
      expect(again.headers['idempotent-replay']).toBe('true');
      expect(body(again)).toEqual(body(first));
      expect(await footprint(w)).toEqual(before);
      expect(await counterOf(w, 'design:MNG')).toBe(1);
    });

    it('two calls with the same key at the same moment make one design', async () => {
      const cat = await categoryOf(w, 'NP');
      const payload = designPayload(w, { design: { category_id: cat }, pieces: [group({ pieces: 4 })] });
      const key = newKey();
      const [a, b] = await Promise.all([createDesign(w, 'owner', payload, key), createDesign(w, 'owner', payload, key)]);
      expect([a.statusCode, b.statusCode], `${a.body} ${b.body}`).toEqual([201, 201]);
      expect([a.headers['idempotent-replay'], b.headers['idempotent-replay']].filter((h) => h === 'true')).toHaveLength(1);
      expect(body(a)).toEqual(body(b));
      expect(await counterOf(w, 'design:NP')).toBe(1);
      expect((await piecesOf(w, payload.design_id)).length).toBe(4);
    });

    it('the same key for another body, another user or another function is refused; a missing or malformed key is refused before the database is asked', async () => {
      const cat = await categoryOf(w, 'BRO');
      const payload = designPayload(w, { design: { category_id: cat } });
      const key = newKey();
      expect((await createDesign(w, 'owner', payload, key)).statusCode).toBe(201);
      const before = await footprint(w);
      const other = await createDesign(w, 'owner', designPayload(w, { design: { category_id: cat } }), key);
      expect([other.statusCode, errorCode(other), errorField(other)]).toEqual([422, 'JV_INVALID_INPUT', 'Idempotency-Key']);
      const user = await createDesign(w, 'staff', payload, key);
      expect([user.statusCode, errorCode(user)]).toEqual([422, 'JV_INVALID_INPUT']);
      const fn = await setStatus(w, 'owner', { sku_ids: [randomUUID()], status: 'Repair' }, key);
      expect([fn.statusCode, errorCode(fn)]).toEqual([422, 'JV_INVALID_INPUT']);
      const none = await createDesign(w, 'owner', designPayload(w, { design: { category_id: cat } }), null);
      expect([none.statusCode, errorCode(none), errorField(none)]).toEqual([422, 'JV_INVALID_INPUT', 'Idempotency-Key']);
      const junk = await createDesign(w, 'owner', designPayload(w, { design: { category_id: cat } }), 'not-a-uuid');
      expect([junk.statusCode, errorCode(junk), errorField(junk)]).toEqual([422, 'JV_INVALID_INPUT', 'Idempotency-Key']);
      expect(await footprint(w)).toEqual(before);
    });
  });

  describe('T-D09 clause: the matrix row of X8', () => {
    it('no session is 401, a biller is 403 (with a valid body: the matrix refuses, not the validation), staff and the owner are let in', async () => {
      const cat = await categoryOf(w, 'OTH');
      const before = await footprint(w);
      const valid = () => designPayload(w, { design: { category_id: cat } });
      const anon = await createDesign(w, 'anon', valid());
      expect([anon.statusCode, errorCode(anon)]).toEqual([401, 'JV_UNAUTHENTICATED']);
      const biller = await createDesign(w, 'biller', valid());
      expect([biller.statusCode, errorCode(biller)]).toEqual([403, 'JV_FORBIDDEN']);
      const mustChange = await createDesign(w, 'must_change', valid());
      expect([mustChange.statusCode, errorCode(mustChange)]).toEqual([403, 'JV_PASSWORD_CHANGE_REQUIRED']);
      expect(await footprint(w)).toEqual(before);
      expect((await createDesign(w, 'staff', valid())).statusCode).toBe(201);
      expect((await createDesign(w, 'owner', valid())).statusCode).toBe(201);
    });

    it('a call without the CSRF headers is refused before anything else (JV_CSRF)', async () => {
      const res = await w.world.app.inject({ method: 'POST', url: '/v1/designs', headers: { cookie: w.world.cookieOf('owner')!, 'idempotency-key': newKey() }, payload: designPayload(w) });
      expect([res.statusCode, errorCode(res)]).toEqual([403, 'JV_CSRF']);
    });
  });

  describe('X0: the order of a writing function (claim, checks, counters last, then the writes)', () => {
    it('the claim is the first statement, every check comes before the first counter, and every insert after the last', async () => {
      const cat = await categoryOf(w, 'PEND');
      const from = w.world.spy.sent.length;
      const res = await createDesign(w, 'staff', designPayload(w, { design: { category_id: cat }, pieces: [group({ pieces: 3 })] }));
      expect(res.statusCode, res.body).toBe(201);
      const all = w.world.spy.sqls().slice(from).filter((s) => !/^(SET|COMMIT|ROLLBACK)\b/i.test(s) && !/FROM (sessions|users)\b/i.test(s) && !/^UPDATE sessions\b/i.test(s));
      const start = all.findIndex((s) => /^START TRANSACTION\b/i.test(s));
      expect(start).toBeGreaterThan(-1);
      const sqls = all.slice(start + 1); // what the transaction sent (the category read and the series row before it are not part of it)
      const at = (re: RegExp) => sqls.findIndex((s) => re.test(s));
      const last = (re: RegExp) => sqls.map((s) => re.test(s)).lastIndexOf(true);
      expect(sqls[0]).toMatch(/^INSERT INTO sys_idempotency\b/); // X0 item 1: the claim is the first statement of the transaction
      const firstCounter = at(/^UPDATE sys_counters\b/);
      const lastCounter = last(/^UPDATE sys_counters\b/);
      expect(firstCounter).toBeGreaterThan(0);
      expect(sqls.filter((s) => /^UPDATE sys_counters\b/.test(s))).toHaveLength(4); // the design number and three piece numbers
      // the checks (plain reads) are all before the first counter; after it only the look-aheads on the new numbers and the writes follow
      expect(last(/FROM (categories|settings|design_photos)\b/)).toBeLessThan(firstCounter);
      expect(at(/^INSERT INTO designs\b/)).toBeGreaterThan(lastCounter);
      expect(at(/^INSERT INTO skus\b/)).toBeGreaterThan(lastCounter);
      // no lock is taken after a counter row is held (the pieces are new rows: nothing is locked for them), and there is no customer lock at all
      expect(sqls.slice(firstCounter).filter((s) => /\bFOR UPDATE\b/i.test(s))).toEqual([]);
      expect(sqls.some((s) => /FROM customers\b/i.test(s))).toBe(false);
      // the result is stored in the claim row before the commit
      expect(last(/^UPDATE sys_idempotency SET result\b/)).toBeGreaterThan(at(/^INSERT INTO skus\b/));
    });
  });

  describe('a refused call leaves nothing behind', () => {
    it('a photo that cannot be attached rolls the whole call back, the claim and the numbers included', async () => {
      const cat = await categoryOf(w, 'ANK');
      const before = await footprint(w);
      const key = newKey();
      const res = await createDesign(w, 'owner', designPayload(w, { design: { category_id: cat, photo_ids: [randomUUID()] } }), key);
      expect(res.statusCode).toBe(422);
      expect(await footprint(w)).toEqual(before);
      expect(requestIdOf(res)).toMatch(/^[0-9a-f-]{36}$/);
    });
  });
});

describe('X8 create_design: skipping numbers that exist (L3), the settings of numbering and locations (D3, AC3)', () => {
  let w: EditWorld;
  let bangles: string;
  beforeAll(async () => {
    w = await editWorld('x8skip');
    bangles = await categoryOf(w, 'BNG');
  }, 120_000);
  afterAll(async () => {
    await w?.world.close();
  }, 60_000);

  const importedDesign = async (designNo: string) => (await insert(w.world.sql, 'designs', V.design(bangles, { design_no: designNo }))).id as string;
  const importedPiece = async (designId: string, o: Record<string, unknown>) => insert(w.world.sql, 'skus', V.sku(designId, o));

  it('skips a design number that exists (an imported code) and a piece number or barcode that exists', async () => {
    const imported = await importedDesign('BNG-00001');
    const other = await importedDesign('IMPORTED-7');
    await importedPiece(other, { sku_no: 'BNG-00002-001' }); // takes the first piece number of the design we are about to make ...
    await importedPiece(other, { sku_no: 'IMP-2', barcode: 'BC-BNG-00002-002' }); // ... and the barcode of its second
    expect(imported).toBeTruthy();
    const res = await createDesign(w, 'owner', designPayload(w, { design: { category_id: bangles }, pieces: [group({ pieces: 2 })] }));
    expect(res.statusCode, res.body).toBe(201);
    const b = body(res);
    expect(b.design.design_no).toBe('BNG-00002'); // 00001 exists
    expect(b.skus.map((s: any) => [s.sku_no, s.barcode])).toEqual([
      ['BNG-00002-003', 'BC-BNG-00002-003'],
      ['BNG-00002-004', 'BC-BNG-00002-004'],
    ]);
    expect(await counterOf(w, 'design:BNG')).toBe(2);
    expect(await counterOf(w, 'sku:BNG-00002')).toBe(4);
    // a number that was skipped is not given out later: the next design is 00003
    const next = await createDesign(w, 'owner', designPayload(w, { design: { category_id: bangles } }));
    expect(body(next).design.design_no).toBe('BNG-00003');
  });

  it('gives up after 100 numbers that exist: JV_INVALID_INPUT, the counter rolled back and nothing written', async () => {
    const chain = await categoryOf(w, 'ANK');
    for (let n = 1; n <= 101; n++) await insert(w.world.sql, 'designs', V.design(chain, { design_no: `ANK-${String(n).padStart(5, '0')}` }));
    const before = await footprint(w);
    const res = await createDesign(w, 'owner', designPayload(w, { design: { category_id: chain } }));
    expect(res.statusCode, res.body).toBe(422);
    expect(errorCode(res)).toBe('JV_INVALID_INPUT');
    expect(await footprint(w)).toEqual(before); // the 101 counter steps were rolled back with the call
    // with 100 taken the 101st try is free: remove the last one from the way
    await w.world.sql.query("UPDATE designs SET design_no = 'MOVED-1' WHERE design_no = 'ANK-00101'");
    const ok = await createDesign(w, 'owner', designPayload(w, { design: { category_id: chain } }));
    expect(ok.statusCode, ok.body).toBe(201);
    expect(body(ok).design.design_no).toBe('ANK-00101');
  });

  it('uses the paddings and the barcode prefix of settings.numbering', async () => {
    const cat = await categoryOf(w, 'RING');
    await w.world.sql.query("UPDATE settings SET value = ? WHERE setting_key = 'numbering'", [JSON.stringify({ designPadding: 3, skuPadding: 2, barcodePrefix: 'JG' })]);
    const res = await createDesign(w, 'owner', designPayload(w, { design: { category_id: cat }, pieces: [group({ pieces: 2 })] }));
    expect(res.statusCode, res.body).toBe(201);
    const b = body(res);
    expect(b.design.design_no).toBe('RING-001');
    expect(b.skus.map((s: any) => [s.sku_no, s.barcode])).toEqual([
      ['RING-001-01', 'JG-RING-001-01'],
      ['RING-001-02', 'JG-RING-001-02'],
    ]);
    await w.world.sql.query("UPDATE settings SET value = ? WHERE setting_key = 'numbering'", [JSON.stringify({ designPadding: 5, skuPadding: 3, barcodePrefix: 'BC' })]);
  });

  it('puts the first entry of settings.locations on every piece; no entry means no location', async () => {
    const cat = await categoryOf(w, 'PSET');
    await w.world.sql.query("UPDATE settings SET value = ? WHERE setting_key = 'locations'", [JSON.stringify(['Strong Room', 'Shop'])]);
    const a = await createDesign(w, 'staff', designPayload(w, { design: { category_id: cat }, pieces: [group({ pieces: 2 })] }));
    expect(body(a).skus.map((s: any) => s.location)).toEqual(['Strong Room', 'Strong Room']);
    await w.world.sql.query("UPDATE settings SET value = '[]' WHERE setting_key = 'locations'");
    const b = await createDesign(w, 'staff', designPayload(w, { design: { category_id: cat } }));
    expect(b.statusCode, b.body).toBe(201);
    expect(body(b).skus[0].location).toBeNull();
    await w.world.sql.query("UPDATE settings SET value = ? WHERE setting_key = 'locations'", [JSON.stringify(['Main Showroom', 'Jaishri Vault', 'Workshop', 'Exhibition'])]);
  });

  it('a settings value that is not what D3 says is a fault of the data (JV_INTERNAL), never the caller\'s', async () => {
    const cat = await categoryOf(w, 'SET');
    const before = await footprint(w);
    await w.world.sql.query("UPDATE settings SET value = '{\"designPadding\":\"five\"}' WHERE setting_key = 'numbering'");
    const res = await createDesign(w, 'owner', designPayload(w, { design: { category_id: cat } }));
    expect(res.statusCode).toBe(500);
    expect(errorCode(res)).toBe('JV_INTERNAL');
    expect(await footprint(w)).toEqual(before);
    await w.world.sql.query("UPDATE settings SET value = ? WHERE setting_key = 'numbering'", [JSON.stringify({ designPadding: 5, skuPadding: 3, barcodePrefix: 'BC' })]);
  });
});
