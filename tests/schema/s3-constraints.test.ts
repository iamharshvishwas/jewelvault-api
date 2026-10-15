import { randomBytes } from 'node:crypto';
import type { Connection } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dropDb, errorOf, ER } from '../helpers';
import { V, insert, migratedDb, u, uuid, world } from './support';

// What each table accepts and refuses. Valid rows come from V.*; every refusal names the rule (spec section and ID).

let db: string;
let c: Connection;
let w: Awaited<ReturnType<typeof world>>;
beforeAll(async () => {
  ({ db, c } = await migratedDb('s3_constraints'));
  w = await world(c);
});
afterAll(async () => {
  await c.end();
  await dropDb(db);
});

const CHECK = 4025;
const DUP = ER.DUP_ENTRY;
const FK = ER.NO_REFERENCED_ROW;
type Case = [title: string, table: string, row: () => Record<string, unknown>, errno: number | null];

const run = (cases: Case[]) =>
  it.each(cases)('%s', async (_title, table, row, errno) => {
    const err = await errorOf(() => insert(c, table, row()));
    if (errno === null) expect(err?.message ?? null).toBeNull();
    else {
      expect(err, 'expected the database to refuse this row').not.toBeNull();
      expect(err?.errno, err?.message).toBe(errno);
    }
  });

describe('users and sessions (D1 replaced)', () => {
  run([
    ['a valid user is accepted and is inactive by default', 'users', () => V.user(), null],
    ['an unknown role is refused', 'users', () => V.user({ role: 'admin' }), CHECK],
    ['an e-mail without @ is refused', 'users', () => V.user({ email: 'nobody' }), CHECK],
    ['an empty full name is refused', 'users', () => V.user({ full_name: '' }), CHECK],
  ]);
  it('e-mail is unique ignoring case', async () => {
    const e = `Dup.${u()}@Example.Test`;
    await insert(c, 'users', V.user({ email: e }));
    expect((await errorOf(() => insert(c, 'users', V.user({ email: e.toLowerCase() }))))?.errno).toBe(DUP);
  });
  it('a new user is inactive until activated (default active = 0)', async () => {
    const row = V.user();
    delete (row as any).active;
    await insert(c, 'users', row);
    const [r] = await c.query<any[]>('SELECT active FROM users WHERE id = ?', [row.id]);
    expect(Number(r[0].active)).toBe(0);
  });
  it('a session needs an existing user and a 32-byte token hash that is unique', async () => {
    const user = await insert(c, 'users', V.user()) as { id: string };
    expect((await errorOf(() => insert(c, 'sessions', V.session(uuid()))))?.errno).toBe(FK);
    const s = V.session(user.id);
    await insert(c, 'sessions', s);
    expect((await errorOf(() => insert(c, 'sessions', V.session(user.id, { token_hash: s.token_hash }))))?.errno).toBe(DUP);
    expect((await errorOf(() => insert(c, 'sessions', V.session(user.id, { token_hash: randomBytes(31) }))))?.errno).toBe(CHECK);
  });
  it('a user with a session cannot be deleted (RESTRICT)', async () => {
    const user = await insert(c, 'users', V.user()) as { id: string };
    await insert(c, 'sessions', V.session(user.id));
    expect((await errorOf(() => c.query('DELETE FROM users WHERE id = ?', [user.id])))?.errno).toBe(ER.ROW_IS_REFERENCED);
  });
});

describe('settings, daily_rates, categories (D3 to D5)', () => {
  run([
    ['a setting is one row per key with a JSON value', 'settings', () => ({ setting_key: `k_${u()}`, value: { a: 1 } }), null],
    ['a setting value that is not JSON is refused', 'settings', () => ({ setting_key: `k_${u()}`, value: '{broken' }), CHECK],
    ['a gold rate is accepted', 'daily_rates', () => V.dailyRate({ rate_date: '2026-01-01', purity: `P${u()}` }), null],
    ['a material other than Gold or Silver is refused (D4)', 'daily_rates', () => V.dailyRate({ material: 'Platinum', purity: `P${u()}` }), CHECK],
    ['a rate of 0 is refused', 'daily_rates', () => V.dailyRate({ rate_per_gram: '0.00', purity: `P${u()}` }), CHECK],
    ['a rate above 100,000,000 is refused (S4)', 'daily_rates', () => V.dailyRate({ rate_per_gram: '100000000.01', purity: `P${u()}` }), CHECK],
    ['a category prefix in lower case is refused (binary compare)', 'categories', () => V.category({ prefix: 'abc' }), CHECK],
    ['a category prefix of one character is refused', 'categories', () => V.category({ prefix: 'A' }), CHECK],
    ['a category prefix of seven characters is refused', 'categories', () => V.category({ prefix: 'ABCDEFG' }), CHECK],
    ['a category with digits in its prefix is accepted', 'categories', () => V.category({ prefix: 'R2D2' }), null],
  ]);
  it('one rate per date, material and purity', async () => {
    const r = V.dailyRate({ rate_date: '2026-02-02', purity: `U${u()}` });
    await insert(c, 'daily_rates', r);
    expect((await errorOf(() => insert(c, 'daily_rates', V.dailyRate({ rate_date: r.rate_date, purity: r.purity }))))?.errno).toBe(DUP);
  });
  it('category names are unique ignoring case; sub-category names are unique per category only', async () => {
    const name = `Unique ${u()}`;
    await insert(c, 'categories', V.category({ name }));
    expect((await errorOf(() => insert(c, 'categories', V.category({ name: name.toUpperCase() }))))?.errno).toBe(DUP);
    const sub = V.subcategory(w.categoryId, { name: `S ${u()}` });
    await insert(c, 'subcategories', sub);
    expect((await errorOf(() => insert(c, 'subcategories', V.subcategory(w.categoryId, { name: String(sub.name).toLowerCase() }))))?.errno).toBe(DUP);
    const other = await insert(c, 'categories', V.category()) as { id: string };
    await insert(c, 'subcategories', V.subcategory(other.id, { name: sub.name }));
  });
});

