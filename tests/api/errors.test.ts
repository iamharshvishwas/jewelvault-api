import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app';
import { DbBusyError } from '../../src/db/errors';
import { createDbPool, type DbPool } from '../../src/db/pool';
import { BUSINESS_KEYS, BusyError, JV_STATUS, JvError, classifyError, describeCause, errorBody } from '../../src/errors';
import { InvalidInputError } from '../../src/wire/zod';
import { freePort, logSink, testConfig } from './support';
import { dbError } from './tx-support';

// S8 (the codes and what each database error becomes), T-C19 (the map), and the T-F08 clause of API03: the 503 JV_UNAVAILABLE and JV_BUSY answers carry the S8 body.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('T-C19 (S8) the codes and their HTTP statuses', () => {
  // written out here a second time, from the spec, so that an edit of the table in src/errors.ts has to be made twice
  const SPEC: Record<string, number> = {
    JV_INVALID_INPUT: 422,
    JV_FORBIDDEN: 403,
    JV_NOT_FOUND: 404,
    JV_PIECE_UNAVAILABLE: 409,
    JV_CUSTOMER_ARCHIVED: 409,
    JV_OVERPAYMENT: 409,
    JV_CASH_LIMIT: 409,
    JV_FINE_EXCEEDS: 409,
    JV_BILL_CANCELLED: 409,
    JV_ALREADY_VOID: 409,
    JV_NOT_ALLOWED: 409,
    JV_BUSY: 503,
    JV_STALE: 409,
    JV_UNAUTHENTICATED: 401,
    JV_SESSION_EXPIRED: 401,
    JV_BAD_LOGIN: 401,
    JV_PASSWORD_CHANGE_REQUIRED: 403,
    JV_CSRF: 403,
    JV_RATE_LIMITED: 429,
    JV_PAYLOAD_TOO_LARGE: 413,
    JV_UNSUPPORTED_MEDIA_TYPE: 415,
    JV_UNAVAILABLE: 503,
    JV_INTERNAL: 500,
  };

  it('holds every JV_* code of S8 with the status the spec gives, and no other', () => {
    expect({ ...JV_STATUS }).toEqual(SPEC);
  });

  it('an error carries the status of its code; JV_BUSY says Retry-After 1; JV_RATE_LIMITED must say how long', () => {
    for (const [code, status] of Object.entries(SPEC)) {
      if (code === 'JV_RATE_LIMITED') continue;
      const e = new JvError(code as keyof typeof JV_STATUS, 'm');
      expect([e.code, e.status]).toEqual([code, status]);
      expect(e.retryAfter).toBe(code === 'JV_BUSY' ? 1 : undefined);
      expect(e.details).toEqual({});
      expect(e).toBeInstanceOf(Error);
    }
    expect(new JvError('JV_RATE_LIMITED', 'm', { retryAfter: 30 }).retryAfter).toBe(30);
    expect(() => new JvError('JV_RATE_LIMITED', 'm')).toThrow(/Retry-After/);
  });

  it('the body is exactly {error:{code,message,details},request_id}', () => {
    const e = new JvError('JV_FINE_EXCEEDS', 'The fine is more than is pending.', { details: { max_grams: '12.500' } });
    const body = errorBody(e, 'abc');
    expect(body).toEqual({ error: { code: 'JV_FINE_EXCEEDS', message: 'The fine is more than is pending.', details: { max_grams: '12.500' } }, request_id: 'abc' });
    expect(Object.keys(body)).toEqual(['error', 'request_id']);
    expect(Object.keys(body.error)).toEqual(['code', 'message', 'details']);
  });
});

