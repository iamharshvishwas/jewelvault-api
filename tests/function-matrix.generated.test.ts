import { randomUUID } from 'node:crypto';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Action, MATRIX, READ_COLUMNS, type Role } from '../src/permissions/matrix';
import { CALLERS, type CallerName } from './api/cells';
import { type EditWorld, editWorld } from './api/edit-support';
import { SYNC_ROWS } from './api/sync-support';
import { designPayload } from './api/stock-support';
import { billBody, item, piece, setEstimate, addDesigns, addRate, type Designs } from './api/x01-support';
import { addBill, addCustomer, addMoney, rows } from './api/x02-support';
import { addFineBill } from './api/x03-support';
import { line, reissueBody, sell } from './api/x10-support';

// API31, T-D09 (A6, A4) and the T-D03 clause (D9, D12, A4, A14): THE GENERATED FUNCTION MATRIX. For each of the twelve service functions X1 to X12 and each caller of A4 (no session, an ended, an expired
// and an idle session, a user who is not active, a user who must still change the password, staff, a biller, the owner) one REAL call with a valid body and fresh fixtures is made, and the answer must be
// the one the spec gives: no session none; staff only X8 and X9; a biller X1, X2, X3, X6 and X7 but not X4, X5, X10, X11 and X12; the owner all. A refused call writes nothing and reads nothing but the
// session. An allowed call is saved (and X7, which only quotes, writes nothing). Then the field rules: a biller's cash override is JV_FORBIDDEN, a past date from a biller is JV_INVALID_INPUT, the
// original weight from staff is JV_FORBIDDEN, and the owner may do all three.
//
// The expectation is typed here from the spec (SPEC below), NOT read from src/permissions/matrix.ts, so a wrong row of the matrix fails; the rows of the matrix are listed from the matrix, so a
// thirteenth function added there is walked at once (a function with no scenario fails the test that lists them). tests/matrix.generated.test.ts (T-D02) walks every row of the matrix with a stub body;
// this walk uses the bodies of the real functions, so the callers that ARE let in really get an answer.
//
// The T-D03 clause scans every result of every role, the function results above and every read of the matrix, for the key `original_net_weight` and for the weight itself, and finds them only in the
// owner's own reads (and in the owner's own answers of X8 and of the edit of the weight).

// ------------------------------------------------------------------ the expectation, from the spec (T-D09)

const X: Record<string, { n: string; roles: readonly Role[] }> = {
  'fn:create_bill': { n: 'X1', roles: ['owner', 'biller'] },
  'fn:record_payment': { n: 'X2', roles: ['owner', 'biller'] },
  'fn:settle_fine': { n: 'X3', roles: ['owner', 'biller'] },
  'fn:void_receipt': { n: 'X4', roles: ['owner'] },
  'fn:cancel_bill': { n: 'X5', roles: ['owner'] },
  'fn:create_customer': { n: 'X6', roles: ['owner', 'biller'] },
  'fn:quote_bill': { n: 'X7', roles: ['owner', 'biller'] },
  'fn:create_design': { n: 'X8', roles: ['owner', 'staff'] },
  'fn:set_sku_status': { n: 'X9', roles: ['owner', 'staff'] },
  'fn:reissue_bill': { n: 'X10', roles: ['owner'] },
  'fn:issue_refund': { n: 'X11', roles: ['owner'] },
  'fn:add_opening_balance': { n: 'X12', roles: ['owner'] },
};
const ACTIONS = Object.keys(X) as Action[];

type Expected = { allowed: true } | { allowed: false; status: number; code: string };
/** T-D09 for one cell, typed from the spec: who is let in, and how everybody else is turned away. */
function expectedFor(action: Action, caller: CallerName): Expected {
  switch (caller) {
    case 'anon':
    case 'ended':
    case 'inactive':
      return { allowed: false, status: 401, code: 'JV_UNAUTHENTICATED' };
    case 'expired':
    case 'idle':
      return { allowed: false, status: 401, code: 'JV_SESSION_EXPIRED' };
    case 'must_change':
      return { allowed: false, status: 403, code: 'JV_PASSWORD_CHANGE_REQUIRED' };
    default:
      return X[action].roles.includes(caller) ? { allowed: true } : { allowed: false, status: 403, code: 'JV_FORBIDDEN' };
  }
}

