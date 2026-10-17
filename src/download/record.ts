// B3, O53, I12: the record of the owner's monthly "Download everything".
//
//   POST /v1/owner/download-record   {date, counts: {<file>: <rows>, ...}}   → { last_download: { at, by, counts } }
//
// The zip itself is built in the browser from the cache (WEB12b); when it is built, the screen sends the date and the number of rows of every file. The API accepts them only if every count equals
// the database's count of that table, give or take the rows made in the last two minutes (the cache is up to one poll behind), and then stores {at, by, counts} in the settings key
// `last_download`. The health line (readHealth, src/reads/health.ts) counts whole Asia/Kolkata days from its `at`: amber at 28, red at 36 (B3, O53). Counts that do not match are
// JV_INVALID_INPUT and nothing is written. An empty zip and a missing file are counts that do not match.
//
// `at` is the API's clock and `by` is the user who called, never what the screen says: the record is what lets the line go green, so the screen may not choose it (RF5-17). The generic settings
// edit never writes this key (A4; NEVER_WRITTEN_SETTINGS of the permission matrix); this call is the only way. It is one transaction and one write, so exactly one audit row: the trigger's (L1 (a))
// or, with JV_AUDIT_MODE=node, the one that API15's audit writer is to make at the place marked "L1 (b)" below. The route writes no `event` row of its own, which would be a second row for one change.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { formatTimestamp } from '../clock.js';
import { txContextFor, withTx } from '../db/tx.js';
import { unavailableError } from '../errors.js';
import { limits } from '../limits.js';
import { route } from '../permissions/route.js';
import * as wire from '../wire/zod.js';

/** B3: the files of the zip, named by the table whose rows each one holds. A record names every one of them, and no other. */
export const DOWNLOAD_FILES = ['customers', 'bills', 'bill_items', 'receipts', 'receipt_allocations', 'designs', 'skus', 'daily_rates', 'categories', 'subcategories', 'settings', 'users'] as const;
export type DownloadFile = (typeof DOWNLOAD_FILES)[number];

/**
 * Each table's row count and how many of its rows were made since the window began (`created_at >= ?`). One literal statement for each table: the table name is never joined into the text.
 * Parameter: the start of the window as DATETIME text.
 */
export const COUNT_STATEMENTS: Readonly<Record<DownloadFile, string>> = Object.freeze({
  customers: 'SELECT COUNT(*) AS n, COALESCE(SUM(created_at >= ?), 0) AS recent FROM customers',
  bills: 'SELECT COUNT(*) AS n, COALESCE(SUM(created_at >= ?), 0) AS recent FROM bills',
  bill_items: 'SELECT COUNT(*) AS n, COALESCE(SUM(created_at >= ?), 0) AS recent FROM bill_items',
  receipts: 'SELECT COUNT(*) AS n, COALESCE(SUM(created_at >= ?), 0) AS recent FROM receipts',
  receipt_allocations: 'SELECT COUNT(*) AS n, COALESCE(SUM(created_at >= ?), 0) AS recent FROM receipt_allocations',
  designs: 'SELECT COUNT(*) AS n, COALESCE(SUM(created_at >= ?), 0) AS recent FROM designs',
  skus: 'SELECT COUNT(*) AS n, COALESCE(SUM(created_at >= ?), 0) AS recent FROM skus',
  daily_rates: 'SELECT COUNT(*) AS n, COALESCE(SUM(created_at >= ?), 0) AS recent FROM daily_rates',
  categories: 'SELECT COUNT(*) AS n, COALESCE(SUM(created_at >= ?), 0) AS recent FROM categories',
  subcategories: 'SELECT COUNT(*) AS n, COALESCE(SUM(created_at >= ?), 0) AS recent FROM subcategories',
  settings: 'SELECT COUNT(*) AS n, COALESCE(SUM(created_at >= ?), 0) AS recent FROM settings',
  users: 'SELECT COUNT(*) AS n, COALESCE(SUM(created_at >= ?), 0) AS recent FROM users',
});

/** The settings key and its write: the only statement that writes `last_download`. The stamp is the API's clock (S6), like every other write of a row that the screens poll. */
export const RECORD_DOWNLOAD_SQL =
  "INSERT INTO settings (setting_key, value, updated_by, updated_at) VALUES ('last_download', ?, ?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value), updated_by = VALUES(updated_by), updated_at = VALUES(updated_at)";

const countMessage = `must be a whole number of rows from 0 to ${limits.downloadFileRows.toLocaleString('en-US')}`;
const rowCount = z
  .number({ error: (issue) => (issue.input === undefined ? 'is required' : countMessage) })
  .int(countMessage)
  .min(0, countMessage)
  .max(limits.downloadFileRows, countMessage);

export const recordBody = wire.strictObject({
  date: wire.businessDate,
  counts: wire.strictObject(Object.fromEntries(DOWNLOAD_FILES.map((file) => [file, rowCount])) as Record<DownloadFile, typeof rowCount>),
});

/** The calendar date before a YYYY-MM-DD date. */
const dayBefore = (date: string): string => new Date(Date.parse(`${date}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);

export function registerDownloadRoutes(app: FastifyInstance): void {
  route(app, {
    action: 'owner:download_record',
    body: recordBody,
    handler: async ({ app: a, request, auth, body }) => {
      if (!a.db) throw unavailableError();
      const reading = a.clock.read();
      // a zip built shortly before midnight may be recorded just after it, so yesterday's business date is as good as today's; an older zip is not the books of today
      if (body.date !== reading.date && body.date !== dayBefore(reading.date)) throw new wire.InvalidInputError('date', "must be today's date or yesterday's, in India");
      const windowStart = formatTimestamp(reading.micros - BigInt(limits.downloadAllowanceMs) * 1000n);
      const at = new Date(Number(reading.micros / 1000n)).toISOString();
      const record = { at, by: auth.user.id, counts: body.counts };
      await withTx(txContextFor(a.db, request, { id: auth.user.id, role: auth.user.role }), async (tx) => {
        for (const file of DOWNLOAD_FILES) {
          const [row] = await tx.rows<{ n: number | string; recent: number | string }>(COUNT_STATEMENTS[file], [windowStart]);
          // give or take the rows made in the last two minutes: the cache the zip was built from is up to one poll behind the database
          if (Math.abs(body.counts[file] - Number(row.n)) > Number(row.recent)) throw new wire.InvalidInputError(`counts.${file}`, 'does not match the books: update the screen and download again');
        }
        await tx.run(RECORD_DOWNLOAD_SQL, [JSON.stringify(record), auth.user.id, reading.timestamp]);
        // L1 (b): API15 writes the Node audit row here when JV_AUDIT_MODE=node: table settings, row 'last_download', an insert, or an update with the row as it was (read it with SELECT ... FOR UPDATE before the write); with the triggers (a) nothing is written here
      });
      return { last_download: record };
    },
  });
}
