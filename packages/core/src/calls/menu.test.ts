import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  newId,
  nowIso,
  openDb,
  type Db,
  type MailRequest
} from '@zamfono/shared';
import { migrateForTest } from '@zamfono/shared/testDb.js';

import { AriClient } from '../ari/client.js';
import { FakeAri } from '../ari/fake.js';
import { defaultChannel, type Logger } from '../ari/types.js';
import { MAX_HOPS } from '../routing/targets.js';
import { eventually } from '../testing/eventually.js';
import { newCall, type Call } from './call.js';
import { playMenu } from './menu.js';
import {
  ConfigCache,
  EventBus,
  Pipeline,
  StateStore,
  type PipelineDeps
} from './pipeline.js';
import type { MailSender } from './voicemail.js';

const noopLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined
};

function fakeCdr(): PipelineDeps['cdr'] {
  return { open: () => Promise.resolve(), finish: () => Promise.resolve() };
}

function stubApiClient(): MailSender & { sent: MailRequest[] } {
  const sent: MailRequest[] = [];
  return {
    sent,
    mail: req => {
      sent.push(req);
      return Promise.resolve();
    }
  };
}

/** A throwaway forward-target/DID chain, just to satisfy `settings.main_did_id`'s FK. */
async function seedSettings(db: Db): Promise<void> {
  const targetId = newId();
  await db
    .insertInto('forwardTargets')
    .values({ id: targetId, external: '+15550000' })
    .execute();
  const didId = newId();
  await db
    .insertInto('dids')
    .values({ id: didId, number: '+15551000', targetId, createdAt: nowIso() })
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
      name: 'Test User',
      email: `${id}@example.com`,
      createdAt: nowIso()
    })
    .execute();
  return id;
}

async function seedAudioAsset(db: Db): Promise<string> {
  const id = newId();
  await db
    .insertInto('audioAssets')
    .values({
      id,
      label: 'Main menu',
      kind: 'announcement',
      filename: 'menu.wav',
      createdAt: nowIso()
    })
    .execute();
  return id;
}

/** A `forward_targets` row that deposits in `userId`'s mailbox: easy to tell apart in assertions. */
async function seedMailboxTarget(db: Db, userId: string): Promise<string> {
  const id = newId();
  await db
    .insertInto('forwardTargets')
    .values({ id, mailboxUserId: userId })
    .execute();
  return id;
}

/** A `forward_targets` row of kind `user` (§10.1 step 6's "Forward targets"), so a match through
 * it re-enters at Entry rather than bypassing hop counting entirely, unlike a mailbox target. */
async function seedForwardTargetUser(db: Db, userId: string): Promise<string> {
  const id = newId();
  await db.insertInto('forwardTargets').values({ id, userId }).execute();
  return id;
}

/** A `forward_targets` row of kind `ring_group`, for a menu's "12: group" entry. */
async function seedForwardTargetRingGroup(
  db: Db,
  ringGroupId: string
): Promise<string> {
  const id = newId();
  await db.insertInto('forwardTargets').values({ id, ringGroupId }).execute();
  return id;
}

async function seedRingGroup(db: Db): Promise<string> {
  const id = newId();
  await db
    .insertInto('ringGroups')
    .values({
      id,
      name: `Group ${id}`,
      strategy: 'simultaneous',
      createdAt: nowIso()
    })
    .execute();
  return id;
}

/** A live, non-parking-slot extension row (§10.1 step 6 "extension dialling"). */
async function seedExtension(
  db: Db,
  ext: string,
  owner: { userId: string } | { ringGroupId: string }
): Promise<void> {
  await db
    .insertInto('extensions')
    .values({
      ext,
      userId: 'userId' in owner ? owner.userId : null,
      ringGroupId: 'ringGroupId' in owner ? owner.ringGroupId : null
    })
    .execute();
}

async function seedMenu(
  db: Db,
  opts: {
    audioId: string;
    fallbackTargetId: string;
    maxAttempts: number;
    timeoutS: number;
    allowExtensionDialing?: number;
  }
): Promise<string> {
  const id = newId();
  await db
    .insertInto('menus')
    .values({
      id,
      name: `Menu ${id}`,
      audioId: opts.audioId,
      fallbackTargetId: opts.fallbackTargetId,
      timeoutS: opts.timeoutS,
      maxAttempts: opts.maxAttempts,
      allowExtensionDialing: opts.allowExtensionDialing ?? 0,
      createdAt: nowIso()
    })
    .execute();
  return id;
}

