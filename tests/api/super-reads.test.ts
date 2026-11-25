import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { JvError } from '../../src/errors';
import { NO_GRANTS, grantsOf } from '../../src/permissions/grants';
import { TICKS, TICK_GROUPS, TICK_KEYS } from '../../src/permissions/ticks';
import { type EditWorld, editWorld } from './edit-support';
import { secret } from './support';

// Task 12 of the access plan (DESIGN.md 6.3, P5): the READ side of the Super Admin's own API. Three calls under /v1/super, each a row of the permission matrix of kind `super`
// (only the Super Admin passes; who is refused is in tests/api/super-escalation.test.ts):
//   GET /v1/super/ticks    the catalogue of the 32 ticks, as the roles screen draws it
//   GET /v1/super/people   every login, with its role's name and whether it is the Super Admin
//   GET /v1/super/roles    every role, with its ticks and how many ACTIVE people hold it
// The answers are typed in here as an independent oracle (the plan's table of ticks, the keys of each row), never read back from the code under test, except where a test says it compares with
// the catalogue module on purpose. The reads write nothing: no audit row, no event, no change of users or roles.
//
// The world is the scratch database of the edit tests (the real routes, the seeds, the generated audit triggers, so that "nothing written" means something). Roles and people are made with
// World.addRole and World.addUser (direct SQL: the write routes of Tasks 13 and 14 do not exist yet).

let w: EditWorld;

beforeAll(async () => {
  w = await editWorld('superrd', { triggers: true });
  await w.world.sql.query('SET SESSION group_concat_max_len = 1000000'); // the digests below hold whole tables
}, 120_000);
afterAll(async () => {
  await w?.world.close();
}, 60_000);

// ------------------------------------------------------------------ the oracle, typed from the plan

const GROUPS = ['Stock', 'Photos', 'Money', 'Orders', 'Records', 'Shop'];
const KEYS = [
  'stock_add', 'stock_edit', 'stock_status', 'category_add', 'category_edit', 'design_material', 'secret_weight',
  'photo_rewrite',
  'customer_view', 'bill_view', 'cashbook_recent', 'cashbook_all', 'customer_edit', 'customer_archive', 'bill_make', 'payment_receive', 'rate_enter', 'rate_correct', 'back_date', 'bill_cancel', 'bill_reissue', 'payment_void', 'refund_give', 'opening_balance', 'cash_over_limit',
  'order_view', 'order_edit', 'order_closed_change',
  'reports_open', 'activity_log', 'download_all',
  'settings_change',
];
/** How many ticks each group holds (the table of the plan: Stock 7, Photos 1, Money 17, Orders 3, Records 3, Shop 1). */
const GROUP_SIZES: Record<string, number> = { Stock: 7, Photos: 1, Money: 17, Orders: 3, Records: 3, Shop: 1 };
/** The twelve ticks the screen shows in another colour. */
const SENSITIVE = ['secret_weight', 'back_date', 'bill_cancel', 'bill_reissue', 'payment_void', 'refund_give', 'opening_balance', 'cash_over_limit', 'order_closed_change', 'activity_log', 'download_all', 'settings_change'];
/** The four ticks that carry a help text. */
const HELPED = ['stock_edit', 'bill_make', 'rate_enter', 'bill_reissue'];

const PERSON_KEYS = ['id', 'full_name', 'email', 'role', 'role_name', 'active', 'is_super_admin', 'last_login_at', 'updated_at'];
const ROLE_KEYS = ['key', 'name', 'description', 'active', 'fixed', 'ticks', 'people', 'updated_at'];
const WIRE_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// ------------------------------------------------------------------ calls and SQL

interface Person {
  id: string;
  full_name: string;
  email: string;
  role: string;
  role_name: string;
  active: boolean;
  is_super_admin: boolean;
  last_login_at: string | null;
  updated_at: string;
}
interface Role {
  key: string;
  name: string;
  description: string;
  active: boolean;
  fixed: boolean;
  ticks: string[];
  people: number;
  updated_at: string;
}

const json = (res: LightMyRequestResponse) => JSON.parse(res.body);
const asSuper = (url: string) => w.world.call('super', 'GET', url);

