// Spec 6.3 (IM1 to IM8): the import of designs, pieces, customers and opening balances. A library; scripts/import-cli.mjs is the command Harsh runs on his Mac.
//
// The input is a "pack": plain JSON with the customers (and their opening dues, silver owed and advances), and the designs with their pieces. Turning Siddhi's sheet or the
// old browser export into a pack is a separate, one-off job (IM7); this file only needs the pack to be right and says exactly what is wrong when it is not.
//
// One batch = ONE transaction (so a failed batch leaves nothing behind and no delete is needed, IM1). Inside it:
//   batch row (name unique, IM2) -> customers -> designs -> pieces (+ owner-only weights) -> opening bills OB-nnnn and opening advances (D15)
//   -> rebalance of every customer who has both dues and an advance (IM4, the same function X12 uses) -> audit rows (role import, no actor, L1: written here, or by the
//   database's own audit triggers when they are installed; never both)
//   -> seedCounters (IM3) -> re-stamp updated_at of every row written and bump settings.data_epoch (C4) -> reconciliation (IM6) -> commit.
// After the commit the nightly check is run on the committed data. A dry run does all of it and rolls back. Rows that fail validation are listed with the reason and left out
// (strict mode: nothing is kept). Numbers are never rounded: a value with more decimals than its column, a negative one, or one above the caps of S4 is refused.
//
// Nobody else may be using the database: the counters are taken inside the transaction (the shop is closed during an import, O35).
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { auditTriggersInstalled } from './audit-triggers.mjs';
import { one } from './backup.mjs';
import { runInvariants } from './invariants.mjs';
import { loadQueries } from './queries.mjs';
import { fromUnits, rebalanceCustomer, toUnits } from './rebalance.mjs';

const LIMITS = JSON.parse(readFileSync(new URL('../db/limits.json', import.meta.url), 'utf8'));
const WALKIN_ID = '00000000-0000-4000-8000-000000000001';
const Q = loadQueries(); // V2 customer_balances as a query (section 11: not a view)
const STRICT_MODE = 'STRICT_TRANS_TABLES,ERROR_FOR_DIVISION_BY_ZERO,NO_AUTO_CREATE_USER,NO_ENGINE_SUBSTITUTION';
const CUSTOMER_TYPES = ['Retail', 'Semi-Wholesale', 'Wholesale'];
const IMPORT_STATUSES = ['In Stock', 'Reserved', 'On Approval', 'Returned', 'Repair', 'Transferred', 'Missing', 'Damaged'];
const MAX_FINE_DUE = 20_000_000; // chk_bills_fine
const MAX_FINE_RECEIPT = 100_000; // chk_receipts_caps
const CHUNK = 200;

// ------------------------------------------------------------------ small parsers

export function normaliseMobile(raw) {
  if (raw === null || raw === undefined || String(raw).trim() === '') return { mobile: null, problem: 'blank: no mobile number given' };
  let s = String(raw).trim();
  const plus = s.startsWith('+');
  s = s.replace(/[\s\-().]/g, '');
  const digits = plus ? s.slice(1) : s;
  const bad = { mobile: null, problem: `not a valid mobile number: ${JSON.stringify(String(raw))}` };
  if (!/^\d+$/.test(digits)) return bad;
  if (plus) {
    if (digits.length === 12 && digits.startsWith('91')) return { mobile: digits.slice(2), problem: null };
    return digits.length >= 7 && digits.length <= 15 ? { mobile: `+${digits}`, problem: null } : bad;
  }
  if (digits.length === 12 && digits.startsWith('91')) return { mobile: digits.slice(2), problem: null };
  if (digits.length === 11 && digits.startsWith('0')) return { mobile: digits.slice(1), problem: null };
  return digits.length === 10 ? { mobile: digits, problem: null } : bad;
}

class Bad extends Error {}