describe('the classes API02 and API06 made extend the one error class, their tests\' meaning unchanged', () => {
  it('DbBusyError: still code JV_BUSY, a reason, nothingStarted true; now also a JvError with status 503 and Retry-After 1', () => {
    const e = new DbBusyError('queue_full');
    expect(e).toMatchObject({ code: 'JV_BUSY', reason: 'queue_full', nothingStarted: true, status: 503, retryAfter: 1 });
    expect(e).toBeInstanceOf(JvError);
    expect(e).toBeInstanceOf(BusyError);
    expect(e.name).toBe('DbBusyError');
  });

  it('InvalidInputError: still field, details {field}, status 422, a message that names the input; now also a JvError', () => {
    const e = new InvalidInputError('items[2].metal_rate', 'is required');
    expect(e).toMatchObject({ code: 'JV_INVALID_INPUT', status: 422, field: 'items[2].metal_rate' });
    expect(e.details).toEqual({ field: 'items[2].metal_rate' });
    expect(Object.isFrozen(e.details)).toBe(true);
    expect(e.message).toBe('items[2].metal_rate is required');
    expect(e).toBeInstanceOf(JvError);
    expect(errorBody(e, 'r')).toEqual({ error: { code: 'JV_INVALID_INPUT', message: 'items[2].metal_rate is required', details: { field: 'items[2].metal_rate' } }, request_id: 'r' });
  });

  it('classifying a JvError gives the same object back (a domain error is never rewritten)', () => {
    for (const e of [new DbBusyError('closing'), new InvalidInputError('x', 'y'), new JvError('JV_OVERPAYMENT', 'm')]) expect(classifyError(e)).toBe(e);
  });
});