// ------------------------------------------------------------------ the world

const DAY = '2026-10-16'; // yesterday of the fixture clock (17 Oct 2026, 10:00 UTC)
const PAST = '2026-10-15';
const ORIGINAL = '98.765'; // the owner-only weight: no other value in this file is spelled like it
let w: EditWorld;
let d: Designs;

beforeAll(async () => {
  w = await editWorld('x31fm', { triggers: true });
  d = await addDesigns(w);
  await setEstimate(w, { prefix: 'FM', roundOff: true });
  await addRate(w, 'Gold', '22K', '6900.00', '2026-10-17');
}, 120_000);
afterAll(async () => {
  await w?.world.close();
}, 60_000);

interface Call {
  method: string;
  url: string;
  payload: unknown;
}
let mobiles = 0;
const newKey = (): string => randomUUID();

/** A valid call of each function on fresh fixtures (typed by SQL, or made by an earlier real call), so that every cell succeeds when the caller is let in. */
const SCENARIOS: Record<string, () => Promise<Call>> = {
  'fn:create_bill': async () => {
    const c = await addCustomer(w);
    const p = await piece(w, d.gold24pp, { retail: '10.00' });
    return { method: 'POST', url: '/v1/bills', payload: billBody(c, 'Retail', [item(p, { metal_rate: '10.00' })]) };
  },
  'fn:record_payment': async () => {
    const c = await addCustomer(w);
    await addBill(w, c, '1000.00', DAY);
    return { method: 'POST', url: `/v1/customers/${c}/payments`, payload: { amount: '100.00', mode: 'UPI' } };
  },
  'fn:settle_fine': async () => {
    const c = await addCustomer(w);
    await addFineBill(w, c, '1000.00', '5.000', DAY);
    return { method: 'POST', url: `/v1/customers/${c}/fine-settlements`, payload: { grams: '1.000', mode: 'Silver' } };
  },
  'fn:void_receipt': async () => {
    const c = await addCustomer(w);
    const r = await addMoney(w, c, '100.00', DAY);
    return { method: 'POST', url: `/v1/receipts/${r}/void`, payload: { reason: 'entered twice by mistake' } };
  },
  'fn:cancel_bill': async () => {
    const c = await addCustomer(w);
    const b = await addBill(w, c, '1000.00', DAY);
    return { method: 'POST', url: `/v1/bills/${b}/cancel`, payload: { reason: 'the customer returned the goods' } };
  },
  'fn:create_customer': async () => ({ method: 'POST', url: '/v1/customers', payload: { name: 'Meera Soni', mobile: `97${String(20_000_000 + ++mobiles)}` } }),
  'fn:quote_bill': async () => {
    const p = await piece(w, d.gold24pp, { retail: '10.00' });
    return { method: 'POST', url: '/v1/bills/quote', payload: { sale_type: 'Retail', items: [item(p, { metal_rate: '10.00' })] } };
  },
  'fn:create_design': async () => ({ method: 'POST', url: '/v1/designs', payload: designPayload(w) }),
  'fn:set_sku_status': async () => {
    const p = await piece(w, d.gold24pp, { retail: '10.00' });
    return { method: 'POST', url: '/v1/skus/status', payload: { sku_ids: [p], status: 'Repair' } };
  },
  'fn:reissue_bill': async () => {
    const c = await addCustomer(w);
    const made = await sell(w, d, c, '100.00');
    return { method: 'POST', url: `/v1/bills/${made.id}/reissue`, payload: reissueBody('Retail', [line(made.piece, '120.00')]) };
  },
  'fn:issue_refund': async () => {
    const c = await addCustomer(w);
    await addMoney(w, c, '200.00', DAY);
    return { method: 'POST', url: `/v1/customers/${c}/refunds`, payload: { amount: '50.00', mode: 'UPI' } };
  },
  'fn:add_opening_balance': async () => {
    const c = await addCustomer(w);
    return { method: 'POST', url: `/v1/customers/${c}/opening-balance`, payload: { dues: '100.00', as_of: DAY } };
  },
};

const send = (caller: CallerName, call: Call, key: string | null = newKey()): Promise<LightMyRequestResponse> =>
  w.world.call(caller, call.method, call.url, { payload: call.payload, headers: key === null ? {} : { 'idempotency-key': key } });

