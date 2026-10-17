#!/usr/bin/env node
// API11 (spec C2, C3, T-F03): the volumes of the shop, in a database, for the tests that need a shop of that size.
//
//   npm run seed:volume -- <lane>     a lane's own database (the container must be up: npm run db:lane -- up <lane>)
//   npm run seed:volume -- --env      the database named by DB_HOST DB_PORT DB_NAME DB_USER DB_PASSWORD (a staging database; typed in the shell, never saved in a file)
//   options (for tests; the defaults are the volumes of C2): --customers N --designs N --pieces N --bills N
//
// It fills an EMPTY database (the migrations and the seeds applied, nothing of the shop yet) with the "M1 volumes" of C2: 2,500 pieces over 600 designs, 2,000 customers (the walk-in is one of
// them) and 3,000 bills with receipts. The paging tests of API11, the hydrate tests of WEB03 and the 10-second measurement of OPS04 read it. It REFUSES anything else: a database that already
// holds a design, a piece, a customer besides the walk-in, a bill, a receipt or an import batch is left exactly as it was.
//
// How it is built, so that nothing in it is a second way to write the shop:
//   1. the customers, the designs, the pieces with their owner-only weights, and the opening dues of a thousand customers (the OB- bills, some with silver owed, some netted off an advance by the
//      rebalance of IM4) go in through the import library (scripts/import.mjs, MB04): one pack, one transaction, the reconciliation, the nightly check;
//   2. the sales: 2,000 bills (the rest of the 3,000) with their lines, 70 % of them with a payment that is allocated to the bill (a full one, or half), numbered JV-2026-00001 on from the
//      counter series of the bill numbers, in ONE more transaction under 20 seconds (IM1), the pieces sold marked Sold on their bill, every row written re-stamped with one fresh `updated_at`
//      and `settings.data_epoch` moved (C4). The sale part is plain SQL on purpose: the import library writes no bills with lines (old estimates are not carried over, IM7).
//   3. the nightly check (I1 to I7, I10, I13 ...) on the result. The command exits 0 only when it passes.
// Every figure is made from integers (paise, milligrams); nothing is random except the ids (version 4), and the rest comes from a fixed seed, so two runs build the same shop.
//
// Audit: when the audit triggers are installed (db/optional, L1) they record both parts with the role import; when they are not, the import writes its own rows and the sales part writes none.
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';
import { auditTriggersInstalled } from './audit-triggers.mjs';
import { runImport } from './import.mjs';
import { runInvariants } from './invariants.mjs';
import { LANES, laneInfo } from './lane.mjs';
import { createPacer, pacedConnect } from './pacing.mjs';

/** C2: "up to 5,000 pieces, 2,000 customers, 3,000 bills"; the pieces are the 2,500 of T-F03 over about 600 designs. */
export const VOLUMES = Object.freeze({ customers: 2000, designs: 600, pieces: 2500, bills: 3000 });

const USAGE = 'usage: node scripts/seed-volume.mjs <lane> | --env   [--customers N] [--designs N] [--pieces N] [--bills N]   (npm run seed:volume -- c)';
const CHUNK = 200;
const SALE_YEAR = 2026;
const CATEGORIES = ['Ring', 'Necklace Set', 'Earrings', 'Bangles', 'Chain', 'Pendant', 'Bracelet', 'Kada', 'Anklet', 'Payal', 'Mangalsutra', 'Pendant Set', 'Nose Pin', 'Brooch', 'Other'];
const LOCATIONS = ['Main Showroom', 'Jaishri Vault', 'Workshop', 'Exhibition'];
const CUSTOMER_TYPES = ['Retail', 'Semi-Wholesale', 'Wholesale'];
const MODES = ['Cash', 'UPI', 'Card', 'Bank Transfer'];
const WALKIN_ID = '00000000-0000-4000-8000-000000000001';
/** The rate of a gram, in paise, by material and purity: made up, like everything here. */
const RATE_PAISE = { '22K': 650000n, '18K': 530000n, '925': 8500n };

// ------------------------------------------------------------------ the command line

