import { randomUUID } from 'node:crypto';
import type { Connection } from 'mysql2/promise';
import { appConn, ER, rng, runTx, type DbError } from './helpers';

/**
 * A small model of the spec's money functions (X1 create_bill, X2 record_payment, X5 cancel_bill, X10 reissue_bill,
 * X12 add_opening_balance) on MariaDB, in the lock order of X0:
 *   1 idempotency insert   2 customer row FOR UPDATE   3 pieces by id ascending FOR UPDATE   4 number counter LAST.
 * `order: 'bad'` flips steps 2 and 4 on purpose, as a negative control: the harness must then see deadlocks.
 */

export const SIM_DDL = [
  `CREATE TABLE customers (id UUID NOT NULL PRIMARY KEY, name VARCHAR(60) NOT NULL) ENGINE=InnoDB`,
  `CREATE TABLE skus (
     id UUID NOT NULL PRIMARY KEY, status VARCHAR(12) NOT NULL DEFAULT 'In Stock', sold_bill_id BIGINT NULL,
     price DECIMAL(14,2) NOT NULL,
     CONSTRAINT chk_sold CHECK ((status = 'Sold') = (sold_bill_id IS NOT NULL))
   ) ENGINE=InnoDB`,
  `CREATE TABLE counters (series VARCHAR(40) PRIMARY KEY, last_value BIGINT NOT NULL) ENGINE=InnoDB`,
  `CREATE TABLE idempotency (request_id UUID NOT NULL PRIMARY KEY, fn VARCHAR(40) NOT NULL) ENGINE=InnoDB`,
  `CREATE TABLE bills (
     id BIGINT AUTO_INCREMENT PRIMARY KEY, bill_no VARCHAR(30) NOT NULL UNIQUE, customer_id UUID NOT NULL,
     doc_type VARCHAR(20) NOT NULL DEFAULT 'estimate', status VARCHAR(12) NOT NULL DEFAULT 'active',
     grand_total DECIMAL(14,2) NOT NULL,
     CONSTRAINT fk_bill_customer FOREIGN KEY (customer_id) REFERENCES customers (id) ON DELETE RESTRICT
   ) ENGINE=InnoDB`,
  `CREATE TABLE bill_items (
     id BIGINT AUTO_INCREMENT PRIMARY KEY, bill_id BIGINT NOT NULL, sku_id UUID NOT NULL, is_live TINYINT(1) NOT NULL DEFAULT 1,
     live_sku UUID AS (IF(is_live = 1, sku_id, NULL)) PERSISTENT,
     ${process.env.JV_LIVE_UNIQUE ? 'UNIQUE KEY uq_live_sku (live_sku),' : 'KEY ix_live_sku (live_sku),'}
     CONSTRAINT fk_item_bill FOREIGN KEY (bill_id) REFERENCES bills (id) ON DELETE RESTRICT,
     CONSTRAINT fk_item_sku FOREIGN KEY (sku_id) REFERENCES skus (id) ON DELETE RESTRICT
   ) ENGINE=InnoDB`,
  `CREATE TABLE receipts (
     id BIGINT AUTO_INCREMENT PRIMARY KEY, customer_id UUID NOT NULL, amount DECIMAL(14,2) NOT NULL,
     CONSTRAINT chk_receipt_amount CHECK (amount > 0),
     CONSTRAINT fk_receipt_customer FOREIGN KEY (customer_id) REFERENCES customers (id) ON DELETE RESTRICT
   ) ENGINE=InnoDB`,
  `CREATE TABLE allocations (
     id BIGINT AUTO_INCREMENT PRIMARY KEY, receipt_id BIGINT NOT NULL, bill_id BIGINT NOT NULL, amount DECIMAL(14,2) NOT NULL,
     released TINYINT(1) NOT NULL DEFAULT 0,
     CONSTRAINT chk_alloc_amount CHECK (amount > 0),
     CONSTRAINT fk_alloc_receipt FOREIGN KEY (receipt_id) REFERENCES receipts (id) ON DELETE RESTRICT,
     CONSTRAINT fk_alloc_bill FOREIGN KEY (bill_id) REFERENCES bills (id) ON DELETE RESTRICT
   ) ENGINE=InnoDB`,
];

