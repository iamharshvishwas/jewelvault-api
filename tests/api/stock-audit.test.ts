import { randomUUID } from 'node:crypto';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type EditWorld, addDesign, body, editWorld } from './edit-support';
import { addPieceIn, addSoldPiece, createDesign, designPayload, newKey, requestIdOf, rows, setStatus } from './stock-support';
import { dbError } from './tx-support';

// API16, the T-D14 clause for X8 `create_design` and X9 `set_sku_status`: `audit_log` has ONE row, written in the same transaction, for each inserted or updated row of an audited table (designs,
// skus, sku_private), with the session user and the role and the old and new row as JSON; none for a row that did not change; none when the call is refused. The rows are counted and compared with the
// rows that really changed, against BOTH mechanisms of L1: (a) the generated triggers, which write the rows by themselves from the actor variables of withTx, and (b) the Node writer of API15
// (JV_AUDIT_MODE=node, a database WITHOUT the triggers), which X8 and X9 call after every insert and update.

const AUDITED: Record<string, string> = { designs: 'id', skus: 'id', sku_private: 'sku_id' };
const asJson = (v: unknown): any => (typeof v === 'string' ? JSON.parse(v) : v);

for (const mode of ['triggers', 'node'] as const) {
  describe(`T-D14 (API16 clause) mechanism ${mode === 'triggers' ? '(a), the generated triggers' : '(b), the Node writer of API15'}: X8 and X9 write one audit row for each changed row`, () => {
    let w: EditWorld;
    beforeAll(async () => {
      w = await editWorld(mode === 'triggers' ? 'stockaudit' : 'stockauditn', mode === 'triggers' ? { triggers: true } : { config: { auditMode: 'node' } });
    }, 120_000);
    afterAll(async () => {
      await w?.world.close();
    }, 60_000);

    /** Every row of the audited tables as JSON, by key: the "changed rows" of T-D14 are found by comparing two of these. */
    async function snapshot(): Promise<Map<string, string>> {
      const out = new Map<string, string>();
      for (const [table, key] of Object.entries(AUDITED)) for (const r of await rows(w, `SELECT * FROM \`${table}\``)) out.set(`${table}:${r[key]}`, JSON.stringify(r));
      return out;
    }

    /** What a call does: the rows that were inserted or changed (by table and key), and the audit rows its request wrote. */
    async function observe(run: () => Promise<LightMyRequestResponse>) {
      const before = await snapshot();
      const res = await run();
      const after = await snapshot();
      const changed = [...after].filter(([k, row]) => before.get(k) !== row).map(([k]) => k).sort();
      const audit = await rows(w, 'SELECT * FROM audit_log WHERE request_id = ? ORDER BY id', [requestIdOf(res)]);
      return { res, changed, audit };
    }
    const keyOf = (a: any) => `${a.table_name}:${a.row_id}`;

    it('X8 by the owner: the design, each piece and each owner-only weight give exactly one insert row, with the owner and the new row', async () => {
      const payload = designPayload(w, { pieces: [{ pieces: 2, gross_weight: '10.000', customer_net_weight: '9.000', original_net_weight: '8.500', labour_retail: '350.00' }, { pieces: 1, gross_weight: '5.000', customer_net_weight: '4.000' }] });
      const { res, changed, audit } = await observe(() => createDesign(w, 'owner', payload));
      expect(res.statusCode, res.body).toBe(201);
      const b = body(res);
      expect(changed).toHaveLength(1 + 3 + 2); // the design, three pieces, two owner-only weights
      expect(audit).toHaveLength(changed.length);
      expect(audit.map(keyOf).sort()).toEqual(changed); // the same rows, each once
      for (const a of audit) {
        expect(a).toMatchObject({ action: 'insert', actor: w.world.fixtures.owner.userId, actor_role: 'owner', old_row: null });
        expect(asJson(a.new_row)).toBeTruthy();
      }
      const design = audit.find((a) => a.table_name === 'designs');
      expect(asJson(design.new_row)).toMatchObject({ id: b.design.id, design_no: b.design.design_no, material: 'Gold', purity: '22K', created_by: w.world.fixtures.owner.userId });
      const piece = audit.find((a) => a.table_name === 'skus' && a.row_id === b.skus[0].id);
      expect(asJson(piece.new_row)).toMatchObject({ sku_no: b.skus[0].sku_no, barcode: b.skus[0].barcode, status: 'In Stock', gross_weight: '10.000', customer_net_weight: '9.000', labour_retail: '350.00' });
      const weight = audit.find((a) => a.table_name === 'sku_private' && a.row_id === b.skus[0].id);
      expect(asJson(weight.new_row)).toMatchObject({ sku_id: b.skus[0].id, original_net_weight: '8.500', created_by: w.world.fixtures.owner.userId });
    });

    it('X8 with 500 pieces and 500 owner-only weights: 1,001 insert rows, one for each changed row, inside the deadline', async () => {
      const payload = designPayload(w, { pieces: Array.from({ length: 5 }, () => ({ pieces: 100, gross_weight: '10.000', customer_net_weight: '9.000', original_net_weight: '8.500' })) });
      const started = Date.now();
      const { res, changed, audit } = await observe(() => createDesign(w, 'owner', payload));
      const elapsed = Date.now() - started;
      expect(res.statusCode, res.body.slice(0, 200)).toBe(201);
      expect(changed).toHaveLength(1 + 500 + 500);
      expect(audit).toHaveLength(changed.length);
      expect(audit.map(keyOf).sort()).toEqual(changed);
      expect(audit.every((a) => a.action === 'insert' && a.actor_role === 'owner')).toBe(true);
      expect(elapsed, `${elapsed} ms`).toBeLessThan(10_000);
    }, 60_000);

    it('X8 by staff: the design and its pieces, no owner-only rows, the role is staff', async () => {
      const { res, changed, audit } = await observe(() => createDesign(w, 'staff', designPayload(w, { pieces: [{ pieces: 4, gross_weight: '3.000', customer_net_weight: '2.500' }] })));
      expect(res.statusCode, res.body).toBe(201);
      expect(changed).toHaveLength(5);
      expect(audit.map(keyOf).sort()).toEqual(changed);
      expect(audit.every((a) => a.action === 'insert' && a.actor_role === 'staff' && a.actor === w.world.fixtures.staff.userId)).toBe(true);
      expect(audit.some((a) => a.table_name === 'sku_private')).toBe(false);
    });

    it('X8 refused (design id used, staff sending the weight, a photo that is not there, 501 pieces): no row changed, no audit row', async () => {
      const used = designPayload(w);
      expect((await createDesign(w, 'owner', used)).statusCode).toBe(201);
      const refusals: [string, () => Promise<LightMyRequestResponse>, number][] = [
        ['design id used', () => createDesign(w, 'owner', { ...used }), 422],
        ['staff sends the original weight', () => createDesign(w, 'staff', designPayload(w, { pieces: [{ pieces: 1, gross_weight: '5.000', customer_net_weight: '4.000', original_net_weight: '3.000' }] })), 403],
        ['a photo that is not there', () => createDesign(w, 'owner', designPayload(w, { design: { photo_ids: [randomUUID()] } })), 422],
        ['501 pieces', () => createDesign(w, 'owner', designPayload(w, { pieces: Array.from({ length: 6 }, () => ({ pieces: 100, gross_weight: '5.000', customer_net_weight: '4.000' })) })), 422],
        ['a biller', () => createDesign(w, 'biller', designPayload(w)), 403],
      ];
      for (const [what, run, status] of refusals) {
        const { res, changed, audit } = await observe(run);
        expect(res.statusCode, `${what}: ${res.body.slice(0, 100)}`).toBe(status);
        expect([changed.length, audit.length], what).toEqual([0, 0]);
      }
    });

    it('X8 replayed with the same Idempotency-Key: nothing more is changed or audited', async () => {
      const payload = designPayload(w);
      const key = newKey();
      expect((await createDesign(w, 'owner', payload, key)).statusCode).toBe(201);
      const { res, changed, audit } = await observe(() => createDesign(w, 'owner', payload, key));
      expect(res.headers['idempotent-replay']).toBe('true');
      expect([changed.length, audit.length]).toEqual([0, 0]);
    });

    it('X9: one update row for each piece whose status changed, with the old and the new row; none for a piece that did not change', async () => {
      const design = await addDesign(w);
      const [a, b, c] = [await addPieceIn(w, design, 'In Stock'), await addPieceIn(w, design, 'In Stock'), await addPieceIn(w, design, 'Repair')];
      const { res, changed, audit } = await observe(() => setStatus(w, 'staff', { sku_ids: [a, b, c], status: 'Repair', note: 'polish' }));
      expect(res.statusCode, res.body).toBe(200);
      expect(changed).toEqual([`skus:${a}`, `skus:${b}`].sort()); // c was Repair already
      expect(audit.map(keyOf).sort()).toEqual(changed);
      for (const r of audit) {
        expect(r).toMatchObject({ action: 'update', actor: w.world.fixtures.staff.userId, actor_role: 'staff' });
        expect(asJson(r.old_row)).toMatchObject({ status: 'In Stock', notes: null });
        expect(asJson(r.new_row)).toMatchObject({ status: 'Repair', notes: 'polish', updated_by: w.world.fixtures.staff.userId });
      }
    });

    it('X9: Archived and leaving Archived are one row each, and the row says archived_at moved with the status', async () => {
      const design = await addDesign(w);
      const id = await addPieceIn(w, design, 'In Stock');
      const archive = await observe(() => setStatus(w, 'owner', { sku_ids: [id], status: 'Archived' }));
      expect([archive.res.statusCode, archive.audit.length, archive.changed]).toEqual([200, 1, [`skus:${id}`]]);
      expect(asJson(archive.audit[0].old_row)).toMatchObject({ status: 'In Stock', archived_at: null });
      expect(asJson(archive.audit[0].new_row)).toMatchObject({ status: 'Archived', archived_at: expect.stringMatching(/^2026-10-17 10:00:00\.\d{6}$/) });
      const leave = await observe(() => setStatus(w, 'owner', { sku_ids: [id], status: 'In Stock' }));
      expect([leave.res.statusCode, leave.audit.length]).toEqual([200, 1]);
      expect(asJson(leave.audit[0].old_row)).toMatchObject({ status: 'Archived' });
      expect(asJson(leave.audit[0].new_row)).toMatchObject({ status: 'In Stock', archived_at: null });
    });

    it('X9 refused (a Sold piece, a piece that does not exist, Sold as the status, a biller) and X9 that changes nothing: no changed row, no audit row', async () => {
      const design = await addDesign(w);
      const id = await addPieceIn(w, design, 'Missing');
      const sold = await addSoldPiece(w, design);
      const calls: [string, () => Promise<LightMyRequestResponse>, number][] = [
        ['a Sold piece', () => setStatus(w, 'owner', { sku_ids: [id, sold.piece], status: 'Repair' }), 409],
        ['a piece that does not exist', () => setStatus(w, 'owner', { sku_ids: [id, randomUUID()], status: 'Repair' }), 422],
        ['Sold as the status', () => setStatus(w, 'owner', { sku_ids: [id], status: 'Sold' }), 422],
        ['a biller', () => setStatus(w, 'biller', { sku_ids: [id], status: 'Repair' }), 403],
        ['nothing to change', () => setStatus(w, 'owner', { sku_ids: [id], status: 'Missing' }), 200],
      ];
      for (const [what, run, status] of calls) {
        const { res, changed, audit } = await observe(run);
        expect(res.statusCode, `${what}: ${res.body.slice(0, 100)}`).toBe(status);
        expect([changed.length, audit.length], what).toEqual([0, 0]);
      }
    });

    it('X9 replayed: nothing more is changed or audited', async () => {
      const design = await addDesign(w);
      const id = await addPieceIn(w, design, 'In Stock');
      const key = newKey();
      expect((await setStatus(w, 'owner', { sku_ids: [id], status: 'Damaged' }, key)).statusCode).toBe(200);
      const { res, changed, audit } = await observe(() => setStatus(w, 'owner', { sku_ids: [id], status: 'Damaged' }, key));
      expect(res.headers['idempotent-replay']).toBe('true');
      expect([changed.length, audit.length]).toEqual([0, 0]);
    });

    it('the change and its audit rows are one transaction: when the COMMIT fails, the statements have run (and, in node mode, the audit rows were written) and everything is gone, the claim and the numbers too', async () => {
      const design = await addDesign(w);
      const id = await addPieceIn(w, design, 'In Stock');
      const failCommit = async <T>(run: () => Promise<T>): Promise<{ res: T; sent: string[] }> => {
        const from = w.world.spy.sent.length;
        w.world.spy.intercept = async (e) => {
          if (e.sql === 'COMMIT') throw dbError(1205, 'ER_LOCK_WAIT_TIMEOUT', 'Lock wait timeout exceeded; try restarting transaction');
        };
        try {
          return { res: await run(), sent: w.world.spy.sqls().slice(from) };
        } finally {
          w.world.spy.intercept = null;
        }
      };

      const sku = await failCommit(() => setStatus(w, 'owner', { sku_ids: [id], status: 'Damaged' }));
      expect(sku.res.statusCode).toBe(503);
      expect(sku.sent.some((q) => /^UPDATE skus\b/i.test(q))).toBe(true);
      if (mode === 'node') expect(sku.sent.some((q) => /^INSERT INTO audit_log\b/.test(q))).toBe(true);
      expect((await rows(w, 'SELECT status FROM skus WHERE id = ?', [id]))[0].status).toBe('In Stock');

      const payload = designPayload(w, { pieces: [{ pieces: 2, gross_weight: '4.000', customer_net_weight: '3.000', original_net_weight: '2.500' }] });
      const before = await snapshot();
      const counters = await rows(w, 'SELECT COALESCE(SUM(last_value), 0) AS n FROM sys_counters');
      const claims = await rows(w, 'SELECT COUNT(*) AS n FROM sys_idempotency');
      const design8 = await failCommit(() => createDesign(w, 'owner', payload));
      expect(design8.res.statusCode).toBe(503);
      expect(design8.sent.some((q) => /^INSERT INTO designs\b/i.test(q))).toBe(true);
      if (mode === 'node') expect(design8.sent.filter((q) => /^INSERT INTO audit_log\b/.test(q))).toHaveLength(1 + 2 + 2);
      expect([...(await snapshot())]).toEqual([...before]);
      expect(await rows(w, 'SELECT COALESCE(SUM(last_value), 0) AS n FROM sys_counters')).toEqual(counters);
      expect(await rows(w, 'SELECT COUNT(*) AS n FROM sys_idempotency')).toEqual(claims);
      // the same call goes through once the database lets it (the key was not used up either)
      expect((await createDesign(w, 'owner', payload)).statusCode).toBe(201);
    });

    it('no audit row of X8 or X9 holds a hash, a token or a password', async () => {
      const made = await createDesign(w, 'owner', designPayload(w, { pieces: [{ pieces: 2, gross_weight: '5.000', customer_net_weight: '4.000', original_net_weight: '3.500' }] }));
      expect(made.statusCode).toBe(201);
      const moved = await setStatus(w, 'staff', { sku_ids: body(made).skus.map((s: any) => s.id), status: 'Repair' });
      expect(moved.statusCode).toBe(200);
      const found = await rows(w, "SELECT old_row, new_row FROM audit_log WHERE request_id IN (?, ?)", [requestIdOf(made), requestIdOf(moved)]);
      expect(found).toHaveLength(1 + 2 + 2 + 2); // the design, two pieces, two weights, two status changes
      for (const r of found) expect(`${r.old_row ?? ''}${r.new_row ?? ''}`).not.toMatch(/hash|token|password/i);
    });
  });
}
