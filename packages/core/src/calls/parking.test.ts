import { afterEach, describe, expect, it } from 'vitest';

import { newId, nowIso, type Db } from '@zamfono/shared';
import { seedUser } from '@zamfono/shared/testDb.js';

import type { AriClient } from '../ari/client.js';
import type { AriEventOf } from '../ari/events.js';
import type { Channel } from '../ari/types.js';
import type { CdrWriter } from '../cdr.js';
import { ERROR_TONE_MEDIA } from '../indications.js';
import type { Presence } from '../presence.js';
import { contactEndpoint } from '../testing/ami/contacts.js';
import type { FakeAri } from '../testing/ari/fake.js';
import { defaultChannel } from '../testing/ari/fakeChannel.js';
import { isPlacement } from '../testing/ari/fakeDial.js';
import { eventually } from '../testing/eventually.js';
import {
  callsRow,
  channelDestroyed,
  hintPutsFor,
  newInternalCall,
  startFeatureRig
} from '../testing/featureRig.js';
import { noopRecorder } from '../testing/pipelineDeps.js';
import { languageSet, type Rig } from '../testing/pipelineRig.js';
import { seedDevice, seedExtension } from '../testing/seedRows.js';
import { newCall, type Call, type Leg } from './call.js';
import { channelOf, otherChannelIn } from './callLookup.js';
import { callUp, liveView } from './callState.js';
import { handleFeature } from './features.js';
import { handleOutbound } from './outbound.js';
import { retrieveParkedCall } from './parkingRetrieval.js';
import type { Pipeline } from './pipeline.js';
import type { ParticipationRecorder } from './recordParticipation.js';
import { sipToHangupCause } from './releaseCause.js';

// A parking slot's timeout in the ring-back tests (`setUp`'s `parkingTimeoutS`), and how long past
// it the ring-back's outcome is waited for.
const PARKING_TIMEOUT_S = 1;
const RINGBACK_WAIT_MS = 5000;

