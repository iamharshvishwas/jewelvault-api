import { describe, expect, it } from 'vitest';
import { NO_GRANTS, accessFingerprint, grantsOf, hasAnyTick, hasTick, sortedTicks, type Grants } from '../../src/permissions/grants';
import {
  FIELD_RIGHTS,
  MATRIX,
  STAFF_SETTING_KEYS,
  WRITE_COLUMNS,
  accessAllows,
  columnsOfTable,
  dailyTotalsWindowDays,
  mayCall,
  mayUseField,
  readableSettingKeys,
  writeFieldVerdict,
  type Action,
  type EditAction,
  type FieldRight,
} from '../../src/permissions/matrix';
import { SCREEN_ONLY, TICK_KEYS, closeOverNeeds, type TickKey } from '../../src/permissions/ticks';

// P2 and P4 of DESIGN.md section 8: the matrix lists ticks, and each tick opens exactly the rows it covers. The oracle below is typed in by hand from the "Covers" column of DESIGN.md 6.2 and from the
// block "Which tick opens which matrix row" of the plan, never read from src/permissions/matrix.ts: when the two disagree, one of them is wrong and the change is made on purpose.

/** The rows every signed-in person may call, whatever their ticks (DESIGN.md 6.2 "Always on"). */
const OPEN_ROWS: readonly Action[] = [
  'read:users',
  'read:settings',
  'read:daily_rates',
  'read:categories',
  'read:subcategories',
  'read:designs',
  'read:skus',
  'read:poll',
  'session:me',
  'session:logout',
  'session:change-password',
  'session:activity',
];

/** The rows each tick opens. A tick that is only a field right, a limit or a screen opens none. */
const COVERS: Record<TickKey, readonly Action[]> = {
  stock_add: ['fn:create_design', 'photo:upload'],
  stock_edit: ['edit:designs.update', 'edit:skus.update'],
  stock_status: ['fn:set_sku_status'],
  category_add: ['edit:categories.insert', 'edit:subcategories.insert'],
  category_edit: ['edit:categories.update', 'edit:subcategories.update'],
  design_material: ['edit:designs.update'],
  secret_weight: ['read:sku_private', 'edit:sku_private.update'],
  photo_rewrite: ['photo:remove'],
  customer_view: ['read:customers'],
  bill_view: ['read:bills', 'read:bill_items', 'read:receipts', 'read:receipt_allocations', 'read:bill_summary', 'read:customer_balances', 'read:customer_ledger'],
  cashbook_recent: ['read:daily_totals'],
  cashbook_all: ['read:daily_totals'],
  customer_edit: ['fn:create_customer', 'edit:customers.update'],
  customer_archive: ['edit:customers.update'],
  bill_make: ['fn:create_bill', 'fn:quote_bill'],
  payment_receive: ['fn:record_payment', 'fn:settle_fine'],
  rate_enter: ['edit:daily_rates.insert'],
  rate_correct: ['edit:daily_rates.update'],
  back_date: [],
  bill_cancel: ['fn:cancel_bill'],
  bill_reissue: ['fn:reissue_bill'],
  payment_void: ['fn:void_receipt'],
  refund_give: ['fn:issue_refund'],
  opening_balance: ['fn:add_opening_balance'],
  cash_over_limit: [],
  order_view: ['read:orders'],
  order_edit: ['fn:create_order', 'edit:orders.update', 'photo:upload_order'],
  order_closed_change: [],
  reports_open: [],
  activity_log: ['read:audit_log', 'read:health_checks', 'read:dashboard_health'],
  download_all: ['owner:download_record'],
  settings_change: ['edit:settings.update'],
};

/** The five field rights and the tick of each (DESIGN.md 6.2: S7, P1, M11, M17, O3). */
const FIELD_TICKS: Record<FieldRight, TickKey> = {
  cash_override_reason: 'cash_over_limit',
  original_net_weight: 'secret_weight',
  back_dates: 'back_date',
  rewrite_photo_ids: 'photo_rewrite',
  change_closed_order: 'order_closed_change',
};

