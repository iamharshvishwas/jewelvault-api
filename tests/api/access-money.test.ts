import { randomUUID } from 'node:crypto';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Reader } from '../../src/db/tx';
import { applyCashRules } from '../../src/domain/cashRules';
import type { JvError } from '../../src/errors';
import { checkBillDate } from '../../src/money/x07QuoteBill';
import { type Grants, NO_GRANTS, grantsOf } from '../../src/permissions/grants';
import type { Action } from '../../src/permissions/matrix';
import { assertMayCall } from '../../src/permissions/route';
import { TICK_KEYS, type TickKey, closeOverNeeds } from '../../src/permissions/ticks';
import { csrfHeaders } from './support';
import { type Designs, type EditWorld, TODAY, addCustomer, addDesigns, billBody, body, codeOf, countOf, editWorld, errorField, footprint, item, piece, requestIdOf, rows } from './x01-support';
import { addBill, addMoney } from './x02-support';
import { addFineBill, cashFine, silver } from './x03-support';
import { line, reissueBody, sell } from './x10-support';

// Task 6 of the access plan (R4, R8; DESIGN.md 6.2, 6.3, P2, P3): the ten money functions (X1 to X7, X10 to X12) and the cash rules ask the PERSON'S ticks (`auth.user.grants`, read from the database on
// every request), not the role's name. Until this task the function's own second check (X0 item 2, defence in depth) resolved the role KEY through the built-in sets, so a custom role that passed the
// route gate on its ticks was refused again by the function itself.
//
// The roles here are CUSTOM: a key that is none of owner, biller and staff, made with World.addRole, holding exactly the ticks the test gives (and what the API would force with them, closeOverNeeds:
// a role is saved with the ticks it needs). The three built-in roles are covered by the x01 to x12 tests, which stay as they were.
//
// The world is the scratch database of the other money tests (the real routes, the seeds, the generated audit triggers, a clock fixed at 17 Oct 2026 10:00 UTC = 15:30 in Kolkata, "today" is
// 2026-10-17). The books a call needs are typed in by SQL or made by the real routes; the figures are written in the test.

let w: EditWorld;
let d: Designs;

beforeAll(async () => {
  w = await editWorld('accmoney', { triggers: true });
  d = await addDesigns(w);
}, 120_000);
afterAll(async () => {
  await w?.world.close();
}, 60_000);

// ------------------------------------------------------------------ people and calls

/** A person in a custom role holding exactly `ticks`, with a live session; `grants` is what the session will read for them. */
async function person(ticks: readonly string[]) {
  const role = await w.world.addRole({ ticks });
  const user = await w.world.addUser({ role: role.key });
  return { ...user, roleKey: role.key, grants: grantsOf({ roleKey: role.key, roleTicks: ticks, isSuperAdmin: false }) };
}
type Person = Awaited<ReturnType<typeof person>>;

interface Call {
  url: string;
  payload: unknown;
}

/** Every call of the ten is a POST with the two headers of the CSRF layers and an Idempotency-Key (a new one unless given; the quote takes none and ignores it). */
const send = (who: { cookie: string }, call: Call, key: string = randomUUID()): Promise<LightMyRequestResponse> =>
  w.world.app.inject({ method: 'POST', url: call.url, headers: { ...csrfHeaders(), cookie: who.cookie, 'idempotency-key': key }, payload: call.payload as object });

/** What a call that is refused or that only reads must leave as it found it: the books, the claims, the audit rows, the counters, the customers. */
async function trace(): Promise<Record<string, number | string>> {
  return { ...(await footprint(w)), customer_rows: await countOf(w, 'customers') };
}

/** The code a function throws, or undefined when it does not. */
function thrownCode(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (e) {
    return (e as JvError).code;
  }
}

const PAST = '2026-10-10';

// ------------------------------------------------------------------ the ten

interface Scenario {
  action: Action;
  tick: TickKey;
  /** the status of a call that is done */
  ok: 200 | 201;
  /** the books the call needs (typed by SQL or made by the real routes) and the call itself; `date` is a business date for the call to carry (only the functions that take one) */
  prepare: (date?: string) => Promise<Call>;
  /** the functions that take a business date: the input that carries it, and where the answer shows it */
  dated?: { field: string; shows: (answer: any) => unknown };
}

