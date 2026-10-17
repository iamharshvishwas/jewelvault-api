import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Connection } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../../scripts/migrate.mjs';
import { runInvariants } from '../../scripts/invariants.mjs';
import { VOLUMES, emptinessProblems, parseArgs, seedVolume } from '../../scripts/seed-volume.mjs';
import { READ_COLUMNS } from '../../src/permissions/matrix';
import { pageStatement } from '../../src/sync/page';
import { SYNC_RESOURCES } from '../../src/sync/resources';
import { V, insert } from '../schema/support';
import { type World, makeWorld } from './cells';
import { REPO } from './support';
import { loadCatalogue } from './static-explain-lib';
import { SYNC_ROWS, pageAll } from './sync-support';

// T-F03 (C2): scripts/seed-volume.mjs (npm run seed:volume -- <lane>) fills an EMPTY lane or staging database with the volumes of C2 through the import library of the database half, and refuses
// anything else. The paging tests of API11, the hydrate tests of WEB03 and the 10-second measurement of OPS04 read it. Here: the full volumes into a scratch database built like a lane
// (migrations, seeds, the audit triggers), the rule that it refuses a second run, the command line, and the read side hydrating the result through the real routes.

const run = promisify(execFile);
const count = async (c: Connection, table: string, where = '1=1') => Number(((await c.query<any[]>(`SELECT COUNT(*) AS n FROM \`${table}\` WHERE ${where}`))[0] as any[])[0].n);

