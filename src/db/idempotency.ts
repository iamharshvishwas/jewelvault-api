// L5, NODE-DESIGN 4.6: repeat-safety of every function that creates something.
//
// The FIRST statement of a creating function is the claim: INSERT INTO sys_idempotency (request_id, fn, actor, args_hash, claim_token) ... ON DUPLICATE KEY UPDATE request_id = request_id, with a fresh
// random claim_token, and then the row is read back FOR UPDATE.
//  - request_id is the Idempotency-Key header (a UUID the screen makes once for each call and reuses for a retry); args_hash is the SHA-256 of a canonical JSON (keys sorted) of the route name, the path
//    ids, the body and the actor id.
//  - The token tells who is first, not the row count: with mysql2's default flags affectedRows is 1 for a fresh insert and for a duplicate alike. If the token is ours the call is first and carries on,
//    and stores its result in that row in the SAME transaction. If it is another request's (the INSERT first waited for any in-flight identical request to commit), the stored result is returned when
//    fn, actor and args_hash all match (the route sends Idempotent-Replay: true), and JV_INVALID_INPUT otherwise: the same key with another cart is refused, not answered with the first result.
//  - A first request that rolls back leaves no row, so the waiting twin becomes first and runs. A failure after the claim (the function's own role check, X0 item 2) rolls the claim back with it.
//  - A call that fails the route wrapper's checks never gets here, so it never uses up its key; a creating call without a valid key is refused here before any statement is sent.
//  - The database runs READ-COMMITTED (S11): under REPEATABLE READ an old snapshot made the duplicate probe fail with error 1020.
// L6: the nightly housekeeping of the tick (src/jobs/housekeeping.ts, API33b) empties the result of a row older than 90 days; the row stays (S7) and a repeat of its key is refused with
// JV_INVALID_INPUT "this request is too old to repeat" and never run again.
import { createHash, randomUUID } from 'node:crypto';
import { JvError } from '../errors.js';
import { UUID_TEXT } from '../wire/format.js';
import { noteStep } from './locks.js';
import type { Tx } from './tx.js';

export const IDEMPOTENCY_KEY_HEADER = 'Idempotency-Key';
export const REPLAY_HEADER = 'Idempotent-Replay';

const KEY_FIELD = { field: IDEMPOTENCY_KEY_HEADER };

/** sys_idempotency.fn is VARCHAR(40): the service function's name, such as create_bill. */
const FN_NAME = /^[a-z][a-z0-9_]{0,39}$/;

// ------------------------------------------------------------------ the key

function checkKey(value: unknown): string {
  if (typeof value !== 'string') throw new JvError('JV_INVALID_INPUT', 'An Idempotency-Key header is required when something is saved: a UUID made once for each action and kept for a retry.', { details: KEY_FIELD });
  const key = value.toLowerCase(); // the column is a UUID: capitals and small letters are one key
  if (!UUID_TEXT.test(key)) throw new JvError('JV_INVALID_INPUT', 'The Idempotency-Key header must be a UUID.', { details: KEY_FIELD });
  return key;
}

/**
 * The Idempotency-Key of a request, from its headers (Node writes header names in lower case; a header sent twice arrives joined with a comma, which is not a UUID). Missing or not a UUID is
 * JV_INVALID_INPUT (422). The route wrapper calls this for every creating route before it starts the transaction.
 */
export function idempotencyKey(headers: Record<string, string | string[] | undefined>): string {
  const raw = headers['idempotency-key'];
  return checkKey(Array.isArray(raw) ? (raw.length === 1 ? raw[0] : undefined) : raw);
}

// ------------------------------------------------------------------ the hash of the request

function serialize(v: unknown): string | undefined {
  if (v === null) return 'null';
  switch (typeof v) {
    case 'string':
      return JSON.stringify(v);
    case 'boolean':
      return v ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(v)) throw new TypeError('a canonical JSON holds finite numbers only');
      return JSON.stringify(v);
    case 'undefined':
      return undefined;
    case 'object': {
      if (Array.isArray(v)) return `[${v.map((x) => serialize(x) ?? 'null').join(',')}]`; // as JSON.stringify: undefined in a list is null
      const proto = Object.getPrototypeOf(v) as unknown;
      if (proto !== Object.prototype && proto !== null) throw new TypeError('a canonical JSON holds plain objects, lists, text, finite numbers, booleans and null only');
      const record = v as Record<string, unknown>;
      const parts: string[] = [];
      for (const k of Object.keys(record).sort()) {
        const s = serialize(record[k]);
        if (s !== undefined) parts.push(`${JSON.stringify(k)}:${s}`); // a property that is undefined is left out, as JSON.stringify does
      }
      return `{${parts.join(',')}}`;
    }
    default:
      throw new TypeError('a canonical JSON holds plain objects, lists, text, finite numbers, booleans and null only');
  }
}

/** JSON with the keys of every object sorted (by UTF-16 code unit), arrays in their order, no spaces. Anything JSON cannot hold is a bug in the caller (TypeError). */
export function canonicalJson(value: unknown): string {
  const text = serialize(value);
  if (text === undefined) throw new TypeError('a canonical JSON needs a value');
  return text;
}

export interface HashInput {
  /** the route name, such as "POST /v1/bills" */
  route: string;
  /** the ids in the path, by name */
  pathIds?: Record<string, string>;
  /** the parsed body (money and weight as strings, as the wire has them) */
  body?: unknown;
  actorId: string;
}

