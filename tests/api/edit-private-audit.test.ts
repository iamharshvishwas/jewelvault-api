import { randomUUID } from 'node:crypto';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { V, insert } from '../schema/support';
import { type EditWorld, STAMP_DB, STAMP_WIRE, addDesign, addPiece, body, editWorld } from './edit-support';
import { createDesign, designPayload } from './stock-support';

// API13c, the T-D14 clause for the edit of the owner-only weight: `audit_log` has ONE row, written in the same transaction, for each inserted or updated row of `sku_private`, with the session
// user, the role and the old and new row as JSON; none for a call that changes nothing, is stale, is refused or is invalid. Counted and compared with the rows that really changed, against BOTH
// mechanisms of L1: (a) the generated triggers (they read the actor from the variables withTx sets, so the route needs no line for it) and (b) the Node writer of API15 (JV_AUDIT_MODE=node, a
// database WITHOUT the triggers), which the edit engine calls after every insert and update.
// A row the test types by SQL (a piece, a weight) is audited by the triggers with the role `sql` and, of course, not by the Node writer; the calls are told apart by their request id.

const asJson = (v: unknown): any => (typeof v === 'string' ? JSON.parse(v) : v);
const requestId = (res: LightMyRequestResponse) => String(res.headers['x-request-id']);

