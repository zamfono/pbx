import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  newId,
  nowIso,
  type Db,
  type Envelope,
  type MailRequest
} from '@zamfono/shared';
import { seedUser } from '@zamfono/shared/testDb.js';

import type { AriClient } from '../ari/client.js';
import type { EventBus } from '../internal/eventBus.js';
import type { FakeAri } from '../testing/ari/fake.js';
import { defaultChannel } from '../testing/ari/fakeChannel.js';
import { onEvents } from '../testing/busEvents.js';
import { eventually, requestTo } from '../testing/eventually.js';
import { noopCdr, stubMailSender } from '../testing/pipelineDeps.js';
import { startRig, type Rig } from '../testing/pipelineRig.js';
import { seedAudioAsset } from '../testing/seedRows.js';
import { newCall, type Call } from './call.js';
import type { Pipeline } from './pipeline.js';
import type { PipelineDeps } from './pipelineDeps.js';
import { deposit, type MailSender } from './voicemail.js';

const VOICEMAIL_MAX_S = 120;

type FakeCdr = PipelineDeps['cdr'] & {
  finished: Call[];
  // Each `finish`'s status as written, which a later write to the same `Call` cannot rewrite.
  statuses: (Call['status'] | null)[];
};

function fakeCdr(): FakeCdr {
  const finished: Call[] = [];
  const statuses: (Call['status'] | null)[] = [];
  const done = new Set<string>();
  return {
    ...noopCdr(),
    finished,
    statuses,
    open: () => Promise.resolve(),
    // Writes once per call, like `CdrWriter.finish`.
    finish: call => {
      if (!done.has(call.id)) {
        done.add(call.id);
        finished.push(call);
        statuses.push(call.status);
      }
      return Promise.resolve();
    }
  };
}

