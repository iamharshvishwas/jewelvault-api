// X8 create_design (POST /v1/designs, 201 {design, skus} and, for the caller who may enter it, sku_private), R1 (1), L3, L4, P2, D6, D7, D9, T-C03, T-C17, T-A02, T-F01.
//
// The screen makes the design's id (a version-4 UUID, P2) and one id for each photo before it uploads the photos; it then sends
//   { design_id, design: { category_id, subcategory_id?, name?, material, purity, selling_method, description?, notes?, tags?, photo_ids?, primary_photo_id? },
//     pieces: [ { pieces: 1..100, gross_weight?, customer_net_weight?, original_net_weight?, stones?, stone_weight?, kundan?, kundan_weight?, piroi?,
//                 labour_retail?, labour_semi?, labour_wholesale?, notes? }, ... ] }
// with an Idempotency-Key. A group of `pieces` identical pieces is the screen's "quantity" row; at most 500 pieces in all. Weights, rates and amounts are decimal text (S3). A blank rate is a rate that is
// absent or null: the three labour rates are NOT NULL in the table, so R1 (1) fills a blank semi-wholesale rate with the wholesale rate, else the retail rate, and a blank wholesale rate with the retail
// rate (a retail rate that is blank is 0.00). The status is In Stock and the location is the first entry of settings.locations (AC3: the constant BUSINESS_LOCATION of the prototype); the client names neither.
//
// The order of work is that of X0 (the lock order of NODE-DESIGN 5.4). Before the transaction: the body is parsed (the route), every rule that needs no database is checked (the total of pieces, the weights of
// D7, the primary photo), the category is read for its prefix and the counter row of `design:<prefix>` is made (ensureSeries: a series made inside a transaction can deadlock, spike F3). Then, in one
// withTx: the claim (L5); the role check, which is after the claim so that a refusal rolls the claim back and the key stays unused (X0 item 2); the checks, all plain reads (the design id is new, the category and
// subcategory exist, every photo id is attachable: P2 (a) to (d), the same function as the PATCH of a design); the numbers, LAST: the design number from `design:<prefix>`, then the piece numbers from
// `sku:<design_no>` (a number that already exists is skipped, at most 100 times, L3); then the writes. X8 takes no customer lock, and there is no existing piece to lock: the pieces are new rows, and the
// counter rows serialise two calls that make numbers of one series.
//
// THE OWNER-ONLY WEIGHT (D9). `original_net_weight` in a group is written to sku_private, and only by a caller who may use that field (mayUseField): anyone else who sends it is JV_FORBIDDEN, and the call
// writes nothing. The answer for such a caller never holds the weight: `sku_private` is in the answer only for a caller who may enter it (T-D03). A replay has the body of the first call, so a caller who may not enter the weight can only replay a call that held none.
//
// AUDIT (L1). The generated triggers write the audit rows of the design, the pieces and the weights by themselves; with JV_AUDIT_MODE=node auditChange writes the same rows here, one for each inserted row.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { type AuditedRow, auditChange } from '../db/audit.js';
import { claim, idempotencyKey, markReplay, storeResult } from '../db/idempotency.js';
import { newId } from '../db/ids.js';
import { MAX_SKIPPED_NUMBERS, type IssuedNumber, type NumberSeries, barcodeFor, designNumbers, ensureSeries, ensureSeriesInTx, nextNumber, pieceNumbers } from '../db/numbers.js';
import type { Param } from '../db/stmt.js';
import { type Tx, txContextFor, withRead, withTx } from '../db/tx.js';
import { assertAttachable } from '../edit/designs.js';
import { type Row, invalid, mustExist, readRow, wireRow } from '../edit/engine.js';
import * as f from '../edit/fields.js';
import { weightProblem } from '../edit/skus.js';
import { BusyError, JvError, unavailableError } from '../errors.js';
import { limits } from '../limits.js';
import { columnsOfTable, mayUseField } from '../permissions/matrix.js';
import { type Auth, assertMayCall, route } from '../permissions/route.js';
import * as wire from '../wire/zod.js';

// ------------------------------------------------------------------ the body

const MATERIALS = ['Gold', 'Silver'];
const METHODS = ['By Weight', 'Per Piece'];

// The schemas of src/edit/fields.ts are the PATCH's own, so that a design is checked the same way when it is made and when it is edited; their type is the general ZodType, and what each one gives back is known here.
const optionalText = (max: number) => f.optionalText(max).schema as z.ZodType<string | null>;
const requiredText = (max: number) => f.requiredText(max).schema as z.ZodType<string>;
const oneOf = (words: readonly string[]) => f.oneOf(words).schema as z.ZodType<string>;
const countField = f.count.schema as z.ZodType<number>;
const tagsField = f.tags.schema as z.ZodType<string[]>;
const photoIdsField = f.photoIds.schema as z.ZodType<string[]>;

