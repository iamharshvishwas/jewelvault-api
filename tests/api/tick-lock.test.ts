import type { Connection } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTx } from '../../src/db/tx';
import { sleep } from '../helpers';
import { type TickWorld, body, gate, tickWorld, toyPhase } from './tick-support';

// PT-T1 (API33), one run at a time (I8, RF5-3, RM5-4): the tick takes ONE pool connection and `GET_LOCK('jv_tick:<database>', 0)` on it, answers "already running" at once if the lock is taken,
// calls RELEASE_LOCK in a `finally` and DESTROYS the connection instead of returning it to the pool if anything throws (a lock belongs to the connection, and a pooled connection lives on).
//
// The phases here are toys that the test holds still: the lock is the thing under test, not the work.

const lockName = (w: TickWorld) => `jv_tick:${w.database}`;
const usedBy = async (c: Connection, name: string): Promise<number | null> => {
  const [rows] = await c.query<any[]>('SELECT IS_USED_LOCK(?) AS id', [name]);
  return rows[0].id === null ? null : Number(rows[0].id);
};
const isFree = async (c: Connection, name: string) => Number((await c.query<any[]>('SELECT IS_FREE_LOCK(?) AS f', [name]))[0][0].f) === 1;
/** Waits until the server no longer lists a connection (a destroyed one closes its socket; the server notices a moment later). */
async function gone(root: Connection, threadId: number): Promise<boolean> {
  for (let i = 0; i < 40; i++) {
    const [rows] = await root.query<any[]>('SELECT COUNT(*) AS n FROM information_schema.PROCESSLIST WHERE ID = ?', [threadId]);
    if (Number(rows[0].n) === 0) return true;
    await sleep(50);
  }
  return false;
}

