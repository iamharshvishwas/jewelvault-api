import mysql, { type Connection } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HOST, PORT, dropDb, rootConn } from '../helpers';
import { DB_RED_LINE_BYTES, RED_AFTER_HOURS, readHealth } from '../../scripts/health.mjs';
import { insert, migratedDb } from './support';

// Spec I12 + the dashboard line + T-R03 (database half): how old the last good export and photo copy and the last check are, how big the database is, and what the user may do.
// All ages are measured in hours from one fixed "now", so the tests do not depend on the clock.

const NOW = '2026-10-15 20:00:00';
const ago = (hours: number) => {
  const d = new Date(Date.parse('2026-10-15T20:00:00Z') - hours * 3600_000);
  return d.toISOString().slice(0, 19).replace('T', ' ') + '.000000';
};
let db: string;
let c: Connection;
beforeAll(async () => {
  ({ db, c } = await migratedDb('s12_health'));
});
afterAll(async () => {
  await c.end();
  await dropDb(db);
});
async function clean() {
  await c.query('DELETE FROM check_runs');
  await c.query('DELETE FROM backup_runs');
}
const check = (hours: number, ok = 1) => insert(c, 'check_runs', { ran_at: ago(hours), ok, details: { counts: {} } });
const backup = (kind: string, hours: number, ok = 1) => insert(c, 'backup_runs', { ran_at: ago(hours), kind, ok, bytes: 1000 });
const healthy = async () => {
  await clean();
  await check(1);
  await backup('db_dump', 2);
  await backup('photo_copy', 3);
};

describe('constants', () => {
  it('red after 26 hours, and at more than 2 GB of the plan\'s 3 GB (P5, O46)', () => {
    expect(RED_AFTER_HOURS).toBe(26);
    expect(DB_RED_LINE_BYTES).toBe(2 * 1024 * 1024 * 1024);
  });
});

describe('readHealth: the dashboard line', () => {
  it('a new shop that has never run the check or a backup is red, and says so for each', async () => {
    await clean();
    const h = await readHealth(c, { now: NOW });
    expect(h.level).toBe('red');
    expect(h.reasons).toEqual(expect.arrayContaining(['check_never', 'dump_never', 'photo_copy_never']));
    expect(h.check).toEqual({ last_at: null, age_hours: null, ok: null });
    expect(h.db_dump.age_hours).toBeNull();
    expect(h.photo_copy.age_hours).toBeNull();
  });

  it('fresh check, export and photo copy: the ages are exact, nothing is red', async () => {
    await healthy();
    const h = await readHealth(c, { now: NOW });
    expect([h.check.age_hours, h.db_dump.age_hours, h.photo_copy.age_hours]).toEqual([1, 2, 3]);
    expect(h.check.ok).toBe(true);
    expect(h.reasons.filter((r) => r !== 'delete_or_drop_right')).toEqual([]);
    expect(h.level).not.toBe('red');
    expect(h.check.last_at).toBe(ago(1));
  });

  it('each age turns red only ABOVE 26 hours: 26.0 is fine, 26.5 is not', async () => {
    for (const [name, make, reason] of [
      ['check', async (hours: number) => { await healthy(); await clean(); await check(hours); await backup('db_dump', 2); await backup('photo_copy', 3); }, 'check_stale'],
      ['dump', async (hours: number) => { await clean(); await check(1); await backup('db_dump', hours); await backup('photo_copy', 3); }, 'dump_stale'],
      ['photo', async (hours: number) => { await clean(); await check(1); await backup('db_dump', 2); await backup('photo_copy', hours); }, 'photo_copy_stale'],
    ] as const) {
      await make(26);
      expect((await readHealth(c, { now: NOW })).reasons, `${name} at 26.0`).not.toContain(reason);
      await make(26.5);
      const h = await readHealth(c, { now: NOW });
      expect(h.level, `${name} at 26.5`).toBe('red');
      expect(h.reasons, `${name} at 26.5`).toContain(reason);
    }
  });

  it('a failed backup run after a good one does not reset the age: only ok = 1 counts', async () => {
    await healthy();
    await backup('db_dump', 0.5, 0); // a failed export half an hour ago
    await backup('db_dump', 30, 1);
    await c.query("DELETE FROM backup_runs WHERE kind = 'db_dump' AND ok = 1 AND ran_at = ?", [ago(2)]);
    const h = await readHealth(c, { now: NOW });
    expect(h.db_dump.age_hours).toBe(30);
    expect(h.reasons).toContain('dump_stale');
  });

  it('a restore drill is not a backup: kind restore_drill never counts for the export or the photo copy', async () => {
    await clean();
    await check(1);
    await backup('restore_drill', 0.1);
    const h = await readHealth(c, { now: NOW });
    expect(h.db_dump.age_hours).toBeNull();
    expect(h.photo_copy.age_hours).toBeNull();
  });

  it('the last check saying Problem is red at once, even when it ran a minute ago', async () => {
    await healthy();
    await check(0.02, 0);
    const h = await readHealth(c, { now: NOW });
    expect(h.check.ok).toBe(false);
    expect(h.level).toBe('red');
    expect(h.reasons[0]).toBe('check_problem');
    expect(h.reasons).not.toContain('check_stale');
  });

  it('an older failed check does not matter once a newer good one exists', async () => {
    await healthy();
    await check(5, 0);
    expect((await readHealth(c, { now: NOW })).reasons).not.toContain('check_problem');
  });

  it('the database size is measured from information_schema, in bytes, and is above zero', async () => {
    await healthy();
    const h = await readHealth(c, { now: NOW });
    expect(h.db_size.injected).toBe(false);
    expect(h.db_size.bytes).toBeGreaterThan(100_000);
    expect(h.db_size.bytes).toBe(h.db_size.data_bytes + h.db_size.index_bytes);
    expect(h.db_size.red_line_bytes).toBe(DB_RED_LINE_BYTES);
    expect(h.reasons).not.toContain('db_size');
  });

  it('above 2 GB is red; exactly 2 GB is not (an injected size)', async () => {
    await healthy();
    const over = await readHealth(c, { now: NOW, sizeBytes: DB_RED_LINE_BYTES + 1 });
    expect(over.level).toBe('red');
    expect(over.reasons).toContain('db_size');
    expect(over.db_size.injected).toBe(true);
    expect((await readHealth(c, { now: NOW, sizeBytes: DB_RED_LINE_BYTES })).reasons).not.toContain('db_size');
  });

  it('reasons come in dashboard order: check, export, photo copy, size', async () => {
    await clean();
    const h = await readHealth(c, { now: NOW, sizeBytes: DB_RED_LINE_BYTES + 1 });
    const order = ['check_problem', 'check_stale', 'check_never', 'dump_stale', 'dump_never', 'photo_copy_stale', 'photo_copy_never', 'db_size', 'delete_or_drop_right'];
    const idx = h.reasons.map((r) => order.indexOf(r));
    expect(idx.every((i) => i >= 0)).toBe(true);
    expect(idx).toEqual([...idx].sort((a, b) => a - b));
  });

  it('the default "now" is the database\'s own UTC clock', async () => {
    await clean();
    const [[t]] = await c.query<any[][]>('SELECT DATE_FORMAT(UTC_TIMESTAMP(6), "%Y-%m-%d %H:%i:%s.%f") AS t');
    await insert(c, 'check_runs', { ran_at: (t as any).t, ok: 1 });
    const h = await readHealth(c);
    expect(h.check.age_hours).toBeLessThan(0.01);
  });
});

