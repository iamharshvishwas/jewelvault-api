// A1, A4, A5, A6, P3, S10: THE PERMISSION MATRIX. One file, the only place that says who may do what. A handler never checks a role itself: the wrapper of route.ts reads the row of its
// action here, and a service function that wants to check again at its start (X0 item 2, defence in depth) calls assertMayCall() with the action, not with a role name. A row says which
// TICKS open it (src/permissions/ticks.ts), never which roles: a person's ticks come with their role (Grants, src/permissions/grants.ts), and the three roles of today are tick sets too
// (BUILTIN_TICKS), so they give the same verdicts as before (P1, tests/api/access-golden.test.ts). Role names appear under src/ only in src/permissions/ (T-D10,
// tests/api/permissions-route.test.ts).
//
// WHAT IS HERE
//   MATRIX          one row for each thing a caller can do: each read resource (GET /v1/sync/<resource>) and the named read calls of C3, each direct edit (A5), each service function
//                   X1 to X12 with its route (section 10), the Order Book of FB-E1 (its read, X13 create_order, its edit and its photo upload), the photo calls (P2, P3), the download record (B3), the four session calls (U5, U8, U11) and
//                   the twelve rows of the Super Admin's own People & Roles API under /v1/super (kind `super`, access `superAdmin`: no tick opens them, DESIGN.md 6.3 and 6.6). The row carries the address
//                   (method and path) too, so the route is registered by its action alone and the generated test (tests/matrix.generated.test.ts) knows what to call.
//   READ_COLUMNS    the field allow-list of every read resource: a read names its columns and never uses SELECT * (A4). Whoever may call the resource's read row reads the list (R7).
//   WRITE_COLUMNS   the fields of every direct edit, per tick (A5, R7): a field is allowed when a tick the person holds lists it; a field outside every list they hold is JV_FORBIDDEN, an
//                   unknown field JV_INVALID_INPUT, nothing is silently ignored.
//   HIDDEN_COLUMNS  the columns of a read table that no role reads, with the reason: tests/api/permissions-matrix.test.ts requires every column of every read table to be listed or hidden,
//                   so a column added by a migration is decided and never exposed or hidden by chance.
//   PUBLIC_ROUTES   the short list of routes that need no session (A1): /healthz, /readyz, the login and the photo read. TOKEN_DOORS: /admin/v1/* and /internal/jobs/*, each with its own token check.
//   FIELD_RIGHTS    the field-level rules of section 10 (Z1, X8, Y8), each opened by one tick, asked by name, so that a service function never holds a role or a tick itself.
//
// There is no row for users, bills, bill_items, receipts or receipt_allocations as a direct edit: nobody writes them except through the service functions (A4, A8, D11, D13, K1). A path that
// is not here answers 404 (A11).
//
// ADDING A ROW (the task that builds the route does this, and the oracles in tests/api/permissions-matrix.test.ts and tests/api/access-matrix.test.ts, typed in from the spec, change with it):
// add the row below with the ticks that open it, add its READ_COLUMNS or WRITE_COLUMNS entry, and register the route with route(app, { action, handler }). The generated test walks the new row at once.
import { type Grants, hasAnyTick, hasTick } from './grants.js';
import type { TickKey } from './ticks.js';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH';

export type RowKind = 'read' | 'edit' | 'fn' | 'photo' | 'session' | 'owner' | 'super';

// ------------------------------------------------------------------ what can be read

/** Every table or derived read a screen can read (C3, C4). The first seventeen are tables (orders is FB-E1's); the last four are the derived reads of section 11, queries of the API (db/queries), not views. */
export const READ_RESOURCES = [
  'users',
  'settings',
  'daily_rates',
  'categories',
  'subcategories',
  'designs',
  'skus',
  'sku_private',
  'customers',
  'bills',
  'bill_items',
  'receipts',
  'receipt_allocations',
  'orders',
  'audit_log',
  'check_runs',
  'backup_runs',
  'bill_summary',
  'customer_balances',
  'customer_ledger',
  'daily_totals',
] as const;
export type ReadResource = (typeof READ_RESOURCES)[number];

/**
 * The tables that no screen reads and no route returns (S1, D18, D24, D25), plus design_photos (read only by the photo calls, never listed: no list query returns bytes), roles (read by the session
 * lookup with the user row and by the Super Admin's People & Roles calls, never a sync read: R1, R6) and the runner's own table.
 */
export const INTERNAL_TABLES: readonly string[] = [
  'sessions',
  'sys_counters',
  'sys_error_log',
  'sys_idempotency',
  'sys_import_batches',
  'sys_job_runs',
  'sys_login_attempts',
  'sys_photo_copies',
  'design_photos',
  'roles',
  'schema_migrations',
];

// ------------------------------------------------------------------ the rows

export interface EditSpec {
  readonly table: string;
  readonly op: 'insert' | 'update';
  /** How a call is written: `changes` is {expected_updated_at, changes:{...}} (a PATCH with the stale check, A5); `fields` is the fields themselves. */
  readonly shape: 'changes' | 'fields';
}

