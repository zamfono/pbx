import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LANGUAGES, newId, nowIso, type Db } from '@zamfono/shared';

import { PROMPTS } from '../prompts.js';
import type { FakeAri } from '../testing/ari/fake.js';
import { startRig, type Rig } from '../testing/pipelineRig.js';
import { newCall, type Call } from './call.js';
import { concludeExhausted } from './conclude.js';
import type { Pipeline } from './pipeline.js';

function playedMedia(fakeAri: FakeAri, channelId: string): string | undefined {
  const played = fakeAri.calls.find(
    entry =>
      entry.method === 'POST' && entry.path === `channels/${channelId}/play`
  );
  return (played?.body as { media?: string } | undefined)?.media;
}

describe('concludeExhausted — the failed-call announcement (§9.4)', () => {
  let rig: Rig;
  let db: Db;
  let fakeAri: FakeAri;
  let pipeline: Pipeline;

  beforeEach(async () => {
    rig = await startRig();
    ({ db, fakeAri, pipeline } = rig);
  });

  afterEach(async () => {
    await rig.stop();
  });

  function makeCall(channelId: string): Call {
    return newCall({
      id: newId(),
      direction: 'outbound',
      callerChannelId: channelId,
      from: '+15551000',
      to: '+498912345',
      startedAt: nowIso(),
      logLevel: 'events',
      callLogMaxBytes: 1_048_576
    });
  }

  it.each(LANGUAGES)(
    "plays the failed-call announcement's sound for %s, every language's set having it",
    async language => {
      await db.updateTable('settings').set({ language }).execute();
      const channel = fakeAri.addChannel({});
      const call = makeCall(channel.id);

      await concludeExhausted(pipeline, call, 'unreachable');

      expect(call.status).toBe('failed');
      expect(playedMedia(fakeAri, channel.id)).toBe(
        `sound:${PROMPTS.failedCall}`
      );
    }
  );
});
