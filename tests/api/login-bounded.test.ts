import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { closeFinishedHour } from '../../src/auth/loginCounters';
import { passwords } from '../../src/auth/password';
import { type LoginCounters, dbLoginCounters, installLoginThrottle } from '../../src/auth/throttle';
import { createClock } from '../../src/clock';
import { withAutocommit } from '../../src/db/autocommit';
import { txContext } from '../../src/db/tx';
import { type World, makeWorld } from './cells';
import { csrfHeaders, secret } from './support';

// T-D30 (D24, A13, D16, L1): bounded growth of failed logins, through HTTP and a real database. 20,000 failed logins for 20,000 invented e-mails and 2,000 for one real e-mail over 50 addresses never
// leave more than 2,050 rows in sys_login_attempts, and a second run of the same load leaves the same number; with an injected clock 24 hours of continuous attack write at most 24 login_failures
// events and none for a single attempt, while the throttle still answers as A13 says; the per-attempt writer of draft 4 is the negative control and FAILS the same check. (The database half proves
// the same on the library alone, tests/schema/s22-login-counters.test.ts; the case "one hour of attack, five quiet hours, a summary after the next tick" is the T-D30 clause of API33b.)

const HOUR = 3_600_000;
const MINUTE = 60_000;

let micros = BigInt(Date.UTC(2026, 9, 17, 10, 0, 0)) * 1000n;
const clock = createClock(() => micros);
const advance = (ms: number) => {
  micros += BigInt(ms) * 1000n;
};
const setClock = (ms: number) => {
  micros = BigInt(ms) * 1000n;
};

let world: World;
const PASSWORD = secret('Pw');

const post = async (email: string, ip: string) => {
  const res = await world.app.inject({ method: 'POST', url: '/v1/auth/login', headers: { ...csrfHeaders(), 'x-real-ip': ip }, payload: { email, password: 'guess' } });
  return { status: res.statusCode, retryAfter: res.headers['retry-after'] };
};
const addr = (i: number) => `198.${18 + ((i >> 16) & 1)}.${(i >> 8) & 255}.${i & 255}`;

/** `workers` run the jobs in turn, as the running API's pool of 8 would. */
async function runAll<T>(jobs: (() => Promise<T>)[], workers: number): Promise<T[]> {
  const out: T[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: workers }, async () => {
      for (;;) {
        const i = next++;
        if (i >= jobs.length) return;
        out[i] = await jobs[i]();
      }
    }),
  );
  return out;
}

const countOf = async (sql: string) => Number((await world.sql.query<any[]>(sql))[0][0].n);
const counterRows = () => countOf('SELECT COUNT(*) AS n FROM sys_login_attempts');
const auditRows = () => countOf('SELECT COUNT(*) AS n FROM audit_log');
const events = async () =>
  (await world.sql.query<any[]>("SELECT row_id, actor_role, new_row FROM audit_log WHERE table_name = 'login_failures' AND action = 'event' ORDER BY id"))[0].map((r) => ({
    hour: r.row_id as string,
    role: r.actor_role as string,
    ...(typeof r.new_row === 'string' ? JSON.parse(r.new_row) : r.new_row),
  })) as { hour: string; role: string; failures: number; event: string }[];

/** The check of T-D30: how many login_failures events a stretch of time may have written. The writer of draft 4 breaks it. */
function assertAtMostOnePerHour(written: number, hours: number) {
  if (written > hours) throw new Error(`${written} login_failures rows in ${hours} hours: more than one for each hour`);
}

beforeAll(async () => {
  await passwords.dummyHash();
  vi.spyOn(passwords, 'verify').mockImplementation(async (password) => password === PASSWORD); // a check that costs nothing: the load is the point here
  world = await makeWorld({ label: 'bnd', routes: true, clock, config: { logLevel: 'error' } });
  installLoginThrottle(world.app, { sleep: async () => undefined });
}, 120_000);

afterAll(async () => {
  vi.restoreAllMocks();
  await world?.close();
});