/** Everything a refused call must leave as it found it: rows of every table a function writes, the sum of the counters, the newest stamp of each. */
async function books(): Promise<string> {
  const out: Record<string, unknown> = {};
  for (const t of ['designs', 'skus', 'sku_private', 'customers', 'bills', 'bill_items', 'receipts', 'receipt_allocations', 'sys_idempotency', 'audit_log']) out[t] = Number((await rows(w, `SELECT COUNT(*) AS n FROM \`${t}\``))[0].n);
  out.counters = String((await rows(w, 'SELECT COALESCE(SUM(last_value), 0) AS n FROM sys_counters'))[0].n);
  for (const t of ['customers', 'bills', 'receipts', 'skus']) out[`${t}_stamp`] = String((await rows(w, `SELECT COALESCE(MAX(updated_at), '') AS m FROM \`${t}\``))[0].m);
  return JSON.stringify(out);
}

/** Statements that read the session and the user, and the checkout's own SET SESSION: all a refused caller may cause (D2, A10). The end-mark of an expired session is the one write (U4). */
const isSessionRead = (sql: string): boolean => /^SELECT\b[\s\S]*\bFROM\s+(sessions|users)\b/i.test(sql.trim()) || /^SET SESSION\b/i.test(sql.trim());
const isEndMark = (sql: string): boolean => /^UPDATE\s+sessions\s+SET\s+revoked_at\s*=\s*\?\s+WHERE\s+id\s*=\s*\?\s+AND\s+revoked_at\s+IS\s+NULL$/i.test(sql.trim());

interface Cell {
  action: Action;
  caller: CallerName;
  res: LightMyRequestResponse;
  problems: string[];
}

/** One cell: the real call of `action` by `caller`, checked against `expected`. Returns the answer and every way it differs from what the spec says. */
async function runCell(action: Action, caller: CallerName, expected: Expected = expectedFor(action, caller)): Promise<Cell> {
  const call = await SCENARIOS[action]();
  const before = await books();
  const sent = w.world.spy.sent.length;
  const res = await send(caller, call);
  await w.world.restore(caller); // a call may have ended or moved the session
  const after = await books();
  const code = (JSON.parse(res.body || 'null') as { error?: { code: string } } | null)?.error?.code;
  const problems: string[] = [];
  const label = `${X[action].n} ${action} by ${caller}`;
  if (expected.allowed) {
    if (res.statusCode !== 200 && res.statusCode !== 201) problems.push(`${label}: the spec lets ${caller} in and the answer was ${res.statusCode} ${code ?? ''} ${res.body.slice(0, 160)}`);
    else if (action === 'fn:quote_bill' ? after !== before : after === before) problems.push(`${label}: ${action === 'fn:quote_bill' ? 'a quote wrote something' : 'a saved call left the books as they were'}`);
  } else {
    if (res.statusCode !== expected.status || code !== expected.code) problems.push(`${label}: the spec says ${expected.status} ${expected.code}, the answer was ${res.statusCode} ${code ?? ''}`);
    if (after !== before) problems.push(`${label}: a refused call changed the books`);
    const stray = w.world.spy.sqls().slice(sent).filter((s) => !isSessionRead(s) && !(!expected.allowed && expected.code === 'JV_SESSION_EXPIRED' && isEndMark(s)));
    if (stray.length > 0) problems.push(`${label}: a refused call caused a statement other than the session and user reads: ${stray[0].slice(0, 80)}`);
  }
  return { action, caller, res, problems };
}

// ------------------------------------------------------------------ T-D09: the matrix

