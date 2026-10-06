import { afterEach, describe, expect, it } from 'vitest';

import { newId, nowIso, type Db } from '@zamfono/shared';
import { seedUser } from '@zamfono/shared/testDb.js';

import type { AriClient } from '../ari/client.js';
import type { CdrWriter } from '../cdr.js';
import type { Presence } from '../presence.js';
import type { FakeAri } from '../testing/ari/fake.js';
import { defaultChannel } from '../testing/ari/fakeChannel.js';
import { eventually, requestTo } from '../testing/eventually.js';
import {
  channelDestroyed,
  hintPutsFor,
  newInternalCall,
  registerWithPresence,
  seedMember,
  startFeatureRig
} from '../testing/featureRig.js';
import type { Rig } from '../testing/pipelineRig.js';
import {
  seedDevice,
  seedExtension,
  seedRingGroup
} from '../testing/seedRows.js';
import { newCall } from './call.js';
import { handleFeature } from './features.js';
import { handleOutbound } from './outbound.js';
import type { Pipeline } from './pipeline.js';
import { ringUser } from './ringUser.js';

describe('do not disturb and call presence', () => {
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

  it('*90 sets dnd and hint BUSY', async () => {
    await setUp();
    const userId = await seedUser(db);
    await seedExtension(db, '201', { userId });
    const channel = fakeAri.addChannel({});
    const call = newInternalCall(channel.id, 'e201', '*90');
    call.callerUserId = userId;
    pipeline.registerCall(call);
    await cdr.open(call);

    await handleFeature(pipeline, presence, call, 'dndOn', '');

    const row = await db
      .selectFrom('users')
      .select('dnd')
      .where('id', '=', userId)
      .executeTakeFirstOrThrow();
    expect(row.dnd).toBe(1);
    const hint = fakeAri.calls
      .filter(
        entry =>
          entry.method === 'PUT' &&
          entry.path === 'deviceStates/Stasis:presence-201'
      )
      .at(-1);
    expect(hint?.body).toEqual({ deviceState: 'BUSY' });
  });

  it("*90 at level qos writes the feature call's call_qos row from its channel's hangup (§7)", async () => {
    await setUp();
    const userId = await seedUser(db);
    await seedExtension(db, '201', { userId });
    const channel = fakeAri.addChannel({});
    fakeAri.rtpQos.set(channel.id, { txjitter: 0.004, rxjitter: 0 });
    const call = newCall({
      id: newId(),
      direction: 'internal',
      callerChannelId: channel.id,
      from: 'e201',
      to: '*90',
      startedAt: nowIso(),
      logLevel: 'qos',
      callLogMaxBytes: 1_048_576
    });
    call.callerUserId = userId;
    pipeline.registerCall(call);
    await cdr.open(call);

    await handleFeature(pipeline, presence, call, 'dndOn', '');
    fakeAri.emit({
      type: 'ChannelDestroyed',
      timestamp: nowIso(),
      application: 'zamfono',
      channel: { id: channel.id, name: '' },
      cause: 16
    });

    await eventually(async () => {
      const rows = await db
        .selectFrom('callQos')
        .select(['channelId', 'jitterMs'])
        .where('callId', '=', call.id)
        .execute();
      expect(rows).toEqual([{ channelId: channel.id, jitterMs: 4 }]);
    });
  });

  it('*90 dialled from a registered device sets dnd, hint BUSY and presence dnd', async () => {
    await setUp();
    const userId = await seedUser(db);
    await seedExtension(db, '201', { userId });
    await seedDevice(db, userId, 'e201-dabc');
    await presence.resyncOnBoot();
    await registerWithPresence(rig, 'e201-dabc');
    expect(hintPutsFor(fakeAri, '201').at(-1)).toEqual({
      deviceState: 'NOT_INUSE'
    });

    // The real dial path: `handleOutbound` resolves `*90` from the warm config snapshot.
    const channel = fakeAri.addChannel({
      name: 'PJSIP/e201-dabc-00000001',
      caller: { number: '201', name: '' }
    });
    await handleOutbound(pipeline, {
      type: 'StasisStart',
      timestamp: nowIso(),
      application: 'zamfono',
      args: ['outbound', '*90'],
      channel
    });

    const row = await db
      .selectFrom('users')
      .select('dnd')
      .where('id', '=', userId)
      .executeTakeFirstOrThrow();
    expect(row.dnd).toBe(1);
    expect(hintPutsFor(fakeAri, '201').at(-1)).toEqual({ deviceState: 'BUSY' });
    // §10.2 "Presence and BLF", §10.6: the status is `dnd`, appended to `presence_log`.
    const statuses = await db
      .selectFrom('presenceLog')
      .select('status')
      .where('userId', '=', userId)
      .orderBy('since', 'asc')
      .execute();
    expect(statuses.map(entry => entry.status)).toEqual([
      'offline',
      'available',
      'dnd'
    ]);
  });

  it("an answered call ending returns the callee's hint to NOT_INUSE and appends a presence_log row", async () => {
    await setUp();
    const userId = await seedUser(db);
    await seedExtension(db, '101', { userId });
    await seedDevice(db, userId, 'e101-dabc');

    await presence.resyncOnBoot();
    await registerWithPresence(rig, 'e101-dabc');

    const callerChannel = fakeAri.addChannel({
      caller: { number: '+15559999', name: '' }
    });
    const call = newCall({
      id: newId(),
      direction: 'inbound',
      callerChannelId: callerChannel.id,
      from: '+15559999',
      to: '101',
      startedAt: nowIso(),
      logLevel: 'events',
      callLogMaxBytes: 1_048_576
    });
    call.calleeUserId = userId;
    pipeline.registerCall(call);
    fakeAri.answerAfterMs = 10;
    await cdr.open(call);

    await ringUser(pipeline, call, userId);

    function hintPuts(): { deviceState?: string }[] {
      return fakeAri.calls
        .filter(
          entry =>
            entry.method === 'PUT' &&
            entry.path === 'deviceStates/Stasis:presence-101'
        )
        .map(entry => entry.body as { deviceState?: string });
    }

    // The answer's presence refresh runs off the ring's own stack.
    await eventually(() => {
      expect(hintPuts().at(-1)).toEqual({ deviceState: 'INUSE' });
    });

    fakeAri.emit({
      type: 'ChannelDestroyed',
      timestamp: nowIso(),
      application: 'zamfono',
      channel: defaultChannel({ id: callerChannel.id })
    });

    await eventually(async () => {
      expect(hintPuts().at(-1)).toEqual({ deviceState: 'NOT_INUSE' });
      const logRows = await db
        .selectFrom('presenceLog')
        .select('status')
        .where('userId', '=', userId)
        .orderBy('since', 'asc')
        .execute();
      expect(logRows.at(-1)?.status).toBe('available');
      // The boot registration flip already wrote its own rows; hanging up the answered call
      // appends at least one more, back to `available` (§10.2 "Presence and BLF").
      expect(logRows.length).toBeGreaterThanOrEqual(3);
    });
  });

  it('dialling a colleague marks the dialling user INUSE and the callee RINGING then INUSE, and ends both on hangup', async () => {
    await setUp();
    const callerUserId = await seedUser(db);
    await seedExtension(db, '100', { userId: callerUserId });
    await seedDevice(db, callerUserId, 'e100-dabc');
    const calleeUserId = await seedUser(db);
    await seedExtension(db, '101', { userId: calleeUserId });
    await seedDevice(db, calleeUserId, 'e101-dabc');
    await presence.resyncOnBoot();
    await registerWithPresence(rig, 'e100-dabc');
    await registerWithPresence(rig, 'e101-dabc');
    expect(hintPutsFor(fakeAri, '100').at(-1)).toEqual({
      deviceState: 'NOT_INUSE'
    });

    fakeAri.answerAfterMs = 300;
    const callerChannel = fakeAri.addChannel({
      name: 'PJSIP/e100-dabc-00000001',
      caller: { number: '100', name: '' }
    });
    const dialing = handleOutbound(pipeline, {
      type: 'StasisStart',
      timestamp: nowIso(),
      application: 'zamfono',
      args: ['outbound', '101'],
      channel: callerChannel
    });
    // §9.3: the dialling user's device is in a call from the dial; the callee's phone rings.
    await eventually(() => {
      expect(hintPutsFor(fakeAri, '100').at(-1)).toEqual({
        deviceState: 'INUSE'
      });
      expect(hintPutsFor(fakeAri, '101').at(-1)).toEqual({
        deviceState: 'RINGING'
      });
    });
    await dialing;
    await eventually(() => {
      expect(hintPutsFor(fakeAri, '101').at(-1)).toEqual({
        deviceState: 'INUSE'
      });
    });

    channelDestroyed(fakeAri, callerChannel.id);
    await eventually(async () => {
      expect(hintPutsFor(fakeAri, '100').at(-1)).toEqual({
        deviceState: 'NOT_INUSE'
      });
      expect(hintPutsFor(fakeAri, '101').at(-1)).toEqual({
        deviceState: 'NOT_INUSE'
      });
      // §10.2 "Presence and BLF": the busy stretch is in `presence_log`, with the counterpart.
      const callerRows = await db
        .selectFrom('presenceLog')
        .select(['status', 'peer'])
        .where('userId', '=', callerUserId)
        .orderBy('since', 'asc')
        .execute();
      expect(callerRows.map(row => row.status)).toEqual([
        'offline',
        'available',
        'busy',
        'available'
      ]);
      expect(callerRows[2]?.peer).toBe('101');
      const calleeRows = await db
        .selectFrom('presenceLog')
        .select(['status', 'peer'])
        .where('userId', '=', calleeUserId)
        .orderBy('since', 'asc')
        .execute();
      expect(calleeRows.map(row => row.status)).toEqual([
        'offline',
        'available',
        'busy',
        'available'
      ]);
      expect(calleeRows[2]?.peer).toBe('100');
    });
  });

  it.each([
    ['ring-group', '400'],
    ['user', '300']
  ] as const)(
    '*5 to a %s extension whose answer finds the running bridge gone hangs the added leg up',
    async (_kind, target) => {
      await setUp();
      const userA = await seedUser(db);
      const groupId = await seedRingGroup(db);
      await seedExtension(db, '400', { ringGroupId: groupId });
      const memberUserId = await seedUser(db);
      await seedExtension(db, '300', { userId: memberUserId });
      await seedDevice(db, memberUserId, 'e300-dabc');
      await seedMember(db, groupId, 0, memberUserId);
      await presence.resyncOnBoot();
      await registerWithPresence(rig, 'e300-dabc');
      const customerChannel = fakeAri.addChannel({});
      const userAChannel = fakeAri.addChannel({});
      const activeCall = newInternalCall(
        customerChannel.id,
        '+15559999',
        '100'
      );
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
      activeCall.bridgeId = bridge.id;
      pipeline.registerCall(activeCall);
      pipeline.callByChannel.set(userAChannel.id, activeCall);
      await cdr.open(activeCall);
      const addPartyChannel = fakeAri.addChannel({});
      const addPartyCall = newInternalCall(
        addPartyChannel.id,
        'e100',
        `*5${target}`
      );
      addPartyCall.callerUserId = userA;
      pipeline.registerCall(addPartyCall);
      fakeAri.answerAfterMs = 100;
      await cdr.open(addPartyCall);

      const adding = handleFeature(
        pipeline,
        presence,
        addPartyCall,
        'addParty',
        target
      );
      // The running call ends while the added party's device still rings: originated, and
      // answering only `answerAfterMs` later.
      await requestTo(fakeAri, 'POST', 'channels/create');
      await ari.bridges.destroy(bridge.id);
      await adding;

      const added = [...addPartyCall.legs.values()].find(
        leg => leg.userId === memberUserId && leg.state === 'up'
      );
      if (added === undefined) {
        throw new Error('the added party never answered');
      }
      // Hung up, not left in Stasis with nobody (§10.2 "Three-way calls": the initiator's call
      // is over, and with it the bridge the added party was to join).
      expect(rig.hungUp(added.channelId)).toBe(true);
      expect(rig.hungUp(addPartyChannel.id)).toBe(true);
      expect(addPartyCall.bridgeId).toBeNull();
      expect(activeCall.threeWayInitiatorChannelId).toBeUndefined();
      expect(addPartyCall.log.finish().log).toContain('"event":"joinFailed"');
    }
  );
});