for (const mode of ['triggers', 'node'] as const) {
  describe(`T-D14 (API13c clause) mechanism ${mode === 'triggers' ? '(a), the generated triggers' : '(b), the Node writer of API15'}: the edit of the original weight writes one audit row for each changed row`, () => {
    let w: EditWorld;
    let design: string;
    beforeAll(async () => {
      w = await editWorld(mode === 'triggers' ? 'e13caudit' : 'e13cauditn', mode === 'triggers' ? { triggers: true } : { config: { auditMode: 'node' } });
      design = await addDesign(w);
    }, 120_000);
    afterAll(async () => {
      await w?.world.close();
    }, 60_000);

    const owner = () => w.world.fixtures.owner.userId;
    const put = (caller: 'owner' | 'biller' | 'staff', sku: string, payload: unknown) => w.world.call(caller, 'PUT', `/v1/sku-private/${sku}`, { payload });

    /** Every row of sku_private as JSON by piece: the "changed rows" of T-D14 are found by comparing two of these. */
    async function weights(): Promise<Map<string, string>> {
      const [rows] = await w.world.sql.query<any[]>('SELECT * FROM sku_private');
      return new Map(rows.map((r) => [String(r.sku_id), JSON.stringify(r)]));
    }

    /** What a call does: the rows of sku_private that differ afterwards, and the audit rows its request wrote (found by request id, so nothing else can be counted). */
    async function observe(run: () => Promise<LightMyRequestResponse>) {
      const before = await weights();
      const res = await run();
      const after = await weights();
      const changed = [...after].filter(([k, row]) => before.get(k) !== row).map(([k]) => k);
      const [audit] = await w.world.sql.query<any[]>('SELECT * FROM audit_log WHERE request_id = ? ORDER BY id', [requestId(res)]);
      return { res, changed, audit: audit as any[] };
    }

    it('the first write and a correction give exactly one audit row each, with the owner, the role and the old and new row (an insert has no old row)', async () => {
      const piece = await addPiece(w, design);
      const insertRun = await observe(() => put('owner', piece, { original_net_weight: '8.500' }));
      expect(insertRun.res.statusCode, insertRun.res.body).toBe(201);
      expect(insertRun.changed).toEqual([piece]);
      expect(insertRun.audit).toHaveLength(1);
      expect(insertRun.audit[0]).toMatchObject({ table_name: 'sku_private', row_id: piece, action: 'insert', actor: owner(), actor_role: 'owner', old_row: null });
      expect(asJson(insertRun.audit[0].new_row)).toMatchObject({ sku_id: piece, original_net_weight: '8.500', created_by: owner(), updated_by: owner() });
      const made = body(insertRun.res).row;

      const updateRun = await observe(() => put('owner', piece, { original_net_weight: '9.250', expected_updated_at: made.updated_at }));
      expect(updateRun.res.statusCode, updateRun.res.body).toBe(200);
      expect(updateRun.changed).toEqual([piece]);
      expect(updateRun.audit).toHaveLength(1);
      expect(updateRun.audit[0]).toMatchObject({ table_name: 'sku_private', row_id: piece, action: 'update', actor: owner(), actor_role: 'owner' });
      expect(asJson(updateRun.audit[0].old_row)).toMatchObject({ sku_id: piece, original_net_weight: '8.500' });
      expect(asJson(updateRun.audit[0].new_row)).toMatchObject({ sku_id: piece, original_net_weight: '9.250', updated_by: owner() });
    });

    it('a weight X8 entered is corrected with one audit row too; the same value again, a stale stamp, a biller, staff, a bad weight, an unknown piece and a stamp for a piece without a row write none and change no row', async () => {
      const made = await createDesign(w, 'owner', designPayload(w, { pieces: [{ pieces: 1, gross_weight: '10.000', customer_net_weight: '9.000', original_net_weight: '8.500' }] }));
      expect(made.statusCode, made.body).toBe(201);
      const [weight] = body(made).sku_private;
      const bare = await addPiece(w, design);

      const corrected = await observe(() => put('owner', weight.sku_id, { original_net_weight: '8.750', expected_updated_at: weight.updated_at }));
      expect(corrected.res.statusCode, corrected.res.body).toBe(200);
      expect([corrected.changed.length, corrected.audit.length]).toEqual([1, 1]);

      const current = body(corrected.res).row;
      const calls: [string, number, () => Promise<LightMyRequestResponse>][] = [
        ['the same value again', 200, () => put('owner', weight.sku_id, { original_net_weight: '8.75', expected_updated_at: current.updated_at })],
        ['a stale stamp', 409, () => put('owner', weight.sku_id, { original_net_weight: '8.100', expected_updated_at: weight.updated_at })],
        ['no stamp while the row exists', 409, () => put('owner', weight.sku_id, { original_net_weight: '8.100' })],
        ['a biller', 403, () => put('biller', weight.sku_id, { original_net_weight: '8.100', expected_updated_at: current.updated_at })],
        ['staff', 403, () => put('staff', bare, { original_net_weight: '8.100' })],
        ['a weight above the gross weight', 422, () => put('owner', weight.sku_id, { original_net_weight: '10.001', expected_updated_at: current.updated_at })],
        ['4 decimals', 422, () => put('owner', bare, { original_net_weight: '8.1000' })],
        ['a forged person column', 422, () => put('owner', bare, { original_net_weight: '8.100', updated_by: randomUUID() })],
        ['an unknown piece', 404, () => put('owner', randomUUID(), { original_net_weight: '8.100' })],
        ['a stamp for a piece without a row', 422, () => put('owner', bare, { original_net_weight: '8.100', expected_updated_at: STAMP_WIRE })],
      ];
      for (const [what, status, run] of calls) {
        const { res, changed, audit } = await observe(run);
        expect(res.statusCode, `${what}: ${res.body.slice(0, 120)}`).toBe(status);
        expect([what, changed.length, audit.length]).toEqual([what, 0, 0]);
      }
    });

    it('a piece whose weight row was typed in by hand: the owner\'s correction is one audit row, from the stamp the fixture carries', async () => {
      const piece = await addPiece(w, design);
      await insert(w.world.sql, 'sku_private', V.skuPrivate(piece, { original_net_weight: '10.500', created_at: STAMP_DB, updated_at: STAMP_DB }));
      const run = await observe(() => put('owner', piece, { original_net_weight: '10.400', expected_updated_at: STAMP_WIRE }));
      expect(run.res.statusCode, run.res.body).toBe(200);
      expect(run.audit).toHaveLength(1);
      expect(asJson(run.audit[0].old_row).original_net_weight).toBe('10.500');
      expect(asJson(run.audit[0].new_row).original_net_weight).toBe('10.400');
    });

    it('two first writes at the same moment leave exactly one insert row between them (the loser is stale and writes nothing)', async () => {
      const piece = await addPiece(w, design);
      const before = await weights();
      const results = await Promise.all([put('owner', piece, { original_net_weight: '3.100' }), put('owner', piece, { original_net_weight: '3.200' })]);
      expect(results.map((r) => r.statusCode).sort()).toEqual([201, 409]);
      const audit: any[] = [];
      for (const r of results) audit.push(...((await w.world.sql.query<any[]>('SELECT * FROM audit_log WHERE request_id = ?', [requestId(r)]))[0] as any[]));
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ table_name: 'sku_private', row_id: piece, action: 'insert' });
      expect([...(await weights())].filter(([k, row]) => before.get(k) !== row)).toHaveLength(1);
    });

    if (mode === 'node') {
      it('mechanism (b): the world has no audit trigger, so the rows above come from the Node writer alone, one for each changed row and never two', async () => {
        const [t] = await w.world.sql.query<any[]>("SELECT COUNT(*) AS n FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = DATABASE() AND TRIGGER_NAME LIKE 'trg_audit%'");
        expect(Number((t as any[])[0].n)).toBe(0);
        const piece = await addPiece(w, design);
        const run = await observe(() => put('owner', piece, { original_net_weight: '2.000' }));
        expect(run.audit).toHaveLength(1);
        expect(run.audit[0]).toMatchObject({ table_name: 'sku_private', row_id: piece, request_id: requestId(run.res) });
      });
    }
  });
}
