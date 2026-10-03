/**
 * The shared outbound-attempt engine (§9.4 "Route fallthrough", "Hosts"): one INVITE's outcome,
 * and `ip`-trunk host failover. Used by both `outbound.ts`'s per-route dialling and
 * `emergency.ts`'s per-trunk dialling; the INVITE itself is `trunkDial.ts`, caller-ID resolution
 * `callerIdentity.ts`, the terminal outcomes `answer.ts` and `conclude.ts`.
 */
import { newId } from '@zamfono/shared';

import type { AriClient } from '../ari/client.js';
import { isEvent } from '../ari/events.js';
import { logFailure, logUnlessGone } from '../ari/failures.js';
import type { Snapshot } from '../internal/snapshot.js';
import {
  ATTEMPT_NO_RESPONSE_MS,
  type AttemptFailure,
  type Route
} from '../routing/trunk.js';
import { SIP_SERVER_ERROR } from '../sipCodes.js';
import { waitForEvent } from './ariWaits.js';
import type { Leg } from './call.js';
import { callRinging } from './callState.js';
import { alertsOn, provisionalArrived, type TrunkLeg } from './provisional.js';
import {
  dialTargets,
  endedSipStatus,
  originateTrunkLeg,
  retriesNextHost,
  type TrunkLegCtx
} from './trunkDial.js';
import type { TrunkState } from './trunkState.js';

export type AttemptOutcome =
  | { kind: 'answered'; channelId: string }
  | { kind: 'failure'; failure: AttemptFailure };

// A leg Asterisk would not place (its create or dial refused, `legOriginate.ts`) fails as a 500
// before alerting would: the next host, then the next route, is tried (§9.4 "Route fallthrough").
const PLACEMENT_FAILED: AttemptFailure = {
  kind: 'final',
  code: SIP_SERVER_ERROR,
  alerted: false
};

/** An attempt's outcome as its channel's events tell it, and the no-response budget's start. */
type AttemptWatch = {
  outcome: Promise<AttemptOutcome>;
  /** Starts the budget, once the leg is placed: it needs the channel's name. */
  start: (leg: TrunkLeg, timeoutMs: number) => void;
  /** Stops watching a leg that could not be placed. */
  stop: () => void;
};

/**
 * Watches `channelId`, from before its create, until it alerts and later ends, answers, or times
 * out (§9.4 "Route fallthrough"): a far end that answers or refuses at once may do so before the
 * leg's placement returns.
 */
function watchAttemptOutcome(ari: AriClient, channelId: string): AttemptWatch {
  let alerted = false;
  const wait = waitForEvent<AttemptOutcome>(ari, (event, waiting) => {
    if (!alerted && alertsOn(event, channelId)) {
      // The no-response budget covers only the interval before the first provisional
      // response (§9.4 "Route fallthrough"); once the far end alerted, the attempt is final
      // only on answer or a terminal response, never on this timer.
      alerted = true;
      waiting.disarm();
      return;
    }
    const channel = event.channel;
    if (channel?.id !== channelId) {
      return;
    }
    if (event.type === 'ChannelStateChange' && channel.state === 'Up') {
      waiting.settle({ kind: 'answered', channelId });
      return;
    }
    if (isEvent(event, 'ChannelDestroyed')) {
      const code = endedSipStatus(event);
      waiting.settle({
        kind: 'failure',
        failure: { kind: 'final', code, alerted }
      });
    }
  });
  const start = (leg: TrunkLeg, timeoutMs: number): void => {
    if (alerted) {
      return;
    }
    wait.arm(timeoutMs, () => {
      // A `100 Trying` ends the budget as any provisional response does, though no event says
      // so; the attempt then waits for its outcome like one that alerted.
      provisionalArrived(ari, leg)
        .then(arrived => {
          if (!arrived) {
            wait.settle({ kind: 'failure', failure: { kind: 'noResponse' } });
          }
        })
        .catch(logFailure(ari.log, 'provisional response read'));
    });
  };
  return {
    outcome: wait.promise,
    start,
    stop: () => {
      wait.settle({ kind: 'failure', failure: PLACEMENT_FAILED });
    }
  };
}

