import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../../scripts/migrate.mjs';
import { MATRIX, type HttpMethod, type MatrixRow } from '../../src/permissions/matrix';
import { createRoute } from '../../src/permissions/route';
import { SESSION_COOKIE, newTicket } from '../../src/permissions/session';
import { TICK_KEYS, type TickKey } from '../../src/permissions/ticks';
import { type CallerName, type World, makeWorld, registerStubs } from './cells';
import { csrfHeaders, secret } from './support';

// Task 12 of the access plan (DESIGN.md 6.3 and P5, ESCALATION): the twelve rows of the Super Admin's own API answer ONLY the Super Admin. A caller who is not the Super Admin, the Owner
// included, a custom role holding all 32 ticks included, gets 403 JV_FORBIDDEN on every row; a caller with no live session gets 401; the Super Admin is the only one who gets in.
//
// WHAT IS WALKED. Every row of kind `super`, for every caller, one real call each, with the answer, the statements the call sent, the books it left and whether the handler behind it ran all checked:
//   - the three READ rows are the real routes of the application (src/super/routes.ts);
//   - the nine WRITE rows have no route until Tasks 13 and 14, so the world gives each a stub behind the real wrapper (registerStubs): the gate is proved now for every row, and stays proved when
//     the real handlers replace the stubs (a refused caller must never reach the handler, and a plausible write body from one must change nothing).
// The expectations are typed here from the plan, not read from the matrix, so a row opened by mistake fails this file. The control at the end shows that: four rows whose access is doctored (open to
// everyone signed in, to any one of the 32 ticks, to the billing tick, to the settings tick) are registered through the real wrapper and the same walk finds each of them, for exactly the callers it lets in.
//
// A refused caller's body is a plausible write (a person added with the Owner role, the Owner role given no tick, the Super Admin switched off) aimed at the real Super Admin's login and the Owner role.
// The Super Admin's own calls carry an empty body on a write, so that a handler that is a real one by then refuses it as invalid and writes nothing; a read carries none.

const ROWS: readonly { action: string; method: HttpMethod; path: string }[] = [
  { action: 'super:ticks', method: 'GET', path: '/v1/super/ticks' },
  { action: 'super:people.list', method: 'GET', path: '/v1/super/people' },
  { action: 'super:people.add', method: 'POST', path: '/v1/super/people' },
  { action: 'super:people.edit', method: 'PATCH', path: '/v1/super/people/:id' },
  { action: 'super:people.role', method: 'POST', path: '/v1/super/people/:id/role' },
  { action: 'super:people.active', method: 'POST', path: '/v1/super/people/:id/active' },
  { action: 'super:people.reset', method: 'POST', path: '/v1/super/people/:id/reset-password' },
  { action: 'super:roles.list', method: 'GET', path: '/v1/super/roles' },
  { action: 'super:roles.create', method: 'POST', path: '/v1/super/roles' },
  { action: 'super:roles.edit', method: 'PATCH', path: '/v1/super/roles/:key' },
  { action: 'super:roles.ticks', method: 'PUT', path: '/v1/super/roles/:key/ticks' },
  { action: 'super:roles.active', method: 'POST', path: '/v1/super/roles/:key/active' },
];
type RowSpec = { action: string; method: HttpMethod; path: string };

/**
 * Four rows that exist only in this test: a Super Admin row doctored the way a mistake would doctor it: open to everyone signed in; opened to any one of the 32 ticks (`anyOf` means any ONE of them is
 * enough, so every person holding at least one tick passes); opened to the tick of billing; opened to one tick only the Owner and wide custom roles hold. Registered through the real wrapper under paths of their own.
 */
