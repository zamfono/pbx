/**
 * The shared outbound-attempt engine (§9.4 "Route fallthrough", "Hosts"): one INVITE's outcome,
 * and `ip`-trunk host failover. Used by both `outbound.ts`'s per-route dialling and
 * `emergency.ts`'s per-trunk dialling; the INVITE itself is `trunkDial.ts`, caller-ID resolution
 * `callerIdentity.ts`, the terminal outcomes `answer.ts` and `conclude.ts`.
 */
import type { AriClient } from '../ari/client.js';
import type { AriEvent, Channel } from '../ari/types.js';
import type { Snapshot } from '../internal/server.js';
import {
  ATTEMPT_NO_RESPONSE_MS,
  type AttemptFailure,
  type Route
} from '../routing/trunk.js';
import { callRinging } from './callState.js';
import { recordEvents, type EventRecording } from './earlyEvents.js';
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

/**
 * Resolves once `leg` alerts and later ends, answers, or times out (§9.4 "Route fallthrough"),
 * `early` holding the events that arrived while the leg was being originated.
 */
function waitForAttemptOutcome(
  ari: AriClient,
  leg: TrunkLeg,
  early: EventRecording,
  timeoutMs: number
): Promise<AttemptOutcome> {
  return new Promise(resolve => {
    let alerted = false;
    let settled = false;
    // Both fields are set once, right below, before `finish` can possibly run; one holder object,
    // so neither field needs a dummy initializer.
    const listener: {
      timer: ReturnType<typeof setTimeout> | null;
      onEvent: ((event: AriEvent) => void) | null;
    } = { timer: null, onEvent: null };
    const stopBudget = (): void => {
      if (listener.timer !== null) {
        clearTimeout(listener.timer);
        listener.timer = null;
      }
    };
    const finish = (outcome: AttemptOutcome): void => {
      if (settled) {
        return;
      }
      settled = true;
      stopBudget();
      if (listener.onEvent !== null) {
        ari.off('event', listener.onEvent);
      }
      resolve(outcome);
    };
    listener.onEvent = event => {
      if (!alerted && alertsOn(event, leg.id)) {
        // The no-response budget covers only the interval before the first provisional
        // response (§9.4 "Route fallthrough"); once the far end alerted, the attempt is final
        // only on answer or a terminal response, never on this timer.
        alerted = true;
        stopBudget();
        return;
      }
      const channel = event.channel as Channel | undefined;
      if (channel?.id !== leg.id) {
        return;
      }
      if (event.type === 'ChannelStateChange' && channel.state === 'Up') {
        finish({ kind: 'answered', channelId: leg.id });
        return;
      }
      if (event.type === 'ChannelDestroyed') {
        const code = endedSipStatus(event);
        finish({ kind: 'failure', failure: { kind: 'final', code, alerted } });
      }
    };
    ari.on('event', listener.onEvent);
    listener.timer = setTimeout(() => {
      listener.timer = null;
      // A `100 Trying` ends the budget as any provisional response does, though no event says so;
      // the attempt then waits for its outcome like one that alerted.
      provisionalArrived(ari, leg)
        .then(arrived => {
          if (!arrived) {
            finish({ kind: 'failure', failure: { kind: 'noResponse' } });
          }
        })
        .catch(() => undefined);
    }, timeoutMs);
    listener.timer.unref();
    // Handed over in the same tick as the listener started, so no event falls between the two;
    // an outcome among them settles the attempt and stops the budget just set.
    early.stop();
    for (const event of early.events) {
      listener.onEvent(event);
    }
  });
}

/** Decrements the trunk's active count once the answered leg's channel eventually ends. */
function watchAttemptChannelEnd(
  ari: AriClient,
  trunkState: TrunkState,
  trunkId: string,
  channelId: string
): void {
  const onEvent = (event: AriEvent): void => {
    const channel = event.channel as Channel | undefined;
    if (channel?.id !== channelId || event.type !== 'ChannelDestroyed') {
      return;
    }
    ari.off('event', onEvent);
    trunkState.noteAttemptEnded(trunkId);
  };
  ari.on('event', onEvent);
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
  const early = recordEvents(pipeline.deps.ari);
  const trunkLeg = await originateTrunkLeg(ctx, endpoint).catch(
    (error: unknown) => {
      early.stop();
      throw error;
    }
  );
  const channelId = trunkLeg.id;
  call.legs.set(channelId, {
    channelId,
    kind: 'trunk',
    userId: null,
    state: 'ringing',
    endCause: null,
    trunkId: trunk.id
  });
  // The live view (§10.6) shows the call ringing its external target from the first INVITE on.
  callRinging(pipeline.deps, call);
  const outcome = await waitForAttemptOutcome(
    pipeline.deps.ari,
    trunkLeg,
    early,
    ATTEMPT_NO_RESPONSE_MS
  );
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
    watchAttemptChannelEnd(pipeline.deps.ari, trunkState, trunk.id, channelId);
    return outcome;
  }
  if (leg) {
    leg.state = 'ended';
  }
  trunkState.noteAttemptEnded(trunk.id);
  await pipeline.deps.ari.channels.hangup(channelId).catch(() => undefined);
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