/** Reads the command line. Throws an Error that starts with "usage:" for anything it does not understand. */
export function parseArgs(argv) {
  const fail = (why) => {
    throw new Error(`${USAGE}${why ? `   (${why})` : ''}`);
  };
  let target = null;
  const volumes = { ...VOLUMES };
  const setTarget = (t) => {
    if (target) fail('one target only');
    target = t;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--env') setTarget({ kind: 'env' });
    else if (a.startsWith('--')) {
      const name = a.slice(2);
      if (!Object.hasOwn(VOLUMES, name)) fail(`unknown option ${a}`);
      const value = argv[++i];
      if (!/^\d+$/.test(value ?? '')) fail(`${a} needs a whole number`);
      volumes[name] = Number(value);
    } else if (LANES.includes(a)) setTarget({ kind: 'lane', lane: a });
    else fail(`${JSON.stringify(a).slice(0, 40)} is not a lane`);
  }
  if (!target) fail('name a lane or --env');
  return { target, volumes };
}

// ------------------------------------------------------------------ what it will and will not fill

const MUST_BE_EMPTY = ['designs', 'skus', 'sku_private', 'bills', 'bill_items', 'receipts', 'receipt_allocations', 'sys_import_batches'];

/** Why the database is not empty, one sentence for each table that holds something. No sentence, no problem. */
export async function emptinessProblems(conn) {
  const problems = [];
  for (const table of MUST_BE_EMPTY) {
    const [[row]] = await conn.query(`SELECT COUNT(*) AS n FROM \`${table}\``);
    if (Number(row.n) > 0) problems.push(`${table} holds ${row.n} row(s)`);
  }
  const [[others]] = await conn.query('SELECT COUNT(*) AS n FROM customers WHERE is_walkin = 0');
  if (Number(others.n) > 0) problems.push(`customers holds ${others.n} row(s) besides the walk-in`);
  return problems;
}

function checkVolumes(v) {
  for (const k of Object.keys(VOLUMES)) {
    if (!Number.isInteger(v[k]) || v[k] < 1) throw new Error(`${k} must be a whole number of 1 or more, got ${JSON.stringify(v[k])}`);
  }
  if (v.customers < 2) throw new Error('customers must be at least 2: the walk-in customer, who is one of them, and one more');
  if (v.designs > v.pieces) throw new Error(`designs (${v.designs}) cannot be more than pieces (${v.pieces}): a design has at least one piece`);
  const plan = planBills(v);
  if (plan.opening > v.customers - 1) throw new Error(`bills (${v.bills}) cannot be built from ${v.customers} customers and ${v.pieces} pieces: ${plan.sale} sales use ${plan.sold} pieces, the other ${plan.opening} bills are opening balances and each needs a customer of its own`);
  return plan;
}

/** How the bills divide: sales (80 % of the pieces at most, each sells one piece, one in twenty two) and opening-balance bills (one customer each, no lines). */
function planBills(v) {
  const sale = Math.min(Math.floor(v.pieces * 0.8), v.bills);
  const two = Math.floor(sale / 20);
  return { sale, two, sold: sale + two, opening: v.bills - sale };
}

// ------------------------------------------------------------------ the shop, from a fixed seed

