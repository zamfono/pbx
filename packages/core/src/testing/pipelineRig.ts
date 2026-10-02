// Test-only: the call-control suites' shared rig, a Pipeline over a fake Asterisk, an in-memory
// database and the collaborators `main.ts` wires it with, and the calls those suites start from;
// the rows they seed are `seedRows.ts`'s.
import { newId, nowIso, openDb, type Db } from '@zamfono/shared';
import { migrateForTest } from '@zamfono/shared/testDb.js';

import { AmiClient } from '../ami/client.js';
import { AriClient } from '../ari/client.js';
import { FakeAri } from '../ari/fake.js';
import type { Logger } from '../ari/types.js';
import type { CallActions } from '../calls/actions.js';
import { newCall, type Call } from '../calls/call.js';
import { Pipeline, type PipelineDeps } from '../calls/pipeline.js';
import { TrunkState } from '../calls/trunkState.js';
import { CdrWriter } from '../cdr.js';
import { EventBus } from '../internal/eventBus.js';
import { startInternalServer } from '../internal/server.js';
import { ConfigCache } from '../internal/snapshot.js';
import { StateStore } from '../internal/stateStore.js';
import { Presence } from '../presence.js';
import { seedSettings } from './seedRows.js';

// Any free port, never a fixed one another suite running on the same host may already hold.
const ANY_FREE_PORT = 0;

export const noopLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined
};

/** The rig's own collaborators, one of each, wired as `main.ts` wires them. */
export type Rig = {
  db: Db;
  fakeAri: FakeAri;
  ari: AriClient;
  cache: ConfigCache;
  state: StateStore;
  bus: EventBus;
  cdr: CdrWriter;
  presence: Presence;
  pipeline: Pipeline;
  /** Reads the endpoint list and the config snapshot once every row a test needs exists. */
  devicesUp: () => Promise<void>;
  /** A `TrunkState` over an AMI client that never connects, enough for route selection. */
  trunkState: () => TrunkState;
  /** Serves `actions` on the internal API; its base URL. */
  startServer: (actions: CallActions) => Promise<string>;
  /** Whether the core hung `channelId` up. */
  hungUp: (channelId: string) => boolean;
  stop: () => Promise<void>;
};

/** A `TrunkState` over an AMI client that never connects, enough for route selection. */
function trunkStateFor(ari: AriClient, db: Db): TrunkState {
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
    cache: new ConfigCache(db),
    state: new StateStore(),
    bus: new EventBus(),
    now: nowIso
  });
}

/** An ARI client connected to a fake Asterisk listening on a free port. */
async function connectFakeAri(): Promise<{ fakeAri: FakeAri; ari: AriClient }> {
  const fakeAri = new FakeAri();
  fakeAri.answerAfterMs = 5;
  const { url } = await fakeAri.listen();
  const ari = new AriClient({
    url,
    user: 'zamfono',
    password: 'secret',
    app: 'zamfono',
    log: noopLogger
  });
  await ari.connect();
  return { fakeAri, ari };
}

/** A Pipeline whose deps `overrides` may replace (a stub mail sender, a trunk state, no
 * presence), over a fresh database and a listening fake Asterisk. */
export async function startRig(
  overrides: Partial<PipelineDeps> = {}
): Promise<Rig> {
  const db = openDb(':memory:');
  await migrateForTest(db);
  await seedSettings(db);
  const { fakeAri, ari } = await connectFakeAri();
  const cache = new ConfigCache(db);
  const state = new StateStore();
  const bus = new EventBus();
  const live = { db, ari, cache, bus, state, log: noopLogger, now: nowIso };
  const cdr = new CdrWriter(live);
  const presence = new Presence(live);
  const pipeline = new Pipeline({
    ari,
    cache,
    state,
    bus,
    cdr,
    now: nowIso,
    db,
    trunkState: null,
    presence,
    ...overrides
  });
  let closeServer: (() => Promise<void>) | null = null;
  return {
    db,
    fakeAri,
    ari,
    cache,
    state,
    bus,
    cdr,
    presence,
    pipeline,
    devicesUp: async () => {
      cache.invalidate();
      await presence.resyncOnBoot();
    },
    trunkState: () => trunkStateFor(ari, db),
    startServer: async actions => {
      const started = await startInternalServer(
        {
          db,
          ari,
          log: noopLogger,
          cache: new ConfigCache(db),
          state: new StateStore(),
          bus: new EventBus(),
          actions,
          presence: null,
          trunks: null
        },
        ANY_FREE_PORT
      );
      closeServer = started.close;
      return `http://127.0.0.1:${started.port}`;
    },
    hungUp: channelId =>
      fakeAri.calls.some(
        entry =>
          entry.method === 'DELETE' && entry.path === `channels/${channelId}`
      ),
    stop: async () => {
      await closeServer?.();
      await ari.close();
      await fakeAri.close();
      await db.destroy();
    }
  };
}

/**
 * An inbound call from `from` that `userId`'s device answered, bridged as `winLeg` leaves one,
 * registered with the pipeline and opened in the CDR; its device leg's channel is named
 * `legName`.
 */
export async function answeredCall(
  rig: Rig,
  userId: string,
  options: { from?: string; legName?: string } = {}
): Promise<Call> {
  const { fakeAri, ari, pipeline, cdr } = rig;
  const from = options.from ?? '+15559999';
  const caller = fakeAri.addChannel({
    name: 'PJSIP/trunk-1-00000001',
    caller: { number: from, name: '' }
  });
  const leg = fakeAri.addChannel({
    name: options.legName ?? 'PJSIP/e101-a-00000002'
  });
  const bridge = await ari.bridges.create({ type: 'mixing' });
  await ari.bridges.addChannel(bridge.id, caller.id);
  await ari.bridges.addChannel(bridge.id, leg.id);
  const call = newCall({
    id: newId(),
    direction: 'inbound',
    callerChannelId: caller.id,
    from,
    to: '101',
    startedAt: nowIso(),
    logLevel: 'events',
    callLogMaxBytes: 1_048_576
  });
  call.calleeUserId = userId;
  call.answeredByUserId = userId;
  call.answeredAt = nowIso();
  call.status = 'answered';
  call.bridgeId = bridge.id;
  call.legs.set(leg.id, {
    channelId: leg.id,
    kind: 'device',
    userId,
    state: 'up',
    endCause: null
  });
  pipeline.registerCall(call);
  pipeline.callByChannel.set(leg.id, call);
  await cdr.open(call);
  return call;
}

/** `call`'s one device leg's channel. */
export function legOf(call: Call): string {
  const [leg] = call.legs.keys();
  if (leg === undefined) {
    throw new Error('no leg');
  }
  return leg;
}

/** Whether the core set `channelId`'s language to `language` (§9.1). */
export function languageSet(
  fakeAri: FakeAri,
  channelId: string,
  language: string
): boolean {
  return fakeAri.calls.some(
    entry =>
      entry.method === 'POST' &&
      entry.path === `channels/${channelId}/variable` &&
      (entry.body as { variable?: string }).variable === 'CHANNEL(language)' &&
      (entry.body as { value?: string }).value === language
  );
}
