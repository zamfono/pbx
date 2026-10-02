/**
 * An attended transfer over the API (§10.1 "Transfers and pickup", §10.3 "Live calls"):
 * `calls.consult` holds the other party (`hold.ts`) and dials the target from the actor as an
 * added leg (`addedParty.ts`), so the actor talks to the target in the conversation's own bridge
 * while the party hears hold music; `calls.transfer` with `toCallId` then joins the held party
 * to the target in the actor's place, as a phone's own attended transfer does
 * (`attendedTransfer.ts`): the original call closes, and the consultation carries the
 * conversation on with `parent_call_id` set to it. The consulted party leaving leaves the actor
 * with the party still held, to resume; the actor leaving ends it all.
 */
import type { AttendedTransferRequest, ConsultRequest } from '@zamfono/shared';

import { ignoreGone, logFailure } from '../ari/failures.js';
import { ActionError, HTTP_CONFLICT, notBridged } from './actionError.js';
import { dialAddedLeg, newAddedLeg } from './addedParty.js';
import { handOver } from './attendedTransfer.js';
import type { Call } from './call.js';
import { bridgedParty, ownBridge, transferrerChannel } from './callLookup.js';
import { consultationLive, endHold, holdOf, holdParty } from './hold.js';
import { closeCall } from './liveCall.js';
import { userOfChannel } from './onwardCall.js';
import type { Pipeline } from './pipeline.js';

/** `POST /internal/calls/{id}/consult`: holds the other party and dials `target` from the actor;
 * the consultation's own call. */
export async function consult(
  pipeline: Pipeline,
  call: Call,
  req: ConsultRequest
): Promise<{ callId: string }> {
  const conversation = bridgedParty(
    call,
    transferrerChannel(call, req.actorUserId)
  );
  if (conversation === null) {
    throw notBridged();
  }
  const { bridgeId, party, byChannelId } = conversation;
  if (consultationLive(pipeline, call)) {
    throw new ActionError(
      HTTP_CONFLICT,
      'consulting',
      'a consultation is already in progress'
    );
  }
  const consultation = await newAddedLeg(
    pipeline,
    call,
    byChannelId,
    req,
    'consult'
  );
  const hold =
    holdOf(pipeline, call) ??
    (await holdParty(pipeline, call, byChannelId, party));
  hold.consultationCallId = consultation.id;
  hold.consultationJoined = false;
  dialAddedLeg(pipeline, consultation, bridgeId, req.target, () => {
    hold.consultationJoined = true;
  });
  return { callId: consultation.id };
}

/**
 * `POST /internal/calls/{id}/attendedTransfer`: the held party of `call` takes the actor's place
 * in `consultation`, which carries on with `parent_call_id` set to `call`; the actor's channel
 * leaves both and `call` closes. Each row keeps its own parties, and the transferee's
 * participation in the consultation is evaluated for recording as its own (§10.2).
 */
export async function transferToConsultation(
  pipeline: Pipeline,
  call: Call,
  consultation: Call,
  req: AttendedTransferRequest
): Promise<void> {
  const hold = holdOf(pipeline, call);
  const bridgeId = ownBridge(call);
  if (hold?.consultationCallId !== consultation.id) {
    throw new ActionError(
      HTTP_CONFLICT,
      'notConsultation',
      'call is not consulting that call'
    );
  }
  // Joined once its dial settled, so the dial's own end no longer acts on its caller channel.
  if (
    bridgeId === null ||
    consultation.bridgeId !== bridgeId ||
    !hold.consultationJoined
  ) {
    throw new ActionError(
      HTTP_CONFLICT,
      'notAnswered',
      'the consultation is not answered'
    );
  }
  const transferee = {
    channelId: hold.channelId,
    userId: userOfChannel(call, hold.channelId)
  };
  call.log.event({
    event: 'attendedTransfer',
    actorUserId: req.actorUserId,
    toCallId: consultation.id,
    transferee: transferee.channelId
  });
  consultation.log.event({
    event: 'attendedTransfer',
    actorUserId: req.actorUserId,
    parentCallId: call.id
  });
  consultation.parentCallId = call.id;
  // A conversation of its own from here on, ended by either of its two parties leaving.
  delete consultation.addedLeg;
  handOver(pipeline, consultation, consultation.callerChannelId, transferee);
  const { ari } = pipeline.deps;
  await ari.bridges
    .removeChannel(bridgeId, hold.byChannelId)
    .catch(ignoreGone)
    .catch(
      logFailure(pipeline.deps.logger, 'transferrer removal', {
        callId: call.id
      })
    );
  await endHold(pipeline, bridgeId, bridgeId);
  await closeCall(pipeline, call, 'answered', false);
  // The actor's channel is left with nobody, as a phone's first channel is after its transfer.
  await ari.channels
    .hangup(hold.byChannelId)
    .catch(ignoreGone)
    .catch(
      logFailure(pipeline.deps.logger, 'transferrer hangup', {
        callId: call.id
      })
    );
  await pipeline.deps.recorder?.onTransfereeUp(consultation, transferee).catch(
    logFailure(pipeline.deps.logger, 'transferee recording', {
      callId: consultation.id
    })
  );
}
