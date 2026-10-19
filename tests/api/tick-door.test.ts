import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app';
import { JOB_HASH, JOB_TOKEN, type TickWorld, body, tickWorld, toyPhase } from './tick-support';
import { TEST_ORIGIN, logSink, testConfig } from './support';

// PT-T1 (API33), the door of the hourly tick (I8, A13): the endpoint needs the job token (the environment holds only its hash), refuses any request that carries an `Origin` header, sends no CORS
// headers, and is throttled by the tick row of A13 (6 a minute for each address, 20 a minute in all): the clause of T-D24.
//
// One world with a toy phase that only counts its runs, on a clock the test moves: the throttles count in the API's clock, so every test starts a minute after the last one.

const MINUTE = 60_000_000n;
const toy = toyPhase('toy', 'every_tick');
let w: TickWorld;

beforeAll(async () => {
  w = await tickWorld('tickdoor', { phases: [toy] });
}, 120_000);
afterAll(async () => {
  await w?.close();
});
let rowsAtStart = 0;
beforeEach(async () => {
  w.time.time.micros += 2n * MINUTE; // every throttle window of the last test is over
  toy.runs.length = 0;
  rowsAtStart = (await w.runs()).length;
});

const errorOf = (res: { json(): unknown }) => (res.json() as { error: { code: string } }).error.code;
const noneRan = async () => {
  expect(toy.runs).toHaveLength(0);
  expect(await w.runs()).toHaveLength(rowsAtStart); // not even a row in sys_job_runs
};

/** A token whose SHA-256 begins with the same bytes as the right hash: the comparison is of the whole hash, so this is still the wrong token. */
function tokenWithHashPrefix(hash: string, bytes: number): string {
  const prefix = hash.slice(0, bytes * 2);
  for (;;) {
    const candidate = randomBytes(32).toString('base64url');
    if (createHash('sha256').update(candidate).digest('hex').startsWith(prefix) && candidate !== JOB_TOKEN) return candidate;
  }
}

describe('PT-T1 the tick refuses a missing or wrong token', () => {
  it('no Authorization header, a wrong token, the right token with a letter added, another scheme, and a token whose hash starts like the right one are all 401 JV_UNAUTHENTICATED and nothing runs', async () => {
    const calls = [
      await w.tick({ token: null }),
      await w.tick({ token: 'wrong' }),
      await w.tick({ token: `${JOB_TOKEN}x` }),
      await w.tick({ token: null, headers: { authorization: `Basic ${JOB_TOKEN}` } }),
      await w.tick({ token: null, headers: { authorization: JOB_TOKEN } }),
      await w.tick({ token: tokenWithHashPrefix(JOB_HASH, 2) }),
    ];
    for (const res of calls) {
      expect(res.statusCode).toBe(401);
      expect(errorOf(res)).toBe('JV_UNAUTHENTICATED');
      expect(JSON.stringify(res.json())).not.toContain(JOB_TOKEN);
    }
    await noneRan();
  });

  it('the right token runs the tick: 200, the S8 request id, no-store, and not one CORS header', async () => {
    const res = await w.tick();
    expect(res.statusCode).toBe(200);
    expect(body(res)).toMatchObject({ status: 'ok', phases: [{ job: 'toy', outcome: 'ran' }] });
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(Object.keys(res.headers).filter((h) => h.startsWith('access-control-'))).toEqual([]);
    expect(toy.runs).toHaveLength(1);
  });

  it('the endpoint does not exist while JV_JOB_TOKEN_HASH is not set, and answers POST only', async () => {
    const get = await w.tick({ method: 'GET' });
    expect([get.statusCode, errorOf(get)]).toEqual([404, 'JV_NOT_FOUND']);
    await noneRan();
    const closed = await tickWorld('tickdoor0', { door: false });
    try {
      const res = await closed.tick();
      expect([res.statusCode, errorOf(res)]).toEqual([404, 'JV_NOT_FOUND']);
    } finally {
      await closed.close();
    }
  }, 60_000);
});

describe('PT-T1 the tick has its own handler timer of 50 seconds', () => {
  it('as registered by the application (read back from the route options of a call that the door refuses)', async () => {
    const app = buildApp({ config: testConfig({ jobTokenHash: JOB_HASH }), logStream: logSink().stream });
    let seen: unknown;
    app.addHook('onRequest', async (request) => {
      if (request.url === '/internal/jobs/tick') seen = request.routeOptions.handlerTimeout;
    });
    try {
      const res = await app.inject({ method: 'POST', url: '/internal/jobs/tick' });
      expect(res.statusCode).toBe(401);
      expect(seen).toBe(50_000);
    } finally {
      await app.close();
    }
  });
});

