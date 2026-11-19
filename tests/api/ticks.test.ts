import { describe, expect, it } from 'vitest';
import {
  BUILTIN_TICKS,
  OWNER_KEY,
  ROLE_KEY_PATTERN,
  SCREEN_ONLY,
  TICK_GROUPS,
  TICK_KEYS,
  TICKS,
  brokenNeeds,
  closeOverNeeds,
  isTickKey,
  type TickKey,
} from '../../src/permissions/ticks';

// DESIGN.md 6.1, 6.2 and R2, R16 of the plan: the tick catalogue of src/permissions/ticks.ts. TABLE below is typed in from the plan (the 32 ticks: keys, groups, words on screen, direct needs) as an independent
// oracle, so that a word or a need edited by mistake fails here before a screen or a route is built on it. The other checks are the rules the catalogue gives to the code around it: what a tick key is, closing a
// set over its needs, spotting a set that breaks one, the three built-in sets of day one (P1) and the shape of a role key. The module reads no database and no request, so this file needs neither.

/** The table of the plan in catalogue order: key, group, words on screen, direct needs. The sensitive ticks and the four help texts have their own checks below. */
const TABLE: readonly (readonly [string, string, string, readonly string[]])[] = [
  ['stock_add', 'Stock', 'Add designs and photos', []],
  ['stock_edit', 'Stock', 'Edit design and piece details (including weights and labour rates)', []],
  ['stock_status', 'Stock', "Change a piece's status", []],
  ['category_add', 'Stock', 'Add categories and sub-categories', []],
  ['category_edit', 'Stock', 'Edit or switch off categories', []],
  ['design_material', 'Stock', "Change a design's metal, purity or selling method", []],
  ['secret_weight', 'Stock', 'See and enter the original (secret) weight', []],
  ['photo_rewrite', 'Photos', 'Remove, reorder or replace photos (designs and orders)', []],
  ['customer_view', 'Money', 'See customers (name, phone, address, GST)', []],
  ['bill_view', 'Money', 'See bills, payments and customer ledgers', []],
  ['cashbook_recent', 'Money', 'See the cash book for today and yesterday', []],
  ['cashbook_all', 'Money', 'See the cash book for all days', ['cashbook_recent']],
  ['customer_edit', 'Money', 'Add and edit customers', ['customer_view']],
  ['customer_archive', 'Money', 'Archive a customer', ['customer_view', 'bill_view']],
  ['bill_make', 'Money', 'Make bills and estimates', ['customer_view', 'bill_view']],
  ['payment_receive', 'Money', 'Receive payments and settle fine', ['customer_view', 'bill_view']],
  ['rate_enter', 'Money', "Enter today's metal rates", []],
  ['rate_correct', 'Money', 'Correct a daily rate', ['rate_enter']],
  ['back_date', 'Money', 'Use a date other than today (back-date)', []],
  ['bill_cancel', 'Money', 'Cancel a bill', ['customer_view', 'bill_view']],
  ['bill_reissue', 'Money', 'Re-issue a bill', ['customer_view', 'bill_view']],
  ['payment_void', 'Money', 'Void a payment', ['customer_view', 'bill_view']],
  ['refund_give', 'Money', 'Give a refund', ['customer_view', 'bill_view']],
  ['opening_balance', 'Money', 'Add an opening balance', ['customer_view', 'bill_view']],
  ['cash_over_limit', 'Money', 'Take cash over the limit (with a reason)', ['payment_receive']],
  ['order_view', 'Orders', 'See the Order Book', []],
  ['order_edit', 'Orders', 'Make and change orders, add order photos', ['order_view', 'customer_view']],
  ['order_closed_change', 'Orders', 'Change a delivered or cancelled order', []],
  ['reports_open', 'Records', 'Open Reports', []],
  [
    'activity_log',
    'Records',
    'See the Activity Log and health checks (shows every change ever made, including customers, money and the secret weight)',
    ['secret_weight', 'customer_view', 'bill_view', 'order_view'],
  ],
  ['download_all', 'Records', 'Download everything', []],
  ['settings_change', 'Shop', 'Change shop settings', []],
];

