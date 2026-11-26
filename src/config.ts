// U10, S1: the database credentials exist only in the environment (Hostinger's variables; a .env file on Harsh's Mac during a migration window).
// The environment is read once, here. A missing or malformed variable stops the start, and the message names variables, never values.
import { z } from 'zod';
import { parseAllowedOrigins } from './security/origins.js';

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/** L1: who writes the audit rows. 'triggers' (a) is the default: the generated triggers of db/optional/0910. 'node' (b): the API writes the same rows itself (src/db/audit.ts). Never both. */
export const AUDIT_MODES = ['triggers', 'node'] as const;
export type AuditMode = (typeof AUDIT_MODES)[number];

const text = z.string().min(1);
const portNumber = z
  .string()
  .regex(/^\d{1,5}$/)
  .transform(Number)
  .pipe(z.number().int().min(1).max(65535));

// A12: the origins the API answers, an exact list (never *, no patterns); the message of a refusal names the variable and never the value (see loadConfig)
const originList = z
  .string()
  .min(1)
  .transform((value, ctx) => {
    const list = parseAllowedOrigins(value);
    if (list === null) ctx.addIssue({ code: 'custom', message: 'not a list of exact origins' });
    return list ?? [];
  });

// U3: the SHA-256 of the admin token, in hex (scripts/make-token.mjs prints it). The admin door exists only while this is set; it is optional, so an unset variable is a shut door and not a failed start.
// I8: JV_JOB_TOKEN_HASH is the same kind of value for the job door (`npm run make-token -- job` prints it); the hourly tick and the jobs health route exist only while it is set.
const tokenHash = z
  .string()
  .regex(/^[0-9a-fA-F]{64}$/)
  .transform((value) => value.toLowerCase());

// D24, U10: the secret salt of the login counter slots. Optional: without it the salt is made from the database password (src/auth/throttle.ts loginSaltOf).
const secretSalt = z.string().min(16).max(256);

// Forgot password by e-mail: the page the mailed link opens. The mail adds `#t=<token>` to it, so the value must already be the exact address of that page and nothing else:
// https anywhere, http only on the developer's own Mac (exactly `localhost`, so `localhost.example.com` or `localhost@host` do not pass); a page (a path, not the bare site); no whitespace, no username or
// password, no query and never a `#` (the token must stay out of anything a server sees); and written the way the URL parser writes it (lower-case host, no default port, no `..`), so the value is the link.
// Judged on the value after loadConfig trimmed it. That its origin is one of ALLOWED_ORIGINS is checked beside it (linkOriginProblem): the link opens the website, the one origin the API answers.
function isResetLinkBase(value: string): boolean {
  if (/\s/.test(value) || value.includes('#') || value.includes('?')) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.href !== value || url.username !== '' || url.password !== '' || url.pathname === '/') return false;
  return url.protocol === 'https:' || (url.protocol === 'http:' && url.hostname === 'localhost');
}
const resetLinkBase = z.string().min(1).refine(isResetLinkBase);

const schema = z.object({
  DB_HOST: text,
  DB_PORT: portNumber,
  DB_NAME: text,
  DB_USER: text,
  DB_PASSWORD: text,
  ALLOWED_ORIGINS: originList,
  JV_ADMIN_TOKEN_HASH: tokenHash.optional(),
  JV_JOB_TOKEN_HASH: tokenHash.optional(),
  JV_LOGIN_SALT: secretSalt.optional(),
  JV_BACKUP_DIR: text.optional(),
  PORT: portNumber.optional(),
  LOG_LEVEL: z.enum(LOG_LEVELS).optional(),
  JV_AUDIT_MODE: z.enum(AUDIT_MODES).optional(),
  // Forgot password by e-mail. All optional, but all-or-nothing: see mailProblems and mailOf.
  JV_SMTP_HOST: text.optional(),
  JV_SMTP_PORT: portNumber.optional(),
  JV_SMTP_USER: text.optional(),
  JV_SMTP_PASSWORD: text.optional(),
  JV_MAIL_FROM: text.optional(),
  JV_RESET_LINK_BASE: resetLinkBase.optional(),
  /** For tests and the website's e2e lane only: every mail is written as a JSON file into this folder instead of being sent. */
  JV_MAIL_OUTBOX_DIR: text.optional(),
});

/** Every variable the API reads; .env.example lists exactly these. */
export const CONFIG_VARIABLES = Object.keys(schema.shape) as (keyof typeof schema.shape)[];