const piecesMessage = `must be a whole number from 1 to ${limits.maxPiecesPerGroup}`;
const countMessage = (what: string) => (issue: { input?: unknown }) => (issue.input === undefined ? 'is required' : what);

/** One row of the screen's stock table: `pieces` identical pieces. */
const pieceGroup = wire.strictObject({
  pieces: z
    .number({ error: countMessage(piecesMessage) })
    .int(piecesMessage)
    .min(1, piecesMessage)
    .max(limits.maxPiecesPerGroup, piecesMessage),
  gross_weight: wire.weight.optional(),
  customer_net_weight: wire.weight.optional(),
  /** Owner only (D9, X8): from anyone else the call is JV_FORBIDDEN, after the claim. */
  original_net_weight: wire.weight.optional(),
  stones: countField.optional(),
  stone_weight: wire.weight.optional(),
  kundan: countField.optional(),
  kundan_weight: wire.weight.optional(),
  piroi: wire.amount.optional(),
  /** Absent or null is blank (R1 (1)). */
  labour_retail: wire.rate.nullish(),
  labour_semi: wire.rate.nullish(),
  labour_wholesale: wire.rate.nullish(),
  notes: optionalText(f.TEXT_MAX).optional(),
});

const totalMessage = `must make at most ${limits.maxPiecesPerCall} pieces in all`;
const groupsMessage = `must be a list of 1 to ${limits.maxPiecesPerCall} groups of pieces`;

const designInput = wire.strictObject({
  category_id: wire.uuid,
  subcategory_id: wire.uuid.nullish(),
  name: optionalText(120).optional(),
  material: oneOf(MATERIALS),
  purity: requiredText(20),
  selling_method: oneOf(METHODS),
  description: optionalText(f.TEXT_MAX).optional(),
  notes: optionalText(f.TEXT_MAX).optional(),
  tags: tagsField.optional(),
  photo_ids: photoIdsField.optional(),
  /** Defaults to the first photo id. */
  primary_photo_id: wire.uuid.nullish(),
});

export const createDesignBody = wire.strictObject({
  design_id: wire.uuid,
  design: designInput,
  pieces: z
    .array(pieceGroup, { error: (issue) => (issue.input === undefined ? 'is required' : groupsMessage) })
    .min(1, groupsMessage)
    .max(limits.maxPiecesPerCall, groupsMessage)
    .check((ctx) => {
      const total = ctx.value.reduce((n, g) => n + g.pieces, 0);
      if (total > limits.maxPiecesPerCall) ctx.issues.push({ code: 'custom', message: totalMessage, input: ctx.value });
    }),
});
export type CreateDesignBody = z.output<typeof createDesignBody>;
type Group = CreateDesignBody['pieces'][number];

// ------------------------------------------------------------------ what needs no database

/** R1 (1), at stock creation: a blank semi-wholesale rate takes the wholesale rate, else the retail rate; a blank wholesale rate takes the retail rate; a blank retail rate is 0.00 (in the schema the three are never blank). */
export function labourRates(g: Pick<Group, 'labour_retail' | 'labour_semi' | 'labour_wholesale'>): { retail: string; semi: string; wholesale: string } {
  const retail = g.labour_retail ?? '0.00';
  const wholesale = g.labour_wholesale ?? retail;
  const semi = g.labour_semi ?? wholesale;
  return { retail, semi, wholesale };
}

interface Prepared {
  designId: string;
  photoIds: string[];
  primaryPhotoId: string | null;
  groups: Group[];
  /** the first group that carries an owner-only weight, or -1 */
  firstOriginal: number;
}

/** The rules of the body that need no database: they are answered before the claim, so a refused body never uses up its key. */
function prepare(body: CreateDesignBody): Prepared {
  const { design } = body;
  const photoIds = design.photo_ids ?? [];
  const primaryPhotoId = design.primary_photo_id ?? photoIds[0] ?? null;
  if (primaryPhotoId !== null && !photoIds.includes(primaryPhotoId)) throw invalid('design.primary_photo_id', "must be one of the design's photo ids");
  body.pieces.forEach((g, i) => {
    // D7 (O37), the one rule of the edit of a piece: the net weight is not above the gross weight (when the gross weight is above 0) and not 0 for a By Weight design
    const problem = weightProblem(g.gross_weight ?? '0.000', g.customer_net_weight ?? '0.000', design.selling_method);
    if (problem === 'net_above_gross') throw invalid(`pieces[${i}].customer_net_weight`, 'must not be above the gross weight');
    if (problem === 'net_zero') throw invalid(`pieces[${i}].customer_net_weight`, 'must be above 0 for a By Weight design');
  });
  return { designId: body.design_id, photoIds, primaryPhotoId, groups: body.pieces, firstOriginal: body.pieces.findIndex((g) => g.original_net_weight !== undefined) };
}

