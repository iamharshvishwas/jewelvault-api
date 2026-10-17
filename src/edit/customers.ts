// A4, A5, D10, Z3, K4: the content columns of a customer (PATCH /v1/customers/:id). The columns are the matrix's (WRITE_COLUMNS: the owner and a biller `name`, `mobile`, `customer_type`, `email`,
// `address`, `gst_number`, `pan` and `notes`; only the owner `archived_at`). A customer is MADE by X6 create_customer (src/money/x06CreateCustomer.ts), never here.
//
// The rules that are code and not columns, here:
//   - a named customer keeps a mobile number: it may be blanked only for an imported customer (D10, O33: the screen asks for the number when the customer is selected). The pattern of the number
//     and of the PAN is the field's (fields.ts), checked before the database's CHECK is asked, so a mistake is a refusal of the field and never a 4025.
//   - the walk-in customer never holds a PAN and is never archived (D10: the CHECK `chk_customers_walkin` says so too; this is the plain answer in front of it).
//   - THE ARCHIVE (K4, A5, API19): a customer is archived only while outstanding, fine outstanding, advance and fine advance are all zero. The check is made under the customer lock of X0 item 3
//     (lockCustomer; the edit has already read the row FOR UPDATE, which is the same lock, so the helper is the written order and costs no wait) and reads the totals once
//     (readCustomerTotals, the V2 text for one customer: in the test build the session is held right after that read, at `archive_customer.after_check`), so a payment cannot arrive between the
//     check and the archive: it waits at the customer lock, and when the archive has committed it finds the customer archived. Not an archive: an edit that does not set `archived_at`, an
//     `archived_at` that is already set (nothing changes), and bringing a customer back (`archived_at` null) read no books. The interleaving with a payment is T-C20 (API29).
//   - the order of the answers: the stale check first (the screen reloads), then the walk-in, then the books. A payment that committed since the screen read the customer moves the customer's stamp
//     (D23), so an archive sent with the old stamp is answered JV_STALE with the fresh row and not with the balance: the screen shows the row again and the owner decides again.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { lockCustomer } from '../db/locks.js';
import { readCustomerTotals } from '../db/state.js';
import { JvError } from '../errors.js';
import type { Auth } from '../permissions/route.js';
import { type EditTable, type UpdateBody, type UpdateRule, invalid, notAllowed, updateRecord } from './engine.js';
import * as f from './fields.js';

export const CUSTOMERS: EditTable = {
  table: 'customers',
  update: 'edit:customers.update',
  fields: {
    name: f.requiredText(120),
    mobile: f.customerMobile,
    customer_type: f.oneOf(['Retail', 'Semi-Wholesale', 'Wholesale']),
    email: f.optionalText(254),
    address: f.optionalText(500),
    gst_number: f.optionalText(20),
    pan: f.customerPan,
    notes: f.optionalText(f.TEXT_MAX),
    archived_at: f.archiveTime,
  },
};

/** The four figures of K4 as V2 names them, with the number of decimals of each (money 2, silver grams 3). */
const BALANCE_FIGURES = [
  ['outstanding', 2],
  ['fine_outstanding', 3],
  ['advance', 2],
  ['fine_advance', 3],
] as const;

const customerRules: UpdateRule = async ({ tx, id, current, diff }) => {
  const walkin = Number(current.is_walkin) === 1;
  if ('mobile' in diff && diff.mobile === null && !walkin && current.import_batch_id === null) {
    throw invalid('changes.mobile', 'is required: only an imported customer may have no mobile number');
  }
  if (walkin) {
    if ('pan' in diff && diff.pan !== null) throw notAllowed('changes.pan', 'The walk-in customer holds no PAN.');
    if ('archived_at' in diff && diff.archived_at !== null) throw notAllowed('changes.archived_at', 'The walk-in customer is never archived.');
  }
  if ('archived_at' in diff && diff.archived_at !== null) {
    // K4, A5, X0 item 3: the customer lock first, then the books; nothing is written before the check has been made
    await lockCustomer(tx, id);
    const totals = await readCustomerTotals(tx, { fn: 'archive_customer', customerId: id });
    const notZero = BALANCE_FIGURES.filter(([name, decimals]) => f.decimalUnits(totals[name], decimals) !== 0n).map(([name]) => name);
    if (notZero.length > 0) {
      throw new JvError('JV_NOT_ALLOWED', 'This customer still owes money or silver, or holds an advance of money or silver. A customer can be archived only when all four are zero.', {
        details: { field: 'changes.archived_at', not_zero: notZero },
      });
    }
  }
};

export const editCustomer = (app: FastifyInstance, request: FastifyRequest, auth: Auth, id: string, body: UpdateBody) => updateRecord(app, request, auth, CUSTOMERS, id, body, customerRules);