/** A non-negative decimal with at most `scale` decimals and at most `max`. Returns { text, units }; blank gives the default. */
function dec(value, scale, max, field, dflt = '0') {
  if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) value = dflt;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Bad(`${field} is not a number`);
    value = String(value);
    if (/e/i.test(value)) throw new Bad(`${field} is too large or too small to read exactly; give it as text`);
  }
  const t = String(value).trim();
  if (/^-/.test(t)) throw new Bad(`${field} must not be negative`);
  if (!/^\d+(\.\d+)?$/.test(t)) throw new Bad(`${field} is not a number: ${JSON.stringify(t)}`);
  let units;
  try {
    units = toUnits(t, scale);
  } catch {
    throw new Bad(`${field} has more than ${scale} decimals: ${JSON.stringify(t)} (it would be rounded; fix the source)`);
  }
  if (units > BigInt(max) * 10n ** BigInt(scale)) throw new Bad(`${field} is above the limit ${max}: ${t}`);
  return { text: fromUnits(units, scale), units };
}
function int(value, field, max = 1_000_000) {
  if (value === undefined || value === null || value === '') return 0;
  const t = String(value).trim();
  if (!/^\d+$/.test(t)) throw new Bad(`${field} must be a whole number: ${JSON.stringify(t)}`);
  if (Number(t) > max) throw new Bad(`${field} is above the limit ${max}`);
  return Number(t);
}
const text = (v, max, field, required = false) => {
  const t = v === undefined || v === null ? '' : String(v).trim();
  if (required && t === '') throw new Bad(`${field} is blank`);
  if (t.length > max) throw new Bad(`${field} is longer than ${max} characters`);
  return t === '' ? null : t;
};
const canon = (v, list, field) => {
  const hit = list.find((x) => x.toLowerCase() === String(v ?? '').trim().toLowerCase());
  if (!hit) throw new Bad(`${field} ${JSON.stringify(v)} is not one of ${list.join(', ')}`);
  return hit;
};
const lower = (s) => s.toLowerCase();
const q = (id) => '`' + String(id).replace(/`/g, '``') + '`';
const jsonOf = (v) => (typeof v === 'string' ? JSON.parse(v) : v);

async function bulkInsert(conn, table, columns, rows) {
  for (let i = 0; i < rows.length; i += CHUNK) {
    const part = rows.slice(i, i + CHUNK);
    await conn.query(`INSERT INTO ${q(table)} (${columns.map(q).join(', ')}) VALUES ${part.map(() => `(${columns.map(() => '?').join(', ')})`).join(', ')}`, part.flat());
  }
}
const chunks = (xs, n) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

// ------------------------------------------------------------------ seedCounters (IM3)

export async function seedCounters(conn) {
  const found = [];
  const [designs] = await conn.query(
    `SELECT c.prefix AS prefix, MAX(CAST(SUBSTRING(d.design_no, CHAR_LENGTH(c.prefix) + 2) AS UNSIGNED)) AS mx
       FROM categories c JOIN designs d ON d.design_no REGEXP CONCAT('^', c.prefix, '-[0-9]+$') GROUP BY c.prefix`
  );
  for (const r of designs) found.push([`design:${r.prefix}`, Number(r.mx)]);
  const [pieces] = await conn.query(
    `SELECT d.design_no AS design_no, MAX(CAST(SUBSTRING(s.sku_no, CHAR_LENGTH(d.design_no) + 2) AS UNSIGNED)) AS mx
       FROM skus s JOIN designs d ON d.id = s.design_id
      WHERE LEFT(s.sku_no, CHAR_LENGTH(d.design_no) + 1) = CONCAT(d.design_no, '-') AND SUBSTRING(s.sku_no, CHAR_LENGTH(d.design_no) + 2) REGEXP '^[0-9]+$'
      GROUP BY d.design_no`
  );
  for (const r of pieces) found.push([`sku:${r.design_no}`, Number(r.mx)]);
  const [bills] = await conn.query(
    `SELECT t.series AS series, MAX(t.n) AS mx FROM (
       SELECT IF(BINARY b.bill_no REGEXP '^OB-[0-9]+$', 'opening',
                 CONCAT('bill:', SUBSTRING(b.bill_no, 1, CHAR_LENGTH(b.bill_no) - CHAR_LENGTH(SUBSTRING_INDEX(b.bill_no, '-', -2)) - 1),
                        ':', SUBSTRING_INDEX(SUBSTRING_INDEX(b.bill_no, '-', -2), '-', 1))) AS series,
              CAST(SUBSTRING_INDEX(b.bill_no, '-', -1) AS UNSIGNED) AS n
         FROM bills b WHERE BINARY b.bill_no REGEXP '^OB-[0-9]+$' OR BINARY b.bill_no REGEXP '^.+-[0-9]{4}-[0-9]+$') t
      GROUP BY t.series`
  );
  for (const r of bills) found.push([r.series, Number(r.mx)]);
  for (const [series, mx] of found) {
    await conn.query(
      `INSERT INTO sys_counters (series, last_value, seed_value) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE seed_value = GREATEST(seed_value, VALUES(seed_value)), last_value = GREATEST(last_value, VALUES(last_value))`,
      [series, mx, mx]
    );
  }
  return found.map(([series, mx]) => ({ series, seed_value: mx }));
}

// ------------------------------------------------------------------ the import

const emptyCounts = () => ({ source: 0, imported: 0, rejected: 0 });

/**
 * L1: "never both". audit 'auto' (the default) records the import with its own audit_log rows (no actor, the role import) when the database has no audit triggers, and lets the
 * triggers do it (the session variable @jv_role is 'import' for the run, then cleared) when it has. Asking for 'import' or 'none' where the triggers exist is refused: the first would
 * write every row twice, the second cannot be honoured.
 */
export async function runImport(conn, pack, opts = {}) {
  const asked = opts.audit ?? 'auto';
  if (!['auto', 'import', 'none'].includes(asked)) throw new Error(`audit must be auto, import or none, got ${JSON.stringify(asked)}`);
  const installed = (await auditTriggersInstalled(conn)).length > 0;
  if (installed && asked !== 'auto') {
    throw new Error(`the audit triggers are installed (L1 (a)) and record the import with the role import; audit: ${JSON.stringify(asked)} would ${asked === 'import' ? 'write every row twice' : 'not switch them off'}: use audit: "auto"`);
  }
  const mode = installed ? 'triggers' : asked === 'auto' ? 'import' : asked;
  if (mode !== 'triggers') return importBody(conn, pack, opts, mode);
  await conn.query("SET @jv_actor = NULL, @jv_role = 'import', @jv_request = NULL");
  try {
    return await importBody(conn, pack, opts, mode);
  } finally {
    await conn.query('SET @jv_actor = NULL, @jv_role = NULL, @jv_request = NULL').catch(() => undefined);
  }
}

async function importBody(conn, pack, opts, auditMode) {
  const t0 = Date.now();
  const newId = opts.newId ?? randomUUID;
  const hook = async (step) => {
    if (opts.after) await opts.after(step);
  };

  // ---- the pack itself
  const batchName = String(pack?.batch ?? '').trim();
  if (batchName === '' || batchName.length > 120) throw new Error('the pack needs a batch name of 1 to 120 characters');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(pack.cut_over ?? '')) || Number.isNaN(Date.parse(`${pack.cut_over}T00:00:00Z`)) || new Date(`${pack.cut_over}T00:00:00Z`).toISOString().slice(0, 10) !== pack.cut_over) {
    throw new Error(`cut_over must be a real date like 2026-11-01, got ${JSON.stringify(pack.cut_over)}`);
  }
  const cutOver = pack.cut_over;

  const report = {
    ok: false,
    dry_run: !!opts.dryRun,
    batch: { id: null, name: batchName },
    counts: { customers: emptyCounts(), designs: emptyCounts(), pieces: emptyCounts(), opening_bills: 0, opening_advances: 0, allocations: 0 },
    totals: {},
    mismatches: [],
    rejected: [],
    warnings: [],
    invalid_mobiles: [],
    invariants: null,
    ms: 0,
  };
  const reject = (table, ref, reason) => report.rejected.push({ table, ref: String(ref), reason });

  await conn.query(`SET SESSION sql_mode = '${STRICT_MODE}'`);
  await conn.query('START TRANSACTION');
  let committed = false;
  try {
    // ---- step: batch (IM2)
    const [dupBatch] = await conn.query('SELECT id FROM sys_import_batches WHERE name = ?', [batchName]);
    if (dupBatch.length) throw new Error(`import batch ${JSON.stringify(batchName)} was already imported (batch names are unique)`);
    const batchId = newId();
    await conn.query('INSERT INTO sys_import_batches (id, name, source_file) VALUES (?, ?, ?)', [batchId, batchName, pack.source_file ?? null]);
    await hook('batch');

    // ---- lookups
    const [cats] = await conn.query('SELECT id, name, prefix FROM categories');
    const [subs] = await conn.query('SELECT id, category_id, name FROM subcategories');
    const numbering = jsonOf((await conn.query("SELECT value FROM settings WHERE setting_key = 'numbering'"))[0][0]?.value) ?? {};
    const skuPadding = Number(numbering.skuPadding ?? 3);
    const barcodePrefix = String(numbering.barcodePrefix ?? 'BC');
    const audited = []; // [table, row id, row object]
    const stamp = { customers: [], designs: [], skus: [], sku_private: [], bills: [], receipts: [], receipt_allocations: [] };
    const audit = (table, id, row) => audited.push([table, id, row]);

    // ---- customers: validate
    const customers = [];
    const srcTotals = { dues: 0n, fine: 0n, advance: 0n, fineAdvance: 0n };
    const sourceCustomers = pack.customers ?? [];
    report.counts.customers.source = sourceCustomers.length;
    const mobilesSeen = new Map();
    sourceCustomers.forEach((pc, i) => {
      const ref = pc?.ref ?? `customer #${i + 1}`;
      try {
        const walkin = pc.walkin === true;
        const c = { ref, walkin, id: walkin ? WALKIN_ID : newId() };
        if (!walkin) {
          c.name = text(pc.name, 120, 'name', true);
          const m = normaliseMobile(pc.mobile);
          c.mobile = m.mobile;
          if (m.problem) report.invalid_mobiles.push({ ref, name: c.name, given: pc.mobile === undefined || pc.mobile === null ? '' : String(pc.mobile), problem: m.problem });
          c.customer_type = pc.customer_type === undefined || pc.customer_type === '' ? 'Retail' : canon(pc.customer_type, CUSTOMER_TYPES, 'customer_type');
          c.email = text(pc.email, 254, 'email');
          c.address = text(pc.address, 500, 'address');
          c.gst_number = text(pc.gst_number, 20, 'gst_number');
          c.notes = text(pc.notes, 60000, 'notes');
          const pan = text(pc.pan, 40, 'pan');
          c.pan = null;
          if (pan !== null) {
            if (/^[A-Za-z]{5}\d{4}[A-Za-z]$/.test(pan)) c.pan = pan.toUpperCase();
            else report.warnings.push(`${c.name} (${ref}): the PAN ${JSON.stringify(pan)} is not five letters, four digits and a letter; it was left out`);
          }
          if (c.mobile !== null) {
            if (mobilesSeen.has(c.mobile)) report.warnings.push(`${c.name} (${ref}): the mobile number ${c.mobile} is also used by ${mobilesSeen.get(c.mobile)}`);
            else mobilesSeen.set(c.mobile, c.name);
          }
        } else {
          c.name = 'walk-in';
          c.customer_type = 'Retail';
        }
        c.dues = dec(pc.dues, 2, LIMITS.maxAmount, 'dues');
        c.fine_due = dec(pc.fine_due, 3, MAX_FINE_DUE, 'fine_due');
        c.advance = dec(pc.advance, 2, LIMITS.maxAmount, 'advance');
        c.fine_advance = dec(pc.fine_advance, 3, MAX_FINE_RECEIPT, 'fine_advance');
        srcTotals.dues += c.dues.units;
        srcTotals.fine += c.fine_due.units;
        srcTotals.advance += c.advance.units;
        srcTotals.fineAdvance += c.fine_advance.units;
        if (walkin && (c.advance.units > 0n || c.fine_advance.units > 0n)) {
          reject('opening', ref, 'the walk-in customer never holds an advance (K5): one row stands for strangers whose money must not pay each other\'s bills');
          report.counts.customers.rejected += 1;
          return;
        }
        customers.push(c);
      } catch (e) {
        if (!(e instanceof Bad)) throw e;
        report.counts.customers.rejected += 1;
        reject('customers', ref, e.message);
      }
    });
    // a shared mobile with a customer already in the database
    const mobiles = [...mobilesSeen.keys()];
    for (const part of chunks(mobiles, 500)) {
      const [rows] = await conn.query('SELECT mobile, name FROM customers WHERE mobile IN (?)', [part]);
      for (const r of rows) report.warnings.push(`the mobile number ${r.mobile} is already used by the existing customer ${r.name}`);
    }
    const newCustomers = customers.filter((c) => !c.walkin);

    // ---- designs and pieces: validate
    const designs = [];
    const pieces = [];
    const sourceDesigns = pack.designs ?? [];
    report.counts.designs.source = sourceDesigns.length;
    report.counts.pieces.source = sourceDesigns.reduce((n, d) => n + (d?.pieces?.length ?? 0), 0);
    const designKeys = [];
    for (const pd of sourceDesigns) if (pd && typeof pd.design_no === 'string') designKeys.push(pd.design_no.trim());
    const existingDesigns = new Set();
    for (const part of chunks(designKeys.filter(Boolean), 500)) for (const r of (await conn.query('SELECT design_no FROM designs WHERE design_no IN (?)', [part]))[0]) existingDesigns.add(lower(r.design_no));
    const pieceNos = [];
    const pieceBarcodes = [];
    for (const pd of sourceDesigns) for (const pp of pd?.pieces ?? []) {
      if (pp?.sku_no) pieceNos.push(String(pp.sku_no).trim());
      if (pp?.barcode) pieceBarcodes.push(String(pp.barcode).trim());
    }
    const existingSku = new Set();
    const existingBarcode = new Set();
    for (const part of chunks(pieceNos.filter(Boolean), 500)) for (const r of (await conn.query('SELECT sku_no FROM skus WHERE sku_no IN (?)', [part]))[0]) existingSku.add(lower(r.sku_no));
    for (const part of chunks(pieceBarcodes.filter(Boolean), 500)) for (const r of (await conn.query('SELECT barcode FROM skus WHERE barcode IN (?)', [part]))[0]) existingBarcode.add(lower(r.barcode));
    const designSeen = new Set();
    const skuSeen = new Set();
    const barcodeSeen = new Set();
    const generated = []; // sku numbers made up by the import, which may collide with a later explicit one
    for (const pd of sourceDesigns) {
      const nPieces = pd?.pieces?.length ?? 0;
      let design;
      const ref = typeof pd?.design_no === 'string' && pd.design_no.trim() ? pd.design_no.trim() : `design #${sourceDesigns.indexOf(pd) + 1}`;
      try {
        const designNo = text(pd.design_no, 64, 'design_no', true);
        if (designSeen.has(lower(designNo))) throw new Bad(`design number ${JSON.stringify(designNo)} appears more than once in the pack (ignoring case); the first one was kept`);
        if (existingDesigns.has(lower(designNo))) throw new Bad(`design number ${JSON.stringify(designNo)} already exists in the database`);
        const catName = String(pd.category ?? '').trim().toLowerCase();
        const cat = cats.find((c) => c.name.toLowerCase() === catName) ?? cats.find((c) => c.prefix.toLowerCase() === catName);
        if (!cat) throw new Bad(`unknown category ${JSON.stringify(pd.category)}`);
        let subId = null;
        if (pd.subcategory) {
          const sub = subs.find((s) => s.category_id === cat.id && s.name.toLowerCase() === String(pd.subcategory).trim().toLowerCase());
          if (sub) subId = sub.id;
          else report.warnings.push(`design ${designNo}: unknown sub-category ${JSON.stringify(pd.subcategory)} of ${cat.name}; it was left out`);
        }
        const tags = pd.tags === undefined ? [] : pd.tags;
        if (!Array.isArray(tags) || tags.some((t) => typeof t !== 'string')) throw new Bad('tags must be a list of text');
        design = {
          id: newId(), design_no: designNo, name: text(pd.name, 120, 'name'), category_id: cat.id, subcategory_id: subId,
          material: canon(pd.material, ['Gold', 'Silver'], 'material'), purity: text(pd.purity, 20, 'purity', true),
          selling_method: canon(pd.selling_method, ['By Weight', 'Per Piece'], 'selling_method'),
          description: text(pd.description, 60000, 'description'), notes: text(pd.notes, 60000, 'notes'), tags: JSON.stringify(tags),
        };
        designSeen.add(lower(designNo));
        designs.push(design);
        report.counts.designs.imported += 1;
      } catch (e) {
        if (!(e instanceof Bad)) throw e;
        report.counts.designs.rejected += 1;
        reject('designs', ref, e.message);
        for (let k = 0; k < nPieces; k++) reject('skus', pd.pieces[k]?.sku_no ? String(pd.pieces[k].sku_no).trim() : `${ref} piece #${k + 1}`, `its design ${ref} was rejected`);
        report.counts.pieces.rejected += nPieces;
        continue;
      }
      // numbers the design's pieces already use (explicit <design_no>-<digits>), so a generated one never repeats them
      const used = new Set();
      for (const pp of pd.pieces ?? []) {
        const s = String(pp?.sku_no ?? '').trim();
        if (s.toLowerCase().startsWith(`${design.design_no.toLowerCase()}-`) && /^\d+$/.test(s.slice(design.design_no.length + 1))) used.add(Number(s.slice(design.design_no.length + 1)));
      }
      let nextNo = 1;
      for (const [k, pp] of (pd.pieces ?? []).entries()) {
        let pref = pp?.sku_no ? String(pp.sku_no).trim() : `${design.design_no} piece #${k + 1}`;
        try {
          let skuNo = text(pp.sku_no, 64, 'sku_no');
          if (skuNo === null) {
            while (used.has(nextNo) || skuSeen.has(lower(`${design.design_no}-${String(nextNo).padStart(skuPadding, '0')}`)) || existingSku.has(lower(`${design.design_no}-${String(nextNo).padStart(skuPadding, '0')}`))) nextNo += 1;
            skuNo = `${design.design_no}-${String(nextNo).padStart(skuPadding, '0')}`;
            used.add(nextNo);
            generated.push(skuNo);
            if (skuNo.length > 64) throw new Bad(`the made-up piece number ${skuNo} is longer than 64 characters; give the piece its own number`);
          }
          pref = skuNo;
          if (skuSeen.has(lower(skuNo))) throw new Bad(`sku_no ${JSON.stringify(skuNo)} appears more than once in the pack (ignoring case)`);
          if (existingSku.has(lower(skuNo))) throw new Bad(`sku_no ${JSON.stringify(skuNo)} already exists in the database`);
          const barcode = text(pp.barcode, 64, 'barcode') ?? `${barcodePrefix}-${skuNo}`;
          if (barcode.length > 64) throw new Bad(`the made-up barcode ${barcode} is longer than 64 characters; give the piece its own barcode`);
          if (barcodeSeen.has(lower(barcode))) throw new Bad(`barcode ${JSON.stringify(barcode)} appears more than once in the pack (ignoring case)`);
          if (existingBarcode.has(lower(barcode))) throw new Bad(`barcode ${JSON.stringify(barcode)} already exists in the database`);
          const gross = dec(pp.gross_weight, 3, LIMITS.maxWeightGrams, 'gross_weight');
          const net = dec(pp.customer_net_weight, 3, LIMITS.maxWeightGrams, 'customer_net_weight');
          const original = pp.original_net_weight === undefined || pp.original_net_weight === null || pp.original_net_weight === '' ? null : dec(pp.original_net_weight, 3, LIMITS.maxWeightGrams, 'original_net_weight');
          const retail = pp.labour_retail === undefined || pp.labour_retail === null || pp.labour_retail === '' ? null : dec(pp.labour_retail, 2, LIMITS.maxRate, 'labour_retail');
          const wholesale = pp.labour_wholesale === undefined || pp.labour_wholesale === null || pp.labour_wholesale === '' ? null : dec(pp.labour_wholesale, 2, LIMITS.maxRate, 'labour_wholesale');
          let semi = pp.labour_semi === undefined || pp.labour_semi === null || pp.labour_semi === '' ? null : dec(pp.labour_semi, 2, LIMITS.maxRate, 'labour_semi');
          if (semi === null) {
            // the average of retail and wholesale, rounded half up to the paisa; with only one of them, that one; with neither, 0
            const have = [retail, wholesale].filter((x) => x !== null);
            const units = have.length === 2 ? (have[0].units + have[1].units + 1n) / 2n : have.length === 1 ? have[0].units : 0n;
            semi = { text: fromUnits(units, 2), units };
          }
          const status = pp.status === undefined || pp.status === null || pp.status === '' ? 'In Stock' : canon(pp.status, IMPORT_STATUSES, 'status');
          const piece = {
            id: newId(), design_id: design.id, sku_no: skuNo, barcode, gross_weight: gross.text, customer_net_weight: net.text,
            stones: int(pp.stones, 'stones'), stone_weight: dec(pp.stone_weight, 3, LIMITS.maxWeightGrams, 'stone_weight').text,
            kundan: int(pp.kundan, 'kundan'), kundan_weight: dec(pp.kundan_weight, 3, LIMITS.maxWeightGrams, 'kundan_weight').text,
            piroi: dec(pp.piroi, 2, LIMITS.maxAmount, 'piroi').text, labour_retail: (retail ?? { text: '0.00' }).text, labour_semi: semi.text, labour_wholesale: (wholesale ?? { text: '0.00' }).text,
            status, location: text(pp.location, 60, 'location'), notes: text(pp.notes, 60000, 'notes'), original: original ? original.text : null,
          };
          if (gross.units > 0n && net.units > gross.units) report.warnings.push(`piece ${skuNo}: the customer net weight ${net.text} is above the gross weight ${gross.text}`);
          if (design.selling_method === 'By Weight' && net.units === 0n) report.warnings.push(`piece ${skuNo}: a By Weight piece with net weight 0 cannot be priced`);
          skuSeen.add(lower(skuNo));
          barcodeSeen.add(lower(barcode));
          pieces.push(piece);
          report.counts.pieces.imported += 1;
        } catch (e) {
          if (!(e instanceof Bad)) throw e;
          report.counts.pieces.rejected += 1;
          reject('skus', pref, e.message);
        }
      }
    }

    if (opts.strict && report.rejected.length) {
      await conn.query('ROLLBACK');
      report.counts.customers.imported = report.counts.designs.imported = report.counts.pieces.imported = 0;
      report.ms = Date.now() - t0;
      return finish(report);
    }

    // ---- step: customers
    const customerCols = ['id', 'name', 'mobile', 'customer_type', 'email', 'address', 'gst_number', 'pan', 'notes', 'is_walkin', 'import_batch_id'];
    const customerRows = newCustomers.map((c) => [c.id, c.name, c.mobile, c.customer_type, c.email, c.address, c.gst_number, c.pan, c.notes, 0, batchId]);
    await bulkInsert(conn, 'customers', customerCols, customerRows);
    for (const row of customerRows) {
      audit('customers', row[0], Object.fromEntries(customerCols.map((k, i) => [k, row[i]])));
      stamp.customers.push(row[0]);
    }
    report.counts.customers.imported = customers.length;
    await hook('customers');

    // ---- step: designs
    const designCols = ['id', 'design_no', 'name', 'category_id', 'subcategory_id', 'material', 'purity', 'selling_method', 'description', 'notes', 'tags', 'import_batch_id'];
    const designRows = designs.map((d) => [d.id, d.design_no, d.name, d.category_id, d.subcategory_id, d.material, d.purity, d.selling_method, d.description, d.notes, d.tags, batchId]);
    await bulkInsert(conn, 'designs', designCols, designRows);
    for (const row of designRows) {
      audit('designs', row[0], Object.fromEntries(designCols.map((k, i) => [k, row[i]])));
      stamp.designs.push(row[0]);
    }
    await hook('designs');

    // ---- step: pieces and the owner-only weights
    const skuCols = ['id', 'design_id', 'sku_no', 'barcode', 'gross_weight', 'customer_net_weight', 'stones', 'stone_weight', 'kundan', 'kundan_weight', 'piroi', 'labour_retail', 'labour_semi', 'labour_wholesale', 'status', 'location', 'notes', 'import_batch_id'];
    const skuRows = pieces.map((p) => [p.id, p.design_id, p.sku_no, p.barcode, p.gross_weight, p.customer_net_weight, p.stones, p.stone_weight, p.kundan, p.kundan_weight, p.piroi, p.labour_retail, p.labour_semi, p.labour_wholesale, p.status, p.location, p.notes, batchId]);
    await bulkInsert(conn, 'skus', skuCols, skuRows);
    for (const row of skuRows) {
      audit('skus', row[0], Object.fromEntries(skuCols.map((k, i) => [k, row[i]])));
      stamp.skus.push(row[0]);
    }
    const privRows = pieces.filter((p) => p.original !== null).map((p) => [p.id, p.original]);
    await bulkInsert(conn, 'sku_private', ['sku_id', 'original_net_weight'], privRows);
    for (const [id, w] of privRows) {
      audit('sku_private', id, { sku_id: id, original_net_weight: w });
      stamp.sku_private.push(id);
    }
    await hook('skus');

    // ---- step: opening rows (D15)
    const walkBefore = await one(conn, `SELECT outstanding, advance FROM (${Q.V2_one}) cb`, [WALKIN_ID]);
    const opening = customers.filter((c) => c.dues.units > 0n || c.fine_due.units > 0n || c.advance.units > 0n || c.fine_advance.units > 0n);
    const billCols = ['id', 'bill_no', 'customer_id', 'bill_date', 'doc_type', 'sale_type', 'status', 'subtotal', 'grand_total', 'fine_weight_due', 'import_batch_id'];
    const billRows = [];
    const receiptCols = ['id', 'customer_id', 'kind', 'mode', 'amount', 'fine_grams', 'paid_on', 'reference', 'is_opening'];
    const receiptRows = [];
    for (const c of opening) {
      if (c.dues.units > 0n || c.fine_due.units > 0n) {
        const billNo = await nextOpeningNumber(conn);
        billRows.push([newId(), billNo, c.id, cutOver, 'opening_balance', c.customer_type, 'active', '0.00', c.dues.text, c.fine_due.text, batchId]);
      }
      if (c.advance.units > 0n) receiptRows.push([newId(), c.id, 'money', 'Other', c.advance.text, '0.000', cutOver, 'Opening advance', 1]);
      if (c.fine_advance.units > 0n) receiptRows.push([newId(), c.id, 'fine_silver', null, '0.00', c.fine_advance.text, cutOver, 'Opening advance', 1]);
    }
    await bulkInsert(conn, 'bills', billCols, billRows);
    await bulkInsert(conn, 'receipts', receiptCols, receiptRows);
    for (const row of billRows) {
      audit('bills', row[0], Object.fromEntries(billCols.map((k, i) => [k, row[i]])));
      stamp.bills.push(row[0]);
    }
    for (const row of receiptRows) {
      audit('receipts', row[0], Object.fromEntries(receiptCols.map((k, i) => [k, row[i]])));
      stamp.receipts.push(row[0]);
    }
    report.counts.opening_bills = billRows.length;
    report.counts.opening_advances = receiptRows.length;
    await hook('opening');

    // ---- step: rebalance (IM4): only a customer with dues AND an advance of the same kind can net off
    for (const c of opening) {
      const moneyNets = c.dues.units > 0n && c.advance.units > 0n;
      const fineNets = c.fine_due.units > 0n && c.fine_advance.units > 0n;
      if (!moneyNets && !fineNets) continue;
      const r = await rebalanceCustomer(conn, c.id, { newId });
      for (const a of r.allocations) {
        stamp.receipt_allocations.push(a.id);
        audit('receipt_allocations', a.id, { id: a.id, receipt_id: a.receipt_id, bill_id: a.bill_id, customer_id: c.id, amount: a.amount, fine_grams: a.fine_grams });
      }
      report.counts.allocations += r.allocations.length;
    }
    await hook('rebalance');

    // ---- step: audit rows (L1): no actor, the role import
    if (auditMode === 'import') {
      for (const part of chunks(audited, CHUNK)) {
        await conn.query(
          `INSERT INTO audit_log (actor, actor_role, request_id, table_name, row_id, action, new_row) VALUES ${part.map(() => "(NULL, 'import', NULL, ?, ?, 'insert', ?)").join(', ')}`,
          part.flatMap(([table, id, row]) => [table, String(id), JSON.stringify(row)])
        );
      }
    }
    await hook('audit');

    // ---- step: counters (IM3)
    await seedCounters(conn);
    await hook('counters');

    // ---- step: re-stamp and data_epoch (C4)
    const nowRow = await one(conn, "SELECT DATE_FORMAT(UTC_TIMESTAMP(6), '%Y-%m-%d %H:%i:%s.%f') AS now");
    for (const [table, ids] of Object.entries(stamp)) {
      const key = table === 'sku_private' ? 'sku_id' : 'id';
      for (const part of chunks(ids, 500)) await conn.query(`UPDATE ${q(table)} SET updated_at = ? WHERE ${q(key)} IN (?)`, [nowRow.now, part]);
    }
    await conn.query("INSERT INTO settings (setting_key, value) VALUES ('data_epoch', JSON_OBJECT('epoch', ?)) ON DUPLICATE KEY UPDATE value = JSON_OBJECT('epoch', ?)", [nowRow.now, nowRow.now]);
    await hook('restamp');

    // ---- reconciliation (IM6): what the database says against what the source says
    const imp = await one(conn, 
      "SELECT CAST(COALESCE(SUM(grand_total), 0) AS CHAR) AS dues, CAST(COALESCE(SUM(fine_weight_due), 0) AS CHAR) AS fine FROM bills WHERE import_batch_id = ? AND doc_type = 'opening_balance'", [batchId]
    );
    const adv = await one(conn, 
      `SELECT CAST(COALESCE(SUM(IF(r.kind = 'money', r.amount, 0)), 0) AS CHAR) AS advance, CAST(COALESCE(SUM(IF(r.kind = 'fine_silver', r.fine_grams, 0)), 0) AS CHAR) AS fine_advance
         FROM receipts r JOIN customers cu ON cu.id = r.customer_id WHERE cu.import_batch_id = ? AND r.is_opening = 1`, [batchId]
    );
    // the walk-in's dues were added to whatever it already had
    const walkinDues = customers.filter((c) => c.walkin).reduce((n, c) => n + c.dues.units, 0n);
    const walkDues = await one(conn, "SELECT CAST(COALESCE(SUM(grand_total), 0) AS CHAR) AS d, CAST(COALESCE(SUM(fine_weight_due), 0) AS CHAR) AS f FROM bills WHERE import_batch_id = ? AND customer_id = ?", [batchId, WALKIN_ID]);
    void walkinDues;
    report.totals = {
      dues_source: fromUnits(srcTotals.dues, 2), dues_imported: imp.dues,
      fine_source: fromUnits(srcTotals.fine, 3), fine_imported: imp.fine,
      advance_source: fromUnits(srcTotals.advance, 2), advance_imported: adv.advance,
      fine_advance_source: fromUnits(srcTotals.fineAdvance, 3), fine_advance_imported: adv.fine_advance,
    };
    const ids = customers.map((c) => c.id);
    const balances = new Map();
    for (const part of chunks(ids, 500)) for (const r of (await conn.query(`SELECT cb.id, cb.outstanding, cb.advance, cb.fine_outstanding, cb.fine_advance FROM (${Q.V2}) cb WHERE cb.id IN (?)`, [part]))[0]) balances.set(r.id, r);
    const net = (a, b) => (a > b ? [a - b, 0n] : [0n, b - a]);
    for (const c of customers) {
      const got = balances.get(c.id);
      let [out, advance] = net(c.dues.units, c.advance.units);
      let [fout, fadvance] = net(c.fine_due.units, c.fine_advance.units);
      if (c.walkin) {
        out += toUnits(walkBefore.outstanding, 2);
        advance += toUnits(walkBefore.advance, 2);
      }
      for (const [field, expected, actual, scale] of [['outstanding', out, got.outstanding, 2], ['advance', advance, got.advance, 2], ['fine_outstanding', fout, got.fine_outstanding, 3], ['fine_advance', fadvance, got.fine_advance, 3]]) {
        if (toUnits(actual, scale) !== expected) report.mismatches.push({ ref: c.ref, customer_id: c.id, field, expected: fromUnits(expected, scale), actual });
      }
    }
    await conn.query('UPDATE sys_import_batches SET row_counts = ? WHERE id = ?', [JSON.stringify({ customers: report.counts.customers.source, designs: report.counts.designs.source, pieces: report.counts.pieces.source, imported: { customers: customers.length, designs: designs.length, pieces: pieces.length }, opening_bills: billRows.length, opening_advances: receiptRows.length, allocations: report.counts.allocations }), batchId]);

    if (opts.dryRun) {
      await conn.query('ROLLBACK');
    } else {
      await conn.query('COMMIT');
      committed = true;
      report.batch.id = batchId;
    }
  } catch (e) {
    await conn.query('ROLLBACK').catch(() => undefined);
    throw e;
  }

  if (committed) {
    // fresh statistics for the tables a bulk load changed (ANALYZE ends any transaction, so it runs after the commit)
    for (const t of ['customers', 'designs', 'skus', 'sku_private', 'bills', 'receipts', 'receipt_allocations', 'sys_counters', 'audit_log']) await conn.query(`ANALYZE TABLE ${q(t)}`);
    const r = await runInvariants(conn);
    report.invariants = { ok: r.ok, counts: r.counts };
  }
  report.ms = Date.now() - t0;
  return finish(report);
}