const toPaise = (s: string) => {
  const [w, f = ''] = s.split('.');
  return BigInt(w) * 100n + BigInt((f + '00').slice(0, 2));
};
const fromPaise = (p: bigint) => `${p / 100n}.${String(p % 100n).padStart(2, '0')}`;

export interface Stats {
  ok: Record<string, number>;
  business: Record<string, number>;
  deadlocks: number;
  lockTimeouts: number;
  otherErrors: string[];
  retries: number;
}

export const emptyStats = (): Stats => ({ ok: {}, business: {}, deadlocks: 0, lockTimeouts: 0, otherErrors: [], retries: 0 });

class Business extends Error {}

/** The counter step: one row, taken last. LAST_INSERT_ID(expr) hands back the new value without a second lock. */
export async function nextNumber(conn: Connection, series: string): Promise<number> {
  await conn.query(
    'INSERT INTO counters (series, last_value) VALUES (?, LAST_INSERT_ID(1)) ON DUPLICATE KEY UPDATE last_value = LAST_INSERT_ID(last_value + 1)',
    [series]
  );
  const [[row]] = await conn.query<any[][]>('SELECT LAST_INSERT_ID() AS n');
  return Number((row as any).n);
}

async function claim(conn: Connection, fn: string) {
  await conn.query('INSERT INTO idempotency (request_id, fn) VALUES (?, ?)', [randomUUID(), fn]);
}
const lockCustomer = (conn: Connection, id: string) => conn.query('SELECT id FROM customers WHERE id = ? FOR UPDATE', [id]);

async function lockPieces(conn: Connection, ids: string[], order: 'spec' | 'bad') {
  if (order === 'spec') {
    const sorted = [...ids].sort(); // UUID type sorts by the same bytes as the hex text
    const [rows] = await conn.query<any[]>(
      `SELECT id, status, price FROM skus WHERE id IN (${sorted.map(() => '?').join(',')}) ORDER BY id FOR UPDATE`,
      sorted
    );
    return rows;
  }
  const out: any[] = []; // negative control: one by one in the order the caller listed them
  for (const id of ids) {
    const [rows] = await conn.query<any[]>('SELECT id, status, price FROM skus WHERE id = ? FOR UPDATE', [id]);
    out.push(...rows);
  }
  return out;
}

/** Applies a customer's unallocated money to their oldest pending bills, oldest receipt first (Y6). Caller holds the customer lock. */
export async function rebalance(conn: Connection, customerId: string) {
  const [bills] = await conn.query<any[]>(
    `SELECT b.id, b.grand_total - COALESCE((SELECT SUM(a.amount) FROM allocations a WHERE a.bill_id = b.id AND a.released = 0), 0) AS pending
     FROM bills b WHERE b.customer_id = ? AND b.status = 'active' HAVING pending > 0 ORDER BY b.id`,
    [customerId]
  );
  if (!bills.length) return;
  const [receipts] = await conn.query<any[]>(
    `SELECT r.id, r.amount - COALESCE((SELECT SUM(a.amount) FROM allocations a WHERE a.receipt_id = r.id AND a.released = 0), 0) AS remaining
     FROM receipts r WHERE r.customer_id = ? HAVING remaining > 0 ORDER BY r.id`,
    [customerId]
  );
  let bi = 0;
  let ri = 0;
  const pend = bills.map((b) => toPaise(b.pending));
  const rem = receipts.map((r) => toPaise(r.remaining));
  while (bi < bills.length && ri < receipts.length) {
    const take = pend[bi] < rem[ri] ? pend[bi] : rem[ri];
    await conn.query('INSERT INTO allocations (receipt_id, bill_id, amount) VALUES (?, ?, ?)', [receipts[ri].id, bills[bi].id, fromPaise(take)]);
    pend[bi] -= take;
    rem[ri] -= take;
    if (pend[bi] === 0n) bi++;
    if (rem[ri] === 0n) ri++;
  }
}

