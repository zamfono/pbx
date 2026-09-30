/** Schedules the daily retention purge (§5.9 last paragraph): `runPurge` once at boot, then on a fixed interval for the process's life. */
import pino from 'pino';

import { MS_PER_DAY, nowIso, type Db } from '@zamfono/shared';

import { runPurge } from './purge.js';

const logger = pino({ name: 'retention' });

export type RetentionScheduler = { stop(): void };

/**
 * Runs `runPurge` immediately and then every `intervalMs` (default one day), stoppable for
 * tests; a failed cycle is logged and does not stop the schedule, so a transient error costs at
 * most one cycle's purge.
 */
export function scheduleRetention(
  db: Db,
  now: () => string = nowIso,
  intervalMs: number = MS_PER_DAY
): RetentionScheduler {
  const state: { timer?: NodeJS.Timeout; stopped: boolean } = {
    stopped: false
  };

  const tick = (): void => {
    runPurge(db, now())
      .catch((error: unknown) => {
        logger.error({ error }, 'retention purge failed');
      })
      .finally(() => {
        if (!state.stopped) {
          state.timer = setTimeout(tick, intervalMs);
        }
      });
  };
  tick();

  return {
    stop: () => {
      state.stopped = true;
      if (state.timer !== undefined) {
        clearTimeout(state.timer);
      }
    }
  };
}
