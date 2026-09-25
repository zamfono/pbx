/**
 * The call a click-to-dial originate places (§10.2 "Click-to-dial"): built before any device of
 * the user rings, its trace naming the actor, and dialled once one of them answers, exactly as
 * that device would have dialled the target. `actions.ts` owns the ring and the action surface.
 */
import { newId, type OriginateRequest } from '@zamfono/shared';

import type { Channel } from '../ari/types.js';
import type { Snapshot } from '../internal/server.js';
import { setChannelLanguage } from '../prompts.js';
import type { DialAction } from '../routing/outbound.js';
import {
  callLogMaxBytesFromEnv,
  newCall,
  raiseLogLevel,
  type Call
} from './call.js';
import type { Pipeline } from './pipeline.js';
import {
  logLevelFor,
  routeToTarget,
  type ResolvedTarget
} from './routeToTarget.js';

function extensionOf(snapshot: Snapshot, userId: string): string {
  return snapshot.extensions.find(row => row.userId === userId)?.ext ?? '';
}

/** The originated call, from the user's own extension to `resolved`, with the actor in its trace;
 * `callerChannelId` is the first device's pre-assigned channel until one of them answers. */
export function newOriginatedCall(
  pipeline: Pipeline,
  snapshot: Snapshot,
  req: OriginateRequest,
  resolved: ResolvedTarget,
  callerChannelId: string
): Call {
  const startedAt = pipeline.deps.now();
  const call = newCall({
    id: newId(),
    direction: resolved.direction,
    callerChannelId,
    from: extensionOf(snapshot, req.userId),
    to: resolved.to,
    startedAt,
    logLevel: logLevelFor(snapshot, resolved.action, startedAt),
    callLogMaxBytes: callLogMaxBytesFromEnv()
  });
  call.callerUserId = req.userId;
  // §7: the call is routed as the user's own, so their diagnostics override counts toward its level.
  raiseLogLevel(
    call.log,
    snapshot.users.find(row => row.id === req.userId),
    startedAt
  );
  call.log.event({
    event: 'originate',
    actorUserId: req.actorUserId,
    requestId: req.requestId,
    target: req.target,
    dialAction: resolved.action.kind
  });
  return call;
}

/** The originated call's device answered: that channel is the call's own from here on, and the
 * target is dialled as the device would have dialled it (§10.2 "Click-to-dial"), including
 * the user's presence: in a call from the dial on (§9.3 "a user: ... INUSE in a call"), except
 * for a feature-code dial or a refused string, which is no call of the user's. */
export async function beginOriginatedCall(
  pipeline: Pipeline,
  call: Call,
  channel: Channel,
  action: DialAction
): Promise<void> {
  call.callerChannelId = channel.id;
  pipeline.registerCall(call);
  call.log.event({ event: 'deviceAnswered', channelId: channel.id });
  // §9.1: every channel's language is the tenant's, so the prompts this call plays follow it.
  const snapshot = await pipeline.deps.cache.get();
  await setChannelLanguage(
    pipeline.deps.ari,
    channel.id,
    snapshot.settings.language
  );
  const isCallOfUser = action.kind !== 'feature' && action.kind !== 'refuse';
  if (call.callerUserId !== null && isCallOfUser) {
    pipeline.deps.presence?.setCallState(
      call.callerUserId,
      'inCall',
      call.to,
      null,
      call.id
    );
  }
  await routeToTarget(pipeline, call, action, call.callerUserId);
}
