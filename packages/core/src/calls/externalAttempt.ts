/**
 * One attempt of an external leg (`externalLeg.ts`) while its channel lives: the listener that
 * notes the far end alerting or answering, the 8-second no-response budget (§9.4 "Route
 * fallthrough"), the attempt's trace line, and the trunk's channel count (§9.4 "Channels").
 */
import type { AriEvent, Channel } from '../ari/types.js';
import {
  ATTEMPT_NO_RESPONSE_MS,
  type AttemptFailure
} from '../routing/trunk.js';
import type { ExternalLeg } from './externalLeg.js';
import type { Candidate } from './externalLegRoutes.js';
import type { Pipeline } from './pipeline.js';
import { alertsOn, provisionalArrived, type TrunkLeg } from './provisional.js';
import { endedSipStatus } from './trunkDial.js';

/** One attempt's live channel; `alerted` once the far end sent 180/183 or answered. */
type Attempt = {
  leg: ExternalLeg;
  candidate: Candidate;
  channelId: string;
  alerted: boolean;
  noResponse: boolean;
  logged: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  onEvent: ((event: AriEvent) => void) | null;
};

const attemptsByPipeline = new WeakMap<Pipeline, Map<string, Attempt>>();

function attemptsOf(pipeline: Pipeline): Map<string, Attempt> {
  let attempts = attemptsByPipeline.get(pipeline);
  if (attempts === undefined) {
    attempts = new Map();
    attemptsByPipeline.set(pipeline, attempts);
  }
  return attempts;
}

/** The attempt's one routing-trace line, naming route, trunk and cause (§9.4 "Route fallthrough"). */
function logAttempt(attempt: Attempt, cause: string | number): void {
  if (attempt.logged) {
    return;
  }
  attempt.logged = true;
  attempt.leg.call.log.event({
    event: 'attempt',
    routeId: attempt.candidate.route.id,
    trunkId: attempt.candidate.trunk.id,
    endpoint: attempt.candidate.endpoint,
    cause
  });
}

/** Stops watching the attempt and counts its channel off the trunk (§9.4 "Channels"); idempotent. */
function closeAttempt(attempt: Attempt): void {
  const attempts = attemptsOf(attempt.leg.pipeline);
  if (attempts.get(attempt.channelId) !== attempt) {
    return;
  }
  attempts.delete(attempt.channelId);
  if (attempt.timer !== null) {
    clearTimeout(attempt.timer);
  }
  if (attempt.onEvent !== null) {
    attempt.leg.pipeline.deps.ari.off('event', attempt.onEvent);
  }
  attempt.leg.trunkState.noteAttemptEnded(attempt.candidate.trunk.id);
}

/** Ends the 8-second no-response budget: a provisional response arrived (§9.4 "Route fallthrough"). */
function stopBudget(attempt: Attempt): void {
  if (attempt.timer !== null) {
    clearTimeout(attempt.timer);
    attempt.timer = null;
  }
}

function onAttemptEvent(attempt: Attempt, event: AriEvent): void {
  if (alertsOn(event, attempt.channelId)) {
    // The no-response budget covers only the interval before the first provisional response.
    attempt.alerted = true;
    stopBudget(attempt);
    return;
  }
  const channel = event.channel as Channel | undefined;
  if (channel?.id !== attempt.channelId) {
    return;
  }
  if (event.type === 'ChannelStateChange' && channel.state === 'Up') {
    attempt.alerted = true;
    stopBudget(attempt);
    logAttempt(attempt, 'answered');
    return;
  }
  if (event.type === 'ChannelDestroyed') {
    // The race consults `externalAttemptDialsOn` from its own handler of this same event; an
    // attempt it did not consult about had been hung up by the race, or had answered.
    queueMicrotask(() => {
      logAttempt(attempt, 'hungUp');
      closeAttempt(attempt);
    });
  }
}

/** Registers the attempt's channel, its outcome listener and its 8-second no-response budget. */
export function watchAttempt(
  leg: ExternalLeg,
  candidate: Candidate,
  trunkLeg: TrunkLeg
): void {
  const { ari } = leg.pipeline.deps;
  const channelId = trunkLeg.id;
  const attempt: Attempt = {
    leg,
    candidate,
    channelId,
    alerted: false,
    noResponse: false,
    logged: false,
    timer: null,
    onEvent: null
  };
  attempt.onEvent = event => {
    onAttemptEvent(attempt, event);
  };
  attempt.timer = setTimeout(() => {
    attempt.timer = null;
    // A `100 Trying` ends the budget too, though no event says so; only its absence hangs up.
    provisionalArrived(ari, trunkLeg)
      .then(arrived => {
        if (!arrived && attemptsOf(leg.pipeline).get(channelId) === attempt) {
          attempt.noResponse = true;
          ari.channels.hangup(channelId).catch(() => undefined);
        }
      })
      .catch(() => undefined);
  }, ATTEMPT_NO_RESPONSE_MS);
  attempt.timer.unref();
  ari.on('event', attempt.onEvent);
  attemptsOf(leg.pipeline).set(channelId, attempt);
}

/**
 * The race's own `ChannelDestroyed` for `channelId`, `destroyed`: closes the attempt and returns
 * its leg and how the attempt failed, or `null` for a channel that is no external attempt.
 */
export function endAttempt(
  pipeline: Pipeline,
  channelId: string,
  destroyed: AriEvent
): { leg: ExternalLeg; failure: AttemptFailure } | null {
  const attempt = attemptsOf(pipeline).get(channelId);
  if (attempt === undefined) {
    return null;
  }
  const failure: AttemptFailure = attempt.noResponse
    ? { kind: 'noResponse' }
    : {
        kind: 'final',
        code: endedSipStatus(destroyed),
        alerted: attempt.alerted
      };
  logAttempt(attempt, failure.kind === 'final' ? failure.code : failure.kind);
  closeAttempt(attempt);
  return { leg: attempt.leg, failure };
}
