import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { passwords } from '../../src/auth/password';
import { installLoginThrottle } from '../../src/auth/throttle';
import { createHousekeepingPhase } from '../../src/jobs/housekeeping';
import { heartbeatPhase } from '../../src/jobs/phases';
import { csrfHeaders } from './support';
import { type TickWorld, at, tickWorld, toyPhase } from './tick-support';

// T-R04 (I8, L6, D24): the `housekeeping` phase of the tick, and the two clauses it proves for other tests.
//   T-C05 clause (L6): "the nightly job empties the result of a request row older than 90 days and a repeat of that key is then refused": the row stays (S7 allows no delete), only `result` is emptied,
//   a repeat is JV_INVALID_INPUT "this request is too old to repeat" and never runs again.
//   T-D30 clause (D24): "an attack of one hour followed by five quiet hours has its summary in audit_log after the next tick without any further failed login".
// The emptying is nightly work (once for a business date, not before 02:00 Asia/Kolkata); the closing of finished login-failure hours is at every tick. The clock only moves forward (S5), so each
// describe is one story told in order.

const outcomes = (res: { json(): unknown }) => Object.fromEntries(((res.json() as any).phases as { job: string; outcome: string }[]).map((p) => [p.job, p.outcome]));
const set = (w: TickWorld, iso: string) => {
  w.time.time.micros = at(iso);
};