describe('T-D09 the function matrix: X1 to X12 for the callers of A4, generated (a real call with a valid body for each cell)', () => {
  it('the matrix has exactly the twelve service functions of the spec, with the roles the spec gives: staff only X8 and X9, a biller X1, X2, X3, X6 and X7 but not X4, X5, X10, X11 and X12, the owner all', () => {
    const fn = Object.entries(MATRIX).filter(([, r]) => r.kind === 'fn');
    expect(fn.map(([a]) => a).sort()).toEqual([...ACTIONS].sort());
    for (const [action, row] of fn) expect([...row.roles].sort(), `${action} (${X[action].n})`).toEqual([...X[action].roles].sort());
    // the spec's sentence, as the roles of the typed table
    const may = (role: Role) => ACTIONS.filter((a) => X[a].roles.includes(role)).map((a) => X[a].n);
    expect(may('staff')).toEqual(['X8', 'X9']);
    expect(may('biller')).toEqual(['X1', 'X2', 'X3', 'X6', 'X7']);
    expect(may('owner')).toEqual(['X1', 'X2', 'X3', 'X4', 'X5', 'X6', 'X7', 'X8', 'X9', 'X10', 'X11', 'X12']);
    // every one has a route and a scenario here
    const registered = new Set(w.world.app.routeTable.map((r) => r.action));
    for (const a of ACTIONS) {
      expect(registered.has(a), `${a} has no route`).toBe(true);
      expect(SCENARIOS[a], `${a} has no scenario in this test`).toBeDefined();
    }
  });

  for (const action of ACTIONS) {
    describe(`${X[action].n} ${action} ${MATRIX[action].method} ${MATRIX[action].path} [${X[action].roles.join(',')}]`, () => {
      for (const caller of CALLERS) {
        it(`${caller}`, async () => {
          const cell = await runCell(action, caller);
          expect(cell.problems).toEqual([]);
        });
      }
    });
  }

  it('NEGATIVE CONTROL: a cell checked against a wrong expectation (a biller let into X4, the owner turned away from X10) FAILS', async () => {
    const wrongBiller = await runCell('fn:void_receipt', 'biller', { allowed: true });
    expect(wrongBiller.problems.length, 'a biller was expected to be let in; the answer was 403 and the check did not notice').toBeGreaterThan(0);
    const wrongOwner = await runCell('fn:reissue_bill', 'owner', { allowed: false, status: 403, code: 'JV_FORBIDDEN' });
    expect(wrongOwner.problems.length).toBeGreaterThan(0);
    const wrongAnon = await runCell('fn:create_bill', 'anon', { allowed: false, status: 403, code: 'JV_FORBIDDEN' });
    expect(wrongAnon.problems.length).toBeGreaterThan(0);
  });
});

// ------------------------------------------------------------------ T-D09: the field rules

