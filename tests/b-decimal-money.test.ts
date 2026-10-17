import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Connection } from 'mysql2/promise';
import { appConn, dropDb, errorOf, ER, freshDb, rng } from './helpers';
import { formatGrams, formatRupees, priceBill, PricingError, type PriceBillInput } from '../oracle/pricing';
import { ExactPricingError, priceBill as exactPrice } from '../oracle/exact-decimal';
import { PricingError as ApiPricingError, priceBill as apiPriceBill } from '../src/domain/pricing';

// Spike (b): exact DECIMAL money in MariaDB against the BigInt oracle in oracle/pricing.ts (a snapshot of the app's pricing.ts). Rules R3 to R8 of the spec are written here in SQL, in
// src/domain/pricing.ts (the file the API runs and the screen previews with) and, since API18, a third time in oracle/exact-decimal.ts, written again from the spec and sharing no line with pricing.ts:
// T-A14 is that 200 random inputs agree in all three. (The snapshot of oracle/pricing.ts is the same code as pricing.ts and so could only agree with itself; the other two engines are independent.)

let db: string;
let c: Connection;

beforeAll(async () => {
  db = await freshDb('b_decimal');
  c = await appConn(db);
  await c.query(`CREATE TABLE bills (
      id INT PRIMARY KEY, sale_type VARCHAR(20) NOT NULL,
      discount DECIMAL(14,2) NOT NULL, additional DECIMAL(14,2) NOT NULL
    ) ENGINE=InnoDB`);
  await c.query(`CREATE TABLE bill_lines (
      bill_id INT NOT NULL, line_no INT NOT NULL, material VARCHAR(10) NOT NULL, method VARCHAR(10) NOT NULL,
      nw DECIMAL(12,3) NOT NULL, qty INT NOT NULL, rate DECIMAL(12,2) NOT NULL, labour DECIMAL(12,2) NOT NULL,
      piroi DECIMAL(12,2) NOT NULL, other DECIMAL(12,2) NOT NULL, PRIMARY KEY (bill_id, line_no)
    ) ENGINE=InnoDB`);
});

afterAll(async () => {
  await c.end();
  await dropDb(db);
});

/** R3 to R7 for every stored line. DECIMAL(12,3) x DECIMAL(12,2) is exact (scale 5, precision 24). */
const LINE_SQL = `
  SELECT l.bill_id, l.line_no,
    CASE WHEN b.sale_type = 'Wholesale' AND l.material = 'Silver' AND l.method = 'By Weight' THEN l.nw * l.qty ELSE 0 END AS fine_due,
    CASE WHEN l.method = 'By Weight' THEN ROUND(l.nw * l.labour, 2) ELSE 0 END AS labour_amount,
    CASE
      WHEN b.sale_type = 'Wholesale' AND l.material = 'Silver' AND l.method = 'By Weight' AND l.nw * l.qty > 0 THEN 0
      WHEN l.method = 'By Weight' THEN ROUND(l.nw * l.rate, 2)
      ELSE ROUND(l.rate * l.qty, 2)
    END AS metal_amount,
    l.piroi, l.other
  FROM bill_lines l JOIN bills b ON b.id = l.bill_id`;

const BILL_SQL = `
  SELECT t.bill_id, SUM(t.item_total) AS subtotal, SUM(t.fine_due) AS fine_due,
         b.discount, b.additional
  FROM (SELECT x.bill_id, x.fine_due, x.metal_amount + x.labour_amount + x.piroi + x.other AS item_total
        FROM (${LINE_SQL}) x) t
  JOIN bills b ON b.id = t.bill_id GROUP BY t.bill_id, b.discount, b.additional`;

type L = NonNullable<PriceBillInput['lines']>[number] & { lineNo: number };

function randomBill(rand: () => number, id: number) {
  const pick = <T,>(xs: T[]) => xs[Math.floor(rand() * xs.length)];
  const sale = pick(['Retail', 'Semi-Wholesale', 'Wholesale'] as const);
  const n = 1 + Math.floor(rand() * 5);
  const lines: L[] = [];
  for (let i = 0; i < n; i++) {
    const byWeight = rand() < 0.75;
    const wide = rand() < 0.1;
    lines.push({
      lineNo: i + 1,
      material: pick(['Gold', 'Silver'] as const),
      sellingMethod: byWeight ? 'By Weight' : 'Per Piece',
      customerNetWeightMg: Math.floor(rand() * (wide ? 100_000_000 : 400_000)),
      quantity: byWeight ? 1 : 1 + Math.floor(rand() * 20),
      metalRatePaise: Math.floor(rand() * (wide ? 100_000_000 : 1_500_000)),
      labourRatePaise: Math.floor(rand() * 90_000),
      piroiPaise: Math.floor(rand() * 20_000),
      otherChargesPaise: rand() < 0.3 ? Math.floor(rand() * 50_000) : 0,
    });
  }
  return { id, sale, lines, additionalPaise: rand() < 0.3 ? Math.floor(rand() * 100_000) : 0 };
}