describe('readHealth: what the database user may do (amber)', () => {
  let limited: Connection;
  let rootC: Connection;
  beforeAll(async () => {
    rootC = await rootConn();
    await rootC.query("CREATE USER IF NOT EXISTS 'jv_limited'@'%' IDENTIFIED BY 'spike_limited_only'");
    await rootC.query(`GRANT SELECT, INSERT, UPDATE, CREATE, ALTER, INDEX, REFERENCES, TRIGGER ON \`${db}\`.* TO 'jv_limited'@'%'`);
    limited = await mysql.createConnection({ host: HOST, port: PORT, user: 'jv_limited', password: 'spike_limited_only', database: db, decimalNumbers: false, supportBigNumbers: true, bigNumberStrings: true, dateStrings: true });
  });
  afterAll(async () => {
    await limited.end();
    await rootC.query("DROP USER IF EXISTS 'jv_limited'@'%'");
    await rootC.end();
  });

  it('a user with ALL PRIVILEGES can delete and drop: amber', async () => {
    await healthy();
    const h = await readHealth(c, { now: NOW });
    expect(h.rights).toEqual({ delete: true, drop: true });
    expect(h.level).toBe('amber');
    expect(h.reasons).toEqual(['delete_or_drop_right']);
  });

  it('a user without Delete and Drop (the S7 setting) is green', async () => {
    await healthy();
    const h = await readHealth(limited, { now: NOW });
    expect(h.rights).toEqual({ delete: false, drop: false });
    expect(h.level).toBe('green');
    expect(h.reasons).toEqual([]);
  });

  it('either right alone is enough for amber', async () => {
    await healthy();
    await rootC.query(`GRANT DELETE ON \`${db}\`.* TO 'jv_limited'@'%'`);
    expect((await readHealth(limited, { now: NOW })).rights).toEqual({ delete: true, drop: false });
    await rootC.query(`REVOKE DELETE ON \`${db}\`.* FROM 'jv_limited'@'%'`);
    await rootC.query(`GRANT DROP ON \`${db}\`.* TO 'jv_limited'@'%'`);
    expect((await readHealth(limited, { now: NOW })).rights).toEqual({ delete: false, drop: true });
    await rootC.query(`REVOKE DROP ON \`${db}\`.* FROM 'jv_limited'@'%'`);
  });

  it('a right on another database does not count; red wins over amber', async () => {
    await clean();
    await rootC.query("GRANT DELETE ON `jv_other_%`.* TO 'jv_limited'@'%'");
    const h = await readHealth(limited, { now: NOW });
    expect(h.rights.delete).toBe(false);
    expect(h.level).toBe('red');
    await rootC.query("REVOKE DELETE ON `jv_other_%`.* FROM 'jv_limited'@'%'");
  });
});