describe('T-D09 the field rules: a biller\'s cash override is JV_FORBIDDEN, a past date from a biller is JV_INVALID_INPUT, original_net_weight from staff is JV_FORBIDDEN; the owner may do all three', () => {
  const field = (res: LightMyRequestResponse): string | undefined => (JSON.parse(res.body) as { error?: { details?: { field?: string } } }).error?.details?.field;
  const codeOf = (res: LightMyRequestResponse): string | undefined => (JSON.parse(res.body) as { error?: { code: string } }).error?.code;

  /** The call is refused with this status, code and field, and the books are as they were. */
  async function refused(caller: CallerName, call: Call, status: number, code: string, fieldName: string) {
    const before = await books();
    const res = await send(caller, call);
    expect([res.statusCode, codeOf(res), field(res)], `${caller} ${call.url}: ${res.body.slice(0, 200)}`).toEqual([status, code, fieldName]);
    expect(await books(), `${caller} ${call.url}: a refused call changed the books`).toBe(before);
  }
  const let_in = async (caller: CallerName, call: Call) => {
    const res = await send(caller, call);
    expect([200, 201], `${caller} ${call.url}: ${res.statusCode} ${res.body.slice(0, 200)}`).toContain(res.statusCode);
    return res;
  };
  const REASON = 'customer paid in cash by ten people';

  it('X1 create_bill: a biller\'s cash_override_reason is 403 JV_FORBIDDEN naming the field; the owner is let in', async () => {
    const make = async (): Promise<Call> => {
      const c = await addCustomer(w);
      const p = await piece(w, d.gold24pp, { retail: '10.00' });
      return { method: 'POST', url: '/v1/bills', payload: billBody(c, 'Retail', [item(p, { metal_rate: '10.00' })], { payments: [{ mode: 'Cash', amount: '10.00' }], cash_override_reason: REASON }) };
    };
    await refused('biller', await make(), 403, 'JV_FORBIDDEN', 'cash_override_reason');
    await let_in('owner', await make());
  });

  it('X2 record_payment: a biller\'s cash_override_reason is 403 JV_FORBIDDEN naming the field; the owner is let in', async () => {
    const make = async (): Promise<Call> => {
      const c = await addCustomer(w);
      await addBill(w, c, '1000.00', DAY);
      return { method: 'POST', url: `/v1/customers/${c}/payments`, payload: { amount: '100.00', mode: 'Cash', cash_override_reason: REASON } };
    };
    await refused('biller', await make(), 403, 'JV_FORBIDDEN', 'cash_override_reason');
    await let_in('owner', await make());
  });

  it('X3 settle_fine: a biller\'s cash_override_reason is 403 JV_FORBIDDEN naming the field; the owner is let in', async () => {
    const make = async (): Promise<Call> => {
      const c = await addCustomer(w);
      await addFineBill(w, c, '1000.00', '5.000', DAY);
      return { method: 'POST', url: `/v1/customers/${c}/fine-settlements`, payload: { grams: '1.000', mode: 'Cash', silver_rate: '85.00', cash_override_reason: REASON } };
    };
    await refused('biller', await make(), 403, 'JV_FORBIDDEN', 'cash_override_reason');
    await let_in('owner', await make());
  });

  it('X1 create_bill: a past bill_date from a biller is 422 JV_INVALID_INPUT naming the field; the owner back-dates', async () => {
    const make = async (): Promise<Call> => {
      const c = await addCustomer(w);
      const p = await piece(w, d.gold24pp, { retail: '10.00' });
      return { method: 'POST', url: '/v1/bills', payload: billBody(c, 'Retail', [item(p, { metal_rate: '10.00' })], { bill_date: PAST }) };
    };
    await refused('biller', await make(), 422, 'JV_INVALID_INPUT', 'bill_date');
    expect(JSON.parse((await let_in('owner', await make())).body).bill.bill_date).toBe(PAST);
  });

  it('X2 record_payment: a past paid_on from a biller is 422 JV_INVALID_INPUT naming the field; the owner back-dates', async () => {
    const make = async (): Promise<Call> => {
      const c = await addCustomer(w);
      await addBill(w, c, '1000.00', DAY);
      return { method: 'POST', url: `/v1/customers/${c}/payments`, payload: { amount: '100.00', mode: 'UPI', paid_on: PAST } };
    };
    await refused('biller', await make(), 422, 'JV_INVALID_INPUT', 'paid_on');
    expect(JSON.parse((await let_in('owner', await make())).body).receipt.paid_on).toBe(PAST);
  });

  it('X3 settle_fine: a past paid_on from a biller is 422 JV_INVALID_INPUT naming the field; the owner back-dates', async () => {
    const make = async (): Promise<Call> => {
      const c = await addCustomer(w);
      await addFineBill(w, c, '1000.00', '5.000', DAY);
      return { method: 'POST', url: `/v1/customers/${c}/fine-settlements`, payload: { grams: '1.000', mode: 'Silver', paid_on: PAST } };
    };
    await refused('biller', await make(), 422, 'JV_INVALID_INPUT', 'paid_on');
    expect(JSON.parse((await let_in('owner', await make())).body).receipt.paid_on).toBe(PAST);
  });

  it('X7 quote_bill: a past bill_date from a biller is 422 JV_INVALID_INPUT naming the field; the owner may quote a past day', async () => {
    const make = async (): Promise<Call> => {
      const p = await piece(w, d.gold24pp, { retail: '10.00' });
      return { method: 'POST', url: '/v1/bills/quote', payload: { sale_type: 'Retail', items: [item(p, { metal_rate: '10.00' })], bill_date: PAST } };
    };
    await refused('biller', await make(), 422, 'JV_INVALID_INPUT', 'bill_date');
    expect(JSON.parse((await let_in('owner', await make())).body).bill_date).toBe(PAST);
  });

  it('X11 issue_refund and X12 add_opening_balance (owner only): a biller is 403 even with a valid body; the owner back-dates both', async () => {
    const refund = async (): Promise<Call> => {
      const c = await addCustomer(w);
      await addMoney(w, c, '200.00', DAY);
      return { method: 'POST', url: `/v1/customers/${c}/refunds`, payload: { amount: '50.00', mode: 'UPI', paid_on: PAST } };
    };
    const opening = async (): Promise<Call> => ({ method: 'POST', url: `/v1/customers/${await addCustomer(w)}/opening-balance`, payload: { dues: '100.00', as_of: PAST } });
    for (const make of [refund, opening]) {
      const call = await make();
      const before = await books();
      const res = await send('biller', call);
      expect([res.statusCode, codeOf(res)]).toEqual([403, 'JV_FORBIDDEN']);
      expect(await books()).toBe(before);
      await let_in('owner', await make());
    }
  });

  const designWith = (weight?: string) => designPayload(w, { pieces: [{ pieces: 2, gross_weight: '12.500', customer_net_weight: '11.000', labour_retail: '350.00', ...(weight ? { original_net_weight: weight } : {}) }] });

  it('X8 create_design: original_net_weight from staff is 403 JV_FORBIDDEN naming the field; from a biller the whole call is 403; the owner stores it', async () => {
    await refused('staff', { method: 'POST', url: '/v1/designs', payload: designWith(ORIGINAL) }, 403, 'JV_FORBIDDEN', 'pieces[0].original_net_weight');
    const biller = await send('biller', { method: 'POST', url: '/v1/designs', payload: designWith(ORIGINAL) });
    expect([biller.statusCode, codeOf(biller)]).toEqual([403, 'JV_FORBIDDEN']);
    const made = await let_in('owner', { method: 'POST', url: '/v1/designs', payload: designWith('55.555') });
    const stored = await rows(w, 'SELECT original_net_weight FROM sku_private p JOIN skus s ON s.id = p.sku_id WHERE s.design_id = ?', [JSON.parse(made.body).design.id]);
    expect(stored.map((r) => r.original_net_weight)).toEqual(['55.555', '55.555']);
    // staff may create the same design without it
    expect((await let_in('staff', { method: 'POST', url: '/v1/designs', payload: designWith() })).statusCode).toBe(201);
  });
});