async function addMenuTarget(
  db: Db,
  menuId: string,
  digits: string,
  targetId: string
): Promise<void> {
  await db
    .insertInto('menuTargets')
    .values({ menuId, digits, targetId })
    .execute();
}

function voicemailMailboxes(call: Call): unknown[] {
  return (
    call.log
      .finish()
      .log?.split('\n')
      .map(line => JSON.parse(line) as { event?: string; mailbox?: unknown })
      .filter(line => line.event === 'voicemail')
      .map(line => line.mailbox) ?? []
  );
}

describe('playMenu', () => {
  // eslint-disable-next-line init-declarations -- assigned in beforeEach before each test runs
  let db: Db;
  // eslint-disable-next-line init-declarations -- assigned in beforeEach before each test runs
  let fakeAri: FakeAri;
  // eslint-disable-next-line init-declarations -- assigned in beforeEach before each test runs
  let ari: AriClient;
  // eslint-disable-next-line init-declarations -- assigned in beforeEach before each test runs
  let pipeline: Pipeline;

  beforeEach(async () => {
    db = openDb(':memory:');
    await migrateForTest(db);
    await seedSettings(db);
    fakeAri = new FakeAri();
    // A menu falling back to a mailbox runs a real deposit, which waits for Asterisk to end
    // its recording (§10.2).
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
    pipeline = new Pipeline({
      ari,
      cache: new ConfigCache(db),
      state: new StateStore(),
      bus: new EventBus(),
      cdr: fakeCdr(),
      now: nowIso,
      db,
      apiClient: stubApiClient(),
      trunkState: null,
      presence: null
    });
  });

  afterEach(async () => {
    await ari.close();
    await fakeAri.close();
    await db.destroy();
  });

  /** Waits for the `count`th greeting on `channelId`: a menu collects digits once it greets. */
  async function greetingPlays(
    channelId: string,
    count: number
  ): Promise<void> {
    await eventually(() => {
      expect(
        fakeAri.calls.filter(
          entry =>
            entry.method === 'POST' &&
            entry.path === `channels/${channelId}/play`
        )
      ).toHaveLength(count);
    });
  }

  function makeCall(channelId: string): Call {
    return newCall({
      id: newId(),
      direction: 'inbound',
      callerChannelId: channelId,
      from: '+15559999',
      to: '+15551000',
      startedAt: nowIso(),
      logLevel: 'events',
      callLogMaxBytes: 1_048_576
    });
  }

  it('collects DTMF 1, waits the inter-digit timeout, then applies the single-digit target without counting a hop', async () => {
    const userOne = await seedUser(db);
    const ringGroupTwelve = await seedRingGroup(db);
    // A real `user` target (§10.1 step 6's "Forward targets"), not a mailbox one: `nextHop` counts
    // a hop for it, so re-entering through the pipeline's own `runTarget`, which the menu must not
    // do, is observable, unlike through a mailbox target, which `nextHop` never counts either way.
    // `12` is a ring-group target, as in a `{1: user, 12: group}` map.
    const targetOne = await seedForwardTargetUser(db, userOne);
    const targetTwelve = await seedForwardTargetRingGroup(db, ringGroupTwelve);
    const audioId = await seedAudioAsset(db);
    const menuId = await seedMenu(db, {
      audioId,
      fallbackTargetId: await seedMailboxTarget(db, userOne),
      maxAttempts: 3,
      timeoutS: 5
    });
    await addMenuTarget(db, menuId, '1', targetOne);
    await addMenuTarget(db, menuId, '12', targetTwelve);

    const channel = fakeAri.addChannel({});
    const call = makeCall(channel.id);
    // The call already forwarded to the hop limit; a matched menu option must still reach the
    // target user (its own mailbox, since the user has no registered device) instead of being
    // caught by the hop-limit fallback, and must leave `call.hops` untouched.
    call.hops = MAX_HOPS;
    const done = playMenu(pipeline, call, menuId);

    // The menu listens for digits from the moment it starts its greeting.
    await greetingPlays(channel.id, 1);
    fakeAri.emit({
      type: 'ChannelDtmfReceived',
      timestamp: nowIso(),
      application: 'zamfono',
      channel: defaultChannel({ id: channel.id }),
      digit: '1'
    });
    await done;

    expect(call.hops).toBe(MAX_HOPS);
    expect(call.status).toBe('voicemail');
    expect(voicemailMailboxes(call)).toEqual([{ userId: userOne }]);
  }, 5000);

  it('lets a DTMF digit during the greeting stop it and start collection (barge-in)', async () => {
    const fallbackUser = await seedUser(db);
    const targetOne = await seedForwardTargetUser(db, fallbackUser);
    const audioId = await seedAudioAsset(db);
    const menuId = await seedMenu(db, {
      audioId,
      fallbackTargetId: await seedMailboxTarget(db, fallbackUser),
      maxAttempts: 3,
      timeoutS: 5
    });
    await addMenuTarget(db, menuId, '1', targetOne);
    // A greeting far longer than the test: only a barge-in, never `PlaybackFinished`, lets it end.
    fakeAri.playbackFinishedAfterMs = 5000;

    const channel = fakeAri.addChannel({});
    const call = makeCall(channel.id);
    const done = playMenu(pipeline, call, menuId);
    // The menu answers the caller first; the digit follows once the greeting has started.
    await greetingPlays(channel.id, 1);

    // Sent while the greeting is still "playing" (well before the 5 s it would take to finish).
    fakeAri.emit({
      type: 'ChannelDtmfReceived',
      timestamp: nowIso(),
      application: 'zamfono',
      channel: defaultChannel({ id: channel.id }),
      digit: '1'
    });
    await done;

    expect(call.status).toBe('voicemail');
    expect(voicemailMailboxes(call)).toEqual([{ userId: fallbackUser }]);
    const stopped = fakeAri.calls.some(
      entry => entry.method === 'DELETE' && entry.path.startsWith('playbacks/')
    );
    expect(stopped).toBe(true);
    // `playbackFinishedAfterMs` also governs the mailbox greeting the deposit plays, so the whole
    // flow costs that greeting twice over.
  }, 20_000);

  it('only starts the silence timer once the greeting has actually finished', async () => {
    // A `user` target with no registered device takes the implicit mailbox default; this test is
    // only about when the silence timer starts.
    const fallbackUser = await seedUser(db);
    const audioId = await seedAudioAsset(db);
    const menuId = await seedMenu(db, {
      audioId,
      fallbackTargetId: await seedForwardTargetUser(db, fallbackUser),
      maxAttempts: 1,
      timeoutS: 1
    });
    // A "long greeting": were the timeout started when it began, the menu would give up around
    // 1 s in, well before the greeting itself finishes.
    const GREETING_MS = 500;
    fakeAri.playbackFinishedAfterMs = GREETING_MS;

    const channel = fakeAri.addChannel({});
    const call = makeCall(channel.id);
    const startedAt = Date.now();

    await playMenu(pipeline, call, menuId);

    const elapsedMs = Date.now() - startedAt;
    expect(call.status).toBe('voicemail');
    // At least the greeting, then the full silence timeout — comfortably more than timeout_s alone.
    expect(elapsedMs).toBeGreaterThanOrEqual(GREETING_MS + 1000 - 100);
  }, 5000);

  it('replays on silence and applies the fallback target after max_attempts', async () => {
    const fallbackUser = await seedUser(db);
    const fallbackTargetId = await seedForwardTargetUser(db, fallbackUser);
    const audioId = await seedAudioAsset(db);
    const menuId = await seedMenu(db, {
      audioId,
      fallbackTargetId,
      maxAttempts: 3,
      timeoutS: 1
    });

    const channel = fakeAri.addChannel({});
    const call = makeCall(channel.id);

    await playMenu(pipeline, call, menuId);

    expect(call.status).toBe('voicemail');
    expect(voicemailMailboxes(call)).toEqual([{ userId: fallbackUser }]);
    const attempts = call.log
      .finish()
      .log?.split('\n')
      .map(line => JSON.parse(line) as { event?: string })
      .filter(line => line.event === 'menuAttempt');
    expect(attempts).toHaveLength(3);
  }, 5000);

  it('ends the call once two menus falling back to each other exhaust the shared attempts', async () => {
    const audioId = await seedAudioAsset(db);
    const tempTargetId = await seedMailboxTarget(db, await seedUser(db));
    const menuAId = await seedMenu(db, {
      audioId,
      fallbackTargetId: tempTargetId,
      maxAttempts: 1,
      timeoutS: 1
    });
    const targetToA = newId();
    await db
      .insertInto('forwardTargets')
      .values({ id: targetToA, menuId: menuAId })
      .execute();
    const menuBId = await seedMenu(db, {
      audioId,
      fallbackTargetId: targetToA,
      maxAttempts: 1,
      timeoutS: 1
    });
    const targetToB = newId();
    await db
      .insertInto('forwardTargets')
      .values({ id: targetToB, menuId: menuBId })
      .execute();
    await db
      .updateTable('menus')
      .set({ fallbackTargetId: targetToB })
      .where('id', '=', menuAId)
      .execute();

    const channel = fakeAri.addChannel({});
    const call = makeCall(channel.id);

    await playMenu(pipeline, call, menuAId);

    expect(call.status).toBe('missed');
    const events = call.log
      .finish()
      .log?.split('\n')
      .map(line => JSON.parse(line) as { event?: string; menuId?: string });
    expect(events?.some(line => line.event === 'menuFallback')).toBe(true);
    expect(events?.some(line => line.event === 'menuAttemptsExceeded')).toBe(
      true
    );
  }, 5000);

  it('gives a menu entered through a matched key its own full attempts budget, nested or not', async () => {
    const userId = await seedUser(db);
    const audioId = await seedAudioAsset(db);
    const targetToUser = await seedForwardTargetUser(db, userId);

    const menuBId = await seedMenu(db, {
      audioId,
      fallbackTargetId: await seedMailboxTarget(db, userId),
      maxAttempts: 1,
      timeoutS: 1
    });
    await addMenuTarget(db, menuBId, '1', targetToUser);

    const targetToMenuB = newId();
    await db
      .insertInto('forwardTargets')
      .values({ id: targetToMenuB, menuId: menuBId })
      .execute();
    const menuAId = await seedMenu(db, {
      audioId,
      fallbackTargetId: await seedMailboxTarget(db, userId),
      maxAttempts: 1,
      timeoutS: 1
    });
    await addMenuTarget(db, menuAId, '1', targetToMenuB);

    const channel = fakeAri.addChannel({});
    const call = makeCall(channel.id);
    const done = playMenu(pipeline, call, menuAId);

    // Menu A's own single attempt is spent reaching menu B; without a reset, menu B would start
    // at that same spent budget and refuse to even greet.
    // The menu listens for digits from the moment it starts its greeting.
    await greetingPlays(channel.id, 1);
    fakeAri.emit({
      type: 'ChannelDtmfReceived',
      timestamp: nowIso(),
      application: 'zamfono',
      channel: defaultChannel({ id: channel.id }),
      digit: '1'
    });
    // Menu B's own greeting.
    await greetingPlays(channel.id, 2);
    fakeAri.emit({
      type: 'ChannelDtmfReceived',
      timestamp: nowIso(),
      application: 'zamfono',
      channel: defaultChannel({ id: channel.id }),
      digit: '1'
    });
    await done;

    expect(call.hops).toBe(0);
    expect(call.status).toBe('voicemail');
    expect(voicemailMailboxes(call)).toEqual([{ userId }]);
    const events = call.log
      .finish()
      .log?.split('\n')
      .map(line => JSON.parse(line) as { event?: string; menuId?: string });
    expect(
      events?.some(
        line => line.event === 'menuAttempt' && line.menuId === menuBId
      )
    ).toBe(true);
    expect(events?.some(line => line.event === 'menuAttemptsExceeded')).toBe(
      false
    );
  }, 5000);

  it('keeps collecting past a menu-map miss while the digits still prefix a live extension', async () => {
    const targetUser = await seedUser(db);
    const otherUser = await seedUser(db);
    const audioId = await seedAudioAsset(db);
    // Two extensions sharing the `10` prefix so a single digit can never resolve early, exercising
    // the actual collection wait, not just a length check.
    await seedExtension(db, '100', { userId: targetUser });
    await seedExtension(db, '101', { userId: otherUser });
    const menuId = await seedMenu(db, {
      audioId,
      fallbackTargetId: await seedMailboxTarget(db, otherUser),
      maxAttempts: 1,
      timeoutS: 1,
      allowExtensionDialing: 1
    });

    const channel = fakeAri.addChannel({});
    const call = makeCall(channel.id);
    const done = playMenu(pipeline, call, menuId);

    // The menu listens for digits from the moment it starts its greeting.
    await greetingPlays(channel.id, 1);
    for (const digit of ['1', '0', '0']) {
      fakeAri.emit({
        type: 'ChannelDtmfReceived',
        timestamp: nowIso(),
        application: 'zamfono',
        channel: defaultChannel({ id: channel.id }),
        digit
      });
      // eslint-disable-next-line no-await-in-loop -- digits are sent one at a time, in order
      await new Promise(resolve => {
        setTimeout(resolve, 10);
      });
    }
    await done;

    expect(call.hops).toBe(0);
    expect(call.status).toBe('voicemail');
    expect(voicemailMailboxes(call)).toEqual([{ userId: targetUser }]);
  }, 15_000);
});
