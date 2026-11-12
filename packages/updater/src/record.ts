import { setTimeout as sleep } from 'node:timers/promises';

import type { UpdateState } from '@zamfono/shared';

import type { Agent } from './agent.js';

/** An update's record in `.update/state.json`, which the host agent's run of `update.sh`
 * writes and the updater reads (§6.3 "Updates"). */
const POLL_MS = 200;

/**
 * How long an update's `running` record may stay before it counts as cut off, its host stopped
 * mid-run: well past its download, pull and three-minute health wait.
 */
export const RUN_STALE_MS = 3_600_000;
export function settle(state: UpdateState, now: number): UpdateState {
  if (
    state.state !== 'running' ||
    (state.startedAt !== undefined &&
      now - Date.parse(state.startedAt) < RUN_STALE_MS)
  ) {
    return state;
  }
  return {
    ...state,
    state: 'failed',
    finishedAt: new Date(now).toISOString(),
    error: 'interrupted: the update did not finish on the host'
  };
}

/** The update's record once the run sent at `sentAt` began, or what it says after `waitMs`. */
export async function recordSince(
  agent: Agent,
  sentAt: number,
  waitMs: number
): Promise<UpdateState> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const state = agent.state();
    if (
      Date.now() >= deadline ||
      (state.startedAt !== undefined && Date.parse(state.startedAt) >= sentAt)
    ) {
      return state;
    }
    // eslint-disable-next-line no-await-in-loop -- polling the record, one look at a time
    await sleep(POLL_MS);
  }
}
