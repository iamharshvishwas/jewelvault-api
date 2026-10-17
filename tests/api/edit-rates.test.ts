import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { timestampToWire } from '../../src/wire/format';
import { AFTER_MIDNIGHT_IN_INDIA, TODAY, TOMORROW, YESTERDAY, addRate, allRows, patchRate, postRate, rateBody } from './edit-13b-support';
import { type EditWorld, STAMP_DB, STAMP_WIRE, body, codeOf, dbRow, detailsOf, editWorld, snapshot } from './edit-support';
import { getPage, bodyOf } from './sync-support';

// API13b, the daily rates (D4, Y8, A4, D22, S6):
//   T-D05  the owner and a biller can add a rate, a biller only for today (yesterday's and tomorrow's are refused), the owner can correct today's rate, staff cannot, and a `confirmed_by` sent by a
//          client is refused.
// D4: the owner may add a rate for any date up to today and correct a row dated today (an audited update); a biller may add a rate dated today, once per material and purity (an API rule that
// compares `rate_date` with today's business date, S5: a CHECK cannot read the clock, S4). The unique key (rate_date, material, purity) stands behind "once". Today is the day of the API clock in
// Asia/Kolkata: the clock of the fixture reads 17 Oct 2026 15:30 there.

let w: EditWorld;
beforeAll(async () => {
  w = await editWorld('editrates');
}, 120_000);
afterAll(async () => {
  await w?.world.close();
});

const user = (caller: 'owner' | 'staff' | 'biller') => w.world.fixtures[caller].userId;
let n = 0;
/** A purity no other test used, so that the "once per material and purity" rule of one test never meets the row of another. */
const purity = () => `P${(n += 1)}`;
const countRates = async (): Promise<number> => {
  const [rows] = await w.world.sql.query<any[]>('SELECT COUNT(*) AS n FROM daily_rates');
  return Number(rows[0].n);
};

describe('T-D05 the owner and a biller can add a rate; the person who confirmed it is the session user (D4, D22)', () => {
  it('the owner adds today\'s rate: 201, the row the sync read would give, confirmed_by and the person columns are the owner, the stamps are readings of the API clock', async () => {
    const p = purity();
    const res = await postRate(w, 'owner', rateBody({ purity: p, rate_per_gram: '7050.50' }));
    expect(res.statusCode, res.body).toBe(201);
    const row = body(res).row;
    expect(row).toMatchObject({ material: 'Gold', purity: p, rate_per_gram: '7050.50', rate_date: TODAY, confirmed_by: user('owner'), created_by: user('owner'), updated_by: user('owner') });
    expect(row.created_at).toBe(row.updated_at);
    const stored = await dbRow(w, 'daily_rates', row.id);
    expect(w.time.readings.map((r) => r.timestamp)).toContain(stored.created_at);
    expect(stored.created_at).toBe(stored.updated_at);
    expect(stored.confirmed_by).toBe(user('owner'));
    // the answer is the row a screen would get by polling (C5 (a): the returned row replaces the pending one)
    const page = bodyOf(await getPage(w.world, 'owner', 'daily-rates'));
    expect(page.rows.find((r) => r.id === row.id)).toEqual(row);
  });

  it('a biller adds today\'s rate: 201, and confirmed_by is the biller', async () => {
    const p = purity();
    const res = await postRate(w, 'biller', rateBody({ purity: p, material: 'Silver', rate_per_gram: '96.00' }));
    expect(res.statusCode, res.body).toBe(201);
    expect(body(res).row).toMatchObject({ material: 'Silver', purity: p, rate_per_gram: '96.00', rate_date: TODAY, confirmed_by: user('biller'), created_by: user('biller') });
    expect((await dbRow(w, 'daily_rates', body(res).row.id)).confirmed_by).toBe(user('biller'));
  });

  it('staff cannot add a rate: 403 JV_FORBIDDEN, nothing stored', async () => {
    const before = await countRates();
    const res = await postRate(w, 'staff', rateBody({ purity: purity() }));
    expect(res.statusCode).toBe(403);
    expect(codeOf(res)).toBe('JV_FORBIDDEN');
    expect(await countRates()).toBe(before);
  });
});

