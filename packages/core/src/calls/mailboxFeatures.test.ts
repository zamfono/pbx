import { afterEach, describe, expect, it } from 'vitest';

import { newId, nowIso, type Db } from '@zamfono/shared';
import { seedUser } from '@zamfono/shared/testDb.js';

import type { AriClient } from '../ari/client.js';
import type { CdrWriter } from '../cdr.js';
import type { Presence } from '../presence.js';
import type { FakeAri } from '../testing/ari/fake.js';
import { defaultChannel } from '../testing/ari/fakeChannel.js';
import { isPlacement } from '../testing/ari/fakeDial.js';
import { nextSubscription, requestTo } from '../testing/eventually.js';
import {
  newInternalCall,
  seedVoicemail,
  startFeatureRig
} from '../testing/featureRig.js';
import type { Rig } from '../testing/pipelineRig.js';
import { seedExtension } from '../testing/seedRows.js';
import { handleFeature } from './features.js';
import type { Pipeline } from './pipeline.js';
import { sipToHangupCause } from './releaseCause.js';

describe('mailbox features', () => {
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

  it('*95<ext> admits a caller who is a member of the ring group only through a user group', async () => {
    await setUp();
    const groupId = newId();
    await db
      .insertInto('ringGroups')
      .values({
        id: groupId,
        name: 'Support',
        strategy: 'simultaneous',
        createdAt: nowIso()
      })
      .execute();
    await seedExtension(db, '400', { ringGroupId: groupId });
    const memberUserId = await seedUser(db);
    const userGroupId = newId();
    await db
      .insertInto('userGroups')
      .values({ id: userGroupId, name: 'Support staff', createdAt: nowIso() })
      .execute();
    await db
      .insertInto('userGroupUsers')
      .values({ groupId: userGroupId, userId: memberUserId })
      .execute();
    await db
      .insertInto('ringGroupMembers')
      .values({ groupId, position: 0, userGroupId, userId: null })
      .execute();

    const channel = fakeAri.addChannel({});
    const call = newInternalCall(channel.id, 'e300', '*95400');
    call.callerUserId = memberUserId;
    pipeline.registerCall(call);
    await cdr.open(call);

    // The menu's wait for a digit, which the caller's hangup ends.
    const menuListening = nextSubscription(ari);
    const done = handleFeature(pipeline, presence, call, 'mailbox', '400');
    await menuListening;
    fakeAri.emit({
      type: 'StasisEnd',
      timestamp: nowIso(),
      application: 'zamfono',
      channel: defaultChannel({ id: channel.id })
    });
    await done;

    const forbidden = fakeAri.calls.some(
      entry =>
        entry.method === 'DELETE' &&
        entry.path === `channels/${channel.id}` &&
        entry.qs === `reason_code=${sipToHangupCause(403)}`
    );
    expect(forbidden).toBe(false);
    const answered = fakeAri.calls.some(
      entry =>
        entry.method === 'POST' &&
        entry.path === `channels/${channel.id}/answer`
    );
    expect(answered).toBe(true);
  });

  it('*96 digit 1 plays the first new message, marks it read and refreshes MWI', async () => {
    await setUp();
    const ownerId = await seedUser(db);
    const messageId = await seedVoicemail(db, ownerId, `${newId()}.wav`);

    const channel = fakeAri.addChannel({});
    const call = newInternalCall(channel.id, 'e100', '*96');
    call.callerUserId = ownerId;
    pipeline.registerCall(call);
    await cdr.open(call);

    // The menu's wait for a digit, after its answer.
    const menuListening = nextSubscription(ari);
    const done = handleFeature(pipeline, presence, call, 'ownVoicemail', '');
    await menuListening;
    // Digit 1 plays the message, waiting for the playback to end ...
    const messagePlaying = nextSubscription(ari);
    fakeAri.emit({
      type: 'ChannelDtmfReceived',
      timestamp: nowIso(),
      application: 'zamfono',
      channel: defaultChannel({ id: channel.id }),
      digit: '1'
    });
    await messagePlaying;
    // ... then marks it read, refreshes MWI and waits for the next digit, which the hangup ends.
    await nextSubscription(ari);
    fakeAri.emit({
      type: 'StasisEnd',
      timestamp: nowIso(),
      application: 'zamfono',
      channel: defaultChannel({ id: channel.id })
    });
    await done;

    const row = await db
      .selectFrom('voicemails')
      .select('read')
      .where('id', '=', messageId)
      .executeTakeFirstOrThrow();
    expect(row.read).toBe(1);
    const mwiPut = fakeAri.calls.find(
      entry =>
        entry.method === 'PUT' && entry.path === `mailboxes/user:${ownerId}`
    );
    expect(mwiPut?.body).toEqual({ oldMessages: 1, newMessages: 0 });
  });

  it('*97<ext> deposits the caller in the mailbox without ringing', async () => {
    await setUp();
    const ownerId = await seedUser(db);
    await seedExtension(db, '150', { userId: ownerId });

    const channel = fakeAri.addChannel({});
    const call = newInternalCall(channel.id, 'e100', '*97150');
    pipeline.registerCall(call);
    await cdr.open(call);

    const done = handleFeature(pipeline, presence, call, 'deposit', '150');
    const recordCall = await requestTo(
      fakeAri,
      'POST',
      `channels/${channel.id}/record`
    );

    const originated = fakeAri.calls.some(entry => isPlacement(entry));
    expect(originated).toBe(false);

    fakeAri.emit({
      type: 'RecordingFinished',
      timestamp: nowIso(),
      application: 'zamfono',
      recording: {
        name: (recordCall.body as { name: string }).name,
        duration: 5
      }
    });
    await done;

    const row = await db
      .selectFrom('voicemails')
      .select('mailboxUserId')
      .executeTakeFirstOrThrow();
    expect(row.mailboxUserId).toBe(ownerId);
  });

  it('a greeting recorded over *95<ext> digit 0 is what the next deposit plays', async () => {
    await setUp();
    const ownerId = await seedUser(db);
    await seedExtension(db, '150', { userId: ownerId });

    // `*95150` by the owner: the permission check warms the config snapshot before the recording.
    const menuChannel = fakeAri.addChannel({});
    const menuCall = newInternalCall(menuChannel.id, 'e150', '*95150');
    menuCall.callerUserId = ownerId;
    pipeline.registerCall(menuCall);
    await cdr.open(menuCall);
    const menuListening = nextSubscription(ari);
    const menu = handleFeature(pipeline, presence, menuCall, 'mailbox', '150');
    await menuListening;
    fakeAri.emit({
      type: 'ChannelDtmfReceived',
      timestamp: nowIso(),
      application: 'zamfono',
      channel: defaultChannel({ id: menuChannel.id }),
      digit: '0'
    });
    const greetingRecord = await requestTo(
      fakeAri,
      'POST',
      `channels/${menuChannel.id}/record`
    );
    // Once the greeting is stored, the menu waits for its next digit, which the hangup ends.
    const nextDigitListening = nextSubscription(ari);
    fakeAri.emit({
      type: 'RecordingFinished',
      timestamp: nowIso(),
      application: 'zamfono',
      recording: {
        name: (greetingRecord.body as { name: string }).name,
        duration: 4
      }
    });
    await nextDigitListening;
    fakeAri.emit({
      type: 'StasisEnd',
      timestamp: nowIso(),
      application: 'zamfono',
      channel: defaultChannel({ id: menuChannel.id })
    });
    await menu;
    const asset = await db
      .selectFrom('audioAssets')
      .select(['id', 'kind'])
      .executeTakeFirstOrThrow();
    expect(asset.kind).toBe('vmGreeting');

    // §10.2 "Mailbox access": the REST API and the phone share one greeting.
    const depositChannel = fakeAri.addChannel({});
    const depositCall = newInternalCall(depositChannel.id, 'e100', '*97150');
    pipeline.registerCall(depositCall);
    await cdr.open(depositCall);
    const done = handleFeature(
      pipeline,
      presence,
      depositCall,
      'deposit',
      '150'
    );
    // Recording starts only once the greeting played to the end.
    const depositRecord = await requestTo(
      fakeAri,
      'POST',
      `channels/${depositChannel.id}/record`
    );
    const greetingPlay = fakeAri.calls.find(
      entry =>
        entry.method === 'POST' &&
        entry.path === `channels/${depositChannel.id}/play`
    );
    expect((greetingPlay?.body as { media?: string }).media).toBe(
      `sound:/media/prompts/${asset.id}`
    );
    fakeAri.emit({
      type: 'RecordingFinished',
      timestamp: nowIso(),
      application: 'zamfono',
      recording: {
        name: (depositRecord.body as { name: string }).name,
        duration: 5
      }
    });
    await done;
  });
});
