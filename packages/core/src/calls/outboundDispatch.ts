/**
 * `outbound.ts`'s dispatch of a resolved dialled string (§10.1 "Outbound" steps 1-6): a feature
 * code runs, an emergency or external number goes through `emergency.ts` or §9.4's trunk
 * selection as the dialling user's call, an own DID enters at its target and an internal
 * extension at Entry, or a parking slot retrieves the call parked there.
 */
import type { Snapshot } from '../internal/server.js';
import { defaultPrompt } from '../prompts.js';
import type { DialAction } from '../routing/outbound.js';
import { findForwardTarget, release, type Call } from './call.js';
import { SIP_SERVICE_UNAVAILABLE } from './conclude.js';
import { dialEmergency } from './emergency.js';
import { handleFeature } from './features.js';
import { dialExternal } from './outboundExternal.js';
import { retrieveParkedCall } from './parkingRetrieval.js';
import type { Pipeline } from './pipeline.js';
import { playAndWait } from './playback.js';
import type { TrunkState } from './trunkState.js';

const SIP_EXTENSION_NOT_FOUND = 404;

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

/** Dispatches a resolved dialled string (§10.1 "Outbound" steps 1-6) from `handleOutbound`. An
 * emergency or external number is dialled as `asUser`: the dialling user, or the transferrer for
 * a blind transfer's onward call (§10.1 "Transfers and pickup"). */
export async function dispatchAction(
  pipeline: Pipeline,
  trunkState: TrunkState,
  call: Call,
  action: DialAction,
  dial: { snapshot: Snapshot; asUser: string | null }
): Promise<void> {
  const { snapshot, asUser } = dial;
  if (action.kind === 'refuse') {
    await release(pipeline, call, action.code, 'failed');
    return;
  }
  if (action.kind === 'emergency') {
    await dialEmergency(pipeline, trunkState, call, action.number, asUser);
    return;
  }
  if (action.kind === 'external') {
    await dialExternal(
      { pipeline, trunkState },
      call,
      action.number,
      asUser,
      action.clir
    );
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