describe('PT-T1 one tick at a time: the lock jv_tick:<database> on the tick\'s own pooled connection', () => {
  let g = gate();
  let holding = false;
  let seen: { me: number; holder: number | null; user: string; limitSeconds: number; txThread: number; inUse: number } | undefined;
  let w: TickWorld;
  const probe = toyPhase('probe', 'every_tick', async (ctx) => {
    const [rows] = await ctx.conn.query<any[]>('SELECT CONNECTION_ID() AS me, CURRENT_USER() AS user, IS_USED_LOCK(?) AS holder, @@session.max_statement_time AS limit_s', [lockName(w)]);
    // a transaction of the phase runs on this very connection (withTx over the tick's pool of one), and takes no second place in the pool
    const txThread = await withTx(ctx.txContext(), async (tx) => Number((await tx.rows<{ me: number }>('SELECT CONNECTION_ID() AS me'))[0].me));
    seen = { me: Number(rows[0].me), holder: rows[0].holder === null ? null : Number(rows[0].holder), user: String(rows[0].user), limitSeconds: Number(rows[0].limit_s), txThread, inUse: w.world.app.db!.stats().inUse };
    return { complete: true };
  });
  const held = toyPhase('held', 'every_tick', async () => {
    if (holding) await g.hold();
    return { complete: true };
  });
  beforeAll(async () => {
    w = await tickWorld('ticklock', { phases: [probe, held] });
  }, 120_000);
  afterAll(async () => {
    g.open();
    await w?.close();
  });

  it('GET_LOCK runs on a pooled connection of the ten-box user: while the phase runs the lock is held by the very connection the phase was given, which belongs to the scratch (ten-box) user, and it is free when the tick has ended', async () => {
    expect((await w.tick()).statusCode).toBe(200);
    expect(seen).toBeDefined();
    expect(seen!.holder).toBe(seen!.me);
    expect(seen!.user.startsWith(`${w.world.scratch.user}@`)).toBe(true);
    expect(seen!.limitSeconds).toBe(20); // the tick's statement limit (I8, S11) ...
    expect(seen!.txThread).toBe(seen!.me); // ... a transaction of the phase is on the same connection ...
    expect(seen!.inUse).toBe(1); // ... and the tick holds one place of the pool, not two
    expect(await isFree(w.sql, lockName(w))).toBe(true); // released when the tick ended
    const next = await w.world.app.db!.checkout(); // the connection goes back with its 20 s, and the next checkout sets the application's 8 s again
    try {
      expect(Number((await next.query<any[]>('SELECT @@session.max_statement_time AS m'))[0][0].m)).toBe(8);
    } finally {
      next.release();
    }
  });

  it('a second tick while one runs answers "already running" at once, runs no phase, and gives its connection back (release, not destroy)', async () => {
    g = gate();
    holding = true;
    const first = w.tick();
    await g.arrived;
    const runsBefore = held.runs.length;
    expect(await usedBy(w.sql, lockName(w))).not.toBeNull(); // the lock carries the database name

    const mark = w.conns.length;
    const started = Date.now();
    const second = await w.tick();
    expect(Date.now() - started).toBeLessThan(2000); // at once: GET_LOCK with timeout 0
    expect(second.statusCode).toBe(200);
    expect(body(second)).toEqual({ status: 'already_running', run_date: null, phases: [] });
    expect(held.runs).toHaveLength(runsBefore);
    expect(w.conns.slice(mark).map((c) => c.kind)).toEqual(['release']);

    g.open();
    holding = false;
    const done = await first;
    expect(done.statusCode).toBe(200);
    expect(body(done)).toMatchObject({ status: 'ok', phases: [{ job: 'probe', outcome: 'ran' }, { job: 'held', outcome: 'ran' }] });
    expect(await isFree(w.sql, lockName(w))).toBe(true);
  });

  it('a second tick after the first has ended runs (two ticks one after the other on a pool of 8 both run)', async () => {
    const before = held.runs.length;
    expect((await w.tick()).statusCode).toBe(200);
    expect((await w.tick()).statusCode).toBe(200);
    expect(held.runs).toHaveLength(before + 2);
    expect(await isFree(w.sql, lockName(w))).toBe(true);
  });

  it('a lock held by somebody else (another connection of the same database): "already running", nothing ran, the tick\'s connection is released, and the lock is still theirs', async () => {
    const other = await w.world.scratch.connect();
    try {
      const [got] = await other.query<any[]>('SELECT GET_LOCK(?, 0) AS got', [lockName(w)]);
      expect(Number(got[0].got)).toBe(1);
      const before = held.runs.length;
      const mark = w.conns.length;
      const res = await w.tick();
      expect(body(res).status).toBe('already_running');
      expect(held.runs).toHaveLength(before);
      expect(w.conns.slice(mark).map((c) => c.kind)).toEqual(['release']);
      expect(await usedBy(w.sql, lockName(w))).toBe(Number((await other.query<any[]>('SELECT CONNECTION_ID() AS id'))[0][0].id)); // theirs, not released by the tick
    } finally {
      await other.end();
    }
    for (let i = 0; i < 40 && !(await isFree(w.sql, lockName(w))); i++) await sleep(50); // the server frees the lock of a connection that ended a moment after it closed
    expect(await isFree(w.sql, lockName(w))).toBe(true);
  });
});

describe('PT-T1 two apps on two databases of one server both run (the lock name carries the database name)', () => {
  it('both ticks are inside their phase at the same moment, each holding its own lock', async () => {
    const ga = gate();
    const gb = gate();
    const pa = toyPhase('held', 'every_tick', async () => (await ga.hold(), { complete: true }));
    const pb = toyPhase('held', 'every_tick', async () => (await gb.hold(), { complete: true }));
    const a = await tickWorld('ticklocka', { phases: [pa] });
    const b = await tickWorld('ticklockb', { phases: [pb] });
    try {
      expect(a.database).not.toBe(b.database);
      const ta = a.tick();
      const tb = b.tick();
      await Promise.all([ga.arrived, gb.arrived]); // neither answered "already running": both are at work
      const root = await a.world.scratch.root();
      try {
        const [rows] = await root.query<any[]>('SELECT IS_USED_LOCK(?) AS a, IS_USED_LOCK(?) AS b', [lockName(a), lockName(b)]);
        expect(rows[0].a).not.toBeNull();
        expect(rows[0].b).not.toBeNull();
        expect(rows[0].a).not.toBe(rows[0].b);
      } finally {
        await root.end();
      }
      ga.open();
      gb.open();
      const [ra, rb] = await Promise.all([ta, tb]);
      expect([body(ra).status, body(rb).status]).toEqual(['ok', 'ok']);
      expect([pa.runs.length, pb.runs.length]).toEqual([1, 1]);
    } finally {
      ga.open();
      gb.open();
      await Promise.all([a.close(), b.close()]);
    }
  }, 120_000);
});

