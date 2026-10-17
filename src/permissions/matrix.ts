// A1, A4, A5, A6, P3, S10: THE PERMISSION MATRIX. One file, the only place that says who may do what. A handler never checks a role itself: the wrapper of route.ts reads the row of its
// action here, and a service function that wants to check again at its start (X0 item 2, defence in depth) calls assertMayCall() with the action, not with a role name. This is also
// the only source file that holds the role names: tests/api/permissions-route.test.ts (T-D10) fails when a role string appears anywhere else under src/.
//
// WHAT IS HERE
//   MATRIX          one row for each thing a caller can do: each read resource (GET /v1/sync/<resource>) and the named read calls of C3, each direct edit (A5), each service function
//                   X1 to X12 with its route (section 10), the photo calls (P2, P3), the download record (B3) and the four session calls (U5, U8, U11). The row carries the address
//                   (method and path) too, so the route is registered by its action alone and the generated test (tests/matrix.generated.test.ts) knows what to call.
//   READ_COLUMNS    the field allow-list per role for every read resource: a read names its columns and never uses SELECT * (A4).
//   WRITE_COLUMNS   the same for every direct edit (A5): a field outside the list is JV_FORBIDDEN, an unknown field JV_INVALID_INPUT, nothing is silently ignored.
//   HIDDEN_COLUMNS  the columns of a read table that no role reads, with the reason: tests/api/permissions-matrix.test.ts requires every column of every read table to be listed or hidden,
//                   so a column added by a migration is decided and never exposed or hidden by chance.
//   PUBLIC_ROUTES   the short list of routes that need no session (A1): /healthz, /readyz, the login and the photo read. TOKEN_DOORS: /admin/v1/* and /internal/jobs/*, each with its own token check.
//   FIELD_RIGHTS    the field-level rules of section 10 that are owner-only (Z1, X8, Y8), asked by name, so that a service function never holds a role string.
//
// There is no row for users, bills, bill_items, receipts or receipt_allocations as a direct edit: nobody writes them except through the service functions (A4, A8, D11, D13, K1). A path that
// is not here answers 404 (A11).
//
// ADDING A ROW (the task that builds the route does this, and the oracle in tests/api/permissions-matrix.test.ts, typed in from the spec, changes with it): add the row below, add its
// READ_COLUMNS or WRITE_COLUMNS entry, and register the route with route(app, { action, handler }). The generated test walks the new row at once.

export const ROLES = ['owner', 'biller', 'staff'] as const;
export type Role = (typeof ROLES)[number];

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH';

export type RowKind = 'read' | 'edit' | 'fn' | 'photo' | 'session' | 'owner';

// ------------------------------------------------------------------ what can be read

/** Every table or derived read a screen can read (C3, C4). The first sixteen are tables; the last four are the derived reads of section 11, queries of the API (db/queries), not views. */
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
  'audit_log',
  'check_runs',
  'backup_runs',
  'bill_summary',
  'customer_balances',
  'customer_ledger',
  'daily_totals',
] as const;
export type ReadResource = (typeof READ_RESOURCES)[number];

/** The tables that no screen reads and no route returns (S1, D18, D24, D25), plus design_photos (read only by the photo calls, never listed: no list query returns bytes) and the runner's own table. */
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
  'schema_migrations',
];

// ------------------------------------------------------------------ the rows

export interface EditSpec {
  readonly table: string;
  readonly op: 'insert' | 'update';
  /** How a call is written: `changes` is {expected_updated_at, changes:{...}} (a PATCH with the stale check, A5); `fields` is the fields themselves. */
  readonly shape: 'changes' | 'fields';
}

