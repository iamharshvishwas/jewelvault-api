import { describe, expect, it } from 'vitest';
import { appConn, dropDb, freshDb, latestDeadlock } from './helpers';
import { runWorkload, seedSim } from './sim';

// OPT-IN (about 2 minutes, stochastic): JV_LIVE_UNIQUE=1 npx vitest run tests/e2-unique-flag-deadlock.test.ts
// Same workload as e-lock-order, spec lock order, but bill_items carries UNIQUE (live_sku) where live_sku is a generated
// column that becomes NULL when a bill is cancelled ("one live line per piece" as a constraint). Observed on 15 Oct 2026:
// a deadlock in roughly 1 run in 5 to 10 (1,200 operations each), a cycle between the number counter and a delete-marked entry of that
// unique index belonging to ANOTHER piece. A 2-connection minimal reproduction did not show it, so the exact trigger is
// not isolated; the design rule is therefore: no UNIQUE index on a column that changes (the check lives in I2 instead).
describe.skipIf(!process.env.JV_LIVE_UNIQUE)('(e2) unique key on a flipping generated column', () => {
  it('reports deadlocks over up to 12 seeds (informational)', async () => {
    const db = await freshDb('e2_unique_flag');
    const a = await appConn(db);
    const seeded = await seedSim(a, 5, 14);
    let total = 0;
    let runs = 0;
    for (const seed of [11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22]) {
      const st = await runWorkload(db, { ...seeded, order: 'spec' }, { workers: 8, opsPerWorker: 150, seed });
      runs++;
      total += st.deadlocks;
      if (st.deadlocks) console.log(await latestDeadlock());
    }
    console.log(`[e2] ${total} deadlocks in ${runs} runs of 1200 operations`);
    await a.end();
    await dropDb(db);
    expect(total).toBeGreaterThanOrEqual(0);
  }, 900000);
});
