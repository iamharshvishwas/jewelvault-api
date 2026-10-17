import { randomUUID } from 'node:crypto';
import type { Connection } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app';
import { createClock } from '../../src/clock';
import { createDbPool } from '../../src/db/pool';
import { txContext, withRead } from '../../src/db/tx';
import { limits } from '../../src/limits';
import { readPage } from '../../src/sync/page';
import { resourceByName } from '../../src/sync/resources';
import { registerSyncRoutes } from '../../src/sync/routes';
import { timestampFromWire } from '../../src/wire/format';
import { V, insert } from '../schema/support';
import { T0, type World, makeWorld } from './cells';
import { testConfig } from './support';
import { type Next, type PageBody, bodyOf, getPage, pageAll } from './sync-support';

// T-F03 (C2, C3, RF3-1): the paging of the read side at the sizes of the shop. 2,500 pieces all arrive through paging, also when the API's page cap is lowered to 500 (the cursor advances by
// the rows received, not by the rows asked for); 30,000 rows with random version-4 ids paged in 2-row pages come back once each, in key order. The key order is the database's: a UUID sorts
// in the type's own order, not as text (BACKUP-RESTORE.md, "Rules learned while writing it").

const insertMany = async (c: Connection, sqlHead: string, rows: string[], chunk = 500) => {
  for (let i = 0; i < rows.length; i += chunk) await c.query(`${sqlHead} VALUES ${rows.slice(i, i + chunk).join(', ')}`);
};

// ------------------------------------------------------------------ 2,500 pieces

