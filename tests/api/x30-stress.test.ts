import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { runInvariants } from '../../scripts/invariants.mjs';
import { POOL_LIMITS } from '../../src/db/pool';
import { rng } from '../helpers';
import { T } from '../schema/support';
import type { CallerName } from './cells';
import { innodbDeadlocks } from './tx-support';
import { type Designs, type Item, TODAY, WALKIN, addCustomer, addDesigns, addRate, item, piece } from './x01-support';
import { withoutCustomerLock } from './x0-support';
import { type EditWorld, pendingAgrees, rows } from './x02-support';
import { fineAgrees } from './x03-support';
import { invariantsFor, overAllocated } from './x04-pair';
import { moneyBooks } from './x29-support';
import { busyLines, movingWorld, sleep, tally } from './x30-support';

// API30. T-C15 (X0, S8, S11, S12), the stress run: 8 workers (the pool of 8, the paced connect of S11) make 200 mixed calls through the REAL routes (bills, payments, fine settlements, voids, cancels,
// re-issues and refunds) over 3 customers (the walk-in among them) and 12 pieces. It ends with no deadlock (1213: the server's own counter, the log of the API and every answer), no 5xx and no JV_BUSY,
// every answer one of the documented ones, the rows in the database exactly the rows the answers say were written, and I1 to I5, I7 and I10 true (with every other invariant the SQL files check).
// I6 and I11 are the T-C15 clause of API31, run on the stress database.
//
// How the calls are chosen: each worker takes the next of the 200 numbers, reads the books with the test's own connection, picks an operation and its target at random (a seeded generator for each
// worker: the seed fixes the choices, the interleaving is the machine's), and makes it. A target is read just before the call, so another worker's call may take it first: those calls end in the refusals
// the spec names (a piece that is no longer In Stock, a bill that is already cancelled, a receipt already void, ...). Anything else is a failure.

const WORKERS = 8;
const CALLS = 200;
const SEEDS = [301, 302, 303];

type Op = 'bill' | 'pay' | 'fine' | 'void' | 'cancel' | 'reissue' | 'refund';
const OPS: readonly Op[] = ['bill', 'pay', 'fine', 'void', 'cancel', 'reissue', 'refund'];
const WEIGHTS: Record<Op, number> = { bill: 30, pay: 22, fine: 9, void: 8, cancel: 8, reissue: 8, refund: 6 };

// ------------------------------------------------------------------ small things (money in whole paise, silver in whole milligrams, as numbers: they are far below 2^53)

type Rand = () => number;
const pick = <X>(r: Rand, a: readonly X[]): X => a[Math.floor(r() * a.length)];
const chance = (r: Rand, p: number): boolean => r() < p;
const int = (r: Rand, lo: number, hi: number): number => lo + Math.floor(r() * (hi - lo + 1));
const toUnits = (text: unknown, scale: number): number => {
  const [i, f = ''] = String(text).split('.');
  return Number(i) * 10 ** scale + (String(i).startsWith('-') ? -1 : 1) * Number(f.padEnd(scale, '0').slice(0, scale));
};
const fromUnits = (n: number, scale: number): string => `${Math.floor(n / 10 ** scale)}.${String(n % 10 ** scale).padStart(scale, '0')}`;
const rupees = (paise: number): string => fromUnits(paise, 2);
const grams = (mg: number): string => fromUnits(mg, 3);

// ------------------------------------------------------------------ the world: 3 customers, 12 pieces

interface Stock {
  id: string;
  kind: 'piece' | 'gold' | 'silver';
  /** Per Piece: the price in paise */
  price: number;
}
interface Fixture {
  w: EditWorld;
  customers: string[];
  stock: Map<string, Stock>;
}

