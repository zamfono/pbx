/** Finding a party in the live calls: the channel a user is present as, a two-party bridge's other
 * side, and a user's current bridged call (§10.1 "Transfers and pickup"; §10.2 "Call parking",
 * "Three-way calls"). Shared by the feature codes, the transfers and the live-call actions; its
 * coverage lives in `features.test.ts` and `transfers.test.ts` alongside theirs. */
import type { Call } from './call.js';
import type { Pipeline } from './pipeline.js';

/**
 * The user whose channel `call.callerChannelId` is right now: the caller until their channel
 * leaves the call, parking the other party (§10.2 "Call parking"), or until an attended transfer
 * hands its place to the transferee (§10.1), whose user it then is. The history's caller is
 * `callerUserId` throughout.
 */
export function presentCallerUserId(call: Call): string | null {
  if (call.callerEnded === true) {
    return null;
  }
  return call.callerChannelUserId === undefined
    ? call.callerUserId
    : call.callerChannelUserId;
}

/** The channel `userId` is present as in `call`: its own caller channel while it is in the call
 * (`presentCallerUserId`), or an up leg. A caller who left (one who parked the other party, §10.2
 * "Call parking") is present only through a leg they joined again by, such as the parking
 * ring-back's. */
export function channelOf(call: Call, userId: string): string | null {
  if (presentCallerUserId(call) === userId) {
    return call.callerChannelId;
  }
  const match = [...call.legs.values()].find(
    leg => leg.userId === userId && leg.state === 'up'
  );
  return match?.channelId ?? null;
}

/** The bridged call's other party (§10.2 "Call parking" assumes the usual two-party bridge):
 * `call.callerChannelId` when `excludeChannelId` is a leg and the caller is still in the call,
 * else the one other up leg. */
export function otherChannelIn(
  call: Call,
  excludeChannelId: string
): string | null {
  if (call.callerChannelId !== excludeChannelId && call.callerEnded !== true) {
    return call.callerChannelId;
  }
  const leg = [...call.legs.values()].find(
    candidate =>
      candidate.state === 'up' && candidate.channelId !== excludeChannelId
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
