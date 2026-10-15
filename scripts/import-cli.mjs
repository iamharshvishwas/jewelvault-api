#!/usr/bin/env node
// The import command Harsh runs on his Mac (IM1). The connection comes ONLY from the environment; nothing about it is in the repository or on the command line:
//   DB_HOST DB_PORT DB_NAME DB_USER DB_PASSWORD
// Usage:
//   node scripts/import-cli.mjs --pack pack.json [--dry-run] [--strict] [--audit none]
//   node scripts/import-cli.mjs --seed-counters
// Run it against the STAGING database first and on production only when the report is clean and Siddhi has signed the opening balances (IM8).
// Exit code: 0 clean, 1 the import was refused or the report is not OK, 2 the command line or the settings are wrong.
import { readFileSync } from 'node:fs';
import mysql from 'mysql2/promise';
import { formatReport, runImport, seedCounters } from './import.mjs';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const fail = (code, message) => {
  console.error(message);
  process.exit(code);
};

const seedOnly = flag('--seed-counters');
const packFile = value('--pack');
if (!seedOnly && !packFile) fail(2, 'usage: node scripts/import-cli.mjs --pack pack.json [--dry-run] [--strict] [--audit none]   |   --seed-counters');
const audit = value('--audit') ?? 'import';
if (!['import', 'none'].includes(audit)) fail(2, '--audit must be import or none');

const missing = ['DB_HOST', 'DB_NAME', 'DB_USER', 'DB_PASSWORD'].filter((k) => !process.env[k]);
if (missing.length) fail(2, `missing settings in the environment: ${missing.join(', ')} (the connection is never taken from a file or the command line)`);

let pack;
if (!seedOnly) {
  try {
    pack = JSON.parse(readFileSync(packFile, 'utf8'));
  } catch (e) {
    fail(2, `cannot read the pack ${packFile}: ${e.message}`);
  }
}

const conn = await mysql.createConnection({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  charset: 'utf8mb4',
  connectTimeout: 15000,
  decimalNumbers: false,
  supportBigNumbers: true,
  bigNumberStrings: true,
  dateStrings: true,
  multipleStatements: false,
});
try {
  await conn.query("SET SESSION transaction_isolation = 'READ-COMMITTED'");
  await conn.query("SET SESSION time_zone = '+00:00'");
  await conn.query('SET SESSION max_statement_time = 120');
  if (seedOnly) {
    await conn.query('START TRANSACTION');
    const done = await seedCounters(conn);
    await conn.query('COMMIT');
    for (const s of done) console.log(`${s.series}: seed ${s.seed_value}`);
    process.exit(0);
  }
  const report = await runImport(conn, pack, { dryRun: flag('--dry-run'), strict: flag('--strict'), audit });
  console.log(formatReport(report));
  process.exitCode = report.ok ? 0 : 1;
} catch (e) {
  console.error(`import refused: ${e.message}`);
  process.exitCode = 1;
} finally {
  await conn.end().catch(() => undefined);
}
