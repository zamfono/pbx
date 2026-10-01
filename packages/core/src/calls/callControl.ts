/**
 * The call control `api` requests on a live call beside hangup and transfer (§10.3 "Live calls"),
 * each the phone feature's own code path: a party added to the conversation (`addedParty.ts`,
 * §10.2 "Three-way calls"), a consultation and the attended transfer to it (`consultation.ts`),
 * hold and resume in the core (`hold.ts`), and a decline of the actor's own ring (`decline.ts`).
 * `actions.ts`'s `CallActions` finds the calls and hands them here; every action leaves its actor
 * in the call's trace.
 */
import type {
  AddPartyRequest,
  AttendedTransferRequest,
  ConsultRequest,
  DeclineRequest,
  HoldRequest
} from '@zamfono/shared';

import { ActionError } from './actionError.js';
import { dialAddedLeg, newAddedLeg } from './addedParty.js';
import type { Call } from './call.js';
import { otherChannelIn } from './callLookup.js';
import {
  consult,
  consultationLive,
  notBridged,
  ownBridge,
  transferToConsultation
} from './consultation.js';
import { decline } from './decline.js';
import { endHold, holdIn, holdOf, holdParty } from './hold.js';
import type { Pipeline } from './pipeline.js';
import { transferrerChannel } from './transfers.js';

const HTTP_CONFLICT = 409;

export class CallControl {
  private readonly pipeline: Pipeline;

  constructor(pipeline: Pipeline) {
    this.pipeline = pipeline;
  }

  /** `POST /internal/calls/{id}/parties`: dials `target` from the actor, its answer joining the
   * call's bridge as a third party; the actor leaving then ends it for everyone, as `*5`'s
   * initiator does. The added leg's own call. */
  async addParty(
    call: Call,
    req: AddPartyRequest
  ): Promise<{ callId: string }> {
    const bridgeId = ownBridge(call);
    if (bridgeId === null) {
      throw notBridged();
    }
    const byChannelId = transferrerChannel(call, req.actorUserId);
    const leg = await newAddedLeg(
      this.pipeline,
      call,
      byChannelId,
      req,
      'addParty'
    );
    leg.parentCallId = call.id;
    dialAddedLeg(this.pipeline, leg, bridgeId, req.target, () => {
      call.threeWayInitiatorChannelId = byChannelId;
    });
    return { callId: leg.id };
  }

  consult(call: Call, req: ConsultRequest): Promise<{ callId: string }> {
    return consult(this.pipeline, call, req);
  }

  transferToConsultation(
    call: Call,
    consultation: Call,
    req: AttendedTransferRequest
  ): Promise<void> {
    return transferToConsultation(this.pipeline, call, consultation, req);
  }

  /** `POST /internal/calls/{id}/hold`: the other party leaves the bridge for the hold music. */
  async hold(call: Call, req: HoldRequest): Promise<void> {
    const bridgeId = ownBridge(call);
    const byChannelId = transferrerChannel(call, req.actorUserId);
    const party = otherChannelIn(call, byChannelId);
    if (bridgeId === null || party === null) {
      throw notBridged();
    }
    if (holdIn(this.pipeline, bridgeId) !== null) {
      throw new ActionError(HTTP_CONFLICT, 'held', 'call is on hold');
    }
    call.log.event({
      event: 'hold',
      actorUserId: req.actorUserId,
      channelId: party
    });
    await holdParty(this.pipeline, call, byChannelId, party);
  }

  /** `POST /internal/calls/{id}/resume`: the held party returns to the bridge. During a
   * consultation that makes three parties, the one who held it then their initiator. */
  async resume(call: Call, req: HoldRequest): Promise<void> {
    const hold = holdOf(this.pipeline, call);
    if (hold === null) {
      throw new ActionError(HTTP_CONFLICT, 'notHeld', 'call is not on hold');
    }
    call.log.event({ event: 'resume', actorUserId: req.actorUserId });
    if (consultationLive(this.pipeline, call)) {
      call.threeWayInitiatorChannelId = hold.byChannelId;
    }
    await endHold(this.pipeline, call.bridgeId, call.bridgeId);
  }

  decline(call: Call, req: DeclineRequest): void {
    decline(this.pipeline, call, req);
  }
}
