import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { newId, nowIso, openDb, type Db } from '@zamfono/shared';
import { migrateForTest } from '@zamfono/shared/testDb.js';

import { AriClient } from '../ari/client.js';
import { FakeAri, isPlacement } from '../ari/fake.js';
import { defaultChannel, type Channel, type Logger } from '../ari/types.js';
import { EventBus } from '../internal/eventBus.js';
import { ConfigCache } from '../internal/snapshot.js';
import { StateStore } from '../internal/stateStore.js';
import { Presence } from '../presence.js';
import { eventually } from '../testing/eventually.js';
import { newCall, type Call } from './call.js';
import { Pipeline, type PipelineDeps } from './pipeline.js';
import { runUserStep } from './userStep.js';

/** Step 4 "Target user" against registration (§10.1): a user whose phones are all off meets the
 * `offline` rule at once, and one already in a call is rung on their other devices only, or meets
 * the `busy` rule at once when they have none. */

const noopLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined
};

function fakeCdr(): PipelineDeps['cdr'] {
  return {
    open: () => Promise.resolve(),
    finish: () => Promise.resolve()
  };
}

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

/** A user with one device per `sipUsernames` entry and a one-second ring timeout. */
async function seedUser(db: Db, sipUsernames: string[]): Promise<string> {
  const userId = newId();
  await db
    .insertInto('users')
    .values({
      id: userId,
      name: 'Anna',
      email: `${userId}@example.com`,
      ringTimeoutS: 1,
      createdAt: nowIso()
    })
    .execute();
  for (const sipUsername of sipUsernames) {
    // eslint-disable-next-line no-await-in-loop -- a user has one or two devices
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
  return userId;
}

/** A user forward rule whose target is an announcement, `filename` telling the rules apart. */
async function seedAnnouncementRule(
  db: Db,
  userId: string,
  condition: 'offline' | 'noAnswer' | 'busy',
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
    .insertInto('userForwardRules')
    .values({ userId, condition, targetId })
    .execute();
}

function originatedEndpoints(fakeAri: FakeAri): string[] {
  return fakeAri.calls
    .filter(entry => isPlacement(entry))
    .map(entry => (entry.body as { endpoint?: string }).endpoint ?? '');
}

/** The channel ids of the device legs placed so far, in the order they were created. */
function placedChannelIds(fakeAri: FakeAri): string[] {
  return fakeAri.calls
    .filter(entry => isPlacement(entry))
    .map(entry => (entry.body as { channelId?: string }).channelId ?? '');
}

function traceEvents(call: Call, name: string): Record<string, unknown>[] {
  return (call.log.finish().log ?? '')
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line) as Record<string, unknown>)
    .filter(line => line.event === name);
}

function playedMedia(fakeAri: FakeAri, channelId: string): string[] {
  return fakeAri.calls
    .filter(
      entry =>
        entry.method === 'POST' && entry.path === `channels/${channelId}/play`
    )
    .map(entry => (entry.body as { media?: string }).media ?? '');
}