/** How the API sends the password reset mail. Made from the JV_SMTP_*, JV_MAIL_FROM, JV_RESET_LINK_BASE and JV_MAIL_OUTBOX_DIR variables; src/mail/mailer.ts turns it into a Mailer. */
export interface MailConfig {
  /** The sender as the mail shows it, e.g. `Jaishri Gold Palace <no-reply@jaishrigoldpalace.com>` (JV_MAIL_FROM). */
  readonly from: string;
  /** The page the link opens (JV_RESET_LINK_BASE, trimmed): the exact address of a page of the website, https (http only on localhost), with no query, no `#` and no credentials, on an origin of ALLOWED_ORIGINS. The link in the mail is this, then `#t=<token>`. */
  readonly resetLinkBase: string;
  readonly transport:
    | { readonly kind: 'smtp'; readonly host: string; readonly port: number; readonly user: string; readonly password: string }
    | { readonly kind: 'outbox'; readonly dir: string };
}

export interface Config {
  /** The port to listen on (PORT, default 3000). */
  readonly port: number;
  readonly logLevel: LogLevel;
  /** A12: the origins that may call the API from a browser, exactly as the browser writes them (ALLOWED_ORIGINS, comma separated). In production only the website's. */
  readonly allowedOrigins: readonly string[];
  /** U3, O41: the SHA-256 of the admin token, 64 lower-case hex characters. Without it the admin door (/admin/v1/*) does not exist: remove the variable and the door is shut. */
  readonly adminTokenHash?: string | undefined;
  /** I8: the SHA-256 of the job token, 64 lower-case hex characters (JV_JOB_TOKEN_HASH). The hourly tick (POST /internal/jobs/tick) and the jobs health route exist only while it is set. */
  readonly jobTokenHash?: string | undefined;
  /** D24, U10: the secret salt of the login counter slots (JV_LOGIN_SALT, at least 16 characters). Unset: a salt made from the database password. */
  readonly loginSalt?: string | undefined;
  /**
   * B2: the backup folder on the plan (JV_BACKUP_DIR), an absolute path with the same value for the app and for cron, outside `domains/`. The tick's photo copy (API33b) writes `photos/` into it, the dump
   * script (API34) `daily/` and `monthly/`. Kept as it is written: the photo copy checks it when it runs (src/jobs/backupFolder.ts resolveBackupDir) and fails visibly when it is not set, not there or
   * not writable; a wrong value does not stop the start, because the owner's line must still open to say so. The start-up check of spec 5.2.2 (src/jobs/backupProbe.ts) judges it and a bad folder is a red line on the owner's dashboard.
   */
  readonly backupDir?: string | undefined;
  /** L1: which mechanism writes the audit rows (JV_AUDIT_MODE, default 'triggers'). 'node' only on a database without the audit triggers (O50). */
  readonly auditMode: AuditMode;
  /** How the password reset mail is sent, or null when none of the mail variables is set: the API then starts as before and the forgot-password route answers 503 (JV_UNAVAILABLE). */
  readonly mail: MailConfig | null;
  readonly db: { readonly host: string; readonly port: number; readonly name: string; readonly user: string; readonly password: string };
}

export interface ConfigProblem {
  name: string;
  problem: 'missing' | 'invalid';
}

