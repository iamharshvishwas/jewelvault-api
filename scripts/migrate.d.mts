import type { Connection } from 'mysql2/promise';
export interface MigrateOptions {
  /** Directory with NNNN_name.sql files. Default: db/migrations. */
  dir?: string;
  /** Apply db/seeds after the migrations (default true). */
  seeds?: boolean;
  /** Apply db/optional (triggers that need the TRIGGER privilege). Default false. */
  optional?: boolean;
}
export function migrate(conn: Connection, opts?: MigrateOptions): Promise<{ applied: string[]; skipped: string[] }>;
export function listMigrations(dir?: string): { version: string; name: string; sql: string; checksum: string }[];
export function buildSchemaSql(): string;
export function buildSeedSql(): string;

export type SqlKind = 'migration' | 'seed' | 'trigger';
/** S9: what a migration file may hold. Returns the statements that are not allowed, with the reason; an empty list means the file is fine. */
export function checkSql(sql: string, kind: SqlKind): { statement: string; reason: string }[];
/** The statements of a file, comments removed, split on ; outside quotes. */
export function splitStatements(sql: string): string[];