describe('designs and photos (D6, P1 to P4 replaced)', () => {
  run([
    ['a valid design', 'designs', () => V.design(w.categoryId), null],
    ['a material other than Gold or Silver is refused (D6)', 'designs', () => V.design(w.categoryId, { material: 'Copper' }), CHECK],
    ['a selling method other than By Weight or Per Piece is refused', 'designs', () => V.design(w.categoryId, { selling_method: 'By Lot' }), CHECK],
    ['tags must be a JSON array', 'designs', () => V.design(w.categoryId, { tags: { a: 1 } }), CHECK],
    ['photo_ids must be a JSON array', 'designs', () => V.design(w.categoryId, { photo_ids: { a: 1 } }), CHECK],
    ['at most 3 photos per design (Harsh, 15 Oct)', 'designs', () => V.design(w.categoryId, { photo_ids: [uuid(), uuid(), uuid(), uuid()] }), CHECK],
    ['3 photos are accepted', 'designs', () => V.design(w.categoryId, { photo_ids: [uuid(), uuid(), uuid()] }), null],
    ['a design needs an existing category', 'designs', () => V.design(uuid()), FK],
    ['an unknown purity is NOT checked in the database (purities are a setting)', 'designs', () => V.design(w.categoryId, { purity: 'Custom' }), null],
  ]);
  it('design numbers are unique ignoring case', async () => {
    const d = V.design(w.categoryId, { design_no: `Dup-${u()}` });
    await insert(c, 'designs', d);
    expect((await errorOf(() => insert(c, 'designs', V.design(w.categoryId, { design_no: String(d.design_no).toUpperCase() }))))?.errno).toBe(DUP);
  });
  it('a category that has designs cannot be deleted', async () => {
    expect((await errorOf(() => c.query('DELETE FROM categories WHERE id = ?', [w.categoryId])))?.errno).toBe(ER.ROW_IS_REFERENCED);
  });

  const photo = (o: Record<string, unknown> = {}) => {
    const bytes = randomBytes(1000);
    return { id: uuid(), kind: 'full', design_id: w.design.id, mime: 'image/jpeg', byte_size: 1000, sha256: randomBytes(32), bytes, ...o };
  };
  run([
    ['a photo of 1000 bytes is accepted', 'design_photos', () => photo(), null],
    ['a thumbnail row is accepted', 'design_photos', () => photo({ kind: 'thumb' }), null],
    ['a kind other than full or thumb is refused', 'design_photos', () => photo({ kind: 'medium' }), CHECK],
    ['a type other than jpeg, png or webp is refused', 'design_photos', () => photo({ mime: 'image/gif' }), CHECK],
    ['a size of 0 is refused', 'design_photos', () => photo({ byte_size: 0, bytes: Buffer.alloc(0) }), CHECK],
    ['a declared size that differs from the stored bytes is refused', 'design_photos', () => photo({ byte_size: 999 }), CHECK],
    ['a photo for a design id that does not exist yet is ACCEPTED: the screen uploads before the design exists (spec P2, D26: no foreign key)', 'design_photos', () => photo({ design_id: uuid() }), null],
    ['a removed photo has removed_at set and no bytes', 'design_photos', () => photo({ removed_at: '2026-10-15 12:00:00.000000', bytes: null }), null],
    ['no bytes without removed_at is refused', 'design_photos', () => photo({ bytes: null }), CHECK],
    ['removed_at with the bytes still there is refused', 'design_photos', () => photo({ removed_at: '2026-10-15 12:00:00.000000' }), CHECK],
    ['a removed photo keeps its recorded size, which must still be 1 byte to 2 MiB', 'design_photos', () => photo({ removed_at: '2026-10-15 12:00:00.000000', bytes: null, byte_size: 0 }), CHECK],
    ['a sha256 of the wrong length is refused', 'design_photos', () => photo({ sha256: randomBytes(31) }), CHECK],
  ]);
  it('removing a photo is a tombstone UPDATE: removed_at set and bytes emptied, the row stays (S7: nothing is deleted)', async () => {
    const p = photo();
    await insert(c, 'design_photos', p);
    await c.query('UPDATE design_photos SET removed_at = ?, bytes = NULL WHERE id = ? AND kind = ?', ['2026-10-15 12:00:00.000000', p.id, 'full']);
    const [r] = await c.query<any[]>('SELECT removed_at, bytes, byte_size FROM design_photos WHERE id = ? AND kind = ?', [p.id, 'full']);
    expect(r).toHaveLength(1);
    expect(r[0].bytes).toBeNull();
    expect(Number(r[0].byte_size)).toBe(1000);
    // emptying the bytes without setting removed_at is refused
    const q = photo();
    await insert(c, 'design_photos', q);
    expect((await errorOf(() => c.query('UPDATE design_photos SET bytes = NULL WHERE id = ? AND kind = ?', [q.id, 'full'])))?.errno).toBe(CHECK);
  });
  it('the full photo and its thumbnail share one photo id (primary key is id + kind)', async () => {
    const id = uuid();
    await insert(c, 'design_photos', photo({ id, kind: 'full' }));
    await insert(c, 'design_photos', photo({ id, kind: 'thumb' }));
    expect((await errorOf(() => insert(c, 'design_photos', photo({ id, kind: 'full' }))))?.errno).toBe(DUP);
  });
  it('a photo of exactly 2 MiB is accepted and one byte more is refused (P1, O21)', async () => {
    const big = Buffer.alloc(2097152, 1);
    await insert(c, 'design_photos', photo({ byte_size: big.length, bytes: big }));
    const bigger = Buffer.alloc(2097153, 1);
    expect((await errorOf(() => insert(c, 'design_photos', photo({ byte_size: bigger.length, bytes: bigger }))))?.errno).toBe(CHECK);
  });
});

