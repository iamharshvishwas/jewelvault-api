// D5, A4: categories and subcategories (POST /v1/categories, PATCH /v1/categories/:id, the same for /v1/subcategories). A5 lists the content columns of designs, skus and customers only, so the
// columns here come from D5 and from the table of A4 (owner S I U, staff S I, biller S), and the lists of WRITE_COLUMNS are confirmed by tests/api/edit-columns.test.ts against those two lines:
//   categories     insert: name and prefix (an `active` category is the default; the owner and staff);   update: name and active (the owner)
//   subcategories  insert: category_id and name;   update: name and active
// The prefix is written once: it is the series of the design numbers (L3), and numbers already issued carry it. The category of a subcategory never changes: the designs refer to the pair. A
// removal is `active` = false (nothing is deleted, S7). A name is unique ignoring case (a category), or ignoring case inside its category (a subcategory): the rule is checked here for a plain
// answer on the field and is the database's unique key as well, which stands behind it for two calls at the same moment.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Tx } from '../db/tx.js';
import type { Auth } from '../permissions/route.js';
import { type EditTable, type InsertRule, type UpdateBody, type UpdateRule, insertRecord, invalid, mustExist, updateRecord } from './engine.js';
import * as f from './fields.js';

const NAME_MAX = 80;
const PREFIX_RULE = 'must be 2 to 6 capital letters or digits';

export const CATEGORIES: EditTable = {
  table: 'categories',
  insert: 'edit:categories.insert',
  update: 'edit:categories.update',
  fields: {
    name: f.requiredText(NAME_MAX),
    prefix: f.patterned(/^[A-Z0-9]{2,6}$/, PREFIX_RULE),
    active: f.flag,
  },
};

export const SUBCATEGORIES: EditTable = {
  table: 'subcategories',
  insert: 'edit:subcategories.insert',
  update: 'edit:subcategories.update',
  fields: {
    category_id: f.idRequired,
    name: f.requiredText(NAME_MAX),
    active: f.flag,
  },
};

const taken = (field: string, what: string) => invalid(field, `is already used by another ${what}`);

async function categoryNameTaken(tx: Tx, name: string, exceptId: string | null): Promise<boolean> {
  const rows = await tx.rows<{ id: string }>('SELECT id FROM categories WHERE name = ?', [name]);
  return rows.some((r) => r.id !== exceptId);
}
async function subcategoryNameTaken(tx: Tx, categoryId: string, name: string, exceptId: string | null): Promise<boolean> {
  const rows = await tx.rows<{ id: string }>('SELECT id FROM subcategories WHERE category_id = ? AND name = ?', [categoryId, name]);
  return rows.some((r) => r.id !== exceptId);
}

const categoryInsertRules: InsertRule = async (tx, values) => {
  if (await categoryNameTaken(tx, values.name as string, null)) throw taken('name', 'category');
};
const categoryUpdateRules: UpdateRule = async ({ tx, id, diff }) => {
  if ('name' in diff && (await categoryNameTaken(tx, diff.name as string, id))) throw taken('changes.name', 'category');
};
const subcategoryInsertRules: InsertRule = async (tx, values) => {
  await mustExist(tx, 'categories', values.category_id as string, 'category_id', 'is not a category');
  if (await subcategoryNameTaken(tx, values.category_id as string, values.name as string, null)) throw taken('name', 'subcategory of this category');
};
const subcategoryUpdateRules: UpdateRule = async ({ tx, id, current, diff }) => {
  if ('name' in diff && (await subcategoryNameTaken(tx, current.category_id as string, diff.name as string, id))) throw taken('changes.name', 'subcategory of this category');
};

export const addCategory = (app: FastifyInstance, request: FastifyRequest, auth: Auth, body: Record<string, unknown>) => insertRecord(app, request, auth, CATEGORIES, body, categoryInsertRules);
export const editCategory = (app: FastifyInstance, request: FastifyRequest, auth: Auth, id: string, body: UpdateBody) => updateRecord(app, request, auth, CATEGORIES, id, body, categoryUpdateRules);
export const addSubcategory = (app: FastifyInstance, request: FastifyRequest, auth: Auth, body: Record<string, unknown>) => insertRecord(app, request, auth, SUBCATEGORIES, body, subcategoryInsertRules);
export const editSubcategory = (app: FastifyInstance, request: FastifyRequest, auth: Auth, id: string, body: UpdateBody) =>
  updateRecord(app, request, auth, SUBCATEGORIES, id, body, subcategoryUpdateRules);
