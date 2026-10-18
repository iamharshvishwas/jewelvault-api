import { randomUUID } from 'node:crypto';
import { runInvariants } from '../../scripts/invariants.mjs';
import { formatTimestamp } from '../../src/clock';
import { fromUnits, toUnits } from '../../src/domain/rebalance';
import { runNightlyCheck } from '../../src/jobs/nightly';
import { rng } from '../helpers';
import { T } from '../schema/support';
import type { CallerName } from './cells';
import { type Designs, WALKIN, addCustomer, addDesigns, addRate, billBody, item, piece, setEstimate } from './x01-support';
import { type EditWorld, editWorld } from './edit-support';
import { rows } from './x02-support';
import { trace } from './x04-support';

// API31, T-B14 and the T-B26 clause (I9, Y6, V3, I1 to I7, I10, I13): RANDOM SEQUENCES OF 200 OPERATIONS through the real routes of the application, and after every operation the invariants of the
// database half, an oracle that recomputes the books from the base tables, and the ledger. The reviewer's seq.mjs (rm5-experiments) was the starting point; this one drives X1 to X5 and X10 to X12
// over HTTP, with a clock the sequence moves (over midnight in Asia/Kolkata and over the New Year) and the callers a shop has (the owner, a biller).
//
// What one operation is: the generator reads the books as they are (the test's own connection, not the code under test), draws an operation by weight and its target at random from a seeded
// generator (the seed fixes every choice; the sequence is one call at a time, so the same seed gives the same sequence), and makes the call. A call can end in a refusal the spec names (an
// overpayment, a cash limit, a bill already cancelled, a refund of more than the advance, ...): the generator provokes some on purpose. A refusal must leave the database exactly as it was.
// Anything else (a 5xx, JV_BUSY, an input the generator made wrong, a refusal nobody documents) is a problem.
//
// After a call that was saved:
//   1. T-B26: every allocation that existed before has the same id, receipt, bill, customer, amount, silver and created_at; only a cancel (X5, and the cancel inside X10) may set `released_at`, and
//      only on the allocations of the bill it cancels. A void changes no allocation at all (it stops them counting). The rebalance only adds rows.
//   2. the rows the answer names are in the tables, with the figures the answer gives;
//   3. the invariants I1 to I7, I10 and I13 (scripts/invariants.mjs, the SQL half) are all 0 rows and all ran;
//   4. the ORACLE: billed, received, refunded, allocated, outstanding, advance and the silver twins of each customer, recomputed from bills, receipts and receipt_allocations in BigInt, equal V2;
//      the pending of each bill equals V1; the last row of the ledger (the real route, GET /v1/customers/:id/ledger) carries the customer's balance and silver balance, and every row of it is the
//      running sum of the rows before it;
//   5. a void changes no day of the cash book before the day it is made (V4 `voided_on`), and `voided_on`/`cancelled_on` are the Asia/Kolkata date of `voided_at`/`cancelled_at`.
// At the end (and every 50 operations) the nightly check of API32 runs on the database: the Node half of I6 and the review line I11, and the verdict must be ok.

export interface SeedPlan {
  seed: number;
  /** the first instant of the API clock (UTC) */
  start: string;
  /** settings.estimate.roundOff for this sequence (R8) */
  roundOff: boolean;
}

/** The three seeds of T-B14, each starting where its night will cross something: the Indian midnight of 31 December (1), the New Year after a midnight (2), three days before it (3); and the fourth, run once. */
export const SEED_PLANS: Record<number, SeedPlan> = {
  1: { seed: 1, start: '2026-12-31T15:30:00Z', roundOff: true },
  2: { seed: 2, start: '2026-12-30T17:55:00Z', roundOff: false },
  3: { seed: 3, start: '2026-12-28T05:00:00Z', roundOff: true },
  4: { seed: 4, start: '2026-12-31T17:10:00Z', roundOff: false },
};

export interface SequenceReport {
  seed: number;
  ops: number;
  problems: string[];
  /** saved calls by operation */
  ok: Record<string, number>;
  /** refused calls by `operation:CODE` */
  refused: Record<string, number>;
  /** receipts voided, by kind (`money`, `money:opening`, `fine_silver`, `fine_silver:opening`, `fine_cash`, `refund`) */
  voided: Record<string, number>;
  /** repeats of a saved request with its key: the stored answer came back */
  replays: number;
  /** how often the Indian calendar day changed between two operations, and how often the year did */
  midnights: number;
  newYears: number;
  /** calls made by the owner with a date before today */
  backdated: number;
  walkin: number;
  /** runs of the invariants and the invariants that ran in each */
  invariantRuns: number;
  ran: string[];
  /** allocations compared before and after (T-B26), summed over the operations */
  allocationsCompared: number;
  /** the ledgers checked */
  ledgersChecked: number;
  nightly: { runs: number; ok: boolean; counts: Record<string, number>; ran: string[] } | null;
  seconds: number;
  /** the dates the sequence lived on, first and last */
  firstDay: string;
  lastDay: string;
}

// ------------------------------------------------------------------ small things

type Rand = () => number;
const pick = <X>(r: Rand, a: readonly X[]): X => a[Math.floor(r() * a.length)];
const chance = (r: Rand, p: number): boolean => r() < p;
const int = (r: Rand, lo: number, hi: number): number => lo + Math.floor(r() * (hi - lo + 1));
const paise = (text: unknown): bigint => toUnits(String(text), 2);
const milli = (text: unknown): bigint => toUnits(String(text), 3);
const rupees = (p: bigint): string => fromUnits(p, 2);
const grams = (mg: bigint): string => fromUnits(mg, 3);
const MIN = (a: bigint, b: bigint): bigint => (a < b ? a : b);
const MS_DAY = 86_400_000;

/** The Asia/Kolkata calendar date of a DATETIME(6) text in UTC. */
export function kolkataDate(utc: string): string {
  return new Date(Date.parse(`${utc.slice(0, 19).replace(' ', 'T')}Z`) + 19_800_000).toISOString().slice(0, 10);
}
const addDays = (date: string, n: number): string => new Date(Date.parse(`${date}T00:00:00Z`) + n * MS_DAY).toISOString().slice(0, 10);

