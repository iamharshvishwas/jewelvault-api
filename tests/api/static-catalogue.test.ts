import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Connection } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Scratch, scratchDatabase } from '../helpers';
import { checkSql } from '../../scripts/migrate.mjs';
import { type CatalogueFacts, DECIMAL_COLUMNS, NAMED_CHECKS, POLLED_TABLES, UNIQUE_KEYS, catalogueProblems, readCatalogue } from './static-catalogue-lib';
import { REPO } from './support';

// T-D11, part 1 (A7, D19, S3, S4, S9): the catalogue test. A table has a primary key, InnoDB and the collation utf8mb4_unicode_ci; money, rates and weights are DECIMAL and no FLOAT, DOUBLE or REAL
// column exists; every foreign key is RESTRICT; the named CHECKs of D8, D13 and S4 exist; the UNIQUE keys are exactly the expected list of D19; every polled table has its (updated_at, key) index;
// and every migration file holds only statements of the allowed list of S9. Each rule is shown failing on a planted violation (a table made in a scratch schema) and passing once it is removed.
//
// The schema is the one `db/migrations` makes, applied as the ten-box user to a scratch database of the lane.

let scratch: Scratch;
let user: Connection; // the ten-box user: it can create and alter, and cannot drop
let root: Connection; // root removes what a control planted
let real: CatalogueFacts;

const SQL = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci';
const problems = async () => catalogueProblems(await readCatalogue(user));
const named = (all: string[], text: string) => all.filter((p) => p.includes(text));
const plant = async (ddl: string, table: string, body: () => Promise<void>) => {
  await user.query(ddl);
  try {
    await body();
  } finally {
    await root.query(`DROP TABLE IF EXISTS \`${scratch.database}\`.\`${table}\``);
  }
};

beforeAll(async () => {
  scratch = await scratchDatabase('catalog', { schema: true });
  user = await scratch.connect();
  root = await scratch.root();
  real = await readCatalogue(user);
}, 120_000);
afterAll(async () => {
  await user?.end().catch(() => undefined);
  await root?.end().catch(() => undefined);
  await scratch?.drop();
});

describe('T-D11 the catalogue of the schema (A7, D19, S3, S4)', () => {
  it('the schema that db/migrations makes passes every rule: no problem at all', async () => {
    expect(await problems()).toEqual([]);
    expect(real.tables.length).toBeGreaterThanOrEqual(25); // 25 tables and schema_migrations
  });

  it('every table has a primary key, the InnoDB engine and the collation utf8mb4_unicode_ci', () => {
    for (const t of real.tables) {
      expect(real.primaryKeys.has(t.name), `${t.name} primary key`).toBe(true);
      expect(t.engine, `${t.name} engine`).toBe('InnoDB');
      expect(t.collation, `${t.name} collation`).toBe('utf8mb4_unicode_ci');
    }
  });

  it('no FLOAT, DOUBLE or REAL column exists; money, rates, weights and percentages are the exact DECIMAL types of S3', () => {
    expect(real.columns.filter((c) => ['float', 'double', 'real'].includes(c.dataType))).toEqual([]);
    // every DECIMAL column of the schema is named in DECIMAL_COLUMNS with its exact type, and every name there is a column: a new money column has to be written into the list
    const decimals = real.columns.filter((c) => c.dataType === 'decimal').map((c) => `${c.table}.${c.name}`);
    expect(decimals.sort()).toEqual(Object.keys(DECIMAL_COLUMNS).sort());
  });

  it('every foreign key is RESTRICT on update and on delete', () => {
    expect(real.foreignKeys.length).toBeGreaterThanOrEqual(18);
    for (const fk of real.foreignKeys) expect([fk.update, fk.delete], fk.name).toEqual(['RESTRICT', 'RESTRICT']);
  });

  it('the named CHECKs of D8 (piece status), D13 (receipts) and S4 (caps) all exist', () => {
    expect(NAMED_CHECKS.length).toBeGreaterThanOrEqual(28);
    expect(NAMED_CHECKS.filter((n) => !real.checks.has(n))).toEqual([]);
  });

  it('the UNIQUE keys are exactly the expected list: the immutable columns and the composite keys of D19 (19 of them)', () => {
    const actual = real.indexes.filter((i) => i.unique && i.name !== 'PRIMARY').map((i) => `${i.table}.${i.name}(${i.columns.join(',')})`).sort();
    expect(actual).toEqual([...UNIQUE_KEYS].sort());
    expect(UNIQUE_KEYS).toHaveLength(19);
  });

  it('every polled table has an index on (updated_at, its primary key): 13 tables', () => {
    expect(POLLED_TABLES).toHaveLength(13);
    for (const t of POLLED_TABLES) {
      const want = ['updated_at', ...(real.primaryKeys.get(t) ?? [])].join(',');
      expect(real.indexes.some((i) => i.table === t && i.columns.join(',') === want), t).toBe(true);
    }
  });
});

