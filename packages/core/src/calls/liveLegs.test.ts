import { afterEach, describe, expect, it } from 'vitest';

import {
  HTTP_CONFLICT,
  HTTP_NOT_FOUND,
  newId,
  type LiveLeg
} from '@zamfono/shared';
import { seedUser } from '@zamfono/shared/testDb.js';

import type { FakeAri } from '../testing/ari/fake.js';
import { eventually } from '../testing/eventually.js';
import {
  answeredCall,
  legOf,
  startRig,
  type Rig
} from '../testing/pipelineRig.js';
import { seedSlot, seedUserWithDevice } from '../testing/seedRows.js';
import { CallActions } from './actions.js';
import { callerChannel, type Call } from './call.js';
import { liveLegs } from './liveLegs.js';

// §10.3 "Live calls": a live call's legs under the core's own ids, and the actions that name one
// (`legId`), so an admin who is not in the call acts on the leg they mean.

describe('live legs', () => {
  let rig: Rig;
  let fakeAri: FakeAri;
  let actions: CallActions;
  const admin = newId();

  async function setUp(): Promise<void> {
    rig = await startRig();
    ({ fakeAri } = rig);
    actions = new CallActions(rig.pipeline);
  }

  afterEach(async () => {
    await rig.stop();
  });

  function legsOf(call: Call): LiveLeg[] {
    return liveLegs(rig.state, call);
  }

  function legIdOf(call: Call, role: LiveLeg['role']): string {
    const leg = legsOf(call).find(candidate => candidate.role === role);
    if (leg === undefined) {
      throw new Error(`no ${role} leg`);
    }
    return leg.id;
  }

  async function refusal(promise: Promise<unknown>): Promise<unknown> {
    return promise.then(
      () => null,
      (error: unknown) => {
        const { status, reason } = error as { status: number; reason: string };
        return { status, reason };
      }
    );
  }

  it('lists the caller and the answered leg under ids of its own, never the channel', async () => {
    await setUp();
    const member = await seedUser(rig.db, { ext: '101' });
    const call = await answeredCall(rig, member);
    call.callerTrunkId = 'trunk-1';

    const legs = legsOf(call);
    expect(legs).toEqual([
      {
        id: call.callerLegId,
        role: 'caller',
        state: 'up',
        trunkId: 'trunk-1'
      },
      {
        id: call.legs.get(legOf(call))?.id,
        role: 'callee',
        state: 'up',
        userId: member
      }
    ]);
    expect(legs.map(leg => leg.id)).not.toContain(call.callerChannelId);
    expect(legs.map(leg => leg.id)).not.toContain(legOf(call));
  });

  it('shows the leg a hold names as held, the call’s state going out again', async () => {
    await setUp();
    const member = await seedUserWithDevice(rig, '101');
    await rig.devicesUp();
    const call = await answeredCall(rig, member);
    const callee = legIdOf(call, 'callee');

    await actions.hold(call.id, { actorUserId: admin, legId: callee });

    expect(
      fakeAri.calls.some(
        entry =>
          entry.method === 'POST' &&
          entry.path === `channels/${legOf(call)}/moh`
      )
    ).toBe(true);
    expect(legsOf(call).map(leg => [leg.role, leg.state])).toEqual([
      ['caller', 'up'],
      ['callee', 'held']
    ]);
  });

  it('transfers the named caller leg for an admin not in the call, releasing the other side', async () => {
    await setUp();
    const member = await seedUserWithDevice(rig, '101');
    await seedUserWithDevice(rig, '102');
    await rig.devicesUp();
    const call = await answeredCall(rig, member);
    const callerId = callerChannel(call);

    await actions.transfer(call.id, {
      target: '102',
      actorUserId: admin,
      legId: legIdOf(call, 'caller')
    });

    expect(rig.hungUp(legOf(call))).toBe(true);
    expect(rig.hungUp(callerId)).toBe(false);
    const child = rig.pipeline.callByChannel.get(callerId);
    expect(child?.parentCallId).toBe(call.id);
  });

  it('transfers the named callee leg, the caller being the side released', async () => {
    await setUp();
    const member = await seedUserWithDevice(rig, '101');
    await seedUserWithDevice(rig, '102');
    await rig.devicesUp();
    const call = await answeredCall(rig, member);
    const calleeChannel = legOf(call);

    await actions.transfer(call.id, {
      target: '102',
      actorUserId: admin,
      legId: legIdOf(call, 'callee')
    });

    expect(rig.hungUp(callerChannel(call))).toBe(true);
    expect(rig.hungUp(calleeChannel)).toBe(false);
    await eventually(() => {
      expect(rig.pipeline.callByChannel.get(calleeChannel)?.parentCallId).toBe(
        call.id
      );
    });
  });

  it('refuses a leg the call does not hold with 404, and a ringing one with 409', async () => {
    await setUp();
    const member = await seedUser(rig.db, { ext: '101' });
    const call = await answeredCall(rig, member);
    const ringing = fakeAri.addChannel({});
    call.legs.set(ringing.id, {
      id: newId(),
      channelId: ringing.id,
      kind: 'device',
      userId: member,
      state: 'ringing',
      endCause: null
    });
    const ringingId = call.legs.get(ringing.id)?.id ?? '';

    expect(
      await refusal(
        actions.transfer(call.id, {
          target: '102',
          actorUserId: admin,
          legId: newId()
        })
      )
    ).toEqual({ status: HTTP_NOT_FOUND, reason: 'legNotFound' });
    expect(
      await refusal(
        actions.hold(call.id, { actorUserId: admin, legId: ringingId })
      )
    ).toEqual({ status: HTTP_CONFLICT, reason: 'legNotUp' });
  });

  it('parks the named leg by its other side, and refuses one whose other side is no user', async () => {
    await setUp();
    await seedSlot(rig.db, '701');
    const member = await seedUser(rig.db, { ext: '101' });
    const call = await answeredCall(rig, member);

    expect(
      await refusal(
        actions.park(call.id, {
          userId: admin,
          actorUserId: admin,
          legId: legIdOf(call, 'callee')
        })
      )
    ).toEqual({ status: HTTP_CONFLICT, reason: 'noParker' });
    const result = await actions.park(call.id, {
      userId: admin,
      actorUserId: admin,
      legId: legIdOf(call, 'caller')
    });

    expect(result).toEqual({ slot: '701' });
    expect(rig.hungUp(legOf(call))).toBe(true);
    expect((await actions.parked()).parked[0]?.parkedByUserId).toBe(member);
  });

  it('hangs up the named leg alone', async () => {
    await setUp();
    const member = await seedUser(rig.db, { ext: '101' });
    const call = await answeredCall(rig, member);

    await actions.hangup(call.id, {
      actorUserId: admin,
      legId: legIdOf(call, 'callee')
    });

    expect(rig.hungUp(legOf(call))).toBe(true);
  });
});