describe('T-R04 / T-C05 clause: housekeeping empties the result of a request row older than 90 days (L6), once a night, and a repeat of the key is then refused', () => {
  let w: TickWorld;
  const bodies = new Map<string, Record<string, unknown>>();
  let n = 0;

  /** POST /v1/customers (X6, a creating route) under a key; the row of sys_idempotency is the one L6 is about */
  const create = async (key: string = randomUUID(), payload?: Record<string, unknown>) => {
    const sent = payload ?? bodies.get(key) ?? { name: 'Meera Soni', mobile: `98${String(20_000_000 + ++n).padStart(8, '0')}` };
    bodies.set(key, sent);
    return w.world.call('owner', 'POST', '/v1/customers', { payload: sent, headers: { 'idempotency-key': key } });
  };
  const rowOf = async (key: string) => (await w.sql.query<any[]>("SELECT fn, actor, args_hash, claim_token, result, DATE_FORMAT(created_at, '%Y-%m-%d %H:%i:%s.%f') AS created_at FROM sys_idempotency WHERE request_id = ?", [key]))[0][0];
  const total = async (table: string) => Number((await w.sql.query<any[]>(`SELECT COUNT(*) AS n FROM ${table}`))[0][0].n);
  const age = (key: string, createdAt: string) => w.sql.query('UPDATE sys_idempotency SET created_at = ? WHERE request_id = ?', [createdAt, key]);
  const updatesOfIdempotency = (from: number) => w.world.spy.sqls().slice(from).filter((s) => /^\s*UPDATE sys_idempotency/i.test(s));
  const housekeepingEvents = async () => (await w.jobEvents()).filter((e) => e.new_row.job === 'housekeeping');

  // "now" of the first tick is 17 Oct 2026 10:00 UTC (15:30 in Asia/Kolkata); 90 days before it is 19 Jul 2026 10:00 UTC
  const CUTOFF = '2026-07-19 10:00:00.000000';
  let kOld = '';
  let kEdge = '';
  let kRecent = '';
  let kAncient = '';

  beforeAll(async () => {
    w = await tickWorld('tickhk', { routes: true, seeds: true });
    [kOld, kEdge, kRecent, kAncient] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    for (const k of [kOld, kEdge, kRecent, kAncient]) expect((await create(k)).statusCode).toBe(201);
    await age(kOld, '2026-07-19 09:59:59.000000'); // 90 days and one second old
    await age(kEdge, '2026-07-19 10:00:01.000000'); // 89 days 23 hours 59 minutes 59 seconds old: not older than 90 days
    await age(kAncient, '2026-01-01 00:00:00.000000');
  }, 180_000);
  afterAll(async () => {
    await w?.close();
  });

  it('before the job has run, an old key is still answered from its stored result: it is the nightly job that makes the repeat refused (L5, L6)', async () => {
    const again = await create(kOld);
    expect(again.statusCode, again.body).toBe(201);
    expect(again.headers['idempotent-replay']).toBe('true');
    expect((await rowOf(kOld)).result).not.toBeNull();
  });

  it('the tick empties `result` of the rows older than 90 days and of no other: the row itself stays (S7), nothing else in it changes', async () => {
    const before = { old: await rowOf(kOld), edge: await rowOf(kEdge), recent: await rowOf(kRecent), ancient: await rowOf(kAncient) };
    const rows = await total('sys_idempotency');
    const customers = await total('customers');
    const res = await w.tick();
    expect(res.statusCode, res.body).toBe(200);
    expect(outcomes(res).housekeeping).toBe('ran');

    expect(await total('sys_idempotency')).toBe(rows); // nothing is deleted
    for (const [name, key, emptied] of [['old', kOld, true], ['ancient', kAncient, true], ['edge', kEdge, false], ['recent', kRecent, false]] as const) {
      const after = await rowOf(key);
      const was = before[name];
      expect(after.result === null, name).toBe(emptied);
      expect({ ...after, result: null }, `${name}: only the result changes`).toEqual({ ...was, result: null });
      if (!emptied) expect(after.result, name).toEqual(was.result);
    }
    expect(await total('customers')).toBe(customers);
  });

  it('a repeat of an emptied key is refused with JV_INVALID_INPUT "this request is too old to repeat" and is never run again, also with another body; a key that is not old is still a replay', async () => {
    const customers = await total('customers');
    const claims = await total('sys_idempotency');
    for (const [label, key, payload] of [['same body', kOld, undefined], ['another body', kOld, { name: 'Someone Else', mobile: '9811111111' }], ['ancient', kAncient, undefined]] as const) {
      const res = await create(key, payload);
      const e = (res.json() as any).error;
      expect([label, res.statusCode, e.code], res.body).toEqual([label, 422, 'JV_INVALID_INPUT']);
      // the same body under an emptied key says why in the words of L6; another body under it is also refused, and the claim says (as it always did) that the key belongs to another request
      if (label !== 'another body') expect(e.message, label).toMatch(/too old to repeat/i);
      expect(e.details).toEqual({ field: 'Idempotency-Key' });
      expect(res.headers['idempotent-replay']).toBeUndefined();
    }
    expect(await total('customers'), 'a refused repeat made a customer').toBe(customers);
    expect(await total('sys_idempotency'), 'a refused repeat made a claim').toBe(claims);

    const edge = await create(kEdge);
    expect([edge.statusCode, edge.headers['idempotent-replay']]).toEqual([201, 'true']); // 89 days 23:59:59 old: not older than 90 days
    const recent = await create(kRecent);
    expect([recent.statusCode, recent.headers['idempotent-replay']]).toEqual([201, 'true']);
  });

  it('the run writes ONE event row (role job) that says how many results it emptied, and nothing that names a key or a customer', async () => {
    const events = await housekeepingEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ actor: null, actor_role: 'job', table_name: 'sys_job_runs' });
    expect(events[0].new_row).toMatchObject({ event: 'job_phase', job: 'housekeeping', run_date: '2026-10-17', outcome: 'ok', idempotency_emptied: 2 });
    const text = JSON.stringify(events[0]);
    for (const key of [kOld, kEdge, kRecent, kAncient]) expect(text).not.toContain(key);
  });

  it('the emptying is nightly work: once for a business date. A row that turns 91 days old during the day waits for the next night; a tick with nothing to do writes no event', async () => {
    await age(kEdge, '2026-07-19 09:00:00.000000'); // now 91 days and 1 hour old
    set(w, '2026-10-17T10:30:00Z');
    const sent = w.world.spy.sqls().length;
    const events = (await housekeepingEvents()).length;
    const res = await w.tick();
    expect(outcomes(res).housekeeping).toBe('ran');
    expect(updatesOfIdempotency(sent), 'the emptying ran again on the same business date').toEqual([]);
    expect((await rowOf(kEdge)).result).not.toBeNull();
    expect((await housekeepingEvents()).length, 'a tick that did nothing wrote an event').toBe(events);
    // the row of the phase is one for the date, and it moves at every tick
    const runs = await w.runs('housekeeping');
    expect(runs.map((r) => [r.run_date, r.status])).toEqual([['2026-10-17', 'ok']]);
    expect(runs[0].detail).toMatchObject({ idempotency: { date: '2026-10-17', emptied: 2 } });
  });

  it('a new business date at 01:59:59.5 in Asia/Kolkata does not empty anything (nightly work waits for 02:00); at 02:00:00 it does, once', async () => {
    set(w, '2026-10-17T20:29:59.500Z'); // 01:59:59.5 on 18 Oct
    const sent = w.world.spy.sqls().length;
    expect(outcomes(await w.tick()).housekeeping).toBe('ran'); // the phase is due at every tick: it closes login hours at any time
    expect(updatesOfIdempotency(sent)).toEqual([]);
    expect((await rowOf(kEdge)).result).not.toBeNull();

    set(w, '2026-10-17T20:30:00.000Z'); // 02:00:00.000
    expect(outcomes(await w.tick()).housekeeping).toBe('ran');
    expect(updatesOfIdempotency(sent).length).toBeGreaterThan(0);
    expect((await rowOf(kEdge)).result).toBeNull();
    expect(await create(kEdge)).toMatchObject({ statusCode: 422 });
    const events = await housekeepingEvents();
    expect(events.map((e) => [e.new_row.run_date, e.new_row.idempotency_emptied])).toEqual([['2026-10-17', 2], ['2026-10-18', 1]]);

    const again = w.world.spy.sqls().length;
    set(w, '2026-10-17T21:00:00Z');
    await w.tick();
    expect(updatesOfIdempotency(again), 'a second run of the same night').toEqual([]);
  });

  it('a housekeeping that fails is marked failed with the error\'s class and code, the tick answers an error, and the other phases still ran; the next tick runs it again', async () => {
    const root = await w.world.scratch.root();
    try {
      await root.query(`USE \`${w.database}\``);
      set(w, '2026-10-18T21:30:00Z'); // 03:00 on 19 Oct, a new business date: L6 is due
      await root.query('RENAME TABLE sys_idempotency TO sys_idempotency_away');
      let bad;
      try {
        bad = await w.tick();
      } finally {
        await root.query('RENAME TABLE sys_idempotency_away TO sys_idempotency');
      }
      expect(bad.statusCode).toBe(500);
      const failed = (await w.runs('housekeeping')).find((r) => r.run_date === '2026-10-19')!;
      expect(failed.status).toBe('failed');
      expect(failed.detail.error).toBeDefined();
      expect((await w.runs('photo_copy')).find((r) => r.run_date === '2026-10-19')?.status, 'the phase after it still ran').toBe('ok');

      set(w, '2026-10-18T21:31:00Z');
      const good = await w.tick();
      expect(good.statusCode).toBe(200);
      const retried = (await w.runs('housekeeping')).filter((r) => r.run_date === '2026-10-19');
      expect(retried).toHaveLength(1);
      expect(retried[0].id).toBe(failed.id);
      expect(retried[0].status).toBe('ok');
    } finally {
      await root.end();
    }
  });
});