/**
 * R8: who may call a row. `open`: everyone signed in. `anyOf`: a person holding any one of the ticks. `superAdmin`: the Super Admin only (the rows of kind `super`), whatever ticks they hold.
 * Anyone else who is signed in gets 403 JV_FORBIDDEN; a caller with no live session gets 401 whatever the row says.
 */
export type Access = { readonly open: true } | { readonly anyOf: readonly [TickKey, ...TickKey[]] } | { readonly superAdmin: true };

export interface MatrixRow {
  readonly kind: RowKind;
  readonly method: HttpMethod;
  /** The Fastify address, with :names for the ids. Never a table or column name taken from the client (A11). */
  readonly path: string;
  /** Who may call (Access). */
  readonly access: Access;
  /** U11: true for the calls a user who must still change the password may make. */
  readonly mustChange: boolean;
  /** Where the row comes from, for the person reading this file. */
  readonly spec: string;
  /** The READ_COLUMNS resources this call serves. */
  readonly reads?: readonly ReadResource[];
  readonly edit?: EditSpec;
}

const OPEN: Access = { open: true };
/** The ticks that open a row, any one enough. */
const any = (...anyOf: [TickKey, ...TickKey[]]): Access => ({ anyOf });

const read = (path: string, access: Access, reads: readonly ReadResource[], spec: string, method: HttpMethod = 'GET') => ({ kind: 'read', method, path, access, mustChange: false, spec, reads }) as const;
const edit = (method: HttpMethod, path: string, access: Access, e: EditSpec, spec: string) => ({ kind: 'edit', method, path, access, mustChange: false, spec, edit: e }) as const;
const fn = (path: string, access: Access, spec: string) => ({ kind: 'fn', method: 'POST', path, access, mustChange: false, spec }) as const;
const session = (method: HttpMethod, path: string, mustChange: boolean, spec: string) => ({ kind: 'session', method, path, access: OPEN, mustChange, spec }) as const;
/** A row of the Super Admin's own API (R8): `{ superAdmin: true }` is the whole access, so no tick and no role key opens it; a person who must still change the password may not call it. */
const superRow = (method: HttpMethod, path: string, spec: string) => ({ kind: 'super', method, path, access: { superAdmin: true }, mustChange: false, spec }) as const;

