/**
 * A party `api` adds to a live call's conversation (§10.2 "Three-way calls", §10.3 "Live calls"):
 * `calls.addParty`'s leg, and `calls.consult`'s consultation, the same leg dialled while the other
 * party is held (`consultation.ts`). It is `*5`'s leg (`addParty.ts`), resolved and dialled the
 * same way, its answer joining the conversation's bridge and its own row ending when it leaves.
 * No line of anyone's dials it, so it has no caller channel and rings its target and stops there
 * (`Call.callerChannelId`): no forward or mailbox of the target's applies, since nobody would hear
 * them.
 */
import { newId, type AddPartyRequest } from '@zamfono/shared';

import { logFailure } from '../ari/failures.js';
import { ActionError, HTTP_UNPROCESSABLE, notBridged } from './actionError.js';
import { dialAddPartyTarget } from './addParty.js';
import { resolveAddedTarget } from './addPartyTarget.js';
import { callLogMaxBytesFromEnv, newCall, type Call } from './call.js';
import { ownBridge, transferrerChannel } from './callLookup.js';
import { extensionOf } from './extensionOwner.js';
import { userOfChannel } from './onwardCall.js';
import type { Pipeline } from './pipeline.js';

/** Which action the leg is for, as its trace and the running call's name it. */
export type AddedLegKind = 'addParty' | 'consult';

/**
 * The added leg's own row, from the user whose channel `byChannelId` is in `running`, its trace
 * and the running call's naming the actor; refused with 422 for a target `*5` refuses (a parking
 * slot, a feature code, a mailbox, an unknown extension), before anything is dialled or held.
 */
export async function newAddedLeg(
  pipeline: Pipeline,
  running: Call,
  byChannelId: string,
  req: AddPartyRequest,
  kind: AddedLegKind
): Promise<Call> {
  const snapshot = await pipeline.deps.cache.get();
  if (resolveAddedTarget(snapshot, req.target).kind === 'refuse') {
    running.log.event({
      event: kind,
      actorUserId: req.actorUserId,
      target: req.target,
      result: 'invalidTarget'
    });
    throw new ActionError(
      HTTP_UNPROCESSABLE,
      'invalidTarget',
      'no party answers on this target'
    );
  }
  const id = newId();
  const callerUserId = userOfChannel(running, byChannelId);
  const leg = newCall({
    id,
    direction: 'internal',
    callerChannelId: null,
    from:
      (callerUserId === null
        ? null
        : extensionOf(snapshot, { userId: callerUserId })) ?? running.from,
    to: req.target,
    startedAt: pipeline.deps.now(),
    logLevel: running.log.level,
    callLogMaxBytes: callLogMaxBytesFromEnv()
  });
  leg.callerUserId = callerUserId;
  leg.addedLeg = true;
  leg.log.event({
    event: kind,
    actorUserId: req.actorUserId,
    target: req.target,
    runningCallId: running.id
  });
  running.log.event({
    event: kind,
    actorUserId: req.actorUserId,
    target: req.target,
    callId: id
  });
  await pipeline.deps.cdr.open(leg);
  // Reachable by its id from here on (`Pipeline.channelless`), as a `*5` dial is through its own
  // channel.
  pipeline.registerCall(leg);
  return leg;
}

/**
 * Dials the added leg in the background, its answer joining `bridgeId`; `onJoined` runs once it
 * did. A ring nobody answered leaves the row open (a call with no caller channel only rings), so
 * it closes here as missed.
 */
export function dialAddedLeg(
  pipeline: Pipeline,
  leg: Call,
  bridgeId: string,
  target: string,
  onJoined: () => void
): void {
  const dial = async (): Promise<void> => {
    const snapshot = await pipeline.deps.cache.get();
    const joined = await dialAddPartyTarget(
      pipeline,
      leg,
      snapshot,
      bridgeId,
      target
    );
    if (joined) {
      onJoined();
      return;
    }
    if (leg.status === null) {
      leg.status = 'missed';
      await pipeline.finishCall(leg);
    }
  };
  dial().catch(logFailure(pipeline.deps.logger, 'added party dial'));
}

/** `POST /internal/calls/{id}/parties`: dials `req.target` from the actor, its answer joining
 * the call's bridge as a third party; the actor leaving then ends it for everyone, as `*5`'s
 * initiator does. The added leg's own call. */
export async function addPartyOnRequest(
  pipeline: Pipeline,
  call: Call,
  req: AddPartyRequest
): Promise<{ callId: string }> {
  const bridgeId = ownBridge(call);
  const byChannelId = transferrerChannel(call, req.actorUserId);
  if (bridgeId === null || byChannelId === null) {
    throw notBridged();
  }
  const leg = await newAddedLeg(pipeline, call, byChannelId, req, 'addParty');
  leg.parentCallId = call.id;
  dialAddedLeg(pipeline, leg, bridgeId, req.target, () => {
    call.threeWayInitiatorChannelId = byChannelId;
  });
  return { callId: leg.id };
}