// ------------------------------------------------------------------ settings and numbers

interface Numbering {
  designPadding: number;
  skuPadding: number;
  barcodePrefix: string;
}

/** A value of the settings table as JSON, whether the driver parsed it or not. */
const jsonOf = (value: unknown): unknown => (typeof value === 'string' ? (JSON.parse(value) as unknown) : value);

/** D3: settings.numbering holds two paddings and the barcode prefix, and settings.locations a list of places. Anything else is a fault of the data, never of the caller. */
async function readSettings(tx: Tx): Promise<{ numbering: Numbering; location: string | null }> {
  const found = await tx.rows<{ setting_key: string; value: unknown }>("SELECT setting_key, value FROM settings WHERE setting_key IN ('numbering', 'locations')");
  const value = (key: string) => jsonOf(found.find((r) => r.setting_key === key)?.value);
  const n = value('numbering') as Partial<Numbering> | null | undefined;
  const padding = (v: unknown) => typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 10;
  if (n === null || typeof n !== 'object' || !padding(n.designPadding) || !padding(n.skuPadding) || typeof n.barcodePrefix !== 'string' || n.barcodePrefix.length === 0 || n.barcodePrefix.length > 20) {
    throw new Error('settings.numbering is missing or is not two paddings of 1 to 10 digits and a barcode prefix of 1 to 20 characters');
  }
  const locations = value('locations');
  if (!Array.isArray(locations)) throw new Error('settings.locations is missing or is not a list');
  const first: unknown = locations[0];
  if (first !== undefined && (typeof first !== 'string' || first.length === 0 || first.length > 60)) throw new Error('the first entry of settings.locations is not a place name of 1 to 60 characters');
  return { numbering: { designPadding: n.designPadding as number, skuPadding: n.skuPadding as number, barcodePrefix: n.barcodePrefix }, location: first ?? null };
}

/**
 * The next number of a series that no row of `taken` has yet. A number that exists (an imported code, IM3) is skipped by looking ahead with a plain read, at most MAX_SKIPPED_NUMBERS times, then
 * JV_INVALID_INPUT; the numbers that were skipped stay used (the call is rolled back on a refusal, and the counter with it).
 */
async function nextFree(tx: Tx, series: NumberSeries, taken: (no: string) => Promise<boolean>): Promise<IssuedNumber> {
  for (let skipped = 0; skipped <= MAX_SKIPPED_NUMBERS; skipped++) {
    const issued = await nextNumber(tx, series);
    if (!(await taken(issued.no))) return issued;
  }
  throw new JvError('JV_INVALID_INPUT', 'The next numbers are already in use, so no number could be given. Nothing was saved.');
}

const MAX_NUMBER_LENGTH = 64; // designs.design_no, skus.sku_no, skus.barcode

const designIsUsed = async (tx: Tx, id: string): Promise<boolean> => (await tx.rows('SELECT id FROM designs WHERE id = ?', [id])).length > 0;

// ------------------------------------------------------------------ the writes

const CHUNK = 100;
const DESIGN_COLUMNS = 'id, design_no, name, category_id, subcategory_id, material, purity, selling_method, description, notes, tags, primary_photo_id, photo_ids, created_at, updated_at, created_by, updated_by';
const marks = (n: number): string => `(${Array.from({ length: n }, () => '?').join(', ')})`;
const columnList = (table: string): string => columnsOfTable(table).map((c) => `\`${c}\``).join(', ');

interface NewPiece {
  id: string;
  skuNo: string;
  barcode: string;
  group: Group;
}

