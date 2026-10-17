import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { REPO } from './support';

// T-A14, the file half (C12, NODE-DESIGN 1.4): the API's src/domain/pricing.ts is the app's src/lib/pricing.ts, byte for byte. PRICING-SOURCE.txt names the app's commit and the SHA-256; `check:pricing`
// compares them (alone, and against the app's own file when it is given the path); the app's pricing unit tests run on the API's copy (tests/pricing.test.ts, which vitest.config.ts points at the copy);
// and GET /v1/auth/me returns the hash (tests/api/quote-bill.test.ts, which has the database). The checks are functions of files, so each is run on a scratch folder where one byte of one copy is changed:
// it must fail, and the unchanged files must pass (the negative control).

const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
const read = (file: string) => readFileSync(join(REPO, file));

/** The one line of the app's test that the API's copy changes: the path it reads to look at the source of pricing.ts (the import is the same text, vitest.config.ts maps it). */
const TEST_LINE_APP = "new URL('../../src/lib/pricing.ts', import.meta.url)";
const TEST_LINE_API = "new URL('../src/domain/pricing.ts', import.meta.url)";

const scratch: string[] = [];
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});

/**
 * A scratch folder shaped like the API (the four files check:pricing reads) next to a scratch "app" holding the same pricing.ts and the app's own test. The app's test is rebuilt from the API's copy by
 * undoing the one documented line, so the folder is consistent without needing the real app repository on this disk.
 */
function folder() {
  const root = mkdtempSync(join(tmpdir(), 'jv-pricing-'));
  scratch.push(root);
  for (const file of ['src/domain/pricing.ts', 'PRICING-SOURCE.txt', 'src/auth/loginRoutes.ts', 'tests/pricing.test.ts']) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    cpSync(join(REPO, file), join(root, file));
  }
  const appPricing = join(root, 'app', 'src', 'lib', 'pricing.ts');
  const appTest = join(root, 'app', 'tests', 'unit', 'pricing.test.ts');
  mkdirSync(dirname(appPricing), { recursive: true });
  mkdirSync(dirname(appTest), { recursive: true });
  cpSync(join(REPO, 'src/domain/pricing.ts'), appPricing);
  writeFileSync(appTest, read('tests/pricing.test.ts').toString('utf8').replace(TEST_LINE_API, TEST_LINE_APP));
  return { root, appPricing, appTest, api: (file: string) => join(root, file) };
}

/** Runs `node scripts/check-pricing.mjs` of THIS repository on the scratch folder. */
function check(root: string, appPricing?: string) {
  const args = ['scripts/check-pricing.mjs', ...(appPricing ? [appPricing] : []), '--root', root];
  const r = spawnSync(process.execPath, args, { cwd: REPO, encoding: 'utf8' });
  return { ok: r.status === 0, out: `${r.stdout}${r.stderr}` };
}

/** Changes one byte of a file: a letter becomes another letter, so the file is still text and the length is the same. */
function flipOneByte(file: string) {
  const bytes = readFileSync(file);
  const at = bytes.indexOf(0x65 /* e */, 200);
  expect(at, 'the file has a letter e after byte 200').toBeGreaterThan(0);
  bytes[at] = 0x66;
  writeFileSync(file, bytes);
}