function finish(report) {
  const t = report.totals;
  const totalsMatch = t.dues_source === undefined || (t.dues_source === t.dues_imported && t.fine_source === t.fine_imported && t.advance_source === t.advance_imported && t.fine_advance_source === t.fine_advance_imported);
  report.ok = report.rejected.length === 0 && report.mismatches.length === 0 && totalsMatch && (report.invariants === null || report.invariants.ok) && (report.dry_run || report.batch.id !== null);
  return report;
}

/**
 * OB-nnnn from the counter of the series 'opening' (L3), skipping any number that already exists (at most 100 tries). The number is the insertId of the counter UPDATE
 * (the OK packet of LAST_INSERT_ID(expr)), with no statement between: a SELECT LAST_INSERT_ID() could answer an audit id (RM4-6).
 */
async function nextOpeningNumber(conn) {
  await conn.query("INSERT INTO sys_counters (series, last_value) VALUES ('opening', 0) ON DUPLICATE KEY UPDATE series = series");
  for (let tries = 0; tries < 100; tries++) {
    const [res] = await conn.query("UPDATE sys_counters SET last_value = LAST_INSERT_ID(last_value + 1) WHERE series = 'opening'");
    if (!res.insertId) throw new Error('the counter UPDATE did not return the new number');
    const billNo = `OB-${String(Number(res.insertId)).padStart(4, '0')}`;
    const [exists] = await conn.query('SELECT 1 FROM bills WHERE bill_no = ?', [billNo]);
    if (exists.length === 0) return billNo;
  }
  throw new Error('no free OB- number in 100 tries');
}

