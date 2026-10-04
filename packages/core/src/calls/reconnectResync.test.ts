import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { presenceHintDevice } from '@zamfono/shared';
import { seedUser } from '@zamfono/shared/testDb.js';

import { eventually } from '../testing/eventually.js';
import {
  answeredCall,
  legOf,
  startRig,
  type Rig
} from '../testing/pipelineRig.js';
import { seedSlot } from '../testing/seedRows.js';
import { resyncOnReconnect } from './reconnectResync.js';

// A start after the fake Asterisk's own `FAKE_ASTERISK_STARTUP_TIME`.
const RESTARTED_AT = '2026-09-29T09:00:00.000+0000';
const SLOT = '700';

describe('resyncOnReconnect', () => {
  let rig: Rig;

  beforeEach(async () => {
    rig = await startRig();
    await seedSlot(rig.db, SLOT);
    await rig.devicesUp();
  });

  afterEach(async () => {
    await rig.stop();
  });

  function reconnected(): Promise<void> {
    return new Promise(resolve => {
      rig.ari.once('connected', () => {
        resolve();
      });
    });
  }

  function slotResets(): number {
    const path = `deviceStates/${presenceHintDevice(SLOT)}`;
    return rig.fakeAri.calls.filter(
      entry => entry.method === 'PUT' && entry.path.startsWith(path)
    ).length;
  }

  it('ends a call whose channels a restarted Asterisk no longer holds, and resets the lamps', async () => {
    const { pipeline, presence, db, fakeAri } = rig;
    const userId = await seedUser(db);
    const call = await answeredCall(rig, userId);
    presence.setCallState(userId, 'inCall', null, null, call.id);
    const listeners = rig.ari.listenerCount('event');
    pipeline.deps.trunkState.watchInboundLeg(call.callerChannelId ?? '')(
      'trunk-1'
    );
    await resyncOnReconnect(pipeline);
    const resetsBefore = slotResets();

    const back = reconnected();
    fakeAri.restartAsterisk(RESTARTED_AT);
    await back;

    await eventually(async () => {
      expect(pipeline.callByChannel.size).toBe(0);
      const row = await db
        .selectFrom('calls')
        .select(['status', 'endedAt'])
        .where('id', '=', call.id)
        .executeTakeFirstOrThrow();
      expect(row.endedAt).not.toBeNull();
      expect(slotResets()).toBeGreaterThan(resetsBefore);
    });
    expect(presence.isInCall(userId)).toBe(false);
    expect(pipeline.deps.trunkState.activeChannels('trunk-1')).toBe(0);
    // The trunk leg's watch, waiting for the caller's `ChannelDestroyed`, ended with it.
    expect(rig.ari.listenerCount('event')).toBe(listeners);
  });

  it('keeps a call whose channels survived a reconnect to the same Asterisk', async () => {
    const { pipeline, db, fakeAri } = rig;
    const userId = await seedUser(db);
    const call = await answeredCall(rig, userId);
    await resyncOnReconnect(pipeline);
    const resetsBefore = slotResets();
    // A trunk leg that ended while the socket was down: its `ChannelDestroyed` never arrived.
    pipeline.deps.trunkState.watchInboundLeg('gone-channel')('trunk-1');

    const back = reconnected();
    fakeAri.disconnectClient();
    await back;

    await eventually(() => {
      expect(pipeline.deps.trunkState.activeChannels('trunk-1')).toBe(0);
    });
    expect(pipeline.callByChannel.get(legOf(call))).toBe(call);
    expect(slotResets()).toBe(resetsBefore);
  });

  it('keeps a call that started while the channel list was on its way', async () => {
    const { pipeline, db, fakeAri, ari } = rig;
    const userId = await seedUser(db);
    await resyncOnReconnect(pipeline);
    let started: Promise<string> | null = null;
    const list = ari.channels.list.bind(ari.channels);
    // Asterisk answers the list, then a new call comes up before the answer arrives.
    ari.channels.list = async () => {
      const answer = await list();
      started ??= answeredCall(rig, userId).then(legOf);
      await started;
      return answer;
    };

    const back = reconnected();
    fakeAri.disconnectClient();
    await back;
    await eventually(() => {
      expect(started).not.toBeNull();
    });
    const leg = await (started as unknown as Promise<string>);
    await new Promise(resolve => {
      setTimeout(resolve, 100);
    });

    expect(pipeline.callByChannel.has(leg)).toBe(true);
  });
});
