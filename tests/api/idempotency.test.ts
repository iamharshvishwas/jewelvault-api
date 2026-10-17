import { type ChildProcess, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app';
import { REPLAY_HEADER, argsHash, canonicalJson, claim, idempotencyKey, idempotent, markReplay, storeResult } from '../../src/db/idempotency';
import { newId } from '../../src/db/ids';
import { takeNumber } from '../../src/db/numbers';
import { createDbPool, type DbPool } from '../../src/db/pool';
import { txContext, txContextFor, withTx, type TxContext } from '../../src/db/tx';
import { JvError } from '../../src/errors';
import { errorOf, sleep } from '../helpers';
import { REPO, buildDist, canConnect, freePort, logSink, testConfig, toyRoutes } from './support';
import { NOTHING, connectionLost, leftovers, spyOn, txWorld, type TxWorld } from './tx-support';

// PT-N1 (L5): the claim machinery, with a toy creating function that has the shape of the real ones: the claim is its first statement, then the customer row, the number, a row, and the result stored in
// the same transaction. Also the clauses of T-C18 (the same Idempotency-Key retried after the restart saves once) and T-C19 (a connection killed during COMMIT: the retry with the same key returns the stored
// result) that API14 owns. The scratch database has the real schema and the audit triggers; the user is the ten-box user; the pool is the real one.

let world: TxWorld;
const pools: DbPool[] = [];
const apps: ReturnType<typeof buildApp>[] = [];
const children: ChildProcess[] = [];
const open = () => {
  const p = createDbPool(world.scratch.db);
  pools.push(p);
  return p;
};
const ACTOR = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const biller = { id: ACTOR, role: 'biller' };
const other = { id: OTHER, role: 'biller' };
const ctxFor = (pool: Parameters<typeof txContext>[0], actor = biller, extra: Partial<Parameters<typeof txContext>[1]> = {}): TxContext => txContext(pool, { requestId: randomUUID(), actor, ...extra });
const db = () => `\`${world.scratch.database}\``;
const CLAIM_SQL = 'INSERT INTO sys_idempotency (request_id, fn, actor, args_hash, claim_token) VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE request_id = request_id';
const READ_SQL = 'SELECT fn, actor, args_hash, claim_token, result FROM sys_idempotency WHERE request_id = ? FOR UPDATE';

beforeAll(async () => {
  world = await txWorld('idem');
}, 120_000);
afterEach(async () => {
  for (const c of children.splice(0)) c.kill('SIGKILL');
  await Promise.all(apps.splice(0).map((a) => a.close().catch(() => undefined)));
  await Promise.all(pools.splice(0).map((p) => p.end().catch(() => undefined)));
  await world.root.query(`DELETE FROM ${db()}.categories`);
  await world.root.query(`DELETE FROM ${db()}.sys_idempotency`);
  await world.root.query(`UPDATE ${db()}.sys_counters SET last_value = 0`);
  await world.root.query(`DELETE FROM ${db()}.audit_log`);
});
afterAll(async () => {
  await world?.drop();
}, 60_000);

interface Call {
  key?: string | undefined;
  actor?: { id: string; role: string };
  customer?: string;
  fn?: string;
  route?: string;
  pathIds?: Record<string, string>;
  body?: unknown;
  /** runs right after the claim, inside the transaction: a test holds or fails the call here */
  afterClaim?: () => Promise<void>;
}
/** The toy creating function: claim first, then the work, the result stored with it. `key` omitted means a fresh key; undefined passed on purpose means none. */
function create(pool: Pick<DbPool, 'checkout'>, c: Call = {}) {
  const key = 'key' in c ? c.key : randomUUID();
  return withTx(ctxFor(pool, c.actor ?? biller), (tx) =>
    idempotent(tx, { key, fn: c.fn ?? 'toy_create', route: c.route ?? 'POST /toy/create', pathIds: c.pathIds, body: 'body' in c ? c.body : { name: 'ring' } }, async () => {
      await c.afterClaim?.();
      await tx.rows('SELECT id FROM customers WHERE id = ? FOR UPDATE', [c.customer ?? world.customers[0]]);
      const number = await takeNumber(tx, 'toy:2026');
      const categoryId = newId();
      await tx.run('INSERT INTO categories (id, name, prefix) VALUES (?, ?, ?)', [categoryId, `cat#${number}`, 'TY']);
      return { number, category_id: categoryId };
    }),
  );
}
const ONE = { categories: 1, audit: 1, claims: 1, counter: 1 };
/** The driver may hand a JSON column over as text or already parsed. */
const resultOf = (r: unknown) => (typeof r === 'string' ? JSON.parse(r) : r);
const claimRows = async () => (await world.root.query<any[]>(`SELECT request_id, fn, actor, args_hash, claim_token, result FROM ${db()}.sys_idempotency`))[0] as any[];

/** A gate: wait() holds until open() is called; arrived() says someone is waiting there. */
function gate() {
  let open!: () => void;
  let arrive!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  const arrived = new Promise<void>((resolve) => (arrive = resolve));
  return { open, arrived, wait: async () => (arrive(), opened) };
}
/** Waits until a call is at its gate; if the call ends first (it failed before the gate) the test fails at once instead of waiting for the test timeout. */
const reaches = (g: ReturnType<typeof gate>, call: Promise<unknown>) =>
  Promise.race([
    g.arrived,
    call.then(
      () => {
        throw new Error('the call ended before it reached the gate');
      },
      (e) => {
        throw new Error(`the call failed before it reached the gate: ${(e as Error)?.message}`);
      },
    ),
  ]);
const pending = async (p: Promise<unknown>, ms = 400) => (await Promise.race([p.then(() => 'done', () => 'done'), sleep(ms).then(() => 'waiting')])) === 'waiting';

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
describe('PT-N1 the claim: first request executes, an identical twin returns the stored result, another actor or body under the same key is refused (L5)', () => {
  it('the first request executes: the claim row holds the function, the actor, a SHA-256 of 64 hex digits, a token and the stored result, and the work was done once', async () => {
    const pool = open();
    const key = randomUUID();
    const out = await create(pool, { key });
    expect(out.replayed).toBe(false);
    expect(out.value).toMatchObject({ number: 1 });
    expect(await leftovers(world)).toEqual(ONE);
    const [row] = await claimRows();
    expect(row).toMatchObject({ request_id: key, fn: 'toy_create', actor: ACTOR });
    expect(row.args_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.claim_token).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/); // a fresh random value (S2 style), not a count or a time
    expect(resultOf(row.result)).toEqual(out.value);
  });

  it('the claim INSERT is the first statement of the function, the row is read back FOR UPDATE, and the result is stored in the same transaction, before COMMIT', async () => {
    const spy = spyOn(open());
    await create(spy.pool);
    const sql = spy.sqls();
    const start = sql.indexOf('START TRANSACTION');
    expect(sql.slice(0, start + 2)).toEqual([expect.stringMatching(/^SET @jv_actor/), 'START TRANSACTION', CLAIM_SQL]);
    expect(sql[start + 1]).toBe(CLAIM_SQL); // the first statement after START TRANSACTION
    expect(sql[start + 2]).toBe(READ_SQL);
    const store = sql.indexOf('UPDATE sys_idempotency SET result = ? WHERE request_id = ?');
    expect(store).toBeGreaterThan(start + 2);
    expect(sql.indexOf('COMMIT')).toBeGreaterThan(store);
    expect(sql.filter((s) => s === 'COMMIT')).toHaveLength(1);
  });

  it('with the driver\'s default flags affectedRows is 1 for a fresh insert and for a duplicate alike, so the token (not the count) tells who is first (docs #7)', async () => {
    const c = await world.scratch.connect();
    try {
      const id = randomUUID();
      const run = () => c.query<any>(CLAIM_SQL, [id, 'toy', ACTOR, 'a'.repeat(64), randomUUID()]);
      const [fresh] = await run();
      const [dup] = await run();
      expect([fresh.affectedRows, dup.affectedRows]).toEqual([1, 1]);
    } finally {
      await c.end();
    }
  });

  it('an identical twin that comes later returns the stored result and says it is a replay; nothing is written a second time', async () => {
    const pool = open();
    const key = randomUUID();
    const first = await create(pool, { key });
    const twin = await create(pool, { key });
    expect(twin).toEqual({ value: first.value, replayed: true });
    expect(await leftovers(world)).toEqual(ONE);
  });

  it('an identical twin IN FLIGHT waits for the first, then returns its stored result: no false error, nothing written twice', async () => {
    const pool = open();
    const key = randomUUID();
    const g = gate();
    const first = create(pool, { key, afterClaim: g.wait });
    await reaches(g, first);
    const twin = create(pool, { key });
    expect(await pending(twin)).toBe(true); // its claim INSERT waits for the first to commit
    g.open();
    const [a, b] = await Promise.all([first, twin]);
    expect(a.replayed).toBe(false);
    expect(b).toEqual({ value: a.value, replayed: true });
    expect(await leftovers(world)).toEqual(ONE);
  });

  it('8 identical requests at once: one executes, 7 replay it, all 8 get the same answer, one row and one counter step', async () => {
    const pool = open();
    const key = randomUUID();
    const g = gate();
    const first = create(pool, { key, afterClaim: g.wait });
    await reaches(g, first);
    const twins = Array.from({ length: 7 }, () => create(pool, { key }));
    expect(await pending(Promise.all(twins))).toBe(true);
    g.open();
    const all = await Promise.all([first, ...twins]);
    expect(all.filter((r) => !r.replayed)).toHaveLength(1);
    expect(all.filter((r) => r.replayed)).toHaveLength(7);
    expect(new Set(all.map((r) => JSON.stringify(r.value))).size).toBe(1);
    expect(await leftovers(world)).toEqual(ONE);
  });

  it('8 identical requests at once with no hold at all (the usual double click): the same', async () => {
    const pool = open();
    const key = randomUUID();
    const all = await Promise.all(Array.from({ length: 8 }, () => create(pool, { key })));
    expect(all.filter((r) => !r.replayed)).toHaveLength(1);
    expect(new Set(all.map((r) => JSON.stringify(r.value))).size).toBe(1);
    expect(await leftovers(world)).toEqual(ONE);
  });

  it('a first request that rolls back leaves no claim row; the waiting twin becomes first and runs', async () => {
    const pool = open();
    const key = randomUUID();
    const g = gate();
    const first = errorOf(() =>
      create(pool, {
        key,
        afterClaim: async () => {
          await g.wait();
          throw new JvError('JV_PIECE_UNAVAILABLE', 'the first fails');
        },
      }),
    );
    await Promise.race([
      g.arrived,
      first.then((e) => {
        throw new Error(`the first call ended before it reached the gate: ${e?.message}`);
      }),
    ]);
    const twin = create(pool, { key });
    expect(await pending(twin)).toBe(true);
    g.open();
    expect(await first).toMatchObject({ code: 'JV_PIECE_UNAVAILABLE', message: 'the first fails' });
    const t = await twin;
    expect(t).toMatchObject({ replayed: false, value: { number: 1 } });
    expect(await leftovers(world)).toEqual(ONE);
  });

  it('different keys do not wait for each other: while one call is held right after its claim, another key completes', async () => {
    const pool = open();
    const g = gate();
    const held = create(pool, { afterClaim: g.wait });
    await reaches(g, held);
    const done = await Promise.race([create(pool, { customer: world.customers[1] }), sleep(3000).then(() => 'timeout' as const)]);
    expect(done).not.toBe('timeout');
    g.open();
    await held;
    expect((await leftovers(world)).claims).toBe(2);
  });

  it('the same key under another actor is refused with JV_INVALID_INPUT (422); nothing is changed, and the first result stays the one stored', async () => {
    const pool = open();
    const key = randomUUID();
    const first = await create(pool, { key });
    const e = await errorOf(() => create(pool, { key, actor: other }));
    expect(e).toBeInstanceOf(JvError);
    expect(e).toMatchObject({ code: 'JV_INVALID_INPUT', status: 422 });
    expect(await leftovers(world)).toEqual(ONE);
    expect(resultOf((await claimRows())[0].result)).toEqual(first.value);
    expect(await create(pool, { key })).toEqual({ value: first.value, replayed: true }); // and the real owner of the key still gets it
  });

  it.each([
    ['another body', { body: { name: 'chain' } }],
    ['no body at all', { body: undefined }],
    ['another route', { route: 'POST /toy/other' }],
    ['another path id', { pathIds: { customerId: randomUUID() } }],
    ['another function', { fn: 'toy_other' }],
  ] as [string, Partial<Call>][])('the same key with %s is refused (JV_INVALID_INPUT), not answered with the first result; nothing is written', async (_name, change) => {
    const pool = open();
    const key = randomUUID();
    const base = { key, pathIds: { customerId: world.customers[0] } };
    await create(pool, base);
    const e = await errorOf(() => create(pool, { ...base, ...change }));
    expect(e).toBeInstanceOf(JvError);
    expect(e).toMatchObject({ code: 'JV_INVALID_INPUT', status: 422 });
    expect(e!.message).not.toMatch(/ring|chain/); // the message never repeats what the caller sent
    expect(await leftovers(world)).toEqual(ONE);
  });

  it('the same body with its keys in another order is the same request (a replay); a number and the same digits as text are not', async () => {
    const pool = open();
    const key = randomUUID();
    const first = await create(pool, { key, body: { a: 1, b: { c: [1, 2], d: 'x' } } });
    expect(await create(pool, { key, body: { b: { d: 'x', c: [1, 2] }, a: 1 } })).toEqual({ value: first.value, replayed: true });
    expect(await errorOf(() => create(pool, { key, body: { a: '1', b: { c: [1, 2], d: 'x' } } }))).toMatchObject({ code: 'JV_INVALID_INPUT' });
    expect(await errorOf(() => create(pool, { key, body: { a: 1, b: { c: [2, 1], d: 'x' } } }))).toMatchObject({ code: 'JV_INVALID_INPUT' }); // an array is ordered
  });

  it('a creating call without an Idempotency-Key, or with one that is not a UUID, is JV_INVALID_INPUT before any statement about the claim is sent; nothing is used', async () => {
    const spy = spyOn(open());
    for (const key of [undefined, '', '   ', 'not-a-uuid', '12345678-1234-1234-1234-12345678901', randomUUID() + 'x']) {
      const e = await errorOf(() => create(spy.pool, { key }));
      expect(e, String(key)).toBeInstanceOf(JvError);
      expect(e, String(key)).toMatchObject({ code: 'JV_INVALID_INPUT', status: 422, details: { field: 'Idempotency-Key' } });
    }
    expect(spy.sqls().filter((s) => /sys_idempotency|sys_counters|categories/.test(s))).toEqual([]);
    expect(await leftovers(world)).toEqual(NOTHING);
  });

  it('a key in capitals is the same key as in small letters (the column is a UUID): stored in lower case, a replay either way', async () => {
    const pool = open();
    const key = randomUUID();
    const first = await create(pool, { key: key.toUpperCase() });
    expect((await claimRows())[0].request_id).toBe(key);
    expect(await create(pool, { key })).toEqual({ value: first.value, replayed: true });
  });

  it('the function\'s own refusal after the claim (the role check of X0 item 2) rolls the claim row back: nothing is left and the key is free again', async () => {
    const pool = open();
    const key = randomUUID();
    const e = await errorOf(() =>
      create(pool, {
        key,
        afterClaim: async () => {
          throw new JvError('JV_FORBIDDEN', 'this role may not do this');
        },
      }),
    );
    expect(e).toMatchObject({ code: 'JV_FORBIDDEN' });
    expect(await leftovers(world)).toEqual(NOTHING);
    expect(await create(pool, { key })).toMatchObject({ replayed: false });
    expect(await leftovers(world)).toEqual(ONE);
  });

  it('a key whose stored result was emptied (L6, after 90 days) is refused, not run again: JV_INVALID_INPUT, nothing written', async () => {
    const pool = open();
    const key = randomUUID();
    await create(pool, { key });
    await world.root.query(`UPDATE ${db()}.sys_idempotency SET result = NULL, claim_token = NULL WHERE request_id = ?`, [key]);
    const e = await errorOf(() => create(pool, { key }));
    expect(e).toMatchObject({ code: 'JV_INVALID_INPUT', status: 422 });
    expect(await leftovers(world)).toEqual(ONE);
  });

  it('claim() and storeResult() on their own are the two halves of idempotent(): a function that claimed and never stored leaves a row that no repeat can use (refused, not run again); a result that is not JSON is a bug', async () => {
    const pool = open();
    const key = randomUUID();
    const req = { key, fn: 'toy_claim', route: 'POST /toy/claim', body: { n: 1 } };
    expect(await withTx(ctxFor(pool), (tx) => claim(tx, req))).toEqual({ first: true, key });
    expect(await errorOf(() => withTx(ctxFor(pool), (tx) => claim(tx, req)))).toMatchObject({ code: 'JV_INVALID_INPUT' });
    const bad = await errorOf(() => withTx(ctxFor(pool), (tx) => idempotent(tx, { key: randomUUID(), fn: 'toy_claim', route: 'r' }, async () => undefined as never)));
    expect(bad).toMatchObject({ code: 'JV_INTERNAL' });
    for (const notAnObject of ['text', 5, null, true]) {
      expect(await errorOf(() => withTx(ctxFor(pool), (tx) => idempotent(tx, { key: randomUUID(), fn: 'toy_claim', route: 'r' }, async () => notAnObject as never))), String(notAnObject)).toMatchObject({ code: 'JV_INTERNAL' });
    }
    expect((await leftovers(world)).claims).toBe(1); // only the claim that was committed on purpose above is there
    const stored = await withTx(ctxFor(pool), async (tx) => {
      const c = await claim(tx, { key: randomUUID(), fn: 'toy_claim', route: 'r' });
      await storeResult(tx, c.key, { a: '1.50' });
      return c.key;
    });
    expect(resultOf((await claimRows()).find((r) => r.request_id === stored).result)).toEqual({ a: '1.50' });
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
describe('PT-N1 the hash of the request and the key header (L5, NODE-DESIGN 4.6)', () => {
  const actorId = ACTOR;

  it('canonicalJson sorts keys at every depth, keeps the order of arrays, drops undefined properties and writes strings and numbers as JSON does', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: null } })).toBe('{"a":{"c":null,"d":[3,{"y":2,"z":1}]},"b":1}');
    expect(canonicalJson({ a: undefined, b: 'é"\n', c: [true, false, null, 0, -1.5] })).toBe('{"b":"é\\"\\n","c":[true,false,null,0,-1.5]}');
    expect(canonicalJson([])).toBe('[]');
    expect(canonicalJson({})).toBe('{}');
    expect(canonicalJson('x')).toBe('"x"');
    expect(canonicalJson(null)).toBe('null');
  });

  it('a value JSON cannot hold is a bug in the caller (TypeError): NaN, Infinity, bigint, Date, function, symbol, Map, undefined at the top', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, 1n, new Date(), () => 1, Symbol('x'), new Map(), undefined, { a: new Set() }, { a: [1n] }]) {
      expect(() => canonicalJson(bad), String(bad)).toThrow(TypeError);
    }
  });

  it('argsHash is the SHA-256 of the canonical JSON of the route name, the path ids, the body and the actor id; it does not change from one deploy to the next', () => {
    const input = { route: 'POST /v1/bills/{id}/cancel', pathIds: { id: '0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f' }, body: { reason: 'wrong customer', lines: [2, 1] }, actorId };
    const expected = createHash('sha256')
      .update('{"actor":"11111111-1111-4111-8111-111111111111","body":{"lines":[2,1],"reason":"wrong customer"},"path":{"id":"0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f"},"route":"POST /v1/bills/{id}/cancel"}', 'utf8')
      .digest('hex');
    expect(argsHash(input)).toBe(expected);
    // no path ids and no body are an empty object and null, so a request with neither has one fixed hash
    const bare = createHash('sha256').update(`{"actor":"${actorId}","body":null,"path":{},"route":"POST /x"}`, 'utf8').digest('hex');
    expect(argsHash({ route: 'POST /x', actorId })).toBe(bare);
    expect(argsHash({ route: 'POST /x', actorId, pathIds: {}, body: null })).toBe(bare);
  });

  it('each of the four parts changes the hash', () => {
    const base = { route: 'POST /x', pathIds: { id: 'a' }, body: { n: 1 }, actorId };
    const h = argsHash(base);
    expect(argsHash({ ...base, route: 'POST /y' })).not.toBe(h);
    expect(argsHash({ ...base, pathIds: { id: 'b' } })).not.toBe(h);
    expect(argsHash({ ...base, body: { n: 2 } })).not.toBe(h);
    expect(argsHash({ ...base, actorId: OTHER })).not.toBe(h);
    expect(argsHash({ ...base, body: { n: 1 }, pathIds: { id: 'a' } })).toBe(h);
  });

  it('idempotencyKey reads the header: a UUID in any case comes back in lower case; none, blank, malformed or doubled is JV_INVALID_INPUT naming the header', () => {
    const id = randomUUID();
    expect(idempotencyKey({ 'idempotency-key': id })).toBe(id);
    expect(idempotencyKey({ 'idempotency-key': id.toUpperCase() })).toBe(id);
    for (const headers of [{}, { 'idempotency-key': '' }, { 'idempotency-key': ' ' }, { 'idempotency-key': 'abc' }, { 'idempotency-key': `${id}, ${randomUUID()}` }, { 'idempotency-key': [id, randomUUID()] }, { 'idempotency-key': [] }]) {
      let e: unknown;
      try {
        idempotencyKey(headers as never);
      } catch (x) {
        e = x;
      }
      expect(e, JSON.stringify(headers)).toBeInstanceOf(JvError);
      expect(e, JSON.stringify(headers)).toMatchObject({ code: 'JV_INVALID_INPUT', status: 422, details: { field: 'Idempotency-Key' } });
    }
    expect(idempotencyKey({ 'idempotency-key': [id] })).toBe(id); // one value in a list is one value
    expect(REPLAY_HEADER).toBe('Idempotent-Replay');
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
describe('PT-N1 over HTTP: the replay says Idempotent-Replay: true with the same status; a refusal has the S8 body', () => {
  async function server() {
    const pool = open();
    const app = buildApp({ config: testConfig(), db: pool, logStream: logSink().stream });
    apps.push(app);
    toyRoutes(app).post('/toy/create', async (request, reply) => {
      const key = idempotencyKey(request.headers);
      const actor = request.headers['x-test-actor'] === 'other' ? other : biller;
      const out = await withTx(txContextFor(pool, request, actor), (tx) =>
        idempotent(tx, { key, fn: 'toy_create', route: 'POST /toy/create', body: request.body }, async () => {
          await tx.rows('SELECT id FROM customers WHERE id = ? FOR UPDATE', [world.customers[0]]);
          const number = await takeNumber(tx, 'toy:2026');
          await tx.run('INSERT INTO categories (id, name, prefix) VALUES (?, ?, ?)', [newId(), `cat#${number}`, 'TY']);
          return { number };
        }),
      );
      markReplay(reply, out.replayed);
      reply.code(201);
      return out.value;
    });
    await app.ready();
    return app;
  }
  const post = (app: Awaited<ReturnType<typeof server>>, key: string | undefined, body: unknown, headers: Record<string, string> = {}) =>
    app.inject({ method: 'POST', url: '/toy/create', payload: body as object, headers: { ...(key ? { 'idempotency-key': key } : {}), ...headers } });

  it('the first answer is 201 with no replay header; the twin is 201 with Idempotent-Replay: true and the same body', async () => {
    const app = await server();
    const key = randomUUID();
    const a = await post(app, key, { name: 'ring' });
    const b = await post(app, key, { name: 'ring' });
    expect([a.statusCode, b.statusCode]).toEqual([201, 201]);
    expect(a.headers[REPLAY_HEADER.toLowerCase()]).toBeUndefined();
    expect(b.headers[REPLAY_HEADER.toLowerCase()]).toBe('true');
    expect(b.json()).toEqual(a.json());
    expect(await leftovers(world)).toEqual(ONE);
  });

  it('another actor, or another body, under the same key: 422 JV_INVALID_INPUT in the S8 body; no key at all: 422 naming the header', async () => {
    const app = await server();
    const key = randomUUID();
    await post(app, key, { name: 'ring' });
    const otherActor = await post(app, key, { name: 'ring' }, { 'x-test-actor': 'other' });
    const otherBody = await post(app, key, { name: 'chain' });
    const noKey = await post(app, undefined, { name: 'ring' });
    for (const r of [otherActor, otherBody, noKey]) {
      expect(r.statusCode).toBe(422);
      expect(r.json()).toMatchObject({ error: { code: 'JV_INVALID_INPUT', message: expect.any(String), details: expect.any(Object) }, request_id: expect.any(String) });
      expect(r.headers[REPLAY_HEADER.toLowerCase()]).toBeUndefined();
    }
    expect(noKey.json().error.details).toEqual({ field: 'Idempotency-Key' });
    expect(await leftovers(world)).toEqual(ONE);
  });

  it('markReplay sets the header only for a replay', () => {
    const set: [string, string][] = [];
    markReplay({ header: (n, v) => set.push([n, v]) }, false);
    expect(set).toEqual([]);
    markReplay({ header: (n, v) => set.push([n, v]) }, true);
    expect(set).toEqual([['Idempotent-Replay', 'true']]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
describe('T-C19 / PT-N1 a connection killed during COMMIT: JV_BUSY, and the retry with the same key returns the stored result (L5)', () => {
  it('the server committed but the answer was lost: JV_BUSY (outcome unknown); the retry returns the stored result and saves nothing twice', async () => {
    const pool = open();
    const spy = spyOn(pool);
    spy.intercept = async (e) => {
      if (e.sql === 'COMMIT') {
        await e.real(); // it reached the server and was saved...
        throw connectionLost(); // ...and the connection dropped before the answer came back
      }
    };
    const key = randomUUID();
    const e = await errorOf(() => create(spy.pool, { key }));
    expect(e).toMatchObject({ code: 'JV_BUSY', reason: 'commit_lost', outcomeUnknown: true, status: 503 });
    expect(await leftovers(world)).toEqual(ONE); // it HAD committed
    spy.intercept = null;
    const retry = await create(pool, { key });
    expect(retry).toMatchObject({ replayed: true, value: { number: 1 } });
    expect(resultOf((await claimRows())[0].result)).toEqual(retry.value);
    expect(await leftovers(world)).toEqual(ONE);
  });

  it('the connection was killed before the COMMIT reached the server: JV_BUSY (outcome unknown); nothing was saved and no claim is left; the retry with the same key runs the call once', async () => {
    const pool = open();
    const spy = spyOn(pool);
    spy.intercept = async (e) => {
      if (e.sql === 'COMMIT') {
        await world.root.query(`KILL CONNECTION ${Number(e.thread)}`);
        await sleep(150);
      }
    };
    const key = randomUUID();
    const e = await errorOf(() => create(spy.pool, { key }));
    expect(e).toMatchObject({ code: 'JV_BUSY', reason: 'commit_lost', outcomeUnknown: true });
    expect(await leftovers(world)).toEqual(NOTHING);
    spy.intercept = null;
    expect(await create(pool, { key })).toMatchObject({ replayed: false, value: { number: 1 } });
    expect(await create(pool, { key })).toMatchObject({ replayed: true, value: { number: 1 } });
    expect(await leftovers(world)).toEqual(ONE);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
describe('T-C18 / PT-N1 the same Idempotency-Key retried after the restart saves once (L5, H7)', () => {
  let dist: string;
  beforeAll(() => {
    dist = buildDist();
  }, 120_000);

  interface Child {
    proc: ChildProcess;
    base: string;
    waitFor(text: string, ms?: number): Promise<void>;
    exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  }
  async function start(): Promise<Child> {
    const port = await freePort();
    const d = world.scratch.db;
    const out: string[] = [];
    const proc = spawn(process.execPath, [join(REPO, 'tests', 'api', 'fixtures', 'idem-server.mjs')], {
      env: { PATH: process.env.PATH ?? '', JV_DIST: dist, DB_HOST: d.host, DB_PORT: String(d.port), DB_NAME: d.name, DB_USER: d.user, DB_PASSWORD: d.password, PORT: String(port), LOG_LEVEL: 'info' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(proc);
    proc.stdout?.on('data', (x) => out.push(String(x)));
    proc.stderr?.on('data', (x) => out.push(String(x)));
    const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => proc.once('exit', (code, signal) => resolve({ code, signal })));
    const waitFor = async (text: string, ms = 15_000) => {
      const until = Date.now() + ms;
      while (!out.join('').includes(text)) {
        if (Date.now() > until) throw new Error(`waited for "${text}" in the child's output; got: ${out.join('')}`);
        await sleep(25);
      }
    };
    let up = false;
    for (let i = 0; i < 200 && !up; i++) {
      up = await canConnect(port);
      if (!up) await sleep(100);
    }
    expect(up, out.join('')).toBe(true);
    return { proc, base: `http://127.0.0.1:${port}`, waitFor, exit };
  }
  const create1 = (c: Child, key: string, ms = 0, body: object = { name: 'ring' }) =>
    fetch(`${c.base}/toy/create?customer=${world.customers[0]}&ms=${ms}`, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': key }, body: JSON.stringify(body) });

  it('a call that finished, the process stopped with SIGTERM and started again: the retry with the same key gets the stored result (Idempotent-Replay: true) and nothing is saved twice; a new key runs', async () => {
    const key = randomUUID();
    const first = await start();
    const a = await create1(first, key);
    expect([a.status, a.headers.get('idempotent-replay'), await a.json()]).toEqual([201, null, { number: 1 }]);
    first.proc.kill('SIGTERM');
    expect((await first.exit).code).toBe(0);
    const second = await start();
    const b = await create1(second, key);
    expect([b.status, b.headers.get('idempotent-replay'), await b.json()]).toEqual([201, 'true', { number: 1 }]);
    expect(await leftovers(world)).toEqual(ONE);
    const c = await create1(second, randomUUID());
    expect([c.status, await c.json()]).toEqual([201, { number: 2 }]);
    const d = await create1(second, key, 0, { name: 'chain' }); // the same key with another body is still refused after the restart
    expect(d.status).toBe(422);
    expect((await leftovers(world)).claims).toBe(2);
  }, 90_000);

  it('a process killed in the middle of the call (SIGKILL): nothing is committed; the retry with the same key on the next start runs it once, and asking again replays', async () => {
    const key = randomUUID();
    const first = await start();
    const running = create1(first, key, 20_000).catch((e) => e as Error);
    await first.waitFor('IN_TX');
    first.proc.kill('SIGKILL');
    expect((await first.exit).signal).toBe('SIGKILL');
    await running;
    const until = Date.now() + 5000;
    while (Date.now() < until && (await leftovers(world)).claims !== 0) await sleep(50);
    expect(await leftovers(world)).toEqual(NOTHING); // the claim, the number, the row and its audit row went with the connection
    const second = await start();
    const a = await create1(second, key);
    expect([a.status, a.headers.get('idempotent-replay'), await a.json()]).toEqual([201, null, { number: 1 }]);
    const b = await create1(second, key);
    expect([b.status, b.headers.get('idempotent-replay'), await b.json()]).toEqual([201, 'true', { number: 1 }]);
    expect(await leftovers(world)).toEqual(ONE);
  }, 90_000);
});
