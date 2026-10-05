import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { newId, nowIso } from '@zamfono/shared';
import { seedUser } from '@zamfono/shared/testDb.js';

import { defaultChannel } from '../testing/ari/fakeChannel.js';
import { isPlacement } from '../testing/ari/fakeDial.js';
import { eventually } from '../testing/eventually.js';
import { registerDevice } from '../testing/pipelineDeps.js';
import { startRig, type Rig } from '../testing/pipelineRig.js';
import { seedDevice, seedRingGroup } from '../testing/seedRows.js';
import { newCall, type Call } from './call.js';
import { ringGroup } from './ringGroup.js';
import { runUserStep } from './userStep.js';

/** §9.3 "rings all registered devices": a device whose AOR holds several registered contacts (one
 * app on several phones) rings on every reachable one, each contact a leg of that device's, and
 * the first contact to answer wins the race as any device does. */

const PHONE = 'sip:e101-da@192.0.2.21:5060;ob';
const TABLET = 'sip:e101-da@192.0.2.22:5070;transport=tcp';
const GONE = 'sip:e101-da@192.0.2.23:5060';

describe('a device registered from several phones', () => {
  let rig: Rig;
  let call: Call;

  beforeEach(async () => {
    rig = await startRig();
    rig.fakeAri.answerAfterMs = 60_000;
    const callerChannel = rig.fakeAri.addChannel({
      caller: { number: '+15559999', name: '' }
    });
    call = newCall({
      id: newId(),
      direction: 'inbound',
      callerChannelId: callerChannel.id,
      from: '+15559999',
      to: '+15551234',
      startedAt: nowIso(),
      logLevel: 'events',
      callLogMaxBytes: 1_048_576
    });
    rig.pipeline.registerCall(call);
  });

  afterEach(async () => {
    await rig.stop();
  });

  /** One user with the device `e101-da`, registered from a phone, a tablet and an unreachable
   * third contact. */
  async function seedTwiceRegistered(): Promise<string> {
    const userId = await seedUser(rig.db, { name: 'Anna', ringTimeoutS: 20 });
    await seedDevice(rig.db, userId, 'e101-da');
    rig.contacts.contacts.set('e101-da', [
      { URI: PHONE, Status: 'Reachable' },
      { URI: TABLET, Status: 'NonQualified' },
      { URI: GONE, Status: 'Unreachable' }
    ]);
    await registerDevice(rig.fakeAri, rig.pipeline, 'e101-da');
    return userId;
  }

  function placed(): { endpoint: string; channelId: string }[] {
    return rig.fakeAri.calls
      .filter(entry => isPlacement(entry))
      .map(entry => entry.body as { endpoint: string; channelId: string });
  }

  function hungUp(channelId: string): boolean {
    return rig.fakeAri.calls.some(
      entry =>
        entry.method === 'DELETE' && entry.path === `channels/${channelId}`
    );
  }

  function answer(channelId: string): void {
    rig.fakeAri.emit({
      type: 'ChannelStateChange',
      timestamp: nowIso(),
      application: 'zamfono',
      channel: defaultChannel({ id: channelId, state: 'Up' })
    });
  }

  it("rings each reachable contact of the user's device; the one answering wins, the other is hung up", async () => {
    const userId = await seedTwiceRegistered();

    const step = runUserStep(
      rig.pipeline,
      call,
      await rig.pipeline.deps.cache.get(),
      userId
    );
    await eventually(() => {
      expect(
        [...call.legs.values()].filter(leg => leg.state === 'ringing')
      ).toHaveLength(2);
    });
    expect(placed().map(leg => leg.endpoint)).toEqual([
      `PJSIP/e101-da/${PHONE}`,
      `PJSIP/e101-da/${TABLET}`
    ]);
    const [phone, tablet] = placed().map(leg => leg.channelId);
    answer(tablet ?? '');
    await step;

    expect(call.answeredByUserId).toBe(userId);
    expect(call.legs.get(tablet ?? '')?.deviceId).toBeDefined();
    await eventually(() => {
      expect(hungUp(phone ?? '')).toBe(true);
    });
    expect(hungUp(tablet ?? '')).toBe(false);
  });

  it("rings each reachable contact of a ring-group member's device", async () => {
    const userId = await seedTwiceRegistered();
    const groupId = await seedRingGroup(rig.db, { strategy: 'simultaneous' });
    await rig.db
      .insertInto('ringGroupMembers')
      .values({ groupId, position: 0, userId, userGroupId: null })
      .execute();

    const finished = ringGroup(rig.pipeline, call, groupId);
    await eventually(() => {
      expect(placed()).toHaveLength(2);
    });
    expect(placed().map(leg => leg.endpoint)).toEqual([
      `PJSIP/e101-da/${PHONE}`,
      `PJSIP/e101-da/${TABLET}`
    ]);
    const [phone, tablet] = placed().map(leg => leg.channelId);
    answer(phone ?? '');
    await finished;

    expect(call.answeredByUserId).toBe(userId);
    await eventually(() => {
      expect(hungUp(tablet ?? '')).toBe(true);
    });
  });
});