const MUTANTS: Record<string, MatrixRow> = {
  'mutant:open': { kind: 'read', method: 'GET', path: '/v1/test-p5/open', access: { open: true }, mustChange: false, spec: 'super-escalation test: a Super Admin row made open to everyone' },
  'mutant:anytick': { kind: 'read', method: 'GET', path: '/v1/test-p5/anytick', access: { anyOf: [...TICK_KEYS] as unknown as [TickKey, ...TickKey[]] }, mustChange: false, spec: 'super-escalation test: a Super Admin row opened to any one tick' },
  'mutant:billing': { kind: 'read', method: 'GET', path: '/v1/test-p5/billing', access: { anyOf: ['bill_make'] }, mustChange: false, spec: 'super-escalation test: a Super Admin row opened to the billing tick' },
  'mutant:settings': { kind: 'read', method: 'GET', path: '/v1/test-p5/settings', access: { anyOf: ['settings_change'] }, mustChange: false, spec: 'super-escalation test: a Super Admin row opened to the settings tick' },
};
const MUTANT_ROWS: RowSpec[] = Object.entries(MUTANTS).map(([action, r]) => ({ action, method: r.method, path: r.path }));

// ------------------------------------------------------------------ the world

let w: World;
const ids = { person: '', role: 'owner' };
/** People that are not fixtures of the world: a role holding all 32 ticks, one holding them and made-up keys that sound like the Super Admin's, a flag on the staff role, a Super Admin switched off, one who must change the password. */
const extra = {} as Record<'all32' | 'madeUp' | 'flaggedStaff' | 'switchedOff' | 'mustChange', { userId: string; cookie: string }>;

beforeAll(async () => {
  w = await makeWorld({
    label: 'superesc',
    routes: true,
    build: (app, h) => {
      registerStubs(app, h.handled); // the nine write rows (Tasks 13 and 14) get a stub behind the real wrapper; the three reads keep their real routes
      const doctored = createRoute({ matrix: MUTANTS, publicRoutes: {}, tokenDoors: {} });
      for (const action of Object.keys(MUTANTS)) doctored(app, { action, handler: async () => ({ ok: true }) });
    },
  });
  await migrate(w.sql, { seeds: false, optional: true }); // the generated audit triggers: a write to users or roles would leave audit rows
  await w.sql.query('SET SESSION group_concat_max_len = 1000000');
  const all32 = await w.addRole({ name: 'Everything but not the Owner', ticks: [...TICK_KEYS] });
  const madeUp = await w.addRole({ name: 'Everything and more', ticks: [...TICK_KEYS, 'super_admin', 'people_roles', 'is_super_admin', 'super:people.list', 'super:roles.list', 'superAdmin'] });
  extra.all32 = await w.addUser({ role: all32.key });
  extra.madeUp = await w.addUser({ role: madeUp.key });
  extra.flaggedStaff = await w.addUser({ role: 'staff', superAdmin: true });
  extra.switchedOff = await w.addUser({ role: 'owner', superAdmin: true, active: false });
  extra.mustChange = await w.addUser({ role: 'owner', superAdmin: true, mustChange: true });
  ids.person = w.fixtures.super.userId; // the person a plausible write is aimed at: the Super Admin herself
}, 180_000);
afterAll(async () => {
  await w?.close();
});

// ------------------------------------------------------------------ callers

interface Who {
  name: string;
  /** a fixture caller of the world (its session is put back after each call), or the cookie header of someone made here */
  fixture?: CallerName;
  cookie?: string;
}
const fixtureCaller = (name: string, fixture: CallerName): Who => ({ name, fixture });

