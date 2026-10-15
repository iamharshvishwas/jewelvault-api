import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Connection } from 'mysql2/promise';
import { appConn, dropDb, errorOf, ER, freshDb, rng, rootConn, runTx, sleep, type DbError } from './helpers';
import { nextNumber } from './sim';

// Spike (f): a counter table gives bill numbers without gaps or repeats, also under rollback, kill and timeout.

let db: string;
const open: Connection[] = [];
const c = async () => {
  const x = await appConn(db);
  open.push(x);
  return x;
};

beforeAll(async () => {
  db = await freshDb('f_counter');
  const s = await c();
  await s.query('CREATE TABLE counters (series VARCHAR(40) PRIMARY KEY, last_value BIGINT NOT NULL) ENGINE=InnoDB');
  await s.query(`CREATE TABLE bills (id BIGINT AUTO_INCREMENT PRIMARY KEY, bill_no VARCHAR(30) NOT NULL UNIQUE, n INT NOT NULL) ENGINE=InnoDB`);
  await s.query('CREATE TABLE auto_probe (id INT AUTO_INCREMENT PRIMARY KEY, v INT) ENGINE=InnoDB');
});
afterAll(async () => {
  await Promise.all(open.map((x) => x.end().catch(() => undefined)));
  await dropDb(db);
});
beforeEach(async () => {
  const s = await c();
  await s.query('DELETE FROM bills');
  await s.query('DELETE FROM counters');
});

const issue = async (conn: Connection, series: string, hook?: (n: number) => Promise<void>) => {
  const n = await nextNumber(conn, series);
  await hook?.(n);
  await conn.query('INSERT INTO bills (bill_no, n) VALUES (?, ?)', [`${series}-${String(n).padStart(4, '0')}`, n]);
  return n;
};

