import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildDist } from './support';

// S5, U10: what the production build can and cannot reach, checked on the compiled files (the same compile as npm run build).
describe('the production build', () => {
  let dist: string;
  let files: string[];
  beforeAll(() => {
    dist = buildDist();
    files = readdirSync(dist).filter((f) => f.endsWith('.js'));
  }, 120_000);

  it('reads process.env in one place only: server.js, once (the environment is read once)', () => {
    const code = (f: string) => readFileSync(join(dist, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\/\/# sourceMappingURL=.*$/m, '');
    const readers = files.filter((f) => /process\.env/.test(code(f)));
    expect(readers).toEqual(['server.js']);
    expect(code('server.js').match(/process\.env/g)).toHaveLength(1);
  });

  it('has no way to set the clock: the entry never names a clock, and the clock module exports readers and constructors only', async () => {
    expect(readFileSync(join(dist, 'server.js'), 'utf8')).not.toMatch(/clock/i);
    const mod = await import(/* @vite-ignore */ pathToFileURL(join(dist, 'clock.js')).href);
    expect(Object.keys(mod).sort()).toEqual(['BUSINESS_TIME_ZONE', 'businessDate', 'createClock', 'formatTimestamp', 'systemClock', 'systemMicros']);
    expect(Object.keys(mod).filter((k) => /^(set|fake|freeze|override|reset|mock)/i.test(k))).toEqual([]);
    expect(Object.isFrozen(mod.systemClock.read())).toBe(true);
  });

  it('contains nothing from tests/ and no .env', () => {
    for (const f of readdirSync(dist)) expect(f).not.toMatch(/test|\.env/i);
  });
});
