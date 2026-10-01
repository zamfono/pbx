/**
 * One attempt of an external leg (`externalLeg.ts`) while its channel lives: the listener that
 * notes the far end alerting, answering or ending, the 8-second no-response budget (§9.4 "Route
 * fallthrough"), the attempt's trace line, and the trunk's channel count (§9.4 "Channels"). The
 * attempt's own channel ending is handled here alone, whichever race holds the leg: a leg the
 * race still rings fails over to its next attempt or ends (`onFailed`), any other channel had
 * been hung up by the race or had answered.
 */
import type { AriEvent, Channel } from '../ari/types.js';
import {
  ATTEMPT_NO_RESPONSE_MS,
  type AttemptFailure
} from '../routing/trunk.js';
import type { ExternalLeg } from './externalLeg.js';
import type { Candidate } from './externalLegRoutes.js';
import { alertsOn, provisionalArrived, type TrunkLeg } from './provisional.js';
import { endedSipStatus } from './trunkDial.js';

/** How a failed attempt of a leg its race still rings goes on: `failure` for the route
 * fallthrough to judge, `cause` the Q.850 cause its channel ended with. */
export type AttemptFailed = (
  failure: AttemptFailure,
  cause: number | null
) => void;

/** One attempt's live channel; `alerted` once the far end sent 180/183 or answered, `closed`
 * once its channel is gone. */
type Attempt = {
  leg: ExternalLeg;
  candidate: Candidate;
  channelId: string;
  alerted: boolean;
  noResponse: boolean;
  logged: boolean;
  closed: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  onEvent: ((event: AriEvent) => void) | null;
  onFailed: AttemptFailed;
};

/** The attempt's one routing-trace line, naming route, trunk and cause (§9.4 "Route fallthrough"). */
function logAttempt(attempt: Attempt, cause: string | number): void {
  if (attempt.logged) {
    return;
  }
  attempt.logged = true;
  attempt.leg.call.log.event({
    event: 'attempt',
    routeId: attempt.candidate.route?.id ?? null,
    trunkId: attempt.candidate.trunk.id,
    endpoint: attempt.candidate.endpoint,
    cause
  });
}

/** Stops watching the attempt and counts its channel off the trunk (§9.4 "Channels"). */
function closeAttempt(attempt: Attempt): void {
  attempt.closed = true;
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

/**
 * The attempt's channel ended: while its race still rings the leg, the attempt failed, and how
 * (§9.4 "Route fallthrough": no response within the budget, else the final status and whether it
 * had alerted) is handed on; any other channel had been hung up by the race, or had answered.
 */
function attemptEnded(attempt: Attempt, destroyed: AriEvent): void {
  if (!attempt.leg.owner.ringing(attempt.channelId)) {
    logAttempt(attempt, 'hungUp');
    closeAttempt(attempt);
    return;
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
  attempt.onFailed(
    failure,
    typeof destroyed.cause === 'number' ? destroyed.cause : null
  );
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
    attemptEnded(attempt, event);
  }
}

/** Watches the attempt's channel: its outcome listener and its 8-second no-response budget;
 * `onFailed` once it fails while its race still rings the leg. */
export function watchAttempt(
  leg: ExternalLeg,
  candidate: Candidate,
  trunkLeg: TrunkLeg,
  onFailed: AttemptFailed
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
    closed: false,
    timer: null,
    onEvent: null,
    onFailed
  };
  attempt.onEvent = event => {
    onAttemptEvent(attempt, event);
  };
  attempt.timer = setTimeout(() => {
    attempt.timer = null;
    // A `100 Trying` ends the budget too, though no event says so; only its absence hangs up. An
    // answer landing while the read is under way ends it as well: the answered leg is the race's.
    provisionalArrived(ari, trunkLeg)
      .then(arrived => {
        if (!arrived && !attempt.alerted && !attempt.closed) {
          attempt.noResponse = true;
          ari.channels.hangup(channelId).catch(() => undefined);
        }
      })
      .catch(() => undefined);
  }, ATTEMPT_NO_RESPONSE_MS);
  attempt.timer.unref();
  ari.on('event', attempt.onEvent);
}