async function sellPieces(conn: Connection, billId: number, rows: any[]) {
  for (const r of rows) {
    await conn.query('INSERT INTO bill_items (bill_id, sku_id) VALUES (?, ?)', [billId, r.id]);
    const [res]: any = await conn.query("UPDATE skus SET status = 'Sold', sold_bill_id = ? WHERE id = ? AND status = 'In Stock'", [billId, r.id]);
    if (res.affectedRows !== 1) throw new Error('piece update count mismatch');
  }
}

export interface Ctx {
  customers: string[];
  skus: string[];
  order: 'spec' | 'bad';
  /** Negative control: find the pieces to free by the NON-indexed column sold_bill_id (a full scan) instead of by the ids already locked. */
  unindexedUpdate?: boolean;
}

export const isWrong = (ctx: Ctx) => ctx.order === 'bad' && Math.random() < 0.5; // mixed orders are what make a cycle

/** Frees the pieces of a bill. The right way uses the ids the transaction has just locked (primary key); the trap scans the table. */
async function freePieces(conn: Connection, ctx: Ctx, billId: number, ids: string[]) {
  if (ctx.unindexedUpdate) {
    await conn.query(`UPDATE skus SET status = 'In Stock', sold_bill_id = NULL WHERE sold_bill_id = ?`, [billId]);
  } else if (ids.length) {
    await conn.query(
      `UPDATE skus SET status = 'In Stock', sold_bill_id = NULL WHERE id IN (${ids.map(() => '?').join(',')}) AND sold_bill_id = ?`,
      [...ids, billId]
    );
  }
}

export async function createBill(conn: Connection, ctx: Ctx, customerId: string, skuIds: string[]) {
  await claim(conn, 'create_bill');
  const wrong = isWrong(ctx);
  let n: number | null = null;
  if (wrong) n = await nextNumber(conn, 'bill:JV:2026'); // WRONG: counter before the customer lock
  await lockCustomer(conn, customerId);
  const rows = await lockPieces(conn, skuIds, wrong ? 'bad' : 'spec');
  if (rows.length !== skuIds.length || rows.some((r) => r.status !== 'In Stock')) throw new Business('JV_PIECE_UNAVAILABLE');
  const total = rows.reduce((s, r) => s + toPaise(r.price), 0n);
  if (!wrong) n = await nextNumber(conn, 'bill:JV:2026'); // counter last
  const billNo = `JV-2026-${String(n).padStart(4, '0')}`;
  const [res]: any = await conn.query('INSERT INTO bills (bill_no, customer_id, grand_total) VALUES (?, ?, ?)', [billNo, customerId, fromPaise(total)]);
  await sellPieces(conn, res.insertId, rows);
  await rebalance(conn, customerId);
  return billNo;
}

export async function recordPayment(conn: Connection, _ctx: Ctx, customerId: string, amount: string) {
  await claim(conn, 'record_payment');
  await lockCustomer(conn, customerId);
  await conn.query('INSERT INTO receipts (customer_id, amount) VALUES (?, ?)', [customerId, amount]);
  await rebalance(conn, customerId);
}

async function cancelInside(conn: Connection, billId: number, ctx: Ctx) {
  const [bills] = await conn.query<any[]>('SELECT id, status, customer_id FROM bills WHERE id = ? FOR UPDATE', [billId]);
  if (!bills.length || bills[0].status !== 'active') throw new Business('JV_BILL_CANCELLED');
  const [items] = await conn.query<any[]>('SELECT sku_id FROM bill_items WHERE bill_id = ? AND is_live = 1', [billId]);
  const ids: string[] = items.map((i) => i.sku_id);
  if (ids.length) await lockPieces(conn, ids, isWrong(ctx) ? 'bad' : 'spec');
  await freePieces(conn, ctx, billId, ids);
  await conn.query('UPDATE bill_items SET is_live = 0 WHERE bill_id = ?', [billId]);
  await conn.query('UPDATE allocations SET released = 1 WHERE bill_id = ?', [billId]);
  await conn.query("UPDATE bills SET status = 'cancelled' WHERE id = ?", [billId]);
  return bills[0].customer_id as string;
}

