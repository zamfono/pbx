import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { newId, nowIso, openDb, type Db } from '@zamfono/shared';
import { migrateForTest } from '@zamfono/shared/testDb.js';

import { AriClient } from '../ari/client.js';
import { FakeAri } from '../ari/fake.js';
import { isPlacement } from '../ari/fakeDial.js';
import type { Channel } from '../ari/types.js';
import { EventBus } from '../internal/eventBus.js';
import { ConfigCache } from '../internal/snapshot.js';
import { StateStore } from '../internal/stateStore.js';
import { Presence } from '../presence.js';
import { eventually } from '../testing/eventually.js';
import { noopLogger, testPipelineDeps } from '../testing/pipelineDeps.js';
import { newCall, type Call } from './call.js';
import { Pipeline } from './pipeline.js';
import { ringGroup } from './ringGroup.js';

/** Who is ringable (registration, busy) and which of the group's own rules fires when nobody
 * rings or answers (§10.1 step 5): `unavailable`, `unanswered`, and the group mailbox default. */

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

/** A member user with one device per `sipUsernames` entry. */
async function seedMemberUser(
  db: Db,
  groupId: string,
  position: number,
  sipUsernames: string[]
): Promise<string> {
  const userId = newId();
  await db
    .insertInto('users')
    .values({
      id: userId,
      name: 'Member',
      email: `${userId}@example.com`,
      createdAt: nowIso()
    })
    .execute();
  for (const sipUsername of sipUsernames) {
    // eslint-disable-next-line no-await-in-loop -- a member has one or two devices
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
  await db
    .insertInto('ringGroupMembers')
    .values({ groupId, position, userId, userGroupId: null })
    .execute();
  return userId;
}

async function seedRingGroup(
  db: Db,
  overrides: { skipBusy?: boolean; mailboxEnabled?: boolean } = {}
): Promise<string> {
  const id = newId();
  await db
    .insertInto('ringGroups')
    .values({
      id,
      name: `Group ${id}`,
      strategy: 'simultaneous',
      ringTimeoutS: 1,
      skipBusy: overrides.skipBusy === false ? 0 : 1,
      mailboxEnabled: overrides.mailboxEnabled === true ? 1 : 0,
      createdAt: nowIso()
    })
    .execute();
  return id;
}

/** A group forward rule whose target is an announcement, `filename` telling the rules apart. */
async function seedAnnouncementRule(
  db: Db,
  groupId: string,
  condition: 'unanswered' | 'unavailable',
  filename: string
): Promise<void> {
  const audioId = newId();
  await db
    .insertInto('audioAssets')
    .values({
      id: audioId,
      label: condition,
      kind: 'announcement',
      filename,
      createdAt: nowIso()
    })
    .execute();
  const targetId = newId();
  await db
    .insertInto('forwardTargets')
    .values({ id: targetId, announcementAudioId: audioId })
    .execute();
  await db
    .insertInto('ringGroupForwardRules')
    .values({ groupId, condition, targetId })
    .execute();
}

/** An unconditional forward from `userId` to `targetUserId`, and `userId`'s DND flag. */
async function seedUserForward(
  db: Db,
  userId: string,
  targetUserId: string,
  dnd = false
): Promise<void> {
  const targetId = newId();
  await db
    .insertInto('forwardTargets')
    .values({ id: targetId, userId: targetUserId })
    .execute();
  await db
    .insertInto('userForwardRules')
    .values({ userId, condition: 'unconditional', targetId })
    .execute();
  await db
    .updateTable('users')
    .set({ dnd: dnd ? 1 : 0 })
    .where('id', '=', userId)
    .execute();
}

function originatedEndpoints(fakeAri: FakeAri): string[] {
  return fakeAri.calls
    .filter(entry => isPlacement(entry))
    .map(entry => (entry.body as { endpoint?: string }).endpoint ?? '');
}

function playedMedia(fakeAri: FakeAri, channelId: string): string[] {
  return fakeAri.calls
    .filter(
      entry =>
        entry.method === 'POST' && entry.path === `channels/${channelId}/play`
    )
    .map(entry => (entry.body as { media?: string }).media ?? '');
}

describe('ring-group ringability and fallback rules', () => {
  let db: Db;
  let fakeAri: FakeAri;
  let ari: AriClient;
  let presence: Presence;
  let pipeline: Pipeline;
  let callerChannel: Channel;
  let call: Call;

  beforeEach(async () => {
    db = openDb(':memory:');
    await migrateForTest(db);
    await seedSettings(db);
    fakeAri = new FakeAri();
    fakeAri.answerAfterMs = 60_000;
    fakeAri.recordingFinishedAfterMs = 5;
    const { url } = await fakeAri.listen();
    ari = new AriClient({
      url,
      user: 'zamfono',
      password: 'secret',
      app: 'zamfono',
      log: noopLogger
    });
    await ari.connect();
    const cache = new ConfigCache(db);
    const state = new StateStore();
    const bus = new EventBus();
    presence = new Presence({
      log: noopLogger,
      ari,
      cache,
      state,
      bus,
      db,
      now: nowIso
    });
    pipeline = new Pipeline(
      testPipelineDeps(ari, db, {
        cache,
        state,
        bus,
        apiClient: { mail: () => Promise.resolve() },
        presence
      })
    );
    callerChannel = fakeAri.addChannel({
      caller: { number: '+15559999', name: '' }
    });
    call = newCall({
      id: newId(),
      direction: 'inbound',
      callerChannelId: callerChannel.id,
      from: '+15559999',
      to: '+15551234',
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

  /** Registers `sipUsername` the way a phone's REGISTER reaches `Presence`. */
  async function register(sipUsername: string): Promise<void> {
    fakeAri.registerEndpoint(sipUsername);
    // `Presence` handles the event off the WebSocket, after a config read.
    await eventually(() => {
      expect(presence.isRegistered(sipUsername)).toBe(true);
    });
  }

  it('applies the unavailable rule at once, ringing nobody, when every member’s phone is off', async () => {
    const groupId = await seedRingGroup(db);
    await seedMemberUser(db, groupId, 0, ['e101-da']);
    await seedMemberUser(db, groupId, 1, ['e102-db']);
    await seedAnnouncementRule(db, groupId, 'unavailable', 'nobody.wav');
    await seedAnnouncementRule(db, groupId, 'unanswered', 'noanswer.wav');

    await ringGroup(pipeline, call, groupId);

    expect(originatedEndpoints(fakeAri)).toEqual([]);
    expect(playedMedia(fakeAri, callerChannel.id)).toEqual([
      'sound:/media/prompts/nobody'
    ]);
  });

  it('falls to the unanswered rule at once when the group has no unavailable rule', async () => {
    const groupId = await seedRingGroup(db);
    await seedMemberUser(db, groupId, 0, ['e101-da']);
    await seedAnnouncementRule(db, groupId, 'unanswered', 'noanswer.wav');

    const started = Date.now();
    await ringGroup(pipeline, call, groupId);

    expect(originatedEndpoints(fakeAri)).toEqual([]);
    expect(playedMedia(fakeAri, callerChannel.id)).toEqual([
      'sound:/media/prompts/noanswer'
    ]);
    // Immediately, not after the group's one-second ring timeout.
    expect(Date.now() - started).toBeLessThan(900);
  });

  it('rings only a member’s registered devices, then applies the unanswered rule on timeout', async () => {
    const groupId = await seedRingGroup(db);
    await seedMemberUser(db, groupId, 0, ['e101-da', 'e101-db']);
    await seedAnnouncementRule(db, groupId, 'unavailable', 'nobody.wav');
    await seedAnnouncementRule(db, groupId, 'unanswered', 'noanswer.wav');
    await register('e101-db');

    await ringGroup(pipeline, call, groupId);

    expect(originatedEndpoints(fakeAri)).toEqual(['PJSIP/e101-db']);
    expect(playedMedia(fakeAri, callerChannel.id)).toEqual([
      'sound:/media/prompts/noanswer'
    ]);
  });

  it('deposits in the group’s own mailbox when unanswered without a rule', async () => {
    const groupId = await seedRingGroup(db, { mailboxEnabled: true });
    await seedMemberUser(db, groupId, 0, ['e101-da']);
    await register('e101-da');

    await ringGroup(pipeline, call, groupId);

    expect(originatedEndpoints(fakeAri)).toEqual(['PJSIP/e101-da']);
    expect(call.status).toBe('voicemail');
    const rows = await db.selectFrom('voicemails').selectAll().execute();
    expect(rows.map(row => row.mailboxRingGroupId)).toEqual([groupId]);
  });

  it('skips a member on a call they placed while skip_busy is set', async () => {
    const groupId = await seedRingGroup(db);
    const busyId = await seedMemberUser(db, groupId, 0, ['e101-da']);
    await seedMemberUser(db, groupId, 1, ['e102-db']);
    await register('e101-da');
    await register('e102-db');
    // What `outbound.ts` flags as the member dials out on their own call.
    presence.setCallState(busyId, 'inCall', '+4930999', null, newId());

    await ringGroup(pipeline, call, groupId);

    expect(originatedEndpoints(fakeAri)).toEqual(['PJSIP/e102-db']);
  });

  it('skips a member whose answer on a party api added is still joining while skip_busy is set', async () => {
    const groupId = await seedRingGroup(db);
    const busyId = await seedMemberUser(db, groupId, 0, ['e101-da']);
    await seedMemberUser(db, groupId, 1, ['e102-db']);
    await register('e101-da');
    await register('e102-db');
    // An added party's call (`addedParty.ts`) has no caller channel; its leg is up from the
    // answer on, before the join that flags the member in a call.
    const added = newCall({
      id: newId(),
      direction: 'internal',
      callerChannelId: null,
      from: '101',
      to: '102',
      startedAt: nowIso(),
      logLevel: 'events',
      callLogMaxBytes: 1_048_576
    });
    const legChannel = fakeAri.addChannel({ caller: { number: '', name: '' } });
    added.legs.set(legChannel.id, {
      channelId: legChannel.id,
      kind: 'device',
      userId: busyId,
      state: 'up',
      endCause: null
    });
    pipeline.registerCall(added);

    await ringGroup(pipeline, call, groupId);

    expect(originatedEndpoints(fakeAri)).toEqual(['PJSIP/e102-db']);
  });

  it('rings a member on a call they placed as call waiting while skip_busy is cleared', async () => {
    const groupId = await seedRingGroup(db, { skipBusy: false });
    const busyId = await seedMemberUser(db, groupId, 0, ['e101-da']);
    await register('e101-da');
    presence.setCallState(busyId, 'inCall', '+4930999', null, newId());

    await ringGroup(pipeline, call, groupId);

    expect(originatedEndpoints(fakeAri)).toEqual(['PJSIP/e101-da']);
  });

  it('skips a member on DND though they forward unconditionally to a reachable user', async () => {
    const groupId = await seedRingGroup(db);
    const memberId = await seedMemberUser(db, groupId, 0, ['e101-da']);
    const otherGroupId = await seedRingGroup(db);
    const forwardedId = await seedMemberUser(db, otherGroupId, 0, ['e102-db']);
    await seedUserForward(db, memberId, forwardedId, true);
    await seedAnnouncementRule(db, groupId, 'unavailable', 'nobody.wav');
    await register('e101-da');
    await register('e102-db');

    await ringGroup(pipeline, call, groupId);

    expect(originatedEndpoints(fakeAri)).toEqual([]);
    expect(playedMedia(fakeAri, callerChannel.id)).toEqual([
      'sound:/media/prompts/nobody'
    ]);
  });

  it('applies the unavailable rule at once when a member forwards to a user whose phones are off', async () => {
    const groupId = await seedRingGroup(db);
    const memberId = await seedMemberUser(db, groupId, 0, ['e101-da']);
    const otherGroupId = await seedRingGroup(db);
    const forwardedId = await seedMemberUser(db, otherGroupId, 0, ['e102-db']);
    await seedUserForward(db, memberId, forwardedId);
    await seedAnnouncementRule(db, groupId, 'unavailable', 'nobody.wav');
    await seedAnnouncementRule(db, groupId, 'unanswered', 'noanswer.wav');
    await register('e101-da');

    const started = Date.now();
    await ringGroup(pipeline, call, groupId);

    expect(originatedEndpoints(fakeAri)).toEqual([]);
    expect(playedMedia(fakeAri, callerChannel.id)).toEqual([
      'sound:/media/prompts/nobody'
    ]);
    expect(Date.now() - started).toBeLessThan(900);
  });

  it('rings the registered phone of the user a member forwards to', async () => {
    const groupId = await seedRingGroup(db);
    const memberId = await seedMemberUser(db, groupId, 0, ['e101-da']);
    const otherGroupId = await seedRingGroup(db);
    const forwardedId = await seedMemberUser(db, otherGroupId, 0, ['e102-db']);
    await seedUserForward(db, memberId, forwardedId);
    await register('e101-da');
    await register('e102-db');

    await ringGroup(pipeline, call, groupId);

    expect(originatedEndpoints(fakeAri)).toEqual(['PJSIP/e102-db']);
  });

  it('rings a busy member only on the devices not carrying their call while skip_busy is cleared', async () => {
    const groupId = await seedRingGroup(db, { skipBusy: false });
    const busyId = await seedMemberUser(db, groupId, 0, ['e101-da', 'e101-db']);
    await register('e101-da');
    await register('e101-db');
    // The call the member placed from e101-da, as Asterisk names its channel.
    fakeAri.addChannel({ name: 'PJSIP/e101-da-0000002a', state: 'Up' });
    presence.setCallState(busyId, 'inCall', '+4930999', null, newId());

    await ringGroup(pipeline, call, groupId);

    expect(originatedEndpoints(fakeAri)).toEqual(['PJSIP/e101-db']);
  });

  it('applies the unavailable rule at once when a busy member has no other device while skip_busy is cleared', async () => {
    const groupId = await seedRingGroup(db, { skipBusy: false });
    const busyId = await seedMemberUser(db, groupId, 0, ['e101-da']);
    await seedAnnouncementRule(db, groupId, 'unavailable', 'nobody.wav');
    await register('e101-da');
    fakeAri.addChannel({ name: 'PJSIP/e101-da-0000002a', state: 'Up' });
    presence.setCallState(busyId, 'inCall', '+4930999', null, newId());

    await ringGroup(pipeline, call, groupId);

    expect(originatedEndpoints(fakeAri)).toEqual([]);
    expect(playedMedia(fakeAri, callerChannel.id)).toEqual([
      'sound:/media/prompts/nobody'
    ]);
  });

  // §7: the ring group's diagnostics override counts toward the call's level.
  it('raises the call to the ring group’s diagnostics override', async () => {
    const groupId = await seedRingGroup(db);
    await db
      .updateTable('ringGroups')
      .set({ logLevel: 'qos', logLevelExpiresAt: '2999-01-01T00:00:00.000Z' })
      .where('id', '=', groupId)
      .execute();
    await seedAnnouncementRule(db, groupId, 'unavailable', 'nobody.wav');

    await ringGroup(pipeline, call, groupId);

    expect(call.log.level).toBe('qos');
  });

  // §7 level `sip`: every leg's dialog is part of the call's SIP log.
  it('joins every member leg it rings to the call’s SIP capture', async () => {
    const groupId = await seedRingGroup(db);
    await seedMemberUser(db, groupId, 0, ['e101-da']);
    await seedMemberUser(db, groupId, 1, ['e102-db']);
    await register('e101-da');
    await register('e102-db');
    const joined: string[] = [];
    pipeline.deps.cdr.joinLeg = (joinedCall, channelId) => {
      expect(joinedCall).toBe(call);
      // Joined before its INVITE leaves (§7 level `sip`): created, not dialled yet.
      expect(
        fakeAri.calls.some(entry => entry.path === `channels/${channelId}/dial`)
      ).toBe(false);
      joined.push(channelId);
      return Promise.resolve();
    };

    await ringGroup(pipeline, call, groupId);

    // Both members' device legs, each its own channel; the fake deletes them once hung up.
    expect(new Set(joined).size).toBe(2);
    expect(joined).not.toContain(callerChannel.id);
  });
});
