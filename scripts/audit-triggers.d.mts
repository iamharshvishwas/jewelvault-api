import type { Connection } from 'mysql2/promise';

export const AUDITED_TABLES: string[];
export const EXCLUDE_FILE: string;
export const TRIGGER_FILE: string;
export const SECRET_NAME: RegExp;
export interface AuditColumn { name: string; type: string; json: boolean }
export type AuditShape = Record<string, { columns: AuditColumn[]; primary_key: string[] }>;
/** db/optional/audit-exclude.json: columns never copied into audit_log, per table (keys starting with _ are notes). */
export function loadExcludeList(file?: string): Record<string, string[]>;
export function readAuditShape(conn: Connection, tables?: string[]): Promise<AuditShape>;
/** The text of db/optional/0910_audit_triggers.sql. Throws for a secret-looking column that is not excluded, an unknown type, or an exclude entry for a column that does not exist. */
export function buildAuditTriggersSql(shape: AuditShape, exclude: Record<string, string[]>, tables?: string[]): string;
export function generateAuditTriggersSql(conn: Connection, opts?: { exclude?: Record<string, string[]>; tables?: string[] }): Promise<string>;
/** Names of the generated audit triggers present in the connected database. */
export function auditTriggersInstalled(conn: Connection): Promise<string[]>;
