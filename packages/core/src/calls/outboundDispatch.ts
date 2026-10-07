/**
 * The dispatch of a resolved dialled string (§10.1 "Outbound" steps 1-6), whoever dialled it: a
 * device's own dial (`outbound.ts`), click-to-dial's originated call once its device answered
 * (`clickToDial.ts`) and a transferee's onward call (`transfers.ts`). A feature code runs, an
 * emergency or external number goes through `emergency.ts` or §9.4's trunk selection as the
 * dialling user's call, an own DID enters at its target and an internal extension at Entry, or a
 * parking slot retrieves the call parked there.
 */
import type { CallLogLevel } from '@zamfono/shared';

import { ignoreGone } from '../ari/failures.js';
import { ERROR_TONE_MEDIA, ERROR_TONE_MS } from '../indications.js';
import type { Snapshot } from '../internal/snapshot.js';
import { resolveDialed, type DialAction } from '../routing/outbound.js';
import { findForwardTarget } from '../routing/targets.js';
import { SIP_NOT_FOUND } from '../sipCodes.js';
import { callerChannel, type Call } from './call.js';
import { dialEmergency, emergencyLogLevel } from './emergency.js';
import { handleFeature } from './features.js';
import { noteBlindTransfer, noteNumberForward } from './forwardContext.js';
import { enterTarget } from './inbound.js';
import { dialExternal } from './outboundExternal.js';
import { resolveDialedContext, toFor } from './outboundLookup.js';
import { retrieveParkedCall } from './parkingRetrieval.js';
import type { Pipeline } from './pipeline.js';
import { playToneAndWait } from './playback.js';
import { release } from './release.js';

export type ResolvedTarget = {
  action: DialAction;
  direction: Call['direction'];
  to: string;
};

/** What `target` resolves to when dialled (§10.1 "Outbound" steps 1-5) and the `Call` fields it
 * fixes (§11.2 `calls.direction`). */
export function resolveTarget(
  snapshot: Snapshot,
  target: string
): ResolvedTarget {
  const action = resolveDialed(target, resolveDialedContext(snapshot));
  const direction =
    action.kind === 'external' || action.kind === 'emergency'
      ? 'outbound'
      : 'internal';
  return { action, direction, to: toFor(action, target) };
}

/** The trace level a call to `action` starts at: the tenant's configured level, raised to
 * `events` for an emergency number (§10.1 "Emergency calls"). */
export function logLevelFor(
  snapshot: Snapshot,
  action: DialAction,
  nowIso: string
): CallLogLevel {
  const configured = snapshot.settings.callLogLevel;
  return action.kind === 'emergency'
    ? emergencyLogLevel(configured, nowIso)
    : configured;
}

/** An empty parking slot's short error tone, then a 404 release (§10.1 Outbound step 3). */
async function playErrorToneAndRelease(
  pipeline: Pipeline,
  call: Call
): Promise<void> {
  const channelId = callerChannel(call);
  const ari = pipeline.deps.ari;
  await ari.channels.answer(channelId).catch(ignoreGone);
  await playToneAndWait(
    ari,
    channelId,
    ERROR_TONE_MEDIA,
    `${channelId}:error-tone`,
    ERROR_TONE_MS
  );
  await release(pipeline, call, SIP_NOT_FOUND, 'failed');
}

/** How a resolved string is dialled: as `asUser`'s call, and whether it is a blind transfer's
 * onward call, whose forwarding context starts with the transferrer's deflection (§9.4 "Forwarded
 * calls"). */
type DialAs = {
  snapshot: Snapshot;
  asUser: string | null;
  blindTransfer?: true;
};

/** An emergency or external number, dialled as `dial.asUser`'s call through the pipeline's
 * `TrunkChannels` (§9.4); a blind transfer's external leg carries its forwarding context. */
async function dialTrunk(
  pipeline: Pipeline,
  call: Call,
  action: Extract<DialAction, { kind: 'external' | 'emergency' }>,
  dial: DialAs
): Promise<void> {
  const { trunkChannels } = pipeline.deps;
  const { asUser } = dial;
  if (action.kind === 'emergency') {
    await dialEmergency(pipeline, trunkChannels, call, action.number, asUser);
    return;
  }
  await dialExternal(
    {
      pipeline,
      trunkChannels,
      ...(dial.blindTransfer === true
        ? { forward: { diversions: [...call.diversions], headers: [] } }
        : {})
    },
    call,
    action.number,
    asUser,
    action.clir
  );
}

async function dispatchExtension(
  pipeline: Pipeline,
  call: Call,
  action: Extract<DialAction, { kind: 'extension' }>
): Promise<void> {
  // §10.1 step 3/7: an internal extension enters at Entry; it is the call's first hop, so it adds no hop.
  if (action.owner.kind === 'user') {
    await enterTarget(
      pipeline,
      call,
      {
        kind: 'user',
        userId: action.owner.userId
      },
      null
    );
    return;
  }
  if (action.owner.kind === 'ringGroup') {
    await enterTarget(
      pipeline,
      call,
      {
        kind: 'ringGroup',
        ringGroupId: action.owner.ringGroupId
      },
      null
    );
    return;
  }
  // §10.1 Outbound step 3: a parking slot retrieves the call parked there, or plays the short
  // error tone when the slot is empty.
  const result = await retrieveParkedCall(
    pipeline,
    pipeline.deps.presence,
    call,
    action.owner.ext
  );
  if (result === 'empty') {
    call.log.event({
      event: 'parkingRetrieve',
      ext: action.owner.ext,
      result: 'empty'
    });
    await playErrorToneAndRelease(pipeline, call);
  }
}

/**
 * Dispatches a resolved dialled string for `call`, its caller channel up and registered (§10.1
 * "Outbound" steps 1-6). An emergency or external number is dialled as `asUser`'s call, so CLIR,
 * routes, caller-ID and the channel cap all apply: the dialling user's, or the transferrer's for
 * a transferee's onward call (§10.1 "Transfers and pickup"), whose forwarding context a blind
 * transfer starts with the transferrer's deflection (`dial.blindTransfer`). A refused string is released with
 * the resolution's own code (404 for an unowned extension, 484 for an incomplete address).
 */
export async function dispatchAction(
  pipeline: Pipeline,
  call: Call,
  action: DialAction,
  dial: DialAs
): Promise<void> {
  const { snapshot, asUser } = dial;
  if (dial.blindTransfer === true && asUser !== null) {
    noteBlindTransfer(snapshot, call, asUser);
  }
  if (action.kind === 'refuse') {
    await release(pipeline, call, action.code, 'failed');
    return;
  }
  if (action.kind === 'emergency' || action.kind === 'external') {
    await dialTrunk(pipeline, call, action, dial);
    return;
  }
  if (action.kind === 'ownDid') {
    // §10.1 step 7: a DID's own target is the call's first hop too, so it adds no hop either, and
    // an external one is dialled without a caller, since the DID forwards, not the dialling user.
    const target = findForwardTarget(snapshot, action.targetId);
    noteNumberForward(snapshot, call, { didId: action.didId }, target);
    await enterTarget(pipeline, call, target, null);
    return;
  }
  if (action.kind === 'extension') {
    await dispatchExtension(pipeline, call, action);
    return;
  }
  // `action.kind === 'feature'`: §9.3 "Feature codes".
  await handleFeature(
    pipeline,
    pipeline.deps.presence,
    call,
    action.key,
    action.rest
  );
}