describe('T-D05 a biller adds a rate for today only: yesterday\'s and tomorrow\'s are refused; the owner any date up to today (D4, Y8)', () => {
  it('a biller\'s rate dated yesterday is 422 on rate_date, and one dated tomorrow too; nothing is stored', async () => {
    const before = await countRates();
    for (const day of [YESTERDAY, TOMORROW, '2026-01-01', '2027-01-01']) {
      const res = await postRate(w, 'biller', rateBody({ purity: purity(), rate_date: day }));
      expect(res.statusCode, day).toBe(422);
      expect(codeOf(res)).toBe('JV_INVALID_INPUT');
      expect(detailsOf(res)).toEqual({ field: 'rate_date' });
    }
    expect(await countRates()).toBe(before);
  });

  it('the owner may add yesterday\'s rate and one from last year, but not tomorrow\'s', async () => {
    const p = purity();
    const yesterday = await postRate(w, 'owner', rateBody({ purity: p, rate_date: YESTERDAY }));
    expect(yesterday.statusCode, yesterday.body).toBe(201);
    expect(body(yesterday).row.rate_date).toBe(YESTERDAY);
    const old = await postRate(w, 'owner', rateBody({ purity: p, rate_date: '2025-04-01' }));
    expect(old.statusCode, old.body).toBe(201);
    const before = await countRates();
    const future = await postRate(w, 'owner', rateBody({ purity: p, rate_date: TOMORROW }));
    expect(future.statusCode).toBe(422);
    expect(detailsOf(future)).toEqual({ field: 'rate_date' });
    expect(await countRates()).toBe(before);
  });

  it('a date that is not a calendar date is 422 on rate_date for everyone', async () => {
    for (const day of ['2026-02-30', '17-10-2026', '', 'today', '2026-10-17T00:00:00Z']) {
      for (const caller of ['owner', 'biller'] as const) {
        const res = await postRate(w, caller, rateBody({ purity: purity(), rate_date: day }));
        expect(res.statusCode, `${caller} ${day}`).toBe(422);
        expect(detailsOf(res)).toEqual({ field: 'rate_date' });
      }
    }
  });
});