describe('T-R04 housekeeping in slices of its own: the emptying works in batches, and a phase that did nothing can say so', () => {
  let w: TickWorld;
  const quiet = toyPhase('t_quiet', 'daily', () => ({ complete: true, quiet: true }));
  const loud = toyPhase('t_loud', 'daily', () => ({ complete: true }));
  beforeAll(async () => {
    w = await tickWorld('tickhkb', { phases: [createHousekeepingPhase({ batch: 2 }), quiet, loud] });
  }, 120_000);
  afterAll(async () => {
    await w?.close();
  });

  const claim = (createdAt: string) =>
    w.sql.query('INSERT INTO sys_idempotency (request_id, fn, actor, args_hash, claim_token, result, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [randomUUID(), 'create_bill', randomUUID(), 'a'.repeat(64), randomUUID(), JSON.stringify({ ok: true }), createdAt]);

  it('five old rows are emptied two statements\' worth at a time until none is left; the recent row and a row that has no result are left alone', async () => {
    for (let i = 0; i < 5; i++) await claim(`2026-05-0${i + 1} 00:00:00.000000`);
    await claim('2026-10-16 00:00:00.000000');
    await w.sql.query("INSERT INTO sys_idempotency (request_id, fn, actor, args_hash, claim_token, result, created_at) VALUES (?, 'x', ?, ?, ?, NULL, '2026-01-01 00:00:00.000000')", [randomUUID(), randomUUID(), 'b'.repeat(64), randomUUID()]);
    const sent = w.world.spy.sent.length;
    const res = await w.tick();
    expect(res.statusCode, res.body).toBe(200);
    const updates = w.world.spy.sent.slice(sent).filter((s) => /^\s*UPDATE sys_idempotency/i.test(s.sql));
    expect(updates.length).toBeGreaterThanOrEqual(3); // 2 + 2 + 1
    const left = (await w.sql.query<any[]>('SELECT COUNT(*) AS n FROM sys_idempotency WHERE result IS NOT NULL'))[0][0].n;
    expect(Number(left)).toBe(1);
    const events = (await w.jobEvents()).filter((e) => e.new_row.job === 'housekeeping');
    expect(events[0].new_row.idempotency_emptied).toBe(5);
  });

  it('a phase that says it was quiet writes its row in sys_job_runs but no event row; one that does not say so writes its event (T-D14 of the tick)', async () => {
    const events = await w.jobEvents();
    expect(events.filter((e) => e.new_row.job === 't_quiet')).toHaveLength(0);
    expect(events.filter((e) => e.new_row.job === 't_loud')).toHaveLength(1);
    expect((await w.runs('t_quiet')).map((r) => r.status)).toEqual(['ok']);
  });
});

describe('T-R04 / T-D30 clause: an attack of one hour followed by five quiet hours has its summary in audit_log after the next tick, without any further failed login (D24)', () => {
  let w: TickWorld; // the application's own phases

  const attempt = async (world: TickWorld, email: string) => {
    const res = await world.world.app.inject({ method: 'POST', url: '/v1/auth/login', headers: { ...csrfHeaders(), 'x-real-ip': '198.18.7.7' }, payload: { email, password: 'a wrong password' } });
    expect(res.statusCode, res.body).toBe(401);
  };
  const summaries = async (world: TickWorld) =>
    (await world.sql.query<any[]>("SELECT row_id, actor, actor_role, request_id, new_row FROM audit_log WHERE table_name = 'login_failures' AND action = 'event' ORDER BY id"))[0].map((r) => ({
      ...r,
      new_row: typeof r.new_row === 'string' ? JSON.parse(r.new_row) : r.new_row,
    }));

  beforeAll(async () => {
    await passwords.dummyHash();
    vi.spyOn(passwords, 'verify').mockImplementation(async () => false); // the load is the point, not the hashing
    w = await tickWorld('tickhk30', { routes: true, seeds: true });
    installLoginThrottle(w.world.app, { sleep: async () => undefined });
  }, 180_000);
  afterAll(async () => {
    vi.restoreAllMocks();
    await w?.close();
  });

  it('three failed logins in the hour 10:00 to 11:00 UTC leave no summary yet; a tick inside that hour does not close it either', async () => {
    for (const [minute, who] of [['10:05', 'a'], ['10:20', 'b'], ['10:40', 'c']] as const) {
      set(w, `2026-10-17T${minute}:00Z`);
      await attempt(w, `nobody-${who}@example.test`);
    }
    expect(await summaries(w)).toEqual([]);
    set(w, '2026-10-17T10:59:59.900Z');
    expect((await w.tick()).statusCode).toBe(200);
    expect(await summaries(w), 'the hour had not ended').toEqual([]);
  });

  it('five quiet hours later the next tick writes the summary of the hour: one login_failures event, role job, the count of the hour, no further failed login needed', async () => {
    const before = Number((await w.sql.query<any[]>('SELECT COUNT(*) AS n FROM sys_login_attempts'))[0][0].n);
    set(w, '2026-10-17T16:05:00Z'); // hours 11, 12, 13, 14 and 15 had no failed login
    const res = await w.tick();
    expect(res.statusCode, res.body).toBe(200);
    expect(outcomes(res).housekeeping).toBe('ran');
    const written = await summaries(w);
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({ row_id: '2026-10-17 10:00:00.000000', actor: null, actor_role: 'job', request_id: null });
    expect(written[0].new_row).toEqual({ event: 'login_failures', hour_start: '2026-10-17 10:00:00', failures: 3 });
    expect(Number((await w.sql.query<any[]>('SELECT COUNT(*) AS n FROM sys_login_attempts'))[0][0].n), 'the counters did not grow').toBe(before);
    // the run of the phase has an event of its own, which says that an hour was closed (the summary above is the row of D24)
    const events = (await w.jobEvents()).filter((e) => e.new_row.job === 'housekeeping');
    expect(events).toHaveLength(1);
    expect(events[0].new_row).toMatchObject({ login_failures_hour: '2026-10-17 10:00:00.000000', login_failures: 3 });
  });

  it('a later tick, and a second tick in the same hour, write no second summary for it', async () => {
    set(w, '2026-10-17T16:35:00Z');
    expect((await w.tick()).statusCode).toBe(200);
    set(w, '2026-10-17T22:00:00Z');
    expect((await w.tick()).statusCode).toBe(200);
    expect(await summaries(w)).toHaveLength(1);
  });

  it('an hour closes the moment it has ended (00:00:00 sharp), and the empty hours in between write nothing', async () => {
    set(w, '2026-10-17T23:10:00Z');
    await attempt(w, 'nobody-d@example.test'); // 23:00 to 24:00
    set(w, '2026-10-17T23:59:59.900Z');
    await w.tick();
    expect(await summaries(w)).toHaveLength(1);
    set(w, '2026-10-18T00:00:00Z');
    await w.tick();
    const written = await summaries(w);
    expect(written.map((x) => [x.new_row.hour_start, x.new_row.failures])).toEqual([['2026-10-17 10:00:00', 3], ['2026-10-17 23:00:00', 1]]);
    set(w, '2026-10-18T03:00:00Z');
    await w.tick();
    expect(await summaries(w)).toHaveLength(2);
  });

  it('NEGATIVE CONTROL: the same attack and a tick that does not run the housekeeping leave the hour unwritten, however many hours pass', async () => {
    const bare = await tickWorld('tickhk30n', { authRoutes: true, phases: [heartbeatPhase] });
    try {
      installLoginThrottle(bare.world.app, { sleep: async () => undefined });
      for (const [minute, who] of [['10:05', 'a'], ['10:20', 'b'], ['10:40', 'c']] as const) {
        set(bare, `2026-10-17T${minute}:00Z`);
        await attempt(bare, `nobody-${who}@example.test`);
      }
      set(bare, '2026-10-17T16:05:00Z');
      expect((await bare.tick()).statusCode).toBe(200);
      set(bare, '2026-10-18T16:05:00Z');
      expect((await bare.tick()).statusCode).toBe(200);
      expect(await summaries(bare)).toEqual([]);
      // the failures are there, waiting in the counter of the current hour for a failed login or a housekeeping to close it
      const [audit] = (await bare.sql.query<any[]>("SELECT n FROM sys_login_attempts WHERE scope = 'audit' AND slot = 0"))[0];
      expect(Number(audit.n)).toBe(3);
    } finally {
      await bare.close();
    }
  });
});
