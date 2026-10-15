import { randomUUID } from 'node:crypto';
import type { Connection } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appConn, dropDb, ER, rng, runTx, type DbError } from '../helpers';
import { formatGrams, formatRupees, parseGrams, parseRupees, priceBill } from '../../oracle/pricing';
import { runInvariants } from '../../scripts/invariants.mjs';
import { V, insert, migratedDb } from './support';

// The spike's lock-order workload (tests/e-lock-order) on the REAL schema: foreign keys, composite keys, CHECK constraints and indexes
// as they will run on Hostinger. Prices come from the integer pricing.ts, so every CHECK (item_total = sum, whole-rupee grand total,
// round-off within 0.50, By Weight quantity 1) is also tested against the rules of section 8.
// Lock order (X0): idempotency claim, customer row, pieces by id ascending, number counter LAST. No retries: every deadlock is counted.

let db: string;
let admin: Connection;
let customers: string[];
let skus: { id: string; design_no: string; sku_no: string; category: string; gross: string; net: string; labour: string; piroi: string }[];

beforeAll(async () => {
  ({ db, c: admin } = await migratedDb('s8_workload'));
  const [cats] = await admin.query<any[]>('SELECT id, name FROM categories ORDER BY name LIMIT 1');
  const design = (await insert(admin, 'designs', V.design(cats[0].id))) as { id: string; design_no: string };
  customers = [];
  for (let i = 0; i < 5; i++) customers.push(((await insert(admin, 'customers', V.customer({ name: `Customer ${i}` }))) as { id: string }).id);
  skus = [];
  for (let i = 0; i < 14; i++) {
    const s = V.sku(design.id, { gross_weight: `${12 + i}.500`, customer_net_weight: `${10 + i}.250`, labour_retail: '350.00', piroi: '2.15' });
    await insert(admin, 'skus', s);
    skus.push({ id: s.id, design_no: design.design_no, sku_no: s.sku_no, category: cats[0].name, gross: s.gross_weight, net: s.customer_net_weight, labour: '350.00', piroi: '2.15' });
  }
});
afterAll(async () => {
  await admin.end();
  await dropDb(db);
});

class Business extends Error {}
const toPaise = (s: string) => BigInt(parseRupees(s));
const fromPaise = (p: bigint) => formatRupees(Number(p));
const HASH = 'a'.repeat(64);

async function claim(c: Connection, fn: string) {
  await c.query('INSERT INTO sys_idempotency (request_id, fn, actor, args_hash) VALUES (?, ?, ?, ?)', [randomUUID(), fn, randomUUID(), HASH]);
}
const lockCustomer = (c: Connection, id: string) => c.query('SELECT id FROM customers WHERE id = ? FOR UPDATE', [id]);
async function lockPieces(c: Connection, ids: string[]) {
  const sorted = [...ids].sort();
  const [rows] = await c.query<any[]>(`SELECT id, status FROM skus WHERE id IN (${sorted.map(() => '?').join(',')}) ORDER BY id FOR UPDATE`, sorted);
  return rows;
}
async function nextNumber(c: Connection, series: string) {
  await c.query('INSERT INTO sys_counters (series, last_value) VALUES (?, LAST_INSERT_ID(1)) ON DUPLICATE KEY UPDATE last_value = LAST_INSERT_ID(last_value + 1)', [series]);
  const [[r]] = await c.query<any[][]>('SELECT LAST_INSERT_ID() AS n');
  return Number((r as any).n);
}

