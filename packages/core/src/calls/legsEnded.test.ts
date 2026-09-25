import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { newId, nowIso, openDb, type Db } from '@zamfono/shared';
import { migrateForTest } from '@zamfono/shared/testDb.js';

import { AriClient } from '../ari/client.js';
import { FakeAri } from '../ari/fake.js';
import type { AriEvent, Logger } from '../ari/types.js';
import { settleAnswered } from './answer.js';
import { newCall, type Call, type Leg } from './call.js';
import { trackLeg, type RingOutcome } from './legs.js';
import { handleChannelEnded } from './legsEnded.js';
import {
  ConfigCache,
  EventBus,
  Pipeline,
  StateStore,
  type PipelineDeps
} from './pipeline.js';
import { endRingingLeg } from './ringConclusion.js';

const noopLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined
};

const CALLER_CHANNEL = 'caller-1';
const MEMBER_CHANNEL = 'member-1';
const MEMBER_USER = 'user-1';

describe('handleChannelEnded, the caller channel', () => {
  // eslint-disable-next-line init-declarations -- assigned in beforeEach before each test runs
  let db: Db;
  // eslint-disable-next-line init-declarations -- assigned in beforeEach before each test runs
  let pipeline: Pipeline;
  // eslint-disable-next-line init-declarations -- assigned in beforeEach before each test runs
  let call: Call;
  // eslint-disable-next-line init-declarations -- assigned in beforeEach before each test runs
  let finished: Call[];
  // eslint-disable-next-line init-declarations -- assigned in beforeEach before each test runs
  let fakeAri: FakeAri;
  // eslint-disable-next-line init-declarations -- assigned in beforeEach before each test runs
  let ari: AriClient;

  beforeEach(async () => {
    db = openDb(':memory:');
    await migrateForTest(db);
    finished = [];
    const cdr: PipelineDeps['cdr'] = {
      open: () => Promise.resolve(),
      finish: (ended: Call) => {
        finished.push(ended);
        return Promise.resolve();
      }
    };
    fakeAri = new FakeAri();
    const { url } = await fakeAri.listen();
    ari = new AriClient({
      url,
      user: 'zamfono',
      password: 'secret',
      app: 'zamfono',
      log: noopLogger
    });
    await ari.connect();
    pipeline = new Pipeline({
      ari,
      cache: new ConfigCache(db),
      state: new StateStore(),
      bus: new EventBus(),
      cdr,
      now: nowIso,
      trunkState: null,
      presence: null
    });
    call = newCall({
      id: newId(),
      direction: 'inbound',
      callerChannelId: CALLER_CHANNEL,
      from: '+15559999',
      to: '+15551000',
      startedAt: nowIso(),
      logLevel: 'events',
      callLogMaxBytes: 1_048_576
    });
    pipeline.registerCall(call);
  });

  afterEach(async () => {
    await ari.close();
    await fakeAri.close();
    await db.destroy();
  });

  /** The `ChannelDestroyed` Asterisk sends for the caller's own channel. */
  function callerDestroyed(): AriEvent {
    return {
      type: 'ChannelDestroyed',
      channel: { id: CALLER_CHANNEL }
    } as unknown as AriEvent;
  }

  /** An answered member leg, the state a ring group leaves behind once someone picks up. */
  function answeredLeg(): Leg {
    const leg: Leg = {
      channelId: MEMBER_CHANNEL,
      kind: 'member',
      userId: MEMBER_USER,
      state: 'up',
      endCause: null
    };
    trackLeg(pipeline, call, leg);
    return leg;
  }

  it('closes out an answered call, which nothing else writes past the placeholder', async () => {
    answeredLeg();
    call.status = 'answered';
    call.answeredAt = nowIso();
    call.answeredByUserId = MEMBER_USER;

    await handleChannelEnded(pipeline, callerDestroyed());

    // `open()` writes `interrupted` and only `finish()` replaces it, so a call closed out without
    // it keeps that placeholder, with no `answeredAt` and no `endedAt`, for good.
    expect(finished).toHaveLength(1);
    expect(finished[0]?.status).toBe('answered');
  });

  it('ends an answered leg, so its user is not held in a call for the process lifetime', async () => {
    const leg = answeredLeg();
    call.status = 'answered';

    await handleChannelEnded(pipeline, callerDestroyed());

    // §10.1 step 5 reads `skip_busy` off exactly this: a leg left `up` makes every later ring
    // group skip the member as already in a call.
    expect(leg.state).toBe('ended');
    expect(pipeline.callByChannel.get(MEMBER_CHANNEL)).toBeUndefined();
  });

  /** The call's own bridge, holding `channels`, as `winLeg`/`settleAnswered` leave it. */
  async function bridged(...channels: string[]): Promise<string> {
    const bridge = await ari.bridges.create({ type: 'mixing' });
    for (const channelId of channels) {
      // eslint-disable-next-line no-await-in-loop -- a handful of channels, added in order
      await ari.bridges.addChannel(bridge.id, channelId);
    }
    call.bridgeId = bridge.id;
    return bridge.id;
  }

  /** The `ChannelDestroyed` Asterisk sends for a leg's own channel. */
  function destroyed(channelId: string): AriEvent {
    return {
      type: 'ChannelDestroyed',
      channel: { id: channelId }
    } as unknown as AriEvent;
  }

  /** Whether the core asked Asterisk to hang up `channelId`. */
  function hungUp(channelId: string): boolean {
    return fakeAri.calls.some(
      request =>
        request.method === 'DELETE' && request.path === `channels/${channelId}`
    );
  }

  it('hangs up the answered leg, which the bridge alone never would', async () => {
    answeredLeg();
    call.status = 'answered';
    const bridgeId = await bridged(CALLER_CHANNEL, MEMBER_CHANNEL);

    await handleChannelEnded(pipeline, callerDestroyed());

    expect(hungUp(MEMBER_CHANNEL)).toBe(true);
    const remaining = await ari.bridges.list();
    expect(remaining.map(bridge => bridge.id)).not.toContain(bridgeId);
  });

  it('hangs up the caller once the answered leg hangs up', async () => {
    const leg = answeredLeg();
    call.status = 'answered';
    await bridged(CALLER_CHANNEL, MEMBER_CHANNEL);

    await handleChannelEnded(pipeline, destroyed(MEMBER_CHANNEL));

    expect(hungUp(CALLER_CHANNEL)).toBe(true);
    expect(leg.state).toBe('ended');
  });

  it('leaves a bridge that still holds two parties, as a three-way call does', async () => {
    answeredLeg();
    call.status = 'answered';
    // §10.2 "Three-way calls": the added party is another call's leg in this call's bridge.
    await bridged(CALLER_CHANNEL, MEMBER_CHANNEL, 'added-1');

    await handleChannelEnded(pipeline, destroyed(MEMBER_CHANNEL));

    expect(hungUp(CALLER_CHANNEL)).toBe(false);
    expect(hungUp('added-1')).toBe(false);
  });

  it('hangs up the caller once an answered trunk leg hangs up', async () => {
    const trunkChannel = 'trunk-1';
    fakeAri.addChannel({ id: CALLER_CHANNEL });
    call.legs.set(trunkChannel, {
      channelId: trunkChannel,
      kind: 'trunk',
      userId: null,
      state: 'up',
      endCause: null
    });

    await settleAnswered(pipeline, call, trunkChannel);
    await handleChannelEnded(pipeline, destroyed(trunkChannel));

    expect(hungUp(CALLER_CHANNEL)).toBe(true);
  });

  it('records an unanswered call as missed, as before', async () => {
    await handleChannelEnded(pipeline, callerDestroyed());

    expect(finished).toHaveLength(1);
    expect(finished[0]?.status).toBe('missed');
  });

  /** Rings two device legs and ends both with `causes`, the way their `ChannelDestroyed`s do. */
  function ringOutcomeFor(causes: [number, number]): Promise<RingOutcome> {
    return new Promise(resolve => {
      const timer = setTimeout(() => undefined, 60_000);
      timer.unref();
      pipeline.pendingRing.set(call.id, {
        resolve,
        timer,
        existingBridgeId: null
      });
      const legs = causes.map((cause, index) => {
        const leg: Leg = {
          channelId: `device-${index}`,
          kind: 'device',
          userId: MEMBER_USER,
          state: 'ringing',
          endCause: null
        };
        trackLeg(pipeline, call, leg);
        return { leg, cause };
      });
      for (const { leg, cause } of legs) {
        endRingingLeg(pipeline, call, leg, cause);
      }
    });
  }

  // Asterisk's Q.850 mapping: SIP 486 and 600 → USER_BUSY (17), SIP 603 → CALL_REJECTED (21).
  it('applies busy only when every device answered 486 or 600 (§10.1 step 4)', async () => {
    await expect(ringOutcomeFor([17, 17])).resolves.toBe('busy');
  });

  it('applies noAnswer, not busy, once a device declined with 603 (§10.1 step 4)', async () => {
    await expect(ringOutcomeFor([21, 21])).resolves.toBe('noAnswer');
    pipeline.pendingRing.clear();
    call.legs.clear();
    await expect(ringOutcomeFor([17, 21])).resolves.toBe('noAnswer');
  });
});