export interface MatrixRow {
  readonly kind: RowKind;
  readonly method: HttpMethod;
  /** The Fastify address, with :names for the ids. Never a table or column name taken from the client (A11). */
  readonly path: string;
  /** Who may call. Anyone else who is signed in gets 403 JV_FORBIDDEN; a caller with no live session gets 401 whatever the row says. */
  readonly roles: readonly Role[];
  /** U11: true for the calls a user who must still change the password may make. */
  readonly mustChange: boolean;
  /** Where the row comes from, for the person reading this file. */
  readonly spec: string;
  /** The READ_COLUMNS resources this call serves. */
  readonly reads?: readonly ReadResource[];
  readonly edit?: EditSpec;
}

const O = ['owner'] as const;
const OB = ['owner', 'biller'] as const;
const OS = ['owner', 'staff'] as const;
const OBS = ['owner', 'biller', 'staff'] as const;

const read = (path: string, roles: readonly Role[], reads: readonly ReadResource[], spec: string, method: HttpMethod = 'GET') => ({ kind: 'read', method, path, roles, mustChange: false, spec, reads }) as const;
const edit = (method: HttpMethod, path: string, roles: readonly Role[], e: EditSpec, spec: string) => ({ kind: 'edit', method, path, roles, mustChange: false, spec, edit: e }) as const;
const fn = (path: string, roles: readonly Role[], spec: string) => ({ kind: 'fn', method: 'POST', path, roles, mustChange: false, spec }) as const;
const session = (method: HttpMethod, path: string, mustChange: boolean, spec: string) => ({ kind: 'session', method, path, roles: OBS, mustChange, spec }) as const;

