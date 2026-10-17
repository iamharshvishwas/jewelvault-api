import { randomUUID } from 'node:crypto';
import type { Connection } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writeEvent } from '../../src/db/events';
import { type DbPool, createDbPool } from '../../src/db/pool';
import { txContext, withTx } from '../../src/db/tx';
import { type Scratch, scratchDatabase } from '../helpers';

// T-D14 (L1, D16): the helper that writes an `event` row to audit_log in the caller's transaction. A login, a logout and a change-password (API05), the admin door (API09) and each tick phase (API33)
// all write through it. The clause of each of those tasks is in its own test; this file proves the helper itself.

let scratch: Scratch;
let sql: Connection;
let pool: DbPool;

beforeAll(async () => {
  scratch = await scratchDatabase('events', { schema: true });
  sql = await scratch.connect();
  pool = createDbPool(scratch.db);
}, 60_000);

afterAll(async () => {
  await pool?.end();
  await sql?.end();
  await scratch?.drop();
});

const rowsFor = async (requestId: string) => (await sql.query<any[]>('SELECT actor, actor_role, request_id, table_name, row_id, action, old_row, new_row FROM audit_log WHERE request_id = ? ORDER BY id', [requestId]))[0];
const asObject = (v: unknown) => (typeof v === 'string' ? JSON.parse(v) : v);
/** A misuse of the helper is a bug in the caller: withTx answers it JV_INTERNAL and keeps the TypeError as the cause (for the log). */
const bugMessage = async (call: Promise<unknown>): Promise<string> => {
  try {
    await call;
  } catch (e) {
    const cause = (e as { cause?: unknown }).cause;
    expect(cause).toBeInstanceOf(TypeError);
    return (cause as Error).message;
  }
  throw new Error('the call did not fail');
};

describe('T-D14 writeEvent: one `event` row in the same transaction, with the actor, the role and the request id', () => {
  it('writes action event with the facts in new_row, the actor and role of the transaction, and its request id', async () => {
    const requestId = randomUUID();
    const actor = randomUUID();
    const subject = randomUUID();
    await withTx(txContext(pool, { requestId, actor: { id: actor, role: 'biller' } }), async (tx) => {
      await writeEvent(tx, { table: 'users', rowId: subject, facts: { event: 'login', session_id: randomUUID(), previous_session_ended: 0 } });
    });
    const rows = await rowsFor(requestId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor, actor_role: 'biller', request_id: requestId, table_name: 'users', row_id: subject, action: 'event', old_row: null });
    expect(asObject(rows[0].new_row)).toMatchObject({ event: 'login', previous_session_ended: 0 });
  });

  it('a job or the admin door has no user id: the actor is empty and the role says what it is', async () => {
    for (const role of ['admin-cli', 'job']) {
      const requestId = randomUUID();
      await withTx(txContext(pool, { requestId, actor: { id: null, role } }), async (tx) => {
        await writeEvent(tx, { table: 'users', rowId: 'x', facts: { event: 'reset_password' } });
      });
      const rows = await rowsFor(requestId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ actor: null, actor_role: role, action: 'event' });
    }
  });

  it('it is part of the transaction: when the call fails afterwards, no event row is left', async () => {
    const requestId = randomUUID();
    await expect(
      withTx(txContext(pool, { requestId, actor: { id: randomUUID(), role: 'owner' } }), async (tx) => {
        await writeEvent(tx, { table: 'users', rowId: 'x', facts: { event: 'logout' } });
        throw new Error('the call failed after the event was written');
      }),
    ).rejects.toThrow();
    expect(await rowsFor(requestId)).toHaveLength(0);
  });

  it('a transaction with no actor is a bug in the code that called it: TypeError, nothing written', async () => {
    const requestId = randomUUID();
    const message = await bugMessage(
      withTx(txContext(pool, { requestId }), async (tx) => {
        await writeEvent(tx, { table: 'users', rowId: 'x', facts: { event: 'login' } });
      }),
    );
    expect(message).toMatch(/actor/i);
    expect(await rowsFor(requestId)).toHaveLength(0);
  });

  it('the facts hold no password, ticket or hash: such a key, at any depth, is refused before anything is written (control: other keys pass)', async () => {
    const secretKeys = ['password', 'new_password', 'current_password', 'password_hash', 'passwordHash', 'token', 'token_hash', 'ticket', 'session_ticket', 'cookie', 'set_cookie', 'authorization', 'secret', 'api_secret', 'hash'];
    for (const key of secretKeys) {
      const requestId = randomUUID();
      const message = await bugMessage(
        withTx(txContext(pool, { requestId, actor: { id: randomUUID(), role: 'owner' } }), async (tx) => {
          await writeEvent(tx, { table: 'users', rowId: 'x', facts: { event: 'login', [key]: 'x' } });
        }),
      );
      expect(message, key).toMatch(/secret|password|ticket|hash/i);
      expect(message, key).toContain(key);
      expect(await rowsFor(requestId), key).toHaveLength(0);
    }
    const nested = randomUUID();
    expect(
      await bugMessage(
        withTx(txContext(pool, { requestId: nested, actor: { id: randomUUID(), role: 'owner' } }), async (tx) => {
          await writeEvent(tx, { table: 'users', rowId: 'x', facts: { event: 'login', detail: { list: [{ password: 'x' }] } } });
        }),
      ),
    ).toMatch(/password/);
    const fine = randomUUID();
    await withTx(txContext(pool, { requestId: fine, actor: { id: randomUUID(), role: 'owner' } }), async (tx) => {
      await writeEvent(tx, { table: 'users', rowId: 'x', facts: { event: 'change_password', other_sessions_ended: 2, session_id: randomUUID() } });
    });
    expect(await rowsFor(fine)).toHaveLength(1);
  });

  it('the event needs a name, and the table and row id fit their columns', async () => {
    const ctx = () => txContext(pool, { requestId: randomUUID(), actor: { id: randomUUID(), role: 'owner' } });
    await expect(withTx(ctx(), (tx) => writeEvent(tx, { table: 'users', rowId: 'x', facts: { event: '' } }))).rejects.toThrow();
    await expect(withTx(ctx(), (tx) => writeEvent(tx, { table: '', rowId: 'x', facts: { event: 'login' } }))).rejects.toThrow();
    await expect(withTx(ctx(), (tx) => writeEvent(tx, { table: 'users', rowId: 'x'.repeat(65), facts: { event: 'login' } }))).rejects.toThrow();
  });
});
