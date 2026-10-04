import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { newId, nowIso, type Db } from '@zamfono/shared';

import type { FakeAri } from '../testing/ari/fake.js';
import { noopCdr } from '../testing/pipelineDeps.js';
import { startRig, type Rig } from '../testing/pipelineRig.js';
import { seedAudioAsset } from '../testing/seedRows.js';
import { announce } from './announce.js';
import { newCall, type Call } from './call.js';
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

describe('announce', () => {
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

  it('answers, plays the announcement, then hangs up and finishes the call', async () => {
    const audioId = await seedAudioAsset(db, {
      label: 'Sorry',
      filename: 'sorry.wav'
    });
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

    await announce(pipeline, call, audioId);

    expect(call.status).toBe('answered');
    expect(call.answeredAt).not.toBeNull();
    expect(cdr.finished).toEqual([call]);

    const answered = fakeAri.calls.some(
      entry =>
        entry.method === 'POST' &&
        entry.path === `channels/${channel.id}/answer`
    );
    expect(answered).toBe(true);
    const playedIndex = fakeAri.calls.findIndex(
      entry =>
        entry.method === 'POST' && entry.path === `channels/${channel.id}/play`
    );
    const played = fakeAri.calls[playedIndex];
    expect((played?.body as { media?: string } | undefined)?.media).toBe(
      'sound:/media/prompts/sorry'
    );
    const hungUpIndex = fakeAri.calls.findIndex(
      entry =>
        entry.method === 'DELETE' && entry.path === `channels/${channel.id}`
    );
    expect(hungUpIndex).toBeGreaterThan(-1);
    // The announcement must have played to its end before the hangup (§10.1 step 6/7): the
    // playback's own `PlaybackFinished`, not just the play request, gates the hangup.
    expect(playedIndex).toBeLessThan(hungUpIndex);
  });
});
