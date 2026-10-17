import { createHash, randomUUID } from 'node:crypto';
import http from 'node:http';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../../src/app';
import { loginSlot } from '../../src/auth/loginCounters';
import { passwords } from '../../src/auth/password';
import { installLoginThrottle, loginSaltOf } from '../../src/auth/throttle';
import { createClock } from '../../src/clock';
import { createDbPool } from '../../src/db/pool';
import { txContext, withTx } from '../../src/db/tx';
import { PUBLIC_ROUTES } from '../../src/permissions/matrix';
import { defaultTimers, handlerTimeoutFor, requestLimits } from '../../src/security/requestLimits';
import { sleep } from '../helpers';
import { T0, type World, makeWorld } from './cells';
import { TEST_ORIGIN, csrfHeaders, secret } from './support';

// T-D24 (A13, D24): the login rows of the throttle through HTTP and a real database, and the two rows that belong to this task (change-password, everything else). The behaviour on its own, in virtual
// time, is tests/api/login-throttle-model.test.ts; the counters and their twin are tests/api/login-counters-twin.test.ts; the bounded growth (T-D30) is tests/api/login-bounded.test.ts.
//
// The clock of the application is the test's: time moves when the test moves it, and the counters (which are in the database) count on it. A password check is a stand-in that takes `stub.ms` and is
// right for PASSWORD, so that many logins do not cost a fifth of a second each; a few tests use the real thing. The wait of an e-mail is a seam (`sleep`): it records the wait and does not wait, except
// where a test says it wants the real time.

const MINUTE = 60_000;
const ADMIN_TOKEN = secret('adm');
const ADMIN_HASH = createHash('sha256').update(ADMIN_TOKEN).digest('hex');

let micros = T0;
const clock = createClock(() => micros);
const advance = (ms: number) => {
  micros += BigInt(ms) * 1000n;
};

let world: World;
let PASSWORD: string;
let HASH: string;
let realVerify: typeof passwords.verify;

const stub = { on: true, ms: 0, current: 0, peak: 0, calls: 0 };

interface Answer {
  status: number;
  code?: string;
  retryAfter?: string;
  ms: number;
}

async function login(email: string, password: string, o: { ip?: string; app?: FastifyInstance } = {}): Promise<Answer> {
  const t = performance.now();
  const res = await (o.app ?? world.app).inject({ method: 'POST', url: '/v1/auth/login', headers: { ...csrfHeaders(), ...(o.ip ? { 'x-real-ip': o.ip } : {}) }, payload: { email, password } });
  const body = res.statusCode === 200 ? null : (res.json() as { error: { code: string } });
  const retryAfter = res.headers['retry-after'];
  return { status: res.statusCode, code: body?.error.code, retryAfter: typeof retryAfter === 'string' ? retryAfter : undefined, ms: performance.now() - t };
}

/** A made-up address in 198.18.0.0/15 (benchmarking space), the same number always the same address. */
const addr = (i: number) => `198.${18 + ((i >> 16) & 1)}.${(i >> 8) & 255}.${i & 255}`;
const invented = (i: number) => `invented-${i}@example.test`;

