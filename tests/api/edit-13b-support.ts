import { randomUUID } from 'node:crypto';
import type { LightMyRequestResponse } from 'fastify';
import { V, insert } from '../schema/support';
import type { CallerName } from './cells';
import { type EditWorld, STAMP_DB, body } from './edit-support';

// Shared by the tests of API13b (the ordinary edits of daily rates, settings and customer content columns: D4, D3, A4, A5, D22, S6; T-D04, T-D05 and the clauses of T-D14, T-D02): fixtures that
// are typed in by hand (as the import or a later task will make them) and the calls of the three tables on top of the helpers of API13 (edit-support.ts).
//
// THE DAY. The clock of the fixture is 17 Oct 2026 10:00 UTC, which is 15:30 on 17 Oct in India (S5): today is 2026-10-17, yesterday 2026-10-16, tomorrow 2026-10-18.

export const TODAY = '2026-10-17';
export const YESTERDAY = '2026-10-16';
export const TOMORROW = '2026-10-18';
/** 17 Oct 2026 19:00 UTC: it is already 00:30 on 18 Oct in India. */
export const AFTER_MIDNIGHT_IN_INDIA = BigInt(Date.UTC(2026, 9, 17, 19, 0, 0)) * 1000n;

export type RateBody = {
  material: string;
  purity: string;
  rate_per_gram: string;
  rate_date: string;
};

/** A rate row typed in by hand, with the stamp of the fixture; `o` overrides any column. Returns the id. */
export async function addRate(w: EditWorld, o: Record<string, unknown> = {}): Promise<string> {
  const id = randomUUID();
  await insert(w.world.sql, 'daily_rates', V.dailyRate({ id, rate_date: TODAY, created_at: STAMP_DB, updated_at: STAMP_DB, ...o }));
  return id;
}

/** A customer typed in by hand (X6 is API19's), with the stamp of the fixture. */
export async function addCustomer(w: EditWorld, o: Record<string, unknown> = {}): Promise<string> {
  const id = randomUUID();
  await insert(w.world.sql, 'customers', V.customer({ id, name: 'Fixture Customer', created_at: STAMP_DB, updated_at: STAMP_DB, ...o }));
  return id;
}

export const rateBody = (o: Partial<RateBody> = {}): RateBody => ({ material: 'Gold', purity: '22K', rate_per_gram: '7050.00', rate_date: TODAY, ...o });

export const postRate = (w: EditWorld, caller: CallerName, payload: Record<string, unknown>): Promise<LightMyRequestResponse> => w.world.call(caller, 'POST', '/v1/daily-rates', { payload });
export const patchRate = (w: EditWorld, caller: CallerName, id: string, expected: string, changes: Record<string, unknown>): Promise<LightMyRequestResponse> =>
  w.world.call(caller, 'PATCH', `/v1/daily-rates/${id}`, { payload: { expected_updated_at: expected, changes } });
export const putSetting = (w: EditWorld, caller: CallerName, key: string, payload: Record<string, unknown>): Promise<LightMyRequestResponse> => w.world.call(caller, 'PUT', `/v1/settings/${key}`, { payload });
export const patchCustomer = (w: EditWorld, caller: CallerName, id: string, expected: string, changes: Record<string, unknown>): Promise<LightMyRequestResponse> =>
  w.world.call(caller, 'PATCH', `/v1/customers/${id}`, { payload: { expected_updated_at: expected, changes } });

/** The rows of a table as the database holds them, for "nothing was stored" comparisons. */
export async function allRows(w: EditWorld, table: string): Promise<string> {
  const [rows] = await w.world.sql.query<any[]>(`SELECT * FROM \`${table}\` ORDER BY 1`);
  return JSON.stringify(rows);
}

/** The setting row as the database holds it (the value parsed). */
export async function settingRow(w: EditWorld, key: string): Promise<Record<string, any> | undefined> {
  const [rows] = await w.world.sql.query<any[]>('SELECT * FROM settings WHERE setting_key = ?', [key]);
  if (rows.length === 0) return undefined;
  const row = rows[0];
  return { ...row, value: typeof row.value === 'string' ? JSON.parse(row.value) : row.value };
}

export { body };
