// Test-only: a call brought to one stage of its life among phones (`calls/hangupStages.test.ts`),
// from a ring to a transfer, where a party then hangs up; `callTargetStages.ts` has the stages at
// a mailbox, a menu or an external number.
import { expect } from 'vitest';

import { callerChannel, type Call } from '../calls/call.js';
import type { FakeRequest } from './ari/fakeTransport.js';
import {
  answer,
  answered,
  bridged,
  callIn,
  callUser,
  legsIn,
  trackedCall,
  type Scene
} from './callScene.js';
import { eventually } from './eventually.js';
import { seedMember } from './featureRig.js';
import { seedForwardTarget, seedRingGroup, seedSlot } from './seedRows.js';

/** Where a stage left the call: the caller's channel; the answered party's, where one is there to
 * hang up; the party still talking to another once the caller left, who hangs up after; and what
 * Asterisk reports once the party hung up. */
export type Reached = {
  caller: string;
  callee?: string;
  talkingOn?: string;
  afterHangup?: () => Promise<void>;
};

async function answeredCall(scene: Scene): Promise<{ call: Call } & Reached> {
  const call = await callUser(scene, scene.users.alice);
  const callee = await answered(scene, call);
  return { call, caller: callerChannel(call), callee };
}

/** A call to a ring group of `alice` and `bob`. */
async function callGroup(scene: Scene): Promise<Call> {
  const { db } = scene.rig;
  const groupId = await seedRingGroup(db);
  await seedMember(db, groupId, 1, scene.users.alice);
  await seedMember(db, groupId, 2, scene.users.bob);
  return callIn(scene, await seedForwardTarget(db, { ringGroupId: groupId }));
}

/** The call `start` places, once the core asked for what `held` matches, which Asterisk answers
 * only once the core has seen the caller go. */
async function heldUntilCallerLeft(
  scene: Scene,
  held: (request: FakeRequest) => boolean,
  start: () => Promise<Call>
): Promise<Reached> {
  const requested = Promise.withResolvers<undefined>();
  const responded = Promise.withResolvers<undefined>();
  scene.rig.fakeAri.holdRequest = request => {
    if (!held(request)) {
      return 0;
    }
    requested.resolve(undefined);
    return responded.promise;
  };
  const call = await start();
  await requested.promise;
  return {
    caller: callerChannel(call),
    afterHangup: async () => {
      await eventually(() => {
        expect(call.callerEnded).toBe(true);
      });
      responded.resolve(undefined);
    }
  };
}

function isDial(request: FakeRequest): boolean {
  return request.method === 'POST' && request.path.endsWith('/dial');
}

function isBridgeCreation(request: FakeRequest): boolean {
  return request.method === 'POST' && request.path === 'bridges';
}

export function stillDialling(scene: Scene): Promise<Reached> {
  return heldUntilCallerLeft(scene, isDial, () =>
    callUser(scene, scene.users.alice)
  );
}

export function groupStillDialling(scene: Scene): Promise<Reached> {
  return heldUntilCallerLeft(scene, isDial, () => callGroup(scene));
}

/** `alice`'s phone answered, the call's bridge not created yet. */
export function answerBeingBridged(scene: Scene): Promise<Reached> {
  return heldUntilCallerLeft(scene, isBridgeCreation, async () => {
    const call = await callUser(scene, scene.users.alice);
    answer(scene, await legsIn(call, 'ringing'));
    return call;
  });
}

/** `bob`'s phone ringing to pick up the call ringing `alice`: the call and his phone's channel. */
async function pickupRinging(
  scene: Scene
): Promise<{ call: Call; picker: string }> {
  const call = await callUser(scene, scene.users.alice);
  await legsIn(call, 'ringing');
  await scene.actions.pickup(call.id, { actorUserId: scene.users.bob });
  const picker = await eventually(() => {
    const leg = [...scene.rig.pipeline.callByChannel].find(
      ([, owner]) => owner !== call
    );
    expect(leg).toBeDefined();
    return leg?.[0] ?? '';
  });
  return { call, picker };
}

/** `bob` picking up, his phone answered, the call's bridge not created yet. */
export function pickupBeingBridged(scene: Scene): Promise<Reached> {
  return heldUntilCallerLeft(scene, isBridgeCreation, async () => {
    const { call, picker } = await pickupRinging(scene);
    answer(scene, picker);
    return call;
  });
}

export async function ringing(scene: Scene): Promise<Reached> {
  const call = await callUser(scene, scene.users.alice);
  await legsIn(call, 'ringing');
  return { caller: callerChannel(call) };
}

export async function ringingGroup(scene: Scene): Promise<Reached> {
  const call = await callGroup(scene);
  await eventually(() => {
    expect(call.batchLegs?.size).toBe(2);
  });
  return { caller: callerChannel(call) };
}

export function talking(scene: Scene): Promise<Reached> {
  return answeredCall(scene);
}

export async function onHold(scene: Scene): Promise<Reached> {
  const reached = await answeredCall(scene);
  await scene.actions.hold(reached.call.id, { actorUserId: scene.users.alice });
  return reached;
}

/** `alice` transferred the caller to `bob`, whose phone rings. */
export async function blindTransferring(scene: Scene): Promise<Reached> {
  const { call } = await answeredCall(scene);
  await scene.actions.transfer(call.id, {
    target: '102',
    actorUserId: scene.users.alice
  });
  const onward = await eventually(() => {
    const next = scene.rig.pipeline.callByChannel.get(callerChannel(call));
    if (next === undefined || next === call) {
      throw new Error('the transferee is in no call of its own yet');
    }
    return next;
  });
  await legsIn(onward, 'ringing');
  return { caller: callerChannel(call) };
}

/** `alice` holds the caller and talks to `bob`; `alice` is the callee who hangs up. */
export async function consulting(scene: Scene): Promise<Reached> {
  const { call, callee } = await answeredCall(scene);
  const { callId } = await scene.actions.consult(call.id, {
    target: '102',
    actorUserId: scene.users.alice
  });
  const consulted = await answered(scene, await trackedCall(scene, callId));
  return { caller: callerChannel(call), callee, talkingOn: consulted };
}

export async function parked(scene: Scene): Promise<Reached> {
  await seedSlot(scene.rig.db, '701');
  scene.rig.cache.invalidate();
  const { call } = await answeredCall(scene);
  await scene.actions.park(call.id, {
    userId: scene.users.alice,
    actorUserId: scene.users.alice
  });
  return { caller: callerChannel(call) };
}

/** `bob` picked up the call ringing `alice`, on his own phone. */
export async function pickedUp(scene: Scene): Promise<Reached> {
  const { call, picker } = await pickupRinging(scene);
  answer(scene, picker);
  return { caller: callerChannel(call), callee: await bridged(scene, call) };
}