describe('user step against registration', () => {
  // eslint-disable-next-line init-declarations -- assigned in beforeEach before each test runs
  let db: Db;
  // eslint-disable-next-line init-declarations -- assigned in beforeEach before each test runs
  let fakeAri: FakeAri;
  // eslint-disable-next-line init-declarations -- assigned in beforeEach before each test runs
  let ari: AriClient;
  // eslint-disable-next-line init-declarations -- assigned in beforeEach before each test runs
  let presence: Presence;
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
    presence = new Presence({ ari, cache, state, bus, db, now: nowIso });
    pipeline = new Pipeline({
      ari,
      cache,
      state,
      bus,
      cdr: fakeCdr(),
      db,
      apiClient: { mail: () => Promise.resolve() },
      now: nowIso,
      trunkState: null,
      presence
    });
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

  /** `channelId`'s `ChannelStateChange` to `Up`: its phone answered. */
  function answer(channelId: string): void {
    fakeAri.emit({
      type: 'ChannelStateChange',
      timestamp: nowIso(),
      application: 'zamfono',
      channel: defaultChannel({ id: channelId, state: 'Up' })
    });
  }

  /** Whether `channelId` was added to a bridge: its answer was bridged with the caller. */
  function bridged(channelId: string): boolean {
    return fakeAri.calls.some(
      entry =>
        entry.method === 'POST' &&
        /^bridges\/[^/]+\/addChannel$/u.test(entry.path) &&
        JSON.stringify(entry.body ?? entry.qs).includes(channelId)
    );
  }

  it('applies the offline rule at once, ringing nothing, when every phone of the user is off', async () => {
    const userId = await seedUser(db, ['e101-da', 'e101-db']);
    await seedAnnouncementRule(db, userId, 'offline', 'offline.wav');
    await seedAnnouncementRule(db, userId, 'noAnswer', 'noanswer.wav');

    const started = Date.now();
    await runUserStep(pipeline, call, await pipeline.deps.cache.get(), userId);

    expect(originatedEndpoints(fakeAri)).toEqual([]);
    expect(playedMedia(fakeAri, callerChannel.id)).toEqual([
      'sound:/media/prompts/offline'
    ]);
    // Immediately, not after the user's one-second ring timeout.
    expect(Date.now() - started).toBeLessThan(900);
  });

  it('traces why the user step sent the call to the mailbox (§7 "fallback taken")', async () => {
    const userId = await seedUser(db, ['e101-da']);

    await runUserStep(pipeline, call, await pipeline.deps.cache.get(), userId);

    const lines = (call.log.finish().log ?? '')
      .split('\n')
      .map(line => JSON.parse(line) as Record<string, unknown>);
    expect(lines).toContainEqual({
      callId: call.id,
      event: 'user',
      userId,
      decision: 'mailbox',
      reason: 'offline',
      registeredDevices: 0
    });
    expect(lines).toContainEqual(
      expect.objectContaining({ event: 'voicemail', reason: 'offline' })
    );
  });

  it('rings the registered phone, then applies the noAnswer rule on timeout', async () => {
    const userId = await seedUser(db, ['e101-da', 'e101-db']);
    await seedAnnouncementRule(db, userId, 'offline', 'offline.wav');
    await seedAnnouncementRule(db, userId, 'noAnswer', 'noanswer.wav');
    await register('e101-db');

    await runUserStep(pipeline, call, await pipeline.deps.cache.get(), userId);

    expect(originatedEndpoints(fakeAri)).toEqual(['PJSIP/e101-db']);
    expect(playedMedia(fakeAri, callerChannel.id)).toEqual([
      'sound:/media/prompts/noanswer'
    ]);
  });

  // A phone Asterisk will not place leaves the race as a phone that declined at once would: with
  // none left, the noAnswer rule applies at once, not after the ring timeout.
  it.each([
    'its create is refused',
    'its dial is refused',
    'it never enters the app'
  ] as const)(
    'applies the noAnswer rule at once when the only phone cannot be placed: %s',
    async refusal => {
      const userId = await seedUser(db, ['e101-da']);
      await seedAnnouncementRule(db, userId, 'noAnswer', 'noanswer.wav');
      await register('e101-da');
      if (refusal === 'its create is refused') {
        fakeAri.failOriginate = { status: 500 };
      } else if (refusal === 'its dial is refused') {
        fakeAri.failDial = { status: 409 };
      } else {
        fakeAri.createdEntersStasis = false;
        pipeline.deps.legStasisWaitMs = 20;
      }

      const started = Date.now();
      await runUserStep(
        pipeline,
        call,
        await pipeline.deps.cache.get(),
        userId
      );

      expect(playedMedia(fakeAri, callerChannel.id)).toEqual([
        'sound:/media/prompts/noanswer'
      ]);
      expect(Date.now() - started).toBeLessThan(900);
      expect(call.log.finish().log).toContain('"cause":"placementFailed"');
    }
  );

  it('rings a user already in a call on their other devices only', async () => {
    const userId = await seedUser(db, ['e101-da', 'e101-db']);
    await register('e101-da');
    await register('e101-db');
    // The call the user placed from e101-da, as Asterisk names its channel.
    fakeAri.addChannel({ name: 'PJSIP/e101-da-0000002a', state: 'Up' });
    presence.setCallState(userId, 'inCall', '+4930999', null, newId());

    await runUserStep(pipeline, call, await pipeline.deps.cache.get(), userId);

    expect(originatedEndpoints(fakeAri)).toEqual(['PJSIP/e101-db']);
  });

  it('applies the busy rule at once when the only registered device carries a call', async () => {
    const userId = await seedUser(db, ['e101-da']);
    await seedAnnouncementRule(db, userId, 'busy', 'busy.wav');
    await seedAnnouncementRule(db, userId, 'noAnswer', 'noanswer.wav');
    await register('e101-da');
    fakeAri.addChannel({ name: 'PJSIP/e101-da-0000002a', state: 'Up' });
    presence.setCallState(userId, 'inCall', '+4930999', null, newId());

    const started = Date.now();
    await runUserStep(pipeline, call, await pipeline.deps.cache.get(), userId);

    expect(originatedEndpoints(fakeAri)).toEqual([]);
    expect(playedMedia(fakeAri, callerChannel.id)).toEqual([
      'sound:/media/prompts/busy'
    ]);
    // Immediately, not after the user's one-second ring timeout.
    expect(Date.now() - started).toBeLessThan(900);
  });

  // §9.1 "every channel's language": a device leg carries it from its creation.
  it('originates every device leg with the tenant’s language', async () => {
    await db.updateTable('settings').set({ language: 'de' }).execute();
    const userId = await seedUser(db, ['e101-da', 'e101-db']);
    await register('e101-da');
    await register('e101-db');

    await runUserStep(pipeline, call, await pipeline.deps.cache.get(), userId);

    const languages = fakeAri.calls
      .filter(entry => isPlacement(entry))
      .map(
        entry =>
          (entry.body as { variables?: Record<string, string> }).variables?.[
            'CHANNEL(language)'
          ]
      );
    expect(languages).toEqual(['de', 'de']);
  });

  // §7: the target user's diagnostics override counts toward the call's level.
  it('raises the call to the target user’s diagnostics override', async () => {
    const userId = await seedUser(db, ['e101-da']);
    await db
      .updateTable('users')
      .set({ logLevel: 'sip', logLevelExpiresAt: '2999-01-01T00:00:00.000Z' })
      .where('id', '=', userId)
      .execute();
    await seedAnnouncementRule(db, userId, 'offline', 'offline.wav');

    await runUserStep(pipeline, call, await pipeline.deps.cache.get(), userId);

    expect(call.log.level).toBe('sip');
  });

  // §7 level `sip`: every leg's dialog is part of the call's SIP log.
  it('joins every device leg it rings to the call’s SIP capture', async () => {
    const userId = await seedUser(db, ['e101-da', 'e101-db']);
    await register('e101-da');
    await register('e101-db');
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

    await runUserStep(pipeline, call, await pipeline.deps.cache.get(), userId);

    expect(joined.toSorted()).toEqual([...call.legs.keys()].toSorted());
    expect(joined).toHaveLength(2);
  });

  // §9.3 "One endpoint per device": the core dials a user's devices in parallel, so no device
  // waits for another's create, `StasisStart` and SIP join before it rings.
  it('places every device at once, none waiting for another to be dialled', async () => {
    const userId = await seedUser(db, ['e101-da', 'e101-db']);
    // Level `sip`, where each leg's dial waits for its dialog's join.
    await db
      .updateTable('users')
      .set({ logLevel: 'sip', logLevelExpiresAt: '2999-01-01T00:00:00.000Z' })
      .where('id', '=', userId)
      .execute();
    await register('e101-da');
    await register('e101-db');
    const bothJoining = Promise.withResolvers<undefined>();
    let joining = 0;
    pipeline.deps.cdr.joinLeg = async () => {
      joining += 1;
      if (joining === 2) {
        bothJoining.resolve(undefined);
      }
      // Held until the other device's join has begun as well: placed one after the other, the
      // first would never be dialled.
      await bothJoining.promise;
    };

    await runUserStep(pipeline, call, await pipeline.deps.cache.get(), userId);

    expect(joining).toBe(2);
    expect(
      fakeAri.calls.filter(entry => entry.path.endsWith('/dial'))
    ).toHaveLength(2);
  });

  // §10.1 step 4: `users.ring_timeout_s` governs how long the devices ring, however long it is;
  // Asterisk's own dial timeout would cut every ring at 30 s.
  it("dials every device leg with no timeout of Asterisk's", async () => {
    const userId = await seedUser(db, ['e101-da', 'e101-db']);
    await register('e101-da');
    await register('e101-db');

    await runUserStep(pipeline, call, await pipeline.deps.cache.get(), userId);

    const timeouts = fakeAri.calls
      .filter(entry => entry.path.endsWith('/dial'))
      .map(entry => (entry.body as { timeout?: number }).timeout);
    expect(timeouts).toEqual([0, 0]);
  });

  // §10.1 step 4 "first answer wins": exactly one outcome settles the ring. On a loaded host a
  // phone's 200 OK reaches the core ahead of its own dial's response, and its answer, claimed as
  // the leg is tracked, was still being bridged when the ring found no leg ringing and concluded
  // it unanswered: the call went to voicemail and the answered phone stayed up, bridged to nobody.
  it('bridges a phone that answered before its own dial returned, never concluding the ring unanswered', async () => {
    const userId = await seedUser(db, ['e101-da']);
    await seedAnnouncementRule(db, userId, 'noAnswer', 'noanswer.wav');
    await register('e101-da');
    fakeAri.requestDelayMs = request => {
      const dial = /^channels\/(?<id>[^/]+)\/dial$/u.exec(request.path);
      if (dial?.groups?.id === undefined) {
        return 0;
      }
      // The answer is on the WebSocket while the dial's own response is still held.
      answer(dial.groups.id);
      return 50;
    };

    await runUserStep(pipeline, call, await pipeline.deps.cache.get(), userId);

    const [legId = ''] = placedChannelIds(fakeAri);
    expect(call.answeredAt).not.toBeNull();
    expect(bridged(legId)).toBe(true);
    expect(traceEvents(call, 'ringOutcome')).toEqual([]);
    expect(playedMedia(fakeAri, callerChannel.id)).toEqual([]);
  });

  it('bridges the phone that answered though the other phone declines while the answer is still being bridged', async () => {
    const userId = await seedUser(db, ['e101-da', 'e101-db']);
    await seedAnnouncementRule(db, userId, 'noAnswer', 'noanswer.wav');
    await register('e101-da');
    await register('e101-db');
    // The answer's bridge is slow to come, so the decline lands while it is still being bridged.
    fakeAri.requestDelayMs = request =>
      request.method === 'POST' && request.path === 'bridges' ? 200 : 0;

    const step = runUserStep(
      pipeline,
      call,
      await pipeline.deps.cache.get(),
      userId
    );
    await eventually(() => {
      expect(traceEvents(call, 'rungDevice')).toHaveLength(2);
    });
    const [answering = '', declining = ''] = placedChannelIds(fakeAri);
    answer(answering);
    await eventually(() => {
      expect(traceEvents(call, 'answered')).toHaveLength(1);
    });
    fakeAri.emit({
      type: 'ChannelDestroyed',
      timestamp: nowIso(),
      application: 'zamfono',
      channel: defaultChannel({ id: declining }),
      cause: 21
    });
    await step;

    expect(bridged(answering)).toBe(true);
    expect(traceEvents(call, 'ringOutcome')).toEqual([]);
    expect(playedMedia(fakeAri, callerChannel.id)).toEqual([]);
  });

  // The other order: the ring timed out first, so a phone answering afterwards is not bridged
  // with a caller already on their way to the noAnswer rule; its leg is hung up, never left up.
  it('hangs up, never bridges, a phone answering after its ring timed out', async () => {
    const userId = await seedUser(db, ['e101-da']);
    await seedAnnouncementRule(db, userId, 'noAnswer', 'noanswer.wav');
    await register('e101-da');

    await runUserStep(pipeline, call, await pipeline.deps.cache.get(), userId);
    const [legId = ''] = placedChannelIds(fakeAri);
    answer(legId);

    await eventually(() => {
      expect(
        fakeAri.calls.some(
          entry =>
            entry.method === 'DELETE' && entry.path === `channels/${legId}`
        )
      ).toBe(true);
    });
    expect(bridged(legId)).toBe(false);
    expect(traceEvents(call, 'answered')).toEqual([]);
    expect(playedMedia(fakeAri, callerChannel.id)).toEqual([
      'sound:/media/prompts/noanswer'
    ]);
  });
});