async function fixture(label: string): Promise<Fixture> {
  const w = await movingWorld(label);
  const d: Designs = await addDesigns(w);
  await addRate(w, 'Gold', '22K', '6900.00', TODAY);
  await addRate(w, 'Silver', '999', '85.00', TODAY);
  const stock = new Map<string, Stock>();
  for (const price of [900, 1500, 2500, 4000]) {
    const id = await piece(w, d.gold24pp, { retail: `${price}.00` });
    stock.set(id, { id, kind: 'piece', price: price * 100 });
  }
  for (const nw of ['3.500', '5.000', '8.250', '12.000']) {
    const id = await piece(w, d.gold22, { nw, retail: '250.00' });
    stock.set(id, { id, kind: 'gold', price: 0 });
  }
  for (const nw of ['40.000', '65.500', '120.000', '25.250']) {
    const id = await piece(w, d.silver999, { nw, retail: '8.00' });
    stock.set(id, { id, kind: 'silver', price: 0 });
  }
  const customers = [WALKIN, await addCustomer(w, { customer_type: 'Retail' }), await addCustomer(w, { customer_type: 'Wholesale' })];
  return { w, customers, stock };
}

/** The line of a piece; `bump` is the change a re-issue makes to the price, in rupees. */
function lineOf(s: Stock, bump = 0): Item {
  if (s.kind === 'piece') return item(s.id, { metal_rate: rupees(s.price + bump * 100) });
  if (s.kind === 'gold') return item(s.id, { metal_rate: fromUnits(690_000 + bump * 100, 2), labour_rate: '250.00' });
  return item(s.id, { metal_rate: fromUnits(8500 + bump * 100, 2), labour_rate: '8.00' });
}

// ------------------------------------------------------------------ the books as the generator sees them

interface Snap {
  pieces: { id: string; status: string }[];
  bills: { id: string; customer_id: string; status: string; sale_type: string; pending: number; fine_pending: number }[];
  receipts: { id: string; customer_id: string; kind: string; status: string }[];
  balances: Map<string, { advance: number; fine_advance: number }>;
}

async function readSnap(w: EditWorld): Promise<Snap> {
  const pieces = (await rows(w, 'SELECT id, status FROM skus')).map((p) => ({ id: String(p.id), status: String(p.status) }));
  const bills = (
    await rows(w, `SELECT b.id, b.customer_id, b.status, b.sale_type, bill_summary.pending, bill_summary.fine_pending FROM bills b JOIN ${T.bill_summary} ON bill_summary.id = b.id`)
  ).map((b) => ({ id: String(b.id), customer_id: String(b.customer_id), status: String(b.status), sale_type: String(b.sale_type), pending: toUnits(b.pending, 2), fine_pending: toUnits(b.fine_pending, 3) }));
  const receipts = (await rows(w, 'SELECT id, customer_id, kind, status FROM receipts')).map((x) => ({ id: String(x.id), customer_id: String(x.customer_id), kind: String(x.kind), status: String(x.status) }));
  const balances = new Map<string, { advance: number; fine_advance: number }>();
  for (const b of await rows(w, `SELECT customer_balances.id AS id, customer_balances.advance, customer_balances.fine_advance FROM ${T.customer_balances}`)) {
    balances.set(String(b.id), { advance: toUnits(b.advance, 2), fine_advance: toUnits(b.fine_advance, 3) });
  }
  return { pieces, bills, receipts, balances };
}

// ------------------------------------------------------------------ the operations

interface Plan {
  op: Op;
  caller: CallerName;
  url: string;
  payload: Record<string, unknown>;
  key: string;
}

const fresh = (op: Op, caller: CallerName, url: string, payload: Record<string, unknown>): Plan => ({ op, caller, url, payload, key: randomUUID() });
const anyone = (r: Rand): CallerName => pick(r, ['biller', 'owner']);

