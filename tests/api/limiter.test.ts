import { describe, expect, it } from 'vitest';
import { addressKey as scriptAddressKey } from '../../scripts/login-counters.mjs';
import { buildApp } from '../../src/app';
import { Limiter, THROTTLES, changePasswordKey, limiterOf, rateLimited, superWrongKey, visitorAddress } from '../../src/auth/limiter';
import { throttleSessionCall } from '../../src/auth/throttle';
import { createClock } from '../../src/clock';
import { JvError } from '../../src/errors';
import { logSink, testConfig } from './support';

// API09 builds the one in-memory limiter of A13 (src/auth/limiter.ts): API08 (change-password, everything else), API17 (photos) and API33 (the tick) import it. These are its own tests, the
// T-D24 clause "the limiter answers 429 with Retry-After and restarts from zero after a process restart"; the admin door's rows, which use it, are tests/api/admin-door.test.ts.

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

function limiterOver(maxKeys?: number, keptKeys?: number) {
  let t = 1_000_000;
  const limiter = new Limiter(() => t, maxKeys, keptKeys);
  return {
    limiter,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe('T-D24 (API09 clause) the in-memory limiter: a fixed window for each key', () => {
  it('lets `limit` calls through in a window, refuses the next with the whole seconds left, and starts a new window when the old one is over', () => {
    const { limiter, advance } = limiterOver();
    const rate = { limit: 10, windowMs: MINUTE };
    for (let i = 0; i < 10; i++) expect(limiter.take('k', rate), `call ${i + 1}`).toEqual({ ok: true });
    advance(20 * SECOND);
    const refused = limiter.take('k', rate);
    expect(refused).toEqual({ ok: false, retryAfterS: 40 });
    advance(39_001);
    expect(limiter.take('k', rate)).toEqual({ ok: false, retryAfterS: 1 }); // 999 ms left: a whole second, never 0
    advance(1000);
    expect(limiter.take('k', rate)).toEqual({ ok: true }); // the window is over
    for (let i = 0; i < 9; i++) expect(limiter.take('k', rate)).toEqual({ ok: true });
    expect(limiter.take('k', rate).ok).toBe(false);
  });

  it('a refused call is not counted and does not push the end of the window out: a flood cannot keep a key blocked', () => {
    const { limiter, advance } = limiterOver();
    const rate = { limit: 2, windowMs: MINUTE };
    limiter.take('k', rate);
    limiter.take('k', rate);
    for (let i = 0; i < 500; i++) expect(limiter.take('k', rate).ok).toBe(false);
    advance(MINUTE);
    expect(limiter.take('k', rate)).toEqual({ ok: true });
  });

  it('keys are independent, and so are different windows of one key name', () => {
    const { limiter } = limiterOver();
    expect(limiter.take('a', { limit: 1, windowMs: MINUTE }).ok).toBe(true);
    expect(limiter.take('a', { limit: 1, windowMs: MINUTE }).ok).toBe(false);
    expect(limiter.take('b', { limit: 1, windowMs: MINUTE }).ok).toBe(true);
  });

  it('require() throws the refusal as JV_RATE_LIMITED, 429, with the Retry-After', () => {
    const { limiter } = limiterOver();
    const rate = { limit: 1, windowMs: 15 * MINUTE };
    limiter.require('user:1', rate);
    let caught: unknown;
    try {
      limiter.require('user:1', rate);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(JvError);
    expect(caught).toMatchObject({ code: 'JV_RATE_LIMITED', status: 429, retryAfter: 900 });
    expect(rateLimited(7)).toMatchObject({ code: 'JV_RATE_LIMITED', status: 429, retryAfter: 7 });
    expect(rateLimited(0).retryAfter, 'at least one second').toBe(1);
  });

  it('a pause refuses until it is over; wrong answers are counted in a row and one right answer clears them', () => {
    const { limiter, advance } = limiterOver();
    expect(limiter.pausedFor('a')).toBe(0);
    expect(limiter.strike('a')).toBe(1);
    expect(limiter.strike('a')).toBe(2);
    limiter.clearStrikes('a');
    expect(limiter.strike('a')).toBe(1);
    limiter.pause('a', 15 * MINUTE);
    expect(limiter.pausedFor('a')).toBe(15 * MINUTE);
    advance(5 * MINUTE);
    expect(limiter.pausedFor('a')).toBe(10 * MINUTE);
    expect(limiter.pausedFor('b'), 'another key is not paused').toBe(0);
    advance(10 * MINUTE);
    expect(limiter.pausedFor('a')).toBe(0);
  });

  it('holds at most maxKeys keys (the oldest in use goes first), so a flood of invented addresses cannot grow it', () => {
    const { limiter } = limiterOver(50);
    const rate = { limit: 1, windowMs: HOUR };
    limiter.take('first', rate);
    for (let i = 0; i < 5000; i++) limiter.take(`flood-${i}`, rate);
    expect(limiter.size).toBeLessThanOrEqual(50);
    // 'first' was dropped long ago, so it counts from zero again: the price of the bound, and the same as a restart
    expect(limiter.take('first', rate).ok).toBe(true);
    // a key in use is kept: touched again and again, it is never the oldest
    const busy = { limit: 3, windowMs: HOUR };
    limiter.take('busy', busy);
    for (let i = 0; i < 40; i++) {
      limiter.take(`more-${i}`, rate);
      limiter.take('busy', { limit: 1000, windowMs: HOUR });
    }
    expect(limiter.take('busy', busy).ok, 'busy has been counted 41 times in its window').toBe(false);
  });

  it('a new limiter starts from zero: nothing is written anywhere (counters restart with the process, A13)', () => {
    const a = limiterOver();
    const rate = { limit: 1, windowMs: HOUR };
    a.limiter.take('k', rate);
    a.limiter.pause('p', HOUR);
    expect(a.limiter.take('k', rate).ok).toBe(false);
    const b = limiterOver();
    expect(b.limiter.take('k', rate).ok).toBe(true);
    expect(b.limiter.pausedFor('p')).toBe(0);
  });

  it('refuses a rate that is not a whole number of calls and a window of at least a millisecond (a bug in the caller)', () => {
    const { limiter } = limiterOver();
    expect(() => limiter.take('k', { limit: 0, windowMs: MINUTE })).toThrow(TypeError);
    expect(() => limiter.take('k', { limit: 1.5, windowMs: MINUTE })).toThrow(TypeError);
    expect(() => limiter.take('k', { limit: 1, windowMs: 0 })).toThrow(TypeError);
    expect(() => new Limiter(() => 0, 0)).toThrow(TypeError);
  });
});

describe('access plan R9: the Super Admin\'s run of wrong passwords and her pause live in a small store of their own, which other traffic cannot push them out of', () => {
  // The key of src/super/password.ts, written out here the way the plan writes it: `super-wrong:<user id>`.
  const ADMIN = 'super-wrong:0b6f1c2e-5d3a-4b8e-9c71-2f4a6d8e1b30';
  const WINDOW = { limit: 3, windowMs: HOUR };

  /** n other keys of EVERY family the limiter has: a window (a call counted), a pause and a run of wrong answers. Public photo reads alone make 65,536 window keys for the /64 networks of one /48. */
  function flood(limiter: Limiter, n = 5100): void {
    for (let i = 0; i < n; i++) {
      limiter.take(`flood-window-${i}`, WINDOW);
      limiter.pause(`flood-pause-${i}`, HOUR);
      limiter.strike(`flood-run-${i}`);
    }
  }

  it('the key is `super-wrong:<user id>`, as the plan writes it (one place makes it: superWrongKey)', () => {
    expect(superWrongKey('0b6f1c2e-5d3a-4b8e-9c71-2f4a6d8e1b30')).toBe(ADMIN);
  });

  it('a live pause survives more than 5,000 other keys of every other family and still says how long is left; it ends when it ends', () => {
    const { limiter, advance } = limiterOver();
    limiter.pause(ADMIN, 15 * MINUTE);
    advance(5 * MINUTE);
    flood(limiter);
    expect(limiter.pausedFor(ADMIN)).toBe(10 * MINUTE);
    advance(10 * MINUTE);
    expect(limiter.pausedFor(ADMIN)).toBe(0);
  });

  it('a live run of four wrong answers survives the same flood: the next wrong answer is the fifth', () => {
    const { limiter } = limiterOver();
    for (let i = 1; i <= 4; i++) expect(limiter.strike(ADMIN)).toBe(i);
    flood(limiter);
    expect(limiter.strike(ADMIN)).toBe(5);
    limiter.clearStrikes(ADMIN);
    expect(limiter.strike(ADMIN), 'a right answer still ends the run').toBe(1);
  });

  it('every other family is evicted as before (the oldest in use goes first and counts from zero again); only the small store is spared, and the shared map stays within its size', () => {
    const { limiter } = limiterOver(50);
    limiter.pause(ADMIN, HOUR);
    limiter.strike(ADMIN);
    expect(limiter.take('first-window', { limit: 1, windowMs: HOUR }).ok).toBe(true);
    limiter.pause('first-pause', HOUR);
    limiter.strike('first-run');
    flood(limiter, 200); // 600 other keys, twelve times what the shared map holds
    expect(limiter.take('first-window', { limit: 1, windowMs: HOUR }).ok, 'its window was evicted: a new one').toBe(true);
    expect(limiter.pausedFor('first-pause'), 'its pause was evicted').toBe(0);
    expect(limiter.strike('first-run'), 'its run was evicted').toBe(1);
    expect(limiter.pausedFor(ADMIN), 'the Super Admin\'s pause was not').toBeGreaterThan(0);
    expect(limiter.strike(ADMIN), 'nor her run').toBe(2);
    expect(limiter.size).toBeLessThanOrEqual(50 + 2); // the shared map holds 50, the small store her two entries
  });

  it('when the small store is full it drops an entry whose pause is over first, never a live pause or a live run while one is left; a cleared run leaves a free place; only then the oldest', () => {
    const { limiter, advance } = limiterOver(undefined, 3);
    const [a, b, c, d, e, f] = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => `super-wrong:${id}`);
    limiter.pause(b, 15 * MINUTE); // the oldest entry, live
    limiter.pause(a, 1 * MINUTE); // will be over
    limiter.strike(c); // a live run
    advance(2 * MINUTE);
    // full: a new key takes the place of the pause that is over, not of the older live pause
    limiter.strike(d);
    expect(limiter.pausedFor(b)).toBe(13 * MINUTE);
    expect(limiter.strike(c), 'the live run of c is still counted').toBe(2);
    expect(limiter.pausedFor(a)).toBe(0);
    // a run that was ended by a right answer is empty: its place is free, and nothing live is dropped for the next key
    limiter.clearStrikes(d);
    limiter.strike(e);
    expect(limiter.pausedFor(b)).toBe(13 * MINUTE);
    expect(limiter.strike(c)).toBe(3);
    // now it holds nothing but live entries (b, c, e): one more key can only take the place of the OLDEST of them
    limiter.strike(f);
    expect(limiter.pausedFor(b), 'the oldest live entry went').toBe(0);
    expect(limiter.strike(c)).toBe(4);
    expect(limiter.strike(e)).toBe(2);
  });

  it('refuses a small store of no keys, as it refuses a shared map of none', () => {
    expect(() => new Limiter(() => 0, 50, 0)).toThrow(TypeError);
    expect(() => new Limiter(() => 0, 50, 1.5)).toThrow(TypeError);
    expect(() => new Limiter(() => 0, 50, 1)).not.toThrow();
  });
});

describe('final review (Ruling Y): the window of a person\'s change of password lives in the small store too, so that other traffic cannot clear it', () => {
  // POST /v1/auth/change-password checks the current password against the same hash that R9 protects, and it is counted under `changePassword:<user id>`, 5 in 15 minutes (API08). That window was in the shared
  // map beside the public photo reads: 5,000 other keys cleared it, and a stolen session (the Super Admin's too) could guess without limit.
  const PERSON = 'changePassword:0b6f1c2e-5d3a-4b8e-9c71-2f4a6d8e1b30';
  const ADMIN = 'super-wrong:0b6f1c2e-5d3a-4b8e-9c71-2f4a6d8e1b30';
  const RATE = THROTTLES.changePassword;

  /** n other keys of EVERY family the limiter has, each from another address or person: windows (public photo reads, the 300 a minute and the photo uploads of other people), pauses and runs of wrong answers (the terminal door's). */
  function flood(limiter: Limiter, n = 5100): void {
    for (let i = 0; i < n; i++) {
      const address = `198.51.${i >> 8}.${i & 255}`;
      limiter.take(`photo-read:${address}`, THROTTLES.photoReadPerAddress);
      limiter.take(`everything:other-person-${i}`, THROTTLES.everything);
      limiter.take(`photoUpload:other-person-${i}`, THROTTLES.photoUpload);
      limiter.pause(`admin-pause:${address}`, THROTTLES.adminPauseMs);
      limiter.strike(`admin-wrong:${address}`);
    }
  }

  it('the key is `changePassword:<user id>`, as before (one place makes it: changePasswordKey)', () => {
    expect(changePasswordKey('0b6f1c2e-5d3a-4b8e-9c71-2f4a6d8e1b30')).toBe(PERSON);
  });

  it('a live window survives more than 5,000 other keys of every other family: the 6th call in the window is still refused, with the time that is left; it ends when it ends', () => {
    const { limiter, advance } = limiterOver();
    for (let i = 1; i <= 5; i++) expect(limiter.take(PERSON, RATE), `call ${i}`).toEqual({ ok: true });
    expect(limiter.take(PERSON, RATE).ok, 'the 6th call, before any flood').toBe(false);
    advance(5 * MINUTE);
    flood(limiter);
    expect(limiter.take(PERSON, RATE), 'the 6th call after the flood').toEqual({ ok: false, retryAfterS: 600 });
    advance(10 * MINUTE + 1);
    expect(limiter.take(PERSON, RATE), 'the window is over, 15 minutes after the first call').toEqual({ ok: true });
  });

  it('the windows of 200 people and the Super Admin\'s pause and run live in the small store together and none pushes another out (a shop\'s people plus the Super Admin never evict each other)', () => {
    const { limiter } = limiterOver();
    limiter.pause(ADMIN, HOUR);
    limiter.strike(ADMIN);
    for (let i = 0; i < 200; i++) for (let call = 1; call <= 5; call++) expect(limiter.take(`changePassword:person-${i}`, RATE), `person ${i}, call ${call}`).toEqual({ ok: true });
    flood(limiter, 1100); // 5,500 other keys: more than the shared map holds
    for (let i = 0; i < 200; i++) expect(limiter.take(`changePassword:person-${i}`, RATE).ok, `person ${i}: the 6th call`).toBe(false);
    expect(limiter.pausedFor(ADMIN), 'the Super Admin\'s pause was not pushed out').toBeGreaterThan(0);
    expect(limiter.strike(ADMIN), 'nor her run').toBe(2);
  });

  it('nothing else is protected: a person\'s other windows (the 300 a minute, the photo uploads) stay in the shared map and are evicted as before', () => {
    const { limiter } = limiterOver();
    expect(limiter.take('everything:the-person', { limit: 1, windowMs: HOUR }).ok).toBe(true);
    expect(limiter.take('photoUpload:the-person', { limit: 1, windowMs: HOUR }).ok).toBe(true);
    flood(limiter);
    expect(limiter.take('everything:the-person', { limit: 1, windowMs: HOUR }).ok, 'its window was evicted: a new one').toBe(true);
    expect(limiter.take('photoUpload:the-person', { limit: 1, windowMs: HOUR }).ok, 'its window was evicted: a new one').toBe(true);
  });

  it('a full small store drops a window that is over first, not an older live pause, and the oldest live entry only when none is over (the rule of R9, now for the windows too)', () => {
    const { limiter, advance } = limiterOver(undefined, 3);
    const [a, b, c, d] = ['a', 'b', 'c', 'd'].map((id) => `changePassword:${id}`);
    limiter.pause(ADMIN, HOUR); // the oldest entry, live for an hour
    advance(1 * MINUTE);
    expect(limiter.take(a, RATE).ok).toBe(true); // a window of 15 minutes
    advance(10 * MINUTE);
    expect(limiter.take(b, RATE).ok).toBe(true); // 11 minutes after the first: live for 15 more
    advance(6 * MINUTE); // 17 minutes in: the window of a is over, the window of b and the pause are not
    expect(limiter.take(c, RATE).ok).toBe(true); // the store is full: it takes the place of a, not of the older live pause
    expect(limiter.pausedFor(ADMIN), 'the live pause was kept although it is the oldest entry').toBeGreaterThan(0);
    // now nothing is over (the pause, b and c are live): one more key can only take the place of the oldest of them, the pause
    expect(limiter.take(d, RATE).ok).toBe(true);
    expect(limiter.pausedFor(ADMIN), 'the oldest live entry went, because nothing was over').toBe(0);
  });

  it('the wrapper of the session routes counts a change of password under that key: after the flood the 6th call is 429 with a Retry-After, and the 5 before it were not refused', async () => {
    const micros = BigInt(Date.UTC(2026, 9, 17, 10, 0, 0)) * 1000n;
    const app = buildApp({ config: testConfig({ logLevel: 'silent' }), clock: createClock(() => micros), routes: false, logStream: logSink().stream });
    await app.ready();
    try {
      const id = '7f3a1c9e-2b4d-4e6f-8a0b-1c2d3e4f5a6b';
      for (let i = 1; i <= 5; i++) expect(() => throttleSessionCall(app, 'session:change-password', id), `call ${i}`).not.toThrow();
      flood(limiterOf(app));
      let refused: unknown;
      try {
        throttleSessionCall(app, 'session:change-password', id);
      } catch (e) {
        refused = e;
      }
      expect(refused).toBeInstanceOf(JvError);
      expect(refused).toMatchObject({ code: 'JV_RATE_LIMITED', status: 429 });
      expect((refused as JvError).retryAfter).toBeGreaterThanOrEqual(1);
      expect((refused as JvError).retryAfter).toBeLessThanOrEqual(900);
      expect(() => throttleSessionCall(app, 'session:change-password', 'someone-else'), 'another person is not affected').not.toThrow();
    } finally {
      await app.close();
    }
  });
});

describe('T-D24 (API09 clause) limiterOf(app): one limiter for an application, on its clock; a new application (a restart) starts from zero', () => {
  it('is the same object for the same app, a different one for another, and reads the API clock (so a test can move time)', async () => {
    let micros = BigInt(Date.UTC(2026, 9, 17, 10, 0, 0)) * 1000n;
    const config = testConfig({ logLevel: 'silent' });
    const app1 = buildApp({ config, clock: createClock(() => micros), routes: false, logStream: logSink().stream });
    const app2 = buildApp({ config, clock: createClock(() => micros), routes: false, logStream: logSink().stream });
    await Promise.all([app1.ready(), app2.ready()]);
    expect(limiterOf(app1)).toBe(limiterOf(app1));
    expect(limiterOf(app1)).not.toBe(limiterOf(app2));
    const rate = { limit: 1, windowMs: MINUTE };
    expect(limiterOf(app1).take('k', rate).ok).toBe(true);
    expect(limiterOf(app1).take('k', rate).ok).toBe(false);
    expect(limiterOf(app2).take('k', rate).ok, 'the other application (a restart) counts from zero').toBe(true);
    micros += 61n * 1_000_000n;
    expect(limiterOf(app1).take('k', rate).ok, 'a minute of the API clock later').toBe(true);
    await Promise.all([app1.close(), app2.close()]);
  });
});

describe('T-D24 (API09 clause) the rows of A13 that live in memory are written down once', () => {
  it('holds the figures of A13: admin door, the Super Admin\'s password (R9), job tick, change-password, photo upload, photo read, everything else, and the two of forgot-password', () => {
    expect(THROTTLES).toEqual({
      adminCalls: { limit: 10, windowMs: MINUTE },
      adminWrongInARow: 2,
      adminPauseMs: 15 * MINUTE,
      superWrongInARow: 5,
      superPauseMs: 15 * MINUTE,
      adminWrongUntrusted: { limit: 5, windowMs: HOUR },
      jobPerAddress: { limit: 6, windowMs: MINUTE },
      jobTotal: { limit: 20, windowMs: MINUTE },
      changePassword: { limit: 5, windowMs: 15 * MINUTE },
      photoUpload: { limit: 30, windowMs: MINUTE },
      photoReadPerAddress: { limit: 600, windowMs: MINUTE },
      photoReadUntrusted: { limit: 120, windowMs: SECOND },
      everything: { limit: 300, windowMs: MINUTE },
      resetPerEmail: { limit: 3, windowMs: HOUR },
      resetPerAddress: { limit: 10, windowMs: HOUR },
    });
    expect(Object.isFrozen(THROTTLES)).toBe(true);
  });
});

describe('T-D24 (API09 clause) the visitor address: x-real-ip only, an IPv6 address by its first 64 bits, anything else is not an address we can trust (A13)', () => {
  const key = (h: Record<string, unknown>) => visitorAddress(h);

  it('reads x-real-ip, trims it, and counts an IPv4 address as it is', () => {
    expect(key({ 'x-real-ip': '203.0.113.7' })).toEqual({ key: '203.0.113.7', trusted: true });
    expect(key({ 'x-real-ip': ' 203.0.113.7 ' })).toEqual({ key: '203.0.113.7', trusted: true });
  });

  it('shortens an IPv6 address to its first 64 bits, so a whole network counts as one; an IPv4-mapped one is the IPv4', () => {
    expect(key({ 'x-real-ip': '2001:db8:1:2:aaaa:bbbb:cccc:dddd' }).key).toBe('2001:db8:1:2::');
    expect(key({ 'x-real-ip': '2001:db8:1:2::1' }).key).toBe('2001:db8:1:2::');
    expect(key({ 'x-real-ip': '2001:DB8:1:2:ffff::9' }).key).toBe('2001:db8:1:2::');
    expect(key({ 'x-real-ip': '::ffff:198.51.100.9' }).key).toBe('198.51.100.9');
    expect(key({ 'x-real-ip': 'fe80::1%eth0' }).key).toBe('fe80:0:0:0::');
    expect(key({ 'x-real-ip': '2001:db8::1' }).key).toBe(key({ 'x-real-ip': '2001:db8::ffff' }).key);
  });

  it('is the same function as the database half\'s addressKey for every address (the login counters and this limiter must count one visitor the same way)', () => {
    const samples = ['203.0.113.7', '::ffff:198.51.100.9', '2001:db8:1:2:aaaa:bbbb:cccc:dddd', '2001:db8::1', '::1', '::', 'fe80::1%eth0', '2001:DB8:0:0:0:0:0:1', '64:ff9b::192.0.2.33', '1:2:3:4:5:6:7:8', '1::8'];
    for (const s of samples) expect(key({ 'x-real-ip': s }).key, s).toBe(scriptAddressKey(s));
  });

  it('a missing header, an array, text that is not an address (a malformed one included), a list or a port is untrusted (one shared key, no pause per address)', () => {
    for (const h of [{}, { 'x-real-ip': undefined }, { 'x-real-ip': ['203.0.113.7'] }, { 'x-real-ip': '' }, { 'x-real-ip': 'unknown' }, { 'x-real-ip': '203.0.113.7, 198.51.100.1' }, { 'x-real-ip': '203.0.113.7:443' }, { 'x-real-ip': '999.1.1.1' }, { 'x-real-ip': '01.2.3.4' }, { 'x-real-ip': '1.2.3' }, { 'x-real-ip': '1::2::3' }, { 'x-real-ip': ':::' }, { 'x-real-ip': '12345::1' }, { 'x-real-ip': 'g::1' }, { 'x-real-ip': '[::1]' }, { 'x-real-ip': '::1]@evil.example/' }, { 'x-real-ip': '1:2:3:4:5:6:7:8:9' }]) {
      expect(key(h), JSON.stringify(h)).toEqual({ key: 'unknown', trusted: false });
    }
  });

  it('never reads x-forwarded-for: a client can write it (A13)', () => {
    expect(key({ 'x-forwarded-for': '203.0.113.7' })).toEqual({ key: 'unknown', trusted: false });
    expect(key({ 'x-forwarded-for': '10.9.9.9', 'x-real-ip': '203.0.113.7' }).key).toBe('203.0.113.7');
  });
});
