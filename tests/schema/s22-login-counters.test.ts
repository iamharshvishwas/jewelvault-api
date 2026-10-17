import { createHash } from 'node:crypto';
import type { Connection } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appConn, dropDb } from '../helpers';
import { clearLoginCounters } from '../../scripts/housekeeping.mjs';
import { addressKey, closeFinishedHour, countAttempt, loginSlot, recordFailure, WINDOW_SECONDS } from '../../scripts/login-counters.mjs';
import { migratedDb } from './support';

// Spec D24, A13 and T-D30 (database half): the login counters are updated in place and never grow (at most 2,050 rows however many invented e-mails are sent), an attempt is
// counted when the request arrives by one atomic statement, and a failed login is never written one by one: the audit row keeps the count of the current hour, the first failure
// after the hour has changed (or the tick's housekeeping) claims it and writes ONE `login_failures` event. All with an injected clock.

let db: string;
let c: Connection;
const extra: Connection[] = [];
beforeAll(async () => {
  ({ db, c } = await migratedDb('s22_login'));
});
afterAll(async () => {
  await c.end();
  for (const x of extra) await x.end().catch(() => undefined);
  await dropDb(db);
});
const at = (iso: string) => new Date(iso);
const rowCount = async (scope?: string) => Number((await c.query<any[]>(`SELECT COUNT(*) AS n FROM sys_login_attempts${scope ? ' WHERE scope = ?' : ''}`, scope ? [scope] : []))[0][0].n);
const events = async () =>
  (await c.query<any[]>("SELECT row_id, actor_role, new_row FROM audit_log WHERE table_name = 'login_failures' AND action = 'event' ORDER BY id"))[0].map((r) => ({
    hour: r.row_id as string,
    role: r.actor_role as string,
    ...(typeof r.new_row === 'string' ? JSON.parse(r.new_row) : r.new_row),
  }));
const auditRow = async () => (await c.query<any[]>("SELECT window_start, n FROM sys_login_attempts WHERE scope = 'audit' AND slot = 0"))[0][0];

describe('which counter an e-mail or an address lands in (D24)', () => {
  it('the slot is the first two bytes of SHA-256(salt | lower-cased e-mail) modulo 1,024: the same for upper and lower case, different for another salt', () => {
    const want = (salt: string, v: string) => createHash('sha256').update(`${salt}|${v}`).digest().readUInt16BE(0) % 1024;
    expect(loginSlot('s3cret', 'email', 'Owner@Example.COM')).toBe(want('s3cret', 'owner@example.com'));
    expect(loginSlot('s3cret', 'email', '  owner@example.com ')).toBe(want('s3cret', 'owner@example.com'));
    expect(loginSlot('other', 'email', 'owner@example.com')).toBe(want('other', 'owner@example.com'));
    for (let i = 0; i < 2000; i++) {
      const s = loginSlot('s3cret', 'email', `x${i}@example.com`);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(1023);
    }
    expect(() => loginSlot('', 'email', 'a@b.c')).toThrow(/salt/);
    expect(() => loginSlot('s3cret', 'phone' as any, 'x')).toThrow(/kind/);
  });

  it('an IPv6 address counts by its first 64 bits (two addresses of one /64 are one address); an IPv4-mapped one counts as the IPv4; IPv4 is as it is', () => {
    expect(addressKey('2001:db8:1:2:aaaa:bbbb:cccc:dddd')).toBe('2001:db8:1:2::');
    expect(addressKey('2001:DB8:1:2::1')).toBe('2001:db8:1:2::');
    expect(addressKey('2001:db8:1:2::')).toBe('2001:db8:1:2::');
    expect(addressKey('2001:db8::1')).toBe('2001:db8:0:0::');
    expect(addressKey('::1')).toBe('0:0:0:0::');
    expect(addressKey('::ffff:203.0.113.9')).toBe('203.0.113.9');
    expect(addressKey('203.0.113.9')).toBe('203.0.113.9');
    expect(addressKey('fe80::1%eth0')).toBe('fe80:0:0:0::');
    expect(loginSlot('s', 'addr', '2001:db8:1:2:aaaa:bbbb:cccc:dddd')).toBe(loginSlot('s', 'addr', '2001:db8:1:2:1111:2222:3333:4444'));
    expect(loginSlot('s', 'addr', '2001:db8:1:2::1')).not.toBe(loginSlot('s', 'addr', '2001:db8:1:3::1')); // another /64 (these two do not share a slot with this salt)
  });
});

