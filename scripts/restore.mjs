// B4 / T-R02, the database half: rebuild an EMPTY database from an export (scripts/backup.mjs) and the photo copy, then prove it equal.
// Decryption, downloading from the bucket and the throw-away Docker database are the Mac tool's job; it hands this function a Source and a PhotoStore.
//
// What it does, in order, and why:
//  1. refuses a database that already has any table (a restore must never touch live data);
//  2. checks the sha256 of every data file against the manifest BEFORE creating anything (a damaged or edited file stops here);
//  3. creates the tables from the recorded SHOW CREATE TABLE statements (foreign keys off while loading: bills.reissue_of points at another bill),
//     loads the rows in batches, puts each live photo's bytes back from the photo copy (checking its sha256), then creates the views and the triggers
//     (triggers last, so they cannot fire on the load; the DEFINER of the source account is dropped);
//  4. switches the foreign keys on and looks for orphans; exports the restored database again and compares every table's content hash with the manifest;
//     checks every restored photo against its recorded sha256 inside the database; runs the nightly check (runInvariants) on the copy.
// The report says ok only if all of that is clean. A failed restore leaves a partly filled database: drop it and start again.
import { createHash } from 'node:crypto';
import { EXCLUDED, FORMAT, exportDatabase, memoryStore, one, q, stripDefiner } from './backup.mjs';
import { runInvariants } from './invariants.mjs';

const STRICT = "STRICT_TRANS_TABLES,ERROR_FOR_DIVISION_BY_ZERO,NO_AUTO_CREATE_USER,NO_ENGINE_SUBSTITUTION";
const BATCH_BYTES = 4 * 1024 * 1024;

async function sha256OfLines(source, file) {
  const hash = createHash('sha256');
  for await (const line of source.lines(file)) hash.update(line + '\n');
  return hash.digest('hex');
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

  await conn.query(`SET SESSION sql_mode = '${STRICT}'`);
  await conn.query('SET SESSION foreign_key_checks = 0');
  const missing = [];
  const mismatched = [];
  const skippedPhotos = new Set();
  let restoredPhotos = 0;
  try {
    for (const t of manifest.tables) await conn.query(t.create);

    // design_photos first: its rows need their bytes, and sys_photo_copies rows of a skipped photo must be skipped too
    const order = [...manifest.tables].sort((a, b) => (a.name === 'design_photos' ? -1 : b.name === 'design_photos' ? 1 : 0));
    for (const t of order) {
      const isPhotos = t.name === 'design_photos';
      const cols = [...t.columns, ...(isPhotos ? [{ name: 'bytes', binary: true, raw: true }] : [])];
      const colSql = cols.map((c) => q(c.name)).join(', ');
      const cell = (c) => (c.binary && !c.raw ? 'UNHEX(?)' : '?');
      const rowSql = `(${cols.map(cell).join(', ')})`;
      let batch = [];
      let batchBytes = 0;
      const flush = async () => {
        if (batch.length === 0) return;
        await conn.query(`INSERT INTO ${q(t.name)} (${colSql}) VALUES ${batch.map(() => rowSql).join(', ')}`, batch.flat());
        batch = [];
        batchBytes = 0;
      };
      for await (const line of source.lines(t.file)) {
        const row = JSON.parse(line);
        if (t.name === 'sys_photo_copies' && skippedPhotos.has(`${row.photo_id}/${row.kind}`)) continue;
        const values = t.columns.map((c) => (row[c.name] === undefined ? null : row[c.name]));
        let size = line.length;
        if (isPhotos) {
          let bytes = null;
          if (row.removed_at === null) {
            bytes = await photos.get(row.id, row.kind);
            if (bytes === null) {
              missing.push({ id: row.id, kind: row.kind });
              skippedPhotos.add(`${row.id}/${row.kind}`);
              continue;
            }
            if (createHash('sha256').update(bytes).digest('hex').toUpperCase() !== String(row.sha256).toUpperCase() || bytes.length !== Number(row.byte_size)) {
              mismatched.push({ id: row.id, kind: row.kind });
              continue;
            }
            restoredPhotos += 1;
            size += bytes.length;
          }
          values.push(bytes);
        }
        batch.push(values);
        batchBytes += size;
        if (batch.length >= pageSize || batchBytes >= BATCH_BYTES) await flush();
      }
      await flush();
    }

    if (mismatched.length) throw new Error(`restore failed: ${mismatched.length} photo(s) in the photo copy do not match their recorded sha256: ${mismatched.slice(0, 10).map((m) => `${m.id}/${m.kind}`).join(', ')}`);
    if (missing.length && !opts.allowMissingPhotos) {
      throw new Error(`restore failed: ${missing.length} photo(s) are missing from the photo copy: ${missing.slice(0, 10).map((m) => `${m.id}/${m.kind}`).join(', ')}`);
    }
    if (missing.length) problems.push(`${missing.length} photo(s) missing from the photo copy and skipped: ${missing.map((m) => `${m.id}/${m.kind}`).join(', ')}`);

    for (const v of manifest.views) await conn.query(stripDefiner(v.create));
    for (const tr of manifest.triggers) await conn.query(stripDefiner(tr.create));
  } finally {
    await conn.query('SET SESSION foreign_key_checks = 1').catch(() => undefined);
  }

  // fresh statistics after the bulk load: the planner needs them for the checks below and for the API's first reads
  for (const t of manifest.tables) await conn.query(`ANALYZE TABLE ${q(t.name)}`);

  // ---- proof
  const orphans = await findOrphans(conn);
  for (const o of orphans) problems.push(`${o.rows} row(s) of ${o.table} point nowhere (${o.constraint})`);

  const again = memoryStore();
  const reread = await exportDatabase(conn, again.sink, { pageSize: 1000 });
  const byName = new Map(reread.tables.map((t) => [t.name, t]));
  const tables = manifest.tables.map((t) => {
    const r = byName.get(t.name);
    const hash_ok = !!r && r.sha256 === t.sha256;
    if (!hash_ok) problems.push(`table ${t.name}: restored content differs from the export (${r ? r.rows : 0} rows, expected ${t.rows})`);
    return { name: t.name, rows_expected: t.rows, rows_restored: r ? r.rows : 0, hash_ok };
  });
  for (const r of reread.tables) if (!byName.has(r.name)) problems.push(`unexpected table ${r.name}`);
  const views = reread.views.length;
  const triggers = reread.triggers.length;
  if (views !== manifest.views.length) problems.push(`${views} views restored, expected ${manifest.views.length}`);
  if (triggers !== manifest.triggers.length) problems.push(`${triggers} triggers restored, expected ${manifest.triggers.length}`);

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
    views,
    triggers,
    photos: { live_expected: manifest.live_photos, restored: restoredPhotos, missing },
    fk_orphans: orphans,
    invariants,
    problems,
    ms: Date.now() - t0,
  };
}

/** Child rows whose foreign key matches no parent row. Reads the constraints from the restored database itself. */
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
