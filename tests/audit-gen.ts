export interface ColumnInfo {
  name: string;
  /** information_schema DATA_TYPE in lower case: 'decimal', 'varchar', 'json'/'longtext', 'uuid', 'datetime', ... */
  type: string;
  /** true when the column is a JSON column (MariaDB reports it as longtext; the caller knows from COLUMN_TYPE/CHECK) */
  isJson?: boolean;
}

/** One JSON_OBJECT(...) over the row alias (NEW or OLD). DECIMAL goes through CHAR so no digit is lost; a JSON column is nested, not escaped. */
function jsonObject(alias: 'NEW' | 'OLD', cols: ColumnInfo[]): string {
  const parts = cols.map((c) => {
    const ref = `${alias}.\`${c.name}\``;
    if (c.isJson) return `'${c.name}', IF(${ref} IS NULL, NULL, JSON_COMPACT(${ref}))`;
    if (c.type === 'decimal' || c.type === 'uuid') return `'${c.name}', CAST(${ref} AS CHAR)`;
    return `'${c.name}', ${ref}`;
  });
  return `JSON_OBJECT(${parts.join(', ')})`;
}

/**
 * Spec L1 without Postgres' row_to_json: one AFTER INSERT and one AFTER UPDATE trigger per audited table, generated from the column list.
 * The actor comes from the session variables @jv_actor / @jv_role that the API sets at the start of every transaction (replacement for auth.uid());
 * a NULL actor is recorded with the role 'import' (spec IM2). An UPDATE that changes nothing but updated_at writes no row (spec D23).
 * A test compares the generated column list with information_schema so a column added later cannot be forgotten.
 */
export function auditTriggerSql(table: string, idColumn: string, cols: ColumnInfo[]): string[] {
  const other = cols.filter((c) => c.name !== 'updated_at');
  const same = other.map((c) => `NEW.\`${c.name}\` <=> OLD.\`${c.name}\``).join(' AND ');
  const actor = `@jv_actor, IF(@jv_actor IS NULL, 'import', @jv_role)`;
  return [
    `CREATE TRIGGER \`trg_${table}_audit_i\` AFTER INSERT ON \`${table}\` FOR EACH ROW
     INSERT INTO audit_log (actor, actor_role, table_name, row_id, action, old_row, new_row)
     VALUES (${actor}, '${table}', CAST(NEW.\`${idColumn}\` AS CHAR), 'insert', NULL, ${jsonObject('NEW', cols)})`,
    `CREATE TRIGGER \`trg_${table}_audit_u\` AFTER UPDATE ON \`${table}\` FOR EACH ROW
     BEGIN
       IF NOT (${same}) THEN
         INSERT INTO audit_log (actor, actor_role, table_name, row_id, action, old_row, new_row)
         VALUES (${actor}, '${table}', CAST(NEW.\`${idColumn}\` AS CHAR), 'update', ${jsonObject('OLD', cols)}, ${jsonObject('NEW', cols)});
       END IF;
     END`,
  ];
}
