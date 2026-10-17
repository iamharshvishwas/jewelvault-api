import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClock } from '../../src/clock';
import { microsOfDbTimestamp } from '../../src/permissions/session';
import { T0, type World, makeWorld } from './cells';
import { getPage, poll } from './sync-support';

// T-D26 clause (API11): "polling does not extend the session, POST /v1/auth/activity does" (U4). The wrapper keeps the paths under /v1/sync/ out of the write of last_seen_at (API05);
// here the real read routes are behind those paths, and the clock is one the test moves.

const time = { micros: T0 };
const advance = (ms: number) => {
  time.micros += BigInt(ms) * 1000n;
};
const HOUR = 3_600_000;
let w: World;

beforeAll(async () => {
  w = await makeWorld({ label: 'syncs', routes: true, clock: createClock(() => time.micros) });
}, 120_000);
afterAll(async () => {
  await w?.close();
});

const lastSeen = async (sessionId: string) => {
  const [rows] = await w.sql.query<any[]>('SELECT last_seen_at FROM sessions WHERE id = ?', [sessionId]);
  return rows[0].last_seen_at as string;
};
const activity = (caller: 'owner') => w.call(caller, 'POST', '/v1/auth/activity');
const asUser = (cookie: string, method: 'GET' | 'POST', url: string, payload?: unknown) =>
  w.app.inject({ method, url, headers: { cookie, ...(method === 'POST' ? { 'x-jv-client': 'web', origin: 'https://app.example.test' } : {}) }, payload: payload as object | undefined });

describe('T-D26 clause (API11): a sync read and a poll never move last_seen_at and never extend the session; POST /v1/auth/activity does', () => {
  it('GET /v1/sync/<resource> and POST /v1/sync/poll leave last_seen_at where it was and send no write for the session; activity moves it to the clock', async () => {
    const sessionId = w.fixtures.owner.sessionId;
    const first = await lastSeen(sessionId);
    advance(6 * HOUR);
    const from = w.spy.sent.length;
    for (const name of ['users', 'categories', 'settings']) expect((await getPage(w, 'owner', name)).statusCode, name).toBe(200);
    expect((await poll(w, 'owner', { cursors: { users: null, customers: null } })).statusCode).toBe(200);
    expect(await lastSeen(sessionId)).toBe(first);
    expect(w.spy.sqls().slice(from).filter((s) => /^UPDATE sessions/i.test(s))).toEqual([]);
    expect((await activity('owner')).statusCode).toBe(200);
    const moved = await lastSeen(sessionId);
    expect(moved).not.toBe(first);
    expect(microsOfDbTimestamp(moved)).toBeGreaterThanOrEqual(T0 + BigInt(6 * HOUR) * 1000n);
  });

  it('a session that is only polled ends after 12 hours of silence however often it polls; one that sent activity 6 hours in is alive at 12 hours 1 minute', async () => {
    time.micros = T0;
    const b = await w.addUser({ role: 'owner' }); // fixtures are made relative to T0: last seen one minute before it
    const a = await w.addUser({ role: 'owner' });
    for (let h = 1; h <= 11; h++) {
      advance(HOUR);
      expect((await asUser(b.cookie, 'GET', '/v1/sync/users')).statusCode, `poll at ${h} h`).toBe(200);
      expect((await asUser(b.cookie, 'POST', '/v1/sync/poll', { cursors: { users: null } })).statusCode, `poll at ${h} h`).toBe(200);
      if (h === 6) expect((await asUser(a.cookie, 'POST', '/v1/auth/activity')).statusCode).toBe(200);
    }
    advance(HOUR - 60_000 + 120_000); // 12 h 01 m after the fixtures were made (the sessions were last seen at T0 minus one minute)
    const dead = await asUser(b.cookie, 'GET', '/v1/sync/users');
    expect(dead.statusCode).toBe(401);
    expect(JSON.parse(dead.body).error.code).toBe('JV_SESSION_EXPIRED');
    const deadPoll = await asUser(b.cookie, 'POST', '/v1/sync/poll', { cursors: { users: null } });
    expect(deadPoll.statusCode).toBe(401);
    const alive = await asUser(a.cookie, 'POST', '/v1/sync/poll', { cursors: { users: null } });
    expect(alive.statusCode).toBe(200);
  });
});
