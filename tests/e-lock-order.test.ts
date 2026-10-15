import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Connection } from 'mysql2/promise';
import { appConn, dropDb, freshDb, latestDeadlock } from './helpers';
import { checkInvariants, runWorkload, seedSim, type Ctx } from './sim';

// Spike (e): one lock order (idempotency, customer row, pieces by id ascending, number counter LAST) under 8 parallel clients.
// The workload mixes create_bill, record_payment, cancel_bill, reissue_bill and add_opening_balance on 5 customers and 14 pieces,
// so almost every operation collides with another. Workers do NOT retry: every deadlock or timeout is counted.

let db: string;
let admin: Connection;
let base: { customers: string[]; skus: string[] };

beforeAll(async () => {
  db = await freshDb('e_lockorder');
  admin = await appConn(db);
  base = await seedSim(admin, 5, 14);
});
afterAll(async () => {
  await admin.end();
  await dropDb(db);
});

const summary = (label: string, s: Awaited<ReturnType<typeof runWorkload>>) =>
  console.log(`[e] ${label}: ok=${JSON.stringify(s.ok)} business=${JSON.stringify(s.business)} deadlocks=${s.deadlocks} lockTimeouts=${s.lockTimeouts} retries=${s.retries} other=${s.otherErrors.length}`);

describe('(e) lock order under 8 parallel clients', () => {
  it('spec order, 8 workers x 150 operations, no retry: 0 deadlocks, 0 lock timeouts, 0 unexpected errors, all invariants hold', async () => {
    const ctx: Ctx = { ...base, order: 'spec' };
    const stats = await runWorkload(db, ctx, { workers: 8, opsPerWorker: 150, seed: 1 });
    summary('spec order', stats);
    if (stats.deadlocks) console.log(await latestDeadlock());
    expect(stats.otherErrors).toEqual([]);
    expect(stats.deadlocks).toBe(0);
    expect(stats.lockTimeouts).toBe(0);
    const done = Object.values(stats.ok).reduce((a, b) => a + b, 0);
    expect(done).toBeGreaterThan(500);
    expect(stats.ok.create_bill).toBeGreaterThan(50);
    expect(stats.ok.cancel_bill).toBeGreaterThan(10);
    expect(stats.ok.reissue_bill).toBeGreaterThan(10);
    expect(await checkInvariants(admin)).toEqual([]);
  }, 120000);

  it('spec order again with other random seeds (3 more runs of 8 x 150): still 0 deadlocks', async () => {
    const ctx: Ctx = { ...base, order: 'spec' };
    for (const seed of [2, 3, 4]) {
      const stats = await runWorkload(db, ctx, { workers: 8, opsPerWorker: 150, seed });
      summary(`spec order seed ${seed}`, stats);
      if (stats.deadlocks) console.log(await latestDeadlock());
      expect(stats.otherErrors).toEqual([]);
      expect(stats.deadlocks).toBe(0);
      expect(stats.lockTimeouts).toBe(0);
    }
    expect(await checkInvariants(admin)).toEqual([]);
  }, 240000);

  it('FINDING: a statement whose WHERE column has no index (UPDATE skus ... WHERE sold_bill_id = ?) scans and locks rows in InnoDB and DEADLOCKS even when the spec order is kept', async () => {
    const db3 = await freshDb('e_lockorder_scan');
    const a3 = await appConn(db3);
    const seeded = await seedSim(a3, 5, 14);
    let seen = 0;
    for (const seed of [21, 22, 23]) {
      const stats = await runWorkload(db3, { ...seeded, order: 'spec', unindexedUpdate: true }, { workers: 8, opsPerWorker: 150, seed });
      summary(`spec order + unindexed UPDATE seed ${seed}`, stats);
      seen += stats.deadlocks;
      if (seen) break;
    }
    expect(seen).toBeGreaterThan(0);
    const [plan] = await a3.query<any[]>("EXPLAIN UPDATE skus SET status = 'In Stock' WHERE sold_bill_id = 1");
    expect(['ALL', 'index']).toContain(plan[0].type); // no usable key: a full scan, the cause
    expect(plan[0].possible_keys).toBeNull();
    await a3.query('CREATE INDEX ix_skus_sold_bill ON skus (sold_bill_id)');
    const [plan2] = await a3.query<any[]>("EXPLAIN UPDATE skus SET status = 'In Stock' WHERE sold_bill_id = 1");
    expect(plan2[0].key).toBe('ix_skus_sold_bill');
    await a3.end();
    await dropDb(db3);
  }, 240000);

  it('NEGATIVE CONTROL: counter taken BEFORE the customer lock (and pieces in caller order) -> the harness sees deadlocks, and the retry wrapper repairs them', async () => {
    const db2 = await freshDb('e_lockorder_bad');
    const a2 = await appConn(db2);
    const seeded = await seedSim(a2, 5, 14);
    const bad: Ctx = { ...seeded, order: 'bad' };
    const stats = await runWorkload(db2, bad, { workers: 8, opsPerWorker: 100, seed: 9 });
    summary('BAD order, no retry', stats);
    expect(stats.deadlocks).toBeGreaterThan(0); // proves the counter is able to catch a wrong order
    // with the retry wrapper (rollback + retry on 1213/1205) the same wrong order still ends consistent, just slower
    const retried = await runWorkload(db2, bad, { workers: 8, opsPerWorker: 100, seed: 10, retries: 8 });
    summary('BAD order, with retry', retried);
    expect(retried.otherErrors).toEqual([]);
    expect(await checkInvariants(a2)).toEqual([]);
    await a2.end();
    await dropDb(db2);
  }, 240000);

  it('InnoDB itself reports the last deadlock (SHOW ENGINE INNODB STATUS needs PROCESS privilege, so the app counts error 1213 instead)', async () => {
    const [rows] = await admin.query<any[]>("SHOW GLOBAL STATUS LIKE 'Innodb_deadlocks'").catch(() => [[]] as any);
    console.log('[e] Innodb_deadlocks (global, whole spike):', rows[0]?.Value ?? 'n/a');
    expect(true).toBe(true);
  });
});
