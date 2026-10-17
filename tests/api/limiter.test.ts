import { describe, expect, it } from 'vitest';
import { addressKey as scriptAddressKey } from '../../scripts/login-counters.mjs';
import { buildApp } from '../../src/app';
import { Limiter, THROTTLES, limiterOf, rateLimited, visitorAddress } from '../../src/auth/limiter';
import { createClock } from '../../src/clock';
import { JvError } from '../../src/errors';
import { logSink, testConfig } from './support';

// API09 builds the one in-memory limiter of A13 (src/auth/limiter.ts): API08 (change-password, everything else), API17 (photos) and API33 (the tick) import it. These are its own tests, the
// T-D24 clause "the limiter answers 429 with Retry-After and restarts from zero after a process restart"; the admin door's rows, which use it, are tests/api/admin-door.test.ts.

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

function limiterOver(maxKeys?: number) {
  let t = 1_000_000;
  const limiter = new Limiter(() => t, maxKeys);
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
  it('holds the figures of A13: admin door, job tick, change-password, photo upload, photo read and everything else', () => {
    expect(THROTTLES).toEqual({
      adminCalls: { limit: 10, windowMs: MINUTE },
      adminWrongInARow: 2,
      adminPauseMs: 15 * MINUTE,
      adminWrongUntrusted: { limit: 5, windowMs: HOUR },
      jobPerAddress: { limit: 6, windowMs: MINUTE },
      jobTotal: { limit: 20, windowMs: MINUTE },
      changePassword: { limit: 5, windowMs: 15 * MINUTE },
      photoUpload: { limit: 30, windowMs: MINUTE },
      photoReadPerAddress: { limit: 600, windowMs: MINUTE },
      photoReadUntrusted: { limit: 120, windowMs: SECOND },
      everything: { limit: 300, windowMs: MINUTE },
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
