import type { Connection } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dropDb } from '../helpers';
import { ledgerWorld, migratedDb } from './support';

// Spec section 11: the four derived views, checked on a fixed data set whose figures were worked out by hand (T-B15, T-B05, T-B10, T-B14, T-B17, T-B20, T-B21, T-B25).
// Live allocation = released_at is NULL and the receipt is active. A voided receipt's allocation never counts, even if it was never released.

let db: string;
let c: Connection;
let w: Awaited<ReturnType<typeof ledgerWorld>>;
beforeAll(async () => {
  ({ db, c } = await migratedDb('s9_views'));
  w = await ledgerWorld(c);
});
afterAll(async () => {
  await c.end();
  await dropDb(db);
});

describe('V1 bill_summary', () => {
  const byNo = async () => {
    const [r] = await c.query<any[]>('SELECT * FROM bill_summary WHERE customer_id = ?', [w.c1.id]);
    return Object.fromEntries(r.map((x) => [x.bill_no, x]));
  };
  it('one row per bill, with the columns of V1', async () => {
    const [r] = await c.query<any[]>('SELECT * FROM bill_summary LIMIT 1');
    expect(Object.keys(r[0])).toEqual([
      'id', 'bill_no', 'customer_id', 'bill_date', 'doc_type', 'sale_type', 'status', 'reissue_of', 'grand_total', 'received', 'pending',
      'fine_due', 'fine_settled', 'fine_pending', 'payment_status', 'item_count', 'created_at', 'updated_at',
    ]);
    expect(Object.keys(await byNo())).toHaveLength(4);
  });
  it('a part-paid bill: received 699.50 (99.50 + 600.00), pending 300.50, Partial, two lines', async () => {
    const b = (await byNo())['JV-2026-0001'];
    expect([b.grand_total, b.received, b.pending, b.payment_status, Number(b.item_count)]).toEqual(['1000.00', '699.50', '300.50', 'Partial', 2]);
    expect([b.fine_due, b.fine_settled, b.fine_pending]).toEqual(['0.000', '0.000', '0.000']);
  });
  it('silver: 10 g due, 5 g settled (2 in silver, 3 settled in cash), 5 g pending, Partial; a voided receipt\'s unreleased allocation of 50.00 is ignored', async () => {
    const b = (await byNo())['JV-2026-0003'];
    expect([b.received, b.pending, b.fine_due, b.fine_settled, b.fine_pending, b.payment_status]).toEqual(['0.00', '2000.00', '10.000', '5.000', '5.000', 'Partial']);
  });
  it('a cancelled bill shows 0 received, 0 pending, 0 fine and the status Cancelled, although its released allocation exists', async () => {
    const b = (await byNo())['JV-2026-0002'];
    expect([b.received, b.pending, b.fine_settled, b.fine_pending, b.payment_status, b.status]).toEqual(['0.00', '0.00', '0.000', '0.000', 'Cancelled', 'cancelled']);
  });
  it('an opening bill paid in money and silver is Paid and has no lines', async () => {
    const b = (await byNo())['OB-0001'];
    expect([b.received, b.pending, b.fine_pending, b.payment_status, Number(b.item_count), b.doc_type]).toEqual(['300.50', '0.00', '0.000', 'Paid', 0, 'opening_balance']);
  });
  it('an unpaid bill is Pending', async () => {
    const [r] = await c.query<any[]>("SELECT payment_status FROM bill_summary WHERE customer_id = ? AND grand_total = 1000", [w.c2.id]);
    expect(r).toHaveLength(0); // customer 2 has no bill at all
    await c.query('START TRANSACTION'); // rolled back below: customer 2 must stay empty for the V2 tests
    try {
      await c.query("INSERT INTO bills (id, bill_no, customer_id, bill_date, sale_type, subtotal, grand_total) VALUES (UUID(), 'JV-2026-0900', ?, '2026-10-14', 'Retail', 700, 700)", [w.c2.id]);
      const [p] = await c.query<any[]>("SELECT payment_status, pending, received FROM bill_summary WHERE bill_no = 'JV-2026-0900'");
      expect([p[0].payment_status, p[0].pending, p[0].received]).toEqual(['Pending', '700.00', '0.00']);
    } finally {
      await c.query('ROLLBACK');
    }
  });
  it('is a SQL SECURITY INVOKER view', async () => {
    const [r] = await c.query<any[]>("SELECT SECURITY_TYPE s FROM information_schema.VIEWS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'bill_summary'");
    expect(r[0].s).toBe('INVOKER');
  });
});

