/** Inbound call entry (§10.1 step 1; §9.2 `inbound,<exten>`) and pipeline steps 2-4, 6 and 7
 * (ring groups are `ringGroup.ts`'s): OOO, opening hours, the target-user and target-menu steps,
 * reject-anonymous, a target's decisions and announcements, and each target kind's dispatch; hop
 * counting is `runTarget.ts`'s. */
import { newId } from '@zamfono/shared';

import type { AriEventOf } from '../ari/events.js';
import { ignoreGone } from '../ari/failures.js';
import { userById, type Snapshot } from '../internal/snapshot.js';
import { setChannelLanguage, soundLanguage } from '../prompts.js';
import type { Resolution, ResolvedTarget } from '../routing/decision.js';
import {
  isBlocked,
  rejectAnonymous,
  resolveInbound
} from '../routing/entry.js';
import { targetFromRow, type ForwardTarget } from '../routing/targets.js';
import { SIP_DECLINE, SIP_SERVER_ERROR } from '../sipCodes.js';
import { announce, hangUp } from './announce.js';
import { newCall, type Call } from './call.js';
import { resolveOnCall } from './callDecisions.js';
import { raiseLogLevel } from './callLogLevel.js';
import { noteNumberForward, type TenantNumber } from './forwardContext.js';
import { dialForwardTarget } from './forwardDial.js';
import type { Forwarder } from './forwardLeg.js';
import { runHttpRequest } from './httpRequestNode.js';
import { applyOooAndHours, targetIdentity } from './inboundSchedule.js';
import { inboundBoundary } from './inboundTrunk.js';
import { playMenu } from './menu.js';
import { isLocalDiallingHalf } from './pendingTransfer.js';
import type { Pipeline } from './pipeline.js';
import { endTargetOwner, release } from './release.js';
import { ringGroup } from './ringGroup.js';
import { endUnresolved } from './runTarget.js';
import { runUserStep } from './userStep.js';
import { deposit } from './voicemail.js';
import { dialWebSocketTarget } from './webSocketTarget.js';

/** `enterTarget` once the target's announcements have played: what its kind does. */
async function enterKind(
  pipeline: Pipeline,
  call: Call,
  target: Exclude<ResolvedTarget, { kind: 'hangup' }>,
  forwarder: Forwarder | null
): Promise<void> {
  if (target.kind === 'mailboxUser' || target.kind === 'mailboxRingGroup') {
    const owner =
      target.kind === 'mailboxUser'
        ? { userId: target.userId }
        : { ringGroupId: target.ringGroupId };
    await deposit(pipeline, call, owner, 'target');
    return;
  }
  if (target.kind === 'external' || target.kind === 'sip') {
    await dialForwardTarget(pipeline, call, target, forwarder);
    return;
  }
  if (target.kind === 'webSocket' || target.kind === 'httpRequest') {
    await (target.kind === 'webSocket'
      ? dialWebSocketTarget(pipeline, call, target, forwarder)
      : runHttpRequest(pipeline, call, target, forwarder));
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
      ? (userById(snapshot, target.userId)?.rejectAnonymous ?? null)
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
      code: SIP_DECLINE,
      status: 'blocked',
      reason: 'rejectAnonymous'
    });
    return;
  }

  if (await applyOooAndHours(pipeline, call, snapshot, scope)) {
    return;
  }

  if (target.kind === 'user') {
    await runUserStep(pipeline, call, snapshot, target.userId);
    return;
  }
  if (target.kind === 'menu') {
    await playMenu(pipeline, call, target.menuId);
    return;
  }
  // The last of `ForwardTarget`'s kinds: every other one returned above.
  await ringGroup(pipeline, call, target.ringGroupId);
}

/** A resolved target applied (§10.1 step 7): the announcements of the decisions it passed and its
 * own play first, in order, then what its kind does. */
export async function enterResolved(
  pipeline: Pipeline,
  call: Call,
  resolution: Extract<Resolution, { kind: 'resolved' }>,
  forwarder: Forwarder | null
): Promise<void> {
  const { target, announcements } = resolution;
  for (const audioId of announcements) {
    // eslint-disable-next-line no-await-in-loop -- one after the other, to the caller
    if (!(await announce(pipeline, call, audioId))) {
      return;
    }
  }
  if (target.kind === 'hangup') {
    await hangUp(pipeline, call, announcements.length > 0);
    return;
  }
  await enterKind(pipeline, call, target, forwarder);
}

