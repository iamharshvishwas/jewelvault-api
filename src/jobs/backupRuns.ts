// D17, I12: the rows of `backup_runs` the dashboard line and the outside check read. The TypeScript twin of `recordBackupRun` in scripts/backup-folder.mjs (MB05), which the dump script (API34)
// uses; src cannot import scripts/*.mjs, and tests/api/backup-twins.test.ts keeps the two equal (the same statement, the same rows, the same words in a refusal).
//
// A row with `ok` true is written only when a phase is COMPLETE for the day, never for a slice that stopped early (D17); a failure is a row with `ok` false. `detail.folder = { files, bytes,
// free_bytes }` (folderStats) is what the dashboard compares from one good run to the next ("the file count fell without a prune" is red, I12), and the dump and the photo copy write into the SAME
// sequence: the dashboard reads the newest 60 good rows of kind db_dump and photo_copy together.
import { withAutocommit } from '../db/autocommit.js';
import type { TxContext } from '../db/tx.js';

export type BackupKind = 'db_dump' | 'photo_copy' | 'restore_drill';
const KINDS: readonly string[] = ['db_dump', 'photo_copy', 'restore_drill'];

export interface BackupRunInput {
  kind: BackupKind;
  ok: boolean;
  bytes?: number;
  detail?: { folder?: object; pruned?: unknown; [key: string]: unknown };
  /** DATETIME(6) text in UTC; default: the database's own clock. The tick passes the API's clock (S5). */
  ranAt?: string | null;
}

const INSERT_AT = 'INSERT INTO backup_runs (ran_at, kind, ok, bytes, detail) VALUES (?, ?, ?, ?, ?)';
const INSERT = 'INSERT INTO backup_runs (kind, ok, bytes, detail) VALUES (?, ?, ?, ?)';

/** Writes one backup_runs row and answers its id. `ok` is for a complete phase only (D17). */
export async function recordBackupRun(ctx: TxContext, input: BackupRunInput): Promise<{ id: number }> {
  const { kind, ok, bytes = 0, detail = {}, ranAt = null } = input;
  if (!KINDS.includes(kind)) throw new Error(`unknown backup kind: ${kind}`);
  if (detail.folder) {
    for (const k of ['files', 'bytes']) if (!Number.isFinite(Number((detail.folder as Record<string, unknown>)[k]))) throw new Error(`detail.folder.${k} must be a number`);
  }
  if (detail.pruned !== undefined && !(Number.isInteger(detail.pruned) && (detail.pruned as number) >= 0)) throw new Error('detail.pruned must be a whole number');
  const res = await withAutocommit(ctx, (db) =>
    ranAt ? db.run(INSERT_AT, [ranAt, kind, ok ? 1 : 0, bytes, JSON.stringify(detail)]) : db.run(INSERT, [kind, ok ? 1 : 0, bytes, JSON.stringify(detail)]),
  );
  return { id: Number(res.insertId) };
}
