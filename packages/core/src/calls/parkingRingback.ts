/**
 * The parked party's bridge moves and the timeout ring-back (§10.2 "Call parking");
 * `parking.ts` owns the slot registry and calls in here.
 */
import { newId } from '@zamfono/shared';

import { ignoreGone } from '../ari/failures.js';
import type { Snapshot } from '../internal/snapshot.js';
import { setChannelLanguage } from '../prompts.js';
import { SIP_NOT_FOUND } from '../sipCodes.js';
import { findForwardTarget, newCall, release, type Call } from './call.js';
import { extensionOf } from './extensionOwner.js';
import { endHold } from './hold.js';
import { trackLeg } from './legs.js';
import { closeCall } from './liveCall.js';
import { startOnwardCall, type OnwardEntry } from './onwardCall.js';
import type { Pipeline } from './pipeline.js';
import { runTarget } from './runTarget.js';
import {
  applyUserDecision,
  runUserStep,
  type UnappliedDecision
} from './userStep.js';

/** Moves the parked party's channel into a fresh bridge of `type` — `holding` for the park itself
 * (§10.2 "Call parking": "moves the other party into a holding bridge"), `mixing` once someone is
 * about to talk to them (a holding bridge mixes nobody's audio) — and destroys the bridge it
 * leaves, so a park never leaves the original conversation's bridge behind. `parked.bridgeId`
 * follows the party. */
export async function moveParkedParty(
  pipeline: Pipeline,
  parked: Call,
  partyChannelId: string,
  type: 'holding' | 'mixing'
): Promise<string> {
  const ari = pipeline.deps.ari;
  const previous = parked.bridgeId;
  // A party held through the API (`hold.ts`) is parked from the bridge it was held out of.
  await endHold(pipeline, previous, previous);
  const bridge = await ari.bridges.create({ type });
  if (previous !== null) {
    await ari.bridges.removeChannel(previous, partyChannelId).catch(ignoreGone);
  }
  await ari.bridges.addChannel(bridge.id, partyChannelId);
  if (previous !== null) {
    await ari.bridges.destroy(previous).catch(ignoreGone);
  }
  // eslint-disable-next-line require-atomic-updates -- `parked` is this park's own aggregate; nothing else writes `bridgeId` while the party is parked
  parked.bridgeId = bridge.id;
  return bridge.id;
}

/**
 * The parker's answered ring-back leg becomes a leg of `parked`, as a retriever's channel does
 * (`parkingRetrieval.ts`): the parker is connected in the parked call from here on (§10.3 "Live
 * calls"), so they may end or transfer it, either side hanging up ends it for the other
 * (`legsEnded.ts`), and their recorded participation carries on in it (§10.2 "Recording
 * semantics"). The ring-back's own row closes as the parker joins.
 */
function takeOverAnsweredLeg(
  pipeline: Pipeline,
  ringback: Call,
  parked: Call
): void {
  const leg = [...ringback.legs.values()].find(
    candidate => candidate.state === 'up'
  );
  if (leg === undefined) {
    return;
  }
  ringback.legs.delete(leg.channelId);
  trackLeg(pipeline, parked, leg);
  const { cdr, presence, recorder } = pipeline.deps;
  if (leg.userId !== null) {
    presence.setCallState(leg.userId, 'inCall', parked.from, null, parked.id);
    presence.setCallState(leg.userId, 'idle', null, null, ringback.id);
  }
  // §7 level `sip`: the parker's dialog is the parked call's leg now, not the ring-back's.
  cdr.registerLeg(parked, leg.channelId);
  recorder.onLegMoved(ringback, parked, leg);
}

type RingbackContext = {
  parkerUserId: string;
  parked: Call;
  partyChannelId: string;
};

/** Where the parked party goes on: `undone`, the parker's own forward or mailbox, else the tenant
 * fallback target (§11.3) as a forward without a caller (§10.1 step 7); `null` with neither. */
function onwardRoute(
  pipeline: Pipeline,
  snapshot: Snapshot,
  undone: UnappliedDecision | null
): ((child: Call) => Promise<void>) | null {
  if (undone !== null) {
    return child => applyUserDecision(pipeline, child, snapshot, undone);
  }
  const targetId = snapshot.settings.fallbackTargetId;
  if (targetId === null) {
    return null;
  }
  const target = findForwardTarget(snapshot, targetId);
  return child => runTarget(pipeline, child, target, null, null);
}

/**
 * §10.2 "Call parking": on an unanswered ring-back, a forward or mailbox of the parker's own rules
 * (`undone`, handed back by the ring-back's user step) takes the parked party; otherwise the
 * tenant fallback target does, released with 404 while the tenant carries none. Like a blind
 * transfer's transferee (§10.1 "Transfers and pickup"), the party goes on in a call of its own, a
 * child of `parked`, whose conversation ends here as answered; the onward call goes `to` the
 * extension the ring-back rang, routed as the parker's call where their own rule sends it on.
 */
