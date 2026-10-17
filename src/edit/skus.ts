// A5, D7: the ordinary edit of a piece (PATCH /v1/skus/:id). The columns are the matrix's (WRITE_COLUMNS: the content columns of A5, the same for the owner and for staff). `status` and `archived_at`
// are not there: they change only through X9 (API16), and a call that names one is refused JV_FORBIDDEN as a whole, so a screen that saves a whole design can never undo a sale (hazard 2).
// `sku_no`, `barcode` and `design_id` never change after creation (D7).
//
// THE WEIGHT RULES of D7 (O37) run on an update that changes a weight column, on the pair as it will be after the change, and not on any other update (a CHECK would run on every update and block a
// status change on an imported row that already breaks the rule):
//   - the customer net weight is not above the gross weight, when the gross weight is above 0 (a blank gross weight, the prototype's default, is stored as 0 and allowed);
//   - for a By Weight design the customer net weight is not 0 ("staff could save weight 0").
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Auth } from '../permissions/route.js';
import { type EditTable, type UpdateBody, type UpdateRule, invalid, updateRecord } from './engine.js';
import * as f from './fields.js';

export const SKUS: EditTable = {
  table: 'skus',
  update: 'edit:skus.update',
  fields: {
    gross_weight: f.weight,
    customer_net_weight: f.weight,
    stones: f.count,
    stone_weight: f.weight,
    kundan: f.count,
    kundan_weight: f.weight,
    piroi: f.amount,
    labour_retail: f.rate,
    labour_semi: f.rate,
    labour_wholesale: f.rate,
    location: f.optionalText(60),
    notes: f.optionalText(f.TEXT_MAX),
  },
};

/**
 * D7 (O37), pure: what is wrong with a pair of weights, or null. `gross` and `net` are weight text; `sellingMethod` is the design's. X8 (API16) asks the same function for every piece it inserts, so
 * that an insert and an edit cannot differ.
 */
export function weightProblem(gross: string, net: string, sellingMethod: string | undefined): 'net_above_gross' | 'net_zero' | null {
  const g = f.decimalUnits(gross, 3);
  const n = f.decimalUnits(net, 3);
  if (g > 0n && n > g) return 'net_above_gross';
  if (n === 0n && sellingMethod === 'By Weight') return 'net_zero';
  return null;
}

const skuRules: UpdateRule = async ({ tx, current, diff }) => {
  if (!('gross_weight' in diff) && !('customer_net_weight' in diff)) return;
  const [design] = await tx.rows<{ selling_method: string }>('SELECT selling_method FROM designs WHERE id = ?', [current.design_id as string]);
  const problem = weightProblem(String(diff.gross_weight ?? current.gross_weight), String(diff.customer_net_weight ?? current.customer_net_weight), design?.selling_method);
  if (problem === 'net_above_gross') {
    throw 'customer_net_weight' in diff ? invalid('changes.customer_net_weight', 'must not be above the gross weight') : invalid('changes.gross_weight', 'must not be below the customer net weight');
  }
  if (problem === 'net_zero') throw invalid('changes.customer_net_weight', 'must be above 0 for a By Weight design');
};

export const editSku = (app: FastifyInstance, request: FastifyRequest, auth: Auth, id: string, body: UpdateBody) => updateRecord(app, request, auth, SKUS, id, body, skuRules);
