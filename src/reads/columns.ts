// The columns a person reads of a resource (READ_COLUMNS of the permission matrix, A4), for the reads of this folder: a read names its columns and never uses SELECT *. A person whose grants do not
// pass the resource's read row reads nothing, whatever asked (the route's matrix row has refused it already; this is the second check, X0 item 2). The grants are the ticks the session read for the
// call (`auth.user.grants`, R4), never the role's name. Nothing the client sends is ever a column or table name (A11).
import { JvError } from '../errors.js';
import type { Grants } from '../permissions/grants.js';
import { type ReadResource, readColumnsFor } from '../permissions/matrix.js';

const IDENT = /^[a-z][a-z0-9_]*$/;

/** A column or table name of the allow-lists, checked once more before it goes into a statement. */
export function ident(name: string): string {
  if (!IDENT.test(name)) throw new Error(`not a column or table name of the allow-lists: ${name.slice(0, 40)}`);
  return name;
}

export function readColumns(resource: ReadResource, grants: Grants): readonly string[] {
  const columns = readColumnsFor(grants, resource);
  if (!columns) throw new JvError('JV_FORBIDDEN', 'You are not allowed to do this.');
  return columns;
}

/** The select list of a derived table or table alias: `v.a, v.b`. */
export const selectList = (alias: string, columns: readonly string[]): string => columns.map((c) => `${ident(alias)}.${ident(c)}`).join(', ');