const ticksOnly = (ticks: readonly unknown[]): Grants => grantsOf({ roleKey: 'x', roleTicks: ticks, isSuperAdmin: false });
const sorted = (actions: Iterable<Action>): Action[] => [...new Set(actions)].sort();
const ACTIONS = Object.keys(MATRIX) as Action[];
const allowedActions = (g: Grants): Action[] => sorted(ACTIONS.filter((a) => mayCall(g, a)));
const EDIT_ACTIONS = Object.keys(WRITE_COLUMNS) as EditAction[];

/** Every name an edit is asked about: the columns of its table, every list of the row, a stamp and a name that is nowhere. */
const askedOf = (action: EditAction): string[] => {
  const edit = MATRIX[action].edit!;
  return [...new Set([...columnsOfTable(edit.table), ...Object.values(WRITE_COLUMNS[action]).flatMap((l) => l ?? []), 'created_at', 'nonexistent_field'])];
};

describe('P4 completeness of the matrix', () => {
  it('P4: every row is open, anyOf with at least one tick, or superAdmin', () => {
    for (const action of ACTIONS) {
      const a = MATRIX[action].access;
      const shapes = ['open' in a && a.open === true, 'anyOf' in a && a.anyOf.length > 0 && a.anyOf.every((t) => (TICK_KEYS as readonly string[]).includes(t)), 'superAdmin' in a && a.superAdmin === true];
      expect(shapes.filter(Boolean), action).toHaveLength(1);
      expect(MATRIX[action].kind === 'super', `${action}: a superAdmin row is of kind super and only it`).toBe('superAdmin' in a);
    }
  });

  it('P4: every tick opens a row, is a field right, a limit, or is in SCREEN_ONLY', () => {
    const fieldTicks = new Set<string>(Object.values(FIELD_RIGHTS));
    for (const tick of TICK_KEYS) {
      const g = ticksOnly([tick]);
      const opensRow = ACTIONS.some((a) => mayCall(g, a) && !mayCall(NO_GRANTS, a));
      const isLimit = readableSettingKeys(g) !== readableSettingKeys(NO_GRANTS) || dailyTotalsWindowDays(g) !== dailyTotalsWindowDays(NO_GRANTS);
      expect(opensRow || fieldTicks.has(tick) || isLimit || SCREEN_ONLY.includes(tick), tick).toBe(true);
    }
  });

  it('P4: the ticks of each row are exactly the ticks whose COVERS list it: an open or superAdmin row has none, and no tick opens a row it does not cover (a role stored without its needs gets no more)', () => {
    for (const action of ACTIONS) {
      const a = MATRIX[action].access;
      const ticks = 'anyOf' in a ? [...a.anyOf].sort() : [];
      const covering = TICK_KEYS.filter((t) => COVERS[t].includes(action)).sort();
      expect(ticks, action).toEqual(covering);
      if (OPEN_ROWS.includes(action)) expect('open' in a, `${action} is open`).toBe(true);
    }
  });

  it('the open rows are what a person with no tick may call', () => {
    expect(allowedActions(NO_GRANTS)).toEqual(sorted(OPEN_ROWS));
    expect(allowedActions(ticksOnly(['not_a_tick', 7, null, '__proto__']))).toEqual(sorted(OPEN_ROWS));
  });
});