describe('skus and sku_private (D7 to D9)', () => {
  const sold = () => V.sku(w.design.id, { status: 'Sold', sold_bill_id: w.bill.id });
  run([
    ['a valid piece', 'skus', () => V.sku(w.design.id), null],
    ['a status outside the ten (D8) is refused', 'skus', () => V.sku(w.design.id, { status: 'Lost' }), CHECK],
    ['Sold without a bill is refused', 'skus', () => V.sku(w.design.id, { status: 'Sold' }), CHECK],
    ['a bill on a piece that is not Sold is refused', 'skus', () => V.sku(w.design.id, { sold_bill_id: w.bill.id }), CHECK],
    ['Sold with a bill is accepted', 'skus', sold, null],
    ['Archived without archived_at is refused', 'skus', () => V.sku(w.design.id, { status: 'Archived' }), CHECK],
    ['Archived with archived_at is accepted', 'skus', () => V.sku(w.design.id, { status: 'Archived', archived_at: '2026-10-15 10:00:00.000000' }), null],
    ['archived_at on a piece that is not Archived is refused', 'skus', () => V.sku(w.design.id, { archived_at: '2026-10-15 10:00:00.000000' }), CHECK],
    ['a negative weight is refused', 'skus', () => V.sku(w.design.id, { gross_weight: '-0.001' }), CHECK],
    ['a gross weight above 100,000 g is refused (S4)', 'skus', () => V.sku(w.design.id, { gross_weight: '100000.001' }), CHECK],
    ['a net weight of exactly 100,000 g is accepted', 'skus', () => V.sku(w.design.id, { customer_net_weight: '100000.000' }), null],
    ['a labour rate above 100,000,000 is refused', 'skus', () => V.sku(w.design.id, { labour_retail: '100000000.01' }), CHECK],
    ['a negative piroi is refused', 'skus', () => V.sku(w.design.id, { piroi: '-1.00' }), CHECK],
    ['a piece needs an existing design', 'skus', () => V.sku(uuid()), FK],
    ['a piece cannot point to a bill that does not exist', 'skus', () => V.sku(w.design.id, { status: 'Sold', sold_bill_id: uuid() }), FK],
    ['a net weight above the gross weight is NOT a database rule (O37: a rule of the API, only on insert and weight change)', 'skus', () => V.sku(w.design.id, { gross_weight: '5.000', customer_net_weight: '9.000' }), null],
  ]);
  it('sku numbers and barcodes are unique ignoring case', async () => {
    const s = V.sku(w.design.id, { sku_no: `Z-${u()}`, barcode: `ZB-${u()}` });
    await insert(c, 'skus', s);
    expect((await errorOf(() => insert(c, 'skus', V.sku(w.design.id, { sku_no: String(s.sku_no).toLowerCase() }))))?.errno).toBe(DUP);
    expect((await errorOf(() => insert(c, 'skus', V.sku(w.design.id, { barcode: String(s.barcode).toLowerCase() }))))?.errno).toBe(DUP);
  });
  it('the owner-only weight is its own table: one row per piece, not negative, not above 100,000 g', async () => {
    const s = await insert(c, 'skus', V.sku(w.design.id)) as { id: string };
    await insert(c, 'sku_private', V.skuPrivate(s.id));
    expect((await errorOf(() => insert(c, 'sku_private', V.skuPrivate(s.id))))?.errno).toBe(DUP);
    const s2 = await insert(c, 'skus', V.sku(w.design.id)) as { id: string };
    expect((await errorOf(() => insert(c, 'sku_private', V.skuPrivate(s2.id, { original_net_weight: '-1.000' }))))?.errno).toBe(CHECK);
    expect((await errorOf(() => insert(c, 'sku_private', V.skuPrivate(s2.id, { original_net_weight: '100000.001' }))))?.errno).toBe(CHECK);
    expect((await errorOf(() => insert(c, 'sku_private', V.skuPrivate(uuid()))))?.errno).toBe(FK);
  });
  it('a piece that is on a bill cannot be deleted, and neither can its design', async () => {
    expect((await errorOf(() => c.query('DELETE FROM skus WHERE id = ?', [w.sku.id])))?.errno).toBe(ER.ROW_IS_REFERENCED);
    expect((await errorOf(() => c.query('DELETE FROM designs WHERE id = ?', [w.design.id])))?.errno).toBe(ER.ROW_IS_REFERENCED);
  });
});