async function insertPieces(tx: Tx, designId: string, location: string | null, pieces: readonly NewPiece[], at: string, by: string): Promise<void> {
  const columns = 'id, design_id, sku_no, barcode, gross_weight, customer_net_weight, stones, stone_weight, kundan, kundan_weight, piroi, labour_retail, labour_semi, labour_wholesale, status, location, notes, created_at, updated_at, created_by, updated_by';
  for (let i = 0; i < pieces.length; i += CHUNK) {
    const chunk = pieces.slice(i, i + CHUNK);
    const params: Param[] = [];
    for (const p of chunk) {
      const g = p.group;
      const rates = labourRates(g);
      params.push(p.id, designId, p.skuNo, p.barcode, g.gross_weight ?? '0.000', g.customer_net_weight ?? '0.000', g.stones ?? 0, g.stone_weight ?? '0.000', g.kundan ?? 0, g.kundan_weight ?? '0.000', g.piroi ?? '0.00', rates.retail, rates.semi, rates.wholesale, 'In Stock', location, g.notes ?? null, at, at, by, by);
    }
    await tx.run(`INSERT INTO skus (${columns}) VALUES ${chunk.map(() => marks(21)).join(', ')}`, params);
  }
}

async function insertWeights(tx: Tx, pieces: readonly NewPiece[], at: string, by: string): Promise<void> {
  const withWeight = pieces.filter((p) => p.group.original_net_weight !== undefined);
  for (let i = 0; i < withWeight.length; i += CHUNK) {
    const chunk = withWeight.slice(i, i + CHUNK);
    const params: Param[] = [];
    for (const p of chunk) params.push(p.id, p.group.original_net_weight as string, at, at, by, by);
    await tx.run(`INSERT INTO sku_private (sku_id, original_net_weight, created_at, updated_at, created_by, updated_by) VALUES ${chunk.map(() => marks(6)).join(', ')}`, params);
  }
}

// ------------------------------------------------------------------ the function

export interface CreateDesignResult {
  design: Row;
  skus: Row[];
  /** only for a caller who may enter the original weight (D9) */
  sku_private?: Row[];
}

function contextOf(app: FastifyInstance, request: FastifyRequest, auth: Auth) {
  if (!app.db) throw unavailableError();
  return txContextFor(app.db, request, { id: auth.user.id, role: auth.user.role });
}

