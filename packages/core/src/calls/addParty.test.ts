import { afterEach, describe, expect, it } from 'vitest';

import { newId, nowIso, type Db } from '@zamfono/shared';
import { seedUser } from '@zamfono/shared/testDb.js';

import type { AriClient } from '../ari/client.js';
import type { CdrWriter } from '../cdr.js';
import type { Presence } from '../presence.js';
import { contactEndpoint } from '../testing/ami/contacts.js';
import type { FakeAri } from '../testing/ari/fake.js';
import { defaultChannel } from '../testing/ari/fakeChannel.js';
import { isPlacement } from '../testing/ari/fakeDial.js';
import { onEvents } from '../testing/busEvents.js';
import { delivered, eventually, flush } from '../testing/eventually.js';
import {
  addedPartyLeaves,
  callsRow,
  channelDestroyed,
  hintPutsFor,
  newInternalCall,
  registerWithPresence,
  seedMember,
  startFeatureRig,
  traceEvents
} from '../testing/featureRig.js';
import { noopRecorder } from '../testing/pipelineDeps.js';
import type { Rig } from '../testing/pipelineRig.js';
import {
  seedDevice,
  seedExtension,
  seedExternalRoute,
  seedRingGroup
} from '../testing/seedRows.js';
import { newCall, type Call, type Leg } from './call.js';
import { handleFeature } from './features.js';
import type { Pipeline } from './pipeline.js';
import { sipToHangupCause } from './releaseCause.js';

