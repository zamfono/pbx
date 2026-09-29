/** Inbound call entry (§10.1 step 1; §9.2 `inbound,<exten>`) and pipeline steps 2-4, 6 and 7
 * (ring groups are Task 29): OOO, opening hours, the target-user and target-menu steps,
 * reject-anonymous, and forward-target hop counting. */
import { newId } from '@zamfono/shared';

import type { AriEvent, Channel } from '../ari/types.js';
import { setChannelLanguage } from '../prompts.js';
import {
  isBlocked,
  rejectAnonymous,
  resolveInbound
} from '../routing/entry.js';
import {
  nextHop,
  targetFromRow,
  type ForwardTarget
} from '../routing/targets.js';
import { announce } from './announce.js';
import {
  callLogMaxBytesFromEnv,
  endTargetOwner,
  newCall,
  raiseLogLevel,
  release,
  toLogLevel,
  type Call,
  type Owner
} from './call.js';
import { applyOooAndHours, targetIdentity } from './inboundSchedule.js';
import { inboundBoundary } from './inboundTrunk.js';
import { playMenu } from './menu.js';
import { dialForwardTarget } from './outboundExternal.js';
import type { Pipeline } from './pipeline.js';
import { ringGroup } from './ringGroup.js';
import { runUserStep } from './userStep.js';
import { deposit } from './voicemail.js';

const RELEASE_CODE_REJECTED = 603;
const RELEASE_CODE_UNAVAILABLE = 480;
// A DID/block's forward_targets row missing from the snapshot (FK-guaranteed present).
const RELEASE_CODE_SERVER_ERROR = 500;

/** Step 1 "Entry" for an already-resolved target (§10.1): reject-anonymous, OOO/hours, then the
 * target's own step. Exported for Task 30's internal extension and own-DID dialling, which enter
 * here directly, without `runTarget`'s hop counting (§10.1 Outbound steps 3 and 5). `asUser` is
 * the user whose own rule forwarded here, whose call an external target is dialled as (§10.1
 * step 7), or `null` when a DID, menu, ring group or tenant rule forwards; no other target kind
 * reads it. */
export async function enterTarget(
  pipeline: Pipeline,
  call: Call,
  target: ForwardTarget,
  asUser: string | null
): Promise<void> {
  if (target.kind === 'mailboxUser') {
    await deposit(pipeline, call, { userId: target.userId });
    return;
  }
  if (target.kind === 'mailboxRingGroup') {
    await deposit(pipeline, call, { ringGroupId: target.ringGroupId });
    return;
  }
  if (target.kind === 'announcement') {
    await announce(pipeline, call, target.audioId);
    return;
  }
  if (target.kind === 'external') {
    await dialForwardTarget(pipeline, call, target.number, asUser);
    return;
  }

  const snapshot = await pipeline.deps.cache.get();
  // The current target: `callee_user_id` is NULL while it is a ring group (§11.2), and the
  // hop-limit fallback reads the pair as the last target's owner (step 7).
  if (target.kind === 'user') {
    call.calleeUserId = target.userId;
  } else if (target.kind === 'ringGroup') {
    call.calleeUserId = null;
    call.ringGroupId = target.ringGroupId;
  }
  const { scope, owner } = targetIdentity(target);

  const tenantDefault = snapshot.settings.rejectAnonymous === 1;
  const ownRejectAnonymous =
    target.kind === 'user'
      ? (snapshot.users.find(row => row.id === target.userId)
          ?.rejectAnonymous ?? null)
      : null;
  const rejectOverride =
    ownRejectAnonymous === null ? null : ownRejectAnonymous === 1;
  if (
    rejectAnonymous(
      call.from,
      { rejectAnonymous: rejectOverride },
      tenantDefault
    )
  ) {
    await endTargetOwner(pipeline, call, owner, snapshot, {
      code: RELEASE_CODE_REJECTED,
      status: 'blocked'
    });
    return;
  }

  if (!call.evaluated.has(scope)) {
    call.evaluated.add(scope);
    if (await applyOooAndHours(pipeline, call, snapshot, scope)) {
      return;
    }
  }

  if (target.kind === 'user') {
    await runUserStep(pipeline, call, snapshot, target.userId);
    return;
  }
  if (target.kind === 'menu') {
    await playMenu(pipeline, call, target.menuId);
    return;
  }
  // The last of `ForwardTarget`'s kinds: the two mailboxes, the announcement, the user and the
  // menu each returned above.
  await ringGroup(pipeline, call, target.ringGroupId);
}