// ------------------------------------------------------------------ the printed report (IM6)

export function formatReport(r) {
  const L = [];
  const pad = (s, n) => String(s).padEnd(n);
  L.push(r.dry_run ? 'IMPORT REPORT - DRY RUN: nothing was kept' : r.batch.id ? 'IMPORT REPORT - committed' : 'IMPORT REPORT - NOT committed');
  L.push(`batch: ${r.batch.name}${r.batch.id ? ` (${r.batch.id})` : ''}`);
  L.push('');
  for (const k of ['customers', 'designs', 'pieces']) L.push(`${pad(k, 11)} source ${r.counts[k].source}   imported ${r.counts[k].imported}   rejected ${r.counts[k].rejected}`);
  L.push(`opening bills ${r.counts.opening_bills}, opening advances ${r.counts.opening_advances}, allocations made ${r.counts.allocations}`);
  if (r.totals.dues_source !== undefined) {
    const t = r.totals;
    L.push('');
    L.push(`dues            source ${t.dues_source}   imported ${t.dues_imported}`);
    L.push(`silver owed     source ${t.fine_source} g   imported ${t.fine_imported} g`);
    L.push(`advances        source ${t.advance_source}   imported ${t.advance_imported}`);
    L.push(`silver advances source ${t.fine_advance_source} g   imported ${t.fine_advance_imported} g`);
  }
  L.push('');
  L.push(r.mismatches.length ? `OUTSTANDING / ADVANCE DIFFERS FROM THE SOURCE for ${r.mismatches.length} value(s):` : 'every customer\'s outstanding and advance match the source');
  for (const m of r.mismatches.slice(0, 50)) L.push(`  ${m.ref}: ${m.field} should be ${m.expected}, is ${m.actual}`);
  if (r.rejected.length) {
    L.push('');
    L.push(`REJECTED ROWS (${r.rejected.length}):`);
    for (const x of r.rejected.slice(0, 200)) L.push(`  ${x.table} ${x.ref}: ${x.reason}`);
    if (r.rejected.length > 200) L.push(`  ... and ${r.rejected.length - 200} more`);
  }
  if (r.warnings.length) {
    L.push('');
    L.push(`WARNINGS (${r.warnings.length}), stored as given:`);
    for (const w of r.warnings.slice(0, 200)) L.push(`  ${w}`);
  }
  if (r.invalid_mobiles.length) {
    L.push('');
    L.push(`MOBILE NUMBERS BLANK OR NOT VALID, to ask Siddhi for (${r.invalid_mobiles.length}):`);
    for (const m of r.invalid_mobiles.slice(0, 500)) L.push(`  ${m.ref}  ${m.name}  ${m.given ? `given ${JSON.stringify(m.given)}` : '(blank)'}`);
  }
  L.push('');
  L.push(r.invariants ? (r.invariants.ok ? 'nightly check on the committed data: passed' : `NIGHTLY CHECK FAILED: ${JSON.stringify(r.invariants.counts)}`) : 'nightly check: not run');
  L.push(`RESULT: ${r.ok ? 'OK' : 'NOT OK'}   (${r.ms} ms)`);
  return L.join('\n');
}
