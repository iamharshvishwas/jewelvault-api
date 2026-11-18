import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { grantsOf, hasTick, type Grants } from '../../src/permissions/grants';
import {
  FIELD_RIGHTS,
  MATRIX,
  RATE_REVIEW,
  READ_COLUMNS,
  WRITE_COLUMNS,
  columnsOfTable,
  dailyTotalsWindowDays,
  mayCall,
  mayUseField,
  readableSettingKeys,
  writeFieldVerdict,
  type Action,
  type EditAction,
  type FieldRight,
  type ReadResource,
} from '../../src/permissions/matrix';
import { BUILTIN_TICKS } from '../../src/permissions/ticks';

// P1, golden equivalence (DESIGN.md section 8): what the three built-in roles may do TODAY, written down from the permission code as it stood on the live API (staging 4fe7a82)
// before the roles-with-ticks work began, and compared with the code ever after. The fixture tests/api/fixtures/access-golden.json is recorded once (JV_RECORD_GOLDEN=1) and is never edited
// afterwards: a later change that makes this test fail is wrong, not the fixture. The file is written with sorted keys and with every list in the order the code gives it, so recording again
// from unchanged code gives the same bytes.
//
// verdictsFromCode() is the only place this file asks the permission code anything. When the permission code stops listing role names, only the body of that function is rewritten, to ask the
// same questions of the three built-in roles; the type, the fixture and the tests below do not change.

const FIXTURE = fileURLToPath(new URL('./fixtures/access-golden.json', import.meta.url));
const RECORD = process.env.JV_RECORD_GOLDEN === '1';

/** The three built-in roles of today. */
type Role = 'owner' | 'biller' | 'staff';

export type Golden = {
  /** May the role call the action: every row of the matrix. */
  rows: Record<Action, Record<Role, boolean>>;
  /** May the role use the owner-only field right of section 10 (FIELD_RIGHTS). */
  fields: Record<FieldRight, Record<Role, boolean>>;
  /** The keys of `settings` the role reads; null is every key (A4). */
  settingKeys: Record<Role, string[] | null>;
  /** The days of the cash book the role reads, counted back from today; null is the wide range and 0 is none (A4, O25). */
  dailyTotalsDays: Record<Role, number | null>;
  /** The columns the role reads of each read resource; null is none (A4). */
  readColumns: Record<ReadResource, Record<Role, string[] | null>>;
  /** What each direct edit does with each field it is sent (A5): allowed, forbidden (JV_FORBIDDEN) or unknown (JV_INVALID_INPUT). */
  writeVerdicts: Record<EditAction, Record<Role, Record<string, 'allowed' | 'forbidden' | 'unknown'>>>;
  /** The roles whose daily rates the nightly review checks (I11, O26). */
  rateReviewRoles: string[];
};

/**
 * The names every direct edit is asked about besides the fields of its own lists and the columns of its table: the stamps and person columns that no request may name (S6, D22), `id` and a
 * name that is nowhere.
 */
const ALWAYS_ASKED = ['created_at', 'updated_at', 'created_by', 'updated_by', 'set_by', 'confirmed_by', 'voided_by', 'cancelled_by', 'id', 'nonexistent_field'];

/** An object with one entry for each key, the value of each made by `value`. */
const table = <K extends string, V>(keys: readonly K[], value: (key: K) => V): Record<K, V> => Object.fromEntries(keys.map((key) => [key, value(key)])) as Record<K, V>;

/** A copy of a list the code holds (those are read-only, and a test may change what it gets); null when there is no list. */
const copy = (list: readonly string[] | null | undefined): string[] | null => (list === undefined || list === null ? null : [...list]);

/** Today's verdicts, asked of the permission code. A fresh value on every call. Each built-in role is asked as the grants its built-in tick set gives (BUILTIN_TICKS). */
export function verdictsFromCode(): Golden {
  const ROLES: readonly Role[] = ['owner', 'biller', 'staff'];
  const grants = table<Role, Grants>(ROLES, (role) => grantsOf({ roleKey: role, roleTicks: BUILTIN_TICKS[role], isSuperAdmin: false }));
  const perRole = <V>(value: (g: Grants) => V): Record<Role, V> => table<Role, V>(ROLES, (role) => value(grants[role]));
  // Ruling A: a role reads the columns of a resource when it may call the read row that serves the resource
  const readRowOf = (resource: ReadResource): Action => {
    const found = (Object.keys(MATRIX) as Action[]).find((a) => MATRIX[a].kind === 'read' && (MATRIX[a].reads ?? []).includes(resource));
    if (found === undefined) throw new Error(`no read row serves ${resource}`);
    return found;
  };
  return {
    // Ruling G: the rows of the Super Admin did not exist when the fixture was recorded (P5 covers them)
    rows: table((Object.keys(MATRIX) as Action[]).filter((a) => MATRIX[a].kind !== 'super'), (action) => perRole((g) => mayCall(g, action))),
    fields: table(Object.keys(FIELD_RIGHTS) as FieldRight[], (field) => perRole((g) => mayUseField(g, field))),
    settingKeys: perRole((g) => copy(readableSettingKeys(g))),
    dailyTotalsDays: perRole((g) => dailyTotalsWindowDays(g)),
    readColumns: table(Object.keys(READ_COLUMNS) as ReadResource[], (resource) => perRole((g) => (mayCall(g, readRowOf(resource)) ? copy(READ_COLUMNS[resource]) : null))),
    writeVerdicts: table(Object.keys(WRITE_COLUMNS) as EditAction[], (action) => {
      const edit = MATRIX[action].edit;
      if (edit === undefined) throw new Error(`${action} is a direct edit without an edit spec`);
      const asked = [...new Set([...Object.values(WRITE_COLUMNS[action]).flatMap((list) => list ?? []), ...columnsOfTable(edit.table), ...ALWAYS_ASKED])];
      return perRole((g) => table(asked, (field) => writeFieldVerdict(action, g, field)));
    }),
    rateReviewRoles: ROLES.filter((role) => hasTick(grants[role], RATE_REVIEW.holds) && !hasTick(grants[role], RATE_REVIEW.lacks)),
  };
}

/** The fixture as text: the keys of every object in plain code-unit order (the same on every machine), lists as they are, two spaces of indent, one newline at the end. */
const fixtureText = (golden: Golden): string =>
  JSON.stringify(
    golden,
    (_key, value: unknown) => (typeof value === 'object' && value !== null && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : value),
    2,
  ) + '\n';

describe('P1 access golden (today)', () => {
  it('has the size the design counts: 55 rows, 5 field rights, 12 edit actions', () => {
    const g = verdictsFromCode();
    expect(Object.keys(g.rows)).toHaveLength(55);
    expect(Object.keys(g.fields)).toHaveLength(5);
    expect(Object.keys(g.writeVerdicts)).toHaveLength(12);
  });
  it('equals the committed fixture', () => {
    if (RECORD) {
      writeFileSync(FIXTURE, fixtureText(verdictsFromCode()));
      return;
    }
    expect(verdictsFromCode()).toEqual(JSON.parse(readFileSync(FIXTURE, 'utf8')));
  });
  it('control: the comparison can fail', () => {
    const g = verdictsFromCode(); g.rows['fn:cancel_bill'].biller = true;
    expect(g).not.toEqual(JSON.parse(readFileSync(FIXTURE, 'utf8')));
  });
});
