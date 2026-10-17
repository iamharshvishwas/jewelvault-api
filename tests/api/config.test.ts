import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CONFIG_VARIABLES, ConfigError, loadConfig } from '../../src/config';
import { REPO, secret } from './support';

const good = () => ({ DB_HOST: '127.0.0.1', DB_PORT: '3306', DB_NAME: 'jv_x', DB_USER: 'jv_u', DB_PASSWORD: secret('pw'), ALLOWED_ORIGINS: 'https://app.example.test' });

describe('config: the environment is read once, checked, and a missing variable stops the start (U10)', () => {
  it('reads the five database variables and the allowed origins, and gives the optional ones their defaults', () => {
    const env = good();
    const c = loadConfig(env);
    expect(c.db).toEqual({ host: '127.0.0.1', port: 3306, name: 'jv_x', user: 'jv_u', password: env.DB_PASSWORD });
    expect(c.allowedOrigins).toEqual(['https://app.example.test']);
    expect(c.port).toBe(3000);
    expect(c.logLevel).toBe('info');
    expect(loadConfig({ ...good(), PORT: '8080', LOG_LEVEL: 'warn' })).toMatchObject({ port: 8080, logLevel: 'warn' });
  });

  it('refuses each missing or empty database variable and names it', () => {
    for (const name of ['DB_HOST', 'DB_PORT', 'DB_NAME', 'DB_USER', 'DB_PASSWORD']) {
      const unset: Record<string, string | undefined> = good();
      delete unset[name];
      expect(() => loadConfig(unset), `${name} unset`).toThrow(ConfigError);
      expect(() => loadConfig(unset)).toThrow(name);
      expect(() => loadConfig({ ...good(), [name]: '' }), `${name} empty`).toThrow(name);
    }
  });

  it('lists every problem at once, and the message holds variable names only, never a value', () => {
    const pw = secret('pw');
    let err: unknown;
    try {
      loadConfig({ DB_HOST: 'db.example.test', DB_PORT: 'not-a-port', DB_PASSWORD: pw, LOG_LEVEL: 'loud', PORT: '99999', ALLOWED_ORIGINS: 'https://a.example.test/' });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ConfigError);
    const text = String((err as Error).message);
    for (const name of ['DB_PORT', 'DB_NAME', 'DB_USER', 'LOG_LEVEL', 'PORT', 'ALLOWED_ORIGINS']) expect(text).toContain(name);
    for (const value of [pw, 'db.example.test', 'not-a-port', 'loud', '99999', 'a.example.test']) expect(text).not.toContain(value);
    expect(text).not.toContain('DB_PASSWORD'); // it was given and valid
    expect((err as ConfigError).problems.map((p) => p.name).sort()).toEqual(['ALLOWED_ORIGINS', 'DB_NAME', 'DB_PORT', 'DB_USER', 'LOG_LEVEL', 'PORT']);
  });

  it('does not read process.env itself when an environment is passed, and the result cannot be changed afterwards', () => {
    const c = loadConfig(good());
    expect(Object.isFrozen(c)).toBe(true);
    expect(Object.isFrozen(c.db)).toBe(true);
  });

  it('.env.example names every variable the config reads, holds no secret value, and .env is ignored', () => {
    const example = readFileSync(join(REPO, '.env.example'), 'utf8');
    const names = new Set([...example.matchAll(/^#?\s*([A-Z][A-Z0-9_]*)=(.*)$/gm)].map((m) => m[1]));
    for (const v of CONFIG_VARIABLES) expect(names.has(v), `${v} in .env.example`).toBe(true);
    for (const m of example.matchAll(/^(DB_PASSWORD|DB_USER)=(.*)$/gm)) expect(m[2].trim(), m[1]).toBe('');
    const ignore = readFileSync(join(REPO, '.gitignore'), 'utf8').split('\n').map((l) => l.trim());
    for (const entry of ['.env', 'dist/', '.lane']) expect(ignore, entry).toContain(entry);
  });
});