const ROWS = {
  // ---- reads: GET /v1/sync/<resource> (C3), kebab-case in the address, the table's name in READ_COLUMNS
  'read:users': read('/v1/sync/users', OPEN, ['users'], 'A4 users'),
  'read:settings': read('/v1/sync/settings', OPEN, ['settings'], 'A4 settings (staff: STAFF_SETTING_KEYS only)'),
  'read:daily_rates': read('/v1/sync/daily-rates', OPEN, ['daily_rates'], 'A4 daily_rates'),
  'read:categories': read('/v1/sync/categories', OPEN, ['categories'], 'A4 categories'),
  'read:subcategories': read('/v1/sync/subcategories', OPEN, ['subcategories'], 'A4 subcategories'),
  'read:designs': read('/v1/sync/designs', OPEN, ['designs'], 'A4 designs (archived rows too)'),
  'read:skus': read('/v1/sync/skus', OPEN, ['skus'], 'A4 skus (archived rows too)'),
  'read:sku_private': read('/v1/sync/sku-private', any('secret_weight'), ['sku_private'], 'A4 sku_private, D9: the only source of the owner-only weight'),
  'read:customers': read('/v1/sync/customers', any('customer_view'), ['customers'], 'A4 customers'),
  'read:bills': read('/v1/sync/bills', any('bill_view'), ['bills'], 'A4 bills (the header the Invoice shape needs, C3)'),
  'read:bill_items': read('/v1/sync/bill-items', any('bill_view'), ['bill_items'], 'A4 bill_items'),
  'read:receipts': read('/v1/sync/receipts', any('bill_view'), ['receipts'], 'A4 receipts'),
  'read:receipt_allocations': read('/v1/sync/receipt-allocations', any('bill_view'), ['receipt_allocations'], 'A4 receipt_allocations'),
  'read:bill_summary': read('/v1/sync/bill-summary', any('bill_view'), ['bill_summary'], 'A4 derived read V1'),
  'read:customer_balances': read('/v1/sync/customer-balances', any('bill_view'), ['customer_balances'], 'A4 derived read V2'),
  'read:orders': read('/v1/sync/orders', any('order_view'), ['orders'], 'FB-E1, FB-D8: the Order Book; staff read it too'),
  // ---- the named read calls of C3
  'read:customer_ledger': read('/v1/customers/:id/ledger', any('bill_view'), ['customer_ledger'], 'C3, V3 for one customer'),
  'read:daily_totals': read('/v1/daily-totals', any('cashbook_recent', 'cashbook_all'), ['daily_totals'], 'C3, V4; a biller reads today and yesterday only (A4, O25: BILLER_DAILY_TOTALS_DAYS)'),
  'read:audit_log': read('/v1/audit-log', any('activity_log'), ['audit_log'], 'A4 audit_log, C3'),
  'read:health_checks': read('/v1/health/checks', any('activity_log'), ['check_runs', 'backup_runs'], 'A4 check_runs and backup_runs, C3'),
  'read:dashboard_health': read('/v1/dashboard/health', any('activity_log'), [], 'C3, section 12: the dashboard line, computed, no table'),
  // the combined poll (C4): open to everyone signed in; the handler asks mayCall(grants, 'read:<resource>') for each resource named and refuses the whole call if one is not allowed
  'read:poll': read('/v1/sync/poll', OPEN, [], 'C4: the call is 403 JV_FORBIDDEN as a whole when one named resource is not the role\'s', 'POST'),

  // ---- direct edits (A5), PATCH with the stale check, or PUT/POST of ordinary fields
  'edit:settings.update': edit('PUT', '/v1/settings/:key', any('settings_change'), { table: 'settings', op: 'update', shape: 'fields' }, 'A4 settings: S, I, U for the owner; never last_download or last_pulled (NEVER_WRITTEN_SETTINGS)'),
  'edit:daily_rates.insert': edit('POST', '/v1/daily-rates', any('rate_enter'), { table: 'daily_rates', op: 'insert', shape: 'fields' }, 'A4 daily_rates: owner any date up to today, biller today only (D4, Y8)'),
  'edit:daily_rates.update': edit('PATCH', '/v1/daily-rates/:id', any('rate_correct'), { table: 'daily_rates', op: 'update', shape: 'changes' }, 'A4 daily_rates: the owner corrects a row dated today'),
  'edit:categories.insert': edit('POST', '/v1/categories', any('category_add'), { table: 'categories', op: 'insert', shape: 'fields' }, 'A4 categories'),
  'edit:categories.update': edit('PATCH', '/v1/categories/:id', any('category_edit'), { table: 'categories', op: 'update', shape: 'changes' }, 'A4 categories'),
  'edit:subcategories.insert': edit('POST', '/v1/subcategories', any('category_add'), { table: 'subcategories', op: 'insert', shape: 'fields' }, 'A4 subcategories'),
  'edit:subcategories.update': edit('PATCH', '/v1/subcategories/:id', any('category_edit'), { table: 'subcategories', op: 'update', shape: 'changes' }, 'A4 subcategories'),
  'edit:designs.update': edit('PATCH', '/v1/designs/:id', any('stock_edit', 'design_material'), { table: 'designs', op: 'update', shape: 'changes' }, 'A4, A5 designs: content columns and archived_at; only the owner changes material, purity, selling_method'),
  'edit:skus.update': edit('PATCH', '/v1/skus/:id', any('stock_edit'), { table: 'skus', op: 'update', shape: 'changes' }, 'A4, A5 skus: content columns; status and archived_at only through X9'),
  'edit:sku_private.update': edit('PUT', '/v1/sku-private/:sku_id', any('secret_weight'), { table: 'sku_private', op: 'update', shape: 'fields' }, 'A4 sku_private: S, I, U for the owner'),
  'edit:customers.update': edit('PATCH', '/v1/customers/:id', any('customer_edit', 'customer_archive'), { table: 'customers', op: 'update', shape: 'changes' }, 'A4, A5 customers: content columns; archived_at only for the owner'),
  'edit:orders.update': edit('PATCH', '/v1/orders/:id', any('order_edit'), { table: 'orders', op: 'update', shape: 'changes' }, 'FB-E1, FB-D8: description, delivery_date, status, notes, photo_ids; the status of a delivered or cancelled order is the owner\'s (FIELD_RIGHTS)'),

  // ---- service functions X1 to X12 (section 10)
  'fn:create_bill': fn('/v1/bills', any('bill_make'), 'X1'),
  'fn:record_payment': fn('/v1/customers/:id/payments', any('payment_receive'), 'X2'),
  'fn:settle_fine': fn('/v1/customers/:id/fine-settlements', any('payment_receive'), 'X3'),
  'fn:void_receipt': fn('/v1/receipts/:id/void', any('payment_void'), 'X4'),
  'fn:cancel_bill': fn('/v1/bills/:id/cancel', any('bill_cancel'), 'X5'),
  'fn:create_customer': fn('/v1/customers', any('customer_edit'), 'X6'),
  'fn:quote_bill': fn('/v1/bills/quote', any('bill_make'), 'X7: read-only, writes nothing'),
  'fn:create_design': fn('/v1/designs', any('stock_add'), 'X8: staff sending original_net_weight is JV_FORBIDDEN (FIELD_RIGHTS)'),
  'fn:set_sku_status': fn('/v1/skus/status', any('stock_status'), 'X9'),
  'fn:reissue_bill': fn('/v1/bills/:id/reissue', any('bill_reissue'), 'X10'),
  'fn:issue_refund': fn('/v1/customers/:id/refunds', any('refund_give'), 'X11'),
  'fn:add_opening_balance': fn('/v1/customers/:id/opening-balance', any('opening_balance'), 'X12'),
  'fn:create_order': fn('/v1/orders', any('order_edit'), 'X13 (FB-E1, FB-D8): create_order; the spec\'s own X13 was retired in draft 4, so the number is free'),

  // ---- photos (P2, P3); the photo READ is on the public list
  'photo:upload': { kind: 'photo', method: 'PUT', path: '/v1/designs/:design_id/photos/:photo_id', access: any('stock_add'), mustChange: false, spec: 'P2, P3: the owner and staff add a new photo' },
  'photo:upload_order': { kind: 'photo', method: 'PUT', path: '/v1/orders/:order_id/photos/:photo_id', access: any('order_edit'), mustChange: false, spec: 'FB-E1, P2, P3: the owner and a biller add a photo to an order (the same PhotoStore and caps, 3 an order)' },
  'photo:remove': { kind: 'photo', method: 'POST', path: '/v1/photos/:photo_id/remove', access: any('photo_rewrite'), mustChange: false, spec: 'P3: only the owner removes one (a POST, nothing is deleted, S7)' },

  // ---- the owner's download record (B3)
  'owner:download_record': { kind: 'owner', method: 'POST', path: '/v1/owner/download-record', access: any('download_all'), mustChange: false, spec: 'A4, B3: the owner\'s monthly download, one record for each call' },

  // ---- the session calls: open to every signed-in user (A4). U11 lets a user who must still change the password call change-password, logout and me and nothing else
  'session:me': session('GET', '/v1/auth/me', true, 'U5, U11'),
  'session:logout': session('POST', '/v1/auth/logout', true, 'U8, U11'),
  'session:change-password': session('POST', '/v1/auth/change-password', true, 'U11'),
  'session:activity': session('POST', '/v1/auth/activity', false, 'U4; U11 keeps it out for a user who must still change the password'),

  // ---- the Super Admin's own API, People & Roles (access plan Task 12, DESIGN.md 6.3). Only isSuperAdmin passes (R8): the Owner does not, and no tick opens a row of it (6.6 guardrail 5). A caller with no session
  //      gets 401 and everyone else 403 JV_FORBIDDEN (P5, tests/api/super-escalation.test.ts). The three reads have their routes (src/super/routes.ts); the nine writes get theirs in Tasks 13 (roles) and 14 (people).
  'super:ticks': superRow('GET', '/v1/super/ticks', 'DESIGN 6.3: the catalogue of the 32 ticks (groups, words, help, sensitive, needs) the roles screen draws'),
  'super:people.list': superRow('GET', '/v1/super/people', 'DESIGN 6.3: every login with its role name and the Super Admin flag, never a hash'),
  'super:people.add': superRow('POST', '/v1/super/people', 'DESIGN 6.3 (Task 14): add a person with a role and a temporary password'),
  'super:people.edit': superRow('PATCH', '/v1/super/people/:id', 'DESIGN 6.3 (Task 14): edit a person\'s name or e-mail'),
  'super:people.role': superRow('POST', '/v1/super/people/:id/role', 'DESIGN 6.3 (Task 14): change a person\'s role'),
  'super:people.active': superRow('POST', '/v1/super/people/:id/active', 'DESIGN 6.3 (Task 14): switch a person off or on'),
  'super:people.reset': superRow('POST', '/v1/super/people/:id/reset-password', 'DESIGN 6.3 (Task 14): reset a person\'s password to a new temporary one'),
  'super:roles.list': superRow('GET', '/v1/super/roles', 'DESIGN 6.3: every role with its ticks and how many active people hold it'),
  'super:roles.create': superRow('POST', '/v1/super/roles', 'DESIGN 6.3 (Task 13): create a role as a copy of another'),
  'super:roles.edit': superRow('PATCH', '/v1/super/roles/:key', 'DESIGN 6.3 (Task 13): edit a role\'s name or description'),
  'super:roles.ticks': superRow('PUT', '/v1/super/roles/:key/ticks', 'DESIGN 6.3 (Task 13): set a role\'s ticks'),
  'super:roles.active': superRow('POST', '/v1/super/roles/:key/active', 'DESIGN 6.3 (Task 13): switch a role off or on'),
} as const satisfies Record<string, MatrixRow>;

