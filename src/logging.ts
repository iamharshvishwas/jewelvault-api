import type { FastifyBaseLogger } from 'fastify';
import pino from 'pino';
import type { LogLevel } from './config.js';

// Nothing secret goes to the log: cookies, authorization headers and password fields are replaced by [Redacted] wherever they appear in a logged object.
// Fastify's own request lines carry method, path, host and address only (the serializer below); this list is for what the API's code logs itself (a header set, a body, an error with a config).

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

/** The part of a request address before the query string. */
const pathOf = (url: unknown): string | undefined => (typeof url === 'string' ? url.split('?', 1)[0] : undefined);

/**
 * A14: the request line of Fastify's log says the method, the PATH, the host and the address, and nothing from the query string: a query can carry a mobile, a PAN or a name (a search, a link a person
 * pasted), and the log is kept for days and read by people. Fastify's own serializer logs the whole address; this one replaces it (a serializer on the logger wins over Fastify's).
 */
export const serializers = {
  req(request: { method?: string; url?: string; host?: string; hostname?: string; ip?: string; socket?: { remotePort?: number } }) {
    return { method: request.method, url: pathOf(request.url), host: request.host ?? request.hostname, remoteAddress: request.ip, remotePort: request.socket?.remotePort };
  },
};

export function createLogger(level: LogLevel, stream?: NodeJS.WritableStream): FastifyBaseLogger {
  const options = { level, redact: { paths: REDACT_PATHS, censor: REDACTED }, serializers };
  return stream ? pino(options, stream) : pino(options);
}
