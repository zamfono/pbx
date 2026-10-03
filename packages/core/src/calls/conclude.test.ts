import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { newId, nowIso, type Db } from '@zamfono/shared';

import { SIT_DURATION_MS } from '../indications.js';
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

/**
 * Short-circuits `calls/playback.ts`'s `playToneAndWait` waiting out `SIT_DURATION_MS` for real
 * (§9.4 "Cross-trunk failover", `indications.ts`) — the pause before it stops the special
 * information tone — without touching any other timer. Global fake timers
 * (`vi.useFakeTimers`/`advanceTimersByTimeAsync`) were tried first, even restricted to just
 * `setTimeout`/`clearTimeout`, and made every ARI request hang instead: `AriClient`'s REST leg
 * (`ari/restTransport.ts`) is Node's global `fetch`, and undici's own connection bookkeeping runs
 * through that same faked `setTimeout`, so `channels.play`'s and `playbacks.stop`'s HTTP requests
 * never got flushed and their promises never settled. This instead spies on `setTimeout` itself
 * and reduces only a call for this exact delay to run on the next tick, leaving every other timer
 * — including the fake ARI's own and `fetch`'s — real and untouched.
 */
function skipSitWait(): () => void {
  const real = globalThis.setTimeout;
  const spy = vi
    .spyOn(globalThis, 'setTimeout')
    .mockImplementation(((
      fn: (...args: unknown[]) => void,
      ms?: number,
      ...args: unknown[]
    ) =>
      real(fn, ms === SIT_DURATION_MS ? 0 : ms, ...args)) as typeof setTimeout);
  return () => {
    spy.mockRestore();
  };
}

describe('concludeExhausted — failed-call announcement vs. special information tone (§9.4)', () => {
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

  it("plays the failed-call announcement's sound for a language whose prompt set has it", async () => {
    await db.updateTable('settings').set({ language: 'en' }).execute();
    const channel = fakeAri.addChannel({});
    const call = makeCall(channel.id);

    await concludeExhausted(pipeline, call, 'unreachable');

    expect(call.status).toBe('failed');
    expect(playedMedia(fakeAri, channel.id)).toBe(
      `sound:${PROMPTS.failedCall}`
    );
  });

  it("plays ITU-T E.180's special information tone for a language whose prompt set lacks the failed-call announcement", async () => {
    const restore = skipSitWait();
    try {
      await db.updateTable('settings').set({ language: 'de' }).execute();
      const channel = fakeAri.addChannel({});
      const call = makeCall(channel.id);

      await concludeExhausted(pipeline, call, 'unreachable');

      expect(call.status).toBe('failed');
      expect(playedMedia(fakeAri, channel.id)).toBe('tone:info;tonezone=itu');
      const stopped = fakeAri.calls.some(
        entry =>
          entry.method === 'DELETE' && entry.path.startsWith('playbacks/')
      );
      expect(stopped).toBe(true);
    } finally {
      restore();
    }
  });

  it('plays the same special information tone for another language whose prompt set lacks it', async () => {
    const restore = skipSitWait();
    try {
      await db.updateTable('settings').set({ language: 'ru' }).execute();
      const channel = fakeAri.addChannel({});
      const call = makeCall(channel.id);

      await concludeExhausted(pipeline, call, 'unreachable');

      expect(call.status).toBe('failed');
      expect(playedMedia(fakeAri, channel.id)).toBe('tone:info;tonezone=itu');
    } finally {
      restore();
    }
  });
});