describe('T-F03 2,500 pieces all arrive through paging, also when the API\'s page cap is lowered to 500 (the cursor advances by the rows received)', () => {
  let world: World;
  let expected: string[];

  beforeAll(async () => {
    world = await makeWorld({ label: 'syncpc', routes: true });
    const category = (await insert(world.sql, 'categories', V.category({ name: 'Pieces', prefix: 'PCS' }))) as { id: string };
    const design = (await insert(world.sql, 'designs', V.design(category.id, { design_no: 'D-PIECES' }))) as { id: string };
    // 2,500 pieces; the stamps come in groups of 50 that share a microsecond count, so the key has to break the ties at (almost) every page edge
    const rows = Array.from({ length: 2500 }, (_, i) => {
      const micros = String(Math.floor(i / 50) * 1000).padStart(6, '0');
      return `('${randomUUID()}', '${design.id}', 'SKU-${String(i).padStart(5, '0')}', 'BC-${String(i).padStart(5, '0')}', '5.500', '5.000', 'In Stock', '2026-10-17 09:00:00.${micros}')`;
    });
    await insertMany(world.sql, 'INSERT INTO skus (id, design_id, sku_no, barcode, gross_weight, customer_net_weight, status, updated_at)', rows);
    expected = (await world.sql.query<any[]>('SELECT id FROM skus ORDER BY updated_at, id'))[0].map((r: any) => r.id as string);
    expect(expected).toHaveLength(2500);
  }, 120_000);
  afterAll(async () => {
    await world?.close();
  });

  it('with the API\'s page size of 1,000 the screen gets 1,000, 1,000 and 500 rows and every piece once, in (updated_at, id) order', async () => {
    expect(limits.syncPageRows).toBe(1000);
    const { rows, pages } = await pageAll(world, 'staff', 'skus');
    expect(pages.map((p) => p.rows.length)).toEqual([1000, 1000, 500]);
    expect(pages.map((p) => p.next !== null)).toEqual([true, true, false]);
    expect(rows.map((r) => r.id)).toEqual(expected);
    expect(new Set(rows.map((r) => r.id)).size).toBe(2500);
    for (const p of pages) expect(p.server_time).toMatch(/^2026-10-17T10:00:00\.\d{6}Z$/);
    // `limit` above the constant is not cut silently: it is refused
    expect((await getPage(world, 'staff', 'skus', { limit: 1001 })).statusCode).toBe(422);
  });

  it('the same through a poll, page after page: the cursor of the next poll is the `next` of the last', async () => {
    const got: string[] = [];
    let cursor: Next | null = null;
    for (let i = 0; i < 10; i++) {
      const res = await world.call('biller', 'POST', '/v1/sync/poll', { payload: { cursors: { skus: cursor } } });
      const page = JSON.parse(res.body).results.skus as PageBody;
      got.push(...page.rows.map((r) => r.id as string));
      if (page.next === null) break;
      cursor = page.next;
    }
    expect(got).toEqual(expected);
  });

  it('with the page cap lowered to 500 the screen still gets every piece once: it asks for 1,000, receives 500, and carries on from `next`', async () => {
    const pool = createDbPool(world.scratch.db);
    const app = buildApp({ config: testConfig({ logLevel: 'silent' }), db: pool, clock: createClock(() => T0), routes: false });
    registerSyncRoutes(app, { maxRows: 500 });
    await app.ready();
    try {
      const cookie = world.cookieOf('owner')!;
      const got: string[] = [];
      const sizes: number[] = [];
      let next: Next | null = null;
      for (let i = 0; i < 20; i++) {
        const q: string = `limit=1000${next ? `&updated_after=${next.updated_at}&after_key=${next.key}` : ''}`;
        const res = await app.inject({ method: 'GET', url: `/v1/sync/skus?${q}`, headers: { cookie } });
        expect(res.statusCode).toBe(200);
        const page = JSON.parse(res.body) as PageBody;
        sizes.push(page.rows.length);
        got.push(...page.rows.map((r) => r.id as string));
        if (page.next === null) break;
        next = page.next;
      }
      expect(sizes).toEqual([500, 500, 500, 500, 500, 0]); // a full last page cannot be told from "more": one more call ends the load
      expect(got).toEqual(expected);
      // the poll is capped the same way
      const poll = await app.inject({ method: 'POST', url: '/v1/sync/poll', headers: { cookie, 'x-jv-client': 'web', origin: 'https://app.example.test' }, payload: { limit: 1000, cursors: { skus: null } } });
      const first = JSON.parse(poll.body).results.skus as PageBody;
      expect(first.rows).toHaveLength(500);
      expect(first.next).toEqual({ updated_at: expect.any(String), key: expect.any(String) });
    } finally {
      await app.close();
    }
  });

  it('negative control: a screen that treats a page shorter than 1,000 as the last one would stop after 500 rows when the cap is 500, which is why `next` decides and the length does not', async () => {
    const pool = createDbPool(world.scratch.db);
    const app = buildApp({ config: testConfig({ logLevel: 'silent' }), db: pool, clock: createClock(() => T0), routes: false });
    registerSyncRoutes(app, { maxRows: 500 });
    await app.ready();
    try {
      const res = await app.inject({ method: 'GET', url: '/v1/sync/skus?limit=1000', headers: { cookie: world.cookieOf('owner')! } });
      const page = JSON.parse(res.body) as PageBody;
      expect(page.rows.length).toBeLessThan(1000);
      expect(page.next).not.toBeNull();
    } finally {
      await app.close();
    }
  });
});

// ------------------------------------------------------------------ 30,000 random ids

