/**
 * One of the two primitives the live-call actions of §3 are made of, shared by `actions.ts` and
 * `transfers.ts`: `routeToTarget` sends a channel through the dial resolution as if a user had
 * dialled `target` from it (§10.1 "Outbound"; click-to-dial's originated call and a transfer's
 * transferee both take this path, and every kind the resolution yields is dispatched the way
 * `outbound.ts` dispatches a device's own dial). `liveCall.ts`'s `closeCall` is the other.
 */
import type { LogLevel } from '../callLog.js';
import type { Snapshot } from '../internal/server.js';
import { defaultPrompt } from '../prompts.js';
import {
  resolveDialed,
  type DialAction,
  type ResolveDialedContext
} from '../routing/outbound.js';
import { findForwardTarget, release, toLogLevel, type Call } from './call.js';
import { SIP_SERVICE_UNAVAILABLE } from './conclude.js';
import { dialEmergency, emergencyLogLevel } from './emergency.js';
import { handleFeature } from './features.js';
import { dialExternal } from './outboundExternal.js';
import {
  buildExtensionsMap,
  didTargetsByNumber,
  toFor
} from './outboundLookup.js';
import { retrieveParkedCall } from './parkingRetrieval.js';
import type { Pipeline } from './pipeline.js';
import { playAndWait } from './playback.js';

// An empty parking slot ends in the short error tone and a 404 release (§9.3 table).
const SIP_NOT_FOUND = 404;

export type ResolvedTarget = {
  action: DialAction;
  direction: Call['direction'];
  to: string;
};

/** `resolveDialed`'s context over `snapshot`, the one a device's own dial resolves against. */
function dialContext(snapshot: Snapshot): ResolveDialedContext {
  return {
    featureCodes: snapshot.settings.featureCodes,
    emergencyNumbers: snapshot.settings.emergencyNumbers,
    country: snapshot.settings.country,
    extLength: snapshot.settings.extLength,
    extensions: buildExtensionsMap(snapshot),
    dids: didTargetsByNumber(snapshot)
  };
}

/** What `target` resolves to when dialled (§10.1 "Outbound" steps 1-5) and the `Call` fields it fixes. */
export function resolveTarget(
  snapshot: Snapshot,
  target: string
): ResolvedTarget {
  const action = resolveDialed(target, dialContext(snapshot));
  const direction =
    action.kind === 'external' || action.kind === 'emergency'
      ? 'outbound'
      : 'internal';
  return { action, direction, to: toFor(action, target) };
}

/** The trace level a call to `action` starts at, the one a device's own dial resolves to: the
 * tenant's configured level, raised to `events` for an emergency number (§10.1 "Emergency calls"). */
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

/** A parking-slot dial (§10.1 "Outbound" step 3): retrieves the call parked there, else plays
 * the short error tone and releases 404 (§9.3 table). */
async function retrieveFromSlot(
  pipeline: Pipeline,
  call: Call,
  ext: string
): Promise<void> {
  const { ari, presence } = pipeline.deps;
  if (presence === null) {
    await release(pipeline, call, SIP_SERVICE_UNAVAILABLE, 'failed');
    return;
  }
  const result = await retrieveParkedCall(pipeline, presence, call, ext);
  if (result === 'retrieved') {
    return;
  }
  call.log.event({ event: 'parkingRetrieve', ext, result: 'empty' });
  await ari.channels.answer(call.callerChannelId).catch(() => undefined);
  await playAndWait(
    ari,
    call.callerChannelId,
    defaultPrompt('invalid'),
    `${call.callerChannelId}:invalid`
  );
  await release(pipeline, call, SIP_NOT_FOUND, 'failed');
}

/** An internal extension (§10.1 "Outbound" step 3): a user or ring group enters at Entry, a
 * parking slot retrieves the call parked there. */
async function routeExtension(
  pipeline: Pipeline,
  call: Call,
  action: Extract<DialAction, { kind: 'extension' }>
): Promise<void> {
  const { owner } = action;
  if (owner.kind === 'user') {
    await pipeline.enterTarget(
      call,
      {
        id: '',
        kind: 'user',
        userId: owner.userId
      },
      null
    );
    return;
  }
  if (owner.kind === 'ringGroup') {
    await pipeline.enterTarget(
      call,
      {
        id: '',
        kind: 'ringGroup',
        ringGroupId: owner.ringGroupId
      },
      null
    );
    return;
  }
  await retrieveFromSlot(pipeline, call, owner.ext);
}

/** A feature code (§9.3 "Feature codes") dialled through an action, run by `features.ts`. */
async function routeFeature(
  pipeline: Pipeline,
  call: Call,
  action: Extract<DialAction, { kind: 'feature' }>
): Promise<void> {
  const { presence } = pipeline.deps;
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

/**
 * Routes `call`, its caller channel up and registered, to `action` the way a device's own dial is
 * routed (§10.1 "Outbound"): a feature code runs, an extension enters at Entry or retrieves a
 * parked call, an own DID enters at its target, an external or emergency number goes through
 * §9.4's trunk selection as `asUser`'s call, so CLIR, routes, caller-ID and the channel cap all
 * apply, and a refused string is released with the resolution's own code (404 for an unowned
 * extension, 484 for an incomplete address).
 */
export async function routeToTarget(
  pipeline: Pipeline,
  call: Call,
  action: DialAction,
  asUser: string | null
): Promise<void> {
  switch (action.kind) {
    case 'feature':
      await routeFeature(pipeline, call, action);
      return;
    case 'extension':
      await routeExtension(pipeline, call, action);
      return;
    case 'ownDid': {
      const snapshot = await pipeline.deps.cache.get();
      // §10.1 step 7: the DID forwards, so an external target is dialled without a caller.
      await pipeline.enterTarget(
        call,
        findForwardTarget(snapshot, action.targetId),
        null
      );
      return;
    }
    case 'external':
    case 'emergency':
      await dialTrunk(pipeline, call, action, asUser);
      return;
    case 'refuse':
      await release(pipeline, call, action.code, 'failed');
      return;
    default:
      // `DialAction` has no further kind; the assertion keeps this switch exhaustive.
      await release(pipeline, call, SIP_NOT_FOUND, 'failed');
  }
}