/** Step 7 "Forward targets": hop counting, then dispatch, or the hop-limit mailbox fallback.
 * `asUser` is `enterTarget`'s: the forwarding user, `null` for a forward nobody's own rule made. */
export async function runTarget(
  pipeline: Pipeline,
  call: Call,
  target: ForwardTarget,
  asUser: string | null
): Promise<void> {
  const hop = nextHop(call.hops, target);
  if (!hop.ok) {
    call.log.event({ event: 'hopLimit', hops: call.hops });
    const snapshot = await pipeline.deps.cache.get();
    let owner: Owner | null = null;
    if (call.calleeUserId !== null) {
      owner = { userId: call.calleeUserId };
    } else if (call.ringGroupId !== null) {
      owner = { ringGroupId: call.ringGroupId };
    }
    await endTargetOwner(pipeline, call, owner, snapshot, {
      code: RELEASE_CODE_UNAVAILABLE,
      status: 'missed'
    });
    return;
  }
  call.hops = hop.hops;
  await enterTarget(pipeline, call, target, asUser);
}

/** A `from-trunk` StasisStart (§9.2): both numbers normalized with the delivering trunk's
 * `inbound_number_format` (§9.4 "Inbound number normalization"), then Entry. */
export async function handleInboundStart(
  pipeline: Pipeline,
  ev: AriEvent
): Promise<void> {
  const channel = ev.channel as Channel;
  const args = (ev.args as string[] | undefined) ?? [];
  // §9.4 "Channels": the leg occupies one of the delivering trunk's channels for its lifetime,
  // watched from here so a hangup during the config read below is not missed.
  const countInboundLeg = pipeline.deps.trunkState?.watchInboundLeg(channel.id);
  const snapshot = await pipeline.deps.cache.get();
  const { trunkId, called, calledFromTo, from } = await inboundBoundary(
    pipeline.deps.ari,
    channel,
    args[1] ?? '',
    snapshot
  );
  countInboundLeg?.(trunkId);

  const call = newCall({
    id: newId(),
    direction: 'inbound',
    callerChannelId: channel.id,
    from,
    to: called,
    startedAt: pipeline.deps.now(),
    logLevel: toLogLevel(snapshot.settings.callLogLevel),
    callLogMaxBytes: callLogMaxBytesFromEnv()
  });
  // §7: the delivering trunk's diagnostics override counts toward the call's level.
  raiseLogLevel(
    call.log,
    snapshot.trunks.find(row => row.id === trunkId),
    call.startedAt
  );
  await pipeline.deps.cdr.open(call);
  pipeline.registerCall(call);
  // §9.4 "Inbound numbers": the trunk that identified the call is recorded in its routing trace.
  // The called number's source is recorded where it was not the Request-URI (§9.4), so a
  // registration trunk's routing on its `To` header shows in the trace at the `events` level.
  call.log.event(
    calledFromTo
      ? { event: 'trunk', trunkId, calledFrom: 'to' }
      : { event: 'trunk', trunkId }
  );
  await setChannelLanguage(
    pipeline.deps.ari,
    call.callerChannelId,
    snapshot.settings.language
  );

  const blocklist = snapshot.blockedNumbers.map(row => ({
    number: row.number,
    isPrefix: row.isPrefix === 1
  }));
  if (isBlocked(from, blocklist)) {
    call.log.event({ event: 'entry', result: 'blocked' });
    await release(pipeline, call, RELEASE_CODE_REJECTED, 'blocked');
    return;
  }

  const resolved = resolveInbound(
    call.to,
    snapshot.dids,
    snapshot.didBlocks,
    snapshot.settings.fallbackTargetId
  );
  if (resolved.kind === 'release') {
    // Why the call is refused, at the default `events` level: the number looked up matched no
    // DID, no number block and there is no tenant-wide fallback (§10.1 Entry).
    call.log.event({ event: 'entry', result: 'noDid', called: call.to });
    await release(pipeline, call, resolved.code, 'failed');
    return;
  }
  if (resolved.kind === 'did') {
    call.didId = resolved.didId;
  }
  call.log.event({ event: 'entry', result: resolved.kind });
  const targetRow = snapshot.forwardTargets.find(
    row => row.id === resolved.targetId
  );
  if (!targetRow) {
    await release(pipeline, call, RELEASE_CODE_SERVER_ERROR, 'failed');
    return;
  }
  // §10.1 step 7: a DID's own target is dialled without a caller.
  await enterTarget(pipeline, call, targetFromRow(targetRow), null);
}
