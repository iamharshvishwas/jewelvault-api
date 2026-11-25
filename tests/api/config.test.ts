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

// The forgot-password mail (docs: DESIGN.md "Sending the mail"). Every mail variable is optional: with none of them the API starts as before and the forgot route answers 503.
describe('config: the mail settings are optional and all-or-nothing', () => {
  const LINK = 'https://crm.example.test/reset-password';
  const FROM = 'Example Shop <no-reply@example.test>';
  const smtp = () => ({ JV_SMTP_HOST: 'smtp.example.test', JV_SMTP_PORT: '465', JV_SMTP_USER: 'no-reply@example.test', JV_SMTP_PASSWORD: secret('smtp') });
  const common = () => ({ JV_MAIL_FROM: FROM, JV_RESET_LINK_BASE: LINK });
  const refusal = (env: Record<string, string | undefined>): ConfigError => {
    try {
      loadConfig({ ...good(), ...env });
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      return e as ConfigError;
    }
    throw new Error('the config was accepted');
  };

  it('no mail variables gives mail null', () => {
    expect(loadConfig(good()).mail).toBeNull();
    expect(loadConfig({ ...good(), JV_SMTP_HOST: '', JV_MAIL_OUTBOX_DIR: '' }).mail, 'empty is unset').toBeNull();
  });

  it('outbox settings give an outbox transport', () => {
    const c = loadConfig({ ...good(), ...common(), JV_MAIL_OUTBOX_DIR: '/tmp/jv-outbox' });
    expect(c.mail).toEqual({ from: FROM, resetLinkBase: LINK, transport: { kind: 'outbox', dir: '/tmp/jv-outbox' } });
  });

  it('all six SMTP settings give smtp, port as a number', () => {
    const s = smtp();
    const c = loadConfig({ ...good(), ...s, ...common() });
    expect(c.mail).toEqual({ from: FROM, resetLinkBase: LINK, transport: { kind: 'smtp', host: 'smtp.example.test', port: 465, user: 'no-reply@example.test', password: s.JV_SMTP_PASSWORD } });
    expect(Object.isFrozen(c.mail)).toBe(true);
    expect(Object.isFrozen(c.mail?.transport)).toBe(true);
    expect(refusal({ ...s, ...common(), JV_SMTP_PORT: '99999' }).problems).toEqual([{ name: 'JV_SMTP_PORT', problem: 'invalid' }]);
  });

  it('a partial set is refused and names what is missing', () => {
    const everything = { ...smtp(), ...common() };
    for (const name of Object.keys(everything)) {
      const partial: Record<string, string | undefined> = { ...everything };
      delete partial[name];
      expect(refusal(partial).problems, `${name} unset`).toEqual([{ name, problem: 'missing' }]);
    }
    // the outbox needs the sender and the link base too
    expect(refusal({ JV_MAIL_OUTBOX_DIR: '/tmp/jv-outbox' }).problems).toEqual([
      { name: 'JV_MAIL_FROM', problem: 'missing' },
      { name: 'JV_RESET_LINK_BASE', problem: 'missing' },
    ]);
    // a sender and a link without a way to send them: the SMTP four are what is missing
    expect(refusal(common()).problems.map((p) => p.name)).toEqual(['JV_SMTP_HOST', 'JV_SMTP_PORT', 'JV_SMTP_USER', 'JV_SMTP_PASSWORD']);
    // one lone setting is a partial set as well, and the message holds names, never values
    const lone = refusal({ JV_SMTP_PASSWORD: everything.JV_SMTP_PASSWORD });
    expect(lone.problems.map((p) => p.name)).toEqual(['JV_SMTP_HOST', 'JV_SMTP_PORT', 'JV_SMTP_USER', 'JV_MAIL_FROM', 'JV_RESET_LINK_BASE']);
    expect(lone.message).not.toContain(everything.JV_SMTP_PASSWORD);
    // an empty variable is an unset one
    expect(refusal({ ...everything, JV_SMTP_USER: '' }).problems).toEqual([{ name: 'JV_SMTP_USER', problem: 'missing' }]);
  });

  it('the outbox is for tests and the e2e lane: set together with SMTP settings it is refused, so a live mailer is never silently replaced by files', () => {
    expect(refusal({ ...smtp(), ...common(), JV_MAIL_OUTBOX_DIR: '/tmp/jv-outbox' }).problems).toEqual([{ name: 'JV_MAIL_OUTBOX_DIR', problem: 'invalid' }]);
  });

  it('a mail problem is listed together with the other problems, not only after they are fixed', () => {
    const e = refusal({ DB_NAME: undefined, JV_SMTP_HOST: 'smtp.example.test' });
    expect(e.problems.map((p) => p.name).sort()).toEqual(['DB_NAME', 'JV_MAIL_FROM', 'JV_RESET_LINK_BASE', 'JV_SMTP_PASSWORD', 'JV_SMTP_PORT', 'JV_SMTP_USER']);
  });

  it('a link base with # or plain http to another host is refused', () => {
    const outbox = { JV_MAIL_FROM: FROM, JV_MAIL_OUTBOX_DIR: '/tmp/jv-outbox' };
    const base = (JV_RESET_LINK_BASE: string) => ({ ...outbox, JV_RESET_LINK_BASE });
    for (const bad of [`${LINK}#t=`, `${LINK}#`, 'http://crm.example.test/reset-password', 'http://localhost.example.test/reset-password', 'http://localhost@crm.example.test/reset-password', 'ftp://crm.example.test/reset-password', 'crm.example.test/reset-password', '/reset-password', 'https://']) {
      expect(refusal(base(bad)).problems, bad).toEqual([{ name: 'JV_RESET_LINK_BASE', problem: 'invalid' }]);
    }
    expect(refusal(base(`${LINK}#t=`)).message).not.toContain('crm.example.test'); // names, never values
    // https anywhere, and http only for the developer's own Mac; the base is kept exactly as written
    for (const ok of [LINK, 'https://crm.example.test/reset-password?from=mail', 'http://localhost:3001/reset-password', 'http://localhost/reset-password']) {
      expect(loadConfig({ ...good(), ...base(ok) }).mail?.resetLinkBase, ok).toBe(ok);
    }
  });
});
