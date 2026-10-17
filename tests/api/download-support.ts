import type { Connection } from 'mysql2/promise';
import { formatTimestamp } from '../../src/clock';
import type { World } from './cells';

// Shared by the tests of API35 (T-R05: Download everything and its record; T-R06: the weekly pull; B3, O53, O54, I12): the files of the zip as the spec lists them, and a way to put the rest of
// the owner's dashboard line in good health at any instant, so that a test sees the download or the pull alone.

/**
 * B3: the files of the zip, named by the table whose rows they hold: customers, bills, bill items, receipts, allocations, stock (designs and pieces), daily rates, categories (with their
 * subcategories) and settings, and the users' names and roles. Written from the spec and not read from the code under test.
 */
export const ZIP_FILES = ['customers', 'bills', 'bill_items', 'receipts', 'receipt_allocations', 'designs', 'skus', 'daily_rates', 'categories', 'subcategories', 'settings', 'users'] as const;
export type ZipFile = (typeof ZIP_FILES)[number];
export type Counts = Record<ZipFile, number>;

export const SECOND = 1_000_000n; // microseconds
export const MINUTE = 60n * SECOND;
export const HOUR = 60n * MINUTE;
export const DAY = 24n * HOUR;

/** The instant as the JSON of the settings keys writes it: '2026-10-17T10:00:00.000Z'. */
export const isoAt = (micros: bigint): string => new Date(Number(micros / 1000n)).toISOString();

/** What the database holds now: the number of rows of every file of the zip. */
export async function dbCounts(sql: Pick<Connection, 'query'>): Promise<Counts> {
  const counts = {} as Counts;
  for (const table of ZIP_FILES) counts[table] = Number((await sql.query<any[]>(`SELECT COUNT(*) AS n FROM \`${table}\``))[0][0].n);
  return counts;
}

/** Puts the creation time of every row of the zip's tables far back, so that no row counts as "made in the last two minutes" unless the test makes one. */
export async function ageEverything(sql: Pick<Connection, 'query'>): Promise<void> {
  for (const table of ZIP_FILES) await sql.query(`UPDATE \`${table}\` SET created_at = '2026-09-01 00:00:00.000000' WHERE created_at >= '2026-09-02 00:00:00.000000'`);
}

type Root = Awaited<ReturnType<World['scratch']['root']>>;

/**
 * Makes everything on the owner's line except the download and the pull good at `now`: a nightly check, a dump and a photo copy one hour old, a backup folder whose file count has not fallen.
 * `firstNightAt` adds an older check (the first night the system ran, B3) and `firstExportAt` an older good dump (the first export, O54); both are the oldest rows of their tables.
 * Clears the check and backup rows first (the ten-box user has no Delete right, so the root connection does it).
 */
export async function resetHealth(world: World, root: Root, now: bigint, o: { firstNightAt?: bigint; firstExportAt?: bigint } = {}): Promise<void> {
  const db = `\`${world.scratch.database}\``;
  await root.query(`DELETE FROM ${db}.check_runs`);
  await root.query(`DELETE FROM ${db}.backup_runs`);
  const check = (at: bigint) => world.sql.query('INSERT INTO check_runs (ran_at, ok, details) VALUES (?, 1, ?)', [formatTimestamp(at), JSON.stringify({ invariants: [] })]);
  const backup = (at: bigint, kind: string, files: number) =>
    world.sql.query('INSERT INTO backup_runs (ran_at, kind, ok, bytes, detail) VALUES (?, ?, 1, 1000, ?)', [formatTimestamp(at), kind, JSON.stringify({ folder: { files: 7, bytes: 7000 + files, free_bytes: 5_000_000 } })]);
  if (o.firstNightAt !== undefined) await check(o.firstNightAt);
  if (o.firstExportAt !== undefined) await backup(o.firstExportAt, 'db_dump', 1);
  await check(now - HOUR);
  await backup(now - HOUR, 'db_dump', 2);
  await backup(now - HOUR + MINUTE, 'photo_copy', 3);
}

/** Writes (or replaces) a settings key as the line reads it: {at}. Direct to the table, so the test chooses the instant. */
export async function putSetting(sql: Pick<Connection, 'query'>, key: 'last_download' | 'last_pulled', at: bigint): Promise<void> {
  await sql.query('INSERT INTO settings (setting_key, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value)', [key, JSON.stringify({ at: isoAt(at) })]);
}
export async function dropSetting(root: Root, world: World, key: 'last_download' | 'last_pulled'): Promise<void> {
  await root.query(`DELETE FROM \`${world.scratch.database}\`.settings WHERE setting_key = ?`, [key]);
}
