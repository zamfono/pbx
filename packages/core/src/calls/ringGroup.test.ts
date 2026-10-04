import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  MS_PER_SECOND,
  newId,
  nowIso,
  type Db,
  type Envelope,
  type LiveCall
} from '@zamfono/shared';
import { seedUser } from '@zamfono/shared/testDb.js';

import type { AriClient } from '../ari/client.js';
import type { Channel } from '../ari/types.js';
import { AST_CAUSE_USER_BUSY } from '../sipCodes.js';
import type { FakeAri } from '../testing/ari/fake.js';
import { defaultChannel } from '../testing/ari/fakeChannel.js';
import { isPlacement, placedCallerId } from '../testing/ari/fakeDial.js';
import { onEvents } from '../testing/busEvents.js';
import { eventually, requestTo } from '../testing/eventually.js';
import { noopRecorder, registerDevice } from '../testing/pipelineDeps.js';
import { startRig, type Rig } from '../testing/pipelineRig.js';
import {
  seedAudioAsset,
  seedDevice,
  seedRingGroup
} from '../testing/seedRows.js';
import { newCall, type Call, type Leg } from './call.js';
import { liveView } from './callState.js';
import type { Pipeline } from './pipeline.js';
import type { ParticipationRecorder } from './recordParticipation.js';
import { sipToHangupCause } from './releaseCause.js';
import { ringGroup } from './ringGroup.js';

async function seedMember(
  db: Db,
  groupId: string,
  position: number,
  userId: string
): Promise<void> {
  await db
    .insertInto('ringGroupMembers')
    .values({ groupId, position, userId, userGroupId: null })
    .execute();
}

/** A recorder that only notes which participations each answer offered it (§10.2). */
function spyRecorder(): ParticipationRecorder & {
  callers: Call[];
  legs: Leg[];
} {
  const callers: Call[] = [];
  const legs: Leg[] = [];
  return {
    ...noopRecorder,
    callers,
    legs,
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
}

/** The call's routing-trace lines whose `event` is `name`. */
function traceEvents(call: Call, name: string): Record<string, unknown>[] {
  return (call.log.finish().log ?? '')
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line) as Record<string, unknown>)
    .filter(line => line.event === name);
}

/**
 * Waits until the batch tracks `count` member legs. A leg is traced once its originate returned
 * and the race holds it, so an event the test emits for it from here on reaches the race; the
 * fake merely having received the originate is not enough.
 */
function membersRinging(call: Call, count: number): Promise<void> {
  return eventually(() => {
    expect(traceEvents(call, 'ringGroupMember')).toHaveLength(count);
  });
}

function originates(fakeAri: FakeAri): { path: string }[] {
  return fakeAri.calls.filter(entry => isPlacement(entry));
}

function hangups(fakeAri: FakeAri, channelId: string): number {
  return fakeAri.calls.filter(
    entry => entry.method === 'DELETE' && entry.path === `channels/${channelId}`
  ).length;
}

