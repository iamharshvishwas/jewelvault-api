import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runInvariants } from '../../scripts/invariants.mjs';
import { type ImportPack, runImport } from '../../scripts/import.mjs';
import { type Designs, addDesigns, billBody, item, piece, postBill, saved, setEstimate } from './x01-support';
import { numberOf, addOpening, billsOf, CUT_OVER, openingBillsOf, openingCounter, openingReceiptsOf, opened, opening, totalsOf } from './x12-support';
import { type EditWorld, addCustomer, editWorld, i10Holds, pendingAgrees, rows } from './x02-support';

// API27, the clause of T-C16 (and T-B21: IM4, IM5, I5, I10): AFTER AN IMPORT an X12 call and a create_bill keep I5 green, and I10 is true for a customer who was given both dues and an advance. The import is
// the real one (scripts/import.mjs, MB04) run on the world's database; X12 and create_bill are the real routes. The second test is the import as the other opinion on D15: the opening rows X12 writes are
// the rows the import writes, column for column, except for the ids, the number, the stamps, the person columns and the batch.

let w: EditWorld;
let d: Designs;
const ids: Record<string, string> = {};
let seed = 0;

const PACK: ImportPack = {
  batch: 'siddhi-opening-x12',
  source_file: 'dues.xlsx',
  cut_over: CUT_OVER,
  customers: [
    { ref: 'anita', name: 'Anita Sharma', mobile: '9876500001', customer_type: 'Retail', dues: '1500.00', advance: '400.00' }, // dues AND an advance: they net off, 1,100 outstanding
    { ref: 'bharat', name: 'Bharat Jewellers', mobile: '9876500002', customer_type: 'Wholesale', dues: '300.00', fine_due: '2.000', advance: '500.00', fine_advance: '3.000' }, // advances beyond the dues: 200 and 1.000 g stay
    { ref: 'chitra', name: 'Chitra Devi', mobile: '9876500003', customer_type: 'Retail', dues: '250.00' },
    { ref: 'dilip', name: 'Dilip Kumar', mobile: '9876500004', customer_type: 'Retail', advance: '90.00' },
    { ref: 'walk-in', name: 'walk-in', walkin: true, dues: '40.00' },
  ],
};

beforeAll(async () => {
  w = await editWorld('x12imp');
  d = await addDesigns(w);
  const report = await runImport(w.world.sql, PACK);
  expect(report.rejected).toEqual([]);
  expect(report.ok, JSON.stringify(report.invariants)).toBe(true);
  for (const name of ['Anita Sharma', 'Bharat Jewellers', 'Chitra Devi', 'Dilip Kumar']) ids[name.split(' ')[0].toLowerCase()] = String((await rows(w, 'SELECT id FROM customers WHERE name = ?', [name]))[0].id);
  await setEstimate(w, { prefix: 'IMP' });
  seed = Number((await rows(w, "SELECT seed_value FROM sys_counters WHERE series = 'opening'"))[0].seed_value);
}, 180_000);
afterAll(async () => {
  await w?.world.close();
}, 60_000);

/** The nightly check of the database half over the whole world: the rows that name an invariant. */
async function checkRows(): Promise<{ invariant: string; row_ref: string; detail: string }[]> {
  return (await runInvariants(w.world.sql, { sample: 10_000 })).rows;
}

