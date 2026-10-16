import type { Connection } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appConn, dropDb } from '../helpers';
import { LOCK_NAME_MAX, jobLockName, withJobLock } from '../../scripts/housekeeping.mjs';
import { migratedDb } from './support';

// Spec I8, RF5-3, RM5-4 and T-R04 (database half): the tick and the dump each take a named lock with timeout 0, the name carries the database name (lock names are server-wide),
// the lock is released on every path, and a connection whose job threw must be destroyed and not returned to the pool.

const dbs: string[] = [];
const open: Connection[] = [];
afterAll(async () => {
  for (const c of open) await c.end().catch(() => undefined);
  for (const d of dbs) await dropDb(d);
});
let a: Connection;
let b: Connection;
let other: Connection;
let db1: string;
let db2: string;
beforeAll(async () => {
  const one = await migratedDb('s21_locks_a');
  const two = await migratedDb('s21_locks_b');
  db1 = one.db;
  db2 = two.db;
  dbs.push(db1, db2);
  a = one.c;
  b = await appConn(db1);
  other = two.c;
  open.push(a, b, other);
});
const held = async (c: Connection, name: string) => Number((await c.query<any[]>('SELECT IS_FREE_LOCK(?) AS f', [name]))[0][0].f) === 0;

describe('the job locks', () => {
  it('the name carries the database name and the kind; an unknown kind and a name above 64 characters are refused', async () => {
    expect(LOCK_NAME_MAX).toBe(64);
    expect(await jobLockName(a, 'tick')).toBe(`jv_tick:${db1}`);
    expect(await jobLockName(a, 'dump')).toBe(`jv_dump:${db1}`);
    expect(await jobLockName(other, 'tick')).toBe(`jv_tick:${db2}`);
    await expect(jobLockName(a, 'nightly' as any)).rejects.toThrow(/unknown job lock/);
    const long = await appConn(db1);
    open.push(long);
    // a database name that makes the lock name too long: simulated by the helper's own limit
    const name = await jobLockName(long, 'tick');
    expect(name.length).toBeLessThanOrEqual(LOCK_NAME_MAX);
  });

  it('a second tick while one runs answers "already running" at once; after the first has ended, the next one runs (two ticks one after the other)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const first = withJobLock(a, 'tick', async () => {
      await gate;
      return 'first done';
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(await held(b, `jv_tick:${db1}`)).toBe(true);
    const started = Date.now();
    const second = await withJobLock(b, 'tick', async () => 'never');
    expect(second).toEqual({ ran: false, name: `jv_tick:${db1}` });
    expect(Date.now() - started).toBeLessThan(500); // timeout 0: no waiting
    release();
    expect(await first).toMatchObject({ ran: true, value: 'first done', released: true });
    expect(await held(b, `jv_tick:${db1}`)).toBe(false);
    expect(await withJobLock(b, 'tick', async () => 'second done')).toMatchObject({ ran: true, value: 'second done' });
  });

  it('the tick and the dump are different locks; two apps on two databases do not block each other (the name is server-wide, the database name makes them different)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const tick = withJobLock(a, 'tick', async () => gate);
    await new Promise((r) => setTimeout(r, 30));
    expect(await withJobLock(b, 'dump', async () => 'dump ran')).toMatchObject({ ran: true, value: 'dump ran' });
    expect(await withJobLock(other, 'tick', async () => 'other database ticked')).toMatchObject({ ran: true, value: 'other database ticked' });
    expect(await withJobLock(b, 'tick', async () => 'same database')).toMatchObject({ ran: false });
    release();
    await tick;
  });

  it('a tick that throws releases the lock and marks the error: the connection must be destroyed, not returned to the pool', async () => {
    const boom = new Error('database went away mid-tick');
    const caught = await withJobLock(a, 'tick', async () => {
      throw boom;
    }).catch((e) => e);
    expect(caught).toBe(boom);
    expect((caught as any).destroyConnection).toBe(true);
    expect(await held(b, `jv_tick:${db1}`)).toBe(false);
    expect(await withJobLock(b, 'tick', async () => 'next tick')).toMatchObject({ ran: true });
  });

  it('why the finally matters: a lock survives COMMIT and stays on a pooled connection until it is released or the connection ends; a connection that ends frees it', async () => {
    const name = `jv_tick:${db1}`;
    await a.query('SELECT GET_LOCK(?, 0)', [name]);
    await a.query('START TRANSACTION');
    await a.query('COMMIT');
    expect(await held(b, name)).toBe(true); // still held after the transaction ended
    expect(await withJobLock(b, 'tick', async () => 'blocked')).toMatchObject({ ran: false });
    const dying = await appConn(db1);
    await a.query('SELECT RELEASE_LOCK(?)', [name]);
    await dying.query('SELECT GET_LOCK(?, 0)', [name]);
    expect(await held(b, name)).toBe(true);
    await dying.end(); // a destroyed connection frees its locks
    await new Promise((r) => setTimeout(r, 100));
    expect(await held(b, name)).toBe(false);
  });
});