export async function cancelBill(conn: Connection, ctx: Ctx, billId: number) {
  await claim(conn, 'cancel_bill');
  // X0 item 3: find the customer by an UNLOCKED read of the bill, lock the customer, then re-read the bill FOR UPDATE
  const [pre] = await conn.query<any[]>('SELECT customer_id FROM bills WHERE id = ?', [billId]);
  if (!pre.length) throw new Business('JV_NOT_FOUND');
  await lockCustomer(conn, pre[0].customer_id);
  const customerId = await cancelInside(conn, billId, ctx);
  await rebalance(conn, customerId);
}

export async function reissueBill(conn: Connection, ctx: Ctx, billId: number, newSkuIds: string[]) {
  await claim(conn, 'reissue_bill');
  const [pre] = await conn.query<any[]>('SELECT customer_id FROM bills WHERE id = ?', [billId]);
  if (!pre.length) throw new Business('JV_NOT_FOUND');
  const customerId = pre[0].customer_id as string;
  const wrong = isWrong(ctx);
  let n: number | null = null;
  if (wrong) n = await nextNumber(conn, 'bill:JV:2026');
  await lockCustomer(conn, customerId);
  // old and new pieces are locked TOGETHER, ascending (X0 item 5)
  const [bills] = await conn.query<any[]>('SELECT status FROM bills WHERE id = ? FOR UPDATE', [billId]);
  if (!bills.length || bills[0].status !== 'active') throw new Business('JV_BILL_CANCELLED');
  const [oldItems] = await conn.query<any[]>('SELECT sku_id FROM bill_items WHERE bill_id = ? AND is_live = 1', [billId]);
  const all = [...new Set([...oldItems.map((i) => i.sku_id as string), ...newSkuIds])];
  const locked = await lockPieces(conn, all, wrong ? 'bad' : 'spec');
  const oldSet = new Set(oldItems.map((i) => i.sku_id as string));
  if (newSkuIds.some((id) => !oldSet.has(id) && locked.find((r) => r.id === id)?.status !== 'In Stock')) throw new Business('JV_PIECE_UNAVAILABLE');
  await freePieces(conn, ctx, billId, oldItems.map((i) => i.sku_id as string));
  await conn.query('UPDATE bill_items SET is_live = 0 WHERE bill_id = ?', [billId]);
  await conn.query('UPDATE allocations SET released = 1 WHERE bill_id = ?', [billId]);
  await conn.query("UPDATE bills SET status = 'cancelled' WHERE id = ?", [billId]);
  const newRows = locked.filter((r) => newSkuIds.includes(r.id));
  const total = newRows.reduce((s, r) => s + toPaise(r.price), 0n);
  if (!wrong) n = await nextNumber(conn, 'bill:JV:2026');
  const [res]: any = await conn.query('INSERT INTO bills (bill_no, customer_id, grand_total) VALUES (?, ?, ?)', [
    `JV-2026-${String(n).padStart(4, '0')}`, customerId, fromPaise(total),
  ]);
  await sellPieces(conn, res.insertId, newRows);
  await rebalance(conn, customerId);
}

export async function addOpeningBalance(conn: Connection, ctx: Ctx, customerId: string, dues: string) {
  await claim(conn, 'add_opening_balance');
  const wrong = isWrong(ctx);
  let n: number | null = null;
  if (wrong) n = await nextNumber(conn, 'opening');
  await lockCustomer(conn, customerId);
  if (!wrong) n = await nextNumber(conn, 'opening');
  await conn.query("INSERT INTO bills (bill_no, customer_id, doc_type, grand_total) VALUES (?, ?, 'opening_balance', ?)", [
    `OB-${String(n).padStart(4, '0')}`, customerId, dues,
  ]);
  await rebalance(conn, customerId);
}

