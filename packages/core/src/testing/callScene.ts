// Test-only: a stack whose phones and trunks act only when a test says so, and the steps of a call
// through it (`calls/hangupStages.test.ts`): an inbound call, its legs ringing, one answering.
import { expect } from 'vitest';

import { nowIso, type MailRequest } from '@zamfono/shared';
import { seedDid } from '@zamfono/shared/testDb.js';

import type { Channel } from '../ari/types.js';
import { CallActions } from '../calls/actions.js';
import type { Call } from '../calls/call.js';
import { defaultChannel } from './ari/fakeChannel.js';
import { trackCoreTimers, type CoreTimers } from './callLeftovers.js';
import { eventually } from './eventually.js';
import { stubMailSender } from './pipelineDeps.js';
import { startRig, type Rig } from './pipelineRig.js';
import { seedForwardTarget, seedUserWithDevice } from './seedRows.js';

const DID = '+15551000';
const CALLER = '+15559999';
// Long enough that no ring, greeting or menu prompt ends by itself while a test runs.
export const NEVER_MS = 60_000;

/** The rig, the actions `api` would call, the mails the core requested, the core's timers, and two
 * users with one registered phone each, `alice` (101) and `bob` (102), who get the missed-call mail as
 * every user does by default. */
export type Scene = {
  rig: Rig;
  actions: CallActions;
  mails: MailRequest[];
  users: { alice: string; bob: string };
  timers: CoreTimers;
};

export async function startScene(): Promise<Scene> {
  const mailer = stubMailSender();
  const rig = await startRig({ apiClient: mailer });
  rig.fakeAri.answerAfterMs = NEVER_MS;
  rig.fakeAri.reportsHangups = true;
  const alice = await seedUserWithDevice(rig, '101');
  const bob = await seedUserWithDevice(rig, '102');
  rig.cache.invalidate();
  return {
    rig,
    actions: new CallActions(rig.pipeline),
    mails: mailer.sent,
    users: { alice, bob },
    timers: trackCoreTimers()
  };
}

/** An inbound call from `CALLER` to a DID forwarding to `targetId`, as Asterisk hands it to the
 * core; the call once the pipeline tracks it. */
export async function callIn(scene: Scene, targetId: string): Promise<Call> {
  const { rig } = scene;
  await seedDid(rig.db, DID, targetId);
  rig.cache.invalidate();
  const caller = rig.fakeAri.addChannel({
    name: 'PJSIP/trunk-1-00000001',
    caller: { number: CALLER, name: '' }
  });
  rig.fakeAri.emit({
    type: 'StasisStart',
    timestamp: nowIso(),
    application: 'zamfono',
    args: ['inbound', DID],
    channel: caller
  });
  return eventually(() => {
    const call = rig.pipeline.callByChannel.get(caller.id);
    if (call === undefined) {
      throw new Error('the pipeline tracks no call for the caller yet');
    }
    return call;
  });
}

/** `callIn` to `userId`'s phones. */
export async function callUser(scene: Scene, userId: string): Promise<Call> {
  return callIn(scene, await seedForwardTarget(scene.rig.db, { userId }));
}

/** The live call with id `callId`, once the pipeline tracks it by a channel. */
export function trackedCall(scene: Scene, callId: string): Promise<Call> {
  return eventually(() => {
    const found = [...scene.rig.pipeline.callByChannel.values()].find(
      candidate => candidate.id === callId
    );
    if (found === undefined) {
      throw new Error(`the pipeline tracks no call ${callId} yet`);
    }
    return found;
  });
}

/** The channels of `call`'s legs in `state`, once there is one. */
export function legsIn(call: Call, state: 'ringing' | 'up'): Promise<string> {
  return eventually(() => {
    const legs = [...call.legs.values()].filter(leg => leg.state === state);
    expect(legs).toHaveLength(1);
    return legs[0]?.channelId ?? '';
  });
}

/** The phone or trunk ringing on `channelId` answers. */
export function answer(scene: Scene, channelId: string): void {
  const channel: Channel = {
    ...defaultChannel({ id: channelId }),
    state: 'Up'
  };
  scene.rig.fakeAri.emit({
    type: 'ChannelStateChange',
    timestamp: nowIso(),
    application: 'zamfono',
    channel
  });
}

/** Waits until `call`'s answer is bridged, the last step of an answer (`answer.ts`), and returns
 * the answered leg's channel. */
export async function bridged(scene: Scene, call: Call): Promise<string> {
  await eventually(() => {
    expect(scene.rig.state.calls.get(call.id)?.state).toBe('up');
  });
  return legsIn(call, 'up');
}

/** `call`'s one ringing leg answered and bridged: its channel. */
export async function answered(scene: Scene, call: Call): Promise<string> {
  answer(scene, await legsIn(call, 'ringing'));
  return bridged(scene, call);
}
