/**
 * One `ringPlan` batch's own ring race (§10.1 step 5): originates its legs (`ringGroupOriginate.ts`),
 * races them (`ringGroupRace.ts`: first `Up` wins, a declined member's siblings drop when `allow_reject`), and resolves
 * once answered or the batch's timeout elapses. Kept off `pipeline.pendingRing`, which Task 27's
 * single-user ring race owns; `ringGroup.ts` is the only caller.
 */
import { MS_PER_SECOND } from '@zamfono/shared';

import type { Snapshot } from '../internal/server.js';
import type { MemberLeg } from '../routing/ringGroup.js';
import type { Call } from './call.js';
import { callRinging } from './callState.js';
import { hangupAllRinging } from './groupLegs.js';
// --- Task 31 ---
import { registerActiveBatch, unregisterActiveBatch } from './groupPickup.js';
import type { Pipeline } from './pipeline.js';
import { originateBatch } from './ringGroupOriginate.js';
import { createBatchRace, type BatchOutcome } from './ringGroupRace.js';

export { activeBatchHasRingingLeg, stopGroupRinging } from './groupPickup.js';
export type { BatchOutcome } from './ringGroupRace.js';

/** One `ringPlan` batch: originates its legs, races them (first `Up` wins, a declined member's
 * siblings drop when `allowReject`), and resolves once answered, the caller abandons, or the
 * batch's `timeoutS` elapses. */
export async function ringBatch(
  pipeline: Pipeline,
  call: Call,
  snapshot: Snapshot,
  batch: { legs: MemberLeg[]; timeoutS: number },
  allowReject: boolean
): Promise<BatchOutcome> {
  callRinging(pipeline.deps, call);
  const race = createBatchRace(pipeline, call, allowReject);
  pipeline.deps.ari.on('event', race.onEvent);
  // --- Task 31 --- (`stopGroupRinging`'s own registry, `groupPickup.ts`)
  registerActiveBatch(pipeline, call.id, {
    tracked: race.tracked,
    settle: race.settle
  });
  // --- end Task 31 ---
  const timer = setTimeout(race.timeOut, batch.timeoutS * MS_PER_SECOND);
  timer.unref();

  await originateBatch(pipeline, call, snapshot, batch.legs, {
    tracked: race.tracked,
    end: race.endLeg
  });
  // --- Task 31 --- (§9.3 "a user: RINGING while any of their devices rings")
  const ringingUserIds = new Set(
    [...race.tracked.values()]
      .map(leg => leg.userId)
      .filter((userId): userId is string => userId !== null)
  );
  for (const userId of ringingUserIds) {
    pipeline.deps.presence?.setCallState(
      userId,
      'ringing',
      call.from,
      call.ringGroupId,
      call.id
    );
  }
  // --- end Task 31 ---
  race.finishOriginating();
  const outcome = await race.promise;
  pipeline.deps.ari.off('event', race.onEvent);
  clearTimeout(timer);
  // --- Task 31 ---
  unregisterActiveBatch(pipeline, call.id);
  // --- end Task 31 ---
  if (outcome !== 'answered') {
    await hangupAllRinging(pipeline, race.tracked);
  }
  // --- Task 31 ---
  // The winner (if any) is already `inCall` via `winBatch`; every other member who was ringing in
  // this batch goes back to idle (§9.3, §10.2 "Presence and BLF").
  for (const userId of ringingUserIds) {
    if (userId !== call.answeredByUserId) {
      pipeline.deps.presence?.setCallState(userId, 'idle', null, null, call.id);
    }
  }
  // --- end Task 31 ---
  return outcome;
}
