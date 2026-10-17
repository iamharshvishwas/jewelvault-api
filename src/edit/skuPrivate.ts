// D9, D7, A4, A5: the ordinary edit of the owner-only original weight of a piece (PUT /v1/sku-private/:sku_id). The matrix row `edit:sku_private.update` is the owner's alone and its one column is
// `original_net_weight` (WRITE_COLUMNS); the piece is named by the address, and the row is made by the first write (X8 stores one only when the owner sent a weight at creation) and corrected after
// that. The body is `{ original_net_weight, expected_updated_at? }`: the stale check of A5 applies when the row exists (engine.ts, putRecord).
//
// The rules that are code and not columns, here:
//   - the piece must exist (404): the foreign key is never asked a question it would answer with a 500. Its row is locked FOR UPDATE ahead of the weight row, which serialises two first writes for one
//     piece (the second finds the row and is stale, not a duplicate key) and a gross weight that changes while the weight is checked against it.
//   - the weight rules of D7: a plain 3-decimal text within the cap (the wire format and chk_sku_private_weight), and not above the gross weight when the gross weight is above 0 (a blank gross
//     weight is stored as 0 and allowed): the one pure rule of the piece edit and of X8, weightProblem (skus.ts), asked with no selling method, because the By Weight rule of O37 (not 0) is about the
//     customer net weight and not about this one.
//   - nothing else about the weight changes: it is in sku_private and nowhere else, and the answer is the sync row of the owner (READ_COLUMNS), the only role that ever receives it (T-D03).
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Auth } from '../permissions/route.js';
import { type EditTable, type PutRule, invalid, notFound, putRecord } from './engine.js';
import * as f from './fields.js';
import { weightProblem } from './skus.js';

export const SKU_PRIVATE: EditTable = {
  table: 'sku_private',
  key: 'sku_id',
  insert: 'edit:sku_private.update',
  update: 'edit:sku_private.update',
  fields: { original_net_weight: f.weight },
};

const pieceRule: PutRule = async (tx, id) => {
  const [piece] = await tx.rows<{ gross_weight: string }>('SELECT gross_weight FROM skus WHERE id = ? FOR UPDATE', [id]);
  if (!piece) throw notFound();
  return (values) => {
    if (weightProblem(piece.gross_weight, String(values.original_net_weight), undefined) === 'net_above_gross') throw invalid('original_net_weight', 'must not be above the gross weight');
  };
};

export const putSkuPrivate = (app: FastifyInstance, request: FastifyRequest, auth: Auth, id: string, body: Record<string, unknown>) => putRecord(app, request, auth, SKU_PRIVATE, id, body, pieceRule);