describe('T-D11 each catalogue rule fails on a planted violation and passes when it is removed', () => {
  it('a table without a primary key', async () => {
    await plant(`CREATE TABLE zz_no_pk (a INT NOT NULL) ${SQL}`, 'zz_no_pk', async () => {
      expect(named(await problems(), 'zz_no_pk')).toEqual(['zz_no_pk: no primary key']);
    });
    expect(await problems()).toEqual([]);
  });

  it('a table that is not InnoDB', async () => {
    await plant('CREATE TABLE zz_myisam (id INT NOT NULL PRIMARY KEY) ENGINE=MyISAM DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci', 'zz_myisam', async () => {
      expect(named(await problems(), 'zz_myisam')).toEqual(['zz_myisam: engine is MyISAM, not InnoDB']);
    });
    expect(await problems()).toEqual([]);
  });

  it('a table with another collation', async () => {
    await plant('CREATE TABLE zz_collation (id INT NOT NULL PRIMARY KEY) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci', 'zz_collation', async () => {
      expect(named(await problems(), 'zz_collation')).toEqual(['zz_collation: collation is utf8mb4_general_ci, not utf8mb4_unicode_ci']);
    });
    expect(await problems()).toEqual([]);
  });

  it('a FLOAT or DOUBLE column, and a money-looking number column that is not DECIMAL', async () => {
    await plant(`CREATE TABLE zz_float (id INT NOT NULL PRIMARY KEY, ratio FLOAT NULL, wide DOUBLE NULL, amount_paid INT NULL) ${SQL}`, 'zz_float', async () => {
      const found = named(await problems(), 'zz_float');
      expect(found.some((p) => p.startsWith('zz_float.ratio: float'))).toBe(true);
      expect(found.some((p) => p.startsWith('zz_float.wide: double'))).toBe(true);
      expect(found.some((p) => p.startsWith('zz_float.amount_paid: int(11) has a money-like name'))).toBe(true);
    });
    expect(await problems()).toEqual([]);
  });

  it('a money column of the wrong type', async () => {
    // the decimal columns are named with their exact type: a narrower or looser one is a finding
    const facts = await readCatalogue(user);
    const bent = { ...facts, columns: facts.columns.map((c) => (c.table === 'receipts' && c.name === 'amount' ? { ...c, columnType: 'decimal(10,2)' } : c)) };
    expect(catalogueProblems(bent)).toEqual(['receipts.amount: decimal(10,2), expected decimal(14,2) (money, rates and weights are DECIMAL, S3)']);
    expect(catalogueProblems(facts)).toEqual([]);
  });

  it('a foreign key that is not RESTRICT', async () => {
    await plant(`CREATE TABLE zz_fk (id INT NOT NULL PRIMARY KEY, category_id UUID NULL, CONSTRAINT zz_fk_cat FOREIGN KEY (category_id) REFERENCES categories (id) ON DELETE CASCADE) ${SQL}`, 'zz_fk', async () => {
      expect(named(await problems(), 'zz_fk')).toEqual(['zz_fk.zz_fk_cat: ON UPDATE RESTRICT ON DELETE CASCADE; every foreign key is RESTRICT (D19, S7)']);
    });
    expect(await problems()).toEqual([]);
  });

  it('a named CHECK that is missing (the piece-status CHECK of D8)', async () => {
    const [[row]] = await root.query<any[]>("SELECT CHECK_CLAUSE AS c FROM information_schema.CHECK_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = ? AND TABLE_NAME = 'skus' AND CONSTRAINT_NAME = 'chk_skus_sold'", [scratch.database]);
    await user.query('ALTER TABLE skus DROP CONSTRAINT chk_skus_sold');
    try {
      expect(await problems()).toEqual(['skus.chk_skus_sold: the named CHECK is missing (D8, D13, S4)']);
    } finally {
      await user.query(`ALTER TABLE skus ADD CONSTRAINT chk_skus_sold CHECK (${row.c})`); // put back exactly what was there
    }
    expect(await problems()).toEqual([]);
  });

  it('a UNIQUE key that is not on the expected list, and one of the list that is missing', async () => {
    await plant(`CREATE TABLE zz_unique (id INT NOT NULL PRIMARY KEY, code VARCHAR(20) NOT NULL, UNIQUE KEY uq_zz_code (code)) ${SQL}`, 'zz_unique', async () => {
      expect(named(await problems(), 'zz_unique')).toEqual(['zz_unique.uq_zz_code(code): a UNIQUE key that is not on the expected list (D19)']);
    });
    expect(await problems()).toEqual([]);
    const facts = await readCatalogue(user);
    const without = { ...facts, indexes: facts.indexes.filter((i) => i.name !== 'uq_designs_no') };
    expect(catalogueProblems(without)).toEqual(['designs.uq_designs_no(design_no): a UNIQUE key of the expected list is missing (D19)']);
  });

  it('a polled table without its (updated_at, key) index, and a key without the index D19 asks for', async () => {
    const facts = await readCatalogue(user);
    const without = { ...facts, indexes: facts.indexes.filter((i) => i.name !== 'ix_skus_updated' && i.name !== 'ix_skus_status') };
    const found = catalogueProblems(without);
    expect(found).toContain('skus: no index on (updated_at, id) for the poll (C4, D19)');
    expect(found).toContain('skus: no index starting with (status) (D19)');
  });
});

