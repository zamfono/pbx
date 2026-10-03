/** The feature-code dial's own call (§9.3 "Feature codes"): the two ways a feature closes that
 * call out with a real outcome (§11.2 `calls.status`). Shared by `features.ts`, `mailbox.ts`, `parking.ts`, `parkingRingback.ts` and
 * `addParty.ts`; its coverage lives in `features.test.ts` alongside theirs. */
import { endCall, type Call, type CallsRow } from './call.js';
import type { Pipeline } from './pipeline.js';

/** `answeredAt` for a feature call closing out `answered` (§10.2 "Call history": renders "Ben
 * joined at 14:02"), stamped here rather than at each call site's own point of answer, so every
 * feature shares one instant for it. Left untouched when already set, so this never overwrites a
 * call whose own `answeredAt` a caller stamped earlier for its own reasons. */
function stampAnsweredAt(
  pipeline: Pipeline,
  call: Call,
  status: CallsRow['status']
): void {
  if (status === 'answered' && call.answeredAt === null) {
    call.answeredAt = pipeline.deps.now();
  }
}

/** Ends the feature-code dial's own disposable channel with a real outcome (§11.2
 * `calls.status`): every feature except pickup and retrieval hangs up here, since their own
 * channel never joins another party's conversation. */
export async function concludeFeature(
  pipeline: Pipeline,
  call: Call,
  status: CallsRow['status']
): Promise<void> {
  stampAnsweredAt(pipeline, call, status);
  await endCall(pipeline, call, status);
}

/** Closes the feature-code dial's own CDR entry without hanging up its channel: pickup and
 * retrieval fold that very channel into the target's bridge, so it is now the real conversation
 * leg, not a disposable one. */
export async function closeFeatureCall(
  pipeline: Pipeline,
  call: Call,
  status: CallsRow['status']
): Promise<void> {
  call.status = status;
  stampAnsweredAt(pipeline, call, status);
  await pipeline.finishCall(call);
}
