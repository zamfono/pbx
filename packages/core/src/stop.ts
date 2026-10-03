// How `core` stops (§3.1 "Independence"): on SIGTERM or SIGINT it takes no new work, winds its
// calls down and lets their event handling finish within a bound, releases the rest and exits.
import process from 'node:process';

import type { AmiClient } from './ami/client.js';
import type { AriClient } from './ari/client.js';
import type { Logger } from './ari/types.js';
import type { Pipeline } from './calls/pipeline.js';

/**
 * How long a stop waits for the calls' wind-down and event handling. Its ceiling is the container's
 * stop grace period, Compose's default 10 s (compose.yaml sets no `stop_grace_period`), after
 * which Docker kills the process; the rest of that period is left for closing ARI and AMI.
 */
export const STOP_DRAIN_MS = 8000;

/** What a booted `core` releases as it stops. */
type Running = {
  jobs: { stop: () => void };
  hep: { close: () => void } | null;
  server: { close: () => Promise<void> };
  pipeline: Pipeline;
  ari: AriClient;
  ami: AmiClient;
  log: Logger;
};

/** Waits up to `STOP_DRAIN_MS` for `pipeline` to drain; past it, logs what was still running. */
async function drainPipeline(pipeline: Pipeline, log: Logger): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<'timeout'>(resolve => {
    timer = setTimeout(resolve, STOP_DRAIN_MS, 'timeout');
  });
  const outcome = await Promise.race([pipeline.drain(), deadline]);
  clearTimeout(timer);
  if (outcome === 'timeout') {
    log.warn(
      {
        handling: pipeline.handling,
        windingDown: pipeline.windDowns.callIds,
        waitedMs: STOP_DRAIN_MS
      },
      'core stopping before its calls were wound down'
    );
  }
}

/**
 * New work stops first: the background jobs, the HEP collector, the internal server and the
 * pipeline's new calls, whose wind-down starts with it. ARI and AMI stay open until the drain has
 * finished, since the wind-down and the handling in progress call Asterisk and wait on the events
 * of their calls.
 */
async function release(running: Running): Promise<void> {
  const { jobs, hep, server, pipeline, ari, ami, log } = running;
  jobs.stop();
  hep?.close();
  const serverClosed = server.close();
  await drainPipeline(pipeline, log);
  await serverClosed;
  await Promise.allSettled([ari.close(), ami.close()]);
}

/**
 * Releases `running` and exits 0 on the first SIGTERM or SIGINT; a further signal during the stop
 * is ignored. The returned `close` releases it without exiting.
 */
export function stopOnSignal(running: Running): {
  close: () => Promise<void>;
} {
  const { log } = running;
  let stopping = false;
  const onSignal = (signal: NodeJS.Signals): void => {
    if (stopping) {
      return;
    }
    stopping = true;
    log.info({ signal }, 'core stopping');
    release(running).then(
      () => {
        log.info('core stopped');
        process.exit(0);
      },
      (error: unknown) => {
        log.error({ error }, 'core failed to stop');
        process.exit(1);
      }
    );
  };
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);
  return {
    close: () => {
      process.off('SIGTERM', onSignal);
      process.off('SIGINT', onSignal);
      return release(running);
    }
  };
}