describe('T-F03 seed-volume: the C2 volumes (2,500 pieces over 600 designs, 2,000 customers, 3,000 bills with receipts) into an empty database', () => {
  let world: World;
  let seeded: Awaited<ReturnType<typeof seedVolume>>;
  let ms = 0;

  beforeAll(async () => {
    world = await makeWorld({ label: 'seedv', routes: true });
    await migrate(world.sql, { seeds: true, optional: true }); // a lane's database: migrations, seeds and the 28 audit triggers
    const t0 = Date.now();
    seeded = await seedVolume(world.sql);
    ms = Date.now() - t0;
  }, 300_000);
  afterAll(async () => {
    await world?.close();
  });

  it('the volumes are the ones of C2, and nothing else is sized by chance', () => {
    expect(VOLUMES).toEqual({ customers: 2000, designs: 600, pieces: 2500, bills: 3000 });
  });

  it('fills them in under 2 minutes', () => {
    console.log(`[seed-volume] ${ms} ms for ${JSON.stringify(seeded.counts)}`);
    expect(ms).toBeLessThan(120_000);
  });

  it('writes 2,500 pieces over 600 designs, 2,000 customers (the walk-in is one of them) and 3,000 bills, with lines, receipts and allocations', async () => {
    const c = world.sql;
    expect(await count(c, 'skus')).toBe(2500);
    expect(await count(c, 'designs')).toBe(600);
    expect(await count(c, 'customers')).toBe(2000);
    expect(await count(c, 'bills')).toBe(3000);
    expect(await count(c, 'sku_private')).toBe(2500);
    expect(await count(c, 'bills', "doc_type = 'opening_balance'")).toBeGreaterThan(500);
    expect(await count(c, 'bill_items')).toBeGreaterThan(1500);
    expect(await count(c, 'receipts')).toBeGreaterThan(1000);
    expect(await count(c, 'receipt_allocations')).toBeGreaterThan(1000);
    expect(await count(c, 'skus', "status = 'Sold'")).toBeGreaterThan(1500);
    expect(await count(c, 'skus', "status = 'In Stock'")).toBeGreaterThan(200);
    expect(seeded.counts).toMatchObject({ pieces: 2500, designs: 600, customers: 2000, bills: 3000 });
  });

  it('I1 to I7 and I10 are true on the result (and the whole nightly check with them)', async () => {
    const r = await runInvariants(world.sql);
    for (const id of ['I1', 'I2', 'I3', 'I4', 'I5', 'I6', 'I7', 'I10']) expect(r.counts[id], id).toBe(0);
    expect(r.rows).toEqual([]);
    expect(r.ok).toBe(true);
    expect(seeded.invariants.ok).toBe(true);
  });

  it('a second run is refused, before it writes anything', async () => {
    const before = { skus: await count(world.sql, 'skus'), bills: await count(world.sql, 'bills'), batches: await count(world.sql, 'sys_import_batches') };
    await expect(seedVolume(world.sql)).rejects.toThrow(/not empty/i);
    expect({ skus: await count(world.sql, 'skus'), bills: await count(world.sql, 'bills'), batches: await count(world.sql, 'sys_import_batches') }).toEqual(before);
  });

  it('the result is a believable shop: the stamps are fresh (one re-stamp at the end, IM1) and data_epoch moved (C4)', async () => {
    const [[row]] = await world.sql.query<any[][]>("SELECT value, (SELECT MAX(updated_at) FROM bills) AS newest, (SELECT MIN(updated_at) FROM bills) AS oldest FROM settings WHERE setting_key = 'data_epoch'");
    const epoch = (typeof (row as any).value === 'string' ? JSON.parse((row as any).value) : (row as any).value).epoch as string;
    expect(epoch).not.toBe('1970-01-01 00:00:00.000000');
    // the rows of the bulk part carry one stamp: no row is older than the transaction that wrote it (a transaction lasts under 20 seconds, S12)
    const spread = (new Date(`${String((row as any).newest).replace(' ', 'T')}Z`).getTime() - new Date(`${String((row as any).oldest).replace(' ', 'T')}Z`).getTime()) / 1000;
    expect(spread).toBeLessThan(120);
  });

  it('the read side hydrates it through the real routes: every resource arrives in pages of at most 1,000, the counts are the database\'s', async () => {
    const t0 = Date.now();
    const sizes: Record<string, number> = {};
    for (const r of SYNC_ROWS) {
      const { rows, pages } = await pageAll(world, 'owner', r.name);
      sizes[r.name] = rows.length;
      expect(new Set(rows.map((x) => x.id ?? x.setting_key ?? x.sku_id)).size, r.name).toBe(rows.length);
      for (const p of pages) expect(p.rows.length).toBeLessThanOrEqual(1000);
    }
    console.log(`[seed-volume] the owner's hydrate through inject(): ${Date.now() - t0} ms ${JSON.stringify(sizes)}`);
    expect(sizes.skus).toBe(2500);
    expect(sizes.designs).toBe(600);
    expect(sizes.customers).toBe(2000);
    expect(sizes.bills).toBe(3000);
    expect(sizes['bill-summary']).toBe(3000);
    expect(sizes['customer-balances']).toBe(2000);
    expect(sizes['sku-private']).toBe(2500);
    expect(sizes['bill-items']).toBe(await count(world.sql, 'bill_items'));
    expect(sizes.receipts).toBe(await count(world.sql, 'receipts'));
    expect(sizes['receipt-allocations']).toBe(await count(world.sql, 'receipt_allocations'));
  }, 180_000);
});

