/** Finding a party in the live calls: the channel a user is present as, a two-party bridge's other
 * side, and a user's current bridged call (§10.1 "Transfers and pickup"; §10.2 "Call parking",
 * "Three-way calls"). Shared by the feature codes, the transfers and the live-call actions; its
 * coverage lives in `features.test.ts` and `transfers.test.ts` alongside theirs. */
import type { Call } from './call.js';
import type { Pipeline } from './pipeline.js';

/** The channel `userId` is present as in `call`: its own caller channel, or an up leg. */
export function channelOf(call: Call, userId: string): string | null {
  if (call.callerUserId === userId) {
    return call.callerChannelId;
  }
  const match = [...call.legs.values()].find(
    leg => leg.userId === userId && leg.state === 'up'
  );
  return match?.channelId ?? null;
}

/** The bridged call's other party (§10.2 "Call parking" assumes the usual two-party bridge):
 * `call.callerChannelId` when `excludeChannelId` is a leg, else the one up leg. */
export function otherChannelIn(
  call: Call,
  excludeChannelId: string
): string | null {
  if (call.callerChannelId !== excludeChannelId) {
    return call.callerChannelId;
  }
  const leg = [...call.legs.values()].find(
    candidate => candidate.state === 'up'
  );
  return leg?.channelId ?? null;
}

/** The first live call matching `test`, over `callByChannel`'s several entries per call. */
export function findLiveCall(
  pipeline: Pipeline,
  test: (call: Call) => boolean
): Call | null {
  for (const call of pipeline.callByChannel.values()) {
    if (test(call)) {
      return call;
    }
  }
  return null;
}

/** `userId`'s current bridged call, for `*5<target>` and `*70` (§10.2). */
export function activeCallOf(pipeline: Pipeline, userId: string): Call | null {
  return findLiveCall(
    pipeline,
    call => call.bridgeId !== null && channelOf(call, userId) !== null
  );
}