async function loadBill(b: ReturnType<typeof randomBill>, discountPaise: number) {
  await c.query('INSERT INTO bills (id, sale_type, discount, additional) VALUES (?, ?, ?, ?)', [
    b.id, b.sale, formatRupees(discountPaise), formatRupees(b.additionalPaise),
  ]);
  const rows = b.lines.map((l) => [
    b.id, l.lineNo, l.material, l.sellingMethod, formatGrams(l.customerNetWeightMg), l.quantity ?? 1,
    formatRupees(l.metalRatePaise), formatRupees(l.labourRatePaise ?? 0), formatRupees(l.piroiPaise ?? 0), formatRupees(l.otherChargesPaise ?? 0),
  ]);
  await c.query('INSERT INTO bill_lines (bill_id, line_no, material, method, nw, qty, rate, labour, piroi, other) VALUES ?', [rows]);
}

describe('(b) DECIMAL money against the BigInt oracle', () => {
  it('the spec worked example: NW 35.42, rate 6920, labour 353, piroi 2.15, Retail, By Weight -> 257,612', async () => {
    await c.query('DELETE FROM bill_lines');
    await c.query('DELETE FROM bills');
    await c.query("INSERT INTO bills VALUES (1, 'Retail', 0, 0)");
    await c.query("INSERT INTO bill_lines VALUES (1, 1, 'Gold', 'By Weight', 35.420, 1, 6920.00, 353.00, 2.15, 0)");
    const [lines] = await c.query<any[]>(LINE_SQL);
    expect(lines[0].metal_amount).toBe('245106.40');
    expect(lines[0].labour_amount).toBe('12503.26');
    const [bill] = await c.query<any[]>(`SELECT ROUND(subtotal, 0) AS grand, subtotal FROM (${BILL_SQL}) q`);
    expect(bill[0].subtotal).toBe('257611.81');
    expect(bill[0].grand).toBe('257612');
  });

  it('3000 random bills (about 9000 lines, some at the caps): every line and bill figure equals the oracle', async () => {
    await c.query('DELETE FROM bill_lines');
    await c.query('DELETE FROM bills');
    const rand = rng(20261015);
    const expected = new Map<number, { lines: any[]; subtotal: string; grand: string; roundOff: string; fine: string }>();
    const skippedOverCap: number[] = [];
    let id = 0;
    const toLoad: ReturnType<typeof randomBill>[] = [];
    const discounts: number[] = [];
    while (id < 3000) {
      id++;
      const b = randomBill(rand, id);
      const base: PriceBillInput = { saleType: b.sale, lines: b.lines, additionalChargesPaise: b.additionalPaise, roundOffSetting: true };
      let priced;
      try {
        priced = priceBill(base);
      } catch (e) {
        expect(e).toBeInstanceOf(PricingError); // above the S4 caps: the oracle refuses, so the API will refuse before the database
        skippedOverCap.push(id);
        continue;
      }
      const discount = rand() < 0.4 ? Math.floor(rand() * (priced.subtotalPaise + b.additionalPaise)) : 0;
      priced = priceBill({ ...base, discountPaise: discount });
      expected.set(id, {
        lines: priced.lines,
        subtotal: formatRupees(priced.subtotalPaise),
        grand: formatRupees(priced.grandTotalPaise),
        roundOff: formatRupees(priced.roundOffPaise),
        fine: formatGrams(priced.fineWeightDueMg),
      });
      toLoad.push(b);
      discounts.push(discount);
    }
    for (let i = 0; i < toLoad.length; i++) await loadBill(toLoad[i], discounts[i]);

    const [lineRows] = await c.query<any[]>(LINE_SQL);
    let linesChecked = 0;
    for (const r of lineRows) {
      const exp = expected.get(Number(r.bill_id))!.lines[Number(r.line_no) - 1];
      expect(r.metal_amount, `bill ${r.bill_id} line ${r.line_no} metal`).toBe(formatRupees(exp.metalAmountPaise));
      expect(r.labour_amount, `bill ${r.bill_id} line ${r.line_no} labour`).toBe(formatRupees(exp.labourAmountPaise));
      expect(Number(r.fine_due) * 1000).toBeCloseTo(exp.fineWeightDueMg, 6);
      linesChecked++;
    }
    const [billRows] = await c.query<any[]>(`
      SELECT q.bill_id, q.subtotal, q.fine_due,
             ROUND(q.subtotal - q.discount + q.additional, 0) AS grand,
             ROUND(q.subtotal - q.discount + q.additional, 0) - (q.subtotal - q.discount + q.additional) AS round_off
      FROM (${BILL_SQL}) q`);
    for (const r of billRows) {
      const exp = expected.get(Number(r.bill_id))!;
      expect(r.subtotal, `bill ${r.bill_id} subtotal`).toBe(exp.subtotal);
      expect(r.grand.replace(/\.0+$/, '') + '.00', `bill ${r.bill_id} grand`).toBe(exp.grand);
      expect(Number(r.round_off).toFixed(2), `bill ${r.bill_id} round_off`).toBe(exp.roundOff);
    }
    console.log(`[b] bills compared: ${billRows.length}, lines compared: ${linesChecked}, bills the oracle refused over the S4 caps: ${skippedOverCap.length}`);
    expect(billRows.length).toBe(expected.size);
    expect(billRows.length).toBeGreaterThan(2000);
  });

  it('exact .5 ties round UP in DECIMAL (round half up); 20000 deliberate ties all match the oracle', async () => {
    const rand = rng(77);
    const cases: { mg: number; rate: number }[] = [];
    while (cases.length < 20000) {
      const mg = 1 + Math.floor(rand() * 900_000);
      const rate = 1 + Math.floor(rand() * 2_000_000);
      if ((mg * rate) % 1000 === 500) cases.push({ mg, rate });
    }
    const exactOk: boolean[] = [];
    const doubleWrong: number[] = [];
    for (let i = 0; i < cases.length; i += 1000) {
      const chunk = cases.slice(i, i + 1000);
      const sql = chunk
        .map(() => `SELECT ROUND(CAST(? AS DECIMAL(12,3)) * CAST(? AS DECIMAL(12,2)), 2) AS exact_amt, ROUND(CAST(? AS DOUBLE) * CAST(? AS DOUBLE), 2) AS dbl`)
        .join(' UNION ALL ');
      const params = chunk.flatMap((k) => [formatGrams(k.mg), formatRupees(k.rate), formatGrams(k.mg), formatRupees(k.rate)]);
      const [rows] = await c.query<any[]>(sql, params);
      rows.forEach((r, j) => {
        const k = chunk[j];
        const oracle = priceBill({
          saleType: 'Retail', roundOffSetting: false,
          lines: [{ material: 'Gold', sellingMethod: 'By Weight', customerNetWeightMg: k.mg, metalRatePaise: k.rate, labourRatePaise: 0 }],
        }).lines[0].metalAmountPaise;
        exactOk.push(r.exact_amt === formatRupees(oracle));
        if (Number(r.dbl).toFixed(2) !== formatRupees(oracle)) doubleWrong.push(i + j);
      });
    }
    expect(exactOk.every(Boolean)).toBe(true);
    console.log(`[b] ties checked: ${exactOk.length}; DECIMAL wrong: 0; DOUBLE columns would be wrong on ${doubleWrong.length}`);
    expect(doubleWrong.length).toBeGreaterThan(0); // proves the point: a float money column gives a different rupee figure
  });

  it('JS numbers are float: money crosses the wire as text (mysql2 gives DECIMAL back as a string)', async () => {
    const [rows] = await c.query<any[]>('SELECT CAST(257611.81 AS DECIMAL(14,2)) AS d, CAST(35.420 AS DECIMAL(12,3)) AS w');
    expect(rows[0].d).toBe('257611.81');
    expect(rows[0].w).toBe('35.420');
    expect(typeof rows[0].d).toBe('string');
    expect(0.1 + 0.2).not.toBe(0.3); // why a JS number is not used for rupees
  });

  it('TRAP 1: more decimals than the column are silently rounded, not refused -> the Node layer must validate (S4)', async () => {
    await c.query('CREATE TABLE rate_probe (r DECIMAL(12,2) NOT NULL)');
    await c.query("INSERT INTO rate_probe VALUES ('1.239')"); // no error in STRICT mode
    const [rows] = await c.query<any[]>('SELECT r FROM rate_probe');
    expect(rows[0].r).toBe('1.24');
    const [w] = await c.query<any[]>('SHOW WARNINGS');
    console.log('[b] warning for 1.239 into DECIMAL(12,2):', JSON.stringify(w));
    // A CHECK cannot catch it either: the value has already been rounded when the CHECK runs.
  });

  it('TRAP 2: over-range values: STRICT mode refuses (1264), a non-strict session silently clamps to the maximum', async () => {
    await c.query('CREATE TABLE cap_probe (amount DECIMAL(14,2) NOT NULL)');
    const err = await errorOf(() => c.query("INSERT INTO cap_probe VALUES ('10000000000000.00')"));
    expect(err?.errno).toBe(ER.OUT_OF_RANGE);
    const lax = await appConn(db);
    await lax.query("SET SESSION sql_mode = ''"); // what a server with an old default would give a new connection
    await lax.query("INSERT INTO cap_probe VALUES ('10000000000000.00')");
    const [rows] = await lax.query<any[]>('SELECT amount FROM cap_probe');
    expect(rows[0].amount).toBe('999999999999.99'); // invented money; so the API sets sql_mode on every connection
    await lax.end();
  });

  it('CHECK constraints can hold the S4 caps (named, error 4025) and negative values are refused', async () => {
    await c.query(`CREATE TABLE cap_check (
      amount DECIMAL(14,2) NOT NULL,
      CONSTRAINT chk_amount_cap CHECK (amount >= 0 AND amount <= 1000000000.00)
    )`);
    await c.query("INSERT INTO cap_check VALUES ('1000000000.00')");
    for (const bad of ['1000000000.01', '-0.01']) {
      const err = await errorOf(() => c.query('INSERT INTO cap_check VALUES (?)', [bad]));
      expect(err?.errno, bad).toBe(ER.CHECK_FAILED);
      expect(err?.message).toContain('chk_amount_cap');
    }
  });

  it('negative round_off (-0.40) and a bill of exactly 0 after a full discount are exact', async () => {
    const [rows] = await c.query<any[]>(
      "SELECT ROUND(CAST('1000.40' AS DECIMAL(14,2)), 0) - CAST('1000.40' AS DECIMAL(14,2)) AS ro, ROUND(CAST('0.50' AS DECIMAL(14,2)), 0) AS half_up, ROUND(CAST('-0.50' AS DECIMAL(14,2)), 0) AS neg_half"
    );
    expect(rows[0].ro).toBe('-0.40');
    expect(rows[0].half_up).toBe('1');
    expect(rows[0].neg_half).toBe('-1'); // away from zero for negatives (the rules only round values >= 0, R8)
  });
});

