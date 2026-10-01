/**
 * The dispatch of a resolved dialled string (§10.1 "Outbound" steps 1-6), whoever dialled it: a
 * device's own dial (`outbound.ts`), click-to-dial's originated call once its device answered
 * (`clickToDial.ts`) and a transferee's onward call (`transfers.ts`). A feature code runs, an
 * emergency or external number goes through `emergency.ts` or §9.4's trunk selection as the
 * dialling user's call, an own DID enters at its target and an internal extension at Entry, or a
 * parking slot retrieves the call parked there.
 */
import type { LogLevel } from '../callLog.js';
import type { Snapshot } from '../internal/server.js';
import { defaultPrompt } from '../prompts.js';
import { resolveDialed, type DialAction } from '../routing/outbound.js';
import { findForwardTarget, release, toLogLevel, type Call } from './call.js';
import { SIP_SERVICE_UNAVAILABLE } from './conclude.js';
import { dialEmergency, emergencyLogLevel } from './emergency.js';
import { handleFeature } from './features.js';
import { dialExternal } from './outboundExternal.js';
import { resolveDialedContext, toFor } from './outboundLookup.js';
import { retrieveParkedCall } from './parkingRetrieval.js';
import type { Pipeline } from './pipeline.js';
import { playAndWait } from './playback.js';

const SIP_EXTENSION_NOT_FOUND = 404;

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
): LogLevel {
  const configured = toLogLevel(snapshot.settings.callLogLevel);
  return action.kind === 'emergency'
    ? emergencyLogLevel(configured, nowIso)
    : configured;
}

/** Asterisk's generic "not a valid option" prompt, then a release (§9.3 table: an empty parking
 * slot's short error tone; feature-code entry outside a menu shares the same fixed prompt as
 * `menu.ts`'s own `defaultPrompt('invalid')`). */
async function playInvalidAndRelease(
  pipeline: Pipeline,
  call: Call
): Promise<void> {
  const ari = pipeline.deps.ari;
  await ari.channels.answer(call.callerChannelId).catch(() => undefined);
  await playAndWait(
    ari,
    call.callerChannelId,
    defaultPrompt('invalid'),
    `${call.callerChannelId}:invalid`
  );
  await release(pipeline, call, SIP_EXTENSION_NOT_FOUND, 'failed');
}

/** An emergency or external number, dialled as `asUser`'s call through the pipeline's
 * `TrunkState` (§9.4); 503 without one. */
async function dialTrunk(
  pipeline: Pipeline,
  call: Call,
  action: Extract<DialAction, { kind: 'external' | 'emergency' }>,
  asUser: string | null
): Promise<void> {
  const { trunkState } = pipeline.deps;
  if (trunkState === null) {
    await release(pipeline, call, SIP_SERVICE_UNAVAILABLE, 'failed');
    return;
  }
  if (action.kind === 'emergency') {
    await dialEmergency(pipeline, trunkState, call, action.number, asUser);
    return;
  }
  await dialExternal(
    { pipeline, trunkState },
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
    await pipeline.enterTarget(
      call,
      {
        id: '',
        kind: 'user',
        userId: action.owner.userId
      },
      null
    );
    return;
  }
  if (action.owner.kind === 'ringGroup') {
    await pipeline.enterTarget(
      call,
      {
        id: '',
        kind: 'ringGroup',
        ringGroupId: action.owner.ringGroupId
      },
      null
    );
    return;
  }
  // §10.1 step 3: a parking slot retrieves the call parked there, or plays the short error tone
  // when the slot is empty (§9.3 table).
  const presence = pipeline.deps.presence;
  if (presence === null) {
    await release(pipeline, call, SIP_SERVICE_UNAVAILABLE, 'failed');
    return;
  }
  const result = await retrieveParkedCall(
    pipeline,
    presence,
    call,
    action.owner.ext
  );
  if (result === 'empty') {
    call.log.event({
      event: 'parkingRetrieve',
      ext: action.owner.ext,
      result: 'empty'
    });
    await playInvalidAndRelease(pipeline, call);
  }
}

/**
 * Dispatches a resolved dialled string for `call`, its caller channel up and registered (§10.1
 * "Outbound" steps 1-6). An emergency or external number is dialled as `asUser`'s call, so CLIR,
 * routes, caller-ID and the channel cap all apply: the dialling user's, or the transferrer's for
 * a transferee's onward call (§10.1 "Transfers and pickup"). A refused string is released with
 * the resolution's own code (404 for an unowned extension, 484 for an incomplete address).
 */
export async function dispatchAction(
  pipeline: Pipeline,
  call: Call,
  action: DialAction,
  dial: { snapshot: Snapshot; asUser: string | null }
): Promise<void> {
  const { snapshot, asUser } = dial;
  if (action.kind === 'refuse') {
    await release(pipeline, call, action.code, 'failed');
    return;
  }
  if (action.kind === 'emergency' || action.kind === 'external') {
    await dialTrunk(pipeline, call, action, asUser);
    return;
  }
  if (action.kind === 'ownDid') {
    // §10.1 step 7: a DID's own target is the call's first hop too, so it adds no hop either, and
    // an external one is dialled without a caller, since the DID forwards, not the dialling user.
    await pipeline.enterTarget(
      call,
      findForwardTarget(snapshot, action.targetId),
      null
    );
    return;
  }
  if (action.kind === 'extension') {
    await dispatchExtension(pipeline, call, action);
    return;
  }
  // `action.kind === 'feature'`: §9.3 "Feature codes".
  const presence = pipeline.deps.presence;
  if (presence === null) {
    call.log.event({
      event: 'feature',
      key: action.key,
      result: 'unavailable'
    });
    await release(pipeline, call, SIP_SERVICE_UNAVAILABLE, 'failed');
    return;
  }
  await handleFeature(pipeline, presence, call, action.key, action.rest);
}
