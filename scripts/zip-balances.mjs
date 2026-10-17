#!/usr/bin/env node
// B3 / T-R05 (drill): "each customer's balance (outstanding, advance, fine_outstanding) is rebuilt from the zip alone and compared with customer_balances". The owner's "Download everything"
// zip (built in the browser, WEB12b) is the copy of the books that survives the loss of the Hostinger account; this proves it is enough: every customer's figures come out of
// the CSV files alone, in whole paise and milligrams (no float anywhere), by the rules of V2 (db/queries/V2_customer_balances.sql):
//   billed          sum of grand_total of the ACTIVE bills (opening bills included)         fine_billed     sum of fine_weight_due of the active bills
//   received        sum of amount of the active receipts of kind money                        fine_received   sum of fine_grams of the active receipts of kind fine_silver or fine_cash
//   refunded        sum of amount of the active receipts of kind refund
//   allocated       sum of amount of the LIVE allocations (released_at empty, receipt active)  fine_allocated  the same for fine_grams
//   outstanding = billed - allocated    advance = received - allocated - refunded    balance = billed - received + refunded
//   fine_outstanding = fine_billed - fine_allocated    fine_advance = fine_received - fine_allocated
// What the zip must hold (the contract with WEB12b): customers.csv, bills.csv, receipts.csv and receipt_allocations.csv (or allocations.csv), each with a header row of the DATABASE column names
// (id; customer_id, status, doc_type, grand_total, fine_weight_due; id, customer_id, status, kind, amount, fine_grams; receipt_id, customer_id, amount, fine_grams, released_at), and MANIFEST.csv
// with the columns file and rows. A zip with other headers is refused with the name of the missing column.
//   node scripts/zip-balances.mjs --zip download.zip      (the database: DB_HOST DB_PORT DB_NAME DB_USER DB_PASSWORD in the environment; it only reads)
// Exit code: 0 all agree, 1 a difference or a zip that cannot be read, 2 the command line or the settings are wrong.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, inflateRawSync } from 'node:zlib';
import mysql from 'mysql2/promise';
import { createPacer, pacedConnect } from './pacing.mjs';
import { loadQueries } from './queries.mjs';

// ---------------------------------------------------------------- CSV

/** RFC 4180: quotes, commas and line breaks inside quotes, doubled quotes, CRLF or LF, a leading byte-order mark. Blank lines are skipped. */
export function parseCsv(text) {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  let sawAny = false;
  const endCell = () => {
    row.push(cell);
    cell = '';
  };
  const endRow = () => {
    endCell();
    if (!(row.length === 1 && row[0] === '' && !sawAny)) rows.push(row);
    row = [];
    sawAny = false;
  };
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"' && cell === '') {
      quoted = true;
      sawAny = true;
    } else if (ch === ',') {
      sawAny = true;
      endCell();
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i += 1;
      endRow();
    } else {
      sawAny = true;
      cell += ch;
    }
  }
  if (quoted) throw new Error('the CSV has an unterminated quote');
  if (cell !== '' || row.length > 0 || sawAny) endRow();
  const [header = [], ...rest] = rows;
  return { header, rows: rest };
}

// ---------------------------------------------------------------- zip

/** The files of a zip (stored or deflated) by name, read through the central directory (so a zip written with data descriptors works too). */
export function readZip(zip) {
  const buf = Buffer.isBuffer(zip) ? zip : Buffer.from(zip);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('this is not a zip file (no end-of-directory record)');
  const count = buf.readUInt16LE(eocd + 10);
  let pos = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || pos === 0xffffffff) throw new Error('zip64 files are not supported');
  const files = new Map();
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(pos) !== 0x02014b50) throw new Error('the zip directory is damaged');
    const flags = buf.readUInt16LE(pos + 8);
    const method = buf.readUInt16LE(pos + 10);
    const crc = buf.readUInt32LE(pos + 16);
    const compSize = buf.readUInt32LE(pos + 20);
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const local = buf.readUInt32LE(pos + 42);
    const name = buf.subarray(pos + 46, pos + 46 + nameLen).toString('utf8');
    pos += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;
    if (flags & 1) throw new Error(`${name} in the zip is encrypted`);
    if (buf.readUInt32LE(local) !== 0x04034b50) throw new Error(`the zip is damaged at ${name}`);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const body = buf.subarray(start, start + compSize);
    let data;
    if (method === 0) data = body;
    else if (method === 8) data = inflateRawSync(body);
    else throw new Error(`${name} in the zip uses compression method ${method}, which is not supported`);
    if (crc32(data) !== crc) throw new Error(`${name} in the zip is damaged (its checksum does not match)`);
    files.set(name, data);
  }
  return files;
}

