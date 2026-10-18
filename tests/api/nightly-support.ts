import type { Connection } from 'mysql2/promise';
import type { DbConnection } from '../../src/db/pool';
import { type NightlyOptions, type NightlyResult, runNightlyCheck } from '../../src/jobs/nightly';
import { cleanWorld } from '../schema/support';
import { type EditWorld, editWorld } from './edit-support';

// Shared by the tests of API32 (the nightly check: T-B18 and T-B24): a scratch database with the real routes and the seeds (editWorld), and the consistent books of MB02 (cleanWorld) whose lines have been
// given a net weight and rates that price to the amounts MB02 typed in, so that the Node half of I6 (every stored line equals a fresh priceLine) holds on them as the SQL half does.

export type Books = Awaited<ReturnType<typeof cleanWorld>>;

/**
 * cleanWorld's lines carry the default snapshot of V.billItem (11 g at 100.00 and 10.00) next to amounts MB02 typed in by hand (500.00 + 100.00 = 600.00), which no pricing rule produces. Every line
 * becomes 10 g at metal_amount / 10 and labour_amount / 10 a gram: priceLine of a By Weight Gold line then gives exactly the typed amounts (R3, R5, R7), and the list prices are the rates sold at.
 */
export async function priceTheLines(sql: Connection): Promise<void> {
  await sql.query(
    `UPDATE bill_items SET gross_weight = '10.000', customer_net_weight = '10.000', quantity = 1, piroi = '0.00', other_charges = '0.00',
            metal_rate = ROUND(metal_amount / 10, 2), labour_rate = ROUND(labour_amount / 10, 2),
            list_metal_rate = ROUND(metal_amount / 10, 2), list_labour_rate = ROUND(labour_amount / 10, 2)`,
  );
}

export interface NightlyWorld {
  w: EditWorld;
  books: Books;
  /** the ten-box user's connection to the scratch database (autocommit): damage is done with it */
  sql: Connection;
  /** one run of the nightly check on a connection checked out of the application's pool, on the application's clock */
  run(options?: Partial<NightlyOptions>): Promise<NightlyResult>;
  /** the rows of check_runs, oldest first, details parsed */
  checkRuns(): Promise<{ id: number; ran_at: string; ok: number; details: any }[]>;
  /** a statement as the scratch database's root (for the deletes the ten-box user cannot do, and DDL): the database is the current one */
  root(sql: string, params?: unknown[]): Promise<void>;
  close(): Promise<void>;
}

export async function nightlyWorld(label: string): Promise<NightlyWorld> {
  const w = await editWorld(label);
  const books = await cleanWorld(w.world.sql);
  await priceTheLines(w.world.sql);
  const root = await w.world.scratch.root();
  await root.query(`USE \`${w.world.scratch.database}\``);
  return {
    w,
    books,
    sql: w.world.sql,
    async run(options = {}) {
      const conn: DbConnection = await w.world.app.db!.checkout();
      try {
        return await runNightlyCheck(conn, { clock: w.world.app.clock, ...options });
      } finally {
        conn.release();
      }
    },
    async checkRuns() {
      const [rows] = await w.world.sql.query<any[]>('SELECT id, ran_at, ok, details FROM check_runs ORDER BY id');
      return rows.map((r) => ({ id: Number(r.id), ran_at: String(r.ran_at), ok: Number(r.ok), details: typeof r.details === 'string' ? JSON.parse(r.details) : r.details }));
    },
    async root(sql, params = []) {
      await root.query(sql, params as any[]);
    },
    async close() {
      await root.end().catch(() => undefined);
      await w.world.close();
    },
  };
}