/** Step 1 "Entry" (§10.1): the target's decisions resolved, then reject-anonymous, OOO/hours and
 * the target's own step. Exported for outbound dialling of an internal extension or own DID, which
 * enters here without `runTarget`'s hop counting (§10.1 Outbound steps 3 and 5). `forwarder` is
 * the user whose own rule forwarded here, whose call an external target is dialled as, else `null`
 * (§10.1 step 7); `number` the tenant number whose own target this is, its hop recorded for the
 * target the decisions resolve to. */
export async function enterTarget(
  pipeline: Pipeline,
  call: Call,
  target: ForwardTarget,
  forwarder: Forwarder | null,
  number?: TenantNumber
): Promise<void> {
  const resolution = await resolveOnCall(pipeline, call, target);
  if (resolution.kind !== 'resolved') {
    await endUnresolved(pipeline, call, resolution, forwarder);
    return;
  }
  if (number !== undefined) {
    noteNumberForward(
      await pipeline.deps.cache.get(),
      call,
      number,
      resolution.target
    );
  }
  await enterResolved(pipeline, call, resolution, forwarder);
}

/** Entry's DID lookup for an inbound call (§10.1 step 1, §11.3): the called number's DID, else
 * the block or tenant fallback, entered without a caller (§10.1 step 7), else a 404 release. */
async function enterCalled(
  pipeline: Pipeline,
  call: Call,
  snapshot: Snapshot
): Promise<void> {
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
  // §11.3: a fallback names the block it came from (`null`: the tenant's) and the number looked up.
  call.log.event(
    resolved.kind === 'fallback'
      ? {
          event: 'entry',
          result: resolved.kind,
          blockId: resolved.blockId,
          called: call.to
        }
      : { event: 'entry', result: resolved.kind }
  );
  const targetRow = snapshot.forwardTargets.find(
    row => row.id === resolved.targetId
  );
  if (!targetRow) {
    // The foreign key keeps a DID's or block's target row present.
    await release(pipeline, call, SIP_SERVER_ERROR, 'failed');
    return;
  }
  // §10.1 step 7: a DID's or fallback's own target is dialled without a caller, the called number
  // its forward's hop.
  await enterTarget(
    pipeline,
    call,
    targetFromRow(targetRow, snapshot.forwardTargets),
    null,
    resolved.kind === 'did'
      ? { didId: resolved.didId }
      : { fallbackBlockId: resolved.blockId }
  );
}

/** A `from-trunk` StasisStart (§9.2): both numbers normalized with the delivering trunk's
 * `inbound_number_format` (§9.4 "Inbound number normalization"), then Entry. */
export async function handleInboundStart(
  pipeline: Pipeline,
  ev: AriEventOf<'StasisStart'>
): Promise<void> {
  const channel = ev.channel;
  // §9.2: only a trunk's chan_pjsip leg or the Local half a trunk-side transfer dials through
  // enters `from-trunk` as a call. Any other channel is refused before it reaches a target.
  if (
    !channel.name.startsWith('PJSIP/') &&
    !isLocalDiallingHalf(channel.name)
  ) {
    pipeline.deps.logger.warn(
      { channel: channel.name },
      'inbound entry from a channel that is no trunk leg'
    );
    await pipeline.deps.ari.channels.hangup(channel.id).catch(ignoreGone);
    return;
  }
  // §9.4 "Channels": the leg occupies one of the delivering trunk's channels for its lifetime,
  // watched from here so a hangup during the config read below is not missed.
  const countInboundLeg = pipeline.deps.trunkChannels.watchInboundLeg(
    channel.id
  );
  const snapshot = await pipeline.deps.cache.get();
  const { trunkId, called, calledFromTo, from } = await inboundBoundary(
    pipeline.deps.ari,
    channel,
    ev.args[1] ?? '',
    snapshot
  );
  countInboundLeg(trunkId);

  const call = newCall({
    id: newId(),
    direction: 'inbound',
    callerChannelId: channel.id,
    from,
    to: called,
    startedAt: pipeline.deps.now(),
    logLevel: snapshot.settings.callLogLevel,
    callLogMaxBytes: pipeline.deps.callLogMaxBytes
  });
  if (trunkId !== null) {
    call.callerTrunkId = trunkId;
  }
  // §7: the delivering trunk's diagnostics override counts toward the call's level.
  raiseLogLevel(
    call.log,
    snapshot.trunks.find(row => row.id === trunkId) ?? null,
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
    channel.id,
    soundLanguage(snapshot.settings)
  );

  const blocklist = snapshot.blockedNumbers.map(row => ({
    number: row.number,
    isPrefix: row.isPrefix === 1
  }));
  if (isBlocked(from, blocklist)) {
    call.log.event({ event: 'entry', result: 'blocked' });
    await release(pipeline, call, SIP_DECLINE, 'blocked');
    return;
  }

  await enterCalled(pipeline, call, snapshot);
}
