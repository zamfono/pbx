import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { newId, nowIso, type Db } from '@zamfono/shared';
import { seedUser } from '@zamfono/shared/testDb.js';

import type { CdrWriter } from '../cdr.js';
import type { FakeAri } from '../testing/ari/fake.js';
import { defaultChannel } from '../testing/ari/fakeChannel.js';
import { eventually, requestTo } from '../testing/eventually.js';
import { startRig, type Rig } from '../testing/pipelineRig.js';
import { seedExtension } from '../testing/seedRows.js';
import { callerChannel, newCall, type Call } from './call.js';
import { mailboxAccess, ownVoicemail } from './mailbox.js';
import { introMedia } from './mailboxGrammar.js';
import { mainMenuMedia } from './mailboxPrompts.js';
import type { Pipeline } from './pipeline.js';

// A prompt "plays" until the test barges in with a key or ends it itself, so every step of the
// menu waits on exactly what the test does next.
const NEVER_MS = 600_000;

type Play = { media: string | string[]; playbackId: string };

/** A message in `ownerId`'s mailbox, `minutesAgo` old; its file is named after its id. */
async function seedMessage(
  db: Db,
  ownerId: string,
  minutesAgo: number,
  read: 0 | 1
): Promise<string> {
  const id = newId();
  await db
    .insertInto('voicemails')
    .values({
      id,
      mailboxUserId: ownerId,
      mailboxRingGroupId: null,
      caller: '+15559999',
      filename: `${id}.wav`,
      durationS: 12,
      createdAt: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
      read
    })
    .execute();
  return id;
}

