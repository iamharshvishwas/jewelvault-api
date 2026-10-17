// S8: every JV_* code with its HTTP status, the JSON body of an error, and what each database error becomes. This file imports nothing from the rest of the app, so every other file may
// import it (the connection layer's DbBusyError and the wire parsers' InvalidInputError extend the classes here).
//
// A service function raises a JvError; the one error handler of app.ts answers it as {"error":{"code","message","details"},"request_id"} with the status below. Anything that is not a
// JvError is classified here: a database error by its number, a lost connection by the driver's code, anything else is JV_INTERNAL, whose detail goes to the log and never to the client (A14).

/** S8 (and NODE-DESIGN 4.5 for the codes new in draft 4). */
export const JV_STATUS = Object.freeze({
  JV_INVALID_INPUT: 422,
  JV_FORBIDDEN: 403,
  JV_NOT_FOUND: 404,
  JV_PIECE_UNAVAILABLE: 409,
  JV_CUSTOMER_ARCHIVED: 409,
  JV_OVERPAYMENT: 409,
  JV_CASH_LIMIT: 409,
  JV_FINE_EXCEEDS: 409,
  JV_BILL_CANCELLED: 409,
  JV_ALREADY_VOID: 409,
  JV_NOT_ALLOWED: 409,
  JV_BUSY: 503,
  JV_STALE: 409,
  JV_UNAUTHENTICATED: 401,
  JV_SESSION_EXPIRED: 401,
  JV_BAD_LOGIN: 401,
  JV_PASSWORD_CHANGE_REQUIRED: 403,
  JV_CSRF: 403,
  JV_RATE_LIMITED: 429,
  JV_PAYLOAD_TOO_LARGE: 413,
  JV_UNSUPPORTED_MEDIA_TYPE: 415,
  JV_UNAVAILABLE: 503,
  JV_INTERNAL: 500,
} as const);

export type JvCode = keyof typeof JV_STATUS;

export interface JvErrorOptions {
  /** What the screen may use (S8): the field, the current row of JV_STALE, the pieces. Never SQL, never a stack. */
  details?: Record<string, unknown>;
  /** Seconds, for the Retry-After header. JV_BUSY says 1 (S8); JV_RATE_LIMITED must say how long. */
  retryAfter?: number;
  cause?: unknown;
  /** The database refused something the API's own checks should have caught (4025, 1264): answered, and logged at error level as a bug. */
  bug?: boolean;
}

/** An error with an S8 code. The message is meant for the client: say what is wrong, never repeat a value the caller sent. */
export class JvError extends Error {
  readonly code: JvCode;
  readonly status: number;
  readonly details: Record<string, unknown>;
  readonly retryAfter: number | undefined;
  readonly bug: boolean;
  constructor(code: JvCode, message: string, options: JvErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'JvError';
    this.code = code;
    this.status = JV_STATUS[code];
    this.details = options.details ?? {};
    if (code === 'JV_RATE_LIMITED' && options.retryAfter === undefined) throw new TypeError('JV_RATE_LIMITED needs a Retry-After (S8)');
    this.retryAfter = options.retryAfter ?? (code === 'JV_BUSY' ? 1 : undefined);
    this.bug = options.bug ?? false;
  }
}

/** Why a call was answered JV_BUSY. The first five are the pool's (API02: nothing had started); the rest come from the transaction wrapper and the handler. */
export type BusyReason =
  | 'queue_full'
  | 'wait_timeout'
  | 'connect_refused'
  | 'connection_lost'
  | 'closing'
  | 'lock_wait'
  | 'statement_timeout'
  | 'deadlock'
  | 'deadline'
  | 'commit_lost'
  | 'handler_timeout';

/**
 * JV_BUSY (S8), 503 with Retry-After: 1. It NEVER promises "nothing was changed": a connection that drops during COMMIT leaves it unknown (`outcomeUnknown`), so the message says nothing about it
 * and the screen retries once with the same Idempotency-Key, whose stored result (L5) tells the truth.
 */
export class BusyError extends JvError {
  readonly reason: BusyReason;
  /** No statement had been sent when this was thrown (the pool refused). */
  readonly nothingStarted: boolean;
  /** The connection dropped during COMMIT: the work may or may not have been saved. */
  readonly outcomeUnknown: boolean;
  constructor(reason: BusyReason, options: { cause?: unknown; nothingStarted?: boolean; outcomeUnknown?: boolean } = {}) {
    super('JV_BUSY', 'The service is busy. Try again in a moment.', { cause: options.cause });
    this.name = 'BusyError';
    this.reason = reason;
    this.nothingStarted = options.nothingStarted ?? false;
    this.outcomeUnknown = options.outcomeUnknown ?? false;
  }
}

