import type { Connection } from 'mysql2/promise';

/** C2: the volumes the seed builds (customers include the walk-in). */
export interface Volumes {
  customers: number;
  designs: number;
  pieces: number;
  bills: number;
}
export const VOLUMES: Readonly<Volumes>;

export type Target = { kind: 'lane'; lane: 'main' | 'a' | 'b' | 'c' } | { kind: 'env' };
/** The command line: a lane name or --env, and optionally --customers N --designs N --pieces N --bills N. Throws an Error starting with "usage:" for anything else. */
export function parseArgs(argv: string[]): { target: Target; volumes: Volumes };

/** Why the database is not empty, one sentence for each table that holds something (the walk-in customer does not count). An empty list means it can be filled. */
export function emptinessProblems(conn: Connection): Promise<string[]>;

export interface SeedReport {
  /** true only when the nightly check passes on the result */
  ok: boolean;
  counts: {
    customers: number;
    designs: number;
    pieces: number;
    bills: number;
    opening_bills: number;
    sale_bills: number;
    bill_items: number;
    receipts: number;
    receipt_allocations: number;
    sold_pieces: number;
  };
  invariants: { ok: boolean; counts: Record<string, number> };
  batch: { id: string | null; name: string };
  ms: number;
}
/**
 * Fills an EMPTY database (migrations and seeds applied) with the shop of `volumes` (default: the volumes of C2) through the import library and one more transaction of sales. Throws before
 * writing anything when the volumes cannot be built, the database is not empty or it has no seeds.
 */
export function seedVolume(conn: Connection, volumes?: Partial<Volumes>): Promise<SeedReport>;
export function formatReport(report: SeedReport): string;
