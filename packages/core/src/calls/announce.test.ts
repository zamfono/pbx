import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { newId, nowIso, openDb, type Db } from '@zamfono/shared';
import { migrateForTest } from '@zamfono/shared/testDb.js';

import { AriClient } from '../ari/client.js';
import { FakeAri } from '../ari/fake.js';
import {
  noopCdr,
  noopLogger,
  testPipelineDeps
} from '../testing/pipelineDeps.js';
import { announce } from './announce.js';
import { newCall, type Call } from './call.js';
import { Pipeline, type PipelineDeps } from './pipeline.js';

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

async function seedAudioAsset(db: Db, filename: string): Promise<string> {
  const id = newId();
  await db
    .insertInto('audioAssets')
    .values({
      id,
      label: 'Sorry',
      kind: 'announcement',
      filename,
      createdAt: nowIso()
    })
    .execute();
  return id;
}

describe('announce', () => {
  let db: Db;
  let fakeAri: FakeAri;
  let ari: AriClient;
  let cdr: PipelineDeps['cdr'] & { finished: Call[] };
  let pipeline: Pipeline;

  beforeEach(async () => {
    db = openDb(':memory:');
    await migrateForTest(db);
    await seedSettings(db);
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
    cdr = fakeCdr();
    pipeline = new Pipeline(testPipelineDeps(ari, db, { cdr }));
  });

  afterEach(async () => {
    await ari.close();
    await fakeAri.close();
    await db.destroy();
  });

  it('answers, plays the announcement, then hangs up and finishes the call', async () => {
    const audioId = await seedAudioAsset(db, 'sorry.wav');
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
