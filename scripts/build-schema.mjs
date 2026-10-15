#!/usr/bin/env node
// Writes db/schema.sql and db/seed.sql (the migrations and the seeds joined, for pasting into phpMyAdmin).
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSchemaSql, buildSeedSql } from './migrate.mjs';

const db = join(dirname(fileURLToPath(import.meta.url)), '..', 'db');
writeFileSync(join(db, 'schema.sql'), buildSchemaSql());
writeFileSync(join(db, 'seed.sql'), buildSeedSql());
console.log('wrote db/schema.sql and db/seed.sql');