describe('T-F03 / T-D11 EXPLAIN on the volumes of C2: the (updated_at, key) index is the one MariaDB uses for the page of every resource (A7, C4, D19)', () => {
  let world: World;
  beforeAll(async () => {
    world = await makeWorld({ label: 'seedx', routes: true });
    await migrate(world.sql, { seeds: true, optional: false });
    await seedVolume(world.sql);
  }, 300_000);
  afterAll(async () => {
    await world?.close();
  });

  it('with a cursor at the newest stamp (the poll of a quiet shop, with and without a key) the optimizer reads the table through that index; with no cursor (the hydrate\'s first page) the plan is its own business', async () => {
    const cat = await loadCatalogue(world.sql);
    const problems: string[] = [];
    for (const r of SYNC_RESOURCES) {
      const pk = cat.primaryKeys.get(r.from) ?? [];
      const index = (cat.indexes.get(r.from) ?? []).find((i) => i.columns[0] === 'updated_at' && pk.every((k, n) => i.columns[n + 1] === k));
      if (!index) {
        problems.push(`${r.from}: no (updated_at, ${pk.join(', ')}) index`);
        continue;
      }
      const [[newest]] = await world.sql.query<any[][]>(`SELECT DATE_FORMAT(DATE_ADD(MAX(updated_at), INTERVAL 1 MICROSECOND), '%Y-%m-%d %H:%i:%s.%f') AS t FROM \`${r.from}\``);
      const at = (newest as any).t ?? '2026-10-17 00:00:00.000000';
      const key = r.keyType === 'uuid' ? '00000000-0000-4000-8000-000000000000' : 'a';
      const columns = r.derived === null ? (Object.values(READ_COLUMNS[r.table]).find((c) => c) ?? []) : [];
      const forms: [string, Parameters<typeof pageStatement>[2], unknown[]][] = [
        ['no cursor', undefined, [1000]],
        ['stamp only', { updatedAt: at, key: null }, [at, 1000]],
        ['stamp and key', { updatedAt: at, key }, [at, at, key, 1000]],
      ];
      for (const [label, after, params] of forms) {
        const sql = pageStatement(r, columns, after, 0);
        const [plan] = await world.sql.query<any[]>(`EXPLAIN ${sql}`, params);
        const row = plan.find((p: any) => p.table === 'src');
        if (!row) problems.push(`${r.name} ${label}: no plan row for the table`);
        // the first page of a hydrate has no comparison at all and reads the table from its start: for a table of a few thousand rows the optimizer may sort it whole, which costs nothing here and is
        // not what A7 judges (the comparison `updated_at > ?` is). Every poll, with or without a key, is a range on the index.
        else if (label !== 'no cursor' && row.key !== index.name) problems.push(`${r.name} ${label}: key ${row.key} (type ${row.type}), the index is ${index.name}`);
      }
    }
    expect(problems).toEqual([]);
  });
});