/** The name of a row. A route is registered by it (route.ts) and a service function checks it again at its start (assertMayCall). */
export type Action = keyof typeof ROWS;

export const MATRIX: Readonly<Record<Action, MatrixRow>> = ROWS;

/** The rows that are direct edits. */
export type EditAction = { [K in Action]: (typeof ROWS)[K] extends { edit: EditSpec } ? K : never }[Action];

// ------------------------------------------------------------------ the public routes and the token doors (A1)

export type PublicName = 'health' | 'ready' | 'login' | 'photo-full' | 'photo-thumb';

export interface PublicRoute {
  readonly method: HttpMethod;
  readonly path: string;
}

/** No session is looked up for these (A1). The login is public because it is how a session starts; the photo read is public because the website's <img> carries no cookie (P3, O11). */
export const PUBLIC_ROUTES: Readonly<Record<PublicName, PublicRoute>> = {
  health: { method: 'GET', path: '/healthz' },
  ready: { method: 'GET', path: '/readyz' },
  login: { method: 'POST', path: '/v1/auth/login' },
  'photo-full': { method: 'GET', path: '/v1/photos/:photo_id/full' },
  'photo-thumb': { method: 'GET', path: '/v1/photos/:photo_id/thumb' },
};

export type TokenDoorName = 'admin' | 'job';