/** The wait of an e-mail is recorded and not waited for. */
function recordSleeps(app: FastifyInstance = world.app) {
  const sleeps: number[] = [];
  const throttle = installLoginThrottle(app, {
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  return { sleeps, throttle };
}

beforeAll(async () => {
  PASSWORD = secret('Pw');
  HASH = await passwords.hash(PASSWORD);
  await passwords.dummyHash(); // made once: the first unknown e-mail must not pay for it
  realVerify = passwords.verify.bind(passwords);
  vi.spyOn(passwords, 'verify').mockImplementation(async (password, stored) => {
    stub.calls += 1;
    if (!stub.on) return realVerify(password, stored);
    stub.current += 1;
    stub.peak = Math.max(stub.peak, stub.current);
    try {
      if (stub.ms > 0) await sleep(stub.ms);
      return password === PASSWORD;
    } finally {
      stub.current -= 1;
    }
  });
  world = await makeWorld({ label: 'thr', routes: true, clock, config: { adminTokenHash: ADMIN_HASH, logLevel: 'warn' } });
}, 120_000);

afterAll(async () => {
  vi.restoreAllMocks();
  await world?.close();
});

beforeEach(() => {
  advance(20 * MINUTE); // every window of A13 (15 minutes for an e-mail, one minute for an address) has run out
  stub.on = true;
  stub.ms = 0;
  stub.peak = 0;
  recordSleeps();
});

// ------------------------------------------------------------------------------------------------ A13 (1): the wait for an e-mail

describe('T-D24 login rows (HTTP + database): the wait for an e-mail (A13 (1), D24)', () => {
  it('after 5 attempts the waits are 1, 2, 4 and 8 seconds, then 8; they survive a restart; a right password still works after the wait', async () => {
    const { sleeps } = recordSleeps();
    const u = await world.addUser({ role: 'owner', passwordHash: HASH });
    for (let i = 1; i <= 10; i++) expect((await login(u.email, 'not-the-password', { ip: '203.0.113.9' })).status, `attempt ${i}`).toBe(401);
    expect(sleeps).toEqual([1000, 2000, 4000, 8000, 8000]);

    // a restart: a new application over the same database, with nothing in memory
    const app2 = buildApp({ config: world.app.config, db: createDbPool(world.scratch.db), clock, routes: true });
    await app2.ready();
    const again = recordSleeps(app2);
    const right = await login(u.email, PASSWORD, { ip: '203.0.113.9', app: app2 });
    expect(right.status).toBe(200);
    expect(again.sleeps).toEqual([8000]);
    expect((await login(u.email, 'still-wrong', { ip: '203.0.113.9', app: app2 })).status).toBe(401);
    expect(again.sleeps).toEqual([8000, 8000]);
    await app2.close();
  });

  it('the wait is real time: the 6th attempt for an e-mail takes about a second, the first five do not', async () => {
    installLoginThrottle(world.app, {}); // the real sleep
    const email = invented(9_000_001);
    const times: number[] = [];
    for (let i = 1; i <= 6; i++) times.push((await login(email, 'nope', { ip: addr(40) })).ms);
    expect(Math.max(...times.slice(0, 5))).toBeLessThan(800);
    expect(times[5]).toBeGreaterThanOrEqual(950);
    expect(times[5]).toBeLessThan(3000);
  });

  it('an unknown e-mail is counted and waits exactly like a known one, so the screen cannot tell them apart', async () => {
    const { sleeps } = recordSleeps();
    const known = await world.addUser({ role: 'biller', passwordHash: HASH });
    for (let i = 0; i < 8; i++) {
      await login(known.email, 'nope', { ip: addr(51) });
      await login(invented(9_000_002), 'nope', { ip: addr(52) });
    }
    expect(sleeps).toEqual([1000, 1000, 2000, 2000, 4000, 4000]); // attempts 6, 7 and 8 of each, in turn
  });
});

// ------------------------------------------------------------------------------------------------ A13 (3): in flight and waiting

describe('T-D24 login rows (HTTP + database): in flight and waiting (A13 (3), U1)', () => {
  it('30 parallel wrong passwords for one e-mail run at most 2 checks at a time and none is refused for that e-mail alone; 50 are limited by the 30 of all e-mails together and nothing else', async () => {
    stub.ms = 25;
    const { throttle } = recordSleeps();
    const u = await world.addUser({ role: 'owner', passwordHash: HASH });
    const thirty = await Promise.all(Array.from({ length: 30 }, (_, i) => login(u.email, 'wrong', { ip: addr(100 + i) })));
    expect(thirty.map((a) => a.status)).toEqual(Array<number>(30).fill(401));
    expect(stub.peak).toBe(2);

    advance(20 * MINUTE);
    const fifty = await Promise.all(Array.from({ length: 50 }, (_, i) => login(u.email, 'wrong', { ip: addr(200 + i) })));
    const statuses = new Set(fifty.map((a) => a.status));
    expect([...statuses].every((s) => s === 401 || s === 429)).toBe(true);
    expect(fifty.filter((a) => a.status === 401).length).toBeGreaterThanOrEqual(30);
    for (const refused of fifty.filter((a) => a.status === 429)) {
      expect(refused.code).toBe('JV_RATE_LIMITED');
      expect(Number(refused.retryAfter)).toBeGreaterThanOrEqual(1);
    }
    expect(stub.peak).toBeLessThanOrEqual(2);
    const stats = throttle.stats();
    expect(stats.peakWaiting).toBeLessThanOrEqual(30);
    expect(stats.peakChecking).toBeLessThanOrEqual(2);
    expect(stats).toMatchObject({ waiting: 0, checking: 0 });
  });

  it("a flood of 500 unknown e-mails at once: an honest login in the same burst is let in within a few seconds, and everything beyond the 30 that wait is answered 429 at once", async () => {
    stub.ms = 20;
    const owner = await world.addUser({ role: 'owner', passwordHash: HASH });
    const started = performance.now();
    const calls = [
      login(owner.email, PASSWORD, { ip: addr(900) }).then((a) => ({ who: 'owner' as const, a })),
      ...Array.from({ length: 500 }, (_, i) => login(invented(100_000 + i), 'guess', { ip: addr(1000 + i) }).then((a) => ({ who: 'flood' as const, a }))),
    ];
    const done = await Promise.all(calls);
    const total = performance.now() - started;
    const mine = done.find((d) => d.who === 'owner')!.a;
    expect(mine.status).toBe(200);
    expect(mine.ms, 'a few seconds at most').toBeLessThan(5000);
    const flood = done.filter((d) => d.who === 'flood').map((d) => d.a);
    const refused = flood.filter((a) => a.status === 429);
    expect(refused.length).toBeGreaterThanOrEqual(400);
    expect(flood.filter((a) => a.status === 401).length).toBeGreaterThanOrEqual(1);
    expect(flood.every((a) => a.status === 401 || a.status === 429)).toBe(true);
    const slowest = Math.max(...refused.map((a) => a.ms));
    expect(slowest, 'refused at once, not after the queue').toBeLessThan(2000);
    expect(total).toBeLessThan(20_000);
  });

  it('8 logins in their delay and one payment at the same moment: the logins hold no connection of the pool and the payment answers in under a second', async () => {
    const email = invented(9_000_010);
    recordSleeps(); // instant: take the e-mail to 9 attempts
    for (let i = 0; i < 9; i++) await login(email, 'nope', { ip: addr(300) });
    // now every attempt for it waits 8 seconds, and the wait is held until the test lets go
    const release: (() => void)[] = [];
    const throttle = installLoginThrottle(world.app, {
      sleep: (_ms, signal) =>
        new Promise<void>((resolve, reject) => {
          release.push(resolve);
          signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        }),
    });
    const waiting = Array.from({ length: 8 }, (_, i) => login(email, 'nope', { ip: addr(310 + i) }));
    while (release.length < 8) await sleep(10);
    expect(throttle.stats().waiting).toBe(8);
    expect(world.app.db!.stats().inUse, 'a waiting login holds no connection').toBe(0);

    const pool = world.app.db!;
    const u = await world.addUser({ role: 'biller', passwordHash: HASH });
    const t = performance.now();
    await withTx(txContext(pool, { requestId: randomUUID(), actor: { id: u.userId, role: 'biller' } }), async (tx) => {
      await tx.rows('SELECT COUNT(*) AS n FROM users');
      await tx.run('UPDATE users SET full_name = ? WHERE id = ?', ['Paid', u.userId]);
    });
    expect(performance.now() - t, 'the payment').toBeLessThan(1000);

    for (const r of release) r();
    expect((await Promise.all(waiting)).map((a) => a.status)).toEqual(Array<number>(8).fill(401));
  });
});

// ------------------------------------------------------------------------------------------------ A13 (2): the address

describe('T-D24 login rows (HTTP + database): the address (A13 (2), D24)', () => {
  it('21 attempts in a minute from one address give 429 with a Retry-After; a minute later it is let in again', async () => {
    const answers: Answer[] = [];
    for (let i = 0; i < 21; i++) answers.push(await login(invented(200_000 + i), 'guess', { ip: '203.0.113.77' }));
    expect(answers.slice(0, 20).map((a) => a.status)).toEqual(Array<number>(20).fill(401));
    expect(answers[20]).toMatchObject({ status: 429, code: 'JV_RATE_LIMITED' });
    expect(Number(answers[20].retryAfter)).toBeGreaterThanOrEqual(1);
    expect(Number(answers[20].retryAfter)).toBeLessThanOrEqual(60);
    advance(61_000);
    expect((await login(invented(200_100), 'guess', { ip: '203.0.113.77' })).status).toBe(401);
  });

  it('two addresses of one /64 count as one address; another /64 is another', async () => {
    const same = ['2001:db8:1:2:aaaa:bbbb:cccc:dddd', '2001:db8:1:2::1'];
    const answers: Answer[] = [];
    for (let i = 0; i < 21; i++) answers.push(await login(invented(210_000 + i), 'guess', { ip: same[i % 2] }));
    expect(answers.slice(0, 20).every((a) => a.status === 401)).toBe(true);
    expect(answers[20].status).toBe(429);
    expect((await login(invented(210_100), 'guess', { ip: '2001:db8:1:3::1' })).status).toBe(401);
  });

  it('with the address header removed, or not an address, the global cap of 60 a minute applies instead; a trusted address is not part of it', async () => {
    const answers: Answer[] = [];
    for (let i = 0; i < 61; i++) answers.push(await login(invented(220_000 + i), 'guess')); // no x-real-ip
    expect(answers.slice(0, 60).every((a) => a.status === 401)).toBe(true);
    expect(answers[60]).toMatchObject({ status: 429, code: 'JV_RATE_LIMITED' });
    expect(Number(answers[60].retryAfter)).toBeGreaterThanOrEqual(1);
    // x-forwarded-for is never read: a client that sends its own gets the same global cap, and a list in x-real-ip is not trusted either
    const forged = await world.app.inject({ method: 'POST', url: '/v1/auth/login', headers: { ...csrfHeaders(), 'x-forwarded-for': '203.0.113.200', 'x-real-ip': '203.0.113.1, 203.0.113.2' }, payload: { email: invented(220_100), password: 'guess' } });
    expect(forged.statusCode).toBe(429);
    expect((await login(invented(220_101), 'guess', { ip: '203.0.113.222' })).status).toBe(401);
  });

  it('a steady attack of 20 attempts a minute from each of 3 addresses on the owner\'s e-mail for 10 minutes does not keep the owner out: a valid login from a fourth address is let in each minute, after its wait of 8 seconds', async () => {
    const owner = await world.addUser({ role: 'owner', passwordHash: HASH });
    const { sleeps } = recordSleeps();
    for (let minute = 0; minute < 10; minute++) {
      for (let k = 0; k < 20; k++) {
        for (let a = 1; a <= 3; a++) await login(owner.email, 'guess', { ip: `198.51.100.${a}` });
      }
      const before = sleeps.length;
      const mine = await login(owner.email, PASSWORD, { ip: '203.0.113.44' });
      expect(mine.status, `minute ${minute}`).toBe(200);
      expect(sleeps.length - before).toBe(1);
      expect(sleeps[sleeps.length - 1]).toBe(8000);
      advance(MINUTE);
    }
  }, 120_000);
});

// ------------------------------------------------------------------------------------------------ the timer, the client that has gone, the clear call

describe('T-D24 login rows (HTTP + database): the timer of the route, a client that has gone, the admin call that clears the counters', () => {
  async function appWithTimer(loginMs: number) {
    const app = buildApp({ config: world.app.config, db: createDbPool(world.scratch.db), clock, routes: true, timers: { loginMs } });
    await app.ready();
    return app;
  }

  /** An e-mail that has had 9 attempts, so that every further attempt waits 8 seconds. */
  async function slowEmail(app: FastifyInstance, n: number) {
    const email = invented(n);
    recordSleeps(app);
    for (let i = 0; i < 9; i++) await login(email, 'nope', { app, ip: addr(60 + i) });
    return email;
  }

  it('the login route\'s handler timer is 30 seconds, every other route\'s 25', () => {
    expect(handlerTimeoutFor(defaultTimers(), PUBLIC_ROUTES.login.method, PUBLIC_ROUTES.login.path)).toBe(30_000);
    expect(requestLimits.loginMs).toBe(30_000);
    expect(handlerTimeoutFor(defaultTimers(), 'POST', '/v1/auth/logout')).toBe(25_000);
  });

  it('when the timer fires during the wait the call is answered 503 JV_BUSY, the password is not checked and the place is free again', async () => {
    const app = await appWithTimer(500);
    const email = await slowEmail(app, 9_100_001);
    const throttle = installLoginThrottle(app, {}); // the real wait of 8 seconds
    const calls = stub.calls;
    const a = await login(email, 'nope', { app, ip: addr(80) });
    expect(a).toMatchObject({ status: 503, code: 'JV_BUSY' });
    expect(a.ms).toBeGreaterThanOrEqual(450);
    expect(a.ms).toBeLessThan(3000);
    await sleep(100);
    expect(stub.calls).toBe(calls);
    expect(throttle.stats()).toMatchObject({ waiting: 0, checking: 0 });
    await app.close();
  });

  it('a call whose client has gone while it waits runs no password check and gives its place back at once', async () => {
    const app = await appWithTimer(30_000);
    const email = await slowEmail(app, 9_100_002);
    const throttle = installLoginThrottle(app, {});
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server.address() as { port: number }).port;
    const calls = stub.calls;
    const body = JSON.stringify({ email, password: 'nope' });
    const request = http.request({ host: '127.0.0.1', port, path: PUBLIC_ROUTES.login.path, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), origin: TEST_ORIGIN, 'x-jv-client': 'web', 'x-real-ip': addr(81) } });
    request.on('error', () => undefined);
    request.end(body);
    const deadline = Date.now() + 5000;
    while (throttle.stats().waiting < 1 && Date.now() < deadline) await sleep(10);
    expect(throttle.stats().waiting, 'the call is waiting for its 8 seconds').toBe(1);
    request.destroy(); // the client goes
    const until = Date.now() + 3000;
    while (throttle.stats().waiting > 0 && Date.now() < until) await sleep(10);
    expect(throttle.stats().waiting, 'its place is free again').toBe(0);
    await sleep(200);
    expect(stub.calls, 'no password was checked').toBe(calls);
    await app.close();
  });

  it('the admin call that clears the login counters lets a refused address and a waiting e-mail in at once', async () => {
    const { sleeps } = recordSleeps();
    const ip = '203.0.113.150';
    const email = invented(9_100_003);
    for (let i = 0; i < 20; i++) await login(email, 'nope', { ip });
    // 20 attempts from one address on one e-mail: the address is at its cap and the e-mail waits 8 seconds
    const refused = await login(email, 'nope', { ip });
    expect(refused.status).toBe(429);
    expect(sleeps.at(-1)).toBe(8000);
    const cleared = await world.app.inject({ method: 'POST', url: '/admin/v1/login-counters/clear', headers: { authorization: `Bearer ${ADMIN_TOKEN}`, 'x-real-ip': '198.18.200.1' } });
    expect(cleared.statusCode).toBe(200);
    const before = sleeps.length;
    const after = await login(email, 'nope', { ip });
    expect(after.status).toBe(401); // not 429: the address is let in
    expect(sleeps.length, 'and the e-mail has no wait').toBe(before);
  });
});