describe('counting an attempt: one atomic statement when the request arrives (D24, A13)', () => {
  it('the windows are 900 seconds for an e-mail and 60 for an address and for "any"; the first attempt is 1, then 2, 3; after the window the count starts again at 1', async () => {
    expect(WINDOW_SECONDS).toEqual({ email: 900, addr: 60, any: 60 });
    const t0 = at('2026-10-16T08:00:00.000Z');
    const plus = (s: number) => new Date(t0.getTime() + s * 1000);
    expect(await countAttempt(c, 'email', 17, { now: t0 })).toBe(1);
    expect(await countAttempt(c, 'email', 17, { now: plus(1) })).toBe(2);
    expect(await countAttempt(c, 'email', 17, { now: plus(899) })).toBe(3); // 899 s after the FIRST attempt: the window is measured from window_start, which has not moved
    expect(await countAttempt(c, 'email', 17, { now: plus(901) })).toBe(1); // more than 900 s after window_start: a fresh window
    expect(await countAttempt(c, 'addr', 17, { now: t0 })).toBe(1); // the same slot number in another scope is another counter
    expect(await countAttempt(c, 'addr', 17, { now: plus(30) })).toBe(2);
    expect(await countAttempt(c, 'addr', 17, { now: plus(61) })).toBe(1);
    expect(await countAttempt(c, 'any', 0, { now: t0 })).toBe(1);
    expect(await countAttempt(c, 'any', 0, { now: plus(59) })).toBe(2);
    expect(await countAttempt(c, 'any', 0, { now: plus(61) })).toBe(1);
  });

  it('50 parallel attempts on one slot are counted exactly (no lost update), and the count survives a new connection (a restart)', async () => {
    const t = at('2026-10-16T09:00:00.000Z');
    const conns = await Promise.all(Array.from({ length: 10 }, () => appConn(db)));
    extra.push(...conns);
    const seen = await Promise.all(Array.from({ length: 50 }, (_, i) => countAttempt(conns[i % 10], 'email', 99, { now: t })));
    expect(Math.max(...seen)).toBeLessThanOrEqual(50);
    expect(await countAttempt(c, 'email', 99, { now: t })).toBe(51);
    const fresh = await appConn(db);
    extra.push(fresh);
    expect(await countAttempt(fresh, 'email', 99, { now: t })).toBe(52);
  });

  it('with the database clock (no injected time) the statement of the spec is used; a wrong scope or slot is refused before it reaches the CHECKs', async () => {
    expect(await countAttempt(c, 'email', 500)).toBe(1);
    expect(await countAttempt(c, 'email', 500)).toBe(2);
    await expect(countAttempt(c, 'audit' as any, 0)).rejects.toThrow(/scope/);
    await expect(countAttempt(c, 'email', 1024)).rejects.toThrow(/slot/);
    await expect(countAttempt(c, 'email', -1)).rejects.toThrow(/slot/);
    await expect(countAttempt(c, 'email', 1.5)).rejects.toThrow(/slot/);
  });
});

