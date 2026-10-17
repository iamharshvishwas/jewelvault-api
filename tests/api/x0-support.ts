import { randomUUID } from 'node:crypto';
import type { Connection } from 'mysql2/promise';
import { vi } from 'vitest';
import * as locks from '../../src/db/locks';
import { type DbPool, createDbPool } from '../../src/db/pool';
import * as state from '../../src/db/state';
import * as touch from '../../src/db/touch';
import type { Tx } from '../../src/db/tx';
import { type Scratch, scratchDatabase } from '../helpers';
import { V, insert } from '../schema/support';

// Shared by the tests of API15 (X0: the lock helpers, the state read, the touches, the audit writer): a scratch database with the real schema, fixtures, a toy writing function that has the shape of
// the real ones, and the TEST SIDE of the hook of X0 item 8.
//
// THE HOOK. The spec says each money function calls ctx.pause('<function>.after_read') and that the production bundle contains no such call (T-D29 reads the compiled output). tsc keeps every call
// it is given, so a call written in src/ would be in the bundle. The hook is therefore made here, in the test build: the state read of src/db/state.ts is the one place a money function reads the
// customer's state before it allocates, and `Gates` puts a wrapper around it (vi.spyOn on the module's exports) that holds the session at `<fn>.after_read` until its gate is released. Production has
// no wrapper, no field on the context and no call. The same is done for `archive_customer.after_check` (readCustomerTotals) and for `lock_pieces.between` (the wrong helper of the T-C21 control
// below, which is the only one that has anything between two locks).

export interface X0World {
  scratch: Scratch;
  root: Connection;
  /** the ten-box user, for fixtures */
  u: Connection;
  pool: DbPool;
  category: string;
  design: string;
  db(): string;
  close(): Promise<void>;
}

/** A scratch database with the real schema (no seeds, no triggers unless asked) and a pool of 8 as the API has it. */
export async function x0World(label: string, opts: { optional?: boolean } = {}): Promise<X0World> {
  const scratch = await scratchDatabase(label, { schema: true });
  const u = await scratch.connect();
  if (opts.optional) {
    const { migrate } = await import('../../scripts/migrate.mjs');
    await migrate(u, { seeds: false, optional: true });
  }
  const category = (await insert(u, 'categories', V.category())).id as string;
  const design = (await insert(u, 'designs', V.design(category))).id as string;
  const root = await scratch.root();
  const pool = createDbPool(scratch.db);
  if (opts.optional) await root.query(`DROP TRIGGER IF EXISTS \`${scratch.database}\`.trg_audit_log_no_delete`);
  return {
    scratch,
    root,
    u,
    pool,
    category,
    design,
    db: () => `\`${scratch.database}\``,
    async close() {
      await pool.end().catch(() => undefined);
      await u.end().catch(() => undefined);
      await root.end().catch(() => undefined);
      await scratch.drop();
    },
  };
}

// ------------------------------------------------------------------ fixtures

export const addCustomer = async (w: X0World, o: Record<string, unknown> = {}): Promise<string> => (await insert(w.u, 'customers', V.customer({ mobile: `9${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`, ...o }))).id as string;
export const addBill = async (w: X0World, customerId: string, total = '1000.00', o: Record<string, unknown> = {}): Promise<string> =>
  (await insert(w.u, 'bills', V.bill(customerId, { subtotal: total, grand_total: total, ...o }))).id as string;
export const addReceipt = async (w: X0World, customerId: string, amount: string, o: Record<string, unknown> = {}): Promise<string> => (await insert(w.u, 'receipts', V.receipt(customerId, { amount, ...o }))).id as string;
export const addAllocation = async (w: X0World, receiptId: string, billId: string, customerId: string, amount: string, o: Record<string, unknown> = {}): Promise<string> =>
  (await insert(w.u, 'receipt_allocations', V.allocation(receiptId, billId, customerId, { amount, ...o }))).id as string;
