// B4 / T-R02 (draft 5), the database half: rebuild an EMPTY database from an export (scripts/backup.mjs) and the photo copy, then prove it equal.
// Decryption, downloading from the bucket and the throw-away Docker database are the Mac tool's job; it hands this function a Source and a PhotoStore.
//
// The order of B4, and why:
//  0. refuse a database that already has any table or view (a restore must never touch live data), refuse an export in another format, check the sha256 of EVERY data file against the
//     manifest and the migration files against the ones the export was made with: all before anything is created;
//  1. apply the migration files (without the trigger files) as the restricted user of A3, so that schema_migrations agrees with the repository: the export holds no table definitions;
//  2. load the data in FOREIGN-KEY order, parents before children, the order derived from the foreign keys the migrations made (the keys stay ON; a table that points at itself,
//     bills.reissue_of, is loaded in waves, the replaced bill first);
//  3. insert each live design_photos row TOGETHER with its bytes from the photo copy (size and sha256 checked): the export has no bytes and the CHECK of D26 refuses a live row without
//     them. A photo that is missing or does not match is inserted as a TOMBSTONE (removed_at = the restore time) and listed; the owner decides about each one;
//  4. tombstones are restored as they are;
//  5. the trigger files last (when the source had triggers), so that loading writes no audit rows of its own;
//  6. ANALYZE, a foreign-key check, the export read again and every table's content hash compared with the manifest (so the row counts too), every restored photo checked against its
//     sha256 inside the database, and the nightly check run on the copy.
// The report says ok only if all of that is clean and no photo had to be tombstoned. A failed restore leaves a partly filled database: drop it and start again.
import { createHash } from 'node:crypto';
import { FORMAT, exportDatabase, memoryStore, one, q } from './backup.mjs';
import { runInvariants } from './invariants.mjs';
import { listMigrations, migrate } from './migrate.mjs';

const BATCH_BYTES = 4 * 1024 * 1024;

async function sha256OfLines(source, file) {
  const hash = createHash('sha256');
  for await (const line of source.lines(file)) hash.update(line + '\n');
  return hash.digest('hex');
}

/** Tables in an order where every table comes after the tables it points at (self-references aside). Ties by name. */
function loadOrder(names, fks) {
  const deps = new Map(names.map((n) => [n, new Set()]));
  for (const f of fks) if (f.t !== f.r && deps.has(f.t) && deps.has(f.r)) deps.get(f.t).add(f.r);
  const order = [];
  const done = new Set();
  while (order.length < names.length) {
    const ready = names.filter((n) => !done.has(n) && [...deps.get(n)].every((d) => done.has(d)));
    if (ready.length === 0) throw new Error(`the foreign keys form a cycle between tables: ${names.filter((n) => !done.has(n)).join(', ')}`);
    for (const n of ready) {
      order.push(n);
      done.add(n);
    }
  }
  return order;
}