function planBill(r: Rand, f: Fixture, snap: Snap): Plan | null {
  const free = snap.pieces.filter((p) => p.status === 'In Stock');
  if (free.length === 0) return null;
  const n = Math.min(free.length, chance(r, 0.3) ? 2 : 1);
  const chosen: Stock[] = [];
  while (chosen.length < n) {
    const p = f.stock.get(pick(r, free).id)!;
    if (!chosen.includes(p)) chosen.push(p);
  }
  const silver = chosen.some((s) => s.kind === 'silver');
  const saleType = silver && chance(r, 0.6) ? 'Wholesale' : pick(r, ['Retail', 'Retail', 'Semi-Wholesale', 'Wholesale']);
  const payload: Record<string, unknown> = { customer_id: pick(r, [f.customers[0], f.customers[1], f.customers[1], f.customers[2], f.customers[2]]), sale_type: saleType, items: chosen.map((s) => lineOf(s)) };
  // a payment row only where the total is known exactly (Per Piece lines: the price), so that an over-payment is never the generator's own mistake
  if (chosen.every((s) => s.kind === 'piece') && chance(r, 0.5)) {
    const total = chosen.reduce((sum, s) => sum + s.price, 0);
    const part = pick(r, [0.3, 0.5, 1]);
    const amount = Math.floor((total * part) / 10_000) * 100; // whole rupees
    if (amount > 0) payload.payments = [{ mode: amount <= 500_000 && chance(r, 0.15) ? 'Cash' : pick(r, ['UPI', 'Card', 'Bank Transfer']), amount: rupees(amount) }];
  }
  return fresh('bill', anyone(r), '/v1/bills', payload);
}

function planPay(r: Rand, f: Fixture, snap: Snap): Plan | null {
  const customer = pick(r, [f.customers[0], f.customers[1], f.customers[1], f.customers[2], f.customers[2]]);
  const walkin = customer === WALKIN;
  const open = snap.bills.filter((b) => b.customer_id === customer && b.status === 'active' && b.pending > 0);
  if (walkin && open.length === 0) return null;
  const payload: Record<string, unknown> = {};
  let amount: number;
  if (open.length > 0) {
    const bill = pick(r, open);
    amount = chance(r, 0.4) ? bill.pending : int(r, 1, bill.pending);
    if (!walkin && chance(r, 0.15)) amount = bill.pending + int(r, 100, 100_000); // more than is pending: the rest is kept as an advance
    if (walkin || chance(r, 0.5)) payload.bill_id = bill.id;
  } else {
    amount = int(r, 10_000, 300_000); // no bill open: money on account
  }
  payload.amount = rupees(amount);
  payload.mode = amount <= 500_000 && chance(r, 0.1) ? 'Cash' : pick(r, ['UPI', 'Card', 'Bank Transfer']);
  return fresh('pay', anyone(r), `/v1/customers/${customer}/payments`, payload);
}

function planFine(r: Rand, f: Fixture, snap: Snap): Plan | null {
  const owing = snap.bills.filter((b) => b.status === 'active' && b.fine_pending > 0);
  if (owing.length === 0) return null;
  const bill = pick(r, owing);
  const walkin = bill.customer_id === WALKIN;
  const mg = chance(r, 0.1) ? bill.fine_pending + int(r, 1, 5000) : int(r, 1, bill.fine_pending); // now and then a little more than is owed
  const payload: Record<string, unknown> = chance(r, 0.6) ? { grams: grams(mg), mode: 'Silver' } : { grams: grams(Math.min(mg, 60_000)), mode: 'Cash', silver_rate: pick(r, ['85.00', '88.50', '90.00']) };
  if (walkin || chance(r, 0.5)) payload.bill_id = bill.id;
  return fresh('fine', anyone(r), `/v1/customers/${bill.customer_id}/fine-settlements`, payload);
}

function planVoid(r: Rand, _f: Fixture, snap: Snap): Plan | null {
  const live = snap.receipts.filter((x) => x.status === 'active');
  if (live.length === 0) return null;
  return fresh('void', 'owner', `/v1/receipts/${pick(r, live).id}/void`, { reason: 'stress run: entered by mistake' });
}

