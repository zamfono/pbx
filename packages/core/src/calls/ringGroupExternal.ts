/**
 * A ring-group member's leg to the external number or SIP target of its unconditional forward
 * (§10.1 step 5), one of the legs `ringGroupOriginate.ts` originates for a batch.
 */
import { newId } from '@zamfono/shared';

import type { Snapshot } from '../internal/snapshot.js';
import type { ForwardTarget } from '../routing/targets.js';
import type { Call } from './call.js';
import { ringExternalLeg } from './externalLeg.js';
import { CONDITION_REASONS, diversionFor } from './forwardContext.js';
import { recordingOf, type ForwardLeg } from './forwardLeg.js';
import { sipForwardLeg } from './forwardValues.js';
import type { Pipeline } from './pipeline.js';
import type { BatchLegs } from './ringGroupOriginate.js';

/** Rings a member's unconditional forward to an external number or a SIP target as the member's
 * leg (§10.1 step 5), dialled as the member's own call (§9.4 "Outbound routing", §10.1 step 7) by
 * `externalLeg.ts`, with the member's forward as its last hop (§9.4 "Forwarded calls"); each
 * attempt's channel is tracked under the member, a superseded one dropped from the batch. */
export async function originateExternalLeg(
  pipeline: Pipeline,
  call: Call,
  target: Extract<ForwardTarget, { kind: 'external' | 'sip' }>,
  member: { memberKey: string; batch: BatchLegs; snapshot: Snapshot }
): Promise<void> {
  if (call.answeredAt !== null) {
    return;
  }
  const { memberKey, batch } = member;
  const { tracked } = batch;
  const hop = diversionFor(
    member.snapshot,
    call,
    { userId: memberKey },
    CONDITION_REASONS.unconditional
  );
  const diversions =
    hop === null ? [...call.diversions] : [...call.diversions, hop];
  // An external leg is originated without a wait, alongside the members' (§10.1 step 5).
  const forward: ForwardLeg =
    target.kind === 'sip'
      ? await sipForwardLeg(pipeline, call, target, diversions, member.snapshot)
      : { diversions, headers: [] };
  await ringExternalLeg(
    pipeline,
    call,
    target.kind === 'sip'
      ? {
          number: target.user,
          asUser: memberKey,
          trunkId: target.trunkId,
          forward
        }
      : { number: target.number, asUser: memberKey, forward },
    {
      place: channelId => {
        tracked.set(channelId, {
          id: newId(),
          channelId,
          userId: null,
          memberKey,
          state: 'placing',
          external: true,
          standsInFor: memberKey,
          ...recordingOf(target)
        });
      },
      track: channelId => {
        call.log.event({ event: 'ringGroupMember', channelId, userId: null });
        const leg = tracked.get(channelId);
        if (leg === undefined || call.answeredAt !== null) {
          return false;
        }
        leg.state = 'ringing';
        return true;
      },
      ringing: channelId => tracked.get(channelId)?.state === 'ringing',
      retire: channelId => {
        tracked.delete(channelId);
      },
      end: (channelId, cause) => {
        const leg = tracked.get(channelId);
        if (leg?.state === 'ringing') {
          batch.end(leg, cause);
        }
      }
    }
  );
}