async function rebalance(c: Connection, customerId: string) {
  const [bills] = await c.query<any[]>(
    `SELECT b.id, b.grand_total - COALESCE((SELECT SUM(a.amount) FROM receipt_allocations a WHERE a.bill_id = b.id AND a.released_at IS NULL), 0) AS pending
     FROM bills b WHERE b.customer_id = ? AND b.status = 'active' HAVING pending > 0 ORDER BY b.bill_date, b.created_at, b.id`, [customerId]);
  if (!bills.length) return;
  const [receipts] = await c.query<any[]>(
    `SELECT r.id, r.amount - COALESCE((SELECT SUM(a.amount) FROM receipt_allocations a WHERE a.receipt_id = r.id AND a.released_at IS NULL), 0) AS remaining
     FROM receipts r WHERE r.customer_id = ? AND r.status = 'active' AND r.kind = 'money' HAVING remaining > 0 ORDER BY r.paid_on, r.created_at, r.id`, [customerId]);
  const pend = bills.map((b) => toPaise(b.pending));
  const rem = receipts.map((r) => toPaise(r.remaining));
  let bi = 0;
  let ri = 0;
  while (bi < bills.length && ri < receipts.length) {
    const take = pend[bi] < rem[ri] ? pend[bi] : rem[ri];
    await c.query('INSERT INTO receipt_allocations (id, receipt_id, bill_id, customer_id, amount) VALUES (?, ?, ?, ?, ?)', [randomUUID(), receipts[ri].id, bills[bi].id, customerId, fromPaise(take)]);
    pend[bi] -= take;
    rem[ri] -= take;
    if (pend[bi] === 0n) bi++;
    if (rem[ri] === 0n) ri++;
  }
}

async function writeBill(c: Connection, customerId: string, pieceIds: string[], extra: Record<string, unknown> = {}) {
  const pieces = pieceIds.map((id) => skus.find((s) => s.id === id)!);
  const priced = priceBill({
    saleType: 'Retail', roundOffSetting: true,
    lines: pieces.map((p) => ({
      material: 'Gold', sellingMethod: 'By Weight', customerNetWeightMg: parseGrams(p.net), metalRatePaise: 692000, labourRatePaise: parseRupees(p.labour), piroiPaise: parseRupees(p.piroi),
    })),
  });
  const n = await nextNumber(c, 'bill:JV:2026'); // counter last
  const billId = randomUUID();
  await insert(c, 'bills', V.bill(customerId, {
    id: billId, bill_no: `JV-2026-${String(n).padStart(4, '0')}`, subtotal: formatRupees(priced.subtotalPaise), grand_total: formatRupees(priced.grandTotalPaise),
    round_off: formatRupees(priced.roundOffPaise), fine_weight_due: formatGrams(priced.fineWeightDueMg), ...extra,
  }));
  for (const [i, p] of pieces.entries()) {
    const l = priced.lines[i];
    await insert(c, 'bill_items', V.billItem(billId, p.id, {
      line_no: i + 1, design_no: p.design_no, sku_no: p.sku_no, category: p.category, gross_weight: p.gross, customer_net_weight: p.net,
      metal_rate: '6920.00', labour_rate: p.labour, labour_amount: formatRupees(l.labourAmountPaise), piroi: formatRupees(l.piroiPaise), other_charges: '0.00',
      metal_amount: formatRupees(l.metalAmountPaise), fine_weight_due: formatGrams(l.fineWeightDueMg), item_total: formatRupees(l.itemTotalPaise), list_metal_rate: '6920.00', list_labour_rate: p.labour,
    }));
  }
  const [res]: any = await c.query(
    `UPDATE skus SET status = 'Sold', sold_bill_id = ? WHERE id IN (${pieceIds.map(() => '?').join(',')}) AND status = 'In Stock' AND sold_bill_id IS NULL`, [billId, ...pieceIds]);
  if (res.affectedRows !== pieceIds.length) throw new Error('piece update count mismatch');
  return billId;
}

