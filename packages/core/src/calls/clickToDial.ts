/**
 * The call a click-to-dial originate places (§10.2 "Click-to-dial"): built before any device of
 * the user rings, its trace naming the actor, and dialled once one of them answers, exactly as
 * that device would have dialled the target. `actions.ts` owns the action surface, `ownDevices.ts`
 * the ring.
 */
import { newId, type OriginateRequest } from '@zamfono/shared';

import type { Channel } from '../ari/types.js';
import type { Snapshot } from '../internal/snapshot.js';
import { setChannelLanguage } from '../prompts.js';
import { withClir, type DialAction } from '../routing/outbound.js';
import { newCall, type Call } from './call.js';
import { raiseLogLevel } from './callLogLevel.js';
import { extensionOf } from './extensionOwner.js';
import {
  dispatchAction,
  logLevelFor,
  resolveTarget,
  type ResolvedTarget
} from './outboundDispatch.js';
import type { Pipeline } from './pipeline.js';

/** What `req.target` resolves to when dialled, under the call's own CLIR where `req.clir` gives
 * one, as `#31#`/`*31#` before the target would (§9.4 "Anonymous calls (CLIR)"); an emergency
 * number keeps presenting the caller's number. */
export function resolveOriginateTarget(
  snapshot: Snapshot,
  req: OriginateRequest
): ResolvedTarget {
  const resolved = resolveTarget(snapshot, req.target);
  return req.clir === undefined
    ? resolved
    : { ...resolved, action: withClir(resolved.action, req.clir) };
}

/** The originated call, from the user's own extension to `resolved`, with the actor in its trace;
 * it has no caller channel until one of the user's devices answers. */
export function newOriginatedCall(
  pipeline: Pipeline,
  snapshot: Snapshot,
  req: OriginateRequest,
  resolved: ResolvedTarget
): Call {
  const startedAt = pipeline.deps.now();
  const call = newCall({
    id: newId(),
    direction: resolved.direction,
    callerChannelId: null,
    from: extensionOf(snapshot, { userId: req.userId }) ?? '',
    to: resolved.to,
    startedAt,
    logLevel: logLevelFor(snapshot, resolved.action, startedAt),
    callLogMaxBytes: pipeline.deps.callLogMaxBytes
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
    dialAction: resolved.action.kind,
    ...(req.clir === undefined ? {} : { clir: req.clir })
  });
  return call;
}

/** The originated call's device answered: that channel is the call's own from here on (it leaves
 * `Pipeline.channelless` for `callByChannel`), and the target is dialled as the device would have
 * dialled it (§10.2 "Click-to-dial"), including the user's presence: in a call from the dial on
 * (§9.3 "a user: ... INUSE in a call"), except for a feature-code dial or a refused string, which
 * is no call of the user's. */
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
    pipeline.deps.presence.setCallState(
      call.callerUserId,
      'inCall',
      call.to,
      null,
      call.id
    );
  }
  await dispatchAction(pipeline, call, action, {
    snapshot,
    asUser: call.callerUserId
  });
}