// ------------------------------------------------------------------ T-D03: nothing but the owner's own reads holds the original weight

interface Result {
  caller: CallerName;
  what: string;
  status: number;
  text: string;
}

/** The key, at any depth, in a parsed answer. */
function hasKey(value: unknown, key: string): boolean {
  if (Array.isArray(value)) return value.some((v) => hasKey(v, key));
  if (value !== null && typeof value === 'object') return Object.entries(value).some(([k, v]) => k === key || hasKey(v, key));
  return false;
}
const holdsWeight = (r: Result): boolean => {
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(r.text);
  } catch {
    /* not JSON: the text is searched below */
  }
  return hasKey(parsed, 'original_net_weight') || r.text.includes('original_net_weight') || r.text.includes(ORIGINAL);
};

/** The reads of the matrix with a made-up id or a window where the address needs one. */
const READ_QUERY: Partial<Record<Action, string>> = { 'read:daily_totals': '?from=2026-10-16&to=2026-10-17', 'read:audit_log': '?limit=200', 'read:health_checks': '?limit=200' };

describe('T-D03 clause (API31): the generated function matrix scans every result of every role for the key original_net_weight and finds it only in the owner\'s own reads', () => {
  let results: Result[];

  beforeAll(async () => {
    results = [];
    const keep = (caller: CallerName, what: string, res: LightMyRequestResponse) => results.push({ caller, what, status: res.statusCode, text: res.body });
    // a design whose pieces have an owner-only weight (made by the owner through X8), a bill of its piece (made by a biller through X1), and the owner's own edit of the weight
    const made = await send('owner', { method: 'POST', url: '/v1/designs', payload: designPayload(w, { pieces: [{ pieces: 1, gross_weight: '120.000', customer_net_weight: '100.000', labour_retail: '350.00', original_net_weight: ORIGINAL }] }) });
    expect(made.statusCode, made.body).toBe(201);
    keep('owner', 'fn:create_design', made);
    const sku = JSON.parse(made.body).skus[0].id as string;
    const customer = await addCustomer(w);
    const bill = await send('biller', { method: 'POST', url: '/v1/bills', payload: billBody(customer, 'Retail', [item(sku, { metal_rate: '6900.00', labour_rate: '350.00' })]) });
    expect(bill.statusCode, bill.body).toBe(201);
    keep('biller', 'fn:create_bill', bill);
    const held = JSON.parse((await w.world.call('owner', 'GET', '/v1/sync/sku-private?limit=1000')).body).rows.find((r: { sku_id: string }) => r.sku_id === sku) as { updated_at: string };
    const edit = await w.world.call('owner', 'PUT', `/v1/sku-private/${sku}`, { payload: { original_net_weight: ORIGINAL, expected_updated_at: held.updated_at } });
    expect([200, 201], edit.body).toContain(edit.statusCode);
    keep('owner', 'edit:sku_private.update', edit);

    // every function by every caller (the answers of a refused call too: an error body must not carry it either)
    for (const action of ACTIONS) {
      for (const caller of CALLERS) {
        const cell = await runCell(action, caller);
        keep(caller, action, cell.res);
      }
    }
    // every read of the matrix by every caller
    const resources = SYNC_ROWS.map((r) => ({ ...r }));
    for (const [action, row] of Object.entries(MATRIX) as [Action, (typeof MATRIX)[Action]][]) {
      if (row.kind !== 'read') continue;
      for (const caller of CALLERS) {
        if (action === 'read:poll') {
          // the combined poll names every resource the caller may read, and (for the roles that may not read it) the one that is not theirs, which refuses the whole call
          const mine = resources.filter((r) => r.roles.includes(caller));
          const names = (mine.length > 0 ? mine : resources).map((r) => r.name);
          const cursors = Object.fromEntries([...new Set([...names, 'sku-private'])].map((n) => [n, null]));
          keep(caller, action, await w.world.call(caller, 'POST', row.path, { payload: { cursors } }));
          keep(caller, `${action} (own resources)`, await w.world.call(caller, 'POST', row.path, { payload: { cursors: Object.fromEntries(names.filter((n) => n !== 'sku-private').map((n) => [n, null])) } }));
          continue;
        }
        const path = row.path.replace(':id', customer);
        keep(caller, action, await w.world.call(caller, row.method, `${path}${READ_QUERY[action] ?? '?limit=1000'}`));
      }
    }
  }, 300_000);

  it('the scan covers every function and every read of the matrix for every caller', () => {
    for (const action of ACTIONS) for (const caller of CALLERS) expect(results.some((r) => r.what === action && r.caller === caller), `${action} by ${caller} was not scanned`).toBe(true);
    const reads = (Object.entries(MATRIX) as [Action, (typeof MATRIX)[Action]][]).filter(([, r]) => r.kind === 'read').map(([a]) => a);
    for (const action of reads) for (const caller of CALLERS) expect(results.some((r) => r.what === action && r.caller === caller), `${action} by ${caller} was not scanned`).toBe(true);
    expect(results.length).toBeGreaterThan(ACTIONS.length * CALLERS.length + reads.length * CALLERS.length);
  });

  it('CONTROL: the scan sees the weight where it is (the owner\'s sync read of sku_private, the owner\'s own X8 answer and edit)', () => {
    const where = results.filter(holdsWeight).map((r) => `${r.caller}|${r.what}`);
    expect(where).toContain('owner|read:sku_private');
    expect(where).toContain('owner|fn:create_design');
    expect(where).toContain('owner|edit:sku_private.update');
    expect(READ_COLUMNS.sku_private.owner).toContain('original_net_weight');
  });

  it('the key original_net_weight and the weight itself appear in no result of staff, of a biller, or of any caller who has no session, and in no result of the owner but the owner\'s own reads and answers', () => {
    const OWNERS_OWN = new Set(['read:sku_private', 'read:poll', 'read:poll (own resources)', 'read:audit_log', 'fn:create_design', 'edit:sku_private.update']);
    const leaks = results.filter(holdsWeight).filter((r) => !(r.caller === 'owner' && OWNERS_OWN.has(r.what)));
    expect(leaks.map((r) => `${r.caller} on ${r.what} (${r.status})`)).toEqual([]);
    // and every caller but the owner was really answered (a 401 or 403 is an answer that was scanned, not a missing one)
    for (const caller of CALLERS.filter((c) => c !== 'owner')) expect(results.filter((r) => r.caller === caller).length, caller).toBeGreaterThan(ACTIONS.length);
  });

  it('a biller\'s bill (X1) and the bill lines and snapshot a biller reads hold the piece but not its original weight', async () => {
    const lines = results.filter((r) => r.caller === 'biller' && ['read:bill_items', 'read:bills', 'read:skus', 'fn:create_bill'].includes(r.what));
    expect(lines.length).toBeGreaterThanOrEqual(4);
    expect(lines.some((r) => r.status === 200 || r.status === 201)).toBe(true);
    for (const r of lines) expect(holdsWeight(r), `${r.what}: ${r.text.slice(0, 120)}`).toBe(false);
  });
});