/** X8. `key` is the Idempotency-Key as idempotencyKey() read it. Returns the answer and whether it is the stored answer of an earlier call. */
export async function createDesign(app: FastifyInstance, request: FastifyRequest, auth: Auth, key: string, body: CreateDesignBody): Promise<{ value: CreateDesignResult; replayed: boolean }> {
  const role = auth.user.role;
  const prepared = prepare(body);
  const ctx = contextOf(app, request, auth);

  // the counter row of the design series exists before the transaction (L3); the category says which series
  const prefix = await withRead(ctx, async (r) => (await r.rows<{ prefix: string }>('SELECT prefix FROM categories WHERE id = ?', [body.design.category_id]))[0]?.prefix);
  if (prefix === undefined) throw invalid('design.category_id', 'is not a category');
  await ensureSeries(ctx, designNumbers(prefix).key);

  return withTx(ctx, async (tx) => {
    const c = await claim(tx, { key, fn: 'create_design', route: 'POST /v1/designs', body });
    assertMayCall(role, 'fn:create_design'); // X0 item 2: after the claim, whose row the rollback removes when this refuses
    const mayEnterWeight = mayUseField(role, 'original_net_weight');
    if (!mayEnterWeight && prepared.firstOriginal >= 0) {
      throw new JvError('JV_FORBIDDEN', 'The original net weight can only be entered by the owner.', { details: { field: `pieces[${prepared.firstOriginal}].original_net_weight` } });
    }
    if (!c.first) return { value: c.result as CreateDesignResult, replayed: true };

    // the checks: plain reads, all before the first counter
    if (await designIsUsed(tx, prepared.designId)) throw invalid('design_id', 'is already used by a design');
    const [category] = await tx.rows<{ prefix: string }>('SELECT prefix FROM categories WHERE id = ?', [body.design.category_id]);
    if (!category) throw invalid('design.category_id', 'is not a category');
    if (category.prefix !== prefix) throw new BusyError('series_changed', { cause: new Error('the prefix of the category changed after its counter row was made') });
    if (body.design.subcategory_id) await mustExist(tx, 'subcategories', body.design.subcategory_id, 'design.subcategory_id', 'is not a subcategory');
    if (prepared.photoIds.length > 0) await assertAttachable(tx, prepared.designId, prepared.photoIds, 'design.photo_ids'); // P2 (b) to (d), as the PATCH of a design asks
    const { numbering, location } = await readSettings(tx);

    // the numbers, last: the design's, then the pieces' (the series of the pieces is the design's own and nobody else can know it yet)
    const design = await nextFree(tx, designNumbers(prefix, numbering.designPadding), async (no) => (await tx.rows('SELECT 1 FROM designs WHERE design_no = ?', [no])).length > 0);
    if (design.no.length > MAX_NUMBER_LENGTH) throw new JvError('JV_INTERNAL', 'Something unexpected went wrong.', { cause: new Error('a design number does not fit the column') });
    const pieceSeries = pieceNumbers(design.no, numbering.skuPadding);
    await ensureSeriesInTx(tx, pieceSeries.key);
    const pieces: NewPiece[] = [];
    for (const group of prepared.groups) {
      for (let i = 0; i < group.pieces; i++) {
        const issued = await nextFree(tx, pieceSeries, async (no) => {
          const barcode = barcodeFor(numbering.barcodePrefix, no);
          if (no.length > MAX_NUMBER_LENGTH || barcode.length > MAX_NUMBER_LENGTH) {
            throw new JvError('JV_INTERNAL', 'Something unexpected went wrong.', { cause: new Error('a piece number or barcode does not fit the column: settings.numbering.barcodePrefix is too long') });
          }
          return (await tx.rows('SELECT 1 FROM skus WHERE sku_no = ? OR barcode = ?', [no, barcode])).length > 0;
        });
        pieces.push({ id: newId(), skuNo: issued.no, barcode: barcodeFor(numbering.barcodePrefix, issued.no), group });
      }
    }
    // two calls with one design id and one category are serialised by the counter row: the second reads here what the first committed
    if (await designIsUsed(tx, prepared.designId)) throw invalid('design_id', 'is already used by a design');

    // the writes, all stamped from one reading of the API clock (S6) and by the session user (D22)
    const at = app.clock.read().timestamp;
    const by = auth.user.id;
    await tx.run(
      `INSERT INTO designs (${DESIGN_COLUMNS}) VALUES ${marks(17)}`,
      [prepared.designId, design.no, body.design.name ?? null, body.design.category_id, body.design.subcategory_id ?? null, body.design.material, body.design.purity, body.design.selling_method, body.design.description ?? null, body.design.notes ?? null, JSON.stringify(body.design.tags ?? []), prepared.primaryPhotoId, JSON.stringify(prepared.photoIds), at, at, by, by],
    );
    await insertPieces(tx, prepared.designId, location, pieces, at, by);
    if (mayEnterWeight) await insertWeights(tx, pieces, at, by);

    // what was written, as the tables hold it (every column, for the audit rows of mechanism (b)), and the answer
    const designRow = await readRow(tx, 'designs', prepared.designId, false);
    if (!designRow) throw new Error('the design is gone after its own insert');
    const stored = new Map((await tx.rows<Row>(`SELECT ${columnList('skus')} FROM skus WHERE design_id = ?`, [prepared.designId])).map((r) => [String(r.id), r]));
    const skuRows = pieces.map((p) => {
      const row = stored.get(p.id);
      if (!row) throw new Error('a piece is gone after its own insert');
      return row;
    });
    const weightIds = mayEnterWeight ? pieces.filter((p) => p.group.original_net_weight !== undefined).map((p) => p.id) : [];
    const weightRows = weightIds.length === 0 ? [] : await tx.rows<Row>(`SELECT ${columnList('sku_private')} FROM sku_private WHERE sku_id IN ${marks(weightIds.length)}`, weightIds);
    const weightById = new Map(weightRows.map((r) => [String(r.sku_id), r]));

    await auditChange(tx, { table: 'designs', action: 'insert', before: null, after: designRow as AuditedRow });
    for (const row of skuRows) await auditChange(tx, { table: 'skus', action: 'insert', before: null, after: row as AuditedRow });
    for (const id of weightIds) await auditChange(tx, { table: 'sku_private', action: 'insert', before: null, after: weightById.get(id) as AuditedRow });

    const value: CreateDesignResult = {
      design: wireRow('designs', role, designRow),
      skus: skuRows.map((r) => wireRow('skus', role, r)),
      ...(mayEnterWeight ? { sku_private: weightIds.map((id) => wireRow('sku_private', role, weightById.get(id) as Row)) } : {}),
    };
    await storeResult(tx, c.key, value);
    return { value, replayed: false };
  });
}

export function registerCreateDesign(app: FastifyInstance): void {
  route(app, {
    action: 'fn:create_design',
    body: createDesignBody,
    handler: async ({ app: a, request, reply, auth, body }) => {
      const key = idempotencyKey(request.headers);
      const { value, replayed } = await createDesign(a, request, auth, key, body);
      markReplay(reply, replayed);
      return reply.code(201).send(value);
    },
  });
}
