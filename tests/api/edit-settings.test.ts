import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { allRows, putSetting, settingRow } from './edit-13b-support';
import { type EditWorld, STAMP_DB, body, codeOf, detailsOf, editWorld } from './edit-support';
import { bodyOf, getPage } from './sync-support';

// API13b, the settings (D3, A4, B3, O54, D22, S6):
//   T-D05  only the owner writes settings (and users: tests/api/edit-roles.test.ts); the generic edit never writes `last_download` or `last_pulled`.
// PUT /v1/settings/:key with the fields themselves, `{ value }` (the matrix row has the shape `fields`: no `expected_updated_at`, the last write wins; the owner is the only writer and the row is
// locked for the length of the write). A key that is not there yet is made (A4 `I`), one that is there is updated (A4 `U`); both are audited (T-D14, tests/api/edit-13b-audit.test.ts). The value is a
// JSON object or list; the three keys that other code reads (`estimate`, `numbering` and the shape of the others) are checked here so that a bad value can never reach X1, X7 or X8 (a bill prefix
// outside BILL_PREFIX_PATTERN is a TypeError there, a `roundOff` that is not true or false is JV_INTERNAL).

let w: EditWorld;
beforeAll(async () => {
  w = await editWorld('editsettings');
}, 120_000);
afterAll(async () => {
  await w?.world.close();
});

const owner = () => w.world.fixtures.owner.userId;
const ESTIMATE = { prefix: 'JV', roundOff: true, footerNote: 'This is an estimate only.' };

describe('T-D05 only the owner writes settings: a biller and staff are 403 and the value stays (A4)', () => {
  it('the owner replaces a setting: 200 and the row the sync read gives; updated_by is the owner, created_by stays, the stamp is a reading of the API clock', async () => {
    const value = { designPadding: 6, skuPadding: 4, barcodePrefix: 'JG' };
    const res = await putSetting(w, 'owner', 'numbering', { value });
    expect(res.statusCode, res.body).toBe(200);
    const row = body(res).row;
    expect(row).toMatchObject({ setting_key: 'numbering', value, created_by: null, updated_by: owner() });
    const stored = await settingRow(w, 'numbering');
    expect(stored).toMatchObject({ value, updated_by: owner(), created_by: null });
    expect(w.time.readings.map((r) => r.timestamp)).toContain(stored?.updated_at);
    const page = bodyOf(await getPage(w.world, 'owner', 'settings'));
    expect(page.rows.find((r) => r.setting_key === 'numbering')).toEqual(row);
  });

  it('a biller and staff are 403 JV_FORBIDDEN, before the body is looked at; nothing changes', async () => {
    const before = await allRows(w, 'settings');
    for (const caller of ['biller', 'staff'] as const) {
      for (const payload of [{ value: { designPadding: 9, skuPadding: 9, barcodePrefix: 'XX' } }, { nonsense: true }, {}]) {
        const res = await putSetting(w, caller, 'numbering', payload);
        expect(res.statusCode, caller).toBe(403);
        expect(codeOf(res)).toBe('JV_FORBIDDEN');
      }
      const created = await putSetting(w, caller, 'a_new_key', { value: { a: 1 } });
      expect(created.statusCode, caller).toBe(403);
    }
    expect(await allRows(w, 'settings')).toBe(before);
    expect(await settingRow(w, 'a_new_key')).toBeUndefined();
  });

  it('every other method is no route: a settings key cannot be PATCHed, POSTed or DELETEd (A11, S7)', async () => {
    for (const method of ['PATCH', 'POST', 'DELETE'] as const) {
      const res = await w.world.call('owner', method, '/v1/settings/numbering', { payload: method === 'DELETE' ? undefined : { value: {} } });
      expect(res.statusCode, method).toBe(404);
    }
  });
});

