import { randomUUID } from 'node:crypto';
import type { Connection } from 'mysql2/promise';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type DbPool, createDbPool } from '../../src/db/pool';
import { txContext, withRead } from '../../src/db/tx';
import { type Scratch, scratchDatabase } from '../helpers';
import { V, insert } from '../schema/support';
import { dbError, spyOn } from './tx-support';

// T-F03 (C4), the snapshot of the poll: "All resources of one poll are read inside one read-only snapshot (SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, then START TRANSACTION READ ONLY,
// WITH CONSISTENT SNAPSHOT, both allowed to the plan's user, committed at the end of the poll), so a poll never shows a bill without its lines or a payment without its allocation; at READ
// COMMITTED each statement would see its own moment." withRead(ctx, fn, { snapshot: true }) is how the read side asks for it; the HTTP half is in sync-reads.test.ts.

let scratch: Scratch;
let writer: Connection;
let pool: DbPool;
let spy: ReturnType<typeof spyOn>;
const ctx = () => txContext(spy.pool, { requestId: randomUUID() });

beforeAll(async () => {
  scratch = await scratchDatabase('snap', { schema: true });
  writer = await scratch.connect();
}, 120_000);
beforeEach(() => {
  pool = createDbPool(scratch.db);
  spy = spyOn(pool);
});
afterAll(async () => {
  await pool?.end().catch(() => undefined);
  await writer?.end().catch(() => undefined);
  await scratch?.drop();
});

const count = async (db: { rows: (sql: string) => Promise<any[]> }) => Number((await db.rows('SELECT COUNT(*) AS n FROM categories'))[0].n);
const addCategory = () => insert(writer, 'categories', V.category({ prefix: 'SNP' }));

describe('T-F03 (C4) the poll snapshot: withRead(ctx, fn, { snapshot: true })', () => {
  it('two reads in one call see one moment: a row committed between them by another connection is not seen by the second', async () => {
    const before = await count({ rows: (sql) => writer.query<any[]>(sql).then(([r]) => r) });
    let reads = 0;
    spy.intercept = async (e) => {
      if (/FROM categories/.test(e.sql) && ++reads === 2) await addCategory();
    };
    const seen = await withRead(ctx(), async (db) => [await count(db), await count(db)], { snapshot: true });
    spy.intercept = null;
    expect(seen).toEqual([before, before]);
    // and the row is there for the next call
    expect(await withRead(ctx(), (db) => count(db), { snapshot: true })).toBe(before + 1);
  });

  it('negative control: without the option each read has its own moment (READ COMMITTED), so the same race shows a row appearing between two reads', async () => {
    let reads = 0;
    spy.intercept = async (e) => {
      if (/FROM categories/.test(e.sql) && ++reads === 2) await addCategory();
    };
    const seen = await withRead(ctx(), async (db) => [await count(db), await count(db)]);
    spy.intercept = null;
    expect(seen[1]).toBe(seen[0] + 1);
  });

  it('sends SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, then START TRANSACTION READ ONLY, WITH CONSISTENT SNAPSHOT, then the reads, then COMMIT, on one connection', async () => {
    await withRead(ctx(), (db) => count(db), { snapshot: true });
    const mine = spy.sent.filter((s) => !/^SET SESSION /i.test(s.sql));
    expect(new Set(mine.map((s) => s.thread)).size).toBe(1);
    expect(mine.map((s) => s.sql)).toEqual(['SET TRANSACTION ISOLATION LEVEL REPEATABLE READ', 'START TRANSACTION READ ONLY, WITH CONSISTENT SNAPSHOT', 'SELECT COUNT(*) AS n FROM categories', 'COMMIT']);
  });

  it('leaves the connection as it was: READ COMMITTED at the next checkout, and no transaction open', async () => {
    await withRead(ctx(), (db) => count(db), { snapshot: true });
    const after = await withRead(ctx(), async (db) => (await db.rows('SELECT @@session.transaction_isolation AS isolation, @@in_transaction AS tx'))[0]);
    expect({ isolation: after.isolation, tx: Number(after.tx) }).toEqual({ isolation: 'READ-COMMITTED', tx: 0 });
    expect(pool.stats().inUse).toBe(0);
  });

  it('inside the call a transaction is open, and it is closed at the end', async () => {
    const inside = await withRead(ctx(), async (db) => Number((await db.rows('SELECT @@in_transaction AS tx'))[0].tx), { snapshot: true });
    expect(inside).toBe(1);
    const outside = await withRead(ctx(), async (db) => Number((await db.rows('SELECT @@in_transaction AS tx'))[0].tx));
    expect(outside).toBe(0);
  });

  it('an error inside the call rolls the snapshot back, gives the connection back not in a transaction, and is mapped like any read error', async () => {
    const error = await withRead(
      ctx(),
      async (db) => {
        await count(db);
        await db.rows('SELECT nothing_here FROM categories');
      },
      { snapshot: true },
    ).catch((e) => e);
    expect(error).toBeInstanceOf(Error);
    expect(spy.sqls().filter((s) => s === 'ROLLBACK')).toHaveLength(1);
    expect(pool.stats().inUse).toBe(0);
    const after = await withRead(ctx(), async (db) => Number((await db.rows('SELECT @@in_transaction AS tx'))[0].tx));
    expect(after).toBe(0);
  });

  it('a snapshot that cannot be started destroys the connection: the next call gets another one, and the failure is the error of the call', async () => {
    const threads: number[] = [];
    spy.intercept = async (e) => {
      threads.push(e.thread);
      if (/^START TRANSACTION READ ONLY/.test(e.sql)) throw dbError(1205, 'ER_LOCK_WAIT_TIMEOUT', 'Lock wait timeout exceeded');
    };
    const error = await withRead(ctx(), (db) => count(db), { snapshot: true }).catch((e) => e);
    spy.intercept = null;
    expect(error).toMatchObject({ code: 'JV_BUSY' });
    expect(pool.stats().inUse).toBe(0);
    const failedThread = threads.at(-1)!;
    const next = await withRead(ctx(), async (db) => (await db.rows('SELECT CONNECTION_ID() AS id'))[0].id as number);
    expect(Number(next)).not.toBe(failedThread);
  });

  it('a read inside the snapshot may send SELECT and WITH only, as every read', async () => {
    const error = await withRead(ctx(), async (db) => db.rows("INSERT INTO categories (id, name, prefix) VALUES (UUID(), 'x', 'XX')"), { snapshot: true }).catch((e) => e);
    expect(error).toBeInstanceOf(Error);
    expect(String((error as Error).message)).not.toMatch(/INSERT INTO categories/);
  });
});