describe('T-D30 bounded growth of failed logins (HTTP + database)', () => {
  it('20,000 failed logins for 20,000 invented e-mails and 2,000 for one real e-mail over 50 addresses never leave more than 2,050 rows; a second run of the same load leaves the same number', async () => {
    const oneRun = async () => {
      let failed = 0;
      for (let batch = 0; batch < 44; batch++) {
        advance(61_000); // the address windows of the batch before have run out
        const jobs: (() => ReturnType<typeof post>)[] = [];
        for (let k = 0; k < 500; k++) {
          const i = batch * 500 + k;
          if (batch < 40) jobs.push(() => post(`invented-${i}@example.test`, addr(i)));
          else jobs.push(() => post('owner@example.test', `192.0.2.${i % 50}`));
        }
        for (const a of await runAll(jobs, 8)) if (a.status === 401) failed += 1;
      }
      return failed;
    };
    const failed1 = await oneRun();
    const first = { counters: await counterRows(), audit: await auditRows() };
    const eventsAfterFirst = (await events()).length;
    setClock(Date.UTC(2026, 9, 17, 13, 0, 0)); // the same load again, three hours later, from the start of an hour
    const failed2 = await oneRun();
    const second = { counters: await counterRows(), audit: await auditRows() };
    const evs = await events();
    // eslint-disable-next-line no-console
    console.log(`D24 worst case after ${failed1 + failed2} failed logins through HTTP: sys_login_attempts ${second.counters} rows (limit 2,050), audit_log ${second.audit} rows`);
    expect(failed1).toBeGreaterThan(21_000); // the load really ran (the address rows refuse a few, by design)
    expect(failed2).toBeGreaterThan(21_000);
    expect(first.counters).toBeLessThanOrEqual(2050);
    expect(second.counters).toBe(first.counters);
    expect(eventsAfterFirst, 'one hour, nothing written yet').toBe(0);
    expect(evs).toHaveLength(1); // the first run's summary, written by the first failure of the second
    expect(evs[0]).toMatchObject({ role: 'job', event: 'login_failures', failures: failed1 });
    expect(second.audit, 'no row for any single attempt').toBe(first.audit + 1);
  }, 1_500_000);

  it('with an injected clock, 24 hours of continuous attack write at most 24 login_failures events and none for a single attempt, and the throttle answers as A13 says during it', async () => {
    const day = Date.UTC(2026, 10, 3, 0, 0, 0);
    setClock(day);
    // the tick of the night closes what the first test left, so that this day starts clean
    const housekeeping = () => txContext(world.app.db!, { requestId: randomUUID(), actor: { id: null, role: 'job' } });
    await closeFinishedHour(housekeeping(), { now: new Date(day) });
    const before = (await events()).length;
    expect((await post('first-ever@example.test', '203.0.113.1')).status).toBe(401);
    expect((await events()).length, 'a single attempt writes nothing').toBe(before);
    for (let h = 0; h < 24; h++) {
      setClock(day + h * HOUR);
      for (let k = 0; k < 20; k++) {
        advance(2 * MINUTE);
        expect((await post(`slow-${h}-${k}@example.test`, addr(500_000 + h * 20 + k))).status).toBe(401);
      }
      // during the attack the address row still answers: 20 pass, the 21st is refused with a Retry-After
      advance(MINUTE);
      const probe: Awaited<ReturnType<typeof post>>[] = [];
      for (let i = 0; i < 21; i++) probe.push(await post(`probe-${h}-${i}@example.test`, '203.0.113.99'));
      expect(probe.slice(0, 20).every((a) => a.status === 401)).toBe(true);
      expect(probe[20].status).toBe(429);
      expect(Number(probe[20].retryAfter)).toBeGreaterThanOrEqual(1);
      expect((await events()).length - before, `after hour ${h}`).toBe(h); // the summary of hour h-1 was written by the first failure of hour h, and nothing else
      assertAtMostOnePerHour((await events()).length - before, h + 1);
    }
    // the tick's housekeeping closes the last hour (API33b calls this); the whole day is 24 events, each with the failures of its hour
    await closeFinishedHour(housekeeping(), { now: new Date(day + 25 * HOUR) });
    const day24 = (await events()).slice(before);
    expect(day24).toHaveLength(24);
    expect(day24.map((e) => e.failures)).toEqual([41, ...Array<number>(23).fill(40)]); // hour 0 also holds the single first attempt
    expect(() => assertAtMostOnePerHour(day24.length, 24)).not.toThrow();
  }, 300_000);

  it('negative control: the per-attempt writer of draft 4 (an audit row for every failed attempt) fails the same check', async () => {
    const real = dbLoginCounters(world.app);
    const ctx = () => txContext(world.app.db!, { requestId: randomUUID(), actor: { id: null, role: 'job' } });
    const draft4: LoginCounters = {
      within: (fn) => real.within(fn),
      // draft 4 wrote a row for each failed attempt
      failure: async () => {
        await withAutocommit(ctx(), (db) =>
          db.run("INSERT INTO audit_log (actor, actor_role, request_id, table_name, row_id, action, old_row, new_row) VALUES (NULL, 'job', NULL, 'login_failures', ?, 'event', NULL, ?)", [
            new Date(Number(micros / 1000n)).toISOString(),
            JSON.stringify({ event: 'login_failure' }),
          ]),
        );
      },
    };
    installLoginThrottle(world.app, { counters: draft4, sleep: async () => undefined });
    const before = await auditRows();
    const start = Date.UTC(2026, 11, 3, 0, 0, 0);
    setClock(start);
    for (let h = 0; h < 3; h++) {
      setClock(start + h * HOUR);
      for (let k = 0; k < 20; k++) {
        advance(2 * MINUTE);
        await post(`ctrl-${h}-${k}@example.test`, addr(600_000 + h * 20 + k));
      }
    }
    const written = (await auditRows()) - before;
    expect(written).toBe(60);
    expect(() => assertAtMostOnePerHour(written, 3), 'the check catches the draft-4 writer').toThrow(/more than one/);
    installLoginThrottle(world.app, { sleep: async () => undefined });
  }, 120_000);
});
