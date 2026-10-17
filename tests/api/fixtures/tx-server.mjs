// Test fixture for T-C18 (restart safety): the REAL app, pool, withTx and shutdown handler from the compiled build (JV_DIST), plus two toy routes that hold a writing transaction open.
// It is started as a child process by tests/api/c18-restart.test.ts, which signals it and then looks at the database. Nothing here is part of the product.
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const dist = process.env.JV_DIST;
const load = (name) => import(pathToFileURL(join(dist, name)).href);
const { buildApp } = await load('app.js');
const { loadConfig } = await load('config.js');
const { createDbPool } = await load('db/pool.js');
const { withTx, txContextFor } = await load('db/tx.js');
const { installShutdown, SHUTDOWN_GRACE_MS } = await load('shutdown.js');
const { createRoute } = await load('permissions/route.js');

const config = loadConfig(process.env);
const pool = createDbPool(config.db);
const app = buildApp({ config, db: pool });
const actor = { id: '11111111-1111-4111-8111-111111111111', role: 'biller' };

// POST /toy/hold?key=<uuid>&customer=<uuid>&ms=<n>: claim, lock the customer, take a number, write a row (and, by the trigger, its audit row), hold for ms, commit.
// The claim is the L5 pattern: a repeat of a key that committed returns the stored result and writes nothing.
// every route goes through the wrapper (A1); this one is a public route of a table made for the test, so no session is looked up
createRoute({ matrix: {}, publicRoutes: { hold: { method: 'POST', path: '/toy/hold' } }, tokenDoors: {} })(app, { public: 'hold', handler: async ({ request }) => {
  const { key, customer, ms } = request.query;
  return withTx(txContextFor(pool, request, actor), async (tx) => {
    const token = randomUUID();
    await tx.run('INSERT INTO sys_idempotency (request_id, fn, actor, args_hash, claim_token) VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE request_id = request_id', [key, 'toy_hold', actor.id, 'c'.repeat(64), token]);
    const [claim] = await tx.rows('SELECT claim_token, result FROM sys_idempotency WHERE request_id = ? FOR UPDATE', [key]);
    if (claim.claim_token !== token) return { ...(typeof claim.result === 'string' ? JSON.parse(claim.result) : claim.result), replayed: true };
    await tx.rows('SELECT id FROM customers WHERE id = ? FOR UPDATE', [customer]);
    const bump = await tx.run('UPDATE sys_counters SET last_value = LAST_INSERT_ID(last_value + 1) WHERE series = ?', ['toy:2026']);
    const number = Number(bump.insertId);
    await tx.run('INSERT INTO categories (id, name, prefix) VALUES (?, ?, ?)', [randomUUID(), `held#${number}`, 'TY']);
    process.stdout.write('IN_TX\n');
    await new Promise((resolve) => setTimeout(resolve, Number(ms ?? 0)));
    const out = { number, replayed: false };
    await tx.run('UPDATE sys_idempotency SET result = ? WHERE request_id = ?', [JSON.stringify(out), key]);
    return out;
  });
} });

installShutdown(app, { graceMs: Number(process.env.JV_GRACE_MS || SHUTDOWN_GRACE_MS) });
await app.listen({ port: config.port, host: '0.0.0.0' });
process.stdout.write(`READY ${config.port}\n`);
