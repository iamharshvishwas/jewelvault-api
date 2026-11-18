// The rows a money function answers with, in the wire format of the sync read of the person who called, so that the website's cache applies them as it applies a polled row (C5 (a)). A person who may not read
// the table of a row (the columns of its sync read, READ_COLUMNS) is refused JV_FORBIDDEN, and the function's transaction rolls back with everything it wrote.
//
// TEMPORARY (remove in Task 8, at the latest in Task 11): this is wireRow() of src/edit/engine.ts, asking the person's GRANTS. wireRow still takes the role KEY (a string, resolved through the built-in sets),
// which a custom role is not, so a custom role holding the right tick would be refused at the very end of every money function. The edit engine is Task 8's: when wireRow takes Grants, the money functions go
// back to it and this file goes.
import type { Row } from '../edit/engine.js';
import { JvError } from '../errors.js';
import type { Grants } from '../permissions/grants.js';
import { readColumnsFor } from '../permissions/matrix.js';
import { toWire } from '../sync/page.js';
import { resourceByName } from '../sync/resources.js';

/** A row of `table` as the sync read of this table gives it to the person with these grants. */
export function answerRow(table: string, grants: Grants, row: Row): Row {
  const resource = resourceByName(table.replaceAll('_', '-'));
  if (!resource) throw new Error(`${table} is not a sync resource`);
  const columns = readColumnsFor(grants, table);
  if (!columns) throw new JvError('JV_FORBIDDEN', 'You are not allowed to do this.');
  return toWire(resource, columns, row);
}
