/**
 * `api`'s live-call actions over the internal API (§3 "core"; §10.2 "Click-to-dial"; §10.1
 * "Transfers and pickup"). Originate rings the user's devices first and, once one answers, dials
 * the target as that device would have; pickup rings the picker's devices with `*8<ext>` as their
 * dial string, so the answer lands in `features.ts`'s own pickup exactly as a dialled `*8` would;
 * hangup and transfer act on a live `Call`. Every action leaves its actor in the call's trace.
 * The originated call itself is built and dialled by `clickToDial.ts`.
 */
/* eslint-disable max-classes-per-file -- ActionError is the one refusal these actions raise */
import {
  newId,
  type HangupRequest,
  type OriginateRequest,
  type PickupRequest,
  type TransferRequest
} from '@zamfono/shared';

import type { Snapshot } from '../internal/server.js';
import type { Call } from './call.js';
import { findLiveCall } from './callLookup.js';
import { beginOriginatedCall, newOriginatedCall } from './clickToDial.js';
import { DeviceRinger, showRinging, type DeviceRing } from './deviceRing.js';
import { closeCall } from './liveCall.js';
import type { Pipeline } from './pipeline.js';
import { followTransfers } from './referTransfers.js';
import { activeBatchHasRingingLeg } from './ringGroupDial.js';
import { resolveTarget } from './routeToTarget.js';
import { transferCall } from './transfers.js';
import { registeredDevices } from './userDevices.js';

const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;
// `users.ring_timeout_s`'s column default (§11.2).
const DEFAULT_RING_TIMEOUT_S = 25;

/** A refused action, carried to the internal API as its HTTP status and problem `cause`. */
export class ActionError extends Error {
  readonly status: number;
  readonly reason: string;

  constructor(status: number, reason: string, message: string) {
    super(message);
    this.name = 'ActionError';
    this.status = status;
    this.reason = reason;
  }
}

/** `users.ring_timeout_s` (§11.2): the user's own, or the column's default for an unknown user. */
function ringTimeoutOf(snapshot: Snapshot, userId: string): number {
  const user = snapshot.users.find(row => row.id === userId);
  return user?.ringTimeoutS ?? DEFAULT_RING_TIMEOUT_S;
}

/** The extension `call` is ringing right now, `null` once it stopped (§10.1 "Pickup"). */
function ringingExtension(
  pipeline: Pipeline,
  snapshot: Snapshot,
  call: Call
): string | null {
  const { calleeUserId, ringGroupId } = call;
  if (
    ringGroupId !== null &&
    activeBatchHasRingingLeg(pipeline, call.id, null)
  ) {
    return (
      snapshot.extensions.find(row => row.ringGroupId === ringGroupId)?.ext ??
      null
    );
  }
  if (calleeUserId !== null && pipeline.pendingRing.has(call.id)) {
    return (
      snapshot.extensions.find(row => row.userId === calleeUserId)?.ext ?? null
    );
  }
  return null;
}

/** The live-call actions of the internal API (§3), over one `Pipeline`. */
export class CallActions {
  private readonly pipeline: Pipeline;
  private readonly ringer: DeviceRinger;
  // Calls whose devices still ring for an originate: reachable by id before any channel of theirs
  // is registered with the pipeline.
  private readonly originating = new Map<
    string,
    { call: Call; ring: DeviceRing }
  >();

  constructor(pipeline: Pipeline) {
    this.pipeline = pipeline;
    this.ringer = new DeviceRinger(pipeline.deps.ari);
    followTransfers(pipeline);
  }

