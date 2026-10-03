import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  HTTP_INTERNAL_SERVER_ERROR,
  newId,
  nowIso,
  type Db
} from '@zamfono/shared';

import type { AriClient } from '../ari/client.js';
import { AriError } from '../ari/types.js';
import type { FakeAri } from '../testing/ari/fake.js';
import { defaultChannel } from '../testing/ari/fakeChannel.js';
import { isPlacement } from '../testing/ari/fakeDial.js';
import { eventually, requestTo } from '../testing/eventually.js';
import { registerDevice } from '../testing/pipelineDeps.js';
import { startRig, type Rig } from '../testing/pipelineRig.js';
import { seedUser } from '../testing/seedRows.js';
import { newCall, type Call } from './call.js';
import { playMenu } from './menu.js';
import type { Pipeline } from './pipeline.js';
import { playAndWait } from './playback.js';

/** A caller who hangs up inside a menu, and a greeting Asterisk refuses to play (§10.1 step 6). */

/** A menu whose fallback is a user: applying it would ring that user's phones. */
async function seedMenu(db: Db, maxAttempts: number): Promise<string> {
  const audioId = newId();
  await db
    .insertInto('audioAssets')
    .values({
      id: audioId,
      label: 'Main menu',
      kind: 'announcement',
      filename: 'menu.wav',
      createdAt: nowIso()
    })
    .execute();
  const userId = await seedUser(db, { name: 'Reception' });
  await db
    .insertInto('devices')
    .values({
      id: newId(),
      userId,
      label: 'desk',
      kind: 'manual',
      sipUsername: 'e100-ddesk',
      sipPasswordEnc: Buffer.from('secret'),
      createdAt: nowIso()
    })
    .execute();
  const fallbackTargetId = newId();
  await db
    .insertInto('forwardTargets')
    .values({ id: fallbackTargetId, userId })
    .execute();
  const id = newId();
  await db
    .insertInto('menus')
    .values({
      id,
      name: `Menu ${id}`,
      audioId,
      fallbackTargetId,
      timeoutS: 1,
      maxAttempts,
      createdAt: nowIso()
    })
    .execute();
  return id;
}

function traceEvents(call: Call): string[] {
  return (call.log.finish().log ?? '')
    .split('\n')
    .map(line => (JSON.parse(line) as { event?: string }).event ?? '');
}

describe('menu hangup and a refused greeting', () => {
  let rig: Rig;
  let db: Db;
  let fakeAri: FakeAri;
  let ari: AriClient;
  let pipeline: Pipeline;

  beforeEach(async () => {
    rig = await startRig();
    ({ db, fakeAri, ari, pipeline } = rig);
    fakeAri.answerAfterMs = 60_000;
    // The greeting plays longer than the tests take, so the caller hangs up while it plays.
    fakeAri.playbackFinishedAfterMs = 200;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rig.stop();
  });

  function makeCall(channelId: string): Call {
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
    pipeline.registerCall(call);
    return call;
  }

  /** The caller hangs up: Asterisk drops the channel and reports it destroyed. */
  async function hangUp(channelId: string): Promise<void> {
    await ari.channels.hangup(channelId);
    fakeAri.emit({
      type: 'ChannelDestroyed',
      timestamp: nowIso(),
      application: 'zamfono',
      channel: defaultChannel({ id: channelId })
    });
  }

  function originates(): number {
    return fakeAri.calls.filter(entry => isPlacement(entry)).length;
  }

  it('runs no fallback for a caller who hung up during the last attempt', async () => {
    const menuId = await seedMenu(db, 1);
    const channel = fakeAri.addChannel({});
    const call = makeCall(channel.id);

    const played = playMenu(pipeline, call, menuId);
    // The caller hangs up while the menu's prompt plays.
    await requestTo(fakeAri, 'POST', `channels/${channel.id}/play`);
    await hangUp(channel.id);

    await expect(played).resolves.toBeUndefined();
    expect(originates()).toBe(0);
    expect(traceEvents(call)).not.toContain('menuFallback');
    expect(traceEvents(call)).toContain('menuHangup');
  });

  it('replays nothing for a caller who hung up with attempts left', async () => {
    const menuId = await seedMenu(db, 3);
    const channel = fakeAri.addChannel({});
    const call = makeCall(channel.id);

    const played = playMenu(pipeline, call, menuId);
    // The caller hangs up while the menu's prompt plays.
    await requestTo(fakeAri, 'POST', `channels/${channel.id}/play`);
    await hangUp(channel.id);

    await expect(played).resolves.toBeUndefined();
    const plays = fakeAri.calls.filter(
      entry =>
        entry.method === 'POST' && entry.path === `channels/${channel.id}/play`
    );
    expect(plays).toHaveLength(1);
    expect(originates()).toBe(0);
  });

  it('answers the caller before the greeting plays', async () => {
    // A trunk caller hears nothing of a greeting played into an unanswered channel, and cannot
    // key a choice into it: Asterisk sends no answer, so the provider keeps playing ringback.
    const menuId = await seedMenu(db, 1);
    const channel = fakeAri.addChannel({});
    const call = makeCall(channel.id);

    const played = playMenu(pipeline, call, menuId);
    await requestTo(fakeAri, 'POST', `channels/${channel.id}/play`);

    const requests = fakeAri.calls.map(
      entry => `${entry.method} ${entry.path}`
    );
    const answered = requests.indexOf(`POST channels/${channel.id}/answer`);
    expect(answered).toBeGreaterThanOrEqual(0);
    expect(answered).toBeLessThan(
      requests.indexOf(`POST channels/${channel.id}/play`)
    );
    await hangUp(channel.id);
    await played;
  });

  it('returns at once from a playback on a channel that is already gone', async () => {
    const channel = fakeAri.addChannel({});
    await ari.channels.hangup(channel.id);

    const end = playAndWait(ari, channel.id, 'sound:beep', `${channel.id}:p`);

    expect(await end).toBe('hangup');
  });

  it('starts the silence timer when Asterisk refuses to play the greeting', async () => {
    const menuId = await seedMenu(db, 1);
    await registerDevice(fakeAri, pipeline, 'e100-ddesk');
    const channel = fakeAri.addChannel({});
    const call = makeCall(channel.id);
    vi.spyOn(ari.channels, 'play').mockRejectedValue(
      new AriError(HTTP_INTERNAL_SERVER_ERROR, {
        message: 'Internal Server Error'
      })
    );

    const played = playMenu(pipeline, call, menuId);

    // One second of silence (`timeout_s`) ends the only attempt, and the fallback rings its user.
    await eventually(() => {
      expect(traceEvents(call)).toContain('menuFallback');
      expect(originates()).toBe(1);
    });
    await hangUp(channel.id);
    await played;
  });
});
