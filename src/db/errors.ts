// Plain classes for what the connection layer can refuse. Their HTTP mapping (JV_BUSY 503 with Retry-After) is API03's.

export type BusyReason = 'queue_full' | 'wait_timeout' | 'connect_refused' | 'connection_lost' | 'closing';

/** JV_BUSY (S8): the pool could not give a connection. Nothing had run when this was thrown. */
export class DbBusyError extends Error {
  readonly code = 'JV_BUSY';
  readonly reason: BusyReason;
  /** Always true here: the call failed before its first statement. (A connection dropped during COMMIT is another case, API03.) */
  readonly nothingStarted = true;
  constructor(reason: BusyReason, options?: { cause?: unknown }) {
    super(`the database pool is busy: ${reason}`, options);
    this.name = 'DbBusyError';
    this.reason = reason;
  }
}
