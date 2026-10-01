import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { newId, nowIso, openDb, type Db, type Envelope } from '@zamfono/shared';
import { migrateForTest } from '@zamfono/shared/testDb.js';

import { AriClient } from '../ari/client.js';
import { FakeAri, isPlacement, placedCallerId } from '../ari/fake.js';
import { defaultChannel, type Channel, type Logger } from '../ari/types.js';
import { eventually, requestTo } from '../testing/eventually.js';
import { newCall, type Call, type Leg } from './call.js';
import {
  ConfigCache,
  EventBus,
  Pipeline,
  StateStore,
  type PipelineDeps
} from './pipeline.js';
import type { ParticipationRecorder } from './recordParticipation.js';
import { sipToHangupCause } from './releaseCause.js';
import { ringGroup } from './ringGroup.js';

const noopLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined
};

// Asterisk's Q.850 mapping of SIP 486 Busy Here (matches ringGroup.ts's own constant).
const AST_CAUSE_USER_BUSY = 17;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, ms);
  });
}

function fakeCdr(): PipelineDeps['cdr'] {
  return {
    open: () => Promise.resolve(),
    finish: () => Promise.resolve()
  };
}

/** A `settings` row plus the `dids` row its `mainDidId` FK requires; no DID is dialed in these tests. */
async function seedSettings(db: Db): Promise<void> {
  const targetId = newId();
  await db
    .insertInto('forwardTargets')
    .values({ id: targetId, external: '+15550000' })
    .execute();
  const didId = newId();
  await db
    .insertInto('dids')
    .values({ id: didId, number: '+15551234', targetId, createdAt: nowIso() })
    .execute();
  await db
    .insertInto('settings')
    .values({
      id: 1,
      companyName: 'Zamfono',
      mainDidId: didId,
      country: 'DE',
      emergencyNumbersJson: '["112"]'
    })
    .execute();
}

async function seedUser(db: Db): Promise<string> {
  const id = newId();
  await db
    .insertInto('users')
    .values({
      id,
      name: 'Member',
      email: `${id}@example.com`,
      createdAt: nowIso()
    })
    .execute();
  return id;
}

async function seedDevice(
  db: Db,
  userId: string,
  sipUsername: string
): Promise<void> {
  await db
    .insertInto('devices')
    .values({
      id: newId(),
      userId,
      label: sipUsername,
      kind: 'manual',
      sipUsername,
      sipPasswordEnc: Buffer.from('secret'),
      createdAt: nowIso()
    })
    .execute();
}

type RingGroupOverrides = {
  strategy?: 'simultaneous' | 'sequential' | 'random';
  ringTimeoutS?: number;
  ringTotalS?: number | null;
  allowReject?: boolean;
  mailboxEnabled?: boolean;
  greetingAudioId?: string;
  mohAudioId?: string;
};

async function seedRingGroup(
  db: Db,
  overrides: RingGroupOverrides = {}
): Promise<string> {
  const id = newId();
  await db
    .insertInto('ringGroups')
    .values({
      id,
      name: `Group ${id}`,
      strategy: overrides.strategy ?? 'simultaneous',
      ringTimeoutS: overrides.ringTimeoutS,
      ringTotalS: overrides.ringTotalS ?? null,
      allowReject: overrides.allowReject === false ? 0 : 1,
      mailboxEnabled: overrides.mailboxEnabled === true ? 1 : 0,
      greetingAudioId: overrides.greetingAudioId ?? null,
      mohAudioId: overrides.mohAudioId ?? null,
      createdAt: nowIso()
    })
    .execute();
  return id;
}

