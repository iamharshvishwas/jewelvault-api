import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../../src/app';
import type { MailConfig } from '../../src/config';
import { type MailMessage, type Mailer, createMailer } from '../../src/mail/mailer';
import { secret, testConfig } from './support';

// nodemailer is replaced: no test here opens a connection. What is checked is what the mailer hands to it.
const nodemailer = vi.hoisted(() => {
  const sendMail = vi.fn(async (_message: unknown) => ({ messageId: 'stand-in' }));
  const createTransport = vi.fn((_options: unknown) => ({ sendMail }));
  return { sendMail, createTransport };
});
vi.mock('nodemailer', () => ({ default: { createTransport: nodemailer.createTransport }, createTransport: nodemailer.createTransport }));

const FROM = 'Example Shop <no-reply@example.test>';
const LINK = 'https://crm.example.test/reset-password';
const message: MailMessage = { to: 'someone@example.test', subject: 'Reset your password: Example Shop', text: 'plain body with a link', html: '<p>html body with a link</p>' };

const scratch: string[] = [];
const scratchDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'jv-mailer-'));
  scratch.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  nodemailer.createTransport.mockClear();
  nodemailer.sendMail.mockClear();
});

const smtpConfig = (port: number, password = secret('smtp')): MailConfig => ({ from: FROM, resetLinkBase: LINK, transport: { kind: 'smtp', host: 'smtp.example.test', port, user: 'no-reply@example.test', password } });

describe('mailer: outbox (tests and the e2e lane)', () => {
  it('outbox writes one JSON file per message with to, subject, text, html', async () => {
    const dir = join(scratchDir(), 'not-there-yet'); // the mailer makes the folder when it is not there
    const mailer = createMailer({ from: FROM, resetLinkBase: LINK, transport: { kind: 'outbox', dir } });
    const second: MailMessage = { ...message, to: 'other@example.test', subject: 'Another subject' };
    await mailer.send(message);
    await mailer.send(second);
    const files = readdirSync(dir).sort();
    expect(files).toHaveLength(2);
    for (const file of files) expect(file, 'named <ISO time>-<random>.json').toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z-[0-9a-f]+\.json$/);
    const written = files.map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')));
    expect(written).toHaveLength(2);
    expect(written).toContainEqual(message);
    expect(written).toContainEqual(second);
    expect(nodemailer.createTransport, 'no SMTP transport is made for an outbox').not.toHaveBeenCalled();
  });

  it('two messages sent in the same millisecond do not overwrite each other', async () => {
    const dir = scratchDir();
    const mailer = createMailer({ from: FROM, resetLinkBase: LINK, transport: { kind: 'outbox', dir } });
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-11-26T10:00:00.000Z'));
      await Promise.all(Array.from({ length: 5 }, (_, i) => mailer.send({ ...message, to: `p${i}@example.test` })));
    } finally {
      vi.useRealTimers();
    }
    const files = readdirSync(dir);
    expect(files).toHaveLength(5);
    expect(new Set(files.map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')).to)).size).toBe(5);
    for (const file of files) expect(file.startsWith('2026-11-26T10:00:00.000Z-')).toBe(true);
  });
});

describe('mailer: SMTP', () => {
  it('smtp transport uses secure for 465 and not for 587', async () => {
    const pass = secret('smtp');
    createMailer(smtpConfig(465, pass));
    createMailer(smtpConfig(587, pass));
    expect(nodemailer.createTransport).toHaveBeenCalledTimes(2);
    const [implicit, starttls] = nodemailer.createTransport.mock.calls.map((c) => c[0]);
    expect(implicit).toEqual({ host: 'smtp.example.test', port: 465, secure: true, auth: { user: 'no-reply@example.test', pass }, connectionTimeout: 15_000, greetingTimeout: 15_000 });
    expect(starttls).toMatchObject({ host: 'smtp.example.test', port: 587, secure: false, auth: { user: 'no-reply@example.test', pass }, connectionTimeout: 15_000, greetingTimeout: 15_000 });
  });

  it('send hands the configured sender and the whole message to the transport, and a refusal reaches the caller', async () => {
    const mailer = createMailer(smtpConfig(465));
    await mailer.send(message);
    expect(nodemailer.sendMail).toHaveBeenCalledTimes(1);
    expect(nodemailer.sendMail).toHaveBeenCalledWith({ from: FROM, to: message.to, subject: message.subject, text: message.text, html: message.html });
    const refused = Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' });
    nodemailer.sendMail.mockRejectedValueOnce(refused);
    await expect(mailer.send(message)).rejects.toBe(refused); // the caller (task 3) reads err.code for the error log
  });
});

describe('app.mailer: made from config.mail, with a seam for tests', () => {
  const quiet = { logLevel: 'silent' } as const;

  it('is null when no mail is configured, so the forgot-password route can answer 503', async () => {
    const app = buildApp({ config: testConfig(quiet), routes: false });
    try {
      expect(app.mailer).toBeNull();
    } finally {
      await app.close();
    }
  });

  it('is made from config.mail when there is one, and an app built with options.mailer uses that one instead', async () => {
    const dir = scratchDir();
    const config = testConfig({ ...quiet, mail: { from: FROM, resetLinkBase: LINK, transport: { kind: 'outbox', dir } } });
    const made = buildApp({ config, routes: false });
    const sent: MailMessage[] = [];
    const fake: Mailer = { send: async (m) => void sent.push(m) };
    const seam = buildApp({ config, routes: false, mailer: fake });
    try {
      expect(made.mailer).not.toBeNull();
      await made.mailer?.send(message);
      expect(readdirSync(dir)).toHaveLength(1); // the real outbox mailer wrote it
      expect(seam.mailer).toBe(fake);
      await seam.mailer?.send(message);
      expect(sent).toEqual([message]);
      expect(readdirSync(dir), 'the seam sent nothing to the outbox').toHaveLength(1);
    } finally {
      await made.close();
      await seam.close();
    }
  });
});
