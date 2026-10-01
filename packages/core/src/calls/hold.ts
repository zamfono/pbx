/**
 * A hold in the core (§10.3 "Live calls": `calls.hold`, `calls.consult`): the other party leaves
 * the conversation's bridge and hears the tenant's hold music on its own channel, the way a ring
 * group's caller hears its music while members ring, and the one holding stays in the bridge,
 * hearing nobody and heard by nobody. Resuming puts the party back. The phone knows nothing of
 * it, so a hold or resume the phone signals (re-INVITE) is a separate matter for Asterisk. One
 * registry per `Pipeline`, keyed by the conversation's bridge, since every row sharing that
 * bridge (a party added to it, a consultation) must count the held party as still in it. Also
 * the `calls.hold` and `calls.resume` actions themselves.
 */
import type { HoldRequest } from '@zamfono/shared';

import { ActionError } from './actionError.js';
import type { Call } from './call.js';
import { findLiveCall, otherChannelIn } from './callLookup.js';
import { notBridged, ownBridge } from './consultation.js';
import type { Pipeline } from './pipeline.js';
import { transferrerChannel } from './transfers.js';

const HTTP_CONFLICT = 409;

export type Hold = {
  /** The call whose party is held. */
  callId: string;
  /** The held party's own channel, in no bridge while held. */
  channelId: string;
  /** The channel of the one who held it: their leaving ends the conversation for everyone. */
  byChannelId: string;
  /** The consultation `calls.consult` started from this hold, if any. */
  consultationCallId: string | null;
  /** Whether that consultation's answer has joined the bridge and its dial settled. */
  consultationJoined: boolean;
};

const holdsByPipeline = new WeakMap<Pipeline, Map<string, Hold>>();

function holds(pipeline: Pipeline): Map<string, Hold> {
  let map = holdsByPipeline.get(pipeline);
  if (map === undefined) {
    map = new Map();
    holdsByPipeline.set(pipeline, map);
  }
  return map;
}

/** The hold on the conversation in `bridgeId`, whichever row sharing that bridge asks. */
export function holdIn(
  pipeline: Pipeline,
  bridgeId: string | null
): Hold | null {
  return bridgeId === null ? null : (holds(pipeline).get(bridgeId) ?? null);
}

/** `call`'s own hold: one of its parties held in its bridge. */
export function holdOf(pipeline: Pipeline, call: Call): Hold | null {
  const hold = holdIn(pipeline, call.bridgeId);
  return hold?.callId === call.id ? hold : null;
}

/**
 * Takes `partyChannelId` out of `call`'s bridge and plays it the tenant's hold music (§10.2 "Hold
 * music": `settings.hold_moh_audio_id`, else Asterisk's `default` class), held by `byChannelId`.
 */
export async function holdParty(
  pipeline: Pipeline,
  call: Call,
  byChannelId: string,
  partyChannelId: string
): Promise<Hold> {
  const { bridgeId } = call;
  if (bridgeId === null) {
    throw new Error(`hold: call ${call.id} has no bridge`);
  }
  const hold: Hold = {
    callId: call.id,
    channelId: partyChannelId,
    byChannelId,
    consultationCallId: null,
    consultationJoined: false
  };
  // Registered before the bridge is left, so the party's absence is never read as their leaving.
  holds(pipeline).set(bridgeId, hold);
  const snapshot = await pipeline.deps.cache.get();
  const { ari } = pipeline.deps;
  await ari.bridges
    .removeChannel(bridgeId, partyChannelId)
    .catch(() => undefined);
  await ari.channels
    .startMoh(partyChannelId, snapshot.settings.holdMohAudioId ?? undefined)
    .catch(() => undefined);
  return hold;
}

/**
 * Ends the hold on the conversation in `bridgeId`, if any: the music stops and the party joins
 * `intoBridgeId`, the conversation's own bridge for a resume, a consultation's for a transfer to
 * it; `null` leaves the party in no bridge, for a party whose channel is gone or about to be.
 * Whether there was a hold.
 */
export async function endHold(
  pipeline: Pipeline,
  bridgeId: string | null,
  intoBridgeId: string | null
): Promise<boolean> {
  const hold = holdIn(pipeline, bridgeId);
  if (hold === null || bridgeId === null) {
    return false;
  }
  holds(pipeline).delete(bridgeId);
  if (intoBridgeId === null) {
    return true;
  }
  const { ari } = pipeline.deps;
  await ari.channels.stopMoh(hold.channelId).catch(() => undefined);
  await ari.bridges
    .addChannel(intoBridgeId, hold.channelId)
    .catch(() => undefined);
  return true;
}

/** Whether `call`'s consultation (`Hold.consultationCallId`) is still live. */
export function consultationLive(pipeline: Pipeline, call: Call): boolean {
  const id = holdOf(pipeline, call)?.consultationCallId ?? null;
  return id !== null && findLiveCall(pipeline, live => live.id === id) !== null;
}

/** `POST /internal/calls/{id}/hold`: the other party leaves the bridge for the hold music. */
export async function holdOnRequest(
  pipeline: Pipeline,
  call: Call,
  req: HoldRequest
): Promise<void> {
  const bridgeId = ownBridge(call);
  const byChannelId = transferrerChannel(call, req.actorUserId);
  const party = otherChannelIn(call, byChannelId);
  if (bridgeId === null || party === null) {
    throw notBridged();
  }
  if (holdIn(pipeline, bridgeId) !== null) {
    throw new ActionError(HTTP_CONFLICT, 'held', 'call is on hold');
  }
  call.log.event({
    event: 'hold',
    actorUserId: req.actorUserId,
    channelId: party
  });
  await holdParty(pipeline, call, byChannelId, party);
}

/** `POST /internal/calls/{id}/resume`: the held party returns to the bridge. During a
 * consultation that makes three parties, the one who held it then their initiator. */
export async function resumeOnRequest(
  pipeline: Pipeline,
  call: Call,
  req: HoldRequest
): Promise<void> {
  const hold = holdOf(pipeline, call);
  if (hold === null) {
    throw new ActionError(HTTP_CONFLICT, 'notHeld', 'call is not on hold');
  }
  call.log.event({ event: 'resume', actorUserId: req.actorUserId });
  if (consultationLive(pipeline, call)) {
    call.threeWayInitiatorChannelId = hold.byChannelId;
  }
  await endHold(pipeline, call.bridgeId, call.bridgeId);
}
