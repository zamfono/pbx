// How the updater stops: on SIGTERM or SIGINT it takes no new request, waits a bounded time for an
// update of its own to end and exits; a run still going is cut off with it, and the next start
// marks it failed (§6.3 "Updates").
import type http from 'node:http';
import process from 'node:process';

import type { Runner } from './runner.js';

/**
 * How long a stop waits for the updater's own run of `update.sh`. Its ceiling is the container's
 * stop grace period, Compose's default 10 s (compose.yaml sets no `stop_grace_period`), after
 * which the runtime kills the process.
 */
export const STOP_WAIT_MS = 8000;

/** Waits up to `STOP_WAIT_MS` for `runner`'s own run to end; past it, says it did not. */
async function waitForRun(
  runner: Runner | undefined,
  log: (message: string) => void
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<'timeout'>(resolve => {
    timer = setTimeout(resolve, STOP_WAIT_MS, 'timeout');
  });
  const outcome = await Promise.race([runner?.idle(), deadline]);
  clearTimeout(timer);
  if (outcome === 'timeout') {
    log('updater stopping before its update ended');
  }
}

/**
 * Closes `server` and exits 0 on the first SIGTERM or SIGINT, once its own run ended or
 * `STOP_WAIT_MS` passed; a further signal is ignored.
 */
export function stopOnSignal(
  server: http.Server,
  runner: Runner | undefined,
  log: (message: string) => void
): void {
  let stopping = false;
  const onSignal = (): void => {
    if (stopping) {
      return;
    }
    stopping = true;
    log('updater stopping');
    server.close();
    waitForRun(runner, log).then(
      () => {
        process.exit(0);
      },
      () => {
        process.exit(1);
      }
    );
  };
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);
}