/** mulberry32: a small generator that gives the same numbers for the same seed. */
function generator(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pad = (n, w) => String(n).padStart(w, '0');
const rupees = (paise) => (paise < 0n ? `-${rupees(-paise)}` : `${paise / 100n}.${pad(paise % 100n, 2)}`);
const grams = (mg) => `${mg / 1000n}.${pad(mg % 1000n, 3)}`;

/** The pack for the import library (see IMPORT-GUIDE.md). */
function buildPack(v, plan, rnd) {
  const customers = [];
  for (let i = 1; i < v.customers; i++) {
    const c = { ref: `seed customer ${i}`, name: `Customer ${pad(i, 5)}`, mobile: `98${pad(10_000_000 + i, 8)}`, customer_type: CUSTOMER_TYPES[i % 3] };
    if (i <= plan.opening) {
      const duesPaise = BigInt(50_000 + Math.floor(rnd() * 4_950_000)) / 50n * 50n; // 500.00 to 50,000.00, to the 50 paise
      c.dues = rupees(duesPaise);
      if (i % 10 === 0) c.fine_due = grams(BigInt(1000 + Math.floor(rnd() * 19_000))); // silver owed
      if (i % 25 === 0) c.advance = rupees((duesPaise * 2n) / 5n / 100n * 100n); // 40 % of the dues, whole rupees: netted off by the rebalance, the dues stay larger
    }
    customers.push(c);
  }
  const base = Math.floor(v.pieces / v.designs);
  const extra = v.pieces % v.designs;
  const designs = [];
  for (let d = 0; d < v.designs; d++) {
    const silver = d % 3 === 2;
    const material = silver ? 'Silver' : 'Gold';
    const purity = silver ? '925' : d % 5 === 4 ? '18K' : '22K';
    const heavy = silver ? 20_000 : 3_000; // milligrams: a silver piece is heavier
    const pieces = [];
    const n = base + (d < extra ? 1 : 0);
    for (let p = 0; p < n; p++) {
      const gross = BigInt(heavy + Math.floor(rnd() * (silver ? 130_000 : 42_000)));
      const stonesMg = BigInt(Math.floor(rnd() * 600));
      const net = gross - stonesMg;
      const original = net > 150n ? net - 50n - BigInt(Math.floor(rnd() * 100)) : net;
      const retail = BigInt(10_000 + Math.floor(rnd() * 140_000)); // 100.00 to 1,500.00
      pieces.push({
        gross_weight: grams(gross),
        customer_net_weight: grams(net),
        original_net_weight: grams(original),
        stones: Math.floor(rnd() * 6),
        stone_weight: grams(stonesMg),
        labour_retail: rupees(retail),
        labour_wholesale: rupees((retail * 8n) / 10n),
        piroi: d % 7 === 0 ? '50.00' : '0.00',
        location: LOCATIONS[(d + p) % LOCATIONS.length],
      });
    }
    designs.push({
      design_no: `SD-${pad(d + 1, 4)}`,
      name: `Design ${d + 1}`,
      category: CATEGORIES[d % CATEGORIES.length],
      material,
      purity,
      selling_method: d % 10 < 7 ? 'By Weight' : 'Per Piece',
      tags: [material.toLowerCase(), `batch-${(d % 4) + 1}`],
      pieces,
    });
  }
  return { batch: `seed-volume-${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 8)}`, source_file: 'scripts/seed-volume.mjs', cut_over: '2026-01-01', customers, designs };
}

// ------------------------------------------------------------------ the sales

async function bulkInsert(conn, table, columns, rows) {
  for (let i = 0; i < rows.length; i += CHUNK) {
    const part = rows.slice(i, i + CHUNK);
    await conn.query(`INSERT INTO \`${table}\` (${columns.map((c) => `\`${c}\``).join(', ')}) VALUES ${part.map(() => `(${columns.map(() => '?').join(', ')})`).join(', ')}`, part.flat());
  }
}
const chunksOf = (xs, n) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));
const json = (v) => (typeof v === 'string' ? JSON.parse(v) : v);

/** A day of the sale year, 1 January on, spread over the sales; '2026-03-17'. */
function saleDay(index, total) {
  const day = Math.floor((index * 289) / Math.max(total, 1)); // 1 January to 16 October
  const d = new Date(Date.UTC(SALE_YEAR, 0, 1 + day));
  return d.toISOString().slice(0, 10);
}

async function writeSales(conn, batchId, plan, report) {
  const [[est]] = await conn.query("SELECT value FROM settings WHERE setting_key = 'estimate'");
  const prefix = String(json(est?.value)?.prefix ?? 'JV');
  if (!/^[A-Z][A-Z0-9]{0,7}$/.test(prefix)) throw new Error('the estimate prefix of the settings is not a bill number prefix');
  const [pieces] = await conn.query(
    `SELECT s.id, s.sku_no, s.gross_weight, s.customer_net_weight, s.labour_retail, s.piroi, d.design_no, d.material, d.purity, d.selling_method, c.name AS category
       FROM skus s JOIN designs d ON d.id = s.design_id JOIN categories c ON c.id = d.category_id
      WHERE s.import_batch_id = ? ORDER BY s.sku_no`,
    [batchId],
  );
  const [customers] = await conn.query('SELECT id, customer_type FROM customers WHERE import_batch_id = ? ORDER BY name', [batchId]);
  const [walkin] = await conn.query('SELECT id FROM customers WHERE id = ? AND is_walkin = 1', [WALKIN_ID]);
  if (pieces.length < plan.sold) throw new Error('not enough pieces for the sales');
  if (customers.length === 0) throw new Error('no customers to sell to');
  const mg = (text) => BigInt(String(text).replace('.', ''));
  const paise = (text) => BigInt(String(text).replace('.', ''));

  const billCols = ['id', 'bill_no', 'customer_id', 'bill_date', 'doc_type', 'sale_type', 'status', 'pricing_version', 'subtotal', 'discount', 'additional_charges', 'gst_percent', 'gst_amount', 'grand_total', 'round_off', 'fine_weight_due', 'created_at'];
  const itemCols = ['id', 'bill_id', 'line_no', 'sku_id', 'design_no', 'sku_no', 'category', 'material', 'purity', 'selling_method', 'gross_weight', 'customer_net_weight', 'quantity', 'metal_rate', 'labour_rate', 'labour_amount', 'piroi', 'other_charges', 'metal_amount', 'fine_weight_due', 'item_total', 'tax_rate', 'tax_amount', 'list_metal_rate', 'list_labour_rate', 'created_at'];
  const receiptCols = ['id', 'customer_id', 'kind', 'mode', 'amount', 'fine_grams', 'paid_on', 'reference', 'is_opening', 'status', 'created_at'];
  const allocCols = ['id', 'receipt_id', 'bill_id', 'customer_id', 'amount', 'fine_grams', 'created_at'];
  const bills = [];
  const items = [];
  const receipts = [];
  const allocations = [];
  const sold = []; // [sku id, bill id]
  let next = 0; // the next piece
  for (let i = 0; i < plan.sale; i++) {
    const billId = randomUUID();
    const toWalkin = walkin.length > 0 && i % 10 === 9;
    const customer = toWalkin ? { id: WALKIN_ID, customer_type: 'Retail' } : customers[(i * 7) % customers.length];
    const date = saleDay(i, plan.sale);
    const createdAt = `${date} 06:${pad(Math.floor(i / 60) % 60, 2)}:${pad(i % 60, 2)}.000000`;
    const lines = i < plan.two ? 2 : 1;
    let subtotal = 0n;
    for (let line = 1; line <= lines; line++) {
      const p = pieces[next++];
      const rate = RATE_PAISE[p.purity] ?? 650000n;
      const netMg = mg(p.customer_net_weight);
      const metal = (netMg * rate + 500n) / 1000n; // paise, rounded half up
      const labour = paise(p.labour_retail);
      const piroi = paise(p.piroi);
      const total = metal + labour + piroi;
      subtotal += total;
      items.push([
        randomUUID(), billId, line, p.id, p.design_no, p.sku_no, p.category, p.material, p.purity, p.selling_method, p.gross_weight, p.customer_net_weight, 1, rupees(rate), p.labour_retail, p.labour_retail, p.piroi, '0.00',
        rupees(metal), '0.000', rupees(total), '0.00', '0.00', rupees(rate), p.labour_retail, createdAt,
      ]);
      sold.push([p.id, billId]);
    }
    const discount = i % 7 === 0 ? 10_000n : 0n; // 100.00 off on every seventh bill
    const net = subtotal - discount;
    const grand = ((net + 50n) / 100n) * 100n; // whole rupees, half up (I6)
    bills.push([billId, `${prefix}-${SALE_YEAR}-${pad(i + 1, 5)}`, customer.id, date, 'estimate', customer.customer_type, 'active', 1, rupees(subtotal), rupees(discount), '0.00', '0.00', '0.00', rupees(grand), rupees(grand - net), '0.000', createdAt]);
    // 70 % are paid: three in five of those in full, the rest half; the walk-in always pays in full (K5: one row stands for strangers)
    const paid = toWalkin || i % 10 < 7;
    if (paid) {
      const full = toWalkin || i % 5 < 3 || grand < 200n;
      const amount = full ? grand : (grand / 200n) * 100n; // half, in whole rupees
      if (amount > 0n) {
        const receiptId = randomUUID();
        const mode = MODES[i % MODES.length];
        const paidAt = `${date} 06:${pad(Math.floor(i / 60) % 60, 2)}:${pad(i % 60, 2)}.500000`;
        receipts.push([receiptId, customer.id, 'money', mode, rupees(amount), '0.000', date, mode === 'Cash' ? null : `REF${pad(i + 1, 6)}`, 0, 'active', paidAt]);
        allocations.push([randomUUID(), receiptId, billId, customer.id, rupees(amount), '0.000', paidAt]);
      }
    }
  }

  const audited = (await auditTriggersInstalled(conn)).length > 0;
  if (audited) await conn.query("SET @jv_actor = NULL, @jv_role = 'import', @jv_request = NULL");
  await conn.query('START TRANSACTION');
  let committed = false;
  try {
    await bulkInsert(conn, 'bills', billCols, bills);
    await bulkInsert(conn, 'bill_items', itemCols, items);
    await bulkInsert(conn, 'receipts', receiptCols, receipts);
    await bulkInsert(conn, 'receipt_allocations', allocCols, allocations);
    for (const part of chunksOf(sold, CHUNK)) {
      const cases = part.map(() => 'WHEN ? THEN ?').join(' ');
      await conn.query(`UPDATE skus SET status = 'Sold', sold_bill_id = CASE id ${cases} END WHERE id IN (${part.map(() => '?').join(', ')})`, [...part.flatMap(([sku, bill]) => [sku, bill]), ...part.map(([sku]) => sku)]);
    }
    if (plan.sale > 0) await conn.query('INSERT INTO sys_counters (series, last_value, seed_value) VALUES (?, ?, 0)', [`bill:${prefix}:${SALE_YEAR}`, plan.sale]);
    // IM1: one fresh updated_at on every row this transaction changed, just before COMMIT, and a new data_epoch (C4)
    const [[now]] = await conn.query("SELECT DATE_FORMAT(UTC_TIMESTAMP(6), '%Y-%m-%d %H:%i:%s.%f') AS now");
    const stamp = [['bills', bills.map((r) => r[0])], ['bill_items', items.map((r) => r[0])], ['receipts', receipts.map((r) => r[0])], ['receipt_allocations', allocations.map((r) => r[0])], ['skus', sold.map((r) => r[0])]];
    for (const [table, ids] of stamp) for (const part of chunksOf(ids, 500)) await conn.query(`UPDATE \`${table}\` SET updated_at = ? WHERE id IN (${part.map(() => '?').join(', ')})`, [now.now, ...part]);
    await conn.query("INSERT INTO settings (setting_key, value) VALUES ('data_epoch', JSON_OBJECT('epoch', ?)) ON DUPLICATE KEY UPDATE value = JSON_OBJECT('epoch', ?)", [now.now, now.now]);
    await conn.query('COMMIT');
    committed = true;
  } finally {
    if (!committed) await conn.query('ROLLBACK').catch(() => undefined);
    if (audited) await conn.query('SET @jv_actor = NULL, @jv_role = NULL, @jv_request = NULL').catch(() => undefined);
  }
  report.counts.sale_bills = bills.length;
  report.counts.bill_items = items.length;
  report.counts.receipts += receipts.length;
  report.counts.receipt_allocations += allocations.length;
  report.counts.sold_pieces = sold.length;
}