describe('T-B21 + T-C16 (the clause of X12): after an import an X12 call and a create_bill keep I5 green, and I10 holds for a customer who was given both dues and an advance', () => {
  it('the import itself: four opening bills (the walk-in\'s among them), the counter seeded to 4, and the customers with dues and an advance netted off (I10 true) before any API call', async () => {
    expect(seed).toBe(4);
    expect(await openingCounter(w)).toBe(4);
    expect(await totalsOf(w, ids.anita)).toMatchObject({ billed: '1500.00', received: '400.00', outstanding: '1100.00', advance: '0.00' });
    expect(await totalsOf(w, ids.bharat)).toMatchObject({ outstanding: '0.00', advance: '200.00', fine_outstanding: '0.000', fine_advance: '1.000' });
    expect(await checkRows(), 'the books are clean straight after the import').toEqual([]);
  });

  it('X12 on an imported customer who has dues and an advance netted off: a new OB number continues after the imported ones (seed + 1), I5 stays green, and I10 holds for her', async () => {
    const r = await opened(await addOpening(w, 'owner', ids.anita, opening({ dues: '100.00' })));
    expect(r.bill?.bill_no).toBe(`OB-${String(seed + 1).padStart(4, '0')}`);
    expect(await openingCounter(w)).toBe(seed + 1);
    expect(await totalsOf(w, ids.anita)).toMatchObject({ billed: '1600.00', outstanding: '1200.00', advance: '0.00' });
    await pendingAgrees(w, ids.anita);
    await i10Holds(w, ids.anita);
    expect((await checkRows()).filter((x) => x.invariant === 'I5'), 'I5 is green with an imported series and a number from the function').toEqual([]);
  });

  it('X12 for a customer created after the import with both dues and an advance (the figures of the T-C16 sentence): the next number again, both netted, I5 and I10 green', async () => {
    const later = await addCustomer(w);
    const r = await opened(await addOpening(w, 'owner', later, opening({ dues: '800.00', advance: '300.00', fine_due: '1.500', fine_advance: '0.500' })));
    expect(r.bill?.bill_no).toBe(`OB-${String(seed + 2).padStart(4, '0')}`);
    expect(await totalsOf(w, later)).toMatchObject({ outstanding: '500.00', advance: '0.00', fine_outstanding: '1.000', fine_advance: '0.000' });
    await i10Holds(w, later);
    expect((await checkRows()).filter((x) => x.invariant === 'I5')).toEqual([]);
  });

  it('create_bill after the import: the customer with an advance (Bharat, 200 and 1.000 g held) is billed 1,000; the advance is applied by the shared rebalance, a customer with open dues (Anita) is billed too; bill numbers are contiguous and I5 and I10 stay green for the whole world', async () => {
    const p1 = await piece(w, d.gold24pp, { retail: '1000.00' });
    const bharat = await saved(await postBill(w, 'owner', billBody(ids.bharat, 'Retail', [item(p1, { metal_rate: '1000.00' })])));
    expect(bharat.bill.bill_no).toBe(`IMP-2026-0001`);
    expect(bharat.advance_applied).toBe('200.00');
    expect(await totalsOf(w, ids.bharat)).toMatchObject({ outstanding: '800.00', advance: '0.00', fine_advance: '1.000' });
    const p2 = await piece(w, d.gold24pp, { retail: '500.00' });
    const anita = await saved(await postBill(w, 'owner', billBody(ids.anita, 'Retail', [item(p2, { metal_rate: '500.00' })])));
    expect(anita.bill.bill_no).toBe('IMP-2026-0002');
    expect(anita.advance_applied).toBe('0.00');
    expect(await totalsOf(w, ids.anita)).toMatchObject({ outstanding: '1700.00', advance: '0.00' });
    for (const c of [ids.anita, ids.bharat]) {
      await pendingAgrees(w, c);
      await i10Holds(w, c);
    }
    // an X12 call AFTER the create_bill: the opening series and the bill series are separate and both are contiguous
    const again = await opened(await addOpening(w, 'owner', ids.chitra, opening({ dues: '10.00', advance: '4.00' })));
    expect(numberOf(String(again.bill?.bill_no))).toBe(seed + 3);
    const all = await checkRows();
    expect(all, JSON.stringify(all)).toEqual([]);
  });

  it('the opening bills the functions made are the ones without an import batch, and I5 counts only them: three from X12, contiguous after the seed', async () => {
    const made = await rows(w, "SELECT bill_no FROM bills WHERE doc_type = 'opening_balance' AND import_batch_id IS NULL ORDER BY bill_no");
    expect(made.map((b) => numberOf(String(b.bill_no)))).toEqual([seed + 1, seed + 2, seed + 3]);
    const imported = await rows(w, "SELECT bill_no FROM bills WHERE doc_type = 'opening_balance' AND import_batch_id IS NOT NULL ORDER BY bill_no");
    expect(imported.map((b) => numberOf(String(b.bill_no)))).toEqual([1, 2, 3, 4]);
  });
});

describe('T-B21 (IM4, D15) X12 writes the rows the import writes', () => {
  it('the opening bill and the two opening receipts of an X12 call equal those of the import for the same figures, column for column, except ids, number, stamps, person columns, request and batch', async () => {
    const later = await addCustomer(w, { customer_type: 'Wholesale' });
    await opened(await addOpening(w, 'owner', later, opening({ dues: '300.00', fine_due: '2.000', advance: '500.00', fine_advance: '3.000' })));
    const strip = (row: Record<string, unknown>, drop: string[]) => Object.fromEntries(Object.entries(row).filter(([k]) => !drop.includes(k)));
    const BILL_DROP = ['id', 'bill_no', 'customer_id', 'created_at', 'updated_at', 'created_by', 'updated_by', 'request_id', 'import_batch_id'];
    const RECEIPT_DROP = ['id', 'customer_id', 'created_at', 'updated_at', 'created_by', 'updated_by'];
    const imported = (await openingBillsOf(w, ids.bharat))[0];
    const byFunction = (await openingBillsOf(w, later))[0];
    expect(strip(byFunction, BILL_DROP)).toEqual(strip(imported, BILL_DROP));
    const importedReceipts = await openingReceiptsOf(w, ids.bharat);
    const functionReceipts = await openingReceiptsOf(w, later);
    expect(importedReceipts).toHaveLength(2);
    expect(functionReceipts.map((r) => strip(r, RECEIPT_DROP))).toEqual(importedReceipts.map((r) => strip(r, RECEIPT_DROP)));
    // the same allocations too: the shared rebalance nets 300 of the money and 2.000 g of the silver
    const alloc = async (customer: string) =>
      (await rows(w, "SELECT a.amount, a.fine_grams, a.released_at FROM receipt_allocations a JOIN bills b ON b.id = a.bill_id WHERE a.customer_id = ? AND b.doc_type = 'opening_balance' ORDER BY a.fine_grams, a.amount", [customer])).map((x) => [x.amount, x.fine_grams, x.released_at]);
    expect(await alloc(later)).toEqual(await alloc(ids.bharat));
    expect(await billsOf(w, later)).toHaveLength(1);
  });
});
