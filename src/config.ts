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
  PORT: portNumber.optional(),
  LOG_LEVEL: z.enum(LOG_LEVELS).optional(),
  JV_AUDIT_MODE: z.enum(AUDIT_MODES).optional(),
});

/** Every variable the API reads; .env.example lists exactly these. */
export const CONFIG_VARIABLES = Object.keys(schema.shape) as (keyof typeof schema.shape)[];

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
  /** L1: which mechanism writes the audit rows (JV_AUDIT_MODE, default 'triggers'). 'node' only on a database without the audit triggers (O50). */
  readonly auditMode: AuditMode;
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

/** Reads and checks the environment. Pass the environment in; server.ts passes process.env, once. */
export function loadConfig(env: Record<string, string | undefined>): Config {
  const raw: Record<string, string | undefined> = {};
  for (const name of CONFIG_VARIABLES) raw[name] = env[name] === '' ? undefined : env[name];
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const names = new Set(parsed.error.issues.map((i) => String(i.path[0])));
    // our own wording: a zod message could repeat the value that was wrong
    throw new ConfigError([...names].map((name) => ({ name, problem: raw[name] === undefined ? ('missing' as const) : ('invalid' as const) })));
  }
  const v = parsed.data;
  return Object.freeze({
    port: v.PORT ?? 3000,
    logLevel: v.LOG_LEVEL ?? 'info',
    allowedOrigins: v.ALLOWED_ORIGINS,
    adminTokenHash: v.JV_ADMIN_TOKEN_HASH,
    jobTokenHash: v.JV_JOB_TOKEN_HASH,
    loginSalt: v.JV_LOGIN_SALT,
    auditMode: v.JV_AUDIT_MODE ?? 'triggers',
    db: Object.freeze({ host: v.DB_HOST, port: v.DB_PORT, name: v.DB_NAME, user: v.DB_USER, password: v.DB_PASSWORD }),
  });
}
