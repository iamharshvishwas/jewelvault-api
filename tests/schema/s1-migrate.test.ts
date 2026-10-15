import { cpSync, mkdtempSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { dropDb, errorOf, freshDb } from '../helpers';
import { buildSchemaSql, buildSeedSql, listMigrations, migrate } from '../../scripts/migrate.mjs';
import { migrationConn } from './support';

// T-F04: all migrations on an empty database, the same schema twice, every file re-runnable (DDL is not transactional in MariaDB).

const dbs: string[] = [];
afterAll(async () => {
  for (const d of dbs) await dropDb(d);
});

async function newDb(name: string) {
  const db = await freshDb(name);
  dbs.push(db);
  return { db, c: await migrationConn(db) };
}

async function schemaDump(c: Awaited<ReturnType<typeof migrationConn>>): Promise<string> {
  const [tables] = await c.query<any[]>("SELECT TABLE_NAME AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE' ORDER BY 1");
  const out: string[] = [];
  for (const t of tables) {
    const [r] = await c.query<any[]>(`SHOW CREATE TABLE \`${t.n}\``);
    // AUTO_INCREMENT counters are data, not schema
    out.push(String(r[0]['Create Table']).replace(/ AUTO_INCREMENT=\d+/, ''));
  }
  const [views] = await c.query<any[]>("SELECT TABLE_NAME AS n FROM information_schema.VIEWS WHERE TABLE_SCHEMA = DATABASE() ORDER BY 1");
  for (const v of views) {
    const [r] = await c.query<any[]>(`SHOW CREATE VIEW \`${v.n}\``);
    out.push(String(r[0]['Create View']));
  }
  return out.join('\n\n');
}

describe('migration runner', () => {
  it('applies every migration to an empty database and records each one; a second run applies nothing', async () => {
    const { c } = await newDb('s1_a');
    const first = await migrate(c, { seeds: false });
    const files = listMigrations();
    expect(files.length).toBeGreaterThanOrEqual(10);
    expect(first.applied).toEqual(files.map((f) => f.version));
    const [rows] = await c.query<any[]>('SELECT version, checksum FROM schema_migrations ORDER BY version');
    expect(rows.map((r) => r.version)).toEqual(files.map((f) => f.version));
    const second = await migrate(c, { seeds: false });
    expect(second.applied).toEqual([]);
    expect(second.skipped).toEqual(files.map((f) => f.version));
    await c.end();
  });

  it('two empty databases get the same schema', async () => {
    const a = await newDb('s1_b1');
    const b = await newDb('s1_b2');
    await migrate(a.c, { seeds: false });
    await migrate(b.c, { seeds: false });
    expect(await schemaDump(a.c)).toBe(await schemaDump(b.c));
    await a.c.end();
    await b.c.end();
  });

  it('every migration file can be run again by hand without changing the schema (re-runnable, S9)', async () => {
    const { c } = await newDb('s1_c');
    await migrate(c, { seeds: false });
    const before = await schemaDump(c);
    await c.query("SET SESSION sql_mode = 'STRICT_TRANS_TABLES,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION'");
    for (const f of listMigrations()) {
      const err = await errorOf(() => c.query(f.sql));
      expect(err, `re-running ${f.version}_${f.name}: ${err?.message}`).toBeNull();
    }
    expect(await schemaDump(c)).toBe(before);
    await c.end();
  });

  it('refuses an applied migration whose file has changed since (checksum)', async () => {
    const { c } = await newDb('s1_d');
    const dir = mkdtempSync(join(tmpdir(), 'jv-mig-'));
    cpSync(join(__dirname, '..', '..', 'db', 'migrations'), dir, { recursive: true });
    await migrate(c, { dir, seeds: false });
    const first = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()[0];
    writeFileSync(join(dir, first), readFileSync(join(dir, first), 'utf8') + '\n-- edited after it was applied\n');
    await expect(migrate(c, { dir, seeds: false })).rejects.toThrow(/checksum/i);
    await c.end();
  });

  it('sets a strict sql_mode for itself, whatever the server default is (Hostinger is not strict)', async () => {
    const { c } = await newDb('s1_e');
    await c.query("SET SESSION sql_mode = 'NO_AUTO_CREATE_USER,NO_ENGINE_SUBSTITUTION'");
    await migrate(c, { seeds: false });
    const [r] = await c.query<any[]>('SELECT @@sql_mode AS m');
    expect(r[0].m).toContain('STRICT_TRANS_TABLES');
    await c.end();
  });

  it('db/schema.sql (for pasting into phpMyAdmin) is exactly the migrations joined, and builds the same schema', async () => {
    const built = buildSchemaSql();
    const onDisk = readFileSync(join(__dirname, '..', '..', 'db', 'schema.sql'), 'utf8');
    expect(onDisk).toBe(built);
    const ref = await newDb('s1_f1');
    const viaSql = await newDb('s1_f2');
    await migrate(ref.c, { seeds: false });
    await viaSql.c.query("SET SESSION sql_mode = 'STRICT_TRANS_TABLES,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION'");
    await viaSql.c.query(onDisk);
    // schema.sql has no schema_migrations table, so compare the business tables only
    const strip = (s: string) => s.split('\n\n').filter((t) => !t.includes('`schema_migrations`')).join('\n\n');
    expect(strip(await schemaDump(viaSql.c))).toBe(strip(await schemaDump(ref.c)));
    await ref.c.end();
    await viaSql.c.end();
  });

  it('db/seed.sql is exactly the seeds joined; schema.sql then seed.sql (the phpMyAdmin route) gives the same data as the runner', async () => {
    const seedOnDisk = readFileSync(join(__dirname, '..', '..', 'db', 'seed.sql'), 'utf8');
    expect(seedOnDisk).toBe(buildSeedSql());
    const viaSql = await newDb('s1_g1');
    await viaSql.c.query("SET SESSION sql_mode = 'STRICT_TRANS_TABLES,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION'");
    await viaSql.c.query(readFileSync(join(__dirname, '..', '..', 'db', 'schema.sql'), 'utf8'));
    await viaSql.c.query(seedOnDisk);
    const ref = await newDb('s1_g2');
    await migrate(ref.c, { seeds: true });
    const counts = async (c: typeof viaSql.c) => {
      const out: Record<string, number> = {};
      for (const t of ['customers', 'settings', 'categories', 'subcategories']) out[t] = Number(((await c.query<any[]>(`SELECT COUNT(*) AS n FROM ${t}`))[0] as any[])[0].n);
      return out;
    };
    expect(await counts(viaSql.c)).toEqual(await counts(ref.c));
    expect(await counts(ref.c)).toEqual({ customers: 1, settings: 10, categories: 15, subcategories: 60 });
    await viaSql.c.end();
    await ref.c.end();
  });
});
