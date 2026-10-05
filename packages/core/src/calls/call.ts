/** The Call aggregate (spec §10.1): tracked in memory only — caller channel, legs, bridge, timers,
 * routing cursor; SQLite holds durable outcomes alone, via the CDR writer. */
import type { Selectable } from 'kysely';

import { newId, type CallLogLevel, type DB, type Scope } from '@zamfono/shared';

import { CallLog } from '../callLog.js';
import type { Diversion } from './forwardContext.js';
import type { GroupLeg } from './groupLegs.js';

export type CallsRow = Selectable<DB['calls']>;

/** One channel dialed for a call: a device, a find-me leg, a trunk leg or a group member. `endCause`
 * is the Q.850 hangup cause `ringOutcome()` reads, set from `ChannelDestroyed` while ringing.
 * `placing` from before its channel is created until it is dialled (`legOriginate.ts`): such a leg
 * is its placement's to settle, never shown, counted as ringing or hung up by anything else. */
export type Leg = {
  /** The leg's own id in the live calls (§10.3 "Live calls"), never Asterisk's. */
  id: string;
  channelId: string;
  kind: 'device' | 'findMe' | 'trunk' | 'member';
  userId: string | null;
  state: 'placing' | 'ringing' | 'up' | 'ended';
  endCause: number | null;
  /** The device a `device` or `member` leg rings, the trunk a `trunk` leg dials over; for the
   * routing trace's `answered` line (§7). */
  deviceId?: string;
  trunkId?: string;
  /** The number or SIP target a `trunk` leg dials (§10.3 "Live calls"). */
  target?: string;
  /** The ring group that placed a `member` leg, whose `record_calls` counts for it (§10.2
   * "Recording semantics"). */
  ringGroupId?: string;
  /** The user whose `unconditional` forward this `trunk` leg, or external `member` leg, dials:
   * its participation and its answer are theirs (§10.2 "Effective flag", "Call history"). */
  standsInFor?: string;
  /** A `device` leg of the caller's own, rung before the call has a caller channel (§10.2
   * "Click-to-dial"): the caller's leg while it rings, and once it answers, the caller's leg under
   * the same id (§10.3 "Live calls"). */
  callerSide?: boolean;
};

export type Call = {
  id: string;
  direction: 'inbound' | 'outbound' | 'internal';
  /** The caller's own channel; `null` while the call has none: a click-to-dial before one of
   * the user's devices answers, a party `api` adds (`addedParty.ts`), the parking ring-back and
   * the ring of an `api` pickup. Each but the pickup's ring, which is never written nor
   * addressed, is reachable by its id through `Pipeline.channelless` (`registerCall`). Such a call
   * only rings (`userStep.ts`, `ringGroup.ts`): a forward, mailbox or release has no caller to
   * act on. */
  callerChannelId: string | null;
  /** The live-calls id of the caller's leg (§10.3 "Live calls"), new whenever another party's
   * channel takes the caller's place. */
  callerLegId: string;
  /** The trunk an inbound caller's channel arrived on. */
  callerTrunkId?: string;
  from: string;
  to: string;
  didId: string | null;
  callerUserId: string | null;
  calleeUserId: string | null;
  ringGroupId: string | null;
  answeredByUserId: string | null;
  bridgeId: string | null;
  legs: Map<string, Leg>;
  /** The legs of the ring-group batch ringing the call right now (`ringGroupDial.ts`), which
   * `legs` holds only once one is answered; a member's ringing leg makes the call theirs to see
   * (`callState.ts`). */
  batchLegs?: ReadonlyMap<string, GroupLeg>;
  hops: number;
  /** The forward hops taken so far, first first (§9.4 "Forwarded calls"). */
  diversions: Diversion[];
  log: CallLog;
  startedAt: string;
  answeredAt: string | null;
  status: CallsRow['status'] | null;
  parentCallId: string | null;
  evaluated: Set<Scope>;
  menuAttempts: number;
  /** The bridge this call's next answer joins in place of a bridge of its own: the parked
   * party's for the parking ring-back (§10.2 "Call parking"), the running call's for `*5`
   * (§10.2 "Three-way calls"). Read once by the answer it is for (`takeJoinBridge`), and
   * cleared by its writer once the dial settles. */
  joinBridgeId?: string;
  /** The bridge a waiting dial's caller and its current trunk attempt share once that attempt
   * answered 183, so its early media reaches the caller (§10.1 "Outbound"). The attempt's answer
   * keeps it as the call's bridge (`takeEarlyBridge`); the attempt ending destroys it. */
  earlyBridgeId?: string;
  /** The caller ID a softphone leg presents for this call, once looked up (`contactName.ts`). */
  softphoneCallerId?: Promise<string>;
  /** §10.2 "Three-way calls": the channel through which the user who added a party to this
   * call's bridge with `*5` is in it; their hanging up ends the bridge for everyone. */
  threeWayInitiatorChannelId?: string;
  /** §10.2 "Three-way calls": a `*5` added leg's own row. Its caller channel is only the
   * disposable feature dial, so the row ends when the added party's answered leg leaves. */
  addedLeg?: boolean;
  /** §10.2 "Voicemail": the caller is in a mailbox deposit, which closes the row itself. Hanging
   * up is how a caller ends a message, and the recording's outcome only follows the channel, so
   * the caller's own channel ending leaves the row to the deposit (`legsEnded.ts`). */
  depositing?: boolean;
  /** The caller's own channel has ended (`legsEnded.ts`'s `endCallerCall`), or left the call
   * for good (`parking.ts`'s park). */
  callerEnded?: boolean;
  /** The user whose channel `callerChannelId` is once an attended transfer handed the caller's
   * place to the transferee (§10.1 "Transfers and pickup"); absent while it is `callerUserId`'s
   * own, who stays the history's caller either way. */
  callerChannelUserId?: string | null;
  /** Who ended the call (`callEnd.ts`): the first hangup request on the caller or an answered
   * leg, and whether the `ended` trace line is written yet. */
  ending?: CallEnding;
};