export interface TokenDoor {
  /** Every route of the door lives under this address. */
  readonly prefix: string;
  readonly why: string;
}

/** Routes with their own token check instead of a session: the admin door (U3) and the job tick (I8, B2). route() requires the check (`verify`) of each. */
export const TOKEN_DOORS: Readonly<Record<TokenDoorName, TokenDoor>> = {
  admin: { prefix: '/admin/v1/', why: 'the admin door of U3: a bearer token compared with JV_ADMIN_TOKEN_HASH' },
  job: { prefix: '/internal/jobs/', why: 'the job tick and the jobs health route (I8, 7.3): a job token' },
};

/** Routes a plugin registers for itself that cannot go through route() (a CORS preflight, say). Exact method and address, with the reason. Nothing else is exempt. */
export const FRAMEWORK_ROUTES: readonly { readonly method: string; readonly url: string; readonly why: string }[] = [
  { method: 'OPTIONS', url: '*', why: '@fastify/cors (API07, A12) answers a preflight in its own hook, ahead of every other hook, and needs this route only so that Fastify accepts the OPTIONS request; it reads no session and answers nothing else' },
];

// ------------------------------------------------------------------ the rules of a row that are not columns

/** A4: everyone signed in reads these seven keys of settings (the keys staff read before roles had ticks); reading every key needs bill_view, bill_make or settings_change. */
export const STAFF_SETTING_KEYS: readonly string[] = ['numbering', 'materials', 'locations', 'custom_fields', 'tag_template', 'photos', 'data_epoch'];

/** A4, B3, O54: the generic edit never writes these two settings (the download record and the pull record have their own calls). */
export const NEVER_WRITTEN_SETTINGS: readonly string[] = ['last_download', 'last_pulled'];

/** A4, O25: cashbook_recent reads daily_totals for today and yesterday only (cashbook_all reads the wide range). */
export const BILLER_DAILY_TOTALS_DAYS = 2;

/**
 * Section 10 and A5: the field rules that belong to the matrix, each opened by one tick. cash_override_reason (Z1), original_net_weight (X8), a business date other than today (Y8), removing,
 * reordering or replacing the photo ids of a design or an order (A5, P3: the others may only add ids at the end), and changing the status of an order that is delivered or cancelled (FB-D8).
 */
export const FIELD_RIGHTS = {
  cash_override_reason: 'cash_over_limit',
  original_net_weight: 'secret_weight',
  back_dates: 'back_date',
  rewrite_photo_ids: 'photo_rewrite',
  change_closed_order: 'order_closed_change',
} as const satisfies Record<string, TickKey>;
export type FieldRight = keyof typeof FIELD_RIGHTS;

/**
 * I11, O26, R8: whose daily rates the nightly review line checks for a move of more than `rate_flag_percent`: the rates entered by a person whose role holds `holds` and not `lacks` (enters
 * today's rate, cannot correct one). The review (src/domain/review.ts) asks here and never names a tick or a role itself (S10, T-D10).
 */
export const RATE_REVIEW = { holds: 'rate_enter', lacks: 'rate_correct' } as const satisfies { holds: TickKey; lacks: TickKey };

/** The ticks that read every key of settings; without one a person reads STAFF_SETTING_KEYS only (A4, DESIGN.md 6.2). */
const ALL_SETTINGS_TICKS: readonly TickKey[] = ['bill_view', 'bill_make', 'settings_change'];

// ------------------------------------------------------------------ asking the matrix

/** Whether grants pass a row's access (R8). The Super Admin rows ask the flag alone, never a tick: all 32 ticks without the flag do not pass. */
export function accessAllows(access: Access, g: Grants): boolean {
  if ('open' in access) return access.open === true;
  if ('superAdmin' in access) return access.superAdmin === true && g.isSuperAdmin;
  return hasAnyTick(g, access.anyOf);
}

/** The access of a row as the route list prints it: `open`, `super` or the ticks, any one enough (T-D01). */
export function describeAccess(access: Access): string {
  return 'open' in access ? 'open' : 'superAdmin' in access ? 'super' : `any(${access.anyOf.join(',')})`;
}

/** Whether a person may call an action. An action that is not a row can be done by nobody. */
export function mayCall(grants: Grants, action: Action): boolean {
  const row = Object.hasOwn(MATRIX, action) ? MATRIX[action] : undefined;
  return row !== undefined && accessAllows(row.access, grants);
}

