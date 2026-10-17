import type { LightMyRequestResponse } from 'fastify';
import { migrate } from '../../scripts/migrate.mjs';
import { MATRIX } from '../../src/permissions/matrix';
import { V, insert, ledgerWorld } from '../schema/support';
import { type CallerName, type World, type WorldOptions, makeWorld } from './cells';

// Shared by the tests of API11 (the read side, C3 and C4): a world with the application's real routes on a scratch database that holds the migrations, the seeds (the walk-in customer, the
// ten settings, the 15 categories) and one fixed set of business rows (tests/schema/support.ts ledgerWorld: two customers, four bills one of them cancelled, nine receipts one of them voided,
// released and live allocations), plus an owner-only original weight whose value appears nowhere else.

/** The owner-only weight of the first piece. No other value in the fixture is spelled like it, so a search of a response for it cannot hit by accident (D9, T-D03). */
export const ORIGINAL_WEIGHT = '7.131';

/** The sync resources as the matrix names them: the address segment, the action, the READ_COLUMNS table. Read from the matrix, not typed again, so a resource added there is walked at once. */
export const SYNC_ROWS = Object.entries(MATRIX)
  .filter(([, r]) => r.kind === 'read' && r.method === 'GET' && r.path.startsWith('/v1/sync/'))
  .map(([action, r]) => ({ action, name: r.path.slice('/v1/sync/'.length), table: (r as { reads: readonly string[] }).reads[0], roles: r.roles as readonly string[] }));

export type Fixture = Awaited<ReturnType<typeof ledgerWorld>> & { skuPrivateFor: string };

export async function syncWorld(label: string, options: WorldOptions = {}): Promise<{ world: World; data: Fixture }> {
  const world = await makeWorld({ label, routes: true, ...options });
  await migrate(world.sql, { seeds: true, optional: false });
  const data = await ledgerWorld(world.sql);
  await insert(world.sql, 'sku_private', V.skuPrivate(data.skus[0], { original_net_weight: ORIGINAL_WEIGHT }));
  await insert(world.sql, 'daily_rates', V.dailyRate());
  return { world, data: { ...data, skuPrivateFor: data.skus[0] } };
}

export const query = (q: Record<string, string | number | undefined> = {}) => {
  const entries = Object.entries(q).filter(([, v]) => v !== undefined);
  return entries.length === 0 ? '' : `?${entries.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join('&')}`;
};

export const getPage = (w: World, caller: CallerName, resource: string, q: Record<string, string | number | undefined> = {}) => w.call(caller, 'GET', `/v1/sync/${resource}${query(q)}`);
export const poll = (w: World, caller: CallerName, payload: unknown) => w.call(caller, 'POST', '/v1/sync/poll', { payload });

export interface Next {
  updated_at: string;
  key: string;
}
export interface PageBody {
  rows: Record<string, unknown>[];
  next: Next | null;
  server_time: string;
}

export const bodyOf = <T = PageBody>(res: LightMyRequestResponse): T => JSON.parse(res.body) as T;

/** What the screen does to hydrate: ask from the beginning and call again with `next` until it is null. Returns every row received, in the order received, and the pages. */
export async function pageAll(w: World, caller: CallerName, resource: string, q: { limit?: number } = {}): Promise<{ rows: Record<string, unknown>[]; pages: PageBody[] }> {
  const pages: PageBody[] = [];
  const rows: Record<string, unknown>[] = [];
  let next: Next | null = null;
  for (let guard = 0; guard < 100_000; guard++) {
    const res: LightMyRequestResponse = await getPage(w, caller, resource, { limit: q.limit, updated_after: next?.updated_at, after_key: next?.key });
    if (res.statusCode !== 200) throw new Error(`GET ${resource}: ${res.statusCode} ${res.body.slice(0, 200)}`);
    const page = bodyOf(res);
    pages.push(page);
    rows.push(...page.rows);
    if (page.next === null) return { rows, pages };
    next = page.next;
  }
  throw new Error('paging did not end');
}

/** 'YYYY-MM-DDTHH:MM:SS.ffffffZ' minus whole seconds, by string work on microseconds (what the screen does with the 30-second overlap). */
export function minusSeconds(wire: string, seconds: number): string {
  const m = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)\.(\d{6})Z$/.exec(wire);
  if (!m) throw new Error(`not wire time: ${wire}`);
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])) - seconds * 1000;
  return `${new Date(ms).toISOString().slice(0, 19)}.${m[7]}Z`;
}

/** The same instant as the database writes it: 'YYYY-MM-DD HH:MM:SS.ffffff'. */
export const dbTime = (wire: string) => wire.replace('T', ' ').replace('Z', '');
