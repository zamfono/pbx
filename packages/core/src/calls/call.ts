/** The Call aggregate (spec §10.1): tracked in memory only — caller channel, legs, bridge, timers,
 * routing cursor; SQLite holds durable outcomes alone, via the CDR writer (Task 32). */
import type { Selectable } from 'kysely';

import type { DB, Scope } from '@zamfono/shared';

import { CallLog, type LogLevel } from '../callLog.js';
import type { Snapshot } from '../internal/server.js';
import { targetFromRow, type ForwardTarget } from '../routing/targets.js';
import type { Diversion } from './forwardContext.js';
import type { GroupLeg } from './groupLegs.js';
import { notifyMissedCall } from './missedCall.js';
import type { Pipeline } from './pipeline.js';
import { sipToHangupCause } from './releaseCause.js';
import type { DepositReason } from './voicemail.js';

export type CallsRow = Selectable<DB['calls']>;

/** One channel dialed for a call: a device, a find-me leg, a trunk leg or a group member. `endCause`
 * is the Q.850 hangup cause `ringOutcome()` reads, set from `ChannelDestroyed` while ringing. */
export type Leg = {
  channelId: string;
  kind: 'device' | 'findMe' | 'trunk' | 'member';
  userId: string | null;
  state: 'ringing' | 'up' | 'ended';
  endCause: number | null;
  /** The device a `device` or `member` leg rings, the trunk a `trunk` leg dials over; for the
   * routing trace's `answered` line (§7). */
  deviceId?: string;
  trunkId?: string;
};

export type Call = {
  id: string;
  direction: 'inbound' | 'outbound' | 'internal';
  callerChannelId: string;
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
  /** §10.2 "Call parking": a system-initiated ring-back rings its target and stops there. Its
   * caller is a placeholder channel with nobody behind it, so the target's forward, mailbox and
   * release rules have no caller to act on; the initiator decides what follows an unanswered
   * ring. */
  ringOnly?: boolean;
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
  /** The caller's own channel has ended (`legsEnded.ts`'s `endCallerCall`). */
  callerEnded?: boolean;
  /** Who ended the call (`callEnd.ts`): the first hangup request on the caller or an answered
   * leg, and whether the `ended` trace line is written yet. */
  ending?: CallEnding;
};

export type CallEnding = {
  by: 'caller' | 'callee' | 'system';
  channelId: string;
  logged: boolean;
};

export type NewCallParams = {
  id: string;
  direction: Call['direction'];
  callerChannelId: string;
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
  pipeline.deps.cdr.noteQosLegs?.(call);
  await pipeline.deps.ari.channels
    .hangup(call.callerChannelId, { reasonCode: sipToHangupCause(code) })
    .catch(() => undefined);
  await pipeline.deps.cdr.finish(call);
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
    await pipeline.deposit(call, owner, fallback.reason);
    return;
  }
  await release(pipeline, call, fallback.code, fallback.status);
}

export {
  callLogMaxBytesFromEnv,
  raiseLogLevel,
  toLogLevel
} from './callLogLevel.js';