/** Whether a person may use a field right of section 10: they hold its tick. */
export function mayUseField(grants: Grants, field: FieldRight): boolean {
  return Object.hasOwn(FIELD_RIGHTS, field) && hasTick(grants, FIELD_RIGHTS[field]);
}

/** A4, C3: the keys of `settings` a person reads. null means every key (a holder of bill_view, bill_make or settings_change); everyone else reads the seven of STAFF_SETTING_KEYS. */
export function readableSettingKeys(grants: Grants): readonly string[] | null {
  return hasAnyTick(grants, ALL_SETTINGS_TICKS) ? null : STAFF_SETTING_KEYS;
}

/**
 * A4, A9, O25: how many days of the cash book (daily_totals) a person reads, counted back from today with today included. null means the wide range (cashbook_all, up to
 * limits.dailyTotalsMaxDays); cashbook_recent reads BILLER_DAILY_TOTALS_DAYS (today and yesterday); neither reads none.
 */
export function dailyTotalsWindowDays(grants: Grants): number | null {
  if (hasTick(grants, 'cashbook_all')) return null;
  return hasTick(grants, 'cashbook_recent') ? BILLER_DAILY_TOTALS_DAYS : 0;
}

// ------------------------------------------------------------------ READ_COLUMNS

// A4 gives the content of a users row as id, full_name, role and active. C3 orders every sync resource by (updated_at, key) and C4 takes the cursor from the data and merges by the greater updated_at,
// so the row carries its stamp too (API11 checked this against C3 and C4); the e-mail, the hash and the other stamps stay hidden.
const USERS = ['id', 'full_name', 'role', 'active', 'updated_at'] as const;
const STAMPS = ['created_at', 'updated_at', 'created_by', 'updated_by'] as const;

const SETTINGS = ['setting_key', 'value', ...STAMPS] as const;
const DAILY_RATES = ['id', 'material', 'purity', 'rate_per_gram', 'rate_date', 'confirmed_by', ...STAMPS] as const;
const CATEGORIES = ['id', 'name', 'prefix', 'active', ...STAMPS] as const;
const SUBCATEGORIES = ['id', 'category_id', 'name', 'active', ...STAMPS] as const;
const DESIGNS = ['id', 'design_no', 'name', 'category_id', 'subcategory_id', 'material', 'purity', 'selling_method', 'description', 'notes', 'tags', 'primary_photo_id', 'photo_ids', 'archived_at', ...STAMPS] as const;
const SKUS = ['id', 'design_id', 'sku_no', 'barcode', 'gross_weight', 'customer_net_weight', 'stones', 'stone_weight', 'kundan', 'kundan_weight', 'piroi', 'labour_retail', 'labour_semi', 'labour_wholesale', 'status', 'location', 'notes', 'sold_bill_id', 'archived_at', ...STAMPS] as const;
const CUSTOMERS = ['id', 'name', 'mobile', 'customer_type', 'email', 'address', 'gst_number', 'pan', 'notes', 'is_walkin', 'archived_at', ...STAMPS] as const;
const BILLS = ['id', 'bill_no', 'customer_id', 'bill_date', 'doc_type', 'sale_type', 'status', 'cancel_reason', 'cancelled_at', 'cancelled_on', 'cancelled_by', 'reissue_of', 'pricing_version', 'subtotal', 'discount', 'additional_charges', 'gst_percent', 'gst_amount', 'grand_total', 'round_off', 'fine_weight_due', 'notes', 'cash_override_reason', ...STAMPS] as const;
const BILL_ITEMS = ['id', 'bill_id', 'line_no', 'sku_id', 'design_no', 'sku_no', 'category', 'material', 'purity', 'selling_method', 'gross_weight', 'customer_net_weight', 'quantity', 'metal_rate', 'labour_rate', 'labour_amount', 'piroi', 'other_charges', 'metal_amount', 'fine_weight_due', 'item_total', 'tax_rate', 'tax_amount', 'list_metal_rate', 'list_labour_rate', 'created_at', 'updated_at'] as const;
const RECEIPTS = ['id', 'customer_id', 'kind', 'mode', 'amount', 'fine_grams', 'silver_rate', 'paid_on', 'reference', 'notes', 'is_opening', 'cash_override_reason', 'status', 'void_reason', 'voided_at', 'voided_on', 'voided_by', ...STAMPS] as const;
const RECEIPT_ALLOCATIONS = ['id', 'receipt_id', 'bill_id', 'customer_id', 'amount', 'fine_grams', 'released_at', 'created_at', 'updated_at'] as const;
const BILL_SUMMARY = ['id', 'bill_no', 'customer_id', 'bill_date', 'doc_type', 'sale_type', 'status', 'reissue_of', 'grand_total', 'received', 'pending', 'fine_due', 'fine_settled', 'fine_pending', 'payment_status', 'item_count', 'created_at', 'updated_at'] as const;
const CUSTOMER_BALANCES = ['id', 'billed', 'total_purchases', 'received', 'refunded', 'allocated', 'outstanding', 'advance', 'balance', 'fine_billed', 'fine_received', 'fine_allocated', 'fine_outstanding', 'fine_advance', 'fine_balance', 'last_purchase', 'updated_at'] as const;
const CUSTOMER_LEDGER = ['customer_id', 'entry_date', 'entry_at', 'kind_rank', 'id', 'kind', 'description', 'debit', 'credit', 'fine_debit', 'fine_credit', 'balance', 'fine_balance'] as const;
const DAILY_TOTALS = ['business_date', 'mode', 'money_in', 'money_out', 'net'] as const;
const ORDERS = ['id', 'order_no', 'customer_id', 'description', 'delivery_date', 'status', 'photo_ids', 'notes', ...STAMPS] as const;