// ------------------------------------------------------------------ the seed

/**
 * Fills an empty database with the shop of `volumes`. Throws, before writing anything, when the volumes cannot be built, when the database is not empty or when it has no seeds. Returns
 * { ok, counts, invariants, ms }; `ok` is true only when the nightly check passes on the result.
 */
export async function seedVolume(conn, volumes = {}) {
  const t0 = Date.now();
  const v = { ...VOLUMES, ...volumes };
  const plan = checkVolumes(v);
  const problems = await emptinessProblems(conn);
  if (problems.length > 0) throw new Error(`the database is not empty (${problems.join('; ')}): seed-volume fills an empty lane or staging database and nothing else`);
  const [[seeds]] = await conn.query("SELECT (SELECT COUNT(*) FROM categories) AS categories, (SELECT COUNT(*) FROM settings WHERE setting_key IN ('numbering', 'estimate')) AS settings");
  if (Number(seeds.categories) === 0 || Number(seeds.settings) < 2) throw new Error('the database has no seeds (categories, settings): apply the migrations with their seeds first (npm run db:migrate)');

  const rnd = generator(0x4a56);
  const pack = buildPack(v, plan, rnd);
  const imported = await runImport(conn, pack);
  if (!imported.ok) throw new Error(`the import of the shop was not clean: ${JSON.stringify({ rejected: imported.rejected.slice(0, 3), mismatches: imported.mismatches.slice(0, 3), invariants: imported.invariants })}`);
  const report = {
    ok: false,
    counts: {
      customers: 0, designs: imported.counts.designs.imported, pieces: imported.counts.pieces.imported, bills: 0, opening_bills: imported.counts.opening_bills,
      sale_bills: 0, bill_items: 0, receipts: imported.counts.opening_advances, receipt_allocations: imported.counts.allocations, sold_pieces: 0,
    },
    invariants: null,
    batch: imported.batch,
    ms: 0,
  };
  await writeSales(conn, imported.batch.id, plan, report);
  for (const t of ['bills', 'bill_items', 'receipts', 'receipt_allocations', 'skus', 'sys_counters']) await conn.query(`ANALYZE TABLE \`${t}\``); // fresh statistics after a bulk load (V1 and V2 depend on them)
  const nightly = await runInvariants(conn);
  report.invariants = { ok: nightly.ok, counts: nightly.counts };
  report.counts.customers = Number(((await conn.query('SELECT COUNT(*) AS n FROM customers'))[0])[0].n);
  report.counts.bills = Number(((await conn.query('SELECT COUNT(*) AS n FROM bills'))[0])[0].n);
  report.ok = nightly.ok;
  report.ms = Date.now() - t0;
  return report;
}

