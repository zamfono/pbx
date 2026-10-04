import { afterEach, describe, expect, it, vi } from 'vitest';

import { newId, nowIso, type Db } from '@zamfono/shared';
import { seedUser } from '@zamfono/shared/testDb.js';

import type { CdrWriter } from '../cdr.js';
import type { Presence } from '../presence.js';
import type { SipMessage } from '../sipCapture.js';
import type { FakeAri } from '../testing/ari/fake.js';
import { defaultChannel } from '../testing/ari/fakeChannel.js';
import { isPlacement } from '../testing/ari/fakeDial.js';
import { eventually } from '../testing/eventually.js';
import {
  memberRinging,
  newInternalCall,
  registerWithPresence,
  seedMember,
  startFeatureRig
} from '../testing/featureRig.js';
import { noopRecorder } from '../testing/pipelineDeps.js';
import type { Rig } from '../testing/pipelineRig.js';
import {
  seedDevice,
  seedExtension,
  seedRingGroup
} from '../testing/seedRows.js';
import { newCall, type Call, type Leg } from './call.js';
import { handleFeature } from './features.js';
import type { Pipeline } from './pipeline.js';
import type { ParticipationRecorder } from './recordParticipation.js';
import { sipToHangupCause } from './releaseCause.js';
import { ringGroup } from './ringGroup.js';