describe('PT-T1 the tick refuses any request with an Origin header', () => {
  it('with the right token, an allowed origin, a foreign origin, "null" and an empty Origin: 403 JV_FORBIDDEN, nothing runs', async () => {
    for (const origin of [TEST_ORIGIN, 'https://evil.example', 'null', '']) {
      const res = await w.tick({ headers: { origin } });
      expect([res.statusCode, errorOf(res)], origin).toEqual([403, 'JV_FORBIDDEN']);
    }
    await noneRan();
  });

  it('the Origin check comes first and counts nothing: with a wrong token it is still 403 (never 401), and ten of them from one address do not use up the address\'s six wrong tokens (RV1-10: only a wrong token is counted)', async () => {
    const ip = '203.0.113.7';
    for (let i = 0; i < 10; i++) {
      const res = await w.tick({ token: i % 2 ? 'wrong' : null, ip, headers: { origin: TEST_ORIGIN } });
      expect([res.statusCode, errorOf(res)]).toEqual([403, 'JV_FORBIDDEN']);
    }
    for (let i = 0; i < 6; i++) expect((await w.tick({ ip, token: 'wrong' })).statusCode, `wrong token ${i + 1}`).toBe(401);
    expect((await w.tick({ ip, token: 'wrong' })).statusCode).toBe(429);
  });

  it('a preflight to the tick is a 404 with no CORS header, whatever the origin', async () => {
    const res = await w.tick({ method: 'OPTIONS', headers: { origin: TEST_ORIGIN, 'access-control-request-method': 'POST' } });
    expect([res.statusCode, errorOf(res)]).toEqual([404, 'JV_NOT_FOUND']);
    expect(Object.keys(res.headers).filter((h) => h.startsWith('access-control-'))).toEqual([]);
  });
});