/** The four help texts of the plan, the only ticks that have one. */
const HELP: Record<string, string> = {
  bill_make: 'A bill that takes payment also needs "Receive payments and settle fine". Without that, the role can still save a bill that takes no payment.',
  bill_reissue:
    'Without "Use a date other than today", only bills dated today can be re-issued (the new bill keeps the old date). Without "Receive payments and settle fine", the re-issue takes no new payment.',
  rate_enter: 'Today\'s rate only. Any other date also needs "Use a date other than today".',
  stock_edit: 'Weights and labour rates are the price inputs.',
};

/** What each tick needs, key by key, for the checks that work the needs out another way than the module does. */
const needsOf = new Map<TickKey, readonly TickKey[]>(TICKS.map((t) => [t.key, t.needs]));

/** The tick and, by plain recursion, everything it needs. (closeOverNeeds works by repeated expansion; this is the other way round, to check it against.) */
const reach = (key: TickKey): TickKey[] => [key, ...(needsOf.get(key) ?? []).flatMap((need) => reach(need))];

/** The name of a tick that is on a cycle of the needs, or null when there is none: depth first, a tick met again while it is still on the path closes a cycle. */
function cycleIn(needs: ReadonlyMap<string, readonly string[]>): string | null {
  const onPath = new Set<string>();
  const cleared = new Set<string>();
  const visit = (key: string): string | null => {
    if (onPath.has(key)) return key;
    if (cleared.has(key)) return null;
    onPath.add(key);
    for (const need of needs.get(key) ?? []) {
      const found = visit(need);
      if (found !== null) return found;
    }
    onPath.delete(key);
    cleared.add(key);
    return null;
  };
  for (const key of needs.keys()) {
    const found = visit(key);
    if (found !== null) return found;
  }
  return null;
}

describe('the catalogue', () => {
  it('has 32 unique keys in table order, six groups, and 12 sensitive ticks', () => {
    expect(TICK_KEYS).toHaveLength(32);
    expect(new Set(TICK_KEYS).size).toBe(32);
    expect(TICKS.map((t) => t.key)).toEqual(TICK_KEYS);
    expect(TICK_GROUPS).toEqual(['Stock', 'Photos', 'Money', 'Orders', 'Records', 'Shop']);
    // each group is one block of the table, and the blocks come in the order of TICK_GROUPS
    expect(TICKS.map((t) => t.group).filter((group, i, all) => group !== all[i - 1])).toEqual(TICK_GROUPS);
    expect(TICKS.filter((t) => t.sensitive).map((t) => t.key).sort()).toEqual(
      ['activity_log', 'back_date', 'bill_cancel', 'bill_reissue', 'download_all', 'opening_balance', 'order_closed_change', 'payment_void', 'refund_give', 'secret_weight', 'settings_change', 'cash_over_limit'].sort(),
    );
  });

  it('is the table of the plan, row for row: key, group, words on screen and needs', () => {
    expect(TICKS.map((t) => [t.key, t.group, t.label, t.needs])).toEqual(TABLE);
  });

  it('words: every label is 1 to 140 characters with no underscore; help exists for bill_make, bill_reissue, rate_enter, stock_edit and for no other tick', () => {
    for (const t of TICKS) {
      expect(t.label.length, t.key).toBeGreaterThanOrEqual(1);
      expect(t.label.length, t.key).toBeLessThanOrEqual(140);
      expect(t.label, t.key).toBe(t.label.trim());
      // plain English on the screen: no key, no technical word (the plan's global constraint)
      expect(`${t.label} ${t.help ?? ''}`, t.key).not.toMatch(/_|\b(sku|matrix)\b/i);
    }
    expect(new Set(TICKS.map((t) => t.label)).size, 'two ticks read the same on the screen').toBe(32);
    expect(Object.fromEntries(TICKS.filter((t) => t.help !== null).map((t) => [t.key, t.help]))).toEqual(HELP);
  });

  it('SCREEN_ONLY is Open Reports and nothing else', () => {
    expect(SCREEN_ONLY).toEqual(['reports_open']);
    expect(SCREEN_ONLY.every(isTickKey)).toBe(true);
  });
});