const MODES = ['Cash', 'Cash', 'Cash', 'UPI', 'UPI', 'UPI', 'Card', 'Bank Transfer', 'Other'] as const;
const SALE_TYPES = ['Retail', 'Retail', 'Semi-Wholesale', 'Wholesale'] as const;

// ------------------------------------------------------------------ what the generator knows about a piece

type Kind = 'pp' | 'gold' | 'silver' | 'silver925';
interface PieceInfo {
  id: string;
  kind: Kind;
  /** a Per Piece piece's price, in rupees */
  price: number;
}

const RATES: Record<Exclude<Kind, 'pp'>, { metal: string; labour: string }> = {
  gold: { metal: '6900.00', labour: '250.00' },
  silver: { metal: '85.00', labour: '8.00' },
  silver925: { metal: '78.00', labour: '12.50' },
};

type Item = ReturnType<typeof item>;
function lineOf(r: Rand, p: PieceInfo, bump = 0): Item {
  if (p.kind === 'pp') return item(p.id, { metal_rate: rupees(BigInt(p.price + bump) * 100n), ...(chance(r, 0.1) ? { other_charges: '10.00' } : {}) });
  const base = RATES[p.kind];
  return item(p.id, {
    metal_rate: rupees(paise(base.metal) + BigInt(bump) * 100n),
    labour_rate: pick(r, [base.labour, base.labour, '0.00']),
    ...(chance(r, 0.3) ? { piroi: '2.15' } : {}),
    ...(chance(r, 0.1) ? { other_charges: '55.55' } : {}),
  });
}

// ------------------------------------------------------------------ the books as the generator sees them

interface BillRow {
  id: string;
  customer_id: string;
  status: string;
  doc_type: string;
  sale_type: string;
  pending: bigint;
  fine_pending: bigint;
  received: bigint;
}
interface ReceiptRow {
  id: string;
  customer_id: string;
  kind: string;
  status: string;
  is_opening: number;
  amount: bigint;
  fine_grams: bigint;
}
interface Figures {
  outstanding: bigint;
  advance: bigint;
  fine_outstanding: bigint;
  fine_advance: bigint;
}
interface Snap {
  stock: string[];
  bills: BillRow[];
  receipts: ReceiptRow[];
  figures: Map<string, Figures>;
}

interface Alloc {
  id: string;
  receipt_id: string;
  bill_id: string;
  customer_id: string;
  amount: string;
  fine_grams: string;
  released_at: string | null;
  created_at: string;
}

// ------------------------------------------------------------------ the calls

interface Plan {
  name: string;
  caller: CallerName;
  url: string;
  payload: unknown;
  key: string;
  /** X5, X10: the bill the call cancels; its allocations are the only ones that may be released */
  cancels?: string;
  /** X4: the receipt that is voided */
  voids?: ReceiptRow;
  backdated?: boolean;
  walkin?: boolean;
}

interface Answer {
  status: number;
  json: any;
  replayed: boolean;
  text: string;
}

/**
 * The refusals the spec names for these functions, by operation and code, with the `details.reason` where the code has several meanings. Anything else is a problem: a refusal for a reason nobody documented
 * is a wrong answer (or a generator that made a wrong request), not "a refusal".
 */
const DOCUMENTED: Record<string, readonly (string | undefined)[]> = {
  'create_bill:JV_OVERPAYMENT': [undefined],
  'create_bill:JV_CASH_LIMIT': [undefined],
  'create_bill:JV_NOT_ALLOWED': [undefined], // the walk-in's bill at the PAN limit (Z2)
  'record_payment:JV_OVERPAYMENT': [undefined],
  'record_payment:JV_CASH_LIMIT': [undefined],
  'settle_fine:JV_FINE_EXCEEDS': [undefined],
  'settle_fine:JV_CASH_LIMIT': [undefined],
  'void_receipt:JV_ALREADY_VOID': [undefined],
  'void_receipt:JV_NOT_ALLOWED': ['void_the_refund_first'],
  'cancel_bill:JV_BILL_CANCELLED': [undefined],
  'cancel_bill:JV_NOT_ALLOWED': ['void_its_receipts_first'],
  'reissue_bill:JV_BILL_CANCELLED': [undefined],
  'reissue_bill:JV_NOT_ALLOWED': ['not_an_estimate', 'void_its_receipts_first'],
  'reissue_bill:JV_OVERPAYMENT': [undefined],
  'reissue_bill:JV_CASH_LIMIT': [undefined],
  'issue_refund:JV_NOT_ALLOWED': ['more_than_advance'],
  'add_opening_balance:JV_NOT_ALLOWED': ['walkin_holds_no_advance'],
};

// ------------------------------------------------------------------ the sequence