describe('PT-RV1d PT-T1 / T-D24 clause (RV1-10): the tick row of A13 counts only wrong tokens, 6 a minute for each address and 20 a minute in all, 429 with Retry-After', () => {
  const wrong = (ip: string | null) => w.tick({ ip, token: 'wrong' });
  const code = (res: { statusCode: number; json(): unknown }) => [res.statusCode, errorOf(res)];

  it('the seventh wrong token (or call without a token) of a minute from one address is 429 JV_RATE_LIMITED with Retry-After in whole seconds; the right token from that very address is still let in; a minute later a wrong token is counted afresh', async () => {
    const ip = '203.0.113.21';
    for (let i = 0; i < 3; i++) expect(code(await wrong(ip)), `wrong token ${i + 1}`).toEqual([401, 'JV_UNAUTHENTICATED']);
    for (let i = 3; i < 6; i++) expect(code(await w.tick({ ip, token: null })), `no token ${i + 1}`).toEqual([401, 'JV_UNAUTHENTICATED']); // no token is a wrong token
    const seventh = await wrong(ip);
    expect(code(seventh)).toEqual([429, 'JV_RATE_LIMITED']);
    const wait = Number(seventh.headers['retry-after']);
    expect(Number.isInteger(wait)).toBe(true);
    expect(wait).toBeGreaterThanOrEqual(1);
    expect(wait).toBeLessThanOrEqual(60);
    expect(toy.runs).toHaveLength(0); // a refused call ran nothing
    expect((await w.tick({ ip })).statusCode).toBe(200); // the right token is not counted, so the address's six wrong tokens do not refuse it
    expect(toy.runs).toHaveLength(1);
    w.time.time.micros += BigInt(wait) * 1_000_000n + 1_000_000n;
    expect(code(await wrong(ip))).toEqual([401, 'JV_UNAUTHENTICATED']);
  });

  it('a right token is counted nowhere: 12 ticks in a minute from one address are 12 runs (200), and they do not lower that address\'s six wrong tokens, nor the 20 in all', async () => {
    const ip = '203.0.113.22';
    for (let i = 0; i < 12; i++) expect((await w.tick({ ip })).statusCode, `right token ${i + 1}`).toBe(200);
    expect(toy.runs).toHaveLength(12);
    for (let i = 0; i < 6; i++) expect(code(await wrong(ip)), `wrong token ${i + 1}`).toEqual([401, 'JV_UNAUTHENTICATED']);
    expect(code(await wrong(ip))).toEqual([429, 'JV_RATE_LIMITED']);
    // the 20 in all: the six above were counted in it; 14 more wrong tokens from other addresses fill it, and the 15th is refused
    for (let i = 0; i < 14; i++) expect((await wrong(`192.0.2.${i + 1}`)).statusCode, `address ${i + 1}`).toBe(401);
    expect(code(await wrong('192.0.2.100'))).toEqual([429, 'JV_RATE_LIMITED']);
  });

  it('20 a minute in all: 20 wrong tokens from 20 different addresses, and the 21st wrong token is 429 whatever its address (a wrong token does not get a fresh bucket each time); a minute later wrong tokens are counted afresh', async () => {
    for (let i = 0; i < 20; i++) expect((await wrong(`192.0.2.${i + 1}`)).statusCode, `address ${i + 1}`).toBe(401);
    const res = await wrong('192.0.2.200');
    expect(code(res)).toEqual([429, 'JV_RATE_LIMITED']);
    expect(Number(res.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    expect(code(await w.tick({ ip: '192.0.2.201', token: null }))).toEqual([429, 'JV_RATE_LIMITED']); // a call without a token is a wrong token
    expect(toy.runs).toHaveLength(0);
    w.time.time.micros += 61n * 1_000_000n;
    expect(code(await wrong('192.0.2.200'))).toEqual([401, 'JV_UNAUTHENTICATED']);
  });

  it('an address that cannot be trusted (no x-real-ip) shares one bucket of six wrong tokens, and its right token passes; an IPv6 address counts by its first 64 bits', async () => {
    for (let i = 0; i < 6; i++) expect((await wrong(null)).statusCode).toBe(401);
    expect((await wrong(null)).statusCode).toBe(429);
    for (let i = 0; i < 3; i++) expect((await w.tick({ ip: null })).statusCode).toBe(200); // the right token from the shared bucket still runs the tick
    w.time.time.micros += 2n * MINUTE;
    for (let i = 0; i < 6; i++) expect((await wrong(`2001:db8:1:2::${i + 1}`)).statusCode).toBe(401);
    expect((await wrong('2001:db8:1:2:ffff::9')).statusCode).toBe(429); // the same /64
    expect((await wrong('2001:db8:1:3::1')).statusCode).toBe(401); // another one
  });
});

describe('PT-RV1d PT-T1 / T-D24 (RV1-10, impl-review-1 attack K) wrong tokens from four addresses at 20 a minute never make the scheduler\'s right token get 429', () => {
  /** 4 strangers with 5 wrong tokens each: 20 in a minute, and each stays under its own six. */
  async function fourStrangers() {
    const answers: number[] = [];
    for (let a = 0; a < 4; a++) for (let i = 0; i < 5; i++) answers.push((await w.tick({ ip: `203.0.113.${a + 10}`, token: 'wrong-token' })).statusCode);
    return answers;
  }

  it('after the 20 wrong tokens the scheduler\'s right token from its own address is 200 and the tick runs, and so is it from an address that took part in the flood; the 21st wrong token is 429', async () => {
    expect(await fourStrangers()).toEqual(new Array(20).fill(401));
    const scheduler = await w.tick({ ip: '198.51.100.99' });
    expect([scheduler.statusCode, body(scheduler).status]).toEqual([200, 'ok']);
    expect(toy.runs).toHaveLength(1);
    expect((await w.tick({ ip: '203.0.113.10' })).statusCode).toBe(200); // a stranger's address with the right token (the cron job of a shared network)
    expect(toy.runs).toHaveLength(2);
    expect(errorOf(await w.tick({ ip: '203.0.113.50', token: 'wrong-token' }))).toBe('JV_RATE_LIMITED');
  });

  it('the same for the job health address, which has the same door', async () => {
    expect(await fourStrangers()).toEqual(new Array(20).fill(401));
    const health = await w.health({ ip: '198.51.100.98' });
    expect([200, 503]).toContain(health.statusCode); // the health of the jobs, whatever it says: not 401 and not 429
    expect(errorOf(await w.health({ ip: '203.0.113.60', token: 'wrong-token' }))).toBe('JV_RATE_LIMITED');
  });

  it('a right token never lowers the budget of wrong ones: 19 wrong tokens, then 25 right tokens from five addresses, and the 20th wrong token is still 401 and the 21st is 429', async () => {
    for (let i = 0; i < 19; i++) expect((await w.tick({ ip: `203.0.113.${100 + (i % 4)}`, token: 'wrong-token' })).statusCode, `wrong token ${i + 1}`).toBe(401);
    for (let i = 0; i < 25; i++) expect((await w.tick({ ip: `198.51.100.${i % 5}` })).statusCode, `right token ${i + 1}`).toBe(200);
    expect((await w.tick({ ip: '203.0.113.200', token: 'wrong-token' })).statusCode).toBe(401); // the 20th
    expect(errorOf(await w.tick({ ip: '203.0.113.201', token: 'wrong-token' }))).toBe('JV_RATE_LIMITED'); // the 21st
    expect(toy.runs).toHaveLength(25);
  });

  it('the Origin refusal is still first and counts nothing: with the 20 used up it is 403 (never 429) for a wrong and for the right token, and it did not use a wrong token\'s place', async () => {
    for (let i = 0; i < 20; i++) expect((await w.tick({ ip: `203.0.113.${120 + (i % 4)}`, token: 'wrong-token' })).statusCode).toBe(401);
    for (const token of ['wrong-token', null, JOB_TOKEN]) {
      const res = await w.tick({ ip: '203.0.113.130', token, headers: { origin: TEST_ORIGIN } });
      expect([res.statusCode, errorOf(res)]).toEqual([403, 'JV_FORBIDDEN']);
    }
    w.time.time.micros += 61n * 1_000_000n; // the next minute: 20 Origin calls would have left none of the 20 if they had been counted
    for (let i = 0; i < 20; i++) await w.tick({ ip: '203.0.113.131', token: 'wrong-token', headers: { origin: TEST_ORIGIN } });
    for (let i = 0; i < 6; i++) expect((await w.tick({ ip: '203.0.113.132', token: 'wrong-token' })).statusCode).toBe(401);
  });
});