/** The body of every error answer (S8). */
export function errorBody(error: JvError, requestId: string) {
  return { error: { code: error.code, message: error.message, details: error.details }, request_id: requestId };
}

// ------------------------------------------------------------------ what each database error becomes

const MESSAGES = {
  unavailable: 'The service is not available. Try again in a moment.',
  internal: 'Something unexpected went wrong.',
  invalid: 'A value was refused.',
  unreadable: 'The request could not be read.',
  tooLarge: 'The request is too large.',
  mediaType: 'This kind of content is not accepted.',
} as const;

/** The connection died under the statement (the server closed it, or it was killed): the statement did not run, or its answer was lost. */
const LOST_CODES = new Set(['PROTOCOL_CONNECTION_LOST', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT']);
const LOST_ERRNOS = new Set([1927 /* connection killed */, 1053 /* server shutdown */, 2006 /* server has gone away */, 2013 /* lost connection during query */]);

interface Raw {
  fatal?: boolean;
  code?: string;
  errno?: number;
  message?: string;
  sqlMessage?: string;
  statusCode?: number;
}
const raw = (e: unknown): Raw => (typeof e === 'object' && e !== null ? (e as Raw) : {});

export function isConnectionLost(e: unknown): boolean {
  const r = raw(e);
  return r.fatal === true || LOST_CODES.has(String(r.code)) || LOST_ERRNOS.has(Number(r.errno));
}

/** A deadlock (1213): the server rolled the transaction back; the whole function may be run again (S12). */
export const isDeadlock = (e: unknown): boolean => Number(raw(e).errno) === 1213;

/** The database cannot be reached at all (not there, a name that does not resolve, the login refused): JV_UNAVAILABLE, as the start-up check would answer (NODE-DESIGN 4.5). */
const UNREACHABLE_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH', 'EAI_AGAIN']);
const UNREACHABLE_ERRNOS = new Set([1044 /* access denied to the database */, 1045 /* access denied */, 1049 /* unknown database */, 1130 /* host not allowed */]);
/** The server has no connection to give (1040 too many connections, 1203 too many for this user): busy, nothing had started. */
const TOO_MANY_ERRNOS = new Set([1040, 1203]);

/**
 * Unique keys whose value a person types or the screen sends (S8: a duplicate of one is JV_INVALID_INPUT). Every other unique key is filled by the numbering step or the claim, which are written
 * so that they never raise a duplicate (L3, L5): a 1062 there is a bug, JV_INTERNAL. tests/api/c19-tx.test.ts compares this list and INTERNAL_KEYS with the unique keys of a migrated database,
 * so a migration that adds one has to say which kind it is.
 */
export const BUSINESS_KEYS: readonly string[] = ['uq_designs_no', 'uq_users_email', 'uq_categories_name', 'uq_subcategories_name', 'uq_daily_rates_day'];
export const INTERNAL_KEYS: readonly string[] = [
  'PRIMARY',
  'uq_import_batches_name',
  'uq_job_runs_day',
  'uq_error_log_slot',
  'uq_sessions_token',
  'uq_bills_no',
  'uq_bills_request',
  'uq_bills_reissue',
  'uq_bills_id_customer',
  'uq_skus_no',
  'uq_skus_barcode',
  'uq_customers_walkin',
  'uq_bill_items_line',
  'uq_bill_items_sku',
  'uq_receipts_id_customer',
];

/** The name of the key in a duplicate-entry message ("for key 'uq_designs_no'", or "'designs.uq_designs_no'" on other servers), or null. */
export function duplicateKeyName(e: unknown): string | null {
  const m = /for key '(?:[^'.]+\.)?([^']+)'/.exec(String(raw(e).sqlMessage ?? raw(e).message ?? ''));
  return m ? m[1] : null;
}

const FASTIFY_CLIENT_ERRORS: Record<string, () => JvError> = {
  FST_ERR_CTP_BODY_TOO_LARGE: () => new JvError('JV_PAYLOAD_TOO_LARGE', MESSAGES.tooLarge),
  FST_ERR_CTP_INVALID_MEDIA_TYPE: () => new JvError('JV_UNSUPPORTED_MEDIA_TYPE', MESSAGES.mediaType),
};

/**
 * Any error, as the JvError the client is told. A JvError is returned as it is. The original is kept as `cause` for the log (describeCause).
 *   1205 lock wait, 1969 statement timeout, 1213 deadlock (after the API's own re-runs), a lost connection, a full pool: JV_BUSY (the pool's own DbBusyError arrives already classified)
 *   1062 on a business key: JV_INVALID_INPUT; on anything else JV_INTERNAL.   4025, 1264: JV_INVALID_INPUT and a bug in the log.   1451, 1452 and anything else: JV_INTERNAL.
 *   the database not there or the login refused: JV_UNAVAILABLE.   Fastify's handler timer: JV_BUSY; its own refusals of the request: 413, 415, 422.
 */
export function classifyError(e: unknown): JvError {
  if (e instanceof JvError) return e;
  const r = raw(e);
  const errno = Number(r.errno);
  const busy = (reason: BusyReason) => new BusyError(reason, { cause: e });

  if (r.code === 'FST_ERR_HANDLER_TIMEOUT') return busy('handler_timeout');
  if (errno === 1205) return busy('lock_wait');
  if (errno === 1969) return busy('statement_timeout');
  if (errno === 1213) return busy('deadlock');
  if (TOO_MANY_ERRNOS.has(errno)) return new BusyError('connect_refused', { cause: e, nothingStarted: true });
  if (isConnectionLost(e)) return busy('connection_lost');
  if (UNREACHABLE_CODES.has(String(r.code)) || UNREACHABLE_ERRNOS.has(errno)) return unavailableError(e);
  if (errno === 1062) {
    const key = duplicateKeyName(e);
    if (key !== null && BUSINESS_KEYS.includes(key)) return new JvError('JV_INVALID_INPUT', MESSAGES.invalid, { cause: e });
    return new JvError('JV_INTERNAL', MESSAGES.internal, { cause: e });
  }
  if (errno === 4025 || errno === 1264) return new JvError('JV_INVALID_INPUT', MESSAGES.invalid, { cause: e, bug: true });
  const fastify = FASTIFY_CLIENT_ERRORS[String(r.code)];
  if (fastify) return fastify();
  if (String(r.code).startsWith('FST_ERR_') && typeof r.statusCode === 'number' && r.statusCode >= 400 && r.statusCode < 500) return new JvError('JV_INVALID_INPUT', MESSAGES.unreadable, { cause: e });
  return new JvError('JV_INTERNAL', MESSAGES.internal, { cause: e });
}

/**
 * A14, a second line of defence: the SHAPE of a mobile number, a PAN, a GST number or an e-mail address inside a text that is about to be logged or stored in the error log is replaced. The first
 * line is that no code puts a customer's value into a message; this catches the one that does (`new Error(\`no customer ${mobile}\`)`). An Indian mobile number is ten digits starting 6 to 9, with
 * or without +91, 91 or 0 in front and a space or dash in the middle.
 */
const SHAPES: readonly (readonly [RegExp, string])[] = [
  [/\b\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]\b/g, '<gst>'],
  [/\b[A-Z]{5}\d{4}[A-Z]\b/g, '<pan>'],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g, '<email>'],
  [/(?<![\w.])(?:(?:\+?91|0)[\s-]?)?[6-9]\d{4}[\s-]?\d{5}(?!\w)/g, '<mobile>'],
];
export const scrubShapes = (text: string): string => SHAPES.reduce((t, [re, to]) => t.replace(re, to), text);

