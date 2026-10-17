import { type ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { SHUTDOWN_GRACE_MS } from '../../src/shutdown';
import { errorOf, sleep } from '../helpers';
import { REPO, buildDist, canConnect, freePort } from './support';
import { NOTHING, leftovers, txWorld, type TxWorld } from './tx-support';

// T-C18 (H7, S11, L5), the part that belongs to API03: restart safety. A process stopped with SIGTERM while a service function holds its locks finishes it or rolls it back, and nothing
// is half-saved; a process killed in the middle of a transaction leaves nothing committed and releases its locks at once; the same Idempotency-Key retried afterwards saves once;
// the first request after a start is served. The children run the compiled build (the files `npm run build` makes) with toy routes from tests/api/fixtures/tx-server.mjs.

let world: TxWorld;
let dist: string;
const children: ChildProcess[] = [];

beforeAll(async () => {
  dist = buildDist();
  world = await txWorld('c18');
}, 180_000);
afterEach(async () => {
  for (const c of children.splice(0)) c.kill('SIGKILL');
  await sleep(100);
  const db = `\`${world.scratch.database}\``;
  await world.root.query(`DELETE FROM ${db}.categories`);
  await world.root.query(`DELETE FROM ${db}.sys_idempotency`);
  await world.root.query(`UPDATE ${db}.sys_counters SET last_value = 0`);
  await world.root.query(`DELETE FROM ${db}.audit_log WHERE table_name = 'categories'`);
});
afterAll(async () => {
  await world?.drop();
}, 60_000);

interface Child {
  proc: ChildProcess;
  port: number;
  base: string;
  log(): string;
  waitFor(text: string, ms?: number): Promise<void>;
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

async function start(entry: { fixture: true; graceMs?: number } | { fixture: false }): Promise<Child> {
  const port = await freePort();
  const db = world.scratch.db;
  const out: string[] = [];
  const file = entry.fixture ? join(REPO, 'tests', 'api', 'fixtures', 'tx-server.mjs') : join(dist, 'server.js');
  const proc = spawn(process.execPath, [file], {
    env: {
      PATH: process.env.PATH ?? '',
      JV_DIST: dist,
      JV_GRACE_MS: entry.fixture && entry.graceMs ? String(entry.graceMs) : '',
      DB_HOST: db.host,
      DB_PORT: String(db.port),
      DB_NAME: db.name,
      DB_USER: db.user,
      DB_PASSWORD: db.password,
      PORT: String(port),
      LOG_LEVEL: 'info',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(proc);
  proc.stdout?.on('data', (d) => out.push(String(d)));
  proc.stderr?.on('data', (d) => out.push(String(d)));
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
  return { proc, port, base: `http://127.0.0.1:${port}`, log: () => out.join(''), waitFor, exit };
}

const hold = (c: Child, p: { key?: string; ms: number; customer?: string }) => `${c.base}/toy/hold?key=${p.key ?? randomUUID()}&customer=${p.customer ?? world.customers[0]}&ms=${p.ms}`;
const post = (url: string) => fetch(url, { method: 'POST' });
const connectionsOfUser = async () => Number(((await world.root.query<any[]>('SELECT COUNT(*) AS n FROM information_schema.PROCESSLIST WHERE USER = ?', [world.scratch.user]))[0] as any[])[0].n);
async function eventually<T>(read: () => Promise<T>, ok: (v: T) => boolean, ms = 5000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const v = await read();
    if (ok(v) || Date.now() > until) return v;
    await sleep(50);
  }
}
/** The customer row can be locked at once: a lock still held by a dead process would wait for the lock timeout (1 s here). */
async function customerRowIsFree() {
  const c = await world.scratch.connect();
  try {
    await c.query('SET SESSION innodb_lock_wait_timeout = 1');
    await c.query('START TRANSACTION');
    const t0 = Date.now();
    const e = await errorOf(() => c.query('SELECT id FROM customers WHERE id = ? FOR UPDATE', [world.customers[0]]));
    await c.query('ROLLBACK');
    return { ok: e === null, ms: Date.now() - t0 };
  } finally {
    await c.end();
  }
}

describe('T-C18 SIGTERM (a deploy, an "Apply changes", a restart): stop accepting, let running transactions finish (at most 10 s), close the pool', () => {
  it('the grace is 10 seconds, as H7 says', () => {
    expect(SHUTDOWN_GRACE_MS).toBe(10_000);
  });

  it('the entry point dist/server.js, idle: SIGTERM closes the pool (no connection is left on the server) and the process ends with exit code 0', async () => {
    const s = await start({ fixture: false });
    expect((await fetch(`${s.base}/healthz`)).status).toBe(200);
    expect(await eventually(connectionsOfUser, (n) => n >= 1)).toBeGreaterThanOrEqual(1); // the start-up check opened one
    s.proc.kill('SIGTERM');
    const { code, signal } = await s.exit;
    expect([code, signal]).toEqual([0, null]);
    expect(await eventually(connectionsOfUser, (n) => n === 0)).toBe(0);
  }, 60_000);

  it('SIGINT does the same (a developer\'s Ctrl-C)', async () => {
    const s = await start({ fixture: false });
    s.proc.kill('SIGINT');
    expect((await s.exit).code).toBe(0);
  }, 60_000);

  it('SIGTERM in the middle of a transaction: the listener closes, the running call FINISHES and commits (answered 200), then the pool is closed and the process ends with 0', async () => {
    const s = await start({ fixture: true });
    const key = randomUUID();
    const running = post(hold(s, { key, ms: 1500 }));
    await s.waitFor('IN_TX');
    s.proc.kill('SIGTERM');
    // no new call is accepted any more
    expect(await eventually(() => canConnect(s.port), (up) => !up, 1000)).toBe(false);
    const res = await running;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ number: 1, replayed: false });
    const { code } = await s.exit;
    expect(code, s.log()).toBe(0);
    expect(await leftovers(world)).toEqual({ categories: 1, audit: 1, claims: 1, counter: 1 });
    expect(await eventually(connectionsOfUser, (n) => n === 0)).toBe(0);
    expect(await customerRowIsFree()).toMatchObject({ ok: true });
  }, 60_000);

  it('SIGTERM and a transaction that will not finish within the grace (0.8 s here instead of 10): the process ends, the transaction is rolled back by MariaDB, nothing is half-saved and the locks are free at once', async () => {
    const s = await start({ fixture: true, graceMs: 800 });
    const running = post(hold(s, { ms: 8000 })).catch((e) => e as Error);
    await s.waitFor('IN_TX');
    const t0 = Date.now();
    s.proc.kill('SIGTERM');
    const { code } = await s.exit;
    expect(Date.now() - t0).toBeLessThan(4000);
    expect(code).toBe(1); // it did not finish by itself: the exit says so
    const answer = await running;
    expect(answer instanceof Error || (answer as Response).status !== 200).toBe(true); // the caller never got a success it could rely on
    expect(await leftovers(world)).toEqual(NOTHING);
    expect(await eventually(connectionsOfUser, (n) => n === 0)).toBe(0);
    expect(await customerRowIsFree()).toMatchObject({ ok: true });
    expect(s.log()).toMatch(/shutdown/i);
  }, 60_000);
});

describe('T-C18 a process killed in the middle of a transaction', () => {
  it('SIGKILL: nothing is committed, the locks are released at once, and the same Idempotency-Key retried on the next start saves once', async () => {
    const key = randomUUID();
    const first = await start({ fixture: true });
    const running = post(hold(first, { key, ms: 20_000 })).catch((e) => e as Error);
    await first.waitFor('IN_TX');
    // while it holds the customer row, another connection cannot take it
    const blocked = await customerRowIsFree();
    expect(blocked.ok).toBe(false);
    first.proc.kill('SIGKILL');
    const { signal } = await first.exit;
    expect(signal).toBe('SIGKILL');
    await running;
    expect(await eventually(connectionsOfUser, (n) => n === 0)).toBe(0);
    expect(await leftovers(world)).toEqual(NOTHING); // not a claim, not a number, not a row, not an audit row
    const free = await customerRowIsFree();
    expect(free.ok).toBe(true);
    expect(free.ms).toBeLessThan(900);

    // the next start serves the first request, and the retry with the same key runs the call once; asking again returns the stored result
    const second = await start({ fixture: true });
    const a = await post(hold(second, { key, ms: 0 }));
    expect([a.status, await a.json()]).toEqual([200, { number: 1, replayed: false }]);
    const b = await post(hold(second, { key, ms: 0 }));
    expect([b.status, await b.json()]).toEqual([200, { number: 1, replayed: true }]);
    expect(await leftovers(world)).toEqual({ categories: 1, audit: 1, claims: 1, counter: 1 });
  }, 90_000);

  it('a deploy starts the app twice: two processes overlap, both serve and write, the first ends with SIGTERM, and nothing durable is lost', async () => {
    const a = await start({ fixture: true });
    const b = await start({ fixture: true });
    expect((await post(hold(a, { ms: 0 }))).status).toBe(200);
    expect((await post(hold(b, { ms: 0 }))).status).toBe(200);
    a.proc.kill('SIGTERM');
    expect((await a.exit).code).toBe(0);
    expect((await post(hold(b, { ms: 0 }))).status).toBe(200);
    expect(await leftovers(world)).toEqual({ categories: 3, audit: 3, claims: 3, counter: 3 });
  }, 90_000);
});
