// DESIGN.md 6.1, 6.2, P1 and R2, R3, R16 of the plan: THE TICK CATALOGUE. A tick is one thing a role may be allowed to do, said in plain words. There are 32, in six groups, and a role is a set of them (the Owner holds
// all 32). This file is the list and the rules about the list, and nothing else: it reads no database and no request and it imports nothing, so the permission matrix (which tick opens which row), the session (the ticks
// of the person calling), the People & Roles calls of the Super Admin (which sets may be saved) and the tests all ask one place. The words on the screen are written once, here.
//
// WHAT IS HERE
//   TICK_GROUPS, TICK_KEYS   the six groups and the 32 keys. TICK_KEYS is the catalogue order, the order of the table of DESIGN.md 6.2: the screen lists the ticks in it, and every list of ticks that is stored or sent is in it.
//   TICKS                    for each key: its group, its words on screen (`label`), the help text shown under it (four have one), whether it is sensitive (the screen asks a second confirm before one is turned on) and
//                            what it needs.
//   needs                    what a tick cannot work without, written DIRECT: a tick lists only what it needs itself. closeOverNeeds() makes them transitive (the screen turns the needed ticks on, a copied role starts
//                            from it); brokenNeeds() says what a set lacks (the API refuses a set that breaks a need).
//   BUILTIN_TICKS            the three roles of today as tick sets, the day-one truth (P1): Biller and Staff hold what they could do before roles were ticks, Owner holds all 32. Owner's ticks always come from
//                            here, never from the database (R3).
//   OWNER_KEY, ROLE_KEY_PATTERN   the Owner's role key, and the shape every role key has: a letter, then up to eleven letters or hyphens, so that it fits `users.role` (12 characters, R2).
//   SCREEN_ONLY              the ticks that open a website screen and no row of the matrix (Open Reports).
//   isTickKey                the one test a value passes before it is used as a tick key. A stored key that fails it is ignored by the caller (R4), a key in a request that fails it is refused: it is never trusted.
//
// ADDING A TICK: put its key in TICK_KEYS at its place and its entry in DEFS (the compiler refuses a key without an entry and an entry without a key), then say which row of the matrix it opens, and type its words
// into tests/api/ticks.test.ts too.

/** The six blocks of the People & Roles screen, in the order it shows them. */
export const TICK_GROUPS = ['Stock', 'Photos', 'Money', 'Orders', 'Records', 'Shop'] as const;
export type TickGroup = (typeof TICK_GROUPS)[number];

/** The 32 keys in catalogue order, the order of the table of DESIGN.md 6.2. A key is what the `roles.ticks` column stores, so it never changes once a role may hold it. */
export const TICK_KEYS = [
  // Stock
  'stock_add',
  'stock_edit',
  'stock_status',
  'category_add',
  'category_edit',
  'design_material',
  'secret_weight',
  // Photos
  'photo_rewrite',
  // Money
  'customer_view',
  'bill_view',
  'cashbook_recent',
  'cashbook_all',
  'customer_edit',
  'customer_archive',
  'bill_make',
  'payment_receive',
  'rate_enter',
  'rate_correct',
  'back_date',
  'bill_cancel',
  'bill_reissue',
  'payment_void',
  'refund_give',
  'opening_balance',
  'cash_over_limit',
  // Orders
  'order_view',
  'order_edit',
  'order_closed_change',
  // Records
  'reports_open',
  'activity_log',
  'download_all',
  // Shop
  'settings_change',
] as const;
export type TickKey = (typeof TICK_KEYS)[number];

export interface TickInfo {
  key: TickKey;
  group: TickGroup;
  /** The words on the screen. */
  label: string;
  /** The words shown under the tick when its label does not say enough; null for all but four. */
  help: string | null;
  /** One of the twelve that the screen shows in another colour and asks a second confirm for when it is turned on. */
  sensitive: boolean;
  /** DIRECT needs: what this tick cannot work without. Turning the tick on turns these on too (closeOverNeeds); a set that holds the tick and lacks one is refused (brokenNeeds). */
  needs: readonly TickKey[];
}