describe('T-F03 30,000 rows with random version-4 ids paged in 2-row pages come back once each, in key order (the key is compared as a UUID, C3)', () => {
  let world: World;
  let expected: string[];
  const STAMPS = [
    { stamp: '2026-10-17 09:00:00.000000', count: 29_000 }, // almost all rows tie on the stamp: only the key tells them apart
    { stamp: '2026-10-17 09:00:01.500000', count: 900 },
    { stamp: '2026-10-17 09:00:02.500001', count: 100 },
  ];

  beforeAll(async () => {
    world = await makeWorld({ label: 'syncpu', routes: true });
    let n = 0;
    for (const { stamp, count } of STAMPS) {
      const rows = Array.from({ length: count }, () => `('${randomUUID()}', 'Key ${String(++n).padStart(6, '0')}', 'KEY', '${stamp}')`);
      await insertMany(world.sql, 'INSERT INTO categories (id, name, prefix, updated_at)', rows, 2000);
    }
    expected = (await world.sql.query<any[]>('SELECT id FROM categories ORDER BY updated_at, id'))[0].map((r: any) => r.id as string);
    expect(expected).toHaveLength(30_000);
  }, 180_000);
  afterAll(async () => {
    await world?.close();
  });

  it('the test data is the hard case: the database order of the keys is not their text order', () => {
    const tied = expected.slice(0, 29_000);
    expect(tied).not.toEqual([...tied].sort());
  });

  it('the page function pages all 30,000 rows in pages of 2: once each, in the database\'s key order, no row skipped and none twice', async () => {
    const pool = createDbPool(world.scratch.db);
    try {
      const resource = resourceByName('categories')!;
      const got: string[] = [];
      let pages = 0;
      let after: { updatedAt: string; key: string | null } | undefined;
      let done = false;
      // a call has 12 seconds (S12): the pages are read in snapshots of 1,000 pages each, the cursor carrying over from one snapshot to the next, as the screen's calls would
      while (!done) {
        const ctx = txContext(pool, { requestId: randomUUID() });
        await withRead(
          ctx,
          async (db) => {
            for (let i = 0; i < 1000; i++) {
              const page = await readPage(db, resource, 'owner', { after, limit: 2 });
              pages++;
              got.push(...page.rows.map((r) => r.id as string));
              if (page.next === null) {
                done = true;
                return;
              }
              after = { updatedAt: timestampFromWire(page.next.updated_at), key: page.next.key };
            }
          },
          { snapshot: true },
        );
      }
      expect(pages).toBe(15_001); // 15,000 full pages and one empty one: the last page is full, so `next` is set once more
      expect(got).toHaveLength(30_000);
      expect(new Set(got).size).toBe(30_000);
      expect(got).toEqual(expected);
    } finally {
      await pool.end();
    }
  }, 240_000);

  it('through the route, pages of 2 from the second stamp on (1,000 rows, 500 calls): once each, in key order', async () => {
    const start = expected.length - 1000;
    const { rows, pages } = await (async () => {
      const pages: PageBody[] = [];
      const rows: Record<string, unknown>[] = [];
      let next: Next | null = null;
      for (let i = 0; i < 2000; i++) {
        const res = await getPage(world, 'staff', 'categories', { limit: 2, updated_after: next?.updated_at ?? '2026-10-17T09:00:01.000000Z', after_key: next?.key });
        expect(res.statusCode).toBe(200);
        const page = bodyOf(res);
        pages.push(page);
        rows.push(...page.rows);
        if (page.next === null) break;
        next = page.next;
      }
      return { rows, pages };
    })();
    expect(rows.map((r) => r.id)).toEqual(expected.slice(start));
    expect(pages.every((p) => p.rows.length === 2 || p === pages.at(-1))).toBe(true);
    expect(new Set(rows.map((r) => r.id)).size).toBe(1000);
  }, 120_000);

  it('negative control: paging with the key cast to text under its own name ("CAST(id AS CHAR) AS id" and ORDER BY id) loses rows on the same data', async () => {
    // the pattern of the export's old bug (BACKUP-RESTORE.md): ORDER BY id means the SELECT-list alias, the text; WHERE id > ? means the column, the UUID
    const [sample] = await world.sql.query<any[]>("SELECT id FROM categories WHERE updated_at = '2026-10-17 09:00:00.000000' ORDER BY id LIMIT 3000");
    const wanted = new Set(sample.map((r: any) => r.id as string));
    const got: string[] = [];
    let after: string | null = null;
    for (let i = 0; i < 10_000; i++) {
      const [rows]: [any[], unknown] = await world.sql.query(
        `SELECT CAST(id AS CHAR) AS id, updated_at FROM categories WHERE updated_at = '2026-10-17 09:00:00.000000' ${after ? 'AND id > ?' : ''} ORDER BY updated_at, id LIMIT 2`,
        after ? [after] : [],
      );
      if (rows.length === 0) break;
      got.push(...rows.map((r) => r.id as string));
      after = rows[rows.length - 1].id as string;
    }
    const lost = [...wanted].filter((id) => !got.includes(id));
    expect(got.length === new Set(got).size && lost.length === 0).toBe(false); // it skips rows or repeats them
  }, 240_000);
});