const mobile = () => `97${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;

const SCENARIOS: Scenario[] = [
  {
    action: 'fn:create_bill',
    tick: 'bill_make',
    ok: 201,
    dated: { field: 'bill_date', shows: (a) => a.bill.bill_date },
    async prepare(date) {
      const c = await addCustomer(w);
      const p = await piece(w, d.gold24pp, { retail: '1000.00' });
      return { url: '/v1/bills', payload: billBody(c, 'Retail', [item(p, { metal_rate: '1000.00' })], date ? { bill_date: date } : {}) };
    },
  },
  {
    action: 'fn:quote_bill',
    tick: 'bill_make',
    ok: 200,
    dated: { field: 'bill_date', shows: (a) => a.bill_date },
    async prepare(date) {
      const p = await piece(w, d.gold24pp, { retail: '1000.00' });
      return { url: '/v1/bills/quote', payload: { sale_type: 'Retail', items: [item(p, { metal_rate: '1000.00' })], ...(date ? { bill_date: date } : {}) } };
    },
  },
  {
    action: 'fn:record_payment',
    tick: 'payment_receive',
    ok: 201,
    dated: { field: 'paid_on', shows: (a) => a.receipt.paid_on },
    async prepare(date) {
      const c = await addCustomer(w);
      await addBill(w, c, '1000.00', '2026-10-01');
      return { url: `/v1/customers/${c}/payments`, payload: { amount: '100.00', mode: 'UPI', ...(date ? { paid_on: date } : {}) } };
    },
  },
  {
    action: 'fn:settle_fine',
    tick: 'payment_receive',
    ok: 201,
    dated: { field: 'paid_on', shows: (a) => a.receipt.paid_on },
    async prepare(date) {
      const c = await addCustomer(w);
      await addFineBill(w, c, '1000.00', '10.000', '2026-10-01');
      return { url: `/v1/customers/${c}/fine-settlements`, payload: silver('4.000', date ? { paid_on: date } : {}) };
    },
  },
  {
    action: 'fn:void_receipt',
    tick: 'payment_void',
    ok: 200,
    async prepare() {
      const c = await addCustomer(w);
      const receipt = await addMoney(w, c, '100.00', PAST);
      return { url: `/v1/receipts/${receipt}/void`, payload: { reason: 'entered twice by mistake' } };
    },
  },
  {
    action: 'fn:cancel_bill',
    tick: 'bill_cancel',
    ok: 200,
    async prepare() {
      const c = await addCustomer(w);
      const bill = await addBill(w, c, '1000.00', '2026-10-01');
      return { url: `/v1/bills/${bill}/cancel`, payload: { reason: 'the customer returned the goods' } };
    },
  },
  {
    action: 'fn:create_customer',
    tick: 'customer_edit',
    ok: 201,
    async prepare() {
      return { url: '/v1/customers', payload: { name: 'Access Test Customer', mobile: mobile() } };
    },
  },
  {
    action: 'fn:reissue_bill',
    tick: 'bill_reissue',
    ok: 201,
    dated: { field: 'bill_date', shows: (a) => a.new_bill.bill_date },
    async prepare(date) {
      const c = await addCustomer(w);
      const old = await sell(w, d, c, '1000.00');
      return { url: `/v1/bills/${old.id}/reissue`, payload: reissueBody('Retail', [line(old.piece, '1000.00')], date ? { bill_date: date } : {}) };
    },
  },
  {
    action: 'fn:issue_refund',
    tick: 'refund_give',
    ok: 201,
    dated: { field: 'paid_on', shows: (a) => a.receipt.paid_on },
    async prepare(date) {
      const c = await addCustomer(w);
      await addMoney(w, c, '500.00', PAST);
      return { url: `/v1/customers/${c}/refunds`, payload: { amount: '100.00', mode: 'UPI', ...(date ? { paid_on: date } : {}) } };
    },
  },
  {
    action: 'fn:add_opening_balance',
    tick: 'opening_balance',
    ok: 201,
    dated: { field: 'as_of', shows: (a) => a.bill.bill_date },
    async prepare(date) {
      const c = await addCustomer(w);
      return { url: `/v1/customers/${c}/opening-balance`, payload: { as_of: date ?? TODAY, dues: '500.00' } };
    },
  },
];
const scenario = (action: Action): Scenario => SCENARIOS.find((s) => s.action === action) as Scenario;
const closeOf = (s: Scenario, ...more: TickKey[]): TickKey[] => closeOverNeeds([s.tick, ...more]);

describe('the ten money functions ask the ticks of the person who calls (X0 item 2, R4)', () => {
  it.each(SCENARIOS)(
    '$action: a custom role with only $tick passes the gate and assertMayCall; a role with every other tick gets 403 JV_FORBIDDEN and nothing is written',
    async (s) => {
      const mine = await person(closeOf(s));
      const others = await person(TICK_KEYS.filter((t) => t !== s.tick));

      // assertMayCall by itself, on the grants each person's session reads, and on literally only the tick (no need, no read tick)
      expect(thrownCode(() => assertMayCall(mine.grants, s.action))).toBeUndefined();
      expect(thrownCode(() => assertMayCall(grantsOf({ roleKey: 'xbare', roleTicks: [s.tick], isSuperAdmin: false }), s.action))).toBeUndefined();
      expect(thrownCode(() => assertMayCall(others.grants, s.action))).toBe('JV_FORBIDDEN');

      const call = await s.prepare();
      const before = await trace();

      // every tick but the one: refused by the gate, and nobody has written, claimed or logged anything
      const refused = await send(others, call);
      expect(refused.statusCode, refused.body).toBe(403);
      expect(codeOf(refused)).toBe('JV_FORBIDDEN');
      expect(await trace(), 'the refused call left something behind').toEqual(before);

      // only the tick: through the gate, through the function's own check, and done
      const done = await send(mine, call);
      expect(done.statusCode, done.body).toBe(s.ok);
      if (s.action === 'fn:quote_bill') expect(await trace(), 'a quote writes nothing').toEqual(before);
      else expect(await trace(), 'the call that was allowed wrote nothing').not.toEqual(before);
    },
  );

  it('the audit trail names the role KEY, not the ticks: a payment by a custom role is logged with the person as the actor and the key of the role as the actor role', async () => {
    const mine = await person(closeOf(scenario('fn:record_payment')));
    const res = await send(mine, await scenario('fn:record_payment').prepare());
    expect(res.statusCode, res.body).toBe(201);
    const log = await rows(w, 'SELECT actor, actor_role, table_name FROM audit_log WHERE request_id = ?', [requestIdOf(res)]);
    expect(log.map((x) => x.table_name).sort()).toEqual(['receipt_allocations', 'receipts']);
    for (const x of log) {
      expect(x.actor).toBe(mine.userId);
      expect(x.actor_role).toBe(mine.roleKey);
    }
  });

  it('the answer is shaped by what the person may read: a role that holds customer_edit without customer_view (a set the API would not save, a hand edit can make) passes the gate, is refused when the new customer is to be shown to it, and nothing is written', async () => {
    const odd = await person(['customer_edit']);
    const call = await scenario('fn:create_customer').prepare();
    const before = await trace();
    const res = await send(odd, call);
    expect(res.statusCode, res.body).toBe(403);
    expect(codeOf(res)).toBe('JV_FORBIDDEN');
    expect(await trace(), 'the customer was saved although it could not be answered').toEqual(before);
  });

  it('the Super Admin flag alone holds every tick whatever the role key is (R3, R4): a login flagged on the staff role records a payment, which no staff role may', async () => {
    const flagged = await w.world.addUser({ role: 'staff', superAdmin: true });
    const unflagged = await w.world.addUser({ role: 'staff' });
    const call = await scenario('fn:record_payment').prepare();
    const refused = await send(unflagged, call);
    expect(refused.statusCode, refused.body).toBe(403);
    const done = await send(flagged, call);
    expect(done.statusCode, done.body).toBe(201);
  });
});

// ------------------------------------------------------------------ cash over the limit

describe('cash over the limit: a reason is accepted only for a role holding cash_over_limit (Z1; X1, X2, X3)', () => {
  const REASON = 'abcdefghij'; // exactly 10 characters
  let allowed: Person;
  let plain: Person;

  beforeAll(async () => {
    // the same role twice: payment_receive, bill_make and what they need, the one with cash_over_limit as well (which itself needs payment_receive)
    allowed = await person(closeOverNeeds(['bill_make', 'cash_over_limit']));
    plain = await person(closeOverNeeds(['bill_make', 'payment_receive']));
  });

  /** The same call by the two roles, in the order that shows what the tick buys: the limit stops both; a reason from the role without the tick is 403 and nothing is left (the key stays free); with the tick it is saved. */
  async function limitAndReason(call: Call, withReason: Call, saved: (res: LightMyRequestResponse) => Promise<void>) {
    const stopped = await send(plain, call);
    expect(stopped.statusCode, stopped.body).toBe(409);
    expect(codeOf(stopped)).toBe('JV_CASH_LIMIT');
    const stoppedToo = await send(allowed, call);
    expect(stoppedToo.statusCode, stoppedToo.body).toBe(409);
    expect(codeOf(stoppedToo)).toBe('JV_CASH_LIMIT');
    expect(body(stoppedToo).error.message, 'the answer says what lets it through').toMatch(/reason/i);

    const key = randomUUID();
    const before = await trace();
    const refused = await send(plain, withReason, key);
    expect(refused.statusCode, refused.body).toBe(403);
    expect(codeOf(refused)).toBe('JV_FORBIDDEN');
    expect(errorField(refused)).toBe('cash_override_reason');
    expect(await trace(), 'the refused reason left something behind').toEqual(before);

    const done = await send(allowed, withReason, key); // the same key: the claim of the refused call was rolled back, so this is a first use
    expect(done.statusCode, done.body).toBe(201);
    expect(done.headers['idempotent-replay']).toBeUndefined();
    await saved(done);
  }

  it('X2 record_payment: Cash of 2,00,000.00 reaches the limit; the reason is stored on the receipt for cash_over_limit and refused for a role without it', async () => {
    const c = await addCustomer(w);
    const url = `/v1/customers/${c}/payments`;
    await limitAndReason({ url, payload: { amount: '200000.00', mode: 'Cash' } }, { url, payload: { amount: '200000.00', mode: 'Cash', cash_override_reason: `  ${REASON} ` } }, async (res) => {
      expect(body(res).receipt.cash_override_reason).toBe(REASON);
      expect((await rows(w, 'SELECT amount, cash_override_reason FROM receipts WHERE customer_id = ?', [c])).map((r) => [r.amount, r.cash_override_reason])).toEqual([['200000.00', REASON]]);
    });
  });

  it('X3 settle_fine: a fine settled in Cash that reaches the limit (2,000 g at 100.00): the same', async () => {
    const c = await addCustomer(w);
    await addFineBill(w, c, '1000.00', '5000.000', '2026-10-01');
    const url = `/v1/customers/${c}/fine-settlements`;
    await limitAndReason({ url, payload: cashFine('2000.000', '100.00') }, { url, payload: cashFine('2000.000', '100.00', { cash_override_reason: ` ${REASON}` }) }, async (res) => {
      expect(body(res).receipt.cash_override_reason).toBe(REASON);
      expect((await rows(w, 'SELECT kind, amount, cash_override_reason FROM receipts WHERE customer_id = ?', [c])).map((r) => [r.kind, r.amount, r.cash_override_reason])).toEqual([['fine_cash', '200000.00', REASON]]);
    });
  });

  it('X1 create_bill: a Cash payment row of 2,00,000.00 on a bill of 3,00,000.00: the reason is stored on the bill', async () => {
    const c = await addCustomer(w);
    const p = await piece(w, d.gold24pp, { retail: '300000.00' });
    const bill = (extra: Record<string, unknown>): Call => ({ url: '/v1/bills', payload: billBody(c, 'Retail', [item(p, { metal_rate: '300000.00' })], { payments: [{ mode: 'Cash', amount: '200000.00' }], ...extra }) });
    await limitAndReason(bill({}), bill({ cash_override_reason: REASON }), async (res) => {
      expect(body(res).bill.cash_override_reason).toBe(REASON);
      expect((await rows(w, 'SELECT cash_override_reason FROM bills WHERE customer_id = ?', [c])).map((r) => r.cash_override_reason)).toEqual([REASON]);
    });
  });

  it('applyCashRules takes grants: the person who holds cash_over_limit may override with a reason, everybody else is stopped (the Super Admin flag holds the tick too)', async () => {
    const reader = { rows: async () => [{ total: null }] } as unknown as Reader; // a customer with no cash today
    const input = (grants: Grants) => ({ customerId: randomUUID(), walkin: false, day: TODAY, cash: 20_000_000n, grants, reason: REASON });
    await expect(applyCashRules(reader, input(allowed.grants))).resolves.toEqual({ reason: REASON });
    await expect(applyCashRules(reader, input(grantsOf({ roleKey: 'staff', roleTicks: [], isSuperAdmin: true })))).resolves.toEqual({ reason: REASON });
    for (const grants of [plain.grants, NO_GRANTS, grantsOf({ roleKey: 'xall', roleTicks: TICK_KEYS.filter((t) => t !== 'cash_over_limit'), isSuperAdmin: false })]) {
      await expect(applyCashRules(reader, input(grants))).rejects.toMatchObject({ code: 'JV_CASH_LIMIT' });
    }
  });
});

// ------------------------------------------------------------------ back-dating

describe('back-dating: a past date needs the back_date tick (Y8; checkBillDate in X1, X2, X3, X7, X10, X11, X12)', () => {
  const holder = grantsOf({ roleKey: 'xback', roleTicks: ['back_date'], isSuperAdmin: false });
  const lacking = grantsOf({ roleKey: 'xnone', roleTicks: TICK_KEYS.filter((t) => t !== 'back_date'), isSuperAdmin: false });
  const refusal = (fn: () => unknown): { code: string | undefined; field: string | undefined; message: string } => {
    try {
      fn();
    } catch (e) {
      return { code: (e as JvError).code, field: (e as { field?: string }).field, message: (e as Error).message };
    }
    return { code: undefined, field: undefined, message: '' };
  };

  it('checkBillDate refuses a past date without back_date and accepts it with back_date; a future date is refused for everybody; no date is today', () => {
    expect(checkBillDate(PAST, TODAY, holder)).toBe(PAST);
    expect(checkBillDate(PAST, TODAY, grantsOf({ roleKey: 'staff', roleTicks: [], isSuperAdmin: true }))).toBe(PAST); // the Super Admin flag holds every tick
    expect(refusal(() => checkBillDate(PAST, TODAY, lacking))).toEqual({ code: 'JV_INVALID_INPUT', field: 'bill_date', message: 'bill_date must be today' });
    expect(refusal(() => checkBillDate(PAST, TODAY, lacking, 'paid_on'))).toEqual({ code: 'JV_INVALID_INPUT', field: 'paid_on', message: 'paid_on must be today' });
    expect(refusal(() => checkBillDate(PAST, TODAY, NO_GRANTS, 'as_of')).field).toBe('as_of');
    for (const grants of [holder, lacking]) {
      expect(refusal(() => checkBillDate('2026-10-18', TODAY, grants, 'as_of'))).toEqual({ code: 'JV_INVALID_INPUT', field: 'as_of', message: 'as_of must not be in the future' });
      expect(checkBillDate(TODAY, TODAY, grants)).toBe(TODAY);
      expect(checkBillDate(null, TODAY, grants)).toBe(TODAY);
      expect(checkBillDate(undefined, TODAY, grants)).toBe(TODAY);
    }
  });

  it.each(SCENARIOS.filter((s) => s.dated))('$action: a past date is 422 on $dated.field for a role without back_date, and saved as sent for the role with it', async (s) => {
    const without = await person(closeOf(s));
    const withTick = await person(closeOf(s, 'back_date'));
    const call = await s.prepare(PAST);
    const before = await trace();
    const refused = await send(without, call);
    expect(refused.statusCode, refused.body).toBe(422);
    expect(codeOf(refused)).toBe('JV_INVALID_INPUT');
    expect(errorField(refused)).toBe(s.dated?.field);
    expect(await trace(), 'the refused date left something behind').toEqual(before);

    const done = await send(withTick, call); // the same call on the same books
    expect(done.statusCode, done.body).toBe(s.ok);
    expect(s.dated?.shows(body(done))).toBe(PAST);
  });
});
