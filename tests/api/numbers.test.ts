import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { type Clock, businessDate, createClock } from '../../src/clock';
import { createDbPool, type DbPool } from '../../src/db/pool';
import { newId } from '../../src/db/ids';
import {
  BILL_PREFIX_PATTERN,
  CATEGORY_PREFIX_PATTERN,
  DEFAULT_DESIGN_PADDING,
  DEFAULT_PIECE_PADDING,
  MAX_SKIPPED_NUMBERS,
  barcodeFor,
  billNumbers,
  businessYear,
  designNumbers,
  ensureSeries,
  ensureSeriesInTx,
  nextBillNo,
  nextNumber,
  openingNumbers,
  pieceNumbers,
  takeNumber,
  type IssuedNumber,
} from '../../src/db/numbers';
import { txContext, withTx, type TxContext } from '../../src/db/tx';
import { BusyError, JvError } from '../../src/errors';
import { errorOf, sleep } from '../helpers';
import { REPO } from './support';
import { dbError, innodbDeadlocks, spyOn, txWorld, type TxWorld } from './tx-support';

// T-C01 (L3, S2, C11), T-F07 (L4) and the numbering clause of T-C16 (L3, IM3): the number counters, the formats, and the ids. Every test that touches the database runs on a scratch database that
// holds the real schema and the audit triggers, as the ten-box user, through the real pool of 8 and the real withTx (API03).

let world: TxWorld;
const pools: DbPool[] = [];
const open = () => {
  const p = createDbPool(world.scratch.db);
  pools.push(p);
  return p;
};
const ACTOR = '11111111-1111-4111-8111-111111111111';
const biller = { id: ACTOR, role: 'biller' };
const ctxFor = (pool: Parameters<typeof txContext>[0], extra: Partial<Parameters<typeof txContext>[1]> = {}): TxContext => txContext(pool, { requestId: randomUUID(), actor: biller, ...extra });
const db = () => `\`${world.scratch.database}\``;

/** A fake clock at an instant given as an ISO time with its offset: the API takes the year from here (S5). */
const clockAt = (iso: string): Clock => createClock(() => BigInt(Date.parse(iso)) * 1000n);
const OCT_2026 = '2026-10-17T10:00:00+05:30';

beforeAll(async () => {
  world = await txWorld('num');
}, 120_000);
afterEach(async () => {
  await Promise.all(pools.splice(0).map((p) => p.end().catch(() => undefined)));
  // each test starts from an empty world: root may delete (the ten-box user cannot, and does not need to)
  await world.root.query(`DELETE FROM ${db()}.bills`);
  await world.root.query(`DELETE FROM ${db()}.sys_import_batches`);
  await world.root.query(`DELETE FROM ${db()}.categories`);
  await world.root.query(`DELETE FROM ${db()}.sys_counters WHERE series <> 'toy:2026'`);
  await world.root.query(`DELETE FROM ${db()}.audit_log`);
});
afterAll(async () => {
  await world?.drop();
}, 60_000);

/** What a toy "create bill" does with the numbering: the series from the clock once, the row made before the transaction, the number inside it, the bill saved with it. */
interface SaveOptions {
  clock?: Clock;
  prefix?: string;
  billDate?: string;
  /** called inside the transaction, right after the number was taken */
  afterNumber?: (issued: IssuedNumber & { skipped: number }) => Promise<void>;
  pool: Pick<DbPool, 'checkout'>;
}
async function saveBill(o: SaveOptions) {
  const numbering = billNumbers((o.clock ?? clockAt(OCT_2026)).read(), o.prefix ?? 'JV');
  const ctx = ctxFor(o.pool);
  await ensureSeries(ctx, numbering.key);
  return withTx(ctx, async (tx) => {
    const issued = await nextBillNo(tx, numbering);
    await o.afterNumber?.(issued);
    const id = newId();
    await tx.run("INSERT INTO bills (id, bill_no, customer_id, bill_date, sale_type, grand_total) VALUES (?, ?, ?, ?, 'Retail', '0.00')", [id, issued.no, world.customers[0], o.billDate ?? '2026-10-17']);
    return { id, bill_no: issued.no, n: issued.n, skipped: issued.skipped };
  });
}