describe('customers (D10, K5)', () => {
  const WALKIN = '00000000-0000-4000-8000-000000000001';
  run([
    ['a valid customer', 'customers', () => V.customer(), null],
    ['a mobile of 9 digits is refused', 'customers', () => V.customer({ mobile: '987654321' }), CHECK],
    ['a mobile with letters is refused', 'customers', () => V.customer({ mobile: '98765abcde' }), CHECK],
    ['a foreign number "+" and 7 to 15 digits is accepted', 'customers', () => V.customer({ mobile: '+447911123456' }), null],
    ['"+" and 6 digits is refused', 'customers', () => V.customer({ mobile: '+123456' }), CHECK],
    ['no mobile for a named customer is refused (O33)', 'customers', () => V.customer({ mobile: null }), CHECK],
    ['a customer type outside the three is refused', 'customers', () => V.customer({ customer_type: 'VIP' }), CHECK],
    ['an empty name is refused', 'customers', () => V.customer({ name: '' }), CHECK],
    ['a name of 121 characters is refused', 'customers', () => V.customer({ name: 'x'.repeat(121) }), ER.DATA_TOO_LONG],
    ['a valid PAN is accepted', 'customers', () => V.customer({ pan: 'ABCDE1234F' }), null],
    ['a PAN in lower case is refused (binary compare, the REGEXP trap)', 'customers', () => V.customer({ pan: 'abcde1234f' }), CHECK],
    ['a PAN of the wrong shape is refused', 'customers', () => V.customer({ pan: 'ABCDE12345' }), CHECK],
    ['a second walk-in customer is refused (one walk-in)', 'customers', () => V.customer({ is_walkin: 1, mobile: null }), DUP],
    ['an ordinary customer may be archived', 'customers', () => V.customer({ archived_at: '2026-10-15 10:00:00.000000' }), null],
  ]);
  it('a customer without a mobile is accepted only when it carries an import batch (D10, O33)', async () => {
    const batch = uuid();
    await insert(c, 'sys_import_batches', { id: batch, name: `batch-${u()}` });
    await insert(c, 'customers', V.customer({ mobile: null, import_batch_id: batch }));
    expect((await errorOf(() => insert(c, 'customers', V.customer({ mobile: null }))))?.errno).toBe(CHECK);
  });
  it('the walk-in row exists with its fixed id, holds no PAN and cannot be archived (K5)', async () => {
    const [r] = await c.query<any[]>('SELECT name, is_walkin, mobile, pan, archived_at FROM customers WHERE id = ?', [WALKIN]);
    expect(r).toHaveLength(1);
    expect(Number(r[0].is_walkin)).toBe(1);
    expect((await errorOf(() => c.query("UPDATE customers SET pan = 'ABCDE1234F' WHERE id = ?", [WALKIN])))?.errno).toBe(CHECK);
    expect((await errorOf(() => c.query("UPDATE customers SET archived_at = '2026-10-15 10:00:00.000000' WHERE id = ?", [WALKIN])))?.errno).toBe(CHECK);
  });
});

