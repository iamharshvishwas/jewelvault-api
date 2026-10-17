import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import net from 'node:net';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import type { Config } from '../../src/config';

export const REPO = fileURLToPath(new URL('../../', import.meta.url));

/** A secret made up at run time: no test holds a password in its source. */
export const secret = (label = 'x') => `${label}-${randomBytes(12).toString('hex')}`;

/** A config for tests that never open a database (API01 has no pool yet). */
export function testConfig(overrides: Partial<Config> = {}): Config {
  return { port: 0, logLevel: 'info', db: { host: '127.0.0.1', port: 3306, name: 'jv_test', user: 'jv_test', password: secret('db') }, ...overrides };
}

/** A log destination that keeps every line, parsed. */
export function logSink() {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, done) {
      chunks.push(chunk.toString());
      done();
    },
  });
  return {
    stream,
    text: () => chunks.join(''),
    lines: () => chunks.join('').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, any>),
  };
}

/** A TCP port nobody listens on right now. */
export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
  });
}

export function canConnect(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ port, host });
    s.once('connect', () => (s.destroy(), resolve(true)));
    s.once('error', () => resolve(false));
  });
}

let built: string | undefined;
/**
 * Compiles src/ with the real build config (tsconfig.build.json) into a scratch folder inside node_modules/.cache
 * (so the compiled files still find node_modules) and returns that folder. The same files `npm run build` puts in dist/.
 */
export function buildDist(): string {
  if (built) return built;
  const out = join(REPO, 'node_modules', '.cache', 'jv-test-dist', secret('b'));
  mkdirSync(out, { recursive: true });
  execFileSync(process.execPath, [join(REPO, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', join(REPO, 'tsconfig.build.json'), '--outDir', out], { cwd: REPO, stdio: 'pipe' });
  built = out;
  return out;
}
