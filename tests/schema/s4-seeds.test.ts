import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Connection } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dropDb } from '../helpers';
import { migrate } from '../../scripts/migrate.mjs';
import { migratedDb, migrationConn } from './support';

// D20: seeds on an empty database and nothing else. Never sample data.

let db: string;
let c: Connection;
beforeAll(async () => {
  ({ db, c } = await migratedDb('s4_seeds'));
});
afterAll(async () => {
  await c.end();
  await dropDb(db);
});

const json = (v: unknown) => (typeof v === 'string' ? JSON.parse(v) : v) as any;

describe('seeds', () => {
  it('the walk-in customer exists once, with the fixed id of K5', async () => {
    const [r] = await c.query<any[]>("SELECT id, name, customer_type, is_walkin, mobile, pan FROM customers WHERE is_walkin = 1");
    expect(r).toHaveLength(1);
    expect(r[0].id).toBe('00000000-0000-4000-8000-000000000001');
    expect(r[0].name).toBe('Walk-in Customer');
    expect(r[0].mobile).toBeNull();
  });

  it('settings: one row per key, the keys of D3 plus the photo rule; no gold or silver rate and no user list (those moved)', async () => {
    const [r] = await c.query<any[]>('SELECT setting_key AS k, value FROM settings ORDER BY 1');
    expect(r.map((x) => x.k)).toEqual(['business', 'custom_fields', 'data_epoch', 'estimate', 'locations', 'materials', 'numbering', 'photos', 'tag_template', 'taxes']);
    const by = Object.fromEntries(r.map((x) => [x.k, json(x.value)]));
    expect(by.estimate).toEqual({ prefix: 'JV', roundOff: true, footerNote: 'This is an estimate only. GST is not charged on this document.' });
    expect(by.materials).toEqual([
      { name: 'Gold', purities: ['18K', '20K', '22K', '24K'] },
      { name: 'Silver', purities: ['800', '925', '999'] },
    ]);
    expect(by.locations).toEqual(['Main Showroom', 'Jaishri Vault', 'Workshop', 'Exhibition']);
    expect(by.numbering).toMatchObject({ designPadding: 5, skuPadding: 3, barcodePrefix: 'BC' });
    expect(by.business).toMatchObject({ legalName: 'Jaishri Gold Palace Pvt Ltd', displayName: 'Jaishri Gold Palace' });
    expect(by.taxes).toEqual({ gstEnabled: false, gstPercent: 0, estimateTaxPercent: 0 });
    expect(typeof by.data_epoch.epoch === 'string' || typeof by.data_epoch === 'string').toBe(true);
  });

  it('photo rule (Harsh, 15 Oct 2026): at most 3 per design, longest side 1000 px, JPEG quality 72, thumbnail 320 px, 2 MiB', async () => {
    const [r] = await c.query<any[]>("SELECT value FROM settings WHERE setting_key = 'photos'");
    expect(json(r[0].value)).toEqual({ maxPerDesign: 3, maxSidePx: 1000, jpegQuality: 0.72, thumbSidePx: 320, maxBytes: 2097152 });
  });

  it('categories and prefixes of the prototype (15), four sub-categories each', async () => {
    const [cats] = await c.query<any[]>('SELECT name, prefix FROM categories ORDER BY name');
    expect(cats).toHaveLength(15);
    expect(Object.fromEntries(cats.map((x) => [x.name, x.prefix]))).toMatchObject({ 'Necklace Set': 'SET', 'Pendant Set': 'PSET', Ring: 'RING', Earrings: 'ER', 'Nose Pin': 'NP', Other: 'OTH' });
    const [subs] = await c.query<any[]>('SELECT c.name AS cat, GROUP_CONCAT(s.name ORDER BY s.name) AS subs FROM subcategories s JOIN categories c ON c.id = s.category_id GROUP BY c.name');
    expect(subs).toHaveLength(15);
    for (const s of subs) expect(s.subs).toBe('Casting,Handmade,Jadau,Kundan');
  });

  it('nothing else is seeded: no rates, designs, pieces, bills, receipts, users, sessions, counters', async () => {
    for (const t of ['daily_rates', 'designs', 'design_photos', 'skus', 'sku_private', 'bills', 'bill_items', 'receipts', 'receipt_allocations', 'users', 'sessions', 'sys_counters', 'sys_idempotency', 'audit_log', 'check_runs', 'backup_runs', 'sys_photo_copies']) {
      const [r] = await c.query<any[]>(`SELECT COUNT(*) AS n FROM \`${t}\``);
      expect(Number(r[0].n), t).toBe(0);
    }
    const [n] = await c.query<any[]>('SELECT COUNT(*) AS n FROM customers');
    expect(Number(n[0].n)).toBe(1);
  });

  it('seeds can be applied again without duplicates or errors', async () => {
    const m = await migrationConn(db);
    await migrate(m, { seeds: true });
    await migrate(m, { seeds: true });
    await m.end();
    const [a] = await c.query<any[]>('SELECT COUNT(*) AS n FROM categories');
    const [b] = await c.query<any[]>('SELECT COUNT(*) AS n FROM settings');
    const [d] = await c.query<any[]>('SELECT COUNT(*) AS n FROM customers');
    expect([Number(a[0].n), Number(b[0].n), Number(d[0].n)]).toEqual([15, 10, 1]);
  });

  it('a seed never overwrites a value the owner changed (settings are inserted only if missing)', async () => {
    await c.query("UPDATE settings SET value = JSON_SET(value, '$.prefix', 'ZZ') WHERE setting_key = 'estimate'");
    const m = await migrationConn(db);
    await migrate(m, { seeds: true });
    await m.end();
    const [r] = await c.query<any[]>("SELECT JSON_VALUE(value, '$.prefix') AS p FROM settings WHERE setting_key = 'estimate'");
    expect(r[0].p).toBe('ZZ');
  });

  it('the seed files are plain SQL files in db/seeds, numbered above the migrations', () => {
    const files = readdirSync(join(__dirname, '..', '..', 'db', 'seeds')).filter((f) => f.endsWith('.sql')).sort();
    expect(files.length).toBeGreaterThanOrEqual(3);
    for (const f of files) {
      expect(f).toMatch(/^\d{4}_[a-z0-9_]+\.sql$/);
      expect(readFileSync(join(__dirname, '..', '..', 'db', 'seeds', f), 'utf8')).not.toMatch(/\bDELETE\b|\bTRUNCATE\b|\bDROP\b/i);
    }
  });
});