describe('bills (D11, R8, K1, K6)', () => {
  const cancelled = (o: Record<string, unknown> = {}) =>
    V.bill(w.customer.id, { status: 'cancelled', cancel_reason: 'wrong customer', cancelled_at: '2026-10-15 11:00:00.000000', cancelled_by: uuid(), ...o });
  run([
    ['a valid estimate', 'bills', () => V.bill(w.customer.id), null],
    ['an unknown document type is refused', 'bills', () => V.bill(w.customer.id, { doc_type: 'invoice' }), CHECK],
    ['an unknown sale type is refused', 'bills', () => V.bill(w.customer.id, { sale_type: 'Export' }), CHECK],
    ['an unknown status is refused', 'bills', () => V.bill(w.customer.id, { status: 'draft' }), CHECK],
    ['a cancelled bill with reason, time and person is accepted', 'bills', () => cancelled(), null],
    ['cancelled without a reason is refused', 'bills', () => cancelled({ cancel_reason: null }), CHECK],
    ['cancelled without a time is refused', 'bills', () => cancelled({ cancelled_at: null }), CHECK],
    ['cancelled without a person is refused', 'bills', () => cancelled({ cancelled_by: null }), CHECK],
    ['an active bill with cancel data is refused', 'bills', () => V.bill(w.customer.id, { cancel_reason: 'x' }), CHECK],
    ['an estimate total with paise is refused (R8: always a whole rupee)', 'bills', () => V.bill(w.customer.id, { grand_total: '1000.50' }), CHECK],
    ['an opening-balance bill may carry paise', 'bills', () => V.bill(w.customer.id, { doc_type: 'opening_balance', subtotal: '0.00', grand_total: '1000.50' }), null],
    ['a negative subtotal is refused', 'bills', () => V.bill(w.customer.id, { subtotal: '-1.00' }), CHECK],
    ['a grand total above 1,000,000,000 is refused (S4)', 'bills', () => V.bill(w.customer.id, { grand_total: '1000000001.00' }), CHECK],
    ['a round-off of -0.40 is accepted (R8)', 'bills', () => V.bill(w.customer.id, { round_off: '-0.40' }), null],
    ['a round-off above 0.50 is refused', 'bills', () => V.bill(w.customer.id, { round_off: '0.51' }), CHECK],
    ['a GST percent above 100 is refused', 'bills', () => V.bill(w.customer.id, { gst_percent: '100.01' }), CHECK],
    ['a bill needs an existing customer', 'bills', () => V.bill(uuid()), FK],
    ['a bill with no request id is accepted (imports)', 'bills', () => V.bill(w.customer.id, { request_id: null }), null],
    ['a bill may replace a bill that exists', 'bills', () => V.bill(w.customer.id, { reissue_of: w.bill.id }), null],
    ['a bill may not replace a bill that does not exist', 'bills', () => V.bill(w.customer.id, { reissue_of: uuid() }), FK],
  ]);
  it('bill numbers and request ids are unique; a bill can be replaced only once (K6)', async () => {
    const b = V.bill(w.customer.id);
    await insert(c, 'bills', b);
    expect((await errorOf(() => insert(c, 'bills', V.bill(w.customer.id, { bill_no: String(b.bill_no).toLowerCase() }))))?.errno).toBe(DUP);
    expect((await errorOf(() => insert(c, 'bills', V.bill(w.customer.id, { request_id: b.request_id }))))?.errno).toBe(DUP);
    await insert(c, 'bills', V.bill(w.customer.id, { reissue_of: b.id }));
    expect((await errorOf(() => insert(c, 'bills', V.bill(w.customer.id, { reissue_of: b.id }))))?.errno).toBe(DUP);
  });
  it('a customer who has bills cannot be deleted', async () => {
    expect((await errorOf(() => c.query('DELETE FROM customers WHERE id = ?', [w.customer.id])))?.errno).toBe(ER.ROW_IS_REFERENCED);
  });
});

describe('bill_items (D12, R6, R7)', () => {
  let bill: string;
  beforeAll(async () => {
    bill = ((await insert(c, 'bills', V.bill(w.customer.id))) as { id: string }).id;
  });
  const withSku = async (o: Record<string, unknown> = {}) => {
    const s = (await insert(c, 'skus', V.sku(w.design.id))) as { id: string };
    return V.billItem(bill, s.id, { line_no: Math.floor(Math.random() * 190) + 1, ...o });
  };
  it('a valid line is accepted; item_total must equal metal + labour + piroi + other charges (R7)', async () => {
    await insert(c, 'bill_items', await withSku());
    expect((await errorOf(async () => insert(c, 'bill_items', await withSku({ item_total: '1210.01' }))))?.errno).toBe(CHECK);
  });
  it('a By Weight line must have quantity 1 (R6); a Per Piece line may have more', async () => {
    expect((await errorOf(async () => insert(c, 'bill_items', await withSku({ quantity: 2 }))))?.errno).toBe(CHECK);
    await insert(c, 'bill_items', await withSku({ selling_method: 'Per Piece', quantity: 5 }));
  });
  it('quantity 1 to 1,000 and line number 1 to 200 (S4)', async () => {
    expect((await errorOf(async () => insert(c, 'bill_items', await withSku({ selling_method: 'Per Piece', quantity: 0 }))))?.errno).toBe(CHECK);
    expect((await errorOf(async () => insert(c, 'bill_items', await withSku({ selling_method: 'Per Piece', quantity: 1001 }))))?.errno).toBe(CHECK);
    expect((await errorOf(async () => insert(c, 'bill_items', await withSku({ line_no: 0 }))))?.errno).toBe(CHECK);
    expect((await errorOf(async () => insert(c, 'bill_items', await withSku({ line_no: 201 }))))?.errno).toBe(CHECK);
  });
  it('material and selling method are checked in the snapshot too; negative amounts are refused', async () => {
    expect((await errorOf(async () => insert(c, 'bill_items', await withSku({ material: 'Brass' }))))?.errno).toBe(CHECK);
    expect((await errorOf(async () => insert(c, 'bill_items', await withSku({ selling_method: 'By Lot' }))))?.errno).toBe(CHECK);
    expect((await errorOf(async () => insert(c, 'bill_items', await withSku({ piroi: '-1.00', item_total: '1209.00' }))))?.errno).toBe(CHECK);
  });
  it('one line number and one piece appear once per bill', async () => {
    const s = (await insert(c, 'skus', V.sku(w.design.id))) as { id: string };
    await insert(c, 'bill_items', V.billItem(bill, s.id, { line_no: 77 }));
    expect((await errorOf(async () => insert(c, 'bill_items', V.billItem(bill, (await insert(c, 'skus', V.sku(w.design.id)) as { id: string }).id, { line_no: 77 }))))?.errno).toBe(DUP);
    expect((await errorOf(() => insert(c, 'bill_items', V.billItem(bill, s.id, { line_no: 78 }))))?.errno).toBe(DUP);
  });
  it('a line needs an existing bill and piece; a bill with lines cannot be deleted', async () => {
    expect((await errorOf(() => insert(c, 'bill_items', V.billItem(uuid(), w.sku.id, { line_no: 5 }))))?.errno).toBe(FK);
    expect((await errorOf(() => insert(c, 'bill_items', V.billItem(bill, uuid(), { line_no: 6 }))))?.errno).toBe(FK);
    expect((await errorOf(() => c.query('DELETE FROM bills WHERE id = ?', [w.bill.id])))?.errno).toBe(ER.ROW_IS_REFERENCED);
  });
});

