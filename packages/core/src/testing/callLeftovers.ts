// Test-only: what a call can leave behind once it ended (`calls/hangupStages.test.ts`): channels
// and bridges in Asterisk, the pipeline's live state, a timer of the core's own, a hint still
// showing a call, a `calls` row never closed.
import { expect, vi } from 'vitest';

import type { Db } from '@zamfono/shared';

import type { FakeAri } from './ari/fake.js';
import { eventually } from './eventually.js';
import type { Rig } from './pipelineRig.js';

/** The timers the core's own modules set and have neither cleared nor seen fire, each by where it
 * was set; any other module's (the fake's, a driver's) are not counted. */
export type CoreTimers = { pending: () => string[] };

const CORE_FRAME = /\/core\/src\/(?!testing\/)[\w/]+(?<!\.test)\.ts:\d+/u;

/** The first frame of `stack` past this module and the mock, as `file:line` when it is a core
 * module's, else `null`. */
function coreSite(stack: string | undefined): string | null {
  const frame = (stack ?? '')
    .split('\n')
    .slice(1)
    .find(
      line =>
        !line.includes('callLeftovers.ts') && !line.includes('node_modules')
    );
  return CORE_FRAME.exec(frame ?? '')?.[0] ?? null;
}

/** Tracks every timer set from here on, until `vi.restoreAllMocks`. */
export function trackCoreTimers(): CoreTimers {
  const live = new Map<unknown, string>();
  const realSet = globalThis.setTimeout;
  const realClear = globalThis.clearTimeout;
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
    run: (...args: unknown[]) => void,
    ms?: number,
    ...args: unknown[]
  ) => {
    const site = coreSite(new Error('timer').stack);
    const timer = realSet(() => {
      live.delete(timer);
      run(...args);
    }, ms);
    if (site !== null) {
      live.set(timer, site);
    }
    return timer;
  }) as typeof setTimeout);
  vi.spyOn(globalThis, 'clearTimeout').mockImplementation(timer => {
    live.delete(timer);
    realClear(timer);
  });
  return { pending: () => [...live.values()] };
}

/** Every `calls` row's status and whether it ended, oldest first. */
export async function callRows(
  db: Db
): Promise<{ status: string; ended: boolean }[]> {
  const rows = await db
    .selectFrom('calls')
    .select(['status', 'endedAt'])
    .orderBy('startedAt')
    .execute();
  return rows.map(row => ({ status: row.status, ended: row.endedAt !== null }));
}

/** The hints whose last device state shows a call (§9.3), with that state. */
function busyHints(fakeAri: FakeAri): [string, string][] {
  const hints = new Map<string, string>();
  for (const entry of fakeAri.calls) {
    if (entry.method === 'PUT' && entry.path.startsWith('deviceStates/')) {
      const body = entry.body as { deviceState?: string };
      hints.set(entry.path, body.deviceState ?? '');
    }
  }
  return [...hints].filter(
    ([, state]) => state !== 'NOT_INUSE' && state !== 'UNAVAILABLE'
  );
}

/** Waits until nothing is left of any call: no channel or bridge in Asterisk, no live state in the
 * pipeline nor call in the live view, no core timer pending, no hint showing a call. */
export async function allQuiet(rig: Rig, timers: CoreTimers): Promise<void> {
  const { pipeline, fakeAri, state } = rig;
  await eventually(async () => {
    await pipeline.idle();
    expect({
      channels: fakeAri.channelIds,
      bridges: fakeAri.bridgeIds,
      timers: timers.pending(),
      liveCalls: [...state.calls.keys()],
      busyHints: busyHints(fakeAri)
    }).toEqual({
      channels: [],
      bridges: [],
      timers: [],
      liveCalls: [],
      busyHints: []
    });
    expect({
      callByChannel: pipeline.callByChannel.size,
      channelless: pipeline.channelless.size,
      pendingRing: pipeline.pendingRing.size,
      findMeTimers: pipeline.findMeTimers.size,
      pendingFindMeAccept: pipeline.pendingFindMeAccept.size,
      activeBatches: pipeline.activeBatches.size,
      holds: pipeline.holds.size,
      parkingSlots: pipeline.parkingSlots.size,
      parkedSlotByChannel: pipeline.parkedSlotByChannel.size,
      pendingTransfers: pipeline.pendingTransfers.entries.size,
      transferWaiters: pipeline.pendingTransfers.waiters.size
    }).toEqual({
      callByChannel: 0,
      channelless: 0,
      pendingRing: 0,
      findMeTimers: 0,
      pendingFindMeAccept: 0,
      activeBatches: 0,
      holds: 0,
      parkingSlots: 0,
      parkedSlotByChannel: 0,
      pendingTransfers: 0,
      transferWaiters: 0
    });
  });
}
