#!/usr/bin/env node
// npm run check:pricing [-- <path to the app's src/lib/pricing.ts>] [--root <folder>]   (spec C12, T-A14, NODE-DESIGN 1.4)
//
// The API runs the app's pricing file, byte for byte, as src/domain/pricing.ts. PRICING-SOURCE.txt names the app's commit and the SHA-256 of that file; this script is how the two are kept the same.
//
//   with no path   (npm run verify): the API's copy has the SHA-256 that PRICING-SOURCE.txt names; the hash that GET /v1/auth/me returns (PRICING_SHA256 in src/auth/loginRoutes.ts) is the same one;
//                  and the copy of the app's pricing unit tests (tests/pricing.test.ts) is the one that was recorded.
//   with the path of the app's own src/lib/pricing.ts (whoever changes either file; the orchestrator's "verify main" step, when both repositories are on one disk): the app's file is the very same
//                  bytes as the API's copy, and, when the app's tests/unit/pricing.test.ts is next to it, the API's copy of the tests is that file with only the documented line changed.
//
// Exit 0 when everything agrees, 1 and a line for each difference when not. It reads files and nothing else (no git, no network). --root is the API folder to check (default: this repository).
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The lines of the app's test that the API's copy changes, and nothing else: the C12 test reads the source of pricing.ts to see that it holds no floating point, and the copy sits in tests/ and the
 * file in src/domain/. (The test's import of '@/lib/pricing' is the same text in both: vitest.config.ts and tsconfig.json map that name to the API's copy.)
 */
const TEST_COPY_EDITS = [["new URL('../../src/lib/pricing.ts', import.meta.url)", "new URL('../src/domain/pricing.ts', import.meta.url)"]];

const args = process.argv.slice(2);
let root = join(dirname(fileURLToPath(import.meta.url)), '..');
let appPricing = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--root') root = resolve(args[++i] ?? '');
  else if (appPricing === null) appPricing = resolve(args[i]);
  else {
    console.error(`unexpected argument: ${args[i]}`);
    process.exit(2);
  }
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const problems = [];
const notes = [];
const readOrNull = (file) => (existsSync(file) ? readFileSync(file) : null);

const noteFile = join(root, 'PRICING-SOURCE.txt');
const noteBytes = readOrNull(noteFile);
if (noteBytes === null) {
  console.error(`check:pricing FAILED\n  PRICING-SOURCE.txt is missing (${noteFile})`);
  process.exit(1);
}
const recorded = {};
for (const line of noteBytes.toString('utf8').split('\n')) {
  const m = /^([a-z0-9_]+):\s*(\S+)\s*$/.exec(line);
  if (m) recorded[m[1]] = m[2];
}
for (const [name, pattern] of [['commit', /^[0-9a-f]{40}$/], ['sha256', /^[0-9a-f]{64}$/], ['test_sha256', /^[0-9a-f]{64}$/], ['test_copy_sha256', /^[0-9a-f]{64}$/]]) {
  if (!pattern.test(recorded[name] ?? '')) problems.push(`PRICING-SOURCE.txt has no valid "${name}:" line`);
}

// the API's copy against the note
const copyFile = join(root, 'src', 'domain', 'pricing.ts');
const copy = readOrNull(copyFile);
if (copy === null) problems.push('src/domain/pricing.ts is missing');
else if (sha256(copy) !== recorded.sha256) problems.push(`src/domain/pricing.ts has SHA-256 ${sha256(copy)} but PRICING-SOURCE.txt says ${recorded.sha256}`);
else notes.push(`src/domain/pricing.ts  sha256 ${recorded.sha256}  (the app's commit ${recorded.commit})`);

// the hash that `me` returns
const routes = readOrNull(join(root, 'src', 'auth', 'loginRoutes.ts'));
const inMe = routes === null ? null : /PRICING_SHA256[^=\n]*=\s*'([0-9a-f]{64})'/.exec(routes.toString('utf8'))?.[1];
if (!inMe) problems.push('src/auth/loginRoutes.ts holds no PRICING_SHA256 of 64 hex digits (GET /v1/auth/me would return the wrong hash)');
else if (inMe !== recorded.sha256) problems.push(`PRICING_SHA256 in src/auth/loginRoutes.ts is ${inMe} but PRICING-SOURCE.txt says ${recorded.sha256}`);
else notes.push('src/auth/loginRoutes.ts  PRICING_SHA256 is the same hash');

// the API's copy of the app's pricing tests
const testCopy = readOrNull(join(root, 'tests', 'pricing.test.ts'));
if (testCopy === null) problems.push('tests/pricing.test.ts (the app\'s pricing tests, run on the API\'s copy) is missing');
else if (sha256(testCopy) !== recorded.test_copy_sha256) problems.push(`tests/pricing.test.ts has SHA-256 ${sha256(testCopy)} but PRICING-SOURCE.txt says ${recorded.test_copy_sha256}`);
else notes.push('tests/pricing.test.ts  the recorded copy of the app\'s pricing tests');

if (appPricing !== null) {
  const app = readOrNull(appPricing);
  if (app === null) problems.push(`the app's file ${appPricing} does not exist`);
  else {
    if (copy !== null && !app.equals(copy)) problems.push(`the app's file ${appPricing} (sha256 ${sha256(app)}) differs from src/domain/pricing.ts (sha256 ${sha256(copy)}): the two are not the same bytes`);
    else if (copy !== null) notes.push(`the app's ${appPricing}  sha256 ${sha256(app)}  is the same bytes`);
    if (sha256(app) !== recorded.sha256) problems.push(`the app's file has SHA-256 ${sha256(app)} but PRICING-SOURCE.txt says ${recorded.sha256}: record the new commit and hashes there`);
    // <app>/src/lib/pricing.ts -> <app>/tests/unit/pricing.test.ts
    const appTestFile = join(dirname(appPricing), '..', '..', 'tests', 'unit', 'pricing.test.ts');
    const appTest = readOrNull(appTestFile);
    if (appTest === null) notes.push(`the app's tests/unit/pricing.test.ts was not found next to the file: the tests were not compared`);
    else {
      if (sha256(appTest) !== recorded.test_sha256) problems.push(`the app's tests/unit/pricing.test.ts has SHA-256 ${sha256(appTest)} but PRICING-SOURCE.txt says ${recorded.test_sha256}`);
      let expected = appTest.toString('utf8');
      for (const [from, to] of TEST_COPY_EDITS) {
        if (expected.split(from).length !== 2) problems.push(`the app's tests/unit/pricing.test.ts no longer holds the line this copy changes once: ${from}`);
        expected = expected.replace(from, () => to);
      }
      if (testCopy !== null && !testCopy.equals(Buffer.from(expected, 'utf8'))) problems.push(`tests/pricing.test.ts is not the app's tests/unit/pricing.test.ts with only the documented line changed`);
      else if (testCopy !== null) notes.push(`tests/pricing.test.ts  is the app's tests/unit/pricing.test.ts with only the documented line changed`);
    }
  }
}

if (problems.length > 0) {
  console.error('check:pricing FAILED');
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
console.log('check:pricing OK');
for (const n of notes) console.log(`  ${n}`);