describe('T-C19 (S8) what each database error becomes (the map of src/errors.ts)', () => {
  const what = (e: unknown) => {
    const c = classifyError(e);
    return { code: c.code, status: c.status, reason: (c as BusyError).reason, bug: c.bug };
  };

  it('a lock wait timeout (1205), a statement timeout (1969) and a deadlock (1213) are JV_BUSY, each with its reason', () => {
    expect(what(dbError(1205, 'ER_LOCK_WAIT_TIMEOUT', 'Lock wait timeout exceeded; try restarting transaction'))).toMatchObject({ code: 'JV_BUSY', status: 503, reason: 'lock_wait' });
    expect(what(dbError(1969, 'ER_STATEMENT_TIMEOUT', 'Query execution was interrupted (max_statement_time exceeded)'))).toMatchObject({ code: 'JV_BUSY', reason: 'statement_timeout' });
    expect(what(dbError(1213, 'ER_LOCK_DEADLOCK', 'Deadlock found when trying to get lock; try restarting transaction'))).toMatchObject({ code: 'JV_BUSY', reason: 'deadlock' });
  });

  it('a lost connection is JV_BUSY, however the driver says it: fatal, PROTOCOL_CONNECTION_LOST, ECONNRESET, EPIPE, killed (1927), gone away (2006, 2013), shutdown (1053)', () => {
    const lost = [
      Object.assign(new Error('x'), { fatal: true }),
      Object.assign(new Error('x'), { code: 'PROTOCOL_CONNECTION_LOST' }),
      Object.assign(new Error('x'), { code: 'ECONNRESET' }),
      Object.assign(new Error('x'), { code: 'EPIPE' }),
      dbError(1927, 'ER_CONNECTION_KILLED', 'Connection was killed'),
      dbError(2006, 'CR_SERVER_GONE_ERROR', 'MySQL server has gone away'),
      dbError(2013, 'CR_SERVER_LOST', 'Lost connection to MySQL server during query'),
      dbError(1053, 'ER_SERVER_SHUTDOWN', 'Server shutdown in progress'),
    ];
    for (const e of lost) expect(what(e), JSON.stringify((e as any).code ?? (e as any).fatal)).toMatchObject({ code: 'JV_BUSY', reason: 'connection_lost' });
  });

  it('the server out of connections (1040, 1203) is JV_BUSY too: nothing had started', () => {
    for (const n of [1040, 1203]) expect(what(dbError(n, 'ER_CON_COUNT_ERROR', 'Too many connections'))).toMatchObject({ code: 'JV_BUSY', reason: 'connect_refused' });
  });

  it('the errors API02 passes through untouched: ECONNREFUSED and access denied mean the database cannot be reached, JV_UNAVAILABLE 503 (NODE-DESIGN 4.5)', () => {
    for (const e of [
      Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:3306'), { code: 'ECONNREFUSED', errno: -111 }),
      Object.assign(new Error('getaddrinfo ENOTFOUND db'), { code: 'ENOTFOUND' }),
      dbError(1045, 'ER_ACCESS_DENIED_ERROR', "Access denied for user 'x'@'localhost' (using password: YES)"),
      dbError(1044, 'ER_DBACCESS_DENIED_ERROR', "Access denied for user 'x'@'%' to database 'y'"),
      dbError(1049, 'ER_BAD_DB_ERROR', "Unknown database 'y'"),
    ]) {
      const c = classifyError(e);
      expect([c.code, c.status, c.retryAfter]).toEqual(['JV_UNAVAILABLE', 503, undefined]);
      expect(JSON.stringify(errorBody(c, 'r'))).not.toMatch(/Access denied|ECONNREFUSED|ENOTFOUND|Unknown database/); // the reason is for the log
    }
  });

  it('a duplicate key (1062): on a business key it is JV_INVALID_INPUT; on anything else a bug, JV_INTERNAL', () => {
    const dup = (key: string) => dbError(1062, 'ER_DUP_ENTRY', `Duplicate entry 'X-1' for key '${key}'`);
    for (const key of BUSINESS_KEYS) expect(what(dup(key)), key).toMatchObject({ code: 'JV_INVALID_INPUT', status: 422 });
    expect(BUSINESS_KEYS).toContain('uq_designs_no');
    for (const key of ['PRIMARY', 'uq_bills_no', 'uq_bills_request', 'uq_skus_no', 'uq_job_runs_day', 'something_new']) expect(what(dup(key)), key).toMatchObject({ code: 'JV_INTERNAL', status: 500 });
    // older servers and MySQL write the table in front of the key's name
    expect(what(dbError(1062, 'ER_DUP_ENTRY', "Duplicate entry 'D-1' for key 'designs.uq_designs_no'"))).toMatchObject({ code: 'JV_INVALID_INPUT' });
    expect(what(dbError(1062, 'ER_DUP_ENTRY', 'Duplicate entry'))).toMatchObject({ code: 'JV_INTERNAL' }); // a message with no key: not a business key
  });

  it('a failed CHECK (4025) and an out-of-range value (1264) are JV_INVALID_INPUT and logged as a bug; foreign keys (1451, 1452) and anything else are JV_INTERNAL', () => {
    expect(what(dbError(4025, 'ER_CONSTRAINT_FAILED', 'CONSTRAINT `chk_receipt_amount` failed for `db`.`receipts`'))).toMatchObject({ code: 'JV_INVALID_INPUT', status: 422, bug: true });
    expect(what(dbError(1264, 'ER_WARN_DATA_OUT_OF_RANGE', "Out of range value for column 'amount' at row 1"))).toMatchObject({ code: 'JV_INVALID_INPUT', bug: true });
    for (const n of [1451, 1452]) expect(what(dbError(n, 'ER_ROW_IS_REFERENCED_2', 'Cannot delete or update a parent row: a foreign key constraint fails'))).toMatchObject({ code: 'JV_INTERNAL', status: 500 });
    expect(what(new TypeError('x is not a function'))).toMatchObject({ code: 'JV_INTERNAL', status: 500 });
    expect(what('a string')).toMatchObject({ code: 'JV_INTERNAL' });
    expect(what(dbError(1146, 'ER_NO_SUCH_TABLE', "Table 'db.nothing' doesn't exist"))).toMatchObject({ code: 'JV_INTERNAL' });
  });

  it('Fastify\'s own errors: the handler timer is JV_BUSY, a big body 413, a wrong media type 415, any other unreadable request 422', () => {
    expect(what(Object.assign(new Error('x'), { code: 'FST_ERR_HANDLER_TIMEOUT', statusCode: 503 }))).toMatchObject({ code: 'JV_BUSY', reason: 'handler_timeout' });
    expect(what(Object.assign(new Error('x'), { code: 'FST_ERR_CTP_BODY_TOO_LARGE', statusCode: 413 }))).toMatchObject({ code: 'JV_PAYLOAD_TOO_LARGE', status: 413 });
    expect(what(Object.assign(new Error('x'), { code: 'FST_ERR_CTP_INVALID_MEDIA_TYPE', statusCode: 415 }))).toMatchObject({ code: 'JV_UNSUPPORTED_MEDIA_TYPE', status: 415 });
    expect(what(Object.assign(new Error('x'), { code: 'FST_ERR_CTP_INVALID_JSON_BODY', statusCode: 400 }))).toMatchObject({ code: 'JV_INVALID_INPUT', status: 422 });
  });

  it('JV_INTERNAL carries no SQL, stack or table name, whatever the error said (A14); the cause is kept for the log', () => {
    const raw = dbError(1146, 'ER_NO_SUCH_TABLE', "Table 'jewel.secret_table' doesn't exist", { sql: 'SELECT * FROM secret_table WHERE pan = ?' });
    const c = classifyError(raw);
    const text = JSON.stringify(errorBody(c, 'r'));
    expect(text).not.toMatch(/secret_table|SELECT|jewel|pan|ER_NO_SUCH_TABLE|1146/);
    expect(c.cause).toBe(raw);
  });

  it('a message written to the log never holds the value that was refused: a duplicate-entry message loses its value, the key stays', () => {
    const d = describeCause(dbError(1062, 'ER_DUP_ENTRY', "Duplicate entry '9876543210' for key 'uq_customers_mobile'"));
    expect(JSON.stringify(d)).not.toContain('9876543210');
    expect(d).toMatchObject({ errno: 1062, code: 'ER_DUP_ENTRY' });
    expect(JSON.stringify(d)).toContain('uq_customers_mobile');
    expect(JSON.stringify(describeCause(dbError(1366, 'ER_TRUNCATED_WRONG_VALUE_FOR_FIELD', "Incorrect string value: '\\xF0\\x9F' for column `name` at row 1")))).not.toContain('xF0');
  });
});