describe('receipts and allocations (D13, D14, Y1, Y2)', () => {
  const voided = (o: Record<string, unknown> = {}) =>
    V.receipt(w.customer.id, { status: 'voided', void_reason: 'entered twice', voided_at: '2026-10-15 12:00:00.000000', voided_by: uuid(), ...o });
  run([
    ['a cash receipt', 'receipts', () => V.receipt(w.customer.id), null],
    ['there is no "Credit" mode (Y2)', 'receipts', () => V.receipt(w.customer.id, { mode: 'Credit' }), CHECK],
    ['UPI, Card, Bank Transfer and Other are accepted', 'receipts', () => V.receipt(w.customer.id, { mode: 'Bank Transfer' }), null],
    ['a money receipt without a mode is refused', 'receipts', () => V.receipt(w.customer.id, { mode: null }), CHECK],
    ['a money receipt of 0 is refused', 'receipts', () => V.receipt(w.customer.id, { amount: '0.00' }), CHECK],
    ['a money receipt above 1,000,000,000 is refused', 'receipts', () => V.receipt(w.customer.id, { amount: '1000000000.01' }), CHECK],
    ['a money receipt that carries fine grams is refused', 'receipts', () => V.receipt(w.customer.id, { fine_grams: '1.000' }), CHECK],
    ['an unknown kind is refused', 'receipts', () => V.receipt(w.customer.id, { kind: 'gift' }), CHECK],
    ['a refund is accepted with a mode and an amount', 'receipts', () => V.receipt(w.customer.id, { kind: 'refund' }), null],
    ['a refund without a mode is refused', 'receipts', () => V.receipt(w.customer.id, { kind: 'refund', mode: null }), CHECK],
    ['silver received: no mode, no amount, grams above 0', 'receipts', () => V.receipt(w.customer.id, { kind: 'fine_silver', mode: null, amount: '0.00', fine_grams: '10.000' }), null],
    ['silver received with a rupee amount is refused', 'receipts', () => V.receipt(w.customer.id, { kind: 'fine_silver', mode: null, amount: '5.00', fine_grams: '10.000' }), CHECK],
    ['silver received with a mode is refused', 'receipts', () => V.receipt(w.customer.id, { kind: 'fine_silver', mode: 'Cash', amount: '0.00', fine_grams: '10.000' }), CHECK],
    ['silver received of 0 grams is refused', 'receipts', () => V.receipt(w.customer.id, { kind: 'fine_silver', mode: null, amount: '0.00', fine_grams: '0.000' }), CHECK],
    ['silver settled in cash: mode Cash, amount, grams and a silver rate', 'receipts', () => V.receipt(w.customer.id, { kind: 'fine_cash', mode: 'Cash', amount: '880.00', fine_grams: '10.000', silver_rate: '88.00' }), null],
    ['silver settled in cash through UPI is refused (D13: Cash only)', 'receipts', () => V.receipt(w.customer.id, { kind: 'fine_cash', mode: 'UPI', amount: '880.00', fine_grams: '10.000', silver_rate: '88.00' }), CHECK],
    ['silver settled in cash without a rate is refused', 'receipts', () => V.receipt(w.customer.id, { kind: 'fine_cash', mode: 'Cash', amount: '880.00', fine_grams: '10.000' }), CHECK],
    ['an opening advance in money (mode Other) is accepted', 'receipts', () => V.receipt(w.customer.id, { is_opening: 1, mode: 'Other' }), null],
    ['an opening flag on a refund is refused', 'receipts', () => V.receipt(w.customer.id, { is_opening: 1, kind: 'refund', mode: 'Other' }), CHECK],
    ['a voided receipt with reason, time and person is accepted', 'receipts', () => voided(), null],
    ['voided without a reason is refused', 'receipts', () => voided({ void_reason: null }), CHECK],
    ['an active receipt carrying void data is refused', 'receipts', () => V.receipt(w.customer.id, { void_reason: 'x' }), CHECK],
    ['a receipt needs an existing customer', 'receipts', () => V.receipt(uuid()), FK],
    ['fine grams above 100,000 are refused', 'receipts', () => V.receipt(w.customer.id, { kind: 'fine_silver', mode: null, amount: '0.00', fine_grams: '100000.001' }), CHECK],
  ]);
  it('an allocation joins a receipt and a bill of the SAME customer only (Y4, composite foreign keys)', async () => {
    const other = (await insert(c, 'customers', V.customer())) as { id: string };
    const otherReceipt = (await insert(c, 'receipts', V.receipt(other.id))) as { id: string };
    const otherBill = (await insert(c, 'bills', V.bill(other.id))) as { id: string };
    expect((await errorOf(() => insert(c, 'receipt_allocations', V.allocation(otherReceipt.id, w.bill.id, w.customer.id))))?.errno).toBe(FK);
    expect((await errorOf(() => insert(c, 'receipt_allocations', V.allocation(w.receipt.id, otherBill.id, w.customer.id))))?.errno).toBe(FK);
    expect((await errorOf(() => insert(c, 'receipt_allocations', V.allocation(w.receipt.id, w.bill.id, other.id))))?.errno).toBe(FK);
    await insert(c, 'receipt_allocations', V.allocation(otherReceipt.id, otherBill.id, other.id));
  });
  it('an allocation is money or silver, never both, never empty, never negative (I3)', async () => {
    expect((await errorOf(() => insert(c, 'receipt_allocations', V.allocation(w.receipt.id, w.bill.id, w.customer.id, { amount: '0.00', fine_grams: '0.000' }))))?.errno).toBe(CHECK);
    expect((await errorOf(() => insert(c, 'receipt_allocations', V.allocation(w.receipt.id, w.bill.id, w.customer.id, { amount: '1.00', fine_grams: '1.000' }))))?.errno).toBe(CHECK);
    expect((await errorOf(() => insert(c, 'receipt_allocations', V.allocation(w.receipt.id, w.bill.id, w.customer.id, { amount: '-1.00' }))))?.errno).toBe(CHECK);
    await insert(c, 'receipt_allocations', V.allocation(w.receipt.id, w.bill.id, w.customer.id, { amount: '0.00', fine_grams: '2.500' }));
  });
  it('a receipt with allocations cannot be deleted', async () => {
    expect((await errorOf(() => c.query('DELETE FROM receipts WHERE id = ?', [w.receipt.id])))?.errno).toBe(ER.ROW_IS_REFERENCED);
  });
});