/** SHA-256 (64 hex digits) of the canonical JSON of the route, the path ids, the body and the actor id. Its layout must not change: a key retried after a deploy is compared with the old hash. */
export function argsHash(input: HashInput): string {
  const text = canonicalJson({ actor: input.actorId, body: input.body === undefined ? null : input.body, path: input.pathIds ?? {}, route: input.route });
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

// ------------------------------------------------------------------ the claim

const CLAIM_SQL = 'INSERT INTO sys_idempotency (request_id, fn, actor, args_hash, claim_token) VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE request_id = request_id';
const READ_SQL = 'SELECT fn, actor, args_hash, claim_token, result FROM sys_idempotency WHERE request_id = ? FOR UPDATE';
const STORE_SQL = 'UPDATE sys_idempotency SET result = ? WHERE request_id = ?';

export interface ClaimRequest {
  /** the Idempotency-Key (see idempotencyKey()); undefined is refused */
  key: string | undefined;
  /** the service function, such as create_bill (kept in sys_idempotency.fn) */
  fn: string;
  /** the route name that goes into the hash */
  route: string;
  pathIds?: Record<string, string>;
  body?: unknown;
}

/** first: this call carries on and stores its result; otherwise the result the first request stored. `key` is the key as stored (lower case). */
export type Claim = { first: true; key: string } | { first: false; key: string; result: unknown };

interface ClaimRow {
  fn: string;
  actor: string;
  args_hash: string;
  claim_token: string | null;
  result: unknown;
}

/**
 * The claim, the first statement of a creating function (inside withTx; the actor is the signed-in user of the call). Throws JV_INVALID_INPUT for a missing or bad key, for a key that was used by
 * another function, actor or request, and for a key whose result is no longer kept. The messages never repeat what the caller sent.
 */
export async function claim(tx: Tx, req: ClaimRequest): Promise<Claim> {
  const key = checkKey(req.key);
  const actor = tx.actor?.id;
  if (!actor) throw new TypeError('a creating call has a signed-in user: the claim records who made it (sys_idempotency.actor)');
  if (typeof req.fn !== 'string' || !FN_NAME.test(req.fn)) throw new TypeError('the function name is 1 to 40 characters: a lower-case letter, then lower-case letters, digits and underscores');
  const hash = argsHash({ route: req.route, pathIds: req.pathIds, body: req.body, actorId: actor });
  const token = randomUUID();
  noteStep(tx, 'claim'); // X0 item 1: the first statement of the transaction; the trail refuses a claim that comes after another step
  await tx.run(CLAIM_SQL, [key, req.fn, actor, hash, token]);
  const [row] = await tx.rows<ClaimRow>(READ_SQL, [key]);
  if (!row) throw new JvError('JV_INTERNAL', 'Something unexpected went wrong.', { cause: new Error('the claim row is not there after its INSERT (the connection is not READ-COMMITTED?)') });
  if (row.claim_token === token) return { first: true, key };
  if (row.fn !== req.fn || row.actor !== actor || row.args_hash !== hash) {
    throw new JvError('JV_INVALID_INPUT', 'This Idempotency-Key was already used for a different request. Make a new key for a different action.', { details: KEY_FIELD });
  }
  if (row.result === null || row.result === undefined) {
    throw new JvError('JV_INVALID_INPUT', 'This request is too old to repeat: its answer is no longer kept. Check whether it was saved, then make a new key.', { details: KEY_FIELD });
  }
  return { first: false, key, result: typeof row.result === 'string' ? JSON.parse(row.result) : row.result };
}

/** Stores the result in the claim row, in the transaction of the work it describes. Money and weight inside it are strings (S12 (4)). */
export async function storeResult(tx: Tx, key: string, result: unknown): Promise<void> {
  // An object or a list, never bare text or a number: the driver may hand a JSON column back already parsed, and the only way to tell that from unparsed text is that unparsed text is { or [.
  if (typeof result !== 'object' || result === null) throw new TypeError('a stored result must be a JSON object or list');
  const json = JSON.stringify(result);
  const ok = await tx.run(STORE_SQL, [json, checkKey(key)]);
  if (ok.affectedRows !== 1) throw new JvError('JV_INTERNAL', 'Something unexpected went wrong.', { cause: new Error(`the result was stored in ${ok.affectedRows} claim rows`) });
}

/**
 * claim, then the work if this call is first (its result stored before COMMIT, in the same transaction), or the stored result of the first request. `replayed` tells the route to send
 * Idempotent-Replay: true (markReplay); the status is the route's own, the same for the first answer and the replay, because only a result that was saved is ever stored.
 */
export async function idempotent<T>(tx: Tx, req: ClaimRequest, work: () => Promise<T>): Promise<{ value: T; replayed: boolean }> {
  const c = await claim(tx, req);
  if (!c.first) return { value: c.result as T, replayed: true };
  const value = await work();
  await storeResult(tx, c.key, value);
  return { value, replayed: false };
}

/** The header of a replay (CORS exposes it, API19). Nothing for the first answer. */
export function markReplay(reply: { header(name: string, value: string): unknown }, replayed: boolean): void {
  if (replayed) reply.header(REPLAY_HEADER, 'true');
}