/**
 * What the log may say about an error that was not answered to the client as it is. A14: the logs never hold a mobile, PAN or GST number, and a database message can repeat the value it refused
 * ("Duplicate entry '9876543210' for key ..."), so the quoted value is replaced and the name of the key stays; and what looks like a mobile, PAN, GST number or e-mail address is cut out of the rest.
 */
export function describeCause(e: unknown): Record<string, unknown> {
  const r = raw(e);
  const text = String(r.sqlMessage ?? r.message ?? '');
  // the quoted VALUE of "Duplicate entry '...'" and "Incorrect ... value: '...'" goes; names of keys, tables and columns stay, they are what the person reading the log needs
  const message = scrubShapes(text.replace(/(Duplicate entry|value:)\s*'((?:[^'\\]|\\.)*)'/g, "$1 '?'"));
  const out: Record<string, unknown> = { name: e instanceof Error ? e.name : typeof e, message };
  if (r.code !== undefined) out.code = r.code;
  if (r.errno !== undefined) out.errno = r.errno;
  const state = (e as { sqlState?: string } | null)?.sqlState;
  if (state !== undefined) out.sqlState = state;
  if (e instanceof Error && r.errno === undefined && e.stack) out.stack = scrubShapes(e.stack); // a bug in the code: the stack is for the log (never for the client, A14)
  return out;
}

/** JV_UNAVAILABLE (S11): the start-up check failed, or the database cannot be reached. The reason is in the log only. */
export const unavailableError = (cause?: unknown): JvError => new JvError('JV_UNAVAILABLE', MESSAGES.unavailable, cause === undefined ? {} : { cause });
