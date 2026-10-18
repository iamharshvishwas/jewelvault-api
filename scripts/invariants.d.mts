import type { Connection } from 'mysql2/promise';
export interface InvariantRow { invariant: string; row_ref: string; detail: string }
export interface RunOptions {
  /** Rows kept per invariant in `rows` (the counts always cover everything). Default 20. */
  sample?: number;
  /** Folder of the invariant files. Default: db/invariants of this repository (the Hostinger proof app keeps its own copy). */
  dir?: string;
  /** Folder of the V1 to V4 query files. Default: db/queries. */
  queriesDir?: string;
  /** Replaces one of the derived reads by other SQL text (a test injects an old or wrong V3 or V4, T-B18). */
  queries?: Partial<Record<'V1' | 'V2' | 'V3' | 'V4', string>>;
  /** Test seam: called after each invariant query, so a test can commit a change while the run is in progress. */
  between?: (invariant: string) => Promise<void>;
  /** Called once, inside the snapshot, after the last file and before COMMIT: work that must read the same moment as the files (the Node half of I6 and the review line of API32). A failure rolls the snapshot back. */
  inSnapshot?: (conn: Connection) => Promise<void>;
}
export interface RunResult { ok: boolean; counts: Record<string, number>; rows: InvariantRow[]; ran: string[] }
/** Runs every file of db/invariants inside ONE consistent snapshot (REPEATABLE READ). I6 is the SQL half only: re-pricing the lines is done in Node. */
export function runInvariants(conn: Connection, opts?: RunOptions): Promise<RunResult>;
export function listInvariantFiles(dir?: string): { id: string; name: string; sql: string }[];
