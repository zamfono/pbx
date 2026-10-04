/**
 * One ring-group batch's race state (§10.1 step 5): the first `Up` wins (`ringGroupWin.ts`), a
 * declined member's siblings drop when `allow_reject`, and exactly one outcome settles it — a win
 * in progress holds off the batch's timeout and its last leg ending, and an answer landing after
 * the batch settled is hung up. `ringGroupDial.ts` places the batch and waits on this race.
 */
import { isEvent, type AriEvent } from '../ari/events.js';
import { logFailure, logUnlessGone } from '../ari/failures.js';
import { AST_CAUSE_CALL_REJECTED, AST_CAUSE_USER_BUSY } from '../sipCodes.js';
import { waitForEvent, type EventWait } from './ariWaits.js';
import type { Call } from './call.js';
import { callPartiesChanged } from './callState.js';
import { hangupMemberSiblings, type GroupLeg } from './groupLegs.js';
import type { Pipeline } from './pipeline.js';
import { winBatch } from './ringGroupWin.js';

/** A batch's outcome: `answered` bridges the caller, `unanswered` moves the plan to its next
 * batch or fallback, `abandoned` means the caller's own channel ended while the batch rang —
 * legs.ts's `handleChannelEnded` already finished the call, so `ringGroup` must run no fallback. */
export type BatchOutcome = 'answered' | 'unanswered' | 'abandoned';

/** What the batch race's event handling reads and calls. */
type RaceContext = {
  pipeline: Pipeline;
  call: Call;
  tracked: Map<string, GroupLeg>;
  allowReject: boolean;
  settle: (outcome: BatchOutcome) => void;
  checkStillRinging: () => void;
  /** Marks a member's answer as the batch's win in progress; false once the batch has settled. */
  beginWin: () => boolean;
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
    callPartiesChanged(ctx.pipeline.deps, ctx.call);
    return;
  }
  if (declined) {
    hangupMemberSiblings(ctx.pipeline, ctx.tracked, leg.memberKey);
  }
  callPartiesChanged(ctx.pipeline.deps, ctx.call);
  ctx.checkStillRinging();
}

/** The batch's own `AriClient` event handler: the caller abandoning, a member leg winning, or a
 * member leg ending early. */
function handleBatchEvent(ctx: RaceContext, ev: AriEvent): void {
  if (!isEvent(ev, 'ChannelStateChange', 'ChannelDestroyed')) {
    return;
  }
  const channel = ev.channel;
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
      if (!ctx.beginWin()) {
        // Settled unanswered first (its timeout): the late answer is hung up, never left up.
        leg.state = 'ended';
        ctx.pipeline.deps.ari.channels
          .hangup(channel.id)
          .catch(logUnlessGone(ctx.pipeline.deps.logger, 'late answer hangup'));
        return;
      }
      winBatch(ctx.pipeline, ctx.call, channel.id, ctx.tracked)
        .then(won => {
          if (won) {
            ctx.settle('answered');
          }
        })
        .catch(logFailure(ctx.pipeline.deps.logger, 'ring group answer'));
    }
    return;
  }
  // An external member leg's attempt's own end falls through to its next route or ends the leg
  // (`externalAttempt.ts`, §9.4 "Route fallthrough").
  if (leg.external === true) {
    return;
  }
  handleDecline(ctx, leg, ev.cause);
}

/** One batch's race: it listens to the event stream and runs the batch's timeout until its outcome
 * settles. */
export class BatchRace implements RaceContext {
  readonly pipeline: Pipeline;
  readonly call: Call;
  readonly allowReject: boolean;
  readonly tracked = new Map<string, GroupLeg>();
  readonly promise: Promise<BatchOutcome>;
  private readonly wait: EventWait<BatchOutcome>;
  private settled = false;
  // Legs are originated at once, each at its own pace; a leg ending mid-origination must not
  // settle the batch as unanswered while its siblings haven't been dialed yet, and a win in
  // flight (still awaiting its own bridge/answer steps) must not be pre-empted by a sibling's own
  // end landing in that window.
  private originatingDone = false;
  private winInProgress = false;

  /** Starts the race, its timeout of `timeoutMs` running from now. */
  constructor(
    pipeline: Pipeline,
    call: Call,
    allowReject: boolean,
    timeoutMs: number
  ) {
    this.pipeline = pipeline;
    this.call = call;
    this.allowReject = allowReject;
    this.wait = waitForEvent(pipeline.deps.ari, ev => {
      handleBatchEvent(this, ev);
    });
    this.promise = this.wait.promise;
    // §10.1 step 5 "the first answer wins": a timeout landing while the winner is still being
    // bridged must not send the caller on to the next batch or the fallback beside it.
    this.wait.arm(timeoutMs, () => {
      if (!this.winInProgress) {
        this.settle('unanswered');
      }
    });
  }

  settle(outcome: BatchOutcome): void {
    this.settled = true;
    this.wait.settle(outcome);
  }

  checkStillRinging(): void {
    if (!this.originatingDone || this.winInProgress) {
      return;
    }
    const stillRinging = [...this.tracked.values()].some(
      entry => entry.state === 'ringing'
    );
    if (!stillRinging) {
      this.settle('unanswered');
    }
  }

  beginWin(): boolean {
    this.winInProgress = !this.settled;
    return this.winInProgress;
  }

  finishOriginating(): void {
    this.originatingDone = true;
    this.checkStillRinging();
  }

  endLeg(leg: GroupLeg, cause: number | null): void {
    handleDecline(this, leg, cause);
  }
}