async function people(): Promise<Person[]> {
  const res = await asSuper('/v1/super/people');
  expect(res.statusCode, res.body).toBe(200);
  return json(res).people;
}
async function roles(): Promise<Role[]> {
  const res = await asSuper('/v1/super/roles');
  expect(res.statusCode, res.body).toBe(200);
  return json(res).roles;
}

/** Rows of a statement, over the test's own connection (dates come back as the database writes them: 'YYYY-MM-DD HH:MM:SS.ffffff'). */
async function sql<T = Record<string, any>>(text: string, params: unknown[] = []): Promise<T[]> {
  const [found] = await w.world.sql.query<any[]>(text, params);
  return found as T[];
}
/** The wire text of a stored DATETIME(6), written out here and not by the code under test: 'YYYY-MM-DDTHH:MM:SS.ffffffZ'. */
const wire = (stored: string): string => `${stored.replace(' ', 'T')}Z`;

/** What a read must leave as it found it: the audit log (the triggers write the rows of users and roles, and `event` rows are the code's own), the users, the roles, the claims. */
async function digest(): Promise<string[]> {
  const one = async (text: string) => JSON.stringify((await sql(text))[0]);
  return [
    await one('SELECT COUNT(*) AS n, MAX(id) AS last FROM audit_log'),
    await one("SELECT COUNT(*) AS n, MD5(GROUP_CONCAT(CONCAT_WS('|', id, email, full_name, role, active, is_super_admin, must_change_password, password_hash, last_login_at, updated_at) ORDER BY id)) AS d FROM users"),
    await one("SELECT COUNT(*) AS n, MD5(GROUP_CONCAT(CONCAT_WS('|', role_key, name, description, active, ticks, updated_at) ORDER BY role_key)) AS d FROM roles"),
    await one('SELECT COUNT(*) AS n FROM sys_idempotency'),
  ];
}

/** How many ACTIVE logins hold a role, counted by the test's own statement: the cross-check for `people` of the roles list (the typed numbers of the fixtures are the independent oracle). */
async function activeHolders(key: string): Promise<number> {
  return Number((await sql<{ n: string }>('SELECT COUNT(*) AS n FROM users WHERE role = ? AND active = 1', [key]))[0].n);
}

/** A role the way a test needs it: its name made unique with a random suffix (a role name is unique ignoring case), ticks written as given (unknown keys too), an optional description, key and switch. */
const newRole = (name: string, ticks: readonly string[], more: { description?: string; active?: boolean; key?: string } = {}) => w.world.addRole({ name: `${name} ${secret('r').slice(2, 8)}`, ticks, ...more });

// ------------------------------------------------------------------ GET /v1/super/ticks