describe('mailbox menu (§10.2 "Mailbox access")', () => {
  let rig: Rig;
  let db: Db;
  let fakeAri: FakeAri;
  let pipeline: Pipeline;
  let cdr: CdrWriter;
  let ownerId: string;
  let call: Call;
  let playsSeen = 0;

  beforeEach(async () => {
    rig = await startRig();
    ({ db, fakeAri, pipeline, cdr } = rig);
    fakeAri.playbackFinishedAfterMs = NEVER_MS;
    ownerId = await seedUser(db, { name: 'Owner' });
    const channel = fakeAri.addChannel({});
    call = newCall({
      id: newId(),
      direction: 'internal',
      callerChannelId: channel.id,
      from: '100',
      to: '*96',
      startedAt: nowIso(),
      logLevel: 'events',
      callLogMaxBytes: 1_048_576
    });
    call.callerUserId = ownerId;
    pipeline.registerCall(call);
    await cdr.open(call);
    playsSeen = 0;
  });

  afterEach(async () => {
    await rig.stop();
  });

  /** The menu's next playback on the caller's channel, once it has been requested. */
  async function nextPlay(): Promise<Play> {
    const play = await eventually(() => {
      const plays = fakeAri.calls.filter(
        entry =>
          entry.method === 'POST' &&
          entry.path === `channels/${call.callerChannelId}/play`
      );
      const found = plays.at(playsSeen);
      if (found === undefined) {
        throw new Error('no further playback yet');
      }
      return found.body as Play;
    });
    playsSeen += 1;
    return play;
  }

  function press(digit: string): void {
    fakeAri.emit({
      type: 'ChannelDtmfReceived',
      timestamp: nowIso(),
      application: 'zamfono',
      channel: defaultChannel({ id: callerChannel(call), state: 'Up' }),
      digit
    });
  }

  function finish(play: Play): void {
    fakeAri.emit({
      type: 'PlaybackFinished',
      timestamp: nowIso(),
      application: 'zamfono',
      playback: { id: play.playbackId }
    });
  }

  function messageMedia(folder: 'new' | 'old', position: number, id: string) {
    return [
      `sound:mailbox/header-${folder}`,
      `sound:digits-final/${position}`,
      `sound:/media/voicemail/${id}`
    ];
  }

  async function readFlags(): Promise<Record<string, number>> {
    const rows = await db
      .selectFrom('voicemails')
      .select(['id', 'read'])
      .execute();
    return Object.fromEntries(rows.map(row => [row.id, row.read]));
  }

  it('speaks the counts and walks new then old messages: next, previous, delete, back, exit', async () => {
    const firstNew = await seedMessage(db, ownerId, 30, 0);
    const secondNew = await seedMessage(db, ownerId, 20, 0);
    const old = await seedMessage(db, ownerId, 60, 1);
    const done = ownVoicemail(pipeline, call);

    // "You have 2 new messages and 1 saved message", then the main menu.
    expect((await nextPlay()).media).toEqual([
      ...introMedia('en', 2, 1),
      ...mainMenuMedia(2, 1)
    ]);
    expect(introMedia('en', 2, 1)).toEqual([
      'sound:mailbox/you-have',
      'sound:digits/2',
      'sound:mailbox/new-other-and',
      'sound:mailbox/old-one'
    ]);
    press('1');
    // A key barges in on the playing menu: it stops at once.
    await requestTo(
      fakeAri,
      'DELETE',
      `playbacks/${call.callerChannelId}:mailbox:1`
    );
    expect((await nextPlay()).media).toEqual(messageMedia('new', 1, firstNew));
    // A new message is read as soon as it starts playing, and MWI follows (§9.3).
    await eventually(async () => {
      expect((await readFlags())[firstNew]).toBe(1);
    });
    press('6');
    expect((await nextPlay()).media).toEqual(messageMedia('new', 2, secondNew));
    press('6');
    // Past the last new message the walk carries on into the old ones.
    expect((await nextPlay()).media).toEqual(messageMedia('old', 1, old));
    press('4');
    expect((await nextPlay()).media).toEqual(messageMedia('new', 2, secondNew));
    press('7');
    const deleted = await nextPlay();
    expect(deleted.media).toBe('sound:vm-deleted');
    finish(deleted);
    // The message after the deleted one plays next.
    expect((await nextPlay()).media).toEqual(messageMedia('old', 1, old));
    press('*');
    // Back in the main menu, which repeats the counts on `*`.
    expect((await nextPlay()).media).toEqual([
      ...introMedia('en', 1, 1),
      ...mainMenuMedia(1, 1)
    ]);
    press('#');
    const goodbye = await nextPlay();
    expect(goodbye.media).toBe('sound:vm-goodbye');
    finish(goodbye);
    await done;

    expect(await readFlags()).toEqual({ [firstNew]: 1, [old]: 1 });
    const mwi = fakeAri.calls
      .filter(
        entry =>
          entry.method === 'PUT' && entry.path === `mailboxes/user:${ownerId}`
      )
      .map(entry => entry.body);
    expect(mwi.at(-1)).toEqual({ oldMessages: 2, newMessages: 0 });
    expect(
      fakeAri.calls.some(
        entry =>
          entry.method === 'DELETE' &&
          entry.path === `channels/${call.callerChannelId}`
      )
    ).toBe(true);
    const row = await db
      .selectFrom('calls')
      .select('status')
      .where('id', '=', call.id)
      .executeTakeFirstOrThrow();
    expect(row.status).toBe('answered');
  });

  it('offers after a message only the options it has, and a message ending leads to them', async () => {
    const only = await seedMessage(db, ownerId, 10, 0);
    const done = ownVoicemail(pipeline, call);
    expect((await nextPlay()).media).toEqual([
      ...introMedia('en', 1, 0),
      ...mainMenuMedia(1, 0)
    ]);
    press('1');
    const message = await nextPlay();
    expect(message.media).toEqual(messageMedia('new', 1, only));
    finish(message);
    // Neither a previous nor a next message: repeat, delete, main menu.
    expect((await nextPlay()).media).toEqual([
      'sound:vm-repeat',
      'sound:vm-delete',
      'sound:vm-starmain'
    ]);
    press('6');
    const noMore = await nextPlay();
    expect(noMore.media).toBe('sound:vm-nomore');
    finish(noMore);
    await nextPlay();
    press('5');
    expect((await nextPlay()).media).toEqual(messageMedia('new', 1, only));
    fakeAri.emit({
      type: 'StasisEnd',
      timestamp: nowIso(),
      application: 'zamfono',
      channel: defaultChannel({ id: callerChannel(call) })
    });
    await done;
  });

  it('announces only the folders that hold messages; 2 without old messages says there are none', async () => {
    await seedMessage(db, ownerId, 10, 0);
    const done = ownVoicemail(pipeline, call);
    const menu = await nextPlay();
    expect(menu.media).toEqual([
      ...introMedia('en', 1, 0),
      ...mainMenuMedia(1, 0)
    ]);
    expect(mainMenuMedia(1, 0)).toEqual([
      'sound:mailbox/menu-new',
      'sound:mailbox/menu-greeting',
      'sound:vm-helpexit'
    ]);
    press('2');
    const noMore = await nextPlay();
    expect(noMore.media).toBe('sound:vm-nomore');
    finish(noMore);
    // The main menu again, without the counts.
    expect((await nextPlay()).media).toEqual(mainMenuMedia(1, 0));
    press('9');
    const sorry = await nextPlay();
    expect(sorry.media).toBe('sound:vm-sorry');
    finish(sorry);
    expect((await nextPlay()).media).toEqual(mainMenuMedia(1, 0));
    press('#');
    finish(await nextPlay());
    await done;
  });

  it("counts and names messages in the tenant language's grammar (§9.1)", async () => {
    await db.updateTable('settings').set({ language: 'es' }).execute();
    const id = await seedMessage(db, ownerId, 10, 0);
    const done = ownVoicemail(pipeline, call);
    // "Tienes un mensaje nuevo", then "Mensaje nuevo número uno" before the message.
    expect((await nextPlay()).media).toEqual([
      'sound:mailbox/you-have',
      'sound:mailbox/new-one',
      ...mainMenuMedia(1, 0)
    ]);
    press('1');
    expect((await nextPlay()).media).toEqual([
      'sound:mailbox/header-new',
      'sound:digits-final/1',
      `sound:/media/voicemail/${id}`
    ]);
    press('#');
    finish(await nextPlay());
    await done;
  });

  it('0 plays the greeting instructions, records after a tone, confirms the greeting was saved and deletes the one it replaces', async () => {
    const previous = newId();
    const promptsDir = path.join(pipeline.deps.mediaDir, 'prompts');
    await mkdir(promptsDir, { recursive: true });
    await writeFile(path.join(promptsDir, `${previous}.wav`), 'wav');
    await db
      .insertInto('audioAssets')
      .values({
        id: previous,
        kind: 'vmGreeting',
        label: 'Mailbox greeting',
        filename: `${previous}.wav`,
        uploadedBy: ownerId,
        createdAt: nowIso()
      })
      .execute();
    await db
      .updateTable('users')
      .set({ mailboxAudioId: previous })
      .where('id', '=', ownerId)
      .execute();
    const done = ownVoicemail(pipeline, call);
    await nextPlay();
    press('0');
    const instructions = await nextPlay();
    expect(instructions.media).toBe('sound:vm-rec-unv');
    finish(instructions);
    const record = await requestTo(
      fakeAri,
      'POST',
      `channels/${call.callerChannelId}/record`
    );
    const params = record.body as { name: string; beep?: boolean };
    expect(params.beep).toBe(true);
    fakeAri.emit({
      type: 'RecordingFinished',
      timestamp: nowIso(),
      application: 'zamfono',
      recording: { name: params.name, duration: 4 }
    });
    const saved = await nextPlay();
    expect(saved.media).toBe('sound:vm-msgsaved');
    finish(saved);
    await nextPlay();
    press('#');
    finish(await nextPlay());
    await done;
    const user = await db
      .selectFrom('users')
      .select('mailboxAudioId')
      .where('id', '=', ownerId)
      .executeTakeFirstOrThrow();
    expect(user.mailboxAudioId).toBe(params.name.replace('prompts/', ''));
    const replaced = await db
      .selectFrom('audioAssets')
      .select('id')
      .where('id', '=', previous)
      .executeTakeFirst();
    expect(replaced).toBeUndefined();
    await expect(readdir(promptsDir)).resolves.not.toContain(`${previous}.wav`);
  });

  it('0 records no greeting while the media volume is at MEDIA_STORAGE_MAX: the mailbox-full prompt, the greeting kept (§11.6)', async () => {
    pipeline.deps.mediaFull = () => Promise.resolve(true);
    const done = ownVoicemail(pipeline, call);
    await nextPlay();
    press('0');
    finish(await nextPlay());
    const refused = await nextPlay();
    expect(refused.media).toBe('sound:vm-mailboxfull');
    finish(refused);
    await nextPlay();
    press('#');
    finish(await nextPlay());
    await done;
    expect(fakeAri.calls.some(entry => entry.path.endsWith('/record'))).toBe(
      false
    );
    const user = await db
      .selectFrom('users')
      .select('mailboxAudioId')
      .where('id', '=', ownerId)
      .executeTakeFirstOrThrow();
    expect(user.mailboxAudioId).toBeNull();
    expect(call.log.finish().log).toContain(
      '"event":"mailboxGreeting","saved":false,"reason":"mediaFull"'
    );
  });

  it.each([
    ['refuses', true],
    ['records', false]
  ])(
    '*95<ext> 0 %s a ring group mailbox greeting with the media volume at MEDIA_STORAGE_MAX: %s (§11.6)',
    async (_label, full) => {
      pipeline.deps.mediaFull = () => Promise.resolve(full);
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
      await db
        .insertInto('ringGroupMembers')
        .values({ groupId, position: 0, userGroupId: null, userId: ownerId })
        .execute();
      const done = mailboxAccess(pipeline, call, '400');
      await nextPlay();
      press('0');
      finish(await nextPlay());
      let after: Play;
      if (full) {
        after = await nextPlay();
        expect(after.media).toBe('sound:vm-mailboxfull');
      } else {
        const record = await requestTo(
          fakeAri,
          'POST',
          `channels/${call.callerChannelId}/record`
        );
        fakeAri.emit({
          type: 'RecordingFinished',
          timestamp: nowIso(),
          application: 'zamfono',
          recording: {
            name: (record.body as { name: string }).name,
            duration: 4
          }
        });
        after = await nextPlay();
        expect(after.media).toBe('sound:vm-msgsaved');
      }
      finish(after);
      await nextPlay();
      press('#');
      finish(await nextPlay());
      await done;
      expect(fakeAri.calls.some(entry => entry.path.endsWith('/record'))).toBe(
        !full
      );
      const group = await db
        .selectFrom('ringGroups')
        .select('mailboxAudioId')
        .where('id', '=', groupId)
        .executeTakeFirstOrThrow();
      expect(group.mailboxAudioId === null).toBe(full);
    }
  );

  it('0 finishes a greeting whose recording started below the limit, though the volume reached it meanwhile', async () => {
    let full = false;
    pipeline.deps.mediaFull = () => Promise.resolve(full);
    const done = ownVoicemail(pipeline, call);
    await nextPlay();
    press('0');
    finish(await nextPlay());
    const record = await requestTo(
      fakeAri,
      'POST',
      `channels/${call.callerChannelId}/record`
    );
    full = true;
    const { name } = record.body as { name: string };
    fakeAri.emit({
      type: 'RecordingFinished',
      timestamp: nowIso(),
      application: 'zamfono',
      recording: { name, duration: 4 }
    });
    const saved = await nextPlay();
    expect(saved.media).toBe('sound:vm-msgsaved');
    finish(saved);
    await nextPlay();
    press('#');
    finish(await nextPlay());
    await done;
    const user = await db
      .selectFrom('users')
      .select('mailboxAudioId')
      .where('id', '=', ownerId)
      .executeTakeFirstOrThrow();
    expect(user.mailboxAudioId).toBe(name.replace('prompts/', ''));
  });

  it('a caller who hangs up to leave the menu is in the history as answered, not missed', async () => {
    const done = ownVoicemail(pipeline, call);
    await nextPlay();
    fakeAri.emit({
      type: 'ChannelDestroyed',
      timestamp: nowIso(),
      application: 'zamfono',
      channel: defaultChannel({ id: callerChannel(call) }),
      cause: 16
    });
    await done;
    const row = await db
      .selectFrom('calls')
      .select(['status', 'answeredAt', 'endedAt'])
      .where('id', '=', call.id)
      .executeTakeFirstOrThrow();
    expect(row.status).toBe('answered');
    expect(row.answeredAt).not.toBeNull();
    expect(row.endedAt).not.toBeNull();
  });

  it('three menus without a key in a row say goodbye and hang up', async () => {
    fakeAri.playbackFinishedAfterMs = 5;
    await ownVoicemail(pipeline, call);
    const media = fakeAri.calls
      .filter(
        entry =>
          entry.method === 'POST' &&
          entry.path === `channels/${call.callerChannelId}/play`
      )
      .map(entry => (entry.body as Play).media);
    expect(media).toEqual([
      [...introMedia('en', 0, 0), ...mainMenuMedia(0, 0)],
      mainMenuMedia(0, 0),
      mainMenuMedia(0, 0),
      'sound:vm-goodbye'
    ]);
    // Real 5 s key waits, three of them.
  }, 20_000);
});