// ---------------------------------------------------------------- exact decimals

const SCALE = { money: 2, grams: 3 };

function toUnits(text, scale, where) {
  const s = String(text ?? '').trim();
  if (s === '') return 0n;
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) throw new Error(`${where}: ${JSON.stringify(s)} is not a number`);
  const frac = m[3] ?? '';
  if (frac.length > scale && /[1-9]/.test(frac.slice(scale))) throw new Error(`${where}: ${s} has more than ${scale} decimals`);
  const units = BigInt(m[2] + frac.slice(0, scale).padEnd(scale, '0'));
  return m[1] === '-' ? -units : units;
}

function fromUnits(units, scale) {
  const neg = units < 0n;
  const abs = (neg ? -units : units).toString().padStart(scale + 1, '0');
  return `${neg ? '-' : ''}${abs.slice(0, -scale)}.${abs.slice(-scale)}`;
}

// ---------------------------------------------------------------- the balances

const REQUIRED = {
  customers: { files: ['customers.csv'], columns: ['id'] },
  bills: { files: ['bills.csv'], columns: ['customer_id', 'status', 'doc_type', 'grand_total', 'fine_weight_due'] },
  receipts: { files: ['receipts.csv'], columns: ['id', 'customer_id', 'status', 'kind', 'amount', 'fine_grams'] },
  allocations: { files: ['receipt_allocations.csv', 'allocations.csv'], columns: ['receipt_id', 'customer_id', 'amount', 'fine_grams', 'released_at'] },
};