describe('PT-T1 a tick that throws destroys its connection and releases its lock', () => {
  let w: TickWorld;
  let explode = true;
  let thread = 0;
  const thrower = toyPhase('thrower', 'every_tick', async (ctx) => {
    thread = ctx.conn.threadId;
    if (explode) throw new Error('the phase broke');
    return { complete: true };
  });
  const after = toyPhase('after', 'every_tick');
  beforeAll(async () => {
    w = await tickWorld('tickthrow', { phases: [thrower, after] });
  }, 120_000);
  afterAll(async () => {
    await w?.close();
  });

  it('the phase throws: the answer is an error, the connection is destroyed and not given back, the lock is free at once, and the server drops the connection', async () => {
    const mark = w.conns.length;
    const res = await w.tick();
    expect(res.statusCode).toBe(500);
    expect((res.json() as any).error.code).toBe('JV_INTERNAL');
    expect(JSON.stringify(res.json())).not.toContain('the phase broke'); // A14: the cause is for the log
    const events = w.conns.slice(mark).filter((c) => c.thread === thread);
    expect(events.map((c) => c.kind)).toContain('destroy'); // destroyed ...
    expect(events.map((c) => c.kind)).not.toContain('release'); // ... never given back to the pool
    expect(await isFree(w.sql, lockName(w))).toBe(true);
    const root = await w.world.scratch.root();
    try {
      expect(await gone(root, thread)).toBe(true);
    } finally {
      await root.end();
    }
  });

  it('the other phases of the tick still ran, the failed one is marked failed (retried by update), and the next tick runs on a new connection and ends well', async () => {
    expect(after.runs.length).toBe(1);
    const row = (await w.runs('thrower'))[0];
    expect(row.status).toBe('failed');
    expect(row.detail.error.name).toBe('Error');
    explode = false;
    const mark = w.conns.length;
    const res = await w.tick();
    expect(res.statusCode).toBe(200);
    expect(body(res).phases).toEqual([
      { job: 'thrower', outcome: 'ran' },
      { job: 'after', outcome: 'ran' },
    ]);
    expect(thread).not.toBe(0);
    expect(w.conns.slice(mark).map((c) => c.kind)).toEqual(['release']);
    expect((await w.runs('thrower'))).toHaveLength(1); // the same row: failed went back to running and ended ok
    expect((await w.runs('thrower'))[0].status).toBe('ok');
  });

  it('a connection that is killed under the phase: the tick answers an error, nothing hangs, the lock is free (it went with the connection), and the next tick runs', async () => {
    let victim = 0;
    const killer = toyPhase('killer', 'every_tick', async (ctx) => {
      victim = ctx.conn.threadId;
      const root = await w.world.scratch.root();
      try {
        await root.query('KILL CONNECTION ?', [victim]);
      } finally {
        await root.end();
      }
      await ctx.conn.query('SELECT 1'); // the connection is gone: this throws
      return { complete: true };
    });
    const k = await tickWorld('tickkill', { phases: [killer, toyPhase('later', 'every_tick')] });
    try {
      const mark = k.conns.length;
      const res = await k.tick();
      expect(res.statusCode).toBe(503);
      expect((res.json() as any).error.code).toBe('JV_BUSY');
      const kinds = k.conns.slice(mark).filter((c) => c.thread === victim).map((c) => c.kind);
      expect(kinds).toContain('destroy');
      expect(kinds).not.toContain('release');
      expect(await isFree(k.sql, `jv_tick:${k.database}`)).toBe(true);
    } finally {
      await k.close();
    }
  }, 120_000);
});