/**
 * The columns of each read resource (A4, R7). Whoever may call the read row that serves a resource reads this list, and nobody else reads anything of it (readColumnsFor). The list is one for
 * everyone, because A9 narrows nothing by column except where A4 says so (the hash of users, the secret weight, which lives in sku_private and nowhere else).
 */
export const READ_COLUMNS: Readonly<Record<ReadResource, readonly string[]>> = {
  users: USERS,
  settings: SETTINGS,
  daily_rates: DAILY_RATES,
  categories: CATEGORIES,
  subcategories: SUBCATEGORIES,
  designs: DESIGNS,
  skus: SKUS,
  sku_private: ['sku_id', 'original_net_weight', ...STAMPS],
  customers: CUSTOMERS,
  bills: BILLS,
  bill_items: BILL_ITEMS,
  receipts: RECEIPTS,
  receipt_allocations: RECEIPT_ALLOCATIONS,
  orders: ORDERS,
  audit_log: ['id', 'at', 'actor', 'actor_role', 'request_id', 'table_name', 'row_id', 'action', 'old_row', 'new_row'],
  check_runs: ['id', 'ran_at', 'ok', 'details'],
  backup_runs: ['id', 'ran_at', 'kind', 'ok', 'bytes', 'detail'],
  bill_summary: BILL_SUMMARY,
  customer_balances: CUSTOMER_BALANCES,
  customer_ledger: CUSTOMER_LEDGER,
  daily_totals: DAILY_TOTALS,
};

/** The read row that serves each resource: the one row of kind `read` whose `reads` names it. */
const READ_ROW_OF = new Map<string, Action>(
  (Object.keys(ROWS) as Action[]).flatMap((action) => {
    const row: MatrixRow = ROWS[action];
    return row.kind === 'read' ? (row.reads ?? []).map((resource): [string, Action] => [resource, action]) : [];
  }),
);

/** The columns a person reads of a resource, or null when they may not call the read row that serves it (A4, R7). A name that is not a resource is read by nobody. */
export function readColumnsFor(grants: Grants, resource: string): readonly string[] | null {
  const action = READ_ROW_OF.get(resource);
  return action !== undefined && Object.hasOwn(READ_COLUMNS, resource) && mayCall(grants, action) ? READ_COLUMNS[resource as ReadResource] : null;
}

/**
 * Columns of a read table that NO role reads, and why. Every other column of the table is listed in READ_COLUMNS: the test adds the two up and fails on a column in neither (a migration that
 * adds a column must decide) or in both.
 */
export const HIDDEN_COLUMNS = {
  users: {
    email: 'the login name: A4 gives users as id, full_name, role and active only',
    password_hash: 'the hash is never read by any route, not even the owner\'s (A4, D1, T-D16)',
    must_change_password: 'only the session calls tell a user about their own flag (U11)',
    is_super_admin: 'only the session calls tell a person about their own flag (R6), and the People & Roles list tells the Super Admin (DESIGN.md 6.3)',
    last_login_at: 'not a screen field in M1; A4 gives users as id, full_name, role and active only',
    created_at: 'A4 gives users as id, full_name, role and active only',
    created_by: 'A4 gives users as id, full_name, role and active only',
    updated_by: 'A4 gives users as id, full_name, role and active only',
  },
  customers: {
    walkin_key: 'the helper column of the unique key of the one walk-in customer (D5); is_walkin tells the screens',
    import_batch_id: 'bookkeeping of the import (IM1); no screen reads it',
  },
  designs: { import_batch_id: 'bookkeeping of the import (IM1); no screen reads it' },
  skus: { import_batch_id: 'bookkeeping of the import (IM1); no screen reads it' },
  bills: {
    request_id: 'the Idempotency-Key of the call that made the bill (L5); no screen reads it',
    import_batch_id: 'bookkeeping of the import (IM1); no screen reads it',
  },
} as const satisfies Partial<Record<ReadResource, Record<string, string>>>;

// ------------------------------------------------------------------ WRITE_COLUMNS