describe('needs', () => {
  it('every need is a tick, none needs itself, the needs have no cycle', () => {
    for (const t of TICKS) {
      for (const need of t.needs) {
        expect(isTickKey(need), `${t.key} needs ${need}, which is not a tick`).toBe(true);
        expect(need, `${t.key} needs itself`).not.toBe(t.key);
      }
      expect(new Set(t.needs).size, `${t.key} lists a need twice`).toBe(t.needs.length);
    }
    expect(cycleIn(needsOf)).toBeNull();
    // the check itself: it sees a cycle of three, a tick that needs itself, and it does not take a need shared by two ticks for a cycle
    expect(cycleIn(new Map([['a', ['b']], ['b', ['c']], ['c', ['a']]]))).not.toBeNull();
    expect(cycleIn(new Map([['a', ['a']]]))).not.toBeNull();
    expect(cycleIn(new Map([['a', ['b', 'c']], ['b', ['c']], ['c', []]]))).toBeNull();
  });

  it('closeOverNeeds is transitive and ordered', () => {
    expect(closeOverNeeds(['cash_over_limit'])).toEqual(['customer_view', 'bill_view', 'payment_receive', 'cash_over_limit']);
    expect(closeOverNeeds(['activity_log'])).toEqual(['secret_weight', 'customer_view', 'bill_view', 'order_view', 'activity_log']);
    expect(closeOverNeeds(['customer_archive'])).toEqual(['customer_view', 'bill_view', 'customer_archive']); // R19: the archive refusal names balances, which are data of the bills read
  });

  it('closeOverNeeds of any one tick is that tick and everything it needs, however deep, in catalogue order', () => {
    for (const key of TICK_KEYS) {
      const wanted = new Set(reach(key));
      expect(closeOverNeeds([key]), key).toEqual(TICK_KEYS.filter((k) => wanted.has(k)));
    }
  });

  it('closeOverNeeds lists nothing twice, ignores the order it is given, takes any iterable, drops what is not a tick, and leaves a closed set as it was', () => {
    const given: TickKey[] = ['order_edit', 'customer_view', 'order_edit', 'rate_correct'];
    const expected = ['customer_view', 'rate_enter', 'rate_correct', 'order_view', 'order_edit'];
    expect(closeOverNeeds(given)).toEqual(expected);
    expect(closeOverNeeds([...given].reverse())).toEqual(expected);
    expect(closeOverNeeds(new Set(given))).toEqual(expected);
    expect(closeOverNeeds([])).toEqual([]);
    const dirty: string[] = ['order_view', 'nope', '__proto__', 'constructor'];
    expect(closeOverNeeds(dirty as TickKey[])).toEqual(['order_view']);
    for (const set of Object.values(BUILTIN_TICKS)) expect(closeOverNeeds(set)).toEqual(set);
  });

  it('brokenNeeds names what is missing', () => {
    expect(brokenNeeds(['customer_edit'])).toEqual([{ tick: 'customer_edit', missing: ['customer_view'] }]);
    expect(brokenNeeds(closeOverNeeds(['order_edit', 'rate_correct']))).toEqual([]);
  });

  it('brokenNeeds lists each short tick once, in catalogue order, with every need it lacks (its direct needs), and nothing for a closed set', () => {
    // given out of catalogue order on purpose: three ticks are short, bill_view is held and needs nothing
    expect(brokenNeeds(['rate_correct', 'order_edit', 'customer_edit', 'bill_view'])).toEqual([
      { tick: 'customer_edit', missing: ['customer_view'] },
      { tick: 'rate_correct', missing: ['rate_enter'] },
      { tick: 'order_edit', missing: ['order_view', 'customer_view'] },
    ]);
    // direct needs only: cash_over_limit lacks payment_receive; what payment_receive needs is asked once payment_receive is in the set
    expect(brokenNeeds(['cash_over_limit'])).toEqual([{ tick: 'cash_over_limit', missing: ['payment_receive'] }]);
    expect(brokenNeeds(['cash_over_limit', 'payment_receive'])).toEqual([{ tick: 'payment_receive', missing: ['customer_view', 'bill_view'] }]);
    expect(brokenNeeds([])).toEqual([]);
    expect(brokenNeeds(TICK_KEYS)).toEqual([]);
    for (const key of TICK_KEYS) expect(brokenNeeds(closeOverNeeds([key])), key).toEqual([]);
  });
});

