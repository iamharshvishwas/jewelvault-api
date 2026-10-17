// H7, NODE-DESIGN 5.7: on SIGTERM (a deploy, "Apply changes", a restart) the API stops accepting calls, lets the running transactions finish (at most 10 seconds) and closes the pool.
//
// app.close() does the first two: the listener closes, idle keep-alive connections are dropped, and Fastify waits for every request still being served, which is every running transaction;
// its onClose hook (app.ts) then ends the pool. If that has not finished when the grace is over, the process ends at once: the connections close with it, and MariaDB rolls back every
// transaction still open and frees its locks (S12, H7), so nothing is half-saved. The exit code says which happened: 0 when everything finished, 1 when it did not.
import type { FastifyInstance } from 'fastify';

/** H7: running transactions get this long. */
export const SHUTDOWN_GRACE_MS = 10_000;

export interface ShutdownOptions {
  /** A seam for tests that cannot wait ten seconds; server.ts passes none. */
  graceMs?: number;
  signals?: readonly NodeJS.Signals[];
  /** Default: process.exit. */
  exit?: (code: number) => void;
}

export interface Shutdown {
  /** What the signal handlers call; resolves when the app is closed (or the grace is over, when it has asked to exit). A second call does nothing. */
  shutdown(signal?: string): Promise<void>;
}

export function installShutdown(app: FastifyInstance, options: ShutdownOptions = {}): Shutdown {
  const graceMs = options.graceMs ?? SHUTDOWN_GRACE_MS;
  const exit = options.exit ?? ((code: number) => process.exit(code));
  let stopping: Promise<void> | undefined;

  const shutdown = (signal = 'shutdown'): Promise<void> => {
    stopping ??= (async () => {
      app.log.info({ signal, graceMs }, 'shutdown: no more calls are accepted; running transactions may finish, then the pool is closed');
      const timer = setTimeout(() => {
        app.log.error({ graceMs }, 'shutdown: the running calls did not finish in time; ending the process, MariaDB rolls back what is still open');
        exit(1);
      }, graceMs);
      try {
        await app.close();
      } catch (error) {
        app.log.error({ err: error }, 'shutdown: closing the app failed');
        clearTimeout(timer);
        exit(1);
        return;
      }
      clearTimeout(timer);
      app.log.info('shutdown: done');
      exit(0);
    })();
    return stopping;
  };

  for (const signal of options.signals ?? (['SIGTERM', 'SIGINT'] as const)) process.on(signal, () => void shutdown(signal));
  return { shutdown };
}
