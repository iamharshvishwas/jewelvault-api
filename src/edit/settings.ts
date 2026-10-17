// D3, A4, B3, O54: the settings (PUT /v1/settings/:key). One row for each key, never one blob; the owner is the only writer (the matrix row `edit:settings.update`, the field `value`). The
// body is the fields themselves, `{ value }`: the row of the matrix has the shape `fields`, so there is no `expected_updated_at` and the last write wins (the row is locked while it is written).
//
//   - the key is in the address: 1 to 64 lower-case letters, digits and underscores, starting with a letter. The database compares keys case-insensitively and ignoring trailing spaces
//     (utf8mb4_unicode_ci), so a spelling such as `Last_Download` would have been the same row as `last_download`: only the plain spelling is a key at all.
//   - THE GENERIC EDIT NEVER WRITES `last_download` OR `last_pulled` (A4, B3, O54): the download record has its own call (API35) and the pull record the admin door (API09); 403 JV_FORBIDDEN naming `key`.
//   - a key that is not there is made (A4 `I`, 201), one that is there is changed (A4 `U`, 200); the same value again writes nothing.
//   - the value is a JSON object or list of at most 64 KiB (fields.ts). The shape of the keys that code reads is checked here, so that a bad value can never reach X1, X7 or X8:
//     `estimate.prefix` is the bill prefix of L4 (BILL_PREFIX_PATTERN of src/db/numbers.ts: a prefix outside it is a TypeError in the number step), `estimate.roundOff` is true or false (R8: any other
//     value is JV_INTERNAL in quote_bill), `numbering` holds the two paddings (whole numbers from 1 to 10, as the number steps require) and the barcode prefix. The other keys of D3 are an object
//     or a list, as the screens read them; what they hold is the screen's.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { BILL_PREFIX_PATTERN } from '../db/numbers.js';
import { JvError } from '../errors.js';
import { NEVER_WRITTEN_SETTINGS } from '../permissions/matrix.js';
import type { Auth } from '../permissions/route.js';
import { type EditTable, invalid, upsertRecord } from './engine.js';
import * as f from './fields.js';

export const SETTINGS: EditTable = {
  table: 'settings',
  key: 'setting_key',
  insert: 'edit:settings.update',
  update: 'edit:settings.update',
  fields: { value: f.jsonValue },
};

const KEY = /^[a-z][a-z0-9_]{0,63}$/;

/** The keys of D3 whose value is a list; every other key of D3 is an object. */
const LIST_KEYS: readonly string[] = ['materials', 'locations', 'custom_fields'];
const OBJECT_KEYS: readonly string[] = ['business', 'estimate', 'taxes', 'tag_template', 'numbering', 'photos', 'data_epoch'];

const BARCODE_PREFIX_MAX = 20;

type Obj = Record<string, unknown>;
const isWholeFromTo = (v: unknown, from: number, to: number): boolean => typeof v === 'number' && Number.isInteger(v) && v >= from && v <= to;

/** The key of the address: a plain key, and not one of the two the generic edit never writes. Throws; returns the key. */
export function checkSettingKey(key: string): string {
  if (NEVER_WRITTEN_SETTINGS.includes(key)) throw new JvError('JV_FORBIDDEN', 'This setting is not written by this call.', { details: { field: 'key' } });
  if (!KEY.test(key)) throw invalid('key', 'must be 1 to 64 lower-case letters, digits and underscores, starting with a letter');
  return key;
}

/** What the code that reads a key needs of its value. `value` is already known to be a JSON object or list. */
export function checkSettingValue(key: string, value: object): void {
  const isList = Array.isArray(value);
  if (LIST_KEYS.includes(key) && !isList) throw invalid('value', 'must be a list');
  if (OBJECT_KEYS.includes(key) && isList) throw invalid('value', 'must be a JSON object');
  const v = value as Obj;
  if (key === 'estimate') {
    if (typeof v.prefix !== 'string' || !BILL_PREFIX_PATTERN.test(v.prefix)) throw invalid('value.prefix', 'must be 1 to 12 letters or digits, with a hyphen allowed between them');
    if (typeof v.roundOff !== 'boolean') throw invalid('value.roundOff', 'must be true or false');
  }
  if (key === 'numbering') {
    if (!isWholeFromTo(v.designPadding, 1, 10)) throw invalid('value.designPadding', 'must be a whole number from 1 to 10');
    if (!isWholeFromTo(v.skuPadding, 1, 10)) throw invalid('value.skuPadding', 'must be a whole number from 1 to 10');
    if (typeof v.barcodePrefix !== 'string' || v.barcodePrefix.trim() === '' || v.barcodePrefix !== v.barcodePrefix.trim() || v.barcodePrefix.length > BARCODE_PREFIX_MAX) {
      throw invalid('value.barcodePrefix', `must be text of 1 to ${BARCODE_PREFIX_MAX} characters with no space at either end`);
    }
  }
}

/** PUT /v1/settings/:key. Everything that can be refused without the database is refused first; the answer says whether the row was made. */
export function putSetting(app: FastifyInstance, request: FastifyRequest, auth: Auth, key: string, body: Obj): Promise<{ row: Record<string, unknown>; created: boolean }> {
  checkSettingKey(key);
  return upsertRecord(app, request, auth, SETTINGS, key, body, (values) => checkSettingValue(key, values.value as object));
}
