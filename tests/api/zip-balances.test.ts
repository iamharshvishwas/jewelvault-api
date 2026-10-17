import { crc32, deflateRawSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Connection } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dropDb } from '../helpers';
import { balancesFromZip, compareWithDatabase, formatComparison, parseCsv, readZip } from '../../scripts/zip-balances.mjs';
import { T, ledgerWorld, migratedDb } from '../schema/support';
import { tempDir, cleanUp } from './restore-support';

// T-R05, the drill half (B3): "each customer's balance (outstanding, advance, fine_outstanding) is rebuilt from the zip alone and compared with customer_balances".
// scripts/zip-balances.mjs reads the owner's "Download everything" zip (WEB12b builds it in the browser) with no database, and compares the figures with V2 (the nightly check's own query).
// The zip is made here from the database the way the browser makes it: one CSV per table with the database's column names, cells starting with = + - @ tab or CR written with a quote in front.

let c: Connection;
let db: string;
let world: Awaited<ReturnType<typeof ledgerWorld>>;
beforeAll(async () => {
  const m = await migratedDb('zipbal');
  c = m.c;
  db = m.db;
  world = await ledgerWorld(c);
}, 60_000);
afterAll(async () => {
  await c.end();
  await dropDb(db);
  await cleanUp();
});

const csvCell = (v: unknown) => {
  if (v === null || v === undefined) return '';
  let s = String(v);
  if (/^[=+@\t\r]/.test(s) || (/^-/.test(s) && !/^-\d+(\.\d+)?$/.test(s))) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const serialize = (p: { header: string[]; rows: string[][] }) => [p.header.join(','), ...p.rows.map((r) => r.map(csvCell).join(','))].join('\r\n') + '\r\n';
const toCsv = (rows: Record<string, unknown>[], cols?: string[]) => {
  const names = cols ?? Object.keys(rows[0] ?? {});
  return [names.join(','), ...rows.map((r) => names.map((n) => csvCell(r[n])).join(','))].join('\r\n') + '\r\n';
};

/** A minimal zip writer (stored or deflated entries, a central directory): enough to make the file the browser makes. */
function makeZip(files: Record<string, string>, opts: { deflate?: boolean; folder?: string } = {}) {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [rawName, text] of Object.entries(files)) {
    const name = Buffer.from((opts.folder ?? '') + rawName);
    const data = Buffer.from(text, 'utf8');
    const body = opts.deflate ? deflateRawSync(data) : data;
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(opts.deflate ? 8 : 0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    parts.push(local, name, body);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt16LE(opts.deflate ? 8 : 0, 10);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(body.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(name.length, 28);
    cen.writeUInt32LE(offset, 42);
    central.push(cen, name);
    offset += local.length + name.length + body.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, end]);
}

async function dumpFiles(): Promise<Record<string, string>> {
  const rows = async (table: string) => (await c.query<any[]>(`SELECT * FROM \`${table}\``))[0].map((r) => ({ ...r }));
  const files: Record<string, string> = {};
  const counts: Record<string, number> = {};
  for (const [file, table] of [['customers.csv', 'customers'], ['bills.csv', 'bills'], ['receipts.csv', 'receipts'], ['receipt_allocations.csv', 'receipt_allocations'], ['bill_items.csv', 'bill_items']] as const) {
    const r = await rows(table);
    files[file] = toCsv(r, r.length ? undefined : (await c.query<any[]>(`SHOW COLUMNS FROM \`${table}\``))[0].map((x) => x.Field));
    counts[file] = r.length;
  }
  files['MANIFEST.csv'] = toCsv(Object.entries(counts).map(([file, rows]) => ({ file, rows, date: '2026-10-17' })));
  return files;
}
const v2Rows = async () => (await c.query<any[]>(`SELECT id, outstanding, advance, fine_outstanding FROM ${T.customer_balances} ORDER BY id`))[0];

describe('T-R05 balances rebuilt from the zip alone (scripts/zip-balances.mjs)', () => {
  it('reads CSV the way spreadsheets write it: quotes, commas, line breaks inside a cell, a byte-order mark, CRLF and LF', () => {
    const csv = '﻿id,name,note\r\n1,"Siddhi, J","line one\nline two"\r\n2,"say ""hi""",\r\n3,x,\n';
    expect(parseCsv(csv)).toEqual({ header: ['id', 'name', 'note'], rows: [['1', 'Siddhi, J', 'line one\nline two'], ['2', 'say "hi"', ''], ['3', 'x', '']] });
    expect(parseCsv('a,b\n')).toEqual({ header: ['a', 'b'], rows: [] });
    expect(() => parseCsv('a,"b\n')).toThrow(/unterminated|quote/i);
  });

  it('reads a zip with stored or deflated entries and a folder prefix, and refuses what is not a zip', () => {
    for (const deflate of [false, true]) {
      const z = readZip(makeZip({ 'a.csv': 'x,y\n1,2\n', 'MANIFEST.csv': 'file,rows\n' }, { deflate, folder: 'jewelvault-2026-10-17/' }));
      expect([...z.keys()].sort()).toEqual(['jewelvault-2026-10-17/MANIFEST.csv', 'jewelvault-2026-10-17/a.csv']);
      expect(z.get('jewelvault-2026-10-17/a.csv')!.toString('utf8')).toBe('x,y\n1,2\n');
    }
    expect(() => readZip(Buffer.from('definitely not a zip file at all, just text'))).toThrow(/not a zip/);
  });

  it('every customer\'s outstanding, advance and fine_outstanding from the zip alone equal customer_balances (cancelled bills, voided receipts, released allocations, refunds, silver, opening dues)', async () => {
    const zip = makeZip(await dumpFiles(), { deflate: true });
    const balances = balancesFromZip(zip);
    expect(balances.customers.size).toBe((await v2Rows()).length);
    const cmp = await compareWithDatabase(c, balances);
    expect(cmp.mismatches).toEqual([]);
    expect(cmp.ok).toBe(true);
    expect(cmp.checked).toBe(balances.customers.size);
    // the data set really has the hard cases; the figures of customer 1 are the ones worked out by hand in s9-views
    const mine = balances.customers.get(world.c1.id)!;
    expect([mine.outstanding, mine.advance, mine.balance]).toEqual(['2300.50', '150.00', '2150.50']);
    expect([mine.fine_outstanding, mine.fine_advance]).toEqual(['5.000', '0.000']);
    expect(formatComparison(cmp)).toMatch(/all \d+ customers agree/);
  });

  it('negative control: one changed amount in the zip is found, named by customer and field', async () => {
    const files = await dumpFiles();
    const bills = parseCsv(files['bills.csv']);
    const gt = bills.header.indexOf('grand_total');
    const cust = bills.header.indexOf('customer_id');
    const row = bills.rows.find((r) => r[cust] === world.c1.id && r[gt] === '1000.00')!;
    row[gt] = '1000.01';
    files['bills.csv'] = serialize(bills);
    const cmp = await compareWithDatabase(c, balancesFromZip(makeZip(files)));
    expect(cmp.ok).toBe(false);
    expect(cmp.mismatches).toContainEqual({ customer_id: world.c1.id, field: 'outstanding', zip: '2300.51', database: '2300.50' });
    expect(cmp.mismatches.every((m) => m.customer_id === world.c1.id)).toBe(true);
    expect(formatComparison(cmp)).toContain(world.c1.id);
    expect(formatComparison(cmp)).toMatch(/outstanding.*zip 2300\.51.*database 2300\.50/);
  });

  it('a customer only in the zip, or only in the database, is a mismatch too', async () => {
    const files = await dumpFiles();
    const customers = parseCsv(files['customers.csv']);
    const ghost = customers.header.map(() => '');
    ghost[customers.header.indexOf('id')] = '99999999-9999-4999-8999-999999999999';
    const withGhost = parseCsv(files['customers.csv']);
    withGhost.rows.push(ghost);
    const cmp = await compareWithDatabase(c, balancesFromZip(makeZip({ ...files, 'customers.csv': serialize(withGhost) })));
    expect(cmp.onlyInZip).toEqual(['99999999-9999-4999-8999-999999999999']);
    expect(cmp.ok).toBe(false);
    const dropped = parseCsv(files['customers.csv']);
    const lost = dropped.rows.shift()![dropped.header.indexOf('id')];
    const cmp2 = await compareWithDatabase(c, balancesFromZip(makeZip({ ...files, 'customers.csv': serialize(dropped) })));
    expect(cmp2.onlyInDatabase).toEqual([lost]);
    expect(cmp2.ok).toBe(false);
    expect(formatComparison(cmp2)).toContain(lost);
  });

  it('says which file or column the zip lacks, in plain words', async () => {
    const files = await dumpFiles();
    const noBills = { ...files };
    delete noBills['bills.csv'];
    expect(() => balancesFromZip(makeZip(noBills))).toThrow(/bills\.csv is not in the zip/);
    const noColumn = { ...files, 'receipts.csv': files['receipts.csv'].replace('fine_grams', 'silver') };
    expect(() => balancesFromZip(makeZip(noColumn))).toThrow(/receipts\.csv has no column fine_grams/);
  });

  it('MANIFEST.csv: the row counts it names must equal the rows in the files; a short file is reported', async () => {
    const files = await dumpFiles();
    expect(balancesFromZip(makeZip(files)).manifest).toEqual({ checked: true, problems: [] });
    const lines = files['MANIFEST.csv'].split('\r\n');
    const i = lines.findIndex((l) => l.startsWith('bills.csv'));
    lines[i] = lines[i].replace(/,\d+,/, ',999,');
    const m = balancesFromZip(makeZip({ ...files, 'MANIFEST.csv': lines.join('\r\n') })).manifest;
    expect(m.checked).toBe(true);
    expect(m.problems.join(' ')).toMatch(/bills\.csv: the manifest says 999 rows, the file has/);
    const none = { ...files };
    delete none['MANIFEST.csv'];
    expect(balancesFromZip(makeZip(none)).manifest.checked).toBe(false);
  });

  it('works from a file path as well, and does not touch money as a float (an amount with many digits stays exact)', async () => {
    const files = await dumpFiles();
    const dir = tempDir('jv zip ');
    const f = path.join(dir, 'download.zip');
    writeFileSync(f, makeZip(files));
    const a = balancesFromZip(f);
    const b = balancesFromZip(makeZip(files));
    expect([...a.customers.entries()]).toEqual([...b.customers.entries()]);
    const exact = balancesFromZip(
      makeZip({
        'customers.csv': 'id\r\nc1\r\n',
        'bills.csv': 'customer_id,status,doc_type,grand_total,fine_weight_due\r\nc1,active,estimate,999999999999999.99,0.001\r\nc1,active,estimate,0.01,0.002\r\n',
        'receipts.csv': 'id,customer_id,status,kind,amount,fine_grams\r\n',
        'receipt_allocations.csv': 'receipt_id,customer_id,amount,fine_grams,released_at\r\n',
      })
    );
    expect(exact.customers.get('c1')!.outstanding).toBe('1000000000000000.00');
    expect(exact.customers.get('c1')!.fine_outstanding).toBe('0.003');
  });
});
