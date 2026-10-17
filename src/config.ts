// U10, S1: the database credentials exist only in the environment (Hostinger's variables; a .env file on Harsh's Mac during a migration window).
// The environment is read once, here. A missing or malformed variable stops the start, and the message names variables, never values.
import { z } from 'zod';
import { parseAllowedOrigins } from './security/origins.js';

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

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

const schema = z.object({
  DB_HOST: text,
  DB_PORT: portNumber,
  DB_NAME: text,
  DB_USER: text,
  DB_PASSWORD: text,
  ALLOWED_ORIGINS: originList,
  PORT: portNumber.optional(),
  LOG_LEVEL: z.enum(LOG_LEVELS).optional(),
});

/** Every variable the API reads; .env.example lists exactly these. */
export const CONFIG_VARIABLES = Object.keys(schema.shape) as (keyof typeof schema.shape)[];

export interface Config {
  /** The port to listen on (PORT, default 3000). */
  readonly port: number;
  readonly logLevel: LogLevel;
  /** A12: the origins that may call the API from a browser, exactly as the browser writes them (ALLOWED_ORIGINS, comma separated). In production only the website's. */
  readonly allowedOrigins: readonly string[];
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
    db: Object.freeze({ host: v.DB_HOST, port: v.DB_PORT, name: v.DB_NAME, user: v.DB_USER, password: v.DB_PASSWORD }),
  });
}