function planCancel(r: Rand, _f: Fixture, snap: Snap): Plan | null {
  const live = snap.bills.filter((b) => b.status === 'active');
  if (live.length === 0) return null;
  return fresh('cancel', 'owner', `/v1/bills/${pick(r, live).id}/cancel`, { reason: 'stress run: the goods came back' });
}

async function planReissue(r: Rand, f: Fixture, snap: Snap): Promise<Plan | null> {
  const live = snap.bills.filter((b) => b.status === 'active');
  if (live.length === 0) return null;
  const bill = pick(r, live);
  const lines = await rows(f.w, 'SELECT sku_id FROM bill_items WHERE bill_id = ? ORDER BY line_no', [bill.id]);
  if (lines.length === 0) return null;
  const bump = pick(r, [-10, -5, 5, 10]); // rupees on the price of a piece or on the rate of a gram
  return fresh('reissue', 'owner', `/v1/bills/${bill.id}/reissue`, { reason: 'stress run: the rate was wrong', sale_type: bill.sale_type, items: lines.map((l) => lineOf(f.stock.get(String(l.sku_id))!, bump)) });
}

function planRefund(r: Rand, f: Fixture, snap: Snap): Plan | null {
  const holding = f.customers.filter((c) => (snap.balances.get(c)?.advance ?? 0) > 0);
  if (holding.length === 0) return null;
  const customer = pick(r, holding);
  const advance = snap.balances.get(customer)!.advance;
  const amount = chance(r, 0.15) ? advance + int(r, 100, 10_000) : int(r, 1, advance);
  return fresh('refund', 'owner', `/v1/customers/${customer}/refunds`, { amount: rupees(amount), mode: 'UPI' });
}

/** An operation drawn by weight; when it cannot be made from the books as they are (nothing to void yet), the next draw. */
async function planOne(r: Rand, f: Fixture, snap: Snap): Promise<Plan> {
  const total = OPS.reduce((n, op) => n + WEIGHTS[op], 0);
  for (let attempt = 0; attempt < 12; attempt++) {
    let x = r() * total;
    const op = OPS.find((o) => (x -= WEIGHTS[o]) < 0) ?? 'bill';
    const plan = op === 'bill' ? planBill(r, f, snap) : op === 'pay' ? planPay(r, f, snap) : op === 'fine' ? planFine(r, f, snap) : op === 'void' ? planVoid(r, f, snap) : op === 'cancel' ? planCancel(r, f, snap) : op === 'reissue' ? await planReissue(r, f, snap) : planRefund(r, f, snap);
    if (plan) return plan;
  }
  // nothing could be made from the books: money on account for the named customer always can
  return fresh('pay', 'owner', `/v1/customers/${f.customers[1]}/payments`, { amount: '500.00', mode: 'UPI' });
}

// ------------------------------------------------------------------ answers

interface Answer {
  plan: Plan;
  status: number;
  code: string | undefined;
  field: string | undefined;
  ms: number;
  json: any;
}

/** The refusals the spec names for these functions; a 422 only on the field a racing call can make wrong (the bill another call has just paid). */
const REFUSALS = new Set(['JV_PIECE_UNAVAILABLE', 'JV_OVERPAYMENT', 'JV_CASH_LIMIT', 'JV_FINE_EXCEEDS', 'JV_BILL_CANCELLED', 'JV_ALREADY_VOID', 'JV_NOT_ALLOWED']);
const successful = (a: Answer): boolean => a.status === 200 || a.status === 201;
function isExpectedRefusal(a: Answer): boolean {
  if (a.status === 409 && a.code !== undefined && REFUSALS.has(a.code)) return true;
  return a.status === 422 && a.code === 'JV_INVALID_INPUT' && a.field === 'bill_id' && (a.plan.op === 'pay' || a.plan.op === 'fine');
}

