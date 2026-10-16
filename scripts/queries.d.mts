export interface Queries { V1: string; V2: string; V2_one: string; V3: string; V4: string; S1: string; S2: string; S3: string; S4: string; P2_insert: string; P2_unattached: string }
export const QUERIES_DIR: string;
/**
 * V1 bill_summary, V2 customer_balances (everyone), V2_one (one customer; one `?` for the customer id), V3 customer_ledger, V4 daily_totals, as SELECT text.
 * Wrap one in parentheses to use it as a table: `SELECT * FROM ( ${V1} ) v WHERE v.customer_id = ?`.
 */
export function loadQueries(dir?: string): Queries;