describe('T-D05 once per material and purity (D4): the unique key of the day stands behind the API\'s rule', () => {
  it('a second rate for the same day, material and purity is refused for a biller and for the owner; another purity or another material is fine', async () => {
    const p = purity();
    expect((await postRate(w, 'biller', rateBody({ purity: p }))).statusCode).toBe(201);
    const before = await countRates();
    for (const caller of ['biller', 'owner'] as const) {
      const again = await postRate(w, caller, rateBody({ purity: p, rate_per_gram: '9999.00' }));
      expect(again.statusCode, caller).toBe(422);
      expect(codeOf(again)).toBe('JV_INVALID_INPUT');
      expect(detailsOf(again)).toEqual({ field: 'rate_date' });
    }
    expect(await countRates()).toBe(before);
    expect((await postRate(w, 'biller', rateBody({ purity: purity() }))).statusCode).toBe(201);
    expect((await postRate(w, 'biller', rateBody({ purity: p, material: 'Silver' }))).statusCode).toBe(201);
  });

  it('the owner\'s second rate for an earlier day is refused the same way (an older row is corrected by nobody: only today\'s is)', async () => {
    const p = purity();
    expect((await postRate(w, 'owner', rateBody({ purity: p, rate_date: YESTERDAY }))).statusCode).toBe(201);
    const again = await postRate(w, 'owner', rateBody({ purity: p, rate_date: YESTERDAY }));
    expect(again.statusCode).toBe(422);
    expect(detailsOf(again)).toEqual({ field: 'rate_date' });
  });

  it('two billers adding the same rate at the same moment: one 201 and one 422, never a 500 (the unique key answers the one that lost)', async () => {
    const p = purity();
    const results = await Promise.all([postRate(w, 'biller', rateBody({ purity: p, rate_per_gram: '1.00' })), postRate(w, 'owner', rateBody({ purity: p, rate_per_gram: '2.00' }))]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([201, 422]);
    const [rows] = await w.world.sql.query<any[]>('SELECT COUNT(*) AS n FROM daily_rates WHERE purity = ?', [p]);
    expect(Number(rows[0].n)).toBe(1);
  });
});

describe('T-D05 what a rate is (D4): material Gold or Silver, a purity, a rate above 0 with two decimals, a date', () => {
  it.each([
    ['zero', '0.00'],
    ['zero without decimals', '0'],
    ['negative', '-5.00'],
    ['three decimals', '7050.001'],
    ['above the cap of 100,000,000', '100000000.01'],
    ['not a number', 'abc'],
    ['empty', ''],
  ])('rate_per_gram %s is 422 on rate_per_gram', async (_what, value) => {
    const before = await countRates();
    const res = await postRate(w, 'owner', rateBody({ purity: purity(), rate_per_gram: value }));
    expect(res.statusCode, res.body).toBe(422);
    expect(detailsOf(res)).toEqual({ field: 'rate_per_gram' });
    expect(await countRates()).toBe(before);
  });

  it('a money value crosses the wire as text: a JSON number is refused (S3), and the cap itself is accepted', async () => {
    const asNumber = await postRate(w, 'owner', { ...rateBody({ purity: purity() }), rate_per_gram: 7050 });
    expect(asNumber.statusCode).toBe(422);
    expect(detailsOf(asNumber)).toEqual({ field: 'rate_per_gram' });
    const max = await postRate(w, 'owner', rateBody({ purity: purity(), rate_per_gram: '100000000.00' }));
    expect(max.statusCode, max.body).toBe(201);
    expect(body(max).row.rate_per_gram).toBe('100000000.00');
  });

  it('a rate of 0.01 is accepted: "greater than 0" is the only floor', async () => {
    const res = await postRate(w, 'owner', rateBody({ purity: purity(), rate_per_gram: '0.01' }));
    expect(res.statusCode, res.body).toBe(201);
  });

  it('the material is Gold or Silver; the purity is text of 1 to 20 characters ("Custom" is fine, O27); each field is required', async () => {
    const before = await countRates();
    const material = await postRate(w, 'owner', rateBody({ purity: purity(), material: 'Platinum' }));
    expect([material.statusCode, detailsOf(material)]).toEqual([422, { field: 'material' }]);
    const empty = await postRate(w, 'owner', rateBody({ purity: '' }));
    expect([empty.statusCode, detailsOf(empty)]).toEqual([422, { field: 'purity' }]);
    const long = await postRate(w, 'owner', rateBody({ purity: 'x'.repeat(21) }));
    expect([long.statusCode, detailsOf(long)]).toEqual([422, { field: 'purity' }]);
    for (const field of ['material', 'purity', 'rate_per_gram', 'rate_date'] as const) {
      const { [field]: _left, ...rest } = rateBody({ purity: purity() });
      const missing = await postRate(w, 'owner', rest);
      expect([field, missing.statusCode, detailsOf(missing)]).toEqual([field, 422, { field }]);
    }
    expect(await countRates()).toBe(before);
    const custom = await postRate(w, 'biller', rateBody({ purity: 'Custom' }));
    expect(custom.statusCode, custom.body).toBe(201);
    expect(body(custom).row.purity).toBe('Custom');
  });

  it('the purity is trimmed ("  22K " is 22K), so a rate cannot hide behind a space', async () => {
    const p = purity();
    const res = await postRate(w, 'owner', rateBody({ purity: `  ${p} `, rate_date: '2024-02-02' }));
    expect(res.statusCode, res.body).toBe(201);
    expect(body(res).row.purity).toBe(p);
  });
});

describe('T-D05 a confirmed_by (or any person column or stamp) sent by a client is refused as an unknown field and never stored (S6, D22)', () => {
  const stray = ['confirmed_by', 'set_by', 'created_by', 'updated_by', 'created_at', 'updated_at'];
  const value = (f: string) => (f.endsWith('_by') ? randomUUID() : '2020-01-01T00:00:00.000000Z');

  it.each(['owner', 'biller'] as const)('POST by %s with one of them: 422 naming it, and no row is made', async (caller) => {
    const before = await countRates();
    for (const f of stray) {
      const res = await postRate(w, caller, { ...rateBody({ purity: purity() }), [f]: value(f) });
      expect(res.statusCode, f).toBe(422);
      expect(codeOf(res)).toBe('JV_INVALID_INPUT');
      expect(detailsOf(res)).toEqual({ field: f });
    }
    expect(await countRates()).toBe(before);
  });

  it('the id is the API\'s: an id in the body is a column that is on nobody\'s list (403), not a way to choose the key', async () => {
    const res = await postRate(w, 'owner', { ...rateBody({ purity: purity() }), id: randomUUID() });
    expect(res.statusCode).toBe(403);
    expect(codeOf(res)).toBe('JV_FORBIDDEN');
  });

  it('PATCH by the owner with one of them: 422, the row is untouched', async () => {
    const id = await addRate(w, { purity: purity() });
    const before = await snapshot(w, 'daily_rates', id);
    for (const f of stray) {
      const res = await patchRate(w, 'owner', id, STAMP_WIRE, { [f]: value(f) });
      expect(res.statusCode, f).toBe(422);
      expect(detailsOf(res)).toEqual({ field: `changes.${f}` });
    }
    const mixed = await patchRate(w, 'owner', id, STAMP_WIRE, { rate_per_gram: '1.00', confirmed_by: randomUUID() });
    expect(mixed.statusCode).toBe(422);
    expect(await snapshot(w, 'daily_rates', id)).toBe(before);
  });

  it('an unknown name is 422 as well', async () => {
    const res = await postRate(w, 'owner', { ...rateBody({ purity: purity() }), colour: 'gold' });
    expect([res.statusCode, detailsOf(res)]).toEqual([422, { field: 'colour' }]);
  });
});

describe('T-D05 the owner corrects today\'s rate; a biller and staff cannot; an older rate is corrected by nobody (D4)', () => {
  it('the owner changes today\'s rate (added by a biller): 200, the new rate, confirmed_by and updated_by are the owner, created_by stays the biller\'s, the stamp moves', async () => {
    const added = await postRate(w, 'biller', rateBody({ purity: purity(), rate_per_gram: '7000.00' }));
    const row = body(added).row;
    w.time.time.micros += 60_000_000n; // a minute later
    const res = await patchRate(w, 'owner', row.id, row.updated_at, { rate_per_gram: '7100.25' });
    expect(res.statusCode, res.body).toBe(200);
    const after = body(res).row;
    expect(after).toMatchObject({ id: row.id, rate_per_gram: '7100.25', rate_date: TODAY, material: 'Gold', confirmed_by: user('owner'), created_by: user('biller'), updated_by: user('owner') });
    expect(after.updated_at > row.updated_at).toBe(true);
    expect(after.created_at).toBe(row.created_at);
    const stored = await dbRow(w, 'daily_rates', row.id);
    expect(stored).toMatchObject({ rate_per_gram: '7100.25', confirmed_by: user('owner'), created_by: user('biller'), updated_by: user('owner') });
    expect(w.time.readings.map((r) => r.timestamp)).toContain(stored.updated_at);
    expect(timestampToWire(stored.updated_at)).toBe(after.updated_at);
  });

  it('a stale correction changes nothing and answers 409 JV_STALE with the current row', async () => {
    const id = await addRate(w, { purity: purity() });
    const first = await patchRate(w, 'owner', id, STAMP_WIRE, { rate_per_gram: '6900.00' });
    expect(first.statusCode, first.body).toBe(200);
    const before = await snapshot(w, 'daily_rates', id);
    const stale = await patchRate(w, 'owner', id, STAMP_WIRE, { rate_per_gram: '6800.00' });
    expect(stale.statusCode).toBe(409);
    expect(codeOf(stale)).toBe('JV_STALE');
    expect(detailsOf(stale).current).toEqual(body(first).row);
    expect(await snapshot(w, 'daily_rates', id)).toBe(before);
  });

  it('a rate dated yesterday (or any earlier day) is not corrected, not even by the owner: 409 JV_NOT_ALLOWED, nothing changes', async () => {
    const p = purity();
    for (const day of [YESTERDAY, '2026-09-01']) {
      const id = await addRate(w, { purity: p, rate_date: day });
      const before = await snapshot(w, 'daily_rates', id);
      const res = await patchRate(w, 'owner', id, STAMP_WIRE, { rate_per_gram: '1.00' });
      expect(res.statusCode, day).toBe(409);
      expect(codeOf(res)).toBe('JV_NOT_ALLOWED');
      expect(detailsOf(res)).toEqual({ field: 'changes.rate_per_gram' });
      expect(await snapshot(w, 'daily_rates', id)).toBe(before);
    }
  });

  it('a row dated in the future (typed by hand) is not corrected either: only today\'s is', async () => {
    const id = await addRate(w, { purity: purity(), rate_date: TOMORROW });
    const res = await patchRate(w, 'owner', id, STAMP_WIRE, { rate_per_gram: '1.00' });
    expect(res.statusCode).toBe(409);
    expect(codeOf(res)).toBe('JV_NOT_ALLOWED');
  });

  it('a biller cannot correct (not even a rate they added themselves) and staff cannot: 403 before the body is looked at', async () => {
    const added = await postRate(w, 'biller', rateBody({ purity: purity() }));
    const row = body(added).row;
    const before = await snapshot(w, 'daily_rates', row.id);
    for (const caller of ['biller', 'staff'] as const) {
      for (const payload of [{ expected_updated_at: row.updated_at, changes: { rate_per_gram: '1.00' } }, { nonsense: true }]) {
        const res = await w.world.call(caller, 'PATCH', `/v1/daily-rates/${row.id}`, { payload });
        expect(res.statusCode, caller).toBe(403);
        expect(codeOf(res)).toBe('JV_FORBIDDEN');
      }
    }
    expect(await snapshot(w, 'daily_rates', row.id)).toBe(before);
  });

  it('only the rate itself is corrected: the material, the purity and the date are real columns that are on nobody\'s list (403), so a correction cannot move a rate to another day', async () => {
    const id = await addRate(w, { purity: purity() });
    const before = await snapshot(w, 'daily_rates', id);
    for (const [field, value] of [['material', 'Silver'], ['purity', 'X'], ['rate_date', YESTERDAY], ['id', randomUUID()]] as const) {
      const res = await patchRate(w, 'owner', id, STAMP_WIRE, { [field]: value });
      expect(res.statusCode, field).toBe(403);
      expect(codeOf(res)).toBe('JV_FORBIDDEN');
      expect(detailsOf(res)).toEqual({ field: `changes.${field}` });
    }
    expect(await snapshot(w, 'daily_rates', id)).toBe(before);
  });

  it('the new rate is checked like a new one: above 0, two decimals, text', async () => {
    const id = await addRate(w, { purity: purity() });
    for (const value of ['0.00', '-1.00', '1.234', '100000000.01', 5000] as const) {
      const res = await patchRate(w, 'owner', id, STAMP_WIRE, { rate_per_gram: value });
      expect(res.statusCode, String(value)).toBe(422);
      expect(detailsOf(res)).toEqual({ field: 'changes.rate_per_gram' });
    }
  });

  it('the same rate again (written with one decimal) changes nothing: 200 with the row, no write, the stamp and confirmed_by stay', async () => {
    const id = await addRate(w, { purity: purity(), rate_per_gram: '6920.00' });
    const before = await snapshot(w, 'daily_rates', id);
    const res = await patchRate(w, 'owner', id, STAMP_WIRE, { rate_per_gram: '6920.0' });
    expect(res.statusCode, res.body).toBe(200);
    expect(await snapshot(w, 'daily_rates', id)).toBe(before);
    expect((await dbRow(w, 'daily_rates', id)).updated_at).toBe(STAMP_DB);
  });

  it('a row that does not exist is 404, and so is an id that is not an id', async () => {
    const missing = await patchRate(w, 'owner', randomUUID(), STAMP_WIRE, { rate_per_gram: '1.00' });
    expect(missing.statusCode).toBe(404);
    expect(codeOf(missing)).toBe('JV_NOT_FOUND');
    const nonsense = await patchRate(w, 'owner', 'not-an-id', STAMP_WIRE, { rate_per_gram: '1.00' });
    expect(nonsense.statusCode).toBe(404);
  });

  it('an empty change, a missing stamp and a stamp that is not the server\'s text are 422', async () => {
    const id = await addRate(w, { purity: purity() });
    expect((await patchRate(w, 'owner', id, STAMP_WIRE, {})).statusCode).toBe(422);
    expect((await w.world.call('owner', 'PATCH', `/v1/daily-rates/${id}`, { payload: { changes: { rate_per_gram: '1.00' } } })).statusCode).toBe(422);
    expect((await patchRate(w, 'owner', id, '2026-10-01 08:30:15', { rate_per_gram: '1.00' })).statusCode).toBe(422);
  });
});

describe('T-D05 "today" is the business day of the API clock in India, not the server\'s or the UTC day (S5, D4)', () => {
  // last in the file: the API clock never runs backwards, so this moves it forward and leaves it there
  it('at 00:30 on the 18th in India (still the 17th in UTC) a biller\'s rate for the 17th is refused and one for the 18th is accepted; the owner corrects the 18th\'s row and no longer the 17th\'s', async () => {
    const p = purity();
    const old = body(await postRate(w, 'biller', rateBody({ purity: p, rate_date: TODAY }))).row; // added on the 17th, 15:30
    w.time.time.micros = AFTER_MIDNIGHT_IN_INDIA;
    const refused = await postRate(w, 'biller', rateBody({ purity: purity(), rate_date: TODAY }));
    expect([refused.statusCode, detailsOf(refused)]).toEqual([422, { field: 'rate_date' }]);
    const future = await postRate(w, 'owner', rateBody({ purity: purity(), rate_date: '2026-10-19' }));
    expect(future.statusCode).toBe(422);
    const accepted = await postRate(w, 'biller', rateBody({ purity: p, rate_date: TOMORROW }));
    expect(accepted.statusCode, accepted.body).toBe(201);
    const corrected = await patchRate(w, 'owner', body(accepted).row.id, body(accepted).row.updated_at, { rate_per_gram: '5.00' });
    expect(corrected.statusCode, corrected.body).toBe(200);
    const tooLate = await patchRate(w, 'owner', old.id, old.updated_at, { rate_per_gram: '5.00' });
    expect([tooLate.statusCode, codeOf(tooLate)]).toEqual([409, 'JV_NOT_ALLOWED']);
  });
});
