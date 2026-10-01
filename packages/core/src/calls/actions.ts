/**
 * `api`'s live-call actions over the internal API (§3 "core"; §10.2 "Click-to-dial"; §10.1
 * "Transfers and pickup"). Originate rings the user's devices first, as any user's ring does
 * (`ownDevices.ts`), and once one answers dials the target as that device would have; the
 * originated call itself is built and dialled by `clickToDial.ts`. Pickup is `pickupAction.ts`'s.
 * Hangup, transfer and park act on a live `Call` (park through `parkingActions.ts`, §10.2 "Call
 * parking"), and so do hold, consultation, an added party and decline. Every action leaves its
 * actor in the call's trace.
 */
import {
  type AddPartyRequest,
  type AttendedTransferRequest,
  type ConsultRequest,
  type DeclineRequest,
  type HangupRequest,
  type HoldRequest,
  type OriginateRequest,
  type ParkingResponse,
  type ParkRequest,
  type PickupRequest,
  type TransferRequest
} from '@zamfono/shared';

import { ActionError, HTTP_NOT_FOUND } from './actionError.js';
import { addPartyOnRequest } from './addedParty.js';
import type { Call } from './call.js';
import { findLiveCall } from './callLookup.js';
import {
  beginOriginatedCall,
  newOriginatedCall,
  resolveOriginateTarget
} from './clickToDial.js';
import { consult, transferToConsultation } from './consultation.js';
import { decline } from './decline.js';
import { holdOnRequest, resumeOnRequest } from './hold.js';
import { closeCall } from './liveCall.js';
import { abandonOwnRing, ringOwnDevices, ringTimeoutOf } from './ownDevices.js';
import { parkOnRequest } from './parkingActions.js';
import { parkedCalls } from './parkingView.js';
import { pickupOnRequest } from './pickupAction.js';
import type { Pipeline } from './pipeline.js';
import { transferCall } from './transfers.js';
import { registeredDevices } from './userDevices.js';

/** The live-call actions of the internal API (§3), over one `Pipeline`. */
export class CallActions {
  private readonly pipeline: Pipeline;
  // Calls whose devices still ring for an originate: reachable by id before any channel of theirs
  // is registered with the pipeline.
  private readonly originating = new Map<string, Call>();

  constructor(pipeline: Pipeline) {
    this.pipeline = pipeline;
  }

  /** `POST /internal/calls` (§10.2 "Click-to-dial"): the call's row exists from here on, its trace
   * naming the actor, whether the user's devices answer, never do, or do not exist. The call has
   * no caller channel until one of them answers. */
  async originate(
    req: OriginateRequest
  ): Promise<{ callId: string } | { error: 'noRegisteredDevice' }> {
    const snapshot = await this.pipeline.deps.cache.get();
    const resolved = resolveOriginateTarget(snapshot, req);
    const devices = registeredDevices(this.pipeline, snapshot, req.userId);
    const call = newOriginatedCall(this.pipeline, snapshot, req, resolved);
    if (devices.length === 0) {
      call.log.event({ event: 'originate', result: 'noRegisteredDevice' });
      call.status = 'failed';
      await this.pipeline.deps.cdr.finish(call);
      return { error: 'noRegisteredDevice' };
    }
    await this.pipeline.deps.cdr.open(call);
    this.originating.set(call.id, call);
    const ring = ringOwnDevices(this.pipeline, {
      host: call,
      sipCall: call,
      userId: req.userId,
      devices,
      callerId: resolved.to,
      timeoutS: ringTimeoutOf(snapshot, req.userId),
      language: snapshot.settings.language,
      peer: resolved.to,
      // Keyed by the call, so a REST hangup's `closeCall` clears it with the rest of the call.
      presenceKey: call.id
    });
    ring.outcome
      .then(async outcome => {
        this.originating.delete(call.id);
        if (outcome.kind === 'answered') {
          await beginOriginatedCall(
            this.pipeline,
            call,
            outcome.channel,
            resolved.action
          );
        } else if (outcome.kind === 'unanswered') {
          call.log.event({ event: 'originate', result: 'unanswered' });
          await closeCall(this.pipeline, call, 'failed', false);
        }
      })
      .catch(() => undefined);
    await ring.placed;
    return { callId: call.id };
  }

  /** `POST /internal/calls/{id}/pickup` (§10.1 "Pickup"): `pickupAction.ts`'s. */
  async pickup(callId: string, req: PickupRequest): Promise<void> {
    await pickupOnRequest(this.pipeline, this.findCall(callId), req);
  }

  /** `POST /internal/calls/{id}/hangup`: ends every channel of the call and writes its history entry. */
  async hangup(callId: string, req: HangupRequest): Promise<void> {
    const call = this.findCall(callId);
    call.log.event({ event: 'hangup', actorUserId: req.actorUserId });
    if (this.originating.delete(callId)) {
      abandonOwnRing(this.pipeline, call);
    }
    await closeCall(this.pipeline, call, 'missed', true);
  }

  /** `POST /internal/calls/{id}/transfer` (§10.1 "Transfers and pickup"): with `voicemail`,
   * into the mailbox of the extension's user or ring group, as `*97<target>` (§9.3). */
  async transfer(callId: string, req: TransferRequest): Promise<void> {
    await transferCall(this.pipeline, this.findCall(callId), req);
  }

  /** `POST /internal/calls/{id}/park` (§10.2 "Call parking"): `userId` parks the call's other
   * party as `*70` would, without the slot read out to a feature dial, which there is none of. */
  async park(callId: string, req: ParkRequest): Promise<{ slot: string }> {
    return parkOnRequest(this.pipeline, this.findCall(callId), req);
  }

  /** `GET /internal/parking`: the occupied parking slots (§10.2 "Call parking"). */
  async parked(): Promise<ParkingResponse> {
    return { parked: await parkedCalls(this.pipeline) };
  }

  // Call control beside hangup and transfer (§10.3 "Live calls"), each the phone feature's own
  // code path: a party added to the conversation (`addedParty.ts`, §10.2 "Three-way calls"), a
  // consultation and the attended transfer to it (`consultation.ts`), hold and resume in the core
  // (`hold.ts`), and a decline of the actor's own ring (`decline.ts`).
  addParty(callId: string, req: AddPartyRequest): Promise<{ callId: string }> {
    return addPartyOnRequest(this.pipeline, this.findCall(callId), req);
  }

  consult(callId: string, req: ConsultRequest): Promise<{ callId: string }> {
    return consult(this.pipeline, this.findCall(callId), req);
  }

  attendedTransfer(
    callId: string,
    req: AttendedTransferRequest
  ): Promise<void> {
    const call = this.findCall(callId);
    const consultation = this.findCall(req.toCallId);
    return transferToConsultation(this.pipeline, call, consultation, req);
  }

  hold(callId: string, req: HoldRequest): Promise<void> {
    return holdOnRequest(this.pipeline, this.findCall(callId), req);
  }

  resume(callId: string, req: HoldRequest): Promise<void> {
    return resumeOnRequest(this.pipeline, this.findCall(callId), req);
  }

  decline(callId: string, req: DeclineRequest): void {
    decline(this.pipeline, this.findCall(callId), req);
  }

  private findCall(callId: string): Call {
    const call =
      findLiveCall(this.pipeline, candidate => candidate.id === callId) ??
      this.originating.get(callId) ??
      null;
    if (call === null) {
      throw new ActionError(HTTP_NOT_FOUND, 'notFound', 'call not found');
    }
    return call;
  }
}
