// The four derived reads of spec section 11 (V1 to V4) and the four state reads of X0 item 8 (S1 to S4) as SQL text. They are queries, not database views: with Delete and Drop unticked (S7) a view can be
// created once and never changed, and Create view is unticked too (A3). The API's read layer and the nightly check (I4, I10, I13) run the same text.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const QUERIES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'db', 'queries');
const FILES = {
  V1: 'V1_bill_summary.sql',
  V2: 'V2_customer_balances.sql',
  V2_one: 'V2_customer_balance_one.sql',
  V3: 'V3_customer_ledger.sql',
  V4: 'V4_daily_totals.sql',
  S1: 'S1_open_bills_of_customer.sql',
  S2: 'S2_open_receipts_of_customer.sql',
  S3: 'S3_bills_of_receipt.sql',
  S4: 'S4_receipts_of_bill.sql',
  P2_insert: 'P2_insert_photo.sql',
  P2_unattached: 'P2_unattached.sql',
};

/** The text of each query without its comment header and without a trailing semicolon, ready to sit in parentheses: `SELECT * FROM ( <query> ) v WHERE ...`. */
export function loadQueries(dir = QUERIES_DIR) {
  const out = {};
  for (const [name, file] of Object.entries(FILES)) {
    const lines = readFileSync(path.join(dir, file), 'utf8').split('\n');
    while (lines.length && (lines[0].startsWith('--') || lines[0].trim() === '')) lines.shift();
    out[name] = lines.join('\n').trim().replace(/;+\s*$/, '');
  }
  return out;
}
