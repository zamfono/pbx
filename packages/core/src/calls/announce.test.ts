import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { newId, nowIso, type Db } from '@zamfono/shared';
import { seedUser } from '@zamfono/shared/testDb.js';

import type { FakeAri } from '../testing/ari/fake.js';
import { noopCdr } from '../testing/pipelineDeps.js';
import { startRig, type Rig } from '../testing/pipelineRig.js';
import { seedAudioAsset } from '../testing/seedRows.js';
import { newCall, type Call } from './call.js';
import { enterTarget } from './inbound.js';
import type { Pipeline } from './pipeline.js';
import type { PipelineDeps } from './pipelineDeps.js';

function fakeCdr(): PipelineDeps['cdr'] & { finished: Call[] } {
  const finished: Call[] = [];
  return {
    ...noopCdr(),
    finished,
    open: () => Promise.resolve(),
    finish: call => {
      finished.push(call);
      return Promise.resolve();
    }
  };
}

/** Whether the caller's channel `channelId` got the ARI request `action` (`answer`, `play`). */
function requested(
  fakeAri: FakeAri,
  channelId: string,
  action: string
): boolean {
  return fakeAri.calls.some(
    entry =>
      entry.method === 'POST' &&
      entry.path === `channels/${channelId}/${action}`
  );
}

describe("a target's announcement and the hangup kind (§10.1 step 7)", () => {
  let rig: Rig;
  let db: Db;
  let fakeAri: FakeAri;
  let cdr: PipelineDeps['cdr'] & { finished: Call[] };
  let pipeline: Pipeline;

  beforeEach(async () => {
    cdr = fakeCdr();
    rig = await startRig({ cdr });
    ({ db, fakeAri, pipeline } = rig);
  });

  afterEach(async () => {
    await rig.stop();
  });

  function inboundCall(): { call: Call; channelId: string } {
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
    return { call, channelId: channel.id };
  }

  it('answers, plays the announcement, then hangs up and finishes the call', async () => {
    const audioId = await seedAudioAsset(db, {
      label: 'Sorry',
      filename: 'sorry.wav'
    });
    const { call, channelId } = inboundCall();

    await enterTarget(
      pipeline,
      call,
      { kind: 'hangup', announcementAudioId: audioId },
      null
    );

    expect(call.status).toBe('answered');
    expect(call.answeredAt).not.toBeNull();
    expect(cdr.finished).toEqual([call]);

    expect(requested(fakeAri, channelId, 'answer')).toBe(true);
    const playedIndex = fakeAri.calls.findIndex(
      entry =>
        entry.method === 'POST' && entry.path === `channels/${channelId}/play`
    );
    const played = fakeAri.calls[playedIndex];
    expect((played?.body as { media?: string } | undefined)?.media).toBe(
      'sound:/media/prompts/sorry'
    );
    const hungUpIndex = fakeAri.calls.findIndex(
      entry =>
        entry.method === 'DELETE' && entry.path === `channels/${channelId}`
    );
    expect(hungUpIndex).toBeGreaterThan(-1);
    // The announcement must have played to its end before the hangup: the playback's own
    // `PlaybackFinished`, not just the play request, gates the hangup.
    expect(playedIndex).toBeLessThan(hungUpIndex);
  });

  it('releases a hangup target without an announcement unanswered, as missed', async () => {
    const { call, channelId } = inboundCall();

    await enterTarget(pipeline, call, { kind: 'hangup' }, null);

    expect(call.status).toBe('missed');
    expect(call.answeredAt).toBeNull();
    expect(requested(fakeAri, channelId, 'answer')).toBe(false);
    expect(requested(fakeAri, channelId, 'play')).toBe(false);
    expect(cdr.finished).toEqual([call]);
  });

  it('plays the announcement of a target of another kind, which then decides how the call ends', async () => {
    const audioId = await seedAudioAsset(db, {
      label: 'Welcome',
      filename: 'welcome.wav'
    });
    // No device and no mailbox: the user step releases the call as missed.
    const userId = await seedUser(db, { name: 'Anna', mailboxEnabled: 0 });
    const { call, channelId } = inboundCall();

    await enterTarget(
      pipeline,
      call,
      { kind: 'user', userId, announcementAudioId: audioId },
      null
    );

    expect(requested(fakeAri, channelId, 'play')).toBe(true);
    expect(call.calleeUserId).toBe(userId);
    expect(call.status).toBe('missed');
    expect(call.answeredAt).toBeNull();
  });
});
