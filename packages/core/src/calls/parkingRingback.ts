/**
 * The parked party's bridge moves and the timeout ring-back (§10.2 "Call parking"), its own
 * module beside `parking.ts` so both stay under the repository's `max-lines` lint rule;
 * `parking.ts` owns the slot registry and calls in here.
 */
import { newId } from '@zamfono/shared';

import type { Snapshot } from '../internal/server.js';
import { setChannelLanguage } from '../prompts.js';
import { joinExistingBridgeOnAnswer, takeJoinBridge } from './bridgeJoin.js';
import {
  callLogMaxBytesFromEnv,
  findForwardTarget,
  newCall,
  release,
  toLogLevel,
  type Call
} from './call.js';
import { RELEASE_CODE_NOT_FOUND } from './featureCall.js';
import type { Pipeline } from './pipeline.js';
import { runUserStep } from './userStep.js';

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
  const bridge = await ari.bridges.create({ type });
  if (previous !== null) {
    await ari.bridges
      .removeChannel(previous, partyChannelId)
      .catch(() => undefined);
  }
  await ari.bridges.addChannel(bridge.id, partyChannelId);
  if (previous !== null) {
    await ari.bridges.destroy(previous).catch(() => undefined);
  }
  // eslint-disable-next-line require-atomic-updates -- `parked` is this park's own aggregate; nothing else writes `bridgeId` while the party is parked
  parked.bridgeId = bridge.id;
  return bridge.id;
}

type RingbackContext = {
  parkerUserId: string;
  parked: Call;
  partyChannelId: string;
};

/** §10.2 "Call parking": on an unanswered ring-back, the parked party goes to the tenant fallback
 * target (§11.3), released with 404 while the tenant carries none, as an ordinary re-entry of the
 * routing pipeline — `parked` continues as the same `calls` row, its `callerChannelId` becoming
 * the party's own still-controlled channel now that nobody else shares its bridge. */
async function routeParkedPartyToFallback(
  pipeline: Pipeline,
  snapshot: Snapshot,
  parked: Call,
  partyChannelId: string
): Promise<void> {
  const ari = pipeline.deps.ari;
  await ari.channels.stopMoh(partyChannelId).catch(() => undefined);
  if (parked.bridgeId !== null) {
    await ari.bridges
      .removeChannel(parked.bridgeId, partyChannelId)
      .catch(() => undefined);
    await ari.bridges.destroy(parked.bridgeId).catch(() => undefined);
  }
  // eslint-disable-next-line require-atomic-updates -- `parked` is this park's own aggregate; no concurrent write races this reassignment before the awaits below
  parked.bridgeId = null;
  // eslint-disable-next-line require-atomic-updates -- see above
  parked.callerChannelId = partyChannelId;
  const targetId = snapshot.settings.fallbackTargetId;
  if (targetId === null) {
    await release(pipeline, parked, RELEASE_CODE_NOT_FOUND, 'missed');
    return;
  }
  parked.log.event({ event: 'parkingTimeout', result: 'fallback' });
  // The tenant fallback forwards without a caller (§10.1 step 7).
  await pipeline.runTarget(parked, findForwardTarget(snapshot, targetId), null);
}

/**
 * §10.2 "Call parking" timeout: rings the parker back as a fresh internal call to their own
 * extension through the routing pipeline's own user step (`runUserStep`), so the parker's rules
 * — DND, forwards, mailbox — apply exactly as they would for any other call to that extension.
 * The ring-back's own `callerChannelId` is a placeholder, never a real ARI channel: the party
 * waits in a mixing bridge of its own, which whichever device answers joins through `legs.ts`'s
 * `winLeg` (`existingBridgeId`, handed over via `joinExistingBridgeOnAnswer`). Its `calls` row
 * closes here on either outcome. On no answer (a DND skip, an unreachable mailbox decision, no
 * registered device or a ring nobody took), the parked party goes to the tenant fallback target.
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
  const parkerExt = snapshot.extensions.find(
    row => row.userId === parkerUserId
  )?.ext;
  if (parkerExt === undefined || parked.bridgeId === null) {
    await routeParkedPartyToFallback(
      pipeline,
      snapshot,
      parked,
      partyChannelId
    );
    return;
  }
  const ringback = newCall({
    id: newId(),
    direction: 'internal',
    callerChannelId: `parkRingback:${parked.id}`,
    from: parked.from,
    to: parkerExt,
    startedAt: pipeline.deps.now(),
    logLevel: toLogLevel(snapshot.settings.callLogLevel),
    callLogMaxBytes: callLogMaxBytesFromEnv()
  });
  ringback.calleeUserId = parkerUserId;
  await pipeline.deps.cdr.open(ringback);
  const bridgeId = await moveParkedParty(
    pipeline,
    parked,
    partyChannelId,
    'mixing'
  );
  joinExistingBridgeOnAnswer(pipeline, ringback.id, bridgeId);
  try {
    ringback.ringOnly = true;
    await runUserStep(pipeline, ringback, snapshot, parkerUserId);
  } catch {
    // The party must not stay parked because the parker's own rules failed to run (the
    // placeholder channel answers no ARI request); the fallback below still takes them.
    ringback.log.event({ event: 'ringbackFailed' });
  }
  takeJoinBridge(pipeline, ringback.id);
  if (ringback.status === 'answered' && ringback.answeredByUserId !== null) {
    await pipeline.deps.ari.channels
      .stopMoh(partyChannelId)
      .catch(() => undefined);
    parked.answeredByUserId = parkerUserId;
    parked.log.event({ event: 'parkingRetrieved', by: parkerUserId });
    await pipeline.deps.cdr.finish(ringback);
    return;
  }
  // A release, a deposit or a forward through `runUserStep` closes the ring-back's own row
  // itself; a row still open is closed here, so none stays at `CdrWriter.open`'s placeholder.
  if (ringback.status === null || ringback.status === 'answered') {
    ringback.status ??= 'missed';
    await pipeline.deps.cdr.finish(ringback);
  }
  await routeParkedPartyToFallback(pipeline, snapshot, parked, partyChannelId);
}
