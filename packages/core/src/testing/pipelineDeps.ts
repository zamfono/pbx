// Test-only: a complete `PipelineDeps` over a fake Asterisk and an in-memory database, every
// collaborator a suite does not supply itself standing in as `main.ts` would wire it, or as a
// no-op where it would reach outside the process.
import { expect } from 'vitest';

import { nowIso, type Db, type MailRequest } from '@zamfono/shared';

import { AmiClient } from '../ami/client.js';
import type { AriClient } from '../ari/client.js';
import type { Logger } from '../ari/types.js';
import { CallActions } from '../calls/actions.js';
import { STASIS_WAIT_MS } from '../calls/legOriginate.js';
import { Pipeline, type PipelineDeps } from '../calls/pipeline.js';
import type { ParticipationRecorder } from '../calls/recordParticipation.js';
import { TrunkState } from '../calls/trunkState.js';
import type { MailSender } from '../calls/voicemail.js';
import { EventBus } from '../internal/eventBus.js';
import { ConfigCache } from '../internal/snapshot.js';
import { StateStore } from '../internal/stateStore.js';
import { Presence } from '../presence.js';
import type { FakeAri } from './ari/fake.js';
import { eventually } from './eventually.js';

export const noopLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined
};

/** A CDR writer that writes nothing. */
export function noopCdr(): PipelineDeps['cdr'] {
  return {
    open: () => Promise.resolve(),
    finish: () => Promise.resolve(),
    noteQosLegs: () => undefined,
    channelEnded: () => Promise.resolve(),
    registerLeg: () => undefined,
    joinLeg: () => Promise.resolve()
  };
}

/** A mail sender that sends nothing and keeps every request in `sent`. */
export function stubMailSender(): MailSender & { sent: MailRequest[] } {
  const sent: MailRequest[] = [];
  return {
    sent,
    mail: request => {
      sent.push(request);
      return Promise.resolve();
    }
  };
}

/** A recorder for a stack where nobody records. */
export const noopRecorder: ParticipationRecorder = {
  onCallerUp: () => Promise.resolve(),
  onLegUp: () => Promise.resolve(),
  onTransfereeUp: () => Promise.resolve(),
  onCallerEnded: () => Promise.resolve(),
  onLegEnded: () => Promise.resolve(),
  onLegMoved: () => undefined
};

/** A `TrunkState` over an AMI client that never connects, enough for route selection. */
export function trunkStateFor(
  ari: AriClient,
  db: Db,
  live: { cache?: ConfigCache; state?: StateStore; bus?: EventBus } = {}
): TrunkState {
  return new TrunkState({
    log: noopLogger,
    ari,
    ami: new AmiClient({
      host: '127.0.0.1',
      port: 1,
      username: 'zamfono',
      password: 'secret',
      log: noopLogger
    }),
    cache: live.cache ?? new ConfigCache(db),
    state: live.state ?? new StateStore(),
    bus: live.bus ?? new EventBus(),
    now: nowIso
  });
}

/** Every dependency a `Pipeline` takes, `overrides` replacing any of them. */
export function testPipelineDeps(
  ari: AriClient,
  db: Db,
  overrides: Partial<PipelineDeps> = {}
): PipelineDeps {
  const cache = overrides.cache ?? new ConfigCache(db);
  const state = overrides.state ?? new StateStore();
  const bus = overrides.bus ?? new EventBus();
  return {
    ari,
    cache,
    state,
    bus,
    cdr: noopCdr(),
    recorder: noopRecorder,
    now: nowIso,
    stackTz: 'UTC',
    stackSipHost: null,
    legStasisWaitMs: STASIS_WAIT_MS,
    callLogMaxBytes: 1_048_576,
    mediaDir: '/nonexistent',
    db,
    apiClient: { mail: () => Promise.resolve() },
    logger: noopLogger,
    trunkState:
      overrides.trunkState ?? trunkStateFor(ari, db, { cache, state, bus }),
    presence:
      overrides.presence ??
      new Presence({
        ari,
        cache,
        state,
        bus,
        db,
        log: noopLogger,
        now: nowIso
      }),
    ...overrides
  };
}

/** The live-call actions over a `Pipeline` of its own, for a suite that serves the internal API
 * but drives no call through it. */
export function testActions(ari: AriClient, db: Db): CallActions {
  return new CallActions(new Pipeline(testPipelineDeps(ari, db)));
}

/** The internal server's presence for a suite that drives none: nothing to refresh, nobody
 * registered. */
export function idlePresence(): Pick<
  Presence,
  'refreshAll' | 'registeredDevices'
> {
  return {
    refreshAll: () => Promise.resolve(),
    registeredDevices: () => Promise.resolve(0)
  };
}

/** The internal server's recorder for a suite that records nothing. */
export const idleRecorder = { inProgressCount: 0, mixFailureCount: 0 };

/** Registers `sipUsername`, whose `devices` row is seeded along with the `settings` row, the way a
 * phone's REGISTER reaches the pipeline's `Presence`: a device rings only while registered
 * (§10.1 step 4). */
export async function registerDevice(
  fakeAri: FakeAri,
  pipeline: Pipeline,
  sipUsername: string
): Promise<void> {
  const { cache, presence } = pipeline.deps;
  // `Presence` matches the event against the config snapshot, which must hold the new row; the
  // rows a test seeds after this one reach the snapshot read after it.
  cache.invalidate();
  fakeAri.registerEndpoint(sipUsername);
  await eventually(() => {
    expect(presence.isRegistered(sipUsername)).toBe(true);
  });
  cache.invalidate();
}