// ------------------------------------------------------------------ the run

interface Report {
  seed: number;
  problems: string[];
  ok: Record<string, number>;
  refused: Record<string, number>;
  deadlocks: number;
  maxConnections: number;
  invariantCounts: Record<string, number>;
  ranInvariants: string[];
  seconds: number;
}

/** Runs the stress and returns every way it went wrong as a sentence (an empty list is a clean run). The control passes `noLock`. */
async function stress(seed: number, noLock = false): Promise<Report> {
  const f = await fixture(`x30s${seed % 1000}`);
  const { w } = f;
  const problems: string[] = [];
  const problem = (s: string) => problems.push(s);
  const undo = noLock ? withoutCustomerLock() : () => undefined;
  try {
    const root = await w.world.scratch.root();
    const mySession = (w.world.sql as unknown as { threadId: number }).threadId;
    const deadlocksBefore = await innodbDeadlocks(root);
    const logFrom = w.world.logs.lines().length;
    const answers: Answer[] = [];
    let issued = 0;
    let maxConnections = 0;
    let sampling = true;
    const sampler = (async () => {
      while (sampling) {
        const [r] = await root.query<any[]>('SELECT COUNT(*) AS n FROM information_schema.PROCESSLIST WHERE USER = ? AND ID <> ?', [w.world.scratch.user, mySession]);
        maxConnections = Math.max(maxConnections, Number(r[0].n));
        await sleep(20);
      }
    })();

    const started = performance.now();
    await Promise.all(
      Array.from({ length: WORKERS }, async (_, worker) => {
        const r = rng(seed * 1009 + worker);
        while (issued < CALLS) {
          issued++;
          const plan = await planOne(r, f, await readSnap(w));
          const t0 = performance.now();
          const res = await w.world.call(plan.caller, 'POST', plan.url, { payload: plan.payload, headers: { 'idempotency-key': plan.key } });
          const json = res.body ? JSON.parse(res.body) : null;
          answers.push({ plan, status: res.statusCode, code: json?.error?.code, field: json?.error?.details?.field, ms: performance.now() - t0, json });
        }
      }),
    );
    const seconds = (performance.now() - started) / 1000;
    sampling = false;
    await sampler;
    await w.world.app.errorLog.idle();

    // 1. no deadlock: the server's counter, the API's own re-run log, and the answers
    const deadlocks = (await innodbDeadlocks(root)) - deadlocksBefore;
    if (deadlocks !== 0) problem(`the server counted ${deadlocks} deadlock(s) (1213)`);
    const logged = w.world.logs.lines().slice(logFrom);
    const reruns = logged.filter((l) => /deadlock/i.test(String(l.msg)));
    if (reruns.length > 0) problem(`the API re-ran a call after a deadlock ${reruns.length} time(s)`);
    const busy = busyLines(w, logFrom);
    if (busy.length > 0) problem(`${busy.length} call(s) were answered JV_BUSY: ${JSON.stringify(tally(busy))}`);

    // 2. every answer is a documented one
    if (answers.length !== CALLS) problem(`${answers.length} answers for ${CALLS} calls`);
    const ok: Record<string, number> = {};
    const refused: Record<string, number> = {};
    for (const a of answers) {
      if (successful(a)) ok[a.plan.op] = (ok[a.plan.op] ?? 0) + 1;
      else if (isExpectedRefusal(a)) refused[`${a.plan.op}:${a.code}`] = (refused[`${a.plan.op}:${a.code}`] ?? 0) + 1;
      else problem(`${a.plan.op} ${a.plan.url} was answered ${a.status} ${a.code ?? ''} ${a.field ?? ''}: ${JSON.stringify(a.json).slice(0, 240)}`);
    }
    const succeeded = Object.values(ok).reduce((n, c) => n + c, 0);
    if (!noLock) {
      for (const op of OPS) if (!ok[op]) problem(`no ${op} call succeeded in ${CALLS} calls: the mix proves nothing about it`);
      if (succeeded < CALLS * 0.4) problem(`only ${succeeded} of ${CALLS} calls succeeded`);
    }

    // 3. the pool of 8
    const stats = w.world.app.db!.stats();
    if (stats.inUse !== 0 || stats.waiting !== 0) problem(`the pool is not at rest: ${JSON.stringify(stats)}`);
    if (stats.opened > POOL_LIMITS.size) problem(`the pool opened ${stats.opened} connections (the limit is ${POOL_LIMITS.size})`);
    if (maxConnections > POOL_LIMITS.size) problem(`the application's database user had ${maxConnections} connections at once`);

    // 4. the rows are exactly the rows the answers say were written (a refused call left nothing, a saved call left all of it)
    const saved = answers.filter(successful);
    const sum = (pick: (a: Answer) => number): number => saved.reduce((n, a) => n + pick(a), 0);
    const count = async (table: string, where = '1 = 1'): Promise<number> => Number((await rows(w, `SELECT COUNT(*) AS n FROM \`${table}\` WHERE ${where}`))[0].n);
    const expectCount = async (table: string, expected: number, where?: string) => {
      const found = await count(table, where);
      if (found !== expected) problem(`${table}: ${found} rows, the answers say ${expected}`);
    };
    await expectCount('bills', sum((a) => (a.plan.op === 'bill' || a.plan.op === 'reissue' ? 1 : 0)));
    await expectCount('receipts', sum((a) => (['pay', 'fine', 'refund'].includes(a.plan.op) ? 1 : 0) + (a.plan.op === 'bill' || a.plan.op === 'reissue' ? (a.json.receipts as unknown[]).length : 0)));
    await expectCount('receipt_allocations', sum((a) => (Array.isArray(a.json.allocations) ? a.json.allocations.length : 0)));
    await expectCount('sys_idempotency', saved.length);
    const lineRows = sum((a) => (a.plan.op === 'bill' ? (a.json.items as unknown[]).length : a.plan.op === 'reissue' ? (a.json.items as unknown[]).length : 0));
    await expectCount('bill_items', lineRows);
    // a piece is Sold exactly when it is on a line of an active bill
    const wrongPieces = await rows(w, "SELECT s.id FROM skus s WHERE (s.status = 'Sold') <> EXISTS (SELECT 1 FROM bill_items i JOIN bills b ON b.id = i.bill_id WHERE i.sku_id = s.id AND b.status = 'active')");
    if (wrongPieces.length > 0) problem(`${wrongPieces.length} piece(s) are Sold without an active bill, or on an active bill and not Sold`);

    // 5. the invariants of the database half, in one snapshot: I1 to I5, I7 and I10 by name, and every other file that runs
    const inv = await runInvariants(w.world.sql, { sample: 10 });
    for (const id of ['I1', 'I2', 'I3', 'I4', 'I5', 'I7', 'I10']) {
      if (!inv.ran.includes(id)) problem(`${id} did not run`);
      else if (inv.counts[id] !== 0) problem(`${id} is false: ${inv.counts[id]} row(s), e.g. ${JSON.stringify(inv.rows.filter((x: { invariant: string }) => x.invariant === id).slice(0, 3))}`);
    }
    for (const [id, n] of Object.entries(inv.counts as Record<string, number>)) if (n !== 0 && !['I1', 'I2', 'I3', 'I4', 'I5', 'I7', 'I10'].includes(id)) problem(`${id} is false: ${n} row(s)`);

    // 6. another opinion on each customer: V1 summed = V2, the fine side the same, nothing allocated twice, and the books from the base tables
    for (const c of f.customers) {
      try {
        await pendingAgrees(w, c);
      } catch (e) {
        problem(`V1 and V2 disagree for ${c}: ${(e as Error).message.slice(0, 200)}`);
      }
      const fine = await fineAgrees(w, c);
      if (fine.bills !== fine.outstanding) problem(`the silver pending on the bills (${fine.bills}) is not the customer's fine outstanding (${fine.outstanding}), in milligrams`);
      const over = await overAllocated(w, c);
      if (over.length > 0) problem(`over-allocated: ${over.join('; ')}`);
      const books = await moneyBooks(w, c);
      if (books.advance < 0n || books.outstanding < 0n) problem(`negative books for ${c}: ${JSON.stringify({ advance: String(books.advance), outstanding: String(books.outstanding) })}`);
      const named = await invariantsFor(w, c);
      if (named.length > 0) problem(`invariants name this customer: ${named.slice(0, 3).join(' | ')}`);
    }

    // 7. a repeat of a saved call with its key is the stored answer and writes nothing (L5), also after all this load
    if (!noLock) {
      const before = JSON.stringify([await count('receipts'), await count('bills'), await count('receipt_allocations'), await count('sys_idempotency'), await count('audit_log')]);
      const r = rng(seed);
      for (const a of Array.from({ length: Math.min(12, saved.length) }, () => pick(r, saved))) {
        const again = await w.world.call(a.plan.caller, 'POST', a.plan.url, { payload: a.plan.payload, headers: { 'idempotency-key': a.plan.key } });
        if (again.statusCode !== a.status || again.headers['idempotent-replay'] !== 'true' || JSON.stringify(JSON.parse(again.body)) !== JSON.stringify(a.json)) {
          problem(`the repeat of ${a.plan.op} ${a.plan.key} was not the stored answer: ${again.statusCode} ${again.body.slice(0, 120)}`);
        }
      }
      const after = JSON.stringify([await count('receipts'), await count('bills'), await count('receipt_allocations'), await count('sys_idempotency'), await count('audit_log')]);
      if (before !== after) problem(`repeats wrote rows: ${before} -> ${after}`);
    }

    await root.end();
    return { seed, problems, ok, refused, deadlocks, maxConnections, invariantCounts: inv.counts as Record<string, number>, ranInvariants: inv.ran as string[], seconds };
  } finally {
    undo();
    await w.world.close();
  }
}