describe('GET /v1/super/ticks (super:ticks)', () => {
  it('GET /v1/super/ticks equals the catalogue of ticks.ts: 32 keys, six groups, the same words', async () => {
    const res = await asSuper('/v1/super/ticks');
    expect(res.statusCode, res.body).toBe(200);
    const answer = json(res);
    expect(Object.keys(answer)).toEqual(['groups', 'ticks']);

    // the six groups, in the order of the screen, and the 32 keys in catalogue order (typed in above)
    expect(answer.groups).toEqual(GROUPS);
    expect(KEYS).toHaveLength(32);
    expect(answer.ticks.map((t: { key: string }) => t.key)).toEqual(KEYS);

    // every tick says the same six things, in the same order, and nothing else
    for (const t of answer.ticks) expect(Object.keys(t), t.key).toEqual(['key', 'group', 'label', 'help', 'sensitive', 'needs']);
    // the words are the catalogue module's: label, help, group, sensitive and (direct) needs, tick by tick (the module holds them once; tests/api/ticks.test.ts pins them to the plan)
    expect(answer.ticks).toEqual(JSON.parse(JSON.stringify(TICKS)));
    expect(answer.groups).toEqual([...TICK_GROUPS]);
    expect(answer.ticks.map((t: { key: string }) => t.key)).toEqual([...TICK_KEYS]);

    // and pinned against the plan here too, so that a catalogue edited in both places at once is still noticed
    for (const group of GROUPS) expect(answer.ticks.filter((t: { group: string }) => t.group === group), group).toHaveLength(GROUP_SIZES[group]);
    expect(answer.ticks.filter((t: { sensitive: boolean }) => t.sensitive).map((t: { key: string }) => t.key).sort()).toEqual([...SENSITIVE].sort());
    expect(answer.ticks.filter((t: { help: string | null }) => t.help !== null).map((t: { key: string }) => t.key).sort()).toEqual([...HELPED].sort());
    const byKey = Object.fromEntries(answer.ticks.map((t: { key: string }) => [t.key, t]));
    expect(byKey.stock_add).toMatchObject({ group: 'Stock', label: 'Add designs and photos', help: null, sensitive: false, needs: [] });
    expect(byKey.photo_rewrite.label).toBe('Remove, reorder or replace photos (designs and orders)');
    expect(byKey.bill_make.help).toBe('A bill that takes payment also needs "Receive payments and settle fine". Without that, the role can still save a bill that takes no payment.');
    expect(byKey.cashbook_all.needs).toEqual(['cashbook_recent']);
    expect(byKey.activity_log.needs).toEqual(['secret_weight', 'customer_view', 'bill_view', 'order_view']);
    // R21 reaches the screen: the "Also needs" line of Re-issue a bill names the billing tick too
    expect(byKey.bill_reissue.needs).toEqual(['customer_view', 'bill_view', 'bill_make']);
    expect(byKey.settings_change).toMatchObject({ group: 'Shop', label: 'Change shop settings', sensitive: true });
  });

  it('the answer is the same on every call and holds no key that is not a tick of the catalogue (needs name ticks, groups name groups)', async () => {
    const first = json(await asSuper('/v1/super/ticks'));
    const second = json(await asSuper('/v1/super/ticks'));
    expect(second).toEqual(first);
    for (const t of first.ticks) {
      expect(GROUPS, t.key).toContain(t.group);
      for (const need of t.needs) expect(KEYS, `${t.key} needs ${need}`).toContain(need);
    }
  });
});

// ------------------------------------------------------------------ GET /v1/super/people

