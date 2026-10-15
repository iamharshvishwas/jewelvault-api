// B2 of the spec (draft 5): the full export of the data (WITHOUT the photo bytes) and the once-only photo copy. The database half only: reading, writing files through a sink,
// recording copies. Gzip, encryption (a fresh AES-256-GCM key per file, wrapped with the RSA public key), the upload to the bucket, the slices of about 40 seconds and the hourly tick
// are the API's job; they plug in through the Sink and PhotoStore below. The job spools every file to disk inside the snapshot, closes the snapshot, and only THEN compresses,
// encrypts and uploads, so no network call happens while a snapshot is open.
//
// The export is ONE consistent read-only snapshot (REPEATABLE READ and START TRANSACTION READ ONLY, WITH CONSISTENT SNAPSHOT, the first set for the next transaction only), every table
// read in keyset pages, newline-delimited JSON: one object per row, every value text (DECIMAL and dates exactly as the server prints them, binary columns as hex, NULL as null).
// Nothing depends on how the connection was configured. It holds NO table definitions (the migration files are the schema, B4), and it leaves out sessions, the login counters and the
// idempotency rows older than 90 days. The connection must not be inside a transaction (START TRANSACTION commits one that is open).
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, mkdirSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { once } from 'node:events';

export const FORMAT = 'jewelvault-export-1';
/** Columns that travel through the photo copy instead of the export (P5, NODE-DESIGN D-Q11). */
export const EXCLUDED = { design_photos: ['bytes'] };
/** Tables that are not exported at all, with the reason (it goes into the manifest). */
export const OMITTED = {
  schema_migrations: 'the migration files are the schema: their versions and checksums are recorded in the manifest instead',
  sessions: 'login sessions are not worth restoring: everyone signs in again',
  sys_login_attempts: 'login counters are rebuilt by use and never grow',
};
/** Tables exported in part: the condition on the alias src, and what it means. */
export const FILTERED = {
  sys_idempotency: { where: 'src.`created_at` >= UTC_TIMESTAMP(6) - INTERVAL 90 DAY', text: 'only rows younger than 90 days; older ones are expired (L6)' },
};
const BINARY_TYPES = new Set(['binary', 'varbinary', 'tinyblob', 'blob', 'mediumblob', 'longblob']);

/** The first row of a query's result. */
export async function one(conn, sql, params) {
  const [rows] = await conn.query(sql, params);
  return rows[0];
}