/** Creates the schema and seed rows the workload needs. */
export async function seedSim(conn: Connection, nCustomers: number, nSkus: number) {
  for (const ddl of SIM_DDL) await conn.query(ddl);
  const customers = Array.from({ length: nCustomers }, () => randomUUID());
  for (const [i, id] of customers.entries()) await conn.query('INSERT INTO customers VALUES (?, ?)', [id, i === 0 ? 'Walk-in' : `Customer ${i}`]);
  const skus = Array.from({ length: nSkus }, () => randomUUID());
  for (const [i, id] of skus.entries()) await conn.query('INSERT INTO skus (id, price) VALUES (?, ?)', [id, fromPaise(BigInt(150000 + (i % 17) * 77777))]);
  return { customers, skus };
}

/** Each worker is its own connection, runs `opsPerWorker` random operations, and never retries: every deadlock is counted. */
export async function runWorkload(
  db: string,
  ctx: Ctx,
  opts: { workers: number; opsPerWorker: number; seed: number; retries?: number }
): Promise<Stats> {
  const stats = emptyStats();
  const conns = await Promise.all(Array.from({ length: opts.workers }, () => appConn(db)));
  const bump = (m: Record<string, number>, k: string) => (m[k] = (m[k] ?? 0) + 1);
  await Promise.all(
    conns.map(async (conn, w) => {
      const rand = rng(opts.seed * 1000 + w);
      const pick = <T,>(xs: T[]) => xs[Math.floor(rand() * xs.length)];
      for (let i = 0; i < opts.opsPerWorker; i++) {
        const roll = rand();
        const customerId = pick(ctx.customers);
        const skuIds = [...new Set(Array.from({ length: 1 + Math.floor(rand() * 3) }, () => pick(ctx.skus)))];
        let name = '';
        let body: () => Promise<unknown>;
        if (roll < 0.4) { name = 'create_bill'; body = () => createBill(conn, ctx, customerId, skuIds); }
        else if (roll < 0.58) { name = 'record_payment'; body = () => recordPayment(conn, ctx, customerId, fromPaise(BigInt(50000 + Math.floor(rand() * 400000)))); }
        else if (roll < 0.78) {
          name = 'cancel_bill';
          const [rows] = await conn.query<any[]>("SELECT id FROM bills WHERE status = 'active' ORDER BY RAND() LIMIT 1");
          if (!rows.length) continue;
          body = () => cancelBill(conn, ctx, rows[0].id);
        } else if (roll < 0.92) {
          name = 'reissue_bill';
          const [rows] = await conn.query<any[]>("SELECT id FROM bills WHERE status = 'active' AND doc_type = 'estimate' ORDER BY RAND() LIMIT 1");
          if (!rows.length) continue;
          body = () => reissueBill(conn, ctx, rows[0].id, skuIds);
        } else { name = 'add_opening_balance'; body = () => addOpeningBalance(conn, ctx, customerId, fromPaise(BigInt(100000 + Math.floor(rand() * 900000)))); }
        try {
          await runTx(conn, body, {
            retries: opts.retries ?? 0,
            onRetry: (code) => { stats.retries++; if (code === ER.DEADLOCK) stats.deadlocks++; else stats.lockTimeouts++; },
          });
          bump(stats.ok, name);
        } catch (e) {
          if (e instanceof Business) bump(stats.business, e.message);
          else {
            const err = e as DbError;
            if (err.errno === ER.DEADLOCK) {
              stats.deadlocks++;
              if (process.env.JV_TRACE) console.log(`[trace] deadlock in ${name} customer=${customerId.slice(0, 8)} skus=${skuIds.map((x) => x.slice(0, 8)).join(',')}`);
            }
            else if (err.errno === ER.LOCK_WAIT_TIMEOUT) stats.lockTimeouts++;
            else stats.otherErrors.push(`${name}: ${err.errno} ${err.message}`);
          }
        }
      }
    })
  );
  await Promise.all(conns.map((x) => x.end()));
  return stats;
}

