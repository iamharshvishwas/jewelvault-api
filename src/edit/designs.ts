// A5, D6, P2, P3: the ordinary edit of a design (PATCH /v1/designs/:id). The columns are the matrix's (WRITE_COLUMNS: staff the content columns and archived_at, the owner also material, purity and
// selling method); the rules that are code and not columns are here:
//   - `selling_method` cannot change while the design has a piece that is not archived (D6): the piece rates mean rupees per gram for By Weight and a piece price for Per Piece (D7).
//   - a design with a piece that is not archived cannot be archived (A5). Bringing it back is always allowed.
//   - the photo ids (P2 (a) to (e), A5): at most 3, each new id has BOTH kinds stored for THIS design and not removed, only the owner may remove, reorder or replace (the others add ids at the end),
//     and `primary_photo_id` must stay one of the ids.
//   - the category and the subcategory must exist (a made-up id is a refusal of the field, not the foreign key's error).
// "A piece that is not archived" is a piece whose status is not Archived: Sold, Reserved, Missing and the rest all count.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Tx } from '../db/tx.js';
import { mayUseField } from '../permissions/matrix.js';
import type { Auth } from '../permissions/route.js';
import { type EditTable, type UpdateBody, type UpdateRule, invalid, mustExist, notAllowed, updateRecord } from './engine.js';
import * as f from './fields.js';

const MATERIALS = ['Gold', 'Silver'];
const METHODS = ['By Weight', 'Per Piece'];

export const DESIGNS: EditTable = {
  table: 'designs',
  update: 'edit:designs.update',
  fields: {
    name: f.optionalText(120),
    description: f.optionalText(f.TEXT_MAX),
    notes: f.optionalText(f.TEXT_MAX),
    tags: f.tags,
    primary_photo_id: f.idOrNull,
    photo_ids: f.photoIds,
    category_id: f.idRequired,
    subcategory_id: f.idOrNull,
    archived_at: f.archiveTime,
    material: f.oneOf(MATERIALS),
    purity: f.requiredText(20),
    selling_method: f.oneOf(METHODS),
  },
};

const KINDS = ['full', 'thumb'] as const;

/**
 * P2 (b) to (d): every id has both kinds stored, for this design's id, and none of them is removed. One message for all, so that a photo of another design is not described. X8 (API16) asks the same
 * function for the ids of a design it is creating (`field` names where the ids stand in its body), so that the PATCH and the creation cannot differ.
 */
export async function assertAttachable(tx: Tx, designId: string, ids: readonly string[], field = 'changes.photo_ids'): Promise<void> {
  const rows = await tx.rows<{ id: string; kind: string; design_id: string; removed_at: string | null }>(
    `SELECT id, kind, design_id, removed_at FROM design_photos WHERE id IN (${ids.map(() => '?').join(', ')})`,
    [...ids],
  );
  for (const id of ids) {
    const mine = rows.filter((r) => r.id === id);
    const whole = KINDS.every((kind) => mine.some((r) => r.kind === kind && r.design_id === designId && r.removed_at === null));
    if (!whole) throw invalid(field, 'names a photo that was not uploaded for this design, or was removed');
  }
}

const designRules: UpdateRule = async ({ tx, role, id, current, diff }) => {
  let live: boolean | undefined;
  const hasLivePieces = async (): Promise<boolean> => (live ??= (await tx.rows('SELECT id FROM skus WHERE design_id = ? AND status <> ? LIMIT 1', [id, 'Archived'])).length > 0);

  if ('selling_method' in diff && (await hasLivePieces())) {
    throw notAllowed('changes.selling_method', 'The selling method cannot change while the design has pieces that are not archived.');
  }
  if ('archived_at' in diff && diff.archived_at !== null && (await hasLivePieces())) {
    throw notAllowed('changes.archived_at', 'A design with pieces that are not archived cannot be archived. Archive its pieces first.');
  }
  if ('category_id' in diff) await mustExist(tx, 'categories', diff.category_id as string, 'changes.category_id', 'is not a category');
  if ('subcategory_id' in diff && diff.subcategory_id !== null) await mustExist(tx, 'subcategories', diff.subcategory_id as string, 'changes.subcategory_id', 'is not a subcategory');

  const idsChange = 'photo_ids' in diff;
  if (!idsChange && !('primary_photo_id' in diff)) return;
  const before = f.parseList(current.photo_ids) as string[];
  const ids = idsChange ? (diff.photo_ids as string[]) : before;
  if (idsChange) {
    const addsOnly = ids.length >= before.length && before.every((x, i) => ids[i] === x);
    if (!addsOnly && !mayUseField(role, 'rewrite_photo_ids')) throw invalid('changes.photo_ids', 'can only get new photo ids added at the end');
  }
  const primary = 'primary_photo_id' in diff ? (diff.primary_photo_id as string | null) : (current.primary_photo_id as string | null);
  if (primary !== null && !ids.includes(primary)) throw invalid('changes.primary_photo_id', 'must be one of the design\'s photo ids');
  const added = ids.filter((x) => !before.includes(x)); // an id that was attached before is not asked again: it may have been removed since, and the list should still be editable
  if (added.length > 0) await assertAttachable(tx, id, added);
};

export const editDesign = (app: FastifyInstance, request: FastifyRequest, auth: Auth, id: string, body: UpdateBody) => updateRecord(app, request, auth, DESIGNS, id, body, designRules);
