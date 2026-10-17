import type { Connection } from 'mysql2/promise';

/** One customer's figures as the zip alone gives them: rupees with 2 decimals and silver grams with 3, as text (worked out in whole paise and milligrams, never as a float). */
export interface ZipBalance {
  billed: string;
  received: string;
  refunded: string;
  allocated: string;
  outstanding: string;
  advance: string;
  balance: string;
  fine_billed: string;
  fine_received: string;
  fine_allocated: string;
  fine_outstanding: string;
  fine_advance: string;
}
export interface ZipBalances {
  /** customer id -> figures, for every row of customers.csv */
  customers: Map<string, ZipBalance>;
  /** MANIFEST.csv: checked is false when the zip has none; problems list every file whose row count differs from the manifest */
  manifest: { checked: boolean; problems: string[] };
  /** rows that point at a customer who is not in customers.csv (they are left out) */
  warnings: string[];
}
export interface Comparison {
  ok: boolean;
  checked: number;
  mismatches: { customer_id: string; field: string; zip: string; database: string }[];
  onlyInZip: string[];
  onlyInDatabase: string[];
}
/** RFC 4180: quotes, commas and line breaks inside quotes, doubled quotes, CRLF or LF, a leading byte-order mark. */
export function parseCsv(text: string): { header: string[]; rows: string[][] };
/** The files of a zip (stored or deflated), by their names inside the zip. Throws on anything that is not a zip. */
export function readZip(zip: Buffer): Map<string, Buffer>;
/** B3 / T-R05: each customer's balances from customers.csv, bills.csv, receipts.csv and receipt_allocations.csv of the owner's Download-everything zip (a path, or the bytes). */
export function balancesFromZip(zip: string | Buffer): ZipBalances;
/** Compares with customer_balances (V2) on this connection: outstanding, advance, fine_outstanding, and also balance and fine_advance. */
export function compareWithDatabase(conn: Connection, balances: ZipBalances): Promise<Comparison>;
export function formatComparison(cmp: Comparison): string;
