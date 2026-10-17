// C3, C4, A4: the sync resources, the things the read side serves by GET /v1/sync/<resource> and names in POST /v1/sync/poll.
//
// WHICH RESOURCES EXIST comes from the permission matrix (the rows `read:<table>` whose address is /v1/sync/<name>): a resource the matrix does not list is not here, and a row added there with no
// shape below stops the start. WHAT EACH ONE LOOKS LIKE is here: the table it is paged by (the derived reads page the BASE table, D23), its key, and how each column crosses the wire (S3). The
// columns a role may read are READ_COLUMNS of the matrix, never listed again here.
//
// The key is `id` except for settings (`setting_key`) and sku_private (`sku_id`) (C3); customer_balances is keyed by the customer's id. A UUID key is compared as a UUID, never as text (C3).
import { MATRIX, type Action, type ReadResource } from '../permissions/matrix.js';
import type { ColumnKind } from '../wire/format.js';

/** The address of a resource: /v1/sync/<name>. The poll is /v1/sync/poll and is not a resource. */
export const SYNC_PREFIX = '/v1/sync/';

export type KeyType = 'uuid' | 'text';
export type Derived = 'bill_summary' | 'customer_balances';

export interface SyncResource {
  /** The address segment, kebab-case: `daily-rates`. Also the name a poll uses. */
  readonly name: string;
  /** The row of the matrix, `read:daily_rates`: who may read it. */
  readonly action: Action;
  /** The READ_COLUMNS key. */
  readonly table: ReadResource;
  /** The base table the page is cut from (for a derived read, the table whose `updated_at` it exposes). */
  readonly from: string;
  readonly key: string;
  readonly keyType: KeyType;
  /** Columns that need a format on the wire (money, weight, id, stamp, date). Every other column is copied as it is. */
  readonly kinds: Readonly<Record<string, ColumnKind>>;
  /** JSON columns: the database hands them back as parsed JSON or as text; the wire carries JSON. */
  readonly json: readonly string[];
  /** TINYINT(1) columns: the wire carries true and false. */
  readonly flags: readonly string[];
  /** Counts that come back as BIGINT text: the wire carries a number. */
  readonly counts: readonly string[];
  /** The figures of this resource are worked out by a second statement for the rows of the page (V1, V2). */
  readonly derived: Derived | null;
  /** The resource is `settings`: a role that may not read every key reads the keys the matrix names for it. */
  readonly keyList: boolean;
}

const STAMPS = { created_at: 'timestamp', updated_at: 'timestamp', created_by: 'uuid', updated_by: 'uuid' } as const satisfies Record<string, ColumnKind>;

type Shape = Omit<SyncResource, 'name' | 'action' | 'table'>;
const shape = (s: Partial<Shape> & Pick<Shape, 'from' | 'kinds'>): Shape => ({ key: 'id', keyType: 'uuid', json: [], flags: [], counts: [], derived: null, keyList: false, ...s });

