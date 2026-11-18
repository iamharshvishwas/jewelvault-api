// The columns a caller reads of a resource (READ_COLUMNS of the permission matrix, A4), for the reads of this folder: a read names its columns and never uses SELECT *. A caller who may not call
// the resource's read row reads nothing, whatever asked (the route's matrix row has refused it already; this is the second check, X0 item 2). Nothing the client sends is ever a column or table
// name (A11).
import { JvError } from '../errors.js';
import { type ReadResource, type Who, readColumnsFor } from '../permissions/matrix.js';

const IDENT = /^[a-z][a-z0-9_]*$/;

/** A column or table name of the allow-lists, checked once more before it goes into a statement. */
export function ident(name: string): string {
  if (!IDENT.test(name)) throw new Error(`not a column or table name of the allow-lists: ${name.slice(0, 40)}`);
  return name;
}

export function readColumns(resource: ReadResource, who: Who): readonly string[] {
  const columns = readColumnsFor(who, resource);
  if (!columns) throw new JvError('JV_FORBIDDEN', 'You are not allowed to do this.');
  return columns;
}

/** The select list of a derived table or table alias: `v.a, v.b`. */
export const selectList = (alias: string, columns: readonly string[]): string => columns.map((c) => `${ident(alias)}.${ident(c)}`).join(', ');