// ------------------------------------------------------------------------------------------------ change-password and everything else (the limiter of API09)

describe('T-D24 rows of the limiter (A13): change-password and everything else', () => {
  const changePassword = (cookie: string, current = 'the-wrong-current-one') =>
    world.app.inject({ method: 'POST', url: '/v1/auth/change-password', headers: { ...csrfHeaders(), cookie }, payload: { current_password: current, new_password: secret('Np-brand-new') } });
  const me = (cookie: string) => world.app.inject({ method: 'GET', url: '/v1/auth/me', headers: { cookie } });

  it('the 6th change-password attempt of one user in 15 minutes is 429 with a Retry-After; another user is not affected; after the window it works again', async () => {
    const a = await world.addUser({ role: 'biller', passwordHash: HASH });
    const b = await world.addUser({ role: 'biller', passwordHash: HASH });
    for (let i = 1; i <= 5; i++) expect((await changePassword(a.cookie)).statusCode, `attempt ${i}`).toBe(422); // a wrong current password is a refused input, never a 401
    const sixth = await changePassword(a.cookie);
    expect(sixth.statusCode).toBe(429);
    expect((sixth.json() as { error: { code: string } }).error.code).toBe('JV_RATE_LIMITED');
    const wait = Number(sixth.headers['retry-after']);
    expect(wait).toBeGreaterThanOrEqual(1);
    expect(wait).toBeLessThanOrEqual(15 * 60);
    expect((await changePassword(b.cookie)).statusCode).toBe(422);
    advance(15 * MINUTE + 1000);
    expect((await changePassword(a.cookie)).statusCode).toBe(422);
  });

  it('the 301st other call of one user in a minute is 429 with a Retry-After; change-password calls are not part of the 300; after the minute it works again', async () => {
    const a = await world.addUser({ role: 'biller', passwordHash: HASH });
    const b = await world.addUser({ role: 'biller', passwordHash: HASH });
    for (let i = 0; i < 5; i++) await changePassword(a.cookie); // its own row
    for (let i = 1; i <= 300; i++) {
      const res = await me(a.cookie);
      if (res.statusCode !== 200) throw new Error(`call ${i} was ${res.statusCode} ${res.body}`);
    }
    const over = await me(a.cookie);
    expect(over.statusCode).toBe(429);
    expect((over.json() as { error: { code: string } }).error.code).toBe('JV_RATE_LIMITED');
    const wait = Number(over.headers['retry-after']);
    expect(wait).toBeGreaterThanOrEqual(1);
    expect(wait).toBeLessThanOrEqual(60);
    expect((await me(b.cookie)).statusCode).toBe(200);
    advance(61_000);
    expect((await me(a.cookie)).statusCode).toBe(200);
  });

  it('a call without a session is not counted for any user (the login has its own rows), and a 401 does not count', async () => {
    for (let i = 0; i < 310; i++) expect((await world.app.inject({ method: 'GET', url: '/v1/auth/me' })).statusCode).toBe(401);
  });
});

// ------------------------------------------------------------------------------------------------ the figures

describe('T-D24 login rows: the slot of an e-mail is the same for the application and the library (D24)', () => {
  it('the salt is a secret of the configuration; the counters of one e-mail are one row however the e-mail is written', async () => {
    const salt = loginSaltOf(world.app.config);
    expect(salt.length).toBeGreaterThanOrEqual(32);
    expect(loginSlot(salt, 'email', 'Owner@Example.test')).toBe(loginSlot(salt, 'email', ' owner@example.test'));
    // the application writes the counters with that slot: attempts for the e-mail in two spellings land on one row
    const email = invented(9_200_001);
    await login(email, 'nope', { ip: addr(70) });
    await login(email.toUpperCase(), 'nope', { ip: addr(71) });
    const slot = loginSlot(salt, 'email', email);
    const c = await world.scratch.connect();
    try {
      const [rows] = await c.query<any[]>("SELECT n FROM sys_login_attempts WHERE scope = 'email' AND slot = ?", [slot]);
      expect(Number(rows[0].n)).toBeGreaterThanOrEqual(2);
    } finally {
      await c.end();
    }
  });
});