describe('logs and system tables (D16 to D18, I8, L5)', () => {
  run([
    ['an audit row for an insert', 'audit_log', () => ({ table_name: 'bills', row_id: uuid(), action: 'insert', new_row: { a: 1 } }), null],
    ['an audit action other than insert, update or event is refused (nothing is deleted)', 'audit_log', () => ({ table_name: 'bills', row_id: uuid(), action: 'delete' }), CHECK],
    ['an audit row for an event (login, failed login, password change, admin door, job run) carries its facts in new_row', 'audit_log', () => ({ table_name: 'users', row_id: uuid(), action: 'event', actor_role: 'admin-cli', new_row: { what: 'password changed' } }), null],
    ['an audit row written by hand in phpMyAdmin may carry the role sql', 'audit_log', () => ({ table_name: 'bills', row_id: uuid(), action: 'update', actor_role: 'sql' }), null],
    ['an audit row with broken JSON is refused', 'audit_log', () => ({ table_name: 'bills', row_id: uuid(), action: 'update', old_row: '{broken' }), CHECK],
    ['a nightly check row', 'check_runs', () => ({ ok: 1, details: { I1: 0 } }), null],
    ['a dump row', 'backup_runs', () => ({ kind: 'db_dump', ok: 1, bytes: 12345, detail: {} }), null],
    ['a restore drill row', 'backup_runs', () => ({ kind: 'restore_drill', ok: 1, bytes: 0, detail: {} }), null],
    ['a photo copy row (D-Q11: the export leaves the photo bytes out, each photo is copied once)', 'backup_runs', () => ({ kind: 'photo_copy', ok: 1, bytes: 245000, detail: { photos: 3 } }), null],
    ['an unknown backup kind is refused', 'backup_runs', () => ({ kind: 'mirror', ok: 1, bytes: 0, detail: {} }), CHECK],
    ['a counter series', 'sys_counters', () => ({ series: `bill:JV:${u()}`, last_value: 5, seed_value: 0 }), null],
    ['a counter below its seed value is refused', 'sys_counters', () => ({ series: `bill:JV:${u()}`, last_value: 1, seed_value: 5 }), CHECK],
    ['an idempotency row', 'sys_idempotency', () => ({ request_id: uuid(), fn: 'create_bill', actor: uuid(), args_hash: 'a'.repeat(64) }), null],
    ['an idempotency hash of the wrong length is refused', 'sys_idempotency', () => ({ request_id: uuid(), fn: 'create_bill', actor: uuid(), args_hash: 'abc' }), CHECK],
    ['a job run', 'sys_job_runs', () => ({ job: `nightly_${u()}`, run_date: '2026-10-15', status: 'running' }), null],
    ['a job status outside running, ok, failed is refused', 'sys_job_runs', () => ({ job: `nightly_${u()}`, run_date: '2026-10-15', status: 'weird' }), CHECK],
    ['an import batch', 'sys_import_batches', () => ({ id: uuid(), name: `b-${u()}`, row_counts: { designs: 3 } }), null],
    ['a login attempt', 'sys_login_attempts', () => ({ email_hash: randomBytes(32), ip_hash: randomBytes(32) }), null],
    ['an error log row', 'sys_error_log', () => ({ level: 'error', code: 'JV_INTERNAL', message: 'x' }), null],
    ['an error level outside the list is refused', 'sys_error_log', () => ({ level: 'loud', code: 'X', message: 'x' }), CHECK],
  ]);
  describe('photo copy tracking (D-Q11): which photos have been copied to the off-site bucket', () => {
    const mk = async (o: Record<string, unknown> = {}) => {
      const id = uuid();
      const base = { id, kind: 'full', design_id: uuid(), mime: 'image/jpeg', byte_size: 3, sha256: randomBytes(32), bytes: Buffer.from([1, 2, 3]), ...o };
      await insert(c, 'design_photos', base);
      return base;
    };
    const copy = (p: { id: string; kind: string }, o: Record<string, unknown> = {}) => ({ photo_id: p.id, kind: p.kind, sha256: randomBytes(32), object_key: `photos/${p.id}/${p.kind}`, ...o });
    it('a copy row needs an existing photo row and is made once per photo and kind', async () => {
      const p = await mk();
      await insert(c, 'sys_photo_copies', copy(p));
      expect((await errorOf(() => insert(c, 'sys_photo_copies', copy(p))))?.errno).toBe(DUP);
      expect((await errorOf(() => insert(c, 'sys_photo_copies', { photo_id: uuid(), kind: 'full', sha256: randomBytes(32), object_key: 'photos/x' })))?.errno).toBe(FK);
    });
    it('the hash must be 32 bytes, and a kind that no photo row has is refused by the foreign key', async () => {
      const p = await mk();
      expect((await errorOf(() => insert(c, 'sys_photo_copies', copy(p, { sha256: randomBytes(31) }))))?.errno).toBe(CHECK);
      expect((await errorOf(() => insert(c, 'sys_photo_copies', copy(p, { kind: 'medium' }))))?.errno).toBe(FK);
    });
    it('the job\'s "not copied yet" list holds the live photos with no copy row, oldest first, and skips removed ones', async () => {
      const design = uuid();
      const a = await mk({ design_id: design });
      const b = await mk({ design_id: design });
      const gone = await mk({ design_id: design, removed_at: '2026-10-15 12:00:00.000000', bytes: null });
      await insert(c, 'sys_photo_copies', copy(a));
      const [todo] = await c.query<any[]>(
        `SELECT p.id, p.kind FROM design_photos p LEFT JOIN sys_photo_copies k ON k.photo_id = p.id AND k.kind = p.kind
         WHERE p.design_id = ? AND k.photo_id IS NULL AND p.removed_at IS NULL ORDER BY p.created_at, p.id LIMIT 20`, [design]);
      expect(todo.map((r) => r.id)).toEqual([b.id]);
      expect(todo.map((r) => r.id)).not.toContain(gone.id);
    });
    it('a photo that has a copy row cannot be deleted (and no photo row is ever deleted)', async () => {
      const p = await mk();
      await insert(c, 'sys_photo_copies', copy(p));
      expect((await errorOf(() => c.query('DELETE FROM design_photos WHERE id = ? AND kind = ?', [p.id, p.kind])))?.errno).toBe(ER.ROW_IS_REFERENCED);
    });
  });

  it('one nightly job per name and day; one import batch per name', async () => {
    const job = `job_${u()}`;
    await insert(c, 'sys_job_runs', { job, run_date: '2026-10-16', status: 'ok' });
    expect((await errorOf(() => insert(c, 'sys_job_runs', { job, run_date: '2026-10-16', status: 'ok' })))?.errno).toBe(DUP);
    await insert(c, 'sys_job_runs', { job, run_date: '2026-10-17', status: 'ok' });
    const name = `batch-${u()}`;
    await insert(c, 'sys_import_batches', { id: uuid(), name });
    expect((await errorOf(() => insert(c, 'sys_import_batches', { id: uuid(), name })))?.errno).toBe(DUP);
  });
});
