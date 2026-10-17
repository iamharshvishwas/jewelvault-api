// D4, Y8, A4, D22: the daily rates (POST /v1/daily-rates, PATCH /v1/daily-rates/:id). The columns are the matrix's (WRITE_COLUMNS: the owner and a biller insert `material`, `purity`, `rate_per_gram` and
// `rate_date`; the owner alone updates `rate_per_gram`); the rules that are code and not columns are here:
//   - a rate is added for a date up to today; a date in the future is refused for everyone, and a date before today only for a caller who may back-date (Y8, `mayUseField(role, 'back_dates')`: the
//     owner). "Today" is the business day of the API clock in Asia/Kolkata (S5), the same reading that stamps the row: a CHECK cannot read the clock (S4).
//   - one rate for each date, material and purity (the unique key of D4 stands behind this check for two calls at the same moment): that is also "once per material and purity" for a biller, who can
//     only add today's and cannot correct it.
//   - only a rate dated today is corrected, and only its `rate_per_gram`: the date, the material and the purity never change, so a correction cannot move a rate to another day.
//   - `confirmed_by` is the session user on every insert and every correction (D22: the person who confirmed the figure); no request may name it (it is an unknown field, S6).
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { mayUseField } from '../permissions/matrix.js';
import type { Auth } from '../permissions/route.js';
import { type EditTable, type InsertRule, type UpdateBody, type UpdateRule, insertRecord, invalid, notAllowed, updateRecord } from './engine.js';
import * as f from './fields.js';

export const DAILY_RATES: EditTable = {
  table: 'daily_rates',
  insert: 'edit:daily_rates.insert',
  update: 'edit:daily_rates.update',
  person: ['confirmed_by'],
  fields: {
    material: f.oneOf(['Gold', 'Silver']),
    purity: f.requiredText(20),
    rate_per_gram: f.positiveRate,
    rate_date: f.businessDate,
  },
};

const rateInsertRules: InsertRule = async (tx, values, { role, now }) => {
  const date = values.rate_date as string;
  const today = now().date;
  if (date > today) throw invalid('rate_date', 'must not be in the future');
  if (date < today && !mayUseField(role, 'back_dates')) throw invalid('rate_date', 'must be today');
  const taken = await tx.rows('SELECT id FROM daily_rates WHERE rate_date = ? AND material = ? AND purity = ?', [date, values.material as string, values.purity as string]);
  if (taken.length > 0) throw invalid('rate_date', 'already has a rate for this material and purity');
};

const rateUpdateRules: UpdateRule = async ({ current, diff, now }) => {
  if (!('rate_per_gram' in diff)) return; // nothing to change: nothing to refuse
  if (String(current.rate_date) !== now().date) throw notAllowed('changes.rate_per_gram', 'Only a rate dated today can be corrected.');
};

export const addRate = (app: FastifyInstance, request: FastifyRequest, auth: Auth, body: Record<string, unknown>) => insertRecord(app, request, auth, DAILY_RATES, body, rateInsertRules);
export const editRate = (app: FastifyInstance, request: FastifyRequest, auth: Auth, id: string, body: UpdateBody) => updateRecord(app, request, auth, DAILY_RATES, id, body, rateUpdateRules);