describe('T-D05 the generic edit never writes last_download or last_pulled (A4, B3, O54)', () => {
  it.each(['last_download', 'last_pulled'])('the owner\'s PUT of %s is 403 JV_FORBIDDEN naming the key; the row is not made and not changed', async (key) => {
    const before = await allRows(w, 'settings');
    const res = await putSetting(w, 'owner', key, { value: { at: '2026-10-17T00:00:00.000000Z' } });
    expect(res.statusCode, res.body).toBe(403);
    expect(codeOf(res)).toBe('JV_FORBIDDEN');
    expect(detailsOf(res)).toEqual({ field: 'key' });
    expect(await allRows(w, 'settings')).toBe(before);
  });

  it.each(['last_download', 'last_pulled'])('and not when the row is there: %s keeps its value', async (key) => {
    await w.world.sql.query('INSERT INTO settings (setting_key, value, created_at, updated_at) VALUES (?, ?, ?, ?)', [key, JSON.stringify({ at: 'the real one' }), STAMP_DB, STAMP_DB]);
    const res = await putSetting(w, 'owner', key, { value: { at: 'forged' } });
    expect(res.statusCode).toBe(403);
    expect(await settingRow(w, key)).toMatchObject({ value: { at: 'the real one' }, updated_at: STAMP_DB });
  });

  it('a spelling of the key that the database\'s case-insensitive comparison would treat as the same row is not a key at all (422), so the rule cannot be walked around', async () => {
    for (const key of ['Last_Download', 'LAST_PULLED', 'last_download%20', 'last-download']) {
      const res = await putSetting(w, 'owner', key, { value: { at: 'forged' } });
      expect([403, 422, 404], key).toContain(res.statusCode);
      expect(res.statusCode, key).not.toBe(200);
    }
    expect(await settingRow(w, 'last_download')).toMatchObject({ value: { at: 'the real one' } });
  });
});

describe('T-D05 a key and a value (D3): a key is 1 to 64 lower-case letters, digits and underscores; a value is a JSON object or list', () => {
  it('a key that is not there yet is made: 201 with the new row (A4 `I`); staff do not read it (A4), the owner and a biller do', async () => {
    const res = await putSetting(w, 'owner', 'shop_notes', { value: { floor: 2 } });
    expect(res.statusCode, res.body).toBe(201);
    expect(body(res).row).toMatchObject({ setting_key: 'shop_notes', value: { floor: 2 }, created_by: owner(), updated_by: owner() });
    expect(body(res).row.created_at).toBe(body(res).row.updated_at);
    for (const [caller, sees] of [['owner', true], ['biller', true], ['staff', false]] as const) {
      const page = bodyOf(await getPage(w.world, caller, 'settings'));
      expect(page.rows.some((r) => r.setting_key === 'shop_notes'), caller).toBe(sees);
    }
  });

  it.each(['Has-Dash', 'UPPER', '1starts_with_digit', 'x'.repeat(65), 'has space', 'dot.ted', '_leading'])('the key %j is 422 on key and nothing is made', async (key) => {
    const before = await allRows(w, 'settings');
    const res = await putSetting(w, 'owner', encodeURIComponent(key), { value: { a: 1 } });
    expect(res.statusCode, res.body).toBe(422);
    expect(detailsOf(res)).toEqual({ field: 'key' });
    expect(await allRows(w, 'settings')).toBe(before);
  });

  it('a key of 64 characters is fine', async () => {
    const key = `k${'x'.repeat(63)}`;
    const res = await putSetting(w, 'owner', key, { value: [1] });
    expect(res.statusCode, res.body).toBe(201);
  });

  it.each([
    ['null', null],
    ['a string', 'text'],
    ['a number', 5],
    ['true', true],
  ])('a value that is %s is 422 on value (an object or a list only)', async (_what, value) => {
    const res = await putSetting(w, 'owner', 'shop_notes', { value });
    expect(res.statusCode).toBe(422);
    expect(detailsOf(res)).toEqual({ field: 'value' });
  });

  it('a value that is missing is 422 "is required"; one that is too large (more than 64 KiB of JSON) is 422', async () => {
    const missing = await putSetting(w, 'owner', 'shop_notes', {});
    expect([missing.statusCode, detailsOf(missing)]).toEqual([422, { field: 'value' }]);
    const big = await putSetting(w, 'owner', 'shop_notes', { value: { text: 'x'.repeat(70_000) } });
    expect([big.statusCode, detailsOf(big)]).toEqual([422, { field: 'value' }]);
    const fine = await putSetting(w, 'owner', 'shop_notes', { value: { text: 'x'.repeat(60_000) } });
    expect(fine.statusCode, fine.body).toBe(200);
  });

  it('an empty list and an empty object are values', async () => {
    expect((await putSetting(w, 'owner', 'shop_list', { value: [] })).statusCode).toBe(201);
    expect((await putSetting(w, 'owner', 'shop_list', { value: {} })).statusCode).toBe(200);
  });

  it('the value comes back exactly as it went in, in the order of its keys, with unicode and nested lists', async () => {
    const value = { b: [1, 2, { c: 'नमस्ते' }], a: null, z: false, n: 1.5 };
    const res = await putSetting(w, 'owner', 'shop_notes', { value });
    expect(res.statusCode, res.body).toBe(200);
    expect(body(res).row.value).toEqual(value);
    expect((await settingRow(w, 'shop_notes'))?.value).toEqual(value);
  });
});