  /** `POST /internal/calls` (§10.2 "Click-to-dial"): the call's row exists from here on, its trace
   * naming the actor, whether the user's devices answer, never do, or do not exist. */
  async originate(
    req: OriginateRequest
  ): Promise<{ callId: string } | { error: 'noRegisteredDevice' }> {
    const snapshot = await this.pipeline.deps.cache.get();
    const resolved = resolveTarget(snapshot, req.target);
    const devices = registeredDevices(this.pipeline, snapshot, req.userId);
    const channelIds = devices.map(() => newId());
    const call = newOriginatedCall(
      this.pipeline,
      snapshot,
      req,
      resolved,
      channelIds.at(0) ?? ''
    );
    if (devices.length === 0) {
      call.log.event({ event: 'originate', result: 'noRegisteredDevice' });
      call.status = 'failed';
      await this.pipeline.deps.cdr.finish(call);
      return { error: 'noRegisteredDevice' };
    }
    await this.pipeline.deps.cdr.open(call);
    // Keyed by the call, so a REST hangup's `closeCall` clears it with the rest of the call.
    const ringing = { userId: req.userId, peer: resolved.to, key: call.id };
    const ring: DeviceRing = {
      channelIds: new Set(channelIds),
      ...showRinging(this.pipeline.deps.presence, ringing, {
        onAnswer: channel => {
          this.originating.delete(call.id);
          return beginOriginatedCall(
            this.pipeline,
            call,
            channel,
            resolved.action
          );
        },
        onUnanswered: () => {
          this.originating.delete(call.id);
          call.log.event({ event: 'originate', result: 'unanswered' });
          return closeCall(this.pipeline, call, 'failed', false);
        }
      })
    };
    this.originating.set(call.id, { call, ring });
    await this.ringer.ring(devices, ring, {
      appArgs: `click,${call.id}`,
      callerId: resolved.to,
      timeoutS: ringTimeoutOf(snapshot, req.userId),
      language: snapshot.settings.language
    });
    // §7 level `sip`: every device's dialog is part of the call's SIP log, the one that answers
    // becoming its caller's; `open` could not join them, since none existed yet.
    for (const channelId of channelIds) {
      this.pipeline.deps.cdr.registerLeg?.(call, channelId);
    }
    return { callId: call.id };
  }

  /** `POST /internal/calls/{id}/pickup` (§10.1 "Pickup"): rings `userId`'s devices with `*8<ext>`
   * of the ringing extension as their dial string, so the answer takes the call the way the
   * feature code does; `pickup`'s own trace line on the target names the actor. */
  async pickup(callId: string, req: PickupRequest): Promise<void> {
    const target = this.findCall(callId);
    const snapshot = await this.pipeline.deps.cache.get();
    const ext = ringingExtension(this.pipeline, snapshot, target);
    if (ext === null) {
      throw new ActionError(HTTP_CONFLICT, 'notRinging', 'call is not ringing');
    }
    const devices = registeredDevices(this.pipeline, snapshot, req.userId);
    if (devices.length === 0) {
      throw new ActionError(
        HTTP_CONFLICT,
        'noRegisteredDevice',
        'no registered device'
      );
    }
    target.log.event({
      event: 'pickup',
      userId: req.userId,
      actorUserId: req.actorUserId,
      ext
    });
    const channelIds = devices.map(() => newId());
    // A key of its own: the answered device's `*8` dial sets the picker in `target`'s call itself.
    const ringing = {
      userId: req.userId,
      peer: target.from,
      key: `pickup:${target.id}`
    };
    const ring: DeviceRing = {
      channelIds: new Set(channelIds),
      ...showRinging(this.pipeline.deps.presence, ringing, {
        onAnswer: () => Promise.resolve(),
        onUnanswered: () => {
          target.log.event({
            event: 'pickup',
            userId: req.userId,
            result: 'unanswered'
          });
          return Promise.resolve();
        }
      })
    };
    await this.ringer.ring(devices, ring, {
      appArgs: `outbound,${snapshot.settings.featureCodes.pickup}${ext}`,
      callerId: target.from,
      timeoutS: ringTimeoutOf(snapshot, req.userId),
      language: snapshot.settings.language
    });
    // §7 level `sip`: each device's dialog rings for the picked-up call and, answered, becomes its
    // leg, so it is joined to that call's SIP log as a ring race's legs are.
    for (const channelId of channelIds) {
      this.pipeline.deps.cdr.registerLeg?.(target, channelId);
    }
  }

  /** `POST /internal/calls/{id}/hangup`: ends every channel of the call and writes its history entry. */
  async hangup(callId: string, req: HangupRequest): Promise<void> {
    const call = this.findCall(callId);
    call.log.event({ event: 'hangup', actorUserId: req.actorUserId });
    const originating = this.originating.get(callId);
    if (originating !== undefined) {
      this.originating.delete(callId);
      await this.ringer.stop(originating.ring, null);
    }
    await closeCall(this.pipeline, call, 'missed', true);
  }

  /** `POST /internal/calls/{id}/transfer` (§10.1 "Transfers and pickup"). */
  async transfer(callId: string, req: TransferRequest): Promise<void> {
    const call = this.findCall(callId);
    const child = await transferCall(this.pipeline, call, req);
    if (child === null) {
      throw new ActionError(HTTP_CONFLICT, 'notBridged', 'call is not bridged');
    }
  }

  private findCall(callId: string): Call {
    const call =
      findLiveCall(this.pipeline, candidate => candidate.id === callId) ??
      this.originating.get(callId)?.call ??
      null;
    if (call === null) {
      throw new ActionError(HTTP_NOT_FOUND, 'notFound', 'call not found');
    }
    return call;
  }
}