describe('GET /v1/super/people (super:people.list)', () => {
  it('the people list holds no password hash and carries is_super_admin and role_name', async () => {
    const cashier = await newRole('Cashier', ['customer_view', 'bill_view'], { description: 'Reads bills.' });
    const sleeper = await w.world.addUser({ role: cashier.key, active: false }); // switched off
    const regular = await w.world.addUser({ role: cashier.key });

    const res = await asSuper('/v1/super/people');
    expect(res.statusCode, res.body).toBe(200);
    const answer = json(res);
    expect(Object.keys(answer)).toEqual(['people']);
    const listed: Person[] = answer.people;

    // every row says the nine things of the plan, in that order, and nothing else: no hash, no must-change flag, no session, no token, no stamp but updated_at
    for (const p of listed) expect(Object.keys(p), p.email).toEqual(PERSON_KEYS);
    // not a hash in the text of the answer, whatever key it might have been given: the stored hashes of every login are looked for in it
    const stored = await sql<{ password_hash: string }>('SELECT password_hash FROM users');
    expect(stored.length).toBeGreaterThan(9);
    for (const { password_hash } of stored) expect(res.body, 'a stored password hash is in the answer').not.toContain(password_hash);
    // and no key of the answer, at any depth, is named for a secret or for the session
    const keysOf = (v: unknown): string[] => (Array.isArray(v) ? v.flatMap(keysOf) : v !== null && typeof v === 'object' ? Object.entries(v).flatMap(([k, inner]) => [k, ...keysOf(inner)]) : []);
    expect(keysOf(answer).filter((k) => /password|hash|token|ticket|session|cookie|must_change|secret/i.test(k))).toEqual([]);

    // role_name is the name of the login's role now, for every row; role is the key
    const names = Object.fromEntries((await sql<{ role_key: string; name: string }>('SELECT role_key, name FROM roles')).map((r) => [r.role_key, r.name]));
    expect(names.owner).toBe('Owner');
    expect(names.biller).toBe('Biller');
    expect(names.staff).toBe('Staff');
    for (const p of listed) expect(p.role_name, `${p.email} (${p.role})`).toBe(names[p.role]);
    const byId = new Map(listed.map((p) => [p.id, p]));
    expect(byId.get(regular.userId)).toMatchObject({ role: cashier.key, role_name: names[cashier.key], active: true, is_super_admin: false, email: regular.email, full_name: 'Fixture extra' });
    expect(byId.get(sleeper.userId)).toMatchObject({ role: cashier.key, role_name: names[cashier.key], active: false });
    expect(byId.get(w.world.fixtures.owner.userId)).toMatchObject({ role: 'owner', role_name: 'Owner', active: true, is_super_admin: false });
    expect(byId.get(w.world.fixtures.biller.userId)).toMatchObject({ role: 'biller', role_name: 'Biller' });
    expect(byId.get(w.world.fixtures.staff.userId)).toMatchObject({ role: 'staff', role_name: 'Staff' });
    expect(byId.get(w.world.fixtures.inactive.userId)).toMatchObject({ role: 'owner', active: false });

    // is_super_admin is true for the flagged login and for nobody else; the flag and `active` are booleans
    expect(byId.get(w.world.fixtures.super.userId)).toMatchObject({ role: 'owner', role_name: 'Owner', active: true, is_super_admin: true });
    expect(listed.filter((p) => p.is_super_admin).map((p) => p.id)).toEqual([w.world.fixtures.super.userId]);
    for (const p of listed) {
      expect(typeof p.active, p.email).toBe('boolean');
      expect(typeof p.is_super_admin, p.email).toBe('boolean');
    }

    // every login is listed, switched off or not: the same count as the table
    expect(listed).toHaveLength(Number((await sql<{ n: string }>('SELECT COUNT(*) AS n FROM users'))[0].n));
  });

  it('dates are written as the API writes them elsewhere: UTC with six decimals and a Z; last_login_at is null for a login that never signed in', async () => {
    const role = await newRole('Dates', []);
    const never = await w.world.addUser({ role: role.key });
    const seen = await w.world.addUser({ role: role.key });
    await sql('UPDATE users SET last_login_at = ? WHERE id = ?', ['2026-10-16 09:30:15.123457', seen.userId]);

    const listed = await people();
    const byId = new Map(listed.map((p) => [p.id, p]));
    expect(byId.get(never.userId)!.last_login_at).toBeNull();
    expect(byId.get(seen.userId)!.last_login_at).toBe('2026-10-16T09:30:15.123457Z'); // the microseconds survive, digit for digit
    const stored = new Map((await sql<{ id: string; updated_at: string }>('SELECT id, updated_at FROM users')).map((r) => [r.id, r.updated_at]));
    for (const p of listed) {
      expect(p.updated_at, p.email).toMatch(WIRE_TIMESTAMP);
      expect(p.updated_at, `${p.email}: updated_at is the stored stamp, text for text`).toBe(wire(stored.get(p.id)!));
      expect(p.id, p.email).toMatch(UUID);
    }
  });

  it('the people are ordered by created_at, then id', async () => {
    const role = await newRole('Order', []);
    const [a, b, c, d1, d2] = [await w.world.addUser({ role: role.key }), await w.world.addUser({ role: role.key }), await w.world.addUser({ role: role.key }), await w.world.addUser({ role: role.key }), await w.world.addUser({ role: role.key })];
    // made out of order on purpose: b first, then a, then c; d1 and d2 at the very same instant, after c
    const made = new Map([[b.userId, '2099-03-01 10:00:00.000001'], [a.userId, '2099-03-01 10:00:00.000002'], [c.userId, '2099-03-01 10:00:00.999999'], [d1.userId, '2099-03-02 00:00:00.000000'], [d2.userId, '2099-03-02 00:00:00.000000']]);
    for (const [id, at] of made) await sql('UPDATE users SET created_at = ? WHERE id = ?', [at, id]);

    const listed = (await people()).map((p) => p.id);
    // the whole list is the table in (created_at, id) order, asked of the database another way
    expect(listed).toEqual((await sql<{ id: string }>('SELECT id FROM users ORDER BY created_at, id')).map((r) => r.id));
    // and the five are in the order made above (the tie between d1 and d2 goes by id), after every login made before
    const ties = (await sql<{ id: string }>('SELECT id FROM users WHERE id IN (?, ?) ORDER BY id', [d1.userId, d2.userId])).map((r) => r.id);
    expect(listed.filter((id) => made.has(id))).toEqual([b.userId, a.userId, c.userId, ...ties]);
    expect(listed.slice(-5)).toEqual([b.userId, a.userId, c.userId, ...ties]);
  });

  it('a login whose role has no row (the foreign key forbids it; a hand edit can make it) is still listed, with its key as the name: the list does not crash', async () => {
    const role = await newRole('Ghost', []);
    const orphan = await w.world.addUser({ role: role.key });
    await sql('SET SESSION foreign_key_checks = 0');
    try {
      await sql("UPDATE users SET role = 'ghost' WHERE id = ?", [orphan.userId]); // there is no role of that key
      const res = await asSuper('/v1/super/people');
      expect(res.statusCode, res.body).toBe(200);
      const row: Person = json(res).people.find((p: Person) => p.id === orphan.userId);
      expect(row).toMatchObject({ role: 'ghost', role_name: 'ghost', active: true, is_super_admin: false });
      expect(Object.keys(row)).toEqual(PERSON_KEYS);
      expect(json(res).people.length).toBe(Number((await sql<{ n: string }>('SELECT COUNT(*) AS n FROM users'))[0].n)); // nobody is dropped by the join
    } finally {
      await sql('UPDATE users SET role = ? WHERE id = ?', [role.key, orphan.userId]);
      await sql('SET SESSION foreign_key_checks = 1');
    }
  });
});

