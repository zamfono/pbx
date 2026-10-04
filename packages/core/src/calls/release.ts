/** How a call ends from the pipeline's side (§11.2 `calls.status`): the caller released with a
 * SIP response, or a target's mailbox taking the call instead. */
import { logUnlessGone } from '../ari/failures.js';
import { userById, type Snapshot } from '../internal/snapshot.js';
import type { Call, CallsRow } from './call.js';
import { settleStatus } from './missedCall.js';
import type { Pipeline } from './pipeline.js';
import { sipToHangupCause } from './releaseCause.js';
import { deposit, type DepositReason } from './voicemail.js';

/**
 * Closes out a call that ends with its caller's channel alone (§11.2 `calls.status`): settles
 * `status` (`settleStatus`), hangs the caller up, with the Q.850 `reasonCode` where one is given,
 * and writes the call's history entry.
 */
export async function endCall(
  pipeline: Pipeline,
  call: Call,
  status: CallsRow['status'],
  reasonCode?: number
): Promise<void> {
  await settleStatus(pipeline, call, status);
  // §7: the channel whose `call_qos` row this call has is noted before it goes.
  pipeline.deps.cdr.noteQosLegs(call);
  if (call.callerChannelId !== null) {
    await pipeline.deps.ari.channels
      .hangup(call.callerChannelId, { reasonCode })
      .catch(
        logUnlessGone(pipeline.deps.logger, 'caller hangup', {
          callId: call.id
        })
      );
  }
  await pipeline.finishCall(call);
}

/** Hangs up the caller with SIP response `code`, settles `status`, and closes the call's CDR entry. */
export async function release(
  pipeline: Pipeline,
  call: Call,
  code: number,
  status: CallsRow['status']
): Promise<void> {
  call.log.event({ event: 'release', code });
  await endCall(pipeline, call, status, sipToHangupCause(code));
}

/** A user's or a ring group's mailbox, the two owners a target can end into. */
export type Owner = { userId: string } | { ringGroupId: string };

function ownerMailboxEnabled(owner: Owner, snapshot: Snapshot): boolean {
  return 'userId' in owner
    ? userById(snapshot, owner.userId)?.mailboxEnabled === 1
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