type CallEnding = {
  by: 'caller' | 'callee' | 'system';
  channelId: string | null;
  logged: boolean;
};

type NewCallParams = {
  id: string;
  direction: Call['direction'];
  callerChannelId: string | null;
  from: string;
  to: string;
  startedAt: string;
  logLevel: CallLogLevel;
  callLogMaxBytes: number;
};

/** The user whose participation `leg` is (§10.2 "Recording semantics", "Call history"): its own
 * user's, or that of the user whose unconditional forward it dials (`Leg.standsInFor`); `null`
 * for a leg with no user behind it, such as an outbound call's trunk leg. */
export function legParticipant(leg: Leg): string | null {
  return leg.userId ?? leg.standsInFor ?? null;
}

/** Builds a fresh `Call` aggregate at the start of routing, before any target is resolved. */
export function newCall(params: NewCallParams): Call {
  const { logLevel, callLogMaxBytes, ...base } = params;
  return {
    ...base,
    callerLegId: newId(),
    didId: null,
    callerUserId: null,
    calleeUserId: null,
    ringGroupId: null,
    answeredByUserId: null,
    bridgeId: null,
    legs: new Map(),
    hops: 0,
    diversions: [],
    log: new CallLog(params.id, logLevel, callLogMaxBytes),
    answeredAt: null,
    status: null,
    parentCallId: null,
    evaluated: new Set(),
    menuAttempts: 0
  };
}

/** The caller's own channel of a call routed from one: every step that answers, plays to, records
 * or bridges the caller runs only for such a call, never for one with no caller channel. */
export function callerChannel(call: Call): string {
  if (call.callerChannelId === null) {
    throw new Error(`call ${call.id} has no caller channel`);
  }
  return call.callerChannelId;
}

/** Reads and clears `call.earlyBridgeId`, the bridge the answer of a waiting dial keeps. */
export function takeEarlyBridge(call: Call): string | null {
  const bridgeId = call.earlyBridgeId ?? null;
  delete call.earlyBridgeId;
  return bridgeId;
}

/** Reads and clears `call.joinBridgeId`, so the bridge is joined by one answer only. */
export function takeJoinBridge(call: Call): string | null {
  const bridgeId = call.joinBridgeId ?? null;
  delete call.joinBridgeId;
  return bridgeId;
}