describe('pickup', () => {
  let rig: Rig;
  let db: Db;
  let fakeAri: FakeAri;
  let pipeline: Pipeline;
  let cdr: CdrWriter;
  let presence: Presence;

  async function setUp(): Promise<void> {
    rig = await startFeatureRig();
    ({ db, fakeAri, pipeline, cdr, presence } = rig);
  }

  afterEach(async () => {
    await rig.stop();
  });

  it('*8101 while 101 rings answers the picker and records them as answerer', async () => {
    await setUp();
    const targetUserId = await seedUser(db);
    await seedExtension(db, '101', { userId: targetUserId });
    const targetChannel = fakeAri.addChannel({
      caller: { number: '+15559999', name: '' }
    });
    const target = newCall({
      id: newId(),
      direction: 'inbound',
      callerChannelId: targetChannel.id,
      from: '+15559999',
      to: '101',
      startedAt: nowIso(),
      logLevel: 'events',
      callLogMaxBytes: 1_048_576
    });
    target.calleeUserId = targetUserId;
    pipeline.registerCall(target);
    await cdr.open(target);
    const deviceChannel = fakeAri.addChannel({});
    target.legs.set(deviceChannel.id, {
      channelId: deviceChannel.id,
      kind: 'device',
      userId: targetUserId,
      state: 'ringing',
      endCause: null
    });
    pipeline.callByChannel.set(deviceChannel.id, target);
    const ringTimer = setTimeout(() => undefined, 60_000);
    pipeline.pendingRing.set(target.id, {
      resolve: () => undefined,
      timer: ringTimer,
      existingBridgeId: null,
      placing: 0
    });

    const pickerUserId = await seedUser(db);
    const pickerChannel = fakeAri.addChannel({});
    const pickerCall = newInternalCall(pickerChannel.id, 'e102', '*8101');
    pickerCall.callerUserId = pickerUserId;
    pipeline.registerCall(pickerCall);
    await cdr.open(pickerCall);

    await handleFeature(pipeline, presence, pickerCall, 'pickup', '101');

    expect(target.answeredByUserId).toBe(pickerUserId);
    expect(target.status).toBe('answered');
    const bridgeCreates = fakeAri.calls.filter(
      entry => entry.method === 'POST' && entry.path === 'bridges'
    );
    expect(bridgeCreates).toHaveLength(1);
    const deviceHangup = fakeAri.calls.some(
      entry =>
        entry.method === 'DELETE' &&
        entry.path === `channels/${deviceChannel.id}`
    );
    expect(deviceHangup).toBe(true);
    const pickerHangup = fakeAri.calls.some(
      entry =>
        entry.method === 'DELETE' &&
        entry.path === `channels/${pickerChannel.id}`
    );
    expect(pickerHangup).toBe(false);
  });

  /** An inbound call ringing `targetUserId`'s one device through the single-user ring race, as
   * `ringUser` leaves it, for `*8<ext>` to pick up. */
  async function ringingDirectCall(targetUserId: string): Promise<Call> {
    const targetChannel = fakeAri.addChannel({
      caller: { number: '+15559999', name: '' }
    });
    const target = newCall({
      id: newId(),
      direction: 'inbound',
      callerChannelId: targetChannel.id,
      from: '+15559999',
      to: '101',
      startedAt: nowIso(),
      logLevel: 'events',
      callLogMaxBytes: 1_048_576
    });
    target.calleeUserId = targetUserId;
    pipeline.registerCall(target);
    await cdr.open(target);
    const deviceChannel = fakeAri.addChannel({});
    target.legs.set(deviceChannel.id, {
      channelId: deviceChannel.id,
      kind: 'device',
      userId: targetUserId,
      state: 'ringing',
      endCause: null
    });
    pipeline.callByChannel.set(deviceChannel.id, target);
    const ringTimer = setTimeout(() => undefined, 60_000);
    pipeline.pendingRing.set(target.id, {
      resolve: () => undefined,
      timer: ringTimer,
      existingBridgeId: null,
      placing: 0
    });
    return target;
  }

  async function pickerCallFor(ext: string): Promise<Call> {
    const pickerUserId = await seedUser(db);
    const pickerChannel = fakeAri.addChannel({});
    const pickerCall = newInternalCall(pickerChannel.id, 'e102', `*8${ext}`);
    pickerCall.callerUserId = pickerUserId;
    pipeline.registerCall(pickerCall);
    await cdr.open(pickerCall);
    return pickerCall;
  }

  // §7 level `sip`: the picker's dialog is the picked-up call's answered leg from here on, not the
  // `*8` dial's, which closes at once.
  it("*8101: joins the picker's dialog to the picked-up call's SIP capture", async () => {
    await setUp();
    const targetUserId = await seedUser(db);
    await seedExtension(db, '101', { userId: targetUserId });
    const target = await ringingDirectCall(targetUserId);
    const pickerCall = await pickerCallFor('101');
    fakeAri.channelVariables.set(
      `${pickerCall.callerChannelId}:CHANNEL(pjsip,call-id)`,
      'picker-dialog@10.0.0.2'
    );

    const logged = vi.spyOn(target.log, 'sip');
    const message = (payload: string): SipMessage => ({
      callId: 'picker-dialog@10.0.0.2',
      at: '2026-01-01T00:00:01.000Z',
      direction: 'in',
      payload
    });

    await handleFeature(pipeline, presence, pickerCall, 'pickup', '101');
    cdr.dialogs.sipMessage(message('BYE sip:e102@pbx SIP/2.0'));

    // The join reads the picker channel's Call-ID off ARI first.
    await eventually(() => {
      expect(logged).toHaveBeenCalledWith(
        expect.objectContaining({ raw: 'BYE sip:e102@pbx SIP/2.0' })
      );
    });
    target.status = 'answered';
    await cdr.finish(target);
    logged.mockClear();
    cdr.dialogs.sipMessage(message('SIP/2.0 200 OK'));
    expect(logged).not.toHaveBeenCalled();
  });

  it("*8101: the pickup is recorded, shown up and traced as the call's one answer, like every answer", async () => {
    await setUp();
    const targetUserId = await seedUser(db);
    await seedExtension(db, '101', { userId: targetUserId });
    const target = await ringingDirectCall(targetUserId);
    const pickerCall = await pickerCallFor('101');
    const callers: Call[] = [];
    const legs: Leg[] = [];
    const recorder: ParticipationRecorder = {
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
    pipeline.deps.recorder = recorder;

    await handleFeature(pipeline, presence, pickerCall, 'pickup', '101');

    // §10.2 "Recording semantics": the picker's participation is evaluated on its own flags.
    expect(callers).toEqual([target]);
    expect(legs.map(leg => [leg.channelId, leg.userId])).toEqual([
      [pickerCall.callerChannelId, pickerCall.callerUserId]
    ]);
    // §10.6 and `GET /internal/state`: the picked-up call is live and up.
    expect(pipeline.deps.state.calls.get(target.id)?.state).toBe('up');
    const answered = (target.log.finish().log ?? '')
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line) as { event?: string; userId?: string })
      .filter(line => line.event === 'answered');
    expect(answered).toHaveLength(1);
    expect(answered[0]?.userId).toBe(pickerCall.callerUserId);
  });

  it('*8101 loses to an answer already in flight: the call keeps its answerer and the picker is refused', async () => {
    await setUp();
    const targetUserId = await seedUser(db);
    await seedExtension(db, '101', { userId: targetUserId });
    const target = await ringingDirectCall(targetUserId);
    // The ring race's own device answer claimed the call and is still bridging (`winLeg`).
    target.answeredAt = nowIso();
    target.answeredByUserId = targetUserId;
    target.status = 'answered';
    const pickerCall = await pickerCallFor('101');

    await handleFeature(pipeline, presence, pickerCall, 'pickup', '101');

    expect(target.answeredByUserId).toBe(targetUserId);
    expect(pipeline.pendingRing.has(target.id)).toBe(true);
    const bridgeCreates = fakeAri.calls.filter(
      entry => entry.method === 'POST' && entry.path === 'bridges'
    );
    expect(bridgeCreates).toHaveLength(0);
    const refused = fakeAri.calls.some(
      entry =>
        entry.method === 'DELETE' &&
        entry.path === `channels/${pickerCall.callerChannelId}` &&
        entry.qs === `reason_code=${sipToHangupCause(404)}`
    );
    expect(refused).toBe(true);
  });

  it('*8101: the picker hanging up ends the picked-up call for its caller (§10.1 "Pickup")', async () => {
    await setUp();
    const targetUserId = await seedUser(db);
    await seedExtension(db, '101', { userId: targetUserId });
    const targetChannel = fakeAri.addChannel({
      caller: { number: '+15559999', name: '' }
    });
    const target = newCall({
      id: newId(),
      direction: 'inbound',
      callerChannelId: targetChannel.id,
      from: '+15559999',
      to: '101',
      startedAt: nowIso(),
      logLevel: 'events',
      callLogMaxBytes: 1_048_576
    });
    target.calleeUserId = targetUserId;
    pipeline.registerCall(target);
    await cdr.open(target);
    const deviceChannel = fakeAri.addChannel({});
    target.legs.set(deviceChannel.id, {
      channelId: deviceChannel.id,
      kind: 'device',
      userId: targetUserId,
      state: 'ringing',
      endCause: null
    });
    pipeline.callByChannel.set(deviceChannel.id, target);
    const ringTimer = setTimeout(() => undefined, 60_000);
    pipeline.pendingRing.set(target.id, {
      resolve: () => undefined,
      timer: ringTimer,
      existingBridgeId: null,
      placing: 0
    });
    const pickerUserId = await seedUser(db);
    const pickerChannel = fakeAri.addChannel({});
    const pickerCall = newInternalCall(pickerChannel.id, 'e102', '*8101');
    pickerCall.callerUserId = pickerUserId;
    pipeline.registerCall(pickerCall);
    await cdr.open(pickerCall);
    await handleFeature(pipeline, presence, pickerCall, 'pickup', '101');

    fakeAri.emit({
      type: 'ChannelDestroyed',
      timestamp: nowIso(),
      application: 'zamfono',
      channel: defaultChannel({ id: pickerChannel.id }),
      cause: 16
    });

    await eventually(() => {
      const callerHangup = fakeAri.calls.some(
        entry =>
          entry.method === 'DELETE' &&
          entry.path === `channels/${targetChannel.id}`
      );
      expect(callerHangup).toBe(true);
    });
  });

  it('*8 on a ring-group member picks up a call ringing that group', async () => {
    await setUp();
    const groupId = await seedRingGroup(db);
    await seedExtension(db, '400', { ringGroupId: groupId });
    const memberUserId = await seedUser(db);
    await seedExtension(db, '300', { userId: memberUserId });
    const memberDeviceUsername = 'e300-dabc';
    await seedDevice(db, memberUserId, memberDeviceUsername);
    await seedMember(db, groupId, 0, memberUserId);
    // A group rings only a member's registered devices (§10.1 step 5).
    await registerWithPresence(rig, memberDeviceUsername);

    const callerChannel = fakeAri.addChannel({
      caller: { number: '+15559999', name: '' }
    });
    const call = newInternalCall(callerChannel.id, 'e100', '400');
    pipeline.registerCall(call);
    await cdr.open(call);
    const ringing = ringGroup(pipeline, call, groupId);
    // The batch rings the member's device before the picker steps in.
    await memberRinging(call);
    expect(
      fakeAri.calls.some(
        entry =>
          isPlacement(entry) &&
          (entry.body as { endpoint?: string }).endpoint ===
            `PJSIP/${memberDeviceUsername}`
      )
    ).toBe(true);

    const pickerUserId = await seedUser(db);
    const pickerChannel = fakeAri.addChannel({});
    const pickerCall = newInternalCall(pickerChannel.id, 'e200', '*8300');
    pickerCall.callerUserId = pickerUserId;
    pipeline.registerCall(pickerCall);

    await handleFeature(pipeline, presence, pickerCall, 'pickup', '300');
    await ringing;

    expect(call.status).toBe('answered');
    expect(call.answeredByUserId).toBe(pickerUserId);
    // The group's own ring stopped: some channel other than the caller's or the picker's own was
    // hung up — the member's ringing device leg, not left ringing (§10.1 step 5's "the other
    // legs are hung up").
    expect(
      fakeAri.calls.some(
        entry =>
          entry.method === 'DELETE' &&
          entry.path.startsWith('channels/') &&
          entry.path !== `channels/${callerChannel.id}` &&
          entry.path !== `channels/${pickerChannel.id}`
      )
    ).toBe(true);
    // The picker's own channel joined the *same* bridge as the group's own caller (§10.1 "Pickup").
    const callerJoin = fakeAri.calls.find(
      entry =>
        entry.method === 'POST' &&
        entry.path.startsWith('bridges/') &&
        entry.path.endsWith('/addChannel') &&
        (entry.body as { channel?: string }).channel === callerChannel.id
    );
    if (callerJoin === undefined) {
      throw new Error('caller channel never joined a bridge');
    }
    expect(
      fakeAri.calls.some(
        entry =>
          entry.method === 'POST' &&
          entry.path === callerJoin.path &&
          (entry.body as { channel?: string }).channel === pickerChannel.id
      )
    ).toBe(true);
  });

  it("*8 on a ring-group member stops the group's hold music on the caller before bridging them", async () => {
    await setUp();
    const groupId = await seedRingGroup(db);
    await seedExtension(db, '400', { ringGroupId: groupId });
    const memberUserId = await seedUser(db);
    await seedExtension(db, '300', { userId: memberUserId });
    await seedDevice(db, memberUserId, 'e300-dabc');
    await seedMember(db, groupId, 0, memberUserId);
    await registerWithPresence(rig, 'e300-dabc');
    const callerChannel = fakeAri.addChannel({
      caller: { number: '+15559999', name: '' }
    });
    const call = newInternalCall(callerChannel.id, 'e100', '400');
    pipeline.registerCall(call);
    await cdr.open(call);
    const ringing = ringGroup(pipeline, call, groupId);
    await memberRinging(call);
    const pickerCall = newInternalCall(
      fakeAri.addChannel({}).id,
      'e200',
      '*8300'
    );
    pickerCall.callerUserId = await seedUser(db);
    pipeline.registerCall(pickerCall);

    await handleFeature(pipeline, presence, pickerCall, 'pickup', '300');
    await ringing;

    // §10.2 "Ring groups": the group's hold music replaces ringback only while members ring.
    const mohPath = `channels/${callerChannel.id}/moh`;
    const stopIndex = fakeAri.calls.findIndex(
      entry => entry.method === 'DELETE' && entry.path === mohPath
    );
    const bridgeIndex = fakeAri.calls.findIndex(
      entry =>
        entry.method === 'POST' &&
        entry.path.endsWith('/addChannel') &&
        (entry.body as { channel?: string }).channel === callerChannel.id
    );
    expect(stopIndex).toBeGreaterThanOrEqual(0);
    expect(stopIndex).toBeLessThan(bridgeIndex);
  });

  it('*8 on an extension nobody owns is refused without answering any live call', async () => {
    await setUp();
    const groupId = await seedRingGroup(db);
    await seedExtension(db, '400', { ringGroupId: groupId });
    const memberUserId = await seedUser(db);
    await seedExtension(db, '300', { userId: memberUserId });
    const memberDeviceUsername = 'e300-dabc';
    await seedDevice(db, memberUserId, memberDeviceUsername);
    await seedMember(db, groupId, 0, memberUserId);
    // A group rings only a member's registered devices (§10.1 step 5).
    await registerWithPresence(rig, memberDeviceUsername);

    const callerChannel = fakeAri.addChannel({
      caller: { number: '+15559999', name: '' }
    });
    const call = newInternalCall(callerChannel.id, 'e100', '400');
    pipeline.registerCall(call);
    const ringing = ringGroup(pipeline, call, groupId);
    // The batch rings the member's device before the picker steps in.
    await memberRinging(call);

    const pickerUserId = await seedUser(db);
    const pickerChannel = fakeAri.addChannel({});
    // `999` is dialled nowhere: not a user, not a ring group, not a parking slot.
    const pickerCall = newInternalCall(pickerChannel.id, 'e200', '*8999');
    pickerCall.callerUserId = pickerUserId;
    pipeline.registerCall(pickerCall);

    await handleFeature(pipeline, presence, pickerCall, 'pickup', '999');

    expect(pickerCall.status).toBe('failed');
    expect(call.answeredByUserId).toBeNull();
    expect(call.status).toBeNull();
    const pickerReleased = fakeAri.calls.some(
      entry =>
        entry.method === 'DELETE' &&
        entry.path === `channels/${pickerChannel.id}` &&
        entry.qs === `reason_code=${sipToHangupCause(404)}`
    );
    expect(pickerReleased).toBe(true);
    // The group's own ring race is untouched: the member's device is never hung up by the
    // picker's failed attempt.
    const memberHungUp = fakeAri.calls.some(
      entry =>
        entry.method === 'DELETE' &&
        entry.path.startsWith('channels/') &&
        entry.path !== `channels/${callerChannel.id}` &&
        entry.path !== `channels/${pickerChannel.id}`
    );
    expect(memberHungUp).toBe(false);

    // Settles the still-ringing batch so the test itself doesn't leave a dangling race.
    fakeAri.emit({
      type: 'ChannelDestroyed',
      timestamp: nowIso(),
      application: 'zamfono',
      channel: defaultChannel({ id: callerChannel.id })
    });
    await ringing;
  });
});
