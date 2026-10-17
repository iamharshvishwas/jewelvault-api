// A4, A5, D10, Z3: the content columns of a customer (PATCH /v1/customers/:id). The columns are the matrix's (WRITE_COLUMNS: the owner and a biller `name`, `mobile`, `customer_type`, `email`,
// `address`, `gst_number`, `pan` and `notes`; only the owner `archived_at`). A customer is MADE by X6 create_customer (API19), never here.
//
// The rules that are code and not columns, here:
//   - a named customer keeps a mobile number: it may be blanked only for an imported customer (D10, O33: the screen asks for the number when the customer is selected). The pattern of the number
//     and of the PAN is the field's (fields.ts), checked before the database's CHECK is asked, so a mistake is a refusal of the field and never a 4025.
//   - the walk-in customer never holds a PAN and is never archived (D10: the CHECK `chk_customers_walkin` says so too; this is the plain answer in front of it).
//
// NOT HERE, ON PURPOSE (API19): the archive rule of K4 and A5. A customer may be archived only while outstanding, fine outstanding, advance and fine advance are all zero, and the check takes the
// customer lock of X0 item 3 so that a payment cannot arrive between the check and the archive (pause point `archive_customer.after_check`; the interleaving test T-C20 is API29's). Until API19
// adds it at the marked place below, the owner's `archived_at` is a plain content column: only the owner can send it (a biller is 403 JV_FORBIDDEN).
import type { FastifyInstance, FastifyRequest } from 'fastify';
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

const customerRules: UpdateRule = async ({ current, diff }) => {
  const walkin = Number(current.is_walkin) === 1;
  if ('mobile' in diff && diff.mobile === null && !walkin && current.import_batch_id === null) {
    throw invalid('changes.mobile', 'is required: only an imported customer may have no mobile number');
  }
  if (walkin) {
    if ('pan' in diff && diff.pan !== null) throw notAllowed('changes.pan', 'The walk-in customer holds no PAN.');
    if ('archived_at' in diff && diff.archived_at !== null) throw notAllowed('changes.archived_at', 'The walk-in customer is never archived.');
  }
  // API19 (K4, A5): an archive (`'archived_at' in diff && diff.archived_at !== null`) is refused here, 409 JV_NOT_ALLOWED, while any of the four balance figures of the customer is not zero,
  // after taking the customer lock; the walk-in rule above stays.
};

export const editCustomer = (app: FastifyInstance, request: FastifyRequest, auth: Auth, id: string, body: UpdateBody) => updateRecord(app, request, auth, CUSTOMERS, id, body, customerRules);