/** An `audio_assets` row (§10.2 "Greetings and audio"), for a group's greeting or MoH class. */
async function seedAudioAsset(
  db: Db,
  kind: 'greeting' | 'moh',
  filename: string
): Promise<string> {
  const id = newId();
  await db
    .insertInto('audioAssets')
    .values({ id, label: kind, kind, filename, createdAt: nowIso() })
    .execute();
  return id;
}

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
  // eslint-disable-next-line init-declarations -- assigned in beforeEach before each test runs
  let db: Db;
  // eslint-disable-next-line init-declarations -- assigned in beforeEach before each test runs
  let fakeAri: FakeAri;
  // eslint-disable-next-line init-declarations -- assigned in beforeEach before each test runs
  let ari: AriClient;
  // eslint-disable-next-line init-declarations -- assigned in beforeEach before each test runs
  let pipeline: Pipeline;
  // eslint-disable-next-line init-declarations -- assigned in beforeEach before each test runs
  let callerChannel: Channel;
  // eslint-disable-next-line init-declarations -- assigned in beforeEach before each test runs
  let call: Call;

  beforeEach(async () => {
    db = openDb(':memory:');
    await migrateForTest(db);
    await seedSettings(db);
    fakeAri = new FakeAri();
    fakeAri.answerAfterMs = 5;
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
      cdr: fakeCdr(),
      now: nowIso,
      // --- Task 31 ---
      trunkState: null,
      presence: null
      // --- end Task 31 ---
    });
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
    await ari.close();
    await fakeAri.close();
    await db.destroy();
  });

  it('simultaneous with three members originates three legs, the first Up wins, the others are hung up', async () => {
    const greetingId = await seedAudioAsset(db, 'greeting', 'welcome.wav');
    const mohId = await seedAudioAsset(db, 'moh', 'hold.wav');
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
      userIds.map((userId, index) => seedDevice(db, userId, `member-${index}`))
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
      members.map((userId, index) => seedDevice(db, userId, `seen-${index}`))
    );
    await Promise.all(
      members.map((userId, index) => seedMember(db, groupId, index, userId))
    );
    const events: Extract<Envelope, { type: 'call.state' }>[] = [];
    pipeline.deps.bus.subscribe(envelope => {
      if (envelope.type === 'call.state') {
        events.push(envelope);
      }
    });
    const eventsFor = (userId: string): string[] =>
      events
        .filter(event => event.userIds.includes(userId))
        .map(event => `${event.state}${event.usersOnly ? '*' : ''}`);
    const liveUsers = (): string[] =>
      [...(pipeline.deps.state.calls.get(call.id)?.userIds ?? [])].sort();
    fakeAri.answerAfterMs = 60_000;

    const finished = ringGroup(pipeline, call, groupId);
    await membersRinging(call, 3);
    expect(liveUsers()).toEqual([...members].sort());
    expect(pipeline.deps.state.calls.get(call.id)?.connectedUserIds).toEqual(
      []
    );
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
    expect(pipeline.deps.state.calls.get(call.id)?.connectedUserIds).toEqual([
      winning
    ]);
    // `*` marks an event for these users alone: the call is new to them, or no longer theirs.
    expect(eventsFor(declining)).toEqual(['ringing*', 'ended*']);
    expect(eventsFor(losing)).toEqual(['ringing*', 'up', 'ended*']);
    expect(eventsFor(winning)).toEqual(['ringing*', 'up']);
  });

  it("names a phone-book caller on the member legs: the contact's display name is the caller-ID name (§10.2)", async () => {
    pipeline.deps.db = db;
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
    const userIds = await Promise.all([seedUser(db), seedUser(db)]);
    await Promise.all(
      userIds.map((userId, index) => seedDevice(db, userId, `member-${index}`))
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
    await seedDevice(db, userB, 'race-b');
    await seedMember(db, groupId, 0, userA);
    await seedMember(db, groupId, 1, userB);
    fakeAri.answerAfterMs = 60_000;

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
    await seedDevice(db, userB, 'slow-b');
    await seedMember(db, groupId, 0, userA);
    await seedMember(db, groupId, 1, userB);
    fakeAri.answerAfterMs = 60_000;
    // The winner's bridge comes only after the batch's one-second timeout.
    fakeAri.requestDelayMs = request =>
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
    const users = [await seedUser(db), await seedUser(db), await seedUser(db)];
    for (const [index, userId] of users.entries()) {
      // eslint-disable-next-line no-await-in-loop -- members keep their positions in order
      await seedDevice(db, userId, `late-${index}`);
      // eslint-disable-next-line no-await-in-loop -- members keep their positions in order
      await seedMember(db, groupId, index, userId);
    }
    fakeAri.answerAfterMs = 60_000;
    // late-1 rings only after the timeout; late-2 is still being placed when late-1 answers.
    const dialDelays: Record<string, number> = {
      'PJSIP/late-1': 1500,
      'PJSIP/late-2': 2500
    };
    fakeAri.requestDelayMs = request => {
      const dial = /^channels\/(?<id>[^/]+)\/dial$/u.exec(request.path);
      const created = fakeAri.calls.find(
        entry =>
          entry.path === 'channels/create' &&
          (entry.body as { channelId?: string }).channelId === dial?.groups?.id
      );
      const endpoint = (created?.body as { endpoint?: string } | undefined)
        ?.endpoint;
      return dial === null ? 0 : (dialDelays[endpoint ?? ''] ?? 0);
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
    await seedDevice(db, userB, 'both-b');
    await seedMember(db, groupId, 0, userA);
    await seedMember(db, groupId, 1, userB);
    const recorder = spyRecorder();
    pipeline.deps.recorder = recorder;
    const states: string[] = [];
    pipeline.deps.bus.subscribe(envelope => {
      if (envelope.type === 'call.state') {
        states.push(envelope.state);
      }
    });
    fakeAri.answerAfterMs = 60_000;

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

  it('sequential rings members one after another and falls back once every timeout elapses', async () => {
    const groupId = await seedRingGroup(db, {
      strategy: 'sequential',
      ringTimeoutS: 2
    });
    const userA = await seedUser(db);
    const userB = await seedUser(db);
    await seedDevice(db, userA, 'seq-a');
    await seedDevice(db, userB, 'seq-b');
    await seedMember(db, groupId, 0, userA);
    await seedMember(db, groupId, 1, userB);
    fakeAri.answerAfterMs = 60_000;

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
    await seedDevice(db, userB, 'pf-b');
    await seedMember(db, groupId, 0, userA);
    await seedMember(db, groupId, 1, userB);
    fakeAri.failDial = { status: 409 };

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
      allowReject: true
    });
    const userA = await seedUser(db);
    const userB = await seedUser(db);
    await seedDevice(db, userA, 'decline-a');
    await seedDevice(db, userB, 'decline-b');
    await seedMember(db, groupId, 0, userA);
    await seedMember(db, groupId, 1, userB);
    fakeAri.answerAfterMs = 60_000;

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
      allowReject: true
    });
    const userA = await seedUser(db);
    const userB = await seedUser(db);
    await seedDevice(db, userA, 'decline-a');
    await seedDevice(db, userB, 'decline-b');
    await seedMember(db, groupId, 0, userA);
    await seedMember(db, groupId, 1, userB);
    fakeAri.answerAfterMs = 60_000;
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
    const groupId = await seedRingGroup(db, {
      strategy: 'sequential',
      ringTimeoutS: 1,
      allowReject: false
    });
    const userA = await seedUser(db);
    const userB = await seedUser(db);
    await seedDevice(db, userA, 'noreject-a');
    await seedDevice(db, userB, 'noreject-b');
    await seedMember(db, groupId, 0, userA);
    await seedMember(db, groupId, 1, userB);
    fakeAri.answerAfterMs = 60_000;

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
    await sleep(200);
    expect(originates(fakeAri)).toHaveLength(1);

    await eventually(() => {
      expect(originates(fakeAri)).toHaveLength(2);
    });

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
    await seedDevice(db, userB, 'rand-b');
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
    await seedDevice(db, userB, 'cap-b');
    await seedMember(db, groupId, 0, userA);
    await seedMember(db, groupId, 1, userB);
    fakeAri.answerAfterMs = 60_000;

    await ringGroup(pipeline, call, groupId);

    expect(originates(fakeAri)).toHaveLength(1);
    expect(call.status).toBe('missed');
  }, 10_000);

  it('the caller abandoning during the group greeting originates no members and runs no fallback', async () => {
    const greetingId = await seedAudioAsset(db, 'greeting', 'welcome.wav');
    const groupId = await seedRingGroup(db, {
      strategy: 'simultaneous',
      greetingAudioId: greetingId
    });
    const userId = await seedUser(db);
    await seedDevice(db, userId, 'abandon-greeting');
    await seedMember(db, groupId, 0, userId);
    // The greeting must not finish on its own during this test; the caller hangs up first.
    fakeAri.playbackFinishedAfterMs = 60_000;

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
    await seedDevice(db, userB, 'abandon-ring-b');
    await seedMember(db, groupId, 0, userA);
    await seedMember(db, groupId, 1, userB);
    fakeAri.answerAfterMs = 60_000;

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
    await seedDevice(db, userB, 'language-ring-b');
    await seedMember(db, groupId, 0, userA);
    await seedMember(db, groupId, 1, userB);
    fakeAri.answerAfterMs = 60_000;

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