/** Signed in, not the Super Admin: every one of them is refused with 403 JV_FORBIDDEN. */
const REFUSED = (): Who[] => [
  fixtureCaller('the Owner', 'owner'),
  fixtureCaller('a Biller', 'biller'),
  fixtureCaller('a Staff', 'staff'),
  { name: 'a custom role holding all 32 ticks', cookie: extra.all32.cookie },
  { name: 'a custom role holding all 32 ticks and made-up keys such as super_admin', cookie: extra.madeUp.cookie },
];
/** No live session: every one of them is 401, whatever the row says. */
const SIGNED_OUT = (): (Who & { code: string; message: string })[] => [
  { ...fixtureCaller('nobody (no cookie)', 'anon'), code: 'JV_UNAUTHENTICATED', message: 'Sign in to continue.' },
  { name: 'a ticket nobody holds', cookie: `${SESSION_COOKIE}=${newTicket()}`, code: 'JV_UNAUTHENTICATED', message: 'Sign in to continue.' },
  { ...fixtureCaller('an ended session (an Owner)', 'ended'), code: 'JV_UNAUTHENTICATED', message: 'Sign in to continue.' },
  { ...fixtureCaller('a login switched off (an Owner)', 'inactive'), code: 'JV_UNAUTHENTICATED', message: 'Sign in to continue.' },
  { name: 'a Super Admin switched off', cookie: extra.switchedOff.cookie, code: 'JV_UNAUTHENTICATED', message: 'Sign in to continue.' },
  { ...fixtureCaller('an expired session (an Owner)', 'expired'), code: 'JV_SESSION_EXPIRED', message: 'Your session has ended. Sign in again.' },
  { ...fixtureCaller('an idle session (an Owner)', 'idle'), code: 'JV_SESSION_EXPIRED', message: 'Your session has ended. Sign in again.' },
];
/** The Super Admin: the flagged login of the Owner role, and a login flagged on another role (the flag, not the role key, is what passes). */
const PASSING = (): Who[] => [fixtureCaller('the Super Admin', 'super'), { name: 'a login flagged as Super Admin on the Staff role', cookie: extra.flaggedStaff.cookie }];

// ------------------------------------------------------------------ one cell

const URL_OF = (path: string): string => path.replace(':id', ids.person).replace(':key', ids.role);

const password = secret('Pw'); // made up for this run; a refused caller's body holds one like a real write does, and nothing prints it
const STAMP = '2026-10-17T10:00:00.000000Z';
/** What a refused caller sends: a plausible write that would do real harm if the gate let it through. */
const PLAUSIBLE: Record<string, object> = {
  'super:people.add': { full_name: 'Asha Verma', email: 'asha.p5@example.test', role: 'owner', password },
  'super:people.edit': { changes: { email: 'takeover.p5@example.test', full_name: 'Someone Else' }, password },
  'super:people.role': { role: 'staff', password },
  'super:people.active': { active: false, password },
  'super:people.reset': { password },
  'super:roles.create': { copy_of: 'owner', name: 'Everything copy', password },
  'super:roles.edit': { expected_updated_at: STAMP, changes: { name: 'Renamed', description: 'by an intruder' }, password },
  'super:roles.ticks': { expected_updated_at: STAMP, ticks: [], password },
  'super:roles.active': { expected_updated_at: STAMP, active: false, password },
};

/** Statements that read the session and the user, and the checkout's own SET SESSION: all a refused caller may cause (D2, A10). */
const isSessionRead = (text: string): boolean => /^SELECT\b[\s\S]*\bFROM\s+(sessions|users)\b/i.test(text.trim()) || /^SET SESSION\b/i.test(text.trim());
/** U4: the one write a caller with an expired session may cause: the session is marked ended. */
const isEndMark = (text: string): boolean => /^UPDATE\s+sessions\s+SET\s+revoked_at\s*=\s*\?\s+WHERE\s+id\s*=\s*\?\s+AND\s+revoked_at\s+IS\s+NULL$/i.test(text.trim());

/** What a refused call must leave as it found it: the audit log, the users, the roles, the claims. */
async function books(): Promise<string[]> {
  const one = async (text: string) => JSON.stringify(((await w.sql.query<any[]>(text))[0] as any[])[0]);
  return [
    await one('SELECT COUNT(*) AS n, MAX(id) AS last FROM audit_log'),
    await one("SELECT COUNT(*) AS n, MD5(GROUP_CONCAT(CONCAT_WS('|', id, email, full_name, role, active, is_super_admin, must_change_password, password_hash, last_login_at, updated_at) ORDER BY id)) AS d FROM users"),
    await one("SELECT COUNT(*) AS n, MD5(GROUP_CONCAT(CONCAT_WS('|', role_key, name, description, active, ticks, updated_at) ORDER BY role_key)) AS d FROM roles"),
    await one('SELECT COUNT(*) AS n FROM sys_idempotency'),
  ];
}

type Verdict = { kind: 'forbidden' } | { kind: 'unauthorized'; code: string; message: string } | { kind: 'password_change' } | { kind: 'pass' };