/** The nightly-check style assertions on the final data. Returns a list of problems (empty = clean). */
export async function checkInvariants(conn: Connection): Promise<string[]> {
  const bad: string[] = [];
  const q = async (sql: string) => (await conn.query<any[]>(sql))[0];
  // I1: Sold pieces are exactly the pieces on live lines of active bills
  const i1 = await q(`SELECT s.id FROM skus s LEFT JOIN bill_items i ON i.sku_id = s.id AND i.is_live = 1
                      LEFT JOIN bills b ON b.id = i.bill_id AND b.status = 'active'
                      WHERE (s.status = 'Sold') <> (b.id IS NOT NULL)`);
  if (i1.length) bad.push(`I1: ${i1.length} piece(s) Sold/line mismatch`);
  const i1b = await q(`SELECT i.id FROM bill_items i JOIN bills b ON b.id = i.bill_id WHERE i.is_live = 1 AND b.status <> 'active'`);
  if (i1b.length) bad.push(`I1: ${i1b.length} live line(s) on a cancelled bill`);
  const i1c = await q(`SELECT s.id FROM skus s WHERE s.sold_bill_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM bill_items i WHERE i.bill_id = s.sold_bill_id AND i.sku_id = s.id AND i.is_live = 1)`);
  if (i1c.length) bad.push(`I1: ${i1c.length} piece(s) point to a bill with no live line for them`);
  // I3: allocations never exceed the bill or the receipt
  const i3 = await q(`SELECT b.id FROM bills b WHERE b.status = 'active' AND (SELECT COALESCE(SUM(a.amount),0) FROM allocations a WHERE a.bill_id = b.id AND a.released = 0) > b.grand_total`);
  if (i3.length) bad.push(`I3: ${i3.length} bill(s) over-allocated`);
  const i3b = await q(`SELECT r.id FROM receipts r WHERE (SELECT COALESCE(SUM(a.amount),0) FROM allocations a WHERE a.receipt_id = r.id AND a.released = 0) > r.amount`);
  if (i3b.length) bad.push(`I3: ${i3b.length} receipt(s) over-spent`);
  const i3c = await q(`SELECT a.id FROM allocations a JOIN bills b ON b.id = a.bill_id WHERE a.released = 0 AND b.status <> 'active'`);
  if (i3c.length) bad.push(`I3: ${i3c.length} live allocation(s) on a cancelled bill`);
  // I10: a customer has an advance only if no bill is pending
  const i10 = await q(`
    SELECT c.id,
      (SELECT COALESCE(SUM(r.amount),0) FROM receipts r WHERE r.customer_id = c.id)
        - (SELECT COALESCE(SUM(a.amount),0) FROM allocations a JOIN receipts r ON r.id = a.receipt_id WHERE r.customer_id = c.id AND a.released = 0) AS advance,
      (SELECT COALESCE(SUM(b.grand_total),0) FROM bills b WHERE b.customer_id = c.id AND b.status = 'active')
        - (SELECT COALESCE(SUM(a.amount),0) FROM allocations a JOIN bills b ON b.id = a.bill_id WHERE b.customer_id = c.id AND a.released = 0) AS outstanding
    FROM customers c`);
  for (const r of i10) if (Number(r.advance) > 0 && Number(r.outstanding) > 0) bad.push(`I10: customer ${r.id} has advance ${r.advance} and outstanding ${r.outstanding}`);
  // I5: numbers contiguous from 1 within each series, no duplicates (bill_no is also UNIQUE)
  for (const [prefix, series] of [['JV-2026-', 'bill:JV:2026'], ['OB-', 'opening']] as const) {
    const nums = (await q(`SELECT CAST(SUBSTRING(bill_no, ${prefix.length + 1}) AS UNSIGNED) AS n FROM bills WHERE bill_no LIKE '${prefix}%' ORDER BY n`)).map((r: any) => Number(r.n));
    const last = (await q(`SELECT last_value FROM counters WHERE series = '${series}'`))[0]?.last_value;
    const expected = nums.map((_, i) => i + 1);
    if (JSON.stringify(nums) !== JSON.stringify(expected)) bad.push(`I5: ${series} has a gap or repeat: ${nums.slice(0, 12).join(',')}...`);
    if (nums.length && Number(last) !== nums.length) bad.push(`I5: ${series} counter ${last} but ${nums.length} numbers issued`);
  }
  return bad;
}