/** The report as text for the person running the command. */
export function formatReport(r) {
  const c = r.counts;
  const lines = [
    'SEED-VOLUME REPORT',
    `customers ${c.customers} (the walk-in is one)   designs ${c.designs}   pieces ${c.pieces} (${c.sold_pieces} sold)`,
    `bills ${c.bills}: ${c.opening_bills} opening balances, ${c.sale_bills} sales with ${c.bill_items} lines`,
    `receipts ${c.receipts}   allocations ${c.receipt_allocations}`,
    r.invariants.ok ? 'nightly check on the result: passed' : `NIGHTLY CHECK FAILED: ${JSON.stringify(r.invariants.counts)}`,
    `RESULT: ${r.ok ? 'OK' : 'NOT OK'}   (${r.ms} ms)`,
  ];
  return lines.join('\n');
}

// ------------------------------------------------------------------ the command

async function connect(target) {
  const options = { charset: 'utf8mb4', connectTimeout: 15000, decimalNumbers: false, supportBigNumbers: true, bigNumberStrings: true, dateStrings: true, multipleStatements: false };
  let settings;
  if (target.kind === 'lane') {
    // the sandbox namespace of the lane tool (JV_LANE_NAMESPACE, JV_LANE_PORT_BASE) is honoured, so a sandbox run never writes into the real lane of the same name
    const namespace = process.env.JV_LANE_NAMESPACE ?? '';
    const info = await laneInfo(target.lane, { namespace, portBase: Number(process.env.JV_LANE_PORT_BASE ?? 33310) });
    if (!info || !info.running) {
      console.error(`lane ${target.lane} is not up (container jv-mariadb-${namespace ? `${namespace}-` : ''}${target.lane}): npm run db:lane -- up ${target.lane}`);
      process.exit(2);
    }
    settings = { host: info.host, port: info.port, user: info.appUser, password: info.appPassword, database: info.database };
  } else {
    const missing = ['DB_HOST', 'DB_NAME', 'DB_USER', 'DB_PASSWORD'].filter((k) => !process.env[k]);
    if (missing.length) {
      console.error(`missing settings in the environment: ${missing.join(', ')} (the connection is never taken from a file or the command line)`);
      process.exit(2);
    }
    settings = { host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 3306), user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME };
  }
  // S11: at most 10 new connections in any 1.2 seconds (Hostinger refuses the 21st inside about a second); this opens one, through the pacer
  const conn = await pacedConnect(createPacer(), () => mysql.createConnection({ ...options, ...settings }));
  await conn.query("SET SESSION transaction_isolation = 'READ-COMMITTED'");
  await conn.query("SET SESSION time_zone = '+00:00'");
  await conn.query('SET SESSION max_statement_time = 120');
  return conn;
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
  let conn;
  try {
    conn = await connect(args.target);
    const report = await seedVolume(conn, args.volumes);
    console.log(formatReport(report));
    process.exitCode = report.ok ? 0 : 1;
  } catch (e) {
    console.error(`seed-volume refused: ${e.message}`);
    process.exitCode = 1;
  } finally {
    await conn?.end().catch(() => undefined);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