describe('add party', () => {
  let rig: Rig;
  let db: Db;
  let fakeAri: FakeAri;
  let ari: AriClient;
  let pipeline: Pipeline;
  let cdr: CdrWriter;
  let presence: Presence;

  async function setUp(): Promise<void> {
    rig = await startFeatureRig();
    ({ db, fakeAri, ari, pipeline, cdr, presence } = rig);
  }

  afterEach(async () => {
    await rig.stop();
  });

  it('add-party creates a child calls row', async () => {
    await setUp();
    const userA = await seedUser(db);
    const userC = await seedUser(db);
    // add-party dials a colleague, whose device must be reachable to ring (§10.1 step 4).
    fakeAri.registerEndpoint('e300-dabc');
    await seedDevice(db, userC, 'e300-dabc');
    await seedExtension(db, '300', { userId: userC });

    const customerChannel = fakeAri.addChannel({
      caller: { number: '+15559999', name: '' }
    });
    const userAChannel = fakeAri.addChannel({});
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
    activeCall.legs.set(userAChannel.id, {
      id: userAChannel.id,
      channelId: userAChannel.id,
      kind: 'device',
      userId: userA,
      state: 'up',
      endCause: null
    });
    const bridge = await ari.bridges.create({ type: 'mixing' });
    await ari.bridges.addChannel(bridge.id, customerChannel.id);
    await ari.bridges.addChannel(bridge.id, userAChannel.id);
    activeCall.bridgeId = bridge.id;
    pipeline.registerCall(activeCall);
    await cdr.open(activeCall);

    const addPartyChannel = fakeAri.addChannel({});
    const addPartyCall = newInternalCall(addPartyChannel.id, 'e100', '*5300');
    addPartyCall.callerUserId = userA;
    pipeline.registerCall(addPartyCall);

    // addParty waits for the originated leg to answer before bridging it (§10.2), so the
    // default 60 s `answerAfterMs` (set for tests that must never auto-answer) would time this
    // race out; this test wants userC's device to answer promptly instead.
    fakeAri.answerAfterMs = 10;
    // Reads the endpoint list and the config snapshot, so it runs once every row exists.
    await presence.resyncOnBoot();
    await handleFeature(pipeline, presence, addPartyCall, 'addParty', '300');
    await addedPartyLeaves(rig, addPartyCall);

    const row = await db
      .selectFrom('calls')
      .select(['parentCallId', 'toUri'])
      .where('id', '=', addPartyCall.id)
      .executeTakeFirstOrThrow();
    expect(row.parentCallId).toBe(activeCall.id);
    // §11.2 `calls.to_uri`: the pipeline's view of the target, the extension, not `*5300`.
    expect(row.toUri).toBe('300');
    // Not just *an* addChannel call on the right bridge (both original parties already produced
    // one during setup above): the *new* party's own channel, once it actually answered.
    const joinedNewParty = fakeAri.calls.some(entry => {
      if (
        entry.method !== 'POST' ||
        entry.path !== `bridges/${bridge.id}/addChannel`
      ) {
        return false;
      }
      const channel = (entry.body as { channel?: string }).channel;
      return (
        channel !== undefined &&
        channel !== customerChannel.id &&
        channel !== userAChannel.id
      );
    });
    expect(joinedNewParty).toBe(true);
  });

  it('*5 to a colleague applies their OOO rule instead of ringing their phones (§10.1 step 2)', async () => {
    await setUp();
    const userA = await seedUser(db);
    const userC = await seedUser(db);
    const userD = await seedUser(db);
    fakeAri.registerEndpoint('e300-dabc');
    await seedDevice(db, userC, 'e300-dabc');
    await seedExtension(db, '300', { userId: userC });
    const targetId = newId();
    await db
      .insertInto('forwardTargets')
      .values({ id: targetId, userId: userD })
      .execute();
    await db
      .insertInto('oooRules')
      .values({
        id: newId(),
        scopeUserId: userC,
        targetId,
        createdAt: nowIso()
      })
      .execute();

    const customerChannel = fakeAri.addChannel({});
    const userAChannel = fakeAri.addChannel({});
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
    activeCall.legs.set(userAChannel.id, {
      id: userAChannel.id,
      channelId: userAChannel.id,
      kind: 'device',
      userId: userA,
      state: 'up',
      endCause: null
    });
    const bridge = await ari.bridges.create({ type: 'mixing' });
    await ari.bridges.addChannel(bridge.id, customerChannel.id);
    await ari.bridges.addChannel(bridge.id, userAChannel.id);
    activeCall.bridgeId = bridge.id;
    pipeline.registerCall(activeCall);
    await cdr.open(activeCall);

    const addPartyChannel = fakeAri.addChannel({});
    const addPartyCall = newInternalCall(addPartyChannel.id, 'e100', '*5300');
    addPartyCall.callerUserId = userA;
    pipeline.registerCall(addPartyCall);
    await presence.resyncOnBoot();
    await handleFeature(pipeline, presence, addPartyCall, 'addParty', '300');

    expect(traceEvents(addPartyCall)).toContain('ooo');
    const rangColleague = fakeAri.calls.some(
      entry =>
        isPlacement(entry) &&
        ((entry.body as { endpoint?: string }).endpoint ?? '').includes(
          'e300-dabc'
        )
    );
    expect(rangColleague).toBe(false);
  });

  it('*5 to an external number dials it through the normal outbound resolution', async () => {
    await setUp();
    await seedExternalRoute(db);
    pipeline.deps.trunkState = rig.trunkState();

    const userA = await seedUser(db);
    const customerChannel = fakeAri.addChannel({
      caller: { number: '+15559999', name: '' }
    });
    const userAChannel = fakeAri.addChannel({});
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
    activeCall.legs.set(userAChannel.id, {
      id: userAChannel.id,
      channelId: userAChannel.id,
      kind: 'device',
      userId: userA,
      state: 'up',
      endCause: null
    });
    const bridge = await ari.bridges.create({ type: 'mixing' });
    await ari.bridges.addChannel(bridge.id, customerChannel.id);
    await ari.bridges.addChannel(bridge.id, userAChannel.id);
    activeCall.bridgeId = bridge.id;
    pipeline.registerCall(activeCall);
    await cdr.open(activeCall);

    const addPartyChannel = fakeAri.addChannel({});
    const addPartyCall = newInternalCall(
      addPartyChannel.id,
      'e100',
      '*5+15551234567'
    );
    addPartyCall.callerUserId = userA;
    pipeline.registerCall(addPartyCall);

    fakeAri.answerAfterMs = 10;
    await handleFeature(
      pipeline,
      presence,
      addPartyCall,
      'addParty',
      '+15551234567'
    );

    // The external leg went out `PJSIP/<number>@trunk-<id>` — the trunk, not any local extension.
    const dialedTrunk = fakeAri.calls.some(entry => {
      if (!isPlacement(entry)) {
        return false;
      }
      const endpoint = (entry.body as { endpoint?: string }).endpoint;
      return endpoint?.includes('@trunk-') === true;
    });
    expect(dialedTrunk).toBe(true);
    const joinedExternalParty = fakeAri.calls.some(entry => {
      if (
        entry.method !== 'POST' ||
        entry.path !== `bridges/${bridge.id}/addChannel`
      ) {
        return false;
      }
      const channel = (entry.body as { channel?: string }).channel;
      return (
        channel !== undefined &&
        channel !== customerChannel.id &&
        channel !== userAChannel.id
      );
    });
    expect(joinedExternalParty).toBe(true);
  });

  /** 100 (userA) and a customer bridged, plus userA's `*5<number>` feature dial, not yet run. */
  async function externalAddParty(): Promise<{
    activeCall: Call;
    addPartyCall: Call;
    bridgeId: string;
    userA: string;
  }> {
    await seedExternalRoute(db);
    pipeline.deps.trunkState = rig.trunkState();
    const userA = await seedUser(db);
    const customerChannel = fakeAri.addChannel({
      caller: { number: '+15559999', name: '' }
    });
    const userAChannel = fakeAri.addChannel({});
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
    activeCall.status = 'answered';
    activeCall.legs.set(userAChannel.id, {
      id: userAChannel.id,
      channelId: userAChannel.id,
      kind: 'device',
      userId: userA,
      state: 'up',
      endCause: null
    });
    const bridge = await ari.bridges.create({ type: 'mixing' });
    await ari.bridges.addChannel(bridge.id, customerChannel.id);
    await ari.bridges.addChannel(bridge.id, userAChannel.id);
    activeCall.bridgeId = bridge.id;
    pipeline.registerCall(activeCall);
    pipeline.callByChannel.set(userAChannel.id, activeCall);
    await cdr.open(activeCall);
    const addPartyCall = newInternalCall(
      fakeAri.addChannel({}).id,
      'e100',
      '*5+15551234567'
    );
    addPartyCall.callerUserId = userA;
    addPartyCall.parentCallId = activeCall.id;
    pipeline.registerCall(addPartyCall);
    fakeAri.answerAfterMs = 10;
    await cdr.open(addPartyCall);
    return { activeCall, addPartyCall, bridgeId: bridge.id, userA };
  }

  it('*5 to an external number joins through the answer path: shown up, traced once, the added leg offered to the recorder alone', async () => {
    await setUp();
    const { addPartyCall, bridgeId, userA } = await externalAddParty();
    await db
      .updateTable('users')
      .set({ recordCalls: 1 })
      .where('id', '=', userA)
      .execute();
    const callers: Call[] = [];
    const legs: Leg[] = [];
    pipeline.deps.recorder = {
      ...noopRecorder,
      onCallerUp: call => {
        callers.push(call);
        return Promise.resolve();
      },
      onLegUp: (_call, leg) => {
        legs.push(leg);
        return Promise.resolve();
      },
      onTransfereeUp: () => Promise.resolve(),
      onCallerEnded: () => Promise.resolve(),
      onLegEnded: () => Promise.resolve()
    };
    const states: string[] = [];
    onEvents(pipeline.deps.bus, envelope => {
      if (
        envelope.type === 'call.state' &&
        envelope.callId === addPartyCall.id
      ) {
        states.push(envelope.state);
      }
    });

    await handleFeature(
      pipeline,
      presence,
      addPartyCall,
      'addParty',
      '+15551234567'
    );

    // §10.6: the added leg's own row is live and up once the party joins.
    expect(states).toContain('up');
    const addedId = legs[0]?.channelId ?? '';
    // §10.2 "Three-way calls": the added party's participation is evaluated on its own flags;
    // the initiator's feature dial is never in the bridge, so nothing records it.
    expect(callers).toEqual([]);
    expect(legs.map(leg => [leg.kind, leg.userId])).toEqual([['trunk', null]]);
    expect(
      fakeAri.calls.some(
        entry =>
          entry.method === 'POST' &&
          entry.path === `bridges/${bridgeId}/addChannel` &&
          (entry.body as { channel?: string }).channel === addedId
      )
    ).toBe(true);
    expect(addPartyCall.bridgeId).toBe(bridgeId);
    expect(pipeline.callByChannel.get(addedId)).toBe(addPartyCall);
    const answered = (addPartyCall.log.finish().log ?? '')
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line) as { event?: string })
      .filter(line => line.event === 'answered');
    expect(answered).toHaveLength(1);
  });

  it("*5 to an external number: the added leg's row ends when the added party leaves, not when they join", async () => {
    await setUp();
    const { addPartyCall } = await externalAddParty();
    await handleFeature(
      pipeline,
      presence,
      addPartyCall,
      'addParty',
      '+15551234567'
    );
    await flush();
    // §11.2 `calls.ended_at`: the added party is still in the three-way bridge.
    expect((await callsRow(db, addPartyCall.id)).endedAt).toBeNull();
    expect(pipeline.deps.state.calls.get(addPartyCall.id)?.state).toBe('up');

    const added = [...addPartyCall.legs.values()].find(
      leg => leg.state === 'up'
    );
    channelDestroyed(fakeAri, added?.channelId ?? '');

    await eventually(async () => {
      const row = await callsRow(db, addPartyCall.id);
      expect(row.status).toBe('answered');
      expect(row.answeredAt).not.toBeNull();
      expect(row.endedAt).not.toBeNull();
    });
  });

  /** The trunk originate an external `*5` sent, and the added leg's `calls` row once the added
   * party has left again. */
  async function externalAddPartyOutcome(addPartyCall: Call): Promise<{
    originate: { endpoint?: string; variables?: Record<string, string> };
    row: { toUri: string; direction: string };
  }> {
    const originate = fakeAri.calls.find(
      entry =>
        isPlacement(entry) &&
        ((entry.body as { endpoint?: string }).endpoint ?? '').includes(
          '@trunk-'
        )
    );
    await addedPartyLeaves(rig, addPartyCall);
    const row = await db
      .selectFrom('calls')
      .select(['toUri', 'direction'])
      .where('id', '=', addPartyCall.id)
      .executeTakeFirstOrThrow();
    return {
      originate: originate?.body ?? {},
      row
    };
  }

  it('*5 to a national number dials and records its E.164 form, as an outbound call (§10.1 Outbound step 4)', async () => {
    await setUp();
    const { addPartyCall } = await externalAddParty();
    await handleFeature(
      pipeline,
      presence,
      addPartyCall,
      'addParty',
      '030123456'
    );
    const { originate, row } = await externalAddPartyOutcome(addPartyCall);
    expect(originate.endpoint).toMatch(/^PJSIP\/\+4930123456@trunk-/u);
    expect(row).toEqual({ toUri: '+4930123456', direction: 'outbound' });
  });

  it('*5 honours a CLIR prefix dialled with the added number (§9.3 #31#)', async () => {
    await setUp();
    const { addPartyCall } = await externalAddParty();
    // A withheld call needs a PAI-carrying trunk (§9.4 "Anonymous calls").
    await db.updateTable('trunks').set({ callerIdHeader: 'both' }).execute();
    await handleFeature(
      pipeline,
      presence,
      addPartyCall,
      'addParty',
      '#31#+15551234567'
    );
    const { originate, row } = await externalAddPartyOutcome(addPartyCall);
    expect(originate.variables?.['CONNECTEDLINE(pres)']).toBe('prohib');
    expect(row.toUri).toBe('+15551234567');
  });

  it("*5 to one of the tenant's own DIDs rings its target internally, never over a trunk", async () => {
    await setUp();
    const { addPartyCall, bridgeId } = await externalAddParty();
    const userC = await seedUser(db);
    await seedExtension(db, '300', { userId: userC });
    await seedDevice(db, userC, 'e300-dabc');
    await registerWithPresence(rig, 'e300-dabc');
    const targetId = newId();
    await db
      .insertInto('forwardTargets')
      .values({ id: targetId, userId: userC })
      .execute();
    await db
      .insertInto('dids')
      .values({
        id: newId(),
        number: '+15557777',
        targetId,
        createdAt: nowIso()
      })
      .execute();
    pipeline.deps.cache.invalidate();

    await handleFeature(
      pipeline,
      presence,
      addPartyCall,
      'addParty',
      '+15557777'
    );

    expect(addPartyCall.bridgeId).toBe(bridgeId);
    const endpoints = fakeAri.calls
      .filter(entry => isPlacement(entry))
      .map(entry => (entry.body as { endpoint?: string }).endpoint);
    expect(endpoints).toEqual([contactEndpoint('e300-dabc')]);
    await addedPartyLeaves(rig, addPartyCall);
    const row = await db
      .selectFrom('calls')
      .select(['toUri', 'calleeUserId'])
      .where('id', '=', addPartyCall.id)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ toUri: '+15557777', calleeUserId: userC });
  });

  it('*5 to a parking slot is refused: a parked call is retrieved, not added', async () => {
    await setUp();
    const { addPartyCall } = await externalAddParty();
    await seedExtension(db, '701', { isParkingSlot: 1 });
    pipeline.deps.cache.invalidate();
    await handleFeature(pipeline, presence, addPartyCall, 'addParty', '701');
    expect(
      fakeAri.calls.some(
        entry =>
          entry.method === 'DELETE' &&
          entry.path === `channels/${addPartyCall.callerChannelId}` &&
          entry.qs === `reason_code=${sipToHangupCause(404)}`
      )
    ).toBe(true);
    expect(addPartyCall.status).toBe('failed');
  });

  it("*5 to a ring-group extension rings its member and joins the winner into the caller's own bridge", async () => {
    await setUp();
    const userA = await seedUser(db);
    const groupId = await seedRingGroup(db);
    await seedExtension(db, '400', { ringGroupId: groupId });
    const memberUserId = await seedUser(db);
    await seedExtension(db, '300', { userId: memberUserId });
    const memberDeviceUsername = 'e300-dabc';
    await seedDevice(db, memberUserId, memberDeviceUsername);
    await seedMember(db, groupId, 0, memberUserId);
    // A group rings only a member's registered devices (§10.1 step 5).
    await registerWithPresence(rig, memberDeviceUsername);

    const customerChannel = fakeAri.addChannel({
      caller: { number: '+15559999', name: '' }
    });
    const userAChannel = fakeAri.addChannel({});
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
    activeCall.legs.set(userAChannel.id, {
      id: userAChannel.id,
      channelId: userAChannel.id,
      kind: 'device',
      userId: userA,
      state: 'up',
      endCause: null
    });
    const bridge = await ari.bridges.create({ type: 'mixing' });
    await ari.bridges.addChannel(bridge.id, customerChannel.id);
    await ari.bridges.addChannel(bridge.id, userAChannel.id);
    activeCall.bridgeId = bridge.id;
    pipeline.registerCall(activeCall);
    await cdr.open(activeCall);

    const addPartyChannel = fakeAri.addChannel({});
    const addPartyCall = newInternalCall(addPartyChannel.id, 'e100', '*5400');
    addPartyCall.callerUserId = userA;
    pipeline.registerCall(addPartyCall);

    fakeAri.answerAfterMs = 10;
    await handleFeature(pipeline, presence, addPartyCall, 'addParty', '400');
    await addedPartyLeaves(rig, addPartyCall);

    const row = await db
      .selectFrom('calls')
      .select('parentCallId')
      .where('id', '=', addPartyCall.id)
      .executeTakeFirstOrThrow();
    expect(row.parentCallId).toBe(activeCall.id);
    const joinedNewParty = fakeAri.calls.some(entry => {
      if (
        entry.method !== 'POST' ||
        entry.path !== `bridges/${bridge.id}/addChannel`
      ) {
        return false;
      }
      const channel = (entry.body as { channel?: string }).channel;
      return (
        channel !== undefined &&
        channel !== customerChannel.id &&
        channel !== userAChannel.id
      );
    });
    expect(joinedNewParty).toBe(true);
    const addPartyChannelHungUp = fakeAri.calls.some(
      entry =>
        entry.method === 'DELETE' &&
        entry.path === `channels/${addPartyChannel.id}`
    );
    expect(addPartyChannelHungUp).toBe(true);
  });

  /** 100 (userA) and a customer in a bridged call, then userA's `*5400` joins group 400's member. */
  async function threeWayCall(): Promise<{
    bridgeId: string;
    customerId: string;
    initiatorId: string;
    addedId: string;
  }> {
    const userA = await seedUser(db);
    const groupId = await seedRingGroup(db);
    await seedExtension(db, '400', { ringGroupId: groupId });
    const memberUserId = await seedUser(db);
    await seedExtension(db, '300', { userId: memberUserId });
    await seedDevice(db, memberUserId, 'e300-dabc');
    await seedMember(db, groupId, 0, memberUserId);
    await presence.resyncOnBoot();
    await registerWithPresence(rig, 'e300-dabc');
    const customerChannel = fakeAri.addChannel({
      caller: { number: '+15559999', name: '' }
    });
    const userAChannel = fakeAri.addChannel({});
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
    activeCall.status = 'answered';
    activeCall.legs.set(userAChannel.id, {
      id: userAChannel.id,
      channelId: userAChannel.id,
      kind: 'device',
      userId: userA,
      state: 'up',
      endCause: null
    });
    const bridge = await ari.bridges.create({ type: 'mixing' });
    await ari.bridges.addChannel(bridge.id, customerChannel.id);
    await ari.bridges.addChannel(bridge.id, userAChannel.id);
    activeCall.bridgeId = bridge.id;
    pipeline.registerCall(activeCall);
    pipeline.callByChannel.set(userAChannel.id, activeCall);
    await cdr.open(activeCall);
    const addPartyChannel = fakeAri.addChannel({});
    const addPartyCall = newInternalCall(addPartyChannel.id, 'e100', '*5400');
    addPartyCall.callerUserId = userA;
    pipeline.registerCall(addPartyCall);
    fakeAri.answerAfterMs = 10;
    await handleFeature(pipeline, presence, addPartyCall, 'addParty', '400');
    const added = fakeAri.calls.find(
      entry =>
        entry.method === 'POST' &&
        entry.path === `bridges/${bridge.id}/addChannel` &&
        ![customerChannel.id, userAChannel.id].includes(
          (entry.body as { channel?: string }).channel ?? ''
        )
    );
    return {
      bridgeId: bridge.id,
      customerId: customerChannel.id,
      initiatorId: userAChannel.id,
      addedId: (added?.body as { channel?: string } | undefined)?.channel ?? ''
    };
  }

  it('*5: the initiator hanging up ends the bridge for everyone (§10.2 "Three-way calls")', async () => {
    await setUp();
    const { bridgeId, customerId, initiatorId, addedId } = await threeWayCall();
    expect(addedId).not.toBe('');

    fakeAri.emit({
      type: 'ChannelDestroyed',
      timestamp: nowIso(),
      application: 'zamfono',
      channel: defaultChannel({ id: initiatorId }),
      cause: 16
    });

    await eventually(() => {
      expect(rig.hungUp(customerId)).toBe(true);
      expect(rig.hungUp(addedId)).toBe(true);
      expect(
        fakeAri.calls.some(
          entry =>
            entry.method === 'DELETE' && entry.path === `bridges/${bridgeId}`
        )
      ).toBe(true);
    });
  });

  it('*5: the added party hanging up leaves the original two-party call intact', async () => {
    await setUp();
    const { customerId, initiatorId, addedId } = await threeWayCall();
    // Asterisk takes the added party's channel out of the bridge as it goes.
    await ari.bridges.removeChannel(
      (await ari.bridges.list())[0]?.id ?? '',
      addedId
    );

    const arrived = delivered(ari, 'ChannelDestroyed', addedId);
    fakeAri.emit({
      type: 'ChannelDestroyed',
      timestamp: nowIso(),
      application: 'zamfono',
      channel: defaultChannel({ id: addedId }),
      cause: 16
    });
    await arrived;
    await pipeline.idle();

    expect(rig.hungUp(customerId)).toBe(false);
    expect(rig.hungUp(initiatorId)).toBe(false);
  });

  it("*5's own channel ending leaves the added party INUSE until their leg ends", async () => {
    await setUp();
    const userA = await seedUser(db);
    const userC = await seedUser(db);
    await seedDevice(db, userC, 'e300-dabc');
    await seedExtension(db, '300', { userId: userC });
    await presence.resyncOnBoot();
    await registerWithPresence(rig, 'e300-dabc');

    const customerChannel = fakeAri.addChannel({
      caller: { number: '+15559999', name: '' }
    });
    const userAChannel = fakeAri.addChannel({});
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
    activeCall.legs.set(userAChannel.id, {
      id: userAChannel.id,
      channelId: userAChannel.id,
      kind: 'device',
      userId: userA,
      state: 'up',
      endCause: null
    });
    const bridge = await ari.bridges.create({ type: 'mixing' });
    await ari.bridges.addChannel(bridge.id, customerChannel.id);
    await ari.bridges.addChannel(bridge.id, userAChannel.id);
    activeCall.bridgeId = bridge.id;
    pipeline.registerCall(activeCall);
    await cdr.open(activeCall);

    const addPartyChannel = fakeAri.addChannel({});
    const addPartyCall = newInternalCall(addPartyChannel.id, 'e100', '*5300');
    addPartyCall.callerUserId = userA;
    pipeline.registerCall(addPartyCall);
    fakeAri.answerAfterMs = 10;
    await cdr.open(addPartyCall);
    await handleFeature(pipeline, presence, addPartyCall, 'addParty', '300');
    await eventually(() => {
      expect(hintPutsFor(fakeAri, '300').at(-1)).toEqual({
        deviceState: 'INUSE'
      });
    });

    // Asterisk answers the feature channel's own hangup with `ChannelDestroyed`; the added
    // party is still bridged (§10.2 "Three-way calls"), so their hint stays.
    const arrived = delivered(ari, 'ChannelDestroyed', addPartyChannel.id);
    channelDestroyed(fakeAri, addPartyChannel.id);
    await arrived;
    await pipeline.idle();
    expect(hintPutsFor(fakeAri, '300').at(-1)).toEqual({
      deviceState: 'INUSE'
    });
    // §11.2 `calls.ended_at`: the added leg's own row ends as the added party leaves, not here.
    expect((await callsRow(db, addPartyCall.id)).endedAt).toBeNull();

    const addedLeg = [...addPartyCall.legs.values()].find(
      leg => leg.state === 'up'
    );
    if (addedLeg === undefined) {
      throw new Error('no added leg is up');
    }
    channelDestroyed(fakeAri, addedLeg.channelId);
    await eventually(async () => {
      expect(hintPutsFor(fakeAri, '300').at(-1)).toEqual({
        deviceState: 'NOT_INUSE'
      });
      const row = await callsRow(db, addPartyCall.id);
      expect(row.status).toBe('answered');
      expect(row.endedAt).not.toBeNull();
    });
  });
});