// ------------------------------------------------------------------ GET /v1/super/roles

describe('GET /v1/super/roles (super:roles.list)', () => {
  it('the roles list shows the Owner as fixed with 32 ticks, and counts only active people', async () => {
    const busy = await newRole('Busy', ['customer_view', 'bill_view', 'bill_make'], { description: 'Makes bills.' });
    const empty = await newRole('Empty', ['order_view']);
    const off = await newRole('Off', [], { active: false });
    await w.world.addUser({ role: busy.key });
    await w.world.addUser({ role: busy.key });
    await w.world.addUser({ role: busy.key, active: false }); // switched off: not counted
    const staffBefore = await activeHolders('staff');

    const res = await asSuper('/v1/super/roles');
    expect(res.statusCode, res.body).toBe(200);
    const answer = json(res);
    expect(Object.keys(answer)).toEqual(['roles']);
    const listed: Role[] = answer.roles;
    for (const r of listed) expect(Object.keys(r), r.key).toEqual(ROLE_KEYS);

    // the Owner: fixed, every tick in catalogue order, the name and the key of the seed
    const owner = listed.find((r) => r.key === 'owner')!;
    expect(owner).toMatchObject({ key: 'owner', name: 'Owner', active: true, fixed: true });
    expect(owner.ticks).toEqual(KEYS);
    expect(owner.ticks).toHaveLength(32);
    // fixed is true for the Owner and for no other row
    expect(listed.filter((r) => r.fixed).map((r) => r.key)).toEqual(['owner']);

    // people counts ACTIVE logins on the role, for the Owner (the Super Admin's login holds that role too), the other two built-in roles and the made ones
    for (const r of listed) expect(r.people, r.key).toBe(await activeHolders(r.key));
    const byKey = new Map(listed.map((r) => [r.key, r]));
    expect(byKey.get(busy.key)).toMatchObject({ people: 2, active: true, fixed: false, description: 'Makes bills.', ticks: ['customer_view', 'bill_view', 'bill_make'] });
    expect(byKey.get(empty.key)).toMatchObject({ people: 0, active: true, ticks: ['order_view'] });
    expect(byKey.get(off.key)).toMatchObject({ people: 0, active: false, ticks: [] }); // a switched-off role is listed, as switched off
    // a login switched off is not a person of the role, and switching one on is
    expect(byKey.get('staff')!.people).toBe(staffBefore);
    const sleeper = await w.world.addUser({ role: 'staff', active: false });
    expect((await roles()).find((r) => r.key === 'staff')!.people).toBe(staffBefore);
    await sql('UPDATE users SET active = 1 WHERE id = ?', [sleeper.userId]);
    expect((await roles()).find((r) => r.key === 'staff')!.people).toBe(staffBefore + 1);
    // the fixtures: owner, ended, expired, idle and the Super Admin are the five active logins of the Owner role; the inactive one is not counted
    expect(byKey.get('owner')!.people).toBe(5);
    expect(byKey.get('biller')!.people).toBe(1);
  });

  it('the Owner and the two built-in roles are the first three, then the made roles by creation time and key; updated_at, name, description and key are the stored ones', async () => {
    const [zeta, alpha, later, first] = [await newRole('Zeta', ['order_view'], { key: 'zeta' }), await newRole('Alpha', [], { key: 'alpha' }), await newRole('Later', []), await newRole('First', [])];
    // far in the future, so that they come after the seeds as made roles do; zeta and alpha at the very same instant
    for (const [key, at] of [[first.key, '2099-01-01 00:00:00.000000'], [zeta.key, '2099-02-01 00:00:00.000000'], [alpha.key, '2099-02-01 00:00:00.000000'], [later.key, '2099-03-01 00:00:00.000000']]) await sql('UPDATE roles SET created_at = ? WHERE role_key = ?', [at, key]);

    const listed = await roles();
    expect(listed.slice(0, 3).map((r) => r.key)).toEqual(['owner', 'biller', 'staff']);
    expect(listed.filter((r) => [first.key, zeta.key, alpha.key, later.key].includes(r.key)).map((r) => r.key)).toEqual([first.key, 'alpha', 'zeta', later.key]);
    // every made role (those of the other tests too) comes after the three
    expect(listed.map((r) => r.key).filter((k) => !['owner', 'biller', 'staff'].includes(k))).toEqual(listed.slice(3).map((r) => r.key));

    const stored = new Map((await sql<{ role_key: string; name: string; description: string; updated_at: string }>('SELECT role_key, name, description, updated_at FROM roles')).map((r) => [r.role_key, r]));
    expect(listed).toHaveLength(stored.size);
    for (const r of listed) {
      const row = stored.get(r.key)!;
      expect(r.name, r.key).toBe(row.name);
      expect(r.description, r.key).toBe(row.description);
      expect(r.updated_at, r.key).toMatch(WIRE_TIMESTAMP);
      expect(r.updated_at, `${r.key}: updated_at is the stored stamp, text for text (a write names it as expected_updated_at)`).toBe(wire(row.updated_at));
      expect(typeof r.active).toBe('boolean');
      expect(Number.isInteger(r.people)).toBe(true);
    }
  });

  it('tick keys this version does not know are ignored, the known ones are listed once each in catalogue order, and nothing crashes (Review Focus 2, R4)', async () => {
    // written out of order, with a repeat, a key dropped by a later release, a wrong capital, a number and null: what a hand edit or an older release can leave
    const written = ['order_view', 'dropped_tick', 'stock_add', 'Bill_View', 'stock_add', 7, null, '', 'customer_view'] as unknown as string[]; // the column is any JSON list
    const odd = await newRole('Odd', written);
    const none = await newRole('Nothing known', ['gone', 'also_gone']);
    const listed = await roles();
    expect(listed.find((r) => r.key === odd.key)!.ticks).toEqual(['stock_add', 'customer_view', 'order_view']);
    expect(listed.find((r) => r.key === none.key)!.ticks).toEqual([]);
  });

  it('the Owner is every tick whatever its ticks column holds (R3): a hand edit of the column changes nothing on the list', async () => {
    await sql('UPDATE roles SET ticks = ? WHERE role_key = ?', [JSON.stringify(['bill_view']), 'owner']);
    try {
      const owner = (await roles()).find((r) => r.key === 'owner')!;
      expect(owner.ticks).toEqual(KEYS);
      expect(owner.fixed).toBe(true);
    } finally {
      await sql('UPDATE roles SET ticks = ? WHERE role_key = ?', ['[]', 'owner']);
    }
  });
});