export const addPiece = async (w: X0World, id: string, o: Record<string, unknown> = {}): Promise<string> => (await insert(w.u, 'skus', V.sku(w.design, { id, ...o }))).id as string;

/** Two pieces whose ids sort one way as text and the other in MariaDB's native UUID order (spec X0 item 5, [W]). */
export const P_TEXT_FIRST = '00000000-0000-4000-8000-000000000001';
export const P_SQL_FIRST = '00000001-0000-4000-8000-000000000000';

// ------------------------------------------------------------------ money in the toy, in whole paise (BigInt: no float anywhere)

export const paise = (text: string): bigint => {
  const [i, f = ''] = text.split('.');
  return BigInt(i) * 100n + BigInt(`${f}00`.slice(0, 2));
};
export const rupees = (p: bigint): string => `${p / 100n}.${String(p % 100n).padStart(2, '0')}`;

// ------------------------------------------------------------------ the toy writing function

export interface ToyPayArgs {
  customerId: string;
  amount: string;
  /** the stamp the touches write (the API clock's reading) */
  at?: string;
}
export interface ToyPayResult {
  receiptId: string;
  allocated: string;
  advance: string;
  trail: string[];
}

/**
 * The shape of X2 record_payment, small: the customer lock FIRST, the state read (the hook `toy_pay.after_read` is its return), allocation from what was read, the receipt and its allocations, the
 * touches. It goes through the helpers by their module's exports, so a test can replace one (the no-op lock of the negative control).
 */
export async function toyPay(tx: Tx, a: ToyPayArgs): Promise<ToyPayResult> {
  const customer = await locks.lockCustomer(tx, a.customerId);
  if (!customer) throw new Error('no such customer');
  const st = await state.readCustomerState(tx, { fn: 'toy_pay', customerId: a.customerId });
  let left = paise(a.amount);
  const receiptId = randomUUID();
  const parts: { billId: string; amount: bigint }[] = [];
  for (const b of st.openBills) {
    if (left === 0n) break;
    const pay = left < paise(b.pending) ? left : paise(b.pending);
    if (pay > 0n) {
      parts.push({ billId: b.id, amount: pay });
      left -= pay;
    }
  }
  await tx.run("INSERT INTO receipts (id, customer_id, kind, mode, amount, paid_on) VALUES (?, ?, 'money', 'UPI', ?, '2026-10-17')", [receiptId, a.customerId, a.amount]);
  for (const p of parts) await tx.run('INSERT INTO receipt_allocations (id, receipt_id, bill_id, customer_id, amount) VALUES (?, ?, ?, ?, ?)', [randomUUID(), receiptId, p.billId, a.customerId, rupees(p.amount)]);
  await touch.touchForReceiptWrite(tx, { customerId: a.customerId, billIds: parts.map((p) => p.billId), at: a.at ?? '2026-10-17 10:00:00.000000' });
  return { receiptId, allocated: rupees(parts.reduce((n, p) => n + p.amount, 0n)), advance: rupees(left), trail: [...tx.trail] };
}

/** What the books say about one customer, worked out from the base tables with plain SQL, independent of the helpers. */
export async function books(w: X0World, customerId: string) {
  const r = await rowOf(
    w.root,
    `SELECT
       (SELECT COALESCE(SUM(amount), 0) FROM ${w.db()}.receipts WHERE customer_id = ? AND status = 'active' AND kind = 'money') AS received,
       (SELECT COALESCE(SUM(a.amount), 0) FROM ${w.db()}.receipt_allocations a JOIN ${w.db()}.receipts r ON r.id = a.receipt_id WHERE a.customer_id = ? AND a.released_at IS NULL AND r.status = 'active') AS allocated,
       (SELECT COALESCE(SUM(grand_total), 0) FROM ${w.db()}.bills WHERE customer_id = ? AND status = 'active') AS billed`,
    [customerId, customerId, customerId],
  );
  const received = paise(String(r.received));
  const allocated = paise(String(r.allocated));
  const billed = paise(String(r.billed));
  return { received: rupees(received), allocated: rupees(allocated), billed: rupees(billed), outstanding: rupees(billed - allocated), advance: rupees(received - allocated), overAllocated: allocated > billed };
}