const createBill = async (c: Connection, customerId: string, pieceIds: string[]) => {
  await claim(c, 'create_bill');
  await lockCustomer(c, customerId);
  const rows = await lockPieces(c, pieceIds);
  if (rows.length !== pieceIds.length || rows.some((r) => r.status !== 'In Stock')) throw new Business('JV_PIECE_UNAVAILABLE');
  await writeBill(c, customerId, pieceIds);
  await rebalance(c, customerId);
};
const recordPayment = async (c: Connection, customerId: string, amount: string) => {
  await claim(c, 'record_payment');
  await lockCustomer(c, customerId);
  await insert(c, 'receipts', V.receipt(customerId, { amount }));
  await rebalance(c, customerId);
};
async function cancelInside(c: Connection, billId: string, reason: string) {
  const [bills] = await c.query<any[]>('SELECT id, status, customer_id FROM bills WHERE id = ? FOR UPDATE', [billId]);
  if (!bills.length || bills[0].status !== 'active') throw new Business('JV_BILL_CANCELLED');
  const [items] = await c.query<any[]>('SELECT sku_id FROM bill_items WHERE bill_id = ?', [billId]);
  const ids: string[] = items.map((i) => i.sku_id);
  if (ids.length) {
    await lockPieces(c, ids);
    await c.query(`UPDATE skus SET status = 'In Stock', sold_bill_id = NULL WHERE id IN (${ids.map(() => '?').join(',')}) AND sold_bill_id = ?`, [...ids, billId]);
  }
  await c.query('UPDATE receipt_allocations SET released_at = CURRENT_TIMESTAMP(6) WHERE bill_id = ? AND released_at IS NULL', [billId]);
  await c.query("UPDATE bills SET status = 'cancelled', cancel_reason = ?, cancelled_at = CURRENT_TIMESTAMP(6), cancelled_on = UTC_DATE(), cancelled_by = ? WHERE id = ?", [reason, randomUUID(), billId]);
  return ids;
}
const cancelBill = async (c: Connection, billId: string) => {
  await claim(c, 'cancel_bill');
  const [pre] = await c.query<any[]>('SELECT customer_id FROM bills WHERE id = ?', [billId]);
  if (!pre.length) throw new Business('JV_NOT_FOUND');
  await lockCustomer(c, pre[0].customer_id); // X0 item 3: find the customer unlocked, lock it, then re-read the bill FOR UPDATE
  await cancelInside(c, billId, 'customer returned the goods');
  await rebalance(c, pre[0].customer_id);
};
const reissueBill = async (c: Connection, billId: string, newPieces: string[]) => {
  await claim(c, 'reissue_bill');
  const [pre] = await c.query<any[]>('SELECT customer_id FROM bills WHERE id = ?', [billId]);
  if (!pre.length) throw new Business('JV_NOT_FOUND');
  const customerId = pre[0].customer_id as string;
  await lockCustomer(c, customerId);
  const [bills] = await c.query<any[]>('SELECT status FROM bills WHERE id = ? FOR UPDATE', [billId]);
  if (!bills.length || bills[0].status !== 'active') throw new Business('JV_BILL_CANCELLED');
  const [oldItems] = await c.query<any[]>('SELECT sku_id FROM bill_items WHERE bill_id = ?', [billId]);
  const oldIds: string[] = oldItems.map((i) => i.sku_id);
  const all = [...new Set([...oldIds, ...newPieces])];
  const locked = await lockPieces(c, all); // old and new pieces together, ascending
  if (locked.length !== all.length || newPieces.some((id) => !oldIds.includes(id) && locked.find((r) => r.id === id)?.status !== 'In Stock')) throw new Business('JV_PIECE_UNAVAILABLE');
  await cancelInside(c, billId, 'corrected bill');
  await writeBill(c, customerId, newPieces, { reissue_of: billId });
  await rebalance(c, customerId);
};
const addOpeningBalance = async (c: Connection, customerId: string, dues: string) => {
  await claim(c, 'add_opening_balance');
  await lockCustomer(c, customerId);
  const n = await nextNumber(c, 'opening');
  await insert(c, 'bills', V.bill(customerId, { bill_no: `OB-${String(n).padStart(4, '0')}`, doc_type: 'opening_balance', subtotal: '0.00', grand_total: dues }));
  await rebalance(c, customerId);
};