// ------------------------------------------------------------------ the reads write nothing

describe('the three reads write nothing', () => {
  it('no audit_log row and no event, no change to users, roles or claims; the only statement that is not a SELECT is the wrapper\'s touch of the session (U4)', async () => {
    const role = await newRole('Quiet', ['order_view']);
    await w.world.addUser({ role: role.key });
    for (const url of ['/v1/super/ticks', '/v1/super/people', '/v1/super/roles']) {
      const before = await digest();
      const from = w.world.spy.sent.length;
      const res = await asSuper(url);
      expect(res.statusCode, `${url}: ${res.body}`).toBe(200);
      const sent = w.world.spy.sqls().slice(from);
      expect(await digest(), `${url} wrote something`).toEqual(before);
      // every statement is a read (or the checkout's SET SESSION), except the session's own last_seen_at, which the wrapper moves for every call that is not polling (U4)
      const other = sent.filter((s) => !/^(SELECT|SET SESSION)\b/i.test(s.trim()));
      expect(other, url).toHaveLength(1);
      expect(other[0], url).toMatch(/^UPDATE sessions SET last_seen_at = \?/);
    }
  });
});

// ------------------------------------------------------------------ how the answers travel

describe('the three answers', () => {
  it('are JSON and are never cached: the people list holds every e-mail of the shop (Cache-Control: no-store, as every answer of the API)', async () => {
    for (const url of ['/v1/super/ticks', '/v1/super/people', '/v1/super/roles']) {
      const res = await asSuper(url);
      expect(res.statusCode, url).toBe(200);
      expect(res.headers['content-type'], url).toMatch(/^application\/json/);
      expect(res.headers['cache-control'], url).toBe('no-store');
      expect(res.headers['x-request-id'], url).toMatch(UUID);
    }
  });
});