describe('T-D05 what the code reads is checked before it is stored (D3, L4, R8, D7)', () => {
  const bad = async (key: string, value: unknown, field: string) => {
    const before = await settingRow(w, key);
    const res = await putSetting(w, 'owner', key, { value });
    expect([res.statusCode, detailsOf(res)], JSON.stringify(value).slice(0, 80)).toEqual([422, { field }]);
    expect(await settingRow(w, key)).toEqual(before);
  };

  it('estimate: the bill prefix is 1 to 12 letters or digits with a hyphen between them (BILL_PREFIX_PATTERN, no colon: the counter series is bill:<PREFIX>:<YYYY>), roundOff is true or false', async () => {
    for (const prefix of ['', 'A:B', '-JV', 'JV-', 'ABCDEFGHIJKLM', 'J V', 5, null]) await bad('estimate', { ...ESTIMATE, prefix }, 'value.prefix');
    for (const roundOff of ['true', 1, null, undefined]) await bad('estimate', { ...ESTIMATE, roundOff }, 'value.roundOff');
    const { prefix: _p, ...noPrefix } = ESTIMATE;
    await bad('estimate', noPrefix, 'value.prefix');
    const { roundOff: _r, ...noRound } = ESTIMATE;
    await bad('estimate', noRound, 'value.roundOff');
    await bad('estimate', [ESTIMATE], 'value');
    for (const prefix of ['JV', 'A', 'JG-2026', 'ABCDEFGHIJKL', '12']) {
      const ok = await putSetting(w, 'owner', 'estimate', { value: { ...ESTIMATE, prefix } });
      expect(ok.statusCode, prefix).toBe(200);
      expect(body(ok).row.value.prefix).toBe(prefix);
    }
    const noFooter = await putSetting(w, 'owner', 'estimate', { value: { prefix: 'JV', roundOff: false } });
    expect(noFooter.statusCode, noFooter.body).toBe(200);
  });

  it('numbering: the paddings are whole numbers from 1 to 10 and the barcode prefix is text (the number steps of API14 refuse anything else)', async () => {
    const good = { designPadding: 5, skuPadding: 3, barcodePrefix: 'BC' };
    for (const designPadding of [0, 11, 1.5, '5', null]) await bad('numbering', { ...good, designPadding }, 'value.designPadding');
    for (const skuPadding of [0, 11, 2.5, '3']) await bad('numbering', { ...good, skuPadding }, 'value.skuPadding');
    for (const barcodePrefix of ['', ' ', 7, null]) await bad('numbering', { ...good, barcodePrefix }, 'value.barcodePrefix');
    await bad('numbering', { designPadding: 5, skuPadding: 3 }, 'value.barcodePrefix');
    for (const padding of [1, 10]) {
      const ok = await putSetting(w, 'owner', 'numbering', { value: { ...good, designPadding: padding, skuPadding: padding } });
      expect(ok.statusCode, String(padding)).toBe(200);
    }
  });

  it('the keys that hold lists are lists and the others are objects (the screens read them that way)', async () => {
    for (const key of ['materials', 'locations', 'custom_fields']) await bad(key, { not: 'a list' }, 'value');
    for (const key of ['business', 'taxes', 'tag_template', 'photos', 'data_epoch']) await bad(key, ['not an object'], 'value');
    expect((await putSetting(w, 'owner', 'locations', { value: ['Main Showroom', 'Vault'] })).statusCode).toBe(200);
    expect((await putSetting(w, 'owner', 'business', { value: { legalName: 'X', displayName: 'X' } })).statusCode).toBe(200);
  });
});

