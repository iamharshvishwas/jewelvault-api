import type { Connection } from 'mysql2/promise';

/** A number may be given as text ("1250.50") or as a JS number; text is safer, a value with more decimals than the column holds is refused (MariaDB would round it silently). */
export type Num = string | number;

export interface PackCustomer {
  /** Your own label for this customer in the report (a row number, a code). */
  ref?: string;
  /** true: dues go to the walk-in customer (fixed id, K5); name and mobile are ignored; an advance is refused. */
  walkin?: boolean;
  name: string;
  mobile?: string;
  customer_type?: 'Retail' | 'Semi-Wholesale' | 'Wholesale';
  email?: string;
  address?: string;
  gst_number?: string;
  pan?: string;
  notes?: string;
  /** Opening figures (D15): dues brought forward, silver owed (grams), money paid in advance, silver paid in advance (grams). */
  dues?: Num;
  fine_due?: Num;
  advance?: Num;
  fine_advance?: Num;
}
export interface PackPiece {
  /** Her own piece number, stored as given (trimmed). Missing: <design_no>-<3 digits> is made. */
  sku_no?: string;
  /** Missing: <barcodePrefix>-<sku_no>. */
  barcode?: string;
  gross_weight?: Num;
  customer_net_weight?: Num;
  /** The owner-only original weight: becomes a sku_private row. */
  original_net_weight?: Num;
  stones?: Num;
  stone_weight?: Num;
  kundan?: Num;
  kundan_weight?: Num;
  piroi?: Num;
  labour_retail?: Num;
  /** Missing: the average of retail and wholesale. */
  labour_semi?: Num;
  labour_wholesale?: Num;
  /** Not Sold, not Archived (a sold piece needs a bill; old estimates are not carried over). Default In Stock. */
  status?: string;
  location?: string;
  notes?: string;
}
export interface PackDesign {
  /** Her own design number, stored as given (trimmed, unique ignoring case, at most 64 characters). */
  design_no: string;
  name?: string;
  /** Category name or prefix, ignoring case. */
  category: string;
  subcategory?: string;
  material: 'Gold' | 'Silver' | string;
  purity: string;
  selling_method: 'By Weight' | 'Per Piece' | string;
  description?: string;
  notes?: string;
  tags?: string[];
  pieces?: PackPiece[];
}
export interface ImportPack {
  /** The batch name, unique: the same name is refused the second time (IM2). */
  batch: string;
  source_file?: string;
  /** 'YYYY-MM-DD': the day the opening rows are dated. */
  cut_over: string;
  customers?: PackCustomer[];
  designs?: PackDesign[];
}

export interface ImportOptions {
  /** Do everything, report, then roll back. Nothing is left in the database. */
  dryRun?: boolean;
  /**
   * 'auto' (default): one audit_log row per inserted row with no actor and the role import (L1) written by the import, or, when the audit triggers are installed (db/optional/0910),
   * by the triggers with @jv_role = 'import'. 'import' and 'none' are for a database without triggers; with triggers they are refused (never both mechanisms).
   */
  audit?: 'auto' | 'import' | 'none';
  /** Any rejected row stops the whole import and nothing is kept. Default false: rejected rows are listed and the rest is imported. */
  strict?: boolean;
  /** Id generator, default crypto.randomUUID. */
  newId?: () => string;
  /** Test seam: called after each step with its name; a throw rolls the whole batch back. */
  after?: (step: string) => Promise<void> | void;
}
export interface Reject { table: 'customers' | 'designs' | 'skus' | 'opening'; ref: string; reason: string }
export interface ImportReport {
  /** true only when nothing was rejected, every customer's outstanding and advance match the source, and (after a real run) the nightly check passes. */
  ok: boolean;
  dry_run: boolean;
  batch: { id: string | null; name: string };
  counts: {
    customers: { source: number; imported: number; rejected: number };
    designs: { source: number; imported: number; rejected: number };
    pieces: { source: number; imported: number; rejected: number };
    opening_bills: number;
    opening_advances: number;
    allocations: number;
  };
  /** Opening totals: what the source says against what was written (as text, exact). */
  totals: { dues_source: string; dues_imported: string; fine_source: string; fine_imported: string; advance_source: string; advance_imported: string; fine_advance_source: string; fine_advance_imported: string };
  /** Customers whose outstanding or advance in V2 differs from what the source implies (dues minus advance, never both). */
  mismatches: { ref: string; customer_id: string; field: string; expected: string; actual: string }[];
  rejected: Reject[];
  /** Things stored as given but worth a look: net above gross, By Weight with net 0, a PAN that was not valid and was left out, a shared mobile number. */
  warnings: string[];
  /** Customers whose mobile number was blank or not valid, listed for Siddhi (IM6). */
  invalid_mobiles: { ref: string; name: string; given: string; problem: string }[];
  /** The nightly check on the committed data; null for a dry run. */
  invariants: { ok: boolean; counts: Record<string, number> } | null;
  ms: number;
}
/** IM1 to IM6: one transaction for the whole batch. The connection must not be inside a transaction. */
export function runImport(conn: Connection, pack: ImportPack, opts?: ImportOptions): Promise<ImportReport>;
/** IM6 as text, for the person running the script. */
export function formatReport(report: ImportReport): string;
/** Ten digits, or + and 7 to 15 digits. Spaces, dashes, brackets, a leading +91 or 0 are removed. */
export function normaliseMobile(raw: unknown): { mobile: string | null; problem: string | null };
/**
 * IM3: every counter series continues after the numbers that already exist: design:<prefix>, sku:<design_no>, bill:<prefix>:<year> and opening.
 * Sets seed_value (I5) and raises last_value to it; never lowers anything. Run inside the import's transaction or on its own.
 */
export function seedCounters(conn: Connection): Promise<{ series: string; seed_value: number }[]>;