describe('T-A14 the API\'s pricing.ts is the app\'s, byte for byte (C12)', () => {
  const source = read('PRICING-SOURCE.txt').toString('utf8');
  const field = (name: string) => new RegExp(`^${name}:\\s*(\\S+)\\s*$`, 'm').exec(source)?.[1];

  it('PRICING-SOURCE.txt names the app\'s commit and the SHA-256 of the file, and the file has that hash', () => {
    expect(field('commit')).toMatch(/^[0-9a-f]{40}$/);
    expect(field('commit')?.startsWith('9724728')).toBe(true); // the commit of the app that last changed src/lib/pricing.ts (FE01)
    expect(field('sha256')).toMatch(/^[0-9a-f]{64}$/);
    expect(sha256(read('src/domain/pricing.ts'))).toBe(field('sha256'));
  });

  it('the copy exports what the API and the app use', async () => {
    const copy = await import('../../src/domain/pricing');
    for (const name of ['priceBill', 'priceLine', 'parseRupees', 'parseGrams', 'formatRupees', 'formatGrams', 'defaultLabourRate', 'defaultMetalRate', 'saleTypeForCustomer', 'assertBusinessDate', 'PricingError', 'LIMITS', 'CURRENT_PRICING_VERSION']) {
      expect(copy, name).toHaveProperty(name);
    }
    expect(copy.CURRENT_PRICING_VERSION).toBe(1);
  });

  it('check:pricing passes on the repository as it is (the API\'s copy, the file, the hash in loginRoutes.ts and the test copy agree)', () => {
    const r = spawnSync(process.execPath, ['scripts/check-pricing.mjs'], { cwd: REPO, encoding: 'utf8' });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain(field('sha256'));
  });

  it('check:pricing passes when it is given the app\'s file and the two are the same bytes', () => {
    const f = folder();
    const r = check(f.root, f.appPricing);
    expect(r.ok, r.out).toBe(true);
    expect(r.out).toContain(sha256(readFileSync(f.appPricing)));
  });

  it('control: ONE changed byte in the API\'s copy fails check:pricing, alone and against the app\'s file', () => {
    const f = folder();
    flipOneByte(f.api('src/domain/pricing.ts'));
    const alone = check(f.root);
    expect(alone.ok, alone.out).toBe(false);
    expect(alone.out).toMatch(/src\/domain\/pricing\.ts/);
    const against = check(f.root, f.appPricing);
    expect(against.ok, against.out).toBe(false);
  });

  it('control: ONE changed byte in the app\'s copy fails check:pricing (the API\'s copy is then behind the app)', () => {
    const f = folder();
    flipOneByte(f.appPricing);
    const r = check(f.root, f.appPricing);
    expect(r.ok, r.out).toBe(false);
    expect(r.out).toMatch(/differs|not the same/i);
  });

  it('control: a different hash in PRICING-SOURCE.txt, or in `me` (loginRoutes.ts), fails', () => {
    const noteChanged = folder();
    const note = noteChanged.api('PRICING-SOURCE.txt');
    writeFileSync(note, readFileSync(note, 'utf8').replace(/^(sha256:\s*)[0-9a-f]/m, (_m, p: string) => `${p}${field('sha256')![0] === '0' ? '1' : '0'}`));
    const a = check(noteChanged.root);
    expect(a.ok, a.out).toBe(false);
    expect(a.out).toMatch(/PRICING-SOURCE\.txt/);

    const meChanged = folder();
    const routes = meChanged.api('src/auth/loginRoutes.ts');
    writeFileSync(routes, readFileSync(routes, 'utf8').replace(/(PRICING_SHA256[^=\n]*=\s*')[0-9a-f]/, (_m, p: string) => `${p}${field('sha256')![0] === '0' ? '1' : '0'}`));
    const b = check(meChanged.root);
    expect(b.ok, b.out).toBe(false);
    expect(b.out).toMatch(/loginRoutes\.ts/);
  });

  it('control: the app\'s pricing tests run on the API\'s copy, so a changed test copy fails check:pricing against the app\'s test (one changed byte)', () => {
    const f = folder();
    flipOneByte(f.api('tests/pricing.test.ts'));
    const alone = check(f.root);
    expect(alone.ok, alone.out).toBe(false);
    expect(alone.out).toMatch(/tests\/pricing\.test\.ts/);
    const g = folder();
    flipOneByte(g.appTest);
    const against = check(g.root, g.appPricing);
    expect(against.ok, against.out).toBe(false);
  });

  it('the test copy is the app\'s test with the one documented line changed, and vitest maps the app\'s import of "@/lib/pricing" to the API\'s copy', () => {
    const copy = read('tests/pricing.test.ts').toString('utf8');
    expect(copy.split(TEST_LINE_API).length - 1).toBe(1);
    expect(copy).not.toContain(TEST_LINE_APP);
    expect(copy).toContain("} from '@/lib/pricing';");
    expect(readFileSync(join(REPO, 'vitest.config.ts'), 'utf8')).toMatch(/@\/lib\/pricing['"]?\s*:[^\n]*src\/domain\/pricing/);
    expect(existsSync(join(REPO, 'src', 'lib'))).toBe(false); // there is one copy of the file, not two
  });

  it('npm run verify runs check:pricing, after the build and before the tests', () => {
    const pkg = JSON.parse(read('package.json').toString('utf8')) as { scripts: Record<string, string> };
    expect(pkg.scripts['check:pricing']).toBe('node scripts/check-pricing.mjs');
    const steps = pkg.scripts.verify.split('&&').map((s) => s.trim());
    const at = steps.indexOf('npm run check:pricing');
    expect(at).toBeGreaterThan(steps.indexOf('npm run build'));
    expect(at).toBeLessThan(steps.findIndex((s) => s.endsWith('npm test')));
  });
});
