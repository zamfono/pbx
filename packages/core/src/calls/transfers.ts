/**
 * Transfers (§10.1 "Transfers and pickup"): `transferCall` is the blind transfer `api` requests
 * over the internal API; `referTransfers.ts`'s `followTransfers` tracks the SIP `REFER` transfers
 * Asterisk executes on its own. Either way the transferrer's participation ends, the original
 * call closes, and the transferee's conversation goes on as a call of its own linked through
 * `parent_call_id`.
 */
import { newId, type TransferRequest } from '@zamfono/shared';

import type { Snapshot } from '../internal/server.js';
import { setChannelLanguage } from '../prompts.js';
import { ActionError } from './actionError.js';
import {
  callLogMaxBytesFromEnv,
  newCall,
  raiseLogLevel,
  type Call
} from './call.js';
import {
  channelOf,
  otherChannelIn,
  presentCallerUserId
} from './callLookup.js';
import { ownerForExt } from './extensionOwner.js';
import { endHold } from './hold.js';
import { closeCall } from './liveCall.js';
import type { Pipeline } from './pipeline.js';
import { logLevelFor, resolveTarget, routeToTarget } from './routeToTarget.js';

/** The user present in `call` as `channelId`: its caller, or the leg's owner. */
export function userOfChannel(call: Call, channelId: string): string | null {
  if (channelId === call.callerChannelId) {
    return presentCallerUserId(call);
  }
  return call.legs.get(channelId)?.userId ?? null;
}

/** The number the transferee's new call is from: the original caller's, or a colleague's extension. */
export function fromOf(
  parent: Call,
  transferee: string,
  snapshot: Snapshot
): string {
  if (transferee === parent.callerChannelId) {
    return parent.from;
  }
  const userId = userOfChannel(parent, transferee);
  const ext = snapshot.extensions.find(row => row.userId === userId)?.ext;
  return ext ?? parent.to;
}

/**
 * What the transferee's new call inherits from `parent` (§10.1 "Transfers and pickup"): the
 * original caller of an inbound call stays an inbound caller, reaching the target through the
 * company's number, so opening hours, the missed-call mail and the history's direction filter
 * treat the onward call as the inbound call it continues; anyone else starts afresh. Shared by
 * the transfer `api` requests and the `REFER` one Asterisk executes (`blindTransfer.ts`).
 */
export function transfereeEntry(
  parent: Call,
  transferee: string
): { inbound: boolean; didId: string | null } {
  const isOriginalCaller = transferee === parent.callerChannelId;
  return {
    inbound: isOriginalCaller && parent.direction === 'inbound',
    didId: isOriginalCaller ? parent.didId : null
  };
}

/**
 * The transferee's own new call (§10.1 "Transfers and pickup"): `parent_call_id` links it to
 * `parent`, its caller channel is the transferee's, and `target` is routed as the transferrer's
 * call (§9.4), so an external number leaves under the transferrer's routes and caller-ID. The
 * routing runs on after this returns, like any other call's.
 */
async function startTransfereeCall(
  pipeline: Pipeline,
  parent: Call,
  transferee: string,
  target: string,
  transferrerUserId: string | null
): Promise<Call> {
  const snapshot = await pipeline.deps.cache.get();
  const resolved = resolveTarget(snapshot, target);
  const entry = transfereeEntry(parent, transferee);
  const startedAt = pipeline.deps.now();
  const child = newCall({
    id: newId(),
    direction: entry.inbound ? 'inbound' : resolved.direction,
    callerChannelId: transferee,
    from: fromOf(parent, transferee, snapshot),
    to: resolved.to,
    startedAt,
    logLevel: logLevelFor(snapshot, resolved.action, startedAt),
    callLogMaxBytes: callLogMaxBytesFromEnv()
  });
  child.parentCallId = parent.id;
  child.callerUserId = userOfChannel(parent, transferee);
  child.didId = entry.didId;
  // §7: the target is routed as the transferrer's call, so their override counts toward its level.
  raiseLogLevel(
    child.log,
    snapshot.users.find(row => row.id === transferrerUserId),
    startedAt
  );
  await pipeline.deps.cdr.open(child);
  pipeline.registerCall(child);
  // §9.1: every channel's language is the tenant's; the transferee may be a leg the core
  // originated, which has not been through an entry of its own.
  await setChannelLanguage(
    pipeline.deps.ari,
    transferee,
    snapshot.settings.language
  );
  child.log.event({
    event: 'entry',
    dialAction: resolved.action.kind,
    dialed: target,
    parentCallId: parent.id
  });
  routeToTarget(pipeline, child, resolved.action, transferrerUserId).catch(
    () => undefined
  );
  return child;
}

const HTTP_UNPROCESSABLE = 422;

/** `*97<ext>` (§9.3), what a phone transfers a caller to for `ext`'s mailbox, without ringing:
 * a transfer with `voicemail` dials it in place of `ext`. 422 for an extension no user or ring
 * group owns. */
export async function voicemailDial(
  pipeline: Pipeline,
  ext: string
): Promise<string> {
  const snapshot = await pipeline.deps.cache.get();
  if (ownerForExt(snapshot, ext) === null) {
    throw new ActionError(
      HTTP_UNPROCESSABLE,
      'noMailbox',
      'the target owns no mailbox'
    );
  }
  return `${snapshot.settings.featureCodes.deposit}${ext}`;
}

/** The transferrer's channel in `call`: the actor's own, else the answerer's, else the caller's.
 * Only an admin's transfer of someone else's call reaches the fallbacks: `api` lets a `user`
 * transfer a call only as its caller or with a leg up in it (§10.3 "Live calls"). The same side
 * holds, consults and adds a party for the actor (`callControl.ts`). */
export function transferrerChannel(call: Call, actorUserId: string): string {
  const answerer =
    call.answeredByUserId === null
      ? null
      : channelOf(call, call.answeredByUserId);
  return channelOf(call, actorUserId) ?? answerer ?? call.callerChannelId;
}

/**
 * `POST /internal/calls/{id}/transfer` (§10.1 "Transfers and pickup"): blind-transfers the other
 * party of the bridged `call` to `target` as their own new call, returned; the transferrer's
 * participation, and with it `call`, ends. `null` for a call that is not bridged, or whose
 * bridge is another call's: a party added to that call (§10.2 "Three-way calls").
 */
export async function transferCall(
  pipeline: Pipeline,
  call: Call,
  req: TransferRequest
): Promise<Call | null> {
  const transferrer = transferrerChannel(call, req.actorUserId);
  const transferee = otherChannelIn(call, transferrer);
  const { bridgeId } = call;
  if (bridgeId === null || transferee === null || call.addedLeg === true) {
    return null;
  }
  // A transferee held through the API (`hold.ts`) leaves from the bridge it was held out of.
  await endHold(pipeline, bridgeId, bridgeId);
  call.log.event({
    event: 'transfer',
    actorUserId: req.actorUserId,
    target: req.target,
    transferee
  });
  const transferrerUserId = userOfChannel(call, transferrer);
  const { ari } = pipeline.deps;
  await ari.bridges.removeChannel(bridgeId, transferee).catch(() => undefined);
  await closeCall(pipeline, call, 'answered', false);
  await ari.channels.hangup(transferrer).catch(() => undefined);
  await ari.bridges.destroy(bridgeId).catch(() => undefined);
  return startTransfereeCall(
    pipeline,
    call,
    transferee,
    req.target,
    transferrerUserId
  );
}