export class ConfigError extends Error {
  readonly problems: ConfigProblem[];
  constructor(problems: ConfigProblem[]) {
    super(`configuration refused: ${problems.map((p) => `${p.name} is ${p.problem}`).join(', ')}`);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

const MAIL_SMTP_VARIABLES = ['JV_SMTP_HOST', 'JV_SMTP_PORT', 'JV_SMTP_USER', 'JV_SMTP_PASSWORD'] as const;
const MAIL_SHARED_VARIABLES = ['JV_MAIL_FROM', 'JV_RESET_LINK_BASE'] as const;
/** Every mail variable is typed or pasted into hPanel by hand: a space or a newline at either end is dropped before anything is checked (loadConfig). Nothing inside a value is touched, the password's included. */
const MAIL_TRIMMED: readonly string[] = [...MAIL_SMTP_VARIABLES, ...MAIL_SHARED_VARIABLES, 'JV_MAIL_OUTBOX_DIR'];

/** The link is a page of the website, and the website is the origin the API answers: a link base on any other origin is a setting slip (or a mail that sends people elsewhere). Judged on the given values; when either is not valid in itself that one is the problem. */
function linkOriginProblem(raw: Record<string, string | undefined>): ConfigProblem[] {
  const { JV_RESET_LINK_BASE: base, ALLOWED_ORIGINS: origins } = raw;
  if (base === undefined || origins === undefined || !isResetLinkBase(base)) return [];
  const allowed = parseAllowedOrigins(origins);
  if (allowed === null || allowed.includes(new URL(base).origin)) return [];
  return [{ name: 'JV_RESET_LINK_BASE', problem: 'invalid' }];
}

/**
 * The mail variables are optional as a group: none set means no mail, the outbox needs JV_MAIL_OUTBOX_DIR with the sender and the link base, SMTP needs its four variables with the sender and the link base.
 * Anything in between names what is missing. The outbox together with an SMTP variable is refused too: the outbox is for tests, and a live setting must never be quietly swapped for files in a folder.
 * Judged on what was given (an empty variable counts as not given), so it can be listed together with the problems zod found. A link base on an origin the API does not answer is listed here as well.
 */
function mailProblems(raw: Record<string, string | undefined>): ConfigProblem[] {
  const given = (name: string) => raw[name] !== undefined;
  const outbox = given('JV_MAIL_OUTBOX_DIR');
  const smtp = MAIL_SMTP_VARIABLES.some(given);
  if (!outbox && !smtp && !MAIL_SHARED_VARIABLES.some(given)) return [];
  if (outbox && smtp) return [{ name: 'JV_MAIL_OUTBOX_DIR', problem: 'invalid' }];
  const needed = outbox ? MAIL_SHARED_VARIABLES : [...MAIL_SMTP_VARIABLES, ...MAIL_SHARED_VARIABLES];
  return [...needed.filter((name) => !given(name)).map((name) => ({ name, problem: 'missing' as const })), ...linkOriginProblem(raw)];
}

/** The mail settings of a config that passed mailProblems: complete, or none at all. */
function mailOf(v: z.infer<typeof schema>): MailConfig | null {
  const { JV_MAIL_FROM: from, JV_RESET_LINK_BASE: resetLinkBase } = v;
  if (from === undefined || resetLinkBase === undefined) return null;
  if (v.JV_MAIL_OUTBOX_DIR !== undefined) return Object.freeze({ from, resetLinkBase, transport: Object.freeze({ kind: 'outbox' as const, dir: v.JV_MAIL_OUTBOX_DIR }) });
  const { JV_SMTP_HOST: host, JV_SMTP_PORT: port, JV_SMTP_USER: user, JV_SMTP_PASSWORD: password } = v;
  if (host === undefined || port === undefined || user === undefined || password === undefined) return null;
  return Object.freeze({ from, resetLinkBase, transport: Object.freeze({ kind: 'smtp' as const, host, port, user, password }) });
}

/** Reads and checks the environment. Pass the environment in; server.ts passes process.env, once. */
export function loadConfig(env: Record<string, string | undefined>): Config {
  const raw: Record<string, string | undefined> = {};
  for (const name of CONFIG_VARIABLES) {
    const value = MAIL_TRIMMED.includes(name) ? env[name]?.trim() : env[name];
    raw[name] = value === '' ? undefined : value; // an empty variable, or one holding only whitespace (a mail one), is an unset one
  }
  const parsed = schema.safeParse(raw);
  const mailIssues = mailProblems(raw);
  if (!parsed.success) {
    const names = new Set(parsed.error.issues.map((i) => String(i.path[0])));
    // our own wording: a zod message could repeat the value that was wrong
    const problems: ConfigProblem[] = [...names].map((name) => ({ name, problem: raw[name] === undefined ? ('missing' as const) : ('invalid' as const) }));
    throw new ConfigError([...problems, ...mailIssues.filter((m) => !names.has(m.name))]);
  }
  if (mailIssues.length > 0) throw new ConfigError(mailIssues);
  const v = parsed.data;
  return Object.freeze({
    port: v.PORT ?? 3000,
    logLevel: v.LOG_LEVEL ?? 'info',
    allowedOrigins: v.ALLOWED_ORIGINS,
    adminTokenHash: v.JV_ADMIN_TOKEN_HASH,
    jobTokenHash: v.JV_JOB_TOKEN_HASH,
    loginSalt: v.JV_LOGIN_SALT,
    backupDir: v.JV_BACKUP_DIR,
    auditMode: v.JV_AUDIT_MODE ?? 'triggers',
    mail: mailOf(v),
    db: Object.freeze({ host: v.DB_HOST, port: v.DB_PORT, name: v.DB_NAME, user: v.DB_USER, password: v.DB_PASSWORD }),
  });
}
