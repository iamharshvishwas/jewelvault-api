// Test fixture for the T-C18 clause of API14 (restart safety of the Idempotency-Key): the REAL app, pool, withTx, shutdown handler, claim and numbering helpers from the compiled build (JV_DIST),
// plus one toy creating route. It is started as a child process by tests/api/idempotency.test.ts, which signals it and then looks at the database. Nothing here is part of the product.
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const dist = process.env.JV_DIST;
const load = (name) => import(pathToFileURL(join(dist, name)).href);
const { buildApp } = await load('app.js');
const { loadConfig } = await load('config.js');
const { createDbPool } = await load('db/pool.js');
const { withTx, txContextFor } = await load('db/tx.js');
const { idempotent, idempotencyKey, markReplay } = await load('db/idempotency.js');
const { takeNumber } = await load('db/numbers.js');
const { newId } = await load('db/ids.js');
const { installShutdown, SHUTDOWN_GRACE_MS } = await load('shutdown.js');

const config = loadConfig(process.env);
const pool = createDbPool(config.db);
const app = buildApp({ config, db: pool });
const actor = { id: '11111111-1111-4111-8111-111111111111', role: 'biller' };

// POST /toy/create?customer=<uuid>&ms=<n> with an Idempotency-Key header and a JSON body: claim, lock the customer, take a number, write a row (and by the trigger its audit row), hold for ms, store the
// result, commit. A repeat of a key that committed returns the stored result with Idempotent-Replay: true and writes nothing.
app.post('/toy/create', async (request, reply) => {
  const { customer, ms } = request.query;
  const key = idempotencyKey(request.headers);
  const out = await withTx(txContextFor(pool, request, actor), (tx) =>
    idempotent(tx, { key, fn: 'toy_create', route: 'POST /toy/create', body: request.body }, async () => {
      await tx.rows('SELECT id FROM customers WHERE id = ? FOR UPDATE', [customer]);
      const number = await takeNumber(tx, 'toy:2026');
      await tx.run('INSERT INTO categories (id, name, prefix) VALUES (?, ?, ?)', [newId(), `held#${number}`, 'TY']);
      process.stdout.write('IN_TX\n');
      await new Promise((resolve) => setTimeout(resolve, Number(ms ?? 0)));
      return { number };
    }),
  );
  markReplay(reply, out.replayed);
  reply.code(201);
  return out.value;
});

installShutdown(app, { graceMs: Number(process.env.JV_GRACE_MS || SHUTDOWN_GRACE_MS) });
await app.listen({ port: config.port, host: '0.0.0.0' });
process.stdout.write(`READY ${config.port}\n`);
