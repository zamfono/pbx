/**
 * A ring-group batch's win (§10.1 step 5: "the first answer wins and the other legs are hung up"),
 * settled by the batch's race.
 */
import { ignoreGone, logUnlessGone } from '../ari/failures.js';
import { bridgeAnswered, claimAnswer } from './answer.js';
import { takeJoinBridge, type Call, type Leg } from './call.js';
import { hangupAllRinging, type GroupLeg } from './groupLegs.js';
import type { Pipeline } from './pipeline.js';

/**
 * The first accepted answer in a batch: bridges it with the caller, ends every other leg, and
 * registers the winner as a `member` leg on the Call aggregate (§10.1 "Call aggregate") so a
 * later ring group's `isUserInCall`/`skip_busy` check sees this user as already in a call.
 * Returns whether `winningChannelId` was actually the one that won — a second `Up` arriving while
 * the first winner is still bridging only hangs up here, and must not re-settle the race.
 */
export async function winBatch(
  pipeline: Pipeline,
  call: Call,
  winningChannelId: string,
  tracked: Map<string, GroupLeg>
): Promise<boolean> {
  const winner = tracked.get(winningChannelId);
  if (winner !== undefined) {
    // Ended either way: a second `Up` for a member already ended (the batch's winner, or a
    // hung-up sibling) must not be re-hung-up as still ringing once `hangupAllRinging` runs.
    winner.state = 'ended';
  }
  const winningLeg: Leg | null =
    winner === undefined
      ? null
      : {
          id: winner.id,
          channelId: winningChannelId,
          kind: 'member',
          userId: winner.userId,
          state: 'ringing',
          endCause: null,
          ...(winner.deviceId === undefined
            ? {}
            : { deviceId: winner.deviceId }),
          ...(call.ringGroupId === null
            ? {}
            : { ringGroupId: call.ringGroupId })
        };
  // Claimed before the first await, so a second member's `Up` landing while this one is still
  // bridging loses here rather than bridging the caller a second time.
  if (
    winningLeg === null ||
    !claimAnswer(pipeline, call, winningLeg, { ringGroupId: call.ringGroupId })
  ) {
    await pipeline.deps.ari.channels.hangup(winningChannelId).catch(
      logUnlessGone(pipeline.deps.logger, 'late answer hangup', {
        callId: call.id
      })
    );
    return false;
  }
  if (call.callerChannelId !== null) {
    await pipeline.deps.ari.channels
      .stopMoh(call.callerChannelId)
      .catch(ignoreGone);
  }
  // A registered bridge to join (`addParty.ts`'s `*5`) in place of a bridge of its own.
  const joined = await bridgeAnswered(
    pipeline,
    call,
    winningLeg,
    takeJoinBridge(call)
  );
  await hangupAllRinging(pipeline, tracked);
  // §9.3 "a user: ... INUSE in a call"; a leg whose join failed is hung up.
  if (winningLeg.userId !== null && joined) {
    pipeline.deps.presence.setCallState(
      winningLeg.userId,
      'inCall',
      call.from,
      call.ringGroupId,
      call.id
    );
  }
  return true;
}