describe('the failure summary: one audit event for each hour, none for an attempt (D24, T-D30)', () => {
  it('failures inside one hour write nothing; the first failure after the hour changed writes ONE login_failures event with the count of the hour that ended', async () => {
    const before = (await events()).length;
    const h = (m: number, s = 0) => at(`2026-10-17T05:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.000Z`);
    for (let i = 0; i < 7; i++) await recordFailure(c, { now: h(i * 7) }); // 05:00 .. 05:42, seven failures in the hour
    expect(await events()).toHaveLength(before);
    expect(Number((await auditRow()).n)).toBe(7);
    const next = await recordFailure(c, { now: at('2026-10-17T06:00:01.000Z') });
    expect(next.closed).toEqual({ hour: '2026-10-17 05:00:00.000000', failures: 7 });
    const ev = await events();
    expect(ev).toHaveLength(before + 1);
    expect(ev[ev.length - 1]).toMatchObject({ hour: '2026-10-17 05:00:00.000000', role: 'job', event: 'login_failures', failures: 7, hour_start: '2026-10-17 05:00:00' });
    expect(Number((await auditRow()).n)).toBe(1); // the failure that closed the hour is the first of the new one
  });

  it('exactly one request wins the claim: 12 failures arriving at once in the first second of a new hour write one event, and none of the 12 is lost from the new hour', async () => {
    const conns = await Promise.all(Array.from({ length: 12 }, () => appConn(db)));
    extra.push(...conns);
    for (let i = 0; i < 5; i++) await recordFailure(c, { now: at(`2026-10-17T07:0${i}:00.000Z`) }); // five failures in the 07:00 hour
    const before = (await events()).length;
    const results = await Promise.all(conns.map((x) => recordFailure(x, { now: at('2026-10-17T08:00:00.500Z') })));
    expect(results.filter((r) => r.closed).length).toBe(1);
    expect(results.find((r) => r.closed)!.closed).toEqual({ hour: '2026-10-17 07:00:00.000000', failures: 5 });
    expect((await events()).length).toBe(before + 1);
    expect(Number((await auditRow()).n)).toBe(12);
  });

  it('an hour with no failures writes nothing, and a quiet gap of several hours is closed once', async () => {
    // after the last test the row holds 12 failures of the 08:00 hour
    const before = (await events()).length;
    const r = await recordFailure(c, { now: at('2026-10-17T13:30:00.000Z') }); // five quiet hours later
    expect(r.closed).toEqual({ hour: '2026-10-17 08:00:00.000000', failures: 12 });
    expect((await events()).length).toBe(before + 1);
    const again = await recordFailure(c, { now: at('2026-10-17T13:31:00.000Z') });
    expect(again.closed).toBeNull();
    expect((await events()).length).toBe(before + 1);
  });

  it('the tick closes a finished hour that has failures not yet written, without any further failed login; closing twice writes one event; an hour with no failures writes none', async () => {
    const before = (await events()).length;
    // 13:00 hour holds 2 failures (the last two tests above); nothing happens while the hour is still running
    expect(await closeFinishedHour(c, { now: at('2026-10-17T13:59:59.000Z') })).toBeNull();
    expect((await events()).length).toBe(before);
    const closed = await closeFinishedHour(c, { now: at('2026-10-17T19:05:00.000Z') });
    expect(closed).toEqual({ hour: '2026-10-17 13:00:00.000000', failures: 2 });
    expect((await events()).length).toBe(before + 1);
    expect(await closeFinishedHour(c, { now: at('2026-10-17T19:06:00.000Z') })).toBeNull();
    expect(await closeFinishedHour(c, { now: at('2026-10-18T03:00:00.000Z') })).toBeNull(); // nothing counted since: no event for an empty hour
    expect((await events()).length).toBe(before + 1);
  });

  it('the first failure ever (no summary row yet) creates it without an event; the database clock is used when no time is injected', async () => {
    const { db: db2, c: c2 } = await migratedDb('s22_login_b');
    const r = await recordFailure(c2, { now: at('2020-01-01T01:10:00.000Z') });
    expect(r.closed).toBeNull();
    const live = await recordFailure(c2); // the database clock is long after 2020: it closes that old hour
    expect(live.closed).toEqual({ hour: '2020-01-01 01:00:00.000000', failures: 1 });
    expect((await c2.query<any[]>("SELECT COUNT(*) AS n FROM audit_log WHERE table_name = 'login_failures'"))[0][0].n).toBe('1');
    await c2.end();
    await dropDb(db2);
  });

  it('the admin-door clear (U3) leaves the summary row alone, so an attack in progress is still summarised', async () => {
    await recordFailure(c, { now: at('2026-10-18T04:10:00.000Z') });
    await recordFailure(c, { now: at('2026-10-18T04:20:00.000Z') });
    await clearLoginCounters(c);
    expect(Number((await auditRow()).n)).toBeGreaterThanOrEqual(2);
  });
});