describe('P2 tick isolation', () => {
  it.each(TICK_KEYS)('P2: a role holding only %s and what it needs may call exactly the rows it covers plus the open rows', (tick) => {
    const ticks = closeOverNeeds([tick]);
    const g = ticksOnly(ticks);
    expect(allowedActions(g)).toEqual(sorted([...OPEN_ROWS, ...ticks.flatMap((t) => COVERS[t])]));
  });

  it('a superAdmin row passes only isSuperAdmin: all 32 ticks without the flag fail, the flag passes', () => {
    const access = { superAdmin: true } as const;
    expect(accessAllows(access, grantsOf({ roleKey: 'owner', roleTicks: [], isSuperAdmin: false }))).toBe(false);
    expect(accessAllows(access, ticksOnly([...TICK_KEYS]))).toBe(false);
    expect(accessAllows(access, NO_GRANTS)).toBe(false);
    expect(accessAllows(access, grantsOf({ roleKey: 'owner', roleTicks: [], isSuperAdmin: true }))).toBe(true);
  });

  it('limits follow the ticks: bill_view, bill_make or settings_change read every settings key, nothing else does; cashbook_all is the wide window, cashbook_recent 2 days, neither 0', () => {
    for (const tick of TICK_KEYS) {
      const g = ticksOnly([tick]);
      expect(readableSettingKeys(g), tick).toEqual(['bill_view', 'bill_make', 'settings_change'].includes(tick) ? null : STAFF_SETTING_KEYS);
      expect(dailyTotalsWindowDays(g), tick).toBe(tick === 'cashbook_all' ? null : tick === 'cashbook_recent' ? 2 : 0);
    }
    expect(readableSettingKeys(NO_GRANTS)).toEqual(STAFF_SETTING_KEYS);
    expect(dailyTotalsWindowDays(NO_GRANTS)).toBe(0);
    expect(dailyTotalsWindowDays(ticksOnly(['cashbook_recent', 'cashbook_all']))).toBeNull();
  });

  it('the five field rights map to cash_over_limit, secret_weight, back_date, photo_rewrite, order_closed_change', () => {
    expect(FIELD_RIGHTS).toEqual(FIELD_TICKS);
    for (const field of Object.keys(FIELD_TICKS) as FieldRight[]) {
      for (const tick of TICK_KEYS) expect(mayUseField(ticksOnly([tick]), field), `${field}/${tick}`).toBe(tick === FIELD_TICKS[field]);
      expect(mayUseField(NO_GRANTS, field)).toBe(false);
    }
  });

  it('every direct-edit row of a tick is readable by that tick: the table it edits is read by the tick or always', () => {
    for (const tick of TICK_KEYS) {
      const g = ticksOnly(closeOverNeeds([tick]));
      for (const action of EDIT_ACTIONS) {
        if (!mayCall(g, action)) continue;
        const table = MATRIX[action].edit!.table;
        const readRow = ACTIONS.find((a) => MATRIX[a].kind === 'read' && (MATRIX[a].reads ?? []).includes(table as never));
        expect(readRow, `${table} has a read row`).toBeDefined();
        expect(mayCall(g, readRow!), `${tick} edits ${table} and reads it`).toBe(true);
      }
    }
  });

  it('writeFieldVerdict: design_material alone may send material, purity, selling_method and nothing else; customer_archive alone only archived_at; an unknown tick set may send nothing', () => {
    const allowedFor = (g: Grants, action: EditAction) => askedOf(action).filter((f) => writeFieldVerdict(action, g, f) === 'allowed').sort();
    expect(allowedFor(ticksOnly(['design_material']), 'edit:designs.update')).toEqual(['material', 'purity', 'selling_method']);
    expect(allowedFor(ticksOnly(['customer_archive']), 'edit:customers.update')).toEqual(['archived_at']);
    for (const action of EDIT_ACTIONS) {
      expect(allowedFor(ticksOnly(['not_a_tick', 'owner']), action), action).toEqual([]);
      expect(allowedFor(NO_GRANTS, action), action).toEqual([]);
    }
    expect(writeFieldVerdict('edit:designs.update', ticksOnly(['design_material']), 'name')).toBe('forbidden');
    expect(writeFieldVerdict('edit:designs.update', ticksOnly(['design_material']), 'created_at')).toBe('unknown');
  });
});

