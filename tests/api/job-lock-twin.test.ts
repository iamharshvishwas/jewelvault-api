import type { Connection } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LOCK_NAME_MAX as scriptMax, jobLockName as scriptName, withJobLock as scriptLock } from '../../scripts/housekeeping.mjs';
import { LOCK_NAME_MAX as srcMax, jobLockName as srcName, withJobLock as srcLock } from '../../src/jobs/lock';
import { type Scratch, scratchDatabase } from '../helpers';

// PT-T1 (API33): src/jobs/lock.ts is the TypeScript twin of `jobLockName` and `withJobLock` in scripts/housekeeping.mjs (MB06). src cannot import scripts/*.mjs (the build's rootDir is src), so the
// tick uses the twin, and this test keeps the two equal: the same names, the same statements in the same order, the same answers on a real database, and the same marking of an error that must
// not go back to the pool (`destroyConnection`). A change to one is a change to the other.

type Lock = typeof srcLock;
const IMPLEMENTATIONS: [string, Lock, typeof srcName, number][] = [
  ['scripts/housekeeping.mjs', scriptLock as unknown as Lock, scriptName as unknown as typeof srcName, scriptMax as number],
  ['src/jobs/lock.ts', srcLock, srcName, srcMax],
];

/** A connection that answers from a script and remembers what it was asked. */
function fakeConn(answers: { database?: string | null; got?: number; released?: number | 'throw' }) {
  const sent: { sql: string; params: unknown[] }[] = [];
  return {
    sent,
    conn: {
      async query(sql: string, params: unknown[] = []) {
        sent.push({ sql, params });
        if (sql.includes('DATABASE()')) return [[{ db: answers.database === undefined ? 'jv_main' : answers.database }]];
        if (sql.includes('GET_LOCK')) return [[{ got: answers.got ?? 1 }]];
        if (sql.includes('RELEASE_LOCK')) {
          if (answers.released === 'throw') throw Object.assign(new Error('Connection lost'), { code: 'PROTOCOL_CONNECTION_LOST', fatal: true });
          return [[{ released: answers.released ?? 1 }]];
        }
        throw new Error(`unexpected statement ${sql}`);
      },
    } as unknown as Connection,
  };
}

describe('PT-T1 src/jobs/lock.ts equals withJobLock and jobLockName of scripts/housekeeping.mjs (MB06)', () => {
  let scratch: Scratch;
  let holder: Connection;
  let probe: Connection;
  beforeAll(async () => {
    scratch = await scratchDatabase('locktwin');
    holder = await scratch.connect();
    probe = await scratch.connect();
  }, 60_000);
  afterAll(async () => {
    await holder?.end();
    await probe?.end();
    await scratch?.drop();
  });

  it('the longest lock name is the same, 64', () => {
    expect([scriptMax, srcMax]).toEqual([64, 64]);
  });

  for (const [label, withLock, lockName, max] of IMPLEMENTATIONS) {
    describe(label, () => {
      it('the name of a lock is jv_<kind>:<database>; an unknown kind, no database and a name over the maximum are refused', async () => {
        expect(await lockName(fakeConn({}).conn, 'tick')).toBe('jv_tick:jv_main');
        expect(await lockName(fakeConn({ database: 'jv_staging' }).conn, 'dump')).toBe('jv_dump:jv_staging');
        await expect(lockName(fakeConn({}).conn, 'other' as 'tick')).rejects.toThrow(/unknown job lock/);
        await expect(lockName(fakeConn({ database: null }).conn, 'tick')).rejects.toThrow(/no database selected/);
        await expect(lockName(fakeConn({ database: 'd'.repeat(max) }).conn, 'tick')).rejects.toThrow(/longer than 64 characters/);
        expect(await lockName(fakeConn({ database: 'd'.repeat(max - 'jv_tick:'.length) }).conn, 'tick')).toHaveLength(max);
      });

      it('on a real database: free lock → ran, value returned, lock released; taken by another connection → { ran: false } at once and fn not called; fn throws → the error comes back marked destroyConnection and the lock is free', async () => {
        const name = `jv_tick:${scratch.database}`;
        const free = async () => Number((await probe.query<any[]>('SELECT IS_FREE_LOCK(?) AS f', [name]))[0][0].f) === 1;
        let inside: boolean | undefined;
        const ran = await withLock(holder as never, 'tick', async () => {
          inside = !(await free());
          return 42;
        });
        expect(ran).toEqual({ ran: true, name, value: 42, released: true });
        expect(inside).toBe(true);
        expect(await free()).toBe(true);

        const got = Number((await probe.query<any[]>('SELECT GET_LOCK(?, 0) AS got', [name]))[0][0].got);
        expect(got).toBe(1);
        let called = false;
        const refused = await withLock(holder as never, 'tick', async () => {
          called = true;
        });
        expect(refused).toEqual({ ran: false, name });
        expect(called).toBe(false);
        await probe.query('SELECT RELEASE_LOCK(?)', [name]);

        const boom = new Error('the work broke');
        const caught = await withLock(holder as never, 'tick', async () => {
          throw boom;
        }).catch((e) => e);
        expect(caught).toBe(boom);
        expect((caught as { destroyConnection?: boolean }).destroyConnection).toBe(true);
        expect(await free()).toBe(true); // RELEASE_LOCK ran in the finally
      });

      it('the statements, in order: the database name, GET_LOCK with the name and timeout 0, RELEASE_LOCK with the name', async () => {
        const f = fakeConn({});
        await withLock(f.conn as never, 'dump', async () => 1);
        expect(f.sent.map((s) => [s.sql.replace(/\s+/g, ' '), s.params])).toEqual([
          ['SELECT DATABASE() AS db', []],
          ['SELECT GET_LOCK(?, 0) AS got', ['jv_dump:jv_main']],
          ['SELECT RELEASE_LOCK(?) AS released', ['jv_dump:jv_main']],
        ]);
      });

      it('a lock that could not be released (RELEASE_LOCK answers 0) is an error marked destroyConnection; a connection that is gone at RELEASE_LOCK means the lock went with it (no error); an error of fn is rethrown after RELEASE_LOCK', async () => {
        const stuck = await withLock(fakeConn({ released: 0 }).conn as never, 'tick', async () => 1).catch((e) => e);
        expect(stuck).toBeInstanceOf(Error);
        expect((stuck as Error).message).toMatch(/could not be released/);
        expect((stuck as { destroyConnection?: boolean }).destroyConnection).toBe(true);

        const gone = await withLock(fakeConn({ released: 'throw' }).conn as never, 'tick', async () => 7);
        expect(gone).toMatchObject({ ran: true, value: 7, released: true });

        const f = fakeConn({});
        const failure = new Error('x');
        await expect(
          withLock(f.conn as never, 'tick', async () => {
            throw failure;
          }),
        ).rejects.toBe(failure);
        expect(f.sent.at(-1)!.sql).toContain('RELEASE_LOCK');
      });
    });
  }
});