const ROWS = {
  // ---- reads: GET /v1/sync/<resource> (C3), kebab-case in the address, the table's name in READ_COLUMNS
  'read:users': read('/v1/sync/users', OBS, ['users'], 'A4 users'),
  'read:settings': read('/v1/sync/settings', OBS, ['settings'], 'A4 settings (staff: STAFF_SETTING_KEYS only)'),
  'read:daily_rates': read('/v1/sync/daily-rates', OBS, ['daily_rates'], 'A4 daily_rates'),
  'read:categories': read('/v1/sync/categories', OBS, ['categories'], 'A4 categories'),
  'read:subcategories': read('/v1/sync/subcategories', OBS, ['subcategories'], 'A4 subcategories'),
  'read:designs': read('/v1/sync/designs', OBS, ['designs'], 'A4 designs (archived rows too)'),
  'read:skus': read('/v1/sync/skus', OBS, ['skus'], 'A4 skus (archived rows too)'),
  'read:sku_private': read('/v1/sync/sku-private', O, ['sku_private'], 'A4 sku_private, D9: the only source of the owner-only weight'),
  'read:customers': read('/v1/sync/customers', OB, ['customers'], 'A4 customers'),
  'read:bills': read('/v1/sync/bills', OB, ['bills'], 'A4 bills (the header the Invoice shape needs, C3)'),
  'read:bill_items': read('/v1/sync/bill-items', OB, ['bill_items'], 'A4 bill_items'),
  'read:receipts': read('/v1/sync/receipts', OB, ['receipts'], 'A4 receipts'),
  'read:receipt_allocations': read('/v1/sync/receipt-allocations', OB, ['receipt_allocations'], 'A4 receipt_allocations'),
  'read:bill_summary': read('/v1/sync/bill-summary', OB, ['bill_summary'], 'A4 derived read V1'),
  'read:customer_balances': read('/v1/sync/customer-balances', OB, ['customer_balances'], 'A4 derived read V2'),
  // ---- the named read calls of C3
  'read:customer_ledger': read('/v1/customers/:id/ledger', OB, ['customer_ledger'], 'C3, V3 for one customer'),
  'read:daily_totals': read('/v1/daily-totals', OB, ['daily_totals'], 'C3, V4; a biller reads today and yesterday only (A4, O25: BILLER_DAILY_TOTALS_DAYS)'),
  'read:audit_log': read('/v1/audit-log', O, ['audit_log'], 'A4 audit_log, C3'),
  'read:health_checks': read('/v1/health/checks', O, ['check_runs', 'backup_runs'], 'A4 check_runs and backup_runs, C3'),
  'read:dashboard_health': read('/v1/dashboard/health', O, [], 'C3, section 12: the dashboard line, computed, no table'),
  // the combined poll (C4): open to everyone who may read anything; the handler asks mayCall(role, 'read:<resource>') for each resource named and refuses the whole call if one is not allowed
  'read:poll': read('/v1/sync/poll', OBS, [], 'C4: the call is 403 JV_FORBIDDEN as a whole when one named resource is not the role\'s', 'POST'),

  // ---- direct edits (A5), PATCH with the stale check, or PUT/POST of ordinary fields
  'edit:settings.update': edit('PUT', '/v1/settings/:key', O, { table: 'settings', op: 'update', shape: 'fields' }, 'A4 settings: S, I, U for the owner; never last_download or last_pulled (NEVER_WRITTEN_SETTINGS)'),
  'edit:daily_rates.insert': edit('POST', '/v1/daily-rates', OB, { table: 'daily_rates', op: 'insert', shape: 'fields' }, 'A4 daily_rates: owner any date up to today, biller today only (D4, Y8)'),
  'edit:daily_rates.update': edit('PATCH', '/v1/daily-rates/:id', O, { table: 'daily_rates', op: 'update', shape: 'changes' }, 'A4 daily_rates: the owner corrects a row dated today'),
  'edit:categories.insert': edit('POST', '/v1/categories', OS, { table: 'categories', op: 'insert', shape: 'fields' }, 'A4 categories'),
  'edit:categories.update': edit('PATCH', '/v1/categories/:id', O, { table: 'categories', op: 'update', shape: 'changes' }, 'A4 categories'),
  'edit:subcategories.insert': edit('POST', '/v1/subcategories', OS, { table: 'subcategories', op: 'insert', shape: 'fields' }, 'A4 subcategories'),
  'edit:subcategories.update': edit('PATCH', '/v1/subcategories/:id', O, { table: 'subcategories', op: 'update', shape: 'changes' }, 'A4 subcategories'),
  'edit:designs.update': edit('PATCH', '/v1/designs/:id', OS, { table: 'designs', op: 'update', shape: 'changes' }, 'A4, A5 designs: content columns and archived_at; only the owner changes material, purity, selling_method'),
  'edit:skus.update': edit('PATCH', '/v1/skus/:id', OS, { table: 'skus', op: 'update', shape: 'changes' }, 'A4, A5 skus: content columns; status and archived_at only through X9'),
  'edit:sku_private.update': edit('PUT', '/v1/sku-private/:sku_id', O, { table: 'sku_private', op: 'update', shape: 'fields' }, 'A4 sku_private: S, I, U for the owner'),
  'edit:customers.update': edit('PATCH', '/v1/customers/:id', OB, { table: 'customers', op: 'update', shape: 'changes' }, 'A4, A5 customers: content columns; archived_at only for the owner'),

  // ---- service functions X1 to X12 (section 10)
  'fn:create_bill': fn('/v1/bills', OB, 'X1'),
  'fn:record_payment': fn('/v1/customers/:id/payments', OB, 'X2'),
  'fn:settle_fine': fn('/v1/customers/:id/fine-settlements', OB, 'X3'),
  'fn:void_receipt': fn('/v1/receipts/:id/void', O, 'X4'),
  'fn:cancel_bill': fn('/v1/bills/:id/cancel', O, 'X5'),
  'fn:create_customer': fn('/v1/customers', OB, 'X6'),
  'fn:quote_bill': fn('/v1/bills/quote', OB, 'X7: read-only, writes nothing'),
  'fn:create_design': fn('/v1/designs', OS, 'X8: staff sending original_net_weight is JV_FORBIDDEN (FIELD_RIGHTS)'),
  'fn:set_sku_status': fn('/v1/skus/status', OS, 'X9'),
  'fn:reissue_bill': fn('/v1/bills/:id/reissue', O, 'X10'),
  'fn:issue_refund': fn('/v1/customers/:id/refunds', O, 'X11'),
  'fn:add_opening_balance': fn('/v1/customers/:id/opening-balance', O, 'X12'),

  // ---- photos (P2, P3); the photo READ is on the public list
  'photo:upload': { kind: 'photo', method: 'PUT', path: '/v1/designs/:design_id/photos/:photo_id', roles: OS, mustChange: false, spec: 'P2, P3: the owner and staff add a new photo' },
  'photo:remove': { kind: 'photo', method: 'POST', path: '/v1/photos/:photo_id/remove', roles: O, mustChange: false, spec: 'P3: only the owner removes one (a POST, nothing is deleted, S7)' },

  // ---- the owner's download record (B3)
  'owner:download_record': { kind: 'owner', method: 'POST', path: '/v1/owner/download-record', roles: O, mustChange: false, spec: 'A4, B3: the owner\'s monthly download, one record for each call' },

  // ---- the session calls: open to every signed-in user (A4). U11 lets a user who must still change the password call change-password, logout and me and nothing else
  'session:me': session('GET', '/v1/auth/me', true, 'U5, U11'),
  'session:logout': session('POST', '/v1/auth/logout', true, 'U8, U11'),
  'session:change-password': session('POST', '/v1/auth/change-password', true, 'U11'),
  'session:activity': session('POST', '/v1/auth/activity', false, 'U4; U11 keeps it out for a user who must still change the password'),
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

/** A4: staff read these seven keys of settings and no others. */
export const STAFF_SETTING_KEYS: readonly string[] = ['numbering', 'materials', 'locations', 'custom_fields', 'tag_template', 'photos', 'data_epoch'];

/** A4, B3, O54: the generic edit never writes these two settings (the download record and the pull record have their own calls). */
export const NEVER_WRITTEN_SETTINGS: readonly string[] = ['last_download', 'last_pulled'];

/** A4, O25: a biller reads daily_totals for today and yesterday only. */
export const BILLER_DAILY_TOTALS_DAYS = 2;

/** Section 10: the field rules that belong to the matrix. Owner-only: cash_override_reason (Z1), original_net_weight (X8), and a business date other than today (Y8). */
export const FIELD_RIGHTS = {
  cash_override_reason: O,
  original_net_weight: O,
  back_dates: O,
} as const satisfies Record<string, readonly Role[]>;
export type FieldRight = keyof typeof FIELD_RIGHTS;

// ------------------------------------------------------------------ asking the matrix

const isRole = (role: unknown): role is Role => typeof role === 'string' && (ROLES as readonly string[]).includes(role);

/** Whether a role may call an action. A name that is not a role (anything a cookie, a header or a body can say) may do nothing; an action that is not a row can be done by nobody. */
export function mayCall(role: string, action: Action): boolean {
  if (!isRole(role)) return false;
  const row = Object.hasOwn(MATRIX, action) ? MATRIX[action] : undefined;
  return row !== undefined && row.roles.includes(role);
}

/** Whether a role may use an owner-only field of section 10. */
export function mayUseField(role: string, field: FieldRight): boolean {
  return isRole(role) && (FIELD_RIGHTS[field] as readonly Role[]).includes(role);
}

/**
 * A4, C3: the keys of `settings` a role reads. null means every key (the owner and the biller); staff read the seven of STAFF_SETTING_KEYS. A name that is not a role reads none, so the read
 * side never has to compare a role itself (S10).
 */
export function readableSettingKeys(role: string): readonly string[] | null {
  if (!isRole(role)) return [];
  return role === 'staff' ? STAFF_SETTING_KEYS : null;
}

// ------------------------------------------------------------------ READ_COLUMNS

type Columns = Partial<Record<Role, readonly string[]>>;

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

const all = (c: readonly string[]): Columns => ({ owner: c, biller: c, staff: c });
const ownerBiller = (c: readonly string[]): Columns => ({ owner: c, biller: c });
const ownerOnly = (c: readonly string[]): Columns => ({ owner: c });

/**
 * The columns each role reads, resource by resource (A4). A role with no entry reads nothing of the resource, and a resource is read only by the roles of its row. The lists are the same for every
 * role that reads a resource, because A9 narrows nothing by column except where A4 says so (the hash of users, the owner-only weight, which lives in sku_private and nowhere else).
 */
export const READ_COLUMNS: Readonly<Record<ReadResource, Columns>> = {
  users: all(USERS),
  settings: all(SETTINGS),
  daily_rates: all(DAILY_RATES),
  categories: all(CATEGORIES),
  subcategories: all(SUBCATEGORIES),
  designs: all(DESIGNS),
  skus: all(SKUS),
  sku_private: ownerOnly(['sku_id', 'original_net_weight', ...STAMPS]),
  customers: ownerBiller(CUSTOMERS),
  bills: ownerBiller(BILLS),
  bill_items: ownerBiller(BILL_ITEMS),
  receipts: ownerBiller(RECEIPTS),
  receipt_allocations: ownerBiller(RECEIPT_ALLOCATIONS),
  audit_log: ownerOnly(['id', 'at', 'actor', 'actor_role', 'request_id', 'table_name', 'row_id', 'action', 'old_row', 'new_row']),
  check_runs: ownerOnly(['id', 'ran_at', 'ok', 'details']),
  backup_runs: ownerOnly(['id', 'ran_at', 'kind', 'ok', 'bytes', 'detail']),
  bill_summary: ownerBiller(BILL_SUMMARY),
  customer_balances: ownerBiller(CUSTOMER_BALANCES),
  customer_ledger: ownerBiller(CUSTOMER_LEDGER),
  daily_totals: ownerBiller(DAILY_TOTALS),
};

/**
 * Columns of a read table that NO role reads, and why. Every other column of the table is listed in READ_COLUMNS: the test adds the two up and fails on a column in neither (a migration that
 * adds a column must decide) or in both.
 */
export const HIDDEN_COLUMNS = {
  users: {
    email: 'the login name: A4 gives users as id, full_name, role and active only',
    password_hash: 'the hash is never read by any route, not even the owner\'s (A4, D1, T-D16)',
    must_change_password: 'only the session calls tell a user about their own flag (U11)',
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

/**
 * The fields each role may send on each direct edit (A5). A field outside the list is refused with JV_FORBIDDEN, an unknown field with JV_INVALID_INPUT, and nothing is silently ignored. What is
 * not a column list but a rule of the call (staff may only add photo ids at the end; a biller writes today's rate only; archiving needs a zero balance) is the handler's, and is tested there.
 * Never a stamp, a person column or a state that only a function changes (S6, A5).
 */
export const WRITE_COLUMNS: Readonly<Record<EditAction, Columns>> = {
  'edit:settings.update': ownerOnly(['value']),
  'edit:daily_rates.insert': ownerBiller(['material', 'purity', 'rate_per_gram', 'rate_date']),
  'edit:daily_rates.update': ownerOnly(['rate_per_gram']),
  'edit:categories.insert': { owner: ['name', 'prefix'], staff: ['name', 'prefix'] },
  'edit:categories.update': ownerOnly(['name', 'active']),
  'edit:subcategories.insert': { owner: ['category_id', 'name'], staff: ['category_id', 'name'] },
  'edit:subcategories.update': ownerOnly(['name', 'active']),
  'edit:designs.update': { owner: [...DESIGN_CONTENT, 'material', 'purity', 'selling_method'], staff: DESIGN_CONTENT },
  'edit:skus.update': { owner: SKU_CONTENT, staff: SKU_CONTENT },
  'edit:sku_private.update': ownerOnly(['original_net_weight']),
  'edit:customers.update': { owner: [...CUSTOMER_CONTENT, 'archived_at'], biller: CUSTOMER_CONTENT },
};
