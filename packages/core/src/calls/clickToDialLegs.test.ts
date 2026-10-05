import { afterEach, describe, expect, it } from 'vitest';

import { newId, nowIso, type LiveLeg } from '@zamfono/shared';
import { seedUser } from '@zamfono/shared/testDb.js';

import { contactEndpoint } from '../testing/ami/contacts.js';
import { defaultChannel } from '../testing/ari/fakeChannel.js';
import { eventually } from '../testing/eventually.js';
import { startRig, type Rig } from '../testing/pipelineRig.js';
import { seedRegisteredDevice } from '../testing/seedRows.js';
import { CallActions } from './actions.js';
import type { Call } from './call.js';
import { liveLegs } from './liveLegs.js';

// §10.2 "Click-to-dial", §10.3 "Live calls": the user's own phones are the call's calling side
// from the start, and the one that answers keeps its leg's id as the caller.

describe('click-to-dial live legs', () => {
  let rig: Rig;

  afterEach(async () => {
    await rig.stop();
  });

  /** The channel placed for `endpoint`, read from its create. */
  function channelOf(endpoint: string): string {
    const created = rig.fakeAri.calls.find(
      entry =>
        entry.path === 'channels/create' &&
        (entry.body as { endpoint?: string }).endpoint === endpoint
    );
    return (created?.body as { channelId?: string }).channelId ?? '';
  }

  function answer(channelId: string): void {
    rig.fakeAri.emit({
      type: 'ChannelStateChange',
      timestamp: nowIso(),
      application: 'zamfono',
      channel: defaultChannel({ id: channelId, state: 'Up' })
    });
  }

  function roles(call: Call): [LiveLeg['role'], LiveLeg['state']][] {
    return liveLegs(rig.state, call).map(leg => [leg.role, leg.state]);
  }

  it('lists the ringing phones as callers, the answering one keeping its id once the target rings and answers', async () => {
    rig = await startRig();
    rig.fakeAri.answerAfterMs = 60_000;
    const callerId = await seedUser(rig.db, { ext: '101' });
    await seedRegisteredDevice(rig, callerId, 'e101-a');
    await seedRegisteredDevice(rig, callerId, 'e101-b');
    const calleeId = await seedUser(rig.db, { ext: '102' });
    await seedRegisteredDevice(rig, calleeId, 'e102-a');
    await rig.devicesUp();
    const actions = new CallActions(rig.pipeline);

    const result = await actions.originate({
      userId: callerId,
      target: '102',
      actorUserId: newId(),
      requestId: 'req-1'
    });
    const callId = 'callId' in result ? result.callId : '';
    const call = rig.pipeline.channelless.get(callId);
    if (call === undefined) {
      throw new Error('no originated call');
    }

    const ringing = liveLegs(rig.state, call);
    expect(ringing.map(leg => [leg.role, leg.state, leg.userId])).toEqual([
      ['caller', 'ringing', callerId],
      ['caller', 'ringing', callerId]
    ]);
    const answering = call.legs.get(channelOf(contactEndpoint('e101-b')))?.id;
    expect(ringing.map(leg => leg.id)).toContain(answering);

    answer(channelOf(contactEndpoint('e101-b')));
    await eventually(() => {
      expect(roles(call)).toEqual([
        ['caller', 'ringing'],
        ['callee', 'ringing']
      ]);
    });
    const dialled = liveLegs(rig.state, call);
    expect(dialled[0]?.id).toBe(answering);
    expect(dialled[1]?.userId).toBe(calleeId);

    answer(channelOf(contactEndpoint('e102-a')));
    await eventually(() => {
      expect(roles(call)).toEqual([
        ['caller', 'up'],
        ['callee', 'up']
      ]);
    });
    expect(liveLegs(rig.state, call)[0]?.id).toBe(answering);
    await actions.hangup(callId, { actorUserId: newId() });
  });
});
