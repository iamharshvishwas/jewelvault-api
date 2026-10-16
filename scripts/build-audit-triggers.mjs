#!/usr/bin/env node
// Writes db/optional/0910_audit_triggers.sql (L1 (a)) from a database that has the migrations applied (NOT the optional files):
//   DB_HOST DB_PORT DB_NAME DB_USER DB_PASSWORD   a scratch database, for example the local one of npm run db:up after npm run db:migrate
//   node scripts/build-audit-triggers.mjs            writes the file
//   node scripts/build-audit-triggers.mjs --check    writes nothing; exit 1 when the file is out of date
import { readFileSync, writeFileSync } from 'node:fs';
import mysql from 'mysql2/promise';
import { TRIGGER_FILE, generateAuditTriggersSql } from './audit-triggers.mjs';

const check = process.argv.includes('--check');
const missing = ['DB_HOST', 'DB_NAME', 'DB_USER', 'DB_PASSWORD'].filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`missing settings in the environment: ${missing.join(', ')}`);
  process.exit(2);
}
const conn = await mysql.createConnection({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});
try {
  const sql = await generateAuditTriggersSql(conn);
  if (check) {
    const current = readFileSync(TRIGGER_FILE, 'utf8');
    if (current !== sql) {
      console.error('db/optional/0910_audit_triggers.sql is out of date: run node scripts/build-audit-triggers.mjs and commit the result');
      process.exit(1);
    }
    console.log('db/optional/0910_audit_triggers.sql is up to date');
  } else {
    writeFileSync(TRIGGER_FILE, sql);
    console.log(`wrote ${TRIGGER_FILE}`);
  }
} finally {
  await conn.end();
}
