import { describe, expect, it } from 'vitest';
import { WINDOW_SECONDS, loginSlot } from '../../src/auth/loginCounters';
import { type CounterSession, LOGIN_THROTTLE, type LoginAttempt, type LoginCounters, LoginThrottle, loginDelayMs } from '../../src/auth/throttle';
import { BusyError, JvError } from '../../src/errors';

// T-D24 (A13, D24), the behaviour of the login throttle on its own, in VIRTUAL time: the counters are a plain in-memory twin of the table (same windows), every sleep and every password check is
// a timer of one fake clock that the test moves, so ten minutes of attack run in a moment and the same way every time. The same rows through HTTP and the real database are
// tests/api/login-throttle.test.ts; what only this file can do is the steady attack of RF5-1 with real arithmetic (waits of 8 s, hashes of 350 ms, two places) and the exact bounds.

const SECOND = 1000;
const HASH_MS = 350;

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

class VirtualTime {
  now = 0;
  private timers: { at: number; seq: number; fire: () => void }[] = [];
  private seq = 0;

  sleep = (ms: number, signal: AbortSignal): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      if (signal.aborted) return reject(new DOMException('aborted', 'AbortError'));
      const timer = {
        at: this.now + ms,
        seq: this.seq++,
        fire: () => {
          signal.removeEventListener('abort', onAbort);
          resolve();
        },
      };
      const onAbort = () => {
        this.timers = this.timers.filter((t) => t !== timer);
        reject(new DOMException('aborted', 'AbortError'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      this.timers.push(timer);
    });

  /** Moves time to `until`, running every timer that falls due on the way, in order, and letting the code that waits for it run to its next wait. */
  async run(until: number): Promise<void> {
    for (;;) {
      await settle();
      await settle();
      const due = this.timers.filter((t) => t.at <= until).sort((a, b) => a.at - b.at || a.seq - b.seq)[0];
      if (!due) break;
      this.timers = this.timers.filter((t) => t !== due);
      this.now = due.at;
      due.fire();
    }
    this.now = until;
    await settle();
  }
}

/** The counters of D24 in memory: a row for each (scope, slot), a window that begins at the first attempt and runs out after WINDOW_SECONDS (a count is 1 again after that). */
function memoryCounters(time: VirtualTime) {
  const rows = new Map<string, { n: number; start: number }>();
  let failures = 0;
  const session: CounterSession = {
    async count(scope, slot) {
      const key = `${scope}:${slot}`;
      const row = rows.get(key);
      if (!row || row.start < time.now - WINDOW_SECONDS[scope] * SECOND) rows.set(key, { n: 1, start: time.now });
      else row.n += 1;
      return rows.get(key)!.n;
    },
  };
  const counters: LoginCounters = {
    within: (fn) => fn(session),
    failure: async () => {
      failures += 1;
    },
  };
  return { counters, failures: () => failures, rows };
}

const SALT = 'a-salt-for-the-model';

function world() {
  const time = new VirtualTime();
  const mem = memoryCounters(time);
  const throttle = new LoginThrottle({ salt: SALT, counters: mem.counters, sleep: time.sleep });
  return { time, mem, throttle, checked: 0 };
}
type World = ReturnType<typeof world>;

type Outcome = { how: 'wrong' | 'right' | 'refused' | 'gone'; code?: string; retryAfter?: number; delayMs?: number; startedAt: number; endedAt: number };

/** One login as the handler does it: begin, wait the e-mail's delay, take one of the places, check (HASH_MS), say it failed when the password is wrong. `valid` marks the owner's real password. */
function login(w: World, o: { email: string; ip?: string | undefined; valid?: boolean; signal?: AbortSignal }): Promise<Outcome> {
  const startedAt = w.time.now;
  const signal = o.signal ?? new AbortController().signal;
  return (async (): Promise<Outcome> => {
    let attempt: LoginAttempt | undefined;
    try {
      attempt = await w.throttle.begin({ email: o.email, headers: o.ip === undefined ? {} : { 'x-real-ip': o.ip }, signal });
      const delayMs = attempt.delayMs;
      await attempt.delay();
      await attempt.check(async () => {
        w.checked += 1;
        await w.time.sleep(HASH_MS, signal);
      });
      if (o.valid) return { how: 'right', delayMs, startedAt, endedAt: w.time.now };
      await attempt.failed();
      return { how: 'wrong', delayMs, startedAt, endedAt: w.time.now };
    } catch (e) {
      if (e instanceof JvError && e.code === 'JV_RATE_LIMITED') return { how: 'refused', code: e.code, retryAfter: e.retryAfter, startedAt, endedAt: w.time.now };
      if (e instanceof BusyError) return { how: 'gone', code: e.code, startedAt, endedAt: w.time.now };
      throw e;
    } finally {
      attempt?.end();
    }
  })();
}

/** Lets `ms` of virtual time pass and returns what the login came to. */
async function finished(w: World, outcome: Promise<Outcome>, ms = 30 * SECOND): Promise<Outcome> {
  await w.time.run(w.time.now + ms);
  return outcome;
}

describe('T-D24 login throttle: the wait for an e-mail (A13 (1))', () => {
  it('the first 5 attempts for an e-mail wait nothing; then each further attempt waits 1, 2, 4 and at most 8 seconds', () => {
    const waits = Array.from({ length: 14 }, (_, i) => loginDelayMs(i + 1));
    expect(waits).toEqual([0, 0, 0, 0, 0, 1000, 2000, 4000, 8000, 8000, 8000, 8000, 8000, 8000]);
    expect(LOGIN_THROTTLE).toMatchObject({ freeAttempts: 5, maxWaiting: 30, maxChecking: 2, addressPerMinute: 20, anyPerMinute: 60 });
  });

  it('one e-mail has no limit of its own on how many of its attempts wait (only the 30 of all e-mails together); each waits by its own count; a right password is let in after the wait', async () => {
    const w = world();
    const first = Array.from({ length: 5 }, () => login(w, { email: 'owner@example.test', ip: '203.0.113.1' }));
    await w.time.run(0);
    // attempts 6 to 30 arrive at once from 25 addresses: all of them wait, none is refused for the e-mail alone
    const many = Array.from({ length: 25 }, (_, i) => login(w, { email: 'Owner@Example.test', ip: `203.0.113.${10 + i}`, valid: i === 24 }));
    await w.time.run(60 * SECOND);
    const outcomes = await Promise.all([...first, ...many]);
    expect(outcomes.filter((o) => o.how === 'refused')).toHaveLength(0);
    expect(outcomes.slice(0, 5).map((o) => o.delayMs)).toEqual([0, 0, 0, 0, 0]);
    expect(outcomes.slice(5).map((o) => o.delayMs)).toEqual([1000, 2000, 4000, ...Array<number>(22).fill(8000)]);
    expect(outcomes[outcomes.length - 1]).toMatchObject({ how: 'right', delayMs: 8000 });
  });
});

describe('T-D24 login throttle: the address (A13 (2))', () => {
  it('20 attempts a minute from one address pass; the 21st is refused with a Retry-After; a new minute starts again', async () => {
    const w = world();
    const outcomes: Outcome[] = [];
    for (let i = 0; i < 21; i++) outcomes.push(await finished(w, login(w, { email: `u${i}@example.test`, ip: '203.0.113.7' }), 500));
    expect(outcomes.slice(0, 20).every((o) => o.how === 'wrong')).toBe(true);
    expect(outcomes[20]).toMatchObject({ how: 'refused', code: 'JV_RATE_LIMITED', retryAfter: 60 });
    await w.time.run(w.time.now + 61 * SECOND);
    expect((await finished(w, login(w, { email: 'u99@example.test', ip: '203.0.113.7' }), 5 * SECOND)).how).toBe('wrong');
  });

  it('a refused attempt is not counted for the e-mail (it never gets to the password)', async () => {
    const w = world();
    for (let i = 0; i < 20; i++) void login(w, { email: `u${i}@example.test`, ip: '203.0.113.7' });
    await w.time.run(0);
    const refused = await login(w, { email: 'target@example.test', ip: '203.0.113.7' });
    expect(refused.how).toBe('refused');
    expect(w.mem.rows.has(`email:${loginSlot(SALT, 'email', 'target@example.test')}`)).toBe(false);
    expect(w.mem.rows.size).toBeGreaterThan(10); // the twenty before it were counted, e-mail and address
  });

  it('two addresses of one /64 network are one address; another network is another', async () => {
    const w = world();
    for (let i = 0; i < 10; i++) void login(w, { email: `a${i}@example.test`, ip: '2001:db8:1:2:aaaa:bbbb:cccc:dddd' });
    for (let i = 0; i < 10; i++) void login(w, { email: `b${i}@example.test`, ip: '2001:db8:1:2::1' });
    await w.time.run(0);
    expect((await login(w, { email: 'c@example.test', ip: '2001:DB8:1:2:ffff::9' })).how).toBe('refused');
    expect((await finished(w, login(w, { email: 'd@example.test', ip: '2001:db8:1:3::9' }))).how).toBe('wrong');
  });

  it('with no usable address (header missing, a list, a port, text) the 60 a minute of all such attempts together apply instead', async () => {
    const w = world();
    const forms: (string | undefined)[] = [undefined, 'not an address', '203.0.113.5:8080', '203.0.113.5, 198.51.100.2'];
    for (let batch = 0; batch < 6; batch++) {
      // ten at a time, so that the cap of 30 that wait is never the reason for a refusal here
      const ten = Array.from({ length: 10 }, (_, k) => login(w, { email: `n${batch * 10 + k}@example.test`, ip: forms[k % forms.length] }));
      await w.time.run(w.time.now + 2 * SECOND);
      expect((await Promise.all(ten)).every((o) => o.how === 'wrong')).toBe(true);
    }
    expect(await login(w, { email: 'n60@example.test' })).toMatchObject({ how: 'refused', retryAfter: 60 });
    // an address that can be trusted is counted on its own row, not in the 60
    expect((await finished(w, login(w, { email: 'n61@example.test', ip: '203.0.113.5' }))).how).toBe('wrong');
  });
});

describe('T-D24 login throttle: in flight and waiting (A13 (3))', () => {
  it('only the password check is busy, at most 2 at a time; up to 30 attempts of all e-mails together wait for a delay or a free place, the 31st is refused at once, and a place is free again when a check ends', async () => {
    const w = world();
    // 31 at the same moment: the 31st is the one over 30
    const burst = Array.from({ length: 31 }, (_, i) => login(w, { email: `flood${i}@example.test`, ip: `203.0.113.${i + 1}` }));
    await w.time.run(0);
    expect(await burst[30]).toMatchObject({ how: 'refused', code: 'JV_RATE_LIMITED', startedAt: 0, endedAt: 0 }); // at once: no time passed
    expect(w.throttle.stats()).toMatchObject({ checking: 2, waiting: 28 });
    // the two that hold the places are not waiting: two more may come (2 checking + 30 waiting), the next is refused
    const topUp = [login(w, { email: 'top1@example.test', ip: '203.0.113.101' }), login(w, { email: 'top2@example.test', ip: '203.0.113.102' })];
    await w.time.run(0);
    expect(w.throttle.stats()).toMatchObject({ checking: 2, waiting: 30 });
    const over = await login(w, { email: 'over@example.test', ip: '203.0.113.103' });
    expect(over).toMatchObject({ how: 'refused', code: 'JV_RATE_LIMITED', startedAt: 0, endedAt: 0 });
    expect(over.retryAfter).toBeGreaterThanOrEqual(1);
    await w.time.run(HASH_MS); // two checks end, two waiting ones take their places
    expect(w.throttle.stats()).toMatchObject({ checking: 2, waiting: 28 });
    expect((await finished(w, login(w, { email: 'later@example.test', ip: '203.0.113.104' }))).how).toBe('wrong');
    const all = await Promise.all([...burst.slice(0, 30), ...topUp]);
    expect(all.every((o) => o.how === 'wrong')).toBe(true);
    expect(w.throttle.stats()).toMatchObject({ checking: 0, waiting: 0, peakChecking: 2, peakWaiting: 30 });
  });

  it('an attempt whose client has gone while it waits for its delay runs no check, and frees its place at once', async () => {
    const w = world();
    const others = Array.from({ length: 8 }, (_, i) => login(w, { email: 'victim@example.test', ip: `203.0.113.${i + 1}` }));
    await w.time.run(0);
    const ac = new AbortController();
    const gone = login(w, { email: 'victim@example.test', ip: '203.0.113.50', signal: ac.signal }); // its 9th: waits 8 seconds
    await w.time.run(1 * SECOND);
    const before = w.throttle.stats().waiting;
    ac.abort();
    await w.time.run(w.time.now + 1);
    expect(await gone).toMatchObject({ how: 'gone', code: 'JV_BUSY' });
    expect(w.throttle.stats().waiting).toBe(before - 1);
    await w.time.run(w.time.now + 60 * SECOND);
    expect((await Promise.all(others)).every((o) => o.how === 'wrong')).toBe(true);
    expect(w.checked).toBe(8); // the eight that stayed; the ninth never took a place
    expect(w.mem.failures()).toBe(8);
  });

  it('an attempt whose client has gone while it waits for a free place leaves the queue and never checks', async () => {
    const w = world();
    for (let i = 0; i < 2; i++) void login(w, { email: `busy${i}@example.test`, ip: `203.0.113.${i + 1}` }); // both places taken
    await w.time.run(0);
    const ac = new AbortController();
    let checked = false;
    const waiting = (async () => {
      const a = await w.throttle.begin({ email: 'third@example.test', headers: { 'x-real-ip': '203.0.113.9' }, signal: ac.signal });
      try {
        await a.delay();
        await a.check(async () => {
          checked = true;
        });
      } finally {
        a.end();
      }
    })();
    waiting.catch(() => undefined);
    await w.time.run(100);
    expect(w.throttle.stats()).toMatchObject({ checking: 2, waiting: 1 });
    ac.abort();
    await w.time.run(HASH_MS * 3);
    await expect(waiting).rejects.toBeInstanceOf(BusyError);
    expect(checked).toBe(false);
    expect(w.throttle.stats()).toMatchObject({ checking: 0, waiting: 0 });
  });

  it('a failure is written only when the handler says so: a right password writes nothing', async () => {
    const w = world();
    const right = login(w, { email: 'owner@example.test', ip: '203.0.113.1', valid: true });
    const wrong = login(w, { email: 'owner@example.test', ip: '203.0.113.2' });
    await w.time.run(5 * SECOND);
    await Promise.all([right, wrong]);
    expect(w.mem.failures()).toBe(1);
  });
});

describe('T-D24 login throttle: the steady attack of RF5-1 (A13, in virtual time)', () => {
  it("20 attempts a minute from each of 3 addresses on the owner's e-mail for 10 minutes: a valid login from a fourth address is let in each time, after its own wait of 8 s and a few seconds at most", async () => {
    const w = world();
    const attackers: Promise<Outcome>[] = [];
    const owner: Promise<Outcome>[] = [];
    for (let s = 0; s < 600; s++) {
      // one attempt a second, round robin over three addresses: 20 a minute from each
      attackers.push(login(w, { email: 'owner@example.test', ip: `198.51.100.${(s % 3) + 1}` }));
      if (s >= 60 && s % 60 === 30) owner.push(login(w, { email: 'owner@example.test', ip: '203.0.113.44', valid: true }));
      await w.time.run((s + 1) * SECOND);
    }
    await w.time.run(660 * SECOND);
    const mine = await Promise.all(owner);
    expect(mine).toHaveLength(9);
    for (const o of mine) {
      expect(o.how, 'the owner is let in').toBe('right');
      expect(o.delayMs).toBe(8000);
      expect(o.endedAt - o.startedAt, 'within about 12 seconds').toBeLessThanOrEqual(12 * SECOND);
      expect(o.endedAt - o.startedAt, 'the wait is not skipped').toBeGreaterThanOrEqual(8 * SECOND);
    }
    const stats = w.throttle.stats();
    expect(stats.peakWaiting, 'nowhere near the 30').toBeLessThan(15);
    expect(stats.peakChecking).toBeLessThanOrEqual(2);
    const wrong = (await Promise.all(attackers)).filter((o) => o.how === 'wrong').length;
    expect(wrong, 'the attack really ran').toBeGreaterThan(500);
  });

  it('the cap of 30 holds however many addresses a stranger has (A13 says plainly that any finite cap can be filled): the waiting never exceeds 30 and the checks never exceed 2', async () => {
    const w = world();
    const all: Promise<Outcome>[] = [];
    // 24 addresses, each sending as fast as its own 20 a minute allow: about 8 attempts a second on one e-mail, all of them waiting 8 s
    for (let s = 0; s < 120; s++) {
      for (let k = 0; k < 8; k++) all.push(login(w, { email: 'owner@example.test', ip: `198.51.100.${((s * 8 + k) % 24) + 1}` }));
      await w.time.run((s + 1) * SECOND);
    }
    await w.time.run(300 * SECOND);
    const done = await Promise.all(all);
    expect(done.some((o) => o.how === 'refused')).toBe(true); // the cap is full and says so at once
    const stats = w.throttle.stats();
    expect(stats.peakWaiting).toBe(30);
    expect(stats.peakChecking).toBe(2);
    expect(stats).toMatchObject({ waiting: 0, checking: 0 });
  });
});