const SHAPES: Readonly<Record<string, Shape>> = {
  users: shape({ from: 'users', kinds: { id: 'uuid', updated_at: 'timestamp' }, flags: ['active'] }),
  settings: shape({ from: 'settings', key: 'setting_key', keyType: 'text', kinds: { ...STAMPS }, json: ['value'], keyList: true }),
  daily_rates: shape({ from: 'daily_rates', kinds: { id: 'uuid', rate_per_gram: 'money', rate_date: 'date', confirmed_by: 'uuid', ...STAMPS } }),
  categories: shape({ from: 'categories', kinds: { id: 'uuid', ...STAMPS }, flags: ['active'] }),
  subcategories: shape({ from: 'subcategories', kinds: { id: 'uuid', category_id: 'uuid', ...STAMPS }, flags: ['active'] }),
  designs: shape({ from: 'designs', kinds: { id: 'uuid', category_id: 'uuid', subcategory_id: 'uuid', primary_photo_id: 'uuid', archived_at: 'timestamp', ...STAMPS }, json: ['tags', 'photo_ids'] }),
  skus: shape({
    from: 'skus',
    kinds: {
      id: 'uuid', design_id: 'uuid', gross_weight: 'weight', customer_net_weight: 'weight', stone_weight: 'weight', kundan_weight: 'weight', piroi: 'money', labour_retail: 'money', labour_semi: 'money', labour_wholesale: 'money',
      sold_bill_id: 'uuid', archived_at: 'timestamp', ...STAMPS,
    },
  }),
  sku_private: shape({ from: 'sku_private', key: 'sku_id', kinds: { sku_id: 'uuid', original_net_weight: 'weight', ...STAMPS } }),
  customers: shape({ from: 'customers', kinds: { id: 'uuid', archived_at: 'timestamp', ...STAMPS }, flags: ['is_walkin'] }),
  bills: shape({
    from: 'bills',
    kinds: {
      id: 'uuid', customer_id: 'uuid', bill_date: 'date', cancelled_at: 'timestamp', cancelled_on: 'date', cancelled_by: 'uuid', reissue_of: 'uuid', subtotal: 'money', discount: 'money', additional_charges: 'money', gst_percent: 'money',
      gst_amount: 'money', grand_total: 'money', round_off: 'money', fine_weight_due: 'weight', ...STAMPS,
    },
  }),
  bill_items: shape({
    from: 'bill_items',
    kinds: {
      id: 'uuid', bill_id: 'uuid', sku_id: 'uuid', gross_weight: 'weight', customer_net_weight: 'weight', metal_rate: 'money', labour_rate: 'money', labour_amount: 'money', piroi: 'money', other_charges: 'money', metal_amount: 'money',
      fine_weight_due: 'weight', item_total: 'money', tax_rate: 'money', tax_amount: 'money', list_metal_rate: 'money', list_labour_rate: 'money', created_at: 'timestamp', updated_at: 'timestamp',
    },
  }),
  receipts: shape({
    from: 'receipts',
    kinds: { id: 'uuid', customer_id: 'uuid', amount: 'money', fine_grams: 'weight', silver_rate: 'money', paid_on: 'date', voided_at: 'timestamp', voided_on: 'date', voided_by: 'uuid', ...STAMPS },
    flags: ['is_opening'],
  }),
  receipt_allocations: shape({
    from: 'receipt_allocations',
    kinds: { id: 'uuid', receipt_id: 'uuid', bill_id: 'uuid', customer_id: 'uuid', amount: 'money', fine_grams: 'weight', released_at: 'timestamp', created_at: 'timestamp', updated_at: 'timestamp' },
  }),
  // V1 and V2 are served by the base tables: the cursor is the base row's (updated_at, id), which the touches of D23 move whenever a payment or an allocation changes (C4)
  bill_summary: shape({
    from: 'bills',
    kinds: {
      id: 'uuid', customer_id: 'uuid', reissue_of: 'uuid', bill_date: 'date', grand_total: 'money', received: 'money', pending: 'money', fine_due: 'weight', fine_settled: 'weight', fine_pending: 'weight',
      created_at: 'timestamp', updated_at: 'timestamp',
    },
    counts: ['item_count'],
    derived: 'bill_summary',
  }),
  customer_balances: shape({
    from: 'customers',
    kinds: {
      id: 'uuid', billed: 'money', total_purchases: 'money', received: 'money', refunded: 'money', allocated: 'money', outstanding: 'money', advance: 'money', balance: 'money', fine_billed: 'weight', fine_received: 'weight',
      fine_allocated: 'weight', fine_outstanding: 'weight', fine_advance: 'weight', fine_balance: 'weight', last_purchase: 'date', updated_at: 'timestamp',
    },
    derived: 'customer_balances',
  }),
};

function build(): SyncResource[] {
  const out: SyncResource[] = [];
  for (const [action, row] of Object.entries(MATRIX)) {
    if (row.kind !== 'read' || row.method !== 'GET' || !row.path.startsWith(SYNC_PREFIX)) continue;
    const table = row.reads?.[0];
    if (!table || row.reads?.length !== 1) throw new Error(`${action}: a sync row names exactly one READ_COLUMNS table`);
    const s = Object.hasOwn(SHAPES, table) ? SHAPES[table] : undefined;
    if (!s) throw new Error(`${action}: the matrix serves ${table} by ${row.path} but src/sync/resources.ts has no shape for it`);
    out.push({ name: row.path.slice(SYNC_PREFIX.length), action: action as Action, table, ...s });
  }
  for (const table of Object.keys(SHAPES)) if (!out.some((r) => r.table === table)) throw new Error(`src/sync/resources.ts has a shape for ${table}, which the matrix does not serve`);
  return out;
}

/** Every sync resource, in the order of the matrix. */
export const SYNC_RESOURCES: readonly SyncResource[] = Object.freeze(build());

const BY_NAME = new Map(SYNC_RESOURCES.map((r) => [r.name, r]));

/** The resource of an address segment or a poll's name; undefined for anything else (a table name, a column, `poll`, a made-up word). Own names only: `constructor` is nothing. */
export const resourceByName = (name: string): SyncResource | undefined => BY_NAME.get(name);