export function balancesFromZip(zip) {
  const entries = readZip(typeof zip === 'string' ? readFileSync(zip) : zip);
  const byBase = new Map();
  for (const [name, data] of entries) if (!byBase.has(path.posix.basename(name))) byBase.set(path.posix.basename(name), data);
  const load = (key) => {
    const spec = REQUIRED[key];
    const file = spec.files.find((f) => byBase.has(f));
    if (!file) throw new Error(`${spec.files[0]} is not in the zip (the files in it: ${[...byBase.keys()].join(', ') || 'none'})`);
    const csv = parseCsv(byBase.get(file).toString('utf8'));
    const idx = {};
    for (const col of spec.columns) {
      idx[col] = csv.header.indexOf(col);
      if (idx[col] < 0) throw new Error(`${file} has no column ${col} (its columns: ${csv.header.join(', ')})`);
    }
    return { file, csv, idx };
  };
  const customers = load('customers');
  const bills = load('bills');
  const receipts = load('receipts');
  const allocations = load('allocations');
  const warnings = [];

  const acc = new Map();
  for (const r of customers.csv.rows) acc.set(r[customers.idx.id], { billed: 0n, received: 0n, refunded: 0n, allocated: 0n, fine_billed: 0n, fine_received: 0n, fine_allocated: 0n });
  const at = (id, what) => {
    const a = acc.get(id);
    if (!a) warnings.push(`${what} points at customer ${id}, who is not in customers.csv; it is left out`);
    return a;
  };

  for (const [n, r] of bills.csv.rows.entries()) {
    if (r[bills.idx.status] !== 'active') continue;
    const a = at(r[bills.idx.customer_id], `bills.csv row ${n + 2}`);
    if (!a) continue;
    a.billed += toUnits(r[bills.idx.grand_total], SCALE.money, `bills.csv row ${n + 2} grand_total`);
    a.fine_billed += toUnits(r[bills.idx.fine_weight_due], SCALE.grams, `bills.csv row ${n + 2} fine_weight_due`);
  }
  const activeReceipts = new Set();
  for (const [n, r] of receipts.csv.rows.entries()) {
    if (r[receipts.idx.status] !== 'active') continue;
    activeReceipts.add(r[receipts.idx.id]);
    const a = at(r[receipts.idx.customer_id], `receipts.csv row ${n + 2}`);
    if (!a) continue;
    const kind = r[receipts.idx.kind];
    if (kind === 'money') a.received += toUnits(r[receipts.idx.amount], SCALE.money, `receipts.csv row ${n + 2} amount`);
    else if (kind === 'refund') a.refunded += toUnits(r[receipts.idx.amount], SCALE.money, `receipts.csv row ${n + 2} amount`);
    else if (kind === 'fine_silver' || kind === 'fine_cash') a.fine_received += toUnits(r[receipts.idx.fine_grams], SCALE.grams, `receipts.csv row ${n + 2} fine_grams`);
  }
  for (const [n, r] of allocations.csv.rows.entries()) {
    if (r[allocations.idx.released_at] !== '' || !activeReceipts.has(r[allocations.idx.receipt_id])) continue; // live only: not released, and the receipt is not voided
    const a = at(r[allocations.idx.customer_id], `${allocations.file} row ${n + 2}`);
    if (!a) continue;
    a.allocated += toUnits(r[allocations.idx.amount], SCALE.money, `${allocations.file} row ${n + 2} amount`);
    a.fine_allocated += toUnits(r[allocations.idx.fine_grams], SCALE.grams, `${allocations.file} row ${n + 2} fine_grams`);
  }

  const money = (u) => fromUnits(u, SCALE.money);
  const grams = (u) => fromUnits(u, SCALE.grams);
  const out = new Map();
  for (const [id, a] of acc) {
    out.set(id, {
      billed: money(a.billed), received: money(a.received), refunded: money(a.refunded), allocated: money(a.allocated),
      outstanding: money(a.billed - a.allocated), advance: money(a.received - a.allocated - a.refunded), balance: money(a.billed - a.received + a.refunded),
      fine_billed: grams(a.fine_billed), fine_received: grams(a.fine_received), fine_allocated: grams(a.fine_allocated),
      fine_outstanding: grams(a.fine_billed - a.fine_allocated), fine_advance: grams(a.fine_received - a.fine_allocated),
    });
  }

  const counts = new Map([[customers.file, customers.csv.rows.length], [bills.file, bills.csv.rows.length], [receipts.file, receipts.csv.rows.length], [allocations.file, allocations.csv.rows.length]]);
  return { customers: out, manifest: checkManifest(byBase, counts, [...byBase.keys()]), warnings };
}

/** MANIFEST.csv (columns file and rows): every file it names must be in the zip with that many rows. Files this script does not read are counted from their own CSV. */
function checkManifest(byBase, counts, names) {
  const raw = byBase.get('MANIFEST.csv');
  if (!raw) return { checked: false, problems: [] };
  const m = parseCsv(raw.toString('utf8'));
  const f = m.header.indexOf('file');
  const r = m.header.findIndex((h) => h === 'rows' || h === 'row_count');
  if (f < 0 || r < 0) return { checked: false, problems: ['MANIFEST.csv has no columns file and rows, so its counts were not checked'] };
  const problems = [];
  for (const row of m.rows) {
    const name = row[f].endsWith('.csv') ? row[f] : `${row[f]}.csv`;
    if (!names.includes(name)) {
      problems.push(`${name}: the manifest names it but it is not in the zip`);
      continue;
    }
    const actual = counts.get(name) ?? parseCsv(byBase.get(name).toString('utf8')).rows.length;
    if (String(actual) !== String(row[r]).trim()) problems.push(`${name}: the manifest says ${row[r]} rows, the file has ${actual}`);
  }
  return { checked: true, problems };
}

const FIELDS = [['outstanding', 'money'], ['advance', 'money'], ['fine_outstanding', 'grams'], ['balance', 'money'], ['fine_advance', 'grams']];