describe('the built-in sets and the role key', () => {
  it('the built-in sets are the day-one truth and closed under needs', () => {
    expect(BUILTIN_TICKS.owner).toEqual(TICK_KEYS);
    expect(BUILTIN_TICKS.biller).toEqual(['customer_view', 'bill_view', 'cashbook_recent', 'customer_edit', 'bill_make', 'payment_receive', 'rate_enter', 'order_view', 'order_edit']);
    expect(BUILTIN_TICKS.staff).toEqual(['stock_add', 'stock_edit', 'stock_status', 'category_add', 'order_view']);
    for (const set of Object.values(BUILTIN_TICKS)) expect(brokenNeeds(set)).toEqual([]);
  });

  it('the built-in roles are owner, biller and staff, and their sets hold real ticks once, in catalogue order', () => {
    expect(Object.keys(BUILTIN_TICKS)).toEqual(['owner', 'biller', 'staff']);
    expect(Object.keys(BUILTIN_TICKS)).toContain(OWNER_KEY);
    for (const [role, set] of Object.entries(BUILTIN_TICKS)) {
      expect(set.every(isTickKey), role).toBe(true);
      expect(set, role).toEqual(TICK_KEYS.filter((k) => set.includes(k)));
    }
  });

  it('a role key is a lower-case letter then up to eleven lower-case letters or hyphens: 12 at most, the width of users.role', () => {
    expect(OWNER_KEY).toBe('owner');
    for (const key of [...Object.keys(BUILTIN_TICKS), 'a', 'cash-desk', 'abcdefghijkl', 'a-b-c-d-e-f-']) expect(ROLE_KEY_PATTERN.test(key), key).toBe(true);
    // refused: nothing, a capital, a digit, a leading hyphen, an underscore, a space, 13 characters, a trailing newline, an accented letter, a zero-width space
    for (const key of ['', 'Owner', 'cashier2', '1cash', '-cash', 'cash_desk', 'cash desk', 'abcdefghijklm', 'owner\n', 'r\u00f4le', 'a\u200bb']) expect(ROLE_KEY_PATTERN.test(key), JSON.stringify(key)).toBe(false);
  });
});

describe('tick keys', () => {
  it('isTickKey refuses __proto__, constructor, numbers and unknown text', () => {
    for (const key of TICK_KEYS) expect(isTickKey(key), key).toBe(true);
    for (const text of ['__proto__', 'constructor', 'prototype', 'toString', 'hasOwnProperty', 'valueOf', '', 'owner', 'STOCK_ADD', 'Stock_Add', 'stock-add', ' stock_add', 'stock_add ', 'stock_add\n', 'stock_add\u200b', 'reports_open;']) {
      expect(isTickKey(text), JSON.stringify(text)).toBe(false);
    }
    for (const other of [0, 1, 31, -1, Number.NaN, 10n, true, null, undefined, {}, [], ['stock_add'], { toString: () => 'stock_add' }, Symbol('stock_add'), () => 'stock_add']) {
      expect(isTickKey(other), String(other)).toBe(false);
    }
  });

  it('isTickKey is a type guard: as a filter it keeps the keys and narrows the type', () => {
    const kept: TickKey[] = ['order_view', '__proto__', 'nope', 'stock_add', 'constructor'].filter(isTickKey);
    expect(kept).toEqual(['order_view', 'stock_add']);
  });
});