interface Stats { ok: number; business: number; deadlocks: number; timeouts: number; other: string[] }
async function workload(seed: number): Promise<Stats> {
  const stats: Stats = { ok: 0, business: 0, deadlocks: 0, timeouts: 0, other: [] };
  const conns = await Promise.all(Array.from({ length: 8 }, () => appConn(db)));
  await Promise.all(conns.map(async (c, w) => {
    const rand = rng(seed * 1000 + w);
    const pick = <T,>(xs: T[]) => xs[Math.floor(rand() * xs.length)];
    for (let i = 0; i < 120; i++) {
      const roll = rand();
      const customerId = pick(customers);
      const pieceIds = [...new Set(Array.from({ length: 1 + Math.floor(rand() * 3) }, () => pick(skus).id))];
      let body: (() => Promise<unknown>) | null = null;
      if (roll < 0.4) body = () => createBill(c, customerId, pieceIds);
      else if (roll < 0.58) body = () => recordPayment(c, customerId, fromPaise(BigInt(50000 + Math.floor(rand() * 400000))));
      else if (roll < 0.78) {
        const [rows] = await c.query<any[]>("SELECT id FROM bills WHERE status = 'active' ORDER BY RAND() LIMIT 1");
        if (rows.length) body = () => cancelBill(c, rows[0].id);
      } else if (roll < 0.92) {
        const [rows] = await c.query<any[]>("SELECT id FROM bills WHERE status = 'active' AND doc_type = 'estimate' ORDER BY RAND() LIMIT 1");
        if (rows.length) body = () => reissueBill(c, rows[0].id, pieceIds);
      } else body = () => addOpeningBalance(c, customerId, fromPaise(BigInt(100000 + Math.floor(rand() * 900000))));
      if (!body) continue;
      try {
        await runTx(c, body);
        stats.ok++;
      } catch (e) {
        if (e instanceof Business) stats.business++;
        else {
          const err = e as DbError;
          if (err.errno === ER.DEADLOCK) stats.deadlocks++;
          else if (err.errno === ER.LOCK_WAIT_TIMEOUT) stats.timeouts++;
          else stats.other.push(`${err.errno} ${err.message}`);
        }
      }
    }
  }));
  await Promise.all(conns.map((x) => x.end()));
  return stats;
}

/** The real thing: the SQL half of spec section 12 (scripts/invariants.mjs), one consistent snapshot. */
async function invariants(): Promise<string[]> {
  const r = await runInvariants(admin);
  return r.rows.map((x) => `${x.invariant}: ${x.row_ref} ${x.detail}`);
}

describe('the lock-order workload on the real schema', () => {
  it.each([1, 2, 3])('seed %i: 8 workers x 120 operations, no retry: 0 deadlocks, 0 lock timeouts, no constraint errors, invariants hold', async (seed) => {
    const stats = await workload(seed);
    console.log(`[s8] seed ${seed}: committed ${stats.ok}, business refusals ${stats.business}, deadlocks ${stats.deadlocks}, lock timeouts ${stats.timeouts}, other ${stats.other.length}`);
    expect(stats.other).toEqual([]);
    expect(stats.deadlocks).toBe(0);
    expect(stats.timeouts).toBe(0);
    expect(stats.ok).toBeGreaterThan(300);
    expect(await invariants()).toEqual([]);
  }, 180000);

  it('the invariant checks have teeth: damaged data is reported (mutation test, T-B18 in miniature)', async () => {
    const [r] = await admin.query<any[]>("SELECT s.id FROM skus s JOIN bill_items i ON i.sku_id = s.id JOIN bills b ON b.id = i.bill_id AND b.status = 'active' WHERE s.status = 'Sold' LIMIT 1");
    expect(r.length, 'the workload should have left at least one piece on an active bill').toBe(1);
    await admin.query("UPDATE skus SET status = 'In Stock', sold_bill_id = NULL WHERE id = ?", [r[0].id]);
    expect((await invariants()).join(' ')).toContain('I1');
    await admin.query("UPDATE skus SET status = 'Sold', sold_bill_id = (SELECT i.bill_id FROM bill_items i JOIN bills b ON b.id = i.bill_id AND b.status = 'active' WHERE i.sku_id = ? LIMIT 1) WHERE id = ?", [r[0].id, r[0].id]);
    expect(await invariants()).toEqual([]);
  });
});