/** What the source of a tick says. The rest of a TickInfo is filled in below: no help, not sensitive, no needs. */
interface TickDef {
  group: TickGroup;
  label: string;
  sensitive?: true;
  needs?: readonly TickKey[];
  help?: string;
}

// One entry for each key, in catalogue order. The words are those of the table of DESIGN.md 6.2: plain English, no technical word. tests/api/ticks.test.ts holds them typed in again, so a change here is a change
// to what the Super Admin reads and is made on purpose. A need is listed in the order the table gives it.
const DEFS: Record<TickKey, TickDef> = {
  // Stock
  stock_add: { group: 'Stock', label: 'Add designs and photos' },
  stock_edit: { group: 'Stock', label: 'Edit design and piece details (including weights and labour rates)', help: 'Weights and labour rates are the price inputs.' },
  stock_status: { group: 'Stock', label: "Change a piece's status" },
  category_add: { group: 'Stock', label: 'Add categories and sub-categories' },
  category_edit: { group: 'Stock', label: 'Edit or switch off categories' },
  design_material: { group: 'Stock', label: "Change a design's metal, purity or selling method" },
  secret_weight: { group: 'Stock', label: 'See and enter the original (secret) weight', sensitive: true },
  // Photos
  photo_rewrite: { group: 'Photos', label: 'Remove, reorder or replace photos (designs and orders)' },
  // Money
  customer_view: { group: 'Money', label: 'See customers (name, phone, address, GST)' },
  bill_view: { group: 'Money', label: 'See bills, payments and customer ledgers' },
  cashbook_recent: { group: 'Money', label: 'See the cash book for today and yesterday' },
  cashbook_all: { group: 'Money', label: 'See the cash book for all days', needs: ['cashbook_recent'] },
  customer_edit: { group: 'Money', label: 'Add and edit customers', needs: ['customer_view'] },
  customer_archive: { group: 'Money', label: 'Archive a customer', needs: ['customer_view', 'bill_view'] }, // R16, R19: the archive refusal names the balances that are not zero, which are data of the bills and balances reads
  bill_make: {
    group: 'Money',
    label: 'Make bills and estimates',
    needs: ['customer_view', 'bill_view'], // R18: the answer of create-bill is the bill in the wire format of the bills read
    help: 'A bill that takes payment also needs "Receive payments and settle fine". Without that, the role can still save a bill that takes no payment.',
  },
  payment_receive: { group: 'Money', label: 'Receive payments and settle fine', needs: ['customer_view', 'bill_view'] },
  rate_enter: { group: 'Money', label: "Enter today's metal rates", help: 'Today\'s rate only. Any other date also needs "Use a date other than today".' },
  rate_correct: { group: 'Money', label: 'Correct a daily rate', needs: ['rate_enter'] },
  back_date: { group: 'Money', label: 'Use a date other than today (back-date)', sensitive: true },
  bill_cancel: { group: 'Money', label: 'Cancel a bill', sensitive: true, needs: ['customer_view', 'bill_view'] },
  bill_reissue: {
    group: 'Money',
    label: 'Re-issue a bill',
    sensitive: true,
    needs: ['customer_view', 'bill_view'],
    help: 'Without "Use a date other than today", only bills dated today can be re-issued (the new bill keeps the old date). Without "Receive payments and settle fine", the re-issue takes no new payment.',
  },
  payment_void: { group: 'Money', label: 'Void a payment', sensitive: true, needs: ['customer_view', 'bill_view'] },
  refund_give: { group: 'Money', label: 'Give a refund', sensitive: true, needs: ['customer_view', 'bill_view'] },
  opening_balance: { group: 'Money', label: 'Add an opening balance', sensitive: true, needs: ['customer_view', 'bill_view'] },
  cash_over_limit: { group: 'Money', label: 'Take cash over the limit (with a reason)', sensitive: true, needs: ['payment_receive'] },
  // Orders
  order_view: { group: 'Orders', label: 'See the Order Book' },
  order_edit: { group: 'Orders', label: 'Make and change orders, add order photos', needs: ['order_view', 'customer_view'] },
  order_closed_change: { group: 'Orders', label: 'Change a delivered or cancelled order', sensitive: true },
  // Records
  reports_open: { group: 'Records', label: 'Open Reports' },
  activity_log: {
    group: 'Records',
    label: 'See the Activity Log and health checks (shows every change ever made, including customers, money and the secret weight)',
    sensitive: true,
    needs: ['secret_weight', 'customer_view', 'bill_view', 'order_view'],
  },
  download_all: { group: 'Records', label: 'Download everything', sensitive: true },
  // Shop
  settings_change: { group: 'Shop', label: 'Change shop settings', sensitive: true },
};