describe('V2 customer_balances', () => {
  const row = async (id: string) => ((await c.query<any[]>('SELECT * FROM customer_balances WHERE id = ?', [id]))[0] as any[])[0];
  it('rupees: billed 3300.50, purchases 3000.00, received 1200.00, refunded 50.00, allocated 1000.00', async () => {
    const r = await row(w.c1.id);
    expect([r.billed, r.total_purchases, r.received, r.refunded, r.allocated]).toEqual(['3300.50', '3000.00', '1200.00', '50.00', '1000.00']);
  });
  it('outstanding 2300.50, advance 150.00, balance 2150.50 and balance = outstanding - advance', async () => {
    const r = await row(w.c1.id);
    expect([r.outstanding, r.advance, r.balance]).toEqual(['2300.50', '150.00', '2150.50']);
    expect(Number(r.balance)).toBeCloseTo(Number(r.outstanding) - Number(r.advance), 2);
  });
  it('silver: billed 12 g, received 7 g (4 silver + 3 settled in cash), allocated 7 g, outstanding 5 g, advance 0, balance 5 g', async () => {
    const r = await row(w.c1.id);
    expect([r.fine_billed, r.fine_received, r.fine_allocated, r.fine_outstanding, r.fine_advance, r.fine_balance]).toEqual(['12.000', '7.000', '7.000', '5.000', '0.000', '5.000']);
  });
  it('last purchase is the newest bill that is active and not an opening bill', async () => {
    expect((await row(w.c1.id)).last_purchase).toBe('2026-10-05');
  });
  it('every customer has a row, the walk-in too; one with no events has zeros and no last purchase', async () => {
    const r = await row(w.c2.id);
    expect([r.billed, r.received, r.refunded, r.allocated, r.outstanding, r.advance, r.balance, r.fine_balance]).toEqual(['0.00', '0.00', '0.00', '0.00', '0.00', '0.00', '0.00', '0.000']);
    expect(r.last_purchase).toBeNull();
    const [n] = await c.query<any[]>('SELECT (SELECT COUNT(*) FROM customer_balances) a, (SELECT COUNT(*) FROM customers) b');
    expect(Number(n[0].a)).toBe(Number(n[0].b));
    expect(await row('00000000-0000-4000-8000-000000000001')).toBeTruthy();
  });
  it('is keyed by the customer id and carries the customer row\'s updated_at', async () => {
    const r = await row(w.c1.id);
    const [cu] = await c.query<any[]>('SELECT updated_at FROM customers WHERE id = ?', [w.c1.id]);
    expect(r.id).toBe(w.c1.id);
    expect(r.updated_at).toBe(cu[0].updated_at);
  });
});