const errorOf = (res: LightMyRequestResponse): { code?: string; message?: string; request_id?: string } | null => {
  try {
    const parsed = JSON.parse(res.body) as { error?: { code?: string; message?: string }; request_id?: string };
    return parsed.error ? { ...parsed.error, request_id: parsed.request_id } : null;
  } catch {
    return null;
  }
};

let cells = 0;
/** One call of one caller to one row, compared with the verdict. Returns every way the answer differs (an empty list when it is as it should be). */
async function check(who: Who, row: RowSpec, verdict: Verdict): Promise<string[]> {
  cells++;
  const cookie = who.fixture !== undefined ? w.cookieOf(who.fixture) : who.cookie;
  const payload = row.method === 'GET' ? undefined : verdict.kind === 'pass' ? {} : (PLAUSIBLE[row.action] ?? { password });
  const beforeBooks = await books();
  const from = w.spy.sent.length;
  const handledBefore = w.handled.length;
  const res = await w.app.inject({ method: row.method, url: URL_OF(row.path), headers: { ...(row.method === 'GET' ? {} : csrfHeaders()), ...(cookie ? { cookie } : {}) }, payload: payload as object | undefined });
  if (who.fixture !== undefined) await w.restore(who.fixture); // a call may have ended or moved the session of a fixture caller
  const sent = w.spy.sqls().slice(from);
  const e = errorOf(res);
  const problems: string[] = [];
  const say = (what: string) => problems.push(`${who.name} on ${row.method} ${row.path} (${row.action}): ${what}`);

  if (verdict.kind === 'pass') {
    // the gate lets the Super Admin through: a read answers 200; a write (a stub now, the real handler later) answers 200, 201, 409 or 422 and never 401, 403 or 404 (no route)
    if (![200, 201, 409, 422].includes(res.statusCode)) say(`status ${res.statusCode} ${e?.code ?? ''}, the Super Admin must pass the gate`);
    if (row.method === 'GET' && res.statusCode !== 200) say(`a read answered ${res.statusCode}`);
    return problems;
  }

  const status = verdict.kind === 'unauthorized' ? 401 : 403;
  const code = verdict.kind === 'unauthorized' ? verdict.code : verdict.kind === 'forbidden' ? 'JV_FORBIDDEN' : 'JV_PASSWORD_CHANGE_REQUIRED';
  if (res.statusCode !== status) say(`status ${res.statusCode}, expected ${status}`);
  if (e === null) say('the body is not the S8 error body {error:{code,message,details},request_id}');
  else {
    if (e.code !== code) say(`code ${e.code}, expected ${code}`);
    // the wording rule: the sentences that exist already, none new
    const message = verdict.kind === 'unauthorized' ? verdict.message : verdict.kind === 'forbidden' ? 'You are not allowed to do this.' : 'Change your password to continue.';
    if (e.message !== message) say(`message ${JSON.stringify(e.message)}, expected the existing sentence ${JSON.stringify(message)}`);
    if (typeof e.request_id !== 'string' || !/^[0-9a-f-]{36}$/.test(e.request_id)) say('request_id is not a UUID');
  }
  const stray = sent.filter((s) => !isSessionRead(s) && !(verdict.kind === 'unauthorized' && verdict.code === 'JV_SESSION_EXPIRED' && isEndMark(s)));
  if (stray.length > 0) say(`a refused caller caused a statement other than the session and user reads: ${stray[0].slice(0, 70)}`);
  if (w.handled.length !== handledBefore) say('the handler ran for a refused caller');
  if (JSON.stringify(await books()) !== JSON.stringify(beforeBooks)) say('the call changed the audit log, the users, the roles or the claims');
  return problems;
}

// ------------------------------------------------------------------ the rows