/** All 32 ticks with their words, in catalogue order. */
export const TICKS: readonly TickInfo[] = TICK_KEYS.map((key) => {
  const { group, label, help = null, sensitive = false, needs = [] } = DEFS[key];
  return { key, group, label, help, sensitive, needs };
});

/** The three roles of today as tick sets, in catalogue order: the day-one truth (P1). Owner is every tick and is read from here, never from the database; Biller and Staff are what they could do before roles had ticks. */
export const BUILTIN_TICKS: Readonly<Record<'owner' | 'biller' | 'staff', readonly TickKey[]>> = {
  owner: [...TICK_KEYS],
  biller: ['customer_view', 'bill_view', 'cashbook_recent', 'customer_edit', 'bill_make', 'payment_receive', 'rate_enter', 'order_view', 'order_edit'],
  staff: ['stock_add', 'stock_edit', 'stock_status', 'category_add', 'order_view'],
};

/** The key of the Owner role. Its ticks are every tick whatever its row in `roles` says (R3, R4). */
export const OWNER_KEY = 'owner';

/** R2: the shape of a role key, a lower-case letter then up to eleven lower-case letters or hyphens: 12 characters at most, the width of `users.role`. A key is made once and never changes. */
export const ROLE_KEY_PATTERN = /^[a-z][a-z-]{0,11}$/;

/** The ticks that open a website screen and no row of the matrix (Open Reports): the screen is all they cover. */
export const SCREEN_ONLY: readonly TickKey[] = ['reports_open'];

const KNOWN_KEYS: ReadonlySet<string> = new Set(TICK_KEYS);

/** True for one of the 32 keys and for nothing else. A Set lookup, not `key in object` or a property read: `__proto__` and `constructor` are not ticks, and nor is anything that is not text. */
export function isTickKey(v: unknown): v is TickKey {
  return typeof v === 'string' && KNOWN_KEYS.has(v);
}

/** The keys given plus everything they need, however deep, in catalogue order and each once. Whatever is not a tick key is left out. The screen turns on what this adds, and a role made as a copy starts from it. */
export function closeOverNeeds(keys: Iterable<TickKey>): TickKey[] {
  const wanted = new Set<TickKey>();
  const todo: TickKey[] = [...keys];
  for (let key = todo.pop(); key !== undefined; key = todo.pop()) {
    // the type says TickKey, but a list that came from a column or a request has not been through the compiler
    if (!isTickKey(key) || wanted.has(key)) continue;
    wanted.add(key);
    todo.push(...(DEFS[key].needs ?? []));
  }
  return TICK_KEYS.filter((key) => wanted.has(key));
}

/** The ticks of the set that lack something they need, in catalogue order, each with the needs it lacks (its own direct needs, in the order it lists them). Empty when the set is closed. Whatever is not a tick key is ignored. */
export function brokenNeeds(keys: Iterable<TickKey>): { tick: TickKey; missing: TickKey[] }[] {
  const held = new Set<TickKey>(keys);
  const broken: { tick: TickKey; missing: TickKey[] }[] = [];
  for (const t of TICKS) {
    if (!held.has(t.key)) continue;
    const missing = t.needs.filter((need) => !held.has(need));
    if (missing.length > 0) broken.push({ tick: t.key, missing });
  }
  return broken;
}