export const q = (id) => '`' + String(id).replace(/`/g, '``') + '`';

/** Columns (generated ones left out: the server computes them), primary key and binary-ness of every exported base table. */
export async function readTableMeta(conn) {
  const [cols] = await conn.query(
    `SELECT c.TABLE_NAME AS t, c.COLUMN_NAME AS n, c.DATA_TYPE AS ty, c.EXTRA AS ex, c.GENERATION_EXPRESSION AS ge
       FROM information_schema.COLUMNS c JOIN information_schema.TABLES x ON x.TABLE_SCHEMA = c.TABLE_SCHEMA AND x.TABLE_NAME = c.TABLE_NAME
      WHERE c.TABLE_SCHEMA = DATABASE() AND x.TABLE_TYPE = 'BASE TABLE' ORDER BY c.TABLE_NAME, c.ORDINAL_POSITION`
  );
  const [pks] = await conn.query(
    `SELECT TABLE_NAME AS t, COLUMN_NAME AS n FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND INDEX_NAME = 'PRIMARY' ORDER BY TABLE_NAME, SEQ_IN_INDEX`
  );
  const tables = new Map();
  for (const r of cols) {
    if (Object.hasOwn(OMITTED, r.t)) continue;
    if (/GENERATED/i.test(r.ex ?? '') || (r.ge !== null && r.ge !== undefined && r.ge !== '')) continue;
    if ((EXCLUDED[r.t] ?? []).includes(r.n)) continue;
    if (!tables.has(r.t)) tables.set(r.t, { name: r.t, columns: [], primary_key: [] });
    tables.get(r.t).columns.push({ name: r.n, binary: BINARY_TYPES.has(String(r.ty).toLowerCase()) });
  }
  for (const r of pks) tables.get(r.t)?.primary_key.push(r.n);
  return [...tables.values()].sort((a, b) => (a.name < b.name ? -1 : 1));
}

const selectList = (meta) => meta.columns.map((c) => `${c.binary ? `HEX(src.${q(c.name)})` : `CAST(src.${q(c.name)} AS CHAR)`} AS ${q(c.name)}`).join(', ');

/** Every row of one table, in primary-key order, by keyset pages. Yields arrays of row objects. */
export async function* tablePages(conn, meta, pageSize) {
  if (meta.primary_key.length === 0) throw new Error(`table ${meta.name} has no primary key: it cannot be read in keyset pages`);
  const binaryPk = new Set(meta.columns.filter((c) => c.binary).map((c) => c.name));
  const keyExpr = (k) => (binaryPk.has(k) ? 'UNHEX(?)' : '?');
  // Every key column is written as src.<column>. A bare name in ORDER BY would mean the SELECT-list alias of the same name (the text of the value), which sorts as text,
  // while WHERE means the column: for a UUID key the two orders differ (the UUID type has its own order), and the pages would overlap or skip rows.
  const key = (k) => `src.${q(k)}`;
  const order = meta.primary_key.map(key).join(', ');
  const filter = FILTERED[meta.name]?.where;
  let after = null;
  for (;;) {
    const params = [];
    const conditions = [];
    if (filter) conditions.push(`(${filter})`);
    if (after) {
      const parts = meta.primary_key.map((k, i) => {
        const eq = meta.primary_key.slice(0, i).map((e) => {
          params.push(after[e]);
          return `${key(e)} = ${keyExpr(e)}`;
        });
        params.push(after[k]);
        return `(${[...eq, `${key(k)} > ${keyExpr(k)}`].join(' AND ')})`;
      });
      conditions.push(`(${parts.join(' OR ')})`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    // the primary key values for the next page come back through the same text conversion, so they are compared as given
    const [rows] = await conn.query(`SELECT ${selectList(meta)} FROM ${q(meta.name)} AS src ${where} ORDER BY ${order} LIMIT ${Number(pageSize)}`, params);
    if (rows.length === 0) return;
    yield rows.map((r) => Object.fromEntries(meta.columns.map((c) => [c.name, r[c.name] === undefined ? null : r[c.name]])));
    if (rows.length < pageSize) return;
    after = rows[rows.length - 1];
  }
}

export async function exportDatabase(conn, sink, opts = {}) {
  const pageSize = opts.pageSize ?? 1000;
  await conn.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
  await conn.query('START TRANSACTION READ ONLY, WITH CONSISTENT SNAPSHOT');
  try {
    const info = await one(conn, "SELECT DATABASE() AS db, VERSION() AS v, DATE_FORMAT(UTC_TIMESTAMP(), '%Y-%m-%d %H:%i:%s') AS now");
    const metas = await readTableMeta(conn);
    const tables = [];
    for (const meta of metas) {
      const file = `data/${meta.name}.ndjson`;
      const out = sink.file(file);
      const hash = createHash('sha256');
      let rows = 0;
      for await (const page of tablePages(conn, meta, pageSize)) {
        const text = page.map((r) => JSON.stringify(r) + '\n').join('');
        hash.update(text);
        await out.write(text);
        rows += page.length;
      }
      await out.close();
      tables.push({ name: meta.name, columns: meta.columns, primary_key: meta.primary_key, rows, file, sha256: hash.digest('hex') });
      if (opts.between) await opts.between(meta.name);
    }
    const [mig] = await conn.query("SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'schema_migrations'");
    const migrations = mig.length ? (await conn.query('SELECT version, name, checksum FROM schema_migrations ORDER BY version'))[0].map((r) => ({ version: r.version, name: r.name, checksum: r.checksum })) : [];
    const triggers = await one(conn, 'SELECT COUNT(*) AS n FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = DATABASE()');
    const live = await one(conn, 'SELECT COUNT(*) AS n FROM design_photos WHERE removed_at IS NULL');
    const manifest = {
      format: FORMAT,
      created_at: info.now,
      server: info.v,
      database: info.db,
      migrations,
      excluded: EXCLUDED,
      omitted: OMITTED,
      filtered: Object.fromEntries(Object.entries(FILTERED).map(([t, f]) => [t, f.text])),
      tables,
      live_photos: Number(live.n),
      has_triggers: Number(triggers.n) > 0,
    };
    const m = sink.file('manifest.json');
    await m.write(JSON.stringify(manifest, null, 2));
    await m.close();
    await conn.query('COMMIT');
    return manifest;
  } catch (e) {
    await conn.query('ROLLBACK').catch(() => undefined);
    throw e;
  }
}

// ---------------------------------------------------------------- the once-only photo copy (D25)

export async function copyPhotosOnce(conn, store, opts = {}) {
  const limit = Number.isInteger(opts.limit) && opts.limit > 0 ? opts.limit : 1_000_000;
  const [todo] = await conn.query(
    `SELECT d.id AS id, d.kind AS kind, HEX(d.sha256) AS sha, d.byte_size AS size
       FROM design_photos d LEFT JOIN sys_photo_copies p ON p.photo_id = d.id AND p.kind = d.kind
      WHERE d.removed_at IS NULL AND p.photo_id IS NULL ORDER BY d.created_at, d.id, d.kind LIMIT ${limit}`
  );
  const result = { copied: 0, bytes: 0, failed: [] };
  for (const p of todo) {
    try {
      const row = await one(conn, 'SELECT bytes FROM design_photos WHERE id = ? AND kind = ? AND removed_at IS NULL', [p.id, p.kind]);
      if (!row || !row.bytes) throw new Error('the photo was removed while the copy ran');
      const actual = createHash('sha256').update(row.bytes).digest('hex').toUpperCase();
      if (actual !== p.sha.toUpperCase() || row.bytes.length !== Number(p.size)) throw new Error('the stored bytes do not match the recorded sha256 and size');
      await store.put(p.id, p.kind, row.bytes);
      // a copy is remembered only after the bucket confirms the stored size (a HEAD request)
      const head = await store.head(p.id, p.kind);
      if (!head) throw new Error('the object is not in the bucket after the upload');
      if (Number(head.size) !== row.bytes.length) throw new Error(`the bucket holds ${head.size} bytes, the photo has ${row.bytes.length}: size mismatch`);
      await conn.query('INSERT INTO sys_photo_copies (photo_id, kind, sha256, size) VALUES (?, ?, UNHEX(?), ?) ON DUPLICATE KEY UPDATE photo_id = photo_id', [p.id, p.kind, p.sha, row.bytes.length]);
      result.copied += 1;
      result.bytes += row.bytes.length;
    } catch (e) {
      result.failed.push({ id: p.id, kind: p.kind, error: e.message });
    }
  }
  return result;
}

// ---------------------------------------------------------------- stores (memory for tests, a folder for the job and the Mac tool)

export function memoryStore() {
  const files = new Map();
  return {
    files,
    sink: {
      file(p) {
        const parts = [];
        return {
          write: async (chunk) => void parts.push(chunk),
          close: async () => void files.set(p, parts.join('')),
        };
      },
    },
    source: {
      text: async (p) => {
        if (!files.has(p)) throw new Error(`export file not found: ${p}`);
        return files.get(p);
      },
      async *lines(p) {
        if (!files.has(p)) throw new Error(`export file not found: ${p}`);
        const text = files.get(p);
        if (text === '') return;
        for (const line of text.replace(/\n$/, '').split('\n')) yield line;
      },
    },
  };
}

export function directoryStore(dir) {
  return {
    sink: {
      file(p) {
        const full = path.join(dir, p);
        mkdirSync(path.dirname(full), { recursive: true });
        const stream = createWriteStream(full);
        return {
          write: async (chunk) => {
            if (!stream.write(chunk)) await once(stream, 'drain');
          },
          close: () => new Promise((resolve, reject) => {
            stream.on('error', reject);
            stream.end(resolve);
          }),
        };
      },
    },
    source: {
      text: (p) => readFile(path.join(dir, p), 'utf8'),
      async *lines(p) {
        const rl = readline.createInterface({ input: createReadStream(path.join(dir, p), { encoding: 'utf8' }), crlfDelay: Infinity });
        for await (const line of rl) yield line;
      },
    },
  };
}

export function memoryPhotos() {
  const objects = new Map();
  return {
    objects,
    put: async (id, kind, bytes) => void objects.set(`${id}/${kind}`, Buffer.from(bytes)),
    head: async (id, kind) => (objects.has(`${id}/${kind}`) ? { size: objects.get(`${id}/${kind}`).length } : null),
    get: async (id, kind) => objects.get(`${id}/${kind}`) ?? null,
  };
}

export function directoryPhotos(dir) {
  const file = (id, kind) => path.join(dir, `${id}-${kind}`);
  const missing = (e) => {
    if (e.code === 'ENOENT') return null;
    throw e;
  };
  return {
    put: async (id, kind, bytes) => {
      mkdirSync(dir, { recursive: true });
      await new Promise((resolve, reject) => {
        const s = createWriteStream(file(id, kind));
        s.on('error', reject);
        s.end(bytes, resolve);
      });
    },
    head: async (id, kind) => stat(file(id, kind)).then((s) => ({ size: s.size }), missing),
    get: async (id, kind) => readFile(file(id, kind)).catch(missing),
  };
}