describe('the twelve rows of the Super Admin (P5)', () => {
  it('the matrix holds exactly these twelve rows of kind super, each for the Super Admin alone, with mustChange false, and no other row is under /v1/super or of kind super', () => {
    const supers = Object.entries(MATRIX).filter(([, r]) => r.kind === 'super');
    expect(supers.map(([action, r]) => `${action} ${r.method} ${r.path}`).sort()).toEqual(ROWS.map((r) => `${r.action} ${r.method} ${r.path}`).sort());
    expect(supers).toHaveLength(12);
    for (const [action, r] of supers) {
      expect(r.access, action).toEqual({ superAdmin: true });
      expect(r.mustChange, action).toBe(false);
      expect(r.path, action).toMatch(/^\/v1\/super\/[a-z-]+(\/(:id|:key))?(\/[a-z-]+)?$/); // fixed words and one named parameter: never a table or a column from the client (A11)
      expect(r.spec.length, action).toBeGreaterThan(10);
      expect(r.reads, `${action} serves no READ_COLUMNS resource`).toBeUndefined();
      expect(r.edit, `${action} is no direct edit`).toBeUndefined();
    }
    for (const [action, r] of Object.entries(MATRIX)) {
      if (r.path.startsWith('/v1/super')) expect(r.kind, action).toBe('super');
      if ('superAdmin' in r.access) expect(r.kind, action).toBe('super');
    }
    // the three reads are GET, the nine writes are not (a GET changes nothing, T-D23)
    expect(supers.filter(([, r]) => r.method === 'GET').map(([action]) => action).sort()).toEqual(['super:people.list', 'super:roles.list', 'super:ticks']);
  });

  it('P5: every super row answers 403 JV_FORBIDDEN to Owner, Biller, Staff and a custom role holding all 32 ticks, and 401 without a session; only the Super Admin passes (walks all 12 rows)', async () => {
    expect(ROWS).toHaveLength(12);
    cells = 0;
    const problems: string[] = [];
    for (const row of ROWS) {
      expect(MATRIX[row.action as keyof typeof MATRIX], `${row.action} is a row of the matrix`).toBeDefined();
      for (const who of REFUSED()) problems.push(...(await check(who, row, { kind: 'forbidden' })));
      for (const who of SIGNED_OUT()) problems.push(...(await check(who, row, { kind: 'unauthorized', code: who.code, message: who.message })));
      for (const who of PASSING()) problems.push(...(await check(who, row, { kind: 'pass' })));
    }
    expect(problems).toEqual([]);
    expect(cells, 'every caller was walked on every row').toBe(12 * (REFUSED().length + SIGNED_OUT().length + PASSING().length));
  });

  it('a Super Admin who must still change the password is turned away on every row with JV_PASSWORD_CHANGE_REQUIRED (U11 comes first: mustChange is false on all twelve)', async () => {
    const problems: string[] = [];
    for (const row of ROWS) problems.push(...(await check({ name: 'a Super Admin who must change the password', cookie: extra.mustChange.cookie }, row, { kind: 'password_change' })));
    expect(problems).toEqual([]);
  });
});

describe('control: the walk is able to fail', () => {
  it('a Super Admin row made open to everyone, to any tick, to the billing tick or to the settings tick is found by the same check, for exactly the callers it lets in', async () => {
    const foundFor = async (row: RowSpec): Promise<string[]> => {
      const found: string[] = [];
      for (const who of REFUSED()) if ((await check(who, row, { kind: 'forbidden' })).length > 0) found.push(who.name);
      return found;
    };
    const [open, anyTick, billing, settings] = MUTANT_ROWS;
    const all = REFUSED().map((who) => who.name);
    const wide = all.filter((name) => name !== 'a Biller' && name !== 'a Staff'); // the Owner and the two roles that hold every tick
    // open to everyone signed in: all five callers get a 200 where the walk wants a 403
    expect(await foundFor(open)).toEqual(all);
    // opened to any one of the 32 ticks: each of the five holds at least one
    expect(await foundFor(anyTick)).toEqual(all);
    // opened to the billing tick: the Biller holds it too, the Staff does not
    expect(await foundFor(billing)).toEqual(all.filter((name) => name !== 'a Staff'));
    // opened to the settings tick: only the wide ones hold it; the Biller and the Staff are refused, as the walk wants, so they are not found
    expect(await foundFor(settings)).toEqual(wide);
    // and the doctored rows are the only thing that differs: a mutant answers the Super Admin as a real row does
    for (const row of MUTANT_ROWS) expect(await check(fixtureCaller('the Super Admin', 'super'), row, { kind: 'pass' })).toEqual([]);
  });
});