describe('ringGroup', () => {
  let rig: Rig;
  let db: Db;
  let fakeAri: FakeAri;
  let ari: AriClient;
  let pipeline: Pipeline;
  let callerChannel: Channel;
  let call: Call;

  beforeEach(async () => {
    rig = await startRig();
    ({ db, fakeAri, ari, pipeline } = rig);
    callerChannel = fakeAri.addChannel({
      caller: { number: '+15559999', name: '' }
    });
    call = newCall({
      id: newId(),
      direction: 'inbound',
      callerChannelId: callerChannel.id,
      from: '+15559999',
      to: '+15551000',
      startedAt: nowIso(),
      logLevel: 'events',
      callLogMaxBytes: 1_048_576
    });
    pipeline.registerCall(call);
  });

  afterEach(async () => {
    await rig.stop();
  });

  it('simultaneous with three members originates three legs, the first Up wins, the others are hung up', async () => {
    const greetingId = await seedAudioAsset(db, {
      label: 'greeting',
      kind: 'greeting',
      filename: 'welcome.wav'
    });
    const mohId = await seedAudioAsset(db, {
      label: 'moh',
      kind: 'moh',
      filename: 'hold.wav'
    });
    const groupId = await seedRingGroup(db, {
      strategy: 'simultaneous',
      greetingAudioId: greetingId,
      mohAudioId: mohId
    });
    const userIds = await Promise.all([
      seedUser(db),
      seedUser(db),
      seedUser(db)
    ]);
    await Promise.all(
      userIds.map(async (userId, index) => {
        await seedDevice(db, userId, `member-${index}`);
        await registerDevice(fakeAri, pipeline, `member-${index}`);
      })
    );
    await Promise.all(
      userIds.map((userId, index) => seedMember(db, groupId, index, userId))
    );
    fakeAri.answerAfterMs = 60_000;

    const finished = ringGroup(pipeline, call, groupId);
    await membersRinging(call, 3);
    expect(originates(fakeAri)).toHaveLength(3);
    expect(call.ringGroupId).toBe(groupId);

    // The greeting plays to the answered caller channel before the MoH class replaces ringback.
    const answered = fakeAri.calls.some(
      entry =>
        entry.method === 'POST' &&
        entry.path === `channels/${callerChannel.id}/answer`
    );
    expect(answered).toBe(true);
    const greeting = fakeAri.calls.find(
      entry =>
        entry.method === 'POST' &&
        entry.path === `channels/${callerChannel.id}/play`
    );
    expect((greeting?.body as { media?: string } | undefined)?.media).toBe(
      'sound:/media/prompts/welcome'
    );
    const moh = fakeAri.calls.find(
      entry =>
        entry.method === 'POST' &&
        entry.path === `channels/${callerChannel.id}/moh`
    );
    expect((moh?.body as { mohClass?: string } | undefined)?.mohClass).toBe(
      mohId
    );

    // Read the three originated channels back off the fake before anyone answers, so the
    // losers can still be found once they are hung up (the fake drops a channel on hangup).
    const listed = await ari.channels.list();
    const channels = userIds.map((_userId, index) =>
      listed.find(entry => entry.name === `PJSIP/member-${index}`)
    );
    for (const channel of channels) {
      expect(channel).toBeDefined();
    }
    const winnerIndex = 0;
    const winnerChannel = channels[winnerIndex];
    if (!winnerChannel) {
      return;
    }
    fakeAri.emit({
      type: 'ChannelStateChange',
      timestamp: nowIso(),
      application: 'zamfono',
      channel: defaultChannel({ id: winnerChannel.id, state: 'Up' })
    });

    await finished;
    expect(call.status).toBe('answered');
    expect(call.bridgeId).not.toBeNull();
    expect(call.answeredByUserId).toBe(userIds[winnerIndex]);
    expect(hangups(fakeAri, winnerChannel.id)).toBe(0);
    for (let index = 0; index < channels.length; index += 1) {
      if (index === winnerIndex) {
        continue;
      }
      const channel = channels[index];
      if (!channel) {
        continue;
      }
      expect(hangups(fakeAri, channel.id)).toBe(1);
    }
  });

  it('a member sees the call while their leg rings, and is told when it stops (§10.3 "Live calls", §10.6)', async () => {
    const groupId = await seedRingGroup(db, {
      strategy: 'simultaneous',
      ringTimeoutS: 20
    });
    const [declining, winning, losing] = await Promise.all([
      seedUser(db),
      seedUser(db),
      seedUser(db)
    ]);
    const members = [declining, winning, losing];
    await Promise.all(
      members.map(async (userId, index) => {
        await seedDevice(db, userId, `seen-${index}`);
        await registerDevice(fakeAri, pipeline, `seen-${index}`);
      })
    );
    await Promise.all(
      members.map((userId, index) => seedMember(db, groupId, index, userId))
    );
    const events: Extract<Envelope, { type: 'call.state' }>[] = [];
    onEvents(pipeline.deps.bus, envelope => {
      if (envelope.type === 'call.state') {
        events.push(envelope);
      }
    });
    const eventsFor = (userId: string): string[] =>
      events
        .filter(event => event.userIds.includes(userId))
        .map(event => `${event.state}${event.usersOnly ? '*' : ''}`);
    const live = (): LiveCall =>
      liveView(pipeline.deps.state.calls.get(call.id) ?? expect.unreachable());
    const liveUsers = (): string[] => [...live().userIds].sort();
    fakeAri.answerAfterMs = 60_000;

    const finished = ringGroup(pipeline, call, groupId);
    await membersRinging(call, 3);
    expect(liveUsers()).toEqual([...members].sort());
    expect(live().connectedUserIds).toEqual([]);
    const listed = await ari.channels.list();
    const channelOf = (index: number): string =>
      listed.find(entry => entry.name === `PJSIP/seen-${index}`)?.id ?? '';

    fakeAri.emit({
      type: 'ChannelDestroyed',
      timestamp: nowIso(),
      application: 'zamfono',
      channel: defaultChannel({ id: channelOf(0) }),
      cause: AST_CAUSE_USER_BUSY
    });
    await eventually(() => {
      expect(liveUsers()).toEqual([winning, losing].sort());
    });
    fakeAri.emit({
      type: 'ChannelStateChange',
      timestamp: nowIso(),
      application: 'zamfono',
      channel: defaultChannel({ id: channelOf(1), state: 'Up' })
    });
    await finished;

    expect(liveUsers()).toEqual([winning]);
    expect(live().connectedUserIds).toEqual([winning]);
    // `*` marks an event for these users alone: the call is new to them, or no longer theirs.
    expect(eventsFor(declining)).toEqual(['ringing*', 'ended*']);
    expect(eventsFor(losing)).toEqual(['ringing*', 'up', 'ended*']);
    expect(eventsFor(winning)).toEqual(['ringing*', 'up']);
  });

  it("names a phone-book caller on the member legs: the contact's display name is the caller-ID name (§10.2)", async () => {
    const contactId = newId();
    await db
      .insertInto('contacts')
      .values({
        id: contactId,
        displayName: 'Huber GmbH',
        createdAt: nowIso(),
        updatedAt: nowIso()
      })
      .execute();
    await db
      .insertInto('contactPhones')
      .values({ contactId, number: '+15559999', label: 'office' })
      .execute();
    const groupId = await seedRingGroup(db, { strategy: 'simultaneous' });
    const userIds = await Promise.all([
      seedUser(db),
      seedUser(db, { name: 'Member' })
    ]);
    await Promise.all(
      userIds.map(async (userId, index) => {
        await seedDevice(db, userId, `member-${index}`);
        await registerDevice(fakeAri, pipeline, `member-${index}`);
      })
    );
    await Promise.all(
      userIds.map((userId, index) => seedMember(db, groupId, index, userId))
    );
    fakeAri.answerAfterMs = 60_000;

    const finished = ringGroup(pipeline, call, groupId);
    await membersRinging(call, 2);
    const callerIds = fakeAri.calls
      .filter(entry => isPlacement(entry))
      .map(entry => placedCallerId(entry));
    expect(callerIds).toEqual([
      '"Huber GmbH" <+15559999>',
      '"Huber GmbH" <+15559999>'
    ]);
    fakeAri.emit({
      type: 'ChannelDestroyed',
      timestamp: nowIso(),
      application: 'zamfono',
      channel: defaultChannel({ id: callerChannel.id }),
      cause: 16
    });
    await finished;
  });

  it('a sibling leg ending while the winner is still bridging does not settle the batch as unanswered', async () => {
    const groupId = await seedRingGroup(db, {
      strategy: 'simultaneous',
      ringTimeoutS: 20
    });
    const userA = await seedUser(db);
    const userB = await seedUser(db);
    await seedDevice(db, userA, 'race-a');
    fakeAri.answerAfterMs = 60_000;
    await registerDevice(fakeAri, pipeline, 'race-a');
    await seedDevice(db, userB, 'race-b');
    await registerDevice(fakeAri, pipeline, 'race-b');
    await seedMember(db, groupId, 0, userA);
    await seedMember(db, groupId, 1, userB);

    const finished = ringGroup(pipeline, call, groupId);
    await membersRinging(call, 2);
    expect(originates(fakeAri)).toHaveLength(2);

    const listed = await ari.channels.list();
    const winnerChannel = listed.find(entry => entry.name === 'PJSIP/race-a');
    const siblingChannel = listed.find(entry => entry.name === 'PJSIP/race-b');
    expect(winnerChannel).toBeDefined();
    expect(siblingChannel).toBeDefined();
    if (!winnerChannel || !siblingChannel) {
      return;
    }
    // Both events are emitted back to back, before winBatch's own network round trips (stopMoh,
    // answer, bridge create/addChannel) can complete, to land the sibling's end inside that window.
    fakeAri.emit({
      type: 'ChannelStateChange',
      timestamp: nowIso(),
      application: 'zamfono',
      channel: defaultChannel({ id: winnerChannel.id, state: 'Up' })
    });
    fakeAri.emit({
      type: 'ChannelDestroyed',
      timestamp: nowIso(),
      application: 'zamfono',
      channel: defaultChannel({ id: siblingChannel.id }),
      cause: AST_CAUSE_USER_BUSY
    });

    await finished;
    expect(call.status).toBe('answered');
    expect(call.answeredByUserId).toBe(userA);
    expect(call.bridgeId).not.toBeNull();
  });

  // §10.1 step 5 "the first answer wins": exactly one outcome settles a batch. Its timeout landing
  // while a member's answer is still being bridged must not ring the next batch nor fall back.
  it('a batch timeout landing while the winner is still bridging does not move on to the next batch', async () => {
    const groupId = await seedRingGroup(db, {
      strategy: 'sequential',
      ringTimeoutS: 1
    });
    const userA = await seedUser(db);
    const userB = await seedUser(db);
    await seedDevice(db, userA, 'slow-a');
    fakeAri.answerAfterMs = 60_000;
    await registerDevice(fakeAri, pipeline, 'slow-a');
    await seedDevice(db, userB, 'slow-b');
    await registerDevice(fakeAri, pipeline, 'slow-b');
    await seedMember(db, groupId, 0, userA);
    await seedMember(db, groupId, 1, userB);
    // The winner's bridge comes only after the batch's one-second timeout.
    fakeAri.holdRequest = request =>
      request.method === 'POST' && request.path === 'bridges' ? 1500 : 0;

    const finished = ringGroup(pipeline, call, groupId);
    await membersRinging(call, 1);
    const listed = await ari.channels.list();
    const winner = listed.find(entry => entry.name === 'PJSIP/slow-a');
    if (!winner) {
      throw new Error('the first member should ring');
    }
    fakeAri.emit({
      type: 'ChannelStateChange',
      timestamp: nowIso(),
      application: 'zamfono',
      channel: defaultChannel({ id: winner.id, state: 'Up' })
    });

    await finished;
    expect(originates(fakeAri)).toHaveLength(1);
    expect(call.status).toBe('answered');
    expect(call.answeredByUserId).toBe(userA);
    expect(call.bridgeId).not.toBeNull();
    expect(hangups(fakeAri, winner.id)).toBe(0);
  }, 10_000);

  // The other order: the batch timed out first while a sibling was still being placed, so a
  // member answering afterwards is hung up, never bridged with a caller already moving on.
  it('a member answering after its batch timed out is hung up, never bridged', async () => {
    const groupId = await seedRingGroup(db, {
      strategy: 'simultaneous',
      ringTimeoutS: 1
    });
    const users = [
      await seedUser(db),
      await seedUser(db, { name: 'Member' }),
      await seedUser(db, { name: 'Member' })
    ];
    fakeAri.answerAfterMs = 60_000;
    await Promise.all(
      users.flatMap((userId, index) => [
        seedDevice(db, userId, `late-${index}`),
        seedMember(db, groupId, index, userId)
      ])
    );
    await Promise.all(
      [...users.keys()].map(index =>
        registerDevice(fakeAri, pipeline, `late-${index}`)
      )
    );
    // late-1 rings only after the timeout; late-2 is still being placed when late-1 answers.
    const createDelays: Record<string, number> = {
      'PJSIP/late-1': 1500,
      'PJSIP/late-2': 2500
    };
    fakeAri.holdRequest = request => {
      const endpoint = (request.body as { endpoint?: string } | undefined)
        ?.endpoint;
      return request.path === 'channels/create'
        ? (createDelays[endpoint ?? ''] ?? 0)
        : 0;
    };

    const finished = ringGroup(pipeline, call, groupId);
    await membersRinging(call, 2);
    const listed = await ari.channels.list();
    const late = listed.find(entry => entry.name === 'PJSIP/late-1');
    if (!late) {
      throw new Error('the second member should ring');
    }
    fakeAri.emit({
      type: 'ChannelStateChange',
      timestamp: nowIso(),
      application: 'zamfono',
      channel: defaultChannel({ id: late.id, state: 'Up' })
    });

    await finished;
    expect(traceEvents(call, 'answered')).toEqual([]);
    expect(call.bridgeId).toBeNull();
    expect(hangups(fakeAri, late.id)).toBeGreaterThan(0);
  }, 10_000);

  it('two members answering back to back: only the first wins, bridged once, traced once, recorded and shown up', async () => {
    const groupId = await seedRingGroup(db, {
      strategy: 'simultaneous',
      ringTimeoutS: 20
    });
    const userA = await seedUser(db);
    const userB = await seedUser(db);
    await seedDevice(db, userA, 'both-a');
    fakeAri.answerAfterMs = 60_000;
    const recorder = spyRecorder();
    pipeline.deps.recorder = recorder;
    await registerDevice(fakeAri, pipeline, 'both-a');
    await seedDevice(db, userB, 'both-b');
    await registerDevice(fakeAri, pipeline, 'both-b');
    await seedMember(db, groupId, 0, userA);
    await seedMember(db, groupId, 1, userB);
    const states: string[] = [];
    onEvents(pipeline.deps.bus, envelope => {
      if (envelope.type === 'call.state') {
        states.push(envelope.state);
      }
    });

    const finished = ringGroup(pipeline, call, groupId);
    await membersRinging(call, 2);
    const listed = await ari.channels.list();
    const channelA = listed.find(entry => entry.name === 'PJSIP/both-a');
    const channelB = listed.find(entry => entry.name === 'PJSIP/both-b');
    if (!channelA || !channelB) {
      throw new Error('both members should ring');
    }
    // Back to back, before the first win's own round trips (stopMoh, bridge) can complete.
    for (const channel of [channelA, channelB]) {
      fakeAri.emit({
        type: 'ChannelStateChange',
        timestamp: nowIso(),
        application: 'zamfono',
        channel: defaultChannel({ id: channel.id, state: 'Up' })
      });
    }

    await finished;
    const bridgeCreates = fakeAri.calls.filter(
      entry => entry.method === 'POST' && entry.path === 'bridges'
    );
    expect(bridgeCreates).toHaveLength(1);
    expect(call.answeredByUserId).toBe(userA);
    expect(hangups(fakeAri, channelA.id)).toBe(0);
    expect(hangups(fakeAri, channelB.id)).toBeGreaterThan(0);
    // §10.2 "Recording semantics": the winner's participation, routed by this group, and the
    // caller's own are offered to the recorder, which applies the effective flag.
    expect(recorder.callers).toEqual([call]);
    expect(recorder.legs.map(leg => leg.channelId)).toEqual([channelA.id]);
    // §10.6 and `GET /internal/state`: the call is live and up.
    expect(pipeline.deps.state.calls.get(call.id)?.state).toBe('up');
    expect(states.filter(state => state === 'up')).toHaveLength(1);
    expect(states.at(-1)).toBe('up');
    // §7: one trace line per answer.
    const answered = traceEvents(call, 'answered');
    expect(answered).toHaveLength(1);
    expect(answered[0]).toMatchObject({ userId: userA, ringGroupId: groupId });
  });

  it('leaves the caller unanswered, hearing ringback, for a group with neither greeting nor music (§10.2)', async () => {
    const groupId = await seedRingGroup(db, {
      strategy: 'simultaneous',
      ringTimeoutS: 1
    });
    const userId = await seedUser(db);
    await seedDevice(db, userId, 'plain-0');
    fakeAri.answerAfterMs = 60_000;
    await registerDevice(fakeAri, pipeline, 'plain-0');
    await seedMember(db, groupId, 0, userId);

    await ringGroup(pipeline, call, groupId);

    const callerPosts = fakeAri.calls
      .filter(
        entry =>
          entry.method === 'POST' &&
          entry.path.startsWith(`channels/${callerChannel.id}/`)
      )
      .map(entry => entry.path.slice(`channels/${callerChannel.id}/`.length));
    expect(callerPosts).toContain('ring');
    expect(callerPosts).not.toContain('answer');
    expect(callerPosts).not.toContain('moh');
  }, 10_000);

  it('sequential rings members one after another and falls back once every timeout elapses', async () => {
    const groupId = await seedRingGroup(db, {
      strategy: 'sequential',
      ringTimeoutS: 2
    });
    const userA = await seedUser(db);
    const userB = await seedUser(db);
    await seedDevice(db, userA, 'seq-a');
    fakeAri.answerAfterMs = 60_000;
    await registerDevice(fakeAri, pipeline, 'seq-a');
    await seedDevice(db, userB, 'seq-b');
    await registerDevice(fakeAri, pipeline, 'seq-b');
    await seedMember(db, groupId, 0, userA);
    await seedMember(db, groupId, 1, userB);

    const finished = ringGroup(pipeline, call, groupId);
    await membersRinging(call, 1);
    expect(originates(fakeAri)).toHaveLength(1);

    // The next member rings only once the first one's 2 s timeout elapses.
    await eventually(() => {
      expect(originates(fakeAri)).toHaveLength(2);
    });

    await finished;
    expect(call.status).toBe('missed');
    const released = fakeAri.calls.some(
      entry =>
        entry.method === 'DELETE' &&
        entry.path === `channels/${callerChannel.id}` &&
        entry.qs === `reason_code=${sipToHangupCause(480)}`
    );
    expect(released).toBe(true);
  }, 10_000);

  // A member's phone Asterisk will not place leaves the batch; with none ringing, the group falls
  // back at once rather than after its timeout, and the trace says why.
  it('falls back at once when no member phone can be placed, tracing placementFailed', async () => {
    const groupId = await seedRingGroup(db, {
      strategy: 'simultaneous',
      ringTimeoutS: 20
    });
    const userA = await seedUser(db);
    const userB = await seedUser(db);
    await seedDevice(db, userA, 'pf-a');
    fakeAri.failDial = { status: 409 };
    await registerDevice(fakeAri, pipeline, 'pf-a');
    await seedDevice(db, userB, 'pf-b');
    await registerDevice(fakeAri, pipeline, 'pf-b');
    await seedMember(db, groupId, 0, userA);
    await seedMember(db, groupId, 1, userB);

    const started = Date.now();
    await ringGroup(pipeline, call, groupId);

    expect(Date.now() - started).toBeLessThan(5000);
    expect(call.status).toBe('missed');
    expect(
      fakeAri.calls.some(
        entry =>
          entry.method === 'DELETE' &&
          entry.path === `channels/${callerChannel.id}` &&
          entry.qs === `reason_code=${sipToHangupCause(480)}`
      )
    ).toBe(true);
    const failed = (call.log.finish().log ?? '')
      .split('\n')
      .filter(line => line.includes('"cause":"placementFailed"'));
    expect(failed).toHaveLength(2);
  });

  it('a member declining with allow_reject is skipped without waiting for the timeout', async () => {
    const groupId = await seedRingGroup(db, {
      strategy: 'sequential',
      ringTimeoutS: 20,
      allowReject: 1
    });
    const userA = await seedUser(db);
    const userB = await seedUser(db);
    await seedDevice(db, userA, 'decline-a');
    fakeAri.answerAfterMs = 60_000;
    await registerDevice(fakeAri, pipeline, 'decline-a');
    await seedDevice(db, userB, 'decline-b');
    await registerDevice(fakeAri, pipeline, 'decline-b');
    await seedMember(db, groupId, 0, userA);
    await seedMember(db, groupId, 1, userB);

    const finished = ringGroup(pipeline, call, groupId);
    await membersRinging(call, 1);
    expect(originates(fakeAri)).toHaveLength(1);

    // ringGroup keeps its ring race private, so the originated channel's id is read back off
    // the fake's own channel list rather than off any exposed pipeline state.
    const listed = await ari.channels.list();
    const decliningChannel = listed.find(
      channel => channel.name === 'PJSIP/decline-a'
    );
    expect(decliningChannel).toBeDefined();
    if (!decliningChannel) {
      return;
    }
    fakeAri.emit({
      type: 'ChannelDestroyed',
      timestamp: nowIso(),
      application: 'zamfono',
      channel: defaultChannel({ id: decliningChannel.id }),
      cause: AST_CAUSE_USER_BUSY
    });

    await membersRinging(call, 2);
    expect(originates(fakeAri)).toHaveLength(2);
    const secondListed = await ari.channels.list();
    const secondChannel = secondListed.find(
      channel => channel.name === 'PJSIP/decline-b'
    );
    expect(secondChannel).toBeDefined();
    if (!secondChannel) {
      return;
    }
    fakeAri.emit({
      type: 'ChannelStateChange',
      timestamp: nowIso(),
      application: 'zamfono',
      channel: defaultChannel({ id: secondChannel.id, state: 'Up' })
    });

    await finished;
    expect(call.status).toBe('answered');
    expect(call.answeredByUserId).toBe(userB);
    expect(hangups(fakeAri, decliningChannel.id)).toBe(0);
  });

  it('a member whose phone declines before its originate returns is skipped with allow_reject', async () => {
    const groupId = await seedRingGroup(db, {
      strategy: 'sequential',
      ringTimeoutS: 20,
      allowReject: 1
    });
    const userA = await seedUser(db);
    const userB = await seedUser(db);
    await seedDevice(db, userA, 'decline-a');
    fakeAri.answerAfterMs = 60_000;
    await registerDevice(fakeAri, pipeline, 'decline-a');
    await seedDevice(db, userB, 'decline-b');
    await registerDevice(fakeAri, pipeline, 'decline-b');
    await seedMember(db, groupId, 0, userA);
    await seedMember(db, groupId, 1, userB);
    // Asterisk dials the phone while it answers the originate; a 486 at once destroys the
    // channel before the core learns its id.
    fakeAri.onOriginate = channel => {
      fakeAri.onOriginate = null;
      fakeAri.emit({
        type: 'ChannelDestroyed',
        timestamp: nowIso(),
        application: 'zamfono',
        channel: defaultChannel({ id: channel.id }),
        cause: AST_CAUSE_USER_BUSY
      });
    };

    const finished = ringGroup(pipeline, call, groupId);
    await membersRinging(call, 2);
    const secondChannel = (await ari.channels.list()).find(
      channel => channel.name === 'PJSIP/decline-b'
    );
    expect(secondChannel).toBeDefined();
    fakeAri.emit({
      type: 'ChannelStateChange',
      timestamp: nowIso(),
      application: 'zamfono',
      channel: defaultChannel({ id: secondChannel?.id ?? '', state: 'Up' })
    });

    await finished;
    expect(call.status).toBe('answered');
    expect(call.answeredByUserId).toBe(userB);
  });

  it('a member declining with allow_reject cleared keeps ringing until the timeout', async () => {
    const RING_TIMEOUT_S = 1;
    const groupId = await seedRingGroup(db, {
      strategy: 'sequential',
      ringTimeoutS: RING_TIMEOUT_S,
      allowReject: 0
    });
    const userA = await seedUser(db);
    const userB = await seedUser(db);
    await seedDevice(db, userA, 'noreject-a');
    fakeAri.answerAfterMs = 60_000;
    await registerDevice(fakeAri, pipeline, 'noreject-a');
    await seedDevice(db, userB, 'noreject-b');
    await registerDevice(fakeAri, pipeline, 'noreject-b');
    await seedMember(db, groupId, 0, userA);
    await seedMember(db, groupId, 1, userB);

    const ringStarted = performance.now();
    const finished = ringGroup(pipeline, call, groupId);
    await membersRinging(call, 1);
    expect(originates(fakeAri)).toHaveLength(1);

    const listed = await ari.channels.list();
    const decliningChannel = listed.find(
      channel => channel.name === 'PJSIP/noreject-a'
    );
    expect(decliningChannel).toBeDefined();
    if (!decliningChannel) {
      return;
    }
    fakeAri.emit({
      type: 'ChannelDestroyed',
      timestamp: nowIso(),
      application: 'zamfono',
      channel: defaultChannel({ id: decliningChannel.id }),
      cause: AST_CAUSE_USER_BUSY
    });

    // The decline alone must not settle the batch early; only the timeout may.
    await eventually(() => {
      expect(originates(fakeAri)).toHaveLength(2);
    });
    // Node arms a timer on its millisecond loop clock, which can trail this one by up to 1 ms.
    expect(performance.now() - ringStarted).toBeGreaterThan(
      RING_TIMEOUT_S * MS_PER_SECOND - 1
    );

    await finished;
  }, 10_000);

  it('random strategy rings members in the order the injected rng shuffles them', async () => {
    const groupId = await seedRingGroup(db, {
      strategy: 'random',
      ringTimeoutS: 5
    });
    const userA = await seedUser(db);
    const userB = await seedUser(db);
    await seedDevice(db, userA, 'rand-a');
    await registerDevice(fakeAri, pipeline, 'rand-a');
    await seedDevice(db, userB, 'rand-b');
    await registerDevice(fakeAri, pipeline, 'rand-b');
    await seedMember(db, groupId, 0, userA);
    await seedMember(db, groupId, 1, userB);

    await ringGroup(pipeline, call, groupId, () => 0);

    const firstOriginate = fakeAri.calls.find(entry => isPlacement(entry));
    expect(
      (firstOriginate?.body as { endpoint?: string } | undefined)?.endpoint
    ).toBe('PJSIP/rand-b');
    expect(call.answeredByUserId).toBe(userB);
  });

  it('caps a sequential group at ring_total_s, dropping the member past the cap', async () => {
    const groupId = await seedRingGroup(db, {
      strategy: 'sequential',
      ringTimeoutS: 2,
      ringTotalS: 2
    });
    const userA = await seedUser(db);
    const userB = await seedUser(db);
    await seedDevice(db, userA, 'cap-a');
    fakeAri.answerAfterMs = 60_000;
    await registerDevice(fakeAri, pipeline, 'cap-a');
    await seedDevice(db, userB, 'cap-b');
    await registerDevice(fakeAri, pipeline, 'cap-b');
    await seedMember(db, groupId, 0, userA);
    await seedMember(db, groupId, 1, userB);

    await ringGroup(pipeline, call, groupId);

    expect(originates(fakeAri)).toHaveLength(1);
    expect(call.status).toBe('missed');
  }, 10_000);

  it('the caller abandoning during the group greeting originates no members and runs no fallback', async () => {
    const greetingId = await seedAudioAsset(db, {
      label: 'greeting',
      kind: 'greeting',
      filename: 'welcome.wav'
    });
    const groupId = await seedRingGroup(db, {
      strategy: 'simultaneous',
      greetingAudioId: greetingId
    });
    const userId = await seedUser(db);
    await seedDevice(db, userId, 'abandon-greeting');
    fakeAri.playbackFinishedAfterMs = 60_000;
    await registerDevice(fakeAri, pipeline, 'abandon-greeting');
    await seedMember(db, groupId, 0, userId);
    // The greeting must not finish on its own during this test; the caller hangs up first.

    const finished = ringGroup(pipeline, call, groupId);
    await requestTo(fakeAri, 'POST', `channels/${callerChannel.id}/play`);
    fakeAri.emit({
      type: 'ChannelDestroyed',
      timestamp: nowIso(),
      application: 'zamfono',
      channel: defaultChannel({ id: callerChannel.id })
    });

    await finished;
    expect(call.status).toBe('missed');
    expect(originates(fakeAri)).toHaveLength(0);
    expect(hangups(fakeAri, callerChannel.id)).toBe(0);
  });

  it('the caller abandoning while members ring hangs up every member and runs no fallback', async () => {
    const groupId = await seedRingGroup(db, {
      strategy: 'simultaneous',
      ringTimeoutS: 20
    });
    const userA = await seedUser(db);
    const userB = await seedUser(db);
    await seedDevice(db, userA, 'abandon-ring-a');
    fakeAri.answerAfterMs = 60_000;
    await registerDevice(fakeAri, pipeline, 'abandon-ring-a');
    await seedDevice(db, userB, 'abandon-ring-b');
    await registerDevice(fakeAri, pipeline, 'abandon-ring-b');
    await seedMember(db, groupId, 0, userA);
    await seedMember(db, groupId, 1, userB);

    const finished = ringGroup(pipeline, call, groupId);
    await membersRinging(call, 2);
    expect(originates(fakeAri)).toHaveLength(2);
    const listed = await ari.channels.list();
    const memberChannels = listed.filter(entry =>
      entry.name.startsWith('PJSIP/abandon-ring')
    );
    expect(memberChannels).toHaveLength(2);

    fakeAri.emit({
      type: 'ChannelDestroyed',
      timestamp: nowIso(),
      application: 'zamfono',
      channel: defaultChannel({ id: callerChannel.id })
    });

    await finished;
    expect(call.status).toBe('missed');
    for (const channel of memberChannels) {
      expect(hangups(fakeAri, channel.id)).toBe(1);
    }
    expect(hangups(fakeAri, callerChannel.id)).toBe(0);
  });

  // §9.1 "every channel's language": a member's leg carries it from its creation.
  it('originates every member leg with the tenant’s language', async () => {
    await db.updateTable('settings').set({ language: 'de' }).execute();
    const groupId = await seedRingGroup(db, {
      strategy: 'simultaneous',
      ringTimeoutS: 20
    });
    const userA = await seedUser(db);
    const userB = await seedUser(db);
    await seedDevice(db, userA, 'language-ring-a');
    fakeAri.answerAfterMs = 60_000;
    await registerDevice(fakeAri, pipeline, 'language-ring-a');
    await seedDevice(db, userB, 'language-ring-b');
    await registerDevice(fakeAri, pipeline, 'language-ring-b');
    await seedMember(db, groupId, 0, userA);
    await seedMember(db, groupId, 1, userB);

    const finished = ringGroup(pipeline, call, groupId);
    await membersRinging(call, 2);
    const languages = originates(fakeAri).map(
      entry =>
        (entry as { body?: { variables?: Record<string, string> } }).body
          ?.variables?.['CHANNEL(language)']
    );
    fakeAri.emit({
      type: 'ChannelDestroyed',
      timestamp: nowIso(),
      application: 'zamfono',
      channel: defaultChannel({ id: callerChannel.id })
    });
    await finished;

    expect(languages).toEqual(['de', 'de']);
  });

  it('releases immediately with 480 when no member is ringable', async () => {
    const groupId = await seedRingGroup(db, { strategy: 'simultaneous' });

    await ringGroup(pipeline, call, groupId);

    expect(originates(fakeAri)).toHaveLength(0);
    expect(call.status).toBe('missed');
    const released = fakeAri.calls.some(
      entry =>
        entry.method === 'DELETE' &&
        entry.path === `channels/${callerChannel.id}` &&
        entry.qs === `reason_code=${sipToHangupCause(480)}`
    );
    expect(released).toBe(true);
  });
});