// ------------------------------------------------------------------ what the query string may hold

describe('the three reads take no query string', () => {
  it('a key in it is refused with 422 on that key, as every read of the API refuses a key it does not know; a caller who is not the Super Admin is refused first, with 403', async () => {
    for (const url of ['/v1/super/ticks', '/v1/super/people', '/v1/super/roles']) {
      const res = await asSuper(`${url}?limit=1`);
      expect([res.statusCode, json(res).error.code, json(res).error.details], url).toEqual([422, 'JV_INVALID_INPUT', { field: 'limit' }]);
      const owner = await w.world.call('owner', 'GET', `${url}?limit=1`);
      expect([owner.statusCode, json(owner).error.code], `${url} (the Owner)`).toEqual([403, 'JV_FORBIDDEN']); // the gate answers before the query is judged
    }
  });
});

// ------------------------------------------------------------------ the second check of each read

describe('each read checks the caller again at its start (X0 item 2): the function is refused for grants that are not the Super Admin\'s, before it reads anything', () => {
  it('the Owner key without the flag, a role holding all 32 ticks and nobody are refused with the usual sentence; the flag passes', async () => {
    const { readPeople, readRoles, tickCatalogue } = await import('../../src/super/queries');
    const reader = (log: string[]) => ({
      rows: async (text: string) => {
        log.push(text);
        return [];
      },
    });
    const refused = [grantsOf({ roleKey: 'owner', roleTicks: [], isSuperAdmin: false }), grantsOf({ roleKey: 'everything', roleTicks: [...TICK_KEYS], isSuperAdmin: false }), NO_GRANTS];
    for (const g of refused) {
      for (const call of [(log: string[]) => readPeople(reader(log), g), (log: string[]) => readRoles(reader(log), g), async () => tickCatalogue(g)]) {
        const log: string[] = [];
        const err = await call(log).then(
          () => undefined,
          (e: JvError) => e,
        );
        expect([err?.code, err?.status]).toEqual(['JV_FORBIDDEN', 403]);
        expect(err?.message).toBe('You are not allowed to do this.');
        expect(log, 'a refused read asked the database something').toEqual([]);
      }
    }
    const flagged = grantsOf({ roleKey: 'owner', roleTicks: [], isSuperAdmin: true });
    const log: string[] = [];
    expect(await readPeople(reader(log), flagged)).toEqual({ people: [] }); // the answer of the call itself, here over an empty database
    expect(await readRoles(reader(log), flagged)).toEqual({ roles: [] });
    expect(log).toHaveLength(2);
    expect(tickCatalogue(flagged).ticks).toHaveLength(32);
  });
});
