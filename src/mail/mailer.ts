// Forgot password by e-mail (docs: DESIGN.md "Sending the mail"): the one place the API delivers a mail. A Mailer takes a finished message and either hands it to the SMTP server or, for tests and the
// website's e2e lane, writes it as a JSON file. It builds no text (the caller does) and decides nothing about who may get a mail. A failed send rejects with the transport's own error: the caller
// reads its `code` for the error log and must never log the message (it holds an address and a link).
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import nodemailer from 'nodemailer';
import type { MailConfig } from '../config.js';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface Mailer {
  send(message: MailMessage): Promise<void>;
}

/** A server that does not answer must not hold a send for the transport's defaults (2 minutes to connect, 30 s for the greeting, 10 minutes of silence on an open socket): each gets 15 s. */
const SMTP_TIMEOUT_MS = 15_000;

/** The test and e2e transport: `<dir>/<ISO time>-<random>.json`, one file per message, holding to, subject, text and html. The random part keeps two mails of the same millisecond apart. */
function outboxMailer(dir: string): Mailer {
  return {
    async send(message) {
      await mkdir(dir, { recursive: true });
      const file = join(dir, `${new Date().toISOString()}-${randomBytes(6).toString('hex')}.json`);
      const { to, subject, text, html } = message;
      await writeFile(file, `${JSON.stringify({ to, subject, text, html }, null, 2)}\n`, { flag: 'wx' });
    },
  };
}

export function createMailer(mail: MailConfig): Mailer {
  const { transport } = mail;
  if (transport.kind === 'outbox') return outboxMailer(transport.dir);
  // port 465 is TLS from the first byte; any other port (587) starts plain and upgrades with STARTTLS, and requireTLS makes the upgrade a must: a server that does not offer it ends the send
  // (nodemailer would otherwise log in and send over the open connection, the password and the link in the clear)
  const smtp = nodemailer.createTransport({
    host: transport.host,
    port: transport.port,
    secure: transport.port === 465,
    requireTLS: transport.port !== 465,
    auth: { user: transport.user, pass: transport.password },
    connectionTimeout: SMTP_TIMEOUT_MS,
    greetingTimeout: SMTP_TIMEOUT_MS,
    socketTimeout: SMTP_TIMEOUT_MS,
  });
  return {
    async send(message) {
      await smtp.sendMail({ from: mail.from, to: message.to, subject: message.subject, text: message.text, html: message.html });
    },
  };
}