describe('(f) counter table', () => {
  it('a rolled-back transaction gives its number back: no gap', async () => {
    const a = await c();
    expect(await runTx(a, () => issue(a, 'S'))).toBe(1);
    expect(await runTx(a, () => issue(a, 'S'))).toBe(2);
    const err = await errorOf(() => runTx(a, async () => { await issue(a, 'S'); throw new Error('JV_PIECE_UNAVAILABLE'); }));
    expect(err?.message).toBe('JV_PIECE_UNAVAILABLE');
    expect(await runTx(a, () => issue(a, 'S'))).toBe(3); // 3 again, not 4
    const [[row]] = await a.query<any[][]>("SELECT last_value FROM counters WHERE series = 'S'");
    expect((row as any).last_value).toBe('3');
  });

  it('CONTRAST: AUTO_INCREMENT keeps the number after a rollback (a gap), which is why it is not used for bill numbers', async () => {
    const a = await c();
    await a.query('START TRANSACTION');
    await a.query('INSERT INTO auto_probe (v) VALUES (1)');
    await a.query('ROLLBACK');
    await a.query('INSERT INTO auto_probe (v) VALUES (2)');
    const [rows] = await a.query<any[]>('SELECT id FROM auto_probe WHERE v = 2');
    expect(Number(rows[0].id)).toBeGreaterThan(1);
  });

  it('8 brand-new clients race to create the same series: numbers 1..8, no duplicate-key error, no gap', async () => {
    const conns = await Promise.all(Array.from({ length: 8 }, () => c()));
    const got = await Promise.all(conns.map((x) => runTx(x, () => issue(x, 'NEWSERIES'))));
    expect([...got].sort((p, q) => p - q)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('8 workers x 120 bills with 25% injected failures (after taking the number), 5% killed connections: issued numbers are exactly 1..N', async () => {
    const workers = 8;
    const each = 120;
    const conns = await Promise.all(Array.from({ length: workers }, () => c()));
    const root = await rootConn();
    let injected = 0;
    let killed = 0;
    let committed = 0;
    await Promise.all(
      conns.map(async (conn0, w) => {
        let conn = conn0;
        const rand = rng(900 + w);
        for (let i = 0; i < each; i++) {
          const roll = rand();
          try {
            await runTx(conn, () =>
              issue(conn, 'JV', async () => {
                if (roll < 0.25) { injected++; throw new Error('injected failure after the number was taken'); }
                if (roll < 0.3) {
                  killed++;
                  const [[id]] = await conn.query<any[][]>('SELECT CONNECTION_ID() AS id');
                  await root.query(`KILL ${(id as any).id}`); // the connection dies while holding the counter lock
                  await sleep(20);
                  await conn.query('SELECT 1'); // fails: connection gone
                }
              })
            );
            committed++;
          } catch (e) {
            const msg = (e as Error).message;
            if (!msg.startsWith('injected') && !/connection|Connection|closed|gone|Query execution was interrupted/i.test(msg)) throw e;
            if (/connection|Connection|closed|gone|interrupted/i.test(msg)) {
              conn = await appConn(db); // reconnect after a killed connection
              open.push(conn);
            }
          }
        }
      })
    );
    await root.end();
    const a = await c();
    const [rows] = await a.query<any[]>('SELECT n FROM bills ORDER BY n');
    const nums = rows.map((r) => Number(r.n));
    const [[last]] = await a.query<any[][]>("SELECT last_value FROM counters WHERE series = 'JV'");
    console.log(`[f] attempted ${workers * each}, injected failures ${injected}, killed connections ${killed}, committed ${committed}, counter ${(last as any).last_value}`);
    expect(nums).toEqual(nums.map((_, i) => i + 1)); // contiguous from 1, no repeat
    expect(Number((last as any).last_value)).toBe(nums.length);
    expect(nums.length).toBe(committed);
    expect(injected).toBeGreaterThan(50);
    expect(killed).toBeGreaterThan(10);
  }, 120000);

  it('a lock timeout (1205) on the counter row issues nothing and burns no number; the caller rolls back and later succeeds', async () => {
    const holder = await c();
    const waiter = await c();
    await waiter.query('SET SESSION innodb_lock_wait_timeout = 1');
    expect(await runTx(holder, () => issue(holder, 'T'))).toBe(1);
    await holder.query('START TRANSACTION');
    expect(await issue(holder, 'T')).toBe(2); // holds the counter row, uncommitted
    const err = await errorOf(() => runTx(waiter, () => issue(waiter, 'T')));
    expect(err?.errno).toBe(ER.LOCK_WAIT_TIMEOUT);
    await holder.query('COMMIT');
    expect(await runTx(waiter, () => issue(waiter, 'T'))).toBe(3);
    const [rows] = await waiter.query<any[]>("SELECT n FROM bills WHERE bill_no LIKE 'T-%' ORDER BY n");
    expect(rows.map((r) => Number(r.n))).toEqual([1, 2, 3]);
  });

  it('numbers already used by an import are skipped inside the same transaction (spec L3: at most 100 tries)', async () => {
    const a = await c();
    await a.query("INSERT INTO counters VALUES ('IMP', 4)");
    await a.query("INSERT INTO bills (bill_no, n) VALUES ('IMP-0005', 5), ('IMP-0006', 6), ('IMP-0007', 7)");
    const takeUnused = async (conn: Connection) => {
      for (let tries = 0; tries < 100; tries++) {
        const n = await nextNumber(conn, 'IMP');
        const [r] = await conn.query<any[]>('SELECT 1 FROM bills WHERE bill_no = ?', [`IMP-${String(n).padStart(4, '0')}`]);
        if (!r.length) return n;
      }
      throw new Error('JV_INVALID_INPUT');
    };
    expect(await runTx(a, async () => { const n = await takeUnused(a); await a.query('INSERT INTO bills (bill_no, n) VALUES (?, ?)', [`IMP-${String(n).padStart(4, '0')}`, n]); return n; })).toBe(8);
  });

  it('throughput: one hot counter row, 8 workers, 1,000 bills (shop volume is a few hundred a day)', async () => {
    const conns = await Promise.all(Array.from({ length: 8 }, () => c()));
    const t0 = Date.now();
    await Promise.all(conns.map(async (x) => { for (let i = 0; i < 125; i++) await runTx(x, () => issue(x, 'PERF')); }));
    const ms = Date.now() - t0;
    console.log(`[f] 1000 numbered inserts through one counter row by 8 workers: ${ms} ms (${Math.round(1000 / (ms / 1000))} per second)`);
    const a = await c();
    const [rows] = await a.query<any[]>("SELECT COUNT(*) AS n, MAX(n) AS mx FROM bills WHERE bill_no LIKE 'PERF-%'");
    expect(Number(rows[0].n)).toBe(1000);
    expect(Number(rows[0].mx)).toBe(1000);
  }, 120000);

  it('FINDING (found by the Hostinger proof kit): the FIRST insert of a new series inside a transaction can deadlock when its transaction rolls back while two others wait; a series row created beforehand (autocommit) cannot', async () => {
    const takeFirst = (conn: Connection, series: string) =>
      conn.query('INSERT INTO counters (series, last_value) VALUES (?, LAST_INSERT_ID(1)) ON DUPLICATE KEY UPDATE last_value = LAST_INSERT_ID(last_value + 1)', [series]);
    const takeExisting = (conn: Connection, series: string) =>
      conn.query('UPDATE counters SET last_value = LAST_INSERT_ID(last_value + 1) WHERE series = ?', [series]);
    const scenario = async (series: string, take: (conn: Connection, s: string) => Promise<unknown>) => {
      const [c1, c2, c3] = await Promise.all([c(), c(), c()]);
      await c1.query('START TRANSACTION');
      await take(c1, series); // the first user holds the row, not yet committed
      const waiting = [c2, c3].map(async (x) => {
        await x.query('START TRANSACTION');
        try {
          await take(x, series);
          await x.query('COMMIT');
          return null;
        } catch (e) {
          await x.query('ROLLBACK').catch(() => undefined);
          return (e as DbError).errno ?? null;
        }
      });
      await sleep(400); // both are now waiting for c1
      await c1.query('ROLLBACK'); // the first user fails and gives the number back
      return Promise.all(waiting);
    };
    const naive = await scenario('NAIVE-NEW', takeFirst);
    console.log('[f] new series, first user rolls back, two waiters:', JSON.stringify(naive));
    expect(naive).toContain(ER.DEADLOCK); // the trap is real on this server
    await (await c()).query("INSERT INTO counters (series, last_value) VALUES ('SAFE-NEW', 0) ON DUPLICATE KEY UPDATE series = series"); // autocommit, before any transaction
    const safe = await scenario('SAFE-NEW', takeExisting);
    expect(safe).toEqual([null, null]);
    const [[row]] = await (await c()).query<any[][]>("SELECT last_value FROM counters WHERE series = 'SAFE-NEW'");
    expect((row as any).last_value).toBe('2'); // c1 rolled back, so the two waiters took 1 and 2: no gap
  });
});