const DESIGN_CONTENT = ['name', 'description', 'notes', 'tags', 'primary_photo_id', 'photo_ids', 'category_id', 'subcategory_id', 'archived_at'] as const;
const SKU_CONTENT = ['gross_weight', 'customer_net_weight', 'stones', 'stone_weight', 'kundan', 'kundan_weight', 'piroi', 'labour_retail', 'labour_semi', 'labour_wholesale', 'location', 'notes'] as const;
const CUSTOMER_CONTENT = ['name', 'mobile', 'customer_type', 'email', 'address', 'gst_number', 'pan', 'notes'] as const;
const ORDER_CONTENT = ['description', 'delivery_date', 'status', 'notes', 'photo_ids'] as const;

/**
 * The fields each tick lets a person send on each direct edit (A5, R7): a field is allowed when a tick the person holds lists it. A field outside every list they hold is refused with JV_FORBIDDEN,
 * an unknown field with JV_INVALID_INPUT, and nothing is silently ignored. A row's lists are under the ticks of its access. What is not a column list but a rule of the call (only photo_rewrite
 * removes or reorders photo ids; only back_date writes a rate for another day; archiving needs a zero balance) is the handler's, and is tested there. Never a stamp, a person column or a state
 * that only a function changes (S6, A5).
 */
export const WRITE_COLUMNS: Readonly<Record<EditAction, Partial<Record<TickKey, readonly string[]>>>> = {
  'edit:settings.update': { settings_change: ['value'] },
  'edit:daily_rates.insert': { rate_enter: ['material', 'purity', 'rate_per_gram', 'rate_date'] },
  'edit:daily_rates.update': { rate_correct: ['rate_per_gram'] },
  'edit:categories.insert': { category_add: ['name', 'prefix'] },
  'edit:categories.update': { category_edit: ['name', 'active'] },
  'edit:subcategories.insert': { category_add: ['category_id', 'name'] },
  'edit:subcategories.update': { category_edit: ['name', 'active'] },
  'edit:designs.update': { stock_edit: DESIGN_CONTENT, design_material: ['material', 'purity', 'selling_method'] },
  'edit:skus.update': { stock_edit: SKU_CONTENT },
  'edit:sku_private.update': { secret_weight: ['original_net_weight'] },
  'edit:customers.update': { customer_edit: CUSTOMER_CONTENT, customer_archive: ['archived_at'] },
  'edit:orders.update': { order_edit: ORDER_CONTENT },
};

/** The fields a person may send on an edit: every list of a tick they hold, each field once, in the order the lists give them. An insert requires all of them (src/edit/engine.ts). */
export function writeColumnsFor(action: EditAction, grants: Grants): readonly string[] {
  const lists = WRITE_COLUMNS[action];
  return [...new Set((Object.keys(lists) as TickKey[]).filter((t) => hasTick(grants, t)).flatMap((t) => lists[t] ?? []))];
}

// ------------------------------------------------------------------ what an edit does with a field it is sent

/** S6, D22: the stamps and the person columns. The API makes them; no request may name one, so one that arrives is an unknown field (A5), not a forbidden one. */
const STAMP_AND_PERSON_COLUMNS: readonly string[] = ['created_at', 'updated_at', 'created_by', 'updated_by', 'set_by', 'confirmed_by', 'voided_by', 'cancelled_by'];

/** Every column the matrix knows of a table, each once: the ones that are read and the ones nobody reads (HIDDEN_COLUMNS). The test of the matrix requires these two to add up to the table. */
export function columnsOfTable(table: string): readonly string[] {
  const read = Object.hasOwn(READ_COLUMNS, table) ? READ_COLUMNS[table as ReadResource] : [];
  const hidden = Object.hasOwn(HIDDEN_COLUMNS, table) ? Object.keys(HIDDEN_COLUMNS[table as keyof typeof HIDDEN_COLUMNS]) : [];
  return [...new Set([...read, ...hidden])];
}

export type FieldVerdict = 'allowed' | 'forbidden' | 'unknown';

/**
 * A5: what an edit does with one field of its body.
 *   allowed    the field is on the list of a tick the caller holds (WRITE_COLUMNS)
 *   forbidden  the field is a column of the table (or on the list of a tick the caller lacks) that is on none of the caller's lists: JV_FORBIDDEN. Nothing is silently ignored: the whole call is
 *              refused. This is how `skus.status` and `skus.archived_at` (only X9 changes them), `design_no`, `id` and `material`, `purity` and `selling_method` without design_material are refused.
 *   unknown    a name that is no column, and the stamps and person columns that no request may name (S6, D22): JV_INVALID_INPUT.
 * Grants with no tick of the row are allowed nothing. Only own keys count: `constructor` and `__proto__` are unknown names.
 */
export function writeFieldVerdict(action: EditAction, grants: Grants, field: string): FieldVerdict {
  if (writeColumnsFor(action, grants).includes(field)) return 'allowed';
  if (STAMP_AND_PERSON_COLUMNS.includes(field)) return 'unknown';
  const edit = MATRIX[action].edit;
  if (!edit) return 'unknown';
  const onSomeList = Object.values(WRITE_COLUMNS[action]).some((list) => (list ?? []).includes(field));
  return onSomeList || columnsOfTable(edit.table).includes(field) ? 'forbidden' : 'unknown';
}
