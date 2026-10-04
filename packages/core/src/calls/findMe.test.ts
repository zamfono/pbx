import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { newId, nowIso, type Db } from '@zamfono/shared';
import { seedUser } from '@zamfono/shared/testDb.js';

import type { AriClient } from '../ari/client.js';
import type { Channel } from '../ari/types.js';
import { AST_CAUSE_NORMAL_CLEARING } from '../sipCodes.js';
import type { FakeAri } from '../testing/ari/fake.js';
import { defaultChannel } from '../testing/ari/fakeChannel.js';
import { eventually } from '../testing/eventually.js';
import { registerDevice } from '../testing/pipelineDeps.js';
import { startRig, type Rig } from '../testing/pipelineRig.js';
import { seedDevice, seedRoute, seedTrunk } from '../testing/seedRows.js';
import { newCall, type Call } from './call.js';
import type { Pipeline } from './pipeline.js';
import { ringUser } from './ringUser.js';

const FIND_ME_NUMBER = '+15557000';

/** A user with one device, unregistered, and one find-me entry `delayS` seconds into the ring. */
async function seedFindMeUser(rig: Rig, delayS: number): Promise<string> {
  const id = await seedUser(rig.db, {
    name: 'Member',
    mailboxEnabled: 0,
    ringTimeoutS: 30,
    findMeJson: JSON.stringify([{ number: FIND_ME_NUMBER, delayS }])
  });
  await seedDevice(rig.db, id, 'e101-d1');
  return id;
}

describe('a find-me leg still to come (§10.1 step 4)', () => {
  let rig: Rig;
  let db: Db;
  let fakeAri: FakeAri;
  let ari: AriClient;
  let pipeline: Pipeline;
  let callerChannel: Channel;
  let call: Call;

  function destroy(channelId: string, cause: number): void {
    fakeAri.emit({
      type: 'ChannelDestroyed',
      timestamp: nowIso(),
      application: 'zamfono',
      channel: defaultChannel({ id: channelId, state: 'Down' }),
      cause
    });
  }

  /** The channel the fake originated to `endpoint` (the fake names a channel after its endpoint). */
  async function channelTo(endpoint: string): Promise<Channel> {
    const channel = (await ari.channels.list()).find(
      entry => entry.name === endpoint
    );
    if (!channel) {
      throw new Error(`no channel originated to ${endpoint}`);
    }
    return channel;
  }

  beforeEach(async () => {
    rig = await startRig();
    ({ db, fakeAri, ari, pipeline } = rig);
    fakeAri.answerAfterMs = 60_000;
    callerChannel = fakeAri.addChannel({
      caller: { number: '+15559999', name: '' }
    });
    call = newCall({
      id: newId(),
      direction: 'inbound',
      callerChannelId: callerChannel.id,
      from: '+15559999',
      to: '+15551000',
      startedAt: nowIso(),
      logLevel: 'events',
      callLogMaxBytes: 1_048_576
    });
    pipeline.registerCall(call);
  });

  afterEach(async () => {
    await rig.stop();
  });

  it('keeps the race open after the last device leg ends, and still rings the find-me number', async () => {
    const userId = await seedFindMeUser(rig, 1);
    await registerDevice(fakeAri, pipeline, 'e101-d1');
    const trunkId = await seedTrunk(db);
    await seedRoute(db, trunkId);

    const finished = ringUser(pipeline, call, userId);
    await eventually(() => {
      expect([...call.legs.values()].map(leg => leg.state)).toEqual([
        'ringing'
      ]);
    });
    destroy((await channelTo('PJSIP/e101-d1')).id, AST_CAUSE_NORMAL_CLEARING);

    const findMeEndpoint = `PJSIP/${FIND_ME_NUMBER}@trunk-${trunkId}`;
    const findMe = await eventually(() => channelTo(findMeEndpoint), 3000);
    expect(pipeline.pendingRing.has(call.id)).toBe(true);
    destroy(findMe.id, AST_CAUSE_NORMAL_CLEARING);
    await finished;

    expect(call.status).toBe('missed');
    expect(pipeline.pendingRing.has(call.id)).toBe(false);
  });

  it('settles the race once a find-me leg that could not be routed was the last one to come', async () => {
    const userId = await seedFindMeUser(rig, 1);
    await registerDevice(fakeAri, pipeline, 'e101-d1');

    const finished = ringUser(pipeline, call, userId);
    await eventually(() => {
      expect([...call.legs.values()].map(leg => leg.state)).toEqual([
        'ringing'
      ]);
    });
    destroy((await channelTo('PJSIP/e101-d1')).id, AST_CAUSE_NORMAL_CLEARING);
    await eventually(() => {
      expect([...call.legs.values()].map(leg => leg.state)).toEqual(['ended']);
    });
    expect(pipeline.pendingRing.has(call.id)).toBe(true);
    await finished;

    expect(call.status).toBe('missed');
  });
});
