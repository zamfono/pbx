// How the updater stops: on SIGTERM or SIGINT it takes no new request and exits. It runs no
// update itself, the host agent does (§6.3 "Updates"), so there is nothing to wait for.
import type http from 'node:http';
import process from 'node:process';

/** Closes `server` and exits 0 on the first SIGTERM or SIGINT; a further signal is ignored. */
export function stopOnSignal(
  server: http.Server,
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
    process.exit(0);
  };
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);
}