describe('T-F08 (clause of API03): the 503 JV_UNAVAILABLE and JV_BUSY answers carry the S8 body {error:{code,message,details},request_id}', () => {
  const apps: ReturnType<typeof buildApp>[] = [];
  const pools: DbPool[] = [];
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((a) => a.close().catch(() => undefined)));
    await Promise.all(pools.splice(0).map((p) => p.end().catch(() => undefined)));
  });

  const expectS8 = (res: { body: string; headers: Record<string, unknown> }, code: string) => {
    const body = JSON.parse(res.body);
    expect(Object.keys(body)).toEqual(['error', 'request_id']);
    expect(Object.keys(body.error)).toEqual(['code', 'message', 'details']);
    expect(body.error.code).toBe(code);
    expect(typeof body.error.message).toBe('string');
    expect(body.error.message.length).toBeGreaterThan(0);
    expect(body.error.details).toEqual({});
    expect(body.request_id).toMatch(UUID);
    return body;
  };

  function toy() {
    const sink = logSink();
    const app = buildApp({ config: testConfig(), logStream: sink.stream });
    apps.push(app);
    for (const reason of ['queue_full', 'wait_timeout', 'connect_refused', 'connection_lost', 'closing'] as const) app.get(`/toy/busy/${reason}`, async () => Promise.reject(new DbBusyError(reason)));
    app.get('/toy/domain', async () => Promise.reject(new JvError('JV_OVERPAYMENT', 'The payment is more than is pending.', { details: { pending: '10.00' } })));
    app.get('/toy/invalid', async () => Promise.reject(new InvalidInputError('amount', 'is required')));
    app.get('/toy/internal', async () => Promise.reject(dbError(1146, 'ER_NO_SUCH_TABLE', "Table 'jewel.secret_table' doesn't exist", { sql: 'SELECT * FROM secret_table' })));
    app.get('/toy/bug', async () => Promise.reject(dbError(1264, 'ER_WARN_DATA_OUT_OF_RANGE', "Out of range value for column 'amount' at row 1")));
    app.post('/toy/body', async (request) => request.body);
    return { app, sink };
  }

  it('JV_BUSY: 503 with Retry-After 1 and the S8 body, for each way the pool can refuse; the reason is in the log, not in the body', async () => {
    const { app, sink } = toy();
    for (const reason of ['queue_full', 'wait_timeout', 'connect_refused', 'connection_lost', 'closing']) {
      const res = await app.inject({ method: 'GET', url: `/toy/busy/${reason}` });
      expect(res.statusCode, reason).toBe(503);
      expect(res.headers['retry-after'], reason).toBe('1');
      expect(res.headers['content-type']).toMatch(/application\/json/);
      expectS8(res, 'JV_BUSY');
      expect(res.body).not.toContain(reason);
    }
    expect(sink.lines().filter((l) => l.reason === 'queue_full' && l.level === 40)).toHaveLength(1); // warn, with the reason
  });

  it('JV_UNAVAILABLE: 503, no Retry-After, the S8 body, the request id is a UUID (the audit log\'s request_id column is a UUID)', async () => {
    const port = await freePort(); // nothing listens there: the start-up check fails
    const pool = createDbPool({ host: '127.0.0.1', port, name: 'x', user: 'x', password: 'x' });
    pools.push(pool);
    const sink = logSink();
    const app = buildApp({ config: testConfig(), db: pool, logStream: sink.stream });
    apps.push(app);
    await app.ready();
    const res = await app.inject({ method: 'GET', url: '/anything' });
    expect(res.statusCode).toBe(503);
    expect(res.headers['retry-after']).toBeUndefined();
    expectS8(res, 'JV_UNAVAILABLE');
  });

  it('a handler that meets an unreachable database answers JV_UNAVAILABLE in the same body', async () => {
    const { app } = toy();
    app.get('/toy/down', async () => Promise.reject(Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1'), { code: 'ECONNREFUSED' })));
    const res = await app.inject({ method: 'GET', url: '/toy/down' });
    expect(res.statusCode).toBe(503);
    expectS8(res, 'JV_UNAVAILABLE');
    expect(res.body).not.toContain('ECONNREFUSED');
  });

  it('every request gets its own UUID as request id, and the body repeats it', async () => {
    const { app } = toy();
    const ids = new Set<string>();
    for (let i = 0; i < 5; i++) ids.add(expectS8(await app.inject({ method: 'GET', url: '/toy/busy/queue_full' }), 'JV_BUSY').request_id);
    expect(ids.size).toBe(5);
  });

  it('a domain error and a refused input go out in the same body with their own status and details', async () => {
    const { app } = toy();
    const a = await app.inject({ method: 'GET', url: '/toy/domain' });
    expect([a.statusCode, JSON.parse(a.body).error]).toEqual([409, { code: 'JV_OVERPAYMENT', message: 'The payment is more than is pending.', details: { pending: '10.00' } }]);
    const b = await app.inject({ method: 'GET', url: '/toy/invalid' });
    expect([b.statusCode, JSON.parse(b.body).error.details]).toEqual([422, { field: 'amount' }]);
  });

  it('JV_INTERNAL: 500, nothing about SQL or tables in the body, and the detail in the log with the request id', async () => {
    const { app, sink } = toy();
    const res = await app.inject({ method: 'GET', url: '/toy/internal' });
    expect(res.statusCode).toBe(500);
    const body = expectS8(res, 'JV_INTERNAL');
    expect(res.body).not.toMatch(/secret_table|SELECT|jewel/);
    const logged = sink.lines().filter((l) => l.level === 50 && l.request_id === body.request_id);
    expect(logged).toHaveLength(1);
    expect(JSON.stringify(logged[0])).toContain('secret_table'); // for the person who reads the log
  });

  it('4025 / 1264 from the database: JV_INVALID_INPUT, and the log line says it is a bug', async () => {
    const { app, sink } = toy();
    const res = await app.inject({ method: 'GET', url: '/toy/bug' });
    expect(res.statusCode).toBe(422);
    expectS8(res, 'JV_INVALID_INPUT');
    expect(sink.lines().some((l) => l.level === 50 && l.bug === true)).toBe(true);
  });

  it('while the app is closing (SIGTERM): a call already running finishes, its response says Connection: close, and the close is not held up by the keep-alive connection it came on', async () => {
    const { app } = toy();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    app.get('/toy/slow', async () => {
      await gate;
      return { done: true };
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = app.server.address() as { port: number };
    const agent = new http.Agent({ keepAlive: true }); // a client that would keep the connection open for good, as a proxy does
    try {
      const running = new Promise<{ status: number; connection: string | undefined; body: string }>((resolve, reject) => {
        http.get({ port, host: '127.0.0.1', path: '/toy/slow', agent }, (res) => {
          let body = '';
          res.on('data', (d) => (body += d));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, connection: res.headers.connection, body }));
        }).on('error', reject);
      });
      await new Promise((r) => setTimeout(r, 50));
      const closed = app.close();
      await new Promise((r) => setTimeout(r, 50));
      release();
      expect(await running).toEqual({ status: 200, connection: 'close', body: '{"done":true}' });
      const t0 = Date.now();
      await closed;
      expect(Date.now() - t0).toBeLessThan(1500);
    } finally {
      agent.destroy();
    }
  });

  it('a body that is not JSON is JV_INVALID_INPUT in the S8 body, not Fastify\'s own shape', async () => {
    const { app } = toy();
    const res = await app.inject({ method: 'POST', url: '/toy/body', headers: { 'content-type': 'application/json' }, payload: '{not json' });
    expect(res.statusCode).toBe(422);
    expectS8(res, 'JV_INVALID_INPUT');
  });
});
