/**
 * Transfers (§10.1 "Transfers and pickup"): `transferCall` is the blind transfer `api` requests
 * over the internal API; `referTransfers.ts`'s `followTransfers` tracks the SIP `REFER` transfers
 * Asterisk executes on its own. Either way the transferrer's participation ends, the original
 * call closes, and the transferee's conversation goes on as a call of its own linked through
 * `parent_call_id` (`onwardCall.ts`).
 */
import {
  HTTP_UNPROCESSABLE_CONTENT,
  type TransferRequest
} from '@zamfono/shared';

import { logUnlessGone } from '../ari/failures.js';
import type { Snapshot } from '../internal/snapshot.js';
import { ActionError, notBridged } from './actionError.js';
import { type Call, type Owner } from './call.js';
import { bridgedParty, transferrerChannel } from './callLookup.js';
import { ownerForExt } from './extensionOwner.js';
import { endHold } from './hold.js';
import { closeCall } from './liveCall.js';
import {
  startOnwardCall,
  userOfChannel,
  type OnwardEntry
} from './onwardCall.js';
import {
  dispatchAction,
  logLevelFor,
  resolveTarget,
  type ResolvedTarget
} from './outboundDispatch.js';
import type { Pipeline } from './pipeline.js';
import { deposit } from './voicemail.js';

/** Where a transfer sends the transferee: `target` dialled as the transferrer's call, or for a
 * transfer to voicemail straight into the mailbox of `target`'s owner, without ringing, as
 * `*97<target>` deposits (§9.3). */
type Onward =
  | { target: string; resolved: ResolvedTarget }
  | { target: string; mailbox: Owner };

/**
 * The transferee's own new call, going `onward`: a target is routed as the transferrer's call
 * (§9.4), so an external number leaves under the transferrer's routes and caller-ID.
 */
async function startTransfereeCall(
  pipeline: Pipeline,
  parent: Call,
  transferee: string,
  onward: Onward,
  transferrerUserId: string | null
): Promise<Call> {
  const snapshot = await pipeline.deps.cache.get();
  const dial = 'resolved' in onward ? onward.resolved : null;
  const entry: OnwardEntry = {
    to: dial?.to ?? onward.target,
    direction: dial?.direction ?? 'internal',
    logLevel:
      dial === null
        ? snapshot.settings.callLogLevel
        : logLevelFor(snapshot, dial.action, pipeline.deps.now()),
    asUserId: transferrerUserId,
    trace:
      dial === null
        ? { mailbox: onward.target }
        : { dialAction: dial.action.kind, dialed: onward.target }
  };
  return startOnwardCall(
    pipeline,
    parent,
    transferee,
    { snapshot, entry },
    child =>
      'mailbox' in onward
        ? deposit(pipeline, child, onward.mailbox, 'transfer')
        : dispatchAction(pipeline, child, onward.resolved.action, {
            snapshot,
            asUser: transferrerUserId
          })
  );
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
      HTTP_UNPROCESSABLE_CONTENT,
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
  await ari.bridges.removeChannel(bridgeId, transferee).catch(
    logUnlessGone(pipeline.deps.logger, 'transferee removal', {
      callId: call.id
    })
  );
  await closeCall(pipeline, call, 'answered', false);
  await ari.channels.hangup(transferrer).catch(
    logUnlessGone(pipeline.deps.logger, 'transferrer hangup', {
      callId: call.id
    })
  );
  await ari.bridges
    .destroy(bridgeId)
    .catch(
      logUnlessGone(pipeline.deps.logger, 'bridge destroy', { callId: call.id })
    );
  return startTransfereeCall(
    pipeline,
    call,
    transferee,
    onward,
    transferrerUserId
  );
}