describe('T-D05 no stale check on a setting, the same value changes nothing, and no stamp or person column can be sent (S6, D22)', () => {
  it('the last write wins: two writes in a row both succeed and the second value is stored', async () => {
    const a = await putSetting(w, 'owner', 'tag_template', { value: { widthMm: 40 } });
    const b = await putSetting(w, 'owner', 'tag_template', { value: { widthMm: 60 } });
    expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
    expect((await settingRow(w, 'tag_template'))?.value).toEqual({ widthMm: 60 });
    expect(body(b).row.updated_at > body(a).row.updated_at).toBe(true);
  });

  it('a body that carries expected_updated_at is not this call\'s shape: 422 (nothing is silently ignored)', async () => {
    const res = await putSetting(w, 'owner', 'tag_template', { value: { widthMm: 1 }, expected_updated_at: '2026-10-01T08:30:15.123457Z' });
    expect([res.statusCode, detailsOf(res)]).toEqual([422, { field: 'expected_updated_at' }]);
    expect((await settingRow(w, 'tag_template'))?.value).toEqual({ widthMm: 60 });
  });

  it('the same value again (a different order of keys is the same value) is 200 with the row, no write, no new stamp', async () => {
    await putSetting(w, 'owner', 'photos', { value: { maxPerDesign: 3, maxSidePx: 1000 } });
    const before = await settingRow(w, 'photos');
    const same = await putSetting(w, 'owner', 'photos', { value: { maxSidePx: 1000, maxPerDesign: 3 } });
    expect(same.statusCode, same.body).toBe(200);
    expect(await settingRow(w, 'photos')).toEqual(before);
  });

  it('a stamp, a person column or a name that is no column is 422; the key column itself is a column that is on nobody\'s list (403)', async () => {
    const before = await allRows(w, 'settings');
    for (const f of ['created_by', 'updated_by', 'set_by', 'confirmed_by']) {
      const res = await putSetting(w, 'owner', 'photos', { value: { a: 1 }, [f]: randomUUID() });
      expect([f, res.statusCode, detailsOf(res)]).toEqual([f, 422, { field: f }]);
    }
    for (const f of ['created_at', 'updated_at']) {
      const res = await putSetting(w, 'owner', 'photos', { value: { a: 1 }, [f]: '2020-01-01T00:00:00.000000Z' });
      expect([f, res.statusCode]).toEqual([f, 422]);
    }
    expect((await putSetting(w, 'owner', 'photos', { value: { a: 1 }, colour: 'red' })).statusCode).toBe(422);
    const key = await putSetting(w, 'owner', 'photos', { value: { a: 1 }, setting_key: 'estimate' });
    expect([key.statusCode, codeOf(key)]).toEqual([403, 'JV_FORBIDDEN']);
    expect(await allRows(w, 'settings')).toBe(before);
  });

  it('the write moves updated_at, so the next poll of every screen reads the row again (C4)', async () => {
    const first = await putSetting(w, 'owner', 'taxes', { value: { gstEnabled: true, gstPercent: 1, estimateTaxPercent: 0 } }); // not the seeded value: that would be no change, and no write
    expect(first.statusCode, first.body).toBe(200);
    const cursor = body(first).row.updated_at as string; // what a screen that polled just now holds
    const second = await putSetting(w, 'owner', 'taxes', { value: { gstEnabled: true, gstPercent: 3, estimateTaxPercent: 0 } });
    expect(second.statusCode, second.body).toBe(200);
    const next = bodyOf(await getPage(w.world, 'biller', 'settings', { updated_after: cursor }));
    expect(next.rows.find((r) => r.setting_key === 'taxes')).toEqual(body(second).row);
    expect(body(second).row.updated_at > cursor).toBe(true);
  });
});