describe('T-D30: bounded growth (database half)', () => {
  it('20,000 failed logins for 20,000 invented e-mails and 2,000 for one real e-mail over 50 addresses never leave more than 2,050 counter rows, and a second run leaves the same number', async () => {
    const { db: db3, c: c3 } = await migratedDb('s22_login_c');
    const salt = 'a-secret-salt';
    const t = at('2026-10-20T10:00:00.000Z');
    const workers = await Promise.all(Array.from({ length: 8 }, () => appConn(db3))); // the running app has a pool of 8 (S11)
    const run = async (offsetS: number) => {
      const now = new Date(t.getTime() + offsetS * 1000);
      const one = async (w: Connection, email: string, addr: string) => {
        await countAttempt(w, 'email', loginSlot(salt, 'email', email), { now });
        await countAttempt(w, 'addr', loginSlot(salt, 'addr', addr), { now });
        await countAttempt(w, 'any', 0, { now });
        await recordFailure(w, { now });
      };
      await Promise.all(
        workers.map(async (w, k) => {
          for (let i = k; i < 20000; i += 8) await one(w, `invented-${i}@example.test`, `203.0.113.${i % 50}`);
          for (let i = k; i < 2000; i += 8) await one(w, 'owner@example.test', `198.51.100.${i % 50}`);
        })
      );
    };
    const count3 = async () => {
      const [[r]] = await c3.query<any[][]>('SELECT COUNT(*) AS n FROM sys_login_attempts').then((x) => [x[0]]);
      const [[a]] = await c3.query<any[][]>('SELECT COUNT(*) AS n FROM audit_log').then((x) => [x[0]]);
      return { counters: Number((r as any).n), audit: Number((a as any).n) };
    };
    await run(0);
    const first = await count3();
    await run(7200); // two hours later: the same load again
    const second = await count3();
    // eslint-disable-next-line no-console
    console.log(`D24 worst case after ${2 * 22000} failed logins: sys_login_attempts ${second.counters} rows (limit 2,050), audit_log ${second.audit} rows`);
    expect(first.counters).toBeLessThanOrEqual(2050);
    expect(second.counters).toBe(first.counters);
    expect(first.audit).toBe(0); // one hour, nothing written yet
    expect(second.audit).toBe(1); // the first hour's summary, written by the first failure of the second run
    const [ev] = await c3.query<any[]>("SELECT new_row FROM audit_log WHERE table_name = 'login_failures'");
    expect((typeof ev[0].new_row === 'string' ? JSON.parse(ev[0].new_row) : ev[0].new_row).failures).toBe(22000);
    for (const w of workers) await w.end();
    await c3.end();
    await dropDb(db3);
  }, 300000);

  it('with an injected clock, 24 hours of continuous attack write at most 24 login_failures events, none for a single attempt; and the per-attempt writer of draft 4 would write one row each (negative control)', async () => {
    const { db: db4, c: c4 } = await migratedDb('s22_login_d');
    const day = at('2026-10-21T00:00:00.000Z');
    let attempts = 0;
    for (let h = 0; h < 24; h++) {
      for (let k = 0; k < 20; k++) {
        await recordFailure(c4, { now: new Date(day.getTime() + h * 3600_000 + k * 170_000) });
        attempts += 1;
      }
    }
    await closeFinishedHour(c4, { now: new Date(day.getTime() + 25 * 3600_000) });
    const [n] = await c4.query<any[]>("SELECT COUNT(*) AS n, MIN(JSON_VALUE(new_row, '$.failures')) AS lo, MAX(JSON_VALUE(new_row, '$.failures')) AS hi FROM audit_log WHERE table_name = 'login_failures'");
    expect(Number(n[0].n)).toBe(24);
    expect([n[0].lo, n[0].hi]).toEqual(['20', '20']);
    expect(attempts).toBe(480);
    const draft4Rows = attempts; // draft 4 wrote a counter row AND an audit row for every attempt
    expect(draft4Rows).toBeGreaterThan(24);
    await c4.end();
    await dropDb(db4);
  }, 60000);
});
