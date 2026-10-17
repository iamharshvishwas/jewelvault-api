// X9 set_sku_status (POST /v1/skus/status, 200 {skus}), D8, INV-01, T-C07, T-C08, T-C17.
//
// { sku_ids: [1 to 500 different piece ids], status, note? } with an Idempotency-Key. The status may be any of the ten of D8 except Sold: a piece becomes Sold only when a bill is saved (X1) and goes back
// only when the bill is cancelled or re-issued (X5, X10), and a piece that IS Sold cannot be changed here at all (JV_NOT_ALLOWED naming those pieces; nothing in the call is changed). This is the ONLY way
// to change `skus.status` and `skus.archived_at` (the edit of a piece refuses both, A5): Archived sets archived_at to the API clock, and leaving Archived clears it, in the one UPDATE, because the table
// ties the two (chk_skus_archived). A piece that already has the status is left alone (no new stamp, no audit row) and is in the answer all the same.
//
// THE NOTE. The spec gives the call a `p_note` and says no more about it. It is added, on a line of its own, to the notes of each piece whose status changes (a piece that does not change gets nothing: the note
// is the reason for the change), so that it is kept with the piece and its audit row shows it. A note that would make the notes longer than the 10,000 characters of an edit is refused, not cut.
//
// X0: claim, the role check (after the claim, so a refusal rolls the claim back), the pieces by ONE statement `... WHERE id IN (...) ORDER BY id FOR UPDATE` (lockPieces: MariaDB's order, never sorted in
// code), the checks, the writes. No customer lock (the stock functions have no customer state) and no counter. AUDIT (L1): the triggers write one row for each changed piece; with JV_AUDIT_MODE=node
// auditChange writes the same rows here. The answer is the rows of the pieces, in the order asked: it never holds the original weight (that is sku_private, which this call does not touch).
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { type AuditedRow, auditChange } from '../db/audit.js';
import { claim, idempotencyKey, markReplay, storeResult } from '../db/idempotency.js';
import { lockPieces } from '../db/locks.js';
import { type Tx, txContextFor, withTx } from '../db/tx.js';
import { type Row, invalid, wireRow } from '../edit/engine.js';
import * as f from '../edit/fields.js';
import { JvError, unavailableError } from '../errors.js';
import { limits } from '../limits.js';
import { columnsOfTable } from '../permissions/matrix.js';
import { type Auth, assertMayCall, route } from '../permissions/route.js';
import * as wire from '../wire/zod.js';

/** D8: the ten statuses of a piece, as the CHECK of the table has them (a test compares the two). */
export const SKU_STATUSES = ['In Stock', 'Reserved', 'On Approval', 'Sold', 'Returned', 'Repair', 'Transferred', 'Missing', 'Damaged', 'Archived'] as const;
export type SkuStatus = (typeof SKU_STATUSES)[number];

const NOTE_MAX = 500;
const statusMessage = `must be one of ${SKU_STATUSES.join(', ')}`;
const idsMessage = `must be a list of 1 to ${limits.maxPiecesPerCall} piece ids`;

export const setSkuStatusBody = wire.strictObject({
  sku_ids: z
    .array(wire.uuid, { error: (issue) => (issue.input === undefined ? 'is required' : idsMessage) })
    .min(1, idsMessage)
    .max(limits.maxPiecesPerCall, idsMessage),
  status: z.enum(SKU_STATUSES, { error: (issue) => (issue.input === undefined ? 'is required' : statusMessage) }).check((ctx) => {
    if (ctx.value === 'Sold') ctx.issues.push({ code: 'custom', message: 'cannot be Sold here: a piece becomes Sold when a bill is saved', input: ctx.value });
  }),
  note: z
    .string({ error: 'must be text' })
    .trim()
    .max(NOTE_MAX, `must be at most ${NOTE_MAX} characters`)
    .transform((s) => (s === '' ? null : s))
    .nullish(),
});
export type SetSkuStatusBody = z.output<typeof setSkuStatusBody>;

export interface SetSkuStatusResult {
  skus: Row[];
}

function contextOf(app: FastifyInstance, request: FastifyRequest, auth: Auth) {
  if (!app.db) throw unavailableError();
  return txContextFor(app.db, request, { id: auth.user.id, role: auth.user.role });
}

/** A piece named twice is refused (nothing is dropped silently), as X1 refuses it on a bill. */
function assertEachOnce(ids: readonly string[]): void {
  const seen = new Set<string>();
  ids.forEach((id, i) => {
    if (seen.has(id)) throw invalid(`sku_ids[${i}]`, 'names a piece twice');
    seen.add(id);
  });
}