export async function restoreDatabase(conn, source, photos, opts = {}) {
  const t0 = Date.now();
  const pageSize = opts.pageSize ?? 500;
  const problems = [];
  const manifest = JSON.parse(await source.text('manifest.json'));
  if (manifest.format !== FORMAT) throw new Error(`restore refused: unknown export format ${JSON.stringify(manifest.format)}, expected ${FORMAT}`);

  const existing = await one(conn, 'SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()');
  if (Number(existing.n) > 0) throw new Error(`restore refused: the database is not empty (${existing.n} tables or views); a restore only goes into an empty database`);

  for (const t of manifest.tables) {
    const actual = await sha256OfLines(source, t.file);
    if (actual !== t.sha256) throw new Error(`restore refused: the file of table ${t.name} (${t.file}) does not match the hash in the manifest; it was changed or damaged after the export`);
  }

  const repo = listMigrations(opts.migrationsDir);
  const wanted = manifest.migrations ?? [];
  for (let i = 0; i < Math.max(repo.length, wanted.length); i++) {
    const a = repo[i];
    const b = wanted[i];
    if (!a || !b || a.version !== b.version || a.checksum !== b.checksum) {
      throw new Error(`restore refused: the migration files here are not the ones the export was made with (migration ${(b ?? a).version}${b ? '' : ' is not in the export'}${a ? '' : ' is missing here'}); the files are the schema, use the repository state of the export`);
    }
  }

  // ---- 1. the schema, from the migration files (no seeds: the data is the export's; no trigger files yet)
  await migrate(conn, { dir: opts.migrationsDir, seeds: false, optional: false });

  // ---- 2 to 4. the data
  const [fkRows] = await conn.query(
    `SELECT TABLE_NAME AS t, REFERENCED_TABLE_NAME AS r, COLUMN_NAME AS c, REFERENCED_COLUMN_NAME AS rc
       FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = DATABASE() AND REFERENCED_TABLE_NAME IS NOT NULL`
  );
  const names = manifest.tables.map((t) => t.name);
  const byName = new Map(manifest.tables.map((t) => [t.name, t]));
  const restoreTime = (await one(conn, "SELECT DATE_FORMAT(UTC_TIMESTAMP(6), '%Y-%m-%d %H:%i:%s.%f') AS t")).t;
  const tombstoned = [];
  let restoredPhotos = 0;

  for (const name of loadOrder(names, fkRows)) {
    const t = byName.get(name);
    const isPhotos = name === 'design_photos';
    const cols = [...t.columns, ...(isPhotos ? [{ name: 'bytes', binary: true, raw: true }] : [])];
    const colSql = cols.map((c) => q(c.name)).join(', ');
    const rowSql = `(${cols.map((c) => (c.binary && !c.raw ? 'UNHEX(?)' : '?')).join(', ')})`;
    let batch = [];
    let batchBytes = 0;
    const flush = async () => {
      if (batch.length === 0) return;
      await conn.query(`INSERT INTO ${q(name)} (${colSql}) VALUES ${batch.map(() => rowSql).join(', ')}`, batch.flat());
      batch = [];
      batchBytes = 0;
    };
    const add = async (row, size) => {
      let values = t.columns.map((c) => (row[c.name] === undefined ? null : row[c.name]));
      if (isPhotos) {
        let bytes = null;
        if (row.removed_at === null) {
          // a live photo: its bytes come from the photo copy, checked, or the row becomes a tombstone
          const got = await photos.get(row.id, row.kind);
          let reason = null;
          if (got === null) reason = 'missing';
          else if (got.length !== Number(row.byte_size)) reason = 'size';
          else if (createHash('sha256').update(got).digest('hex').toUpperCase() !== String(row.sha256).toUpperCase()) reason = 'sha256';
          if (reason) {
            tombstoned.push({ id: row.id, kind: row.kind, reason });
            values = t.columns.map((c) => (c.name === 'removed_at' ? restoreTime : row[c.name] === undefined ? null : row[c.name]));
          } else {
            bytes = got;
            restoredPhotos += 1;
            size += got.length;
          }
        }
        values.push(bytes);
      }
      batch.push(values);
      batchBytes += size;
      if (batch.length >= pageSize || batchBytes >= BATCH_BYTES) await flush();
    };
    const selfKey = fkRows.find((f) => f.t === name && f.r === name);
    if (selfKey) {
      // a table that points at itself: the replaced row must exist before the row that replaces it
      let pending = [];
      for await (const line of source.lines(t.file)) pending.push(JSON.parse(line));
      const loaded = new Set();
      while (pending.length) {
        const ready = pending.filter((r) => r[selfKey.c] === null || loaded.has(r[selfKey.c]));
        if (ready.length === 0) throw new Error(`restore failed: ${pending.length} row(s) of ${name} point at a ${selfKey.c} that is not in the export`);
        const rest = pending.filter((r) => !(r[selfKey.c] === null || loaded.has(r[selfKey.c])));
        for (const r of ready) {
          await add(r, 200);
          loaded.add(r[selfKey.rc]);
        }
        await flush(); // the parents are in before the next wave points at them
        pending = rest;
      }
    } else {
      for await (const line of source.lines(t.file)) await add(JSON.parse(line), line.length);
    }
    await flush();
  }
  for (const p of tombstoned) {
    problems.push(`photo ${p.id}/${p.kind}: ${p.reason === 'missing' ? 'not in the photo copy' : p.reason === 'size' ? 'its size in the photo copy is not the recorded one' : 'its sha256 in the photo copy is not the recorded one'}; it was restored as a tombstone (the owner decides)`);
  }

  // ---- 5. triggers last
  let triggerCount = 0;
  if (manifest.has_triggers && opts.triggers !== false) {
    await migrate(conn, { dir: opts.migrationsDir, seeds: false, optional: true });
    triggerCount = Number((await one(conn, 'SELECT COUNT(*) AS n FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = DATABASE()')).n);
  }

  // ---- 6. proof
  for (const n of names) await conn.query(`ANALYZE TABLE ${q(n)}`); // fresh statistics for the checks below and for the API's first reads
  const orphans = await findOrphans(conn);
  for (const o of orphans) problems.push(`${o.rows} row(s) of ${o.table} point nowhere (${o.constraint})`);

  const again = memoryStore();
  const reread = await exportDatabase(conn, again.sink, { pageSize: 1000 });
  const reByName = new Map(reread.tables.map((t) => [t.name, t]));
  const tables = manifest.tables.map((t) => {
    const r = reByName.get(t.name);
    const hash_ok = !!r && r.sha256 === t.sha256;
    // the photos that became tombstones already have their own lines above
    if (!hash_ok && !(t.name === 'design_photos' && tombstoned.length)) problems.push(`table ${t.name}: restored content differs from the export (${r ? r.rows : 0} rows, expected ${t.rows})`);
    return { name: t.name, rows_expected: t.rows, rows_restored: r ? r.rows : 0, hash_ok };
  });
  for (const r of reread.tables) if (!byName.has(r.name)) problems.push(`unexpected table ${r.name}`);

  const badBytes = await one(conn, 'SELECT COUNT(*) AS n FROM design_photos WHERE bytes IS NOT NULL AND UNHEX(SHA2(bytes, 256)) <> sha256');
  if (Number(badBytes.n) > 0) problems.push(`${badBytes.n} restored photo(s) do not match their sha256 inside the database`);
  const live = await one(conn, 'SELECT COUNT(*) AS n FROM design_photos WHERE removed_at IS NULL AND bytes IS NOT NULL');
  if (Number(live.n) !== restoredPhotos) problems.push(`${live.n} live photos in the database, ${restoredPhotos} loaded`);

  let invariants = null;
  if (!opts.skipInvariants) {
    const r = await runInvariants(conn);
    invariants = { ok: r.ok, counts: r.counts };
    if (!r.ok) problems.push(`the nightly check fails on the restored copy: ${r.rows.slice(0, 5).map((x) => `${x.invariant} ${x.row_ref}`).join('; ')}`);
  }

  return {
    ok: problems.length === 0,
    tables,
    triggers: triggerCount,
    photos: { live_expected: manifest.live_photos, restored: restoredPhotos, tombstoned },
    fk_orphans: orphans,
    invariants,
    problems,
    ms: Date.now() - t0,
  };
}