/** Decrements the trunk's active count once the answered leg's channel eventually ends. */
function watchAttemptChannelEnd(
  ari: AriClient,
  trunkState: TrunkState,
  channelId: string
): void {
  waitForEvent<undefined>(ari, (event, wait) => {
    const channel = event.channel;
    if (channel?.id !== channelId || event.type !== 'ChannelDestroyed') {
      return;
    }
    wait.settle(undefined);
    trunkState.noteAttemptEnded(channelId);
  });
}

export type AttemptCtx = TrunkLegCtx & { route: Route | null };

function attemptCause(outcome: AttemptOutcome): string | number {
  if (outcome.kind === 'answered') {
    return 'answered';
  }
  if (outcome.failure.kind === 'final') {
    return outcome.failure.code;
  }
  return outcome.failure.kind;
}

/** One INVITE to `endpoint`: originate, track as a `trunk` leg, wait for its outcome (§9.4). */
async function attemptOnce(
  ctx: AttemptCtx,
  endpoint: string
): Promise<AttemptOutcome> {
  const { pipeline, call, trunkState, route, trunk } = ctx;
  const channelId = newId();
  const placing: Leg = {
    channelId,
    kind: 'trunk',
    userId: null,
    state: 'placing',
    endCause: null,
    trunkId: trunk.id
  };
  call.legs.set(channelId, placing);
  const watch = watchAttemptOutcome(pipeline.deps.ari, channelId);
  const trunkLeg = await originateTrunkLeg(ctx, endpoint, channelId, () => {
    placing.state = 'ringing';
  }).catch(
    logFailure(pipeline.deps.logger, 'trunk attempt placement', {
      callId: call.id,
      trunkId: trunk.id
    })
  );
  if (trunkLeg === undefined) {
    watch.stop();
    call.legs.delete(channelId);
    call.log.event({
      event: 'attempt',
      routeId: route?.id ?? null,
      trunkId: trunk.id,
      endpoint,
      cause: 'placementFailed'
    });
    return { kind: 'failure', failure: PLACEMENT_FAILED };
  }
  // The live view (§10.6) shows the call ringing its external target from the first INVITE on.
  callRinging(pipeline.deps, call);
  watch.start(trunkLeg, ATTEMPT_NO_RESPONSE_MS);
  const outcome = await watch.outcome;
  const leg = call.legs.get(channelId);
  // One `events` trace line per attempt, naming route, trunk and cause (§9.4 "Route fallthrough").
  call.log.event({
    event: 'attempt',
    routeId: route?.id ?? null,
    trunkId: trunk.id,
    endpoint,
    // The caller ID the INVITE presented: the number as formatted for the trunk, the format and
    // header(s) the trunk takes it in, and whether it was withheld (§9.4 "Caller ID", CLIR).
    callerId: {
      number: ctx.identity.number,
      format: trunk.calleridFormat,
      header: trunk.calleridHeader,
      withheld: ctx.identity.withhold
    },
    cause: attemptCause(outcome)
  });
  if (outcome.kind === 'answered') {
    if (leg) {
      leg.state = 'up';
    }
    watchAttemptChannelEnd(pipeline.deps.ari, trunkState, channelId);
    return outcome;
  }
  if (leg) {
    leg.state = 'ended';
  }
  trunkState.noteAttemptEnded(channelId);
  await pipeline.deps.ari.channels
    .hangup(channelId)
    .catch(logUnlessGone(pipeline.deps.logger, 'trunk attempt hangup'));
  return outcome;
}

/** One route's (or emergency trunk's) attempt: every host in turn for an `ip` trunk (§9.4 "Hosts"), once otherwise. */
export async function attemptRoute(
  ctx: AttemptCtx,
  snapshot: Snapshot
): Promise<AttemptOutcome> {
  let lastFailure: AttemptFailure = { kind: 'hostsExhausted' };
  for (const endpoint of dialTargets(ctx.trunk, snapshot)) {
    // eslint-disable-next-line no-await-in-loop -- hosts are attempted one at a time, in priority order, by design
    const outcome = await attemptOnce(ctx, endpoint);
    if (outcome.kind === 'answered') {
      return outcome;
    }
    if (!retriesNextHost(outcome.failure)) {
      return outcome;
    }
    lastFailure = outcome.failure;
  }
  return { kind: 'failure', failure: lastFailure };
}