const marks = (n: number): string => `(${Array.from({ length: n }, () => '?').join(', ')})`;
const SKU_COLUMNS = columnsOfTable('skus')
  .map((c) => `\`${c}\``)
  .join(', ');
const readSkus = async (tx: Tx, ids: readonly string[]): Promise<Map<string, Row>> =>
  new Map((await tx.rows<Row>(`SELECT ${SKU_COLUMNS} FROM skus WHERE id IN ${marks(ids.length)}`, ids)).map((r) => [String(r.id), r]));

/** X9. `key` is the Idempotency-Key as idempotencyKey() read it. */
export async function setSkuStatus(app: FastifyInstance, request: FastifyRequest, auth: Auth, key: string, body: SetSkuStatusBody): Promise<{ value: SetSkuStatusResult; replayed: boolean }> {
  const role = auth.user.role;
  assertEachOnce(body.sku_ids);
  const target: SkuStatus = body.status;
  const note = body.note ?? null;

  return withTx(contextOf(app, request, auth), async (tx) => {
    const c = await claim(tx, { key, fn: 'set_sku_status', route: 'POST /v1/skus/status', body });
    assertMayCall(role, 'fn:set_sku_status'); // X0 item 2: after the claim, whose row the rollback removes when this refuses
    if (!c.first) return { value: c.result as SetSkuStatusResult, replayed: true };

    const locked = await lockPieces(tx, body.sku_ids); // ONE statement, MariaDB's id order (X0 item 5)
    const status = new Map(locked.map((r) => [r.id, r.status]));
    body.sku_ids.forEach((id, i) => {
      if (!status.has(id)) throw invalid(`sku_ids[${i}]`, 'is not a piece');
    });
    const sold = body.sku_ids.filter((id) => status.get(id) === 'Sold');
    if (sold.length > 0) {
      throw new JvError('JV_NOT_ALLOWED', 'A piece that is Sold cannot be changed here. Cancel or re-issue its bill instead.', { details: { field: 'sku_ids', sku_ids: sold } });
    }

    const before = await readSkus(tx, body.sku_ids);
    const changing = body.sku_ids.filter((id) => status.get(id) !== target);
    const notes = new Map<string, string>();
    if (note !== null) {
      for (const id of changing) {
        const existing = before.get(id)?.notes;
        const next = typeof existing === 'string' && existing !== '' ? `${existing}\n${note}` : note;
        if (next.length > f.TEXT_MAX) throw invalid('note', `does not fit in the notes of a piece (at most ${f.TEXT_MAX} characters)`);
        notes.set(id, next);
      }
    }

    if (changing.length > 0) {
      const at = app.clock.read().timestamp; // one reading for the whole call (S6)
      const archivedAt = target === 'Archived' ? at : null; // D8: Archived and archived_at go together, both ways
      for (const id of changing) {
        const withNote = notes.get(id);
        const ok =
          withNote === undefined
            ? await tx.run("UPDATE skus SET status = ?, archived_at = ?, updated_at = ?, updated_by = ? WHERE id = ? AND status <> 'Sold'", [target, archivedAt, at, auth.user.id, id])
            : await tx.run("UPDATE skus SET status = ?, archived_at = ?, notes = ?, updated_at = ?, updated_by = ? WHERE id = ? AND status <> 'Sold'", [target, archivedAt, withNote, at, auth.user.id, id]);
        // the lock and the Sold check above make this certain; `status <> 'Sold'` in the statement is the second line of defence for INV-01
        if (ok.affectedRows !== 1) throw new JvError('JV_INTERNAL', 'Something unexpected went wrong.', { cause: new Error(`the status update of a locked piece changed ${ok.affectedRows} rows`) });
      }
    }
    const after = changing.length === 0 ? before : await readSkus(tx, body.sku_ids);
    for (const id of changing) await auditChange(tx, { table: 'skus', action: 'update', before: before.get(id) as AuditedRow, after: after.get(id) as AuditedRow });

    const value: SetSkuStatusResult = { skus: body.sku_ids.map((id) => wireRow('skus', role, after.get(id) as Row)) };
    await storeResult(tx, c.key, value);
    return { value, replayed: false };
  });
}

export function registerSetSkuStatus(app: FastifyInstance): void {
  route(app, {
    action: 'fn:set_sku_status',
    body: setSkuStatusBody,
    handler: async ({ app: a, request, reply, auth, body }) => {
      const key = idempotencyKey(request.headers);
      const { value, replayed } = await setSkuStatus(a, request, auth, key, body);
      markReplay(reply, replayed);
      return reply.code(200).send(value);
    },
  });
}
