/**
 * One `ringPlan` batch's own ring race (§10.1 step 5): originates its legs (`ringGroupOriginate.ts`),
 * races them (first `Up` wins, `ringGroupWin.ts`; a declined member's siblings drop when `allow_reject`), and resolves
 * once answered or the batch's timeout elapses. Kept off `pipeline.pendingRing`, which Task 27's
 * single-user ring race owns; `ringGroup.ts` is the only caller.
 */
import type { AriEvent, Channel } from '../ari/types.js';
import type { Snapshot } from '../internal/server.js';
import type { MemberLeg } from '../routing/ringGroup.js';
import type { Call } from './call.js';
import { callRinging } from './callState.js';
import { externalAttemptDialsOn } from './externalLeg.js';
// --- Task 31 ---
import { registerActiveBatch, unregisterActiveBatch } from './groupPickup.js';
import type { Pipeline } from './pipeline.js';
import {
  hangupAllRinging,
  hangupMemberSiblings,
  originateBatch,
  type GroupLeg
} from './ringGroupOriginate.js';
import { winBatch } from './ringGroupWin.js';

export { activeBatchHasRingingLeg, stopGroupRinging } from './groupPickup.js';

// Asterisk's Q.850 mapping of SIP 486 Busy Here / 600 Busy Everywhere and SIP 603 Decline
// (mirrors legs.ts's own mapping for the single-user ring race).
const AST_CAUSE_USER_BUSY = 17;
const AST_CAUSE_CALL_REJECTED = 21;
const MILLISECONDS_PER_SECOND = 1000;

/** A batch's outcome: `answered` bridges the caller, `unanswered` moves the plan to its next
 * batch or fallback, `abandoned` means the caller's own channel ended while the batch rang —
 * legs.ts's `handleChannelEnded` already finished the call, so `ringGroup` must run no fallback. */
export type BatchOutcome = 'answered' | 'unanswered' | 'abandoned';

/** The batch race's read-only context, threaded through its event handling as one object so that
 * handling stays free of the local state's own closure (§ Global Constraints max-params). */
type RaceContext = {
  pipeline: Pipeline;
  call: Call;
  tracked: Map<string, GroupLeg>;
  allowReject: boolean;
  settle: (outcome: BatchOutcome) => void;
  checkStillRinging: () => void;
  setWinInProgress: () => void;
};

/** A declined (or otherwise ended) member leg: hangs up its siblings when `allowReject`, else
 * leaves the batch's other legs ringing on to their own timeout (§10.1 step 5). */
function handleDecline(
  ctx: RaceContext,
  leg: GroupLeg,
  cause: number | null
): void {
  leg.state = 'ended';
  ctx.call.log.event({ event: 'declined', channelId: leg.channelId, cause });
  const declined =
    cause === AST_CAUSE_USER_BUSY || cause === AST_CAUSE_CALL_REJECTED;
  if (declined && !ctx.allowReject) {
    // §10.1 step 5: with allow_reject cleared, a decline is ignored, so it must not end the
    // batch early — the member's line drops, but the batch still rings on to its own timeout.
    return;
  }
  if (declined) {
    hangupMemberSiblings(ctx.pipeline, ctx.tracked, leg.memberKey);
  }
  ctx.checkStillRinging();
}

/** The batch's own `AriClient` event handler: the caller abandoning, a member leg winning, or a
 * member leg ending early. */
function handleBatchEvent(ctx: RaceContext, ev: AriEvent): void {
  if (ev.type !== 'ChannelStateChange' && ev.type !== 'ChannelDestroyed') {
    return;
  }
  const channel = ev.channel as Channel;
  if (channel.id === ctx.call.callerChannelId) {
    if (ev.type === 'ChannelDestroyed') {
      ctx.settle('abandoned');
    }
    return;
  }
  const leg = ctx.tracked.get(channel.id);
  if (leg?.state !== 'ringing') {
    return;
  }
  if (ev.type === 'ChannelStateChange') {
    if (channel.state === 'Up') {
      ctx.setWinInProgress();
      winBatch(ctx.pipeline, ctx.call, channel.id, ctx.tracked)
        .then(won => {
          if (won) {
            ctx.settle('answered');
          }
        })
        .catch(() => undefined);
    }
    return;
  }
  const cause = typeof ev.cause === 'number' ? ev.cause : null;
  // An external leg's attempt that falls through to its next route rings on (§9.4 "Route fallthrough").
  if (externalAttemptDialsOn(ctx.pipeline, channel.id, ev)) {
    return;
  }
  handleDecline(ctx, leg, cause);
}

/** The batch race's mutable state and its `AriClient` event handler, factored out so `ringBatch`
 * itself stays a short setup/teardown shell (§ Global Constraints max-lines-per-function). */
type BatchRace = {
  tracked: Map<string, GroupLeg>;
  promise: Promise<BatchOutcome>;
  onEvent: (ev: AriEvent) => void;
  settle: (outcome: BatchOutcome) => void;
  finishOriginating: () => void;
  endLeg: (leg: GroupLeg, cause: number | null) => void;
};

function createBatchRace(
  pipeline: Pipeline,
  call: Call,
  allowReject: boolean
): BatchRace {
  const tracked = new Map<string, GroupLeg>();
  const { promise, resolve } = Promise.withResolvers<BatchOutcome>();
  let settled = false;
  // Legs are originated one at a time; a leg ending mid-origination must not settle the batch as
  // unanswered while its siblings haven't been dialed yet, and a win in flight (still awaiting its
  // own bridge/answer steps) must not be pre-empted by a sibling's own end landing in that window.
  let originatingDone = false;
  let winInProgress = false;
  const settle = (outcome: BatchOutcome): void => {
    if (settled) {
      return;
    }
    settled = true;
    resolve(outcome);
  };
  const checkStillRinging = (): void => {
    if (!originatingDone || winInProgress) {
      return;
    }
    const stillRinging = [...tracked.values()].some(
      entry => entry.state === 'ringing'
    );
    if (!stillRinging) {
      settle('unanswered');
    }
  };
  const ctx: RaceContext = {
    pipeline,
    call,
    tracked,
    allowReject,
    settle,
    checkStillRinging,
    setWinInProgress: () => {
      winInProgress = true;
    }
  };
  return {
    tracked,
    promise,
    onEvent: ev => {
      handleBatchEvent(ctx, ev);
    },
    settle,
    finishOriginating: () => {
      originatingDone = true;
      checkStillRinging();
    },
    endLeg: (leg, cause) => {
      handleDecline(ctx, leg, cause);
    }
  };
}

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
  const timer = setTimeout(() => {
    race.settle('unanswered');
  }, batch.timeoutS * MILLISECONDS_PER_SECOND);
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
