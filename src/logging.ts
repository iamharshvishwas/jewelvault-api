import type { FastifyBaseLogger } from 'fastify';
import pino from 'pino';
import type { LogLevel } from './config.js';

// Nothing secret goes to the log: cookies, authorization headers and password fields are replaced by [Redacted] wherever they appear in a logged object.
// Fastify's own request lines carry method, url, host and address only; this list is for what the API's code logs itself (a header set, a body, an error with a config).

const HEADER_KEYS = ['cookie', 'authorization', 'proxy-authorization', 'set-cookie'];
const PASSWORD_KEYS = ['password', 'passwd', 'password_hash', 'new_password', 'current_password', 'old_password', 'passwordHash', 'newPassword', 'currentPassword', 'oldPassword', 'DB_PASSWORD'];
const BRACKET = (key: string) => (/^[A-Za-z_$][\w$]*$/.test(key) ? `.${key}` : `["${key}"]`);

// fast-redact wildcards stand for exactly one level, so the list repeats the pattern for the top level and up to three levels down.
const WILDCARD_PREFIXES = ['', '*.', '*.*.', '*.*.*.'];
const HEADER_HOLDERS = ['headers', '*.headers', '*.*.headers', '*.*.*.headers'];

export const REDACT_PATHS: string[] = [
  ...PASSWORD_KEYS.flatMap((k) => WILDCARD_PREFIXES.map((p) => (p === '' ? k : `${p.slice(0, -1)}${BRACKET(k)}`))),
  ...HEADER_KEYS.flatMap((k) => HEADER_HOLDERS.map((h) => `${h}${BRACKET(k)}`)),
];

export const REDACTED = '[Redacted]';

export function createLogger(level: LogLevel, stream?: NodeJS.WritableStream): FastifyBaseLogger {
  const options = { level, redact: { paths: REDACT_PATHS, censor: REDACTED } };
  return stream ? pino(options, stream) : pino(options);
}