/** Compares with customer_balances (V2, the query the nightly check runs) on this connection. Reads only. */
export async function compareWithDatabase(conn, balances) {
  const [rows] = await conn.query(`SELECT id, outstanding, advance, fine_outstanding, balance, fine_advance FROM (${loadQueries().V2}) v ORDER BY id`);
  const db = new Map(rows.map((r) => [String(r.id), r]));
  const mismatches = [];
  let checked = 0;
  for (const [id, z] of balances.customers) {
    const d = db.get(id);
    if (!d) continue;
    checked += 1;
    for (const [field, kind] of FIELDS) {
      const scale = SCALE[kind];
      const a = toUnits(z[field], scale, field);
      const b = toUnits(String(d[field]), scale, `database ${field}`);
      if (a !== b) mismatches.push({ customer_id: id, field, zip: fromUnits(a, scale), database: fromUnits(b, scale) });
    }
  }
  const onlyInZip = [...balances.customers.keys()].filter((id) => !db.has(id));
  const onlyInDatabase = [...db.keys()].filter((id) => !balances.customers.has(id));
  return { ok: mismatches.length === 0 && onlyInZip.length === 0 && onlyInDatabase.length === 0, checked, mismatches, onlyInZip, onlyInDatabase };
}

export function formatComparison(cmp) {
  const out = ['Balances rebuilt from the zip alone, against customer_balances:'];
  if (cmp.ok) out.push(`  all ${cmp.checked} customers agree (outstanding, advance, fine_outstanding, balance, fine_advance).`);
  for (const m of cmp.mismatches) out.push(`  ${m.customer_id} ${m.field}: zip ${m.zip}, database ${m.database}`);
  for (const id of cmp.onlyInZip) out.push(`  ${id}: in the zip but not in the database`);
  for (const id of cmp.onlyInDatabase) out.push(`  ${id}: in the database but not in the zip`);
  if (!cmp.ok) out.push(`  ${cmp.mismatches.length} differing figure(s), ${cmp.onlyInZip.length} customer(s) only in the zip, ${cmp.onlyInDatabase.length} only in the database; ${cmp.checked} customers compared.`);
  return out.join('\n');
}

// ---------------------------------------------------------------- command line

async function main(argv) {
  const i = argv.indexOf('--zip');
  if (i < 0 || !argv[i + 1]) {
    console.error('usage: node scripts/zip-balances.mjs --zip download.zip   (database settings DB_HOST DB_PORT DB_NAME DB_USER DB_PASSWORD in the environment)');
    return 2;
  }
  const missing = ['DB_HOST', 'DB_NAME', 'DB_USER', 'DB_PASSWORD'].filter((k) => !process.env[k]);
  if (missing.length) {
    console.error(`missing settings in the environment: ${missing.join(', ')} (the connection is never taken from a file or the command line)`);
    return 2;
  }
  let balances;
  try {
    balances = balancesFromZip(argv[i + 1]);
  } catch (e) {
    console.error(`cannot rebuild the balances from ${argv[i + 1]}: ${e.message}`);
    return 1;
  }
  const pacer = createPacer();
  const conn = await pacedConnect(pacer, () =>
    mysql.createConnection({
      host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 3306), user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
      charset: 'utf8mb4', connectTimeout: 15000, decimalNumbers: false, supportBigNumbers: true, bigNumberStrings: true, dateStrings: true, multipleStatements: false,
    })
  );
  try {
    const cmp = await compareWithDatabase(conn, balances);
    console.log(formatComparison(cmp));
    if (balances.manifest.checked) console.log(balances.manifest.problems.length ? `MANIFEST.csv:\n  ${balances.manifest.problems.join('\n  ')}` : 'MANIFEST.csv: every row count agrees with the files.');
    else console.log(`MANIFEST.csv: not checked${balances.manifest.problems.length ? ` (${balances.manifest.problems[0]})` : ' (the zip has none)'}`);
    for (const w of balances.warnings) console.log(`warning: ${w}`);
    return cmp.ok && balances.manifest.problems.length === 0 ? 0 : 1;
  } finally {
    await conn.end().catch(() => undefined);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).then(
    (code) => void (process.exitCode = code),
    (e) => {
      console.error(e.message);
      process.exitCode = 1;
    }
  );
}
