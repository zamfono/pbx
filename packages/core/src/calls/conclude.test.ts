import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { newId, nowIso, openDb, type Db } from '@zamfono/shared';
import { migrateForTest } from '@zamfono/shared/testDb.js';

import { AriClient } from '../ari/client.js';
import { FakeAri } from '../ari/fake.js';
import { SIT_DURATION_MS } from '../indications.js';
import { PROMPTS } from '../prompts.js';
import { noopLogger, testPipelineDeps } from '../testing/pipelineDeps.js';
import { newCall, type Call } from './call.js';
import { concludeExhausted } from './conclude.js';
import { Pipeline } from './pipeline.js';

/** A throwaway forward-target/DID chain, just to satisfy `settings.main_did_id`'s FK. */
async function seedSettings(
  db: Db,
  overrides: { language?: string } = {}
): Promise<void> {
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
      ...(overrides.language === undefined
        ? {}
        : { language: overrides.language }),
      emergencyNumbersJson: '["112"]'
    })
    .execute();
}

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
  let db: Db;
  let fakeAri: FakeAri;
  let ari: AriClient;
  let pipeline: Pipeline;

  beforeEach(async () => {
    db = openDb(':memory:');
    await migrateForTest(db);
    fakeAri = new FakeAri();
    const { url } = await fakeAri.listen();
    ari = new AriClient({
      url,
      user: 'zamfono',
      password: 'secret',
      app: 'zamfono',
      log: noopLogger
    });
    await ari.connect();
    pipeline = new Pipeline(testPipelineDeps(ari, db));
  });

  afterEach(async () => {
    await ari.close();
    await fakeAri.close();
    await db.destroy();
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
    await seedSettings(db, { language: 'en' });
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
      await seedSettings(db, { language: 'de' });
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
      await seedSettings(db, { language: 'ru' });
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