/** Child rows whose foreign key matches no parent row (the keys are ON, so this should never find any; it is the belt to the braces). */
async function findOrphans(conn) {
  const [fks] = await conn.query(
    `SELECT CONSTRAINT_NAME AS c, TABLE_NAME AS t, COLUMN_NAME AS col, REFERENCED_TABLE_NAME AS rt, REFERENCED_COLUMN_NAME AS rcol
       FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = DATABASE() AND REFERENCED_TABLE_NAME IS NOT NULL ORDER BY CONSTRAINT_NAME, TABLE_NAME, ORDINAL_POSITION`
  );
  const groups = new Map();
  for (const r of fks) {
    const key = `${r.t}.${r.c}`;
    if (!groups.has(key)) groups.set(key, { constraint: r.c, table: r.t, ref: r.rt, pairs: [] });
    groups.get(key).pairs.push([r.col, r.rcol]);
  }
  const found = [];
  for (const g of groups.values()) {
    const join = g.pairs.map(([c, p]) => `p.${q(p)} = c.${q(c)}`).join(' AND ');
    const notNull = g.pairs.map(([c]) => `c.${q(c)} IS NOT NULL`).join(' AND ');
    const row = await one(conn, `SELECT COUNT(*) AS n FROM ${q(g.table)} c LEFT JOIN ${q(g.ref)} p ON ${join} WHERE ${notNull} AND p.${q(g.pairs[0][1])} IS NULL`);
    if (Number(row.n) > 0) found.push({ constraint: g.constraint, table: g.table, rows: Number(row.n) });
  }
  return found;
}