// ------------------------------------------------------------------ the tests

describe('T-C15 stress run: 8 workers and 200 mixed calls (bills, payments, fine, voids, cancels, re-issues, refunds) over 3 customers (the walk-in among them) and 12 pieces', () => {
  for (const seed of SEEDS) {
    it(`seed ${seed}: 0 deadlocks (1213), no 5xx and no JV_BUSY, every answer a documented one, the rows are the rows the answers say, I1 to I5, I7 and I10 true`, async () => {
      const report = await stress(seed);
      console.log(`[T-C15 stress seed ${seed}]`, JSON.stringify({ seconds: Math.round(report.seconds * 10) / 10, ok: report.ok, refused: report.refused, deadlocks: report.deadlocks, maxConnections: report.maxConnections, invariants: report.ranInvariants.join(',') }));
      expect(report.problems).toEqual([]);
      expect(report.deadlocks).toBe(0);
    }, 300_000);
  }

  it('NEGATIVE CONTROL: with the customer-lock helper replaced by a no-op in the test build the same run FAILS (a bill paid twice, a refund of money that is spent, an invariant, a deadlock or a refusal that is none of the documented ones)', async () => {
    let found: Report | undefined;
    for (const seed of [SEEDS[0], SEEDS[1], SEEDS[2]]) {
      const report = await stress(seed, true);
      console.log(`[T-C15 control seed ${seed}]`, JSON.stringify({ problems: report.problems.length, first: report.problems.slice(0, 3) }));
      if (report.problems.length > 0) {
        found = report;
        break;
      }
    }
    expect(found, 'three runs without the customer lock, and the checks found nothing wrong: they cannot see what the lock prevents').toBeDefined();
  }, 600_000);
});
