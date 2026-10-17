// A9, C3: the reads that are not sync resources.
//
//   GET /v1/customers/:id/ledger?after=&limit=       V3 for one customer, keyset-paged by the order key   → { rows, next: { after } | null }
//   GET /v1/daily-totals?from=&to=                   V4 for a range of days                              → { rows }
//   GET /v1/audit-log?before_id=&table=&row_id=&limit=   the audit log, newest first, 200 a page        → { rows, next: { before_id } | null }
//   GET /v1/health/checks?limit=                     the newest check_runs and backup_runs               → { check_runs, backup_runs }
//   GET /v1/dashboard/health                         the dashboard line of section 12, in one call       → readHealth (src/reads/health.ts)
//
// bill_summary and customer_balances, the other two derived reads, are sync resources (src/sync/): their pages are cut from the base table, so their updated_at is the base row's (C4, D23).
//
// Reading is wide and writing is narrow (A9): a role that may read a resource reads every row of it, so a biller reads every customer's ledger; the narrowing is the matrix row (who may call), the
// field lists (READ_COLUMNS) and, for the cash book, the window of days (dailyTotalsWindowDays). No handler here holds a role string (S10); the wrapper has already looked the caller up and checked
// the row (route.ts) when a handler runs. Every input is checked before the database is asked, and an unknown key is 422. The answers carry no value the client sent: ids, dates and tokens are
// parsed first and bound as parameters.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { txContextFor, withRead } from '../db/tx.js';
import { BusyError, JvError, classifyError, isConnectionLost } from '../errors.js';
import { limits } from '../limits.js';
import { route } from '../permissions/route.js';
import * as wire from '../wire/zod.js';
import { readAuditLog, auditQuery } from './auditLog.js';
import { checkRange, readDailyTotals } from './dailyTotals.js';
import { checksQuery, readHealth, readHealthLists, wireHealth } from './health.js';
import { decodeCursor, readLedger } from './ledger.js';

const unavailable = () => new JvError('JV_UNAVAILABLE', 'The service is not available. Try again in a moment.');

const limitMessage = `must be a whole number from 1 to ${limits.syncPageRows.toLocaleString('en-US')}`;
const ledgerQuery = wire.strictObject({
  after: z.string({ error: 'must be the token the server sent' }).optional(),
  limit: z.string({ error: limitMessage }).regex(/^[1-9][0-9]{0,3}$/, limitMessage).optional(),
});
const totalsQuery = wire.strictObject({ from: wire.businessDate, to: wire.businessDate });
const noQuery = wire.strictObject({});

export function registerReadRoutes(app: FastifyInstance): void {
  const contextOf = (a: FastifyInstance, request: FastifyRequest, user: { id: string; role: string }) => {
    if (!a.db) throw unavailable();
    return txContextFor(a.db, request, { id: user.id, role: user.role });
  };

  route(app, {
    action: 'read:customer_ledger',
    handler: async ({ app: a, request, auth }) => {
      const { id } = wire.parseInput(wire.strictObject({ id: wire.uuid }), request.params);
      const q = wire.parseInput(ledgerQuery, request.query);
      const limit = q.limit === undefined ? limits.syncPageRows : Number(q.limit);
      if (limit > limits.syncPageRows) throw new wire.InvalidInputError('limit', limitMessage); // the constant is the contract: asking for more is refused, not cut
      const after = q.after === undefined ? null : decodeCursor(q.after);
      return withRead(contextOf(a, request, auth.user), (db) => readLedger(db, auth.user.role, id, { after, limit }));
    },
  });

  route(app, {
    action: 'read:daily_totals',
    handler: async ({ app: a, request, auth }) => {
      const q = wire.parseInput(totalsQuery, request.query);
      checkRange(auth.user.role, q.from, q.to, a.clock.read().date); // before the cash book is read
      return withRead(contextOf(a, request, auth.user), (db) => readDailyTotals(db, auth.user.role, q.from, q.to));
    },
  });

  route(app, {
    action: 'read:audit_log',
    handler: async ({ app: a, request, auth }) => {
      const q = wire.parseInput(auditQuery, request.query);
      return withRead(contextOf(a, request, auth.user), (db) => readAuditLog(db, auth.user.role, q));
    },
  });

  route(app, {
    action: 'read:health_checks',
    handler: async ({ app: a, request, auth }) => {
      const q = wire.parseInput(checksQuery, request.query);
      return withRead(contextOf(a, request, auth.user), (db) => readHealthLists(db, auth.user.role, q));
    },
  });

  route(app, {
    action: 'read:dashboard_health',
    handler: async ({ app: a, request, auth }) => {
      wire.parseInput(noQuery, request.query);
      const ctx = contextOf(a, request, auth.user);
      // readHealth sends SHOW GRANTS and ANALYZE TABLE as well as selects, which a Reader may not: it takes a checked-out connection of its own, under the same deadline as every read (S12)
      if (ctx.now() - ctx.arrivedAt > ctx.deadlineMs) throw new BusyError('deadline');
      const conn = await ctx.pool.checkout();
      let broken = false;
      try {
        return wireHealth(await readHealth(conn, { now: a.clock.read().timestamp }));
      } catch (e) {
        broken = isConnectionLost(e);
        throw classifyError(e);
      } finally {
        if (broken) conn.destroy();
        else conn.release();
      }
    },
  });
}