describe('parking', () => {
  let rig: Rig;
  let db: Db;
  let fakeAri: FakeAri;
  let ari: AriClient;
  let pipeline: Pipeline;
  let cdr: CdrWriter;
  let presence: Presence;

  async function setUp(parkingTimeoutS?: number): Promise<void> {
    rig = await startFeatureRig(parkingTimeoutS);
    ({ db, fakeAri, ari, pipeline, cdr, presence } = rig);
  }

  afterEach(async () => {
    await rig.stop();
  });

  /** A bridged call between a customer and the parker, which the parker then parks with `*70`:
   * an inbound call the parker answered, or with `parkerIsCaller` one the parker dialled out. */
  async function setUpParkedCall(
    options: { parkerIsCaller?: boolean; recorder?: ParticipationRecorder } = {}
  ): Promise<{
    activeCall: Call;
    parkerUserId: string;
    bridgeId: string;
    partyChannelId: string;
    parkerChannelId: string;
  }> {
    await setUp();
    pipeline.deps.recorder = options.recorder ?? noopRecorder;
    await seedExtension(db, '701', { isParkingSlot: 1 });
    const parkerUserId = await seedUser(db);
    await seedExtension(db, '100', { userId: parkerUserId });
    const customerChannel = fakeAri.addChannel({
      caller: { number: '+15559999', name: '' }
    });
    const parkerChannel = fakeAri.addChannel({});
    const parkerIsCaller = options.parkerIsCaller === true;
    const activeCall = newCall({
      id: newId(),
      direction: parkerIsCaller ? 'outbound' : 'inbound',
      callerChannelId: parkerIsCaller ? parkerChannel.id : customerChannel.id,
      from: parkerIsCaller ? '100' : '+15559999',
      to: parkerIsCaller ? '+15559999' : '100',
      startedAt: nowIso(),
      logLevel: 'events',
      callLogMaxBytes: 1_048_576
    });
    activeCall.status = 'answered';
    if (parkerIsCaller) {
      activeCall.callerUserId = parkerUserId;
    }
    const answeredLeg: Leg = parkerIsCaller
      ? {
          channelId: customerChannel.id,
          kind: 'trunk',
          userId: null,
          state: 'up',
          endCause: null
        }
      : {
          channelId: parkerChannel.id,
          kind: 'device',
          userId: parkerUserId,
          state: 'up',
          endCause: null
        };
    activeCall.legs.set(answeredLeg.channelId, answeredLeg);
    pipeline.callByChannel.set(answeredLeg.channelId, activeCall);
    const bridge = await ari.bridges.create({ type: 'mixing' });
    await ari.bridges.addChannel(bridge.id, customerChannel.id);
    await ari.bridges.addChannel(bridge.id, parkerChannel.id);
    activeCall.bridgeId = bridge.id;
    pipeline.registerCall(activeCall);
    await cdr.open(activeCall);
    // The state `legs.ts`'s `winLeg` would have left for the parker's answered leg.
    presence.setCallState(
      parkerUserId,
      'inCall',
      '+15559999',
      null,
      activeCall.id
    );
    // Its refresh has logged the parker `busy` before the park moves them on.
    await eventually(async () => {
      const rows = await db
        .selectFrom('presenceLog')
        .select('status')
        .where('userId', '=', parkerUserId)
        .execute();
      expect(rows.map(row => row.status)).toEqual(['busy']);
    });

    const parkDialChannel = fakeAri.addChannel({});
    const parkDial = newInternalCall(parkDialChannel.id, 'e100', '*70');
    parkDial.callerUserId = parkerUserId;
    pipeline.registerCall(parkDial);
    await cdr.open(parkDial);

    await handleFeature(pipeline, presence, parkDial, 'park', '');
    return {
      activeCall,
      parkerUserId,
      bridgeId: bridge.id,
      partyChannelId: customerChannel.id,
      parkerChannelId: parkerChannel.id
    };
  }

  it('parked call retrieved by dialing 701', async () => {
    const { activeCall, bridgeId, partyChannelId } = await setUpParkedCall();

    const retrieverUserId = await seedUser(db);
    const retrieverChannel = fakeAri.addChannel({});
    const retrieverCall = newInternalCall(retrieverChannel.id, 'e200', '701');
    retrieverCall.callerUserId = retrieverUserId;
    pipeline.registerCall(retrieverCall);
    await cdr.open(retrieverCall);

    const outcome = await retrieveParkedCall(
      pipeline,
      presence,
      retrieverCall,
      '701'
    );

    expect(outcome).toBe('retrieved');
    expect(activeCall.answeredByUserId).toBe(retrieverUserId);
    // §10.2 "Call parking": the party waited in a `holding` bridge, the original conversation's
    // bridge being destroyed; retrieval moves them into a `mixing` bridge the retriever joins.
    const bridgeTypes = fakeAri.calls
      .filter(entry => entry.method === 'POST' && entry.path === 'bridges')
      .map(entry => (entry.body as { type?: string }).type);
    expect(bridgeTypes).toEqual(['mixing', 'holding', 'mixing']);
    expect(
      fakeAri.calls.some(
        entry =>
          entry.method === 'DELETE' && entry.path === `bridges/${bridgeId}`
      )
    ).toBe(true);
    const retrieverJoin = fakeAri.calls.find(
      entry =>
        entry.method === 'POST' &&
        entry.path.endsWith('/addChannel') &&
        (entry.body as { channel?: string }).channel === retrieverChannel.id
    );
    if (retrieverJoin === undefined) {
      throw new Error('retriever channel never joined a bridge');
    }
    expect(retrieverJoin.path).not.toBe(`bridges/${bridgeId}/addChannel`);
    expect(
      fakeAri.calls.some(
        entry =>
          entry.method === 'POST' &&
          entry.path === retrieverJoin.path &&
          (entry.body as { channel?: string }).channel === partyChannelId
      )
    ).toBe(true);
    expect(activeCall.bridgeId).toBe(
      retrieverJoin.path.slice('bridges/'.length, -'/addChannel'.length)
    );
    // The retriever's own channel now carries the conversation (§9.3 table): it must stay up.
    const retrieverHangup = fakeAri.calls.some(
      entry =>
        entry.method === 'DELETE' &&
        entry.path === `channels/${retrieverChannel.id}`
    );
    expect(retrieverHangup).toBe(false);
    // The held party stops hearing hold music once the retriever joins (§10.2 "Call parking").
    const mohStopped = fakeAri.calls.some(
      entry =>
        entry.method === 'DELETE' &&
        entry.path === `channels/${partyChannelId}/moh`
    );
    expect(mohStopped).toBe(true);
  });

  /** The retriever's own user, extension and device, added after `setUpParkedCall` warmed the
   * config snapshot; the invalidation stands in for the api's `/internal/configChanged`. */
  async function seedRetriever(): Promise<string> {
    pipeline.deps.trunkState = rig.trunkState();
    const retrieverUserId = await seedUser(db);
    await seedExtension(db, '200', { userId: retrieverUserId });
    await seedDevice(db, retrieverUserId, 'e200-dabc');
    pipeline.deps.cache.invalidate();
    return retrieverUserId;
  }

  function outboundEvent(
    channel: Channel,
    dialed: string
  ): AriEventOf<'StasisStart'> {
    return {
      type: 'StasisStart',
      timestamp: nowIso(),
      application: 'zamfono',
      args: ['outbound', dialed],
      channel
    };
  }

  it('dialling 701 from a registered device retrieves the parked call through the outbound entry', async () => {
    const { activeCall, partyChannelId } = await setUpParkedCall();
    const retrieverUserId = await seedRetriever();
    const retrieverChannel = fakeAri.addChannel({
      name: 'PJSIP/e200-dabc-00000001',
      caller: { number: '200', name: '' }
    });

    await handleOutbound(pipeline, outboundEvent(retrieverChannel, '701'));

    expect(activeCall.answeredByUserId).toBe(retrieverUserId);
    const retrieverJoin = fakeAri.calls.find(
      entry =>
        entry.method === 'POST' &&
        entry.path.endsWith('/addChannel') &&
        (entry.body as { channel?: string }).channel === retrieverChannel.id
    );
    expect(retrieverJoin).toBeDefined();
    expect(
      fakeAri.calls.some(
        entry =>
          entry.method === 'POST' &&
          entry.path === retrieverJoin?.path &&
          (entry.body as { channel?: string }).channel === partyChannelId
      )
    ).toBe(true);
    // The retriever's own channel now carries the conversation (§9.3 table): it stays up.
    expect(
      fakeAri.calls.some(
        entry =>
          entry.method === 'DELETE' &&
          entry.path === `channels/${retrieverChannel.id}`
      )
    ).toBe(false);
  });

  it('dialling an empty parking slot plays a short error tone and releases with 404', async () => {
    await setUp();
    await seedExtension(db, '701', { isParkingSlot: 1 });
    await seedRetriever();
    const channel = fakeAri.addChannel({
      name: 'PJSIP/e200-dabc-00000001',
      caller: { number: '200', name: '' }
    });

    await handleOutbound(pipeline, outboundEvent(channel, '701'));

    // §9.3 table, §10.1 Outbound step 3: the short error tone, then the release.
    const relevant = fakeAri.calls.filter(
      entry =>
        entry.path === `channels/${channel.id}/play` ||
        (entry.method === 'DELETE' && entry.path === `channels/${channel.id}`)
    );
    expect(relevant.map(entry => entry.method)).toEqual(['POST', 'DELETE']);
    expect((relevant[0]?.body as { media?: string }).media).toBe(
      ERROR_TONE_MEDIA
    );
    expect(relevant[1]?.qs).toBe(`reason_code=${sipToHangupCause(404)}`);
  });

  it('the parked party hanging up releases the slot instead of leaving it occupied', async () => {
    const { partyChannelId } = await setUpParkedCall();

    fakeAri.emit({
      type: 'ChannelDestroyed',
      timestamp: nowIso(),
      application: 'zamfono',
      channel: defaultChannel({ id: partyChannelId }),
      cause: 16
    });

    // §9.3 "a parking slot: INUSE while a call is parked there" — released, so the hint reverts.
    await eventually(() => {
      const hintPuts = fakeAri.calls.filter(
        entry =>
          entry.method === 'PUT' &&
          entry.path === 'deviceStates/Stasis:presence-701'
      );
      expect(
        (hintPuts.at(-1)?.body as { deviceState?: string }).deviceState
      ).toBe('NOT_INUSE');
    });

    const retrieverChannel = fakeAri.addChannel({});
    const retrieverCall = newInternalCall(retrieverChannel.id, 'e200', '701');
    pipeline.registerCall(retrieverCall);
    await cdr.open(retrieverCall);
    const outcome = await retrieveParkedCall(
      pipeline,
      presence,
      retrieverCall,
      '701'
    );
    expect(outcome).toBe('empty');
  });

  it("parking hangs up the parker's own channel, not just removes it from the bridge", async () => {
    const { parkerChannelId } = await setUpParkedCall();

    const parkerHangup = fakeAri.calls.some(
      entry =>
        entry.method === 'DELETE' &&
        entry.path === `channels/${parkerChannelId}`
    );
    expect(parkerHangup).toBe(true);
  });

  it("parking returns the parker's own hint from INUSE and their presence from busy", async () => {
    const { parkerUserId } = await setUpParkedCall();

    await eventually(async () => {
      expect(hintPutsFor(fakeAri, '100').at(-1)).not.toEqual({
        deviceState: 'INUSE'
      });
      const rows = await db
        .selectFrom('presenceLog')
        .select('status')
        .where('userId', '=', parkerUserId)
        .orderBy('since', 'asc')
        .execute();
      expect(rows.map(row => row.status)).toEqual(['busy', 'offline']);
    });
  });

  /** A stub recorder noting each participation it is told has started or ended. */
  function endingRecorder(ended: string[]): ParticipationRecorder {
    return {
      ...noopRecorder,
      onCallerUp: () => Promise.resolve(),
      onLegUp: (_call, leg) => {
        ended.push(`up:${leg.channelId}`);
        return Promise.resolve();
      },
      onTransfereeUp: () => Promise.resolve(),
      onCallerEnded: call => {
        ended.push(`caller:${call.callerChannelId}`);
        return Promise.resolve();
      },
      onLegEnded: (_call, leg) => {
        ended.push(`leg:${leg.channelId}`);
        return Promise.resolve();
      }
    };
  }

  it("parking ends the parker's recorded participation, as leaving the bridge does (§10.2 Recording semantics)", async () => {
    const answererEnded: string[] = [];
    const answerer = await setUpParkedCall({
      recorder: endingRecorder(answererEnded)
    });
    expect(answererEnded).toEqual([`leg:${answerer.parkerChannelId}`]);

    const callerEnded: string[] = [];
    const caller = await setUpParkedCall({
      parkerIsCaller: true,
      recorder: endingRecorder(callerEnded)
    });
    expect(callerEnded).toEqual([`caller:${caller.parkerChannelId}`]);
  });

  /** Dials slot 701 from a fresh retriever channel, which `retrieveParkedCall` folds into the
   * parked call. */
  async function retrieve(): Promise<{
    retrieverUserId: string;
    retrieverChannelId: string;
    retrieverCall: Call;
  }> {
    const retrieverUserId = await seedUser(db);
    // Stands in for the api's `/internal/configChanged`, so presence knows the new user.
    pipeline.deps.cache.invalidate();
    const retrieverChannel = fakeAri.addChannel({});
    const retrieverCall = newInternalCall(retrieverChannel.id, 'e200', '701');
    retrieverCall.callerUserId = retrieverUserId;
    pipeline.registerCall(retrieverCall);
    await cdr.open(retrieverCall);
    await expect(
      retrieveParkedCall(pipeline, presence, retrieverCall, '701')
    ).resolves.toBe('retrieved');
    return {
      retrieverUserId,
      retrieverChannelId: retrieverChannel.id,
      retrieverCall
    };
  }

  it('the retriever hanging up ends the parked party’s call instead of leaving it in dead air', async () => {
    const ended: string[] = [];
    const { activeCall, partyChannelId } = await setUpParkedCall({
      recorder: endingRecorder(ended)
    });
    const { retrieverUserId, retrieverChannelId, retrieverCall } =
      await retrieve();

    // The retriever is the parked call's answered leg: in a call, and recorded on its own flags.
    expect(pipeline.callByChannel.get(retrieverChannelId)).toBe(activeCall);
    expect(ended).toContain(`up:${retrieverChannelId}`);
    await eventually(() => {
      expect(pipeline.deps.state.presence.get(retrieverUserId)?.status).toBe(
        'busy'
      );
    });
    expect((await callsRow(db, retrieverCall.id)).endedAt).not.toBeNull();

    channelDestroyed(fakeAri, retrieverChannelId);
    await eventually(() => {
      expect(rig.hungUp(partyChannelId)).toBe(true);
    });
    expect(ended).toContain(`leg:${retrieverChannelId}`);
    channelDestroyed(fakeAri, partyChannelId);
    await eventually(async () => {
      const row = await callsRow(db, activeCall.id);
      expect(row.status).toBe('answered');
      expect(row.endedAt).not.toBeNull();
    });
    await eventually(() => {
      expect(
        pipeline.deps.state.presence.get(retrieverUserId)?.status
      ).not.toBe('busy');
    });
  });

  it('a call its caller parked still ends its row once the retrieved conversation ends', async () => {
    const { activeCall, partyChannelId } = await setUpParkedCall({
      parkerIsCaller: true
    });
    const { retrieverChannelId } = await retrieve();

    // The party hangs up this time: the retriever is hung up with them, and the row ends.
    channelDestroyed(fakeAri, partyChannelId);
    await eventually(() => {
      expect(rig.hungUp(retrieverChannelId)).toBe(true);
    });
    await eventually(async () => {
      const row = await callsRow(db, activeCall.id);
      expect(row.status).toBe('answered');
      expect(row.endedAt).not.toBeNull();
    });
  });

  it('a call its caller parked ends its row when the parked party hangs up while waiting', async () => {
    const { activeCall, partyChannelId } = await setUpParkedCall({
      parkerIsCaller: true
    });

    channelDestroyed(fakeAri, partyChannelId);

    await eventually(async () => {
      expect((await callsRow(db, activeCall.id)).endedAt).not.toBeNull();
    });
  });

  it('an unanswered parking ring-back routes the parked party to the tenant fallback target', async () => {
    await setUp(PARKING_TIMEOUT_S);
    // §9.1: the party the fallback plays to may be a leg the core originated, with no entry of
    // its own that set its language.
    await db.updateTable('settings').set({ language: 'de' }).execute();
    // No device for the parker at all: `ringParkerBack` originates nothing and settles the
    // ring-back as unanswered immediately, without needing to wait out its own 30 s race window.
    // Nor a mailbox, which would take the party in the tenant fallback's place.
    await seedExtension(db, '701', { isParkingSlot: 1 });
    const parkerUserId = await seedUser(db);
    await db
      .updateTable('users')
      .set({ mailboxEnabled: 0 })
      .where('id', '=', parkerUserId)
      .execute();
    await seedExtension(db, '100', { userId: parkerUserId });
    const customerChannel = fakeAri.addChannel({
      caller: { number: '+15559999', name: '' }
    });
    const parkerChannel = fakeAri.addChannel({});
    const activeCall = newCall({
      id: newId(),
      direction: 'inbound',
      callerChannelId: customerChannel.id,
      from: '+15559999',
      to: '100',
      startedAt: nowIso(),
      logLevel: 'events',
      callLogMaxBytes: 1_048_576
    });
    activeCall.legs.set(parkerChannel.id, {
      channelId: parkerChannel.id,
      kind: 'device',
      userId: parkerUserId,
      state: 'up',
      endCause: null
    });
    const bridge = await ari.bridges.create({ type: 'mixing' });
    await ari.bridges.addChannel(bridge.id, customerChannel.id);
    await ari.bridges.addChannel(bridge.id, parkerChannel.id);
    activeCall.bridgeId = bridge.id;
    pipeline.registerCall(activeCall);
    await cdr.open(activeCall);

    const parkDialChannel = fakeAri.addChannel({});
    const parkDial = newInternalCall(parkDialChannel.id, 'e100', '*70');
    parkDial.callerUserId = parkerUserId;
    pipeline.registerCall(parkDial);
    await cdr.open(parkDial);

    await handleFeature(pipeline, presence, parkDial, 'park', '');

    // The slot times out, the ring-back finds no device, and the fallback releases the party.
    await eventually(async () => {
      // seedSettings() leaves settings.fallbackTargetId NULL, so §11.3's own rule for that case
      // applies: the party is released with 404, not just dropped as 'missed' without a code.
      const fallbackReleased = fakeAri.calls.some(
        entry =>
          entry.method === 'DELETE' &&
          entry.path === `channels/${customerChannel.id}` &&
          entry.qs === `reason_code=${sipToHangupCause(404)}`
      );
      expect(fallbackReleased).toBe(true);
      expect(languageSet(fakeAri, customerChannel.id, 'de')).toBe(true);
      const ringbackRows = await db
        .selectFrom('calls')
        .select('status')
        .where('direction', '=', 'internal')
        .where('toUri', '=', '100')
        .execute();
      expect(ringbackRows).toHaveLength(1);
      expect(ringbackRows[0]?.status).not.toBe('interrupted');
      expect(pipeline.channelless.size).toBe(0);
    }, RINGBACK_WAIT_MS);
    // The ring-back has no caller channel, and no request is made against one.
    expect(fakeAri.calls.some(entry => entry.path.includes('/null'))).toBe(
      false
    );
  }, 10_000);

  it('parking timeout rings the parker back through the pipeline and joins the parked bridge on answer', async () => {
    await setUp(PARKING_TIMEOUT_S);
    // The ring-back is a real internal call through `runUserStep`/`ringUser`;
    // this test wants the parker's device to answer promptly once dialled.
    fakeAri.answerAfterMs = 10;
    const parkerDeviceUsername = 'e100-dabc';
    await seedExtension(db, '701', { isParkingSlot: 1 });
    const parkerUserId = await seedUser(db);
    await seedExtension(db, '100', { userId: parkerUserId });
    // the parking ring-back rings the parker, whose device must be reachable (§10.1 step 4).
    fakeAri.registerEndpoint(parkerDeviceUsername);
    await seedDevice(db, parkerUserId, parkerDeviceUsername);
    await presence.resyncOnBoot();
    const customerChannel = fakeAri.addChannel({
      caller: { number: '+15559999', name: '' }
    });
    const parkerChannel = fakeAri.addChannel({});
    const activeCall = newCall({
      id: newId(),
      direction: 'inbound',
      callerChannelId: customerChannel.id,
      from: '+15559999',
      to: '100',
      startedAt: nowIso(),
      logLevel: 'events',
      callLogMaxBytes: 1_048_576
    });
    activeCall.legs.set(parkerChannel.id, {
      channelId: parkerChannel.id,
      kind: 'device',
      userId: parkerUserId,
      state: 'up',
      endCause: null
    });
    const bridge = await ari.bridges.create({ type: 'mixing' });
    await ari.bridges.addChannel(bridge.id, customerChannel.id);
    await ari.bridges.addChannel(bridge.id, parkerChannel.id);
    activeCall.bridgeId = bridge.id;
    pipeline.registerCall(activeCall);
    await cdr.open(activeCall);
    callUp(pipeline.deps, activeCall);

    const parkDialChannel = fakeAri.addChannel({});
    const parkDial = newInternalCall(parkDialChannel.id, 'e100', '*70');
    parkDial.callerUserId = parkerUserId;
    pipeline.registerCall(parkDial);
    await cdr.open(parkDial);

    await handleFeature(pipeline, presence, parkDial, 'park', '');

    // The slot times out and the ring-back's answer joins the parker to the parked party.
    await eventually(() => {
      const rangParker = fakeAri.calls.some(
        entry =>
          isPlacement(entry) &&
          (entry.body as { endpoint?: string }).endpoint ===
            contactEndpoint(parkerDeviceUsername)
      );
      expect(rangParker).toBe(true);
      // §10.2 "Call parking": "whose answer lands in the parked bridge" — the bridge the customer
      // is waiting in, not a bridge of the ring-back's own (legs.ts's `winLeg` with
      // `existingBridgeId`).
      const customerJoins = fakeAri.calls.filter(
        entry =>
          entry.method === 'POST' &&
          entry.path.endsWith('/addChannel') &&
          (entry.body as { channel?: string }).channel === customerChannel.id
      );
      const parkedBridgePath = customerJoins.at(-1)?.path;
      expect(parkedBridgePath).toBeDefined();
      expect(parkedBridgePath).not.toBe(`bridges/${bridge.id}/addChannel`);
      const joinedParkedBridge = fakeAri.calls.some(entry => {
        if (entry.method !== 'POST' || entry.path !== parkedBridgePath) {
          return false;
        }
        const channel = (entry.body as { channel?: string }).channel;
        return (
          channel !== undefined &&
          channel !== customerChannel.id &&
          channel !== parkerChannel.id
        );
      });
      expect(joinedParkedBridge).toBe(true);
    }, RINGBACK_WAIT_MS);
    // The ring-back's own `calls` row (an internal call to the parker's extension) is closed
    // out, not left at the `interrupted` placeholder `CdrWriter.open` writes; the parked call
    // has its answerer by then.
    await eventually(async () => {
      const ringbackRow = await db
        .selectFrom('calls')
        .select(['direction', 'status', 'calleeUserId', 'endedAt'])
        .where('toUri', '=', '100')
        .where('direction', '=', 'internal')
        .executeTakeFirstOrThrow();
      expect(ringbackRow.direction).toBe('internal');
      expect(ringbackRow.status).toBe('answered');
      expect(ringbackRow.calleeUserId).toBe(parkerUserId);
      expect(ringbackRow.endedAt).not.toBeNull();
    }, RINGBACK_WAIT_MS);
    expect(activeCall.answeredByUserId).toBe(parkerUserId);
    expect(pipeline.channelless.size).toBe(0);
    // §10.3 "Live calls": the parker who answered is connected in the parked call itself, their
    // answered leg one of its own, so they may end or transfer it.
    const parkerLeg = [...activeCall.legs.values()].find(
      leg => leg.userId === parkerUserId && leg.state === 'up'
    );
    expect(parkerLeg?.channelId).not.toBe(parkerChannel.id);
    expect(pipeline.callByChannel.get(parkerLeg?.channelId ?? '')).toBe(
      activeCall
    );
    expect(
      liveView(
        pipeline.deps.state.calls.get(activeCall.id) ?? expect.unreachable()
      ).connectedUserIds
    ).toEqual([parkerUserId]);
  }, 10_000);

  it('finds a caller who left only by a leg they joined again by, and the other party among the legs (§10.2 "Call parking")', () => {
    const call = newInternalCall('caller-gone', '100', '+15559999');
    call.callerUserId = 'parker';
    call.callerEnded = true;
    for (const [channelId, userId] of [
      ['party', null],
      ['ringback', 'parker']
    ] as const) {
      call.legs.set(channelId, {
        channelId,
        kind: userId === null ? 'trunk' : 'device',
        userId,
        state: 'up',
        endCause: null
      });
    }
    call.bridgeId = 'bridge';

    expect(channelOf(call, 'parker')).toBe('ringback');
    expect(otherChannelIn(call, 'ringback')).toBe('party');
    expect(otherChannelIn(call, 'party')).toBe('ringback');
  });
});
