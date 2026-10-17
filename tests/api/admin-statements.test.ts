import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Connection } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clearLoginCounters as scriptClear, recordPull as scriptPull } from '../../scripts/housekeeping.mjs';
import { CLEAR_COUNTERS_SQL, RECORD_PULL_SQL, clearLoginCounters, recordPull } from '../../src/db/adminStatements';
import { type DbPool, createDbPool } from '../../src/db/pool';
import { type Tx, txContext, withTx } from '../../src/db/tx';
import { type Scratch, scratchDatabase } from '../helpers';
import { REPO } from './support';

// T-D27 (U3, O54): the two statements of the admin door are the database half's (scripts/housekeeping.mjs clearLoginCounters and recordPull, MB05, tested by tests/schema/s18-housekeeping.test.ts).
// The build compiles src/ alone, so src cannot import the .mjs file; src/db/adminStatements.ts is its twin, as src/db/errorLog.ts is the twin of logError, and this file keeps the two identical.

let scratch: Scratch;
let sql: Connection;
let pool: DbPool;
beforeAll(async () => {
  scratch = await scratchDatabase('admstmt', { schema: true });
  sql = await scratch.connect();
  pool = createDbPool(scratch.db);
}, 120_000);
afterAll(async () => {
  await pool?.end();
  await sql?.end();
  await scratch?.drop();
});

const normalise = (text: string) => text.replace(/\s+/g, ' ').trim();
const inTx = <T>(fn: (tx: Tx) => Promise<T>) => withTx(txContext(pool, { requestId: randomUUID(), actor: { id: null, role: 'admin-cli' } }), fn);
const counters = async () => (await sql.query<any[]>("SELECT scope, slot, n, TIMESTAMPDIFF(SECOND, window_start, UTC_TIMESTAMP(6)) AS age FROM sys_login_attempts ORDER BY scope, slot"))[0].map((r: any) => ({ scope: r.scope, slot: r.slot, n: Number(r.n), fresh: Number(r.age) < 30 }));
const seed = async () => {
  await sql.query(
    "INSERT INTO sys_login_attempts (scope, slot, window_start, n) VALUES ('email', 1, '2026-01-01 00:00:00.000000', 9), ('email', 1000, '2026-01-01 00:00:00.000000', 4), ('addr', 2, '2026-01-01 00:00:00.000000', 25), ('any', 0, '2026-01-01 00:00:00.000000', 70), ('audit', 0, '2026-01-01 00:00:00.000000', 13) ON DUPLICATE KEY UPDATE window_start = VALUES(window_start), n = VALUES(n)",
  );
};

describe('T-D27 the twin of MB05\'s clearLoginCounters', () => {
  it('the statement is the script\'s, character for character (whitespace aside)', () => {
    const script = normalise(readFileSync(join(REPO, 'scripts', 'housekeeping.mjs'), 'utf8'));
    expect(script).toContain(normalise(CLEAR_COUNTERS_SQL));
  });

  it('leaves the same rows for the same table: n = 0 and the window to now on the scopes email, addr and any; the summary row untouched; the same count', async () => {
    await seed();
    const viaScript = await scriptClear(sql as never);
    const afterScript = await counters();
    await seed();
    const viaTwin = await inTx((tx) => clearLoginCounters(tx));
    const afterTwin = await counters();
    expect(viaTwin).toEqual(viaScript);
    expect(viaTwin).toEqual({ cleared: 4 });
    expect(afterTwin).toEqual(afterScript);
    expect(afterTwin.filter((r) => r.scope !== 'audit').every((r) => r.n === 0 && r.fresh)).toBe(true);
    expect(afterTwin.find((r) => r.scope === 'audit')).toMatchObject({ n: 13, fresh: false });
  });
});

describe('T-D27 the twin of MB05\'s recordPull', () => {
  it('the statement is the script\'s, character for character (whitespace aside)', () => {
    const script = normalise(readFileSync(join(REPO, 'scripts', 'housekeeping.mjs'), 'utf8'));
    expect(script).toContain(normalise(RECORD_PULL_SQL));
  });

  const value = async () => {
    const v = (await sql.query<any[]>("SELECT value FROM settings WHERE setting_key = 'last_pulled'"))[0][0].value;
    return typeof v === 'string' ? v : JSON.stringify(v);
  };

  it('writes the same value (the same keys in the same order) for the same pull, insert and replace alike', async () => {
    const pull = { at: '2026-10-16T05:00:00.000Z', by: 'admin-cli', file: 'daily/2026-10-16.enc', sha256: randomBytes(32).toString('hex').toUpperCase() };
    await scriptPull(sql as never, pull);
    const viaScript = await value();
    await inTx((tx) => recordPull(tx, { ...pull, file: 'monthly/2026-10.enc' })); // a different pull first, so that the twin has something to replace
    expect(await value()).not.toBe(viaScript);
    expect(await inTx((tx) => recordPull(tx, pull))).toEqual({ recorded: true });
    expect(await value()).toBe(viaScript);
    expect(JSON.parse(viaScript)).toEqual({ at: pull.at, by: 'admin-cli', file: 'daily/2026-10-16.enc', sha256: pull.sha256.toLowerCase() });
    expect(Number((await sql.query<any[]>("SELECT COUNT(*) AS n FROM settings WHERE setting_key = 'last_pulled'"))[0][0].n)).toBe(1);
  });

  it('refuses what the script refuses, with the same words', async () => {
    const good = { at: '2026-10-16T05:00:00.000Z', by: 'admin-cli', file: 'daily/2026-10-16.enc', sha256: 'a'.repeat(64) };
    const bad = [
      { ...good, at: 'yesterday' },
      { ...good, at: 5 },
      { ...good, by: '  ' },
      { ...good, by: 7 },
      { ...good, file: '../daily/2026-10-16.enc' },
      { ...good, file: 'daily/2026-10-16.txt' },
      { ...good, sha256: 'a'.repeat(63) },
      { ...good, sha256: 'g'.repeat(64) },
    ];
    for (const pull of bad) {
      let scriptMessage = '';
      try {
        await scriptPull(sql as never, pull as never);
      } catch (e) {
        scriptMessage = (e as Error).message;
      }
      expect(scriptMessage, JSON.stringify(pull)).not.toBe('');
      let twinMessage = '';
      try {
        await recordPull({ run: async () => ({}) as never }, pull as never);
      } catch (e) {
        twinMessage = (e as Error).message;
      }
      expect(twinMessage, JSON.stringify(pull)).toBe(scriptMessage);
    }
  });
});