describe('V3 customer_ledger', () => {
  const rows = async (id: string) => ((await c.query<any[]>('SELECT * FROM customer_ledger WHERE customer_id = ? ORDER BY entry_date, entry_at, kind_rank, id', [id]))[0]) as any[];
  it('16 events: 3 invoices + 1 opening, 1 cancellation, 5 payments (one an opening advance), 2 fine, 2 refunds, 2 voids', async () => {
    const r = await rows(w.c1.id);
    const count = (k: string) => r.filter((x) => x.kind === k).length;
    expect(r).toHaveLength(16);
    expect([count('Invoice'), count('Opening'), count('Cancellation'), count('Payment'), count('Opening advance'), count('Fine'), count('Refund'), count('Void')]).toEqual([3, 1, 1, 4, 1, 2, 2, 2]);
  });
  it('the running balance is the sum of debit minus credit in the order key, and ends at V2\'s balance and fine_balance (I4)', async () => {
    const r = await rows(w.c1.id);
    let bal = 0;
    let fine = 0;
    for (const x of r) {
      bal = Math.round((bal + Number(x.debit) - Number(x.credit)) * 100) / 100;
      fine = Math.round((fine + Number(x.fine_debit) - Number(x.fine_credit)) * 1000) / 1000;
      expect(Number(x.balance), `${x.kind} ${x.entry_date}`).toBeCloseTo(bal, 2);
      expect(Number(x.fine_balance), `${x.kind} ${x.entry_date}`).toBeCloseTo(fine, 3);
    }
    const [v2] = await c.query<any[]>('SELECT balance, fine_balance FROM customer_balances WHERE id = ?', [w.c1.id]);
    expect(r[r.length - 1].balance).toBe(v2[0].balance);
    expect(r[r.length - 1].fine_balance).toBe(v2[0].fine_balance);
  });
  it('the order key is (entry_date, entry_at, kind_rank, id): a cancelled bill is dated the day it was cancelled, a void the day it was voided', async () => {
    const r = await rows(w.c1.id);
    const cancel = r.find((x) => x.kind === 'Cancellation');
    expect([cancel.entry_date, cancel.credit, cancel.fine_credit]).toEqual(['2026-10-04', '500.00', '0.000']);
    const voids = r.filter((x) => x.kind === 'Void').map((x) => x.entry_date);
    expect(voids).toEqual(['2026-10-10', '2026-10-13']); // the second was voided at 01:30 IST on the 13th (20:00 UTC on the 12th)
    const sorted = [...r].sort((p, q) => (p.entry_date + p.entry_at + p.kind_rank).localeCompare(q.entry_date + q.entry_at + q.kind_rank));
    expect(r.map((x) => x.kind_rank)).toEqual(sorted.map((x) => x.kind_rank));
  });
  it('a void is the exact reverse of its own row: a voided payment of 150.00 comes back as a debit, a voided refund of 25.00 as a credit', async () => {
    const r = await rows(w.c1.id);
    const pay = r.find((x) => x.kind === 'Payment' && x.credit === '150.00');
    const voidPay = r.find((x) => x.kind === 'Void' && x.debit === '150.00');
    expect(pay && voidPay).toBeTruthy();
    const ref = r.find((x) => x.kind === 'Refund' && x.debit === '25.00');
    const voidRef = r.find((x) => x.kind === 'Void' && x.credit === '25.00');
    expect(ref && voidRef).toBeTruthy();
  });
  it('silver received has no rupee entry; settled in cash it says so (rate and amount)', async () => {
    const fine = (await rows(w.c1.id)).filter((x) => x.kind === 'Fine');
    expect(fine.map((x) => [x.debit, x.credit, x.fine_credit])).toEqual([['0.00', '0.00', '4.000'], ['0.00', '0.00', '3.000']]);
    expect(fine[1].description).toContain('90.00');
    expect(fine[1].description).toContain('270.00');
  });
  it('a filter on one customer gives the same running balances as the whole view (the sums are partitioned by customer)', async () => {
    const [all] = await c.query<any[]>('SELECT id, balance FROM customer_ledger');
    const [one] = await c.query<any[]>('SELECT id, balance FROM customer_ledger WHERE customer_id = ?', [w.c1.id]);
    const byId = new Map(all.map((x) => [x.id + x.balance, true]));
    for (const x of one) expect(byId.has(x.id + x.balance)).toBe(true);
  });
  it('a customer with no events has no ledger rows', async () => {
    expect(await rows(w.c2.id)).toHaveLength(0);
  });
});

describe('V4 daily_totals', () => {
  const day = async () => {
    const [r] = await c.query<any[]>('SELECT business_date d, mode, money_in i, money_out o, net n FROM daily_totals ORDER BY business_date, mode');
    return r.map((x) => [x.d, x.mode, x.i, x.o, x.n]);
  };
  it('cash book by business date and mode: receipts and silver settled in cash in, refunds out, a void reverses on the day it is done', async () => {
    expect(await day()).toEqual([
      ['2026-10-02', 'Cash', '400.00', '0.00', '400.00'],
      ['2026-10-03', 'Cash', '100.00', '0.00', '100.00'],
      ['2026-10-06', 'UPI', '600.00', '0.00', '600.00'],
      ['2026-10-08', 'Cash', '270.00', '0.00', '270.00'], // silver settled in cash is money in
      ['2026-10-09', 'Cash', '150.00', '0.00', '150.00'], // a payment that was voided later still shows on its own day
      ['2026-10-10', 'Cash', '0.00', '150.00', '-150.00'], // ... and is reversed on the day of the void
      ['2026-10-11', 'Cash', '0.00', '50.00', '-50.00'],
      ['2026-10-12', 'UPI', '0.00', '25.00', '-25.00'],
      ['2026-10-13', 'UPI', '25.00', '0.00', '25.00'], // a voided refund comes back as money in, on the Indian date of the void
    ]);
  });
  it('an opening advance is not money received today and is left out', async () => {
    const [r] = await c.query<any[]>("SELECT COUNT(*) n FROM daily_totals WHERE mode = 'Other'");
    expect(Number(r[0].n)).toBe(0);
  });
  it('the sums over all days tie out with the receipts (I13): Cash 720.00, UPI 600.00', async () => {
    const [r] = await c.query<any[]>('SELECT mode, SUM(net) n FROM daily_totals GROUP BY mode ORDER BY mode');
    expect(r.map((x) => [x.mode, x.n])).toEqual([['Cash', '720.00'], ['UPI', '600.00']]);
  });
});