async function routeParkedParty(
  pipeline: Pipeline,
  snapshot: Snapshot,
  ctx: RingbackContext,
  onward: { to: string; undone: UnappliedDecision | null }
): Promise<void> {
  const { parked, partyChannelId } = ctx;
  const { undone } = onward;
  const ari = pipeline.deps.ari;
  await ari.channels.stopMoh(partyChannelId).catch(ignoreGone);
  if (parked.bridgeId !== null) {
    await ari.bridges
      .removeChannel(parked.bridgeId, partyChannelId)
      .catch(ignoreGone);
    await ari.bridges.destroy(parked.bridgeId).catch(ignoreGone);
  }
  parked.bridgeId = null;
  const route = onwardRoute(pipeline, snapshot, undone);
  if (route === null) {
    // The party is the one channel left for the release to end.
    parked.callerChannelId = partyChannelId;
    await release(pipeline, parked, SIP_NOT_FOUND, 'missed');
    return;
  }
  const result = undone?.kind ?? 'fallback';
  parked.log.event({ event: 'parkingTimeout', result });
  await closeCall(pipeline, parked, 'answered', false);
  const entry: OnwardEntry = {
    to: onward.to,
    direction: 'internal',
    logLevel: snapshot.settings.callLogLevel,
    asUserId: undone === null ? null : ctx.parkerUserId,
    trace: { parkingTimeout: result }
  };
  await startOnwardCall(
    pipeline,
    parked,
    partyChannelId,
    { snapshot, entry },
    route
  );
}

/**
 * §10.2 "Call parking" timeout: rings the parker back as a fresh internal call to their own
 * extension through the routing pipeline's own user step (`runUserStep`). The ring-back has no
 * caller channel, so it only rings (`Call.callerChannelId`): the party waits in a mixing bridge
 * of its own, which whichever device answers joins through `legs.ts`'s `winLeg`
 * (`existingBridgeId`, handed over as the ring-back's `joinBridgeId`). Its `calls` row closes here
 * on either outcome. On no answer, a forward or mailbox the parker's rules decided takes the
 * parked party; otherwise (a release, no registered device or a ring nobody took with no rule of
 * theirs to follow) the tenant fallback target does.
 */
export async function ringParkerBack(
  pipeline: Pipeline,
  ctx: RingbackContext
): Promise<void> {
  const { parkerUserId, parked, partyChannelId } = ctx;
  const snapshot = await pipeline.deps.cache.get();
  // §9.1: every channel's language is the tenant's. The parked party may be a leg the core
  // originated, which has not been through an entry of its own, and the fallback may play to it.
  await setChannelLanguage(
    pipeline.deps.ari,
    partyChannelId,
    snapshot.settings.language
  );
  const parkerExt = extensionOf(snapshot, { userId: parkerUserId });
  if (parkerExt === null || parked.bridgeId === null) {
    await routeParkedParty(pipeline, snapshot, ctx, {
      to: parkerExt ?? parked.to,
      undone: null
    });
    return;
  }
  const ringback = newCall({
    id: newId(),
    direction: 'internal',
    callerChannelId: null,
    from: parked.from,
    to: parkerExt,
    startedAt: pipeline.deps.now(),
    logLevel: snapshot.settings.callLogLevel,
    callLogMaxBytes: pipeline.deps.callLogMaxBytes
  });
  ringback.calleeUserId = parkerUserId;
  await pipeline.deps.cdr.open(ringback);
  pipeline.registerCall(ringback);
  const bridgeId = await moveParkedParty(
    pipeline,
    parked,
    partyChannelId,
    'mixing'
  );
  ringback.joinBridgeId = bridgeId;
  let undone: UnappliedDecision | null = null;
  try {
    undone = await runUserStep(pipeline, ringback, snapshot, parkerUserId);
  } catch {
    // The party must not stay parked because the parker's own rules failed to run; the fallback
    // below still takes them.
    ringback.log.event({ event: 'ringbackFailed' });
  }
  delete ringback.joinBridgeId;
  if (ringback.status === 'answered' && ringback.answeredByUserId !== null) {
    await pipeline.deps.ari.channels.stopMoh(partyChannelId).catch(ignoreGone);
    parked.answeredByUserId = parkerUserId;
    parked.log.event({ event: 'parkingRetrieved', by: parkerUserId });
    takeOverAnsweredLeg(pipeline, ringback, parked);
    await pipeline.finishCall(ringback);
    return;
  }
  // A row a release or a REST hangup closed already stays as it is; a row still open is closed
  // here, so none stays at `CdrWriter.open`'s placeholder.
  if (ringback.status === null || ringback.status === 'answered') {
    ringback.status ??= 'missed';
    await pipeline.finishCall(ringback);
  }
  await routeParkedParty(pipeline, snapshot, ctx, { to: parkerExt, undone });
}