describe('T-F03 seed-volume: what it refuses, and the command line', () => {
  let world: World;
  beforeAll(async () => {
    world = await makeWorld({ label: 'seedr' });
    await migrate(world.sql, { seeds: true, optional: false });
  }, 120_000);
  afterAll(async () => {
    await world?.close();
  });

  const small = { customers: 40, designs: 8, pieces: 30, bills: 50 };

  it('refuses a database that has any design, piece, customer (the walk-in aside), bill, receipt or import batch, and names what it found', async () => {
    expect(await emptinessProblems(world.sql)).toEqual([]);
    const category = (await world.sql.query<any[]>('SELECT id FROM categories LIMIT 1'))[0][0].id as string;
    await insert(world.sql, 'designs', V.design(category));
    expect((await emptinessProblems(world.sql)).join(' ')).toMatch(/designs/);
    await expect(seedVolume(world.sql, small)).rejects.toThrow(/not empty.*designs/i);
    expect(await count(world.sql, 'customers')).toBe(1); // nothing was written: the walk-in alone
    expect(await count(world.sql, 'sys_import_batches')).toBe(0);
  });

  it('refuses a database with no seeds (the categories, the walk-in and the settings are the import\'s ground)', async () => {
    const empty = await (await import('../helpers')).scratchDatabase('seednos', { schema: true });
    const c = await empty.connect();
    try {
      await expect(seedVolume(c, small)).rejects.toThrow(/seed/i);
    } finally {
      await c.end();
      await empty.drop();
    }
  });

  it('refuses volumes that cannot be built: more bills than the customers and pieces allow, a number that is not a count', async () => {
    const fresh = await (await import('../helpers')).scratchDatabase('seedbad', { schema: true });
    const c = await fresh.connect();
    try {
      await migrate(c, { seeds: true, optional: false });
      await expect(seedVolume(c, { customers: 5, designs: 2, pieces: 6, bills: 100 })).rejects.toThrow(/bills/i);
      await expect(seedVolume(c, { customers: 40, designs: 8, pieces: 30, bills: -1 })).rejects.toThrow(/bills/i);
      await expect(seedVolume(c, { customers: 40, designs: 100, pieces: 30, bills: 50 })).rejects.toThrow(/designs/i);
      expect(await count(c, 'customers')).toBe(1);
    } finally {
      await c.end();
      await fresh.drop();
    }
  });

  it('a small seed is a whole one: invariants hold for the smallest shop too', async () => {
    const fresh = await (await import('../helpers')).scratchDatabase('seedsm', { schema: true });
    const c = await fresh.connect();
    try {
      await migrate(c, { seeds: true, optional: true });
      const r = await seedVolume(c, small);
      expect(r.counts).toMatchObject({ customers: 40, designs: 8, pieces: 30, bills: 50 });
      expect((await runInvariants(c)).ok).toBe(true);
    } finally {
      await c.end();
      await fresh.drop();
    }
  });

  it('the command line: a lane name or --env; anything else is a usage error', () => {
    expect(parseArgs(['c'])).toMatchObject({ target: { kind: 'lane', lane: 'c' } });
    expect(parseArgs(['a'])).toMatchObject({ target: { kind: 'lane', lane: 'a' } });
    expect(parseArgs(['--env'])).toMatchObject({ target: { kind: 'env' } });
    expect(parseArgs(['c', '--customers', '40', '--designs', '8', '--pieces', '30', '--bills', '50']).volumes).toEqual(small);
    expect(parseArgs(['c']).volumes).toEqual(VOLUMES);
    for (const bad of [[], ['zz'], ['c', '--env'], ['c', '--bills'], ['c', '--bills', 'many'], ['c', '--nothing', '1'], ['c', 'a']]) expect(() => parseArgs(bad), JSON.stringify(bad)).toThrow(/usage/i);
  });

  it('npm run seed:volume -- <lane> is wired in package.json', () => {
    const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    expect(pkg.scripts['seed:volume']).toBe('node scripts/seed-volume.mjs');
  });

  it('as a command with the connection in the environment: fills a small shop, exits 0; the second run exits 1 and says why; a usage error exits 2; the password is never printed', async () => {
    const fresh = await (await import('../helpers')).scratchDatabase('seedcli', { schema: true });
    const u = await fresh.connect();
    try {
      await migrate(u, { seeds: true, optional: false });
    } finally {
      await u.end();
    }
    const env = { ...process.env, DB_HOST: fresh.db.host, DB_PORT: String(fresh.db.port), DB_NAME: fresh.db.name, DB_USER: fresh.db.user, DB_PASSWORD: fresh.db.password };
    const args = ['scripts/seed-volume.mjs', '--env', '--customers', '40', '--designs', '8', '--pieces', '30', '--bills', '50'];
    try {
      const first = await run(process.execPath, args, { cwd: REPO, env });
      expect(first.stdout).toMatch(/RESULT: OK/);
      expect(first.stdout + first.stderr).not.toContain(fresh.db.password);
      const second = await run(process.execPath, args, { cwd: REPO, env }).then(
        () => ({ code: 0, out: '' }),
        (e) => ({ code: e.code as number, out: `${e.stdout}${e.stderr}` }),
      );
      expect(second.code).toBe(1);
      expect(second.out).toMatch(/not empty/i);
      expect(second.out).not.toContain(fresh.db.password);
      const usage = await run(process.execPath, ['scripts/seed-volume.mjs'], { cwd: REPO, env }).then(
        () => 0,
        (e) => e.code as number,
      );
      expect(usage).toBe(2);
      const noEnv = await run(process.execPath, ['scripts/seed-volume.mjs', '--env'], { cwd: REPO, env: { PATH: process.env.PATH ?? '' } }).then(
        () => 0,
        (e) => e.code as number,
      );
      expect(noEnv).toBe(2);
    } finally {
      await fresh.drop();
    }
  }, 180_000);
});
