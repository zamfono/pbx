/** The Call aggregate (spec §10.1): tracked in memory only — caller channel, legs, bridge, timers,
 * routing cursor; SQLite holds durable outcomes alone, via the CDR writer. */
import type { Selectable } from 'kysely';

import type { DB, Scope } from '@zamfono/shared';

import { ignoreGone, logFailure } from '../ari/failures.js';
import { CallLog, type LogLevel } from '../callLog.js';
import type { Snapshot } from '../internal/snapshot.js';
import { targetFromRow, type ForwardTarget } from '../routing/targets.js';
import type { Diversion } from './forwardContext.js';
import type { GroupLeg } from './groupLegs.js';
import { notifyMissedCall } from './missedCall.js';
import type { Pipeline } from './pipeline.js';
import { sipToHangupCause } from './releaseCause.js';
import { deposit, type DepositReason } from './voicemail.js';

export type CallsRow = Selectable<DB['calls']>;

/** One channel dialed for a call: a device, a find-me leg, a trunk leg or a group member. `endCause`
 * is the Q.850 hangup cause `ringOutcome()` reads, set from `ChannelDestroyed` while ringing.
 * `placing` from before its channel is created until it is dialled (`legOriginate.ts`): such a leg
 * is its placement's to settle, never shown, counted as ringing or hung up by anything else. */
export type Leg = {
  channelId: string;
  kind: 'device' | 'findMe' | 'trunk' | 'member';
  userId: string | null;
  state: 'placing' | 'ringing' | 'up' | 'ended';
  endCause: number | null;
  /** The device a `device` or `member` leg rings, the trunk a `trunk` leg dials over; for the
   * routing trace's `answered` line (§7). */
  deviceId?: string;
  trunkId?: string;
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

export type CallEnding = {
  by: 'caller' | 'callee' | 'system';
  channelId: string | null;
  logged: boolean;
};

export type NewCallParams = {
  id: string;
  direction: Call['direction'];
  callerChannelId: string | null;
  from: string;
  to: string;
  startedAt: string;
  logLevel: LogLevel;
  callLogMaxBytes: number;
};

/** Builds a fresh `Call` aggregate at the start of routing, before any target is resolved. */
export function newCall(params: NewCallParams): Call {
  const { logLevel, callLogMaxBytes, ...base } = params;
  return {
    ...base,
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

/** Reads and clears `call.joinBridgeId`, so the bridge is joined by one answer only. */
export function takeJoinBridge(call: Call): string | null {
  const bridgeId = call.joinBridgeId ?? null;
  delete call.joinBridgeId;
  return bridgeId;
}

/** The `ForwardTarget` a `forward_targets` row represents; throws on a dangling id (FK-guaranteed present). */
export function findForwardTarget(
  snapshot: Snapshot,
  targetId: string
): ForwardTarget {
  const row = snapshot.forwardTargets.find(
    candidate => candidate.id === targetId
  );
  if (!row) {
    throw new Error(`forwardTargets: missing row ${targetId}`);
  }
  return targetFromRow(row);
}

type EntryOrOutcomeCondition =
  'unconditional' | 'dnd' | 'busy' | 'noAnswer' | 'offline';

/** `user_forward_rules` for `userId`, keyed by condition, resolved to their `ForwardTarget`s. */
export function buildUserRules(
  snapshot: Snapshot,
  userId: string
): Partial<Record<EntryOrOutcomeCondition, ForwardTarget>> {
  const rules: Partial<Record<EntryOrOutcomeCondition, ForwardTarget>> = {};
  for (const row of snapshot.userForwardRules) {
    if (row.userId !== userId) {
      continue;
    }
    rules[row.condition as EntryOrOutcomeCondition] = findForwardTarget(
      snapshot,
      row.targetId
    );
  }
  return rules;
}

/** Hangs up the caller with SIP response `code`, records `status`, and closes the call's CDR entry. */
export async function release(
  pipeline: Pipeline,
  call: Call,
  code: number,
  status: CallsRow['status']
): Promise<void> {
  call.log.event({ event: 'release', code });
  call.status = status;
  if (status === 'missed') {
    await notifyMissedCall(pipeline, call);
  }
  // §7: the channel whose `call_qos` row this call has is noted before it goes.
  pipeline.deps.cdr.noteQosLegs(call);
  if (call.callerChannelId !== null) {
    await pipeline.deps.ari.channels
      .hangup(call.callerChannelId, { reasonCode: sipToHangupCause(code) })
      .catch(ignoreGone)
      .catch(
        logFailure(pipeline.deps.logger, 'caller release', { callId: call.id })
      );
  }
  await pipeline.finishCall(call);
}
/** A user's or a ring group's mailbox, the two owners a target can end into. */
export type Owner = { userId: string } | { ringGroupId: string };

function ownerMailboxEnabled(owner: Owner, snapshot: Snapshot): boolean {
  return 'userId' in owner
    ? snapshot.users.find(row => row.id === owner.userId)?.mailboxEnabled === 1
    : snapshot.ringGroups.find(row => row.id === owner.ringGroupId)
        ?.mailboxEnabled === 1;
}

/** The last visited target's mailbox when it has one enabled, else `fallback`'s release. */
export async function endTargetOwner(
  pipeline: Pipeline,
  call: Call,
  owner: Owner | null,
  snapshot: Snapshot,
  fallback: {
    code: number;
    status: CallsRow['status'];
    reason: DepositReason;
  }
): Promise<void> {
  if (owner !== null && ownerMailboxEnabled(owner, snapshot)) {
    await deposit(pipeline, call, owner, fallback.reason);
    return;
  }
  await release(pipeline, call, fallback.code, fallback.status);
}

export {
  callLogMaxBytesFromEnv,
  raiseLogLevel,
  toLogLevel
} from './callLogLevel.js';
