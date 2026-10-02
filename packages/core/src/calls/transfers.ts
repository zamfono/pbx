/**
 * Transfers (§10.1 "Transfers and pickup"): `transferCall` is the blind transfer `api` requests
 * over the internal API; `referTransfers.ts`'s `followTransfers` tracks the SIP `REFER` transfers
 * Asterisk executes on its own. Either way the transferrer's participation ends, the original
 * call closes, and the transferee's conversation goes on as a call of its own linked through
 * `parent_call_id`.
 */
import { newId, type TransferRequest } from '@zamfono/shared';

import type { Snapshot } from '../internal/snapshot.js';
import { setChannelLanguage } from '../prompts.js';
import { ActionError, HTTP_UNPROCESSABLE, notBridged } from './actionError.js';
import {
  callLogMaxBytesFromEnv,
  newCall,
  raiseLogLevel,
  toLogLevel,
  type Call,
  type Owner
} from './call.js';
import {
  bridgedParty,
  presentCallerUserId,
  transferrerChannel
} from './callLookup.js';
import { extensionOf, ownerForExt } from './extensionOwner.js';
import { endHold } from './hold.js';
import { closeCall } from './liveCall.js';
import {
  dispatchAction,
  logLevelFor,
  resolveTarget,
  type ResolvedTarget
} from './outboundDispatch.js';
import type { Pipeline } from './pipeline.js';
import { deposit } from './voicemail.js';

/** The user present in `call` as `channelId`: its caller, or the leg's owner. */
export function userOfChannel(call: Call, channelId: string): string | null {
  if (channelId === call.callerChannelId) {
    return presentCallerUserId(call);
  }
  return call.legs.get(channelId)?.userId ?? null;
}

/** The number the transferee's new call is from: the original caller's, a colleague's extension,
 * else, for a party with no user of its own (an external number dialled), the number the call
 * went to. */
export function fromOf(
  parent: Call,
  transferee: string,
  snapshot: Snapshot
): string {
  if (transferee === parent.callerChannelId) {
    return parent.from;
  }
  const userId = userOfChannel(parent, transferee);
  const ext = userId === null ? null : extensionOf(snapshot, { userId });
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

/** Where a transfer sends the transferee: `target` dialled as the transferrer's call, or for a
 * transfer to voicemail straight into the mailbox of `target`'s owner, without ringing, as
 * `*97<target>` deposits (§9.3). */
type Onward =
  | { target: string; resolved: ResolvedTarget }
  | { target: string; mailbox: Owner };

/**
 * The transferee's own new call (§10.1 "Transfers and pickup"): `parent_call_id` links it to
 * `parent`, its caller channel is the transferee's, and it goes `onward`: a target is routed as
 * the transferrer's call (§9.4), so an external number leaves under the transferrer's routes and
 * caller-ID. The routing runs on after this returns, like any other call's.
 */
async function startTransfereeCall(
  pipeline: Pipeline,
  parent: Call,
  transferee: string,
  onward: Onward,
  transferrerUserId: string | null
): Promise<Call> {
  const snapshot = await pipeline.deps.cache.get();
  const entry = transfereeEntry(parent, transferee);
  const startedAt = pipeline.deps.now();
  const dial = 'resolved' in onward ? onward.resolved : null;
  const child = newCall({
    id: newId(),
    direction: entry.inbound ? 'inbound' : (dial?.direction ?? 'internal'),
    callerChannelId: transferee,
    from: fromOf(parent, transferee, snapshot),
    to: dial?.to ?? onward.target,
    startedAt,
    logLevel:
      dial === null
        ? toLogLevel(snapshot.settings.callLogLevel)
        : logLevelFor(snapshot, dial.action, startedAt),
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
    ...(dial === null
      ? { mailbox: onward.target }
      : { dialAction: dial.action.kind, dialed: onward.target }),
    parentCallId: parent.id
  });
  const routing =
    'mailbox' in onward
      ? deposit(pipeline, child, onward.mailbox, 'transfer')
      : dispatchAction(pipeline, child, onward.resolved.action, {
          snapshot,
          asUser: transferrerUserId
        });
  routing.catch(() => undefined);
  return child;
}

/** Where `req` sends the transferee (`Onward`); 422 for a transfer to voicemail to an extension
 * no user or ring group owns, so nothing has moved yet. */
function onwardOf(snapshot: Snapshot, req: TransferRequest): Onward {
  const { target } = req;
  if (req.voicemail !== true) {
    return { target, resolved: resolveTarget(snapshot, target) };
  }
  const mailbox = ownerForExt(snapshot, target);
  if (mailbox === null) {
    throw new ActionError(
      HTTP_UNPROCESSABLE,
      'noMailbox',
      'the target owns no mailbox'
    );
  }
  return { target, mailbox };
}

/**
 * `POST /internal/calls/{id}/transfer` (§10.1 "Transfers and pickup"): blind-transfers the other
 * party of the bridged `call` to `req.target`, with `req.voicemail` into its owner's mailbox, as
 * their own new call, returned; the transferrer's participation, and with it `call`, ends. 409
 * for a call that is not bridged (`bridgedParty`).
 */
export async function transferCall(
  pipeline: Pipeline,
  call: Call,
  req: TransferRequest
): Promise<Call> {
  const onward = onwardOf(await pipeline.deps.cache.get(), req);
  const conversation = bridgedParty(
    call,
    transferrerChannel(call, req.actorUserId)
  );
  if (conversation === null) {
    throw notBridged();
  }
  const {
    bridgeId,
    party: transferee,
    byChannelId: transferrer
  } = conversation;
  // A transferee held through the API (`hold.ts`) leaves from the bridge it was held out of.
  await endHold(pipeline, bridgeId, bridgeId);
  call.log.event({
    event: 'transfer',
    actorUserId: req.actorUserId,
    target: req.target,
    ...('mailbox' in onward ? { voicemail: true } : {}),
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
    onward,
    transferrerUserId
  );
}
