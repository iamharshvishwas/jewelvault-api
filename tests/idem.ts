import { createHash, randomUUID } from 'node:crypto';
import type { Connection } from 'mysql2/promise';

export const IDEMPOTENCY_DDL = `CREATE TABLE idempotency (
    request_id CHAR(36) NOT NULL PRIMARY KEY,
    fn VARCHAR(40) NOT NULL,
    actor CHAR(36) NOT NULL,
    args_hash CHAR(64) NOT NULL,
    claim_token CHAR(36) NOT NULL,
    result JSON NULL,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
  ) ENGINE=InnoDB`;

export class InvalidInput extends Error {
  code = 'JV_INVALID_INPUT';
}

export const hashArgs = (args: unknown) => createHash('sha256').update(JSON.stringify(args)).digest('hex');

/**
 * Spec L5 in MariaDB: the FIRST statement of the transaction claims the request id.
 *  - INSERT ... ON DUPLICATE KEY UPDATE request_id = request_id  (a no-op update; waits for an in-flight identical request to commit or roll back)
 *  - then a locking read of the row tells us whether our claim_token won.
 * If it did not win, the stored result is returned when fn, actor and args_hash all match.
 * (affectedRows is NOT used to decide: with mysql2's default FOUND_ROWS flag a duplicate also reports 1.)
 */
export async function idempotent<T>(
  conn: Connection,
  req: { requestId: string; fn: string; actor: string; args: unknown },
  work: () => Promise<T>,
  hooks: { afterClaim?: () => Promise<void> } = {}
): Promise<{ value: T; replayed: boolean }> {
  const token = randomUUID();
  const hash = hashArgs(req.args);
  await conn.query('START TRANSACTION');
  try {
    await conn.query(
      `INSERT INTO idempotency (request_id, fn, actor, args_hash, claim_token) VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE request_id = request_id`,
      [req.requestId, req.fn, req.actor, hash, token]
    );
    const [rows] = await conn.query<any[]>(
      'SELECT fn, actor, args_hash, claim_token, result FROM idempotency WHERE request_id = ? FOR UPDATE',
      [req.requestId]
    );
    const row = rows[0];
    if (!row) throw new Error('claim row not visible after insert'); // would mean a stale snapshot
    if (row.claim_token === token) {
      await hooks.afterClaim?.();
      const value = await work();
      await conn.query('UPDATE idempotency SET result = ? WHERE request_id = ?', [JSON.stringify(value), req.requestId]);
      await conn.query('COMMIT');
      return { value, replayed: false };
    }
    if (row.fn !== req.fn || row.actor !== req.actor || row.args_hash !== hash) {
      throw new InvalidInput('same request id with different arguments');
    }
    if (row.result === null) throw new Error('claimed but no result stored');
    await conn.query('COMMIT');
    // mysql2 already turns a MariaDB JSON column into an object (see test d); a string would be parsed here
    return { value: (typeof row.result === 'string' ? JSON.parse(row.result) : row.result) as T, replayed: true };
  } catch (e) {
    await conn.query('ROLLBACK').catch(() => undefined);
    throw e;
  }
}