describe('deposit', () => {
  let rig: Rig;
  let db: Db;
  let fakeAri: FakeAri;
  let ari: AriClient;
  let cdr: FakeCdr;
  let bus: EventBus;
  let apiClient: MailSender & { sent: MailRequest[] };
  let pipeline: Pipeline;

  beforeEach(async () => {
    cdr = fakeCdr();
    apiClient = stubMailSender();
    rig = await startRig({ cdr, apiClient });
    ({ db, fakeAri, ari, bus, pipeline } = rig);
    await db
      .updateTable('settings')
      .set({ voicemailMaxS: VOICEMAIL_MAX_S })
      .execute();
  });

  afterEach(async () => {
    await rig.stop();
  });

  it('keeps a message the caller ended by hanging up', async () => {
    const userId = await seedUser(db);
    const channel = fakeAri.addChannel({});
    const call = newCall({
      id: newId(),
      direction: 'inbound',
      callerChannelId: channel.id,
      from: '+15559999',
      to: '+15551000',
      startedAt: nowIso(),
      logLevel: 'events',
      callLogMaxBytes: 1_048_576
    });

    const started = deposit(pipeline, call, { userId });
    const recordCall = await requestTo(
      fakeAri,
      'POST',
      `channels/${channel.id}/record`
    );
    const recordingName = (recordCall.body as { name: string }).name;

    // Hanging up is how a caller ends a message: Asterisk stops the recording as the channel
    // goes, so `RecordingFinished` follows `ChannelDestroyed` rather than preceding it.
    fakeAri.emit({
      type: 'ChannelDestroyed',
      timestamp: nowIso(),
      application: 'zamfono',
      channel: { id: channel.id }
    });
    fakeAri.emit({
      type: 'RecordingFinished',
      timestamp: nowIso(),
      application: 'zamfono',
      recording: { name: recordingName, duration: 7 }
    });
    await started;

    expect(call.status).toBe('voicemail');
    const row = await db
      .selectFrom('voicemails')
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(row.durationS).toBe(7);
  });

  it('records the caller with the configured cap and emits voicemail.new plus a mail request', async () => {
    const userId = await seedUser(db);
    const channel = fakeAri.addChannel({});
    const call = newCall({
      id: newId(),
      direction: 'inbound',
      callerChannelId: channel.id,
      from: '+15559999',
      to: '+15551000',
      startedAt: nowIso(),
      logLevel: 'events',
      callLogMaxBytes: 1_048_576
    });
    const envelopes: Envelope[] = [];
    onEvents(bus, envelope => {
      envelopes.push(envelope);
    });

    const started = deposit(pipeline, call, { userId });
    const recordCall = await requestTo(
      fakeAri,
      'POST',
      `channels/${channel.id}/record`
    );
    expect(recordCall).toBeDefined();
    expect(recordCall.body).toMatchObject({
      format: 'wav',
      maxDurationSeconds: VOICEMAIL_MAX_S,
      maxSilenceSeconds: 5,
      terminateOn: '#'
    });
    // The greeting must have played to the end before recording starts (§10.2 "Voicemail"),
    // never overlapping it.
    const greetingPlay = fakeAri.calls.findIndex(
      entry =>
        entry.method === 'POST' && entry.path === `channels/${channel.id}/play`
    );
    const recordIndex = fakeAri.calls.findIndex(
      entry =>
        entry.method === 'POST' &&
        entry.path === `channels/${channel.id}/record`
    );
    expect(greetingPlay).toBeGreaterThanOrEqual(0);
    expect(greetingPlay).toBeLessThan(recordIndex);
    const recordingName = (recordCall.body as { name: string }).name;
    // The recording spool directory landing in the shared /media volume (§11.6) is the asterisk
    // image's own job; this is core's side of that path.
    expect(recordingName).toMatch(/^voicemail\//u);

    fakeAri.emit({
      type: 'RecordingFinished',
      timestamp: nowIso(),
      application: 'zamfono',
      recording: { name: recordingName, duration: 12 }
    });
    await started;

    expect(call.status).toBe('voicemail');
    const row = await db
      .selectFrom('voicemails')
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(row.mailboxUserId).toBe(userId);
    expect(row.durationS).toBe(12);
    expect(row.caller).toBe('+15559999');
    expect(recordingName).toBe(`voicemail/${row.id}`);

    const mwiCall = fakeAri.calls.find(
      entry => entry.method === 'PUT' && entry.path.startsWith('mailboxes/')
    );
    expect(mwiCall?.path).toContain(userId);
    expect(mwiCall?.body).toEqual({ oldMessages: 0, newMessages: 1 });

    const voicemailEvent = envelopes.find(
      envelope => envelope.type === 'voicemail.new'
    );
    expect(voicemailEvent).toMatchObject({
      type: 'voicemail.new',
      mailbox: `user:${userId}`
    });

    // The goodbye plays, and only then does the caller's channel get hung up.
    const playIndices = fakeAri.calls
      .map((entry, index) => ({ entry, index }))
      .filter(
        ({ entry }) =>
          entry.method === 'POST' &&
          entry.path === `channels/${channel.id}/play`
      )
      .map(({ index }) => index);
    expect(playIndices).toHaveLength(2);
    const hangupIndex = fakeAri.calls.findIndex(
      entry =>
        entry.method === 'DELETE' && entry.path === `channels/${channel.id}`
    );
    expect(playIndices[1]).toBeLessThan(hangupIndex);

    expect(apiClient.sent).toHaveLength(1);
    expect(apiClient.sent[0]).toMatchObject({
      kind: 'voicemail',
      // §7: the call's id travels with the request, for the log lines of its send.
      callId: call.id,
      to: { userId },
      values: { callerName: '' },
      filename: row.filename
    });
    expect(cdr.finished).toEqual([call]);
  });

  it('sends the phone book display name as callerName for a known caller', async () => {
    const userId = await seedUser(db);
    const contactId = newId();
    await db
      .insertInto('contacts')
      .values({
        id: contactId,
        displayName: 'Anna Huber',
        createdAt: nowIso(),
        updatedAt: nowIso()
      })
      .execute();
    await db
      .insertInto('contactPhones')
      .values({ contactId, label: 'mobile', number: '+15559999' })
      .execute();
    const channel = fakeAri.addChannel({});
    const call = newCall({
      id: newId(),
      direction: 'inbound',
      callerChannelId: channel.id,
      from: '+15559999',
      to: '+15551000',
      startedAt: nowIso(),
      logLevel: 'events',
      callLogMaxBytes: 1_048_576
    });

    const started = deposit(pipeline, call, { userId });
    const recordCall = await requestTo(
      fakeAri,
      'POST',
      `channels/${channel.id}/record`
    );
    fakeAri.emit({
      type: 'RecordingFinished',
      timestamp: nowIso(),
      application: 'zamfono',
      recording: { name: (recordCall.body as { name: string }).name }
    });
    await started;

    expect(apiClient.sent[0]).toMatchObject({
      values: { callerName: 'Anna Huber' }
    });
  });

  it("plays the mailbox's own greeting instead of the language default when mailbox_audio_id is set", async () => {
    const audioId = await seedAudioAsset(db, {
      label: 'Mailbox greeting',
      kind: 'vmGreeting',
      filename: 'mailbox.wav'
    });
    const userId = await seedUser(db, { mailboxAudioId: audioId });
    const channel = fakeAri.addChannel({});
    const call = newCall({
      id: newId(),
      direction: 'inbound',
      callerChannelId: channel.id,
      from: '+15559999',
      to: '+15551000',
      startedAt: nowIso(),
      logLevel: 'events',
      callLogMaxBytes: 1_048_576
    });

    const started = deposit(pipeline, call, { userId });
    // Recording starts only once the greeting played to the end, so by the record request the
    // greeting's own play request has landed.
    const recordCall = await requestTo(
      fakeAri,
      'POST',
      `channels/${channel.id}/record`
    );
    const greetingPlay = fakeAri.calls.find(
      entry =>
        entry.method === 'POST' && entry.path === `channels/${channel.id}/play`
    );
    expect(greetingPlay?.body).toMatchObject({
      media: 'sound:/media/prompts/mailbox'
    });

    fakeAri.emit({
      type: 'RecordingFinished',
      timestamp: nowIso(),
      application: 'zamfono',
      recording: { name: (recordCall.body as { name: string }).name }
    });
    await started;
  });

  it('releases the caller and persists nothing when the recording fails', async () => {
    const userId = await seedUser(db);
    const channel = fakeAri.addChannel({});
    const call = newCall({
      id: newId(),
      direction: 'inbound',
      callerChannelId: channel.id,
      from: '+15559999',
      to: '+15551000',
      startedAt: nowIso(),
      logLevel: 'events',
      callLogMaxBytes: 1_048_576
    });

    const started = deposit(pipeline, call, { userId });
    const recordCall = await requestTo(
      fakeAri,
      'POST',
      `channels/${channel.id}/record`
    );
    fakeAri.emit({
      type: 'RecordingFailed',
      timestamp: nowIso(),
      application: 'zamfono',
      recording: { name: (recordCall.body as { name: string }).name }
    });
    await started;

    expect(call.status).toBe('failed');
    const rows = await db.selectFrom('voicemails').selectAll().execute();
    expect(rows).toHaveLength(0);
    expect(apiClient.sent).toHaveLength(0);
    const mwiCall = fakeAri.calls.find(
      entry => entry.method === 'PUT' && entry.path.startsWith('mailboxes/')
    );
    expect(mwiCall).toBeUndefined();
    expect(cdr.finished).toEqual([call]);
  });

  it('records a caller who hangs up mid-recording without a message as missed, persisting nothing', async () => {
    const userId = await seedUser(db);
    const channel = fakeAri.addChannel({});
    const call = newCall({
      id: newId(),
      direction: 'inbound',
      callerChannelId: channel.id,
      from: '+15559999',
      to: '+15551000',
      startedAt: nowIso(),
      logLevel: 'events',
      callLogMaxBytes: 1_048_576
    });

    const started = deposit(pipeline, call, { userId });
    await requestTo(fakeAri, 'POST', `channels/${channel.id}/record`);
    // Asterisk emits `ChannelDestroyed` once for the whole channel; the greeting's own
    // `playAndWait` has already resolved by this point, so this is the recording wait's own turn
    // to see it.
    fakeAri.emit({
      type: 'ChannelDestroyed',
      timestamp: nowIso(),
      application: 'zamfono',
      channel: defaultChannel({ id: channel.id })
    });
    await started;

    expect(call.status).toBe('missed');
    const rows = await db.selectFrom('voicemails').selectAll().execute();
    expect(rows).toHaveLength(0);
    expect(apiClient.sent).toHaveLength(0);
    expect(cdr.finished).toEqual([call]);
  });

  /** An inbound call to `userId`, registered with the pipeline like every live call, so the
   * caller's own `ChannelDestroyed` reaches `legsEnded.ts` as well as the deposit. */
  function registeredCall(channelId: string, userId: string): Call {
    const call = newCall({
      id: newId(),
      direction: 'inbound',
      callerChannelId: channelId,
      from: '+15559999',
      to: '+15551000',
      startedAt: nowIso(),
      logLevel: 'events',
      callLogMaxBytes: 1_048_576
    });
    call.calleeUserId = userId;
    pipeline.registerCall(call);
    return call;
  }

  it('closes a call whose caller hung up to end the message as voicemail, with the voicemail mail only (§10.2 "Mail")', async () => {
    const userId = await seedUser(db, { notifyMissedCalls: 1 });
    const channel = fakeAri.addChannel({});
    const call = registeredCall(channel.id, userId);

    const started = deposit(pipeline, call, { userId });
    const recordCall = await requestTo(
      fakeAri,
      'POST',
      `channels/${channel.id}/record`
    );
    fakeAri.emit({
      type: 'ChannelDestroyed',
      timestamp: nowIso(),
      application: 'zamfono',
      channel: defaultChannel({ id: channel.id })
    });
    // The caller's own end has run before Asterisk reports the finalised recording.
    await eventually(() => {
      expect(call.callerEnded).toBe(true);
    });
    expect(cdr.finished).toHaveLength(0);
    fakeAri.emit({
      type: 'RecordingFinished',
      timestamp: nowIso(),
      application: 'zamfono',
      recording: {
        name: (recordCall.body as { name: string }).name,
        duration: 4
      }
    });
    await started;

    expect(cdr.statuses).toEqual(['voicemail']);
    expect(apiClient.sent.map(request => request.kind)).toEqual(['voicemail']);
    const rows = await db.selectFrom('voicemails').selectAll().execute();
    expect(rows).toHaveLength(1);
  });

  it('closes a registered call whose caller hung up without a message as missed, with the missed-call mail', async () => {
    const userId = await seedUser(db, { notifyMissedCalls: 1 });
    const channel = fakeAri.addChannel({});
    const call = registeredCall(channel.id, userId);

    const started = deposit(pipeline, call, { userId });
    await requestTo(fakeAri, 'POST', `channels/${channel.id}/record`);
    // The caller's BYE: Asterisk's own hangup request, not the core's (soft) one.
    fakeAri.emit({
      type: 'ChannelHangupRequest',
      timestamp: nowIso(),
      application: 'zamfono',
      channel: defaultChannel({ id: channel.id }),
      cause: 16
    });
    fakeAri.emit({
      type: 'ChannelDestroyed',
      timestamp: nowIso(),
      application: 'zamfono',
      channel: defaultChannel({ id: channel.id })
    });
    await started;

    expect(call.log.finish().log).toContain(
      `"event":"voicemailFailed","mailbox":{"userId":"${userId}"},"reason":"callerHungUp"`
    );
    expect(cdr.statuses).toEqual(['missed']);
    expect(apiClient.sent.map(request => request.kind)).toEqual(['missedCall']);
    const rows = await db.selectFrom('voicemails').selectAll().execute();
    expect(rows).toHaveLength(0);
  });

  it('closes a call whose caller hung up during the greeting at once, as missed', async () => {
    const userId = await seedUser(db, { notifyMissedCalls: 1 });
    const channel = fakeAri.addChannel({});
    const call = registeredCall(channel.id, userId);

    const started = deposit(pipeline, call, { userId });
    await requestTo(fakeAri, 'POST', `channels/${channel.id}/play`);
    // Asterisk reports the greeting as finished (failed) as the channel goes, before its
    // `ChannelDestroyed`, so the record request is what meets the channel already gone.
    await ari.channels.hangup(channel.id);
    fakeAri.emit({
      type: 'PlaybackFinished',
      timestamp: nowIso(),
      application: 'zamfono',
      playback: { id: `${channel.id}:vmGreeting`, state: 'failed' }
    });
    fakeAri.emit({
      type: 'ChannelDestroyed',
      timestamp: nowIso(),
      application: 'zamfono',
      channel: defaultChannel({ id: channel.id })
    });
    await started;

    expect(cdr.statuses).toEqual(['missed']);
    expect(apiClient.sent.map(request => request.kind)).toEqual(['missedCall']);
  });
});
