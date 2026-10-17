// What the connection layer can refuse. It is the one JV_BUSY error of src/errors.ts (503 with Retry-After: 1, the S8 body); the pool throws it before any statement has run.
// The message is the client's (it says the service is busy); the reason is for the log and the tests.
import { BusyError, type BusyReason } from '../errors.js';

export type { BusyReason };

/** JV_BUSY (S8): the pool could not give a connection. Nothing had run when this was thrown. */
export class DbBusyError extends BusyError {
  constructor(reason: Extract<BusyReason, 'queue_full' | 'wait_timeout' | 'connect_refused' | 'connection_lost' | 'closing'>, options?: { cause?: unknown }) {
    super(reason, { cause: options?.cause, nothingStarted: true });
    this.name = 'DbBusyError';
  }
}
