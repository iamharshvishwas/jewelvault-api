import type { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app';
import { createClock } from '../../src/clock';
import { limits } from '../../src/limits';
import { WireFormatError, formatBusinessDate, formatMoney, formatMoneyFromPaise, formatRow, formatUuid, formatWeight, formatWeightFromMilligrams, timestampFromWire, timestampToWire } from '../../src/wire/format';
import * as wire from '../../src/wire/zod';
import { parseGrams, parseRupees } from '../../oracle/pricing';
import { logSink, testConfig, toyRoutes } from './support';

// T-A09 (generic part) and T-F09: the wire formats of S3, S4 and S5. The per-function inputs are tested by the tasks that build the functions.
// The oracle (a read-only snapshot of the screen's pricing.ts) is imported only to show what the loose parsers of the shared file accept.

/** Runs one value through the strict object { field: schema } and returns the refusal (or null when it is accepted). */
function refusal(schema: z.ZodType, value: unknown): wire.InvalidInputError | null {
  try {
    wire.parseInput(wire.strictObject({ field: schema }), { field: value });
    return null;
  } catch (e) {
    expect(e).toBeInstanceOf(wire.InvalidInputError);
    return e as wire.InvalidInputError;
  }
}
const accepted = (schema: z.ZodType, value: unknown) => refusal(schema, value) === null;

const decimalSchemas = { amount: wire.amount, rate: wire.rate, weight: wire.weight } as const;

describe('T-A09 generic input rejections (S3, S4): the Zod layer, before pricing.ts sees a value', () => {
  describe.each(Object.entries(decimalSchemas))('%s', (name, schema) => {
    it.each([7.5, 7, 0, 1e21, 12345678901234567890, 0.1 + 0.2, -1, 1.23])('a JSON number (%s) is JV_INVALID_INPUT, never a value', (n) => {
      const e = refusal(schema, n);
      expect(e).not.toBeNull();
      expect(e!.code).toBe('JV_INVALID_INPUT');
      expect(e!.status).toBe(422);
      expect(e!.field).toBe('field');
      expect(e!.message).toMatch(/text/);
    });

    it.each([
      '.5', '5.', ' 7.50 ', '7.50 ', ' 7.50', '+5', '-5', '-0', '1,5', '1e3', '0x10', '', ' ', '.', '5.5.5', '1 000', '5\n', '\n5', '5 ', '٥', '５', 'NaN', 'Infinity', '7.50\u0000',
    ])('the text %j is JV_INVALID_INPUT', (text) => {
      const e = refusal(schema, text);
      expect(e).not.toBeNull();
      expect(e!.code).toBe('JV_INVALID_INPUT');
    });

    it.each([null, undefined, true, {}, [], ['5']])('a %j is JV_INVALID_INPUT too', (v) => {
      expect(refusal(schema, v)).not.toBeNull();
    });

    it('accepts plain decimal text and gives it back unchanged (a trailing zero stays)', () => {
      for (const text of ['0', '7', '7.5', '7.50', '0.05', '99999.99', '001.5', '100']) {
        expect(wire.parseInput(wire.strictObject({ field: schema }), { field: text }), `${name} ${text}`).toEqual({ field: text });
      }
    });
  });

  it('NEGATIVE CONTROL: the loose parsers of the shared file accept .5, 5., " 7.50 " and numbers, which is why the layer exists (+5 they refuse already)', () => {
    expect(parseRupees('.5')).toBe(50);
    expect(parseRupees('5.')).toBe(500);
    expect(parseRupees(' 7.50 ')).toBe(750);
    expect(parseRupees(7.5)).toBe(750);
    expect(parseGrams('.5')).toBe(500);
    expect(() => parseRupees('+5')).toThrow();
    for (const schema of Object.values(decimalSchemas)) {
      for (const loose of ['.5', '5.', ' 7.50 ', 7.5]) expect(accepted(schema, loose), String(loose)).toBe(false);
    }
  });

  it('a trailing zero counts as a decimal: 1.230 is refused as a rate or an amount and accepted as a weight, 1.2300 is refused as a weight', () => {
    expect(refusal(wire.rate, '1.230')).not.toBeNull();
    expect(refusal(wire.amount, '1.230')).not.toBeNull();
    expect(refusal(wire.weight, '1.230')).toBeNull();
    expect(refusal(wire.weight, '1.2300')).not.toBeNull();
    expect(refusal(wire.amount, '1.2300')).not.toBeNull();
    expect(refusal(wire.rate, '1.20')).toBeNull();
    expect(refusal(wire.weight, '1.2345')).not.toBeNull();
    expect(refusal(wire.amount, '0.001')).not.toBeNull();
    expect(refusal(wire.weight, '0.0001')).not.toBeNull();
  });

  it('an over-cap value is JV_INVALID_INPUT from the parser (so a CHECK never fires): 1,000,000,000.01 as an amount', () => {
    const e = refusal(wire.amount, '1000000000.01');
    expect(e).not.toBeNull();
    expect(e!.code).toBe('JV_INVALID_INPUT');
    expect(e!.status).toBe(422);
    expect((e as unknown as { errno?: number }).errno).toBeUndefined(); // not a database error
    expect(e!.message).toMatch(/1000000000|1,000,000,000/);
  });

  it('the caps are exact at the edge: amount 1,000,000,000, rate 100,000,000, weight 100,000 g are accepted and one unit more is not', () => {
    expect(accepted(wire.amount, '1000000000')).toBe(true);
    expect(accepted(wire.amount, '1000000000.00')).toBe(true);
    expect(accepted(wire.amount, '999999999.99')).toBe(true);
    expect(accepted(wire.amount, '1000000000.01')).toBe(false);
    expect(accepted(wire.amount, '1000000001')).toBe(false);
    expect(accepted(wire.rate, '100000000.00')).toBe(true);
    expect(accepted(wire.rate, '100000000.01')).toBe(false);
    expect(accepted(wire.rate, '1000000000')).toBe(false); // the amount cap is not the rate cap
    expect(accepted(wire.weight, '100000.000')).toBe(true);
    expect(accepted(wire.weight, '100000.001')).toBe(false);
    expect(accepted(wire.weight, '100001')).toBe(false);
    expect(accepted(wire.weight, '1000000000')).toBe(false);
    expect(accepted(wire.amount, '0001000000000.00')).toBe(true); // leading zeros do not change the value
    expect(accepted(wire.amount, `${'9'.repeat(400)}.99`)).toBe(false);
    expect(accepted(wire.weight, '9'.repeat(100_000))).toBe(false);
  });

  it('a quantity is a JSON integer from 1 to 1,000', () => {
    for (const ok of [1, 2, 999, 1000]) expect(accepted(wire.quantity, ok), String(ok)).toBe(true);
    for (const bad of [0, -1, 1001, 1.5, 0.5, '3', '1', null, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) {
      const e = refusal(wire.quantity, bad);
      expect(e, String(bad)).not.toBeNull();
      expect(e!.code).toBe('JV_INVALID_INPUT');
    }
  });

  it('a bill has 1 to 200 lines', () => {
    const lines = wire.billLines(wire.strictObject({ n: wire.quantity }));
    const make = (count: number) => Array.from({ length: count }, () => ({ n: 1 }));
    expect(accepted(lines, make(1))).toBe(true);
    expect(accepted(lines, make(200))).toBe(true);
    expect(accepted(lines, make(0))).toBe(false);
    expect(accepted(lines, make(201))).toBe(false);
    expect(accepted(lines, 'not a list')).toBe(false);
  });

  it('unknown keys are refused, at any depth, also the key __proto__ that JSON.parse makes', () => {
    const schema = wire.strictObject({ amount: wire.amount, items: wire.billLines(wire.strictObject({ rate: wire.rate })) });
    expect(wire.parseInput(schema, { amount: '1.00', items: [{ rate: '2.00' }] })).toEqual({ amount: '1.00', items: [{ rate: '2.00' }] });
    const top = (() => { try { wire.parseInput(schema, { amount: '1.00', items: [{ rate: '2.00' }], role: 'owner' }); } catch (e) { return e as wire.InvalidInputError; } })();
    expect(top?.code).toBe('JV_INVALID_INPUT');
    expect(top?.field).toBe('role');
    const nested = (() => { try { wire.parseInput(schema, { amount: '1.00', items: [{ rate: '2.00' }, { rate: '2.00', extra: 1 }] }); } catch (e) { return e as wire.InvalidInputError; } })();
    expect(nested?.field).toBe('items[1].extra');
    const proto = (() => { try { wire.parseInput(schema, JSON.parse('{"amount":"1.00","items":[{"rate":"2.00"}],"__proto__":{"admin":true}}')); } catch (e) { return e as wire.InvalidInputError; } })();
    expect(proto?.code).toBe('JV_INVALID_INPUT');
    expect(({} as Record<string, unknown>).admin).toBeUndefined();
  });

  it('a body that is not an object is refused, and a missing field says it is required', () => {
    const schema = wire.strictObject({ amount: wire.amount });
    for (const body of [null, 'x', 5, [], undefined]) expect(() => wire.parseInput(schema, body)).toThrow(wire.InvalidInputError);
    try {
      wire.parseInput(schema, {});
      expect.unreachable();
    } catch (e) {
      expect((e as wire.InvalidInputError).field).toBe('amount');
      expect((e as wire.InvalidInputError).message).toMatch(/required/);
    }
  });

  it('names the field with its path (items[2].metal_rate), as details.field, and never repeats the value it refused', () => {
    const schema = wire.strictObject({ items: wire.billLines(wire.strictObject({ metal_rate: wire.rate, gross_weight: wire.weight })) });
    const secret = '4111 1111 1111 1111 pan ABCDE1234F';
    try {
      wire.parseInput(schema, { items: [{ metal_rate: '1', gross_weight: '1' }, { metal_rate: '1', gross_weight: '1' }, { metal_rate: secret, gross_weight: '1' }] });
      expect.unreachable();
    } catch (e) {
      const err = e as wire.InvalidInputError;
      expect(err.code).toBe('JV_INVALID_INPUT');
      expect(err.field).toBe('items[2].metal_rate');
      expect(err.details).toEqual({ field: 'items[2].metal_rate' });
      expect(err.message.startsWith('items[2].metal_rate ')).toBe(true);
      expect(err.message).not.toContain('4111');
      expect(err.message).not.toContain('ABCDE');
    }
    try {
      wire.parseInput(schema, { items: [{ metal_rate: 3.5, gross_weight: '1' }] });
      expect.unreachable();
    } catch (e) {
      expect((e as wire.InvalidInputError).message).not.toContain('3.5');
    }
  });

  it('the checks work on exact text: no float is used, so a 25-digit amount below the cap is read right and one above is not', () => {
    expect(wire.checkDecimalText('0000000000000000000000000.50', 2, limits.maxAmount)).toBeNull();
    expect(wire.checkDecimalText('1000000000.000', 3, limits.maxAmount)).toBeNull();
    expect(wire.checkDecimalText('1000000000.0001', 4, limits.maxAmount)).not.toBeNull();
    expect(wire.checkDecimalText('1000000000.01', 2, limits.maxAmount)).toMatch(/at most/);
    expect(wire.checkDecimalText('1.239', 2, limits.maxAmount)).toMatch(/at most 2 decimals/);
    expect(wire.checkDecimalText('.5', 2, limits.maxAmount)).toMatch(/plain/);
  });
});

describe('T-F09 wire formats (S3, S5, A5): strings in, strings out', () => {
  describe('money and weight leave as text with 2 and 3 decimals', () => {
    it('money has 2 decimals', () => {
      expect(formatMoney('257612')).toBe('257612.00');
      expect(formatMoney('257612.5')).toBe('257612.50');
      expect(formatMoney('257612.00')).toBe('257612.00');
      expect(formatMoney('0')).toBe('0.00');
      expect(formatMoney('12.5000')).toBe('12.50'); // a computed DECIMAL with spare zeros
      expect(formatMoney('-0.4')).toBe('-0.40'); // round_off and balances may be negative
      expect(formatMoney('-0.00')).toBe('0.00');
      expect(formatMoney('99999999999999999999.99')).toBe('99999999999999999999.99'); // no number is made on the way
    });
    it('weight has 3 decimals', () => {
      expect(formatWeight('35.42')).toBe('35.420');
      expect(formatWeight('12')).toBe('12.000');
      expect(formatWeight('1.2300')).toBe('1.230');
      expect(formatWeight('100000.000')).toBe('100000.000');
      expect(formatWeight('0.5')).toBe('0.500');
    });
    it('a value that would need rounding, a JS number or a malformed text is a bug (WireFormatError), never rounded', () => {
      for (const bad of ['1.239', '0.001', '', ' 1', '1e3', '.5', '5.', 'abc', '--1', '+1', 7.5 as unknown as string, null as unknown as string, undefined as unknown as string, 10n as unknown as string]) {
        expect(() => formatMoney(bad), String(bad)).toThrow(WireFormatError);
      }
      for (const bad of ['1.2345', '', 'x', 35.42 as unknown as string]) expect(() => formatWeight(bad), String(bad)).toThrow(WireFormatError);
    });
    it('whole units: paise and milligrams (integers) become text exactly', () => {
      expect(formatMoneyFromPaise(25761200)).toBe('257612.00');
      expect(formatMoneyFromPaise(5)).toBe('0.05');
      expect(formatMoneyFromPaise(0)).toBe('0.00');
      expect(formatMoneyFromPaise(-40)).toBe('-0.40');
      expect(formatMoneyFromPaise(100_000_000_000n)).toBe('1000000000.00');
      expect(formatMoneyFromPaise(9_007_199_254_740_993n)).toBe('90071992547409.93');
      expect(formatWeightFromMilligrams(35420)).toBe('35.420');
      expect(formatWeightFromMilligrams(7)).toBe('0.007');
      expect(formatWeightFromMilligrams(100_000_000n)).toBe('100000.000');
      for (const bad of [1.5, Number.NaN, 2 ** 53, Number.POSITIVE_INFINITY, '5' as unknown as number]) {
        expect(() => formatMoneyFromPaise(bad), String(bad)).toThrow(WireFormatError);
        expect(() => formatWeightFromMilligrams(bad), String(bad)).toThrow(WireFormatError);
      }
    });
    it('what the parser accepts, the formatter gives back with the column scale (the round trip of S3)', () => {
      for (const [text, scaled] of [['7', '7.00'], ['7.5', '7.50'], ['7.50', '7.50'], ['0.05', '0.05']] as const) {
        const parsed = wire.parseInput(wire.strictObject({ a: wire.amount }), { a: text });
        expect(formatMoney(parsed.a as string)).toBe(scaled);
      }
    });
  });

  describe('ids are lower-case UUID text', () => {
    it('lower-cases a UUID and refuses anything else', () => {
      expect(formatUuid('00000000-0000-4000-8000-000000000001')).toBe('00000000-0000-4000-8000-000000000001');
      expect(formatUuid('A1B2C3D4-0000-4000-8000-ABCDEFABCDEF')).toBe('a1b2c3d4-0000-4000-8000-abcdefabcdef');
      for (const bad of ['', 'not-a-uuid', '00000000000040008000000000000001', '{00000000-0000-4000-8000-000000000001}', ' 00000000-0000-4000-8000-000000000001', 5 as unknown as string]) {
        expect(() => formatUuid(bad), String(bad)).toThrow(WireFormatError);
      }
    });
    it('a request id must already be lower case (the screens send crypto.randomUUID())', () => {
      expect(accepted(wire.uuid, '00000000-0000-4000-8000-000000000001')).toBe(true);
      expect(accepted(wire.uuid, 'a1b2c3d4-0000-4000-8000-abcdefabcdef')).toBe(true);
      for (const bad of ['A1B2C3D4-0000-4000-8000-ABCDEFABCDEF', 'a1b2c3d4-0000-4000-8000-abcdefabcdeg', 'a1b2c3d400004000-8000-abcdefabcdef', ' a1b2c3d4-0000-4000-8000-abcdefabcdef', '', 7, null]) {
        expect(accepted(wire.uuid, bad), String(bad)).toBe(false);
      }
    });
  });

  describe('created_at and updated_at: UTC text with microseconds that the screen sends back unchanged', () => {
    it('the database text becomes ISO text with six digits and a Z, and back, exactly', () => {
      expect(timestampToWire('2026-10-15 09:41:12.123456')).toBe('2026-10-15T09:41:12.123456Z');
      expect(timestampFromWire('2026-10-15T09:41:12.123456Z')).toBe('2026-10-15 09:41:12.123456');
      expect(timestampToWire('2026-10-15 09:41:12.100000')).toBe('2026-10-15T09:41:12.100000Z'); // trailing zeros stay
      expect(timestampToWire('2026-10-15 09:41:12.1')).toBe('2026-10-15T09:41:12.100000Z'); // a shorter column is padded on the right
      expect(timestampToWire('2026-10-15 09:41:12')).toBe('2026-10-15T09:41:12.000000Z');
      expect(timestampToWire('2026-12-31 23:59:59.999999')).toBe('2026-12-31T23:59:59.999999Z');
    });
    it('the stale check of A5: text from the database, sent back by the screen, is the same database text', () => {
      for (const db of ['2026-10-15 09:41:12.123456', '2026-10-15 09:41:12.000001', '2026-10-15 09:41:12.000000', '2024-02-29 00:00:00.500000']) {
        const wireText = timestampToWire(db);
        expect(accepted(wire.timestamp, wireText)).toBe(true);
        expect(wire.parseInput(wire.strictObject({ t: wire.timestamp }), { t: wireText })).toEqual({ t: wireText }); // unchanged
        expect(timestampFromWire(wireText)).toBe(db);
      }
    });
    it('NEGATIVE CONTROL: a JavaScript Date cuts the microseconds, which is why the work is done on text', () => {
      const wireText = timestampToWire('2026-10-15 09:41:12.123456');
      expect(new Date(wireText).toISOString()).toBe('2026-10-15T09:41:12.123Z');
      expect(new Date(wireText).toISOString()).not.toBe(wireText);
    });
    it('only the exact form is accepted from the screen', () => {
      for (const bad of [
        '2026-10-15T09:41:12Z', '2026-10-15T09:41:12.123Z', '2026-10-15T09:41:12.1234567Z', '2026-10-15T09:41:12.123456', '2026-10-15T09:41:12.123456+05:30', '2026-10-15T09:41:12.123456z',
        '2026-10-15 09:41:12.123456', '2026-10-15T09:41:12.123456Z ', '2026-02-30T09:41:12.123456Z', '2026-13-01T09:41:12.123456Z', '2026-10-15T24:00:00.000000Z', '2026-10-15T09:60:00.000000Z', '2026-10-15T09:41:60.000000Z',
        '0000-10-15T09:41:12.123456Z', '', 1760521272123, null,
      ]) {
        expect(accepted(wire.timestamp, bad), String(bad)).toBe(false);
      }
      expect(() => timestampToWire('2026-10-15T09:41:12.123456Z')).toThrow(WireFormatError);
      expect(() => timestampToWire('garbage')).toThrow(WireFormatError);
      expect(() => timestampFromWire('2026-10-15 09:41:12.123456')).toThrow(WireFormatError);
    });
    it('a thousand readings of a clock fixed at one instant give a thousand different, ordered texts, each of which comes back unchanged', () => {
      const clock = createClock(() => BigInt(Date.parse('2026-10-17T10:00:00.000Z')) * 1000n);
      const texts: string[] = [];
      for (let i = 0; i < 1000; i++) texts.push(timestampToWire(clock.read().timestamp));
      for (let i = 1; i < texts.length; i++) expect(texts[i] > texts[i - 1], `${texts[i - 1]} < ${texts[i]}`).toBe(true);
      expect(new Set(texts).size).toBe(1000);
      expect(texts[0]).toBe('2026-10-17T10:00:00.000000Z');
      expect(texts[999]).toBe('2026-10-17T10:00:00.000999Z');
      for (const t of texts) expect(timestampToWire(timestampFromWire(t))).toBe(t);
    });
  });

  describe('a business date is YYYY-MM-DD in Asia/Kolkata', () => {
    it('the date of a clock reading is a business date, and a response gives it as text', () => {
      const r = createClock(() => BigInt(Date.parse('2026-12-31T18:40:00.000Z')) * 1000n).read();
      expect(r.date).toBe('2027-01-01'); // 00:10 on 1 January in Kolkata (T-B16)
      expect(formatBusinessDate(r.date)).toBe('2027-01-01');
      expect(formatBusinessDate('2024-02-29')).toBe('2024-02-29');
    });
    it('the response formatter refuses what is not a plain date (a Date object or a timestamp would shift the day)', () => {
      for (const bad of [new Date('2026-10-15T00:00:00Z') as unknown as string, '2026-10-15T00:00:00.000Z', '2026-10-15 00:00:00', '15-10-2026', '2026-2-3', '2026-02-30', '', null as unknown as string]) {
        expect(() => formatBusinessDate(bad), String(bad)).toThrow(WireFormatError);
      }
    });
    it('a request date must be a real calendar date written YYYY-MM-DD', () => {
      for (const ok of ['2026-10-15', '2024-02-29', '1000-01-01', '9999-12-31']) expect(accepted(wire.businessDate, ok), ok).toBe(true);
      for (const bad of ['2026-02-29', '2026-13-01', '2026-00-10', '2026-10-32', '2026-1-5', '26-10-15', '2026-10-15 ', ' 2026-10-15', '2026/10/15', '2026-10-15T00:00:00Z', '0999-12-31', '', 20261015, null]) {
        expect(accepted(wire.businessDate, bad), String(bad)).toBe(false);
      }
    });
  });

  describe('formatRow: a database row becomes a response row', () => {
    const kinds = { id: 'uuid', bill_date: 'date', grand_total: 'money', round_off: 'money', gross_weight: 'weight', created_at: 'timestamp', updated_at: 'timestamp' } as const;
    const row = {
      id: 'A1B2C3D4-0000-4000-8000-ABCDEFABCDEF', bill_date: '2026-10-15', grand_total: '257612', round_off: '-0.4', gross_weight: '35.42', quantity: 3,
      created_at: '2026-10-15 09:41:12.123456', updated_at: '2026-10-15 09:41:12.5', note: null, void_reason: null, fine: null as string | null,
    };
    it('gives money 2 decimals, weight 3, ids in lower case, timestamps as UTC text, and leaves the other columns alone', () => {
      expect(formatRow(row, kinds)).toEqual({
        id: 'a1b2c3d4-0000-4000-8000-abcdefabcdef', bill_date: '2026-10-15', grand_total: '257612.00', round_off: '-0.40', gross_weight: '35.420', quantity: 3,
        created_at: '2026-10-15T09:41:12.123456Z', updated_at: '2026-10-15T09:41:12.500000Z', note: null, void_reason: null, fine: null,
      });
    });
    it('a null stays null, a column that is not in the list is copied, and the input row is not changed', () => {
      const before = JSON.stringify(row);
      const out = formatRow({ ...row, grand_total: null }, kinds);
      expect(out.grand_total).toBeNull();
      expect(JSON.stringify(row)).toBe(before);
    });
    it('a JS number in a money or weight column is refused (a driver set to numbers would lose the trailing zero)', () => {
      expect(() => formatRow({ ...row, grand_total: 257612 }, kinds)).toThrow(WireFormatError);
      expect(() => formatRow({ ...row, gross_weight: 35.42 }, kinds)).toThrow(WireFormatError);
    });
    it('names the column that could not be formatted', () => {
      expect(() => formatRow({ ...row, grand_total: '1.234' }, kinds)).toThrow(/grand_total/);
    });
  });

  describe('over HTTP (a toy route that parses the body and answers with formatted text)', () => {
    const bodySchema = wire.strictObject({ amount: wire.amount, weight: wire.weight });
    function toyApp() {
      const app = buildApp({ config: testConfig(), logStream: logSink().stream });
      toyRoutes(app).post('/toy', async (request, reply) => {
        try {
          const body = wire.parseInput(bodySchema, request.body);
          return { amount: formatMoney(body.amount as string), weight: formatWeight(body.weight as string) };
        } catch (e) {
          if (e instanceof wire.InvalidInputError) return reply.code(e.status).send({ error: { code: e.code, message: e.message, details: e.details }, request_id: request.id });
          throw e;
        }
      });
      return app;
    }
    const post = async (payload: string) => {
      const app = toyApp();
      try {
        return await app.inject({ method: 'POST', url: '/toy', headers: { 'content-type': 'application/json' }, payload });
      } finally {
        await app.close();
      }
    };

    it('strings in, strings out: 7.5 and 12.5 as text come back with 2 and 3 decimals', async () => {
      const res = await post('{"amount":"7.5","weight":"12.5"}');
      expect(res.statusCode).toBe(200);
      expect(res.body).toBe('{"amount":"7.50","weight":"12.500"}');
    });
    it('a JSON number in a money field is 422 JV_INVALID_INPUT (it arrives as 7.5, the trailing zero is already lost)', async () => {
      const res = await post('{"amount":7.50,"weight":"1.000"}');
      expect(res.statusCode).toBe(422);
      expect(res.json().error.code).toBe('JV_INVALID_INPUT');
      expect(res.json().error.details).toEqual({ field: 'amount' });
      expect(typeof res.json().request_id).toBe('string');
    });
    it('a JSON number above 2^53 in a weight field is 422 too, and an unknown key is 422', async () => {
      const big = await post('{"amount":"1.00","weight":12345678901234567890}');
      expect(big.statusCode).toBe(422);
      expect(big.json().error.details).toEqual({ field: 'weight' });
      const extra = await post('{"amount":"1.00","weight":"1.000","discount":"5"}');
      expect(extra.statusCode).toBe(422);
      expect(extra.json().error.details).toEqual({ field: 'discount' });
    });
    it('an over-cap amount is 422 from the parser, not a database error (this app has no database at all)', async () => {
      const res = await post('{"amount":"1000000000.01","weight":"1.000"}');
      expect(res.statusCode).toBe(422);
      expect(res.json().error.code).toBe('JV_INVALID_INPUT');
    });
  });
});
