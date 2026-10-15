// B2 of the spec: the full export of the data (WITHOUT the photo bytes) and the once-only photo copy. The database half only: reading, writing files through a sink, recording copies.
// Gzip, encryption (a fresh AES-256-GCM key per file, wrapped with the RSA public key), the upload to the bucket and the hourly tick are the API's job; they plug in through the Sink and PhotoStore below.
//
// The export is ONE consistent snapshot (REPEATABLE READ, set for the next transaction only), every table read in keyset pages, newline-delimited JSON:
// one object per row, every value text (DECIMAL and dates exactly as the server prints them, binary columns as hex, NULL as null). Nothing depends on how the connection was configured.
// The connection must not be inside a transaction (START TRANSACTION commits one that is open).
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { once } from 'node:events';

export const FORMAT = 'jewelvault-export-1';
/** Columns that travel through the photo copy instead of the export (P5, NODE-DESIGN D-Q11). */
export const EXCLUDED = { design_photos: ['bytes'] };
const BINARY_TYPES = new Set(['binary', 'varbinary', 'tinyblob', 'blob', 'mediumblob', 'longblob']);

/** The first row of a query's result. */
export async function one(conn, sql, params) {
  const [rows] = await conn.query(sql, params);
  return rows[0];
}

export const q = (id) => '`' + String(id).replace(/`/g, '``') + '`';

/** The DEFINER of a view or trigger is the account that made it; where it is restored that account may not exist. */
export function stripDefiner(sql) {
  return sql.replace(/^(CREATE\s+(?:OR\s+REPLACE\s+)?(?:ALGORITHM\s*=\s*\w+\s+)?)DEFINER\s*=\s*(?:CURRENT_USER(?:\(\))?|`(?:[^`]|``)*`@`(?:[^`]|``)*`|'[^']*'@'[^']*'|\S+)\s+/i, '$1');
}

/** Columns (generated ones left out: the server computes them), primary key and binary-ness of every base table. */
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
  let after = null;
  for (;;) {
    let where = '';
    const params = [];
    if (after) {
      const parts = meta.primary_key.map((k, i) => {
        const eq = meta.primary_key.slice(0, i).map((e) => {
          params.push(after[e]);
          return `${key(e)} = ${keyExpr(e)}`;
        });
        params.push(after[k]);
        return `(${[...eq, `${key(k)} > ${keyExpr(k)}`].join(' AND ')})`;
      });
      where = `WHERE ${parts.join(' OR ')}`;
    }
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
  await conn.query('START TRANSACTION WITH CONSISTENT SNAPSHOT');
  try {
    const info = await one(conn, "SELECT DATABASE() AS db, VERSION() AS v, DATE_FORMAT(UTC_TIMESTAMP(), '%Y-%m-%d %H:%i:%s') AS now");
    const metas = await readTableMeta(conn);
    const tables = [];
    for (const meta of metas) {
      const created = await one(conn, `SHOW CREATE TABLE ${q(meta.name)}`);
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
      tables.push({ name: meta.name, create: created['Create Table'], columns: meta.columns, primary_key: meta.primary_key, rows, file, sha256: hash.digest('hex') });
      if (opts.between) await opts.between(meta.name);
    }
    const [viewRows] = await conn.query("SELECT TABLE_NAME AS n FROM information_schema.VIEWS WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME");
    const views = [];
    for (const v of viewRows) {
      const c = await one(conn, `SHOW CREATE VIEW ${q(v.n)}`);
      views.push({ name: v.n, create: c['Create View'] });
    }
    const [trigRows] = await conn.query("SELECT TRIGGER_NAME AS n, EVENT_OBJECT_TABLE AS t FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = DATABASE() ORDER BY TRIGGER_NAME");
    const triggers = [];
    for (const t of trigRows) {
      const c = await one(conn, `SHOW CREATE TRIGGER ${q(t.n)}`);
      triggers.push({ name: t.n, table: t.t, create: c['SQL Original Statement'] });
    }
    const live = await one(conn, 'SELECT COUNT(*) AS n FROM design_photos WHERE removed_at IS NULL');
    const manifest = { format: FORMAT, created_at: info.now, server: info.v, database: info.db, excluded: EXCLUDED, tables, views, triggers, live_photos: Number(live.n) };
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

// ---------------------------------------------------------------- the once-only photo copy

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
      const { key } = await store.put(p.id, p.kind, row.bytes);
      await conn.query('INSERT INTO sys_photo_copies (photo_id, kind, sha256, object_key) VALUES (?, ?, UNHEX(?), ?) ON DUPLICATE KEY UPDATE photo_id = photo_id', [p.id, p.kind, p.sha, key]);
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
    put: async (id, kind, bytes) => {
      objects.set(`${id}/${kind}`, Buffer.from(bytes));
      return { key: `photos/${id}-${kind}` };
    },
    get: async (id, kind) => objects.get(`${id}/${kind}`) ?? null,
  };
}

export function directoryPhotos(dir) {
  const file = (id, kind) => path.join(dir, `${id}-${kind}`);
  return {
    put: async (id, kind, bytes) => {
      mkdirSync(dir, { recursive: true });
      await new Promise((resolve, reject) => {
        const s = createWriteStream(file(id, kind));
        s.on('error', reject);
        s.end(bytes, resolve);
      });
      return { key: `photos/${id}-${kind}` };
    },
    get: async (id, kind) => {
      try {
        return await readFile(file(id, kind));
      } catch (e) {
        if (e.code === 'ENOENT') return null;
        throw e;
      }
    },
  };
}