// ------------------------------------------------------------------ T-A14 (API18): the API's pricing.ts against the two independent engines

describe('T-A14 the API\'s pricing.ts equals the independent exact-decimal oracle and the SQL DECIMAL version on 200 random inputs (R12, C12)', () => {
  it('the exact-decimal oracle is its own text: it imports nothing and shares no long line with pricing.ts', () => {
    const oracle = readFileSync(new URL('../oracle/exact-decimal.ts', import.meta.url), 'utf8');
    const pricing = readFileSync(new URL('../src/domain/pricing.ts', import.meta.url), 'utf8');
    expect(oracle).not.toMatch(/^\s*import\s/m);
    const shared = oracle.split('\n').map((l) => l.trim()).filter((l) => l.length >= 40 && !l.startsWith('//') && !l.startsWith('*') && pricing.includes(l));
    expect(shared, 'oracle lines that also stand in pricing.ts').toEqual([]);
  });

  it('20,000 deliberate half-way cases (NW x rate ends in exactly half a paisa): pricing.ts and the exact-decimal oracle both round them up', () => {
    const rand = rng(78);
    let checked = 0;
    while (checked < 20000) {
      const mg = 1 + Math.floor(rand() * 900_000);
      const rate = 1 + Math.floor(rand() * 2_000_000);
      if ((mg * rate) % 1000 !== 500) continue;
      const line = { material: 'Gold', sellingMethod: 'By Weight', customerNetWeightMg: mg, metalRatePaise: rate, labourRatePaise: rate } as const;
      const input = { saleType: 'Retail', roundOffSetting: false, lines: [line] } as const;
      const a = apiPriceBill(input).lines[0];
      const e = exactPrice(input).lines[0];
      expect(a.metalAmountPaise, `${mg} mg x ${rate}`).toBe((mg * rate - 500) / 1000 + 1); // the product is k + 0.5 paise: the larger neighbour
      expect(a, `${mg} mg x ${rate}`).toEqual(e);
      checked++;
    }
  });

  it('200 random bills (some at the caps, some over them): pricing.ts and the exact-decimal oracle give the same figures or both refuse, and the accepted bills equal the SQL DECIMAL figures', async () => {
    await c.query('DELETE FROM bill_lines');
    await c.query('DELETE FROM bills');
    const rand = rng(20261016);
    let accepted = 0;
    let refused = 0;
    const loaded: { b: ReturnType<typeof randomBill>; discount: number; priced: ReturnType<typeof exactPrice> }[] = [];
    for (let id = 1; id <= 200; id++) {
      const b = randomBill(rand, id);
      const base: PriceBillInput = { saleType: b.sale, lines: b.lines, additionalChargesPaise: b.additionalPaise, roundOffSetting: true };
      const outcome = (fn: (i: PriceBillInput) => unknown, input: PriceBillInput) => {
        try {
          return { ok: true as const, value: fn(input) };
        } catch (e) {
          return { ok: false as const, code: (e as { code?: string }).code, isPricingError: e instanceof ExactPricingError || e instanceof ApiPricingError };
        }
      };
      const first = outcome(apiPriceBill, base);
      const second = outcome(exactPrice, base);
      expect(first.ok, `bill ${id}: pricing.ts and the exact-decimal oracle must both accept or both refuse`).toBe(second.ok);
      if (!first.ok || !second.ok) {
        expect(first).toMatchObject({ code: 'JV_INVALID_INPUT', isPricingError: true });
        refused++;
        continue;
      }
      const subtotal = (second.value as ReturnType<typeof exactPrice>).subtotalPaise;
      const discount = rand() < 0.4 ? Math.floor(rand() * (subtotal + b.additionalPaise)) : 0;
      const full = { ...base, discountPaise: discount, roundOffSetting: rand() < 0.5 };
      const api = apiPriceBill(full);
      const oracle = exactPrice(full);
      expect(api, `bill ${id}`).toEqual(oracle);
      if (full.roundOffSetting) loaded.push({ b, discount, priced: oracle });
      accepted++;
    }
    for (const { b, discount } of loaded) await loadBill(b, discount);

    const [lineRows] = await c.query<any[]>(LINE_SQL);
    const [billRows] = await c.query<any[]>(`
      SELECT q.bill_id, q.subtotal, q.fine_due,
             ROUND(q.subtotal - q.discount + q.additional, 0) AS grand,
             ROUND(q.subtotal - q.discount + q.additional, 0) - (q.subtotal - q.discount + q.additional) AS round_off
      FROM (${BILL_SQL}) q`);
    const byId = new Map(loaded.map((l) => [l.b.id, l]));
    for (const r of lineRows) {
      const e = byId.get(Number(r.bill_id))!.priced.lines[Number(r.line_no) - 1];
      expect(r.metal_amount, `bill ${r.bill_id} line ${r.line_no} metal`).toBe(formatRupees(e.metalAmountPaise));
      expect(r.labour_amount, `bill ${r.bill_id} line ${r.line_no} labour`).toBe(formatRupees(e.labourAmountPaise));
    }
    for (const r of billRows) {
      const e = byId.get(Number(r.bill_id))!.priced;
      expect(r.subtotal, `bill ${r.bill_id} subtotal`).toBe(formatRupees(e.subtotalPaise));
      expect(r.grand.replace(/\.0+$/, '') + '.00', `bill ${r.bill_id} grand`).toBe(formatRupees(e.grandTotalPaise));
      expect(Number(r.round_off).toFixed(2), `bill ${r.bill_id} round_off`).toBe(formatRupees(e.roundOffPaise));
      expect(Number(r.fine_due).toFixed(3), `bill ${r.bill_id} fine`).toBe(formatGrams(e.fineWeightDueMg));
    }
    console.log(`[T-A14] 200 random bills: ${accepted} accepted by pricing.ts and the exact-decimal oracle (equal), ${refused} refused by both over a cap; ${billRows.length} bills (with the round-off setting on) equal the SQL DECIMAL figures`);
    expect(accepted + refused).toBe(200);
    expect(billRows.length).toBe(loaded.length);
    expect(loaded.length).toBeGreaterThan(50);
  });
});
