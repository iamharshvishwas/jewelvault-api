import { randomUUID } from 'node:crypto';
import type { LightMyRequestResponse } from 'fastify';
import { migrate } from '../../scripts/migrate.mjs';
import { type Clock, type Reading, createClock } from '../../src/clock';
import type { Config } from '../../src/config';
import { timestampToWire } from '../../src/wire/format';
import { V, insert } from '../schema/support';
import { type CallerName, T0, type World, makeWorld } from './cells';

// Shared by the tests of API13 (the ordinary edits of designs, pieces, categories and subcategories: A5, D22, S6; T-C07, T-D19, T-D22, T-F05 and the clauses of T-D14, T-D02, T-F09): a world with the
// application's real routes on a scratch database that holds the migrations and the seeds, optionally the generated audit triggers (L1 mechanism (a)), and a clock the test can move and that
// remembers every reading it gave, so that a stored stamp can be traced back to the reading it came from (S6).

/** The stamp the fixture rows carry before anybody edits them: microseconds that are not zero, so a stamp cut to milliseconds is visibly another one. */
export const STAMP_DB = '2026-10-01 08:30:15.123457';
export const STAMP_WIRE = timestampToWire(STAMP_DB);

export interface TestClock {
  clock: Clock;
  /** every reading the API took, in order */
  readings: Reading[];
  /** the source: a test moves time by changing this */
  time: { micros: bigint };
}

/** A clock over a source the test moves; it starts at T0 (17 Oct 2026, 10:00 UTC), the instant the sessions of the fixture are made relative to. */
export function testClock(): TestClock {
  const time = { micros: T0 };
  const inner = createClock(() => time.micros);
  const readings: Reading[] = [];
  return {
    time,
    readings,
    clock: {
      read() {
        const r = inner.read();
        readings.push(r);
        return r;
      },
    },
  };
}

export interface EditWorld {
  world: World;
  time: TestClock;
  /** two categories of the seeds and the subcategory 'Kundan' of the first */
  category: string;
  other_category: string;
  subcategory: string;
}

export interface EditWorldOptions {
  /** true: db/optional is applied too, so the generated audit triggers write the audit rows (L1 (a)) */
  triggers?: boolean;
  /** values for the application's config: `{ auditMode: 'node' }` is mechanism (b) of L1 (API15), on a database WITHOUT the triggers */
  config?: Partial<Config>;
}

export async function editWorld(label: string, options: EditWorldOptions = {}): Promise<EditWorld> {
  const time = testClock();
  const world = await makeWorld({ label, routes: true, clock: time.clock, ...(options.config ? { config: options.config } : {}) });
  await migrate(world.sql, { seeds: true, optional: options.triggers === true });
  const [cats] = await world.sql.query<any[]>('SELECT id FROM categories ORDER BY name LIMIT 2');
  const [subs] = await world.sql.query<any[]>("SELECT id FROM subcategories WHERE category_id = ? AND name = 'Kundan'", [cats[0].id]); // the seeds give every category four
  const subcategory = subs[0].id as string;
  return { world, time, category: cats[0].id, other_category: cats[1].id, subcategory };
}

// ------------------------------------------------------------------ rows

/** A design with the stamp of the fixture. `o` overrides any column. */
export async function addDesign(w: EditWorld, o: Record<string, unknown> = {}): Promise<string> {
  const id = randomUUID();
  await insert(w.world.sql, 'designs', V.design(w.category, { id, updated_at: STAMP_DB, created_at: STAMP_DB, ...o }));
  return id;
}

export async function addPiece(w: EditWorld, designId: string, o: Record<string, unknown> = {}): Promise<string> {
  const id = randomUUID();
  await insert(w.world.sql, 'skus', V.sku(designId, { id, updated_at: STAMP_DB, created_at: STAMP_DB, ...o }));
  return id;
}

/** A photo stored under an id for a design: one row for each kind, as the upload route will make them (API17); the bytes are a few made-up ones. */
export async function addPhoto(w: EditWorld, designId: string, o: { id?: string; kinds?: ('full' | 'thumb')[]; removed?: boolean } = {}): Promise<string> {
  const id = o.id ?? randomUUID();
  for (const kind of o.kinds ?? ['full', 'thumb']) {
    const bytes = o.removed ? null : Buffer.from(`not-an-image-${id}-${kind}`);
    await w.world.sql.query('INSERT INTO design_photos (id, kind, design_id, mime, byte_size, sha256, bytes, removed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [
      id,
      kind,
      designId,
      'image/jpeg',
      bytes ? bytes.length : 10,
      Buffer.alloc(32, 1),
      bytes,
      o.removed ? '2026-10-02 00:00:00.000000' : null,
    ]);
  }
  return id;
}

export async function dbRow(w: EditWorld, table: string, id: string): Promise<Record<string, any>> {
  const [rows] = await w.world.sql.query<any[]>(`SELECT * FROM \`${table}\` WHERE id = ?`, [id]);
  if (rows.length !== 1) throw new Error(`${table} ${id}: ${rows.length} rows`);
  return rows[0];
}

/** The stamp of a row as the wire writes it (what a screen holds and sends back). */
export async function stampOf(w: EditWorld, table: string, id: string): Promise<string> {
  return timestampToWire((await dbRow(w, table, id)).updated_at as string);
}

// ------------------------------------------------------------------ calls

export const body = <T = any>(res: LightMyRequestResponse): T => JSON.parse(res.body) as T;
export const codeOf = (res: LightMyRequestResponse): string | undefined => (JSON.parse(res.body) as { error?: { code: string } }).error?.code;
export const detailsOf = (res: LightMyRequestResponse): any => (JSON.parse(res.body) as { error?: { details: unknown } }).error?.details;

/** PATCH /v1/<collection>/<id> with the body of A5: only the changed fields, and the stamp exactly as it was read. */
export function patch(w: EditWorld, caller: CallerName, collection: 'designs' | 'skus' | 'categories' | 'subcategories', id: string, expected: string, changes: Record<string, unknown>) {
  return w.world.call(caller, 'PATCH', `/v1/${collection}/${id}`, { payload: { expected_updated_at: expected, changes } });
}

/** Every column of a table, as the database holds it, for "nothing changed" comparisons. */
export async function snapshot(w: EditWorld, table: string, id: string): Promise<string> {
  return JSON.stringify(await dbRow(w, table, id));
}

export async function auditRows(w: EditWorld, table: string, rowId: string): Promise<any[]> {
  const [rows] = await w.world.sql.query<any[]>('SELECT * FROM audit_log WHERE table_name = ? AND row_id = ? ORDER BY id', [table, rowId]);
  return rows;
}

export async function auditCount(w: EditWorld): Promise<number> {
  const [rows] = await w.world.sql.query<any[]>('SELECT COUNT(*) AS n FROM audit_log');
  return Number(rows[0].n);
}