const counterOf = async (series: string): Promise<number | null> => {
  const [rows] = await world.root.query<any[]>(`SELECT last_value FROM ${db()}.sys_counters WHERE series = ?`, [series]);
  return rows.length ? Number(rows[0].last_value) : null;
};
const billNos = async (): Promise<string[]> => {
  const [rows] = await world.root.query<any[]>(`SELECT bill_no FROM ${db()}.bills ORDER BY bill_no`);
  return rows.map((r) => r.bill_no as string);
};
/** Bills as an import leaves them (IM2): a batch, the numbers as given. */
async function importBills(numbers: string[]) {
  const batch = randomUUID();
  await world.root.query(`INSERT INTO ${db()}.sys_import_batches (id, name) VALUES (?, ?)`, [batch, `batch-${batch}`]);
  const rows = numbers.map((no) => [randomUUID(), no, world.customers[0], '2026-01-05', 'Retail', '0.00', batch]);
  await world.root.query(`INSERT INTO ${db()}.bills (id, bill_no, customer_id, bill_date, sale_type, grand_total, import_batch_id) VALUES ?`, [rows]);
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
describe('T-F07 number formats (L4) and the Asia/Kolkata year', () => {
  const clock = clockAt(OCT_2026);

  it('a bill is <prefix>-<YYYY>-<4 digits>, and after 9,999 the digits simply grow', () => {
    const s = billNumbers(clock.read(), 'JV');
    expect(s.key).toBe('bill:JV:2026');
    expect(s.format(1)).toBe('JV-2026-0001');
    expect(s.format(7)).toBe('JV-2026-0007');
    expect(s.format(9999)).toBe('JV-2026-9999');
    expect(s.format(10000)).toBe('JV-2026-10000');
    expect(s.format(123456)).toBe('JV-2026-123456');
    expect(billNumbers(clock.read(), 'AB1').format(42)).toBe('AB1-2026-0042');
  });

  it('an opening-balance bill is OB-<4 digits> in the series "opening"', () => {
    expect(openingNumbers.key).toBe('opening');
    expect(openingNumbers.format(1)).toBe('OB-0001');
    expect(openingNumbers.format(9999)).toBe('OB-9999');
    expect(openingNumbers.format(10000)).toBe('OB-10000');
  });

  it('a design is <category prefix>-<5 digits> (designPadding) in the series design:<CATEGORY PREFIX>', () => {
    const s = designNumbers('RNG');
    expect(s.key).toBe('design:RNG');
    expect(s.format(1)).toBe('RNG-00001');
    expect(s.format(12)).toBe('RNG-00012');
    expect(s.format(100000)).toBe('RNG-100000');
    expect(designNumbers('RNG', 4).format(12)).toBe('RNG-0012'); // the padding is the setting's
  });

  it('a piece is <design_no>-<3 digits> (skuPadding) in the series sku:<design_no>; a barcode is <barcodePrefix>-<sku_no>', () => {
    const s = pieceNumbers('RNG-00012');
    expect(s.key).toBe('sku:RNG-00012');
    expect(s.format(3)).toBe('RNG-00012-003');
    expect(s.format(1000)).toBe('RNG-00012-1000');
    expect(pieceNumbers('RNG-00012', 4).format(3)).toBe('RNG-00012-0003');
    expect(barcodeFor('BC', 'RNG-00012-003')).toBe('BC-RNG-00012-003');
    expect(barcodeFor('XY', 'RNG-00012-003')).toBe('XY-RNG-00012-003');
  });

  it('a bad prefix, padding or number is a bug in the caller and is refused, not formatted', () => {
    for (const bad of ['', ' JV', 'JV ', 'J:V', 'JV-', '-JV', 'A'.repeat(13), 'J_V', 'JÝ']) expect(() => billNumbers(clock.read(), bad), JSON.stringify(bad)).toThrow(TypeError);
    for (const good of ['JV', 'jv', 'J', 'A-B', 'AB12', 'A'.repeat(12)]) expect(BILL_PREFIX_PATTERN.test(good), good).toBe(true);
    const s = billNumbers(clock.read(), 'JV');
    for (const bad of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2]) expect(() => s.format(bad), String(bad)).toThrow(TypeError);
    expect(() => designNumbers('RNG', 0)).toThrow(TypeError);
    expect(() => pieceNumbers('RNG-00001', 11)).toThrow(TypeError);
  });

  it('the category prefix rule and the default paddings are the database\'s: the CHECK of db/migrations/0003 and the seeded settings.numbering', () => {
    const migration = readFileSync(join(REPO, 'db', 'migrations', '0003_settings_rates_catalog.sql'), 'utf8');
    expect(/chk_categories_prefix CHECK \(BINARY prefix REGEXP '([^']+)'\)/.exec(migration)?.[1]).toBe(CATEGORY_PREFIX_PATTERN.source);
    const seeds = readFileSync(join(REPO, 'db', 'seeds', '0101_settings.sql'), 'utf8');
    const numbering = /\('numbering', '(\{[^']+\})'\)/.exec(seeds)?.[1];
    expect(JSON.parse(numbering ?? '{}')).toEqual({ designPadding: DEFAULT_DESIGN_PADDING, skuPadding: DEFAULT_PIECE_PADDING, barcodePrefix: 'BC' });
  });

  it('the year is the Asia/Kolkata year: 23:59:59 on 31 December is still that year, 00:00:01 on 1 January is the next (the UTC date is still 31 December)', () => {
    const before = clockAt('2026-12-31T23:59:59+05:30').read();
    const after = clockAt('2027-01-01T00:00:01+05:30').read();
    expect(before.timestamp.startsWith('2026-12-31 18:29:59')).toBe(true); // the UTC text of the same instants,
    expect(after.timestamp.startsWith('2026-12-31 18:30:01')).toBe(true); // which is why the year may not come from UTC
    expect(businessYear(before)).toBe('2026');
    expect(businessYear(after)).toBe('2027');
    expect(billNumbers(before, 'JV').format(5)).toBe('JV-2026-0005');
    expect(billNumbers(after, 'JV').format(1)).toBe('JV-2027-0001');
    expect(billNumbers(after, 'JV').key).toBe('bill:JV:2027');
    // and the other way round: 1 January 00:00:01 UTC is 05:30:01 in Kolkata, the same year; 20:00 UTC on 31 December is already 1 January 01:30 there
    expect(businessYear(clockAt('2027-01-01T00:00:01Z').read())).toBe('2027');
    expect(businessYear(clockAt('2026-12-31T20:00:00Z').read())).toBe('2027');
    expect(businessDate(clockAt('2026-12-31T20:00:00Z').read().micros)).toBe('2027-01-01');
  });

  it('every day of a year agrees with the zone table: the year of the reading is the year of the Asia/Kolkata date, at 00:00:00, 12:00 and 23:59:59 local time', () => {
    const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric' });
    for (let day = 0; day < 366; day++) {
      for (const hms of ['00:00:00', '12:00:00', '23:59:59']) {
        const d = new Date(Date.UTC(2026, 11, 20 + day, 0, 0, 0));
        const local = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}T${hms}+05:30`;
        const instant = clockAt(local).read();
        expect(businessYear(instant), local).toBe(fmt.format(new Date(Date.parse(local))));
      }
    }
  });

  it('on the database: the bill saved at 23:59:59 on 31 December takes 2026, the one at 00:00:01 on 1 January takes 2027 and starts that year at 0001; a backdated bill still takes the current year', async () => {
    const pool = open();
    const a = await saveBill({ pool, clock: clockAt('2026-12-31T23:59:59+05:30') });
    const b = await saveBill({ pool, clock: clockAt('2027-01-01T00:00:01+05:30') });
    const c = await saveBill({ pool, clock: clockAt('2027-01-01T00:00:02+05:30'), billDate: '2025-06-01' }); // dated last year, saved this year
    expect([a.bill_no, b.bill_no, c.bill_no]).toEqual(['JV-2026-0001', 'JV-2027-0001', 'JV-2027-0002']);
    expect(await counterOf('bill:JV:2026')).toBe(1);
    expect(await counterOf('bill:JV:2027')).toBe(2);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
describe('T-C01 S2: ids are crypto.randomUUID() version 4, made by the API, never a clock or a count', () => {
  it('newId() gives lower-case version-4 UUIDs, 5,000 of them all different', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 5000; i++) {
      const id = newId();
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      seen.add(id);
    }
    expect(seen.size).toBe(5000);
  });

  it('the database accepts the id as a native UUID, and it comes back as the same text', async () => {
    const id = newId();
    const pool = open();
    await withTx(ctxFor(pool), (tx) => tx.run('INSERT INTO categories (id, name, prefix) VALUES (?, ?, ?)', [id, 'Uuid probe', 'UP']));
    const [rows] = await world.root.query<any[]>(`SELECT id FROM ${db()}.categories WHERE name = 'Uuid probe'`);
    expect(rows[0].id).toBe(id);
  });

  it('no SQL in src/ asks the database for an id or a number of its own: no UUID(), UUID_V7(), UUID_SHORT(), and no SELECT LAST_INSERT_ID() (L3)', () => {
    const sqlLike: { file: string; text: string }[] = [];
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((name) => {
        const p = join(dir, name);
        return statSync(p).isDirectory() ? walk(p) : /\.ts$/.test(name) ? [p] : [];
      });
    for (const file of walk(join(REPO, 'src'))) {
      const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
      const visit = (n: ts.Node) => {
        if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) sqlLike.push({ file: relative(REPO, file), text: n.text });
        ts.forEachChild(n, visit);
      };
      visit(sf);
    }
    const bad = sqlLike.filter((l) => /\bUUID\(|\bUUID_V7\(|\bUUID_SHORT\(|SELECT\s+LAST_INSERT_ID\s*\(/i.test(l.text));
    expect(bad).toEqual([]);
    // control: the scanner does see such a literal
    const sf = ts.createSourceFile('x.ts', "const q = 'SELECT LAST_INSERT_ID() AS n';", ts.ScriptTarget.ES2022, true);
    let seen = '';
    ts.forEachChild(sf, function visit(n) {
      if (ts.isStringLiteral(n)) seen = n.text;
      ts.forEachChild(n, visit);
    });
    expect(/SELECT\s+LAST_INSERT_ID\s*\(/i.test(seen)).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
describe('T-C01 the series row exists before the transaction that needs it (L3): a read first, INSERT IGNORE only when it is missing', () => {
  it('a series that exists costs one SELECT 1 and nothing else: no lock, no write, no transaction; the connection goes back', async () => {
    const pool = open();
    await ensureSeries(ctxFor(pool), 'design:RNG');
    const spy = spyOn(pool);
    await ensureSeries(ctxFor(spy.pool), 'design:RNG');
    expect(spy.sent.map((s) => [s.kind, s.sql])).toEqual([['execute', 'SELECT 1 FROM sys_counters WHERE series = ?']]); // (the checkout's own SET SESSION ran before the spy could see it)
    expect(pool.stats()).toMatchObject({ inUse: 0, waiting: 0 });
  });

  it('a missing series is made with INSERT IGNORE on the same checked-out connection, in autocommit (no START TRANSACTION): the row is there and committed, the counter is 0', async () => {
    const pool = open();
    const spy = spyOn(pool);
    await ensureSeries(ctxFor(spy.pool), 'opening');
    expect(spy.sqls()).toEqual(['SELECT 1 FROM sys_counters WHERE series = ?', 'INSERT IGNORE INTO sys_counters (series, last_value) VALUES (?, 0)']);
    expect(new Set(spy.sent.map((s) => s.thread)).size).toBe(1);
    expect(spy.sent.every((s) => s.kind === 'execute' || !/START TRANSACTION|COMMIT/i.test(s.sql))).toBe(true);
    expect(await counterOf('opening')).toBe(0); // visible to another connection: committed
    expect(pool.stats()).toMatchObject({ inUse: 0, waiting: 0 });
  });

  it('the earlier INSERT ... ON DUPLICATE KEY UPDATE series = series is never used (it took the row lock and waited behind the bill before it)', () => {
    expect(readFileSync(join(REPO, 'src', 'db', 'numbers.ts'), 'utf8').replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, '')).not.toMatch(/ON\s+DUPLICATE\s+KEY/i);
  });

  it('twelve calls for the same new series at once: one row, no error, nobody waits behind anybody', async () => {
    const pool = open();
    await Promise.all(Array.from({ length: 12 }, () => ensureSeries(ctxFor(pool), 'design:RACE')));
    const [rows] = await world.root.query<any[]>(`SELECT COUNT(*) AS n FROM ${db()}.sys_counters WHERE series = 'design:RACE'`);
    expect(Number(rows[0].n)).toBe(1);
    expect(await counterOf('design:RACE')).toBe(0);
  });

  it('a series row made for a series nobody has used leaves no audit row and no gap: the first number is 1', async () => {
    const pool = open();
    await ensureSeries(ctxFor(pool), 'design:NEW');
    const [audit] = await world.root.query<any[]>(`SELECT COUNT(*) AS n FROM ${db()}.audit_log`);
    expect(Number(audit[0].n)).toBe(0);
    expect(await withTx(ctxFor(pool), (tx) => takeNumber(tx, 'design:NEW'))).toBe(1);
  });

  it('sku:<design_no> is made inside the transaction of the design (ensureSeriesInTx): the same INSERT IGNORE; it rolls back with the design and does nothing the second time', async () => {
    const pool = open();
    const key = 'sku:RNG-00001';
    await withTx(ctxFor(pool), async (tx) => {
      await ensureSeriesInTx(tx, key);
      await ensureSeriesInTx(tx, key);
      expect(await takeNumber(tx, key)).toBe(1);
      expect(await takeNumber(tx, key)).toBe(2);
    });
    expect(await counterOf(key)).toBe(2);
    const e = await errorOf(() =>
      withTx(ctxFor(pool), async (tx) => {
        await ensureSeriesInTx(tx, 'sku:RNG-00002');
        throw new Error('the design failed');
      }),
    );
    expect(e).toBeInstanceOf(JvError);
    expect(await counterOf('sku:RNG-00002')).toBeNull();
  });

  it('a key that cannot be a series (empty, longer than the column, not text) is a bug in the caller and is refused before any statement', async () => {
    const pool = open();
    const spy = spyOn(pool);
    for (const bad of ['', 'x'.repeat(101), 5 as unknown as string]) {
      expect(await errorOf(() => ensureSeries(ctxFor(spy.pool), bad)), String(bad)).toBeInstanceOf(TypeError);
    }
    expect(spy.sent).toEqual([]);
    expect(await errorOf(() => ensureSeries(ctxFor(spy.pool), 'x'.repeat(100)))).toBeNull(); // the column is 100 characters (INSERT IGNORE would cut a longer key silently)
    expect(await counterOf('x'.repeat(100))).toBe(0);
  });

  it('it is inside the 12-second deadline: a call that is already over it sends nothing and is JV_BUSY (deadline)', async () => {
    const spy = spyOn(open());
    const e = await errorOf(() => ensureSeries(ctxFor(spy.pool, { arrivedAt: 0, now: () => 13_000 }), 'design:LATE'));
    expect(e).toBeInstanceOf(BusyError);
    expect(e).toMatchObject({ code: 'JV_BUSY', reason: 'deadline' });
    expect(spy.sqls().filter((s) => /sys_counters/.test(s))).toEqual([]);
  });

  it('it is inside the error map of S8: a lost connection is JV_BUSY and the connection is destroyed, not handed on', async () => {
    const pool = open();
    const spy = spyOn(pool);
    spy.intercept = (e) => {
      if (/sys_counters/.test(e.sql)) throw Object.assign(new Error('Connection lost: The server closed the connection.'), { code: 'PROTOCOL_CONNECTION_LOST', fatal: true });
    };
    const e = await errorOf(() => ensureSeries(ctxFor(spy.pool), 'design:LOST'));
    expect(e).toMatchObject({ code: 'JV_BUSY', reason: 'connection_lost' });
    expect(pool.stats().inUse).toBe(0);
    spy.intercept = null;
    await ensureSeries(ctxFor(spy.pool), 'design:LOST'); // and the pool is still good
    expect(await counterOf('design:LOST')).toBe(0);
  });

  it('an error that is not busy is mapped as well (a CHECK refusal is JV_INVALID_INPUT and a bug in the log, anything else JV_INTERNAL), never the raw database error', async () => {
    const spy = spyOn(open());
    spy.intercept = (e) => {
      if (/INSERT IGNORE/.test(e.sql)) throw dbError(1146, 'ER_NO_SUCH_TABLE', "Table 'x.sys_counters' doesn't exist");
    };
    const e = await errorOf(() => ensureSeries(ctxFor(spy.pool), 'design:ODD'));
    expect(e).toBeInstanceOf(JvError);
    expect(e).toMatchObject({ code: 'JV_INTERNAL', status: 500 });
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
describe('T-C01 numbers are unique and contiguous (L3)', () => {
  it('50 sequential saves give 50 unique bill numbers JV-2026-0001 to JV-2026-0050, in order, and the counter ends at 50; each result carries its id and its number', async () => {
    const pool = open();
    const got: Awaited<ReturnType<typeof saveBill>>[] = [];
    for (let i = 0; i < 50; i++) got.push(await saveBill({ pool }));
    expect(got.map((g) => g.n)).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
    expect(got.map((g) => g.bill_no)).toEqual(Array.from({ length: 50 }, (_, i) => `JV-2026-${String(i + 1).padStart(4, '0')}`));
    expect(new Set(got.map((g) => g.id)).size).toBe(50);
    for (const g of got) expect(g.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(await billNos()).toEqual(got.map((g) => g.bill_no));
    expect(await counterOf('bill:JV:2026')).toBe(50);
  });

  it('10 concurrent saves (more than half the pool) give 10 unique, contiguous numbers; none is lost or repeated', async () => {
    const pool = open();
    const got = await Promise.all(Array.from({ length: 10 }, () => saveBill({ pool })));
    expect(got.map((g) => g.n).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(new Set(got.map((g) => g.bill_no)).size).toBe(10);
    expect(await counterOf('bill:JV:2026')).toBe(10);
    expect((await billNos()).length).toBe(10);
  });

  it('10 concurrent saves of a series nobody has used yet (1 January): the same, and no deadlock', async () => {
    const before = await innodbDeadlocks(world.root);
    const pool = open();
    const clock = clockAt('2027-01-01T00:00:05+05:30');
    const got = await Promise.all(Array.from({ length: 10 }, () => saveBill({ pool, clock })));
    expect(got.map((g) => g.n).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(await innodbDeadlocks(world.root)).toBe(before);
  });

  it('a failed save uses no number: the next save takes the same number and the counter shows only what was kept', async () => {
    const pool = open();
    expect((await saveBill({ pool })).n).toBe(1);
    const e = await errorOf(() =>
      saveBill({
        pool,
        afterNumber: async (issued) => {
          expect(issued.n).toBe(2); // it did take 2 ...
          throw new JvError('JV_OVERPAYMENT', 'the payment is more than the bill'); // ... and then failed
        },
      }),
    );
    expect(e).toMatchObject({ code: 'JV_OVERPAYMENT' });
    expect(await counterOf('bill:JV:2026')).toBe(1); // given back with the rollback
    expect((await saveBill({ pool })).n).toBe(2);
    // and a bug, a lock timeout and a killed connection give it back as well (T-C19 proves the rollback; here the number)
    await errorOf(() => saveBill({ pool, afterNumber: async () => { throw new TypeError('a bug'); } }));
    expect(await counterOf('bill:JV:2026')).toBe(2);
    expect((await saveBill({ pool })).bill_no).toBe('JV-2026-0003');
    expect(await billNos()).toEqual(['JV-2026-0001', 'JV-2026-0002', 'JV-2026-0003']);
  });

  it('25 percent injected failures after the number was taken, 8 workers: the numbers that were kept are exactly 1..N', async () => {
    const pool = open();
    let injected = 0;
    let kept = 0;
    let seed = 7;
    const rand = () => ((seed = (seed * 48271) % 2147483647) / 2147483647); // a fixed sequence: the test is repeatable
    await Promise.all(
      Array.from({ length: 8 }, async () => {
        for (let i = 0; i < 12; i++) {
          const fail = rand() < 0.25;
          try {
            await saveBill({ pool, afterNumber: async () => { if (fail) throw new JvError('JV_PIECE_UNAVAILABLE', 'injected'); } });
            kept++;
          } catch (e) {
            expect(e).toMatchObject({ code: 'JV_PIECE_UNAVAILABLE' });
            injected++;
          }
        }
      }),
    );
    expect(injected).toBeGreaterThan(10);
    const nos = await billNos();
    expect(nos).toEqual(Array.from({ length: kept }, (_, i) => `JV-2026-${String(i + 1).padStart(4, '0')}`));
    expect(await counterOf('bill:JV:2026')).toBe(kept);
  }, 60_000);

  it('a brand-new series whose first user rolls back while two others wait gives no deadlock: the two take 1 and 2, no gap (the row was made before the transactions)', async () => {
    const before = await innodbDeadlocks(world.root);
    const pool = open();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let tookIt!: () => void;
    const firstHasIt = new Promise<void>((resolve) => (tookIt = resolve));
    const first = errorOf(() =>
      saveBill({
        pool,
        prefix: 'ZZ',
        afterNumber: async (issued) => {
          expect(issued.n).toBe(1);
          tookIt();
          await gate;
          throw new JvError('JV_PIECE_UNAVAILABLE', 'the first user fails');
        },
      }),
    );
    await Promise.race([
      firstHasIt,
      first.then((e) => {
        throw new Error(`the first user ended before it took the number: ${e?.message}`);
      }),
    ]);
    const others = [saveBill({ pool, prefix: 'ZZ' }), saveBill({ pool, prefix: 'ZZ' })]; // both queue behind the counter row
    const settled = Promise.race([Promise.all(others).then(() => 'done'), sleep(600).then(() => 'waiting')]);
    expect(await settled).toBe('waiting');
    release();
    const done = await Promise.all(others);
    expect(await first).toMatchObject({ code: 'JV_PIECE_UNAVAILABLE', message: 'the first user fails' });
    expect(done.map((d) => d.n).sort()).toEqual([1, 2]);
    expect(await innodbDeadlocks(world.root)).toBe(before);
    expect(await counterOf('bill:ZZ:2026')).toBe(2);
  });

  it('NEGATIVE CONTROL: creating the series inside the transaction (the first insert of a new series) DOES deadlock in the same scenario, so the harness is able to see it', async () => {
    const takeFirst = (c: Awaited<ReturnType<typeof world.scratch.connect>>, series: string) =>
      c.query('INSERT INTO sys_counters (series, last_value) VALUES (?, LAST_INSERT_ID(1)) ON DUPLICATE KEY UPDATE last_value = LAST_INSERT_ID(last_value + 1)', [series]);
    const conns = await Promise.all([world.scratch.connect(), world.scratch.connect(), world.scratch.connect()]);
    try {
      const [c1, c2, c3] = conns;
      await c1.query('START TRANSACTION');
      await takeFirst(c1, 'bill:NEG:2026'); // the first user holds the new row, not yet committed
      const waiting = [c2, c3].map(async (x) => {
        await x.query('START TRANSACTION');
        try {
          await takeFirst(x, 'bill:NEG:2026');
          await x.query('COMMIT');
          return null;
        } catch (e) {
          await x.query('ROLLBACK').catch(() => undefined);
          return (e as { errno?: number }).errno ?? null;
        }
      });
      await sleep(500);
      await c1.query('ROLLBACK');
      expect(await Promise.all(waiting)).toContain(1213);
    } finally {
      await Promise.all(conns.map((c) => c.end().catch(() => undefined)));
    }
  });

  it('if the row was NOT made first, the numbering step does not make it up: an UPDATE that changes no row is JV_INTERNAL (a bug), and nothing is created or used', async () => {
    const pool = open();
    const spy = spyOn(pool);
    const e = await errorOf(() => withTx(ctxFor(spy.pool), (tx) => takeNumber(tx, 'bill:NOPE:2026')));
    expect(e).toBeInstanceOf(JvError);
    expect(e).toMatchObject({ code: 'JV_INTERNAL', status: 500 });
    expect(spy.sqls()).toContain('UPDATE sys_counters SET last_value = LAST_INSERT_ID(last_value + 1) WHERE series = ?'); // the statement ran and changed nothing: that is what was answered
    expect(spy.sqls().some((q) => /^INSERT/i.test(q))).toBe(false); // and no row was made up
    expect(await counterOf('bill:NOPE:2026')).toBeNull();
    const e2 = await errorOf(() => withTx(ctxFor(pool), (tx) => nextBillNo(tx, billNumbers(clockAt(OCT_2026).read(), 'NOPE'))));
    expect(e2).toMatchObject({ code: 'JV_INTERNAL' });
    expect(await counterOf('bill:NOPE:2026')).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
describe('T-C01 the number is the insertId of the counter UPDATE (L3)', () => {
  it('one statement, exactly the spec\'s: UPDATE sys_counters SET last_value = LAST_INSERT_ID(last_value + 1) WHERE series = ?, and nothing is sent after it to read the value', async () => {
    const pool = open();
    await ensureSeries(ctxFor(pool), 'design:ONE');
    const spy = spyOn(pool);
    const n = await withTx(ctxFor(spy.pool), (tx) => takeNumber(tx, 'design:ONE'));
    expect(n).toBe(1);
    const sql = spy.sqls();
    const at = sql.indexOf('UPDATE sys_counters SET last_value = LAST_INSERT_ID(last_value + 1) WHERE series = ?');
    expect(at).toBeGreaterThan(-1);
    expect(sql.slice(at + 1)).toEqual(['COMMIT', 'SET @jv_actor = NULL, @jv_role = NULL, @jv_request = NULL']); // only the wrapper's own statements follow
    expect(sql.some((s) => /SELECT\s+LAST_INSERT_ID/i.test(s))).toBe(false);
  });

  it('it stays right after an audit row (an AUTO_INCREMENT table) was inserted; a SELECT LAST_INSERT_ID() at that point answers the audit row\'s id (the control)', async () => {
    await world.root.query(`ALTER TABLE ${db()}.audit_log AUTO_INCREMENT = 86857`); // the review run read 86,857 where the number was 43
    const pool = open();
    const key = 'bill:JV:2026';
    await ensureSeries(ctxFor(pool), key);
    const out = await withTx(ctxFor(pool), async (tx) => {
      const n = await takeNumber(tx, key);
      await tx.run("INSERT INTO audit_log (at, actor_role, table_name, row_id, action) VALUES (?, 'owner', 'probe', 'x', 'event')", ['2026-10-17 10:00:00.000000']);
      const [{ id }] = await tx.rows<{ id: string }>('SELECT LAST_INSERT_ID() AS id');
      return { n, wrong: Number(id) };
    });
    expect(out.n).toBe(1);
    expect(out.wrong).toBe(86857); // the trap is real on this server: this is what the old statement would have used as the bill number
    expect(await counterOf(key)).toBe(1);
  });

  it('a bill saved with audit rows written before and after the number (the real trigger, and a direct audit insert) carries the counter\'s value as its number', async () => {
    await world.root.query(`ALTER TABLE ${db()}.audit_log AUTO_INCREMENT = 5000`);
    const pool = open();
    const numbering = billNumbers(clockAt(OCT_2026).read(), 'JV');
    await ensureSeries(ctxFor(pool), numbering.key);
    const out = await withTx(ctxFor(pool), async (tx) => {
      await tx.run('INSERT INTO categories (id, name, prefix) VALUES (?, ?, ?)', [newId(), 'before', 'BF']); // the trigger writes an audit row (an auto id)
      const issued = await nextBillNo(tx, numbering);
      await tx.run('INSERT INTO categories (id, name, prefix) VALUES (?, ?, ?)', [newId(), 'after', 'AF']);
      await tx.run("INSERT INTO audit_log (at, actor_role, table_name, row_id, action) VALUES (?, 'owner', 'probe', 'y', 'event')", ['2026-10-17 10:00:00.000000']);
      return issued;
    });
    expect(out).toMatchObject({ n: 1, no: 'JV-2026-0001' });
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
describe('T-C01 a lock wait on the counter is JV_BUSY after 5 seconds, through the error map (S8), never a raw 1205', () => {
  const key = 'bill:JV:2026';

  it('the counter row held for 6.5 s by another transaction: the series row is NOT waited for (the read takes no lock), the number step answers JV_BUSY after 5 s', async () => {
    const pool = open();
    await ensureSeries(ctxFor(pool), key);
    const holder = await world.scratch.connect();
    await holder.query('START TRANSACTION');
    await holder.query('UPDATE sys_counters SET last_value = last_value + 1 WHERE series = ?', [key]); // the bill before it, not yet committed
    const release = sleep(6500).then(() => holder.query('ROLLBACK').then(() => holder.end()));
    const t0 = Date.now();
    let ensuredAfter = -1;
    const e = await errorOf(async () => {
      const ctx = ctxFor(pool);
      await ensureSeries(ctx, key);
      ensuredAfter = Date.now() - t0;
      await withTx(ctx, (tx) => nextBillNo(tx, billNumbers(clockAt(OCT_2026).read(), 'JV')));
    });
    const took = Date.now() - t0;
    expect(ensuredAfter).toBeGreaterThanOrEqual(0);
    expect(ensuredAfter).toBeLessThan(1000); // it did not queue behind the bill before it
    expect(e).toBeInstanceOf(BusyError);
    expect(e).toMatchObject({ code: 'JV_BUSY', status: 503, reason: 'lock_wait', retryAfter: 1 });
    expect((e as BusyError).cause).toMatchObject({ errno: 1205 }); // the raw error is the cause for the log, not the answer
    expect(took).toBeGreaterThanOrEqual(4800);
    expect(took).toBeLessThan(6400); // before the holder lets go at 6.5 s
    await release;
    expect(await counterOf(key)).toBe(0); // nothing was used
    expect((await saveBill({ pool })).n).toBe(1);
  }, 30_000);

  it('a new series row held, uncommitted, by someone else for 6.5 s: the INSERT IGNORE of ensureSeries waits the 5 s and is JV_BUSY through the map (not a raw 1205)', async () => {
    const pool = open();
    const holder = await world.scratch.connect();
    await holder.query('START TRANSACTION');
    await holder.query("INSERT INTO sys_counters (series, last_value) VALUES ('design:HELD', 0)");
    const release = sleep(6500).then(() => holder.query('ROLLBACK').then(() => holder.end()));
    const t0 = Date.now();
    const e = await errorOf(() => ensureSeries(ctxFor(pool), 'design:HELD'));
    const took = Date.now() - t0;
    expect(e).toBeInstanceOf(BusyError);
    expect(e).toMatchObject({ code: 'JV_BUSY', status: 503, reason: 'lock_wait' });
    expect((e as BusyError).cause).toMatchObject({ errno: 1205 });
    expect(took).toBeGreaterThanOrEqual(4800);
    expect(took).toBeLessThan(6400);
    expect(pool.stats().inUse).toBe(0);
    await release;
  }, 30_000);
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
describe('T-C01 / T-C16 numbering skips an imported number by looking ahead with a read (L3, IM3)', () => {
  const seed = (last: number, prefix = 'JV') => world.root.query(`INSERT INTO ${db()}.sys_counters (series, last_value, seed_value) VALUES (?, ?, ?)`, [`bill:${prefix}:2026`, last, last]);

  it('an imported JV-2026-0007 with the counter at 6 continues to JV-2026-0008: the 7 is skipped, no duplicate-key error is raised, and the bill is saved', async () => {
    await importBills(['JV-2026-0003', 'JV-2026-0007']);
    await seed(6);
    const pool = open();
    const spy = spyOn(pool);
    const saved = await saveBill({ pool: spy.pool });
    expect(saved).toMatchObject({ bill_no: 'JV-2026-0008', n: 8, skipped: 1 });
    const sql = spy.sqls().filter((s) => /bills|sys_counters/.test(s));
    expect(sql).toEqual([
      'SELECT 1 FROM sys_counters WHERE series = ?',
      'UPDATE sys_counters SET last_value = LAST_INSERT_ID(last_value + 1) WHERE series = ?',
      'SELECT 1 FROM bills WHERE bill_no = ?',
      'UPDATE sys_counters SET last_value = LAST_INSERT_ID(last_value + 1) WHERE series = ?',
      'SELECT 1 FROM bills WHERE bill_no = ?',
      "INSERT INTO bills (id, bill_no, customer_id, bill_date, sale_type, grand_total) VALUES (?, ?, ?, ?, 'Retail', '0.00')",
    ]);
    expect(await billNos()).toEqual(['JV-2026-0003', 'JV-2026-0007', 'JV-2026-0008']);
    expect(await counterOf('bill:JV:2026')).toBe(8);
    expect((await saveBill({ pool })).bill_no).toBe('JV-2026-0009'); // and it carries on from there
  });

  it('no next-key lock is left: while the transaction that skipped the number is still open, a second connection inserts into the gap before the imported number and after it, and neither waits', async () => {
    await importBills(['PQ-2026-0003', 'PQ-2026-0007']); // (its own prefix: index entries of rows deleted by an earlier test linger until the server purges them and would move the gap)
    await seed(6, 'PQ');
    const pool = open();
    const times: number[] = [];
    const insertBill = async (c: Awaited<ReturnType<typeof world.scratch.connect>>, no: string) => {
      const t0 = Date.now();
      await c.query("INSERT INTO bills (id, bill_no, customer_id, bill_date, sale_type, grand_total) VALUES (?, ?, ?, '2026-10-17', 'Retail', 0)", [newId(), no, world.customers[1]]);
      times.push(Date.now() - t0);
    };
    const saved = await saveBill({
      pool,
      prefix: 'PQ',
      afterNumber: async (issued) => {
        expect(issued.no).toBe('PQ-2026-0008'); // the transaction is open and has skipped 0007
        const other = await world.scratch.connect();
        try {
          await other.query('SET SESSION innodb_lock_wait_timeout = 1');
          await insertBill(other, 'PQ-2026-0005'); // in the gap before the imported number
          await insertBill(other, 'PQ-2026-0009'); // after it
        } finally {
          await other.end();
        }
      },
    });
    expect(saved.bill_no).toBe('PQ-2026-0008');
    expect(times).toHaveLength(2);
    for (const t of times) expect(t).toBeLessThan(900); // a lock would have waited the full 1 s and failed with 1205
  });

  it('NEGATIVE CONTROL: a duplicate-key insert that is caught leaves its next-key lock until the commit: the same neighbour then waits the whole lock timeout (1205)', async () => {
    await importBills(['NQ-2026-0003', 'NQ-2026-0007']);
    const a = await world.scratch.connect();
    const b = await world.scratch.connect();
    try {
      await a.query('START TRANSACTION');
      const dup = await errorOf(() => a.query("INSERT INTO bills (id, bill_no, customer_id, bill_date, sale_type, grand_total) VALUES (?, 'NQ-2026-0007', ?, '2026-10-17', 'Retail', 0)", [newId(), world.customers[0]]));
      expect(dup?.errno).toBe(1062); // caught, and the transaction carries on, which S12 forbids
      await b.query('SET SESSION innodb_lock_wait_timeout = 1');
      const t0 = Date.now();
      const neighbour = await errorOf(() => b.query("INSERT INTO bills (id, bill_no, customer_id, bill_date, sale_type, grand_total) VALUES (?, 'NQ-2026-0005', ?, '2026-10-17', 'Retail', 0)", [newId(), world.customers[1]]));
      expect(neighbour?.errno).toBe(1205);
      expect(Date.now() - t0).toBeGreaterThanOrEqual(900);
      await a.query('ROLLBACK');
    } finally {
      await a.end().catch(() => undefined);
      await b.end().catch(() => undefined);
    }
  });

  it('at most 100 numbers are skipped: with 100 imported numbers ahead the 101st is taken; with 101 ahead the answer is JV_INVALID_INPUT and no number is used', async () => {
    expect(MAX_SKIPPED_NUMBERS).toBe(100);
    await importBills(Array.from({ length: 100 }, (_, i) => `JV-2026-${String(i + 1).padStart(4, '0')}`));
    const pool = open();
    const ok = await saveBill({ pool });
    expect(ok).toMatchObject({ n: 101, bill_no: 'JV-2026-0101', skipped: 100 });
    await importBills(Array.from({ length: 101 }, (_, i) => `JV-2026-${String(i + 102).padStart(4, '0')}`)); // 0102 to 0202
    const e = await errorOf(() => saveBill({ pool }));
    expect(e).toBeInstanceOf(JvError);
    expect(e).toMatchObject({ code: 'JV_INVALID_INPUT', status: 422 });
    expect(await counterOf('bill:JV:2026')).toBe(101); // the 101 attempts were rolled back with the call
    expect((await billNos()).includes('JV-2026-0202')).toBe(true);
  }, 60_000);

  it('the opening series skips an imported OB number the same way (OB-0001 imported: the first function-issued one is OB-0002)', async () => {
    await importBills(['OB-0001']);
    const pool = open();
    await ensureSeries(ctxFor(pool), openingNumbers.key);
    const issued = await withTx(ctxFor(pool), (tx) => nextBillNo(tx, openingNumbers));
    expect(issued).toEqual({ n: 2, no: 'OB-0002', skipped: 1 });
  });

  it('the match is the unique key\'s: an imported number typed in lower case is found, so it is skipped too (utf8mb4_unicode_ci)', async () => {
    await importBills(['jv-2026-0001']);
    const pool = open();
    expect((await saveBill({ pool })).bill_no).toBe('JV-2026-0002');
  });

  it('a duplicate-key error on a bill\'s number is never caught: a bill inserted with a number that exists answers JV_INTERNAL, and rolls everything back', async () => {
    await importBills(['JV-2026-0001']);
    const pool = open();
    const e = await errorOf(() =>
      withTx(ctxFor(pool), async (tx) => {
        await tx.run('INSERT INTO categories (id, name, prefix) VALUES (?, ?, ?)', [newId(), 'kept?', 'KP']);
        await tx.run("INSERT INTO bills (id, bill_no, customer_id, bill_date, sale_type, grand_total) VALUES (?, 'JV-2026-0001', ?, '2026-10-17', 'Retail', 0)", [newId(), world.customers[0]]);
      }),
    );
    expect(e).toBeInstanceOf(JvError);
    expect(e).toMatchObject({ code: 'JV_INTERNAL', status: 500 });
    expect(Number((await world.root.query<any[]>(`SELECT COUNT(*) AS n FROM ${db()}.categories`))[0][0].n)).toBe(0);
  });

  it('numbers the caller does not look ahead for (designs, pieces) are plain: nextNumber gives n and the formatted number', async () => {
    const pool = open();
    const design = designNumbers('RNG');
    await ensureSeries(ctxFor(pool), design.key);
    const a = await withTx(ctxFor(pool), (tx) => nextNumber(tx, design));
    const b = await withTx(ctxFor(pool), (tx) => nextNumber(tx, design));
    expect([a, b]).toEqual([
      { n: 1, no: 'RNG-00001' },
      { n: 2, no: 'RNG-00002' },
    ]);
  });
});