// ------------------------------------------------------------------ gates: the test side of the hook of X0 item 8

/**
 * One gate holds ONE session at a hook point. `reached` resolves with the point's name when the session arrives; the session stays until release() (called before it arrives, it passes at once).
 * A gate is never held longer than `maxHoldMs` (3 s by default: the lock wait of 5 s must still cut the other session, spec X0 item 8): after that it lets go by itself and says so in `autoReleased`.
 */
export class Gate {
  readonly reached: Promise<string>;
  readonly maxHoldMs: number;
  autoReleased = false;
  reachedAt: number | null = null;
  releasedAt: number | null = null;
  #arrive!: (point: string) => void;
  #open!: () => void;
  readonly #opened: Promise<void>;
  constructor(maxHoldMs = 3000) {
    this.maxHoldMs = maxHoldMs;
    this.reached = new Promise<string>((resolve) => (this.#arrive = resolve));
    this.#opened = new Promise<void>((resolve) => (this.#open = resolve));
  }
  async pass(point: string): Promise<void> {
    if (this.reachedAt === null) {
      this.reachedAt = Date.now();
      this.#arrive(point);
    }
    const timer = setTimeout(() => {
      this.autoReleased = true;
      this.release();
    }, this.maxHoldMs);
    try {
      await this.#opened;
    } finally {
      clearTimeout(timer);
    }
  }
  release(): void {
    this.releasedAt ??= Date.now();
    this.#open();
  }
  /** has the session arrived? (without waiting) */
  get isAtHook(): boolean {
    return this.reachedAt !== null && this.releasedAt === null;
  }
  get heldMs(): number {
    return this.reachedAt === null ? 0 : (this.releasedAt ?? Date.now()) - this.reachedAt;
  }
}

/** The gates of a test, one for each session (each request id). install() puts the wrappers in; restore() takes them out again. */
export class Gates {
  readonly #byRequest = new Map<string, Gate>();
  readonly #unbound: Gate[] = [];
  readonly points: { requestId: string; point: string }[] = [];
  #spies: { mockRestore(): void }[] = [];

  /** The gate of the session whose transaction has this request id (txContext's requestId). */
  forRequest(requestId: string, maxHoldMs?: number): Gate {
    const g = new Gate(maxHoldMs);
    this.#byRequest.set(requestId, g);
    return g;
  }
  /** A gate for the next session that reaches a hook point without a gate of its own (a request made with inject() has an id the test does not know in advance). */
  forNextSession(maxHoldMs?: number): Gate {
    const g = new Gate(maxHoldMs);
    this.#unbound.push(g);
    return g;
  }
  async #at(requestId: string, point: string): Promise<void> {
    this.points.push({ requestId, point });
    let g = this.#byRequest.get(requestId);
    if (!g && this.#unbound.length > 0) {
      g = this.#unbound.shift();
      if (g) this.#byRequest.set(requestId, g);
    }
    await g?.pass(point);
  }
  static install(): Gates {
    const gates = new Gates();
    const realState = state.readCustomerState;
    const realTotals = state.readCustomerTotals;
    gates.#spies.push(
      vi.spyOn(state, 'readCustomerState').mockImplementation(async (r, o) => {
        const out = await realState(r, o);
        await gates.#at(requestIdOf(r), `${o.fn}.after_read`);
        return out;
      }),
      vi.spyOn(state, 'readCustomerTotals').mockImplementation(async (r, o) => {
        const out = await realTotals(r, o);
        await gates.#at(requestIdOf(r), `${o.fn}.after_check`);
        return out;
      }),
    );
    return gates;
  }
  restore(): void {
    for (const s of this.#spies.splice(0)) s.mockRestore();
    for (const g of this.#byRequest.values()) g.release();
    for (const g of this.#unbound) g.release();
  }
}
const requestIdOf = (r: unknown): string => String((r as { requestId?: string }).requestId ?? '');

/** The negative control of X0 item 8: the customer-lock helpers replaced by versions that note the step and read the row but take NO lock (the reviewer's noCustomerLock). Returns the undo. */
export function withoutCustomerLock(): () => void {
  const a = vi.spyOn(locks, 'lockCustomer').mockImplementation(async (tx, id) => {
    locks.noteStep(tx, 'customer', id);
    const rows = await tx.rows<locks.CustomerLockRow>('SELECT id, name, mobile, customer_type, gst_number, pan, is_walkin, archived_at FROM customers WHERE id = ?', [id]);
    return rows[0] ?? null;
  });
  const b = vi.spyOn(locks, 'lockCustomerOf').mockImplementation(async (tx, table, id) => {
    const found = await tx.rows<{ customer_id: string }>(table === 'receipts' ? 'SELECT customer_id FROM receipts WHERE id = ?' : 'SELECT customer_id FROM bills WHERE id = ?', [id]);
    if (found.length === 0) return null;
    locks.noteStep(tx, 'customer', found[0].customer_id);
    const customer = (await tx.rows<locks.CustomerLockRow>('SELECT id, name, mobile, customer_type, gst_number, pan, is_walkin, archived_at FROM customers WHERE id = ?', [found[0].customer_id]))[0];
    const row = (await tx.rows<locks.LockedRow>(table === 'receipts' ? 'SELECT * FROM receipts WHERE id = ?' : 'SELECT * FROM bills WHERE id = ?', [id]))[0];
    return { customer, row };
  });
  return () => {
    a.mockRestore();
    b.mockRestore();
  };
}

// ------------------------------------------------------------------ the wrong piece helper of the T-C21 control

/**
 * The mistake the spec warns about: ids sorted in code and locked ONE AT A TIME. `between` is the pause point `lock_pieces.between` of the test build: it is the only helper that has anything between two
 * locks (the real one is a single statement), so the hook lives with it. Writes its step like the real helper, so the trail check cannot tell the two apart (it cannot, X0 item 5).
 */
export async function lockPiecesWrong(tx: Tx, ids: readonly string[], between: (lockedSoFar: number) => Promise<void> = async () => undefined): Promise<{ id: string }[]> {
  locks.noteStep(tx, 'pieces');
  const rows: { id: string }[] = [];
  for (const id of [...ids].sort()) {
    rows.push(...(await tx.rows<{ id: string }>('SELECT id FROM skus WHERE id = ? FOR UPDATE', [id])));
    await between(rows.length);
  }
  return rows;
}

// ------------------------------------------------------------------ small things

/** The first row of a query, untyped. */
export async function rowOf(c: Connection, sql: string, params: unknown[] = []): Promise<any> {
  const [rows] = await c.query<any[]>(sql, params);
  return (rows as any[])[0];
}

export function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

/**
 * Waits until `n` statements have been running for at least `minMs` (default 100 ms): on these tests that is a statement waiting for a row lock, since every other statement answers in a few
 * milliseconds. Read from the process list as root (the ten-box user may not). information_schema.INNODB_TRX would say "LOCK WAIT" directly, but InnoDB serves it from a cache that is refreshed only
 * when it has not been read for 100 ms: polled faster it never changes, and read at the start of the next round it still shows the last round's wait.
 */
export async function waitForLockWaits(root: Connection, n: number, timeoutMs = 4000, minMs = 100): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    const [rows] = await root.query<any[]>("SELECT COUNT(*) AS n FROM information_schema.PROCESSLIST WHERE COMMAND IN ('Query', 'Execute') AND INFO IS NOT NULL AND INFO NOT LIKE '%PROCESSLIST%' AND TIME_MS >= ?", [minMs]);
    if (Number(rows[0].n) >= n) return;
    if (Date.now() - t0 > timeoutMs) throw new Error(`no ${n} statement(s) waiting for a lock after ${timeoutMs} ms`);
    await new Promise((r) => setTimeout(r, 20));
  }
}