describe('grants (R4, R5)', () => {
  it('the Owner key or the Super Admin flag holds every tick whatever the column says; another key holds what the column lists', () => {
    expect(sortedTicks(grantsOf({ roleKey: 'owner', roleTicks: [], isSuperAdmin: false }))).toEqual([...TICK_KEYS]);
    expect(sortedTicks(grantsOf({ roleKey: 'someone', roleTicks: null, isSuperAdmin: true }))).toEqual([...TICK_KEYS]);
    expect(sortedTicks(ticksOnly(['order_view', 'stock_add']))).toEqual(['stock_add', 'order_view']);
  });

  it('unknown keys are ignored, a column given as text is parsed, a bad column holds nothing and never throws', () => {
    expect(sortedTicks(ticksOnly(['bill_view', 'dropped_tick', 42, { a: 1 }]))).toEqual(['bill_view']);
    expect(sortedTicks(grantsOf({ roleKey: 'x', roleTicks: '["customer_view","gone"]', isSuperAdmin: false }))).toEqual(['customer_view']);
    for (const bad of ['not json', '{"a":1}', 7, null, undefined, {}]) expect(sortedTicks(grantsOf({ roleKey: 'x', roleTicks: bad, isSuperAdmin: false })), String(bad)).toEqual([]);
  });

  it('a Grants value cannot be changed, so no caller can change what another is given: a tick added, taken away or cleared through a cast (the types forbid it) changes nothing, for the value itself, for a later grantsOf of the same role and for NO_GRANTS', () => {
    // the hazard this closes: Object.freeze does not freeze a Set, and ReadonlySet stops .add at compile time only, so one holder of a shared value could widen what every later holder may do
    const tamper = (g: Grants): void => {
      const set = g.ticks as Set<TickKey>;
      for (const attempt of [() => set.add('settings_change'), () => set.delete('bill_view'), () => set.clear(), () => ((g as { isSuperAdmin: boolean }).isSuperAdmin = true)]) {
        try {
          attempt();
        } catch {
          // a set with no add, delete or clear, and a frozen value, refuse: that is as good as ignoring it
        }
      }
    };
    const clerk = { roleKey: 'clerk', roleTicks: ['bill_view'], isSuperAdmin: false };
    const owner = { roleKey: 'owner', roleTicks: [], isSuperAdmin: false };
    for (const [what, input, held] of [['a role with one tick', clerk, ['bill_view']], ['the Owner', owner, [...TICK_KEYS]]] as const) {
      const first = grantsOf(input);
      tamper(first);
      expect(sortedTicks(first), `${what}: the value that was tampered with`).toEqual(held);
      expect(first.isSuperAdmin, `${what}: the flag of the value that was tampered with`).toBe(false);
      const later = grantsOf(input);
      expect(sortedTicks(later), `${what}: a later grantsOf`).toEqual(held);
      expect(later.isSuperAdmin, `${what}: the flag of a later grantsOf`).toBe(false);
      expect(later.ticks, `${what}: every call makes a set of its own`).not.toBe(first.ticks);
    }
    tamper(NO_GRANTS); // the one value that is shared
    expect(sortedTicks(NO_GRANTS)).toEqual([]);
    expect(NO_GRANTS.isSuperAdmin).toBe(false);
    expect(mayCall(NO_GRANTS, 'read:customers')).toBe(false);
    expect(mayCall(NO_GRANTS, 'edit:settings.update')).toBe(false);
  });

  it('hasTick and hasAnyTick', () => {
    const g = ticksOnly(['bill_view']);
    expect(hasTick(g, 'bill_view')).toBe(true);
    expect(hasTick(g, 'bill_make')).toBe(false);
    expect(hasAnyTick(g, ['bill_make', 'bill_view'])).toBe(true);
    expect(hasAnyTick(g, [])).toBe(false);
  });

  it('the access fingerprint is 16 hex characters and moves with the key, the ticks and the flag, not with the order of the column', () => {
    const f = accessFingerprint('clerk', ticksOnly(['bill_view', 'customer_view']));
    expect(f).toMatch(/^[0-9a-f]{16}$/);
    expect(accessFingerprint('clerk', ticksOnly(['customer_view', 'bill_view']))).toBe(f);
    expect(accessFingerprint('other', ticksOnly(['bill_view', 'customer_view']))).not.toBe(f);
    expect(accessFingerprint('clerk', ticksOnly(['bill_view']))).not.toBe(f);
    expect(accessFingerprint('clerk', grantsOf({ roleKey: 'clerk', roleTicks: ['bill_view', 'customer_view'], isSuperAdmin: true }))).not.toBe(f);
  });
});