export async function runSequence(plan: SeedPlan, o: { ops?: number; label?: string; keepGoing?: boolean; onProgress?: (n: number) => void } = {}): Promise<SequenceReport> {
  const t0 = performance.now();
  const nOps = o.ops ?? 200;
  const rand = rng(plan.seed * 7919 + 17);
  const w: EditWorld = await editWorld(o.label ?? `x31s${plan.seed}`, { triggers: true });
  const problems: string[] = [];
  const report: SequenceReport = {
    seed: plan.seed,
    ops: 0,
    problems,
    ok: {},
    refused: {},
    voided: {},
    replays: 0,
    midnights: 0,
    newYears: 0,
    backdated: 0,
    walkin: 0,
    invariantRuns: 0,
    ran: [],
    allocationsCompared: 0,
    ledgersChecked: 0,
    nightly: null,
    seconds: 0,
    firstDay: '',
    lastDay: '',
  };
  let stop = false;
  let current = 'setup';
  const fail = (message: string) => {
    problems.push(`seed ${plan.seed}, operation ${report.ops} (${current}): ${message}`);
    if (!o.keepGoing) stop = true;
  };

  try {
    const sql = w.world.sql;
    const q = (text: string, params: unknown[] = []) => rows(w, text, params);
    const micros = w.time.time;

    // ---- the clock: only forward (S5); the sessions of the fixture are renewed whenever time jumps (idle 12 hours, absolute 14 days)
    micros.micros = BigInt(Date.parse(plan.start)) * 1000n;
    const renew = async () => {
      await sql.query('UPDATE sessions SET last_seen_at = ?, expires_at = ?, revoked_at = NULL', [formatTimestamp(micros.micros - 60_000_000n), formatTimestamp(micros.micros + 14n * 24n * 3600n * 1_000_000n)]);
    };
    const today = (): string => kolkataDate(formatTimestamp(micros.micros));
    await renew();
    report.firstDay = today();

    // ---- the world: designs, pieces, customers, the settings of R8 and L4
    const d: Designs = await addDesigns(w);
    await setEstimate(w, { prefix: 'JV', roundOff: plan.roundOff });
    await addRate(w, 'Gold', '22K', RATES.gold.metal, '2026-12-01');
    await addRate(w, 'Silver', '999', RATES.silver.metal, '2026-12-01');
    const info = new Map<string, PieceInfo>();
    const restock = async (n: number) => {
      for (let i = 0; i < n; i++) {
        const kind = pick(rand, ['pp', 'gold', 'gold', 'silver', 'silver', 'silver925'] as const);
        let id: string;
        let price = 0;
        if (kind === 'pp') {
          price = pick(rand, [900, 1500, 2500, 4000, 6000]);
          id = await piece(w, d.gold24pp, { retail: `${price}.00` });
        } else if (kind === 'gold') id = await piece(w, d.gold22, { nw: fromUnits(BigInt(int(rand, 3000, 15000)), 3), retail: '250.00' });
        else if (kind === 'silver') id = await piece(w, d.silver999, { nw: fromUnits(BigInt(int(rand, 20000, 120000)), 3), retail: '8.00' });
        else id = await piece(w, d.silver925, { nw: fromUnits(BigInt(int(rand, 20000, 80000)), 3), retail: '12.50' });
        info.set(id, { id, kind, price });
      }
    };
    await restock(24);
    const A = await addCustomer(w, { customer_type: 'Retail' });
    const B = await addCustomer(w, { customer_type: 'Wholesale' });
    const customers = [WALKIN, A, B];

    // ---- reading the books
    const snapshot = async (): Promise<Snap> => {
      const stock = (await q("SELECT id FROM skus WHERE status = 'In Stock' ORDER BY id")).map((r) => String(r.id));
      const bills = (await q(`SELECT b.id, b.customer_id, b.status, b.doc_type, b.sale_type, bill_summary.pending, bill_summary.fine_pending, bill_summary.received FROM bills b JOIN ${T.bill_summary} ON bill_summary.id = b.id ORDER BY b.bill_no`)).map((r) => ({
        id: String(r.id), customer_id: String(r.customer_id), status: String(r.status), doc_type: String(r.doc_type), sale_type: String(r.sale_type), pending: paise(r.pending), fine_pending: milli(r.fine_pending), received: paise(r.received),
      }));
      const receipts = (await q('SELECT id, customer_id, kind, status, is_opening, amount, fine_grams FROM receipts ORDER BY created_at, id')).map((r) => ({
        id: String(r.id), customer_id: String(r.customer_id), kind: String(r.kind), status: String(r.status), is_opening: Number(r.is_opening), amount: paise(r.amount), fine_grams: milli(r.fine_grams),
      }));
      const figures = new Map<string, Figures>();
      for (const r of await q(`SELECT customer_balances.id, customer_balances.outstanding, customer_balances.advance, customer_balances.fine_outstanding, customer_balances.fine_advance FROM ${T.customer_balances}`)) {
        figures.set(String(r.id), { outstanding: paise(r.outstanding), advance: paise(r.advance), fine_outstanding: milli(r.fine_outstanding), fine_advance: milli(r.fine_advance) });
      }
      return { stock, bills, receipts, figures };
    };
    const allocations = async (): Promise<Map<string, Alloc>> =>
      new Map((await q('SELECT id, receipt_id, bill_id, customer_id, amount, fine_grams, released_at, created_at FROM receipt_allocations')).map((r) => [String(r.id), { id: String(r.id), receipt_id: String(r.receipt_id), bill_id: String(r.bill_id), customer_id: String(r.customer_id), amount: String(r.amount), fine_grams: String(r.fine_grams), released_at: r.released_at === null ? null : String(r.released_at), created_at: String(r.created_at) }]));
    const dayRows = async (): Promise<Map<string, string>> => new Map((await q(`SELECT business_date, mode, money_in, money_out FROM ${T.daily_totals}`)).map((r) => [`${r.business_date}|${r.mode}`, `${r.money_in}|${r.money_out}`]));
    const counters = async (): Promise<string> => String((await q('SELECT COALESCE(SUM(last_value), 0) AS n FROM sys_counters'))[0].n);
    const fingerprint = async (): Promise<string> => JSON.stringify([await trace(w), await counters()]);

    // ---- the calls
    const send = async (p: { caller: CallerName; url: string; payload?: unknown; key?: string }): Promise<Answer> => {
      const res = await w.world.call(p.caller, 'POST', p.url, { ...(p.payload === undefined ? {} : { payload: p.payload }), headers: p.key ? { 'idempotency-key': p.key } : {} });
      return { status: res.statusCode, json: res.body ? JSON.parse(res.body) : null, replayed: res.headers['idempotent-replay'] === 'true', text: res.body };
    };
    const quote = async (caller: CallerName, body: Record<string, unknown>): Promise<{ grand: bigint; subtotal: bigint; fine: bigint } | null> => {
      const a = await send({ caller, url: '/v1/bills/quote', payload: body });
      if (a.status !== 200) {
        fail(`the quote of the generator's own cart was refused: ${a.status} ${a.text.slice(0, 200)}`);
        return null;
      }
      return { grand: paise(a.json.totals.grand_total), subtotal: paise(a.json.totals.subtotal), fine: milli(a.json.totals.fine_weight_due) };
    };

    // ---- the generator
    const pastDay = (): string => addDays(today(), -int(rand, 1, 3));
    const owner = (): boolean => chance(rand, 0.7);
    const reasonText = 'owner approves cash above the limit';

    /** A cart for X1 / X10 / X7 from pieces: the sale type, the lines, and (sometimes) a discount and extra charges. */
    const cartOf = (ids: string[], saleType: string): { saleType: string; items: Item[] } => ({ saleType, items: ids.map((id) => lineOf(rand, info.get(id) as PieceInfo, chance(rand, 0.15) ? pick(rand, [-5, -2, 2, 5]) : 0)) });

    const split = (total: bigint): bigint[] => {
      if (total <= 100n) return [total];
      const first = (total * BigInt(int(rand, 20, 80))) / 100n;
      return first > 0n && first < total ? [first, total - first] : [total];
    };
    const paymentRows = (total: bigint, floor = 0n): Record<string, unknown>[] => {
      // unpaid, part paid or paid in full; a few calls pay one rupee too much (Y5)
      const scenario = pick(rand, ['none', 'none', 'none', 'part', 'part', 'full', 'full', 'full', 'over'] as const);
      if (scenario === 'none' || total <= floor) return [];
      let sum = scenario === 'part' ? (total * BigInt(pick(rand, [10, 30, 50, 80]))) / 100n : scenario === 'full' ? total : total + 100n;
      sum = sum - floor > 0n ? sum - floor : 0n;
      if (sum <= 0n) return [];
      const parts = split(sum);
      return parts.map((a) => ({ mode: pick(rand, MODES), amount: rupees(a) }));
    };

    const planBill = async (s: Snap): Promise<Plan | null> => {
      if (s.stock.length === 0) return null;
      const n = Math.min(s.stock.length, pick(rand, [1, 1, 1, 2, 2, 3]));
      const ids = new Set<string>();
      while (ids.size < n) ids.add(pick(rand, s.stock));
      const customer = pick(rand, [WALKIN, A, A, B, B]);
      const asOwner = owner();
      const caller: CallerName = asOwner ? 'owner' : 'biller';
      const saleType = pick(rand, chance(rand, 0.5) ? SALE_TYPES : ([customer === B ? 'Wholesale' : 'Retail'] as const));
      const cart = cartOf([...ids], saleType);
      const date = asOwner && chance(rand, 0.15) ? pastDay() : null;
      const base: Record<string, unknown> = { sale_type: cart.saleType, items: cart.items, ...(date ? { bill_date: date } : {}) };
      let totals = await quote(caller, base);
      if (!totals) return null;
      if (chance(rand, 0.15) && totals.subtotal > 100_000n) {
        base.discount = rupees((totals.subtotal * BigInt(int(rand, 1, 9))) / 100n / 100n * 100n);
        totals = await quote(caller, base);
        if (!totals) return null;
      }
      if (chance(rand, 0.1)) {
        base.additional_charges = '150.00';
        totals = await quote(caller, base);
        if (!totals) return null;
      }
      const payments = paymentRows(totals.grand);
      const body = billBody(customer, cart.saleType, cart.items, {
        ...(date ? { bill_date: date } : {}),
        ...(base.discount ? { discount: base.discount } : {}),
        ...(base.additional_charges ? { additional_charges: base.additional_charges } : {}),
        ...(payments.length > 0 ? { payments } : {}),
        ...(asOwner && payments.length > 0 && chance(rand, 0.3) ? { cash_override_reason: reasonText } : {}),
      });
      return { name: 'create_bill', caller, url: '/v1/bills', payload: body, key: randomUUID(), backdated: date !== null, walkin: customer === WALKIN };
    };

    const planPay = (s: Snap): Plan | null => {
      const customer = pick(rand, [WALKIN, A, A, B, B]);
      const walkin = customer === WALKIN;
      const open = s.bills.filter((b) => b.customer_id === customer && b.status === 'active' && b.pending > 0n);
      if (walkin && open.length === 0) return null;
      const asOwner = owner();
      const payload: Record<string, unknown> = {};
      let amount: bigint;
      if (open.length > 0) {
        const bill = pick(rand, open);
        if (walkin || chance(rand, 0.4)) {
          payload.bill_id = bill.id; // named-bill payment (Y3); the walk-in must name one (K5)
          amount = chance(rand, 0.4) ? bill.pending : BigInt(int(rand, 1, Number(bill.pending)));
          if (walkin && chance(rand, 0.06)) amount = bill.pending + 100n; // more than the bill: JV_OVERPAYMENT
        } else {
          const total = open.reduce((n, b) => n + b.pending, 0n);
          amount = chance(rand, 0.15) ? total + BigInt(int(rand, 100, 200_000)) : BigInt(int(rand, 1, Number(total))); // oldest first; the excess is kept as an advance
        }
      } else amount = BigInt(int(rand, 10_000, 400_000)); // nothing is open: money on account
      payload.amount = rupees(amount);
      payload.mode = pick(rand, MODES);
      const date = asOwner && chance(rand, 0.15) ? pastDay() : null;
      if (date) payload.paid_on = date;
      if (asOwner && chance(rand, 0.3)) payload.cash_override_reason = reasonText;
      return { name: 'record_payment', caller: asOwner ? 'owner' : 'biller', url: `/v1/customers/${customer}/payments`, payload, key: randomUUID(), backdated: date !== null, walkin };
    };

    const planFine = (s: Snap): Plan | null => {
      const owing = s.bills.filter((b) => b.status === 'active' && b.fine_pending > 0n);
      const customer = owing.length > 0 && chance(rand, 0.85) ? pick(rand, owing).customer_id : pick(rand, customers);
      const walkin = customer === WALKIN;
      const mine = owing.filter((b) => b.customer_id === customer);
      if (walkin && mine.length === 0) return null;
      const payload: Record<string, unknown> = {};
      let limit = s.figures.get(customer)?.fine_outstanding ?? 0n;
      if (mine.length > 0 && (walkin || chance(rand, 0.3))) {
        const bill = pick(rand, mine);
        payload.bill_id = bill.id;
        limit = bill.fine_pending;
      }
      if (limit <= 0n) limit = 1_000n; // nothing is owed: the refusal JV_FINE_EXCEEDS is the point
      const mg = chance(rand, 0.1) ? limit + BigInt(int(rand, 1, 5000)) : BigInt(int(rand, 1, Number(limit)));
      const mode = pick(rand, ['Silver', 'Cash'] as const);
      payload.grams = grams(mg);
      payload.mode = mode;
      if (mode === 'Cash') payload.silver_rate = pick(rand, ['85.00', '88.50', '90.00', '60.00']);
      const asOwner = owner();
      const date = asOwner && chance(rand, 0.15) ? pastDay() : null;
      if (date) payload.paid_on = date;
      if (asOwner && mode === 'Cash' && chance(rand, 0.3)) payload.cash_override_reason = reasonText;
      return { name: 'settle_fine', caller: asOwner ? 'owner' : 'biller', url: `/v1/customers/${customer}/fine-settlements`, payload, key: randomUUID(), backdated: date !== null, walkin };
    };

    const receiptKind = (r: ReceiptRow): string => (r.is_opening ? `${r.kind}:opening` : r.kind);
    const planVoid = (s: Snap): Plan | null => {
      const live = s.receipts.filter((r) => r.status === 'active');
      if (live.length === 0) return null;
      let target: ReceiptRow;
      const gone = s.receipts.filter((r) => r.status === 'voided');
      if (gone.length > 0 && chance(rand, 0.06)) target = pick(rand, gone); // a second void: JV_ALREADY_VOID
      else {
        const kinds = [...new Set(live.map(receiptKind))];
        // every kind in turn (payments, silver, cash for silver, refunds, opening advances): a kind that has not been voided yet in this sequence is drawn first, most of the time
        const missing = kinds.filter((k) => !report.voided[k]);
        const kind = missing.length > 0 && chance(rand, 0.8) ? pick(rand, missing) : pick(rand, kinds);
        target = pick(rand, live.filter((r) => receiptKind(r) === kind));
      }
      return { name: 'void_receipt', caller: 'owner', url: `/v1/receipts/${target.id}/void`, payload: { reason: 'entered on the wrong customer' }, key: randomUUID(), voids: target, walkin: target.customer_id === WALKIN };
    };

    const planCancel = (s: Snap): Plan | null => {
      const live = s.bills.filter((b) => b.status === 'active');
      const gone = s.bills.filter((b) => b.status === 'cancelled');
      if (live.length === 0) return null;
      const target = gone.length > 0 && chance(rand, 0.06) ? pick(rand, gone) : pick(rand, live); // a second cancel: JV_BILL_CANCELLED
      return { name: 'cancel_bill', caller: 'owner', url: `/v1/bills/${target.id}/cancel`, payload: { reason: 'the goods came back' }, key: randomUUID(), cancels: target.id, walkin: target.customer_id === WALKIN };
    };

    const planReissue = async (s: Snap): Promise<Plan | null> => {
      const estimates = s.bills.filter((b) => b.status === 'active' && b.doc_type === 'estimate');
      const odd = s.bills.filter((b) => b.status === 'cancelled' || b.doc_type !== 'estimate');
      if (estimates.length === 0) return null;
      const old = odd.length > 0 && chance(rand, 0.06) ? pick(rand, odd) : pick(rand, estimates);
      const oldPieces = (await q('SELECT sku_id FROM bill_items WHERE bill_id = ? ORDER BY line_no', [old.id])).map((r) => String(r.sku_id));
      const pool = [...new Set([...oldPieces, ...s.stock])];
      if (pool.length === 0) return null;
      const n = Math.min(pool.length, pick(rand, [1, 1, 2, 3]));
      const ids = new Set<string>();
      if (oldPieces.length > 0 && chance(rand, 0.7)) ids.add(pick(rand, oldPieces));
      while (ids.size < n) ids.add(pick(rand, pool));
      const cart = cartOf([...ids], chance(rand, 0.6) ? old.sale_type : pick(rand, SALE_TYPES));
      const body: Record<string, unknown> = { reason: 'the rate on the first bill was wrong', sale_type: cart.saleType, items: cart.items };
      if (chance(rand, 0.25)) {
        const totals = await quote('owner', { sale_type: cart.saleType, items: cart.items });
        if (!totals) return null;
        const payments = paymentRows(totals.grand, old.received).slice(0, 1);
        if (payments.length > 0) body.payments = payments;
      }
      return { name: 'reissue_bill', caller: 'owner', url: `/v1/bills/${old.id}/reissue`, payload: body, key: randomUUID(), cancels: old.id, walkin: old.customer_id === WALKIN };
    };

    const planRefund = (s: Snap): Plan | null => {
      const holding = customers.filter((c) => (s.figures.get(c)?.advance ?? 0n) > 0n);
      const customer = holding.length > 0 && chance(rand, 0.9) ? pick(rand, holding) : pick(rand, customers);
      const advance = s.figures.get(customer)?.advance ?? 0n;
      const amount = advance > 0n && !chance(rand, 0.12) ? BigInt(int(rand, 1, Number(advance))) : advance + BigInt(int(rand, 100, 20_000)); // now and then more than the advance (Y10)
      const date = chance(rand, 0.1) ? pastDay() : null;
      return { name: 'issue_refund', caller: 'owner', url: `/v1/customers/${customer}/refunds`, payload: { amount: rupees(amount), mode: pick(rand, ['Cash', 'UPI'] as const), ...(date ? { paid_on: date } : {}) }, key: randomUUID(), backdated: date !== null, walkin: customer === WALKIN };
    };

    const planOpening = (): Plan => {
      const customer = pick(rand, [WALKIN, A, A, B, B]);
      const figures: Record<string, string> = {};
      if (chance(rand, 0.6)) figures.dues = rupees(BigInt(int(rand, 100, 50_000)) * 100n);
      if (chance(rand, 0.3)) figures.fine_due = grams(BigInt(int(rand, 100, 40_000)));
      if (chance(rand, 0.4)) figures.advance = rupees(BigInt(int(rand, 100, 30_000)) * 100n);
      if (chance(rand, 0.2)) figures.fine_advance = grams(BigInt(int(rand, 100, 30_000)));
      if (Object.keys(figures).length === 0) figures.dues = '1000.00';
      const date = chance(rand, 0.5) ? addDays(today(), -int(rand, 0, 20)) : today();
      return { name: 'add_opening_balance', caller: 'owner', url: `/v1/customers/${customer}/opening-balance`, payload: { ...figures, as_of: date }, key: randomUUID(), backdated: date !== today(), walkin: customer === WALKIN };
    };

    const WEIGHTS: [string, number][] = [['bill', 27], ['pay', 20], ['fine', 9], ['void', 9], ['cancel', 6], ['reissue', 6], ['refund', 6], ['opening', 6]];
    const planOne = async (s: Snap): Promise<Plan> => {
      const total = WEIGHTS.reduce((n, [, wgt]) => n + wgt, 0);
      for (let attempt = 0; attempt < 12; attempt++) {
        let x = rand() * total;
        const op = WEIGHTS.find(([, wgt]) => (x -= wgt) < 0)?.[0] ?? 'bill';
        const made = op === 'bill' ? await planBill(s) : op === 'pay' ? planPay(s) : op === 'fine' ? planFine(s) : op === 'void' ? planVoid(s) : op === 'cancel' ? planCancel(s) : op === 'reissue' ? await planReissue(s) : op === 'refund' ? planRefund(s) : planOpening();
        if (made) return made;
        if (stop) break;
      }
      return planOpening();
    };

    // ---- the checks after a call
    const checkInvariants = async () => {
      const out = await runInvariants(sql, { sample: 10 });
      report.invariantRuns++;
      const need = ['I1', 'I2', 'I3', 'I4', 'I5', 'I6', 'I7', 'I10', 'I13'];
      for (const id of need) if (!out.ran.includes(id)) fail(`${id} did not run`);
      report.ran = out.ran;
      for (const [id, n] of Object.entries(out.counts as Record<string, number>)) {
        if (n !== 0) fail(`${id} is false: ${n} row(s), e.g. ${JSON.stringify(out.rows.filter((r: { invariant: string }) => r.invariant === id).slice(0, 2))}`);
      }
    };

    /** The books of one customer recomputed from bills, receipts and receipt_allocations, in BigInt, against V2, V1 and the ledger the route gives. */
    const checkOracle = async (customer: string) => {
      const sum = async (sqlText: string, p: unknown[] = [customer]): Promise<bigint> => {
        const [r] = await q(sqlText, p);
        return r.v === null ? 0n : BigInt(String(r.v).replace('.', ''));
      };
      const billed = await sum("SELECT SUM(grand_total) AS v FROM bills WHERE customer_id = ? AND status = 'active'");
      const fineBilled = await sum("SELECT SUM(fine_weight_due) AS v FROM bills WHERE customer_id = ? AND status = 'active'");
      const received = await sum("SELECT SUM(amount) AS v FROM receipts WHERE customer_id = ? AND status = 'active' AND kind = 'money'");
      const refunded = await sum("SELECT SUM(amount) AS v FROM receipts WHERE customer_id = ? AND status = 'active' AND kind = 'refund'");
      const fineReceived = await sum("SELECT SUM(fine_grams) AS v FROM receipts WHERE customer_id = ? AND status = 'active' AND kind IN ('fine_silver', 'fine_cash')");
      const allocated = await sum("SELECT SUM(a.amount) AS v FROM receipt_allocations a JOIN receipts r ON r.id = a.receipt_id JOIN bills b ON b.id = a.bill_id WHERE a.customer_id = ? AND a.released_at IS NULL AND r.status = 'active' AND b.status = 'active'");
      const fineAllocated = await sum("SELECT SUM(a.fine_grams) AS v FROM receipt_allocations a JOIN receipts r ON r.id = a.receipt_id JOIN bills b ON b.id = a.bill_id WHERE a.customer_id = ? AND a.released_at IS NULL AND r.status = 'active' AND b.status = 'active'");
      const want = {
        billed, received, refunded, allocated,
        outstanding: billed - allocated,
        advance: received - allocated - refunded,
        balance: billed - received + refunded,
        fine_outstanding: fineBilled - fineAllocated,
        fine_advance: fineReceived - fineAllocated,
        fine_balance: fineBilled - fineReceived,
      };
      const [v2] = await q(`SELECT * FROM ${T.customer_balances} WHERE customer_balances.id = ?`, [customer]);
      const got: Record<string, bigint> = {
        billed: paise(v2.billed), received: paise(v2.received), refunded: paise(v2.refunded), allocated: paise(v2.allocated), outstanding: paise(v2.outstanding), advance: paise(v2.advance), balance: paise(v2.balance),
        fine_outstanding: milli(v2.fine_outstanding), fine_advance: milli(v2.fine_advance), fine_balance: milli(v2.fine_balance),
      };
      const who = customer === WALKIN ? 'the walk-in' : customer.slice(0, 8);
      for (const k of Object.keys(want) as (keyof typeof want)[]) if (want[k] !== got[k]) fail(`oracle: ${who}'s ${k} is ${got[k]} in V2 and ${want[k]} from the base tables`);
      // the pending of each bill (V1) from the allocations
      for (const b of await q(`SELECT b.id, b.grand_total, b.fine_weight_due, bill_summary.pending, bill_summary.fine_pending FROM bills b JOIN ${T.bill_summary} ON bill_summary.id = b.id WHERE b.customer_id = ? AND b.status = 'active'`, [customer])) {
        const [live] = await q("SELECT SUM(a.amount) AS m, SUM(a.fine_grams) AS f FROM receipt_allocations a JOIN receipts r ON r.id = a.receipt_id WHERE a.bill_id = ? AND a.released_at IS NULL AND r.status = 'active'", [b.id]);
        const pending = paise(b.grand_total) - (live.m === null ? 0n : paise(live.m));
        const finePending = milli(b.fine_weight_due) - (live.f === null ? 0n : milli(live.f));
        if (pending !== paise(b.pending)) fail(`oracle: bill ${String(b.id).slice(0, 8)} pending is ${b.pending} in V1 and ${rupees(pending)} from the allocations`);
        if (finePending !== milli(b.fine_pending)) fail(`oracle: bill ${String(b.id).slice(0, 8)} silver pending is ${b.fine_pending} in V1 and ${grams(finePending)} from the allocations`);
        if (pending < 0n || finePending < 0n) fail(`oracle: bill ${String(b.id).slice(0, 8)} is over-paid (${rupees(pending)} / ${grams(finePending)})`);
      }
      // the ledger, through the real route: the last row is the customer's balance, each row the running sum of the ones before it
      const res = await w.world.call('owner', 'GET', `/v1/customers/${customer}/ledger?limit=1000`);
      if (res.statusCode !== 200) return fail(`the ledger of ${who} was answered ${res.statusCode}: ${res.body.slice(0, 200)}`);
      const ledger = JSON.parse(res.body) as { rows: Record<string, string>[]; next: unknown };
      if (ledger.next !== null) return fail(`the ledger of ${who} has more than one page`);
      let money = 0n;
      let fine = 0n;
      ledger.rows.forEach((r, i) => {
        money += paise(r.debit) - paise(r.credit);
        fine += milli(r.fine_debit) - milli(r.fine_credit);
        if (paise(r.balance) !== money) fail(`the ledger of ${who}, row ${i + 1} (${r.kind}): balance ${r.balance} is not the running sum ${rupees(money)}`);
        if (milli(r.fine_balance) !== fine) fail(`the ledger of ${who}, row ${i + 1} (${r.kind}): silver balance ${r.fine_balance} is not the running sum ${grams(fine)}`);
      });
      const last = ledger.rows[ledger.rows.length - 1];
      const lastMoney = last ? paise(last.balance) : 0n;
      const lastFine = last ? milli(last.fine_balance) : 0n;
      if (lastMoney !== want.balance) fail(`the last row of the ledger of ${who} says balance ${rupees(lastMoney)}, the customer's balance is ${rupees(want.balance)}`);
      if (lastFine !== want.fine_balance) fail(`the last row of the ledger of ${who} says silver balance ${grams(lastFine)}, the customer's is ${grams(want.fine_balance)}`);
      report.ledgersChecked++;
    };

    /** T-B26: nothing that existed changed, except that a cancel released the allocations of its bill. */
    const checkAllocations = (before: Map<string, Alloc>, after: Map<string, Alloc>, p: Plan) => {
      for (const [id, a] of before) {
        const b = after.get(id);
        if (!b) {
          fail(`T-B26: allocation ${id.slice(0, 8)} is gone`);
          continue;
        }
        report.allocationsCompared++;
        for (const k of ['receipt_id', 'bill_id', 'customer_id', 'amount', 'fine_grams', 'created_at'] as const) {
          if (a[k] !== b[k]) fail(`T-B26: allocation ${id.slice(0, 8)} changed its ${k}: ${a[k]} -> ${b[k]}`);
        }
        if (a.released_at !== b.released_at) {
          if (!(p.cancels !== undefined && a.bill_id === p.cancels && a.released_at === null && b.released_at !== null)) {
            fail(`T-B26: allocation ${id.slice(0, 8)} (bill ${a.bill_id.slice(0, 8)}) was released by ${p.name}`);
          }
        }
      }
    };

    /** The rows an answer names are in the tables with the figures the answer gives. */
    const checkAnswer = async (json: any) => {
      const allocs: any[] = [...(json.allocations ?? []), ...(json.released_allocations ?? [])];
      for (const a of allocs) {
        const [row] = await q('SELECT receipt_id, bill_id, amount, fine_grams, released_at FROM receipt_allocations WHERE id = ?', [a.id]);
        if (!row) fail(`the answer names allocation ${String(a.id).slice(0, 8)}, which is not in the table`);
        else if (paise(row.amount) !== paise(a.amount) || milli(row.fine_grams) !== milli(a.fine_grams) || row.receipt_id !== a.receipt_id || row.bill_id !== a.bill_id) fail(`allocation ${String(a.id).slice(0, 8)} is not what the answer says`);
      }
      for (const a of json.released_allocations ?? []) {
        const [row] = await q('SELECT released_at FROM receipt_allocations WHERE id = ?', [a.id]);
        if (row && row.released_at === null) fail(`the answer says allocation ${String(a.id).slice(0, 8)} was released and it is not`);
      }
      for (const r of [...(json.receipts ?? []), ...(json.receipt ? [json.receipt] : [])]) {
        const [row] = await q('SELECT customer_id, kind, status, amount, fine_grams FROM receipts WHERE id = ?', [r.id]);
        if (!row) fail(`the answer names receipt ${String(r.id).slice(0, 8)}, which is not in the table`);
        else if (paise(row.amount) !== paise(r.amount) || milli(row.fine_grams) !== milli(r.fine_grams) || row.kind !== r.kind || row.status !== r.status) fail(`receipt ${String(r.id).slice(0, 8)} is not what the answer says`);
      }
      for (const b of [json.bill, json.new_bill, json.old_bill].filter((x) => x && typeof x === 'object')) {
        const [row] = await q('SELECT status, grand_total, fine_weight_due FROM bills WHERE id = ?', [b.id]);
        if (!row) fail(`the answer names bill ${String(b.id).slice(0, 8)}, which is not in the table`);
        else if (paise(row.grand_total) !== paise(b.grand_total) || row.status !== b.status) fail(`bill ${String(b.id).slice(0, 8)} is not what the answer says`);
      }
    };

    /** Dates of D11 and D13: the business day of a void or a cancel is the Asia/Kolkata date of the same instant, and never before the day of the thing it ends. */
    const checkDays = async () => {
      for (const r of await q("SELECT id, paid_on, voided_at, voided_on FROM receipts WHERE status = 'voided'")) {
        if (String(r.voided_on) !== kolkataDate(String(r.voided_at))) fail(`receipt ${String(r.id).slice(0, 8)} was voided at ${r.voided_at} (UTC) and voided_on is ${r.voided_on}: that is not its Indian day ${kolkataDate(String(r.voided_at))}`);
        if (String(r.voided_on) < String(r.paid_on)) fail(`receipt ${String(r.id).slice(0, 8)} was voided on ${r.voided_on}, before it was paid on ${r.paid_on}`);
      }
      for (const b of await q("SELECT id, cancelled_at, cancelled_on FROM bills WHERE status = 'cancelled'")) {
        if (String(b.cancelled_on) !== kolkataDate(String(b.cancelled_at))) fail(`bill ${String(b.id).slice(0, 8)} was cancelled at ${b.cancelled_at} (UTC) and cancelled_on is ${b.cancelled_on}`);
      }
    };

    const runNightly = async (): Promise<NonNullable<SequenceReport['nightly']>> => {
      const conn = await w.world.app.db!.checkout();
      try {
        const out = await runNightlyCheck(conn, { clock: w.world.app.clock, date: today() });
        if (!out.ok) fail(`the nightly check is red: ${JSON.stringify(out.rows.slice(0, 3))}`);
        for (const id of ['I1', 'I2', 'I3', 'I4', 'I5', 'I6', 'I7', 'I10', 'I13']) {
          if (!out.ran.includes(id)) fail(`the nightly check did not run ${id}`);
          else if (out.counts[id] !== 0) fail(`the nightly check: ${id} has ${out.counts[id]} broken row(s)`);
        }
        return { runs: (report.nightly?.runs ?? 0) + 1, ok: out.ok, counts: out.counts, ran: out.ran };
      } finally {
        conn.release();
      }
    };

    // ---- the run
    let last: { plan: Plan; answer: Answer } | null = null;
    let dayBefore = today();
    for (let n = 0; n < nOps && !stop; n++) {
      report.ops = n + 1;
      current = 'clock';
      // time passes: a little, now and then hours, now and then days
      const roll = rand();
      const seconds = roll < 0.88 ? 20 + rand() * 600 : roll < 0.98 ? 3600 * (6 + rand() * 20) : 86_400 * (2 + rand() * 2);
      micros.micros += BigInt(Math.round(seconds * 1000)) * 1000n;
      if (seconds > 3000) await renew();
      const day = today();
      if (day !== dayBefore) {
        report.midnights++;
        if (day.slice(0, 4) !== dayBefore.slice(0, 4)) report.newYears++;
        dayBefore = day;
      }
      if (Number((await q("SELECT COUNT(*) AS n FROM skus WHERE status = 'In Stock'"))[0].n) < 4) await restock(8);

      // a repeat of the last saved request with its key (L5): the stored answer, nothing written
      if (last && chance(rand, 0.04)) {
        current = `repeat of ${last.plan.name}`;
        const before = await fingerprint();
        const again = await send({ caller: last.plan.caller, url: last.plan.url, payload: last.plan.payload, key: last.plan.key });
        if (again.status !== last.answer.status || !again.replayed || again.text !== last.answer.text) fail(`the repeat was not the stored answer: ${again.status} replayed=${again.replayed} ${again.text.slice(0, 120)}`);
        if ((await fingerprint()) !== before) fail('the repeat wrote rows');
        report.replays++;
        continue;
      }

      const snap = await snapshot();
      const p = await planOne(snap);
      if (stop) break;
      current = p.name;
      const beforeFp = await fingerprint();
      const beforeAllocs = await allocations();
      const beforeDays = p.voids ? await dayRows() : null;
      const answer = await send({ caller: p.caller, url: p.url, payload: p.payload, key: p.key });
      const ok = answer.status === 200 || answer.status === 201;

      if (!ok) {
        const code = answer.json?.error?.code as string | undefined;
        const refusal = `${p.name}:${code ?? answer.status}`;
        const reasons = DOCUMENTED[refusal];
        if (!(answer.status === 409 && reasons && reasons.includes(answer.json?.error?.details?.reason))) {
          fail(`answered ${answer.status} ${code ?? ''} ${JSON.stringify(answer.json?.error?.details ?? '')} ${String(answer.json?.error?.message ?? '').slice(0, 160)} for ${JSON.stringify(p.payload).slice(0, 300)}`);
        }
        report.refused[refusal] = (report.refused[refusal] ?? 0) + 1;
        if ((await fingerprint()) !== beforeFp) fail(`refused (${refusal}) but the books changed`);
        if (code === 'JV_NOT_ALLOWED' || code === 'JV_OVERPAYMENT') {
          // a refusal leaves the claim unused: the same key is still free (X0, K2)
          const [c] = await q('SELECT COUNT(*) AS n FROM sys_idempotency WHERE request_id = ?', [p.key]);
          if (Number(c.n) !== 0) fail(`refused (${refusal}) and the key was used up`);
        }
        continue;
      }

      report.ok[p.name] = (report.ok[p.name] ?? 0) + 1;
      if (p.backdated) report.backdated++;
      if (p.walkin) report.walkin++;
      if (p.voids) {
        const k = receiptKind(p.voids);
        report.voided[k] = (report.voided[k] ?? 0) + 1;
      }
      last = { plan: p, answer };

      checkAllocations(beforeAllocs, await allocations(), p);
      await checkAnswer(answer.json);
      if (beforeDays) {
        const afterDays = await dayRows();
        const voidDay = today();
        for (const [key, was] of beforeDays) {
          if (key.split('|')[0] < voidDay && afterDays.get(key) !== was) fail(`a void changed a closed day of the cash book: ${key} was ${was} and is ${afterDays.get(key)}`);
        }
      }
      await checkDays();
      await checkInvariants();
      for (const c of customers) await checkOracle(c);
      if ((n + 1) % 50 === 0 && !stop) report.nightly = await runNightly();
      o.onProgress?.(n + 1);
    }
    if (!stop) {
      current = 'the end';
      report.nightly = await runNightly();
      const bad = w.world.logs.lines().filter((l) => Number(l.level) >= 50 || l.msg === 'answered JV_BUSY');
      if (bad.length > 0) fail(`the log holds ${bad.length} error or busy line(s): ${JSON.stringify(bad[0]).slice(0, 300)}`);
    }
    report.lastDay = today();
  } finally {
    report.seconds = (performance.now() - t0) / 1000;
    await w.world.close();
  }
  return report;
}
