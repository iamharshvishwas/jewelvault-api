import type { Connection } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dropDb, errorOf } from '../helpers';
import { insert, migratedDb, uuid } from './support';

// db/optional: needs the TRIGGER privilege (hPanel "Trigger" tick box; log_bin is OFF on Hostinger, so no SUPER should be needed). NOT applied by default.

let db: string;
let c: Connection;
beforeAll(async () => {
  ({ db, c } = await migratedDb('s7_optional', { optional: true }));
});
afterAll(async () => {
  await c.end();
  await dropDb(db);
});

describe('optional: audit_log is append-only (L2)', () => {
  it('inserting still works; an UPDATE or a DELETE is refused with JV_FORBIDDEN', async () => {
    const id = uuid();
    await insert(c, 'audit_log', { table_name: 'bills', row_id: id, action: 'insert', new_row: { x: 1 } });
    const e1 = await errorOf(() => c.query("UPDATE audit_log SET row_id = 'changed' WHERE table_name = 'bills'"));
    const e2 = await errorOf(() => c.query("DELETE FROM audit_log WHERE table_name = 'bills'"));
    expect(e1?.errno).toBe(1644);
    expect(e1?.message).toContain('JV_FORBIDDEN');
    expect(e2?.errno).toBe(1644);
    const [r] = await c.query<any[]>('SELECT COUNT(*) AS n FROM audit_log WHERE row_id = ?', [id]);
    expect(Number(r[0].n)).toBe(1);
  });

  it('without the optional step the table is not protected by a trigger (so the choice is visible)', async () => {
    const plain = await migratedDb('s7_plain');
    const [t] = await plain.c.query<any[]>("SELECT COUNT(*) AS n FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = DATABASE()");
    expect(Number(t[0].n)).toBe(0);
    await plain.c.end();
    await dropDb(plain.db);
  });
});