describe('T-D11 every migration file holds only statements of the allowed list of S9', () => {
  const dirs: [string, 'migration' | 'seed' | 'trigger'][] = [
    ['migrations', 'migration'],
    ['seeds', 'seed'],
    ['optional', 'trigger'],
  ];

  it.each(dirs)('db/%s: no statement outside the list, no executable comment', (dir, kind) => {
    const files = readdirSync(join(REPO, 'db', dir)).filter((f) => f.endsWith('.sql'));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) expect(checkSql(readFileSync(join(REPO, 'db', dir, f), 'utf8'), kind), `${dir}/${f}`).toEqual([]);
  });

  it('control: a planted DELETE, DROP, REPLACE, a view, an UPDATE and a CREATE TABLE without IF NOT EXISTS are each found; the file without them passes', () => {
    const good = 'CREATE TABLE IF NOT EXISTS a (id INT PRIMARY KEY);\nALTER TABLE a ADD COLUMN IF NOT EXISTS b INT NULL;\nINSERT IGNORE INTO a (id) VALUES (1);';
    expect(checkSql(good, 'migration')).toEqual([]);
    for (const bad of ['DELETE FROM a', 'DROP TABLE IF EXISTS a', 'REPLACE INTO a VALUES (1)', 'CREATE VIEW v AS SELECT 1', 'UPDATE a SET b = 1', 'CREATE TABLE a (id INT PRIMARY KEY)', 'TRUNCATE TABLE a', 'ALTER TABLE a DROP COLUMN b']) {
      const found = checkSql(`${good}\n${bad};`, 'migration');
      expect(found, bad).toHaveLength(1);
      expect(found[0].statement).toContain(bad.slice(0, 12));
    }
  });
});
