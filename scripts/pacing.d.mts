export const PACE_MAX: number;
export const PACE_WINDOW_MS: number;
export interface Pacer {
  max: number;
  windowMs: number;
  /** Resolves when one more NEW connection may be opened (and records it): never more than `max` in any `windowMs`. Waiters are served in order. */
  wait(): Promise<void>;
}
export function createPacer(opts?: { max?: number; windowMs?: number; now?: () => number; sleep?: (ms: number) => Promise<void> }): Pacer;
export function pacedConnect<T>(pacer: Pacer, connect: () => Promise<T>): Promise<T>;
